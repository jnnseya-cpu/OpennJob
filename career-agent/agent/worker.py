"""Browser worker on certified routes (R12, R13, R15).

  python3 -m agent.worker --preflight   what is configured and what is missing (exits 1 when not ready)
  python3 -m agent.worker --once        dry run: verify, fill and upload on each ready route, never submit
  python3 -m agent.worker --submit      submit mode, one pass per poll:
                                          standing authorisation + auto-certified route + a form with no
                                          declaration or sensitive question + every required answer confirmed
                                          -> the agent presses submit and captures the receipt;
                                          otherwise -> it fills what it may, leaves the rest highlighted, and
                                          waits for YOU to answer and press submit (assist).

On every route, in order: refuses an attempted posting or a quarantined route; checks the URLs
are https and inside the route's origins; verifies the full JD at its own URL (or on the apply
page) against the version that was matched, and records the version; detects a withdrawn or
closed vacancy; stops at a CAPTCHA, login or unexpected redirect; checks the live form against
the certified schema; rebuilds and checks the sealed pack; fills confirmed ordinary answers and
uploads the sealed documents; seals the attempt snapshot; claims the attempt atomically with the
daily cap; re-reads authorisation, exclusions and inputs from disk; only then clicks (or hands
over). A receipt counts only when it is new, visible, matches the route's job-specific pattern
and is correlated with this posting. Anything ambiguous is uncertain and never retried.
"""
import argparse, hashlib, json, os, re, sys, time
from pathlib import Path
from . import paths, versions
from .answers import resolve, is_declaration, LeftForApplicant, AskApplicant
from .contracts import ContractError, safe_url, same_origin
from .core import Store, now, score
from .documents import build
from .normalize import digest, jd_version, normalize
from .policy import authorize, daily_attempt_count, final_check, pack_digest, standing
from .routes import SCAN, auto_certified, review_form, schema_hash
from .snapshot import build as build_snapshot, seal
from .store import ClaimConflict, new_attempt_id

HIGHLIGHT = "(el)=>{el.style.outline='3px solid #d97706';el.style.outlineOffset='2px';el.setAttribute('data-career-agent','answer this yourself')}"
WATCH = """([form, button]) => {
  window.__careerApplicantSubmitted = false;
  const mark = () => { window.__careerApplicantSubmitted = true; };
  const f = document.querySelector(form); const b = document.querySelector(button);
  if (f) f.addEventListener('submit', mark, true);
  if (b) b.addEventListener('click', mark, true);
}"""
CLOSED = re.compile(r'no longer (accepting|available|open)|position (has been )?(filled|closed)|vacancy (has )?(closed|expired)|applications? (are )?closed|job (has )?expired', re.I)


class Need(ValueError):
    """Something the applicant must do or decide. Nothing was sent."""


class RouteError(Need):
    """The route itself no longer matches (schema, selectors, uploads): counts towards quarantine."""


class Withdrawn(Need):
    """The vacancy is closed, withdrawn or past its deadline."""


def normalized(text):
    return normalize(text)


def record_need(store, job_id, reason):
    payload = {'job_id': job_id, 'reason': reason}
    recent = store.db.execute("SELECT payload FROM events WHERE kind='needs_input' ORDER BY id DESC LIMIT 200").fetchall()
    if any(json.loads(r['payload']) == payload for r in recent):
        return
    store.event('needs_input', payload)


def recover(store):
    """After a restart: an attempt the agent claimed but never clicked is failed (nothing sent); any
    other in-flight attempt is uncertain, because the applicant or the page may have submitted it."""
    for app in store.applications():
        if app['status'] != 'submitting':
            continue
        attempt = store.attempt(app['attempt_id']) if app.get('attempt_id') else None
        if attempt and attempt['actor'] == 'worker-auto' and not attempt['clicked_at']:
            store.transition(app['job_id'], 'failed', {'reason': 'Worker stopped before the click; nothing was sent.'})
        else:
            store.transition(app['job_id'], 'uncertain', {'reason': 'Worker restarted during attempt; reconcile receipt before retrying.'})


