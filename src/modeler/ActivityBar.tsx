import { useModel } from '../model/ModelContext';
import styles from './ActivityBar.module.css';

export type PanelId = 'properties' | 'attributes' | 'variables' | 'neighborhoods' | 'mappings' | 'variegated';

interface ActivityBarProps {
  activePanel: PanelId | null;
  onTogglePanel: (panel: PanelId) => void;
}

const BASE_PANELS: Array<{ id: PanelId; label: string; icon: string }> = [
  { id: 'properties', label: 'Properties', icon: 'P' },
  { id: 'attributes', label: 'Attributes', icon: 'A' },
  { id: 'variables', label: 'Local Variables', icon: 'L' },
  { id: 'neighborhoods', label: 'Neighborhoods', icon: 'N' },
  { id: 'mappings', label: 'Mappings', icon: 'M' },
];

export function ActivityBar({ activePanel, onTogglePanel }: ActivityBarProps) {
  const { model } = useModel();
  // Variegated Cells tab is hidden entirely unless the feature is enabled in
  // Properties. Auto-switching the active panel when the feature flips off
  // is handled by ModelerView; here we just elide the button.
  const panels = model.variegatedCells?.enabled
    ? [...BASE_PANELS, { id: 'variegated' as PanelId, label: 'Variegated Cells', icon: 'V' }]
    : BASE_PANELS;
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
