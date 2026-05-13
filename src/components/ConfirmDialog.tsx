import { useEffect, useRef } from 'react';
import styles from './SaveProjectDialog.module.css';

export interface ConfirmDialogProps {
  title: string;
  /** Body text. Single string keeps the call sites concise; pass JSX via `body` for richer content. */
  message?: string;
  body?: React.ReactNode;
  /** Default "OK". Made primary action color. */
  confirmLabel?: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** When true, the primary button uses the destructive (red) style instead of accent. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Generic in-app confirmation modal that mirrors SaveProjectDialog's styling
 *  (backdrop + centered card + Cancel/primary actions). Used to replace native
 *  `window.confirm` so the UI stays consistent with the rest of the app and
 *  doesn't block the page on systems where the native dialog can freeze the
 *  preview iframe. */
export function ConfirmDialog({
  title, message, body, confirmLabel = 'OK', cancelLabel = 'Cancel',
  danger = false, onConfirm, onCancel,
}: ConfirmDialogProps) {
  // Auto-focus the confirm button so Enter submits, Escape cancels.
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onConfirm, onCancel]);

  return (
    <div className={styles.backdrop} onClick={onCancel}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>{title}</div>
        <div className={styles.body}>
          {body ?? (message && <div>{message}</div>)}
        </div>
        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onCancel}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={styles.btnPrimary}
            onClick={onConfirm}
            style={danger ? { background: 'var(--color-danger, #d32f2f)', borderColor: 'var(--color-danger, #d32f2f)', color: '#fff' } : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
