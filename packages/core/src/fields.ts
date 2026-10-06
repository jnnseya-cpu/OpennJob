import type { Passport, Profile } from './types';

/**
 * Form-field classification. Shared by the API and the browser extension (this file has
 * no Node or DOM dependencies). Two questions are answered for each field:
 *   1. Is it SENSITIVE? (never filled until the user confirms it)
 *   2. Which piece of stored data, if any, belongs in it?
 * When in doubt a field is classed as sensitive: a false positive costs the user one
 * extra tick, a false negative could put a declaration on a form unreviewed.
 */

export interface FieldDescriptor {
  label?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  /** The input's type attribute (text, email, radio, ...). */
  type?: string;
  /** input | textarea | select */
  tag?: string;
  /** Text of the enclosing fieldset legend / section heading, if any. */
  groupLabel?: string;
}

export type SensitiveCategory =
  | 'referee'
  | 'convictions'
  | 'dbs'
  | 'registration'
  | 'credential'
  | 'security-clearance'
  | 'right-to-work'
  | 'conflict-of-interest'
  | 'fitness-to-practise'
  | 'safeguarding'
  | 'health'
  | 'equality'
  | 'declaration';

export type FieldKey =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'postcode'
  | 'supportingStatement'
  | 'nmcPin'
  | 'professionalMembershipNumber'
  | 'cscsCardNumber'
  | 'languages'
  | 'dbsCertificateNumber'
  | 'dbsIssueDate'
  | 'dbsUpdateService'
  | 'rightToWork'
  | `referee${1 | 2 | 3}.${'name' | 'email' | 'phone' | 'organisation' | 'relationship'}`;

export interface FieldClassification {
  /** true for fields the agent must never read or write (passwords, hidden, file, buttons). */
  ignore: boolean;
  ignoreReason?: 'password' | 'not-fillable';
  sensitive: boolean;
  category: SensitiveCategory | null;
  key: FieldKey | null;
}

const IGNORED_TYPES = new Set(['hidden', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color']);

/** "nmcPin", "first_name", "addr-line-1" -> "nmc pin", "first name", "addr line 1" */
export function normaliseFieldText(...parts: Array<string | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) =>
      p
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .replace(/[_\-.[\]/:*?()]+/g, ' ')
        .toLowerCase(),
    )
    .join(' | ')
    .replace(/[^\S|]+/g, ' ')
    .trim();
}

/**
 * Order matters: the first matching category wins.
 *
 * French: the patterns also cover the French wording of the same questions (casier
 * judiciaire, permis de travail, droit de travailler, références, déclaration sur
 * l'honneur). Field text is lower-cased but keeps its accents, so accented and
 * unaccented spellings are both listed. Only tried on the French fixture form.
 */
