# Job sources and their terms (DIS-5)

Every job source OpennJob can read is listed here with the state of its terms-of-use check.
`packages/core/test/sources-register.test.ts` fails if an adapter in `packages/core/src/sources/`
is missing from this table, so a new source cannot be added without a row.

**No source has had its terms checked.** The terms pages could not be reached from the
build environment, and nobody has read them for this project. Until a row says
`checked` with a date and a name, treat that source as **not cleared for production use**.
Turning a source on (its environment variable) is the operator's decision and the
operator's responsibility.

| Adapter | Endpoint read | What it is | Terms check | Notes |
|---|---|---|---|---|
| `greenhouse` | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | An employer's public job board API | not checked | Check the Job Board API terms, and the employer's own wishes for its board. |
| `lever` | `GET https://api.lever.co/v0/postings/{company}?mode=json` | An employer's public postings API | not checked | Check Lever's postings API terms. |
| `ashby` | `GET https://api.ashbyhq.com/posting-api/job-board/{name}` | An employer's public job board API | not checked | Check Ashby's public job posting API terms. |
| `adzuna` | `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}` | Aggregator API with a free key | not checked | The API terms set attribution, caching and permitted use. The web app shows "Jobs by Adzuna" (linked) on matches and the review screen, and applies through Adzuna's own redirect link. Needs `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`. |
| `reed` | `GET https://www.reed.co.uk/api/1.0/search` | Aggregator API with a free key | not checked | Check the Reed API terms (attribution, caching). Needs `REED_API_KEY`. |
| `sample` | none (in the code) | Fictional demonstration jobs | not needed | Fictional data only. Off unless `OPENNJOB_DEMO_JOBS=true`. |

Response shapes for the five live adapters were written from public documentation and are
**not verified against the live APIs** (DIS-2). Nothing in this repository calls them in tests.

## What the job-search APIs are asked

Adzuna and Reed are asked per person: the job titles found in that person's CV
(`packages/core/src/search.ts`), in the cities and countries they chose on Profile, or their
home country when they chose none. Reed is asked for the UK only, Adzuna for the countries it
operates in. Only a job title and a place are sent; no name, contact detail or CV text. The same
search needed by several people is asked once, and every refresh is capped
(`OPENNJOB_SEARCH_MAX_QUERIES_PER_USER`, `OPENNJOB_SEARCH_MAX_QUERIES_PER_REFRESH`) to stay within
the APIs' quotas. There is no server-wide keyword or location setting.

## Sites OpennJob does not read

No scraper or automated access exists, or may be added without a terms check or a
partnership, for NHS Jobs, Trac, LinkedIn, Indeed or any other site (CLAUDE.md rule 5).

## How to record a check

Change the row's "Terms check" to `checked YYYY-MM-DD by NAME`, and add to the notes the
link read, the conditions found (attribution, caching limits, rate limits, permitted use)
and what the code does to meet each one. A source whose terms forbid this use is removed.
