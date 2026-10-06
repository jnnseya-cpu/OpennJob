"""Deterministic controls. No third-party packages required."""
import hashlib, json, re, sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
STATES={'met':1.0,'partial':.5,'unknown':0.0,'unmet':0.0}
def now(): return datetime.now(timezone.utc).isoformat()
def score(requirements):
    """Display only: the floor of the exact coverage. Eligibility uses scoring.eligible (raw Decimal)."""
    from .scoring import display
    try:
        return display(requirements)
    except ValueError:
        raise ValueError('Invalid requirement')
def validate_requirements(requirements,profile):
    ledger={e['id']:e for e in profile['evidence']}
    if not requirements: raise ValueError('No requirements extracted')
    for r in requirements:
        if not isinstance(r.get('hard'),bool): raise ValueError('Essential classification missing')
        if r['state'] in ('met','partial') and not r.get('evidence_ids'): raise ValueError('Evidence required')
        if any(i not in ledger for i in r.get('evidence_ids',[])): raise ValueError('Unknown evidence citation')
    from .scoring import raw_coverage
    raw_coverage(requirements)
def gates(job,profile,threshold=80):
    reasons=[]
    if threshold<80: raise ValueError('Minimum threshold is 80')
    req=job.get('requirements',[])
    try: validate_requirements(req,profile)
    except (ValueError,KeyError,TypeError) as e: return [str(e)]
    from .scoring import eligible
    if not eligible(req,threshold): reasons.append('Below minimum relevance threshold')
    reasons += ['Essential requirement unresolved: '+r['text'] for r in req if r['hard'] and r['state']!='met']
    if not profile.get('confirmed'): reasons.append('Profile not confirmed')
    for field in ('email','phone','ge_end_date'):
        if not profile.get(field): reasons.append('Missing '+field)
    country=job.get('country','Unconfirmed')
    # Work rights come only from a confirmed, document-backed record for that country (agent/rights.py).
    from .rights import record_for
    record,question=record_for(profile,country)
    if record is None: reasons.append(question)
    elif record['right_to_work'] is not True:
        # Sponsorship counts only when it is confirmed that THIS applicant is eligible for THIS role's
        # sponsorship. An advert that mentions sponsorship proves nothing on its own (R07, T17).
        if not record['requires_sponsorship']: reasons.append('Work authorisation not confirmed for '+country)
        elif job.get('sponsorship_eligibility_confirmed') is not True:
            reasons.append(('Sponsorship is advertised but your eligibility for it is not confirmed for ' if job.get('sponsorship_offered') else 'Work authorisation or sponsorship not confirmed for ')+country)
    if country!='United Kingdom' and profile.get('relocation') is not True and not job.get('remote_from_home_confirmed'): reasons.append('International relocation/remote arrangement not confirmed')
    for lang in job.get('required_languages',[]):
        if profile.get('languages',{}).get(lang) is not True: reasons.append('Language not confirmed: '+lang)
    cited={i for r in req for i in r.get('evidence_ids',[])}
    if any(not e.get('verified') for e in profile['evidence'] if e['id'] in cited): reasons.append('Cited CV evidence not confirmed by applicant')
    if not job.get('live_verified'): reasons.append('Vacancy not verified immediately before application')
    else:
        try:
            stamp=datetime.fromisoformat(job['verified_at'])
            age=datetime.now(timezone.utc)-stamp
            if stamp.tzinfo is None or age>timedelta(minutes=15) or age<timedelta(0): reasons.append('Vacancy verification expired')
        except (KeyError,TypeError,ValueError): reasons.append('Invalid vacancy verification timestamp')
    if job.get('deadline') and job['deadline']<datetime.now(timezone.utc).date().isoformat(): reasons.append('Past closing date')
    if not job.get('preferences_confirmed'): reasons.append('Location, travel, rate/salary and work type require confirmation')
    return reasons

from .identity import canonical_id  # noqa: E402,F401  (kept here for existing imports)
from .store import Store, ClaimConflict, now as _now  # noqa: E402,F401
