import type { FillValue, SensitiveCategory } from './fields';
import type { DeclarationAnswers } from './types';

/**
 * OD-6 (owner decision, 8 October 2026): declarations answered from the person's own answers
 * (Profile: "Declarations OpennJob answers for you"). Like the right-to-work record (OD-5), a field
 * answered here counts as answered: it does not stop auto mode submitting (policy.ts, fromOwnRecord).
 *
 * Only plain wordings are answered; anything else is left for the person, as before:
 *  - convictions: a yes/no question about convictions or cautions, from "ever convicted";
 *    a tick box "I have no criminal convictions" is ticked only when the answer is no.
 *  - conflict of interest: a yes/no question, from the person's answer.
 *  - declaration and consent: a tick box (or yes/no) certifying the information is true, or
 *    accepting a privacy notice or terms, when the person allowed it. A box claiming a fact
 *    ("I confirm I hold a driving licence") is never ticked.
 *  - equality monitoring: "Prefer not to say", when the person chose it.
 * Health, safeguarding, fitness to practise, vetting and security clearance stay the person's.
 */

/** The value fill.ts matches against any "prefer not to say" / "do not wish to disclose" option. */
export const PREFER_NOT_TO_SAY = 'Prefer not to say';

export interface OwnAnswerField {
  category: SensitiveCategory | null;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'listbox';
}

const none = { value: undefined, fromOwnRecord: false } as const;
const yesNo = (kind: OwnAnswerField['kind']) => kind === 'radio' || kind === 'select' || kind === 'listbox';
const t = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/** A statement ("I have no...", "I do not have...") rather than a question. */
const NEGATIVE_STATEMENT = /\b(i have no|i do not have|i don.t have|i have never|i am not aware of any|there (is|are) no)\b/;
/** A box that claims a fact about the person: never ticked from consent. */
const FACT_CLAIM = /\bi (hold|possess|own)\b|\bi am (a|an|eligible|qualified|registered|entitled|able|over|under|aged)\b|\bi have (a|an|no|never|been|the right|held|obtained|completed)\b|licen[cs]e|degree|qualif|eligib|right to work|sponsor|convict|criminal|disab|health/;
const CERTIFY = /\b(true|accurate|correct|complete|truthful)\b|certify|privacy|terms (and|&) conditions|data protection|\bgdpr\b|consent|i agree|i accept|accept the|agree to|read and understood|processing of my/;

export function ownAnswer(field: OwnAnswerField, answers: DeclarationAnswers | undefined): { value: FillValue | undefined; fromOwnRecord: boolean } {
  if (!answers) return none;
  const label = t(field.label);
  switch (field.category) {
    case 'convictions': {
      if (answers.everConvicted === undefined) return none;
      if (field.kind === 'checkbox') return !answers.everConvicted && NEGATIVE_STATEMENT.test(label) ? { value: true, fromOwnRecord: true } : none;
      if (!yesNo(field.kind) || NEGATIVE_STATEMENT.test(label) || /\bnot\b|n.t\b/.test(label)) return none;
      return { value: answers.everConvicted, fromOwnRecord: true };
    }
    case 'conflict-of-interest': {
      if (answers.conflictOfInterest === undefined) return none;
      if (field.kind === 'checkbox') return !answers.conflictOfInterest && NEGATIVE_STATEMENT.test(label) ? { value: true, fromOwnRecord: true } : none;
      if (!yesNo(field.kind) || NEGATIVE_STATEMENT.test(label) || /\bnot\b|n.t\b/.test(label)) return none;
      return { value: answers.conflictOfInterest, fromOwnRecord: true };
    }
    case 'declaration': {
      if (answers.certifyAndConsent !== true || !CERTIFY.test(label) || FACT_CLAIM.test(label)) return none;
      return field.kind === 'checkbox' || yesNo(field.kind) ? { value: true, fromOwnRecord: true } : none;
    }
    case 'equality': {
      if (answers.equalityPreferNotToSay !== true || field.kind === 'checkbox') return none;
      return { value: PREFER_NOT_TO_SAY, fromOwnRecord: true };
    }
    default:
      return none;
  }
}
