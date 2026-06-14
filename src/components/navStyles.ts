import type { CSSProperties } from 'react';

/**
 * Shared style for the small icon buttons in the top navbar (the `?` shortcuts
 * button, the `⤢` fullscreen button, and the Install button). Lifted out of
 * App.tsx so InstallButton can reuse the exact same look.
 */
export const navIconBtn: CSSProperties = {
  background: 'transparent', border: '1px solid var(--color-widget-border)',
  borderRadius: 'var(--radius-md)', color: 'var(--color-text-secondary)',
  width: 28, height: 24, cursor: 'pointer', fontSize: 'var(--font-sm)', lineHeight: 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};
