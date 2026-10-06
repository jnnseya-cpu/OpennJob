import type { Criterion, Job, JobLanguage, JobOrigin, JobSource, PackId } from '../types';
import { extractCriteriaFallback } from '../matching';
import { inferPlace, normaliseCountryCode, regionOf } from '../geo';
import { detectLanguage } from '../languages';
import { classifyPack } from '../packs';

/** Minimal fetch shape so adapters can be driven by fixtures in tests. Global fetch satisfies it. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface JobSourceAdapter {
  readonly name: JobSource;
  /** Human-readable label for logs and error reports, e.g. "greenhouse:exampleboard". */
  readonly label: string;
  fetchJobs(): Promise<Job[]>;
}

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${source}: ${message}`);
    this.name = 'SourceError';
  }
}

export async function getJson(fetchFn: FetchLike, source: string, url: string, headers?: Record<string, string>): Promise<unknown> {
  let res;
  try {
    res = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
  } catch (err) {
    throw new SourceError(source, `request failed (${err instanceof Error ? err.message : 'unknown error'})`);
  }
  if (!res.ok) throw new SourceError(source, `HTTP ${res.status}`, res.status);
  try {
    return await res.json();
  } catch {
    throw new SourceError(source, 'response was not valid JSON');
  }
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Epoch milliseconds or a date string -> ISO string. Returns undefined if unreadable. */
export function toIso(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  if (typeof v === 'string') {
    // Reed uses dd/mm/yyyy
    const uk = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
    if (uk) return new Date(Date.UTC(Number(uk[3]), Number(uk[2]) - 1, Number(uk[1]))).toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', bull: '-', hellip: '...' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** HTML -> plain text, keeping paragraph and list-item breaks as newlines. */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n\s*\n+/g, '\n');
}

/** Greenhouse `content` is HTML that has itself been HTML-escaped: decode, strip tags, decode again. */
export function escapedHtmlToText(escaped: string): string {
  return tidy(decodeEntities(stripTags(decodeEntities(escaped))));
}

export function tidy(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface RawJob {
  source: JobSource;
  externalId: string;
  title: string;
  employer: string;
  location: string;
  url: string;
  applyUrl?: string;
  description: string;
  salaryMin?: number;
  salaryMax?: number;
  employmentType?: string;
  postedAt?: string;
  /** Criteria supplied with the job (demo data, or an employer's own posting). When absent they are extracted from the description. */
  criteria?: Criterion[];
  /** ISO 3166-1 alpha-2. When absent it is inferred from `location` where possible. */
  country?: string;
  city?: string;
  /** When absent it is guessed from the wording (detectLanguage). */
  language?: JobLanguage;
  /** When absent it is classified from the wording (classifyPack). */
  pack?: PackId;
  /** When absent it is detected from the wording ('pin' or 'sc'). */
  requiredCredential?: string;
  /** Defaults to 'discovered'. */
  origin?: JobOrigin;
}

/**
 * Builds the single normalised Job. Criteria start from the deterministic extractor so a
 * job is always scoreable; the API may later replace them with LLM-extracted criteria.
 * Country, city, region, language and pack are filled in here for every source, so a
 * discovered job and an employer-posted job have exactly the same shape.
 * Returns undefined for rows without an id or a title.
 */
export function normaliseJob(raw: RawJob): Job | undefined {
  if (!raw.externalId || !raw.title) return undefined;
  const extracted = extractCriteriaFallback(raw.description, raw.title);
  const job: Job = {
    id: `${raw.source}:${raw.externalId}`,
    source: raw.source,
    externalId: raw.externalId,
    title: raw.title,
    employer: raw.employer || 'Unknown employer',
    location: raw.location || 'Not stated',
    url: raw.url,
    description: raw.description,
    criteria: raw.criteria && raw.criteria.length > 0 ? raw.criteria : extracted.criteria,
    criteriaSource: raw.criteria && raw.criteria.length > 0 ? 'provided' : 'fallback',
    requiresRegistration: extracted.requiresRegistration,
  };
  const requiredCredential = raw.requiredCredential?.trim() || extracted.requiredCredential;
  if (requiredCredential) {
    job.requiredCredential = requiredCredential;
    if (requiredCredential === 'pin') job.requiresRegistration = true;
  }
  const inferred = inferPlace(raw.location);
  const country = normaliseCountryCode(raw.country) ?? inferred.country;
  const city = raw.city?.trim() || inferred.city;
  if (country) {
    job.country = country;
    const region = regionOf(country);
    if (region) job.region = region;
  }
  if (city) job.city = city;
  job.language = raw.language ?? detectLanguage(`${raw.title}\n${raw.description}`);
  const pack = raw.pack ?? classifyPack({ title: raw.title, description: raw.description, ...(country ? { country } : {}), language: job.language });
  if (pack) job.pack = pack;
  job.origin = raw.origin ?? 'discovered';
  if (raw.applyUrl) job.applyUrl = raw.applyUrl;
  if (raw.salaryMin !== undefined) job.salaryMin = raw.salaryMin;
  if (raw.salaryMax !== undefined) job.salaryMax = raw.salaryMax;
  if (raw.employmentType) job.employmentType = raw.employmentType;
  if (raw.postedAt) job.postedAt = raw.postedAt;
  return job;
}

export const present = <T>(v: T | undefined): v is T => v !== undefined;
