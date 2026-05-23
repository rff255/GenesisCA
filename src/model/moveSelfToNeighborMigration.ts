/**
 * Runtime migration: upgrade legacy `moveSelfToNeighbor` ("Move Self To
 * Neighbor") nodes to the reworked "Transfer Cell Attributes to Neighbor"
 * shape. The node type id is unchanged — only its config + ports changed.
 *
 * Old shape: per-slot `payload_${i}` value input ports + an `orientation`
 * value input port + a `transferOrientation` bool. Behaviour was always
 * "push self → neighbour, then clear self to defaults" (= Copy To + Defaults),
 * with the payload typically wired from a Get Cell Attribute of self.
 *
 * New shape: slots are pure attribute selectors (values read directly from the
 * cells); `operation` (copyTo/copyFrom/swap) + `nonReceiving`
 * (untouched/defaults) + `includeOrientation`. The payload/orientation ports
 * are gone.
 *
 * Migration policy (preserves the old behaviour byte-for-byte):
 *   - operation = 'copyTo', nonReceiving = 'defaults'.
 *   - includeOrientation = old `transferOrientation`.
 *   - Drop the dead `transferOrientation` config + any inline
 *     `_port_payload_*` / `_port_orientation` widget values.
 *   - Drop edges targeting the removed `payload_${i}` / `orientation` input
 *     ports (handles `input_value_payload_*` / `input_value_orientation`).
 *
 * Idempotent: a node is migrated only when it lacks an `operation` config key
 * (old nodes never have it; reworked / freshly-created nodes always do).
 */

import type { GraphNode, GraphEdge, MacroDef } from './types';

function isLegacy(node: GraphNode): boolean {
  return node.data?.nodeType === 'moveSelfToNeighbor'
    && (node.data.config as Record<string, unknown>).operation === undefined;
}

function migrateOneNode(node: GraphNode): GraphNode {
  const cfg = node.data.config as Record<string, string | number | boolean>;
  const newCfg: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'transferOrientation') continue;
    if (k.startsWith('_port_payload_') || k === '_port_orientation') continue;
    newCfg[k] = v;
  }
  newCfg.operation = 'copyTo';
  newCfg.nonReceiving = 'defaults';
  newCfg.includeOrientation = !!cfg.transferOrientation;
  return {
    ...node,
    data: { ...node.data, config: newCfg },
  };
}

function isRemovedHandle(h: string | undefined): boolean {
  if (!h) return false;
  return h.startsWith('input_value_payload_') || h === 'input_value_orientation';
}

function migratePair(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  const targetIds = new Set<string>();
  for (const n of nodes) {
    if (isLegacy(n)) targetIds.add(n.id);
  }
  if (targetIds.size === 0) return { nodes, edges, changed: false };

  const newNodes = nodes.map(n => (targetIds.has(n.id) ? migrateOneNode(n) : n));
  const newEdges = edges.filter(e => {
    if (!targetIds.has(e.target)) return true;
    return !isRemovedHandle(e.targetHandle);
  });
  return { nodes: newNodes, edges: newEdges, changed: true };
}

/** Migrate top-level + all macroDefs in one pass. Returns the same array
 *  references when no migration was needed (idempotent). */
export function migrateMoveSelfToNeighborNodes(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  macroDefs: MacroDef[] | undefined,
): { graphNodes: GraphNode[]; graphEdges: GraphEdge[]; macroDefs: MacroDef[] } {
  const top = migratePair(graphNodes, graphEdges);

  let anyMacroChanged = false;
  const newMacroDefs = (macroDefs ?? []).map(md => {
    const r = migratePair(md.nodes, md.edges);
    if (!r.changed) return md;
    anyMacroChanged = true;
    return { ...md, nodes: r.nodes, edges: r.edges };
  });

  if (!top.changed && !anyMacroChanged) {
    return { graphNodes, graphEdges, macroDefs: macroDefs ?? [] };
  }
  return {
    graphNodes: top.changed ? top.nodes : graphNodes,
    graphEdges: top.changed ? top.edges : graphEdges,
    macroDefs: newMacroDefs,
  };
}

/** Convenience for macro-import call sites — migrates one MacroDef in place
 *  (returns the same reference if nothing matched). */
export function migrateMoveSelfToNeighborInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
