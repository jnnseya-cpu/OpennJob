/**
 * CV upload (PRO-1): a PDF or Word file becomes plain text that the person sees and edits before
 * anything uses it. The file itself is not stored, and nothing is saved until the person saves
 * the profile. Suggested profile details (name, e-mail, phone, postcode, city) are found by
 * simple patterns and shown as suggestions only; the person confirms them.
 */

export const CV_MAX_BYTES = 5 * 1024 * 1024;
/** The most pages of a PDF CV that are read. */
export const CV_MAX_PAGES = 30;
export const CV_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

export class CvError extends Error {}

export interface CvExtraction {
  text: string;
  format: 'pdf' | 'docx';
  pages?: number;
  warnings: string[];
  suggestions: { firstName?: string; lastName?: string; email?: string; phone?: string; postcode?: string; city?: string };
}

// Keeps a real dynamic import(): tsc would otherwise turn it into require(), which cannot load an ES module.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

function formatOf(bytes: Buffer, contentType: string): 'pdf' | 'docx' {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && contentType.includes('wordprocessingml')) return 'docx';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'docx';
  throw new CvError('Upload a PDF or a Word (.docx) file');
}

async function loadPdfjs(): Promise<unknown> {
  try {
    return await importModule('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    // Under the test runner (a VM context) the Function-made import is not available; its own import is.
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
}

async function pdfText(bytes: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = (await loadPdfjs()) as {
    getDocument(o: { data: Uint8Array; isEvalSupported: boolean; useSystemFonts: boolean; disableFontFace: boolean; verbosity: number }): { promise: Promise<PdfDoc> };
  };
  interface PdfDoc {
    numPages: number;
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }> }>;
    destroy(): Promise<void>;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const lines: string[] = [];
  try {
    // A CV is a few pages: at most CV_MAX_PAGES are read, so a crafted file cannot tie up the server.
    for (let n = 1; n <= Math.min(doc.numPages, CV_MAX_PAGES); n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items) {
        line += item.str ?? '';
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      lines.push('');
    }
  } finally {
    await doc.destroy();
  }
  return { text: lines.join('\n'), pages: doc.numPages };
}

async function docxText(bytes: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as { extractRawText(o: { buffer: Buffer }): Promise<{ value: string }> };
  return (await mammoth.extractRawText({ buffer: bytes })).value;
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function suggestDetails(text: string): CvExtraction['suggestions'] {
  const out: CvExtraction['suggestions'] = {};
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text);
  if (email) out.email = email[0];
  const phone = /(?:\+44\s?7\d{3}|\(?07\d{3}\)?)\s?\d{3}\s?\d{3}/.exec(text);
  if (phone) out.phone = phone[0].replace(/\s+/g, ' ').trim();
  const postcode = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/.exec(text);
  if (postcode) out.postcode = `${postcode[1]} ${postcode[2]}`;
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (first && /^[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){1,3}$/.test(first) && first.length <= 60) {
    const parts = first.split(/\s+/);
    out.firstName = parts[0];
    out.lastName = parts.slice(1).join(' ');
  }
  return out;
}

export async function extractCv(bytes: Buffer, contentType: string): Promise<CvExtraction> {
  if (bytes.length === 0) throw new CvError('The file is empty');
  if (bytes.length > CV_MAX_BYTES) throw new CvError('The file is larger than 5 MB');
  const format = formatOf(bytes, contentType);
  const warnings: string[] = [];
  let text: string;
  let pages: number | undefined;
  try {
    if (format === 'pdf') {
      const r = await pdfText(bytes);
      text = r.text;
      pages = r.pages;
    } else {
      text = await docxText(bytes);
    }
  } catch {
    throw new CvError(`The ${format === 'pdf' ? 'PDF' : 'Word file'} could not be read. Paste the CV text instead.`);
  }
  text = tidy(text);
  if (text.length < 50) {
    warnings.push(format === 'pdf' ? 'Very little text was found. A scanned PDF has no text to read: paste the CV text instead.' : 'Very little text was found.');
  }
  warnings.push('Check every line before saving: conversion can drop columns, tables and symbols.');
  return { text, format, ...(pages !== undefined ? { pages } : {}), warnings, suggestions: suggestDetails(text) };
}
