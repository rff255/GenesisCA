/**
 * Vector stored-attribute lowering — target-independent pre-compile / pre-init
 * transform (the composite-STORAGE analogue of `expandComposites`, which lowers a
 * composite WIRE).
 *
 * A `vector` attribute is a per-cell / per-agent 2D–3D direction. It is NEVER
 * stored as one array — `expandVectorAttributes` replaces each vector attribute
 * with its `dims` scalar `float` component attributes (`<id>_vx`/`_vy`/`_vz`),
 * mirroring how `color` splits into `_r/_g/_b`. Applied to the attribute list at
 * every compiler + the worker-init boundary, so every downstream layer (all 5
 * compilers, the worker SoA, save/load) sees ONLY scalar floats — already verified
 * on every target, 2D+3D. The vector attribute itself exists only in
 * `model.attributes`/`agentAttributes` (authoring) + this transform.
 *
 * There are NO dedicated Get/Set Vector nodes: the ordinary
 * `getCellAttribute`/`setAttribute`/`getVariable`/`setVariable` nodes flip their
 * `value` port to the composite `vector` type when the picked attribute/variable
 * is a vector (see `vectorPortDims`), and `lowerVectorAttrs` rewrites those Get/Set
 * into Make/Break Vector over getCellAttribute/setAttribute on these component ids
 * — reusing the verified `expandComposites` path, so there is ZERO new per-target
 * emit.
 *
 * NB the suffix `_vx/_vy/_vz` mirrors `color`'s `_r/_g/_b` split. Attribute ids are
 * random-generated (never user-typed), so a synthesized component id (`<randomId>_vx`)
 * colliding with another attribute's random id is astronomically unlikely — the same
 * theoretical, unguarded collision `color`'s `_r/_g/_b` split carries.
 */

import type { Attribute, AttributeType, CAModel, GraphNode, GraphEdge, Variable } from '../../../model/types';
import { is3dModelLike } from './niCodec';
import { encodeAttrValue } from '../../../model/attrValueEncoding';

const VECTOR_SUFFIXES = ['_vx', '_vy', '_vz'] as const;
const VECTOR_LABELS = ['X', 'Y', 'Z'] as const;

export function isVectorAttr(attr: { type: AttributeType } | undefined | null): boolean {
  return !!attr && attr.type === 'vector';
}

/** The component count of a vector attribute — chosen PER ATTRIBUTE via
 *  `vectorDims` (2 = x,y; 3 = x,y,z), NOT derived from the model. A 3D model may
 *  hold both 2D and 3D vector attrs (a horizontal heading vs a full direction);
 *  a 2D model only ever has 2D vectors. Absent ⇒ 2. */
export function vectorDimsOf(attr: { vectorDims?: number } | undefined | null): 2 | 3 {
  return attr && attr.vectorDims === 3 ? 3 : 2;
}

/** The MAXIMUM vector dimensionality the model can offer — 3 in a 3D model, else 2.
 *  Drives the UI: "Vector (2D)" is always available, "Vector (3D)" only when this
 *  is 3 (a 3D model). NOT the dims of a given attr — that is `vectorDimsOf`. */
export function vectorDimsForModel(model: CAModel | undefined | null): 2 | 3 {
  return is3dModelLike(model ?? undefined) ? 3 : 2;
}

/** The synthesized per-component scalar-float attribute ids for a vector attr —
 *  the ONE place that builds `<id>_vx/_vy/_vz`. Every expansion routes through it. */
export function vectorComponentIds(attrId: string, dims: number): string[] {
  return VECTOR_SUFFIXES.slice(0, Math.max(2, Math.min(3, dims))).map(sfx => attrId + sfx);
}

/** Per-component display labels (X / Y / Z), for the editor + inspector. */
export function vectorComponentLabels(dims: number): string[] {
  return VECTOR_LABELS.slice(0, Math.max(2, Math.min(3, dims))) as unknown as string[];
}

/** Parse a vector default string ("x,y" / "x,y,z") into `dims` numbers (missing /
 *  non-finite entries → 0). Comma-separated, whitespace-tolerant. */
export function parseVectorDefault(value: string | undefined, dims: number): number[] {
  const parts = String(value ?? '').split(',');
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    const v = parseFloat((parts[i] ?? '').trim());
    out.push(Number.isFinite(v) ? v : 0);
  }
  return out;
}

