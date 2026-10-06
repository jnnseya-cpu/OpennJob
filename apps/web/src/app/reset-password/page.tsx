'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { FormEvent } from 'react';
import { api, clearSession, errorText } from '../../lib/api';

/** ACC-3: a new password from the one-time link or code. Every earlier session ends. */
function Reset() {
  const fromLink = useSearchParams()?.get('token') ?? '';
  const router = useRouter();
  const [code, setCode] = useState(fromLink);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/auth/password/reset', { method: 'POST', body: { token: code.trim(), password }, auth: false });
      // Every earlier session has ended: this browser's too.
      clearSession();
      router.replace('/signin/?notice=reset');
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Choose a new password</h1>
      <form className="card" onSubmit={submit}>
        {fromLink ? null : (
          <label className="field">
            <span>Code from the e-mail</span>
            <input autoComplete="one-time-code" spellCheck={false} required value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>New password</span>
          <input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="field">
          <span>New password again</span>
          <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        <p className="small muted">At least 12 characters. A few unrelated words make a strong password. You will be signed out everywhere.</p>
        {error ? <div className="note bad" role="alert">{error}</div> : null}
        <button className="btn primary" type="submit" disabled={busy || code.trim().length < 32}>
          {busy ? 'Saving…' : 'Save the new password'}
        </button>
      </form>
      <p className="small">
        <Link href="/forgot-password/">Ask for a new link</Link> · <Link href="/signin/">Back to sign in</Link>
      </p>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <Reset />
    </Suspense>
  );
}
