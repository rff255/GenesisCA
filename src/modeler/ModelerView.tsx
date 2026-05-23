import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useModel } from '../model/ModelContext';
import type { CAModel } from '../model/types';
import { ActivityBar, type PanelId } from './ActivityBar';
import { ModelerDetailContext, type ModelerDetailValue, type PanelContentProps } from './ModelerDetailContext';
import { RightActivityBar, type RightPanelId } from './RightActivityBar';
import { PanelShell } from './PanelShell';
import { PropertiesPanelContent } from './panels/PropertiesPanelContent';
import { AttributesPanelContent } from './panels/AttributesPanelContent';
import { NeighborhoodsPanelContent } from './panels/NeighborhoodsPanelContent';
import { MappingsPanelContent } from './panels/MappingsPanelContent';
import { VariablesPanelSection } from './panels/VariablesPanelSection';
import { PalettePanelContent } from './panels/PalettePanelContent';
import { VariegatedCellsPanelContent } from './panels/VariegatedCellsPanelContent';
import { GraphEditorInner } from './vpl/GraphEditor';
import { NodeExplorer } from './vpl/NodeExplorer';
import type { NodeExplorerHandle } from './vpl/NodeExplorer';
import styles from './ModelerView.module.css';

const panelTitles: Record<PanelId, string> = {
  properties: 'Properties',
  attributes: 'Attributes',
  variables: 'Local Variables',
  neighborhoods: 'Neighborhoods',
  mappings: 'Mappings',
  variegated: 'Variegated Cells',
};

const panelComponents: Record<PanelId, React.ComponentType<PanelContentProps>> = {
  properties: PropertiesPanelContent,
  attributes: AttributesPanelContent,
  variables: VariablesPanelSection,
  neighborhoods: NeighborhoodsPanelContent,
  mappings: MappingsPanelContent,
  variegated: VariegatedCellsPanelContent,
};

// Panels with a list + per-item editor. Their editor renders in a second left
// panel (the "detail" panel) so the user never scrolls past the list to reach it.
const MASTER_DETAIL_PANELS = new Set<PanelId>(['attributes', 'variables', 'neighborhoods', 'mappings']);

/** Display name of the active panel's selected item, or null if nothing is
 *  selected / the id no longer resolves (so the detail panel hides on delete). */
function selectedItemName(model: CAModel, panel: PanelId, id: string | null): string | null {
  if (!id) return null;
  if (panel === 'attributes') return model.attributes.find(a => a.id === id)?.name ?? null;
  if (panel === 'variables') return (model.variables ?? []).find(v => v.id === id)?.name ?? null;
  if (panel === 'neighborhoods') return model.neighborhoods.find(n => n.id === id)?.name ?? null;
  if (panel === 'mappings') return model.mappings.find(m => m.id === id)?.name ?? null;
  return null;
}

const rightPanelTitles: Record<RightPanelId, string> = {
  explorer: 'Node Explorer',
  palette: 'Palette',
};

