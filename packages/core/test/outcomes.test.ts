import { describe, expect, it } from 'vitest';
import { OUTCOMES_BEFORE_LEARNING, automaticBar, automaticOrder, employerKey, interviewRates, interviewedEmployers } from '../src';
import type { Application, ApplicationOutcome } from '../src';

/** Fictional sent applications with a score and, optionally, an outcome. */
let n = 0;
function sent(score: number, outcome?: ApplicationOutcome, employer = `Employer ${score} (fictional)`): Application {
  n += 1;
  return {
    id: `app-${n}`,
    userId: 'user-1',
    jobId: `job-${n}`,
    jobTitle: 'Site Manager (fictional)',
    employer,
    applyUrl: 'https://example.org/apply',
    mode: 'auto',
    status: 'submitted',
    statement: '',
    statementSource: 'fallback',
    gaps: [],
    warnings: [],
    score,
    confirmedFields: [],
    createdAt: `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    submittedAt: '2026-10-01T06:00:00.000Z',
    ...(outcome ? { outcome, outcomeAt: '2026-10-05T09:00:00.000Z' } : {}),
  };
}
const many = (count: number, score: number, outcome: ApplicationOutcome) => Array.from({ length: count }, () => sent(score, outcome));

describe('interview rates by match score', () => {
  it('counts interviews out of recorded outcomes in each band; drafts are not counted', () => {
    const apps = [sent(82, 'interview'), sent(83, 'rejected'), sent(84), sent(96, 'interview'), { ...sent(97), status: 'draft' as const, submittedAt: undefined }];
    const bands = interviewRates(apps);
    expect(bands.find((b) => b.label === '80–84%')).toMatchObject({ sent: 3, outcomes: 2, interviews: 1, rate: 50 });
    expect(bands.find((b) => b.label === '95–100%')).toMatchObject({ sent: 1, outcomes: 1, interviews: 1, rate: 100 });
    expect(bands.find((b) => b.label === '90–94%')).toMatchObject({ sent: 0, outcomes: 0 });
    expect(bands.find((b) => b.label === '90–94%')?.rate).toBeUndefined();
  });
});

describe('the automatic bar', () => {
  it('stays at the base with no target, or before enough outcomes are recorded', () => {
    expect(automaticBar(many(30, 82, 'rejected'), 80, undefined)).toMatchObject({ bar: 80, reason: 'no-target' });
    expect(automaticBar(many(OUTCOMES_BEFORE_LEARNING - 1, 82, 'rejected'), 80, 80)).toMatchObject({ bar: 80, reason: 'learning', outcomes: 19, needed: 20 });
  });

  it('rises to the lowest band whose applications reached the target', () => {
    // 80-89: no interviews; 90+: 8 of 10 interviews.
    const apps = [...many(10, 82, 'no-reply'), ...many(5, 87, 'rejected'), ...many(8, 92, 'interview'), ...many(2, 96, 'rejected')];
    expect(automaticBar(apps, 80, 80)).toMatchObject({ bar: 90, reason: 'meets-target', rateAtBar: 80 });
    // A lower target is already met lower down.
    expect(automaticBar(apps, 80, 30)).toMatchObject({ bar: 80, reason: 'meets-target', rateAtBar: 32 });
  });

  it('when no band reaches the target, only the closest matches go out', () => {
    expect(automaticBar([...many(15, 85, 'rejected'), ...many(6, 96, 'rejected')], 80, 80)).toMatchObject({ bar: 95, reason: 'below-target', rateAtBar: 0 });
  });

  it('never goes below the base, and a band needs five outcomes before its rate counts', () => {
    const apps = [...many(20, 82, 'interview'), ...many(4, 97, 'interview')];
    expect(automaticBar(apps, 85, 80)).toMatchObject({ bar: 95, reason: 'below-target' }); // 85+ has only 4 outcomes
    expect(automaticBar(apps, 80, 80).bar).toBe(80);
  });
});

describe('the order applications go out in', () => {
  it('an employer that interviewed the person first, then a company they asked for, then the score', () => {
    const history = [sent(85, 'interview', 'Northgrid Power plc (fictional)')];
    const interviewed = interviewedEmployers(history);
    expect([...interviewed]).toEqual([employerKey('Northgrid Power plc (fictional)')]);
    const ready = [sent(99, undefined, 'Other Co (fictional)'), sent(81, undefined, 'Example Build Ltd (fictional)'), sent(82, undefined, 'Northgrid Power Services (fictional)')];
    const order = automaticOrder(interviewed, (a) => a.employer.startsWith('Example Build'));
    expect([...ready].sort(order).map((a) => a.employer)).toEqual(['Northgrid Power Services (fictional)', 'Example Build Ltd (fictional)', 'Other Co (fictional)']);
  });
});
