/** Generic Agent Platform — LOAD_MODEL migration: split agent state out of the
 *  cell attribute set.
 *
 *  Before this milestone the agent engine REUSED the cell attribute set (D-IDX):
 *  the four shipped agent models (Boids, Morphogenesis/Tissue, Chemotaxis, Agent
 *  WASM Drift) stored per-agent state in CELL attributes. After the split agents
 *  own a SEPARATE `agentAttributes[]` set, and cell attributes the agents merely
 *  read/write as the field/environment carry an `agentAccess` permission.
 *
 *  This migration classifies each cell attribute by HOW THE AGENT GRAPH references
 *  it and rewrites the model so it loads byte-behaviourally unchanged:
 *    - referenced as agent STATE (Get/Set/Update Attribute, Get/Set Agent
 *      Attribute by id, …) AND not otherwise needed as a cell attribute → MOVE it
 *      into `agentAttributes` (the agent-graph node configs keep its id).
 *    - referenced as agent state AND also genuinely a cell attribute (used by the
 *      CELL graph / a mapping / an indicator / an agent FIELD node) → DUPLICATE:
 *      clone it into `agentAttributes` with a fresh id, rewrite ONLY the
 *      agent-state node configs to the clone, leave the original a cell attribute
 *      (and set `agentAccess` if a field node also targets it).
 *    - referenced only as a FIELD (Sample/Read/Field-Gradient = read;
 *      Affect/Secrete = write) → STAY a cell attribute, set `agentAccess`.
 *  Cell-graph usage NEVER triggers a move (e.g. Chemotaxis's `chemical` is a cell
 *  field diffused by the CELL graph AND read/secreted by agents → it STAYS a cell
 *  attr with `agentAccess: 'readWrite'`).
 *
 *  Idempotent: once `agentAttributes` is populated the model is treated as
 *  already-split and skipped (a freshly authored post-split model sets
 *  `agentAttributes` directly and never needs this). Wired into LOAD_MODEL +
 *  macroImport.
 *
 *  Known limitation: the DUPLICATE config-rewrite walks the agent graph's
 *  top-level nodes + the macros reachable from agent-graph macro instances. A
 *  macro SHARED with the cell graph that internally reads a duplicated attribute
 *  as agent-state is not handled (none of the shipped models do this). */

import type { CAModel, Attribute, GraphNode, MacroDef } from './types';

/** Agent-graph node types that reference an attribute as AGENT STATE (own or
 *  another agent's), via `config.attributeId`. */
const AGENT_STATE_NODES = new Set<string>([
  // NB `setAttribute` covers the retired `setAgentAttribute` too: this migration
  // runs AFTER `migrateSetAgentAttribute` at both call sites (LOAD_MODEL and the
  // dev harness), so a legacy by-id write has already become a `setAttribute`.
  'getCellAttribute', 'setAttribute', 'updateAttribute',
  'getAgentAttribute',
  // PR3 array nodes (forward-compat — harmless if absent in a v1 file)
  'getAgentsAttribute', 'filterAgents',
]);
const FIELD_READ_NODES = new Set<string>(['sampleField', 'fieldGradient', 'readCellsUnder']);
const FIELD_WRITE_NODES = new Set<string>(['affectCellsUnder', 'secreteToField']);

