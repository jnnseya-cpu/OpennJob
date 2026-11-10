import { describe, expect, it } from 'vitest';
import { splitSentences, unwrapLines } from '../src/text';

/** CVs converted from PDF break lines mid-sentence; sentences must come back whole. Fictional text. */
describe('lines broken mid-sentence', () => {
  it('joins a line that does not end a sentence with a next line in lower case', () => {
    expect(unwrapLines('Chartered manager leading teams through the full\nproject lifecycle on rail schemes.')).toBe('Chartered manager leading teams through the full project lifecycle on rail schemes.');
  });

  it('keeps headings, names, bullets and finished sentences on their own lines', () => {
    const cv = 'EXAMPLE PERSON (fictional)\nPROFESSIONAL PROFILE\nLed teams.\nCore skills:\n• Risk management\n• Programme control';
    expect(unwrapLines(cv)).toBe(cv);
  });

  it('splitSentences gives the whole sentence, not the first half', () => {
    expect(splitSentences('Led multidisciplinary teams through the full\nproject lifecycle. Delivered schools.')).toEqual(['Led multidisciplinary teams through the full project lifecycle.', 'Delivered schools.']);
  });
});
