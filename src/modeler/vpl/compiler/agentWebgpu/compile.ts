// ===========================================================================
// The SEPARATE WebGPU AGENT-LOOP compiler — full-coverage behaviour shader.
//
// A self-contained agent-WebGPU compiler whose per-agent behaviour pass is a
// WGSL compute shader over the GPU agent SoA (`agentWebgpu/layout.ts`). It is the
// GPU sibling of `agentWasm/compile.ts`: the SAME front-end pipeline (macro-
// expand → reroute-collapse → accessor-CSE) and the SAME honest central gate
// pattern (`isAgentGraphWebGPUSupported`) — but it emits WGSL instead of WASM
// bytes.
//
// The skeleton: one invocation per agent slot, `dispatchCells(maxAgents,64)`
// 2-D tiling (the lattice grid pattern), `highWater` a CONTROL UNIFORM (not a
// baked literal — baking forces a per-gen recompile), the alive-skip + the
// `idx >= highWater` guard. Per-agent PCG RNG keyed by `idx` (the lattice
// per-cell PCG — statistical parity, NOT bit-exact, the documented WebGPU
// target constraint).
//
// HARD CONSTRAINT: this compiler touches NO lattice/grid WebGPU code and NO
// existing agent JS/WASM path — it is wholly additive, so lattice + JS-agent +
// WASM-agent byte-identity holds BY CONSTRUCTION.
//
// SCOPE (full catalogue MINUS the documented fundamentals): 2D AND 3D agents,
// the field bridge (2D bilinear / 3D trilinear + r-disk / r-sphere via the
// fieldRead snapshot + the atomic fieldDeposit accumulator), the agent-array
// tier (getNearbyAgents / getBondedAgents / getAgentsAttribute / filter / join /
// pick + the array folds), the structural-write requests (divideAgent / formBond /
// breakBond / killAgent — flag stores the CPU structural phase consumes), user
// agent attributes, indicators (atomics), the bond store reads (forEachBond /
// getCurvature / getBondDegree), lookup tables / model attrs (auxF32), and
// array Local Variables. The REJECT set is only:
//   - aggregate/groupOperator `median` + uniform `random` (no sort / per-thread
//     pick path — same as the lattice WebGPU grid; `weightedRandom` IS supported);
//   - updateIndicator toggle/next/previous (order-dependent under parallel writers);
//   - > the array-producer scratch-slot budget (a capacity gate, not a node ban).
// Everything else runs on the GPU; a rejected graph FALLS BACK to JS via
// `isAgentGraphWebGPUSupported`.
//
// CONSTRAINTS (documented): f32 + per-agent PCG → statistical parity, not
// bit-exact (same as the lattice WebGPU grid). The divisionEvent + agentInit
// roots stay JS-on-CPU (target-independent).
// ===========================================================================

import type { GraphNode, GraphEdge, CAModel } from '../../../../model/types';
import type { ValueRef, WgslType } from '../webgpu/compile';
import { castTo } from '../webgpu/compile';
import { emitWgsl, wgslFloatLit } from '../expression/emitWgsl';
import { buildVarMap, parseExpression, clampVisibleCount } from '../expression/parser';
import { is3dModel } from '../compile';
import { expandMacros } from '../macroExpand';
import { collapseReroutes } from '../rerouteCollapse';
import { expandMultiAttrs } from '../multiAttrExpand';
import { expandForceToAgents } from '../forceToAgentsExpand';
import { expandComposites } from '../expandComposites';
import { lowerVectorAttrs, expandVectorAttributes } from '../vectorAttr';
import { lowerFacingSource } from '../facingSource';
import { canonicalizeAccessorEdges } from '../accessorCSE';
import { computeAsyncReadWriteHazards } from '../asyncWriteHazard';
import { computeVolatileHoist } from '../volatileHoist';
import { getNodeDef } from '../../nodes/registry';
import { cellFieldAttrsOf, cellFieldWriteAttrsOf, agentAttrsOf } from '../../../../model/attributeScope';
import { modelAttrSlotKeys } from '../../../../model/attributeScope';
import { categoricalHasAlpha, readCategoricalEntries, readCategoricalDefault, type CategoricalEntry } from '../../nodes/CategoricalColorNode';
import { colorConstantHasAlpha } from '../../nodes/GetColorConstantNode';
import { colorScaleHasAlpha, readColorScaleStops, type ColorScaleStop } from '../../nodes/ColorScaleNode';
import { viewCosHalf } from '../../nodes/GetAgentsInViewNode';
import { resolveKeyLabels, resolveAxes, isMultiAxisTable } from '../variegation';
import { computeAgentWebGPULayout, type AgentWebGPULayout } from './layout';
import { resolveMaxBonds } from '../../../../model/centerBased';
import { encodeAttrValue } from '../../../../model/attrValueEncoding';

/** The node types this compiler can emit to WGSL. A model whose agent graph uses
 *  ONLY these (after macro-expansion / reroute-collapse / CSE) runs on the WebGPU
 *  target; anything else FALLS BACK to JS. SINGLE source of truth for the gate +
 *  the emitter dispatch (mirrors AGENT_WASM_SUPPORTED_TYPES). */
export const AGENT_WEBGPU_SUPPORTED_TYPES: ReadonlySet<string> = new Set<string>([
  // event roots
  'behaviourStep',
  // self reads
  'getSelfPosition', 'getSelfHandle', 'getRadius', 'getAge', 'getBondDegree', 'neighbourDensity', 'getCurvature',
  // world size (the agent world IS the cell grid — control.fieldW/H/D)
  'getGridDimensions',
  // neighbour access
  'getNearbyAgents', 'getAgentsInView', 'senseHemifield', 'forEachInArray', 'getAgentOffset', 'getVelocity',
  'getAgentPosition', 'getAgentRadius', 'getAgentAttribute',
  // agent-array tier (id/value arrays + aggregate/group-reduce over them)
  'getAgentsAttribute', 'setAgentsAttribute', 'filterAgents', 'joinAgents',
  'pickRandomAgent', 'pickNRandomAgents', 'getBondedAgents',
  'aggregate', 'groupOperator', 'groupCounting', 'groupStatement',
  // bonds
  'forEachBond',
  // local variables (scalar + array)
  'getVariable', 'setVariable', 'setArrayElement',
  // array accessors
  'arrayElement', 'arrayLength',
  // agent attributes (Get/Set/Update Attribute on the agent SoA)
  'getCellAttribute', 'setAttribute', 'updateAttribute', 'setAgentAttribute',
  'setVelocity', 'setAgentPosition', 'setAgentRadius',
  // field bridge (G5 — the closed agent↔grid morphogen feedback)
  'sampleField', 'fieldGradient', 'readCellsUnder',
  'affectCellsUnder', 'secreteToField',
  // colour + tables + model attrs
  'categoricalColor', 'setCellLooks', 'getColorConstant', 'colorScale',
  'getModelAttribute', 'lookupInteraction', 'proportionMap', 'interpolation', 'valueSwitch',
  // indicators
  'getIndicator', 'setIndicator', 'updateIndicator',
  // structural writes (G4 — the post-step CPU structural phase reads the requests)
  'divideAgent', 'formBond', 'breakBond', 'killAgent',
  // mid-step graph-authored spawning (Create Agent → set-by-handle → Add To World,
  // exactly as in the Init Event — an atomic bump allocator gives the handle a real
  // slot id, so the by-id setters write the newborn directly; CPU-reconciled).
  'createAgent', 'addAgentToWorld',
  // Stop Event — atomicCompareExchangeWeak into a stopFlag buffer (worker merges it)
  'stopEvent',
  // writes
  'applyForce', 'applyForceToAgent', 'setTargetRadius',
  // value/flow utility
  'getConstant', 'arithmeticOperator', 'expression', 'statement', 'logicOperator', 'getRandom',
  // flow
  'conditional', 'sequence', 'switch', 'loop',
]);

/** Max agent-array-producer nodes (getNearbyAgents / getAgentsAttribute /
 *  filterAgents / joinAgents / pickNRandomAgents) a single shader can host. Each
 *  gets its own per-thread `var<function>` array sized `maxAgents` — a tight
 *  register/stack budget on the GPU, so keep the TOTAL small (a graph exceeding
 *  it clamps to JS, like the WASM path's AGENT_NEARBY_SCRATCH_SLOTS=4). */
export const AGENT_WEBGPU_NEARBY_SLOTS = 6;

