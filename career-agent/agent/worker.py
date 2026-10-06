"""Browser assistant on configured routes. The applicant clicks submit, never the agent.

  python3 -m agent.worker --preflight   what is configured and what is missing
  python3 -m agent.worker --once        dry run: fill and upload on each ready route, never submit
  python3 -m agent.worker --submit      assist: fill and upload, leave declarations to you, wait
                                        for YOUR click on submit, then capture the receipt

What the worker does on an exact, reviewed application page: checks for CAPTCHA and login
walls (it stops; it never works around them), checks that the live description matches the
one that was matched, rebuilds and checks the sealed pack, fills confirmed ordinary answers,
uploads the sealed documents and highlights every declaration for you. It never ticks a
declaration or consent box and never presses submit. If you submit, it records the receipt
and a screenshot; if the page leaves before a receipt shows, the attempt is uncertain and is
never retried automatically.
"""
import argparse, hashlib, json, os, re, time
from pathlib import Path
from .core import Store, now, score
from .answers import resolve, is_declaration, LeftForApplicant, AskApplicant
from .policy import authorize, daily_attempt_count, pack_digest
from .documents import build
from . import paths

HIGHLIGHT = "(el)=>{el.style.outline='3px solid #d97706';el.style.outlineOffset='2px';el.setAttribute('data-career-agent','answer this yourself')}"
WATCH = """([form, button]) => {
  window.__careerApplicantSubmitted = false;
  const mark = () => { window.__careerApplicantSubmitted = true; };
  const f = document.querySelector(form); const b = document.querySelector(button);
  if (f) f.addEventListener('submit', mark, true);
  if (b) b.addEventListener('click', mark, true);
}"""


def normalized(text):
    return re.sub(r'\s+', ' ', text).strip()


def record_need(store, job_id, reason):
    payload = {'job_id': job_id, 'reason': reason}
    recent = store.db.execute("SELECT payload FROM events WHERE kind='needs_input' ORDER BY id DESC LIMIT 200").fetchall()
    if any(json.loads(r['payload']) == payload for r in recent):
        return
    store.event('needs_input', payload)


def recover(store):
    # A worker stopped during an attempt cannot know whether the applicant submitted.
    for app in store.applications():
        if app['status'] == 'submitting':
            store.transition(app['job_id'], 'uncertain', {'reason': 'Worker restarted during attempt; reconcile receipt before retrying.'})


def preflight(store):
    profile = paths.read('profile.json'); policy = paths.read('policy.json'); routes = list(paths.sub('adapters').glob('*.json'))
    missing = []
    for key in ('OPENAI_API_KEY', 'LLM_MODEL', 'SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM'):
        if not os.getenv(key):
            missing.append(key)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            executable = os.getenv('CAREER_BROWSER_EXECUTABLE') or pw.chromium.executable_path
            if not Path(executable).is_file():
                missing.append('Chromium browser installation')
    except ImportError:
        missing.append('Playwright installation and Chromium')
    return {
        'mode': 'applicant-initiated: the worker fills and uploads; you answer declarations and click submit',
        'minimum_match': policy['minimum_match'], 'employer_adapters': len(routes), 'jobs': len(store.jobs()),
        'missing_connections': missing, 'source_boards': len(paths.read('boards.json')),
        'ready_count': sum(a['status'] == 'ready' for a in store.applications()),
        'profile_confirmed': bool(profile.get('confirmed')),
        'trial_review': f"{policy.get('trial_review_date')}; extended outcome review {policy.get('evaluation_extension_date')}",
        'notes': ['No employer adapters are shipped as approved.', 'Unknown answers (notice period, driving licence, expected salary, earlier dates) stay unknown until you confirm them.', 'Researched jobs are summaries and must be replaced with full current descriptions before matching.'],
    }


def _fill(page, adapter, pack, library, profile=None, country=None, ask=None):
    filled, left = [], []
    for field in adapter['fields']:
        if field.get('source') == 'work_rights' and field.get('type') == 'radio':
            # A yes/no radio group: the selector matches the group, the mapped value picks one.
            try:
                value = resolve(field, pack, library, profile, country)
            except AskApplicant as question:
                if ask:
                    ask(str(question))
                page.locator(field['selector']).first.evaluate(HIGHLIGHT); left.append(field['key']); continue
            choice = page.locator(f"{field['selector']}[value=\"{value}\"]")
            if choice.count() != 1:
                raise ValueError('Option unavailable: ' + field['key'])
            choice.check(); filled.append({'key': field['key'], 'selector': field['selector'], 'value': value, 'type': 'radio'}); continue
        element = page.locator(field['selector'])
        if element.count() != 1 or not element.is_visible():
            raise ValueError('Field missing or ambiguous: ' + field['key'])
        actual = element.evaluate('(el)=>({tag:el.tagName,type:el.type})')
        if actual['type'] in ('password', 'hidden', 'file', 'submit'):
            raise ValueError('Invalid answer target')
        work_rights = field.get('source') == 'work_rights'
        if not work_rights and (is_declaration(field, library) or actual['type'] in ('checkbox', 'radio')):
            element.evaluate(HIGHLIGHT); left.append(field['key']); continue
        try:
            value = resolve(field, pack, library, profile, country)
        except AskApplicant as question:
            if ask:
                ask(str(question))
            element.evaluate(HIGHLIGHT); left.append(field['key']); continue
        except LeftForApplicant:
            element.evaluate(HIGHLIGHT); left.append(field['key']); continue
        kind = field.get('type', 'text')
        if kind == 'select':
            if actual['tag'] != 'SELECT':
                raise ValueError('Select schema changed')
            element.select_option(str(value))
        elif kind == 'text':
            element.fill(str(value))
        else:
            raise ValueError('Unsupported field type: ' + kind)
        filled.append({'key': field['key'], 'selector': field['selector'], 'value': value, 'type': kind})
    return filled, left


