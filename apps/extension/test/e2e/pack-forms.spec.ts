import { expect, test } from '@playwright/test';
import { byId, fixtureLog, formSnapshot, openFixture, runAgent } from './helpers';
import { buildFillValues } from '../../../../packages/core/src/browser';
import type { FillValues, Mode, Passport, Profile } from '../../../../packages/core/src/browser';

/**
 * The two forms added with the industry packs: an English construction-sector form and a
 * French form. Same method as form-filling.spec.ts: the built content script is injected
 * into a fictional fixture page. Nothing here touches a real website, and French field
 * detection has only ever been tried on this one fixture.
 */

const CONSTRUCTION = 'construction-application.html';
const FRENCH = 'candidature-fr.html';
const MODES: Mode[] = ['review', 'hybrid', 'auto'];

/** Entirely fictional applicant. The numbers are made up and belong to nobody. */
const PROFILE: Profile = {
  firstName: 'Mireille',
  lastName: 'Kabongo-Example',
  email: 'mireille.kabongo@example.org',
  phone: '07700 900555',
  addressLine1: '4 Sample Yard',
  city: 'Birmingham',
  postcode: 'B2 2ZZ',
  cvText: 'Fictional construction manager with twelve years on multi-contractor hospital and data centre sites.',
  preferences: { languages: ['English', 'French'], countries: [], cities: [] },
};

const PASSPORT: Passport = {
  credentials: { prof: 'MCIOB 0000000', cscs: '00000000', sc: 'SC (fictional)', lang: 'English, French, Lingala', rtw: 'United Kingdom' },
  rightToWorkConfirmed: true,
  training: [],
  referees: [{ name: 'Tomasz Fixture', relationship: 'Project Director', organisation: 'Corbel & Wray Developments (example)', email: 'tomasz.fixture@example.org', phone: '07700 900666' }],
};

const STATEMENT = 'I have led multi-contractor hospital sites under NEC4.\nI hold the SMSTS certificate and I am a chartered member of the CIOB.';
const VALUES: FillValues = buildFillValues(PROFILE, PASSPORT, STATEMENT);
const run = (page: Parameters<typeof runAgent>[0], mode: Mode, confirmed: string[] = [], options: { dryRun?: boolean } = {}) =>
  runAgent(page, mode, confirmed, { values: VALUES, ...options });

test('the fill values carry the new credential fields and nothing for clearance or work countries', () => {
  expect(VALUES).toMatchObject({ professionalMembershipNumber: 'MCIOB 0000000', cscsCardNumber: '00000000', languages: 'English, French, Lingala', rightToWork: true });
  // credentials.sc and credentials.rtw are stored for matching and display. They are never typed into a form.
  expect(Object.values(VALUES)).not.toContain('SC (fictional)');
  expect(Object.values(VALUES)).not.toContain('United Kingdom');
  expect(VALUES.nmcPin).toBeUndefined();
});

