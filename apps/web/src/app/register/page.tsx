'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorText, setSession } from '../../lib/api';
import type { AuthResult } from '../../lib/types';

interface Versions {
  termsVersion: string;
  privacyVersion: string;
}

export default function RegisterPage() {
  const [versions, setVersions] = useState<Versions>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Never pre-ticked: consent is the person's own act.
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Versions>('/auth/versions', { auth: false })
      .then(setVersions)
      .catch((err) => setError(errorText(err)));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!versions) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<AuthResult>('/auth/register', {
        method: 'POST',
        body: { email, password, acceptedTermsVersion: versions.termsVersion, acceptedPrivacyVersion: versions.privacyVersion },
        auth: false,
      });
      setSession({ accessToken: r.accessToken, expiresAt: r.expiresAt }, '/profile/');
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Create an account</h1>
      <div className="note">
        Test build. The terms and the privacy notice have not been written yet, and email addresses are not verified. Do not enter real
        personal data.
      </div>
      <form className="card" onSubmit={submit}>
        <label className="field">
          <span>Email address</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="new-password" required minLength={12} aria-describedby="password-rules" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <p className="small muted" id="password-rules">
          12 characters or more, not a common password, not your email address.
        </p>
        <label className={`confirm ${terms ? 'on' : ''}`}>
          <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
          <span>
            I accept the terms of use{versions ? ` (version ${versions.termsVersion})` : ''}.
            <br />
            <span className="muted small">Draft: the document is not published yet.</span>
          </span>
        </label>
        <label className={`confirm ${privacy ? 'on' : ''}`}>
          <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
          <span>
            I have read the privacy notice{versions ? ` (version ${versions.privacyVersion})` : ''}.
            <br />
            <span className="muted small">Draft: the document is not published yet.</span>
          </span>
        </label>
        {error ? <div className="note bad" role="alert">{error}</div> : null}
        <button className="btn primary" type="submit" disabled={busy || !versions || !terms || !privacy}>
          {busy ? 'Creating your account…' : 'Create account'}
        </button>
      </form>
      <p className="small">
        Already registered? <Link href="/signin/">Sign in</Link>
      </p>
    </>
  );
}
