import { describe, expect, it } from 'vitest';
import { buildFillValues, classifyField, detectSensitiveCategory, normaliseFieldText } from '../src';
import type { FieldDescriptor } from '../src';
import { PASSPORT, PROFILE } from './fixtures/cv';

const c = (d: FieldDescriptor) => classifyField(d);

describe('normaliseFieldText', () => {
  it('splits camelCase, snake_case and digits', () => {
    expect(normaliseFieldText('nmcPin')).toBe('nmc pin');
    expect(normaliseFieldText('first_name', 'addr-line1')).toBe('first name | addr line 1');
    expect(normaliseFieldText(undefined, '', 'Referee[0].email')).toBe('referee 0 email');
  });
});

describe('sensitive field detection', () => {
  const cases: Array<[string, string]> = [
    ['NMC PIN', 'registration'],
    ['Professional registration number', 'registration'],
    ['Are you registered with a regulatory body?', 'registration'],
    ['HCPC number', 'registration'],
    ['DBS certificate number', 'dbs'],
    ['Are you subscribed to the DBS Update Service?', 'dbs'],
    ['Disclosure and Barring Service check', 'dbs'],
    ['Do you have any unspent criminal convictions?', 'convictions'],
    ['Have you ever received a caution, reprimand or final warning?', 'convictions'],
    ['Are you currently the subject of a police investigation?', 'convictions'],
    ['Do you have the right to work in the UK?', 'right-to-work'],
    ['Visa type', 'right-to-work'],
    ['Immigration status', 'right-to-work'],
    ['Do you require sponsorship?', 'right-to-work'],
    ['National Insurance number', 'right-to-work'],
    ['Nationality', 'right-to-work'],
    ['Has your fitness to practise ever been investigated?', 'fitness-to-practise'],
    ['Have you been subject to fitness to practice proceedings?', 'fitness-to-practise'],
    ['Have you ever been dismissed from a post?', 'fitness-to-practise'],
    ['Have you ever been the subject of a safeguarding investigation?', 'safeguarding'],
    ['Are you on the adults or children barred list?', 'safeguarding'],
    ['Health declaration', 'health'],
    ['Do you consider yourself to have a disability?', 'health'],
    ['Do you need any reasonable adjustments?', 'health'],
    ['Occupational health questionnaire', 'health'],
    ['Ethnic origin', 'equality'],
    ['Religion or belief', 'equality'],
    ['Sexual orientation', 'equality'],
    ['Gender', 'equality'],
    ['Date of birth', 'equality'],
    ['Marital status', 'equality'],
    ['Equal opportunities monitoring', 'equality'],
    ['Referee 1 email address', 'referee'],
    ['Reference 2 - telephone', 'referee'],
    ['Name of referee', 'referee'],
    ['I declare that the information given is true', 'declaration'],
    ['I confirm I have read the privacy notice', 'declaration'],
  ];
  it.each(cases)('"%s" is sensitive (%s)', (label, category) => {
    const r = c({ label, type: 'text', tag: 'input' });
    expect(r.sensitive).toBe(true);
    expect(r.category).toBe(category);
    expect(r.ignore).toBe(false);
  });

  it('detects sensitivity from name, id, placeholder or group label when the label is unhelpful', () => {
    expect(c({ label: 'Number', name: 'nmc_pin' }).category).toBe('registration');
    expect(c({ label: 'Number', id: 'dbsCertificate' }).category).toBe('dbs');
    expect(c({ label: '', placeholder: 'e.g. Skilled Worker visa' }).category).toBe('right-to-work');
    expect(c({ label: 'Email', type: 'email', groupLabel: 'Referees' })).toMatchObject({ sensitive: true, category: 'referee', key: 'referee1.email' });
    expect(c({ label: 'Yes', type: 'radio', groupLabel: 'Criminal convictions' }).category).toBe('convictions');
    expect(c({ label: 'Prefer not to say', type: 'radio', groupLabel: 'Equality monitoring' }).category).toBe('equality');
  });

  const plain: Array<[FieldDescriptor, string | null]> = [
    [{ label: 'First name' }, 'firstName'],
    [{ label: 'Forename(s)' }, 'firstName'],
    [{ label: 'Surname' }, 'lastName'],
    [{ label: 'Last name', name: 'lname' }, 'lastName'],
    [{ label: 'Full name' }, 'fullName'],
    [{ label: 'Name', name: 'name' }, 'fullName'],
    [{ label: 'Email address', type: 'email' }, 'email'],
    [{ label: 'E-mail' }, 'email'],
    [{ label: 'Mobile number', type: 'tel' }, 'phone'],
    [{ label: 'Telephone' }, 'phone'],
    [{ label: 'Address line 1' }, 'addressLine1'],
    [{ label: 'Address', name: 'address1' }, 'addressLine1'],
    [{ label: 'Address line 2' }, 'addressLine2'],
    [{ label: 'Town or city' }, 'city'],
    [{ label: 'Postcode' }, 'postcode'],
    [{ label: 'Post code', name: 'postal_code' }, 'postcode'],
    [{ label: 'Supporting information', tag: 'textarea' }, 'supportingStatement'],
    [{ label: 'How do you meet the person specification?', tag: 'textarea' }, 'supportingStatement'],
    [{ label: 'Cover letter', tag: 'textarea' }, 'supportingStatement'],
    [{ label: 'Job reference' }, null],
    [{ label: 'Vacancy reference number' }, null],
    [{ label: 'Where did you hear about us?' }, null],
    [{ label: 'Preferred start date' }, null],
    [{ label: 'Employer name' }, null],
  ];
  it.each(plain)('%o is not sensitive and maps to %s', (d, key) => {
    const r = c({ type: 'text', tag: 'input', ...d });
    expect(r.sensitive).toBe(false);
    expect(r.category).toBeNull();
    expect(r.key).toBe(key);
  });

  it('uses autocomplete tokens', () => {
    expect(c({ label: 'x', autocomplete: 'given-name' }).key).toBe('firstName');
    expect(c({ label: 'x', autocomplete: 'section-a family-name' }).key).toBe('lastName');
    expect(c({ label: 'x', autocomplete: 'postal-code' }).key).toBe('postcode');
    expect(c({ label: 'x', autocomplete: 'address-level2' }).key).toBe('city');
  });

  it('never treats a referee email or phone as the applicant\'s own', () => {
    expect(c({ label: 'Referee 1 email', type: 'email' }).key).toBe('referee1.email');
    expect(c({ label: 'Email', name: 'referee2_email', type: 'email' }).key).toBe('referee2.email');
    expect(c({ label: 'Second referee: telephone', type: 'tel' }).key).toBe('referee2.phone');
    expect(c({ label: 'Referee 3 organisation' }).key).toBe('referee3.organisation');
    expect(c({ label: 'Relationship to you', groupLabel: 'Referee 1' }).key).toBe('referee1.relationship');
    expect(c({ label: 'Name', groupLabel: 'Referee 2' }).key).toBe('referee2.name');
  });

  it('maps stored passport data onto its fields', () => {
    expect(c({ label: 'NMC PIN' }).key).toBe('nmcPin');
    expect(c({ label: 'DBS certificate number' }).key).toBe('dbsCertificateNumber');
    expect(c({ label: 'DBS issue date' }).key).toBe('dbsIssueDate');
    expect(c({ label: 'I am registered with the DBS Update Service', type: 'checkbox' }).key).toBe('dbsUpdateService');
    expect(c({ label: 'Do you have the right to work in the UK?', type: 'radio' }).key).toBe('rightToWork');
  });

  it('has no stored answer for declarations the user must make personally', () => {
    for (const label of [
      'Do you have any unspent criminal convictions?',
      'Has your fitness to practise ever been investigated?',
      'Have you ever been the subject of a safeguarding investigation?',
      'Do you consider yourself to have a disability?',
      'Ethnic origin',
      'Visa type',
      'I declare that the information given is true',
    ]) {
      expect(c({ label }).key, label).toBeNull();
    }
  });

  it('ignores passwords and non-fillable controls', () => {
    expect(c({ label: 'Password', type: 'password' })).toMatchObject({ ignore: true, ignoreReason: 'password', key: null });
    expect(c({ label: 'Choose a PIN', type: 'password' })).toMatchObject({ ignore: true, key: null });
    for (const type of ['hidden', 'file', 'submit', 'button', 'reset', 'image']) {
      expect(c({ label: 'First name', type })).toMatchObject({ ignore: true, key: null });
    }
  });

  it('detectSensitiveCategory returns null for ordinary text', () => {
    expect(detectSensitiveCategory('first name')).toBeNull();
    expect(detectSensitiveCategory('job reference')).toBeNull();
    expect(detectSensitiveCategory('page 2 of 3')).toBeNull();
    expect(detectSensitiveCategory('your preferences')).toBeNull();
  });
});

describe('buildFillValues', () => {
  it('maps profile, passport and statement', () => {
    const v = buildFillValues(PROFILE, PASSPORT, 'My statement.');
    expect(v).toMatchObject({
      firstName: 'Amara',
      lastName: 'Okafor',
      fullName: 'Amara Okafor',
      email: 'amara.okafor@example.org',
      postcode: 'B1 1AA',
      supportingStatement: 'My statement.',
      nmcPin: '18A1234E',
      dbsCertificateNumber: '001234567890',
      dbsUpdateService: true,
      rightToWork: true,
      'referee1.name': 'Priya Shah',
      'referee2.email': 'tom.reid@example.org',
    });
    expect(v['referee3.name']).toBeUndefined();
  });
  it('omits what is not stored and never offers "no" for right to work', () => {
    const v = buildFillValues(PROFILE, { rightToWorkConfirmed: false, training: [], referees: [] });
    expect(v.rightToWork).toBeUndefined();
    expect(v.nmcPin).toBeUndefined();
    expect(v.supportingStatement).toBeUndefined();
    expect(buildFillValues(PROFILE).nmcPin).toBeUndefined();
  });
});
