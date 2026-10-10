'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { StageBar, StatTiles } from '../../components/Charts';
import { api, errorText } from '../../lib/api';
import { HOLD_LABEL, RETRYABLE_HOLD, STATUS_LABEL } from '../../lib/labels';
import type { AgentStatus, Application, InterviewRates } from '../../lib/types';

const ORDER: Record<Application['status'], number> = { needs_you: 0, uncertain: 1, draft: 2, confirmed: 3, interview: 4, submitted: 5, closed: 6 };
const MODE_NAME: Record<Application['mode'], string> = { review: 'review all', hybrid: 'hybrid', auto: 'auto' };

/** Will go out without the person (by e-mail or an enabled form) unless they skip it: the queue's own test. */
const goesOutAutomatically = (a: Application) =>
  a.mode === 'auto' && (a.status === 'draft' || a.status === 'confirmed') && !a.holdReasons?.length && !a.traceFailures?.length && a.attemptedAt === undefined;

type Route = 'email' | 'form' | 'you';
const ROUTE_NAME: Record<Route, string> = { email: 'By e-mail to the recruiter', form: 'On a form, by the agent', you: 'Sent by you' };
const routeOf = (a: Application): Route => (a.receipt?.pageUrl.startsWith('mailto:') ? 'email' : a.receipt?.automatic || a.automatic ? 'form' : 'you');
const BAR_TEXT: Record<InterviewRates['bar']['reason'], (r: InterviewRates['bar']) => string> = {
  'no-target': (r) => `Automatic applications need a ${r.bar}% match. Set a target interview rate on your Profile and the bar will adjust itself from your results.`,
  learning: (r) => `Aiming for ${r.target}% of applications to lead to an interview. Learning: ${r.outcomes} of ${r.needed} outcomes recorded. Until then automatic applications need a ${r.bar}% match.`,
  'meets-target': (r) => `Aiming for ${r.target}%: applications at ${r.bar}% or more reached ${r.rateAtBar}% interviews, so only those go out on their own.`,
  'below-target': (r) => `Aiming for ${r.target}%: no score band has reached it yet${r.rateAtBar !== undefined ? ` (${r.rateAtBar}% at ${r.bar}%+)` : ''}, so only the closest matches (${r.bar}% or more) go out on their own. The rest wait for you.`,
};
const SYSTEM_NAME: Record<string, string> = { workday: 'Workday', successfactors: 'SuccessFactors', greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workable: 'Workable' };
function noRouteText(reason: string | undefined): string {
  if (reason === 'job-board') return 'The link is the job board’s own page (Reed, Indeed, LinkedIn…): OpennJob never presses a job board’s apply button. Paste the employer’s own application page, if the advert gives one, and the queue applies there.';
  if (reason === 'aggregator') return 'The link goes through a job search site (Adzuna, Jooble). Open it, and paste the employer’s application page it leads to.';
  if (reason?.startsWith('system-off:')) {
    const id = reason.slice(11);
    return `${SYSTEM_NAME[id] ?? id} is not switched on yet. After one supervised test: bash deploy/enable-system.sh ${id}`;
  }
  return 'OpennJob does not know this site’s application system, so it cannot send it. Apply there yourself, or paste a Workday or SuccessFactors link if the employer uses one.';
}

const OUTCOME_NAME: Record<NonNullable<Application['outcome']>, string> = { interview: 'Interview', rejected: 'Rejected', 'no-reply': 'No reply' };

function holdText(reason: string): string {
  if (HOLD_LABEL[reason]) return HOLD_LABEL[reason];
  if (reason.startsWith('question:')) return `A question with no stored answer: “${reason.slice(9)}”. Open it (Documents) and answer it there.`;
  if (reason.startsWith('sensitive:')) return `A ${reason.slice(10).replace(/-/g, ' ')} question that only you answer.`;
  if (reason.startsWith('steps-saved:')) return `OpennJob filled and saved the first ${reason.slice(12)} step(s) on the employer’s site and left it open in a tab: finish from the step it stopped at.`;
  if (reason.startsWith('step-refused:')) return `The employer’s site did not move to the next step. It said: “${reason.slice(13)}”`;
  return reason;
}