def _wait_for_applicant(page, adapter, wait_seconds):
    """Returns ('receipt', text), ('uncertain', reason) or ('not_submitted', reason). Never clicks."""
    deadline = time.monotonic() + wait_seconds
    clicked = False
    receipt = page.locator(adapter['receipt_selector'])
    while time.monotonic() < deadline:
        try:
            if receipt.count() and receipt.first.is_visible():
                return 'receipt', receipt.first.inner_text().strip()
            clicked = clicked or bool(page.evaluate('() => window.__careerApplicantSubmitted === true'))
            if page.url != adapter['exact_url']:
                clicked = True
        except Exception:
            clicked = True  # the page navigated or closed while we looked: treat as a possible submission
        page.wait_for_timeout(300)
    if clicked:
        return 'uncertain', 'Submit was pressed or the page changed, but no receipt appeared; reconcile before any retry.'
    return 'not_submitted', f'Not submitted by the applicant within {wait_seconds} seconds; nothing was sent.'


def execute(page, store, job, profile, policy, adapter, library, submit=False, wait_seconds=None):
    attempted = False
    try:
        prior = next((a for a in store.applications() if a['job_id'] == job['id']), None)
        if prior and prior['status'] not in ('draft', 'ready'):
            raise ValueError('Posting already attempted; preserve previous documents and reconcile first')
        if not adapter.get('reviewed') or not adapter.get('route_tested'):
            raise ValueError('Route has not been reviewed and tested')
        page.goto(adapter['exact_url'], wait_until='domcontentloaded', timeout=30000)
        if page.url != adapter['exact_url']:
            raise ValueError('Login, redirect or changed application URL needs input')
        for selector in adapter.get('blocking_selectors', []):
            el = page.locator(selector)
            if el.count() and el.first.is_visible():
                raise ValueError('Login, CAPTCHA or unsupported step needs input')
        live = page.locator(adapter['jd_selector'])
        if live.count() != 1 or normalized(live.inner_text()) != normalized(job['description']):
            raise ValueError('Full description changed or mismatched; re-match before applying')
        job.update(live_verified=True, verified_at=now()); store.put_job(job)
        if score(job.get('requirements', [])) < 80:
            raise ValueError('Below 80%')
        pack = build(job, profile, paths.sub('packs') / job['id'])
        reasons = authorize(job, profile, pack, adapter, policy)
        if reasons:
            raise ValueError('; '.join(reasons))
        form = page.locator(adapter['form_selector'])
        if form.count() != 1:
            raise ValueError('Application form missing or ambiguous')
        receipt = page.locator(adapter['receipt_selector'])
        if receipt.count() and receipt.first.is_visible():
            raise ValueError('Receipt already present: possible duplicate')
        pack['answers'], pack['left_for_applicant'] = _fill(page, adapter, pack, library, profile, job.get('country'), lambda q: record_need(store, job['id'], q))
        for upload in adapter.get('uploads', []):
            kind = upload['document']; path = Path(pack['documents'][kind])
            if hashlib.sha256(path.read_bytes()).hexdigest() != pack['document_hashes'][kind]:
                raise ValueError('Document changed after preparation')
            element = page.locator(upload['selector'])
            if element.count() != 1:
                raise ValueError('Upload selector changed')
            element.set_input_files(str(path))
        button = page.locator(adapter['submit_selector'])
        if button.count() != 1:
            raise ValueError('Submit control changed')
        pack['integrity'] = pack_digest(pack)
        existing = next((a for a in store.applications() if a['job_id'] == job['id']), None)
        if existing and existing['status'] not in ('draft', 'ready'):
            raise ValueError('Posting already attempted; no resubmission')
        if not existing or existing['status'] == 'draft':
            store.draft(job, pack); store.transition(job['id'], 'ready')
        else:
            store.db.execute('UPDATE applications SET payload=?,updated=? WHERE job_id=?', (json.dumps(pack), now(), job['id'])); store.db.commit()
        if not submit:
            return {'status': 'ready', 'job_id': job['id'], 'mode': 'dry run; submit not clicked', 'left_for_applicant': pack['left_for_applicant']}
        if daily_attempt_count(store) >= policy['daily_submission_limit']:
            raise ValueError('Daily attempt limit reached')
        reasons = authorize(job, profile, pack, adapter, policy)
        if reasons:
            raise ValueError('; '.join(reasons))
        page.evaluate(WATCH, [adapter['form_selector'], adapter['submit_selector']])
        store.transition(job['id'], 'submitting', {'attempt_at': now(), 'initiated_by': 'applicant'}); attempted = True
        print(f"Ready for you: {job.get('company', '')} — {job.get('title', '')}. Check every field, answer: {', '.join(pack['left_for_applicant']) or 'nothing extra'}; then click submit yourself.", flush=True)
        outcome, detail = _wait_for_applicant(page, adapter, wait_seconds or policy.get('applicant_wait_seconds', 900))
        if outcome == 'not_submitted':
            store.transition(job['id'], 'failed', {'reason': detail}); attempted = False
            return {'status': 'not_submitted', 'job_id': job['id'], 'reason': detail}
        if outcome == 'uncertain':
            store.transition(job['id'], 'uncertain', {'reason': detail}); attempted = False
            return {'status': 'uncertain', 'job_id': job['id'], 'reason': detail}
        if not re.search(adapter['receipt_pattern'], detail):
            raise ValueError('Visible text is not a confirmed success receipt')
        evidence_dir = paths.sub('receipts'); evidence_dir.mkdir(parents=True, exist_ok=True)
        shot = evidence_dir / (job['id'] + '.png'); page.screenshot(path=str(shot), full_page=True)
        proof = {'receipt': page.url + ' | ' + detail[:1500], 'receipt_kind': 'adapter_verified', 'screenshot': str(shot), 'submitted_at': now(), 'adapter_id': adapter.get('id', 'exact-route'), 'initiated_by': 'applicant'}
        store.transition(job['id'], 'submitted', proof)
        return {'status': 'submitted', 'job_id': job['id'], 'receipt': proof['receipt']}
    except Exception as error:
        reason = str(error)[:1800]
        if attempted:
            store.transition(job['id'], 'uncertain', {'reason': reason})
            return {'status': 'uncertain', 'job_id': job['id'], 'reason': reason}
        record_need(store, job['id'], reason)
        return {'status': 'needs_input', 'job_id': job['id'], 'reason': reason}


