import { describe, expect, it } from 'vitest';
import { buildFillValues, classifyField, detectSensitiveCategory, normaliseFieldText, workRightsAnswer } from '../src';
import type { FieldDescriptor, Passport, Profile } from '../src';

const classify = (label: string, extra: Partial<FieldDescriptor> = {}) => classifyField({ label, type: 'text', tag: 'input', ...extra });

describe('French labels for the basic fields', () => {
  it.each([
    ['Prénom', 'firstName'],
    ['Prénom(s)', 'firstName'],
    ['Nom', 'lastName'],
    ['Nom de famille', 'lastName'],
    ['Courriel', 'email'],
    ['E-mail', 'email'],
    ['Adresse e-mail', 'email'],
    ['Téléphone', 'phone'],
    ['Numéro de téléphone', 'phone'],
    ['Adresse', 'addressLine1'],
    ['Code postal', 'postcode'],
    ['Ville', 'city'],
    ['Lettre de motivation', 'supportingStatement'],
  ])('%s -> %s, not sensitive', (label, key) => {
    expect(classify(label)).toEqual({ ignore: false, sensitive: false, category: null, key });
  });

  it('works from the name or id when the label is missing, with or without accents', () => {
    expect(classify('', { name: 'prenom' }).key).toBe('firstName');
    expect(classify('', { id: 'code_postal' }).key).toBe('postcode');
    expect(classify('', { name: 'telephone' }).key).toBe('phone');
    expect(classify('', { name: 'lettreDeMotivation', tag: 'textarea' }).key).toBe('supportingStatement');
  });

  it('does not mistake "nom" inside other labels for the surname', () => {
    expect(classify("Nom de l'entreprise actuelle").key).toBeNull();
    expect(classify('Nom complet').key).toBe('fullName');
    // Not the surname. Since SCR-1 it is the ordinary "years of experience" screening question.
    expect(classify('Nombre d\'années d\'expérience').key).toBe('yearsExperience');
  });
});

describe('fields treated as sensitive: clearance, sponsorship, conflict of interest', () => {
  it.each([
    ['Do you hold current security clearance?', 'security-clearance'],
    ['Security clearance level (SC, DV)', 'security-clearance'],
    ['Have you been through national security vetting?', 'security-clearance'],
    ['Are you SC cleared?', 'security-clearance'],
    ['BPSS check completed', 'security-clearance'],
    ['Will you need visa sponsorship for this role?', 'right-to-work'],
    ['Do you require sponsorship?', 'right-to-work'],
    ['Do you hold a valid work permit?', 'right-to-work'],
    ['Work authorisation status', 'right-to-work'],
    ['Are you authorized to work in the United States?', 'right-to-work'],
    ['US work authorization', 'right-to-work'],
    ['Do you have any conflict of interest to declare?', 'conflict-of-interest'],
    ['Conflicts of interest', 'conflict-of-interest'],
  ])('%s -> %s', (label, category) => {
    for (const type of ['text', 'radio', 'checkbox']) {
      expect(classify(label, { type })).toMatchObject({ sensitive: true, category });
    }
  });

  it('holds no answer for any of them: they are never auto-filled', () => {
    for (const label of [
      'Do you hold current security clearance?',
      'Security clearance reference number',
      'Do you hold a valid work permit?',
      'Work authorisation status',
      'Do you have any conflict of interest to declare?',
    ]) {
      expect(classify(label).key, label).toBeNull();
      expect(classify(label, { type: 'radio' }).key, label).toBeNull();
    }
  });

  it('OD-5: the plain sponsorship question is recognised, stays sensitive, and is answered only from a valid record', () => {
    const c = classify('Will you need visa sponsorship for this role?', { type: 'radio' });
    expect(c).toMatchObject({ sensitive: true, category: 'right-to-work', key: 'visaSponsorship' });
    // No record: the old UK confirmation never answers sponsorship.
    expect(workRightsAnswer(c, { rightToWork: true }, { country: 'GB', fromRecord: false }).value).toBeUndefined();
    // Worded the other way round: left for the person.
    expect(classify('Are you able to work without sponsorship?', { type: 'radio' }).key).toBeNull();
  });

  it('detects them from the name, id or section heading when the label does not say', () => {
    expect(classify('Yes', { name: 'securityClearance', type: 'radio' }).category).toBe('security-clearance');
    expect(classify('Details', { groupLabel: 'Conflict of interest' }).category).toBe('conflict-of-interest');
    expect(classify('Please give details', { id: 'visa_sponsorship_details' }).category).toBe('right-to-work');
  });
});

