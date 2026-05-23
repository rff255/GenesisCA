import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './SaveProjectDialog.module.css';

interface Props {
  title: string;
  /** Optional label shown above the input. */
  fieldLabel?: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel?: string;
  /** When false (default), the confirm button is disabled while the field is blank. */
  allowEmpty?: boolean;
  /** Viewport point (screen px) to center the dialog around — where the user clicked. */
  anchorX: number;
  anchorY: number;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

/**
 * Small in-app name-entry dialog used in place of native window.prompt().
 * Reuses the Save Project dialog's card styling, but floats anchored at the
 * click point (no screen dim — popover feel) and pre-selects the field text so
 * a rename is one keystroke away.
 */
export function NameInputDialog({
  title,
  fieldLabel,
  initialValue,
  placeholder,
  confirmLabel = 'OK',
  allowEmpty = false,
  anchorX,
  anchorY,
  onConfirm,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const canConfirm = allowEmpty || value.trim().length > 0;
  const submit = () => {
    if (allowEmpty || value.trim().length > 0) onConfirm(value.trim());
  };

  // Pre-fill + select-all once the card is positioned (and thus visible) so the
  // focus lands on a rendered element — focusing while still visibility:hidden
  // (the pre-measure frame) silently no-ops in the browser.
  useEffect(() => {
    if (!pos) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [pos]);

  // Center the card on the anchor, clamped to the viewport.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(anchorX - rect.width / 2, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(anchorY - rect.height / 2, window.innerHeight - rect.height - margin));
    setPos({ left, top });
  }, [anchorX, anchorY]);

  // Enter confirms (when valid), Escape cancels.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (allowEmpty || value.trim().length > 0) onConfirm(value.trim());
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [value, allowEmpty, onConfirm, onCancel]);

  return (
    <div className={styles.backdrop} style={{ background: 'transparent' }} onClick={onCancel}>
      <div
        ref={cardRef}
        className={styles.dialog}
        style={{
          position: 'fixed',
          width: 320,
          left: pos?.left ?? anchorX,
          top: pos?.top ?? anchorY,
          visibility: pos ? 'visible' : 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className={styles.title}>{title}</div>
        <div className={styles.body}>
          <div>
            {fieldLabel && <div className={styles.rowLabel} style={{ marginBottom: 6 }}>{fieldLabel}</div>}
            <input
              ref={inputRef}
              type="text"
              value={value}
              placeholder={placeholder}
              onChange={e => setValue(e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                background: 'var(--color-bg-canvas)',
                border: '1px solid var(--color-widget-border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-sm)',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={styles.btnPrimary} disabled={!canConfirm} onClick={submit}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
