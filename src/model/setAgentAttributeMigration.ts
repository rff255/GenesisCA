/**
 * Runtime migration: rewrite every legacy `setAgentAttribute` node into the
 * equivalent `setAttribute`.
 *
 * The two nodes became redundant the moment Set Attribute gained its optional
 * `agentId` port: on the Agents graph a Set Attribute with `Agent` WIRED already
 * emits exactly what Set Agent Attribute emitted — the same range-guarded
 * `w_<attr>[id]` write on JS, the same `emitGuardedAgentWrite` block on WASM, the
 * same `if (id >= 0 && id < maxAgents)` line in WGSL. So one verb covers both
 * "write my own attribute" and "write another agent's", and the second node was a
 * duplicate spelling of an op the first already emits (the user's rule: an action
 * either takes an optional agent id defaulting to self, or has a by-id sibling —
 * never both spellings of the same write).
 *
 * Migration policy — a PURE nodeType rename, with NO handle or config rewrites,
 * because the two defs already matched slot for slot:
 *   - both carry `do` / `next`, `agentId` (same port id!) and `value`;
 *   - both are multi-slot accessors, so `extraCount` / `attr_${i}` /
 *     `_port_value_${i}` / the `value_${i}` handles mean the same thing on both;
 *   - `attributeId` is the same config key.
 * The only declared difference is the `value` port's dataType (`float` → `any`),
 * which is strictly MORE permissive — no existing edge can become invalid.
 *
 * Because node ids, edge ids, both array orders and every handle are preserved,
 * the adjacency the compilers walk is unchanged — which is what makes a migrated
 * model's emitted code BYTE-IDENTICAL on all three agent targets.
 *
 * Idempotent: a model with no `setAgentAttribute` node is returned with its
 * original array references.
 */

import type { CAModel, GraphNode, GraphEdge, MacroDef } from './types';

const OLD_TYPE = 'setAgentAttribute';
const NEW_TYPE = 'setAttribute';

function migratePair(
  nodes: GraphNode[] | undefined,
  edges: GraphEdge[] | undefined,
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  const ns = nodes ?? [];
  const es = edges ?? [];
  let found = false;
  for (const n of ns) if (n.data?.nodeType === OLD_TYPE) { found = true; break; }
  if (!found) return { nodes: ns, edges: es, changed: false };

  const newNodes = ns.map(n => (n.data?.nodeType === OLD_TYPE
    ? { ...n, data: { ...n.data, nodeType: NEW_TYPE } }
    : n));
  // Edges are untouched: every handle id is identical on the two defs.
  return { nodes: newNodes, edges: es, changed: true };
}

/** Migrate every graph a `setAgentAttribute` node could sit in.
 *
 *  The node was `requirements: { bondGraph: true }`, so the app could only place
 *  it on the AGENTS graph — but `macroDefs` are shared across graphs, and the
 *  cell / overseer stores are swept defensively so a hand-edited file cannot
 *  strand a node type the registry no longer knows. Returns the same model
 *  reference when nothing matched. */
export function migrateSetAgentAttribute(model: CAModel): CAModel {
  const agent = migratePair(model.agentGraphNodes, model.agentGraphEdges);
  const cell = migratePair(model.graphNodes, model.graphEdges);
  const overseer = migratePair(model.overseerGraphNodes, model.overseerGraphEdges);

  let anyMacroChanged = false;
  const newMacroDefs = (model.macroDefs ?? []).map(md => {
    const r = migratePair(md.nodes, md.edges);
    if (!r.changed) return md;
    anyMacroChanged = true;
    return { ...md, nodes: r.nodes, edges: r.edges } as MacroDef;
  });

  if (!agent.changed && !cell.changed && !overseer.changed && !anyMacroChanged) return model;
  return {
    ...model,
    ...(agent.changed ? { agentGraphNodes: agent.nodes, agentGraphEdges: agent.edges } : {}),
    ...(cell.changed ? { graphNodes: cell.nodes, graphEdges: cell.edges } : {}),
    ...(overseer.changed ? { overseerGraphNodes: overseer.nodes, overseerGraphEdges: overseer.edges } : {}),
    macroDefs: anyMacroChanged ? newMacroDefs : model.macroDefs,
  };
}

/** Convenience for macro-import call sites — migrates one MacroDef in place
 *  (returns the same reference if nothing matched). */
export function migrateSetAgentAttributeInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
