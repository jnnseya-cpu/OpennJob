"""The static dashboard in Chromium with the fictional example data (no data.json)."""
import shutil, tempfile, unittest
from pathlib import Path
from tests.helpers import ROOT
from tests.test_worker import serve, sync_playwright


@unittest.skipIf(sync_playwright is None, 'Playwright is not installed')
class Dashboard(unittest.TestCase):
    def test_every_tab_renders_from_example_data_without_errors(self):
        with tempfile.TemporaryDirectory() as d:
            for f in ('index.html', 'app.js', 'style.css', 'data.example.json'):
                shutil.copy(ROOT / 'dashboard' / f, Path(d) / f)
            server = serve(d)
            errors = []
            with sync_playwright() as pw:
                b = pw.chromium.launch(headless=True); page = b.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(f'http://127.0.0.1:{server.server_port}/index.html')
                page.wait_for_selector('#content .stat', timeout=10000)
                self.assertEqual(page.text_content('#who'), 'Alex Example')
                for tab in ('jobs', 'profile', 'applications', 'interview', 'report', 'launch', 'setup'):
                    page.click(f'nav button[data-tab="{tab}"]')
                    self.assertTrue(page.text_content('#content').strip(), tab)
                page.click('nav button[data-tab="setup"]')
                text = page.text_content('#content')
                self.assertIn('never clicks submit', text); self.assertNotIn('Standing authorization', text)
                page.click('nav button[data-tab="interview"]')
                self.assertIn('rail depot upgrade', page.text_content('#content'))
                b.close()
            server.shutdown()
            self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main()
