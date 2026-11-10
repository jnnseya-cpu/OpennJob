"""What employers did, recorded separately with evidence and dates (R19, B18; T39).

  python3 -m agent.outcomes add --job ID --kind interview_invitation --date 2026-10-08 --evidence-file reply.txt [--source pasted_email]
  python3 -m agent.outcomes list [--job ID]
  python3 -m agent.outcomes metrics

Kinds are distinct: recruiter_reply, interview_invitation, interview_booked, interview_completed,
rejection, offer. Paste a recruiter's reply instead of connecting an inbox. The evidence stays in
the local ledger. Metrics count only agent-confirmed submissions (with a receipt) and recorded
outcomes by their own dates; prepared documents, opened links or self-reported updates are not
submissions.
"""
import argparse, json
from datetime import date
from pathlib import Path
from . import paths
from .store import Store

KINDS = ('recruiter_reply', 'interview_invitation', 'interview_booked', 'interview_completed', 'rejection', 'offer')
STATUS = {'recruiter_reply': 'recruiter_reply', 'interview_invitation': 'interview', 'interview_booked': 'interview', 'rejection': 'rejected', 'offer': 'offer'}


def add(store, job_id, kind, occurred_on, evidence, source='pasted'):
    if kind not in KINDS:
        raise ValueError('Unknown outcome kind')
    date.fromisoformat(occurred_on)
    if not evidence or not evidence.strip():
        raise ValueError('An outcome needs its evidence (the pasted reply, or a note of the call)')
    app = store.application(job_id)
    if not app:
        raise ValueError('No application for that job')
    store.add_outcome(job_id, kind, occurred_on, source, evidence.strip()[:20000])
    target = STATUS.get(kind)
    if target and target != app['status']:
        try:
            store.transition(job_id, target, {'outcome_' + kind: occurred_on})
        except ValueError:
            pass  # the state machine refuses a step back; the outcome is still recorded
    return store.outcomes(job_id)


def metrics(store):
    apps = store.applications()
    confirmed = [a for a in apps if a['payload'].get('receipt_kind') in ('adapter_verified', 'manually_reconciled')]
    by_kind = {k: len({o['job_id'] for o in store.outcomes() if o['kind'] == k}) for k in KINDS}
    usage = store.db.execute('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) FROM usage').fetchone()[0]
    return {'verified_submissions': len(confirmed), 'agent_submitted': sum(a['payload'].get('initiated_by') == 'agent' for a in confirmed),
            'uncertain': sum(a['status'] == 'uncertain' for a in apps), **by_kind, 'llm_cost_gbp': round(float(usage), 4),
            'note': 'Counts by event. Prepared documents and opened links are not submissions. No interview probability is implied.'}


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.outcomes')
    p.add_argument('action', choices=['add', 'list', 'metrics'])
    p.add_argument('--job'); p.add_argument('--kind', choices=KINDS); p.add_argument('--date'); p.add_argument('--evidence'); p.add_argument('--evidence-file'); p.add_argument('--source', default='pasted')
    a = p.parse_args(argv); s = Store(paths.db_path())
    if a.action == 'add':
        evidence = Path(a.evidence_file).read_text(encoding='utf-8') if a.evidence_file else a.evidence
        add(s, a.job, a.kind, a.date or date.today().isoformat(), evidence or '', a.source); print('Recorded.')
    elif a.action == 'list':
        for o in s.outcomes(a.job):
            print(f"{o['occurred_on']} {o['job_id']} {o['kind']} ({o['source']})")
    else:
        print(json.dumps(metrics(s), indent=2))
    s.close()


if __name__ == '__main__':
    main()
