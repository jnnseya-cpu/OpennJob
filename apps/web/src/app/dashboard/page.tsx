'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { BarList, Histogram, StageBar, StatTiles, scoreBins } from '../../components/Charts';
import { ApiError, api, errorText } from '../../lib/api';
import { PACKS } from '../../lib/core';
import type { Application, MatchView, PassportView } from '../../lib/types';

interface Inbox {
  unread: number;
  items: { id: string; subject: string; severity: string; createdAt: string; readAt?: string }[];
}

export default function DashboardPage() {
  const { threshold, pack } = useApp();
  const [matches, setMatches] = useState<MatchView[]>();
  const [apps, setApps] = useState<Application[]>([]);
  const [passport, setPassport] = useState<PassportView>();
  const [inbox, setInbox] = useState<Inbox>({ unread: 0, items: [] });
  const [noProfile, setNoProfile] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const query = pack === 'all' ? '' : `&pack=${pack}`;
        const [m, a, n] = await Promise.all([
          api<MatchView[]>(`/jobs/matches?min=0${query}`).catch((err) => {
            if (err instanceof ApiError && err.status === 404) return undefined;
            throw err;
          }),
          api<Application[]>('/applications'),
          api<Inbox>('/notifications'),
        ]);
        const p = await api<PassportView>('/passport').catch(() => undefined);
        if (!live) return;
        setNoProfile(m === undefined);
        setMatches(m ?? []);
        setApps(a);
        setInbox(n);
        setPassport(p);
      } catch (err) {
        if (live) setError(errorText(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [pack]);

  if (error) return <div className="note bad" role="alert">{error}</div>;
  if (!matches) return <p className="muted small">Loading your dashboard…</p>;

  const strong = matches.filter((m) => m.eligible && m.score >= threshold).length;
  const waiting = apps.filter((a) => a.status === 'draft').length;
  const submitted = apps.filter((a) => a.status === 'submitted').length;
  const byPack = PACKS.map((p) => ({ label: p.name, value: matches.filter((m) => m.job.pack === p.id).length })).filter((r) => r.value > 0);
  const training = (passport?.training ?? [])
    .filter((t) => t.daysRemaining !== undefined)
    .sort((x, y) => (x.daysRemaining ?? 0) - (y.daysRemaining ?? 0))
    .map((t) => ({ label: t.name, value: Math.max(0, t.daysRemaining ?? 0), detail: (t.daysRemaining ?? 0) < 0 ? `${t.name}: expired` : `${t.name}: ${t.daysRemaining} days left` }));

  return (
    <>
      <h2>Your dashboard</h2>
      {noProfile ? (
        <div className="note">
          Add your CV first: matches are scored against it. <Link href="/profile/">Go to Profile</Link>
        </div>
      ) : null}
      <StatTiles
        items={[
          { label: `Matches at ${threshold}% or more`, value: strong, testId: 'stat-strong' },
          { label: 'Waiting for your review', value: waiting, testId: 'stat-waiting' },
          { label: 'Recorded as submitted', value: submitted, testId: 'stat-submitted' },
          { label: 'Unread notifications', value: inbox.unread, testId: 'stat-unread' },
        ]}
      />
      <div className="cols">
        <section className="card">
          <Histogram title="How your matches score" bins={scoreBins(matches.map((m) => m.score))} threshold={threshold} thresholdLabel={`Agent prepares at ${threshold}%`} />
        </section>
        <section className="card">
          <StageBar
            title="Application pipeline"
            stages={[
              { label: 'Waiting for you', count: waiting },
              { label: 'Approved, not sent', count: apps.filter((a) => a.status === 'confirmed').length },
              { label: 'Submitted', count: submitted },
            ]}
          />
        </section>
        <section className="card">
          <BarList title="Matches by industry pack" rows={byPack} valueHead="Jobs" empty="No matches yet. Open Matches and look for jobs." />
        </section>
        <section className="card">
          <BarList title="Training: days until expiry" rows={training} unit=" d" valueHead="Days left" empty="No training with an expiry date in your passport." />
        </section>
        <section className="card span">
          <div className="row">
            <h3 className="grow">Latest notifications</h3>
            <Link href="/notifications/" className="small">
              All notifications
            </Link>
          </div>
          {inbox.items.length ? (
            <ul className="plain small">
              {inbox.items.slice(0, 5).map((n) => (
                <li key={n.id}>
                  {n.readAt ? '' : '● '}
                  {n.subject}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">Nothing yet.</p>
          )}
        </section>
      </div>
    </>
  );
}
