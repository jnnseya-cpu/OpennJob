"""Application routes: what a form looks like, what on it is sensitive, and its certification (R12, B10).

A route is one employer application page (or one approved multi-step flow). reviewed=true is
not certification. A route is certified when its live form schema was recorded and hashed, its
uploads were checked, and a supervised run on it produced a job-correlated receipt. Automatic
submission additionally needs certification.auto_submit, which the operator can set only when
that supervised receipt exists in the ledger.

  python3 -m agent.routes schema   --adapter PATH          prints the live form schema and its hash
  python3 -m agent.routes certify  --adapter PATH --job ID --confirmed [--auto]
  python3 -m agent.routes status                          routes, failures, quarantine
  python3 -m agent.routes release  --route ID --confirmed  lift a quarantine after fixing the route
"""
import argparse, hashlib, json, re
from pathlib import Path
from . import paths
from .store import Store, now

# Words that make a form control a declaration or another question only the applicant answers.
SENSITIVE = re.compile(
    r'right[\s_-]*to[\s_-]*work|sponsor|visa|work[\s_-]*permit|immigration|authori[sz]ed? to work|nationality|citizenship|passport|'
    r'criminal|conviction|caution|offence|offense|police|clearance|vetting|\bdbs\b|barred|safeguard|conflict[\s_-]*of[\s_-]*interest|'
    r'disab|health|medical|gender|\bsex\b|ethnic|race\b|religio|belief|sexual|orientation|marital|pregnan|date[\s_-]*of[\s_-]*birth|\bage\b|'
    r'equal[\s_-]*opportunit|diversity|monitoring|declar|i[\s_-]*confirm|i[\s_-]*certify|i[\s_-]*consent|i[\s_-]*agree|terms|privacy|fitness[\s_-]*to[\s_-]*practi',
    re.I)

SCAN = """(form) => {
  const label = (el) => {
    let t = '';
    if (el.id) { const l = form.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) t = l.innerText; }
    if (!t) { const l = el.closest('label'); if (l) t = l.innerText; }
    if (!t) { const f = el.closest('fieldset'); const g = f && f.querySelector('legend'); if (g) t = g.innerText; }
    return [t, el.getAttribute('aria-label') || '', el.name || '', el.id || '', el.placeholder || ''].join(' ').replace(/\\s+/g, ' ').trim();
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  return Array.from(form.querySelectorAll('input, select, textarea'))
    .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((el.type || '').toLowerCase()))
    .map((el) => ({
      tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase(), name: el.name || '', id: el.id || '',
      required: el.required || el.getAttribute('aria-required') === 'true', label: label(el), visible: visible(el),
      options: el.tagName === 'SELECT' ? Array.from(el.options).map((o) => o.value) : [],
      default: el.type === 'checkbox' || el.type === 'radio' ? (el.defaultChecked ? 'checked' : '') : (el.tagName === 'SELECT' ? (Array.from(el.options).find((o) => o.defaultSelected)?.value || '') : (el.defaultValue || '')),
      value: el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'checked' : '') : el.type === 'file' ? String(el.files ? el.files.length : 0) : el.value,
    }));
}"""


def schema_hash(controls):
    """Stable fingerprint of the form: control kinds, names, ids, required flags and options. Values excluded."""
    shape = sorted((c['tag'], c['type'], c['name'], c['id'], bool(c['required']), tuple(c.get('options', []))) for c in controls)
    return hashlib.sha256(json.dumps(shape).encode()).hexdigest()


def is_sensitive(control):
    return bool(SENSITIVE.search(control.get('label', '') + ' ' + control.get('name', '') + ' ' + control.get('id', '')))


def matches(control, selector):
    sel = selector.strip()
    return (sel.startswith('#') and control['id'] == sel[1:]) or sel in (f'[name="{control["name"]}"]', f"[name='{control['name']}']")


