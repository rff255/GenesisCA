/**
 * Accessor CSE (common subexpression elimination) — sync-mode only.
 *
 * Many graphs repeat the same "pure accessor" pattern across independent
 * sub-expressions: a Gray-Scott reaction-diffusion graph naturally wants one
 * `GetCellAttribute(u)` per equation, one `GetNeighborsAttribute(u) →
 * Aggregate(sum)` per equation, and so on. Without CSE each instance compiles
 * to a separate read / scratch-fill / aggregate loop, even though every
 * instance with identical inputs produces an identical value within a single
 * cell iteration. Users end up sharing one accessor node and wiring spaghetti
 * to all consumers just to avoid the cost.
 *
 * This pass eliminates that tax: for every value-producing node whose output
 * is a pure function of (config, cell index, neighborhood index tables), it
 * computes a structural "purity key", groups nodes that share a key, picks one
 * canonical per group (lexicographically smallest node ID for stability), and
 * rewrites every edge whose source is a non-canonical equivalent to point at
 * the canonical instead. The orphaned non-canonicals become unreachable from
 * any flow root, so the downstream compilers (which only emit nodes reached
 * by flow-walk) never touch them.
 *
 * The output edge array is a drop-in replacement for the input edges — every
 * downstream consumer (sink analysis, loop-invariance, fusion, the three
 * target compilers) sees the deduplicated graph naturally because they all
 * look up sources via `inputToSource` / `inputToSources` built from those
 * edges. No per-target emit changes required.
 *
 * # Async mode
 *
 * The pass is a global no-op when `model.properties.updateMode === 'asynchronous'`.
 * Async-mode Step shares one buffer for reads and writes, so a cell that writes
 * its own attribute changes subsequent reads of that attribute. Two
 * `GetCellAttribute` instances at different points in the cell body can return
 * different values — CSE would silently merge them, breaking the model. The
 * Step function is the only place this matters (InputColor / OutputMapping /
 * Init are non-loop or read-only), but global edge rewriting spans all roots,
 * so the simplest sound design is "all-or-nothing per model".
 *
 * # Purity rules
 *
 * Impure (each instance must emit independently):
 *   - `getRandom`, `pickRandomNeighbor`, `pickNRandomNeighbors` — advance per-cell RNG state.
 *   - `getIndicator` — `_indicators[id]` is mutable mid-cell via SetIndicator/UpdateIndicator.
 *   - `aggregate` / `groupOperator` with `op === 'random'` — uniform pick from input array.
 *   - `macro` — opaque container; v1 doesn't introspect macro internals.
 *   - Entry-point types (`step`, `inputColor`, `initEvent`, `outputMapping`,
 *     `macroInput`, `macroOutput`) — their value outputs are externally provided
 *     function parameters, not computed expressions.
 *
 * Pure (CSE-eligible): any other value-producing node, provided every value
 * input source is also pure. A consumer wired to an impure source becomes
 * impure itself (the impurity propagates through the key) — `Compare(a=GetRandomA, b=Const)`
 * keys differently from `Compare(a=GetRandomB, b=Const)` even with identical
 * configs, because the random source IDs make the per-node nonpure tags differ.
 *
 * # Interactions with other compiler passes
 *
 * - **Sink analysis** — runs AFTER CSE; assigns each surviving (canonical)
 *   value node an emit scope based on the union of all merged uses. The LCA
 *   may land higher than where any single member alone would have landed, but
 *   in practice merged accessors in multi-equation models share the
 *   cell-top scope, so this isn't a regression.
 * - **Aggregate fusion** — runs AFTER CSE on the rewritten edges. When two
 *   equivalent `getNeighborsAttribute → aggregate` pipelines merge into one
 *   each, the canonical chain still has exactly one consumer and fuses
 *   normally. The corner case: two `aggregate` nodes with DIFFERENT ops over
 *   the SAME `getNeighborsAttribute` source. Pre-CSE, fusion gave us two
 *   inlined gather+reduce loops; post-CSE, the canonical scratch fills once
 *   and feeds two unfused reducers — a small regression on this specific
 *   shape. Accepted as a v1 tradeoff; v2 could fall back to per-source fusion
 *   eligibility checks.
 * - **Multi-output nodes** — handled naturally because `handleId` encodes only
 *   `${kind}_${category}_${portId}`, not the node ID. A rewritten edge from B
 *   to A keeps its sourceHandle; A has the same port set as B (same node
 *   type → same registry def → identical ports).
 */

