import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attribute } from '../model/types';
import { decodeAttrValue, encodeAttrValue } from '../model/attrValueEncoding';
import { InlineBoolSelect, InlineNumberInput, InlineTagSelect } from '../modeler/vpl/widgets/InlineWidgets';
import styles from './InspectCellPopover.module.css';

/** One pinned bond inspector. `a`/`b` are agent ids, NORMALISED a < b by the
 *  caller so the same edge can never be pinned twice under two keys. */
export type BondPopoverState = {
  a: number;
  b: number;
  x: number;
  y: number;
};

/** The worker's `bondState` reply (the edge sibling of `agentState`). */
export interface BondStateValues {
  a: number;
  b: number;
  live: boolean;
  /** Built-in per-slot fields. */
  restLength?: number;
  stiffness?: number;
  typeLabel?: number;
  /** Current separation, torus-FOLDED by the worker (same fold as the force
   *  pass and the bond render), so a seam-crossing bond reports its real length. */
  length?: number;
  /** Per-EDGE user attribute values, keyed by bond-attribute id. */
  attrs?: Record<string, number>;
}

interface Props {
  popover: BondPopoverState;
  /** Latest worker state for this bond (null until the first reply lands). */
  state: BondStateValues | null;
  /** The model's BOND attributes — one editable row each. Empty ⇒ the popover
   *  still shows the built-in fields (endpoints / length / rest / stiffness). */
  bondAttributes: Attribute[];
  /** Does the engine run bond SPRINGS for this model (`usesEngineSprings`)?
   *  When it doesn't, stiffness feeds nothing at all, so its row is HIDDEN
   *  rather than shown-and-inert (the standing enabled-control rule). */
  springs: boolean;
  focused: boolean;
  totalOpen: number;
  onClose: () => void;
  onCloseAll: () => void;
  onFocus: () => void;
  onDragEnd: (x: number, y: number) => void;
  /** Apply the edited fields (posts one `setBondState`). Only called with the
   *  fields the user actually touched. */
  onApply: (patch: { restLength?: number; stiffness?: number; attrs?: Array<{ attrId: string; value: number }> }) => void;
  /** Open the agent inspector for an endpoint (the id chips are clickable). */
  onOpenAgent?: (id: number) => void;
}

const DRAG_MARGIN = 8;
/** Keys of the local edit-draft map: the two built-ins + one per bond attr id. */
const REST_KEY = '__rest__';
const STIFF_KEY = '__stiff__';

function fmt(v: number | undefined, digits: number): string {
  return v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

/** Seed an editor from a live float without showing 17 digits of FP noise. */
function editSeed(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toFixed(6)));
}

/**
 * A draggable BOND inspector popover — the edge-layer twin of
 * `InspectAgentPopover`. Opened by an inspect click that lands near a bond LINE
 * rather than on an agent. Shows the edge's live state (endpoints, current
 * length, rest length, stiffness) plus one row per user BOND ATTRIBUTE, and
 * edits them through an explicit Apply.
 *
 * WHY APPLY RATHER THAN WRITE-ON-CHANGE: a bond attribute is often written by
 * the rule EVERY generation (SDCA's link value is an exponential moving
 * average), so the polled live value changes under the cursor. Rows therefore
 * READ live until the user touches a field; from then on the local draft wins
 * for that field only, and Apply commits every dirty field in one message.
 */
