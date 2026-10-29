import { describe, expect, it } from 'vitest';
import { buildFillValues, classifyField, countryNamedIn, workRightsAnswer, workRightsContext, workRightsFor, workRightsProblem } from '../src';
import type { Passport, Profile, WorkRightsRecord } from '../src';

/** OD-5: right to work and sponsorship from the person's own record. Fictional people only. */
const PROFILE: Profile = { firstName: 'Alex', lastName: 'Example', email: 'alex.example@example.org', phone: '07700 900111', addressLine1: '1 Example Street', city: 'Leeds', postcode: 'LS1 1AA', cvText: 'Fictional CV.' };
const GB: WorkRightsRecord = { country: 'GB', rightToWork: true, requiresSponsorship: false, basis: 'British or Irish passport', confirmedAt: '2026-10-06T09:00:00.000Z' };
const passport = (workRights: WorkRightsRecord[], extra: Partial<Passport> = {}): Passport => ({ rightToWorkConfirmed: false, training: [], referees: [], workRights, ...extra });
const TODAY = '2026-10-06';
const radio = (label: string) => classifyField({ label, type: 'radio', tag: 'input' });

describe('the record', () => {
  it('is used only while confirmed, answered both ways, resting on a named document and not expired', () => {
    expect(workRightsProblem(GB, TODAY)).toBeUndefined();
    expect(workRightsProblem({ ...GB, confirmedAt: '' }, TODAY)).toBe('not confirmed by you');
    expect(workRightsProblem({ ...GB, basis: ' ' }, TODAY)).toBe('no document named');
    expect(workRightsProblem({ ...GB, documentExpires: '2026-10-05' }, TODAY)).toBe('the document expired on 2026-10-05');
    expect(workRightsProblem({ ...GB, documentExpires: '2026-10-06' }, TODAY)).toBeUndefined();
  });

  it('is found for its own country only', () => {
    expect(workRightsFor(passport([GB]), 'gb', TODAY)).toEqual(GB);
    expect(workRightsFor(passport([GB]), 'IE', TODAY)).toBeUndefined();
    expect(workRightsFor(passport([GB]), undefined, TODAY)).toBeUndefined();
    expect(workRightsFor(passport([{ ...GB, documentExpires: '2020-01-01' }]), 'GB', TODAY)).toBeUndefined();
  });
});

describe('the questions it answers', () => {
  it('recognises the two plain questions and the country they name', () => {
    expect(radio('Do you have the right to work in the UK?')).toMatchObject({ key: 'rightToWork', country: 'GB' });
    expect(radio('Are you eligible to work in this country?')).toMatchObject({ key: 'rightToWork' });
    expect(radio('Are you eligible to work in this country?').country).toBeUndefined();
    expect(radio('Will you now or in the future require visa sponsorship?')).toMatchObject({ key: 'visaSponsorship' });
    expect(countryNamedIn('Tell us if you have the right to work')).toBeUndefined(); // "us" is not a country
    expect(countryNamedIn('Right to work in the EU')).toBe('EU');
  });

  it('leaves anything worded the other way round, asking for detail, or in French to the person', () => {
    for (const label of [
      'Can you work in the UK without sponsorship?',
      'I do not require sponsorship',
      'What is your immigration status?',
      'Share code',
      'Visa expiry date',
      'Nationality',
      'Please upload evidence of your right to work',
      'I confirm the information I have given is true and I have the right to work',
      'Avez-vous le droit de travailler en France ?',
    ]) {
      const c = radio(label);
      expect(c.sensitive, label).toBe(true);
      expect(c.key, label).toBeNull();
    }
  });
});

describe('the answers', () => {
  it('a valid record answers both questions, yes or no, for a job in its country', () => {
    const p = passport([{ ...GB, requiresSponsorship: true }]);
    const values = buildFillValues(PROFILE, p, undefined, { jobCountry: 'GB', today: TODAY });
    expect(values).toMatchObject({ rightToWork: true, visaSponsorship: true });
    const context = workRightsContext(p, 'GB', TODAY);
    expect(context).toEqual({ country: 'GB', fromRecord: true });
    expect(workRightsAnswer(radio('Do you have the right to work in the UK?'), values, context)).toEqual({ value: true, fromRecord: true });
    expect(workRightsAnswer(radio('Will you need visa sponsorship?'), values, context)).toEqual({ value: true, fromRecord: true });
  });

  it('no record for the job country: nothing from the record, and sponsorship is never answered', () => {
    const p = passport([GB], { rightToWorkConfirmed: true });
    const values = buildFillValues(PROFILE, p, undefined, { jobCountry: 'FR', today: TODAY });
    const context = workRightsContext(p, 'FR', TODAY);
    expect(context).toEqual({ country: 'FR', fromRecord: false });
    expect(values.visaSponsorship).toBeUndefined();
    // The old UK confirmation is not offered for a job in France.
    expect(workRightsAnswer(radio('Do you have the right to work?'), values, context).value).toBeUndefined();
  });

  it('the old UK confirmation still needs confirming on the form (fromRecord false)', () => {
    const p = passport([], { rightToWorkConfirmed: true });
    const values = buildFillValues(PROFILE, p, undefined, { jobCountry: 'GB', today: TODAY });
    expect(workRightsAnswer(radio('Do you have the right to work in the UK?'), values, workRightsContext(p, 'GB', TODAY))).toEqual({ value: true, fromRecord: false });
  });

  it('an expired record answers nothing', () => {
    const p = passport([{ ...GB, documentExpires: '2026-01-01' }]);
    expect(buildFillValues(PROFILE, p, undefined, { jobCountry: 'GB', today: TODAY }).visaSponsorship).toBeUndefined();
    expect(workRightsContext(p, 'GB', TODAY)?.fromRecord).toBe(false);
  });

  it('other declarations never get a value, whatever the record says', () => {
    const values = buildFillValues(PROFILE, passport([GB]), undefined, { jobCountry: 'GB', today: TODAY });
    for (const label of ['Do you have any unspent criminal convictions?', 'Do you have a conflict of interest?', 'I confirm the information is true']) {
      const c = radio(label);
      expect(c.key, label).toBeNull();
      expect(workRightsAnswer(c, values, workRightsContext(passport([GB]), 'GB', TODAY)).value, label).toBeUndefined();
    }
  });
});
