/**
 * Runtime migration: drop every reference to the removed built-in agent `type`
 * field from a loaded model's AGENT graph (+ any macroDefs).
 *
 * GenesisCA agents no longer carry a built-in integer `type` (it didn't fit the
 * generalist intention — agents have only their user-defined `agentAttributes`).
 * Three node-graph remnants can appear in legacy `.gcaproj` files:
 *   1. `setAgentType` nodes — the node type is gone. DROP the node + every edge
 *      touching it.
 *   2. `createAgent` nodes with a `type` input — DROP the `_port_type` inline
 *      config + any edge into the `input_value_type` handle.
 *   3. `behaviourStep` nodes whose `myType` output was wired — DROP any edge out
 *      of the `output_value_myType` handle.
 *
 * Operates on `agentGraphNodes` / `agentGraphEdges` (where these nodes live) and
 * every `macroDefs[*]`. Idempotent: a model with none of these is returned
 * unchanged (same array references).
 */

import type { CAModel, GraphNode, GraphEdge, MacroDef } from './types';

function migratePair(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  const removedNodeIds = new Set<string>();
  const createAgentIds = new Set<string>();
  const behaviourIds = new Set<string>();
  let changed = false;

  for (const n of nodes) {
    const t = n.data?.nodeType;
    if (t === 'setAgentType') removedNodeIds.add(n.id);
    else if (t === 'createAgent') createAgentIds.add(n.id);
    else if (t === 'behaviourStep') behaviourIds.add(n.id);
  }

  // Nothing to do if there are no setAgentType nodes AND no createAgent type
  // config AND no myType-out edges.
  const hasTypePortCfg = [...createAgentIds].some(id => {
    const node = nodes.find(n => n.id === id);
    const cfg = node?.data?.config as Record<string, unknown> | undefined;
    return cfg && ('_port_type' in cfg);
  });
  const hasMyTypeEdge = edges.some(e =>
    behaviourIds.has(e.source) && e.sourceHandle === 'output_value_myType');
  const hasTypeInEdge = edges.some(e =>
    createAgentIds.has(e.target) && e.targetHandle === 'input_value_type');
  if (removedNodeIds.size === 0 && !hasTypePortCfg && !hasMyTypeEdge && !hasTypeInEdge) {
    return { nodes, edges, changed: false };
  }

  // Drop setAgentType nodes; strip _port_type from createAgent configs.
  const newNodes = nodes
    .filter(n => !removedNodeIds.has(n.id))
    .map(n => {
      if (!createAgentIds.has(n.id)) return n;
      const cfg = n.data?.config as Record<string, unknown> | undefined;
      if (!cfg || !('_port_type' in cfg)) return n;
      const newCfg = { ...cfg };
      delete newCfg._port_type;
      changed = true;
      return { ...n, data: { ...n.data, config: newCfg as GraphNode['data']['config'] } };
    });
  if (newNodes.length !== nodes.length) changed = true;

  // Drop edges touching a removed node, edges into createAgent.type, edges out of
  // behaviourStep.myType.
  const newEdges = edges.filter(e => {
    if (removedNodeIds.has(e.source) || removedNodeIds.has(e.target)) return false;
    if (createAgentIds.has(e.target) && e.targetHandle === 'input_value_type') return false;
    if (behaviourIds.has(e.source) && e.sourceHandle === 'output_value_myType') return false;
    return true;
  });
  if (newEdges.length !== edges.length) changed = true;

  return { nodes: changed ? newNodes : nodes, edges: changed ? newEdges : edges, changed };
}

/** Migrate the agent graph + all macroDefs in one pass. Returns the same model
 *  reference when nothing matched (idempotent). */
export function migrateAgentTypeRemoval(model: CAModel): CAModel {
  const agent = migratePair(model.agentGraphNodes ?? [], model.agentGraphEdges ?? []);

  let anyMacroChanged = false;
  const newMacroDefs = (model.macroDefs ?? []).map(md => {
    const r = migratePair(md.nodes, md.edges);
    if (!r.changed) return md;
    anyMacroChanged = true;
    return { ...md, nodes: r.nodes, edges: r.edges } as MacroDef;
  });

  if (!agent.changed && !anyMacroChanged) return model;
  return {
    ...model,
    ...(agent.changed ? { agentGraphNodes: agent.nodes, agentGraphEdges: agent.edges } : {}),
    macroDefs: anyMacroChanged ? newMacroDefs : model.macroDefs,
  };
}

/** Convenience for macro-import call sites — migrates one MacroDef in place
 *  (returns the same reference if nothing matched). */
export function migrateAgentTypeRemovalInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
