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

export function setConnectingFrom(val: typeof connectingFrom) {
  connectingFrom = val;
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
