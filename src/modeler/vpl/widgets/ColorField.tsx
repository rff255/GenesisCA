import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hexToRgba, rgbaToHex, rgbaToCss, hexRgbPart, isOpaque, OPAQUE } from '../../../model/colorHex';

/**
 * ColorField — THE colour control for every engine-path picker.
 *
 * A checkerboard-backed swatch button rendering the true `rgba()` composite
 * (alpha is *visible*, not a number to read), which opens a popover containing
 * the native RGB picker + an alpha slider.
 *
 * ── Why not `<input type="color" alpha>`? (measured, not assumed) ─────────────
 * The HTML spec added an `alpha` attribute, but it is **Safari 18.4+ only —
 * ~12.6% global; Chrome ✗ through 150, Edge ✗, Firefox ✗**. Probed directly in a
 * Chrome 148 renderer:
 *
 *     'alpha' in input   →  false
 *     value = '#ff000080'  →  '#ff0000'      // silently TRUNCATED, no error
 *
 * Two reasons it is unusable here: (1) it would light up only in the browser
 * where GenesisCA is *least* capable (WebGPU + the Tauri shell are Chromium-bound)
 * and stay dark for the Chromium users who are the actual audience; (2) it fails
 * SILENTLY — an 8-digit hex is truncated, not rejected. A progressive-enhancement
 * branch would give ~87% of users a different control AND still require this
 * fallback to exist, i.e. more code for worse consistency.
 *
 * So the native element is used ONLY as the RGB sub-control (fed `hexRgbPart`,
 * which is all it can represent), and alpha is carried alongside it. Alpha is
 * never round-tripped through the element.
 *
 * This replaces seven bespoke swatch layouts, and with them three divergent
 * hex-helper pairs — see colorHex.ts.
 *
 * ── The popover is PORTALLED to document.body (load-bearing) ──────────────────
 * It is `position: fixed` at measured viewport coords, which is only correct
 * when no ancestor is transformed: a `transform` makes that element the
 * containing block for its fixed descendants. VPL nodes live inside React
 * Flow's `.react-flow__viewport`, which carries `transform: translate(…)
 * scale(…)` — so an in-tree popover was offset by the pan/zoom (and scaled) on
 * every canvas node, while the panel sites (no transformed ancestor) looked
 * fine. The portal escapes the transform, so ONE positioning path serves both.
 */

const CHECKER_BG =
  'repeating-conic-gradient(#3a3f4b 0% 25%, #20242c 0% 50%) 50% / 10px 10px';

const ctrlStyle: React.CSSProperties = {
  background: '#1a2530', color: '#cfd8dc',
  border: '1px solid #2a3a4a', borderRadius: 3, fontSize: '0.7rem', padding: '2px 4px',
};

export interface ColorFieldProps {
  /** Current colour as `#rrggbb` (opaque) or `#rrggbbaa`. */
  value: string;
  /** Emits the next colour. Opaque values come back as 6-digit (`rgbaToHex`), so
   *  a colour that never touches alpha round-trips to its original string. */
  onChange: (hex: string) => void;
  /** Hide the alpha slider (RGB-only site). Default false. */
  noAlpha?: boolean;
  title?: string;
  /** Extra style for the swatch button (e.g. `flex: 1`). */
  style?: React.CSSProperties;
  disabled?: boolean;
}

