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

/**
 * "Lille, FR" -> { city: "Lille", country: "FR" }; "Lyon" -> { city: "Lyon", country: "FR" };
 * unknown -> country undefined. The part after the last comma may be an ISO code ("FR"), a country
 * name ("France") or a common alias ("UK", "England", "USA"): people write "Stafford, UK", not "GB".
 */
export function parseCity(value: string): { city: string; country: string | undefined } {
  const trimmed = value.trim();
  const comma = trimmed.lastIndexOf(',');
  if (comma > 0) {
    const country = resolveCountry(trimmed.slice(comma + 1));
    if (country) return { city: trimmed.slice(0, comma).trim(), country };
  }
  const folded = foldPlace(trimmed);
  // A UK town OpennJob can place by its postcode area (CITY_POSTCODE_AREAS) belongs to GB, so a
  // person who picks "Leeds" or "Bristol" (not just a picker city) still narrows the United Kingdom.
  return { city: trimmed, country: CITY_LOOKUP.get(folded) ?? (CITY_POSTCODE_AREAS[folded] ? 'GB' : undefined) };
}

/** An ISO alpha-2 code ("GB"), a country name ("United Kingdom") or a common alias ("UK") -> its code. */
export function resolveCountry(value: string): string | undefined {
  return normaliseCountryCode(value) ?? NAME_MAP.get(foldPlace(value));
}

/** Which country a preference city belongs to, or undefined when OpennJob cannot tell. */
export function cityCountry(value: string): string | undefined {
  return parseCity(value).country;
}

/**
 * The area letters of a UK postcode in a free-text location ("B24 6BF" -> "B", "CV1 2AB" -> "CV",
 * "WV10 7EH" -> "WV"). Adverts usually give a postcode, not a town name, so this lets a city
 * preference match them. Undefined when no postcode-looking token is present.
 */
