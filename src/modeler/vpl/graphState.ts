/** Shared mutable state between GraphEditor and CaNode (avoids circular imports) */

/** Per-scope viewport cache (x/y/zoom) for the GraphEditor's ReactFlow canvas.
 *  Keyed by scope id — `"root"` for the top-level graph, or the macro id
 *  (e.g. `"macro_abc123"`) when the user is inside a macro definition.
 *
 *  Persists across ModelerView unmounts so that tab-switching (Modeler →
 *  Simulator → Modeler) doesn't lose pan/zoom — they often want quick A/B
 *  testing without re-finding their place. Also persists across scope
 *  switches inside the modeler so navigating breadcrumbs Foo → Bar → Foo
 *  doesn't keep re-fitting Foo.
 *
 *  Cleared en masse on `loadModel`/`newModel` (different graph layout —
 *  saved coords are meaningless). */
type Viewport = { x: number; y: number; zoom: number };
const savedViewports = new Map<string, Viewport>();

export function getSavedGraphViewport(scopeId: string): Viewport | null {
  return savedViewports.get(scopeId) ?? null;
}
export function setSavedGraphViewport(scopeId: string, v: Viewport | null): void {
  if (v === null) savedViewports.delete(scopeId);
  else savedViewports.set(scopeId, v);
}
export function clearAllSavedGraphViewports(): void {
  savedViewports.clear();
}

/** Scope stack the user was in when the GraphEditor last unmounted. Stored
 *  so a Modeler → Simulator → Modeler round-trip leaves the user inside the
 *  macro they were editing instead of dumping them back at root scope. */
export let savedCurrentScope: string[] = ['root'];
export function setSavedCurrentScope(scope: string[]): void {
  // Defensive copy so external mutations to the React state array don't
  // silently mutate the saved snapshot.
  savedCurrentScope = scope.slice();
}


/** Whether the user is currently dragging a connection */
export let isConnectingGlobal = false;

export function setIsConnecting(val: boolean) {
  isConnectingGlobal = val;
}

// ---------------------------------------------------------------------------
// Canvas view settings (port labels / grid / snap) — persisted.
// GraphEditor unmounts on every Modeler → Simulator tab switch, so its local
// useState seeds from these module globals; the globals themselves write
// through to localStorage so the choices also survive page reloads.
// ---------------------------------------------------------------------------

const VIEW_SETTINGS_KEY = 'genesisca_graph_view_settings';

type GraphViewSettings = {
  showPortLabels?: boolean;
  showGrid?: boolean;
  snapEnabled?: boolean;
};

