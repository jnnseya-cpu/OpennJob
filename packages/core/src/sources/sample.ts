/*
 * Built-in FICTIONAL sample jobs so the product can be tried with no API keys.
 * Enabled with OPENNJOB_DEMO_JOBS=true. The employers do not exist; example.org is a
 * reserved documentation domain.
 *
 * Two sets:
 *  - SAMPLES: the three v1 healthcare jobs. Their criteria are extracted from the text.
 *  - PACK_DEMO: jobs for every industry pack across several countries, following the
 *    product demo (same ids, titles, criteria and required credentials). Their criteria
 *    are supplied with the job, as an employer or a richer source would supply them.
 * Every one of them is `origin: 'discovered'`: the demo shows the system finding jobs,
 * not employers posting them.
 */
import type { Criterion, JobLanguage, PackId } from '../types';
import { normaliseJob, present } from './common';
import type { JobSourceAdapter, RawJob } from './common';

const SAMPLES: RawJob[] = [
  {
    source: 'sample',
    externalId: 'staff-nurse-medical',
    title: 'Staff Nurse - Acute Medical Ward',
    employer: 'Midshire University Hospitals (example)',
    location: 'Birmingham',
    country: 'GB',
    city: 'Birmingham',
    pack: 'hc',
    language: 'en',
    url: 'https://example.org/jobs/staff-nurse-medical',
    description: [
      'We are looking for a Staff Nurse to join our 28-bed acute medical ward.',
      'Essential',
      '- Current NMC registration (Registered Nurse, Adult).',
      '- Experience of medication administration and medicines management.',
      '- Able to recognise a deteriorating patient using NEWS2 observations.',
      '- Clear record keeping and care planning.',
      '- Understanding of safeguarding adults.',
      'Desirable',
      '- Venepuncture and cannulation.',
      '- Experience mentoring students.',
    ].join('\n'),
    salaryMin: 29970,
    salaryMax: 36483,
    employmentType: 'Permanent',
  },
  {
    source: 'sample',
    externalId: 'hca-elderly-care',
    title: 'Healthcare Assistant - Elderly Care',
    employer: 'Midshire University Hospitals (example)',
    location: 'Birmingham',
    country: 'GB',
    city: 'Birmingham',
    pack: 'hc',
    language: 'en',
    url: 'https://example.org/jobs/hca-elderly-care',
    description: [
      'Healthcare Assistant for our elderly care wards.',
      'Essential',
      '- Care Certificate or NVQ Level 2 in Health and Social Care.',
      '- Experience providing personal care with dignity.',
      '- Moving and handling training.',
      '- Good communication skills and able to work in a team.',
      'Desirable',
      '- Experience of dementia care.',
      '- Taking clinical observations.',
    ].join('\n'),
    employmentType: 'Permanent',
  },
  {
    source: 'sample',
    externalId: 'support-worker-ld',
    title: 'Support Worker - Learning Disabilities',
    employer: 'Brookvale Care Agency (example)',
    location: 'Coventry',
    country: 'GB',
    city: 'Coventry',
    pack: 'hc',
    language: 'en',
    url: 'https://example.org/jobs/support-worker-ld',
    description: [
      'Support Worker for adults with learning disabilities in supported living.',
      'Essential',
      '- Experience supporting people with a learning disability.',
      '- Understanding of safeguarding.',
      '- Able to follow a care plan and keep accurate records.',
      'Desirable',
      '- Full UK driving licence.',
      '- Medication training.',
    ].join('\n'),
    employmentType: 'Full-time',
  },
];

type C = [label: string, essential: 0 | 1, keywords: string[]];
type Demo = [id: string, pack: PackId, title: string, employer: string, city: string, country: string, criteria: C[], extra?: { language?: JobLanguage; requiredCredential?: string; contractType?: 'permanent' | 'contract' }];

