/** Shared mutable state between GraphEditor and CaNode (avoids circular imports) */

/** Whether the user is currently dragging a connection */
export let isConnectingGlobal = false;

export function setIsConnecting(val: boolean) {
  isConnectingGlobal = val;
}
