"""Source coverage, measured rather than claimed (R27, B19; T51).

data/source_registry.json is the target list (20 to 50 relevant employers and boards for the
initial role families). An entry is used for discovery only once its board identifier is
verified and the site's terms allow automated reading; until then it is a target, nothing more.

matrix() reports, per market: registered targets, configured boards, verified boards, postings
found, postings at 80% or more, certified routes and receipts. It never says "worldwide" or
"every job board": coverage is what the ledger shows.

import_job() accepts a pasted job URL and description from the applicant, keeps where it came
from, and leaves it unverified until the worker matches the live posting at that URL.
"""
import json
from collections import defaultdict
from . import paths
from .contracts import safe_url, validate_job
from .identity import canonical_id
from .routes import certified
from .store import now


def registry():
    try:
        data = paths.read('source_registry.json')
    except FileNotFoundError:
        return []
    return data.get('sources', []) if isinstance(data, dict) else data


def matrix(store):
    reg = registry()
    boards = paths.read('boards.json')
    configured = {b['company'] for b in boards}
    health = {s['company']: s for s in store.sources()}
    adapters = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(paths.sub('adapters').glob('*.json'))]
    routes_by_url = {a.get('exact_url'): a for a in adapters}
    apps = {a['job_id']: a for a in store.applications()}
    rows = defaultdict(lambda: {'registered_targets': 0, 'configured_boards': 0, 'verified_boards': 0, 'postings': 0, 'eligible_80': 0, 'certified_routes': 0, 'receipts': 0})
    for entry in reg:
        for market in entry.get('markets', ['Unconfirmed']):
            rows[market]['registered_targets'] += 1
            if entry.get('company') in configured:
                rows[market]['configured_boards'] += 1
            if entry.get('board_verified') and entry.get('terms_checked'):
                rows[market]['verified_boards'] += 1
    from .scoring import eligible
    for j in store.jobs():
        m = rows[j.get('country') or 'Unconfirmed']; m['postings'] += 1
        try:
            if j.get('requirements') and eligible(j['requirements']):
                m['eligible_80'] += 1
        except ValueError:
            pass
        a = routes_by_url.get(j.get('url'))
        if a and certified(a):
            m['certified_routes'] += 1
        app = apps.get(j['id'])
        if app and app['payload'].get('receipt_kind') in ('adapter_verified', 'manually_reconciled'):
            m['receipts'] += 1
    return {'generated_at': now(), 'markets': dict(sorted(rows.items())),
            'sources': [{'company': b['company'], 'type': b['type'], 'last_ok': (health.get(b['company']) or {}).get('last_ok'),
                         'failures_in_a_row': (health.get(b['company']) or {}).get('consecutive_failures', 0)} for b in boards],
            'statement': 'Coverage is what this ledger shows for these sources. It is not whole-internet coverage and not a promise about any market.'}


def import_job(store, url, company, title, description, country=None):
    safe_url(url)
    if not description or len(description.strip()) < 40:
        raise ValueError('Paste the full job description')
    job = validate_job({'id': canonical_id(company, url), 'company': company, 'title': title, 'url': url, 'jd_url': url, 'description': description.strip(),
                        'country': country or 'Unconfirmed', 'source': 'import', 'fetched_at': now(), 'requirements': [], 'status': 'imported',
                        'live_verified': False, 'import_unverified': True, 'description_full': False,
                        'provenance': [{'source': 'import', 'url': url, 'fetched_at': now(), 'by': 'applicant'}]})
    return store.put_job(job)
