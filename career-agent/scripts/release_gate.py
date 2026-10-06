"""Release gate (B16): run everything, map results to T01-T60, write the acceptance register.

  python3 scripts/release_gate.py            writes docs/ACCEPTANCE.md and docs/acceptance.json
  python3 scripts/release_gate.py --check    also exits 1 when any P0 automated case failed

"Passed" means an automated test named for the case ran and passed in this run. Cases that need
the real world (a genuine employer receipt, an inbox delivery, human-labelled data) are "Not run"
with the reason. Cases the owner's rules exclude are "Decided against". Commercial cases stay off.
Nothing personal is written: tests use fictional data only.
"""
import hashlib, io, json, os, platform, re, subprocess, sys, unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

# case -> (priority, title, test-name patterns or None, status when no automated test, note)
CASES = {
    'T01': ('P0', 'Regression: unit, compile and JS syntax', [r'.'], None, 'The whole suite, compileall and node --check.'),
    'T02': ('P0', 'Clean install from the lock', [], 'Passed (manual)', 'Fresh venv from requirements.lock, full suite green, 6 October 2026; Chromium was the pre-installed build, playwright install was not run here.'),
    'T03': ('P0', 'Contracts: malformed fields, missing country, timestamps', [r'T03_'], None, ''),
    'T04': ('P0', 'Profile/policy v2 invalidates readiness; snapshot kept', [r'T04_'], None, ''),
    'T05': ('P0', 'Separate JD and apply URLs; formatting vs material change', [r'T05_'], None, ''),
    'T06': ('P0', 'Three search profiles without employer accounts', [r'T06_'], None, ''),
    'T07': ('P0', 'Multi-page sources; no starvation; truncation explicit', [r'T07_T08_Sources\.test_a_capped'], None, ''),
    'T08': ('P0', '429/503 bounded backoff; healthy source continues', [r'T07_T08_Sources\.test_429', r'test_malformed_postings'], None, ''),
    'T09': ('P0', 'One canonical posting across seed, feed, import, profiles', [r'T09_'], None, ''),
    'T10': ('P0', 'Withdrawn, closed or past-deadline: no click', [r'T10_'], None, ''),
    'T11': ('P0', 'Score boundaries 79 to 100, raw Decimal', [r'T11_'], None, ''),
    'T12': ('P0', 'Malformed weights and states refused', [r'T12_'], None, ''),
    'T13': ('P0', 'Unknown essential blocks at 95', [r'T13_'], None, ''),
    'T14': ('P0', 'Prompt injection and invented evidence', [r'T14_'], None, 'Controlled adversarial examples with a model that obeys the injection.'),
    'T15': ('P0', 'Human-labelled 50-JD essential evaluation', None, 'Not run', 'Needs 50 human-labelled job descriptions. None were supplied and a developer cannot label them as the applicant would.'),
    'T16': ('P0', 'Unreviewed extraction blocks; review opens it, no new permission', [r'T16_'], None, ''),
    'T17': ('P0', 'Country rights and sponsorship eligibility', [r'T17_'], None, ''),
    'T18': ('P0', 'Revocation after fill: zero clicks', [r'T18_'], None, ''),
    'T19': ('P0', 'Exclusion added mid-cycle', [r'T18_T19_FinalCheck'], None, ''),
    'T20': ('P0', 'Cap race at 19/20 and London midnight', [r'test_cap_race'], None, ''),
    'T21': ('P0', 'Fill, select, upload; exact bytes; changed question blocks', [r'test_T21_'], None, 'Ticking a "confirmed declaration" is decided against (CLAUDE.md rule 1): the agent never ticks a declaration.'),
    'T22': ('P0', 'Redirect, iframe, multi-step, unsupported routes', [r'test_T22_'], None, ''),
    'T23': ('P0', 'Unknown mandatory answers never invented', [r'test_T23_'], None, ''),
    'T24': ('P0', 'Demographics, defaults, new declaration', [r'test_T24_'], None, 'Required consent "from a confirmed mapping" is decided against: consent boxes are always the applicant\'s.'),
    'T25': ('P0', 'Documents: searchable text, complete, truthful', [r'T25_'], None, ''),
    'T26': ('P0', 'Edits invalidate packs; sent files untouched', [r'test_T26_', r'test_reviewed_route_passes_and_pack_tampering'], None, ''),
    'T27': ('P0', 'Two actors, one atomic claim', [r'test_two_connections_racing', r'test_the_extension_cannot_claim'], None, ''),
    'T28': ('P0', 'Second worker, stale lock, active extension', [r'T28_'], None, ''),
    'T29': ('P0', 'Crash before, during and after the click', [r'test_T29_', r'test_a_claim_without_a_click'], None, ''),
    'T30': ('P0', 'Already submitted or uncertain: no second click', [r'test_T21_exact_values', r'test_T26_', r'test_restart_no_duplicate'], None, ''),
    'T31': ('P0', 'Full application record reconstructable', [r'test_T26_T30_T31'], None, ''),
    'T32': ('P0', 'Discovery to submit with no per-job click', [r'test_T32_'], None, 'Against a local simulated employer server, not a real employer.'),
    'T33': ('P0', 'Receipt rules and correlation', [r'test_T33_'], None, ''),
    'T34': ('P0', 'Screenshot failure keeps a proven receipt', [r'test_T34_'], None, ''),
    'T35': ('P0', '09:00 London, not before', [r'test_T35_'], None, ''),
    'T36': ('P0', 'DST: 25 Oct 2026 and 28 Mar 2027', [r'test_T36_'], None, ''),
    'T37': ('P0', 'Host off at 09:00: one labelled catch-up', [r'test_T37_'], None, ''),
    'T38': ('P0', 'Mail refused, ambiguous, succeeded', [r'T38_'], None, 'Fake transports. A real inbox delivery is part of T52.'),
    'T39': ('P0', 'Event counts across digest boundaries', [r'T39_'], None, ''),
    'T40': ('P0', 'Dashboard disconnected and connected', [r'T40_T48_'], None, ''),
    'T41': ('P0', 'API tokens and optimistic versions', [r'test_T41_', r'test_claim_is_idempotent'], None, ''),
    'T42': ('P0', 'LLM budget: limit, unknown price, timeout', [r'T42_'], None, ''),
    'T43': ('P0', 'Failing route quarantined; others continue', [r'quarantines_the_route'], None, ''),
    'T44': ('P0', 'Unsafe URLs, paths, ids; secret scan', [r'T44_'], None, ''),
    'T45': ('P0', 'Preflight fails with fixes; launch refuses', [r'test_T45_'], None, ''),
    'T46': ('P0', 'Contention, disk full, partial start, backup/restore', [r'test_T46_'], None, ''),
    'T47': ('P1', 'Interview from the actual pack', [r'T47_'], None, 'Deterministic checks; a real LLM coaching call was not made.'),
    'T48': ('P1', 'Practice with speech unavailable or refused', [r'T40_T48_'], None, ''),
    'T49': ('P1', 'Salary history is not a floor', [r'T49_'], None, ''),
    'T50': ('P1', 'Style vs factual edits', [r'test_T50_', r'T04_'], None, ''),
    'T51': ('P1', 'Coverage matrix by market', [r'T51_'], None, ''),
    'T52': ('P0', 'Live release: genuine application and real report', None, 'Not run', 'Needs the applicant\'s certified route on a real, relevant, open vacancy, the real SMTP account and inbox. Not possible from this build environment.'),
    **{f'T{n}': ('Commercial', 'Commercial acceptance', None, 'Not run (commercial off)', 'B20-B22 are out of the personal release by decision; no other applicants, no Stripe.') for n in range(53, 61)},
}


