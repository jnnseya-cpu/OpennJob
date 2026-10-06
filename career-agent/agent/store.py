"""The local ledger: SQLite, versioned schema, transactional state changes.

Every state change is a compare-and-swap inside one transaction: the row changes only if it
is still in the state the caller saw, and the event (and, for a claim, the attempt and the
daily count) is written in the same transaction. Two actors (the worker and the extension)
racing for the same application get exactly one claim; the loser gets ClaimConflict and must
not click (R14, T27).
"""
import json, sqlite3, uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

LONDON = ZoneInfo('Europe/London')

# Application states. needs_input is an exception record (an event), never a state.
ALLOWED = {
    'draft': {'ready', 'expired', 'blocked'},
    'ready': {'submitting', 'blocked', 'expired'},
    'submitting': {'submitted', 'uncertain', 'failed'},
    'uncertain': {'submitted', 'failed'},
    'submitted': {'recruiter_reply', 'interview', 'rejected', 'offer'},
    'recruiter_reply': {'interview', 'rejected', 'offer'},
    'interview': {'rejected', 'offer'},
    'failed': {'ready'},
    'blocked': {'ready', 'expired'},
    'expired': set(),
    'rejected': set(),
    'offer': set(),
}

MIGRATIONS = [
    # 1: the original tables (kept compatible with ledgers made by the first version)
    """CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY, job_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, payload TEXT);
    CREATE TABLE IF NOT EXISTS digests(day TEXT PRIMARY KEY, status TEXT, at TEXT);""",
    # 2: optimistic versions, attempts, versioned inputs and JD versions
    """ALTER TABLE applications ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE applications ADD COLUMN attempt_id TEXT;
    CREATE TABLE IF NOT EXISTS attempts(
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, actor TEXT NOT NULL, idempotency_key TEXT UNIQUE,
        claimed_at TEXT NOT NULL, local_day TEXT NOT NULL, clicked_at TEXT, finished_at TEXT,
        status TEXT NOT NULL, snapshot TEXT, snapshot_sha256 TEXT, receipt TEXT);
    CREATE INDEX IF NOT EXISTS attempts_day ON attempts(local_day);
    CREATE TABLE IF NOT EXISTS input_versions(kind TEXT NOT NULL, version_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind, version_id));
    CREATE TABLE IF NOT EXISTS jd_versions(job_id TEXT NOT NULL, version_id TEXT NOT NULL, sha256 TEXT NOT NULL, normalized_text TEXT NOT NULL, original_text TEXT NOT NULL,
        url TEXT, fetched_at TEXT NOT NULL, parser_version TEXT NOT NULL, PRIMARY KEY(job_id, version_id));""",
    # 3: sources, routes, outcomes, outbox, usage
    """CREATE TABLE IF NOT EXISTS sources(company TEXT PRIMARY KEY, last_ok TEXT, last_error TEXT, last_error_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        jobs INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS routes(id TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, quarantined INTEGER NOT NULL DEFAULT 0, updated TEXT);
    CREATE TABLE IF NOT EXISTS outcomes(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_on TEXT NOT NULL, recorded_at TEXT NOT NULL,
        source TEXT NOT NULL, evidence TEXT NOT NULL);
    ALTER TABLE digests ADD COLUMN window_start TEXT;
    ALTER TABLE digests ADD COLUMN window_end TEXT;
    ALTER TABLE digests ADD COLUMN catch_up INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE digests ADD COLUMN message_id TEXT;
    ALTER TABLE digests ADD COLUMN detail TEXT;
    CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, local_day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        purpose TEXT NOT NULL, status TEXT NOT NULL, reserved REAL NOT NULL, actual REAL, input_tokens INTEGER, output_tokens INTEGER);""",
]


class ClaimConflict(ValueError):
    """Another actor holds the application, the state or version moved, or the cap is reached. Never click."""


def new_attempt_id():
    return 'att-' + uuid.uuid4().hex


def now():
    return datetime.now(timezone.utc).isoformat()


def london_day(instant=None):
    return (instant or datetime.now(timezone.utc)).astimezone(LONDON).date().isoformat()


