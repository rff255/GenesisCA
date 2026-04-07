import { useCallback, useState } from 'react';
import { ActivityBar, type PanelId } from './ActivityBar';
import { PanelShell } from './PanelShell';
import { PropertiesPanelContent } from './panels/PropertiesPanelContent';
import { AttributesPanelContent } from './panels/AttributesPanelContent';
import { NeighborhoodsPanelContent } from './panels/NeighborhoodsPanelContent';
import { MappingsPanelContent } from './panels/MappingsPanelContent';
import { GraphEditor } from './vpl/GraphEditor';
import styles from './ModelerView.module.css';

const panelTitles: Record<PanelId, string> = {
  properties: 'Properties',
  attributes: 'Attributes',
  neighborhoods: 'Neighborhoods',
  mappings: 'Mappings',
};

const panelComponents: Record<PanelId, React.ComponentType> = {
  properties: PropertiesPanelContent,
  attributes: AttributesPanelContent,
  neighborhoods: NeighborhoodsPanelContent,
  mappings: MappingsPanelContent,
};

export function ModelerView() {
  const [activePanel, setActivePanel] = useState<PanelId | null>('properties');

  const handleTogglePanel = useCallback((panel: PanelId) => {
    setActivePanel(prev => (prev === panel ? null : panel));
  }, []);

  const handleClosePanel = useCallback(() => {
    setActivePanel(null);
  }, []);

  const PanelContent = activePanel ? panelComponents[activePanel] : null;

  return (
    <div className={styles.modelerLayout}>
      <ActivityBar activePanel={activePanel} onTogglePanel={handleTogglePanel} />
      {activePanel && PanelContent && (
        <PanelShell title={panelTitles[activePanel]} onClose={handleClosePanel}>
          <PanelContent />
        </PanelShell>
      )}
      <div className={styles.graphArea}>
        <GraphEditor />
      </div>
    </div>
  );
}
