import type { Blocker } from './types';
import { isVisible } from './scan';

/**
 * Things the agent refuses to work around. When one is present the agent does nothing
 * at all on the page and tells the user. There is no CAPTCHA solving, no proxying and
 * no attempt to look less like automation anywhere in this codebase.
 */
const CAPTCHA_SELECTOR = [
  'iframe[src*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="challenges.cloudflare.com" i]',
  'iframe[src*="captcha" i]',
  'iframe[title*="captcha" i]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '[data-sitekey]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  'input[name*="captcha" i]',
  'img[alt*="captcha" i]',
].join(',');

export function detectBlockers(doc: Document): Blocker[] {
  const blockers: Blocker[] = [];
  if (doc.querySelector(CAPTCHA_SELECTOR)) blockers.push('captcha');

  // Login wall: a visible password box in a form that has almost nothing else to fill.
  for (const pw of Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="password"]'))) {
    if (!isVisible(pw)) continue;
    const scope: ParentNode = pw.form ?? doc;
    const others = Array.from(scope.querySelectorAll<HTMLElement>('input, textarea, select')).filter((el) => {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      return el !== pw && !['password', 'hidden', 'submit', 'button', 'checkbox', 'reset', 'image'].includes(type) && isVisible(el);
    });
    if (others.length <= 2) {
      blockers.push('login-wall');
      break;
    }
  }
  return blockers;
}

export function blockerMessage(blockers: Blocker[]): string {
  const parts: string[] = [];
  if (blockers.includes('captcha')) parts.push('This page has a CAPTCHA. OpennJob does not solve or bypass CAPTCHAs.');
  if (blockers.includes('login-wall')) parts.push('This page is asking you to sign in. OpennJob never fills passwords.');
  return `${parts.join(' ')} Nothing was filled. Complete this step yourself, then scan the page again.`;
}
