/**
 * Composite-type lowering — target-independent pre-compile graph transform.
 *
 * The composite value types (`vector` = [x, y, z], `color` = [r, g, b, a]) and
 * their Make / Break / Vector-Op nodes are EDITOR SUGAR. This pass rewrites them
 * into plain SCALAR nodes (`arithmeticOperator` + `getConstant`) BEFORE any
 * per-target compile runs, so the JS / WASM / WebGPU emitters never see a vector
 * or colour and need ZERO per-target composite code — exactly the lowering
 * pattern of `expandMacros` (macros → flat nodes), `collapseReroutes` (reroutes →
 * direct edges) and `injectLinkedOutputMappings` (linked OM → colour-pass nodes).
 *
 * Because the output is ordinary scalar nodes the existing verified emitters
 * already compile on every target, a vector model runs natively on WASM and
 * WebGPU (grid AND agents) — NOT clamped to JS. This honours the ALL-TARGET
 * DELIVERY rule (see CLAUDE.md): the targets exist for performance, so a feature
 * must run on all of them, not just the reference engine.
 *
 * Lowering, by node:
 *   - Make Vector / Make Color  → its output's component sources ARE its scalar
 *     inputs (pass-through; the node disappears).
 *   - Break Vector / Break Color → each scalar output resolves to one component
 *     of the input composite.
 *   - Vector Op → synthesises a small tree of `arithmeticOperator` nodes per
 *     component (add/sub/scale/cross/normalize/negate/lerp/rotate2d/rotateAxis)
 *     or one scalar result (dot/length/distance). Angles arrive in DEGREES and
 *     are converted with a π/180 multiply, so sin/cos (already lockstepped on
 *     all three targets) do the work.
 *   - Apply Force "vector input" mode → the force vector's components are wired
 *     to the existing fx / fy / fz scalar ports (so all targets emit the adds).
 *
 * A vector value never reaches a non-composite consumer except through Break
 * (scalar outputs) or a known composite-input port (Apply Force's `force`) —
 * `isValidConnection` enforces vector/color → composite-port-only. So the
 * producer set is closed and every value bottoms out at a real scalar source or
 * a literal. Hot-path no-op when the graph has no composite nodes.
 *
 * Sound in BOTH sync and async modes: the produced scalar nodes carry the same
 * data the array form did, with no new read/write ordering.
 */

import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';
import { is3dModelLike } from './niCodec';
import { DEG_TO_RAD } from '../nodes/VectorOpNode';
import type { TraceComponent, TraceOrigin, TraceOriginMap } from './traceOrigin';
import {
  COMPOSITE_ARITY, COMPOSITE_RELAY_TYPES, RELAY_BRANCH_PORTS, RELAY_RESULT_PORT,
  makeCompositeTypeResolver, staticPortCompositeType, type CompositeType,
} from './compositeRelay';

const COMPOSITE_NODE_TYPES = new Set(['makeVector', 'breakVector', 'vectorOp', 'makeColor', 'breakColor']);

/** Composite SCALAR-output ports (emit a scalar derived from a composite). The
 *  VALUE-output ports (makeVector.vector / makeColor.color / vectorOp.result) are
 *  dispatched by node type in `vecComponentsOf`, so they need no table here. */
const SCALAR_OUT_PORTS: Record<string, string[]> = { breakVector: ['x', 'y', 'z'], breakColor: ['r', 'g', 'b', 'a'], vectorOp: ['value'] };

/** A resolved scalar value: a wire to a real/synthetic node, or a literal. */
type Comp = { kind: 'wire'; source: string; sourceHandle: string } | { kind: 'literal'; value: string };

/** The composite component port ids — used only to tag a Rule Trace origin with
 *  the axis/channel a lowered scalar node stands for. */
const COMPONENT_PORTS = new Set(['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a']);

