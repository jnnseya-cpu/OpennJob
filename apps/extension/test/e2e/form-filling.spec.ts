import { expect, test } from '@playwright/test';
import { PASSPORT, PROFILE, STATEMENT, VALUES, byId, fixtureLog, formSnapshot, openFixture, runAgent } from './helpers';
import type { Mode } from '../../../../packages/core/src/browser';

/**
 * These tests inject the built content script (dist/content.js) into the fixture pages
 * and drive it exactly as the popup does. The fixtures are fictional forms; see
 * test/fixtures/README.md. Nothing here touches a real website.
 */

const NHS = 'nhs-style-application.html';
const AGENCY = 'agency-quick-apply.html';
const CAPTCHA = 'captcha-application.html';
const LOGIN = 'login-wall.html';
const MODES: Mode[] = ['review', 'hybrid', 'auto'];

const NHS_EMPTY = {
  'vacancy-ref': 'MUH-EX-0412', forename: '', surname: '', 'contact-email': '', 'contact-phone': '', addr1: '', addr2: '', town: '', pcode: '', heard: '',
  'save-password': '', 'nmc-pin': '', 'supporting-info': '', 'ref1-name': '', 'ref1-org': '', 'ref1-email': '', 'ref1-phone': '',
  'rtw-yes': false, 'rtw-no': false, 'conv-yes': false, 'conv-no': false, 'ftp-yes': false, 'ftp-no': false,
  'dbs-number': '', 'dbs-update': false, 'ethnic-group': '', 'final-declaration': false,
};

const NHS_ORDINARY = {
  forename: PROFILE.firstName, surname: PROFILE.lastName, 'contact-email': PROFILE.email, 'contact-phone': PROFILE.phone,
  addr1: PROFILE.addressLine1, addr2: 'Flat 3', town: PROFILE.city, pcode: PROFILE.postcode, 'supporting-info': STATEMENT,
};

/** Sensitive fields OpennJob holds data for, and the fixture field ids they live in. */
const NHS_SENSITIVE_WITH_DATA = ['nmc-pin', 'ref1-name', 'ref1-org', 'ref1-email', 'ref1-phone', 'radio:rtw', 'dbs-number', 'dbs-update'];
/** Sensitive fields only the applicant can answer. */
const NHS_ANSWER_YOURSELF = ['radio:convictions', 'radio:ftp', 'ethnic-group', 'final-declaration'];
const NHS_ALL_SENSITIVE = [...NHS_SENSITIVE_WITH_DATA, ...NHS_ANSWER_YOURSELF];

