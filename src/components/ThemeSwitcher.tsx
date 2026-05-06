/**
 * ThemeSwitcher — small <select> in the navbar that lets the user pick a
 * theme. Drives the html[data-theme="…"] attribute and persists the choice
 * to localStorage. The initial value is read by the boot script in
 * index.html so the page paints in the right theme on first frame.
 */

import { useEffect, useState } from 'react';
import styles from './ThemeSwitcher.module.css';

export type ThemeName = 'default-generic' | 'blender';

const STORAGE_KEY = 'genesisca_theme';

const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'blender', label: 'Blender' },
  { value: 'default-generic', label: 'Default Generic' },
];

function readInitialTheme(): ThemeName {
  // The boot script already set the attribute; trust it.
  const fromAttr = (document.documentElement.dataset.theme || '') as ThemeName;
  if (fromAttr === 'blender' || fromAttr === 'default-generic') return fromAttr;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'blender' || v === 'default-generic') return v;
  } catch {}
  return 'blender';
}

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeName>(readInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {}
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
