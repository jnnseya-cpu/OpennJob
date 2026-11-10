import { describe, expect, it } from 'vitest';
import { advertReference, applicationEmail, coverLetterFileName, coverLetterPdf, coverLetterText, cvPdf, recruiterEmailIn } from '../src';

/** Applications by e-mail. Fictional people, recruiters and employers only. */
describe('the recruiter address in an advert', () => {
  it('takes the first address that is a person to apply to', () => {
    expect(recruiterEmailIn('Send your CV to Jane.Recruiter@Example.org today.')).toBe('jane.recruiter@example.org');
    expect(recruiterEmailIn('Questions: noreply@example.org. Apply: jobs@example-build.example.')).toBe('jobs@example-build.example');
  });

  it('ignores no-reply, privacy and job-board addresses, and image names', () => {
    expect(recruiterEmailIn('noreply@example.org, privacy@example.org, gdpr@example.org')).toBeUndefined();
    expect(recruiterEmailIn('Apply via apply@reed.co.uk or support@adzuna.co.uk')).toBeUndefined();
    expect(recruiterEmailIn('logo@2x.png')).toBeUndefined();
    expect(recruiterEmailIn('No address in this advert.')).toBeUndefined();
  });

  it('reads the job reference when the advert states one', () => {
    expect(advertReference('Senior Project Manager. Ref: SPM-2041. Leeds.')).toBe('SPM-2041');
    expect(advertReference('Job reference: 1887624')).toBe('1887624');
    expect(advertReference('A reference from your last employer is required')).toBeUndefined();
  });
});

describe('the message', () => {
  it('carries the statement, the contact details and a CV file name, and nothing else', () => {
    const m = applicationEmail(
      { title: 'Senior Project Manager', employer: 'Example Build (fictional)', description: 'Ref: SPM-2041' },
      { firstName: 'Sam', lastName: 'Example', email: 'sam.example@example.org', phone: '07700 900222' },
      'I led multidisciplinary teams on a hospital new build.',
    );
    expect(m.subject).toBe('Application: Senior Project Manager (ref SPM-2041) - Sam Example');
    expect(m.text).toContain('I led multidisciplinary teams on a hospital new build.');
    expect(m.text).toContain('07700 900222 | sam.example@example.org');
    expect(m.text).not.toMatch(/right to work|sponsor|conviction|declare/i);
    expect(m.cvFileName).toBe('Sam_Example_CV.pdf');
  });
});

describe('the CV as a PDF', () => {
  it('is a well-formed PDF whose cross-reference offsets point at each object', () => {
    const cv = ['Sam Example (fictional)', 'Senior Project Manager — major projects (Leeds)', 'Gérant de projet; brackets (like this) and a back\\slash.', ...Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`)].join('\n');
    const bytes = cvPdf(cv);
    const pdf = Buffer.from(bytes).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('/Count 2'); // 83 lines: two pages
    const xrefAt = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const offsets = [...pdf.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(pdf).toContain('/F2 16 Tf 50 '); // the name, large and bold
    expect(pdf).toContain('(Sam Example \\(fictional\\)) Tj');
    expect(pdf).toContain('G\\351rant'); // é in WinAnsi
    expect([...bytes].every((b) => b < 128)).toBe(true);
  });
});

describe('headings, bullets and the cover letter', () => {
  it('sets headings in bold and turns "- " into a bullet', () => {
    const pdf = Buffer.from(cvPdf('Sam Example (fictional)\nPROFESSIONAL EXPERIENCE\n- Led a hospital new build')).toString('latin1');
    expect(pdf).toContain('/F2 10.5 Tf 50');
    expect(pdf).toContain('(PROFESSIONAL EXPERIENCE) Tj');
    expect(pdf).toContain('(\\225  Led a hospital new build) Tj');
  });

  it('the cover letter is the statement as a dated, signed letter, adding nothing else', () => {
    const profile = { firstName: 'Sam', lastName: 'Example', email: 'sam.example@example.org', phone: '07700 900222' };
    const letter = coverLetterText('I led multidisciplinary teams on a hospital new build.', profile, { title: 'Senior Project Manager', employer: 'Example Build (fictional)' }, new Date('2026-10-06T09:00:00Z'));
    expect(letter.split('\n')).toEqual([
      'Sam Example',
      '07700 900222 | sam.example@example.org',
      '',
      '6 October 2026',
      '',
      'Re: Senior Project Manager, Example Build (fictional)',
      '',
      'Dear Hiring Manager,',
      '',
      'I led multidisciplinary teams on a hospital new build.',
      '',
      'Yours sincerely,',
      '',
      'Sam Example',
    ]);
    // A statement that already opens and signs off is not wrapped twice.
    const own = coverLetterText('Dear Ms Example,\nI led teams.\nKind regards,\nSam', profile, { title: 'PM', employer: '' }, new Date('2026-10-06T09:00:00Z'));
    expect(own.match(/Dear/g)).toHaveLength(1);
    expect(own).not.toContain('Yours sincerely');
    expect(Buffer.from(coverLetterPdf(letter)).toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    expect(coverLetterFileName(profile)).toBe('Sam_Example_Cover_Letter.pdf');
  });
});
