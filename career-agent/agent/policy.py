"""Authorisation: standing authorisation, exclusions, caps and the final check before a click.

Two modes, chosen by the applicant in data/local/policy.json:

  applicant_initiated     the worker and extension fill and upload; the applicant presses submit.
  standing_authorization  the applicant agreed once, to a named and versioned scope, that the agent
                          may press submit without asking each time, ONLY when all of these hold:
                          the route is certified for automatic submission; the form has no
                          declaration and no other sensitive question; every required question has
                          an answer the applicant confirmed; raw coverage >= 80 with every essential
                          met; the vacancy and form were verified just now; today's cap is not
                          reached. Anything else is filled as far as allowed and waits for the
                          applicant (R09, R13).

final_check() re-reads the policy, profile and answer library from disk immediately before a
click and compares their versions with the attempt's snapshot. A revocation, an exclusion or
any changed input after the form was filled means no click (T18, T19).
"""
import hashlib, json
from datetime import datetime
from zoneinfo import ZoneInfo
from .core import gates, score
from . import paths, versions

SCOPE_VERSION = 'nseya-sa-2026-10-06'
SCOPE_TEXT = ('The agent may submit an application for me without asking each time when the route is certified, '
              'the form has no declaration or sensitive question, every required answer is one I confirmed, raw '
              'coverage is at least 80% with every essential met, the vacancy was verified just now, and the daily cap '
              'is not reached. Everything else waits for me. I can revoke this at any time.')


def pack_digest(pack):
    keys = ('job_id', 'url', 'cv_text', 'cover_letter', 'evidence_ids', 'match_score', 'documents', 'document_hashes', 'answers')
    return hashlib.sha256(json.dumps({k: pack.get(k) for k in keys}, sort_keys=True).encode()).hexdigest()


def standing(policy):
    """True when standing authorisation is on, to the current scope, and not revoked."""
    sa = policy.get('standing_authorization') or {}
    return (policy.get('mode') == 'standing_authorization' and policy.get('enabled') is True and sa.get('scope_version') == SCOPE_VERSION
            and bool(sa.get('consent_at')) and not sa.get('revoked_at'))


def excluded(job, policy):
    return job.get('company', '').casefold() in {x.casefold() for x in policy.get('excluded_employers', [])} or job.get('id') in policy.get('excluded_job_ids', [])


def authorize(job, profile, pack, adapter, policy):
    reasons = gates(job, profile, policy.get('minimum_match', 80))
    if not policy.get('enabled'):
        reasons.append('Agent disabled by the applicant (policy.enabled is false)')
    if excluded(job, policy):
        reasons.append('Excluded by applicant')
    if policy.get('require_reviewed_matching', True) and not job.get('matching_reviewed'):
        reasons.append('Complete requirement extraction needs review')
    if not adapter.get('reviewed') or not adapter.get('route_tested'):
        reasons.append('Route not reviewed and tested (adapter reviewed and route_tested must be true)')
    if adapter.get('exact_url') != job.get('url') or pack.get('url') != job.get('url'):
        reasons.append('Exact application URL mismatch')
    if not adapter.get('jd_selector') or not job.get('description_full'):
        reasons.append('Complete current description required')
    if not adapter.get('receipt_pattern') or not adapter.get('receipt_selector'):
        reasons.append('Success receipt rule missing')
    if pack.get('match_score') != score(job.get('requirements', [])):
        reasons.append('Pack score differs from job')
    ledger = {e['id']: e['text'] for e in profile.get('evidence', [])}
    ids = pack.get('evidence_ids', [])
    if not ids or any(i not in ledger or ledger[i] not in pack.get('cv_text', '') for i in ids):
        reasons.append('Pack evidence mismatch')
    if pack.get('generation_mode') != 'extractive_v1' or pack.get('integrity') != pack_digest(pack):
        reasons.append('Pack changed or requires individual review')
    return reasons


def final_check(job_id, snapshot_versions, cap=None, store=None):
    """Re-read everything from disk just before the click. An empty list means the click may happen."""
    reasons = []
    try:
        policy = paths.read('policy.json'); profile = paths.read('profile.json'); library = paths.read('answer_library.json')
    except (OSError, ValueError) as e:
        return ['Inputs could not be read just before submitting: ' + type(e).__name__]
    now_versions = versions.current(profile, policy, library)
    changed = versions.stale(snapshot_versions, now_versions)
    if changed:
        reasons.append('Changed after the form was filled: ' + ', '.join(changed) + '. Not submitted.')
    if not policy.get('enabled'):
        reasons.append('Agent disabled by the applicant. Not submitted.')
    if store is not None:
        job = store.job(job_id) or {'id': job_id}
        if excluded(job, policy):
            reasons.append('Excluded by applicant. Not submitted.')
    return reasons


def daily_attempt_count(store):
    """Attempts today (London), counted from the attempt ledger, ambiguous ones included."""
    return store.attempts_today()


def london_today():
    return datetime.now(ZoneInfo('Europe/London')).date()
