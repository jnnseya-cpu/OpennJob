import type { FillValue } from '@opennjob/core/browser';
import type { DetectedField } from './types';

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const YES = new Set(['yes', 'y', 'true', '1', 'on']);
const NO = new Set(['no', 'n', 'false', '0', 'off']);

/** Writes through the native setter so frameworks that wrap `value` (React etc.) see the change. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fireInputEvents(el: HTMLElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('blur'));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

function choiceMatches(candidate: string, value: FillValue): boolean {
  const c = norm(candidate);
  if (typeof value === 'boolean') return value ? YES.has(c) : NO.has(c);
  return c !== '' && c === norm(value);
}

export interface FillOutcome {
  filled: boolean;
  reason?: string;
}

/**
 * Writes one value into one field and fires input/change/blur events.
 * Never overwrites something the user has already typed or chosen.
 */
export function fillField(field: DetectedField, value: FillValue): FillOutcome {
  const first = field.elements[0];
  if (!first) return { filled: false, reason: 'field is no longer on the page' };

  switch (field.kind) {
    case 'text':
    case 'textarea': {
      const el = first as HTMLInputElement | HTMLTextAreaElement;
      if (typeof value !== 'string') return { filled: false, reason: 'no text value for this field' };
      if (el.value === value) return { filled: true };
      if (el.value.trim() !== '') return { filled: false, reason: 'already has a value; left as it is' };
      if (el.maxLength > 0 && value.length > el.maxLength) {
        return { filled: false, reason: `the text is ${value.length} characters but this field allows ${el.maxLength}` };
      }
      el.focus();
      setNativeValue(el, value);
      fireInputEvents(el);
      // Some inputs (type=date, type=number, pattern masks) silently reject values they cannot parse.
      if (el.value !== value) return { filled: false, reason: 'the page did not accept this value' };
      return { filled: true };
    }
    case 'select': {
      const el = first as HTMLSelectElement;
      const option = Array.from(el.options).find((o) => !o.disabled && (choiceMatches(o.value, value) || choiceMatches(o.textContent ?? '', value)));
      if (!option) return { filled: false, reason: 'no matching option in this list' };
      if (el.value === option.value) return { filled: true };
      if (el.selectedIndex > 0 && el.value !== '') return { filled: false, reason: 'already has a selection; left as it is' };
      el.focus();
      setNativeValue(el, option.value);
      fireInputEvents(el);
      return { filled: true };
    }
    case 'checkbox': {
      const el = first as HTMLInputElement;
      if (typeof value !== 'boolean') return { filled: false, reason: 'no yes/no value for this tick box' };
      // Only ever ticks a box. Never unticks one the user ticked.
      if (value && !el.checked) el.click(); // click() fires the page's own click/input/change handlers
      return value ? { filled: el.checked } : { filled: false, reason: 'stored answer is "no"; box left unticked' };
    }
    case 'radio': {
      const radios = field.elements as HTMLInputElement[];
      if (radios.some((r) => r.checked)) {
        const current = radios.find((r) => r.checked) as HTMLInputElement;
        const same = choiceMatches(current.value, value) || choiceMatches(current.labels?.[0]?.textContent ?? '', value);
        return same ? { filled: true } : { filled: false, reason: 'already answered; left as it is' };
      }
      const target = radios.find((r) => !r.disabled && (choiceMatches(r.value, value) || choiceMatches(r.labels?.[0]?.textContent ?? '', value)));
      if (!target) return { filled: false, reason: 'no matching option' };
      target.click();
      return { filled: target.checked };
    }
  }
}
