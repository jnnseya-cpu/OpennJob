import argparse, json
from pathlib import Path
from .core import Store, score, gates
from .sources import fetch
from . import llm, paths
from .documents import build, PackError
from .report import report, send, schedule


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.cli')
    p.add_argument('command', choices=['seed', 'discover', 'match', 'prepare', 'report', 'send-report', 'schedule', 'gate', 'status', 'export-dashboard'])
    p.add_argument('--job'); p.add_argument('--db', default=None)
    args = p.parse_args(argv)
    s = Store(args.db or paths.db_path())
    if args.command == 'seed':
        for j in paths.read('jobs.json'):
            s.put_job(j)
        print('Seeded researched snapshot; no applications submitted.')
    elif args.command == 'discover':
        for b in paths.read('boards.json'):
            try:
                jobs = fetch(b)
                for j in jobs:
                    s.put_job(j)
                s.event('source_ok', {'company': b['company'], 'count': len(jobs)}); print(b['company'], len(jobs))
            except Exception as e:
                s.event('source_failed', {'company': b['company'], 'error': type(e).__name__}); print('Source failed:', b['company'], type(e).__name__)
    elif args.command == 'status':
        apps = {a['job_id']: a['status'] for a in s.applications()}
        for j in sorted(s.jobs(), key=lambda j: score(j.get('requirements', [])), reverse=True):
            print(f"{score(j.get('requirements', [])):>3}%  {apps.get(j['id'], '-'):<10} {j['id']}  {j.get('company', '')} — {j.get('title', '')}")
    elif args.command == 'export-dashboard':
        out = paths.ROOT / 'dashboard' / 'data.json'
        data = {k.replace('.json', ''): paths.read(k) for k in ('profile.json', 'jobs.json', 'search_profiles.json', 'answer_library.json', 'policy.json')}
        out.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding='utf-8')
        print(f'Wrote {out} (git-ignored; it holds your personal data). Open dashboard/index.html through a local web server.')
    elif args.command in ('match', 'prepare', 'gate'):
        profile = paths.read('profile.json')
        j = next((j for j in s.jobs() if j['id'] == args.job), None)
        if not j:
            raise SystemExit('Choose --job from the seeded/discovered IDs (python3 -m agent.cli status)')
        if args.command == 'match':
            j = llm.match(j, profile); s.put_job(j); print(json.dumps(j, indent=2))
        elif args.command == 'gate':
            print(json.dumps(gates(j, profile), indent=2))
        else:
            if score(j['requirements']) < 80:
                raise SystemExit('Draft blocked: below 80%')
            try:
                pack = build(j, profile, paths.sub('packs') / j['id'])
            except PackError as e:
                raise SystemExit('Draft blocked: ' + str(e))
            s.draft(j, pack)
            print(f"Draft saved in {paths.sub('packs') / j['id']}. Read it; then verify the job and approve the pack (python3 -m agent.review).")
    elif args.command == 'report':
        print(report(s))
    elif args.command == 'send-report':
        send(s)
    elif args.command == 'schedule':
        schedule(s)


if __name__ == '__main__':
    main()
