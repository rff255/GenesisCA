import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attribute } from '../model/types';
import { unpackNI, INVALID_NI } from '../modeler/vpl/compiler/niCodec';
import styles from './InspectCellPopover.module.css';

export type InspectPopoverState = {
  cellIdx: number;
  row: number;
  col: number;
  x: number;
  y: number;
};

interface Props {
  popover: InspectPopoverState;
  cellAttrs: Attribute[];
  values: Record<string, number> | null;
  color: { r: number; g: number; b: number } | null;
  /** Variegated-cells orientation (0..3 = N/E/S/W head direction). null when
   *  the model isn't variegated or the worker hasn't published it yet. */
  orientation: number | null;
  pulse: boolean;
  focused: boolean;
  totalOpen: number;
  onClose: () => void;
  onCloseAll: () => void;
  onFocus: () => void;
  onDragEnd: (x: number, y: number) => void;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
  onRectMeasure: (rect: DOMRect) => void;
}

const ORIENTATION_NAMES = ['N', 'E', 'S', 'W'] as const;

const DRAG_MARGIN = 8;

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, v | 0));
  return '#' + [clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === Math.trunc(v)) return v.toFixed(1);
  const fixed = v.toFixed(6);
  return fixed.replace(/0+$/, '').replace(/\.$/, '.0');
}

function decodeAttrValue(v: number | undefined, attr: Attribute): string {
  if (v === undefined) return '—';
  switch (attr.type) {
    case 'bool': return v ? 'true' : 'false';
    case 'integer': return String(v | 0);
    case 'float': return formatFloat(v);
    case 'tag': {
      const opts = attr.tagOptions || [];
      const idx = v | 0;
      if (idx >= 0 && idx < opts.length) return opts[idx]!;
      return `(${idx})`;
    }
    case 'neighborIndex': {
      const packed = v | 0;
      if (packed === INVALID_NI) return 'INVALID_NI (no neighbor)';
      const { dr, dc } = unpackNI(packed);
      return `(dr ${dr}, dc ${dc})`;
    }
    default: return formatFloat(v);
  }
}

function parentMatches(parent: Attribute, parentValue: number | undefined, parentValues: string[] | undefined): boolean {
  if (parentValue === undefined || !parentValues || parentValues.length === 0) return false;
  if (parent.type === 'bool') {
    const want = parentValues.includes('true');
    const wantFalse = parentValues.includes('false');
    if (parentValue) return want;
    return wantFalse;
  }
  if (parent.type === 'tag') {
    const idx = String(parentValue | 0);
    return parentValues.includes(idx);
  }
  return false;
}

