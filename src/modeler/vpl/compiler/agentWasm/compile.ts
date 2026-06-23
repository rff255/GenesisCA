// ===========================================================================
// PR6b-1 — the WASM AGENT-LOOP ARCHITECTURE SKELETON (the first internal split
// of capstone PR6b).
//
// A SEPARATE, minimal agent-WASM compiler whose per-agent behaviour loop runs
// directly against the wasmBacked AgentStore memory (PR6a — the AgentStore SoA
// laid out on a single WebAssembly.Memory at the offsets `computeAgentMemoryLayout`
// bakes). This proves the ARCHITECTURE — memory sharing + the per-agent loop +
// the dispatch + a handful of emitters — before the large emitter port lands
// (PR6b-2 neighbour access → Boids; PR6b-3 field + division → Tissue).
//
// SCOPE — intentionally MINIMAL (a deterministic drift / spring model only):
//   roots/reads/writes : behaviourStep, getSelfPosition, getRadius,
//                        applyForce, setTargetRadius
//   layout-agnostic    : getConstant (number), arithmeticOperator (Math),
//   value/flow utility   statement (Compare), conditional, logicOperator
// Everything else FALLS BACK to JS — `isAgentGraphWasmSupported(model)` is the
// honest, central gate; PR6b-2/3 just widen `AGENT_WASM_SUPPORTED_TYPES`.
//
// HARD CONSTRAINT: this compiler does NOT touch the lattice WASM compiler bytes.
// It REUSES the pure binary ENCODER (../wasm/encoder.ts: leb128, sections,
// opcodes) but emits its own, self-contained module — no coupling to the lattice
// WasmCompileCtx / layout. The front-end (macro-expand → reroute-collapse →
// accessor-CSE) is the same target-independent pipeline the JS agent compiler
// runs, so the supported subset matches its emit semantics 1:1.
//
// The module:
//   import "env" "mem"  = the wasmBacked AgentStore memory (reads/writes hit the
//                          SAME bytes the JS engine reads at the baked offsets).
//   import "env" "pow"/"exp"/.../"tanh" = the 7 host math funcs (same funcIdx
//                          convention as the lattice module: POW=0 .. TANH=6).
//   export "behaviour"(highWater: i32) -> ()
//     for (idx = 0; idx < highWater; idx++) {
//       if (alive[idx] == 0) continue;          // i32.load8_u at alive offset
//       <per-agent value DAG + the linear flow chain over the supported nodes>
//     }
//
// AW-HASH NOTE: the minimal model needs NO neighbour query, so `behaviour` takes
// ONLY `highWater` and the hash arrays are NOT copied into agent-memory views.
// `getNearbyAgents` is therefore NOT in the supported set (the gate excludes it);
// PR6b-2 adds the control-region hash + the array emitter.
// ===========================================================================

import type { GraphNode, GraphEdge, CAModel } from '../../../../model/types';
import {
  I32, F64,
  concat, leb128u,
  funcType, buildModule, buildFuncBody, localsRun,
  exportEntry, EXPORT_FUNC,
  importEntry, importMemoryDesc, importFuncDesc,
  opI32Const, opF64Const, opLocalGet, opLocalSet, opLocalTee,
  opI32Load8U, opF64Load, opF64Store,
  opBlock, opLoop, opIf, opBr, opBrIf, opCall,
  OP_ELSE, OP_END,
  OP_I32_ADD, OP_I32_MUL, OP_I32_GE_S, OP_I32_EQZ,
  OP_F64_ADD, OP_F64_SUB, OP_F64_MUL, OP_F64_DIV,
  OP_F64_ABS, OP_F64_SQRT, OP_F64_MIN, OP_F64_MAX,
  OP_F64_EQ, OP_F64_NE, OP_F64_LT, OP_F64_GT, OP_F64_LE, OP_F64_GE,
  OP_I32_AND, OP_I32_OR, OP_I32_XOR,
  OP_F64_CONVERT_I32_S,
} from '../wasm/encoder';
import { is3dModel } from '../compile';
import { expandMacros } from '../macroExpand';
import { collapseReroutes } from '../rerouteCollapse';
import { canonicalizeAccessorEdges } from '../accessorCSE';
import { computeAgentMemoryLayout, type AgentAttrSpec, type AgentMemoryLayout } from '../../../../simulator/engine/agentEngine';

