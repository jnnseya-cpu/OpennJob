'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorText, setSession } from '../../lib/api';
import type { AuthResult } from '../../lib/types';

const NOTICES: Record<string, string> = {
  expired: 'Your session ended. Sign in again.',
  deleted: 'Your account and everything stored for it were deleted.',
  signedout: 'You are signed out on this device.',
};

function SignIn() {
  const notice = NOTICES[useSearchParams()?.get('notice') ?? ''];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<AuthResult>('/auth/login', { method: 'POST', body: { email, password }, auth: false });
      setSession({ accessToken: r.accessToken, expiresAt: r.expiresAt }, '/dashboard/');
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Sign in</h1>
      {notice ? <div className="note ok" role="status">{notice}</div> : null}
      <form className="card" onSubmit={submit}>
        <label className="field">
          <span>Email address</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error ? <div className="note bad" role="alert">{error}</div> : null}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" className="link" onClick={() => setForgot(true)}>
          Forgot your password?
        </button>
        {forgot ? (
          <p className="note" role="status">
            Password reset is not available yet. There is no way to recover an account without its password at the moment.
          </p>
        ) : null}
      </form>
      <p className="small">
        New here? <Link href="/register/">Create an account</Link>
      </p>
    </>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignIn />
    </Suspense>
  );
}
