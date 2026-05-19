/**
 * Runtime migration: rewrite any legacy `tagConstant` node into the equivalent
 * `getConstant` with `constType: 'tag'`. TagConstant was a hidden, palette-less
 * node type that emitted a single integer (the tag index); GetConstant's tag
 * mode already exposes the exact same picker UI (tag attribute + tag option)
 * and compiles identically on all three targets — so the two were redundant.
 *
 * Migration policy:
 *   - `data.nodeType` flips from 'tagConstant' to 'getConstant'.
 *   - Old `config.attributeId` becomes new `config.tagAttributeId`.
 *   - Old `config.tagIndex` (a number) becomes new `config.constValue` (the
 *     stringified index — GetConstant stores constValue as a string).
 *   - `config.constType` is set to 'tag'.
 *   - Edges are unaffected: both nodes expose the same single output port
 *     `value` with handle `output_value_value`, so no edge rewrites needed.
 *
 * Idempotent: when no `tagConstant` nodes are found, the input references are
 * returned unchanged.
 */

import type { GraphNode, GraphEdge, MacroDef } from './types';

function migrateOneNode(node: GraphNode): GraphNode {
  const cfg = node.data.config as Record<string, string | number | boolean>;
  const attributeId = (cfg.attributeId as string) ?? '';
  const tagIndex = Number(cfg.tagIndex) || 0;

  const newCfg: Record<string, string | number | boolean> = {
    constType: 'tag',
    tagAttributeId: attributeId,
    constValue: String(tagIndex),
  };

  return {
    ...node,
    data: { ...node.data, nodeType: 'getConstant', config: newCfg },
  };
}

function migratePair(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  const targetIds = new Set<string>();
  for (const n of nodes) {
    if (n.data?.nodeType === 'tagConstant') targetIds.add(n.id);
  }
  if (targetIds.size === 0) return { nodes, edges, changed: false };

  const newNodes = nodes.map(n => (targetIds.has(n.id) ? migrateOneNode(n) : n));
  // Edges unchanged — both nodes share the same `value` output port.
  return { nodes: newNodes, edges, changed: true };
}

/** Migrate top-level + all macroDefs in one pass. Returns the same array
 *  references when no migration was needed (idempotent). */
export function migrateTagConstantNodes(
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
export function migrateTagConstantInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