export interface AgentWebGPUResult {
  /** The WGSL module source (empty on error / unsupported). */
  shaderCode: string;
  /** The GPU agent storage layout this shader was compiled against. */
  layout: AgentWebGPULayout;
  /** The node types the compiler actually emitted (diagnostics + the gate). */
  supportedTypes: string[];
  /** True when the behaviour body writes the i32 SoA (setAgentType) → the runtime
   *  must bind agentI32 as `storage` (read_write) + read the i32 SoA back. */
  usesI32Write?: boolean;
  /** Which universal bindings the shader actually USES (declared only when used,
   *  so the runtime binds matching entries — see the binding-declaration note). */
  usesBondStore?: boolean;
  usesIndicators?: boolean;
  usesAux?: boolean;
  /** True when the behaviour graph uses Create Agent / Add Agent To World (mid-step
   *  spawning) — the runtime then binds a spawnCursor atomic buffer (binding 12) and
   *  makes agentAlive read_write so a newborn can be committed on the GPU. */
  usesSpawn?: boolean;
  /** True when the behaviour graph uses a Stop Event — the runtime binds a
   *  stopFlag atomic buffer (binding 13), seeds it to 0, and reads it back to
   *  merge into the shared stopFlag. */
  usesStop?: boolean;
  /** True when the behaviour graph uses Apply Force To Agent (cross-agent force
   *  scatter) — the runtime binds a `forceScatter` atomic buffer (binding 14, an
   *  f32-bitcast atomic accumulator), zeros it each step, and the force pass adds it
   *  to each agent's self-force seed (its binding 4). */
  usesForceScatter?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Adjacency (a small self-contained value/flow walk for the supported subset —
// identical shape to agentWasm's).
// ---------------------------------------------------------------------------

interface Adjacency {
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  /** ALL sources for a value input port (the isArray ports — e.g. aggregate.values
   *  — accept multiple connections). `${target}:${portId}` → ordered source list. */
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;
}

function parseHandle(handleId: string | undefined): { category: 'value' | 'flow'; portId: string } | null {
  if (!handleId) return null;
  const m = handleId.match(/^(?:input|output)_(value|flow)_(.+)$/);
  if (!m) return null;
  return { category: m[1] as 'value' | 'flow', portId: m[2]! };
}

function buildAdjacency(nodes: GraphNode[], edges: GraphEdge[]): Adjacency {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();
  for (const e of edges) {
    const src = parseHandle(e.sourceHandle);
    const tgt = parseHandle(e.targetHandle);
    if (!src || !tgt) continue;
    if (tgt.category === 'value') {
      const key = `${e.target}:${tgt.portId}`;
      // First-wins single source (back-compat with the scalar-input resolvers).
      if (!inputToSource.has(key)) inputToSource.set(key, { nodeId: e.source, portId: src.portId });
      const arr = inputToSources.get(key) ?? [];
      arr.push({ nodeId: e.source, portId: src.portId });
      inputToSources.set(key, arr);
    } else {
      const key = `${e.source}:${src.portId}`;
      const arr = flowOutputToTargets.get(key) ?? [];
      arr.push({ nodeId: e.target, portId: tgt.portId });
      flowOutputToTargets.set(key, arr);
    }
  }
  return { nodeMap, inputToSource, inputToSources, flowOutputToTargets };
}

// ---------------------------------------------------------------------------
// The emitter context. Values are WGSL expression/local references (the lattice
// string model), NOT the WASM stack/local model. Each value port is materialised
// into a `let` once + cached by `${nodeId}:${portId}`; the cache is cleared at
// scope boundaries (the agent-iteration top + each forEach iteration) so a value
// reading a per-iteration `element`/`index` re-emits per iteration.
// ---------------------------------------------------------------------------

/** A reference to an agent id/value array materialised in a per-thread (function-
 *  scope) WGSL `var<function> arr<slot>: array<T, maxAgents>` + a length local.
 *  Consumers iterate `0..lenName` and read `arrName[k]`. The GPU sibling of the JS
 *  `_v<id>_result`/`_v<id>_vals` scratch arrays — every agent-array producer
 *  (getNearbyAgents / getAgentsAttribute / filterAgents / joinAgents / pickN…)
 *  emits into one of these slots. `elemType` distinguishes id arrays (`i32`, the
 *  agent index space) from value arrays (`f32`, gathered attr values). */
interface AgentArrayRef {
  arrName: string;
  lenName: string;
  elemType: WgslType;
}

interface AgentWgpuCtx {
  adj: Adjacency;
  layout: AgentWebGPULayout;
  is3d: boolean;
  /** The WGSL line buffer the current emit appends to (function body). */
  lines: string[];
  /** unique-name counter. */
  uid: number;
  /** Agent-attr id → its data type (bool/integer/float/tag), for int-rounding on
   *  a Set Attribute write (the GPU SoA is f32). */
  agentAttrType: Map<string, string>;
  /** Agent-attr id → its numeric default value (initAgentSlot parity — a GPU
   *  Create Agent resets the newborn's attrs to these, then setters override). */
  agentAttrDefault: Map<string, number>;
  /** Scalar Local-Variable id → its WGSL var name (`var<function>`, reset per agent). */
  varNames: Map<string, string>;
  /** Array Local-Variable id → its WGSL var name + fixed length (`var<function>
   *  array<f32, N>`, reset per agent). */
  arrayVarNames: Map<string, { name: string; len: number }>;
  /** Cache: `${nodeId}:${portId}` → its ValueRef. Cleared on scope change. */
  valueCache: Map<string, ValueRef>;
  /** Cache: `${nodeId}:${portId}` → its AgentArrayRef. Cleared on scope change
   *  (re-emitted per forEach iteration when volatile, like the value cache). */
  arrayCache: Map<string, AgentArrayRef>;
  /** Node ids whose cached value MUST NOT persist across a forEach iteration. */
  volatileNodes: Set<string>;
  /** Async read-after-write hazard cone (pure scalar chains): excluded from the
   *  function-top hoist; emitted ONCE before the flow node in hazardEmitBefore
   *  (the JS volatileHoist's LCA position — cross-target emission lockstep). */
  hazardPinned: Set<string>;
  hazardEmitBefore: Map<string, string[]>;
  /** Array-producing node id → its assigned `var<function>` scratch slot index.
   *  Each `i32` (id arrays) or `f32` (value arrays) producer gets its own slot. */
  arrayScratchSlot: Map<string, { slot: number; elemType: WgslType }>;
  /** Active forEach iteration locals (innermost last). `elemType` is the source
   *  array's element type (i32 for id arrays, f32 for value arrays). */
  forEachStack: Array<{ nodeId: string; elemName: string; idxName: string; elemType: WgslType }>;
  /** Active Loop nodes (innermost last) — exposes the iteration counter var
   *  for the Loop's `index` output port (mirrors forEachStack). */
  loopStack: Array<{ nodeId: string; idxName: string }>;
  /** Set when the behaviour body writes the i32 SoA (setAgentType) — the agentI32
   *  binding is then declared `read_write` (else `read`, the Boids-byte-identical
   *  default). */
  usesI32Write: boolean;
  /** Set when an emitter actually REFERENCES a universal binding — the binding is
   *  declared (and bound by the runtime) ONLY when used, so a model whose layout
   *  RESERVES a region (e.g. maxBonds>0) but whose graph never touches it does NOT
   *  declare an unused storage global (Naga strips it → a bind-group mismatch). */
  usesBondStore: boolean;
  usesIndicators: boolean;
  usesAux: boolean;
  /** Set when a Create Agent / Add Agent To World emitter runs — declares the
   *  spawnCursor atomic binding + makes agentAlive read_write. */
  usesSpawn: boolean;
  /** Set when a Stop Event emitter runs — declares the stopFlag atomic binding. */
  usesStop: boolean;
  /** Set when an Apply Force To Agent emitter runs — declares the forceScatter
   *  atomic binding (14) + emits the forceScatterAdd f32-CAS helper. */
  usesForceScatter: boolean;
  /** Active forEachBond iteration frames — the per-iteration value-output WGSL
   *  expressions (partnerId / restLength / currentLength / index). */
  forEachBondStack: Array<{ nodeId: string; partner: string; rest: string; cur: string; index: string }>;
}

function fresh(ctx: AgentWgpuCtx, hint: string): string {
  return `_${hint}${ctx.uid++}`;
}

/** Bind a WGSL expression to a fresh `let` of the given type + return its ref. */
function emitLet(ctx: AgentWgpuCtx, type: WgslType, expr: string, hint: string): ValueRef {
  const name = fresh(ctx, hint);
  const wt = type === 'f32' ? 'f32' : type === 'i32' ? 'i32' : 'bool';
  ctx.lines.push(`  let ${name}: ${wt} = ${expr};`);
  return { expr: name, type };
}

// ---------------------------------------------------------------------------
// SoA accessors — read a per-agent field from the strided storage arrays.
// ---------------------------------------------------------------------------

/** `agentF32[base + <idxExpr>]` for the named f32 field. */
function f32At(ctx: AgentWgpuCtx, field: string, idxExpr: string): string {
  const base = ctx.layout.f32Base[field]!;
  return base === 0 ? `agentF32[${idxExpr}]` : `agentF32[${base}u + ${idxExpr}]`;
}

/** `agentI32[base + <idxExpr>]` for the named i32 field. */
function i32At(ctx: AgentWgpuCtx, field: string, idxExpr: string): string {
  const base = ctx.layout.i32Base[field]!;
  return base === 0 ? `agentI32[${idxExpr}]` : `agentI32[${base}u + ${idxExpr}]`;
}

/** `fieldRead[base + <cellIdxExpr>]` for the named cell field attr (G5). The
 *  field index is `row·gridWidth + col`; `base = fieldReadBase[attrId]`. */
function fieldReadAt(ctx: AgentWgpuCtx, attrId: string, cellIdxExpr: string): string {
  const base = ctx.layout.fieldReadBase[attrId] ?? 0;
  return base === 0 ? `fieldRead[${cellIdxExpr}]` : `fieldRead[${base}u + ${cellIdxExpr}]`;
}

/** The absolute element offset of a write-attr's deposit run (for the atomic
 *  `fieldDeposit` accumulator). */
function fieldWriteBaseOf(ctx: AgentWgpuCtx, attrId: string): number {
  return ctx.layout.fieldWriteBase[attrId] ?? 0;
}

/** A `fieldRead` sample at continuous (px, py[, pz]) — bilinear in 2D, trilinear
 *  in 3D. The 3D form threads the agent's z at `pzExpr` (default the agent's own
 *  z) so Sample/Gradient stay single-source. */
function fieldSampleCall(ctx: AgentWgpuCtx, base: number, pxExpr: string, pyExpr: string, pzExpr?: string): string {
  if (ctx.is3d) {
    const pz = pzExpr ?? f32At(ctx, 'z', 'idx');
    return `fieldSampleTrilinear(${base}u, ${pxExpr}, ${pyExpr}, ${pz})`;
  }
  return `fieldSampleBilinear(${base}u, ${pxExpr}, ${pyExpr})`;
}

// ---------------------------------------------------------------------------
// Inline-widget fallback for an unwired value input.
// ---------------------------------------------------------------------------

function getInlineNum(node: GraphNode, portId: string, fallback: number): number {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const raw = cfg?.[`_port_${portId}`];
  if (typeof raw === 'string') {
    if (raw === 'true') return 1;
    if (raw === 'false') return 0;
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return fallback;
}

/** Resolve a value input port to a ValueRef. Wired → the source node's output;
 *  unwired → the inline-widget constant (f32). */
function resolveValueInput(ctx: AgentWgpuCtx, node: GraphNode, portId: string, fallback: number): ValueRef {
  const src = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
  if (src) return compileValueNode(ctx, src.nodeId, src.portId);
  return { expr: wgslFloatLit(getInlineNum(node, portId, fallback)), type: 'f32' };
}

/** Resolve + cast to f32 (most agent math is f32). */
function inF32(ctx: AgentWgpuCtx, node: GraphNode, portId: string, fallback: number): string {
  return castTo(resolveValueInput(ctx, node, portId, fallback), 'f32');
}

/** Resolve a value input ONLY when wired (no inline-widget fallback). Returns the
 *  f32 expr or `undefined` (the caller supplies its own default — e.g. the divide
 *  axis defaults to (0,0) = "engine-resolved tension axis", behaviour-equivalent to
 *  the JS path's NaN default; see the divideAgent emitter for why not a NaN). */
function resolveOptionalF32(ctx: AgentWgpuCtx, node: GraphNode, portId: string): string | undefined {
  const src = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
  if (!src) return undefined;
  return castTo(compileValueNode(ctx, src.nodeId, src.portId), 'f32');
}

// ---------------------------------------------------------------------------
// Value emission.
// ---------------------------------------------------------------------------

function compileValueNode(ctx: AgentWgpuCtx, nodeId: string, portId: string): ValueRef {
  const key = `${nodeId}:${portId}`;
  const cached = ctx.valueCache.get(key);
  if (cached !== undefined) return cached;

  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) throw new Error(`agentWebgpu: missing node ${nodeId}`);
  const type = node.data.nodeType;

  let result: ValueRef;
  switch (type) {
    case 'forEachInArray': {
      const frame = ctx.forEachStack.find(f => f.nodeId === nodeId);
      if (!frame) { result = { expr: '0', type: 'i32' }; break; }
      result = portId === 'index'
        ? { expr: frame.idxName, type: 'i32' }
        : { expr: frame.elemName, type: frame.elemType };
      break;
    }
    case 'forEachBond': {
      const frame = ctx.forEachBondStack.find(f => f.nodeId === nodeId);
      if (!frame) { result = { expr: '0', type: 'i32' }; break; }
      result = portId === 'restLength' ? { expr: frame.rest, type: 'f32' }
        : portId === 'currentLength' ? { expr: frame.cur, type: 'f32' }
        : portId === 'index' ? { expr: frame.index, type: 'i32' }
        : { expr: frame.partner, type: 'i32' }; // partnerId
      break;
    }
    case 'loop': {
      // The Loop node's per-iteration counter (`index` output). Body-only —
      // outside the live loop it resolves to 0, like forEach.
      const frame = ctx.loopStack.find(f => f.nodeId === nodeId);
      result = frame ? { expr: frame.idxName, type: 'i32' } : { expr: '0', type: 'i32' };
      break;
    }
    case 'behaviourStep': {
      result = emitBehaviourStep(ctx, portId);
      break;
    }
    case 'createAgent': {
      // The `handle` is emitted at the createAgent flow position (a `var<i32>`) and
      // cached; the top-of-function cache check returns it for downstream setters.
      // This fallback only runs if a consumer is resolved BEFORE the flow emitter —
      // it shouldn't (createAgent is NO_HOIST + precedes its consumers) → -1.
      result = ctx.valueCache.get(`${nodeId}:handle`) ?? { expr: '-1', type: 'i32' };
      break;
    }
    case 'getSelfPosition': {
      const field = portId === 'y' ? 'y' : portId === 'z' ? (ctx.is3d ? 'z' : 'y') : 'x';
      result = emitLet(ctx, 'f32', f32At(ctx, field, 'idx'), 'sp');
      break;
    }
    case 'getRadius': {
      result = emitLet(ctx, 'f32', f32At(ctx, 'radius', 'idx'), 'rad');
      break;
    }
    // Get Grid Dimensions — the agent world IS the cell grid (1:1); its dims ride
    // the Control uniform as fieldW / fieldH / fieldD (fieldD is 1 in a 2D world).
    case 'getGridDimensions': {
      const dim = portId === 'height' ? 'control.fieldH'
        : portId === 'depth' ? 'control.fieldD'
        : 'control.fieldW';
      result = emitLet(ctx, 'f32', dim, 'gdim');
      break;
    }
    case 'getAge': {
      result = emitLet(ctx, 'f32', f32At(ctx, 'age', 'idx'), 'age');
      break;
    }
    case 'getBondDegree': {
      result = emitLet(ctx, 'f32', `f32(${i32At(ctx, 'bondCount', 'idx')})`, 'bd');
      break;
    }
    case 'getSelfHandle': {
      // The current agent's own id = the loop index.
      result = emitLet(ctx, 'f32', 'f32(idx)', 'sh');
      break;
    }
    case 'neighbourDensity': {
      // The engine reduction `density` (other agents within the cutoff), read as f32.
      result = emitLet(ctx, 'f32', f32At(ctx, 'density', 'idx'), 'nd');
      break;
    }
    case 'getCellAttribute': {
      // On the agent graph, Get Cell Attribute reads the AGENT SoA (agentAttrsOf):
      // `agentF32[attrBase + idx]` (f32 storage; int/tag/bool round-trip exactly).
      const attr = (node.data.config?.['attributeId'] as string) || '_undef';
      const base = ctx.layout.agentAttrBase[attr];
      result = base === undefined
        ? { expr: '0.0', type: 'f32' }
        : emitLet(ctx, 'f32', f32At(ctx, attr, 'idx'), 'ga');
      break;
    }
    case 'categoricalColor': {
      result = emitCategoricalColor(ctx, node, portId);
      break;
    }
    case 'getColorConstant': {
      result = emitGetColorConstant(ctx, node, portId);
      break;
    }
    case 'getConstant': {
      result = { expr: wgslFloatLit(readConstantValue(node)), type: 'f32' };
      break;
    }
    case 'getModelAttribute': {
      result = emitGetModelAttribute(ctx, node, portId);
      break;
    }
    case 'proportionMap': {
      result = emitProportionMap(ctx, node);
      break;
    }
    case 'interpolation': {
      const t = inF32(ctx, node, 't', 0.5);
      const mn = inF32(ctx, node, 'min', 0);
      const mx = inF32(ctx, node, 'max', 1);
      result = emitLet(ctx, 'f32', `(${mn} + ${t} * (${mx} - ${mn}))`, 'lerp');
      break;
    }
    case 'colorScale': {
      result = emitColorScale(ctx, node, portId);
      break;
    }
    case 'valueSwitch': {
      const cond = `(${inF32(ctx, node, 'condition', 0)} != 0.0)`;
      const ifV = inF32(ctx, node, 'ifValue', 1);
      const elV = inF32(ctx, node, 'elseValue', 0);
      result = emitLet(ctx, 'f32', `select(${elV}, ${ifV}, ${cond})`, 'vsel');
      break;
    }
    case 'arrayElement': {
      result = emitArrayElement(ctx, node);
      break;
    }
    case 'arrayLength': {
      result = emitArrayLength(ctx, node);
      break;
    }
    case 'getIndicator': {
      result = emitGetIndicator(ctx, node);
      break;
    }
    case 'getBondedAgents': {
      // scalar request (no scalar output) — defer to array path.
      compileArrayNode(ctx, node.id, 'agents');
      result = { expr: '0', type: 'i32' };
      break;
    }
    case 'getCurvature': {
      result = emitGetCurvature(ctx, node);
      break;
    }
    case 'groupOperator': {
      result = emitGroupOperator(ctx, node, portId);
      break;
    }
    case 'groupCounting': {
      result = emitGroupCounting(ctx, node);
      break;
    }
    case 'groupStatement': {
      result = emitGroupStatement(ctx, node);
      break;
    }
    case 'lookupInteraction': {
      result = emitLookupInteraction(ctx, node);
      break;
    }
    case 'arithmeticOperator': {
      result = emitArithmetic(ctx, node);
      break;
    }
    case 'expression': {
      result = compileExpression(ctx, node);
      break;
    }
    case 'statement': {
      result = emitCompare(ctx, node);
      break;
    }
    case 'logicOperator': {
      result = emitLogic(ctx, node);
      break;
    }
    case 'getRandom': {
      result = emitGetRandom(ctx, node);
      break;
    }
    case 'getVariable': {
      const variableId = (node.data.config?.['variableId'] as string) || '';
      const name = variableId ? ctx.varNames.get(variableId) : undefined;
      result = name ? { expr: name, type: 'f32' } : { expr: '0.0', type: 'f32' };
      break;
    }
    case 'getAgentPosition': {
      if ((node.data.config?.['mode'] as string) === 'relative') {
        result = compileAgentRelativePosition(ctx, node, portId);
        break;
      }
      const g = emitAgentIdGuarded(ctx, node, 'agentId');
      const field = portId === 'y' ? 'y' : portId === 'z' ? (ctx.is3d ? 'z' : 'y') : 'x';
      result = emitLet(ctx, 'f32', `select(0.0, ${f32At(ctx, field, g.name)}, ${g.ok})`, 'gp');
      break;
    }
    case 'getAgentRadius': {
      const g = emitAgentIdGuarded(ctx, node, 'agentId');
      result = emitLet(ctx, 'f32', `select(0.0, ${f32At(ctx, 'radius', g.name)}, ${g.ok})`, 'gr');
      break;
    }
    case 'getVelocity': {
      // self when agentId is unwired (JS: `inputs.agentId ? (...|0) : idx`) —
      // self is always valid; a WIRED id is range-guarded like JS/WASM.
      const src = ctx.adj.inputToSource.get(`${node.id}:agentId`);
      const field = portId === 'vy' ? 'vy' : portId === 'vz' ? (ctx.is3d ? 'vz' : 'vy') : 'vx';
      if (!src) {
        result = emitLet(ctx, 'f32', f32At(ctx, field, 'idx'), 'gv');
        break;
      }
      const g = emitAgentIdGuarded(ctx, node, 'agentId');
      result = emitLet(ctx, 'f32', `select(0.0, ${f32At(ctx, field, g.name)}, ${g.ok})`, 'gv');
      break;
    }
    case 'getAgentAttribute': {
      // Read a SPECIFIC agent's attribute by id → `agentF32[attrBase + id]`.
      const attr = (node.data.config?.['attributeId'] as string) || '_undef';
      const base = ctx.layout.agentAttrBase[attr];
      if (base === undefined) { result = { expr: '0.0', type: 'f32' }; break; }
      const g = emitAgentIdGuarded(ctx, node, 'agentId');
      result = emitLet(ctx, 'f32', `select(0.0, ${f32At(ctx, attr, g.name)}, ${g.ok})`, 'gaa1');
      break;
    }
    case 'aggregate': {
      result = emitAggregate(ctx, node);
      break;
    }
    case 'pickRandomAgent': {
      result = emitPickRandomAgent(ctx, node);
      break;
    }
    case 'filterAgents':
    case 'joinAgents': {
      // The `count` port is the only scalar output; `result` is an array. A scalar
      // request for either resolves the array (caching count) then returns count.
      // (A consumer reading `result` goes through compileArrayNode, not here.)
      compileArrayNode(ctx, node.id, 'result');
      result = ctx.valueCache.get(`${node.id}:count`) ?? { expr: '0', type: 'i32' };
      break;
    }
    case 'getAgentOffset': {
      result = compileAgentOffset(ctx, node, portId);
      break;
    }
    case 'senseHemifield': {
      result = emitSenseHemifield(ctx, node, portId);
      break;
    }
    case 'sampleField': {
      result = emitSampleField(ctx, node);
      break;
    }
    case 'fieldGradient': {
      result = compileFieldGradient(ctx, node, portId);
      break;
    }
    case 'readCellsUnder': {
      result = emitReadCellsUnder(ctx, node);
      break;
    }
    default:
      throw new Error(`agentWebgpu: unsupported value node '${type}'`);
  }

  ctx.valueCache.set(key, result);
  return result;
}

/** The behaviourStep self value-outs (the per-agent geometry/identity preamble). */
function emitBehaviourStep(ctx: AgentWgpuCtx, portId: string): ValueRef {
  switch (portId) {
    case 'myX': return emitLet(ctx, 'f32', f32At(ctx, 'x', 'idx'), 'myX');
    case 'myY': return emitLet(ctx, 'f32', f32At(ctx, 'y', 'idx'), 'myY');
    // `myZ` exists only in a 3D world (the `z` SoA run is appended only then, and
    // the port is hidden in 2D). Without this case a 3D Behaviour Step → Z wire
    // silently read 0.0 on WebGPU while JS/WASM read `_agentZ[idx]`.
    case 'myZ': return ctx.is3d
      ? emitLet(ctx, 'f32', f32At(ctx, 'z', 'idx'), 'myZ')
      : { expr: '0.0', type: 'f32' };
    case 'myRadius': return emitLet(ctx, 'f32', f32At(ctx, 'radius', 'idx'), 'myR');
    case 'myArea': {
      const r = f32At(ctx, 'radius', 'idx');
      return emitLet(ctx, 'f32', `(3.14159265358979 * ${r} * ${r})`, 'myA');
    }
    case 'myAge': return emitLet(ctx, 'f32', f32At(ctx, 'age', 'idx'), 'myG');
    case 'myBondDegree': return emitLet(ctx, 'f32', `f32(${i32At(ctx, 'bondCount', 'idx')})`, 'myBd');
    default: return { expr: '0.0', type: 'f32' };
  }
}

/** Resolve the `agentId` input → a fresh u32 index local (for SoA addressing). */
/** Range-guarded agent id (the READER nodes): unwired → -1 (the empty sentinel),
 *  `ok = id in [0, highWater)`, index clamped for the eager load. Mirrors the
 *  JS/WASM readers' guard — an invalid id yields 0, never agent 0's value. */
function emitAgentIdGuarded(ctx: AgentWgpuCtx, node: GraphNode, portId: string): { name: string; ok: string } {
  const ref = resolveValueInput(ctx, node, portId, -1);
  const raw = fresh(ctx, 'aidRaw'); const ok = fresh(ctx, 'aidOk'); const nm = fresh(ctx, 'aid');
  ctx.lines.push(`  let ${raw}: i32 = ${castTo(ref, 'i32')};`);
  ctx.lines.push(`  let ${ok}: bool = (${raw} >= 0 && ${raw} < i32(control.highWater));`);
  ctx.lines.push(`  let ${nm}: u32 = u32(select(0, ${raw}, ${ok}));`);
  return { name: nm, ok };
}

/** Get Constant — numeric / bool only in the supported set. */
function readConstantValue(node: GraphNode): number {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const ct = (cfg?.['constType'] as string) ?? 'integer';
  const raw = cfg?.['constValue'];
  const rawStr = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '0';
  if (ct === 'bool') return rawStr === 'true' ? 1 : 0;
  if (ct === 'float') { const n = parseFloat(rawStr); return Number.isFinite(n) ? n : 0; }
  const n = parseInt(rawStr, 10); return Number.isFinite(n) ? n : 0;
}

/** Math node — mirrors the lattice WGSL arithmeticOperator (f32, the ÷0→0 guard). */
function emitArithmetic(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['operation'] as string) ?? '+';
  const x = () => inF32(ctx, node, 'x', 0);
  const y = () => inF32(ctx, node, 'y', 0);
  let expr: string;
  switch (op) {
    case '+': case 'add': expr = `(${x()} + ${y()})`; break;
    case '-': expr = `(${x()} - ${y()})`; break;
    case '*': expr = `(${x()} * ${y()})`; break;
    case '/': { const yv = y(); expr = `select(0.0, (${x()} / ${yv}), (${yv} != 0.0))`; break; }
    case 'sqrt': expr = `sqrt(${x()})`; break;
    case 'abs': expr = `abs(${x()})`; break;
    case 'max': expr = `max(${x()}, ${y()})`; break;
    case 'min': expr = `min(${x()}, ${y()})`; break;
    case 'mean': expr = `((${x()} + ${y()}) * 0.5)`; break;
    case 'pow': expr = `pow(${x()}, ${y()})`; break;
    case 'exp': expr = `exp(${x()})`; break;
    case 'log': expr = `log(${x()})`; break;
    case 'sin': expr = `sin(${x()})`; break;
    case 'cos': expr = `cos(${x()})`; break;
    case 'tan': expr = `tan(${x()})`; break;
    case 'tanh': expr = `tanh(${x()})`; break;
    case '%': {
      // (y != 0 ? x % y : 0) — WGSL's f32 % is the trunc-remainder like JS.
      const yv = y();
      expr = `select(0.0, (${x()} % ${yv}), (${yv} != 0.0))`;
      break;
    }
    default: expr = `(${x()} + ${y()})`; break;
  }
  return emitLet(ctx, 'f32', expr, 'ar');
}

/** Compare node — numerical compare ops → an f32 1.0/0.0. */
function emitCompare(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  // The Compare (`statement`) node stores its operator under `operation` (see
  // StatementNode.defaultConfig / its JS compile) — NOT `operator`. Reading the
  // wrong key made every non-equality op fall through to `==` on the WebGPU
  // agent target (silent divergence from the JS / WASM agent path).
  const op = (cfg?.['operation'] as string) ?? '==';
  const x = inF32(ctx, node, 'x', 0);
  const y = inF32(ctx, node, 'y', 0);
  if (op === 'between' || op === 'notBetween') {
    // (x lowOp y) && (x highOp y2), inverted for notBetween — mirrors
    // StatementNode's JS emit (previously gate-rejected → JS clamp).
    const y2 = inF32(ctx, node, 'y2', 0);
    const lo = cfg?.['lowOp'] === '>' ? '>' : '>=';
    const hi = cfg?.['highOp'] === '<' ? '<' : '<=';
    const inside = `((${x} ${lo} ${y}) && (${x} ${hi} ${y2}))`;
    return emitLet(ctx, 'f32', `select(0.0, 1.0, ${op === 'notBetween' ? `!${inside}` : inside})`, 'cmp');
  }
  let cond: string;
  switch (op) {
    case '==': cond = `(${x} == ${y})`; break;
    case '!=': cond = `(${x} != ${y})`; break;
    case '>': cond = `(${x} > ${y})`; break;
    case '<': cond = `(${x} < ${y})`; break;
    case '>=': cond = `(${x} >= ${y})`; break;
    case '<=': cond = `(${x} <= ${y})`; break;
    default: cond = `(${x} == ${y})`; break;
  }
  return emitLet(ctx, 'f32', `select(0.0, 1.0, ${cond})`, 'cmp');
}

/** Logic node — AND/OR/XOR/NOT over boolean (non-zero) f32 inputs → 1.0/0.0. The
 *  LogicOperatorNode stores its op UPPERCASE ('AND'/'OR'/'XOR'/'NOT'), so lowercase
 *  before matching — otherwise 'OR'/'XOR'/'NOT' fall through to AND (the GoL-on-
 *  agents all-die bug: every OR-births rule silently became an AND). */
function emitLogic(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = ((cfg?.['operation'] as string) ?? 'and').toLowerCase();
  const a = `(${inF32(ctx, node, 'a', 0)} != 0.0)`;
  if (op === 'not') return emitLet(ctx, 'f32', `select(0.0, 1.0, !${a})`, 'lg');
  const b = `(${inF32(ctx, node, 'b', 0)} != 0.0)`;
  let cond: string;
  if (op === 'or') cond = `(${a} || ${b})`;
  else if (op === 'xor') cond = `(${a} != ${b})`;
  else cond = `(${a} && ${b})`;
  return emitLet(ctx, 'f32', `select(0.0, 1.0, ${cond})`, 'lg');
}

/** Expression node — parse the formula + emit via the shared WGSL AST emitter. */
function compileExpression(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown>;
  const visibleCount = clampVisibleCount(cfg['visibleCount']);
  const { map, errors } = buildVarMap(cfg as Parameters<typeof buildVarMap>[0], visibleCount);
  if (errors.length > 0) throw new Error(`expression: ${errors[0]}`);
  const res = parseExpression(String(cfg['expression'] ?? ''), map);
  if ('error' in res) throw new Error(`expression: ${res.error}`);
  const inputs: Record<string, ValueRef | undefined> = {};
  const portIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (let i = 0; i < visibleCount && i < portIds.length; i++) {
    const pid = portIds[i]!;
    inputs[pid] = resolveValueInput(ctx, node, pid, 0);
  }
  const expr = emitWgsl(res.ast, inputs);
  return emitLet(ctx, 'f32', expr, 'ex');
}

/** Get Random — float / integer / orientation / bool / options. Per-agent
 *  PCG keyed by `idx` (the lattice grid model — statistical parity, NOT bit-exact
 *  vs JS/WASM's shared xorshift32 stream; the documented WebGPU constraint). */
function emitGetRandom(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const t = (cfg?.['randomType'] as string) || (cfg?.['mode'] as string) || 'float';
  const minRaw = cfg?.['min']; const maxRaw = cfg?.['max'];
  const minN = typeof minRaw === 'number' ? minRaw : parseFloat(String(minRaw ?? '0')) || 0;
  const maxN = typeof maxRaw === 'number' ? maxRaw : parseFloat(String(maxRaw ?? '1')) || 1;
  const r = 'rand_f32(idx)';
  if (t === 'options') {
    // One option picked uniformly; Fallback when empty (previously gate-rejected
    // → JS clamp). Multi-source scalars pick via a compile-time if/else chain;
    // a single array-producer source picks at its runtime length.
    const fb = castTo(resolveValueInput(ctx, node, 'fallback', 0), 'f32');
    const sources = ctx.adj.inputToSources.get(`${node.id}:options`) ?? [];
    const singleProducer = sources.length === 1
      && isAgentArrayProducer(ctx.adj.nodeMap.get(sources[0]!.nodeId)?.data.nodeType ?? '');
    const res = fresh(ctx, 'ropt');
    if (singleProducer || (sources.length === 0 && ctx.adj.inputToSource.get(`${node.id}:options`))) {
      const arr = resolveInputArray(ctx, node, 'options');
      ctx.lines.push(`  var ${res}: f32 = ${fb};`);
      if (arr) {
        const k = fresh(ctx, 'roptK');
        const elem = arr.elemType === 'f32' ? arrLoad(arr, k) : `f32(${arrLoad(arr, k)})`;
        ctx.lines.push(`  if (${arr.lenName} > 0) {`);
        ctx.lines.push(`    let ${k}: i32 = clamp(i32(${r} * f32(${arr.lenName})), 0, ${arr.lenName} - 1);`);
        ctx.lines.push(`    ${res} = ${elem};`);
        ctx.lines.push(`  }`);
      }
      return { expr: res, type: 'f32' };
    }
    if (sources.length === 0) return emitLet(ctx, 'f32', fb, 'ropt');
    // multi-source scalars — resolve each, draw once, pick by compile-time index.
    const vals = sources.map(s => castTo(compileValueNode(ctx, s.nodeId, s.portId), 'f32'));
    const k = fresh(ctx, 'roptK');
    ctx.lines.push(`  let ${k}: i32 = i32(${r} * ${wgslFloatLit(vals.length)});`);
    ctx.lines.push(`  var ${res}: f32 = ${vals[vals.length - 1]};`);
    vals.slice(0, -1).forEach((v, i) => {
      ctx.lines.push(`  if (${k} == ${i}) { ${res} = ${v}; }`);
    });
    return { expr: res, type: 'f32' };
  }
  if (t === 'bool') {
    const probRef = resolveValueInput(ctx, node, 'probability', 0.5);
    return emitLet(ctx, 'f32', `select(0.0, 1.0, (${r} < ${castTo(probRef, 'f32')}))`, 'rb');
  }
  if (t === 'integer') {
    const span = maxN - minN + 1;
    return emitLet(ctx, 'f32', `(floor(${r} * ${wgslFloatLit(span)}) + ${wgslFloatLit(minN)})`, 'ri');
  }
  if (t === 'orientation') {
    return emitLet(ctx, 'f32', `f32(i32(${r} * 4.0) & 3)`, 'ro');
  }
  // float: uniform * (max - min) + min
  return emitLet(ctx, 'f32', `(${r} * ${wgslFloatLit(maxN - minN)} + ${wgslFloatLit(minN)})`, 'rf');
}

/** Categorical Color — integer index → flat RGB from an N-entry palette (no
 *  blending). Multi-output (r/g/b); emit the select chain once into shared `var`
 *  locals + cache all ports. Mirrors the lattice WGSL categoricalColor. */
function emitCategoricalColor(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const cachedSibling = ctx.valueCache.get(`${node.id}:r`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  const idx = castTo(resolveValueInput(ctx, node, 'index', 0), 'i32');
  const entries = readCategoricalEntries(node.data.config as Record<string, string | number | boolean>);
  const d = readCategoricalDefault(node.data.config as Record<string, string | number | boolean>);
  // `a` minted LAST and only when declared - see the colorScale twin.
  const withA = categoricalHasAlpha(node.data.config as Record<string, string | number | boolean>);
  const chans: Array<{ name: string; get: (e: CategoricalEntry) => number }> = [
    { name: fresh(ctx, 'ccr'), get: e => e.r },
    { name: fresh(ctx, 'ccg'), get: e => e.g },
    { name: fresh(ctx, 'ccb'), get: e => e.b },
  ];
  if (withA) chans.push({ name: fresh(ctx, 'cca'), get: e => e.a ?? 255 });
  ctx.lines.push(`  ${chans.map(c => `var ${c.name}: i32;`).join(' ')}`);
  const writeConst = (e: CategoricalEntry) => chans.map(c => `${c.name} = ${c.get(e) | 0};`).join(' ');
  if (entries.length === 0) {
    ctx.lines.push(`  ${writeConst(d)}`);
  } else {
    const kName = fresh(ctx, 'cck');
    ctx.lines.push(`  let ${kName}: i32 = ${idx};`);
    entries.forEach((e, i) => {
      const head = i === 0 ? `if (${kName} == ${i})` : `else if (${kName} == ${i})`;
      ctx.lines.push(`  ${head} { ${writeConst(e)} }`);
    });
    ctx.lines.push(`  else { ${writeConst(d)} }`);
  }
  const refs: Record<string, ValueRef> = {};
  (withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b']).forEach((pn, i) => {
    refs[pn] = { expr: chans[i]!.name, type: 'i32' };
  });
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['r']!;
}

/** Get Agent Offset — torus-shortest (dX, dY) + Distance from self to a target.
 *  Multi-output: one emit pass into shared locals; cache all ports. */
function compileAgentOffset(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const is3d = ctx.is3d;
  const cachedSibling = ctx.valueCache.get(`${node.id}:dx`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  // Range-guarded (mirrors JS/WASM): an invalid id yields a zero vector.
  const g = emitAgentIdGuarded(ctx, node, 'agentId');
  const aName = g.name;
  const dx = fresh(ctx, 'odx'), dy = fresh(ctx, 'ody'), dz = fresh(ctx, 'odz'), dist = fresh(ctx, 'odist');
  ctx.lines.push(`  var ${dx}: f32 = select(0.0, ${f32At(ctx, 'x', aName)} - ${f32At(ctx, 'x', 'idx')}, ${g.ok});`);
  ctx.lines.push(`  var ${dy}: f32 = select(0.0, ${f32At(ctx, 'y', aName)} - ${f32At(ctx, 'y', 'idx')}, ${g.ok});`);
  if (is3d) ctx.lines.push(`  var ${dz}: f32 = select(0.0, ${f32At(ctx, 'z', aName)} - ${f32At(ctx, 'z', 'idx')}, ${g.ok});`);
  // torus fold over the world bounds (control.fieldW / fieldH / fieldD / fieldTorus).
  ctx.lines.push(`  if (control.fieldTorus != 0u) {`);
  ctx.lines.push(`    let _hW = control.fieldW * 0.5; let _hH = control.fieldH * 0.5;`);
  ctx.lines.push(`    if (${dx} > _hW) { ${dx} = ${dx} - control.fieldW; } else if (${dx} < -_hW) { ${dx} = ${dx} + control.fieldW; }`);
  ctx.lines.push(`    if (${dy} > _hH) { ${dy} = ${dy} - control.fieldH; } else if (${dy} < -_hH) { ${dy} = ${dy} + control.fieldH; }`);
  if (is3d) {
    ctx.lines.push(`    let _hD = control.fieldD * 0.5;`);
    ctx.lines.push(`    if (${dz} > _hD) { ${dz} = ${dz} - control.fieldD; } else if (${dz} < -_hD) { ${dz} = ${dz} + control.fieldD; }`);
  }
  ctx.lines.push(`  }`);
  const distMag = is3d ? `${dx} * ${dx} + ${dy} * ${dy} + ${dz} * ${dz}` : `${dx} * ${dx} + ${dy} * ${dy}`;
  ctx.lines.push(`  let ${dist}: f32 = sqrt(${distMag});`);
  const refs: Record<string, ValueRef> = {
    dx: { expr: dx, type: 'f32' },
    dy: { expr: dy, type: 'f32' },
    dz: { expr: is3d ? dz : '0.0', type: 'f32' },
    distance: { expr: dist, type: 'f32' },
  };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['dx']!;
}

/** Get Agent Position (relative mode) — torus-shortest (X, Y[, Z]) displacement
 *  from a REFERENCE agent to the target: `target − reference`, folded to the
 *  shortest path. Like compileAgentOffset minus the Distance output, with `ref` in
 *  place of `idx`; the reference defaults to SELF (`idx`) when `refId` is unwired.
 *  Multi-output: one emit pass into shared vars cached under x/y/z. */
function compileAgentRelativePosition(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const is3d = ctx.is3d;
  const cachedSibling = ctx.valueCache.get(`${node.id}:x`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  // Range-guarded BOTH ids (mirrors JS/WASM; self is trivially in range).
  const gA = emitAgentIdGuarded(ctx, node, 'agentId');
  const aName = gA.name;
  const refSrc = ctx.adj.inputToSource.get(`${node.id}:refId`);
  const gR = refSrc ? emitAgentIdGuarded(ctx, node, 'refId') : null;
  const refName = gR ? gR.name : 'idx';
  const okBoth = gR ? `(${gA.ok} && ${gR.ok})` : gA.ok;
  const ox = fresh(ctx, 'rpx'), oy = fresh(ctx, 'rpy'), oz = fresh(ctx, 'rpz');
  ctx.lines.push(`  var ${ox}: f32 = select(0.0, ${f32At(ctx, 'x', aName)} - ${f32At(ctx, 'x', refName)}, ${okBoth});`);
  ctx.lines.push(`  var ${oy}: f32 = select(0.0, ${f32At(ctx, 'y', aName)} - ${f32At(ctx, 'y', refName)}, ${okBoth});`);
  if (is3d) ctx.lines.push(`  var ${oz}: f32 = select(0.0, ${f32At(ctx, 'z', aName)} - ${f32At(ctx, 'z', refName)}, ${okBoth});`);
  ctx.lines.push(`  if (control.fieldTorus != 0u) {`);
  ctx.lines.push(`    let _hW = control.fieldW * 0.5; let _hH = control.fieldH * 0.5;`);
  ctx.lines.push(`    if (${ox} > _hW) { ${ox} = ${ox} - control.fieldW; } else if (${ox} < -_hW) { ${ox} = ${ox} + control.fieldW; }`);
  ctx.lines.push(`    if (${oy} > _hH) { ${oy} = ${oy} - control.fieldH; } else if (${oy} < -_hH) { ${oy} = ${oy} + control.fieldH; }`);
  if (is3d) {
    ctx.lines.push(`    let _hD = control.fieldD * 0.5;`);
    ctx.lines.push(`    if (${oz} > _hD) { ${oz} = ${oz} - control.fieldD; } else if (${oz} < -_hD) { ${oz} = ${oz} + control.fieldD; }`);
  }
  ctx.lines.push(`  }`);
  const refs: Record<string, ValueRef> = {
    x: { expr: ox, type: 'f32' },
    y: { expr: oy, type: 'f32' },
    z: { expr: is3d ? oz : '0.0', type: 'f32' },
  };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['x']!;
}

// ---------------------------------------------------------------------------
// Field bridge (G5) — the closed agent↔grid morphogen feedback.
//
// READS (Sample Field / Field Gradient / Read Cells Under) sample the read-only
// `fieldRead` snapshot via the module-level `fieldSampleBilinear` helper (2D
// cell-centered bilinear, torus / clamp from control). WRITES (Affect Cells
// Under / Secrete To Field) accumulate into the atomic `fieldDeposit` buffer
// through `fieldDepositCell` (an f32-bitcast CAS loop per op) so parallel agents
// writing the same cell don't race. Mirrors the JS emitters' math (2D).
// ---------------------------------------------------------------------------

/** Resolve the chosen cell-attr id of a field node (Sample/Affect/…). */
function fieldAttrId(node: GraphNode): string {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const id = cfg?.['attributeId'];
  return typeof id === 'string' && id.length > 0 ? id : '_undef';
}

/** Sample Field — bilinearly (2D) / trilinearly (3D) read the field at the
 *  agent's (x, y[, z]). */
function emitSampleField(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const attr = fieldAttrId(node);
  const base = ctx.layout.fieldReadBase[attr] ?? 0;
  const px = f32At(ctx, 'x', 'idx'), py = f32At(ctx, 'y', 'idx');
  return emitLet(ctx, 'f32', fieldSampleCall(ctx, base, px, py), 'sf');
}

/** Field Gradient — central differences (±0.5 cell) of the bilinear/trilinear
 *  field. Multi-output (∂x, ∂y[, ∂z] in 3D); emit into shared locals + cache
 *  all ports. */
function compileFieldGradient(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const cachedSibling = ctx.valueCache.get(`${node.id}:dx`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  const attr = fieldAttrId(node);
  const base = ctx.layout.fieldReadBase[attr] ?? 0;
  const px = f32At(ctx, 'x', 'idx'), py = f32At(ctx, 'y', 'idx');
  const dxN = fresh(ctx, 'gdx'), dyN = fresh(ctx, 'gdy');
  ctx.lines.push(`  let ${dxN}: f32 = ${fieldSampleCall(ctx, base, `${px} + 0.5`, py)} - ${fieldSampleCall(ctx, base, `${px} - 0.5`, py)};`);
  ctx.lines.push(`  let ${dyN}: f32 = ${fieldSampleCall(ctx, base, px, `${py} + 0.5`)} - ${fieldSampleCall(ctx, base, px, `${py} - 0.5`)};`);
  const refs: Record<string, ValueRef> = {
    dx: { expr: dxN, type: 'f32' },
    dy: { expr: dyN, type: 'f32' },
  };
  if (ctx.is3d) {
    const pz = f32At(ctx, 'z', 'idx');
    const dzN = fresh(ctx, 'gdz');
    ctx.lines.push(`  let ${dzN}: f32 = ${fieldSampleCall(ctx, base, px, py, `${pz} + 0.5`)} - ${fieldSampleCall(ctx, base, px, py, `${pz} - 0.5`)};`);
    refs['dz'] = { expr: dzN, type: 'f32' };
  }
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['dx']!;
}

/** Read Cells Under — aggregate (mean/sum/max/min) the field over an r-disk (2D)
 *  / r-sphere (3D) under the agent. Reads the `fieldRead` snapshot. The 3D path
 *  adds a layer loop + 3D torus-shortest membership (the sphere wraps near the
 *  z-seam) + the 3D field index, mirroring ReadCellsUnderNode's 3D JS. */
function emitReadCellsUnder(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const attr = fieldAttrId(node);
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const reduce = (cfg?.['reduce'] as string) || 'mean';
  const r = castTo(resolveValueInput(ctx, node, 'radius', 2), 'f32');
  const cx = f32At(ctx, 'x', 'idx'), cy = f32At(ctx, 'y', 'idx');
  const out = fresh(ctx, 'rcu');
  const acc = fresh(ctx, 'rcuA'), n = fresh(ctx, 'rcuN'), rr = fresh(ctx, 'rcuR2');
  const cxL = fresh(ctx, 'rcuCx'), cyL = fresh(ctx, 'rcuCy'), rL = fresh(ctx, 'rcuRad');
  const init = reduce === 'max' ? '-3.4028235e38' : reduce === 'min' ? '3.4028235e38' : '0.0';
  const accumLine = (val: string) => {
    if (reduce === 'max') ctx.lines.push(`        if (${val} > ${acc}) { ${acc} = ${val}; }`);
    else if (reduce === 'min') ctx.lines.push(`        if (${val} < ${acc}) { ${acc} = ${val}; }`);
    else ctx.lines.push(`        ${acc} = ${acc} + ${val};`);
    ctx.lines.push(`        ${n} = ${n} + 1;`);
  };

  if (ctx.is3d) {
    const cz = f32At(ctx, 'z', 'idx');
    const czL = fresh(ctx, 'rcuCz');
    ctx.lines.push(`  let ${cxL}: f32 = ${cx}; let ${cyL}: f32 = ${cy}; let ${czL}: f32 = ${cz}; let ${rL}: f32 = ${r};`);
    ctx.lines.push(`  var ${acc}: f32 = ${init}; var ${n}: i32 = 0; let ${rr}: f32 = ${rL} * ${rL};`);
    const W = `f32(control.fieldW)`, H = `f32(control.fieldH)`, D = `f32(control.fieldD)`;
    const hW = fresh(ctx, 'rcuHw'), hH = fresh(ctx, 'rcuHh'), hD = fresh(ctx, 'rcuHd');
    ctx.lines.push(`  let ${hW}: f32 = ${W} * 0.5; let ${hH}: f32 = ${H} * 0.5; let ${hD}: f32 = ${D} * 0.5;`);
    const cmin = fresh(ctx, 'rcuCmin'), cmax = fresh(ctx, 'rcuCmax'), rmin = fresh(ctx, 'rcuRmin'), rmax = fresh(ctx, 'rcuRmax'), lmin = fresh(ctx, 'rcuLmin'), lmax = fresh(ctx, 'rcuLmax');
    ctx.lines.push(`  let ${cmin}: i32 = i32(floor(${cxL} - ${rL})); let ${cmax}: i32 = i32(ceil(${cxL} + ${rL}));`);
    ctx.lines.push(`  let ${rmin}: i32 = i32(floor(${cyL} - ${rL})); let ${rmax}: i32 = i32(ceil(${cyL} + ${rL}));`);
    ctx.lines.push(`  let ${lmin}: i32 = i32(floor(${czL} - ${rL})); let ${lmax}: i32 = i32(ceil(${czL} + ${rL}));`);
    const li = fresh(ctx, 'rcuLi'), ri = fresh(ctx, 'rcuRi'), ci = fresh(ctx, 'rcuCi');
    ctx.lines.push(`  for (var ${li}: i32 = ${lmin}; ${li} <= ${lmax}; ${li} = ${li} + 1) {`);
    ctx.lines.push(`  for (var ${ri}: i32 = ${rmin}; ${ri} <= ${rmax}; ${ri} = ${ri} + 1) {`);
    ctx.lines.push(`  for (var ${ci}: i32 = ${cmin}; ${ci} <= ${cmax}; ${ci} = ${ci} + 1) {`);
    const ddx = fresh(ctx, 'rcuDx'), ddy = fresh(ctx, 'rcuDy'), ddz = fresh(ctx, 'rcuDz');
    ctx.lines.push(`    var ${ddx}: f32 = f32(${ci}) - ${cxL}; var ${ddy}: f32 = f32(${ri}) - ${cyL}; var ${ddz}: f32 = f32(${li}) - ${czL};`);
    // torus-shortest fold of the membership offsets (matches the 3D JS)
    ctx.lines.push(`    if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`      if (${ddx} > ${hW}) { ${ddx} = ${ddx} - ${W}; } else if (${ddx} < -${hW}) { ${ddx} = ${ddx} + ${W}; }`);
    ctx.lines.push(`      if (${ddy} > ${hH}) { ${ddy} = ${ddy} - ${H}; } else if (${ddy} < -${hH}) { ${ddy} = ${ddy} + ${H}; }`);
    ctx.lines.push(`      if (${ddz} > ${hD}) { ${ddz} = ${ddz} - ${D}; } else if (${ddz} < -${hD}) { ${ddz} = ${ddz} + ${D}; }`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`    if (${ddx} * ${ddx} + ${ddy} * ${ddy} + ${ddz} * ${ddz} <= ${rr}) {`);
    const col = fresh(ctx, 'rcuCol'), row = fresh(ctx, 'rcuRow'), lay = fresh(ctx, 'rcuLay'), inb = fresh(ctx, 'rcuIn');
    ctx.lines.push(`      var ${col}: i32 = ${ci}; var ${row}: i32 = ${ri}; var ${lay}: i32 = ${li}; var ${inb}: bool = true;`);
    ctx.lines.push(`      if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`        ${col} = ((${col} % i32(control.fieldW)) + i32(control.fieldW)) % i32(control.fieldW);`);
    ctx.lines.push(`        ${row} = ((${row} % i32(control.fieldH)) + i32(control.fieldH)) % i32(control.fieldH);`);
    ctx.lines.push(`        ${lay} = ((${lay} % i32(control.fieldD)) + i32(control.fieldD)) % i32(control.fieldD);`);
    ctx.lines.push(`      } else {`);
    ctx.lines.push(`        if (${col} < 0 || ${col} >= i32(control.fieldW) || ${row} < 0 || ${row} >= i32(control.fieldH) || ${lay} < 0 || ${lay} >= i32(control.fieldD)) { ${inb} = false; }`);
    ctx.lines.push(`      }`);
    ctx.lines.push(`      if (${inb}) {`);
    const val = fresh(ctx, 'rcuVal');
    // 3D field index = (lay·H + row)·W + col.
    ctx.lines.push(`        let ${val}: f32 = ${fieldReadAt(ctx, attr, `(u32(${lay}) * u32(control.fieldH) + u32(${row})) * u32(control.fieldW) + u32(${col})`)};`);
    accumLine(val);
    ctx.lines.push(`      }`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`  } } }`);
  } else {
    ctx.lines.push(`  let ${cxL}: f32 = ${cx}; let ${cyL}: f32 = ${cy}; let ${rL}: f32 = ${r};`);
    ctx.lines.push(`  var ${acc}: f32 = ${init}; var ${n}: i32 = 0; let ${rr}: f32 = ${rL} * ${rL};`);
    const cmin = fresh(ctx, 'rcuCmin'), cmax = fresh(ctx, 'rcuCmax'), rmin = fresh(ctx, 'rcuRmin'), rmax = fresh(ctx, 'rcuRmax');
    ctx.lines.push(`  let ${cmin}: i32 = i32(floor(${cxL} - ${rL})); let ${cmax}: i32 = i32(ceil(${cxL} + ${rL}));`);
    ctx.lines.push(`  let ${rmin}: i32 = i32(floor(${cyL} - ${rL})); let ${rmax}: i32 = i32(ceil(${cyL} + ${rL}));`);
    const ri = fresh(ctx, 'rcuRi'), ci = fresh(ctx, 'rcuCi');
    ctx.lines.push(`  for (var ${ri}: i32 = ${rmin}; ${ri} <= ${rmax}; ${ri} = ${ri} + 1) {`);
    ctx.lines.push(`  for (var ${ci}: i32 = ${cmin}; ${ci} <= ${cmax}; ${ci} = ${ci} + 1) {`);
    const ddx = fresh(ctx, 'rcuDx'), ddy = fresh(ctx, 'rcuDy');
    ctx.lines.push(`    let ${ddx}: f32 = f32(${ci}) - ${cxL}; let ${ddy}: f32 = f32(${ri}) - ${cyL};`);
    ctx.lines.push(`    if (${ddx} * ${ddx} + ${ddy} * ${ddy} <= ${rr}) {`);
    const col = fresh(ctx, 'rcuCol'), row = fresh(ctx, 'rcuRow'), inb = fresh(ctx, 'rcuIn');
    ctx.lines.push(`      var ${col}: i32 = ${ci}; var ${row}: i32 = ${ri}; var ${inb}: bool = true;`);
    ctx.lines.push(`      if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`        ${col} = ((${col} % i32(control.fieldW)) + i32(control.fieldW)) % i32(control.fieldW);`);
    ctx.lines.push(`        ${row} = ((${row} % i32(control.fieldH)) + i32(control.fieldH)) % i32(control.fieldH);`);
    ctx.lines.push(`      } else {`);
    ctx.lines.push(`        if (${col} < 0 || ${col} >= i32(control.fieldW) || ${row} < 0 || ${row} >= i32(control.fieldH)) { ${inb} = false; }`);
    ctx.lines.push(`      }`);
    ctx.lines.push(`      if (${inb}) {`);
    const val = fresh(ctx, 'rcuVal');
    ctx.lines.push(`        let ${val}: f32 = ${fieldReadAt(ctx, attr, `u32(${row}) * u32(control.fieldW) + u32(${col})`)};`);
    accumLine(val);
    ctx.lines.push(`      }`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`  } }`);
  }
  // finish: mean → acc/n; max/min → (n>0?acc:0); sum → acc.
  let finishExpr: string;
  if (reduce === 'mean') finishExpr = `select(0.0, ${acc} / f32(${n}), ${n} > 0)`;
  else if (reduce === 'max' || reduce === 'min') finishExpr = `select(0.0, ${acc}, ${n} > 0)`;
  else finishExpr = acc;
  ctx.lines.push(`  let ${out}: f32 = ${finishExpr};`);
  return { expr: out, type: 'f32' };
}

// ---------------------------------------------------------------------------
// Universal value emitters (no new GPU bindings) — ported from the lattice WGSL
// compiler, adapted to the agent loop's idx-based SoA addressing.
// ---------------------------------------------------------------------------

/** Resolve a `getVariable` node whose variable is an ARRAY → its WGSL var name +
 *  fixed length (null when it's a scalar variable or unknown). */
function resolveArrayVar(ctx: AgentWgpuCtx, getVarNode: GraphNode): { name: string; len: number } | null {
  const variableId = (getVarNode.data.config?.['variableId'] as string) || '';
  return variableId ? (ctx.arrayVarNames.get(variableId) ?? null) : null;
}

/** Get Color Constant — three integer literals (multi-output r/g/b). */
function emitGetColorConstant(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const cached = ctx.valueCache.get(`${node.id}:r`);
  if (cached !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cached;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const r = parseInt(String(cfg?.['r'] ?? '0'), 10) || 0;
  const g = parseInt(String(cfg?.['g'] ?? '0'), 10) || 0;
  const b = parseInt(String(cfg?.['b'] ?? '0'), 10) || 0;
  const refs: Record<string, ValueRef> = {
    r: emitLet(ctx, 'i32', `${r | 0}`, 'gcr'),
    g: emitLet(ctx, 'i32', `${g | 0}`, 'gcg'),
    b: emitLet(ctx, 'i32', `${b | 0}`, 'gcb'),
  };
  // `a` emitted LAST and only when declared - an extra `let` (and its `fresh`
  // name) would change the shader of every existing model.
  if (colorConstantHasAlpha((cfg ?? {}) as Record<string, string | number | boolean>)) {
    const a = parseInt(String(cfg?.['a'] ?? '255'), 10) || 0;
    refs['a'] = emitLet(ctx, 'i32', `${a | 0}`, 'gca');
  }
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['r']!;
}

/** WGSL interpolation-curve expr (mirrors the lattice `wgslInterpolationCurveExpr`). */
function curveExpr(tExpr: string, method: string): string {
  if (method === 'linear') return `(${tExpr})`;
  const tcl = `clamp((${tExpr}), 0.0, 1.0)`;
  switch (method) {
    case 'smoothstep': return `(${tcl}) * (${tcl}) * (3.0 - 2.0 * (${tcl}))`;
    case 'easeInQuad': return `(${tcl}) * (${tcl})`;
    case 'easeOutQuad': return `(1.0 - (1.0 - (${tcl})) * (1.0 - (${tcl})))`;
    case 'exponential': return `select(0.0, pow(2.0, 10.0 * ((${tcl}) - 1.0)), (${tcl}) > 0.0)`;
    case 'logarithmic': return `select(1.0, (1.0 - pow(2.0, -10.0 * (${tcl}))), (${tcl}) < 1.0)`;
    default: return `(${tcl})`;
  }
}

/** Proportion Map — remap x from [inMin,inMax] to [outMin,outMax] via a curve. */
function emitProportionMap(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const x = inF32(ctx, node, 'x', 0);
  const inMin = inF32(ctx, node, 'inMin', 0);
  const inMax = inF32(ctx, node, 'inMax', 1);
  const outMin = inF32(ctx, node, 'outMin', 0);
  const outMax = inF32(ctx, node, 'outMax', 1);
  const method = (node.data.config?.['method'] as string) || 'linear';
  const span = emitLet(ctx, 'f32', `(${inMax} - ${inMin})`, 'pmSp');
  const tRaw = emitLet(ctx, 'f32', `select(0.0, ((${x}) - (${inMin})) / ${span.expr}, (${span.expr} != 0.0))`, 'pmt');
  const tCurve = emitLet(ctx, 'f32', curveExpr(tRaw.expr, method), 'pmc');
  return emitLet(ctx, 'f32', `select((${outMin}), ((${outMin}) + ${tCurve.expr} * ((${outMax}) - (${outMin}))), (${span.expr} != 0.0))`, 'pm');
}

/** Color Scale — multi-stop gradient → integer r/g/b (multi-output). Mirrors the
 *  lattice WGSL colorScale exactly. */
function emitColorScale(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const cached = ctx.valueCache.get(`${node.id}:r`);
  if (cached !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cached;
  const t = inF32(ctx, node, 't', 0.5);
  const method = (node.data.config?.['method'] as string) || 'linear';
  const stops = readColorScaleStops(node.data.config as Record<string, string | number | boolean>);
  const f32Lit = (n: number) => Number.isInteger(n) ? `${n}.0` : `${n}`;
  const tName = fresh(ctx, 'cst');
  ctx.lines.push(`  let ${tName}: f32 = ${t};`);
  // Channel table - `a` minted LAST and only when declared, so the opaque path
  // consumes the same `fresh` names and emits the same lines as before.
  const withA = colorScaleHasAlpha(node.data.config as Record<string, string | number | boolean>);
  const chans: Array<{ name: string; get: (s: ColorScaleStop) => number }> = [
    { name: fresh(ctx, 'csr'), get: s => s.r },
    { name: fresh(ctx, 'csg'), get: s => s.g },
    { name: fresh(ctx, 'csb'), get: s => s.b },
  ];
  if (withA) chans.push({ name: fresh(ctx, 'csa'), get: s => s.a ?? 255 });
  ctx.lines.push(`  ${chans.map(c => `var ${c.name}: i32;`).join(' ')}`);
  const writeConst = (s: ColorScaleStop) => chans.map(c => `${c.name} = ${c.get(s) | 0};`).join(' ');
  const ZERO: ColorScaleStop = { p: 0, r: 0, g: 0, b: 0, a: 0 };
  if (stops.length === 0) {
    ctx.lines.push(`  ${writeConst(ZERO)}`);
  } else if (stops.length === 1) {
    ctx.lines.push(`  ${writeConst(stops[0]!)}`);
  } else {
    const first = stops[0]!, last = stops[stops.length - 1]!;
    ctx.lines.push(`  if (${tName} <= ${f32Lit(first.p)}) { ${writeConst(first)} }`);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i]!, b = stops[i + 1]!;
      if (b.p === a.p) continue;
      const localExpr = `((${tName} - ${f32Lit(a.p)}) / ${f32Lit(b.p - a.p)})`;
      const curved = curveExpr(localExpr, method);
      // Alpha interpolates on the SAME curve as the colour channels.
      const body = chans
        .map(c => `${c.name} = i32(floor(${f32Lit(c.get(a))} + (${curved}) * ${f32Lit(c.get(b) - c.get(a))} + 0.5)); `)
        .join('');
      ctx.lines.push(`  else if (${tName} < ${f32Lit(b.p)}) { ${body}}`);
    }
    ctx.lines.push(`  else { ${writeConst(last)} }`);
  }
  const refs: Record<string, ValueRef> = {};
  (withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b']).forEach((pn, i) => {
    refs[pn] = { expr: chans[i]!.name, type: 'i32' };
  });
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['r']!;
}

/** Get Array Element — `arr[position]` with a bounds-guarded fallback (0). The
 *  source is an agent-array producer OR an array Local Variable. */
function emitArrayElement(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const pos = castTo(resolveValueInput(ctx, node, 'position', 0), 'i32');
  const src = ctx.adj.inputToSource.get(`${node.id}:array`);
  if (!src) return emitLet(ctx, 'f32', '0.0', 'ae');
  const srcNode = ctx.adj.nodeMap.get(src.nodeId);
  // Array Local Variable source.
  if (srcNode?.data.nodeType === 'getVariable') {
    const av = resolveArrayVar(ctx, srcNode);
    if (av) {
      const i = fresh(ctx, 'aeI');
      ctx.lines.push(`  let ${i}: i32 = ${pos};`);
      return emitLet(ctx, 'f32', `select(0.0, ${av.name}[${i}], (${i} >= 0 && ${i} < ${av.len}))`, 'ae');
    }
  }
  // Agent-array producer source.
  const arr = compileArrayNode(ctx, src.nodeId, src.portId);
  const i = fresh(ctx, 'aeI');
  ctx.lines.push(`  let ${i}: i32 = ${pos};`);
  const elemT = arr.elemType === 'i32' ? 'i32' : 'f32';
  const zero = elemT === 'i32' ? '0' : '0.0';
  return emitLet(ctx, elemT as WgslType, `select(${zero}, ${arr.arrName}[${i}], (${i} >= 0 && ${i} < ${arr.lenName}))`, 'ae');
}

/** Get Array Length — the source array's length local (or the array-var length). */
function emitArrayLength(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const src = ctx.adj.inputToSource.get(`${node.id}:array`);
  if (!src) return emitLet(ctx, 'i32', '0', 'al');
  const srcNode = ctx.adj.nodeMap.get(src.nodeId);
  if (srcNode?.data.nodeType === 'getVariable') {
    const av = resolveArrayVar(ctx, srcNode);
    if (av) return emitLet(ctx, 'i32', `${av.len}`, 'al');
  }
  const arr = compileArrayNode(ctx, src.nodeId, src.portId);
  return emitLet(ctx, 'i32', arr.lenName, 'al');
}

/** Get Curvature — mean unit-vector magnitude to bonded partners (torus-folded).
 *  Reads the bond store. <2 bonds → 0. Mirrors GetCurvatureNode's JS emit. */
function emitGetCurvature(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  void node;
  ctx.usesBondStore = true;
  const out = fresh(ctx, 'curv');
  const bc = fresh(ctx, 'cvBc'), base = fresh(ctx, 'cvBase'), sx = fresh(ctx, 'cvSx'), sy = fresh(ctx, 'cvSy'), cnt = fresh(ctx, 'cvCnt');
  const k = fresh(ctx, 'cvK'), p = fresh(ctx, 'cvP'), dx = fresh(ctx, 'cvDx'), dy = fresh(ctx, 'cvDy'), d = fresh(ctx, 'cvD');
  ctx.lines.push(`  var ${out}: f32 = 0.0;`);
  ctx.lines.push(`  { let ${bc}: i32 = ${i32At(ctx, 'bondCount', 'idx')};`);
  ctx.lines.push(`    if (${bc} >= 2) {`);
  ctx.lines.push(`      let ${base}: u32 = idx * u32(control.maxBonds) * 2u;`);
  ctx.lines.push(`      var ${sx}: f32 = 0.0; var ${sy}: f32 = 0.0; var ${cnt}: i32 = 0;`);
  ctx.lines.push(`      for (var ${k}: i32 = 0; ${k} < ${bc}; ${k} = ${k} + 1) {`);
  ctx.lines.push(`        let ${p}: i32 = bondStore[${base} + u32(${k}) * 2u];`);
  ctx.lines.push(`        if (${p} >= 0 && ${p} < i32(control.highWater) && agentAlive[${p}] != 0u) {`);
  ctx.lines.push(`          var ${dx}: f32 = ${f32At(ctx, 'x', `u32(${p})`)} - ${f32At(ctx, 'x', 'idx')};`);
  ctx.lines.push(`          var ${dy}: f32 = ${f32At(ctx, 'y', `u32(${p})`)} - ${f32At(ctx, 'y', 'idx')};`);
  ctx.lines.push(`          if (control.fieldTorus != 0u) {`);
  ctx.lines.push(`            let _hw = control.fieldW * 0.5; let _hh = control.fieldH * 0.5;`);
  ctx.lines.push(`            if (${dx} > _hw) { ${dx} = ${dx} - control.fieldW; } else if (${dx} < -_hw) { ${dx} = ${dx} + control.fieldW; }`);
  ctx.lines.push(`            if (${dy} > _hh) { ${dy} = ${dy} - control.fieldH; } else if (${dy} < -_hh) { ${dy} = ${dy} + control.fieldH; }`);
  ctx.lines.push(`          }`);
  ctx.lines.push(`          let ${d}: f32 = sqrt(${dx} * ${dx} + ${dy} * ${dy});`);
  ctx.lines.push(`          if (${d} > 1e-9) { ${sx} = ${sx} + ${dx} / ${d}; ${sy} = ${sy} + ${dy} / ${d}; ${cnt} = ${cnt} + 1; }`);
  ctx.lines.push(`        }`);
  ctx.lines.push(`      }`);
  ctx.lines.push(`      if (${cnt} > 0) { ${out} = sqrt(${sx} * ${sx} + ${sy} * ${sy}) / f32(${cnt}); }`);
  ctx.lines.push(`    }`);
  ctx.lines.push(`  }`);
  return { expr: out, type: 'f32' };
}

/** Get Model Attribute — read a model attribute from the `auxF32` buffer (the
 *  agent path's modelAttrs region). Color attrs are multi-output (r/g/b). */
function emitGetModelAttribute(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const attr = (node.data.config?.['attributeId'] as string) || '_undef';
  const isColor = !!node.data.config?.['isColorAttr'];
  if (isColor) {
    const cached = ctx.valueCache.get(`${node.id}:r`);
    if (cached !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cached;
    // A colour model attr ALWAYS occupies four slots (`modelAttrSlotKeys`), so
    // alpha is not gated here the way the palette nodes' is.
    const refs: Record<string, ValueRef> = {
      r: emitLet(ctx, 'f32', auxRead(ctx, `${attr}_r`), 'mar'),
      g: emitLet(ctx, 'f32', auxRead(ctx, `${attr}_g`), 'mag'),
      b: emitLet(ctx, 'f32', auxRead(ctx, `${attr}_b`), 'mab'),
      a: emitLet(ctx, 'f32', auxRead(ctx, `${attr}_a`), 'maa'),
    };
    for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
    return refs[portId] ?? refs['r']!;
  }
  return emitLet(ctx, 'f32', auxRead(ctx, attr), 'ma');
}

/** Read a scalar model-attribute slot from the auxF32 buffer (0 if absent). */
function auxRead(ctx: AgentWgpuCtx, key: string): string {
  const off = ctx.layout.modelAttrSlot?.[key];
  if (off === undefined) return '0.0';
  ctx.usesAux = true;
  return off === 0 ? `auxF32[0]` : `auxF32[${off}u]`;
}

/** Table Lookup — index a Lookup Table by (row, col) → a float from the auxF32
 *  table region. Row-major `tableBase + row*colCount + col`. MULTI-AXIS tables:
 *  per-axis saturating clamp + `Σ idxₖ·strideₖ` (D-NDT-5).
 *  NB the legacy ports are `labelA`/`labelB` (the node def's ids) — this
 *  emitter used to read `'row'`/`'col'`, which never exist, so BOTH indices
 *  resolved to the default 0 and the lookup always read the clamped [0,0]
 *  cell on the agent-WebGPU target (pre-existing bug, fixed with the N-D
 *  generalization; lattice + agentWasm always used the correct ids). */
function emitLookupInteraction(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const tableId = (node.data.config?.['tableId'] as string) || (node.data.config?.['attributeId'] as string) || '';
  const tbl = ctx.layout.lookupTables?.[tableId];
  if (!tbl) return emitLet(ctx, 'f32', '0.0', 'li');
  ctx.usesAux = true;
  if (tbl.dims && tbl.dims.length > 0) {
    const dims = tbl.dims;
    const mins = tbl.mins ?? [];
    const strides = new Array<number>(dims.length).fill(1);
    for (let i = dims.length - 2; i >= 0; i--) strides[i] = strides[i + 1]! * dims[i + 1]!;
    const terms: string[] = [];
    for (let k = 0; k < dims.length; k++) {
      const src = castTo(resolveValueInput(ctx, node, `axis_${k}`, 0), 'i32');
      const min = Math.floor(mins[k] ?? 0) || 0;
      const hi = Math.max(0, dims[k]! - 1);
      const idx = `clamp((${src})${min !== 0 ? ` - ${min}` : ''}, 0, ${hi})`;
      terms.push(strides[k] === 1 ? `u32(${idx})` : `u32(${idx}) * ${strides[k]}u`);
    }
    const o = fresh(ctx, 'liO');
    ctx.lines.push(`  let ${o}: u32 = ${tbl.base}u + ${terms.join(' + ')};`);
    return emitLet(ctx, 'f32', `auxF32[${o}]`, 'li');
  }
  const row = castTo(resolveValueInput(ctx, node, 'labelA', 0), 'i32');
  const col = castTo(resolveValueInput(ctx, node, 'labelB', 0), 'i32');
  const r = fresh(ctx, 'liR'), c = fresh(ctx, 'liC'), o = fresh(ctx, 'liO');
  ctx.lines.push(`  let ${r}: i32 = clamp(${row}, 0, ${tbl.rowCount - 1});`);
  ctx.lines.push(`  let ${c}: i32 = clamp(${col}, 0, ${tbl.colCount - 1});`);
  ctx.lines.push(`  let ${o}: u32 = ${tbl.base}u + u32(${r}) * ${tbl.colCount}u + u32(${c});`);
  return emitLet(ctx, 'f32', `auxF32[${o}]`, 'li');
}

/** Get Indicator — read a standalone indicator from the `indicators` atomic
 *  buffer (bitcast per the indicator's dataType). */
function emitGetIndicator(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const slot = node.data.config?.['_indicatorIdx'];
  const off = typeof slot === 'number' ? slot : -1;
  if (off < 0) return emitLet(ctx, 'f32', '0.0', 'gi');
  ctx.usesIndicators = true;
  const isInt = node.data.config?.['_indicatorIsInt'] === true;
  const word = `atomicLoad(&indicators[${off}u])`;
  return isInt
    ? emitLet(ctx, 'f32', `f32(bitcast<i32>(${word}))`, 'gi')
    : emitLet(ctx, 'f32', `bitcast<f32>(${word})`, 'gi');
}

/** Group Reduce (groupOperator) over a single agent-array source. sum / product /
 *  min / max / average / count / weightedRandom. median + uniform random reject at
 *  the gate (no sort / per-cell pick path — like the lattice WebGPU). Multi-output
 *  (result + index/position). */
function emitGroupOperator(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const cachedResult = ctx.valueCache.get(`${node.id}:result`);
  if (cachedResult !== undefined) {
    if (portId === 'index' || portId === 'position') return ctx.valueCache.get(`${node.id}:index`) ?? { expr: '-1', type: 'i32' };
    return cachedResult;
  }
  let op = (node.data.config?.['operation'] as string) || 'sum';
  if (op === 'mul') op = 'product';
  if (op === 'mean') op = 'average';
  const src = ctx.adj.inputToSource.get(`${node.id}:values`);
  const resName = fresh(ctx, 'goR'), idxName = fresh(ctx, 'goI');
  ctx.lines.push(`  var ${resName}: f32 = 0.0; var ${idxName}: i32 = -1;`);
  if (src) {
    const srcNode = ctx.adj.nodeMap.get(src.nodeId);
    if (srcNode && isAgentArrayProducer(srcNode.data.nodeType)) {
      const arr = compileArrayNode(ctx, src.nodeId, src.portId);
      const k = fresh(ctx, 'goK'), ev = fresh(ctx, 'goV'), cnt = fresh(ctx, 'goCnt'), sum = fresh(ctx, 'goSum');
      const best = fresh(ctx, 'goBest');
      ctx.lines.push(`  { var ${cnt}: i32 = 0; var ${sum}: f32 = 0.0; var ${best}: f32 = 0.0;`);
      if (op === 'weightedRandom') {
        // cumulative-sum weighted pick (mirrors the lattice WGSL weightedRandom).
        const tot = fresh(ctx, 'goTot');
        ctx.lines.push(`    var ${tot}: f32 = 0.0;`);
        ctx.lines.push(`    for (var ${k}: i32 = 0; ${k} < ${arr.lenName}; ${k} = ${k} + 1) { ${tot} = ${tot} + max(0.0, f32(${arr.arrName}[${k}])); }`);
        const u = fresh(ctx, 'goU'), acc2 = fresh(ctx, 'goAcc');
        ctx.lines.push(`    let ${u}: f32 = rand_f32(idx) * ${tot};`);
        ctx.lines.push(`    var ${acc2}: f32 = 0.0;`);
        ctx.lines.push(`    if (${tot} > 0.0) {`);
        ctx.lines.push(`      for (var ${k}: i32 = 0; ${k} < ${arr.lenName}; ${k} = ${k} + 1) { ${acc2} = ${acc2} + max(0.0, f32(${arr.arrName}[${k}])); if (${u} < ${acc2}) { ${idxName} = ${k}; ${resName} = f32(${arr.arrName}[${k}]); break; } }`);
        ctx.lines.push(`      if (${idxName} < 0 && ${arr.lenName} > 0) { ${idxName} = ${arr.lenName} - 1; ${resName} = f32(${arr.arrName}[${arr.lenName} - 1]); }`);
        ctx.lines.push(`    }`);
      } else {
        const initBest = op === 'product' ? '1.0' : op === 'min' ? '3.4028235e38' : op === 'max' ? '-3.4028235e38' : '0.0';
        ctx.lines.push(`    ${best} = ${initBest};`);
        ctx.lines.push(`    for (var ${k}: i32 = 0; ${k} < ${arr.lenName}; ${k} = ${k} + 1) {`);
        ctx.lines.push(`      let ${ev}: f32 = f32(${arr.arrName}[${k}]);`);
        if (op === 'sum' || op === 'average') ctx.lines.push(`      ${sum} = ${sum} + ${ev};`);
        else if (op === 'product') ctx.lines.push(`      ${best} = ${best} * ${ev};`);
        else if (op === 'min') ctx.lines.push(`      if (${ev} < ${best}) { ${best} = ${ev}; ${idxName} = ${k}; }`);
        else if (op === 'max') ctx.lines.push(`      if (${ev} > ${best}) { ${best} = ${ev}; ${idxName} = ${k}; }`);
        ctx.lines.push(`      ${cnt} = ${cnt} + 1;`);
        ctx.lines.push(`    }`);
        if (op === 'sum') ctx.lines.push(`    ${resName} = ${sum};`);
        else if (op === 'average') ctx.lines.push(`    ${resName} = select(0.0, ${sum} / f32(${cnt}), ${cnt} > 0);`);
        else if (op === 'count') ctx.lines.push(`    ${resName} = f32(${cnt});`);
        else ctx.lines.push(`    ${resName} = select(0.0, ${best}, ${cnt} > 0);`);
      }
      ctx.lines.push(`  }`);
    }
  }
  const refs: Record<string, ValueRef> = {
    result: { expr: resName, type: 'f32' }, index: { expr: idxName, type: 'i32' },
  };
  ctx.valueCache.set(`${node.id}:result`, refs['result']!);
  ctx.valueCache.set(`${node.id}:index`, refs['index']!);
  ctx.valueCache.set(`${node.id}:position`, refs['index']!);
  return (portId === 'index' || portId === 'position') ? refs['index']! : refs['result']!;
}

/** Group Counting — count array elements passing a comparison (scalar output). */
function emitGroupCounting(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const op = (node.data.config?.['operation'] as string) || 'equals';
  const v1 = inF32(ctx, node, 'value', 0);
  const v2 = inF32(ctx, node, 'value2', 0);
  const src = ctx.adj.inputToSource.get(`${node.id}:values`);
  const cnt = fresh(ctx, 'gcCnt');
  ctx.lines.push(`  var ${cnt}: i32 = 0;`);
  if (src) {
    const srcNode = ctx.adj.nodeMap.get(src.nodeId);
    if (srcNode && isAgentArrayProducer(srcNode.data.nodeType)) {
      const arr = compileArrayNode(ctx, src.nodeId, src.portId);
      const k = fresh(ctx, 'gcK'), ev = fresh(ctx, 'gcV');
      ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${arr.lenName}; ${k} = ${k} + 1) {`);
      ctx.lines.push(`    let ${ev}: f32 = f32(${arr.arrName}[${k}]);`);
      ctx.lines.push(`    if (${groupCompareExpr(op, ev, v1, v2)}) { ${cnt} = ${cnt} + 1; }`);
      ctx.lines.push(`  }`);
    }
  }
  return { expr: cnt, type: 'i32' };
}

/** Group Statement — boolean predicate over an array (allIs/anyIs/noneIs/hasA/
 *  allGreater/anyGreater/allLesser/anyLesser). Each op = (a per-element predicate)
 *  combined with all/any/none semantics. */
function emitGroupStatement(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const op = (node.data.config?.['operation'] as string) || 'anyIs';
  const v1 = inF32(ctx, node, 'value', 0);
  const src = ctx.adj.inputToSource.get(`${node.id}:values`);
  const res = fresh(ctx, 'gsR');
  // ALL → start true, break-false on a failing element; ANY/HAS → start false,
  // break-true on a passing element; NONE → start true, break-false on a match.
  const isAll = /^all/.test(op);
  const isNone = op === 'noneIs';
  const startTrue = isAll || isNone;
  ctx.lines.push(`  var ${res}: bool = ${startTrue ? 'true' : 'false'};`);
  if (src) {
    const srcNode = ctx.adj.nodeMap.get(src.nodeId);
    if (srcNode && isAgentArrayProducer(srcNode.data.nodeType)) {
      const arr = compileArrayNode(ctx, src.nodeId, src.portId);
      const k = fresh(ctx, 'gsK'), ev = fresh(ctx, 'gsV');
      const elemPred = groupStatementElemCmp(op, ev, v1);
      ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${arr.lenName}; ${k} = ${k} + 1) {`);
      ctx.lines.push(`    let ${ev}: f32 = f32(${arr.arrName}[${k}]);`);
      if (isNone) ctx.lines.push(`    if (${elemPred}) { ${res} = false; break; }`);
      else if (isAll) ctx.lines.push(`    if (!(${elemPred})) { ${res} = false; break; }`);
      else ctx.lines.push(`    if (${elemPred}) { ${res} = true; break; }`);
      ctx.lines.push(`  }`);
    }
  }
  return emitLet(ctx, 'f32', `select(0.0, 1.0, ${res})`, 'gs');
}

/** A comparison expr for groupCounting (==/!=/>/</.../between). */
function groupCompareExpr(op: string, e: string, v1: string, v2: string): string {
  switch (op) {
    case 'notEquals': return `${e} != ${v1}`;
    case 'greater': return `${e} > ${v1}`;
    case 'lesser': return `${e} < ${v1}`;
    case 'greaterEqual': return `${e} >= ${v1}`;
    case 'lesserEqual': return `${e} <= ${v1}`;
    case 'between': return `(${e} >= ${v1} && ${e} <= ${v2})`;
    case 'notBetween': return `(${e} < ${v1} || ${e} > ${v2})`;
    default: return `${e} == ${v1}`; // equals
  }
}

/** The per-element predicate for groupStatement (the "is" / "Greater" / "Lesser"
 *  comparison; the all/any/none combinator is applied by the caller). */
function groupStatementElemCmp(op: string, e: string, v1: string): string {
  if (/Greater/.test(op)) return `${e} > ${v1}`;
  if (/Lesser/.test(op)) return `${e} < ${v1}`;
  return `${e} == ${v1}`; // allIs / anyIs / noneIs / hasA
}

// ---------------------------------------------------------------------------
// Agent-array tier — the keystone id/value array path (GoL-on-agents et al).
//
// The id-array producers (getNearbyAgents / filterAgents / joinAgents /
// pickNRandomAgents) and the value-array producer (getAgentsAttribute) each
// materialise into their own `var<function> arr<slot>` + a length local
// (`AgentArrayRef`). Consumers — forEachInArray (flow), aggregate (value),
// pickRandomAgent (value) — read `arrName[0..lenName]`. Mirrors the JS agent
// emitters' `_v<id>_result`/`_v<id>_vals` scratch arrays, minus the NeighborIndex
// codec (elements are plain agent ids, -1 = empty sentinel). 2D Boids subset.
// ---------------------------------------------------------------------------

/** The set of node types that emit an `AgentArrayRef`. A `forEachInArray.array`
 *  / `aggregate.values` / `pickRandomAgent.agents` source MUST be one of these. */
const AGENT_ARRAY_PRODUCERS: ReadonlySet<string> = new Set<string>([
  'getNearbyAgents', 'getAgentsInView', 'getAgentsAttribute', 'filterAgents', 'joinAgents', 'pickNRandomAgents',
  'getBondedAgents',
]);

function isAgentArrayProducer(nodeType: string): boolean {
  return AGENT_ARRAY_PRODUCERS.has(nodeType);
}

/** The `var<function>` array name for a producer's assigned scratch slot. */
function arraySlotName(ctx: AgentWgpuCtx, nodeId: string): { arrName: string; elemType: WgslType } {
  const s = ctx.arrayScratchSlot.get(nodeId);
  if (!s) throw new Error(`agentWebgpu: no array scratch slot for ${nodeId}`);
  return { arrName: `arr${s.elemType}${s.slot}`, elemType: s.elemType };
}

/** Compile an agent-array-producing node → its `AgentArrayRef` (memoised in the
 *  array cache; re-emitted per forEach iteration when volatile). */
function compileArrayNode(ctx: AgentWgpuCtx, nodeId: string, portId: string): AgentArrayRef {
  const key = `${nodeId}:${portId}`;
  const cached = ctx.arrayCache.get(key);
  if (cached !== undefined) return cached;

  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) throw new Error(`agentWebgpu: missing array node ${nodeId}`);
  const type = node.data.nodeType;

  let ref: AgentArrayRef;
  switch (type) {
    case 'getNearbyAgents':
    case 'getAgentsInView': ref = emitNearbyFill(ctx, node); break; // getAgentsInView injects the cone; getNearbyAgents WGSL is byte-identical
    case 'getAgentsAttribute': ref = emitGetAgentsAttribute(ctx, node); break;
    case 'filterAgents': ref = emitFilterAgents(ctx, node); break;
    case 'joinAgents': ref = emitJoinAgents(ctx, node); break;
    case 'pickNRandomAgents': ref = emitPickNRandomAgents(ctx, node); break;
    case 'getBondedAgents': ref = emitGetBondedAgents(ctx, node); break;
    default:
      throw new Error(`agentWebgpu: unsupported array node '${type}'`);
  }
  ctx.arrayCache.set(key, ref);
  return ref;
}

/** Resolve an array input port → its source `AgentArrayRef` (single source; the
 *  array tier never multi-sources an array input — that's the scalar aggregate
 *  fold). Returns null when the port is unwired (the caller handles the empty
 *  case the way the JS `|| '[]'` default does). */
function resolveInputArray(ctx: AgentWgpuCtx, node: GraphNode, portId: string): AgentArrayRef | null {
  const src = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
  if (!src) return null;
  const srcNode = ctx.adj.nodeMap.get(src.nodeId);
  if (!srcNode || !isAgentArrayProducer(srcNode.data.nodeType)) {
    throw new Error(`agentWebgpu: array input "${portId}" must come from an agent-array producer (got ${srcNode?.data.nodeType}).`);
  }
  return compileArrayNode(ctx, src.nodeId, src.portId);
}

/** Get Agents Attribute — gather ONE agent attribute over an id-array → a values
 *  array. The KEYSTONE (fed by getNearbyAgents, consumed by aggregate). Skips
 *  empty(-1)/out-of-range/dead ids (the JS guard), so the output length is the
 *  live-id count. Reads the agent SoA at `agentF32[attrBase + id]` (f32 storage;
 *  int/tag/bool round-trip exactly). */
function emitGetAgentsAttribute(ctx: AgentWgpuCtx, node: GraphNode): AgentArrayRef {
  const attr = (node.data.config?.['attributeId'] as string) || '_undef';
  const inArr = resolveInputArray(ctx, node, 'agents');
  const { arrName } = arraySlotName(ctx, node.id);
  const lenName = fresh(ctx, 'gaaLen');
  ctx.lines.push(`  var ${lenName}: i32 = 0;`);
  if (inArr) {
    const base = ctx.layout.agentAttrBase[attr];
    const k = fresh(ctx, 'gaaK'), id = fresh(ctx, 'gaaId');
    ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${inArr.lenName}; ${k} = ${k} + 1) {`);
    ctx.lines.push(`    let ${id}: i32 = ${arrLoad(inArr, k)};`);
    ctx.lines.push(`    if (${id} >= 0 && ${id} < i32(control.highWater) && agentAlive[${id}] != 0u) {`);
    // Unknown attr → push 0.0 (parity with the value-node fallback).
    const val = base === undefined ? '0.0' : f32At(ctx, attr, `u32(${id})`);
    ctx.lines.push(`      ${arrName}[${lenName}] = ${val}; ${lenName} = ${lenName} + 1;`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`  }`);
  }
  return { arrName, lenName, elemType: 'f32' };
}