function freshId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function nodeAttrId(n: GraphNode): string | undefined {
  const v = n.data?.config?.attributeId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Collect the macroDefs reachable from a set of graph nodes (following macro
 *  instances), so the agent-state rewrite reaches in-macro references. */
function reachableMacros(nodes: GraphNode[], macroDefs: MacroDef[], acc: Set<string>): void {
  for (const n of nodes) {
    if (n.data?.nodeType === 'macro') {
      const defId = n.data.config?.macroDefId;
      if (typeof defId === 'string' && !acc.has(defId)) {
        acc.add(defId);
        const def = macroDefs.find(d => d.id === defId);
        if (def) reachableMacros(def.nodes, macroDefs, acc);
      }
    }
  }
}

export function migrateAgentAttributeSplit(model: CAModel): CAModel {
  // Only legacy agent models need splitting. Non-agent models + already-split
  // models (agentAttributes populated) are untouched.
  if (!model.topologyMode?.agents) return model;
  if (model.agentAttributes && model.agentAttributes.length > 0) return model;

  const agentNodes = model.agentGraphNodes ?? [];
  if (agentNodes.length === 0) return model;

  // Macros reachable from the AGENT graph (for in-macro state/field references).
  const agentMacroIds = new Set<string>();
  reachableMacros(agentNodes, model.macroDefs ?? [], agentMacroIds);
  const agentMacroNodes: GraphNode[] = (model.macroDefs ?? [])
    .filter(d => agentMacroIds.has(d.id))
    .flatMap(d => d.nodes);
  const allAgentScopeNodes = [...agentNodes, ...agentMacroNodes];

  // Classify each cell attribute by its AGENT-graph usage.
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const stateRefIds = new Set<string>();   // referenced as agent state
  const fieldReadIds = new Set<string>();
  const fieldWriteIds = new Set<string>();
  for (const n of allAgentScopeNodes) {
    const t = n.data?.nodeType as string;
    const aid = nodeAttrId(n);
    if (!aid) continue;
    if (AGENT_STATE_NODES.has(t)) stateRefIds.add(aid);
    else if (FIELD_READ_NODES.has(t)) fieldReadIds.add(aid);
    else if (FIELD_WRITE_NODES.has(t)) fieldWriteIds.add(aid);
  }
  if (stateRefIds.size === 0 && fieldReadIds.size === 0 && fieldWriteIds.size === 0) {
    return model; // agent graph touches no cell attributes (e.g. pure-geometry Boids)
  }

  // Is an attribute genuinely needed as a CELL attribute (so an agent-state ref
  // must DUPLICATE rather than MOVE)? True when the CELL graph, a mapping, an
  // indicator, OR an agent FIELD node references it.
  const cellGraphAttrIds = new Set<string>();
  for (const n of model.graphNodes ?? []) { const a = nodeAttrId(n); if (a) cellGraphAttrIds.add(a); }
  // Cell-graph macros' internal attribute refs too.
  const cellMacroIds = new Set<string>();
  reachableMacros(model.graphNodes ?? [], model.macroDefs ?? [], cellMacroIds);
  for (const d of model.macroDefs ?? []) {
    if (!cellMacroIds.has(d.id)) continue;
    for (const n of d.nodes) { const a = nodeAttrId(n); if (a) cellGraphAttrIds.add(a); }
  }
  for (const m of model.mappings ?? []) if (m.linkedAttributeId) cellGraphAttrIds.add(m.linkedAttributeId);
  for (const i of model.indicators ?? []) if (i.linkedAttributeId) cellGraphAttrIds.add(i.linkedAttributeId);

  const neededAsCell = (id: string): boolean =>
    cellGraphAttrIds.has(id) || fieldReadIds.has(id) || fieldWriteIds.has(id);

  const accessFor = (id: string): 'read' | 'readWrite' | undefined => {
    if (fieldWriteIds.has(id)) return 'readWrite';
    if (fieldReadIds.has(id)) return 'read';
    return undefined;
  };

  // Build the new attribute lists.
  const newAttributes = [...model.attributes];     // we mutate copies of entries
  const agentAttributes: Attribute[] = [];
  const idRewrites: Array<{ from: string; to: string }> = [];   // DUPLICATE rewrites
  const movedIds = new Set<string>();

  for (const a of cellAttrs) {
    const isState = stateRefIds.has(a.id);
    if (isState && neededAsCell(a.id)) {
      // DUPLICATE — clone into agentAttributes with a fresh id; agent-state refs
      // point at the clone; the original stays a cell attr (+ field access).
      const clone: Attribute = { ...a, id: freshId() };
      agentAttributes.push(clone);
      idRewrites.push({ from: a.id, to: clone.id });
      const acc = accessFor(a.id);
      if (acc) {
        const idx = newAttributes.findIndex(x => x.id === a.id);
        if (idx >= 0) newAttributes[idx] = { ...newAttributes[idx]!, agentAccess: acc };
      }
    } else if (isState) {
      // MOVE — relocate the attribute into agentAttributes (node configs keep its id).
      agentAttributes.push({ ...a });
      movedIds.add(a.id);
    } else {
      // FIELD-only — stay a cell attr, set the access permission.
      const acc = accessFor(a.id);
      if (acc) {
        const idx = newAttributes.findIndex(x => x.id === a.id);
        if (idx >= 0) newAttributes[idx] = { ...newAttributes[idx]!, agentAccess: acc };
      }
    }
  }

  // Apply the MOVE removals.
  const finalAttributes = newAttributes.filter(a => !movedIds.has(a.id));

  // Apply the DUPLICATE id rewrites to the AGENT-state nodes (top-level + agent
  // macros). Only state nodes are rewritten — field nodes keep the cell id.
  const rewriteMap = new Map(idRewrites.map(r => [r.from, r.to]));
  const rewriteNode = (n: GraphNode): GraphNode => {
    const t = n.data?.nodeType as string;
    const aid = nodeAttrId(n);
    if (aid && AGENT_STATE_NODES.has(t) && rewriteMap.has(aid)) {
      return { ...n, data: { ...n.data, config: { ...n.data.config, attributeId: rewriteMap.get(aid)! } } };
    }
    return n;
  };
  const newAgentGraphNodes = rewriteMap.size > 0 ? agentNodes.map(rewriteNode) : agentNodes;
  const newMacroDefs = rewriteMap.size > 0
    ? (model.macroDefs ?? []).map(d =>
        agentMacroIds.has(d.id) ? { ...d, nodes: d.nodes.map(rewriteNode) } : d)
    : (model.macroDefs ?? []);

  return {
    ...model,
    attributes: finalAttributes,
    agentAttributes,
    agentGraphNodes: newAgentGraphNodes,
    macroDefs: newMacroDefs,
  };
}
