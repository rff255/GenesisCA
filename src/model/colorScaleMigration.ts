/**
 * Runtime migration: rewrite any legacy `colorInterpolation` node into the
 * new `colorScale` shape. The old node had 2 fixed colour stops driven by
 * `_port_r1/g1/b1/r2/g2/b2` inline widgets plus a `method` config; the new
 * node stores N colour stops via `stopCount` + `stop_<i>_(position|r|g|b)`.
 *
 * Migration policy:
 *   - Old `method` is preserved verbatim.
 *   - Stops 0 and 1 are seeded at positions 0 and 1 with the old (r1,g1,b1)
 *     and (r2,g2,b2) channel values.
 *   - Old `_port_t` (inline value for the `t` port) is preserved since the
 *     `t` port carries over to the new node.
 *   - Edges targeting the removed `r1/g1/b1/r2/g2/b2` input ports on a
 *     migrated node are dropped. Edges targeting `t` (handle
 *     `input_value_t`) and ALL outgoing edges from `r/g/b` survive.
 *
 * Idempotent: when no `colorInterpolation` nodes are found the input
 * references are returned unchanged.
 */

import type { GraphNode, GraphEdge, MacroDef } from './types';

const REMOVED_INPUT_PORTS = ['r1', 'g1', 'b1', 'r2', 'g2', 'b2'] as const;
const REMOVED_TARGET_HANDLES = new Set(
  REMOVED_INPUT_PORTS.map(p => `input_value_${p}`),
);

function migrateOneNode(node: GraphNode): GraphNode {
  const cfg = node.data.config as Record<string, string | number | boolean>;
  const method = (cfg.method as string) ?? 'linear';
  const r1 = parseInt(String(cfg._port_r1 ?? '0'), 10) || 0;
  const g1 = parseInt(String(cfg._port_g1 ?? '0'), 10) || 0;
  const b1 = parseInt(String(cfg._port_b1 ?? '0'), 10) || 0;
  const r2 = parseInt(String(cfg._port_r2 ?? '255'), 10) || 0;
  const g2 = parseInt(String(cfg._port_g2 ?? '255'), 10) || 0;
  const b2 = parseInt(String(cfg._port_b2 ?? '255'), 10) || 0;

  const newCfg: Record<string, string | number | boolean> = {
    method,
    stopCount: 2,
    stop_0_position: '0',
    stop_0_r: String(r1),
    stop_0_g: String(g1),
    stop_0_b: String(b1),
    stop_1_position: '1',
    stop_1_r: String(r2),
    stop_1_g: String(g2),
    stop_1_b: String(b2),
  };
  if (cfg._port_t !== undefined) newCfg._port_t = cfg._port_t;

  return {
    ...node,
    data: { ...node.data, nodeType: 'colorScale', config: newCfg },
  };
}

function migratePair(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  const targetIds = new Set<string>();
  for (const n of nodes) {
    if (n.data?.nodeType === 'colorInterpolation') targetIds.add(n.id);
  }
  if (targetIds.size === 0) return { nodes, edges, changed: false };

  const newNodes = nodes.map(n => (targetIds.has(n.id) ? migrateOneNode(n) : n));
  const newEdges = edges.filter(e => {
    if (!targetIds.has(e.target)) return true;
    return !REMOVED_TARGET_HANDLES.has(e.targetHandle);
  });
  return { nodes: newNodes, edges: newEdges, changed: true };
}

/** Migrate top-level + all macroDefs in one pass. Returns the same array
 *  references when no migration was needed (idempotent). */
export function migrateColorInterpolationNodes(
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
export function migrateColorInterpolationInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
