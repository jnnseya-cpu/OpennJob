/*
 * UNVERIFIED RESPONSE SHAPE.
 * The endpoint and response shape below were written from memory of Lever's public
 * Postings API docs and have NOT been checked against the live API. The tests use a
 * fixture in that remembered shape, never a live call. Verify against the live API
 * before relying on this adapter.
 *
 * GET https://api.lever.co/v0/postings/{company}?mode=json
 * -> [{ id, text, hostedUrl, applyUrl, categories: { location, team, commitment },
 *       descriptionPlain, createdAt }]
 */
import { arr, getJson, normaliseJob, obj, present, str, tidy, toIso } from './common';
import type { FetchLike, JobSourceAdapter } from './common';

export interface LeverOptions {
  company: string;
  /** Lever does not return the employer name on this endpoint; supply it. Defaults to the company slug. */
  employer?: string;
  fetch: FetchLike;
}

export function createLeverSource(options: LeverOptions): JobSourceAdapter {
  const label = `lever:${options.company}`;
  return {
    name: 'lever',
    label,
    async fetchJobs() {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(options.company)}?mode=json`;
      return arr(await getJson(options.fetch, label, url))
        .map((item) => {
          const j = obj(item);
          const categories = obj(j.categories);
          const postedAt = toIso(j.createdAt);
          return normaliseJob({
            source: 'lever',
            externalId: str(j.id),
            title: str(j.text),
            employer: options.employer ?? options.company,
            location: str(categories.location),
            url: str(j.hostedUrl),
            applyUrl: str(j.applyUrl) || str(j.hostedUrl),
            description: tidy(str(j.descriptionPlain)),
            employmentType: str(categories.commitment),
            ...(postedAt ? { postedAt } : {}),
          });
        })
        .filter(present);
    },
  };
}
