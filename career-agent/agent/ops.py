"""Operations: backup and restore of the ledger (R22, R23; T46).

  python3 -m agent.cli backup  --file PATH             online copy with the SQLite backup API + a manifest
  python3 -m agent.cli restore --file PATH --confirmed  refused while a worker runs; checks integrity first

A restore is idempotent: restoring the same backup twice gives the same ledger. Documents and
receipts live beside the ledger under the data directory; copy that directory with it.
"""
import hashlib, json, sqlite3
from pathlib import Path
from . import paths
from .store import now

TABLES = ('jobs', 'applications', 'events', 'attempts', 'outcomes', 'digests', 'usage', 'sources', 'routes', 'jd_versions', 'input_versions')


def counts(db):
    out = {}
    for t in TABLES:
        try:
            out[t] = db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
        except sqlite3.OperationalError:
            out[t] = None
    return out


def backup(store, target):
    target = Path(target); target.parent.mkdir(parents=True, exist_ok=True)
    dest = sqlite3.connect(str(target))
    try:
        store.db.backup(dest)
        check = dest.execute('PRAGMA integrity_check').fetchone()[0]
        manifest = {'at': now(), 'integrity': check, 'counts': counts(dest)}
    finally:
        dest.close()
    manifest['sha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix(target.suffix + '.manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    store.event('backup_made', {'counts': manifest['counts']})
    return manifest


def restore(source, db_path, confirmed=False):
    if not confirmed:
        raise SystemExit('Restoring replaces the ledger. Check the backup manifest, then pass --confirmed.')
    if paths.sub('worker.lock').exists():
        raise SystemExit('A worker is running on this ledger. Stop it first.')
    src = sqlite3.connect(str(source))
    try:
        if src.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise SystemExit('The backup failed its integrity check; nothing was restored.')
        dest = sqlite3.connect(str(db_path))
        try:
            src.backup(dest)
            result = {'restored_at': now(), 'counts': counts(dest), 'integrity': dest.execute('PRAGMA integrity_check').fetchone()[0]}
        finally:
            dest.close()
    finally:
        src.close()
    return result
