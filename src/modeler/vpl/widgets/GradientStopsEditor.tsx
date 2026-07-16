import { useState, useRef } from 'react';
import { InlineNumberInput } from './InlineWidgets';
import { ColorField } from './ColorField';
import { COLOR_SCALE_PRESETS } from '../nodes/colorScalePresets';
import { hexToRgba, rgbaToHex, rgbaToCss, OPAQUE } from '../../../model/colorHex';

/** A gradient stop. `a` is OPTIONAL — absent means opaque, which is what keeps a
 *  pre-alpha palette byte-identical through the compiler (see ColorScaleNode's
 *  `colorScaleHasAlpha`). */
export interface GradStop { p: number; r: number; g: number; b: number; a?: number; }

const CHECKER_BG =
  'repeating-conic-gradient(#3a3f4b 0% 25%, #20242c 0% 50%) 50% / 10px 10px';

const ctrlStyle: React.CSSProperties = {
  width: '100%', background: '#1a2530', color: '#cfd8dc',
  border: '1px solid #2a3a4a', borderRadius: 3, fontSize: '0.7rem', padding: '2px 4px',
  cursor: 'pointer',
};

/**
 * Reusable gradient editor: a CSS gradient bar with draggable color-stop
 * markers, a detail row for the selected stop (position + color + delete), an
 * "Add Stop" button, and a palette-preset dropdown. Stops use position in
 * [0,1]. Pure: reads `stops`, emits the full next array via `onChange`.
 * Shared by the Color Scale node and the Linked Output Mapping editor.
 */
