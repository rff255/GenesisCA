// ===========================================================================
// PR7 / G1+G2 — the SEPARATE WebGPU AGENT-LOOP compiler.
//
// A self-contained agent-WebGPU compiler whose per-agent behaviour pass is a
// WGSL compute shader over the GPU agent SoA (`agentWebgpu/layout.ts`). It is the
// GPU sibling of `agentWasm/compile.ts`: the SAME front-end pipeline (macro-
// expand → reroute-collapse → accessor-CSE), the SAME honest central gate
// (`isAgentGraphWebGPUSupported`), and the SAME Boids node subset — but it emits
// WGSL instead of WASM bytes.
//
// G1 — the skeleton: one invocation per agent slot, `dispatchCells(maxAgents,64)`
//      2-D tiling (the lattice grid pattern), `highWater` a CONTROL UNIFORM (not a
//      baked literal — baking forces a per-gen recompile), the alive-skip + the
//      `idx >= highWater` guard.
// G2 — the behaviour shader: universal nodes (arithmetic / compare / logic /
//      conditional / getConstant / getRandom / expression / Local Variables)
//      routed through f32-string emit (reusing the lattice `emitWgsl`); the ~12
//      agent-node WGSL emitters (getSelfPosition/getRadius/getNearbyAgents/
//      getAgentOffset/getVelocity/getAgentPosition/getAgentRadius/applyForce/
//      setTargetRadius/setVariable/forEachInArray). Per-agent PCG RNG keyed by
//      `idx` (the lattice per-cell PCG — statistical parity, NOT bit-exact, the
//      documented WebGPU target constraint).
//
// HARD CONSTRAINT: this compiler touches NO lattice/grid WebGPU code and NO
// existing agent JS/WASM path — it is wholly additive, so lattice + JS-agent +
// WASM-agent byte-identity holds BY CONSTRUCTION.
//
// SCOPE (mirrors AGENT_WASM_SUPPORTED_TYPES — the Boids subset):
//   roots/reads/writes : behaviourStep, getSelfPosition, getRadius,
//                        applyForce, setTargetRadius
//   neighbour access   : getNearbyAgents (the hash stencil → a per-thread id
//                        array), forEachInArray, getAgentOffset, getVelocity,
//                        getAgentPosition, getAgentRadius
//   local variables    : getVariable / setVariable (SCALAR only)
//   value/flow utility : getConstant, arithmeticOperator, expression, statement,
//                        logicOperator, getRandom, conditional, sequence
// Everything else FALLS BACK to JS via `isAgentGraphWebGPUSupported`.
//
// CONSTRAINTS (documented): agents are always SYNC (single-buffer) — no async
// agent nodes exist, so no async gate. f32 + per-agent PCG → statistical parity,
// not bit-exact (same as the lattice WebGPU grid). 2D-only (worldDepth>1 is the
// 3D port; this compiler rejects 3D so a 3D-agent model clamps to JS).
// ===========================================================================

import type { GraphNode, GraphEdge, CAModel } from '../../../../model/types';
import type { ValueRef, WgslType } from '../webgpu/compile';
import { castTo } from '../webgpu/compile';
import { emitWgsl, wgslFloatLit } from '../expression/emitWgsl';
import { buildVarMap, parseExpression, clampVisibleCount } from '../expression/parser';
import { is3dModel } from '../compile';
import { expandMacros } from '../macroExpand';
import { collapseReroutes } from '../rerouteCollapse';
import { canonicalizeAccessorEdges } from '../accessorCSE';
import { cellFieldAttrsOf, cellFieldWriteAttrsOf, agentAttrsOf } from '../../../../model/attributeScope';
import { readCategoricalEntries, readCategoricalDefault } from '../../nodes/CategoricalColorNode';
import { computeAgentWebGPULayout, type AgentWebGPULayout } from './layout';

/** The node types this compiler can emit to WGSL. A model whose agent graph uses
 *  ONLY these (after macro-expansion / reroute-collapse / CSE) runs on the WebGPU
 *  target; anything else FALLS BACK to JS. SINGLE source of truth for the gate +
 *  the emitter dispatch (mirrors AGENT_WASM_SUPPORTED_TYPES). */
export const AGENT_WEBGPU_SUPPORTED_TYPES: ReadonlySet<string> = new Set<string>([
  // event roots
  'behaviourStep',
  // self reads
  'getSelfPosition', 'getRadius', 'getBondDegree', 'neighbourDensity',
  // neighbour access
  'getNearbyAgents', 'forEachInArray', 'getAgentOffset', 'getVelocity',
  'getAgentPosition', 'getAgentRadius',
  // local variables (SCALAR only)
  'getVariable', 'setVariable',
  // agent attributes (Get/Set Attribute on the agent SoA — G4)
  'getCellAttribute', 'setAttribute',
  // field bridge (G5 — the closed agent↔grid morphogen feedback)
  'sampleField', 'fieldGradient', 'readCellsUnder',
  'affectCellsUnder', 'secreteToField',
  // colour (G4 — Set Cell Looks per-agent + the categorical palette)
  'categoricalColor', 'setCellLooks',
  // structural writes (G4 — the post-step CPU structural phase reads the requests)
  'divideAgent', 'formBond', 'breakBond', 'killAgent',
  // writes
  'applyForce', 'setTargetRadius',
  // value/flow utility
  'getConstant', 'arithmeticOperator', 'expression', 'statement', 'logicOperator', 'getRandom',
  // flow
  'conditional', 'sequence',
]);

