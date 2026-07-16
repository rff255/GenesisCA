import type { NodeTypeDef } from '../types';
import { isOpaque } from '../../../model/colorHex';

/** Read the node's `a` config. ABSENT ⇒ undefined (NOT 255) — the distinction
 *  {@link colorConstantHasAlpha} reads. */
function readAlpha(config: Record<string, string | number | boolean>): number | undefined {
  const raw = config.a;
  return raw === undefined ? undefined : ((parseInt(String(raw), 10) || 0) | 0);
}

/** Does this constant declare a non-opaque alpha?
 *
 *  THE BYTE-IDENTITY GATE — see the twin in ColorScaleNode.ts for the rationale.
 *  false ⇒ the `a` output port is hidden and the emit is the verbatim pre-alpha
 *  three-channel form. */
export function colorConstantHasAlpha(
  config: Record<string, string | number | boolean>,
): boolean {
  return !isOpaque({ a: readAlpha(config) });
}

export const GetColorConstantNode: NodeTypeDef = {
  type: 'getColorConstant',
  label: 'Color Constant',
  description:
    'Emits a fixed RGB(A) color as separate integer channels. '
    + 'The A output appears once a non-opaque alpha is set.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'a', label: 'A', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { r: '128', g: '128', b: '128' },
  // Option A: the alpha channel exists only when a non-opaque alpha is declared.
  hiddenPorts: (config) => colorConstantHasAlpha(config) ? [] : ['a'],
  compile: (nodeId, config) => {
    const r = parseInt(config.r as string, 10) || 0;
    const g = parseInt(config.g as string, 10) || 0;
    const b = parseInt(config.b as string, 10) || 0;
    // Each channel is a separate output variable.
    const base = `const _v${nodeId}_r = ${r}; const _v${nodeId}_g = ${g}; const _v${nodeId}_b = ${b};`;
    if (!colorConstantHasAlpha(config)) return base + '\n';
    return `${base} const _v${nodeId}_a = ${readAlpha(config) ?? 255};\n`;
  },
};