/** Get Bonded Agents — this agent's bonded partners as an id array (the data
 *  sibling of For Each Bond). Reads the ragged `bondStore` + `bondCount`. */
function emitGetBondedAgents(ctx: AgentWgpuCtx, node: GraphNode): AgentArrayRef {
  ctx.usesBondStore = true;
  const { arrName } = arraySlotName(ctx, node.id);
  const lenName = fresh(ctx, 'gbaLen');
  const bc = fresh(ctx, 'gbaBc'), base = fresh(ctx, 'gbaBase'), k = fresh(ctx, 'gbaK'), p = fresh(ctx, 'gbaP');
  ctx.lines.push(`  var ${lenName}: i32 = 0;`);
  ctx.lines.push(`  { let ${bc}: i32 = ${i32At(ctx, 'bondCount', 'idx')};`);
  ctx.lines.push(`    let ${base}: u32 = idx * u32(control.maxBonds) * 2u;`);
  ctx.lines.push(`    for (var ${k}: i32 = 0; ${k} < ${bc}; ${k} = ${k} + 1) {`);
  ctx.lines.push(`      let ${p}: i32 = bondStore[${base} + u32(${k}) * 2u];`);
  ctx.lines.push(`      if (${p} >= 0 && ${p} < i32(control.highWater) && agentAlive[${p}] != 0u) { ${arrName}[${lenName}] = ${p}; ${lenName} = ${lenName} + 1; }`);
  ctx.lines.push(`    }`);
  ctx.lines.push(`  }`);
  return { arrName, lenName, elemType: 'i32' };
}

