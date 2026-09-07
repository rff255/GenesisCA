import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useModel } from '../model/ModelContext';
import type { CAModel } from '../model/types';
import { ActivityBar, type PanelId } from './ActivityBar';
import { ModelerDetailContext, type ModelerDetailValue, type PanelContentProps } from './ModelerDetailContext';
import { RightActivityBar, type RightPanelId } from './RightActivityBar';
import { PanelShell } from './PanelShell';
import { InfoPanelContent } from './panels/InfoPanelContent';
import { PropertiesPanelContent } from './panels/PropertiesPanelContent';
import { AttributesPanelContent } from './panels/AttributesPanelContent';
import { NeighborhoodsPanelContent } from './panels/NeighborhoodsPanelContent';
import { MappingsPanelContent } from './panels/MappingsPanelContent';
import { PalettePanelContent } from './panels/PalettePanelContent';
import type { PaletteHandle } from './panels/PalettePanelContent';
import { VariegatedCellsPanelContent } from './panels/VariegatedCellsPanelContent';
import { GraphEditorInner } from './vpl/GraphEditor';
import { NodeExplorer } from './vpl/NodeExplorer';
import type { NodeExplorerHandle } from './vpl/NodeExplorer';
import { quickAddApi, subscribeActiveGraphKind, getActiveGraphKind } from './vpl/graphState';
import type { QuickAddPayload } from './vpl/graphState';
import { modelerUiState } from './modelerUiState';
import { getLiveFocus, dispatchCanvasFullscreen } from '../live/liveState';
import { overlayOwnsKeyboard } from '../live/liveKeyboard';
import { IndicatorsPanelContent } from './panels/IndicatorsPanelContent';
import { OPEN_MODELER_PANEL_EVENT, type OpenModelerPanelDetail } from './panels/propertiesWidgets';
import styles from './ModelerView.module.css';

const panelTitles: Record<PanelId, string> = {
  info: 'Info',
  properties: 'Properties',
  attributes: 'Attributes',
  neighborhoods: 'Neighborhoods',
  mappings: 'Mappings',
  indicators: 'Indicators',
  variegated: 'Variegated Cells',
};

const panelComponents: Record<PanelId, React.ComponentType<PanelContentProps>> = {
  info: InfoPanelContent,
  properties: PropertiesPanelContent,
  attributes: AttributesPanelContent,
  neighborhoods: NeighborhoodsPanelContent,
  mappings: MappingsPanelContent,
  indicators: IndicatorsPanelContent,
  variegated: VariegatedCellsPanelContent,
};

// Panels with a list + per-item editor. Their editor renders in a second left
// panel (the "detail" panel) so the user never scrolls past the list to reach it.
// (The Attributes panel also hosts Local Variables; its selection is a
// discriminated `attr:`/`var:` string handled by selectedItemName below.
// Indicators is its own panel — its slot is a bare indicator id.)
const MASTER_DETAIL_PANELS = new Set<PanelId>(['indicators', 'attributes', 'neighborhoods', 'mappings']);

/** Display name of the active panel's selected item, or null if nothing is
 *  selected / the id no longer resolves (so the detail panel hides on delete).
 *  `agentMode` (the Agents sub-tab is active) makes the Attributes panel resolve
 *  AGENT attributes / variables — without it an agent-attribute selection never
 *  resolves and the detail editor panel stays hidden (the bug). The Agents tab
 *  still shows the SHARED Model Attributes section, so an agent-attr lookup falls
 *  through to model.attributes for a model attr selected there. */
