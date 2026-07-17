import type { NodeTypeDef } from '../types';
import { safeId } from '../compiler/identifierSafe';

/** config.mappingId sentinel — "Current Simulator Selected": write for
 *  WHICHEVER output mapping (viewer) is active in the simulator, instead of one
 *  fixed mapping. Lets one graph serve several viewers that differ only in other
 *  aspects. All three compile targets emit the writes WITHOUT the activeViewer
 *  guard for this value (the running pass IS the current viewer by construction). */
export const CURRENT_VIEWER_SENTINEL = '__current__';

/**
 * Set Cell Looks — the unified per-cell appearance node. It merges the former
 * `Set Color Viewer` (flat cell color) and `Set Cell Glyph` (overlaid Unicode
 * character) into one node with a `useGlyph` toggle:
 *
 *  - Plain mode (`useGlyph` false): writes the cell's R/G/B to the `colors`
 *    RGBA buffer — exactly the old Set Color Viewer. This is the appearance
 *    shown at EVERY zoom level.
 *  - Glyph mode (`useGlyph` true): writes a per-cell glyph (codepoint + RGB
 *    tint) the simulator overlays at readable zoom levels, plus optionally a
 *    cell BACKGROUND color (`setBackground`) written to the same `colors`
 *    buffer (so it shows behind the glyph close-up AND at macro zoom). When
 *    `fallbackToGlyphColor` is on, the simulator paints each glyphed cell with
 *    its glyph color once cells are too small to draw the glyph — so the macro
 *    view stays meaningful instead of going blank. (That fallback is purely a
 *    render-time behaviour; the compiler is unaware of it.)
 *
 * The per-cell buffers `glyphCodes` (Uint32Array, one codepoint per cell) and
 * `glyphColors` (Uint32Array, RGB packed as R|G<<8|B<<16) live in WASM memory
 * and are shared by all three compile targets; "codepoint 0" means "no glyph".
 * Cell-color (R/G/B) is the flat / background color; glyph color is glyphR/G/B.
 */
export const SetCellLooksNode: NodeTypeDef = {
  type: 'setCellLooks',
  label: 'Set Cell Looks',
  // Agents graph: the same node colours the current AGENT for an agent view.
  // Glyphs are a render no-op there (agents draw as discs/sprites, no glyph
  // overlay) — the editor hides the glyph UI on the Agents graph.
  agentLabel: 'Set Agent Looks',
  agentDescription: 'Sets the current agent’s color for the named agent view (RGBA — alpha makes the agent translucent). "Current Simulator Selected" instead targets whichever agent view is active.',
  description: 'Sets the current cell’s appearance for the named Output Mapping: a flat color, or (Use glyph) an overlaid Unicode character with an optional background color and an optional zoomed-out glyph-color fallback. "Current Simulator Selected" instead targets whichever viewer is active.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    // Cell color (flat in plain mode; background in glyph mode when setBackground).
    { id: 'r', label: 'R', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'g', label: 'G', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    // Cell alpha (0 = fully transparent, 255 = opaque). Default 255 keeps every
    // existing model byte-identical. Used by the 3D voxel renderer to cull /
    // blend cells; the 2D canvas composites it source-over too.
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
    // Glyph (codepoint) + glyph color.
    { id: 'glyph', label: 'Glyph', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'glyph', defaultValue: '0' },
    { id: 'glyphR', label: 'Glyph R', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
    { id: 'glyphG', label: 'Glyph G', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
    { id: 'glyphB', label: 'Glyph B', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
  ],
  defaultConfig: { mappingId: '', useGlyph: false, setBackground: true, fallbackToGlyphColor: false },
  hiddenPorts: (config) => {
    const useGlyph = !!config.useGlyph;
    if (!useGlyph) return ['glyph', 'glyphR', 'glyphG', 'glyphB'];
    // glyph mode — hide the cell-color ports (incl. alpha) unless the background is enabled.
    return config.setBackground === false ? ['r', 'g', 'b', 'a'] : [];
  },
  compile: (nodeId, config, inputs) => {
    void nodeId;
    const mappingId = (config.mappingId as string) || 'default';
    const useGlyph = !!config.useGlyph;
    const setBg = config.setBackground !== false; // default true
    const writeBg = (!useGlyph || setBg)
      ? `colors[colorIdx] = ${inputs['r'] || '0'}; colors[colorIdx+1] = ${inputs['g'] || '0'}; colors[colorIdx+2] = ${inputs['b'] || '0'}; colors[colorIdx+3] = ${inputs['a'] || '255'};`
      : '';
    let writeGlyph = '';
    if (useGlyph) {
      const cp = inputs['glyph'] || '0';
      const gr = inputs['glyphR'] || '0';
      const gg = inputs['glyphG'] || '0';
      const gb = inputs['glyphB'] || '0';
      // Packed RGB so glyphColors matches its u32 GPU layout 1:1.
      writeGlyph = `glyphCodes[idx] = (${cp})|0; glyphColors[idx] = (((${gr})|0) & 0xff) | ((((${gg})|0) & 0xff) << 8) | ((((${gb})|0) & 0xff) << 16);`;
    }
    const body = `${writeBg}${writeBg && writeGlyph ? ' ' : ''}${writeGlyph}`;
    if (!body) return '';
    // "Current Simulator Selected": whatever pass is running IS the current
    // viewer — write unconditionally. Otherwise the compiler hoists a per-mapping
    // `const _isV_<safeId> = activeViewer === "<id>"` and we read it here.
    if (mappingId === CURRENT_VIEWER_SENTINEL) return `${body}\n`;
    return `if (_isV_${safeId(mappingId)}) { ${body} }\n`;
  },
};