/** Max getNearbyAgents nodes a single shader can host. Each gets its own
 *  per-thread `var<function>` id array sized `maxAgents` — a tight register
 *  budget on the GPU, so keep it small (a graph exceeding it clamps to JS, like
 *  the WASM path's AGENT_NEARBY_SCRATCH_SLOTS=4). */
export const AGENT_WEBGPU_NEARBY_SLOTS = 4;

export interface AgentWebGPUResult {
  /** The WGSL module source (empty on error / unsupported). */
  shaderCode: string;
  /** The GPU agent storage layout this shader was compiled against. */
  layout: AgentWebGPULayout;
  /** The node types the compiler actually emitted (diagnostics + the gate). */
  supportedTypes: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Adjacency (a small self-contained value/flow walk for the supported subset —
// identical shape to agentWasm's).
// ---------------------------------------------------------------------------

interface Adjacency {
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
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
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();
  for (const e of edges) {
    const src = parseHandle(e.sourceHandle);
    const tgt = parseHandle(e.targetHandle);
    if (!src || !tgt) continue;
    if (tgt.category === 'value') {
      inputToSource.set(`${e.target}:${tgt.portId}`, { nodeId: e.source, portId: src.portId });
    } else {
      const key = `${e.source}:${src.portId}`;
      const arr = flowOutputToTargets.get(key) ?? [];
      arr.push({ nodeId: e.target, portId: tgt.portId });
      flowOutputToTargets.set(key, arr);
    }
  }
  return { nodeMap, inputToSource, flowOutputToTargets };
}

// ---------------------------------------------------------------------------
// The emitter context. Values are WGSL expression/local references (the lattice
// string model), NOT the WASM stack/local model. Each value port is materialised
// into a `let` once + cached by `${nodeId}:${portId}`; the cache is cleared at
// scope boundaries (the agent-iteration top + each forEach iteration) so a value
// reading a per-iteration `element`/`index` re-emits per iteration.
// ---------------------------------------------------------------------------

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
  /** Scalar Local-Variable id → its WGSL var name (`var<function>`, reset per agent). */
  varNames: Map<string, string>;
  /** Cache: `${nodeId}:${portId}` → its ValueRef. Cleared on scope change. */
  valueCache: Map<string, ValueRef>;
  /** Node ids whose cached value MUST NOT persist across a forEach iteration. */
  volatileNodes: Set<string>;
  /** getNearbyAgents node id → its assigned scratch slot index. */
  nearbyScratchSlot: Map<string, number>;
  /** Active forEach iteration locals (innermost last). */
  forEachStack: Array<{ nodeId: string; elemName: string; idxName: string }>;
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
 *  axis defaults to NaN = "engine-resolved tension axis", matching the JS emit). */
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
        : { expr: frame.elemName, type: 'i32' };
      break;
    }
    case 'behaviourStep': {
      result = emitBehaviourStep(ctx, portId);
      break;
    }
    case 'getSelfPosition': {
      const field = portId === 'y' ? 'y' : portId === 'z' ? 'y' /* 2D: z N/A */ : 'x';
      result = emitLet(ctx, 'f32', f32At(ctx, field, 'idx'), 'sp');
      break;
    }
    case 'getRadius': {
      result = emitLet(ctx, 'f32', f32At(ctx, 'radius', 'idx'), 'rad');
      break;
    }
    case 'getBondDegree': {
      result = emitLet(ctx, 'f32', `f32(${i32At(ctx, 'bondCount', 'idx')})`, 'bd');
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
    case 'getConstant': {
      result = { expr: wgslFloatLit(readConstantValue(node)), type: 'f32' };
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
      const aName = emitAgentId(ctx, node, 'agentId');
      const field = portId === 'y' ? 'y' : 'x';
      result = emitLet(ctx, 'f32', f32At(ctx, field, aName), 'gp');
      break;
    }
    case 'getAgentRadius': {
      const aName = emitAgentId(ctx, node, 'agentId');
      result = emitLet(ctx, 'f32', f32At(ctx, 'radius', aName), 'gr');
      break;
    }
    case 'getVelocity': {
      // self when agentId is unwired (JS: `inputs.agentId ? (...|0) : idx`).
      const src = ctx.adj.inputToSource.get(`${node.id}:agentId`);
      const aName = src ? emitAgentId(ctx, node, 'agentId') : 'idx';
      const field = portId === 'vy' ? 'vy' : 'vx';
      result = emitLet(ctx, 'f32', f32At(ctx, field, aName), 'gv');
      break;
    }
    case 'getAgentOffset': {
      result = compileAgentOffset(ctx, node, portId);
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
    case 'myRadius': return emitLet(ctx, 'f32', f32At(ctx, 'radius', 'idx'), 'myR');
    case 'myArea': {
      const r = f32At(ctx, 'radius', 'idx');
      return emitLet(ctx, 'f32', `(3.14159265358979 * ${r} * ${r})`, 'myA');
    }
    case 'myAge': return emitLet(ctx, 'f32', f32At(ctx, 'age', 'idx'), 'myG');
    case 'myBondDegree': return emitLet(ctx, 'f32', `f32(${i32At(ctx, 'bondCount', 'idx')})`, 'myBd');
    case 'myType': return emitLet(ctx, 'f32', `f32(${i32At(ctx, 'type', 'idx')})`, 'myT');
    default: return { expr: '0.0', type: 'f32' };
  }
}

