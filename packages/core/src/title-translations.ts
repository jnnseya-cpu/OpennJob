/**
 * Job titles in the language of the country searched. A CV says "electrical engineer"; adverts in
 * France say "ingénieur électricien", in Germany "Elektroingenieur". Searches in those countries
 * ask for both, and an advert titled in the local language counts as the same kind of post when
 * the CV shows the English title. A small, hand-made list for the titles OpennJob recognises
 * (search.ts ROLE_TITLES); a title not on it is searched in English only.
 */

export type TitleLanguage = 'fr' | 'de' | 'nl' | 'es' | 'it';

/** The languages adverts are commonly written in, by country (ISO 3166-1 alpha-2). English is always searched too. */
export const COUNTRY_LANGUAGES: Readonly<Record<string, readonly TitleLanguage[]>> = {
  FR: ['fr'], BE: ['fr', 'nl'], LU: ['fr', 'de'], CH: ['de', 'fr'], MC: ['fr'],
  DE: ['de'], AT: ['de'], NL: ['nl'], ES: ['es'], MX: ['es'], IT: ['it'],
  // Francophone Africa
  CD: ['fr'], CG: ['fr'], CI: ['fr'], SN: ['fr'], CM: ['fr'], MA: ['fr'], TN: ['fr'], DZ: ['fr'], GA: ['fr'], BJ: ['fr'], TG: ['fr'], ML: ['fr'], BF: ['fr'], NE: ['fr'], GN: ['fr'], MG: ['fr'], RW: ['fr'], BI: ['fr'],
};

