"""Content-addressed versions of the applicant's inputs (R03, R09, R11, T04, T50).

A version id is the hash of the canonical JSON, so any change of the profile, policy or
answer library is a new version. A prepared pack records the versions it was built from;
a pack whose versions differ from the current files is stale and is never submitted.
Style-only answers (kind "narrative") have their own version so editing wording does not
invalidate packs, while any factual change does.
"""
import hashlib, json
from . import paths

NARRATIVE_KINDS = {'narrative', 'style'}


def _hash(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def version_of(kind, payload):
    return f'{kind}-{_hash(payload)[:16]}'


def answers_split(library):
    answers = (library or {}).get('answers', {})
    facts = {k: v for k, v in answers.items() if v.get('kind') not in NARRATIVE_KINDS}
    narrative = {k: v for k, v in answers.items() if v.get('kind') in NARRATIVE_KINDS}
    return facts, narrative


def current(profile=None, policy=None, library=None, store=None):
    """The current version ids, read from disk unless given. Recorded in the ledger when a store is passed."""
    profile = profile if profile is not None else paths.read('profile.json')
    policy = policy if policy is not None else paths.read('policy.json')
    library = library if library is not None else paths.read('answer_library.json')
    facts, narrative = answers_split(library)
    out = {'profile': version_of('profile', profile), 'policy': version_of('policy', policy),
           'answers': version_of('answers', facts), 'narrative': version_of('narrative', narrative)}
    if store is not None:
        for kind, payload in (('profile', profile), ('policy', policy), ('answers', facts), ('narrative', narrative)):
            store.record_version(kind, out[kind], payload)
    return out


def stale(recorded, now_versions, keys=('profile', 'policy', 'answers')):
    """The inputs that changed since a pack was prepared (narrative edits do not count)."""
    return [k for k in keys if (recorded or {}).get(k) != now_versions.get(k)]
