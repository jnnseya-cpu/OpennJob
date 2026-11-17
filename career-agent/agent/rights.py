"""Right to work and sponsorship, per country, backed by a document the applicant attached.

  python3 -m agent.rights add --country "United Kingdom" --right-to-work yes --sponsorship no \\
      --document ~/passport.pdf --basis "British passport" [--expires 2032-05-01] --confirmed
  python3 -m agent.rights list
  python3 -m agent.rights remove --country "United Kingdom" --confirmed
  python3 -m agent.rights missing        countries of your matched jobs with no valid record

A record is used only while it is confirmed, its document is still in data/local/documents/
with the same SHA-256, and it has not expired. Then it decides the work-rights gate for jobs in
that country, and the worker answers that form's right-to-work and sponsorship questions from
it. With no valid record the agent asks: the job waits as needs input, the field is left for
you, and the daily report lists the question. Other declarations are never answered for you.

The document itself is never uploaded to an employer by this module and never logged.
"""
import argparse, hashlib, json, shutil
from datetime import date
from pathlib import Path
from . import paths


def _doc_dir() -> Path:
    return paths.sub('documents')


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(record, today=None):
    """None when the record can be used, otherwise the reason it cannot."""
    if not record.get('confirmed'):
        return 'not confirmed by you'
    doc = record.get('document')
    if not doc:
        return 'no supporting document attached'
    path = _doc_dir() / doc
    if not path.is_file():
        return 'supporting document missing'
    if _sha(path) != record.get('document_sha256'):
        return 'supporting document changed since you confirmed it'
    if record.get('expires') and record['expires'] < (today or date.today()).isoformat():
        return 'supporting document expired on ' + record['expires']
    if not isinstance(record.get('right_to_work'), bool) or not isinstance(record.get('requires_sponsorship'), bool):
        return 'right to work and sponsorship must both be answered yes or no'
    return None


def record_for(profile, country, today=None):
    """(record, None) when a valid record exists for the country, else (None, question to ask)."""
    for r in profile.get('work_rights', []):
        if r.get('country', '').casefold() == (country or '').casefold():
            problem = check(r, today)
            if problem:
                return None, f'Right to work for {country}: {problem}. Add or renew it with python3 -m agent.rights add, or answer it yourself.'
            return r, None
    return None, f'No right-to-work record for {country}. Add one with a supporting document (python3 -m agent.rights add), or answer it yourself.'


def answer_for(key, profile, country):
    """The confirmed yes/no answer for a work-rights field in this country, or raise with the question."""
    record, question = record_for(profile, country)
    if not record:
        raise LookupError(question)
    return record['requires_sponsorship'] if 'sponsor' in key else record['right_to_work']


def _yes(v):
    if v.lower() in ('yes', 'y', 'true'):
        return True
    if v.lower() in ('no', 'n', 'false'):
        return False
    raise SystemExit('Answer yes or no')


def main(argv=None):
    p = argparse.ArgumentParser(prog='python3 -m agent.rights')
    p.add_argument('action', choices=['add', 'list', 'remove', 'missing'])
    p.add_argument('--country'); p.add_argument('--right-to-work'); p.add_argument('--sponsorship', help='do you need sponsorship? yes or no')
    p.add_argument('--document'); p.add_argument('--basis'); p.add_argument('--expires'); p.add_argument('--confirmed', action='store_true')
    a = p.parse_args(argv)
    pp = paths.data_file('profile.json'); profile = json.loads(pp.read_text(encoding='utf-8'))
    rights = profile.setdefault('work_rights', [])
    if a.action == 'list':
        for r in rights:
            problem = check(r)
            print(f"{r['country']}: right to work {'yes' if r.get('right_to_work') else 'no'}, sponsorship needed {'yes' if r.get('requires_sponsorship') else 'no'}, "
                  f"basis {r.get('basis') or '-'}, expires {r.get('expires') or '-'} — {'valid' if not problem else 'NOT USED: ' + problem}")
        if not rights:
            print('No right-to-work records. Every right-to-work and sponsorship question will be asked of you.')
        return
    if a.action == 'missing':
        from .core import Store, score
        countries = sorted({j.get('country', 'Unconfirmed') for j in Store(paths.db_path()).jobs() if score(j.get('requirements', [])) >= 80})
        for c in countries:
            _, question = record_for(profile, c)
            if question:
                print(question)
        return
    if not a.country:
        raise SystemExit('--country is required')
    if not a.confirmed:
        raise SystemExit('Check the details, then pass --confirmed')
    if a.action == 'remove':
        profile['work_rights'] = [r for r in rights if r['country'].casefold() != a.country.casefold()]
        pp.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding='utf-8'); print('Removed.'); return
    if a.right_to_work is None or a.sponsorship is None or not a.document:
        raise SystemExit('add needs --right-to-work yes|no, --sponsorship yes|no and --document PATH')
    source = Path(a.document).expanduser()
    if not source.is_file():
        raise SystemExit('Document not found: ' + str(source))
    if a.expires:
        date.fromisoformat(a.expires)
    _doc_dir().mkdir(parents=True, exist_ok=True)
    name = f"right-to-work-{a.country.lower().replace(' ', '-')}{source.suffix.lower()}"
    shutil.copyfile(source, _doc_dir() / name)
    record = {'country': a.country, 'right_to_work': _yes(a.right_to_work), 'requires_sponsorship': _yes(a.sponsorship), 'basis': a.basis or '',
              'document': name, 'document_sha256': _sha(_doc_dir() / name), 'expires': a.expires, 'confirmed': True, 'confirmed_at': date.today().isoformat()}
    profile['work_rights'] = [r for r in rights if r['country'].casefold() != a.country.casefold()] + [record]
    pp.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'Recorded for {a.country}. The document is kept in {_doc_dir()} (git-ignored).')


if __name__ == '__main__':
    main()
