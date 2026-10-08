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
| `reliefweb` | `POST https://api.reliefweb.int/v2/jobs?appname={appname}` | UN OCHA's humanitarian and development jobs API; free; needs an appname ReliefWeb approved (since 1 November 2025) | not checked | Covers countries the commercial APIs do not, such as DR Congo. Its documentation says anyone can use the API, and that jobs are contributed by partners and may be copyrighted. Check the terms (attribution, caching, use of job content) before turning it on with `OPENNJOB_RELIEFWEB_APPNAME`. Asked for the countries in its ISO3 table. |
| `jooble` | `POST https://{cc}.jooble.org/api/{key}` (USA: `jooble.org`) | Aggregator API; each country's site issues its own free key, valid only for that country | not checked | About 60 countries, including the UAE and the Gulf. Asked only for the countries that have a key in `JOOBLE_API_KEYS` (`AE:key,SA:key`; request each at `{cc}.jooble.org/api/about`). Adverts are snippets; the full text is on the linked site. Check the API terms (attribution, linking, caching) before turning it on. **Live check 2026-10-07 (owner's server, `deploy/check-sources.sh`):** `ae.jooble.org` with a UAE key returned 30 jobs for "electrical engineer", parsed into titles and employers, so the endpoint and response shape work for the UAE. |
| `career-sites` | Workday: `POST https://{tenant}.wdN.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`; SuccessFactors career sites: `GET https://{host}/services/rss/job/?keywords=(...)` | Employers' own careers sites, searched directly | not checked | Off until the operator lists a site in `OPENNJOB_CAREER_SITES` with `deploy/add-career-site.sh`, which asks that the site's terms of use were read and allow it (rule 5) and records the date. Each listed site is its own terms check: record it here with the date and who read them. Every job comes with the employer's own application page, which the queue applies on when that system is switched on. Response shapes from memory, **not verified against a live site**. |
| `sample` | none (in the code) | Fictional demonstration jobs | not needed | Fictional data only. Off unless `OPENNJOB_DEMO_JOBS=true`. |

Response shapes for the seven live adapters were written from public documentation. On 2026-10-07 the owner's server
(`deploy/check-sources.sh`, "electrical engineer") got and parsed real results from Adzuna (50 jobs
each in GB, FR, BE, CA), Reed (100 in GB) and Jooble (30 in AE). Greenhouse, Lever, Ashby and
ReliefWeb are **not verified against the live APIs** (DIS-2). Nothing in this repository calls them in tests.

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
