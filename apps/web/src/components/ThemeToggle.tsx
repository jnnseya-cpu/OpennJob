'use client';

import { useEffect, useState } from 'react';

type Theme = 'auto' | 'light' | 'dark';
const NEXT: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' };
const LABEL: Record<Theme, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };

/** Light, Dark, or Auto (the device's setting). Kept in this browser only: a display preference, nothing personal. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('auto');

  useEffect(() => {
    const t = document.documentElement.getAttribute('data-theme');
    setTheme(t === 'light' || t === 'dark' ? t : 'auto');
  }, []);

  function cycle() {
    const next = NEXT[theme];
    setTheme(next);
    if (next === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    try {
      if (next === 'auto') window.localStorage.removeItem('opennjob.theme');
      else window.localStorage.setItem('opennjob.theme', next);
    } catch {
      // storage refused: the choice lasts for this page only
    }
  }

  return (
    <button type="button" className={className ?? 'iconlink theme'} onClick={cycle} aria-label={`Theme: ${LABEL[theme]}. Change theme`} data-testid="theme-toggle">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M12 3a9 9 0 1 0 9 9A7 7 0 0 1 12 3z" fill="currentColor" />
      </svg>
      {LABEL[theme]}
    </button>
  );
}
