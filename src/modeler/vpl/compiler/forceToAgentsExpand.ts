/**
 * Apply Force To Agents (array broadcast) — target-independent pre-compile graph
 * transform. Editor sugar that lowers each `applyForceToAgents` node into
 * `For Each In Array → Apply Force To Agent`: the forEach walks the node's `agents`
 * id array and its body applies the same force to each element via the SINGLE-agent
 * `applyForceToAgent` primitive.
 *
 * So the array node reuses `applyForceToAgent`'s JS / WASM / WebGPU emitters
 * ENTIRELY — ZERO new per-target emit, the sanctioned "lower to primitives" pattern
 * (`expandMacros` / `collapseReroutes` / `expandMultiAttrs` / `lowerVectorAttrs` /
 * `expandComposites`). Runs in all three agent front-ends right after
 * `collapseReroutes`; the agent-target GATE then inspects the FLATTENED graph and
 * sees only `forEachInArray` + `applyForceToAgent` (both already supported), so
 * `applyForceToAgents` needs no entry in any supported-types set. Bit-parity is
 * inherited from the two verified primitives. Semantically identical to the
 * hand-built For-Each pattern (the same commutative `+=` per element; the force
 * inputs are loop-invariant unless they depend on the element, so the compiler
 * hoists them out of the loop). Hot-path no-op when no `applyForceToAgents` node.
 */

import type { CAModel, GraphNode, GraphEdge } from '../../../model/types';

/** The inline force keys carried onto the synthesized single-agent node. */
const FORCE_INLINE_KEYS = ['_port_fx', '_port_fy', '_port_fz'] as const;

export function expandForceToAgents(
  nodes: GraphNode[], edges: GraphEdge[], _model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let any = false;
  for (const nd of nodes) if (nd.data.nodeType === 'applyForceToAgents') { any = true; break; }
  if (!any) return { nodes, edges };

  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  const remapSrc = new Map<string, { source: string; sourceHandle: string }>();
  const remapTgt = new Map<string, { target: string; targetHandle: string }>();
  const expandedIds = new Set<string>();

  for (const nd of nodes) {
    if (nd.data.nodeType !== 'applyForceToAgents') { outNodes.push(nd); continue; }
    expandedIds.add(nd.id);
    // Deterministic ids (WASM/WebGPU recompiles stay byte-stable).
    const feId = `${nd.id}__afaFe`;
    const afId = `${nd.id}__afaAf`;
    // Copy the inline force values onto the single-agent node. A WIRED fx/fy/fz edge
    // (remapped below) overrides the inline in the compiler — exactly as it does on
    // the array node itself, so wired and inline forces behave identically.
    const afCfg: Record<string, string | number | boolean> = {};
    for (const k of FORCE_INLINE_KEYS) {
      const val = nd.data.config[k];
      if (val !== undefined) afCfg[k] = val as string | number | boolean;
    }
    outNodes.push({ id: feId, type: 'caNode', position: nd.position, data: { nodeType: 'forEachInArray', config: {} } });
    outNodes.push({ id: afId, type: 'caNode', position: nd.position, data: { nodeType: 'applyForceToAgent', config: afCfg } });
    // Internal wiring: forEach body → the single apply-force; element → its agentId.
    outEdges.push({ id: `${nd.id}__afaE0`, source: feId, sourceHandle: 'output_flow_body', target: afId, targetHandle: 'input_flow_do' });
    outEdges.push({ id: `${nd.id}__afaE1`, source: feId, sourceHandle: 'output_value_element', target: afId, targetHandle: 'input_value_agentId' });
    // Remap the array node's external ports onto the subgraph.
    remapTgt.set(`${nd.id} input_flow_do`, { target: feId, targetHandle: 'input_flow_do' });
    remapTgt.set(`${nd.id} input_value_agents`, { target: feId, targetHandle: 'input_value_array' });
    remapTgt.set(`${nd.id} input_value_fx`, { target: afId, targetHandle: 'input_value_fx' });
    remapTgt.set(`${nd.id} input_value_fy`, { target: afId, targetHandle: 'input_value_fy' });
    remapTgt.set(`${nd.id} input_value_fz`, { target: afId, targetHandle: 'input_value_fz' });
    // The array node's former DONE (next) consumers run AFTER the whole loop.
    remapSrc.set(`${nd.id} output_flow_next`, { source: feId, sourceHandle: 'output_flow_next' });
  }

  for (const e of edges) {
    const rs = remapSrc.get(`${e.source} ${e.sourceHandle}`);
    const rt = remapTgt.get(`${e.target} ${e.targetHandle}`);
    // An edge touching a REMOVED node's port that no remap claimed is stale → drop.
    if (!rs && expandedIds.has(e.source)) continue;
    if (!rt && expandedIds.has(e.target)) continue;
    outEdges.push({
      ...e,
      source: rs ? rs.source : e.source,
      sourceHandle: rs ? rs.sourceHandle : e.sourceHandle,
      target: rt ? rt.target : e.target,
      targetHandle: rt ? rt.targetHandle : e.targetHandle,
    });
  }

  return { nodes: outNodes, edges: outEdges };
}
