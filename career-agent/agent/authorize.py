"""Standing authorisation: given once, dated, to a named scope; revocable at any time (R09).

  python3 -m agent.authorize status
  python3 -m agent.authorize grant --confirmed     prints the scope; you agree to exactly that wording
  python3 -m agent.authorize revoke                 takes effect before the next click, even mid-cycle
  python3 -m agent.authorize pause | resume         stops or restarts all submissions (policy.enabled)
  python3 -m agent.authorize exclude --employer NAME | --job ID

Writes data/local/policy.json (git-ignored). The committed data/policy.json stays applicant-initiated.
"""
import argparse, json
from . import paths
from .policy import SCOPE_TEXT, SCOPE_VERSION, standing
from .store import Store, now


def _load():
    local = paths.data_dir() / 'policy.json'
    policy = json.loads(local.read_text(encoding='utf-8')) if local.exists() else json.loads((paths.ROOT / 'data' / 'policy.json').read_text(encoding='utf-8'))
    return local, policy


def _save(local, policy):
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_text(json.dumps(policy, indent=2), encoding='utf-8')


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.authorize')
    p.add_argument('action', choices=['status', 'grant', 'revoke', 'pause', 'resume', 'exclude'])
    p.add_argument('--confirmed', action='store_true'); p.add_argument('--employer'); p.add_argument('--job')
    a = p.parse_args(argv)
    local, policy = _load(); store = Store(paths.db_path())
    if a.action == 'status':
        sa = policy.get('standing_authorization') or {}
        print(json.dumps({'standing_authorization': standing(policy), 'enabled': policy.get('enabled'), 'mode': policy.get('mode'), 'scope_version': sa.get('scope_version'),
                          'consent_at': sa.get('consent_at'), 'revoked_at': sa.get('revoked_at'), 'daily_submission_limit': policy.get('daily_submission_limit'),
                          'excluded_employers': policy.get('excluded_employers', []), 'excluded_job_ids': policy.get('excluded_job_ids', [])}, indent=2))
        return
    if a.action == 'grant':
        print(SCOPE_TEXT)
        if not a.confirmed:
            raise SystemExit('Read the scope above. To agree to exactly this wording, run again with --confirmed.')
        policy.update(mode='standing_authorization', enabled=True, standing_authorization={'scope_version': SCOPE_VERSION, 'scope_text': SCOPE_TEXT, 'consent_at': now()})
        _save(local, policy); store.event('standing_authorization_granted', {'scope_version': SCOPE_VERSION})
        print('Standing authorisation recorded. Revoke at any time: python3 -m agent.authorize revoke')
    elif a.action == 'revoke':
        sa = policy.get('standing_authorization') or {}
        sa['revoked_at'] = now(); policy.update(mode='applicant_initiated', standing_authorization=sa)
        _save(local, policy); store.event('standing_authorization_revoked', {})
        print('Revoked. The next click is refused, including one already being prepared.')
    elif a.action in ('pause', 'resume'):
        policy['enabled'] = a.action == 'resume'; _save(local, policy); store.event('agent_' + a.action + 'd', {})
        print('Paused: nothing will be submitted.' if a.action == 'pause' else 'Resumed.')
    elif a.action == 'exclude':
        if a.employer:
            policy.setdefault('excluded_employers', []).append(a.employer)
        if a.job:
            policy.setdefault('excluded_job_ids', []).append(a.job)
        if not (a.employer or a.job):
            raise SystemExit('exclude needs --employer or --job')
        _save(local, policy); store.event('exclusion_added', {'employer': bool(a.employer), 'job': a.job or None})
        print('Excluded. Takes effect before the next click.')
    store.close()


if __name__ == '__main__':
    main()
