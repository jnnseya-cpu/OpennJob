'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { Histogram, scoreBins } from '../../components/Charts';
import { ApiError, api, errorText } from '../../lib/api';
import { REGION_IDS, getPack } from '../../lib/core';
import type { Region } from '../../lib/core';
import { STATUS_LABEL, needsLabel, placeOf, regionLabel } from '../../lib/labels';
import type { AgentRunResult, Application, MatchView, Profile } from '../../lib/types';

export default function MatchesPage() {
  const router = useRouter();
  const { pack, mode, threshold, setThreshold, setAgentMessage, refreshWaiting } = useApp();
  const [matches, setMatches] = useState<MatchView[]>();
  const [apps, setApps] = useState<Application[]>([]);
  const [noProfile, setNoProfile] = useState(false);
  const [hasPrefs, setHasPrefs] = useState(false);
  const [region, setRegion] = useState<Region | 'all'>('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'refresh' | 'agent'>('');

  const load = useCallback(async () => {
    setError('');
    try {
      const profile = await api<Profile>('/profile');
      const p = profile.preferences;
      setHasPrefs(Boolean(p && (p.languages.length || p.countries.length || p.cities.length)));
      const query = pack === 'all' ? '' : `&pack=${pack}`;
      const [list, applications] = await Promise.all([api<MatchView[]>(`/jobs/matches?min=0${query}`), api<Application[]>('/applications')]);
      setMatches(list);
      setApps(applications);
      setNoProfile(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNoProfile(true);
      else setError(errorText(err));
    }
  }, [pack]);

  useEffect(() => {
    void load();
  }, [load]);

  const regions = useMemo(() => REGION_IDS.filter((r) => matches?.some((m) => m.job.region === r)), [matches]);
  useEffect(() => {
    if (region !== 'all' && !regions.includes(region)) setRegion('all');
  }, [region, regions]);

  async function refresh() {
    setBusy('refresh');
    try {
      await api('/jobs/refresh', { method: 'POST' });
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function runAgent() {
    setBusy('agent');
    setError('');
    try {
      const r = await api<AgentRunResult>('/agent/run', { method: 'POST', body: { mode } });
      setThreshold(r.threshold);
      const left = r.skipped.belowThreshold + r.skipped.ineligible;
      setAgentMessage(
        `${r.prepared.length} application${r.prepared.length === 1 ? '' : 's'} prepared at ${r.threshold}% or more and waiting for you. ` +
          `${left} match${left === 1 ? ' was' : 'es were'} left alone (under ${r.threshold}%, or a credential is missing). ` +
          'Nothing has been sent to any employer: each application waits for your review.',
      );
      refreshWaiting();
      router.push('/tracker/');
    } catch (err) {
      setError(errorText(err));
      setBusy('');
    }
  }

  if (noProfile) {
    return (
      <>
        <h2>Matches</h2>
        <div className="empty">
          Add your CV first. Matches are scored against it. <Link href="/profile/">Go to Profile</Link>
        </div>
      </>
    );
  }

  const latestApp = (jobId: string) => apps.find((a) => a.jobId === jobId);
  const shown = (matches ?? []).filter((m) => region === 'all' || m.job.region === region);
  const anySample = matches?.some((m) => m.job.source === 'sample');

  return (
    <>
      {anySample ? <div className="note">Sample jobs. Every employer and vacancy marked “(example)” is invented. Nothing is sent to anyone.</div> : null}
      <p className="small muted">OpennJob finds these on careers pages, agency sites and job boards. Employers can also post directly, but nothing depends on it.</p>
      <div className="row">
        <h2 className="grow">Matches</h2>
        <button className="btn primary" type="button" onClick={runAgent} disabled={busy !== '' || !matches?.length}>
          {busy === 'agent' ? 'Running…' : 'Run agent'}
        </button>
      </div>
      <p className="small muted">
        The agent prepares a draft for every match at {threshold}% or more that fits your preferences and credentials. It does not send
        anything.
      </p>
      {regions.length ? (
        <div className="row" role="group" aria-label="Region">
          {(['all', ...regions] as (Region | 'all')[]).map((r) => (
            <button key={r} type="button" className={`chip ${region === r ? '' : 'plain'}`} aria-pressed={region === r} onClick={() => setRegion(r)}>
              {r === 'all' ? 'All regions' : regionLabel(r)}
            </button>
          ))}
        </div>
      ) : null}
      {hasPrefs ? (
        <p className="small muted">
          Your language, country and city choices narrow this list. <Link href="/profile/">Change</Link>
        </p>
      ) : null}
      {error ? <div className="note bad" role="alert">{error}</div> : null}
      {shown.length > 1 ? (
        <section className="card">
          <Histogram title="Score spread in this view" bins={scoreBins(shown.map((m) => m.score))} threshold={threshold} thresholdLabel={`Agent prepares at ${threshold}%`} />
        </section>
      ) : null}
      {matches === undefined && !error ? <p className="muted small">Loading matches…</p> : null}
      {matches && !matches.length ? (
        <div className="empty stack">
          <p>No jobs {pack === 'all' ? '' : `in ${getPack(pack)?.name ?? 'this pack'} `}fit your choices yet.</p>
          <p className="small">If you have just started, OpennJob may not have looked for jobs yet.</p>
          <button type="button" className="btn" onClick={refresh} disabled={busy !== ''}>
            {busy === 'refresh' ? 'Looking…' : 'Look for jobs now'}
          </button>
        </div>
      ) : null}
      <div className="stack">
        {shown.map((m) => {
          const app = latestApp(m.job.id);
          const gaps = m.unmetEssential.length;
          return (
            <Link key={m.job.id} className="card job" href={`/review/?job=${encodeURIComponent(m.job.id)}`} data-testid="match">
              <div className="row">
                <div className="grow">
                  <h3>{m.job.title}</h3>
                  <p className="muted small">
                    {m.job.employer} · {placeOf(m.job)}
                  </p>
                </div>
                <div className="score">{m.score}%</div>
              </div>
              <div className="bar">
                <span style={{ width: `${m.score}%` }} />
              </div>
              <div className="row">
                <span className="chip plain">{regionLabel(m.job.region)}</span>
                <span className="chip plain">{m.job.origin === 'employer' ? 'Posted by employer' : 'Found by OpennJob'}</span>
                {m.job.language === 'fr' ? <span className="chip plain">Applies in French</span> : null}
                {!m.eligible ? (
                  <span className="chip bad">Needs {needsLabel(m.missingCredential)}</span>
                ) : gaps ? (
                  <span className="chip gap">
                    {gaps} essential gap{gaps > 1 ? 's' : ''}
                  </span>
                ) : (
                  <span className="chip">All essentials met</span>
                )}
                {m.eligible ? m.score >= threshold ? <span className="chip">Agent prepares</span> : <span className="chip plain">Under {threshold}%, you decide</span> : null}
                {app ? <span className="chip">{STATUS_LABEL[app.status]}</span> : null}
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
