import type { NodeTypeDef } from '../types';
import {
  DEFAULT_INTERPOLATION_METHOD,
  curvedTVarName,
  emitInterpolationCurveJS,
} from './interpolationMethods';

export interface ColorScaleStop { p: number; r: number; g: number; b: number; }

/** Parse stop_${i}_(position|r|g|b) keys from config and sort by position.
 *  Exported so the WASM and WebGPU emitters can reuse the same parser. */
export function readColorScaleStops(
  config: Record<string, string | number | boolean>,
): ColorScaleStop[] {
  const n = Math.max(0, Number(config.stopCount) || 0);
  const stops: ColorScaleStop[] = [];
  for (let i = 0; i < n; i++) {
    const p = Number(config[`stop_${i}_position`]);
    stops.push({
      p: Number.isFinite(p) ? p : 0,
      r: (parseInt(String(config[`stop_${i}_r`] ?? '0'), 10) || 0) | 0,
      g: (parseInt(String(config[`stop_${i}_g`] ?? '0'), 10) || 0) | 0,
      b: (parseInt(String(config[`stop_${i}_b`] ?? '0'), 10) || 0) | 0,
    });
  }
  stops.sort((a, b) => a.p - b.p);
  return stops;
}

export const ColorScaleNode: NodeTypeDef = {
  type: 'colorScale',
  label: 'Color Scale',
  description:
    'Maps a position t in [0, 1] to an RGB color via N color stops and a selectable curve. '
    + 'Replaces the legacy Color Interpolation node.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 't', label: 'Position', kind: 'input', category: 'value', dataType: 'float',
      inlineWidget: 'number', defaultValue: '0.5' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {
    method: DEFAULT_INTERPOLATION_METHOD,
    stopCount: 2,
    stop_0_position: '0',   stop_0_r: '0',   stop_0_g: '0',   stop_0_b: '0',
    stop_1_position: '1',   stop_1_r: '255', stop_1_g: '255', stop_1_b: '255',
  },
  compile: (nodeId, config, inputs) => {
    const t = inputs['t'] || '0.5';
    const method = (config.method as string) || DEFAULT_INTERPOLATION_METHOD;
    const stops = readColorScaleStops(config);
    const rVar = `_v${nodeId}_r`;
    const gVar = `_v${nodeId}_g`;
    const bVar = `_v${nodeId}_b`;

    if (stops.length === 0) {
      return `const ${rVar} = 0; const ${gVar} = 0; const ${bVar} = 0;\n`;
    }
    if (stops.length === 1) {
      const s = stops[0]!;
      return `const ${rVar} = ${s.r | 0}; const ${gVar} = ${s.g | 0}; const ${bVar} = ${s.b | 0};\n`;
    }

    const tRaw = `_v${nodeId}_tRaw`;
    const lines: string[] = [];
    lines.push(`let ${rVar}, ${gVar}, ${bVar};`);
    lines.push(`const ${tRaw} = (${t});`);
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    lines.push(
      `if (${tRaw} <= ${first.p}) { ${rVar} = ${first.r | 0}; ${gVar} = ${first.g | 0}; ${bVar} = ${first.b | 0}; }`,
    );
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i]!;
      const b = stops[i + 1]!;
      if (b.p === a.p) continue;
      const segId = `${nodeId}_${i}`;
      const localT = `((${tRaw} - ${a.p}) / ${b.p - a.p})`;
      const curveSetup = emitInterpolationCurveJS(segId, localT, method);
      const tf = curvedTVarName(segId);
      lines.push(
        `else if (${tRaw} < ${b.p}) { ${curveSetup} `
        + `${rVar} = Math.round((${a.r | 0}) + ${tf} * ((${b.r | 0}) - (${a.r | 0}))); `
        + `${gVar} = Math.round((${a.g | 0}) + ${tf} * ((${b.g | 0}) - (${a.g | 0}))); `
        + `${bVar} = Math.round((${a.b | 0}) + ${tf} * ((${b.b | 0}) - (${a.b | 0}))); }`,
      );
    }
    lines.push(
      `else { ${rVar} = ${last.r | 0}; ${gVar} = ${last.g | 0}; ${bVar} = ${last.b | 0}; }`,
    );
    return lines.join(' ') + '\n';
  },
};
