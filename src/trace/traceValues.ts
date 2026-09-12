/** RULE TRACE (P5) — the DOM-free half of the Trace panel.
 *
 * Everything here is a pure function of a trace reply (its `writes`, its
 * `snapshot`, its `events`) plus the model's own vocabulary, so
 * `scripts/test-rule-trace.mjs` § J drives the SHIPPED functions rather than a
 * transcription of them — the house rule `traceGraphMap.ts` and `traceOrigin.ts`
 * already follow. `TracePanel.tsx` renders what this returns and decides nothing
 * about what a write MEANS.
 *
 * THE ONE IDEA: a trace's `writes` are RAW — a parameter name, a flat index, a
 * number, and the number that was there before. `w_alive` at the traced cell's
 * own index is "this attribute's next value"; the SAME parameter at another
 * index is "a write aimed at a neighbour"; `colors` at `idx*4` is the colour the
 * Output Mapping produced; `_bondFormReq` is one lane of a sign-encoded
 * structural request. Turning that back into sentences is the panel's entire
 * job, and it is exactly the part worth testing without a browser.
 *
 * ⚠ NOTHING THE TRACE WROTE MAY BE INVISIBLE. Every write is claimed by exactly
 * one row builder, and whatever is left over comes out as a generic
 * `param[index] prev → value` row (`unknownRows`). A write that silently
 * vanished from the table would make the panel quietly lie about what the rule
 * did — the one thing a debugger must never do. The `claimed` set is how that is
 * enforced, and the harness asserts it.
 *
 * ⚠ THE REQUEST LANES MIRROR AN EMITTER. The bond verbs are encoded across the
 * SIGNS of two lanes by `bondRequestEmitJS.ts` (and its WASM / WebGPU mirrors);
 * `decodeBondRequest` below is the READING of that encoding and its constants
 * are imported from `bondRequestQueue.ts` rather than re-spelled, so a change to
 * the bias or the sign convention cannot leave the panel decoding an old dialect.
 */

import type { TraceEvent, TraceWrite } from '../simulator/engine/traceRunner';
import type { TraceTarget, TraceRootKey } from '../simulator/engine/traceProtocol';
import { BOND_REQ_NONE, BOND_REQ_ID_BIAS } from '../modeler/vpl/compiler/bondRequestQueue';
import { unpackNI, unpackNI3, INVALID_NI } from '../modeler/vpl/compiler/niCodec';

// ---------------------------------------------------------------------------
// Number / neighbour-index formatting — ONE definition for the whole feature
// ---------------------------------------------------------------------------

/** A number as the trace prints it: integers bare, decimals trimmed to four
 *  places with the trailing zeros dropped. Deliberately COMPACT — a values table
 *  and a hover tooltip both read as a sentence, not as a spreadsheet cell (the
 *  cell inspector's own `formatFloat` pads `3` to `3.0`, which is right for a
 *  fixed-width popover and wrong here). `TraceTooltip` imports it from here so
 *  the two surfaces cannot drift. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === Math.trunc(v)) return String(v);
  const fixed = v.toFixed(4);
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** A packed neighbour index as `(dr, dc)` / `(dr, dc, dl)`, through the
 *  dimension's own codec (2D packs two 16-bit offsets, 3D three 10-bit ones). */
export function formatNI(n: number, is3d: boolean): string {
  const packed = n | 0;
  if (packed === INVALID_NI) return 'no neighbour';
  if (is3d) {
    const { dr, dc, dl } = unpackNI3(packed);
    return `(${dr}, ${dc}, ${dl})`;
  }
  const { dr, dc } = unpackNI(packed);
  return `(${dr}, ${dc})`;
}

// ---------------------------------------------------------------------------
// The row model the panel renders
// ---------------------------------------------------------------------------

/** One displayable value. The panel turns it into text; keeping the NUMBER here
 *  is what lets `changed` be decided numerically (a formatter that rounds could
 *  otherwise make a real change look like none). */
export type TraceRowValue =
  /** Decode through this attribute's declared type (tag option, Binary, NI…). */
  | { kind: 'attr'; attrId: string; v: number }
  | { kind: 'number'; v: number }
  | { kind: 'vector'; v: number[] }
  | { kind: 'hex'; rgb: [number, number, number] }
  | { kind: 'text'; text: string };

