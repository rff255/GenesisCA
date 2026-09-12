/** RULE TRACE (P5) — THE TRACE PANEL: the bottom drawer of the graph pane.
 *
 * The IDE debugger convention, and decision D7: a drawer along the bottom of
 * `.graphArea` rather than a left ActivityBar tab (Live closes those by policy,
 * so the panel would be one click away from the graph it annotates) or a
 * floating popover (too small for a values table). It is mounted ONLY while a
 * trace target exists and only in LIVE — doctrine HIDE on both counts: with no
 * target there is nothing to show and an empty drawer would steal height from
 * the graph, and outside Live the graph is not on screen at all.
 *
 * ⚠ `role="region"`, NEVER `role="dialog"` or `role="menu"`. `overlayOwnsKeyboard()`
 * probes the DOM for those two roles and stands the GLOBAL keys down for as long
 * as one is present — and this panel is present for the whole tracing session,
 * so either role would silently disable `Enter` (play/pause), `Space`, `]` and
 * `[` for the entire time the user is debugging. The `role="tablist"` on the tab
 * strip is deliberately NOT one of the two probed roles.
 *
 * ⚠ NO BUTTON HERE KEEPS FOCUS ON A MOUSE PRESS. In Live, `Enter` is the global
 * play/pause; a focused `<button>` also activates on `Enter`, so a user who
 * clicks Pause and then presses `Enter` would toggle play TWICE (once from the
 * button's own activation, once from the global handler) if the button held
 * focus. Every control is built through `<TraceBtn>`, whose `onMouseDown`
 * preventDefault leaves focus where it was; keyboard users still reach and
 * activate them by Tab, which is the case where one activation is correct.
 *
 * ⚠ IT SUBSCRIBES TO THE TIMELINE CHANNEL, which fires on every trace (~30/s).
 * That is unavoidable — the panel's whole job is to show every trace — so the
 * cost is controlled instead: the two expensive derivations (the values rows and
 * the steps list) are memoised per ENTRY ID, the cursor only re-renders a
 * highlight class, and nothing here touches React Flow.
 *
 * WHAT LIVES WHERE: the numbers-to-sentences logic is in the DOM-free
 * `traceValues.ts` (harness § J drives the shipped functions); this file is the
 * React, the layout, the drag and the doctrine.
 */

import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore, type ReactNode,
} from 'react';
import { useModel } from '../model/ModelContext';
import type { CAModel, Attribute, GraphNode } from '../model/types';
import { typeDisplayName } from '../model/typeLabels';
import { getNodeDef } from '../modeler/vpl/nodes/registry';
import { subscribeActiveGraphKind, getActiveGraphKind } from '../modeler/vpl/graphState';
import { getEffectivePorts } from '../modeler/vpl/effectivePorts';
import { bondReqSlotsForModel } from '../modeler/vpl/compiler/bondRequestQueue';
import { cellFieldAttrsOf, agentAttrsOf } from '../model/attributeScope';
import {
  simTransportApi, subscribeSimPlaying, getSimPlaying,
} from '../simulator/simTransportState';
import {
  getTraceSession, subscribeTraceSession, getTraceTimeline, subscribeTraceTimeline,
  selectedEntry, pinSelection, unpin, setCursor, stepCursor, flowEvents,
  resolveRecordOrigin, macroDefPath, setBreakpointEnabled, removeBreakpoint,
  clearBreakpoints,
} from './traceState';
import type { TraceEntry, TraceGraphKind } from './traceState';
import type { TraceValue } from '../simulator/engine/traceRunner';
import { formatTraceValue } from './TraceTooltip';
import type { TracePortRecord } from './TraceTooltip';
import {
  buildTraceRows, traceChipLabel, traceRootLabel, traceTargetLabel, isResetRoot,
  formatNumber, formatNI, approximateReason,
} from './traceValues';
import type { TraceRow, TraceRowValue, TraceAttrSpec, TraceGridDims } from './traceValues';
import styles from './TracePanel.module.css';

// ---------------------------------------------------------------------------
// Persistence — its OWN key (`genesisca_sim_settings` belongs to SimulatorView's
// persist effect, and a drawer in the MODELER has no business in it).
// ---------------------------------------------------------------------------

const STORE_KEY = 'genesisca_trace_panel';
const DEFAULT_H = 220;
const MIN_H = 120;
const COLLAPSED_H = 24;

type TabId = 'values' | 'steps' | 'breakpoints';

interface PanelPrefs { h: number; collapsed: boolean; tab: TabId }

function readPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PanelPrefs>;
      return {
        h: typeof p.h === 'number' && p.h >= MIN_H ? p.h : DEFAULT_H,
        collapsed: !!p.collapsed,
        tab: p.tab === 'steps' || p.tab === 'breakpoints' ? p.tab : 'values',
      };
    }
  } catch { /* a private window / blocked storage — the defaults are correct */ }
  return { h: DEFAULT_H, collapsed: false, tab: 'values' };
}

