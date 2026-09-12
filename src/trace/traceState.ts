/** RULE TRACE (P3) — THE TRACE STORE (main thread).
 *
 * One module global in the `graphState.ts` shape (private `let`, getter,
 * `subscribe` returning an unsubscribe, equality-guarded setters that notify),
 * because the four consumers live in THREE React trees: `SimulatorView` (the
 * marks, the chip, the worker protocol), `GraphEditor` / `CaNode` (P4 — the lit
 * path and the breakpoint glyphs), the Trace panel (P5) and `App` (the `]` / `[`
 * keys). Prop-drilling a trace through 18 kloc of simulator into another tree
 * buys nothing over the seam this project already uses everywhere else.
 *
 * ⚠ TWO NOTIFICATION CHANNELS, and the reason is perf, not taste.
 * A trace arrives up to ~30×/s. Everything that is per-TRACE (the timeline, the
 * newest entry) notifies `subscribeTraceTimeline`; everything that is per-SESSION
 * (the target, the breakpoints, the pause, the selection, the cursor) notifies
 * `subscribeTraceSession`. A component that only needs to know "is something
 * being traced" — the Live bar chip — subscribes to the SESSION channel and
 * therefore does not re-render per frame. `subscribeTrace` is both, for a
 * consumer (P4's imperative class toggler) that genuinely reacts to each trace.
 *
 * ⚠ A THIRD, one-consumer channel: `subscribeTraceFocus` / `takeTraceFocus`
 * (P8 — "show that node on the canvas"). It carries an EVENT, not state, and is
 * deliberately not a session field; see the CANVAS FOCUS block below.
 *
 * ⚠ THE STORE IS PURE STATE. It posts no worker message and compiles nothing:
 * `SimulatorView` owns the worker and calls a setter here in the same statement
 * block as its post, the mirror-invariant discipline `overseerRunning` uses.
 *
 * WHAT IS WHERE
 *   `target`       one element per graph kind (a cell index, an agent slot id).
 *   `origin`       per graph kind, the lowered-id → user-node table from the
 *                  TRACE BUILD's compile (`CompileResult.trace.origin`).
 *   `timeline`     a ring of the last 40 replies, oldest → newest.
 *   selection      `pinnedId` (the user picked an older entry) beats the
 *                  AUTO-FOLLOWED newest rule trace PER GRAPH KIND, so a
 *                  grid+agents model does not flip the graph pane between the
 *                  two every frame.
 *   `cursor`       null = the whole trace; else an index into the selected
 *                  entry's FLOW events (`f` records) — "step node".
 *   breakpoints    keyed `graphKind|macroPath|nodeId`, where `macroPath` is the
 *                  editor's macro-DEF path (P4). The editor's scope stack names
 *                  DEFS, not instances — entering a macro edits the shared
 *                  definition — so a breakpoint set inside a def is a mark on
 *                  THAT NODE OF THAT DEF and arms in every instance of it. The
 *                  trace's own `macroPath` names INSTANCES, so matching runs
 *                  through `macroDefPath` (see `setMacroDefIndex`).
 *   `paused`       the last `traceBreak` (cleared when the run resumes).
 *   `lost`         the last `traceTargetLost` reason (a transient notice).
 */

import type { TraceOrigin, TraceOriginTable } from '../modeler/vpl/compiler/traceOrigin';
import { resolveTraceOrigin } from '../modeler/vpl/compiler/traceOrigin';
import type { TraceEvent, TraceValue, TraceWrite } from '../simulator/engine/traceRunner';
import { focusTargetForOrigin } from './traceGraphMap';
import type { TraceFocusTarget } from './traceGraphMap';
import type { TraceReplyMsg, TraceRootKey, TraceTarget, TraceApproximateTerm } from '../simulator/engine/traceProtocol';
import {
  TRACE_ROOT_AGENT_BEHAVIOUR, TRACE_ROOT_STEP,
} from '../simulator/engine/traceProtocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which rule graph a trace (or a breakpoint) belongs to. Deliberately the
 *  `ActiveGraphKind` vocabulary minus `overseer` — the Overseer never traces. */
export type TraceGraphKind = 'cells' | 'agents';

/** One reply, kept in the ring. `graphKind` is DERIVED from the root key once,
 *  here, so no consumer has to re-derive it (and they cannot disagree). */
