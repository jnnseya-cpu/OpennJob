import type { Job } from '../types';

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Same normalised title + employer + location = the same vacancy. */
export function dedupeKey(job: Pick<Job, 'title' | 'employer' | 'location'>): string {
  return `${norm(job.title)}|${norm(job.employer)}|${norm(job.location)}`;
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
