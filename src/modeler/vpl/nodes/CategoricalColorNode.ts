import type { NodeTypeDef } from '../types';

export interface CategoricalEntry { r: number; g: number; b: number; }

/** Parse entry_${i}_(r|g|b) keys (i in [0, count)) into a dense palette.
 *  Exported so the WASM and WebGPU emitters reuse the same parser. */
export function readCategoricalEntries(
  config: Record<string, string | number | boolean>,
): CategoricalEntry[] {
  const n = Math.max(0, Number(config.count) || 0);
  const out: CategoricalEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      r: (parseInt(String(config[`entry_${i}_r`] ?? '0'), 10) || 0) | 0,
      g: (parseInt(String(config[`entry_${i}_g`] ?? '0'), 10) || 0) | 0,
      b: (parseInt(String(config[`entry_${i}_b`] ?? '0'), 10) || 0) | 0,
    });
  }
  return out;
}

/** The color used when the index is out of the palette's range. */
export function readCategoricalDefault(
  config: Record<string, string | number | boolean>,
): CategoricalEntry {
  return {
    r: (parseInt(String(config.default_r ?? '0'), 10) || 0) | 0,
    g: (parseInt(String(config.default_g ?? '0'), 10) || 0) | 0,
    b: (parseInt(String(config.default_b ?? '0'), 10) || 0) | 0,
  };
}

export const CategoricalColorNode: NodeTypeDef = {
  type: 'categoricalColor',
  label: 'Categorical Color',
  description:
    'Maps an integer index to a flat RGB color from an N-entry palette (no blending). '
    + 'Index i selects entry i; out-of-range indices use the default color.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer',
      inlineWidget: 'number', defaultValue: '0' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { count: 0, default_r: '0', default_g: '0', default_b: '0' },
  compile: (nodeId, config, inputs) => {
    const idx = inputs['index'] || '0';
    const entries = readCategoricalEntries(config);
    const d = readCategoricalDefault(config);
    const rVar = `_v${nodeId}_r`;
    const gVar = `_v${nodeId}_g`;
    const bVar = `_v${nodeId}_b`;

    if (entries.length === 0) {
      return `const ${rVar} = ${d.r | 0}; const ${gVar} = ${d.g | 0}; const ${bVar} = ${d.b | 0};\n`;
    }

    const kVar = `_v${nodeId}_k`;
    const lines: string[] = [];
    lines.push(`let ${rVar}, ${gVar}, ${bVar};`);
    lines.push(`const ${kVar} = (${idx}) | 0;`);
    entries.forEach((e, i) => {
      const head = i === 0 ? `if (${kVar} === ${i})` : `else if (${kVar} === ${i})`;
      lines.push(`${head} { ${rVar} = ${e.r | 0}; ${gVar} = ${e.g | 0}; ${bVar} = ${e.b | 0}; }`);
    });
    lines.push(`else { ${rVar} = ${d.r | 0}; ${gVar} = ${d.g | 0}; ${bVar} = ${d.b | 0}; }`);
    return lines.join(' ') + '\n';
  },
};
