import { describe, it, expect } from 'vitest';
import { joinPdfItems } from '../src/cv';
import type { PdfItem } from '../src/cv';

const item = (str: string, x: number, width: number, opts: Partial<PdfItem> = {}): PdfItem => ({ str, width, height: 12, transform: [1, 0, 0, 1, x, 700], ...opts });

describe('joinPdfItems: spaces come from the layout, not from gluing runs', () => {
  it('inserts a space where two runs sit apart (the headline gluing bug)', () => {
    const line = joinPdfItems([item('Senior Project Manager', 50, 100), item('Technical Director', 160, 80, { hasEOL: true })]);
    expect(line).toEqual(['Senior Project Manager Technical Director']);
  });

  it('does not split a word a run merely broke (no gap, no space)', () => {
    expect(joinPdfItems([item('Mana', 50, 20), item('ger', 70, 15, { hasEOL: true })])).toEqual(['Manager']);
  });

  it('does not double an existing space', () => {
    expect(joinPdfItems([item('Project ', 50, 40), item('Director', 95, 35, { hasEOL: true })])).toEqual(['Project Director']);
  });

  it('breaks lines on end-of-line runs', () => {
    expect(joinPdfItems([item('Line one', 50, 40, { hasEOL: true }), item('Line two', 50, 40, { hasEOL: true })])).toEqual(['Line one', 'Line two']);
  });
});
