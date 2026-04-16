import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ActivityBar, type PanelId } from './ActivityBar';
import { RightActivityBar, type RightPanelId } from './RightActivityBar';
import { PanelShell } from './PanelShell';
import { PropertiesPanelContent } from './panels/PropertiesPanelContent';
import { AttributesPanelContent } from './panels/AttributesPanelContent';
import { NeighborhoodsPanelContent } from './panels/NeighborhoodsPanelContent';
import { MappingsPanelContent } from './panels/MappingsPanelContent';
import { PalettePanelContent } from './panels/PalettePanelContent';
import { GraphEditorInner } from './vpl/GraphEditor';
import { NodeExplorer } from './vpl/NodeExplorer';
import type { NodeExplorerHandle } from './vpl/NodeExplorer';
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

const rightPanelTitles: Record<RightPanelId, string> = {
  explorer: 'Node Explorer',
  palette: 'Palette',
};

export function ModelerView() {
  const [activePanel, setActivePanel] = useState<PanelId | null>('properties');
  const [activeRightPanel, setActiveRightPanel] = useState<RightPanelId | null>(null);
  // Remembered last-opened right panel — used by the floating graph-area toggle to reopen
  // whatever the user had open before closing it. Defaults to 'palette'.
  const [lastRightPanel, setLastRightPanel] = useState<RightPanelId>('palette');
  const explorerRef = useRef<NodeExplorerHandle>(null);

  const handleTogglePanel = useCallback((panel: PanelId) => {
    setActivePanel(prev => (prev === panel ? null : panel));
  }, []);

  const handleClosePanel = useCallback(() => {
    setActivePanel(null);
  }, []);

  const handleToggleRightPanel = useCallback((panel: RightPanelId) => {
    setActiveRightPanel(prev => (prev === panel ? null : panel));
    setLastRightPanel(panel);
  }, []);

  const handleCloseRightPanel = useCallback(() => {
    setActiveRightPanel(null);
  }, []);

  const handleOpenLastRightPanel = useCallback(() => {
    setActiveRightPanel(lastRightPanel);
  }, [lastRightPanel]);

  // Ctrl+F opens Node Explorer and focuses search; Esc closes it
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        const tag = (document.activeElement as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        setActiveRightPanel('explorer');
        setTimeout(() => explorerRef.current?.focusSearch(), 50);
      } else if (e.key === 'Escape' && activeRightPanel) {
        // Don't steal Esc from fields (e.g. clearing the search input first)
        const tag = (document.activeElement as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        setActiveRightPanel(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeRightPanel]);

  const PanelContent = activePanel ? panelComponents[activePanel] : null;

  return (
    <ReactFlowProvider>
      <div className={styles.modelerLayout}>
        <ActivityBar activePanel={activePanel} onTogglePanel={handleTogglePanel} />
        {activePanel && PanelContent && (
          <PanelShell title={panelTitles[activePanel]} onClose={handleClosePanel}>
            <PanelContent />
          </PanelShell>
        )}
        <div className={styles.graphArea}>
          <GraphEditorInner />
          {!activeRightPanel && (
            <button
              className={styles.rightPanelExpandBtn}
              onClick={handleOpenLastRightPanel}
              title={`Open ${rightPanelTitles[lastRightPanel]}`}
            >
              &lsaquo;
            </button>
          )}
        </div>
        {activeRightPanel && (
          <PanelShell
            title={rightPanelTitles[activeRightPanel]}
            onClose={handleCloseRightPanel}
            side="right"
          >
            {activeRightPanel === 'explorer' ? (
              <NodeExplorer ref={explorerRef} />
            ) : (
              <PalettePanelContent />
            )}
          </PanelShell>
        )}
        <RightActivityBar activePanel={activeRightPanel} onTogglePanel={handleToggleRightPanel} />
      </div>
    </ReactFlowProvider>
  );
}
