import { DEFAULT_NOTIFICATION_PREFERENCES, SYSTEM_USER_ID, eventsForTrigger, notificationEvent, renderEmailHtml, renderTemplate, routeChannels } from '@opennjob/core';
import type { Brand, Channel, DomainEvent, NotificationDelivery, NotificationEventDef, NotificationPreferences, NotificationVars } from '@opennjob/core';
import { createTransport } from 'nodemailer';
import type { OpennJobDeps } from './deps';

/**
 * The notification engine. It listens to every domain event on the EventBus, finds the
 * catalogue entries that event fires (packages/core/src/notifications.ts), and delivers each
 * one on the channels the user's preferences allow (mandatory notices ignore opt-outs).
 *
 *  - in-app: stored in the user's inbox (always on);
 *  - email: through the configured EmailSender (Resend when RESEND_API_KEY and
 *    OPENNJOB_EMAIL_FROM are set, else SMTP when SMTP_HOST, SMTP_USER and SMTP_PASSWORD are set),
 *    otherwise recorded as "logged" in sandbox mode;
 *  - SMS, push and WhatsApp: no provider is wired; every attempt is recorded as "logged".
 *
 * Every attempt, and every channel skipped because the user opted out, is a delivery row
 * with no message text and no address. A failure to notify never fails the request that
 * caused it. The log line carries the event key, channel and status only.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  readonly name: string;
  /** true when messages really leave the system. */
  readonly live: boolean;
  send(message: EmailMessage): Promise<'sent' | 'logged' | 'failed'>;
}

export const sandboxEmail: EmailSender = { name: 'sandbox', live: false, send: async () => 'logged' };

/**
 * Development and test only: each message is written as a JSON file in a directory, so a test or a
 * developer can read the verification link without a mail server. The API refuses to start with it
 * in production (startupProblems).
 */
export function fileMailbox(dir: string): EmailSender {
  return {
    name: 'dev-mailbox',
    live: true,
    async send(m) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { randomUUID } = await import('node:crypto');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(m), { mode: 0o600 });
      return 'sent';
    },
  };
}

/**
 * Resend's HTTP API (POST https://api.resend.com/emails). Written from its public
 * documentation; never called from this repository's tests and never verified live.
 */
export type PostFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;

export function resendEmail(apiKey: string, from: string, fetchFn: PostFn = (url, init) => fetch(url, init)): EmailSender {
  return {
    name: 'resend',
    live: true,
    async send(m) {
      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      });
      return res.ok ? 'sent' : 'failed';
    },
  };
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  /** TLS from the first byte (port 465). Otherwise STARTTLS is required before logging in. */
  secure: boolean;
  /** Tests only: accept the test server's self-signed certificate. Never set from the environment. */
  allowSelfSignedForTests?: boolean;
}

/**
 * SMTP, for a mailbox such as Hostinger Email (smtp.hostinger.com, port 465). The password is
 * never logged; a failure is reported as "failed" with no driver message, which can carry
 * addresses or server replies.
 */