export const SENSITIVE_PATTERNS: ReadonlyArray<{ category: SensitiveCategory; pattern: RegExp }> = [
  { category: 'referee', pattern: /\breferee|\breferences?\b|\br[ée]f[ée]rences\b|\br[ée]f[ée]rents?\b|personnes? de r[ée]f[ée]rence/ },
  {
    category: 'convictions',
    pattern: /convict|\bcautions?\b|criminal|reprimand|\boffences?\b|\boffenses?\b|police|casier judiciaire|condamn|infractions? p[ée]nales?|ant[ée]c[ée]dents judiciaires/,
  },
  { category: 'dbs', pattern: /\bdbs\b|disclosure and barring|disclosure & barring|update service|\bpvg\b|access ni/ },
  {
    category: 'registration',
    pattern: /\bnmc\b|\bpin\b|professional registration|registration (number|no|pin|body)|\bhcpc\b|\bgmc\b|regulatory body|registered with/,
  },
  {
    // Security clearance and vetting. The user answers these; OpennJob never does.
    category: 'security-clearance',
    pattern: /security clear|\bsc clear|\bdv clear|\bvetting\b|\bvetted\b|\bbpss\b|developed vetting|habilitation( de s[ée]curit[ée])?\b|enqu[êe]te de s[ée]curit[ée]/,
  },
  {
    category: 'right-to-work',
    pattern:
      /right to work|\bvisa\b|immigration|work permit|work authori[sz]ation|authori[sz]ed to work|sponsorship|settled status|leave to remain|national insurance|\bni number\b|nationality|citizenship|share code|passport|permis de travail|droit de travailler|droit au travail|autorisation de travail|autoris[ée]e? [àa] travailler|titre de s[ée]jour|nationalit[ée]|parrainage/,
  },
  { category: 'conflict-of-interest', pattern: /conflicts? of interests?|conflits? d.int[ée]r[êe]ts?/ },
  { category: 'safeguarding', pattern: /safeguard|barred list|barred from/ },
  { category: 'fitness-to-practise', pattern: /fitness to practi[sc]e|disciplinary|\bdismiss|under investigation|investigat/ },
  {
    category: 'health',
    pattern: /health declaration|occupational health|medical (condition|history|questionnaire)|health (condition|question|issue)|disabilit|reasonable adjustment|vaccinat|immunis/,
  },
  {
    category: 'equality',
    pattern: /equal(ity)? (opportunit|monitoring|and diversity)|equal opportunit|diversity monitoring|ethnic|\brace\b|religio|\bbelief\b|sexual orientation|\bgender\b|\bsex\b|marital|civil partnership|date of birth|\bdob\b|\bage\b|pregnan|maternity|date de naissance|situation familiale/,
  },
  {
    // Professional membership and site-card numbers from the credential passport. Sensitive
    // like the NMC PIN: filled only after the user confirms the field.
    category: 'credential',
    pattern: /professional membership|membership (number|no|grade)\b|\b(mciob|ciob|mrics|rics|apm|ice|riba) (membership|member|number|no)\b|\bcscs\b|num[ée]ro d.adh[ée]rent|carte professionnelle/,
  },
  { category: 'declaration', pattern: /d[ée]clar|i confirm|i certify|i consent|i agree|sur l.honneur|j.atteste|je certifie|je confirme|j.accepte/ },
];

/** "Job reference", "vacancy ref" etc. are not about referees. */
const JOB_REFERENCE = /(job|vacancy|post|advert|application|requisition) (ref|reference)\b|reference (number|no|code|id)\b|r[ée]f[ée]rences? (de l.offre|du poste|de l.annonce)/;

export function detectSensitiveCategory(text: string): SensitiveCategory | null {
  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (!pattern.test(text)) continue;
    if (category === 'referee' && JOB_REFERENCE.test(text) && !/\breferee|r[ée]f[ée]rents?\b/.test(text)) continue;
    return category;
  }
  return null;
}

const AUTOCOMPLETE_KEYS: Readonly<Record<string, FieldKey>> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'address-line1': 'addressLine1',
  'street-address': 'addressLine1',
  'address-line2': 'addressLine2',
  'address-level2': 'city',
  'postal-code': 'postcode',
};

function refereeIndex(text: string): 1 | 2 | 3 {
  const m = /(?:referee|reference)\s*(\d)|(\d)(?:st|nd|rd)?\s*(?:referee|reference)/.exec(text);
  const n = m ? Number(m[1] ?? m[2]) : /second/.test(text) ? 2 : /third/.test(text) ? 3 : 1;
  return n === 2 ? 2 : n === 3 ? 3 : 1;
}

function refereeKey(own: string, all: string, type: string): FieldKey {
  const i = refereeIndex(all);
  if (type === 'email' || /e ?mail|courriel/.test(own)) return `referee${i}.email`;
  if (type === 'tel' || /phone|mobile|telephone|\btel\b|contact number|t[ée]l[ée]phone/.test(own)) return `referee${i}.phone`;
  if (/organisation|organization|employer|company|workplace|organisme|entreprise|employeur|soci[ée]t[ée]/.test(own)) return `referee${i}.organisation`;
  if (/relationship|capacity|position|job title|\brole\b|fonction|lien professionnel/.test(own)) return `referee${i}.relationship`;
  return `referee${i}.name`;
}

