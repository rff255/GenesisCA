import styles from './ActivityBar.module.css';

export type PanelId = 'properties' | 'attributes' | 'neighborhoods' | 'mappings';

interface ActivityBarProps {
  activePanel: PanelId | null;
  onTogglePanel: (panel: PanelId) => void;
}

const panels: Array<{ id: PanelId; label: string; icon: string }> = [
  { id: 'properties', label: 'Properties', icon: 'P' },
  { id: 'attributes', label: 'Attributes', icon: 'A' },
  { id: 'neighborhoods', label: 'Neighborhoods', icon: 'N' },
  { id: 'mappings', label: 'Mappings', icon: 'M' },
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
