// HOVER HIGHLIGHT — the pure half of the graph-canvas hover gesture.
// Plan: docs/PLAN_HOVER_HIGHLIGHT.md (P1 = its §7 P1 row).
//
// WHAT THIS IS
//   Hovering a node on the graph canvas lights the node itself and — depending on
//   which THIRD of the node's screen box the cursor is in — the wires INTO it and
//   their real producers (left), or the wires OUT of it and their real consumers
//   (right). Reroute dots are transparent relays: every SEGMENT of a chain and
//   every dot on it lights, and the peer is the first non-reroute at the far end.
//
// WHY IT IS A SEPARATE, DOM-FREE MODULE
//   Exactly the `autoLayout.ts` / `traceGraphMap.ts` discipline: the decidable
//   part (which ids light, which zone a ratio means, what colour a raw node fill
//   glows in) is pure, deterministic and harnessed by
//   `scripts/verify-hover-highlight.mjs`; the editor owns only the DOM writes and
//   the gesture. Nothing here imports React, React Flow or `document`.
//
// THE MECHANISM THE EDITOR USES (documented here because this module's output
// shape is designed for it): the marks are written as a `data-hover` ATTRIBUTE
// plus an inline `--hover-c` custom property straight onto
// `.react-flow__node[data-id]` / `.react-flow__edge[data-id]`. NEVER a class —
// React Flow rebuilds `className` on every render and would wipe it — and never
// React state: a mouse moves 60–120x/s and `setNodes` would re-render the whole
// node layer that often. See `GraphEditor.tsx` § HOVER HIGHLIGHT and
// `GraphEditor.module.css` § HOVER HIGHLIGHT.

// ---------------------------------------------------------------------------
// Constants (one definition each — the harness pins these values)
// ---------------------------------------------------------------------------

/** How long the cursor must rest on a node before its NEIGHBOURHOOD lights.
 *  The node's own ring is immediate; crossing a dense graph on the way
 *  somewhere else must not strobe every wire the cursor passes. Once lit,
 *  switching thirds is instant (the dwell is per-gesture, not per-zone). */
export const HOVER_DWELL_MS = 90;

/** The zone edges, with HYSTERESIS so a cursor resting on a boundary cannot
 *  flap: enter LEFT below .30 and leave it above .36; enter RIGHT above .70 and
 *  leave it below .64. */
export const HOVER_ENTER_LEFT = 0.30;
export const HOVER_LEAVE_LEFT = 0.36;
export const HOVER_ENTER_RIGHT = 0.70;
export const HOVER_LEAVE_RIGHT = 0.64;

/** Target HSL lightness for a node's own glow, and for a WIRE's (a wire is a
 *  2 px stroke against the canvas, so it is lifted further than a node's ring,
 *  which sits against the node's own header). See `hoverGlowColor`. */
export const HOVER_GLOW_L = 0.62;
export const HOVER_WIRE_GLOW_L = 0.72;

/** The wire colours `toRFEdges` puts in the INLINE style of every edge path
 *  (`GraphEditor.tsx`). Mirrored here — and pinned against that source by the
 *  harness — because a hovered wire glows in its OWN category colour
 *  (user decision D1), which means this module has to know what that is. */
export const EDGE_FLOW_COLOR = '#66bb6a';
export const EDGE_VALUE_COLOR = '#4cc9f0';

/** The fallback glow for anything whose colour cannot be resolved (a node type
 *  that is not in the registry). Deliberately the same neutral
 *  `borderColorFor()` uses for light fills. */
export const HOVER_FALLBACK_COLOR = '#b0b8c0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HoverZone = 'self' | 'in' | 'out' | 'both';
export type HoverNodeMark = 'self' | 'peer' | 'relay';
export type HoverEdgeMark = 'in' | 'out';
export type HoverNodeKind = 'node' | 'reroute' | 'other';
export type HoverWireCategory = 'flow' | 'value';

