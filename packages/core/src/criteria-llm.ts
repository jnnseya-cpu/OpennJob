/**
 * The AI-powered half of criteria extraction. Kept apart from matching.ts so that matching.ts
 * (match scoring and the deterministic fallback) stays browser-safe: the browser entries
 * (@core/web, browser.ts) import matching but must never reach the LlmPort. The API uses this file.
 */
import type { Criterion } from './types';
import type { LlmPort } from './llm';
import { extractJsonObject } from './text';
import { detectRequiredCredential, extractCriteriaFallback } from './matching';
import type { ExtractedCriteria } from './matching';

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