function writePrefs(p: PanelPrefs): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* see readPrefs */ }
}

// ---------------------------------------------------------------------------
// Model lookups — one place that knows how to find a user node in ANY graph
// ---------------------------------------------------------------------------

/** Every node list a record can resolve into: the two top-level graphs plus
 *  every macro DEF's own subgraph (a macro-scoped origin names a node inside a
 *  def, which lives in none of the top-level lists). The P3 chip's own rule. */
function allNodeLists(model: CAModel): GraphNode[][] {
  const lists: GraphNode[][] = [
    (model.graphNodes || []) as GraphNode[],
    (model.agentGraphNodes || []) as GraphNode[],
  ];
  for (const def of model.macroDefs || []) lists.push((def.nodes || []) as GraphNode[]);
  return lists;
}

function findNode(model: CAModel, id: string): GraphNode | undefined {
  for (const nodes of allNodeLists(model)) {
    const n = nodes.find(nn => nn.id === id);
    if (n) return n;
  }
  return undefined;
}

/** A user node's display name: its own label, else the node TYPE's label (the
 *  agent spelling when the node belongs to the agent graph), else the raw id.
 *
 *  ⚠ The kind is passed IN rather than read from `getActiveGraphKind()`. The
 *  shipped `displayNodeLabel` reads that module global, and a readout must not
 *  re-word itself because the user switched sub-tabs — the P3 pause chip's own
 *  rule, applied to every label this panel prints. */
function labelOfNode(n: GraphNode | undefined, fallbackId: string, kind: TraceGraphKind): string {
  if (!n) return fallbackId;
  const userLabel = (n.data as { label?: string } | undefined)?.label;
  if (userLabel) return userLabel;
  const def = getNodeDef((n.data as { nodeType?: string } | undefined)?.nodeType ?? '');
  if (!def) return fallbackId;
  return (kind === 'agents' && def.agentLabel) ? def.agentLabel : def.label;
}

function nodeLabel(model: CAModel, id: string, kind: TraceGraphKind): string {
  return labelOfNode(findNode(model, id), id, kind);
}

/** Resolve a LOWERED id to `{ label, macroName }`. The macro name is the DEF's,
 *  because that is the name the user sees on the editor's scope breadcrumb. */
