/**
 * The only way the web app talks to the API.
 *
 * - The API address comes from `/opennjob-config.json` next to the site (written by whoever
 *   deploys it), else NEXT_PUBLIC_OPENNJOB_API_BASE at build time, else http://127.0.0.1:3000.
 * - The access token is kept in sessionStorage: it goes when the tab closes. The password
 *   is never stored.
 * - Nothing here logs anything. Error messages shown to the user come from the API's own
 *   wording (which never repeats submitted values) or from this file.
 */

const SESSION_KEY = 'opennjob.session';
const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_OPENNJOB_API_BASE ?? 'http://127.0.0.1:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Session {
  accessToken: string;
  expiresAt: string;
}

let basePromise: Promise<string> | undefined;

export function apiBase(): Promise<string> {
  basePromise ??= fetch('/opennjob-config.json', { cache: 'no-store' })
    .then((r): Promise<{ apiBase?: unknown }> | { apiBase?: unknown } => (r.ok ? (r.json() as Promise<{ apiBase?: unknown }>) : {}))
    .then((c) => (typeof c.apiBase === 'string' && c.apiBase.trim() ? c.apiBase.trim().replace(/\/+$/, '') : DEFAULT_API_BASE))
    .catch(() => DEFAULT_API_BASE);
  return basePromise;
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function getSession(): Session | undefined {
  try {
    const raw = storage()?.getItem(SESSION_KEY);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as Partial<Session>;
    if (typeof s.accessToken !== 'string' || typeof s.expiresAt !== 'string') return undefined;
    if (Date.parse(s.expiresAt) <= Date.now()) {
      clearSession('/signin/?notice=expired');
      return undefined;
    }
    return { accessToken: s.accessToken, expiresAt: s.expiresAt };
  } catch {
    return undefined;
  }
}

let nextPath: string | undefined;

/** Where the app goes once signed in or out (the shell reads it once). */
export function takeNextPath(): string | undefined {
  const p = nextPath;
  nextPath = undefined;
  return p;
}

export function setSession(session: Session, next?: string): void {
  nextPath = next;
  try {
    storage()?.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage refused (private window, blocked site data): the session lasts for this page only.
  }
  memorySession = session;
  notify();
}

export function clearSession(next?: string): void {
  nextPath = next;
  try {
    storage()?.removeItem(SESSION_KEY);
  } catch {
    // nothing to remove
  }
  memorySession = undefined;
  notify();
}

let memorySession: Session | undefined;
const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}
export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentSession(): Session | undefined {
  const s = getSession() ?? memorySession;
  if (s && Date.parse(s.expiresAt) <= Date.now()) return undefined;
  return s;
}

/** Turns an API error body into one plain sentence. Validation problems name the field, never its value. */
function messageOf(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; issues?: unknown };
    if (Array.isArray(b.issues) && b.issues.length) {
      const parts = b.issues
        .filter((i): i is { path: string; message: string } => typeof i === 'object' && i !== null && typeof (i as { message?: unknown }).message === 'string')
        .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
      if (parts.length) return `Please check: ${parts.join('; ')}.`;
    }
    if (Array.isArray(b.message)) return b.message.filter((m) => typeof m === 'string').join(' ');
    if (typeof b.message === 'string' && b.message) return b.message;
  }
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (status >= 500) return 'The OpennJob service had a problem. Try again later.';
  return `The request was refused (${status}).`;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** false for the public routes (sign in, register, versions). */
  auth?: boolean;
  /** A 401 here means a wrong password, not an ended session (DELETE /account). */
  passwordCheck?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, passwordCheck = false } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const session = currentSession();
    if (!session) {
      clearSession('/signin/?notice=expired');
      throw new ApiError(401, 'Your session has ended. Sign in again.');
    }
    headers.Authorization = `Bearer ${session.accessToken}`;
  }
  const base = await apiBase();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'The OpennJob service could not be reached. Check your connection and try again.');
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && auth && !passwordCheck) {
      clearSession('/signin/?notice=expired');
      throw new ApiError(401, 'Your session has ended. Sign in again.');
    }
    throw new ApiError(res.status, messageOf(res.status, parsed));
  }
  return parsed as T;
}

export function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

export function isSignedIn(): boolean {
  return currentSession() !== undefined;
}
