/**
 * Composite (vector / color) RELAY resolution — the composite sibling of
 * `arrayRelay.ts`.
 *
 * `valueSwitch` (`result = cond ? ifValue : elseValue`) is a pure SELECTOR: its
 * output shape is its input shape. `arrayRelay.ts` already teaches the two agent
 * backends that it relays ARRAYS; this module is the same statement for the
 * COMPOSITE types — when BOTH branches carry a `vector` (or both a `color`), the
 * result IS that composite, which `nodeType` alone cannot express.
 *
 * Two consumers, one rule, so the editor and the compiler can never disagree
 * about what a relay's result is:
 *   - `expandComposites` (the LOWERING) — a composite relay is rewritten into N
 *     SCALAR `valueSwitch` nodes, one per component, sharing the condition. So
 *     the whole feature rides the already-verified scalar `valueSwitch` emitters
 *     on JS / WASM / WebGPU (cell + agent), 2D + 3D — ZERO per-target emit.
 *   - `isValidConnection` (the EDITOR) — a composite may be wired into a relay
 *     branch, and a relay's result may feed a composite sink.
 *
 * ── THE "BOTH BRANCHES" RULE ────────────────────────────────────────────────
 * A relay carries a composite only when BOTH branches produce the SAME composite
 * type — exactly the rule `makeProducesArray` uses for arrays, and for the same
 * reason: one composite branch and one scalar branch has no well-defined
 * per-component meaning ("what are the Y and Z of the number 3?"). The editor
 * refuses to CREATE that state (a scalar into a branch whose sibling is already a
 * composite is rejected, and a mixed relay's result reports no composite type, so
 * it cannot be wired into a composite sink). A graph that reaches it anyway —
 * a paste, a hand-edited file, or DELETING one branch edge after the fact — is
 * reported BY NAME as a compile error by `detectCompositeShapeMismatch`, never
 * silently lowered to zeros.
 *
 * ⚠ THIS MODULE MUST NEVER THROW. `expandComposites` runs inside
 * `flattenAgentGraph`, which the agent capability GATES call — and those are
 * evaluated during a React render (`resolveEngines` / the Compatibility block).
 * An exception there would white-screen the app, so every shape complaint is
 * returned as a string from the compile-path-only detector below.
 */

import type { CAModel, GraphEdge, GraphNode } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';
import { vectorPortDims } from './vectorAttr';
import { slotVectorDims } from './multiAttrExpand';

export type CompositeType = 'vector' | 'color';

/** Component count per composite type — vector is (x, y, z), color is (r, g, b, a). */
export const COMPOSITE_ARITY: Record<CompositeType, number> = { vector: 3, color: 4 };

export const isCompositeType = (t: string | undefined): t is CompositeType =>
  t === 'vector' || t === 'color';

/** The node types that RELAY a composite (dual-mode selectors). `valueSwitch` is
 *  the only one; a `switch` in value mode is deliberately NOT here (see the
 *  sweep note in CLAUDE.md — its dynamic per-case ports have no composite
 *  representation and it refuses composites at validation instead). */
export const COMPOSITE_RELAY_TYPES: ReadonlySet<string> = new Set(['valueSwitch']);
/** The relay's two branch INPUT ports (both must agree) … */
export const RELAY_BRANCH_PORTS = ['ifValue', 'elseValue'] as const;
/** … and its OUTPUT port. */
export const RELAY_RESULT_PORT = 'result';

/** Guard: a relay chain deeper than this is a hand-edited pathology. */
const MAX_RELAY_DEPTH = 64;

export interface CompositeResolverDeps {
  /** The node's registry type, or undefined for an unknown / missing node. */
  nodeTypeOf: (nodeId: string) => string | undefined;
  /** The composite type of a port WITHOUT relay resolution — the static
   *  `PortDef.dataType` plus whatever the caller derives (the editor also applies
   *  `vectorPortDims` / `slotVectorDims`, so a vector ATTRIBUTE read counts). */
  portCompositeType: (nodeId: string, portId: string) => CompositeType | null;
  /** First edge into `(nodeId, portId)` — value inputs are single-occupancy. */
  sourceOf: (nodeId: string, portId: string) => { nodeId: string; portId: string } | undefined;
}

