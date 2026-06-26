import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

interface ClipIntervalSliderProps {
  lo: number;
  hi: number;
  min: number;
  max: number;
  step?: number;
  /** Called with the (already lo ≤ hi clamped) new bounds on every drag tick. */
  onChange: (lo: number, hi: number) => void;
}

/**
 * Dual-thumb range slider for the 3D clip interval: two handles on ONE track with
 * a filled band between them. Dragging a handle moves just that bound; **dragging
 * the band moves BOTH bounds together at constant width**, so the user can "swoop"
 * a fixed-width clipping window back and forth through the volume (the convenient
 * gesture the two-separate-sliders layout couldn't do). A click on the bare track
 * jumps the nearer handle to the cursor. Controlled — all state lives in the parent
 * `clip3d`; this only emits `onChange(lo, hi)`.
 *
 * Pointer handling uses window-level move/up listeners (not setPointerCapture) so a
 * fast drag that leaves the thin track keeps tracking. Every emitted (lo, hi) is
 * snapped to `step` and clamped to [min, max] with lo ≤ hi, so the parent can set
 * state verbatim.
 */
export function ClipIntervalSlider({ lo, hi, min, max, step = 0.5, onChange }: ClipIntervalSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: 'lo' | 'hi' | 'band'; startX: number; startLo: number; startHi: number } | null>(null);

  const range = max - min || 1;
  const snap = (v: number) => Math.round(v / step) * step;
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const pct = (v: number) => `${clamp((v - min) / range, 0, 1) * 100}%`;

  const beginDrag = (mode: 'lo' | 'hi' | 'band', clientX: number, seedThumbToCursor: boolean) => {
    const track = trackRef.current;
    if (!track) return;
    let curLo = lo, curHi = hi;
    if (seedThumbToCursor && mode !== 'band') {
      const r = track.getBoundingClientRect();
      const v = snap(clamp(min + ((clientX - r.left) / (r.width || 1)) * range, min, max));
      if (mode === 'lo') curLo = clamp(v, min, hi);
      else curHi = clamp(v, lo, max);
      onChange(curLo, curHi);
    }
    dragRef.current = { mode, startX: clientX, startLo: curLo, startHi: curHi };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current, tr = trackRef.current;
      if (!d || !tr) return;
      const w = tr.getBoundingClientRect().width || 1;
      const dv = ((ev.clientX - d.startX) / w) * range;
      if (d.mode === 'band') {
        // Preserve the window width; clamp the shift so neither bound leaves [min,max].
        const width = d.startHi - d.startLo;
        const shift = clamp(snap(dv), min - d.startLo, max - d.startHi);
        onChange(d.startLo + shift, d.startLo + shift + width);
      } else if (d.mode === 'lo') {
        onChange(clamp(snap(d.startLo + dv), min, d.startHi), d.startHi);
      } else {
        onChange(d.startLo, clamp(snap(d.startHi + dv), d.startLo, max));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const stop = (e: ReactPointerEvent) => { e.preventDefault(); e.stopPropagation(); };
  const thumbStyle = (v: number): CSSProperties => ({
    position: 'absolute', left: pct(v), top: '50%', transform: 'translate(-50%, -50%)',
    width: 13, height: 13, borderRadius: '50%',
    background: 'var(--color-accent, #e8a13a)', border: '2px solid var(--color-bg-panel, #16181d)',
    boxShadow: '0 0 0 1px var(--color-accent, #e8a13a)', cursor: 'ew-resize',
    touchAction: 'none', zIndex: 2,
  });

  return (
    <div>
      <div
        ref={trackRef}
        style={{ position: 'relative', height: 22, cursor: 'pointer', touchAction: 'none' }}
        onPointerDown={(e: ReactPointerEvent) => {
          // Bare-track click: jump the NEARER handle to the cursor and drag it.
          const r = e.currentTarget.getBoundingClientRect();
          const v = min + ((e.clientX - r.left) / (r.width || 1)) * range;
          const mode = Math.abs(v - lo) <= Math.abs(v - hi) ? 'lo' : 'hi';
          stop(e);
          beginDrag(mode, e.clientX, true);
        }}
      >
        {/* rail */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 3, transform: 'translateY(-50%)', background: 'var(--color-widget-border, #444)', borderRadius: 2 }} />
        {/* draggable band (the clip window) */}
        <div
          style={{ position: 'absolute', left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})`, top: '50%', height: 7, transform: 'translateY(-50%)', background: 'var(--color-accent, #e8a13a)', opacity: 0.55, borderRadius: 2, cursor: 'grab', touchAction: 'none', zIndex: 1 }}
          title="Drag the band to swoop the clip window through the volume (both bounds move together)"
          onPointerDown={(e: ReactPointerEvent) => { stop(e); beginDrag('band', e.clientX, false); }}
        />
        <div style={thumbStyle(lo)} title="Near bound — drag to resize the clip window" onPointerDown={(e: ReactPointerEvent) => { stop(e); beginDrag('lo', e.clientX, false); }} />
        <div style={thumbStyle(hi)} title="Far bound — drag to resize the clip window" onPointerDown={(e: ReactPointerEvent) => { stop(e); beginDrag('hi', e.clientX, false); }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.58rem', color: '#888' }}>
        <span>{lo.toFixed(1)}</span>
        <span style={{ color: '#aaa' }}>width {(hi - lo).toFixed(1)}</span>
        <span>{hi.toFixed(1)}</span>
      </div>
    </div>
  );
}
