"""Acceptance cases for the foundation: contracts, versions, scoring, eligibility, claims, revocation.

Named after the workbook's cases (NSEYA_Test_Matrix_and_Build_Backlog.xlsx). Fictional data only.
"""
import copy, json, os, tempfile, threading, unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from agent import contracts, paths, policy as policy_mod, scoring, versions
from agent.core import gates
from agent.identity import canonical_url
from agent.normalize import digest, normalize
from agent.store import ClaimConflict, Store
from tests.helpers import DataDir, ROOT, fixture_job, profile, uk_rights

SYNTH = ROOT / 'fixtures' / 'synthetic'


def req(weight, state='met', hard=False, evidence=('E01',), quote='Construction delivery leadership'):
    return {'text': f'r{weight}{state}', 'jd_quote': quote, 'weight': weight, 'state': state, 'hard': hard, 'evidence_ids': list(evidence) if state in ('met', 'partial') else []}


class T03_Contracts(unittest.TestCase):
    def test_malformed_records_are_rejected_and_country_is_never_guessed(self):
        good = {'id': 'x1', 'company': 'Example Build (fictional)', 'title': 'Construction Manager', 'url': 'https://jobs.example.org/1', 'fetched_at': '2026-10-06T09:00:00+00:00'}
        self.assertEqual(contracts.validate_job(dict(good))['country'], 'Unconfirmed')
        self.assertEqual(contracts.validate_job(dict(good, country='France'))['country'], 'France')
        for bad in (dict(good, url='http://jobs.example.org/1'), dict(good, title=''), {k: v for k, v in good.items() if k != 'company'},
                    dict(good, fetched_at='2026-10-06 09:00'), dict(good, fetched_at='not a time'), dict(good, verified_at='2026-13-40T00:00:00Z'), 'not an object'):
            with self.assertRaises(contracts.ContractError, msg=bad):
                contracts.validate_job(bad)

    def test_snapshot_contract_example_and_runtime_checks(self):
        example = json.loads((ROOT / 'contracts' / 'attempt-snapshot.example.json').read_text())
        self.assertEqual(contracts.schema_errors(example), [])
        contracts.validate_snapshot(example)
        broken = copy.deepcopy(example); broken['jd']['apply_url'] = 'http://employer.example/apply'
        self.assertTrue(contracts.schema_errors(broken))
        broken = copy.deepcopy(example); broken['scorecard']['raw_coverage'] = '95'
        with self.assertRaises(contracts.ContractError):
            contracts.validate_snapshot(broken)
        broken = copy.deepcopy(example); broken['jd']['normalized_text'] = 'Different text.'
        with self.assertRaises(contracts.ContractError):
            contracts.validate_snapshot(broken)
        broken = copy.deepcopy(example); broken['jd']['fetched_at'] = 'yesterday'
        self.assertTrue(any('date-time' in e for e in contracts.schema_errors(broken)))
        broken = copy.deepcopy(example); broken['authorization']['minimum_match'] = 75
        self.assertTrue(contracts.schema_errors(broken))


class T04_Versions(unittest.TestCase):
    def test_changing_profile_or_policy_invalidates_and_narrative_edits_do_not(self):
        p, pol = profile(), json.loads((ROOT / 'data' / 'policy.json').read_text())
        lib = json.loads((ROOT / 'data' / 'answer_library.example.json').read_text())
        v1 = versions.current(p, pol, lib)
        p2 = copy.deepcopy(p); p2['phone'] = '07700 900999'
        self.assertEqual(versions.stale(v1, versions.current(p2, pol, lib)), ['profile'])
        pol2 = dict(pol, excluded_employers=['Someone (fictional)'])
        self.assertEqual(versions.stale(v1, versions.current(p, pol2, lib)), ['policy'])
        lib2 = copy.deepcopy(lib); lib2['answers']['opening_style'] = {'value': 'Short sentences', 'confirmed': True, 'kind': 'narrative'}
        self.assertEqual(versions.stale(v1, versions.current(p, pol, lib2)), [])
        lib3 = copy.deepcopy(lib); lib3['answers']['notice_period'] = {'value': '4 weeks', 'confirmed': True, 'kind': 'fact'}
        self.assertEqual(versions.stale(v1, versions.current(p, pol, lib3)), ['answers'])

    def test_versions_are_recorded_in_the_ledger(self):
        s = Store(':memory:'); v = versions.current(profile(), {'enabled': True}, {'answers': {}}, s)
        self.assertEqual(s.version_payload('profile', v['profile'])['name'], 'Alex Example')