test.describe('NHS-style multi-section form', () => {
  test('starts empty and classifies every field', async ({ page }) => {
    await openFixture(page, NHS);
    expect(await formSnapshot(page)).toEqual(NHS_EMPTY);
    const report = await runAgent(page, 'hybrid', [], { dryRun: true });
    expect(report.status).toBe('ok');
    const fields = byId(report);
    // The read-only vacancy reference and the password box are not offered at all.
    expect(Object.keys(fields).sort()).toEqual(
      ['forename', 'surname', 'contact-email', 'contact-phone', 'addr1', 'addr2', 'town', 'pcode', 'heard', 'supporting-info', ...NHS_ALL_SENSITIVE].sort(),
    );
    expect(report.fields.filter((f) => f.sensitive).map((f) => f.id).sort()).toEqual([...NHS_ALL_SENSITIVE].sort());
    expect(Object.fromEntries(NHS_ALL_SENSITIVE.map((id) => [id, fields[id]?.category]))).toEqual({
      'nmc-pin': 'registration', 'ref1-name': 'referee', 'ref1-org': 'referee', 'ref1-email': 'referee', 'ref1-phone': 'referee',
      'radio:rtw': 'right-to-work', 'dbs-number': 'dbs', 'dbs-update': 'dbs',
      'radio:convictions': 'convictions', 'radio:ftp': 'fitness-to-practise', 'ethnic-group': 'equality', 'final-declaration': 'declaration',
    });
    expect(fields['supporting-info']).toMatchObject({ key: 'supportingStatement', sensitive: false, required: true });
    expect(fields['ref1-email']?.key).toBe('referee1.email');
    expect(fields['contact-email']?.key).toBe('email');
    // A dry run writes nothing.
    expect(await formSnapshot(page)).toEqual(NHS_EMPTY);
    expect((await fixtureLog(page)).inputEvents).toEqual({});
  });

  test('hybrid: fills ordinary fields correctly, fires input and change events, leaves sensitive fields untouched', async ({ page }) => {
    await openFixture(page, NHS);
    const report = await runAgent(page, 'hybrid');

    expect(await formSnapshot(page)).toEqual({ ...NHS_EMPTY, ...NHS_ORDINARY });
    expect(report.decision).toBe('await-confirmation');
    expect(report.submitted).toBe(false);

    const log = await fixtureLog(page);
    for (const id of Object.keys(NHS_ORDINARY)) {
      expect(log.inputEvents[id], `input event on ${id}`).toBe(1);
      expect(log.changeEvents[id], `change event on ${id}`).toBe(1);
    }
    for (const id of ['nmc-pin', 'ref1-email', 'dbs-number', 'save-password']) expect(log.inputEvents[id]).toBeUndefined();
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    await expect(page.locator('#result')).toBeHidden();

    const fields = byId(report);
    for (const id of Object.keys(NHS_ORDINARY)) expect(fields[id]?.state, id).toBe('filled');
    for (const id of NHS_SENSITIVE_WITH_DATA) expect(fields[id]?.state, id).toBe('awaiting-confirmation');
    for (const id of NHS_ANSWER_YOURSELF) expect(fields[id]).toMatchObject({ state: 'answer-yourself', proposed: null, key: null });
    expect(fields.heard?.state).toBe('no-data');
  });

  test('hybrid: sensitive fields get a visible outline and are labelled as waiting', async ({ page }) => {
    await openFixture(page, NHS);
    await runAgent(page, 'hybrid');
    for (const selector of ['#nmc-pin', '#ref1-email', '#dbs-number', '#dbs-update', '#rtw-group', '#convictions-group', '#ftp-group', '#ethnic-group', '#final-declaration']) {
      const el = page.locator(selector);
      await expect(el, selector).toHaveAttribute('data-opennjob-sensitive', /.+/);
      await expect(el, selector).toHaveCSS('outline-style', 'solid');
      await expect(el, selector).toHaveCSS('outline-width', '3px');
    }
    await expect(page.locator('#nmc-pin')).toHaveAttribute('data-opennjob-state', 'awaiting-confirmation');
    await expect(page.locator('#convictions-group')).toHaveAttribute('data-opennjob-state', 'answer-yourself');
    // Ordinary fields are not outlined.
    await expect(page.locator('#forename')).not.toHaveAttribute('data-opennjob-sensitive', /.*/);
    await expect(page.locator('#forename')).toHaveCSS('outline-style', 'none');
  });

  test('hybrid: a sensitive field is filled only after the user confirms that field', async ({ page }) => {
    await openFixture(page, NHS);
    await runAgent(page, 'hybrid');

    // Confirm the NMC PIN alone.
    let report = await runAgent(page, 'hybrid', ['nmc-pin']);
    expect(await formSnapshot(page)).toEqual({ ...NHS_EMPTY, ...NHS_ORDINARY, 'nmc-pin': PASSPORT.nmcPin });
    expect(report.decision).toBe('await-confirmation');
    await expect(page.locator('#nmc-pin')).toHaveAttribute('data-opennjob-state', 'filled');

    // Confirm everything OpennJob holds data for.
    report = await runAgent(page, 'hybrid', NHS_SENSITIVE_WITH_DATA);
    const filled = {
      ...NHS_EMPTY, ...NHS_ORDINARY,
      'nmc-pin': '18A1234E', 'ref1-name': 'Priya Shah', 'ref1-org': 'Northfield General Hospital (example)', 'ref1-email': 'priya.shah@example.org', 'ref1-phone': '07700 900456',
      'rtw-yes': true, 'dbs-number': '001234567890', 'dbs-update': true,
    };
    expect(await formSnapshot(page)).toEqual(filled);
    // Still waiting: convictions, fitness to practise, equality monitoring and the final declaration are the applicant's to answer.
    expect(report.decision).toBe('await-confirmation');
    expect(report.submitted).toBe(false);

    // Even with every sensitive field acknowledged, OpennJob does not answer those four and does not submit.
    report = await runAgent(page, 'hybrid', NHS_ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    expect(await formSnapshot(page)).toEqual(filled);
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    expect(log.inputEvents['nmc-pin']).toBe(1); // filled once, not re-typed on later runs
    expect(log.changeEvents['rtw-yes']).toBe(1);
    expect(log.changeEvents['dbs-update']).toBe(1);
    await expect(page.locator('#result')).toBeHidden();
  });

  test('review: nothing is filled until the user confirms it, field by field, and submit is never pressed', async ({ page }) => {
    await openFixture(page, NHS);
    let report = await runAgent(page, 'review');
    expect(await formSnapshot(page)).toEqual(NHS_EMPTY);
    expect(report.decision).toBe('await-confirmation');
    expect(report.fields.filter((f) => f.state === 'filled')).toEqual([]);

    report = await runAgent(page, 'review', ['forename', 'nmc-pin']);
    expect(await formSnapshot(page)).toEqual({ ...NHS_EMPTY, forename: 'Amara', 'nmc-pin': '18A1234E' });
    expect(report.decision).toBe('await-confirmation');

    const everyId = report.fields.map((f) => f.id);
    report = await runAgent(page, 'review', everyId);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    const snapshot = await formSnapshot(page);
    expect(snapshot).toMatchObject({ ...NHS_ORDINARY, 'nmc-pin': '18A1234E', 'rtw-yes': true, 'dbs-update': true });
    expect(snapshot).toMatchObject({ 'conv-yes': false, 'conv-no': false, 'ftp-yes': false, 'ftp-no': false, 'ethnic-group': '', 'final-declaration': false });
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
  });

  test('auto: a form with sensitive fields is held for the user and never submitted, even after confirmation', async ({ page }) => {
    await openFixture(page, NHS);
    let report = await runAgent(page, 'auto');
    expect(report.decision).toBe('await-confirmation');
    expect(report.submitted).toBe(false);
    expect(await formSnapshot(page)).toEqual({ ...NHS_EMPTY, ...NHS_ORDINARY });

    report = await runAgent(page, 'auto', NHS_ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    expect(report.message).toMatch(/did not submit/);

    // Even if the applicant then completes every remaining answer by hand, another run still does not submit.
    await page.check('#conv-no');
    await page.check('#ftp-no');
    await page.selectOption('#ethnic-group', 'Prefer not to say');
    await page.check('#final-declaration');
    report = await runAgent(page, 'auto', NHS_ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    await expect(page.locator('#result')).toBeHidden();
  });

  for (const mode of MODES) {
    test(`${mode}: never answers convictions, fitness to practise, equality monitoring or the final declaration`, async ({ page }) => {
      await openFixture(page, NHS);
      const first = await runAgent(page, mode);
      const report = await runAgent(page, mode, first.fields.map((f) => f.id));
      expect(await formSnapshot(page)).toMatchObject({ 'conv-yes': false, 'conv-no': false, 'ftp-yes': false, 'ftp-no': false, 'ethnic-group': '', 'final-declaration': false });
      expect(report.submitted).toBe(false);
    });

    test(`${mode}: never touches the password field or the read-only field`, async ({ page }) => {
      await openFixture(page, NHS);
      const first = await runAgent(page, mode);
      const report = await runAgent(page, mode, [...first.fields.map((f) => f.id), 'save-password', 'name:savePassword']);
      const snapshot = await formSnapshot(page);
      expect(snapshot['save-password']).toBe('');
      expect(snapshot['vacancy-ref']).toBe('MUH-EX-0412');
      expect(report.fields.some((f) => /password/i.test(`${f.id} ${f.label}`))).toBe(false);
      const log = await fixtureLog(page);
      expect(log.inputEvents['save-password']).toBeUndefined();
      await expect(page.locator('#save-password')).not.toHaveAttribute('data-opennjob-state', /.*/);
    });
  }

  test('does not overwrite what the applicant has already typed or chosen', async ({ page }) => {
    await openFixture(page, NHS);
    await page.fill('#forename', 'Amy');
    await page.fill('#supporting-info', 'My own words.');
    await page.check('#rtw-no');
    const report = await runAgent(page, 'hybrid', ['radio:rtw']);
    const snapshot = await formSnapshot(page);
    expect(snapshot.forename).toBe('Amy');
    expect(snapshot['supporting-info']).toBe('My own words.');
    expect(snapshot['rtw-no']).toBe(true);
    expect(snapshot['rtw-yes']).toBe(false);
    const fields = byId(report);
    expect(fields.forename).toMatchObject({ state: 'skipped', reason: 'already has a value; left as it is' });
    expect(fields['radio:rtw']).toMatchObject({ state: 'skipped', reason: 'already answered; left as it is' });
    expect(snapshot.surname).toBe('Okafor');
  });

  test('never offers "No" for right to work and never ticks a box for a stored "no"', async ({ page }) => {
    await openFixture(page, NHS);
    const values = { ...VALUES, dbsUpdateService: false };
    delete values.rightToWork;
    const report = await runAgent(page, 'hybrid', NHS_SENSITIVE_WITH_DATA, { values });
    const snapshot = await formSnapshot(page);
    expect(snapshot).toMatchObject({ 'rtw-yes': false, 'rtw-no': false, 'dbs-update': false });
    expect(byId(report)['radio:rtw']?.state).toBe('answer-yourself');
  });

  test('refuses to truncate a statement that is longer than the field allows', async ({ page }) => {
    await openFixture(page, NHS);
    await page.evaluate(() => document.getElementById('supporting-info')?.setAttribute('maxlength', '50'));
    const report = await runAgent(page, 'hybrid');
    expect((await formSnapshot(page))['supporting-info']).toBe('');
    expect(byId(report)['supporting-info']).toMatchObject({ state: 'skipped' });
    expect(byId(report)['supporting-info']?.reason).toMatch(/allows 50/);
  });
});

test.describe('agency quick-apply form (no declarations)', () => {
  const FILLED = { 'qa-name': 'Amara Okafor', 'qa-email': PROFILE.email, 'qa-phone': PROFILE.phone, 'qa-postcode': PROFILE.postcode, 'qa-cover': STATEMENT, 'qa-email2': '' };

  for (const mode of ['review', 'hybrid'] as const) {
    test(`${mode}: fills the form and does not submit`, async ({ page }) => {
      await openFixture(page, AGENCY);
      const first = await runAgent(page, mode);
      const report = await runAgent(page, mode, first.fields.map((f) => f.id));
      expect(await formSnapshot(page)).toEqual(FILLED);
      expect(report.decision).toBe('fill-only');
      expect(report.submitted).toBe(false);
      expect(report.fields.some((f) => f.sensitive)).toBe(false);
      const log = await fixtureLog(page);
      expect(log.submitCount).toBe(0);
      expect(log.submitClicks).toBe(0);
      await expect(page.locator('#result')).toBeHidden();
    });
  }

  test('hybrid: fills immediately with no confirmation needed', async ({ page }) => {
    await openFixture(page, AGENCY);
    const report = await runAgent(page, 'hybrid');
    expect(await formSnapshot(page)).toEqual(FILLED);
    expect(report.decision).toBe('fill-only');
    expect((await fixtureLog(page)).submitCount).toBe(0);
  });

  test('auto: fills the form and submits it, once', async ({ page }) => {
    await openFixture(page, AGENCY);
    const report = await runAgent(page, 'auto');
    expect(report.decision).toBe('submit');
    expect(report.submitted).toBe(true);
    expect(await formSnapshot(page)).toEqual(FILLED);
    const log = await fixtureLog(page);
    expect(log.submitClicks).toBe(1);
    expect(log.submitCount).toBe(1);
    expect(log.inputEvents).toMatchObject({ 'qa-name': 1, 'qa-email': 1, 'qa-phone': 1, 'qa-postcode': 1, 'qa-cover': 1 });
    await expect(page.locator('#result')).toBeVisible();
  });

  test('auto: leaves the hidden trap field alone', async ({ page }) => {
    await openFixture(page, AGENCY);
    const report = await runAgent(page, 'auto');
    expect(report.fields.map((f) => f.id)).not.toContain('qa-email2');
    expect((await formSnapshot(page))['qa-email2']).toBe('');
    expect((await fixtureLog(page)).inputEvents['qa-email2']).toBeUndefined();
  });

  test('auto: does not submit when a required field could not be filled', async ({ page }) => {
    await openFixture(page, AGENCY);
    const values = { ...VALUES };
    delete values.phone;
    const report = await runAgent(page, 'auto', [], { values });
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    expect((await fixtureLog(page)).submitClicks).toBe(0);
    await expect(page.locator('#result')).toBeHidden();
  });

  test('auto: does not submit if the page gains a sensitive field', async ({ page }) => {
    await openFixture(page, AGENCY);
    await page.evaluate(() => {
      const label = document.createElement('label');
      label.htmlFor = 'late-declaration';
      label.textContent = 'Do you have any criminal convictions?';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'late-declaration';
      document.querySelector('form')?.prepend(label, input);
    });
    const report = await runAgent(page, 'auto');
    expect(report.decision).toBe('await-confirmation');
    expect(report.submitted).toBe(false);
    expect((await fixtureLog(page)).submitClicks).toBe(0);
  });

  test('a dry run in auto mode fills nothing and does not submit', async ({ page }) => {
    await openFixture(page, AGENCY);
    const report = await runAgent(page, 'auto', [], { dryRun: true });
    expect(report.submitted).toBe(false);
    expect(report.fields.every((f) => f.state === 'will-fill')).toBe(true);
    expect((await formSnapshot(page))['qa-name']).toBe('');
    expect((await fixtureLog(page)).submitClicks).toBe(0);
  });
});

test.describe('OD-6: declarations answered from the person\'s own answers (owner decision, 8 October 2026)', () => {
  const ALL = { everConvicted: false, conflictOfInterest: false, certifyAndConsent: true, equalityPreferNotToSay: true };

  test('auto: every declaration answered from the record, so the form is submitted', async ({ page }) => {
    await openFixture(page, 'declarations-application.html');
    const report = await runAgent(page, 'auto', [], { declarations: ALL });
    const form = await formSnapshot(page);
    expect(form['d-conv-no']).toBe(true);
    expect(form['d-coi-no']).toBe(true);
    expect(form['d-gender']).toBe('Prefer not to say');
    expect(form['d-eth-x']).toBe(true);
    expect(form['d-certify']).toBe(true);
    expect(form['d-privacy']).toBe(true);
    expect(report.decision).toBe('submit');
    expect(report.submitted).toBe(true);
    expect((await fixtureLog(page)).submitCount).toBe(1);
  });

  test('auto: one declaration not answered in the record still stops the submit, and nothing is assumed', async ({ page }) => {
    await openFixture(page, 'declarations-application.html');
    const report = await runAgent(page, 'auto', [], { declarations: { ...ALL, everConvicted: undefined } as unknown as Record<string, boolean> });
    const form = await formSnapshot(page);
    expect(form['d-conv-no']).toBe(false);
    expect(form['d-conv-yes']).toBe(false);
    expect(report.submitted).toBe(false);
    expect((await fixtureLog(page)).submitCount).toBe(0);
  });

  test('no recorded answers: nothing sensitive is filled and nothing is submitted, as before', async ({ page }) => {
    await openFixture(page, 'declarations-application.html');
    const report = await runAgent(page, 'auto', []);
    const form = await formSnapshot(page);
    expect(form['d-certify']).toBe(false);
    expect(form['d-gender']).toBe('');
    expect(report.submitted).toBe(false);
  });
});

test.describe('pages the agent must stop on', () => {
  for (const mode of MODES) {
    test(`${mode}: stops on the CAPTCHA fixture, fills nothing, does not submit, and tells the user`, async ({ page }) => {
      await openFixture(page, CAPTCHA);
      const before = await formSnapshot(page);
      for (const confirmed of [[], ['c-name', 'c-email', 'c-phone']]) {
        const report = await runAgent(page, mode, confirmed);
        expect(report.status).toBe('blocked');
        expect(report.blockers).toEqual(['captcha']);
        expect(report.decision).toBeNull();
        expect(report.submitted).toBe(false);
        expect(report.fields).toEqual([]);
        expect(report.message).toMatch(/CAPTCHA/);
        expect(report.message).toMatch(/Nothing was filled/);
      }
      expect(await formSnapshot(page)).toEqual(before);
      const log = await fixtureLog(page);
      expect(log.inputEvents).toEqual({});
      expect(log.submitClicks).toBe(0);
      expect(log.submitCount).toBe(0);
      // The mock widget itself is not clicked or altered.
      await expect(page.locator('.g-recaptcha')).not.toHaveAttribute('data-opennjob-state', /.*/);
    });
  }

  test('an invisible reCAPTCHA alone (badge, no puzzle) does not stop the fill, and is not touched (owner decision, 8 October 2026)', async ({ page }) => {
    await openFixture(page, 'invisible-recaptcha-application.html');
    const report = await runAgent(page, 'hybrid', []);
    expect(report.blockers).toEqual([]);
    expect(report.status).not.toBe('blocked');
    expect(report.submitted).toBe(false); // hybrid never submits
    const filled = await formSnapshot(page);
    expect(filled['i-name']).not.toBe('');
    expect(filled['i-email']).not.toBe('');
    // The reCAPTCHA parts are left exactly as they were.
    expect(filled['g-recaptcha-response']).toBe('');
    await expect(page.locator('.g-recaptcha')).not.toHaveAttribute('data-opennjob-state', /.*/);
  });

  test('stops on a login wall and never fills the email or password', async ({ page }) => {
    await openFixture(page, LOGIN);
    for (const mode of MODES) {
      const report = await runAgent(page, mode, ['login-email', 'login-password']);
      expect(report.status).toBe('blocked');
      expect(report.blockers).toEqual(['login-wall']);
      expect(report.message).toMatch(/sign in/);
    }
    expect(await formSnapshot(page)).toEqual({ 'login-email': '', 'login-password': '' });
    expect((await fixtureLog(page)).submitClicks).toBe(0);
  });
});

test.describe('older portals: labels written beside the box, not linked to it', () => {
  test('reads the label from the table cell or the text before the box, fills ordinary fields, leaves the declaration', async ({ page }) => {
    await openFixture(page, 'sf-classic.html');
    const report = await runAgent(page, 'hybrid');
    const byId = Object.fromEntries(report.fields.map((f) => [f.id, f]));
    expect(byId['c-first']).toMatchObject({ label: 'First Name *', key: 'firstName', state: 'filled' });
    expect(byId['c-last']).toMatchObject({ key: 'lastName', state: 'filled' });
    expect(byId['c-email']).toMatchObject({ key: 'email', state: 'filled' });
    expect(byId['c-phone']?.key).toBe('phone');
    expect(byId['c-post']?.key).toBe('postcode');
    // A conviction question stays the person's, however its label is written.
    expect(byId['c-conv']).toMatchObject({ sensitive: true, category: 'convictions' });
    expect(byId['c-conv']?.state).not.toBe('filled');
    expect(byId['c-statement']?.label).toBe('Cover letter');
    const values = await formSnapshot(page);
    expect(values['c-first']).toBe(PROFILE.firstName);
    expect(values['c-conv']).toBe('');
  });
});
