import { describe, expect, it } from 'vitest';
import { FakeLlm, QUESTION_BANK, buildStarPrompt, findQuestion, parseStarReply, questionsFor, scoreAnswer, scoreStarHeuristic } from '../src';

const STRONG = [
  'Last year, while I was working a night shift on an acute medical ward, a patient who had been admitted with pneumonia became very distressed and confused.',
  'I was responsible for six patients that night and my role was to keep him safe while making sure the others were not neglected.',
  'I immediately checked his observations and found his NEWS2 score had risen to 7.',
  'I escalated to the nurse in charge and called the on-call doctor using SBAR.',
  'I then stayed with him, reassured him and explained what was happening while a colleague covered my other patients.',
  'I documented everything in his care record and informed his daughter by phone.',
  'As a result he was reviewed within 15 minutes, started on oxygen and antibiotics, and he recovered and was discharged 5 days later.',
  'I learned to trust early warning signs and I now check on confused patients more often at night.',
].join(' ');

describe('question bank', () => {
  it('has values-based and clinical-scenario questions for each healthcare role', () => {
    for (const role of ['nurse', 'hca', 'support-worker'] as const) {
      expect(questionsFor(role, 'values').length).toBeGreaterThanOrEqual(3);
      expect(questionsFor(role, 'clinical').length).toBeGreaterThanOrEqual(3);
    }
  });
  it('has unique ids and complete entries', () => {
    expect(new Set(QUESTION_BANK.map((q) => q.id)).size).toBe(QUESTION_BANK.length);
    for (const q of QUESTION_BANK) {
      expect(q.text.length).toBeGreaterThan(20);
      expect(q.lookFor.length).toBeGreaterThan(0);
      expect(q.roles.length).toBeGreaterThan(0);
    }
    expect(findQuestion('val-compassion')?.category).toBe('values');
    expect(findQuestion('nope')).toBeUndefined();
  });
  it('keeps nurse-only questions away from other roles', () => {
    expect(questionsFor('support-worker').some((q) => q.id === 'clin-medication-error')).toBe(false);
    expect(questionsFor('nurse').some((q) => q.id === 'clin-medication-error')).toBe(true);
  });
});

describe('STAR prompt', () => {
  it('names all four parts, the JSON shape, the question and the answer', () => {
    const p = buildStarPrompt('Tell me about a time...', 'My answer.', ['escalation']);
    for (const s of ['Situation', 'Task', 'Action', 'Result', '"situation"', '"improvements"', 'Tell me about a time...', 'My answer.', 'escalation']) {
      expect(p).toContain(s);
    }
  });
});

describe('parseStarReply', () => {
  it('parses, clamps and totals', () => {
    expect(parseStarReply('Here you go: {"situation":4,"task":3.6,"action":9,"result":-2,"strengths":["Clear"],"improvements":["a","b","c","d"]}')).toEqual({
      scores: { situation: 4, task: 4, action: 5, result: 0 },
      total: 13,
      strengths: ['Clear'],
      improvements: ['a', 'b', 'c'],
      source: 'llm',
    });
  });
  it('rejects replies with missing or non-numeric scores', () => {
    expect(parseStarReply('{"situation":4,"task":3,"action":2}')).toBeUndefined();
    expect(parseStarReply('{"situation":"high","task":3,"action":2,"result":1}')).toBeUndefined();
    expect(parseStarReply('no json')).toBeUndefined();
  });
});

describe('heuristic scorer', () => {
  it('scores a full STAR answer highly on every part', () => {
    const f = scoreStarHeuristic(STRONG);
    expect(f.source).toBe('heuristic');
    expect(f.scores.situation).toBeGreaterThanOrEqual(4);
    expect(f.scores.task).toBeGreaterThanOrEqual(3);
    expect(f.scores.action).toBe(5);
    expect(f.scores.result).toBeGreaterThanOrEqual(4);
    expect(f.total).toBe(f.scores.situation + f.scores.task + f.scores.action + f.scores.result);
    expect(f.total).toBeGreaterThanOrEqual(16);
  });
  it('scores an empty answer zero', () => {
    const f = scoreStarHeuristic('   ');
    expect(f.total).toBe(0);
    expect(f.improvements[0]).toMatch(/very short/);
  });
  it('caps a very short answer and tells the user why', () => {
    const f = scoreStarHeuristic('I helped a patient and as a result they recovered.');
    expect(Math.max(...Object.values(f.scores))).toBeLessThanOrEqual(2);
    expect(f.improvements[0]).toMatch(/very short/);
  });
  it('flags a missing result', () => {
    const noResult = STRONG.split(' As a result')[0] as string;
    const f = scoreStarHeuristic(noResult);
    expect(f.scores.result).toBeLessThan(scoreStarHeuristic(STRONG).scores.result);
    expect(f.scores.action).toBe(5);
  });
  it('scores a "we"-only answer low on action', () => {
    const we = 'On the ward last year there was a patient who was very upset about their discharge. We talked to them and we sorted out the transport and we rang the family and we made sure everything was ready and the team was great and everyone pulled together all day long until it was done.';
    expect(scoreStarHeuristic(we).scores.action).toBeLessThanOrEqual(2);
  });
  it('is deterministic and always within range', () => {
    for (const a of [STRONG, '', 'x', 'I '.repeat(500)]) {
      const one = scoreStarHeuristic(a);
      expect(one).toEqual(scoreStarHeuristic(a));
      for (const v of Object.values(one.scores)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(5);
      }
      expect(one.improvements.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('scoreAnswer', () => {
  const input = { question: 'Tell me about a time you escalated a concern.', answer: STRONG };
  it('uses the heuristic when no LLM is configured', async () => {
    expect((await scoreAnswer(input)).source).toBe('heuristic');
  });
  it('uses the LLM score when the reply parses', async () => {
    const llm = new FakeLlm(() => '{"situation":5,"task":4,"action":5,"result":4,"strengths":["Specific"],"improvements":["Shorter"]}');
    const f = await scoreAnswer(input, llm);
    expect(f).toMatchObject({ source: 'llm', total: 18, strengths: ['Specific'] });
    expect(llm.calls[0]?.prompt).toContain(STRONG);
  });
  it('falls back to the heuristic when the LLM reply is unusable or the call fails', async () => {
    expect((await scoreAnswer(input, new FakeLlm(() => 'Great answer!'))).source).toBe('heuristic');
    expect((await scoreAnswer(input, { complete: async () => { throw new Error('x'); } })).source).toBe('heuristic');
  });
});