export interface TraceRow {
  /** Stable React key AND the harness's handle on the row. */
  key: string;
  name: string;
  current?: TraceRowValue;
  next?: TraceRowValue;
  /** The rule wrote this row's target and the value differs from what was there. */
  changed: boolean;
  /** The rule did NOT write it — `next` mirrors `current` and renders greyed. */
  unchanged?: boolean;
  /** A trailing qualifier: `queued, not applied`, `write to another cell`… */
  note?: string;
  /** The attribute whose TYPE badge this row carries (`typeDisplayName` is
   *  applied by the panel — this module never spells a user-facing type name). */
  typeOf?: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** As much of an `Attribute` as the rows need. Structural, so the model's own
 *  `Attribute` satisfies it and the harness can hand-build one. */
export interface TraceAttrSpec {
  id: string;
  name: string;
  type: string;
  vectorDims?: number;
}

export interface TraceGridDims {
  W: number;
  H: number;
  /** 1 ⇒ a 2D grid. */
  D: number;
}

export interface TraceRowsInput {
  target: TraceTarget;
  writes: readonly TraceWrite[];
  events: readonly TraceEvent[];
  snapshot?: Record<string, number> | undefined;
  /** Declaration order — A6 says rows are never re-sorted. */
  attrs: readonly TraceAttrSpec[];
  dims: TraceGridDims;
  /** `model.indicators` order, which is the order `_indicators` is indexed in
   *  (`compile.ts` builds the map from that array). */
  indicatorNames?: readonly string[];
  /** The message of the Stop Event node the trace actually ran, when the panel
   *  could resolve one (see `TracePanel`); the flag itself only carries an
   *  index into a post-macro-expansion list the main thread does not have. */
  stopMessage?: string | undefined;
  /** Per-agent bond-request queue slots (`bondReqSlotsForModel`). */
  bondReqSlots?: number;
  /** Cell-field ids an agent may deposit into (`_field_<id>`), with their names. */
  fieldAttrs?: readonly TraceAttrSpec[];
}

// ---------------------------------------------------------------------------
// Write indexing
// ---------------------------------------------------------------------------

export interface IndexedWrite { index: number; value: number; prev: number }

/** `param → index → write`. Built once per entry; every row builder reads it. */
export function indexWrites(writes: readonly TraceWrite[]): Map<string, Map<number, IndexedWrite>> {
  const out = new Map<string, Map<number, IndexedWrite>>();
  for (const w of writes) {
    let m = out.get(w.param);
    if (!m) { m = new Map(); out.set(w.param, m); }
    // LAST write wins: the shadow already collapsed repeated writes to one entry
    // per index, but an aliased buffer can appear under two parameter names and
    // the later one is the one the engine would keep.
    m.set(w.index, { index: w.index, value: w.value, prev: w.prev });
  }
  return out;
}

/** `${param}:${index}` — the key the `claimed` set uses. */
export const writeKey = (param: string, index: number): string => `${param}:${index}`;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Flat cell index → grid coordinates. 3D adds the layer axis exactly as the
 *  engine's own `_layer` decode does (`total = W*H*D`, layer-major). */
export function cellCoords(idx: number, dims: TraceGridDims): { r: number; c: number; l: number } {
  const WH = dims.W * dims.H;
  if (dims.D > 1) {
    const l = Math.floor(idx / WH);
    const rem = idx - l * WH;
    return { l, r: Math.floor(rem / dims.W), c: rem % dims.W };
  }
  return { l: 0, r: Math.floor(idx / dims.W), c: idx % dims.W };
}

/** Shortest signed offset on a wrapped axis — `dr = 1` rather than `dr = −199`
 *  for a write from row 199 to row 0 of a 200-row grid.
 *
 *  Applied on EVERY boundary, not only a torus: a neighbour write is local by
 *  construction (the writer reached the target through a neighbourhood), so the
 *  short way round is always the one the user means, and on a non-torus grid the
 *  wrapped case cannot arise in the first place. */
export function shortestDelta(a: number, b: number, extent: number): number {
  let d = b - a;
  if (extent <= 1) return d;
  const half = extent / 2;
  if (d > half) d -= extent;
  else if (d < -half) d += extent;
  return d;
}

/** The `(dr, dc)` / `(dr, dc, dl)` a write at `to` carries, seen from `from`. */
export function neighbourOffset(
  from: number, to: number, dims: TraceGridDims,
): { dr: number; dc: number; dl: number } {
  const a = cellCoords(from, dims);
  const b = cellCoords(to, dims);
  return {
    dr: shortestDelta(a.r, b.r, dims.H),
    dc: shortestDelta(a.c, b.c, dims.W),
    dl: dims.D > 1 ? shortestDelta(a.l, b.l, dims.D) : 0,
  };
}

/** `(dr, dc)` / `(dr, dc, dl)` as the panel prints it. */
export function formatOffset(o: { dr: number; dc: number; dl: number }, is3d: boolean): string {
  return is3d ? `(${o.dr}, ${o.dc}, ${o.dl})` : `(${o.dr}, ${o.dc})`;
}

/** The element label the panel's header carries — `Cell (r, c)` in 2D,
 *  `Cell (layer, r, c)` in 3D, `Agent #id`. */
export function traceTargetLabel(target: TraceTarget, dims: TraceGridDims): string {
  if (target.kind === 'agent') return `Agent #${target.id}`;
  if (target.idx < 0) return 'Cell';
  const { r, c, l } = cellCoords(target.idx, dims);
  return dims.D > 1 ? `Cell (${l}, ${r}, ${c})` : `Cell (${r}, ${c})`;
}

// ---------------------------------------------------------------------------
// Root labels — the timeline strip's vocabulary
// ---------------------------------------------------------------------------

/** The names a root key needs looked up in the model. Every lookup may answer
 *  `undefined`; the label then falls back to the bare word, because a timeline
 *  chip must always be able to say something. */
export interface TraceRootNames {
  mapping?: (mappingId: string) => string | undefined;
  agentMapping?: (mappingId: string) => string | undefined;
  periodicNode?: (nodeId: string) => string | undefined;
}

/** Roots that fire on RESET rather than during a generation. Their chip reads
 *  `Reset · Init` instead of `gen N · Init`: the generation counter is 0 for all
 *  of them, and "gen 0" would read as "the first step", which they are not. */
const RESET_ROOTS = new Set(['init', 'gridInit', 'agentInit']);

export function isResetRoot(root: TraceRootKey): boolean { return RESET_ROOTS.has(root); }

/** One root key → the words the timeline and the Values header use. */
export function traceRootLabel(root: TraceRootKey, names: TraceRootNames = {}): string {
  const colon = root.indexOf(':');
  if (colon < 0) {
    switch (root) {
      case 'step': return 'Step';
      case 'init': return 'Init';
      case 'gridInit': return 'Grid Init';
      case 'agentBehaviour': return 'Behaviour';
      case 'agentInit': return 'Agent Init';
      case 'agentDivision': return 'Division';
      default: return root;
    }
  }
  const prefix = root.slice(0, colon);
  const rest = root.slice(colon + 1);
  const wrap = (word: string, name: string | undefined): string =>
    (name ? `${word} (${name})` : word);
  switch (prefix) {
    case 'gridPeriodic':
    case 'agentPeriodic': return wrap('Periodic', names.periodicNode?.(rest));
    case 'inputColor': return wrap('Brush', names.mapping?.(rest));
    case 'outputMapping': return wrap('Output Mapping', names.mapping?.(rest));
    case 'agentInputMapping': return wrap('Agent Brush', names.agentMapping?.(rest));
    case 'agentOutputMapping': return wrap('Agent View', names.agentMapping?.(rest));
    default: return root;
  }
}

/** The timeline chip's full text. */
export function traceChipLabel(root: TraceRootKey, gen: number, names?: TraceRootNames): string {
  return `${isResetRoot(root) ? 'Reset' : `gen ${gen}`} · ${traceRootLabel(root, names)}`;
}

// ---------------------------------------------------------------------------
// The bond-request lanes (see the module header)
// ---------------------------------------------------------------------------

export type BondRequestVerbRead =
  | 'form' | 'break' | 'rewire' | 'formBetween' | 'breakBetween' | 'transfer';

export interface BondRequestRead {
  verb: BondRequestVerbRead;
  /** The ids the verb names, already un-biased. `-1` ⇒ the emitter's explicit
   *  no-op (an unresolvable port), which the panel prints as `unresolved`. */
  a: number;
  b: number;
}

const unbias = (lane: number): number => Math.abs(lane) - BOND_REQ_ID_BIAS;

/** Read ONE queue entry back into a verb. The truth table is the mirror of
 *  `emitBondRequestJS`: the lane SIGNS carry the op kind, `BOND_REQ_NONE` marks
 *  the unused half, and a bare id is biased by `BOND_REQ_ID_BIAS`.
 *
 *  | break lane | form lane | verb |
 *  |---|---|---|
 *  | +NONE | +id | form (self → id) |
 *  | +id | +NONE | break (self ↔ id) |
 *  | +id | +id | rewire (break from, form to) |
 *  | −id | +id | form between |
 *  | −id | −id | break between |
 *  | +id | −id | transfer |
 */
export function decodeBondRequest(breakLane: number, formLane: number): BondRequestRead | null {
  if (breakLane === 0 && formLane === 0) return null;   // never appended
  const bNeg = breakLane < 0, fNeg = formLane < 0;
  const bNone = Math.abs(breakLane) === BOND_REQ_NONE;
  const fNone = Math.abs(formLane) === BOND_REQ_NONE;
  if (!bNeg && !fNeg) {
    if (bNone && !fNone) return { verb: 'form', a: unbias(formLane), b: -1 };
    if (!bNone && fNone) return { verb: 'break', a: unbias(breakLane), b: -1 };
    if (bNone && fNone) return null;                    // both halves unused
    return { verb: 'rewire', a: unbias(breakLane), b: unbias(formLane) };
  }
  if (bNeg && !fNeg) return { verb: 'formBetween', a: unbias(breakLane), b: unbias(formLane) };
  if (bNeg && fNeg) return { verb: 'breakBetween', a: unbias(breakLane), b: unbias(formLane) };
  return { verb: 'transfer', a: unbias(breakLane), b: unbias(formLane) };
}

/** The sentence one decoded request reads as. `#-1` never appears: an
 *  unresolvable port is named for what it is. */
export function bondRequestText(r: BondRequestRead): string {
  const id = (n: number): string => (n < 0 ? 'unresolved' : `#${n}`);
  switch (r.verb) {
    case 'form': return `Form bond → ${id(r.a)}`;
    case 'break': return `Break bond ↔ ${id(r.a)}`;
    case 'rewire': return `Rewire ${id(r.a)} → ${id(r.b)}`;
    case 'formBetween': return `Form bond ${id(r.a)} ↔ ${id(r.b)}`;
    case 'breakBetween': return `Break bond ${id(r.a)} ↔ ${id(r.b)}`;
    case 'transfer': return `Transfer bond ${id(r.a)} → ${id(r.b)}`;
  }
}

// ---------------------------------------------------------------------------
// buildTraceRows — the one entry point
// ---------------------------------------------------------------------------

/** A stored `vector` attribute is lowered to scalar-float components before any
 *  compile, so the snapshot and the writes both speak COMPONENTS. Mirrors
 *  `vectorComponentIds` (copied rather than imported to keep this module free of
 *  the compiler's attribute machinery — the suffixes are a file format, not a
 *  policy, and the harness pins them). */
const VECTOR_SUFFIXES = ['_vx', '_vy', '_vz'];
function componentIdsOf(attr: TraceAttrSpec): string[] {
  const dims = Math.max(2, Math.min(3, attr.vectorDims ?? 2));
  return VECTOR_SUFFIXES.slice(0, dims).map(s => attr.id + s);
}

export interface TraceRowsResult {
  rows: TraceRow[];
  /** How many writes no row builder claimed (0 in every shipped model — the
   *  generic rows exist for a node type nobody has taught this module yet). */
  unknownCount: number;
}

export function buildTraceRows(input: TraceRowsInput): TraceRowsResult {
  const { target, dims } = input;
  const is3d = dims.D > 1;
  const byParam = indexWrites(input.writes);
  const claimed = new Set<string>();
  const rows: TraceRow[] = [];
  const snap = input.snapshot;

  /** Read one write and mark it claimed. */
  const take = (param: string, index: number): IndexedWrite | undefined => {
    const w = byParam.get(param)?.get(index);
    if (w) claimed.add(writeKey(param, index));
    return w;
  };
  /** Claim a write without reading it (a lane consumed by a sibling row). */
  const claim = (param: string, index: number): void => { claimed.add(writeKey(param, index)); };

  const elementIdx = target.kind === 'cell' ? target.idx : target.id;

  // --- 1. THE ATTRIBUTES, in declaration order (decision A6) ---------------
  for (const attr of input.attrs) {
    if (attr.type === 'vector') {
      const ids = componentIdsOf(attr);
      const cur = ids.map(id => snap?.[id] ?? 0);
      const nxt = ids.map((id, i) => {
        const w = take(`w_${id}`, elementIdx);
        return w ? w.value : cur[i]!;
      });
      const changed = nxt.some((v, i) => v !== cur[i]);
      rows.push({
        key: `attr:${attr.id}`, name: attr.name, typeOf: attr.type,
        ...(snap ? { current: { kind: 'vector', v: cur } as TraceRowValue } : {}),
        next: { kind: 'vector', v: nxt }, changed, ...(changed ? {} : { unchanged: true }),
      });
      continue;
    }
    const w = take(`w_${attr.id}`, elementIdx);
    const cur = snap?.[attr.id];
    const nextV = w ? w.value : cur;
    // `prev` is the live buffer's value at the trace point — the same number the
    // snapshot carries. Comparing against the snapshot when there is one keeps
    // the accent honest even for a root whose write buffer starts empty.
    const base = cur !== undefined ? cur : (w ? w.prev : undefined);
    const changed = w !== undefined && base !== undefined && w.value !== base;
    rows.push({
      key: `attr:${attr.id}`, name: attr.name, typeOf: attr.type,
      ...(base !== undefined ? { current: { kind: 'attr', attrId: attr.id, v: base } as TraceRowValue } : {}),
      ...(nextV !== undefined ? { next: { kind: 'attr', attrId: attr.id, v: nextV } as TraceRowValue } : {}),
      changed, ...(changed ? {} : { unchanged: true }),
    });
  }

  if (target.kind === 'cell') {
    buildCellExtraRows(input, { rows, take, claim, byParam, claimed, elementIdx, is3d, snap });
  } else {
    buildAgentExtraRows(input, { rows, take, claim, byParam, claimed, elementIdx, is3d, snap });
  }

  // --- COMMON: indicators, stop, unknown -----------------------------------
  pushIndicatorRows(input, rows, byParam, claimed);
  pushStopRow(input, rows, byParam, claimed);
  const unknown = pushUnknownRows(rows, byParam, claimed);

  return { rows, unknownCount: unknown };
}

// ---------------------------------------------------------------------------

interface RowCtx {
  rows: TraceRow[];
  take: (param: string, index: number) => IndexedWrite | undefined;
  claim: (param: string, index: number) => void;
  byParam: Map<string, Map<number, IndexedWrite>>;
  claimed: Set<string>;
  elementIdx: number;
  is3d: boolean;
  snap: Record<string, number> | undefined;
}

/** A cell's non-attribute rows: orientation, colour, glyph, the writes aimed at
 *  OTHER cells, and the async skip flag. */
function buildCellExtraRows(input: TraceRowsInput, ctx: RowCtx): void {
  const { rows, take, elementIdx, is3d } = ctx;
  const idx = elementIdx;

  // Orientation (variegated models only — the snapshot carries it only then).
  const ow = take('w_orientation', idx);
  const oCur = ctx.snap?.orientation;
  if (ow || oCur !== undefined) {
    const base = oCur !== undefined ? oCur : ow!.prev;
    const next = ow ? ow.value : base;
    rows.push({
      key: 'orientation', name: 'Orientation',
      current: { kind: 'number', v: base }, next: { kind: 'number', v: next },
      changed: next !== base, ...(next === base ? { unchanged: true } : {}),
    });
  }

  // Colour — the Output Mapping's RGB, written as three consecutive `colors`
  // bytes (the fourth is alpha and the colour pass leaves it alone).
  const base4 = idx * 4;
  const cr = take('colors', base4), cg = take('colors', base4 + 1), cb = take('colors', base4 + 2);
  take('colors', base4 + 3);
  if (cr || cg || cb) {
    // A colour pass writes all four channels together, so a partial write is
    // not a shape the shipped emitters produce; a missing channel falls back to
    // 0 rather than inventing a value the trace never saw.
    const rgb: [number, number, number] = [cr?.value ?? 0, cg?.value ?? 0, cb?.value ?? 0];
    rows.push({
      key: 'colour', name: 'Colour', next: { kind: 'hex', rgb }, changed: true,
      note: 'Output Mapping',
    });
  }

  const gc = take('glyphCodes', idx);
  if (gc) {
    rows.push({
      key: 'glyph', name: 'Glyph',
      current: { kind: 'number', v: gc.prev }, next: { kind: 'number', v: gc.value },
      changed: gc.value !== gc.prev,
    });
  }
  const gcol = take('glyphColors', idx);
  if (gcol) {
    rows.push({
      key: 'glyphColour', name: 'Glyph colour',
      next: { kind: 'number', v: gcol.value }, changed: true,
    });
  }

  // "Mark Cell Updated" (asynchronous mode only).
  const sk = take('_skipped', idx);
  if (sk && sk.value) {
    rows.push({
      key: 'skipped', name: 'Skipped', next: { kind: 'text', text: 'Mark Cell Updated' },
      changed: true,
    });
  }

  // NEIGHBOUR WRITES — the same `w_<attr>` parameters at ANOTHER index. Sorted
  // by (attribute declaration order, then index) so the block is stable frame to
  // frame; a row that jumps is harder to follow across generations (A6's reason).
  for (const attr of input.attrs) {
    const ids = attr.type === 'vector' ? componentIdsOf(attr) : [attr.id];
    for (const id of ids) {
      const m = ctx.byParam.get(`w_${id}`);
      if (!m) continue;
      const others = [...m.values()].filter(w => w.index !== elementIdx).sort((a, b) => a.index - b.index);
      for (const w of others) {
        ctx.claim(`w_${id}`, w.index);
        const off = neighbourOffset(elementIdx, w.index, input.dims);
        rows.push({
          key: `nbr:${id}:${w.index}`,
          name: `${formatOffset(off, is3d)} ${attr.name}`,
          current: { kind: 'attr', attrId: id, v: w.prev },
          next: { kind: 'attr', attrId: id, v: w.value },
          changed: w.value !== w.prev, note: 'write to another cell',
        });
      }
    }
  }
}

/** An agent's non-attribute rows: geometry, the force the rule accumulated, the
 *  structural requests, field deposits and the sprite. */
function buildAgentExtraRows(input: TraceRowsInput, ctx: RowCtx): void {
  const { rows, take, elementIdx: id, snap } = ctx;
  const is3dAgents = snap?.z !== undefined;

  const axes = is3dAgents ? ['X', 'Y', 'Z'] : ['X', 'Y'];
  const lower = is3dAgents ? ['x', 'y', 'z'] : ['x', 'y'];

  // POSITION — normally NOT written by a rule (the integrator moves the agent),
  // so the row shows the current position and says so only when something wrote.
  const posW = axes.map(a => take(`_agent${a}`, id));
  const posCur = lower.map(k => snap?.[k] ?? 0);
  if (snap || posW.some(Boolean)) {
    const next = posW.map((w, i) => (w ? w.value : posCur[i]!));
    const changed = posW.some((w, i) => w !== undefined && w.value !== posCur[i]);
    rows.push({
      key: 'position', name: 'Position',
      current: { kind: 'vector', v: posCur }, next: { kind: 'vector', v: next },
      changed, ...(changed ? {} : { unchanged: true }),
    });
  }

  // VELOCITY — `_agentVX` / `_agentVY` / `_agentVZ` (the ABI spells the axis in
  // upper case; getting that wrong is a silently empty row, not an error).
  const velW = axes.map(a => take(`_agentV${a}`, id));
  const velCur = lower.map(k => snap?.['v' + k] ?? 0);
  if (snap || velW.some(Boolean)) {
    const next = velW.map((w, i) => (w ? w.value : velCur[i]!));
    const changed = velW.some((w, i) => w !== undefined && w.value !== velCur[i]);
    rows.push({
      key: 'velocity', name: 'Velocity',
      current: { kind: 'vector', v: velCur }, next: { kind: 'vector', v: next },
      changed, ...(changed ? {} : { unchanged: true }),
    });
  }

  // FORCE — the accumulator is ADDITIVE and shared with the engine's own force
  // pass, so the interesting number is what THIS rule contributed: value − prev.
  const forceW = axes.map(a => take(`_agentForce${a}`, id));
  if (forceW.some(Boolean)) {
    const delta = forceW.map(w => (w ? w.value - w.prev : 0));
    rows.push({
      key: 'force', name: 'Force applied',
      next: { kind: 'vector', v: delta }, changed: delta.some(v => v !== 0),
      note: 'total added by this rule',
    });
  }

  for (const [param, key, name] of [
    ['_agentRadius', 'radius', 'Radius'],
    ['_agentTargetRadius', 'targetRadius', 'Target radius'],
    ['_agentAge', 'age', 'Age'],
  ] as const) {
    const w = take(param, id);
    const cur = snap?.[key];
    if (!w && cur === undefined) continue;
    const base = cur !== undefined ? cur : w!.prev;
    const next = w ? w.value : base;
    rows.push({
      key, name,
      current: { kind: 'number', v: base }, next: { kind: 'number', v: next },
      changed: next !== base, ...(next === base ? { unchanged: true } : {}),
    });
  }

  // --- REQUESTS: recorded, never applied ----------------------------------
  const div = take('_divideRequest', id);
  if (div && div.value) {
    take('_divideAxisX', id); take('_divideAxisY', id); take('_divideAsym', id);
    rows.push({ key: 'req:divide', name: 'Request', next: { kind: 'text', text: 'Divide' }, changed: true, note: 'queued, not applied' });
  }
  const kill = take('_killRequest', id);
  if (kill && kill.value) {
    rows.push({ key: 'req:kill', name: 'Request', next: { kind: 'text', text: 'Kill' }, changed: true, note: 'queued, not applied' });
  }

  // Bond verbs — one row per QUEUE ENTRY, read back through the sign encoding.
  const slots = Math.max(1, Math.floor(input.bondReqSlots ?? 1));
  const breakM = ctx.byParam.get('_bondBreakReq');
  const formM = ctx.byParam.get('_bondFormReq');
  if (breakM || formM) {
    for (let s = 0; s < slots; s++) {
      const bq = id * slots + s;
      const b = breakM?.get(bq), f = formM?.get(bq);
      if (!b && !f) continue;
      ctx.claim('_bondBreakReq', bq); ctx.claim('_bondFormReq', bq);
      ctx.claim('_bondFormL', bq); ctx.claim('_bondFormK', bq);
      // The FORM half's per-bond-attribute cells. Claimed by PREFIX rather than
      // from a list of bond attributes: the panel would have to thread a fourth
      // id-space in just to silence rows the request row already speaks for.
      for (const p of ctx.byParam.keys()) if (p.startsWith('_bondFormAttr_')) ctx.claim(p, bq);
      const read = decodeBondRequest(b ? b.value : 0, f ? f.value : 0);
      if (!read) continue;
      rows.push({
        key: `req:bond:${s}`, name: 'Request',
        next: { kind: 'text', text: bondRequestText(read) }, changed: true,
        note: 'queued, not applied',
      });
    }
  }

  // Create Agent / Add Agent To World are HOST FUNCTIONS, so the sandbox records
  // them as `q` events rather than as writes — the one request kind that leaves
  // no trace in a buffer.
  for (const ev of input.events) {
    if (ev[0] !== 'q') continue;
    const fn = ev[1];
    const text = fn === '_agentCreate' ? 'Create Agent'
      : fn === '_agentAddToWorld' ? 'Add Agent To World' : fn;
    rows.push({
      key: `req:q:${rows.length}`, name: 'Request',
      next: { kind: 'text', text }, changed: true, note: 'queued, not applied',
    });
  }

  // --- FIELD DEPOSITS: a write into a CELL attribute from the agent graph ---
  for (const f of input.fieldAttrs ?? []) {
    const m = ctx.byParam.get(`_field_${f.id}`);
    if (!m) continue;
    for (const w of [...m.values()].sort((a, b) => a.index - b.index)) {
      ctx.claim(`_field_${f.id}`, w.index);
      const { r, c, l } = cellCoords(w.index, input.dims);
      const where = input.dims.D > 1 ? `(${l}, ${r}, ${c})` : `(${r}, ${c})`;
      rows.push({
        key: `field:${f.id}:${w.index}`, name: `Field ${f.name}`,
        current: { kind: 'number', v: w.prev }, next: { kind: 'number', v: w.value },
        changed: w.value !== w.prev, note: `deposited into cell ${where}`,
      });
    }
  }

  // --- SPRITE ---------------------------------------------------------------
  for (const [param, name] of [
    ['spriteIds', 'Sprite'], ['spriteFrames', 'Sprite frame'],
    ['spriteSpeeds', 'Sprite speed'], ['spriteRotations', 'Sprite rotation'],
    ['spriteScales', 'Sprite scale'],
  ] as const) {
    const w = take(param, id);
    if (!w) continue;
    rows.push({
      key: `sprite:${param}`, name,
      current: { kind: 'number', v: w.prev }, next: { kind: 'number', v: w.value },
      changed: w.value !== w.prev,
    });
  }

  // The agent colour pass writes the agent's own RGBA run.
  const base4 = id * 4;
  const cr = take('colors', base4), cg = take('colors', base4 + 1), cb = take('colors', base4 + 2);
  take('colors', base4 + 3);
  if (cr || cg || cb) {
    rows.push({
      key: 'colour', name: 'Colour',
      next: { kind: 'hex', rgb: [cr?.value ?? 0, cg?.value ?? 0, cb?.value ?? 0] },
      changed: true, note: 'Agent View',
    });
  }
}

function pushIndicatorRows(
  input: TraceRowsInput, rows: TraceRow[],
  byParam: Map<string, Map<number, IndexedWrite>>, claimed: Set<string>,
): void {
  const m = byParam.get('_indicators');
  if (!m) return;
  for (const w of [...m.values()].sort((a, b) => a.index - b.index)) {
    claimed.add(writeKey('_indicators', w.index));
    const name = input.indicatorNames?.[w.index] ?? `Indicator #${w.index}`;
    rows.push({
      key: `indicator:${w.index}`, name,
      current: { kind: 'number', v: w.prev }, next: { kind: 'number', v: w.value },
      changed: w.value !== w.prev, note: 'indicator write',
    });
  }
}

function pushStopRow(
  input: TraceRowsInput, rows: TraceRow[],
  byParam: Map<string, Map<number, IndexedWrite>>, claimed: Set<string>,
): void {
  const w = byParam.get('_stopFlag')?.get(0);
  if (!w) return;
  claimed.add(writeKey('_stopFlag', 0));
  // The flag holds a 1-BASED index into the post-macro-expansion stop-event list,
  // which the main thread does not have — so the message is resolved by the panel
  // from the node the trace actually executed, and `raised` is the honest
  // fallback rather than a guessed message.
  rows.push({
    key: 'stop', name: 'Stop event',
    next: { kind: 'text', text: w.value ? (input.stopMessage ?? 'raised') : 'not fired' },
    changed: w.value !== 0,
  });
}

/** Everything no builder claimed. See the module header: the trace must never
 *  write something the panel does not show. */
function pushUnknownRows(
  rows: TraceRow[], byParam: Map<string, Map<number, IndexedWrite>>, claimed: Set<string>,
): number {
  let n = 0;
  const params = [...byParam.keys()].sort();
  for (const param of params) {
    for (const w of [...byParam.get(param)!.values()].sort((a, b) => a.index - b.index)) {
      if (claimed.has(writeKey(param, w.index))) continue;
      n++;
      rows.push({
        key: `raw:${param}:${w.index}`, name: `${param}[${w.index}]`,
        current: { kind: 'number', v: w.prev }, next: { kind: 'number', v: w.value },
        changed: w.value !== w.prev, note: 'engine write',
      });
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// The "approximate" caveat — the brainstorm's table, in one sentence
// ---------------------------------------------------------------------------

/** WHY a trace is approximate, in the words the header line uses. The worker
 *  ships one boolean (it knows the reasons but not the user's vocabulary), so
 *  the model's own settings pick the sentence — and when several apply, the one
 *  that changes the answer most is named first. */
export function approximateReason(opts: {
  asyncCells: boolean;
  agentsAsync: boolean;
  /** Agents are running AND they deposit into a cell field this rule reads —
   *  the trace is taken before their deposits land (the worker's own term). */
  agentsWriteField: boolean;
  usesRng: boolean;
  webgpu: boolean;
  kind: 'cells' | 'agents';
}): string {
  if (opts.kind === 'cells' && opts.asyncCells) return 'approximate under asynchronous updates';
  if (opts.kind === 'agents' && opts.agentsAsync) return 'approximate — agent attributes update asynchronously';
  if (opts.kind === 'cells' && opts.agentsWriteField) {
    return 'approximate — agents deposit into the field after this trace';
  }
  if (opts.usesRng) return 'approximate — the rule draws random numbers';
  if (opts.webgpu) return 'approximate — WebGPU computes in 32-bit';
  // The worker knows the reason; the panel only knows the model. A term it
  // cannot name is still worth flagging — the badge's tooltip lists them all.
  return 'approximate — see the badge for why';
}
