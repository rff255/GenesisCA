import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { navIconBtn } from './navStyles';

// The browser's install-prompt event (not in the standard lib DOM types).
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

// Accent variant of the navbar icon button — the install affordance is meant to
// stand out when available (and is hidden entirely otherwise).
const installBtnStyle: CSSProperties = {
  ...navIconBtn,
  width: 'auto',
  gap: 5,
  padding: '0 9px',
  color: 'var(--color-accent)',
  borderColor: 'var(--color-accent)',
  background: 'var(--color-accent-soft)',
  fontWeight: 500,
};

/**
 * Navbar "Install" affordance. Captures the browser's `beforeinstallprompt`
 * (Chrome/Edge desktop + Android), shows the button only while the app is
 * installable, and fires the native install prompt on click. Self-hides once
 * the app is installed (`appinstalled`) or when the browser never offers an
 * install. See docs/IMPACT_MAP_PWA_INSTALL.md §A.5.
 */
export function InstallButton({ onInstalled }: { onInstalled?: () => void }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  // Keep the latest callback without re-subscribing the window listeners.
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // suppress the browser's mini-infobar; we drive it
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setDeferred(null);
      onInstalledRef.current?.();
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const handleClick = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null); // a deferred prompt can only be used once
  }, [deferred]);

  if (!deferred) return null;

  return (
    <button
      style={installBtnStyle}
      title="Install GenesisCA as an app"
      aria-label="Install GenesisCA"
      onClick={handleClick}
    >
      <span aria-hidden="true" style={{ fontSize: '0.95em' }}>⤓</span>
      Install
    </button>
  );
}