import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { parseHandleId } from '../types';
import { getNodeDef } from '../nodes/registry';

/** Node types that are NEVER eligible for CSE, regardless of config or inputs. */
const NEVER_PURE_TYPES = new Set<string>([
  // RNG side effect — every instance advances per-cell RNG state.
  'getRandom',
  'pickRandomNeighbor',
  'pickNRandomNeighbors',
  // Mutable mid-cell via SetIndicator/UpdateIndicator.
  'getIndicator',
  // Local Variables: `_var_<id>` is mutable mid-cell/-agent via SetVariable /
  // SetArrayElement. CSE-merging two reads of the SAME scalar variable at
  // different program points would collapse them to one read at their common
  // (dominating) scope — fatal for an in-loop accumulator (`v = v + x`), whose
  // read MUST re-evaluate each iteration. Exactly the getIndicator rationale.
  'getVariable',
  // Bond-Graph Agents: a neighbour's attribute can be mutated mid-step by
  // Set Agent Attribute (immediate single-buffer write), so two reads of the
  // same neighbour attribute are not interchangeable.
  'getAgentAttribute',
  // Generic Agent Platform — impure agent-equivalent ops: the gathers read
  // mutable agent attrs (Set Agents Attribute), Get Bonded Agents reads the
  // mutable bond store, and the picks consume the shared RNG stream.
  'getAgentsAttribute',
  'getBondedAgents',
  'pickRandomAgent',
  'pickNRandomAgents',
  // Engine-buffer readers whose backing store the BEHAVIOUR graph can mutate
  // mid-agent via the live setters (Set Velocity / Set Agent Position / Set
  // Agent Radius write vx/x/radius DIRECTLY; the field deposits write _field_*
  // in place). Two structurally-identical reads straddling such a write are NOT
  // interchangeable — same rationale as getAgentAttribute above. The lost dedup
  // is a few array reads; correctness wins.
  'getVelocity',
  'getSelfPosition',
  'getAgentPosition',
  'getAgentOffset',
  'getAgentRadius',
  'getRadius',
  'getNearbyAgents',
  'getCurvature',
  'sampleField',
  'fieldGradient',
  'readCellsUnder',
  // Create Agent allocates a NEW slot per call — two Create Agents with the same
  // inline x/y/radius are two DIFFERENT agents; merging their handles retargets
  // every consumer onto one agent and leak-sweeps the other (silent population
  // loss in the Init Event).
  'createAgent',
  // Entry-point nodes — their "outputs" are external function params.
  'step',
  'initEvent',
  'inputColor',
  'outputMapping',
  'behaviourStep',
  'divisionEvent',
  'agentInit',
  'agentOutputMapping',
  // Macro boundary / opaque container — v1 doesn't introspect macro internals.
  'macro',
  'macroInput',
  'macroOutput',
]);

/** For nodes whose config carries an `operation` field, this set marks ops
 *  whose emit has a side effect (RNG advance / non-deterministic selection)
 *  and so must NEVER be CSE'd across instances. */
const IMPURE_OPS = new Set<string>(['random', 'weightedRandom']);

/** True iff the node TYPE is structurally pure (modulo config / inputs). */
function isPureType(node: GraphNode): boolean {
  const t = node.data.nodeType;
  if (NEVER_PURE_TYPES.has(t)) return false;
  if ((t === 'aggregate' || t === 'groupOperator') && IMPURE_OPS.has(String(node.data.config.operation))) {
    return false;
  }
  // A node with ANY flow port is never a CSE source: its value outputs (a
  // forEachBond/forEachInArray's per-iteration element/index, a Create Agent's
  // handle) are declared block-scoped INSIDE its flow emit — canonicalizing two
  // instances rewires the second's consumers onto an out-of-scope const
  // (runtime ReferenceError). Zero-config flow nodes (two bare For Each Bonds)
  // share identical purity keys, so this class collides unconditionally.
  const def = getNodeDef(t);
  if (def && def.ports.some(p => p.category === 'flow')) return false;
  return true;
}

