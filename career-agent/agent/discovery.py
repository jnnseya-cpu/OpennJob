"""Discovery every two hours (R01, R02, R03, R20; T06, T07, T08, T10).

For each known board: read the public feed (bounded retries with backoff for reads only),
record the source's health, validate every posting on the way in, keep the cost prefilter
recall-safe, apply the three search profiles, version the JD (a changed JD invalidates every
review made against the old one), and mark postings that vanished from a COMPLETE read as
withdrawn. One failing source never stops the others. LLM matching is capped per cycle and by
the spending budget; the 80% floor is never lowered to fill a queue.
"""
import argparse, json, time
from .contracts import ContractError, validate_job
from .core import Store, score
from .normalize import digest, jd_version
from .profiles import apply as apply_profiles, title_matches
from .sources import fetch
from . import llm, paths


def _profiles():
    try:
        return paths.read('search_profiles.json')
    except FileNotFoundError:
        return []


def once(store, max_matches=10):
    profile = paths.read('profile.json'); boards = paths.read('boards.json'); profiles = _profiles()
    matched = 0
    for board in boards:
        company = board['company']
        try:
            cursor = (store.source(company) or {}).get('cursor', 0)
            meta = {}
            jobs = fetch(board, cursor, meta) if board.get('type') == 'smartrecruiters' else fetch(board)
            store.source_ok(company, len(jobs), meta.get('pages', 1), meta.get('truncated', False), meta.get('next', 0))
            store.event('source_ok', {'company': company, 'count': len(jobs), 'truncated': bool(meta.get('truncated'))})
            old = {j['id']: j for j in store.jobs()}
            seen = set()
            for j in jobs:
                try:
                    j = validate_job(j)
                except ContractError as e:
                    store.event('job_rejected', {'company': company, 'reason': str(e)}); continue
                if not title_matches(j['title']):
                    continue
                j['description_full'] = True
                apply_profiles(j, profiles)
                previous = old.get(j['id']) or next((x for x in old.values() if x.get('company') == j['company'] and x.get('posting_id') == j.get('posting_id')), None)
                if previous:
                    j['id'] = previous['id']
                seen.add(j['id'])
                version = jd_version(j['description'], j.get('jd_url') or j['url'], j.get('fetched_at'))
                store.record_jd(j['id'], version)
                j.update(jd_version=version['version_id'], jd_sha256=version['sha256'])
                if previous and digest(previous.get('description', '')) == version['sha256']:
                    j = previous | j | {'requirements': previous.get('requirements', []), 'matching_reviewed': previous.get('matching_reviewed', False),
                                        'preferences_confirmed': previous.get('preferences_confirmed', False) or j.get('preferences_confirmed', False)}
                elif previous:
                    j = j | {'requirements': [], 'matching_reviewed': False, 'preferences_confirmed': j.get('preferences_confirmed', False), 'live_verified': False}
                    store.event('description_changed', {'job_id': j['id']})
                    app = store.application(j['id'])
                    if app and app['status'] == 'ready':
                        store.transition(j['id'], 'blocked', {'reason': 'The job description changed; re-match and review before applying.'})
                store.put_job(j)
                if not j['requirements'] and matched < max_matches:
                    matched += 1
                    try:
                        store.put_job(llm.match(j, profile, store=store))
                    except Exception as e:
                        store.event('matching_failed', {'job_id': j['id'], 'reason': type(e).__name__})
            if not meta.get('truncated'):
                # Only a complete read can show that a posting is gone (T10).
                for job in old.values():
                    if job.get('company') == company and job.get('source') == board.get('type') and job['id'] not in seen and job.get('status') != 'closed':
                        job.update(status='closed', closed_reason='No longer in the employer feed', closed_at=jd_version('x')['fetched_at']); store.put_job(job)
                        app = store.application(job['id'])
                        if app and app['status'] in ('draft', 'ready', 'blocked'):
                            store.transition(job['id'], 'expired', {'reason': 'The posting is no longer in the employer feed.'})
                        store.event('posting_withdrawn', {'job_id': job['id'], 'reason': 'not in feed'})
            print(company, len(jobs), 'found', flush=True)
        except Exception as e:
            store.source_failed(company, type(e).__name__)
            store.event('source_failed', {'company': company, 'reason': type(e).__name__})
            print('Source failed', company, type(e).__name__, flush=True)


def main():
    p = argparse.ArgumentParser(); p.add_argument('--once', action='store_true'); p.add_argument('--max-matches', type=int, default=10); a = p.parse_args()
    if not 0 <= a.max_matches <= 100:
        raise SystemExit('Use a matching budget between 0 and 100 per source cycle')
    store = Store(paths.db_path())
    while True:
        once(store, a.max_matches)
        if a.once:
            break
        deadline = time.monotonic() + paths.read('policy.json')['source_interval_seconds']
        while time.monotonic() < deadline:
            time.sleep(min(30, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    main()
