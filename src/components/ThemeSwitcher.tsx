/**
 * ThemeSwitcher — small <select> in the navbar that lets the user pick a
 * theme. Drives the html[data-theme="…"] attribute and persists the choice
 * to localStorage. The initial value is read by the boot script in
 * index.html so the page paints in the right theme on first frame.
 *
 * All theming is CSS-variable driven (src/styles/tokens.css), so switching is
 * instant for the whole DOM. Canvas-rendered charts re-read the variables on
 * their next redraw.
 */

import { useEffect, useState } from 'react';
import styles from './ThemeSwitcher.module.css';

export type ThemeName = 'blender' | 'nocturne';

export const THEME_STORAGE_KEY = 'genesisca_theme';

const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'blender', label: 'Blender' },
  { value: 'nocturne', label: 'Nocturne' },
];

const KNOWN = new Set<ThemeName>(THEME_OPTIONS.map(o => o.value));

function isTheme(v: string | null | undefined): v is ThemeName {
  return !!v && KNOWN.has(v as ThemeName);
}

function readInitialTheme(): ThemeName {
  // The boot script already set the attribute; trust it.
  const fromAttr = document.documentElement.dataset.theme;
  if (isTheme(fromAttr)) return fromAttr;
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(v)) return v;
  } catch { /* localStorage unavailable */ }
  return 'blender';
}

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeName>(readInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch { /* localStorage unavailable */ }
  }, [theme]);

  return (
    <label className={styles.wrapper} title="Theme">
      <span className={styles.label}>Theme</span>
      <select
        className={styles.select}
        value={theme}
        onChange={e => setTheme(e.target.value as ThemeName)}
      >
        {THEME_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