/** Filter Agents — keep the ids whose AGENT attribute passes the comparison →
 *  the filtered id array + a count. Skips empty/dead/out-of-range ids before the
 *  comparison (the JS guard). Multi-output (result + count): cache the count port
 *  as a ValueRef. */
function emitFilterAgents(ctx: AgentWgpuCtx, node: GraphNode): AgentArrayRef {
  const attr = (node.data.config?.['attributeId'] as string) || '_undef';
  const op = (node.data.config?.['operation'] as string) || 'equals';
  const inArr = resolveInputArray(ctx, node, 'agents');
  const cmp = inF32(ctx, node, 'compare', 0);
  const { arrName } = arraySlotName(ctx, node.id);
  const cntName = fresh(ctx, 'faCnt');
  ctx.lines.push(`  var ${cntName}: i32 = 0;`);
  if (inArr) {
    const base = ctx.layout.agentAttrBase[attr];
    const k = fresh(ctx, 'faK'), id = fresh(ctx, 'faId');
    ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${inArr.lenName}; ${k} = ${k} + 1) {`);
    ctx.lines.push(`    let ${id}: i32 = ${arrLoad(inArr, k)};`);
    ctx.lines.push(`    if (${id} >= 0 && ${id} < i32(control.highWater) && agentAlive[${id}] != 0u) {`);
    const elem = base === undefined ? '0.0' : f32At(ctx, attr, `u32(${id})`);
    const ev = fresh(ctx, 'faV');
    ctx.lines.push(`      let ${ev}: f32 = ${elem};`);
    let cond: string;
    switch (op) {
      case 'notEquals':    cond = `${ev} != ${cmp}`; break;
      case 'greater':      cond = `${ev} > ${cmp}`; break;
      case 'lesser':       cond = `${ev} < ${cmp}`; break;
      case 'greaterEqual': cond = `${ev} >= ${cmp}`; break;
      case 'lesserEqual':  cond = `${ev} <= ${cmp}`; break;
      default:             cond = `${ev} == ${cmp}`; break; // equals
    }
    ctx.lines.push(`      if (${cond}) { ${arrName}[${cntName}] = ${id}; ${cntName} = ${cntName} + 1; }`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`  }`);
  }
  // count port (multi-output).
  ctx.valueCache.set(`${node.id}:count`, { expr: cntName, type: 'i32' });
  return { arrName, lenName: cntName, elemType: 'i32' };
}

/** Join Agents — union (default) or intersection of two id-arrays, excluding the
 *  -1 empty sentinel. Dedup via a linear "already present?" scan over the output
 *  (no Set on the GPU — the arrays are small, neighbour-sized). Multi-output
 *  (result + count). */
function emitJoinAgents(ctx: AgentWgpuCtx, node: GraphNode): AgentArrayRef {
  const op = (node.data.config?.['operation'] as string) || 'union';
  const aArr = resolveInputArray(ctx, node, 'a');
  const bArr = resolveInputArray(ctx, node, 'b');
  const { arrName } = arraySlotName(ctx, node.id);
  const cntName = fresh(ctx, 'jaCnt');
  ctx.lines.push(`  var ${cntName}: i32 = 0;`);
  // Linear membership scan over the current output (dedup helper, inlined).
  const seenInOut = (xExpr: string): string => {
    // Returns a boolean expr; emits a scan loop into a local. WGSL has no inline
    // "any", so emit a small flagged loop.
    const flag = fresh(ctx, 'jaSeen'), si = fresh(ctx, 'jaSi');
    ctx.lines.push(`      var ${flag}: bool = false;`);
    ctx.lines.push(`      for (var ${si}: i32 = 0; ${si} < ${cntName}; ${si} = ${si} + 1) { if (${arrName}[${si}] == ${xExpr}) { ${flag} = true; break; } }`);
    return flag;
  };
  if (op === 'intersection') {
    // ids in BOTH a and b (deduped), excluding -1.
    if (aArr && bArr) {
      const k = fresh(ctx, 'jaK'), x = fresh(ctx, 'jaX'), bk = fresh(ctx, 'jaBk'), inB = fresh(ctx, 'jaInB');
      ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${aArr.lenName}; ${k} = ${k} + 1) {`);
      ctx.lines.push(`    let ${x}: i32 = ${arrLoad(aArr, k)};`);
      ctx.lines.push(`    if (${x} != -1) {`);
      ctx.lines.push(`      var ${inB}: bool = false;`);
      ctx.lines.push(`      for (var ${bk}: i32 = 0; ${bk} < ${bArr.lenName}; ${bk} = ${bk} + 1) { if (${arrLoad(bArr, bk)} == ${x}) { ${inB} = true; break; } }`);
      const seen = seenInOut(x);
      ctx.lines.push(`      if (${inB} && !${seen}) { ${arrName}[${cntName}] = ${x}; ${cntName} = ${cntName} + 1; }`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`  }`);
    }
  } else {
    // union — all unique ids across a and b, excluding -1.
    for (const src of [aArr, bArr]) {
      if (!src) continue;
      const k = fresh(ctx, 'jaK'), x = fresh(ctx, 'jaX');
      ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${src.lenName}; ${k} = ${k} + 1) {`);
      ctx.lines.push(`    let ${x}: i32 = ${arrLoad(src, k)};`);
      ctx.lines.push(`    if (${x} != -1) {`);
      const seen = seenInOut(x);
      ctx.lines.push(`      if (!${seen}) { ${arrName}[${cntName}] = ${x}; ${cntName} = ${cntName} + 1; }`);
      ctx.lines.push(`    }`);
      ctx.lines.push(`  }`);
    }
  }
  ctx.valueCache.set(`${node.id}:count`, { expr: cntName, type: 'i32' });
  return { arrName, lenName: cntName, elemType: 'i32' };
}

/** Pick N Random Agents — pick up to N distinct ids without replacement (partial
 *  Fisher-Yates). Per-agent PCG RNG (statistical parity, NOT the JS shared
 *  xorshift32 — the documented WebGPU constraint). Copies the input into the
 *  scratch slot as a work buffer, then shuffles the first K. */
function emitPickNRandomAgents(ctx: AgentWgpuCtx, node: GraphNode): AgentArrayRef {
  const inArr = resolveInputArray(ctx, node, 'agents');
  const nExpr = castTo(resolveValueInput(ctx, node, 'n', 1), 'i32');
  const { arrName } = arraySlotName(ctx, node.id);
  const lenName = fresh(ctx, 'pnLen');
  ctx.lines.push(`  var ${lenName}: i32 = 0;`);
  if (inArr) {
    // copy input into the work/result slot
    const total = fresh(ctx, 'pnTot'), cp = fresh(ctx, 'pnCp');
    ctx.lines.push(`  let ${total}: i32 = ${inArr.lenName};`);
    ctx.lines.push(`  for (var ${cp}: i32 = 0; ${cp} < ${total}; ${cp} = ${cp} + 1) { ${arrName}[${cp}] = ${arrLoad(inArr, cp)}; }`);
    const kCnt = fresh(ctx, 'pnK');
    ctx.lines.push(`  let ${kCnt}: i32 = clamp(${nExpr}, 0, ${total});`);
    const i = fresh(ctx, 'pnI'), j = fresh(ctx, 'pnJ'), tmp = fresh(ctx, 'pnTmp');
    ctx.lines.push(`  for (var ${i}: i32 = 0; ${i} < ${kCnt}; ${i} = ${i} + 1) {`);
    ctx.lines.push(`    let ${j}: i32 = ${i} + i32(rand_f32(idx) * f32(${total} - ${i}));`);
    ctx.lines.push(`    let ${tmp}: i32 = ${arrName}[${i}]; ${arrName}[${i}] = ${arrName}[${j}]; ${arrName}[${j}] = ${tmp};`);
    ctx.lines.push(`  }`);
    ctx.lines.push(`  ${lenName} = ${kCnt};`);
  }
  return { arrName, lenName, elemType: 'i32' };
}

/** Load element k of an `AgentArrayRef` (the WGSL `arrName[k]` expr). */
function arrLoad(arr: AgentArrayRef, kExpr: string): string {
  return `${arr.arrName}[${kExpr}]`;
}

/** Aggregate over a single agent-array source → a reduced scalar. sum / product /
 *  min / max / average / and / or (median / random reject at the gate, like the
 *  lattice WebGPU aggregate). */
function emitAggregate(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  let op = (node.data.config?.['operation'] as string) || 'sum';
  if (op === 'mul') op = 'product';
  if (op === 'mean') op = 'average';
  const src = ctx.adj.inputToSource.get(`${node.id}:values`);
  if (!src) return emitLet(ctx, 'f32', '0.0', 'agg');
  const srcNode = ctx.adj.nodeMap.get(src.nodeId);
  if (!srcNode || !isAgentArrayProducer(srcNode.data.nodeType)) {
    throw new Error(`agentWebgpu: aggregate "values" must come from an agent-array producer (got ${srcNode?.data.nodeType}).`);
  }
  const arr = compileArrayNode(ctx, src.nodeId, src.portId);

  // and / or: a flagged short-circuit loop (and: empty → 1; or: empty → 0; JS parity).
  if (op === 'and' || op === 'or') {
    const flag = fresh(ctx, 'aggBool');
    ctx.lines.push(`  var ${flag}: f32 = ${op === 'and' ? '1.0' : '0.0'};`);
    const bk = fresh(ctx, 'aggBk');
    ctx.lines.push(`  for (var ${bk}: i32 = 0; ${bk} < ${arr.lenName}; ${bk} = ${bk} + 1) {`);
    if (op === 'and') ctx.lines.push(`    if (f32(${arrLoad(arr, bk)}) == 0.0) { ${flag} = 0.0; break; }`);
    else ctx.lines.push(`    if (f32(${arrLoad(arr, bk)}) != 0.0) { ${flag} = 1.0; break; }`);
    ctx.lines.push(`  }`);
    return { expr: flag, type: 'f32' };
  }

  const acc = fresh(ctx, 'aggAcc');
  let init: string;
  if (op === 'product') init = '1.0';
  else if (op === 'min') init = '3.4028235e38';
  else if (op === 'max') init = '-3.4028235e38';
  else init = '0.0'; // sum + average
  ctx.lines.push(`  var ${acc}: f32 = ${init};`);
  const k = fresh(ctx, 'aggK'), ev = fresh(ctx, 'aggV');
  ctx.lines.push(`  for (var ${k}: i32 = 0; ${k} < ${arr.lenName}; ${k} = ${k} + 1) {`);
  ctx.lines.push(`    let ${ev}: f32 = f32(${arrLoad(arr, k)});`);
  switch (op) {
    case 'product': ctx.lines.push(`    ${acc} = ${acc} * ${ev};`); break;
    case 'min': ctx.lines.push(`    ${acc} = min(${acc}, ${ev});`); break;
    case 'max': ctx.lines.push(`    ${acc} = max(${acc}, ${ev});`); break;
    default: ctx.lines.push(`    ${acc} = ${acc} + ${ev};`); break; // sum + average accumulate
  }
  ctx.lines.push(`  }`);
  if (op === 'average') {
    const out = fresh(ctx, 'aggAvg');
    ctx.lines.push(`  let ${out}: f32 = select(0.0, ${acc} / f32(${arr.lenName}), ${arr.lenName} > 0);`);
    return { expr: out, type: 'f32' };
  }
  return { expr: acc, type: 'f32' };
}

/** Pick Random Agent — one id at random from an id-array (-1 when empty). Per-agent
 *  PCG RNG (statistical parity vs the JS shared xorshift32). */
function emitPickRandomAgent(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const arr = resolveInputArray(ctx, node, 'agents');
  const out = fresh(ctx, 'pra');
  if (!arr) { ctx.lines.push(`  let ${out}: i32 = -1;`); return { expr: out, type: 'i32' }; }
  const pick = fresh(ctx, 'praP');
  ctx.lines.push(`  let ${pick}: i32 = i32(rand_f32(idx) * f32(${arr.lenName}));`);
  ctx.lines.push(`  let ${out}: i32 = select(-1, ${arrLoad(arr, pick)}, ${arr.lenName} > 0);`);
  return { expr: out, type: 'i32' };
}

// ---------------------------------------------------------------------------
// Flow emission.
// ---------------------------------------------------------------------------

function compileFlowChain(ctx: AgentWgpuCtx, nodeId: string, portId: string): void {
  const targets = ctx.adj.flowOutputToTargets.get(`${nodeId}:${portId}`) ?? [];
  for (const t of targets) compileFlowNode(ctx, t.nodeId);
}

/** Every output port of `nodeId` that some consumer actually reads. */
function usedOutPortsOf(ctx: AgentWgpuCtx, nodeId: string): string[] {
  const ports = new Set<string>();
  for (const [, src] of ctx.adj.inputToSource) if (src.nodeId === nodeId) ports.add(src.portId);
  for (const [, srcs] of ctx.adj.inputToSources) for (const s of srcs) if (s.nodeId === nodeId) ports.add(s.portId);
  return ports.size > 0 ? [...ports] : ['value'];
}

function compileFlowNode(ctx: AgentWgpuCtx, nodeId: string): void {
  // Hazard-pinned values scheduled immediately BEFORE this flow node (the LCA
  // of their uses — the same position JS's volatileHoist emits them). Emitted
  // once at this scope (which dominates every use, so the WGSL `let`s resolve
  // from all consuming branches) + cached.
  const pinned = ctx.hazardEmitBefore.get(nodeId);
  if (pinned) {
    for (const vid of pinned) {
      if (!ctx.adj.nodeMap.has(vid)) continue;
      for (const p of usedOutPortsOf(ctx, vid)) compileValueNode(ctx, vid, p);
    }
  }
  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) return;
  const type = node.data.nodeType;
  switch (type) {
    case 'applyForce': {
      // Always component mode here — `expandComposites` lowers a vector-input
      // Apply Force to its fx/fy/fz components before the compiler sees it.
      ctx.lines.push(`  ${f32At(ctx, 'forceX', 'idx')} = ${f32At(ctx, 'forceX', 'idx')} + ${inF32(ctx, node, 'fx', 0)};`);
      ctx.lines.push(`  ${f32At(ctx, 'forceY', 'idx')} = ${f32At(ctx, 'forceY', 'idx')} + ${inF32(ctx, node, 'fy', 0)};`);
      if (ctx.is3d) ctx.lines.push(`  ${f32At(ctx, 'forceZ', 'idx')} = ${f32At(ctx, 'forceZ', 'idx')} + ${inF32(ctx, node, 'fz', 0)};`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'applyForceToAgent': {
      // Cross-agent COMMUTATIVE force scatter: `force[target] += f`. On the PARALLEL
      // GPU many threads scatter onto the same target this step, so the add goes
      // through an f32-bitcast atomic CAS (forceScatterAdd) into a dedicated
      // `forceScatter` buffer (binding 14); the force pass adds it to each agent's
      // self-force seed. (Self Apply Force above stays a plain write — each thread
      // owns its slot.) Range-guarded (emitAgentIdGuarded); a dead-slot write is
      // harmless (the force pass skips dead agents; the buffer is zeroed each step)
      // — observably identical to the JS/WASM live guard. Region stride = maxAgents.
      const g = emitAgentIdGuarded(ctx, node, 'agentId');
      const fx = inF32(ctx, node, 'fx', 0);
      const fy = inF32(ctx, node, 'fy', 0);
      const fz = ctx.is3d ? inF32(ctx, node, 'fz', 0) : null;
      const MA = ctx.layout.maxAgents;
      ctx.lines.push(`  if (${g.ok}) {`);
      ctx.lines.push(`    forceScatterAdd(u32(${g.name}), ${fx});`);
      ctx.lines.push(`    forceScatterAdd(${MA}u + u32(${g.name}), ${fy});`);
      if (fz !== null) ctx.lines.push(`    forceScatterAdd(${2 * MA}u + u32(${g.name}), ${fz});`);
      ctx.lines.push(`  }`);
      ctx.usesForceScatter = true;
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setTargetRadius': {
      ctx.lines.push(`  ${f32At(ctx, 'targetRadius', 'idx')} = ${inF32(ctx, node, 'value', 1)};`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setVariable': {
      const variableId = (node.data.config?.['variableId'] as string) || '';
      const name = variableId ? ctx.varNames.get(variableId) : undefined;
      if (name) ctx.lines.push(`  ${name} = ${inF32(ctx, node, 'value', 0)};`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setArrayElement': {
      const variableId = (node.data.config?.['variableId'] as string) || '';
      const av = variableId ? ctx.arrayVarNames.get(variableId) : undefined;
      if (av) {
        const i = castTo(resolveValueInput(ctx, node, 'index', 0), 'i32');
        const v = inF32(ctx, node, 'value', 0);
        const iL = fresh(ctx, 'saeI');
        ctx.lines.push(`  { let ${iL}: i32 = ${i}; if (${iL} >= 0 && ${iL} < ${av.len}) { ${av.name}[${iL}] = ${v}; } }`);
      }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAttribute': {
      // Write the AGENT SoA (agentAttrsOf): `agentF32[attrBase + idx] = value`.
      // int/tag/bool attrs round to the nearest integer (the JS Int32/Uint8 store).
      const attr = (node.data.config?.['attributeId'] as string) || '_undef';
      const base = ctx.layout.agentAttrBase[attr];
      if (base !== undefined) {
        const t = ctx.agentAttrType.get(attr) || 'float';
        let v = inF32(ctx, node, 'value', 0);
        if (t !== 'float') v = `round(${v})`;
        ctx.lines.push(`  ${f32At(ctx, attr, 'idx')} = ${v};`);
      }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'updateAttribute': {
      // In-place modify THIS agent's attribute (increment/decrement/min/max/…).
      const attr = (node.data.config?.['attributeId'] as string) || '_undef';
      const base = ctx.layout.agentAttrBase[attr];
      if (base !== undefined) {
        const op = (node.data.config?.['operation'] as string) || 'increment';
        const cur = f32At(ctx, attr, 'idx');
        const tagLen = Number(node.data.config?.['_tagLen']) || 1;
        let expr: string;
        switch (op) {
          case 'decrement': expr = `${cur} - ${inF32(ctx, node, 'value', 1)}`; break;
          case 'max': expr = `max(${cur}, ${inF32(ctx, node, 'value', 0)})`; break;
          case 'min': expr = `min(${cur}, ${inF32(ctx, node, 'value', 0)})`; break;
          case 'toggle': expr = `select(1.0, 0.0, ${cur} != 0.0)`; break;
          case 'or': expr = `select(${cur}, 1.0, ${inF32(ctx, node, 'value', 0)} != 0.0)`; break;
          case 'and': expr = `select(0.0, ${cur}, ${inF32(ctx, node, 'value', 0)} != 0.0)`; break;
          case 'next': expr = `f32((i32(round(${cur})) + 1) % ${tagLen})`; break;
          case 'previous': expr = `f32(((i32(round(${cur})) - 1) % ${tagLen} + ${tagLen}) % ${tagLen})`; break;
          default: expr = `${cur} + ${inF32(ctx, node, 'value', 1)}`; break; // increment
        }
        const t = ctx.agentAttrType.get(attr) || 'float';
        const wrapped = t !== 'float' ? `round(${expr})` : `(${expr})`;
        ctx.lines.push(`  ${f32At(ctx, attr, 'idx')} = ${wrapped};`);
      }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setVelocity': {
      ctx.lines.push(`  ${f32At(ctx, 'vx', 'idx')} = ${inF32(ctx, node, 'vx', 0)};`);
      ctx.lines.push(`  ${f32At(ctx, 'vy', 'idx')} = ${inF32(ctx, node, 'vy', 0)};`);
      if (ctx.is3d) ctx.lines.push(`  ${f32At(ctx, 'vz', 'idx')} = ${inF32(ctx, node, 'vz', 0)};`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAgentAttribute': {
      // Write ANOTHER agent's attribute by id (signal a neighbour). Range-guarded.
      const attr = (node.data.config?.['attributeId'] as string) || '_undef';
      const base = ctx.layout.agentAttrBase[attr];
      if (base !== undefined) {
        const id = castTo(resolveValueInput(ctx, node, 'agentId', -1), 'i32');
        const t = ctx.agentAttrType.get(attr) || 'float';
        let v = inF32(ctx, node, 'value', 0);
        if (t !== 'float') v = `round(${v})`;
        const sa = fresh(ctx, 'saa');
        // Range-only guard (NO alive check): unified spawning stages a Created agent
        // at alive=0 until Add To World, so a fresh handle in [0, maxAgents) must be
        // writable in the behaviour graph — the JS `< _agentMaxAgents` relaxation.
        // (Writing a dead slot is a harmless no-op; the WebGPU compiler only ever
        // emits the behaviour graph, so the strict-live division guard never applies.)
        ctx.lines.push(`  { let ${sa}: i32 = ${id}; if (${sa} >= 0 && ${sa} < i32(control.maxAgents)) { ${f32At(ctx, attr, `u32(${sa})`)} = ${v}; } }`);
      }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAgentsAttribute': {
      // Write a whole id-array's attribute (write-many).
      const attr = (node.data.config?.['attributeId'] as string) || '_undef';
      const base = ctx.layout.agentAttrBase[attr];
      const inArr = resolveInputArray(ctx, node, 'agents');
      if (base !== undefined && inArr) {
        const t = ctx.agentAttrType.get(attr) || 'float';
        let v = inF32(ctx, node, 'value', 0);
        if (t !== 'float') v = `round(${v})`;
        const k = fresh(ctx, 'sasK'), id = fresh(ctx, 'sasId'), vL = fresh(ctx, 'sasV');
        ctx.lines.push(`  { let ${vL}: f32 = ${v};`);
        ctx.lines.push(`    for (var ${k}: i32 = 0; ${k} < ${inArr.lenName}; ${k} = ${k} + 1) {`);
        ctx.lines.push(`      let ${id}: i32 = ${arrLoad(inArr, k)};`);
        ctx.lines.push(`      if (${id} >= 0 && ${id} < i32(control.highWater) && agentAlive[${id}] != 0u) { ${f32At(ctx, attr, `u32(${id})`)} = ${vL}; }`);
        ctx.lines.push(`    }`);
        ctx.lines.push(`  }`);
      }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAgentPosition': {
      const id = castTo(resolveValueInput(ctx, node, 'agentId', -1), 'i32');
      const sp = fresh(ctx, 'sp');
      // Range-only guard — see setAgentAttribute (a staged spawn handle must be settable).
      ctx.lines.push(`  { let ${sp}: i32 = ${id}; if (${sp} >= 0 && ${sp} < i32(control.maxAgents)) {`);
      ctx.lines.push(`    ${f32At(ctx, 'x', `u32(${sp})`)} = ${inF32(ctx, node, 'x', 0)}; ${f32At(ctx, 'y', `u32(${sp})`)} = ${inF32(ctx, node, 'y', 0)};`);
      if (ctx.is3d) ctx.lines.push(`    ${f32At(ctx, 'z', `u32(${sp})`)} = ${inF32(ctx, node, 'z', 0)};`);
      ctx.lines.push(`  } }`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setAgentRadius': {
      const id = castTo(resolveValueInput(ctx, node, 'agentId', -1), 'i32');
      const sr = fresh(ctx, 'sr'), rv = fresh(ctx, 'srV');
      ctx.lines.push(`  { let ${sr}: i32 = ${id}; let ${rv}: f32 = ${inF32(ctx, node, 'radius', 1)};`);
      // Range-only guard — see setAgentAttribute (a staged spawn handle must be settable).
      ctx.lines.push(`    if (${sr} >= 0 && ${sr} < i32(control.maxAgents)) { ${f32At(ctx, 'radius', `u32(${sr})`)} = ${rv}; ${f32At(ctx, 'targetRadius', `u32(${sr})`)} = ${rv}; } }`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setIndicator': {
      const slot = node.data.config?.['_indicatorIdx'];
      const off = typeof slot === 'number' ? slot : -1;
      if (off >= 0) {
        ctx.usesIndicators = true;
        const isInt = node.data.config?.['_indicatorIsInt'] === true;
        const v = inF32(ctx, node, 'value', 0);
        const bits = isInt ? `bitcast<u32>(i32(round(${v})))` : `bitcast<u32>(${v})`;
        ctx.lines.push(`  atomicStore(&indicators[${off}u], ${bits});`);
      }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'updateIndicator': {
      emitUpdateIndicator(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'forEachBond': {
      emitForEachBond(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'switch': {
      emitSwitch(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'loop': {
      emitLoop(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setCellLooks': {
      emitSetCellLooks(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'divideAgent': {
      // Flag a division request (the CPU structural phase reads it back). The
      // axes default to (0,0) = "engine-resolved tension axis": divideAgent()
      // resolves the tension axis whenever the axis is non-finite OR (0,0)
      // (agentEngine.ts `axisX !== 0 || axisY !== 0`), so (0,0) is byte-equivalent
      // to the JS path's NaN default. We must NOT emit a NaN literal/bitcast here —
      // WGSL/Naga constant-folds `bitcast<f32>(0x7fc00000u)` into a NaN constant and
      // rejects it ("value nan cannot be represented as 'f32'"), failing the shader.
      ctx.lines.push(`  ${f32At(ctx, 'divideRequest', 'idx')} = 1.0;`);
      const ax = resolveOptionalF32(ctx, node, 'axisX');
      const ay = resolveOptionalF32(ctx, node, 'axisY');
      ctx.lines.push(`  ${f32At(ctx, 'divideAxisX', 'idx')} = ${ax ?? '0.0'};`);
      ctx.lines.push(`  ${f32At(ctx, 'divideAxisY', 'idx')} = ${ay ?? '0.0'};`);
      ctx.lines.push(`  ${f32At(ctx, 'divideAsym', 'idx')} = ${inF32(ctx, node, 'asymmetry', 0.5)};`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'formBond': {
      // `_bondFormReq = (target | 0) + 1` (0 = no request); restLength / stiffness.
      const tgt = castTo(resolveValueInput(ctx, node, 'targetAgent', -1), 'i32');
      ctx.lines.push(`  ${f32At(ctx, 'bondFormReq', 'idx')} = f32(${tgt} + 1);`);
      ctx.lines.push(`  ${f32At(ctx, 'bondFormL', 'idx')} = ${inF32(ctx, node, 'restLength', 0)};`);
      ctx.lines.push(`  ${f32At(ctx, 'bondFormK', 'idx')} = ${inF32(ctx, node, 'stiffness', 0)};`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'breakBond': {
      const tgt = castTo(resolveValueInput(ctx, node, 'targetAgent', -1), 'i32');
      ctx.lines.push(`  ${f32At(ctx, 'bondBreakReq', 'idx')} = f32(${tgt} + 1);`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'killAgent': {
      ctx.lines.push(`  ${f32At(ctx, 'killRequest', 'idx')} = 1.0;`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'stopEvent': {
      // Mirrors the cell WebGPU stopEvent + the JS/WASM agent path: first-match
      // atomicCompareExchangeWeak into the stopFlag buffer (parallel agents; the
      // first writer wins). _stopIdx is baked by the JS compileAgentGraph (runs
      // first, offset by the cell stop count). The worker reads the buffer back
      // and merges it into the shared stopFlag.
      const stopIdx = Number(node.data.config._stopIdx ?? 0);
      if (stopIdx) {
        ctx.usesStop = true;
        const ce = fresh(ctx, 'stopCe');
        ctx.lines.push(`  let ${ce} = atomicCompareExchangeWeak(&stopFlag, 0u, ${stopIdx}u);`);
      }
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'createAgent': {
      // Mid-step spawning (Generic Agent Platform). The parallel GPU can't call the
      // CPU `_agentCreate` closure (like JS/WASM), so we allocate a REAL slot with an
      // atomic bump (`spawnCursor`), write the child directly on the GPU, and return
      // that slot as the `handle` — so the by-id setters (Set Agent Position/Radius/
      // Attribute) write the newborn exactly like an existing agent. The CPU
      // reconciles the buffer after readback (see readbackAgentStep). A newborn stays
      // STAGED (alive=0) until Add Agent To World, and beyond highWater ⇒ neither the
      // behaviour nor the force pass touches it this step (configured now, behaves next).
      ctx.usesSpawn = true;
      const x = inF32(ctx, node, 'x', 0);
      const y = inF32(ctx, node, 'y', 0);
      const r = inF32(ctx, node, 'radius', 1);
      const z = ctx.is3d ? inF32(ctx, node, 'z', 0) : null;
      const raw = fresh(ctx, 'spRaw');
      const h = fresh(ctx, 'spH');
      ctx.lines.push(`  let ${raw}: u32 = atomicAdd(&spawnCursor, 1u);`);
      ctx.lines.push(`  var ${h}: i32 = -1;`);
      ctx.lines.push(`  if (${raw} < control.maxAgents) {`);
      ctx.lines.push(`    ${f32At(ctx, 'x', raw)} = ${x}; ${f32At(ctx, 'xNext', raw)} = ${x};`);
      ctx.lines.push(`    ${f32At(ctx, 'y', raw)} = ${y}; ${f32At(ctx, 'yNext', raw)} = ${y};`);
      if (z) ctx.lines.push(`    ${f32At(ctx, 'z', raw)} = ${z}; ${f32At(ctx, 'zNext', raw)} = ${z};`);
      ctx.lines.push(`    ${f32At(ctx, 'radius', raw)} = ${r}; ${f32At(ctx, 'targetRadius', raw)} = ${r};`);
      ctx.lines.push(`    ${f32At(ctx, 'vx', raw)} = 0.0; ${f32At(ctx, 'vy', raw)} = 0.0;`);
      if (z) ctx.lines.push(`    ${f32At(ctx, 'vz', raw)} = 0.0;`);
      ctx.lines.push(`    ${f32At(ctx, 'age', raw)} = 0.0;`);
      // Reset the child's agent attributes to their compile-time defaults (the
      // GPU analogue of initAgentSlot's attr reset — the CPU never runs it here).
      // A later Set Agent Attribute by handle overrides, exactly like the JS path.
      for (const [attr, def] of ctx.agentAttrDefault) {
        ctx.lines.push(`    ${f32At(ctx, attr, raw)} = ${wgslFloatLit(def)};`);
      }
      ctx.lines.push(`    ${h} = i32(${raw});`);
      ctx.lines.push(`  }`);
      ctx.valueCache.set(`${node.id}:handle`, { expr: h, type: 'i32' });
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'addAgentToWorld': {
      // Commit a staged newborn: mark it alive on the GPU (agentAlive is read_write
      // when spawning). The CPU reconciliation (readbackAgentStep) reads the alive
      // flag back to add committed newborns to the store + bump liveCount/highWater.
      ctx.usesSpawn = true;
      const h = castTo(resolveValueInput(ctx, node, 'handle', -1), 'i32');
      const hn = fresh(ctx, 'addH');
      ctx.lines.push(`  { let ${hn}: i32 = ${h}; if (${hn} >= 0 && ${hn} < i32(control.maxAgents)) { agentAlive[u32(${hn})] = 1u; } }`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'sequence': {
      // Ports are `first`, `then`, then `then_2`…`then_(1+extraCount)` (see
      // SequenceNode + CaNode's dynamic ports). The previous `then0`/`then1`
      // (keyed on a nonexistent `sequenceCount`) matched NOTHING — every
      // Sequence in an agent behaviour silently dropped its downstream chain.
      const cfg = node.data.config as Record<string, unknown> | undefined;
      const extra = Math.max(0, Number(cfg?.['extraCount']) || 0);
      compileFlowChain(ctx, node.id, 'first');
      compileFlowChain(ctx, node.id, 'then');
      for (let i = 2; i < 2 + extra; i++) compileFlowChain(ctx, node.id, `then_${i}`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'conditional': {
      const cond = `(${inF32(ctx, node, 'condition', 0)} != 0.0)`;
      // Volatile values (hazard-pinned reads, per-iteration refs) must re-emit
      // INSIDE each branch — a value cached from `then` would leave `else`
      // referencing a block-scoped `let` from the sibling branch (WGSL
      // unresolved-name compile error).
      ctx.lines.push(`  if (${cond}) {`);
      clearVolatileCache(ctx);
      compileFlowChain(ctx, node.id, 'then');
      ctx.lines.push(`  } else {`);
      clearVolatileCache(ctx);
      compileFlowChain(ctx, node.id, 'else');
      ctx.lines.push(`  }`);
      clearVolatileCache(ctx);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'forEachInArray': {
      emitForEach(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'affectCellsUnder': {
      emitAffectCellsUnder(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'secreteToField': {
      emitSecreteToField(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    default:
      throw new Error(`agentWebgpu: unsupported flow node '${type}'`);
  }
}

/** Affect Cells Under — write the field over an r-disk (2D) / r-sphere (3D)
 *  under the agent. The op (set/add/subtract/max/min) goes through the atomic
 *  `fieldDeposit` accumulator via `fieldDepositCell` so parallel agents don't
 *  race. The 3D path adds a layer loop + 3D torus-shortest membership + the 3D
 *  index, mirroring AffectCellsUnderNode's 3D JS. */
function emitAffectCellsUnder(ctx: AgentWgpuCtx, node: GraphNode): void {
  const attr = fieldAttrId(node);
  if (ctx.layout.fieldWriteBase[attr] === undefined) return; // not a write field → no-op
  const wBase = fieldWriteBaseOf(ctx, attr);
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['op'] as string) || 'add';
  const opCode = op === 'set' ? 0 : op === 'subtract' ? 1 : op === 'max' ? 2 : op === 'min' ? 3 : 4; // add=4
  const v = castTo(resolveValueInput(ctx, node, 'value', 1), 'f32');
  const r = castTo(resolveValueInput(ctx, node, 'radius', 1), 'f32');
  const cx = f32At(ctx, 'x', 'idx'), cy = f32At(ctx, 'y', 'idx');
  const cxL = fresh(ctx, 'acuCx'), cyL = fresh(ctx, 'acuCy'), rL = fresh(ctx, 'acuR'), vL = fresh(ctx, 'acuV'), rr = fresh(ctx, 'acuR2');

  if (ctx.is3d) {
    const cz = f32At(ctx, 'z', 'idx');
    const czL = fresh(ctx, 'acuCz');
    ctx.lines.push(`  { let ${cxL}: f32 = ${cx}; let ${cyL}: f32 = ${cy}; let ${czL}: f32 = ${cz}; let ${rL}: f32 = ${r}; let ${vL}: f32 = ${v}; let ${rr}: f32 = ${rL} * ${rL};`);
    const W = `f32(control.fieldW)`, H = `f32(control.fieldH)`, D = `f32(control.fieldD)`;
    const hW = fresh(ctx, 'acuHw'), hH = fresh(ctx, 'acuHh'), hD = fresh(ctx, 'acuHd');
    ctx.lines.push(`  let ${hW}: f32 = ${W} * 0.5; let ${hH}: f32 = ${H} * 0.5; let ${hD}: f32 = ${D} * 0.5;`);
    const cmin = fresh(ctx, 'acuCmin'), cmax = fresh(ctx, 'acuCmax'), rmin = fresh(ctx, 'acuRmin'), rmax = fresh(ctx, 'acuRmax'), lmin = fresh(ctx, 'acuLmin'), lmax = fresh(ctx, 'acuLmax');
    ctx.lines.push(`  let ${cmin}: i32 = i32(floor(${cxL} - ${rL})); let ${cmax}: i32 = i32(ceil(${cxL} + ${rL}));`);
    ctx.lines.push(`  let ${rmin}: i32 = i32(floor(${cyL} - ${rL})); let ${rmax}: i32 = i32(ceil(${cyL} + ${rL}));`);
    ctx.lines.push(`  let ${lmin}: i32 = i32(floor(${czL} - ${rL})); let ${lmax}: i32 = i32(ceil(${czL} + ${rL}));`);
    const li = fresh(ctx, 'acuLi'), ri = fresh(ctx, 'acuRi'), ci = fresh(ctx, 'acuCi');
    ctx.lines.push(`  for (var ${li}: i32 = ${lmin}; ${li} <= ${lmax}; ${li} = ${li} + 1) {`);
    ctx.lines.push(`  for (var ${ri}: i32 = ${rmin}; ${ri} <= ${rmax}; ${ri} = ${ri} + 1) {`);
    ctx.lines.push(`  for (var ${ci}: i32 = ${cmin}; ${ci} <= ${cmax}; ${ci} = ${ci} + 1) {`);
    const ddx = fresh(ctx, 'acuDx'), ddy = fresh(ctx, 'acuDy'), ddz = fresh(ctx, 'acuDz');
    ctx.lines.push(`    var ${ddx}: f32 = f32(${ci}) - ${cxL}; var ${ddy}: f32 = f32(${ri}) - ${cyL}; var ${ddz}: f32 = f32(${li}) - ${czL};`);
    ctx.lines.push(`    if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`      if (${ddx} > ${hW}) { ${ddx} = ${ddx} - ${W}; } else if (${ddx} < -${hW}) { ${ddx} = ${ddx} + ${W}; }`);
    ctx.lines.push(`      if (${ddy} > ${hH}) { ${ddy} = ${ddy} - ${H}; } else if (${ddy} < -${hH}) { ${ddy} = ${ddy} + ${H}; }`);
    ctx.lines.push(`      if (${ddz} > ${hD}) { ${ddz} = ${ddz} - ${D}; } else if (${ddz} < -${hD}) { ${ddz} = ${ddz} + ${D}; }`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`    if (${ddx} * ${ddx} + ${ddy} * ${ddy} + ${ddz} * ${ddz} <= ${rr}) {`);
    const col = fresh(ctx, 'acuCol'), row = fresh(ctx, 'acuRow'), lay = fresh(ctx, 'acuLay'), inb = fresh(ctx, 'acuIn');
    ctx.lines.push(`      var ${col}: i32 = ${ci}; var ${row}: i32 = ${ri}; var ${lay}: i32 = ${li}; var ${inb}: bool = true;`);
    ctx.lines.push(`      if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`        ${col} = ((${col} % i32(control.fieldW)) + i32(control.fieldW)) % i32(control.fieldW);`);
    ctx.lines.push(`        ${row} = ((${row} % i32(control.fieldH)) + i32(control.fieldH)) % i32(control.fieldH);`);
    ctx.lines.push(`        ${lay} = ((${lay} % i32(control.fieldD)) + i32(control.fieldD)) % i32(control.fieldD);`);
    ctx.lines.push(`      } else {`);
    ctx.lines.push(`        if (${col} < 0 || ${col} >= i32(control.fieldW) || ${row} < 0 || ${row} >= i32(control.fieldH) || ${lay} < 0 || ${lay} >= i32(control.fieldD)) { ${inb} = false; }`);
    ctx.lines.push(`      }`);
    ctx.lines.push(`      if (${inb}) {`);
    ctx.lines.push(`        let _ci: u32 = ${wBase}u + (u32(${lay}) * u32(control.fieldH) + u32(${row})) * u32(control.fieldW) + u32(${col});`);
    ctx.lines.push(`        fieldDepositCell(_ci, ${vL}, ${opCode}u);`);
    ctx.lines.push(`      }`);
    ctx.lines.push(`    }`);
    ctx.lines.push(`  } } } }`);
    return;
  }

  ctx.lines.push(`  { let ${cxL}: f32 = ${cx}; let ${cyL}: f32 = ${cy}; let ${rL}: f32 = ${r}; let ${vL}: f32 = ${v}; let ${rr}: f32 = ${rL} * ${rL};`);
  const cmin = fresh(ctx, 'acuCmin'), cmax = fresh(ctx, 'acuCmax'), rmin = fresh(ctx, 'acuRmin'), rmax = fresh(ctx, 'acuRmax');
  ctx.lines.push(`  let ${cmin}: i32 = i32(floor(${cxL} - ${rL})); let ${cmax}: i32 = i32(ceil(${cxL} + ${rL}));`);
  ctx.lines.push(`  let ${rmin}: i32 = i32(floor(${cyL} - ${rL})); let ${rmax}: i32 = i32(ceil(${cyL} + ${rL}));`);
  const ri = fresh(ctx, 'acuRi'), ci = fresh(ctx, 'acuCi');
  ctx.lines.push(`  for (var ${ri}: i32 = ${rmin}; ${ri} <= ${rmax}; ${ri} = ${ri} + 1) {`);
  ctx.lines.push(`  for (var ${ci}: i32 = ${cmin}; ${ci} <= ${cmax}; ${ci} = ${ci} + 1) {`);
  const ddx = fresh(ctx, 'acuDx'), ddy = fresh(ctx, 'acuDy');
  ctx.lines.push(`    let ${ddx}: f32 = f32(${ci}) - ${cxL}; let ${ddy}: f32 = f32(${ri}) - ${cyL};`);
  ctx.lines.push(`    if (${ddx} * ${ddx} + ${ddy} * ${ddy} <= ${rr}) {`);
  const col = fresh(ctx, 'acuCol'), row = fresh(ctx, 'acuRow'), inb = fresh(ctx, 'acuIn');
  ctx.lines.push(`      var ${col}: i32 = ${ci}; var ${row}: i32 = ${ri}; var ${inb}: bool = true;`);
  ctx.lines.push(`      if (control.fieldTorus != 0u) {`);
  ctx.lines.push(`        ${col} = ((${col} % i32(control.fieldW)) + i32(control.fieldW)) % i32(control.fieldW);`);
  ctx.lines.push(`        ${row} = ((${row} % i32(control.fieldH)) + i32(control.fieldH)) % i32(control.fieldH);`);
  ctx.lines.push(`      } else {`);
  ctx.lines.push(`        if (${col} < 0 || ${col} >= i32(control.fieldW) || ${row} < 0 || ${row} >= i32(control.fieldH)) { ${inb} = false; }`);
  ctx.lines.push(`      }`);
  ctx.lines.push(`      if (${inb}) {`);
  ctx.lines.push(`        let _ci: u32 = ${wBase}u + u32(${row}) * u32(control.fieldW) + u32(${col});`);
  ctx.lines.push(`        fieldDepositCell(_ci, ${vL}, ${opCode}u);`);
  ctx.lines.push(`      }`);
  ctx.lines.push(`    }`);
  ctx.lines.push(`  } } }`);
}

/** Secrete To Field — bilinear 4-cell (2D) / trilinear 8-cell (3D) splat deposit
 *  at the agent's position. The weights sum to 1, so the total deposit is `rate`.
 *  Additive (op=add). The 3D path mirrors SecreteToFieldNode's 8-cell splat. */
function emitSecreteToField(ctx: AgentWgpuCtx, node: GraphNode): void {
  const attr = fieldAttrId(node);
  if (ctx.layout.fieldWriteBase[attr] === undefined) return; // not a write field → no-op
  const wBase = fieldWriteBaseOf(ctx, attr);
  const rate = castTo(resolveValueInput(ctx, node, 'rate', 1), 'f32');
  const fx = f32At(ctx, 'x', 'idx'), fy = f32At(ctx, 'y', 'idx');
  const fxL = fresh(ctx, 'stfX'), fyL = fresh(ctx, 'stfY'), rt = fresh(ctx, 'stfR');

  if (ctx.is3d) {
    const fz = f32At(ctx, 'z', 'idx');
    const fzL = fresh(ctx, 'stfZ');
    ctx.lines.push(`  { let ${fxL}: f32 = ${fx}; let ${fyL}: f32 = ${fy}; let ${fzL}: f32 = ${fz}; let ${rt}: f32 = ${rate};`);
    const x0 = fresh(ctx, 'stfX0'), y0 = fresh(ctx, 'stfY0'), z0 = fresh(ctx, 'stfZ0');
    const x1 = fresh(ctx, 'stfX1'), y1 = fresh(ctx, 'stfY1'), z1 = fresh(ctx, 'stfZ1');
    const tx = fresh(ctx, 'stfTx'), ty = fresh(ctx, 'stfTy'), tz = fresh(ctx, 'stfTz');
    ctx.lines.push(`  var ${x0}: i32 = i32(floor(${fxL})); var ${y0}: i32 = i32(floor(${fyL})); var ${z0}: i32 = i32(floor(${fzL}));`);
    ctx.lines.push(`  let ${tx}: f32 = ${fxL} - f32(${x0}); let ${ty}: f32 = ${fyL} - f32(${y0}); let ${tz}: f32 = ${fzL} - f32(${z0});`);
    ctx.lines.push(`  var ${x1}: i32 = ${x0} + 1; var ${y1}: i32 = ${y0} + 1; var ${z1}: i32 = ${z0} + 1;`);
    ctx.lines.push(`  if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`    ${x0} = ((${x0} % i32(control.fieldW)) + i32(control.fieldW)) % i32(control.fieldW);`);
    ctx.lines.push(`    ${x1} = ((${x1} % i32(control.fieldW)) + i32(control.fieldW)) % i32(control.fieldW);`);
    ctx.lines.push(`    ${y0} = ((${y0} % i32(control.fieldH)) + i32(control.fieldH)) % i32(control.fieldH);`);
    ctx.lines.push(`    ${y1} = ((${y1} % i32(control.fieldH)) + i32(control.fieldH)) % i32(control.fieldH);`);
    ctx.lines.push(`    ${z0} = ((${z0} % i32(control.fieldD)) + i32(control.fieldD)) % i32(control.fieldD);`);
    ctx.lines.push(`    ${z1} = ((${z1} % i32(control.fieldD)) + i32(control.fieldD)) % i32(control.fieldD);`);
    ctx.lines.push(`  } else {`);
    ctx.lines.push(`    ${x0} = clamp(${x0}, 0, i32(control.fieldW) - 1); ${x1} = clamp(${x1}, 0, i32(control.fieldW) - 1);`);
    ctx.lines.push(`    ${y0} = clamp(${y0}, 0, i32(control.fieldH) - 1); ${y1} = clamp(${y1}, 0, i32(control.fieldH) - 1);`);
    ctx.lines.push(`    ${z0} = clamp(${z0}, 0, i32(control.fieldD) - 1); ${z1} = clamp(${z1}, 0, i32(control.fieldD) - 1);`);
    ctx.lines.push(`  }`);
    const W = `u32(control.fieldW)`, WH = `(u32(control.fieldW) * u32(control.fieldH))`;
    const splat3 = (layV: string, rowV: string, colV: string, wExpr: string) =>
      `fieldDepositCell(${wBase}u + u32(${layV}) * ${WH} + u32(${rowV}) * ${W} + u32(${colV}), ${rt} * (${wExpr}), 4u);`;
    ctx.lines.push(`  ${splat3(z0, y0, x0, `(1.0 - ${tx}) * (1.0 - ${ty}) * (1.0 - ${tz})`)}`);
    ctx.lines.push(`  ${splat3(z0, y0, x1, `${tx} * (1.0 - ${ty}) * (1.0 - ${tz})`)}`);
    ctx.lines.push(`  ${splat3(z0, y1, x0, `(1.0 - ${tx}) * ${ty} * (1.0 - ${tz})`)}`);
    ctx.lines.push(`  ${splat3(z0, y1, x1, `${tx} * ${ty} * (1.0 - ${tz})`)}`);
    ctx.lines.push(`  ${splat3(z1, y0, x0, `(1.0 - ${tx}) * (1.0 - ${ty}) * ${tz}`)}`);
    ctx.lines.push(`  ${splat3(z1, y0, x1, `${tx} * (1.0 - ${ty}) * ${tz}`)}`);
    ctx.lines.push(`  ${splat3(z1, y1, x0, `(1.0 - ${tx}) * ${ty} * ${tz}`)}`);
    ctx.lines.push(`  ${splat3(z1, y1, x1, `${tx} * ${ty} * ${tz}`)}`);
    ctx.lines.push(`  }`);
    return;
  }

  ctx.lines.push(`  { let ${fxL}: f32 = ${fx}; let ${fyL}: f32 = ${fy}; let ${rt}: f32 = ${rate};`);
  const x0 = fresh(ctx, 'stfX0'), y0 = fresh(ctx, 'stfY0'), x1 = fresh(ctx, 'stfX1'), y1 = fresh(ctx, 'stfY1');
  const tx = fresh(ctx, 'stfTx'), ty = fresh(ctx, 'stfTy');
  ctx.lines.push(`  var ${x0}: i32 = i32(floor(${fxL})); var ${y0}: i32 = i32(floor(${fyL}));`);
  ctx.lines.push(`  let ${tx}: f32 = ${fxL} - f32(${x0}); let ${ty}: f32 = ${fyL} - f32(${y0});`);
  ctx.lines.push(`  var ${x1}: i32 = ${x0} + 1; var ${y1}: i32 = ${y0} + 1;`);
  ctx.lines.push(`  if (control.fieldTorus != 0u) {`);
  ctx.lines.push(`    ${x0} = ((${x0} % i32(control.fieldW)) + i32(control.fieldW)) % i32(control.fieldW);`);
  ctx.lines.push(`    ${x1} = ((${x1} % i32(control.fieldW)) + i32(control.fieldW)) % i32(control.fieldW);`);
  ctx.lines.push(`    ${y0} = ((${y0} % i32(control.fieldH)) + i32(control.fieldH)) % i32(control.fieldH);`);
  ctx.lines.push(`    ${y1} = ((${y1} % i32(control.fieldH)) + i32(control.fieldH)) % i32(control.fieldH);`);
  ctx.lines.push(`  } else {`);
  ctx.lines.push(`    ${x0} = clamp(${x0}, 0, i32(control.fieldW) - 1); ${x1} = clamp(${x1}, 0, i32(control.fieldW) - 1);`);
  ctx.lines.push(`    ${y0} = clamp(${y0}, 0, i32(control.fieldH) - 1); ${y1} = clamp(${y1}, 0, i32(control.fieldH) - 1);`);
  ctx.lines.push(`  }`);
  const W = `u32(control.fieldW)`;
  const splat = (rowV: string, colV: string, wExpr: string) =>
    `fieldDepositCell(${wBase}u + u32(${rowV}) * ${W} + u32(${colV}), ${rt} * (${wExpr}), 4u);`;
  ctx.lines.push(`  ${splat(y0, x0, `(1.0 - ${tx}) * (1.0 - ${ty})`)}`);
  ctx.lines.push(`  ${splat(y0, x1, `${tx} * (1.0 - ${ty})`)}`);
  ctx.lines.push(`  ${splat(y1, x0, `(1.0 - ${tx}) * ${ty}`)}`);
  ctx.lines.push(`  ${splat(y1, x1, `${tx} * ${ty}`)}`);
  ctx.lines.push(`  }`);
}