def cycle(store, context, submit=False, wait_seconds=None):
    profile = paths.read('profile.json'); policy = paths.read('policy.json'); library = paths.read('answer_library.json')
    apps = {a['job_id']: a for a in store.applications()}
    routes = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(paths.sub('adapters').glob('*.json'))]
    for job in sorted(store.jobs(), key=lambda j: score(j.get('requirements', [])), reverse=True):
        if not job.get('requirements') or score(job['requirements']) < 80:
            continue
        if job['id'] in apps and apps[job['id']]['status'] not in ('draft', 'ready'):
            continue
        if job.get('company', '').casefold() in {x.casefold() for x in policy.get('excluded_employers', [])} or job['id'] in policy.get('excluded_job_ids', []):
            continue
        if submit and daily_attempt_count(store) >= policy['daily_submission_limit']:
            break
        adapter = next((a for a in routes if a.get('exact_url') == job.get('url')), None)
        if not adapter:
            record_need(store, job['id'], 'No tested exact-page employer adapter'); continue
        page = context.new_page()
        try:
            print(json.dumps(execute(page, store, job, profile, policy, adapter, library, submit, wait_seconds)), flush=True)
        finally:
            page.close()


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python3 -m agent.worker')
    parser.add_argument('--submit', action='store_true', help='assist mode: wait for you to submit each ready application')
    parser.add_argument('--once', action='store_true'); parser.add_argument('--preflight', action='store_true')
    a = parser.parse_args(argv); store = Store(paths.db_path())
    if a.preflight:
        print(json.dumps(preflight(store), indent=2)); return
    headless = os.getenv('CAREER_HEADLESS', 'false').lower() == 'true'
    if a.submit and headless:
        raise SystemExit('--submit needs a visible browser: you click submit yourself. Unset CAREER_HEADLESS.')
    from playwright.sync_api import sync_playwright
    # Only one process per database; SQLite cannot decide if a live page was submitted.
    paths.data_dir().mkdir(parents=True, exist_ok=True)
    lock = paths.sub('worker.lock')
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, str(os.getpid()).encode()); os.close(fd); recover(store)
        with sync_playwright() as pw:
            context = pw.chromium.launch_persistent_context(str(paths.sub('browser-profile')), headless=headless, **({'executable_path': os.environ['CAREER_BROWSER_EXECUTABLE']} if os.getenv('CAREER_BROWSER_EXECUTABLE') else {}))
            try:
                while True:
                    cycle(store, context, a.submit)
                    if a.once:
                        break
                    time.sleep(paths.read('policy.json')['worker_poll_seconds'])
            finally:
                context.close()
    finally:
        lock.unlink(missing_ok=True); store.db.close()


if __name__ == '__main__':
    main()