class Store:
    def __init__(self, path='career.sqlite3', timeout=5.0):
        # Autocommit mode; multi-statement changes use explicit BEGIN IMMEDIATE.
        self.db = sqlite3.connect(path, timeout=timeout, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute(f'PRAGMA busy_timeout={int(timeout * 1000)}')
        if path != ':memory:':
            self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.migrate()

    # ----- schema -----------------------------------------------------------------------
    def migrate(self):
        self.db.execute('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
        done = {r[0] for r in self.db.execute('SELECT version FROM schema_migrations')}
        for number, sql in enumerate(MIGRATIONS, start=1):
            if number in done:
                continue
            with self.tx():
                for statement in [s.strip() for s in sql.split(';') if s.strip()]:
                    try:
                        self.db.execute(statement)
                    except sqlite3.OperationalError as e:
                        # A ledger made before migrations existed already has these columns.
                        if 'duplicate column name' not in str(e):
                            raise
                self.db.execute('INSERT INTO schema_migrations VALUES(?,?)', (number, now()))

    def schema_version(self):
        return self.db.execute('SELECT COALESCE(MAX(version),0) FROM schema_migrations').fetchone()[0]

    class _Tx:
        def __init__(self, db):
            self.db = db

        def __enter__(self):
            self.db.execute('BEGIN IMMEDIATE')
            return self.db

        def __exit__(self, kind, *_):
            self.db.execute('ROLLBACK' if kind else 'COMMIT')
            return False

    def tx(self):
        return Store._Tx(self.db)

    # ----- events -----------------------------------------------------------------------
    def event(self, kind, payload, at=None):
        self.db.execute('INSERT INTO events(at,kind,payload) VALUES(?,?,?)', (at or now(), kind, json.dumps(payload)))

    def events(self, kind=None, since=None, until=None):
        sql, args = 'SELECT id,at,kind,payload FROM events WHERE 1=1', []
        if kind:
            sql += ' AND kind=?'; args.append(kind)
        if since:
            sql += ' AND at>=?'; args.append(since)
        if until:
            sql += ' AND at<?'; args.append(until)
        return [{'id': r['id'], 'at': r['at'], 'kind': r['kind'], 'payload': json.loads(r['payload'])} for r in self.db.execute(sql + ' ORDER BY id', args)]

    # ----- jobs -------------------------------------------------------------------------
    def put_job(self, j):
        from .identity import merge_provenance, same_posting
        with self.tx():
            # One canonical posting per employer and posting id, or per canonical URL; every
            # original URL is kept in provenance (T09).
            for existing in self.jobs():
                if existing['id'] != j['id'] and same_posting(existing, j):
                    j = j | {'id': existing['id'], 'provenance': merge_provenance(existing, j)}
                    break
            else:
                prior = self.job(j['id'])
                if prior:
                    j = j | {'provenance': merge_provenance(prior, j)}
            self.db.execute('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (j['id'], json.dumps(j)))
        return j

    def jobs(self):
        return [json.loads(x[0]) for x in self.db.execute('SELECT payload FROM jobs ORDER BY id')]

    def job(self, job_id):
        row = self.db.execute('SELECT payload FROM jobs WHERE id=?', (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    # ----- applications -----------------------------------------------------------------
    def applications(self):
        return [dict(x) | {'payload': json.loads(x['payload'])} for x in self.db.execute('SELECT * FROM applications ORDER BY job_id')]

    def application(self, job_id):
        row = self.db.execute('SELECT * FROM applications WHERE job_id=?', (job_id,)).fetchone()
        return dict(row) | {'payload': json.loads(row['payload'])} if row else None

    def draft(self, j, pack):
        # No status regression and no duplicate application to the same posting.
        with self.tx():
            existing = self.db.execute('SELECT status FROM applications WHERE job_id=?', (j['id'],)).fetchone()
            if existing and existing['status'] != 'draft':
                raise ValueError('Application already queued or attempted')
            self.db.execute('INSERT INTO applications(id,job_id,status,payload,updated,version) VALUES(?,?,?,?,?,0) '
                            'ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated,version=applications.version+1',
                            (j['id'], j['id'], 'draft', json.dumps(pack), now()))

    def update_payload(self, job_id, pack, expected_status=None):
        with self.tx():
            row = self.db.execute('SELECT status FROM applications WHERE job_id=?', (job_id,)).fetchone()
            if not row:
                raise ValueError('Unknown application')
            if expected_status and row['status'] != expected_status:
                raise ClaimConflict(f'Application is {row["status"]}, not {expected_status}')
            self.db.execute('UPDATE applications SET payload=?,updated=?,version=version+1 WHERE job_id=?', (json.dumps(pack), now(), job_id))

    def transition(self, job_id, status, extra=None):
        if status == 'submitting':
            # Every start of a submission is a claim: one actor, one attempt, counted.
            return self.claim(job_id, actor=(extra or {}).get('initiated_by', 'applicant'), extra=extra)
        with self.tx():
            row = self.db.execute('SELECT * FROM applications WHERE job_id=?', (job_id,)).fetchone()
            if not row:
                raise ValueError('Unknown application')
            if status not in ALLOWED.get(row['status'], set()):
                raise ValueError('Invalid state transition')
            p = json.loads(row['payload']); p.update(extra or {})
            if status == 'submitted' and not (p.get('receipt') and p.get('receipt_kind') in ('adapter_verified', 'manually_reconciled')):
                raise ValueError('Submission receipt required')
            changed = self.db.execute('UPDATE applications SET status=?,payload=?,updated=?,version=version+1 WHERE job_id=? AND status=? AND version=?',
                                      (status, json.dumps(p), now(), job_id, row['status'], row['version'])).rowcount
            if changed != 1:
                raise ClaimConflict('Application changed while updating; reload and try again')
            if row['attempt_id'] and status in ('submitted', 'uncertain', 'failed'):
                self.db.execute('UPDATE attempts SET status=?,finished_at=?,receipt=COALESCE(?,receipt) WHERE id=?',
                                (status, now(), p.get('receipt') if status == 'submitted' else None, row['attempt_id']))
            self.event('application_' + status, {'job_id': job_id, 'attempt_id': row['attempt_id']})

    # ----- claims -----------------------------------------------------------------------
    def attempts_today(self, day=None):
        return self.db.execute('SELECT COUNT(*) FROM attempts WHERE local_day=?', (day or london_day(),)).fetchone()[0]

    def claim(self, job_id, actor, idempotency_key=None, cap=None, expected_version=None, snapshot=None, snapshot_sha256=None, extra=None, attempt_id=None):
        """ready -> submitting, the attempt row, the event and the daily count: one transaction.

        Returns the attempt id. The same idempotency key returns the same attempt. Raises
        ClaimConflict when anything moved; the caller must then not click.
        """
        with self.tx():
            if idempotency_key:
                same = self.db.execute('SELECT id, job_id FROM attempts WHERE idempotency_key=?', (idempotency_key,)).fetchone()
                if same:
                    if same['job_id'] != job_id:
                        raise ClaimConflict('Idempotency key belongs to another application')
                    return same['id']
            row = self.db.execute('SELECT * FROM applications WHERE job_id=?', (job_id,)).fetchone()
            if not row:
                raise ValueError('Unknown application')
            if row['status'] != 'ready':
                raise ClaimConflict(f'Application is {row["status"]}; only a ready application can be claimed')
            if expected_version is not None and row['version'] != expected_version:
                raise ClaimConflict('Application changed since it was read')
            day = london_day()
            if cap is not None and self.attempts_today(day) >= cap:
                raise ClaimConflict('Daily attempt limit reached')
            attempt_id = attempt_id or new_attempt_id()
            p = json.loads(row['payload']); p.update(extra or {}); p.update(attempt_id=attempt_id, attempt_at=now(), initiated_by=actor)
            changed = self.db.execute("UPDATE applications SET status='submitting',payload=?,updated=?,version=version+1,attempt_id=? "
                                      "WHERE job_id=? AND status='ready' AND version=?", (json.dumps(p), now(), attempt_id, job_id, row['version'])).rowcount
            if changed != 1:
                raise ClaimConflict('Application was claimed by another actor')
            self.db.execute('INSERT INTO attempts(id,job_id,actor,idempotency_key,claimed_at,local_day,status,snapshot,snapshot_sha256) VALUES(?,?,?,?,?,?,?,?,?)',
                            (attempt_id, job_id, actor, idempotency_key, now(), day, 'submitting', json.dumps(snapshot) if snapshot else None, snapshot_sha256))
            self.event('application_submitting', {'job_id': job_id, 'attempt_id': attempt_id, 'actor': actor})
            return attempt_id

    def mark_clicked(self, attempt_id):
        """Recorded immediately before the click: after a crash it decides failed (no click) or uncertain."""
        self.db.execute('UPDATE attempts SET clicked_at=? WHERE id=?', (now(), attempt_id))

    def attempt(self, attempt_id):
        row = self.db.execute('SELECT * FROM attempts WHERE id=?', (attempt_id,)).fetchone()
        return dict(row) if row else None

    def attempts(self, job_id=None):
        sql, args = 'SELECT * FROM attempts', []
        if job_id:
            sql += ' WHERE job_id=?'; args.append(job_id)
        return [dict(r) for r in self.db.execute(sql + ' ORDER BY claimed_at', args)]

    # ----- versions of inputs -----------------------------------------------------------
    def record_version(self, kind, version_id, payload):
        self.db.execute('INSERT OR IGNORE INTO input_versions VALUES(?,?,?,?)', (kind, version_id, now(), json.dumps(payload, sort_keys=True)))

    def version_payload(self, kind, version_id):
        row = self.db.execute('SELECT payload FROM input_versions WHERE kind=? AND version_id=?', (kind, version_id)).fetchone()
        return json.loads(row[0]) if row else None

    def record_jd(self, job_id, version):
        self.db.execute('INSERT OR IGNORE INTO jd_versions VALUES(?,?,?,?,?,?,?,?)',
                        (job_id, version['version_id'], version['sha256'], version['normalized_text'], version['original_text'], version.get('url'), version['fetched_at'], version['parser_version']))

    def jd_versions(self, job_id):
        return [dict(r) for r in self.db.execute('SELECT * FROM jd_versions WHERE job_id=? ORDER BY fetched_at', (job_id,))]

    # ----- sources and routes -----------------------------------------------------------
    def source_ok(self, company, jobs, pages=1, truncated=False, cursor=0):
        self.db.execute('INSERT INTO sources(company,last_ok,consecutive_failures,jobs,pages,truncated,cursor) VALUES(?,?,0,?,?,?,?) '
                        'ON CONFLICT(company) DO UPDATE SET last_ok=excluded.last_ok,consecutive_failures=0,jobs=excluded.jobs,pages=excluded.pages,truncated=excluded.truncated,cursor=excluded.cursor',
                        (company, now(), jobs, pages, int(bool(truncated)), cursor))

    def source_failed(self, company, reason):
        self.db.execute('INSERT INTO sources(company,last_error,last_error_at,consecutive_failures) VALUES(?,?,?,1) '
                        'ON CONFLICT(company) DO UPDATE SET last_error=excluded.last_error,last_error_at=excluded.last_error_at,consecutive_failures=sources.consecutive_failures+1',
                        (company, reason, now()))

    def sources(self):
        return [dict(r) for r in self.db.execute('SELECT * FROM sources ORDER BY company')]

    def source(self, company):
        row = self.db.execute('SELECT * FROM sources WHERE company=?', (company,)).fetchone()
        return dict(row) if row else None

    def route(self, route_id):
        row = self.db.execute('SELECT * FROM routes WHERE id=?', (route_id,)).fetchone()
        return dict(row) if row else {'id': route_id, 'failures': 0, 'quarantined': 0, 'last_error': None}

    def route_failed(self, route_id, reason, quarantine_after=3):
        with self.tx():
            r = self.route(route_id); failures = r['failures'] + 1; quarantined = int(failures >= quarantine_after)
            self.db.execute('INSERT INTO routes(id,failures,last_error,quarantined,updated) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET failures=excluded.failures,'
                            'last_error=excluded.last_error,quarantined=excluded.quarantined,updated=excluded.updated', (route_id, failures, reason, quarantined, now()))
            if quarantined and not r['quarantined']:
                self.event('route_quarantined', {'route': route_id, 'failures': failures})
        return bool(quarantined)

    def route_ok(self, route_id):
        self.db.execute('INSERT INTO routes(id,failures,quarantined,updated) VALUES(?,0,0,?) ON CONFLICT(id) DO UPDATE SET failures=0,updated=excluded.updated', (route_id, now()))

    def release_route(self, route_id):
        self.db.execute('UPDATE routes SET failures=0,quarantined=0,updated=? WHERE id=?', (now(), route_id))

    # ----- outcomes ---------------------------------------------------------------------
    def add_outcome(self, job_id, kind, occurred_on, source, evidence):
        self.db.execute('INSERT INTO outcomes(job_id,kind,occurred_on,recorded_at,source,evidence) VALUES(?,?,?,?,?,?)', (job_id, kind, occurred_on, now(), source, evidence))
        self.event('outcome_' + kind, {'job_id': job_id, 'occurred_on': occurred_on, 'source': source})

    def outcomes(self, job_id=None):
        sql, args = 'SELECT * FROM outcomes', []
        if job_id:
            sql += ' WHERE job_id=?'; args.append(job_id)
        return [dict(r) for r in self.db.execute(sql + ' ORDER BY occurred_on, id', args)]

    def close(self):
        self.db.close()
