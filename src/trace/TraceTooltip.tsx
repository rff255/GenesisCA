/** RULE TRACE (P4) — the hover tooltip: what this node / this wire carried.
 *
 * ⚠ PORTALLED TO `document.body`, and that is not a style choice. A
 * `position: fixed` element rendered from inside React Flow's transformed
 * viewport is positioned against the TRANSFORM, not the viewport — the standing
 * repo rule (`modeler-ui.md` Key Patterns). The hover handlers live in
 * `GraphEditor`, inside the flow; the surface they open lives here, in the body.
 *
 * ⚠ IT CARRIES NO `role`, deliberately. `overlayOwnsKeyboard()` probes the DOM
 * for `[role="dialog"] / [role="menu"]` and stands the global keys down while
 * one is open — a surface that opens on HOVER must never do that (the viewer
 * control paid for this lesson: an Enter swallowed just for mousing past). It is
 * also `pointer-events: none`, so it can never eat a click meant for the canvas.
 *
 * VALUES ARE DECODED, NOT RAW (the plan's §3 note): binary → true/false · a tag
 * → the option name · a neighbour index → `(dr, dc)` / `(dr, dc, dl)` in 3D · a
 * vector or colour → `(x, y, z)` reassembled from the per-component records the
 * composite lowering emitted · an array → `[a, b, …] (n)`.
 *
 * The tooltip RE-READS the view on each trace (rAF-coalesced), so a value under
 * the pointer keeps up with a running simulation. That re-render is confined to
 * THIS component — the graph itself is never re-rendered by a trace (Trap 6).
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CAModel, Attribute } from '../model/types';
import type { PortDef } from '../modeler/vpl/types';
import type { TraceValue } from '../simulator/engine/traceRunner';
import { getNodeDef } from '../modeler/vpl/nodes/registry';
import { getEffectivePorts } from '../modeler/vpl/effectivePorts';
import { displayNodeLabel } from '../modeler/vpl/graphState';
import { unpackNI, unpackNI3, INVALID_NI } from '../modeler/vpl/compiler/niCodec';
import { subscribeTrace } from './traceState';
import type { TraceWireOrigin } from './traceGraphMap';
import styles from './TraceTooltip.module.css';

// ---------------------------------------------------------------------------
// The view the highlighter publishes (read here, never written here)
// ---------------------------------------------------------------------------

/** One user PORT's record. A composite port (vector / colour) was lowered to
 *  one scalar node per component, so its record arrives in pieces. */
export interface TracePortRecord {
  value?: TraceValue;
  components?: Record<string, TraceValue>;
}

export interface TraceNodeView {
  /** How many times a FLOW record named this node at/under the cursor. */
  flowCount: number;
  /** The flow OUTPUT ports taken, in order, first occurrence only. */
  taken: string[];
  /** user port id → its latest record at/under the cursor. */
  ports: Map<string, TracePortRecord>;
}

export interface TraceGraphView {
  gen: number;
  approximate: boolean;
  /** editor node id → what it did. Absent ⇒ no record in this trace. */
  nodes: Map<string, TraceNodeView>;
  /** edge id → the real source port it carries (reroute chains resolved). */
  edgeOrigin: Map<string, TraceWireOrigin>;
  /** `<nodeId>:<inputPortId>` → the real source port wired into it. */
  valueInputOrigin: Map<string, TraceWireOrigin>;
}

export interface TraceHoverTarget {
  kind: 'node' | 'edge';
  id: string;
  /** Pointer position at the moment of entry, in CLIENT coords. */
  x: number;
  y: number;
}

/** The node data the tooltip needs — supplied by the caller so this component
 *  never touches React Flow's store. */
export interface TraceHoverNode {
  nodeType: string;
  config: Record<string, unknown>;
  label?: string;
}

interface Props {
  hover: TraceHoverTarget;
  /** Latest-ref to the highlighter's view (null ⇒ nothing traced here). */
  viewRef: { current: TraceGraphView | null };
  /** Resolve the hovered node (or an edge's source node) to its data. */
  lookupNode: (id: string) => TraceHoverNode | null;
  model: CAModel;
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

const ARRAY_SHOWN = 8;

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === Math.trunc(v)) return String(v);
  const fixed = v.toFixed(4);
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

function attrOf(model: CAModel, id: unknown): Attribute | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  return model.attributes.find(a => a.id === id);
}

