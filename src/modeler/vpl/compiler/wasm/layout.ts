/**
 * Memory layout computation — shared between worker (allocates the actual
 * WebAssembly.Memory + creates typed-array views) and main thread (compiles
 * WASM with embedded offsets).
 *
 * Layout (in order):
 *   [cell attr 0 read][cell attr 1 read]...
 *   [cell attr 0 write][cell attr 1 write]...      (skipped in async — write aliases read)
 *   [orientation read][orientation write]           (variegated only; i32/cell, write skipped in async)
 *   [colors: 4 bytes/cell]
 *   [neighbor index table 0][...]                   (Int32Array per neighborhood, total*size i32 each)
 *   [model attrs region]                            (one f64 per scalar; 3 per color attr)
 *   [indicators region]                             (one f64 per indicator)
 *   [rngState: 4 bytes]
 *   [activeViewer: 4 bytes]
 *   [orderArray: total * 4 bytes — async only]
 *   [stopFlag: 4 bytes]
 *   [facePatternLookup: tagOptions × 8 i32]         (variegated only)
 *   [interactionTables...]                          (variegated only; f64 each, (labels+1)² entries per table)
 *   [scratch region]
 *
 * All region offsets are 8-byte aligned. Total bytes are rounded up to the
 * nearest 64KB page. The grid never resizes without a fresh init, so memory
 * is allocated once and never grown.
 */

import type { CAModel } from '../../../../model/types';
import { FACE_SLOT_COUNT } from '../variegation';
import { hasGlyphsInModel } from '../glyphsUsage';

export interface AttrDef {
  id: string;
  type: string;
  isModelAttribute: boolean;
  defaultValue: string;
  tagOptions?: string[];
}

export interface NeighborhoodDef {
  id: string;
  coords: Array<[number, number]>;
}

export interface IndicatorLite {
  id: string;
  kind: string;
}

/** Variegated Cells layout inputs — when omitted the layout has no
 *  orientation / facePatternLookup / interactionTable regions and the
 *  related offsets are all 0. */
export interface VariegatedLayoutInputs {
  /** Source attribute's `tagOptions.length` — facePatternLookup is sized
   *  `tagOptions × 8` i32. Zero ⇒ lookup region is empty. */
  speciesCount: number;
  /** User-defined face label palette length (without implicit `none`). Each
   *  interaction table is `(faceLabelsCount + 1)²` f64. */
  faceLabelsCount: number;
  /** Ids of every model attribute with `type === 'interactionTable'`. Each
   *  gets its own contiguous f64 region. Iterated in stable order. */
  interactionTableIds: string[];
}

export interface MemoryLayout {
  totalBytes: number;
  pages: number;
  isAsync: boolean;
  total: number;

  attrReadOffset: Record<string, number>;
  attrWriteOffset: Record<string, number>;
  attrTypeBytes: Record<string, number>;
  attrType: Record<string, string>;

  colorsOffset: number;
  colorsBytes: number;

  /** True when any `setCellGlyph` node exists in the graph. When false the
   *  glyph regions are 0-sized and the worker skips view allocation, ship,
   *  and overlay render entirely (~zero cost for the common case). */
  hasGlyphs: boolean;
  /** Byte offset of the per-cell glyph codepoint buffer (Uint32Array, one
   *  codepoint per cell). 0 when `hasGlyphs` is false. */
  glyphCodesOffset: number;
  /** Bytes reserved for glyphCodes (`total × 4`). 0 when off. */
  glyphCodesBytes: number;
  /** Byte offset of the per-cell glyph colour buffer (Uint32Array, R in low
   *  byte, G middle, B high; alpha byte unused). Matches WebGPU's u32 layout
   *  1:1 so readback / overlay paths can share the same packed format. */
  glyphColorsOffset: number;
  /** Bytes reserved for glyphColors (`total × 4`). 0 when off. */
  glyphColorsBytes: number;

  /** byte offset of nbr index Int32Array; size in i32-elems is total * coords.length */
  nbrIndexOffset: Record<string, number>;
  nbrSize: Record<string, number>;

  /** Model-attr offsets (per slot key — "id" or "id_r/_g/_b" for colors), each f64. */
  modelAttrOffset: Record<string, number>;

  /** Per-indicator offset (f64 each). Indexed by indicator id. */
  indicatorOffset: Record<string, number>;
  /** Parallel array: indicator id at index N (matches the model.indicators order). */
  indicatorIds: string[];

  rngStateOffset: number;
  activeViewerOffset: number;
  orderOffset: number;

