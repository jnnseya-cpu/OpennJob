/*
 * UNVERIFIED RESPONSE SHAPE.
 * The endpoint and response shape below were written from memory of Greenhouse's public
 * Job Board API docs and have NOT been checked against the live API. The tests use a
 * fixture in that remembered shape, never a live call. Verify against the live API
 * before relying on this adapter.
 *
 * GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 * -> { jobs: [{ id, title, absolute_url, location: { name }, updated_at, content }] }
 *    (content is HTML-escaped HTML)
 */
import { arr, escapedHtmlToText, getJson, normaliseJob, obj, present, str, toIso } from './common';
import type { FetchLike, JobSourceAdapter } from './common';

export interface GreenhouseOptions {
  boardToken: string;
  /** Greenhouse does not return the employer name on this endpoint; supply it. Defaults to the board token. */
  employer?: string;
  fetch: FetchLike;
}

export function createGreenhouseSource(options: GreenhouseOptions): JobSourceAdapter {
  const label = `greenhouse:${options.boardToken}`;
  return {
    name: 'greenhouse',
    label,
    async fetchJobs() {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(options.boardToken)}/jobs?content=true`;
      const body = obj(await getJson(options.fetch, label, url));
      return arr(body.jobs)
        .map((item) => {
          const j = obj(item);
          const postedAt = toIso(j.updated_at);
          return normaliseJob({
            source: 'greenhouse',
            externalId: str(j.id),
            title: str(j.title),
            employer: options.employer ?? options.boardToken,
            location: str(obj(j.location).name),
            url: str(j.absolute_url),
            applyUrl: str(j.absolute_url),
            description: escapedHtmlToText(str(j.content)),
            ...(postedAt ? { postedAt } : {}),
          });
        })
        .filter(present);
    },
  };
}
