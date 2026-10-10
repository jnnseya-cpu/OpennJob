'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorText } from '../lib/api';
import type { DeclarationAnswers } from '../lib/core';
import type { ScreeningAnswers } from '../lib/types';

const TEXT_FIELDS: [keyof ScreeningAnswers, string][] = [
  ['noticePeriod', 'Notice period'],
  ['salaryExpectation', 'Salary expectation'],
  ['dayRate', 'Day rate (contract roles)'],
  ['yearsExperience', 'Years of relevant experience'],
];
/** OD-6 (owner decision, 8 October 2026): declarations answered once, filled on every form. */
const DECLARATIONS: [keyof DeclarationAnswers, string, string][] = [
  ['everConvicted', 'Have you ever had a criminal conviction or caution (spent or unspent)?', 'This answer is given to every question about convictions or cautions.'],
  ['conflictOfInterest', 'Do you have a conflict of interest with the employers you apply to?', 'This answer is given to every conflict-of-interest question.'],
];
const DECLARATION_TICKS: [keyof DeclarationAnswers, string][] = [
  ['certifyAndConsent', 'Tick "I certify the information I have given is true" and the privacy-notice and terms boxes for me. Boxes that claim a fact (a licence, a qualification) are never ticked.'],
  ['equalityPreferNotToSay', 'Answer equality-monitoring questions (gender, ethnicity, disability, age…) "Prefer not to say".'],
];

const YES_NO: [keyof ScreeningAnswers, string][] = [
  ['relocation', 'Willing to relocate'],
  ['travel', 'Willing to travel'],
  ['drivingLicence', 'Full driving licence'],
];

/**
 * SCR-1: ordinary screening answers, stored once and reused by the agent. OD-6: the declarations
 * the person chooses to answer once (convictions, conflict of interest, certify and consent,
 * equality "Prefer not to say"). Free-text declaration questions are still refused by the API.
 */
export function ScreeningForm() {
  const [answers, setAnswers] = useState<ScreeningAnswers>({ custom: {} });
  const [rows, setRows] = useState<{ q: string; a: string }[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ScreeningAnswers>('/screening')
      .then((s) => {
        setAnswers(s);
        setRows(Object.entries(s.custom ?? {}).map(([q, a]) => ({ q, a })));
      })
      .catch(() => undefined);
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(undefined);
    const body: ScreeningAnswers = { custom: Object.fromEntries(rows.filter((r) => r.q.trim() && r.a.trim()).map((r) => [r.q.trim(), r.a.trim()])) };
    for (const [k] of TEXT_FIELDS) {
      const v = answers[k];
      if (typeof v === 'string' && v.trim()) (body as unknown as Record<string, unknown>)[k] = v.trim();
    }
    for (const [k] of YES_NO) {
      const v = answers[k];
      if (typeof v === 'boolean') (body as unknown as Record<string, unknown>)[k] = v;
    }
    const d = answers.declarations ?? {};
    const declarations = Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === 'boolean'));
    if (Object.keys(declarations).length) body.declarations = declarations;
    try {
      setAnswers(await api<ScreeningAnswers>('/screening', { method: 'PUT', body }));
      setMsg({ ok: true, text: 'Answers saved. The agent uses them on forms that ask these questions.' });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={save} aria-label="Standard answers">
      <span className="label">Standard answers</span>
      <p className="small muted">Ordinary questions that application forms ask again and again. Right to work is on the Credential passport; declarations are just below.</p>
      <div className="grid2">
        {TEXT_FIELDS.map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <input type="text" value={(answers[k] as string | undefined) ?? ''} onChange={(e) => setAnswers((s) => ({ ...s, [k]: e.target.value }))} />
            {k === 'salaryExpectation' || k === 'dayRate' ? <span className="small muted">A job that states lower pay is not shown or applied for. One that states no pay still is.</span> : null}
          </label>
        ))}
        {YES_NO.map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <select value={answers[k] === undefined ? '' : answers[k] ? 'yes' : 'no'} onChange={(e) => setAnswers((s) => ({ ...s, [k]: e.target.value === '' ? undefined : e.target.value === 'yes' }))}>
              <option value="">Not answered</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        ))}
      </div>
      <fieldset className="field" aria-label="Declarations OpennJob answers for you">
        <legend><b>Declarations OpennJob answers for you</b></legend>
        <p className="small muted">Answer truthfully: OpennJob gives these answers in your name on every form, so applications can be sent without you. Health, safeguarding and vetting questions are still left for you. Change or clear an answer at any time.</p>
        {DECLARATIONS.map(([k, label, help]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <select value={answers.declarations?.[k] === undefined ? '' : answers.declarations[k] ? 'yes' : 'no'} onChange={(e) => setAnswers((s) => ({ ...s, declarations: { ...s.declarations, [k]: e.target.value === '' ? undefined : e.target.value === 'yes' } }))}>
              <option value="">Not answered (I answer it on each form)</option>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
            <span className="small muted">{help}</span>
          </label>
        ))}
        {DECLARATION_TICKS.map(([k, label]) => (
          <label key={k} className="row small">
            <input type="checkbox" checked={answers.declarations?.[k] === true} onChange={(e) => setAnswers((s) => ({ ...s, declarations: { ...s.declarations, [k]: e.target.checked ? true : undefined } }))} /> {label}
          </label>
        ))}
      </fieldset>
      <span className="small"><b>Other questions you have answered</b></span>
      {rows.map((r, i) => (
        <div key={i} className="grid2">
          <label className="field">
            <span>Question {i + 1}</span>
            <input type="text" value={r.q} onChange={(e) => setRows((list) => list.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} />
          </label>
          <label className="field">
            <span>Your answer</span>
            <input type="text" value={r.a} onChange={(e) => setRows((list) => list.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} />
          </label>
          <button type="button" className="link" onClick={() => setRows((list) => list.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn" onClick={() => setRows((list) => [...list, { q: '', a: '' }])}>
        Add a question
      </button>
      {msg ? <div className={`note ${msg.ok ? 'ok' : 'bad'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div> : null}
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save answers'}
      </button>
    </form>
  );
}
