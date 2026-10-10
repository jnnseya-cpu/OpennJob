import json, tempfile, unittest
from agent.answers import answer, resolve, is_declaration, LeftForApplicant
from agent.policy import authorize, pack_digest, daily_attempt_count
from agent.documents import build
from agent.core import Store
from agent.worker import recover
from tests.helpers import profile, policy, library, fixture_job, fixture_adapter


class Trial(unittest.TestCase):
    def inputs(self):
        return profile(), fixture_job(), fixture_adapter(), policy()

    def test_unknown_answer_never_guessed(self):
        lib = library()
        with self.assertRaises(ValueError):
            answer('expected_permanent_salary', lib)
        with self.assertRaises(ValueError):
            answer('notice_period', lib)
        self.assertEqual(answer('email', lib), 'alex.example@example.org')

    def test_declarations_are_never_resolved_into_a_form(self):
        lib = library()
        for field in ({'key': 'uk_right_to_work', 'value_map': {'true': 'Yes'}}, {'key': 'uk_requires_sponsorship'}, {'key': 'criminal_convictions'},
                      {'key': 'security_clearance_status'}, {'key': 'equal_opportunities_gender'}, {'key': 'name', 'declaration': True},
                      {'key': 'newsletter', 'type': 'checkbox'}):
            self.assertTrue(is_declaration(field, lib), field)
            with self.assertRaises(LeftForApplicant):
                resolve(field, {}, lib)
        self.assertEqual(resolve({'key': 'name'}, {}, lib), 'Alex Example')

    def test_reviewed_route_passes_and_pack_tampering_is_caught(self):
        p, j, a, pol = self.inputs()
        with tempfile.TemporaryDirectory() as d:
            pack = build(j, p, d)
            self.assertEqual(authorize(j, p, pack, a, pol), [])
            pack['cv_text'] += '\nInvented PMP credential'
            self.assertTrue(any('changed' in x for x in authorize(j, p, pack, a, pol)))

    def test_untested_route_is_refused(self):
        p, j, a, pol = self.inputs(); a['route_tested'] = False
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(any('not reviewed and tested' in x for x in authorize(j, p, build(j, p, d), a, pol)))

    def test_disable_and_exclusions_stop_the_agent(self):
        p, j, a, pol = self.inputs()
        with tempfile.TemporaryDirectory() as d:
            pack = build(j, p, d); pol['enabled'] = False
            self.assertTrue(any('disabled' in x for x in authorize(j, p, pack, a, pol)))
            pol['enabled'] = True; pol['excluded_employers'] = ['LOCAL FIXTURE']
            self.assertTrue(any('Excluded' in x for x in authorize(j, p, pack, a, pol)))

    def test_restart_no_duplicate(self):
        s = Store(':memory:'); j = fixture_job(); s.draft(j, {}); s.transition('fixture', 'ready'); s.transition('fixture', 'submitting')
        recover(s)
        self.assertEqual(s.applications()[0]['status'], 'uncertain'); self.assertEqual(daily_attempt_count(s), 1)

    def test_country_right_not_from_uk_or_relocation(self):
        p, j, a, pol = self.inputs(); j['country'] = 'France'
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(any('France' in x for x in authorize(j, p, build(j, p, d), a, pol)))

    def test_unreviewed_extraction_blocks(self):
        p, j, a, pol = self.inputs(); j['matching_reviewed'] = False
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(any('extraction' in x for x in authorize(j, p, build(j, p, d), a, pol)))

    def test_committed_policy_is_applicant_initiated_with_the_80_floor(self):
        pol = policy()
        self.assertEqual(pol['mode'], 'applicant_initiated'); self.assertEqual(pol['minimum_match'], 80); self.assertEqual(pol['daily_submission_limit'], 20)


if __name__ == '__main__':
    unittest.main()
