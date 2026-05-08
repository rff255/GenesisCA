/** Shared mutable state between GraphEditor and CaNode (avoids circular imports) */

/** Whether the user is currently dragging a connection */
export let isConnectingGlobal = false;

export function setIsConnecting(val: boolean) {
  isConnectingGlobal = val;
}

/** Whether port labels are visible (toggled from canvas controls) */
export let showPortLabelsGlobal = true;

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
  labelListeners.forEach(fn => fn());
}

/** Info about the handle being dragged for connection (for port compatibility highlighting) */
export let connectingFrom: { category: string; kind: string; dataType?: string; nodeId: string } | null = null;

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
