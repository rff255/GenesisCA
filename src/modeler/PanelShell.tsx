import type { ReactNode } from 'react';
import styles from './PanelShell.module.css';

interface PanelShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function PanelShell({ title, onClose, children }: PanelShellProps) {
  return (
    <div className={styles.panelShell}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button className={styles.closeButton} onClick={onClose} title="Close panel">
          &times;
        </button>
      </div>
      <div className={styles.body}>
        {children}
      </div>
    </div>
  );
}
