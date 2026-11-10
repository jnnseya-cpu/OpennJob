"""The 09:00 Europe/London report (R16, R19, B12; T35-T39).

Event based. Each digest covers the interval since the previous digest's end (its watermark),
or the last 24 hours for the first one, so an application submitted and then invited to
interview inside one interval counts once as a submission and once as an interview, and is
not counted again the next day. One digest per London day, keyed by the day. The schedule
works in UTC instants converted to London time, so 09:00 is right on both sides of a clock
change. A host that was off at 09:00 sends one catch-up when it starts, labelled late.

Outbox: the Message-ID is stored before the send. A definite refusal (connection refused,
recipient or sender refused, authentication) is recorded as failed and tried again on the next
tick. A send that may have been accepted (timeout or disconnect after the data) is recorded as
uncertain and never re-sent automatically: reconcile it with
  python3 -m agent.cli report-reconcile --day YYYY-MM-DD --sent|--not-sent
SMTP acceptance is not proof of delivery to the inbox.
"""
import json, os, smtplib, socket, ssl, time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import make_msgid
from zoneinfo import ZoneInfo
from .core import score
from .store import now

ZONE = ZoneInfo('Europe/London')
LATE_AFTER_MINUTES = 15
DEFINITE = (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPAuthenticationError, smtplib.SMTPHeloError, ConnectionRefusedError, socket.gaierror)


def _rights_questions(jobs):
    from . import paths
    from .rights import record_for
    try:
        profile = paths.read('profile.json')
    except FileNotFoundError:
        return ['Profile missing.']
    countries = sorted({j.get('country', 'Unconfirmed') for j in jobs.values() if _eligible(j)})
    out = [q for c in countries for q in [record_for(profile, c)[1]] if q]
    return out or ['None: every country with a match of 80% or more has a valid record.']


def _eligible(j):
    from .scoring import eligible
    try:
        return bool(j.get('requirements')) and eligible(j['requirements'])
    except ValueError:
        return False


def window(store, instant):
    """[start, end) of the next digest: from the last digest's end, or 24 hours back."""
    row = store.db.execute('SELECT window_end FROM digests WHERE window_end IS NOT NULL ORDER BY window_end DESC LIMIT 1').fetchone()
    end = instant.astimezone(timezone.utc)
    start = datetime.fromisoformat(row[0]) if row and row[0] else end - timedelta(hours=24)
    return start, end


def report(store, instant=None, start=None, end=None, late=False):
    instant = (instant or datetime.now(ZONE)).astimezone(ZONE)
    if start is None or end is None:
        start, end = window(store, instant)
    s, e = start.astimezone(timezone.utc).isoformat(), end.astimezone(timezone.utc).isoformat()
    jobs = {j['id']: j for j in store.jobs()}; apps = {a['job_id']: a for a in store.applications()}
    ev = store.events(since=s, until=e)
    def jobs_with(kind):
        return list(dict.fromkeys(x['payload'].get('job_id') for x in ev if x['kind'] == kind and x['payload'].get('job_id')))
    submitted, uncertain = jobs_with('application_submitted'), jobs_with('application_uncertain')
    outcome = {k: jobs_with('outcome_' + k) for k in ('recruiter_reply', 'interview_invitation', 'interview_booked', 'interview_completed', 'rejection', 'offer')}
    needs = list(dict.fromkeys((x['payload'].get('job_id'), x['payload'].get('reason')) for x in ev if x['kind'] == 'needs_input'))
    lines = ['NSEYA Career Agent — daily report', instant.isoformat()]
    if late:
        lines.append(f'LATE: catch-up report. It was due at 09:00 and is sent at {instant.strftime("%H:%M")} London time.')
    lines += [f'INTERVAL: {start.astimezone(ZONE).isoformat()} to {end.astimezone(ZONE).isoformat()} (LAST 24 HOURS for the first report)', '']
    lines += [f'SUBMITTED (with a receipt): {len(submitted)}', f'UNCERTAIN (reconcile before any retry): {len(uncertain)}',
              f'RECRUITER REPLIES: {len(outcome["recruiter_reply"])}', f'INTERVIEW INVITATIONS: {len(outcome["interview_invitation"])}',
              f'INTERVIEWS BOOKED: {len(outcome["interview_booked"])}', f'INTERVIEWS COMPLETED: {len(outcome["interview_completed"])}',
              f'REJECTIONS: {len(outcome["rejection"])}', f'OFFERS: {len(outcome["offer"])}', '']
    for label, ids in (('NEW SUBMISSIONS', submitted), ('UNCERTAIN', uncertain), ('INTERVIEW INVITATIONS', outcome['interview_invitation'])):
        lines.append(label)
        for jid in ids:
            j = jobs.get(jid, {}); a = apps.get(jid, {}); p = a.get('payload', {}) if a else {}
            lines.append(f"• {j.get('company', '')} — {j.get('title', '')} | coverage {score(j.get('requirements', []))}% (not an interview probability) | {j.get('url', '')}")
            if p.get('receipt'):
                lines.append('  Receipt: ' + p['receipt'][:300] + (' (' + p.get('receipt_kind', '') + ')' if p.get('receipt_kind') else ''))
        if not ids:
            lines.append('• none')
        lines.append('')
    lines += ['Labels: SUBMITTED needs a receipt (adapter_verified = captured by the agent; manually_reconciled = recorded by you). '
              'READY means waiting for you to submit, or for its route; DRAFT is not an application.', '']
    lines.append('CURRENT DRAFTS AND READY (not applications)')
    for status in ('ready', 'draft', 'blocked', 'uncertain'):
        group = [a for a in apps.values() if a['status'] == status]
        lines.append(f'{status.upper()}: {len(group)}')
        for a in group:
            j = jobs.get(a['job_id'], {}); lines.append(f"• {j.get('company', '')} — {j.get('title', '')} {j.get('url', '')}")
    lines += ['', 'NEEDS INPUT IN THIS INTERVAL'] + ([f'• {jid}: {reason}' for jid, reason in needs] or ['• none'])
    lines += ['', 'QUESTIONS FOR YOU (right to work and sponsorship)'] + _rights_questions(jobs)
    failures = [x for x in ev if x['kind'] in ('source_failed', 'route_quarantined', 'budget_reached', 'matching_failed', 'report_failed')]
    lines += ['', 'RECENT SOURCE FAILURES AND HEALTH'] + ([f"• {x['at']} {x['kind']} {json.dumps(x['payload'])}" for x in failures] or ['• none'])
    for src in store.sources():
        lines.append(f"• {src['company']}: last ok {src['last_ok'] or 'never'}, {src['jobs']} jobs, failures in a row {src['consecutive_failures']}{', TRUNCATED' if src['truncated'] else ''}")
    from .budget import summary
    b = summary(store)
    lines += ['', f"LLM COST TODAY: £{b['today_gbp']} of limit {b['daily_limit_gbp']}", '', 'NEXT ACTIONS']
    actions = []
    if uncertain:
        actions.append('Reconcile the uncertain applications (python3 -m agent.review reconcile).')
    if needs:
        actions.append('Answer the open questions above, then the agent continues.')
    if not actions:
        actions.append('Nothing needs you today.')
    lines += ['• ' + a for a in actions]
    counts = {'submitted': len(submitted), 'uncertain': len(uncertain), **{k: len(v) for k, v in outcome.items()}, 'needs_input': len(needs)}
    report.last_counts = counts
    return '\n'.join(lines)


