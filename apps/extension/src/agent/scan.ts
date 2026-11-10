import { classifyField } from '@opennjob/core/browser';
import type { DetectedField, FieldKind } from './types';

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** Hidden, off-screen or inert controls (including honeypots) are never read or written. */
export function isVisible(el: HTMLElement): boolean {
  if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  if (el.getClientRects().length === 0) return false;
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  if (rect.right + view.scrollX < 0 || rect.bottom + view.scrollY < 0) return false;
  return true;
}

function ownLabel(el: Control): string {
  const doc = el.ownerDocument;
  const fromLabels = Array.from(el.labels ?? []).map((l) => clean(l.textContent)).filter(Boolean).join(' ');
  if (fromLabels) return fromLabels;
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const fromIds = labelledBy.map((id) => clean(doc.getElementById(id)?.textContent)).filter(Boolean).join(' ');
  if (fromIds) return fromIds;
  return clean(el.getAttribute('title')) || nearbyLabel(el);
}

/** Text that reads like a label: short, not just punctuation. */
const labelLike = (s: string): string => {
  const t = clean(s).replace(/\s*:\s*$/, '');
  return t.length >= 2 && t.length <= 120 && /[\p{L}]/u.test(t) ? t : '';
};

/**
 * Older application systems (the classic SAP SuccessFactors career portal, many in-house forms) write
 * the label as plain text next to the box instead of a <label> linked to it: in the table cell to its
 * left, or just before it. Used only when the box has no label of its own.
 */
function nearbyLabel(el: HTMLElement): string {
  const cell = el.closest('td, th');
  if (cell) {
    // The cell before this one in the same row, or (label above the box) the same column one row up.
    let prev = cell.previousElementSibling;
    while (prev && !labelLike(prev.textContent ?? '')) prev = prev.previousElementSibling;
    if (prev) return labelLike(prev.textContent ?? '');
    const row = cell.parentElement;
    const index = row ? Array.from(row.children).indexOf(cell) : -1;
    const above = row?.previousElementSibling?.children[index];
    if (above && !above.querySelector('input, select, textarea')) {
      const t = labelLike(above.textContent ?? '');
      if (t) return t;
    }
  }
  // Text just before the box among its siblings (a <span>, <b>, <div> or a bare text node).
  for (let node: Node | null = el.previousSibling, steps = 0; node && steps < 4; node = node.previousSibling, steps++) {
    if (node instanceof HTMLElement && node.querySelector('input, select, textarea')) break;
    if (node instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(node.tagName)) break;
    const t = labelLike(node.textContent ?? '');
    if (t) return t;
  }
  // The box's own container, when it holds only this box and a few words.
  const parent = el.parentElement;
  if (parent && parent.querySelectorAll('input, select, textarea').length === 1) return labelLike(parent.textContent ?? '');
  return '';
}

/** Legend of the enclosing fieldset (for a radio group this is the question itself). */
function legendOf(el: HTMLElement): string {
  return clean(el.closest('fieldset')?.querySelector('legend')?.textContent);
}

/** Heading of the enclosing section, e.g. "Declarations" or "Referees". */
function sectionHeading(el: HTMLElement): string {
  const section = el.closest('section, [role="group"], [role="region"]');
  if (!section) return '';
  return clean(section.getAttribute('aria-label')) || clean(section.querySelector('h1, h2, h3, h4, h5, h6')?.textContent);
}

function kindOf(el: Control): FieldKind {
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'select';
  const type = el.type.toLowerCase();
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  return 'text';
}