export interface TraceEntry {
  /** Monotonic per session, assigned here — the stable key for selection and
   *  for React lists (the worker's `seq` restarts with a fresh worker). */
  id: number;
  seq: number;
  root: TraceRootKey;
  gen: number;
  target: TraceTarget;
  graphKind: TraceGraphKind;
  events: TraceEvent[];
  writes: TraceWrite[];
  /** RULE TRACE (P5) — the element's state AT the trace point, read beside the
   *  trace in the worker (`traceSnapshot`). The Values tab's `current` column;
   *  `writes` are its `next`. Absent when the target no longer resolves. */
  snapshot?: Record<string, number>;
  truncated: boolean;
  approximate: boolean;
  /** WHICH term made it approximate, straight off the wire (P7b / F6). The
   *  worker is the only side that can see the emitted text and the run's hash
   *  age; the panel owns the wording. Absent ⇒ fall back to the model-derived
   *  guess. */
  approximateReason?: TraceApproximateTerm;
  error?: string;
  receivedAt: number;
}

export interface BreakpointDef {
  graphKind: TraceGraphKind;
  /** Macro instance ids, outermost first. Empty ⇒ the top-level graph. */
  macroPath: string[];
  /** The USER node id (inside the macro DEF when `macroPath` is set). */
  nodeId: string;
  enabled: boolean;
}

export interface TracePause {
  root: TraceRootKey;
  gen: number;
  /** The LOWERED id the worker matched — resolve it through the origin table. */
  nodeId: string;
}

/** The SESSION snapshot — everything that is not per-trace. A stable object
 *  replaced only when one of its fields changes, so `useSyncExternalStore`
 *  consumers of the session channel re-render only on real session changes. */
export interface TraceSession {
  target: { cell: number | null; agent: number | null };
  breakpoints: ReadonlyMap<string, BreakpointDef>;
  paused: TracePause | null;
  lost: string | null;
  /** A `traceCompileErrors` reply — the trace build failed to eval. */
  traceError: string | null;
  /** The entry the user PINNED, or null while the newest trace is followed. */
  pinnedId: number | null;
  cursor: number | null;
  /** Bumped whenever an origin table is replaced (the tables themselves are
   *  plain objects read through `getTraceOrigin`, never copied into here). */
  originVersion: number;
}

/** True while anything is traced — the one test every consumer opens with. */
export function traceArmed(): boolean {
  return session.target.cell !== null || session.target.agent !== null;
}

/** Which graph a root key belongs to. The agent roots are exactly the ones the
 *  protocol prefixes `agent…`; everything else is a cell root. */
export function graphKindOfRoot(root: TraceRootKey): TraceGraphKind {
  return root.startsWith('agent') ? 'agents' : 'cells';
}

/** Is this root the graph's RULE root (the one the panel follows by default)?
 *  The init / periodic / mapping / division roots are events — interesting when
 *  they happen, but they must not steal the selection from the step trace. */
export function isRuleRoot(root: TraceRootKey): boolean {
  return root === TRACE_ROOT_STEP || root === TRACE_ROOT_AGENT_BEHAVIOUR;
}

export const TRACE_RING_SIZE = 40;

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

const EMPTY_ORIGIN: TraceOriginTable = {};

let session: TraceSession = {
  target: { cell: null, agent: null },
  breakpoints: new Map(),
  paused: null,
  lost: null,
  traceError: null,
  pinnedId: null,
  cursor: null,
  originVersion: 0,
};
let originTables: { cell: TraceOriginTable; agent: TraceOriginTable } = {
  cell: EMPTY_ORIGIN, agent: EMPTY_ORIGIN,
};
let timeline: TraceEntry[] = [];
/** The AUTO-FOLLOWED newest rule trace per graph kind (see the header). */
let autoSelected: { cells: number | null; agents: number | null } = { cells: null, agents: null };
let nextEntryId = 1;
/** The worker `seq` of the last accepted reply — out-of-order arrivals are
 *  dropped rather than shown over a newer trace. */
let lastSeq = -1;
/** One-shot: the next rule trace restarts the cursor at its first flow event
 *  (the `]`-past-the-end gesture, which steps a generation). */
let cursorRestartPending = false;

const sessionListeners = new Set<() => void>();
const timelineListeners = new Set<() => void>();

