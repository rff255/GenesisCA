/**
 * Memory layout computation — shared between worker (allocates the actual
 * WebAssembly.Memory + creates typed-array views) and main thread (compiles
 * WASM with embedded offsets).
 *
 * Layout (in order):
 *   [cell attr 0 read][cell attr 1 read]...
 *   [cell attr 0 write][cell attr 1 write]...      (skipped in async, agents-only,
 *                                                    OR the WebGPU grid target —
 *                                                    write aliases read; only the
 *                                                    JS/WASM sync STEP needs a
 *                                                    separate write buffer, and it
 *                                                    never runs on WebGPU)
 *   [orientation read][orientation write]           (variegated only; i32/cell, write skipped in async)
 *   [colors: 4 bytes/cell]
 *   [neighbor index table 0][...]                   (Int32Array per neighborhood, total*size i32 each)
 *   [model attrs region]                            (one f64 per scalar; 4 per color attr: r/g/b/a)
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
import { FACE_SLOT_COUNT, resolveKeyLabels, resolveAxes, isMultiAxisTable } from '../variegation';
import { hasGlyphsInModel } from '../glyphsUsage';
import { expandVectorAttributes } from '../vectorAttr';
import { modelAttrSlotKeys } from '../../../../model/attributeScope';
import { sparseSteppingEnabled } from '../sparseStepping';

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
 *  orientation / facePatternLookup regions and the related offsets are all 0.
 *  (Lookup tables are NOT here — they're decoupled from variegation; see
 *  `LookupTableLayoutInput`.) */
export interface VariegatedLayoutInputs {
  /** Source attribute's `tagOptions.length` — facePatternLookup is sized
   *  `tagOptions × 8` i32. Zero ⇒ lookup region is empty. */
  speciesCount: number;
}

/** Lookup Table memory-region inputs. Decoupled from variegation — a table can
 *  be keyed by tag attributes with no faces at all. Each table gets its own
 *  contiguous row-major f64 region sized `rowCount * colCount * 8` bytes,
 *  indexed `(row * colCount + col)`. MULTI-AXIS (N-D) tables carry `dims` +
 *  `mins` instead (region sized `Π dims * 8`, indexed `Σ idxₖ·strideₖ`);
 *  `dims` present ⇔ multi-axis — the emitters branch on it. */
export interface LookupTableLayoutInput {
  id: string;
  rowCount: number;
  colCount: number;
  /** Multi-axis only: per-axis dimensions (declared axis order, row-major). */
  dims?: number[];
  /** Multi-axis only: per-axis intRange index offsets (0 for label axes). */
  mins?: number[];
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

  /** Model-attr offsets (per slot key — "id", or "id_r/_g/_b/_a" for colour
   *  attrs), each f64. Slot list from the shared `modelAttrSlotKeys`. */
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

  /** Per Lookup Table model attr: byte `offset` of its f64 row-major region
   *  plus its `rowCount`/`colCount` dimensions (region sized
   *  `rowCount * colCount * 8`, indexed `[row * colCount + col]`). Keyed by
   *  attribute id. Allocated for every lookupTable attr regardless of
   *  variegation; empty map when the model has none. MULTI-AXIS tables carry
   *  `dims`/`mins` (region `Π dims * 8`, indexed `Σ idxₖ·strideₖ`); `dims`
   *  present ⇔ multi-axis. */
  interactionTableOffsets: Record<string, { offset: number; rowCount: number; colCount: number; dims?: number[]; mins?: number[] }>;

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

  // ---- "Skip Isolated Empty Cells" (docs/PLAN_LARGE_GRID_PERF.md) ----

