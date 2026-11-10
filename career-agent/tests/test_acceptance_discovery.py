"""Discovery acceptance cases: T06, T07, T08, T10 (feed side), title recall, route certification."""
import io, json, os, unittest, urllib.error
from unittest.mock import patch
from agent import discovery, paths, profiles, routes, sources
from agent.core import Store
from tests.helpers import DataDir, fixture_adapter, fixture_job

PROFILES = json.loads(open(os.path.join(os.path.dirname(__file__), '..', 'data', 'search_profiles.example.json')).read())


def posting(i, title='Senior Construction Manager', country='United Kingdom', work_type='permanent', company='Example Build (fictional)', source='greenhouse'):
    return {'id': f'p{i}', 'posting_id': str(i), 'company': company, 'source': source, 'title': title, 'location': 'x', 'url': f'https://jobs.example.org/{i}',
            'description': f'Fictional advert {i}: construction delivery leadership.', 'requirements': [], 'country': country, 'work_type': work_type,
            'fetched_at': '2026-10-06T08:00:00+00:00'}


class T06_Profiles(unittest.TestCase):
    def test_a_mixed_feed_lands_in_the_right_profiles_without_any_employer_account(self):
        jobs = [posting(1), posting(2, work_type='Contract'), posting(3, country='France'), posting(4, country='Unconfirmed'), posting(5, work_type='')]
        got = {j['id']: [m[0] for m in profiles.memberships(j, PROFILES)] for j in jobs}
        self.assertEqual(got, {'p1': ['uk-permanent'], 'p2': ['uk-contract'], 'p3': ['international'], 'p4': [], 'p5': ['uk-permanent', 'uk-contract']})
        self.assertEqual(profiles.apply(posting(5, work_type=''), PROFILES)['profile_flags'], ['work_type_unconfirmed'])
        # Preferences count as confirmed only through a profile the applicant confirmed.
        self.assertNotIn('preferences_confirmed', profiles.apply(posting(1), PROFILES))
        confirmed = [dict(p, confirmed=True) for p in PROFILES]
        self.assertTrue(profiles.apply(posting(1), confirmed)['preferences_confirmed'])
        self.assertNotIn('preferences_confirmed', profiles.apply(posting(5, work_type=''), confirmed))  # unconfirmed work type still asks

    def test_the_cost_prefilter_keeps_leadership_variants_and_drops_unrelated_titles(self):
        keep = ['Senior Construction Manager', 'Project Director - Infrastructure', 'Construction Director', 'EPC Project Manager', 'Programme Manager, Grid Connections',
                'Package Manager (MEP)', 'Site Manager – Substation', 'Delivery Lead, Data Centres', 'Head of Construction', 'Construction Lead', 'Senior Project Manager',
                'Subcontracts Manager', 'Project Recovery Manager', 'Client-side Construction Manager', 'Principal Project Manager - Rail', 'Commissioning Manager - Energy']
        drop = ['Receptionist', 'Software Engineer', 'Marketing Manager', 'Accountant', 'HR Business Partner', 'Sales Director', 'Graduate Site Manager',
                'Project Accountant', 'Assistant Project Manager', 'Recruitment Consultant', 'Data Analyst']
        self.assertEqual([t for t in keep if not profiles.title_matches(t)], [])  # recall on the labelled set
        self.assertEqual([t for t in drop if profiles.title_matches(t)], [])


class T07_T08_Sources(unittest.TestCase):
    def test_a_capped_source_resumes_from_its_cursor_so_no_page_is_starved(self):
        listing = lambda off: {'content': [{'id': str(i), 'name': f'Senior Project Manager {i}'} for i in range(off, min(off + 100, 250))], 'totalFound': 250}
        def get(url, headers=None):
            if '/postings?' in url:
                return listing(int(url.split('offset=')[1].split('&')[0]))
            pid = url.rsplit('/', 1)[1]
            return {'name': f'Senior Project Manager {pid}', 'location': {'city': 'Leeds', 'country': 'gb'}, 'applyUrl': f'https://jobs.example.org/{pid}', 'jobAd': {'sections': {}}}
        board = {'company': 'Example', 'type': 'smartrecruiters', 'board': 'Ex', 'max_details': 120}
        seen = set()
        with patch.object(sources, 'get', get):
            meta = {}; first = sources.fetch(board, 0, meta)
            self.assertTrue(meta['truncated']); self.assertEqual(len(first), 120); seen |= {j['posting_id'] for j in first}
            meta2 = {}; second = sources.fetch(board, meta['next'], meta2)
            seen |= {j['posting_id'] for j in second}
            meta3 = {}; third = sources.fetch(board, meta2['next'], meta3)
            seen |= {j['posting_id'] for j in third}
        self.assertEqual(seen, {str(i) for i in range(250)})  # every posting reached within three cycles

    def test_429_and_503_back_off_for_reads_and_a_healthy_source_keeps_going(self):
        calls = []
        def opener(req, timeout):
            calls.append(req.full_url)
            if len(calls) <= 2:
                raise urllib.error.HTTPError(req.full_url, 429 if len(calls) == 1 else 503, 'busy', {'Retry-After': '1'}, None)
            return io.BytesIO(b'{"jobs": []}')
        with patch('urllib.request.urlopen', opener), patch('time.sleep') as sleep:
            self.assertEqual(sources.get('https://boards-api.greenhouse.io/v1/boards/x/jobs'), {'jobs': []})
        self.assertEqual(len(calls), 3); self.assertEqual([c.args[0] for c in sleep.call_args_list], [1, 2])
        with patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError('u', 404, 'gone', {}, None)), patch('time.sleep'):
            with self.assertRaises(urllib.error.HTTPError):
                sources.get('https://example.org/x')  # not retried

        with DataDir():
            (paths.data_dir() / 'boards.json').write_text(json.dumps([{'company': 'Down (fictional)', 'type': 'greenhouse', 'board': 'down'}, {'company': 'Example Build (fictional)', 'type': 'greenhouse', 'board': 'ok'}]))
            s = Store(paths.db_path())
            def fetch(board, *a, **k):
                if board['company'].startswith('Down'):
                    raise urllib.error.HTTPError('u', 503, 'down', {}, None)
                return [posting(1), posting(2)]
            with patch.object(discovery, 'fetch', fetch), patch.object(discovery.llm, 'match', side_effect=RuntimeError('no key')):
                discovery.once(s, max_matches=0)
            health = {x['company']: x for x in s.sources()}
            self.assertEqual(health['Down (fictional)']['consecutive_failures'], 1); self.assertEqual(health['Down (fictional)']['last_error'], 'HTTPError')
            self.assertEqual(health['Example Build (fictional)']['jobs'], 2); self.assertEqual(len(s.jobs()), 2)
            s.close()

    def test_malformed_postings_are_rejected_with_a_visible_event(self):
        with DataDir():
            (paths.data_dir() / 'boards.json').write_text(json.dumps([{'company': 'Example Build (fictional)', 'type': 'greenhouse', 'board': 'ok'}]))
            s = Store(paths.db_path())
            bad = dict(posting(9), url='http://insecure.example.org/9')
            with patch.object(discovery, 'fetch', lambda b, *a, **k: [posting(1), bad]), patch.object(discovery.llm, 'match', side_effect=RuntimeError('x')):
                discovery.once(s, max_matches=0)
            self.assertEqual(len(s.jobs()), 1); self.assertEqual(len(s.events('job_rejected')), 1); s.close()