/** Join `dims` component numbers back into the "x,y[,z]" default-string encoding. */
export function encodeVectorDefault(comps: number[], dims: number): string {
  return Array.from({ length: dims }, (_, i) => String(comps[i] ?? 0)).join(',');
}

/** Encode a manual / seed / edit-brush value STRING for `attr` into the flat
 *  `{attrId, value}` sets the worker paints. A scalar attribute yields ONE set
 *  (via `encodeAttrValue`); a `vector` attribute yields ONE set PER COMPONENT,
 *  keyed by its `<id>_vx/_vy[/_vz]` ids — so painting a vector direction writes
 *  the real component buffers the worker owns (the vector id itself never exists
 *  there; the worker's paint guard would silently skip it). Value is the
 *  "x,y[,z]" comma encoding. Shared by every brush set-builder in SimulatorView. */
export function encodeAttrSets(
  attr: { id: string; type: AttributeType; defaultValue?: string; vectorDims?: number },
  raw?: string,
): Array<{ attrId: string; value: number }> {
  if (attr.type === 'vector') {
    const dims = vectorDimsOf(attr);
    const ids = vectorComponentIds(attr.id, dims);
    const comps = parseVectorDefault(raw ?? attr.defaultValue ?? '', dims);
    return ids.map((id, i) => ({ attrId: id, value: comps[i] ?? 0 }));
  }
  return [{ attrId: attr.id, value: encodeAttrValue(attr, raw) }];
}

/** Inverse of `encodeAttrSets` for prefilling the edit brush from a live agent /
 *  inspected cell: read a vector attribute's components out of a worker-published
 *  values map (keyed by the `<id>_vx…` component ids) and join them into the
 *  "x,y[,z]" string the vector brush widget edits. Missing components → 0. */
export function decodeVectorFromValues(
  attr: { id: string; vectorDims?: number },
  values: Record<string, number> | null | undefined,
): string {
  const dims = vectorDimsOf(attr);
  const ids = vectorComponentIds(attr.id, dims);
  const comps = ids.map(id => {
    const v = values?.[id];
    return Number.isFinite(v) ? (v as number) : 0;
  });
  return encodeVectorDefault(comps, dims);
}

/** Lower each `vector` attribute in `attrs` into its `vectorDimsOf` scalar-FLOAT
 *  component attributes (`<id>_vx/_vy`[/`_vz`]), preserving list order + the fields
 *  the storage / compiler layers read: `isModelAttribute`, `agentAccess` (a vector
 *  cell FIELD's components inherit the field access), and a per-component
 *  `boundaryValue` split. Each attr uses its OWN `vectorDims` (2 or 3). Non-vector
 *  attributes pass through untouched. Returns the SAME array (identity) when there
 *  are no vector attributes — the hot-path no-op. */
export function expandVectorAttributes(attrs: Attribute[]): Attribute[] {
  if (!attrs.some(a => a.type === 'vector')) return attrs;
  const out: Attribute[] = [];
  for (const a of attrs) {
    if (a.type !== 'vector') { out.push(a); continue; }
    const dims = vectorDimsOf(a);
    const ids = vectorComponentIds(a.id, dims);
    const labels = vectorComponentLabels(dims);
    const defaults = parseVectorDefault(a.defaultValue, dims);
    const bounds = a.boundaryValue !== undefined && a.boundaryValue !== '' ? parseVectorDefault(a.boundaryValue, dims) : null;
    for (let i = 0; i < dims; i++) {
      const comp: Attribute = {
        id: ids[i]!,
        name: `${a.name} ${labels[i]}`,
        type: 'float',
        description: a.description,
        isModelAttribute: a.isModelAttribute,
        defaultValue: String(defaults[i]),
      };
      if (bounds) comp.boundaryValue = String(bounds[i]);
      if (a.agentAccess) comp.agentAccess = a.agentAccess;
      out.push(comp);
    }
  }
  return out;
}

/** Does this attribute list contain any vector attribute? (Cheap gate for callers
 *  deciding whether to run the expansion / node lowering.) */
export function hasVectorAttrs(attrs: readonly Attribute[]): boolean {
  return attrs.some(a => a.type === 'vector');
}

