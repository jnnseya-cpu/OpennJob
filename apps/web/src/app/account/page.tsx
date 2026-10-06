'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, clearSession, errorText } from '../../lib/api';
import type { AgentStatus, Authorisation, PublicUser } from '../../lib/types';

interface Prefs {
  email: boolean;
  sms: boolean;
  push: boolean;
  whatsapp: boolean;
  muted: string[];
}

const REPORT_KEY = 'agent.daily_report';

export default function AccountPage() {
  const [me, setMe] = useState<PublicUser>();
  const [error, setError] = useState('');
  const [exportMsg, setExportMsg] = useState('');
  const [password, setPassword] = useState('');
  const [sure, setSure] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState<Authorisation>();
  const [status, setStatus] = useState<AgentStatus>();
  const [agree, setAgree] = useState(false);
  const [authMsg, setAuthMsg] = useState('');
  const [prefs, setPrefs] = useState<Prefs>();
  const [reportMsg, setReportMsg] = useState('');

  useEffect(() => {
    api<PublicUser>('/account')
      .then(setMe)
      .catch((err) => setError(errorText(err)));
    api<Authorisation>('/agent/authorisation')
      .then(setAuth)
      .catch(() => undefined);
    api<AgentStatus>('/agent/status')
      .then(setStatus)
      .catch(() => undefined);
    api<Prefs>('/notifications/preferences')
      .then(setPrefs)
      .catch(() => undefined);
  }, []);

  async function refreshStatus() {
    setStatus(await api<AgentStatus>('/agent/status').catch(() => undefined));
  }

  async function setAuthorisation(enabled: boolean) {
    if (!auth) return;
    setAuthMsg('');
    try {
      const next = await api<Authorisation>('/agent/authorisation', { method: 'PUT', body: enabled ? { enabled: true, scopeVersion: auth.scope.version } : { enabled: false } });
      setAuth(next);
      setAgree(false);
      setAuthMsg(enabled ? 'Standing authorisation is on, to the wording above.' : 'Standing authorisation is off. Nothing is sent without you from now on.');
      await refreshStatus();
    } catch (err) {
      setAuthMsg(errorText(err));
    }
  }

  async function setPaused(paused: boolean) {
    setAuthMsg('');
    try {
      setAuth(await api<Authorisation>('/agent/pause', { method: 'PUT', body: { paused } }));
      setAuthMsg(paused ? 'The agent is paused. Nothing is sent until you resume it.' : 'The agent is running again.');
      await refreshStatus();
    } catch (err) {
      setAuthMsg(errorText(err));
    }
  }

  async function setReport(on: boolean) {
    if (!prefs) return;
    setReportMsg('');
    const muted = on ? prefs.muted.filter((k) => k !== REPORT_KEY) : [...new Set([...prefs.muted, REPORT_KEY])];
    const before = prefs;
    setPrefs({ ...prefs, muted }); // shown at once; put back if the API refuses
    try {
      setPrefs(await api<Prefs>('/notifications/preferences', { method: 'PUT', body: { ...before, muted } }));
      setReportMsg(on ? 'The 09:00 report e-mail is on.' : 'The 09:00 report e-mail is paused.');
    } catch (err) {
      setPrefs(before);
      setReportMsg(errorText(err));
    }
  }

  async function exportData() {
    setExportMsg('');
    try {
      const data = await api<unknown>('/account/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `opennjob-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportMsg('Your data was downloaded as a JSON file. Keep it somewhere safe: it holds your CV and passport.');
    } catch (err) {
      setExportMsg(errorText(err));
    }
  }

  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setDeleteError('');
    try {
      await api('/account', { method: 'DELETE', body: { password }, passwordCheck: true });
      clearSession('/signin/?notice=deleted');
    } catch (err) {
      setDeleteError(errorText(err));
      setBusy(false);
    }
  }

  function signOut() {
    clearSession('/signin/?notice=signedout');
  }

  return (
    <>
      <h2>Account</h2>
      {error ? <div className="note bad" role="alert">{error}</div> : null}
      <div className="cols flow">
        {me ? (
          <section className="card">
            <span className="label">Signed in as</span>
            <p>{me.email}</p>
            <p className="small" data-testid="email-state">
              {me.emailVerified ? `E-mail address confirmed${me.emailVerifiedAt ? ` on ${new Date(me.emailVerifiedAt).toLocaleDateString('en-GB')}` : ''}.` : 'E-mail address not confirmed yet: nothing is sent to an employer for you until it is.'}
            </p>
            <p className="small muted">
              Created {new Date(me.createdAt).toLocaleDateString('en-GB')}. Terms accepted: version {me.consent.acceptedTermsVersion}. Privacy notice:
              version {me.consent.acceptedPrivacyVersion}.
            </p>
            <button type="button" className="btn" onClick={signOut}>
              Sign out on this device
            </button>
            <p className="small muted">Signing out removes the token from this browser. There is no server-side sign-out yet, so a copied token works until it expires.</p>
          </section>
        ) : null}

        {auth ? (
          <section className="card" aria-label="Automatic applications" data-testid="authorisation">
            <span className="label">Automatic applications</span>
            <p className="small">
              {auth.enabled
                ? `On since ${auth.consentAt ? new Date(auth.consentAt).toLocaleString('en-GB') : 'an unknown time'}${auth.paused ? ', and paused by you' : ''}.`
                : auth.revokedAt
                  ? `Off. You turned it off on ${new Date(auth.revokedAt).toLocaleString('en-GB')}.`
                  : 'Off. Nothing is sent without you.'}
            </p>
            <blockquote className="small" data-testid="scope-text">
              {auth.scope.text}
            </blockquote>
            <p className="small muted">Wording version {auth.scope.version}. A form with any declaration or other sensitive question always waits for you, whatever you choose here.</p>
            {auth.enabled ? (
              <div className="row">
                <button type="button" className="btn danger" onClick={() => setAuthorisation(false)}>
                  Turn off automatic applications
                </button>
                <button type="button" className="btn" onClick={() => setPaused(!auth.paused)}>
                  {auth.paused ? 'Resume' : 'Pause'}
                </button>
              </div>
            ) : (
              <>
                <label className={`confirm ${agree ? 'on' : ''}`}>
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  <span>I have read this wording and I agree to it.</span>
                </label>
                <button type="button" className="btn primary" disabled={!agree} onClick={() => setAuthorisation(true)}>
                  Turn on automatic applications
                </button>
              </>
            )}
            {authMsg ? <p className="small note ok" role="status">{authMsg}</p> : null}
            {status ? (
              <div className="small" data-testid="queue-status">
                <p>
                  Ready to send: {status.queue.ready} · Waiting for a site to be enabled: {status.queue.waitingForSystem} · Needs you: {status.queue.needsYou} · Sent today: {status.dailyLimit.used} of {status.dailyLimit.limit}
                </p>
                {status.message ? <p className="muted">{status.message}</p> : null}
                {status.systems.filter((x) => !x.enabled).length ? (
                  <p className="muted">
                    Not yet enabled by the operator (terms check and a supervised submission needed): {status.systems.filter((x) => !x.enabled).map((x) => x.label).join(', ')}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {prefs ? (
          <section className="card" aria-label="Daily report">
            <span className="label">Daily report</span>
            <p className="small">At 09:00 London time: what was sent with the site's confirmation, what is held for you and why, new matches and any problems. It names jobs and employers only, never your CV or answers.</p>
            <label className={`confirm ${prefs.muted.includes(REPORT_KEY) ? '' : 'on'}`}>
              <input type="checkbox" checked={!prefs.muted.includes(REPORT_KEY)} onChange={(e) => setReport(e.target.checked)} />
              <span>Send me the daily report by e-mail</span>
            </label>
            {reportMsg ? <p className="small note ok" role="status">{reportMsg}</p> : null}
          </section>
        ) : null}

        <section className="card">
          <span className="label">Your data</span>
          <p className="small">Download everything OpennJob holds about you: account, profile, CV, passport, applications, activity and usage.</p>
          <button type="button" className="btn" onClick={exportData}>
            Download my data
          </button>
          {exportMsg ? <p className="small note ok" role="status">{exportMsg}</p> : null}
        </section>

        <form className="card" onSubmit={deleteAccount} aria-label="Delete account">
          <span className="label">Delete account</span>
          <p className="small">This deletes your account and everything stored for it, at once. It cannot be undone.</p>
          <label className="field">
            <span>Your password</span>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className={`confirm ${sure ? 'on' : ''}`}>
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            <span>I understand that my data cannot be recovered.</span>
          </label>
          {deleteError ? <div className="note bad" role="alert">{deleteError}</div> : null}
          <button type="submit" className="btn danger" disabled={busy || !sure || !password}>
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </form>

        <section className="card">
          <span className="label">Not available yet</span>
          <ul className="plain small">
            <li>Changing your password while signed in (use Forgot your password on the sign-in page) or your email address.</li>
            <li>Plans and billing. Nothing is charged.</li>
          </ul>
        </section>
      </div>
    </>
  );
}