function resolveLabel(
  model: CAModel, loweredId: string, kind: TraceGraphKind,
): { label: string; macroName?: string; nodeId: string; portId?: string } {
  const o = resolveRecordOrigin(loweredId, kind);
  if (o.nodeId.startsWith('linked:')) return { label: 'a linked colour pass', nodeId: o.nodeId };
  const defPath = macroDefPath(o.macroPath ?? []);
  const defId = defPath.length > 0 ? defPath[defPath.length - 1] : undefined;
  const macroName = defId ? (model.macroDefs || []).find(d => d.id === defId)?.name : undefined;
  return {
    label: nodeLabel(model, o.nodeId, kind),
    ...(macroName ? { macroName } : {}),
    nodeId: o.nodeId,
    ...(o.portId ? { portId: o.portId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Value rendering — the NUMBERS come from `traceValues`, the WORDS from here
// ---------------------------------------------------------------------------

function hex(rgb: readonly number[]): string {
  const c = (v: number) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0');
  return '#' + c(rgb[0] ?? 0) + c(rgb[1] ?? 0) + c(rgb[2] ?? 0);
}

/** Decode one attribute value through its DECLARED type — the reason `alive`
 *  reads `true` and a state tag reads its option name instead of an index. */
function decodeAttr(v: number, attr: Attribute | undefined, is3d: boolean): string {
  if (!attr) return formatNumber(v);
  switch (attr.type) {
    case 'bool': return v ? 'true' : 'false';
    case 'integer': return String(v | 0);
    case 'tag': {
      const opts = attr.tagOptions || [];
      const i = v | 0;
      return (i >= 0 && i < opts.length) ? opts[i]! : `(${i})`;
    }
    case 'neighborIndex': return formatNI(v, is3d);
    default: return formatNumber(v);
  }
}

function renderValue(
  val: TraceRowValue | undefined, attrsById: Map<string, Attribute>, is3d: boolean,
): string {
  if (!val) return '—';
  switch (val.kind) {
    case 'attr': return decodeAttr(val.v, attrsById.get(val.attrId), is3d);
    case 'number': return formatNumber(val.v);
    case 'vector': return `(${val.v.map(formatNumber).join(', ')})`;
    case 'hex': return hex(val.rgb);
    case 'text': return val.text;
  }
}

// ---------------------------------------------------------------------------
// The timeline chip — MEMOISED, and that is a measured requirement
// ---------------------------------------------------------------------------

/** entry → its chip text. An entry is immutable once filed, so its label can be
 *  computed once for the life of the entry instead of twice (text + title) on
 *  every one of the ~30 traces that arrive each second. */
const chipLabelCache = new WeakMap<TraceEntry, string>();
function chipLabelOf(entry: TraceEntry, names: Parameters<typeof traceChipLabel>[2]): string {
  const hit = chipLabelCache.get(entry);
  if (hit !== undefined) return hit;
  const label = traceChipLabel(entry.root, entry.gen, names);
  chipLabelCache.set(entry, label);
  return label;
}

/** ⚠ WHY THIS IS `memo`. The strip holds the whole ring — up to 40 chips — and a
 *  new trace replaces the timeline ARRAY on every arrival, so the parent
 *  re-renders ~30×/s. Without memo React reconciles all 40 buttons each time:
 *  measured at 7.5 ms per trace render on Particle Life, against a 3 ms budget.
 *  The props are deliberately primitives so the default shallow compare works,
 *  and the click handler is rebuilt from `id` INSIDE the chip rather than passed
 *  down (a fresh arrow per render would defeat the memo entirely). */
const TimelineChip = memo(function TimelineChip({
  id, label, selected, ghost,
}: { id: number; label: string; selected: boolean; ghost: boolean }) {
  return (
    <button
      type="button"
      className={`${styles.chip} ${selected ? styles.chipOn : ''} ${ghost ? styles.chipGhost : ''}`}
      title={`${label} — click to hold this trace`}
      onMouseDown={ev => ev.preventDefault()}
      onClick={() => pinSelection(id)}
    >{label}</button>
  );
});

// ---------------------------------------------------------------------------
// A transport button. See the module header for why focus is refused on mouse.
// ---------------------------------------------------------------------------

function TraceBtn({
  glyph, title, onClick, disabled, wide,
}: {
  glyph: ReactNode; title: string; onClick: () => void; disabled?: boolean; wide?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.btn} ${wide ? styles.btnWide : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
    >{glyph}</button>
  );
}

// ---------------------------------------------------------------------------

/** DEV render meter — the project's `window.__*` convention (P4's
 *  `__tracePerf` for the graph highlighter, this one for the panel). A trace
 *  arrives ~30×/s, so "how long does one panel render take" is the number that
 *  decides whether this drawer is affordable, and inferring it from simulation
 *  throughput is far too noisy to act on. */
const panelPerf = { n: 0, body: 0, bodyMax: 0, commit: 0, commitMax: 0 };
if (import.meta.env.DEV) {
  (globalThis as unknown as { __tracePanelPerf?: () => unknown }).__tracePanelPerf = () => ({
    renders: panelPerf.n,
    // The panel's OWN work: derivations + element creation.
    bodyMeanMs: panelPerf.n ? +(panelPerf.body / panelPerf.n).toFixed(3) : 0,
    bodyMaxMs: +panelPerf.bodyMax.toFixed(3),
    // Render start → after the COMMIT. An upper bound only: the layout effect
    // runs after the whole root's commit, so anything else that updated in the
    // same batch (in Live, the simulator's own per-frame readouts) is inside it.
    commitMeanMs: panelPerf.n ? +(panelPerf.commit / panelPerf.n).toFixed(3) : 0,
    commitMaxMs: +panelPerf.commitMax.toFixed(3),
    reset: () => { panelPerf.n = 0; panelPerf.body = 0; panelPerf.bodyMax = 0; panelPerf.commit = 0; panelPerf.commitMax = 0; },
  });
}

export function TracePanel() {
  const renderStart = performance.now();
  const { model } = useModel();
  const session = useSyncExternalStore(subscribeTraceSession, getTraceSession);
  const timeline = useSyncExternalStore(subscribeTraceTimeline, getTraceTimeline);
  const playing = useSyncExternalStore(subscribeSimPlaying, getSimPlaying);
  const activeGraph = useSyncExternalStore(subscribeActiveGraphKind, getActiveGraphKind);

  const [prefs, setPrefs] = useState<PanelPrefs>(readPrefs);
  // Render + commit cost of THIS panel, every render (see `panelPerf`).
  const bodyMsRef = useRef(0);
  useLayoutEffect(() => {
    const dt = performance.now() - renderStart;
    panelPerf.n++;
    panelPerf.commit += dt; if (dt > panelPerf.commitMax) panelPerf.commitMax = dt;
    panelPerf.body += bodyMsRef.current;
    if (bodyMsRef.current > panelPerf.bodyMax) panelPerf.bodyMax = bodyMsRef.current;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const armed = session.target.cell !== null || session.target.agent !== null;

  /** WHICH graph's traces this panel is showing. The editor's sub-tab decides
   *  (the user is looking at one graph, and P4 lights that one). The OVERSEER
   *  tab traces nothing at all, so the panel falls back to whichever kind is
   *  actually targeted rather than going blank on a tab that has no traces of
   *  its own to show. */
  const kind: TraceGraphKind = activeGraph === 'agents'
    ? 'agents'
    : activeGraph === 'cells'
      ? 'cells'
      : (session.target.cell !== null ? 'cells' : 'agents');

  const entry = armed ? selectedEntry(kind) : null;
  const flows = entry ? flowEvents(entry) : [];
  const cursor = session.cursor;

  /** IS THE PIN STILL REAL? The ring holds 40 entries, so a held trace is
   *  eventually EVICTED — and `selectedEntry` then falls back to following the
   *  newest, which is the right behaviour. But `pinnedId` stays set, so a
   *  condition written on it alone would keep offering "↧ follow newest" (and
   *  keep the strip from scrolling) while the panel is already following: a
   *  control claiming a state the app is not in, which is the doctrine failure
   *  this project names first. Both the button and the auto-scroll therefore ask
   *  whether the pinned entry is still IN the timeline. */
  const pinnedLive = session.pinnedId !== null
    && timeline.some(e => e.id === session.pinnedId);

  // --- persistence ---------------------------------------------------------
  const commitPrefs = useCallback((patch: Partial<PanelPrefs>) => {
    setPrefs(prev => { const next = { ...prev, ...patch }; writePrefs(next); return next; });
  }, []);

  // --- the drag handle -----------------------------------------------------
  // THE PANEL-RESIZE DISCIPLINE: mutate `style.height` during the drag (a React
  // state write per mousemove would re-render a values table 60×/s for no
  // visible gain) and COMMIT once on release.
  const onGripDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = panelRef.current;
    const pane = el?.parentElement;
    if (!el || !pane) return;
    const startY = e.clientY;
    const startH = el.offsetHeight;
    const maxH = Math.max(MIN_H, pane.clientHeight * 0.6);
    let last = startH;
    const onMove = (ev: MouseEvent) => {
      last = Math.max(MIN_H, Math.min(maxH, startH - (ev.clientY - startY)));
      el.style.height = last + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      commitPrefs({ h: last, collapsed: false });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [commitPrefs]);

  // --- the timeline strip follows the newest, unless the user pinned ------
  const lastId = timeline.length > 0 ? timeline[timeline.length - 1]!.id : 0;
  useEffect(() => {
    if (pinnedLive) return;                    // A3: a LIVE pin beats the auto-follow
    const el = stripRef.current;
    // ⚠ WRITE-ONLY, never `el.scrollLeft = el.scrollWidth`. Reading `scrollWidth`
    // forces a synchronous layout of a 40-chip flex row, and this runs on EVERY
    // trace (~30×/s). The browser clamps an over-large `scrollLeft` to the
    // maximum, so assigning a constant scrolls fully right for free.
    if (el) el.scrollLeft = 1e7;
  }, [lastId, pinnedLive, prefs.collapsed]);

  // --- derived model vocabulary (cheap; memoised against the model) -------
  const is3d = model.properties.dimension === '3d';
  const dims: TraceGridDims = useMemo(() => ({
    W: model.properties.gridWidth || 1,
    H: model.properties.gridHeight || 1,
    D: is3d ? (model.properties.gridDepth || 1) : 1,
  }), [model.properties.gridWidth, model.properties.gridHeight, model.properties.gridDepth, is3d]);

  const attrsById = useMemo(() => {
    const m = new Map<string, Attribute>();
    for (const a of model.attributes || []) m.set(a.id, a);
    for (const a of agentAttrsOf(model) || []) m.set(a.id, a);
    return m;
  }, [model]);

  const rootNames = useMemo(() => ({
    mapping: (id: string) => (model.mappings || []).find(m => m.id === id)?.name,
    agentMapping: (id: string) => (model.agentMappings || []).find(m => m.id === id)?.name,
    periodicNode: (id: string) => {
      const n = findNode(model, id);
      const label = (n?.data as { label?: string } | undefined)?.label;
      return label || undefined;
    },
  }), [model]);

  // --- the Values rows, memoised PER ENTRY and PER TAB --------------------
  // ⚠ GATED ON THE VISIBLE TAB, and that is a measured requirement rather than
  // tidiness: a trace lands ~30×/s, so deriving the rows for a tab nobody is
  // looking at pays the whole cost for nothing (measured on Particle Life:
  // computing both derivations unconditionally cost 4.87 ms per generation
  // against 1.56 ms with this gate).
  const rows = useMemo<TraceRow[]>(() => {
    if (!entry || prefs.tab !== 'values') return [];
    const attrSpecs: TraceAttrSpec[] = kind === 'agents'
      ? (agentAttrsOf(model) || []).map(a => ({ id: a.id, name: a.name, type: a.type, ...(a.vectorDims ? { vectorDims: a.vectorDims } : {}) }))
      : (model.attributes || []).filter(a => !a.isModelAttribute)
        .map(a => ({ id: a.id, name: a.name, type: a.type, ...(a.vectorDims ? { vectorDims: a.vectorDims } : {}) }));
    // The Stop Event message: the flag holds a 1-based index into a list built
    // AFTER macro expansion, which the main thread does not have — so it is
    // resolved from the `stopEvent` node this trace actually EXECUTED, which is
    // exact and needs no index bookkeeping at all.
    //
    // ⚠ GUARDED ON THE WRITE. This walk resolves an origin per event, and an
    // agent trace carries hundreds; running it on every trace of every model
    // that has no Stop Event at all would be pure waste. No `_stopFlag` write ⇒
    // no stop row ⇒ nothing to name.
    let stopMessage: string | undefined;
    const raisedStop = entry.writes.some(w => w.param === '_stopFlag' && w.value !== 0);
    for (const ev of (raisedStop ? entry.events : [])) {
      if (ev[0] !== 'f' && ev[0] !== 'v') continue;
      const o = resolveRecordOrigin(ev[1], kind);
      const n = findNode(model, o.nodeId);
      if ((n?.data as { nodeType?: string } | undefined)?.nodeType !== 'stopEvent') continue;
      const msg = (n!.data as { config?: Record<string, unknown> }).config?.message;
      stopMessage = String(msg ?? 'Stop condition reached');
      break;
    }
    return buildTraceRows({
      target: entry.target,
      writes: entry.writes,
      events: entry.events,
      snapshot: entry.snapshot,
      attrs: attrSpecs,
      dims,
      indicatorNames: (model.indicators || []).map(i => i.name),
      stopMessage,
      bondReqSlots: bondReqSlotsForModel(model),
      fieldAttrs: (cellFieldAttrsOf(model) || []).map(a => ({ id: a.id, name: a.name, type: a.type })),
    }).rows;
  }, [entry, model, kind, dims, prefs.tab]);

  // --- the Steps rows, memoised PER ENTRY and PER TAB ---------------------
  const steps = useMemo(
    () => (prefs.tab === 'steps' ? buildSteps(entry, model, kind) : []),
    [entry, model, kind, prefs.tab],
  );

  if (!armed) return null;           // doctrine HIDE — nothing to show (D7)

  const chips = timeline.filter(e => e.graphKind === kind);
  const selectedId = entry?.id ?? null;

  const backDisabled = cursor === null;
  const stepNodeDisabled = flows.length === 0 || (cursor !== null && cursor >= flows.length - 1);
  const wholeDisabled = cursor === null;

  const pausedLabel = session.paused
    ? resolveLabel(model, session.paused.nodeId, kind).label
    : null;

  bodyMsRef.current = performance.now() - renderStart;

  const approxNote = entry?.approximate
    ? approximateReason({
      asyncCells: model.properties.updateMode === 'asynchronous',
      // `agentUpdateMode` defaults to ASYNC when unset (the engine's own
      // default), so an absent field is the asynchronous case, not the safe one.
      agentsAsync: model.centerBased?.agentUpdateMode !== 'sync',
      agentsWriteField: !!model.topologyMode?.agents && (cellFieldAttrsOf(model) || []).length > 0,
      usesRng: false,
      webgpu: false,
      kind,
    })
    : null;

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      style={{ height: prefs.collapsed ? COLLAPSED_H : prefs.h }}
      role="region"
      aria-label="Rule Trace"
      data-trace-panel=""
    >
      <div className={styles.grip} onMouseDown={prefs.collapsed ? undefined : onGripDown}>
        <button
          type="button"
          className={styles.collapseBtn}
          title={prefs.collapsed ? 'Expand the Rule Trace panel' : 'Collapse the Rule Trace panel'}
          aria-label={prefs.collapsed ? 'Expand the Rule Trace panel' : 'Collapse the Rule Trace panel'}
          aria-expanded={!prefs.collapsed}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
          onClick={() => commitPrefs({ collapsed: !prefs.collapsed })}
        >{prefs.collapsed ? '▴' : '▾'}</button>
        {prefs.collapsed && <span className={styles.collapsedLabel}>Rule Trace</span>}
      </div>

      {!prefs.collapsed && (<>
        {/* --- transport row ------------------------------------------- */}
        <div className={styles.transport}>
          <TraceBtn
            glyph={playing ? '⏸' : '⏵'}
            title={playing ? 'Pause (Enter)' : 'Resume (Enter)'}
            onClick={() => (playing ? simTransportApi?.pause() : simTransportApi?.play())}
          />
          <TraceBtn
            glyph={'⏭'}
            title="Step one generation (Space with the viewport focused)"
            onClick={() => simTransportApi?.stepGeneration()}
          />
          <span className={styles.sep} />
          <TraceBtn
            glyph={'⤒'}
            title={backDisabled ? 'Already at the start' : 'Back one node ([)'}
            disabled={backDisabled}
            onClick={() => stepCursor(-1, entry)}
          />
          <TraceBtn
            glyph={'⤓'}
            title={stepNodeDisabled
              ? (flows.length === 0
                ? 'This trace executed no nodes'
                : 'Already at the last node — use Step generation')
              : 'Step one node (])'}
            disabled={stepNodeDisabled}
            onClick={() => stepCursor(1, entry)}
          />
          <TraceBtn
            glyph={'⟲'}
            title={wholeDisabled ? 'Showing the whole trace' : 'Show the whole trace'}
            disabled={wholeDisabled}
            onClick={() => setCursor(null)}
          />
          {pausedLabel && (
            <span className={styles.paused} title="A breakpoint paused the run BEFORE this generation was applied">
              {'⏸'} paused at {pausedLabel}
            </span>
          )}
          <span className={styles.spacer} />
          <span className={styles.element} title="The element being traced">
            {entry ? traceTargetLabel(entry.target, dims) : targetLabelFromSession(session, dims)}
          </span>
          {approxNote && (
            <span
              className={styles.badgeWarn}
              title={'This trace is a re-evaluation, not a recording of the engine’s own run: '
                + 'random draws come from the trace’s own stream, asynchronous updates make the '
                + 'neighbour state order-dependent, WebGPU computes in 32-bit, and an indicator '
                + 'accumulates across every element. See Help › Trace.'}
            >approximate</span>
          )}
          {entry?.truncated && (
            <span className={styles.badgeWarn} title="The event log hit its cap; this trace is a PREFIX of what the element did.">truncated</span>
          )}
          <TraceBtn
            glyph={'×'}
            title="Stop tracing"
            onClick={() => simTransportApi?.stopTrace()}
          />
        </div>

        {/* --- timeline strip (A3: horizontal scroll, never wrap) ------- */}
        <div className={styles.timelineRow}>
          <div className={styles.strip} ref={stripRef}>
            {chips.length === 0 && <span className={styles.empty}>waiting for the first trace…</span>}
            {chips.map(e => (
              <TimelineChip
                key={e.id}
                id={e.id}
                label={chipLabelOf(e, rootNames)}
                selected={e.id === selectedId}
                ghost={isResetRoot(e.root)}
              />
            ))}
          </div>
          {pinnedLive && (
            <TraceBtn
              glyph={<>{'↧'} follow newest</>}
              title="Release the held trace and follow the newest again"
              onClick={() => unpin()}
              wide
            />
          )}
        </div>

        {/* --- tabs ------------------------------------------------------ */}
        <div className={styles.tabs} role="tablist" aria-label="Rule Trace views">
          {(['values', 'steps', 'breakpoints'] as TabId[]).map(t => (
            <button
              type="button"
              key={t}
              role="tab"
              aria-selected={prefs.tab === t}
              className={`${styles.tab} ${prefs.tab === t ? styles.tabOn : ''}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => commitPrefs({ tab: t })}
            >{t === 'values' ? 'Values' : t === 'steps' ? 'Steps' : 'Breakpoints'}</button>
          ))}
        </div>

        <div className={styles.body} role="tabpanel">
          {prefs.tab === 'values' && (
            <ValuesTab
              entry={entry} rows={rows} attrsById={attrsById} is3d={is3d}
              rootNames={rootNames} approxNote={approxNote}
            />
          )}
          {prefs.tab === 'steps' && (
            <StepsTab steps={steps} cursor={cursor} truncated={!!entry?.truncated} model={model} kind={kind} />
          )}
          {prefs.tab === 'breakpoints' && <BreakpointsTab model={model} kind={kind} session={session} />}
        </div>
      </>)}
    </div>
  );
}

/** The element label before the FIRST trace of a session lands (the target is
 *  set, the reply is in flight — the header must not be blank for that frame). */
function targetLabelFromSession(
  session: ReturnType<typeof getTraceSession>, dims: TraceGridDims,
): string {
  if (session.target.cell !== null) return traceTargetLabel({ kind: 'cell', idx: session.target.cell }, dims);
  if (session.target.agent !== null) return traceTargetLabel({ kind: 'agent', id: session.target.agent }, dims);
  return '';
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function ValuesTab({
  entry, rows, attrsById, is3d, rootNames, approxNote,
}: {
  entry: TraceEntry | null;
  rows: TraceRow[];
  attrsById: Map<string, Attribute>;
  is3d: boolean;
  rootNames: Parameters<typeof traceRootLabel>[1];
  approxNote: string | null;
}) {
  if (!entry) return <div className={styles.empty}>No trace for this graph yet.</div>;
  return (<>
    <div className={styles.head}>
      {isResetRoot(entry.root)
        ? <>Trace of <b>Reset</b> ({traceRootLabel(entry.root, rootNames)})</>
        : <>Trace of generation <b>{entry.gen}</b> ({traceRootLabel(entry.root, rootNames)})</>}
      {approxNote && <> {'·'} <span className={styles.warn}>{approxNote}</span></>}
      {entry.error && <> {'·'} <span className={styles.warn}>the rule threw: {entry.error}</span></>}
    </div>
    {rows.length === 0 && <div className={styles.empty}>This rule wrote nothing for the traced element.</div>}
    {rows.map(r => (
      <div key={r.key} className={`${styles.vrow} ${r.changed ? styles.vrowChanged : ''}`}>
        <span className={styles.vname}>{r.name}</span>
        {r.current !== undefined && <span className={styles.vval}>{renderValue(r.current, attrsById, is3d)}</span>}
        <span className={styles.arrow}>{'→'}</span>
        <span className={`${styles.vval} ${r.changed ? styles.vnext : styles.vmuted}`}>
          {r.next !== undefined ? renderValue(r.next, attrsById, is3d) : '—'}
        </span>
        {r.next?.kind === 'hex' && (
          <span className={styles.swatch} style={{ background: hex(r.next.rgb) }} aria-hidden="true" />
        )}
        <span className={styles.vtag}>
          {r.note ?? (r.typeOf ? typeDisplayName(r.typeOf) : '')}
          {!r.changed && !r.note && r.current !== undefined ? ' · unchanged' : ''}
        </span>
      </div>
    ))}
  </>);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** One collapsed value record. It holds the RAW record, not a formatted string:
 *  decoding costs a `getEffectivePorts` call per record, and a 340-event trace
 *  arriving 30×/s would pay that ~330 times a frame for text behind a collapsed
 *  expander nobody opened. The text is produced by `stepValueText` when a row is
 *  actually expanded. */
interface StepValue { loweredId: string; portId: string; value: TraceValue }
interface StepRow {
  key: string;
  /** The CURSOR index (an index into `flowEvents`) this row selects, or null for
   *  a request row, which the cursor does not walk. */
  flowIndex: number | null;
  label: string;
  macroName?: string;
  taken?: string;
  request?: string;
  values: StepValue[];
}

/** The event log as the Steps tab shows it: one row per FLOW record, with the
 *  branch it took, and the value records collapsed under the flow row they feed.
 *
 *  ⚠ WHY VALUES ARE ATTRIBUTED FORWARDS. The JS compiler HOISTS values above the
 *  flow, so nearly every `v` record precedes the first `f` record in the log.
 *  Attributing each value to the next flow record at or after it is what makes
 *  "collapsed under their consumer" mean something — the alternative, a flat
 *  list, is forty `Get Attribute`s before the first step the user cares about
 *  (decision D3). */
function buildSteps(entry: TraceEntry | null, model: CAModel, kind: TraceGraphKind): StepRow[] {
  if (!entry) return [];
  const rows: StepRow[] = [];
  let pending: StepValue[] = [];
  let flowIndex = 0;
  for (let i = 0; i < entry.events.length; i++) {
    const ev = entry.events[i]!;
    if (ev[0] === 'v') {
      pending.push({ loweredId: ev[1], portId: ev[2], value: ev[3] as TraceValue });
      continue;
    }
    if (ev[0] === 'q') {
      rows.push({
        key: `q${i}`, flowIndex: null, label: '',
        request: ev[1] === '_agentCreate' ? 'Create Agent'
          : ev[1] === '_agentAddToWorld' ? 'Add Agent To World' : ev[1],
        values: pending,
      });
      pending = [];
      continue;
    }
    if (ev[0] !== 'f') continue;
    const r = resolveLabel(model, ev[1], kind);
    // The branch this node took is recorded by the SAME node, immediately after
    // its flow record and before the next one.
    let taken: string | undefined;
    for (let j = i + 1; j < entry.events.length; j++) {
      const e2 = entry.events[j]!;
      if (e2[0] === 'f') break;
      if (e2[0] === 'o' && e2[1] === ev[1]) { taken = e2[2]; break; }
    }
    rows.push({
      key: `f${i}`, flowIndex: flowIndex++, label: r.label,
      ...(r.macroName ? { macroName: r.macroName } : {}),
      ...(taken ? { taken } : {}),
      values: pending,
    });
    pending = [];
  }
  // Trailing values (records after the last flow node) belong to the last row —
  // dropping them would hide what the rule computed.
  if (pending.length > 0 && rows.length > 0) {
    rows[rows.length - 1]!.values.push(...pending);
  }
  return rows;
}

/** Format ONE collapsed value record, on demand (see `StepValue`). The port's
 *  declared type leads the decoding, which is why the node has to be resolved at
 *  all — `formatTraceValue` is the same function the hover tooltip uses, so a
 *  value reads identically in both surfaces. */
function stepValueText(
  v: StepValue, model: CAModel, kind: TraceGraphKind,
): { port: string; text: string } {
  const r = resolveLabel(model, v.loweredId, kind);
  const n = findNode(model, r.nodeId);
  const port = `${r.label}.${r.portId ?? v.portId}`;
  if (!n) return { port, text: String(v.value ?? '—') };
  const data = n.data as { nodeType?: string; config?: Record<string, unknown> };
  const eff = getEffectivePorts(data.nodeType ?? '', (data.config ?? {}) as never, model);
  const def = eff.outputs.find(p => p.id === (r.portId ?? v.portId));
  const rec: TracePortRecord = { value: v.value };
  return { port, text: formatTraceValue(rec, def, data.config, model) };
}

function StepsTab({
  steps, cursor, truncated, model, kind,
}: {
  steps: StepRow[]; cursor: number | null; truncated: boolean;
  model: CAModel; kind: TraceGraphKind;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (steps.length === 0) return <div className={styles.empty}>This trace executed no nodes.</div>;
  return (<>
    {steps.map(s => (
      <div key={s.key}>
        <div
          className={`${styles.srow} ${s.flowIndex !== null && s.flowIndex === cursor ? styles.srowCur : ''}`}
          onMouseDown={e => e.preventDefault()}
          onClick={() => { if (s.flowIndex !== null) setCursor(s.flowIndex); }}
          role="button"
          tabIndex={-1}
          title={s.flowIndex !== null ? 'Put the cursor on this node' : 'A queued request — the cursor does not stop here'}
        >
          <span className={styles.sidx}>{s.flowIndex !== null ? s.flowIndex + 1 : ''}</span>
          {s.request
            ? <span className={styles.sreq}>{'⚑'} request: {s.request}</span>
            : <span>
              {'▸'} {s.label}
              {s.macroName && <span className={styles.smut}> (in {s.macroName})</span>}
              {s.taken && <> {'→'} <span className={styles.staken}>{s.taken}</span></>}
            </span>}
          {s.values.length > 0 && (
            <button
              type="button"
              className={styles.expander}
              title={open === s.key ? 'Hide the values this step consumed' : 'Show the values this step consumed'}
              onMouseDown={e => e.preventDefault()}
              onClick={e => { e.stopPropagation(); setOpen(open === s.key ? null : s.key); }}
            >{'▹'} {s.values.length} value{s.values.length === 1 ? '' : 's'}</button>
          )}
        </div>
        {open === s.key && s.values.map((v, i) => {
          const t = stepValueText(v, model, kind);
          return (
            <div className={styles.vsub} key={i}>
              <span className={styles.vname}>{t.port}</span>
              <span className={styles.vval}>{t.text}</span>
            </div>
          );
        })}
      </div>
    ))}
    {truncated && <div className={styles.empty}>{'—'} the event log hit its cap; this is a prefix {'—'}</div>}
  </>);
}

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

function BreakpointsTab({
  model, kind, session,
}: { model: CAModel; kind: TraceGraphKind; session: ReturnType<typeof getTraceSession> }) {
  const list = [...session.breakpoints.entries()].filter(([, b]) => b.graphKind === kind);
  if (list.length === 0) {
    return (
      <div className={styles.empty}>
        Right-click a node {'→'} Breakpoint to pause the trace there.
      </div>
    );
  }
  return (<>
    {list.map(([key, bp]) => {
      // ⚠ `bp.macroPath` names macro DEFS (the editor's scope stack), so the node
      // is looked up inside the DEF — and a mark set inside a def arms in every
      // instance of it, which is what the scope suffix has to say.
      const defId = bp.macroPath.length > 0 ? bp.macroPath[bp.macroPath.length - 1] : undefined;
      const def = defId ? (model.macroDefs || []).find(d => d.id === defId) : undefined;
      const nodes: GraphNode[] = def
        ? (def.nodes as GraphNode[])
        : ((kind === 'agents' ? model.agentGraphNodes : model.graphNodes) || []) as GraphNode[];
      const label = labelOfNode(nodes.find(nn => nn.id === bp.nodeId), bp.nodeId, kind);
      return (
        <div key={key} className={styles.brow}>
          <input
            type="checkbox"
            checked={bp.enabled}
            onChange={e => setBreakpointEnabled(key, e.target.checked)}
            title={bp.enabled ? 'Disable this breakpoint' : 'Enable this breakpoint'}
            aria-label={`${bp.enabled ? 'Disable' : 'Enable'} the breakpoint on ${label}`}
          />
          <span className={`${styles.bdot} ${bp.enabled ? '' : styles.bdotOff}`} aria-hidden="true" />
          <span className={bp.enabled ? '' : styles.smut}>{label}</span>
          <span className={styles.smut}>
            {'·'} {kind === 'agents' ? 'agents' : 'cells'} {'·'} {def ? `in ${def.name}` : 'root scope'}
          </span>
          <span className={styles.spacer} />
          <TraceBtn glyph={'×'} title="Remove this breakpoint" onClick={() => removeBreakpoint(key)} />
        </div>
      );
    })}
    <div className={styles.brow}>
      <TraceBtn
        glyph="Clear all"
        title={`Remove every breakpoint on the ${kind === 'agents' ? 'agent' : 'cell'} graph`}
        onClick={() => clearBreakpoints(kind)}
        wide
      />
    </div>
  </>);
}
