/** RULE TRACE (P4) — the EDITOR-side graph maths, with no DOM in it.
 *
 * The highlighter in `GraphEditor` has to answer four questions per trace, and
 * all four are pure functions of the editor's own nodes/edges plus one resolved
 * origin. They live here so `scripts/test-rule-trace.mjs` can drive the SHIPPED
 * functions rather than a transcription of them (the house rule every other
 * trace module follows).
 *
 *  1. **Which node of the OPEN SCOPE does this record light?** — `originInEditorScope`.
 *  2. **Which wire did a value travel down?** — `buildEditorTraceIndex().edgeOrigin`.
 *  3. **Which values fed the flow that has run so far?** — `valueConeFrom`.
 *  4. **Which macro def is this instance an instance OF?** — `buildMacroDefIndex`.
 *
 * ⚠ TWO ID SPACES, AND MIXING THEM IS THE TRAP THIS MODULE EXISTS FOR.
 * A trace record's `macroPath` (from `expandMacros`) names macro **INSTANCE
 * node ids** — `m<instanceId>_<innerId>`. The graph editor's scope stack names
 * macro **DEF ids** (`setCurrentScope(prev => [...prev, macroDefId])`), because
 * entering a macro edits the shared DEFINITION, not one instance of it. So:
 *
 *   • the VISIBILITY test (is this record inside the scope I am looking at?)
 *     must run in DEF space — otherwise nothing inside any macro ever lights;
 *   • the ANSWER (which node id do I light?) must stay in INSTANCE space —
 *     a def id names no node on the canvas.
 *
 * `originInEditorScope` does exactly that, delegating the prefix rule itself to
 * the shipped `originInScope` so there is still only ONE copy of it. The
 * consequence is deliberate and is the honest reading of a def-scoped editor:
 * **inside a macro def, the records of EVERY instance of that def light** (they
 * are the same nodes), while at the root each instance lights its own node.
 *
 * REROUTES are editor-only relays (`rerouteCollapse.ts` removes them before any
 * compile), so a value the trace recorded on `A:out` reaches `B` through two or
 * more editor edges the compiler never saw. Rather than walking the path
 * forwards from a lit source, every edge is resolved ONCE to the real port it
 * ultimately carries (`edgeOrigin`) — then "light every edge whose origin has a
 * record" lights the whole chain, dots included, with no path walking per trace.
 */

import type { TraceOrigin } from '../modeler/vpl/compiler/traceOrigin';
import type { OriginInScope } from './traceOrigin';
import { originInScope } from './traceOrigin';

// ---------------------------------------------------------------------------
// The minimal shapes this module needs. Structural, so React Flow's `Node` /
// `Edge` and the `.gcaproj` `GraphNode` / `GraphEdge` both satisfy them.
// ---------------------------------------------------------------------------

export interface TraceEditorNode {
  id: string;
  type?: string;
  data?: unknown;
}

export interface TraceEditorEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export type TracePortCategory = 'value' | 'flow';

/** The real (non-reroute) output port a wire ultimately carries. */
export interface TraceWireOrigin {
  nodeId: string;
  portId: string;
  category: TracePortCategory;
}

export interface EditorTraceIndex {
  /** Editor-only relay nodes — they carry no record of their own. */
  reroutes: Set<string>;
  /** edge id → the REAL source port it carries (reroute chains resolved). */
  edgeOrigin: Map<string, TraceWireOrigin>;
  /** reroute node id → the REAL source port the dot relays. */
  rerouteOrigin: Map<string, TraceWireOrigin>;
  /** edge id → the real (non-reroute) target nodes it ultimately reaches. */
  edgeTargets: Map<string, string[]>;
  /** node id → the real source nodes feeding its VALUE inputs. */
  valueSources: Map<string, string[]>;
  /** `<nodeId>:<inputPortId>` → the real source port wired into it. The hover
   *  tooltip reads a node's INPUTS through this (an `If`'s interesting value is
   *  its condition, which is produced by somebody else). */
  valueInputOrigin: Map<string, TraceWireOrigin>;
}

const HANDLE_RE = /^(?:input|output)_(value|flow)_(.+)$/;

/** `output_value_result` → `{ category: 'value', portId: 'result' }`. Copied
 *  rather than imported from `vpl/types.ts` so this module stays dependency-free
 *  (the harness bundles it on its own). */