function formatNI(n: number, is3d: boolean): string {
  const packed = n | 0;
  if (packed === INVALID_NI) return 'no neighbour';
  if (is3d) {
    const { dr, dc, dl } = unpackNI3(packed);
    return `(${dr}, ${dc}, ${dl})`;
  }
  const { dr, dc } = unpackNI(packed);
  return `(${dr}, ${dc})`;
}

/** Decode ONE recorded value for display.
 *
 *  The port's declared `dataType` leads; where it is the permissive `any` (the
 *  accessor nodes' output type) the node's CONFIGURED attribute decides — that
 *  is how `alive` shows `true` and a state tag shows its option name rather than
 *  an index nobody can read. */
export function formatTraceValue(
  rec: TracePortRecord | undefined,
  port: PortDef | undefined,
  nodeConfig: Record<string, unknown> | undefined,
  model: CAModel,
): string {
  if (!rec) return '—';
  const is3d = model.properties.dimension === '3d';
  if (rec.components) {
    const order = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'].filter(c => rec.components![c] !== undefined);
    const parts = order.map(c => {
      const v = rec.components![c];
      return typeof v === 'number' ? formatNumber(v) : String(v ?? '?');
    });
    return `(${parts.join(', ')})`;
  }
  const v = rec.value;
  if (v === undefined) return 'not evaluated';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'arr' in v) {
    const shown = v.arr.slice(0, ARRAY_SHOWN).map(formatNumber);
    const more = v.len > shown.length ? ', …' : '';
    return `[${shown.join(', ')}${more}] (${v.len})`;
  }
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  if (typeof n !== 'number') return String(v);

  const dt = port?.dataType;
  if (dt === 'bool' || typeof v === 'boolean') return n ? 'true' : 'false';
  if (dt === 'neighborIndex') return formatNI(n, is3d);
  if (dt === 'integer') return String(n | 0);

  // `any` / `float` — let the node's configured attribute speak if it can.
  const attr = attrOf(model, nodeConfig?.attributeId);
  if (attr) {
    if (attr.type === 'bool') return n ? 'true' : 'false';
    if (attr.type === 'tag') {
      const opts = attr.tagOptions || [];
      const i = n | 0;
      return (i >= 0 && i < opts.length) ? opts[i]! : `(${i})`;
    }
    if (attr.type === 'neighborIndex') return formatNI(n, is3d);
    if (attr.type === 'integer') return String(n | 0);
  }
  return formatNumber(n);
}

// ---------------------------------------------------------------------------
// A rAF-coalesced tick so a running trace refreshes the hovered value without
// re-rendering anything else.
// ---------------------------------------------------------------------------

function useTraceTick(): number {
  const [tick, setTick] = useState(0);
  const pending = useRef(false);
  useEffect(() => {
    const unsub = subscribeTrace(() => {
      if (pending.current) return;
      pending.current = true;
      requestAnimationFrame(() => { pending.current = false; setTick(t => t + 1); });
    });
    return unsub;
  }, []);
  return tick;
}

// ---------------------------------------------------------------------------

const MARGIN = 12;
const EST_W = 250;

