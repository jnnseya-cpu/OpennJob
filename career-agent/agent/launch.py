"""One local command supervises discovery, the worker and the 09:00 report (R22; T45, T46).

  python3 -m agent.launch --submit [--no-email] [--max-matches 10]

--submit refuses to start while preflight shows a problem (browser, LLM key and budget, certified
route, confirmed profile, SMTP). --no-email starts without the report and says plainly that the
run is incomplete. If any component fails to start, or later stops, every other component is
stopped too: no orphan processes are left behind.
"""
import argparse, os, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def supervise(commands, popen=subprocess.Popen, poll_seconds=2, stop=None):
    children = []
    try:
        for c in commands:
            children.append(popen(c, cwd=ROOT))
        print('Local trial running. Computer must stay awake and connected. Ctrl+C stops all components.', flush=True)
        while not (stop and stop()):
            if any(ch.poll() is not None for ch in children):
                raise RuntimeError('A component stopped; inspect its error and restart after reconciliation.')
            time.sleep(poll_seconds)
    except KeyboardInterrupt:
        pass
    finally:
        for ch in children:
            if ch.poll() is None:
                ch.terminate()
        for ch in children:
            try:
                ch.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ch.kill(); ch.wait()
    return children


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.launch')
    p.add_argument('--submit', action='store_true'); p.add_argument('--no-email', action='store_true'); p.add_argument('--max-matches', type=int, default=10)
    a = p.parse_args(argv)
    from . import paths
    from .store import Store
    from .worker import preflight
    report = preflight(Store(paths.db_path()))
    problems = [x for x in report['problems'] if not (a.no_email and x.startswith('SMTP_HOST'))]
    if a.submit and problems:
        print('Not starting: fix these first.', *problems, sep='\n- ', file=sys.stderr)
        raise SystemExit(1)
    if a.no_email:
        print('Starting WITHOUT the 09:00 report: this run is incomplete.', flush=True)
    commands = [[sys.executable, '-m', 'agent.discovery', '--max-matches', str(a.max_matches)], [sys.executable, '-m', 'agent.worker'] + (['--submit'] if a.submit else [])]
    if not a.no_email:
        commands.append([sys.executable, '-m', 'agent.cli', 'schedule'])
    supervise(commands)


if __name__ == '__main__':
    main()
