/**
 * Multi-attribute slot expansion — target-independent pre-compile graph transform.
 *
 * The four attribute-accessor nodes (`getCellAttribute` / `setAttribute` /
 * `getModelAttribute` / `getAgentAttribute`) support a
 * DYNAMIC number of attribute slots (the `Transfer Cell Attributes To Neighbor`
 * payload-slot pattern applied to the accessors): one Get node reads N attributes
 * through N output ports, one Set node writes N attributes through N input ports.
 * Slot 1 is the legacy `attributeId` + `value` port — old files load and compile
 * byte-identically. Extra slots are `attr_${i}` config keys + `value_${i}` ports,
 * indexed 2..extraCount+1 (mirroring Sequence's `then_2…`).
 *
 * The slots are EDITOR SUGAR: this pass rewrites every multi-slot accessor into
 * the SINGLE-slot primitives all five compilers already emit, BEFORE any
 * per-target compile runs — exactly the lowering pattern of `expandMacros`,
 * `collapseReroutes`, `lowerVectorAttrs` and `expandComposites`. After it runs no
 * compiler, analyzer (sink / CSE / loop-invariance / volatile / asyncWriteHazard),
 * agent-target gate, or emitter ever sees a multi-slot node — so the feature runs
 * on JS / WASM / WebGPU, cell + agent graphs, 2D + 3D by construction (the
 * ALL-TARGET DELIVERY rule satisfied the sanctioned way).
 *
 * Lowering, by direction:
 *  - GET (value): the original node keeps slot 1 (config pruned of the extra
 *    keys, so accessor-CSE sees a plain single get); each extra slot becomes a
 *    synthesized single-slot clone, and consumers of `value_${i}` (or
 *    `r/g/b_${i}` for a color model attribute) rewire to the clone's `value`
 *    (`r`/`g`/`b`). The shared `agentId` input of `getAgentAttribute` / a WIRED
 *    `setAttribute` FANS OUT — the original keeps its edge and each clone gets a
 *    copy of the same source.
 *  - SET (flow): the original (slot 1) heads a synthesized linear flow splice
 *    `do → set(slot1) → set(slot2) → … → set(slotN) → next`; `value_${i}` edges
 *    retarget to clone i's `value`, `_port_value_${i}` inline values copy to the
 *    clone's `_port_value`, and the original's former `next` consumers re-source
 *    from the LAST clone. Slots therefore execute in slot order — in async mode a
 *    later read-after-write sees earlier slots' writes, byte-for-byte what a
 *    hand-built chain does (the asyncWriteHazard analyzer sees the chain natively).
 *
 * Runs AFTER macro expansion + reroute collapse (so multi-slot accessors inside
 * macros are already flat) and BEFORE `lowerFacingSource` / `lowerVectorAttrs` /
 * `expandComposites` — so a VECTOR attribute in an extra slot becomes an ordinary
 * single-slot get/set that the vector lowering then rewrites (vector slots work on
 * every target for free). Synthesized ids are deterministic (`${origId}__ma${i}`)
 * so WASM/WebGPU recompiles stay byte-stable. Hot-path no-op when no node has
 * `extraCount > 0` — every existing model compiles byte-identically.
 *
 * Stale slot edges (a dangling `value_${i}` handle beyond the CURRENT extraCount,
 * left by a removed slot) are DROPPED, never passed through: an unmapped
 * `value_${i}` source handle on a single-output get would silently resolve to the
 * slot-1 variable (`varName` falls back to `_v<id>`), reading the wrong attribute.
 */

import type { Attribute, CAModel, GraphNode, GraphEdge } from '../../../model/types';
import type { PortDef } from '../types';

/** Accessor nodes whose extra slots add value OUTPUTS. */
export const MULTI_ATTR_GET_TYPES: ReadonlySet<string> = new Set([
  'getCellAttribute', 'getModelAttribute', 'getAgentAttribute',
]);
/** Accessor nodes whose extra slots add value INPUTS (written in slot order). */
export const MULTI_ATTR_SET_TYPES: ReadonlySet<string> = new Set([
  'setAttribute',
]);
/** All multi-slot-capable accessor node types. */
export const MULTI_ATTR_TYPES: ReadonlySet<string> = new Set([
  ...MULTI_ATTR_GET_TYPES, ...MULTI_ATTR_SET_TYPES,
]);

