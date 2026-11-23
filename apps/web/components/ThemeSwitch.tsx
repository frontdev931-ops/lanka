'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';

// The workspace theme: light by default, dark on the person's choice. Kept in this browser only (a per-viewer convenience); the root layout
// applies it before the first paint (THEME_BOOT in app/layout.tsx). A plain switch with a sun and a moon, no words; the label is for screen readers.
const KEY = 'lanka_theme';
type Theme = 'light' | 'dark';

function apply(theme: Theme) {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    let saved: Theme = 'light';
    try {
      saved = window.localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
    } catch {
      // no storage: the light theme
    }
    setTheme(saved);
    apply(saved);
    // leaving the workspace (the landing, a public page): their own look again
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, []);
  const set = (t: Theme) => {
    setTheme(t);
    apply(t);
    try {
      window.localStorage.setItem(KEY, t);
    } catch {
      // not remembered, the switch still works on this page
    }
  };
  return [theme, set];
}

const SUN = 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4';
const MOON = 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z';
const Glyph = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

// compact: one icon button (the phone's header); otherwise a small track with the sun and the moon and a moving knob
export function ThemeSwitch({ theme, onChange, compact }: { theme: Theme; onChange: (t: Theme) => void; compact?: boolean }) {
  const { t } = useI18n();
  const dark = theme === 'dark';
  if (compact)
    return (
      <button type="button" className="theme-icon" role="switch" aria-checked={dark} aria-label={t('theme.dark')} title={t('theme.dark')} onClick={() => onChange(dark ? 'light' : 'dark')}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={dark ? SUN : MOON} /></svg>
      </button>
    );
  return (
    <button type="button" className={`theme-switch${dark ? ' dark' : ''}`} role="switch" aria-checked={dark} aria-label={t('theme.dark')} title={t('theme.dark')} onClick={() => onChange(dark ? 'light' : 'dark')}>
      <span className="theme-track" aria-hidden="true">
        <Glyph d={SUN} />
        <Glyph d={MOON} />
        <span className="theme-knob"><Glyph d={dark ? MOON : SUN} /></span>
      </span>
    </button>
  );
}