export function smtpEmail(settings: SmtpSettings): EmailSender {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { minVersion: 'TLSv1.2', ...(settings.allowSelfSignedForTests ? { rejectUnauthorized: false } : {}) },
  });
  return {
    name: 'smtp',
    live: true,
    async send(m) {
      try {
        await transport.sendMail({ from: settings.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
        return 'sent';
      } catch {
        return 'failed';
      }
    },
  };
}

export const DEFAULT_BRAND: Brand = { name: 'OpennJob', colour: '#1A3C8A', footer: 'OpennJob · test build · messages about your own account only' };

/** Channels that can really deliver today. */
export function wiredChannels(sender: EmailSender): Record<Channel, boolean> {
  return { inapp: true, email: sender.live, sms: false, push: false, whatsapp: false };
}

export const SAMPLE_VARS: NotificationVars = { jobTitle: 'Site Manager (example)', employer: 'Example Construction Ltd', count: 3, threshold: 80 };

export class Notifier {
  constructor(private readonly deps: OpennJobDeps) {}

  get sender(): EmailSender {
    return this.deps.emailSender ?? sandboxEmail;
  }

  get brand(): Brand {
    return this.deps.config.brand ?? DEFAULT_BRAND;
  }

  start(): void {
    this.deps.eventBus.subscribe('*', (event) => this.onEvent(event));
  }

  async preferences(userId: string): Promise<NotificationPreferences> {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...((await this.deps.repository.getNotificationPreferences(userId)) ?? {}) };
  }

  private async onEvent(event: DomainEvent): Promise<void> {
    if (event.userId === SYSTEM_USER_ID) return;
    const defs = eventsForTrigger(event.type);
    if (defs.length === 0) return;
    try {
      const vars = await this.varsFor(event);
      for (const def of defs) await this.dispatch(event.userId, def, vars);
    } catch (err) {
      this.deps.logger.error({ msg: 'notification failed', event: event.type, errorName: err instanceof Error ? err.name : 'Error' });
    }
  }

  /** Counts from the payload; job title and employer from the user's own application. Nothing else. */
  private async varsFor(event: DomainEvent): Promise<NotificationVars> {
    const p = event.payload;
    const vars: NotificationVars = {};
    const count = typeof p.prepared === 'number' ? p.prepared : typeof p.stored === 'number' ? p.stored : undefined;
    if (count !== undefined) vars.count = count;
    if (typeof p.threshold === 'number') vars.threshold = p.threshold;
    if (typeof p.applicationId === 'string') {
      const app = await this.deps.repository.getApplication(event.userId, p.applicationId);
      if (app) {
        vars.jobTitle = app.jobTitle;
        vars.employer = app.employer;
      }
    }
    return vars;
  }

  /** Delivers one catalogue event to one user. Returns the delivery rows written. */
  async dispatch(userId: string, def: NotificationEventDef, vars: NotificationVars, options: { test?: boolean } = {}): Promise<NotificationDelivery[]> {
    const { send, skipped } = routeChannels(def, await this.preferences(userId));
    const v = { ...vars, app: this.brand.name };
    const prefix = options.test ? '[Test] ' : '';
    const out: NotificationDelivery[] = [];
    const record = async (channel: Channel, status: NotificationDelivery['status'], provider: string) => {
      const d: NotificationDelivery = { id: this.deps.newId(), userId, eventKey: def.key, channel, status, provider, at: this.deps.clock().toISOString() };
      await this.deps.repository.appendDelivery(d);
      this.deps.logger.info({ msg: 'notification', event: def.key, channel, status });
      out.push(d);
    };
    for (const channel of send) {
      try {
        if (channel === 'inapp') {
          await this.deps.repository.saveNotification({
            id: this.deps.newId(), userId, eventKey: def.key, category: def.category, severity: def.severity,
            subject: prefix + renderTemplate(def.subject, v), body: renderTemplate(def.body, v), createdAt: this.deps.clock().toISOString(),
          });
          await record('inapp', 'delivered', 'inbox');
        } else if (channel === 'email') {
          const user = await this.deps.repository.getUserById(userId);
          if (!user) continue;
          const m = renderEmailHtml(def, v, this.brand);
          const status = await this.sender.send({ to: user.email, subject: prefix + m.subject, text: m.text, html: m.html });
          await record('email', status, this.sender.name);
        } else {
          await record(channel, 'logged', 'not wired');
        }
      } catch {
        await record(channel, 'failed', channel === 'email' ? this.sender.name : 'not wired');
      }
    }
    for (const channel of skipped) await record(channel, 'skipped', 'opted out');
    return out;
  }

  /**
   * A catalogue message with content only the caller has: a one-time link, or the daily report.
   * The e-mail carries it; the in-app copy (when the event has one) carries the catalogue text
   * only, so no token is ever stored. The delivery log keeps channel and status, never content.
   */
  async sendDirect(userId: string, key: string, extra: { text: string; html: string; linkUrl?: string }, vars: NotificationVars = {}): Promise<NotificationDelivery[]> {
    const def = notificationEvent(key);
    if (!def) throw new Error(`Unknown notification ${key}`);
    const { send, skipped } = routeChannels(def, await this.preferences(userId));
    const v = { ...vars, app: this.brand.name };
    const out: NotificationDelivery[] = [];
    const record = async (channel: Channel, status: NotificationDelivery['status'], provider: string) => {
      const d: NotificationDelivery = { id: this.deps.newId(), userId, eventKey: def.key, channel, status, provider, at: this.deps.clock().toISOString() };
      await this.deps.repository.appendDelivery(d);
      this.deps.logger.info({ msg: 'notification', event: def.key, channel, status });
      out.push(d);
    };
    for (const channel of send) {
      try {
        if (channel === 'inapp') {
          await this.deps.repository.saveNotification({ id: this.deps.newId(), userId, eventKey: def.key, category: def.category, severity: def.severity,
            subject: renderTemplate(def.subject, v), body: renderTemplate(def.body, v), createdAt: this.deps.clock().toISOString() });
          await record('inapp', 'delivered', 'inbox');
        } else if (channel === 'email') {
          const user = await this.deps.repository.getUserById(userId);
          if (!user) continue;
          const m = renderEmailHtml(def, v, this.brand);
          const link = extra.linkUrl ? `<p style="margin:16px 0"><a href="${extra.linkUrl.replace(/"/g, '&quot;')}">${extra.linkUrl.replace(/</g, '&lt;')}</a></p>` : '';
          const html = m.html.replace('</p>', `</p>${extra.html}${link}`);
          const status = await this.sender.send({ to: user.email, subject: m.subject, text: `${m.text}\n\n${extra.text}${extra.linkUrl ? `\n\n${extra.linkUrl}` : ''}`, html });
          await record('email', status, this.sender.name);
        } else {
          await record(channel, 'logged', 'not wired');
        }
      } catch {
        await record(channel, 'failed', channel === 'email' ? this.sender.name : 'not wired');
      }
    }
    for (const channel of skipped) await record(channel, 'skipped', 'opted out');
    return out;
  }

  /** NFR-4: a message to the operator (OPENNJOB_OPERATOR_EMAIL). Names what failed and counts, nothing personal. */
  async alertOperator(subject: string, text: string): Promise<'sent' | 'logged' | 'failed' | 'not configured'> {
    const to = this.deps.config.operatorEmail;
    this.deps.logger.warn({ msg: 'operator alert', alert: subject });
    if (!to) return 'not configured';
    try {
      return await this.sender.send({ to, subject: `[${this.brand.name} alert] ${subject}`, text, html: `<p>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)}</p>` });
    } catch {
      return 'failed';
    }
  }

  /**
   * The mandatory notice after an account is deleted. The account and its delivery log are
   * already gone, so nothing is stored: one log line with the event, channel and status.
   */
  async accountDeleted(email: string): Promise<void> {
    const def = notificationEvent('privacy.account_deleted');
    if (!def) return;
    const m = renderEmailHtml(def, {}, this.brand);
    let status: 'sent' | 'logged' | 'failed' = 'failed';
    try {
      status = await this.sender.send({ to: email, subject: m.subject, text: m.text, html: m.html });
    } catch {
      status = 'failed';
    }
    this.deps.logger.info({ msg: 'notification', event: def.key, channel: 'email', status });
  }
}
