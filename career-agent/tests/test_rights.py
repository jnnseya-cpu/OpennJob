"""Right to work and sponsorship per country, from document-backed records only."""
import io, json, os, tempfile, unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from agent import paths, rights
from agent.answers import resolve, AskApplicant
from agent.core import gates, Store
from tests.helpers import DataDir, profile, library, fixture_job, uk_rights

FIELD = {'key': 'right_to_work', 'source': 'work_rights', 'value_map': {'true': 'Yes', 'false': 'No'}}
SPONSOR = {'key': 'requires_sponsorship', 'source': 'work_rights', 'value_map': {'true': 'Yes', 'false': 'No'}}


class Rights(unittest.TestCase):
    def test_answers_come_from_the_record_for_the_job_country(self):
        p = profile()
        self.assertEqual(resolve(FIELD, {}, library(), p, 'United Kingdom'), 'Yes')
        self.assertEqual(resolve(SPONSOR, {}, library(), p, 'united kingdom'), 'No')
        with self.assertRaises(AskApplicant) as e:
            resolve(FIELD, {}, library(), p, 'France')
        self.assertIn('No right-to-work record for France', str(e.exception))

    def test_unconfirmed_expired_or_documentless_records_are_not_used(self):
        for change in ({'confirmed': False}, {'expires': '2020-01-01'}, {'document': None}, {'document_sha256': '0' * 64}, {'right_to_work': None}):
            p = profile(); p['work_rights'][0].update(change)
            record, question = rights.record_for(p, 'United Kingdom')
            self.assertIsNone(record, change); self.assertTrue(question)
            with self.assertRaises(AskApplicant):
                resolve(FIELD, {}, library(), p, 'United Kingdom')

    def test_gate_uses_the_record_and_honours_sponsorship(self):
        p = profile(); job = fixture_job()
        self.assertFalse(any('right-to-work' in r.lower() or 'authorisation' in r.lower() for r in gates(job, p)))
        p['work_rights'] = []
        self.assertTrue(any('No right-to-work record for United Kingdom' in r for r in gates(job, p)))
        # Needs sponsorship: eligible only where the job confirms sponsorship.
        p = profile(); p['work_rights'][0].update(right_to_work=False, requires_sponsorship=True)
        self.assertTrue(any('sponsorship not confirmed' in r for r in gates(job, p)))
        self.assertFalse(any('sponsorship not confirmed' in r for r in gates(dict(job, sponsorship_eligibility_confirmed=True), p)))
        # A legacy flag without a document no longer counts.
        p = profile(); p['work_rights'] = []; p['right_to_work'] = True
        self.assertTrue(any('No right-to-work record' in r for r in gates(job, p)))

    def test_cli_add_list_missing_remove(self):
        with DataDir() as d, tempfile.TemporaryDirectory() as t:
            doc = Path(t) / 'permit.pdf'; doc.write_bytes(b'%PDF fictional permit')
            from agent import cli
            with redirect_stdout(io.StringIO()):
                cli.main(['seed'])
            with self.assertRaises(SystemExit):
                rights.main(['add', '--country', 'France', '--right-to-work', 'yes', '--sponsorship', 'no', '--document', str(doc)])  # no --confirmed
            out = io.StringIO()
            with redirect_stdout(out):
                rights.main(['add', '--country', 'France', '--right-to-work', 'yes', '--sponsorship', 'no', '--document', str(doc), '--basis', 'Permit (fictional)', '--expires', '2030-01-01', '--confirmed'])
                rights.main(['list'])
            text = out.getvalue()
            self.assertIn('France: right to work yes, sponsorship needed no', text); self.assertIn('valid', text)
            stored = json.loads((paths.data_dir() / 'profile.json').read_text())
            self.assertTrue((paths.data_dir() / 'documents' / 'right-to-work-france.pdf').is_file())
            self.assertEqual(rights.record_for(stored, 'France')[0]['basis'], 'Permit (fictional)')
            out = io.StringIO()
            with redirect_stdout(out):
                rights.main(['remove', '--country', 'France', '--confirmed'])
            self.assertIsNone(rights.record_for(json.loads((paths.data_dir() / 'profile.json').read_text()), 'France')[0])

    def test_report_lists_the_questions(self):
        from agent.report import report
        with DataDir():
            s = Store(':memory:'); s.put_job(fixture_job(id='fr', country='France'))
            text = report(s)
            self.assertIn('QUESTIONS FOR YOU', text); self.assertIn('No right-to-work record for France', text)


if __name__ == '__main__':
    unittest.main()
