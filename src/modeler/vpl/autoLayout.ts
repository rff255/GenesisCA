/**
 * autoLayout.ts — the "Organize" auto-layout for the rule-graph canvas.
 *
 * Plan: `docs/PLAN_AUTO_ORGANIZE.md` (§4 is this file, assertion-by-assertion).
 *
 * DOM-free, React-free, dependency-free — exactly like `alignmentSnap.ts` and
 * `macroMoveScope.ts`. The editor (`GraphEditor.tsx`) builds the input from
 * `nodesRef.current` / `edgesRef.current` and writes the answer back in ONE
 * `setNodes`; nothing here knows about React Flow, and nothing here is compiled
 * (node POSITIONS are not an emitted surface, which is why
 * `check-compile-identity` must stay green across this whole feature).
 *
 * THE ONE IDEA. A GenesisCA rule graph has two edge kinds and they mean
 * different things, which is exactly what a generic layout library cannot
 * express:
 *
 *   - a **FLOW** edge is the execution spine. It is drawn left→right and it
 *     decides a node's COLUMN.
 *   - a **VALUE** edge is a parameter dependency. It must never push its
 *     consumer right; instead the producer is pulled LEFT of it (Blueprint
 *     Assist's `ParameterStyle=LeftSide`, which here is the only correct
 *     behaviour and therefore not offered as a choice).
 *
 * A wire's kind is readable straight off its handle id (`kind_category_portId`,
 * `types.ts handleId`), so no node lookup is needed to classify an edge.
 *
 * DETERMINISM IS A HARD REQUIREMENT (harness A6 / A7): every sort carries an
 * explicit final tie-break on the node id, no `Math.random`, no `Date.now` in
 * anything that reaches a coordinate, no reliance on `Map` iteration order for
 * anything but a lookup. Organize twice must be a no-op.
 *
 * Verified by `scripts/verify-auto-layout.mjs` (sections A / B / C + seven
 * negative controls by deliberate source mutation).
 */

import { parseHandleId } from './types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type LayoutStyle = 'tidy' | 'compact' | 'expanded';

/** `node` / `reroute` take part in the layout. `comment` / `group` are P3 — in
 *  P1/P2 they are translated by the anchor delta (honest, and never worse than
 *  leaving them where they were). */
export type LayoutKind = 'node' | 'reroute' | 'comment' | 'group';

export interface LayoutNodeIn {
  id: string;
  kind: LayoutKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** handleId → y offset from the node's TOP, for every port that carries an
   *  edge. Built by `portYOffsets` in `nodeGeometry.ts`, which mirrors CaNode's
   *  own handle placement from the SAME exported constants CaNode renders with. */
  portY: Readonly<Record<string, number>>;
  /** A declared `category: 'event'` type with no flow input — used only for root
   *  ORDERING, never for the root SET (which is structural: no incoming flow
   *  edge). A missing entry therefore costs an odd order, never correctness. */
  rootRank?: number;
}

export interface LayoutEdgeIn {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface LayoutOptions {
  style: LayoutStyle;
  gapX: number;
  gapY: number;
  /** 0 = no rounding (the canvas snap toggle is off). */
  grid: number;
  /** The result's bbox top-left is translated to land here — the ORIGINAL bbox
   *  top-left of the laid-out set, so the canvas does not jump and a `Ctrl+Z`
   *  lands on the same screen. `fitView` is deliberately never called. */
  anchor: { x: number; y: number };
  groupPad: number;
  commentPad: number;
}

export interface LayoutResult {
  /** id → new absolute position. Every input node is present (the harness
   *  asserts on the full set); the editor writes back only what it finds. */
  positions: Record<string, { x: number; y: number }>;
  /** P3: group / comment rects written back through `data.width/height`. Empty
   *  in P1/P2 — see the `// P3` seam in `placePassiveNodes`. */
  boxes: Record<string, { w: number; h: number }>;
  stats: { columns: number; crossings: number; backEdges: number; components: number; ms: number };
}

/** Padding per style. Compact mirrors Blueprint Assist's `Padding=(60,30)`;
 *  `gapY >= 30` is load-bearing — grid rounding moves a box by at most
 *  `grid/2` = 10 px, so two separated boxes stay separated and rounding can
 *  never create an overlap (§4.12). Tidy's numbers are MINIMA: it keeps the
 *  user's own column spacing wherever that is already roomier. */
export const STYLE_PADDING: Readonly<Record<LayoutStyle, { gapX: number; gapY: number }>> = {
  tidy: { gapX: 40, gapY: 30 },
  compact: { gapX: 60, gapY: 30 },
  expanded: { gapX: 120, gapY: 60 },
};

/** The vertical band a reroute may occupy on its wire, as a fraction of the
 *  segment — a dot pinned at an endpoint reads as a broken wire. */
const REROUTE_T_MIN = 0.15;
const REROUTE_T_MAX = 0.85;

/** Barycentre sweeps (down, up, down, up). Fixed count, no randomness. */
const SWEEPS = 4;
/** A FLOW edge counts this much more than a value wire in both the barycentre
 *  and the crossing cost: a flow chain should come out straight, a value wire
 *  may bend. Load-bearing — negative control 4 drops it. */
const FLOW_WEIGHT = 4;
/** Straightening iterations (left→right, then right→left). */
const STRAIGHTEN_PASSES = 2;

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

interface LEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  flow: boolean;
  /** Closes a cycle in the union graph — still drawn, never honoured. */
  back: boolean;
}

interface LNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  portY: Readonly<Record<string, number>>;
  rootRank: number;
  col: number;
  /** position within the column, after ordering */
  row: number;
  ny: number;
  nx: number;
}

const ROOT_RANK_LAST = 1e6;

function cmpStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function computeAutoLayout(
  nodes: readonly LayoutNodeIn[],
  edges: readonly LayoutEdgeIn[],
  opts: LayoutOptions,
): LayoutResult {
  const t0 = now();
  const positions: Record<string, { x: number; y: number }> = {};
  const boxes: Record<string, { w: number; h: number }> = {};

  // --- §4.1 partition -------------------------------------------------------
  const active = nodes.filter(n => n.kind === 'node' || n.kind === 'reroute');
  const passive = nodes.filter(n => n.kind === 'comment' || n.kind === 'group');
  const rerouteIds = new Set(active.filter(n => n.kind === 'reroute').map(n => n.id));
  const byId = new Map<string, LayoutNodeIn>(active.map(n => [n.id, n]));

  if (active.length === 0) {
    for (const p of passive) positions[p.id] = { x: p.x, y: p.y };
    return { positions, boxes, stats: { columns: 0, crossings: 0, backEdges: 0, components: 0, ms: now() - t0 } };
  }

  // --- §4.1 reroute transparency + §4.2 edge classification -----------------
  const rawEdges = edges
    .filter(e => byId.has(e.source) && byId.has(e.target))
    .slice()
    .sort((a, b) => cmpStr(a.id, b.id));
  const { logical, rerouteIn, rerouteOut } = resolveReroutes(rawEdges, rerouteIds);

  const lnodes = new Map<string, LNode>();
  for (const n of active) {
    if (rerouteIds.has(n.id)) continue;
    lnodes.set(n.id, {
      id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, portY: n.portY,
      rootRank: n.rootRank ?? ROOT_RANK_LAST,
      col: 0, row: 0, ny: n.y, nx: n.x,
    });
  }
  const ids = [...lnodes.keys()].sort(cmpStr);

  // --- §4.3 acyclicity (defensive) -----------------------------------------
  const backEdges = markBackEdges(ids, logical);

  // --- components (§4.12) ---------------------------------------------------
  // Tidy deliberately does NOT split into components: it keeps the user's own
  // arrangement, and stacking components would move nodes the user placed
  // beside each other. Compact / Expanded lay each component out on its own and
  // stack them vertically at the anchor x.
  const comps = opts.style === 'tidy'
    ? [ids]
    : connectedComponents(ids, logical);

  // Order: a component holding a declared event root first, then its previous
  // top edge, then its first id — fully deterministic.
  const compMeta = comps.map(cids => {
    let hasRoot = false;
    let minY = Infinity;
    for (const id of cids) {
      const n = lnodes.get(id)!;
      if (n.rootRank < ROOT_RANK_LAST) hasRoot = true;
      if (n.y < minY) minY = n.y;
    }
    return { cids, hasRoot, minY, key: cids[0] ?? '' };
  });
  compMeta.sort((a, b) =>
    (a.hasRoot === b.hasRoot ? 0 : a.hasRoot ? -1 : 1)
    || (a.minY - b.minY)
    || cmpStr(a.key, b.key));

  let stackY = 0;
  let totalColumns = 0;
  let totalCrossings = 0;
  for (const meta of compMeta) {
    const res = layoutOneComponent(meta.cids, lnodes, logical, opts);
    totalColumns = Math.max(totalColumns, res.columns);
    totalCrossings += res.crossings;
    // stack vertically at the anchor x, separated by 2 * gapY
    let top = Infinity;
    let bottom = -Infinity;
    for (const id of meta.cids) {
      const n = lnodes.get(id)!;
      if (n.ny < top) top = n.ny;
      if (n.ny + n.h > bottom) bottom = n.ny + n.h;
    }
    if (!Number.isFinite(top)) continue;
    const dy = stackY - top;
    for (const id of meta.cids) lnodes.get(id)!.ny += dy;
    stackY = (bottom + dy) + 2 * opts.gapY;
  }

  // --- §4.12 anchor, then grid ---------------------------------------------
  // ⚠ The bbox is over the laid-out NODES only — a reroute rides its wire and
  // its position is a lerp, not a grid coordinate, so letting one define the
  // anchor makes the second Organize round to a different origin and shift the
  // whole graph (A7). The editor must therefore measure `opts.anchor` the same
  // way: the bbox of the node boxes.
  let bx = Infinity;
  let by = Infinity;
  for (const n of lnodes.values()) { if (n.nx < bx) bx = n.nx; if (n.ny < by) by = n.ny; }
  if (!Number.isFinite(bx)) { bx = opts.anchor.x; by = opts.anchor.y; }

  const g = opts.grid > 0 ? opts.grid : 0;
  // The anchor itself is rounded first, and every coordinate is then rounded
  // RELATIVE to it. Two nodes whose pre-round y was equal therefore stay equal
  // (harness A5 asserts exact handle-y equality POST-grid), and every final
  // coordinate is still a grid multiple (A9) because the anchor is one.
  const ax = g ? Math.round(opts.anchor.x / g) * g : opts.anchor.x;
  const ay = g ? Math.round(opts.anchor.y / g) * g : opts.anchor.y;
  const snap = (v: number, a: number): number =>
    g ? a + Math.round((v - a) / g) * g : Math.round(v);

  for (const n of lnodes.values()) {
    positions[n.id] = { x: snap(n.nx - bx + ax, ax), y: snap(n.ny - by + ay, ay) };
  }
  // --- §4.9 reroutes: placed LAST, on the FINAL segment ---------------------
  // Two disciplines here, both learned from A7:
  //  · the endpoints are the FINAL (anchored + grid-rounded) node positions, not
  //    the internal pre-snap ones — otherwise the dot sits beside the wire it
  //    belongs to, by up to grid/2;
  //  · and the dot is NOT itself rounded. It belongs ON its wire, not on the
  //    canvas grid; rounding it moves it off the segment, and the next Organize
  //    re-projects the rounded point, gets a different `t`, and moves it again.
  //    Keeping the exact lerp makes `t` recover exactly on a second run. A9
  //    (grid) is therefore stated over the laid-out NODES.
  const reroutePos = placeReroutes(active, rerouteIds, rerouteIn, rerouteOut, lnodes, byId, positions);
  for (const [id, p] of reroutePos) positions[id] = p;

  // --- comments / groups: the anchor delta only (P3 does the real work) -----
  // ⚠ The delta is in INPUT space, not the internal one: it is
  // (final anchor) − (the laid-out set's ORIGINAL bbox top-left), so when the
  // editor passes that same bbox as `opts.anchor` — which it does — the delta is
  // zero and a comment simply stays put. Measuring it against the internal
  // `bx`/`by` (which start at 0 per component) translated every comment by the
  // whole anchor and broke idempotence: the harness's A7 caught it on 13 shipped
  // models before this feature ever reached the UI.
  let obx = Infinity, oby = Infinity;
  for (const n of active) {
    if (n.kind === 'reroute') continue;   // same reason as the bbox above
    if (n.x < obx) obx = n.x;
    if (n.y < oby) oby = n.y;
  }
  if (!Number.isFinite(obx)) { obx = opts.anchor.x; oby = opts.anchor.y; }
  placePassiveNodes(passive, positions, { x: ax - obx, y: ay - oby }, g, ax, ay);

  return {
    positions,
    boxes,
    stats: {
      columns: totalColumns,
      crossings: totalCrossings,
      backEdges,
      components: compMeta.length,
      ms: now() - t0,
    },
  };
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------
// §4.1 — reroute transparency
// ---------------------------------------------------------------------------

/** A reroute is TRANSPARENT to the layout: every edge whose source is a reroute
 *  is rewritten to the first non-reroute source upstream, and every edge INTO a
 *  reroute is dropped. Memoised + cycle-guarded, mirroring the compiler's
 *  `collapseReroutes`. */
function resolveReroutes(
  raw: readonly LayoutEdgeIn[],
  rerouteIds: ReadonlySet<string>,
): {
  logical: LEdge[];
  /** reroute id → its single inbound edge */
  rerouteIn: Map<string, LayoutEdgeIn>;
  /** reroute id → its outbound edges, in id order */
  rerouteOut: Map<string, LayoutEdgeIn[]>;
} {
  const rerouteIn = new Map<string, LayoutEdgeIn>();
  const rerouteOut = new Map<string, LayoutEdgeIn[]>();
  for (const e of raw) {
    if (rerouteIds.has(e.target) && !rerouteIn.has(e.target)) rerouteIn.set(e.target, e);
    if (rerouteIds.has(e.source)) {
      const list = rerouteOut.get(e.source);
      if (list) list.push(e); else rerouteOut.set(e.source, [e]);
    }
  }

  const memo = new Map<string, { source: string; sourceHandle: string } | null>();
  const resolveSource = (id: string, handle: string): { source: string; sourceHandle: string } | null => {
    if (!rerouteIds.has(id)) return { source: id, sourceHandle: handle };
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    memo.set(id, null); // cycle guard: a reroute loop resolves to nothing
    const inbound = rerouteIn.get(id);
    const out = inbound ? resolveSource(inbound.source, inbound.sourceHandle) : null;
    memo.set(id, out);
    return out;
  };

  const logical: LEdge[] = [];
  for (const e of raw) {
    if (rerouteIds.has(e.target)) continue;           // edges INTO a reroute: dropped
    const src = resolveSource(e.source, e.sourceHandle);
    if (!src) continue;
    const cat = parseHandleId(e.sourceHandle)?.category
      ?? parseHandleId(src.sourceHandle)?.category
      ?? 'value';
    logical.push({
      id: e.id,
      source: src.source,
      sourceHandle: src.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      // A reroute relays its source's category, so read the kind off the
      // RESOLVED source handle whenever the drawn one was a reroute relay.
      flow: (rerouteIds.has(e.source)
        ? parseHandleId(src.sourceHandle)?.category
        : cat) === 'flow',
      back: false,
    });
  }
  logical.sort((a, b) => cmpStr(a.id, b.id));
  return { logical, rerouteIn, rerouteOut };
}

// ---------------------------------------------------------------------------
// §4.3 — back edges
// ---------------------------------------------------------------------------

/** Iterative DFS over the UNION graph. Every edge that closes a cycle is marked
 *  `back` (drawn, but excluded from layering, ordering and straightening) and
 *  counted. On a graph built through the UI this is always 0 — `isValidConnection`
 *  runs a BFS cycle check — but a hand-edited `.gcaproj` can carry one and a
 *  naive longest-path recursion would hang the UI thread. */
function markBackEdges(ids: readonly string[], edges: LEdge[]): number {
  const out = new Map<string, LEdge[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) out.get(e.source)?.push(e);

  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(ids.map(id => [id, WHITE]));
  let count = 0;
  for (const root of ids) {
    if (colour.get(root) !== WHITE) continue;
    const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
    colour.set(root, GREY);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const adj = out.get(top.id)!;
      if (top.i >= adj.length) { colour.set(top.id, BLACK); stack.pop(); continue; }
      const e = adj[top.i++]!;
      const c = colour.get(e.target);
      if (c === GREY) { e.back = true; count++; continue; }
      if (c === BLACK) continue;
      colour.set(e.target, GREY);
      stack.push({ id: e.target, i: 0 });
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

function connectedComponents(ids: readonly string[], edges: readonly LEdge[]): string[][] {
  const parent = new Map<string, string>(ids.map(id => [id, id]));
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = a;
    while (parent.get(c) !== c) { const nx = parent.get(c)!; parent.set(c, r); c = nx; }
    return r;
  };
  for (const e of edges) {
    const ra = find(e.source), rb = find(e.target);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const g = groups.get(r);
    if (g) g.push(id); else groups.set(r, [id]);
  }
  return [...groups.values()].map(g => g.sort(cmpStr));
}

// ---------------------------------------------------------------------------
// One component
// ---------------------------------------------------------------------------

function layoutOneComponent(
  cids: readonly string[],
  lnodes: Map<string, LNode>,
  allEdges: readonly LEdge[],
  opts: LayoutOptions,
): { columns: number; crossings: number } {
  const inComp = new Set(cids);
  const edges = allEdges.filter(e => !e.back && inComp.has(e.source) && inComp.has(e.target));

  const inE = new Map<string, LEdge[]>();
  const outE = new Map<string, LEdge[]>();
  for (const id of cids) { inE.set(id, []); outE.set(id, []); }
  for (const e of edges) { inE.get(e.target)!.push(e); outE.get(e.source)!.push(e); }

  // --- §4.5 / §4.13 columns -------------------------------------------------
  const cols = opts.style === 'tidy'
    ? tidyColumns(cids, lnodes, edges, inE)
    : flowColumns(cids, lnodes, edges, inE, outE);
  for (const id of cids) lnodes.get(id)!.col = cols.get(id)!;

  const maxCol = Math.max(0, ...cids.map(id => lnodes.get(id)!.col));
  const columns: string[][] = Array.from({ length: maxCol + 1 }, () => []);
  for (const id of cids) columns[lnodes.get(id)!.col]!.push(id);

  // --- §4.6 ordering --------------------------------------------------------
  const crossings = orderColumns(columns, lnodes, inE, outE);
  for (const col of columns) col.forEach((id, i) => { lnodes.get(id)!.row = i; });

  // --- §4.7 coordinates -----------------------------------------------------
  assignCoordinates(columns, lnodes, inE, outE, opts);

  return { columns: columns.length, crossings };
}

/** §4.5 — PASS 1 flow-forward longest path, PASS 2 value nodes pulled LEFT, then
 *  a single topological repair sweep.
 *
 *  Pass 1 is a fixed point over the FLOW DAG only, so a value chain NEVER pushes
 *  an exec node right — the inverse of Blueprint Assist's
 *  `bExpandNodesAheadOfParameters`: the parameter chain grows leftward (into
 *  negative columns, normalised at the end) and the exec spine keeps the column
 *  it earned.
 *
 *  Pass 2 walks in REVERSE topological order so every consumer is already
 *  resolved (no recursion, so a 1000-deep value chain cannot blow the stack).
 *
 *  The repair sweep then restores `col(target) >= col(source) + 1` for EVERY
 *  non-back edge in one topological pass — this is what makes harness A2
 *  (flow points right) and A3 (producer left of consumer) hold by construction
 *  even for the cross-chain shapes pass 2 alone would break. It only ever
 *  raises a column, and never past the union longest path. */
function flowColumns(
  cids: readonly string[],
  lnodes: Map<string, LNode>,
  edges: readonly LEdge[],
  inE: Map<string, LEdge[]>,
  outE: Map<string, LEdge[]>,
): Map<string, number> {
  // §4.4 roots: no incoming FLOW edge. Ordering is rootRank, then previous y,
  // then id — the root SET is structural, the ORDER is the table.
  const topo = topoOrder(cids, edges, inE, lnodes);

  // PASS 1 — longest path over FLOW edges only.
  const flowCol = new Map<string, number>(cids.map(id => [id, 0]));
  for (const id of topo) {
    let c = 0;
    for (const e of inE.get(id)!) {
      if (!e.flow) continue;
      c = Math.max(c, flowCol.get(e.source)! + 1);
    }
    flowCol.set(id, c);
  }

  const valueOnly = new Set<string>();
  for (const id of cids) {
    const hasFlow = inE.get(id)!.some(e => e.flow) || outE.get(id)!.some(e => e.flow);
    if (!hasFlow) valueOnly.add(id);
  }

  // PASS 2 — a value node sits LEFT of its LEFTMOST consumer, so a shared
  // producer lands once, on the left, and fans out rightward.
  const col = new Map<string, number>(flowCol);
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i]!;
    if (!valueOnly.has(id)) continue;
    const consumers = outE.get(id)!;
    if (consumers.length === 0) continue;   // orphan: the repair sweep places it
    let m = Infinity;
    for (const e of consumers) m = Math.min(m, col.get(e.target)!);
    col.set(id, m - 1);
  }

  // REPAIR — one topological sweep restoring every non-back edge.
  for (const id of topo) {
    let c = col.get(id)!;
    for (const e of inE.get(id)!) c = Math.max(c, col.get(e.source)! + 1);
    col.set(id, c);
  }

  // normalise (columns may have gone negative)
  let min = Infinity;
  for (const c of col.values()) min = Math.min(min, c);
  if (!Number.isFinite(min)) min = 0;
  for (const id of cids) col.set(id, col.get(id)! - min);
  return col;
}

