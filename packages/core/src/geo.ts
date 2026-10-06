/**
 * Countries, regions and the small city table used for candidate preferences.
 *
 * COUNTRY LIST: the 249 ISO 3166-1 alpha-2 codes, typed in from memory and checked only
 * against the ICU data that ships with Node (every code resolves to a region name there).
 * It has not been compared with the ISO register itself. Names are short English names.
 *
 * REGIONS are OpennJob's own five browsing groups plus two catch-alls. They are a product
 * convenience, not a legal or geographic authority: "uk" is GB only (the Crown
 * dependencies sit under "eu"), North Africa is under "africa", Turkey under "mena".
 */

export type Region = 'uk' | 'eu' | 'africa' | 'mena' | 'am' | 'apac' | 'other';

export const REGIONS: Readonly<Record<Region, string>> = {
  uk: 'UK',
  eu: 'Europe',
  africa: 'Africa',
  mena: 'Middle East',
  am: 'Americas',
  apac: 'Asia-Pacific',
  other: 'Other',
};

export const REGION_IDS = Object.keys(REGIONS) as Region[];

const BY_REGION: Readonly<Record<Region, string>> = {
  uk: 'GB:United Kingdom',
  eu:
    'AD:Andorra;AL:Albania;AT:Austria;AX:Åland Islands;BA:Bosnia and Herzegovina;BE:Belgium;BG:Bulgaria;BY:Belarus;CH:Switzerland;CY:Cyprus;' +
    'CZ:Czechia;DE:Germany;DK:Denmark;EE:Estonia;ES:Spain;FI:Finland;FO:Faroe Islands;FR:France;GG:Guernsey;GI:Gibraltar;GR:Greece;HR:Croatia;' +
    'HU:Hungary;IE:Ireland;IM:Isle of Man;IS:Iceland;IT:Italy;JE:Jersey;LI:Liechtenstein;LT:Lithuania;LU:Luxembourg;LV:Latvia;MC:Monaco;' +
    'MD:Moldova;ME:Montenegro;MK:North Macedonia;MT:Malta;NL:Netherlands;NO:Norway;PL:Poland;PT:Portugal;RO:Romania;RS:Serbia;RU:Russia;' +
    'SE:Sweden;SI:Slovenia;SJ:Svalbard and Jan Mayen;SK:Slovakia;SM:San Marino;UA:Ukraine;VA:Vatican City',
  africa:
    'AO:Angola;BF:Burkina Faso;BI:Burundi;BJ:Benin;BW:Botswana;CD:DR Congo;CF:Central African Republic;CG:Congo (Brazzaville);' +
    "CI:Côte d'Ivoire;CM:Cameroon;CV:Cabo Verde;DJ:Djibouti;DZ:Algeria;EG:Egypt;EH:Western Sahara;ER:Eritrea;ET:Ethiopia;GA:Gabon;GH:Ghana;" +
    'GM:Gambia;GN:Guinea;GQ:Equatorial Guinea;GW:Guinea-Bissau;KE:Kenya;KM:Comoros;LR:Liberia;LS:Lesotho;LY:Libya;MA:Morocco;MG:Madagascar;' +
    'ML:Mali;MR:Mauritania;MU:Mauritius;MW:Malawi;MZ:Mozambique;NA:Namibia;NE:Niger;NG:Nigeria;RE:Réunion;RW:Rwanda;SC:Seychelles;SD:Sudan;' +
    'SH:Saint Helena;SL:Sierra Leone;SN:Senegal;SO:Somalia;SS:South Sudan;ST:São Tomé and Príncipe;SZ:Eswatini;TD:Chad;TG:Togo;TN:Tunisia;' +
    'TZ:Tanzania;UG:Uganda;YT:Mayotte;ZA:South Africa;ZM:Zambia;ZW:Zimbabwe',
  mena:
    'AE:United Arab Emirates;BH:Bahrain;IL:Israel;IQ:Iraq;IR:Iran;JO:Jordan;KW:Kuwait;LB:Lebanon;OM:Oman;PS:Palestine;QA:Qatar;' +
    'SA:Saudi Arabia;SY:Syria;TR:Türkiye;YE:Yemen',
  am:
    'AG:Antigua and Barbuda;AI:Anguilla;AR:Argentina;AW:Aruba;BB:Barbados;BL:Saint Barthélemy;BM:Bermuda;BO:Bolivia;' +
    'BQ:Bonaire, Sint Eustatius and Saba;BR:Brazil;BS:Bahamas;BZ:Belize;CA:Canada;CL:Chile;CO:Colombia;CR:Costa Rica;CU:Cuba;CW:Curaçao;' +
    'DM:Dominica;DO:Dominican Republic;EC:Ecuador;FK:Falkland Islands;GD:Grenada;GF:French Guiana;GL:Greenland;GP:Guadeloupe;GT:Guatemala;' +
    'GY:Guyana;HN:Honduras;HT:Haiti;JM:Jamaica;KN:Saint Kitts and Nevis;KY:Cayman Islands;LC:Saint Lucia;MF:Saint Martin;MQ:Martinique;' +
    'MS:Montserrat;MX:Mexico;NI:Nicaragua;PA:Panama;PE:Peru;PM:Saint Pierre and Miquelon;PR:Puerto Rico;PY:Paraguay;SR:Suriname;' +
    'SV:El Salvador;SX:Sint Maarten;TC:Turks and Caicos Islands;TT:Trinidad and Tobago;US:United States;UY:Uruguay;' +
    'VC:Saint Vincent and the Grenadines;VE:Venezuela;VG:British Virgin Islands;VI:US Virgin Islands',
  apac:
    'AF:Afghanistan;AM:Armenia;AS:American Samoa;AU:Australia;AZ:Azerbaijan;BD:Bangladesh;BN:Brunei;BT:Bhutan;CC:Cocos (Keeling) Islands;' +
    'CK:Cook Islands;CN:China;CX:Christmas Island;FJ:Fiji;FM:Micronesia;GE:Georgia;GU:Guam;HK:Hong Kong;ID:Indonesia;IN:India;' +
    'IO:British Indian Ocean Territory;JP:Japan;KG:Kyrgyzstan;KH:Cambodia;KI:Kiribati;KP:North Korea;KR:South Korea;KZ:Kazakhstan;LA:Laos;' +
    'LK:Sri Lanka;MH:Marshall Islands;MM:Myanmar;MN:Mongolia;MO:Macao;MP:Northern Mariana Islands;MV:Maldives;MY:Malaysia;NC:New Caledonia;' +
    'NF:Norfolk Island;NP:Nepal;NR:Nauru;NU:Niue;NZ:New Zealand;PF:French Polynesia;PG:Papua New Guinea;PH:Philippines;PK:Pakistan;' +
    'PN:Pitcairn Islands;PW:Palau;SB:Solomon Islands;SG:Singapore;TH:Thailand;TJ:Tajikistan;TK:Tokelau;TL:Timor-Leste;TM:Turkmenistan;' +
    'TO:Tonga;TV:Tuvalu;TW:Taiwan;UM:US Minor Outlying Islands;UZ:Uzbekistan;VN:Vietnam;VU:Vanuatu;WF:Wallis and Futuna;WS:Samoa',
  other: 'AQ:Antarctica;BV:Bouvet Island;GS:South Georgia and the South Sandwich Islands;HM:Heard Island and McDonald Islands;TF:French Southern Territories',
};

