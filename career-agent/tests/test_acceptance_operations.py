"""Acceptance cases for reporting, the local API and dashboard, budget, operations, interview and coverage.

T35-T42, T45-T48, T50, T51 and B19. Fictional data; no e-mail leaves the test (fake transports).
"""
import json, os, smtplib, socket, sqlite3, subprocess, sys, tempfile, threading, unittest, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo
from agent import budget, coverage, interview, launch, llm, ops, outcomes, paths, report as report_mod, versions, worker
from agent.store import Store
from tests.helpers import DataDir, ROOT, fixture_job, profile

UTC = ZoneInfo('UTC'); LONDON = ZoneInfo('Europe/London')
TOKEN = 'test-token-0123456789-abcdefghij'


def next_nine():
    """The next 09:00 London after the real current time: events made now fall inside its 24-hour window."""
    from datetime import timedelta
    n = datetime.now(LONDON); nine = n.replace(hour=9, minute=0, second=0, microsecond=0)
    return nine if nine > n else nine + timedelta(days=1)


def wait_text(page, selector, needle, timeout=10):
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle in (page.text_content(selector) or ''):
            return
        page.wait_for_timeout(100)
    raise AssertionError(f'{needle!r} not in {selector}: {page.text_content(selector)!r}')


def submitted_store(path=':memory:', job_id='fixture'):
    s = Store(path); j = fixture_job(id=job_id); s.put_job(j); s.draft(j, {'cv_text': 'Led contractor governance on a £40M rail depot upgrade. (fictional)', 'cover_letter': 'Dear Hiring Manager'})
    s.transition(job_id, 'ready'); s.transition(job_id, 'submitting')
    s.transition(job_id, 'submitted', {'receipt': 'https://jobs.example.org/thanks | TEST application received — FIXTURE-001', 'receipt_kind': 'adapter_verified'})
    return s


class T35_T37_Schedule(unittest.TestCase):
    def test_T35_sent_at_09_00_not_before_with_recipient_and_links(self):
        s = submitted_store(); sent = []
        with patch.dict(os.environ, {'REPORT_TO': 'applicant@example.org', 'SMTP_FROM': 'agent@example.org'}):
            from datetime import timedelta
            nine = next_nine()
            self.assertIsNone(report_mod.tick(s, nine - timedelta(seconds=1), sent.append))
            self.assertEqual(report_mod.tick(s, nine, sent.append), 'sent')
        msg = sent[0]
        self.assertEqual(msg['To'], 'applicant@example.org'); self.assertTrue(msg['Message-ID'])
        body = msg.get_content()
        self.assertIn('SUBMITTED (with a receipt): 1', body); self.assertIn('https://127.0.0.1:8766/application.html', body); self.assertIn('FIXTURE-001', body)
        self.assertNotIn('LATE', body)

    def test_T36_09_00_london_across_both_clock_changes_once_per_day(self):
        s = Store(':memory:'); sent = []
        cases = [(datetime(2026, 10, 24, 7, 59, tzinfo=UTC), None), (datetime(2026, 10, 24, 8, 0, tzinfo=UTC), 'sent'),      # BST: 09:00 = 08:00 UTC
                 (datetime(2026, 10, 25, 8, 30, tzinfo=UTC), None), (datetime(2026, 10, 25, 9, 0, tzinfo=UTC), 'sent'),      # GMT from 25 Oct: 09:00 = 09:00 UTC
                 (datetime(2027, 3, 27, 8, 59, tzinfo=UTC), None), (datetime(2027, 3, 27, 9, 0, tzinfo=UTC), 'sent'),        # GMT
                 (datetime(2027, 3, 28, 7, 59, tzinfo=UTC), None), (datetime(2027, 3, 28, 8, 0, tzinfo=UTC), 'sent'),        # BST from 28 Mar: 09:00 = 08:00 UTC
                 (datetime(2027, 3, 28, 20, 0, tzinfo=UTC), None)]
        for instant, expected in cases:
            self.assertEqual(report_mod.tick(s, instant, sent.append), expected, instant)
        days = [r[0] for r in s.db.execute('SELECT day FROM digests ORDER BY day')]
        self.assertEqual(days, ['2026-10-24', '2026-10-25', '2027-03-27', '2027-03-28'])

    def test_T37_a_host_off_at_09_00_sends_one_labelled_catch_up(self):
        s = submitted_store(); sent = []
        self.assertEqual(report_mod.tick(s, datetime(2026, 11, 3, 11, 0, tzinfo=LONDON), sent.append), 'sent')
        self.assertIsNone(report_mod.tick(s, datetime(2026, 11, 3, 11, 5, tzinfo=LONDON), sent.append))  # restarted again
        self.assertEqual(len(sent), 1)
        self.assertIn('LATE: catch-up report', sent[0].get_content()); self.assertTrue(sent[0]['Subject'].startswith('LATE'))
        self.assertEqual(s.db.execute('SELECT catch_up FROM digests').fetchone()[0], 1)


