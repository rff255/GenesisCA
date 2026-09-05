import type { ReactElement } from 'react';
import { useModel } from '../model/ModelContext';
import styles from './ActivityBar.module.css';

export type PanelId = 'info' | 'properties' | 'attributes' | 'neighborhoods' | 'mappings' | 'indicators' | 'variegated';

interface ActivityBarProps {
  activePanel: PanelId | null;
  onTogglePanel: (panel: PanelId) => void;
}

/** Shared SVG icon props — stroked, currentColor, rounded, like RightActivityBar. */
const svg = (children: ReactElement) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const ICONS: Record<PanelId, ReactElement> = {
  // Info — circle with an "i".
  info: svg(<><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" /></>),
  // Properties — cogwheel (settings). Toothed gear ring + centre hole.
  properties: svg(<><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>),
  // Attributes — a bulleted list.
  attributes: svg(<><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none" /></>),
  // Neighborhoods — a 3×3 grid of cells with the centre filled.
  neighborhoods: svg(<><rect x="4" y="4" width="16" height="16" rx="1.5" /><line x1="9.3" y1="4" x2="9.3" y2="20" /><line x1="14.6" y1="4" x2="14.6" y2="20" /><line x1="4" y1="9.3" x2="20" y2="9.3" /><line x1="4" y1="14.6" x2="20" y2="14.6" /><rect x="9.3" y="9.3" width="5.3" height="5.3" fill="currentColor" stroke="none" /></>),
  // Mappings — overlapping colour swatches.
  mappings: svg(<><rect x="4" y="4" width="11" height="11" rx="2" /><rect x="9" y="9" width="11" height="11" rx="2" fill="currentColor" fillOpacity="0.25" /></>),
  // Indicators — a line chart (a measured series over time).
  indicators: svg(<><polyline points="3,20 3,4" /><polyline points="3,20 21,20" /><polyline points="6,15 10,10 14,13 20,6" /></>),
  // Variegated — a compass needle (orientation).
  variegated: svg(<><circle cx="12" cy="12" r="9" /><polygon points="12,6 14.5,12 12,18 9.5,12" fill="currentColor" stroke="none" /></>),
};

const BASE_PANELS: Array<{ id: PanelId; label: string }> = [
  { id: 'info', label: 'Info' },
  { id: 'properties', label: 'Properties' },
  { id: 'attributes', label: 'Attributes' },
  { id: 'neighborhoods', label: 'Neighborhoods' },
  { id: 'mappings', label: 'Mappings' },
  { id: 'indicators', label: 'Indicators' },
];

export function ActivityBar({ activePanel, onTogglePanel }: ActivityBarProps) {
  const { model } = useModel();
  // Neighborhoods only apply to the lattice CA — hide the tab entirely for an
  // agents-only model (Grid Cells topology off). Variegated Cells tab is hidden
  // unless the feature is enabled (also grid-only). Auto-switching the active
  // panel when either flips off is handled by ModelerView; here we just elide
  // the buttons.
  const gridCellsOn = model.topologyMode?.gridCells !== false;
  const base = gridCellsOn
    ? BASE_PANELS
    : BASE_PANELS.filter(p => p.id !== 'neighborhoods');
  const panels = model.variegatedCells?.enabled
    ? [...base, { id: 'variegated' as PanelId, label: 'Variegated Cells' }]
    : base;
  return (
    <div className={styles.activityBar}>
      {panels.map(({ id, label }) => (
        <button
          key={id}
          className={`${styles.button} ${activePanel === id ? styles.buttonActive : ''}`}
          onClick={() => onTogglePanel(id)}
          title={label}
          aria-label={label}
        >
          {ICONS[id]}
        </button>
      ))}
    </div>
  );
}
