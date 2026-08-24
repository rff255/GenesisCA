/**
 * D3 / D4 — "does the DIVISION EVENT use X?", the two predicates every surface
 * that conditionally widens the `division` ABI consults, so they cannot disagree.
 *
 * Both new blocks (`__siblingId` and the structural REQUEST QUEUE) are appended
 * to the `division` kind behind a usage gate, for the same reason `_generation`
 * is: an unconditional field would change the emitted `agent.divisionCode` of
 * EVERY model that carries a Division Event, and byte-identity is the milestone's
 * primary regression net (`check-compile-identity`).
 *
 * ── THE GATE IS SYMMETRIC, unlike `_generation` (Impact Map §5.3) ────────────
 * `_generation` is param-gated but ALWAYS passed, which the worker's DEV arity
 * assert tolerates as `params ∈ {args − 1, args}`. A SECOND always-passed-but-
 * param-gated field would widen that tolerance to `args − 2` and weaken the
 * check. So these two flags gate BOTH sides: the compiler derives them from the
 * model, SHIPS them in the init/recompile message, and the worker's
 * `agentAbiShapeOfStore` reads the shipped record — exactly the discipline
 * `agentFieldGates` / `agentBondReqSlots` already use. The arity assert stays
 * exact.
 *
 * ── TWO RULES THE IMPLEMENTATION KEEPS ──────────────────────────────────────
 *
 *  1. **A SUPERSET is the safe direction, and these deliberately are one.**
 *     `true` costs one unread trailing param (harmless); `false` while the
 *     flattened graph actually uses the feature emits code referencing an
 *     UNDECLARED identifier (`_v<id>_siblingId` / `_bondFormReq`) — the division
 *     fn then throws at runtime, `agentDivisionFn` is nulled, and every later
 *     division event is silently skipped. So the scans over-approximate: a
 *     REACHED macro instance contributes its WHOLE body (exactly what
 *     `expandMacros` produces), and a macroDef that itself contains a
 *     `divisionEvent` root is scanned wholesale.
 *
 *  2. **The scope is the DIVISION SUBTREE, never the whole agent graph.** A GRA
 *     model rewrites bonds in its BEHAVIOUR step (`Growing Graphs`, `SDCA`,
 *     `Cubic GRA`) and may also carry a Division Event; a whole-graph scan would
 *     hand those models the queue block they do not use and diff their
 *     `agent.divisionCode`. Reachability is over the model's OWN edges — flow
 *     edges OUT of a reached node (its downstream chain) + value edges INTO one
 *     (its input cone) — the same walk `targetDiagnosis.behaviourReachedIds`
 *     uses for the behaviour root, and the same scope the agent compilers use.
 *
 * NOTE the sizing of the queue itself needs NO change: `bondReqSlotsForModel`
 * ([bondRequestQueue.ts]) scans `model.agentGraphNodes` unscoped — the whole
 * agent graph, division subtree included — so a queue verb placed ONLY in a
 * Division Event already sizes the store's request arrays today.
 */

import type { CAModel, GraphNode, GraphEdge, MacroDef } from '../../../model/types';
import { parseHandleId } from '../types';
import { BOND_REQUEST_NODE_TYPES } from './bondRequestQueue';

/** The Division Event root's `siblingId` value output (D3). */
export const DIVISION_SIBLING_PORT = 'siblingId';

type AgentGraphModel = Pick<CAModel, 'agentGraphNodes' | 'agentGraphEdges' | 'macroDefs' | 'topologyMode'>;

/** Nodes reachable from EVERY `divisionEvent` root in one node/edge set — the
 *  division-subtree analogue of `behaviourReachedIds`. Flow edges OUT of a
 *  reached node + value edges INTO one; following value edges OUTWARD would be
 *  wrong (a value producer shared with the Behaviour Step would drag that
 *  separately-compiled subtree in). */
function divisionReachedNodes(
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge>,
): GraphNode[] {
  const byId = new Map(nodes.map(n => [n.id, n] as const));
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (n.data?.nodeType === 'divisionEvent') { reached.add(n.id); queue.push(n.id); }
  }
  while (queue.length) {
    const id = queue.pop()!;
    for (const e of edges) {
      let next: string | null = null;
      if (e.source === id && e.sourceHandle?.startsWith('output_flow')) next = e.target;
      else if (e.target === id && e.targetHandle?.startsWith('input_value')) next = e.source;
      if (next && !reached.has(next)) { reached.add(next); queue.push(next); }
    }
  }
  return [...reached].map(id => byId.get(id)).filter((n): n is GraphNode => !!n);
}