function loadViewSettings(): GraphViewSettings {
  try {
    const raw = localStorage.getItem(VIEW_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as GraphViewSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const savedViewSettings = loadViewSettings();

function persistViewSettings(): void {
  try {
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({
      showPortLabels: showPortLabelsGlobal,
      showGrid: showGridGlobal,
      snapEnabled: snapEnabledGlobal,
    }));
  } catch {
    // localStorage unavailable (private mode / quota) — settings just won't persist
  }
}

/** Whether the background grid is visible (toggled from canvas controls) */
export let showGridGlobal = savedViewSettings.showGrid ?? true;

export function setShowGrid(val: boolean): void {
  if (showGridGlobal === val) return;
  showGridGlobal = val;
  persistViewSettings();
}

/** Whether snap-to-grid is enabled (toggled from canvas controls) */
export let snapEnabledGlobal = savedViewSettings.snapEnabled ?? true;

export function setSnapEnabled(val: boolean): void {
  if (snapEnabledGlobal === val) return;
  snapEnabledGlobal = val;
  persistViewSettings();
}

/** Whether port labels are visible (toggled from canvas controls) */
export let showPortLabelsGlobal = savedViewSettings.showPortLabels ?? true;

/** Subscribers that want to re-render when showPortLabelsGlobal changes */
const labelListeners = new Set<() => void>();

/** Subscribe to port-label visibility changes. Returns an unsubscribe fn.
 *  Used by CaNode via useSyncExternalStore so memoized nodes re-render on toggle. */
export function subscribeShowPortLabels(fn: () => void): () => void {
  labelListeners.add(fn);
  return () => { labelListeners.delete(fn); };
}

export function setShowPortLabels(val: boolean) {
  if (showPortLabelsGlobal === val) return;
  showPortLabelsGlobal = val;
  persistViewSettings();
  labelListeners.forEach(fn => fn());
}

/** Info about the handle being dragged for connection (for port compatibility highlighting
 *  AND the connection-drop-to-pane feature that pops the Add Node menu filtered to
 *  compatible nodes). `portId` and `dataType` populated when known so the drop-on-pane
 *  handler can filter the menu and seed the auto-connect edge. */
export let connectingFrom: {
  category: string;
  kind: string;
  dataType?: string;
  isArray?: boolean;
  nodeId: string;
  portId?: string;
} | null = null;

const connectingFromListeners = new Set<() => void>();

/** Subscribe to connectingFrom changes. Used by CaNode via useSyncExternalStore
 *  so memoized nodes re-render with the right port-compatibility highlighting
 *  the moment a drag starts and the moment it ends. */
export function subscribeConnectingFrom(fn: () => void): () => void {
  connectingFromListeners.add(fn);
  return () => { connectingFromListeners.delete(fn); };
}

export function setConnectingFrom(val: typeof connectingFrom) {
  if (connectingFrom === val) return;
  // Compare by reference is enough — callers either pass null or a fresh object.
  connectingFrom = val;
  connectingFromListeners.forEach(fn => fn());
}

// ---------------------------------------------------------------------------
// Connected input handles per node (perf: single pub/sub instead of per-node
// useStore subscriptions that fire on every React Flow store change)
// ---------------------------------------------------------------------------

const EMPTY_HANDLE_SET: ReadonlySet<string> = new Set();
let connectedHandlesMap = new Map<string, ReadonlySet<string>>();
const connectedHandlesListeners = new Set<() => void>();

/** Subscribe to connected-handles changes. Returns an unsubscribe fn. */
export function subscribeConnectedHandles(fn: () => void): () => void {
  connectedHandlesListeners.add(fn);
  return () => { connectedHandlesListeners.delete(fn); };
}

/** Get the set of connected input handle IDs for a node. Stable identity when unchanged. */
export function getConnectedHandlesForNode(id: string): ReadonlySet<string> {
  return connectedHandlesMap.get(id) ?? EMPTY_HANDLE_SET;
}

/** Diff-aware update from the current edges list. Reuses prior Set identity when a node's
 *  connected handles didn't actually change — so useSyncExternalStore consumers only re-render
 *  for nodes that truly changed. */
export function setConnectedHandlesFromEdges(edges: Array<{ target: string; targetHandle?: string | null }>): void {
  const grouped = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!e.target) continue;
    let s = grouped.get(e.target);
    if (!s) { s = new Set(); grouped.set(e.target, s); }
    s.add(e.targetHandle ?? '');
  }
  const next = new Map<string, ReadonlySet<string>>();
  for (const [nodeId, nextSet] of grouped) {
    const prevSet = connectedHandlesMap.get(nodeId);
    if (prevSet && prevSet.size === nextSet.size) {
      let same = true;
      for (const h of nextSet) {
        if (!prevSet.has(h)) { same = false; break; }
      }
      if (same) { next.set(nodeId, prevSet); continue; }
    }
    next.set(nodeId, nextSet);
  }
  connectedHandlesMap = next;
  connectedHandlesListeners.forEach(fn => fn());
}

// ---------------------------------------------------------------------------
// Model-element panel drag (Attribute / Neighborhood / Mapping / Indicator
// dragged from a side panel onto the canvas). Drives:
//   1. `compatibleHandlesForDrag` — the set of existing-canvas handles that a
//      to-be-spawned related node could connect to. CaNode subscribes and
//      lights up matching ports with the existing `handleCompatible` glow.
//   2. The snap-to-port detection in `onPaletteDrop` — if the drop lands
//      within React Flow's connection radius of any handle in this set, the
//      menu filters to nodes that can actually connect, and the chosen node
//      auto-wires its matching port.
// ---------------------------------------------------------------------------