/** Defensive ceiling on extra slots (guards NaN / negative / pathological configs). */
const MAX_EXTRA_SLOTS = 30;

/** The number of EXTRA attribute slots on a node config (0 = classic single). */
export function multiAttrExtraCount(config: Record<string, unknown> | undefined): number {
  const n = Number(config?.extraCount) || 0;
  return Math.max(0, Math.min(MAX_EXTRA_SLOTS, Math.floor(n)));
}

/** Extra slot indices — 2..extraCount+1 (slot 1 is the legacy `attributeId`). */
export function multiAttrSlotIndices(config: Record<string, unknown> | undefined): number[] {
  const n = multiAttrExtraCount(config);
  return Array.from({ length: n }, (_, k) => k + 2);
}

export const slotAttrKey = (i: number): string => `attr_${i}`;
export const slotPortId = (i: number): string => `value_${i}`;
export const slotInlineKey = (i: number): string => `_port_value_${i}`;

/** Resolve an extra slot's attribute in the node type's OWN scope: model attrs for
 *  `getModelAttribute`, agent attrs for the by-id agent pair, and the cell∪agent
 *  own-scope for the universal pair (ids are globally unique, and the graph-aware
 *  dropdown prevents picking the wrong scope — mirrors nodeValidation's hasOwnAttr). */
export function resolveSlotAttr(
  nodeType: string,
  model: Pick<CAModel, 'attributes' | 'agentAttributes'> | undefined | null,
  attrId: unknown,
): Attribute | undefined {
  if (!model || typeof attrId !== 'string' || !attrId) return undefined;
  if (nodeType === 'getModelAttribute') {
    return model.attributes.find(a => a.id === attrId && a.isModelAttribute);
  }
  if (nodeType === 'getAgentAttribute') {
    return (model.agentAttributes ?? []).find(a => a.id === attrId);
  }
  return model.attributes.find(a => a.id === attrId && !a.isModelAttribute)
    ?? (model.agentAttributes ?? []).find(a => a.id === attrId);
}

/** Port-aware vector typing for the EXTRA slot ports — the `value_${i}` analogue
 *  of `vectorPortDims` (which covers the primary `value` port). Consumed by
 *  isValidConnection so a vector attribute in an extra slot only wires
 *  vector↔vector, like the primary. Null for a scalar slot / non-slot port. */
export function slotVectorDims(
  nodeType: string,
  portId: string,
  config: Record<string, unknown> | undefined,
  model: Pick<CAModel, 'attributes' | 'agentAttributes'> | undefined | null,
): 2 | 3 | null {
  if (!MULTI_ATTR_TYPES.has(nodeType) || !config) return null;
  const m = /^value_(\d+)$/.exec(portId);
  if (!m) return null;
  const i = Number(m[1]);
  if (!multiAttrSlotIndices(config).includes(i)) return null;
  const attr = resolveSlotAttr(nodeType, model, config[slotAttrKey(i)]);
  if (attr?.type !== 'vector') return null;
  return attr.vectorDims === 3 ? 3 : 2;
}

/** Build the dynamic EXTRA slot ports for a multi-attr accessor — the ONE place
 *  the editor derives them (CaNode render + effectivePorts both call this, so the
 *  two can't drift). Get slots → value outputs (a color model attribute exposes
 *  `r/g/b_${i}` like the primary's R/G/B); Set slots → value inputs whose inline
 *  widget adapts to THAT slot's attribute type (the same bool/tag/number mapping
 *  the primary port's `effectiveWidget` swap applies — none for vector/color/NI,
 *  which are wired-only). A vector slot types as the composite `vector` so the
 *  connection rules match the primary port. Labels = the attribute's name. */
