/**
 * Interview preparation from what was actually sent (INT-1, spec T-18). Every question quotes the
 * advert and, where one exists, the line of the statement or tailored CV that answered it, word for
 * word. Nothing is invented: a criterion the documents did not address is marked as a gap, so the
 * person prepares for it rather than being told they covered it.
 */
import type { Criterion, SentDocuments } from './types';

export interface DocumentQuestion {
  id: string;
  criterion: string;
  essential: boolean;
  /** An exact sentence of the advert. Absent when no sentence of the advert names the criterion. */
  advertQuote?: string;
  /** An exact sentence of the documents sent, and which document. Absent means a gap. */
  documentQuote?: { document: 'statement' | 'tailoredCv'; text: string };
  question: string;
  lookFor: string[];
}

export interface DocumentInterview {
  applicationId: string;
  documentsSha256: SentDocuments['sha256'];
  questions: DocumentQuestion[];
  gaps: string[];
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

function mentions(sentence: string, keywords: readonly string[]): boolean {
  const lower = sentence.toLowerCase();
  return keywords.some((k) => k.trim().length > 0 && lower.includes(k.toLowerCase()));
}

export function interviewFromDocuments(
  applicationId: string,
  advert: { title: string; description: string; criteria: readonly Criterion[] },
  sent: SentDocuments,
  max = 8,
): DocumentInterview {
  const advertLines = sentences(advert.description);
  const docLines: Array<{ document: 'statement' | 'tailoredCv'; text: string }> = [
    ...sentences(sent.statement).map((text) => ({ document: 'statement' as const, text })),
    ...sentences(sent.tailoredCv).map((text) => ({ document: 'tailoredCv' as const, text })),
  ];
  const ordered = [...advert.criteria].sort((a, b) => Number(b.essential) - Number(a.essential));
  const questions: DocumentQuestion[] = [];
  const gaps: string[] = [];
  for (const [i, c] of ordered.slice(0, max).entries()) {
    const keys = [...c.keywords, c.label];
    const advertQuote = advertLines.find((s) => mentions(s, keys));
    const documentQuote = docLines.find((d) => mentions(d.text, keys));
    const which = documentQuote?.document === 'tailoredCv' ? 'your CV' : 'your statement';
    const question = documentQuote
      ? `The advert asks for ${c.label.toLowerCase()}. In ${which} you wrote: "${documentQuote.text}". Talk me through that example: the situation, what you did, and the result.`
      : `The advert asks for ${c.label.toLowerCase()}, and your documents did not cover it. Tell me about a time you showed it, or how you would.`;
    if (!documentQuote) gaps.push(c.label);
    questions.push({
      id: `doc-${i + 1}`,
      criterion: c.label,
      essential: c.essential,
      ...(advertQuote ? { advertQuote } : {}),
      ...(documentQuote ? { documentQuote } : {}),
      question,
      lookFor: c.keywords.slice(0, 5),
    });
  }
  return { applicationId, documentsSha256: sent.sha256, questions, gaps };
}
