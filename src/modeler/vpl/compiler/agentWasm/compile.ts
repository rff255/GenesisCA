// ===========================================================================
// PR6b-2 — the SEPARATE WASM AGENT-LOOP compiler (widened to run Boids).
//
// A self-contained agent-WASM compiler whose per-agent behaviour loop runs
// directly against the wasmBacked AgentStore memory (PR6a — the AgentStore SoA
// laid out on a single WebAssembly.Memory at the offsets `computeAgentMemoryLayout`
// bakes). PR6b-1 proved the architecture on a deterministic drift/spring model;
// PR6b-2 widens the emitter set so the **Boids — Flocking** sample runs on WASM
// with JS bit-parity (Boids is deterministic given the same RNG stream — only
// neighbour math + a deterministic jitter).
//
// SCOPE (PR6b-2 — the Boids node set + the PR6b-1 set):
//   roots/reads/writes : behaviourStep, getSelfPosition, getRadius,
//                        applyForce, setTargetRadius
//   neighbour access   : getNearbyAgents (the hash stencil → an agent-id array),
//                        forEachInArray (loop body + element/index),
//                        getAgentOffset (torus-shortest dX/dY[/dZ] + Distance),
//                        getVelocity (self/neighbour Vx/Vy[/Vz]),
//                        getAgentPosition (X/Y[/Z]), getAgentRadius
//   local variables    : getVariable / setVariable (SCALAR only — array variables
//                        + setArrayElement stay OUT, PR6b-3)
//   value/flow utility : getConstant, arithmeticOperator (Math), expression,
//                        statement (Compare), logicOperator, getRandom,
//                        conditional, sequence
// Everything else FALLS BACK to JS — `isAgentGraphWasmSupported(model)` is the
// honest central gate; PR6b-3 widens `AGENT_WASM_SUPPORTED_TYPES`.
//
// HARD CONSTRAINT: this compiler does NOT touch the lattice WASM compiler bytes.
// It REUSES the pure binary ENCODER (../wasm/encoder.ts) + the stateful
// `WasmEmitter` (../wasm/emitter.ts) + the Expression AST emitter
// (../expression/emitWasm.ts) — all byte-stable, importable abstractions — but
// emits its own self-contained module. The front-end (macro-expand →
// reroute-collapse → accessor-CSE) is the same target-independent pipeline the
// JS agent compiler runs.
//
// The module:
//   import "env" "mem"  = the wasmBacked AgentStore memory (reads/writes hit the
//                          SAME bytes the JS engine reads at the baked offsets).
//   import "env" "pow"/"exp"/.../"tanh" = the 7 host math funcs (same funcIdx
//                          convention as the lattice module: POW=0 .. TANH=6).
//   export "behaviour"(highWater, hashValid, nBinsX, nBinsY, nBinsZ : i32,
//                       binSizeX, binSizeY, binSizeZ : f64) -> ()
//     _rs = u32[rngStateOffset];                  // AW-RNG: read the shared stream
//     for (idx = 0; idx < highWater; idx++) {
//       if (alive[idx] == 0) continue;
//       <reset scalar Local Variables>
//       <per-agent value DAG + the linear flow chain over the supported nodes>
//     }
//     u32[rngStateOffset] = _rs;                  // store back (JS↔WASM bit-parity)
//
// AW-HASH (S10): the per-step spatial hash (binStart/binAgents) is COPIED into the
// agent-memory views by the worker each step (an O(nBins + liveCount) copy); the
// hash DIMENSIONS (valid flag + nBins + binSize per axis) ride the behaviour ARG
// list (so they need no per-step memory write). `getNearbyAgents` queries the
// in-memory hash via the SAME 3×3[×3] stencil + torus wrap the JS emit uses.
// ===========================================================================

import type { GraphNode, GraphEdge, CAModel } from '../../../../model/types';
import { agentAttrsOf } from '../../../../model/attributeScope';
import {
  I32, F64,
  leb128u,
  funcType, buildModule,
  exportEntry, EXPORT_FUNC,
  importEntry, importMemoryDesc, importFuncDesc,
  OP_I32_ADD, OP_I32_SUB, OP_I32_MUL, OP_I32_REM_S,
  OP_I32_GE_S, OP_I32_GT_S, OP_I32_LT_S, OP_I32_NE, OP_I32_EQ, OP_I32_EQZ,
  OP_I32_AND, OP_I32_OR, OP_I32_XOR, OP_I32_SHL, OP_I32_SHR_U,
  OP_F64_ADD, OP_F64_SUB, OP_F64_MUL, OP_F64_DIV,
  OP_F64_ABS, OP_F64_NEG, OP_F64_SQRT, OP_F64_MIN, OP_F64_MAX, OP_F64_FLOOR,
  OP_F64_EQ, OP_F64_NE, OP_F64_LT, OP_F64_GT, OP_F64_LE, OP_F64_GE,
  OP_F64_CONVERT_I32_S, OP_F64_CONVERT_I32_U, OP_I32_TRUNC_F64_S,
  opCall,
} from '../wasm/encoder';
import { WasmEmitter, pushValueAs, type ValueRef, type LocalRef } from '../wasm/emitter';
import { POW_FUNC_IDX, EXP_FUNC_IDX, LOG_FUNC_IDX, SIN_FUNC_IDX, COS_FUNC_IDX, TAN_FUNC_IDX, TANH_FUNC_IDX, NUM_IMPORTED_FUNCS } from '../wasm/compile';
import { emitWasm } from '../expression/emitWasm';
import { buildVarMap, parseExpression, clampVisibleCount } from '../expression/parser';
import { is3dModel } from '../compile';
import { expandMacros } from '../macroExpand';
import { collapseReroutes } from '../rerouteCollapse';
import { canonicalizeAccessorEdges } from '../accessorCSE';
import {
  computeAgentMemoryLayout, computeAgentMaxHashBins, AGENT_NEARBY_SCRATCH_SLOTS,
  type AgentAttrSpec, type AgentMemoryLayout,
} from '../../../../simulator/engine/agentEngine';

/** The node types PR6b-2 can emit to WASM. A model whose agent graph uses ONLY
 *  these (after macro-expansion / reroute-collapse / CSE) runs on the WASM
 *  target; anything else FALLS BACK to JS (the clamp stays the safe default).
 *  Keep this the SINGLE source of truth so the gate + the emitter dispatch never
 *  drift. */
export const AGENT_WASM_SUPPORTED_TYPES: ReadonlySet<string> = new Set<string>([
  // event roots
  'behaviourStep',
  // self reads (SoA geometry)
  'getSelfPosition', 'getRadius',
  // neighbour access (PR6b-2)
  'getNearbyAgents', 'forEachInArray', 'getAgentOffset', 'getVelocity',
  'getAgentPosition', 'getAgentRadius',
  // local variables (SCALAR only — array variables + setArrayElement are PR6b-3)
  'getVariable', 'setVariable',
  // writes (SoA / request)
  'applyForce', 'setTargetRadius',
  // layout-agnostic value/flow utility (operate on the f64 stack / locals)
  'getConstant', 'arithmeticOperator', 'expression', 'statement', 'logicOperator', 'getRandom',
  // flow
  'conditional', 'sequence',
]);