/** English title -> its usual titles in each language. Lower case. */
export const TITLE_TRANSLATIONS: Readonly<Record<string, Partial<Record<TitleLanguage, readonly string[]>>>> = {
  'project manager': { fr: ['chef de projet'], de: ['projektleiter', 'projektmanager'], nl: ['projectleider', 'projectmanager'], es: ['jefe de proyecto'], it: ['responsabile di progetto'] },
  'senior project manager': { fr: ['chef de projet senior'], de: ['senior projektleiter'], nl: ['senior projectleider'], es: ['jefe de proyecto senior'] },
  'project director': { fr: ['directeur de projet'], de: ['projektdirektor'], es: ['director de proyecto'], it: ['direttore di progetto'] },
  'programme manager': { fr: ['directeur de programme'], de: ['programmmanager'], es: ['director de programa'] },
  'site manager': { fr: ['conducteur de travaux'], de: ['bauleiter'], nl: ['uitvoerder'], es: ['jefe de obra'], it: ['capo cantiere'] },
  'construction manager': { fr: ['directeur de travaux'], de: ['bauleiter', 'oberbauleiter'], nl: ['bouwmanager'], es: ['jefe de obra'], it: ['direttore dei lavori'] },
  'site engineer': { fr: ['ingénieur travaux'], de: ['bauingenieur'], es: ['ingeniero de obra'] },
  'project engineer': { fr: ['ingénieur projet', 'ingénieur de projet'], de: ['projektingenieur'], nl: ['projectingenieur'], es: ['ingeniero de proyecto'], it: ['ingegnere di progetto'] },
  'electrical engineer': { fr: ['ingénieur électricien', 'ingénieur électrique'], de: ['elektroingenieur'], nl: ['elektrotechnisch ingenieur'], es: ['ingeniero eléctrico'], it: ['ingegnere elettrico'] },
  'power engineer': { fr: ['ingénieur électrotechnique'], de: ['ingenieur energietechnik'], es: ['ingeniero de potencia'] },
  'substation engineer': { fr: ['ingénieur postes électriques'], de: ['ingenieur umspannwerk'], es: ['ingeniero de subestaciones'] },
  'grid engineer': { fr: ['ingénieur réseau électrique'], de: ['netzingenieur'], es: ['ingeniero de redes eléctricas'] },
  'civil engineer': { fr: ['ingénieur génie civil'], de: ['bauingenieur'], nl: ['civiel ingenieur'], es: ['ingeniero civil'], it: ['ingegnere civile'] },
  'structural engineer': { fr: ['ingénieur structure'], de: ['tragwerksplaner', 'statiker'], es: ['ingeniero de estructuras'], it: ['ingegnere strutturista'] },
  'mechanical engineer': { fr: ['ingénieur mécanique'], de: ['maschinenbauingenieur'], nl: ['werktuigbouwkundig ingenieur'], es: ['ingeniero mecánico'], it: ['ingegnere meccanico'] },
  'commissioning engineer': { fr: ['ingénieur mise en service'], de: ['inbetriebnahmeingenieur'], es: ['ingeniero de puesta en marcha'], it: ['ingegnere di commissioning'] },
  'commissioning manager': { fr: ['responsable mise en service'], de: ['inbetriebnahmeleiter'], es: ['jefe de puesta en marcha'] },
  'health and safety manager': { fr: ['responsable hse', 'responsable qhse'], de: ['fachkraft für arbeitssicherheit'], es: ['responsable de seguridad y salud'] },
  'hse manager': { fr: ['responsable hse'], de: ['hse manager'], es: ['responsable hse'] },
  'quality manager': { fr: ['responsable qualité'], de: ['qualitätsmanager'], nl: ['kwaliteitsmanager'], es: ['responsable de calidad'], it: ['responsabile qualità'] },
  'planner': { fr: ['planificateur'], de: ['terminplaner'], nl: ['planner'], es: ['planificador'] },
  'project planner': { fr: ['planificateur projet'], de: ['projektplaner'], es: ['planificador de proyectos'] },
  'quantity surveyor': { fr: ['économiste de la construction'], de: ['kalkulator'], es: ['aparejador'] },
  'estimator': { fr: ['chiffreur'], de: ['kalkulator'], es: ['estimador'] },
  'operations manager': { fr: ['responsable des opérations'], de: ['betriebsleiter'], es: ['jefe de operaciones'] },
  'electrician': { fr: ['électricien'], de: ['elektriker'], nl: ['elektricien'], es: ['electricista'], it: ['elettricista'] },
  'facilities manager': { fr: ['responsable services généraux'], de: ['facility manager'], es: ['responsable de mantenimiento'] },
  'nurse': { fr: ['infirmier', 'infirmière'], de: ['pflegefachkraft'], nl: ['verpleegkundige'], es: ['enfermero', 'enfermera'], it: ['infermiere'] },
  'registered nurse': { fr: ['infirmier', 'infirmière'], de: ['pflegefachkraft'], nl: ['verpleegkundige'], es: ['enfermero', 'enfermera'], it: ['infermiere'] },
  'healthcare assistant': { fr: ['aide-soignant', 'aide-soignante'], de: ['pflegehelfer'], es: ['auxiliar de enfermería'] },
};

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (p: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(fold(p)).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'u');

/** The local-language titles to search for an English title in a country (none when unknown). */
export function localTitles(title: string, country: string): string[] {
  const t = TITLE_TRANSLATIONS[title.toLowerCase()];
  if (!t) return [];
  const out: string[] = [];
  for (const lang of COUNTRY_LANGUAGES[country.toUpperCase()] ?? []) for (const local of t[lang] ?? []) if (local !== title.toLowerCase() && !out.includes(local)) out.push(local);
  return out;
}

/** The English titles a job title is a translation of: "Ingénieur électricien H/F" -> ["electrical engineer"]. */
export function englishTitlesOf(jobTitle: string): string[] {
  const t = fold(jobTitle);
  const hits: { en: string; local: string }[] = [];
  for (const [en, langs] of Object.entries(TITLE_TRANSLATIONS)) {
    const local = Object.values(langs).flatMap((list) => list ?? []).filter((l) => phrase(l).test(t)).sort((a, b) => b.length - a.length)[0];
    if (local) hits.push({ en, local: fold(local) });
  }
  // "ingénieur électricien" is an electrical engineer, not also an "électricien".
  return hits.filter((h) => !hits.some((o) => o.local !== h.local && o.local.includes(h.local))).map((h) => h.en);
}

/** Does the CV show the English title that this local-language job title translates? */
export function cvShowsTranslatedTitle(jobTitle: string, cvText: string): boolean {
  const cv = fold(cvText);
  return englishTitlesOf(jobTitle).some((en) => phrase(en).test(cv));
}