function selectedItemName(model: CAModel, panel: PanelId, id: string | null, agentMode: boolean): string | null {
  if (!id) return null;
  if (panel === 'indicators') {
    return (model.indicators ?? []).find(i => i.id === id)?.name ?? null;
  }
  if (panel === 'attributes') {
    // Discriminated `attr:<id>` / `var:<id>` / `bond:<id>` — Local Variables AND
    // (P2) Bond Attributes share this panel's single detail slot.
    // ⚠ A prefix that does NOT resolve here means the detail PanelShell (gated on
    // `detailItemName != null`) never mounts, so clicking or adding an item does
    // NOTHING visible — the exact bug that shipped once for agent attributes.
    if (id.startsWith('bond:')) {
      const bondId = id.slice(5);
      return (model.bondAttributes ?? []).find(a => a.id === bondId)?.name ?? null;
    }
    if (id.startsWith('var:')) {
      const varId = id.slice(4);
      const list = agentMode ? (model.agentVariables ?? []) : (model.variables ?? []);
      return list.find(v => v.id === varId)?.name ?? null;
    }
    const attrId = id.startsWith('attr:') ? id.slice(5) : id;
    if (agentMode) {
      // Agents tab: the primary list is agentAttributes; the SHARED Model
      // Attributes section is also shown, so fall through to MODEL attrs only
      // (a cell attr — not listed here — must not resolve on this tab).
      const hit = (model.agentAttributes ?? []).find(a => a.id === attrId)
        ?? model.attributes.find(a => a.id === attrId && a.isModelAttribute);
      return hit?.name ?? null;
    }
    return model.attributes.find(a => a.id === attrId)?.name ?? null;
  }
  if (panel === 'neighborhoods') return model.neighborhoods.find(n => n.id === id)?.name ?? null;
  if (panel === 'mappings') {
    // Discriminated `agentmap:<id>` (an AGENT mapping — EITHER direction, since
    // `agentMappings` holds both the A→C views and the C→A input mappings) /
    // `sprite:<id>`
    // (a Sprite Library asset) vs a bare id (a CELL mapping) — three separate
    // id-spaces sharing this panel's ONE detail slot. Same ⚠ as the attributes
    // panel above: an unresolved prefix leaves the detail PanelShell unmounted,
    // so clicking / adding a row would do NOTHING visible.
    if (id.startsWith('agentmap:')) {
      const agentMapId = id.slice(9);
      return (model.agentMappings ?? []).find(m => m.id === agentMapId)?.name ?? null;
    }
    if (id.startsWith('sprite:')) {
      const spriteId = id.slice(7);
      return (model.sprites ?? []).find(s => s.id === spriteId)?.name ?? null;
    }
    return model.mappings.find(m => m.id === id)?.name ?? null;
  }
  return null;
}

const rightPanelTitles: Record<RightPanelId, string> = {
  explorer: 'Node Explorer',
  palette: 'Palette',
};

/** `live` — the Modeler is sharing the workspace with the running simulation
 *  (the Live split). The graph pane is then roughly half a window wide, so the
 *  side panels start collapsed and are restored on the way out. */