export function GradientStopsEditor({ stops, onChange }: { stops: GradStop[]; onChange: (s: GradStop[]) => void }) {
  const [selectedStopIdx, setSelectedStopIdx] = useState<number>(0);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ idx: number; startX: number; startP: number; barWidth: number } | null>(null);

  const safeIdx = Math.min(Math.max(0, selectedStopIdx), Math.max(0, stops.length - 1));
  const selStop = stops[safeIdx];
  const stopDrag = (e: React.MouseEvent) => { if (e.button === 0) e.stopPropagation(); };

  const updateStop = (i: number, patch: Partial<GradStop>) => {
    onChange(stops.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  // Samples r/g/b AND alpha, so a stop added mid-gradient inherits the local
  // transparency instead of silently snapping to opaque. `a` is returned only
  // when some stop declares one — an unconditional `a` would make every palette
  // "have alpha" and defeat the compiler's byte-identity gate.
  const anyAlpha = stops.some(s => s.a !== undefined && s.a !== OPAQUE);
  const pick = (s: GradStop) => (anyAlpha ? { r: s.r, g: s.g, b: s.b, a: s.a ?? OPAQUE } : { r: s.r, g: s.g, b: s.b });
  const sampleAt = (p: number): { r: number; g: number; b: number; a?: number } => {
    if (stops.length === 0) return { r: 0, g: 0, b: 0 };
    const sorted = [...stops].sort((a, b) => a.p - b.p);
    if (p <= sorted[0]!.p) return pick(sorted[0]!);
    if (p >= sorted[sorted.length - 1]!.p) return pick(sorted[sorted.length - 1]!);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (p < b.p && b.p !== a.p) {
        const t = (p - a.p) / (b.p - a.p);
        const lerp = (x: number, y: number) => Math.round(x + t * (y - x));
        const out: { r: number; g: number; b: number; a?: number } = {
          r: lerp(a.r, b.r), g: lerp(a.g, b.g), b: lerp(a.b, b.b),
        };
        if (anyAlpha) out.a = lerp(a.a ?? OPAQUE, b.a ?? OPAQUE);
        return out;
      }
    }
    return { r: 0, g: 0, b: 0 };
  };

  const addStop = () => {
    const sorted = [...stops].sort((a, b) => a.p - b.p);
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    let np = 0.5;
    let sample: { r: number; g: number; b: number; a?: number } = { r: 128, g: 128, b: 128 };
    if (last && prev) {
      np = (last.p + prev.p) / 2;
      sample = sampleAt(np);
    } else if (last) {
      np = Math.min(1, last.p + 0.1);
      sample = pick(last);
    }
    const next = [...stops, { p: np, ...sample }];
    onChange(next);
    setSelectedStopIdx(next.length - 1);
  };

  const deleteStop = (i: number) => {
    if (stops.length <= 2) return;
    const next = stops.filter((_, j) => j !== i);
    onChange(next);
    setSelectedStopIdx(Math.max(0, Math.min(i, next.length - 1)));
  };

  const applyPreset = (name: string) => {
    const preset = COLOR_SCALE_PRESETS.find(x => x.name === name);
    if (!preset) return;
    // Presets carry no alpha (PresetStop is RGB-only), so applying one resets the
    // scale to the fully-opaque form — which is also the byte-identical compiler
    // path. Deliberate: a preset is a colour ramp, not a transparency design.
    onChange(preset.stops.map(s => ({ p: s.position, r: s.r, g: s.g, b: s.b })));
    setSelectedStopIdx(0);
  };

  const sortedForCss = [...stops].sort((a, b) => a.p - b.p);
  const gradStops = sortedForCss.length === 0
    ? 'rgba(0,0,0,1.000)'
    : sortedForCss
        .map(s => `${rgbaToCss(s)} ${Math.max(0, Math.min(1, s.p)) * 100}%`)
        .join(', ');
  // The gradient composites OVER a checkerboard, so a transparent run reads as
  // transparent rather than as black.
  const barBg = `linear-gradient(to right, ${gradStops}), ${CHECKER_BG}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} onMouseDown={stopDrag}>
      <select
        value=""
        onChange={e => applyPreset(e.target.value)}
        onMouseDown={stopDrag}
        onClick={e => e.stopPropagation()}
        style={ctrlStyle}
        title="Apply a preset palette (replaces the current stops)"
      >
        <option value="">Preset palette…</option>
        {COLOR_SCALE_PRESETS.map(p => (
          <option key={p.name} value={p.name}>{p.name}</option>
        ))}
      </select>

      <div
        ref={barRef}
        style={{
          position: 'relative', height: 22, width: '100%', background: barBg,
          border: '1px solid #2a3a4a', borderRadius: 3, cursor: 'crosshair',
        }}
        onMouseDown={stopDrag}
        onClick={(e) => {
          if (!barRef.current || dragRef.current) return;
          if (e.target !== barRef.current) return;
          const rect = barRef.current.getBoundingClientRect();
          const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const sampled = sampleAt(p);
          const next = [...stops, { p, ...sampled }];
          onChange(next);
          setSelectedStopIdx(next.length - 1);
        }}
      >
        {stops.map((s, i) => (
          <div
            key={i}
            style={{
              position: 'absolute', left: `calc(${Math.max(0, Math.min(1, s.p)) * 100}% - 6px)`,
              top: -3, width: 12, height: 28,
              background: `linear-gradient(${rgbaToCss(s)}, ${rgbaToCss(s)}), ${CHECKER_BG}`,
              border: i === safeIdx ? '2px solid #4cc9f0' : '1px solid #cfd8dc',
              borderRadius: 2, cursor: 'grab', boxSizing: 'border-box',
            }}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              if (!barRef.current) return;
              const rect = barRef.current.getBoundingClientRect();
              dragRef.current = { idx: i, startX: e.clientX, startP: s.p, barWidth: rect.width };
              setSelectedStopIdx(i);
              const onMove = (ev: MouseEvent) => {
                const d = dragRef.current;
                if (!d) return;
                const dp = (ev.clientX - d.startX) / d.barWidth;
                const newP = Math.max(0, Math.min(1, d.startP + dp));
                updateStop(d.idx, { p: newP });
              };
              const onUp = () => {
                dragRef.current = null;
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
            onClick={(e) => { e.stopPropagation(); setSelectedStopIdx(i); }}
            title={`Stop ${i}: pos ${s.p.toFixed(3)}, ${rgbaToHex(s)}`}
          />
        ))}
      </div>

      {selStop && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <InlineNumberInput
            min={0} max={1} step={0.01}
            value={String(selStop.p)}
            onChange={(v) => updateStop(safeIdx, { p: parseFloat(v) || 0 })}
            onMouseDown={stopDrag}
            style={{ ...ctrlStyle, width: 52, flex: '0 0 auto', textAlign: 'center' }}
            title="Stop position (0–1)"
          />
          <ColorField
            value={rgbaToHex(selStop)}
            onChange={(hex) => {
              const n = hexToRgba(hex);
              // Write `a` only when non-opaque, so an opaque stop keeps no alpha
              // key at all and the compiler stays on its pre-alpha path.
              updateStop(safeIdx, n.a === OPAQUE
                ? { r: n.r, g: n.g, b: n.b, a: undefined }
                : { r: n.r, g: n.g, b: n.b, a: n.a });
            }}
            style={{ height: 24, flex: 1 }}
            title={`Stop colour — ${rgbaToHex(selStop)}`}
          />
          <button
            onClick={() => deleteStop(safeIdx)}
            disabled={stops.length <= 2}
            style={{
              background: 'none', border: 'none',
              color: stops.length <= 2 ? '#586060' : '#f44336',
              cursor: stops.length <= 2 ? 'not-allowed' : 'pointer',
              fontSize: '0.7rem', padding: '0 2px',
            }}
            title={stops.length <= 2 ? 'A scale must have at least 2 stops' : 'Delete this stop'}
          >x</button>
        </div>
      )}

      <button style={{ ...ctrlStyle, textAlign: 'center' }} onClick={addStop} onMouseDown={stopDrag}>
        + Add Stop
      </button>
    </div>
  );
}
