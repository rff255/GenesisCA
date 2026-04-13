import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ActivityBar, type PanelId } from './ActivityBar';
import { PanelShell } from './PanelShell';
import { PropertiesPanelContent } from './panels/PropertiesPanelContent';
import { AttributesPanelContent } from './panels/AttributesPanelContent';
import { NeighborhoodsPanelContent } from './panels/NeighborhoodsPanelContent';
import { MappingsPanelContent } from './panels/MappingsPanelContent';
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

export function ModelerView() {
  const [activePanel, setActivePanel] = useState<PanelId | null>('properties');
  const [explorerOpen, setExplorerOpen] = useState(false);
  const explorerRef = useRef<NodeExplorerHandle>(null);

  const handleTogglePanel = useCallback((panel: PanelId) => {
    setActivePanel(prev => (prev === panel ? null : panel));
  }, []);

  const handleClosePanel = useCallback(() => {
    setActivePanel(null);
  }, []);

  // Ctrl+F opens Node Explorer and focuses search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        const tag = (document.activeElement as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        setExplorerOpen(true);
        setTimeout(() => explorerRef.current?.focusSearch(), 50);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

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
          <button
            className={`${styles.explorerToggle} ${explorerOpen ? styles.explorerToggleActive : ''}`}
            onClick={() => setExplorerOpen(v => !v)}
            title="Node Explorer"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
        </div>
        {explorerOpen && (
          <PanelShell title="Node Explorer" onClose={() => setExplorerOpen(false)} side="right">
            <NodeExplorer ref={explorerRef} />
          </PanelShell>
        )}
      </div>
    </ReactFlowProvider>
  );
}