/** Resolve the `agentId` input → a fresh u32 index local (for SoA addressing). */
function emitAgentId(ctx: AgentWgpuCtx, node: GraphNode, portId: string): string {
  const ref = resolveValueInput(ctx, node, portId, 0);
  // (id | 0) → i32 → clamp non-negative → u32 for indexing.
  const iName = fresh(ctx, 'aid');
  ctx.lines.push(`  let ${iName}: u32 = u32(max(0, ${castTo(ref, 'i32')}));`);
  return iName;
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

/** Logic node — AND/OR/XOR/NOT over boolean (non-zero) f32 inputs → 1.0/0.0. */
function emitLogic(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['operation'] as string) ?? 'and';
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

/** Get Random — float / integer / orientation / bool (NO options mode). Per-agent
 *  PCG keyed by `idx` (the lattice grid model — statistical parity, NOT bit-exact
 *  vs JS/WASM's shared xorshift32 stream; the documented WebGPU constraint). */
function emitGetRandom(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const t = (cfg?.['randomType'] as string) || (cfg?.['mode'] as string) || 'float';
  const minRaw = cfg?.['min']; const maxRaw = cfg?.['max'];
  const minN = typeof minRaw === 'number' ? minRaw : parseFloat(String(minRaw ?? '0')) || 0;
  const maxN = typeof maxRaw === 'number' ? maxRaw : parseFloat(String(maxRaw ?? '1')) || 1;
  const r = 'rand_f32(idx)';
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
  const rName = fresh(ctx, 'ccr'), gName = fresh(ctx, 'ccg'), bName = fresh(ctx, 'ccb');
  ctx.lines.push(`  var ${rName}: i32; var ${gName}: i32; var ${bName}: i32;`);
  const writeConst = (r: number, g: number, b: number) =>
    `${rName} = ${r | 0}; ${gName} = ${g | 0}; ${bName} = ${b | 0};`;
  if (entries.length === 0) {
    ctx.lines.push(`  ${writeConst(d.r, d.g, d.b)}`);
  } else {
    const kName = fresh(ctx, 'cck');
    ctx.lines.push(`  let ${kName}: i32 = ${idx};`);
    entries.forEach((e, i) => {
      const head = i === 0 ? `if (${kName} == ${i})` : `else if (${kName} == ${i})`;
      ctx.lines.push(`  ${head} { ${writeConst(e.r, e.g, e.b)} }`);
    });
    ctx.lines.push(`  else { ${writeConst(d.r, d.g, d.b)} }`);
  }
  const refs: Record<string, ValueRef> = {
    r: { expr: rName, type: 'i32' },
    g: { expr: gName, type: 'i32' },
    b: { expr: bName, type: 'i32' },
  };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['r']!;
}

/** Get Agent Offset — torus-shortest (dX, dY) + Distance from self to a target.
 *  Multi-output: one emit pass into shared locals; cache all ports. */
function compileAgentOffset(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const cachedSibling = ctx.valueCache.get(`${node.id}:dx`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  const aName = emitAgentId(ctx, node, 'agentId');
  const dx = fresh(ctx, 'odx'), dy = fresh(ctx, 'ody'), dist = fresh(ctx, 'odist');
  ctx.lines.push(`  var ${dx}: f32 = ${f32At(ctx, 'x', aName)} - ${f32At(ctx, 'x', 'idx')};`);
  ctx.lines.push(`  var ${dy}: f32 = ${f32At(ctx, 'y', aName)} - ${f32At(ctx, 'y', 'idx')};`);
  // torus fold over the world bounds (control.fieldW / fieldH / fieldTorus).
  ctx.lines.push(`  if (control.fieldTorus != 0u) {`);
  ctx.lines.push(`    let _hW = control.fieldW * 0.5; let _hH = control.fieldH * 0.5;`);
  ctx.lines.push(`    if (${dx} > _hW) { ${dx} = ${dx} - control.fieldW; } else if (${dx} < -_hW) { ${dx} = ${dx} + control.fieldW; }`);
  ctx.lines.push(`    if (${dy} > _hH) { ${dy} = ${dy} - control.fieldH; } else if (${dy} < -_hH) { ${dy} = ${dy} + control.fieldH; }`);
  ctx.lines.push(`  }`);
  ctx.lines.push(`  let ${dist}: f32 = sqrt(${dx} * ${dx} + ${dy} * ${dy});`);
  const refs: Record<string, ValueRef> = {
    dx: { expr: dx, type: 'f32' },
    dy: { expr: dy, type: 'f32' },
    distance: { expr: dist, type: 'f32' },
  };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['dx']!;
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

/** Sample Field — bilinearly read the field at the agent's (x, y). */
function emitSampleField(ctx: AgentWgpuCtx, node: GraphNode): ValueRef {
  const attr = fieldAttrId(node);
  const base = ctx.layout.fieldReadBase[attr] ?? 0;
  const px = f32At(ctx, 'x', 'idx'), py = f32At(ctx, 'y', 'idx');
  return emitLet(ctx, 'f32', `fieldSampleBilinear(${base}u, ${px}, ${py})`, 'sf');
}

/** Field Gradient — central differences (±0.5 cell) of the bilinear field.
 *  Multi-output (∂x, ∂y); emit both into shared locals + cache all ports. */
function compileFieldGradient(ctx: AgentWgpuCtx, node: GraphNode, portId: string): ValueRef {
  const cachedSibling = ctx.valueCache.get(`${node.id}:dx`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  const attr = fieldAttrId(node);
  const base = ctx.layout.fieldReadBase[attr] ?? 0;
  const px = f32At(ctx, 'x', 'idx'), py = f32At(ctx, 'y', 'idx');
  const dxN = fresh(ctx, 'gdx'), dyN = fresh(ctx, 'gdy');
  ctx.lines.push(`  let ${dxN}: f32 = fieldSampleBilinear(${base}u, ${px} + 0.5, ${py}) - fieldSampleBilinear(${base}u, ${px} - 0.5, ${py});`);
  ctx.lines.push(`  let ${dyN}: f32 = fieldSampleBilinear(${base}u, ${px}, ${py} + 0.5) - fieldSampleBilinear(${base}u, ${px}, ${py} - 0.5);`);
  const refs: Record<string, ValueRef> = {
    dx: { expr: dxN, type: 'f32' },
    dy: { expr: dyN, type: 'f32' },
  };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['dx']!;
}

/** Read Cells Under — aggregate (mean/sum/max/min) the field over an r-disk
 *  under the agent. Reads the `fieldRead` snapshot. 2D. */
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
  if (reduce === 'max') ctx.lines.push(`        if (${val} > ${acc}) { ${acc} = ${val}; }`);
  else if (reduce === 'min') ctx.lines.push(`        if (${val} < ${acc}) { ${acc} = ${val}; }`);
  else ctx.lines.push(`        ${acc} = ${acc} + ${val};`);
  ctx.lines.push(`        ${n} = ${n} + 1;`);
  ctx.lines.push(`      }`);
  ctx.lines.push(`    }`);
  ctx.lines.push(`  } }`);
  // finish: mean → acc/n; max/min → (n>0?acc:0); sum → acc.
  let finishExpr: string;
  if (reduce === 'mean') finishExpr = `select(0.0, ${acc} / f32(${n}), ${n} > 0)`;
  else if (reduce === 'max' || reduce === 'min') finishExpr = `select(0.0, ${acc}, ${n} > 0)`;
  else finishExpr = acc;
  ctx.lines.push(`  let ${out}: f32 = ${finishExpr};`);
  return { expr: out, type: 'f32' };
}

// ---------------------------------------------------------------------------
// Flow emission.
// ---------------------------------------------------------------------------

function compileFlowChain(ctx: AgentWgpuCtx, nodeId: string, portId: string): void {
  const targets = ctx.adj.flowOutputToTargets.get(`${nodeId}:${portId}`) ?? [];
  for (const t of targets) compileFlowNode(ctx, t.nodeId);
}

function compileFlowNode(ctx: AgentWgpuCtx, nodeId: string): void {
  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) return;
  const type = node.data.nodeType;
  switch (type) {
    case 'applyForce': {
      ctx.lines.push(`  ${f32At(ctx, 'forceX', 'idx')} = ${f32At(ctx, 'forceX', 'idx')} + ${inF32(ctx, node, 'fx', 0)};`);
      ctx.lines.push(`  ${f32At(ctx, 'forceY', 'idx')} = ${f32At(ctx, 'forceY', 'idx')} + ${inF32(ctx, node, 'fy', 0)};`);
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
    case 'setCellLooks': {
      emitSetCellLooks(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'divideAgent': {
      // Flag a division request (the CPU structural phase reads it back). The
      // axes default to NaN (= "engine-resolved tension axis", the JS default).
      ctx.lines.push(`  ${f32At(ctx, 'divideRequest', 'idx')} = 1.0;`);
      const ax = resolveOptionalF32(ctx, node, 'axisX');
      const ay = resolveOptionalF32(ctx, node, 'axisY');
      ctx.lines.push(`  ${f32At(ctx, 'divideAxisX', 'idx')} = ${ax ?? 'bitcast<f32>(0x7fc00000u)'};`); // NaN
      ctx.lines.push(`  ${f32At(ctx, 'divideAxisY', 'idx')} = ${ay ?? 'bitcast<f32>(0x7fc00000u)'};`);
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
    case 'sequence': {
      const cfg = node.data.config as Record<string, unknown> | undefined;
      const count = Math.max(1, Number(cfg?.['sequenceCount']) || 1);
      compileFlowChain(ctx, node.id, 'then0');
      for (let i = 1; i < count; i++) compileFlowChain(ctx, node.id, `then${i}`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'conditional': {
      const cond = `(${inF32(ctx, node, 'condition', 0)} != 0.0)`;
      ctx.lines.push(`  if (${cond}) {`);
      compileFlowChain(ctx, node.id, 'then');
      ctx.lines.push(`  } else {`);
      compileFlowChain(ctx, node.id, 'else');
      ctx.lines.push(`  }`);
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

/** Affect Cells Under — write the field over an r-disk under the agent. The op
 *  (set/add/subtract/max/min) goes through the atomic `fieldDeposit` accumulator
 *  via `fieldDepositCell` so parallel agents don't race. 2D. */
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

/** Secrete To Field — bilinear 4-cell splat deposit at the agent's position. The
 *  4 weights sum to 1, so the total deposit is `rate`. Additive (op=add). 2D. */
function emitSecreteToField(ctx: AgentWgpuCtx, node: GraphNode): void {
  const attr = fieldAttrId(node);
  if (ctx.layout.fieldWriteBase[attr] === undefined) return; // not a write field → no-op
  const wBase = fieldWriteBaseOf(ctx, attr);
  const rate = castTo(resolveValueInput(ctx, node, 'rate', 1), 'f32');
  const fx = f32At(ctx, 'x', 'idx'), fy = f32At(ctx, 'y', 'idx');
  const fxL = fresh(ctx, 'stfX'), fyL = fresh(ctx, 'stfY'), rt = fresh(ctx, 'stfR');
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
 *  PLAIN mode only on the agent GPU path (glyphs need the per-cell glyph buffers,
 *  which the agent GPU SoA doesn't carry — a glyph setCellLooks clamps the model
 *  to JS via the gate). The agent loop's "viewer" is always the current pass, so
 *  the `__current__` sentinel + any concrete mapping write unconditionally (the
 *  worker dispatches one behaviour pass; there's no per-mapping viewer guard on
 *  the agent colour buffer). */
function emitSetCellLooks(ctx: AgentWgpuCtx, node: GraphNode): void {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const useGlyph = !!cfg?.['useGlyph'];
  const setBg = cfg?.['setBackground'] !== false; // default true
  const doBg = !useGlyph || setBg;
  if (!doBg) return; // glyph-only (no background) → no agent-colour write on GPU
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
 *  var name + the length local. */
function emitNearbyFill(ctx: AgentWgpuCtx, naNode: GraphNode): { arrName: string; lenName: string } {
  const slot = ctx.nearbyScratchSlot.get(naNode.id)!;
  const arrName = `nearby${slot}`;        // the per-thread var array (declared at fn top)
  const lenName = fresh(ctx, 'naLen');
  const r2 = fresh(ctx, 'naR2'), xi = fresh(ctx, 'naXi'), yi = fresh(ctx, 'naYi');
  const qr = castTo(resolveValueInput(ctx, naNode, 'radius', 5), 'f32');
  ctx.lines.push(`  var ${lenName}: i32 = 0;`);
  ctx.lines.push(`  let ${r2}: f32 = (${qr}) * (${qr});`);
  ctx.lines.push(`  let ${xi}: f32 = ${f32At(ctx, 'x', 'idx')};`);
  ctx.lines.push(`  let ${yi}: f32 = ${f32At(ctx, 'y', 'idx')};`);

  // The candidate test, applied to a candidate u32 id `j`. Pushes j into the
  // scratch array + bumps len when (j != idx && alive[j] && torus-folded d2 <= r2).
  const test = (jExpr: string) => {
    const j = fresh(ctx, 'naJ');
    ctx.lines.push(`  { let ${j}: u32 = ${jExpr};`);
    ctx.lines.push(`    if (${j} != idx && agentAlive[${j}] != 0u) {`);
    const dx = fresh(ctx, 'naDx'), dy = fresh(ctx, 'naDy');
    ctx.lines.push(`      var ${dx}: f32 = ${f32At(ctx, 'x', j)} - ${xi};`);
    ctx.lines.push(`      var ${dy}: f32 = ${f32At(ctx, 'y', j)} - ${yi};`);
    ctx.lines.push(`      if (control.fieldTorus != 0u) {`);
    ctx.lines.push(`        let _hW = control.fieldW * 0.5; let _hH = control.fieldH * 0.5;`);
    ctx.lines.push(`        if (${dx} > _hW) { ${dx} = ${dx} - control.fieldW; } else if (${dx} < -_hW) { ${dx} = ${dx} + control.fieldW; }`);
    ctx.lines.push(`        if (${dy} > _hH) { ${dy} = ${dy} - control.fieldH; } else if (${dy} < -_hH) { ${dy} = ${dy} + control.fieldH; }`);
    ctx.lines.push(`      }`);
    ctx.lines.push(`      if (${dx} * ${dx} + ${dy} * ${dy} <= ${r2} && ${lenName} < i32(control.maxAgents)) {`);
    ctx.lines.push(`        ${arrName}[${lenName}] = i32(${j}); ${lenName} = ${lenName} + 1;`);
    ctx.lines.push(`      }`);
    ctx.lines.push(`    } }`);
  };

  ctx.lines.push(`  if (control.hashValid != 0u) {`);
  emitHashStencil(ctx, test, xi, yi);
  ctx.lines.push(`  } else {`);
  emitAllPairs(ctx, test);
  ctx.lines.push(`  }`);
  return { arrName, lenName };
}

/** The 3×3 hash-bin stencil over the in-buffer binStart/binAgents (CSR), torus-
 *  wrapped like the JS emit. Calls `test(jExpr)` for each candidate. 2D only. */
function emitHashStencil(ctx: AgentWgpuCtx, test: (jExpr: string) => void, xi: string, yi: string): void {
  const bsBase = ctx.layout.hashBinStartBase;
  const baBase = ctx.layout.hashBinAgentsBase;
  const binStartAt = (e: string) => bsBase === 0 ? `hashBins[${e}]` : `hashBins[${bsBase}u + ${e}]`;
  const binAgentsAt = (e: string) => baBase === 0 ? `hashBins[${e}]` : `hashBins[${baBase}u + ${e}]`;
  const bx = fresh(ctx, 'naBx'), by = fresh(ctx, 'naBy');
  // bx = clamp((xi/binSizeX)|0, 0, nBinsX-1)
  ctx.lines.push(`  var ${bx}: i32 = i32(${xi} / control.binSizeX);`);
  ctx.lines.push(`  ${bx} = clamp(${bx}, 0, i32(control.nBinsX) - 1);`);
  ctx.lines.push(`  var ${by}: i32 = i32(${yi} / control.binSizeY);`);
  ctx.lines.push(`  ${by} = clamp(${by}, 0, i32(control.nBinsY) - 1);`);
  const ey = fresh(ctx, 'naEy'), ex = fresh(ctx, 'naEx');
  ctx.lines.push(`  for (var ${ey}: i32 = -1; ${ey} <= 1; ${ey} = ${ey} + 1) {`);
  ctx.lines.push(`  for (var ${ex}: i32 = -1; ${ex} <= 1; ${ex} = ${ex} + 1) {`);
  const nbx = fresh(ctx, 'naNbx'), nby = fresh(ctx, 'naNby'), skip = fresh(ctx, 'naSkip');
  ctx.lines.push(`    var ${nbx}: i32 = ${bx} + ${ex}; var ${nby}: i32 = ${by} + ${ey}; var ${skip}: bool = false;`);
  ctx.lines.push(`    if (control.fieldTorus != 0u) {`);
  ctx.lines.push(`      ${nbx} = ((${nbx} % i32(control.nBinsX)) + i32(control.nBinsX)) % i32(control.nBinsX);`);
  ctx.lines.push(`      ${nby} = ((${nby} % i32(control.nBinsY)) + i32(control.nBinsY)) % i32(control.nBinsY);`);
  ctx.lines.push(`    } else {`);
  ctx.lines.push(`      if (${nbx} < 0 || ${nbx} >= i32(control.nBinsX) || ${nby} < 0 || ${nby} >= i32(control.nBinsY)) { ${skip} = true; }`);
  ctx.lines.push(`    }`);
  ctx.lines.push(`    if (!${skip}) {`);
  const b = fresh(ctx, 'naB'), p = fresh(ctx, 'naP'), end = fresh(ctx, 'naEnd');
  ctx.lines.push(`      let ${b}: i32 = ${nby} * i32(control.nBinsX) + ${nbx};`);
  ctx.lines.push(`      let ${p}_start: i32 = ${binStartAt(`u32(${b})`)};`);
  ctx.lines.push(`      let ${end}: i32 = ${binStartAt(`u32(${b}) + 1u`)};`);
  ctx.lines.push(`      for (var ${p}: i32 = ${p}_start; ${p} < ${end}; ${p} = ${p} + 1) {`);
  test(`u32(${binAgentsAt(`u32(${p})`)})`);
  ctx.lines.push(`      }`);
  ctx.lines.push(`    }`);
  ctx.lines.push(`  } }`);
}

/** All-pairs fallback: for (all=0; all<highWater; all++) test(all). */
function emitAllPairs(ctx: AgentWgpuCtx, test: (jExpr: string) => void): void {
  const all = fresh(ctx, 'naAll');
  ctx.lines.push(`  for (var ${all}: u32 = 0u; ${all} < control.highWater; ${all} = ${all} + 1u) {`);
  test(all);
  ctx.lines.push(`  }`);
}

/** forEachInArray over a getNearbyAgents source. */
function emitForEach(ctx: AgentWgpuCtx, node: GraphNode): void {
  const src = ctx.adj.inputToSource.get(`${node.id}:array`);
  if (!src) return; // no array wired → body + done skipped (JS parity)
  const naNode = ctx.adj.nodeMap.get(src.nodeId);
  if (!naNode || naNode.data.nodeType !== 'getNearbyAgents') {
    throw new Error(`agentWebgpu: forEachInArray array input must be getNearbyAgents (got ${naNode?.data.nodeType}).`);
  }
  const { arrName, lenName } = emitNearbyFill(ctx, naNode);
  const fi = fresh(ctx, 'fei'), elem = fresh(ctx, 'feElem');
  ctx.lines.push(`  for (var ${fi}: i32 = 0; ${fi} < ${lenName}; ${fi} = ${fi} + 1) {`);
  ctx.lines.push(`    let ${elem}: i32 = ${arrName}[${fi}];`);
  ctx.forEachStack.push({ nodeId: node.id, elemName: elem, idxName: fi });
  clearVolatileCache(ctx);
  compileFlowChain(ctx, node.id, 'body');
  ctx.forEachStack.pop();
  ctx.lines.push(`  }`);
  clearVolatileCache(ctx);
}

/** Drop cached values for volatile nodes so they re-emit at the next use. */
function clearVolatileCache(ctx: AgentWgpuCtx): void {
  for (const k of [...ctx.valueCache.keys()]) {
    const nid = k.slice(0, k.lastIndexOf(':'));
    if (ctx.volatileNodes.has(nid)) ctx.valueCache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Volatility analysis — mirrors agentWasm: a node is volatile iff it transitively
// reads a forEach element/index (don't cache across a forEach iteration).
// ---------------------------------------------------------------------------

function computeVolatile(ctx: AgentWgpuCtx): void {
  const { nodeMap, inputToSource } = ctx.adj;
  const volatileSet = new Set<string>();
  for (const [, node] of nodeMap) if (node.data.nodeType === 'forEachInArray') volatileSet.add(node.id);
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
  { nodes: GraphNode[]; edges: GraphEdge[]; error?: string } {
  const expanded = expandMacros(nodes, edges, model);
  if (expanded.error) return { nodes, edges, error: expanded.error };
  let n = expanded.nodes, e = expanded.edges;
  ({ nodes: n, edges: e } = collapseReroutes(n, e));
  e = canonicalizeAccessorEdges(n, e, model);
  return { nodes: n, edges: e };
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
 *  `isAgentGraphWasmSupported` but adds the WebGPU-specific rejections: 3D agents
 *  (worldDepth>1) are the 3D port (G-future) — clamp to JS for now. */
export function isAgentGraphWebGPUSupported(model: CAModel | undefined | null): boolean {
  if (!model || !model.topologyMode?.agents) return false;
  // 3D agents are NOT yet ported to WebGPU (the 2D Boids scale target first).
  if (is3dModel(model)) return false;
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

  let nearbyCount = 0;
  for (const n of reachNodes) {
    const t = n.data.nodeType;
    if (t === 'macroInput' || t === 'macroOutput' || t === 'macro') return false;
    if (!AGENT_WEBGPU_SUPPORTED_TYPES.has(t)) return false;
    const cfg = (n.data.config ?? {}) as Record<string, unknown>;
    if (t === 'getNearbyAgents') nearbyCount++;
    if (t === 'statement') {
      // `operation`, not `operator` (matches emitCompare + StatementNode). The
      // wrong key meant the between/notBetween reject never fired → a between
      // Compare reached emitCompare (no between path) and emitted ==.
      const op = cfg['operation'] as string | undefined;
      if (op && /between/i.test(op)) return false;
      const compareType = cfg['compareType'] as string | undefined;
      if (compareType && compareType !== 'numerical') return false;
    }
    if (t === 'getConstant') {
      const ct = cfg['constType'] as string | undefined;
      if (ct && ct !== 'integer' && ct !== 'float' && ct !== 'bool') return false;
    }
    if (t === 'getRandom') {
      const rt = (cfg['randomType'] as string) || (cfg['mode'] as string);
      if (rt === 'options') return false;
    }
    if (t === 'setCellLooks') {
      // Glyph mode needs the per-cell glyph buffers, which the agent GPU SoA does
      // not carry — a glyph (no-background) setCellLooks clamps the model to JS.
      if (cfg['useGlyph'] && cfg['setBackground'] === false) return false;
    }
  }
  if (nearbyCount > AGENT_WEBGPU_NEARBY_SLOTS) return false;
  // SCALAR Local Variables only (array variables are a future port). The agent
  // graph resolves variables against `agentVariables` (the Generic Agent
  // Platform's separate agent-variable id-space), NOT the cell `variables`.
  const hasArrayVar = (model.agentVariables ?? []).some(v => v.kind === 'array');
  const usesVar = reachNodes.some(n => n.data.nodeType === 'getVariable' || n.data.nodeType === 'setVariable');
  if (hasArrayVar && usesVar) return false;
  // forEachInArray's array input must come from getNearbyAgents (behaviour subtree only).
  const map = new Map(reachNodes.map(n => [n.id, n] as const));
  for (const e of flat.edges) {
    const tgt = parseHandle(e.targetHandle);
    if (tgt && tgt.category === 'value' && tgt.portId === 'array') {
      const consumer = map.get(e.target);
      if (consumer?.data.nodeType === 'forEachInArray') {
        const srcNode = map.get(e.source);
        if (srcNode && srcNode.data.nodeType !== 'getNearbyAgents') return false;
      }
    }
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
};`;
}

/** The field-bridge WGSL helpers (G5): a 2D cell-centered bilinear READ of the
 *  read-only `fieldRead` snapshot, and an f32-bitcast atomic-CAS deposit into
 *  `fieldDeposit` (set/sub/max/min/add per opcode) so parallel agents writing the
 *  same cell don't race. `base` is the attr's element offset in the buffer. */
function emitFieldHelpers(): string {
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
fn fieldDepositCell(ci: u32, v: f32, op: u32) {
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
  if (is3dModel(model)) return empty('agentWebgpu: 3D agents are not yet ported to WebGPU (clamps to JS).');

  const flat = flattenAgentGraph(agentNodes, agentEdges, model);
  if (flat.error) return empty(flat.error);
  const nodes = flat.nodes, edges = flat.edges;

  const behaviourNode = nodes.find(n => n.data.nodeType === 'behaviourStep');
  if (!behaviourNode) return empty('No Behaviour Step node in the agent graph.');

  // Gate (defensive — the caller already checked isAgentGraphWebGPUSupported).
  // ONLY the behaviour-reachable nodes are emitted; the divisionEvent / agentInit
  // roots are compiled separately on CPU/JS (G4), so they're excluded here.
  const reachable = behaviourReachableNodeIds(nodes, edges);
  const seen = new Set<string>();
  let nearbyCount = 0;
  for (const n of nodes) {
    if (!reachable.has(n.id)) continue;
    seen.add(n.data.nodeType);
    if (!AGENT_WEBGPU_SUPPORTED_TYPES.has(n.data.nodeType)) return empty(`agentWebgpu: unsupported node '${n.data.nodeType}' (falls back to JS).`);
    if (n.data.nodeType === 'getNearbyAgents') nearbyCount++;
  }
  if (nearbyCount > AGENT_WEBGPU_NEARBY_SLOTS) return empty(`agentWebgpu: too many getNearbyAgents (${nearbyCount} > ${AGENT_WEBGPU_NEARBY_SLOTS} slots).`);

  const adj = buildAdjacency(nodes, edges);
  const agentAttrType = new Map<string, string>();
  for (const a of agentAttrsOf(model)) agentAttrType.set(a.id, a.type);
  const ctx: AgentWgpuCtx = {
    adj, layout, is3d: false,
    lines: [], uid: 0,
    agentAttrType,
    varNames: new Map<string, string>(),
    valueCache: new Map<string, ValueRef>(),
    volatileNodes: new Set<string>(),
    nearbyScratchSlot: new Map<string, number>(),
    forEachStack: [],
  };

  // Assign getNearbyAgents scratch slots + name the scalar variables. The agent
  // graph's Local Variables live on `agentVariables` (the separate agent-variable
  // id-space), NOT the cell `variables`.
  let slot = 0;
  for (const n of nodes) if (reachable.has(n.id) && n.data.nodeType === 'getNearbyAgents') ctx.nearbyScratchSlot.set(n.id, slot++);
  for (const v of (model.agentVariables ?? [])) {
    if (v.kind !== 'scalar') continue;
    ctx.varNames.set(v.id, `_var${v.id.replace(/[^a-zA-Z0-9_]/g, '_')}`);
  }

  computeVolatile(ctx);

  // --- emit the per-agent body ---
  try {
    // reset scalar Local Variables to their initialValue (per agent).
    for (const v of (model.agentVariables ?? [])) {
      if (v.kind !== 'scalar') continue;
      ctx.lines.push(`  ${ctx.varNames.get(v.id)!} = ${wgslFloatLit(variableInitNum(v))};`);
    }
    compileFlowChain(ctx, behaviourNode.id, 'do');
  } catch (e) {
    return empty(String((e as Error)?.message || e));
  }

  // --- assemble the WGSL module ---
  const nearbyDecls: string[] = [];
  for (let i = 0; i < slot; i++) {
    nearbyDecls.push(`  var<function> nearby${i}: array<i32, ${layout.maxAgents}>;`);
  }
  const varDecls: string[] = [];
  for (const v of (model.agentVariables ?? [])) {
    if (v.kind !== 'scalar') continue;
    varDecls.push(`  var<function> ${ctx.varNames.get(v.id)!}: f32 = 0.0;`);
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
  // Each carries its OWN leading newline so the no-field case inserts NOTHING (a
  // no-field Boids shader is then byte-identical to the pre-G5 template).
  const fieldBindings = fieldBindingLines.length > 0 ? '\n' + fieldBindingLines.join('\n') : '';
  const fieldHelpers = (hasFieldRead || hasFieldWrite) ? '\n' + emitFieldHelpers() : '';

  const shaderCode = `${emitControlStruct()}

@group(0) @binding(0) var<storage, read_write> agentF32    : array<f32>;
@group(0) @binding(1) var<storage, read>       agentI32    : array<i32>;
@group(0) @binding(2) var<storage, read>       agentAlive  : array<u32>;
@group(0) @binding(3) var<storage, read>       hashBins    : array<i32>;
@group(0) @binding(4) var<uniform>             control     : Control;
@group(0) @binding(5) var<storage, read_write> rngState    : array<u32>;
@group(0) @binding(6) var<storage, read_write> agentColors : array<u32>;${fieldBindings}

${emitRngHelpers()}${fieldHelpers}

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

  return { shaderCode, layout, supportedTypes: [...seen] };
}

/** Build the field-bridge layout spec from a model (G5) — the ordered
 *  agent-accessible cell-attr id lists + grid dims, mirroring the compiler's
 *  `cellFieldAttrsOf` / `cellFieldWriteAttrsOf` (= the worker's `fieldSpecs`). */
export function agentWebGPUFieldSpecOf(model: CAModel) {
  return {
    readAttrs: cellFieldAttrsOf(model).map(a => a.id),
    writeAttrs: cellFieldWriteAttrsOf(model).map(a => a.id),
    gridWidth: Math.max(1, Math.floor((model.properties.gridWidth as number) || 100)),
    gridHeight: Math.max(1, Math.floor((model.properties.gridHeight as number) || 100)),
  };
}

/** Convenience for the DEV harness: derive the GPU agent layout from a model +
 *  compile. Mirrors `compileAgentGraphWasmForModel`. */
export function compileAgentGraphWebGPUForModel(model: CAModel): AgentWebGPUResult {
  const cfg = model.centerBased;
  const layout = computeAgentWebGPULayout(
    Math.max(1, Math.floor((cfg?.maxAgents as number) ?? 2000)),
    agentMaxHashBinsForModelGPU(model),
    agentWebGPUFieldSpecOf(model),
    agentAttrsOf(model).map(a => a.id),
  );
  if (!cfg) return { shaderCode: '', layout, supportedTypes: [], error: 'No centerBased config.' };
  return compileAgentGraphWebGPU(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, layout);
}

/** The per-model max hash-bin reserve (same bound the WASM path uses). */
function agentMaxHashBinsForModelGPU(model: CAModel): number {
  const cfg = model.centerBased;
  const W = (model.properties.gridWidth as number) || 100;
  const H = (model.properties.gridHeight as number) || 100;
  const range = (cfg?.interactionRange as number) ?? 1.5;
  const dr = (cfg?.defaultRadius as number) ?? 0.5;
  const nq = (cfg?.neighbourQueryRadius as number) ?? 5;
  const minEdge = Math.max(1e-3, range * 2 * dr, nq);
  const nx = Math.max(1, Math.floor(W / minEdge));
  const ny = Math.max(1, Math.floor(H / minEdge));
  return Math.min(1 << 20, nx * ny);
}