export function TraceTooltip({ hover, viewRef, lookupNode, model }: Props) {
  useTraceTick();
  const elRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Clamp to the viewport once the real size is known (the first frame renders
  // hidden, the context menu's own discipline).
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const w = el.offsetWidth || EST_W;
    const h = el.offsetHeight || 60;
    let left = hover.x + MARGIN;
    let top = hover.y + MARGIN;
    if (left + w > window.innerWidth - 4) left = Math.max(4, hover.x - w - MARGIN);
    if (top + h > window.innerHeight - 4) top = Math.max(4, hover.y - h - MARGIN);
    setPos({ left, top });
  }, [hover.x, hover.y, hover.id, hover.kind]);

  const view = viewRef.current;
  if (!view) return null;

  let body: React.ReactNode;

  if (hover.kind === 'edge') {
    const origin = view.edgeOrigin.get(hover.id);
    if (!origin) return null;
    const src = lookupNode(origin.nodeId);
    const nv = view.nodes.get(origin.nodeId);
    const rec = nv?.ports.get(origin.portId);
    const def = src ? getNodeDef(src.nodeType) : undefined;
    const eff = src ? getEffectivePorts(src.nodeType, src.config, model) : { inputs: [], outputs: [] };
    const port = eff.outputs.find(p => p.id === origin.portId);
    const title = src ? (src.label || (def ? displayNodeLabel(def) : src.nodeType)) : origin.nodeId;
    body = (
      <>
        <div className={styles.head}>
          <span className={styles.title}>{title}</span>
          <span className={styles.gen}>gen {view.gen}</span>
        </div>
        {origin.category === 'flow' ? (
          <div className={styles.row}>
            <span className={styles.label}>{port?.label ?? origin.portId}</span>
            <span className={styles.value}>{nv ? 'taken' : 'not taken'}</span>
          </div>
        ) : (
          <div className={styles.row}>
            <span className={styles.label}>{port?.label ?? origin.portId}</span>
            <span className={styles.value}>
              {rec ? formatTraceValue(rec, port, src?.config, model) : 'not evaluated'}
            </span>
          </div>
        )}
      </>
    );
  } else {
    const node = lookupNode(hover.id);
    if (!node) return null;
    const def = getNodeDef(node.nodeType);
    const nv = view.nodes.get(hover.id);
    const eff = getEffectivePorts(node.nodeType, node.config, model);
    const valueOuts = eff.outputs.filter(p => p.category === 'value');
    const title = node.label || (def ? displayNodeLabel(def) : node.nodeType);
    // INPUTS FIRST. What a flow node like `If` is interesting FOR is the value
    // it was handed, and that value is recorded on whoever produced it — so a
    // wired input is read back through the wire (the plan's §3 mockup, which
    // shows the If's `condition` before its branch).
    const inRows = eff.inputs
      .filter(p => p.category === 'value')
      .map(p => {
        const o = view.valueInputOrigin.get(`${hover.id}:${p.id}`);
        const rec = o ? view.nodes.get(o.nodeId)?.ports.get(o.portId) : undefined;
        const srcCfg = o ? lookupNode(o.nodeId)?.config : undefined;
        return { p, rec, srcCfg };
      })
      .filter(r => r.rec !== undefined);
    const rows = valueOuts
      .map(p => ({ p, rec: nv?.ports.get(p.id) }))
      .filter(r => r.rec !== undefined);
    // A port the compiler named but the editor's effective list does not carry
    // (a macro instance's dynamic ports, a root wrapper's own outs).
    const extra = nv
      ? [...nv.ports.keys()].filter(k => !valueOuts.some(p => p.id === k))
      : [];
    body = (
      <>
        <div className={styles.head}>
          <span className={styles.title}>{title}</span>
          <span className={styles.gen}>gen {view.gen}</span>
        </div>
        {!nv && inRows.length === 0 && <div className={styles.muted}>not reached in this trace</div>}
        {inRows.map(({ p, rec, srcCfg }) => (
          <div className={styles.row} key={`in:${p.id}`}>
            <span className={styles.label}>{p.label}</span>
            <span className={styles.value}>{formatTraceValue(rec, p, srcCfg, model)}</span>
          </div>
        ))}
        {nv && nv.flowCount > 0 && (
          <div className={styles.row}>
            <span className={styles.label}>executed</span>
            <span className={styles.value}>&times;{nv.flowCount}</span>
          </div>
        )}
        {nv && nv.taken.length > 0 && (
          <div className={styles.row}>
            <span className={styles.label}>branch taken</span>
            <span className={`${styles.value} ${styles.flowValue}`}>{nv.taken.join(', ')}</span>
          </div>
        )}
        {rows.map(({ p, rec }) => (
          <div className={styles.row} key={p.id}>
            <span className={styles.label}>{p.label}</span>
            <span className={styles.value}>{formatTraceValue(rec, p, node.config, model)}</span>
          </div>
        ))}
        {extra.map(k => (
          <div className={styles.row} key={`x:${k}`}>
            <span className={styles.label}>{k}</span>
            <span className={styles.value}>
              {formatTraceValue(nv!.ports.get(k), undefined, node.config, model)}
            </span>
          </div>
        ))}
        {nv && view.approximate && (
          <div className={styles.muted}>approximate — see the Trace panel</div>
        )}
      </>
    );
  }

  return createPortal(
    <div
      ref={elRef}
      className={styles.tooltip}
      style={{
        left: pos ? pos.left : hover.x + MARGIN,
        top: pos ? pos.top : hover.y + MARGIN,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {body}
    </div>,
    document.body,
  );
}