export function buildExtraSlotPorts(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model?: Pick<CAModel, 'attributes' | 'agentAttributes'> | null,
): { inputs: PortDef[]; outputs: PortDef[] } {
  const inputs: PortDef[] = [];
  const outputs: PortDef[] = [];
  if (!MULTI_ATTR_TYPES.has(nodeType)) return { inputs, outputs };
  for (const i of multiAttrSlotIndices(config)) {
    const attr = resolveSlotAttr(nodeType, model, config?.[slotAttrKey(i)]);
    const label = attr?.name ?? `Value ${i}`;
    if (MULTI_ATTR_GET_TYPES.has(nodeType)) {
      if (nodeType === 'getModelAttribute' && attr?.type === 'color') {
        // A colour model attribute always occupies r/g/b/a slots (see
        // `modelAttrSlotKeys`), so the alpha channel is always exposed here —
        // unlike the palette nodes, whose `a` port is gated on a declared alpha.
        outputs.push({ id: `r_${i}`, label: `${label} R`, kind: 'output', category: 'value', dataType: 'integer' });
        outputs.push({ id: `g_${i}`, label: `${label} G`, kind: 'output', category: 'value', dataType: 'integer' });
        outputs.push({ id: `b_${i}`, label: `${label} B`, kind: 'output', category: 'value', dataType: 'integer' });
        outputs.push({ id: `a_${i}`, label: `${label} A`, kind: 'output', category: 'value', dataType: 'integer' });
      } else {
        outputs.push({
          id: slotPortId(i), label, kind: 'output', category: 'value',
          dataType: attr?.type === 'vector' ? 'vector' : 'any',
        });
      }
    } else {
      const ty = attr?.type;
      const widget = ty === 'bool' ? 'bool' as const
        : ty === 'tag' ? 'tag' as const
        : (ty === 'integer' || ty === 'float') ? 'number' as const
        : undefined;
      inputs.push({
        id: slotPortId(i), label, kind: 'input', category: 'value',
        dataType: ty === 'vector' ? 'vector' : 'any',
        inlineWidget: widget, defaultValue: '0',
      });
    }
  }
  return { inputs, outputs };
}

const isColorModelAttr = (model: CAModel, attrId: string): boolean =>
  model.attributes.some(a => a.id === attrId && a.isModelAttribute && a.type === 'color');

/** Slot-port handle (a `value_${i}` / `r/g/b/a_${i}` handle) — used to drop STALE
 *  edges on an expanded node that no remap claimed. MUST list every channel the
 *  slot-port builder can emit: an unclaimed handle left here would fall through to
 *  the pruned slot-1 node and silently resolve to the WRONG variable. */
const STALE_SLOT_HANDLE = /^(input|output)_value_(value|r|g|b|a)_\d+$/;

