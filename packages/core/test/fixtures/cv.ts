import type { Passport, Profile } from '../../src';

/** Entirely fictional person. */
export const CV_TEXT = [
  'Amara Okafor - Registered Nurse (Adult)',
  'Profile',
  'Registered nurse with five years of experience on acute medical wards. I hold a BSc (Hons) Nursing from a UK university.',
  'Experience',
  'Staff Nurse, Northfield General Hospital (example), 2021 to present.',
  '- Completed medication rounds for 28 patients and acted as second checker for controlled drugs.',
  '- Escalated deteriorating patients using NEWS2 observations and SBAR handover.',
  '- Wrote and reviewed care plans with patients and families.',
  '- Raised two safeguarding concerns through the trust procedure.',
  'Healthcare Assistant, Elm Court Care Home (example), 2018 to 2021.',
  '- Provided personal care to residents living with dementia.',
  'Training',
  'Basic life support, moving and handling, infection control.',
].join('\n');

export const PROFILE: Profile = {
  firstName: 'Amara',
  lastName: 'Okafor',
  email: 'amara.okafor@example.org',
  phone: '07700 900123',
  addressLine1: '12 Example Street',
  city: 'Birmingham',
  postcode: 'B1 1AA',
  cvText: CV_TEXT,
};

export const PASSPORT: Passport = {
  nmcPin: '18A1234E',
  dbs: { certificateNumber: '001234567890', issueDate: '2025-03-01', onUpdateService: true },
  rightToWorkConfirmed: true,
  training: [
    { name: 'Basic life support', completedOn: '2025-11-01', expiresOn: '2026-11-01' },
    { name: 'Moving and handling', completedOn: '2025-01-10', expiresOn: '2026-01-10' },
  ],
  referees: [
    { name: 'Priya Shah', relationship: 'Ward Manager', organisation: 'Northfield General Hospital (example)', email: 'priya.shah@example.org', phone: '07700 900456' },
    { name: 'Tom Reid', relationship: 'Home Manager', organisation: 'Elm Court Care Home (example)', email: 'tom.reid@example.org', phone: '07700 900789' },
  ],
};
