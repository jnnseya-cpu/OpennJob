"""LLM output is validated before use. The transport is replaced: no network call, no key."""
import json, os, unittest
from unittest.mock import patch
from agent import llm
from tests.helpers import profile

JOB = {'id': 'j', 'title': 'Construction Manager', 'company': 'Example Ltd', 'url': 'https://example.org/1', 'description': 'Essential: chartered status. Contractor governance on rail projects.'}


def reply(obj, fenced=False):
    text = json.dumps(obj)
    if fenced:
        text = '```json\n' + text + '\n```'
    return lambda body, key: {'output': [{'content': [{'type': 'output_text', 'text': text}]}]}


# A live call needs a spending limit and prices (R20); these are test values.
ENV = {'OPENAI_API_KEY': 'test-key-not-real', 'LLM_MODEL': 'test-model', 'LLM_BUDGET_GBP_DAILY': '5', 'LLM_PRICE_GBP_PER_MTOK_INPUT': '2', 'LLM_PRICE_GBP_PER_MTOK_OUTPUT': '8'}


class Llm(unittest.TestCase):
    def good(self):
        return {'requirements': [
            {'text': 'Chartered', 'jd_quote': 'chartered status', 'weight': 50, 'state': 'met', 'evidence_ids': ['E01'], 'hard': True, 'reason': ''},
            {'text': 'Governance', 'jd_quote': 'Contractor governance on rail projects', 'weight': 50, 'state': 'met', 'evidence_ids': ['E02'], 'hard': True, 'reason': ''}]}

    def test_needs_key_and_model(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                llm.call('t', {})

    def test_match_accepts_valid_output_and_marks_it_unreviewed(self):
        with patch.dict(os.environ, ENV), patch.object(llm, 'transport', reply(self.good(), fenced=True)):
            out = llm.match(dict(JOB), profile())
        self.assertEqual(out['score'], 100); self.assertFalse(out['matching_reviewed'])

    def test_match_rejects_invented_evidence_bad_quotes_and_bad_weights(self):
        for mutate in (lambda r: r['requirements'][0].update(evidence_ids=['E99']),
                       lambda r: r['requirements'][0].update(jd_quote='ten years of PMP'),
                       lambda r: r['requirements'][0].update(weight=40),
                       lambda r: r['requirements'][0].pop('hard')):
            bad = self.good(); mutate(bad)
            with patch.dict(os.environ, ENV), patch.object(llm, 'transport', reply(bad)):
                with self.assertRaises((ValueError, KeyError)):
                    llm.match(dict(JOB), profile())

    def test_tailor_copies_evidence_exactly_and_rejects_unknown_ids(self):
        job = dict(JOB, requirements=self.good()['requirements'])
        with patch.dict(os.environ, ENV), patch.object(llm, 'transport', reply({'headline': 'x', 'evidence_order': ['E02', 'E01'], 'cover_intro': '', 'cover_close': '', 'review_notes': []})):
            pack = llm.tailor(job, profile())
        for e in profile()['evidence'][:2]:
            self.assertIn(e['text'], pack['cv_text'])
        self.assertNotIn('[', pack['cv_text'])
        with patch.dict(os.environ, ENV), patch.object(llm, 'transport', reply({'evidence_order': ['E77']})):
            with self.assertRaises(ValueError):
                llm.tailor(job, profile())


if __name__ == '__main__':
    unittest.main()
