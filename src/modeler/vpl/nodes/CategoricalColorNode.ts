import type { NodeTypeDef } from '../types';
import { OPAQUE, isOpaque } from '../../../model/colorHex';

/** A parsed Categorical Color palette entry. `a` is OPTIONAL: absent means the
 *  entry declares no alpha at all — the distinction that keeps a pre-alpha
 *  palette byte-identical (see {@link categoricalHasAlpha}). */
export interface CategoricalEntry { r: number; g: number; b: number; a?: number; }

/** Read one `<prefix>_(r|g|b|a)` colour out of config. */
function readEntry(
  config: Record<string, string | number | boolean>,
  prefix: string,
): CategoricalEntry {
  const rawA = config[`${prefix}_a`];
  return {
    r: (parseInt(String(config[`${prefix}_r`] ?? '0'), 10) || 0) | 0,
    g: (parseInt(String(config[`${prefix}_g`] ?? '0'), 10) || 0) | 0,
    b: (parseInt(String(config[`${prefix}_b`] ?? '0'), 10) || 0) | 0,
    // ABSENT ⇒ undefined (NOT 255) — `categoricalHasAlpha` reads the distinction.
    a: rawA === undefined ? undefined : ((parseInt(String(rawA), 10) || 0) | 0),
  };
}

/** Parse entry_${i}_(r|g|b|a) keys (i in [0, count)) into a dense palette.
 *  Exported so the WASM and WebGPU emitters reuse the same parser. */
export function readCategoricalEntries(
  config: Record<string, string | number | boolean>,
): CategoricalEntry[] {
  const n = Math.max(0, Number(config.count) || 0);
  const out: CategoricalEntry[] = [];
  for (let i = 0; i < n; i++) out.push(readEntry(config, `entry_${i}`));
  return out;
}

/** The color used when the index is out of the palette's range. */
export function readCategoricalDefault(
  config: Record<string, string | number | boolean>,
): CategoricalEntry {
  return readEntry(config, 'default');
}

/** Does this palette declare a non-opaque alpha anywhere (entries OR the
 *  out-of-range default)?
 *
 *  THE BYTE-IDENTITY GATE — see the twin in ColorScaleNode.ts for the full
 *  rationale. false ⇒ the `a` output port is hidden and the emit is the verbatim
 *  pre-alpha three-channel form. Shared by `hiddenPorts`, all five compilers, and
 *  the linked-OM injector so the port and the emit can never disagree. */
export function categoricalHasAlpha(
  config: Record<string, string | number | boolean>,
): boolean {
  return readCategoricalEntries(config).some(e => !isOpaque(e))
    || !isOpaque(readCategoricalDefault(config));
}

export const CategoricalColorNode: NodeTypeDef = {
  type: 'categoricalColor',
  label: 'Categorical Color',
  description:
    'Maps an integer index to a flat RGB(A) color from an N-entry palette (no blending). '
    + 'Index i selects entry i; out-of-range indices use the default color. '
    + 'The A output appears once any entry declares a non-opaque alpha.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer',
      inlineWidget: 'number', defaultValue: '0' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'a', label: 'A', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { count: 0, default_r: '0', default_g: '0', default_b: '0' },
  // Option A: the alpha channel exists only when the palette declares one.
  hiddenPorts: (config) => categoricalHasAlpha(config) ? [] : ['a'],
  compile: (nodeId, config, inputs) => {
    const idx = inputs['index'] || '0';
    const entries = readCategoricalEntries(config);
    const d = readCategoricalDefault(config);
    const withA = categoricalHasAlpha(config);

    // Channel table — r/g/b always, `a` only when declared. Every emit branch
    // walks it, so the opaque path reproduces the pre-alpha string exactly.
    const chans: Array<{ v: string; get: (e: CategoricalEntry) => number }> = [
      { v: `_v${nodeId}_r`, get: e => e.r | 0 },
      { v: `_v${nodeId}_g`, get: e => e.g | 0 },
      { v: `_v${nodeId}_b`, get: e => e.b | 0 },
    ];
    if (withA) chans.push({ v: `_v${nodeId}_a`, get: e => (e.a ?? OPAQUE) | 0 });

    if (entries.length === 0) {
      return chans.map(c => `const ${c.v} = ${c.get(d)};`).join(' ') + '\n';
    }

    const kVar = `_v${nodeId}_k`;
    const lines: string[] = [];
    lines.push(`let ${chans.map(c => c.v).join(', ')};`);
    lines.push(`const ${kVar} = (${idx}) | 0;`);
    entries.forEach((e, i) => {
      const head = i === 0 ? `if (${kVar} === ${i})` : `else if (${kVar} === ${i})`;
      lines.push(`${head} { ${chans.map(c => `${c.v} = ${c.get(e)}; `).join('')}}`);
    });
    lines.push(`else { ${chans.map(c => `${c.v} = ${c.get(d)}; `).join('')}}`);
    return lines.join(' ') + '\n';
  },
};