// The math-import funcIdx convention MIRRORS the lattice module
// (POW_FUNC_IDX..TANH_FUNC_IDX, NUM_IMPORTED_FUNCS=7) so an env object built for
// one works for the other.
const POW_FUNC_IDX = 0;
const EXP_FUNC_IDX = 1;
const LOG_FUNC_IDX = 2;
const SIN_FUNC_IDX = 3;
const COS_FUNC_IDX = 4;
const TAN_FUNC_IDX = 5;
const TANH_FUNC_IDX = 6;
const NUM_IMPORTED_FUNCS = 7;

/** The node types PR6b-1 can emit to WASM. A model whose agent graph uses ONLY
 *  these (after macro-expansion / reroute-collapse) runs on the WASM target;
 *  anything else FALLS BACK to JS (the clamp stays the safe default). PR6b-2/3
 *  widen this set — keep it the SINGLE source of truth so the gate + the emitter
 *  dispatch never drift. */
export const AGENT_WASM_SUPPORTED_TYPES: ReadonlySet<string> = new Set<string>([
  // event roots
  'behaviourStep',
  // self reads (SoA geometry)
  'getSelfPosition', 'getRadius',
  // writes (SoA / request)
  'applyForce', 'setTargetRadius',
  // layout-agnostic value/flow utility (operate on the f64 stack / locals)
  'getConstant', 'arithmeticOperator', 'statement', 'logicOperator',
  // flow
  'conditional', 'sequence',
]);

