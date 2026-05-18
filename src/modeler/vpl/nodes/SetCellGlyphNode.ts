import type { NodeTypeDef } from '../types';
import { safeId } from '../compiler/identifierSafe';

/**
 * Set Cell Glyph — companion to SetColorViewer. Writes a per-cell glyph
 * (Unicode codepoint) + RGB tint that the simulator overlays on top of the
 * coloured cell at sufficient zoom levels.
 *
 * The per-cell buffers `glyphCodes` (Uint32Array, one codepoint per cell)
 * and `glyphColors` (Uint32Array, RGB packed as R|G<<8|B<<16) live in WASM
 * memory and are shared by all three compile targets. The simulator clears
 * them at the top of every colour pass — "codepoint 0" means "no glyph".
 *
 * Inline glyph widget on the `glyph` port stores the codepoint as a numeric
 * string; the widget UI decodes/encodes the visible character.
 */
export const SetCellGlyphNode: NodeTypeDef = {
  type: 'setCellGlyph',
  label: 'Set Cell Glyph',
  description: 'Overlays a Unicode character on the current cell when the named Output Mapping is active. Coloured by R/G/B; only drawn at zoom levels where cells are large enough to read.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'glyph', label: 'Glyph', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'glyph', defaultValue: '0' },
    { id: 'r', label: 'R', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
    { id: 'g', label: 'G', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
  ],
  defaultConfig: { mappingId: '' },
  compile: (nodeId, config, inputs) => {
    const mappingId = config.mappingId as string || 'default';
    const cp = inputs['glyph'] || '0';
    const r = inputs['r'] || '0';
    const g = inputs['g'] || '0';
    const b = inputs['b'] || '0';
    void nodeId;
    // Hoisted `_isV_<mappingId>` guard (same one SetColorViewer uses).
    // Packed RGB so glyphColors matches its u32 GPU layout 1:1 — no format
    // mismatch between the JS view and the WebGPU readback.
    return `if (_isV_${safeId(mappingId)}) { glyphCodes[idx] = (${cp})|0; glyphColors[idx] = (((${r})|0) & 0xff) | ((((${g})|0) & 0xff) << 8) | ((((${b})|0) & 0xff) << 16); }\n`;
  },
};
