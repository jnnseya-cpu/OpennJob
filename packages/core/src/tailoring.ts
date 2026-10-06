import type { LlmPort } from './llm';
import type { MatchResult } from './matching';
import { FRENCH_FALLBACK_OPENING } from './statement';
import type { Job, Passport } from './types';
import { escapeRegExp, splitSentences } from './text';

/**
 * Truthful tailoring (TAI-2) and the trace check (TAI-3).
 *
 * The tailored CV is the person's CV rewritten for the advert by the LLM (tailorCvForJob):
 * reworded, reordered and focused on what the advert asks for, but checked at fact level
 * (traceRewrittenCv): every figure and name in it must be in the CV, the passport, the
 * selected languages or the person's name. If the rewrite fails that check, or there is no
 * LLM, it is the person's own CV with its lines reordered (tailorCv): lines that evidence
 * the job's criteria come first, then every other line in its original order, with no line
 * added, changed or dropped. Either way it cannot contain an employer, date,
 * qualification, figure or skill that the CV does not.
 *
 * The trace check runs on every document before it may be sent. A document fails when a
 * sentence cannot be traced to the source: the CV, the credential passport, the languages
 * the person selected, and (for names only) the job's title, employer and location.
 */

/** Why an application is held for the person (status needs_you). */
export const HOLD_REASONS = {
  'trace-check': 'A sentence in the documents could not be traced to your CV. Read it and correct it.',
  'llm-ceiling': 'The daily AI spending limit was reached, so this was drafted without AI. Read it before use.',
  'daily-limit': "Today's application limit was reached. It goes out tomorrow.",
} as const;
export type HoldReason = keyof typeof HOLD_REASONS;

export function tailorCv(cvText: string, match: Pick<MatchResult, 'hits'>): string {
  const lines = cvText.split(/\r?\n/).filter((l) => l.trim() !== '');
  const ordered = [...match.hits.filter((h) => h.criterion.essential), ...match.hits.filter((h) => !h.criterion.essential)];
  const first: number[] = [];
  for (const hit of ordered) {
    if (!hit.matched || !hit.evidence) continue;
    const evidence = hit.evidence;
    const i = lines.findIndex((l, n) => !first.includes(n) && l.includes(evidence));
    if (i !== -1) first.push(i);
  }
  const rest = lines.map((_, n) => n).filter((n) => !first.includes(n));
  return [...first, ...rest].map((n) => lines[n] as string).join('\n');
}

/** The usual CV section headings, in any case. Only these are exempt from the fact check. */
const CV_HEADINGS =
  /^(professional |personal |career )?(profile|summary|statement)$|^(key |core )?(skills|capabilities|competencies|strengths)( and (capabilities|competencies|qualifications))?$|^(professional |work |employment |relevant |career )?(experience|history)$|^(education|qualifications|education and (training|qualifications)|training|certifications?|accreditations?|professional (memberships?|development|qualifications)|memberships?|languages|interests|references|achievements|key achievements|selected projects|projects|contact( details)?)$/i;

export const CV_TAILOR_SYSTEM_PROMPT =
  'You rewrite a candidate\'s CV for one job advert. You use ONLY facts already in the CV: never add an employer, job title, ' +
  'date, number, qualification, certificate, membership, skill, tool or achievement that the CV does not state. You may: ' +
  'rewrite the profile summary towards this role; reorder sections, roles and bullets so the most relevant come first; ' +
  'reword bullets using the advert\'s terms where the CV shows the same thing; shorten or drop lines that do not help. ' +
  'Keep every employer name, job title and date exactly as written. Plain text only: the candidate\'s name on the first ' +
  'line, contact line second, section headings in CAPITALS on their own line, bullets starting with "- ". Reply with the CV ' +
  'only, no commentary.';

export interface TailoredCv {
  text: string;
  /** 'llm': rewritten for the advert and traced to the CV. 'reorder': the CV's own lines, most relevant first. */
  source: 'llm' | 'reorder';
}

/**
 * The CV rewritten for one advert by the LLM, then traced to the source (TAI-3). If the rewrite
 * states anything the CV, passport or selected languages do not (a new figure, employer,
 * qualification...), or the call fails, the person's own lines reordered are used instead
 * (tailorCv), so nothing untrue is ever sent and the application is not held for it.
 */
