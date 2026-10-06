'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, clearSession, errorText } from '../../lib/api';
import type { PublicUser } from '../../lib/types';

export default function AccountPage() {
  const [me, setMe] = useState<PublicUser>();
  const [error, setError] = useState('');
  const [exportMsg, setExportMsg] = useState('');
  const [password, setPassword] = useState('');
  const [sure, setSure] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PublicUser>('/account')
      .then(setMe)
      .catch((err) => setError(errorText(err)));
  }, []);

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
      {me ? (
        <section className="card">
          <span className="label">Signed in as</span>
          <p>{me.email}</p>
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
          <li>Changing your password or email address.</li>
          <li>Email verification and password reset.</li>
          <li>Plans and billing. Nothing is charged.</li>
        </ul>
      </section>
    </>
  );
}