test.describe('construction-sector form (English)', () => {
  const EMPTY = {
    given: '', family: '', mail: '', mobile: '', street: '', locality: '', 'post-code': '', spoken: '', notice: '',
    'membership-no': '', 'cscs-no': '', 'why-you': '',
    'clearance-yes': false, 'clearance-no': false, 'work-right-yes': false, 'work-right-no': false, 'sponsor-yes': false, 'sponsor-no': false,
    'interest-yes': false, 'interest-no': false, 'interest-detail': '', 'record-yes': false, 'record-no': false,
    'r1-name': '', 'r1-company': '', 'r1-mail': '', truth: false,
  };
  const ORDINARY = {
    given: 'Mireille', family: 'Kabongo-Example', mail: 'mireille.kabongo@example.org', mobile: '07700 900555', street: '4 Sample Yard',
    locality: 'Birmingham', 'post-code': 'B2 2ZZ', spoken: 'English, French, Lingala', 'why-you': STATEMENT,
  };
  /** Sensitive fields OpennJob holds a value for. */
  const WITH_DATA = ['membership-no', 'cscs-no', 'radio:workRight', 'r1-name', 'r1-company', 'r1-mail'];
  /** Sensitive fields only the applicant can answer. */
  const ANSWER_YOURSELF = ['radio:clearance', 'radio:sponsor', 'radio:interest', 'interest-detail', 'radio:record', 'truth'];
  const ALL_SENSITIVE = [...WITH_DATA, ...ANSWER_YOURSELF];
  const UNANSWERED = {
    'clearance-yes': false, 'clearance-no': false, 'sponsor-yes': false, 'sponsor-no': false, 'interest-yes': false, 'interest-no': false,
    'interest-detail': '', 'record-yes': false, 'record-no': false, truth: false,
  };

  test('starts empty and classifies every field', async ({ page }) => {
    await openFixture(page, CONSTRUCTION);
    expect(await formSnapshot(page)).toEqual(EMPTY);
    const report = await run(page, 'hybrid', [], { dryRun: true });
    expect(report.status).toBe('ok');
    const fields = byId(report);
    expect(Object.keys(fields).sort()).toEqual([...Object.keys(ORDINARY), 'notice', ...ALL_SENSITIVE].sort());
    expect(report.fields.filter((f) => f.sensitive).map((f) => f.id).sort()).toEqual([...ALL_SENSITIVE].sort());
    expect(Object.fromEntries(ALL_SENSITIVE.map((id) => [id, fields[id]?.category]))).toEqual({
      'membership-no': 'credential', 'cscs-no': 'credential', 'radio:workRight': 'right-to-work',
      'r1-name': 'referee', 'r1-company': 'referee', 'r1-mail': 'referee',
      'radio:clearance': 'security-clearance', 'radio:sponsor': 'right-to-work', 'radio:interest': 'conflict-of-interest',
      'interest-detail': 'conflict-of-interest', 'radio:record': 'convictions', truth: 'declaration',
    });
    expect(fields['membership-no']?.key).toBe('professionalMembershipNumber');
    expect(fields['cscs-no']?.key).toBe('cscsCardNumber');
    expect(fields.spoken).toMatchObject({ key: 'languages', sensitive: false });
    expect(fields['radio:workRight']?.key).toBe('rightToWork');
    // No stored answer exists for clearance, sponsorship, conflict of interest, convictions or the declaration.
    // OD-5: the plain sponsorship question is recognised (key visaSponsorship), but with no right-to-work
    // record it has no proposed answer and waits for the person, like the others.
    for (const id of ANSWER_YOURSELF) expect(fields[id], id).toMatchObject({ key: id === 'radio:sponsor' ? 'visaSponsorship' : null, proposed: null, state: 'answer-yourself' });
    expect(await formSnapshot(page)).toEqual(EMPTY);
    expect((await fixtureLog(page)).inputEvents).toEqual({});
  });

  test('hybrid: fills ordinary fields correctly and leaves every sensitive field untouched before confirmation', async ({ page }) => {
    await openFixture(page, CONSTRUCTION);
    const report = await run(page, 'hybrid');
    expect(await formSnapshot(page)).toEqual({ ...EMPTY, ...ORDINARY });
    expect(report.decision).toBe('await-confirmation');
    expect(report.submitted).toBe(false);

    const log = await fixtureLog(page);
    for (const id of Object.keys(ORDINARY)) {
      expect(log.inputEvents[id], `input event on ${id}`).toBe(1);
      expect(log.changeEvents[id], `change event on ${id}`).toBe(1);
    }
    for (const id of ['membership-no', 'cscs-no', 'r1-mail', 'interest-detail']) expect(log.inputEvents[id], id).toBeUndefined();
    for (const id of ['clearance-yes', 'work-right-yes', 'sponsor-no', 'interest-no', 'record-no', 'truth']) expect(log.changeEvents[id], id).toBeUndefined();
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    await expect(page.locator('#result')).toBeHidden();

    const fields = byId(report);
    for (const id of Object.keys(ORDINARY)) expect(fields[id]?.state, id).toBe('filled');
    for (const id of WITH_DATA) expect(fields[id]?.state, id).toBe('awaiting-confirmation');
    for (const id of ANSWER_YOURSELF) expect(fields[id]?.state, id).toBe('answer-yourself');
    expect(fields.notice?.state).toBe('no-data');

    for (const selector of ['#membership-no', '#cscs-no', '#clearance-group', '#work-right-group', '#sponsor-group', '#interest-group', '#record-group', '#truth']) {
      await expect(page.locator(selector), selector).toHaveAttribute('data-opennjob-sensitive', /.+/);
      await expect(page.locator(selector), selector).toHaveCSS('outline-style', 'solid');
    }
    await expect(page.locator('#clearance-group')).toHaveAttribute('data-opennjob-state', 'answer-yourself');
    await expect(page.locator('#spoken')).not.toHaveAttribute('data-opennjob-sensitive', /.*/);
  });

  test('hybrid: credential numbers and right to work are filled only after the user confirms each one; clearance and sponsorship never', async ({ page }) => {
    await openFixture(page, CONSTRUCTION);
    await run(page, 'hybrid');

    let report = await run(page, 'hybrid', ['cscs-no']);
    expect(await formSnapshot(page)).toEqual({ ...EMPTY, ...ORDINARY, 'cscs-no': '00000000' });
    expect(report.decision).toBe('await-confirmation');

    report = await run(page, 'hybrid', WITH_DATA);
    const filled = {
      ...EMPTY, ...ORDINARY, 'membership-no': 'MCIOB 0000000', 'cscs-no': '00000000', 'work-right-yes': true,
      'r1-name': 'Tomasz Fixture', 'r1-company': 'Corbel & Wray Developments (example)', 'r1-mail': 'tomasz.fixture@example.org',
    };
    expect(await formSnapshot(page)).toEqual(filled);
    expect(report.decision).toBe('await-confirmation');

    // Every sensitive field acknowledged: OpennJob still answers none of the questions it holds no data for, and does not submit.
    report = await run(page, 'hybrid', ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    expect(await formSnapshot(page)).toEqual(filled);
    expect(await formSnapshot(page)).toMatchObject(UNANSWERED);
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    expect(log.inputEvents['cscs-no']).toBe(1);
    await expect(page.locator('#result')).toBeHidden();
  });

  test('review: nothing is filled until confirmed, and submit is never pressed', async ({ page }) => {
    await openFixture(page, CONSTRUCTION);
    let report = await run(page, 'review');
    expect(await formSnapshot(page)).toEqual(EMPTY);
    expect(report.decision).toBe('await-confirmation');

    report = await run(page, 'review', ['given', 'membership-no']);
    expect(await formSnapshot(page)).toEqual({ ...EMPTY, given: 'Mireille', 'membership-no': 'MCIOB 0000000' });

    report = await run(page, 'review', report.fields.map((f) => f.id));
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    expect(await formSnapshot(page)).toMatchObject({ ...ORDINARY, 'cscs-no': '00000000', 'work-right-yes': true, ...UNANSWERED });
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
  });

  test('auto: this form has sensitive fields, so it waits for the user and is never submitted, even after confirmation', async ({ page }) => {
    await openFixture(page, CONSTRUCTION);
    let report = await run(page, 'auto');
    expect(report.decision).toBe('await-confirmation');
    expect(report.submitted).toBe(false);
    expect(await formSnapshot(page)).toEqual({ ...EMPTY, ...ORDINARY });

    report = await run(page, 'auto', ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    expect(report.message).toMatch(/did not submit/);

    // The applicant answers the rest by hand; another run still does not submit.
    for (const id of ['#clearance-no', '#sponsor-no', '#interest-no', '#record-no', '#truth']) await page.check(id);
    report = await run(page, 'auto', ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    await expect(page.locator('#result')).toBeHidden();
  });

  for (const mode of MODES) {
    test(`${mode}: never answers security clearance, visa sponsorship, conflict of interest, convictions or the declaration`, async ({ page }) => {
      await openFixture(page, CONSTRUCTION);
      const first = await run(page, mode);
      const report = await run(page, mode, first.fields.map((f) => f.id));
      expect(await formSnapshot(page)).toMatchObject(UNANSWERED);
      expect(report.submitted).toBe(false);
      expect((await fixtureLog(page)).submitClicks).toBe(0);
    });
  }

  test('without a stored right-to-work confirmation the question is left for the applicant', async ({ page }) => {
    await openFixture(page, CONSTRUCTION);
    const values = buildFillValues(PROFILE, { ...PASSPORT, rightToWorkConfirmed: false }, STATEMENT);
    const report = await runAgent(page, 'hybrid', WITH_DATA, { values });
    expect(await formSnapshot(page)).toMatchObject({ 'work-right-yes': false, 'work-right-no': false });
    expect(byId(report)['radio:workRight']?.state).toBe('answer-yourself');
  });
});

test.describe('French application form', () => {
  const EMPTY = {
    prenom: '', nom: '', courriel: '', telephone: '', adresse: '', 'code-postal': '', disponibilite: '', motivation: '',
    'casier-oui': false, 'casier-non': false, 'permis-oui': false, 'permis-non': false, 'droit-oui': false, 'droit-non': false,
    'ref-nom': '', 'ref-organisme': '', 'ref-courriel': '', honneur: false,
  };
  const ORDINARY = {
    prenom: 'Mireille', nom: 'Kabongo-Example', courriel: 'mireille.kabongo@example.org', telephone: '07700 900555', adresse: '4 Sample Yard',
    'code-postal': 'B2 2ZZ', motivation: STATEMENT,
  };
  const WITH_DATA = ['ref-nom', 'ref-organisme', 'ref-courriel'];
  const ANSWER_YOURSELF = ['radio:casier', 'radio:permis', 'radio:droit', 'honneur'];
  const ALL_SENSITIVE = [...WITH_DATA, ...ANSWER_YOURSELF];
  const UNANSWERED = { 'casier-oui': false, 'casier-non': false, 'permis-oui': false, 'permis-non': false, 'droit-oui': false, 'droit-non': false, honneur: false };

  test('recognises the French labels and classifies every field', async ({ page }) => {
    await openFixture(page, FRENCH);
    expect(await formSnapshot(page)).toEqual(EMPTY);
    const report = await run(page, 'hybrid', [], { dryRun: true });
    expect(report.status).toBe('ok');
    const fields = byId(report);
    expect(Object.keys(fields).sort()).toEqual([...Object.keys(ORDINARY), 'disponibilite', ...ALL_SENSITIVE].sort());
    expect(Object.fromEntries(Object.keys(ORDINARY).map((id) => [id, fields[id]?.key]))).toEqual({
      prenom: 'firstName', nom: 'lastName', courriel: 'email', telephone: 'phone', adresse: 'addressLine1', 'code-postal': 'postcode', motivation: 'supportingStatement',
    });
    for (const id of Object.keys(ORDINARY)) expect(fields[id]?.sensitive, id).toBe(false);
    expect(report.fields.filter((f) => f.sensitive).map((f) => f.id).sort()).toEqual([...ALL_SENSITIVE].sort());
    expect(Object.fromEntries(ALL_SENSITIVE.map((id) => [id, fields[id]?.category]))).toEqual({
      'ref-nom': 'referee', 'ref-organisme': 'referee', 'ref-courriel': 'referee',
      'radio:casier': 'convictions', 'radio:permis': 'right-to-work', 'radio:droit': 'right-to-work', honneur: 'declaration',
    });
    expect(fields['ref-courriel']?.key).toBe('referee1.email');
    expect(fields['ref-organisme']?.key).toBe('referee1.organisation');
    // The stored right-to-work confirmation is about the UK. It is not offered on a French form.
    for (const id of ANSWER_YOURSELF) expect(fields[id], id).toMatchObject({ key: null, proposed: null, state: 'answer-yourself' });
    expect(await formSnapshot(page)).toEqual(EMPTY);
    expect((await fixtureLog(page)).inputEvents).toEqual({});
  });

  test('hybrid: fills the basic fields and the lettre de motivation, leaves sensitive fields untouched before confirmation', async ({ page }) => {
    await openFixture(page, FRENCH);
    const report = await run(page, 'hybrid');
    expect(await formSnapshot(page)).toEqual({ ...EMPTY, ...ORDINARY });
    expect(report.decision).toBe('await-confirmation');
    expect(report.submitted).toBe(false);
    const log = await fixtureLog(page);
    for (const id of Object.keys(ORDINARY)) {
      expect(log.inputEvents[id], `input event on ${id}`).toBe(1);
      expect(log.changeEvents[id], `change event on ${id}`).toBe(1);
    }
    for (const id of ['ref-nom', 'ref-organisme', 'ref-courriel']) expect(log.inputEvents[id], id).toBeUndefined();
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    await expect(page.locator('#result')).toBeHidden();
    const fields = byId(report);
    for (const id of WITH_DATA) expect(fields[id]?.state, id).toBe('awaiting-confirmation');
    expect(fields.disponibilite?.state).toBe('no-data');
    for (const selector of ['#casier-groupe', '#permis-groupe', '#droit-groupe', '#ref-courriel', '#honneur']) {
      await expect(page.locator(selector), selector).toHaveAttribute('data-opennjob-sensitive', /.+/);
      await expect(page.locator(selector), selector).toHaveCSS('outline-style', 'solid');
    }
  });

  test('hybrid: referee details are filled only after confirmation; casier judiciaire, permis de travail and the declaration never', async ({ page }) => {
    await openFixture(page, FRENCH);
    await run(page, 'hybrid');
    let report = await run(page, 'hybrid', ['ref-courriel']);
    expect(await formSnapshot(page)).toEqual({ ...EMPTY, ...ORDINARY, 'ref-courriel': 'tomasz.fixture@example.org' });
    expect(report.decision).toBe('await-confirmation');

    report = await run(page, 'hybrid', ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    expect(await formSnapshot(page)).toEqual({
      ...EMPTY, ...ORDINARY, 'ref-nom': 'Tomasz Fixture', 'ref-organisme': 'Corbel & Wray Developments (example)', 'ref-courriel': 'tomasz.fixture@example.org',
    });
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    await expect(page.locator('#result')).toBeHidden();
  });

  test('review: nothing is filled until confirmed, and submit is never pressed', async ({ page }) => {
    await openFixture(page, FRENCH);
    let report = await run(page, 'review');
    expect(await formSnapshot(page)).toEqual(EMPTY);
    expect(report.decision).toBe('await-confirmation');
    report = await run(page, 'review', ['prenom']);
    expect(await formSnapshot(page)).toEqual({ ...EMPTY, prenom: 'Mireille' });
    report = await run(page, 'review', report.fields.map((f) => f.id));
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    expect(await formSnapshot(page)).toMatchObject({ ...ORDINARY, ...UNANSWERED });
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
  });

  test('auto: this form has sensitive fields, so it waits for the user and is never submitted, even after confirmation', async ({ page }) => {
    await openFixture(page, FRENCH);
    let report = await run(page, 'auto');
    expect(report.decision).toBe('await-confirmation');
    expect(report.submitted).toBe(false);
    expect(await formSnapshot(page)).toEqual({ ...EMPTY, ...ORDINARY });

    report = await run(page, 'auto', ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    for (const id of ['#casier-non', '#permis-oui', '#droit-oui', '#honneur']) await page.check(id);
    report = await run(page, 'auto', ALL_SENSITIVE);
    expect(report.decision).toBe('fill-only');
    expect(report.submitted).toBe(false);
    const log = await fixtureLog(page);
    expect(log.submitCount).toBe(0);
    expect(log.submitClicks).toBe(0);
    await expect(page.locator('#result')).toBeHidden();
  });

  for (const mode of MODES) {
    test(`${mode}: never answers casier judiciaire, permis de travail, droit de travailler or the déclaration sur l'honneur`, async ({ page }) => {
      await openFixture(page, FRENCH);
      const first = await run(page, mode);
      const report = await run(page, mode, first.fields.map((f) => f.id));
      expect(await formSnapshot(page)).toMatchObject(UNANSWERED);
      expect(report.submitted).toBe(false);
      expect((await fixtureLog(page)).submitClicks).toBe(0);
    });
  }
});
