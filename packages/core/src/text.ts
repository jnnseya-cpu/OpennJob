/** Small text helpers shared by matching, statement drafting and interview scoring. */

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive keyword test.
 *
 * The keyword must start at a word boundary so that "RN" does not match "learn".
 * Keywords of 4+ characters may be followed by a suffix ("medication" matches "medications");
 * shorter keywords (acronyms such as "NMC", "HCA", "RN") must match as whole words.
 */
export function keywordRegExp(keyword: string): RegExp | null {
  const k = keyword.trim();
  if (!k) return null;
  const body = k.split(/\s+/).map(escapeRegExp).join('\\s+');
  const tail = k.length < 4 ? '(?![A-Za-z0-9])' : '';
  return new RegExp(`(?<![A-Za-z0-9])${body}${tail}`, 'i');
}

export function keywordInText(keyword: string, text: string): boolean {
  const re = keywordRegExp(keyword);
  return re ? re.test(text) : false;
}

/**
 * Splits text into sentences / bullet lines. Every returned sentence is a verbatim
 * substring of the input (only leading bullet markers and surrounding whitespace are dropped),
 * which is what lets the fallback statement drafter guarantee it never invents text.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n+/)) {
    for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)) {
      const s = part.replace(/^[\s\-*•–—·]+/, '').trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Pulls the first JSON object out of an LLM reply, tolerating code fences and prose around it. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