  /** Byte offset of the stop-event flag (single i32). When the compiled step
   *  writes a non-zero index there, the worker reads it post-step and pauses
   *  the simulator, surfacing `stopMessages[idx-1]`. */
  stopFlagOffset: number;

  /** Async-only per-cell skip flag (Uint8Array, one byte per cell). The
   *  compiled step writes 1 via `markCellUpdated`; the cell-iteration loop
   *  reads at the top and `continue`s when non-zero, preventing the cell
   *  from running again this step. Worker clears it before every step.
   *  Region is always reserved (size `total` aligned) so layout stays stable
   *  across sync/async edits. */
  skippedOffset: number;
  skippedBytes: number;

  // ---- Variegated Cells regions. All zero when `variegatedEnabled` is false. ----

  /** True when the layout reserves orientation / facePatternLookup /
   *  interactionTable regions. Implies the model has Variegated Cells on. */
  variegatedEnabled: boolean;

  /** Byte offset of the orientation read buffer (i32 per cell, sized to
   *  match cell-attr buffers — `cellsPerAttr` = `total + 1` for constant
   *  boundary, `total` for torus). 0 when variegation is off. */
  orientationReadOffset: number;
  /** Byte offset of the orientation write buffer. Equal to
   *  `orientationReadOffset` in async mode (single shared buffer). 0 when
   *  variegation is off. */
  orientationWriteOffset: number;
  /** Bytes per orientation buffer (cellsPerAttr × 4). Used by bulk copy. */
  orientationBytes: number;

  /** Byte offset of the flat facePatternLookup i32 region. Layout matches
   *  `buildFacePatternLookup`: `[speciesIdx * 8 + faceIdx → labelIdx]`. The
   *  worker uploads this once on init/recompile; emitters read it at
   *  compile-time-known offsets relative to `facePatternLookupOffset`. */
  facePatternLookupOffset: number;
  /** Bytes reserved for facePatternLookup (`speciesCount × 8 × 4`). */
  facePatternLookupBytes: number;

  /** Byte offset per interaction-table model attr (f64 row-major
   *  `[rowLabelIdx * labelCount + colLabelIdx]`, sized
   *  `(faceLabelsCount + 1)² × 8` bytes per table). Keyed by attribute id.
   *  Empty map when variegation is off. */
  interactionTableOffsets: Record<string, number>;
  /** Number of labels per row/col in every interaction table — equal to
   *  `faceLabelsCount + 1` (the implicit `none` label at index 0 plus the
   *  user-defined palette). Same for every table because they all share
   *  the model's face-label palette. */
  interactionTableLabelCount: number;

  /** Per-cell-iteration scratch region (bump-pointer allocator).
   *  Used by array-producing emitters (filterNeighbors, joinNeighbors,
   *  getNeighborIndexesByTags, getNeighborsAttrByIndexes) to materialise
   *  intermediate arrays without leaving the WASM module. The bump pointer
   *  resets at the top of every cell iteration, so the size needs to fit the
   *  PEAK concurrent allocation within one cell, not across cells. */
  scratchOffset: number;
  scratchBytes: number;

  /** Sentinel cell index used by constant boundary (-1 if torus). */
  sentinelIndex: number;
}

export function alignTo(off: number, align: number): number {
  return Math.ceil(off / align) * align;
}

export function bytesPerType(t: string): number {
  switch (t) {
    case 'bool': return 1;
    case 'integer': return 4;
    case 'tag': return 4;
    case 'neighborIndex': return 4;
    case 'float': return 8;
    default: return 8;
  }
}