class T05_Normalisation(unittest.TestCase):
    def test_formatting_differences_normalise_and_material_changes_do_not(self):
        a = 'Construction delivery leadership &amp; contractor governance.'
        b = '<p>Construction delivery   leadership\n&amp;  contractor​ governance.</p>'
        self.assertEqual(digest(a), digest(b))
        self.assertEqual(normalize(b), 'Construction delivery leadership & contractor governance.')
        self.assertNotEqual(digest(a), digest(a.replace('contractor', 'client')))


class T09_Dedup(unittest.TestCase):
    def test_seed_feed_import_and_two_profiles_share_one_posting_with_provenance(self):
        s = Store(':memory:')
        s.put_job({'id': 'seed-1', 'company': 'Example Build (fictional)', 'title': 'PM', 'url': 'https://jobs.example.org/p/123', 'source': 'seed'})
        s.put_job({'id': 'feed-9', 'company': 'example build (FICTIONAL)', 'title': 'PM', 'url': 'https://jobs.example.org/p/123/?utm_source=x&gclid=1', 'source': 'greenhouse'})
        s.put_job({'id': 'import-3', 'company': 'Example Build (fictional)', 'title': 'PM', 'url': 'https://JOBS.example.org/p/123#apply', 'source': 'import'})
        jobs = s.jobs()
        self.assertEqual(len(jobs), 1); self.assertEqual(jobs[0]['id'], 'seed-1')
        self.assertEqual({p['source'] for p in jobs[0]['provenance']}, {'seed', 'greenhouse', 'import'})
        self.assertEqual(canonical_url('https://jobs.example.org/p/123/?utm_source=x&gclid=1&page=2'), 'https://jobs.example.org/p/123?page=2')
        # One active application per posting: once attempted, it cannot be drafted again.
        s.draft(jobs[0], {}); s.transition('seed-1', 'ready'); s.transition('seed-1', 'submitting')
        with self.assertRaises(ValueError):
            s.draft(jobs[0], {})
        self.assertEqual(len(s.applications()), 1)


class T11_ExactThreshold(unittest.TestCase):
    def test_score_boundaries_from_the_supplied_fixture(self):
        for case in json.loads((SYNTH / 'score-boundaries.json').read_text()):
            c = Decimal(case['coverage'])
            reqs = [req(str(c), 'met'), req(str(Decimal(100) - c), 'unmet')] if c < 100 else [req('100', 'met')]
            self.assertEqual(scoring.raw_coverage(reqs), c, case)
            self.assertEqual(scoring.eligible(reqs), case['expected_threshold_pass'], case)
            # Display floors; it never changes the decision.
            self.assertEqual(scoring.display(reqs), int(c))

    def test_threshold_cannot_be_lowered(self):
        with self.assertRaises(ValueError):
            scoring.eligible([req('100')], threshold=79)


class T12_MalformedWeights(unittest.TestCase):
    def test_bad_weights_and_states_are_refused(self):
        for weights in ([], [None], ['NaN'], ['Infinity'], [-5, 105], [0, 100], [40, 40], [60, 60], [True, 99], ['abc', 50]):
            reqs = [req(w) for w in weights]
            with self.assertRaises(ValueError, msg=weights):
                scoring.validate_scorecard(reqs)
        with self.assertRaises(ValueError):
            scoring.validate_scorecard([dict(req(100), state='probably')])
        with self.assertRaises(ValueError):
            scoring.validate_scorecard([{k: v for k, v in req(100).items() if k != 'hard'}])
        self.assertEqual(scoring.validate_scorecard([req('60.5'), req('39.5', 'partial')]), Decimal('80.25'))


class T13_EssentialsIndependent(unittest.TestCase):
    def test_score_95_with_an_unknown_required_licence_is_blocked(self):
        p = profile(); p['work_rights'] = uk_rights()
        j = fixture_job(requirements=[req(95, 'met', quote='Construction delivery leadership'), req(5, 'unknown', hard=True, quote='contractor governance')])
        self.assertEqual(scoring.display(j['requirements']), 95)
        self.assertTrue(any('Essential requirement unresolved' in r for r in gates(j, p)))