def preflight(store):
    """Every prerequisite for a live run, with the fix for each one missing. ready=False blocks launch."""
    problems = []
    try:
        profile = paths.read('profile.json')
    except FileNotFoundError as e:
        profile = {}; problems.append(str(e))
    policy = paths.read('policy.json')
    routes = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(paths.sub('adapters').glob('*.json'))]
    from .routes import certified
    for key, fix in (('OPENAI_API_KEY', 'set the LLM API key in the environment'), ('LLM_MODEL', 'set LLM_MODEL'),
                     ('LLM_BUDGET_GBP_DAILY', 'set a daily LLM spending limit before live analysis')):
        if not os.getenv(key):
            problems.append(f'{key} missing: {fix}')
    email = all(os.getenv(k) for k in ('SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM', 'REPORT_TO'))
    if not email:
        problems.append('SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM and REPORT_TO are needed for the 09:00 report (or run with --no-email: incomplete)')
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            executable = os.getenv('CAREER_BROWSER_EXECUTABLE') or pw.chromium.executable_path
            if not Path(executable).is_file():
                problems.append('Chromium is not installed: python3 -m playwright install chromium, or set CAREER_BROWSER_EXECUTABLE')
    except ImportError:
        problems.append('Playwright is not installed: python3 -m pip install -r requirements.lock')
    if not any(certified(r) for r in routes):
        problems.append('No certified route: certify one with python3 -m agent.routes certify')
    if not profile.get('confirmed'):
        problems.append('Profile not confirmed: python3 -m agent.review confirm-profile --confirmed')
    return {
        'ready': not problems, 'problems': problems,
        'mode': 'standing authorisation (automatic on certified routes with no sensitive question)' if standing(policy) else 'applicant-initiated: you press submit',
        'email': 'configured' if email else 'NOT configured: a run without the 09:00 report is incomplete',
        'minimum_match': policy['minimum_match'], 'routes': len(routes), 'certified_routes': sum(certified(r) for r in routes),
        'jobs': len(store.jobs()), 'source_boards': len(paths.read('boards.json')),
        'ready_count': sum(a['status'] == 'ready' for a in store.applications()),
    }


def _target(page, adapter):
    return page.frame_locator(adapter['frame_selector']) if adapter.get('frame_selector') else page


def _fill(page, adapter, pack, library, profile=None, country=None, ask=None, fields=None, target=None):
    target = target or _target(page, adapter)
    filled, left = [], []
    for field in (fields if fields is not None else adapter['fields']):
        if field.get('source') == 'work_rights' and field.get('type') == 'radio':
            try:
                value = resolve(field, pack, library, profile, country)
            except AskApplicant as question:
                if ask:
                    ask(str(question))
                target.locator(field['selector']).first.evaluate(HIGHLIGHT); left.append(field['key']); continue
            choice = target.locator(f"{field['selector']}[value=\"{value}\"]")
            if choice.count() != 1:
                raise RouteError('Option unavailable: ' + field['key'])
            choice.check(); filled.append({'key': field['key'], 'selector': field['selector'], 'value': value, 'type': 'radio'}); continue
        element = target.locator(field['selector'])
        if element.count() != 1 or not element.is_visible():
            raise RouteError('Field missing or ambiguous: ' + field['key'])
        actual = element.evaluate('(el)=>({tag:el.tagName,type:el.type})')
        if actual['type'] in ('password', 'hidden', 'file', 'submit'):
            raise RouteError('Invalid answer target')
        work_rights = field.get('source') == 'work_rights'
        if not work_rights and (is_declaration(field, library) or (actual['type'] in ('checkbox', 'radio') and not field.get('ordinary'))):
            element.evaluate(HIGHLIGHT); left.append(field['key']); continue
        try:
            value = resolve(field, pack, library, profile, country)
        except AskApplicant as question:
            if ask:
                ask(str(question))
            element.evaluate(HIGHLIGHT); left.append(field['key']); continue
        except LeftForApplicant:
            element.evaluate(HIGHLIGHT); left.append(field['key']); continue
        except ValueError as missing:
            # No confirmed answer: never guessed (T23). The field waits, the reason is recorded.
            if ask:
                ask(str(missing))
            element.evaluate(HIGHLIGHT); left.append(field['key']); continue
        kind = field.get('type', 'text')
        if kind == 'select':
            if actual['tag'] != 'SELECT':
                raise RouteError('Select schema changed')
            options = element.evaluate('(el)=>Array.from(el.options).map(o=>o.value)')
            if str(value) not in options:
                raise RouteError('Option unavailable: ' + field['key'])
            element.select_option(str(value))
        elif kind == 'text':
            element.fill(str(value))
        elif kind == 'checkbox' and field.get('ordinary'):
            element.set_checked(bool(value))
        else:
            raise RouteError('Unsupported field type: ' + kind)
        filled.append({'key': field['key'], 'selector': field['selector'], 'value': value, 'type': kind})
    return filled, left


