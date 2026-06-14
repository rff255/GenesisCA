/**
 * Runtime migration: rewrite legacy `setColorViewer` and `setCellGlyph` nodes
 * into the merged `setCellLooks` node.
 *
 *  - `setColorViewer` → `setCellLooks` with `useGlyph:false, setBackground:true`.
 *    Its R/G/B were the cell color and stay on the `r`/`g`/`b` ports — edges and
 *    `_port_r/g/b` config keys are unchanged.
 *  - `setCellGlyph` → `setCellLooks` with `useGlyph:true, setBackground:false,
 *    fallbackToGlyphColor:false`. Its R/G/B were the GLYPH color, which in the
 *    merged node live on `glyphR`/`glyphG`/`glyphB`, so:
 *      - edges targeting `input_value_r/g/b` are rewritten to
 *        `input_value_glyphR/glyphG/glyphB`;
 *      - inline config keys `_port_r/g/b` are renamed to `_port_glyphR/G/B`;
 *      - the `glyph` port (codepoint) and its `_port_glyph` are unchanged.
 *    `setBackground:false` preserves the old behaviour where the glyph node never
 *    touched the `colors` buffer (so a model that paired a Set Color Viewer for
 *    the background with a Set Cell Glyph still renders identically).
 *
 * Idempotent: only `setColorViewer`/`setCellGlyph` typed nodes are touched.
 */

import type { GraphNode, GraphEdge, MacroDef } from './types';

const GLYPH_CHANNEL_REMAP: Record<string, string> = {
  input_value_r: 'input_value_glyphR',
  input_value_g: 'input_value_glyphG',
  input_value_b: 'input_value_glyphB',
};

function migrateColorViewer(node: GraphNode): GraphNode {
  const cfg = node.data.config as Record<string, string | number | boolean>;
  return {
    ...node,
    data: {
      ...node.data,
      nodeType: 'setCellLooks',
      config: { ...cfg, useGlyph: false, setBackground: true, fallbackToGlyphColor: false },
    },
  };
}

function migrateGlyph(node: GraphNode): GraphNode {
  const cfg = node.data.config as Record<string, string | number | boolean>;
  const newCfg: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === '_port_r') newCfg['_port_glyphR'] = v;
    else if (k === '_port_g') newCfg['_port_glyphG'] = v;
    else if (k === '_port_b') newCfg['_port_glyphB'] = v;
    else newCfg[k] = v;
  }
  newCfg.useGlyph = true;
  newCfg.setBackground = false;
  newCfg.fallbackToGlyphColor = false;
  return {
    ...node,
    data: { ...node.data, nodeType: 'setCellLooks', config: newCfg },
  };
}

function migratePair(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  const glyphIds = new Set<string>();
  let any = false;
  const newNodes = nodes.map(n => {
    const t = n.data?.nodeType;
    if (t === 'setColorViewer') { any = true; return migrateColorViewer(n); }
    if (t === 'setCellGlyph') { any = true; glyphIds.add(n.id); return migrateGlyph(n); }
    return n;
  });
  if (!any) return { nodes, edges, changed: false };

  // Only glyph-node edges need handle rewrites (r/g/b → glyphR/G/B).
  const newEdges = glyphIds.size === 0 ? edges : edges.map(e => {
    if (!glyphIds.has(e.target)) return e;
    const remapped = e.targetHandle ? GLYPH_CHANNEL_REMAP[e.targetHandle] : undefined;
    return remapped ? { ...e, targetHandle: remapped } : e;
  });
  return { nodes: newNodes, edges: newEdges, changed: true };
}

/** Migrate top-level + all macroDefs in one pass. Returns the same array
 *  references when no migration was needed (idempotent). */
export function migrateSetCellLooksNodes(
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
export function migrateSetCellLooksInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