class Collector(unittest.TextTestResult):
    def __init__(self, *a, **k):
        super().__init__(*a, **k); self.outcomes = {}

    def addSuccess(self, test):
        super().addSuccess(test); self.outcomes[test.id()] = 'pass'

    def addFailure(self, test, err):
        super().addFailure(test, err); self.outcomes[test.id()] = 'fail'

    def addError(self, test, err):
        super().addError(test, err); self.outcomes[test.id()] = 'error'

    def addSkip(self, test, reason):
        super().addSkip(test, reason); self.outcomes[test.id()] = 'skip'


def run_suite():
    suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'))
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2, resultclass=Collector).run(suite)
    return result


def checks():
    out = {}
    out['compileall'] = subprocess.run([sys.executable, '-m', 'compileall', '-q', 'agent'], capture_output=True).returncode == 0
    for js in ('extension/popup.js', 'dashboard/app.js', 'dashboard/connect.js'):
        out['node --check ' + js] = subprocess.run(['node', '--check', js], capture_output=True).returncode == 0
    return out


def manifest():
    files = sorted(p for d in ('agent', 'dashboard', 'extension', 'contracts', 'scripts') for p in (ROOT / d).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name != 'data.json')
    files += [ROOT / f for f in ('requirements.txt', 'requirements.lock')]
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