export interface Country {
  /** ISO 3166-1 alpha-2, upper case. */
  code: string;
  name: string;
  region: Region;
}

export const COUNTRIES: readonly Country[] = REGION_IDS.flatMap((region) =>
  BY_REGION[region].split(';').map((entry) => {
    const i = entry.indexOf(':');
    return { code: entry.slice(0, i), name: entry.slice(i + 1), region };
  }),
).sort((a, b) => a.code.localeCompare(b.code));

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

/** Every ISO 3166-1 alpha-2 code, upper case, sorted. Used to validate input. */
export const ISO_COUNTRY_CODES: readonly string[] = COUNTRIES.map((c) => c.code);

/** " gb " -> "GB". Returns undefined for anything that is not an ISO 3166-1 alpha-2 code. */
export function normaliseCountryCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toUpperCase();
  return BY_CODE.has(code) ? code : undefined;
}

export const isCountryCode = (value: unknown): boolean => normaliseCountryCode(value) !== undefined;

export function countryName(code: string | undefined): string | undefined {
  return code ? BY_CODE.get(code.trim().toUpperCase())?.name : undefined;
}

/** The browsing region a country belongs to. undefined for an unknown or missing code. */
export function regionOf(country: string | undefined): Region | undefined {
  return country ? BY_CODE.get(country.trim().toUpperCase())?.region : undefined;
}