def _upload(target, uploads, pack):
    for upload in uploads:
        kind = upload['document']; path = Path(pack['documents'][kind])
        if hashlib.sha256(path.read_bytes()).hexdigest() != pack['document_hashes'][kind]:
            raise Need('Document changed after preparation')
        element = target.locator(upload['selector'])
        if element.count() != 1:
            raise RouteError('Upload selector changed')
        element.set_input_files(str(path))
        if element.evaluate('(el)=>el.files.length') != 1:
            raise RouteError('Upload was not accepted by the form')


def receipt_pattern(adapter, job):
    pattern = adapter['receipt_pattern']
    return pattern.replace('{posting_id}', re.escape(str(job.get('posting_id') or job['id'])))


def _allowed(url, adapter):
    origins = [adapter['exact_url'], *adapter.get('allowed_origins', [])]
    return any(same_origin(url, o) for o in origins)


def _await_receipt(page, adapter, job, wait_seconds):
    """After the agent's own click: ('receipt', text, url) or ('uncertain', reason, url)."""
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        try:
            if not _allowed(page.url, adapter):
                return 'uncertain', 'The page left the route after submit; reconcile before any retry.', page.url
            el = _target(page, adapter).locator(adapter['receipt_selector'])
            if el.count() and el.first.is_visible():
                text = el.first.inner_text().strip()
                if text:
                    return 'receipt', text, page.url
        except Exception:
            pass  # navigating
        page.wait_for_timeout(250)
    return 'uncertain', 'Submit was pressed but no receipt appeared; reconcile before any retry.', page.url


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


def _withdraw(store, job, reason):
    job.update(status='closed', closed_reason=reason, closed_at=now()); store.put_job(job)
    app = store.application(job['id'])
    if app and app['status'] in ('draft', 'ready', 'blocked'):
        store.transition(job['id'], 'expired', {'reason': reason})
    store.event('posting_withdrawn', {'job_id': job['id'], 'reason': reason[:200]})


def _verify_jd(page, adapter, job, store):
    """The full current JD, at its own URL when the route has one. Returns the normalized live text."""
    jd_url = adapter.get('jd_url')
    if jd_url:
        safe_url(jd_url)
        response = page.goto(jd_url, wait_until='domcontentloaded', timeout=30000)
        if response is not None and response.status in (404, 410):
            raise Withdrawn('The job description page is gone (HTTP %d)' % response.status)
        if not _allowed(page.url, adapter | {'exact_url': jd_url}):
            raise Need('The job description redirected outside the route')
    body = page.locator('body').inner_text() if page.locator('body').count() else ''
    if CLOSED.search(body) or (adapter.get('closed_selector') and page.locator(adapter['closed_selector']).count()):
        raise Withdrawn('The employer shows this vacancy as closed')
    live = page.locator(adapter['jd_selector'])
    if live.count() != 1:
        raise RouteError('Job description selector missing or ambiguous')
    text = live.inner_text()
    if digest(text) != digest(job['description']):
        raise Need('Full description changed or mismatched; re-match before applying')
    version = jd_version(text, jd_url or adapter['exact_url']); store.record_jd(job['id'], version)
    return version


