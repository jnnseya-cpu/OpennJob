"""Pre-submission checks with immutable prepared-pack checks.

The applicant starts every submission: the worker and the extension fill the form and
upload the sealed documents, and the applicant answers the declarations and clicks submit.
These checks decide whether a pack may be offered for that.
"""
import hashlib,json
from datetime import datetime
from zoneinfo import ZoneInfo
from .core import gates,score

def pack_digest(pack):
    keys=('job_id','url','cv_text','cover_letter','evidence_ids','match_score','documents','document_hashes','answers')
    return hashlib.sha256(json.dumps({k:pack.get(k) for k in keys},sort_keys=True).encode()).hexdigest()

def authorize(job,profile,pack,adapter,policy):
    reasons=gates(job,profile,policy.get('minimum_match',80))
    if not policy.get('enabled'):reasons.append('Agent disabled by the applicant (policy.enabled is false)')
    if job.get('company','').casefold() in {x.casefold() for x in policy.get('excluded_employers',[])} or job['id'] in policy.get('excluded_job_ids',[]):reasons.append('Excluded by applicant')
    if policy.get('require_reviewed_matching',True) and not job.get('matching_reviewed'):reasons.append('Complete requirement extraction needs review')
    if not adapter.get('reviewed') or not adapter.get('route_tested'):reasons.append('Route not reviewed and tested (adapter reviewed and route_tested must be true)')
    if adapter.get('exact_url')!=job.get('url') or pack.get('url')!=job.get('url'):reasons.append('Exact application URL mismatch')
    if not adapter.get('jd_selector') or not job.get('description_full'):reasons.append('Complete current description required')
    if not adapter.get('receipt_pattern') or not adapter.get('receipt_selector'):reasons.append('Success receipt rule missing')
    if pack.get('match_score')!=score(job.get('requirements',[])):reasons.append('Pack score differs from job')
    ledger={e['id']:e['text'] for e in profile.get('evidence',[])}
    ids=pack.get('evidence_ids',[])
    if not ids or any(i not in ledger or ledger[i] not in pack.get('cv_text','') for i in ids):reasons.append('Pack evidence mismatch')
    if pack.get('generation_mode')!='extractive_v1' or pack.get('integrity')!=pack_digest(pack):reasons.append('Pack changed or requires individual review')
    return reasons

def daily_attempt_count(store):
    zone=ZoneInfo('Europe/London');today=datetime.now(zone).date()
    rows=store.db.execute("SELECT at FROM events WHERE kind='application_submitting'").fetchall()
    return sum(datetime.fromisoformat(r['at']).astimezone(zone).date()==today for r in rows)
