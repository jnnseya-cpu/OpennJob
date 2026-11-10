'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { BarList, Histogram, StageBar, StatTiles, scoreBins } from '../../components/Charts';
import { ApiError, api, errorText } from '../../lib/api';
import { PACKS } from '../../lib/core';
import { SHOW_FROM } from '../../lib/labels';
import type { Application, InterviewRates, MatchView, PassportView, Profile } from '../../lib/types';

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
  const [rates, setRates] = useState<InterviewRates>();
  const [profile, setProfile] = useState<Profile>();
  const [noProfile, setNoProfile] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const query = pack === 'all' ? '' : `&pack=${pack}`;
        const [m, a, n] = await Promise.all([
          api<MatchView[]>(`/jobs/matches?min=${SHOW_FROM}${query}`).catch((err) => {
            if (err instanceof ApiError && err.status === 404) return undefined;
            throw err;
          }),
          api<Application[]>('/applications'),
          api<Inbox>('/notifications'),
        ]);
        const p = await api<PassportView>('/passport').catch(() => undefined);
        const r = await api<InterviewRates>('/agent/interview-rates').catch(() => undefined);
        const prof = await api<Profile>('/profile').catch(() => undefined);
        if (!live) return;
        setNoProfile(m === undefined);
        setMatches(m ?? []);
        setApps(a);
        setInbox(n);
        setPassport(p);
        setRates(r);
        setProfile(prof);
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
  // Outcomes recorded against sent applications (APP-level), and those still awaiting a reply.
  const interviews = apps.filter((a) => a.outcome === 'interview').length;
  const rejected = apps.filter((a) => a.outcome === 'rejected').length;
  const noReply = apps.filter((a) => a.outcome === 'no-reply').length;
  const awaiting = apps.filter((a) => a.status === 'submitted' && a.outcome === undefined).length;
  const decided = interviews + rejected + noReply;
  // Interview rate by the score band the application was sent at (needs recorded outcomes to mean anything).
  const bandRates = (rates?.bands ?? [])
    .filter((b) => b.outcomes > 0)
    .map((b) => ({ label: b.label, value: b.rate ?? 0, detail: `${b.label}: ${b.interviews} of ${b.outcomes} led to an interview` }));
  const byPack = PACKS.map((p) => ({ label: p.name, value: matches.filter((m) => m.job.pack === p.id).length })).filter((r) => r.value > 0);
  const training = (passport?.training ?? [])
    .filter((t) => t.daysRemaining !== undefined)
    .sort((x, y) => (x.daysRemaining ?? 0) - (y.daysRemaining ?? 0))
    .map((t) => ({ label: t.name, value: Math.max(0, t.daysRemaining ?? 0), detail: (t.daysRemaining ?? 0) < 0 ? `${t.name}: expired` : `${t.name}: ${t.daysRemaining} days left` }));

  return (
    <>
      <h2>Your dashboard</h2>
      {profile && (profile.cover || profile.avatar) ? (
        <div className="dash-hero" data-testid="dash-hero">
          {profile.cover ? <img className="profile-cover" src={profile.cover} alt="" /> : <div className="profile-cover placeholder" aria-hidden="true" />}
          {profile.avatar ? <img className="profile-avatar" src={profile.avatar} alt="Your profile photo" /> : <div className="profile-avatar placeholder" aria-hidden="true">{(profile.firstName[0] ?? '').toUpperCase()}{(profile.lastName[0] ?? '').toUpperCase()}</div>}
        </div>
      ) : null}
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
          { label: 'Interviews so far', value: interviews, testId: 'stat-interviews' },
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
        <section className="card" data-testid="outcomes">
          <StageBar
            title="Outcomes so far"
            stages={[
              { label: 'Awaiting reply', count: awaiting },
              { label: 'Interview', count: interviews },
              { label: 'Rejected', count: rejected },
              { label: 'No reply', count: noReply },
            ]}
          />
          {decided === 0 ? <p className="small muted">Record each reply in the Tracker (Interview / Rejected / No reply). The agent learns which score bands win interviews for you and sends more at those.</p> : null}
        </section>
        <section className="card">
          <BarList title="Interview rate by match score" rows={bandRates} unit="%" max={100} valueHead="Rate" empty="No recorded outcomes yet. Mark replies in the Tracker to see which scores convert for you." />
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
