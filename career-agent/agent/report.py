import os,smtplib,ssl,time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from email.message import EmailMessage
from .core import now,score
ZONE=ZoneInfo('Europe/London')
def report(store,instant=None):
    apps=store.applications();jobs={j['id']:j for j in store.jobs()}
    instant=(instant or datetime.now(ZONE)).astimezone(ZONE); start=instant-timedelta(hours=24)
    recent=[a for a in apps if datetime.fromisoformat(a['updated'])>=start]
    lines=['NSEYA Career Agent — daily report',instant.isoformat(),'LAST 24 HOURS: '+start.isoformat()+' to '+instant.isoformat(),'']
    lines+=['Updated '+status+': '+str(sum(a['status']==status for a in recent)) for status in ('submitted','recruiter_reply','interview','offer','uncertain')]
    lines+=['','Labels: SUBMITTED needs a receipt (adapter_verified = captured by the agent; manually_reconciled = recorded by you). READY means waiting for you to submit; DRAFT is not an application.']
    lines+=['','ALL-TIME APPLICATION STATE AND LINKS']
    for status in ['submitted','uncertain','ready','draft','blocked','failed','recruiter_reply','interview','offer','rejected']:
        group=[a for a in apps if a['status']==status];lines.append(f'{status.upper()}: {len(group)}')
        for a in group:
            j=jobs.get(a['job_id'],{});lines.extend([j.get('company','')+' — '+j.get('title',''),j.get('url','')])
            if status=='submitted':lines.append('Receipt: '+a['payload'].get('receipt','')+' ('+a['payload'].get('receipt_kind','')+')')
        lines.append('')
    errors=store.db.execute("SELECT at,payload FROM events WHERE kind='source_failed' ORDER BY id DESC LIMIT 20").fetchall()
    needs=store.db.execute("SELECT at,payload FROM events WHERE kind='needs_input' AND at>=? ORDER BY id DESC LIMIT 30",(start.astimezone(__import__('datetime').timezone.utc).isoformat(),)).fetchall()
    lines+=['NEEDS INPUT IN LAST 24 HOURS']+[r['at']+' '+r['payload'] for r in needs]
    lines+=['RECENT SOURCE FAILURES']+[r['at']+' '+r['payload'] for r in errors]
    return '\n'.join(lines)
def send(store):
    needed=['SMTP_HOST','SMTP_USERNAME','SMTP_PASSWORD','SMTP_FROM','REPORT_TO']
    if any(not os.getenv(k) for k in needed):raise RuntimeError('SMTP and REPORT_TO settings required; report not sent')
    msg=EmailMessage();msg['Subject']='NSEYA Career Agent — applications and next actions';msg['From']=os.environ['SMTP_FROM'];msg['To']=os.environ['REPORT_TO'];msg.set_content(report(store))
    with smtplib.SMTP(os.environ['SMTP_HOST'],int(os.getenv('SMTP_PORT','587')),timeout=30) as smtp:
        smtp.starttls(context=ssl.create_default_context());smtp.login(os.environ['SMTP_USERNAME'],os.environ['SMTP_PASSWORD']);smtp.send_message(msg)
    store.event('report_sent',{'recipient':os.environ['REPORT_TO']})
def tick(store,instant=None,sender=None):
    # UTC instant -> London local time handles DST. A restart after 09:00 sends today's
    # missed digest once. Returns the digest status when one was attempted, else None.
    local=(instant or datetime.now(ZONE)).astimezone(ZONE);day=local.date().isoformat()
    if local.hour<9 or store.db.execute('SELECT 1 FROM digests WHERE day=?',(day,)).fetchone():return None
    store.db.execute('INSERT INTO digests VALUES(?,?,?)',(day,'sending',now()));store.db.commit()
    try:
        (sender or send)(store);status='sent'
    except Exception as e:
        # Do not blindly retry an uncertain SMTP send; reconcile manually.
        status='failed_or_uncertain';store.event('report_failed',{'reason':type(e).__name__})
    store.db.execute('UPDATE digests SET status=? WHERE day=?',(status,day));store.db.commit();return status
def schedule(store):
    # Check once per 30 seconds. Single process only.
    while True:
        tick(store);time.sleep(30)
