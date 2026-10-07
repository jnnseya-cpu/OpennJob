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

/** Keeps the first occurrence of each vacancy (so list your preferred sources first). */
export function dedupeJobs(jobs: readonly Job[]): { jobs: Job[]; duplicates: Job[] } {
  const seen = new Set<string>();
  const kept: Job[] = [];
  const duplicates: Job[] = [];
  for (const job of jobs) {
    const key = dedupeKey(job);
    if (seen.has(key)) duplicates.push(job);
    else {
      seen.add(key);
      kept.push(job);
    }
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
export async function collectJobs(
  sources: ReadonlyArray<{ label: string; fetchJobs(): Promise<Job[]> }>,
): Promise<CollectResult> {
  const all: Job[] = [];
  const errors: CollectResult['errors'] = [];
  for (const source of sources) {
    try {
      all.push(...(await source.fetchJobs()));
    } catch (err) {
      errors.push({ source: source.label, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const { jobs, duplicates } = dedupeJobs(all);
  return { jobs, fetched: all.length, duplicates: duplicates.length, errors };
}