def message(store, instant, start, end, late):
    msg = EmailMessage()
    msg['Subject'] = ('LATE — ' if late else '') + 'NSEYA Career Agent — applications and next actions'
    msg['From'] = os.getenv('SMTP_FROM', 'career-agent@localhost'); msg['To'] = os.getenv('REPORT_TO', 'applicant@localhost')
    msg['Message-ID'] = make_msgid(domain='nseya-career-agent.local')
    msg.set_content(report(store, instant, start, end, late))
    return msg


def send_message(msg):
    needed = ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM', 'REPORT_TO']
    if any(not os.getenv(k) for k in needed):
        raise RuntimeError('SMTP and REPORT_TO settings required; report not sent')
    with smtplib.SMTP(os.environ['SMTP_HOST'], int(os.getenv('SMTP_PORT', '587')), timeout=30) as smtp:
        smtp.starttls(context=ssl.create_default_context()); smtp.login(os.environ['SMTP_USERNAME'], os.environ['SMTP_PASSWORD']); smtp.send_message(msg)


def send(store, instant=None):
    """Sends a report now, outside the schedule (no digest row)."""
    instant = (instant or datetime.now(ZONE)).astimezone(ZONE); start, end = window(store, instant)
    send_message(message(store, instant, start, end, False))
    store.event('report_sent', {'manual': True})


def tick(store, instant=None, sender=None):
    """Called every 30 seconds. Returns the digest status when a send was attempted, else None."""
    local = (instant or datetime.now(ZONE)).astimezone(ZONE); day = local.date().isoformat()
    if local.hour < 9:
        return None
    row = store.db.execute('SELECT status FROM digests WHERE day=?', (day,)).fetchone()
    if row and row['status'] in ('sent', 'sending', 'failed_or_uncertain', 'uncertain'):
        return None  # sent, in flight, or waiting for reconciliation: never sent twice
    start, end = window(store, local)
    due = local.replace(hour=9, minute=0, second=0, microsecond=0)
    late = local - due > timedelta(minutes=LATE_AFTER_MINUTES)
    msg = message(store, local, start, end, late)
    with store.tx():
        store.db.execute('INSERT INTO digests(day,status,at,window_start,window_end,catch_up,message_id) VALUES(?,?,?,?,?,?,?) '
                         'ON CONFLICT(day) DO UPDATE SET status=excluded.status,at=excluded.at,window_start=excluded.window_start,window_end=excluded.window_end,'
                         'catch_up=excluded.catch_up,message_id=excluded.message_id',
                         (day, 'sending', now(), start.astimezone(timezone.utc).isoformat(), end.isoformat(), int(late), msg['Message-ID']))
    try:
        (sender or send_message)(msg); status = 'sent'
        store.event('report_sent', {'day': day, 'late': late, 'message_id': msg['Message-ID']})
    except DEFINITE as e:
        status = 'failed'; store.event('report_failed', {'day': day, 'reason': type(e).__name__, 'definite': True})
        # Refused outright: nothing was accepted. The window is released for the next try.
        store.db.execute('UPDATE digests SET window_end=NULL WHERE day=?', (day,))
    except Exception as e:
        status = 'failed_or_uncertain'; store.event('report_failed', {'day': day, 'reason': type(e).__name__, 'definite': False})
    store.db.execute('UPDATE digests SET status=?, detail=? WHERE day=?', (status, json.dumps(getattr(report, 'last_counts', {})), day))
    return status


def reconcile(store, day, sent):
    row = store.db.execute('SELECT status FROM digests WHERE day=?', (day,)).fetchone()
    if not row or row['status'] not in ('failed_or_uncertain', 'uncertain'):
        raise ValueError('No uncertain report for that day')
    if sent:
        store.db.execute("UPDATE digests SET status='sent' WHERE day=?", (day,))
    else:
        store.db.execute("UPDATE digests SET status='failed', window_end=NULL WHERE day=?", (day,))
    store.event('report_reconciled', {'day': day, 'sent': bool(sent)})


def schedule(store):
    while True:
        tick(store); time.sleep(30)