export function parseTraceHandle(
  handle: string | null | undefined,
): { category: TracePortCategory; portId: string } | null {
  if (!handle) return null;
  const m = HANDLE_RE.exec(handle);
  if (!m) return null;
  return { category: m[1] as TracePortCategory, portId: m[2]! };
}

function isRerouteNode(n: TraceEditorNode): boolean {
  if (n.type === 'rerouteNode') return true;
  const d = n.data as { nodeType?: unknown } | undefined;
  return d?.nodeType === 'reroute';
}

/** Build the per-graph index. O(N + E); rebuilt only when the graph changes,
 *  never per trace. */
export function buildEditorTraceIndex(
  nodes: readonly TraceEditorNode[],
  edges: readonly TraceEditorEdge[],
): EditorTraceIndex {
  const reroutes = new Set<string>();
  for (const n of nodes) if (isRerouteNode(n)) reroutes.add(n.id);

  // A reroute has exactly ONE inbound edge (enforced by `isValidConnection`);
  // "first inbound wins" is the same defensive fallback `collapseReroutes` keeps
  // for hand-edited files.
  const inboundOfReroute = new Map<string, TraceEditorEdge>();
  const outboundOfReroute = new Map<string, TraceEditorEdge[]>();
  for (const e of edges) {
    if (reroutes.has(e.target) && !inboundOfReroute.has(e.target)) inboundOfReroute.set(e.target, e);
    if (reroutes.has(e.source)) {
      const cur = outboundOfReroute.get(e.source);
      if (cur) cur.push(e); else outboundOfReroute.set(e.source, [e]);
    }
  }

  /** Walk upstream from (node, handle) until the node is not a reroute. */
  const resolveUpstream = (
    startNode: string, startHandle: string | null | undefined,
  ): TraceWireOrigin | null => {
    let node = startNode;
    let handle = startHandle;
    const seen = new Set<string>();
    while (reroutes.has(node)) {
      if (seen.has(node)) return null;      // cycle — a hand-edited file
      seen.add(node);
      const inb = inboundOfReroute.get(node);
      if (!inb) return null;                // relaying nothing
      node = inb.source;
      handle = inb.sourceHandle;
    }
    const h = parseTraceHandle(handle);
    if (!h) return null;
    return { nodeId: node, portId: h.portId, category: h.category };
  };

  const rerouteOrigin = new Map<string, TraceWireOrigin>();
  for (const id of reroutes) {
    const inb = inboundOfReroute.get(id);
    if (!inb) continue;
    const o = resolveUpstream(inb.source, inb.sourceHandle);
    if (o) rerouteOrigin.set(id, o);
  }

  const edgeOrigin = new Map<string, TraceWireOrigin>();
  for (const e of edges) {
    const o = reroutes.has(e.source)
      ? rerouteOrigin.get(e.source)
      : resolveUpstream(e.source, e.sourceHandle);
    if (o) edgeOrigin.set(e.id, o);
  }

  // Forward walk: the real consumers a wire ultimately reaches (a flow edge into
  // a reroute chain runs whatever the chain feeds).
  const targetsOfReroute = new Map<string, string[]>();
  const realTargetsFrom = (nodeId: string, seen: Set<string>): string[] => {
    if (!reroutes.has(nodeId)) return [nodeId];
    const cached = targetsOfReroute.get(nodeId);
    if (cached) return cached;
    if (seen.has(nodeId)) return [];
    seen.add(nodeId);
    const out: string[] = [];
    for (const e of outboundOfReroute.get(nodeId) ?? []) {
      for (const t of realTargetsFrom(e.target, seen)) if (!out.includes(t)) out.push(t);
    }
    targetsOfReroute.set(nodeId, out);
    return out;
  };
  const edgeTargets = new Map<string, string[]>();
  for (const e of edges) edgeTargets.set(e.id, realTargetsFrom(e.target, new Set()));

  // VALUE feed map, reroutes resolved away. A reroute is not a consumer: every
  // real consumer downstream of it already resolves through it via its own edge.
  const valueSources = new Map<string, string[]>();
  const valueInputOrigin = new Map<string, TraceWireOrigin>();
  for (const e of edges) {
    if (reroutes.has(e.target)) continue;
    const th = parseTraceHandle(e.targetHandle);
    const o = edgeOrigin.get(e.id);
    if (!o) continue;
    const category = th?.category ?? o.category;
    if (category !== 'value') continue;
    const cur = valueSources.get(e.target);
    if (cur) { if (!cur.includes(o.nodeId)) cur.push(o.nodeId); }
    else valueSources.set(e.target, [o.nodeId]);
    // A value input is single-occupancy (`isValidConnection`), so first wins is
    // also only-one; an array input takes several and the first is shown.
    if (th) {
      const key = `${e.target}:${th.portId}`;
      if (!valueInputOrigin.has(key)) valueInputOrigin.set(key, o);
    }
  }

  return { reroutes, edgeOrigin, rerouteOrigin, edgeTargets, valueSources, valueInputOrigin };
}