/** Fictional. Employer names are invented; any resemblance to a real organisation is unintended. */
const PACK_DEMO: Demo[] = [
  // Construction and infrastructure
  ['c1', 'con', 'Senior Construction Manager - Hospital New Build', 'Halden Build Group', 'Birmingham', 'GB', [
    ['Chartered status (MCIOB or MRICS)', 1, ['mciob', 'mrics']], ['Multi-contractor site leadership', 1, ['multi-contractor']], ['CDM 2015 duties', 1, ['cdm']],
    ['NEC4 contract administration', 1, ['nec4', 'nec3']], ['SMSTS certificate', 0, ['smsts']], ['Primavera P6 scheduling', 0, ['primavera']]]],
  ['c2', 'con', 'Project Director - Mixed-use Regeneration', 'Corbel & Wray Developments', 'Manchester', 'GB', [
    ['Programmes of £100M and above', 1, ['£100m']], ['Client-side delivery authority', 1, ['client-side']], ['Procurement and cost control', 1, ['procurement']],
    ['BIM coordination', 0, ['bim']], ['Residential sector experience', 0, ['residential']]]],
  ['c3', 'con', 'Programme Manager - Government Estates', 'Castlegate Programme Partners', 'London', 'GB', [
    ['Security clearance (SC)', 1, ['sc cleared']], ['Public sector estates experience', 1, ['public sector', 'government estates']], ['PRINCE2 or APM qualification', 1, ['prince2', 'apmp']],
    ['Risk and change management', 0, ['risk & change', 'risk and change']]], { requiredCredential: 'sc' }],
  ['c4', 'con', "Owner's Representative - Stadium Redevelopment", 'Liffey Venue Partners', 'Dublin', 'IE', [
    ['Client-side construction authority', 1, ['client-side']], ['QA/QC and compliance', 1, ['qa/qc']], ['Programme recovery', 1, ['recovery']], ['Primavera P6 scheduling', 0, ['primavera']]]],
  ['c5', 'con', 'Construction Manager - Airport Terminal Expansion', 'Najd Aviation Projects', 'Riyadh', 'SA', [
    ['Airport or aviation projects', 1, ['airport', 'aviation']], ['Multi-contractor site leadership', 1, ['multi-contractor']], ['HSE leadership', 1, ['hse']],
    ['FIDIC contracts', 0, ['fidic']], ['Gulf region experience', 0, ['gcc', 'saudi', 'middle east']]]],
  // Data centres and mission-critical
  ['d1', 'dc', 'Senior Construction Manager - Hyperscale Data Centre', 'Northgate Digital Infrastructure', 'Slough', 'GB', [
    ['Data centre delivery', 1, ['data centre']], ['MEP coordination', 1, ['mep']], ['Commissioning readiness', 1, ['commissioning']], ['HV power systems', 1, ['hv']],
    ['Integrated systems testing (Level 5)', 0, ['integrated systems test', 'level 5']]]],
  ['d2', 'dc', 'Client-side Construction Lead - 120MW Campus', 'Rheinwerk Data Parks', 'Frankfurt', 'DE', [
    ['Client-side authority', 1, ['client-side']], ['Data centre delivery', 1, ['data centre']], ['Managing Tier 1 contractors', 1, ['tier 1']], ['German language', 0, ['german']], ['Primavera P6 scheduling', 0, ['primavera']]], { contractType: 'contract' }],
  ['d4', 'dc', 'Site Lead - Edge Data Centre', 'Lekki Cloud Facilities', 'Lagos', 'NG', [
    ['Data centre delivery', 1, ['data centre']], ['HV/MV power systems', 1, ['hv/mv']], ['QA/QC and compliance', 1, ['qa/qc']], ['West Africa experience', 0, ['nigeria', 'west africa']]]],
  ['d5', 'dc', 'Commissioning Manager - AI Compute Campus', 'Blue Ridge Compute', 'Northern Virginia', 'US', [
    ['Commissioning leadership', 1, ['commissioning']], ['Commissioning authority certification', 1, ['cxa', 'commissioning authority']], ['US work authorisation', 1, ['us work authori']], ['Data centre delivery', 0, ['data centre']]]],
  // Energy and grid
  ['e1', 'en', 'Head of Construction - HVDC Converter Station', 'Tees Grid Connections', 'Teesside', 'GB', [
    ['Grid and substation delivery', 1, ['substation', 'grid']], ['HV power systems', 1, ['hv']], ['Subcontract governance', 1, ['subcontract']], ['Offshore wind integration', 0, ['offshore wind']], ['CDM 2015 duties', 0, ['cdm']]], { contractType: 'contract' }],
  ['e2', 'en', 'Construction Manager - Offshore Wind Onshore Works', 'Vesterhav Energi', 'Esbjerg', 'DK', [
    ['Offshore wind programmes', 1, ['offshore wind']], ['Multi-country delivery', 1, ['multi-country']], ['HSE leadership', 1, ['hse']], ['GWO training', 0, ['gwo']]]],
  ['e4', 'en', 'Site Manager - 200MW Solar and Storage', 'Karoo Sun Power', 'Northern Cape', 'ZA', [
    ['Energy programme delivery', 1, ['energy']], ['Solar or battery storage', 1, ['solar', 'bess', 'battery']], ['Contractor performance management', 1, ['contractor performance']], ['Southern Africa experience', 0, ['south africa']]]],
  ['e5', 'en', 'Construction Lead - Nuclear Enabling Works', 'Severnside Nuclear Delivery', 'Somerset', 'GB', [
    ['Security clearance (SC)', 1, ['sc cleared']], ['Civil and structural delivery', 1, ['civil']], ['QA/QC and compliance', 1, ['qa/qc']], ['Nuclear sector experience', 0, ['nuclear']]], { requiredCredential: 'sc' }],
  // Rail and transport
  ['r1', 'rail', 'Senior Project Manager - Main Line Electrification', 'Trentside Rail Alliance', 'Derby', 'GB', [
    ['Rail programme delivery', 1, ['rail']], ['Earned value management', 1, ['evm']], ['Schedule and cost control', 1, ['schedule']], ['Personal Track Safety card', 0, ['personal track safety', 'pts card']]]],
  ['r2', 'rail', 'Programme Delivery Lead - Metro Extension', 'Midland Metro Partnership', 'Birmingham', 'GB', [
    ['Metro or light rail delivery', 1, ['metro']], ['BIM implementation', 1, ['bim']], ['Programmes of £1BN and above', 1, ['£1.3bn', '£1bn']], ['Stakeholder management', 0, ['stakeholder']]], { contractType: 'contract' }],
  ['r3', 'rail', 'Construction Manager - Metro Line 4', 'Gulf Transit Constructors', 'Doha', 'QA', [
    ['Metro or light rail delivery', 1, ['metro']], ['Multi-contractor leadership', 1, ['multi-contractor']], ['FIDIC contracts', 0, ['fidic']], ['Gulf region experience', 0, ['gcc', 'qatar', 'middle east']]]],
  ['r4', 'rail', 'Responsable BIM - Ligne à grande vitesse', 'Rhône Rail Ingénierie', 'Lyon', 'FR', [
    ['BIM 4D/5D coordination', 1, ['bim']], ['Rail programme delivery', 1, ['rail']], ['French, professional level', 1, ['french', 'français']], ["Master's degree", 0, ['msc', 'master']]], { language: 'fr' }],
  ['r5', 'rail', 'Project Controls Manager - Light Rail', 'Lakeshore Transit Builders', 'Toronto', 'CA', [
    ['Primavera P6 scheduling', 1, ['primavera']], ['Earned value management', 1, ['evm']], ['Risk management', 1, ['risk']], ['Canadian work authorisation', 1, ['canadian work']], ['P.Eng or PMP', 0, ['p.eng', 'pmp certified']]]],
  // Francophone Africa and diaspora
  ['f1', 'fr', 'Directeur de projet - Infrastructure énergétique', 'Compagnie Énergie du Fleuve', 'Kinshasa', 'CD', [
    ['Major infrastructure programmes', 1, ['infrastructure']], ['Grid and HV systems', 1, ['grid', 'hv']], ['French, fluent', 1, ['french', 'français']], ['DRC experience', 0, ['drc', 'rdc', 'congo', 'kinshasa']]], { language: 'fr' }],
  ['f2', 'fr', 'Construction Manager - Mine de cuivre', 'Katanga Cuivre Développement', 'Kolwezi', 'CD', [
    ['Mining sector projects', 1, ['mining', 'minier']], ['HSE leadership', 1, ['hse']], ['Multi-contractor leadership', 1, ['multi-contractor']], ['French, working level', 1, ['french', 'français']]], { language: 'fr' }],
  ['f3', 'fr', 'Infrastructure Programme Officer', 'Agence Sahel Développement', 'Dakar', 'SN', [
    ["Master's degree", 1, ['msc', 'master']], ['Programme delivery and governance', 1, ['programme delivery']], ['French, fluent', 1, ['french', 'français']], ['Donor-funded project experience', 0, ['donor', 'development bank', 'humanitarian']]], { language: 'fr' }],
  ['f4', 'fr', 'Chargé de programme diaspora', 'Réseau Diaspora Europe-Afrique', 'Brussels', 'BE', [
    ['Project management qualification', 1, ['prince2', 'apmp']], ['French, fluent', 1, ['french', 'français']], ['Diaspora community work', 0, ['diaspora', 'community']]], { language: 'fr' }],
  ['f5', 'fr', 'Country Construction Lead - Data Centre', 'Lagune Data Afrique', 'Abidjan', 'CI', [
    ['Data centre delivery', 1, ['data centre']], ['Client-side authority', 1, ['client-side']], ['Commissioning readiness', 1, ['commissioning']], ['French, working level', 0, ['french', 'français']]]],
  // Healthcare outside the UK (the three v1 jobs above are the UK ones)
  ['h7', 'hc', 'Staff Nurse - Medical Ward', 'Liffey General Hospital', 'Dublin', 'IE', [
    ['NMBI registration (Ireland)', 1, ['nmbi']], ['Acute medical experience', 1, ['acute']], ['Medication administration', 1, ['medication']], ['IV therapy', 0, ['iv therapy']]], { requiredCredential: 'pin' }],
  ['h8', 'hc', 'Registered Nurse - Private Hospital', 'Al Noor Medical Centre', 'Dubai', 'AE', [
    ['Nursing registration in home country', 1, ['nmc']], ['Two years of acute experience', 1, ['acute']], ['DHA licence or eligibility letter', 1, ['dha']], ['French or Arabic language', 0, ['french', 'arabic']]], { requiredCredential: 'pin' }],
];

