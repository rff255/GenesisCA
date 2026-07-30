import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attribute } from '../model/types';
import type { AgentCapabilities } from '../model/types';
import { decodeVectorFromValues } from '../modeler/vpl/compiler/vectorAttr';
import styles from './InspectCellPopover.module.css';

/** One pinned (or transient-sweep) agent inspector. Mirrors the cell inspector's
 *  `InspectPopoverState`: the agent id it tracks + where the popover sits. */
export type AgentPopoverState = {
  id: number;
  x: number;
  y: number;
};

/** The worker's `agentState` reply (the shape SimulatorView already receives). */
export interface AgentStateValues {
  id: number;
  live: boolean;
  x?: number; y?: number; z?: number;
  vx?: number; vy?: number; vz?: number;
  radius?: number; lineage?: number; age?: number;
  bondDegree?: number; density?: number;
  attrs?: Record<string, number>;
  bonds?: number[];
  /** P2 — per-EDGE user state, PARALLEL to `bonds` (same order, one record per
   *  live bond). Absent when the model declares no bond attributes. */
  bondAttrs?: Array<Record<string, number>>;
}

interface Props {
  popover: AgentPopoverState;
  /** Latest worker state for this agent (null until the first reply lands). */
  state: AgentStateValues | null;
  agentAttributes: Attribute[];
  /** P2 — the model's BOND attributes, for the per-bond value rows. Empty ⇒ the
   *  bond-attribute block is not rendered at all. */
  bondAttributes: Attribute[];
  /** Agent Capability Profile — gates the geometry rows (absent ⇒ show all). */
  capProfile: AgentCapabilities | null;
  /** Transient sweep popover (opened on press, not yet pinned): no Close-all and
   *  a subtle marker, so the pinned/unpinned distinction is visible. */
  transient?: boolean;
  focused: boolean;
  totalOpen: number;
  /** FOLLOW MODE: is the camera currently tracking THIS agent? Only meaningful
   *  when `onToggleFollow` is supplied (pinned popovers — a transient sweep
   *  popover is about to be discarded, so following it would be pointless). */
  following?: boolean;
  onToggleFollow?: () => void;
  onClose: () => void;
  onCloseAll: () => void;
  onFocus: () => void;
  onDragEnd: (x: number, y: number) => void;
}

const DRAG_MARGIN = 8;

