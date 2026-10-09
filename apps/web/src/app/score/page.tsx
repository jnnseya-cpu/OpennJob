'use client';

import Link from 'next/link';
import { useState } from 'react';
import { atsReadiness, extractCriteriaFallback, matchJob } from '../../lib/core';
import type { AtsReadiness } from '../../lib/core';

/**
 * Public, sign-in-free CV check (competitive brief, October 2026): paste a CV and a job advert and
 * see the match and ATS-readiness. It runs entirely in the browser — nothing is sent to the server
 * or stored — using the same scoring the app uses. A top-of-funnel tool, honest by construction.
 */
export default function ScorePage() {
  const [cv, setCv] = useState('');
  const [title, setTitle] = useState('');
  const [advert, setAdvert] = useState('');
  const [result, setResult] = useState<{ match: number; ats: AtsReadiness } | undefined>();

  function run() {
    const { criteria } = extractCriteriaFallback(advert, title);
    const m = matchJob({ criteria, requiresRegistration: false, criteriaSource: 'fallback', title }, cv, undefined);
    const hits = m.hits.map((h) => ({ label: h.criterion.label, essential: h.criterion.essential, matched: h.matched }));
    setResult({ match: m.score, ats: atsReadiness(hits, cv) });
  }

  const ready = cv.trim().length > 50 && advert.trim().length > 50;

  return (
    <>
      <h2>Check your CV against a job — free</h2>
      <p className="small muted">
        Paste your CV and a job advert. You will see how well they match and how ready the CV is for an applicant-tracking
        system (ATS). It runs in your browser only: nothing is sent anywhere or saved.
      </p>

      <section className="card">
        <label className="field">
          <span>Your CV (paste the text)</span>
          <textarea rows={8} value={cv} onChange={(e) => setCv(e.target.value)} placeholder="Paste your CV here" />
        </label>
        <label className="field">
          <span>Job title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Staff Nurse" />
        </label>
        <label className="field">
          <span>The job advert (paste the whole text)</span>
          <textarea rows={8} value={advert} onChange={(e) => setAdvert(e.target.value)} placeholder="Paste the advert here" />
        </label>
        <div className="row">
          <button type="button" className="btn primary" disabled={!ready} onClick={run}>
            Check my CV
          </button>
          {!ready ? <span className="small muted">Paste a CV and an advert to check.</span> : null}
        </div>
      </section>

      {result ? (
        <>
          <section className="card" aria-label="Result">
            <div className="row">
              <span className="label grow">Match</span>
              <span className="num">{result.match}%</span>
            </div>
            <div className="bar" aria-hidden="true"><span style={{ width: `${result.match}%` }} /></div>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="label grow">ATS readiness</span>
              <span className="num">{result.ats.score}/100 · {result.ats.band === 'strong' ? 'Strong' : result.ats.band === 'fair' ? 'Fair' : 'Needs work'}</span>
            </div>
            <div className="bar" aria-hidden="true"><span style={{ width: `${result.ats.score}%` }} /></div>
            <p className="small muted">{result.ats.coverage.matched} of {result.ats.coverage.total} of the advert’s requirements are evidenced in your CV.</p>
            <dl className="kv">
              {result.ats.checks.map((c) => (
                <div key={c.id} className="crit">
                  <span className={`chip ${c.ok ? '' : 'gap'}`}>{c.ok ? 'OK' : 'Fix'}</span>
                  <span>{c.label}{c.detail ? <span className="muted small"> — {c.detail}</span> : null}</span>
                </div>
              ))}
            </dl>
            <span className="label">How to improve it</span>
            <ul className="small">
              {result.ats.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>
          <section className="card">
            <p className="small">Want OpennJob to find matching jobs, write a trace-checked CV and statement for each, and apply by e-mail where it can?</p>
            <Link className="btn primary" href="/register/">Create a free account</Link>
          </section>
        </>
      ) : null}
    </>
  );
}
