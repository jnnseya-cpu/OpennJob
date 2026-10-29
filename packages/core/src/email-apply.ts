import type { Job, Profile } from './types';

/**
 * Applying by e-mail: when an advert gives a recruiter's e-mail address, the application (the
 * tailored CV as a PDF and the supporting statement) can be sent there, under the person's standing
 * authorisation. There is no form, so no declaration is answered: an employer who wants one asks
 * for it later, and the person answers it then. Replies go to the person's own address.
 */

/** Addresses that are not a person to apply to. */
const NOT_A_RECRUITER = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|privacy|gdpr|dpo|data\.?protection|unsubscribe|abuse|webmaster|marketing|newsletter|complaints?|accounts?|invoices?|billing)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
/** Job boards' own addresses: an application sent there reaches nobody hiring. */
const BOARD_DOMAINS = /(^|\.)(reed\.co\.uk|adzuna\.(co\.uk|com)|indeed\.(co\.uk|com)|linkedin\.com|totaljobs\.com|cv-library\.co\.uk)$/i;

/** The first recruiter e-mail address in an advert, lower case, or undefined. */
export function recruiterEmailIn(text: string): string | undefined {
  for (const raw of text.match(EMAIL) ?? []) {
    const address = raw.replace(/\.+$/, '').toLowerCase();
    const [local = '', domain = ''] = address.split('@');
    if (NOT_A_RECRUITER.test(local) || BOARD_DOMAINS.test(domain)) continue;
    if (/\.(png|jpe?g|gif|svg|webp)$/i.test(address)) continue;
    return address;
  }
  return undefined;
}

