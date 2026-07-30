/**
 * Neighbour State Census — target-independent pre-compile graph transform.
 *
 * A `neighbourCensus` node is EDITOR SUGAR for the hand-wired
 *
 *     Get Bonded Agents ─┐
 *     (or Get Nearby)    ├→ Get Agents Attribute ─┬→ Count Matching(== option 0) → count_0
 *                        ┘                        ├→ Count Matching(== option 1) → count_1
 *                                                 ├→ …
 *                                                 └→ Array Length              → total
 *
 * chain, once per state value of a tag/bool AGENT attribute. This module rewrites
 * each census node into exactly that chain BEFORE any target compiles, so the
 * census reuses the already-verified `getBondedAgents` / `getNearbyAgents` /
 * `getAgentsAttribute` / `groupCounting` / `getConstant` / `arrayLength` emitters
 * ENTIRELY — **ZERO new per-target emit**, the sanctioned "lower to primitives"
 * pattern (`expandMacros` / `collapseReroutes` / `expandMultiAttrs` /
 * `lowerVectorAttrs` / `expandComposites` / `expandForceToAgents`).
 *
 * It runs in all three agent front-ends right after `collapseReroutes`; the
 * agent-target GATE then inspects the FLATTENED graph and sees only node types it
 * already supports, so `neighbourCensus` needs no entry in
 * `AGENT_WASM_SUPPORTED_TYPES` / `AGENT_WEBGPU_SUPPORTED_TYPES` and runs on JS,
 * WASM and WebGPU by construction. Bit-parity is inherited from the primitives.
 *
 * Three rules the implementation must keep:
 *  - **Deterministic synthetic ids** (`${censusId}__cn…`) so WASM bytes / WGSL text
 *    stay byte-stable across recompiles (the `multiAttrExpand` discipline).
 *  - **Emit only CONSUMED ports** — an unconsumed count must synthesize nothing, or
 *    a 4-state census would cost 4 count loops when the rule reads one.
 *  - **Share the gather** — ONE `getBondedAgents`/`getNearbyAgents` and ONE
 *    `getAgentsAttribute` per census node, fanned out to every counter. (Do NOT
 *    rely on accessor-CSE: it is gated OFF in async agent mode.)
 *
 * Hot-path no-op when the graph has no census node (returns the SAME arrays), so
 * every existing model compiles byte-identically.
 */

import type { Attribute, CAModel, GraphNode, GraphEdge } from '../../../model/types';
import type { PortDef } from '../types';
import { agentAttrsOf } from '../../../model/attributeScope';

/** One selectable state of a census attribute: the port label + the numeric value
 *  the agent SoA holds for it (a tag INDEX, or 0/1 for a bool). */
export interface CensusOption {
  label: string;
  value: number;
}

/** The attribute types a census can enumerate. An integer/float attribute has no
 *  finite option set (a "binned census" is a separate feature), so only tag and
 *  bool qualify. */
export const CENSUS_ATTR_TYPES: ReadonlySet<string> = new Set(['tag', 'bool']);

/** The census attributes offered for a model: the AGENT attributes of tag/bool
 *  type. (Agents read their own SoA — a cell attribute is not a neighbour state.) */
export function censusAttributes(model?: Pick<CAModel, 'attributes' | 'agentAttributes'> | null): Attribute[] {
  if (!model) return [];
  return agentAttrsOf(model as CAModel).filter(a => CENSUS_ATTR_TYPES.has(a.type));
}

/** Resolve a census node's attribute, or null when unset / removed / no longer a
 *  tag-or-bool agent attribute. */
export function censusAttribute(
  config: Record<string, unknown> | undefined,
  model?: Pick<CAModel, 'attributes' | 'agentAttributes'> | null,
): Attribute | null {
  const id = typeof config?.['attributeId'] === 'string' ? config['attributeId'] as string : '';
  if (!id) return null;
  return censusAttributes(model).find(a => a.id === id) ?? null;
}

/** The ordered options of a census attribute — one output port each.
 *  tag → its `tagOptions` (index = the stored value); bool → False(0) / True(1). */
export function censusOptions(attr: Attribute | null): CensusOption[] {
  if (!attr) return [];
  if (attr.type === 'bool') return [{ label: 'False', value: 0 }, { label: 'True', value: 1 }];
  return (attr.tagOptions ?? []).map((name, i) => ({ label: name || `Option ${i}`, value: i }));
}

/** The output-port id carrying option `i`'s count. */
export const censusCountPortId = (i: number): string => `count_${i}`;

/** The DYNAMIC ports of a census node — one integer output per state value,
 *  labelled with the option name. Consumed by BOTH CaNode's render path AND
 *  effectivePorts.getEffectivePorts (the `buildExtraSlotPorts` dual-consumption
 *  discipline: if those two drift, drag-and-drop offers ports the canvas never
 *  renders). The static `total` output stays on the node def. */
export function buildCensusPorts(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model?: Pick<CAModel, 'attributes' | 'agentAttributes'> | null,
): { inputs: PortDef[]; outputs: PortDef[] } {
  if (nodeType !== 'neighbourCensus') return { inputs: [], outputs: [] };
  const options = censusOptions(censusAttribute(config, model));
  return {
    inputs: [],
    outputs: options.map((o, i) => ({
      id: censusCountPortId(i), label: o.label,
      kind: 'output' as const, category: 'value' as const, dataType: 'integer' as const,
    })),
  };
}