/** True iff this node type produces at least one value-output port. */
function isValueProducer(nodeType: string): boolean {
  const def = getNodeDef(nodeType);
  if (!def) return false;
  return def.ports.some(p => p.kind === 'output' && p.category === 'value');
}

interface Adj {
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
}

function buildAdj(nodes: GraphNode[], edges: GraphEdge[]): Adj {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  for (const e of edges) {
    const sh = parseHandleId(e.sourceHandle);
    const th = parseHandleId(e.targetHandle);
    if (!sh || !th) continue;
    if (th.category !== 'value') continue;
    const key = `${e.target}:${th.portId}`;
    // First source wins for the single-source map (matches the main compiler).
    if (!inputToSource.has(key)) {
      inputToSource.set(key, { nodeId: e.source, portId: sh.portId });
    }
    const arr = inputToSources.get(key) ?? [];
    arr.push({ nodeId: e.source, portId: sh.portId });
    inputToSources.set(key, arr);
  }
  return { nodeMap, inputToSource, inputToSources };
}

/**
 * Recursive structural key for a value-producing node. Returns null if the
 * node is impure (or transitively depends on an impure node) — those nodes
 * are not CSE-eligible and stay as-is.
 *
 * The key incorporates node type, config (excluding underscored compiler-
 * injected keys), and the canonical keys of each value-input source. Two
 * nodes share a key iff they would emit byte-identical expressions within a
 * single cell iteration.
 */
function purityKey(
  nodeId: string,
  adj: Adj,
  cache: Map<string, string | null>,
  visiting: Set<string>,
): string | null {
  const cached = cache.get(nodeId);
  if (cached !== undefined) return cached;
  if (visiting.has(nodeId)) {
    // Cycle in the value DAG — shouldn't happen in a valid graph. Be safe.
    cache.set(nodeId, null);
    return null;
  }
  visiting.add(nodeId);

  const node = adj.nodeMap.get(nodeId);
  if (!node) { cache.set(nodeId, null); visiting.delete(nodeId); return null; }
  const def = getNodeDef(node.data.nodeType);
  if (!def) { cache.set(nodeId, null); visiting.delete(nodeId); return null; }
  if (!isPureType(node)) { cache.set(nodeId, null); visiting.delete(nodeId); return null; }

  // Configuration enters the key, except for compiler-injected underscored
  // keys (e.g., _resolvedTagIndex, _elemKind, _indicatorIdx, _attr_*_default) —
  // those are derived from other config / graph structure, so
  // structurally-identical nodes already match on the source keys that produced
  // them. CRUCIAL exception: `_port_*` (inline widget values) and `_varName_*`
  // (expression variable names) are USER-FACING inputs that change the emitted
  // output, despite the leading underscore. They MUST stay in the key — without
  // them, two nodes differing only in an inline value (e.g. two Compares reading
  // the same attribute but testing `== 5` vs `== 10`, or two Get Array Element
  // nodes at different inline positions) would collapse into one.
  const configEntries: Array<[string, string | number | boolean]> = [];
  for (const k of Object.keys(node.data.config).sort()) {
    if (k.startsWith('_') && !k.startsWith('_port_') && !k.startsWith('_varName_')) continue;
    configEntries.push([k, node.data.config[k]!]);
  }
  const configPart = JSON.stringify(configEntries);

  // Value-input sources keyed by port. Multi-edge ports (isArray) preserve
  // edge order, since some consumers are position-sensitive (e.g.,
  // ProportionMap reads source index → output color). Static ports come from
  // def.ports; dynamic ports (switch case_N_cond / case_N_val) come from
  // the edge map directly.
  const seenPorts = new Set<string>();
  const inputParts: string[] = [];

  const staticInputs = def.ports
    .filter(p => p.kind === 'input' && p.category === 'value')
    .map(p => ({ id: p.id, isArray: !!p.isArray }));
  // Sort by port id for stable key ordering (port set is fixed per node type).
  staticInputs.sort((a, b) => a.id.localeCompare(b.id));

  function srcTag(s: { nodeId: string; portId: string }): string {
    const k = purityKey(s.nodeId, adj, cache, visiting);
    if (k == null) {
      // Impure source — tag uniquely by node id + port so two consumers wired
      // to DIFFERENT random / indicator sources don't collide on the same key.
      return `nonpure:${s.nodeId}:${s.portId}`;
    }
    return `${k}@${s.portId}`;
  }

  for (const p of staticInputs) {
    seenPorts.add(p.id);
    const key = `${nodeId}:${p.id}`;
    if (p.isArray) {
      const srcs = adj.inputToSources.get(key) ?? [];
      inputParts.push(`${p.id}=[${srcs.map(srcTag).join('|')}]`);
    } else {
      const src = adj.inputToSource.get(key);
      inputParts.push(`${p.id}=${src ? srcTag(src) : '<unconnected>'}`);
    }
  }

  // Dynamic value inputs (switch case_N_cond / case_N_val). Sort port ids for
  // a stable key.
  const dynamicEntries: Array<[string, { nodeId: string; portId: string }]> = [];
  for (const [k, src] of adj.inputToSource) {
    if (!k.startsWith(`${nodeId}:`)) continue;
    const portId = k.slice(nodeId.length + 1);
    if (seenPorts.has(portId)) continue;
    dynamicEntries.push([portId, src]);
  }
  dynamicEntries.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [portId, src] of dynamicEntries) {
    inputParts.push(`${portId}=${srcTag(src)}`);
  }

  const key = `${node.data.nodeType}|cfg=${configPart}|in=${inputParts.join(',')}`;
  cache.set(nodeId, key);
  visiting.delete(nodeId);
  return key;
}