function fmt(v: number | undefined, digits: number): string {
  return v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

/** Format one agent-attribute value by its declared type (mirrors the cell
 *  inspector's decode; a `vector` attribute is stored as scalar components, so
 *  it recombines into `(x, y[, z])`). */
function decodeAgentAttr(attr: Attribute, attrs: Record<string, number>): string {
  if (attr.type === 'vector') return decodeVectorFromValues(attr, attrs);
  const v = attrs[attr.id];
  if (v === undefined) return '—';
  switch (attr.type) {
    case 'bool': return v ? 'true' : 'false';
    case 'tag': return attr.tagOptions?.[v | 0] ?? `(${v | 0})`;
    case 'integer': return String(v | 0);
    default: return v.toFixed(3);
  }
}

/**
 * A draggable agent inspector popover — the agent-layer twin of
 * `InspectCellPopover`. Several can be open at once (z-order = array order),
 * each is dragged by its header, closes with its × or Esc while focused, and
 * carries a "Close all" action. Dimension-agnostic: the 2D and 3D pick paths
 * both open these (the 3D view additionally rings the agent in the volume).
 */
export function InspectAgentPopover({
  popover, state, agentAttributes, bondAttributes, capProfile, transient = false,
  focused, totalOpen, following = false, onToggleFollow,
  onClose, onCloseAll, onFocus, onDragEnd,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: popover.x, top: popover.y });

  // Viewport clamp after mount so the popover never spills off-screen on open
  // or after a window resize (same rule as the cell inspector).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - DRAG_MARGIN;
    const maxTop = window.innerHeight - rect.height - DRAG_MARGIN;
    setPos({
      left: Math.max(DRAG_MARGIN, Math.min(popover.x, maxLeft)),
      top: Math.max(DRAG_MARGIN, Math.min(popover.y, maxTop)),
    });
  }, [popover.x, popover.y]);

  // Escape closes only the focused popup.
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, onClose]);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    onFocus();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const start = { left: pos.left, top: pos.top };
    const clamp = (nx: number, ny: number) => {
      const el = rootRef.current;
      const w = el?.offsetWidth ?? 0, h = el?.offsetHeight ?? 0;
      return {
        left: Math.max(DRAG_MARGIN, Math.min(nx, window.innerWidth - w - DRAG_MARGIN)),
        top: Math.max(DRAG_MARGIN, Math.min(ny, window.innerHeight - h - DRAG_MARGIN)),
      };
    };
    const onMove = (ev: MouseEvent) => {
      setPos(clamp(start.left + ev.clientX - startX, start.top + ev.clientY - startY));
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const p = clamp(start.left + ev.clientX - startX, start.top + ev.clientY - startY);
      onDragEnd(p.left, p.top);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const showAll = !capProfile;
  const attrs = state?.attrs;

  return (
    <div
      ref={rootRef}
      data-sim-overlay
      className={styles.popover}
      style={{ left: pos.left, top: pos.top, opacity: transient ? 0.94 : 1 }}
      onMouseDown={onFocus}
      onContextMenu={e => e.preventDefault()}
    >
      <div className={styles.header} onMouseDown={onHeaderMouseDown}>
        <span className={styles.coord}>Agent #{popover.id}</span>
        {onToggleFollow && (
          <button
            className={following ? `${styles.followBtn} ${styles.followBtnActive}` : styles.followBtn}
            onClick={onToggleFollow}
            onMouseDown={e => e.stopPropagation()}
            title={following
              ? 'Following this agent — click to stop (a manual pan/orbit also stops it)'
              : 'Follow this agent with the camera'}
            aria-pressed={following}
          >&#9678;</button>
        )}
        {!transient && totalOpen > 1 && (
          <button
            className={styles.closeAllBtn}
            onClick={onCloseAll}
            onMouseDown={e => e.stopPropagation()}
            title={`Close all agent inspect popups (${totalOpen} open)`}
          >Close all</button>
        )}
        <button
          className={styles.closeBtn}
          onClick={onClose}
          onMouseDown={e => e.stopPropagation()}
          title="Close (Esc)"
        >&times;</button>
      </div>

      <div className={styles.attrTable}>
        {!state || !state.live ? (
          <div className={styles.empty}>{state && !state.live ? 'Agent no longer exists.' : 'Loading…'}</div>
        ) : (
          <>
            <div className={styles.attrRow}>
              <span className={styles.attrName}>pos</span>
              <span className={styles.attrValue}>
                ({fmt(state.x, 2)}, {fmt(state.y, 2)}{state.z !== undefined ? `, ${fmt(state.z, 2)}` : ''})
              </span>
            </div>
            {(showAll || capProfile!.motion !== 'static') && (
              <div className={styles.attrRow}>
                <span className={styles.attrName}>|v|</span>
                <span className={styles.attrValue}>{Math.hypot(state.vx ?? 0, state.vy ?? 0, state.vz ?? 0).toFixed(3)}</span>
              </div>
            )}
            {(showAll || capProfile!.body) && (
              <div className={styles.attrRow}>
                <span className={styles.attrName}>radius</span>
                <span className={styles.attrValue}>{fmt(state.radius, 3)}</span>
              </div>
            )}
            {(showAll || capProfile!.bonds !== 'off') && (
              <div className={styles.attrRow}>
                <span className={styles.attrName}>bonds</span>
                <span className={styles.attrValue}>{state.bondDegree ?? '—'}</span>
              </div>
            )}
            {(showAll || capProfile!.collision !== 'off' || capProfile!.sensing) && (
              <div className={styles.attrRow}>
                <span className={styles.attrName}>density</span>
                <span className={styles.attrValue}>{fmt(state.density, 3)}</span>
              </div>
            )}
            {attrs && agentAttributes.length > 0 && (
              <>
                {agentAttributes
                  .filter(a => a.type === 'vector' || attrs[a.id] !== undefined)
                  .map(a => (
                    <div className={styles.attrRow} key={a.id}>
                      <span className={styles.attrName} title={a.description || undefined}>{a.name}</span>
                      <span className={styles.attrValue}>{decodeAgentAttr(a, attrs)}</span>
                    </div>
                  ))}
              </>
            )}
            {/* P2 — this agent's BONDS with their per-EDGE attribute values. One
                row per live bond ("→ 42  weight 1.5 · kind Apical"); a bond
                attribute is symmetric, so the partner shows the same values. */}
            {bondAttributes.length > 0 && (state.bonds?.length ?? 0) > 0 && (
              <>
                <div className={styles.attrRow} style={{ opacity: 0.65, marginTop: 4 }}>
                  <span className={styles.attrName}>bond attributes</span>
                  <span className={styles.attrValue} />
                </div>
                {(state.bonds ?? []).map((p, i) => (
                  <div className={styles.attrRow} key={`${p}-${i}`}>
                    <span className={styles.attrName}>→ {p}</span>
                    <span className={styles.attrValue}>
                      {bondAttributes.map(a => {
                        const v = state.bondAttrs?.[i]?.[a.id];
                        return `${a.name} ${v === undefined ? '—' : decodeAgentAttr(a, { [a.id]: v })}`;
                      }).join(' · ')}
                    </span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
