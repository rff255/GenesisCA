/**
 * Runtime migration: rewrite every legacy `setAgentsAttribute` node into the
 * equivalent `setAttribute`.
 *
 * The two nodes became redundant the moment Set Attribute's optional `agentId`
 * port became SCALAR-OR-ARRAY: a Set Attribute whose `Agent` input is wired to
 * an id array already emits exactly what Set Agents Attribute emitted — the same
 * `_si`/`_sa` guarded write-many loop on JS, the same `emitSetAgentsAttribute`
 * block on WASM, the same `sasK`/`sasId`/`sasV` WGSL loop. So ONE verb covers
 * "write my own attribute", "write that agent's" and "write every agent in this
 * list", and the second node was a duplicate spelling of a write the first
 * already emits (the user's rule: an action either takes an optional agent id
 * defaulting to self, or has a by-id sibling — never both spellings of one
 * write). It also gains what only Set Attribute had: MULTI-SLOT writes, so one
 * node can now set several attributes on a whole group.
 *
 * Migration policy — a nodeType rename plus ONE handle rewrite, because the two
 * defs otherwise matched slot for slot:
 *   - both carry `do` / `next` and `value` (same id, same inline widget, same
 *     `_port_value` config key, same `'0'` default — the `value` port's dataType
 *     widens `float` → `any`, which is strictly MORE permissive, so no existing
 *     edge can become invalid);
 *   - `attributeId` is the same config key;
 *   - the id input is named `agents` on the old def and `agentId` on the new
 *     one, so an edge into it is retargeted `input_value_agents` →
 *     `input_value_agentId`. Nothing else about the edge changes.
 * `setAgentsAttribute` had no multi-slot support, so there are no `extraCount` /
 * `attr_${i}` / `value_${i}` keys or handles to consider.
 *
 * Because node ids, edge ids, both array orders and every other handle are
 * preserved, the adjacency the compilers walk is unchanged — which is what makes
 * a migrated model's emitted code BYTE-IDENTICAL on all three agent targets.
 *
 * Ordering: this runs BEFORE `migrateAgentAttributeSplit`, which is why that
 * migration's node-type set needs only `setAttribute`.
 *
 * Idempotent: a model with no `setAgentsAttribute` node is returned with its
 * original array references.
 */

import type { CAModel, GraphNode, GraphEdge, MacroDef } from './types';

const OLD_TYPE = 'setAgentsAttribute';
const NEW_TYPE = 'setAttribute';
const OLD_HANDLE = 'input_value_agents';
const NEW_HANDLE = 'input_value_agentId';

function migratePair(
  nodes: GraphNode[] | undefined,
  edges: GraphEdge[] | undefined,
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  const ns = nodes ?? [];
  const es = edges ?? [];
  const oldIds = new Set<string>();
  for (const n of ns) if (n.data?.nodeType === OLD_TYPE) oldIds.add(n.id);
  if (oldIds.size === 0) return { nodes: ns, edges: es, changed: false };

  const newNodes = ns.map(n => (oldIds.has(n.id)
    ? { ...n, data: { ...n.data, nodeType: NEW_TYPE } }
    : n));
  // Retarget the id input only on the migrated nodes — the handle name is
  // shared with nothing else, but scoping it to the rewritten nodes keeps a
  // hand-edited file from having an unrelated `agents` edge rewired.
  const newEdges = es.map(e => (oldIds.has(e.target) && e.targetHandle === OLD_HANDLE
    ? { ...e, targetHandle: NEW_HANDLE }
    : e));
  return { nodes: newNodes, edges: newEdges, changed: true };
}

/** Migrate every graph a `setAgentsAttribute` node could sit in.
 *
 *  The node was `requirements: { bondGraph: true }`, so the app could only place
 *  it on the AGENTS graph — but `macroDefs` are shared across graphs, and the
 *  cell / overseer stores are swept defensively so a hand-edited file cannot
 *  strand a node type the registry no longer knows. Returns the same model
 *  reference when nothing matched. */
export function migrateSetAgentsAttribute(model: CAModel): CAModel {
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
export function migrateSetAgentsAttributeInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