export function ModelerView() {
  const { model } = useModel();
  const variegatedEnabled = !!model.variegatedCells?.enabled;
  const [activePanel, setActivePanel] = useState<PanelId | null>('properties');
  // When the user disables Variegated Cells while its panel is open, switch
  // the left panel to Properties (where the toggle lives). The ActivityBar
  // hides the V tab in this case so there'd be no way to dismiss the panel
  // otherwise. Also re-aim `lastLeftPanel` if it pointed at variegated.
  useEffect(() => {
    if (!variegatedEnabled && activePanel === 'variegated') setActivePanel('properties');
  }, [variegatedEnabled, activePanel]);
  const [activeRightPanel, setActiveRightPanel] = useState<RightPanelId | null>(null);
  // Remembered last-opened panels — used by the floating graph-area expand-ears
  // to reopen whatever the user had open before closing it.
  const [lastLeftPanel, setLastLeftPanel] = useState<PanelId>('properties');
  const [lastRightPanel, setLastRightPanel] = useState<RightPanelId>('palette');
  // Snapshot of panel state when entering F-fullscreen so the toggle restores
  // exactly what was open before (null entries are preserved as null).
  const prePanelStateRef = useRef<{ left: PanelId | null; right: RightPanelId | null } | null>(null);
  const explorerRef = useRef<NodeExplorerHandle>(null);

  // Per-panel detail selection, shared with the master-detail panels via context.
  const [selectedByPanel, setSelectedByPanel] = useState<Partial<Record<PanelId, string | null>>>({});
  const setSelected = useCallback((panel: PanelId, id: string | null) => {
    setSelectedByPanel(prev => ({ ...prev, [panel]: id }));
  }, []);
  const detailContextValue = useMemo<ModelerDetailValue>(
    () => ({ selectedByPanel, setSelected }),
    [selectedByPanel, setSelected],
  );

  const handleTogglePanel = useCallback((panel: PanelId) => {
    setActivePanel(prev => (prev === panel ? null : panel));
    setLastLeftPanel(panel);
  }, []);

  const handleClosePanel = useCallback(() => {
    setActivePanel(null);
  }, []);

  const handleOpenLastLeftPanel = useCallback(() => {
    setActivePanel(lastLeftPanel);
  }, [lastLeftPanel]);

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

  // Ctrl+F opens Node Explorer and focuses search; Space toggles Palette;
  // Esc closes whichever right panel is open. Registered in the capture phase
  // so the Space toggle preempts the always-mounted SimulatorView's
  // space-to-step listener (which is in the bubble phase) when the modeler
  // tab is active.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || (ae?.isContentEditable ?? false);

      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (isField) return;
        e.preventDefault();
        setActiveRightPanel('explorer');
        setLastRightPanel('explorer');
        setTimeout(() => explorerRef.current?.focusSearch(), 50);
      } else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        // F = toggle both side panels (canvas fullscreen). Restore the exact
        // previous layout (including null entries) when toggling back out.
        if (isField) return;
        e.preventDefault();
        const anyOpen = activePanel != null || activeRightPanel != null;
        if (anyOpen) {
          prePanelStateRef.current = { left: activePanel, right: activeRightPanel };
          setActivePanel(null);
          setActiveRightPanel(null);
        } else {
          const prev = prePanelStateRef.current;
          setActivePanel(prev ? prev.left : lastLeftPanel);
          setActiveRightPanel(prev ? prev.right : null);
        }
      } else if ((e.key === ' ' || e.code === 'Space') && !e.repeat) {
        // Skip when typing or when a button has focus (Space activates buttons).
        if (isField || tag === 'BUTTON') return;
        e.preventDefault();
        // Block the simulator's bubble-phase space-step listener from also
        // running on this keystroke.
        e.stopImmediatePropagation();
        setActiveRightPanel(prev => (prev === 'palette' ? null : 'palette'));
        setLastRightPanel('palette');
      } else if (e.key === 'Escape' && activeRightPanel) {
        // Don't steal Esc from fields (e.g. clearing the search input first)
        if (isField) return;
        setActiveRightPanel(null);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [activePanel, activeRightPanel, lastLeftPanel]);

  const PanelContent = activePanel ? panelComponents[activePanel] : null;

  // Second left panel: the active master-detail panel's selected-item editor.
  // Mounted only when that panel is open AND its selected item still resolves.
  const detailPanelId = activePanel && MASTER_DETAIL_PANELS.has(activePanel) ? activePanel : null;
  const DetailContent = detailPanelId ? panelComponents[detailPanelId] : null;
  const detailItemName = detailPanelId
    ? selectedItemName(model, detailPanelId, selectedByPanel[detailPanelId] ?? null)
    : null;

  return (
    <ReactFlowProvider>
      <ModelerDetailContext.Provider value={detailContextValue}>
      <div className={styles.modelerLayout}>
        <ActivityBar activePanel={activePanel} onTogglePanel={handleTogglePanel} />
        {activePanel && PanelContent && (
          <PanelShell title={panelTitles[activePanel]} onClose={handleClosePanel}>
            <PanelContent mode="list" />
          </PanelShell>
        )}
        {detailPanelId && DetailContent && detailItemName != null && (
          <PanelShell
            title={`Edit: ${detailItemName}`}
            onClose={() => setSelected(detailPanelId, null)}
          >
            <DetailContent mode="detail" />
          </PanelShell>
        )}
        <div className={styles.graphArea}>
          <GraphEditorInner />
          {!activePanel && (
            <button
              className={styles.leftPanelExpandBtn}
              onClick={handleOpenLastLeftPanel}
              title={`Open ${panelTitles[lastLeftPanel]}`}
            >
              &rsaquo;
            </button>
          )}
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
      </ModelerDetailContext.Provider>
    </ReactFlowProvider>
  );
}
