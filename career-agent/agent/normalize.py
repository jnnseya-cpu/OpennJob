"""One canonical form for job-description text, used for every hash and comparison (R03, B06).

Formatting-only differences (HTML tags and entities, non-breaking and zero-width spaces,
line breaks, runs of spaces, typographic quotes and dashes) do not change the hash. Any
change of words does.
"""
import hashlib, html, re, unicodedata

PARSER_VERSION = 'jd-normalize-2'
_TAG = re.compile(r'<[^>]+>')
_SPACE = re.compile(r'\s+')
_ZERO = dict.fromkeys(map(ord, '​‌‍⁠﻿'), None)
_PUNCT = str.maketrans({'‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' '})


def normalize(text):
    t = html.unescape(_TAG.sub(' ', text or ''))
    t = unicodedata.normalize('NFKC', t).translate(_ZERO).translate(_PUNCT)
    return _SPACE.sub(' ', t).strip()


def digest(text):
    return hashlib.sha256(normalize(text).encode('utf-8')).hexdigest()


def jd_version(text, url=None, fetched_at=None):
    from .store import now
    n = normalize(text)
    sha = hashlib.sha256(n.encode('utf-8')).hexdigest()
    return {'version_id': 'jd-' + sha[:16], 'sha256': sha, 'normalized_text': n, 'original_text': text or '', 'url': url,
            'fetched_at': fetched_at or now(), 'parser_version': PARSER_VERSION}