export function ColorField({ value, onChange, noAlpha, title, style, disabled }: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const c = hexToRgba(value);

  // Position the popover under the swatch, clamped to the viewport. Measured
  // AFTER first paint (mirrors NameInputDialog): a pre-measure frame has no size.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    const w = 208, h = noAlpha ? 96 : 132;
    setPos({
      x: Math.max(6, Math.min(window.innerWidth - w - 6, r.left)),
      y: Math.max(6, Math.min(window.innerHeight - h - 6, r.bottom + 4)),
    });
  }, [open, noAlpha]);

  // Close on outside press / Escape. Capture-phase so a press that starts a drag
  // elsewhere still dismisses (the GraphEditor context-menu lesson). An outside
  // WHEEL closes too: the popover is measured once at open, so a canvas zoom (or
  // a panel scroll) would slide the swatch out from under it — a pan already
  // dismisses via the pointerdown, but a wheel fires none.
  useEffect(() => {
    if (!open) return;
    const outside = (t: globalThis.Node | null) =>
      !popRef.current?.contains(t) && !btnRef.current?.contains(t);
    const onDown = (e: PointerEvent) => { if (outside(e.target as globalThis.Node | null)) setOpen(false); };
    const onWheel = (e: WheelEvent) => { if (outside(e.target as globalThis.Node | null)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('wheel', onWheel, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const setRgb = (hex: string) => {
    const n = hexToRgba(hex);
    onChange(rgbaToHex({ r: n.r, g: n.g, b: n.b, a: c.a }));
  };
  const setAlpha = (a: number) => onChange(rgbaToHex({ r: c.r, g: c.g, b: c.b, a }));

  // Nodes live on a React-Flow drag surface; a bare mousedown would start a node
  // drag instead of opening the popover.
  const stopDrag = (e: React.MouseEvent) => { if (e.button === 0) e.stopPropagation(); };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="nodrag"
        disabled={disabled}
        title={title ?? `${rgbaToHex(c)} — click to edit`}
        onMouseDown={stopDrag}
        onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen(o => !o); }}
        style={{
          height: 22, minWidth: 30, padding: 0, borderRadius: 3,
          border: '1px solid #3a3f4b', background: CHECKER_BG,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
          overflow: 'hidden', ...style,
        }}
      >
        {/* The composite sits ON the checkerboard, so alpha reads at a glance. */}
        <span style={{ display: 'block', width: '100%', height: '100%', background: rgbaToCss(c) }} />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          className="nodrag"
          onMouseDown={stopDrag}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: pos.x, top: pos.y, width: 208, zIndex: 10000,
            background: '#15171c', border: '1px solid #2a3a4a', borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.5)', padding: 8,
            display: 'flex', flexDirection: 'column', gap: 6,
          }}
        >
          <label style={{ fontSize: '0.62rem', color: '#9aa0ac' }}>RGB</label>
          <input
            type="color"
            /* Fed the 6-digit part ONLY — the element cannot hold alpha and would
               silently truncate an 8-digit value. */
            value={hexRgbPart(value)}
            onChange={(e) => setRgb(e.target.value)}
            style={{ width: '100%', height: 26, padding: 1, cursor: 'pointer', ...ctrlStyle }}
          />

          {!noAlpha && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '0.62rem', color: '#9aa0ac' }}>Alpha</label>
                <span style={{ fontSize: '0.62rem', color: '#e8a13a', fontFamily: 'ui-monospace, monospace' }}>
                  {c.a}{isOpaque(c) ? ' (opaque)' : ''}
                </span>
              </div>
              <div style={{ position: 'relative', height: 14, borderRadius: 7, background: CHECKER_BG, border: '1px solid #3a3f4b' }}>
                {/* transparent → opaque preview of THIS colour, under the thumb */}
                <span style={{
                  position: 'absolute', inset: 0, borderRadius: 6,
                  background: `linear-gradient(to right, ${rgbaToCss({ ...c, a: 0 })}, ${rgbaToCss({ ...c, a: OPAQUE })})`,
                }} />
                <input
                  type="range" min={0} max={255} step={1} value={c.a}
                  onChange={(e) => setAlpha(parseInt(e.target.value, 10))}
                  style={{ position: 'absolute', inset: 0, width: '100%', margin: 0, opacity: 0.9, cursor: 'pointer' }}
                  title="Alpha (0 = fully transparent, 255 = opaque)"
                />
              </div>
            </>
          )}

          <div style={{
            ...ctrlStyle, textAlign: 'center', fontFamily: 'ui-monospace, monospace',
            userSelect: 'text', padding: '3px 4px',
          }}>
            {rgbaToHex(c)}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
