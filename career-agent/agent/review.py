"""Explicit local review actions; never silently approve applications.

  confirm-profile   you confirm your profile and evidence (not an independent credential check)
  verify-job        you checked the live posting, the requirements and your preferences (valid 15 minutes)
  approve-pack      you read the pack and reviewed the adapter: the application becomes ready
  retry             a failed or blocked application goes back to ready (never an uncertain one)
  reconcile         an uncertain application becomes submitted (with your receipt) or failed

The agent never submits on its own. A ready application is filled by the worker or the
extension; you answer the declarations and click submit yourself.
"""
import argparse, json
from pathlib import Path
from .core import Store, gates, now, score
from . import paths


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.review')
    p.add_argument('action', choices=['confirm-profile', 'verify-job', 'approve-pack', 'retry', 'reconcile'])
    p.add_argument('--job'); p.add_argument('--adapter'); p.add_argument('--confirmed', action='store_true')
    p.add_argument('--auto-submit', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('--receipt', help='reconcile: the confirmation reference or text you received')
    p.add_argument('--not-submitted', action='store_true', help='reconcile: you confirmed nothing was sent')
    a = p.parse_args(argv)
    if a.auto_submit:
        raise SystemExit('Automatic submission is not available: you click submit yourself on every application.')
    if not a.confirmed:
        raise SystemExit('Review first, then explicitly pass --confirmed')
    pp = paths.data_file('profile.json'); profile = json.loads(pp.read_text(encoding='utf-8')); s = Store(paths.db_path())
    if a.action == 'confirm-profile':
        for field in ('email', 'phone', 'ge_end_date'):
            if not profile.get(field):
                raise SystemExit('Add ' + field + ' to ' + str(pp) + ' first')
        profile['confirmed'] = True
        for e in profile['evidence']:
            e['verified'] = True
        pp.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding='utf-8'); s.event('profile_confirmed', {})
        print('Applicant-confirmed CV claims; no independent credential check implied.')
        if not profile.get('prior_chronology') and not profile.get('employment'):
            print('Note: no earlier employment dates. Packs leave them out; a form that requires them waits for you.')
        return
    job = next((j for j in s.jobs() if j['id'] == a.job), None)
    if not job:
        raise SystemExit('Unknown --job; see python3 -m agent.cli status')
    if a.action == 'verify-job':
        job.update(live_verified=True, verified_at=now(), matching_reviewed=True, preferences_confirmed=True); s.put_job(job); s.event('job_reviewed', {'id': job['id']})
        print('Current vacancy, requirements and preferences review recorded. Expires in 15 minutes.')
    elif a.action == 'approve-pack':
        reasons = gates(job, profile)
        if reasons:
            raise SystemExit('\n'.join(reasons))
        app = next((x for x in s.applications() if x['job_id'] == a.job), None)
        if not app:
            raise SystemExit('Prepare the pack first: python3 -m agent.cli prepare --job ' + a.job)
        if not a.adapter:
            raise SystemExit('--adapter is required')
        adapter = json.loads(Path(a.adapter).read_text(encoding='utf-8'))
        if not adapter.get('reviewed') or not adapter.get('exact_url'):
            raise SystemExit('Reviewed exact-page adapter required')
        pack = app['payload']
        pack.update(adapter=adapter, human_reviewed=True, match_score=score(job['requirements']))
        s.db.execute('UPDATE applications SET payload=? WHERE job_id=?', (json.dumps(pack), job['id'])); s.db.commit(); s.transition(job['id'], 'ready')
        print('Application ready; not submitted. Fill it with the worker or the extension, then answer the declarations and submit it yourself.')
    elif a.action == 'retry':
        s.transition(job['id'], 'ready', {'retried_at': now()}); print('Back to ready.')
    elif a.action == 'reconcile':
        if a.not_submitted:
            s.transition(job['id'], 'failed', {'reconciled_at': now(), 'reason': 'Applicant confirmed nothing was submitted'}); print('Recorded as not submitted (failed). Use retry to try again.')
        elif a.receipt:
            s.transition(job['id'], 'submitted', {'receipt': a.receipt, 'receipt_kind': 'manually_reconciled', 'submitted_at': now()}); print('Recorded as submitted (manually reconciled).')
        else:
            raise SystemExit('reconcile needs --receipt TEXT or --not-submitted')


if __name__ == '__main__':
    main()
