/**
 * WebGPU buffer layout — Wave 3 backend.
 *
 * Mirrors the WASM `MemoryLayout` concept but exposes each region as its own
 * GPU storage buffer (binding) instead of slicing one linear memory. Sizing
 * formulas reuse the WASM ones: `cellsPerAttr = total + 1` when boundary is
 * "constant" so the sentinel cell still works for out-of-grid neighbour reads.
 *
 * Neighbour storage uses IMPLICIT lookup: rather than precomputing a per-cell
 * `(total × nbr_size)` index table (catastrophic on huge grids — 1.4 GB for
 * MNCA at 1000²), we upload only the relative coordinate offsets per
 * neighbourhood (`nbr.size × 2 × 4` bytes — a few KB total) and let the WGSL
 * shader compute neighbour cell indices inline via the `nbrCellIdx` helper.
 * See docs/HUGE_GRID_OPTIMIZATIONS.md §2.1 for the rationale.
 */

import type { CAModel } from '../../../../model/types';

export interface WebGPULayoutAttr {
  id: string;
  type: string;        // 'bool' | 'integer' | 'float' | 'tag' | 'color'
  itemBytes: number;   // 4 — every attr stored as one u32 word per cell on GPU (bool 0/1, int/tag i32, float f32)
  /** Element count per buffer (= cellsPerAttr). */
  count: number;
  /** Offset within the attrsRead / attrsWrite buffer, in bytes. */
  byteOffset: number;
  /** Offset within the buffer when accessed as an `array<u32>` — = byteOffset / 4. */
  wordOffset: number;
}

export interface WebGPULayoutNbr {
  id: string;
  size: number;        // neighbour count per cell (= coords.length)
  /** Element count in the offsets buffer for this neighbourhood. = size * 2
   *  (one i32 each for dRow, dCol, per neighbour offset). */
  count: number;
  /** Offset within the nbrOffsets buffer, in bytes. */
  byteOffset: number;
  /** Offset within the buffer when accessed as `array<i32>` — = byteOffset / 4.
   *  Compiler emits this as the `baseOffset` arg to `nbrCellIdx`. */
  wordOffset: number;
  /** Pre-flattened relative coords [dRow, dCol] per neighbour — uploaded
   *  verbatim into the offsets buffer at `byteOffset`. */
  coords: Array<[number, number]>;
}

export interface WebGPULayout {
  /** Total cells in the grid (width * height). */
  total: number;
  /** total + 1 when boundary is "constant", else total. Sentinel slot is `total`. */
  cellsPerAttr: number;
  sentinelIndex: number;
  /** Grid dimensions (baked into the WGSL `nbrCellIdx` helper as literals).
   *  Zero values (degenerate empty model) are clamped to 1 to keep the WGSL
   *  modulo math defined. */
  gridWidth: number;
  gridHeight: number;
  /** Boundary mode (selects which `nbrCellIdx` helper variant the encoder
   *  emits — torus wraps, constant returns the sentinel). */
  boundaryTreatment: 'torus' | 'constant';
  /** Total bytes for one attrs buffer (read or write). */
  attrsBytes: number;
  attrs: WebGPULayoutAttr[];
  /** Total bytes for the small neighbour-offsets buffer (sum across
   *  neighbourhoods of `size × 2 × 4`). Independent of grid size. */
  nbrBytes: number;
  nbrs: WebGPULayoutNbr[];
  /** Bytes for the colors buffer (RGBA8 = 4 per cell). */
  colorsBytes: number;
  /** Bytes for the modelAttrs uniform buffer (one f32 per scalar, three f32 per color). */
  modelAttrsBytes: number;
  /** Map from model-attr key ("id" or "id_r" / "id_g" / "id_b") to byte offset
   *  inside the modelAttrs buffer. */
  modelAttrOffset: Record<string, number>;
  /** Bytes for the indicators buffer (one f32 / atomic<u32> per indicator, indices match model.indicators order). */
  indicatorsBytes: number;
  indicatorIds: string[];
  /** One u32 per cell. */
  rngStateBytes: number;
  /** Packed control buffer: activeViewer (i32) + stopFlag (atomic<u32>). */
  controlBytes: number;
  /** Byte offsets within the control buffer. */
  controlOffsets: { activeViewer: number; stopFlag: number };
}

/**
 * Compute the per-region sizes and offsets needed to allocate the GPU buffers.
 *
 * Step 1: returns a skeleton with the regions sized but not yet exercised by
 * a real shader. Step 2 wires this into device.createBuffer calls and the
 * shader module preamble.
 */
