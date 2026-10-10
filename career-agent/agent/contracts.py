"""Contracts and input safety (R03, R11, R21; T03, T44).

  validate_snapshot(s)   JSON Schema (Draft 2020-12, formats checked) plus the runtime checks the
                         schema cannot express: weights total 100, raw coverage recomputed in
                         Decimal, every quote in the JD text, the JD hash matching the text, the
                         policy floor of 80. Schema validity alone never authorises anything.
  validate_job(j)        an ingested posting: required fields, an https URL, an aware timestamp,
                         and a country that is either known or literally "Unconfirmed".
  safe_url(u)            https only; no credentials; no private, loopback or link-local host
                         unless the local test fixture is explicitly allowed.
  safe_id(i)             ids used in file names: letters, digits, dash and underscore only.
  child_path(base, *p)   a path that cannot leave its base directory.
"""
import ipaddress, json, os, re, socket
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit
from .normalize import digest, normalize
from .scoring import raw_coverage, as_text

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / 'contracts' / 'attempt-snapshot.schema.json'
_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')


class ContractError(ValueError):
    pass


def _validator():
    from jsonschema import Draft202012Validator, FormatChecker
    schema = json.loads(SCHEMA_PATH.read_text(encoding='utf-8'))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def schema_errors(snapshot):
    return sorted(f"{'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}" for e in _validator().iter_errors(snapshot))


def validate_snapshot(snapshot):
    errors = schema_errors(snapshot)
    if errors:
        raise ContractError('Snapshot does not match the contract: ' + '; '.join(errors[:5]))
    reqs = snapshot['scorecard']['requirements']
    if sum(Decimal(str(r['weight'])) for r in reqs) != Decimal(100):
        raise ContractError('Scorecard weights must total 100')
    if as_text(raw_coverage(reqs)) != as_text(Decimal(snapshot['scorecard']['raw_coverage'])):
        raise ContractError('raw_coverage does not match the requirements')
    text = snapshot['jd']['normalized_text']
    if digest(text) != snapshot['jd']['sha256'] or normalize(text) != text:
        raise ContractError('JD hash does not match its normalized text')
    for r in reqs:
        if normalize(r['jd_quote']) not in text:
            raise ContractError('Requirement quote not in the JD: ' + r['text'])
        if r['state'] in ('met', 'partial') and not r['evidence_ids']:
            raise ContractError('Met or partial requirement without evidence: ' + r['text'])
    if snapshot['authorization']['minimum_match'] < 80:
        raise ContractError('Minimum match below 80')
    return snapshot


def _aware(stamp):
    try:
        d = datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return False
    return d.tzinfo is not None


def validate_job(j):
    """Returns the job with an explicit country; raises ContractError when malformed (T03)."""
    if not isinstance(j, dict):
        raise ContractError('Job must be an object')
    for field in ('id', 'company', 'title', 'url'):
        if not isinstance(j.get(field), str) or not j[field].strip():
            raise ContractError('Job is missing ' + field)
    if not j['url'].startswith('https://'):
        raise ContractError('Job URL must be https')
    if j.get('jd_url') and not str(j['jd_url']).startswith('https://'):
        raise ContractError('Job description URL must be https')
    if 'fetched_at' in j and not _aware(j['fetched_at']):
        raise ContractError('fetched_at must be an ISO timestamp with a time zone')
    if j.get('verified_at') and not _aware(j['verified_at']):
        raise ContractError('verified_at must be an ISO timestamp with a time zone')
    country = j.get('country')
    # A missing country is never guessed to be the UK.
    if not isinstance(country, str) or not country.strip():
        j = j | {'country': 'Unconfirmed'}
    return j


def loopback_allowed():
    """Only the test suite sets this, to reach the fixture server on 127.0.0.1."""
    return os.getenv('CAREER_ALLOW_LOCAL_FIXTURE') == '1'


def _private(host):
    try:
        ip = ipaddress.ip_address(host.strip('[]'))
    except ValueError:
        if host in ('localhost',) or host.endswith('.localhost') or host.endswith('.local') or host.endswith('.internal'):
            return True
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


def safe_url(url, resolve=False):
    """The URL, when the agent may open or submit to it; ContractError otherwise."""
    parts = urlsplit(str(url or ''))
    if parts.username or parts.password:
        raise ContractError('URL must not carry credentials')
    host = (parts.hostname or '').lower()
    if not host:
        raise ContractError('URL has no host')
    local = _private(host)
    if local and loopback_allowed() and parts.scheme in ('https', 'http') and host in ('127.0.0.1', 'localhost'):
        return url
    if parts.scheme != 'https':
        raise ContractError('Only https URLs are allowed')
    if local:
        raise ContractError('Private, loopback or link-local addresses are not allowed')
    if resolve:
        for info in socket.getaddrinfo(host, None):
            if _private(info[4][0]):
                raise ContractError('Host resolves to a private address')
    return url


def same_origin(a, b):
    pa, pb = urlsplit(a), urlsplit(b)
    return (pa.scheme, pa.hostname, pa.port) == (pb.scheme, pb.hostname, pb.port)


def safe_id(value):
    if not isinstance(value, str) or not _ID.match(value):
        raise ContractError('Unsafe identifier')
    return value


def child_path(base, *parts):
    base = Path(base).resolve()
    target = base.joinpath(*[safe_id(p) if i == 0 else p for i, p in enumerate(parts)]).resolve()
    if target != base and base not in target.parents:
        raise ContractError('Path leaves its directory')
    return target
