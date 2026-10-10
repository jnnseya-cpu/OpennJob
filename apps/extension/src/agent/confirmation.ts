import { isVisible } from './scan';

/**
 * Reads the site's own confirmation that an application was received (APP-7). Only
 * visible text counts: a confirmation message hidden in the page before submitting is
 * not a confirmation. Returns undefined when none is seen; the caller then records the
 * application as "uncertain", never as submitted.
 */
const CONFIRMATION =
  /thank(s| you)[^.]{0,40}\bapplica|applica(tion|nt)[^.]{0,30}\b(received|submitted|sent|complete)|we (have|'ve) (received )?your applica|candidature[^.]{0,30}\b(re[çc]ue|envoy[ée]e|transmise|enregistr[ée]e)|merci pour votre candidature/i;

export interface Confirmation {
  pageUrl: string;
  text: string;
}

export function detectConfirmation(doc: Document): Confirmation | undefined {
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>('h1, h2, h3, p, div, section, main, [role="status"], [role="alert"]'));
  for (const el of candidates) {
    // The smallest element that carries the message: skip containers whose children carry it.
    if (Array.from(el.children).some((c) => CONFIRMATION.test(c.textContent ?? ''))) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 600 || !CONFIRMATION.test(text) || !isVisible(el)) continue;
    return { pageUrl: doc.location?.href ?? '', text };
  }
  return undefined;
}
