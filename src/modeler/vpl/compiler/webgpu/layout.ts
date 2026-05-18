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
import { FACE_SLOT_COUNT } from '../variegation';

export interface WebGPULayoutAttr {
  id: string;
  type: string;        // 'bool' | 'integer' | 'float' | 'tag' | 'color' | 'neighborIndex'
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

/** Per-interaction-table location within the varAux buffer. */
export interface WebGPUInteractionTableLayout {
  /** Word offset into the varAux array<u32> at which the f32 values start. */
  wordOffset: number;
  /** Number of f32 entries — equals `(faceLabelsCount + 1)²`. */
  count: number;
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

  // ---- Variegated Cells regions. All zero / empty when disabled. ----

  /** True when the layout reserves orientation + facePatternLookup +
   *  interaction tables. Implies `model.variegatedCells?.enabled === true`. */
  variegatedEnabled: boolean;
  /** Word offset of the orientation read region INSIDE the attrs buffer (i.e.
   *  within `attrsRead` / `attrsWrite` — orientation is co-located with cell
   *  attrs so no new storage binding is needed). One u32 per cell, sized
   *  `cellsPerAttr × 4` bytes. The write region uses the same offset within
   *  the attrsWrite ping-pong buffer; bind-group orientation flipping keeps
   *  the source-of-truth aligned. 0 when variegation is off. */
  orientationWordOffset: number;
  /** Bytes occupied by the orientation region inside the attrs buffer
   *  (= cellsPerAttr × 4). 0 when variegation is off. */
  orientationBytes: number;

  /** Total bytes in the varAux storage buffer (binding 8) — sized to fit
   *  facePatternLookup + every interaction table. Stub-sized (16 bytes) when
   *  variegation is off so the bind group still binds something. */
  varAuxBytes: number;
  /** Word offset of facePatternLookup inside varAux (read as i32). Layout
   *  matches `buildFacePatternLookup`: `[speciesIdx * 8 + faceIdx]`. 0 when
   *  variegation is off. */
  facePatternLookupWordOffset: number;
  /** Number of i32 entries (= speciesCount × 8). 0 when no source attr / no
   *  variegation. */
  facePatternLookupCount: number;
  /** Per-attribute interaction table location within varAux. Keyed by the
   *  model attribute's id. Values are read as f32 via `bitcast<f32>(...)`. */
  interactionTableOffsets: Record<string, WebGPUInteractionTableLayout>;
  /** Number of labels per row/col in every interaction table
   *  (= faceLabelsCount + 1 for the implicit `none`). All tables share this
   *  because they all index into the model's face-label palette. */
  interactionTableLabelCount: number;
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
  // Variegated Cells: orientation read/write are co-located inside the same
  // attrs ping-pong buffer (one u32 per cell, sized like an integer attr).
  // No new storage binding — the WGSL emit indexes attrsRead/Write at
  // `orientationWordOffset + cellIdx`. The attrsBufA / attrsBufB swap (which
  // already handles per-step ping-pong of cell attrs) automatically also
  // swaps orientation read↔write. The +1 sentinel slot stays at 0 (initGrid
  // zero-fills the whole buffer; resetGrid zeros the orientation region).
  let orientationWordOffset = 0;
  let orientationBytes = 0;
  const isVariegated = !!model.variegatedCells?.enabled;
  if (isVariegated) {
    orientationWordOffset = attrCursor / 4;
    orientationBytes = cellsPerAttr * 4;
    attrCursor += orientationBytes;
  }
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

  // Variegated Cells: varAux is a small storage buffer holding the
  // facePatternLookup (i32 entries) followed by every interaction table
  // (f32 entries). All entries are u32-aligned. Reads from WGSL use bitcast
  // to recover the typed value.
  //
  // The buffer is always created (stub-sized at 16 bytes when off) so the
  // bind group can attach binding 8 unconditionally — keeps the pipeline
  // layout model-independent.
  let varAuxCursor = 0;
  let facePatternLookupWordOffset = 0;
  let facePatternLookupCount = 0;
  let interactionTableLabelCount = 1;
  const interactionTableOffsets: Record<string, WebGPUInteractionTableLayout> = {};
  if (isVariegated) {
    const v = model.variegatedCells!;
    const source = model.attributes.find(a => a.id === v.sourceAttributeId);
    const speciesCount = source && source.type === 'tag' && !source.isModelAttribute
      ? (source.tagOptions?.length ?? 0) : 0;
    facePatternLookupCount = speciesCount * FACE_SLOT_COUNT;
    if (facePatternLookupCount > 0) {
      facePatternLookupWordOffset = varAuxCursor / 4;
      varAuxCursor += facePatternLookupCount * 4;
    }
    interactionTableLabelCount = v.faceLabels.length + 1;
    const tableCount = interactionTableLabelCount * interactionTableLabelCount;
    const tableBytes = tableCount * 4;
    for (const a of modelAttrs) {
      if (a.type !== 'interactionTable') continue;
      // 16-byte alignment for storage struct safety (not strictly required for
      // array<u32>, but keeps every table on a cache line for slightly better
      // access patterns on tile-based GPUs).
      varAuxCursor = Math.ceil(varAuxCursor / 16) * 16;
      interactionTableOffsets[a.id] = {
        wordOffset: varAuxCursor / 4,
        count: tableCount,
      };
      varAuxCursor += tableBytes;
    }
  }
  // Storage buffers must be at least 4 bytes — even when no variegation data
  // exists, the buffer is created with the stub size so binding 8 is bindable.
  const varAuxBytes = Math.max(16, varAuxCursor);

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
    variegatedEnabled: isVariegated,
    orientationWordOffset,
    orientationBytes,
    varAuxBytes,
    facePatternLookupWordOffset,
    facePatternLookupCount,
    interactionTableOffsets,
    interactionTableLabelCount,
  };
}