/**
 * Build the context-aware "what composite does this OUTPUT emit?" resolver.
 * Returns null for a scalar / array / unknown output. Memoised and cycle-guarded
 * (the value graph is a DAG; the guard is defensive against a hand-edited
 * self-referential edge).
 */
export function makeCompositeTypeResolver(
  deps: CompositeResolverDeps,
): (nodeId: string, portId: string) => CompositeType | null {
  const { nodeTypeOf, portCompositeType, sourceOf } = deps;
  const memo = new Map<string, CompositeType | null>();
  const active = new Set<string>();

  function branchType(nodeId: string, port: string, depth: number): CompositeType | null {
    const src = sourceOf(nodeId, port);
    if (!src) return null; // unwired branch ⇒ the inline scalar ⇒ not a composite
    return resolve(src.nodeId, src.portId, depth + 1);
  }

  function resolve(nodeId: string, portId: string, depth: number): CompositeType | null {
    const direct = portCompositeType(nodeId, portId);
    if (direct) return direct;
    if (depth > MAX_RELAY_DEPTH) return null;
    const t = nodeTypeOf(nodeId);
    if (!t || !COMPOSITE_RELAY_TYPES.has(t) || portId !== RELAY_RESULT_PORT) return null;
    const key = `${nodeId} ${portId}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (active.has(key)) return null; // cycle guard
    active.add(key);
    const a = branchType(nodeId, RELAY_BRANCH_PORTS[0], depth);
    const b = branchType(nodeId, RELAY_BRANCH_PORTS[1], depth);
    const out = a !== null && a === b ? a : null;
    active.delete(key);
    memo.set(key, out);
    return out;
  }

  return (nodeId, portId) => resolve(nodeId, portId, 0);
}

/** A REROUTE is not a registry node — it is an editor-only pure wire relay that
 *  carries the relayed port's own `dataType` in `node.data`, and
 *  `collapseReroutes` erases it before any lowering. So a rerouted composite is
 *  perfectly legal and both the editor and the shape gate must resolve THROUGH
 *  it; ONE helper so they cannot disagree. */
export function rerouteCompositeType(data: unknown): CompositeType | null {
  const d = (data ?? {}) as { nodeType?: string; dataType?: string };
  if (d.nodeType !== 'reroute') return null;
  return isCompositeType(d.dataType) ? d.dataType : null;
}

/** The composite type a port declares STATICALLY (registry `dataType` only) —
 *  the compiler-side `portCompositeType`, since by the time `expandComposites`
 *  runs every stored-vector access has already become a Make/Break Vector. */
export function staticPortCompositeType(
  nodeType: string | undefined,
  portId: string,
  kind: 'input' | 'output',
): CompositeType | null {
  if (!nodeType) return null;
  const p = getNodeDef(nodeType)?.ports.find(x => x.id === portId && x.kind === kind);
  return isCompositeType(p?.dataType) ? p!.dataType as CompositeType : null;
}

/** The composite type a port carries in the EDITOR — the static `dataType` PLUS
 *  the two config-derived retypes (`vectorPortDims` for a picked vector
 *  attribute/variable on a `value` port, `slotVectorDims` for a multi-attr extra
 *  slot). Shared by `isValidConnection` and the shape gate so the two agree. */
export function editorPortCompositeType(
  nodeType: string | undefined,
  portId: string,
  kind: 'input' | 'output',
  config: Record<string, unknown> | undefined,
  model: CAModel | undefined | null,
): CompositeType | null {
  if (!nodeType) return null;
  if (portId === 'value' && vectorPortDims(nodeType, config, model)) return 'vector';
  if (slotVectorDims(nodeType, portId, config, model)) return 'vector';
  return staticPortCompositeType(nodeType, portId, kind);
}

/**
 * Compile-path shape gate: report a composite wire the lowering cannot honour,
 * BY NAME, instead of emitting code that reads an undeclared identifier (the
 * `w_mag[idx] = _v<id>_vector` failure mode) or silently lowering to zeros.
 *
 * Two cases, both only reachable by a paste / hand-edit / an edge deleted after
 * the fact — `isValidConnection` refuses to create either:
 *   1. a composite source wired into a port that is NOT composite (and is not a
 *      relay branch);
 *   2. a relay whose two branches disagree (one composite, or two different
 *      composites) while its result feeds a composite consumer.
 *
 * Runs on the FLAT graph, beside `detectDanglingRefs`, and NEVER throws.
 */
export function detectCompositeShapeMismatch(
  nodes: GraphNode[],
  edges: GraphEdge[],
  model: CAModel,
): string | undefined {
  // Cheap gate: no composite-typed port anywhere in the graph ⇒ nothing to check.
  const hasCompositeCandidate = nodes.some(n => {
    const t = n.data?.nodeType;
    if (!t) return false;
    if (COMPOSITE_RELAY_TYPES.has(t)) return true;
    return (getNodeDef(t)?.ports ?? []).some(p => isCompositeType(p.dataType));
  });
  if (!hasCompositeCandidate) return undefined;

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const portOf = (h: string | undefined) => (h ? h.replace(/^(input|output)_value_/, '') : '');
  const inSrc = new Map<string, { nodeId: string; portId: string }>();
  for (const e of edges) {
    if (!e.targetHandle?.startsWith('input_value_')) continue;
    const key = `${e.target} ${portOf(e.targetHandle)}`;
    if (!inSrc.has(key)) inSrc.set(key, { nodeId: e.source, portId: portOf(e.sourceHandle) });
  }
  const cfgOf = (id: string) => nodeMap.get(id)?.data?.config as Record<string, unknown> | undefined;
  const typeOf = (id: string) => nodeMap.get(id)?.data?.nodeType;
  const resolve = makeCompositeTypeResolver({
    nodeTypeOf: typeOf,
    portCompositeType: (id, port) =>
      rerouteCompositeType(nodeMap.get(id)?.data)
      ?? editorPortCompositeType(typeOf(id), port, 'output', cfgOf(id), model),
    sourceOf: (id, port) => inSrc.get(`${id} ${port}`),
  });
  const labelOf = (id: string) => {
    const n = nodeMap.get(id);
    return (n?.data as { label?: string } | undefined)?.label
      ?? getNodeDef(n?.data?.nodeType ?? '')?.label ?? n?.data?.nodeType ?? id;
  };

  const issues: string[] = [];
  const seenRelay = new Set<string>();
  for (const e of edges) {
    if (!e.sourceHandle?.startsWith('output_value_') || !e.targetHandle?.startsWith('input_value_')) continue;
    const srcType = typeOf(e.source);
    const tgtType = typeOf(e.target);
    const srcPort = portOf(e.sourceHandle);
    const tgtPort = portOf(e.targetHandle);
    const src = resolve(e.source, srcPort);

    // (2) A relay feeding a composite consumer while its own branches disagree.
    if (!src && srcType && COMPOSITE_RELAY_TYPES.has(srcType) && srcPort === RELAY_RESULT_PORT) {
      const branches = RELAY_BRANCH_PORTS.map(p => {
        const s = inSrc.get(`${e.source} ${p}`);
        return s ? resolve(s.nodeId, s.portId) : null;
      });
      if (branches.some(Boolean) && !seenRelay.has(e.source)) {
        seenRelay.add(e.source);
        issues.push(`${labelOf(e.source)}: both branches must carry the same type — got ${branches.map(b => b ?? 'a number').join(' and ')}.`);
      }
      continue;
    }
    if (!src) continue;

    // A reroute takes ANY shape (it is a pure wire); the real check happens on
    // the edge leaving it, which this same loop visits.
    if (tgtType === 'reroute') continue;
    // (1) A composite source into a port that cannot take it.
    const tgt = editorPortCompositeType(tgtType, tgtPort, 'input', cfgOf(e.target), model);
    if (tgt === src) continue;
    const tgtPortDef = tgtType ? getNodeDef(tgtType)?.ports.find(p => p.id === tgtPort && p.kind === 'input') : undefined;
    if (!tgt && tgtPortDef?.compositeCapable) continue; // a relay branch takes any composite
    issues.push(`${labelOf(e.target)}: the "${tgtPortDef?.label ?? tgtPort}" input cannot take a ${src} — connect it through Break ${src === 'color' ? 'Color' : 'Vector'}.`);
  }
  return issues.length ? issues.join(' ') : undefined;
}
