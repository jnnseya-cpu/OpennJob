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
  { id: 'local-fixture', label: 'Fictional test forms (127.0.0.1)', hosts: ['127.0.0.1', 'localhost'], testOnly: true },
];

/** Evidence the operator records before a system is enabled. */
export interface ApplicationSystemSetting {
  enabled: boolean;
  termsCheckedAt?: string;
  supervisedSubmissionAt?: string;
  note?: string;
}

export function applicationSystemFor(url: string): ApplicationSystem | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return APPLICATION_SYSTEMS.find((s) => s.hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h)));
}

/** The wording a person agrees to when they turn on standing authorisation (APP-2, scope per OD-1). */
export const STANDING_SCOPE_VERSION = 'od1-2026-10-06';
export const STANDING_SCOPE_TEXT = [
  'OpennJob may send applications for me, without asking each time, when all of these are true:',
  'the job is inside my preferences and scores at least 80% against my CV;',
  'every sentence of the documents traces to my CV;',
  'the form has no declaration and no other sensitive question;',
  'every required question has an answer I stored myself;',
  "the site's application system has been enabled by the operator after a supervised test;",
  "today's limit has not been reached.",
  'Anything else waits for me. I can pause or turn this off at any time, and it stops before the next submission.',
].join(' ');