def execute(page, store, job, profile, policy, adapter, library, submit=False, wait_seconds=None):
    attempt_id = None; claimed = False
    route_id = adapter.get('id', 'exact-route')
    try:
        prior = store.application(job['id'])
        if prior and prior['status'] not in ('draft', 'ready'):
            raise Need('Posting already attempted; preserve previous documents and reconcile first')
        if not adapter.get('reviewed') or not adapter.get('route_tested'):
            raise Need('Route has not been reviewed and tested')
        if store.route(route_id)['quarantined']:
            raise Need(f'Route {route_id} is quarantined after repeated failures; fix it, then python3 -m agent.routes release')
        try:
            safe_url(adapter['exact_url']); safe_url(job['url'])
        except ContractError as e:
            raise Need('Unsafe application URL: ' + str(e))
        if job.get('deadline') and job['deadline'] < now()[:10]:
            raise Withdrawn('Past closing date')
        if adapter.get('jd_url'):
            version = _verify_jd(page, adapter, job, store)
        response = page.goto(adapter['exact_url'], wait_until='domcontentloaded', timeout=30000)
        if response is not None and response.status in (404, 410):
            raise Withdrawn('The application page is gone (HTTP %d)' % response.status)
        if page.url != adapter['exact_url'] and page.url not in adapter.get('allowed_redirects', []):
            raise Need('Login, redirect or changed application URL needs input')
        for selector in adapter.get('blocking_selectors', []):
            el = page.locator(selector)
            if el.count() and el.first.is_visible():
                raise Need('Login, CAPTCHA or unsupported step needs input')
        if not adapter.get('jd_url'):
            version = _verify_jd(page, adapter, job, store)
        job.update(live_verified=True, verified_at=now(), jd_version=version['version_id'], jd_sha256=version['sha256']); store.put_job(job)
        if score(job.get('requirements', [])) < 80:
            raise Need('Below 80%')
        pack = build(job, profile, paths.sub('packs') / job['id'])
        reasons = authorize(job, profile, pack, adapter, policy)
        if reasons:
            raise Need('; '.join(reasons))
        target = _target(page, adapter)
        form = target.locator(adapter['form_selector'])
        if form.count() != 1:
            raise RouteError('Application form missing or ambiguous')
        receipt = target.locator(adapter['receipt_selector'])
        if receipt.count() and receipt.first.is_visible():
            raise Need('Receipt already present: possible duplicate')
        ask = lambda q: record_need(store, job['id'], q)
        controls = form.evaluate(SCAN)
        filled, left = [], []
        steps = adapter.get('steps') or []
        for step in steps:
            f, l = _fill(page, adapter, pack, library, profile, job.get('country'), ask, step.get('fields', []), target)
            filled += f; left += l
            _upload(target, step.get('uploads', []), pack)
            nxt = target.locator(step['next_selector'])
            if nxt.count() != 1:
                raise RouteError('Next-step control changed')
            nxt.click(); page.wait_for_timeout(200)
            form = target.locator(adapter['form_selector'])
            if form.count() != 1:
                raise RouteError('Application form missing after a step')
            controls += form.evaluate(SCAN)
        fhash = schema_hash(controls)
        cert = adapter.get('certification') or {}
        if cert.get('form_schema_hash') and cert['form_schema_hash'] != fhash:
            raise RouteError('The form changed since the route was certified')
        sensitive, unknown, defaults = review_form(controls, adapter)
        f, l = _fill(page, adapter, pack, library, profile, job.get('country'), ask, None, target)
        filled += f; left += l
        _upload(target, adapter.get('uploads', []), pack)
        button = target.locator(adapter['submit_selector'])
        if button.count() != 1:
            raise RouteError('Submit control changed')
        input_versions = versions.current(profile, policy, library, store)
        pack.update(answers=filled, left_for_applicant=left, versions=input_versions, adapter_id=route_id)
        pack['integrity'] = pack_digest(pack)
        existing = store.application(job['id'])
        if existing and existing['status'] not in ('draft', 'ready'):
            raise Need('Posting already attempted; no resubmission')
        if not existing or existing['status'] == 'draft':
            store.draft(job, pack); store.transition(job['id'], 'ready')
        else:
            store.update_payload(job['id'], pack, expected_status='ready')
        store.route_ok(route_id)
        for d in defaults:
            ask('Pre-selected answer on a sensitive question left for you: ' + d)
        for q in unknown:
            ask('Required question with no confirmed answer: ' + q)
        if not submit:
            return {'status': 'ready', 'job_id': job['id'], 'mode': 'dry run; submit not clicked', 'left_for_applicant': left, 'unknown_required': unknown}

        auto = standing(policy) and auto_certified(adapter)
        if auto:
            held = (['The form has declarations or sensitive questions, which are yours to answer: ' + ', '.join(sensitive)] if sensitive else []) + \
                   (['Required questions with no confirmed answer: ' + ', '.join(unknown)] if unknown else []) + \
                   (['Left for you: ' + ', '.join(left)] if left else [])
            if held:
                for h in held:
                    ask(h)
                return {'status': 'needs_input', 'job_id': job['id'], 'reason': '; '.join(held), 'left_for_applicant': left, 'mode': 'held for the applicant; not submitted'}
        if daily_attempt_count(store) >= policy['daily_submission_limit']:
            raise Need('Daily attempt limit reached')

        attempt_id = new_attempt_id()
        snapshot = build_snapshot(attempt_id, job, pack, filled, adapter, fhash, input_versions, policy)
        _, snapshot_sha = seal(snapshot, pack, job['id'])
        try:
            store.claim(job['id'], actor='worker-auto' if auto else 'applicant', cap=policy['daily_submission_limit'], snapshot=snapshot,
                        snapshot_sha256=snapshot_sha, attempt_id=attempt_id, idempotency_key=f'{job["id"]}:{snapshot_sha}')
        except ClaimConflict as e:
            raise Need('Not claimed: ' + str(e))
        claimed = True
        problems = final_check(job['id'], input_versions, store=store)
        if problems:
            store.transition(job['id'], 'failed', {'reason': ' '.join(problems)}); claimed = False
            return {'status': 'not_submitted', 'job_id': job['id'], 'reason': ' '.join(problems)}

        if auto:
            store.mark_clicked(attempt_id)
            button.click()
            outcome, detail, url = _await_receipt(page, adapter, job, wait_seconds or 20)
        else:
            store.mark_clicked(attempt_id)  # the applicant may press submit at any moment from here
            page.evaluate(WATCH, [adapter['form_selector'], adapter['submit_selector']])
            print(f"Ready for you: {job.get('company', '')} — {job.get('title', '')}. Check every field, answer: {', '.join(left) or 'nothing extra'}; then click submit yourself.", flush=True)
            outcome, detail = _wait_for_applicant(page, adapter, wait_seconds or policy.get('applicant_wait_seconds', 900)); url = page.url
            if outcome == 'not_submitted':
                store.transition(job['id'], 'failed', {'reason': detail}); claimed = False
                return {'status': 'not_submitted', 'job_id': job['id'], 'reason': detail}
        if outcome == 'uncertain' or not re.search(receipt_pattern(adapter, job), detail):
            reason = detail if outcome == 'uncertain' else 'Visible text is not a success receipt correlated with this posting'
            store.transition(job['id'], 'uncertain', {'reason': reason}); claimed = False
            return {'status': 'uncertain', 'job_id': job['id'], 'reason': reason}
        proof = {'receipt': url + ' | ' + detail[:1500], 'receipt_kind': 'adapter_verified', 'submitted_at': now(), 'adapter_id': route_id,
                 'initiated_by': 'agent' if auto else 'applicant', 'attempt_id': attempt_id}
        try:
            evidence_dir = paths.sub('receipts'); evidence_dir.mkdir(parents=True, exist_ok=True)
            shot = evidence_dir / (attempt_id + '.png'); page.screenshot(path=str(shot), full_page=True); proof['screenshot'] = str(shot)
        except Exception as e:  # a proven receipt survives a screenshot failure (T34)
            proof['screenshot_warning'] = 'Screenshot could not be saved: ' + type(e).__name__
        store.transition(job['id'], 'submitted', proof); claimed = False
        return {'status': 'submitted', 'job_id': job['id'], 'receipt': proof['receipt'], 'initiated_by': proof['initiated_by'], 'attempt_id': attempt_id}
    except Exception as error:
        reason = str(error)[:1800]
        if claimed:
            store.transition(job['id'], 'uncertain', {'reason': reason})
            return {'status': 'uncertain', 'job_id': job['id'], 'reason': reason}
        if isinstance(error, Withdrawn):
            _withdraw(store, job, reason)
            return {'status': 'withdrawn', 'job_id': job['id'], 'reason': reason}
        if isinstance(error, RouteError):
            if store.route_failed(route_id, reason, (policy or {}).get('route_quarantine_after', 3)):
                reason += f' Route {route_id} is now quarantined.'
        record_need(store, job['id'], reason)
        return {'status': 'needs_input', 'job_id': job['id'], 'reason': reason}


