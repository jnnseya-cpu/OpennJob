'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { api, errorText } from '../../lib/api';
import { ALL_FIELDS_CHECKED, STATEMENT_FIELD, declarationField, declarationsFor } from '../../lib/declarations';
import { HOLD_LABEL, STATUS_LABEL, needsLabel, placeOf } from '../../lib/labels';
import type { Application, MatchView } from '../../lib/types';

const FILLED: [string, string][] = [
  ['Name, contact details', 'from your profile'],
  ['Employment history', 'from your CV'],
  ['Qualifications', 'from your CV'],
  ['Tickets and memberships', 'from your credential passport, after you confirm each one on the form'],
  ['Supporting statement', 'the text below, as saved'],
];

function Review() {
  const jobId = useSearchParams()?.get('job') ?? '';
  const { mode, refreshWaiting } = useApp();
  const [match, setMatch] = useState<MatchView>();
  const [app, setApp] = useState<Application>();
  const [loaded, setLoaded] = useState(false);
  const [statement, setStatement] = useState('');
  // APP-7: "I have submitted it" records the site's confirmation page and what it said.
  const [receiptUrl, setReceiptUrl] = useState('');
  const [receiptText, setReceiptText] = useState('');
  // Nothing here starts ticked, except what this user already confirmed and the API recorded.
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const showApp = useCallback((a: Application | undefined) => {
    setApp(a);
    setStatement(a?.statement ?? '');
    setTicked(new Set(a?.confirmedFields ?? []));
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [matches, apps] = await Promise.all([api<MatchView[]>('/jobs/matches?min=0'), api<Application[]>('/applications')]);
        if (!live) return;
        setMatch(matches.find((m) => m.job.id === jobId));
        showApp(apps.find((a) => a.jobId === jobId));
      } catch (err) {
        if (live) setError(errorText(err));
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [jobId, showApp]);

  async function prepare() {
    setBusy(true);
    setError('');
    try {
      showApp(await api<Application>('/applications', { method: 'POST', body: { jobId, mode } }));
      refreshWaiting();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveStatement(): Promise<Application | undefined> {
    if (!app) return undefined;
    const updated = await api<Application>(`/applications/${encodeURIComponent(app.id)}/statement`, { method: 'PUT', body: { statement } });
    setApp(updated);
    setStatement(updated.statement);
    return updated;
  }

  async function onSave() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await saveStatement();
      setNotice('Statement saved. The extension fills this text.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const declarations = declarationsFor(match?.job);

  async function approve() {
    if (!app) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (statement !== app.statement) await saveStatement();
      const fields = [STATEMENT_FIELD, ...declarations.map((d) => declarationField(d.id)), ...(app.mode === 'review' ? [ALL_FIELDS_CHECKED] : [])];
      showApp(await api<Application>(`/applications/${encodeURIComponent(app.id)}/confirm`, { method: 'POST', body: { confirmedFields: fields } }));
      refreshWaiting();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function markSubmitted() {
    if (!app) return;
    setBusy(true);
    setError('');
    try {
      showApp(await api<Application>(`/applications/${encodeURIComponent(app.id)}/submitted`, { method: 'POST', body: { pageUrl: receiptUrl.trim(), confirmationText: receiptText.trim() } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (field: string, on: boolean) =>
    setTicked((t) => {
      const next = new Set(t);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });

  if (!loaded) return <p className="muted small">Loading…</p>;

  const title = match?.job.title ?? app?.jobTitle;
  if (!title) {
    return (
      <>
        <Link href="/matches/">← Back</Link>
        <div className="empty">This job is not in your matches any more.</div>
        {error ? <div className="note bad" role="alert">{error}</div> : null}
      </>
    );
  }

  const status = app?.status;
  // A held application (needs_you) is still the person's to correct and approve.
  const editable = status === 'draft' || status === 'needs_you';
  const appMode = app?.mode ?? mode;
  const allDeclared = declarations.every((d) => ticked.has(declarationField(d.id)));
  const reviewed = appMode !== 'review' || ticked.has(ALL_FIELDS_CHECKED);
  const canApprove = editable && allDeclared && reviewed && statement.trim() !== '' && !busy;

  return (
    <>
      <Link href="/matches/">← Back</Link>
      <div>
        <h2>{title}</h2>
        <p className="muted">
          {match ? `${match.job.employer} · ${placeOf(match.job)}` : app?.employer}
          {status ? ` · ${STATUS_LABEL[status]}` : ''}
        </p>
      </div>
      {match && !match.eligible ? <div className="note">This post needs your {needsLabel(match.missingCredential)}. Add it in Profile to apply.</div> : null}

      {match ? (
        <section className="card">
          <div className="row">
            <span className="label grow">Requirements</span>
            <span className="num">{match.score}% match</span>
          </div>
          <div>
            {match.hits.map((h) => (
              <div key={h.label} className="crit">
                <span className={`chip ${h.matched ? '' : 'gap'}`}>{h.matched ? 'Met' : 'Gap'}</span>
                <span>
                  {h.label} <span className="muted small">{h.essential ? 'essential' : 'desirable'}</span>
                </span>
                {h.evidence ? <span className="ev">“{h.evidence}”</span> : h.statedLanguage ? <span className="ev">You speak {h.statedLanguage}.</span> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!app ? (
        <>
          {error ? <div className="note bad" role="alert">{error}</div> : null}
          <button className="btn primary" type="button" onClick={prepare} disabled={busy || !match?.eligible}>
            {busy ? 'Preparing…' : 'Prepare application'}
          </button>
          <p className="small muted">This drafts a supporting statement from your CV. Nothing is sent.</p>
        </>
      ) : (
        <>
          {status === 'needs_you' ? (
            <section className="card" aria-label="Held for you">
              <span className="label">Held for you</span>
              <ul className="plain small">
                {(app.holdReasons ?? []).map((r) => (
                  <li key={`h-${r}`}>{HOLD_LABEL[r] ?? r}</li>
                ))}
                {(app.traceFailures ?? []).map((f) => (
                  <li key={`t-${f}`}>{f}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {app.gaps.length || app.warnings.length ? (
            <section className="card">
              <span className="label">Before you approve</span>
              <ul className="plain small">
                {app.gaps.map((g) => (
                  <li key={`g-${g}`}>Not evidenced in your CV: {g}</li>
                ))}
                {app.warnings.map((w) => (
                  <li key={`w-${w}`}>{w}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="card">
            <div className="row">
              <label className="label grow" htmlFor="statement">
                Supporting statement{match?.job.language === 'fr' ? ' · French' : ''}
              </label>
              {editable ? (
                <button className="btn" type="button" onClick={onSave} disabled={busy || statement === app.statement || statement.trim() === ''}>
                  Save changes
                </button>
              ) : null}
            </div>
            <textarea id="statement" value={statement} readOnly={!editable} onChange={(e) => setStatement(e.target.value)} />
            <p className="small muted">
              {app.statementSource === 'llm' ? 'Drafted by an AI model from your CV. ' : 'Built from your CV without AI. '}
              Read every line before you approve. Anything in square brackets is for you to fix.
            </p>
          </section>

          <section className="card">
            <span className="label">The extension fills these</span>
            <dl className="kv">
              {FILLED.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {appMode === 'review' && editable ? (
              <label className={`confirm ${ticked.has(ALL_FIELDS_CHECKED) ? 'on' : ''}`}>
                <input type="checkbox" checked={ticked.has(ALL_FIELDS_CHECKED)} onChange={(e) => toggle(ALL_FIELDS_CHECKED, e.target.checked)} />
                <span>I have checked every field above.</span>
              </label>
            ) : null}
          </section>

          <section className="card" aria-label="Only you confirm these">
            <span className="label">Only you confirm these</span>
            <p className="small muted">
              Tick each one to say you will answer it yourself on the employer’s form. OpennJob does not store your answers and never fills
              them in.
            </p>
            {declarations.map((d) => {
              const field = declarationField(d.id);
              return (
                <label key={d.id} className={`confirm ${ticked.has(field) ? 'on' : ''}`}>
                  <input type="checkbox" checked={ticked.has(field)} disabled={!editable} onChange={(e) => toggle(field, e.target.checked)} />
                  <span>
                    {d.label}
                    <br />
                    <span className="muted small">The agent never answers this for you.</span>
                  </span>
                </label>
              );
            })}
            {appMode === 'auto' ? (
              <p className="note small">Auto mode never submits a form that has a declaration or other sensitive field. This form waits for you.</p>
            ) : null}
          </section>

          {error ? <div className="note bad" role="alert">{error}</div> : null}
          {notice ? <div className="note ok" role="status">{notice}</div> : null}

          {editable ? (
            <>
              <button className="btn primary" type="button" onClick={approve} disabled={!canApprove}>
                Approve
              </button>
              {!canApprove && !busy ? (
                <p className="small muted">
                  {statement.trim() === '' ? 'Write a supporting statement first. ' : ''}
                  {!allDeclared || !reviewed ? 'Tick each confirmation to enable Approve.' : ''}
                </p>
              ) : null}
            </>
          ) : null}

          {status === 'confirmed' ? (
            <section className="card" aria-label="Next steps">
              <p>
                <b>Approved. Nothing has been sent to the employer.</b>
              </p>
              <ol className="small">
                <li>Open the employer’s form.</li>
                <li>Use the OpennJob extension to fill it. It asks you again before it writes any sensitive field.</li>
                <li>Answer the declarations yourself and submit the form, then record it here.</li>
              </ol>
              <div className="row">
                <a className="btn" href={app.applyUrl} target="_blank" rel="noopener noreferrer">
                  Open the employer’s form
                </a>
              </div>
              <label className="label" htmlFor="receipt-url">
                Address of the confirmation page
              </label>
              <input id="receipt-url" type="url" inputMode="url" placeholder="https://" value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} />
              <label className="label" htmlFor="receipt-text">
                What the site said when you submitted
              </label>
              <textarea id="receipt-text" rows={2} value={receiptText} onChange={(e) => setReceiptText(e.target.value)} />
              <button className="btn primary" type="button" onClick={markSubmitted} disabled={busy || !/^https?:\/\/\S+/.test(receiptUrl.trim()) || receiptText.trim().length < 3}>
                I have submitted it
              </button>
              <p className="small muted">OpennJob records an application as sent only with the site’s own confirmation.</p>
            </section>
          ) : null}

          {status === 'submitted' ? (
            <div className="card">
              <p>
                <b>Submitted.</b> You recorded this application as sent{app.submittedAt ? ` on ${new Date(app.submittedAt).toLocaleDateString('en-GB')}` : ''}.
              </p>
              <Link className="btn" href="/tracker/">
                Open tracker
              </Link>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

export default function ReviewPage() {
  return (
    <Suspense fallback={null}>
      <Review />
    </Suspense>
  );
}
