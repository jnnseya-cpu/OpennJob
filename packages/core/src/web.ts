/**
 * Browser-safe entry point for the candidate web app (apps/web): pack definitions,
 * countries, regions and languages. Only modules with no Node dependencies and no I/O.
 * The web app reads the declarations a user must confirm from here, so the website and
 * the API agree on them.
 */
export type { PackId, Mode, Preferences, Profile, Passport, Referee, TrainingRecord, DbsDetails, Application, ApplicationStatus, JobLanguage } from './types';
export { MODES } from './types';
export { PACKS, PACK_IDS, getPack, credentialLabel } from './packs';
export type { Pack, PackDeclaration, PackCredentialField } from './packs';
export { REGIONS, REGION_IDS, COUNTRIES, KNOWN_CITIES, countryName, cityCountry } from './geo';
export type { Region, Country } from './geo';
export { LANGUAGES } from './languages';
export { WORK_RIGHTS_BASES, workRightsProblem, describeWorkRights } from './work-rights';
export type { WorkRightsRecord } from './types';
export type { Language } from './languages';
