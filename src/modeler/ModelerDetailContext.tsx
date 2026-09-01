import { createContext, useContext } from 'react';
import type { PanelId } from './ActivityBar';

/** Shared selection state for the modeler's master-detail panels (Attributes,
 *  Neighborhoods, Mappings). The selected item's editor is rendered in a SECOND
 *  left panel, so the selection must be lifted out of each panel component and
 *  shared with ModelerView (which mounts that detail panel). Keyed per-panel so
 *  switching ActivityBar tabs preserves each panel's selection. */
export interface ModelerDetailValue {
  selectedByPanel: Partial<Record<PanelId, string | null>>;
  setSelected: (panel: PanelId, id: string | null) => void;
  /** Clear EVERY panel's detail selection, so the second (detail) PanelShell
   *  unmounts whichever panel is active. Called when the user clicks the graph
   *  canvas — attention moved to the graph, so the editor for a model element
   *  gets out of the way. Stable identity (a `useCallback` with no deps), so a
   *  consumer can hold it in a ref without re-subscribing. */
  clearAllSelections: () => void;
}

export const ModelerDetailContext = createContext<ModelerDetailValue | null>(null);

/** Which half a master-detail panel component should render. The same component
 *  is mounted twice: `list` in the primary panel, `detail` in the secondary one. */
export type PanelMode = 'list' | 'detail';
export interface PanelContentProps {
  mode?: PanelMode;
}

const NOOP = () => {};

/** Clear every panel's detail selection. Returns a no-op outside the provider
 *  so a consumer rendered without it (a future standalone editor) still works. */
export function useClearDetailSelections(): () => void {
  const ctx = useContext(ModelerDetailContext);
  return ctx ? ctx.clearAllSelections : NOOP;
}

/** Per-panel detail selection — used like `useState` by the master-detail panels. */
export function useDetailSelection(panel: PanelId): [string | null, (id: string | null) => void] {
  const ctx = useContext(ModelerDetailContext);
  if (!ctx) throw new Error('useDetailSelection must be used within ModelerDetailContext.Provider');
  const selectedId = ctx.selectedByPanel[panel] ?? null;
  const setSelectedId = (id: string | null) => ctx.setSelected(panel, id);
  return [selectedId, setSelectedId];
}