/** Node types whose `value` port carries a stored-attribute value keyed by
 *  `config.attributeId` — the own-cell Get/Set PLUS the neighbour reads
 *  (`getNeighborAttributeByIndex`/`getNeighborAttributeByTag`), the by-id agent
 *  read (`getAgentAttribute`), and the neighbour
 *  writes (`setNeighborAttributeByIndex`/`setNeighborhoodAttribute`). When the
 *  picked attribute is a `vector`, that port flips to the composite `vector` type
 *  and the node lowers (see `lowerVectorAttrs`). */
const VECTOR_ATTR_PORT_NODES: ReadonlySet<string> = new Set([
  'getCellAttribute', 'setAttribute',
  'getNeighborAttributeByIndex', 'getNeighborAttributeByTag', 'getAgentAttribute',
  'setNeighborAttributeByIndex', 'setNeighborhoodAttribute',
]);

/** Every node type whose reference to a `vector` attribute IS correctly lowered by
 *  `lowerVectorAttrs` (so `nodeValidation` must NOT badge it). The `VECTOR_ATTR_PORT_NODES`
 *  set (single vector VALUE on a `value` port) + `moveSelfToNeighbor` (config-slot
 *  expansion of its per-payload `attr_${i}` slots) + the Local-Variable Get/Set
 *  (keyed by `variableId`, so never badged by the attribute-id guard anyway).
 *  Any node referencing a vector attribute NOT in this set has no vector
 *  representation (array-of-vectors reads, `filterNeighbors`, `updateAttribute`,
 *  the field-bridge nodes) and stays badged. */
export const VECTOR_LOWERED: ReadonlySet<string> = new Set([
  ...VECTOR_ATTR_PORT_NODES,
  'getVariable', 'setVariable', 'moveSelfToNeighbor',
]);

/** The UNIFIED type-driven port rule: when an EXISTING Get/Set Attribute, a
 *  neighbour read, a by-id agent read/write, a neighbour write, or a Get/Set
 *  Variable node has a VECTOR attr/var picked, its `value` port is a `vector` port
 *  (and it lowers to Make/Break Vector). Returns the component count, or null for a
 *  scalar (the port stays scalar). Shared by effectivePorts + isValidConnection +
 *  CaNode so the editor + validator + render agree. Ids are globally unique, so the
 *  cell/agent scope is looked up together. */
export function vectorPortDims(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model: Pick<CAModel, 'attributes' | 'agentAttributes' | 'variables' | 'agentVariables'> | undefined | null,
): 2 | 3 | null {
  if (!model || !config) return null;
  if (VECTOR_ATTR_PORT_NODES.has(nodeType)) {
    const id = config.attributeId;
    const a = [...(model.attributes ?? []), ...(model.agentAttributes ?? [])].find(x => x.id === id && x.type === 'vector');
    return a ? vectorDimsOf(a) : null;
  }
  if (nodeType === 'getVariable' || nodeType === 'setVariable') {
    const id = config.variableId;
    const v = [...(model.variables ?? []), ...(model.agentVariables ?? [])].find(x => x.id === id && x.dataType === 'vector' && x.kind !== 'array');
    return v ? vectorDimsOf(v) : null;
  }
  return null;
}

/** Lower each `vector` scalar VARIABLE into its `vectorDimsOf` scalar-`float`
 *  component variables (`<id>_vx/_vy[/_vz]`) — the Local-Variable analogue of
 *  `expandVectorAttributes`. `initialValue` ("x,y[,z]") splits per component. So a
 *  vector accumulator (summed forces) becomes N float scratch variables that
 *  `buildVariableJS` / the WASM/WebGPU variable storage already handle. Non-vector
 *  variables pass through untouched; identity when there are none.
 *
 *  Only SCALAR vectors are lowered — a vector is a scalar-only type (the UI blocks
 *  Kind=Array on a vector). A hand-edited/legacy invalid `{kind:'array',
 *  dataType:'vector'}` passes through untouched so `_var_<id>` still exists (a plain
 *  array) rather than being expanded away, which would leave Set Array Element
 *  referencing an undeclared `_var_<id>`. */