export function ukPostcodeArea(value: string | undefined): string | undefined {
  const m = /(?:^|[\s,(])([A-Za-z]{1,2})\d/u.exec((value ?? '').trim());
  return m?.[1] ? m[1].toUpperCase() : undefined;
}

/**
 * UK postcode areas for the towns OpennJob can place, so a city preference also catches adverts
 * that give only a postcode. Coarse on purpose (one area covers neighbouring towns): Solihull and
 * West Bromwich sit in Birmingham's "B"; Stafford shares "ST" with Stoke-on-Trent. Keyed by folded
 * city name.
 */
export const CITY_POSTCODE_AREAS: Readonly<Record<string, readonly string[]>> = {
  // West Midlands region (metropolitan county + Staffordshire, Warwickshire, Worcestershire,
  // Herefordshire, Shropshire): neighbouring towns share one area, so the mapping is coarse.
  birmingham: ['B'], solihull: ['B'], 'west bromwich': ['B'], 'sutton coldfield': ['B'], redditch: ['B'],
  bromsgrove: ['B'], tamworth: ['B'], coventry: ['CV'], nuneaton: ['CV'], rugby: ['CV'], warwick: ['CV'],
  wolverhampton: ['WV'], walsall: ['WS'], cannock: ['WS'], dudley: ['DY'], kidderminster: ['DY'],
  stafford: ['ST'], 'stoke-on-trent': ['ST'], telford: ['TF'], shrewsbury: ['SY'], shropshire: ['SY', 'TF'],
  worcester: ['WR'], hereford: ['HR'],
  // East Midlands
  derby: ['DE'], 'burton-on-trent': ['DE'], leicester: ['LE'], nottingham: ['NG'], northampton: ['NN'],
  lincoln: ['LN'], peterborough: ['PE'],
  // Yorkshire and the North East
  leeds: ['LS'], sheffield: ['S'], barnsley: ['S'], rotherham: ['S'], bradford: ['BD'], wakefield: ['WF'],
  huddersfield: ['HD'], halifax: ['HX'], harrogate: ['HG'], york: ['YO'], hull: ['HU'], doncaster: ['DN'],
  newcastle: ['NE'], sunderland: ['SR'], middlesbrough: ['TS'], teesside: ['TS'], durham: ['DH'],
  darlington: ['DL'], carlisle: ['CA'],
  // North West
  manchester: ['M'], stockport: ['SK'], bolton: ['BL'], oldham: ['OL'], wigan: ['WN'], warrington: ['WA'],
  liverpool: ['L'], chester: ['CH'], crewe: ['CW'], preston: ['PR'], blackburn: ['BB'], blackpool: ['FY'],
  lancaster: ['LA'],
  // Scotland
  glasgow: ['G'], edinburgh: ['EH'], aberdeen: ['AB'], dundee: ['DD'], perth: ['PH'], inverness: ['IV'],
  paisley: ['PA'], kilmarnock: ['KA'], motherwell: ['ML'], falkirk: ['FK'], kirkcaldy: ['KY'], dumfries: ['DG'],
  // Wales
  cardiff: ['CF'], swansea: ['SA'], newport: ['NP'], wrexham: ['LL'],
  // South West
  bristol: ['BS'], bath: ['BA'], gloucester: ['GL'], swindon: ['SN'], plymouth: ['PL'], exeter: ['EX'],
  torquay: ['TQ'], truro: ['TR'], taunton: ['TA'], bournemouth: ['BH'], dorchester: ['DT'], salisbury: ['SP'],
  // South and South East
  southampton: ['SO'], portsmouth: ['PO'], brighton: ['BN'], guildford: ['GU'], oxford: ['OX'],
  'milton keynes': ['MK'], bedford: ['MK'], luton: ['LU'], basingstoke: ['RG'], reading: ['RG'], slough: ['SL'],
  maidstone: ['ME'], canterbury: ['CT'], 'tunbridge wells': ['TN'], chelmsford: ['CM'], colchester: ['CO'],
  southend: ['SS'], ipswich: ['IP'], norwich: ['NR'], cambridge: ['CB'],
  // London and its outer areas
  london: ['E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC'], watford: ['WD'], bromley: ['BR'], croydon: ['CR'],
  dartford: ['DA'], enfield: ['EN'], harrow: ['HA'], ilford: ['IG'], kingston: ['KT'], romford: ['RM'],
  sutton: ['SM'], twickenham: ['TW'], uxbridge: ['UB'],
};

/** Does a job location (its city or free-text place) fall in the given town, by name or postcode area? */
export function placeInCity(jobCity: string | undefined, jobLocation: string | undefined, cityName: string): boolean {
  const target = foldPlace(cityName);
  if (jobCity && foldPlace(jobCity) === target) return true;
  const areas = CITY_POSTCODE_AREAS[target];
  if (!areas) return false;
  const area = ukPostcodeArea(jobCity) ?? ukPostcodeArea(jobLocation);
  return area !== undefined && areas.includes(area);
}


const NAME_LOOKUP: ReadonlyArray<[string, string]> = [
  ...COUNTRIES.map((c): [string, string] => [foldPlace(c.name), c.code]),
  ['uk', 'GB'], ['great britain', 'GB'], ['england', 'GB'], ['scotland', 'GB'], ['wales', 'GB'], ['northern ireland', 'GB'],
  ['usa', 'US'], ['united states of america', 'US'], ['uae', 'AE'], ['drc', 'CD'], ['democratic republic of the congo', 'CD'],
  ['ivory coast', 'CI'], ['turkey', 'TR'], ['czech republic', 'CZ'], ['republic of ireland', 'IE'],
  ['britain', 'GB'], ['united states', 'US'], ['holland', 'NL'], ['the netherlands', 'NL'],
];

/** Country names and aliases (folded) -> ISO alpha-2 code. Used by resolveCountry. */
const NAME_MAP = new Map<string, string>(NAME_LOOKUP);

/**
 * A wider place gazetteer used ONLY to infer a job advert's country (inferPlace), so a worldwide
 * careers site cannot pass its foreign jobs off as the site's country. It is deliberately NOT the
 * city picker (KNOWN_CITIES): it holds common UK towns (so UK jobs are confirmed) and the foreign
 * cities, US states and global hubs that otherwise resolve to nothing. Folded place -> ISO code.
 */
const WORLD_PLACES: Readonly<Record<string, string>> = {
  // UK towns and cities beyond the picker list, so a UK job is confirmed rather than guessed.
  stafford: 'GB', stone: 'GB', warwick: 'GB', rugby: 'GB', bristol: 'GB', leeds: 'GB', sheffield: 'GB', liverpool: 'GB',
  newcastle: 'GB', nottingham: 'GB', leicester: 'GB', reading: 'GB', cardiff: 'GB', edinburgh: 'GB', aberdeen: 'GB', bath: 'GB',
  oxford: 'GB', cambridge: 'GB', york: 'GB', watford: 'GB', amersham: 'GB', wakefield: 'GB', bridgwater: 'GB', prescot: 'GB',
  stirling: 'GB', portsmouth: 'GB', southampton: 'GB', brighton: 'GB', hull: 'GB', preston: 'GB', bolton: 'GB', swindon: 'GB',
  worcester: 'GB', hereford: 'GB', shrewsbury: 'GB', telford: 'GB', dudley: 'GB', walsall: 'GB', cannock: 'GB',
  kidderminster: 'GB', redditch: 'GB', tamworth: 'GB', nuneaton: 'GB', 'sutton coldfield': 'GB', bromsgrove: 'GB',
  'west bromwich': 'GB', 'stoke-on-trent': 'GB', doncaster: 'GB', bradford: 'GB', huddersfield: 'GB', halifax: 'GB',
  harrogate: 'GB', middlesbrough: 'GB', sunderland: 'GB', durham: 'GB', darlington: 'GB', carlisle: 'GB',
  stockport: 'GB', oldham: 'GB', wigan: 'GB', warrington: 'GB', chester: 'GB', crewe: 'GB', blackburn: 'GB',
  blackpool: 'GB', lancaster: 'GB', dundee: 'GB', perth: 'GB', inverness: 'GB', paisley: 'GB', swansea: 'GB',
  newport: 'GB', wrexham: 'GB', plymouth: 'GB', exeter: 'GB', torquay: 'GB', truro: 'GB', taunton: 'GB',
  gloucester: 'GB', bournemouth: 'GB', salisbury: 'GB', guildford: 'GB', 'milton keynes': 'GB', luton: 'GB',
  basingstoke: 'GB', maidstone: 'GB', canterbury: 'GB', chelmsford: 'GB', colchester: 'GB', ipswich: 'GB',
  norwich: 'GB', northampton: 'GB', lincoln: 'GB', peterborough: 'GB', bedford: 'GB',
  // United States: all states, plus common GE Vernova / industry hubs that appear as bare city names.
  alabama: 'US', alaska: 'US', arizona: 'US', arkansas: 'US', california: 'US', colorado: 'US', connecticut: 'US', delaware: 'US',
  florida: 'US', hawaii: 'US', idaho: 'US', illinois: 'US', indiana: 'US', iowa: 'US', kansas: 'US', kentucky: 'US',
  louisiana: 'US', maine: 'US', maryland: 'US', massachusetts: 'US', michigan: 'US', minnesota: 'US', mississippi: 'US', missouri: 'US',
  montana: 'US', nebraska: 'US', nevada: 'US', ohio: 'US', oklahoma: 'US', oregon: 'US', pennsylvania: 'US', tennessee: 'US',
  texas: 'US', utah: 'US', vermont: 'US', virginia: 'US', washington: 'US', wisconsin: 'US', wyoming: 'US',
  'niagara falls': 'US', schenectady: 'US', greenville: 'US', pensacola: 'US', 'oakbrook terrace': 'US', duquoin: 'US',
  'findlay township': 'US', mckinney: 'US', atlanta: 'US', houston: 'US', 'new york': 'US', chicago: 'US', boston: 'US', dallas: 'US',
  // Canada
  markham: 'CA', toronto: 'CA', montreal: 'CA', calgary: 'CA', ottawa: 'CA',
  // India
  noida: 'IN', vadodara: 'IN', bengaluru: 'IN', bangalore: 'IN', chennai: 'IN', mumbai: 'IN', hyderabad: 'IN', pune: 'IN', 'new delhi': 'IN', delhi: 'IN',
  // Europe (non-UK) and MENA hubs that show up on energy careers sites.
  berlin: 'DE', munich: 'DE', hamburg: 'DE', milan: 'IT', rome: 'IT', madrid: 'ES', barcelona: 'ES', kirkkonummi: 'FI', helsinki: 'FI',
  'new cairo': 'EG', cairo: 'EG', doha: 'QA', riyadh: 'SA', dubai: 'AE', 'abu dhabi': 'AE',
  // East Asia / Pacific
  shanghai: 'CN', beijing: 'CN', singapore: 'SG', tokyo: 'JP', sydney: 'AU', melbourne: 'AU',
};
const WORLD_PLACE_MAP = new Map<string, string>(Object.entries(WORLD_PLACES).map(([k, v]) => [foldPlace(k), v]));

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
    const folded = foldPlace(part);
    const hit = Object.keys(KNOWN_CITIES).find((c) => foldPlace(c) === folded);
    if (hit) {
      city = hit;
      country = KNOWN_CITIES[hit];
      break;
    }
    const world = WORLD_PLACE_MAP.get(folded);
    if (world) {
      city = part;
      country = world;
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