describe('French equivalents of the sensitive labels', () => {
  it.each([
    ['Avez-vous un casier judiciaire ?', 'convictions'],
    ['Extrait de casier judiciaire', 'convictions'],
    ['Disposez-vous d\'un permis de travail ?', 'right-to-work'],
    ['Avez-vous le droit de travailler en France ?', 'right-to-work'],
    ['Références', 'referee'],
    ['Références professionnelles', 'referee'],
    ['Déclaration sur l\'honneur', 'declaration'],
    ['Je certifie sur l\'honneur l\'exactitude de ces informations', 'declaration'],
    ['Habilitation de sécurité', 'security-clearance'],
    ['Conflit d\'intérêts', 'conflict-of-interest'],
  ])('%s -> %s', (label, category) => {
    expect(classify(label)).toMatchObject({ sensitive: true, category });
    expect(detectSensitiveCategory(normaliseFieldText(label))).toBe(category);
  });

  it('never answers them: the stored UK right-to-work confirmation is not offered on a French question', () => {
    for (const label of ['Avez-vous un casier judiciaire ?', 'Disposez-vous d\'un permis de travail ?', 'Avez-vous le droit de travailler en France ?', 'Déclaration sur l\'honneur']) {
      expect(classify(label, { type: 'radio' }).key, label).toBeNull();
      expect(classify(label, { type: 'checkbox' }).key, label).toBeNull();
    }
  });

  it('maps French referee fields to the stored referee, never to the applicant', () => {
    const inRefs = (label: string) => classify(label, { groupLabel: 'Références' });
    expect(inRefs('Nom complet')).toMatchObject({ sensitive: true, category: 'referee', key: 'referee1.name' });
    expect(inRefs('Courriel').key).toBe('referee1.email');
    expect(inRefs('Téléphone').key).toBe('referee1.phone');
    expect(inRefs('Organisme').key).toBe('referee1.organisation');
  });

  it('does not treat the vacancy reference as a referee', () => {
    expect(classify("Référence de l'offre")).toMatchObject({ sensitive: false, category: null });
  });
});

describe('the right-to-work answer is only offered for the UK question', () => {
  it('offers the stored confirmation for "right to work" and "right to work in the UK"', () => {
    expect(classify('Do you have the right to work in the UK?', { type: 'radio' }).key).toBe('rightToWork');
    expect(classify('Right to work', { type: 'checkbox' }).key).toBe('rightToWork');
  });
  it('does not offer it when the question names another country', () => {
    for (const [label, country] of [
      ['Do you have the right to work in Ireland?', 'IE'],
      ['Do you have the right to work in Germany?', 'DE'],
      ['Right to work in Canada', 'CA'],
    ] as const) {
      const c = classify(label, { type: 'radio' });
      // OD-5: the question is recognised with the country it names...
      expect(c).toMatchObject({ sensitive: true, category: 'right-to-work', key: 'rightToWork', country });
      // ...and no answer is offered for a UK job, from a record or from the old UK confirmation.
      expect(workRightsAnswer(c, { rightToWork: true, visaSponsorship: false }, { country: 'GB', fromRecord: true }).value).toBeUndefined();
      expect(workRightsAnswer(c, { rightToWork: true }, { country: 'GB', fromRecord: false }).value).toBeUndefined();
      expect(workRightsAnswer(c, { rightToWork: true }, undefined).value).toBeUndefined();
    }
  });
});

