"""The authenticated local API, and the dashboard served from it (R17, R21, B13; T40, T41).

  python3 -m agent.server          http://127.0.0.1:8765  (CAREER_AGENT_TOKEN, at least 24 characters)

Loopback only. Every /api request needs "Authorization: Bearer <token>"; the dashboard asks for
the token and keeps it in sessionStorage. 401 for a bad token, 409 for a state or version
conflict, 400 for a malformed request, 404 for an unknown id. Unknown body keys are refused,
bodies are limited to 100 kB, ids must be safe identifiers, and no response carries a secret.

  GET  /api/health                         ledger, worker and authorisation state
  GET  /api/sources                        source health and the coverage matrix
  GET  /api/jobs                           postings with their coverage explanation
  GET  /api/applications[/<job_id>]        applications, attempts, receipts and outcomes
  PATCH /api/policy                        {expected_version, changes:{enabled, excluded_employers, excluded_job_ids, daily_submission_limit}}
  PATCH /api/profile                       {expected_version, changes:{...}, confirmed:true}  factual edits need confirmed
  POST /api/applications/<job_id>/claim    {idempotency_key}            the same claim service as the worker
  POST /api/attempts/<attempt_id>/result   {status, receipt}            submitted needs a correlated receipt
  POST /api/applications/<job_id>/outcomes {kind, date, evidence, source}
  GET  /api/reports/<YYYY-MM-DD>           that day's digest record and text
  POST /api/practice                       {job_id, question, answer}   practice only, never an application

Legacy extension routes (kept): GET /pack?job_id=, POST /attempt, POST /result.
"""
import json, os, re, secrets
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from . import paths, versions
from .contracts import ContractError, safe_id
from .core import Store, gates, now
from .store import ClaimConflict

DASHBOARD = paths.ROOT / 'dashboard'
STATIC = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'connect.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8',
          'data.example.json': 'application/json'}
POLICY_KEYS = {'enabled', 'excluded_employers', 'excluded_job_ids', 'daily_submission_limit'}
PROFILE_STYLE_KEYS = {'headline'}
PROFILE_FACT_KEYS = {'location', 'relocation', 'languages', 'work_types', 'phone', 'email'}


class Bad(ValueError):
    pass


def _summary(job):
    from .scoring import display, eligible, raw_coverage
    try:
        cov = str(raw_coverage(job.get('requirements', []))); ok = bool(job.get('requirements')) and eligible(job['requirements']); shown = display(job.get('requirements', []))
    except ValueError:
        cov, ok, shown = 'invalid', False, 0
    return {'id': job['id'], 'company': job.get('company'), 'title': job.get('title'), 'country': job.get('country'), 'url': job.get('url'), 'status': job.get('status'),
            'coverage_display': shown, 'raw_coverage': cov, 'eligible': ok, 'profile_ids': job.get('profile_ids', []), 'matching_reviewed': bool(job.get('matching_reviewed')),
            'requirements': [{'text': r.get('text'), 'jd_quote': r.get('jd_quote'), 'weight': r.get('weight'), 'state': r.get('state'), 'hard': r.get('hard'), 'evidence_ids': r.get('evidence_ids', [])}
                             for r in job.get('requirements', [])]}