function notifySession(): void { sessionListeners.forEach(fn => fn()); }
function notifyTimeline(): void { timelineListeners.forEach(fn => fn()); }

/** Replace the session snapshot (one object per change — the identity IS the
 *  change signal for `useSyncExternalStore`). */
function patchSession(patch: Partial<TraceSession>): void {
  session = { ...session, ...patch };
  notifySession();
}

// --- subscriptions ---------------------------------------------------------

export function getTraceSession(): TraceSession { return session; }
export function subscribeTraceSession(fn: () => void): () => void {
  sessionListeners.add(fn);
  return () => { sessionListeners.delete(fn); };
}

/** The ring, oldest → newest. A NEW array identity on every push. */
export function getTraceTimeline(): readonly TraceEntry[] { return timeline; }
export function subscribeTraceTimeline(fn: () => void): () => void {
  timelineListeners.add(fn);
  return () => { timelineListeners.delete(fn); };
}

/** Both channels — for a consumer that reacts to EVERY change (P4's imperative
 *  highlighter: a new trace, a cursor step and a scope change all re-light). */
export function subscribeTrace(fn: () => void): () => void {
  sessionListeners.add(fn);
  timelineListeners.add(fn);
  return () => { sessionListeners.delete(fn); timelineListeners.delete(fn); };
}

/** The lowered-id → user-node table of one graph's TRACE BUILD. */
export function getTraceOrigin(kind: TraceGraphKind): TraceOriginTable {
  return kind === 'agents' ? originTables.agent : originTables.cell;
}

// ---------------------------------------------------------------------------
// The macro INSTANCE → DEF index (P4). See the `breakpoints` note in the header.
// ---------------------------------------------------------------------------

let macroDefOfInstance: ReadonlyMap<string, string> = new Map();

/** Published by `GraphEditor` from the model (every macro instance in the two
 *  top-level graphs and inside every def). Pure lookup data — it changes no
 *  session field and therefore notifies nobody. */
export function setMacroDefIndex(index: ReadonlyMap<string, string>): void {
  macroDefOfInstance = index;
}

/** Translate a trace's INSTANCE path into the editor's DEF path. An instance the
 *  index does not know falls back to itself, so with no index published this is
 *  the identity and every consumer behaves exactly as it did before P4. */
export function macroDefPath(instancePath: readonly string[]): string[] {
  if (instancePath.length === 0) return [];
  return instancePath.map(id => macroDefOfInstance.get(id) ?? id);
}

/** The one instance → def translation, as a function (the shape
 *  `focusTargetForOrigin` / `originInEditorScope` take). */
const defOf = (instanceId: string): string => macroDefOfInstance.get(instanceId) ?? instanceId;

// ---------------------------------------------------------------------------
// CANVAS FOCUS (P8) — the THIRD channel
// ---------------------------------------------------------------------------
/** ⚠ A THIRD, deliberately tiny channel, and NOT a session field.
 *
 * "Show me that node on the canvas" is an EVENT, not state: it happens once,
 * exactly one consumer (the graph editor) performs it, and re-performing it on
 * an unrelated re-render would yank the canvas out from under the user. Putting
 * it in the session snapshot would also re-render every `useSyncExternalStore`
 * session consumer (~300 breakpoint glyphs) for something none of them read.
 *
 * So: `requestTraceFocus` parks ONE request and notifies; the editor's single
 * subscriber calls `takeTraceFocus()`, which returns it and CLEARS it, so the
 * request is performed exactly once and a second subscriber (there is none, and
 * there must not be one) could not double-pan.
 *
 * The reasons are for the editor's own judgement and for the DEV hook — a
 * `'cursor'` step may decline to move a node that is already fully visible,
 * where a `'breakpoint'` jump always means "take me there".
 */
export type TraceFocusReason = 'cursor' | 'break' | 'breakpoint' | 'step';

export interface TraceFocusRequest extends TraceFocusTarget {
  graphKind: TraceGraphKind;
  reason: TraceFocusReason;
  /** Monotonic — the editor logs it, and a DEV probe can tell two identical
   *  requests apart. */
  seq: number;
}

let pendingFocus: TraceFocusRequest | null = null;
let focusSeq = 0;
const focusListeners = new Set<() => void>();

export function subscribeTraceFocus(fn: () => void): () => void {
  focusListeners.add(fn);
  return () => { focusListeners.delete(fn); };
}

