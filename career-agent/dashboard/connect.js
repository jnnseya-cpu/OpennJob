'use strict';
/* Live ledger: the dashboard connected to the local agent (agent/server.py), served from the same
   address. Every value from the agent is written with textContent. Without a connection the page
   says so and shows nothing as live; local marks elsewhere on the page stay "self-reported". */
(() => {
  const KEY = 'nseya-agent-token';
  const $ = (s) => document.querySelector(s);
  const make = (tag, props = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const c of children) if (c) e.append(c);
    return e;
  };
  let connected = false; let lastSync = null; let ledger = { jobs: [], applications: [], sources: [] };

  const bar = make('div', { id: 'connection', class: 'notice', role: 'status' });
  const statusText = make('span', { id: 'connection-status', text: 'Not connected to your local agent. Nothing on this page is live; local marks are self-reported.' });
  const token = make('input', { id: 'agent-token', type: 'password', autocomplete: 'off', placeholder: 'Local agent token', 'aria-label': 'Local agent token' });
  const button = make('button', { id: 'connect', class: 'secondary', text: 'Connect', onclick: () => connect(token.value.trim()) });
  bar.append(make('b', { text: 'Local agent' }), statusText, token, button);
  const header = $('main header');
  if (header) header.after(bar);

  const section = make('section', { id: 'ledger', hidden: '' });
  const content = $('#content'); if (content) content.after(section);
  const nav = $('nav');
  const tab = make('button', { 'data-ledger': 'true', text: 'Live ledger' });
  if (nav) nav.prepend(tab);
  tab.addEventListener('click', () => { document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active')); tab.classList.add('active'); content.hidden = true; section.hidden = false; $('#heading').textContent = 'Live ledger'; render(); });
  document.querySelectorAll('nav button[data-tab]').forEach((b) => b.addEventListener('click', () => { tab.classList.remove('active'); section.hidden = true; content.hidden = false; }));

  async function api(path, options = {}) {
    const res = await fetch(path, { ...options, headers: { Authorization: 'Bearer ' + (sessionStorage.getItem(KEY) || ''), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(body.error || (body.blockers || []).join('; ') || res.status); err.status = res.status; throw err; }
    return body;
  }

  function setStatus(on, text) {
    connected = on; statusText.textContent = text; bar.dataset.connected = String(on);
  }

  async function connect(value) {
    if (value) { try { sessionStorage.setItem(KEY, value); } catch { /* private mode */ } }
    try {
      const health = await api('/api/health');
      const [jobs, applications, sources] = await Promise.all([api('/api/jobs'), api('/api/applications'), api('/api/sources')]);
      ledger = { health, jobs: jobs.jobs, applications: applications.applications, sources: sources.sources, coverage: sources.coverage };
      lastSync = new Date();
      setStatus(true, `Connected to your local agent · last sync ${lastSync.toLocaleTimeString('en-GB')} · ${health.standing_authorization ? 'standing authorisation on' : 'you submit'}${health.enabled ? '' : ' · PAUSED'}`);
    } catch (e) {
      ledger = { jobs: [], applications: [], sources: [] };
      setStatus(false, e.status === 401 ? 'The agent refused this token. Not connected; nothing on this page is live.' : 'Not connected to your local agent. Nothing on this page is live; local marks are self-reported.');
    }
    if (!section.hidden) render();
  }

  function table(headers, rows) {
    const t = make('table', { class: 'ledger-table' });
    t.append(make('thead', {}, make('tr', {}, ...headers.map((h) => make('th', { text: h })))));
    const body = make('tbody');
    for (const r of rows) body.append(make('tr', {}, ...r.map((c) => make('td', { text: c == null ? '' : String(c) }))));
    if (!rows.length) body.append(make('tr', {}, make('td', { colspan: String(headers.length), text: 'None yet.' })));
    t.append(body); return t;
  }

  function render() {
    section.replaceChildren();
    if (!connected) {
      section.append(make('div', { class: 'panel' }, make('h2', { text: 'Not connected' }), make('p', { id: 'ledger-empty', text: 'Start the local agent (python3 -m agent.server), open it at its local address and enter your token. Until then nothing here is live, and no draft or local mark counts as an application.' })));
      return;
    }
    const h = ledger.health;
    section.append(make('div', { class: 'panel' }, make('h2', { text: 'Agent' }),
      make('p', { id: 'ledger-health', text: `Worker ${h.worker_running ? 'running' : 'not running'} · attempts today ${h.attempts_today} · last discovery ${h.last_discovery || 'never'} · ledger schema v${h.schema_version}` })));
    section.append(make('div', { class: 'panel' }, make('h2', { text: 'Applications (from the ledger)' }),
      table(['Job', 'Status', 'Receipt', 'By', 'Attempts', 'Employer outcomes', 'Reason'], ledger.applications.map((a) => [a.job_id, a.status, a.receipt ? `${a.receipt.slice(0, 120)} (${a.receipt_kind})` : '', a.initiated_by || '', a.attempts.length, a.outcomes.map((o) => `${o.kind.replace(/_/g, ' ')} ${o.occurred_on}`).join('; '), a.reason || '']))));
    section.append(make('div', { class: 'panel' }, make('h2', { text: 'Postings' }),
      table(['Company', 'Title', 'Country', 'Coverage (raw)', 'Eligible', 'Reviewed'], ledger.jobs.map((j) => [j.company, j.title, j.country, `${j.coverage_display}% (${j.raw_coverage})`, j.eligible ? 'yes' : 'no', j.matching_reviewed ? 'yes' : 'no']))));
    section.append(make('div', { class: 'panel' }, make('h2', { text: 'Sources' }),
      table(['Source', 'Last OK', 'Jobs', 'Failures in a row', 'Truncated'], ledger.sources.map((s) => [s.company, s.last_ok || 'never', s.jobs, s.consecutive_failures, s.truncated ? 'yes' : 'no'])),
      make('p', { class: 'help', text: ledger.coverage ? ledger.coverage.statement : '' })));
    section.append(practicePanel());
  }

  function practicePanel() {
    const sent = ledger.applications.filter((a) => a.status !== 'draft');
    const select = make('select', { id: 'practice-app', 'aria-label': 'Application' }, ...sent.map((a) => make('option', { value: a.job_id, text: a.job_id })));
    const question = make('input', { id: 'practice-question', value: 'Tell me about a time you governed contractors on a complex project.', 'aria-label': 'Question' });
    const answer = make('textarea', { id: 'practice-answer', placeholder: 'Type your answer. Dictation is optional.', 'aria-label': 'Your answer' });
    const out = make('div', { id: 'practice-out', role: 'status' });
    const speech = 'speechSynthesis' in window; const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const read = make('button', { class: 'secondary', id: 'practice-read', text: 'Read question aloud', onclick: () => speechSynthesis.speak(new SpeechSynthesisUtterance(question.value)) });
    if (!speech) { read.disabled = true; read.title = 'Speech is not available in this browser; read and type instead.'; }
    const dictate = make('button', { class: 'secondary', id: 'practice-dictate', text: 'Dictate', onclick: () => {
      try { const r = new Recognition(); r.lang = 'en-GB'; r.onresult = (ev) => { answer.value += ' ' + ev.results[0][0].transcript; }; r.onerror = () => { out.textContent = 'Dictation stopped (microphone refused or unavailable). Type your answer instead.'; }; r.start(); }
      catch { out.textContent = 'Dictation is unavailable here. Type your answer instead.'; }
    } });
    if (!Recognition) { dictate.disabled = true; dictate.title = 'Dictation is not available in this browser.'; }
    const go = make('button', { id: 'practice-go', text: 'Get feedback', onclick: async () => {
      out.replaceChildren(make('p', { text: 'Checking…' }));
      try {
        const r = await api('/api/practice', { method: 'POST', body: JSON.stringify({ job_id: select.value, question: question.value, answer: answer.value }) });
        const f = r.feedback;
        out.replaceChildren(make('p', { text: 'Practice only: nothing is sent to an employer.' }),
          make('p', { id: 'practice-unsupported', text: f.unsupported_claims.length ? 'Not in what you sent: ' + f.unsupported_claims.join(', ') : 'Every detail is in what you sent.' }),
          make('ul', {}, ...f.improvements.map((i) => make('li', { text: i }))), f.llm_error ? make('p', { text: f.llm_error }) : null);
      } catch (e) {
        out.replaceChildren(make('p', { text: 'Feedback is unavailable right now (' + e.message + '). Your typed answer is kept here.' }));
      }
    } });
    return make('div', { class: 'panel' }, make('h2', { text: 'Interview practice for a real application' }),
      make('p', { class: 'help', text: 'Questions and feedback use the exact CV, cover letter and answers sent for that application.' }), select, question, make('div', { class: 'toolbar' }, read, dictate), answer, make('div', { class: 'toolbar' }, go), out);
  }

  const saved = (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();
  if (saved && location.protocol.startsWith('http')) connect(); else setStatus(false, statusText.textContent);
  window.__ledger = { connect, state: () => ({ connected, lastSync }) };
})();