class T17_CountryRights(unittest.TestCase):
    def test_uk_rights_and_relocation_do_not_give_france(self):
        p = profile(); p['relocation'] = True
        j = fixture_job(country='France', requirements=[req(100, 'met', quote='contractor governance')])
        self.assertTrue(any('No right-to-work record for France' in r for r in gates(j, p)))
        # A record that needs sponsorship, and an advert offering it, is still not enough.
        p['work_rights'].append(dict(uk_rights()[0], country='France', right_to_work=False, requires_sponsorship=True))
        j['sponsorship_offered'] = True
        self.assertTrue(any('eligibility for it is not confirmed for France' in r for r in gates(j, p)))
        # Only confirmed eligibility for this role's sponsorship opens it.
        j['sponsorship_eligibility_confirmed'] = True
        self.assertFalse(any('France' in r for r in gates(j, p)))

    def test_supplied_eligibility_scenarios(self):
        p = profile()
        for case in json.loads((SYNTH / 'eligibility-scenarios.json').read_text()):
            c = Decimal(case['coverage'])
            state = {True: 'met', None: 'unknown', False: 'unmet'}[case.get('essential_met', True)]
            j = fixture_job(requirements=[req(str(c), 'met', quote='Construction delivery leadership'), req(str(100 - c), state, hard=True, quote='contractor governance')])
            pp = copy.deepcopy(p)
            if case.get('france_rights', 'x') is None:
                j['country'] = 'France'; pp['relocation'] = True
            reasons = gates(j, pp)
            if case['id'] == 'synthetic-revoked':
                pol = {'enabled': False}
                self.assertTrue(policy_mod.standing(pol) is False)
                continue
            self.assertEqual(not reasons, case['expected'].startswith('eligible'), (case, reasons))


class T18_T19_FinalCheck(unittest.TestCase):
    def test_revocation_exclusion_or_changed_inputs_after_fill_mean_no_click(self):
        with DataDir() as d:
            pol = json.loads((ROOT / 'data' / 'policy.json').read_text())
            (d.path / 'policy.json').write_text(json.dumps(pol))
            s = Store(paths.db_path()); s.put_job(fixture_job())
            v = versions.current()
            self.assertEqual(policy_mod.final_check('fixture', v, store=s), [])
            (d.path / 'policy.json').write_text(json.dumps(dict(pol, enabled=False)))   # revoked after the fill
            problems = policy_mod.final_check('fixture', v, store=s)
            self.assertTrue(any('policy' in x for x in problems)); self.assertTrue(any('disabled' in x for x in problems))
            (d.path / 'policy.json').write_text(json.dumps(dict(pol, excluded_employers=['local fixture'])))   # excluded mid-cycle
            self.assertTrue(any('Excluded' in x for x in policy_mod.final_check('fixture', v, store=s)))
            s.close()

    def test_standing_authorisation_needs_the_current_scope_and_no_revocation(self):
        on = {'mode': 'standing_authorization', 'enabled': True, 'standing_authorization': {'scope_version': policy_mod.SCOPE_VERSION, 'consent_at': '2026-10-06T09:00:00+00:00'}}
        self.assertTrue(policy_mod.standing(on))
        self.assertFalse(policy_mod.standing(dict(on, enabled=False)))
        self.assertFalse(policy_mod.standing(dict(on, mode='applicant_initiated')))
        self.assertFalse(policy_mod.standing(dict(on, standing_authorization={'scope_version': 'old', 'consent_at': 'x'})))
        self.assertFalse(policy_mod.standing(dict(on, standing_authorization=dict(on['standing_authorization'], revoked_at='2026-10-06T10:00:00+00:00'))))
        self.assertFalse(policy_mod.standing(json.loads((ROOT / 'data' / 'policy.json').read_text())))  # the committed default