export function InspectCellPopover({
  popover, cellAttrs, values, color, orientation, pulse, focused, totalOpen,
  onClose, onCloseAll, onFocus, onDragEnd, onHoverEnter, onHoverLeave, onRectMeasure,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: popover.x, top: popover.y });

  // Viewport clamp after mount so the popover never spills off-screen on the
  // initial open or after a window resize.
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

  // Report rect to parent so the hover-link overlay can anchor at the right
  // edge. Runs after each layout, including after drag updates.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    onRectMeasure(el.getBoundingClientRect());
  });

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
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { left: pos.left, top: pos.top };
    const onMove = (ev: MouseEvent) => {
      const nextLeft = start.left + ev.clientX - startX;
      const nextTop = start.top + ev.clientY - startY;
      const el = rootRef.current;
      const w = el?.offsetWidth ?? 0;
      const h = el?.offsetHeight ?? 0;
      const maxLeft = window.innerWidth - w - DRAG_MARGIN;
      const maxTop = window.innerHeight - h - DRAG_MARGIN;
      setPos({
        left: Math.max(DRAG_MARGIN, Math.min(nextLeft, maxLeft)),
        top: Math.max(DRAG_MARGIN, Math.min(nextTop, maxTop)),
      });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const nextLeft = start.left + ev.clientX - startX;
      const nextTop = start.top + ev.clientY - startY;
      const el = rootRef.current;
      const w = el?.offsetWidth ?? 0;
      const h = el?.offsetHeight ?? 0;
      const maxLeft = window.innerWidth - w - DRAG_MARGIN;
      const maxTop = window.innerHeight - h - DRAG_MARGIN;
      const finalLeft = Math.max(DRAG_MARGIN, Math.min(nextLeft, maxLeft));
      const finalTop = Math.max(DRAG_MARGIN, Math.min(nextTop, maxTop));
      onDragEnd(finalLeft, finalTop);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Per-cell color readout — supplied directly by the worker in
  // inspectCellsData so the swatch works under WebGPU direct render too
  // (where the full colors buffer is never transferred to the main thread).
  const colorRow = color;

  const attrById: Record<string, Attribute> = {};
  for (const a of cellAttrs) attrById[a.id] = a;

  return (
    <div
      ref={rootRef}
      data-sim-overlay
      className={`${styles.popover} ${pulse ? styles.pulse : ''}`}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={onFocus}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      onContextMenu={e => e.preventDefault()}
    >
      <div
        className={styles.header}
        onMouseDown={onHeaderMouseDown}
      >
        <span className={styles.coord}>Cell ({popover.row}, {popover.col})</span>
        <button
          className={styles.closeAllBtn}
          onClick={onCloseAll}
          onMouseDown={e => e.stopPropagation()}
          title={`Close all inspect popups (${totalOpen} open)`}
        >Close all</button>
        <button
          className={styles.closeBtn}
          onClick={onClose}
          onMouseDown={e => e.stopPropagation()}
          title="Close (Esc)"
        >&times;</button>
      </div>

      <div className={styles.colorRow}>
        <div
          className={styles.swatch}
          style={{ background: colorRow ? `rgb(${colorRow.r}, ${colorRow.g}, ${colorRow.b})` : 'transparent' }}
        />
        <span className={styles.colorText}>
          {colorRow
            ? `${rgbToHex(colorRow.r, colorRow.g, colorRow.b)} · RGB(${colorRow.r}, ${colorRow.g}, ${colorRow.b})`
            : '—'}
        </span>
      </div>

      <div className={styles.attrTable}>
        {orientation !== null && (
          <div className={styles.attrRow}>
            <span className={styles.attrName} title="Variegated-cells orientation (head direction)">orientation</span>
            <span className={styles.attrValue}>
              {orientation} ({ORIENTATION_NAMES[orientation & 3]})
            </span>
          </div>
        )}
        {cellAttrs.length === 0 && orientation === null && (
          <div className={styles.empty}>No cell attributes defined.</div>
        )}
        {cellAttrs.map(attr => {
          const rawValue = values?.[attr.id];
          const rawText = decodeAttrValue(rawValue, attr);
          let undefinedOverlay = false;
          if (attr.parentAttributeId) {
            const parent = attrById[attr.parentAttributeId];
            if (parent && values) {
              const ok = parentMatches(parent, values[attr.parentAttributeId], attr.parentValues);
              if (!ok) undefinedOverlay = true;
            }
          }
          return (
            <div key={attr.id} className={styles.attrRow}>
              <span className={styles.attrName} title={attr.name}>{attr.name}</span>
              {undefinedOverlay ? (
                <span className={styles.attrValue}>
                  <span className={styles.undefinedValue}>(undefined)</span>
                  <span className={styles.rawValue}>raw: {rawText}</span>
                </span>
              ) : (
                <span className={styles.attrValue}>{rawText}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface HoverLinkProps {
  cellX: number;        // viewport coords of cell top-left
  cellY: number;
  cellSize: number;
  popupRect: DOMRect | undefined;
}

export function InspectHoverLink({ cellX, cellY, cellSize, popupRect }: HoverLinkProps) {
  if (!popupRect) return null;
  const cellCenterX = cellX + cellSize / 2;
  const cellCenterY = cellY + cellSize / 2;
  // Pick the popup edge closest to the cell center, then anchor at that edge midpoint.
  const popupCenterX = popupRect.left + popupRect.width / 2;
  const popupCenterY = popupRect.top + popupRect.height / 2;
  const dx = cellCenterX - popupCenterX;
  const dy = cellCenterY - popupCenterY;
  let anchorX: number, anchorY: number;
  if (Math.abs(dx) * popupRect.height > Math.abs(dy) * popupRect.width) {
    // Side-dominant: anchor on left or right edge
    anchorX = dx > 0 ? popupRect.right : popupRect.left;
    anchorY = popupCenterY;
  } else {
    // Top/bottom-dominant
    anchorX = popupCenterX;
    anchorY = dy > 0 ? popupRect.bottom : popupRect.top;
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  return (
    <svg
      className={styles.hoverSvg}
      width={w}
      height={h}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9999 }}
    >
      <rect
        x={cellX}
        y={cellY}
        width={cellSize}
        height={cellSize}
        fill="none"
        stroke="#ffd54f"
        strokeWidth={2}
      />
      <line
        x1={anchorX}
        y1={anchorY}
        x2={cellCenterX}
        y2={cellCenterY}
        stroke="#ffd54f"
        strokeWidth={2}
        strokeDasharray="6 4"
      />
    </svg>
  );
}