/** Set Cell Looks — colour THIS agent (per-agent RGBA into `agentColors[idx]`,
 *  packed `r | g<<8 | b<<16 | a<<24`, mirroring the lattice WGSL setCellLooks).
 *  The agent render draws filled circles only (no glyph overlay on ANY target),
 *  so this writes ONLY the background colour: plain mode always, glyph mode when
 *  `setBackground` is on. A glyph-WITHOUT-background setCellLooks is a no-op here
 *  — the SAME no-op as JS/WASM (where the per-agent glyph write lands in the
 *  length-0 GLYPH_NOOP buffer), so cross-target parity holds and the node never
 *  clamps the model off WebGPU. The agent loop's "viewer" is always the current
 *  pass, so the `__current__` sentinel + any concrete mapping write
 *  unconditionally (the worker dispatches one behaviour pass; there's no
 *  per-mapping viewer guard on the agent colour buffer). */
function emitSetCellLooks(ctx: AgentWgpuCtx, node: GraphNode): void {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const useGlyph = !!cfg?.['useGlyph'];
  const setBg = cfg?.['setBackground'] !== false; // default true
  const doBg = !useGlyph || setBg;
  if (!doBg) return; // glyph-only (no background) → no agent-colour write (no-op, == JS/WASM)
  const re = `u32(clamp(${castTo(resolveValueInput(ctx, node, 'r', 0), 'i32')}, 0, 255))`;
  const ge = `u32(clamp(${castTo(resolveValueInput(ctx, node, 'g', 0), 'i32')}, 0, 255))`;
  const be = `u32(clamp(${castTo(resolveValueInput(ctx, node, 'b', 0), 'i32')}, 0, 255))`;
  const aSrc = ctx.adj.inputToSource.get(`${node.id}:a`);
  const aInline = getInlineNum(node, 'a', 255);
  const ae = (!aSrc && aInline === 255) ? '255u' : `u32(clamp(${castTo(resolveValueInput(ctx, node, 'a', 255), 'i32')}, 0, 255))`;
  ctx.lines.push(`  agentColors[idx] = (${re}) | ((${ge}) << 8u) | ((${be}) << 16u) | (${ae} << 24u);`);
}

