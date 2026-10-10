// A fictional single-page application shaped like a Workday career site. Each screen replaces
// the last (only the current step is in the page). The submit is reported to the fixture server.
(function () {
  const variant = new URLSearchParams(location.search).get('variant') || 'plain';
  const steps = ['info', 'experience', 'questions'].concat(variant === 'disclosures' ? ['disclosures'] : []).concat(['review']);
  let screen = 'job';
  const app = () => document.getElementById('app');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function listbox(id, label, options) {
    return `<div data-automation-id="formField-${id}" class="field"><label id="lbl-${id}">${esc(label)}*</label>
      <button type="button" aria-haspopup="listbox" aria-labelledby="lbl-${id}" aria-controls="lb-${id}" data-automation-id="${id}" id="${id}">Select One</button>
      <ul role="listbox" id="lb-${id}" hidden>${options.map((o) => `<li role="option" tabindex="-1">${esc(o)}</li>`).join('')}</ul></div>`;
  }
  function text(id, label, type) {
    return `<div data-automation-id="formField-${id}" class="field"><label for="${id}">${esc(label)}*</label><input type="${type || 'text'}" id="${id}" data-automation-id="${id}" aria-required="true"></div>`;
  }
  const progress = () => `<div data-automation-id="progressBar"><ol>${steps.map((s) => `<li${s === screen ? ' aria-current="step"' : ''}>${s}</li>`).join('')}</ol></div>`;
  const nav = (label) => `<div class="nav"><button type="button" data-automation-id="bottom-navigation-next-button">${label}</button></div><div id="errors"></div>`;

  function render() {
    const root = app();
    if (screen === 'job') {
      root.innerHTML = `<h2 data-automation-id="jobPostingHeader">Electrical Project Manager (fictional)</h2>
        <p>Leeds. Lead HV substation projects. A fictional vacancy for the OpennJob tests.</p>
        <a href="#" role="button" data-automation-id="adventureButton">Apply</a>`;
    } else if (screen === 'start') {
      root.innerHTML = `<div role="dialog" aria-label="Start your application"><h2>Start Your Application</h2>
        <a href="#" role="button" data-automation-id="autofillWithResume">Autofill with Resume</a>
        <a href="#" role="button" data-automation-id="applyManually">Apply Manually</a>
        <a href="#" role="button" data-automation-id="useMyLastApplication">Use My Last Application</a></div>`;
    } else if (screen === 'signin') {
      root.innerHTML = `<div data-automation-id="signInContent"><h2>Sign In</h2>
        <label for="si-email">Email Address</label><input type="email" id="si-email" data-automation-id="email">
        <label for="si-pw">Password</label><input type="password" id="si-pw" data-automation-id="password">
        <button type="button" data-automation-id="signInSubmitButton">Sign In</button>
        <a href="#" data-automation-id="createAccountLink">Create Account</a></div>`;
    } else if (screen === 'info') {
      root.innerHTML = `${progress()}<h2 data-automation-id="pageHeader">My Information</h2>
        ${listbox('countryDropdown', 'Country', ['France', 'United Kingdom', 'United States'])}
        ${text('legalNameSection_firstName', 'Given Name(s)')}${text('legalNameSection_lastName', 'Family Name')}
        ${text('addressSection_addressLine1', 'Address Line 1')}${text('addressSection_city', 'City')}${text('addressSection_postalCode', 'Postal Code')}
        ${text('email', 'Email Address', 'email')}${listbox('phone-device-type', 'Phone Device Type', ['Landline', 'Mobile'])}${text('phone-number', 'Phone Number', 'tel')}
        ${nav('Save and Continue')}`;
    } else if (screen === 'experience') {
      root.innerHTML = `${progress()}<h2 data-automation-id="pageHeader">My Experience</h2>
        <section aria-label="Resume/CV"><h3>Resume/CV</h3>
        <input type="file" data-automation-id="file-upload-input-ref" accept=".pdf,.doc,.docx" aria-required="true" aria-label="Upload resume or CV"></section>
        ${nav('Save and Continue')}`;
    } else if (screen === 'questions') {
      root.innerHTML = `${progress()}<h2 data-automation-id="pageHeader">Application Questions</h2>
        <fieldset><legend>Do you have the right to work in the United Kingdom?*</legend>
          <label><input type="radio" name="rtw" value="Yes" required> Yes</label><label><input type="radio" name="rtw" value="No"> No</label></fieldset>
        <fieldset><legend>Will you need visa sponsorship to work in the United Kingdom?*</legend>
          <label><input type="radio" name="sponsor" value="Yes" required> Yes</label><label><input type="radio" name="sponsor" value="No"> No</label></fieldset>
        ${text('notice', 'What is your notice period?')}
        ${nav('Save and Continue')}`;
    } else if (screen === 'disclosures') {
      root.innerHTML = `${progress()}<h2 data-automation-id="pageHeader">Voluntary Disclosures</h2>
        <div class="field"><label for="gender">What is your gender?</label><select id="gender"><option value="">Select One</option><option>Woman</option><option>Man</option><option>Prefer not to say</option></select></div>
        <div class="field"><label><input type="checkbox" id="terms" required> I have read and consent to the terms and conditions*</label></div>
        ${nav('Save and Continue')}`;
    } else if (screen === 'review') {
      root.innerHTML = `${progress()}<h2 data-automation-id="pageHeader">Review</h2><p>Check your application, then submit it.</p>${nav('Submit')}`;
    } else if (screen === 'done') {
      root.innerHTML = `<h1>Thank you for applying. Your application has been submitted.</h1><p>Reference WD-0001 (fictional).</p>`;
    }
  }

  function requiredMissing() {
    const missing = [];
    for (const el of app().querySelectorAll('input[aria-required="true"], input[required]')) {
      if (el.type === 'radio') { if (!app().querySelector(`input[name="${el.name}"]:checked`)) missing.push(el.name); }
      else if (el.type === 'file') { if (!el.files || el.files.length === 0) missing.push('file'); }
      else if (el.type === 'checkbox') { if (!el.checked) missing.push(el.id); }
      else if (!el.value.trim()) missing.push(el.id);
    }
    for (const b of app().querySelectorAll('button[aria-haspopup="listbox"]')) if (b.textContent.trim() === 'Select One') missing.push(b.id);
    return missing;
  }

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-automation-id], [role="option"]');
    if (!target) return;
    e.preventDefault();
    const id = target.getAttribute('data-automation-id');
    if (target.getAttribute('role') === 'option') {
      const list = target.closest('[role="listbox"]');
      const button = document.querySelector(`[aria-controls="${list.id}"]`);
      button.textContent = target.textContent;
      list.hidden = true;
      return;
    }
    if (target.getAttribute('aria-haspopup') === 'listbox') {
      setTimeout(() => { document.getElementById(target.getAttribute('aria-controls')).hidden = false; }, 120); // the list opens a moment later
      return;
    }
    if (id === 'adventureButton') { screen = 'start'; render(); return; }
    if (id === 'applyManually') {
      screen = variant === 'signin' && localStorage.getItem('wd-signed-in') !== '1' ? 'signin' : 'info';
      render(); return;
    }
    if (id === 'signInSubmitButton') { localStorage.setItem('wd-signed-in', '1'); screen = 'info'; render(); return; }
    if (id === 'bottom-navigation-next-button') {
      const missing = requiredMissing();
      if (missing.length) { document.getElementById('errors').innerHTML = `<div data-automation-id="errorMessage" role="alert">Errors found: ${missing.length} required field(s) are missing.</div>`; return; }
      if (screen === 'review') {
        fetch(`/hit?form=workday-${variant}`, { method: 'POST', keepalive: true }).finally(() => { screen = 'done'; render(); });
        return;
      }
      setTimeout(() => { screen = steps[steps.indexOf(screen) + 1]; render(); }, 200);
    }
  });
  document.addEventListener('DOMContentLoaded', render);
})();
