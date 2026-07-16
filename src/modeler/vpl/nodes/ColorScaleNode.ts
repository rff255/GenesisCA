import type { NodeTypeDef } from '../types';
import { OPAQUE, isOpaque } from '../../../model/colorHex';
import {
  DEFAULT_INTERPOLATION_METHOD,
  curvedTVarName,
  emitInterpolationCurveJS,
} from './interpolationMethods';

/** A parsed Color Scale stop. `a` is OPTIONAL: absent means the stop declares no
 *  alpha at all — the distinction that keeps a pre-alpha palette byte-identical
 *  (see {@link colorScaleHasAlpha}). */
export interface ColorScaleStop { p: number; r: number; g: number; b: number; a?: number; }

/** Parse stop_${i}_(position|r|g|b|a) keys from config and sort by position.
 *  Exported so the WASM and WebGPU emitters can reuse the same parser. */
export function readColorScaleStops(
  config: Record<string, string | number | boolean>,
): ColorScaleStop[] {
  const n = Math.max(0, Number(config.stopCount) || 0);
  const stops: ColorScaleStop[] = [];
  for (let i = 0; i < n; i++) {
    const p = Number(config[`stop_${i}_position`]);
    const rawA = config[`stop_${i}_a`];
    stops.push({
      p: Number.isFinite(p) ? p : 0,
      r: (parseInt(String(config[`stop_${i}_r`] ?? '0'), 10) || 0) | 0,
      g: (parseInt(String(config[`stop_${i}_g`] ?? '0'), 10) || 0) | 0,
      b: (parseInt(String(config[`stop_${i}_b`] ?? '0'), 10) || 0) | 0,
      // An ABSENT key ⇒ undefined (NOT 255). `colorScaleHasAlpha` reads that
      // distinction to decide whether this node has an alpha channel at all.
      a: rawA === undefined ? undefined : ((parseInt(String(rawA), 10) || 0) | 0),
    });
  }
  stops.sort((a, b) => a.p - b.p);
  return stops;
}

/** Does this palette declare a non-opaque alpha anywhere?
 *
 *  ── THE BYTE-IDENTITY GATE (Option A — docs/IMPACT_MAP_RGBA_COLORS.md) ────────
 *  A multi-output node emits all its ports together, so an unconditional
 *  `_v<id>_a` would add a dead const to every existing model with a linked
 *  float/integer output mapping. Harmless at runtime — but it would turn the
 *  `check-compile-identity.mjs` baseline red across ~10 models and burn the
 *  cheapest regression net this change has.
 *
 *  So: false ⇒ the `a` OUTPUT PORT is hidden (`hiddenPorts`) AND the emit is the
 *  verbatim pre-alpha three-channel form. An all-opaque palette is byte-identical
 *  by construction. An explicit 255 counts as opaque, so dragging alpha to full
 *  and back leaves no trace.
 *
 *  Shared by `hiddenPorts`, all five compilers, and the linked-OM injector, so the
 *  port's existence and the emit can never disagree. */
export function colorScaleHasAlpha(
  config: Record<string, string | number | boolean>,
): boolean {
  return readColorScaleStops(config).some(s => !isOpaque(s));
}

export const ColorScaleNode: NodeTypeDef = {
  type: 'colorScale',
  label: 'Color Scale',
  description:
    'Maps a position t in [0, 1] to an RGB(A) color via N color stops and a selectable curve. '
    + 'The A output appears once any stop declares a non-opaque alpha.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 't', label: 'Position', kind: 'input', category: 'value', dataType: 'float',
      inlineWidget: 'number', defaultValue: '0.5' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'a', label: 'A', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {
    method: DEFAULT_INTERPOLATION_METHOD,
    stopCount: 2,
    stop_0_position: '0',   stop_0_r: '0',   stop_0_g: '0',   stop_0_b: '0',
    stop_1_position: '1',   stop_1_r: '255', stop_1_g: '255', stop_1_b: '255',
  },
  // Option A: the alpha channel exists only when the palette declares one, so an
  // opaque scale keeps its historical 3-port shape and 3-var emit.
  hiddenPorts: (config) => colorScaleHasAlpha(config) ? [] : ['a'],
  compile: (nodeId, config, inputs) => {
    const t = inputs['t'] || '0.5';
    const method = (config.method as string) || DEFAULT_INTERPOLATION_METHOD;
    const stops = readColorScaleStops(config);
    const withA = colorScaleHasAlpha(config);

    // Channel table — r/g/b always, `a` only when declared. EVERY emit branch
    // walks this list, so the opaque path reproduces the pre-alpha string exactly
    // (verified by check-compile-identity.mjs, not by eye).
    const chans: Array<{ v: string; get: (s: ColorScaleStop) => number }> = [
      { v: `_v${nodeId}_r`, get: s => s.r | 0 },
      { v: `_v${nodeId}_g`, get: s => s.g | 0 },
      { v: `_v${nodeId}_b`, get: s => s.b | 0 },
    ];
    if (withA) chans.push({ v: `_v${nodeId}_a`, get: s => (s.a ?? OPAQUE) | 0 });

    if (stops.length === 0) {
      // No stops ⇒ no alpha can be declared ⇒ withA is false ⇒ three channels.
      return chans.map(c => `const ${c.v} = 0;`).join(' ') + '\n';
    }
    if (stops.length === 1) {
      const s = stops[0]!;
      return chans.map(c => `const ${c.v} = ${c.get(s)};`).join(' ') + '\n';
    }

    const tRaw = `_v${nodeId}_tRaw`;
    const lines: string[] = [];
    lines.push(`let ${chans.map(c => c.v).join(', ')};`);
    lines.push(`const ${tRaw} = (${t});`);
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    lines.push(
      `if (${tRaw} <= ${first.p}) { ${chans.map(c => `${c.v} = ${c.get(first)}; `).join('')}}`,
    );
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i]!;
      const b = stops[i + 1]!;
      if (b.p === a.p) continue;
      const segId = `${nodeId}_${i}`;
      const localT = `((${tRaw} - ${a.p}) / ${b.p - a.p})`;
      const curveSetup = emitInterpolationCurveJS(segId, localT, method);
      const tf = curvedTVarName(segId);
      // Alpha interpolates on the SAME curve as the colour channels (straight,
      // non-premultiplied) — matching GradientStopsEditor's preview sampling.
      const body = chans
        .map(c => `${c.v} = Math.round((${c.get(a)}) + ${tf} * ((${c.get(b)}) - (${c.get(a)}))); `)
        .join('');
      lines.push(`else if (${tRaw} < ${b.p}) { ${curveSetup} ${body}}`);
    }
    lines.push(`else { ${chans.map(c => `${c.v} = ${c.get(last)}; `).join('')}}`);
    return lines.join(' ') + '\n';
  },
};