// ---------------------------------------------------------------------------
// getNearbyAgents + forEachInArray — the keystone array path.
//
// getNearbyAgents fills a per-thread `var<function> array<i32, maxAgents>` with
// the matched agent ids + a length local, queried against the in-buffer CSR hash
// (3×3 bin stencil + torus wrap) with an all-pairs fallback. forEachInArray loops
// it. Mirrors GetNearbyAgentsNode's JS emit exactly (2D Boids subset).
// ---------------------------------------------------------------------------

/** Emit the getNearbyAgents fill into its scratch slot; return the slot's array
 *  var name + the length local as an `AgentArrayRef`. */
function emitNearbyFill(ctx: AgentWgpuCtx, naNode: GraphNode): AgentArrayRef {
  const is3d = ctx.is3d;
  const { arrName } = arraySlotName(ctx, naNode.id); // the per-thread var array (declared at fn top)
  const lenName = fresh(ctx, 'naLen');
  const r2 = fresh(ctx, 'naR2'), xi = fresh(ctx, 'naXi'), yi = fresh(ctx, 'naYi'), zi = fresh(ctx, 'naZi');
  const qr = castTo(resolveValueInput(ctx, naNode, 'radius', 5), 'f32');
  ctx.lines.push(`  var ${lenName}: i32 = 0;`);
  ctx.lines.push(`  let ${r2}: f32 = (${qr}) * (${qr});`);
  ctx.lines.push(`  let ${xi}: f32 = ${f32At(ctx, 'x', 'idx')};`);
  ctx.lines.push(`  let ${yi}: f32 = ${f32At(ctx, 'y', 'idx')};`);
  if (is3d) ctx.lines.push(`  let ${zi}: f32 = ${f32At(ctx, 'z', 'idx')};`);

  // FOV cone (getAgentsInView only) — the heading (hx,hy[,hz]) + |heading|, once per
  // agent. Mirrors the JS/WASM preamble; cosHalf is the SAME compile-time literal
  // (viewCosHalf, no runtime cos). getNearbyAgents (and the omni fast-path,
  // halfAngle≥180) keep cone=null ⇒ the push below is byte-identical. f32 ⇒ a
  // cone-boundary statistical difference vs JS/WASM (the documented WebGPU stance,
  // same class as the distance-boundary difference), not a bug.
  let cone: { cosHalfLit: string; hx: string; hy: string; hz: string; hm2: string; hm: string } | null = null;
  if (naNode.data.nodeType === 'getAgentsInView') {
    const { cosHalf, omni } = viewCosHalf(naNode.data.config as Record<string, unknown>);
    if (!omni) {
      const wired = naNode.data.config.headingSource === 'wired';
      const hx = fresh(ctx, 'naHx'), hy = fresh(ctx, 'naHy'), hz = fresh(ctx, 'naHz'), hm2 = fresh(ctx, 'naHm2'), hm = fresh(ctx, 'naHm');
      ctx.lines.push(`  let ${hx}: f32 = ${wired ? castTo(resolveValueInput(ctx, naNode, 'headingX', 0), 'f32') : f32At(ctx, 'vx', 'idx')};`);
      ctx.lines.push(`  let ${hy}: f32 = ${wired ? castTo(resolveValueInput(ctx, naNode, 'headingY', 0), 'f32') : f32At(ctx, 'vy', 'idx')};`);
      let hm2Expr = `${hx} * ${hx} + ${hy} * ${hy}`;
      if (is3d) {
        ctx.lines.push(`  let ${hz}: f32 = ${wired ? castTo(resolveValueInput(ctx, naNode, 'headingZ', 0), 'f32') : f32At(ctx, 'vz', 'idx')};`);
        hm2Expr += ` + ${hz} * ${hz}`;
      }
      ctx.lines.push(`  let ${hm2}: f32 = ${hm2Expr};`);
      ctx.lines.push(`  let ${hm}: f32 = sqrt(${hm2});`);
      cone = { cosHalfLit: Number.isInteger(cosHalf) ? cosHalf.toFixed(1) : String(cosHalf), hx, hy, hz, hm2, hm };
    }
  }

  // The candidate test, applied to a candidate u32 id `j`. Pushes j into the
  // scratch array + bumps len when (j != idx && alive[j] && torus-folded d2 <= r2).
  const test = (jExpr: string) => {
    const j = fresh(ctx, 'naJ');
    ctx.lines.push(`  { let ${j}: u32 = ${jExpr};`);
    ctx.lines.push(`    if (${j} != idx && agentAlive[${j}] != 0u) {`);
    const dx = fresh(ctx, 'naDx'), dy = fresh(ctx, 'naDy'), dz = fresh(ctx, 'naDz');
    ctx.lines.push(`      var ${dx}: f32 = ${f32At(ctx, 'x', j)} - ${xi};`);
    ctx.lines.push(`      var ${dy}: f32 = ${f32At(ctx, 'y', j)} - ${yi};`);
    if (is3d) ctx.lines.push(`      var ${dz}: f32 = ${f32At(ctx, 'z', j)} - ${zi};`);
    ctx.lines.push(`      if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`        let _hW = control.fieldW * 0.5; let _hH = control.fieldH * 0.5;`);
    ctx.lines.push(`        if (${dx} > _hW) { ${dx} = ${dx} - control.fieldW; } else if (${dx} < -_hW) { ${dx} = ${dx} + control.fieldW; }`);
    ctx.lines.push(`        if (${dy} > _hH) { ${dy} = ${dy} - control.fieldH; } else if (${dy} < -_hH) { ${dy} = ${dy} + control.fieldH; }`);
    if (is3d) {
      ctx.lines.push(`        let _hD = control.fieldD * 0.5;`);
      ctx.lines.push(`        if (${dz} > _hD) { ${dz} = ${dz} - control.fieldD; } else if (${dz} < -_hD) { ${dz} = ${dz} + control.fieldD; }`);
    }
    ctx.lines.push(`      }`);
    const d2 = is3d ? `${dx} * ${dx} + ${dy} * ${dy} + ${dz} * ${dz}` : `${dx} * ${dx} + ${dy} * ${dy}`;
    ctx.lines.push(`      if (${d2} <= ${r2} && ${lenName} < i32(control.maxAgents)) {`);
    if (cone) {
      // Cone gate: hm2==0 ⇒ omnidirectional; else dot(h,offset) ≥ cosHalf·|h|·d
      // (division-free `cosA ≥ cosHalf`). Mirrors the JS/WASM op order.
      const dotE = is3d ? `${cone.hx} * ${dx} + ${cone.hy} * ${dy} + ${cone.hz} * ${dz}` : `${cone.hx} * ${dx} + ${cone.hy} * ${dy}`;
      ctx.lines.push(`        if (${cone.hm2} == 0.0 || (${dotE}) >= (${cone.cosHalfLit} * ${cone.hm}) * sqrt(${d2})) {`);
      ctx.lines.push(`          ${arrName}[${lenName}] = i32(${j}); ${lenName} = ${lenName} + 1;`);
      ctx.lines.push(`        }`);
    } else {
      ctx.lines.push(`        ${arrName}[${lenName}] = i32(${j}); ${lenName} = ${lenName} + 1;`);
    }
    ctx.lines.push(`      }`);
    ctx.lines.push(`    } }`);
  };

  ctx.lines.push(`  if (control.hashValid != 0u) {`);
  emitHashStencil(ctx, test, xi, yi, zi);
  ctx.lines.push(`  } else {`);
  emitAllPairs(ctx, test);
  ctx.lines.push(`  }`);
  return { arrName, lenName, elemType: 'i32' };
}

/** Sense Hemifield (the Braitenberg L/R sensor) — one gather pass into TWO i32
 *  counters (no scratch array; a plain multi-output value node). Reuses the SAME
 *  stencil + cone gate as emitNearbyFill; each in-view neighbour is split by the
 *  sign of the heading-relative cross product (2D: hx·dy−hy·dx; 3D: the triple
 *  product against a +Z up-reference, swapped to +Y for a near-vertical heading —
 *  `select(+Z form, +Y form, upY)`). f32 ⇒ a boundary statistical difference vs
 *  JS/WASM (the documented WebGPU stance). Multi-output: leftCount / rightCount. */
function emitSenseHemifield(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const is3d = ctx.is3d;
  const cached = ctx.valueCache.get(`${node.id}:leftCount`);
  if (cached !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cached;

  const left = fresh(ctx, 'shL'), right = fresh(ctx, 'shR'), cr = fresh(ctx, 'shCr');
  ctx.lines.push(`  var ${left}: i32 = 0; var ${right}: i32 = 0;`);
  const r2 = fresh(ctx, 'shR2'), xi = fresh(ctx, 'shXi'), yi = fresh(ctx, 'shYi'), zi = fresh(ctx, 'shZi');
  const qr = castTo(resolveValueInput(ctx, node, 'radius', 5), 'f32');
  ctx.lines.push(`  let ${r2}: f32 = (${qr}) * (${qr});`);
  ctx.lines.push(`  let ${xi}: f32 = ${f32At(ctx, 'x', 'idx')};`);
  ctx.lines.push(`  let ${yi}: f32 = ${f32At(ctx, 'y', 'idx')};`);
  if (is3d) ctx.lines.push(`  let ${zi}: f32 = ${f32At(ctx, 'z', 'idx')};`);

  // heading (hx,hy[,hz]) + |heading| — ALWAYS needed (the cross uses it), plus cosHalf.
  const { cosHalf, omni } = viewCosHalf(node.data.config as Record<string, unknown>);
  const cosHalfLit = Number.isInteger(cosHalf) ? cosHalf.toFixed(1) : String(cosHalf);
  const wired = node.data.config.headingSource === 'wired';
  const hx = fresh(ctx, 'shHx'), hy = fresh(ctx, 'shHy'), hz = fresh(ctx, 'shHz'), hm2 = fresh(ctx, 'shHm2'), hm = fresh(ctx, 'shHm'), upY = fresh(ctx, 'shUpY');
  ctx.lines.push(`  let ${hx}: f32 = ${wired ? castTo(resolveValueInput(ctx, node, 'headingX', 0), 'f32') : f32At(ctx, 'vx', 'idx')};`);
  ctx.lines.push(`  let ${hy}: f32 = ${wired ? castTo(resolveValueInput(ctx, node, 'headingY', 0), 'f32') : f32At(ctx, 'vy', 'idx')};`);
  let hm2Expr = `${hx} * ${hx} + ${hy} * ${hy}`;
  if (is3d) {
    ctx.lines.push(`  let ${hz}: f32 = ${wired ? castTo(resolveValueInput(ctx, node, 'headingZ', 0), 'f32') : f32At(ctx, 'vz', 'idx')};`);
    hm2Expr += ` + ${hz} * ${hz}`;
  }
  ctx.lines.push(`  let ${hm2}: f32 = ${hm2Expr};`);
  ctx.lines.push(`  let ${hm}: f32 = sqrt(${hm2});`);
  if (is3d) ctx.lines.push(`  let ${upY}: bool = ${hz} * ${hz} > 0.81 * ${hm2};`);

  // cross ≥ 0 ⇒ Left, else Right. WGSL select(f, t, cond) → t if cond else f, so the
  // +Y form is the true-arm and the +Z form the false-arm: select(+Z, +Y, upY). The
  // per-neighbour offsets (dx/dy/dz) are fresh inside `test`, so cross is built there.
  const test = (jExpr: string) => {
    const j = fresh(ctx, 'shJ');
    ctx.lines.push(`  { let ${j}: u32 = ${jExpr};`);
    ctx.lines.push(`    if (${j} != idx && agentAlive[${j}] != 0u) {`);
    const dx = fresh(ctx, 'shDx'), dy = fresh(ctx, 'shDy'), dz = fresh(ctx, 'shDz');
    ctx.lines.push(`      var ${dx}: f32 = ${f32At(ctx, 'x', j)} - ${xi};`);
    ctx.lines.push(`      var ${dy}: f32 = ${f32At(ctx, 'y', j)} - ${yi};`);
    if (is3d) ctx.lines.push(`      var ${dz}: f32 = ${f32At(ctx, 'z', j)} - ${zi};`);
    ctx.lines.push(`      if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`        let _hW = control.fieldW * 0.5; let _hH = control.fieldH * 0.5;`);
    ctx.lines.push(`        if (${dx} > _hW) { ${dx} = ${dx} - control.fieldW; } else if (${dx} < -_hW) { ${dx} = ${dx} + control.fieldW; }`);
    ctx.lines.push(`        if (${dy} > _hH) { ${dy} = ${dy} - control.fieldH; } else if (${dy} < -_hH) { ${dy} = ${dy} + control.fieldH; }`);
    if (is3d) {
      ctx.lines.push(`        let _hD = control.fieldD * 0.5;`);
      ctx.lines.push(`        if (${dz} > _hD) { ${dz} = ${dz} - control.fieldD; } else if (${dz} < -_hD) { ${dz} = ${dz} + control.fieldD; }`);
    }
    ctx.lines.push(`      }`);
    const d2 = is3d ? `${dx} * ${dx} + ${dy} * ${dy} + ${dz} * ${dz}` : `${dx} * ${dx} + ${dy} * ${dy}`;
    const cross = is3d
      ? `select(${hx} * ${dy} - ${hy} * ${dx}, ${hz} * ${dx} - ${hx} * ${dz}, ${upY})`
      : `${hx} * ${dy} - ${hy} * ${dx}`;
    const tally = `{ let ${cr}: f32 = ${cross}; if (${cr} >= 0.0) { ${left} = ${left} + 1; } else { ${right} = ${right} + 1; } }`;
    ctx.lines.push(`      if (${d2} <= ${r2}) {`);
    if (omni) {
      ctx.lines.push(`        ${tally}`);
    } else {
      const dotE = is3d ? `${hx} * ${dx} + ${hy} * ${dy} + ${hz} * ${dz}` : `${hx} * ${dx} + ${hy} * ${dy}`;
      ctx.lines.push(`        if (${hm2} == 0.0 || (${dotE}) >= (${cosHalfLit} * ${hm}) * sqrt(${d2})) {`);
      ctx.lines.push(`          ${tally}`);
      ctx.lines.push(`        }`);
    }
    ctx.lines.push(`      }`);
    ctx.lines.push(`    } }`);
  };

  ctx.lines.push(`  if (control.hashValid != 0u) {`);
  emitHashStencil(ctx, test, xi, yi, zi);
  ctx.lines.push(`  } else {`);
  emitAllPairs(ctx, test);
  ctx.lines.push(`  }`);

  const refs: Record<string, ValueRef> = {
    leftCount: { expr: left, type: 'i32' },
    rightCount: { expr: right, type: 'i32' },
  };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['leftCount']!;
}

/** The 3×3 (2D) / 3×3×3 (3D) hash-bin stencil over the in-buffer binStart/binAgents
 *  (CSR), torus-wrapped like the JS/WASM emit. Calls `test(jExpr)` per candidate.
 *  The 3D bin index is `(nbz·nBinsY + nby)·nBinsX + nbx`. */
function emitHashStencil(ctx: AgentWgpuCtx, test: (jExpr: string) => void, xi: string, yi: string, zi: string): void {
  const is3d = ctx.is3d;
  const bsBase = ctx.layout.hashBinStartBase;
  const baBase = ctx.layout.hashBinAgentsBase;
  const binStartAt = (e: string) => bsBase === 0 ? `hashBins[${e}]` : `hashBins[${bsBase}u + ${e}]`;
  const binAgentsAt = (e: string) => baBase === 0 ? `hashBins[${e}]` : `hashBins[${baBase}u + ${e}]`;
  const bx = fresh(ctx, 'naBx'), by = fresh(ctx, 'naBy'), bz = fresh(ctx, 'naBz');
  ctx.lines.push(`  var ${bx}: i32 = i32((${xi} - control.originX) / control.binSizeX);`);
  ctx.lines.push(`  ${bx} = clamp(${bx}, 0, i32(control.nBinsX) - 1);`);
  ctx.lines.push(`  var ${by}: i32 = i32((${yi} - control.originY) / control.binSizeY);`);
  ctx.lines.push(`  ${by} = clamp(${by}, 0, i32(control.nBinsY) - 1);`);
  if (is3d) {
    ctx.lines.push(`  var ${bz}: i32 = i32((${zi} - control.originZ) / control.binSizeZ);`);
    ctx.lines.push(`  ${bz} = clamp(${bz}, 0, i32(control.nBinsZ) - 1);`);
  }
  const ez = fresh(ctx, 'naEz'), ey = fresh(ctx, 'naEy'), ex = fresh(ctx, 'naEx');
  if (is3d) ctx.lines.push(`  for (var ${ez}: i32 = -1; ${ez} <= 1; ${ez} = ${ez} + 1) {`);
  ctx.lines.push(`  for (var ${ey}: i32 = -1; ${ey} <= 1; ${ey} = ${ey} + 1) {`);
  ctx.lines.push(`  for (var ${ex}: i32 = -1; ${ex} <= 1; ${ex} = ${ex} + 1) {`);
  const nbx = fresh(ctx, 'naNbx'), nby = fresh(ctx, 'naNby'), nbz = fresh(ctx, 'naNbz'), skip = fresh(ctx, 'naSkip');
  ctx.lines.push(`    var ${nbx}: i32 = ${bx} + ${ex}; var ${nby}: i32 = ${by} + ${ey}; var ${skip}: bool = false;`);
  if (is3d) ctx.lines.push(`    var ${nbz}: i32 = ${bz} + ${ez};`);
  ctx.lines.push(`    if (control.fieldTorus != 0u) {`);
  ctx.lines.push(`      ${nbx} = ((${nbx} % i32(control.nBinsX)) + i32(control.nBinsX)) % i32(control.nBinsX);`);
  ctx.lines.push(`      ${nby} = ((${nby} % i32(control.nBinsY)) + i32(control.nBinsY)) % i32(control.nBinsY);`);
  if (is3d) ctx.lines.push(`      ${nbz} = ((${nbz} % i32(control.nBinsZ)) + i32(control.nBinsZ)) % i32(control.nBinsZ);`);
  ctx.lines.push(`    } else {`);
  const oob3d = is3d ? ` || ${nbz} < 0 || ${nbz} >= i32(control.nBinsZ)` : '';
  ctx.lines.push(`      if (${nbx} < 0 || ${nbx} >= i32(control.nBinsX) || ${nby} < 0 || ${nby} >= i32(control.nBinsY)${oob3d}) { ${skip} = true; }`);
  ctx.lines.push(`    }`);
  ctx.lines.push(`    if (!${skip}) {`);
  const b = fresh(ctx, 'naB'), p = fresh(ctx, 'naP'), end = fresh(ctx, 'naEnd');
  const binIdx = is3d
    ? `(${nbz} * i32(control.nBinsY) + ${nby}) * i32(control.nBinsX) + ${nbx}`
    : `${nby} * i32(control.nBinsX) + ${nbx}`;
  ctx.lines.push(`      let ${b}: i32 = ${binIdx};`);
  ctx.lines.push(`      let ${p}_start: i32 = ${binStartAt(`u32(${b})`)};`);
  ctx.lines.push(`      let ${end}: i32 = ${binStartAt(`u32(${b}) + 1u`)};`);
  ctx.lines.push(`      for (var ${p}: i32 = ${p}_start; ${p} < ${end}; ${p} = ${p} + 1) {`);
  test(`u32(${binAgentsAt(`u32(${p})`)})`);
  ctx.lines.push(`      }`);
  ctx.lines.push(`    }`);
  ctx.lines.push(is3d ? `  } } }` : `  } }`);
}

/** All-pairs fallback: for (all=0; all<highWater; all++) test(all). */
function emitAllPairs(ctx: AgentWgpuCtx, test: (jExpr: string) => void): void {
  const all = fresh(ctx, 'naAll');
  ctx.lines.push(`  for (var ${all}: u32 = 0u; ${all} < control.highWater; ${all} = ${all} + 1u) {`);
  test(all);
  ctx.lines.push(`  }`);
}

/** forEachInArray over ANY agent-array producer (getNearbyAgents / filterAgents /
 *  joinAgents / pickNRandomAgents = i32 id arrays, getAgentsAttribute = an f32
 *  values array). The per-iteration `element` is the array's `elemType`. */
/** Update Indicator — atomic in-place modify of a standalone indicator (the
 *  `indicators` atomic<u32> buffer). inc/dec/max/min (int via atomicAdd/Max/Min;
 *  float via a CAS loop) + or/and (bool). toggle/next/previous reject at the gate
 *  (order-dependent — same as the lattice WebGPU). Mirrors the lattice emit. */
function emitUpdateIndicator(ctx: AgentWgpuCtx, node: GraphNode): void {
  const slot = node.data.config?.['_indicatorIdx'];
  const off = typeof slot === 'number' ? slot : -1;
  if (off < 0) return;
  ctx.usesIndicators = true;
  const op = (node.data.config?.['operation'] as string) || 'increment';
  const isInt = node.data.config?.['_indicatorIsInt'] === true;
  if (op === 'or' || op === 'and') {
    const vb = `(${inF32(ctx, node, 'value', 0)} != 0.0)`;
    if (op === 'or') ctx.lines.push(`  if (${vb}) { atomicOr(&indicators[${off}u], 1u); }`);
    else ctx.lines.push(`  if (!${vb}) { atomicAnd(&indicators[${off}u], 0u); }`);
    return;
  }
  if (isInt && (op === 'increment' || op === 'decrement')) {
    const vi = castTo(resolveValueInput(ctx, node, 'value', op === 'increment' ? 1 : 1), 'i32');
    const sign = op === 'increment' ? '' : '-';
    ctx.lines.push(`  atomicAdd(&indicators[${off}u], bitcast<u32>(${sign}(${vi})));`);
    return;
  }
  if (isInt && (op === 'max' || op === 'min')) {
    const vi = castTo(resolveValueInput(ctx, node, 'value', 0), 'i32');
    const fn = op === 'max' ? 'atomicMax' : 'atomicMin';
    ctx.lines.push(`  ${fn}(&indicators[${off}u], bitcast<u32>(${vi}));`);
    return;
  }
  // float CAS loop.
  const vf = inF32(ctx, node, 'value', op === 'increment' || op === 'decrement' ? 1 : 0);
  let fnExpr: string;
  switch (op) {
    case 'decrement': fnExpr = `(_old_f - (${vf}))`; break;
    case 'max': fnExpr = `max(_old_f, (${vf}))`; break;
    case 'min': fnExpr = `min(_old_f, (${vf}))`; break;
    default: fnExpr = `(_old_f + (${vf}))`; break; // increment
  }
  ctx.lines.push(`  loop {`);
  ctx.lines.push(`    let _old_u: u32 = atomicLoad(&indicators[${off}u]);`);
  ctx.lines.push(`    let _old_f: f32 = bitcast<f32>(_old_u);`);
  ctx.lines.push(`    let _new_u: u32 = bitcast<u32>(${fnExpr});`);
  ctx.lines.push(`    let _r = atomicCompareExchangeWeak(&indicators[${off}u], _old_u, _new_u);`);
  ctx.lines.push(`    if (_r.exchanged) { break; }`);
  ctx.lines.push(`  }`);
}

/** For Each Bond — iterate this agent's ragged bond list (reads `bondStore`).
 *  Exposes partnerId / restLength / currentLength / index per iteration. */
