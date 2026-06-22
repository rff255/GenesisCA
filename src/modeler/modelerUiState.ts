import type { PanelId } from './ActivityBar';
import type { RightPanelId } from './RightActivityBar';

// Module-level snapshot of the ModelerView's panel/selection UI state. ModelerView
// is conditionally rendered in App.tsx (unmounted whenever the user switches to the
// Simulator or another top-level tab), which would otherwise reset every panel
// choice on return. ModelerView seeds its useState from this snapshot on mount and
// writes through on change, so the modeler layout — which left tab is focused, which
// side panels are open, and which item is being edited in each — survives a round
// trip through the Simulator. Same approach graphState.ts uses for the graph
// viewport/scope. In-memory only: resets on a full page reload, like the rest of the
// modeler session state.
export const modelerUiState: {
  activePanel: PanelId | null;
  activeRightPanel: RightPanelId | null;
  lastLeftPanel: PanelId;
  lastRightPanel: RightPanelId;
  selectedByPanel: Partial<Record<PanelId, string | null>>;
  /** Bond-Graph Agents: which rule graph the editor is showing (Cells vs the
   *  Agents graph). Persists across a Modeler↔Simulator round-trip (GraphEditor
   *  unmounts and reseeds from here). Macro navigation does NOT reset it (entering
   *  a macro from the Agents graph returns to the Agents graph). */
  activeGraph: 'cells' | 'agents';
} = {
  activePanel: 'properties',
  activeRightPanel: null,
  lastLeftPanel: 'properties',
  lastRightPanel: 'palette',
  selectedByPanel: {},
  activeGraph: 'cells',
};