class T38_Outbox(unittest.TestCase):
    def test_refused_is_retried_ambiguous_is_never_resent_and_can_be_reconciled(self):
        s = Store(':memory:'); attempts = []
        def refuse(msg):
            attempts.append('refused'); raise smtplib.SMTPRecipientsRefused({'applicant@example.org': (550, b'no')})
        self.assertEqual(report_mod.tick(s, datetime(2026, 11, 4, 9, 0, tzinfo=LONDON), refuse), 'failed')
        self.assertEqual(report_mod.tick(s, datetime(2026, 11, 4, 9, 1, tzinfo=LONDON), lambda m: attempts.append('ok')), 'sent')
        self.assertEqual(attempts, ['refused', 'ok'])
        def timeout(msg):
            attempts.append('timeout'); raise socket.timeout('timed out after DATA')
        self.assertEqual(report_mod.tick(s, datetime(2026, 11, 5, 9, 0, tzinfo=LONDON), timeout), 'failed_or_uncertain')
        self.assertIsNone(report_mod.tick(s, datetime(2026, 11, 5, 9, 30, tzinfo=LONDON), lambda m: attempts.append('again')))
        self.assertNotIn('again', attempts)
        report_mod.reconcile(s, '2026-11-05', sent=True)
        self.assertEqual(s.db.execute("SELECT status FROM digests WHERE day='2026-11-05'").fetchone()[0], 'sent')
        with self.assertRaises(ValueError):
            report_mod.reconcile(s, '2026-11-05', sent=True)


class T39_EventCounts(unittest.TestCase):
    def test_a_submission_and_its_interview_count_once_each_and_not_again_next_day(self):
        s = submitted_store()
        outcomes.add(s, 'fixture', 'interview_invitation', '2026-11-06', 'Recruiter e-mail, pasted: please come in on Friday. (fictional)')
        sent = []
        report_mod.tick(s, next_nine(), sent.append)
        body = sent[0].get_content()
        self.assertIn('SUBMITTED (with a receipt): 1', body); self.assertIn('INTERVIEW INVITATIONS: 1', body)
        self.assertEqual(s.application('fixture')['status'], 'interview')
        later = datetime(2099, 1, 1, 9, 0, tzinfo=LONDON)
        report_mod.tick(s, later, sent.append)
        self.assertIn('SUBMITTED (with a receipt): 0', sent[1].get_content())
        self.assertEqual(outcomes.metrics(s)['verified_submissions'], 1); self.assertEqual(outcomes.metrics(s)['interview_invitation'], 1)
        with self.assertRaises(ValueError):
            outcomes.add(s, 'fixture', 'interview_booked', '2026-11-06', '   ')  # evidence required


