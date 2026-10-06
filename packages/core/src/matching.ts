import type { Criterion, Job, Passport, Preferences } from './types';
import type { LlmPort } from './llm';
import { languagesAskedBy } from './languages';
import { classifyPack } from './packs';
import { credentialOf, requiredCredentialOf } from './passport';
import { extractJsonObject, keywordInText, splitSentences } from './text';

export const ESSENTIAL_WEIGHT = 2;
export const DESIRABLE_WEIGHT = 1;

export interface CriterionHit {
  criterion: Criterion;
  matched: boolean;
  /** The keyword that matched, if any. */
  keyword?: string;
  /** The first CV sentence containing a matching keyword (verbatim from the CV). */
  evidence?: string;
  /**
   * Set only when the criterion asks for a language, the CV does not evidence it, and the
   * candidate selected that language in their preferences. There is no CV evidence for
   * such a hit, so `evidence` stays undefined.
   */
  statedLanguage?: string;
}

export interface MatchResult {
  /** round(100 x matched weight / total weight). 0 when the job has no criteria. */
  score: number;
  /** false only when the job requires a credential (NMC PIN, security clearance, ...) that is not stored in the passport. */
  eligible: boolean;
  /** The credential that is required and missing, when not eligible. */
  missingCredential?: string;
  matchedWeight: number;
  totalWeight: number;
  hits: CriterionHit[];
  /** Labels of essential criteria with no evidence in the CV. */
  unmetEssential: string[];
}

/**
 * Scores a job against the CV.
 *
 * Language rule: a language the candidate SELECTED in their preferences counts as
 * evidence for a criterion that asks for that language. An empty language list selects
 * nothing, so it is never evidence of speaking any language (even though, for scope, an
 * empty list excludes nothing).
 */