/** The hover gesture's subject. The union is deliberately open at the seams P2
 *  needs — a `port` target narrows the set to ONE handle's wires (I1) and an
 *  `edge` target lights a wire plus both its real endpoints (I2) — so adding
 *  them does not reshape anything here. P1 answers only `node`. */
export type HoverTarget =
  | { kind: 'node'; id: string; zone: HoverZone }
  | { kind: 'port'; nodeId: string; handleId: string }
  | { kind: 'edge'; id: string };

/** The editor-node shape this module needs. A React Flow `Node` satisfies it
 *  structurally, and so does a raw `.gcaproj` graph node (which is what the
 *  harness sweeps), so neither side has to adapt. */
export interface HoverEditorNode {
  id: string;
  type?: string | undefined;
  data?: unknown;
}

export interface HoverEditorEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
}

/** One editor wire, with its category already decided. */
export interface HoverWire {
  id: string;
  source: string;
  target: string;
  category: HoverWireCategory;
}

export interface HoverIndex {
  /** Editor-only relay dots. Transparent to the gesture: the chain is walked
   *  THROUGH them, and each one is marked `relay`. */
  reroutes: Set<string>;
  /** Every node id in the scope → what kind of thing it is. `other` (groups,
   *  comments) is what makes them "skipped by node type" rather than by a
   *  special case at every call site. */
  kindOf: Map<string, HoverNodeKind>;
  /** node id → the wires whose TARGET is that node. */
  inByNode: Map<string, HoverWire[]>;
  /** node id → the wires whose SOURCE is that node. */
  outByNode: Map<string, HoverWire[]>;
  wireById: Map<string, HoverWire>;
}

