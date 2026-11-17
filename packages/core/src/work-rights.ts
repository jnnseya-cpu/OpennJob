import { countryName, foldPlace, normaliseCountryCode } from './geo';
import type { Passport, WorkRightsRecord } from './types';

/**
 * Right to work and visa sponsorship, answered from the person's own record for a country.
 *
 * Owner decision OD-5 (6 October 2026): these two questions, and only these two, may be answered
 * on an application form without the person confirming them on that form, when the person has a
 * record for the job's country that
 *   - they confirmed themselves (confirmedAt),
 *   - answers both questions yes or no,
 *   - names the document they hold as evidence (basis), and
 *   - has not expired (documentExpires, when the document has an expiry date).
 * OpennJob does not see or check the document: the person states which one they hold. Every other
 * right-to-work question (nationality, passport or share code, National Insurance number,
 * immigration status in detail) and every other declaration is still answered by the person.
 */

/** The documents a record can rest on. The person picks the one they hold. */
export const WORK_RIGHTS_BASES = [
  'British or Irish passport',
  'Passport of this country',
  'Settled or pre-settled status',
  'Indefinite leave to remain',
  'Visa, residence permit or eVisa',
  'Birth or naturalisation certificate with National Insurance number',
  'Other official document',
] as const;
export type WorkRightsBasis = (typeof WORK_RIGHTS_BASES)[number];

/** Why a record cannot be used, or undefined when it can. `today` is YYYY-MM-DD. */
export function workRightsProblem(record: WorkRightsRecord, today: string): string | undefined {
  if (!record.confirmedAt) return 'not confirmed by you';
  if (typeof record.rightToWork !== 'boolean' || typeof record.requiresSponsorship !== 'boolean') return 'both questions need a yes or no';
  if (!record.basis || !record.basis.trim()) return 'no document named';
  if (record.documentExpires && record.documentExpires < today) return `the document expired on ${record.documentExpires}`;
  return undefined;
}

/** The usable record for a country, or undefined (no record, or one that cannot be used). */
export function workRightsFor(passport: Pick<Passport, 'workRights'> | undefined, country: string | undefined, today: string): WorkRightsRecord | undefined {
  const code = normaliseCountryCode(country);
  if (!code) return undefined;
  const record = (passport?.workRights ?? []).find((r) => normaliseCountryCode(r.country) === code);
  return record && !workRightsProblem(record, today) ? record : undefined;
}

/** Ways a question names the place it is about. "this country" and similar name nothing. */
const COUNTRY_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/\b(the )?(uk|u k|united kingdom|great britain|britain|england|scotland|wales|northern ireland)\b/, 'GB'],
  [/\b(republic of )?ireland\b|\birish\b/, 'IE'],
  [/\b(the )?(usa|u s a|united states)( of america)?\b/, 'US'], // not "us": "tell us" is not a country
  [/\bcanada\b/, 'CA'],
  [/\baustralia\b/, 'AU'],
  [/\bnew zealand\b/, 'NZ'],
  [/\b(the )?(uae|united arab emirates)\b|\bdubai\b|\babu dhabi\b/, 'AE'],
  [/\bsaudi( arabia)?\b|\bksa\b/, 'SA'],
  [/\bqatar\b/, 'QA'],
  [/\bfrance\b/, 'FR'],
  [/\bbelgi(um|que)\b/, 'BE'],
  [/\bgermany\b|\ballemagne\b/, 'DE'],
  [/\bnetherlands\b|\bholland\b/, 'NL'],
  [/\bspain\b|\bespagne\b/, 'ES'],
  [/\bswitzerland\b|\bsuisse\b/, 'CH'],
  [/\bnorway\b/, 'NO'],
  [/\bsweden\b/, 'SE'],
  [/\bdenmark\b/, 'DK'],
  [/\b(the )?eu\b|\beuropean union\b|\beea\b/, 'EU'],
];

/**
 * The country a right-to-work question names, if it names one: "Do you have the right to work in
 * the UK?" -> 'GB'. 'EU' for the EU or EEA, which no single record answers. undefined when it
 * names none ("Are you eligible to work in this country?"), in which case the job's country is meant.
 */
export function countryNamedIn(questionText: string): string | undefined {
  const text = foldPlace(questionText).replace(/[^a-z ]+/g, ' ');
  for (const [pattern, code] of COUNTRY_WORDS) if (pattern.test(text)) return code;
  return undefined;
}

/** "United Kingdom (British or Irish passport)": how a record is described to the person. */
export function describeWorkRights(record: WorkRightsRecord): string {
  return `${countryName(record.country) ?? record.country} (${record.basis})`;
}
