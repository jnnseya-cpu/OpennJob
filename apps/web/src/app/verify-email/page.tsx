'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorText, isSignedIn } from '../../lib/api';

/** ACC-2: the link in the e-mail opens this page with ?token=; the code can also be typed in. */
function Verify() {
  const fromLink = useSearchParams()?.get('token') ?? '';
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);

  async function verify(token: string) {
    setBusy(true);
    setError('');
    try {
      await api('/auth/verify-email', { method: 'POST', body: { token: token.trim() }, auth: false });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (fromLink && !tried.current) {
      tried.current = true;
      void verify(fromLink);
    }
  }, [fromLink]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void verify(code);
  }

  return (
    <>
      <h1>Confirm your e-mail address</h1>
      {done ? (
        <div className="note ok" role="status">
          Your e-mail address is confirmed. <Link href={isSignedIn() ? '/dashboard/' : '/signin/'}>{isSignedIn() ? 'Back to your dashboard' : 'Sign in'}</Link>
        </div>
      ) : (
        <form className="card" onSubmit={submit}>
          {fromLink && busy ? <p className="muted small">Checking your link…</p> : null}
          <label className="field">
            <span>Code from the e-mail</span>
            <input autoComplete="one-time-code" spellCheck={false} required value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          {error ? <div className="note bad" role="alert">{error}</div> : null}
          <button className="btn primary" type="submit" disabled={busy || code.trim().length < 32}>
            {busy ? 'Checking…' : 'Confirm'}
          </button>
          <p className="small muted">The link and the code work once and expire after 24 hours. Signed in, you can ask for a new one from the banner at the top of any page.</p>
        </form>
      )}
    </>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <Verify />
    </Suspense>
  );
}