export interface AgentWasmResult {
  /** The compiled module bytes (empty on error / unsupported). */
  bytes: Uint8Array;
  /** Pages the module's imported memory must have (= the agent layout's pages). */
  pages: number;
  /** The node types the compiler actually emitted (for diagnostics + the gate). */
  supportedTypes: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Adjacency — a small self-contained value/flow graph walk for the supported
// subset (the lattice buildAdjacency is not exported + is coupled to the lattice
// context; the minimal subset has no branches-with-cross-scope-values, so a flat
// agent-top emission matches the JS agent compiler's emit for these nodes).
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

/** The value-PRODUCING node types in the supported set (writes / flow-only nodes
 *  like applyForce/setTargetRadius/conditional/sequence are excluded). */
const VALUE_PRODUCER_TYPES: ReadonlySet<string> = new Set<string>([
  'behaviourStep', 'getSelfPosition', 'getRadius', 'getConstant',
  'arithmeticOperator', 'statement', 'logicOperator',
]);

/** Every (sourceNodeId, sourcePortId) that some value input depends on — i.e. the
 *  CONSUMED value-output ports. Drives the unconditional pre-emit so a value used
 *  inside a `conditional` branch is materialised before the `if` (not lazily in
 *  whichever branch compiles first, which would stale the sibling branch). */
function consumedValueSources(adj: Adjacency): Array<{ nodeId: string; portId: string }> {
  const seen = new Set<string>();
  const out: Array<{ nodeId: string; portId: string }> = [];
  for (const src of adj.inputToSource.values()) {
    const key = `${src.nodeId}:${src.portId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  return out;
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
// The emitter context — a flat function (one WASM func body). Every f64 value is
// materialised into an f64 local once (memoised by `${nodeId}:${portId}`); the
// per-agent SoA offsets come from the baked AgentMemoryLayout.
// ---------------------------------------------------------------------------

interface AgentWasmCtx {
  adj: Adjacency;
  layout: AgentMemoryLayout;
  is3d: boolean;
  /** Byte-code accumulator for the function body expression. */
  code: Uint8Array[];
  /** local index of the loop var `idx` (i32). */
  idxLocal: number;
  /** local index of `idx*8` (the per-agent f64 byte address; i32), recomputed
   *  at the top of each iteration. */
  addr8Local: number;
  /** Cache: `${nodeId}:${portId}` → the f64 local holding that value. */
  valueLocals: Map<string, number>;
  /** Allocated f64 locals beyond the params (count → declared in localsRun). */
  f64LocalCount: number;
  /** Allocated i32 locals beyond the params. */
  i32LocalCount: number;
  /** Base index of the first non-param i32 local. */
  i32Base: number;
  /** Base index of the first f64 local. */
  f64Base: number;
}

function emit(ctx: AgentWasmCtx, ...parts: Uint8Array[]): void {
  for (const p of parts) ctx.code.push(p);
}

/** Allocate a fresh f64 local; returns its absolute local index. */
function allocF64(ctx: AgentWasmCtx): number {
  const idx = ctx.f64Base + ctx.f64LocalCount;
  ctx.f64LocalCount++;
  return idx;
}

/** Allocate a fresh i32 local; returns its absolute local index. */
function allocI32(ctx: AgentWasmCtx): number {
  const idx = ctx.i32Base + ctx.i32LocalCount;
  ctx.i32LocalCount++;
  return idx;
}

/** Push the byte address of a per-agent Float64 region at `idx`: `offset + idx*8`.
 *  Uses the precomputed `addr8Local` (= idx*8) so it's a const-add. */
function pushF64Addr(ctx: AgentWasmCtx, regionOffset: number): void {
  emit(ctx, opI32Const(regionOffset), opLocalGet(ctx.addr8Local), OP_I32_ADD);
}

// ---------------------------------------------------------------------------
// Value emission — resolve a value-input port to an f64 value ON THE STACK.
// Every node's output is materialised into an f64 local once + cached; resolving
// re-pushes the cached local. Inline-widget fallbacks read the node config.
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

/** Resolve value input `portId` of `node` and leave its f64 value on the stack.
 *  Wired → the source node's cached local; unwired → the inline-widget constant. */
function pushValueInput(ctx: AgentWasmCtx, node: GraphNode, portId: string, fallback: number): void {
  const src = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
  if (src) {
    const local = compileValueNode(ctx, src.nodeId, src.portId);
    emit(ctx, opLocalGet(local));
    return;
  }
  emit(ctx, opF64Const(getInlineNum(node, portId, fallback)));
}

/** Compile a value-producing node, returning the f64 local holding the requested
 *  output port's value (memoised). Throws on an unsupported node type — the gate
 *  guarantees we never reach here for one, but the throw is a hard safety net. */
function compileValueNode(ctx: AgentWasmCtx, nodeId: string, portId: string): number {
  const key = `${nodeId}:${portId}`;
  const cached = ctx.valueLocals.get(key);
  if (cached !== undefined) return cached;

  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) throw new Error(`agentWasm: missing node ${nodeId}`);
  const type = node.data.nodeType;

  let resultLocal: number;
  switch (type) {
    case 'behaviourStep': {
      // The agent's own geometry/identity value-outs (the loop preamble in JS).
      resultLocal = allocF64(ctx);
      if (portId === 'myX') { pushF64Addr(ctx, ctx.layout.f64['x']!); emit(ctx, opF64Load()); }
      else if (portId === 'myY') { pushF64Addr(ctx, ctx.layout.f64['y']!); emit(ctx, opF64Load()); }
      else if (portId === 'myZ') { pushF64Addr(ctx, ctx.layout.f64['z']!); emit(ctx, opF64Load()); }
      else if (portId === 'myRadius') { pushF64Addr(ctx, ctx.layout.f64['radius']!); emit(ctx, opF64Load()); }
      else if (portId === 'myArea') {
        // π·r²
        pushF64Addr(ctx, ctx.layout.f64['radius']!); emit(ctx, opF64Load());
        pushF64Addr(ctx, ctx.layout.f64['radius']!); emit(ctx, opF64Load());
        emit(ctx, OP_F64_MUL, opF64Const(Math.PI), OP_F64_MUL);
      }
      else if (portId === 'myAge') { pushF64Addr(ctx, ctx.layout.f64['age']!); emit(ctx, opF64Load()); }
      else { emit(ctx, opF64Const(0)); } // myBondDegree/myType — not exercised by the minimal model
      emit(ctx, opLocalSet(resultLocal));
      break;
    }
    case 'getSelfPosition': {
      resultLocal = allocF64(ctx);
      const region = portId === 'y' ? ctx.layout.f64['y']! : portId === 'z' ? ctx.layout.f64['z']! : ctx.layout.f64['x']!;
      pushF64Addr(ctx, region); emit(ctx, opF64Load(), opLocalSet(resultLocal));
      break;
    }
    case 'getRadius': {
      resultLocal = allocF64(ctx);
      pushF64Addr(ctx, ctx.layout.f64['radius']!); emit(ctx, opF64Load(), opLocalSet(resultLocal));
      break;
    }
    case 'getConstant': {
      resultLocal = allocF64(ctx);
      emit(ctx, opF64Const(readConstantValue(node)), opLocalSet(resultLocal));
      break;
    }
    case 'arithmeticOperator': {
      resultLocal = allocF64(ctx);
      emitArithmetic(ctx, node);
      emit(ctx, opLocalSet(resultLocal));
      break;
    }
    case 'statement': {
      resultLocal = allocF64(ctx);
      emitCompare(ctx, node);   // leaves 1.0/0.0 on the stack
      emit(ctx, opLocalSet(resultLocal));
      break;
    }
    case 'logicOperator': {
      resultLocal = allocF64(ctx);
      emitLogic(ctx, node);
      emit(ctx, opLocalSet(resultLocal));
      break;
    }
    default:
      throw new Error(`agentWasm: unsupported value node '${type}'`);
  }
  ctx.valueLocals.set(key, resultLocal);
  return resultLocal;
}

/** Get Constant — numeric / bool only in the minimal set. Mirrors
 *  GetConstantNode.compile's `constType`/`constValue` config + 1/0-for-bool
 *  convention (faceLabel / tag / orientation are rejected by the gate). */
function readConstantValue(node: GraphNode): number {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const ct = (cfg?.['constType'] as string) ?? 'integer';
  const raw = cfg?.['constValue'];
  const rawStr = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '0';
  if (ct === 'bool') return rawStr === 'true' ? 1 : 0;
  if (ct === 'float') { const n = parseFloat(rawStr); return Number.isFinite(n) ? n : 0; }
  const n = parseInt(rawStr, 10); return Number.isFinite(n) ? n : 0;
}

/** Math node — the f64 arithmetic + the host-imported transcendentals. Leaves
 *  the result on the stack. Mirrors ArithmeticOperatorNode.compile's JS semantics
 *  (incl. the divide-by-zero → 0 guard via a select). */
function emitArithmetic(ctx: AgentWasmCtx, node: GraphNode): void {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['operation'] as string) ?? '+';
  const unary = (call: number) => { pushValueInput(ctx, node, 'x', 0); emit(ctx, opCall(call)); };
  switch (op) {
    case '+': case 'add':
      pushValueInput(ctx, node, 'x', 0); pushValueInput(ctx, node, 'y', 0); emit(ctx, OP_F64_ADD); break;
    case '-':
      pushValueInput(ctx, node, 'x', 0); pushValueInput(ctx, node, 'y', 0); emit(ctx, OP_F64_SUB); break;
    case '*':
      pushValueInput(ctx, node, 'x', 0); pushValueInput(ctx, node, 'y', 0); emit(ctx, OP_F64_MUL); break;
    case '/':
      emitGuardedDiv(ctx, node); break;
    case 'sqrt': pushValueInput(ctx, node, 'x', 0); emit(ctx, OP_F64_SQRT); break;
    case 'abs':  pushValueInput(ctx, node, 'x', 0); emit(ctx, OP_F64_ABS); break;
    case 'max':  pushValueInput(ctx, node, 'x', 0); pushValueInput(ctx, node, 'y', 0); emit(ctx, OP_F64_MAX); break;
    case 'min':  pushValueInput(ctx, node, 'x', 0); pushValueInput(ctx, node, 'y', 0); emit(ctx, OP_F64_MIN); break;
    case 'mean':
      pushValueInput(ctx, node, 'x', 0); pushValueInput(ctx, node, 'y', 0); emit(ctx, OP_F64_ADD, opF64Const(2), OP_F64_DIV); break;
    case 'pow':  pushValueInput(ctx, node, 'x', 0); pushValueInput(ctx, node, 'y', 0); emit(ctx, opCall(POW_FUNC_IDX)); break;
    case 'exp':  unary(EXP_FUNC_IDX); break;
    case 'log':  unary(LOG_FUNC_IDX); break;
    case 'sin':  unary(SIN_FUNC_IDX); break;
    case 'cos':  unary(COS_FUNC_IDX); break;
    case 'tan':  unary(TAN_FUNC_IDX); break;
    case 'tanh': unary(TANH_FUNC_IDX); break;
    default:
      pushValueInput(ctx, node, 'x', 0); pushValueInput(ctx, node, 'y', 0); emit(ctx, OP_F64_ADD); break;
  }
}

/** `y !== 0 ? x / y : 0` — the JS Math node's divide guard, via a stashed `y`
 *  local + a select (cond = y != 0). */
function emitGuardedDiv(ctx: AgentWasmCtx, node: GraphNode): void {
  const yLocal = allocF64(ctx);
  pushValueInput(ctx, node, 'y', 0); emit(ctx, opLocalTee(yLocal)); // y on stack + stashed
  emit(ctx, opF64Const(0), OP_F64_NE);   // cond i32 = (y != 0)
  const condLocal = allocI32(ctx); emit(ctx, opLocalSet(condLocal));
  // if (cond) x/y else 0
  emit(ctx, opLocalGet(condLocal), opIf(F64));
  pushValueInput(ctx, node, 'x', 0); emit(ctx, opLocalGet(yLocal), OP_F64_DIV);
  emit(ctx, OP_ELSE, opF64Const(0), OP_END);
}

/** Compare node — numerical compare ops, leaving 1.0/0.0 on the stack. Mirrors
 *  StatementNode's numerical path (the only compareType the minimal set needs).
 *  Operands read `x` / `y` inline-widget or wired. */
function emitCompare(ctx: AgentWasmCtx, node: GraphNode): void {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['operator'] as string) ?? '==';
  // between-family ops need an upper bound — not in the minimal set; treat any
  // unknown op as `==` so the gate (which already rejects between via config) is
  // the real guard.
  pushValueInput(ctx, node, 'x', 0);
  pushValueInput(ctx, node, 'y', 0);
  switch (op) {
    case '==': emit(ctx, OP_F64_EQ); break;
    case '!=': emit(ctx, OP_F64_NE); break;
    case '>':  emit(ctx, OP_F64_GT); break;
    case '<':  emit(ctx, OP_F64_LT); break;
    case '>=': emit(ctx, OP_F64_GE); break;
    case '<=': emit(ctx, OP_F64_LE); break;
    default:   emit(ctx, OP_F64_EQ); break;
  }
  // i32 (0/1) → f64
  emit(ctx, OP_F64_CONVERT_I32_S);
}

/** Logic node — AND / OR / XOR / NOT over boolean (non-zero) f64 inputs, leaving
 *  1.0/0.0 on the stack. Each operand is coerced to i32 truthiness via (!= 0). */
function emitLogic(ctx: AgentWasmCtx, node: GraphNode): void {
  const cfg = node.data.config as Record<string, unknown> | undefined;
  const op = (cfg?.['operation'] as string) ?? 'and';
  const pushBool = (port: string) => { pushValueInput(ctx, node, port, 0); emit(ctx, opF64Const(0), OP_F64_NE); };
  if (op === 'not') {
    pushBool('a'); emit(ctx, OP_I32_EQZ);
  } else {
    pushBool('a'); pushBool('b');
    if (op === 'or') emit(ctx, OP_I32_OR);
    else if (op === 'xor') emit(ctx, OP_I32_XOR);
    else emit(ctx, OP_I32_AND);
  }
  emit(ctx, OP_F64_CONVERT_I32_S);
}

// ---------------------------------------------------------------------------
// Flow emission — walk the DO chain. The minimal set is a linear chain of
// applyForce / setTargetRadius with an optional `conditional` (if/else) and a
// transparent `sequence`. Each flow node emits its writes, then recurses into
// its `next` (and branch outputs for conditional).
// ---------------------------------------------------------------------------

function compileFlowChain(ctx: AgentWasmCtx, nodeId: string, portId: string): void {
  const targets = ctx.adj.flowOutputToTargets.get(`${nodeId}:${portId}`) ?? [];
  for (const t of targets) compileFlowNode(ctx, t.nodeId);
}

function compileFlowNode(ctx: AgentWasmCtx, nodeId: string): void {
  const node = ctx.adj.nodeMap.get(nodeId);
  if (!node) return;
  const type = node.data.nodeType;
  switch (type) {
    case 'applyForce': {
      // _agentForceX[idx] += fx;  _agentForceY[idx] += fy;  (+ forceZ in 3D)
      emitForceAdd(ctx, ctx.layout.f64['forceX']!, () => pushValueInput(ctx, node, 'fx', 0));
      emitForceAdd(ctx, ctx.layout.f64['forceY']!, () => pushValueInput(ctx, node, 'fy', 0));
      if (ctx.is3d) emitForceAdd(ctx, ctx.layout.f64['forceZ']!, () => pushValueInput(ctx, node, 'fz', 0));
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'setTargetRadius': {
      // _agentTargetRadius[idx] = value;
      pushF64Addr(ctx, ctx.layout.f64['targetRadius']!);
      pushValueInput(ctx, node, 'value', 1);
      emit(ctx, opF64Store());
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'sequence': {
      // Transparent: run each then_N output in order (then0, then1, … — only
      // `then0` (the static first) is exercised here; dynamic then_N follow).
      const cfg = node.data.config as Record<string, unknown> | undefined;
      const count = Math.max(1, Number(cfg?.['sequenceCount']) || 1);
      compileFlowChain(ctx, node.id, 'then0');
      for (let i = 1; i < count; i++) compileFlowChain(ctx, node.id, `then${i}`);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    case 'conditional': {
      // if (cond) { then } else { else }
      const condLocal = compileValueNode2Bool(ctx, node, 'condition');
      emit(ctx, opLocalGet(condLocal), opIf());
      compileFlowChain(ctx, node.id, 'then');
      emit(ctx, OP_ELSE);
      compileFlowChain(ctx, node.id, 'else');
      emit(ctx, OP_END);
      compileFlowChain(ctx, node.id, 'next');
      break;
    }
    default:
      // Unsupported flow node — the gate guarantees we never get here.
      throw new Error(`agentWasm: unsupported flow node '${type}'`);
  }
}

/** `_agentForceX[idx] += <pushVal()>` — load, add, store at the same address.
 *  The address is recomputed twice (cheap const-add) to keep the stack simple. */
function emitForceAdd(ctx: AgentWasmCtx, regionOffset: number, pushVal: () => void): void {
  pushF64Addr(ctx, regionOffset);            // store address
  pushF64Addr(ctx, regionOffset); emit(ctx, opF64Load()); // current
  pushVal();
  emit(ctx, OP_F64_ADD);
  emit(ctx, opF64Store());
}

/** Resolve a flow node's bool value-input into an i32 (0/1) local for an `if`. */
function compileValueNode2Bool(ctx: AgentWasmCtx, node: GraphNode, portId: string): number {
  const src = ctx.adj.inputToSource.get(`${node.id}:${portId}`);
  const out = allocI32(ctx);
  if (src) {
    const local = compileValueNode(ctx, src.nodeId, src.portId);
    emit(ctx, opLocalGet(local), opF64Const(0), OP_F64_NE, opLocalSet(out));
  } else {
    emit(ctx, opI32Const(getInlineNum(node, portId, 0) !== 0 ? 1 : 0), opLocalSet(out));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate + the top-level compile.
// ---------------------------------------------------------------------------

/** Run the shared front-end (macro-expand → reroute-collapse → accessor-CSE) so
 *  the supported-type check sees the same flattened graph the emitter will. */
function flattenAgentGraph(nodes: GraphNode[], edges: GraphEdge[], model: CAModel):
  { nodes: GraphNode[]; edges: GraphEdge[]; error?: string } {
  const expanded = expandMacros(nodes, edges, model);
  if (expanded.error) return { nodes, edges, error: expanded.error };
  let n = expanded.nodes, e = expanded.edges;
  ({ nodes: n, edges: e } = collapseReroutes(n, e));
  e = canonicalizeAccessorEdges(n, e, model);
  return { nodes: n, edges: e };
}

/** TRUE iff EVERY node in the (flattened) agent graph is in the PR6b-1 supported
 *  set AND the model has Agents enabled. The honest, central gate `agentTargetOf`
 *  consults — PR6b-2/3 widen `AGENT_WASM_SUPPORTED_TYPES` and this passes more
 *  models with no other change. A model that fails this clamps to the JS target. */
export function isAgentGraphWasmSupported(model: CAModel | undefined | null): boolean {
  if (!model || !model.topologyMode?.agents) return false;
  const nodes = model.agentGraphNodes ?? [];
  const edges = model.agentGraphEdges ?? [];
  if (!nodes.some(n => n.data.nodeType === 'behaviourStep')) return false;
  const flat = flattenAgentGraph(nodes, edges, model);
  if (flat.error) return false;
  for (const n of flat.nodes) {
    const t = n.data.nodeType;
    // boundary / structural editor-only nodes are dropped by the front-end; any
    // surviving node MUST be in the supported set.
    if (t === 'macroInput' || t === 'macroOutput' || t === 'macro') return false;
    if (!AGENT_WASM_SUPPORTED_TYPES.has(t)) return false;
    // Reject Compare's between-family ops (need an upper bound — not in the
    // minimal emitter); reject Math nodes are fine (all ops emit).
    if (t === 'statement') {
      const op = (n.data.config as Record<string, unknown>)?.['operator'] as string | undefined;
      if (op && /between/i.test(op)) return false;
      const compareType = (n.data.config as Record<string, unknown>)?.['compareType'] as string | undefined;
      if (compareType && compareType !== 'numerical') return false;
    }
    if (t === 'getConstant') {
      const ct = (n.data.config as Record<string, unknown>)?.['constType'] as string | undefined;
      if (ct && ct !== 'integer' && ct !== 'float' && ct !== 'bool') return false;
    }
  }
  return true;
}

/** Compile the agent behaviour graph to a self-contained WASM module that reads /
 *  writes the wasmBacked AgentStore memory at the baked offsets. Returns
 *  `{ bytes, pages }`. On an unsupported graph it returns an empty result + an
 *  error (the worker keeps the JS path). PR6b-1 is BEHAVIOUR-ONLY (no division
 *  module yet — that's PR6b-3). */
export function compileAgentGraphWasm(
  agentNodes: GraphNode[],
  agentEdges: GraphEdge[],
  model: CAModel,
  agentLayout: AgentMemoryLayout,
): AgentWasmResult {
  const empty: AgentWasmResult = { bytes: new Uint8Array(), pages: agentLayout.pages, supportedTypes: [] };
  if (!model.topologyMode?.agents) return { ...empty, error: 'Agents topology not enabled.' };

  const flat = flattenAgentGraph(agentNodes, agentEdges, model);
  if (flat.error) return { ...empty, error: flat.error };
  const nodes = flat.nodes, edges = flat.edges;

  const behaviourNode = nodes.find(n => n.data.nodeType === 'behaviourStep');
  if (!behaviourNode) return { ...empty, error: 'No Behaviour Step node in the agent graph.' };

  // Gate: every surviving node must be emittable.
  const seen = new Set<string>();
  for (const n of nodes) {
    seen.add(n.data.nodeType);
    if (!AGENT_WASM_SUPPORTED_TYPES.has(n.data.nodeType)) {
      return { ...empty, error: `agentWasm: unsupported node '${n.data.nodeType}' (falls back to JS).` };
    }
  }

  const adj = buildAdjacency(nodes, edges);
  const is3d = is3dModel(model);

  // Function locals layout: param 0 = highWater (i32). Then our scratch i32
  // locals (idx, addr8 + per-node temporaries), then f64 value locals. WASM
  // locals are declared in two runs (i32 then f64); absolute indices follow
  // params (1) → i32 run → f64 run.
  const PARAM_COUNT = 1;            // highWater
  // Reserve idx + addr8 as the first two i32 locals.
  const ctx: AgentWasmCtx = {
    adj, layout: agentLayout, is3d,
    code: [],
    idxLocal: PARAM_COUNT + 0,
    addr8Local: PARAM_COUNT + 1,
    valueLocals: new Map(),
    f64LocalCount: 0,
    i32LocalCount: 2,                // idx, addr8 pre-reserved
    i32Base: PARAM_COUNT,            // i32 run starts right after the param
    // f64Base is only known after the i32 count is final; patched below. We emit
    // value locals lazily, so set a generous base and fix the localsRun counts at
    // the end. Two-pass: emit into ctx.code with placeholder local indices that
    // are absolute from the start (idx/addr8 fixed; f64 base computed up front by
    // pre-counting). To keep it single-pass we put the f64 run AFTER a fixed-size
    // i32 run — but i32 temporaries are dynamic. Resolve by buffering: see below.
    f64Base: 0,                      // patched after the body is emitted (relocation)
  };

  // We don't know the final i32-local count until the whole body is emitted, and
  // f64 locals must come AFTER all i32 locals in the index space. To avoid a
  // relocation pass we allocate f64 locals from a HIGH fixed base and i32 from a
  // low base, then declare the locals with explicit counts + a filler so indices
  // stay valid. Simpler + robust: pick a fixed f64Base well above any i32 count.
  // The graph is tiny (minimal model), so a 256-slot i32 window is ample.
  const I32_WINDOW = 256;
  ctx.f64Base = PARAM_COUNT + I32_WINDOW;

  // --- emit the per-agent loop body ---
  // addr8 = idx * 8  (recomputed at loop top)
  // for (idx=0; idx<highWater; idx++) { if (alive[idx]==0) continue; <body> }
  emit(ctx,
    opI32Const(0), opLocalSet(ctx.idxLocal),
    opBlock(),                       // break target (label 1 from loop)
    opLoop(),                        // continue target (label 0)
    // if (idx >= highWater) break
    opLocalGet(ctx.idxLocal), opLocalGet(0 /* highWater param */), OP_I32_GE_S, opBrIf(1),
    // addr8 = idx * 8
    opLocalGet(ctx.idxLocal), opI32Const(8), OP_I32_MUL, opLocalSet(ctx.addr8Local),
    // if (alive[idx] == 0) { idx++; continue }   (alive is 1 byte/agent at u8.alive)
    opI32Const(ctx.layout.u8['alive']!), opLocalGet(ctx.idxLocal), OP_I32_ADD, opI32Load8U(), OP_I32_EQZ,
    opIf(),
      opLocalGet(ctx.idxLocal), opI32Const(1), OP_I32_ADD, opLocalSet(ctx.idxLocal),
      opBr(1),                       // continue the loop (label 1 from inside the if = the loop)
    OP_END,
  );

  // PRE-EMIT every value-producing node at loop-body TOP (unconditionally), then
  // run the flow chain. The `valueLocals` map then returns the already-computed
  // locals — so a value referenced inside a `conditional` branch is initialized
  // BEFORE the `if`, not lazily inside whichever branch compiles first (which
  // would leave the local stale in the sibling branch — the WGSL/JS cross-branch
  // scoping hazard, here a stale-local hazard). The minimal model has no
  // branches, so this is just the same emit; it makes `conditional` sound too.
  // NB: the value cache is compile-time only — the emitted byte-code lives inside
  // the loop, so every local is recomputed each iteration.
  try {
    // For each CONSUMED value-output port (one with an outgoing value edge),
    // materialise its node before the flow chain. Precise: an unused myZ/myArea
    // port is never emitted. `consumedValueSources` collects (nodeId, portId)
    // pairs that some value input depends on.
    for (const { nodeId, portId } of consumedValueSources(adj)) {
      const src = adj.nodeMap.get(nodeId);
      if (src && VALUE_PRODUCER_TYPES.has(src.data.nodeType)) compileValueNode(ctx, nodeId, portId);
    }
    compileFlowChain(ctx, behaviourNode.id, 'do');
  } catch (e) {
    return { ...empty, error: String((e as Error)?.message || e) };
  }

  // idx++ ; continue
  emit(ctx,
    opLocalGet(ctx.idxLocal), opI32Const(1), OP_I32_ADD, opLocalSet(ctx.idxLocal),
    opBr(0),                         // loop
    OP_END,                          // end loop
    OP_END,                          // end block
  );

  // --- assemble the module ---
  // locals: an i32 run sized I32_WINDOW (covers idx/addr8 + all i32 temporaries),
  // then an f64 run sized f64LocalCount. Unused i32 slots are harmless.
  const localRuns = [localsRun(I32_WINDOW, I32), localsRun(Math.max(1, ctx.f64LocalCount), F64)];
  const body = buildFuncBody(localRuns, concat(...ctx.code));

  // Imports: env.mem + the 7 math funcs (same funcIdx order as the lattice).
  const memImport = importEntry('env', 'mem', importMemoryDesc(agentLayout.pages));
  const typePow = funcType([F64, F64], [F64]);     // type 0 — pow
  const typeBehaviour = funcType([I32], []);        // type 1 — behaviour(highWater)
  const typeUnary = funcType([F64], [F64]);         // type 2 — exp/log/sin/cos/tan/tanh
  const TYPE_POW = 0, TYPE_BEHAVIOUR = 1, TYPE_UNARY = 2;
  const powImport = importEntry('env', 'pow', importFuncDesc(TYPE_POW));
  const unaryNames = ['exp', 'log', 'sin', 'cos', 'tan', 'tanh'];
  const unaryImports = unaryNames.map(nm => importEntry('env', nm, importFuncDesc(TYPE_UNARY)));

  const bytes = buildModule({
    types: [typePow, typeBehaviour, typeUnary],
    imports: [memImport, powImport, ...unaryImports],
    funcs: [leb128u(TYPE_BEHAVIOUR)],                 // behaviour() uses type 1
    exports: [exportEntry('behaviour', EXPORT_FUNC, NUM_IMPORTED_FUNCS + 0)],
    code: [body],
  });

  return { bytes, pages: agentLayout.pages, supportedTypes: [...seen] };
}

/** Instantiate the agent WASM module against the agent store's memory + the host
 *  math funcs. Returns the `behaviour(highWater)` export. */
export async function instantiateAgentWasm(
  bytes: Uint8Array,
  memory: WebAssembly.Memory,
): Promise<{ behaviour: (highWater: number) => void }> {
  const importObj = {
    env: {
      mem: memory,
      pow: Math.pow, exp: Math.exp, log: Math.log,
      sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh,
    },
  };
  const mod = await WebAssembly.instantiate(bytes, importObj);
  return { behaviour: mod.instance.exports.behaviour as (hw: number) => void };
}

/** Convenience for the DEV harness: derive the agent memory layout from a model's
 *  center-based config + cell-attr specs, then compile. Mirrors how the worker
 *  builds the layout via `createAgentStore({ wasmBacked: true })`. */
export function compileAgentGraphWasmForModel(model: CAModel): AgentWasmResult {
  const cfg = model.centerBased;
  if (!cfg) return { bytes: new Uint8Array(), pages: 1, supportedTypes: [], error: 'No centerBased config.' };
  const specs: AgentAttrSpec[] = (model.attributes ?? [])
    .filter(a => !a.isModelAttribute)
    .map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const maxAgents = Math.max(1, Math.floor((cfg.maxAgents as number) ?? 2000));
  const maxBonds = Math.max(1, Math.floor((cfg.maxBonds as number) ?? 8));
  const layout = computeAgentMemoryLayout(maxAgents, maxBonds, specs);
  return compileAgentGraphWasm(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, layout);
}
