import type { Job } from './types';
import type { LlmPort } from './llm';
import type { MatchResult } from './matching';
import { keywordInText } from './text';

export const STATEMENT_TARGET_WORDS = 250;

const STATEMENT_RULES = [
  'You draft supporting statements for job applications on behalf of the applicant.',
  'Hard rules:',
  '1. Use only evidence that is present in the CV you are given. Never invent experience, employers, qualifications, registrations, dates or numbers.',
  '2. If the CV has no evidence for a criterion, do not claim it and do not imply it. List it under GAPS instead.',
];

export const STATEMENT_SYSTEM_PROMPT = [
  ...STATEMENT_RULES,
  '3. Write in UK English, first person, plain professional tone. No headings, no bullet points in the statement.',
].join('\n');

/** Used when job.language is 'fr'. The evidence rules are the same; only the language of the output changes. */
export const STATEMENT_SYSTEM_PROMPT_FR = [
  ...STATEMENT_RULES,
  '3. Write the statement in formal French (français soutenu, vouvoiement, first person), as a French "lettre de motivation" would be written. No headings, no bullet points in the statement.',
  '4. The CV may be in English. Translate the evidence faithfully; translation must not add, strengthen or generalise any claim.',
  '5. Keep the marker "GAPS:" exactly as written, in capitals, and list the gaps after it.',
].join('\n');

/** Fixed opening of the no-LLM draft for a French application. It makes no claim about the applicant. */
export const FRENCH_FALLBACK_OPENING =
  'Madame, Monsieur,\nVeuillez trouver ci-dessous les éléments de mon CV qui répondent aux critères du poste.';

export interface StatementInput {
  job: Pick<Job, 'title' | 'employer' | 'criteria'> & Partial<Pick<Job, 'language'>>;
  cvText: string;
  match: MatchResult;
}

export function buildStatementPrompt(input: StatementInput): { system: string; prompt: string } {
  const essential = input.match.hits.filter((h) => h.criterion.essential);
  const desirable = input.match.hits.filter((h) => !h.criterion.essential);
  const french = input.job.language === 'fr';
  const line = (h: (typeof essential)[number], i: number) =>
    `${i + 1}. ${h.criterion.label} - ${
      h.evidence
        ? `CV evidence: "${h.evidence}"`
        : h.statedLanguage
          ? `NOT IN THE CV. The applicant states in their profile that they speak ${h.statedLanguage}. You may say exactly that and nothing more about it (no level, no examples).`
          : 'NO EVIDENCE IN CV (do not claim; list under GAPS)'
    }`;

  const prompt = [
    `Write a supporting statement for the post of ${input.job.title} at ${input.job.employer}.`,
    '',
    'Essential criteria from the person specification. Address each one, in this order:',
    essential.length ? essential.map(line).join('\n') : '(none listed)',
    '',
    'Desirable criteria. Mention only those the CV evidences:',
    desirable.length ? desirable.map(line).join('\n') : '(none listed)',
    '',
    'Instructions:',
    `- About ${STATEMENT_TARGET_WORDS} words.`,
    '- Address each essential criterion in the order given, using only evidence present in the CV below.',
    '- Never invent experience. If something is not in the CV, leave it out of the statement.',
    french
      ? '- Write the statement in formal French (vouvoiement), even if the CV is in English. Translate faithfully; add nothing.'
      : '- UK English spelling.',
    '- After the statement, on a new line write exactly "GAPS:" and then list each criterion the CV does not evidence, one per line, or "none".',
    '',
    'CV:',
    '"""',
    input.cvText,
    '"""',
  ].join('\n');

  return { system: french ? STATEMENT_SYSTEM_PROMPT_FR : STATEMENT_SYSTEM_PROMPT, prompt };
}

export interface StatementDraft {
  statement: string;
  /** Unmet essential criteria. Always computed from the match, never taken on trust from the LLM. */
  gaps: string[];
  source: 'llm' | 'fallback';
  warnings: string[];
}