export function ModelerView({ live = false }: { live?: boolean } = {}) {
  const { model } = useModel();
  const variegatedEnabled = !!model.variegatedCells?.enabled;
  // Neighborhoods is a lattice-CA-only panel; the ActivityBar elides its tab for
  // an agents-only model (Grid Cells off). Mirror the variegated auto-switch so
  // the panel doesn't stay open with no tab to dismiss it.
  const gridCellsOn = model.topologyMode?.gridCells !== false;
  // Generic Agent Platform: the Attributes panel shows AGENT attributes/variables
  // on the Agents sub-tab. The detail-panel resolution (selectedItemName) must
  // know this so an agent-attribute selection resolves (else its editor never
  // mounts). Mirrors AttributesPanelContent's `agentMode`.
  const activeGraphKind = useSyncExternalStore(subscribeActiveGraphKind, getActiveGraphKind);
  const attrAgentMode = activeGraphKind === 'agents' && !!model.topologyMode?.agents;
  // Seed from the module-level snapshot so the modeler layout survives the
  // unmount that happens when switching to the Simulator / another top-level tab.
  const [activePanel, setActivePanel] = useState<PanelId | null>(modelerUiState.activePanel);
  // When the user disables Variegated Cells while its panel is open, switch
  // the left panel to Properties (where the toggle lives). The ActivityBar
  // hides the V tab in this case so there'd be no way to dismiss the panel
  // otherwise. Also re-aim `lastLeftPanel` if it pointed at variegated.
  useEffect(() => {
    if (!variegatedEnabled && activePanel === 'variegated') setActivePanel('properties');
    if (!gridCellsOn && activePanel === 'neighborhoods') setActivePanel('properties');
  }, [variegatedEnabled, gridCellsOn, activePanel]);
  const [activeRightPanel, setActiveRightPanel] = useState<RightPanelId | null>(modelerUiState.activeRightPanel);
  // Remembered last-opened panels — used by the floating graph-area expand-ears
  // to reopen whatever the user had open before closing it.
  const [lastLeftPanel, setLastLeftPanel] = useState<PanelId>(modelerUiState.lastLeftPanel);
  const [lastRightPanel, setLastRightPanel] = useState<RightPanelId>(modelerUiState.lastRightPanel);
  // Snapshot of panel state when entering F-fullscreen so the toggle restores
  // exactly what was open before (null entries are preserved as null).
  const prePanelStateRef = useRef<{ left: PanelId | null; right: RightPanelId | null } | null>(null);
  const explorerRef = useRef<NodeExplorerHandle>(null);

  // The Palette panel keeps its own keyboard quick-add (Enter in its search)
  // when opened manually; it drops the node at the cursor's live flow position.
  // (Spacebar no longer opens the Palette — it opens the in-canvas quick-add
  // menu via quickAddApi.openQuickAddMenu instead.)
  const paletteRef = useRef<PaletteHandle>(null);

  const handlePaletteQuickAdd = useCallback((payload: QuickAddPayload) => {
    const pos = quickAddApi?.getCursorFlowPos() ?? null;
    if (pos) quickAddApi?.addFromPalette(payload, pos);
    setActiveRightPanel(null);
  }, []);

  // Per-panel detail selection, shared with the master-detail panels via context.
  const [selectedByPanel, setSelectedByPanel] = useState<Partial<Record<PanelId, string | null>>>(modelerUiState.selectedByPanel);
  const setSelected = useCallback((panel: PanelId, id: string | null) => {
    setSelectedByPanel(prev => ({ ...prev, [panel]: id }));
  }, []);
  // Clearing EVERY panel's slot (rather than just the active one) is what makes
  // the detail PanelShell unmount whichever tab the user later switches to —
  // and it persists as cleared through the modelerUiState snapshot effect below,
  // so a Simulator round-trip does not resurrect a stale editor. Same-object
  // early return so a repeated canvas click re-renders nothing.
  const clearAllSelections = useCallback(() => {
    setSelectedByPanel(prev => (Object.values(prev).every(v => v == null) ? prev : {}));
  }, []);

  // --- LIVE panel policy ---------------------------------------------------
  // In Live the graph shares the workspace with the simulation viewport, so the
  // pane is about half a window wide — with a 320 px master panel (plus a detail
  // panel) open, the React Flow canvas measured **101 px**, which is unusable.
  // So both side panels start collapsed in Live and are put back on the way out,
  // INCLUDING null entries — the same discipline `prePanelStateRef` uses for the
  // F-fullscreen toggle, and the mirror of `SimulatorView`'s own Live policy.
  //
  // ⚠ ModelerView stays MOUNTED across a Modeler ⇄ Live switch (App keeps its
  // wrapper in the tree in every mode), so without the restore the collapse
  // would silently leak into the Modeler tab. And because the write-through
  // effect below persists the COLLAPSED state to `modelerUiState`, an unmount
  // that happens while still in Live (Live → Library) has to put the snapshot
  // back there itself, or the panels stay shut for good.
  const preLivePanelRef = useRef<{ left: PanelId | null; right: RightPanelId | null } | null>(null);
  const panelStateRef = useRef<{ left: PanelId | null; right: RightPanelId | null }>({ left: null, right: null });
  panelStateRef.current = { left: activePanel, right: activeRightPanel };
  useEffect(() => {
    if (live) {
      if (preLivePanelRef.current) return;     // already inside Live
      preLivePanelRef.current = { ...panelStateRef.current };
      setActivePanel(null);
      setActiveRightPanel(null);
    } else if (preLivePanelRef.current) {
      const p = preLivePanelRef.current;
      preLivePanelRef.current = null;
      setActivePanel(p.left);
      setActiveRightPanel(p.right);
    }
  }, [live]);
  useEffect(() => () => {
    const p = preLivePanelRef.current;
    if (!p) return;
    modelerUiState.activePanel = p.left;
    modelerUiState.activeRightPanel = p.right;
  }, []);

  // Write the layout state through to the module-level snapshot on every change
  // so the next ModelerView mount (after a tab round-trip) restores it.
  useEffect(() => {
    modelerUiState.activePanel = activePanel;
    modelerUiState.activeRightPanel = activeRightPanel;
    modelerUiState.lastLeftPanel = lastLeftPanel;
    modelerUiState.lastRightPanel = lastRightPanel;
    modelerUiState.selectedByPanel = selectedByPanel;
  }, [activePanel, activeRightPanel, lastLeftPanel, lastRightPanel, selectedByPanel]);
  const detailContextValue = useMemo<ModelerDetailValue>(
    () => ({ selectedByPanel, setSelected, clearAllSelections }),
    [selectedByPanel, setSelected, clearAllSelections],
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

  // Canvas fullscreen = toggle both side panels. Shared by the F key and the
  // navbar fullscreen button (via the `genesis-toggle-canvas-fullscreen` event)
  // so both do the same in-app maximize (not a browser-only F11). Restores the
  // exact previous layout (including null entries) when toggling back out.
  //
  // ⚠ `collapse` (LIVE): in Live the event carries an explicit intent so ONE
  // press acts the same way on BOTH panel sets. Toggling each view
  // independently would be permanently out of phase there — the Live policy
  // enters with the graph's panels already closed and the simulator's bars
  // open, so an independent toggle would OPEN one while CLOSING the other.
  // Omitted (undefined) everywhere else, which is the historical toggle.
  const applyCanvasFullscreen = useCallback((collapse?: boolean) => {
    const anyOpen = activePanel != null || activeRightPanel != null;
    if (collapse ?? anyOpen) {
      // Snapshot when there is something to remember — and ALSO the first time
      // an explicit `collapse: true` arrives with nothing open (Live's shared
      // intent), so the matching restore leaves the panels closed instead of
      // falling back to `lastLeftPanel`. ⚠ Never overwrite an existing snapshot
      // with an all-closed one, or the restore becomes a permanent no-op.
      if (anyOpen || !prePanelStateRef.current) {
        prePanelStateRef.current = { left: activePanel, right: activeRightPanel };
      }
      setActivePanel(null);
      setActiveRightPanel(null);
    } else {
      const prev = prePanelStateRef.current;
      setActivePanel(prev ? prev.left : lastLeftPanel);
      setActiveRightPanel(prev ? prev.right : null);
    }
  }, [activePanel, activeRightPanel, lastLeftPanel]);
  const toggleCanvasFullscreen = useCallback(() => applyCanvasFullscreen(), [applyCanvasFullscreen]);

  useEffect(() => {
    const onEvt = (e: Event) => {
      const d = (e as CustomEvent<{ collapse?: boolean }>).detail;
      applyCanvasFullscreen(typeof d?.collapse === 'boolean' ? d.collapse : undefined);
    };
    window.addEventListener('genesis-toggle-canvas-fullscreen', onEvt);
    return () => window.removeEventListener('genesis-toggle-canvas-fullscreen', onEvt);
  }, [applyCanvasFullscreen]);

  // Open a named left panel from anywhere (the palette's hidden-nodes notice,
  // the Setup tab's "Open panel" links). For Properties an optional sub-tab is
  // written to the snapshot FIRST, so the panel mounts on it.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenModelerPanelDetail>).detail;
      if (!d?.panel) return;
      if (d.propertiesTab) modelerUiState.propertiesTab = d.propertiesTab;
      setActivePanel(d.panel);
      setLastLeftPanel(d.panel);
    };
    window.addEventListener(OPEN_MODELER_PANEL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_MODELER_PANEL_EVENT, onOpen);
  }, []);

  // Ctrl+F opens Node Explorer and focuses search; Space toggles Palette;
  // Esc closes whichever right panel is open. Registered in the capture phase
  // so the Space toggle preempts the always-mounted SimulatorView's
  // space-to-step listener (which is in the bubble phase) when the modeler
  // tab is active.
  //
  // LIVE (Phase 4) — this handler owns the GRAPH pane, so two arms change:
  // `Space` stands down when the VIEWPORT has focus (letting the simulator's
  // step arm run), and `F` is re-routed through the shared
  // `genesis-toggle-canvas-fullscreen` event so ONE press collapses BOTH panel
  // sets exactly once. See `docs/areas/modeler-ui.md` § *LIVE mode*.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || (ae?.isContentEditable ?? false);
      // A modal or an open menu owns the keyboard while it is up — including
      // the graph's own quick-add menu, whose search input is focused on a
      // 50 ms timer (so the field check alone does not cover it).
      if (overlayOwnsKeyboard()) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (isField) return;
        e.preventDefault();
        setActiveRightPanel('explorer');
        setLastRightPanel('explorer');
        setTimeout(() => explorerRef.current?.focusSearch(), 50);
      } else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        // F = toggle both side panels (canvas fullscreen).
        if (isField) return;
        e.preventDefault();
        // In LIVE both workspaces have panel sets, and the user means BOTH.
        // Dispatching the shared event (rather than calling the local toggle)
        // is what makes one press = one toggle per view: this view's own event
        // listener does the modeler half and `SimulatorView`'s does the
        // simulator half. Its DIRECT F-key handler stands down in Live for the
        // same reason — otherwise the simulator would toggle twice (event +
        // key) and appear not to respond at all.
        if (live) dispatchCanvasFullscreen(true);
        else toggleCanvasFullscreen();
      } else if ((e.key === ' ' || e.code === 'Space') && !e.repeat) {
        // Skip when typing or when a button has focus (Space activates buttons).
        if (isField || tag === 'BUTTON') return;
        // LIVE: Space follows the focused surface — quick-add on the graph,
        // one step on the viewport. Standing down here (BEFORE the
        // stopImmediatePropagation below) is what lets the simulator's arm run.
        if (live && getLiveFocus() !== 'graph') return;
        e.preventDefault();
        // Block the simulator's bubble-phase space-step listener from also
        // running on this keystroke.
        e.stopImmediatePropagation();
        // Quick-add: open the unified add-node menu (pane options + focused
        // search + node list) right at the cursor — same menu as a blank-canvas
        // right-click. GraphEditor focuses the search and freezes the drop
        // position from the cursor's last canvas location. Esc closes it.
        quickAddApi?.openQuickAddMenu();
      } else if (e.key === 'Escape' && activeRightPanel) {
        // Don't steal Esc from fields (e.g. clearing the search input first)
        if (isField) return;
        setActiveRightPanel(null);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [activeRightPanel, toggleCanvasFullscreen, live]);

  const PanelContent = activePanel ? panelComponents[activePanel] : null;

  // Second left panel: the active master-detail panel's selected-item editor.
  // Mounted only when that panel is open AND its selected item still resolves.
  const detailPanelId = activePanel && MASTER_DETAIL_PANELS.has(activePanel) ? activePanel : null;
  const DetailContent = detailPanelId ? panelComponents[detailPanelId] : null;
  const detailItemName = detailPanelId
    ? selectedItemName(model, detailPanelId, selectedByPanel[detailPanelId] ?? null, attrAgentMode)
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
              <PalettePanelContent
                ref={paletteRef}
                onQuickAdd={handlePaletteQuickAdd}
                onQuickAddCancel={handleCloseRightPanel}
              />
            )}
          </PanelShell>
        )}
        <RightActivityBar activePanel={activeRightPanel} onTogglePanel={handleToggleRightPanel} />
      </div>
      </ModelerDetailContext.Provider>
    </ReactFlowProvider>
  );
}
