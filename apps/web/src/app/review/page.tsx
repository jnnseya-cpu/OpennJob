'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { api, errorText } from '../../lib/api';
import { ALL_FIELDS_CHECKED, STATEMENT_FIELD, declarationField, declarationsFor } from '../../lib/declarations';
import { ADZUNA_URL, HOLD_LABEL, STATUS_LABEL, isAdzuna, needsLabel, placeOf } from '../../lib/labels';
import { describeWorkRights, workRightsProblem } from '../../lib/core';
import type { WorkRightsRecord } from '../../lib/core';
import type { AgentStatus, Application, MatchView, PassportView, PublicUser } from '../../lib/types';

const FILLED: [string, string][] = [
  ['Name, contact details', 'from your profile'],
  ['Employment history', 'from your CV'],
  ['Qualifications', 'from your CV'],
  ['Tickets and memberships', 'from your credential passport, after you confirm each one on the form'],
  ['Referees', 'from your credential passport (Profile), after you confirm each one on the form'],
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
  const [agent, setAgent] = useState<AgentStatus>();
  const [verified, setVerified] = useState<boolean>();
  const [workRights, setWorkRights] = useState<WorkRightsRecord[]>([]);
  useEffect(() => {
    api<AgentStatus>('/agent/status').then(setAgent).catch(() => undefined);
    api<PublicUser>('/account').then((u) => setVerified(u.emailVerified)).catch(() => undefined);
    api<PassportView>('/passport').then((v) => setWorkRights(v.passport.workRights ?? [])).catch(() => undefined);
  }, []);

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

  // OD-5: a valid right-to-work record for the job's country answers right to work and sponsorship.
  const today = new Date().toISOString().slice(0, 10);
  const record = workRights.find((r) => r.country === match?.job.country && !workRightsProblem(r, today));
  // Referees are filled from the passport after the person confirms them on the form, and right to
  // work from a valid record, so they are listed under "The extension fills these", not here.
  const declarations = declarationsFor(match?.job).filter((d) => d.id !== 'ref' && !(record && d.id === 'rtw'));
  const filled: [string, string][] = record ? [...FILLED, ['Right to work and sponsorship', `filled from your record: ${describeWorkRights(record)}`]] : FILLED;

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
          {match && isAdzuna(match.job) ? (
            <>
              {' · '}
              <a href={ADZUNA_URL} target="_blank" rel="noopener noreferrer">
                Jobs by Adzuna
              </a>
            </>
          ) : null}
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
              {filled.map(([k, v]) => (
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
          </section>

          {appMode === 'auto' && status !== 'submitted' ? <AutoChecklist agent={agent} verified={verified} declarations={declarations.map((d) => d.label)} rightToWork={record ? describeWorkRights(record) : null} emailApply={match?.emailApply === true} /> : null}

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
                <b>Approved, not sent yet.</b> The checklist above says what is stopping OpennJob from sending it for you. To send it now:
              </p>
              <ol className="small">
                <li>Open the employer’s form.</li>
                <li>Press Fill in the OpennJob extension: your details, CV and statement go in; it asks before any sensitive field.</li>
                <li>Answer the declarations, press submit, then paste the confirmation here.</li>
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

/**
 * What stands between this application and OpennJob sending it without the person: each line is
 * met or not, read from the account and the agent status. Declarations on the form always stop it.
 */
function AutoChecklist({ agent, verified, declarations, rightToWork, emailApply }: { agent?: AgentStatus; verified?: boolean; declarations: string[]; rightToWork: string | null; emailApply: boolean }) {
  const enabledSystems = (agent?.systems ?? []).filter((s) => s.enabled).map((s) => s.label);
  const on = agent ? agent.authorisation.enabled && !agent.authorisation.paused : undefined;
  const all: { ok: boolean | undefined; text: string; fix?: { href: string; label: string }; formOnly?: true }[] = [
    { ok: verified, text: verified ? 'Your e-mail address is confirmed.' : 'Your e-mail address is not confirmed.', ...(verified === false ? { fix: { href: '/verify-email/', label: 'Confirm it' } } : {}) },
    {
      ok: on,
      text: on ? 'Automatic applications are on.' : agent?.authorisation.paused ? 'Automatic applications are paused.' : 'Automatic applications are off.',
      ...(on === false ? { fix: { href: '/account/', label: 'Turn them on in Account' } } : {}),
    },
    {
      formOnly: true,
      ok: enabledSystems.length > 0 ? undefined : agent ? false : undefined,
      text:
        enabledSystems.length > 0
          ? `OpennJob can send only on: ${enabledSystems.join(', ')}. Another site waits for you.`
          : 'No employer application system is enabled yet: each needs one supervised test submission first.',
    },
    ...(emailApply
      ? [{ ok: true as const, text: 'The advert gives a recruiter’s e-mail address: OpennJob can e-mail your tailored CV and statement there, in your name, with replies to you. No form, so no declarations.' }]
      : []),
    {
      formOnly: true,
      ok: rightToWork !== null,
      text: rightToWork ? `Right to work and sponsorship are answered from your record: ${rightToWork}.` : 'No right-to-work record for this job’s country, so those questions wait for you.',
      ...(rightToWork ? {} : { fix: { href: '/profile/', label: 'Add one in Profile' } }),
    },
    {
      formOnly: true,
      ok: declarations.length === 0,
      text: declarations.length ? `This job’s form asks for things only you answer (${declarations.join('; ')}). A form with any of them waits for you.` : 'No declaration expected.',
    },
  ];
  // By e-mail there is no form: the form-only lines do not apply.
  const rows = all.filter((row) => !(emailApply && row.formOnly));
  if (agent && agent.dailyLimit.remaining === 0) rows.push({ ok: false, text: `Today’s limit of ${agent.dailyLimit.limit} automatic applications is reached.` });
  return (
    <section className="card" aria-label="What stops automatic sending" data-testid="auto-checklist">
      <span className="label">Can OpennJob send this for you?</span>
      <ul className="plain checklist">
        {rows.map((row) => (
          <li key={row.text} className={row.ok === true ? 'ok' : row.ok === false ? 'no' : 'unknown'}>
            <span aria-hidden="true">{row.ok === true ? '✓' : row.ok === false ? '✗' : '•'}</span> {row.text}
            {row.fix ? (
              <>
                {' '}
                <Link href={row.fix.href}>{row.fix.label}</Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