/** The job's reference in the advert, if it states one ("Ref: ABC123", "Job reference 1887624"). */
export function advertReference(text: string): string | undefined {
  const m = /\b(?:job\s+)?ref(?:erence)?(?:\s+(?:no|number))?\s*[:#.]\s*([A-Z0-9][A-Z0-9/_-]{2,24})\b/i.exec(text);
  return m?.[1];
}

export interface ApplicationEmail {
  subject: string;
  text: string;
  /** File name of the attached CV. */
  cvFileName: string;
}

/** The message sent to the recruiter: the statement, contact details and the CV, nothing else. */
export function applicationEmail(job: Pick<Job, 'title' | 'employer' | 'description'>, profile: Pick<Profile, 'firstName' | 'lastName' | 'email' | 'phone'>, statement: string): ApplicationEmail {
  const name = `${profile.firstName} ${profile.lastName}`.trim();
  const ref = advertReference(job.description);
  const subject = `Application: ${job.title}${ref ? ` (ref ${ref})` : ''} - ${name}`;
  const text = [
    'Dear Hiring Team,',
    '',
    `Please find my application for the ${job.title} role${job.employer ? ` with ${job.employer}` : ''}. My CV is attached.`,
    '',
    statement.trim(),
    '',
    'Kind regards,',
    name,
    [profile.phone, profile.email].filter(Boolean).join(' | '),
  ].join('\n');
  const safe = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'CV';
  return { subject, text, cvFileName: `${safe}_CV.pdf` };
}

// ---------------------------------------------------------------------------------------
// PDFs of the tailored CV and the cover letter. No library: Helvetica and Helvetica-Bold, A4.
// The CV's first line (the name) is large and bold, section headings bold, "- " bullets as "•".
// ---------------------------------------------------------------------------------------

/** WinAnsi text for a PDF string: accents kept where Latin-1 has them, anything else replaced. */
function pdfText(s: string): string {
  const swaps: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ' };
  let out = '';
  for (const ch of s) {
    if (ch === '•') {
      out += '\\225'; // WinAnsi bullet
      continue;
    }
    for (const d of swaps[ch] ?? ch) {
      const code = d.charCodeAt(0);
      if (d === '(' || d === ')' || d === '\\') out += `\\${d}`;
      else if (code >= 32 && code < 127) out += d;
      else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, '0')}`;
      else out += '?';
    }
  }
  return out;
}

function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(' ', width);
    const at = cut > width / 2 ? cut : width;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

interface StyledLine {
  text: string;
  bold: boolean;
  size: number;
  /** Space before the line, in points. */
  before: number;
}

/** A section heading: a short line in capitals, or a usual CV heading ("Professional Experience"). */
const HEADING = /^(?=.*\p{L})[\p{Lu}\p{N}\s&/,'-]{3,48}$|^(profile|summary|experience|education|skills|qualifications|certifications|languages|interests|references|key achievements|professional experience|work experience|employment history|core capabilities|key skills)$/u;

function layoutCv(cvText: string): StyledLine[] {
  const raw = cvText.replace(/\r/g, '').split('\n').map((l) => l.replace(/\t/g, '    ').trimEnd());
  const out: StyledLine[] = [];
  let first = true;
  for (const line of raw) {
    const t = line.trim();
    if (!t) {
      if (out.length) out.push({ text: '', bold: false, size: 6, before: 0 });
      continue;
    }
    if (first) {
      out.push({ text: t, bold: true, size: 16, before: 0 });
      first = false;
      continue;
    }
    if (HEADING.test(t.replace(/:$/, ''))) {
      out.push({ text: t.replace(/:$/, '').toUpperCase(), bold: true, size: 10.5, before: 8 });
      continue;
    }
    const bullet = /^[-*•]\s+/.test(t);
    const body = bullet ? `•  ${t.replace(/^[-*•]\s+/, '')}` : t;
    wrap(body, 98).forEach((part, i) => out.push({ text: i > 0 && bullet ? `    ${part}` : part, bold: false, size: 9.5, before: 0 }));
  }
  return out;
}

function layoutLetter(text: string): StyledLine[] {
  const out: StyledLine[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (!line.trim()) {
      out.push({ text: '', bold: false, size: 6, before: 0 });
      continue;
    }
    wrap(line.trim(), 92).forEach((part) => out.push({ text: part, bold: false, size: 10.5, before: 0 }));
  }
  return out;
}

function renderPdf(lines: StyledLine[]): Uint8Array {
  const top = 800;
  const bottom = 50;
  const pages: string[][] = [[]];
  let y = top;
  for (const l of lines.length ? lines : [{ text: '', bold: false, size: 9.5, before: 0 }]) {
    const step = l.before + l.size * 1.32;
    if (y - step < bottom) {
      pages.push([]);
      y = top;
    }
    y -= step;
    (pages[pages.length - 1] as string[]).push(`BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf 50 ${y.toFixed(1)} Td (${pdfText(l.text)}) Tj ET`);
  }

  // Object numbers are index + 1: 1 catalog, 2 pages, 3 and 4 fonts, then a content and a page object per page.
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  const kids: number[] = [];
  for (const page of pages) {
    const content = page.join('\n');
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const contentNo = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character above is ASCII (pdfText escapes the rest), so one byte per character.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0x7f;
  return bytes;
}

/** The CV as PDF bytes: the name large, headings bold, bullets. */
export function cvPdf(cvText: string): Uint8Array {
  return renderPdf(layoutCv(cvText));
}

/** The cover letter: the supporting statement as a dated letter, signed with the person's name. */
export function coverLetterText(statement: string, profile: Pick<Profile, 'firstName' | 'lastName' | 'email' | 'phone'>, job: Pick<Job, 'title' | 'employer'>, date: Date): string {
  const name = `${profile.firstName} ${profile.lastName}`.trim();
  const body = statement.trim();
  const opens = /^(dear|to whom)/i.test(body);
  const closes = /(yours (sincerely|faithfully)|kind regards|best regards)[\s\S]{0,80}$/i.test(body);
  return [
    name,
    [profile.phone, profile.email].filter(Boolean).join(' | '),
    '',
    date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }),
    '',
    `Re: ${job.title}${job.employer ? `, ${job.employer}` : ''}`,
    '',
    ...(opens ? [] : ['Dear Hiring Manager,', '']),
    body,
    ...(closes ? [] : ['', 'Yours sincerely,', '', name]),
  ].join('\n');
}

export function coverLetterPdf(letter: string): Uint8Array {
  return renderPdf(layoutLetter(letter));
}

/** "Sam_Example_Cover_Letter.pdf" */
export function coverLetterFileName(profile: Pick<Profile, 'firstName' | 'lastName'>): string {
  const safe = `${profile.firstName} ${profile.lastName}`.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Cover';
  return `${safe}_Cover_Letter.pdf`;
}
