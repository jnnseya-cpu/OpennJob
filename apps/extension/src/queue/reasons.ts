import type { RunReport } from '../agent/types';

/**
 * Why a filled page must wait for the person, as hold reasons the API stores:
 *   captcha, login-wall           the agent stops; it never works around them (rule 4)
 *   sensitive:<category>          a declaration or other sensitive field: never sent by the agent (rule 3, OD-1)
 *   question:<label>              a required ordinary question with no stored answer (SCR-2)
 *   file-upload                   a required file (CV) the agent does not attach
 *   no-submit-button              no single submit button to press
 * An empty list means the policy allows submitting this page.
 */
export function holdReasonsOf(report: RunReport): string[] {
  if (report.status === 'blocked') return [...report.blockers];
  const reasons: string[] = [];
  for (const f of report.fields) if (f.sensitive) reasons.push(`sensitive:${f.category ?? 'sensitive'}`);
  for (const f of report.fields) if (!f.sensitive && f.required && (f.state === 'no-data' || f.state === 'skipped')) reasons.push(`question:${f.label.slice(0, 280)}`);
  if ((report.fileInputs?.required ?? 0) > 0) reasons.push('file-upload');
  if (reasons.length === 0 && report.fields.length === 0) reasons.push('no-form');
  if (reasons.length === 0 && report.readyToSubmit !== true) reasons.push('no-submit-button');
  return [...new Set(reasons)];
}
