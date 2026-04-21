/**
 * Memory layout computation — shared between worker (allocates the actual
 * WebAssembly.Memory + creates typed-array views) and main thread (compiles
 * WASM with embedded offsets).
 *
 * Layout (in order):
 *   [cell attr 0 read][cell attr 1 read]...
 *   [cell attr 0 write][cell attr 1 write]...      (skipped in async — write aliases read)
 *   [colors: 4 bytes/cell]
 *   [neighbor index table 0][...]                   (Int32Array per neighborhood, total*size i32 each)
 *   [model attrs region]                            (one f64 per scalar; 3 per color attr)
 *   [indicators region]                             (one f64 per indicator)
 *   [rngState: 4 bytes]
 *   [activeViewer: 4 bytes]
 *   [orderArray: total * 4 bytes — async only]
 *
 * All region offsets are 8-byte aligned. Total bytes are rounded up to the
 * nearest 64KB page. The grid never resizes without a fresh init, so memory
 * is allocated once and never grown.
 */

import type { CAModel } from '../../../../model/types';

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

  // Colors region (RGBA Uint8 per cell)
  off = alignTo(off, 8);
  const colorsOffset = off;
  const colorsBytes = total * 4;
  off += colorsBytes;

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
    nbrIndexOffset, nbrSize,
    modelAttrOffset,
    indicatorOffset, indicatorIds,
    rngStateOffset, activeViewerOffset, orderOffset,
    stopFlagOffset,
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
  return computeMemoryLayout(
    cellAttrs.map(a => ({ id: a.id, type: a.type, isModelAttribute: false, defaultValue: a.defaultValue, tagOptions: a.tagOptions })),
    modelAttrs.map(a => ({ id: a.id, type: a.type, isModelAttribute: true, defaultValue: a.defaultValue, tagOptions: a.tagOptions })),
    neighborhoods,
    indicators,
    total,
    isAsync,
    model.properties.boundaryTreatment,
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
