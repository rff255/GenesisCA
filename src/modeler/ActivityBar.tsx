import styles from './ActivityBar.module.css';

export type PanelId = 'properties' | 'attributes' | 'neighborhoods' | 'mappings' | 'variegated';

interface ActivityBarProps {
  activePanel: PanelId | null;
  onTogglePanel: (panel: PanelId) => void;
}

const panels: Array<{ id: PanelId; label: string; icon: string }> = [
  { id: 'properties', label: 'Properties', icon: 'P' },
  { id: 'attributes', label: 'Attributes', icon: 'A' },
  { id: 'neighborhoods', label: 'Neighborhoods', icon: 'N' },
  { id: 'mappings', label: 'Mappings', icon: 'M' },
  // Variegated Cells — always visible; the panel renders an empty-state CTA
  // when the feature is off so users discover where to enable it.
  { id: 'variegated', label: 'Variegated Cells', icon: 'V' },
];

export function ActivityBar({ activePanel, onTogglePanel }: ActivityBarProps) {
  return (
    <div className={styles.activityBar}>
      {panels.map(({ id, label, icon }) => (
        <button
          key={id}
          className={`${styles.button} ${activePanel === id ? styles.buttonActive : ''}`}
          onClick={() => onTogglePanel(id)}
          title={label}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
