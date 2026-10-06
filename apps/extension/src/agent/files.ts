import { coverLetterPdf, cvPdf } from '@opennjob/core/browser';

/**
 * Attaching the CV and the cover letter. A file field whose label (or name, id or nearby text) says
 * CV, résumé or curriculum vitae gets the person's CV tailored to the advert, as a PDF; a field that
 * asks for a cover letter gets the application's cover letter (the drafted statement as a letter).
 * Nothing else is ever attached: a certificate, passport, transcript or any other document field is
 * left for the person, and a required one keeps the form waiting.
 */

export interface CvAttachment {
  /** File name shown to the employer, e.g. "Sam_Example_CV.pdf". */
  fileName: string;
  /** The tailored CV text the PDF is made from. */
  text: string;
}

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const CV_WORDS = /\b(cv|c\.v\.?|resume|résumé|curriculum vitae)\b/i;
const OTHER_DOCUMENT = /cover|motivation|lettre|certificate|passport|licen[cs]e|transcript|portfolio|photo|id\b|identity|proof|evidence|right to work|visa/i;

/** The text that describes a file field: its labels, aria, name, id and the text just around it. */
function describe(input: HTMLInputElement): string {
  const doc = input.ownerDocument;
  const labels = Array.from(input.labels ?? []).map((l) => clean(l.textContent));
  const labelledBy = (input.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => clean(doc.getElementById(id)?.textContent));
  const around = clean(input.closest('label, .field, [class*="field"], [class*="upload"], div')?.textContent).slice(0, 160);
  return [...labels, ...labelledBy, clean(input.getAttribute('aria-label')), input.name, input.id, around].join(' | ');
}

/** Is this file field asking for a CV, and only a CV? */
export function isCvField(input: HTMLInputElement): boolean {
  const text = describe(input);
  if (!CV_WORDS.test(text)) return false;
  // "CV or cover letter" style fields are fine; a field that is about another document is not.
  const own = [...Array.from(input.labels ?? []).map((l) => clean(l.textContent)), clean(input.getAttribute('aria-label')), input.name, input.id].join(' ');
  if (OTHER_DOCUMENT.test(own) && !CV_WORDS.test(own)) return false;
  const accept = (input.accept ?? '').toLowerCase();
  if (accept && !/pdf|application\/\*|\*\/\*|\.pdf/.test(accept)) return false;
  return true;
}

const COVER_WORDS = /cover(ing)?[\s_-]*letter|motivation(al)?[\s_-]*letter|lettre de motivation|\bcover\b/i;

/** Is this file field asking for a cover letter (and not a CV)? */
export function isCoverLetterField(input: HTMLInputElement): boolean {
  if (isCvField(input)) return false;
  const own = [...Array.from(input.labels ?? []).map((l) => clean(l.textContent)), clean(input.getAttribute('aria-label')), input.name, input.id].join(' ');
  const text = own.trim() ? own : describe(input);
  if (!COVER_WORDS.test(text)) return false;
  const accept = (input.accept ?? '').toLowerCase();
  return !accept || /pdf|application\/\*|\*\/\*|\.pdf/.test(accept);
}

/** File fields the agent may consider: in the document, not in a hidden or inert region, enabled. */
function fileInputs(doc: Document): HTMLInputElement[] {
  return Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((i) => !i.disabled && !i.closest('[hidden], [aria-hidden="true"], [inert]'));
}

function attach(doc: Document, input: HTMLInputElement, bytes: Uint8Array, fileName: string): boolean {
  const view = doc.defaultView;
  if (!view) return false;
  const file = new view.File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], fileName, { type: 'application/pdf' });
  const transfer = new view.DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new view.Event('input', { bubbles: true }));
  input.dispatchEvent(new view.Event('change', { bubbles: true }));
  return (input.files?.length ?? 0) > 0;
}

/**
 * Attaches the CV to every empty CV field. Returns how many were attached. Never replaces a file
 * the person chose, and never touches any other file field.
 */
export function attachCv(doc: Document, cv: CvAttachment): number {
  let attached = 0;
  for (const input of fileInputs(doc)) {
    if (!isCvField(input) || (input.files?.length ?? 0) > 0) continue;
    if (attach(doc, input, cvPdf(cv.text), cv.fileName)) attached += 1;
  }
  return attached;
}

/** Attaches the cover letter to every empty cover-letter field. Returns how many were attached. */
export function attachCoverLetter(doc: Document, letter: CvAttachment): number {
  let attached = 0;
  for (const input of fileInputs(doc)) {
    if (!isCoverLetterField(input) || (input.files?.length ?? 0) > 0) continue;
    if (attach(doc, input, coverLetterPdf(letter.text), letter.fileName)) attached += 1;
  }
  return attached;
}

/** Required file fields still empty, and all file fields. A required empty one keeps the form waiting. */
export function countFileInputs(doc: Document): { required: number; total: number } {
  const inputs = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  return {
    required: inputs.filter((i) => (i.required || i.getAttribute('aria-required') === 'true') && (i.files?.length ?? 0) === 0).length,
    total: inputs.length,
  };
}
