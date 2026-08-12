/**
 * Async read-after-write hazard detector (target-independent).
 *
 * In ASYNCHRONOUS update mode `r_<attr>` and `w_<attr>` alias one buffer, so a
 * write to attribute A is immediately visible to a later read of A. But sink
 * analysis ([sinkAnalysis.ts]) treats an attribute read (getCellAttribute, the
 * neighbour reads, orientation/facing reads) as a pure, hoistable value and may
 * emit it ABOVE a write to the same attribute that precedes it in flow order —
 * capturing the stale pre-write value. (Canonical repro: the Snake model's
 * "Can it move?" gate read `Direction` before the direction-decision branch
 * wrote it, while the move re-read it afterwards — gate and move disagreed.)
 *
 * This analyzer returns every DIRECT attribute/orientation reader node whose
 * value is consumed at a flow position where a write to the SAME attribute may
 * already have executed (in flow order). The compiler unions these ids into its
 * "volatile" set (see volatileHoist.ts); membership excludes them from
 * sink-to-cell-top and forces emission at the use site — AFTER the write.
 *
 * PRECISE: a reader is flagged ONLY when a matching write may precede its use.
 * Readers of never-written attributes, and readers that precede every write,
 * are not flagged → byte-identical output (zero regression). No-op for sync
 * mode (`isAsync === false`); WebGPU rejects async at the model level so it
 * never reaches here.
 *
 * Attribute matching is at the attribute-id granularity (a synthetic
 * `__orientation__` key matches orientation read/write pairs). We deliberately
 * do NOT discriminate self-vs-neighbour cell index — a neighbourhood may include
 * the central cell, indices are runtime values, and over-flagging is safe (it
 * only relocates emission; the result stays correct).
 *
 * The flow walk mirrors volatileHoist.ts / sinkAnalysis.ts (Sequence is
 * transparent; conditional/loop/forEach/switch open child scopes) so "flow
 * order" matches `compileFlowChain` emission order on both JS and WASM. The
 * input graph must be FLAT (macros already expanded) — same precondition as the
 * sibling analyzers.
 */

import type { GraphNode } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';

/** Synthetic attribute key for the built-in per-cell orientation buffer (it has
 *  no `Attribute` object / config.attributeId). */
const ORIENTATION_KEY = '__orientation__';

/** Bond-Graph Agents — synthetic keys for the live engine buffers the behaviour
 *  graph can mutate mid-agent (Set Velocity / Set Agent Position / Set Agent
 *  Radius write vx / x / radius DIRECTLY, in BOTH agent update modes). A read of
 *  the same buffer later in flow order must not be hoisted above the write.
 *  Field reads (sampleField / fieldGradient / readCellsUnder) are deliberately
 *  NOT hazard keys: all three targets snapshot the field at agent-loop top
 *  (D-FIELD "sample before deposit"; WebGPU's fieldRead buffer is structurally a
 *  step-start snapshot), so pinning them would diverge from the GPU. */
const VELOCITY_KEY = '__agentVelocity__';
const POSITION_KEY = '__agentPosition__';
const RADIUS_KEY = '__agentRadius__';

/** Sequence runs `first`/`then`/`then_N` at its OWN scope — identical to
 *  sinkAnalysis.ts:TRANSPARENT_FLOW_TYPES and volatileHoist.ts. Keep in sync. */
const TRANSPARENT_FLOW_TYPES = new Set(['sequence']);

/** Value nodes that read per-cell attribute / orientation storage directly
 *  (emit `r_<attr>[...]` / `r_orientation[...]`). Consumers of these (aggregate,
 *  compares, etc.) are NOT listed — they become volatile through the closure. */
const DIRECT_READER_TYPES = new Set<string>([
  'getCellAttribute',
  'getNeighborAttributeByIndex',
  'getNeighborAttributeByTag',
  'getNeighborsAttribute',
  'getNeighborsAttrByIndexes',
  'filterNeighbors',
  'getOrientation',
  'getFacingOrientation',
  'getNeighborOrientationByIndex',
  'getFacingLabels',
  'getAllFacingLabels',
  // Bond-Graph Agents (behaviour / division roots — these types never appear in
  // a cell graph, so the lattice path is unaffected). getCellAttribute above
  // doubles as the own-agent attribute read on the Agents graph.
  'getAgentAttribute',
  'getAgentsAttribute',
  'getVelocity',
  'getSelfPosition',
  'getAgentPosition',
  'getAgentOffset',
  'getCurvature',
  'getNearbyAgents',
  'getAgentsInView',
  'senseHemifield',
  'getRadius',
  'getAgentRadius',
]);

