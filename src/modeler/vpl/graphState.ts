/** Shared mutable state between GraphEditor and CaNode (avoids circular imports) */

/** Whether the user is currently dragging a connection */
export let isConnectingGlobal = false;

export function setIsConnecting(val: boolean) {
  isConnectingGlobal = val;
}

/** Whether port labels are visible (toggled from canvas controls) */
export let showPortLabelsGlobal = true;

export function setShowPortLabels(val: boolean) {
  showPortLabelsGlobal = val;
}

/** Info about the handle being dragged for connection (for port compatibility highlighting) */
export let connectingFrom: { category: string; dataType?: string; nodeId: string } | null = null;

export function setConnectingFrom(val: typeof connectingFrom) {
  connectingFrom = val;
}