export async function tailorCvForJob(
  input: { cvText: string; job: Pick<Job, 'title' | 'employer' | 'location' | 'description'>; match: Pick<MatchResult, 'hits'> },
  llm: LlmPort | undefined,
  sources: TraceSources,
): Promise<TailoredCv> {
  const reorder: TailoredCv = { text: tailorCv(input.cvText, input.match), source: 'reorder' };
  if (!llm) return reorder;
  const met = input.match.hits.filter((h) => h.matched).map((h) => h.criterion.label);
  const prompt = [
    `JOB: ${input.job.title} at ${input.job.employer} (${input.job.location})`,
    met.length ? `REQUIREMENTS THE CV MEETS (lead with these): ${met.join('; ')}` : '',
    'ADVERT:',
    input.job.description.slice(0, 6000),
    '',
    'CV:',
    input.cvText.slice(0, 12000),
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const text = (await llm.complete({ system: CV_TAILOR_SYSTEM_PROMPT, prompt, maxTokens: 2500 })).text.trim();
    if (text.length < 200) return reorder;
    return traceRewrittenCv(text, sources).length === 0 ? { text, source: 'llm' } : reorder;
  } catch {
    return reorder;
  }
}

/**
 * The trace check for a CV rewritten for an advert: the same standard as a statement. Wording may
 * change; facts may not. Every figure (dates, years, amounts, percentages, counts) and every name
 * (employers, qualifications, places, tools, memberships) in each line must appear in the CV, the
 * passport, the selected languages or the person's own name. Unlike a statement, the advert's
 * employer and title are NOT accepted: a CV must not appear to claim work there.
 */
export function traceRewrittenCv(text: string, sources: TraceSources): TraceFailure[] {
  const factCorpus = `${sources.cvText}\n${passportText(sources.passport)}`;
  const nameCorpus = [factCorpus, ...(sources.languages ?? []), sources.personName ?? ''].join('\n');
  const failures: TraceFailure[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // A section heading ("KEY SKILLS", "Professional Experience") states no fact.
    if (CV_HEADINGS.test(line.trim().replace(/[:\s]+$/, ''))) continue;
    const { figures, names } = factsIn(line);
    const unsupported = [...figures.filter((f) => !contains(factCorpus, f)), ...names.filter((n) => !contains(nameCorpus, n))];
    if (unsupported.length > 0) failures.push({ document: 'tailoredCv', text: line.trim(), unsupported });
  }
  return failures;
}

export interface TraceSources {
  cvText: string;
  passport?: Passport;
  /** The languages the person selected. An empty list is evidence of no language (T-03). */
  languages?: readonly string[];
  job?: Pick<Job, 'title' | 'employer' | 'location'>;
  /** The person's own name, which a letter may sign with. */
  personName?: string;
}

export interface TraceFailure {
  document: 'statement' | 'tailoredCv';
  text: string;
  /** The facts in the text that the source does not contain. Empty when the line itself is new. */
  unsupported: string[];
}

/** Sentences the drafters write themselves. They state nothing about the person. */
const BOILERPLATE = new Set(splitSentences(FRENCH_FALLBACK_OPENING).map((s) => normalise(s)));

/** Capitalised words a letter uses without stating a fact. */
const PLAIN_WORDS = new Set(
  ['i', "i'm", 'i’m', "i've", 'i’ve', "i'd", 'i’d', "i'll", 'i’ll', 'dear', 'sir', 'madam', 'hiring', 'manager', 'yours', 'sincerely', 'faithfully', 'kind', 'regards', 'madame', 'monsieur', 'je', 'veuillez', 'cordialement', 'mesdames', 'messieurs'],
);

const NUMBER_WORDS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'hundreds', 'thousand', 'thousands', 'dozen', 'dozens', 'million'];

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function passportText(p: Passport | undefined): string {
  if (!p) return '';
  return [
    p.nmcPin ?? '',
    ...Object.values(p.credentials ?? {}),
    p.dbs?.certificateNumber ?? '',
    p.dbs?.issueDate ?? '',
    ...p.training.flatMap((t) => [t.name, t.completedOn ?? '', t.expiresOn ?? '']),
  ].join('\n');
}

