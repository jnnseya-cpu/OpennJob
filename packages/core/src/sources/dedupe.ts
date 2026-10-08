import { isEmployerLink } from '../adapters';
import { recruiterEmailIn } from '../email-apply';
import type { Job } from '../types';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const firstWord = (s: string) => norm(s).replace(/^the /, '').split(' ')[0] ?? '';

/**
 * Same normalised title + employer (+ country) = the same vacancy. The employer is compared on its
 * first word, because sources spell it differently: "Clarion" and "Clarion Housing", "Ernest Gordon
 * Recruitment" and "... Limited", "Hays Specialist Recruitment" and "Hays Construction and Property".
 * The town is not compared: Reed and Adzuna write it differently ("London", "Central London",
 * "City of London"), which let one vacancy through twice. One application per title per employer
 * per country is also what an employer expects from one person.
 */
export function dedupeKey(job: Pick<Job, 'title' | 'employer' | 'location'> & Partial<Pick<Job, 'country'>>): string {
  return `${norm(job.title)}|${firstWord(job.employer)}|${(job.country ?? '').toUpperCase()}`;
}

/**
 * Can an application to this copy of a vacancy go out on its own: the advert names a recruiter's
 * address, or the link is the employer's own page (not a job board's or an aggregator's)?
 */
export const hasWayOut = (job: Pick<Job, 'description' | 'url' | 'applyUrl'>): boolean =>
  recruiterEmailIn(job.description) !== undefined || isEmployerLink(job.applyUrl ?? job.url);

/**
 * Keeps one copy of each vacancy: the first (so list your preferred sources first), unless a
 * later copy has a way out the first lacks (a recruiter's address, the employer's own link). The
 * kept copy stays where the first one was.
 */
export function dedupeJobs(jobs: readonly Job[]): { jobs: Job[]; duplicates: Job[] } {
  const at = new Map<string, number>();
  const kept: Job[] = [];
  const duplicates: Job[] = [];
  for (const job of jobs) {
    const key = dedupeKey(job);
    const i = at.get(key);
    const first = i === undefined ? undefined : kept[i];
    if (i === undefined || !first) {
      at.set(key, kept.length);
      kept.push(job);
    } else if (!hasWayOut(first) && hasWayOut(job)) {
      duplicates.push(first);
      kept[i] = job;
    } else duplicates.push(job);
  }
  return { jobs: kept, duplicates };
}

export interface CollectResult {
  jobs: Job[];
  fetched: number;
  duplicates: number;
  errors: { source: string; message: string }[];
}

/** Runs every adapter, tolerating individual failures, then de-duplicates across sources. */
/** How many sources are asked at the same time. */
export const COLLECT_CONCURRENCY = 4;

export async function collectJobs(
  sources: ReadonlyArray<{ label: string; fetchJobs(): Promise<Job[]> }>,
  concurrency = COLLECT_CONCURRENCY,
): Promise<CollectResult> {
  // A few sources at a time; results are kept in the sources' order, so the same copy of a
  // duplicate wins whatever answers first.
  const results: Array<{ jobs: Job[] } | { error: { source: string; message: string } }> = new Array(sources.length);
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const i = next++;
      const source = sources[i];
      if (!source) continue;
      try {
        results[i] = { jobs: await source.fetchJobs() };
      } catch (err) {
        results[i] = { error: { source: source.label, message: err instanceof Error ? err.message : String(err) } };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  const all: Job[] = [];
  const errors: CollectResult['errors'] = [];
  for (const r of results) {
    if (!r) continue;
    if ('jobs' in r) all.push(...r.jobs);
    else errors.push(r.error);
  }
  const { jobs, duplicates } = dedupeJobs(all);
  return { jobs, fetched: all.length, duplicates: duplicates.length, errors };
}
