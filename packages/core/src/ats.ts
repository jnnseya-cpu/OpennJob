/**
 * ATS-readiness check (October 2026, from the competitive brief).
 *
 * The recurring, independent finding across the field is that the real bottleneck is not how many
 * applications you send, but whether the CV passes the employer's applicant-tracking system (ATS)
 * and genuinely matches the advert. OpennJob already scores evidence and trace-checks documents;
 * this turns that into a plain ATS-readiness score the person sees before they apply.
 *
 * It reports keyword coverage against the advert's own requirements, plain-text parser checks on
 * the CV, and actionable tips. Every tip that suggests adding a term says to add it ONLY if it is
 * genuinely true of the person: OpennJob never invents a qualification or a claim (rule 1/8).
 *
 * Pure: no I/O, no framework. Shared by the web app (@core/web) and the API.
 */

/** One requirement from the advert, matched against the CV (the shape MatchResult.hits already has). */
export interface AtsHit {
  label: string;
  essential: boolean;
  matched: boolean;
}

export interface AtsCheck {
  id: 'contact' | 'sections' | 'length' | 'bullets' | 'parserSafe';
  label: string;
  ok: boolean;
  detail?: string;
}

export interface AtsReadiness {
  /** 0–100: 60% advert keyword coverage, 40% plain-text parser checks. */
  score: number;
  band: 'strong' | 'fair' | 'weak';
  /** How many of the advert's requirements the CV evidences (essential weighted double). */
  coverage: { matched: number; total: number; percent: number };
  /** Requirements the advert asks for that the CV does not evidence — essential first, de-duplicated. */
  missing: string[];
  checks: AtsCheck[];
  /** Plain, do-this-next suggestions. Term suggestions always say "only if true of you". */
  tips: string[];
}

const ESSENTIAL_WEIGHT = 2;
const DESIRABLE_WEIGHT = 1;
const MAX_MISSING = 8;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// A phone number: at least 9 digits, allowing spaces, +, (), -.
const PHONE = /(?:\+?\d[\s().-]*){9,}/;
const SECTION_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'experience', re: /\b(experience|employment|work history|career history)\b/i },
  { label: 'education', re: /\b(education|qualifications?|academic)\b/i },
  { label: 'skills', re: /\b(skills|competenc(?:e|ies)|expertise|proficien)/i },
  { label: 'summary', re: /\b(summary|profile|objective|about me)\b/i },
];
const BULLET_LINE = /^\s*(?:[-*•▪◦·]|\d+[.)])\s+/;

function wordCount(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** Lines that look like a pipe table or tab-separated columns: these confuse many ATS parsers. */
function parserHostileLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => (line.match(/\|/g) ?? []).length >= 2 || (line.match(/\t/g) ?? []).length >= 2).length;
}

function band(score: number): AtsReadiness['band'] {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'fair';
  return 'weak';
}

/**
 * @param hits  the advert's requirements matched against the CV (MatchResult.hits).
 * @param cvText the plain-text CV the application would be built from.
 */
export function atsReadiness(hits: readonly AtsHit[], cvText: string): AtsReadiness {
  const cv = cvText ?? '';

  // --- Keyword coverage against the advert's own requirements ---
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const h of hits) {
    const w = h.essential ? ESSENTIAL_WEIGHT : DESIRABLE_WEIGHT;
    totalWeight += w;
    if (h.matched) matchedWeight += w;
  }
  const coveragePercent = totalWeight === 0 ? 100 : Math.round((100 * matchedWeight) / totalWeight);
  const matchedCount = hits.filter((h) => h.matched).length;

  // Essential-first, de-duplicated labels of what the advert asks for and the CV does not show.
  const missing: string[] = [];
  for (const h of [...hits].sort((a, b) => Number(b.essential) - Number(a.essential))) {
    if (!h.matched && !missing.includes(h.label)) missing.push(h.label);
  }

  // --- Plain-text parser checks on the CV ---
  const words = wordCount(cv);
  const foundSections = SECTION_PATTERNS.filter((s) => s.re.test(cv)).map((s) => s.label);
  const bulletLines = cv.split(/\r?\n/).filter((l) => BULLET_LINE.test(l)).length;
  const hostile = parserHostileLines(cv);

  const checks: AtsCheck[] = [
    {
      id: 'contact',
      label: 'Contact details (e-mail and phone)',
      ok: EMAIL.test(cv) && PHONE.test(cv),
      ...(EMAIL.test(cv) && PHONE.test(cv) ? {} : { detail: 'An ATS reads these first. Put your e-mail and phone near the top in plain text.' }),
    },
    {
      id: 'sections',
      label: 'Clear section headings',
      ok: foundSections.length >= 2,
      ...(foundSections.length >= 2 ? {} : { detail: 'Use plain headings such as Experience, Education and Skills so the parser can split your CV.' }),
    },
    {
      id: 'length',
      label: 'Sensible length',
      ok: words >= 150 && words <= 1200,
      detail: words < 150 ? `Only ${words} words — likely too thin for a parser to score.` : words > 1200 ? `${words} words — long; trim to the most relevant.` : `${words} words.`,
    },
    {
      id: 'bullets',
      label: 'Bullet points for achievements',
      ok: bulletLines >= 3,
      ...(bulletLines >= 3 ? {} : { detail: 'List achievements as short bullet lines; ATS and readers both prefer them to dense paragraphs.' }),
    },
    {
      id: 'parserSafe',
      label: 'No tables or columns',
      ok: hostile === 0,
      ...(hostile === 0 ? {} : { detail: `${hostile} line(s) look like a table or columns; many ATS garble these. Use single-column plain text.` }),
    },
  ];

  // Format score weights the checks that matter most to a parser.
  const WEIGHTS: Record<AtsCheck['id'], number> = { contact: 0.3, sections: 0.3, length: 0.2, bullets: 0.1, parserSafe: 0.1 };
  const formatScore = Math.round(100 * checks.reduce((sum, c) => sum + (c.ok ? WEIGHTS[c.id] : 0), 0));

  const score = Math.round(0.6 * coveragePercent + 0.4 * formatScore);

  // --- Tips: parser fixes first, then truthful keyword suggestions ---
  const tips: string[] = [];
  for (const c of checks) if (!c.ok && c.detail) tips.push(c.detail);
  if (missing.length > 0) {
    const show = missing.slice(0, 5).join(', ');
    tips.push(`The advert asks for: ${show}${missing.length > 5 ? ', and more' : ''}. Add these to your CV in the advert's words — only if they are genuinely true of you. OpennJob never invents a claim.`);
  }
  if (tips.length === 0) tips.push('Strong match and parser-friendly. Keep the wording close to the advert where it is genuinely true of you.');

  return {
    score,
    band: band(score),
    coverage: { matched: matchedCount, total: hits.length, percent: coveragePercent },
    missing: missing.slice(0, MAX_MISSING),
    checks,
    tips,
  };
}
