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
// A plain, text-only PDF of the tailored CV. No library: one font (Helvetica), A4, wrapped lines.
// ---------------------------------------------------------------------------------------

/** WinAnsi text for a PDF string: accents kept where Latin-1 has them, anything else replaced. */
function pdfText(s: string): string {
  const swaps: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '•': '-', '…': '...', ' ': ' ' };
  let out = '';
  for (const ch of s) {
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

/** The CV as PDF bytes (PDF 1.4, A4, Helvetica 9.5pt). */
export function cvPdf(cvText: string): Uint8Array {
  const lines = cvText.replace(/\r/g, '').split('\n').flatMap((l) => wrap(l.replace(/\t/g, '    '), 100));
  const perPage = 62;
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += perPage) pages.push(lines.slice(i, i + perPage));

  // Object numbers are index + 1: 1 catalog, 2 pages, 3 font, then a content and a page object per page.
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const kids: number[] = [];
  for (const page of pages) {
    const content = ['BT', '/F1 9.5 Tf', '12.5 TL', '50 800 Td', ...page.map((l) => `(${pdfText(l)}) '`), 'ET'].join('\n');
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const contentNo = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNo} 0 R >>`);
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
