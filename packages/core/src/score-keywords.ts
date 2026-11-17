/**
 * A forgiving, AI-free keyword match for the public /score page (competitive brief, October 2026).
 *
 * The signed-in app reads an advert with the LLM and understands synonyms; the public page must stay
 * free and private (nothing sent, no API), so it can only compare words. A purely literal match
 * under-reports badly ("team communication" != the exact phrase "Communication skills" -> 0%), which
 * made a good CV look like a 0% match. This compares *word stems* instead, so common variants
 * (manage / managing / management) line up. It is deliberately a rough estimate, labelled as such;
 * the accurate score is the AI-read one on the Review screen.
 *
 * Pure: no I/O, no framework.
 */

// Common English words plus job-advert filler that carries no matching signal.
const STOPWORDS = new Set(
  (
    'a an and are as at be been being but by for from had has have he her his if in into is it its of on or our so that the their them then there these they this to was we were what when which who will with you your ' +
    'about above after again all also am any because before below between both can could did do does doing down during each few further here how more most no nor not now off once only other out over own same some such than too under until up very ' +
    'ability able across among applicant apply candidate career company essential etc experience including job knowledge level looking must need needs opportunity preferred recruit relevant role roles skill skills strong team teams work working would years year within us well want using use based desirable required require requirement requirements responsibility responsibilities duties duty ideal ideally join joining excellent good great please position vacancy'
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** A light suffix stemmer: enough to line up common variants, not linguistically perfect. */
export function stemWord(word: string): string {
  let w = word.toLowerCase();
  const suffixes = ['ational', 'isation', 'ization', 'ations', 'ation', 'isations', 'izations', 'ements', 'ement', 'ments', 'ment', 'ingly', 'ing', 'edly', 'ed', 'ies', 'ees', 'ers', 'er', 'ors', 'or', 'ance', 'ence', 'ities', 'ity', 'ively', 'ive', 'ally', 'ness', 'less', 'able', 'ible', 'ful', 'al', 'ly', 'es', 's'];
  for (const suf of suffixes) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1); // manage -> manag, so it meets managing/management
  return w;
}

function terms(text: string): string[] {
  // Letters, with internal + or # kept (c++, c#); punctuation such as a trailing full stop is a delimiter.
  return (text.toLowerCase().match(/[a-z][a-z0-9+#]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

const titleCase = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

export interface KeywordMatch {
  /** 0–100: share of the advert's distinct keywords whose stem appears in the CV. */
  percent: number;
  /** The advert's top keywords, each flagged matched or not — shaped for atsReadiness(). */
  hits: { label: string; essential: boolean; matched: boolean }[];
}

/**
 * @param maxTerms how many of the advert's distinct keywords to weigh (first appearance wins).
 */
export function keywordMatch(advert: string, title: string, cvText: string, maxTerms = 16): KeywordMatch {
  const cvStems = new Set(terms(cvText).map(stemWord));
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const raw of terms(`${title}\n${advert}`)) {
    const stem = stemWord(raw);
    if (seen.has(stem)) continue;
    seen.add(stem);
    picked.push(raw);
    if (picked.length >= maxTerms) break;
  }
  const hits = picked.map((raw) => ({ label: titleCase(raw), essential: false, matched: cvStems.has(stemWord(raw)) }));
  const matched = hits.filter((h) => h.matched).length;
  const percent = hits.length === 0 ? 0 : Math.round((100 * matched) / hits.length);
  return { percent, hits };
}
