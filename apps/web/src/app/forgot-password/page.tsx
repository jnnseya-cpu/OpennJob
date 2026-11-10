'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorText } from '../../lib/api';

/** ACC-3: the reply is the same whether or not the address has an account. */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email }, auth: false });
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Reset your password</h1>
      {sent ? (
        <div className="note ok" role="status">
          If an account uses that address, a reset link is on its way. It works once and expires after one hour. <Link href="/reset-password/">I have a code</Link>
        </div>
      ) : (
        <form className="card" onSubmit={submit}>
          <label className="field">
            <span>Email address</span>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error ? <div className="note bad" role="alert">{error}</div> : null}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send a reset link'}
          </button>
        </form>
      )}
      <p className="small">
        <Link href="/signin/">Back to sign in</Link>
      </p>
    </>
  );
}