/** Ask the graph editor to show a node. State-free: the request lives only until
 *  it is taken. */
export function requestTraceFocus(req: Omit<TraceFocusRequest, 'seq'>): void {
  pendingFocus = { ...req, macroPath: [...req.macroPath], seq: ++focusSeq };
  focusListeners.forEach(fn => fn());
}

/** Take the pending request (and clear it). */
export function takeTraceFocus(): TraceFocusRequest | null {
  const req = pendingFocus;
  pendingFocus = null;
  return req;
}

/** The focus target one LOWERED record id names — the node the user placed, plus
 *  the macro DEF path that has to be open for it to be on the canvas. `null`
 *  for a synthesized linked-mapping colour pass, which has no user node. */
export function focusTargetForLoweredId(
  loweredId: string, kind: TraceGraphKind,
): TraceFocusTarget | null {
  return focusTargetForOrigin(resolveRecordOrigin(loweredId, kind), defOf);
}

/** THE ONE PLACE a cursor move asks for focus. Every caller of `setCursor` /
 *  `stepCursor` that hands over its entry gets the pan for free — the `]` / `[`
 *  keys, the panel's Back / Step node buttons and a Steps-tab row click are all
 *  the same gesture ("put the cursor here"), and each of them wiring its own
 *  focus call is exactly how the three would drift apart. */
function requestFocusForCursor(
  entry: TraceEntry | null | undefined, cursor: number | null, reason: TraceFocusReason,
): void {
  if (!entry || cursor === null) return;
  const idx = cursorEventIndex(entry, cursor);
  if (idx === null) return;
  const ev = entry.events[idx];
  if (!ev) return;
  const target = focusTargetForLoweredId(ev[1], entry.graphKind);
  if (target) requestTraceFocus({ graphKind: entry.graphKind, ...target, reason });
}

/** The CURSOR index (an index into `flowEvents`) whose flow record carries this
 *  lowered id — where a breakpoint hit lands the cursor. `null` when the id has
 *  no flow record at all, which is the honest answer for a breakpoint on a pure
 *  VALUE node (matched on its `v` record; the cursor only walks flow). */