function plainKey(own: string, d: FieldDescriptor): FieldKey | null {
  const type = (d.type ?? '').toLowerCase();
  const tag = (d.tag ?? '').toLowerCase();
  for (const token of (d.autocomplete ?? '').toLowerCase().split(/\s+/)) {
    const k = AUTOCOMPLETE_KEYS[token];
    if (k) return k;
  }
  if (/supporting (statement|information)|person spec|personal statement|cover(ing)? letter|why (do|are|would) you|suitability|lettre de motivation/.test(own)) {
    return 'supportingStatement';
  }
  if (tag === 'textarea' && /statement/.test(own)) return 'supportingStatement';
  // French labels for the basic fields sit beside the English ones: prénom, nom, courriel /
  // e-mail, téléphone, adresse, code postal, ville. ("e-mail" is already "e mail" after normalising.)
  if (type === 'email' || /e ?mail|courriel|adresse [ée]lectronique/.test(own)) return 'email';
  if (/first name|forename|given name|\bfname\b|pr[ée]noms?( \||$| \()/.test(own)) return 'firstName';
  if (/last name|surname|family name|\blname\b|nom de famille|(^|\| )nom( \||$)/.test(own)) return 'lastName';
  if (/full name|your name|(^|\| )name( \||$)|nom complet|nom et pr[ée]nom|pr[ée]nom et nom/.test(own)) return 'fullName';
  if (type === 'tel' || /phone|mobile|telephone|\btel\b|contact number|t[ée]l[ée]phone|\bportable\b/.test(own)) return 'phone';
  if (/post ?code|postal code|\bzip\b|code postal/.test(own)) return 'postcode';
  if (/address (line )?2|addr(ess)? ?2|compl[ée]ment d.adresse|adresse (ligne )?2/.test(own)) return 'addressLine2';
  if (/\btown\b|\bcity\b|\bville\b|\bcommune\b/.test(own)) return 'city';
  if (/address (line )?1|addr(ess)? ?1|street|house (number|name)|(^|\| )address( \||$)|home address|(^|\| )adresse( \||$)|adresse (postale|ligne 1|1)|\brue\b/.test(own)) return 'addressLine1';
  // Languages spoken: an ordinary field, filled from the passport's "Languages" line or the selected languages.
  if (/\blanguages?( you)? (spoken|speak)|(^|\| )languages( \||$)|langues? parl[ée]es?|(^|\| )langues( \||$)/.test(own)) return 'languages';
  return null;
}

export function classifyField(d: FieldDescriptor): FieldClassification {
  const type = (d.type ?? '').toLowerCase();
  if (type === 'password') return { ignore: true, ignoreReason: 'password', sensitive: true, category: null, key: null };
  if (IGNORED_TYPES.has(type)) return { ignore: true, ignoreReason: 'not-fillable', sensitive: false, category: null, key: null };

  const own = normaliseFieldText(d.label, d.name, d.id, d.placeholder);
  const all = normaliseFieldText(d.label, d.name, d.id, d.placeholder, d.groupLabel);
  const category = detectSensitiveCategory(all);

  if (category === null) return { ignore: false, sensitive: false, category: null, key: plainKey(own, d) };

  let key: FieldKey | null = null;
  switch (category) {
    case 'referee':
      key = refereeKey(own, all, type);
      break;
    case 'registration':
      if (/\bnmc\b|\bpin\b|registration (number|no|pin)/.test(all) && type !== 'checkbox' && type !== 'radio') key = 'nmcPin';
      break;
    case 'dbs':
      if (/update service/.test(all)) key = 'dbsUpdateService';
      else if (/issue|\bdate\b|issued/.test(own)) key = 'dbsIssueDate';
      else if (/certificate|number|\bno\b/.test(own)) key = 'dbsCertificateNumber';
      break;
    case 'credential':
      if (type !== 'checkbox' && type !== 'radio') {
        if (/\bcscs\b/.test(own)) key = /expir|valid until|\bdate\b/.test(own) ? null : 'cscsCardNumber';
        else if (/membership|\b(mciob|ciob|mrics|rics|apm|ice|riba)\b|adh[ée]rent/.test(own) && !/grade|body|institution|organisme/.test(own)) key = 'professionalMembershipNumber';
      }
      break;
    case 'right-to-work':
      // The stored confirmation is about the UK only. It is offered for "right to work" /
      // "right to work in the UK", and NOT when the question names somewhere else
      // ("right to work in Ireland") or is asked in French (permis de travail, droit de
      // travailler: those forms are for another country). Visa and sponsorship questions
      // are never answered either. The user answers all of those personally.
      if (/right to work/.test(all) && !/right to work in (?!(the )?(uk|u k|united kingdom|great britain|britain|this country)\b)[a-z]/.test(all)) key = 'rightToWork';
      break;
    default:
      // Convictions, security clearance and vetting, conflicts of interest, fitness to
      // practise, safeguarding, health, equality monitoring and free-form declarations
      // are NEVER auto-answered. OpennJob stores no data for them.
      key = null;
  }
  return { ignore: false, sensitive: true, category, key };
}

export type FillValue = string | boolean;
export type FillValues = Partial<Record<FieldKey, FillValue>>;

/** Builds the value for every field key from the stored profile, passport and drafted statement. */
export function buildFillValues(profile: Profile, passport?: Passport, statement?: string): FillValues {
  const v: FillValues = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: `${profile.firstName} ${profile.lastName}`.trim(),
    email: profile.email,
    phone: profile.phone,
    addressLine1: profile.addressLine1,
    city: profile.city,
    postcode: profile.postcode,
  };
  if (profile.addressLine2) v.addressLine2 = profile.addressLine2;
  if (statement && statement.trim()) v.supportingStatement = statement;
  const selectedLanguages = (profile.preferences?.languages ?? []).filter((l) => l.trim());
  if (selectedLanguages.length > 0) v.languages = selectedLanguages.join(', ');
  if (passport) {
    const credential = (id: string): string => {
      const fromMap = passport.credentials?.[id];
      return typeof fromMap === 'string' ? fromMap.trim() : '';
    };
    // credentials.pin and the v1 nmcPin field are the same thing; the map wins when both are present.
    const pin = credential('pin') || passport.nmcPin?.trim() || '';
    if (pin) v.nmcPin = pin;
    if (credential('prof')) v.professionalMembershipNumber = credential('prof');
    if (credential('cscs')) v.cscsCardNumber = credential('cscs');
    if (credential('lang')) v.languages = credential('lang');
    if (passport.dbs?.certificateNumber) v.dbsCertificateNumber = passport.dbs.certificateNumber;
    if (passport.dbs?.issueDate) v.dbsIssueDate = passport.dbs.issueDate;
    if (typeof passport.dbs?.onUpdateService === 'boolean') v.dbsUpdateService = passport.dbs.onUpdateService;
    // Only ever offered as "yes" when the user has stored that confirmation. Never offered as "no".
    if (passport.rightToWorkConfirmed === true) v.rightToWork = true;
    // credentials.sc (security clearance) and credentials.rtw (countries you can work in) are
    // deliberately NOT turned into fill values: those questions are the user's to answer.
    passport.referees.slice(0, 3).forEach((r, idx) => {
      const i = (idx + 1) as 1 | 2 | 3;
      if (r.name) v[`referee${i}.name`] = r.name;
      if (r.email) v[`referee${i}.email`] = r.email;
      if (r.phone) v[`referee${i}.phone`] = r.phone;
      if (r.organisation) v[`referee${i}.organisation`] = r.organisation;
      if (r.relationship) v[`referee${i}.relationship`] = r.relationship;
    });
  }
  return v;
}