class T20_T27_Claims(unittest.TestCase):
    def ledger(self, n=1):
        d = tempfile.mkdtemp(); path = os.path.join(d, 'ledger.sqlite3')
        s = Store(path)
        for i in range(n):
            j = fixture_job(id=f'job{i}'); s.put_job(j); s.draft(j, {}); s.transition(j['id'], 'ready')
        return path, s

    def test_two_connections_racing_get_exactly_one_claim_and_one_event(self):
        path, s = self.ledger()
        results, barrier = [], threading.Barrier(8)
        def race(i):
            mine = Store(path)
            barrier.wait()
            try:
                results.append(('ok', mine.claim('job0', actor=f'actor{i}')))
            except ClaimConflict as e:
                results.append(('conflict', str(e)))
            finally:
                mine.close()
        threads = [threading.Thread(target=race, args=(i,)) for i in range(8)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(sum(r[0] == 'ok' for r in results), 1, results)
        self.assertEqual(len(s.attempts('job0')), 1)
        self.assertEqual(len(s.events('application_submitting')), 1)
        self.assertEqual(s.application('job0')['status'], 'submitting')

    def test_cap_race_at_19_of_20_and_london_midnight(self):
        path, s = self.ledger(3)
        with patch('agent.store.london_day', return_value='2026-10-24'):
            for i in range(19):
                s.db.execute("INSERT INTO attempts(id,job_id,actor,claimed_at,local_day,status) VALUES(?,?,?,?,?,?)", (f'old{i}', 'other', 'worker-auto', '2026-10-24T08:00:00+00:00', '2026-10-24', 'uncertain'))
            results = []
            def race(job):
                mine = Store(path)
                try:
                    results.append(mine.claim(job, actor='x', cap=20))
                except ClaimConflict as e:
                    results.append(str(e))
                finally:
                    mine.close()
            threads = [threading.Thread(target=race, args=(f'job{i}',)) for i in (0, 1)]
            [t.start() for t in threads]; [t.join() for t in threads]
            self.assertEqual(sum(str(r).startswith('att-') for r in results), 1, results)
            self.assertIn('Daily attempt limit reached', results)
        # A new London day resets the count once. 23:30 UTC on 24 October is 00:30 BST on the 25th.
        from agent.store import london_day
        self.assertEqual(london_day(datetime(2026, 10, 24, 23, 30, tzinfo=timezone.utc)), '2026-10-25')
        self.assertEqual(london_day(datetime(2026, 10, 25, 23, 30, tzinfo=timezone.utc)), '2026-10-25')  # GMT again after the change
        with patch('agent.store.london_day', return_value='2026-10-25'):
            leftover = next(j for j in ('job0', 'job1') if s.application(j)['status'] == 'ready')
            self.assertTrue(s.claim(leftover, actor='x', cap=20).startswith('att-'))

    def test_idempotency_key_and_stale_version(self):
        _, s = self.ledger()
        a = s.claim('job0', actor='extension', idempotency_key='k1')
        self.assertEqual(s.claim('job0', actor='extension', idempotency_key='k1'), a)
        with self.assertRaises(ClaimConflict):
            s.claim('job0', actor='worker')
        _, s2 = self.ledger()
        version = s2.application('job0')['version']
        s2.update_payload('job0', {'changed': True})
        with self.assertRaises(ClaimConflict):
            s2.claim('job0', actor='worker', expected_version=version)


class T44_Safety(unittest.TestCase):
    def test_unsafe_urls_paths_and_ids_are_blocked(self):
        with patch.dict(os.environ, {'CAREER_ALLOW_LOCAL_FIXTURE': ''}):
            for url in ('http://jobs.example.org/a', 'https://127.0.0.1/a', 'https://localhost/x', 'https://10.0.0.5/x', 'https://169.254.169.254/latest',
                        'https://[::1]/x', 'https://user:pass@jobs.example.org/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://printer.local/x'):
                with self.assertRaises(contracts.ContractError, msg=url):
                    contracts.safe_url(url)
            self.assertEqual(contracts.safe_url('https://jobs.example.org/apply?id=1'), 'https://jobs.example.org/apply?id=1')
        with patch.dict(os.environ, {'CAREER_ALLOW_LOCAL_FIXTURE': '1'}):
            self.assertTrue(contracts.safe_url('https://127.0.0.1:8443/application.html'))
            with self.assertRaises(contracts.ContractError):
                contracts.safe_url('https://10.0.0.5/x')  # only the local fixture host, never the private network
        for bad in ('../job', 'a/b', '', '.hidden', 'x' * 200, 'job id', 'job\x00'):
            with self.assertRaises(contracts.ContractError, msg=bad):
                contracts.safe_id(bad)
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(contracts.child_path(d, 'job-1', 'attempts'), Path(d).resolve() / 'job-1' / 'attempts')
            with self.assertRaises(contracts.ContractError):
                contracts.child_path(d, 'job-1', '..', '..', 'etc')

    def test_no_secret_or_personal_file_is_tracked(self):
        import subprocess, re
        tracked = subprocess.run(['git', 'ls-files', 'career-agent'], cwd=ROOT.parent, capture_output=True, text=True).stdout.split()
        self.assertFalse([f for f in tracked if f.startswith('career-agent/data/local/') or f.endswith('dashboard/data.json') or f.endswith('.sqlite3')])
        pattern = re.compile(r'sk-[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}')
        for f in tracked:
            path = ROOT.parent / f
            if path.is_file() and path.suffix in ('.py', '.json', '.md', '.js', '.html', '.txt', '.example', '.css'):
                self.assertIsNone(pattern.search(path.read_text(encoding='utf-8', errors='ignore')), f)


if __name__ == '__main__':
    unittest.main()