export function computeMemoryLayout(
  cellAttrs: AttrDef[],
  modelAttrs: AttrDef[],
  neighborhoods: NeighborhoodDef[],
  indicators: IndicatorLite[],
  total: number,
  isAsync: boolean,
  boundaryTreatment: string,
  variegated?: VariegatedLayoutInputs,
  hasGlyphs: boolean = false,
): MemoryLayout {
  let off = 0;

  const attrReadOffset: Record<string, number> = {};
  const attrWriteOffset: Record<string, number> = {};
  const attrTypeBytes: Record<string, number> = {};
  const attrType: Record<string, string> = {};

  // For constant-boundary models we reserve one extra cell per attr — the
  // sentinel cell at index `total` that constant-boundary neighbours point at.
  // Allocating it inside wasmMemory keeps the JS-side typed-array views and
  // the WASM module pointing at the same bytes (otherwise the worker's
  // standalone +1 arrays would diverge from WASM's baked-in offsets).
  const cellsPerAttr = boundaryTreatment === 'torus' ? total : (total + 1);

  // Cell attrs — read region
  for (const a of cellAttrs) {
    const ib = bytesPerType(a.type);
    attrTypeBytes[a.id] = ib;
    attrType[a.id] = a.type;
    off = alignTo(off, 8);
    attrReadOffset[a.id] = off;
    off += cellsPerAttr * ib;
  }
  // Cell attrs — write region (sync only)
  if (!isAsync) {
    for (const a of cellAttrs) {
      const ib = attrTypeBytes[a.id]!;
      off = alignTo(off, 8);
      attrWriteOffset[a.id] = off;
      off += cellsPerAttr * ib;
    }
  } else {
    for (const a of cellAttrs) attrWriteOffset[a.id] = attrReadOffset[a.id]!;
  }

  // Variegated Cells — orientation read/write regions. Same i32-per-cell shape
  // as integer cell attrs, sized with the same sentinel-aware `cellsPerAttr`
  // so the JS-side typed-array views and WASM emit see identical bytes.
  const variegatedEnabled = !!variegated;
  let orientationReadOffset = 0;
  let orientationWriteOffset = 0;
  let orientationBytes = 0;
  if (variegatedEnabled) {
    orientationBytes = cellsPerAttr * 4;
    off = alignTo(off, 8);
    orientationReadOffset = off;
    off += orientationBytes;
    if (!isAsync) {
      off = alignTo(off, 8);
      orientationWriteOffset = off;
      off += orientationBytes;
    } else {
      orientationWriteOffset = orientationReadOffset;
    }
  }

  // Colors region (RGBA Uint8 per cell)
  off = alignTo(off, 8);
  const colorsOffset = off;
  const colorsBytes = total * 4;
  off += colorsBytes;

  // Glyph regions (codes + packed RGB colours) — both u32 per cell, allocated
  // only when the model actually references setCellGlyph. Sized by `total`
  // (not `cellsPerAttr`) — there's no sentinel slot to read from.
  let glyphCodesOffset = 0;
  let glyphCodesBytes = 0;
  let glyphColorsOffset = 0;
  let glyphColorsBytes = 0;
  if (hasGlyphs) {
    glyphCodesBytes = total * 4;
    off = alignTo(off, 8);
    glyphCodesOffset = off;
    off += glyphCodesBytes;
    glyphColorsBytes = total * 4;
    off = alignTo(off, 8);
    glyphColorsOffset = off;
    off += glyphColorsBytes;
  }

  // Neighbor index tables (Int32Array per neighborhood, length = total * coords.length)
  const nbrIndexOffset: Record<string, number> = {};
  const nbrSize: Record<string, number> = {};
  for (const n of neighborhoods) {
    nbrSize[n.id] = n.coords.length;
    off = alignTo(off, 8);
    nbrIndexOffset[n.id] = off;
    off += total * n.coords.length * 4;
  }

  // Model attrs region — one f64 slot per scalar (or per color channel for color attrs)
  const modelAttrOffset: Record<string, number> = {};
  off = alignTo(off, 8);
  for (const a of modelAttrs) {
    if (a.type === 'color') {
      modelAttrOffset[a.id + '_r'] = off; off += 8;
      modelAttrOffset[a.id + '_g'] = off; off += 8;
      modelAttrOffset[a.id + '_b'] = off; off += 8;
    } else {
      modelAttrOffset[a.id] = off; off += 8;
    }
  }

  // Indicators region — one f64 per indicator (matches model.indicators order)
  const indicatorOffset: Record<string, number> = {};
  const indicatorIds: string[] = [];
  off = alignTo(off, 8);
  for (const ind of indicators) {
    indicatorIds.push(ind.id);
    indicatorOffset[ind.id] = off;
    off += 8;
  }

  // RNG state (single u32, but pad to 8 bytes)
  off = alignTo(off, 8);
  const rngStateOffset = off;
  off += 8;

  // Active viewer ID (i32, padded to 8)
  off = alignTo(off, 8);
  const activeViewerOffset = off;
  off += 8;

  // Order array (only meaningful in async mode, but reserve in both for layout stability)
  off = alignTo(off, 8);
  const orderOffset = off;
  off += total * 4;

  // Stop-event flag (single i32, padded to 8)
  off = alignTo(off, 8);
  const stopFlagOffset = off;
  off += 8;

  // Mark Cell Updated: per-cell Uint8 skip flag (only meaningful in async mode,
  // but reserve in both modes for layout stability — matches orderOffset).
  off = alignTo(off, 8);
  const skippedOffset = off;
  const skippedBytes = total;
  off += alignTo(skippedBytes, 8);

  // Variegated Cells — facePatternLookup + interaction tables. Uploaded by the
  // worker on init/recompile. Sized once at layout time (count-driven, not
  // value-driven) so the layout is stable across live edits to the table
  // values themselves (those are upload-only). Tables share one labelCount
  // because they all use the model's face-label palette.
  let facePatternLookupOffset = 0;
  let facePatternLookupBytes = 0;
  const interactionTableOffsets: Record<string, number> = {};
  let interactionTableLabelCount = 1; // implicit `none` = 1 when palette empty
  if (variegated) {
    facePatternLookupBytes = variegated.speciesCount * FACE_SLOT_COUNT * 4;
    if (facePatternLookupBytes > 0) {
      off = alignTo(off, 8);
      facePatternLookupOffset = off;
      off += facePatternLookupBytes;
    }
    interactionTableLabelCount = variegated.faceLabelsCount + 1;
    const tableBytes = interactionTableLabelCount * interactionTableLabelCount * 8;
    for (const id of variegated.interactionTableIds) {
      off = alignTo(off, 8);
      interactionTableOffsets[id] = off;
      off += tableBytes;
    }
  }

  // Scratch region for per-cell array allocation (bump-pointer reset per
  // iteration). Sized for: max neighborhood size × 8 bytes (worst-case f64
  // element) × 32 concurrent arrays. With a floor of 4 KB so trivial graphs
  // still get a usable scratch region. Bump-pointer resets per cell, so this
  // bounds PEAK simultaneous arrays within one iteration, not lifetime.
  off = alignTo(off, 8);
  const scratchOffset = off;
  let maxNbrSize = 0;
  for (const n of neighborhoods) if (n.coords.length > maxNbrSize) maxNbrSize = n.coords.length;
  const scratchBytes = Math.max(4096, maxNbrSize * 8 * 32);
  off += scratchBytes;

  const sentinelIndex = boundaryTreatment === 'constant' ? total : -1;

  const totalBytes = off;
  const pages = Math.max(1, Math.ceil(totalBytes / 65536));
  return {
    totalBytes, pages, isAsync, total,
    attrReadOffset, attrWriteOffset, attrTypeBytes, attrType,
    colorsOffset, colorsBytes,
    hasGlyphs,
    glyphCodesOffset, glyphCodesBytes,
    glyphColorsOffset, glyphColorsBytes,
    nbrIndexOffset, nbrSize,
    modelAttrOffset,
    indicatorOffset, indicatorIds,
    rngStateOffset, activeViewerOffset, orderOffset,
    stopFlagOffset,
    skippedOffset, skippedBytes,
    variegatedEnabled,
    orientationReadOffset, orientationWriteOffset, orientationBytes,
    facePatternLookupOffset, facePatternLookupBytes,
    interactionTableOffsets, interactionTableLabelCount,
    scratchOffset, scratchBytes,
    sentinelIndex,
  };
}

