import { isVisible } from './scan';

/**
 * Multi-step application systems (Workday, SAP SuccessFactors, and any form split over pages).
 *
 * A step is one page (or one screen of a single-page app) of an application. On each step the
 * agent fills what it may, and then exactly one of these happens:
 *   - a start control ("Apply", "Apply Manually") opens the application: it is pressed;
 *   - a next control ("Save and Continue", "Next") leads to the next step: it is pressed only when
 *     the step has no sensitive field (other than right to work answered from the person's record),
 *     no empty required field and no required file (canAdvance in agent.ts);
 *   - a submit control ends the application: it is pressed only after the API's go, under the same
 *     policy as every other form, judged over the fields of every step together.
 *
 * The systems are recognised by the page, not the address, so a career site on an employer's own
 * domain is recognised too. Workday marks its controls with data-automation-id; the names below
 * are as remembered from Workday's career sites and are NOT verified against a live site (the
 * supervised test submission that enables each system is that check).
 */

export type Flow = 'workday' | 'successfactors' | 'generic';

export interface StepControls {
  flow: Flow;
  start?: HTMLElement;
  next?: HTMLElement;
  submit?: HTMLElement;
}

const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const START = /^(apply|apply now|apply for this job|apply for job|apply manually|apply to job|start application|start your application)$/i;
const NEXT = /^(save and continue|save & continue|next|continue|next step|save and next)$/i;
const SUBMIT = /^(submit|submit application|submit my application|submit your application|send application|send my application|complete application|finish and submit)$/i;

function clickables(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>('button, a[role="button"], a[href], input[type="submit"], input[type="button"], [role="button"]')).filter(
    (el) => isVisible(el) && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true',
  );
}
const labelOf = (el: HTMLElement): string => (el instanceof HTMLInputElement ? el.value : text(el)) || (el.getAttribute('aria-label') ?? '');
const only = (els: HTMLElement[]): HTMLElement | undefined => (els.length === 1 ? els[0] : undefined);

/** A label that means "go to the next step", so a form button with it is not a final submit. */
export const isNextLabel = (label: string): boolean => NEXT.test(label.replace(/\s+/g, ' ').trim());

export function flowOf(doc: Document): Flow {
  if (doc.querySelector('[data-automation-id="bottom-navigation-next-button"], [data-automation-id="applyManually"], [data-automation-id="adventureButton"], [data-automation-id="progressBar"]')) return 'workday';
  if (doc.querySelector('[data-careersite-propertyid], .careersite-content, form[id^="fbclc_"], [id^="fbclc_"], meta[name="keywords"][content*="SuccessFactors" i]')) return 'successfactors';
  return 'generic';
}

/**
 * The start, next and submit controls on this step. Each is returned only when there is exactly
 * one: two candidate buttons are too ambiguous to press.
 */
export function stepControls(doc: Document): StepControls {
  const flow = flowOf(doc);
  const all = clickables(doc);
  if (flow === 'workday') {
    const nav = all.filter((el) => el.getAttribute('data-automation-id') === 'bottom-navigation-next-button');
    const navButton = only(nav);
    const byId = (id: string) => only(all.filter((el) => el.getAttribute('data-automation-id') === id));
    // "Apply Manually" (fill the form) rather than "Autofill with Resume" or "Use My Last Application".
    const start = byId('applyManually') ?? byId('adventureButton');
    if (navButton) return SUBMIT.test(labelOf(navButton)) ? { flow, submit: navButton } : { flow, next: navButton };
    return start ? { flow, start } : { flow };
  }
  const submit = only(all.filter((el) => SUBMIT.test(labelOf(el))));
  const next = only(all.filter((el) => NEXT.test(labelOf(el))));
  const start = only(all.filter((el) => START.test(labelOf(el))));
  if (submit) return { flow, submit };
  if (next) return { flow, next };
  return start ? { flow, start } : { flow };
}

/** What identifies the step on screen, to tell whether pressing next moved anything. */
export function stepSignature(doc: Document): string {
  const heading = Array.from(doc.querySelectorAll('h1, h2, h3, [data-automation-id="pageHeader"]'))
    .filter((h) => isVisible(h as HTMLElement))
    .map(text)
    .join('|');
  const inputs = Array.from(doc.querySelectorAll('input, select, textarea, button[aria-haspopup="listbox"]'))
    .filter((el) => isVisible(el as HTMLElement))
    .map((el) => el.id || el.getAttribute('name') || el.getAttribute('data-automation-id') || el.tagName)
    .join(',');
  return `${doc.location?.href ?? ''}#${heading}#${inputs}`;
}

/** Messages the page shows when a step was refused (missing or invalid answers). */
export function stepErrors(doc: Document): string[] {
  return Array.from(doc.querySelectorAll<HTMLElement>('[data-automation-id="errorMessage"], [data-automation-id="inputAlert"], [role="alert"], .error-message, .errorMessage'))
    .filter(isVisible)
    .map(text)
    .filter(Boolean)
    .slice(0, 5);
}