/** Finds every visible, enabled, fillable control and classifies it. Password fields are never returned. */
export function scanFields(doc: Document): DetectedField[] {
  const fields: DetectedField[] = [];
  const usedIds = new Set<string>();
  const radioGroups = new Map<string, DetectedField>();
  const uniqueId = (base: string): string => {
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}#${n}`;
    usedIds.add(id);
    return id;
  };

  const controls = Array.from(doc.querySelectorAll<Control>('input, textarea, select'));
  const forms = Array.from(doc.forms);
  const formIndex = (form: HTMLFormElement | null): number => (form ? forms.indexOf(form) : -1);
  controls.forEach((el, index) => {
    if (el.disabled || (el as HTMLInputElement).readOnly) return;
    const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : '';
    const tag = el.tagName.toLowerCase();
    const kind = kindOf(el);
    const legend = legendOf(el);
    const heading = sectionHeading(el);

    if (kind === 'radio') {
      const name = el.getAttribute('name') ?? '';
      const groupKey = `${formIndex(el.form)}|${name || `anon-${index}`}`;
      const existing = radioGroups.get(groupKey);
      if (existing) {
        if (isVisible(el)) existing.elements.push(el);
        if ((el as HTMLInputElement).required) existing.required = true;
        return;
      }
      if (!isVisible(el)) return;
      const question = legend || ownLabel(el);
      const c = classifyField({ label: question, name, type: 'radio', tag, groupLabel: heading });
      if (c.ignore) return;
      const field: DetectedField = {
        id: uniqueId(name ? `radio:${name}` : `radio-${index}`),
        label: question || name || 'Unlabelled choice',
        kind,
        sensitive: c.sensitive,
        category: c.category,
        key: c.key,
        ...(c.country ? { country: c.country } : {}),
        required: (el as HTMLInputElement).required,
        elements: [el],
      };
      radioGroups.set(groupKey, field);
      fields.push(field);
      return;
    }

    const label = ownLabel(el);
    const descriptor = {
      label,
      name: el.getAttribute('name') ?? '',
      id: el.id,
      placeholder: el.getAttribute('placeholder') ?? '',
      autocomplete: el.getAttribute('autocomplete') ?? '',
      type,
      tag,
      groupLabel: clean(`${legend} ${heading}`),
    };
    const c = classifyField(descriptor);
    if (c.ignore) return; // passwords, hidden inputs, file inputs, buttons
    if (!isVisible(el)) return;
    fields.push({
      id: uniqueId(el.id || (descriptor.name ? `name:${descriptor.name}` : `field-${index}`)),
      label: label || descriptor.placeholder || descriptor.name || 'Unlabelled field',
      kind,
      sensitive: c.sensitive,
      category: c.category,
      key: c.key,
      ...(c.country ? { country: c.country } : {}),
      required: el.required || el.getAttribute('aria-required') === 'true',
      elements: [el],
    });
  });
  scanListboxes(doc, fields, uniqueId);
  return fields;
}

/** What a drop-down button shows before anything is chosen. */
const LISTBOX_PLACEHOLDER = /^(select one|select|select\.\.\.|choose|choose one|please select|please choose|--.*--|)$/i;

function listboxLabel(el: HTMLElement): string {
  const doc = el.ownerDocument;
  const fieldBox = el.closest('[data-automation-id^="formField"], .field, [class*="formField"]');
  const fromBox = clean(fieldBox?.querySelector('label, legend')?.textContent);
  if (fromBox) return fromBox.replace(/\*\s*$/, '').trim();
  const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const fromIds = labelledBy.map((id) => clean(doc.getElementById(id)?.textContent)).filter(Boolean).join(' ');
  if (fromIds) return fromIds;
  if (el.id) {
    const forLabel = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (forLabel) return clean(forLabel.textContent);
  }
  return clean(el.getAttribute('aria-label'));
}

/** Drop-downs built from a button and a list of options (Workday and other single-page apps). */
function scanListboxes(doc: Document, fields: DetectedField[], uniqueId: (base: string) => string): void {
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"], [role="combobox"][aria-haspopup="listbox"]'));
  buttons.forEach((el, index) => {
    if ((el as HTMLButtonElement).disabled || !isVisible(el)) return;
    const label = listboxLabel(el);
    const c = classifyField({ label, name: el.getAttribute('name') ?? '', id: el.id, type: 'select', tag: 'select', groupLabel: sectionHeading(el) });
    if (c.ignore) return;
    // A list of options is never one of the person's free-text details ("Phone Device Type" is not
    // the phone number): such a key is dropped, so the person's stored answer for the question is used.
    const FREE_TEXT = new Set(['firstName', 'lastName', 'fullName', 'email', 'phone', 'addressLine1', 'addressLine2', 'postcode', 'supportingStatement']);
    if (c.key && FREE_TEXT.has(c.key)) c.key = null;
    const box = el.closest('[data-automation-id^="formField"], .field, [class*="formField"]');
    const required = el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(clean(box?.querySelector('label, legend')?.textContent)) || /\brequired\b/i.test(el.getAttribute('aria-label') ?? '');
    fields.push({
      id: uniqueId(el.id || el.getAttribute('data-automation-id') || `listbox-${index}`),
      label: label || 'Unlabelled list',
      kind: 'listbox',
      sensitive: c.sensitive,
      category: c.category,
      key: c.key,
      ...(c.country ? { country: c.country } : {}),
      required,
      elements: [el],
    });
  });
}

/** The option a drop-down button shows as chosen, or '' when nothing is chosen. */
export function listboxValue(el: HTMLElement): string {
  const shown = clean(el.textContent);
  return LISTBOX_PLACEHOLDER.test(shown) ? '' : shown;
}

/** Does the control currently hold a value / selection? */
export function hasValue(field: DetectedField): boolean {
  const first = field.elements[0];
  switch (field.kind) {
    case 'checkbox':
      return (first as HTMLInputElement).checked;
    case 'radio':
      return field.elements.some((el) => (el as HTMLInputElement).checked);
    case 'listbox':
      return listboxValue(first as HTMLElement) !== '';
    default:
      return clean((first as Control).value) !== '';
  }
}