export function expandMultiAttrs(
  nodes: GraphNode[], edges: GraphEdge[], model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let any = false;
  for (const nd of nodes) {
    if (MULTI_ATTR_TYPES.has(nd.data.nodeType) && multiAttrExtraCount(nd.data.config) > 0) { any = true; break; }
  }
  if (!any) return { nodes, edges };

  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  let fanSeq = 0;
  // Redirect a (nodeId, handle) → its clone's (nodeId, handle) at edge-rewire time.
  const remapSrc = new Map<string, { source: string; sourceHandle: string }>();
  const remapTgt = new Map<string, { target: string; targetHandle: string }>();
  // COPY-fanout (the shared `agentId` input): the original keeps its edge AND each
  // clone gets a duplicate of the same source (one source node, N edges).
  const fanoutTgt = new Map<string, Array<{ target: string; targetHandle: string }>>();
  const expandedIds = new Set<string>();

  const addFan = (key: string, to: { target: string; targetHandle: string }): void => {
    const list = fanoutTgt.get(key);
    if (list) list.push(to); else fanoutTgt.set(key, [to]);
  };
  const mkEdge = (id: string, s: string, sh: string, t: string, th: string): void => {
    outEdges.push({ id, source: s, sourceHandle: sh, target: t, targetHandle: th });
  };

  for (const nd of nodes) {
    const t = nd.data.nodeType;
    const slots = MULTI_ATTR_TYPES.has(t) ? multiAttrSlotIndices(nd.data.config) : [];
    if (slots.length === 0) { outNodes.push(nd); continue; }

    // Prune the original down to slot 1 (CLONE — never mutate the live React node).
    // Dropping the extra keys keeps accessor-CSE's purity key equal to a plain
    // single-slot node, so slot 1 still merges with equivalent hand-placed gets.
    const pruned: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(nd.data.config)) {
      if (k === 'extraCount' || /^attr_\d+$/.test(k) || /^_port_value_\d+$/.test(k)) continue;
      pruned[k] = v;
    }
    outNodes.push({ ...nd, data: { ...nd.data, config: pruned } });
    expandedIds.add(nd.id);

    // The SHARED by-id input fans out to every slot clone, so one node writes N
    // attributes on ONE target. `setAttribute`'s `agentId` is OPTIONAL — unwired
    // there is no edge to fan, so a self / cell write is byte-identical.
    const fanPorts = (t === 'getAgentAttribute' || t === 'setAttribute') ? ['agentId'] : [];

    if (MULTI_ATTR_GET_TYPES.has(t)) {
      for (const i of slots) {
        const attrId = String(nd.data.config[slotAttrKey(i)] ?? '');
        const cfg: Record<string, string | number | boolean> = { ...pruned, attributeId: attrId };
        const colorSlot = t === 'getModelAttribute' && isColorModelAttr(model, attrId);
        if (t === 'getModelAttribute') cfg.isColorAttr = colorSlot;
        const gid = `${nd.id}__ma${i}`;
        outNodes.push({ id: gid, type: 'caNode', position: nd.position, data: { nodeType: t, config: cfg } });
        if (colorSlot) {
          // r/g/b/a — must match `buildExtraSlotPorts`' colour-slot output list,
          // or an `a_${i}` consumer edge would be dropped as a stale handle.
          for (const ch of ['r', 'g', 'b', 'a']) {
            remapSrc.set(`${nd.id} output_value_${ch}_${i}`, { source: gid, sourceHandle: `output_value_${ch}` });
          }
        } else {
          remapSrc.set(`${nd.id} output_value_${slotPortId(i)}`, { source: gid, sourceHandle: 'output_value_value' });
        }
        for (const fp of fanPorts) {
          addFan(`${nd.id} input_value_${fp}`, { target: gid, targetHandle: `input_value_${fp}` });
        }
      }
    } else {
      // SET: linear flow splice — original (slot 1) → clone(slot 2) → … → clone(slot N).
      const chain: string[] = [];
      for (const i of slots) {
        const attrId = String(nd.data.config[slotAttrKey(i)] ?? '');
        const cfg: Record<string, string | number | boolean> = { ...pruned, attributeId: attrId };
        const inline = nd.data.config[slotInlineKey(i)];
        if (inline !== undefined) cfg._port_value = inline;
        else delete cfg._port_value; // slot 1's inline must not leak into the clone
        const sid = `${nd.id}__ma${i}`;
        outNodes.push({ id: sid, type: 'caNode', position: nd.position, data: { nodeType: t, config: cfg } });
        remapTgt.set(`${nd.id} input_value_${slotPortId(i)}`, { target: sid, targetHandle: 'input_value_value' });
        for (const fp of fanPorts) {
          addFan(`${nd.id} input_value_${fp}`, { target: sid, targetHandle: `input_value_${fp}` });
        }
        chain.push(sid);
      }
      mkEdge(`${nd.id}__mafl0`, nd.id, 'output_flow_next', chain[0]!, 'input_flow_do');
      for (let j = 0; j < chain.length - 1; j++) {
        mkEdge(`${nd.id}__mafl${j + 1}`, chain[j]!, 'output_flow_next', chain[j + 1]!, 'input_flow_do');
      }
      // The original's former `next` consumers run AFTER the whole splice.
      remapSrc.set(`${nd.id} output_flow_next`, { source: chain[chain.length - 1]!, sourceHandle: 'output_flow_next' });
    }
  }

  for (const e of edges) {
    const rs = remapSrc.get(`${e.source} ${e.sourceHandle}`);
    const rt = remapTgt.get(`${e.target} ${e.targetHandle}`);
    // Stale slot handles on an expanded node that no remap claimed → drop.
    if (!rs && expandedIds.has(e.source) && STALE_SLOT_HANDLE.test(e.sourceHandle)) continue;
    if (!rt && expandedIds.has(e.target) && STALE_SLOT_HANDLE.test(e.targetHandle)) continue;
    const src = rs ? rs.source : e.source;
    const srcH = rs ? rs.sourceHandle : e.sourceHandle;
    const tgt = rt ? rt.target : e.target;
    const tgtH = rt ? rt.targetHandle : e.targetHandle;
    outEdges.push({ ...e, source: src, sourceHandle: srcH, target: tgt, targetHandle: tgtH });
    // Fan copies: duplicate the (possibly re-sourced) shared input onto each clone.
    const fans = fanoutTgt.get(`${e.target} ${e.targetHandle}`);
    if (fans) {
      for (const f of fans) mkEdge(`${e.id}__maf${fanSeq++}`, src, srcH, f.target, f.targetHandle);
    }
  }

  return { nodes: outNodes, edges: outEdges };
}
