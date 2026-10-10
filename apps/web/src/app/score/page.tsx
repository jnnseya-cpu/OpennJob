'use client';

import Link from 'next/link';
import { useState } from 'react';
import { atsReadiness, keywordMatch } from '../../lib/core';
import type { AtsReadiness } from '../../lib/core';

/**
 * Public, sign-in-free CV check (competitive brief, October 2026). It compares the CV and the advert
 * entirely in the browser — nothing is sent to the server or stored, and no AI is called, so it is
 * free to run at any scale. Because it has no AI it can only compare word stems (a forgiving keyword
 * match, not synonym understanding), so it is a rough estimate: the accurate, AI-read score is on the
 * signed-in Review screen.
 */
export default function ScorePage() {
  const [cv, setCv] = useState('');
  const [title, setTitle] = useState('');
  const [advert, setAdvert] = useState('');
  const [result, setResult] = useState<{ match: number; ats: AtsReadiness } | undefined>();

  function run() {
    const km = keywordMatch(advert, title, cv);
    setResult({ match: km.percent, ats: atsReadiness(km.hits, cv) });
  }

  const ready = cv.trim().length > 50 && advert.trim().length > 50;
  const bandWord = (b: AtsReadiness['band']) => (b === 'strong' ? 'Strong' : b === 'fair' ? 'Fair' : 'Needs work');

  return (
    <>
      <h2>Check your CV against a job — free</h2>
      <p className="small muted">
        Paste your CV and a job advert for a quick keyword match and an applicant-tracking-system (ATS) readiness check.
        It runs in your browser only — nothing is sent anywhere or saved, and it uses no AI.
      </p>
      <p className="small muted">
        This is a <b>rough keyword estimate</b>: it compares words, so close wording may not line up.{' '}
        <Link href="/register/">Create a free account</Link> for the accurate, AI-read score and a tailored CV for each job.
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
              <span className="label grow">Keyword match (rough)</span>
              <span className="num">{result.match}%</span>
            </div>
            <div className="bar" aria-hidden="true"><span style={{ width: `${result.match}%` }} /></div>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="label grow">ATS readiness</span>
              <span className="num">{result.ats.score}/100 · {bandWord(result.ats.band)}</span>
            </div>
            <div className="bar" aria-hidden="true"><span style={{ width: `${result.ats.score}%` }} /></div>
            <p className="small muted">{result.ats.coverage.matched} of {result.ats.coverage.total} of the advert’s keywords appear in your CV (by word, not meaning — the AI check understands synonyms).</p>
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
            <p className="small">Want the accurate, AI-read score — plus matching jobs, a trace-checked CV and statement for each, and apply-by-e-mail where it can?</p>
            <Link className="btn primary" href="/register/">Create a free account</Link>
          </section>
        </>
      ) : null}
    </>
  );
}
