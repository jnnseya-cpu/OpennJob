"""Where the agent keeps its files.

Personal data (profile, jobs, answers, search profiles, the database, packs, receipts,
the browser profile and adapters) lives in the data directory: CAREER_DATA, or
data/local/ by default. data/local/ is git-ignored. Non-personal configuration
(policy.json, boards.json) is read from the data directory when present there, and
otherwise from the committed data/ folder.
"""
import json, os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PERSONAL = {'profile.json', 'jobs.json', 'answer_library.json', 'search_profiles.json'}


def data_dir() -> Path:
    return Path(os.getenv('CAREER_DATA') or ROOT / 'data' / 'local')


def data_file(name: str) -> Path:
    local = data_dir() / name
    if local.exists() or name in PERSONAL:
        if not local.exists():
            raise FileNotFoundError(f'{local} is missing. Copy data/{name.replace(".json", ".example.json")} there and replace it with your own confirmed details.')
        return local
    return ROOT / 'data' / name


def read(name: str):
    return json.loads(data_file(name).read_text(encoding='utf-8'))


def db_path() -> str:
    data_dir().mkdir(parents=True, exist_ok=True)
    return str(data_dir() / 'career.sqlite3')


def sub(name: str) -> Path:
    """packs, receipts, adapters, browser-profile, worker.lock under the data directory."""
    return data_dir() / name