/** §4.13 — Tidy derives its columns from the CURRENT x: nodes whose x-intervals
 *  overlap by more than 50 % of the narrower node join one cluster, and clusters
 *  sort by mean x. This is the style for a graph the user has already arranged,
 *  so the answer is "align my columns, straighten my chains, remove my overlaps",
 *  not a re-layout.
 *
 *  ⚠ As-built deviation from the plan: the cluster index is then run through the
 *  SAME topological repair as §4.5. Without it a user arrangement in which two
 *  connected nodes share an x column (or a wire runs leftward) would come out
 *  violating A2 / A3, and the library sweep asserts those for ALL THREE styles.
 *  Repair only ever SPLITS a cluster along a directed path, so membership is
 *  preserved for every pair that has no path between them — which is what
 *  harness A13 states. */
function tidyColumns(
  cids: readonly string[],
  lnodes: Map<string, LNode>,
  edges: readonly LEdge[],
  inE: Map<string, LEdge[]>,
): Map<string, number> {
  const seed = clusterByX(cids, lnodes);
  const topo = topoOrder(cids, edges, inE, lnodes);
  const col = new Map<string, number>(seed);
  for (const id of topo) {
    let c = col.get(id)!;
    for (const e of inE.get(id)!) c = Math.max(c, col.get(e.source)! + 1);
    col.set(id, c);
  }
  let min = Infinity;
  for (const c of col.values()) min = Math.min(min, c);
  if (!Number.isFinite(min)) min = 0;
  for (const id of cids) col.set(id, col.get(id)! - min);
  return col;
}

