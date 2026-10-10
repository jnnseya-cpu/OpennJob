import { getPack } from './core';
import type { PackDeclaration } from './core';
import type { MatchView } from './types';

/**
 * Asked on almost every form, whatever the pack. OpennJob never answers any declaration;
 * the person does, on the employer's form, every time.
 */
const ALWAYS: PackDeclaration = { id: 'declare', label: 'Any other declaration or “I confirm” statement on the form' };

/** For a job with no pack: the declarations nearly every application form asks. */
const GENERIC: PackDeclaration[] = [
  { id: 'rtw', label: 'Right to work or visa status for this country' },
  { id: 'conv', label: 'Criminal convictions declaration' },
];

/**
 * What the user must confirm for this job: the pack's declarations (packages/core/src/packs.ts),
 * keeping one that depends on a credential only when the job asks for that credential.
 */
export function declarationsFor(job: Pick<MatchView['job'], 'pack' | 'requiredCredential'> | undefined): PackDeclaration[] {
  const pack = getPack(job?.pack);
  const own = pack ? pack.declarations.filter((d) => !d.requiresCredential || d.requiresCredential === job?.requiredCredential) : GENERIC;
  return [...own, ALWAYS];
}

/** The ids recorded through POST /applications/:id/confirm. The confirmation is recorded; no answer is. */
export const declarationField = (id: string) => `declaration:${id}`;
export const STATEMENT_FIELD = 'statement';
export const ALL_FIELDS_CHECKED = 'review:all-fields-checked';
