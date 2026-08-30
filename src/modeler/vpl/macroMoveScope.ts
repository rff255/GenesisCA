/**
 * MOVE A SELECTION ACROSS A MACRO BOUNDARY — the pure rewiring engine.
 *
 * Adding a node to an existing macro (or pulling one out) used to mean either
 * Undo Macro (which DESTROYS the def, losing every Explicit Control and group
 * the author configured) + re-create, or cut/enter/paste + hand-rewire every
 * wire that crossed the boundary. This module is the direct alternative: given
 * a def, its parent graph, the instance node and a moving selection, it returns
 * the new def + the new parent graph with EVERY connection preserved.
 *
 * DOM-free and dependency-light on purpose — GraphEditor drives it, the DEV
 * hook drives it, and `scripts/test-macro-move-scope.mjs` drives the SAME
 * shipped code rather than a re-implementation.
 *
 * ── THE PORT RULE (inherited from 05a668a, and it is the law here too) ────────
 * ONE exposed port per distinct SOURCE port, never one per crossing edge:
 *   • an INPUT  port is keyed by the OUTER  (source, sourceHandle) — its fan-out
 *     to several internal consumers lives INSIDE the def (one bridge each);
 *   • an OUTPUT port is keyed by the INTERNAL (source, sourceHandle) — its
 *     fan-out to several outer consumers lives OUTSIDE (one outer edge each).
 * Both key on the edge's SOURCE side, which is what makes the merge always
 * legal: a value OUTPUT may fan out, while a value INPUT is single-occupancy
 * (`isValidConnection`), so a group can never need to fold two wires into one
 * input.
 *
 * ── WHAT MAKES A PORT DISAPPEAR ──────────────────────────────────────────────
 * A port whose reason to exist just walked across the boundary is REMOVED, and
 * the wires it carried are re-made directly. That is the whole point: a node
 * moved INTO a macro must not keep talking to the macro through a port whose
 * only feeder is now inside it.
 *   • MOVE IN, a port the moved node FED: internalise the port's bridges, then
 *     drop the port iff no OUTER feeder remains. (A FLOW input legitimately
 *     takes several feeders, so "no remaining feeder" is a real test, not a
 *     foregone conclusion — a value input's single feeder just moved, so it
 *     always is.)
 *   • MOVE IN, a port the moved node CONSUMED: same, mirrored.
 *   • MOVE OUT, `MacroInput.in_k -> movedNode`: drop the port iff no OTHER
 *     internal consumer remains; otherwise KEEP it and additionally wire the
 *     outer source straight to the moved node (a fan-out from an OUTPUT port,
 *     always legal).
 *   • MOVE OUT, `movedNode -> MacroOutput.out_k`: the port's ONE internal
 *     source is leaving, so it always goes; every outer consumer is rewired to
 *     the moved node directly.
 *
 * ⚠ A REMOVED PORT INVALIDATES WIRES AT EVERY OTHER INSTANCE, in every graph.
 * This module reports them in `removedInputPortIds` / `removedOutputPortIds`;
 * dropping those wires model-wide is the caller's job (ModelContext's
 * `PRUNE_MACRO_INSTANCE_EDGES`, which reuses `patchAllEdges`). Leaving them
 * would point a wire at a port that no longer exists.
 *
 * ⚠ MOVE OUT IS REFUSED FOR A DEF WITH MORE THAN ONE INSTANCE — pulling a node
 * out of a def silently removes that computation from every OTHER instance too.
 * The caller enforces it (it owns the model-wide instance count); this module
 * only needs the instance node it is told about.
 */
import type { GraphEdge, GraphNode, MacroControl, MacroDef, MacroPort } from '../../model/types';
import { handleId, parseHandleId } from './types';
import { applyInterfaceEdit } from './explicitControls';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

let seq = 0;
function freshId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Node types that can never cross a boundary: the macro's own interface, and
 *  the singleton event roots (a def has no business owning a Step / Behaviour
 *  Step, and the parent may already have one). */
export const MOVE_SCOPE_EXCLUDED_TYPES = new Set([
  'macroInput', 'macroOutput',
  'step', 'initEvent', 'gridInit', 'behaviourStep', 'divisionEvent', 'agentInit', 'experiment',
]);