function demoToRaw([id, pack, title, employer, city, country, criteria, extra]: Demo): RawJob {
  const language = extra?.language ?? 'en';
  const fr = language === 'fr';
  const essential = criteria.filter((c) => c[1] === 1);
  const desirable = criteria.filter((c) => c[1] === 0);
  return {
    source: 'sample',
    externalId: id,
    title,
    employer: `${employer} (example)`,
    location: city,
    city,
    country,
    pack,
    language,
    url: `https://example.org/jobs/${id}`,
    description: [
      fr ? `${employer} (employeur fictif) recrute pour le poste suivant : ${title}, ${city}.` : `${employer} (a fictional employer) is recruiting: ${title}, ${city}.`,
      fr ? 'Profil recherché' : 'Essential',
      ...essential.map((c) => `- ${c[0]}.`),
      ...(desirable.length ? [fr ? 'Atouts' : 'Desirable', ...desirable.map((c) => `- ${c[0]}.`)] : []),
    ].join('\n'),
    criteria: criteria.map(([label, e, keywords]): Criterion => ({ label, essential: e === 1, keywords })),
    ...(extra?.requiredCredential ? { requiredCredential: extra.requiredCredential } : {}),
    contractType: extra?.contractType ?? 'permanent',
    employmentType: extra?.contractType === 'contract' ? 'Contract' : 'Permanent',
    origin: 'discovered',
  };
}

export interface SampleOptions {
  /** true = the three v1 healthcare jobs plus the demo jobs for every pack. false (default) = the three v1 jobs only. */
  allPacks?: boolean;
}

export function createSampleSource(options: SampleOptions = {}): JobSourceAdapter {
  return {
    name: 'sample',
    label: 'sample (fictional demo jobs)',
    async fetchJobs() {
      const raw = options.allPacks ? [...SAMPLES, ...PACK_DEMO.map(demoToRaw)] : SAMPLES;
      return raw.map(normaliseJob).filter(present);
    },
  };
}