/** The pure clustering half of Tidy, exported so the harness can state A13
 *  ("every pair that shared a column before shares one after") against the SAME
 *  predicate the layout uses rather than a re-implementation of it. */
export function clusterByX(
  cids: readonly string[],
  lnodes: ReadonlyMap<string, { x: number; w: number }>,
): Map<string, number> {
  const sorted = [...cids].sort((a, b) => {
    const A = lnodes.get(a)!, B = lnodes.get(b)!;
    return (A.x - B.x) || cmpStr(a, b);
  });
  const clusters: { lo: number; hi: number; members: string[] }[] = [];
  for (const id of sorted) {
    const n = lnodes.get(id)!;
    const lo = n.x, hi = n.x + n.w;
    let joined = false;
    for (const c of clusters) {
      const ov = Math.min(hi, c.hi) - Math.max(lo, c.lo);
      const narrower = Math.min(hi - lo, c.hi - c.lo);
      if (narrower > 0 && ov > 0.5 * narrower) {
        c.lo = Math.min(c.lo, lo); c.hi = Math.max(c.hi, hi); c.members.push(id);
        joined = true; break;
      }
    }
    if (!joined) clusters.push({ lo, hi, members: [id] });
  }
  const meanX = (c: { members: string[] }) =>
    c.members.reduce((s, m) => s + lnodes.get(m)!.x, 0) / c.members.length;
  clusters.sort((a, b) => (meanX(a) - meanX(b)) || cmpStr(a.members[0]!, b.members[0]!));
  const out = new Map<string, number>();
  clusters.forEach((c, i) => { for (const m of c.members) out.set(m, i); });
  return out;
}

