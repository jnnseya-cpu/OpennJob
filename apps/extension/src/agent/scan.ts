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
  return clean(el.getAttribute('title'));
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
      required: el.required || el.getAttribute('aria-required') === 'true',
      elements: [el],
    });
  });
  return fields;
}

/** Does the control currently hold a value / selection? */
export function hasValue(field: DetectedField): boolean {
  const first = field.elements[0];
  switch (field.kind) {
    case 'checkbox':
      return (first as HTMLInputElement).checked;
    case 'radio':
      return field.elements.some((el) => (el as HTMLInputElement).checked);
    default:
      return clean((first as Control).value) !== '';
  }
}
