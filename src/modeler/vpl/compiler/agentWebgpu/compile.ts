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
import { computeAgentWebGPULayout, type AgentWebGPULayout } from './layout';

/** The node types this compiler can emit to WGSL. A model whose agent graph uses
 *  ONLY these (after macro-expansion / reroute-collapse / CSE) runs on the WebGPU
 *  target; anything else FALLS BACK to JS. SINGLE source of truth for the gate +
 *  the emitter dispatch (mirrors AGENT_WASM_SUPPORTED_TYPES). */
export const AGENT_WEBGPU_SUPPORTED_TYPES: ReadonlySet<string> = new Set<string>([
  // event roots
  'behaviourStep',
  // self reads
  'getSelfPosition', 'getRadius',
  // neighbour access
  'getNearbyAgents', 'forEachInArray', 'getAgentOffset', 'getVelocity',
  'getAgentPosition', 'getAgentRadius',
  // local variables (SCALAR only)
  'getVariable', 'setVariable',
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
    default:
      throw new Error(`agentWebgpu: unsupported flow node '${type}'`);
  }
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

  let nearbyCount = 0;
  for (const n of flat.nodes) {
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
  }
  if (nearbyCount > AGENT_WEBGPU_NEARBY_SLOTS) return false;
  // SCALAR Local Variables only (array variables are a future port). The agent
  // graph resolves variables against `agentVariables` (the Generic Agent
  // Platform's separate agent-variable id-space), NOT the cell `variables`.
  const hasArrayVar = (model.agentVariables ?? []).some(v => v.kind === 'array');
  const usesVar = flat.nodes.some(n => n.data.nodeType === 'getVariable' || n.data.nodeType === 'setVariable');
  if (hasArrayVar && usesVar) return false;
  // forEachInArray's array input must come from getNearbyAgents.
  const map = new Map(flat.nodes.map(n => [n.id, n] as const));
  for (const e of flat.edges) {
    const tgt = parseHandle(e.targetHandle);
    if (tgt && tgt.category === 'value' && tgt.portId === 'array') {
      const consumer = map.get(e.target);
      if (consumer?.data.nodeType === 'forEachInArray') {
        const srcNode = map.get(e.source);
        if (srcNode?.data.nodeType !== 'getNearbyAgents') return false;
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
  const seen = new Set<string>();
  let nearbyCount = 0;
  for (const n of nodes) {
    seen.add(n.data.nodeType);
    if (!AGENT_WEBGPU_SUPPORTED_TYPES.has(n.data.nodeType)) return empty(`agentWebgpu: unsupported node '${n.data.nodeType}' (falls back to JS).`);
    if (n.data.nodeType === 'getNearbyAgents') nearbyCount++;
  }
  if (nearbyCount > AGENT_WEBGPU_NEARBY_SLOTS) return empty(`agentWebgpu: too many getNearbyAgents (${nearbyCount} > ${AGENT_WEBGPU_NEARBY_SLOTS} slots).`);

  const adj = buildAdjacency(nodes, edges);
  const ctx: AgentWgpuCtx = {
    adj, layout, is3d: false,
    lines: [], uid: 0,
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
  for (const n of nodes) if (n.data.nodeType === 'getNearbyAgents') ctx.nearbyScratchSlot.set(n.id, slot++);
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

  const shaderCode = `${emitControlStruct()}

@group(0) @binding(0) var<storage, read_write> agentF32    : array<f32>;
@group(0) @binding(1) var<storage, read>       agentI32    : array<i32>;
@group(0) @binding(2) var<storage, read>       agentAlive  : array<u32>;
@group(0) @binding(3) var<storage, read>       hashBins    : array<i32>;
@group(0) @binding(4) var<uniform>             control     : Control;
@group(0) @binding(5) var<storage, read_write> rngState    : array<u32>;
@group(0) @binding(6) var<storage, read_write> agentColors : array<u32>;

${emitRngHelpers()}

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

/** Convenience for the DEV harness: derive the GPU agent layout from a model +
 *  compile. Mirrors `compileAgentGraphWasmForModel`. */
export function compileAgentGraphWebGPUForModel(model: CAModel): AgentWebGPUResult {
  const cfg = model.centerBased;
  const layout = computeAgentWebGPULayout(
    Math.max(1, Math.floor((cfg?.maxAgents as number) ?? 2000)),
    agentMaxHashBinsForModelGPU(model),
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