export function flowIndexOfLoweredId(entry: TraceEntry, loweredId: string): number | null {
  const flow = flowEvents(entry);
  for (let i = 0; i < flow.length; i++) {
    if (entry.events[flow[i]!]![1] === loweredId) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------

/** Point the trace at one element of one graph (null clears that kind).
 *  ⚠ State only — the caller posts `setTrace` in the same statement block. */
export function setTraceTarget(kind: TraceGraphKind, id: number | null): void {
  const key = kind === 'agents' ? 'agent' : 'cell';
  if (session.target[key] === id) return;
  patchSession({
    target: { ...session.target, [key]: id },
    // A new target makes the previous "lost" notice meaningless, and the pause
    // belonged to the element that is no longer watched.
    lost: null,
    ...(id === null ? {} : { paused: null }),
  });
}

/** Drop the whole session: both targets, the timeline, the selection, the
 *  cursor and the pause. Breakpoints SURVIVE (they are the user's marks on the
 *  graph, and the graph is still the same graph) unless `alsoBreakpoints`. */
export function clearTrace(alsoBreakpoints = false): void {
  timeline = [];
  autoSelected = { cells: null, agents: null };
  lastSeq = -1;
  cursorRestartPending = false;
  originTables = { cell: EMPTY_ORIGIN, agent: EMPTY_ORIGIN };
  patchSession({
    target: { cell: null, agent: null },
    paused: null, lost: null, traceError: null,
    pinnedId: null, cursor: null,
    originVersion: session.originVersion + 1,
    ...(alsoBreakpoints ? { breakpoints: new Map() } : {}),
  });
  notifyTimeline();
}

/** A fresh worker restarts its `seq` at 1 — accept the next reply whatever it
 *  says. Called from the full-reinit arm of the model effect. */
export function resetTraceSeq(): void { lastSeq = -1; }

/** Publish one graph's origin table (from `compileGraph(…, { trace: true })`). */
export function setTraceOrigin(kind: TraceGraphKind, table: TraceOriginTable | undefined): void {
  const next = table ?? EMPTY_ORIGIN;
  const key = kind === 'agents' ? 'agent' : 'cell';
  if (originTables[key] === next) return;
  originTables = { ...originTables, [key]: next };
  patchSession({ originVersion: session.originVersion + 1 });
}

/** File one `trace` reply. Drops an out-of-order arrival (the worker's `seq` is
 *  monotonic per worker; a big backward jump is a fresh worker, not disorder). */
export function pushTrace(msg: TraceReplyMsg): void {
  // A reply can land AFTER the session was dropped (a `clearTrace` post does not
  // recall the messages already in flight — measured: 2 arrivals after leaving
  // Live). Filing those would leave a timeline with no target behind it, which
  // the next session would briefly show as its own.
  if (session.target.cell === null && session.target.agent === null) return;
  const seq = msg.seq;
  if (seq <= lastSeq && lastSeq - seq < 1000) return;
  lastSeq = seq;
  const kind = graphKindOfRoot(msg.root);
  const entry: TraceEntry = {
    id: nextEntryId++,
    seq,
    root: msg.root,
    gen: msg.gen,
    target: msg.target,
    graphKind: kind,
    events: msg.events as TraceEvent[],
    writes: msg.writes as TraceWrite[],
    ...(msg.snapshot !== undefined ? { snapshot: msg.snapshot } : {}),
    truncated: msg.truncated,
    approximate: msg.approximate,
    ...(msg.approximateReason !== undefined ? { approximateReason: msg.approximateReason } : {}),
    ...(msg.error !== undefined ? { error: msg.error } : {}),
    receivedAt: performance.now(),
  };
  timeline = timeline.length >= TRACE_RING_SIZE
    ? [...timeline.slice(timeline.length - TRACE_RING_SIZE + 1), entry]
    : [...timeline, entry];
  if (isRuleRoot(entry.root)) {
    autoSelected = { ...autoSelected, [kind]: entry.id };
    if (cursorRestartPending) {
      cursorRestartPending = false;
      // Session change — notify that channel too (the cursor moved).
      patchSession({ cursor: 0 });
      // …and the canvas follows it, exactly as an ordinary `]` does — this IS
      // the second half of one `]` press (P8). The ONLY per-trace focus request
      // there is, and it is gated behind a one-shot the user has to arm.
      requestFocusForCursor(entry, 0, 'step');
    }
  }
  notifyTimeline();
}

/** PIN an older entry (the user clicked the timeline). `null` releases the pin
 *  and the newest rule trace of each kind is followed again. */
export function selectTrace(id: number | null): void {
  if (session.pinnedId === id) return;
  patchSession({ pinnedId: id, cursor: null });
}
export function pinSelection(id: number): void { selectTrace(id); }
export function unpin(): void { selectTrace(null); }

/** The entry the graph should show for one kind: the PIN (when it belongs to
 *  that kind) else the newest rule trace of that kind. */
export function selectedEntry(kind: TraceGraphKind): TraceEntry | null {
  if (session.pinnedId !== null) {
    const pinned = timeline.find(e => e.id === session.pinnedId);
    if (pinned && pinned.graphKind === kind) return pinned;
    if (pinned) return null;      // pinned to the OTHER graph — show nothing here
  }
  const auto = autoSelected[kind];
  return auto === null ? null : (timeline.find(e => e.id === auto) ?? null);
}

/** `null` = the whole trace; otherwise an index into the entry's FLOW events.
 *
 *  ⚠ Pass `entry` whenever the caller has it: that is what makes the CANVAS
 *  FOLLOW the cursor (P8). The focus request is issued here, before the
 *  equality guard, so re-selecting the node the cursor is already on still
 *  brings it back on screen — the gesture means "show me this one" either way.
 *  A cursor of `null` (Whole trace) asks for no focus: it names no node. */
export function setCursor(i: number | null, entry?: TraceEntry | null): void {
  if (i !== null && entry) requestFocusForCursor(entry, i, 'cursor');
  if (session.cursor === i) return;
  patchSession({ cursor: i });
}

/** Step the cursor by ±1 over `entry`'s flow events.
 *  Returns FALSE when it could not move (already at an end) so the caller can
 *  decide what the gesture means there — `]` past the end steps a generation,
 *  `[` before the start goes back to the whole trace. */
export function stepCursor(delta: 1 | -1, entry: TraceEntry | null): boolean {
  const n = entry ? flowEvents(entry).length : 0;
  if (n === 0) return false;
  const cur = session.cursor;
  if (delta === 1) {
    const next = cur === null ? 0 : cur + 1;
    if (next >= n) return false;
    setCursor(next, entry);
    return true;
  }
  if (cur === null) return false;
  if (cur <= 0) { setCursor(null); return true; }
  setCursor(cur - 1, entry);
  return true;
}

/** One-shot: the NEXT rule trace starts the cursor at its first flow event.
 *  Set by the `]`-past-the-end gesture, which also steps one generation. */
export function requestCursorRestart(): void { cursorRestartPending = true; }

// --- breakpoints -----------------------------------------------------------

export function breakpointKey(kind: TraceGraphKind, macroPath: readonly string[], nodeId: string): string {
  return `${kind}|${macroPath.join('/')}|${nodeId}`;
}

export function toggleBreakpoint(def: Omit<BreakpointDef, 'enabled'>): void {
  const key = breakpointKey(def.graphKind, def.macroPath, def.nodeId);
  const next = new Map(session.breakpoints);
  if (next.has(key)) next.delete(key);
  else next.set(key, { ...def, macroPath: [...def.macroPath], enabled: true });
  patchSession({ breakpoints: next });
}

export function setBreakpointEnabled(key: string, enabled: boolean): void {
  const cur = session.breakpoints.get(key);
  if (!cur || cur.enabled === enabled) return;
  const next = new Map(session.breakpoints);
  next.set(key, { ...cur, enabled });
  patchSession({ breakpoints: next });
}

export function removeBreakpoint(key: string): void {
  if (!session.breakpoints.has(key)) return;
  const next = new Map(session.breakpoints);
  next.delete(key);
  patchSession({ breakpoints: next });
}

export function clearBreakpoints(graphKind?: TraceGraphKind): void {
  if (session.breakpoints.size === 0) return;
  const next = new Map<string, BreakpointDef>();
  if (graphKind) {
    for (const [k, v] of session.breakpoints) if (v.graphKind !== graphKind) next.set(k, v);
    if (next.size === session.breakpoints.size) return;
  }
  patchSession({ breakpoints: next });
}

export function hasBreakpoint(kind: TraceGraphKind, macroPath: readonly string[], nodeId: string): BreakpointDef | undefined {
  return session.breakpoints.get(breakpointKey(kind, macroPath, nodeId));
}

/** THE LOWERED ids one graph's ENABLED breakpoints stand for — what `setTrace`
 *  ships (the worker only ever does set membership; the main thread owns the
 *  origin table).
 *
 *  A user node can lower into SEVERAL nodes (composite components, multi-attr
 *  slots, a macro expanded twice), so every id whose origin resolves onto the
 *  breakpoint's `(nodeId, macroPath)` is included. A top-level user node that
 *  was never lowered records under its OWN id and has no table entry at all, so
 *  that id is included too — but only for a root-scope breakpoint, where the id
 *  really is the emitted one. */
export function breakpointLoweredIds(kind: TraceGraphKind): string[] {
  const out = new Set<string>();
  const table = getTraceOrigin(kind);
  const wanted: BreakpointDef[] = [];
  for (const bp of session.breakpoints.values()) {
    if (bp.graphKind === kind && bp.enabled) wanted.push(bp);
  }
  if (wanted.length === 0) return [];
  for (const bp of wanted) if (bp.macroPath.length === 0) out.add(bp.nodeId);
  for (const loweredId of Object.keys(table)) {
    const o = resolveTraceOrigin(loweredId, table);
    // The record's path names macro INSTANCES; a breakpoint's names macro DEFS
    // (the editor's scope stack). Compare in DEF space — see the header.
    const path = macroDefPath(o.macroPath ?? []);
    for (const bp of wanted) {
      if (o.nodeId !== bp.nodeId) continue;
      if (path.length !== bp.macroPath.length) continue;
      let same = true;
      for (let i = 0; i < path.length; i++) if (path[i] !== bp.macroPath[i]) { same = false; break; }
      if (same) { out.add(loweredId); break; }
    }
  }
  return [...out];
}

/** Is any ENABLED breakpoint armed for a graph whose target is set? That is
 *  exactly the condition for the worker's EVERY-GENERATION cadence. */
export function traceEveryGenWanted(): boolean {
  for (const bp of session.breakpoints.values()) {
    if (!bp.enabled) continue;
    if (bp.graphKind === 'cells' && session.target.cell !== null) return true;
    if (bp.graphKind === 'agents' && session.target.agent !== null) return true;
  }
  return false;
}

// --- pause / loss ----------------------------------------------------------

export function setPaused(p: TracePause | null): void {
  if (session.paused === p) return;
  patchSession({ paused: p });
  if (!p) return;
  // A BREAKPOINT HIT LANDS THE CURSOR ON THE NODE, and the canvas follows it
  // (P8). The Help chapter has always said the trace "lands with the cursor on
  // the node" — until now it did not, so `]` after a break resumed from the
  // ROOT rather than from the mark the user set.
  //
  // ⚠ The `trace` reply for this generation was posted by the worker BEFORE the
  // `traceBreak` (`traceRootSync` posts, then returns the hit), so the entry is
  // already in the ring when this runs. It is still guarded on the generation:
  // with an older trace PINNED, `selectedEntry` answers the pin, whose flow
  // events are a different run and whose indices mean nothing here.
  const kind = graphKindOfRoot(p.root);
  const entry = selectedEntry(kind);
  if (entry && entry.gen === p.gen) {
    const flowIdx = flowIndexOfLoweredId(entry, p.nodeId);
    // The cursor trigger issues the focus request — ONE request, not two.
    if (flowIdx !== null) { setCursor(flowIdx, entry); return; }
  }
  // No flow record for it: a breakpoint on a pure VALUE node (matched on its
  // `v` record), or a pinned / missing entry. Focus it directly.
  const target = focusTargetForLoweredId(p.nodeId, kind);
  if (target) requestTraceFocus({ graphKind: kind, ...target, reason: 'break' });
}

export function setLost(reason: string | null): void {
  if (session.lost === reason) return;
  patchSession({ lost: reason });
}

export function setTraceError(message: string | null): void {
  if (session.traceError === message) return;
  patchSession({ traceError: message });
}

// ---------------------------------------------------------------------------
// SELECTORS — memoised PER ENTRY, because P4 calls them per frame
// ---------------------------------------------------------------------------

interface EntryCache {
  flow?: number[];
  records: Map<number, Map<string, Map<string, TraceValue>>>;
  executed: Map<number, Set<string>>;
  taken: Map<number, Set<string>>;
}
const entryCache = new WeakMap<TraceEntry, EntryCache>();
function cacheOf(entry: TraceEntry): EntryCache {
  let c = entryCache.get(entry);
  if (!c) { c = { records: new Map(), executed: new Map(), taken: new Map() }; entryCache.set(entry, c); }
  return c;
}
/** `null` (the whole trace) is cached under this key — a real event index is
 *  never negative. */
const WHOLE = -1;
const keyOf = (eventIdx: number | null): number => (eventIdx === null ? WHOLE : eventIdx);
const limitOf = (entry: TraceEntry, eventIdx: number | null): number =>
  (eventIdx === null ? entry.events.length - 1 : Math.min(eventIdx, entry.events.length - 1));

/** The event-log indices of this entry's FLOW (`f`) records, in order. The
 *  cursor indexes THIS array — "step node" walks the executed flow nodes. */
export function flowEvents(entry: TraceEntry): number[] {
  const c = cacheOf(entry);
  if (c.flow) return c.flow;
  const out: number[] = [];
  for (let i = 0; i < entry.events.length; i++) if (entry.events[i]![0] === 'f') out.push(i);
  c.flow = out;
  return out;
}

/** The event index the cursor points at (null ⇒ the whole trace). */
export function cursorEventIndex(entry: TraceEntry, cursor: number | null): number | null {
  if (cursor === null) return null;
  const f = flowEvents(entry);
  if (f.length === 0) return null;
  return f[Math.max(0, Math.min(cursor, f.length - 1))]!;
}

/** loweredId → (portId → the LATEST value recorded at or before `eventIdx`).
 *  Latest, not first: a node inside a loop records once per iteration, and what
 *  the cursor is standing on is the value that iteration produced. */
export function latestRecordsUpTo(
  entry: TraceEntry, eventIdx: number | null,
): Map<string, Map<string, TraceValue>> {
  const c = cacheOf(entry);
  const k = keyOf(eventIdx);
  const hit = c.records.get(k);
  if (hit) return hit;
  const out = new Map<string, Map<string, TraceValue>>();
  const end = limitOf(entry, eventIdx);
  for (let i = 0; i <= end; i++) {
    const e = entry.events[i]!;
    if (e[0] !== 'v') continue;
    let ports = out.get(e[1]);
    if (!ports) { ports = new Map(); out.set(e[1], ports); }
    ports.set(e[2], e[3]);
  }
  c.records.set(k, out);
  return out;
}

/** Every LOWERED id that produced a record at or before `eventIdx` — value and
 *  flow alike, so a pure value node lights as readily as an action. */
export function executedNodeIds(entry: TraceEntry, eventIdx: number | null): Set<string> {
  const c = cacheOf(entry);
  const k = keyOf(eventIdx);
  const hit = c.executed.get(k);
  if (hit) return hit;
  const out = new Set<string>();
  const end = limitOf(entry, eventIdx);
  for (let i = 0; i <= end; i++) {
    const e = entry.events[i]!;
    if (e[0] === 'v' || e[0] === 'f' || e[0] === 'o') out.add(e[1]);
  }
  c.executed.set(k, out);
  return out;
}

/** The flow OUTPUT ports taken at or before `eventIdx`, as `nodeId:port` — the
 *  set P4 lights the taken wire from (a Switch's one live case, an If's `then`). */
export function takenFlowPorts(entry: TraceEntry, eventIdx: number | null): Set<string> {
  const c = cacheOf(entry);
  const k = keyOf(eventIdx);
  const hit = c.taken.get(k);
  if (hit) return hit;
  const out = new Set<string>();
  const end = limitOf(entry, eventIdx);
  for (let i = 0; i <= end; i++) {
    const e = entry.events[i]!;
    if (e[0] === 'o') out.add(`${e[1]}:${e[2]}`);
  }
  c.taken.set(k, out);
  return out;
}

// (P7b / review finding F9: `resolveForGraph` — a one-line wrapper round
//  `getTraceOrigin` — was exported and never called. `resolveRecordOrigin` below
//  is the resolver every consumer actually imports, and it already applies the
//  rule that wrapper documented: an entry resolves against ITS OWN graph's
//  table, never the open editor tab's.)

/** Resolve one recorded id to its user node (a thin re-export so P4/P5 import
 *  the resolver from the store they already import). */
export function resolveRecordOrigin(loweredId: string, kind: TraceGraphKind): TraceOrigin {
  return resolveTraceOrigin(loweredId, getTraceOrigin(kind));
}

// ---------------------------------------------------------------------------
// DEV hook (the project's `window.__*` convention) — the trace is otherwise
// invisible to a driven browser: its state lives in a module global and its
// consumers render nothing until P4.
// ---------------------------------------------------------------------------
if (import.meta.env.DEV) {
  (globalThis as unknown as { __traceState?: () => unknown }).__traceState = () => ({
    target: session.target,
    timeline: timeline.map(e => ({
      id: e.id, seq: e.seq, root: e.root, gen: e.gen, graphKind: e.graphKind,
      events: e.events.length, writes: e.writes.length,
      truncated: e.truncated, approximate: e.approximate, error: e.error,
    })),
    selected: { cells: selectedEntry('cells')?.id ?? null, agents: selectedEntry('agents')?.id ?? null },
    pinnedId: session.pinnedId,
    cursor: session.cursor,
    paused: session.paused,
    lost: session.lost,
    traceError: session.traceError,
    breakpoints: [...session.breakpoints.entries()].map(([k, v]) => ({ key: k, ...v })),
    everyGenWanted: traceEveryGenWanted(),
    loweredIds: { cells: breakpointLoweredIds('cells'), agents: breakpointLoweredIds('agents') },
    originCounts: {
      cells: Object.keys(originTables.cell).length,
      agents: Object.keys(originTables.agent).length,
    },
    originVersion: session.originVersion,
  });
  (globalThis as unknown as { __traceStore?: unknown }).__traceStore = {
    toggleBreakpoint, setBreakpointEnabled, removeBreakpoint, clearBreakpoints,
    selectTrace, setCursor, stepCursor, selectedEntry, flowEvents,
    executedNodeIds, takenFlowPorts, latestRecordsUpTo, breakpointLoweredIds,
    // P8 — drive a focus request from a probe (the editor's own performer is
    // observable through `window.__traceFocus()`).
    requestTraceFocus, focusTargetForLoweredId, flowIndexOfLoweredId,
  };
}
