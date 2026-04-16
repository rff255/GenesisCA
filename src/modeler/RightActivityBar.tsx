import type { ReactElement } from 'react';
import styles from './ActivityBar.module.css';

export type RightPanelId = 'explorer' | 'palette';

interface RightActivityBarProps {
  activePanel: RightPanelId | null;
  onTogglePanel: (panel: RightPanelId) => void;
}

const panels: Array<{ id: RightPanelId; label: string; icon: ReactElement }> = [
  {
    id: 'explorer',
    label: 'Node Explorer',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
  },
  {
    id: 'palette',
    label: 'Palette',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <line x1="17.5" y1="14" x2="17.5" y2="21" />
        <line x1="14" y1="17.5" x2="21" y2="17.5" />
      </svg>
    ),
  },
];

export function RightActivityBar({ activePanel, onTogglePanel }: RightActivityBarProps) {
  return (
    <div className={styles.activityBar} style={{ borderRight: 'none', borderLeft: '1px solid #2d4059' }}>
      {panels.map(({ id, label, icon }) => (
        <button
          key={id}
          className={`${styles.button} ${activePanel === id ? `${styles.buttonActive} ${styles.buttonActiveRight}` : ''}`}
          onClick={() => onTogglePanel(id)}
          title={label}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