function emitForEachBond(ctx: AgentWgpuCtx, node: GraphNode): void {
  ctx.usesBondStore = true;
  const bc = fresh(ctx, 'febBc'), base = fresh(ctx, 'febBase'), k = fresh(ctx, 'febK');
  const partner = fresh(ctx, 'febP'), rest = fresh(ctx, 'febRest'), cur = fresh(ctx, 'febCur');
  const dx = fresh(ctx, 'febDx'), dy = fresh(ctx, 'febDy');
  ctx.lines.push(`  { let ${bc}: i32 = ${i32At(ctx, 'bondCount', 'idx')};`);
  ctx.lines.push(`    let ${base}: u32 = idx * u32(control.maxBonds) * 2u;`);
  ctx.lines.push(`    for (var ${k}: i32 = 0; ${k} < ${bc}; ${k} = ${k} + 1) {`);
  ctx.lines.push(`      let ${partner}: i32 = bondStore[${base} + u32(${k}) * 2u];`);
  ctx.lines.push(`      let ${rest}: f32 = bitcast<f32>(bondStore[${base} + u32(${k}) * 2u + 1u]);`);
  ctx.lines.push(`      var ${cur}: f32 = 0.0;`);
  ctx.lines.push(`      if (${partner} >= 0 && ${partner} < i32(control.highWater)) {`);
  ctx.lines.push(`        var ${dx}: f32 = ${f32At(ctx, 'x', `u32(${partner})`)} - ${f32At(ctx, 'x', 'idx')};`);
  ctx.lines.push(`        var ${dy}: f32 = ${f32At(ctx, 'y', `u32(${partner})`)} - ${f32At(ctx, 'y', 'idx')};`);
  if (ctx.is3d) {
    const dz = fresh(ctx, 'febDz');
    ctx.lines.push(`        var ${dz}: f32 = ${f32At(ctx, 'z', `u32(${partner})`)} - ${f32At(ctx, 'z', 'idx')};`);
    ctx.lines.push(`        if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`          let _hw = control.fieldW * 0.5; let _hh = control.fieldH * 0.5; let _hd = control.fieldD * 0.5;`);
    ctx.lines.push(`          if (${dx} > _hw) { ${dx} = ${dx} - control.fieldW; } else if (${dx} < -_hw) { ${dx} = ${dx} + control.fieldW; }`);
    ctx.lines.push(`          if (${dy} > _hh) { ${dy} = ${dy} - control.fieldH; } else if (${dy} < -_hh) { ${dy} = ${dy} + control.fieldH; }`);
    ctx.lines.push(`          if (${dz} > _hd) { ${dz} = ${dz} - control.fieldD; } else if (${dz} < -_hd) { ${dz} = ${dz} + control.fieldD; }`);
    ctx.lines.push(`        }`);
    ctx.lines.push(`        ${cur} = sqrt(${dx} * ${dx} + ${dy} * ${dy} + ${dz} * ${dz});`);
  } else {
    ctx.lines.push(`        if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`          let _hw = control.fieldW * 0.5; let _hh = control.fieldH * 0.5;`);
    ctx.lines.push(`          if (${dx} > _hw) { ${dx} = ${dx} - control.fieldW; } else if (${dx} < -_hw) { ${dx} = ${dx} + control.fieldW; }`);
    ctx.lines.push(`          if (${dy} > _hh) { ${dy} = ${dy} - control.fieldH; } else if (${dy} < -_hh) { ${dy} = ${dy} + control.fieldH; }`);
    ctx.lines.push(`        }`);
    ctx.lines.push(`        ${cur} = sqrt(${dx} * ${dx} + ${dy} * ${dy});`);
  }
  ctx.lines.push(`      }`);
  ctx.forEachBondStack.push({ nodeId: node.id, partner, rest, cur, index: k });
  clearVolatileCache(ctx);
  compileFlowChain(ctx, node.id, 'body');
  ctx.forEachBondStack.pop();
  ctx.lines.push(`    }`);
  ctx.lines.push(`  }`);
  clearVolatileCache(ctx);
}

/** Switch — multi-way branch. Conditions mode (per-case bool inputs) or value mode
 *  (compare a value against per-case constants/inputs). Mirrors the lattice WGSL
 *  switch (if/else-if chain for firstMatchOnly; independent ifs otherwise). */
function emitSwitch(ctx: AgentWgpuCtx, node: GraphNode): void {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const mode = (cfg?.['mode'] as string) || 'conditions';
  const firstMatchOnly = cfg?.['firstMatchOnly'] !== false;
  const valType = (cfg?.['valueType'] as string) || 'integer';
  const caseCount = Number(cfg?.['caseCount']) || 0;
  const hasDefault = ctx.adj.flowOutputToTargets.has(`${node.id}:default`);
  if (caseCount === 0) { compileFlowChain(ctx, node.id, 'default'); return; }
  // The compared value (value mode).
  let valueRef: ValueRef | null = null;
  if (mode === 'value') valueRef = resolveValueInput(ctx, node, 'value', 0);
  const caseConds: string[] = [];
  for (let ci = 0; ci < caseCount; ci++) {
    if (mode === 'conditions') {
      const condSrc = ctx.adj.inputToSource.get(`${node.id}:case_${ci}_cond`);
      if (condSrc) caseConds.push(castTo(compileValueNode(ctx, condSrc.nodeId, condSrc.portId), 'bool'));
      else caseConds.push(cfg?.[`_port_case_${ci}_cond`] === 'true' ? 'true' : 'false');
    } else {
      const caseValSrc = ctx.adj.inputToSource.get(`${node.id}:case_${ci}_val`);
      let caseVal: ValueRef;
      if (caseValSrc) caseVal = compileValueNode(ctx, caseValSrc.nodeId, caseValSrc.portId);
      else {
        const raw = cfg?.[`_port_case_${ci}_val`] ?? cfg?.[`case_${ci}_value`] ?? 0;
        const num = parseFloat(String(raw));
        const n = Number.isFinite(num) ? num : 0;
        caseVal = valType === 'float' ? { expr: `${n}.0`, type: 'f32' } : { expr: `${n | 0}`, type: 'i32' };
      }
      const rawOp = (cfg?.[`case_${ci}_op`] as string) || '==';
      const op = rawOp === '===' ? '==' : rawOp === '!==' ? '!=' : rawOp;
      const wt: WgslType = valType === 'float' ? 'f32' : 'i32';
      caseConds.push(`(${castTo(valueRef!, wt)} ${op} ${castTo(caseVal, wt)})`);
    }
  }
  // Branch-entry volatile clears — a volatile value cached from one case would
  // leave a sibling case referencing a block-scoped `let` from the first case
  // (WGSL unresolved-name compile error). Mirrors the conditional emit.
  if (firstMatchOnly) {
    const open = (ci: number): void => {
      if (ci >= caseCount) { if (hasDefault) { clearVolatileCache(ctx); compileFlowChain(ctx, node.id, 'default'); } return; }
      ctx.lines.push(`  if (${caseConds[ci]}) {`);
      clearVolatileCache(ctx);
      compileFlowChain(ctx, node.id, `case_${ci}`);
      ctx.lines.push(`  } else {`);
      open(ci + 1);
      ctx.lines.push(`  }`);
    };
    open(0);
    clearVolatileCache(ctx);
  } else {
    for (let ci = 0; ci < caseCount; ci++) {
      ctx.lines.push(`  if (${caseConds[ci]}) {`);
      clearVolatileCache(ctx);
      compileFlowChain(ctx, node.id, `case_${ci}`);
      ctx.lines.push(`  }`);
    }
    if (hasDefault) { clearVolatileCache(ctx); compileFlowChain(ctx, node.id, 'default'); }
    clearVolatileCache(ctx);
  }
}

/** Loop — repeat BODY `count` times (or From..To inclusive in range mode). The
 *  counter is exposed via the node's `index` output (body-only; consumers are
 *  volatile so they re-emit per iteration, like forEach element/index). */
function emitLoop(ctx: AgentWgpuCtx, node: GraphNode): void {
  // Resolve the bound inputs BEFORE minting `li` — resolution mints fresh names
  // of its own, and the historical name order (bound first) is what existing
  // shaders carry (byte-identity for count-mode models).
  const isRange = node.data.config?.['mode'] === 'range';
  if (isRange) {
    const from = castTo(resolveValueInput(ctx, node, 'from', 0), 'i32');
    const to = castTo(resolveValueInput(ctx, node, 'to', 0), 'i32');
    const li = fresh(ctx, 'lpI');
    ctx.lines.push(`  for (var ${li}: i32 = ${from}; ${li} <= ${to}; ${li} = ${li} + 1) {`);
    runLoopBody(ctx, node, li);
    return;
  }
  const cnt = castTo(resolveValueInput(ctx, node, 'count', 1), 'i32');
  const li = fresh(ctx, 'lpI');
  ctx.lines.push(`  for (var ${li}: i32 = 0; ${li} < ${cnt}; ${li} = ${li} + 1) {`);
  runLoopBody(ctx, node, li);
}

/** Shared Loop body emit (both modes): expose the counter frame, compile the
 *  BODY chain with per-iteration volatile-cache clears, close the block. */
function runLoopBody(ctx: AgentWgpuCtx, node: GraphNode, li: string): void {
  ctx.loopStack.push({ nodeId: node.id, idxName: li });
  clearVolatileCache(ctx);
  compileFlowChain(ctx, node.id, 'body');
  ctx.loopStack.pop();
  ctx.lines.push(`  }`);
  clearVolatileCache(ctx);
}

function emitForEach(ctx: AgentWgpuCtx, node: GraphNode): void {
  const arr = resolveInputArray(ctx, node, 'array');
  if (!arr) return; // no array wired → body + done skipped (JS parity)
  const wt = arr.elemType === 'f32' ? 'f32' : arr.elemType === 'i32' ? 'i32' : 'bool';
  const fi = fresh(ctx, 'fei'), elem = fresh(ctx, 'feElem');
  ctx.lines.push(`  for (var ${fi}: i32 = 0; ${fi} < ${arr.lenName}; ${fi} = ${fi} + 1) {`);
  ctx.lines.push(`    let ${elem}: ${wt} = ${arrLoad(arr, fi)};`);
  ctx.forEachStack.push({ nodeId: node.id, elemName: elem, idxName: fi, elemType: arr.elemType });
  clearVolatileCache(ctx);
  compileFlowChain(ctx, node.id, 'body');
  ctx.forEachStack.pop();
  ctx.lines.push(`  }`);
  clearVolatileCache(ctx);
}

/** Drop cached values + array-refs for volatile nodes so they re-emit at the next
 *  use (re-fill the scratch slot per forEach iteration). */
function clearVolatileCache(ctx: AgentWgpuCtx): void {
  for (const k of [...ctx.valueCache.keys()]) {
    const nid = k.slice(0, k.lastIndexOf(':'));
    if (ctx.volatileNodes.has(nid)) ctx.valueCache.delete(k);
  }
  for (const k of [...ctx.arrayCache.keys()]) {
    const nid = k.slice(0, k.lastIndexOf(':'));
    if (ctx.volatileNodes.has(nid)) ctx.arrayCache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Volatility analysis — mirrors agentWasm: a node is volatile iff it transitively
// reads a forEach element/index (don't cache across a forEach iteration).
// ---------------------------------------------------------------------------

/** Node types whose value output is IMPURE / stateful / array / per-iteration, so
 *  they must NOT be hoisted to function-top by preEmitAgentValues (they stay inline
 *  / re-emit per branch / per forEach iteration). Everything else (math / compare /
 *  field reads / model attrs / SoA reads) is pure within a step and safe to hoist. */
const AGENT_VALUE_NO_HOIST: ReadonlySet<string> = new Set<string>([
  'getRandom',                              // RNG side effect (per-branch draw)
  'createAgent',                            // alloc side effect — handle emits at its flow position
  'getVariable',                            // mutable Local Variable storage
  'getAgentAttribute',                      // a neighbour write can mutate it
  'getIndicator',                           // mutable indicator storage
  'forEachInArray', 'forEachBond', 'loop',  // per-iteration element/index refs
  // array producers (use scratch — emitted via compileArrayNode, not here)
  'getNearbyAgents', 'getAgentsInView', 'getAgentsAttribute', 'filterAgents', 'joinAgents',
  'pickNRandomAgents', 'pickRandomAgent', 'getBondedAgents',
  // aggregate/group* read array scratch (their fold is fine inline at use site)
  'aggregate', 'groupOperator', 'groupCounting', 'groupStatement',
  // arrayElement/arrayLength may read array-var/producer scratch — keep inline
  'arrayElement', 'arrayLength',
]);

/** Pre-emit the PURE, non-volatile value cone of the behaviour flow tree at
 *  function-top scope (so cross-branch pure values are declared in a dominating
 *  scope — WGSL is block-scoped). Walks every flow node's value inputs (DAG), and
 *  for each source that is pure (not in AGENT_VALUE_NO_HOIST) and non-volatile and
 *  whose entire input cone is also hoistable, calls compileValueNode at top. Does
 *  NOT descend into forEach/forEachBond BODIES (those flow-outputs carry
 *  per-iteration values). Idempotent via the value cache. */
function preEmitAgentValues(ctx: AgentWgpuCtx, rootId: string): void {
  const { nodeMap, inputToSource, inputToSources, flowOutputToTargets } = ctx.adj;
  // The set of OUTPUT ports each node actually feeds (so a multi-output value node
  // like getSelfPosition / fieldGradient / colorScale pre-emits exactly the ports
  // that cross branches — a single compileValueNode caches the others anyway, but
  // a multi-output whose `value` default differs from the consumed port needs the
  // consumed port emitted at top). Built from inputToSource/inputToSources (the
  // source port is the producer's output port).
  const usedOutPorts = new Map<string, Set<string>>();
  const addOut = (nodeId: string, portId: string) => {
    let set = usedOutPorts.get(nodeId); if (!set) { set = new Set(); usedOutPorts.set(nodeId, set); }
    set.add(portId);
  };
  for (const [, src] of inputToSource) addOut(src.nodeId, src.portId);
  for (const [, srcs] of inputToSources) for (const s of srcs) addOut(s.nodeId, s.portId);
  // Memoised "is this value node fully hoistable?" (pure + non-volatile + all
  // value inputs hoistable). Cycle-guarded.
  const hoistable = new Map<string, boolean>();
  const inProgress = new Set<string>();
  const isHoistable = (id: string): boolean => {
    const cached = hoistable.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return false; // cycle → not hoistable
    const node = nodeMap.get(id);
    if (!node) return false;
    if (AGENT_VALUE_NO_HOIST.has(node.data.nodeType)) { hoistable.set(id, false); return false; }
    if (ctx.volatileNodes.has(id)) { hoistable.set(id, false); return false; }
    // Hazard-pinned reads emit at their LCA flow position, never at function-top.
    if (ctx.hazardPinned.has(id)) { hoistable.set(id, false); return false; }
    inProgress.add(id);
    let ok = true;
    for (const [key, src] of inputToSource) {
      if (!key.startsWith(`${id}:`)) continue;
      if (!isHoistable(src.nodeId)) { ok = false; break; }
    }
    if (ok) for (const [key, srcs] of inputToSources) {
      if (!key.startsWith(`${id}:`)) continue;
      for (const s of srcs) if (!isHoistable(s.nodeId)) { ok = false; break; }
      if (!ok) break;
    }
    inProgress.delete(id);
    hoistable.set(id, ok);
    return ok;
  };
  // Pre-emit every hoistable node in a value cone (a non-hoistable node still has
  // hoistable SUB-sources — e.g. `compare(getRandom, expression(readCellsUnder))`:
  // the compare + expression aren't hoistable (getRandom taints them) but the
  // readCellsUnder IS, and IT is what crosses branches). Recurse the value DAG and
  // emit each hoistable node once.
  const emitConeVisited = new Set<string>();
  const emitCone = (nodeId: string) => {
    if (emitConeVisited.has(nodeId)) return;
    emitConeVisited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node) return;
    if (isHoistable(nodeId)) {
      const ports = usedOutPorts.get(nodeId);
      if (ports && ports.size > 0) for (const p of ports) compileValueNode(ctx, nodeId, p);
      else compileValueNode(ctx, nodeId, 'value');
    }
    // Recurse into the value inputs regardless (a non-hoistable node guards a
    // hoistable sub-cone). Stop at forEach element / array producers — their
    // outputs are per-iteration / scratch, never top-hoistable.
    if (AGENT_VALUE_NO_HOIST.has(node.data.nodeType) && (node.data.nodeType === 'forEachInArray' || node.data.nodeType === 'forEachBond')) return;
    for (const [key, src] of inputToSource) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      emitCone(src.nodeId);
    }
    for (const [key, srcs] of inputToSources) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      for (const s of srcs) emitCone(s.nodeId);
    }
  };
  // Walk the flow tree (NOT into forEach/forEachBond bodies) → for every flow
  // node's value-input cone, pre-emit the hoistable nodes.
  const visited = new Set<string>();
  const walk = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node) return;
    for (const [key, src] of inputToSource) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      emitCone(src.nodeId);
    }
    for (const [key, srcs] of inputToSources) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      for (const s of srcs) emitCone(s.nodeId);
    }
    const skipPort = (node.data.nodeType === 'forEachInArray' || node.data.nodeType === 'forEachBond') ? 'body' : null;
    for (const [key, targets] of flowOutputToTargets) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const port = key.slice(nodeId.length + 1);
      if (skipPort && port === skipPort) continue;
      for (const t of targets) walk(t.nodeId);
    }
  };
  walk(rootId);
}

function computeVolatile(ctx: AgentWgpuCtx, extraSeeds?: Set<string>): void {
  const { nodeMap, inputToSource } = ctx.adj;
  // extraSeeds = the async read-after-write hazard reads (shared analyzer) —
  // pinned to re-emit at use so a "Set Attribute → read later in flow" shape
  // reads post-write like JS/WASM instead of a hoisted stale snapshot.
  const volatileSet = new Set<string>(extraSeeds ?? []);
  for (const [, node] of nodeMap) if (node.data.nodeType === 'forEachInArray' || node.data.nodeType === 'forEachBond' || node.data.nodeType === 'loop') volatileSet.add(node.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, node] of nodeMap) {
      if (volatileSet.has(node.id)) continue;
      for (const [key, src] of inputToSource) {
        if (!key.startsWith(`${node.id}:`)) continue;
        if (volatileSet.has(src.nodeId)) { volatileSet.add(node.id); changed = true; break; }
      }
    }
  }
  ctx.volatileNodes = volatileSet;
}

// ---------------------------------------------------------------------------
// The gate + the top-level compile.
// ---------------------------------------------------------------------------

function flattenAgentGraph(nodes: GraphNode[], edges: GraphEdge[], model: CAModel):
  { nodes: GraphNode[]; edges: GraphEdge[]; model: CAModel; error?: string } {
  const expanded = expandMacros(nodes, edges, model);
  if (expanded.error) return { nodes, edges, model, error: expanded.error };
  let n = expanded.nodes, e = expanded.edges;
  ({ nodes: n, edges: e } = collapseReroutes(n, e));
  // Apply Force To Agents (array broadcast) → For Each In Array → Apply Force To
  // Agent (both already supported), so the gate + emitter never see the array node.
  ({ nodes: n, edges: e } = expandForceToAgents(n, e, model));
  // Multi-attribute slot expansion — multi-slot Get/Set Attribute nodes become the
  // single-slot primitives the gate + emitter already handle. See multiAttrExpand.ts.
  ({ nodes: n, edges: e } = expandMultiAttrs(n, e, model));
  // FOV `facing` heading source → Get Self Attribute [vector] → Break Vector → wired
  // heading (BEFORE vector lowering). No-op unless a facing FOV node is used.
  ({ nodes: n, edges: e } = lowerFacingSource(n, e, model));
  // Vector stored-attribute lowering — Get/Set Vector nodes → Make/Break Vector over
  // per-component scalar reads/writes + reassign `model` to the component-expanded
  // agent attrs/variables (the layout expands identically). See vectorAttr.ts.
  ({ nodes: n, edges: e, model } = lowerVectorAttrs(n, e, model));
  // Composite-type lowering — vector / colour nodes become scalar nodes BEFORE
  // the gate + emitter see the graph, so a vector agent model runs on WebGPU.
  ({ nodes: n, edges: e } = expandComposites(n, e, model));
  e = canonicalizeAccessorEdges(n, e, model);
  return { nodes: n, edges: e, model };
}

/** The set of node ids reachable from the `behaviourStep` root (its `do` flow
 *  chain + every transitive value input). ONLY these nodes are emitted to the
 *  WebGPU behaviour shader — the `divisionEvent` + `agentInit` roots are compiled
 *  SEPARATELY on CPU/JS (target-independent), so a Tissue graph that contains
 *  (e.g.) an `expression` only inside its divisionEvent subtree must NOT make the
 *  gate reject the model. Mirrors how the JS/WASM compilers walk one root at a time. */
function behaviourReachableNodeIds(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const adj = buildAdjacency(nodes, edges);
  const root = nodes.find(x => x.data.nodeType === 'behaviourStep');
  const reached = new Set<string>();
  if (!root) return reached;
  // value-input cone of a node.
  const pullValues = (nodeId: string) => {
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const [key, src] of adj.inputToSource) {
        if (!key.startsWith(`${id}:`)) continue;
        if (!reached.has(src.nodeId)) { reached.add(src.nodeId); stack.push(src.nodeId); }
      }
    }
  };
  // flow walk from the root (depth-first over every flow output port).
  const visitFlow = new Set<string>();
  const walkFlow = (nodeId: string) => {
    if (visitFlow.has(nodeId)) return;
    visitFlow.add(nodeId);
    reached.add(nodeId);
    pullValues(nodeId);
    for (const [key, targets] of adj.flowOutputToTargets) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      for (const t of targets) walkFlow(t.nodeId);
    }
  };
  walkFlow(root.id);
  return reached;
}

/** TRUE iff the (flattened) agent graph is entirely emittable to WGSL. Mirrors
 *  `isAgentGraphWasmSupported`; 3D agents (worldDepth>1) DO run on WebGPU (the
 *  z fields + 3×3×3 hash + 3D force pass are emitted). The remaining WebGPU
 *  rejects are the genuine parallelism fundamentals (median / uniform-random,
 *  toggle/next/previous indicators) + the array-producer capacity gate. */
export function isAgentGraphWebGPUSupported(model: CAModel | undefined | null): boolean {
  if (!model || !model.topologyMode?.agents) return false;
  const nodes = model.agentGraphNodes ?? [];
  const edges = model.agentGraphEdges ?? [];
  if (!nodes.some(n => n.data.nodeType === 'behaviourStep')) return false;
  const flat = flattenAgentGraph(nodes, edges, model);
  if (flat.error) return false;

  // ONLY the behaviour-reachable nodes are emitted to the WebGPU shader (the
  // divisionEvent + agentInit roots are compiled separately on CPU/JS — G4). So
  // a Tissue graph whose divisionEvent subtree uses a node the shader can't emit
  // (e.g. an extra setAttribute on a daughter) still runs on WebGPU. Macros are
  // already flattened, so a leftover macro boundary node is a structural error.
  const reachable = behaviourReachableNodeIds(flat.nodes, flat.edges);
  const reachNodes = flat.nodes.filter(n => reachable.has(n.id));

  let arrayProducerCount = 0;
  for (const n of reachNodes) {
    const t = n.data.nodeType;
    if (t === 'macroInput' || t === 'macroOutput' || t === 'macro') return false;
    if (!AGENT_WEBGPU_SUPPORTED_TYPES.has(t)) return false;
    const cfg = (n.data.config ?? {}) as Record<string, unknown>;
    if (isAgentArrayProducer(t)) arrayProducerCount++;
    if (t === 'aggregate') {
      // median / uniform-random need a sort / RNG-pick path the agent shader
      // doesn't have (the lone genuinely-fundamental aggregate cases, same as the
      // lattice WebGPU grid). sum/product/min/max/average/and/or ARE supported.
      let op = (cfg['operation'] as string) || 'sum';
      if (op === 'mul') op = 'product';
      if (op === 'mean') op = 'average';
      if (op === 'median' || op === 'random') return false;
    }
    if (t === 'groupOperator') {
      // Same fundamentals as aggregate: median + uniform random reject (no sort /
      // per-cell pick path). weightedRandom IS supported (cumulative-sum pick).
      const op = (cfg['operation'] as string) || 'sum';
      if (op === 'median' || op === 'random') return false;
    }
    if (t === 'updateIndicator') {
      // toggle/next/previous are order-dependent under parallel writers (the lone
      // node-op-level fundamental, same as the lattice WebGPU grid). inc/dec/max/
      // min/or/and ARE supported via atomics.
      const op = (cfg['operation'] as string) || 'increment';
      if (op === 'toggle' || op === 'next' || op === 'previous') return false;
    }
    if (t === 'statement') {
      // between/notBetween now EMIT (emitCompare's between path) — no reject.
      // Non-numerical compareTypes (bool/tag compare small exact ints — fine in
      // f32; neighborIndex has no agent sources) also emit via the same ==/!=.
      const compareType = cfg['compareType'] as string | undefined;
      if (compareType === 'neighborIndex') return false;   // lattice-only value type
    }
    // getRandom options mode now EMITS (multi-scalar if/else chain or a single
    // array-producer pick) — no reject.
    // setCellLooks glyph mode: the AGENT render path (drawAgentsOverlay) draws
    // filled circles only — NO glyph overlay on ANY target. On JS/WASM a glyph
    // setCellLooks writes the per-AGENT glyph buffer, which for agents is the
    // length-0 GLYPH_NOOP buffer (a silently-dropped write) — i.e. a no-op. So a
    // glyph setCellLooks is HARMLESS, not a fundamental: it must NOT clamp the
    // model to JS. emitSetCellLooks writes the background colour when
    // setBackground (matching JS) and skips the glyph codepoint write (the
    // agent SoA has no glyph buffers — same no-op as JS/WASM, so cross-target
    // parity is preserved). No reject here.
    // The field bridge (sample/affect/secrete/etc.) now emits a 3D trilinear /
    // r-sphere path when gridDepth>1 (gap C), so a 3D field model runs on WebGPU
    // too — no field-in-3D clamp remains.
  }
  if (arrayProducerCount > AGENT_WEBGPU_NEARBY_SLOTS) return false;
  // Every array input (forEachInArray.array / aggregate|group*.values / pick*.agents
  // / getAgentsAttribute|setAgentsAttribute.agents / filter/join inputs) must come
  // from an agent-array producer OR an array Local Variable (the array tier never
  // sees a non-producer non-variable array source).
  const map = new Map(reachNodes.map(n => [n.id, n] as const));
  const ARRAY_INPUT_PORTS = new Set(['array', 'values', 'agents', 'a', 'b']);
  for (const e of flat.edges) {
    const tgt = parseHandle(e.targetHandle);
    if (!tgt || tgt.category !== 'value' || !ARRAY_INPUT_PORTS.has(tgt.portId)) continue;
    const consumer = map.get(e.target);
    if (!consumer) continue;
    const ct = consumer.data.nodeType;
    // Only the agent-array consumers gate their array inputs (a scalar node with a
    // coincidental 'a'/'b' port — e.g. logicOperator.a/b — is NOT array-typed).
    const isArrayConsumer = ct === 'forEachInArray'
      || ((ct === 'aggregate' || ct === 'groupOperator' || ct === 'groupCounting' || ct === 'groupStatement') && tgt.portId === 'values')
      || (ct === 'pickRandomAgent' && tgt.portId === 'agents')
      || (ct === 'pickNRandomAgents' && tgt.portId === 'agents')
      || (ct === 'getAgentsAttribute' && tgt.portId === 'agents')
      || (ct === 'setAgentsAttribute' && tgt.portId === 'agents')
      || (ct === 'filterAgents' && tgt.portId === 'agents')
      || (ct === 'joinAgents' && (tgt.portId === 'a' || tgt.portId === 'b'))
      || (ct === 'arrayElement' && tgt.portId === 'array')
      || (ct === 'arrayLength' && tgt.portId === 'array');
    if (!isArrayConsumer) continue;
    const srcNode = map.get(e.source);
    if (!srcNode) continue;
    // Array Local Variable (a getVariable on an array variable) is a valid array
    // source for arrayElement / arrayLength / forEach.
    const isArrayVarSrc = srcNode.data.nodeType === 'getVariable'
      && (model.agentVariables ?? []).some(v => v.id === (srcNode.data.config?.['variableId'] as string) && v.kind === 'array');
    if (!isAgentArrayProducer(srcNode.data.nodeType) && !isArrayVarSrc) return false;
  }
  return true;
}

/** Encode a scalar Variable's initialValue → number. */
function variableInitNum(v: { dataType: string; initialValue?: string }): number {
  const r = v.initialValue ?? '0';
  if (v.dataType === 'bool') return (r === 'true' || r === '1') ? 1 : 0;
  const n = Number(r);
  return Number.isFinite(n) ? n : 0;
}

/** The Control uniform struct — the per-step scalars the worker writes before
 *  each dispatch (G3). `highWater` is here (NOT a baked literal). */
function emitControlStruct(): string {
  return `struct Control {
  highWater  : u32,
  maxAgents  : u32,
  hashValid  : u32,
  nBinsX     : u32,
  nBinsY     : u32,
  fieldTorus : u32,
  binSizeX   : f32,
  binSizeY   : f32,
  fieldW     : f32,
  fieldH     : f32,
  maxBonds   : u32,
  nBinsZ     : u32,
  binSizeZ   : f32,
  fieldD     : f32,
  originX    : f32,
  originY    : f32,
  originZ    : f32,
  _pad0      : f32,
};`;
}

