/**
 * Application systems the queue may submit to (APP-9). Each one is OFF until the operator
 * records, for that system, (a) that its terms of use were checked and allow it, and
 * (b) one supervised real submission that succeeded. Until then the queue holds its
 * applications for the person. None has been enabled against a real employer yet.
 */
export interface ApplicationSystem {
  id: string;
  label: string;
  /** Host names (exact, or a parent domain written with a leading dot). */
  hosts: readonly string[];
  /** Only for the fictional forms in the tests. The API refuses to enable it in production. */
  testOnly?: boolean;
}

export const APPLICATION_SYSTEMS: readonly ApplicationSystem[] = [
  { id: 'greenhouse', label: 'Greenhouse', hosts: ['boards.greenhouse.io', 'job-boards.greenhouse.io'] },
  { id: 'lever', label: 'Lever', hosts: ['jobs.lever.co', 'jobs.eu.lever.co'] },
  { id: 'ashby', label: 'Ashby', hosts: ['jobs.ashbyhq.com'] },
  { id: 'workable', label: 'Workable', hosts: ['apply.workable.com'] },
  // Workday: every employer has its own tenant, e.g. example.wd3.myworkdayjobs.com. Multi-step
  // (My Information, My Experience, Application Questions, Voluntary Disclosures, Review); the
  // extension's step engine drives it (apps/extension/src/agent/steps.ts).
  { id: 'workday', label: 'Workday', hosts: ['.myworkdayjobs.com', '.myworkdaysite.com', '.myworkday.com'] },
  // SAP SuccessFactors Recruiting: career sites on SAP hosts, and often on the employer's own
  // domain (e.g. a jobs.<employer> address): the operator adds those as extra hosts.
  { id: 'successfactors', label: 'SAP SuccessFactors', hosts: ['.successfactors.com', '.successfactors.eu', '.sapsf.com', '.sapsf.eu', '.jobs2web.com'] },
  { id: 'local-fixture', label: 'Fictional test forms (127.0.0.1)', hosts: ['127.0.0.1', 'localhost'], testOnly: true },
];

/** Evidence the operator records before a system is enabled. */
export interface ApplicationSystemSetting {
  enabled: boolean;
  /** The employer's own domains that run this system, e.g. "jobs.example.org" (exact host names). */
  extraHosts?: string[];
  termsCheckedAt?: string;
  supervisedSubmissionAt?: string;
  note?: string;
}

/**
 * The application system a URL belongs to: by its own hosts, or by the extra hosts the operator
 * recorded for a system (an employer's own domain running Workday or SuccessFactors).
 */
export function applicationSystemFor(url: string, extraHosts: Readonly<Record<string, readonly string[]>> = {}): ApplicationSystem | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return (
    APPLICATION_SYSTEMS.find((s) => s.hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h))) ??
    APPLICATION_SYSTEMS.find((s) => (extraHosts[s.id] ?? []).some((h) => host === h.toLowerCase()))
  );
}

/**
 * The wording a person agrees to when they turn on standing authorisation (APP-2, scope per OD-1,
 * right to work per OD-5). A new version means consent to the old one no longer counts.
 */
export const STANDING_SCOPE_VERSION = 'od5-email-2026-10-06';
export const STANDING_SCOPE_TEXT = [
  'OpennJob may send applications for me, without asking each time, when all of these are true:',
  'the job is inside my preferences and scores at least 80% against my CV;',
  'every sentence of the documents traces to my CV;',
  "today's limit has not been reached;",
  'and either (by e-mail) the advert gives a recruiter\'s e-mail address, and OpennJob e-mails my tailored CV as a PDF and my supporting statement there, in my name, with replies coming to my own e-mail address;',
  'or (on a form) the form has no declaration and no other sensitive question, except "Do you have the right to work in this country?" and "Will you need visa sponsorship?", which OpennJob answers from the right-to-work record I keep in my Profile for that country;',
  "every required question has an answer I stored myself; and the site's application system has been enabled by the operator after a supervised test.",
  'Anything else waits for me. I can pause or turn this off at any time, and it stops before the next submission.',
].join(' ');