export function InspectBondPopover({
  popover, state, bondAttributes, springs, focused, totalOpen,
  onClose, onCloseAll, onFocus, onDragEnd, onApply, onOpenAgent,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: popover.x, top: popover.y });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Viewport clamp after mount (same rule as the cell/agent inspectors).
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

  const setDraft = (key: string, value: string) => setDrafts(prev => ({ ...prev, [key]: value }));
  const dirty = Object.keys(drafts).length > 0;
  const live = !!state?.live;

  const apply = () => {
    if (!dirty) return;
    const patch: { restLength?: number; stiffness?: number; attrs?: Array<{ attrId: string; value: number }> } = {};
    if (drafts[REST_KEY] !== undefined) {
      const n = parseFloat(drafts[REST_KEY]!);
      if (Number.isFinite(n)) patch.restLength = n;
    }
    if (drafts[STIFF_KEY] !== undefined) {
      const n = parseFloat(drafts[STIFF_KEY]!);
      if (Number.isFinite(n)) patch.stiffness = n;
    }
    const attrs: Array<{ attrId: string; value: number }> = [];
    for (const attr of bondAttributes) {
      const raw = drafts[attr.id];
      if (raw === undefined) continue;
      attrs.push({ attrId: attr.id, value: encodeAttrValue(attr, raw) });
    }
    if (attrs.length > 0) patch.attrs = attrs;
    onApply(patch);
    setDrafts({});   // rows go back to reading LIVE
  };

  return (
    <div
      ref={rootRef}
      data-sim-overlay
      className={styles.popover}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={onFocus}
      onContextMenu={e => e.preventDefault()}
    >
      <div className={styles.header} onMouseDown={onHeaderMouseDown}>
        <span className={styles.coord}>Bond #{popover.a} &harr; #{popover.b}</span>
        {totalOpen > 1 && (
          <button
            className={styles.closeAllBtn}
            onClick={onCloseAll}
            onMouseDown={e => e.stopPropagation()}
            title={`Close all bond inspect popups (${totalOpen} open)`}
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
        {!live ? (
          <div className={styles.empty}>{state && !state.live ? 'Bond no longer exists.' : 'Loading…'}</div>
        ) : (
          <>
            <div className={styles.attrRow}>
              <span className={styles.attrName}>endpoints</span>
              <span className={styles.attrValue} style={{ flexDirection: 'row', gap: 6 }}>
                {[popover.a, popover.b].map(id => (
                  <button
                    key={id}
                    className={styles.closeAllBtn}
                    onClick={() => onOpenAgent?.(id)}
                    onMouseDown={e => e.stopPropagation()}
                    title={`Inspect agent #${id}`}
                    disabled={!onOpenAgent}
                  >#{id}</button>
                ))}
              </span>
            </div>
            <div className={styles.attrRow}>
              <span className={styles.attrName} title="Current separation (torus-folded)">length</span>
              <span className={styles.attrValue}>{fmt(state!.length, 3)}</span>
            </div>
            <div className={styles.attrRow}>
              <span className={styles.attrName} title="The spring's natural length — also readable from a rule via For Each Bond.">rest length</span>
              <span className={styles.attrValue}>
                <InlineNumberInput
                  value={drafts[REST_KEY] ?? editSeed(state!.restLength)}
                  step="any"
                  onChange={v => setDraft(REST_KEY, v)}
                />
              </span>
            </div>
            {springs && (
              <div className={styles.attrRow}>
                <span className={styles.attrName} title="Bond spring stiffness (λ).">stiffness</span>
                <span className={styles.attrValue}>
                  <InlineNumberInput
                    value={drafts[STIFF_KEY] ?? editSeed(state!.stiffness)}
                    step="any"
                    onChange={v => setDraft(STIFF_KEY, v)}
                  />
                </span>
              </div>
            )}
            {bondAttributes.length > 0 && (
              <>
                <div className={styles.attrRow} style={{ opacity: 0.65, marginTop: 4 }}>
                  <span className={styles.attrName}>bond attributes</span>
                  <span className={styles.attrValue} />
                </div>
                {bondAttributes.map(attr => {
                  const raw = state!.attrs?.[attr.id];
                  const shown = drafts[attr.id]
                    ?? (raw === undefined ? (attr.defaultValue ?? '')
                      : attr.type === 'float' ? editSeed(raw) : decodeAttrValue(attr, raw));
                  return (
                    <div className={styles.attrRow} key={attr.id}>
                      <span className={styles.attrName} title={attr.description || undefined}>{attr.name}</span>
                      <span className={styles.attrValue}>
                        {attr.type === 'bool' && (
                          <InlineBoolSelect value={shown || 'false'} onChange={v => setDraft(attr.id, v)} />
                        )}
                        {attr.type === 'tag' && (
                          <InlineTagSelect value={shown || '0'} options={attr.tagOptions ?? []} onChange={v => setDraft(attr.id, v)} />
                        )}
                        {(attr.type === 'integer' || attr.type === 'float') && (
                          <InlineNumberInput
                            value={shown}
                            step={attr.type === 'float' ? 'any' : 1}
                            onChange={v => setDraft(attr.id, v)}
                          />
                        )}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
            <div className={styles.attrRow} style={{ marginTop: 4 }}>
              <span className={styles.attrName} />
              <span className={styles.attrValue}>
                <button
                  className={styles.closeAllBtn}
                  onClick={apply}
                  onMouseDown={e => e.stopPropagation()}
                  disabled={!dirty}
                  style={{ opacity: dirty ? 1 : 0.45 }}
                  title={dirty
                    ? 'Write the edited fields onto BOTH sides of this bond'
                    : 'Edit a field above to enable'}
                >Apply</button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
