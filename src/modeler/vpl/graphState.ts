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