def cycle(store, context, submit=False, wait_seconds=None):
    profile = paths.read('profile.json'); policy = paths.read('policy.json'); library = paths.read('answer_library.json')
    from .scoring import eligible
    apps = {a['job_id']: a for a in store.applications()}
    routes = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(paths.sub('adapters').glob('*.json'))]
    results = []
    for job in sorted(store.jobs(), key=lambda j: score(j.get('requirements', [])), reverse=True):
        try:
            if not job.get('requirements') or not eligible(job['requirements']):
                continue
        except ValueError:
            continue
        if job.get('status') == 'closed' or (job['id'] in apps and apps[job['id']]['status'] not in ('draft', 'ready')):
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
            result = execute(page, store, job, profile, policy, adapter, library, submit, wait_seconds)
            results.append(result); print(json.dumps(result), flush=True)
        finally:
            page.close()
    return results


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def acquire_lock(store):
    """One worker per ledger. A stale lock (its process is gone) is reconciled, never ignored (T28)."""
    paths.data_dir().mkdir(parents=True, exist_ok=True)
    lock = paths.sub('worker.lock')
    for _ in range(2):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(fd, str(os.getpid()).encode()); os.close(fd)
            recover(store)
            return lock
        except FileExistsError:
            try:
                pid = int(lock.read_text().strip() or '0')
            except (OSError, ValueError):
                pid = 0
            if pid and _pid_alive(pid):
                raise SystemExit(f'Another worker (pid {pid}) is running on this ledger.')
            store.event('stale_lock_reconciled', {'pid': pid}); lock.unlink(missing_ok=True)
    raise SystemExit('Could not take the worker lock.')


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python3 -m agent.worker')
    parser.add_argument('--submit', action='store_true', help='submit mode: automatic where allowed, otherwise wait for you')
    parser.add_argument('--once', action='store_true'); parser.add_argument('--preflight', action='store_true')
    a = parser.parse_args(argv); store = Store(paths.db_path())
    if a.preflight:
        report = preflight(store); print(json.dumps(report, indent=2))
        raise SystemExit(0 if report['ready'] else 1)
    headless = os.getenv('CAREER_HEADLESS', 'false').lower() == 'true'
    if a.submit and headless and not standing(paths.read('policy.json')):
        raise SystemExit('--submit without standing authorisation needs a visible browser: you click submit yourself. Unset CAREER_HEADLESS.')
    from playwright.sync_api import sync_playwright
    lock = acquire_lock(store)
    try:
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