export interface HoverMarks {
  nodes: Map<string, HoverNodeMark>;
  edges: Map<string, HoverEdgeMark>;
  /** The hovered element — the editor looks its colour up once from this. */
  originId: string;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

function isRerouteNode(n: HoverEditorNode): boolean {
  if (n.type === 'rerouteNode') return true;
  const d = n.data as { nodeType?: unknown } | undefined;
  return d?.nodeType === 'reroute';
}

export function hoverNodeKind(n: HoverEditorNode): HoverNodeKind {
  if (isRerouteNode(n)) return 'reroute';
  if (n.type === 'groupNode' || n.type === 'commentNode') return 'other';
  const d = n.data as { nodeType?: unknown } | undefined;
  // A node with no `nodeType` is not a rule node (the same test the trace's
  // `dark` pass makes) — nothing to light, nothing to walk from.
  if (typeof d?.nodeType !== 'string' || !d.nodeType) return 'other';
  return 'node';
}

/** flow vs value, decided EXACTLY as `toRFEdges` decides the stroke colour it
 *  paints (`sourceHandle.includes('flow')`), falling back to the target handle
 *  for a hand-edited file with no source handle. */
export function edgeCategoryOf(e: HoverEditorEdge): HoverWireCategory {
  const sh = e.sourceHandle ?? '';
  if (sh) return sh.includes('flow') ? 'flow' : 'value';
  const th = e.targetHandle ?? '';
  return th.includes('flow') ? 'flow' : 'value';
}

/** The raw (un-lifted) colour a wire of this category is drawn in. */
export function categoryBaseColor(category: HoverWireCategory): string {
  return category === 'flow' ? EDGE_FLOW_COLOR : EDGE_VALUE_COLOR;
}

/**
 * O(N + E). Rebuilt only when the GRAPH changes — never per mouse move. The
 * editor caches it on the edge array identity + the node count, exactly like
 * `traceIndexRef`: a node drag replaces the node array 60x/s while changing
 * neither the wiring nor which nodes are reroutes.
 */
export function buildHoverIndex(
  nodes: readonly HoverEditorNode[],
  edges: readonly HoverEditorEdge[],
): HoverIndex {
  const reroutes = new Set<string>();
  const kindOf = new Map<string, HoverNodeKind>();
  for (const n of nodes) {
    const k = hoverNodeKind(n);
    kindOf.set(n.id, k);
    if (k === 'reroute') reroutes.add(n.id);
  }

  const inByNode = new Map<string, HoverWire[]>();
  const outByNode = new Map<string, HoverWire[]>();
  const wireById = new Map<string, HoverWire>();
  for (const e of edges) {
    const w: HoverWire = {
      id: e.id, source: e.source, target: e.target, category: edgeCategoryOf(e),
    };
    wireById.set(w.id, w);
    const ins = inByNode.get(w.target);
    if (ins) ins.push(w); else inByNode.set(w.target, [w]);
    const outs = outByNode.get(w.source);
    if (outs) outs.push(w); else outByNode.set(w.source, [w]);
  }

  return { reroutes, kindOf, inByNode, outByNode, wireById };
}

// ---------------------------------------------------------------------------
// The marks
// ---------------------------------------------------------------------------

/**
 * Which ids light for one hover. Returns `null` for anything with nothing to
 * light (a group, a comment, an id that is not in this scope) so the editor's
 * "clear everything" path and "nothing to do" path are the same code.
 *
 * The reroute walk, in both directions, is ITERATIVE and cycle-guarded: a
 * reroute has exactly one inbound wire by `isValidConnection`, but a
 * hand-edited `.gcaproj` can contain a dot pair that points at each other, and
 * a recursive walk would blow the stack on it (`buildEditorTraceIndex` guards
 * the same way, for the same reason).
 */
export function computeHoverMarks(
  index: HoverIndex,
  target: HoverTarget,
  // Reserved for P2/P3 (`transitive` + `cap` for the Alt cone). Accepted now so
  // the signature does not move later.
  _opts?: { transitive?: boolean; cap?: number },
): HoverMarks | null {
  if (target.kind !== 'node') return null;   // P2 seams — not answered in P1
  const kind = index.kindOf.get(target.id);
  if (!kind || kind === 'other') return null;

  const nodes = new Map<string, HoverNodeMark>();
  const edges = new Map<string, HoverEdgeMark>();
  nodes.set(target.id, 'self');

  // A 16 px dot has no thirds: hovering it lights BOTH sides (plan §3.3). The
  // zone the editor computed from the ratio is ignored rather than trusted, so
  // the rule holds no matter which call site asks.
  const zone: HoverZone = kind === 'reroute' ? 'both' : target.zone;

  if (zone === 'in' || zone === 'both') {
    const stack = [target.id];
    const seen = new Set(stack);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const w of index.inByNode.get(cur) ?? []) {
        if (!edges.has(w.id)) edges.set(w.id, 'in');
        const src = w.source;
        if (index.reroutes.has(src)) {
          if (!nodes.has(src)) nodes.set(src, 'relay');
          if (!seen.has(src)) { seen.add(src); stack.push(src); }
        } else if (!nodes.has(src)) {
          nodes.set(src, 'peer');
        }
      }
    }
  }

  if (zone === 'out' || zone === 'both') {
    const stack = [target.id];
    const seen = new Set(stack);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      // A dot FANS OUT: every outbound wire of a relay is part of the set.
      for (const w of index.outByNode.get(cur) ?? []) {
        // `in` wins a tie only because the in-walk ran first; the two closures
        // cannot actually overlap (that would need a cycle, which
        // `isValidConnection` rejects).
        if (!edges.has(w.id)) edges.set(w.id, 'out');
        const tgt = w.target;
        if (index.reroutes.has(tgt)) {
          if (!nodes.has(tgt)) nodes.set(tgt, 'relay');
          if (!seen.has(tgt)) { seen.add(tgt); stack.push(tgt); }
        } else if (!nodes.has(tgt)) {
          nodes.set(tgt, 'peer');
        }
      }
    }
  }

  return { nodes, edges, originId: target.id };
}

// ---------------------------------------------------------------------------
// The zone
// ---------------------------------------------------------------------------

