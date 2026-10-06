import type { Job, PackId } from './types';
import { detectLanguage } from './languages';
import { escapeRegExp } from './text';

/**
 * Industry packs. Ids, names, credential fields, declarations and questions follow the
 * product demo so the codebase and the demo agree. v1 was healthcare only; the healthcare
 * pack keeps that behaviour.
 */
export interface PackCredentialField {
  id: string;
  label: string;
}

export interface PackDeclaration {
  id: string;
  label: string;
  /** The passport credential this declaration depends on (e.g. "pin", "sc"), when there is one. */
  requiresCredential?: string;
}

export interface Pack {
  id: PackId;
  name: string;
  /** Lines of the credential passport for this pack. Passport.credentials is keyed by these ids. */
  credentialFields: PackCredentialField[];
  /** What an application form in this pack usually asks the applicant to declare. The user answers these; OpennJob never does. */
  declarations: PackDeclaration[];
  /** Interview practice questions. */
  questions: string[];
}

const INFRA_CREDENTIALS: PackCredentialField[] = [
  { id: 'prof', label: 'Professional membership' },
  { id: 'sc', label: 'Security clearance' },
  { id: 'cdm', label: 'CDM 2015' },
  { id: 'pm', label: 'Project management' },
  { id: 'cscs', label: 'CSCS card and expiry' },
  { id: 'smsts', label: 'SMSTS and expiry' },
  { id: 'pts', label: 'Personal Track Safety (rail)' },
  { id: 'lang', label: 'Languages' },
  { id: 'rtw', label: 'Countries you can work in' },
];

const INFRA_DECLARATIONS: PackDeclaration[] = [
  { id: 'rtw', label: 'Right to work or visa sponsorship for this country' },
  { id: 'sc', label: 'Security clearance and vetting declaration', requiresCredential: 'sc' },
  { id: 'conv', label: 'Criminal convictions declaration' },
  { id: 'coi', label: 'Conflict of interest declaration' },
  { id: 'ref', label: "Referees' names and contact details" },
];

const infra = (id: PackId, name: string, questions: string[]): Pack => ({
  id,
  name,
  credentialFields: INFRA_CREDENTIALS.map((f) => ({ ...f })),
  declarations: INFRA_DECLARATIONS.map((d) => ({ ...d })),
  questions,
});

export const PACKS: readonly Pack[] = [
  infra('con', 'Construction and infrastructure', [
    'Tell me about a programme you recovered. What was wrong and what did you change first?',
    'How do you hold a Tier 1 contractor to account when you are client-side?',
    'Describe a serious HSE incident or near miss on your site and what you did afterwards.',
  ]),
  infra('dc', 'Data centres and mission-critical', [
    'How do you protect the commissioning window when construction is running late?',
    'Tell me about an interface clash between MEP and HV packages and how you resolved it.',
    'What does handover readiness mean to you on a live, high-availability site?',
  ]),
  infra('en', 'Energy and grid', [
    'Describe how you governed subcontractors across several countries on one programme.',
    'Tell me about a grid connection date at risk. What did you do?',
    'How do you manage outage windows with the network operator?',
  ]),
  infra('rail', 'Rail and transport', [
    'How did you keep a rail upgrade on schedule and cost? Use a real example.',
    'Tell me about introducing BIM to a team that resisted it.',
    'How do you plan work around possessions and a live railway?',
  ]),
  infra('fr', 'Francophone Africa and diaspora', [
    "Parlez-nous d'un programme d'infrastructure que vous avez redressé.",
    'How would you adapt UK delivery standards to a site in the DRC or Senegal?',
    'Comment gérez-vous plusieurs sous-traitants sur un chantier éloigné ?',
  ]),
  {
    id: 'hc',
    name: 'Healthcare',
    credentialFields: [
      { id: 'pin', label: 'Professional registration number (NMC PIN)' },
      { id: 'dbs', label: 'DBS' },
      { id: 'rtw', label: 'Countries you can work in' },
    ],
    declarations: [
      { id: 'pin', label: 'Professional registration number', requiresCredential: 'pin' },
      { id: 'rtw', label: 'Right to work or visa status for this country' },
      { id: 'dbs', label: 'DBS or police check details' },
      { id: 'conv', label: 'Criminal convictions and cautions declaration' },
      { id: 'ftp', label: 'Fitness to practise declaration', requiresCredential: 'pin' },
    ],
    questions: [
      'Tell me about a time you recognised that a patient was deteriorating. What did you do?',
      'Describe a medication error or near miss you were involved in and what you learned.',
      'Describe a time you raised a safeguarding concern. What happened next?',
    ],
  },
];

