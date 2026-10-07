import type { RunReport } from '../agent/types';

/**
 * Why a filled page must wait for the person, as hold reasons the API stores:
 *   captcha, login-wall           the agent stops; it never works around them (rule 4)
 *   sensitive:<category>          a declaration or other sensitive field: never sent by the agent (rule 3, OD-1)
 *   question:<label>              a required ordinary question with no stored answer (SCR-2)
 *   file-upload                   a required file (CV) the agent does not attach
 *   no-submit-button              no single submit button to press
 *   step-refused[:<message>]      a multi-step site did not move on after "Next" (its message, if any)
 *   steps-saved:<n>               added when it stopped part-way: n steps were saved on the site, tab left open
 *   too-many-steps                more steps than the queue goes through
 * An empty list means the policy allows submitting this page.
 */
export function holdReasonsOf(report: RunReport): string[] {
  if (report.status === 'blocked') return [...report.blockers];
  const reasons: string[] = [];
  // Right to work answered from the person's record (OD-5) is not a reason to hold; anything else sensitive is.
  for (const f of report.fields) if (f.sensitive && f.fromRecord !== true) reasons.push(`sensitive:${f.category ?? 'sensitive'}`);
  for (const f of report.fields) if ((!f.sensitive || f.fromRecord === true) && f.required && (f.state === 'no-data' || f.state === 'skipped')) reasons.push(`question:${f.label.slice(0, 280)}`);
  if ((report.fileInputs?.required ?? 0) > 0) reasons.push('file-upload');
  if (reasons.length === 0 && report.fields.length === 0) reasons.push('no-form');
  if (reasons.length === 0 && report.readyToSubmit !== true) reasons.push('no-submit-button');
  return [...new Set(reasons)];
}

/** Why a step of a multi-step application waits: the same reasons, without "no submit button" (it has a next one). */
export function stepHoldReasons(report: RunReport): string[] {
  const reasons = holdReasonsOf(report).filter((r) => r !== 'no-submit-button' && r !== 'no-form');
  return reasons.length > 0 ? reasons : ['step-waits'];
}