export interface AgentWasmResult {
  /** The compiled module bytes (empty on error / unsupported). */
  bytes: Uint8Array;
  /** Pages the module's imported memory must have (= the agent layout's pages). */
  pages: number;
  /** The agent memory layout this module was compiled against (so the worker can
   *  build the SAME layout — incl. the AW-HASH reserve — for the store). */
  layout: AgentMemoryLayout;
  /** The node types the compiler actually emitted (for diagnostics + the gate). */
  supportedTypes: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Adjacency — a small self-contained value/flow graph walk for the supported
// subset.
// ---------------------------------------------------------------------------

interface Adjacency {
  nodeMap: Map<string, GraphNode>;
  /** value input port `${nodeId}:${portId}` → its single source `{nodeId, portId}`. */
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  /** flow output port `${nodeId}:${portId}` → the ordered target node ids. */
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
// The emitter context. One WasmEmitter holds the whole behaviour body. Every
// value-output port is materialised into a local once + cached by
// `${nodeId}:${portId}`. SoA offsets come from the baked AgentMemoryLayout.
//
// IMPORTANT (volatility): unlike PR6b-1's pre-emit-everything-at-top scheme, the
// value cache here is SCOPED — a value emitted inside a forEachInArray body (it
// reads `element`/`index`, mutated per iteration) must be re-emitted each loop.
// We mirror the JS agent compiler's structure: pre-emit only the LOOP-INVARIANT
// values at the agent-loop top; values that transitively read a forEach
// element/index OR a getVariable (mutated by setVariable) are emitted LAZILY at
// use site inside their enclosing scope. We model this by clearing the relevant
// cache entries on forEach-body entry, and by NOT caching getVariable reads.
// ---------------------------------------------------------------------------

interface AgentWasmCtx {
  adj: Adjacency;
  layout: AgentMemoryLayout;
  is3d: boolean;
  em: WasmEmitter;
  /** RNG local (i32) holding the live xorshift32 `_rs`. */
  rsLocal: number;
  /** loop var `idx` (i32, behaviour) — for division it's param 0. */
  idxLocal: number;
  /** Scalar Local-Variable id → its f64 local. Reset to initialValue at loop top. */
  varLocals: Map<string, number>;
  /** Cache: `${nodeId}:${portId}` → its ValueRef. Cleared on scope change. */
  valueCache: Map<string, ValueRef>;
  /** Node ids whose cached value MUST NOT persist across a forEach iteration
   *  (they transitively depend on a forEach element/index or a getVariable). */
  volatileNodes: Set<string>;
  /** getNearbyAgents node id → its assigned scratch slot index (0..slots-1). */
  nearbyScratchSlot: Map<string, number>;
  /** The current forEach iteration locals, innermost last (for nested loops — the
   *  supported set is single-level, but kept general). Each entry exposes the
   *  forEach node id + its element (i32 local) + index (i32 local). */
  forEachStack: Array<{ nodeId: string; elemLocal: number; idxLocal: number }>;
  // --- behaviour PARAM indices (read directly as locals — see the signature) ---
  highWaterLocal: number; hashValidLocal: number;
  nBinsXLocal: number; nBinsYLocal: number; nBinsZLocal: number;
  binSizeXLocal: number; binSizeYLocal: number; binSizeZLocal: number;
  fieldWLocal: number; fieldHLocal: number; fieldDLocal: number; fieldTorusLocal: number;
}

// ---------------------------------------------------------------------------
// SoA address helpers — push the byte address of a per-agent region element.
// ---------------------------------------------------------------------------

/** Push `regionOffset + agentLocal*8` (Float64 element address) onto the stack. */
function pushF64ElemAddr(em: WasmEmitter, regionOffset: number, agentI32Local: number): void {
  em.localGet(agentI32Local);
  em.i32Const(8);
  em.op(OP_I32_MUL);
  em.i32Const(regionOffset);
  em.op(OP_I32_ADD);
}

/** Load a per-agent Float64 at `regionOffset + agentLocal*8` onto the stack. */
function pushF64Elem(em: WasmEmitter, regionOffset: number, agentI32Local: number): void {
  pushF64ElemAddr(em, regionOffset, agentI32Local);
  em.f64Load();
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

/** Resolve a value input port to a ValueRef (an f64 unless the source is an i32
 *  producer like a forEach element/index). Wired → the source node's cached/
 *  freshly-emitted output; unwired → the inline-widget constant (f64). */
function resolveValueInput(ctx: AgentWasmCtx, node: GraphNode, portId: string, fallback: number): ValueRef {
  const src = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
  if (src) return compileValueNode(ctx, src.nodeId, src.portId);
  return { inline: true, value: getInlineNum(node, portId, fallback), valtype: F64 };
}

/** Push a value input onto the stack as f64. */
function pushValueInputF64(ctx: AgentWasmCtx, node: GraphNode, portId: string, fallback: number): void {
  pushValueAs(ctx.em, resolveValueInput(ctx, node, portId, fallback), F64);
}

// ---------------------------------------------------------------------------
// Value emission.
// ---------------------------------------------------------------------------

/** Compile a value-producing node + return the ValueRef for the requested port.
 *  Memoised in `valueCache` (keyed `${nodeId}:${portId}`). The cache is CLEARED at
 *  two boundaries — the top of each agent iteration AND each forEach iteration —
 *  so a value emitted inside a forEach body re-emits per iteration (it may read
 *  the per-iteration element/index) while a value used twice within one scope
 *  (e.g. a getRandom feeding two expressions) emits ONCE (the RNG-advance-once
 *  invariant, matching JS). `getVariable` returns the LIVE variable local, so its
 *  cached ValueRef is always current even after a `setVariable` write. */
function compileValueNode(ctx: AgentWasmCtx, nodeId: string, portId: string): ValueRef {
  const key = `${nodeId}:${portId}`;
  const cached = ctx.valueCache.get(key);
  if (cached !== undefined) return cached;

  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) throw new Error(`agentWasm: missing node ${nodeId}`);
  const type = node.data.nodeType;
  const em = ctx.em;

  const f64Result = (emitOntoStack: () => void): LocalRef => {
    emitOntoStack();
    const l = em.allocLocal(F64);
    em.localSet(l);
    return { localIdx: l, valtype: F64 };
  };

  let result: ValueRef;
  switch (type) {
    case 'forEachInArray': {
      // element (agent id, i32) / index (i32) of the active iteration — the loop's
      // locals live on the forEachStack (innermost = this node). The cache is
      // cleared each iteration, so caching the live local here is safe.
      const frame = ctx.forEachStack.find(f => f.nodeId === nodeId);
      if (!frame) { result = { inline: true, value: 0, valtype: I32 }; break; }
      result = portId === 'index'
        ? { localIdx: frame.idxLocal, valtype: I32 }
        : { localIdx: frame.elemLocal, valtype: I32 };
      break;
    }
    case 'behaviourStep': {
      result = f64Result(() => {
        if (portId === 'myX') pushF64Elem(em, ctx.layout.f64['x']!, ctx.idxLocal);
        else if (portId === 'myY') pushF64Elem(em, ctx.layout.f64['y']!, ctx.idxLocal);
        else if (portId === 'myZ') pushF64Elem(em, ctx.layout.f64['z']!, ctx.idxLocal);
        else if (portId === 'myRadius') pushF64Elem(em, ctx.layout.f64['radius']!, ctx.idxLocal);
        else if (portId === 'myArea') {
          pushF64Elem(em, ctx.layout.f64['radius']!, ctx.idxLocal);
          pushF64Elem(em, ctx.layout.f64['radius']!, ctx.idxLocal);
          em.op(OP_F64_MUL); em.f64Const(Math.PI); em.op(OP_F64_MUL);
        }
        else if (portId === 'myAge') pushF64Elem(em, ctx.layout.f64['age']!, ctx.idxLocal);
        else if (portId === 'myBondDegree') { em.localGet(ctx.idxLocal); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(ctx.layout.i32['bondCount']!); em.op(OP_I32_ADD); em.i32Load(); em.i32ToF64(); }
        else if (portId === 'myType') { em.localGet(ctx.idxLocal); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(ctx.layout.i32['type']!); em.op(OP_I32_ADD); em.i32Load(); em.i32ToF64(); }
        else em.f64Const(0);
      });
      break;
    }
    case 'getSelfPosition': {
      const region = portId === 'y' ? ctx.layout.f64['y']! : portId === 'z' ? ctx.layout.f64['z']! : ctx.layout.f64['x']!;
      result = f64Result(() => pushF64Elem(em, region, ctx.idxLocal));
      break;
    }
    case 'getRadius': {
      result = f64Result(() => pushF64Elem(em, ctx.layout.f64['radius']!, ctx.idxLocal));
      break;
    }
    case 'getConstant': {
      result = { inline: true, value: readConstantValue(node), valtype: F64 };
      break;
    }
    case 'arithmeticOperator': {
      result = f64Result(() => emitArithmetic(ctx, node));
      break;
    }
    case 'expression': {
      result = compileExpression(ctx, node);
      break;
    }
    case 'statement': {
      result = f64Result(() => emitCompare(ctx, node));
      break;
    }
    case 'logicOperator': {
      result = f64Result(() => emitLogic(ctx, node));
      break;
    }
    case 'getRandom': {
      result = f64Result(() => emitGetRandom(ctx, node));
      break;
    }
    case 'getVariable': {
      const variableId = (node.data.config?.['variableId'] as string) || '';
      const local = variableId ? ctx.varLocals.get(variableId) : undefined;
      if (local === undefined) result = { inline: true, value: 0, valtype: F64 };
      else result = { localIdx: local, valtype: F64 };
      break;
    }
    case 'getAgentPosition': {
      const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
      const region = portId === 'y' ? ctx.layout.f64['y']! : portId === 'z' ? ctx.layout.f64['z']! : ctx.layout.f64['x']!;
      result = f64Result(() => pushF64Elem(em, region, aLocal));
      break;
    }
    case 'getAgentRadius': {
      const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
      result = f64Result(() => pushF64Elem(em, ctx.layout.f64['radius']!, aLocal));
      break;
    }
    case 'getVelocity': {
      // self when agentId is unwired (JS: `inputs.agentId ? (...|0) : idx`).
      const src = ctx.adj.inputToSource.get(`${node.id}:agentId`);
      const aLocal = src ? emitAgentIdLocal(ctx, node, 'agentId') : ctx.idxLocal;
      const region = portId === 'vy' ? ctx.layout.f64['vy']! : portId === 'vz' ? ctx.layout.f64['vz']! : ctx.layout.f64['vx']!;
      result = f64Result(() => pushF64Elem(em, region, aLocal));
      break;
    }
    case 'getAgentOffset': {
      result = compileAgentOffset(ctx, node, portId);
      break;
    }
    default:
      throw new Error(`agentWasm: unsupported value node '${type}'`);
  }

  ctx.valueCache.set(key, result);
  return result;
}

/** Resolve the `agentId` input of a neighbour-read node into a fresh i32 local. */
function emitAgentIdLocal(ctx: AgentWasmCtx, node: GraphNode, portId: string): number {
  const em = ctx.em;
  const ref = resolveValueInput(ctx, node, portId, 0);
  // (id) | 0 — coerce to i32.
  pushValueAs(em, ref, I32);
  const l = em.allocLocal(I32);
  em.localSet(l);
  return l;
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

/** Math node — leaves the result on the stack (f64). Mirrors the JS Math node
 *  (incl. the divide-by-zero → 0 guard). */
function emitArithmetic(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['operation'] as string) ?? '+';
  const unary = (call: number) => { pushValueInputF64(ctx, node, 'x', 0); em.emit(opCall(call)); };
  switch (op) {
    case '+': case 'add': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_ADD); break;
    case '-': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_SUB); break;
    case '*': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_MUL); break;
    case '/': emitGuardedDiv(ctx, node); break;
    case 'sqrt': pushValueInputF64(ctx, node, 'x', 0); em.op(OP_F64_SQRT); break;
    case 'abs': pushValueInputF64(ctx, node, 'x', 0); em.op(OP_F64_ABS); break;
    case 'max': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_MAX); break;
    case 'min': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_MIN); break;
    case 'mean': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_ADD); em.f64Const(2); em.op(OP_F64_DIV); break;
    case 'pow': pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.emit(opCall(POW_FUNC_IDX)); break;
    case 'exp': unary(EXP_FUNC_IDX); break;
    case 'log': unary(LOG_FUNC_IDX); break;
    case 'sin': unary(SIN_FUNC_IDX); break;
    case 'cos': unary(COS_FUNC_IDX); break;
    case 'tan': unary(TAN_FUNC_IDX); break;
    case 'tanh': unary(TANH_FUNC_IDX); break;
    default: pushValueInputF64(ctx, node, 'x', 0); pushValueInputF64(ctx, node, 'y', 0); em.op(OP_F64_ADD); break;
  }
}

/** `y !== 0 ? x / y : 0` — the JS Math node's divide guard. Leaves the result on
 *  the stack (WasmEmitter's ifThenElse uses an EMPTY block type, so the branches
 *  may not yield a value — store into a result local + reload). */
function emitGuardedDiv(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const yLocal = em.allocLocal(F64);
  const resLocal = em.allocLocal(F64);
  pushValueInputF64(ctx, node, 'y', 0); em.localSet(yLocal);
  em.localGet(yLocal); em.f64Const(0); em.op(OP_F64_NE); // cond = (y != 0)
  em.ifThenElse(
    () => { pushValueInputF64(ctx, node, 'x', 0); em.localGet(yLocal); em.op(OP_F64_DIV); em.localSet(resLocal); },
    () => { em.f64Const(0); em.localSet(resLocal); },
  );
  em.localGet(resLocal);
}

/** Compare node — numerical compare ops, leaving 1.0/0.0 on the stack. */
function emitCompare(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  // The Compare (`statement`) node stores its operator under `operation` (see
  // StatementNode.defaultConfig / its JS compile) — NOT `operator`. Reading the
  // wrong key made every non-equality op fall through to `==` on the WASM agent
  // target (silent divergence from the JS agent path).
  const op = (cfg?.['operation'] as string) ?? '==';
  pushValueInputF64(ctx, node, 'x', 0);
  pushValueInputF64(ctx, node, 'y', 0);
  switch (op) {
    case '==': em.op(OP_F64_EQ); break;
    case '!=': em.op(OP_F64_NE); break;
    case '>': em.op(OP_F64_GT); break;
    case '<': em.op(OP_F64_LT); break;
    case '>=': em.op(OP_F64_GE); break;
    case '<=': em.op(OP_F64_LE); break;
    default: em.op(OP_F64_EQ); break;
  }
  em.op(OP_F64_CONVERT_I32_S);
}

/** Logic node — AND/OR/XOR/NOT over boolean (non-zero) f64 inputs → 1.0/0.0. */
function emitLogic(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['operation'] as string) ?? 'and';
  const pushBool = (port: string) => { pushValueInputF64(ctx, node, port, 0); em.f64Const(0); em.op(OP_F64_NE); };
  if (op === 'not') { pushBool('a'); em.op(OP_I32_EQZ); }
  else {
    pushBool('a'); pushBool('b');
    if (op === 'or') em.op(OP_I32_OR);
    else if (op === 'xor') em.op(OP_I32_XOR);
    else em.op(OP_I32_AND);
  }
  em.op(OP_F64_CONVERT_I32_S);
}

/** Expression node — parse the formula + emit via the shared AST emitter. Each
 *  port (a..h) resolves to a ValueRef the SAME way the JS emit's `inputVars` map
 *  does. Returns the result f64 local. */
function compileExpression(ctx: AgentWasmCtx, node: GraphNode): ValueRef {
  const cfg = node.data.config as Record<string, unknown>;
  const visibleCount = clampVisibleCount(cfg['visibleCount']);
  const { map, errors } = buildVarMap(cfg as Parameters<typeof buildVarMap>[0], visibleCount);
  if (errors.length > 0) throw new Error(`expression: ${errors[0]}`);
  const res = parseExpression(String(cfg['expression'] ?? ''), map);
  if ('error' in res) throw new Error(`expression: ${res.error}`);
  // Resolve the visible ports the AST may reference (a..h). Like the JS path, an
  // unwired port falls through to its inline-widget constant.
  const inputs: Record<string, ValueRef | undefined> = {};
  const portIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (let i = 0; i < visibleCount && i < portIds.length; i++) {
    const pid = portIds[i]!;
    inputs[pid] = resolveValueInput(ctx, node, pid, 0);
  }
  return emitWasm(res.ast, ctx.em, inputs);
}

/** Get Random (the supported subset: float / integer / orientation / bool — NO
 *  options mode). Mirrors the lattice WASM getRandom xorshift32 + JS GetRandomNode
 *  exactly: the SAME constants (13/17/5) on the in-register `_rs` local (read once
 *  at function top, stored back at the end). Leaves an f64 on the stack. */