/**
 * Build a remap `nonCanonicalId → canonicalId` for every value-producing pure
 * node that shares a purity key with at least one other node. Used by
 * `canonicalizeAccessorEdges` to rewrite edges; also exposed for diagnostics.
 */
export function buildCanonicalRemap(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, string> {
  const adj = buildAdj(nodes, edges);
  const cache = new Map<string, string | null>();
  const visiting = new Set<string>();

  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    if (!isValueProducer(node.data.nodeType)) continue;
    const key = purityKey(node.id, adj, cache, visiting);
    if (key == null) continue;
    const list = groups.get(key) ?? [];
    list.push(node.id);
    groups.set(key, list);
  }

  const remap = new Map<string, string>();
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    // Lexicographically smallest member is canonical — stable across runs and
    // independent of edge insertion order.
    const canonical = members.slice().sort()[0]!;
    for (const m of members) {
      if (m !== canonical) remap.set(m, canonical);
    }
  }

  return remap;
}

/**
 * Rewrite `edges` so that every edge sourced from a non-canonical equivalent
 * is redirected to the canonical equivalent. `sourceHandle` is left intact
 * because `handleId` does not encode the source node id — same node TYPE has
 * the same port set, so the existing handle id is correct for the canonical
 * source too.
 *
 * No-op when `model.properties.updateMode === 'asynchronous'` (see file header).
 * Also a no-op when no group has more than one member (typical for single-
 * accessor models like Game of Life — zero overhead beyond the analysis pass).
 */
export function canonicalizeAccessorEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
  model: CAModel | undefined,
): GraphEdge[] {
  if (model?.properties.updateMode === 'asynchronous') return edges;

  const remap = buildCanonicalRemap(nodes, edges);
  if (remap.size === 0) return edges;

  return edges.map(e => {
    const canon = remap.get(e.source);
    if (!canon) return e;
    return { ...e, source: canon };
  });
}