/**
 * `(clientX - rect.left) / rect.width` → which third the cursor is in, with
 * HYSTERESIS against the zone it was in a moment ago.
 *
 * `prev` is the zone this gesture last resolved (`null` on enter). `both` is a
 * reroute's fixed zone and is never reached from a ratio, so it re-enters the
 * plain thresholds like `null` does.
 */
export function zoneForRatio(ratio: number, prev: HoverZone | null): HoverZone {
  const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  if (prev === 'in' && r <= HOVER_LEAVE_LEFT) return 'in';
  if (prev === 'out' && r >= HOVER_LEAVE_RIGHT) return 'out';
  if (r < HOVER_ENTER_LEFT) return 'in';
  if (r > HOVER_ENTER_RIGHT) return 'out';
  return 'self';
}

// ---------------------------------------------------------------------------
// The colour
// ---------------------------------------------------------------------------

function parseHex(hex: string): [number, number, number] | null {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

function hue2rgb(p: number, q: number, t: number): number {
  let u = t;
  if (u < 0) u += 1;
  if (u > 1) u -= 1;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
}

/**
 * The glow colour for a raw node fill — **an HSL LIGHTNESS LIFT, keeping hue and
 * saturation**.
 *
 * ⚠ THIS IS THE ONE REAL FINDING OF THE INVESTIGATION (plan §2.3), not a
 * flourish. `def.color` fills are deliberately dark and muted (the Blender
 * compositor palette: `conditional` `#1b5e20`, `getCellAttribute` `#b71c1c`,
 * `setAttribute` `#4a148c`), and the node's BORDER is already painted in
 * `def.color` — so a 2 px ring in the raw hue reads as *no change at all*. The
 * live prototype proved it: the first pass was invisible at 1x.
 *
 * A fill that is ALREADY at or above the target lightness is returned unchanged,
 * which is why the white event roots (`#ffffff`) and light fills stay themselves
 * instead of being washed out.
 */
export function hoverGlowColor(hex: string, targetL: number = HOVER_GLOW_L): string {
  const rgb = parseHex(hex);
  if (!rgb) return HOVER_FALLBACK_COLOR;
  const [r8, g8, b8] = rgb;
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (l >= targetL) return `#${hex2(r8)}${hex2(g8)}${hex2(b8)}`;
  const d = max - min;
  if (d === 0) {
    // Achromatic: there is no hue to keep, so it lifts straight up the grey axis.
    const v = targetL * 255;
    return `#${hex2(v)}${hex2(v)}${hex2(v)}`;
  }
  const s = d / (1 - Math.abs(2 * l - 1));
  let hDeg: number;
  if (max === r) hDeg = ((g - b) / d) % 6;
  else if (max === g) hDeg = (b - r) / d + 2;
  else hDeg = (r - g) / d + 4;
  const hNorm = ((hDeg / 6) % 1 + 1) % 1;
  const q = targetL < 0.5 ? targetL * (1 + s) : targetL + s - targetL * s;
  const p = 2 * targetL - q;
  const nr = hue2rgb(p, q, hNorm + 1 / 3) * 255;
  const ng = hue2rgb(p, q, hNorm) * 255;
  const nb = hue2rgb(p, q, hNorm - 1 / 3) * 255;
  return `#${hex2(nr)}${hex2(ng)}${hex2(nb)}`;
}

/**
 * The translucent halo colour, as an `rgba()` string.
 *
 * DECISION (an as-built choice the plan left open, §4.3): the soft halo is
 * computed HERE and written as a SECOND custom property (`--hover-c-soft`)
 * rather than derived in CSS with `color-mix(in srgb, var(--hover-c) 55%,
 * transparent)`. Two reasons: it removes the only `color-mix` dependency in the
 * feature (risk R10), and the derived value becomes visible in the DOM, so the
 * real-UI verification can read the halo it is looking at instead of inferring
 * it.
 */
export function hoverSoftColor(hex: string, alpha = 0.5): string {
  const rgb = parseHex(hex) ?? parseHex(HOVER_FALLBACK_COLOR)!;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