/** The field-bridge WGSL helpers (G5): a cell-centered bilinear (2D) / trilinear
 *  (3D) READ of the read-only `fieldRead` snapshot, and an f32-bitcast atomic-CAS
 *  deposit into `fieldDeposit` (set/sub/max/min/add per opcode) so parallel agents
 *  writing the same cell don't race. `base` is the attr's element offset in the
 *  buffer. The 3D `fieldSampleTrilinear` mirrors SampleFieldNode's 8-corner read
 *  (index = (z·H + y)·W + x). 2D models emit ONLY the bilinear helper (byte-
 *  identical to pre-3D); 3D models emit ONLY the trilinear one (the field nodes
 *  call `fieldSampleField(base, px, py)` either way — see emitFieldSampleCall). */
/** The Apply Force To Agent scatter helper — a commutative f32-bitcast atomic-CAS
 *  accumulate into `forceScatter` (parallel agents scatter onto the same target;
 *  the force pass reads the summed result). Same CAS shape as fieldDepositCell's
 *  add path. Emitted once, only when a graph uses Apply Force To Agent. */
function emitForceScatterHelper(): string {
  return `fn forceScatterAdd(ci: u32, v: f32) {
  loop {
    let oldBits: u32 = atomicLoad(&forceScatter[ci]);
    let nv: f32 = bitcast<f32>(oldBits) + v;
    let res = atomicCompareExchangeWeak(&forceScatter[ci], oldBits, bitcast<u32>(nv));
    if (res.exchanged) { break; }
  }
}`;
}

function emitFieldHelpers(is3d: boolean): string {
  const deposit = `fn fieldDepositCell(ci: u32, v: f32, op: u32) {
  // op: 0=set, 1=subtract, 2=max, 3=min, 4=add. f32-bitcast CAS loop.
  loop {
    let oldBits: u32 = atomicLoad(&fieldDeposit[ci]);
    let oldV: f32 = bitcast<f32>(oldBits);
    var nv: f32 = oldV + v;
    if (op == 0u) { nv = v; }
    else if (op == 1u) { nv = oldV - v; }
    else if (op == 2u) { nv = max(oldV, v); }
    else if (op == 3u) { nv = min(oldV, v); }
    let res = atomicCompareExchangeWeak(&fieldDeposit[ci], oldBits, bitcast<u32>(nv));
    if (res.exchanged) { break; }
  }
}`;
  if (is3d) {
    // Trilinear (8-corner) sample at the agent's continuous (px, py, agentZ).
    // agentZ is fetched per call (the field nodes pass it through `pz`).
    return `fn fieldSampleTrilinear(base: u32, px: f32, py: f32, pz: f32) -> f32 {
  let W: i32 = i32(control.fieldW); let H: i32 = i32(control.fieldH); let D: i32 = i32(control.fieldD);
  var x0: i32 = i32(floor(px)); var y0: i32 = i32(floor(py)); var z0: i32 = i32(floor(pz));
  let tx: f32 = px - f32(x0); let ty: f32 = py - f32(y0); let tz: f32 = pz - f32(z0);
  var x1: i32 = x0 + 1; var y1: i32 = y0 + 1; var z1: i32 = z0 + 1;
  if (control.fieldTorus != 0u) {
    x0 = ((x0 % W) + W) % W; x1 = ((x1 % W) + W) % W;
    y0 = ((y0 % H) + H) % H; y1 = ((y1 % H) + H) % H;
    z0 = ((z0 % D) + D) % D; z1 = ((z1 % D) + D) % D;
  } else {
    x0 = clamp(x0, 0, W - 1); x1 = clamp(x1, 0, W - 1);
    y0 = clamp(y0, 0, H - 1); y1 = clamp(y1, 0, H - 1);
    z0 = clamp(z0, 0, D - 1); z1 = clamp(z1, 0, D - 1);
  }
  let uW: u32 = u32(W); let uWH: u32 = u32(W) * u32(H);
  let c000: f32 = fieldRead[base + u32(z0) * uWH + u32(y0) * uW + u32(x0)];
  let c100: f32 = fieldRead[base + u32(z0) * uWH + u32(y0) * uW + u32(x1)];
  let c010: f32 = fieldRead[base + u32(z0) * uWH + u32(y1) * uW + u32(x0)];
  let c110: f32 = fieldRead[base + u32(z0) * uWH + u32(y1) * uW + u32(x1)];
  let c001: f32 = fieldRead[base + u32(z1) * uWH + u32(y0) * uW + u32(x0)];
  let c101: f32 = fieldRead[base + u32(z1) * uWH + u32(y0) * uW + u32(x1)];
  let c011: f32 = fieldRead[base + u32(z1) * uWH + u32(y1) * uW + u32(x0)];
  let c111: f32 = fieldRead[base + u32(z1) * uWH + u32(y1) * uW + u32(x1)];
  let c00: f32 = c000 * (1.0 - tx) + c100 * tx;
  let c10: f32 = c010 * (1.0 - tx) + c110 * tx;
  let c01: f32 = c001 * (1.0 - tx) + c101 * tx;
  let c11: f32 = c011 * (1.0 - tx) + c111 * tx;
  let c0: f32 = c00 * (1.0 - ty) + c10 * ty;
  let c1: f32 = c01 * (1.0 - ty) + c11 * ty;
  return c0 * (1.0 - tz) + c1 * tz;
}
${deposit}`;
  }
  return `fn fieldSampleBilinear(base: u32, px: f32, py: f32) -> f32 {
  let W: i32 = i32(control.fieldW); let H: i32 = i32(control.fieldH);
  var x0: i32 = i32(floor(px)); var y0: i32 = i32(floor(py));
  let tx: f32 = px - f32(x0); let ty: f32 = py - f32(y0);
  var x1: i32 = x0 + 1; var y1: i32 = y0 + 1;
  if (control.fieldTorus != 0u) {
    x0 = ((x0 % W) + W) % W; x1 = ((x1 % W) + W) % W;
    y0 = ((y0 % H) + H) % H; y1 = ((y1 % H) + H) % H;
  } else {
    x0 = clamp(x0, 0, W - 1); x1 = clamp(x1, 0, W - 1);
    y0 = clamp(y0, 0, H - 1); y1 = clamp(y1, 0, H - 1);
  }
  let uW: u32 = u32(W);
  let c00: f32 = fieldRead[base + u32(y0) * uW + u32(x0)];
  let c10: f32 = fieldRead[base + u32(y0) * uW + u32(x1)];
  let c01: f32 = fieldRead[base + u32(y1) * uW + u32(x0)];
  let c11: f32 = fieldRead[base + u32(y1) * uW + u32(x1)];
  return c00 * (1.0 - tx) * (1.0 - ty) + c10 * tx * (1.0 - ty)
       + c01 * (1.0 - tx) * ty + c11 * tx * ty;
}
${deposit}`;
}

/** The PCG RNG helpers (per-agent stream keyed by `idx` — the lattice grid model). */
function emitRngHelpers(): string {
  return `fn pcg_hash(input: u32) -> u32 {
  var state: u32 = input * 747796405u + 2891336453u;
  let word: u32 = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rand_advance(cell: u32) -> u32 {
  let prev: u32 = rngState[cell];
  let next: u32 = pcg_hash(prev + 1u);
  rngState[cell] = next;
  return next;
}
fn rand_f32(cell: u32) -> f32 {
  return f32(rand_advance(cell)) * 2.3283064365386963e-10;
}`;
}

/** Compile the agent behaviour graph to a WGSL compute module. Returns
 *  `{ shaderCode, layout }`. On an unsupported graph it returns an empty result +
 *  an error (the worker keeps the JS/WASM path). BEHAVIOUR-ONLY (no division
 *  module — division stays CPU/JS on every target, G4). */
export function compileAgentGraphWebGPU(
  agentNodes: GraphNode[],
  agentEdges: GraphEdge[],
  model: CAModel,
  layout: AgentWebGPULayout,
): AgentWebGPUResult {
  const empty = (error: string): AgentWebGPUResult => ({ shaderCode: '', layout, supportedTypes: [], error });
  if (!model.topologyMode?.agents) return empty('Agents topology not enabled.');

  const flat = flattenAgentGraph(agentNodes, agentEdges, model);
  if (flat.error) return empty(flat.error);
  const nodes = flat.nodes, edges = flat.edges;
  model = flat.model;  // component-expanded (vector agent attrs → scalar floats)
  // Bake the indicator slot + int-flag onto each indicator node (the WebGPU agent
  // compiler is self-sufficient — it does NOT rely on the JS agent pre-resolve).
  preResolveIndicators(nodes, model);

  const behaviourNode = nodes.find(n => n.data.nodeType === 'behaviourStep');
  if (!behaviourNode) return empty('No Behaviour Step node in the agent graph.');

  // Gate (defensive — the caller already checked isAgentGraphWebGPUSupported).
  // ONLY the behaviour-reachable nodes are emitted; the divisionEvent / agentInit
  // roots are compiled separately on CPU/JS (G4), so they're excluded here.
  const reachable = behaviourReachableNodeIds(nodes, edges);
  const seen = new Set<string>();
  let arrayProducerCount = 0;
  for (const n of nodes) {
    if (!reachable.has(n.id)) continue;
    seen.add(n.data.nodeType);
    if (!AGENT_WEBGPU_SUPPORTED_TYPES.has(n.data.nodeType)) return empty(`agentWebgpu: unsupported node '${n.data.nodeType}' (falls back to JS).`);
    if (isAgentArrayProducer(n.data.nodeType)) arrayProducerCount++;
  }
  if (arrayProducerCount > AGENT_WEBGPU_NEARBY_SLOTS) return empty(`agentWebgpu: too many agent-array producers (${arrayProducerCount} > ${AGENT_WEBGPU_NEARBY_SLOTS} slots).`);

  const adj = buildAdjacency(nodes, edges);
  const agentAttrType = new Map<string, string>();
  const agentAttrDefault = new Map<string, number>();
  for (const a of agentAttrsOf(model)) { agentAttrType.set(a.id, a.type); agentAttrDefault.set(a.id, encodeAttrValue(a)); }
  const ctx: AgentWgpuCtx = {
    adj, layout, is3d: layout.gridDepth > 1,
    lines: [], uid: 0,
    agentAttrType, agentAttrDefault,
    varNames: new Map<string, string>(),
    arrayVarNames: new Map<string, { name: string; len: number }>(),
    valueCache: new Map<string, ValueRef>(),
    arrayCache: new Map<string, AgentArrayRef>(),
    volatileNodes: new Set<string>(),
    hazardPinned: new Set<string>(),
    hazardEmitBefore: new Map<string, string[]>(),
    arrayScratchSlot: new Map<string, { slot: number; elemType: WgslType }>(),
    forEachStack: [],
    loopStack: [],
    forEachBondStack: [],
    usesI32Write: false,
    usesBondStore: false, usesIndicators: false, usesAux: false,
    usesSpawn: false,
    usesStop: false,
    usesForceScatter: false,
  };

  // Assign array-producer scratch slots (separate i32 + f32 `var<function>` pools)
  // + name the variables. The agent graph's Local Variables live on
  // `agentVariables` (the separate agent-variable id-space), NOT the cell `variables`.
  let i32Slots = 0, f32Slots = 0;
  for (const n of nodes) {
    if (!reachable.has(n.id) || !isAgentArrayProducer(n.data.nodeType)) continue;
    // getAgentsAttribute → f32 (gathered attr values); all others → i32 (id arrays).
    const elemType: WgslType = n.data.nodeType === 'getAgentsAttribute' ? 'f32' : 'i32';
    if (elemType === 'f32') ctx.arrayScratchSlot.set(n.id, { slot: f32Slots++, elemType });
    else ctx.arrayScratchSlot.set(n.id, { slot: i32Slots++, elemType });
  }
  for (const v of (model.agentVariables ?? [])) {
    const sanitised = `_var${v.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    if (v.kind === 'array') ctx.arrayVarNames.set(v.id, { name: sanitised, len: Math.max(1, Math.floor(Number(v.length) || 1)) });
    else ctx.varNames.set(v.id, sanitised);
  }

  computeVolatile(ctx);

  // Async read-after-write hazards (shared analyzer, SAME eligibility as the
  // JS/WASM agent compilers): the pure-scalar hazard cone is excluded from the
  // function-top hoist and emitted ONCE immediately before the flow node that
  // is the LCA of its uses (computeVolatileHoist — the same positions the JS
  // volatileHoist uses). Nodes already covered by the volatile re-emit or the
  // NO_HOIST at-use mechanisms keep those.
  {
    const hazardSeeds = computeAsyncReadWriteHazards({
      nodeMap: adj.nodeMap,
      inputToSource: adj.inputToSource,
      inputToSources: adj.inputToSources,
      flowOutputToTargets: adj.flowOutputToTargets,
      rootNodeId: behaviourNode.id,
      rootFlowPortId: 'do',
      isAsync: model.centerBased?.agentUpdateMode !== 'sync',
    });
    if (hazardSeeds.size > 0) {
      const consumers = new Map<string, string[]>();
      const addC = (src: string, tgt: string) => { const a = consumers.get(src); if (a) a.push(tgt); else consumers.set(src, [tgt]); };
      for (const [k, src] of adj.inputToSource) { const t = k.split(':')[0]; if (t) addC(src.nodeId, t); }
      for (const [k, srcs] of adj.inputToSources) { const t = k.split(':')[0]; if (t) for (const s of srcs) addC(s.nodeId, t); }
      const cone = new Set<string>();
      const stack = [...hazardSeeds];
      while (stack.length) {
        const id = stack.pop()!;
        if (cone.has(id)) continue;
        cone.add(id);
        for (const c of consumers.get(id) ?? []) stack.push(c);
      }
      for (const id of [...cone]) {
        const n = adj.nodeMap.get(id);
        if (!n) { cone.delete(id); continue; }
        if (ctx.volatileNodes.has(id) || AGENT_VALUE_NO_HOIST.has(n.data.nodeType)) { cone.delete(id); continue; }
        const def = getNodeDef(n.data.nodeType);
        if (!def || def.ports.some(p => p.category === 'flow')) cone.delete(id);
      }
      ctx.hazardPinned = cone;
      ctx.hazardEmitBefore = computeVolatileHoist({
        nodeMap: adj.nodeMap,
        inputToSource: adj.inputToSource,
        inputToSources: adj.inputToSources,
        flowOutputToTargets: adj.flowOutputToTargets,
        rootNodeId: behaviourNode.id,
        rootFlowPortId: 'do',
        volatile: cone,
      }).emitBefore;
    }
  }

  // --- emit the per-agent body ---
  try {
    // reset Local Variables to their initialValue (per agent).
    for (const v of (model.agentVariables ?? [])) {
      if (v.kind === 'array') {
        const av = ctx.arrayVarNames.get(v.id)!;
        const init = wgslFloatLit(variableInitNum(v));
        const aiL = `_avi${v.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        ctx.lines.push(`  for (var ${aiL}: i32 = 0; ${aiL} < ${av.len}; ${aiL} = ${aiL} + 1) { ${av.name}[${aiL}] = ${init}; }`);
      } else {
        ctx.lines.push(`  ${ctx.varNames.get(v.id)!} = ${wgslFloatLit(variableInitNum(v))};`);
      }
    }
    // Pre-emit the PURE, non-volatile value cone of the behaviour root at
    // function-top scope. WGSL `let`/`var` are block-scoped, so a pure value read
    // in MULTIPLE sibling branches (e.g. a readCellsUnder result tested in both a
    // switch case AND the default) must be declared in a dominating scope — else
    // the cache returns a name declared inside the first branch and the sibling
    // branch sees an "unresolved value". Pre-emitting at top makes the cache serve
    // every branch. Skipped: volatile (forEach-element-derived) values + RNG /
    // array-producer / mutable-storage reads (those stay inline / per-iteration).
    preEmitAgentValues(ctx, behaviourNode.id);
    compileFlowChain(ctx, behaviourNode.id, 'do');
  } catch (e) {
    return empty(String((e as Error)?.message || e));
  }

  // --- assemble the WGSL module ---
  // Array-producer scratch pools: one `var<function>` array per assigned slot
  // (`arri32<n>` for id arrays, `arrf32<n>` for gathered value arrays).
  const nearbyDecls: string[] = [];
  for (let i = 0; i < i32Slots; i++) {
    nearbyDecls.push(`  var<function> arri32${i}: array<i32, ${layout.maxAgents}>;`);
  }
  for (let i = 0; i < f32Slots; i++) {
    nearbyDecls.push(`  var<function> arrf32${i}: array<f32, ${layout.maxAgents}>;`);
  }
  const varDecls: string[] = [];
  for (const v of (model.agentVariables ?? [])) {
    if (v.kind === 'array') {
      const av = ctx.arrayVarNames.get(v.id)!;
      varDecls.push(`  var<function> ${av.name}: array<f32, ${av.len}>;`);
    } else {
      varDecls.push(`  var<function> ${ctx.varNames.get(v.id)!}: f32 = 0.0;`);
    }
  }

  // Field bridge bindings (G5) — only present when the model has agent-accessible
  // cell attrs (so a no-field Boids shader stays byte-identical: no field bindings,
  // no field helpers). fieldRead (binding 7) is the read-only snapshot; fieldDeposit
  // (binding 8) is the atomic deposit accumulator (present only with write attrs).
  const hasFieldRead = layout.fieldReadLen > 0;
  const hasFieldWrite = layout.fieldWriteLen > 0;
  const fieldBindingLines: string[] = [];
  if (hasFieldRead) fieldBindingLines.push('@group(0) @binding(7) var<storage, read>       fieldRead    : array<f32>;');
  if (hasFieldWrite) fieldBindingLines.push('@group(0) @binding(8) var<storage, read_write> fieldDeposit : array<atomic<u32>>;');
  // Universal-node bindings (Generic Agent Platform) — appended after the field
  // bindings. Declared ONLY when an emitter actually REFERENCED the binding (NOT
  // merely when the layout reserved the region): a global declared but unused is
  // stripped by Naga, so its bind-group entry would mismatch the pipeline's
  // reflected layout (the GoL-on-agents all-die bug — maxBonds>0 reserved a bond
  // store that the totalistic rule never touches). The runtime reads the SAME
  // usage flags (shipped on the result) to bind matching entries.
  const hasAux = ctx.usesAux && layout.auxF32Len > 0;             // model attrs + lookup tables
  const hasIndicators = ctx.usesIndicators && layout.indicatorCount > 0;  // indicators atomic buffer
  const hasBondStore = ctx.usesBondStore && layout.bondStoreLen > 0;     // ragged bond store
  if (hasAux) fieldBindingLines.push('@group(0) @binding(9) var<storage, read>       auxF32      : array<f32>;');
  if (hasIndicators) fieldBindingLines.push('@group(0) @binding(10) var<storage, read_write> indicators : array<atomic<u32>>;');
  if (hasBondStore) fieldBindingLines.push('@group(0) @binding(11) var<storage, read>       bondStore   : array<i32>;');
  // Mid-step spawning (Create Agent / Add To World): an atomic bump allocator into
  // a single-word storage buffer. Declared ONLY when the graph spawns (else Naga
  // strips it → a bind-group mismatch, like the other universal bindings).
  const hasSpawn = ctx.usesSpawn;
  if (hasSpawn) fieldBindingLines.push('@group(0) @binding(12) var<storage, read_write> spawnCursor : atomic<u32>;');
  // Stop Event flag (binding 13) — a single-word atomic; declared ONLY when a Stop
  // Event emitter ran (else Naga strips it → a bind-group mismatch).
  const hasStop = ctx.usesStop;
  if (hasStop) fieldBindingLines.push('@group(0) @binding(13) var<storage, read_write> stopFlag    : atomic<u32>;');
  // Apply Force To Agent (binding 14) — the cross-agent force-scatter atomic
  // accumulator (f32-bitcast). Declared ONLY when an emitter ran (else Naga strips
  // it → a bind-group mismatch, like the other universal bindings).
  const hasForceScatter = ctx.usesForceScatter;
  if (hasForceScatter) fieldBindingLines.push('@group(0) @binding(14) var<storage, read_write> forceScatter : array<atomic<u32>>;');
  // Each carries its OWN leading newline so the no-extra case inserts NOTHING (a
  // no-field Boids shader is then byte-identical to the pre-G5 template).
  const fieldBindings = fieldBindingLines.length > 0 ? '\n' + fieldBindingLines.join('\n') : '';
  const fieldHelpers = (hasFieldRead || hasFieldWrite) ? '\n' + emitFieldHelpers(ctx.is3d) : '';
  const forceScatterHelper = hasForceScatter ? '\n' + emitForceScatterHelper() : '';
  // agentI32 is read_write ONLY when a setAgentType wrote it (the worker selects
  // the matching bind-group layout from the result's `usesI32Write` flag).
  const i32Access = ctx.usesI32Write ? 'read_write' : 'read      ';

  const shaderCode = `${emitControlStruct()}

@group(0) @binding(0) var<storage, read_write> agentF32    : array<f32>;
@group(0) @binding(1) var<storage, ${i32Access}> agentI32    : array<i32>;
@group(0) @binding(2) var<storage, ${hasSpawn ? 'read_write' : 'read      '}> agentAlive  : array<u32>;
@group(0) @binding(3) var<storage, read>       hashBins    : array<i32>;
@group(0) @binding(4) var<uniform>             control     : Control;
@group(0) @binding(5) var<storage, read_write> rngState    : array<u32>;
@group(0) @binding(6) var<storage, read_write> agentColors : array<u32>;${fieldBindings}

${emitRngHelpers()}${fieldHelpers}${forceScatterHelper}

@compute @workgroup_size(64)
fn behaviour(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let idx: u32 = gid.y * (nwg.x * 64u) + gid.x;
  if (idx >= control.highWater) { return; }
  if (agentAlive[idx] == 0u) { return; }
  let colorIdx: u32 = idx * 4u;
${nearbyDecls.join('\n')}
${varDecls.join('\n')}
${ctx.lines.join('\n')}
}
`;

  return {
    shaderCode, layout, supportedTypes: [...seen], usesI32Write: ctx.usesI32Write,
    usesBondStore: hasBondStore, usesIndicators: hasIndicators, usesAux: hasAux,
    usesSpawn: hasSpawn, usesStop: hasStop, usesForceScatter: hasForceScatter,
  };
}

/** Bake `_indicatorIdx` + `_indicatorIsInt` onto each indicator node (the agent
 *  WebGPU compiler is self-sufficient — it does NOT depend on the JS agent
 *  pre-resolve running first). The slot is the index into the model's indicator
 *  list (the SAME order the worker uploads the indicators buffer). */
function preResolveIndicators(nodes: GraphNode[], model: CAModel): void {
  const inds = model.indicators ?? [];
  const slotOf = new Map<string, number>();
  inds.forEach((ind, i) => slotOf.set(ind.id, i));
  const isIntOf = new Map<string, boolean>();
  for (const ind of inds) {
    isIntOf.set(ind.id, ind.kind === 'standalone' && (ind.dataType === 'integer' || ind.dataType === 'tag'));
  }
  for (const n of nodes) {
    if (n.data.nodeType !== 'getIndicator' && n.data.nodeType !== 'setIndicator' && n.data.nodeType !== 'updateIndicator') continue;
    const id = (n.data.config?.['indicatorId'] as string) || '';
    const slot = slotOf.get(id);
    if (slot === undefined) continue;
    n.data.config = { ...(n.data.config ?? {}), _indicatorIdx: slot, _indicatorIsInt: isIntOf.get(id) === true };
  }
}

/** Build the field-bridge layout spec from a model (G5) — the ordered
 *  agent-accessible cell-attr id lists + grid dims, mirroring the compiler's
 *  `cellFieldAttrsOf` / `cellFieldWriteAttrsOf` (= the worker's `fieldSpecs`). 3D
 *  passes gridDepth so the field index becomes layer·W·H + row·W + col. */
export function agentWebGPUFieldSpecOf(model: CAModel) {
  const is3d = is3dModel(model);
  return {
    readAttrs: cellFieldAttrsOf(model).map(a => a.id),
    writeAttrs: cellFieldWriteAttrsOf(model).map(a => a.id),
    gridWidth: Math.max(1, Math.floor((model.properties.gridWidth as number) || 100)),
    gridHeight: Math.max(1, Math.floor((model.properties.gridHeight as number) || 100)),
    gridDepth: is3d ? Math.max(1, Math.floor((model.properties.gridDepth as number) || 1)) : 1,
  };
}

/** Build the universal-node `AgentWebGPUExtras` for a model — the model-attribute
 *  keys (scalar + the 3 color sub-keys), the lookup-table dims, the indicator
 *  count, the bond capacity, and the world depth. */
export function agentWebGPUExtrasOf(model: CAModel) {
  // Slot list via the shared `modelAttrSlotKeys` (colour → r/g/b/a) — the
  // layout-lockstep invariant, see attributeScope.ts. This site has historically
  // NOT filtered `lookupTable`; that is preserved deliberately, since dropping the
  // slot would shift every later attribute's offset here but not elsewhere.
  const modelAttrKeys: string[] = [];
  for (const a of model.attributes ?? []) {
    if (!a.isModelAttribute) continue;
    modelAttrKeys.push(...modelAttrSlotKeys(a));
  }
  const lookupTables: Array<{ id: string; rowCount: number; colCount: number; dims?: number[]; mins?: number[] }> = [];
  for (const a of model.attributes ?? []) {
    if (a.type !== 'lookupTable') continue;
    if (isMultiAxisTable(a)) {
      // Multi-axis: geometry via resolveAxes (layout-lockstep with the CPU
      // store + the emitter — one resolution).
      const r = resolveAxes(a, model);
      lookupTables.push({ id: a.id, rowCount: r.dims[0] ?? 1, colCount: r.dims[1] ?? 1, dims: r.dims, mins: r.mins });
    } else {
      const rowCount = Math.max(1, resolveKeyLabels(a.rowKeySource, model).length);
      const colCount = Math.max(1, resolveKeyLabels(a.colKeySource, model).length);
      lookupTables.push({ id: a.id, rowCount, colCount });
    }
  }
  const indicatorCount = (model.indicators ?? []).length;
  // STEP 3: use the PROFILE-AWARE resolver (Bonds=off ⇒ 0) so the GPU agent
  // layout's bond stride matches the CPU store + the WASM layout (all via
  // resolveMaxBonds). A direct `centerBased.maxBonds` read here would desync a
  // Bonds=off model (store 0 vs GPU 2).
  const maxBonds = resolveMaxBonds(model.centerBased);
  const gridDepth = is3dModel(model) ? Math.max(1, Math.floor((model.properties.gridDepth as number) || 1)) : 1;
  return { modelAttrKeys, lookupTables, indicatorCount, maxBonds, gridDepth };
}

/** Convenience for the DEV harness: derive the GPU agent layout from a model +
 *  compile. Mirrors `compileAgentGraphWasmForModel`. */
export function compileAgentGraphWebGPUForModel(model: CAModel): AgentWebGPUResult {
  const cfg = model.centerBased;
  const layout = computeAgentWebGPULayout(
    Math.max(1, Math.floor((cfg?.maxAgents as number) ?? 2000)),
    agentMaxHashBinsForModelGPU(model),
    agentWebGPUFieldSpecOf(model),
    // Expand vector agent attrs into scalar-float components (the SoA runs must
    // match the worker's + the compiler's per-component reads) — ABI-mirror.
    expandVectorAttributes(agentAttrsOf(model)).map(a => a.id),
    agentWebGPUExtrasOf(model),
  );
  if (!cfg) return { shaderCode: '', layout, supportedTypes: [], error: 'No centerBased config.' };
  return compileAgentGraphWebGPU(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, layout);
}

/** The per-model max hash-bin reserve (same bound the WASM path uses). */
function agentMaxHashBinsForModelGPU(model: CAModel): number {
  const cfg = model.centerBased;
  const W = (model.properties.gridWidth as number) || 100;
  const H = (model.properties.gridHeight as number) || 100;
  // The agent world depth IS the grid depth (1:1, B2) — 3D only when is3dModel.
  const D = is3dModel(model) ? Math.max(1, Math.floor((model.properties.gridDepth as number) || 1)) : 1;
  const range = (cfg?.interactionRange as number) ?? 1.5;
  const dr = (cfg?.defaultRadius as number) ?? 0.5;
  const nq = (cfg?.neighbourQueryRadius as number) ?? 5;
  const minEdge = Math.max(1e-3, range * 2 * dr, nq);
  const nx = Math.max(1, Math.floor(W / minEdge));
  const ny = Math.max(1, Math.floor(H / minEdge));
  // The Z axis MUST be counted in 3D (mirrors computeAgentMaxHashBins) — without
  // nz the reserve undersizes the 3×3×3 hash and every step overflows → JS
  // fallback (the 3D-field-bridge bug). 2D (D=1) → nz=1 → byte-identical reserve.
  const nz = D > 1 ? Math.max(1, Math.floor(D / minEdge)) : 1;
  return Math.min(1 << 20, nx * ny * nz);
}