describe('new credential fields', () => {
  it('recognises the professional membership number and the CSCS card number as sensitive credential fields', () => {
    expect(classify('Professional membership number')).toEqual({ ignore: false, sensitive: true, category: 'credential', key: 'professionalMembershipNumber' });
    expect(classify('MCIOB membership number').key).toBe('professionalMembershipNumber');
    expect(classify('RICS number').key).toBe('professionalMembershipNumber');
    expect(classify('CSCS card number')).toEqual({ ignore: false, sensitive: true, category: 'credential', key: 'cscsCardNumber' });
    expect(classify('', { name: 'cscsNo' })).toMatchObject({ sensitive: true, key: 'cscsCardNumber' });
  });

  it('does not put the number into a neighbouring field', () => {
    expect(classify('CSCS card expiry date')).toMatchObject({ sensitive: true, category: 'credential', key: null });
    expect(classify('Professional membership grade')).toMatchObject({ sensitive: true, key: null });
    expect(classify('Do you hold a CSCS card?', { type: 'radio' })).toMatchObject({ sensitive: true, key: null });
    expect(classify('I hold a valid CSCS card', { type: 'checkbox' })).toMatchObject({ sensitive: true, key: null });
  });

  it('recognises a languages field as an ordinary field', () => {
    for (const label of ['Languages spoken', 'Languages', 'Languages you speak', 'Langues parlées', 'Langues']) {
      expect(classify(label), label).toEqual({ ignore: false, sensitive: false, category: null, key: 'languages' });
    }
    expect(classify('Programming languages used').key).toBeNull();
  });

  it('still recognises the NMC PIN exactly as before', () => {
    expect(classify('NMC PIN')).toEqual({ ignore: false, sensitive: true, category: 'registration', key: 'nmcPin' });
  });
});

describe('buildFillValues with the credential map', () => {
  /** Fictional. */
  const profile: Profile = {
    firstName: 'Mireille', lastName: 'Kabongo-Example', email: 'mireille.kabongo@example.org', phone: '07700 900555',
    addressLine1: '4 Sample Yard', city: 'Birmingham', postcode: 'B2 2ZZ', cvText: 'Fictional construction manager.',
  };
  const passport = (p: Partial<Passport> = {}): Passport => ({ rightToWorkConfirmed: false, training: [], referees: [], ...p });

  it('maps prof, cscs and lang to their fields', () => {
    const v = buildFillValues(profile, passport({ credentials: { prof: ' MCIOB 0000000 ', cscs: '00000000', lang: 'English, French' } }));
    expect(v).toMatchObject({ professionalMembershipNumber: 'MCIOB 0000000', cscsCardNumber: '00000000', languages: 'English, French' });
  });

  it('never turns security clearance or "countries you can work in" into a fill value', () => {
    const v = buildFillValues(profile, passport({ credentials: { sc: 'SC (fictional)', rtw: 'United Kingdom, Ireland', cdm: 'Principal contractor', pm: 'PRINCE2', smsts: '2027-01-01', pts: 'yes' } }));
    expect(Object.values(v)).not.toContain('SC (fictional)');
    expect(Object.values(v)).not.toContain('United Kingdom, Ireland');
    expect(v.rightToWork).toBeUndefined();
    expect(Object.keys(v).sort()).toEqual(['addressLine1', 'city', 'email', 'firstName', 'fullName', 'lastName', 'phone', 'postcode']);
  });

  it('reads the NMC PIN from the map or from the v1 field', () => {
    expect(buildFillValues(profile, passport({ credentials: { pin: '20B5678C' } })).nmcPin).toBe('20B5678C');
    expect(buildFillValues(profile, passport({ nmcPin: '18A1234E' })).nmcPin).toBe('18A1234E');
    expect(buildFillValues(profile, passport({ nmcPin: '18A1234E', credentials: { pin: '20B5678C' } })).nmcPin).toBe('20B5678C');
    expect(buildFillValues(profile, passport()).nmcPin).toBeUndefined();
  });

  it('fills languages from the selected languages when the passport has no languages line, and with nothing when neither exists', () => {
    const withPrefs = { ...profile, preferences: { languages: ['English', 'French'], countries: [], cities: [] } };
    expect(buildFillValues(withPrefs, passport()).languages).toBe('English, French');
    expect(buildFillValues(withPrefs).languages).toBe('English, French');
    expect(buildFillValues(withPrefs, passport({ credentials: { lang: 'English, French, Lingala' } })).languages).toBe('English, French, Lingala');
    // An empty selection is not a claim to speak anything.
    expect(buildFillValues({ ...profile, preferences: { languages: [], countries: [], cities: [] } }, passport()).languages).toBeUndefined();
    expect(buildFillValues(profile, passport()).languages).toBeUndefined();
  });
});
