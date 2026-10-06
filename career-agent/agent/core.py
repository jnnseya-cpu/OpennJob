"""Deterministic controls. No third-party packages required."""
import hashlib, json, re, sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
STATES={'met':1.0,'partial':.5,'unknown':0.0,'unmet':0.0}
def now(): return datetime.now(timezone.utc).isoformat()
def score(requirements):
    if not requirements: return 0
    total=sum(float(r['weight']) for r in requirements)
    if total<=0: raise ValueError('Requirement weights must have positive total')
    for r in requirements:
        if r['state'] not in STATES or not 0<float(r['weight'])<=100: raise ValueError('Invalid requirement')
    # Never round a score below 80 up into eligibility.
    return int(sum(float(r['weight'])*STATES[r['state']] for r in requirements)/total*100+1e-9)
def validate_requirements(requirements,profile):
    ledger={e['id']:e for e in profile['evidence']}
    if not requirements: raise ValueError('No requirements extracted')
    for r in requirements:
        if not isinstance(r.get('hard'),bool): raise ValueError('Essential classification missing')
        if r['state'] in ('met','partial') and not r.get('evidence_ids'): raise ValueError('Evidence required')
        if any(i not in ledger for i in r.get('evidence_ids',[])): raise ValueError('Unknown evidence citation')
    score(requirements)
def gates(job,profile,threshold=80):
    reasons=[]
    if threshold<80: raise ValueError('Minimum threshold is 80')
    req=job.get('requirements',[])
    try: validate_requirements(req,profile)
    except (ValueError,KeyError,TypeError) as e: return [str(e)]
    if score(req)<threshold: reasons.append('Below minimum relevance threshold')
    reasons += ['Essential requirement unresolved: '+r['text'] for r in req if r['hard'] and r['state']!='met']
    if not profile.get('confirmed'): reasons.append('Profile not confirmed')
    for field in ('email','phone','ge_end_date'):
        if not profile.get(field): reasons.append('Missing '+field)
    country=job.get('country','Unconfirmed')
    authorised=profile.get('right_to_work') if country=='United Kingdom' else profile.get('work_authorisation_by_country',{}).get(country)
    if authorised is not True and job.get('sponsorship_confirmed') is not True: reasons.append('Work authorisation or sponsorship not confirmed for '+country)
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

def canonical_id(company,url,posting_id=None):
    # Employer + stable posting ID if available; query strings excluded otherwise.
    return hashlib.sha256((company.lower().strip()+'|'+str(posting_id or url.split('?')[0].rstrip('/'))).encode()).hexdigest()[:24]
class Store:
    def __init__(self,path='career.sqlite3'):
        self.db=sqlite3.connect(path);self.db.row_factory=sqlite3.Row
        self.db.executescript('''CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT,kind TEXT,payload TEXT);
        CREATE TABLE IF NOT EXISTS digests(day TEXT PRIMARY KEY,status TEXT,at TEXT);''');self.db.commit()
    def event(self,kind,payload):
        self.db.execute('INSERT INTO events(at,kind,payload) VALUES(?,?,?)',(now(),kind,json.dumps(payload)));self.db.commit()
    def put_job(self,j):
        # Reconcile researched seed IDs with provider IDs to avoid duplicate queues.
        if j.get('posting_id'):
            for existing in self.jobs():
                if existing.get('posting_id')==j['posting_id'] and existing.get('company','').lower()==j.get('company','').lower():
                    j=j|{'id':existing['id']};break
        self.db.execute('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',(j['id'],json.dumps(j)));self.db.commit()
    def jobs(self): return [json.loads(x[0]) for x in self.db.execute('SELECT payload FROM jobs')]
    def applications(self): return [dict(x) | {'payload':json.loads(x['payload'])} for x in self.db.execute('SELECT * FROM applications')]
    def draft(self,j,pack):
        # No status regression and no duplicate application to the same posting.
        existing=self.db.execute('SELECT status FROM applications WHERE job_id=?',(j['id'],)).fetchone()
        if existing and existing['status']!='draft': raise ValueError('Application already queued or attempted')
        self.db.execute('INSERT INTO applications VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated',(j['id'],j['id'],'draft',json.dumps(pack),now()));self.db.commit()
    def transition(self,job_id,status,extra=None):
        allowed={'draft':{'ready','expired'},'ready':{'submitting','blocked','expired'},'submitting':{'submitted','uncertain','failed'},'uncertain':{'submitted','failed'},'submitted':{'recruiter_reply','interview','rejected','offer'},'recruiter_reply':{'interview','rejected','offer'},'interview':{'rejected','offer'},'failed':{'ready'},'blocked':{'ready'}}
        row=self.db.execute('SELECT * FROM applications WHERE job_id=?',(job_id,)).fetchone()
        if not row: raise ValueError('Unknown application')
        if status not in allowed.get(row['status'],set()): raise ValueError('Invalid state transition')
        p=json.loads(row['payload']);p.update(extra or {})
        if status=='submitted' and not (p.get('receipt') and p.get('receipt_kind') in ('adapter_verified','manually_reconciled')): raise ValueError('Submission receipt required')
        self.db.execute('UPDATE applications SET status=?,payload=?,updated=? WHERE job_id=?',(status,json.dumps(p),now(),job_id));self.db.commit();self.event('application_'+status,{'job_id':job_id})