/**
 * No-LLM drafter. The statement is built ONLY from sentences copied verbatim from the CV
 * (the evidence sentences for each matched criterion, essential first, in order, without
 * repeats). No connecting words are added, so it cannot state anything the CV does not.
 * It is a rough draft for the user to edit, not finished prose.
 *
 * For a French application (job.language 'fr') the draft opens with a fixed French
 * salutation and one neutral sentence (FRENCH_FALLBACK_OPENING). That opening states
 * nothing about the applicant; everything after it is still copied verbatim from the CV,
 * in whatever language the CV is written in. Nothing is translated without an LLM.
 */
export function draftStatementFallback(input: StatementInput): StatementDraft {
  const ordered = [
    ...input.match.hits.filter((h) => h.criterion.essential),
    ...input.match.hits.filter((h) => !h.criterion.essential),
  ];
  const sentences: string[] = [];
  for (const hit of ordered) {
    if (hit.matched && hit.evidence && !sentences.includes(hit.evidence)) sentences.push(hit.evidence);
  }
  const warnings = ['Drafted without an LLM: this is a list of matching sentences from your CV. Edit it before use.'];
  if (sentences.length === 0) warnings.push('No evidence for any criterion was found in the CV, so the draft is empty.');
  const french = input.job.language === 'fr';
  if (french && sentences.length > 0) {
    warnings.push('This application is in French. Without an LLM only the opening is in French: the sentences from your CV are copied as they are and are not translated.');
  }
  const statement = french && sentences.length > 0 ? [FRENCH_FALLBACK_OPENING, ...sentences].join('\n') : sentences.join('\n');
  return { statement, gaps: [...input.match.unmetEssential], source: 'fallback', warnings };
}

/** Splits an LLM reply into the statement and its trailing "GAPS:" section. */
export function splitLlmStatement(reply: string): { statement: string; llmGaps: string[] } {
  const m = /^[ \t]*\**GAPS:?\**:?[ \t]*/im.exec(reply);
  if (!m) return { statement: reply.trim(), llmGaps: [] };
  const statement = reply.slice(0, m.index).trim();
  const llmGaps = reply
    .slice(m.index + m[0].length)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, '').trim())
    .filter((l) => l && !/^none\.?$/i.test(l));
  return { statement, llmGaps };
}

/**
 * A cheap guard, not a proof: flags unmet criteria whose keywords nevertheless appear in
 * the drafted statement, which suggests the LLM claimed something the CV does not evidence.
 */
export function findUnsupportedClaims(statement: string, match: MatchResult): string[] {
  return match.hits
    .filter((h) => !h.matched && h.criterion.keywords.some((k) => keywordInText(k, statement)))
    .map((h) => h.criterion.label);
}

export async function draftStatement(input: StatementInput, llm?: LlmPort): Promise<StatementDraft> {
  if (!llm) return draftStatementFallback(input);
  const { system, prompt } = buildStatementPrompt(input);
  let reply: string;
  try {
    reply = (await llm.complete({ system, prompt, maxTokens: 900 })).text;
  } catch (err) {
    const fb = draftStatementFallback(input);
    fb.warnings.unshift(`The LLM call failed (${err instanceof Error ? err.message : 'unknown error'}); used the no-LLM draft.`);
    return fb;
  }
  const { statement } = splitLlmStatement(reply);
  if (!statement) {
    const fb = draftStatementFallback(input);
    fb.warnings.unshift('The LLM returned an empty statement; used the no-LLM draft.');
    return fb;
  }
  const warnings = ['AI-drafted. Read every sentence and check it is true of you before submitting.'];
  const unsupported = findUnsupportedClaims(statement, input.match);
  if (unsupported.length) {
    warnings.push(`The draft mentions criteria your CV does not evidence: ${unsupported.join('; ')}. Remove or correct these.`);
  }
  return { statement, gaps: [...input.match.unmetEssential], source: 'llm', warnings };
}
