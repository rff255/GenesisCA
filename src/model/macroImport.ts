import type { MacroDef, MacroPort, GraphNode, GraphEdge } from './types';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Deep-clone a MacroDef and regenerate every internal identifier so two drops of
 * the same default macro into a project (or the same macro into two projects)
 * never collide on node/edge/macro IDs.
 *
 * Remaps:
 *   - MacroDef.id
 *   - every node.id in the subgraph (including group/commentNode children)
 *   - every edge.id, edge.source, edge.target
 *   - any node.data.parentId references (to keep group membership)
 *   - MacroPort.internalNodeId references (to keep boundary ports wired)
 *
 * Internal port ids (sourceHandle/targetHandle strings, MacroPort.internalPortId,
 * MacroPort.portId) are intentionally preserved — they're stable identifiers
 * inside the subgraph and don't collide across macro instances because each
 * MacroDef.id differs.
 */
export function cloneMacroWithFreshIds(raw: MacroDef): MacroDef {
  const newMacroId = genId('mac');
  const idMap = new Map<string, string>();
  const mapId = (oldId: string): string => {
    const existing = idMap.get(oldId);
    if (existing) return existing;
    const fresh = genId('n');
    idMap.set(oldId, fresh);
    return fresh;
  };

  // Pre-register all node ids so later references (parentId, edge endpoints,
  // MacroPort.internalNodeId) map consistently regardless of iteration order.
  for (const n of raw.nodes) mapId(n.id);

  const nodes: GraphNode[] = raw.nodes.map(n => {
    const data = { ...n.data } as GraphNode['data'] & { parentId?: string };
    if ((data as Record<string, unknown>).parentId) {
      const parentOld = (data as Record<string, unknown>).parentId as string;
      (data as Record<string, unknown>).parentId = idMap.get(parentOld) ?? parentOld;
    }
    // Update macroDefId on boundary nodes (macroInput/macroOutput) to point at the new MacroDef.
    const config: GraphNode['data']['config'] = { ...n.data.config };
    if ((n.data.nodeType === 'macroInput' || n.data.nodeType === 'macroOutput') && 'macroDefId' in config) {
      config.macroDefId = newMacroId;
    }
    return {
      ...n,
      id: mapId(n.id),
      position: { ...n.position },
      data: { ...data, config },
    };
  });

  const edges: GraphEdge[] = raw.edges.map(e => ({
    id: genId('e'),
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
  }));

  const remapPort = (p: MacroPort): MacroPort => ({
    ...p,
    internalNodeId: idMap.get(p.internalNodeId) ?? p.internalNodeId,
  });

  return {
    id: newMacroId,
    name: raw.name,
    nodes,
    edges,
    exposedInputs: raw.exposedInputs.map(remapPort),
    exposedOutputs: raw.exposedOutputs.map(remapPort),
  };
}