/** Attribute keys a direct-reader node reads. */
function attrKeysRead(node: GraphNode): string[] {
  const cfg = node.data.config;
  switch (node.data.nodeType) {
    case 'getCellAttribute':
    case 'getNeighborAttributeByIndex':
    case 'getNeighborAttributeByTag':
    case 'getNeighborsAttribute':
    case 'getNeighborsAttrByIndexes':
    case 'filterNeighbors': {
      const a = cfg.attributeId as string | undefined;
      return a ? [a] : [];
    }
    case 'getOrientation':
    case 'getFacingOrientation':
    case 'getNeighborOrientationByIndex':
      return [ORIENTATION_KEY];
    // --- Bond-Graph Agents ---
    case 'getAgentAttribute':
    case 'getAgentsAttribute': {
      const a = cfg.attributeId as string | undefined;
      return a ? [a] : [];
    }
    case 'getVelocity':
      return [VELOCITY_KEY];
    case 'getSelfPosition':
    case 'getAgentPosition':
    case 'getAgentOffset':
    case 'getCurvature':
    case 'getNearbyAgents':
      return [POSITION_KEY];
    case 'getAgentsInView':
    case 'senseHemifield':
      // Reads neighbour POSITIONS (the cone offset) + the agent's own VELOCITY when
      // the heading source is velocity (the default). Wired heading reads no attr.
      return cfg.headingSource === 'wired' ? [POSITION_KEY] : [POSITION_KEY, VELOCITY_KEY];
    case 'getRadius':
    case 'getAgentRadius':
      return [RADIUS_KEY];
    case 'getFacingLabels':
    case 'getAllFacingLabels': {
      // Reads orientation + the variegation source ("species") attribute. The
      // source id is baked into config._sourceAttrId by preResolveVariegatedNodes
      // (which runs before this analysis on every target).
      const keys = [ORIENTATION_KEY];
      const src = cfg._sourceAttrId as string | undefined;
      if (src) keys.push(src);
      return keys;
    }
    default:
      return [];
  }
}

/** Attribute keys a flow/action node writes. */
function attrKeysWritten(node: GraphNode): string[] {
  const cfg = node.data.config;
  switch (node.data.nodeType) {
    case 'setAttribute':
    case 'updateAttribute':
    case 'setNeighborhoodAttribute':
    case 'setNeighborAttributeByIndex': {
      const a = cfg.attributeId as string | undefined;
      return a ? [a] : [];
    }
    case 'setOrientation':
    case 'setFacingOrientation':
    case 'setNeighborOrientationByIndex':
      return [ORIENTATION_KEY];
    // --- Bond-Graph Agents ---
    case 'setVelocity':
      return [VELOCITY_KEY];
    case 'setAgentPosition':
      return [POSITION_KEY];
    case 'setAgentRadius':
      return [RADIUS_KEY];
    case 'moveSelfToNeighbor': {
      const keys: string[] = [];
      const payloadCount = Math.max(1, Number(cfg.payloadCount) || 1);
      for (let i = 0; i < payloadCount; i++) {
        const a = cfg[`attr_${i}`] as string | undefined;
        if (a) keys.push(a);
      }
      const includeOri = cfg._includeOriResolved !== undefined
        ? !!cfg._includeOriResolved
        : !!cfg.includeOrientation;
      if (includeOri) keys.push(ORIENTATION_KEY);
      return keys;
    }
    // markCellUpdated writes the scheduler flag (_skipped), not attribute
    // storage — not a hazard source.
    default:
      return [];
  }
}

export interface AsyncHazardInput {
  /** Flat (post-macro-expansion) node map. */
  nodeMap: Map<string, GraphNode>;
  inputToSource: Map<string, { nodeId: string; portId: string }>;
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>;
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>;
  /** Entry flow node (step / initEvent). */
  rootNodeId: string;
  /** Flow output port on the root that starts the chain (e.g. 'do'). */
  rootFlowPortId: string;
  /** Only async-mode step/init roots have the single-buffer hazard. */
  isAsync: boolean;
}

