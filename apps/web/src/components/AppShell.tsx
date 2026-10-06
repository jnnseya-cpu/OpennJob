'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, isSignedIn, onSessionChange, takeNextPath } from '../lib/api';
import { PACKS } from '../lib/core';
import type { Application, Mode, PackId } from '../lib/types';

/** The threshold the API applies unless OPENNJOB_APPLY_THRESHOLD says otherwise. An agent run reports the real one. */
export const DEFAULT_THRESHOLD = 80;

export const MODE_HELP: Record<Mode, string> = {
  review: 'You see and confirm every field before anything is filled.',
  hybrid: 'The agent prepares every match at or above the threshold. You confirm declarations and submit yourself.',
  auto: 'The agent prepares every match at or above the threshold. The extension may submit a form only if it has no declaration or other sensitive field; any form that has one waits for you.',
};

const MODE_LABEL: Record<Mode, string> = { review: 'Review all', hybrid: 'Hybrid', auto: 'Auto' };

export type PackChoice = PackId | 'all';

interface AppState {
  mode: Mode;
  setMode(mode: Mode): void;
  pack: PackChoice;
  setPack(pack: PackChoice): void;
  threshold: number;
  setThreshold(n: number): void;
  agentMessage: string;
  setAgentMessage(text: string): void;
  waiting: number;
  unread: number;
  refreshWaiting(): void;
}

const AppContext = createContext<AppState | undefined>(undefined);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside AppShell');
  return ctx;
}

/** Per-viewer conveniences only (chosen mode and pack). Never personal data. */
function readPref(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage refused: the choice lasts for this page only
  }
}

const PUBLIC_PATHS = ['/signin', '/register'];
const TABS: [string, string][] = [
  ['/dashboard', 'Home'],
  ['/matches', 'Matches'],
  ['/tracker', 'Tracker'],
  ['/interview', 'Interview'],
  ['/profile', 'Profile'],
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = (usePathname() ?? '/').replace(/\/+$/, '') || '/';
  const router = useRouter();
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);
  const [mode, setModeState] = useState<Mode>('hybrid');
  const [pack, setPackState] = useState<PackChoice>('all');
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [agentMessage, setAgentMessage] = useState('');
  const [waiting, setWaiting] = useState(0);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const m = readPref('opennjob.mode');
    if (m === 'review' || m === 'hybrid' || m === 'auto') setModeState(m);
    const p = readPref('opennjob.pack');
    if (p === 'all' || PACKS.some((x) => x.id === p)) setPackState(p as PackChoice);
    const update = () => setSignedIn(isSignedIn());
    update();
    return onSessionChange(update);
  }, []);

  const isLanding = pathname === '/';
  const isPublic = PUBLIC_PATHS.includes(pathname);
  useEffect(() => {
    if (signedIn === undefined) return;
    if (!signedIn && !isPublic && !isLanding) router.replace(takeNextPath() ?? '/signin/');
    else if (signedIn && (isPublic || isLanding)) router.replace(takeNextPath() ?? '/dashboard/');
  }, [signedIn, isPublic, isLanding, pathname, router]);

  const refreshWaiting = useCallback(() => {
    if (!isSignedIn()) return;
    api<Application[]>('/applications')
      .then((apps) => setWaiting(apps.filter((a) => a.status === 'draft').length))
      .catch(() => undefined);
    api<{ unread: number }>('/notifications')
      .then((n) => setUnread(n.unread))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (signedIn) refreshWaiting();
  }, [signedIn, pathname, refreshWaiting]);

  const state = useMemo<AppState>(
    () => ({
      mode,
      setMode: (m) => {
        setModeState(m);
        writePref('opennjob.mode', m);
      },
      pack,
      setPack: (p) => {
        setPackState(p);
        writePref('opennjob.pack', p);
      },
      threshold,
      setThreshold,
      agentMessage,
      setAgentMessage,
      waiting,
      unread,
      refreshWaiting,
    }),
    [mode, pack, threshold, agentMessage, waiting, unread, refreshWaiting],
  );

  if (isLanding && signedIn === false) return <AppContext.Provider value={state}>{children}</AppContext.Provider>;

  // Until the session is known, and while a redirect is pending, show nothing personal.
  const showPage = signedIn !== undefined && (isPublic ? !signedIn : signedIn && pathname !== '/');
  const current = pathname.startsWith('/review') ? '/matches' : pathname;

  return (
    <AppContext.Provider value={state}>
      <div className="wrap">
        <header className="top">
          <div className="brand">
            <b>
              Openn<i>Job</i>
            </b>
            <span className="muted small grow">Six industry packs · UK and worldwide</span>
            {signedIn && !isPublic ? (
              <span className="row" style={{ gap: 4 }}>
                <Link href="/notifications/" className="iconlink" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-current={pathname === '/notifications' ? 'page' : undefined}>
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.6L4.3 15.4A1 1 0 0 0 5.2 17h13.6a1 1 0 0 0 .9-1.6L18 12.6V9a6 6 0 0 0-6-6zm0 19a2.5 2.5 0 0 0 2.4-2h-4.8A2.5 2.5 0 0 0 12 22z" fill="currentColor" /></svg>
                  {unread > 0 ? <span className="count">{unread}</span> : null}
                </Link>
                <Link href="/account/" className="iconlink" aria-current={pathname === '/account' ? 'page' : undefined}>
                  Account
                </Link>
              </span>
            ) : null}
          </div>
          {signedIn && !isPublic ? (
            <>
              <select className="pack" aria-label="Industry pack" value={pack} onChange={(e) => state.setPack(e.target.value as PackChoice)}>
                <option value="all">All industry packs</option>
                {PACKS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <div className="seg" role="group" aria-label="How much the agent does alone">
                {(['review', 'hybrid', 'auto'] as Mode[]).map((m) => (
                  <button key={m} type="button" aria-pressed={mode === m} onClick={() => state.setMode(m)}>
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
              <p className="small muted" data-testid="mode-help">
                {MODE_HELP[mode]}
              </p>
            </>
          ) : null}
        </header>
        <main>{showPage ? children : <p className="muted small">Loading…</p>}</main>
      </div>
      {signedIn && !isPublic ? (
        <nav className="tabs" aria-label="Sections">
          <div>
            {TABS.map(([href, label]) => (
              <Link key={href} href={`${href}/`} aria-current={current === href ? 'page' : undefined}>
                {label}
                {href === '/tracker' && waiting > 0 ? (
                  <span className="count" aria-label={`${waiting} waiting`}>
                    {waiting}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        </nav>
      ) : null}
    </AppContext.Provider>
  );
}