def main():
    result = run_suite(); static = checks()
    outcomes = result.outcomes
    total = {'run': result.testsRun, 'passed': sum(v == 'pass' for v in outcomes.values()), 'failed': sum(v in ('fail', 'error') for v in outcomes.values()), 'skipped': sum(v == 'skip' for v in outcomes.values())}
    rows = []
    for case, (priority, title, patterns, fallback, note) in CASES.items():
        if patterns is None or patterns == []:
            rows.append({'case': case, 'priority': priority, 'title': title, 'result': fallback, 'tests': [], 'note': note}); continue
        if case == 'T01':
            ok = total['failed'] == 0 and total['skipped'] == 0 and all(static.values())
            rows.append({'case': case, 'priority': priority, 'title': title, 'result': 'Passed' if ok else 'FAILED', 'tests': [f"{total['passed']} of {total['run']} tests"], 'note': note}); continue
        matched = {t: v for t, v in outcomes.items() if any(re.search(p, t) for p in patterns)}
        if not matched:
            status = 'NO TEST FOUND'
        elif any(v in ('fail', 'error') for v in matched.values()):
            status = 'FAILED'
        elif any(v == 'skip' for v in matched.values()):
            status = 'Skipped (not run)'
        else:
            status = 'Passed'
        rows.append({'case': case, 'priority': priority, 'title': title, 'result': status, 'tests': sorted(t.split('.', 1)[1] for t in matched), 'note': note})
    env = {'run_at_utc': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'python': platform.python_version(), 'platform': platform.platform()}
    try:
        from importlib.metadata import version
        env.update({p: version(p) for p in ('playwright', 'reportlab', 'python-docx', 'jsonschema')})
    except Exception:
        pass
    env['chromium'] = os.getenv('CAREER_BROWSER_EXECUTABLE') or os.getenv('PLAYWRIGHT_BROWSERS_PATH', 'Playwright default')
    try:
        env['commit'] = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    except OSError:
        env['commit'] = 'unknown'
    data = {'environment': env, 'totals': total, 'static_checks': static, 'cases': rows, 'source_manifest': manifest()}
    docs = ROOT / 'docs'; docs.mkdir(exist_ok=True)
    (docs / 'acceptance.json').write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    lines = ['# Acceptance register — NSEYA Career Agent (personal release)', '',
             f"Generated by `scripts/release_gate.py` at {env['run_at_utc']} on commit `{env['commit']}` (the commit before this file was regenerated).",
             f"Python {env['python']}, Playwright {env.get('playwright', '?')}, jsonschema {env.get('jsonschema', '?')}; browser: {env['chromium']}.", '',
             f"Automated run: **{total['passed']} passed, {total['failed']} failed, {total['skipped']} skipped** of {total['run']} tests. "
             f"Static checks: {', '.join(k + (' ok' if v else ' FAILED') for k, v in static.items())}.", '',
             'Passed means an automated test for the case ran and passed against fictional data and local fixtures. It is development evidence, '
             'not proof on a real employer\'s site: only T52 (a genuine receipt and a real report in the inbox) is that, and it has not been run.', '',
             '| Case | Priority | What | Result | Evidence / note |', '|---|---|---|---|---|']
    for r in rows:
        evidence = '; '.join(r['tests'][:4]) + (f' (+{len(r["tests"]) - 4} more)' if len(r['tests']) > 4 else '')
        lines.append(f"| {r['case']} | {r['priority']} | {r['title']} | {r['result']} | {(evidence + ('. ' if evidence and r['note'] else '') + r['note']).replace('|', '/')} |")
    (docs / 'ACCEPTANCE.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps(total), 'static', json.dumps(static))
    bad = [r['case'] for r in rows if r['priority'] == 'P0' and r['result'] in ('FAILED', 'NO TEST FOUND', 'Skipped (not run)')]
    print('P0 cases failing or missing:', bad or 'none')
    if '--check' in sys.argv and (bad or total['failed']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