/** Lower case, no accents, single spaces: "  Côte d'Ivoire " -> "cote d'ivoire". */
export function foldPlace(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The cities OpennJob knows the country of (the demo's city list). This is NOT a
 * gazetteer. A city outside this table can still be used in preferences by writing it
 * with its country code: "Lille, FR".
 */
export const KNOWN_CITIES: Readonly<Record<string, string>> = {
  Birmingham: 'GB', Manchester: 'GB', London: 'GB', Slough: 'GB', Teesside: 'GB', Glasgow: 'GB', Somerset: 'GB', Derby: 'GB',
  Solihull: 'GB', Wolverhampton: 'GB', Coventry: 'GB',
  Dublin: 'IE', Frankfurt: 'DE', Esbjerg: 'DK', Lyon: 'FR', Brussels: 'BE', Riyadh: 'SA', Doha: 'QA', Dubai: 'AE', Lagos: 'NG',
  'Northern Cape': 'ZA', Kinshasa: 'CD', Kolwezi: 'CD', Dakar: 'SN', Abidjan: 'CI', 'Northern Virginia': 'US', Toronto: 'CA',
};

const CITY_LOOKUP = new Map(Object.entries(KNOWN_CITIES).map(([city, code]) => [foldPlace(city), code]));

/** "Lille, FR" -> { city: "Lille", country: "FR" }; "Lyon" -> { city: "Lyon", country: "FR" }; unknown -> country undefined. */
export function parseCity(value: string): { city: string; country: string | undefined } {
  const m = /^(.*?),\s*([A-Za-z]{2})\s*$/.exec(value.trim());
  if (m) {
    const country = normaliseCountryCode(m[2]);
    if (country) return { city: (m[1] as string).trim(), country };
  }
  const city = value.trim();
  return { city, country: CITY_LOOKUP.get(foldPlace(city)) };
}

/** Which country a preference city belongs to, or undefined when OpennJob cannot tell. */
export function cityCountry(value: string): string | undefined {
  return parseCity(value).country;
}

export const sameCity = (a: string, b: string): boolean => foldPlace(parseCity(a).city) === foldPlace(parseCity(b).city);

const NAME_LOOKUP: ReadonlyArray<[string, string]> = [
  ...COUNTRIES.map((c): [string, string] => [foldPlace(c.name), c.code]),
  ['uk', 'GB'], ['great britain', 'GB'], ['england', 'GB'], ['scotland', 'GB'], ['wales', 'GB'], ['northern ireland', 'GB'],
  ['usa', 'US'], ['united states of america', 'US'], ['uae', 'AE'], ['drc', 'CD'], ['democratic republic of the congo', 'CD'],
  ['ivory coast', 'CI'], ['turkey', 'TR'], ['czech republic', 'CZ'], ['republic of ireland', 'IE'],
];

/**
 * Best-effort guess at a job's country and city from a free-text location such as
 * "Leeds, UK" or "Lyon". Looks for a known city, then for a country name. A heuristic:
 * it returns nothing rather than guess when it recognises neither.
 */
export function inferPlace(location: string | undefined): { country?: string; city?: string } {
  if (!location) return {};
  const parts = location.split(/[,/|()-]+/).map((p) => p.trim()).filter(Boolean);
  let city: string | undefined;
  let country: string | undefined;
  for (const part of parts) {
    const hit = Object.keys(KNOWN_CITIES).find((c) => foldPlace(c) === foldPlace(part));
    if (hit) {
      city = hit;
      country = KNOWN_CITIES[hit];
      break;
    }
  }
  if (!country) {
    for (const part of [...parts].reverse()) {
      const folded = foldPlace(part);
      const byName = NAME_LOOKUP.find(([name]) => name === folded);
      if (byName) {
        country = byName[1];
        break;
      }
    }
  }
  if (country && !city && parts.length > 1) city = parts[0];
  return { ...(country ? { country } : {}), ...(city ? { city } : {}) };
}
