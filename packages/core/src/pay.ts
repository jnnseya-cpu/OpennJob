import type { Job, ScreeningAnswers } from './types';

/**
 * The person's pay expectation against what a job says it pays (owner's request, 8 October 2026):
 * a job that states its pay is shown and applied for only when its top figure reaches the
 * person's expectation; a job that states no pay is kept. Salaries are compared with the salary
 * expectation and day rates with the day rate. When the person gave only one of the two, the
 * other is worked out at 220 working days a year.
 */

/** Working days a year, to turn a day rate into a salary and back. */
export const WORKING_DAYS = 220;
/** A figure at or under this is a day rate (or an hourly one); above it, a yearly salary. */
const DAILY_MAX = 3_000;
const HOURLY_MAX = 150;
const HOURS_PER_DAY = 7.5;

export interface PayExpectation {
  /** Yearly, in the job's currency. */
  annual?: number;
  daily?: number;
}

export interface JobPay {
  /** The top of the job's range, per year or per day. */
  top: number;
  per: 'year' | 'day';
}

/** "£85,000", "85k", "85,000 - 95,000", "£600 a day": the first amount, as a number. */
export function parseAmount(text: string | undefined): number | undefined {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/i.exec((text ?? '').replace(/\s+/g, ' '));
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(/,/g, '')) * (m[2] ? 1_000 : 1);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The expectation from the person's screening answers (Profile: Salary expectation, Day rate). */
export function payExpectationOf(answers: Pick<ScreeningAnswers, 'salaryExpectation' | 'dayRate'> | undefined): PayExpectation {
  const annual = parseAmount(answers?.salaryExpectation);
  const daily = parseAmount(answers?.dayRate);
  return { ...(annual ? { annual } : {}), ...(daily ? { daily } : {}) };
}

const perOf = (n: number): JobPay => (n <= HOURLY_MAX ? { top: n * HOURS_PER_DAY, per: 'day' } : n <= DAILY_MAX ? { top: n, per: 'day' } : { top: n, per: 'year' });

/**
 * Pay written in an advert: a range ("£50,000 - £65,000", "£500-£550 per day") or one amount
 * next to a pay word ("salary £60k", "£550 per day", "up to £70,000 per annum"). Amounts of
 * millions (project values) are not pay. Undefined when the advert does not say.
 */
export function payInText(text: string): JobPay | undefined {
  const t = text.replace(/\s+/g, ' ');
  const amount = String.raw`£\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?`;
  const value = (digits: string, k: string | undefined) => Number(digits.replace(/,/g, '')) * (k ? 1_000 : 1);
  const range = new RegExp(`${amount}\\s?(?:-|–|to)\\s?${amount}`, 'i').exec(t);
  if (range?.[1] && range[3]) {
    const top = Math.max(value(range[1], range[2]), value(range[3], range[4]));
    if (top > 0 && top < 1_000_000) return perOf(top);
  }
  const single = new RegExp(`(?:salary|up to|paying|pays|rate)[^£.]{0,20}${amount}|${amount}\\s?(?:per annum|p\\.?a\\.?\\b|a year|per year|per day|a day|daily|p/d|per hour|an hour|ph\\b)`, 'i').exec(t);
  const digits = single?.[1] ?? single?.[3];
  const k = single?.[1] ? single?.[2] : single?.[4];
  if (digits) {
    const n = value(digits, k);
    if (n > 0 && n < 1_000_000) return perOf(n);
  }
  return undefined;
}

/** What the job pays: its stated range first, else what its title or advert says. */
export function jobPay(job: Pick<Job, 'salaryMin' | 'salaryMax' | 'title' | 'description'>): JobPay | undefined {
  const top = job.salaryMax ?? job.salaryMin;
  if (top !== undefined && top > 0) return perOf(top);
  return payInText(`${job.title}. ${job.description}`);
}

/** True when the job states no pay, the person gave no expectation, or its top figure reaches it. */
export function payFits(job: Pick<Job, 'salaryMin' | 'salaryMax' | 'title' | 'description'>, expectation: PayExpectation): boolean {
  const pay = jobPay(job);
  if (!pay) return true;
  const wanted = pay.per === 'year' ? expectation.annual ?? (expectation.daily ? expectation.daily * WORKING_DAYS : undefined) : expectation.daily ?? (expectation.annual ? expectation.annual / WORKING_DAYS : undefined);
  return wanted === undefined || pay.top >= wanted;
}