export function computeWebGPULayout(model: CAModel): WebGPULayout {
  const gridWidth = Math.max(1, model.properties.gridWidth || 1);
  const gridHeight = Math.max(1, model.properties.gridHeight || 1);
  const total = gridWidth * gridHeight;
  const isConstantBoundary = model.properties.boundaryTreatment === 'constant';
  const cellsPerAttr = isConstantBoundary ? total + 1 : total;
  const sentinelIndex = isConstantBoundary ? total : -1;
  const boundaryTreatment: 'torus' | 'constant' = isConstantBoundary ? 'constant' : 'torus';

  const cellAttrs = (model.attributes || []).filter(a => !a.isModelAttribute);
  const modelAttrs = (model.attributes || []).filter(a => a.isModelAttribute);

  // Attrs partitioning. WGSL has no f64; floats are stored as f32. bool stays 1
  // byte but each storage element is at least 4 bytes (storage buffers are
  // u32-aligned), so we still allocate 4 bytes per cell for bools and treat
  // them as 0/1 u32. This keeps SoA simple and aligned at the cost of 4×
  // memory for bool attrs; not a problem for v1 (a 5000×5000 bool attr is
  // 100 MB at 4-byte stride, comfortably within typical adapter limits).
  let attrCursor = 0;
  const attrs: WebGPULayoutAttr[] = cellAttrs.map(a => {
    const itemBytes = 4; // u32 / i32 / f32 — see comment above
    const bytes = cellsPerAttr * itemBytes;
    const entry: WebGPULayoutAttr = {
      id: a.id, type: a.type, itemBytes, count: cellsPerAttr,
      byteOffset: attrCursor, wordOffset: attrCursor / 4,
    };
    attrCursor += bytes;
    return entry;
  });
  // Storage buffers must have non-zero size; clamp to 4 bytes when there are
  // no cell attrs (degenerate models — UI prevents this once you have a graph,
  // but the simulator doesn't crash on the empty model).
  const attrsBytes = Math.max(4, attrCursor);

  // Neighbour offsets table (one block per neighbourhood). Each block holds
  // `size × 2` i32 entries — pairs of (dRow, dCol). The shader-side
  // `nbrCellIdx` helper reads these and computes the linear cell index inline,
  // applying the boundary rule. Total bytes are independent of grid size.
  let nbrCursor = 0;
  const nbrs: WebGPULayoutNbr[] = (model.neighborhoods || []).map(n => {
    const size = n.coords.length;
    const count = size * 2;
    const bytes = count * 4;
    // Defensive clone: (a) coerce each pair into a fresh tuple so later edits
    // to the model's coords array can't mutate the layout view, (b) coerce
    // each component to int32 so non-integer junk in a saved file lands as 0.
    const coords: Array<[number, number]> = n.coords.map(c => [(c[0] | 0), (c[1] | 0)]);
    const entry: WebGPULayoutNbr = {
      id: n.id, size, count,
      byteOffset: nbrCursor, wordOffset: nbrCursor / 4,
      coords,
    };
    nbrCursor += bytes;
    return entry;
  });
  const nbrBytes = Math.max(4, nbrCursor);

  // Model attrs: one f32 per scalar, three f32 per color (r, g, b separately).
  let modelCursor = 0;
  const modelAttrOffset: Record<string, number> = {};
  for (const a of modelAttrs) {
    if (a.type === 'color') {
      modelAttrOffset[a.id + '_r'] = modelCursor; modelCursor += 4;
      modelAttrOffset[a.id + '_g'] = modelCursor; modelCursor += 4;
      modelAttrOffset[a.id + '_b'] = modelCursor; modelCursor += 4;
    } else {
      modelAttrOffset[a.id] = modelCursor; modelCursor += 4;
    }
  }
  // Uniform buffers must be 16-byte aligned in size.
  const modelAttrsBytes = Math.max(16, Math.ceil(modelCursor / 16) * 16);

  const indicatorIds = (model.indicators || []).map(i => i.id);
  const indicatorsBytes = Math.max(4, indicatorIds.length * 4);

  const rngStateBytes = total * 4;

  const controlOffsets = { activeViewer: 0, stopFlag: 4 };
  const controlBytes = 16; // 8 bytes used + padding to align

  return {
    total,
    cellsPerAttr,
    sentinelIndex,
    gridWidth,
    gridHeight,
    boundaryTreatment,
    attrsBytes,
    attrs,
    nbrBytes,
    nbrs,
    colorsBytes: total * 4,
    modelAttrsBytes,
    modelAttrOffset,
    indicatorsBytes,
    indicatorIds,
    rngStateBytes,
    controlBytes,
    controlOffsets,
  };
}