def _application(store, a):
    p = a['payload']
    return {'job_id': a['job_id'], 'status': a['status'], 'version': a['version'], 'updated': a['updated'], 'receipt': p.get('receipt'), 'receipt_kind': p.get('receipt_kind'),
            'initiated_by': p.get('initiated_by'), 'reason': p.get('reason'), 'left_for_applicant': p.get('left_for_applicant', []), 'screenshot_warning': p.get('screenshot_warning'),
            'attempts': [{k: x[k] for k in ('id', 'actor', 'claimed_at', 'clicked_at', 'finished_at', 'status')} for x in store.attempts(a['job_id'])],
            'outcomes': [{k: o[k] for k in ('kind', 'occurred_on', 'source')} for o in store.outcomes(a['job_id'])]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, payload, content_type='application/json'):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status); self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(raw)))
        self.send_header('X-Content-Type-Options', 'nosniff'); self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:")
        self.end_headers(); self.wfile.write(raw)

    def authorized(self):
        return secrets.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + os.environ['CAREER_AGENT_TOKEN']).encode())

    def body(self, allowed):
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            raise Bad('JSON required')
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length > 100_000:
            raise Bad('Too large')
        try:
            data = json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError:
            raise Bad('Malformed JSON')
        if not isinstance(data, dict):
            raise Bad('Body must be an object')
        unknown = set(data) - set(allowed)
        if unknown:
            raise Bad('Unknown keys: ' + ', '.join(sorted(unknown)))
        return data

    # ----- routing ----------------------------------------------------------------------
    def do_GET(self):
        q = urlparse(self.path)
        if q.path in ('/', '/index.html') or (q.path.startswith('/dashboard/') and q.path.split('/')[-1] in STATIC) or q.path.lstrip('/') in STATIC:
            name = 'index.html' if q.path in ('/', '/index.html') else q.path.split('/')[-1]
            return self.respond(200, (DASHBOARD / name).read_bytes(), STATIC[name])
        if not self.authorized():
            return self.respond(401, {'error': 'Unauthorized'})
        if q.path == '/pack':
            return self.legacy_pack(q)
        s = Store(paths.db_path())
        try:
            parts = q.path.strip('/').split('/')
            if parts[:1] != ['api']:
                return self.respond(404, {'error': 'Not found'})
            if parts[1:] == ['health']:
                from .policy import standing
                pol = paths.read('policy.json')
                return self.respond(200, {'ok': True, 'schema_version': s.schema_version(), 'worker_running': paths.sub('worker.lock').exists(),
                                          'standing_authorization': standing(pol), 'enabled': pol.get('enabled'), 'policy_version': versions.version_of('policy', pol),
                                          'profile_version': versions.version_of('profile', paths.read('profile.json')), 'at': now(),
                                          'last_discovery': (s.events('source_ok') or [{}])[-1].get('at'), 'attempts_today': s.attempts_today()})
            if parts[1:] == ['sources']:
                from .coverage import matrix
                return self.respond(200, {'sources': s.sources(), 'coverage': matrix(s)})
            if parts[1:] == ['jobs']:
                return self.respond(200, {'jobs': [_summary(j) for j in s.jobs()]})
            if parts[1:] == ['applications']:
                return self.respond(200, {'applications': [_application(s, a) for a in s.applications()]})
            if len(parts) == 3 and parts[1] == 'applications':
                a = s.application(safe_id(parts[2]))
                return self.respond(200, _application(s, a)) if a else self.respond(404, {'error': 'Application not found'})
            if len(parts) == 3 and parts[1] == 'reports':
                day = parts[2]
                if not re.match(r'^\d{4}-\d{2}-\d{2}$', day):
                    raise Bad('Day must be YYYY-MM-DD')
                row = s.db.execute('SELECT * FROM digests WHERE day=?', (day,)).fetchone()
                if not row:
                    return self.respond(404, {'error': 'No report for that day'})
                from .report import report
                d = dict(row)
                text = report(s, start=datetime.fromisoformat(d['window_start']), end=datetime.fromisoformat(d['window_end'])) if d.get('window_start') and d.get('window_end') else ''
                return self.respond(200, {'day': day, 'status': d['status'], 'catch_up': bool(d['catch_up']), 'message_id': d['message_id'], 'text': text})
            return self.respond(404, {'error': 'Not found'})
        except (Bad, ContractError) as e:
            return self.respond(400, {'error': str(e)})
        finally:
            s.close()

    def do_PATCH(self):
        if not self.authorized():
            return self.respond(401, {'error': 'Unauthorized'})
        q = urlparse(self.path); s = Store(paths.db_path())
        try:
            if q.path == '/api/policy':
                body = self.body({'expected_version', 'changes'})
                local = paths.data_dir() / 'policy.json'
                pol = paths.read('policy.json')
                if body.get('expected_version') != versions.version_of('policy', pol):
                    return self.respond(409, {'error': 'The policy changed since you read it; reload', 'current_version': versions.version_of('policy', pol)})
                changes = body.get('changes') or {}
                if not isinstance(changes, dict) or set(changes) - POLICY_KEYS:
                    raise Bad('Only these policy fields can change here: ' + ', '.join(sorted(POLICY_KEYS)))
                if 'daily_submission_limit' in changes and (not isinstance(changes['daily_submission_limit'], int) or not 0 <= changes['daily_submission_limit'] <= 20):
                    raise Bad('daily_submission_limit must be a whole number from 0 to 20')
                pol.update(changes); local.parent.mkdir(parents=True, exist_ok=True); local.write_text(json.dumps(pol, indent=2), encoding='utf-8')
                s.event('policy_changed', {'fields': sorted(changes)})
                return self.respond(200, {'policy_version': versions.version_of('policy', pol)})
            if q.path == '/api/profile':
                body = self.body({'expected_version', 'changes', 'confirmed'})
                pp = paths.data_file('profile.json'); profile = json.loads(pp.read_text(encoding='utf-8'))
                if body.get('expected_version') != versions.version_of('profile', profile):
                    return self.respond(409, {'error': 'The profile changed since you read it; reload', 'current_version': versions.version_of('profile', profile)})
                changes = body.get('changes') or {}
                if not isinstance(changes, dict) or set(changes) - PROFILE_STYLE_KEYS - PROFILE_FACT_KEYS:
                    raise Bad('Only these profile fields can change here: ' + ', '.join(sorted(PROFILE_STYLE_KEYS | PROFILE_FACT_KEYS)))
                facts = set(changes) & PROFILE_FACT_KEYS
                if facts and body.get('confirmed') is not True:
                    raise Bad('Factual changes need confirmed: true (they make prepared packs stale): ' + ', '.join(sorted(facts)))
                profile.update(changes); pp.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding='utf-8')
                s.event('profile_changed', {'fields': sorted(changes), 'factual': bool(facts)})
                return self.respond(200, {'profile_version': versions.version_of('profile', profile), 'packs_stale': bool(facts)})
            return self.respond(404, {'error': 'Not found'})
        except Bad as e:
            return self.respond(400, {'error': str(e)})
        finally:
            s.close()

    def do_POST(self):
        if not self.authorized():
            return self.respond(401, {'error': 'Unauthorized'})
        q = urlparse(self.path)
        if q.path in ('/attempt', '/result'):
            return self.legacy_post(q.path)
        s = Store(paths.db_path())
        try:
            parts = q.path.strip('/').split('/')
            if len(parts) == 4 and parts[:2] == ['api', 'applications'] and parts[3] == 'claim':
                job_id = safe_id(parts[2]); body = self.body({'idempotency_key'})
                key = body.get('idempotency_key')
                if not isinstance(key, str) or not 8 <= len(key) <= 128:
                    raise Bad('idempotency_key (8 to 128 characters) is required')
                blockers = self.claim_blockers(s, job_id)
                if blockers:
                    return self.respond(409, {'blockers': blockers})
                try:
                    attempt = s.claim(job_id, actor='extension', idempotency_key=key, cap=paths.read('policy.json')['daily_submission_limit'])
                except ClaimConflict as e:
                    return self.respond(409, {'blockers': [str(e)]})
                return self.respond(200, {'attempt_id': attempt})
            if len(parts) == 4 and parts[:2] == ['api', 'attempts'] and parts[3] == 'result':
                attempt = s.attempt(safe_id(parts[2]))
                if not attempt:
                    return self.respond(404, {'error': 'Attempt not found'})
                body = self.body({'status', 'receipt'})
                return self.record_result(s, attempt['job_id'], body, attempt_id=attempt['id'])
            if len(parts) == 4 and parts[:2] == ['api', 'applications'] and parts[3] == 'outcomes':
                from .outcomes import add
                body = self.body({'kind', 'date', 'evidence', 'source'})
                try:
                    add(s, safe_id(parts[2]), body.get('kind'), str(body.get('date', '')), str(body.get('evidence', '')), str(body.get('source', 'pasted'))[:40])
                except ValueError as e:
                    raise Bad(str(e))
                return self.respond(200, {'ok': True})
            if parts == ['api', 'practice']:
                from .interview import practice
                body = self.body({'job_id', 'question', 'answer', 'ai'})
                if not isinstance(body.get('answer'), str) or not body['answer'].strip() or len(body['answer']) > 20000:
                    raise Bad('An answer of up to 20,000 characters is required')
                try:
                    return self.respond(200, practice(s, safe_id(str(body.get('job_id', ''))), str(body.get('question', ''))[:1000], body['answer'], bool(body.get('ai'))))
                except LookupError as e:
                    return self.respond(404, {'error': str(e)})
            return self.respond(404, {'error': 'Not found'})
        except (Bad, ContractError) as e:
            return self.respond(400, {'error': str(e)})
        finally:
            s.close()

    # ----- shared rules -------------------------------------------------------------------
    def claim_blockers(self, s, job_id):
        j = s.job(job_id); a = s.application(job_id)
        if not j or not a:
            return ['Application not found']
        reasons = gates(j, paths.read('profile.json'))
        if not a['payload'].get('human_reviewed'):
            reasons.append('Pack needs review')
        if not j.get('matching_reviewed'):
            reasons.append('Matching needs review')
        recorded = a['payload'].get('versions')
        if recorded:
            changed = versions.stale(recorded, versions.current())
            if changed:
                reasons.append('Pack is stale: ' + ', '.join(changed) + ' changed since it was prepared')
        return reasons

    def record_result(self, s, job_id, body, attempt_id=None):
        status = body.get('status')
        if status not in ('submitted', 'uncertain', 'failed'):
            raise Bad('status must be submitted, uncertain or failed')
        app = s.application(job_id)
        if not app or app['status'] != 'submitting' or (attempt_id and app.get('attempt_id') != attempt_id):
            return self.respond(409, {'error': 'This attempt is not the one in progress'})
        receipt = str(body.get('receipt', ''))[:1600]
        if status == 'submitted':
            adapter = app['payload'].get('adapter') or {}
            pattern = adapter.get('receipt_pattern')
            if pattern:
                from .worker import receipt_pattern
                if not re.search(receipt_pattern(adapter, s.job(job_id) or {'id': job_id}), receipt):
                    return self.respond(409, {'error': 'The receipt does not match this posting; record it as uncertain and reconcile'})
        try:
            s.transition(job_id, status, {'receipt': receipt, 'receipt_kind': 'adapter_verified' if status == 'submitted' else None, 'submitted_at': now() if status == 'submitted' else None})
        except ValueError as e:
            return self.respond(409, {'error': str(e)})
        return self.respond(200, {'ok': True})

    # ----- legacy extension routes --------------------------------------------------------
    def legacy_pack(self, q):
        job_id = parse_qs(q.query).get('job_id', [''])[0]; s = Store(paths.db_path())
        try:
            app = s.application(job_id); j = s.job(job_id)
            if not app or not j:
                return self.respond(404, {'error': 'Application not found'})
            reasons = gates(j, paths.read('profile.json')); pack = app['payload']
            if app['status'] != 'ready':
                reasons.append('Application is not ready')
            if not pack.get('human_reviewed'):
                reasons.append('Pack needs review')
            if not j.get('matching_reviewed'):
                reasons.append('Matching needs review')
            if reasons:
                return self.respond(409, {'blockers': reasons})
            return self.respond(200, pack | {'gate_passed': True, 'verified_at': j['verified_at']})
        finally:
            s.close()

    def legacy_post(self, path):
        s = Store(paths.db_path())
        try:
            body = self.body({'job_id', 'status', 'receipt', 'idempotency_key'}); job_id = body.get('job_id')
            if not isinstance(job_id, str) or not job_id:
                raise Bad('job_id required')
            if path == '/attempt':
                blockers = self.claim_blockers(s, job_id)
                if blockers:
                    return self.respond(409, {'blockers': blockers})
                try:
                    attempt = s.claim(job_id, actor='extension', idempotency_key=body.get('idempotency_key'), cap=paths.read('policy.json')['daily_submission_limit'])
                except ClaimConflict as e:
                    return self.respond(409, {'blockers': [str(e)]})
                return self.respond(200, {'ok': True, 'attempt_id': attempt})
            return self.record_result(s, job_id, body)
        except Bad as e:
            return self.respond(409 if path == '/result' else 400, {'error': str(e)})
        finally:
            s.close()


def make_server(port=8765):
    if len(os.getenv('CAREER_AGENT_TOKEN', '')) < 24:
        raise SystemExit('Set CAREER_AGENT_TOKEN to a random value of at least 24 characters')
    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def main():
    server = make_server(int(os.getenv('CAREER_AGENT_PORT', '8765')))
    print(f'Local agent: http://127.0.0.1:{server.server_port} (dashboard and API; authenticated requests only)'); server.serve_forever()


if __name__ == '__main__':
    main()
