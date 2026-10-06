"""Fictional test data in a temporary CAREER_DATA directory. No test reads data/local/."""
import copy, json, os, shutil, tempfile
from pathlib import Path
from agent.core import now

ROOT = Path(__file__).resolve().parents[1]
DOCUMENT = ROOT / 'fixtures' / 'right-to-work.example.txt'


def install_documents(directory):
    (Path(directory) / 'documents').mkdir(parents=True, exist_ok=True)
    shutil.copy(DOCUMENT, Path(directory) / 'documents' / 'right-to-work-united-kingdom.txt')


# No test may read the real data/local/: every test runs against a temporary data directory.
_BASE = tempfile.mkdtemp(prefix='career-agent-tests-')
install_documents(_BASE)
os.environ['CAREER_DATA'] = _BASE


def example(name):
    return json.loads((ROOT / 'data' / name).read_text(encoding='utf-8'))


class DataDir:
    """Context manager: a temporary data directory holding the fictional example files."""

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)
        profile = example('profile.example.json')
        profile['confirmed'] = True
        (self.path / 'profile.json').write_text(json.dumps(profile), encoding='utf-8')
        (self.path / 'jobs.json').write_text(json.dumps(example('jobs.example.json')), encoding='utf-8')
        (self.path / 'answer_library.json').write_text(json.dumps(example('answer_library.example.json')), encoding='utf-8')
        (self.path / 'search_profiles.json').write_text(json.dumps(example('search_profiles.example.json')), encoding='utf-8')
        install_documents(self.path)
        self.old = os.environ.get('CAREER_DATA')
        os.environ['CAREER_DATA'] = str(self.path)
        return self

    def __exit__(self, *exc):
        os.environ['CAREER_DATA'] = self.old or _BASE
        self.tmp.cleanup()


def profile():
    p = example('profile.example.json'); p['confirmed'] = True
    return p


def policy():
    return example('policy.json')


def library():
    return example('answer_library.example.json')


def fixture_job(url='http://127.0.0.1:8766/application.html', **extra):
    j = {'id': 'fixture', 'url': url, 'country': 'United Kingdom', 'company': 'Local fixture', 'title': 'Construction Manager',
         'description': 'Construction delivery leadership and contractor governance.',
         'requirements': [{'text': 'Contractor governance', 'jd_quote': 'contractor governance', 'weight': 100, 'state': 'met', 'evidence_ids': ['E02'], 'hard': True}],
         'description_full': True, 'matching_reviewed': True, 'live_verified': True, 'verified_at': now(), 'preferences_confirmed': True}
    j.update(extra)
    return j


def fixture_adapter(base='http://127.0.0.1:8766'):
    text = (ROOT / 'fixtures' / 'application.adapter.json').read_text(encoding='utf-8').replace('{BASE}', base)
    return json.loads(text)


def uk_rights():
    return copy.deepcopy(example('profile.example.json')['work_rights'])
