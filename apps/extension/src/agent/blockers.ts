import type { Blocker } from './types';
import { isVisible } from './scan';

/**
 * Things the agent refuses to work around. When one is present the agent does nothing
 * at all on the page and tells the user. There is no CAPTCHA solving, no proxying and
 * no attempt to look less like automation anywhere in this codebase.
 *
 * A CAPTCHA here is one the person can see: a tick box, a picture puzzle, a Cloudflare check, a
 * typed-letters box. Google's invisible reCAPTCHA (the small badge and its hidden parts, which show
 * no puzzle) does not stop the agent (owner's decision, 8 October 2026). It is not touched, hidden
 * or answered: the site's own check still runs, and if it then shows a puzzle the agent stops.
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

/** The invisible reCAPTCHA: its badge (and everything in it), or a widget or frame marked invisible. */
function invisibleKind(el: Element): boolean {
  if (el.closest('.grecaptcha-badge')) return true;
  if ((el.getAttribute('data-size') ?? '').toLowerCase() === 'invisible') return true;
  const src = el instanceof HTMLIFrameElement ? el.src : '';
  return /[?&]size=invisible\b/i.test(src);
}

/** A CAPTCHA the person can see on the page. */
export function hasVisibleCaptcha(doc: Document): boolean {
  return Array.from(doc.querySelectorAll<HTMLElement>(CAPTCHA_SELECTOR)).some((el) => !invisibleKind(el) && isVisible(el));
}

export function detectBlockers(doc: Document): Blocker[] {
  const blockers: Blocker[] = [];
  if (hasVisibleCaptcha(doc)) blockers.push('captcha');

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