const isScalarVectorVar = (v: Variable) => v.dataType === 'vector' && v.kind !== 'array';
export function expandVectorVariables(vars: Variable[]): Variable[] {
  if (!vars.some(isScalarVectorVar)) return vars;
  const out: Variable[] = [];
  for (const v of vars) {
    if (!isScalarVectorVar(v)) { out.push(v); continue; }
    const dims = vectorDimsOf(v);
    const ids = vectorComponentIds(v.id, dims);
    const labels = vectorComponentLabels(dims);
    const inits = parseVectorDefault(v.initialValue, dims);
    for (let i = 0; i < dims; i++) {
      out.push({
        id: ids[i]!,
        name: `${v.name} ${labels[i]}`,
        description: v.description,
        kind: 'scalar',
        dataType: 'float',
        initialValue: String(inits[i]),
      });
    }
  }
  return out;
}

// ── The node-lowering + attr-expansion transform (one call per compiler) ──────
const vIn = (p: string) => `input_value_${p}`;
const vOut = (p: string) => `output_value_${p}`;
const fIn = (p: string) => `input_flow_${p}`;
const fOut = (p: string) => `output_flow_${p}`;
const AXES = ['x', 'y', 'z'];

/** Get nodes whose vector `value` OUTPUT lowers to a Make Vector over per-component
 *  reads. `key` = the config key naming the attr/var; `fanout` = the shared VALUE
 *  input ports duplicated onto every component reader (the NI / agent id — the
 *  own-cell reads fan nothing). `copyConfig` = carry the original config forward
 *  (neighborhoodId / tagName for the tag read). */
const GET_LOWER: Record<string, { key: string; fanout: string[]; copyConfig: boolean }> = {
  getCellAttribute: { key: 'attributeId', fanout: [], copyConfig: false },
  getVariable: { key: 'variableId', fanout: [], copyConfig: false },
  getNeighborAttributeByIndex: { key: 'attributeId', fanout: ['index'], copyConfig: true },
  getNeighborAttributeByTag: { key: 'attributeId', fanout: [], copyConfig: true },
  getAgentAttribute: { key: 'attributeId', fanout: ['agentId'], copyConfig: true },
};
/** Set nodes whose vector `value` INPUT lowers to a Break Vector + a linear
 *  component-write chain. Same `key`/`fanout`/`copyConfig` semantics. */
const SET_LOWER: Record<string, { key: string; fanout: string[]; copyConfig: boolean }> = {
  // `setAttribute` fans its OPTIONAL `agentId` out to every component setter (an
  // unwired one has no edge, so the fan is a no-op and a cell/self write is
  // unchanged). `copyConfig` stays false: the component clones must NOT inherit
  // the parent's `_port_value` inline, exactly as before the agent id existed.
  setAttribute: { key: 'attributeId', fanout: ['agentId'], copyConfig: false },
  setVariable: { key: 'variableId', fanout: [], copyConfig: false },
  setNeighborAttributeByIndex: { key: 'attributeId', fanout: ['index'], copyConfig: true },
  setNeighborhoodAttribute: { key: 'attributeId', fanout: [], copyConfig: true },
};

/** The ONE compiler-facing transform: lowers every node that reads/writes a stored
 *  `vector` attribute/variable into per-component scalar nodes AND expands the model's
 *  vector attributes/variables into their scalar-float components — so the rest of the
 *  compiler (which then runs `expandComposites` on the synthesized Make/Break Vector)
 *  sees ONLY scalar floats + a scalar attribute list. NO per-target emit: the whole
 *  feature rides the already-verified scalar reads/writes + the `expandComposites`
 *  Make/Break lowering, on JS / WASM / WebGPU (cell + agent), 2D + 3D.
 *
 *  Run AFTER macro expansion / reroute collapse (so a vector Get/Set inside a macro
 *  is already flat) and BEFORE `expandComposites` (so the synthesized Make/Break
 *  Vector get lowered). Returns the SAME nodes/edges/model (identity) when there are
 *  no vector attrs/vars — the hot-path no-op.
 *
 *  Lowered nodes (all in `VECTOR_LOWERED`):
 *   - VALUE reads (`GET_LOWER`): own `getCellAttribute`/`getVariable`, the neighbour
 *     reads `getNeighborAttributeByIndex`/`getNeighborAttributeByTag`, the by-id agent
 *     read `getAgentAttribute` — each → a `makeVector` fed by N same-type component
 *     reads, with the shared value input (NI index / agent id) fanned out to every reader.
 *   - FLOW writes (`SET_LOWER`): `setAttribute` (self OR another agent by id) /
 *     `setVariable`, the neighbour writes `setNeighborAttributeByIndex` /
 *     `setNeighborhoodAttribute` — each → a `breakVector` + a linear `do → set_vx → set_vy[
 *     → set_vz] → next` chain, with the shared value input fanned out to every setter.
 *   - `moveSelfToNeighbor` — a config-slot expansion of each vector payload slot into
 *     its scalar-component slots (NOT a Make/Break rewrite).
 *
 *  Array-of-vectors reads (`getNeighborsAttribute` / `getAgentsAttribute` / …),
 *  `filterNeighbors`, and `updateAttribute` have NO vector representation and stay
 *  badged by `detectMissingConfig` (they are NOT in `VECTOR_LOWERED`). */