/** The subset of `ids` that may actually cross a boundary, in `nodes` order. */
export function filterMovableIds(nodes: GraphNode[], ids: Iterable<string>): string[] {
  const want = new Set(ids);
  return nodes
    .filter(n => want.has(n.id) && !MOVE_SCOPE_EXCLUDED_TYPES.has(n.data?.nodeType))
    .map(n => n.id);
}

/**
 * How many instances of `defId` exist ANYWHERE in the model.
 *
 * ⚠ Deliberately NOT `macroImport.countMacroInstances`, which walks only
 * `graphNodes` + `macroDefs` — it predates the Agents and Overseer graphs. A
 * move-OUT is refused above 1, so an instance this missed would let the gesture
 * silently strip a computation out of a graph the user was not even looking at.
 */
export function countInstancesEverywhere(
  model: {
    graphNodes?: GraphNode[];
    agentGraphNodes?: GraphNode[];
    overseerGraphNodes?: GraphNode[];
    macroDefs?: MacroDef[];
  },
  defId: string,
): number {
  if (!defId) return 0;
  let n = 0;
  const visit = (nodes: GraphNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.data?.nodeType !== 'macro') continue;
      if ((node.data.config as Record<string, unknown> | undefined)?.macroDefId === defId) n++;
    }
  };
  visit(model.graphNodes);
  visit(model.agentGraphNodes);
  visit(model.overseerGraphNodes);
  for (const m of model.macroDefs ?? []) visit(m.nodes);
  return n;
}

/** Where a def's single instance lives, and the store to write back. */
export type InstanceLocation =
  | { store: 'cells' | 'agents' | 'overseer'; instanceId: string; nodes: GraphNode[]; edges: GraphEdge[] }
  | { store: 'macro'; defId: string; instanceId: string; nodes: GraphNode[]; edges: GraphEdge[] };

/**
 * Find the instance of `defId` and the graph that holds it.
 *
 * A move-OUT needs the instance node — to place the departing nodes and to
 * re-aim the outer wires — and `currentScope` cannot supply it: that stack is a
 * list of DEF ids, not instance node ids. It is uniquely findable precisely
 * because move-out is refused above one instance.
 */
export function locateMacroInstance(
  model: {
    graphNodes?: GraphNode[]; graphEdges?: GraphEdge[];
    agentGraphNodes?: GraphNode[]; agentGraphEdges?: GraphEdge[];
    overseerGraphNodes?: GraphNode[]; overseerGraphEdges?: GraphEdge[];
    macroDefs?: MacroDef[];
  },
  defId: string,
): InstanceLocation | null {
  const isInst = (n: GraphNode) =>
    n.data?.nodeType === 'macro'
    && (n.data.config as Record<string, unknown> | undefined)?.macroDefId === defId;
  const roots: Array<{ store: 'cells' | 'agents' | 'overseer'; nodes: GraphNode[]; edges: GraphEdge[] }> = [
    { store: 'cells', nodes: model.graphNodes ?? [], edges: model.graphEdges ?? [] },
    { store: 'agents', nodes: model.agentGraphNodes ?? [], edges: model.agentGraphEdges ?? [] },
    { store: 'overseer', nodes: model.overseerGraphNodes ?? [], edges: model.overseerGraphEdges ?? [] },
  ];
  for (const r of roots) {
    const hit = r.nodes.find(isInst);
    if (hit) return { store: r.store, instanceId: hit.id, nodes: r.nodes, edges: r.edges };
  }
  for (const m of model.macroDefs ?? []) {
    const hit = m.nodes.find(isInst);
    if (hit) return { store: 'macro', defId: m.id, instanceId: hit.id, nodes: m.nodes, edges: m.edges };
  }
  return null;
}

const portIdOf = (handle: string | undefined): string => parseHandleId(handle ?? '')?.portId ?? '';
const categoryOf = (handle: string | undefined): 'value' | 'flow' =>
  (parseHandleId(handle ?? '')?.category ?? 'value') as 'value' | 'flow';

/**
 * Next free `in_N` / `out_N`.
 *
 * ⚠ `used` is a set that only ever GROWS — it must carry every id the def EVER
 * had in this operation, including ones just removed. Recomputing the max over
 * the LIVE list would re-issue a removed port's id for a DIFFERENT port, and
 * the caller is at that moment about to prune wires model-wide BY that id.
 */