/** Opaque to graphState — actual type lives in modelElementDrag.ts. Stored
 *  here as `unknown` to avoid an import cycle (graphState is imported by
 *  CaNode which is imported by GraphEditor which is where the drag types
 *  live). Callers cast on read. */
export let currentModelElementDrag: unknown = null;
const currentModelElementDragListeners = new Set<() => void>();

export function subscribeCurrentModelElementDrag(fn: () => void): () => void {
  currentModelElementDragListeners.add(fn);
  return () => { currentModelElementDragListeners.delete(fn); };
}
export function setCurrentModelElementDrag(val: unknown): void {
  if (currentModelElementDrag === val) return;
  currentModelElementDrag = val;
  currentModelElementDragListeners.forEach(fn => fn());
}

/** Set of canvas handle keys (`${nodeId}|${kind}|${category}|${portId}`) that
 *  are compatible with the current panel drag. Recomputed by GraphEditor when
 *  the drag payload changes or the node list changes. */
const EMPTY_HANDLE_KEY_SET: ReadonlySet<string> = new Set();
export let compatibleHandlesForDrag: ReadonlySet<string> = EMPTY_HANDLE_KEY_SET;
const compatibleHandlesForDragListeners = new Set<() => void>();

export function subscribeCompatibleHandlesForDrag(fn: () => void): () => void {
  compatibleHandlesForDragListeners.add(fn);
  return () => { compatibleHandlesForDragListeners.delete(fn); };
}
export function setCompatibleHandlesForDrag(val: ReadonlySet<string>): void {
  if (compatibleHandlesForDrag === val) return;
  // Reference compare is enough — callers either pass the empty constant or a
  // freshly built set.
  compatibleHandlesForDrag = val;
  compatibleHandlesForDragListeners.forEach(fn => fn());
}
export function clearCompatibleHandlesForDrag(): void {
  setCompatibleHandlesForDrag(EMPTY_HANDLE_KEY_SET);
}

/** Canonical handle-key encoding shared by the producer (compatibility
 *  computation) and the consumer (CaNode highlight check). */
export function handleKey(nodeId: string, kind: 'input' | 'output', category: 'flow' | 'value', portId: string): string {
  return `${nodeId}|${kind}|${category}|${portId}`;
}

// ---------------------------------------------------------------------------
// Connection-kind hazards per node (e.g. list-position → NeighborIndex mis-wires)
// Same pub/sub pattern as connectedHandles — single global recomputation,
// per-node useSyncExternalStore subscription, diff-aware notify.
// ---------------------------------------------------------------------------

const EMPTY_HAZARD_LIST: readonly string[] = [];
let connectionHazardsMap = new Map<string, readonly string[]>();
const connectionHazardsListeners = new Set<() => void>();

export function subscribeConnectionHazards(fn: () => void): () => void {
  connectionHazardsListeners.add(fn);
  return () => { connectionHazardsListeners.delete(fn); };
}

/** Get the list of hazard messages for a node (target side of incoming edges). Stable identity when unchanged. */
export function getConnectionHazardsForNode(id: string): readonly string[] {
  return connectionHazardsMap.get(id) ?? EMPTY_HAZARD_LIST;
}

/** Replace the global hazards map. Caller (GraphEditor) precomputes by walking edges + calling
 *  `detectEdgeHazard` per edge; this function handles diff-aware storage and notify. */
export function setConnectionHazards(next: Map<string, readonly string[]>): void {
  const prev = connectionHazardsMap;
  // Stabilize identity for unchanged entries
  const stabilized = new Map<string, readonly string[]>();
  for (const [k, v] of next) {
    const old = prev.get(k);
    if (old && old.length === v.length && old.every((x, i) => x === v[i])) {
      stabilized.set(k, old);
    } else {
      stabilized.set(k, v);
    }
  }
  // Detect any change (size or differing per-node references)
  let changed = stabilized.size !== prev.size;
  if (!changed) {
    for (const [k, v] of prev) {
      if (stabilized.get(k) !== v) { changed = true; break; }
    }
  }
  connectionHazardsMap = stabilized;
  if (changed) connectionHazardsListeners.forEach(fn => fn());
}
