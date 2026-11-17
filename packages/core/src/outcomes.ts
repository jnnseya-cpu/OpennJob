/**
 * What actually happened to sent applications, and what the agent learns from it. The person
 * records each outcome (interview, rejected, no reply) on the Tracker; OpennJob does not read e-mail.
 *
 * - interviewRates: interviews out of recorded outcomes, by match-score band.
 * - automaticBar: the score an application needs before the agent prepares or sends it on its
 *   own. With a target interview rate set, and enough recorded outcomes, the bar rises to the
 *   lowest band whose applications reached the target; it never goes below the platform's
 *   threshold or the person's own minimum. Without enough outcomes it stays where it is.
 * - automaticOrder: which ready application goes first: employers that have interviewed the
 *   person, then companies they asked to search for, then the higher score.
 */
import type { Application } from './types';

export interface ScoreBand {
  label: string;
  from: number;
  /** Exclusive; 101 for the top band. */
  to: number;
}

export const SCORE_BANDS: readonly ScoreBand[] = [
  { label: 'Below 80%', from: 0, to: 80 },
  { label: '80–84%', from: 80, to: 85 },
  { label: '85–89%', from: 85, to: 90 },
  { label: '90–94%', from: 90, to: 95 },
  { label: '95–100%', from: 95, to: 101 },
];

/** Outcomes needed in all before the bar moves. */
export const OUTCOMES_BEFORE_LEARNING = 20;
/** Outcomes needed at or above a bar before its rate is trusted. */
export const OUTCOMES_PER_BAR = 5;

export interface BandRate {
  label: string;
  from: number;
  to: number;
  /** Applications sent in this band. */
  sent: number;
  /** Of those, with an outcome recorded. */
  outcomes: number;
  interviews: number;
  /** Interviews out of recorded outcomes, 0-100; undefined with no outcome yet. */
  rate?: number;
}

const wasSent = (a: Application) => a.submittedAt !== undefined || a.status === 'submitted' || a.status === 'interview' || a.outcome !== undefined;
const percent = (part: number, whole: number) => Math.round((100 * part) / whole);

export function interviewRates(applications: readonly Application[]): BandRate[] {
  const sent = applications.filter(wasSent);
  return SCORE_BANDS.map((b) => {
    const mine = sent.filter((a) => a.score >= b.from && a.score < b.to);
    const decided = mine.filter((a) => a.outcome !== undefined);
    const interviews = decided.filter((a) => a.outcome === 'interview').length;
    return { ...b, sent: mine.length, outcomes: decided.length, interviews, ...(decided.length ? { rate: percent(interviews, decided.length) } : {}) };
  });
}

export type BarReason = 'no-target' | 'learning' | 'meets-target' | 'below-target';

export interface AutomaticBar {
  /** The score an application needs for the agent to prepare or send it on its own. */
  bar: number;
  /** The platform's threshold or the person's minimum, whichever is higher. */
  base: number;
  target?: number;
  reason: BarReason;
  /** Recorded outcomes so far, and how many are needed before the bar moves. */
  outcomes: number;
  needed: number;
  /** The interview rate of recorded outcomes at or above the bar, when known. */
  rateAtBar?: number;
}

export function automaticBar(applications: readonly Application[], base: number, target: number | undefined): AutomaticBar {
  const decided = applications.filter((a) => wasSent(a) && a.outcome !== undefined);
  const common = { base, outcomes: decided.length, needed: OUTCOMES_BEFORE_LEARNING };
  const rateFrom = (floor: number) => {
    const set = decided.filter((a) => a.score >= floor);
    return set.length >= OUTCOMES_PER_BAR ? percent(set.filter((a) => a.outcome === 'interview').length, set.length) : undefined;
  };
  if (target === undefined) return { bar: base, reason: 'no-target', ...common, ...withRate(rateFrom(base)) };
  if (decided.length < OUTCOMES_BEFORE_LEARNING) return { bar: base, target, reason: 'learning', ...common, ...withRate(rateFrom(base)) };
  const floors = [base, ...SCORE_BANDS.map((b) => b.from).filter((f) => f > base)];
  for (const floor of floors) {
    // A band with no outcome of its own says nothing about itself: start the bar where evidence starts.
    const band = SCORE_BANDS.find((b) => b.from === floor);
    if (floor !== base && band && !decided.some((a) => a.score >= band.from && a.score < band.to)) continue;
    const rate = rateFrom(floor);
    if (rate !== undefined && rate >= target) return { bar: floor, target, reason: 'meets-target', ...common, rateAtBar: rate };
  }
  // No band reached the target yet: send only the closest matches, and keep learning.
  const strictest = Math.max(base, SCORE_BANDS[SCORE_BANDS.length - 1]?.from ?? base);
  return { bar: strictest, target, reason: 'below-target', ...common, ...withRate(rateFrom(strictest)) };
}

const withRate = (rate: number | undefined) => (rate === undefined ? {} : { rateAtBar: rate });

/** The employer's first word, folded: "Moorside Care Ltd" and "Moorside Care Group" are one employer. */
export function employerKey(employer: string): string {
  return (employer.toLowerCase().match(/[\p{L}\p{N}]+/u)?.[0] ?? '').normalize('NFKD');
}

/** Employers that have interviewed the person before. */
export function interviewedEmployers(applications: readonly Application[]): Set<string> {
  return new Set(applications.filter((a) => a.outcome === 'interview' || a.status === 'interview').map((a) => employerKey(a.employer)).filter(Boolean));
}

/**
 * The order the agent sends ready applications in: an employer that has interviewed the person,
 * then a company they asked to search for, then the higher score, then the older draft.
 */
export function automaticOrder(interviewed: Set<string>, isTarget: (a: Application) => boolean) {
  return (x: Application, y: Application): number =>
    Number(interviewed.has(employerKey(y.employer))) - Number(interviewed.has(employerKey(x.employer))) ||
    Number(isTarget(y)) - Number(isTarget(x)) ||
    y.score - x.score ||
    x.createdAt.localeCompare(y.createdAt) ||
    x.id.localeCompare(y.id);
}
