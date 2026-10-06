"""Canonical posting identity (R14, T09).

A posting is the employer plus its stable posting or requisition id where one exists;
otherwise its canonical URL. Tracking parameters, fragments, a trailing slash and letter
case in the host never create a new posting. Every original URL is kept in provenance.
"""
import hashlib
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TRACKING = ('utm_', 'gclid', 'fbclid', 'msclkid', 'mc_', 'ref', 'source', 'src', 'trk', 'campaign', 'gh_src', 'lever-source', 'lever-origin')


def canonical_url(url):
    if not url:
        return ''
    parts = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=False) if not k.lower().startswith(TRACKING)]
    path = parts.path.rstrip('/') or '/'
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, urlencode(sorted(query)), ''))


def company_key(company):
    return ' '.join((company or '').casefold().replace('&', ' and ').split())


def canonical_id(company, url, posting_id=None):
    basis = str(posting_id) if posting_id not in (None, '') else canonical_url(url).split('?')[0]
    return hashlib.sha256((company_key(company) + '|' + basis).encode()).hexdigest()[:24]


def same_posting(a, b):
    if company_key(a.get('company')) != company_key(b.get('company')):
        return False
    if a.get('posting_id') and b.get('posting_id'):
        return str(a['posting_id']) == str(b['posting_id'])
    urls_a = {canonical_url(u) for u in _urls(a)}; urls_b = {canonical_url(u) for u in _urls(b)}
    return bool(urls_a & urls_b - {''})


def _urls(j):
    return [x for x in [j.get('url'), j.get('jd_url'), *[p.get('url') for p in j.get('provenance', [])]] if x]


def merge_provenance(existing, incoming):
    seen, out = set(), []
    for p in [*existing.get('provenance', []), *incoming.get('provenance', []),
              *([{'source': incoming.get('source', 'unknown'), 'url': incoming['url'], 'fetched_at': incoming.get('fetched_at')}] if incoming.get('url') else []),
              *([{'source': existing.get('source', 'unknown'), 'url': existing['url'], 'fetched_at': existing.get('fetched_at')}] if existing.get('url') else [])]:
        key = (p.get('source'), p.get('url'))
        if key not in seen:
            seen.add(key); out.append(p)
    return out
