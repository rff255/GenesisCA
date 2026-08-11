/**
 * Runtime migration: rewrite every legacy `formBondBetween` node into the
 * equivalent `formBond` with its FIRST endpoint wired.
 *
 * The two nodes became redundant the moment Form Bond gained its optional
 * `agentA` port: a Form Bond with `agentA` WIRED already LOWERS to the exact
 * Form Between queue encoding (the NEGATIVE break lane — see
 * `bondRequestQueue.ts` and `bondRequestEmitJS.ts`), on all three agent targets.
 * So one verb covers both "bond me to X" and "bond X to Y", and the second node
 * was a duplicate spelling of an op the first already emits.
 *
 * ⚠️ THE QUEUE ENCODING IS NOT RETIRED — only the NODE is. The negative-break-lane
 * op kind is what a wired Form Bond lowers to, and the engine drain's Form Between
 * arm is untouched.
 *
 * Migration policy — a pure rename plus ONE port remap, because everything else
 * already matches port-for-port (both defs carry `do`/`next`, `restLength`,
 * `stiffness`, and the same dynamic `bondAttr_<id>` ports from the shared
 * `buildBondAttrPorts`):
 *   - `data.nodeType` flips from 'formBondBetween' to 'formBond'.
 *   - `agentA` → `agentA` (unchanged; it is the port that makes the op a pair op).
 *   - `agentB` → `targetAgent`: any edge whose `targetHandle` is
 *     `input_value_agentB` is re-pointed at `input_value_targetAgent`, and a
 *     stale `_port_agentB` inline key is re-keyed to `_port_targetAgent`.
 *     (Neither port carries an inline widget, so the config key should not exist
 *     in a file the app wrote — it is handled for hand-edited files.)
 *
 * A migrated node emits BYTE-IDENTICAL code on JS / WASM / WebGPU: all three
 * emitters resolve `agentA` and then the second id, and route a wired `agentA`
 * through the very same `between` branch the old node took unconditionally.
 *
 * Idempotent: a model with no `formBondBetween` node is returned with its
 * original array references.
 */

import type { CAModel, GraphNode, GraphEdge, MacroDef } from './types';

const OLD_TYPE = 'formBondBetween';
const NEW_TYPE = 'formBond';
/** The second endpoint's port id on each def. */
const OLD_B_PORT = 'agentB';
const NEW_B_PORT = 'targetAgent';
const OLD_B_HANDLE = `input_value_${OLD_B_PORT}`;
const NEW_B_HANDLE = `input_value_${NEW_B_PORT}`;
const OLD_B_CFG = `_port_${OLD_B_PORT}`;
const NEW_B_CFG = `_port_${NEW_B_PORT}`;

function migrateOneNode(node: GraphNode): GraphNode {
  const cfg = (node.data.config ?? {}) as Record<string, unknown>;
  let newCfg = cfg;
  if (OLD_B_CFG in cfg) {
    newCfg = { ...cfg };
    newCfg[NEW_B_CFG] = cfg[OLD_B_CFG];
    delete newCfg[OLD_B_CFG];
  }
  return {
    ...node,
    data: {
      ...node.data,
      nodeType: NEW_TYPE,
      config: newCfg as GraphNode['data']['config'],
    },
  };
}

function migratePair(
  nodes: GraphNode[] | undefined,
  edges: GraphEdge[] | undefined,
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  const ns = nodes ?? [];
  const es = edges ?? [];
  const targetIds = new Set<string>();
  for (const n of ns) if (n.data?.nodeType === OLD_TYPE) targetIds.add(n.id);
  if (targetIds.size === 0) return { nodes: ns, edges: es, changed: false };

  const newNodes = ns.map(n => (targetIds.has(n.id) ? migrateOneNode(n) : n));
  // Re-point the second endpoint's edges. Node ids, edge ids and BOTH array
  // orders are preserved, so the adjacency the compilers walk is unchanged —
  // which is what keeps the emitted code byte-identical.
  const newEdges = es.map(e =>
    targetIds.has(e.target) && e.targetHandle === OLD_B_HANDLE
      ? { ...e, targetHandle: NEW_B_HANDLE }
      : e);
  return { nodes: newNodes, edges: newEdges, changed: true };
}

/** Migrate every graph a `formBondBetween` node could sit in.
 *
 *  The node is `requirements: { bondGraph: true }`, so the app can only place it
 *  on the AGENTS graph — but `macroDefs` are shared across graphs, and the cell /
 *  overseer stores are swept defensively so a hand-edited file cannot strand a
 *  node type the registry no longer knows. Returns the same model reference when
 *  nothing matched. */
export function migrateFormBondBetween(model: CAModel): CAModel {
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
export function migrateFormBondBetweenInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
