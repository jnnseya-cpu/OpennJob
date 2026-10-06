import type { LlmPort } from './llm';
import type { JobLanguage, PackId } from './types';
import { detectLanguage } from './languages';
import { PACKS } from './packs';
import { countWords, extractJsonObject } from './text';

export type QuestionCategory = 'values' | 'clinical';
export type HealthcareRole = 'nurse' | 'hca' | 'support-worker';

export interface InterviewQuestion {
  id: string;
  category: QuestionCategory;
  roles: HealthcareRole[];
  text: string;
  /** What a strong answer usually covers. Shown to the user after they answer. */
  lookFor: string[];
}

const ALL: HealthcareRole[] = ['nurse', 'hca', 'support-worker'];

/** Written for OpennJob. Generic practice questions, not copied from any employer's interview pack. */
export const QUESTION_BANK: readonly InterviewQuestion[] = [
  { id: 'val-compassion', category: 'values', roles: ALL, text: 'Tell me about a time you showed compassion to a patient or service user who was distressed.', lookFor: ['what you noticed', 'what you did yourself', 'how the person responded'] },
  { id: 'val-dignity', category: 'values', roles: ALL, text: 'Describe a situation where you protected someone\'s dignity while providing personal care.', lookFor: ['consent', 'privacy', 'choice', 'outcome for the person'] },
  { id: 'val-speak-up', category: 'values', roles: ALL, text: 'Tell me about a time you raised a concern about the care someone was receiving.', lookFor: ['what the concern was', 'who you escalated to', 'what changed'] },
  { id: 'val-teamwork', category: 'values', roles: ALL, text: 'Give an example of working well in a team under pressure.', lookFor: ['your own role', 'communication', 'result for patients'] },
  { id: 'val-mistake', category: 'values', roles: ALL, text: 'Tell me about a mistake you made at work and what you did about it.', lookFor: ['honesty', 'reporting', 'what you learned'] },
  { id: 'val-difficult-family', category: 'values', roles: ALL, text: 'Describe a time you dealt with an upset relative or carer.', lookFor: ['listening', 'staying calm', 'follow-up'] },
  { id: 'val-inclusion', category: 'values', roles: ALL, text: 'Give an example of adapting your care to respect someone\'s culture, beliefs or preferences.', lookFor: ['asking not assuming', 'what you changed', 'outcome'] },
  { id: 'clin-deteriorating', category: 'clinical', roles: ['nurse', 'hca'], text: 'A patient\'s observations suddenly worsen during your shift. Tell me about a time this happened and what you did.', lookFor: ['recognising deterioration', 'escalation', 'documentation', 'outcome'] },
  { id: 'clin-medication-error', category: 'clinical', roles: ['nurse'], text: 'Tell me about a time you identified or prevented a medication error.', lookFor: ['checks you made', 'patient safety first', 'reporting', 'learning'] },
  { id: 'clin-prioritise', category: 'clinical', roles: ['nurse'], text: 'Describe a shift where you had to prioritise several patients with competing needs.', lookFor: ['how you assessed risk', 'delegation', 'result'] },
  { id: 'clin-safeguarding', category: 'clinical', roles: ALL, text: 'Describe a time you had a safeguarding concern about an adult or child in your care.', lookFor: ['what you observed', 'following policy', 'who you told', 'recording'] },
  { id: 'clin-falls', category: 'clinical', roles: ['hca', 'support-worker'], text: 'Tell me about a time you found someone on the floor or helped prevent a fall.', lookFor: ['immediate safety', 'calling for help', 'reporting', 'prevention afterwards'] },
  { id: 'clin-challenging-behaviour', category: 'clinical', roles: ['support-worker', 'hca'], text: 'Describe how you supported someone whose behaviour was challenging.', lookFor: ['de-escalation', 'understanding triggers', 'care plan', 'outcome'] },
  { id: 'clin-infection', category: 'clinical', roles: ALL, text: 'Give an example of how you prevented the spread of infection in your workplace.', lookFor: ['hand hygiene', 'PPE', 'challenging poor practice', 'result'] },
];

export function questionsFor(role?: HealthcareRole, category?: QuestionCategory): InterviewQuestion[] {
  return QUESTION_BANK.filter((q) => (!role || q.roles.includes(role)) && (!category || q.category === category));
}

