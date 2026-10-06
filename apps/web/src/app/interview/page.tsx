'use client';

import { useEffect, useState } from 'react';
import { useApp } from '../../components/AppShell';
import { BarList } from '../../components/Charts';
import { api, errorText } from '../../lib/api';
import { PACKS, getPack } from '../../lib/core';
import type { InterviewFeedback, PackId, PackQuestion } from '../../lib/types';

const PART_NAMES = [
  ['situation', 'Situation'],
  ['task', 'Task'],
  ['action', 'Action'],
  ['result', 'Result'],
] as const;

export default function InterviewPage() {
  const { pack: chosen } = useApp();
  const [pack, setPack] = useState<PackId>(chosen === 'all' ? 'con' : chosen);
  const [questions, setQuestions] = useState<PackQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<InterviewFeedback>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (chosen !== 'all') setPack(chosen);
  }, [chosen]);

  useEffect(() => {
    setError('');
    setIndex(0);
    setAnswer('');
    setResult(undefined);
    api<PackQuestion[]>(`/interview/questions?pack=${pack}`)
      .then(setQuestions)
      .catch((err) => setError(errorText(err)));
  }, [pack]);

  const question = questions.length ? questions[index % questions.length] : undefined;

  async function feedback() {
    if (!question) return;
    if (answer.trim().split(/\s+/).length < 5) {
      setError('Write your answer first, a few sentences at least.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setResult(await api<InterviewFeedback>('/interview/feedback', { method: 'POST', body: { questionId: question.id, answer } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Interview practice</h2>
      <div className="card">
        <label className="label" htmlFor="ivpack">
          Practising for
        </label>
        <select id="ivpack" value={pack} onChange={(e) => setPack(e.target.value as PackId)}>
          {PACKS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {question ? (
        <div className="card">
          <span className="label">
            Question {(index % questions.length) + 1} of {questions.length} · {getPack(pack)?.name}
          </span>
          <h3>{question.text}</h3>
          <div className="row">
            <button
              type="button"
              className="link"
              onClick={() => {
                setIndex((i) => i + 1);
                setAnswer('');
                setResult(undefined);
              }}
            >
              Next question
            </button>
          </div>
          <textarea
            aria-label="Your answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer as you would say it. Situation, what you had to do, what you did, how it ended."
          />
          <div className="row">
            <button type="button" className="btn primary" onClick={feedback} disabled={busy}>
              {busy ? 'Checking…' : 'Get feedback'}
            </button>
          </div>
          {error ? <div className="note bad" role="alert">{error}</div> : null}
          {result ? (
            <div className="stack" aria-label="Feedback">
              <span className="label">{result.feedback.source === 'llm' ? 'Feedback from an AI model' : 'Built-in check (no AI)'}</span>
              <BarList title={`STAR score: ${result.feedback.total}/20`} rows={PART_NAMES.map(([k, name]) => ({ label: name, value: result.feedback.scores[k], detail: `${name}: ${result.feedback.scores[k]} out of 5` }))} max={5} unit="/5" valueHead="Score" />
              <p className="small num">Total {result.feedback.total}/20</p>
              {result.feedback.strengths.length ? (
                <>
                  <b className="small">What worked</b>
                  <ul className="plain small">{result.feedback.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
                </>
              ) : null}
              {result.feedback.improvements.length ? (
                <>
                  <b className="small">Do next</b>
                  <ul className="plain small">{result.feedback.improvements.map((s) => <li key={s}>{s}</li>)}</ul>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : error ? (
        <div className="note bad" role="alert">{error}</div>
      ) : (
        <p className="muted small">Loading questions…</p>
      )}
      <p className="small muted">Answers are checked against the STAR structure. Practice is typed only; voice practice is not built.</p>
    </>
  );
}
