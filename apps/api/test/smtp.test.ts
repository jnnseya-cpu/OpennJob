import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { createDefaultDeps, smtpSettings, startupProblems } from '../src/deps';
import { memoryLogger } from '../src/logging';
import { smtpEmail } from '../src/notifications';

/**
 * Sending e-mail through a mailbox over SMTP (for example Hostinger Email), against a real SMTP
 * server started inside the test (the `smtp-server` package, with its built-in self-signed
 * certificate). Every address is fictional. No external mail server is contacted.
 */

const USER = 'support@example.org';
const PASSWORD = 'not-a-real-mailbox-password';
const FROM = 'OpennJob <support@example.org>';
const TO = 'kemi.adebayo@example.org';

interface Received {
  auth: { username?: string; password?: string }[];
  mailFrom: string[];
  rcptTo: string[];
  raw: string[];
  secureAtAuth: boolean[];
}

let server: SMTPServer | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function start(options: { secure: boolean; noTls?: boolean; password?: string }): Promise<{ port: number; got: Received }> {
  const got: Received = { auth: [], mailFrom: [], rcptTo: [], raw: [], secureAtAuth: [] };
  server = new SMTPServer({
    secure: options.secure,
    // noTls: a server with no STARTTLS at all that would accept a password in plain text.
    ...(options.noTls ? { disabledCommands: ['STARTTLS'], allowInsecureAuth: true } : {}),
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, session, cb) {
      got.auth.push({ username: auth.username, password: auth.password });
      got.secureAtAuth.push(Boolean(session.secure));
      if (auth.username === USER && auth.password === (options.password ?? PASSWORD)) cb(null, { user: USER });
      else cb(new Error('Invalid username or password'));
    },
    onMailFrom(address, _session, cb) {
      got.mailFrom.push(address.address);
      cb();
    },
    onRcptTo(address, _session, cb) {
      got.rcptTo.push(address.address);
      cb();
    },
    onData(stream, _session, cb) {
      let data = '';
      stream.on('data', (c: Buffer) => (data += c.toString('utf8')));
      stream.on('end', () => {
        got.raw.push(data);
        cb();
      });
    },
  });
  const srv = server;
  // A client that rightly drops the connection (untrusted certificate) is an error on the server side.
  srv.on('error', () => undefined);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { port: (srv.server.address() as AddressInfo).port, got };
}

const message = { to: TO, subject: 'Verify your email address', text: 'Your confirmation code: abc (fictional)', html: '<p>Your confirmation code: <b>abc</b> (fictional)</p>' };