export const PACK_IDS: readonly PackId[] = PACKS.map((p) => p.id);

export function getPack(id: string | undefined): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

/** Every credential id any pack knows. Passport.credentials may only use these keys. */
export const CREDENTIAL_IDS: readonly string[] = [...new Set(PACKS.flatMap((p) => p.credentialFields.map((f) => f.id)))];

export function credentialLabel(id: string): string {
  for (const pack of PACKS) {
    const field = pack.credentialFields.find((f) => f.id === id);
    if (field) return field.label;
  }
  return id;
}

/** Countries where the francophone pack applies. From memory; a product grouping, not an authority. */
export const FRANCOPHONE_AFRICA: readonly string[] = [
  'BF', 'BI', 'BJ', 'CD', 'CF', 'CG', 'CI', 'CM', 'DJ', 'DZ', 'GA', 'GN', 'KM', 'MA', 'MG', 'ML', 'MR', 'NE', 'RW', 'SN', 'TD', 'TG', 'TN',
];

/** Whole words only (an optional plural "s" is allowed), so "metro" does not match "metropolitan" and "nurse" does not match "nursery". */
const any = (text: string, keywords: readonly string[]): boolean =>
  keywords.some((k) => new RegExp(`(?<![\\p{L}\\p{N}])${k.trim().split(/\s+/).map(escapeRegExp).join('\\s+')}s?(?![\\p{L}\\p{N}])`, 'iu').test(text));

const HEALTHCARE = [
  'nurse', 'nursing', 'midwife', 'midwifery', 'healthcare assistant', 'health care assistant', 'care assistant', 'support worker', 'carer',
  'NMC', 'NMBI', 'HCA', 'health and social care', 'care home', 'clinical', 'infirmier', 'infirmière', 'aide-soignant',
];
const DATA_CENTRE = ['data centre', 'data center', 'datacentre', 'datacenter', 'hyperscale', 'colocation', 'mission-critical', 'mission critical', 'centre de données'];
const RAIL = ['rail', 'railway', 'metro', 'tram', 'tramway', 'rolling stock', 'signalling', 'ferroviaire', 'ligne à grande vitesse', 'personal track safety'];
const ENERGY = [
  'energy', 'grid', 'substation', 'HVDC', 'offshore wind', 'onshore wind', 'wind farm', 'solar', 'battery storage', 'BESS', 'nuclear',
  'power station', 'transmission', 'énergie', 'énergétique', 'hydroélectrique',
];
const CONSTRUCTION = [
  'construction', 'site manager', 'quantity surveyor', 'civil engineering', 'CDM', 'NEC4', 'NEC3', 'SMSTS', 'CSCS', 'MCIOB', 'MRICS',
  'regeneration', 'redevelopment', 'new build', 'estates', 'building site', 'chantier', 'génie civil', 'BIM', 'airport terminal', 'stadium',
];
const DIASPORA = ['diaspora', 'francophone africa', 'afrique francophone'];

/**
 * Sorts a job into an industry pack from the words in its title and description.
 * Order matters: healthcare roles first; then the francophone pack (a job in a
 * French-speaking African country, or one about the diaspora); then data centres, rail,
 * energy and finally general construction. Returns undefined when nothing matches, so an
 * unrelated job (say, an accountant) is not forced into a pack. A heuristic: it can be wrong.
 */
export function classifyPack(job: Pick<Job, 'title' | 'description'> & Partial<Pick<Job, 'country' | 'language'>>): PackId | undefined {
  const text = `${job.title}\n${job.description}`;
  if (any(text, HEALTHCARE)) return 'hc';
  const country = job.country?.toUpperCase();
  const sector = any(text, DATA_CENTRE) ? 'dc' : any(text, RAIL) ? 'rail' : any(text, ENERGY) ? 'en' : any(text, CONSTRUCTION) ? 'con' : undefined;
  if (any(text, DIASPORA)) return 'fr';
  if (country && FRANCOPHONE_AFRICA.includes(country) && (sector !== undefined || (job.language ?? detectLanguage(text)) === 'fr')) return 'fr';
  return sector;
}