/** Kahn topological order over the non-back edges. The ready queue is kept
 *  sorted by (rootRank, previous y, id) — §4.4's root ordering, applied at every
 *  level rather than only at the roots, so the whole order is deterministic. */
function topoOrder(
  cids: readonly string[],
  edges: readonly LEdge[],
  inE: Map<string, LEdge[]>,
  lnodes: Map<string, LNode>,
): string[] {
  const deg = new Map<string, number>(cids.map(id => [id, inE.get(id)!.length]));
  const rank = (id: string) => {
    const n = lnodes.get(id)!;
    return [n.rootRank, n.y, id] as const;
  };
  const cmp = (a: string, b: string) => {
    const A = rank(a), B = rank(b);
    return (A[0] - B[0]) || (A[1] - B[1]) || cmpStr(A[2], B[2]);
  };
  const ready = cids.filter(id => deg.get(id) === 0).sort(cmp);
  const out: string[] = [];
  const outE = new Map<string, LEdge[]>();
  for (const id of cids) outE.set(id, []);
  for (const e of edges) outE.get(e.source)!.push(e);
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    let added = false;
    for (const e of outE.get(id)!) {
      const d = deg.get(e.target)! - 1;
      deg.set(e.target, d);
      if (d === 0) { ready.push(e.target); added = true; }
    }
    if (added) ready.sort(cmp);
  }
  // A residual cycle (only reachable if markBackEdges missed one) appends in id
  // order rather than hanging.
  if (out.length < cids.length) {
    const seen = new Set(out);
    for (const id of [...cids].sort(cmpStr)) if (!seen.has(id)) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// §4.6 — ordering within a column
// ---------------------------------------------------------------------------

function orderColumns(
  columns: string[][],
  lnodes: Map<string, LNode>,
  inE: Map<string, LEdge[]>,
  outE: Map<string, LEdge[]>,
): number {
  // Seed: previous y ascending, ties by id.
  for (const col of columns) {
    col.sort((a, b) => {
      const A = lnodes.get(a)!, B = lnodes.get(b)!;
      return (A.y - B.y) || cmpStr(a, b);
    });
  }
  const posOf = () => {
    const p = new Map<string, number>();
    for (const col of columns) col.forEach((id, i) => p.set(id, i));
    return p;
  };
  const cost = (weighted: boolean) => crossingCost(columns, lnodes, outE, weighted);

  let best = columns.map(c => c.slice());
  let bestW = cost(true);
  const seedU = cost(false);

  for (let s = 0; s < SWEEPS; s++) {
    const down = s % 2 === 0;
    const pos = posOf();
    const range = down
      ? columns.map((_, i) => i)
      : columns.map((_, i) => columns.length - 1 - i);
    for (const ci of range) {
      const col = columns[ci]!;
      const bary = new Map<string, number>();
      col.forEach((id, i) => {
        const edgesHere = down ? inE.get(id)! : outE.get(id)!;
        let num = 0, den = 0;
        for (const e of edgesHere) {
          if (e.back) continue;
          const other = down ? e.source : e.target;
          const op = pos.get(other);
          if (op === undefined) continue;
          const w = e.flow ? FLOW_WEIGHT : 1;
          num += w * op; den += w;
        }
        bary.set(id, den > 0 ? num / den : i);
      });
      // Stable sort: equal barycentres keep the previous order.
      const idxOf = new Map<string, number>(col.map((id, i) => [id, i]));
      col.sort((a, b) => (bary.get(a)! - bary.get(b)!) || (idxOf.get(a)! - idxOf.get(b)!));
      col.forEach((id, i) => pos.set(id, i));
    }
    const w = cost(true);
    const u = cost(false);
    // Accept only a strict weighted improvement that also does not increase the
    // plain crossing count vs the SEED — harness A4 states both halves.
    if (w < bestW && u <= seedU) { bestW = w; best = columns.map(c => c.slice()); }
  }
  for (let i = 0; i < columns.length; i++) columns[i] = best[i]!;
  return crossingCost(columns, lnodes, outE, false);
}

/** Crossing count over every adjacent column pair, by the standard
 *  sorted-inversions accumulator (a Fenwick tree) — O(E log V) per pair.
 *  `weighted` multiplies each crossing by the product of the two edges' flow
 *  weights, so a flow/flow crossing costs 16 and a value/value one 1. */
function crossingCost(
  columns: readonly string[][],
  lnodes: Map<string, LNode>,
  outE: Map<string, LEdge[]>,
  weighted: boolean,
): number {
  const pos = new Map<string, number>();
  for (const col of columns) col.forEach((id, i) => pos.set(id, i));
  let total = 0;
  for (let c = 0; c + 1 < columns.length; c++) {
    const pairs: { s: number; t: number; w: number }[] = [];
    for (const id of columns[c]!) {
      for (const e of outE.get(id)!) {
        if (e.back) continue;
        const tn = lnodes.get(e.target);
        if (!tn || tn.col !== c + 1) continue;
        pairs.push({ s: pos.get(id)!, t: pos.get(e.target)!, w: weighted ? (e.flow ? FLOW_WEIGHT : 1) : 1 });
      }
    }
    if (pairs.length < 2) continue;
    pairs.sort((a, b) => (a.s - b.s) || (a.t - b.t));
    const size = columns[c + 1]!.length;
    const bit = new Float64Array(size + 2);
    const add = (i: number, v: number) => { for (let k = i + 1; k <= size; k += k & -k) bit[k] = bit[k]! + v; };
    const sum = (i: number) => { let r = 0; for (let k = i + 1; k > 0; k -= k & -k) r += bit[k]!; return r; };
    let inserted = 0;
    for (const p of pairs) {
      // edges already inserted whose target sits strictly BELOW this one cross it
      const below = inserted - sum(p.t);
      total += below * p.w;
      add(p.t, p.w);
      inserted += p.w;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// §4.7 / §4.8 — coordinates, straightening, separation
// ---------------------------------------------------------------------------

function assignCoordinates(
  columns: readonly string[][],
  lnodes: Map<string, LNode>,
  inE: Map<string, LEdge[]>,
  outE: Map<string, LEdge[]>,
  opts: LayoutOptions,
): void {
  const tidy = opts.style === 'tidy';
  const meanX = (col: readonly string[]) =>
    col.length ? col.reduce((s, id) => s + lnodes.get(id)!.x, 0) / col.length : 0;
  // x: a column starts past the widest node of the previous one. Tidy keeps the
  // user's own spacing wherever it is already roomier than that minimum.
  //
  // ⚠ Tidy SEEDS the chain with the first column's own mean, not with 0. The x
  // chain is then TRANSLATION-EQUIVARIANT — shift every input x by d and every
  // output shifts by d — which is what makes Organize-twice a no-op once the
  // anchor pass has re-translated the result. Seeding at 0 made `max(minimum,
  // mean)` pick a different arm on the second run and drifted whole columns by a
  // gap (caught by A7 on Kelp War and Chromatography).
  let x = tidy ? meanX(columns[0] ?? []) : 0;
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c]!;
    if (c > 0) {
      const prev = columns[c - 1]!;
      const prevW = Math.max(0, ...prev.map(id => lnodes.get(id)!.w));
      x = x + prevW + opts.gapX;
    }
    const colX = tidy && col.length > 0 ? Math.max(x, meanX(col)) : x;
    x = colX;
    for (const id of col) lnodes.get(id)!.nx = colX;
  }

  // y: stack in the order §4.6 settled on.
  for (const col of columns) {
    let y = 0;
    for (const id of col) {
      const n = lnodes.get(id)!;
      n.ny = y;
      y += n.h + opts.gapY;
    }
  }

  // Straightening — the quality step. Two iterations, left→right then
  // right→left. A node with a flow predecessor wants its mainFlowIn HANDLE on
  // the same absolute y as the predecessor's taken flow-out handle; a pure value
  // node wants the mean of its consumers' input-handle y.
  const g = opts.grid > 0 ? opts.grid : 0;
  // Placement priority: a node ON the exec spine outranks every parameter beside
  // it, then degree breaks the rest. See `placeColumn`.
  const priority = new Map<string, number>();
  for (const col of columns) {
    for (const id of col) {
      const ins = inE.get(id)!, outs = outE.get(id)!;
      const onSpine = ins.some(e => !e.back && e.flow) || outs.some(e => !e.back && e.flow);
      priority.set(id, (onSpine ? 1000 : 0) + ins.length + outs.length);
    }
  }
  for (let pass = 0; pass < STRAIGHTEN_PASSES; pass++) {
    const forward = pass % 2 === 0;
    const order = forward
      ? columns.map((_, i) => i)
      : columns.map((_, i) => columns.length - 1 - i);
    for (const ci of order) {
      const col = columns[ci]!;
      const desired = new Map<string, number>();
      for (const id of col) {
        const n = lnodes.get(id)!;
        const d = forward
          ? desiredFromPredecessors(n, inE.get(id)!, lnodes)
          : desiredFromConsumers(n, outE.get(id)!, lnodes);
        if (d === null) continue;
        // Band y is quantised BEFORE assignment so a whole chain rounds
        // identically and stays aligned after the final grid pass (§4.12).
        desired.set(id, g ? Math.round(d / g) * g : Math.round(d));
      }
      placeColumn(col, lnodes, desired, opts.gapY, priority);
    }
  }

  // §4.8 — the defensive collision sweep. Column x-spacing makes cross-column
  // overlap impossible; this restores the within-column minimum unconditionally,
  // and it is what the harness's "no two boxes overlap" assertion leans on.
  for (const col of columns) {
    const sorted = col.slice().sort((a, b) => {
      const A = lnodes.get(a)!, B = lnodes.get(b)!;
      return (A.ny - B.ny) || (A.row - B.row);
    });
    const ys = sorted.map(id => lnodes.get(id)!.ny);
    separateDown(ys, sorted.map(id => lnodes.get(id)!.h), opts.gapY);
    sorted.forEach((id, i) => { lnodes.get(id)!.ny = ys[i]!; });
  }
}

/** THE ONE minimum-separation rule, shared by the straightening pass and the
 *  §4.8 defensive sweep: walking down a column in ORDER, push each box to at
 *  least `gapY` below the previous one. Order-preserving by construction — the
 *  ordering is §4.6's answer and no separation pass may revisit it.
 *
 *  It is a SAFETY NET, not the primary mechanism: `placeColumn`'s priority clamp
 *  already reserves room for every node in the column, so on a correct run this
 *  never fires. Negative control 1 therefore empties BOTH, and harness A1 fails. */
function separateDown(ys: number[], hs: readonly number[], gapY: number): void {
  for (let i = 1; i < ys.length; i++) {
    const min = ys[i - 1]! + hs[i - 1]! + gapY;
    if (ys[i]! < min) ys[i] = min;
  }
}

/** The y that puts this node's flow INPUT handle level with its predecessor's
 *  taken flow OUTPUT handle. Null when there is no flow predecessor or the
 *  handle offsets are unknown. */
function desiredFromPredecessors(n: LNode, ins: readonly LEdge[], lnodes: Map<string, LNode>): number | null {
  const flowIns = ins.filter(e => !e.back && e.flow && lnodes.has(e.source));
  if (flowIns.length > 0) {
    // the CLOSEST predecessor (rightmost column), tie-broken by edge id
    flowIns.sort((a, b) => (lnodes.get(b.source)!.col - lnodes.get(a.source)!.col) || cmpStr(a.id, b.id));
    const e = flowIns[0]!;
    const p = lnodes.get(e.source)!;
    const po = p.portY[e.sourceHandle];
    const no = n.portY[e.targetHandle];
    if (po === undefined || no === undefined) return null;
    return p.ny + po - no;
  }
  const valueIns = ins.filter(e => !e.back && lnodes.has(e.source));
  if (valueIns.length === 0) return null;
  let sum = 0, cnt = 0;
  for (const e of valueIns) {
    const p = lnodes.get(e.source)!;
    const po = p.portY[e.sourceHandle];
    const no = n.portY[e.targetHandle];
    if (po === undefined || no === undefined) continue;
    sum += p.ny + po - no; cnt++;
  }
  return cnt > 0 ? sum / cnt : null;
}

/** The y that puts this node's OUTPUT handle at the mean of its consumers'
 *  input-handle y — the rule for a pure value node, which has no predecessor to
 *  line up with. */
function desiredFromConsumers(n: LNode, outs: readonly LEdge[], lnodes: Map<string, LNode>): number | null {
  const live = outs.filter(e => !e.back && lnodes.has(e.target));
  if (live.length === 0) return null;
  let sum = 0, cnt = 0;
  for (const e of live) {
    const t = lnodes.get(e.target)!;
    const to = t.portY[e.targetHandle];
    const no = n.portY[e.sourceHandle];
    if (to === undefined || no === undefined) continue;
    sum += t.ny + to - no; cnt++;
  }
  return cnt > 0 ? sum / cnt : null;
}

/** THE PRIORITY METHOD (§4.7). Nodes are placed at their desired y in DESCENDING
 *  priority — a flow-chain member first, then by degree — and each one is
 *  clamped into the slot left by the higher-priority nodes already placed above
 *  and below it, with exactly enough room reserved for the ones in between. So a
 *  node ON the exec spine gets the row that straightens its wire and a value
 *  node beside it yields, instead of the value node winning simply because the
 *  user had once parked it higher.
 *
 *  The ORDER is §4.6's answer and this pass never revisits it: a node is only
 *  ever moved WITHIN the slot its neighbours leave, so the column's sequence —
 *  and therefore the crossing count §4.6 minimised — is preserved. The trailing
 *  `separateDown` is a safety net; the clamping already guarantees feasibility.
 *
 *  Without the priority the flow chain bends the moment any value node shares
 *  its column (harness A4b). */
function placeColumn(
  col: readonly string[],
  lnodes: Map<string, LNode>,
  desired: ReadonlyMap<string, number>,
  gapY: number,
  priority: ReadonlyMap<string, number>,
): void {
  const n = col.length;
  if (n === 0) return;
  const h = col.map(id => lnodes.get(id)!.h);
  const y = col.map(id => lnodes.get(id)!.ny);
  const want = col.map(id => desired.get(id));

  const order = col.map((_, i) => i).sort((a, b) =>
    ((priority.get(col[b]!) ?? 0) - (priority.get(col[a]!) ?? 0)) || (a - b));
  const placed: boolean[] = new Array(n).fill(false);
  // prefix[i] = Σ (h[k] + gapY) for k < i, so the room the nodes between two
  // indices need is one subtraction rather than a loop
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + h[i]! + gapY;

  for (const i of order) {
    // the room the already-placed neighbours leave, with the intervening nodes
    // reserved for
    let lo = -Infinity;
    for (let j = i - 1; j >= 0; j--) {
      if (!placed[j]) continue;
      lo = y[j]! + (prefix[i]! - prefix[j]!);
      break;
    }
    let hi = Infinity;
    for (let j = i + 1; j < n; j++) {
      if (!placed[j]) continue;
      hi = y[j]! - (prefix[j]! - prefix[i]!);
      break;
    }
    let v = want[i] ?? y[i]!;
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    y[i] = v;
    placed[i] = true;
  }
  separateDown(y, h, gapY);
  for (let k = 0; k < n; k++) lnodes.get(col[k]!)!.ny = y[k]!;
}

// ---------------------------------------------------------------------------
// §4.9 — reroutes
// ---------------------------------------------------------------------------

/** Each reroute is placed on the straight segment between its RESOLVED source
 *  handle and its first consumer's target handle, at the parameter `t` it
 *  occupied on the OLD segment (its old centre projected onto the old line),
 *  clamped to [0.15, 0.85]; degenerate old geometry ⇒ 0.5. This preserves a
 *  deliberate bend without spending a whole column on a 16 px dot — reroutes
 *  never take part in the columns at all. */
function placeReroutes(
  active: readonly LayoutNodeIn[],
  rerouteIds: ReadonlySet<string>,
  rerouteIn: ReadonlyMap<string, LayoutEdgeIn>,
  rerouteOut: ReadonlyMap<string, LayoutEdgeIn[]>,
  lnodes: Map<string, LNode>,
  byId: ReadonlyMap<string, LayoutNodeIn>,
  finalPos: Readonly<Record<string, { x: number; y: number }>>,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();

  /** Walk UP through reroutes to the first real source + its handle. */
  const realSource = (id: string, handle: string, seen: Set<string>): { id: string; handle: string } | null => {
    if (!rerouteIds.has(id)) return { id, handle };
    if (seen.has(id)) return null;
    seen.add(id);
    const e = rerouteIn.get(id);
    return e ? realSource(e.source, e.sourceHandle, seen) : null;
  };
  /** Walk DOWN through reroutes to the first real consumer + its handle. */
  const realTarget = (id: string, handle: string, seen: Set<string>): { id: string; handle: string } | null => {
    if (!rerouteIds.has(id)) return { id, handle };
    if (seen.has(id)) return null;
    seen.add(id);
    const outs = rerouteOut.get(id);
    if (!outs || outs.length === 0) return null;
    const e = outs.slice().sort((a, b) => cmpStr(a.id, b.id))[0]!;
    return realTarget(e.target, e.targetHandle, seen);
  };

  for (const r of active) {
    if (!rerouteIds.has(r.id)) continue;
    const inbound = rerouteIn.get(r.id);
    const outs = rerouteOut.get(r.id);
    const src = inbound ? realSource(inbound.source, inbound.sourceHandle, new Set()) : null;
    const firstOut = outs && outs.length
      ? outs.slice().sort((a, b) => cmpStr(a.id, b.id))[0]!
      : null;
    const tgt = firstOut ? realTarget(firstOut.target, firstOut.targetHandle, new Set()) : null;

    const sN = src ? lnodes.get(src.id) : undefined;
    const tN = tgt ? lnodes.get(tgt.id) : undefined;
    if (!sN || !tN || !src || !tgt) {
      // Stranded (no endpoint left in the laid-out set): leave it where it was.
      out.set(r.id, { x: r.x, y: r.y });
      continue;
    }
    const sOldRaw = byId.get(src.id)!;
    const tOldRaw = byId.get(tgt.id)!;
    const sOff = sN.portY[src.handle] ?? sOldRaw.h / 2;
    const tOff = tN.portY[tgt.handle] ?? tOldRaw.h / 2;

    const oldA = { x: sOldRaw.x + sOldRaw.w, y: sOldRaw.y + sOff };
    const oldB = { x: tOldRaw.x, y: tOldRaw.y + tOff };
    // `t` is QUANTISED to 1/1000 and the placement rounded to 1/100 px. Both are
    // idempotence plumbing, not cosmetics: a second Organize re-projects the dot
    // it just placed, and with raw floats the round trip came back a few ULPs
    // off — enough for A7's byte-identity to fail on four shipped models. With
    // the quantisation the recovered `t` lands back on exactly the same step.
    const tRaw = clamp(projectT(oldA, oldB, { x: r.x + r.w / 2, y: r.y + r.h / 2 }), REROUTE_T_MIN, REROUTE_T_MAX);
    const t = Math.round(tRaw * 1000) / 1000;

    const sFinal = finalPos[src.id]!;
    const tFinal = finalPos[tgt.id]!;
    const A = { x: sFinal.x + sN.w, y: sFinal.y + sOff };
    const B = { x: tFinal.x, y: tFinal.y + tOff };
    const q = (v: number) => Math.round(v * 100) / 100;
    out.set(r.id, {
      x: q(A.x + (B.x - A.x) * t - r.w / 2),
      y: q(A.y + (B.y - A.y) * t - r.h / 2),
    });
  }
  return out;
}

function projectT(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0.5;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}
function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0.5;
}

// ---------------------------------------------------------------------------
// Comments + groups — the P3 seam
// ---------------------------------------------------------------------------

/** P1/P2: a comment or a group is translated by the anchor delta and nothing
 *  else — it keeps its relation to the canvas, and since the editor passes the
 *  laid-out set's own bbox top-left as the anchor, that delta is normally zero.
 *
 *  // P3 — this is where G1 lands: a group contracts to an opaque SUPER-NODE
 *  // (its members laid out by a recursive call and translated with it, its rect
 *  // re-fitted around exactly them via `boxes`), and a comment is translated
 *  // and re-wrapped around the NEW positions of whatever it used to contain.
 *  // Both need the containment predicate extracted out of `onNodeDragStart`
 *  // into ONE shared helper, and harness assertions A14 / A15. */
function placePassiveNodes(
  passive: readonly LayoutNodeIn[],
  positions: Record<string, { x: number; y: number }>,
  delta: { x: number; y: number },
  grid: number,
  ax: number,
  ay: number,
): void {
  for (const p of passive) {
    const x = p.x + delta.x;
    const y = p.y + delta.y;
    positions[p.id] = grid
      ? { x: ax + Math.round((x - ax) / grid) * grid, y: ay + Math.round((y - ay) / grid) * grid }
      : { x: Math.round(x), y: Math.round(y) };
  }
}