describe('smtpEmail: sending through a mailbox over SMTP', () => {
  it('port 465 style (TLS from the start): logs in, sends from the configured address, delivers text and HTML', async () => {
    const { port, got } = await start({ secure: true });
    const sender = smtpEmail({ host: '127.0.0.1', port, user: USER, password: PASSWORD, from: FROM, secure: true, allowSelfSignedForTests: true });
    expect(sender).toMatchObject({ name: 'smtp', live: true });
    expect(await sender.send(message)).toBe('sent');
    expect(got.auth).toEqual([{ username: USER, password: PASSWORD }]);
    expect(got.secureAtAuth).toEqual([true]);
    expect(got.mailFrom).toEqual([USER]);
    expect(got.rcptTo).toEqual([TO]);
    const raw = got.raw[0] ?? '';
    expect(raw).toMatch(/^From: OpennJob <support@example\.org>/m);
    expect(raw).toMatch(/^To: kemi\.adebayo@example\.org/m);
    expect(raw).toMatch(/^Subject: Verify your email address/m);
    expect(raw).toContain('text/plain');
    expect(raw).toContain('text/html');
  });

  it('an application by e-mail: the applicant as display name, replies to the applicant, the CV attached', async () => {
    const { port, got } = await start({ secure: true });
    const sender = smtpEmail({ host: '127.0.0.1', port, user: USER, password: PASSWORD, from: FROM, secure: true, allowSelfSignedForTests: true });
    const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
    expect(await sender.send({ ...message, fromName: 'Kemi Adebayo', replyTo: TO, attachments: [{ filename: 'Kemi_Adebayo_CV.pdf', content: pdf, contentType: 'application/pdf' }] })).toBe('sent');
    expect(got.mailFrom).toEqual([USER]); // still sent from the configured mailbox
    const raw = got.raw[0] ?? '';
    expect(raw).toMatch(/^From: Kemi Adebayo <support@example\.org>/m);
    expect(raw).toMatch(/^Reply-To: kemi\.adebayo@example\.org/m);
    expect(raw).toContain('filename=Kemi_Adebayo_CV.pdf');
    expect(raw).toContain('application/pdf');
  });

  it('port 587 style: upgrades with STARTTLS before logging in', async () => {
    const { port, got } = await start({ secure: false });
    const sender = smtpEmail({ host: '127.0.0.1', port, user: USER, password: PASSWORD, from: FROM, secure: false, allowSelfSignedForTests: true });
    expect(await sender.send(message)).toBe('sent');
    expect(got.secureAtAuth).toEqual([true]);
  });

  it('never sends the password over an unencrypted connection: a server without STARTTLS is refused', async () => {
    const { port, got } = await start({ secure: false, noTls: true });
    const sender = smtpEmail({ host: '127.0.0.1', port, user: USER, password: PASSWORD, from: FROM, secure: false, allowSelfSignedForTests: true });
    expect(await sender.send(message)).toBe('failed');
    expect(got.auth).toEqual([]);
    expect(got.raw).toEqual([]);
  });

  it('refuses an untrusted certificate unless the test flag is set', async () => {
    const { port, got } = await start({ secure: true });
    const sender = smtpEmail({ host: '127.0.0.1', port, user: USER, password: PASSWORD, from: FROM, secure: true });
    expect(await sender.send(message)).toBe('failed');
    expect(got.auth).toEqual([]);
  });

  it('a wrong password is "failed", does not throw, and nothing is delivered', async () => {
    const { port, got } = await start({ secure: true, password: 'the-real-one' });
    const sender = smtpEmail({ host: '127.0.0.1', port, user: USER, password: PASSWORD, from: FROM, secure: true, allowSelfSignedForTests: true });
    expect(await sender.send(message)).toBe('failed');
    expect(got.raw).toEqual([]);
  });

  it('an unreachable server is "failed"', async () => {
    const sender = smtpEmail({ host: '127.0.0.1', port: 1, user: USER, password: PASSWORD, from: FROM, secure: true });
    expect(await sender.send(message)).toBe('failed');
  });
});

describe('SMTP configuration', () => {
  const HOSTINGER = { SMTP_HOST: 'smtp.hostinger.com', SMTP_USER: USER, SMTP_PASSWORD: PASSWORD };

  it('is off until host, user and password are all set; 465 means TLS from the start', () => {
    expect(smtpSettings({})).toBeUndefined();
    expect(smtpSettings({ SMTP_HOST: 'smtp.hostinger.com', SMTP_USER: USER })).toBeUndefined();
    expect(smtpSettings({ ...HOSTINGER, SMTP_PASSWORD: '   ' })).toBeUndefined();
    expect(smtpSettings({ ...HOSTINGER, OPENNJOB_EMAIL_FROM: FROM })).toEqual({ host: 'smtp.hostinger.com', port: 465, user: USER, password: PASSWORD, from: FROM, secure: true });
    expect(smtpSettings({ ...HOSTINGER, SMTP_PORT: '587' })).toMatchObject({ port: 587, secure: false, from: USER });
  });

  it('a half-configured SMTP or a bad port stops the API from starting', () => {
    expect(startupProblems({ SMTP_HOST: 'smtp.hostinger.com' })).toEqual(['SMTP needs SMTP_HOST, SMTP_USER and SMTP_PASSWORD together (one or two of them are set).']);
    expect(startupProblems({ ...HOSTINGER, SMTP_PORT: 'abc' })).toEqual(['SMTP_PORT must be a port number, for example 465.']);
    expect(startupProblems({ ...HOSTINGER })).toEqual([]);
  });

  it('SMTP is used when configured; Resend wins when both are set; the password never reaches the log', () => {
    const logger = memoryLogger();
    expect(createDefaultDeps({ ...HOSTINGER }, undefined, logger).emailSender?.name).toBe('smtp');
    expect(createDefaultDeps({ ...HOSTINGER, RESEND_API_KEY: 're_not_a_key', OPENNJOB_EMAIL_FROM: FROM }, undefined, logger).emailSender?.name).toBe('resend');
    expect(createDefaultDeps({}, undefined, logger).emailSender).toBeUndefined();
    expect(JSON.stringify(logger.lines)).not.toContain(PASSWORD);
  });
});