/** Every node reachable from `seeds` by walking VALUE inputs backwards — the
 *  "value cone" the plan's cursor section draws.
 *
 *  Why it is load-bearing: the JS compiler HOISTS values above the flow, so a
 *  trace's value records nearly all precede its first flow record. Lighting
 *  every value node with a record ≤ the cursor would therefore light the whole
 *  data half of the graph the moment the cursor leaves `null`. Restricting to
 *  the cone of what has actually RUN is what makes stepping mean something. */
export function valueConeFrom(
  seeds: Iterable<string>,
  index: Pick<EditorTraceIndex, 'valueSources'>,
): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const s of seeds) stack.push(s);
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const src of index.valueSources.get(id) ?? []) {
      if (out.has(src)) continue;
      out.add(src);
      stack.push(src);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Macro scope — the two id spaces (see the module header)
// ---------------------------------------------------------------------------

/** instance node id → the macro DEF id it instantiates. */
export type MacroDefIndex = ReadonlyMap<string, string>;

/** Collect every macro INSTANCE in a set of graphs (the top-level graphs plus
 *  every macro def's own subgraph, so nested instances are covered too). */
export function buildMacroDefIndex(
  graphs: ReadonlyArray<readonly TraceEditorNode[] | undefined>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of graphs) {
    if (!g) continue;
    for (const n of g) {
      const d = n.data as { nodeType?: unknown; config?: Record<string, unknown> } | undefined;
      if (d?.nodeType !== 'macro') continue;
      const defId = d.config?.macroDefId;
      if (typeof defId === 'string' && defId) out.set(n.id, defId);
    }
  }
  return out;
}

/** A macro definition, as much of it as the wire mapping needs. */
export interface TraceMacroDef {
  id: string;
  nodes: readonly TraceEditorNode[];
  edges: readonly TraceEditorEdge[];
}

/** def id → (`<innerNodeId>:<innerPortId>` → the macro OUTPUT ports that carry it).
 *
 *  Why: at the root scope a record inside a macro rolls up to the INSTANCE node,
 *  but the wire leaving that instance is labelled with the INSTANCE's port id,
 *  which no record ever mentions. The bridge is the def's `macroOutput` boundary
 *  node: an edge `inner:port → macroOutput:<outPortId>` says "the instance's
 *  `outPortId` carries `inner:port`" — the same rule `expandMacros` uses when it
 *  re-targets the outer consumers (`macroExpand.ts`, the `tgtInner` arm).
 *
 *  ⚠ ONE LEVEL. A record two levels deep rolls up to the OUTER instance, and
 *  relating it to that instance's ports would mean chaining this map through the
 *  nested instance's own bridge. The outer instance still LIGHTS (it executed);
 *  only its outgoing wire stays unlit until the user steps into the scope. */
