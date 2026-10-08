'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { Histogram, scoreBins } from '../../components/Charts';
import { ApiError, TIMED_OUT, api, errorText } from '../../lib/api';
import { REGION_IDS, countryName, getPack } from '../../lib/core';
import type { Region } from '../../lib/core';
import { ADZUNA_URL, STATUS_LABEL, isAdzuna, needsLabel, placeOf, regionLabel } from '../../lib/labels';
import type { AgentRunResult, Application, MatchView, Profile, SearchPlanView } from '../../lib/types';

/** How long "Look for jobs now" waits for the server before saying the search carries on there. */
const REFRESH_TIMEOUT_MS = 40_000;
const STILL_SEARCHING =
  'Still searching: this many searches take a few minutes, and the search carries on without this page. Come back in 5 minutes and press Run agent; the new jobs will be in your matches.';

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
  const [plan, setPlan] = useState<SearchPlanView>();
  const [found, setFound] = useState('');

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
      setPlan(await api<SearchPlanView>('/jobs/search-plan').catch(() => undefined));
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
      const r = await api<{ running: true } | { running: false; new: number; stored: number; searches: number; errors: unknown[] }>('/jobs/refresh', { method: 'POST', timeoutMs: REFRESH_TIMEOUT_MS });
      if (r.running) {
        setFound(STILL_SEARCHING);
        return;
      }
      setFound(`${r.searches} search${r.searches === 1 ? '' : 'es'} made: ${r.new} new job${r.new === 1 ? '' : 's'} found.${r.errors.length ? ` ${r.errors.length} source${r.errors.length === 1 ? '' : 's'} did not answer.` : ''}`);
      await load();
    } catch (err) {
      // The server answers within 25 seconds; if it does not, the search still runs there.
      if (err instanceof ApiError && err.status === TIMED_OUT) setFound(STILL_SEARCHING);
      else setError(errorText(err));
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
      {plan && plan.searchSources.length ? (
        <section className="card" data-testid="search-plan">
          {plan.titles.length ? (
            <p className="small">
              Searching {plan.searchSources.map((s) => s.label.charAt(0).toUpperCase() + s.label.slice(1)).join(' and ')} for{' '}
              <b>{plan.titles.join(', ')}</b> in{' '}
              {plan.places.map((p) => (p.where ? `${p.where} (${countryName(p.country) ?? p.country})` : countryName(p.country) ?? p.country)).join(', ')}.
              <span className="muted"> Taken from your CV and your places on Profile; nobody else sets it.</span>
            </p>
          ) : (
            <p className="small note">
              No job title was found in your CV, so OpennJob cannot search for you yet. Put your current or target job title in the first lines of
              your CV, for example "Site Manager", then save your profile. <Link href="/profile/">Go to Profile</Link>
            </p>
          )}
          {plan.coverage && plan.coverage.length > 1 ? (
            <ul className="plain small" data-testid="coverage">
              {plan.coverage.map((c) => (
                <li key={c.country}>
                  <b>{countryName(c.country) ?? c.country}</b>:{' '}
                  {c.sources.length === 0
                    ? 'no job source covers this country yet, so OpennJob cannot search there. Jobs come only from employers who post them here.'
                    : c.searches === 0
                      ? 'not searched this time: the search limit was used up by the places before it. Remove a city, or ask the operator to raise the limit.'
                      : `${c.searches} search${c.searches === 1 ? '' : 'es'} on ${c.sources.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' and ')}`}
                </li>
              ))}
            </ul>
          ) : null}
          {plan.warnings?.includes('search-types-uk-only') ? (
            <p className="small note" data-testid="warning-search-types">
              Jobs outside the UK are found but hidden: your search types do not include “International”. <Link href="/profile/">Change on Profile</Link>
            </p>
          ) : null}
          {plan.warnings?.includes('french-not-selected') ? (
            <p className="small note" data-testid="warning-french">
              Adverts written in French are hidden: French is not among your languages. <Link href="/profile/">Change on Profile</Link>
            </p>
          ) : null}
          <div className="row">
            <button type="button" className="btn" onClick={refresh} disabled={busy !== '' || !plan.titles.length}>
              {busy === 'refresh' ? 'Looking…' : 'Look for jobs now'}
            </button>
            {found ? <span className="small" role="status">{found}</span> : null}
          </div>
        </section>
      ) : null}
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
      <div className="stack list">
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
              {m.hits.length ? (
                <p className="small reqs" data-testid="match-requirements">
                  {m.hits.some((h) => h.matched) ? (
                    <>
                      <b>Meets:</b> {m.hits.filter((h) => h.matched).map((h) => h.label).join(', ')}
                    </>
                  ) : null}
                  {m.hits.some((h) => h.matched) && m.hits.some((h) => !h.matched) ? ' · ' : null}
                  {m.hits.some((h) => !h.matched) ? (
                    <span className="missing">
                      <b>Missing:</b> {m.hits.filter((h) => !h.matched).map((h) => `${h.label}${h.essential ? ' (essential)' : ''}`).join(', ')}
                    </span>
                  ) : null}
                </p>
              ) : (
                <p className="small muted">The advert lists no requirements OpennJob can read: the score rests on the job title.</p>
              )}
              <div className="row">
                <span className="chip plain">{regionLabel(m.job.region)}</span>
                <span className="chip plain">{m.job.origin === 'employer' ? 'Posted by employer' : isAdzuna(m.job) ? 'Jobs by Adzuna' : 'Found by OpennJob'}</span>
                {m.targetEmployer ? <span className="chip">{m.targetEmployer.how === 'employer' ? m.targetEmployer.name : `Names ${m.targetEmployer.name}`}</span> : null}
                {m.job.language === 'fr' ? <span className="chip plain">Applies in French</span> : null}
                {m.thinEvidence ? <span className="chip plain">Few requirements in the advert: score capped</span> : null}
                {m.otherField ? <span className="chip bad">Not your field: your CV does not mention {m.otherField.missing.join(', ')}</span> : null}
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
      {shown.some((m) => isAdzuna(m.job)) ? (
        <p className="small muted" data-testid="adzuna-credit">
          Jobs by{' '}
          <a href={ADZUNA_URL} target="_blank" rel="noopener noreferrer">
            Adzuna
          </a>
        </p>
      ) : null}
    </>
  );
}
