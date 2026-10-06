"""Read connectors against recorded response shapes. No network call is made."""
import os, unittest
from unittest.mock import patch
from agent import sources


class Sources(unittest.TestCase):
    def test_greenhouse(self):
        payload = {'jobs': [{'id': 1, 'title': 'Construction Manager', 'location': {'name': 'Leeds'}, 'absolute_url': 'https://boards.example.org/1', 'content': '<p>Lead <b>delivery</b></p>'}]}
        with patch.object(sources, 'get', return_value=payload) as g:
            out = sources.fetch({'company': 'Example', 'type': 'greenhouse', 'board': 'example board'})
        self.assertIn('/boards/example%20board/jobs?content=true', g.call_args[0][0])
        self.assertEqual(out[0]['title'], 'Construction Manager'); self.assertEqual(out[0]['description'], 'Lead  delivery')
        self.assertEqual(out[0]['country'], 'Unconfirmed'); self.assertFalse(out[0]['live_verified'])

    def test_lever_paginates_and_uses_the_eu_host(self):
        page = [{'id': str(i), 'text': 'Site Manager', 'applyUrl': f'https://jobs.example.org/{i}', 'categories': {'location': 'Dublin'}, 'descriptionPlain': 'x', 'lists': [], 'additionalPlain': ''} for i in range(100)]
        with patch.object(sources, 'get', side_effect=[page, page[:3]]) as g:
            out = sources.fetch({'company': 'Example', 'type': 'lever', 'board': 'ex', 'region': 'eu'})
        self.assertEqual(len(out), 103); self.assertIn('api.eu.lever.co', g.call_args_list[0][0][0]); self.assertIn('skip=100', g.call_args_list[1][0][0])

    def test_ashby_skips_unlisted(self):
        payload = {'jobs': [{'jobUrl': 'u1', 'title': 'PM', 'applyUrl': 'https://jobs.example.org/a', 'isListed': True}, {'jobUrl': 'u2', 'title': 'Hidden', 'applyUrl': 'https://jobs.example.org/b', 'isListed': False}]}
        with patch.object(sources, 'get', return_value=payload):
            out = sources.fetch({'company': 'Example', 'type': 'ashby', 'board': 'ex'})
        self.assertEqual([j['title'] for j in out], ['PM'])

    def test_smartrecruiters_filters_titles_and_maps_country(self):
        listing = {'content': [{'id': '7', 'name': 'Senior Project Manager - Construction'}, {'id': '8', 'name': 'Receptionist'}], 'totalFound': 2}
        detail = {'name': 'Senior Project Manager - Construction', 'location': {'city': 'Birmingham', 'country': 'gb'}, 'applyUrl': 'https://jobs.example.org/7',
                  'jobAd': {'sections': {'jobDescription': {'text': 'Lead delivery'}}}, 'typeOfEmployment': {'id': 'permanent', 'label': 'Permanent'}}
        with patch.object(sources, 'get', side_effect=[listing, detail]) as g:
            out = sources.fetch({'company': 'Example', 'type': 'smartrecruiters', 'board': 'Example1'})
        self.assertEqual(len(out), 1); self.assertEqual(out[0]['country'], 'United Kingdom'); self.assertTrue(out[0]['description_full'])
        self.assertEqual(g.call_count, 2)

    def test_https_only_and_unknown_feed(self):
        with self.assertRaises(ValueError):
            sources.normal('Example', 'x', 1, 't', 'l', 'http://insecure.example.org', '')
        with self.assertRaises(ValueError):
            sources.fetch({'company': 'X', 'type': 'linkedin', 'board': 'x'})

    def test_keyed_sources_need_their_keys(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                sources.reed('construction')
            with self.assertRaises(RuntimeError):
                sources.adzuna('construction')

    def test_canonical_id_ignores_query_strings(self):
        from agent.core import canonical_id
        self.assertEqual(canonical_id('AECOM', 'https://x.example.org/a?utm=1'), canonical_id('aecom ', 'https://x.example.org/a/'))


if __name__ == '__main__':
    unittest.main()