export function matchJob(
  job: Pick<Job, 'criteria' | 'requiresRegistration'> & Partial<Pick<Job, 'requiredCredential'>>,
  cvText: string,
  passport: Pick<Passport, 'nmcPin' | 'credentials'> | undefined,
  preferences?: Pick<Preferences, 'languages'>,
): MatchResult {
  const selected = (preferences?.languages ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const sentences = splitSentences(cvText);
  let matchedWeight = 0;
  let totalWeight = 0;

  const hits: CriterionHit[] = job.criteria.map((criterion) => {
    const weight = criterion.essential ? ESSENTIAL_WEIGHT : DESIRABLE_WEIGHT;
    totalWeight += weight;
    const keyword = criterion.keywords.find((k) => keywordInText(k, cvText));
    if (keyword === undefined) {
      const stated = selected.length > 0 ? languagesAskedBy(criterion).find((l) => selected.includes(l.toLowerCase())) : undefined;
      if (stated === undefined) return { criterion, matched: false };
      matchedWeight += weight;
      return { criterion, matched: true, statedLanguage: stated };
    }
    matchedWeight += weight;
    // Evidence is the first sentence, in CV order, that contains any of the criterion's keywords.
    const evidence = sentences.find((s) => criterion.keywords.some((k) => keywordInText(k, s)));
    return { criterion, matched: true, keyword, ...(evidence ? { evidence } : {}) };
  });

  const required = requiredCredentialOf(job);
  const eligible = required === undefined || credentialOf(passport, required).length > 0;
  return {
    score: totalWeight === 0 ? 0 : Math.round((100 * matchedWeight) / totalWeight),
    eligible,
    ...(eligible || required === undefined ? {} : { missingCredential: required }),
    matchedWeight,
    totalWeight,
    hits,
    unmetEssential: hits.filter((h) => !h.matched && h.criterion.essential).map((h) => h.criterion.label),
  };
}

// ---------------------------------------------------------------------------------------
// Criteria extraction
// ---------------------------------------------------------------------------------------

export interface ExtractedCriteria {
  criteria: Criterion[];
  requiresRegistration: boolean;
  /** 'pin' when requiresRegistration, 'sc' when the advert requires security clearance. */
  requiredCredential?: string;
  source: 'llm' | 'fallback';
}

/**
 * Heuristic: does this role need NMC registration?
 * True when the description explicitly asks for NMC registration, or the title is a
 * registered-nurse/midwife title and not an assistant/associate/student/support title.
 * It is a heuristic; the user always sees the result and can ignore it.
 */
export function detectRequiresRegistration(title: string, description: string): boolean {
  const explicit =
    /\b(current|valid|active|live|full)\s+nmc\b|\bnmc\s+(pin|registration|registered)\b|\bregistered\s+with\s+the\s+nmc\b|\bregistration\s+with\s+the\s+(nmc|nursing\s+and\s+midwifery\s+council)\b/i;
  const negated = /\bnot\s+(be\s+)?(required|needed|necessary|essential)\b|\bno\s+nmc\b|\bwithout\s+(an?\s+)?nmc\b/i;
  const sentences = [title, ...splitSentences(description)];
  if (sentences.some((s) => explicit.test(s) && !negated.test(s))) return true;
  const nonRegisteredTitle = /assistant|associate|student|support\s+worker|\bhca\b|carer|care\s+worker|trainee|apprentice/i;
  const registeredTitle = /\bnurse\b|\bmidwife\b|\brgn\b|\brmn\b|\brnld\b|\brn\b/i;
  return registeredTitle.test(title) && !nonRegisteredTitle.test(title);
}

/**
 * Heuristic: does the advert REQUIRE security clearance? True for "SC cleared",
 * "security clearance (SC) required", "must hold SC clearance" and similar, unless the
 * same sentence says it is not required or is desirable. Like the registration
 * heuristic it can be wrong in both directions; the user always sees the result.
 */
export function detectRequiresSecurityClearance(title: string, description: string): boolean {
  const asks = /\bsc[\s-]+clear(ed|ance)\b|\bsecurity\s+clear(ed|ance)\b|\bdv[\s-]+clear(ed|ance)\b|\bhabilitation\s+de\s+s[ée]curit[ée]\b/i;
  const soft = /\bnot\s+(be\s+)?(required|needed|necessary|essential)\b|\bdesirable\b|\badvantage(ous)?\b|\bpreferred\b|\bwilling(ness)?\s+to\b|\beligib(le|ility)\b|\bable\s+to\s+obtain\b/i;
  return [title, ...splitSentences(description)].some((s) => asks.test(s) && !soft.test(s));
}

/** The passport credential a job needs, judged from its wording: 'pin', 'sc' or none. */
export function detectRequiredCredential(title: string, description: string): string | undefined {
  if (detectRequiresRegistration(title, description)) return 'pin';
  if (detectRequiresSecurityClearance(title, description)) return 'sc';
  return undefined;
}

/**
 * Terms for the construction, data-centre, energy, rail and francophone packs, used by the
 * same deterministic extractor. Short and incomplete on purpose: it makes a discovered
 * job in those sectors scoreable without an LLM, nothing more.
 */
export const INFRA_LEXICON: ReadonlyArray<{ label: string; keywords: string[] }> = [
  { label: 'Chartered status (MCIOB or MRICS)', keywords: ['MCIOB', 'MRICS', 'chartered'] },
  { label: 'CDM 2015 duties', keywords: ['CDM'] },
  { label: 'NEC contract administration', keywords: ['NEC4', 'NEC3'] },
  { label: 'FIDIC contracts', keywords: ['FIDIC'] },
  { label: 'SMSTS certificate', keywords: ['SMSTS'] },
  { label: 'CSCS card', keywords: ['CSCS'] },
  { label: 'Primavera P6 scheduling', keywords: ['Primavera'] },
  { label: 'BIM coordination', keywords: ['BIM'] },
  { label: 'HSE leadership', keywords: ['HSE'] },
  { label: 'QA/QC and compliance', keywords: ['QA/QC'] },
  { label: 'Multi-contractor leadership', keywords: ['multi-contractor'] },
  { label: 'Client-side authority', keywords: ['client-side'] },
  { label: 'PRINCE2 or APM qualification', keywords: ['PRINCE2', 'APMP', 'APM PMQ'] },
  { label: 'Security clearance (SC)', keywords: ['SC cleared', 'security clearance'] },
  { label: 'Data centre delivery', keywords: ['data centre', 'data center'] },
  { label: 'MEP coordination', keywords: ['MEP'] },
  { label: 'Commissioning', keywords: ['commissioning'] },
  { label: 'HV power systems', keywords: ['HV', 'high voltage'] },
  { label: 'Substation delivery', keywords: ['substation'] },
  { label: 'Offshore wind programmes', keywords: ['offshore wind'] },
  { label: 'Solar or battery storage', keywords: ['solar', 'BESS', 'battery storage'] },
  { label: 'Rail programme delivery', keywords: ['railway', 'rail programme', 'rail project'] },
  { label: 'Metro or light rail delivery', keywords: ['metro', 'light rail'] },
  { label: 'Personal Track Safety card', keywords: ['personal track safety', 'PTS card'] },
  { label: 'Earned value management', keywords: ['EVM', 'earned value'] },
  { label: 'French language', keywords: ['french', 'français'] },
  { label: 'German language', keywords: ['german'] },
  { label: 'Arabic language', keywords: ['arabic'] },
];

/** Deterministic lexicon used when no LLM is configured (or its reply is unusable). */
export const HEALTHCARE_LEXICON: ReadonlyArray<{ label: string; keywords: string[] }> = [
  { label: 'NMC registration', keywords: ['NMC', 'registered nurse', 'RGN', 'RMN', 'RNLD'] },
  { label: 'Nursing degree or diploma', keywords: ['nursing degree', 'BSc Nursing', 'diploma in nursing', 'BSc (Hons) Nursing'] },
  { label: 'Care Certificate', keywords: ['care certificate'] },
  { label: 'NVQ/QCF in Health and Social Care', keywords: ['NVQ', 'QCF', 'health and social care'] },
  { label: 'Medication administration', keywords: ['medication', 'medicines management', 'drug round'] },
  { label: 'Safeguarding', keywords: ['safeguarding'] },
  { label: 'Care planning', keywords: ['care plan', 'care planning'] },
  { label: 'Record keeping and documentation', keywords: ['record keeping', 'documentation', 'care records', 'accurate records'] },
  { label: 'Moving and handling', keywords: ['moving and handling', 'manual handling', 'hoist'] },
  { label: 'Infection prevention and control', keywords: ['infection control', 'infection prevention'] },
  { label: 'Personal care', keywords: ['personal care'] },
  { label: 'Dementia care', keywords: ['dementia'] },
  { label: 'Mental health experience', keywords: ['mental health'] },
  { label: 'Learning disability experience', keywords: ['learning disability', 'learning disabilities'] },
  { label: 'End of life / palliative care', keywords: ['end of life', 'palliative'] },
  { label: 'Wound care', keywords: ['wound care', 'wound management', 'dressings'] },
  { label: 'Clinical observations', keywords: ['observations', 'NEWS2', 'vital signs'] },
  { label: 'Venepuncture and cannulation', keywords: ['venepuncture', 'cannulation', 'phlebotomy'] },
  { label: 'Basic life support', keywords: ['basic life support', 'BLS', 'immediate life support', 'ILS'] },
  { label: 'Acute hospital experience', keywords: ['acute', 'ward'] },
  { label: 'Community care experience', keywords: ['community', 'domiciliary', 'home care'] },
  { label: 'Teamwork', keywords: ['team', 'multidisciplinary', 'MDT'] },
  { label: 'Communication skills', keywords: ['communication', 'communicate'] },
  { label: 'Supervising or mentoring staff', keywords: ['mentor', 'supervis', 'preceptor'] },
  { label: 'Full UK driving licence', keywords: ['driving licence', 'driving license'] },
];

const DESIRABLE_HEADING = /^\W*(desirable|nice to have|preferred|atouts|souhait[ée]s?|crit[èe]res souhait[ée]s)(?![a-zà-ÿ])/i;
const ESSENTIAL_HEADING = /^\W*(essential|required|requirements|you must have|what you.ll need|profil recherch[ée]|crit[èe]res essentiels|exigences)(?![a-zà-ÿ])/i;
const DESIRABLE_INLINE = /\b(desirable|advantage|advantageous|preferred|preferably|ideally|beneficial|nice to have|would be a bonus)\b/i;

/**
 * Deterministic, keyword-based criteria extraction. No network, no randomness.
 *
 * - If the advert has "Essential" / "Desirable" style headings, only the lines under a
 *   heading are read (the introduction above them is ignored).
 * - If it has no such headings, every line is read and everything is essential unless
 *   the line itself says "desirable", "an advantage", "ideally" and so on.
 * - A line offering alternatives ("Care Certificate or NVQ Level 2") becomes ONE
 *   criterion that either alternative satisfies.
 * It only recognises the terms in HEALTHCARE_LEXICON and INFRA_LEXICON, so it will miss anything unusual.
 */
export function extractCriteriaFallback(jobDescription: string, title = ''): ExtractedCriteria {
  const byLabel = new Map<string, Criterion>();
  const lines = jobDescription.split(/\r?\n+/).flatMap((raw) => splitSentences(raw));
  const isHeading = (line: string) => line.length <= 60 && (DESIRABLE_HEADING.test(line) || ESSENTIAL_HEADING.test(line));
  const hasHeadings = lines.some(isHeading);
  let section: 'intro' | 'essential' | 'desirable' = hasHeadings ? 'intro' : 'essential';

  const add = (label: string, essential: boolean, keywords: string[]) => {
    const existing = byLabel.get(label);
    // A criterion mentioned as essential anywhere stays essential.
    if (!existing) byLabel.set(label, { label, essential, keywords });
    else if (essential) existing.essential = true;
  };

  // A healthcare advert is read with the healthcare terms only, exactly as in v1 (so "HSE"
  // in an Irish nursing advert is not mistaken for site health and safety).
  const lexicon = classifyPack({ title, description: jobDescription }) === 'hc' ? HEALTHCARE_LEXICON : [...HEALTHCARE_LEXICON, ...INFRA_LEXICON];

  for (const line of lines) {
    if (isHeading(line)) {
      section = DESIRABLE_HEADING.test(line) ? 'desirable' : 'essential';
      continue;
    }
    if (section === 'intro') continue;
    const essential = section === 'essential' && !DESIRABLE_INLINE.test(line);
    const found = lexicon.filter((entry) => entry.keywords.some((k) => keywordInText(k, line)));
    if (found.length > 1 && /\bor\b/i.test(line)) {
      add(found.map((e) => e.label).join(' or '), essential, found.flatMap((e) => e.keywords));
    } else {
      for (const entry of found) add(entry.label, essential, [...entry.keywords]);
    }
  }
  const requiredCredential = detectRequiredCredential(title, jobDescription);
  return {
    criteria: [...byLabel.values()],
    requiresRegistration: requiredCredential === 'pin',
    ...(requiredCredential ? { requiredCredential } : {}),
    source: 'fallback',
  };
}

export const CRITERIA_SYSTEM_PROMPT =
  'You extract person-specification criteria from job adverts (healthcare, construction, data centres, energy, rail; in English or French). ' +
  'Reply with one JSON object and nothing else.';

export function buildCriteriaPrompt(jobDescription: string, title = ''): string {
  return [
    'Read the job advert below and list its selection criteria.',
    'Return JSON exactly in this shape:',
    '{"criteria":[{"label":"short name of the criterion","essential":true,"keywords":["word or short phrase a matching CV would contain"]}],"requiresRegistration":false}',
    'Rules:',
    '- "essential" is true for essential/required criteria and false for desirable ones.',
    '- Give 2 to 6 keywords per criterion: lower-case words or short phrases, including common UK synonyms and abbreviations.',
    '- For an advert written in French, write the labels in French and give keywords in both French and English.',
    '- "requiresRegistration" is true only if the role requires registration with a professional regulator (for example an NMC PIN).',
    '- Use only what the advert says. At most 15 criteria.',
    '',
    title ? `Job title: ${title}` : '',
    'Job advert:',
    '"""',
    jobDescription,
    '"""',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Validates the LLM's JSON. Returns undefined when it is not usable. */
export function parseCriteriaReply(text: string): { criteria: Criterion[]; requiresRegistration: boolean } | undefined {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object') return undefined;
  const raw = (obj as { criteria?: unknown }).criteria;
  if (!Array.isArray(raw)) return undefined;
  const criteria: Criterion[] = [];
  for (const item of raw.slice(0, 15)) {
    if (!item || typeof item !== 'object') continue;
    const { label, essential, keywords } = item as Record<string, unknown>;
    if (typeof label !== 'string' || !label.trim() || !Array.isArray(keywords)) continue;
    const clean = [...new Set(keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean))].slice(0, 8);
    if (clean.length === 0) continue;
    criteria.push({ label: label.trim().slice(0, 120), essential: essential === true, keywords: clean });
  }
  if (criteria.length === 0) return undefined;
  return { criteria, requiresRegistration: (obj as { requiresRegistration?: unknown }).requiresRegistration === true };
}

/**
 * Turns a raw job description into criteria. Uses the LLM when one is supplied and falls
 * back to the deterministic extractor when there is no LLM, the call fails, or the reply
 * cannot be parsed.
 */
export async function extractCriteria(jobDescription: string, llm?: LlmPort, title = ''): Promise<ExtractedCriteria> {
  const fallback = () => extractCriteriaFallback(jobDescription, title);
  if (!llm) return fallback();
  try {
    const reply = await llm.complete({
      system: CRITERIA_SYSTEM_PROMPT,
      prompt: buildCriteriaPrompt(jobDescription, title),
      maxTokens: 1200,
    });
    const parsed = parseCriteriaReply(reply.text);
    if (!parsed) return fallback();
    // Either signal is enough: we would rather warn about registration than miss it.
    const requiredCredential = parsed.requiresRegistration ? 'pin' : detectRequiredCredential(title, jobDescription);
    return {
      criteria: parsed.criteria,
      requiresRegistration: requiredCredential === 'pin',
      ...(requiredCredential ? { requiredCredential } : {}),
      source: 'llm',
    };
  } catch {
    return fallback();
  }
}
