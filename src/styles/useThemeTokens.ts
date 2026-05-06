/**
 * useThemeTokens — read CSS custom properties from the document root and
 * re-render whenever the active theme changes.
 *
 * Used by canvas-rendered components (IndicatorSparkline, the multi-line and
 * stacked-area charts) that bake colours into the bitmap and so can't simply
 * reference var(--…) like CSS modules do. The hook subscribes to mutations on
 * <html data-theme="…"> so a theme swap re-runs the canvas paint with new
 * colour values.
 */

import { useEffect, useState, useMemo } from 'react';

function readTokens(names: readonly string[]): string[] {
  const cs = getComputedStyle(document.documentElement);
  return names.map(n => cs.getPropertyValue(n).trim());
}

export function useThemeTokens(names: readonly string[]): string[] {
  // Memoise the names list so identity is stable across renders even if the
  // caller passes a fresh array literal each time.
  const namesKey = names.join('|');
  const stableNames = useMemo(() => names, [namesKey]);
  const [values, setValues] = useState<string[]>(() => readTokens(stableNames));

  useEffect(() => {
    setValues(readTokens(stableNames));
    const observer = new MutationObserver(() => {
      setValues(readTokens(stableNames));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, [stableNames]);

  return values;
}
