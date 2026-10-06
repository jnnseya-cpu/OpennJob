import argparse, json
from pathlib import Path
from .core import Store, score, gates
from .sources import fetch
from . import llm, paths
from .documents import build, PackError
from .report import report, send, schedule


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.cli')
    p.add_argument('command', choices=['seed', 'discover', 'match', 'prepare', 'report', 'send-report', 'schedule', 'gate', 'status', 'export-dashboard', 'report-reconcile', 'export-application', 'backup', 'restore', 'coverage', 'import-job'])
    p.add_argument('--job'); p.add_argument('--db', default=None); p.add_argument('--day'); p.add_argument('--sent', action='store_true'); p.add_argument('--not-sent', action='store_true')
    p.add_argument('--file'); p.add_argument('--url'); p.add_argument('--company'); p.add_argument('--title'); p.add_argument('--country'); p.add_argument('--confirmed', action='store_true')
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
    elif args.command == 'report-reconcile':
        from .report import reconcile
        if args.sent == args.not_sent or not args.day:
            raise SystemExit('report-reconcile needs --day and exactly one of --sent or --not-sent (check the inbox first)')
        reconcile(s, args.day, args.sent); print('Recorded.')
    elif args.command == 'export-application':
        from .snapshot import export
        print(json.dumps(export(s, args.job), indent=2, ensure_ascii=False))
    elif args.command in ('backup', 'restore'):
        from . import ops
        if not args.file:
            raise SystemExit('--file is required')
        print(json.dumps(ops.backup(s, args.file) if args.command == 'backup' else ops.restore(args.file, paths.db_path(), confirmed=args.confirmed), indent=2))
    elif args.command == 'coverage':
        from . import coverage
        print(json.dumps(coverage.matrix(s), indent=2))
    elif args.command == 'import-job':
        from . import coverage
        if not (args.url and args.file and args.company and args.title):
            raise SystemExit('import-job needs --url, --company, --title and --file (the pasted job description)')
        job = coverage.import_job(s, args.url, args.company, args.title, Path(args.file).read_text(encoding='utf-8'), args.country)
        print('Imported as ' + job['id'] + '. The live posting is checked again before any application.')


if __name__ == '__main__':
    main()