  /** True when the layout was computed with sparse stepping on (the feature
   *  enabled + sync + gridCells — `sparseSteppingEnabled`). Reserves the
   *  active-list region AND switches the nbr tables to the compact
   *  packed-offset form (inline neighbour computation). */
  sparseStepping: boolean;
  /** Byte offset of the active-cell list (Int32Array, `total` capacity). The
   *  worker's ActiveSet.list is a VIEW over this region, so the sparse step
   *  (JS param / WASM baked offset) reads the live list with zero copies.
   *  Appended LAST so a non-sparse module's offsets are byte-identical. */
  activeListOffset: number;
  /** Bytes reserved for the active list (`total × 4`; 0 when off). */
  activeListBytes: number;
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
  lookupTables: LookupTableLayoutInput[] = [],
  // Agents-only (CA Grid off): the per-cell ENGINE regions — colors, glyphs,
  // async order/skipped arrays, and the sync attr WRITE buffers — exist only
  // for the cell step + grid render, neither of which runs when the grid is
  // off. Skipping them makes an agents-only world's memory scale with its
  // CELL ATTRIBUTES only (kept: agents read/deposit fields via readAttrs), so
  // a huge "container" world (e.g. 5000×500×500) with no cell attrs costs
  // ~nothing instead of 9 bytes/cell (which blew the wasm32 4 GiB Memory cap).
  // Callers that compile the lattice step never pass false (the lattice
  // targets are gated off entirely when the grid is off).
  gridCells: boolean = true,
  // "Skip Isolated Empty Cells": reserve the active-list region (appended LAST
  // so a non-sparse layout is byte-identical) + (Phase 3) compact nbr tables.
  // MUST equal `sparseSteppingEnabled(model)` on the compile side and the
  // worker's mirror predicate — layout-lockstep.
  sparseStepping: boolean = false,
  // WebGPU grid target: the STEP runs on the GPU (its own attrsBufA/B ping-pong),
  // so the CPU sync attr WRITE buffer (state+... one copy per writeable attr) is
  // dead weight — the only other CPU writers (init / gridInit / paint) write FINAL
  // values and are correct with write===read. Alias the write region to the read
  // region (0 extra bytes), exactly like the agents-only + async paths, so even a
  // 600³ 3D WebGPU grid fits under the wasm32 4 GiB Memory cap. Decided by the
  // worker from msg.useWebGPU (INTENT) — see sim.worker.ts `attrWriteAliased`.
  // COMPILE-side callers (computeLayoutFromModel → the WASM module) NEVER pass
  // true: the WASM sync step indexes a separate write buffer, so JS/WASM stay
  // byte-identical. This is WebGPU-grid-target-only.
  webgpuGridWriteAliased: boolean = false,
): MemoryLayout {
  let off = 0;
  const glyphsOn = hasGlyphs && gridCells;

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
  // Cell attrs — write region (sync only; grid off ⇒ no cell step ever writes,
  // so the write side aliases the read side like async mode; ditto the WebGPU
  // grid target — the sync STEP runs on the GPU, so no CPU function needs a
  // SEPARATE write buffer, see `webgpuGridWriteAliased`).
  if (!isAsync && gridCells && !webgpuGridWriteAliased) {
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

  // Colors region (RGBA Uint8 per cell; 0 bytes when the CA grid is off —
  // nothing renders the grid, and at agent-world scales 4 B/cell dominates)
  off = alignTo(off, 8);
  const colorsOffset = off;
  const colorsBytes = gridCells ? total * 4 : 0;
  off += colorsBytes;

  // Glyph regions (codes + packed RGB colours) — both u32 per cell, allocated
  // only when the model actually references setCellGlyph. Sized by `total`
  // (not `cellsPerAttr`) — there's no sentinel slot to read from.
  let glyphCodesOffset = 0;
  let glyphCodesBytes = 0;
  let glyphColorsOffset = 0;
  let glyphColorsBytes = 0;
  if (glyphsOn) {
    glyphCodesBytes = total * 4;
    off = alignTo(off, 8);
    glyphCodesOffset = off;
    off += glyphCodesBytes;
    glyphColorsBytes = total * 4;
    off = alignTo(off, 8);
    glyphColorsOffset = off;
    off += glyphColorsBytes;
  }

  // Neighbor index tables (Int32Array per neighborhood, length = total * coords.length).
  // "Skip Isolated Empty Cells" (inline-neighbour mode): COMPACT tables instead —
  // `coords.length` PACKED NIs per neighbourhood (a few dozen bytes vs
  // total×nSz×4, the 2.8 GB memory hog at 300³). The JS/WASM emitters decode
  // each slot inline (niCellExprStmts / pushNiCellIdx), reproducing the exact
  // torus-wrap / constant-sentinel indices the big table precomputed.
  const nbrIndexOffset: Record<string, number> = {};
  const nbrSize: Record<string, number> = {};
  for (const n of neighborhoods) {
    nbrSize[n.id] = n.coords.length;
    off = alignTo(off, 8);
    nbrIndexOffset[n.id] = off;
    off += (sparseStepping && gridCells ? 1 : total) * n.coords.length * 4;
  }

  // Model attrs region — one f64 slot per scalar (or per colour channel for
  // colour attrs: r/g/b/a). The slot list comes from the shared
  // `modelAttrSlotKeys` so this layout cannot drift from the worker's writer or
  // the other three mirror sites (see attributeScope.ts).
  const modelAttrOffset: Record<string, number> = {};
  off = alignTo(off, 8);
  for (const a of modelAttrs) {
    for (const key of modelAttrSlotKeys(a)) { modelAttrOffset[key] = off; off += 8; }
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

  // Order array (only meaningful in async mode, but reserve in both for layout
  // stability; 0 bytes when the CA grid is off — the async cell loop never runs)
  off = alignTo(off, 8);
  const orderOffset = off;
  off += gridCells ? total * 4 : 0;

  // Stop-event flag (single i32, padded to 8)
  off = alignTo(off, 8);
  const stopFlagOffset = off;
  off += 8;

  // Mark Cell Updated: per-cell Uint8 skip flag (only meaningful in async mode,
  // but reserve in both modes for layout stability — matches orderOffset).
  off = alignTo(off, 8);
  const skippedOffset = off;
  const skippedBytes = gridCells ? total : 0;
  off += alignTo(skippedBytes, 8);

  // Variegated Cells — facePatternLookup. Uploaded by the worker on
  // init/recompile. Sized once at layout time (count-driven, not value-driven)
  // so the layout is stable across live edits.
  let facePatternLookupOffset = 0;
  let facePatternLookupBytes = 0;
  if (variegated) {
    facePatternLookupBytes = variegated.speciesCount * FACE_SLOT_COUNT * 4;
    if (facePatternLookupBytes > 0) {
      off = alignTo(off, 8);
      facePatternLookupOffset = off;
      off += facePatternLookupBytes;
    }
  }
  // Lookup tables — allocated for every lookupTable model attr regardless of
  // variegation (tag×tag tables need no faces). Each is row-major f64, sized
  // rowCount*colCount*8, indexed (row*colCount + col). Stable per-table dims
  // baked at layout time; values are upload-only.
  const interactionTableOffsets: Record<string, { offset: number; rowCount: number; colCount: number; dims?: number[]; mins?: number[] }> = {};
  for (const t of lookupTables) {
    const rowCount = Math.max(1, t.rowCount);
    const colCount = Math.max(1, t.colCount);
    off = alignTo(off, 8);
    if (t.dims && t.dims.length > 0) {
      // Multi-axis: region sized Π dims × 8 (dims floor at 1 like row/col).
      const dims = t.dims.map(d => Math.max(1, Math.floor(d) || 1));
      const mins = dims.map((_, i) => Math.floor(t.mins?.[i] ?? 0) || 0);
      interactionTableOffsets[t.id] = { offset: off, rowCount, colCount, dims, mins };
      off += dims.reduce((a, b) => a * b, 1) * 8;
    } else {
      interactionTableOffsets[t.id] = { offset: off, rowCount, colCount };
      off += rowCount * colCount * 8;
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

  // "Skip Isolated Empty Cells": the active-cell list region. Appended LAST so
  // every offset above is byte-identical whether or not the feature is on.
  off = alignTo(off, 8);
  const activeListOffset = off;
  const activeListBytes = (sparseStepping && gridCells) ? total * 4 : 0;
  off += activeListBytes;

  const totalBytes = off;
  const pages = Math.max(1, Math.ceil(totalBytes / 65536));
  return {
    totalBytes, pages, isAsync, total,
    attrReadOffset, attrWriteOffset, attrTypeBytes, attrType,
    colorsOffset, colorsBytes,
    hasGlyphs: glyphsOn,
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
    interactionTableOffsets,
    scratchOffset, scratchBytes,
    sentinelIndex,
    sparseStepping: sparseStepping && gridCells,
    activeListOffset, activeListBytes,
  };
}

export function computeLayoutFromModel(
  model: CAModel,
  // WebGPU grid target: alias the CPU sync attr WRITE buffer to the read buffer
  // (see computeMemoryLayout's `webgpuGridWriteAliased`). ONLY the regression
  // harness passes true — every production compile caller omits it (default
  // false), so the WASM module's baked offsets keep the separate write region
  // and JS/WASM output stays byte-identical.
  webgpuGridWriteAliased: boolean = false,
): MemoryLayout {
  // Lower any `vector` cell attribute into its scalar-float components BEFORE
  // building the layout, so the WASM memory offsets match the compiler's
  // component reads/writes (lowerVectorAttrs, run inside compileGraphWasm) — the
  // ABI-mirror discipline. Vector attrs are cell/agent-only, so model attrs are
  // unaffected. Identity no-op when there are none. See vectorAttr.ts.
  const cellAttrs = expandVectorAttributes(model.attributes).filter(a => !a.isModelAttribute);
  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);
  // 3D Grid CA: the nbr region is sized by neighbour COUNT (the stride). For a
  // 3D neighbourhood coords3d is the source of truth (coords stays a same-length
  // projection); fall back to a coords3d-derived 2D list so a hand-edited file
  // with empty `coords` but populated `coords3d` still sizes the region correctly.
  const neighborhoods = model.neighborhoods.map(n => ({
    id: n.id,
    coords: (n.coords && n.coords.length
      ? n.coords
      : (n.coords3d ?? []).map(c => [c[0], c[1]] as [number, number])) as Array<[number, number]>,
  }));
  const indicators = (model.indicators || []).map(i => ({ id: i.id, kind: i.kind }));
  // 3D Grid CA: total = W*H*D (only honour gridDepth in a 3D model — mirrors the
  // worker's `depth` derivation so the baked `total` literal can't desync).
  const depth = model.properties.dimension === '3d' ? Math.max(1, model.properties.gridDepth ?? 1) : 1;
  const total = model.properties.gridWidth * model.properties.gridHeight * depth;
  const isAsync = model.properties.updateMode === 'asynchronous';
  let variegated: VariegatedLayoutInputs | undefined;
  if (model.variegatedCells?.enabled) {
    const source = model.attributes.find(a => a.id === model.variegatedCells!.sourceAttributeId);
    const speciesCount = source && source.type === 'tag' && !source.isModelAttribute
      ? (source.tagOptions?.length ?? 0) : 0;
    variegated = { speciesCount };
  }
  // Lookup tables — every lookupTable model attr, dims resolved per axis key
  // source (face palette or tag attribute). Independent of variegation.
  // Multi-axis tables resolve through resolveAxes (the single source of truth
  // shared with every other layout/emit consumer — layout-lockstep).
  const lookupTables: LookupTableLayoutInput[] = model.attributes
    .filter(a => a.isModelAttribute && a.type === 'lookupTable')
    .map(a => {
      if (isMultiAxisTable(a)) {
        const r = resolveAxes(a, model);
        return { id: a.id, rowCount: r.dims[0] ?? 1, colCount: r.dims[1] ?? 1, dims: r.dims, mins: r.mins };
      }
      return {
        id: a.id,
        rowCount: resolveKeyLabels(a.rowKeySource, model).length || 1,
        colCount: resolveKeyLabels(a.colKeySource, model).length || 1,
      };
    });
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
    lookupTables,
    true,
    sparseSteppingEnabled(model),
    webgpuGridWriteAliased,
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
