import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const KEY = 'stackreel.theme';
const ThemeContext = createContext(null);

function readStored() {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; }
}
function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function apply(theme, animate) {
  const root = document.documentElement;
  if (animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 380);
  }
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }) {
  // index.html already applied the right theme before first paint; read it back.
  const [theme, setThemeState] = useState(() => document.documentElement.dataset.theme || readStored() || systemTheme());
  const [explicit, setExplicit] = useState(() => readStored() !== null);

  useEffect(() => { apply(theme, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow OS changes until the user picks a theme explicitly.
  useEffect(() => {
    if (explicit || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => { const t = mq.matches ? 'light' : 'dark'; apply(t, true); setThemeState(t); };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [explicit]);

  const setTheme = useCallback((t) => {
    apply(t, true);
    setThemeState(t);
    setExplicit(true);
    try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
  }, []);
  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

  const value = useMemo(() => ({ theme, isDark: theme === 'dark', setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