class API(unittest.TestCase):
    def setUp(self):
        from agent.server import make_server
        self.data = DataDir().__enter__()
        self.env = patch.dict(os.environ, {'CAREER_AGENT_TOKEN': TOKEN}); self.env.start()
        self.store = submitted_store(paths.db_path())
        self.server = make_server(0); self.base = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.store.close(); self.env.stop(); self.data.__exit__(None, None, None)

    def call(self, method, path, body=None, token=TOKEN, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, method=method, data=data, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_T41_tokens_versions_and_validation(self):
        self.assertEqual(self.call('GET', '/api/health', token='wrong')[0], 401)
        status, health = self.call('GET', '/api/health'); self.assertEqual(status, 200)
        self.assertNotIn(TOKEN, json.dumps(health))
        status, apps = self.call('GET', '/api/applications')
        self.assertEqual(apps['applications'][0]['receipt_kind'], 'adapter_verified')
        self.assertEqual(self.call('GET', '/api/applications/..%2Fetc')[0], 400)
        v = health['policy_version']
        self.assertEqual(self.call('PATCH', '/api/policy', {'expected_version': 'stale', 'changes': {'enabled': False}})[0], 409)
        self.assertEqual(self.call('PATCH', '/api/policy', {'expected_version': v, 'changes': {'minimum_match': 50}})[0], 400)
        self.assertEqual(self.call('PATCH', '/api/policy', {'expected_version': v, 'changes': {'enabled': False}, 'extra': 1})[0], 400)
        status, out = self.call('PATCH', '/api/policy', {'expected_version': v, 'changes': {'enabled': False}})
        self.assertEqual(status, 200)
        self.assertEqual(self.call('PATCH', '/api/policy', {'expected_version': v, 'changes': {'enabled': True}})[0], 409)  # the newer state wins
        self.assertEqual(self.call('POST', '/api/practice', raw=b'not json')[0], 400)
        self.assertEqual(self.call('POST', '/api/applications/fixture/outcomes', {'kind': 'offer', 'date': 'yesterday', 'evidence': 'x'})[0], 400)
        self.assertEqual(self.call('GET', '/api/reports/2026-13-99')[0], 404 if False else 404)

    def test_T50_style_edits_keep_packs_factual_edits_need_confirmation(self):
        status, health = self.call('GET', '/api/health'); pv = health['profile_version']
        status, out = self.call('PATCH', '/api/profile', {'expected_version': pv, 'changes': {'headline': 'Construction delivery lead (fictional)'}})
        self.assertEqual(status, 200); self.assertFalse(out['packs_stale'])
        self.assertEqual(self.call('PATCH', '/api/profile', {'expected_version': out['profile_version'], 'changes': {'phone': '07700 900999'}})[0], 400)
        status, out2 = self.call('PATCH', '/api/profile', {'expected_version': out['profile_version'], 'changes': {'phone': '07700 900999'}, 'confirmed': True})
        self.assertEqual(status, 200); self.assertTrue(out2['packs_stale'])
        self.assertEqual(self.call('PATCH', '/api/profile', {'expected_version': out2['profile_version'], 'changes': {'name': 'Someone Else'}, 'confirmed': True})[0], 400)

    def test_claim_is_idempotent_and_results_need_a_correlated_receipt(self):
        j = fixture_job(id='second', url='https://127.0.0.1:8766/second.html', posting_id='second'); self.store.put_job(j)
        self.store.draft(j, {'human_reviewed': True, 'adapter': {'receipt_pattern': 'TEST application received — {posting_id}'}}); self.store.transition('second', 'ready')
        self.assertEqual(self.call('POST', '/api/applications/second/claim', {})[0], 400)
        s1, a1 = self.call('POST', '/api/applications/second/claim', {'idempotency_key': 'key-00000001'})
        s2, a2 = self.call('POST', '/api/applications/second/claim', {'idempotency_key': 'key-00000001'})
        self.assertEqual((s1, s2), (200, 200)); self.assertEqual(a1, a2)
        self.assertEqual(self.call('POST', '/api/applications/second/claim', {'idempotency_key': 'key-00000002'})[0], 409)
        att = a1['attempt_id']
        self.assertEqual(self.call('POST', f'/api/attempts/{att}/result', {'status': 'submitted', 'receipt': 'TEST application received — OTHER'})[0], 409)
        self.assertEqual(self.call('POST', f'/api/attempts/{att}/result', {'status': 'submitted', 'receipt': 'https://x | TEST application received — second'})[0], 200)
        self.assertEqual(self.store.application('second')['status'], 'submitted')


class T40_T48_Dashboard(unittest.TestCase):
    def test_disconnected_is_explicit_connected_shows_backend_receipts_and_practice_falls_back_to_typing(self):
        from agent.server import make_server
        from tests.test_worker import sync_playwright
        if sync_playwright is None:
            self.skipTest('Playwright is not installed')
        with DataDir(), patch.dict(os.environ, {'CAREER_AGENT_TOKEN': TOKEN}):
            s = submitted_store(paths.db_path())
            server = make_server(0); base = f'http://127.0.0.1:{server.server_port}'
            threading.Thread(target=server.serve_forever, daemon=True).start()
            errors = []
            try:
                with sync_playwright() as pw:
                    b = pw.chromium.launch(headless=True); page = b.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
                    # The microphone is refused: dictation reports it and typing carries on.
                    page.add_init_script("window.webkitSpeechRecognition = class { start() { setTimeout(() => this.onerror && this.onerror({ error: 'not-allowed' }), 20); } }; window.SpeechRecognition = undefined;")
                    page.goto(base + '/')
                    page.wait_for_selector('#connection-status')
                    self.assertIn('Not connected', page.text_content('#connection-status'))
                    page.click('nav button[data-ledger]'); self.assertIn('nothing here is live', page.text_content('#ledger-empty'))
                    page.fill('#agent-token', 'wrong-token-wrong-token-wrong')
                    page.click('#connect'); wait_text(page, '#connection-status', 'refused')
                    page.fill('#agent-token', TOKEN); page.click('#connect')
                    wait_text(page, '#connection-status', 'Connected')
                    self.assertIn('last sync', page.text_content('#connection-status'))
                    self.assertIn('FIXTURE-001', page.text_content('#ledger'))
                    page.click('#practice-dictate'); wait_text(page, '#practice-out', 'microphone refused')
                    page.fill('#practice-answer', 'I led contractor governance on a £90M hospital for Acme Projects, as a result we finished on time.')
                    page.click('#practice-go'); page.wait_for_selector('#practice-unsupported')
                    text = page.text_content('#practice-unsupported')
                    self.assertIn('£90M', text); self.assertIn('Acme Projects', text)
                    self.assertIn('Practice only', page.text_content('#practice-out'))
                    # A browser with no speech at all: the buttons are off and say why.
                    plain = b.new_page(); plain.add_init_script('delete window.webkitSpeechRecognition; delete window.SpeechRecognition; delete window.speechSynthesis;')
                    plain.route('**/api/**', lambda route: route.fulfill(status=401, body='{"error":"Unauthorized"}', content_type='application/json'))
                    plain.goto(base + '/'); plain.click('nav button[data-ledger]')
                    self.assertIn('Not connected', plain.text_content('#connection-status'))
                    server.shutdown(); server.server_close()  # the agent goes away: the page says feedback is unavailable, the answer stays
                    page.click('#practice-go'); wait_text(page, '#practice-out', 'unavailable')
                    self.assertTrue(page.input_value('#practice-answer'))
                    b.close()
            finally:
                server.server_close(); s.close()
            self.assertEqual(errors, [])


class T42_Budget(unittest.TestCase):
    ENV = {'OPENAI_API_KEY': 'test-key-not-real', 'LLM_MODEL': 'test-model'}

    def test_no_call_past_the_limit_unknown_prices_reserved_timeouts_charged_no_retry(self):
        s = Store(':memory:'); calls = []
        def ok(body, key):
            calls.append(1); return {'output': [{'content': [{'type': 'output_text', 'text': '{"a":1}'}]}], 'usage': {'input_tokens': 1000, 'output_tokens': 100}}
        with patch.dict(os.environ, self.ENV, clear=True), patch.object(llm, 'transport', ok):
            with self.assertRaises(budget.BudgetNotConfigured):
                llm.call('t', {}, s)
            self.assertEqual(calls, [])
        env = dict(self.ENV, LLM_BUDGET_GBP_DAILY='0.05', LLM_PRICE_GBP_PER_MTOK_INPUT='2', LLM_PRICE_GBP_PER_MTOK_OUTPUT='8')
        with patch.dict(os.environ, env, clear=True), patch.object(llm, 'transport', ok):
            self.assertEqual(llm.call('t', {}, s), {'a': 1})  # worst case 6000 output tokens = £0.048 reserved, actual far less
            spent = budget.spent(s); self.assertLess(spent, __import__('decimal').Decimal('0.01'))
            s.db.execute("INSERT INTO usage(at,local_day,provider,model,purpose,status,reserved,actual) VALUES('x',?,'p','m','x','ok',0.04,0.04)", (budget.london_day(),))
            with self.assertRaises(budget.BudgetExceeded):
                llm.call('t', {}, s)
            self.assertEqual(len(calls), 1)
        unknown = dict(self.ENV, LLM_BUDGET_GBP_DAILY='1', LLM_UNKNOWN_PRICE_RESERVE_GBP='0.30')
        def slow(body, key):
            calls.append(1); raise socket.timeout('provider timeout')
        s2 = Store(':memory:')
        with patch.dict(os.environ, unknown, clear=True), patch.object(llm, 'transport', slow):
            with self.assertRaises(socket.timeout):
                llm.call('t', {}, s2)
        row = s2.db.execute('SELECT status, actual FROM usage').fetchone()
        self.assertEqual(row['status'], 'uncertain'); self.assertAlmostEqual(row['actual'], 0.30)
        self.assertEqual(len(calls), 2)  # one each: never retried
        self.assertIn('budget_reached', [e['kind'] for e in s.events()])


class T45_T46_Operations(unittest.TestCase):
    def test_T45_preflight_fails_with_specific_fixes_and_launch_refuses(self):
        with DataDir(), patch.dict(os.environ, {}, clear=False):
            for k in ('OPENAI_API_KEY', 'LLM_MODEL', 'LLM_BUDGET_GBP_DAILY', 'SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM', 'REPORT_TO'):
                os.environ.pop(k, None)
            s = Store(paths.db_path()); report = worker.preflight(s)
            self.assertFalse(report['ready'])
            joined = '\n'.join(report['problems'])
            for needle in ('OPENAI_API_KEY missing', 'LLM_BUDGET_GBP_DAILY missing', 'SMTP_HOST', 'No certified route'):
                self.assertIn(needle, joined)
            self.assertIn('NOT configured', report['email'])
            with self.assertRaises(SystemExit) as e:
                worker.main(['--preflight'])
            self.assertEqual(e.exception.code, 1)
            with self.assertRaises(SystemExit) as e:
                launch.main(['--submit', '--no-email'])
            self.assertEqual(e.exception.code, 1)
            s.close()

    def test_T46_partial_start_leaves_no_orphans(self):
        started = []
        class Child:
            def __init__(self, cmd, cwd=None):
                if cmd == ['broken']:
                    raise OSError('cannot start')
                self.alive = True; started.append(self)
            def poll(self):
                return None if self.alive else 0
            def terminate(self):
                self.alive = False
            def wait(self, timeout=None):
                return 0
            def kill(self):
                self.alive = False
        with self.assertRaises(OSError):
            launch.supervise([['discovery'], ['broken'], ['report']], popen=Child, poll_seconds=0)
        self.assertEqual(len(started), 1); self.assertFalse(started[0].alive)

    def test_T46_contention_disk_full_and_backup_restore(self):
        d = tempfile.mkdtemp(); path = os.path.join(d, 'ledger.sqlite3')
        s = submitted_store(path); j = fixture_job(id='other'); s.put_job(j); s.draft(j, {}); s.transition('other', 'ready')
        blocker = sqlite3.connect(path, timeout=0.1); blocker.execute('BEGIN IMMEDIATE')
        quick = Store(path, timeout=0.2)
        with self.assertRaises(sqlite3.OperationalError):
            quick.claim('other', actor='worker-auto')
        blocker.rollback(); blocker.close()
        self.assertEqual(quick.application('other')['status'], 'ready'); self.assertEqual(quick.attempts('other'), [])
        self.assertEqual(quick.db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        with DataDir():
            from agent import snapshot
            with patch('agent.snapshot.os.open', side_effect=OSError(28, 'No space left on device')):
                with self.assertRaises(OSError):
                    snapshot.seal({'attempt_id': 'att-x', 'x': 1}, {'documents': {}, 'document_hashes': {}}, 'other')
        manifest = ops.backup(s, os.path.join(d, 'backup.sqlite3'))
        self.assertEqual(manifest['integrity'], 'ok'); self.assertEqual(manifest['counts']['applications'], 2)
        restored = os.path.join(d, 'restored.sqlite3')
        with DataDir():
            with self.assertRaises(SystemExit):
                ops.restore(os.path.join(d, 'backup.sqlite3'), restored)
            first = ops.restore(os.path.join(d, 'backup.sqlite3'), restored, confirmed=True)
            second = ops.restore(os.path.join(d, 'backup.sqlite3'), restored, confirmed=True)
        self.assertEqual(first['counts'], second['counts']); self.assertEqual(first['integrity'], 'ok')
        self.assertEqual(Store(restored).application('fixture')['status'], 'submitted')


class T47_Interview(unittest.TestCase):
    def test_questions_come_from_the_actual_pack_and_unsupported_claims_are_flagged(self):
        s = submitted_store()
        q = interview.questions(interview.materials(s, 'fixture'))
        self.assertIn('“contractor governance”', q['questions'][0]['question']); self.assertEqual(q['questions'][0]['kind'], 'evidence')
        fb = interview.practice(s, 'fixture', 'Contractor governance?', 'When we were on the rail depot, I led contractor governance on the £40M upgrade; as a result we finished on time.')
        self.assertEqual(fb['feedback']['unsupported_claims'], []); self.assertTrue(fb['practice_only'])
        fb = interview.practice(s, 'fixture', 'Contractor governance?', 'I managed a £300M airport for Vantage Holdings with PMP certification.')
        self.assertEqual(sorted(fb['feedback']['unsupported_claims']), ['PMP', 'Vantage Holdings', '£300M'])
        with patch.dict(os.environ, {'OPENAI_API_KEY': '', 'LLM_MODEL': ''}):
            out = interview.practice(s, 'fixture', 'q', 'I led contractor governance.', use_llm=True)
        self.assertIn('unavailable', out['feedback']['llm_error']); self.assertIn('star', out['feedback'])
        with self.assertRaises(LookupError):
            interview.materials(s, 'missing')


class T51_Coverage(unittest.TestCase):
    def test_the_matrix_measures_markets_and_claims_nothing_more(self):
        with DataDir():
            s = submitted_store(paths.db_path())
            m = coverage.matrix(s)
            self.assertEqual(m['markets']['United Kingdom']['receipts'], 1)
            self.assertIn('not whole-internet coverage', m['statement'])
            self.assertGreaterEqual(m['markets']['United Kingdom']['registered_targets'], 10)
            reg = coverage.registry()
            self.assertTrue(20 <= len(reg) <= 50); self.assertTrue(all(not e['terms_checked'] for e in reg))  # nothing claimed as checked
            job = coverage.import_job(s, 'https://jobs.example.org/p/77?utm_source=mail', 'Example Build (fictional)', 'Senior Construction Manager',
                                      'Fictional pasted advert: lead construction delivery and contractor governance on a hospital scheme.')
            self.assertTrue(job['import_unverified']); self.assertEqual(job['provenance'][0]['by'], 'applicant'); self.assertEqual(job['country'], 'Unconfirmed')
            with self.assertRaises(Exception):
                coverage.import_job(s, 'http://jobs.example.org/x', 'X', 'Y', 'z' * 50)
            s.close()


if __name__ == '__main__':
    unittest.main()
