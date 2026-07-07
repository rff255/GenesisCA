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

/** The UNIFIED type-driven port rule: when an EXISTING Get/Set Attribute or Get/Set
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
  if (nodeType === 'getCellAttribute' || nodeType === 'setAttribute') {
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

/** The ONE compiler-facing transform: lowers `Get/Set Vector Attribute` nodes into
 *  Make/Break Vector over per-component `getCellAttribute`/`setAttribute` nodes AND
 *  expands the model's vector attributes into their scalar-float components — so the
 *  rest of the compiler (which then runs `expandComposites` on the synthesized
 *  Make/Break Vector) sees ONLY scalar floats + a scalar attribute list.
 *
 *  Run AFTER macro expansion / reroute collapse (so a Get/Set Vector inside a macro
 *  is already flat) and BEFORE `expandComposites` (so the synthesized Make/Break
 *  Vector get lowered). Returns the SAME nodes/edges/model (identity) when there are
 *  no vector attrs AND no Get/Set Vector nodes — the hot-path no-op.
 *
 *  `Set Vector Attribute` (a FLOW node) lowers to a linear `setAttribute` chain
 *  (`do → set_vx → set_vy[ → set_vz] → next`) fed by a `breakVector`; `Get Vector
 *  Attribute` (a VALUE node) lowers to a `makeVector` fed by `getCellAttribute`s. */
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

  // Which existing node types read / write a vector (the component accessor is the
  // SAME node type — getCellAttribute components are getCellAttribute reads, etc.).
  const GET_KIND: Record<string, { key: string; dims: Map<string, number> }> = {
    getCellAttribute: { key: 'attributeId', dims: vecAttrDims },
    getVariable: { key: 'variableId', dims: vecVarDims },
  };
  const SET_KIND: Record<string, { key: string; dims: Map<string, number> }> = {
    setAttribute: { key: 'attributeId', dims: vecAttrDims },
    setVariable: { key: 'variableId', dims: vecVarDims },
  };

  let seq = 0;
  const nid = () => `__va${seq++}`;
  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  const dropIds = new Set<string>();
  // Redirect a (nodeId, handle) → a replacement (nodeId, handle) at edge-rewire time.
  const remapSrc = new Map<string, { source: string; sourceHandle: string }>();
  const remapTgt = new Map<string, { target: string; targetHandle: string }>();

  const mkNode = (nodeType: string, config: Record<string, string | number | boolean>): GraphNode => {
    const n: GraphNode = { id: nid(), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } };
    outNodes.push(n);
    return n;
  };
  const mkEdge = (s: string, sh: string, t: string, th: string) =>
    outEdges.push({ id: nid() + 'e', source: s, sourceHandle: sh, target: t, targetHandle: th });

  for (const n of nodes) {
    const t = n.data.nodeType;
    const getK = GET_KIND[t];
    const setK = SET_KIND[t];
    const getId = getK ? String(n.data.config?.[getK.key] ?? '') : '';
    const setId = setK ? String(n.data.config?.[setK.key] ?? '') : '';
    // Only lower when the referenced attr/var is a VECTOR; a scalar Get/Set is
    // passed through unchanged (its value port stays scalar). The component
    // accessor is the SAME node type (`t`) reading/writing the scalar `_vx/_vy` ids.
    if (getK && getK.dims.has(getId)) {
      // Get (VALUE) → makeVector fed by N scalar component reads.
      const dims = getK.dims.get(getId)!;
      const compIds = vectorComponentIds(getId, dims);
      const mv = mkNode('makeVector', {});
      for (let i = 0; i < dims; i++) {
        const gn = mkNode(t, { [getK.key]: compIds[i]! });
        mkEdge(gn.id, vOut('value'), mv.id, vIn(AXES[i]!));
      }
      // Consumers of this node's `value` (vector) output → the makeVector's `vector`.
      remapSrc.set(`${n.id} ${vOut('value')}`, { source: mv.id, sourceHandle: vOut('vector') });
      dropIds.add(n.id);
    } else if (setK && setK.dims.has(setId)) {
      // Set (FLOW) → breakVector + a linear scalar-write chain over the components.
      const dims = setK.dims.get(setId)!;
      const compIds = vectorComponentIds(setId, dims);
      const bv = mkNode('breakVector', {});
      const setNodes: GraphNode[] = [];
      for (let i = 0; i < dims; i++) {
        const sn = mkNode(t, { [setK.key]: compIds[i]! });
        mkEdge(bv.id, vOut(AXES[i]!), sn.id, vIn('value'));
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