export function lowerVectorAttrs(
  nodes: GraphNode[], edges: GraphEdge[], model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[]; model: CAModel } {
  const anyVecAttr = hasVectorAttrs(model.attributes ?? []) || hasVectorAttrs(model.agentAttributes ?? []);
  const anyVecVar = (model.variables ?? []).some(isScalarVectorVar) || (model.agentVariables ?? []).some(isScalarVectorVar);
  if (!anyVecAttr && !anyVecVar) return { nodes, edges, model };

  // Vector def dims by id (both scopes). Unified design: the EXISTING Get/Set
  // Attribute + Get/Set Variable nodes are vector-aware — when the picked attr/var
  // is a vector, they lower here (and effectivePorts/isValidConnection make their
  // value port a `vector` port). No dedicated Get/Set Vector node types.
  const vecAttrDims = new Map<string, number>();
  for (const a of model.attributes ?? []) if (a.type === 'vector') vecAttrDims.set(a.id, vectorDimsOf(a));
  for (const a of model.agentAttributes ?? []) if (a.type === 'vector') vecAttrDims.set(a.id, vectorDimsOf(a));
  const vecVarDims = new Map<string, number>();
  for (const v of model.variables ?? []) if (isScalarVectorVar(v)) vecVarDims.set(v.id, vectorDimsOf(v));
  for (const v of model.agentVariables ?? []) if (isScalarVectorVar(v)) vecVarDims.set(v.id, vectorDimsOf(v));

  // The dims map for a node's config key (attributes vs variables).
  const dimsFor = (key: string) => (key === 'variableId' ? vecVarDims : vecAttrDims);

  // Cell-attribute lookup for moveSelfToNeighbor slot defaults (its slots are
  // non-model cell attrs; the emit looks up `!isModelAttribute`).
  const cellAttrById = new Map<string, Attribute>();
  for (const a of model.attributes ?? []) cellAttrById.set(a.id, a);
  const scalarDefaultString = (id: string): string => {
    const raw = String(cellAttrById.get(id)?.defaultValue ?? '0');
    return raw === 'true' ? '1' : raw === 'false' ? '0' : raw;
  };

  // Resolve a neighbourhood tag NAME → its coord-index (mirrors the JS compiler's
  // `_resolvedTagIndex` pre-pass). Baked HERE so synthesized `getNeighborAttributeByTag`
  // component readers work on WASM/WebGPU too — those targets have no tag pre-pass and
  // never see the JS-mutated config for the fresh readers this transform creates.
  const resolveTagIndex = (nbrId: string, tagName: string): number => {
    const nbr = model.neighborhoods?.find(nb => nb.id === nbrId);
    if (nbr?.tags) {
      const entry = Object.entries(nbr.tags).find(([, name]) => name === tagName);
      if (entry) return Number(entry[0]);
    }
    return 0;
  };

  let seq = 0;
  const nid = () => `__va${seq++}`;
  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  const dropIds = new Set<string>();
  // Redirect a (nodeId, handle) → a replacement (nodeId, handle) at edge-rewire time.
  const remapSrc = new Map<string, { source: string; sourceHandle: string }>();
  const remapTgt = new Map<string, { target: string; targetHandle: string }>();
  // Duplicate a single incoming edge (the shared NI / agent id) onto EVERY component
  // accessor — the fan-out the neighbour/by-id nodes need (the own-cell reads don't).
  const fanoutTgt = new Map<string, Array<{ target: string; targetHandle: string }>>();

  const mkNode = (nodeType: string, config: Record<string, string | number | boolean>): GraphNode => {
    const n: GraphNode = { id: nid(), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } };
    outNodes.push(n);
    return n;
  };
  const mkEdge = (s: string, sh: string, t: string, th: string) =>
    outEdges.push({ id: nid() + 'e', source: s, sourceHandle: sh, target: t, targetHandle: th });

  // The config a synthesized component accessor carries: swap the attr/var key to
  // the component id, optionally carrying the ORIGINAL config forward (neighborhoodId
  // / tagName for the tag read) + baking the tag index.
  const compConfig = (orig: GraphNode, t: string, key: string, compId: string, copyConfig: boolean): Record<string, string | number | boolean> => {
    const cfg: Record<string, string | number | boolean> = copyConfig ? { ...orig.data.config } : {};
    cfg[key] = compId;
    if (t === 'getNeighborAttributeByTag') {
      cfg._resolvedTagIndex = resolveTagIndex(String(orig.data.config.neighborhoodId ?? ''), String(orig.data.config.tagName ?? ''));
    }
    return cfg;
  };
  const addFanout = (origId: string, port: string, target: string) => {
    const k = `${origId} ${vIn(port)}`;
    (fanoutTgt.get(k) ?? fanoutTgt.set(k, []).get(k)!).push({ target, targetHandle: vIn(port) });
  };

  for (const n of nodes) {
    const t = n.data.nodeType;

    // moveSelfToNeighbor: config-slot expansion (NOT a Make/Break rewrite). Each
    // per-payload `attr_${i}` slot that names a vector attr is replaced by its
    // `dims` scalar-component slots; `payloadCount` grows; the orientation transfer
    // (a separate trailing slot, unaffected) keeps its position. `_attr_${i}_default`
    // is baked for EVERY new slot so the WASM emit (which reads it, and never sees
    // the JS `preResolveMoveNodes` bake for this freshly-cloned node) is correct.
    if (t === 'moveSelfToNeighbor') {
      const pc = Math.max(1, Number(n.data.config.payloadCount) || 1);
      let hasVecSlot = false;
      for (let i = 0; i < pc; i++) if (vecAttrDims.has(String(n.data.config[`attr_${i}`] ?? ''))) { hasVecSlot = true; break; }
      if (!hasVecSlot) { outNodes.push(n); continue; }
      const cfg: Record<string, string | number | boolean> = { ...n.data.config };
      for (const k of Object.keys(cfg)) if (/^attr_\d+$/.test(k) || /^_attr_\d+_default$/.test(k)) delete cfg[k];
      let w = 0;
      for (let i = 0; i < pc; i++) {
        const sid = String(n.data.config[`attr_${i}`] ?? '');
        if (vecAttrDims.has(sid)) {
          const dims = vecAttrDims.get(sid)!;
          const compIds = vectorComponentIds(sid, dims);
          const defs = parseVectorDefault(cellAttrById.get(sid)?.defaultValue, dims);
          for (let k = 0; k < dims; k++) { cfg[`attr_${w}`] = compIds[k]!; cfg[`_attr_${w}_default`] = String(defs[k] ?? 0); w++; }
        } else {
          cfg[`attr_${w}`] = sid;
          cfg[`_attr_${w}_default`] = scalarDefaultString(sid);
          w++;
        }
      }
      cfg.payloadCount = w;
      // Clone (never mutate the live React node — this would show expanded slots in the editor).
      outNodes.push({ ...n, data: { ...n.data, config: cfg } });
      continue;
    }

    const getK = GET_LOWER[t];
    const setK = SET_LOWER[t];
    const getId = getK ? String(n.data.config?.[getK.key] ?? '') : '';
    const setId = setK ? String(n.data.config?.[setK.key] ?? '') : '';
    // Only lower when the referenced attr/var is a VECTOR; a scalar Get/Set is
    // passed through unchanged (its value port stays scalar). The component
    // accessor is the SAME node type (`t`) reading/writing the scalar `_vx/_vy` ids.
    if (getK && dimsFor(getK.key).has(getId)) {
      // Get (VALUE) → makeVector fed by N scalar component reads. The shared value
      // inputs (NI / agent id) fan out to every component reader.
      const dims = dimsFor(getK.key).get(getId)!;
      const compIds = vectorComponentIds(getId, dims);
      const mv = mkNode('makeVector', {});
      for (let i = 0; i < dims; i++) {
        const gn = mkNode(t, compConfig(n, t, getK.key, compIds[i]!, getK.copyConfig));
        mkEdge(gn.id, vOut('value'), mv.id, vIn(AXES[i]!));
        for (const fp of getK.fanout) addFanout(n.id, fp, gn.id);
      }
      // Consumers of this node's `value` (vector) output → the makeVector's `vector`.
      remapSrc.set(`${n.id} ${vOut('value')}`, { source: mv.id, sourceHandle: vOut('vector') });
      dropIds.add(n.id);
    } else if (setK && dimsFor(setK.key).has(setId)) {
      // Set (FLOW) → breakVector + a linear scalar-write chain over the components.
      // The shared value inputs (NI / agent id) fan out to every component setter.
      const dims = dimsFor(setK.key).get(setId)!;
      const compIds = vectorComponentIds(setId, dims);
      const bv = mkNode('breakVector', {});
      const setNodes: GraphNode[] = [];
      for (let i = 0; i < dims; i++) {
        const sn = mkNode(t, compConfig(n, t, setK.key, compIds[i]!, setK.copyConfig));
        mkEdge(bv.id, vOut(AXES[i]!), sn.id, vIn('value'));
        for (const fp of setK.fanout) addFanout(n.id, fp, sn.id);
        setNodes.push(sn);
      }
      for (let i = 0; i < dims - 1; i++) mkEdge(setNodes[i]!.id, fOut('next'), setNodes[i + 1]!.id, fIn('do'));
      // The vector value input source → breakVector.vector.
      remapTgt.set(`${n.id} ${vIn('value')}`, { target: bv.id, targetHandle: vIn('vector') });
      // Flow in → first set's `do`; flow out ← last set's `next`.
      remapTgt.set(`${n.id} ${fIn('do')}`, { target: setNodes[0]!.id, targetHandle: fIn('do') });
      remapSrc.set(`${n.id} ${fOut('next')}`, { source: setNodes[dims - 1]!.id, sourceHandle: fOut('next') });
      dropIds.add(n.id);
    } else {
      outNodes.push(n);
    }
  }

  for (const e of edges) {
    // Fan-out: a shared value input of a dropped read/write node → duplicate its
    // source onto every component accessor (reusing the ONE source node; N edges).
    const fans = fanoutTgt.get(`${e.target} ${e.targetHandle}`);
    if (fans) {
      const frs = remapSrc.get(`${e.source} ${e.sourceHandle}`);
      const src = frs ? frs.source : e.source;
      const srcH = frs ? frs.sourceHandle : e.sourceHandle;
      for (const f of fans) mkEdge(src, srcH, f.target, f.targetHandle);
      continue;
    }
    const rs = remapSrc.get(`${e.source} ${e.sourceHandle}`);
    const rt = remapTgt.get(`${e.target} ${e.targetHandle}`);
    // An edge touching a dropped node on a handle we did NOT remap is stale — drop it.
    if ((dropIds.has(e.source) && !rs) || (dropIds.has(e.target) && !rt)) continue;
    outEdges.push({
      ...e,
      source: rs ? rs.source : e.source,
      sourceHandle: rs ? rs.sourceHandle : e.sourceHandle,
      target: rt ? rt.target : e.target,
      targetHandle: rt ? rt.targetHandle : e.targetHandle,
    });
  }

  const model2: CAModel = {
    ...model,
    attributes: expandVectorAttributes(model.attributes ?? []),
    agentAttributes: model.agentAttributes ? expandVectorAttributes(model.agentAttributes) : model.agentAttributes,
    variables: model.variables ? expandVectorVariables(model.variables) : model.variables,
    agentVariables: model.agentVariables ? expandVectorVariables(model.agentVariables) : model.agentVariables,
  };
  return { nodes: outNodes, edges: outEdges, model: model2 };
}