export function computeLayoutFromModel(
  model: CAModel,
): MemoryLayout {
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);
  const neighborhoods = model.neighborhoods.map(n => ({ id: n.id, coords: n.coords as Array<[number, number]> }));
  const indicators = (model.indicators || []).map(i => ({ id: i.id, kind: i.kind }));
  const total = model.properties.gridWidth * model.properties.gridHeight;
  const isAsync = model.properties.updateMode === 'asynchronous';
  let variegated: VariegatedLayoutInputs | undefined;
  if (model.variegatedCells?.enabled) {
    const source = model.attributes.find(a => a.id === model.variegatedCells!.sourceAttributeId);
    const speciesCount = source && source.type === 'tag' && !source.isModelAttribute
      ? (source.tagOptions?.length ?? 0) : 0;
    const interactionTableIds = model.attributes
      .filter(a => a.isModelAttribute && a.type === 'interactionTable')
      .map(a => a.id);
    variegated = {
      speciesCount,
      faceLabelsCount: model.variegatedCells.faceLabels.length,
      interactionTableIds,
    };
  }
  return computeMemoryLayout(
    cellAttrs.map(a => ({ id: a.id, type: a.type, isModelAttribute: false, defaultValue: a.defaultValue, tagOptions: a.tagOptions })),
    modelAttrs.map(a => ({ id: a.id, type: a.type, isModelAttribute: true, defaultValue: a.defaultValue, tagOptions: a.tagOptions })),
    neighborhoods,
    indicators,
    total,
    isAsync,
    model.properties.boundaryTreatment,
    variegated,
    hasGlyphsInModel(model),
  );
}

/** Helper: assign each viewer (mapping) a numeric id in stable order. */
export function buildViewerIds(model: CAModel): Record<string, number> {
  const ids: Record<string, number> = {};
  let i = 0;
  for (const m of model.mappings) {
    if (m.isAttributeToColor) {
      ids[m.id] = i++;
    }
  }
  return ids;
}