export default function TrackerPage() {
  const { agentMessage } = useApp();
  const [apps, setApps] = useState<Application[]>();
  const [error, setError] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [rates, setRates] = useState<InterviewRates>();
  const [agent, setAgent] = useState<AgentStatus>();
  const [links, setLinks] = useState<Record<string, string>>({});
  const [found, setFound] = useState({ url: '', title: '', employer: '', location: '', description: '' });
  const [foundMessage, setFoundMessage] = useState('');
  async function applyToLink() {
    setBusyId('from-link');
    setError('');
    setFoundMessage('');
    try {
      const body = { url: found.url.trim(), title: found.title.trim(), employer: found.employer.trim(), description: found.description.trim(), ...(found.location.trim() ? { location: found.location.trim() } : {}) };
      const r = await api<{ application: Application; route: 'email' | 'form' | 'none'; reason?: string }>('/applications/from-link', { method: 'POST', body });
      setApps((list) => [...(list ?? []), r.application]);
      setAgent(await api<AgentStatus>('/agent/status'));
      setFound({ url: '', title: '', employer: '', location: '', description: '' });
      setFoundMessage(
        r.route === 'form'
          ? `Prepared at ${r.application.score}% with a tailored CV and cover letter. Open the extension and press Start the queue: it applies on that page and stops for you on anything only you answer.`
          : r.route === 'email'
            ? `Prepared at ${r.application.score}%. The advert names a recruiter's address, so it is e-mailed with your tailored CV and cover letter at the next agent run.`
            : `Prepared at ${r.application.score}%, but it cannot go out on its own: ${noRouteText(r.reason)}`,
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId('');
    }
  }
  async function saveLink(id: string) {
    setBusyId(id);
    setError('');
    try {
      replace(await api<Application>(`/applications/${encodeURIComponent(id)}/apply-url`, { method: 'POST', body: { url: (links[id] ?? '').trim() } }));
      setAgent(await api<AgentStatus>('/agent/status'));
      setLinks((l) => ({ ...l, [id]: '' }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId('');
    }
  }

  const replace = (updated: Application) => setApps((list) => list?.map((x) => (x.id === updated.id ? updated : x)));
  async function act(id: string, path: 'skip' | 'outcome' | 'retry', body?: object) {
    setBusyId(id);
    setError('');
    try {
      replace(await api<Application>(`/applications/${encodeURIComponent(id)}/${path}`, { method: 'POST', ...(body ? { body } : {}) }));
      if (path === 'outcome') setRates(await api<InterviewRates>('/agent/interview-rates'));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId('');
    }
  }
  const sent = (apps ?? []).filter((a) => a.submittedAt);
  // Once results have raised the bar, only applications at or above it go out on their own.
  const raised = rates && rates.bar.bar > rates.bar.base ? rates.bar.bar : 0;
  const ready = (apps ?? []).filter((a) => goesOutAutomatically(a) && a.score >= raised);
  // Only what has a way out goes out on its own: an e-mail address in the advert, or an enabled application system.
  const autoRouteOf = (a: Application) => agent?.routes?.[a.id] ?? 'none';
  const outgoing = ready.filter((a) => autoRouteOf(a) !== 'none');
  const noRoute = ready.filter((a) => autoRouteOf(a) === 'none');
  const ROUTE_LABEL = { email: 'by e-mail to the recruiter', form: 'on the form, through the extension', none: '' } as const;

  useEffect(() => {
    api<Application[]>('/applications')
      .then((list) => setApps([...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt.localeCompare(a.createdAt))))
      .catch((err) => setError(errorText(err)));
    api<InterviewRates>('/agent/interview-rates')
      .then(setRates)
      .catch((err) => setError(errorText(err)));
    api<AgentStatus>('/agent/status')
      .then(setAgent)
      .catch(() => undefined);
  }, []);

  return (
    <>
      <h2>Tracker</h2>
      {agentMessage ? <div className="note ok" role="status">{agentMessage}</div> : null}
      {error ? <div className="note bad" role="alert">{error}</div> : null}
      {apps === undefined && !error ? <p className="muted small">Loading…</p> : null}
      <section className="card" aria-label="Apply to this link" data-testid="from-link">
        <span className="label">Apply to a job you found</span>
        <p className="small muted">
          Found a job on an employer’s own site (Workday, SuccessFactors)? Paste its application page and the advert. OpennJob writes a CV and cover letter for it, and the extension’s queue applies there.
        </p>
        <div className="grid2">
          <label className="field"><span>Application page</span><input type="url" placeholder="https://…myworkdayjobs.com/… or …successfactors…" value={found.url} onChange={(e) => setFound((f) => ({ ...f, url: e.target.value }))} /></label>
          <label className="field"><span>Job title</span><input type="text" value={found.title} onChange={(e) => setFound((f) => ({ ...f, title: e.target.value }))} /></label>
          <label className="field"><span>Employer</span><input type="text" value={found.employer} onChange={(e) => setFound((f) => ({ ...f, employer: e.target.value }))} /></label>
          <label className="field"><span>Town or city (optional)</span><input type="text" value={found.location} onChange={(e) => setFound((f) => ({ ...f, location: e.target.value }))} /></label>
        </div>
        <label className="field"><span>The advert (copy and paste the whole text)</span><textarea rows={6} value={found.description} onChange={(e) => setFound((f) => ({ ...f, description: e.target.value }))} /></label>
        <div className="row">
          <button type="button" className="btn primary" disabled={busyId === 'from-link' || !found.url.trim() || !found.title.trim() || !found.employer.trim() || found.description.trim().length < 50} onClick={applyToLink}>
            {busyId === 'from-link' ? 'Preparing…' : 'Prepare and apply'}
          </button>
        </div>
        {foundMessage ? <p className="note ok small" role="status" data-testid="from-link-result">{foundMessage}</p> : null}
      </section>
      {apps && apps.length ? (
        <>
          <StatTiles
            items={(() => {
              const submitted = apps.filter((a) => a.submittedAt).length;
              const interviews = apps.filter((a) => a.outcome === 'interview' || a.status === 'interview').length;
              return [
                { label: 'Open applications', value: apps.filter((a) => a.status !== 'closed').length },
                { label: 'Submitted', value: submitted },
                { label: 'Interviews', value: interviews },
                // Honest headline metric: of what you actually sent, how many led to an interview.
                { label: 'Interview rate (of submitted)', value: submitted ? `${Math.round((100 * interviews) / submitted)}%` : '—' },
              ];
            })()}
          />
          <section className="card">
            <StageBar
              title="Where your applications are"
              stages={[
                { label: 'Waiting for you', count: apps.filter((a) => a.status === 'draft').length },
                { label: 'Approved, not sent', count: apps.filter((a) => a.status === 'confirmed').length },
                { label: 'Submitted', count: apps.filter((a) => a.status === 'submitted').length },
              ]}
            />
          </section>
        </>
      ) : null}
      {outgoing.length ? (
        <section className="card" aria-label="Going out automatically" data-testid="outgoing">
          <span className="label">Going out automatically · {outgoing.length}</span>
          <p className="small muted">These go out without you unless you skip them. Skipped ones are closed.</p>
          {agent && !agent.authorisation.enabled ? (
            <p className="small note" data-testid="authorisation-off">
              Standing authorisation is off, so nothing goes out yet. <Link href="/account/">Turn it on in Account</Link>
            </p>
          ) : agent?.message ? (
            <p className="small note">{agent.message}</p>
          ) : null}
          <ul className="plain review-list">
            {outgoing.map((a) => (
              <li key={a.id} className="row">
                <span className="grow">
                  <b>{a.jobTitle}</b> · {a.employer} · {a.score}% · <span className="muted">{ROUTE_LABEL[autoRouteOf(a)]}</span>
                </span>
                <Link className="small" href={`/review/?job=${encodeURIComponent(a.jobId)}`}>
                  Check
                </Link>
                <button type="button" className="btn" disabled={busyId === a.id} onClick={() => act(a.id, 'skip')}>
                  Skip
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {noRoute.length ? (
        <section className="card" aria-label="Ready, but you apply" data-testid="no-route">
          <span className="label">Ready, but you apply · {noRoute.length}</span>
          <p className="small muted">
            These adverts give no recruiter e-mail address and their application site is not switched on for OpennJob, so it cannot send them. Open the advert and apply there; your tailored CV and cover letter are on the review page. Then press “I have submitted it” there so the Tracker and the report count it.
          </p>
          <ul className="plain review-list">
            {noRoute.map((a) => (
              <li key={a.id} className="row" data-testid="no-route-item">
                <span className="grow">
                  <b>{a.jobTitle}</b> · {a.employer} · {a.score}%
                  <br />
                  <span className="small muted" data-testid="no-route-reason">{noRouteText(agent?.routeReasons?.[a.id])}</span>
                  <span className="row">
                    <input type="url" className="grow" aria-label={`Employer's application page for ${a.jobTitle}`} placeholder="https://… the employer's own application page" value={links[a.id] ?? ''} onChange={(e) => setLinks((l) => ({ ...l, [a.id]: e.target.value }))} />
                    <button type="button" className="btn" disabled={busyId === a.id || !(links[a.id] ?? '').trim()} onClick={() => saveLink(a.id)}>
                      Use this link
                    </button>
                  </span>
                </span>
                <a className="small" href={a.applyUrl} target="_blank" rel="noopener noreferrer">
                  Open advert
                </a>
                <Link className="small" href={`/review/?job=${encodeURIComponent(a.jobId)}`}>
                  Documents
                </Link>
                <button type="button" className="btn" disabled={busyId === a.id} onClick={() => act(a.id, 'skip')}>
                  Skip
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {sent.length ? (
        <section className="card" aria-label="Replies by route" data-testid="replies-by-route">
          <span className="label">Replies by route</span>
          <table className="routes">
            <thead>
              <tr>
                <th scope="col">Route</th>
                <th scope="col">Sent</th>
                <th scope="col">Interviews</th>
                <th scope="col">Rejected</th>
                <th scope="col">Interview rate</th>
              </tr>
            </thead>
            <tbody>
              {(['email', 'form', 'you'] as Route[]).map((route) => {
                const mine = sent.filter((a) => routeOf(a) === route);
                if (!mine.length) return null;
                const interviews = mine.filter((a) => a.outcome === 'interview').length;
                return (
                  <tr key={route}>
                    <th scope="row">{ROUTE_NAME[route]}</th>
                    <td>{mine.length}</td>
                    <td>{interviews}</td>
                    <td>{mine.filter((a) => a.outcome === 'rejected').length}</td>
                    <td>{Math.round((100 * interviews) / mine.length)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small muted">Counted from what you record on each sent application below. OpennJob does not read your e-mail.</p>
        </section>
      ) : null}
      {rates ? (
        <section className="card" aria-label="Interview rate by match score" data-testid="interview-rates">
          <span className="label">Interview rate by match score</span>
          <p className="small" data-testid="automatic-bar">{BAR_TEXT[rates.bar.reason](rates.bar)}</p>
          {rates.bands.some((b) => b.sent) ? (
            <table className="routes">
              <thead>
                <tr>
                  <th scope="col">Match</th>
                  <th scope="col">Sent</th>
                  <th scope="col">Outcome recorded</th>
                  <th scope="col">Interviews</th>
                  <th scope="col">Interview rate</th>
                </tr>
              </thead>
              <tbody>
                {rates.bands
                  .filter((b) => b.sent)
                  .map((b) => (
                    <tr key={b.label}>
                      <th scope="row">{b.label}</th>
                      <td>{b.sent}</td>
                      <td>{b.outcomes}</td>
                      <td>{b.interviews}</td>
                      <td>{b.rate === undefined ? '–' : `${b.rate}%`}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : null}
          <p className="small muted">Record Interview, Rejected or No reply on each sent application: the bar learns only from what you record.</p>
        </section>
      ) : null}
      {apps && !apps.length ? <div className="empty">No applications yet. Open a match, or tap Run agent on the Matches tab.</div> : null}
      <div className="stack list">
        {apps?.filter((a) => showClosed || a.status !== 'closed').map((a) => (
          <div key={a.id} className="card" data-testid="application">
            <div className="row">
              <div className="grow">
                <h3>{a.jobTitle}</h3>
                <p className="muted small">
                  {a.employer} · {a.score}% match · {MODE_NAME[a.mode]} mode · prepared {new Date(a.createdAt).toLocaleDateString('en-GB')}
                </p>
              </div>
              <span className={`chip ${a.status === 'draft' ? 'gap' : ''}`}>{STATUS_LABEL[a.status]}</span>
            </div>
            {a.status === 'needs_you' && a.holdReasons?.length ? (
              <ul className="plain small" aria-label="Why it waits for you">
                {a.holdReasons.map((r) => (
                  <li key={r}>{holdText(r)}</li>
                ))}
              </ul>
            ) : null}
            {a.status === 'needs_you' && a.attemptedAt === undefined && a.holdReasons?.some((r) => RETRYABLE_HOLD.test(r)) ? (
              <div className="row">
                <a className="btn" href={a.applyUrl} target="_blank" rel="noopener noreferrer">
                  Open the employer’s site
                </a>
                <button type="button" className="btn" disabled={busyId === a.id} onClick={() => act(a.id, 'retry')} data-testid="retry">
                  {a.holdReasons.includes('login-wall') ? 'I have signed in: try again' : 'Try again'}
                </button>
              </div>
            ) : null}
            {a.receipt ? (
              <div className="small" data-testid="receipt">
                <b>Confirmation from the site</b>
                {a.receipt.automatic ? ' (sent by the agent under your standing authorisation)' : ''}: <span className="quote">“{a.receipt.confirmationText}”</span>
                <br />
                <span className="muted">
                  {new Date(a.receipt.at).toLocaleString('en-GB')} · {a.receipt.pageUrl}
                </span>
              </div>
            ) : null}
            {a.submittedAt ? (
              <div className="row" role="group" aria-label="What came of it">
                <span className="small muted">What came of it?</span>
                {(['interview', 'rejected', 'no-reply'] as const).map((o) => (
                  <button key={o} type="button" className={`chip ${a.outcome === o ? '' : 'plain'}`} aria-pressed={a.outcome === o} disabled={busyId === a.id} onClick={() => act(a.id, 'outcome', { outcome: o })}>
                    {OUTCOME_NAME[o]}
                  </button>
                ))}
              </div>
            ) : null}
            {a.status === 'uncertain' ? <p className="small note">The form was sent but no confirmation was seen. Check with the employer before applying again: it is never retried automatically.</p> : null}
            <div className="row">
              {a.sentDocuments ? (
                <Link className="btn" href={`/interview/?application=${encodeURIComponent(a.id)}`}>
                  Prepare for interview
                </Link>
              ) : null}
              <Link className={`btn ${a.status === 'submitted' ? '' : 'primary'}`} href={`/review/?job=${encodeURIComponent(a.jobId)}`}>
                {a.status === 'draft' ? 'Review and approve' : a.status === 'confirmed' ? 'Next steps' : 'View'}
              </Link>
            </div>
          </div>
        ))}
      </div>
      {apps?.some((a) => a.status === 'closed') ? (
        <button type="button" className="link" onClick={() => setShowClosed((v) => !v)} data-testid="toggle-closed">
          {showClosed ? 'Hide closed applications' : `Show closed applications (${apps.filter((a) => a.status === 'closed').length})`}
        </button>
      ) : null}
      <p className="small muted">OpennJob does not read your e-mail: record interviews and rejections on each sent application.</p>
    </>
  );
}