export function buildMacroOutputMap(
  defs: readonly TraceMacroDef[] | undefined,
): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const def of defs ?? []) {
    const boundary = new Set<string>();
    for (const n of def.nodes) {
      const d = n.data as { nodeType?: unknown } | undefined;
      if (d?.nodeType === 'macroOutput') boundary.add(n.id);
    }
    if (boundary.size === 0) continue;
    const map = new Map<string, string[]>();
    for (const e of def.edges) {
      if (!boundary.has(e.target)) continue;
      const sh = parseTraceHandle(e.sourceHandle);
      const th = parseTraceHandle(e.targetHandle);
      const outPort = th?.portId ?? e.targetHandle;
      if (!sh || !outPort) continue;
      const key = `${e.source}:${sh.portId}`;
      const cur = map.get(key);
      if (cur) { if (!cur.includes(outPort)) cur.push(outPort); }
      else map.set(key, [outPort]);
    }
    if (map.size > 0) out.set(def.id, map);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The traced ROOT's own node
// ---------------------------------------------------------------------------

/** Root key prefix → the node type that declares that root, for the keys that
 *  name a mapping rather than a node (`outputMapping:<mappingId>`). */
const MAPPING_ROOTS: Record<string, string> = {
  outputMapping: 'outputMapping',
  inputColor: 'inputColor',
  agentOutputMapping: 'agentOutputMapping',
  agentInputMapping: 'agentInputMapping',
};
/** The bare root keys, by the node type that declares them. */
const SIMPLE_ROOTS: Record<string, string> = {
  step: 'step',
  init: 'initEvent',
  gridInit: 'gridInit',
  agentBehaviour: 'behaviourStep',
  agentInit: 'agentInit',
  agentDivision: 'divisionEvent',
};

/** Which node of the OPEN graph is the ROOT of this trace?
 *
 *  Why it is needed at all: the root's body IS the emitted wrapper, so the
 *  compiler records no `_tr.f` for it — nothing in the event log ever names it.
 *  It plainly DID run (the trace exists because it did), and the plan's §3
 *  drawing lights it, so the highlighter treats it as executed. Answered from
 *  the editor's own nodes rather than from a record, which is also why it is
 *  pure and testable.
 *
 *  A periodic key already carries its node id; a mapping key carries the
 *  mapping's, matched against the root node's `config.mappingId`. */
export function traceRootNodeId(
  rootKey: string,
  nodes: readonly TraceEditorNode[],
): string | null {
  const typeOf = (n: TraceEditorNode): string | undefined =>
    (n.data as { nodeType?: string } | undefined)?.nodeType;
  const colon = rootKey.indexOf(':');
  if (colon < 0) {
    const want = SIMPLE_ROOTS[rootKey];
    if (!want) return null;
    return nodes.find(n => typeOf(n) === want)?.id ?? null;
  }
  const prefix = rootKey.slice(0, colon);
  const rest = rootKey.slice(colon + 1);
  // `gridPeriodic:<nodeId>` / `agentPeriodic:<nodeId>` name the node directly.
  if (prefix === 'gridPeriodic' || prefix === 'agentPeriodic') {
    return nodes.some(n => n.id === rest) ? rest : null;
  }
  const want = MAPPING_ROOTS[prefix];
  if (!want) return null;
  const hit = nodes.find(n => {
    if (typeOf(n) !== want) return false;
    const cfg = (n.data as { config?: Record<string, unknown> } | undefined)?.config;
    return (cfg?.mappingId ?? '') === rest;
  });
  return hit?.id ?? null;
}

/** Map one RESOLVED origin onto the scope the EDITOR is showing.
 *
 *  `scope` is the editor's macro-DEF path (its stack minus the `'root'`
 *  sentinel — exactly what `getOpenMacroScope()` returns). `defOf` turns an
 *  instance node id into the def id it instantiates; an unknown instance falls
 *  back to itself, which makes this function degrade to plain `originInScope`
 *  when no index has been built (and keeps the P3 harness's instance-space
 *  checks meaningful). */
export function originInEditorScope(
  resolved: TraceOrigin,
  scope: readonly string[],
  defOf: (instanceId: string) => string,
): OriginInScope {
  const instPath = resolved.macroPath ?? [];
  if (instPath.length === 0 && scope.length === 0) {
    // The overwhelmingly common case — skip both allocations.
    return { visible: true, nodeId: resolved.nodeId };
  }
  const defPath = instPath.map(defOf);
  const verdict = originInScope({ ...resolved, macroPath: defPath }, scope);
  if (!verdict.visible) return verdict;
  // Visible — but `originInScope` answered in DEF space. Re-answer the node id
  // in INSTANCE space, which is the only space that names a node on the canvas.
  if (instPath.length === scope.length) return { visible: true, nodeId: resolved.nodeId };
  return { visible: true, nodeId: instPath[scope.length]! };
}