function contains(corpus: string, token: string): boolean {
  const body = escapeRegExp(token.toLowerCase()).replace(/\\?\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu').test(corpus);
}

/** The facts a sentence asserts that can be checked: figures, dates, money, names, acronyms, counted words. */
export function factsIn(sentence: string): { figures: string[]; names: string[] } {
  const figures = new Set<string>();
  const names = new Set<string>();
  for (const m of sentence.matchAll(/(?<![\p{L}\d])\d+(?:[.,:/-]\d+)*(?![\p{L}])/gu)) figures.add(m[0].replace(/[.,:/-]+$/, ''));
  for (const w of NUMBER_WORDS) if (contains(sentence, w)) figures.add(w);
  const words = [...sentence.matchAll(/[\p{Lu}][\p{L}\p{N}'’&-]*/gu)];
  for (const m of words) {
    const word = m[0].replace(/['’-]+$/, '');
    const atStart = sentence.slice(0, m.index).replace(/[\s"'“‘(\-–—•*]+/g, '') === '';
    const acronym = /^[\p{Lu}\p{N}&]{2,}$/u.test(word) && /\p{Lu}.*\p{Lu}/u.test(word);
    if (PLAIN_WORDS.has(word.toLowerCase())) continue;
    if (atStart && !acronym) continue;
    names.add(word);
  }
  return { figures: [...figures], names: [...names] };
}

/**
 * Checks the documents against the source. Returns one failure per untraceable sentence
 * (statement) or line (tailored CV). An empty list means everything traced.
 */
export function traceCheck(documents: { statement?: string; tailoredCv?: string }, sources: TraceSources): TraceFailure[] {
  const failures: TraceFailure[] = [];
  const cv = sources.cvText;
  const passport = passportText(sources.passport);
  const verbatim = normalise(`${cv}\n${passport}`);
  const factCorpus = `${cv}\n${passport}`;
  // The job's own title, employer and location may be named (and numbered: "Band 5"). Its description may not:
  // "5 years' experience required" in an advert is not evidence that the person has it.
  const jobIdentity = [sources.job?.title ?? '', sources.job?.employer ?? '', sources.job?.location ?? ''].join('\n');
  const nameCorpus = [cv, passport, ...(sources.languages ?? []), jobIdentity, sources.personName ?? ''].join('\n');

  if (documents.tailoredCv !== undefined) {
    // Every line must be a line of the CV, used no more often than the CV has it.
    const available = new Map<string, number>();
    for (const line of cv.split(/\r?\n/)) {
      const k = normalise(line);
      if (k) available.set(k, (available.get(k) ?? 0) + 1);
    }
    for (const line of documents.tailoredCv.split(/\r?\n/)) {
      const k = normalise(line);
      if (!k) continue;
      const left = available.get(k) ?? 0;
      if (left > 0) {
        available.set(k, left - 1);
        continue;
      }
      const { figures, names } = factsIn(line);
      failures.push({ document: 'tailoredCv', text: line.trim(), unsupported: [...figures.filter((f) => !contains(factCorpus, f)), ...names.filter((n) => !contains(factCorpus, n))] });
    }
  }

  if (documents.statement !== undefined) {
    for (const sentence of splitSentences(documents.statement)) {
      const k = normalise(sentence);
      if (BOILERPLATE.has(k) || verbatim.includes(k)) continue;
      const { figures, names } = factsIn(sentence);
      const unsupported = [...figures.filter((f) => !contains(`${factCorpus}\n${jobIdentity}`, f)), ...names.filter((n) => !contains(nameCorpus, n))];
      if (unsupported.length > 0) failures.push({ document: 'statement', text: sentence, unsupported });
    }
  }
  return failures;
}

/** How a failure is shown to the person and stored with the application (encrypted). */
export function describeTraceFailure(f: TraceFailure): string {
  const where = f.document === 'statement' ? 'Statement' : 'Tailored CV';
  return f.unsupported.length > 0
    ? `${where}: "${f.text}" mentions ${f.unsupported.join(', ')}, which your CV does not contain.`
    : `${where}: "${f.text}" is not a line of your CV.`;
}
