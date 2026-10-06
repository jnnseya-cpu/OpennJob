/*
 * UNVERIFIED RESPONSE SHAPE.
 * The endpoint and response shape below were written from memory of Ashby's public
 * job-board posting API docs and have NOT been checked against the live API. The tests
 * use a fixture in that remembered shape, never a live call. Verify against the live
 * API before relying on this adapter.
 *
 * GET https://api.ashbyhq.com/posting-api/job-board/{name}
 * -> { jobs: [{ id, title, location, employmentType, jobUrl, applyUrl,
 *               descriptionPlain, publishedAt }] }
 */
import { arr, getJson, normaliseJob, obj, present, str, tidy, toIso } from './common';
import type { FetchLike, JobSourceAdapter } from './common';

export interface AshbyOptions {
  boardName: string;
  /** Ashby does not return the employer name on this endpoint; supply it. Defaults to the board name. */
  employer?: string;
  fetch: FetchLike;
}

export function createAshbySource(options: AshbyOptions): JobSourceAdapter {
  const label = `ashby:${options.boardName}`;
  return {
    name: 'ashby',
    label,
    async fetchJobs() {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(options.boardName)}`;
      const body = obj(await getJson(options.fetch, label, url));
      return arr(body.jobs)
        .map((item) => {
          const j = obj(item);
          const postedAt = toIso(j.publishedAt);
          return normaliseJob({
            source: 'ashby',
            externalId: str(j.id),
            title: str(j.title),
            employer: options.employer ?? options.boardName,
            location: str(j.location),
            url: str(j.jobUrl),
            applyUrl: str(j.applyUrl) || str(j.jobUrl),
            description: tidy(str(j.descriptionPlain)),
            employmentType: str(j.employmentType),
            ...(postedAt ? { postedAt } : {}),
          });
        })
        .filter(present);
    },
  };
}
