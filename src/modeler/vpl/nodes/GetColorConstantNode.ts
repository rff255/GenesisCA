import type { NodeTypeDef } from '../types';
import { isOpaque, OPAQUE } from '../../../model/colorHex';

/** Read the node's `a` config. ABSENT ⇒ undefined (NOT 255) — the distinction
 *  {@link colorConstantHasAlpha} reads. */
function readAlpha(config: Record<string, string | number | boolean>): number | undefined {
  const raw = config.a;
  return raw === undefined ? undefined : ((parseInt(String(raw), 10) || 0) | 0);
}

/** The node's colour as one value. `a` defaults to opaque, so the returned
 *  object is a complete RGBA the pickers can render. */
export function readColorConstant(
  config: Record<string, string | number | boolean>,
): { r: number; g: number; b: number; a: number } {
  return {
    r: parseInt(String(config.r ?? '128'), 10) || 0,
    g: parseInt(String(config.g ?? '128'), 10) || 0,
    b: parseInt(String(config.b ?? '128'), 10) || 0,
    a: readAlpha(config) ?? OPAQUE,
  };
}

/**
 * Write the node's colour back to config, applying the Option-A alpha gate: an
 * OPAQUE colour DELETES the `a` key entirely, so the node keeps its pre-alpha
 * config, its 3-port shape and its byte-identical emit.
 *
 * THE writer both the in-node `ColorField` and the Explicit-Controls FACET
 * control use, so an instance edit produces the same config as an in-node one.
 */
export function writeColorConstant(
  config: Record<string, string | number | boolean>,
  c: { r: number; g: number; b: number; a?: number },
): Record<string, string | number | boolean> {
  const next = { ...config };
  next.r = String(c.r | 0);
  next.g = String(c.g | 0);
  next.b = String(c.b | 0);
  if (isOpaque(c)) delete next.a; else next.a = String((c.a ?? OPAQUE) | 0);
  return next;
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