function emitGetRandom(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const cfg = node.data.config as Record<string, unknown> | undefined;
  // The Boids node uses `mode` (not `randomType`); accept either key, default float.
  const t = (cfg?.['randomType'] as string) || (cfg?.['mode'] as string) || 'float';
  const minRaw = cfg?.['min']; const maxRaw = cfg?.['max'];
  const minN = typeof minRaw === 'number' ? minRaw : parseFloat(String(minRaw ?? '0')) || 0;
  const maxN = typeof maxRaw === 'number' ? maxRaw : parseFloat(String(maxRaw ?? '1')) || 1;
  const rs = ctx.rsLocal;
  // Advance: _rs ^= _rs << 13; _rs ^= _rs >>> 17; _rs ^= _rs << 5 (in-register).
  em.localGet(rs); em.localGet(rs); em.i32Const(13); em.op(OP_I32_SHL); em.op(OP_I32_XOR); em.localSet(rs);
  em.localGet(rs); em.localGet(rs); em.i32Const(17); em.op(OP_I32_SHR_U); em.op(OP_I32_XOR); em.localSet(rs);
  em.localGet(rs); em.localGet(rs); em.i32Const(5); em.op(OP_I32_SHL); em.op(OP_I32_XOR); em.localSet(rs);
  // uniform = (unsigned _rs) / 2^32
  em.localGet(rs); em.op(OP_F64_CONVERT_I32_U); em.f64Const(4294967296); em.op(OP_F64_DIV);
  if (t === 'bool') {
    const probRef = resolveValueInput(ctx, node, 'probability', 0.5);
    pushValueAs(em, probRef, F64);   // stack: [uniform, prob]
    em.op(OP_F64_LT);                // uniform < prob ? 1 : 0
    em.op(OP_F64_CONVERT_I32_S);
    em.i32ToF64();
  } else if (t === 'integer') {
    em.f64Const(maxN - minN + 1); em.op(OP_F64_MUL);
    em.op(OP_F64_FLOOR);
    em.f64Const(minN); em.op(OP_F64_ADD);
  } else if (t === 'orientation') {
    em.f64Const(4); em.op(OP_F64_MUL); em.op(OP_F64_FLOOR);
    // & 3 — via i32 round-trip
    em.op(OP_I32_TRUNC_F64_S); em.i32Const(3); em.op(OP_I32_AND); em.i32ToF64();
  } else {
    // float: uniform * (max - min) + min
    em.f64Const(maxN - minN); em.op(OP_F64_MUL); em.f64Const(minN); em.op(OP_F64_ADD);
  }
}

/** Get Agent Offset — torus-shortest (dX, dY[, dZ]) + Distance from self to a
 *  target by id. Mirrors GetAgentOffsetNode's JS emit (the engine torus wrap over
 *  the world bounds). Multi-output: all four ports share one emit pass into four
 *  locals; returns the requested one. */