def review_form(controls, adapter):
    """What on the live form stops automatic submission, as (sensitive, unknown_required, defaults).

    sensitive         every declaration and sensitive question (work rights included): the applicant answers
    unknown_required  required ordinary questions the route does not map: needs input, never guessed (T23)
    defaults          sensitive questions that already carry a pre-selected answer: never accepted (T24)
    """
    mapped = [f for f in adapter.get('fields', [])] + [{'selector': u['selector'], 'upload': True} for u in adapter.get('uploads', [])]
    sensitive, unknown, defaults = [], [], []
    for c in controls:
        field = next((f for f in mapped if matches(c, f['selector'])), None)
        declared = bool(field and (field.get('declaration') or field.get('source') == 'work_rights'))
        if declared or is_sensitive(c) or (c['type'] in ('checkbox', 'radio') and not (field and field.get('ordinary'))):
            sensitive.append(c['label'] or c['id'] or c['name'])
            if c['default']:
                defaults.append(c['label'] or c['id'] or c['name'])
            continue
        if c['required'] and not field and c['visible']:
            unknown.append(c['label'] or c['id'] or c['name'])
    return sensitive, unknown, defaults


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def certified(adapter):
    c = adapter.get('certification') or {}
    return bool(adapter.get('reviewed') and adapter.get('route_tested') and c.get('id') and c.get('form_schema_hash') and c.get('tested_at'))


def auto_certified(adapter):
    c = adapter.get('certification') or {}
    return certified(adapter) and c.get('auto_submit') is True and bool(c.get('supervised_receipt'))


def certify(adapter, controls, store, job_id=None, auto=False):
    """Records the certification. Automatic submission needs a supervised, adapter-verified receipt on this route."""
    record = {'id': 'cert-' + hashlib.sha256((adapter.get('id', '') + now()).encode()).hexdigest()[:12], 'form_schema_hash': schema_hash(controls),
              'tested_at': now(), 'controls': len(controls), 'uploads': [u['document'] for u in adapter.get('uploads', [])], 'auto_submit': False}
    if auto:
        app = store.application(job_id) if job_id else None
        if not app or app['status'] not in ('submitted', 'recruiter_reply', 'interview', 'rejected', 'offer') or app['payload'].get('receipt_kind') != 'adapter_verified':
            raise ValueError('Automatic submission needs one supervised submission on this route with an adapter-verified receipt')
        if app['payload'].get('adapter_id') != adapter.get('id'):
            raise ValueError('The supervised receipt is from another route')
        record.update(auto_submit=True, supervised_receipt={'job_id': job_id, 'receipt': app['payload']['receipt'][:300], 'at': app['payload'].get('submitted_at')})
    return adapter | {'certification': record}


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.routes')
    p.add_argument('action', choices=['schema', 'certify', 'status', 'release'])
    p.add_argument('--adapter'); p.add_argument('--job'); p.add_argument('--route'); p.add_argument('--auto', action='store_true'); p.add_argument('--confirmed', action='store_true')
    a = p.parse_args(argv); store = Store(paths.db_path())
    if a.action == 'status':
        for f in sorted(paths.sub('adapters').glob('*.json')):
            ad = load(f); r = store.route(ad.get('id', f.stem))
            print(f"{ad.get('id', f.stem)}: certified={certified(ad)} auto={auto_certified(ad)} failures={r['failures']} quarantined={bool(r['quarantined'])} {r.get('last_error') or ''}")
        return
    if a.action == 'release':
        if not a.route or not a.confirmed:
            raise SystemExit('release needs --route and --confirmed')
        store.release_route(a.route); print('Quarantine lifted for ' + a.route); return
    adapter = load(a.adapter)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True); page = browser.new_page()
        page.goto(adapter['exact_url'], wait_until='domcontentloaded')
        controls = page.locator(adapter['form_selector']).evaluate(SCAN)
        browser.close()
    if a.action == 'schema':
        print(json.dumps({'form_schema_hash': schema_hash(controls), 'controls': controls}, indent=2)); return
    if not a.confirmed:
        raise SystemExit('Check the schema first (schema), then certify with --confirmed')
    out = certify(adapter, controls, store, a.job, a.auto)
    Path(a.adapter).write_text(json.dumps(out, indent=2), encoding='utf-8')
    print('Certified: ' + out['certification']['id'] + (' (automatic submission allowed on forms with no sensitive question)' if a.auto else ''))


if __name__ == '__main__':
    main()