const inH = (port: string) => `input_value_${port}`;
const outH = (port: string) => `output_value_${port}`;
/** Parse the port id out of a `input_value_…` / `output_value_…` handle. */
const portOf = (handle: string | undefined): string => (handle ? handle.replace(/^(input|output)_value_/, '') : '');
/** The `inEdge` map key. A NAMED builder because the separator is a NUL byte —
 *  building it inline elsewhere with a space (which is what a NUL looks like in
 *  most editors) silently misses every entry. */
const inKey = (nodeId: string, port: string): string => `${nodeId}\x00${port}`;

export function expandComposites(
  nodes: GraphNode[],
  edges: GraphEdge[],
  model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[]; origin?: TraceOriginMap } {
  const compositeIds = new Set<string>();
  for (const n of nodes) if (COMPOSITE_NODE_TYPES.has(n.data.nodeType)) compositeIds.add(n.id);
  // Apply Force in vector-input mode is a composite CONSUMER even though it isn't
  // a composite node itself — detect it so the hot-path no-op check is accurate.
  const hasVecConsumer = nodes.some(n => n.data.nodeType === 'applyForce' && n.data.config?.vectorInput);
  // A `valueSwitch` may be a composite RELAY (see compositeRelay.ts) even with no
  // Make/Break node in sight (two Get Random vector outputs into Apply Force, say),
  // so it has to be considered before the hot-path no-op. Checking the cheap
  // "is there one at all?" first keeps a relay-free graph on the original fast path.
  const hasRelayCandidate = nodes.some(n => COMPOSITE_RELAY_TYPES.has(n.data.nodeType));
  if (compositeIds.size === 0 && !hasVecConsumer && !hasRelayCandidate) return { nodes, edges };

  const is3d = is3dModelLike(model);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // First edge into each (node, inputPort) — composite/scalar inputs are single-occupancy.
  const inEdge = new Map<string, GraphEdge>();
  for (const e of edges) {
    const key = inKey(e.target, portOf(e.targetHandle));
    if (!inEdge.has(key)) inEdge.set(key, e);
  }

  // Which `valueSwitch` nodes are COMPOSITE RELAYS — resolved through the shared
  // rule (BOTH branches must carry the same composite), so the editor's
  // validation and this lowering can never disagree about what a relay is. At
  // this point every stored-vector access has already become a Make/Break Vector
  // (lowerVectorAttrs ran first), so the STATIC port dataType is the whole answer
  // for a non-relay source — no model lookup is needed here.
  const compositeTypeOfOutput = makeCompositeTypeResolver({
    nodeTypeOf: id => nodeMap.get(id)?.data.nodeType,
    portCompositeType: (id, port) => staticPortCompositeType(nodeMap.get(id)?.data.nodeType, port, 'output'),
    sourceOf: (id, port) => {
      const e = inEdge.get(inKey(id, port));
      return e ? { nodeId: e.source, portId: portOf(e.sourceHandle) } : undefined;
    },
  });
  /** Relay id → the composite type it carries. A relay is treated exactly like a
   *  composite node: its edges are consumed by resolution and the node itself is
   *  dropped (its scalar emit would reference inputs that no longer exist). */
  const relayType = new Map<string, CompositeType>();
  for (const n of nodes) {
    if (!COMPOSITE_RELAY_TYPES.has(n.data.nodeType)) continue;
    const ct = compositeTypeOfOutput(n.id, RELAY_RESULT_PORT);
    if (ct) { relayType.set(n.id, ct); compositeIds.add(n.id); }
  }
  // No composite after all (a graph whose only Value Switches are scalar) ⇒ return
  // the SAME arrays, byte-identically to the pre-relay behaviour.
  if (compositeIds.size === 0 && !hasVecConsumer) return { nodes, edges };

  const synthNodes: GraphNode[] = [];
  const synthEdges: GraphEdge[] = [];
  let synthSeq = 0;
  // Rule Trace (S2): `__vec<n>` is a bare counter (deliberately — renaming it would
  // move emitted bytes on every target), so the ORIGIN is carried out-of-band. The
  // resolvers below set `originCtx` to the composite (node, port[, component]) they
  // are lowering; every id minted while that context is live is attributed to it.
  const origin: TraceOriginMap = new Map();
  let originCtx: TraceOrigin | undefined;
  const withOrigin = <T,>(o: TraceOrigin | undefined, f: () => T): T => {
    const saved = originCtx;
    if (o) originCtx = o;
    try { return f(); } finally { originCtx = saved; }
  };
  const nextId = () => {
    const id = `__vec${synthSeq++}`;
    if (originCtx) origin.set(id, originCtx);
    return id;
  };

  // Clone-on-write for real nodes whose config we set (inline literals / applyForce mode).
  const cloned = new Map<string, GraphNode>();
  const mutable = (id: string): GraphNode | undefined => {
    if (cloned.has(id)) return cloned.get(id);
    const n = nodeMap.get(id);
    if (!n) return undefined;
    const c: GraphNode = { ...n, data: { ...n.data, config: { ...n.data.config } } };
    cloned.set(id, c);
    return c;
  };

  /** Wire a resolved component to a target node's scalar input port. */
  const connect = (comp: Comp, targetId: string, targetPort: string): void => {
    if (comp.kind === 'wire') {
      synthEdges.push({ id: `${nextId()}e`, source: comp.source, sourceHandle: comp.sourceHandle, target: targetId, targetHandle: inH(targetPort) });
      return;
    }
    // Literal: set an inline widget value if the port has one, else a getConstant.
    const def = getNodeDef(nodeMap.get(targetId)?.data.nodeType ?? cloned.get(targetId)?.data.nodeType ?? '');
    const portDef = def?.ports.find(p => p.id === targetPort);
    if (portDef?.inlineWidget) {
      const m = mutable(targetId);
      if (m) m.data.config[`_port_${targetPort}`] = comp.value;
      return;
    }
    const id = nextId();
    synthNodes.push({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'getConstant', config: { constType: 'float', constValue: comp.value } } });
    synthEdges.push({ id: `${id}e`, source: id, sourceHandle: outH('value'), target: targetId, targetHandle: inH(targetPort) });
  };

  /** Build an arithmeticOperator node (x [op] y) and return a wire to its result. */
  const arith = (op: string, x: Comp, y: Comp | null): Comp => {
    const id = nextId();
    const config: Record<string, string | number | boolean> = { operation: op };
    const node: GraphNode = { id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'arithmeticOperator', config } };
    synthNodes.push(node);
    connect(x, id, 'x');
    if (y) connect(y, id, 'y');
    return { kind: 'wire', source: id, sourceHandle: outH('result') };
  };
  const LIT = (v: string): Comp => ({ kind: 'literal', value: v });

  /** Build a SCALAR `valueSwitch` (cond ? a : b) and return a wire to its result.
   *  The composite relay lowers to one of these PER COMPONENT, all sharing the
   *  ONE condition source — so the condition is evaluated exactly once however
   *  many components there are (an RNG condition draws once, per the documented
   *  "one Get Random node = one draw, shared" invariant), and every target emits
   *  the select through its already-verified scalar `valueSwitch` path. */
  const vswitch = (cond: Comp, a: Comp, b: Comp): Comp => {
    const id = nextId();
    synthNodes.push({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'valueSwitch', config: {} } });
    connect(cond, id, 'condition');
    connect(a, id, 'ifValue');
    connect(b, id, 'elseValue');
    return { kind: 'wire', source: id, sourceHandle: outH('result') };
  };

  // Memoized resolvers (cycle-guarded — vector graphs are DAGs, defensive).
  const vecMemo = new Map<string, Comp[]>();
  const scalarMemo = new Map<string, Comp>();
  const active = new Set<string>();

  /** The scalar value feeding a SCALAR input port of `nodeId`. */
  const resolveScalarInput = (nodeId: string, port: string): Comp => {
    const e = inEdge.get(inKey(nodeId, port));
    if (!e) {
      const cfg = nodeMap.get(nodeId)?.data.config ?? {};
      const def = getNodeDef(nodeMap.get(nodeId)?.data.nodeType ?? '');
      const dflt = def?.ports.find(p => p.id === port)?.defaultValue ?? '0';
      // Mirror getInlineValue: a CLEARED inline field is `''` (not undefined), and
      // must fall back to the port default — else makeColor.A clears to 0
      // (transparent) instead of 255, and vectorOp scale/lerp lose their 1/0.5.
      const raw = cfg[`_port_${port}`];
      return LIT(String(raw === undefined || raw === '' ? dflt : raw));
    }
    const srcType = nodeMap.get(e.source)?.data.nodeType ?? '';
    const srcPort = portOf(e.sourceHandle);
    if (COMPOSITE_NODE_TYPES.has(srcType) && (SCALAR_OUT_PORTS[srcType] ?? []).includes(srcPort)) {
      return scalarSourceOf(e.source, srcPort);
    }
    // A real scalar producer (or a composite VECTOR output wrongly wired into a
    // scalar port — isValidConnection prevents that; pass the wire through).
    return { kind: 'wire', source: e.source, sourceHandle: e.sourceHandle };
  };

  /** The N components feeding a VECTOR/COLOR input port of `nodeId`. */
  const resolveVecInput = (nodeId: string, port: string, arity: number): Comp[] => {
    const e = inEdge.get(inKey(nodeId, port));
    if (!e) return arity === 4 ? [LIT('0'), LIT('0'), LIT('0'), LIT('255')] : [LIT('0'), LIT('0'), LIT('0')];
    return vecComponentsOf(e.source, portOf(e.sourceHandle), arity);
  };

  /** The components of a composite VECTOR/COLOR output port. */
  function vecComponentsOf(nodeId: string, port: string, arity: number): Comp[] {
    const key = inKey(nodeId, port);
    const cached = vecMemo.get(key);
    if (cached) return cached;
    if (active.has(key)) return arity === 4 ? [LIT('0'), LIT('0'), LIT('0'), LIT('255')] : [LIT('0'), LIT('0'), LIT('0')];
    active.add(key);
    const savedCtx = originCtx;
    originCtx = { nodeId, portId: port };
    const type = nodeMap.get(nodeId)?.data.nodeType ?? '';
    let comps: Comp[];
    if (type === 'makeVector') {
      comps = [resolveScalarInput(nodeId, 'x'), resolveScalarInput(nodeId, 'y'), is3d ? resolveScalarInput(nodeId, 'z') : LIT('0')];
    } else if (type === 'makeColor') {
      comps = [resolveScalarInput(nodeId, 'r'), resolveScalarInput(nodeId, 'g'), resolveScalarInput(nodeId, 'b'), resolveScalarInput(nodeId, 'a')];
    } else if (type === 'vectorOp') {
      comps = synthVectorOpVector(nodeId);
    } else if (relayType.get(nodeId) && port === RELAY_RESULT_PORT) {
      // COMPOSITE RELAY (Value Switch over two composites): select COMPONENT BY
      // COMPONENT, through the node's OWN scalar form. The branches are resolved
      // at the relay's own arity (a colour relay keeps its alpha even if a
      // 3-arity consumer asked), then padded/truncated to what the consumer wants.
      const relayArity = COMPOSITE_ARITY[relayType.get(nodeId)!];
      // The condition feeds a scalar port, so a bool inline ('true'/'false') has
      // to arrive as the numeric literal the synthesized getConstant can parse.
      const condRaw = resolveScalarInput(nodeId, 'condition');
      const cond = condRaw.kind === 'literal'
        ? LIT(condRaw.value === 'true' ? '1' : condRaw.value === 'false' ? '0' : condRaw.value)
        : condRaw;
      const ifC = resolveVecInput(nodeId, RELAY_BRANCH_PORTS[0], relayArity);
      const elC = resolveVecInput(nodeId, RELAY_BRANCH_PORTS[1], relayArity);
      const pad = arity === 4 ? ['0', '0', '0', '255'] : ['0', '0', '0'];
      comps = Array.from({ length: arity }, (_, i) =>
        (i < relayArity ? vswitch(cond, ifC[i] ?? LIT('0'), elC[i] ?? LIT('0')) : LIT(pad[i] ?? '0')));
    } else if (type === 'getRandom') {
      // Get Random (vector / color mode) emits its components NATIVELY on every
      // target, so the composite output lowers to plain wires back to this SAME
      // node — never to synthesized arithmetic. That is what keeps the node
      // IMPURE-safe: every component resolves through the ONE multi-output emit,
      // i.e. one draw set, however many consumers the composite port has.
      const rt = String(nodeMap.get(nodeId)?.data.config?.randomType ?? '');
      comps = rt === 'color'
        // Alpha is a LITERAL 255: colour mode draws R/G/B only (see GetRandomNode).
        ? [
          { kind: 'wire', source: nodeId, sourceHandle: 'output_value_r' },
          { kind: 'wire', source: nodeId, sourceHandle: 'output_value_g' },
          { kind: 'wire', source: nodeId, sourceHandle: 'output_value_b' },
          LIT('255'),
        ]
        : [
          { kind: 'wire', source: nodeId, sourceHandle: 'output_value_x' },
          { kind: 'wire', source: nodeId, sourceHandle: 'output_value_y' },
          LIT('0'),
        ];
    } else {
      comps = [LIT('0'), LIT('0'), LIT('0')];
    }
    originCtx = savedCtx;
    active.delete(key);
    vecMemo.set(key, comps);
    return comps;
  }

  /** A composite SCALAR output (breakVector.x, breakColor.r, vectorOp.value). */
  function scalarSourceOf(nodeId: string, port: string): Comp {
    const key = inKey(nodeId, port);
    const cached = scalarMemo.get(key);
    if (cached) return cached;
    if (active.has(key)) return LIT('0');
    active.add(key);
    const savedCtx = originCtx;
    // A composite SCALAR output names its component directly (breakVector.x → 'x').
    originCtx = { nodeId, portId: port, ...(COMPONENT_PORTS.has(port) ? { component: port as TraceComponent } : {}) };
    const type = nodeMap.get(nodeId)?.data.nodeType ?? '';
    let comp: Comp;
    if (type === 'breakVector') {
      const idx = ['x', 'y', 'z'].indexOf(port);
      comp = resolveVecInput(nodeId, 'vector', 3)[idx] ?? LIT('0');
    } else if (type === 'breakColor') {
      const idx = ['r', 'g', 'b', 'a'].indexOf(port);
      comp = resolveVecInput(nodeId, 'color', 4)[idx] ?? LIT('0');
    } else if (type === 'vectorOp') {
      comp = synthVectorOpScalar(nodeId);
    } else {
      comp = LIT('0');
    }
    originCtx = savedCtx;
    active.delete(key);
    scalarMemo.set(key, comp);
    return comp;
  }

  // ── Vector Op synthesis ───────────────────────────────────────────────────
  const lengthOf = (v: Comp[]): Comp => {
    const sq = v.map(c => arith('*', c, c));
    const sumSq = arith('+', arith('+', sq[0]!, sq[1]!), sq[2]!);
    return arith('sqrt', sumSq, null);
  };
  /** The Angle° input in RADIANS. One node — reused by both cos and sin. */
  const angleRad = (nodeId: string): Comp =>
    arith('*', resolveScalarInput(nodeId, 'angle'), LIT(String(DEG_TO_RAD)));
  function synthVectorOpVector(nodeId: string): Comp[] {
    const op = String(nodeMap.get(nodeId)?.data.config?.op ?? 'add');
    const a = resolveVecInput(nodeId, 'a', 3);
    const b = resolveVecInput(nodeId, 'b', 3);
    switch (op) {
      case 'add': return [arith('+', a[0]!, b[0]!), arith('+', a[1]!, b[1]!), arith('+', a[2]!, b[2]!)];
      case 'subtract': return [arith('-', a[0]!, b[0]!), arith('-', a[1]!, b[1]!), arith('-', a[2]!, b[2]!)];
      case 'scale': { const s = resolveScalarInput(nodeId, 's'); return [arith('*', a[0]!, s), arith('*', a[1]!, s), arith('*', a[2]!, s)]; }
      case 'negate': return [arith('*', a[0]!, LIT('-1')), arith('*', a[1]!, LIT('-1')), arith('*', a[2]!, LIT('-1'))];
      case 'cross': return [
        arith('-', arith('*', a[1]!, b[2]!), arith('*', a[2]!, b[1]!)),
        arith('-', arith('*', a[2]!, b[0]!), arith('*', a[0]!, b[2]!)),
        arith('-', arith('*', a[0]!, b[1]!), arith('*', a[1]!, b[0]!)),
      ];
      case 'normalize': { const len = lengthOf(a); return [arith('/', a[0]!, len), arith('/', a[1]!, len), arith('/', a[2]!, len)]; }
      case 'lerp': { const t = resolveScalarInput(nodeId, 't'); return [
        arith('+', a[0]!, arith('*', arith('-', b[0]!, a[0]!), t)),
        arith('+', a[1]!, arith('*', arith('-', b[1]!, a[1]!), t)),
        arith('+', a[2]!, arith('*', arith('-', b[2]!, a[2]!), t)),
      ]; }
      // Rotate about +Z (the XY plane), Z passing through unchanged. Positive
      // angle rotates from +X toward +Y — which, because rows/Y grow DOWNWARD in
      // GenesisCA's world mapping, reads as CLOCKWISE on screen.
      case 'rotate2d': {
        const rad = angleRad(nodeId);
        const c = arith('cos', rad, null);   // one node each — shared by both
        const s = arith('sin', rad, null);   // component expressions below
        return [
          arith('-', arith('*', a[0]!, c), arith('*', a[1]!, s)),
          arith('+', arith('*', a[0]!, s), arith('*', a[1]!, c)),
          a[2]!,
        ];
      }
      // Rodrigues: v·cosθ + (k̂×v)·sinθ + k̂(k̂·v)(1−cosθ). The axis is normalised
      // through the SAME guarded divide `normalize` uses, so a ZERO axis yields
      // k̂ = (0,0,0) (÷0→0 on every target) and the result degenerates to v·cosθ.
      // cos/sin/(1−cos)/k̂/dot are each ONE synthesized node, reused per component
      // (sharing is structural — accessor-CSE is off in async agent mode).
      case 'rotateAxis': {
        const rad = angleRad(nodeId);
        const c = arith('cos', rad, null);
        const s = arith('sin', rad, null);
        const omc = arith('-', LIT('1'), c);
        const k = resolveVecInput(nodeId, 'axis', 3);
        const klen = lengthOf(k);
        const kn = [arith('/', k[0]!, klen), arith('/', k[1]!, klen), arith('/', k[2]!, klen)];
        const cross = [
          arith('-', arith('*', kn[1]!, a[2]!), arith('*', kn[2]!, a[1]!)),
          arith('-', arith('*', kn[2]!, a[0]!), arith('*', kn[0]!, a[2]!)),
          arith('-', arith('*', kn[0]!, a[1]!), arith('*', kn[1]!, a[0]!)),
        ];
        const dot = arith('+', arith('+', arith('*', kn[0]!, a[0]!), arith('*', kn[1]!, a[1]!)), arith('*', kn[2]!, a[2]!));
        const dotOmc = arith('*', dot, omc);
        return [0, 1, 2].map(i =>
          arith('+', arith('+', arith('*', a[i]!, c), arith('*', cross[i]!, s)), arith('*', kn[i]!, dotOmc)));
      }
      default: return [arith('+', a[0]!, b[0]!), arith('+', a[1]!, b[1]!), arith('+', a[2]!, b[2]!)];
    }
  }
  function synthVectorOpScalar(nodeId: string): Comp {
    const op = String(nodeMap.get(nodeId)?.data.config?.op ?? 'dot');
    const a = resolveVecInput(nodeId, 'a', 3);
    const b = resolveVecInput(nodeId, 'b', 3);
    switch (op) {
      case 'dot': { const m = [arith('*', a[0]!, b[0]!), arith('*', a[1]!, b[1]!), arith('*', a[2]!, b[2]!)]; return arith('+', arith('+', m[0]!, m[1]!), m[2]!); }
      case 'length': return lengthOf(a);
      case 'distance': { const d = [arith('-', a[0]!, b[0]!), arith('-', a[1]!, b[1]!), arith('-', a[2]!, b[2]!)]; return lengthOf(d); }
      default: { const m = [arith('*', a[0]!, b[0]!), arith('*', a[1]!, b[1]!), arith('*', a[2]!, b[2]!)]; return arith('+', arith('+', m[0]!, m[1]!), m[2]!); }
    }
  }

  // ── Rewrite ────────────────────────────────────────────────────────────────
  // (1) Exit edges: a composite SCALAR output feeding a REAL (non-composite)
  //     consumer's scalar input → rewire to the resolved scalar source.
  const keptEdges: GraphEdge[] = [];
  for (const e of edges) {
    const srcType = nodeMap.get(e.source)?.data.nodeType ?? '';
    const srcPort = portOf(e.sourceHandle);
    const tgtType = nodeMap.get(e.target)?.data.nodeType ?? '';
    const srcIsComposite = compositeIds.has(e.source);
    const tgtIsComposite = compositeIds.has(e.target);
    // Apply Force's force port (composite consumer) is handled in (2).
    const isVecConsumerEdge = tgtType === 'applyForce' && portOf(e.targetHandle) === 'force';
    if (srcIsComposite || tgtIsComposite || isVecConsumerEdge) {
      if (srcIsComposite && !tgtIsComposite && !isVecConsumerEdge && (SCALAR_OUT_PORTS[srcType] ?? []).includes(srcPort)) {
        withOrigin(
          { nodeId: e.source, portId: srcPort, ...(COMPONENT_PORTS.has(srcPort) ? { component: srcPort as TraceComponent } : {}) },
          () => connect(scalarSourceOf(e.source, srcPort), e.target, portOf(e.targetHandle)),
        );
      }
      // All other composite-touching edges are dropped (consumed by resolution).
      continue;
    }
    keptEdges.push(e);
  }

  // (2) Apply Force vector-input mode → wire the force vector's components to the
  //     existing fx / fy / fz scalar ports + flip the node to component mode so
  //     every target emits the adds (no per-target vector path).
  for (const n of nodes) {
    if (n.data.nodeType !== 'applyForce' || !n.data.config?.vectorInput) continue;
    const m = mutable(n.id)!;
    m.data.config.vectorInput = false;
    const comps = withOrigin({ nodeId: n.id, portId: 'force' }, () => resolveVecInput(n.id, 'force', 3));
    const ports = is3d ? ['fx', 'fy', 'fz'] : ['fx', 'fy'];
    ports.forEach((p, i) => withOrigin({ nodeId: n.id, portId: 'force' }, () => connect(comps[i] ?? LIT('0'), n.id, p)));
  }

  const outNodes: GraphNode[] = [];
  for (const n of nodes) {
    if (compositeIds.has(n.id)) continue;
    outNodes.push(cloned.get(n.id) ?? n);
  }
  outNodes.push(...synthNodes);
  return { nodes: outNodes, edges: [...keptEdges, ...synthEdges], origin };
}