class T10_Withdrawn(unittest.TestCase):
    def test_a_posting_missing_from_a_complete_read_is_withdrawn_and_its_ready_application_expires(self):
        with DataDir():
            (paths.data_dir() / 'boards.json').write_text(json.dumps([{'company': 'Example Build (fictional)', 'type': 'greenhouse', 'board': 'ok'}]))
            s = Store(paths.db_path())
            with patch.object(discovery, 'fetch', lambda b, *a, **k: [posting(1), posting(2)]), patch.object(discovery.llm, 'match', side_effect=RuntimeError('x')):
                discovery.once(s, max_matches=0)
            job = s.job('p2'); s.draft(job, {}); s.transition('p2', 'ready')
            with patch.object(discovery, 'fetch', lambda b, *a, **k: [posting(1)]), patch.object(discovery.llm, 'match', side_effect=RuntimeError('x')):
                discovery.once(s, max_matches=0)
            self.assertEqual(s.job('p2')['status'], 'closed'); self.assertEqual(s.application('p2')['status'], 'expired')
            self.assertNotEqual(s.job('p1').get('status'), 'closed')  # still in the feed: untouched
            s.close()

    def test_a_changed_description_blocks_a_ready_application(self):
        with DataDir():
            (paths.data_dir() / 'boards.json').write_text(json.dumps([{'company': 'Example Build (fictional)', 'type': 'greenhouse', 'board': 'ok'}]))
            s = Store(paths.db_path())
            with patch.object(discovery, 'fetch', lambda b, *a, **k: [posting(1)]), patch.object(discovery.llm, 'match', side_effect=RuntimeError('x')):
                discovery.once(s, max_matches=0)
            s.draft(s.job('p1'), {}); s.transition('p1', 'ready')
            changed = dict(posting(1), description='Fictional advert 1: NEC4 commercial management.')
            with patch.object(discovery, 'fetch', lambda b, *a, **k: [changed]), patch.object(discovery.llm, 'match', side_effect=RuntimeError('x')):
                discovery.once(s, max_matches=0)
            self.assertEqual(s.application('p1')['status'], 'blocked'); self.assertEqual(len(s.jd_versions('p1')), 2)
            s.close()


class B10_Certification(unittest.TestCase):
    def test_automatic_submission_needs_a_supervised_receipt_on_the_same_route(self):
        s = Store(':memory:'); a = fixture_adapter(); controls = [{'tag': 'input', 'type': 'text', 'name': 'name', 'id': 'name', 'required': True, 'options': [], 'label': 'Name'}]
        self.assertFalse(routes.certified(a))
        plain = routes.certify(a, controls, s)
        self.assertTrue(routes.certified(plain)); self.assertFalse(routes.auto_certified(plain))
        with self.assertRaises(ValueError):
            routes.certify(a, controls, s, 'fixture', auto=True)
        j = fixture_job(); s.draft(j, {}); s.transition('fixture', 'ready'); s.transition('fixture', 'submitting')
        s.transition('fixture', 'submitted', {'receipt': 'https://x | TEST application received', 'receipt_kind': 'adapter_verified', 'adapter_id': 'other-route'})
        with self.assertRaises(ValueError):
            routes.certify(a, controls, s, 'fixture', auto=True)  # receipt from another route
        s.db.execute("UPDATE applications SET payload=json_set(payload,'$.adapter_id',?) WHERE job_id='fixture'", (a['id'],))
        auto = routes.certify(a, controls, s, 'fixture', auto=True)
        self.assertTrue(routes.auto_certified(auto)); self.assertEqual(auto['certification']['supervised_receipt']['job_id'], 'fixture')


if __name__ == '__main__':
    unittest.main()
