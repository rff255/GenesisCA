/** Generic Agent Platform — LOAD_MODEL migration: split Local Variables into a
 *  cell set (`variables`) and an agent set (`agentVariables`).
 *
 *  Before this milestone `model.variables` was a single list shared by the cell
 *  step AND the agent behaviour/division loops. After the split the agent loops
 *  resolve their Get/Set Variable nodes against `model.agentVariables`. A legacy
 *  agent model whose accumulators live on `variables` would compile its agent
 *  loop with no matching `_var_` decls → a ReferenceError. This migration MOVES
 *  any `variables` entry referenced by the AGENT graph (top-level + macros
 *  reachable from the agent graph) into `agentVariables`, DUPLICATING (a fresh
 *  id + rewriting the agent-graph node configs) when the same variable is ALSO
 *  referenced by the CELL graph.
 *
 *  Idempotent: skipped once `agentVariables` is populated; a model that doesn't
 *  use variables in its agent graph is a no-op. Wired into LOAD_MODEL +
 *  macroImport. Mirrors agentAttributeSplitMigration. */

import type { CAModel, Variable, GraphNode, MacroDef } from './types';

const VAR_NODES = new Set<string>(['getVariable', 'setVariable', 'setArrayElement']);

function freshId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function nodeVarId(n: GraphNode): string | undefined {
  const v = n.data?.config?.variableId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

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

export function migrateVariableScopeSplit(model: CAModel): CAModel {
  if (!model.topologyMode?.agents) return model;
  if (model.agentVariables && model.agentVariables.length > 0) return model;
  const agentNodes = model.agentGraphNodes ?? [];
  const variables = model.variables ?? [];
  if (agentNodes.length === 0 || variables.length === 0) {
    return model.agentVariables ? model : { ...model, agentVariables: [] };
  }

  // Variable ids referenced by the AGENT graph (top-level + reachable macros).
  const agentMacroIds = new Set<string>();
  reachableMacros(agentNodes, model.macroDefs ?? [], agentMacroIds);
  const agentMacroNodes = (model.macroDefs ?? []).filter(d => agentMacroIds.has(d.id)).flatMap(d => d.nodes);
  const agentVarRefs = new Set<string>();
  for (const n of [...agentNodes, ...agentMacroNodes]) {
    if (VAR_NODES.has(n.data?.nodeType as string)) { const v = nodeVarId(n); if (v) agentVarRefs.add(v); }
  }
  if (agentVarRefs.size === 0) return { ...model, agentVariables: [] };

  // Variable ids referenced by the CELL graph (top-level + reachable macros).
  const cellMacroIds = new Set<string>();
  reachableMacros(model.graphNodes ?? [], model.macroDefs ?? [], cellMacroIds);
  const cellMacroNodes = (model.macroDefs ?? []).filter(d => cellMacroIds.has(d.id)).flatMap(d => d.nodes);
  const cellVarRefs = new Set<string>();
  for (const n of [...(model.graphNodes ?? []), ...cellMacroNodes]) {
    if (VAR_NODES.has(n.data?.nodeType as string)) { const v = nodeVarId(n); if (v) cellVarRefs.add(v); }
  }

  const agentVariables: Variable[] = [];
  const movedIds = new Set<string>();
  const idRewrites = new Map<string, string>();   // DUPLICATE: old id → clone id
  for (const v of variables) {
    if (!agentVarRefs.has(v.id)) continue;
    if (cellVarRefs.has(v.id)) {
      // DUPLICATE — clone into agentVariables with a fresh id; rewrite the
      // agent-graph references; the original stays a cell variable.
      const clone: Variable = { ...v, id: freshId() };
      agentVariables.push(clone);
      idRewrites.set(v.id, clone.id);
    } else {
      // MOVE — relocate into agentVariables (node configs keep the id).
      agentVariables.push({ ...v });
      movedIds.add(v.id);
    }
  }
  if (agentVariables.length === 0) return { ...model, agentVariables: [] };

  const finalVariables = variables.filter(v => !movedIds.has(v.id));

  // Rewrite DUPLICATE references in the agent graph + reachable agent macros.
  const rewriteNode = (n: GraphNode): GraphNode => {
    if (!VAR_NODES.has(n.data?.nodeType as string)) return n;
    const vid = nodeVarId(n);
    if (vid && idRewrites.has(vid)) {
      return { ...n, data: { ...n.data, config: { ...n.data.config, variableId: idRewrites.get(vid)! } } };
    }
    return n;
  };
  const newAgentGraphNodes = idRewrites.size > 0 ? agentNodes.map(rewriteNode) : agentNodes;
  const newMacroDefs = idRewrites.size > 0
    ? (model.macroDefs ?? []).map(d => agentMacroIds.has(d.id) ? { ...d, nodes: d.nodes.map(rewriteNode) } : d)
    : (model.macroDefs ?? []);

  return {
    ...model,
    variables: finalVariables,
    agentVariables,
    agentGraphNodes: newAgentGraphNodes,
    macroDefs: newMacroDefs,
  };
}