/** Source-handle → option index, for the "which counts are consumed?" scan. */
const COUNT_HANDLE = /^output_value_count_(\d+)$/;

export function expandNeighbourCensus(
  nodes: GraphNode[], edges: GraphEdge[], model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let any = false;
  for (const nd of nodes) if (nd.data.nodeType === 'neighbourCensus') { any = true; break; }
  if (!any) return { nodes, edges };

  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  const remapSrc = new Map<string, { source: string; sourceHandle: string }>();
  const remapTgt = new Map<string, { target: string; targetHandle: string }>();
  const expandedIds = new Set<string>();

  for (const nd of nodes) {
    if (nd.data.nodeType !== 'neighbourCensus') { outNodes.push(nd); continue; }
    expandedIds.add(nd.id);

    const cfg = nd.data.config ?? {};
    const attr = censusAttribute(cfg, model);
    const options = censusOptions(attr);
    const nearby = cfg['source'] === 'nearby';

    // Which outputs does the graph actually read? Only those are synthesized.
    // A `count_<i>` beyond the live option set (e.g. a tag option was deleted)
    // gets no remap below and its edge is DROPPED — never silently repointed.
    const wantedCounts = new Set<number>();
    let wantsTotal = false;
    for (const e of edges) {
      if (e.source !== nd.id) continue;
      if (e.sourceHandle === 'output_value_total') { wantsTotal = true; continue; }
      const m = COUNT_HANDLE.exec(e.sourceHandle ?? '');
      if (m) {
        const i = Number(m[1]);
        if (i >= 0 && i < options.length) wantedCounts.add(i);
      }
    }
    if (wantedCounts.size === 0 && !wantsTotal) continue;   // node + edges dropped

    // ONE shared gather (the neighbour id array).
    const gatherId = `${nd.id}__cnG`;
    if (nearby) {
      const gCfg: Record<string, string | number | boolean> = {};
      const r = cfg['_port_radius'];
      if (r !== undefined) gCfg['_port_radius'] = r as string | number | boolean;
      outNodes.push({ id: gatherId, type: 'caNode', position: nd.position, data: { nodeType: 'getNearbyAgents', config: gCfg } });
      // A WIRED Radius overrides the inline value, exactly as on the census node.
      remapTgt.set(`${nd.id} input_value_radius`, { target: gatherId, targetHandle: 'input_value_radius' });
    } else {
      outNodes.push({ id: gatherId, type: 'caNode', position: nd.position, data: { nodeType: 'getBondedAgents', config: {} } });
    }

    // `total` is the NEIGHBOUR count, so it reads the gather's id array directly.
    // That keeps it meaningful (and costs no second array producer) when only the
    // total is consumed, or when no attribute is configured yet.
    if (wantsTotal) {
      const lenId = `${nd.id}__cnLen`;
      outNodes.push({ id: lenId, type: 'caNode', position: nd.position, data: { nodeType: 'arrayLength', config: {} } });
      outEdges.push({ id: `${nd.id}__cnEt`, source: gatherId, sourceHandle: 'output_value_agents', target: lenId, targetHandle: 'input_value_array' });
      remapSrc.set(`${nd.id} output_value_total`, { source: lenId, sourceHandle: 'output_value_length' });
    }

    if (wantedCounts.size === 0) continue;

    // ONE shared value gather (the neighbours' attribute values), fanned out to
    // every counter. `attr` is non-null here: wantedCounts is only non-empty when
    // the option list is (and the option list comes from the resolved attribute).
    const valsId = `${nd.id}__cnV`;
    outNodes.push({
      id: valsId, type: 'caNode', position: nd.position,
      data: { nodeType: 'getAgentsAttribute', config: { attributeId: attr!.id } },
    });
    outEdges.push({ id: `${nd.id}__cnEv`, source: gatherId, sourceHandle: 'output_value_agents', target: valsId, targetHandle: 'input_value_agents' });

    for (const i of wantedCounts) {
      const opt = options[i]!;
      const kId = `${nd.id}__cnK${i}`;
      const cId = `${nd.id}__cnC${i}`;
      // The comparison operand: a tag constant carries the option INDEX; a bool
      // constant carries true/false (which getConstant emits as 1/0, matching the
      // agent SoA's 0/1 storage). Both are exact small integers on every target.
      const kCfg: Record<string, string | number | boolean> = attr!.type === 'bool'
        ? { constType: 'bool', constValue: opt.value === 1 ? 'true' : 'false' }
        : { constType: 'tag', tagAttributeId: attr!.id, constValue: String(opt.value) };
      outNodes.push({ id: kId, type: 'caNode', position: nd.position, data: { nodeType: 'getConstant', config: kCfg } });
      outNodes.push({ id: cId, type: 'caNode', position: nd.position, data: { nodeType: 'groupCounting', config: { operation: 'equals' } } });
      outEdges.push({ id: `${nd.id}__cnEa${i}`, source: valsId, sourceHandle: 'output_value_values', target: cId, targetHandle: 'input_value_values' });
      outEdges.push({ id: `${nd.id}__cnEk${i}`, source: kId, sourceHandle: 'output_value_value', target: cId, targetHandle: 'input_value_compare' });
      remapSrc.set(`${nd.id} ${`output_value_${censusCountPortId(i)}`}`, { source: cId, sourceHandle: 'output_value_count' });
    }
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
