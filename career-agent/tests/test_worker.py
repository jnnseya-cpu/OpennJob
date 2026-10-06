"""The worker in real Chromium against the local fixture form (fixtures/application.html).

The applicant's own actions (answering the declarations, clicking submit) are played by a
script in the page, so the test can show that the worker itself never submits.
"""
import functools, http.server, json, os, threading, unittest
from pathlib import Path
from agent.core import Store
from agent import paths
from tests.helpers import DataDir, ROOT, profile, policy, library, fixture_job, fixture_adapter

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

APPLICANT = """
(() => {
  const act = () => {
    if (window.__careerApplicantSubmitted === undefined) return setTimeout(act, 100);
    document.querySelector('#rtw').value = 'Yes';
    document.querySelector('#declare').checked = true;
    MODE;
  };
  window.addEventListener('DOMContentLoaded', () => setTimeout(act, 100));
})();
"""


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(Quiet, directory=str(directory))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@unittest.skipIf(sync_playwright is None, 'Playwright is not installed')
class WorkerInChromium(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = serve(ROOT / 'fixtures')
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        exe = os.getenv('CAREER_BROWSER_EXECUTABLE')
        cls.browser = cls.pw.chromium.launch(headless=True, **({'executable_path': exe} if exe else {}))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown()

    def setUp(self):
        self.data = DataDir().__enter__()
        self.store = Store(paths.db_path())
        self.job = fixture_job(url=f'{self.base}/application.html'); self.store.put_job(self.job)
        self.adapter = fixture_adapter(self.base)
        self.context = self.browser.new_context()
        self.page = self.context.new_page()

    def tearDown(self):
        self.context.close(); self.store.db.close(); self.data.__exit__(None, None, None)

    def run_worker(self, submit, wait=8, job=None, pol=None):
        from agent.worker import execute
        return execute(self.page, self.store, job or self.job, profile(), pol or policy(), self.adapter, library(), submit, wait_seconds=wait)

    def status(self):
        return self.store.applications()[0]['status'] if self.store.applications() else None

    def test_dry_run_fills_and_uploads_but_leaves_declarations_and_never_submits(self):
        r = self.run_worker(False)
        self.assertEqual(r['status'], 'ready', r)
        self.assertEqual(r['left_for_applicant'], ['accuracy_declaration'])
        self.assertEqual(self.page.input_value('#name'), 'Alex Example')
        self.assertEqual(self.page.input_value('#email'), 'alex.example@example.org')
        self.assertEqual(self.page.input_value('#rtw'), 'Yes')  # from the document-backed UK record
        self.assertFalse(self.page.is_checked('#declare'))
        self.assertEqual(self.page.eval_on_selector('#cv', 'el => el.files[0].name'), 'cv.pdf')
        self.assertEqual(self.page.get_attribute('#declare', 'data-career-agent'), 'answer this yourself')
        self.assertEqual(self.page.evaluate('window.__posts'), 0)
        self.assertEqual(self.status(), 'ready')

    def test_applicant_submits_and_the_receipt_is_captured(self):
        self.context.add_init_script(APPLICANT.replace('MODE', "document.querySelector('#send').click()"))
        r = self.run_worker(True)
        self.assertEqual(r['status'], 'submitted', r)
        app = self.store.applications()[0]
        self.assertEqual(app['status'], 'submitted')
        self.assertIn('FIXTURE-001', app['payload']['receipt'])
        self.assertEqual(app['payload']['receipt_kind'], 'adapter_verified')
        self.assertEqual(app['payload']['initiated_by'], 'applicant')
        self.assertTrue(Path(app['payload']['screenshot']).is_file())
        self.assertEqual(self.page.evaluate('window.__posts'), 1)
        # A second run on the same posting does nothing and keeps the sealed documents.
        hashes = app['payload']['document_hashes']
        self.assertEqual(self.run_worker(True)['status'], 'needs_input')
        self.assertEqual(self.store.applications()[0]['payload']['document_hashes'], hashes)

    def test_no_click_from_the_applicant_means_nothing_is_sent(self):
        r = self.run_worker(True, wait=2)
        self.assertEqual(r['status'], 'not_submitted', r)
        self.assertEqual(self.status(), 'failed')
        self.assertEqual(self.page.evaluate('window.__posts'), 0)
        self.assertTrue(self.page.locator('#apply').is_visible())

    def test_page_leaves_without_a_receipt_is_uncertain_and_not_retried(self):
        # The applicant submits, but the form goes to another page with no receipt.
        self.context.add_init_script(APPLICANT.replace('MODE', "document.querySelector('form').onsubmit = null; document.querySelector('#send').click()"))
        r = self.run_worker(True, wait=4)
        self.assertEqual(r['status'], 'uncertain', r)
        self.assertEqual(self.status(), 'uncertain')
        self.assertEqual(self.run_worker(True)['status'], 'needs_input')
        self.assertEqual(self.status(), 'uncertain')

    def test_captcha_stops_before_anything_is_filled(self):
        self.context.add_init_script("window.addEventListener('DOMContentLoaded',()=>{const f=document.createElement('iframe');f.src='about:blank#recaptcha';f.setAttribute('src','https://www.google.com/recaptcha/api2/anchor');document.body.appendChild(f)})")
        self.context.route('**/recaptcha/**', lambda route: route.fulfill(body='captcha'))
        r = self.run_worker(True)
        self.assertEqual(r['status'], 'needs_input'); self.assertIn('CAPTCHA', r['reason'])
        self.assertEqual(self.page.input_value('#name'), '')
        self.assertIsNone(self.status())

    def test_no_record_for_the_country_means_the_agent_asks(self):
        # A Dublin job with no Irish record: the gate asks, and nothing is filled.
        job = dict(self.job, country='Ireland')
        r = self.run_worker(False, job=job)
        self.assertEqual(r['status'], 'needs_input'); self.assertIn('No right-to-work record for Ireland', r['reason'])
        events = [json.loads(e['payload']) for e in self.store.db.execute("SELECT payload FROM events WHERE kind='needs_input'")]
        self.assertTrue(any('Ireland' in e['reason'] for e in events))

    def test_changed_document_means_the_agent_asks_instead_of_filling(self):
        (paths.data_dir() / 'documents' / 'right-to-work-united-kingdom.txt').write_text('altered')
        r = self.run_worker(False)
        self.assertEqual(r['status'], 'needs_input'); self.assertIn('changed since you confirmed it', r['reason'])
        self.assertEqual(self.page.input_value('#rtw'), '')

    def test_changed_description_stops(self):
        job = dict(self.job, description='Something else entirely.')
        r = self.run_worker(True, job=job)
        self.assertEqual(r['status'], 'needs_input'); self.assertIn('description', r['reason'])

    def test_daily_attempt_limit(self):
        pol = policy(); pol['daily_submission_limit'] = 0
        r = self.run_worker(True, pol=pol)
        self.assertEqual(r['status'], 'needs_input'); self.assertIn('limit', r['reason'])
        self.assertEqual(self.status(), 'ready')


@unittest.skipIf(sync_playwright is None, 'Playwright is not installed')
class ExtensionFillInChromium(unittest.TestCase):
    """The extension's page functions (fillForm, readReceipt) run in the fixture page."""

    def test_fill_leaves_declarations_and_reads_only_a_real_receipt(self):
        server = serve(ROOT / 'fixtures'); base = f'http://127.0.0.1:{server.server_port}'
        source = (ROOT / 'extension' / 'popup.js').read_text(encoding='utf-8')
        self.assertNotIn('.click()', source)
        with sync_playwright() as pw:
            b = pw.chromium.launch(headless=True); page = b.new_page()
            page.goto(f'{base}/application.html')
            page.add_script_tag(content=source.replace("const $=", "var $=") + '\nwindow.fillForm=fillForm;window.readReceipt=readReceipt;')
            adapter = fixture_adapter(base)
            from agent.core import now
            pack = {'adapter': adapter, 'verified_at': now(), 'profile': {'name': 'Alex Example', 'email': 'alex.example@example.org'}, 'cover_letter': ''}
            out = page.evaluate('p => window.fillForm(p)', pack)
            self.assertEqual(out, {'ok': True, 'left': ['right_to_work', 'accuracy_declaration']})
            self.assertEqual(page.input_value('#name'), 'Alex Example')
            self.assertFalse(page.is_checked('#declare')); self.assertEqual(page.input_value('#rtw'), '')
            self.assertEqual(page.evaluate('a => window.readReceipt(a)', adapter)['status'], 'uncertain')
            self.assertEqual(page.evaluate('window.__posts'), 0)
            b.close()
        server.shutdown()


if __name__ == '__main__':
    unittest.main()