function nextPortId(used: Set<string>, prefix: 'in' | 'out'): string {
  let max = -1;
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  for (const id of used) {
    const m = id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const id = `${prefix}_${max + 1}`;
  used.add(id);
  return id;
}

/** Label a fresh port from its own id, so a removal can never make two ports
 *  share a label (they are user-renameable, but a duplicate reads as a bug). */
function portLabel(portId: string, prefix: 'in' | 'out'): string {
  const n = Number(portId.slice(prefix.length + 1));
  const word = prefix === 'in' ? 'Input' : 'Output';
  return Number.isFinite(n) ? `${word} ${n + 1}` : word;
}

/** Group a list by a key, preserving first-seen order (the 05a668a rule). */
function groupBy<T>(list: T[], key: (t: T) => string): Array<{ key: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const t of list) {
    const k = key(t);
    const cur = map.get(k);
    if (cur) cur.push(t);
    else map.set(k, [t]);
  }
  return [...map.entries()].map(([k, items]) => ({ key: k, items }));
}

/** The source-side key both directions group by. A NUL separator so a handle
 *  containing the separator can never merge two distinct sources. */
const srcKey = (e: GraphEdge): string => `${e.source} ${e.sourceHandle ?? ''}`;

// --- geometry ---------------------------------------------------------------

const GAP = 80;
interface Box { minX: number; minY: number; maxX: number; maxY: number }

function nodeBox(n: GraphNode): Box {
  const d = n.data as unknown as Record<string, unknown> | undefined;
  const w = typeof d?.width === 'number' ? (d.width as number) : 200;
  const h = typeof d?.height === 'number' ? (d.height as number) : (d?.isCollapsed ? 32 : 100);
  return { minX: n.position.x, minY: n.position.y, maxX: n.position.x + w, maxY: n.position.y + h };
}