/** Macro-aware node walk (the `targetDiagnosis.walkNodes` shape): a `macro`
 *  instance contributes its WHOLE definition, recursively, with a `seen` guard.
 *  Returns true as soon as `hit` accepts a node type. */
function anyNodeType(
  roots: ReadonlyArray<GraphNode> | undefined,
  macroDefs: ReadonlyArray<MacroDef>,
  hit: (nodeType: string) => boolean,
  seen: Set<string> = new Set(),
): boolean {
  for (const n of roots ?? []) {
    const t = n.data?.nodeType;
    if (!t) continue;
    if (t === 'macro') {
      const defId = n.data?.config?.macroDefId as string | undefined;
      if (defId && !seen.has(defId)) {
        seen.add(defId);
        const def = macroDefs.find(d => d.id === defId);
        if (def && anyNodeType(def.nodes, macroDefs, hit, seen)) return true;
      }
      continue;
    }
    if (hit(t)) return true;
  }
  return false;
}

/** Every macroDef that itself contains a `divisionEvent` root. Bizarre but
 *  possible (`compileAgentGraph` finds the root on the FLATTENED node list, so
 *  such a def's root is real), and the conservative arm that keeps the scans a
 *  superset of the flattened graph. */
function macroDefsWithDivisionRoot(model: AgentGraphModel): MacroDef[] {
  return (model.macroDefs ?? []).filter(d => (d.nodes ?? []).some(n => n.data?.nodeType === 'divisionEvent'));
}

/** Is a value output of a `divisionEvent` node WIRED to anything, in one
 *  node/edge set? (`portId` is unique to that root, but the node-type test keeps
 *  the predicate honest if a later node reuses the id.) */
function divisionPortWired(
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge>,
  portId: string,
): boolean {
  const divIds = new Set(nodes.filter(n => n.data?.nodeType === 'divisionEvent').map(n => n.id));
  if (divIds.size === 0) return false;
  for (const e of edges) {
    if (!divIds.has(e.source)) continue;
    if (parseHandleId(e.sourceHandle ?? '')?.portId === portId) return true;
  }
  return false;
}

/** D3 — does the Division Event's `siblingId` output feed anything?
 *
 *  The gate must be a SUPERSET of "the FLATTENED graph wires it", because the
 *  compiler emits the `_v<id>_siblingId` alias whenever the PARAM exists (never
 *  from its own flattened-edge test), so `true`-but-unwired is a dead alias while
 *  `false`-but-wired is an undeclared reference. Every flattening preserves the
 *  edge's SOURCE (a reroute collapses to the real source; a macro bridge rewires
 *  to the internal consumer), so a raw-model scan is that superset. */
export function agentUsesDivisionSibling(model: AgentGraphModel | null | undefined): boolean {
  if (!model) return false;
  if (model.topologyMode && model.topologyMode.agents === false) return false;
  const nodes = model.agentGraphNodes ?? [];
  const edges = model.agentGraphEdges ?? [];
  if (divisionPortWired(nodes, edges, DIVISION_SIBLING_PORT)) return true;
  for (const def of macroDefsWithDivisionRoot(model)) {
    if (divisionPortWired(def.nodes ?? [], def.edges ?? [], DIVISION_SIBLING_PORT)) return true;
  }
  return false;
}

/** D4 — does the Division Event's subtree contain a structural REQUEST-QUEUE verb
 *  (Form / Break / Rewire / Transfer Bond)?
 *
 *  True ⇒ the `division` ABI carries the queue block (so those verbs emit code
 *  that resolves) AND the worker runs a SECOND `drainAgentBondRequests` after the
 *  division events, applying what they queued. False ⇒ the pre-D4 signature and
 *  the pre-D4 structural phase, byte-for-byte. */
export function agentUsesDivisionRequests(model: AgentGraphModel | null | undefined): boolean {
  if (!model) return false;
  if (model.topologyMode && model.topologyMode.agents === false) return false;
  const macroDefs = model.macroDefs ?? [];
  const hit = (t: string) => BOND_REQUEST_NODE_TYPES.has(t);
  const reached = divisionReachedNodes(model.agentGraphNodes ?? [], model.agentGraphEdges ?? []);
  if (anyNodeType(reached, macroDefs, hit)) return true;
  for (const def of macroDefsWithDivisionRoot(model)) {
    if (anyNodeType(def.nodes ?? [], macroDefs, hit)) return true;
  }
  return false;
}