export function findQuestion(id: string): InterviewQuestion | undefined {
  return QUESTION_BANK.find((q) => q.id === id);
}

/** One practice question from an industry pack. */
export interface PackQuestion {
  /** `${pack}-${n}`, e.g. "rail-2". */
  id: string;
  pack: PackId;
  /** The language the question is asked in. The francophone pack mixes French and English, as the demo does. */
  language: JobLanguage;
  text: string;
}

/** The per-pack question bank, taken from the pack registry (packs.ts). */
export const PACK_QUESTION_BANK: readonly PackQuestion[] = PACKS.flatMap((pack) =>
  pack.questions.map((text, i) => ({ id: `${pack.id}-${i + 1}`, pack: pack.id, language: detectLanguage(text), text })),
);

export function questionsForPack(pack: PackId): PackQuestion[] {
  return PACK_QUESTION_BANK.filter((q) => q.pack === pack);
}

export function findPackQuestion(id: string): PackQuestion | undefined {
  return PACK_QUESTION_BANK.find((q) => q.id === id);
}

export type StarPart = 'situation' | 'task' | 'action' | 'result';
export const STAR_PARTS: readonly StarPart[] = ['situation', 'task', 'action', 'result'];

export interface StarFeedback {
  /** Each part scored 0-5. */
  scores: Record<StarPart, number>;
  /** Sum of the four parts, 0-20. */
  total: number;
  strengths: string[];
  improvements: string[];
  source: 'llm' | 'heuristic';
}

export const STAR_SYSTEM_PROMPT =
  'You are an experienced interviewer giving practice feedback to a job candidate. Be specific, kind and honest. ' +
  'Judge only what the candidate actually said. Write your feedback in the language the candidate answered in. ' +
  'Reply with one JSON object and nothing else.';