/** Returns the ids of DIRECT-READER nodes that have a may-write-before hazard.
 *  Empty when `isAsync` is false. */
export function computeAsyncReadWriteHazards(input: AsyncHazardInput): Set<string> {
  const hazards = new Set<string>();
  if (!input.isAsync) return hazards;
  const { nodeMap, inputToSource, inputToSources, flowOutputToTargets, rootNodeId, rootFlowPortId } = input;

  /** Value-input source node ids of `nodeId` — static def ports + dynamic
   *  edge-map ports (switch `case_N_cond/val`). Mirrors sinkAnalysis /
   *  volatileHoist. */
  function valueInputSources(nodeId: string): string[] {
    const node = nodeMap.get(nodeId);
    if (!node) return [];
    const def = getNodeDef(node.data.nodeType);
    if (!def) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      seen.add(port.id);
      if (port.isArray) {
        const m = inputToSources.get(`${nodeId}:${port.id}`);
        if (m) for (const s of m) out.push(s.nodeId);
      } else {
        const s = inputToSource.get(`${nodeId}:${port.id}`);
        if (s) out.push(s.nodeId);
      }
    }
    for (const [key, source] of inputToSource) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const portId = key.slice(nodeId.length + 1);
      if (seen.has(portId)) continue;
      out.push(source.nodeId);
    }
    return out;
  }

  // --- Phase A: writesInSubtree(flowNodeId) — attr keys written by the node and
  //     its entire flow subtree. Memoized; cache set before recursion (cycle /
  //     diamond guard). Includes all flow output ports (then/else/body/case_N/
  //     default/first/then_N) so a write nested in a Sequence's `first` branch
  //     counts toward the Sequence's subtree. ---
  const subtreeCache = new Map<string, Set<string>>();
  function writesInSubtree(flowNodeId: string): Set<string> {
    const cached = subtreeCache.get(flowNodeId);
    if (cached) return cached;
    const acc = new Set<string>();
    subtreeCache.set(flowNodeId, acc);
    const node = nodeMap.get(flowNodeId);
    if (node) for (const k of attrKeysWritten(node)) acc.add(k);
    for (const [key, targets] of flowOutputToTargets) {
      if (!key.startsWith(`${flowNodeId}:`)) continue;
      for (const t of targets) for (const k of writesInSubtree(t.nodeId)) acc.add(k);
    }
    return acc;
  }
  function bodyWrites(flowNodeId: string, portIds: string[]): Set<string> {
    const acc = new Set<string>();
    for (const portId of portIds) {
      const targets = flowOutputToTargets.get(`${flowNodeId}:${portId}`);
      if (!targets) continue;
      for (const t of targets) for (const k of writesInSubtree(t.nodeId)) acc.add(k);
    }
    return acc;
  }

  // --- readersInCone(flowNodeId): every direct-reader node in the transitive
  //     value-input cone of a flow node (its condition / count / array / switch
  //     case conds+vals / action value). Memoized (prefix-independent). ---
  const coneCache = new Map<string, Array<{ id: string; keys: string[] }>>();
  function readersInCone(flowNodeId: string): Array<{ id: string; keys: string[] }> {
    const cached = coneCache.get(flowNodeId);
    if (cached) return cached;
    const result: Array<{ id: string; keys: string[] }> = [];
    const seen = new Set<string>();
    const stack = [...valueInputSources(flowNodeId)];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = nodeMap.get(id);
      if (!node) continue;
      if (DIRECT_READER_TYPES.has(node.data.nodeType)) {
        const keys = attrKeysRead(node);
        if (keys.length) result.push({ id, keys });
      }
      // Keep walking inputs: a reader's own inputs (e.g. an index source) may
      // themselves be hazarded readers.
      for (const s of valueInputSources(id)) stack.push(s);
    }
    coneCache.set(flowNodeId, result);
    return result;
  }
  function checkReaders(flowNodeId: string, prefix: Set<string>): void {
    if (prefix.size === 0) return;
    for (const r of readersInCone(flowNodeId)) {
      if (hazards.has(r.id)) continue;
      for (const k of r.keys) if (prefix.has(k)) { hazards.add(r.id); break; }
    }
  }

  function unionWith(a: Set<string>, b: Set<string>): Set<string> {
    if (b.size === 0) return a;
    const out = new Set(a);
    for (const k of b) out.add(k);
    return out;
  }

  // --- Phase B: walk flow carrying a `prefix` of attr keys written before the
  //     current point. `entryPrefix` accumulates the union over all paths that
  //     reach a node (so a diamond join is checked conservatively); children are
  //     re-walked only when that union grows (monotone → terminates; flow has no
  //     cycles, and growth is bounded by the attr-key count). ---
  const entryPrefix = new Map<string, Set<string>>();
  const childrenWalked = new Set<string>();

  function walkOutput(srcNodeId: string, srcPortId: string, prefix: Set<string>): void {
    const targets = flowOutputToTargets.get(`${srcNodeId}:${srcPortId}`);
    if (!targets) return;
    // Targets of one port are emitted in array order (matches compileFlowChain);
    // each later sibling sees earlier siblings' subtree writes.
    let running = prefix;
    for (const t of targets) {
      walkNode(t.nodeId, running);
      running = unionWith(running, writesInSubtree(t.nodeId));
    }
  }

  function walkNode(nodeId: string, incoming: Set<string>): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    let entry = entryPrefix.get(nodeId);
    let grew = false;
    if (!entry) { entry = new Set(incoming); entryPrefix.set(nodeId, entry); grew = true; }
    else { for (const k of incoming) if (!entry.has(k)) { entry.add(k); grew = true; } }

    checkReaders(nodeId, entry);

    if (childrenWalked.has(nodeId) && !grew) return;
    childrenWalked.add(nodeId);

    const type = node.data.nodeType;
    if (TRANSPARENT_FLOW_TYPES.has(type)) {
      const ports = ['first', 'then'];
      const extra = Number(node.data.config.extraCount) || 0;
      for (let si = 2; si < 2 + extra; si++) ports.push(`then_${si}`);
      let running = entry;
      for (const p of ports) {
        walkOutput(nodeId, p, running);
        running = unionWith(running, bodyWrites(nodeId, [p]));
      }
      return;
    }
    if (type === 'conditional') {
      walkOutput(nodeId, 'then', entry);
      walkOutput(nodeId, 'else', entry);
      // DONE chain runs after the construct: branches MAY have written.
      walkOutput(nodeId, 'next', unionWith(entry, bodyWrites(nodeId, ['then', 'else'])));
    } else if (type === 'loop' || type === 'forEachInArray') {
      // A write anywhere in the body precedes a read anywhere in the body on the
      // next iteration → seed the body prefix with the whole body's writes.
      const bodyPrefix = unionWith(entry, bodyWrites(nodeId, ['body']));
      walkOutput(nodeId, 'body', bodyPrefix);
      walkOutput(nodeId, 'next', bodyPrefix);
    } else if (type === 'switch') {
      const caseCount = Number(node.data.config.caseCount) || 0;
      if (caseCount === 0) {
        walkOutput(nodeId, 'default', entry);
        walkOutput(nodeId, 'next', unionWith(entry, bodyWrites(nodeId, ['default'])));
      } else {
        const casePorts: string[] = [];
        for (let ci = 0; ci < caseCount; ci++) {
          casePorts.push(`case_${ci}`);
          walkOutput(nodeId, `case_${ci}`, entry);
        }
        if (flowOutputToTargets.has(`${nodeId}:default`)) {
          casePorts.push('default');
          walkOutput(nodeId, 'default', entry);
        }
        walkOutput(nodeId, 'next', unionWith(entry, bodyWrites(nodeId, casePorts)));
      }
    } else {
      // Action nodes (setAttribute, setVariable, stopEvent, …): the NEXT chain
      // runs after the action — its own writes join the prefix.
      walkOutput(nodeId, 'next', unionWith(entry, new Set(attrKeysWritten(node))));
    }
  }

  walkOutput(rootNodeId, rootFlowPortId, new Set());
  return hazards;
}
