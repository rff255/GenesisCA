import { useCallback, useEffect, useId, useRef } from 'react';
import { LIGHT_BALL_MAX_R } from './render/gl3d';

interface Props {
  /** Light position on the unit disc (view space: +x right, +y up). The
   *  implied +z (toward the viewer) is √(1−bx²−by²) — front hemisphere only. */
  bx: number;
  by: number;
  size?: number;
  onChange: (bx: number, by: number) => void;
}

/** Dot travel radius as a fraction of the ball radius. Defined in gl3d.ts so
 *  DEFAULT_LIGHT3D (which sits at this exact radius, top-left) and this clamp
 *  can never drift apart. */
const DOT_R = LIGHT_BALL_MAX_R;

/** Draggable "sun position" ball — the standard light-direction widget: a
 *  shaded sphere whose highlight follows the light dot. Drag the dot (or click
 *  anywhere on the ball) to aim the key light; the position clamps to the
 *  disc. Window-level pointer listeners (not setPointerCapture) so a fast drag
 *  off the small widget keeps tracking, mirroring ClipIntervalSlider. */
export function LightBallWidget({ bx, by, size = 64, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const gradId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const applyFromClient = useCallback((clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = ((clientX - r.left) / r.width) * 2 - 1;
    let y = 1 - ((clientY - r.top) / r.height) * 2;
    const len = Math.hypot(x, y);
    if (len > DOT_R) { x = (x / len) * DOT_R; y = (y / len) * DOT_R; }
    onChangeRef.current(x, y);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      applyFromClient(e.clientX, e.clientY);
    };
    const up = () => { draggingRef.current = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [applyFromClient]);

  const R = size / 2;
  const ballR = R - 2;
  const dotX = R + bx * ballR * DOT_R;
  const dotY = R - by * ballR * DOT_R;
  // The gradient highlight tracks the dot so the ball previews the shading.
  const fx = 0.5 + bx * 0.35;
  const fy = 0.5 - by * 0.35;

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      style={{ cursor: 'grab', touchAction: 'none', flex: '0 0 auto' }}
      onPointerDown={e => {
        e.preventDefault();
        e.stopPropagation();
        draggingRef.current = true;
        applyFromClient(e.clientX, e.clientY);
      }}
    >
      <defs>
        <radialGradient id={gradId} cx={fx} cy={fy} r="0.95">
          <stop offset="0%" stopColor="#eef2f8" />
          <stop offset="45%" stopColor="#7b8494" />
          <stop offset="100%" stopColor="#1c2027" />
        </radialGradient>
      </defs>
      <circle cx={R} cy={R} r={ballR} fill={`url(#${gradId})`} stroke="var(--color-widget-border, #444)" strokeWidth="1" />
      <circle cx={dotX} cy={dotY} r={4} fill="#ffd77a" stroke="#111" strokeWidth="1" />
    </svg>
  );
}
