import type { Criterion, JobLanguage } from './types';

/** Languages a candidate can select. The list the demo offers. */
export const LANGUAGES = ['English', 'French', 'Lingala', 'Swahili', 'Arabic', 'German', 'Spanish', 'Portuguese'] as const;
export type Language = (typeof LANGUAGES)[number];

/** The language an application is written in. Only English and French are supported. */
export const JOB_LANGUAGE_NAME: Readonly<Record<JobLanguage, Language>> = { en: 'English', fr: 'French' };

/** "french" / " FRENCH " -> "French". undefined for anything not in LANGUAGES. */
export function normaliseLanguage(value: unknown): Language | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return LANGUAGES.find((l) => l.toLowerCase() === v);
}

/** Words in a criterion that show it is asking for a language. Matched as whole words, accents ignored. */
const LANGUAGE_WORDS: Readonly<Record<Language, string[]>> = {
  English: ['english', 'anglais'],
  French: ['french', 'francais', 'francophone'],
  Lingala: ['lingala'],
  Swahili: ['swahili', 'kiswahili'],
  Arabic: ['arabic', 'arabe'],
  German: ['german', 'allemand', 'deutsch'],
  Spanish: ['spanish', 'espagnol'],
  Portuguese: ['portuguese', 'portugais'],
};

const fold = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Which languages a criterion asks for, judged from its label and keywords
 * ("French, fluent" -> French; "French or Arabic language" -> French and Arabic).
 * "UK English spelling" style wording is not a criterion label, so plain word matching is enough here.
 */
export function languagesAskedBy(criterion: Pick<Criterion, 'label' | 'keywords'>): Language[] {
  const text = fold([criterion.label, ...criterion.keywords].join(' | '));
  return LANGUAGES.filter((language) => LANGUAGE_WORDS[language].some((w) => new RegExp(`(?<![a-z])${w}(?![a-z])`).test(text)));
}

const FRENCH_MARKERS =
  /(?<![a-z])(le|la|les|des|du|une|et|est|vous|nous|pour|avec|dans|sur|votre|notre|je|j'ai|que|qui|au|aux|poste|chantier|candidature|responsable|directeur|directrice|charge|chargee|experience|maitrise|gestion|projet|programme|equipe|sein|ans|parlez|comment|d'un|d'une|l'equipe)(?![a-z])/g;
const ENGLISH_MARKERS = /(?<![a-z])(the|and|of|to|for|with|you|your|our|we|is|are|will|in|on|a|an|have|has|experience|manager|must|about|how|what|tell|me)(?![a-z])/g;

/**
 * Rough guess at whether a piece of text is written in French. A word-count heuristic,
 * good enough to choose between "en" and "fr" for a job advert or an interview answer.
 * Anything it is unsure about is "en".
 */
export function detectLanguage(text: string): JobLanguage {
  const t = fold(text);
  const fr = t.match(FRENCH_MARKERS)?.length ?? 0;
  const en = t.match(ENGLISH_MARKERS)?.length ?? 0;
  return fr >= 2 && fr > en ? 'fr' : 'en';
}