function compileAgentOffset(ctx: AgentWasmCtx, node: GraphNode, portId: string): ValueRef {
  const em = ctx.em;
  const L = ctx.layout;
  // The four output ports share ONE emit pass into four locals; cache all four so
  // a second port request reuses them (the main valueCache handles invalidation
  // at scope boundaries). If a sibling port is already cached, reuse it.
  const cachedSibling = ctx.valueCache.get(`${node.id}:dx`);
  if (cachedSibling !== undefined) return ctx.valueCache.get(`${node.id}:${portId}`) ?? cachedSibling;
  const aLocal = emitAgentIdLocal(ctx, node, 'agentId');
  const dxL = em.allocLocal(F64), dyL = em.allocLocal(F64), distL = em.allocLocal(F64);
  let dzL = -1;
  // dx = ax[a]-ax[idx]; dy = ay[a]-ay[idx]
  pushF64Elem(em, L.f64['x']!, aLocal); pushF64Elem(em, L.f64['x']!, ctx.idxLocal); em.op(OP_F64_SUB); em.localSet(dxL);
  pushF64Elem(em, L.f64['y']!, aLocal); pushF64Elem(em, L.f64['y']!, ctx.idxLocal); em.op(OP_F64_SUB); em.localSet(dyL);
  if (ctx.is3d) {
    dzL = em.allocLocal(F64);
    pushF64Elem(em, L.f64['z']!, aLocal); pushF64Elem(em, L.f64['z']!, ctx.idxLocal); em.op(OP_F64_SUB); em.localSet(dzL);
  }
  // if (_fieldBoundaryTorus) fold each axis to the shortest. The world bounds ride
  // the behaviour as the fieldW/fieldH/[fieldD] PARAMS (mirroring JS's _fieldW etc).
  em.localGet(ctx.fieldTorusLocal);
  em.ifThen(() => {
    foldTorus(em, dxL, ctx.fieldWLocal);
    foldTorus(em, dyL, ctx.fieldHLocal);
    if (ctx.is3d && dzL >= 0) foldTorus(em, dzL, ctx.fieldDLocal);
  });
  // distance = hypot
  em.localGet(dxL); em.localGet(dxL); em.op(OP_F64_MUL);
  em.localGet(dyL); em.localGet(dyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
  if (ctx.is3d && dzL >= 0) { em.localGet(dzL); em.localGet(dzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
  em.op(OP_F64_SQRT); em.localSet(distL);

  const refs: Record<string, ValueRef> = {
    dx: { localIdx: dxL, valtype: F64 },
    dy: { localIdx: dyL, valtype: F64 },
    distance: { localIdx: distL, valtype: F64 },
  };
  if (ctx.is3d && dzL >= 0) refs['dz'] = { localIdx: dzL, valtype: F64 };
  for (const k of Object.keys(refs)) ctx.valueCache.set(`${node.id}:${k}`, refs[k]!);
  return refs[portId] ?? refs['dx']!;
}

/** Fold an f64 local `d` to the torus-shortest range given the world span in
 *  `spanLocal`: `if(d > span/2) d -= span; else if(d < -span/2) d += span`. */
function foldTorus(em: WasmEmitter, dLocal: number, spanLocal: number): void {
  // d > span*0.5 ?
  em.localGet(dLocal); em.localGet(spanLocal); em.f64Const(0.5); em.op(OP_F64_MUL); em.op(OP_F64_GT);
  em.ifThenElse(
    () => { em.localGet(dLocal); em.localGet(spanLocal); em.op(OP_F64_SUB); em.localSet(dLocal); },
    () => {
      // d < -span*0.5 ?
      em.localGet(dLocal); em.localGet(spanLocal); em.f64Const(-0.5); em.op(OP_F64_MUL); em.op(OP_F64_LT);
      em.ifThen(() => { em.localGet(dLocal); em.localGet(spanLocal); em.op(OP_F64_ADD); em.localSet(dLocal); });
    },
  );
}

// ---------------------------------------------------------------------------
// Flow emission.
// ---------------------------------------------------------------------------

function compileFlowChain(ctx: AgentWasmCtx, nodeId: string, portId: string): void {
  const targets = ctx.adj.flowOutputToTargets.get(`${nodeId}:${portId}`) ?? [];
  for (const t of targets) compileFlowNode(ctx, t.nodeId);
}

function compileFlowNode(ctx: AgentWasmCtx, nodeId: string): void {
  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) return;
  const em = ctx.em;
  const type = node.data.nodeType;
  switch (type) {
    case 'applyForce': {
      forceAdd(ctx, ctx.layout.f64['forceX']!, () => pushValueInputF64(ctx, node, 'fx', 0));
      forceAdd(ctx, ctx.layout.f64['forceY']!, () => pushValueInputF64(ctx, node, 'fy', 0));
      if (ctx.is3d) forceAdd(ctx, ctx.layout.f64['forceZ']!, () => pushValueInputF64(ctx, node, 'fz', 0));
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setTargetRadius': {
      pushF64ElemAddr(em, ctx.layout.f64['targetRadius']!, ctx.idxLocal);
      pushValueInputF64(ctx, node, 'value', 1);
      em.f64Store();
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setVariable': {
      const variableId = (node.data.config?.['variableId'] as string) || '';
      const local = variableId ? ctx.varLocals.get(variableId) : undefined;
      if (local !== undefined) { pushValueInputF64(ctx, node, 'value', 0); em.localSet(local); }
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
      const condRef = resolveValueInput(ctx, node, 'condition', 0);
      pushValueAs(em, condRef, F64); em.f64Const(0); em.op(OP_F64_NE);
      em.ifThenElse(
        () => compileFlowChain(ctx, node.id, 'then'),
        () => compileFlowChain(ctx, node.id, 'else'),
      );
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'forEachInArray': {
      emitForEach(ctx, node);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    default:
      throw new Error(`agentWasm: unsupported flow node '${type}'`);
  }
}

/** `_agentForceX[idx] += <pushVal()>`. */
function forceAdd(ctx: AgentWasmCtx, regionOffset: number, pushVal: () => void): void {
  const em = ctx.em;
  pushF64ElemAddr(em, regionOffset, ctx.idxLocal);              // store address
  pushF64Elem(em, regionOffset, ctx.idxLocal);                 // current value
  pushVal();
  em.op(OP_F64_ADD);
  em.f64Store();
}

// ---------------------------------------------------------------------------
// getNearbyAgents + forEachInArray — the keystone.
//
// getNearbyAgents fills a scratch i32 array (in agent memory at its assigned slot)
// with the matched agent ids + records the count in a `len` i32 local. It's the
// only array producer; its consumer is forEachInArray. We model the "array" not
// as an ArrayRef object that flows through value resolution, but by emitting the
// fill immediately before the forEach loop and exposing (scratchBaseLocal, lenLocal).
// ---------------------------------------------------------------------------

/** Compile getNearbyAgents (the source feeding this forEach's `array`) — fills the
 *  node's scratch slot with matched ids; returns `{ baseLocal, lenLocal }` (i32
 *  byte-address base + element count). Mirrors GetNearbyAgentsNode's JS emit (the
 *  3×3[×3] hash stencil + torus wrap + the all-pairs fallback). */
function emitNearbyFill(ctx: AgentWasmCtx, naNode: GraphNode): { baseLocal: number; lenLocal: number } {
  const em = ctx.em;
  const L = ctx.layout;
  const slot = ctx.nearbyScratchSlot.get(naNode.id)!;
  const baseConst = L.nearbyScratchOffset + slot * L.maxAgents * 4;   // byte offset
  const baseLocal = em.allocLocal(I32); em.i32Const(baseConst); em.localSet(baseLocal);
  const lenLocal = em.allocLocal(I32); em.i32Const(0); em.localSet(lenLocal);
  // query params
  const qr = resolveValueInput(ctx, naNode, 'radius', 5);
  const r2L = em.allocLocal(F64); pushValueAs(em, qr, F64); em.localTee(r2L); em.localGet(r2L); em.op(OP_F64_MUL); em.localSet(r2L);
  const xiL = em.allocLocal(F64); pushF64Elem(em, L.f64['x']!, ctx.idxLocal); em.localSet(xiL);
  const yiL = em.allocLocal(F64); pushF64Elem(em, L.f64['y']!, ctx.idxLocal); em.localSet(yiL);
  const ziL = em.allocLocal(F64); if (ctx.is3d) { pushF64Elem(em, L.f64['z']!, ctx.idxLocal); em.localSet(ziL); } else { em.f64Const(0); em.localSet(ziL); }

  // The candidate test, applied to a candidate agent id local jL. Pushes jL into
  // scratch + bumps len when (j != idx && alive[j] && torus-folded d2 <= r2).
  const aliveOff = L.u8['alive']!;
  const test = (jL: number) => {
    // if (j != idx)
    em.localGet(jL); em.localGet(ctx.idxLocal); em.op(OP_I32_NE);
    em.ifThen(() => {
      // if (alive[j])
      em.localGet(jL); em.i32Const(aliveOff); em.op(OP_I32_ADD); em.i32Load8U();
      em.ifThen(() => {
        const dxL = em.allocLocal(F64), dyL = em.allocLocal(F64);
        pushF64Elem(em, L.f64['x']!, jL); em.localGet(xiL); em.op(OP_F64_SUB); em.localSet(dxL);
        pushF64Elem(em, L.f64['y']!, jL); em.localGet(yiL); em.op(OP_F64_SUB); em.localSet(dyL);
        let dzL = -1;
        if (ctx.is3d) { dzL = em.allocLocal(F64); pushF64Elem(em, L.f64['z']!, jL); em.localGet(ziL); em.op(OP_F64_SUB); em.localSet(dzL); }
        em.localGet(ctx.fieldTorusLocal);
        em.ifThen(() => {
          foldTorus(em, dxL, ctx.fieldWLocal);
          foldTorus(em, dyL, ctx.fieldHLocal);
          if (ctx.is3d && dzL >= 0) foldTorus(em, dzL, ctx.fieldDLocal);
        });
        // d2 = dx*dx + dy*dy [+ dz*dz]
        const d2L = em.allocLocal(F64);
        em.localGet(dxL); em.localGet(dxL); em.op(OP_F64_MUL);
        em.localGet(dyL); em.localGet(dyL); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        if (ctx.is3d && dzL >= 0) { em.localGet(dzL); em.localGet(dzL); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
        em.localSet(d2L);
        // if (d2 <= r2) scratch[len++] = j
        em.localGet(d2L); em.localGet(r2L); em.op(OP_F64_LE);
        em.ifThen(() => {
          // addr = base + len*4
          em.localGet(baseLocal); em.localGet(lenLocal); em.i32Const(4); em.op(OP_I32_MUL); em.op(OP_I32_ADD);
          em.localGet(jL);
          em.i32Store();
          em.localGet(lenLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(lenLocal);
        });
      });
    });
  };

  // if (_hashValid) { 3x3[x3] bin stencil } else { all-pairs }
  em.localGet(ctx.hashValidLocal);
  em.ifThenElse(
    () => emitHashStencil(ctx, test, xiL, yiL, ziL),
    () => emitAllPairs(ctx, test),
  );
  return { baseLocal, lenLocal };
}

/** The 3×3[×3] hash-bin stencil over the in-memory binStart/binAgents, torus-
 *  wrapped exactly like the JS emit. Calls `test(jLocal)` for each candidate. */
function emitHashStencil(ctx: AgentWasmCtx, test: (jL: number) => void, xiL: number, yiL: number, ziL: number): void {
  const em = ctx.em;
  const L = ctx.layout;
  const binStartOff = L.hashBinStartOffset, binAgentsOff = L.hashBinAgentsOffset;
  // bx = clamp((xi/binSizeX)|0, 0, nBinsX-1); same for by[,bz].
  const clampBin = (coordL: number, sizeL: number, nBinsL: number): number => {
    const b = em.allocLocal(I32);
    em.localGet(coordL); em.localGet(sizeL); em.op(OP_F64_DIV); em.f64ToI32(); em.localSet(b);
    // if (b < 0) b = 0
    em.localGet(b); em.i32Const(0); em.op(OP_I32_LT_S);
    em.ifThenElse(
      () => { em.i32Const(0); em.localSet(b); },
      () => {
        // else if (b >= nBins) b = nBins-1
        em.localGet(b); em.localGet(nBinsL); em.op(OP_I32_GE_S);
        em.ifThen(() => { em.localGet(nBinsL); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(b); });
      },
    );
    return b;
  };
  const bx = clampBin(xiL, ctx.binSizeXLocal, ctx.nBinsXLocal);
  const by = clampBin(yiL, ctx.binSizeYLocal, ctx.nBinsYLocal);
  const bz = ctx.is3d ? clampBin(ziL, ctx.binSizeZLocal, ctx.nBinsZLocal) : -1;

  // wrapped neighbour-bin coordinate: torus → ((nb % n) + n) % n; else range-check.
  // We loop ddz (3D) / ddy / ddx in [-1,1].
  const ezL = em.allocLocal(I32), eyL = em.allocLocal(I32), exL = em.allocLocal(I32);

  const innerBody = () => {
    // nbx = bx + ex; nby = by + ey; nbz = bz + ez (3D)
    const nbx = em.allocLocal(I32), nby = em.allocLocal(I32);
    em.localGet(bx); em.localGet(exL); em.op(OP_I32_ADD); em.localSet(nbx);
    em.localGet(by); em.localGet(eyL); em.op(OP_I32_ADD); em.localSet(nby);
    let nbz = -1;
    if (ctx.is3d) { nbz = em.allocLocal(I32); em.localGet(bz); em.localGet(ezL); em.op(OP_I32_ADD); em.localSet(nbz); }
    // skipFlag (i32): 1 ⇒ this neighbour bin is out of range (non-torus); skip.
    const skipL = em.allocLocal(I32); em.i32Const(0); em.localSet(skipL);
    em.localGet(ctx.fieldTorusLocal);
    em.ifThenElse(
      () => {
        wrapMod(em, nbx, ctx.nBinsXLocal);
        wrapMod(em, nby, ctx.nBinsYLocal);
        if (ctx.is3d && nbz >= 0) wrapMod(em, nbz, ctx.nBinsZLocal);
      },
      () => {
        // if (nbx<0||nbx>=nx||nby<0||nby>=ny[||nbz...]) skip=1
        rangeBad(em, nbx, ctx.nBinsXLocal, skipL);
        rangeBad(em, nby, ctx.nBinsYLocal, skipL);
        if (ctx.is3d && nbz >= 0) rangeBad(em, nbz, ctx.nBinsZLocal, skipL);
      },
    );
    em.localGet(skipL); em.op(OP_I32_EQZ);
    em.ifThen(() => {
      // b = is3d ? (nbz*nBinsY + nby)*nBinsX + nbx : nby*nBinsX + nbx
      const bIdx = em.allocLocal(I32);
      if (ctx.is3d && nbz >= 0) {
        em.localGet(nbz); em.localGet(ctx.nBinsYLocal); em.op(OP_I32_MUL); em.localGet(nby); em.op(OP_I32_ADD);
        em.localGet(ctx.nBinsXLocal); em.op(OP_I32_MUL); em.localGet(nbx); em.op(OP_I32_ADD); em.localSet(bIdx);
      } else {
        em.localGet(nby); em.localGet(ctx.nBinsXLocal); em.op(OP_I32_MUL); em.localGet(nbx); em.op(OP_I32_ADD); em.localSet(bIdx);
      }
      // p = binStart[b]; end = binStart[b+1]; for (; p<end; p++) { j = binAgents[p]; test(j) }
      const pL = em.allocLocal(I32), endL = em.allocLocal(I32);
      // p = binStart[b] : load i32 at binStartOff + b*4
      em.localGet(bIdx); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binStartOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(pL);
      em.localGet(bIdx); em.i32Const(1); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binStartOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(endL);
      em.block(() => {
        em.loop(() => {
          em.localGet(pL); em.localGet(endL); em.op(OP_I32_GE_S); em.brIf(1);
          const jL = em.allocLocal(I32);
          em.localGet(pL); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binAgentsOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(jL);
          test(jL);
          em.localGet(pL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(pL);
          em.br(0);
        });
      });
    });
  };

  // for ez in [-1,1] (3D) { for ey { for ex { innerBody } } }
  const ddLoop = (varL: number, body: () => void) => {
    em.i32Const(-1); em.localSet(varL);
    em.block(() => {
      em.loop(() => {
        em.localGet(varL); em.i32Const(1); em.op(OP_I32_GT_S); em.brIf(1);
        body();
        em.localGet(varL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(varL);
        em.br(0);
      });
    });
  };
  if (ctx.is3d) {
    ddLoop(ezL, () => ddLoop(eyL, () => ddLoop(exL, innerBody)));
  } else {
    em.i32Const(0); em.localSet(ezL); // ez fixed 0 in 2D (innerBody ignores it)
    ddLoop(eyL, () => ddLoop(exL, innerBody));
  }
}

/** `n = ((n % m) + m) % m` (positive modulo) in place on i32 local n. */
function wrapMod(em: WasmEmitter, nLocal: number, mLocal: number): void {
  em.localGet(nLocal); em.localGet(mLocal); em.op(OP_I32_REM_S);
  em.localGet(mLocal); em.op(OP_I32_ADD);
  em.localGet(mLocal); em.op(OP_I32_REM_S);
  em.localSet(nLocal);
}

/** `if (n < 0 || n >= m) skip = 1`. */
function rangeBad(em: WasmEmitter, nLocal: number, mLocal: number, skipLocal: number): void {
  em.localGet(nLocal); em.i32Const(0); em.op(OP_I32_LT_S);
  em.localGet(nLocal); em.localGet(mLocal); em.op(OP_I32_GE_S);
  em.op(OP_I32_OR);
  em.ifThen(() => { em.i32Const(1); em.localSet(skipLocal); });
}

/** All-pairs fallback: for (all=0; all<highWater; all++) test(all). */
function emitAllPairs(ctx: AgentWasmCtx, test: (jL: number) => void): void {
  const em = ctx.em;
  const allL = em.allocLocal(I32); em.i32Const(0); em.localSet(allL);
  em.block(() => {
    em.loop(() => {
      em.localGet(allL); em.localGet(ctx.highWaterLocal); em.op(OP_I32_GE_S); em.brIf(1);
      test(allL);
      em.localGet(allL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(allL);
      em.br(0);
    });
  });
}

/** forEachInArray over a getNearbyAgents source. Fills the scratch, then loops
 *  `for (fi=0; fi<len; fi++) { element = scratch[fi]; index = fi; <body>; }`.
 *  The body's value cache is cleared each iteration for volatile (element/index-
 *  dependent) nodes — modelled by marking the forEach node's element/index
 *  consumers volatile + clearing their cache entries around the loop. */
function emitForEach(ctx: AgentWasmCtx, node: GraphNode): void {
  const em = ctx.em;
  const src = ctx.adj.inputToSource.get(`${node.id}:array`);
  if (!src) return; // no array wired → body + done skipped (JS parity)
  const naNode = ctx.adj.nodeMap.get(src.nodeId);
  if (!naNode || naNode.data.nodeType !== 'getNearbyAgents') {
    throw new Error(`agentWasm: forEachInArray array input must be getNearbyAgents (got ${naNode?.data.nodeType}).`);
  }
  const { baseLocal, lenLocal } = emitNearbyFill(ctx, naNode);
  const fiL = em.allocLocal(I32); em.i32Const(0); em.localSet(fiL);
  const elemL = em.allocLocal(I32);
  // expose element/index locals for the body
  ctx.forEachStack.push({ nodeId: node.id, elemLocal: elemL, idxLocal: fiL });
  em.block(() => {
    em.loop(() => {
      em.localGet(fiL); em.localGet(lenLocal); em.op(OP_I32_GE_S); em.brIf(1);
      // element = scratch[fi]
      em.localGet(baseLocal); em.localGet(fiL); em.i32Const(4); em.op(OP_I32_MUL); em.op(OP_I32_ADD); em.i32Load(); em.localSet(elemL);
      // clear volatile caches so body values re-emit with the current element/index
      clearVolatileCache(ctx);
      compileFlowChain(ctx, node.id, 'body');
      em.localGet(fiL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(fiL);
      em.br(0);
    });
  });
  ctx.forEachStack.pop();
  clearVolatileCache(ctx);
}

/** Drop cached values for volatile nodes so they re-emit at the next use. */
function clearVolatileCache(ctx: AgentWasmCtx): void {
  for (const k of [...ctx.valueCache.keys()]) {
    const nid = k.slice(0, k.lastIndexOf(':'));
    if (ctx.volatileNodes.has(nid)) ctx.valueCache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Volatility analysis — a node is volatile (don't cache across a forEach
// iteration) iff it transitively reads a forEach element/index OR a getVariable
// (mutated by setVariable). Mirrors the JS compiler's NEVER_INVARIANT + volatile
// rationale for the supported set.
// ---------------------------------------------------------------------------

function computeVolatile(ctx: AgentWasmCtx): void {
  const { nodeMap, inputToSource } = ctx.adj;
  // Seeds: ONLY forEachInArray (its per-iteration element/index outputs). A node
  // is volatile iff it transitively reads a forEach element/index — its cached
  // value must be dropped at each forEach iteration boundary so it re-emits with
  // the current element. getRandom / getVariable are NOT inherently volatile (they
  // emit once per agent + cache); they become volatile only if they read element/
  // index (they don't in the supported shapes). This mirrors the JS compiler's
  // forEach-element-dependent analysis.
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

// ===========================================================================
// W1 — the WASM FORCE PASS (the boost lever).
//
// The agent force integrator — the engine code that, today, runs in JS even on
// the WASM agent target. It is the HOTTEST per-step code (the per-neighbour-pair
// double loop), so porting it to WASM is the cap on the WASM agent speedup.
//
// This emits a SECOND export `forcePass` in the SAME agent module, reading/writing
// the wasmBacked AgentStore at the `computeAgentMemoryLayout` baked offsets — the
// SAME memory the JS engine reads (zero glue; the JS typed arrays are views over
// it). It runs RIGHT AFTER the behaviour (same step), reusing the in-memory hash
// the worker already copied in for `getNearbyAgents` (no extra copy).
//
// It is a faithful byte-for-byte port of `runAgentStep`'s force loop
// (sim.worker.ts) — the 3×3(×3) neighbour stencil (soft-sphere repulsion/adhesion
// + density) → bond springs → velocity integration (momentum, maxSpeed, drag, dt)
// → xNext/yNext[/zNext] → growth ramp. f64 throughout, so JS↔WASM is bit-exact.
//
// The structural phase + the hash build STAY in JS (run once per step, not per
// neighbour-pair). The position double-buffer swap stays in `swapPositions`
// (a copy-into under wasmBacked views, B10).
//
// MIRRORED SCALAR-CONFIG ABI (the worker MIRRORS this in runAgentStep — see
// buildForcePassArgs there; the param↔arg pair is the silent-desync class):
//   (highWater, hashValid, nBinsX, nBinsY, nBinsZ : i32,
//    binSizeX, binSizeY, binSizeZ : f64,
//    dtOverEta, muR, muA, range, momentum, maxSpeed, growthRate : f64,
//    W, H, D : f64, bonding, torus : i32)
// `dtOverEta = dt / eta` is passed PRECOMPUTED (one division, bit-identical to JS's
// per-iteration `(dt / eta)` since the operands are step-constant). `bonding`
// gates BOTH the soft-sphere force (JS `engineForces`) AND the bond springs AND
// the growth ramp (JS passes `growthRate=0` when off, but the gate keeps it tidy).
// ===========================================================================

/** The 22 force-pass params (the worker mirrors this order exactly). */
const FORCE_PASS_PARAMS: ('i32' | 'f64')[] = [
  'i32', 'i32', 'i32', 'i32', 'i32',     // highWater, hashValid, nBinsX, nBinsY, nBinsZ
  'f64', 'f64', 'f64',                   // binSizeX, binSizeY, binSizeZ
  'f64', 'f64', 'f64', 'f64', 'f64', 'f64', 'f64', // dtOverEta, muR, muA, range, momentum, maxSpeed, growthRate
  'f64', 'f64', 'f64',                   // W, H, D
  'i32', 'i32',                          // bonding, torus
];

interface ForcePassParamIdx {
  highWater: number; hashValid: number; nBinsX: number; nBinsY: number; nBinsZ: number;
  binSizeX: number; binSizeY: number; binSizeZ: number;
  dtOverEta: number; muR: number; muA: number; range: number;
  momentum: number; maxSpeed: number; growthRate: number;
  W: number; H: number; D: number;
  bonding: number; torus: number;
}

/** Emit the force-pass function body onto `em`. Reads the wasmBacked AgentStore at
 *  `layout` offsets; `is3d` selects the 3-axis branch (2D is the verbatim 2D fast
 *  path — a separate code path, NOT a branchless always-0-dz body, mirroring the
 *  JS loop's `if (is3d)` split so the 2D arithmetic + stencil count are identical).
 *  `fmodFuncIdx` is the host `env.fmod = (a,b)=>a%b` import — used for the torus
 *  position wrap so it is BIT-EXACT to JS's native `%` (WASM has no f64 rem opcode;
 *  reconstructing `a - trunc(a/b)*b` rounds twice and would drift). */
function emitForcePass(em: WasmEmitter, layout: AgentMemoryLayout, is3d: boolean, P: ForcePassParamIdx, fmodFuncIdx: number): void {
  const L = layout;
  const aliveOff = L.u8['alive']!;
  // half-spans: halfW = W / 2 (mirrors JS `W / 2` exactly).
  const halfW = em.allocLocal(F64); em.localGet(P.W); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(halfW);
  const halfH = em.allocLocal(F64); em.localGet(P.H); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(halfH);
  const halfD = em.allocLocal(F64); if (is3d) { em.localGet(P.D); em.f64Const(2); em.op(OP_F64_DIV); em.localSet(halfD); } else { em.f64Const(0); em.localSet(halfD); }

  const i = em.allocLocal(I32);

  // Per-agent scratch locals (reused each iteration).
  const xi = em.allocLocal(F64), yi = em.allocLocal(F64), zi = em.allocLocal(F64), ri = em.allocLocal(F64);
  const fx = em.allocLocal(F64), fy = em.allocLocal(F64), fz = em.allocLocal(F64);
  const dens = em.allocLocal(F64);
  const bx = em.allocLocal(I32), by = em.allocLocal(I32), bz = em.allocLocal(I32);
  const ddx = em.allocLocal(I32), ddy = em.allocLocal(I32), ddz = em.allocLocal(I32);
  const nbx = em.allocLocal(I32), nby = em.allocLocal(I32), nbz = em.allocLocal(I32);
  const bidx = em.allocLocal(I32), pL = em.allocLocal(I32), endL = em.allocLocal(I32), jL = em.allocLocal(I32);
  const dx = em.allocLocal(F64), dy = em.allocLocal(F64), dz = em.allocLocal(F64);
  const d2 = em.allocLocal(F64), sij = em.allocLocal(F64), rmax = em.allocLocal(F64), d = em.allocLocal(F64), Fl = em.allocLocal(F64), kl = em.allocLocal(F64);
  const bc = em.allocLocal(I32), baseB = em.allocLocal(I32), bk = em.allocLocal(I32), pp = em.allocLocal(I32);
  const vxi = em.allocLocal(F64), vyi = em.allocLocal(F64), vzi = em.allocLocal(F64), sp = em.allocLocal(F64), sc = em.allocLocal(F64);
  const nx = em.allocLocal(F64), ny = em.allocLocal(F64), nz = em.allocLocal(F64);
  const tr = em.allocLocal(F64), cur = em.allocLocal(F64), dd = em.allocLocal(F64), stepRad = em.allocLocal(F64);

  const off = {
    x: L.f64['x']!, y: L.f64['y']!, z: L.f64['z']!,
    xN: L.f64['xNext']!, yN: L.f64['yNext']!, zN: L.f64['zNext']!,
    vx: L.f64['vx']!, vy: L.f64['vy']!, vz: L.f64['vz']!,
    fX: L.f64['forceX']!, fY: L.f64['forceY']!, fZ: L.f64['forceZ']!,
    rad: L.f64['radius']!, tgt: L.f64['targetRadius']!, age: L.f64['age']!, dens: L.f64['density']!,
  };

  // --- the torus fold of a delta `dLocal` against span `spanLocal` + its half
  //     `halfLocal`: if (d > halfSpan) d -= span; else if (d < -halfSpan) d += span.
  const foldDelta = (dLocal: number, spanLocal: number, halfLocal: number) => {
    em.localGet(dLocal); em.localGet(halfLocal); em.op(OP_F64_GT);
    em.ifThenElse(
      () => { em.localGet(dLocal); em.localGet(spanLocal); em.op(OP_F64_SUB); em.localSet(dLocal); },
      () => {
        em.localGet(dLocal); em.localGet(halfLocal); em.op(OP_F64_NEG); em.op(OP_F64_LT);
        em.ifThen(() => { em.localGet(dLocal); em.localGet(spanLocal); em.op(OP_F64_ADD); em.localSet(dLocal); });
      },
    );
  };

  // --- the candidate body for neighbour j held in `jL` (soft-sphere + density). It
  //     computes dx/dy[/dz] (torus-folded), d2, the cutoff, density++, and the
  //     graph-`engineForces`-gated soft-sphere force into fx/fy[/fz]. Mirrors the
  //     JS inner block verbatim. `skipSelf` controls whether to skip j===i (hash:
  //     yes; the JS hash path also skips dead j implicitly via the bin membership,
  //     so no alive check here — bins only hold alive agents; the all-pairs path
  //     adds the alive check before calling this). ---
  const candidate = (skipDead: boolean) => {
    // if (j === i) skip (the hash + all-pairs both skip self)
    em.localGet(jL); em.localGet(i); em.op(OP_I32_NE);
    em.ifThen(() => {
      const run = () => {
        // dx = x[j]-xi; dy = y[j]-yi [; dz = z[j]-zi]
        pushF64Elem(em, off.x, jL); em.localGet(xi); em.op(OP_F64_SUB); em.localSet(dx);
        pushF64Elem(em, off.y, jL); em.localGet(yi); em.op(OP_F64_SUB); em.localSet(dy);
        if (is3d) { pushF64Elem(em, off.z, jL); em.localGet(zi); em.op(OP_F64_SUB); em.localSet(dz); }
        em.localGet(P.torus);
        em.ifThen(() => {
          foldDelta(dx, P.W, halfW);
          foldDelta(dy, P.H, halfH);
          if (is3d) foldDelta(dz, P.D, halfD);
        });
        // d2 = dx*dx + dy*dy [+ dz*dz]
        em.localGet(dx); em.localGet(dx); em.op(OP_F64_MUL);
        em.localGet(dy); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
        if (is3d) { em.localGet(dz); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
        em.localSet(d2);
        // sij = ri + rad[j]; rmax = range * sij
        em.localGet(ri); pushF64Elem(em, off.rad, jL); em.op(OP_F64_ADD); em.localSet(sij);
        em.localGet(P.range); em.localGet(sij); em.op(OP_F64_MUL); em.localSet(rmax);
        // if (d2 === 0 || d2 >= rmax*rmax) continue; — i.e. only proceed when
        //   d2 !== 0 && d2 < rmax*rmax
        em.localGet(d2); em.f64Const(0); em.op(OP_F64_NE);                  // d2 != 0
        em.localGet(d2); em.localGet(rmax); em.localGet(rmax); em.op(OP_F64_MUL); em.op(OP_F64_LT); // d2 < rmax^2
        em.op(OP_I32_AND);
        em.ifThen(() => {
          // dens++
          em.localGet(dens); em.f64Const(1); em.op(OP_F64_ADD); em.localSet(dens);
          // if (engineForces=bonding) { d = sqrt(d2); F = ((d<sij)?muR:muA)*(d-sij); k=F/d; fx+=k*dx; ... }
          em.localGet(P.bonding);
          em.ifThen(() => {
            em.localGet(d2); em.op(OP_F64_SQRT); em.localSet(d);
            // F = ((d < sij) ? muR : muA) * (d - sij)
            em.localGet(d); em.localGet(sij); em.op(OP_F64_LT);
            em.ifThenElse(
              () => { em.localGet(P.muR); em.localSet(Fl); },
              () => { em.localGet(P.muA); em.localSet(Fl); },
            );
            em.localGet(Fl); em.localGet(d); em.localGet(sij); em.op(OP_F64_SUB); em.op(OP_F64_MUL); em.localSet(Fl);
            // k = F / d
            em.localGet(Fl); em.localGet(d); em.op(OP_F64_DIV); em.localSet(kl);
            // fx += k*dx; fy += k*dy [; fz += k*dz]
            em.localGet(fx); em.localGet(kl); em.localGet(dx); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fx);
            em.localGet(fy); em.localGet(kl); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fy);
            if (is3d) { em.localGet(fz); em.localGet(kl); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fz); }
          });
        });
      };
      if (skipDead) {
        // all-pairs path: if (!alive[j]) skip
        em.localGet(jL); em.i32Const(aliveOff); em.op(OP_I32_ADD); em.i32Load8U();
        em.ifThen(run);
      } else {
        run();
      }
    });
  };

  // --- a 1-D wrap/range helper for a neighbour-bin coordinate already in `nbLocal`:
  //     torus → ((nb % n) + n) % n; else range-check sets a `skip` flag.            ---
  const wrapBin = (nbLocal: number, nLocal: number, skipLocal: number) => {
    em.localGet(P.torus);
    em.ifThenElse(
      () => { wrapMod(em, nbLocal, nLocal); },
      () => { rangeBad(em, nbLocal, nLocal, skipLocal); },
    );
  };

  // --- store-address helper: push (regionOffset + i*8) as the f64 store address. ---
  const addr = (regionOffset: number, idxLocal: number) => pushF64ElemAddr(em, regionOffset, idxLocal);

  // ===== the per-agent loop =====
  em.i32Const(0); em.localSet(i);
  em.block(() => {
    em.loop(() => {
      em.localGet(i); em.localGet(P.highWater); em.op(OP_I32_GE_S); em.brIf(1);
      // if (alive[i]) { <body> } else { xN[i]=x[i]; yN[i]=y[i]; [zN[i]=z[i];] }
      em.i32Const(aliveOff); em.localGet(i); em.op(OP_I32_ADD); em.i32Load8U();
      em.ifThenElse(
        () => emitForceBody(),
        () => {
          // dead: copy current position into the next buffer (so swapPositions keeps it)
          addr(off.xN, i); pushF64Elem(em, off.x, i); em.f64Store();
          addr(off.yN, i); pushF64Elem(em, off.y, i); em.f64Store();
          if (is3d) { addr(off.zN, i); pushF64Elem(em, off.z, i); em.f64Store(); }
        },
      );
      em.localGet(i); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(i);
      em.br(0);
    });
  });

  // --- the live-agent force body (factored so the loop stays readable) ---
  function emitForceBody(): void {
    // xi=x[i]; yi=y[i]; [zi=z[i];] ri=rad[i]
    pushF64Elem(em, off.x, i); em.localSet(xi);
    pushF64Elem(em, off.y, i); em.localSet(yi);
    if (is3d) { pushF64Elem(em, off.z, i); em.localSet(zi); }
    pushF64Elem(em, off.rad, i); em.localSet(ri);
    // fx=forceX[i]; fy=forceY[i]; [fz=forceZ[i];] dens=0
    pushF64Elem(em, off.fX, i); em.localSet(fx);
    pushF64Elem(em, off.fY, i); em.localSet(fy);
    if (is3d) { pushF64Elem(em, off.fZ, i); em.localSet(fz); }
    em.f64Const(0); em.localSet(dens);

    // --- neighbour pass: hash stencil when hashValid, else all-pairs ---
    em.localGet(P.hashValid);
    em.ifThenElse(
      () => emitForceStencil(),
      () => {
        // all-pairs: for (j=0; j<highWater; j++) candidate(skipDead=true)
        em.i32Const(0); em.localSet(jL);
        em.block(() => {
          em.loop(() => {
            em.localGet(jL); em.localGet(P.highWater); em.op(OP_I32_GE_S); em.brIf(1);
            candidate(true);
            em.localGet(jL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(jL);
            em.br(0);
          });
        });
      },
    );
    // density[i] = dens
    addr(off.dens, i); em.localGet(dens); em.f64Store();

    // --- bond springs (gated on bonding && bondCount>0) ---
    // bc = bondCount[i]
    em.localGet(i); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(L.i32['bondCount']!); em.op(OP_I32_ADD); em.i32Load(); em.localSet(bc);
    em.localGet(P.bonding);
    em.localGet(bc); em.i32Const(0); em.op(OP_I32_GT_S);
    em.op(OP_I32_AND);
    em.ifThen(() => emitBondSprings());

    // --- integrate: vxi = momentum*vx[i] + dtOverEta*fx; ... ; maxSpeed cap ---
    em.localGet(P.momentum); pushF64Elem(em, off.vx, i); em.op(OP_F64_MUL); em.localGet(P.dtOverEta); em.localGet(fx); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(vxi);
    em.localGet(P.momentum); pushF64Elem(em, off.vy, i); em.op(OP_F64_MUL); em.localGet(P.dtOverEta); em.localGet(fy); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(vyi);
    if (is3d) { em.localGet(P.momentum); pushF64Elem(em, off.vz, i); em.op(OP_F64_MUL); em.localGet(P.dtOverEta); em.localGet(fz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(vzi); }
    // if (maxSpeed > 0) { sp = sqrt(v·v); if (sp > maxSpeed) { sc = maxSpeed/sp; v *= sc } }
    em.localGet(P.maxSpeed); em.f64Const(0); em.op(OP_F64_GT);
    em.ifThen(() => {
      em.localGet(vxi); em.localGet(vxi); em.op(OP_F64_MUL);
      em.localGet(vyi); em.localGet(vyi); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
      if (is3d) { em.localGet(vzi); em.localGet(vzi); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
      em.op(OP_F64_SQRT); em.localSet(sp);
      em.localGet(sp); em.localGet(P.maxSpeed); em.op(OP_F64_GT);
      em.ifThen(() => {
        em.localGet(P.maxSpeed); em.localGet(sp); em.op(OP_F64_DIV); em.localSet(sc);
        em.localGet(vxi); em.localGet(sc); em.op(OP_F64_MUL); em.localSet(vxi);
        em.localGet(vyi); em.localGet(sc); em.op(OP_F64_MUL); em.localSet(vyi);
        if (is3d) { em.localGet(vzi); em.localGet(sc); em.op(OP_F64_MUL); em.localSet(vzi); }
      });
    });
    // vx[i]=vxi; ...
    addr(off.vx, i); em.localGet(vxi); em.f64Store();
    addr(off.vy, i); em.localGet(vyi); em.f64Store();
    if (is3d) { addr(off.vz, i); em.localGet(vzi); em.f64Store(); }

    // nx = xi + vxi; ny = yi + vyi; [nz = zi + vzi;]
    em.localGet(xi); em.localGet(vxi); em.op(OP_F64_ADD); em.localSet(nx);
    em.localGet(yi); em.localGet(vyi); em.op(OP_F64_ADD); em.localSet(ny);
    if (is3d) { em.localGet(zi); em.localGet(vzi); em.op(OP_F64_ADD); em.localSet(nz); }
    // torus wrap or clamp
    em.localGet(P.torus);
    em.ifThenElse(
      () => {
        wrapPos(nx, P.W);
        wrapPos(ny, P.H);
        if (is3d) wrapPos(nz, P.D);
      },
      () => {
        clampPos(nx, P.W);
        clampPos(ny, P.H);
        if (is3d) clampPos(nz, P.D);
      },
    );
    // xN[i]=nx; yN[i]=ny; [zN[i]=nz;]
    addr(off.xN, i); em.localGet(nx); em.f64Store();
    addr(off.yN, i); em.localGet(ny); em.f64Store();
    if (is3d) { addr(off.zN, i); em.localGet(nz); em.f64Store(); }

    // age[i] = age[i] + 1
    addr(off.age, i); pushF64Elem(em, off.age, i); em.f64Const(1); em.op(OP_F64_ADD); em.f64Store();

    // growth: tr=targetRadius[i]; cur=radius[i]; if (tr !== cur) { dd=tr-cur;
    //   radius[i] = abs(dd)<=growthRate ? tr : cur + sign(dd)*growthRate }
    pushF64Elem(em, off.tgt, i); em.localSet(tr);
    pushF64Elem(em, off.rad, i); em.localSet(cur);
    em.localGet(tr); em.localGet(cur); em.op(OP_F64_NE);
    em.ifThen(() => {
      em.localGet(tr); em.localGet(cur); em.op(OP_F64_SUB); em.localSet(dd);
      // stepRad = abs(dd) <= growthRate ? tr : cur + sign(dd)*growthRate
      em.localGet(dd); em.op(OP_F64_ABS); em.localGet(P.growthRate); em.op(OP_F64_LE);
      em.ifThenElse(
        () => { em.localGet(tr); em.localSet(stepRad); },
        () => {
          // sign(dd) — dd != 0 here, so dd>0 ? +growthRate : -growthRate
          em.localGet(dd); em.f64Const(0); em.op(OP_F64_GT);
          em.ifThenElse(
            () => { em.localGet(cur); em.localGet(P.growthRate); em.op(OP_F64_ADD); em.localSet(stepRad); },
            () => { em.localGet(cur); em.localGet(P.growthRate); em.op(OP_F64_SUB); em.localSet(stepRad); },
          );
        },
      );
      addr(off.rad, i); em.localGet(stepRad); em.f64Store();
    });
  }

  // --- the 3×3(×3) hash stencil over the in-memory binStart/binAgents ---
  function emitForceStencil(): void {
    const binStartOff = L.hashBinStartOffset, binAgentsOff = L.hashBinAgentsOffset;
    // bx = clamp((xi/binSizeX)|0, 0, nBinsX-1); same by[,bz]
    clampToBin(xi, P.binSizeX, P.nBinsX, bx);
    clampToBin(yi, P.binSizeY, P.nBinsY, by);
    if (is3d) clampToBin(zi, P.binSizeZ, P.nBinsZ, bz); else { em.i32Const(0); em.localSet(bz); }

    const innerBin = () => {
      // nbx = bx+ddx; nby = by+ddy; [nbz = bz+ddz]
      em.localGet(bx); em.localGet(ddx); em.op(OP_I32_ADD); em.localSet(nbx);
      em.localGet(by); em.localGet(ddy); em.op(OP_I32_ADD); em.localSet(nby);
      if (is3d) { em.localGet(bz); em.localGet(ddz); em.op(OP_I32_ADD); em.localSet(nbz); }
      const skipL = em.allocLocal(I32); em.i32Const(0); em.localSet(skipL);
      wrapBin(nbx, P.nBinsX, skipL);
      wrapBin(nby, P.nBinsY, skipL);
      if (is3d) wrapBin(nbz, P.nBinsZ, skipL);
      em.localGet(skipL); em.op(OP_I32_EQZ);
      em.ifThen(() => {
        // b = is3d ? (nbz*nBinsY + nby)*nBinsX + nbx : nby*nBinsX + nbx
        if (is3d) {
          em.localGet(nbz); em.localGet(P.nBinsY); em.op(OP_I32_MUL); em.localGet(nby); em.op(OP_I32_ADD);
          em.localGet(P.nBinsX); em.op(OP_I32_MUL); em.localGet(nbx); em.op(OP_I32_ADD); em.localSet(bidx);
        } else {
          em.localGet(nby); em.localGet(P.nBinsX); em.op(OP_I32_MUL); em.localGet(nbx); em.op(OP_I32_ADD); em.localSet(bidx);
        }
        // p = binStart[b]; end = binStart[b+1]
        em.localGet(bidx); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binStartOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(pL);
        em.localGet(bidx); em.i32Const(1); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binStartOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(endL);
        em.block(() => {
          em.loop(() => {
            em.localGet(pL); em.localGet(endL); em.op(OP_I32_GE_S); em.brIf(1);
            // j = binAgents[p]
            em.localGet(pL); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(binAgentsOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(jL);
            candidate(false);
            em.localGet(pL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(pL);
            em.br(0);
          });
        });
      });
    };

    // for (ddz in [-1,1]) for (ddy) for (ddx) innerBin    (ddz fixed 0 in 2D)
    const ddLoop = (varL: number, body: () => void) => {
      em.i32Const(-1); em.localSet(varL);
      em.block(() => {
        em.loop(() => {
          em.localGet(varL); em.i32Const(1); em.op(OP_I32_GT_S); em.brIf(1);
          body();
          em.localGet(varL); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(varL);
          em.br(0);
        });
      });
    };
    if (is3d) ddLoop(ddz, () => ddLoop(ddy, () => ddLoop(ddx, innerBin)));
    else { em.i32Const(0); em.localSet(ddz); ddLoop(ddy, () => ddLoop(ddx, innerBin)); }
  }

  // bIdx-out: store clamp((coord/size)|0, 0, n-1) into outLocal.
  function clampToBin(coordL: number, sizeL: number, nL: number, outLocal: number): void {
    em.localGet(coordL); em.localGet(sizeL); em.op(OP_F64_DIV); em.f64ToI32(); em.localSet(outLocal);
    em.localGet(outLocal); em.i32Const(0); em.op(OP_I32_LT_S);
    em.ifThenElse(
      () => { em.i32Const(0); em.localSet(outLocal); },
      () => {
        em.localGet(outLocal); em.localGet(nL); em.op(OP_I32_GE_S);
        em.ifThen(() => { em.localGet(nL); em.i32Const(1); em.op(OP_I32_SUB); em.localSet(outLocal); });
      },
    );
  }

  // --- bond springs over the agent's bond list (mirrors the JS bond block) ---
  function emitBondSprings(): void {
    // base = i * maxBonds
    em.localGet(i); em.i32Const(L.maxBonds); em.op(OP_I32_MUL); em.localSet(baseB);
    const bpOff = L.bondI32['bondPartner']!, bpeOff = L.bondI32['bondPartnerEpoch']!;
    const brlOff = L.bondF64['bondRestLength']!, bstOff = L.bondF64['bondStiffness']!;
    const epochOff = L.i32['epoch']!;
    em.i32Const(0); em.localSet(bk);
    em.block(() => {
      em.loop(() => {
        em.localGet(bk); em.localGet(bc); em.op(OP_I32_GE_S); em.brIf(1);
        // p = bondPartner[base+bk]
        em.localGet(baseB); em.localGet(bk); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(bpOff); em.op(OP_I32_ADD); em.i32Load(); em.localSet(pp);
        // if (p >= 0 && p < highWater && alive[p]) { ... }  (else: just skip → bk++)
        em.localGet(pp); em.i32Const(0); em.op(OP_I32_GE_S);
        em.localGet(pp); em.localGet(P.highWater); em.op(OP_I32_LT_S); em.op(OP_I32_AND);
        em.ifThen(() => {
          em.localGet(pp); em.i32Const(aliveOff); em.op(OP_I32_ADD); em.i32Load8U();
          em.ifThen(() => {
            // if (bondPartnerEpoch[base+bk] === epoch[p]) { ... }
            em.localGet(baseB); em.localGet(bk); em.op(OP_I32_ADD); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(bpeOff); em.op(OP_I32_ADD); em.i32Load();
            em.localGet(pp); em.i32Const(4); em.op(OP_I32_MUL); em.i32Const(epochOff); em.op(OP_I32_ADD); em.i32Load();
            em.op(OP_I32_EQ); // (need OP_I32_EQ)
            em.ifThen(() => {
              // dx=x[p]-xi; dy=y[p]-yi; [dz=z[p]-zi]
              pushF64Elem(em, off.x, pp); em.localGet(xi); em.op(OP_F64_SUB); em.localSet(dx);
              pushF64Elem(em, off.y, pp); em.localGet(yi); em.op(OP_F64_SUB); em.localSet(dy);
              if (is3d) { pushF64Elem(em, off.z, pp); em.localGet(zi); em.op(OP_F64_SUB); em.localSet(dz); }
              em.localGet(P.torus);
              em.ifThen(() => { foldDelta(dx, P.W, halfW); foldDelta(dy, P.H, halfH); if (is3d) foldDelta(dz, P.D, halfD); });
              // d2b = dx*dx + dy*dy [+ dz*dz]; if (d2b === 0) skip
              em.localGet(dx); em.localGet(dx); em.op(OP_F64_MUL);
              em.localGet(dy); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD);
              if (is3d) { em.localGet(dz); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); }
              em.localSet(d2);
              em.localGet(d2); em.f64Const(0); em.op(OP_F64_NE);
              em.ifThen(() => {
                em.localGet(d2); em.op(OP_F64_SQRT); em.localSet(d);
                // F = bondStiffness[base+bk] * (d - bondRestLength[base+bk])
                em.localGet(baseB); em.localGet(bk); em.op(OP_I32_ADD); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(bstOff); em.op(OP_I32_ADD); em.f64Load();
                em.localGet(d);
                em.localGet(baseB); em.localGet(bk); em.op(OP_I32_ADD); em.i32Const(8); em.op(OP_I32_MUL); em.i32Const(brlOff); em.op(OP_I32_ADD); em.f64Load();
                em.op(OP_F64_SUB);
                em.op(OP_F64_MUL); em.localSet(Fl);
                // k = F / d; fx += k*dx; ...
                em.localGet(Fl); em.localGet(d); em.op(OP_F64_DIV); em.localSet(kl);
                em.localGet(fx); em.localGet(kl); em.localGet(dx); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fx);
                em.localGet(fy); em.localGet(kl); em.localGet(dy); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fy);
                if (is3d) { em.localGet(fz); em.localGet(kl); em.localGet(dz); em.op(OP_F64_MUL); em.op(OP_F64_ADD); em.localSet(fz); }
              });
            });
          });
        });
        em.localGet(bk); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(bk);
        em.br(0);
      });
    });
  }

  // wrap a position local into [0, span): nx = ((nx % W) + W) % W — JS native `%`
  // (exact fmod), reproduced via the host `env.fmod` import so it is BIT-EXACT.
  //
  // NB: a "skip the wrap when n ∈ [0, span)" fast path is NOT bit-exact — for a
  // non-power-of-2 span, JS's `(n + W)` rounds, so `((n % W) + W) % W` does NOT
  // equal `n` in the low bits even for an in-range n. The unconditional host-fmod
  // is the only path that matches JS exactly (verified: the fast path diverged at
  // ~1e-12). WASM has no f64 rem opcode; an inline musl-style i64 fmod would avoid
  // the host call but needs ~15 new i64 encoder ops — deferred (the wrap is once
  // per agent, not per neighbour pair, so its cost is secondary).
  function wrapPos(nLocal: number, spanLocal: number): void {
    fmod(nLocal, spanLocal);                 // n = n % span
    em.localGet(nLocal); em.localGet(spanLocal); em.op(OP_F64_ADD); em.localSet(nLocal); // n += span
    fmod(nLocal, spanLocal);                 // n = n % span
  }
  // n = n % span  (JS `%` — exact fmod via the host import; WASM has no f64 rem).
  function fmod(nLocal: number, spanLocal: number): void {
    em.localGet(nLocal); em.localGet(spanLocal); em.emit(opCall(fmodFuncIdx));
    em.localSet(nLocal);
  }
  // clamp a position local into [0, span]: n = n<0?0 : n>span?span : n
  function clampPos(nLocal: number, spanLocal: number): void {
    em.localGet(nLocal); em.f64Const(0); em.op(OP_F64_LT);
    em.ifThenElse(
      () => { em.f64Const(0); em.localSet(nLocal); },
      () => {
        em.localGet(nLocal); em.localGet(spanLocal); em.op(OP_F64_GT);
        em.ifThen(() => { em.localGet(spanLocal); em.localSet(nLocal); });
      },
    );
  }
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

/** TRUE iff EVERY node in the (flattened) agent graph is in the supported set AND
 *  the model has Agents enabled AND the structural constraints hold (≤ the
 *  reserved getNearbyAgents scratch slots; forEach arrays come from
 *  getNearbyAgents; only SCALAR Local Variables; getRandom is not options-mode). */
export function isAgentGraphWasmSupported(model: CAModel | undefined | null): boolean {
  if (!model || !model.topologyMode?.agents) return false;
  const nodes = model.agentGraphNodes ?? [];
  const edges = model.agentGraphEdges ?? [];
  if (!nodes.some(n => n.data.nodeType === 'behaviourStep')) return false;
  const flat = flattenAgentGraph(nodes, edges, model);
  if (flat.error) return false;

  let nearbyCount = 0;
  for (const n of flat.nodes) {
    const t = n.data.nodeType;
    if (t === 'macroInput' || t === 'macroOutput' || t === 'macro') return false;
    if (!AGENT_WASM_SUPPORTED_TYPES.has(t)) return false;
    const cfg = (n.data.config ?? {}) as Record<string, unknown>;
    if (t === 'getNearbyAgents') nearbyCount++;
    if (t === 'statement') {
      // `operation`, not `operator` (matches emitCompare + StatementNode). The
      // wrong key meant the between/notBetween reject never fired → a between
      // Compare reached emitCompare (which has no between path) and emitted ==.
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
      if (rt === 'options') return false; // options mode (array source) is PR6b-3
    }
  }
  if (nearbyCount > AGENT_NEARBY_SCRATCH_SLOTS) return false;
  // Local Variables: only SCALAR variables are supported (array variables +
  // setArrayElement are PR6b-3). If the model has any array variable AND a
  // getVariable/setVariable touches it, the agent graph can't be safely compiled.
  // Conservative: reject when any AGENT variable is an array (the agent graph may
  // reference it). Generic Agent Platform: the agent graph resolves variables
  // against agentVariables — a cell-only array variable no longer blocks the
  // agent WASM compile (the documented false-positive fix).
  const hasArrayVar = (model.agentVariables ?? []).some(v => v.kind === 'array');
  const usesVar = flat.nodes.some(n => n.data.nodeType === 'getVariable' || n.data.nodeType === 'setVariable');
  if (hasArrayVar && usesVar) return false;
  // forEachInArray's array input must come from getNearbyAgents (the only
  // supported array producer).
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

/** Compile the agent behaviour graph to a self-contained WASM module. Returns
 *  `{ bytes, pages, layout }`. On an unsupported graph it returns an empty result
 *  + an error (the worker keeps the JS path). BEHAVIOUR-ONLY (no division module
 *  yet — PR6b-3). */
export function compileAgentGraphWasm(
  agentNodes: GraphNode[],
  agentEdges: GraphEdge[],
  model: CAModel,
  agentLayout: AgentMemoryLayout,
): AgentWasmResult {
  const empty = (error: string): AgentWasmResult => ({ bytes: new Uint8Array(), pages: agentLayout.pages, layout: agentLayout, supportedTypes: [], error });
  if (!model.topologyMode?.agents) return empty('Agents topology not enabled.');

  const flat = flattenAgentGraph(agentNodes, agentEdges, model);
  if (flat.error) return empty(flat.error);
  const nodes = flat.nodes, edges = flat.edges;

  const behaviourNode = nodes.find(n => n.data.nodeType === 'behaviourStep');
  if (!behaviourNode) return empty('No Behaviour Step node in the agent graph.');

  // Gate (defensive — the caller already checked isAgentGraphWasmSupported).
  const seen = new Set<string>();
  let nearbyCount = 0;
  for (const n of nodes) {
    seen.add(n.data.nodeType);
    if (!AGENT_WASM_SUPPORTED_TYPES.has(n.data.nodeType)) return empty(`agentWasm: unsupported node '${n.data.nodeType}' (falls back to JS).`);
    if (n.data.nodeType === 'getNearbyAgents') nearbyCount++;
  }
  if (nearbyCount > agentLayout.nearbyScratchSlots) return empty(`agentWasm: too many getNearbyAgents (${nearbyCount} > ${agentLayout.nearbyScratchSlots} reserved slots).`);

  const adj = buildAdjacency(nodes, edges);
  const is3d = is3dModel(model);

  // Behaviour signature (the worker's call MIRRORS this — see runAgentStep):
  //   (highWater, hashValid, nBinsX, nBinsY, nBinsZ : i32,
  //    binSizeX, binSizeY, binSizeZ : f64,
  //    fieldW, fieldH, fieldD : f64, fieldTorus : i32)
  const PARAMS: ('i32' | 'f64')[] = ['i32', 'i32', 'i32', 'i32', 'i32', 'f64', 'f64', 'f64', 'f64', 'f64', 'f64', 'i32'];
  const em = new WasmEmitter(PARAMS.length);

  // Param indices.
  const P_highWater = 0, P_hashValid = 1, P_nBinsX = 2, P_nBinsY = 3, P_nBinsZ = 4;
  const P_binSizeX = 5, P_binSizeY = 6, P_binSizeZ = 7;
  const P_fieldW = 8, P_fieldH = 9, P_fieldD = 10, P_fieldTorus = 11;

  const ctx: AgentWasmCtx = {
    adj, layout: agentLayout, is3d, em,
    rsLocal: -1, idxLocal: -1,
    varLocals: new Map<string, number>(),
    valueCache: new Map<string, ValueRef>(),
    volatileNodes: new Set<string>(),
    nearbyScratchSlot: new Map<string, number>(),
    forEachStack: [],
    fieldWLocal: P_fieldW, fieldHLocal: P_fieldH, fieldDLocal: P_fieldD, fieldTorusLocal: P_fieldTorus,
    highWaterLocal: P_highWater, hashValidLocal: P_hashValid,
    nBinsXLocal: P_nBinsX, nBinsYLocal: P_nBinsY, nBinsZLocal: P_nBinsZ,
    binSizeXLocal: P_binSizeX, binSizeYLocal: P_binSizeY, binSizeZLocal: P_binSizeZ,
  };

  // Assign getNearbyAgents scratch slots.
  let slot = 0;
  for (const n of nodes) if (n.data.nodeType === 'getNearbyAgents') ctx.nearbyScratchSlot.set(n.id, slot++);

  // Volatility analysis (don't cache element/index/getVariable-derived values).
  computeVolatile(ctx);

  // Patch compileValueNode to resolve forEach element/index ports (they're not
  // in the switch). We do this by overriding the resolver via a closure check.

  try {
    // --- function locals: RNG + idx ---
    const rsLocal = em.allocLocal(I32);
    ctx.rsLocal = rsLocal;
    // _rs = u32[rngStateOffset] || 0x12345678  (read once at function top — AW-RNG;
    // mirrors JS `_rs = _rngState[0] || 0x12345678` exactly so a 0 seed agrees).
    em.i32Const(0); em.i32Load(agentLayout.rngStateOffset, 2); em.localSet(rsLocal);
    em.localGet(rsLocal); em.op(OP_I32_EQZ);
    em.ifThen(() => { em.i32Const(0x12345678); em.localSet(rsLocal); });
    // Local Variables — one f64 local per SCALAR AGENT variable (reset per agent
    // at loop top). The agent graph's variables live on model.agentVariables.
    for (const v of (model.agentVariables ?? [])) {
      if (v.kind !== 'scalar') continue;
      ctx.varLocals.set(v.id, em.allocLocal(F64));
    }
    const idxLocal = em.allocLocal(I32);
    ctx.idxLocal = idxLocal;

    // for (idx = 0; idx < highWater; idx++) { if (alive[idx]==0) continue; <body> }
    em.i32Const(0); em.localSet(idxLocal);
    em.block(() => {
      em.loop(() => {
        // if (idx >= highWater) break (label 1 = the block)
        em.localGet(idxLocal); em.localGet(P_highWater); em.op(OP_I32_GE_S); em.brIf(1);
        // if (alive[idx] != 0) { <body> }  — structured (no br out of the if, so
        // the alive==0 case just falls through to idx++).
        em.i32Const(agentLayout.u8['alive']!); em.localGet(idxLocal); em.op(OP_I32_ADD); em.i32Load8U();
        em.ifThen(() => {
          // reset scalar Local Variables to initialValue (agent variable set)
          for (const v of (model.agentVariables ?? [])) {
            if (v.kind !== 'scalar') continue;
            const l = ctx.varLocals.get(v.id)!;
            em.f64Const(variableInitNum(v));
            em.localSet(l);
          }
          // clear the value cache each iteration (locals are recomputed per agent)
          ctx.valueCache.clear();
          // run the behaviour flow chain
          compileFlowChain(ctx, behaviourNode.id, 'do');
        });
        // idx++ ; continue loop (label 0)
        em.localGet(idxLocal); em.i32Const(1); em.op(OP_I32_ADD); em.localSet(idxLocal);
        em.br(0);
      });
    });
    // store _rs back to memory (AW-RNG)
    em.i32Const(0); em.localGet(rsLocal); em.i32Store(agentLayout.rngStateOffset, 2);
  } catch (e) {
    return empty(String((e as Error)?.message || e));
  }

  const body = em.buildBody();

  // --- W1: the FORCE PASS function body (a SECOND func in this module) ---
  // The force pass needs an 8th host import `env.fmod = (a,b)=>a%b` (exact JS `%`
  // for the bit-exact torus position wrap — WASM has no f64 rem opcode). It is
  // APPENDED to the import list at funcIdx NUM_IMPORTED_FUNCS (= 7) so the existing
  // pow..tanh func indices (0..6) — which the behaviour body's opCall refers to —
  // are UNCHANGED. The two module-defined funcs then sit at funcIdx 8 (behaviour)
  // and 9 (forcePass).
  const FMOD_FUNC_IDX = NUM_IMPORTED_FUNCS; // = 7
  const NUM_IMPORTED_FUNCS_FORCE = NUM_IMPORTED_FUNCS + 1; // 8 (incl. fmod)
  const fpEm = new WasmEmitter(FORCE_PASS_PARAMS.length);
  const FP: ForcePassParamIdx = {
    highWater: 0, hashValid: 1, nBinsX: 2, nBinsY: 3, nBinsZ: 4,
    binSizeX: 5, binSizeY: 6, binSizeZ: 7,
    dtOverEta: 8, muR: 9, muA: 10, range: 11, momentum: 12, maxSpeed: 13, growthRate: 14,
    W: 15, H: 16, D: 17, bonding: 18, torus: 19,
  };
  let forceBody: Uint8Array;
  try {
    emitForcePass(fpEm, agentLayout, is3d, FP, FMOD_FUNC_IDX);
    forceBody = fpEm.buildBody();
  } catch (e) {
    return empty('agentWasm forcePass: ' + String((e as Error)?.message || e));
  }

  // --- assemble the module ---
  const memImport = importEntry('env', 'mem', importMemoryDesc(agentLayout.pages));
  const typeBehaviour = funcType(PARAMS.map(p => (p === 'i32' ? I32 : F64)), []);          // type 0
  const typePow = funcType([F64, F64], [F64]);                                              // type 1 — pow / fmod
  const typeUnary = funcType([F64], [F64]);                                                 // type 2 — exp/log/sin/cos/tan/tanh
  const typeForce = funcType(FORCE_PASS_PARAMS.map(p => (p === 'i32' ? I32 : F64)), []);    // type 3 — forcePass
  const TYPE_BEHAVIOUR = 0, TYPE_POW = 1, TYPE_UNARY = 2, TYPE_FORCE = 3;
  const powImport = importEntry('env', 'pow', importFuncDesc(TYPE_POW));
  const unaryNames = ['exp', 'log', 'sin', 'cos', 'tan', 'tanh'];
  const unaryImports = unaryNames.map(nm => importEntry('env', nm, importFuncDesc(TYPE_UNARY)));
  const fmodImport = importEntry('env', 'fmod', importFuncDesc(TYPE_POW)); // (f64,f64)->f64

  const bytes = buildModule({
    types: [typeBehaviour, typePow, typeUnary, typeForce],
    imports: [memImport, powImport, ...unaryImports, fmodImport],
    funcs: [leb128u(TYPE_BEHAVIOUR), leb128u(TYPE_FORCE)],
    exports: [
      exportEntry('behaviour', EXPORT_FUNC, NUM_IMPORTED_FUNCS_FORCE + 0),
      exportEntry('forcePass', EXPORT_FUNC, NUM_IMPORTED_FUNCS_FORCE + 1),
    ],
    code: [body, forceBody],
  });

  return { bytes, pages: agentLayout.pages, layout: agentLayout, supportedTypes: [...seen] };
}

/** Encode a scalar Variable's initialValue → f64. */
function variableInitNum(v: { dataType: string; initialValue?: string }): number {
  const r = v.initialValue ?? '0';
  if (v.dataType === 'bool') return (r === 'true' || r === '1') ? 1 : 0;
  const n = Number(r);
  return Number.isFinite(n) ? n : 0;
}

/** Instantiate the agent WASM module against the agent store's memory + the host
 *  math funcs. Returns the `behaviour(...)` export (the worker calls it with the
 *  per-step hash dimensions) AND the W1 `forcePass(...)` export (the soft-sphere +
 *  bond-spring + integration force loop — null on a legacy/behaviour-only module
 *  that didn't export it). `fmod` is the exact JS `%` the force pass uses for the
 *  bit-exact torus position wrap. */
export async function instantiateAgentWasm(
  bytes: Uint8Array,
  memory: WebAssembly.Memory,
): Promise<{ behaviour: (...args: number[]) => void; forcePass: ((...args: number[]) => void) | null }> {
  const importObj = {
    env: {
      mem: memory,
      pow: Math.pow, exp: Math.exp, log: Math.log,
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
      // The force pass's torus position wrap uses JS native `%` (exact fmod).
      fmod: (a: number, b: number): number => a % b,
    },
  };
  const mod = await WebAssembly.instantiate(bytes, importObj);
  return {
    behaviour: mod.instance.exports.behaviour as (...args: number[]) => void,
    forcePass: (mod.instance.exports.forcePass as ((...args: number[]) => void) | undefined) ?? null,
  };
}

/** The per-model max hash-bin reserve, derived from the grid (= agent world)
 *  dimensions + the force config — the worker builds the SAME bound so its
 *  layout matches the compiled module's. */
export function agentMaxHashBinsForModel(model: CAModel): number {
  const cfg = model.centerBased;
  const is3d = is3dModel(model);
  const W = (model.properties.gridWidth as number) || 100;
  const H = (model.properties.gridHeight as number) || 100;
  const D = is3d ? ((model.properties.gridDepth as number) || 1) : 1;
  const range = (cfg?.interactionRange as number) ?? 1.5;
  const dr = (cfg?.defaultRadius as number) ?? 0.5;
  const nq = (cfg?.neighbourQueryRadius as number) ?? 5;
  return computeAgentMaxHashBins(W, H, D, range, dr, nq);
}

/** Convenience for the DEV harness: derive the agent memory layout from a model's
 *  center-based config + cell-attr specs, then compile. Mirrors how the worker
 *  builds the layout via `createAgentStore({ wasmBacked: true })`. */
export function compileAgentGraphWasmForModel(model: CAModel): AgentWasmResult {
  const cfg = model.centerBased;
  if (!cfg) return { bytes: new Uint8Array(), pages: 1, layout: computeAgentMemoryLayout(1, 1, []), supportedTypes: [], error: 'No centerBased config.' };
  // Generic Agent Platform: the agent SoA + the baked memory offsets are keyed by
  // the AGENT attribute set (agentAttrsOf), the SAME ordered list the worker's
  // buildAgentAttrSpecs uses — they MUST match byte-for-byte or the WASM behaviour
  // reads/writes land on wrong-attribute bytes (the baked-offset lockstep).
  const specs: AgentAttrSpec[] = agentAttrsOf(model)
    .map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const maxAgents = Math.max(1, Math.floor((cfg.maxAgents as number) ?? 2000));
  const maxBonds = Math.max(1, Math.floor((cfg.maxBonds as number) ?? 8));
  const maxHashBins = agentMaxHashBinsForModel(model);
  const layout = computeAgentMemoryLayout(maxAgents, maxBonds, specs, maxHashBins);
  return compileAgentGraphWasm(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, layout);
}
