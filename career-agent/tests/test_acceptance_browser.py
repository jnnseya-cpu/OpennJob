"""Browser acceptance cases in real Chromium against local HTTPS fixtures (no employer is contacted).

T05 T10 T18 T21 T22 T23 T24 T25 T26 T29 T30 T31 T32 T33 T34 T43. The fixture server records
every POST it receives, so each test can say exactly what was, and was not, sent.
"""
import copy, hashlib, json, os, re, unittest
from pathlib import Path
from unittest.mock import patch
from agent import paths, policy as policy_mod, worker
from agent.core import Store
from agent.documents import build
from agent.routes import SCAN, schema_hash
from agent.snapshot import export
from tests.fixture_server import serve_https
from tests.helpers import DataDir, ROOT, fixture_job, library, policy, profile

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

POSTING = 'POSTING-100'


def standing_policy():
    p = policy()
    p.update(mode='standing_authorization', enabled=True, standing_authorization={'scope_version': policy_mod.SCOPE_VERSION, 'consent_at': '2026-10-06T08:00:00+00:00'})
    return p


@unittest.skipIf(sync_playwright is None, 'Playwright is not installed')
class Routes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = serve_https(ROOT / 'fixtures' / 'routes')
        cls.base = cls.server.base
        cls.pw = sync_playwright().start()
        exe = os.getenv('CAREER_BROWSER_EXECUTABLE')
        cls.browser = cls.pw.chromium.launch(headless=True, **({'executable_path': exe} if exe else {}))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown()

    def setUp(self):
        self.server.received.clear(); self.server.references.clear(); self.server.slow_receipt = False
        self.data = DataDir().__enter__()
        self.policy = standing_policy()
        (self.data.path / 'policy.json').write_text(json.dumps(self.policy))
        self.store = Store(paths.db_path())
        self.context = self.browser.new_context(ignore_https_errors=True)
        self.page = self.context.new_page()

    def tearDown(self):
        self.context.close(); self.store.close(); self.data.__exit__(None, None, None)

    # ----- helpers ------------------------------------------------------------------------
    def schema_of(self, name, form='#apply', frame=None):
        page = self.context.new_page(); page.goto(f'{self.base}/{name}')
        target = page.frame_locator(frame) if frame else page
        controls = target.locator(form).evaluate(SCAN); page.close()
        return schema_hash(controls)

    def route(self, name, certify_from=None, auto=True, **over):
        a = {'id': f'route-{name}', 'exact_url': f'{self.base}/{name}', 'reviewed': True, 'route_tested': True, 'jd_selector': '#jd', 'form_selector': '#apply',
             'fields': [{'selector': '#name', 'key': 'name'}, {'selector': '#email', 'key': 'email'}, {'selector': '#phone', 'key': 'phone'}],
             'uploads': [{'selector': '#cv', 'document': 'cv'}], 'submit_selector': '#send', 'receipt_selector': '#receipt',
             'receipt_pattern': 'TEST application received — {posting_id}', 'blocking_selectors': ['iframe[src*="recaptcha"]'], 'allowed_origins': [self.base]}
        a.update(over)
        cert = {'id': f'cert-{name}', 'form_schema_hash': self.schema_of(certify_from or name, frame=a.get('frame_selector')),
                'tested_at': '2026-10-06T08:00:00+00:00', 'auto_submit': auto, 'supervised_receipt': {'job_id': 'earlier', 'receipt': 'supervised (fictional)'} if auto else None}
        a['certification'] = {k: v for k, v in cert.items() if v is not None}
        return a

    def job(self, name, **extra):
        self.server.references[name.replace('.html', '')] = POSTING
        j = fixture_job(id=re.sub(r'\W', '-', name.replace('.html', '')), url=f'{self.base}/{name}', posting_id=POSTING)
        j.update(extra); self.store.put_job(j)
        return j

    def go(self, job, adapter, submit=True, pol=None, wait=6):
        return worker.execute(self.page, self.store, job, profile(), pol or self.policy, adapter, library(), submit, wait_seconds=wait)

    def status(self, job_id):
        app = self.store.application(job_id)
        return app['status'] if app else None

    # ----- T21 T32: automatic submission on a certified route --------------------------------
    def test_T21_exact_values_and_bytes_are_submitted_once_without_approval(self):
        j = self.job('plain.html'); a = self.route('plain.html')
        r = self.go(j, a)
        self.assertEqual(r['status'], 'submitted', r); self.assertEqual(r['initiated_by'], 'agent')
        self.assertEqual(len(self.server.received), 1)
        sent = self.server.received[0]
        self.assertEqual(sent['fields'], {'name': 'Alex Example', 'email': 'alex.example@example.org', 'phone': '07700 900123'})
        app = self.store.application(j['id'])
        self.assertEqual(sent['files']['cv']['sha256'], app['payload']['document_hashes']['cv'])
        self.assertEqual(sent['files']['cv']['filename'], 'cv.pdf')
        self.assertIn(POSTING, app['payload']['receipt']); self.assertEqual(app['payload']['receipt_kind'], 'adapter_verified')
        attempt = self.store.attempts(j['id'])[0]
        self.assertEqual(attempt['actor'], 'worker-auto'); self.assertTrue(attempt['clicked_at']); self.assertEqual(attempt['status'], 'submitted')
        # T30: rediscovered and regenerated, it is never sent again.
        self.assertEqual(self.go(j, a)['status'], 'needs_input'); self.assertEqual(len(self.server.received), 1)

    def test_T21_a_form_that_changed_since_certification_blocks_and_T43_quarantines_the_route(self):
        j = self.job('changed.html'); a = self.route('changed.html', certify_from='plain.html')
        for i in range(3):
            r = self.go(j, a)
            self.assertEqual(r['status'], 'needs_input'); self.assertIn('changed since the route was certified', r['reason'])
        self.assertIn('quarantined', r['reason'])
        self.assertTrue(self.store.route('route-changed.html')['quarantined'])
        r = self.go(j, a)
        self.assertIn('is quarantined', r['reason'])
        self.assertEqual(self.server.received, [])
        # Other healthy routes keep working.
        self.assertEqual(self.go(self.job('plain.html'), self.route('plain.html'))['status'], 'submitted')

    def test_T32_discovery_to_submit_without_any_per_job_click(self):
        from agent import discovery, llm, review
        feed = [{'id': 'feed-1', 'posting_id': POSTING, 'company': 'Local fixture', 'source': 'greenhouse', 'title': 'Senior Construction Manager',
                 'location': 'Birmingham', 'url': f'{self.base}/plain.html', 'jd_url': f'{self.base}/plain.html', 'country': 'United Kingdom', 'work_type': 'permanent',
                 'description': 'Construction delivery leadership and contractor governance.', 'requirements': [], 'fetched_at': '2026-10-06T08:00:00+00:00'}]
        (self.data.path / 'boards.json').write_text(json.dumps([{'company': 'Local fixture', 'type': 'greenhouse', 'board': 'local'}]))
        profiles = json.loads((self.data.path / 'search_profiles.json').read_text())
        for p in profiles:
            p['confirmed'] = True
        (self.data.path / 'search_profiles.json').write_text(json.dumps(profiles))
        model = {'requirements': [{'text': 'Contractor governance', 'jd_quote': 'contractor governance', 'weight': 100, 'state': 'met', 'evidence_ids': ['E02'], 'hard': True, 'reason': ''}]}
        env = {'OPENAI_API_KEY': 'test-key-not-real', 'LLM_MODEL': 'test-model', 'LLM_BUDGET_GBP_DAILY': '1', 'LLM_PRICE_GBP_PER_MTOK_INPUT': '2', 'LLM_PRICE_GBP_PER_MTOK_OUTPUT': '8'}
        reply = lambda body, key: {'output': [{'content': [{'type': 'output_text', 'text': json.dumps(model)}]}], 'usage': {'input_tokens': 900, 'output_tokens': 120}}
        with patch.dict(os.environ, env), patch.object(discovery, 'fetch', lambda board, *a, **k: copy.deepcopy(feed)), patch.object(llm, 'transport', reply):
            discovery.once(self.store, max_matches=5)
        job = self.store.jobs()[0]
        self.assertEqual(job['profile_ids'], ['uk-permanent']); self.assertTrue(job['preferences_confirmed']); self.assertFalse(job['matching_reviewed'])
        review.main(['review-matching', '--job', job['id'], '--confirmed'])  # first-trial quality control, not a submit permission
        self.server.references['plain'] = POSTING
        adapter = self.route('plain.html'); (paths.sub('adapters')).mkdir(parents=True, exist_ok=True)
        (paths.sub('adapters') / 'plain.json').write_text(json.dumps(adapter))
        results = worker.cycle(self.store, self.context, submit=True, wait_seconds=6)
        self.assertEqual([r['status'] for r in results], ['submitted'], results)
        self.assertEqual(len(self.server.received), 1)
        self.assertEqual([e['kind'] for e in self.store.events() if e['kind'].startswith('application_')], ['application_ready', 'application_submitting', 'application_submitted'])
        usage = self.store.db.execute('SELECT status, actual FROM usage').fetchall()
        self.assertEqual([u['status'] for u in usage], ['ok']); self.assertGreater(usage[0]['actual'], 0)

    # ----- T22: route families ----------------------------------------------------------------
    def test_T22_multistep_frame_and_redirect_routes(self):
        steps = [{'fields': [{'selector': '#name', 'key': 'name'}, {'selector': '#email', 'key': 'email'}], 'next_selector': '#next'}]
        multi = self.route('multistep.html', steps=steps, fields=[{'selector': '#phone', 'key': 'phone'}])
        r = self.go(self.job('multistep.html'), multi)
        self.assertEqual(r['status'], 'submitted', r)
        self.assertEqual(self.server.received[-1]['fields']['email'], 'alex.example@example.org')
        # A form inside an iframe works only on a route that declares the frame.
        framed = self.route('frame-host.html', frame_selector='#ats', jd_selector='#jd')
        framed['certification']['form_schema_hash'] = self.schema_of('frame-host.html', frame='#ats')
        frame_job = self.job('frame-host.html'); self.server.references['plain'] = POSTING  # the frame posts to /submit/plain
        r = self.go(frame_job, framed)
        self.assertEqual(r['status'], 'submitted', r)
        self.assertEqual(self.server.received[-1]['fields']['name'], 'Alex Example')
        before = len(self.server.received)
        unsupported = self.route('frame-host.html', certify_from='plain.html')
        r = self.go(self.job('frame-host.html', id='frame-2'), unsupported)
        self.assertEqual(r['status'], 'needs_input'); self.assertIn('form missing', r['reason'])
        self.assertEqual(len(self.server.received), before)
        # Redirects: an approved one is followed; any other stops.
        approved = self.route('plain.html', exact_url=f'{self.base}/redirect/plain.html', allowed_redirects=[f'{self.base}/plain.html'])
        self.assertEqual(self.go(self.job('plain.html', id='redir-ok', url=f'{self.base}/redirect/plain.html'), approved)['status'], 'submitted')
        unapproved = self.route('plain.html', exact_url=f'{self.base}/redirect/plain.html')
        r = self.go(self.job('plain.html', id='redir-bad', url=f'{self.base}/redirect/plain.html'), unapproved)
        self.assertIn('redirect', r['reason'])

    # ----- T23 T24: answers ---------------------------------------------------------------------
    def test_T23_unknown_required_answers_are_never_invented(self):
        j = self.job('unknown.html')
        a = self.route('unknown.html', fields=[{'selector': '#name', 'key': 'name'}, {'selector': '#email', 'key': 'email'}, {'selector': '#notice', 'key': 'notice_period'},
                                                {'selector': '#salary', 'key': 'expected_permanent_salary'}])
        r = self.go(j, a)
        self.assertEqual(r['status'], 'needs_input')
        self.assertEqual(self.page.input_value('#notice'), ''); self.assertEqual(self.page.input_value('#salary'), ''); self.assertEqual(self.page.input_value('#earliest'), '')
        reasons = [e['payload']['reason'] for e in self.store.events('needs_input')]
        self.assertTrue(any('notice_period' in x for x in reasons)); self.assertTrue(any('expected_permanent_salary' in x for x in reasons))
        self.assertTrue(any('Start date of your earliest role' in x for x in reasons))
        self.assertEqual(self.server.received, [])

    def test_T24_sensitive_questions_and_preselected_answers_hold_the_form(self):
        j = self.job('demographics.html'); a = self.route('demographics.html')
        r = self.go(j, a)
        self.assertEqual(r['status'], 'needs_input'); self.assertIn('sensitive questions', r['reason'])
        self.assertEqual(self.page.input_value('#gender'), 'female')  # untouched: the agent sets no sensitive answer
        reasons = ' '.join(e['payload']['reason'] for e in self.store.events('needs_input'))
        self.assertIn('Pre-selected answer on a sensitive question', reasons)
        self.assertEqual(self.server.received, []); self.assertEqual(self.store.attempts(j['id']), [])

    # ----- T33 T34: receipts ---------------------------------------------------------------------
    def test_T33_only_a_new_correlated_receipt_counts(self):
        r = self.go(self.job('already-received.html'), self.route('already-received.html'))
        self.assertIn('Receipt already present', r['reason']); self.assertEqual(self.server.received, [])
        j = self.job('plain.html'); self.server.references['plain'] = 'OTHER-999'  # a success page for another posting
        r = self.go(j, self.route('plain.html'))
        self.assertEqual(r['status'], 'uncertain'); self.assertIn('correlated', r['reason'])
        self.assertEqual(self.status(j['id']), 'uncertain')
        self.assertEqual(self.go(j, self.route('plain.html'))['status'], 'needs_input')  # never retried
        self.assertEqual(len(self.server.received), 1)

    def test_T33_no_receipt_after_the_click_is_uncertain(self):
        j = self.job('plain.html'); self.server.slow_receipt = True
        r = self.go(j, self.route('plain.html'), wait=2)
        self.assertEqual(r['status'], 'uncertain'); self.assertEqual(len(self.server.received), 1)

    def test_T34_a_proven_receipt_survives_a_screenshot_failure(self):
        j = self.job('plain.html')
        with patch.object(type(self.page), 'screenshot', side_effect=OSError('disk full')):
            r = self.go(j, self.route('plain.html'))
        self.assertEqual(r['status'], 'submitted')
        app = self.store.application(j['id'])
        self.assertIn('Screenshot could not be saved', app['payload']['screenshot_warning']); self.assertNotIn('screenshot', app['payload'])
        self.assertEqual(len(self.server.received), 1)

    # ----- T29: crashes ---------------------------------------------------------------------------
    def test_T29_crash_before_during_and_after_the_click(self):
        j = self.job('plain.html'); a = self.route('plain.html')
        with patch.object(Store, 'mark_clicked', side_effect=KeyboardInterrupt):  # killed before the click
            with self.assertRaises(KeyboardInterrupt):
                self.go(j, a)
        worker.recover(self.store)
        self.assertEqual(self.status(j['id']), 'failed'); self.assertEqual(self.server.received, [])
        j2 = self.job('plain.html', id='during')
        with patch.object(worker, '_await_receipt', side_effect=KeyboardInterrupt):  # killed during the click
            with self.assertRaises(KeyboardInterrupt):
                self.go(j2, a)
        worker.recover(self.store)
        self.assertEqual(self.status('during'), 'uncertain')
        posts = len(self.server.received)
        self.assertEqual(self.go(j2, a)['status'], 'needs_input')  # no automatic retry
        self.assertEqual(len(self.server.received), posts)

    # ----- T05 T10: the vacancy itself ------------------------------------------------------------
    def test_T05_separate_jd_page_normalises_formatting_and_blocks_a_material_change(self):
        a = self.route('apply-only.html', jd_url=f'{self.base}/jd.html', jd_selector='#advert p')
        self.assertEqual(self.go(self.job('apply-only.html'), a)['status'], 'submitted')
        self.assertEqual(len(self.store.jd_versions('apply-only')), 1)
        changed = self.route('apply-only.html', jd_url=f'{self.base}/jd-changed.html', jd_selector='#advert p')
        r = self.go(self.job('apply-only.html', id='apply-2'), changed)
        self.assertIn('description changed', r['reason']); self.assertEqual(len(self.server.received), 1)

    def test_T10_closed_or_gone_or_past_deadline_vacancies_are_never_clicked(self):
        closed = self.route('apply-only.html', jd_url=f'{self.base}/jd-closed.html', jd_selector='#advert p')
        j = self.job('apply-only.html'); self.store.draft(j, {}); self.store.transition(j['id'], 'ready')
        r = self.go(j, closed)
        self.assertEqual(r['status'], 'withdrawn'); self.assertEqual(self.status(j['id']), 'expired')
        self.assertEqual(self.store.job(j['id'])['status'], 'closed')
        gone = self.route('apply-only.html', jd_url=f'{self.base}/gone/jd.html', jd_selector='#advert p')
        self.assertEqual(self.go(self.job('apply-only.html', id='gone'), gone)['status'], 'withdrawn')
        late = self.job('plain.html', id='late', deadline='2020-01-01')
        self.assertEqual(self.go(late, self.route('plain.html'))['status'], 'withdrawn')
        self.assertEqual(self.server.received, [])

    # ----- T18: revocation after the fill ---------------------------------------------------------
    def test_T18_revoked_after_fill_before_click_means_zero_clicks(self):
        j = self.job('plain.html'); a = self.route('plain.html'); claim = Store.claim
        def claim_then_revoke(store, *args, **kwargs):
            out = claim(store, *args, **kwargs)
            revoked = dict(self.policy, enabled=False); (self.data.path / 'policy.json').write_text(json.dumps(revoked))
            return out
        with patch.object(Store, 'claim', claim_then_revoke):
            r = self.go(j, a)
        self.assertEqual(r['status'], 'not_submitted'); self.assertIn('disabled', r['reason'])
        self.assertEqual(self.server.received, []); self.assertEqual(self.status(j['id']), 'failed')
        self.assertIsNone(self.store.attempts(j['id'])[0]['clicked_at'])

    # ----- T26 T30 T31: what was sent stays reconstructable ----------------------------------------
    def test_T26_T30_T31_sealed_materials_survive_regeneration_and_export(self):
        j = self.job('plain.html'); a = self.route('plain.html')
        self.assertEqual(self.go(j, a)['status'], 'submitted')
        record = export(self.store, j['id'])
        self.assertTrue(record['attempts'][0]['documents_match'])
        snap = record['attempts'][0]['snapshot']
        self.assertEqual(snap['jd']['sha256'], hashlib.sha256(snap['jd']['normalized_text'].encode()).hexdigest())
        self.assertEqual([x['answer_key'] for x in snap['answers']], ['name', 'email', 'phone'])
        self.assertEqual(snap['scorecard']['raw_coverage'], '100')
        sealed = {p.name: p.read_bytes() for p in (paths.sub('packs') / j['id'] / 'attempts' / snap['attempt_id']).iterdir()}
        # Regenerate with an edited profile: the working pack changes, the sealed attempt does not.
        p2 = profile(); p2['phone'] = '07700 900999'
        build(j, p2, paths.sub('packs') / j['id'])
        self.assertEqual({p.name: p.read_bytes() for p in (paths.sub('packs') / j['id'] / 'attempts' / snap['attempt_id']).iterdir()}, sealed)
        self.assertTrue(export(self.store, j['id'])['attempts'][0]['documents_match'])
        folder = paths.sub('packs') / j['id'] / 'attempts' / snap['attempt_id']
        self.assertTrue(all(p.stat().st_mode & 0o222 == 0 for p in folder.iterdir()))  # written read-only
        from agent.snapshot import seal
        with self.assertRaises(FileExistsError):  # an attempt's folder is never written twice
            seal(snap, self.store.application(j['id'])['payload'], j['id'])