export function buildStarPrompt(question: string, answer: string, lookFor: readonly string[] = []): string {
  return [
    'Score this interview answer against the STAR structure (Situation, Task, Action, Result).',
    'Score each part from 0 (missing) to 5 (clear, specific and relevant).',
    'Return JSON exactly in this shape:',
    '{"situation":0,"task":0,"action":0,"result":0,"strengths":["..."],"improvements":["..."]}',
    'Give at most 3 strengths and at most 3 improvements, each one short sentence.',
    'Write the strengths and improvements in the same language as the candidate\'s answer: French if the answer is in French, UK English if it is in English, whatever language the question was asked in. Keep the JSON keys in English.',
    'Do not rewrite the answer and do not invent details the candidate did not give.',
    '',
    `Question: ${question}`,
    lookFor.length ? `A strong answer usually covers: ${lookFor.join('; ')}.` : '',
    'Answer:',
    '"""',
    answer,
    '"""',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const clampScore = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : undefined;

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()).slice(0, 3) : [];

export function parseStarReply(text: string): StarFeedback | undefined {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  const s = clampScore(o.situation), t = clampScore(o.task), a = clampScore(o.action), r = clampScore(o.result);
  if (s === undefined || t === undefined || a === undefined || r === undefined) return undefined;
  return {
    scores: { situation: s, task: t, action: a, result: r },
    total: s + t + a + r,
    strengths: stringList(o.strengths),
    improvements: stringList(o.improvements),
    source: 'llm',
  };
}

/** French wording that signals each STAR part. Deliberately small; see scoreStarHeuristic. */
const CUES_FR: Record<StarPart, RegExp[]> = {
  situation: [/(?<![a-zà-ÿ])(lorsque|quand|pendant|l'an dernier|l'année dernière|en 20\d\d|sur (le|un|ce) (chantier|projet|programme|site))(?![a-zà-ÿ])/i, /(?<![a-zà-ÿ])(chantier|projet|programme|client|sous-traitants?|équipe|patiente?|service)(?![a-zà-ÿ])/i, /(?<![a-zà-ÿ])(il y avait|nous avions|accusait|était en retard|avait pris du retard)(?![a-zà-ÿ])/i],
  task: [/(?<![a-zà-ÿ])(mon rôle|ma mission|ma responsabilité|ma tâche|mon objectif)(?![a-zà-ÿ])/i, /(?<![a-zà-ÿ])(j'étais (responsable|chargée?)|on m'a (demandé|confié))(?![a-zà-ÿ])/i, /(?<![a-zà-ÿ])(je devais|il me fallait|il fallait que je)(?![a-zà-ÿ])/i],
  action: [/(?<![a-zà-ÿ])j'ai (?:(?:ensuite|aussi|d'abord|immédiatement) )?[a-zà-ÿ]+(é|i|is|it|u)(?![a-zà-ÿ])/gi, /(?<![a-zà-ÿ])(puis j'ai|ensuite j'ai|j'ai d'abord|j'ai immédiatement)(?![a-zà-ÿ])/i],
  result: [/(?<![a-zà-ÿ])(résultat|en conséquence|au final|finalement|cela a permis|ce qui a permis|grâce à)(?![a-zà-ÿ])/i, /(?<![a-zà-ÿ])(amélioré|rattrapé|réduit|évité|livré|respecté|résolu|rétabli)(?![a-zà-ÿ])/i, /(?<![a-zà-ÿ])(j'ai appris|depuis|j'en ai tiré|la prochaine fois)(?![a-zà-ÿ])/i],
};

const CUES: Record<StarPart, RegExp[]> = {
  situation: [/\b(when|while|during|last (year|month|week)|on (a|one|my) (shift|ward|placement|visit))\b/i, /\b(patient|resident|service user|client|relative|ward|care home|unit|shift)\b/i, /\b(there was|we had|was admitted|had been|was (very )?(distressed|unwell|upset|confused))\b/i],
  task: [/\bmy (role|job|task|responsibility|duty|priority)\b/i, /\bi was (responsible|asked|allocated|assigned|in charge)\b/i, /\b(i (needed|had) to|it was my|the aim was)\b/i, /\b(mak(e|ing) sure|ensur(e|ing))\b/i],
  action: [/\bI (?:(?:then|also|first|next|\w+ly) )?(?:spoke|called|escalated|reported|checked|assessed|reassured|explained|recorded|documented|administered|supported|helped|asked|listened|arranged|contacted|completed|stayed|informed|monitored|raised|followed|used|sat|took|made|gave)\b/g, /\b(so i|i then|i immediately|first,? i|next,? i|after that,? i)\b/i],
  result: [/\b(as a result|the (result|outcome) was|in the end|this meant|this led to|afterwards|subsequently)\b/i, /\b(improved|recovered|settled|was (safe|discharged|resolved|reviewed)|thanked|reduced|prevented|avoided)\b/i, /\b(i learn(ed|t)|i now|since then|i reflected|next time)\b/i],
};

/**
 * Heuristic fallback when no LLM is configured. It looks for wording that usually signals
 * each STAR part and how much the candidate says "I did". It cannot judge whether the
 * answer is true, clinically sound, or relevant to the question. Treat it as a structure
 * check only.
 *
 * The feedback is written in the language of the answer: an answer that reads as French
 * is checked against French cue words and gets its advice in French. The French cue list
 * is much smaller than the English one and has only been tried on the test answers.
 */
export function scoreStarHeuristic(answer: string): StarFeedback {
  if (detectLanguage(answer) === 'fr') return scoreStarHeuristicFrench(answer);
  const words = countWords(answer);
  const scores = { situation: 0, task: 0, action: 0, result: 0 } as Record<StarPart, number>;
  if (words > 0) {
    for (const part of STAR_PARTS) {
      let cueHits = 0;
      for (const re of CUES[part]) {
        re.lastIndex = 0;
        if (re.test(answer)) cueHits += 1;
      }
      let score = cueHits === 0 ? 0 : cueHits === 1 ? 2 : cueHits === 2 ? 3 : 4;
      if (part === 'action') {
        // Count "I <verb>" statements, plus verbs chained on with "and" ("I checked ... and called ...").
        const direct = answer.match(CUES.action[0] as RegExp)?.length ?? 0;
        const chained = direct > 0 ? (answer.match(/\band (?:spoke|called|escalated|reported|checked|assessed|reassured|explained|recorded|documented|administered|supported|helped|asked|listened|arranged|contacted|completed|stayed|informed|monitored|raised|followed|used|sat|took|made|gave)\b/g)?.length ?? 0) : 0;
        const actions = direct + chained;
        if (actions >= 3) score = Math.max(score, 4);
        if (actions >= 5) score = 5;
      }
      if (part === 'result' && score >= 3 && /\b\d+\b/.test(answer)) score = Math.min(5, score + 1);
      if (part === 'situation' && score >= 3 && words >= 60) score = Math.min(5, score + 1);
      if (words < 40) score = Math.min(score, 2); // too short to be specific
      scores[part] = score;
    }
  }
  const names: Record<StarPart, string> = { situation: 'Situation', task: 'Task', action: 'Action', result: 'Result' };
  const advice: Record<StarPart, string> = {
    situation: 'Set the scene in one or two sentences: where you were, who was involved and what was happening.',
    task: 'Say what you personally were responsible for ("My role was...", "I needed to...").',
    action: 'Spend most of the answer on what you did, step by step, using "I" rather than "we".',
    result: 'Finish with the outcome for the patient or team, and what you learned.',
  };
  const strengths = STAR_PARTS.filter((p) => scores[p] >= 4).map((p) => `${names[p]}: clearly covered.`).slice(0, 3);
  const improvements = STAR_PARTS.filter((p) => scores[p] <= 2).map((p) => `${names[p]}: ${advice[p]}`);
  if (words < 40) improvements.unshift('The answer is very short. Aim for around 150 to 250 words (about two minutes spoken).');
  else if (words > 400) improvements.unshift('The answer is long. Aim for about two minutes spoken and cut background detail.');
  return {
    scores,
    total: scores.situation + scores.task + scores.action + scores.result,
    strengths,
    improvements: improvements.slice(0, 3),
    source: 'heuristic',
  };
}

function scoreStarHeuristicFrench(answer: string): StarFeedback {
  const words = countWords(answer);
  const scores = { situation: 0, task: 0, action: 0, result: 0 } as Record<StarPart, number>;
  for (const part of STAR_PARTS) {
    let cueHits = 0;
    for (const re of CUES_FR[part]) {
      re.lastIndex = 0;
      if (re.test(answer)) cueHits += 1;
    }
    let score = cueHits === 0 ? 0 : cueHits === 1 ? 2 : cueHits === 2 ? 3 : 4;
    if (part === 'action') {
      const actions = answer.match(CUES_FR.action[0] as RegExp)?.length ?? 0;
      if (actions >= 3) score = Math.max(score, 4);
      if (actions >= 5) score = 5;
    }
    if (part === 'result' && score >= 3 && /\b\d+\b/.test(answer)) score = Math.min(5, score + 1);
    if (words < 40) score = Math.min(score, 2);
    scores[part] = score;
  }
  const names: Record<StarPart, string> = { situation: 'Situation', task: 'Tâche', action: 'Action', result: 'Résultat' };
  const advice: Record<StarPart, string> = {
    situation: 'Plantez le décor en une ou deux phrases : où vous étiez, qui était concerné et ce qui se passait.',
    task: 'Dites ce dont vous étiez personnellement responsable (« Mon rôle était... », « Je devais... »).',
    action: 'Consacrez l\'essentiel de la réponse à ce que vous avez fait, étape par étape, en disant « je » plutôt que « nous ».',
    result: 'Terminez par le résultat obtenu et ce que vous en avez appris.',
  };
  const strengths = STAR_PARTS.filter((p) => scores[p] >= 4).map((p) => `${names[p]} : bien traitée.`).slice(0, 3);
  const improvements = STAR_PARTS.filter((p) => scores[p] <= 2).map((p) => `${names[p]} : ${advice[p]}`);
  if (words < 40) improvements.unshift('La réponse est très courte. Visez 150 à 250 mots environ (deux minutes à l\'oral).');
  else if (words > 400) improvements.unshift('La réponse est longue. Visez deux minutes à l\'oral et réduisez le contexte.');
  return { scores, total: scores.situation + scores.task + scores.action + scores.result, strengths, improvements: improvements.slice(0, 3), source: 'heuristic' };
}

export async function scoreAnswer(
  input: { question: string; answer: string; lookFor?: readonly string[] },
  llm?: LlmPort,
): Promise<StarFeedback> {
  if (!llm) return scoreStarHeuristic(input.answer);
  try {
    const reply = await llm.complete({
      system: STAR_SYSTEM_PROMPT,
      prompt: buildStarPrompt(input.question, input.answer, input.lookFor),
      maxTokens: 600,
    });
    return parseStarReply(reply.text) ?? scoreStarHeuristic(input.answer);
  } catch {
    return scoreStarHeuristic(input.answer);
  }
}