function unionBox(nodes: GraphNode[]): Box | null {
  if (nodes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const b = nodeBox(n);
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

const overlaps = (a: Box, b: Box): boolean =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

/**
 * Translate `moving` by (dx, dy) — the scope's coordinate conversion — then, if
 * the landed cluster would sit on top of anything already there, drop it clear
 * BELOW the existing content. Deliberately simple and deterministic: the exact
 * landing spot is cosmetic, but landing ON the boundary nodes (move in) or ON
 * the instance node (move out) is not.
 */
function placeCluster(moving: GraphNode[], dx: number, dy: number, existing: GraphNode[]): GraphNode[] {
  const moved = moving.map(n => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
  const box = unionBox(moved);
  const host = unionBox(existing);
  if (!box || !host) return moved;
  const clash = moved.some(m => existing.some(e => overlaps(nodeBox(m), nodeBox(e))));
  if (!clash) return moved;
  const shift = host.maxY + GAP - box.minY;
  return moved.map(n => ({ ...n, position: { x: n.position.x, y: n.position.y + shift } }));
}

// --- boundary nodes ---------------------------------------------------------

function findBoundary(def: MacroDef, which: 'macroInput' | 'macroOutput'): GraphNode | undefined {
  return def.nodes.find(n => n.data?.nodeType === which);
}

/** A def imported without any port of one side may legitimately lack that
 *  boundary node. Mint one rather than refusing the move. */
function makeBoundary(def: MacroDef, which: 'macroInput' | 'macroOutput'): GraphNode {
  const box = unionBox(def.nodes);
  const x = box ? (which === 'macroInput' ? box.minX - 320 : box.maxX + 120) : 0;
  const y = box ? (box.minY + box.maxY) / 2 - 40 : 0;
  return {
    id: `${which === 'macroInput' ? 'mi' : 'mo'}_${freshId('b')}`,
    type: 'caNode',
    position: { x, y },
    data: { nodeType: which, config: { macroDefId: def.id } },
  };
}

// --- Explicit Controls ------------------------------------------------------

/**
 * Drop every control in `def` whose target names a DEPARTING node, through the
 * ONE authoring mutation builder so the CANONICAL ordering of `controls` /
 * `groups` is preserved (and an emptied array comes back `undefined`, restoring
 * the pristine record shape).
 *
 * Covers BOTH nodeId-bearing target kinds — `config` and `facet` — plus
 * `control` (a chained target names a nested macro INSTANCE node, which can
 * itself move). A chained target in an OUTER def that pointed at a control
 * removed here degrades to the documented `orphan-control` block, which the
 * instance already surfaces.
 */
export function stripControlsForNodes(def: MacroDef, departing: Set<string>): MacroDef {
  const doomed = (def.controls ?? []).filter((c: MacroControl) => departing.has(c.target.nodeId));
  if (doomed.length === 0) return def;
  let out = def;
  for (const c of doomed) out = { ...out, ...applyInterfaceEdit(out, { kind: 'control-remove', controlId: c.id }) };
  return out;
}

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface ScopeMoveInput {
  /** The macro definition the nodes move INTO (move in) or OUT OF (move out). */
  def: MacroDef;
  /** The graph that holds the macro INSTANCE. */
  parentNodes: GraphNode[];
  parentEdges: GraphEdge[];
  /** The `macro` node in the parent graph whose `macroDefId` is `def.id`. */
  instanceNodeId: string;
  /** The selection to move (already filtered, or filtered here defensively). */
  movingIds: string[];
}

export interface ScopeMoveOk {
  ok: true;
  def: MacroDef;
  parentNodes: GraphNode[];
  parentEdges: GraphEdge[];
  /** Ports that no longer exist — every OTHER instance's wires into them must
   *  be dropped model-wide by the caller. */
  removedInputPortIds: string[];
  removedOutputPortIds: string[];
  addedInputPortIds: string[];
  addedOutputPortIds: string[];
  /** Controls dropped because their target left the def. */
  removedControlIds: string[];
  movedIds: string[];
  notes: string[];
}
export type ScopeMoveResult = ScopeMoveOk | { ok: false; error: string };

// ---------------------------------------------------------------------------
// MOVE IN — parent graph → the dropped-on macro instance's definition
// ---------------------------------------------------------------------------

export function moveIntoMacro(input: ScopeMoveInput): ScopeMoveResult {
  const { parentNodes, parentEdges, instanceNodeId } = input;
  const instance = parentNodes.find(n => n.id === instanceNodeId);
  if (!instance) return { ok: false, error: 'The macro instance is no longer in this graph.' };
  if (instance.data?.nodeType !== 'macro') return { ok: false, error: 'Drop target is not a macro instance.' };

  const movingIds = filterMovableIds(parentNodes, input.movingIds).filter(id => id !== instanceNodeId);
  if (movingIds.length === 0) return { ok: false, error: 'Nothing in the selection can move into a macro.' };
  const moving = new Set(movingIds);
  const movingNodes = parentNodes.filter(n => moving.has(n.id));

  const notes: string[] = [];
  let def = input.def;
  let defNodes = [...def.nodes];
  const defEdges = [...def.edges];
  let exposedInputs = [...def.exposedInputs];
  let exposedOutputs = [...def.exposedOutputs];
  const usedIn = new Set(def.exposedInputs.map(p => p.portId));
  const usedOut = new Set(def.exposedOutputs.map(p => p.portId));
  const removedIn: string[] = [], removedOut: string[] = [], addedIn: string[] = [], addedOut: string[] = [];

  // Node-id collisions with the def are essentially impossible (ids are
  // timestamp+random) but cheap to make impossible: regenerate and remap every
  // edge endpoint that names the colliding node.
  const defIds = new Set(defNodes.map(n => n.id));
  const idMap = new Map<string, string>();
  for (const n of movingNodes) if (defIds.has(n.id)) idMap.set(n.id, freshId('n'));
  const mid = (id: string): string => idMap.get(id) ?? id;
  if (idMap.size > 0) notes.push(`${idMap.size} node id(s) regenerated to avoid a collision inside the macro.`);

  // --- classify every parent edge ------------------------------------------
  const keepParent: GraphEdge[] = [];
  const addParent: GraphEdge[] = [];
  const fedInstance: GraphEdge[] = [];   // movedNode -> instance.in_k
  const readInstance: GraphEdge[] = [];  // instance.out_k -> movedNode
  const needInput: GraphEdge[] = [];     // outerNode -> movedNode
  const needOutput: GraphEdge[] = [];    // movedNode -> outerNode

  for (const e of parentEdges) {
    const sIn = moving.has(e.source), tIn = moving.has(e.target);
    if (sIn && tIn) {
      defEdges.push({ id: freshId('e'), source: mid(e.source), sourceHandle: e.sourceHandle, target: mid(e.target), targetHandle: e.targetHandle });
      continue;
    }
    if (sIn && e.target === instanceNodeId) { fedInstance.push(e); continue; }
    if (tIn && e.source === instanceNodeId) { readInstance.push(e); continue; }
    if (tIn) { needInput.push(e); continue; }
    if (sIn) { needOutput.push(e); continue; }
    keepParent.push(e);
  }

  // --- a moved node FED one of the instance's input ports -------------------
  // Its bridges become direct internal edges; the port survives only if some
  // OUTER (non-moving) feeder still needs it — real for a FLOW input, never for
  // a value one.
  for (const g of groupBy(fedInstance, e => portIdOf(e.targetHandle))) {
    const port = exposedInputs.find(p => p.portId === g.key);
    if (!port) continue; // dangling wire into a port the def no longer has — drop it
    const bridgeHandle = handleId({ id: port.portId, kind: 'output', category: port.category });
    const bridges = defEdges.filter(b => b.source === port.internalNodeId && b.sourceHandle === bridgeHandle);
    for (const e of g.items) {
      for (const b of bridges) {
        defEdges.push({ id: freshId('e'), source: mid(e.source), sourceHandle: e.sourceHandle ?? '', target: b.target, targetHandle: b.targetHandle });
      }
    }
    const outerFeederRemains = keepParent.some(
      e => e.target === instanceNodeId && portIdOf(e.targetHandle) === g.key,
    );
    if (!outerFeederRemains) {
      exposedInputs = exposedInputs.filter(p => p.portId !== g.key);
      for (const b of bridges) {
        const i = defEdges.indexOf(b);
        if (i >= 0) defEdges.splice(i, 1);
      }
      removedIn.push(g.key);
    }
  }

  // --- a moved node CONSUMED one of the instance's output ports -------------
  for (const g of groupBy(readInstance, e => portIdOf(e.sourceHandle))) {
    const port = exposedOutputs.find(p => p.portId === g.key);
    if (!port) continue;
    const bridgeHandle = handleId({ id: port.portId, kind: 'input', category: port.category });
    const bridge = defEdges.find(b => b.target === port.internalNodeId && b.targetHandle === bridgeHandle);
    if (bridge) {
      for (const e of g.items) {
        defEdges.push({ id: freshId('e'), source: bridge.source, sourceHandle: bridge.sourceHandle, target: mid(e.target), targetHandle: e.targetHandle ?? '' });
      }
    }
    const outerConsumerRemains = keepParent.some(
      e => e.source === instanceNodeId && portIdOf(e.sourceHandle) === g.key,
    );
    if (!outerConsumerRemains) {
      exposedOutputs = exposedOutputs.filter(p => p.portId !== g.key);
      if (bridge) {
        const i = defEdges.indexOf(bridge);
        if (i >= 0) defEdges.splice(i, 1);
      }
      removedOut.push(g.key);
    }
  }

  // --- outer feeders of the moved nodes → macro INPUT ports -----------------
  // REUSE an input port this same outer (source, sourceHandle) already feeds:
  // the value is already crossing the boundary, so a second port carrying it
  // would be exactly the duplication 05a668a removed. Built AFTER the removals
  // above and from the SURVIVING parent edges, so it can never hand back a port
  // that just went (or one whose feeder just moved).
  const inputPortByOuter = new Map<string, MacroPort>();
  for (const e of keepParent) {
    if (e.target !== instanceNodeId) continue;
    const p = exposedInputs.find(pp => pp.portId === portIdOf(e.targetHandle));
    if (p && !inputPortByOuter.has(srcKey(e))) inputPortByOuter.set(srcKey(e), p);
  }
  let macroInputNode = findBoundary(def, 'macroInput');

  for (const g of groupBy(needInput, srcKey)) {
    const first = g.items[0]!;
    let port = inputPortByOuter.get(g.key);
    if (!port) {
      const category = categoryOf(first.targetHandle);
      if (!macroInputNode) {
        macroInputNode = makeBoundary(def, 'macroInput');
        defNodes = [...defNodes, macroInputNode];
        notes.push('Created a Macro Input boundary node (the macro had none).');
      }
      const portId = nextPortId(usedIn, 'in');
      port = {
        portId, label: portLabel(portId, 'in'), dataType: 'any', category,
        internalNodeId: macroInputNode.id, internalPortId: portId,
      };
      exposedInputs = [...exposedInputs, port];
      addedIn.push(portId);
      addParent.push({
        id: freshId('e'), source: first.source, sourceHandle: first.sourceHandle ?? '',
        target: instanceNodeId, targetHandle: handleId({ id: portId, kind: 'input', category }),
      });
      inputPortByOuter.set(g.key, port);
    }
    const bridgeHandle = handleId({ id: port.portId, kind: 'output', category: port.category });
    for (const e of g.items) {
      defEdges.push({ id: freshId('e'), source: port.internalNodeId, sourceHandle: bridgeHandle, target: mid(e.target), targetHandle: e.targetHandle ?? '' });
    }
  }

  // --- outer consumers of the moved nodes → macro OUTPUT ports --------------
  let macroOutputNode = findBoundary(def, 'macroOutput');
  for (const g of groupBy(needOutput, srcKey)) {
    const first = g.items[0]!;
    const category = categoryOf(first.sourceHandle);
    if (!macroOutputNode) {
      macroOutputNode = makeBoundary(def, 'macroOutput');
      defNodes = [...defNodes, macroOutputNode];
      notes.push('Created a Macro Output boundary node (the macro had none).');
    }
    const portId = nextPortId(usedOut, 'out');
    exposedOutputs = [...exposedOutputs, {
      portId, label: portLabel(portId, 'out'), dataType: 'any', category,
      internalNodeId: macroOutputNode.id, internalPortId: portId,
    }];
    addedOut.push(portId);
    defEdges.push({
      id: freshId('e'), source: mid(first.source), sourceHandle: first.sourceHandle ?? '',
      target: macroOutputNode.id, targetHandle: handleId({ id: portId, kind: 'input', category }),
    });
    for (const e of g.items) {
      addParent.push({
        id: freshId('e'), source: instanceNodeId, sourceHandle: handleId({ id: portId, kind: 'output', category }),
        target: e.target, targetHandle: e.targetHandle ?? '',
      });
    }
  }

  // --- place the moved nodes inside the def --------------------------------
  // Def-internal positions are RELATIVE to the instance (the invariant
  // `createMacroFromSelection` establishes and `undoMacro` inverts).
  const placed = placeCluster(
    movingNodes.map(n => ({ ...n, id: mid(n.id) })),
    -instance.position.x, -instance.position.y,
    defNodes,
  );
  defNodes = [...defNodes, ...placed];

  def = {
    ...def,
    nodes: defNodes,
    edges: defEdges,
    exposedInputs,
    exposedOutputs,
  };

  if (addedIn.length) notes.push(`${addedIn.length} macro input port(s) added.`);
  if (addedOut.length) notes.push(`${addedOut.length} macro output port(s) added.`);
  if (removedIn.length || removedOut.length) {
    notes.push(`${removedIn.length + removedOut.length} port(s) removed (their wires are now internal).`);
  }

  return {
    ok: true,
    def,
    parentNodes: parentNodes.filter(n => !moving.has(n.id)),
    parentEdges: [...keepParent, ...addParent],
    removedInputPortIds: removedIn,
    removedOutputPortIds: removedOut,
    addedInputPortIds: addedIn,
    addedOutputPortIds: addedOut,
    removedControlIds: [],
    movedIds: movingIds,
    notes,
  };
}

// ---------------------------------------------------------------------------
// MOVE OUT — the macro definition → the parent graph
// ---------------------------------------------------------------------------

export function moveOutOfMacro(input: ScopeMoveInput): ScopeMoveResult {
  const { parentNodes, parentEdges, instanceNodeId } = input;
  const instance = parentNodes.find(n => n.id === instanceNodeId);
  if (!instance) return { ok: false, error: 'The macro instance could not be found in the parent graph.' };

  const movingIds = filterMovableIds(input.def.nodes, input.movingIds);
  if (movingIds.length === 0) return { ok: false, error: 'Nothing in the selection can move out of a macro.' };
  const moving = new Set(movingIds);
  const movingNodes = input.def.nodes.filter(n => moving.has(n.id));

  const notes: string[] = [];
  let def = input.def;
  const macroInputId = findBoundary(def, 'macroInput')?.id ?? '';
  let macroOutputNode = findBoundary(def, 'macroOutput');
  let macroInputNode = findBoundary(def, 'macroInput');

  let defNodes = def.nodes.filter(n => !moving.has(n.id));
  const keepDefEdges: GraphEdge[] = [];
  const addDefEdges: GraphEdge[] = [];
  let exposedInputs = [...def.exposedInputs];
  let exposedOutputs = [...def.exposedOutputs];
  const usedIn = new Set(def.exposedInputs.map(p => p.portId));
  const usedOut = new Set(def.exposedOutputs.map(p => p.portId));
  const removedIn: string[] = [], removedOut: string[] = [], addedIn: string[] = [], addedOut: string[] = [];

  // Parent-side id collisions: the same defensive remap as move-in.
  const parentIds = new Set(parentNodes.map(n => n.id));
  const idMap = new Map<string, string>();
  for (const n of movingNodes) if (parentIds.has(n.id)) idMap.set(n.id, freshId('n'));
  const mid = (id: string): string => idMap.get(id) ?? id;
  if (idMap.size > 0) notes.push(`${idMap.size} node id(s) regenerated to avoid a collision in the parent graph.`);

  const addParent: GraphEdge[] = [];
  const dropParent = new Set<string>();

  const fromMacroInput: GraphEdge[] = [];  // MacroInput.in_k -> movedNode
  const fromStaying: GraphEdge[] = [];     // stayingNode    -> movedNode
  const toMacroOutput: GraphEdge[] = [];   // movedNode      -> MacroOutput.out_k
  const toStaying: GraphEdge[] = [];       // movedNode      -> stayingNode

  for (const e of def.edges) {
    const sIn = moving.has(e.source), tIn = moving.has(e.target);
    if (sIn && tIn) {
      addParent.push({ id: freshId('e'), source: mid(e.source), sourceHandle: e.sourceHandle, target: mid(e.target), targetHandle: e.targetHandle });
      continue;
    }
    if (tIn && e.source === macroInputId && macroInputId) { fromMacroInput.push(e); continue; }
    if (tIn) { fromStaying.push(e); continue; }
    if (sIn && macroOutputNode && e.target === macroOutputNode.id) { toMacroOutput.push(e); continue; }
    if (sIn) { toStaying.push(e); continue; }
    keepDefEdges.push(e);
  }

  // --- MacroInput.in_k -> movedNode ----------------------------------------
  // The moved node must now be fed from OUTSIDE directly. Keep the port only if
  // it still has another internal consumer.
  for (const g of groupBy(fromMacroInput, e => portIdOf(e.sourceHandle))) {
    const port = exposedInputs.find(p => p.portId === g.key);
    const feeders = parentEdges.filter(e => e.target === instanceNodeId && portIdOf(e.targetHandle) === g.key);
    for (const e of g.items) {
      for (const f of feeders) {
        addParent.push({ id: freshId('e'), source: f.source, sourceHandle: f.sourceHandle, target: mid(e.target), targetHandle: e.targetHandle });
      }
    }
    // Does the port still feed anything INSIDE? Every bridge out of it whose
    // target is NOT moving went to `keepDefEdges`, so that list is the test.
    const bridgeHandle = g.items[0]!.sourceHandle;
    const otherConsumer = keepDefEdges.some(b => b.source === macroInputId && b.sourceHandle === bridgeHandle);
    if (!otherConsumer && port) {
      exposedInputs = exposedInputs.filter(p => p.portId !== g.key);
      removedIn.push(g.key);
      for (const f of feeders) dropParent.add(f.id);
    }
  }

  // --- stayingNode -> movedNode  ⇒  a new (or reused) macro OUTPUT port -----
  const outputPortByInner = new Map<string, MacroPort>();
  for (const p of exposedOutputs) {
    const bridgeHandle = handleId({ id: p.portId, kind: 'input', category: p.category });
    const b = def.edges.find(be => be.target === p.internalNodeId && be.targetHandle === bridgeHandle);
    if (b && !moving.has(b.source)) outputPortByInner.set(srcKey(b), p);
  }
  for (const g of groupBy(fromStaying, srcKey)) {
    const first = g.items[0]!;
    let port = outputPortByInner.get(g.key);
    if (!port) {
      const category = categoryOf(first.sourceHandle);
      if (!macroOutputNode) {
        macroOutputNode = makeBoundary(def, 'macroOutput');
        defNodes = [...defNodes, macroOutputNode];
        notes.push('Created a Macro Output boundary node (the macro had none).');
      }
      const portId = nextPortId(usedOut, 'out');
      port = {
        portId, label: portLabel(portId, 'out'), dataType: 'any', category,
        internalNodeId: macroOutputNode.id, internalPortId: portId,
      };
      exposedOutputs = [...exposedOutputs, port];
      addedOut.push(portId);
      addDefEdges.push({
        id: freshId('e'), source: first.source, sourceHandle: first.sourceHandle,
        target: macroOutputNode.id, targetHandle: handleId({ id: portId, kind: 'input', category }),
      });
      outputPortByInner.set(g.key, port);
    }
    const outHandle = handleId({ id: port.portId, kind: 'output', category: port.category });
    for (const e of g.items) {
      addParent.push({ id: freshId('e'), source: instanceNodeId, sourceHandle: outHandle, target: mid(e.target), targetHandle: e.targetHandle });
    }
  }

  // --- movedNode -> MacroOutput.out_k --------------------------------------
  // A MacroOutput input port takes exactly ONE internal source, and it is
  // leaving: rewire every outer consumer to the moved node and drop the port.
  for (const g of groupBy(toMacroOutput, e => portIdOf(e.targetHandle))) {
    const first = g.items[0]!;
    const consumers = parentEdges.filter(e => e.source === instanceNodeId && portIdOf(e.sourceHandle) === g.key);
    for (const c of consumers) {
      addParent.push({ id: freshId('e'), source: mid(first.source), sourceHandle: first.sourceHandle, target: c.target, targetHandle: c.targetHandle });
      dropParent.add(c.id);
    }
    if (exposedOutputs.some(p => p.portId === g.key)) {
      exposedOutputs = exposedOutputs.filter(p => p.portId !== g.key);
      removedOut.push(g.key);
    }
  }

  // --- movedNode -> stayingNode  ⇒  a new macro INPUT port -----------------
  for (const g of groupBy(toStaying, srcKey)) {
    const first = g.items[0]!;
    const category = categoryOf(first.sourceHandle);
    if (!macroInputNode) {
      macroInputNode = makeBoundary(def, 'macroInput');
      defNodes = [...defNodes, macroInputNode];
      notes.push('Created a Macro Input boundary node (the macro had none).');
    }
    const portId = nextPortId(usedIn, 'in');
    exposedInputs = [...exposedInputs, {
      portId, label: portLabel(portId, 'in'), dataType: 'any', category,
      internalNodeId: macroInputNode.id, internalPortId: portId,
    }];
    addedIn.push(portId);
    const bridgeHandle = handleId({ id: portId, kind: 'output', category });
    for (const e of g.items) {
      addDefEdges.push({ id: freshId('e'), source: macroInputNode.id, sourceHandle: bridgeHandle, target: e.target, targetHandle: e.targetHandle });
    }
    addParent.push({
      id: freshId('e'), source: mid(first.source), sourceHandle: first.sourceHandle,
      target: instanceNodeId, targetHandle: handleId({ id: portId, kind: 'input', category }),
    });
  }

  // --- Explicit Controls: a control whose target left the def must go -------
  const beforeControls = new Set((def.controls ?? []).map(c => c.id));
  def = stripControlsForNodes(def, moving);
  const removedControlIds = [...beforeControls].filter(id => !(def.controls ?? []).some(c => c.id === id));
  if (removedControlIds.length) notes.push(`${removedControlIds.length} explicit control(s) removed (their target left the macro).`);

  // --- place the moved nodes in the parent graph ---------------------------
  const placed = placeCluster(
    movingNodes.map(n => ({ ...n, id: mid(n.id) })),
    instance.position.x, instance.position.y,
    parentNodes,
  );

  def = { ...def, nodes: defNodes, edges: [...keepDefEdges, ...addDefEdges], exposedInputs, exposedOutputs };

  if (addedIn.length) notes.push(`${addedIn.length} macro input port(s) added.`);
  if (addedOut.length) notes.push(`${addedOut.length} macro output port(s) added.`);
  if (removedIn.length || removedOut.length) {
    notes.push(`${removedIn.length + removedOut.length} port(s) removed (their wires are now direct).`);
  }

  return {
    ok: true,
    def,
    parentNodes: [...parentNodes, ...placed],
    parentEdges: [...parentEdges.filter(e => !dropParent.has(e.id)), ...addParent],
    removedInputPortIds: removedIn,
    removedOutputPortIds: removedOut,
    addedInputPortIds: addedIn,
    addedOutputPortIds: addedOut,
    removedControlIds,
    movedIds: movingIds,
    notes,
  };
}