class T25_Documents(unittest.TestCase):
    def test_pdf_text_is_searchable_complete_and_truthful(self):
        import tempfile
        from agent.documents import pdf_text
        p = profile(); p['employment'] = [{'employer': 'Example Grid Ltd (fictional)', 'title': 'Construction Manager', 'start': '2022-12', 'end': '2025-12'},
                                          {'employer': 'Example Rail Ltd (fictional)', 'title': 'Site Manager', 'start': None, 'end': '2022-11'}]
        with tempfile.TemporaryDirectory() as d:
            pack = build(fixture_job(), p, d)
            text = pdf_text(Path(d) / 'cv.pdf')
            for part in ('Alex Example', 'alex.example@example.org', '07700 900123', 'Led contractor governance on a £40M rail depot upgrade. (fictional)',
                         'Example Grid Ltd (fictional) — Construction Manager | 2022-12–2025-12', 'Example Rail Ltd (fictional) — Site Manager | 2022-11'):
                self.assertIn(part, text)
            self.assertNotRegex(text, r'\[|TODO|PLACEHOLDER|REPLACE')
            self.assertNotIn('None', text)  # a missing start date is left out, never invented
            cover = pdf_text(Path(d) / 'cover.pdf')
            self.assertIn('Dear Hiring Manager', cover); self.assertIn('Yours sincerely', cover)
            # Long evidence wraps across pages without losing text.
            p['evidence'] = [dict(e, verified=True) for e in p['evidence']] + [{'id': f'L{i}', 'text': f'Delivered package {i} safely and to programme. (fictional)', 'verified': True} for i in range(70)]
            j = fixture_job(); j['requirements'][0]['evidence_ids'] = ['E02'] + [f'L{i}' for i in range(70)]
            pack = build(j, p, d)
            long_text = pdf_text(Path(d) / 'cv.pdf')
            self.assertIn('Delivered package 69 safely', long_text)
            self.assertGreaterEqual(len(re.findall(rb'/Type\s*/Page(?!s)', (Path(d) / 'cv.pdf').read_bytes())), 2)


if __name__ == '__main__':
    unittest.main()
