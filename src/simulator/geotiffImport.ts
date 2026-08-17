/**
 * GeoTIFF import — the raster sibling of `csvImport.ts`'s Esri ASCII grid path.
 *
 * Tier 2 of docs/INVESTIGATION_GEOSPATIAL_IO.md. The real-world sources
 * (LANDFIRE, WorldPop, NLCD, Copernicus) ship GeoTIFF, and asking users to
 * convert every band to `.asc` in QGIS first is pure friction. This module reads
 * one client-side, band by band, and hands the SAME `importGridValues` payload
 * the `.asc` path produces — so there is ZERO compiler / worker impact.
 *
 * Split by testability, deliberately:
 *   - Everything above `openGeoTiff` is PURE and dependency-free (the crop
 *     window, the numeric decode, the georef conversion + window shift, the
 *     categorical value map; the resampling kernels themselves live in the
 *     shared `rasterResample.ts`), so `scripts/test-geotiff-import.mjs` asserts
 *     VALUES on it without a browser.
 *   - `openGeoTiff` is the only impure part, and it reaches geotiff.js through
 *     `geotiffLoader.ts` — the one module the viewer build aliases away.
 *
 * THE SOURCE IS NEVER READ WHOLE. `openGeoTiff` reads metadata only; every band
 * read is bounded by a crop WINDOW the user sets in the dialog. That is what
 * makes a country-scale download openable here instead of in QGIS.
 *
 * NO REPROJECTION, by design (the doctrine every surveyed tool follows, and the
 * same one `.asc` import states): if the file's CRS differs from the model's we
 * SAY so and point at QGIS. Alignment happens upstream.
 */

import { encodeAttrValue } from '../model/attrValueEncoding';
import type { GeoReference } from '../model/types';
import type { CsvAttrShape, CsvIssue } from './csvImport';
import { loadGeoTiffLib } from './geotiffLoader';
import { resampleAverage, resampleNearest, type RasterResampleMethod } from './rasterResample';

export { GEOTIFF_SUPPORTED } from './geotiffLoader';

// ---------------------------------------------------------------------------
// Caps — a browser tab, not a GIS workstation
//
// THE CAPS APPLY TO THE **WINDOW**, NOT TO THE SOURCE. geotiff.js's
// `readRasters({ window })` bounds its tile/strip loop AND its allocation by the
// window (verified against geotiff@3.0.5's `_readRaster`: `minXTile..maxXTile`
// come from the window, and `numPixels = windowW*windowH`), so a country-scale
// source is perfectly readable as long as you only ask for a piece of it. That
// is what lets the dialog offer a CROP instead of an error message.
// ---------------------------------------------------------------------------

/** Refuse a WINDOW wider/taller than this on either axis. */
export const GEOTIFF_MAX_DIM = 8192;
/** …and refuse a WINDOW with more pixels than this (the read allocates
 *  `windowPixels` samples per band, normalised to Float64 here). 16 Mpx = a
 *  4096² tile; above that the dialog asks for a smaller crop. */
export const GEOTIFF_MAX_PIXELS = 16_777_216;
/** Sanity ceiling on the SOURCE dimensions. Not a memory bound (nothing reads
 *  the whole source any more) — just a guard against a corrupt header claiming
 *  an absurd raster size. */
export const GEOTIFF_MAX_SOURCE_DIM = 200_000;
/** Bands offered in the dialog. Hyperspectral stacks exist; mapping 200 of them
 *  by hand does not. */
export const GEOTIFF_MAX_BANDS = 16;
/** Distinct raw values enumerated for a categorical (tag/bool) band before we
 *  conclude "this is not categorical" and fall back to the plain numeric decode. */
export const GEOTIFF_MAX_DISTINCT = 64;

// ---------------------------------------------------------------------------
// The crop window (PURE)
// ---------------------------------------------------------------------------

/** A sub-rectangle of the source raster, in SOURCE PIXELS, top-left origin.
 *  Half-open: rows `y .. y+height-1`, columns `x .. x+width-1`. */
export interface GeoTiffWindow { x: number; y: number; width: number; height: number }

/** Clamp a window into the raster, keeping at least one pixel. */
export function clampWindow(win: GeoTiffWindow, srcW: number, srcH: number): GeoTiffWindow {
  const x = Math.max(0, Math.min(Math.round(win.x), Math.max(0, srcW - 1)));
  const y = Math.max(0, Math.min(Math.round(win.y), Math.max(0, srcH - 1)));
  const width = Math.max(1, Math.min(Math.round(win.width), srcW - x));
  const height = Math.max(1, Math.min(Math.round(win.height), srcH - y));
  return { x, y, width, height };
}

/** The window a freshly-opened file starts on: the WHOLE image when it fits the
 *  caps, else the largest cap-shaped window CENTRED on it.
 *
 *  Centring rather than rejecting is the point of the whole feature — a
 *  country-scale source opens with a usable default the user then drags, instead
 *  of an error telling them to go and install QGIS. */
export function defaultWindow(srcW: number, srcH: number): GeoTiffWindow {
  const w0 = Math.max(1, Math.min(srcW, GEOTIFF_MAX_DIM));
  const h0 = Math.max(1, Math.min(srcH, GEOTIFF_MAX_DIM));
  let w = w0, h = h0;
  if (w * h > GEOTIFF_MAX_PIXELS) {
    // Shrink both axes by the SAME factor, so when only the pixel cap binds the
    // default keeps the source's aspect ratio (a lopsided box reads as a bug).
    // The per-axis clamp above is axis-INDEPENDENT and cannot preserve it — but
    // a uniform shrink there would be worse: a 90000×200 strip would lose 91 %
    // of its rows to satisfy a cap its pixel count never came near.
    const k = Math.sqrt(GEOTIFF_MAX_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  return clampWindow({ x: Math.floor((srcW - w) / 2), y: Math.floor((srcH - h) / 2), width: w, height: h }, srcW, srcH);
}

/** Why this window cannot be read, or null when it can. */
export function windowCapError(win: GeoTiffWindow): string | null {
  if (win.width > GEOTIFF_MAX_DIM || win.height > GEOTIFF_MAX_DIM) {
    return `The crop is ${win.width}×${win.height}; GenesisCA reads up to ${GEOTIFF_MAX_DIM} on each axis. Drag the box smaller.`;
  }
  if (win.width * win.height > GEOTIFF_MAX_PIXELS) {
    return `The crop holds ${(win.width * win.height).toLocaleString()} pixels; GenesisCA reads up to ${GEOTIFF_MAX_PIXELS.toLocaleString()} (a 4096² tile). Drag the box smaller.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resampling (PURE) — implemented in `rasterResample.ts` so the `.asc` importer
// runs the IDENTICAL kernels; re-exported here because this module has been the
// public face of raster resampling since Tier 2.
// ---------------------------------------------------------------------------

export { resampleNearest, resampleAverage, resampleRaster } from './rasterResample';

/** How a band is resampled when the crop's dimensions differ from the grid's. */
export type GeoTiffResampleMethod = RasterResampleMethod;

/** True when `average` is a legitimate choice for this target.
 *
 *  Categorical targets are excluded BY DOCTRINE, not by capability: the mean of
 *  fuel models 1 and 7 is 4, which may well be a different fuel model. The UI
 *  hides the control for them (the standing "an enabled control must do
 *  something" rule) and `buildBandValues` enforces it regardless. */
export function supportsAverageResample(attr: CsvAttrShape): boolean {
  return attr.type === 'integer' || attr.type === 'float' || attr.type === 'neighborIndex';
}

// ---------------------------------------------------------------------------
// Numeric value decoding (PURE)
// ---------------------------------------------------------------------------

/** Mirrors `CsvDecode`: `ok:false` ⇒ `value` is the attribute DEFAULT, never a
 *  guess, and the caller counts + reports the miss. */
export interface NumericDecode { value: number; ok: boolean }

/** Decode ONE raster sample into the numeric form the worker stores.
 *
 *  A raster band is already NUMBERS, so this is the numeric twin of
 *  `decodeCsvValue` (which starts from text) rather than a wrapper around it —
 *  stringifying a float only to re-parse it would be lossy theatre.
 *
 *    integer / neighborIndex → ROUNDED
 *    float                   → as-is
 *    bool                    → NONZERO is true (the universal raster mask
 *                              convention: 0 = absent, anything else = present)
 *    tag                     → the option INDEX (rounded); out of range ⇒ default
 *    other                   → default (a colour / lookupTable is not a per-cell
 *                              scalar)
 *
 *  A non-finite sample (a float band's NaN fill) takes the default, counted. */
export function decodeNumericValue(attr: CsvAttrShape, v: number): NumericDecode {
  const fallback = encodeAttrValue(attr, undefined);
  if (!Number.isFinite(v)) return { value: fallback, ok: false };
  switch (attr.type) {
    case 'integer':
    case 'neighborIndex':
      return { value: Math.round(v), ok: true };
    case 'float':
      return { value: v, ok: true };
    case 'bool':
      return { value: v !== 0 ? 1 : 0, ok: true };
    case 'tag': {
      const n = Math.round(v);
      const len = (attr.tagOptions ?? []).length;
      return n >= 0 && n < len ? { value: n, ok: true } : { value: fallback, ok: false };
    }
    default:
      return { value: fallback, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Categorical value map (PURE) — the Cell2Fire code→fuel table, as UI
// ---------------------------------------------------------------------------

/** A distinct raw value found in a band, with how many cells carry it. */
export interface GeoTiffValueInfo { value: number; count: number }

/** raw band value → the value it stands for, in the CANONICAL
 *  `Attribute.defaultValue` string encoding (a tag is its INDEX string, a bool
 *  is `'true'`/`'false'`, numbers are decimal) — the SAME shape `CsvCharMap`
 *  uses, so it feeds `encodeAttrValue` and the existing inline widgets
 *  unchanged. Keyed by `String(rawValue)`.
 *
 *  An ABSENT key or `''` means UNMAPPED → the attribute default (counted and
 *  reported, never silent). */
export type GeoTiffValueMap = Record<string, string>;

/** Distinct raw values of a band, most frequent first (the "background" class
 *  leads), ties by value ascending. Stops enumerating past `cap` and reports
 *  `truncated` — a continuous band has ~one distinct value per cell, and a table
 *  of a million rows is not a mapping UI. NaN / non-finite samples are skipped
 *  (they decode to the default regardless). */
export function distinctValues(
  band: ArrayLike<number>, cap = GEOTIFF_MAX_DISTINCT,
): { values: GeoTiffValueInfo[]; truncated: boolean } {
  const counts = new Map<number, number>();
  let truncated = false;
  for (let i = 0; i < band.length; i++) {
    const v = band[i] as number;
    if (!Number.isFinite(v)) continue;
    const prev = counts.get(v);
    if (prev === undefined) {
      if (counts.size >= cap) { truncated = true; continue; }
      counts.set(v, 1);
    } else counts.set(v, prev + 1);
  }
  const values = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (b.count - a.count) || (a.value - b.value));
  return { values, truncated };
}

/** Conservative auto-seed for the value map — IDENTITY where it is already
 *  meaningful, nothing where it is not (every seed is visible + editable, and an
 *  unseeded value takes the attribute default and is reported).
 *
 *    tag  → a value that is already a valid option INDEX maps to that option.
 *    bool → 0 → false, anything else → true (the raster mask convention).
 *    else → the value maps to itself.
 *
 *  So the common case (a raster already written with the model's own codes)
 *  needs no user input at all, and a mismatched code shows up as unmapped. */
export function autoSeedValueMap(values: Array<GeoTiffValueInfo | number>, attr: CsvAttrShape): GeoTiffValueMap {
  const list = values.map(v => (typeof v === 'number' ? v : v.value));
  const map: GeoTiffValueMap = {};
  const len = (attr.tagOptions ?? []).length;
  for (const v of list) {
    if (!Number.isFinite(v)) continue;
    const key = String(v);
    if (attr.type === 'tag') {
      const n = Math.round(v);
      if (n >= 0 && n < len && n === v) map[key] = String(n);
    } else if (attr.type === 'bool') {
      map[key] = v !== 0 ? 'true' : 'false';
    } else {
      map[key] = String(v);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Band → grid values (PURE) — resample, then decode
// ---------------------------------------------------------------------------

/** Mirrors `CsvGridBuild` field-for-field so the dialog's reporting is shared. */
export interface GeoTiffBandBuild {
  /** Row-major, length `width*height`. */
  values: Float64Array;
  width: number;
  height: number;
  /** Samples that could not become a value for this attribute (→ default). */
  badValues: number;
  /** Samples equal to the file's NODATA (→ default). Counted SEPARATELY —
   *  "outside the study area" is a legitimate statement, not a parse failure. */
  nodataCells: number;
  /** With a value map: the distinct raw values that carried NO mapping. Reported
   *  per VALUE, not per cell (one unmapped background class would otherwise
   *  flood the issue list with a million identical entries). */
  unmappedValues: number[];
  issues: CsvIssue[];
}

const MAX_ISSUES = 12;

/** Build the flat row-major block `importGridValues` takes.
 *
 *  ORDER IS RESAMPLE → DECODE, and it matters: nearest resampling picks a whole
 *  source sample, so NODATA and categorical codes survive the resize intact and
 *  are compared/looked-up in their ORIGINAL numeric form. Decoding first would
 *  resample already-defaulted values and lose the distinction.
 *
 *  `noData` is compared NUMERICALLY (so `-9999` and `-9999.0` both match) BEFORE
 *  the decode. `valueMap` (the categorical table) replaces the per-type decode
 *  with a raw-value lookup; an unmapped value takes the default and is counted. */
export function buildBandValues(
  band: ArrayLike<number>, srcW: number, srcH: number,
  dstW: number, dstH: number,
  attr: CsvAttrShape,
  opts?: { noData?: number | null; valueMap?: GeoTiffValueMap; resample?: GeoTiffResampleMethod },
): GeoTiffBandBuild {
  // `average` is refused STRUCTURALLY for a categorical target or a code table —
  // the pure function is the last line of defence, so a caller that ignores
  // `supportsAverageResample` still cannot average class codes into ones the
  // model does not have.
  const method: GeoTiffResampleMethod =
    opts?.resample === 'average' && supportsAverageResample(attr) && !opts?.valueMap ? 'average' : 'nearest';
  const raw = method === 'average'
    ? resampleAverage(band, srcW, srcH, dstW, dstH, opts?.noData)
    : resampleNearest(band, srcW, srcH, dstW, dstH);
  const values = new Float64Array(raw.length);
  const fallback = encodeAttrValue(attr, undefined);
  const noData = opts?.noData;
  const hasNoData = noData !== undefined && noData !== null && Number.isFinite(noData);
  const out: GeoTiffBandBuild = {
    values, width: dstW, height: dstH,
    badValues: 0, nodataCells: 0, unmappedValues: [], issues: [],
  };
  // Pre-encode the map ONCE (a raster is large; the map is tiny).
  let enc: Map<number, number> | null = null;
  if (opts?.valueMap) {
    enc = new Map<number, number>();
    for (const [k, v] of Object.entries(opts.valueMap)) {
      if (v === undefined || v === '') continue;
      const n = Number(k);
      if (Number.isFinite(n)) enc.set(n, encodeAttrValue(attr, v));
    }
  }
  const seen = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]!;
    if (hasNoData && v === noData) { values[i] = fallback; out.nodataCells++; continue; }
    if (enc) {
      const mapped = enc.get(v);
      if (mapped === undefined) {
        values[i] = fallback;
        out.badValues++;
        if (!seen.has(v)) {
          seen.add(v);
          out.unmappedValues.push(v);
          if (out.issues.length < MAX_ISSUES) {
            out.issues.push({ row: Math.floor(i / dstW) + 1, column: `column ${(i % dstW) + 1}`, raw: String(v), reason: 'unmapped value → default' });
          }
        }
        continue;
      }
      values[i] = mapped;
      continue;
    }
    const d = decodeNumericValue(attr, v);
    values[i] = d.value;
    if (!d.ok) {
      out.badValues++;
      if (out.issues.length < MAX_ISSUES) {
        out.issues.push({ row: Math.floor(i / dstW) + 1, column: `column ${(i % dstW) + 1}`, raw: String(v), reason: `not a valid ${attr.type} value` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Georeference (PURE) — GeoTIFF's TOP-LEFT origin → Esri's LOWER-LEFT corner
// ---------------------------------------------------------------------------

export interface GeoTiffGeorefInput {
  /** `image.getOrigin()` — the TOP-LEFT corner of the raster in world units. */
  origin: ArrayLike<number> | null | undefined;
  /** `image.getResolution()` — `[xres, yres]`; `yres` is normally NEGATIVE
   *  (world Y grows UP while raster rows grow DOWN). */
  resolution: ArrayLike<number> | null | undefined;
  width: number;
  height: number;
  crs?: string;
}

export interface GeoTiffGeorefResult {
  georef: GeoReference | null;
  /** Set when |xres| ≠ |yres| — `GeoReference` carries ONE square cell size, so
   *  we take |xres| and say so rather than silently distorting the model. */
  nonSquareWarning?: string;
}

/** Convert a GeoTIFF's origin + pixel scale into the Esri lower-left-corner
 *  convention `GeoReference` (and every GenesisCA georef consumer) uses.
 *
 *  THE FLIP IS THE WHOLE POINT: GeoTIFF states the TOP-LEFT corner, `.asc` and
 *  `GeoReference` state the LOWER-LEFT, so
 *      `yllcorner = topY − height · |yres|`.
 *  A file whose `yres` is POSITIVE already has its origin at the BOTTOM (rare
 *  but legal), so no subtraction applies there. */
export function georefFromGeoTiff(input: GeoTiffGeorefInput): GeoTiffGeorefResult {
  const ox = Number(input.origin?.[0]);
  const oy = Number(input.origin?.[1]);
  const rx = Number(input.resolution?.[0]);
  const ry = Number(input.resolution?.[1]);
  if (![ox, oy, rx, ry].every(Number.isFinite) || rx === 0 || ry === 0) {
    return { georef: null };
  }
  const cellSize = Math.abs(rx);
  const yll = ry < 0 ? oy - input.height * Math.abs(ry) : oy;
  const georef: GeoReference = { xllcorner: ox, yllcorner: yll, cellSize };
  if (input.crs) georef.crs = input.crs;
  const out: GeoTiffGeorefResult = { georef };
  if (Math.abs(Math.abs(rx) - Math.abs(ry)) > 1e-9 * Math.max(Math.abs(rx), Math.abs(ry))) {
    out.nonSquareWarning = `Non-square pixels (${Math.abs(rx)} × ${Math.abs(ry)}) — GenesisCA cells are square, so the X size was used.`;
  }
  return out;
}

/** Re-express a georef for a grid the raster was RESAMPLED onto.
 *
 *  The extent is unchanged (the same ground is covered by fewer/more cells), so
 *  the lower-left corner stays put and only the cell size scales:
 *      `cellSize' = cellSize · srcW / dstW`.
 *  X drives it because `GeoReference` has ONE size; a resample whose X and Y
 *  ratios differ distorts the model, and the caller says so. */
export function scaleGeorefForResample(
  georef: GeoReference, srcW: number, srcH: number, dstW: number, dstH: number,
): { georef: GeoReference; aspectWarning?: string } {
  if (srcW === dstW && srcH === dstH) return { georef };
  if (dstW < 1 || dstH < 1) return { georef };
  const scaled: GeoReference = { ...georef, cellSize: (georef.cellSize * srcW) / dstW };
  const rx = srcW / dstW;
  const ry = srcH / dstH;
  const out: { georef: GeoReference; aspectWarning?: string } = { georef: scaled };
  if (Math.abs(rx - ry) > 1e-9 * Math.max(rx, ry)) {
    out.aspectWarning = `The grid (${dstW}×${dstH}) has a different aspect ratio from the raster (${srcW}×${srcH}) — the cell size follows the X axis, so world coordinates stretch along Y.`;
  }
  return out;
}

/** Re-express a georef for a CROPPED window of the raster it describes.
 *
 *  THE ROW FLIP IS THE TRAP, and it is the same one `georefFromGeoTiff` handles:
 *  the georef states the raster's LOWER-LEFT corner while the window is given in
 *  TOP-LEFT pixel coordinates, so the window's bottom edge sits `srcH − y − h`
 *  rows ABOVE the raster's bottom edge:
 *
 *      xll' = xll + x · cellSize
 *      yll' = yll + (srcH − y − height) · cellSize
 *
 *  The cell size is unchanged — a crop selects fewer cells of the SAME ground
 *  resolution. (A resample changes the size; compose the two with
 *  `scaleGeorefForResample`, in that order.)
 *
 *  Sanity: `y = 0` (the TOP rows) gives the largest yll, and
 *  `y = srcH − height` (the BOTTOM rows) gives exactly the original yll. */
export function shiftGeorefForWindow(
  georef: GeoReference, win: GeoTiffWindow, srcH: number,
): GeoReference {
  return {
    ...georef,
    xllcorner: georef.xllcorner + win.x * georef.cellSize,
    yllcorner: georef.yllcorner + (srcH - win.y - win.height) * georef.cellSize,
  };
}

/** Map the GeoTIFF geo keys onto an `EPSG:xxxx` string, or null.
 *
 *  Projected wins over geographic (a file carrying both is projected); 32767 is
 *  the "user-defined" sentinel and names nothing, so it is skipped. */
export function crsFromGeoKeys(keys: Record<string, unknown> | null | undefined): string | null {
  if (!keys) return null;
  const pick = (v: unknown): number | null => {
    const n = Array.isArray(v) ? Number(v[0]) : Number(v);
    return Number.isFinite(n) && n > 0 && n !== 32767 ? n : null;
  };
  const proj = pick(keys.ProjectedCSTypeGeoKey);
  if (proj !== null) return `EPSG:${proj}`;
  const geog = pick(keys.GeographicTypeGeoKey);
  if (geog !== null) return `EPSG:${geog}`;
  return null;
}

// ---------------------------------------------------------------------------
// Opening a file (the ONE impure entry point)
// ---------------------------------------------------------------------------

export interface GeoTiffBandInfo {
  index: number;
  /** `Float32` / `Int16` / `UInt8` … — the sample format + bit depth, for the UI. */
  typeLabel: string;
}

/** A decimated whole-image band, for the crop preview. */
export interface GeoTiffPreview { data: Float64Array; width: number; height: number }

export interface GeoTiffFile {
  width: number;
  height: number;
  /** Bands the file declares (may exceed `bands.length` — see GEOTIFF_MAX_BANDS). */
  bandCount: number;
  /** The bands this dialog offers (the first GEOTIFF_MAX_BANDS). */
  bands: GeoTiffBandInfo[];
  /** `GDAL_NODATA`, or null when the file declares none. */
  noData: number | null;
  georef: GeoReference | null;
  /** Non-square pixels etc. — informational, never blocking. */
  warnings: string[];
  /** Read ONE band over a WINDOW (default: the whole image) at source
   *  resolution. Cached by band + window: the dialog reads a band to build its
   *  value map and again on Apply, and a re-read would re-decompress.
   *
   *  The window bounds geotiff.js's tile loop AND its allocation, so this is the
   *  ONLY read the caps apply to — see the caps block at the top. */
  readBand(index: number, win?: GeoTiffWindow): Promise<Float64Array>;
  /** A whole-image thumbnail of one band, ≤ `maxEdge` on the long side, for the
   *  crop box to sit on. Null when the source is too big to decode whole AND
   *  carries no usable overview — the dialog then says so and the user crops
   *  numerically. Cached per band. */
  readPreview(index: number, maxEdge: number): Promise<GeoTiffPreview | null>;
  /** Whether `readPreview` can show the whole image at all (known at open time,
   *  so the dialog can lay itself out without waiting for a decode). */
  previewAvailable: boolean;
}

const SAMPLE_FORMAT_LABEL: Record<number, string> = { 1: 'UInt', 2: 'Int', 3: 'Float' };
/** Pixels we are willing to DECODE for a preview. Same budget as one import
 *  window — a preview is a one-off read, not a per-frame cost. */
const PREVIEW_DECODE_PIXELS = GEOTIFF_MAX_PIXELS;
/** Band reads kept in hand. The dialog re-reads as the crop box moves, so an
 *  unbounded cache would retain every window the user dragged through. */
const BAND_CACHE_MAX = 6;

/** Open a GeoTIFF from raw bytes. Reads METADATA ONLY (plus, lazily, whatever
 *  window the caller asks for), so a source far larger than the import caps
 *  opens fine and is cropped in the dialog.
 *
 *  Throws a NAMED error when the file is not a GeoTIFF or declares an absurd
 *  raster size. */
export async function openGeoTiff(buffer: ArrayBuffer): Promise<GeoTiffFile> {
  const lib = await loadGeoTiffLib();
  const tiff = await lib.fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  if (!(width > 0) || !(height > 0)) throw new Error('The GeoTIFF declares no raster size.');
  if (width > GEOTIFF_MAX_SOURCE_DIM || height > GEOTIFF_MAX_SOURCE_DIM) {
    throw new Error(`The file declares a ${width}×${height} raster, which is beyond anything GenesisCA can address — the header looks corrupt.`);
  }

  const bandCount = Math.max(1, image.getSamplesPerPixel());
  const bands: GeoTiffBandInfo[] = [];
  for (let i = 0; i < Math.min(bandCount, GEOTIFF_MAX_BANDS); i++) {
    let typeLabel = 'sample';
    try {
      const fmt = SAMPLE_FORMAT_LABEL[image.getSampleFormat(i)] ?? 'UInt';
      typeLabel = `${fmt}${image.getBitsPerSample(i)}`;
    } catch { /* a malformed per-sample tag must not stop the import */ }
    bands.push({ index: i, typeLabel });
  }

  const warnings: string[] = [];
  let noData: number | null = null;
  try {
    const nd = image.getGDALNoData();
    if (nd !== null && nd !== undefined && Number.isFinite(nd)) noData = nd;
  } catch { /* no GDAL_NODATA tag */ }

  let georef: GeoReference | null = null;
  try {
    const crs = crsFromGeoKeys(image.getGeoKeys() as Record<string, unknown> | null);
    const g = georefFromGeoTiff({
      origin: image.getOrigin(), resolution: image.getResolution(),
      width, height, crs: crs ?? undefined,
    });
    georef = g.georef;
    if (g.nonSquareWarning) warnings.push(g.nonSquareWarning);
  } catch {
    warnings.push('The file carries no readable georeference (no origin / pixel scale).');
  }
  if (!georef && warnings.length === 0) {
    warnings.push('The file carries no georeference — the model keeps whatever it already had.');
  }
  if (bandCount > GEOTIFF_MAX_BANDS) {
    warnings.push(`The file has ${bandCount} bands; the first ${GEOTIFF_MAX_BANDS} are offered.`);
  }
  if (width * height > GEOTIFF_MAX_PIXELS) {
    warnings.push(`The raster is ${width.toLocaleString()}×${height.toLocaleString()} — larger than one import can read, so the crop box opens on a centred ${GEOTIFF_MAX_PIXELS.toLocaleString()}-pixel window. Move or resize it to pick the area you want.`);
  }

  // --- pick the image the crop preview decodes ------------------------------
  // Prefer a reduced-resolution OVERVIEW (a COG carries a pyramid, and reading
  // one is the difference between decoding 512² and decoding 40 000²); fall back
  // to the main image when it fits the decode budget; else there is no
  // whole-image preview and the dialog says so.
  const previewImage = await pickPreviewImage(tiff, image, width, height);

  type BandKey = string;
  const cache = new Map<BandKey, Float64Array>();
  const remember = (key: BandKey, data: Float64Array) => {
    cache.set(key, data);
    while (cache.size > BAND_CACHE_MAX) {
      const oldest = cache.keys().next().value as BandKey | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  /** Normalise whatever typed array geotiff.js returns to Float64 ONCE: every
   *  consumer below (the resamplers, the value map, the decode) then works on
   *  one representation, and an Int32 / UInt16 band's values survive exactly. */
  const toF64 = (arr: ArrayLike<number>, len: number): Float64Array => {
    const out = new Float64Array(len);
    const n = Math.min(len, arr.length);
    for (let i = 0; i < n; i++) out[i] = arr[i] as number;
    return out;
  };

  const readBand = async (index: number, win?: GeoTiffWindow): Promise<Float64Array> => {
    const w = clampWindow(win ?? { x: 0, y: 0, width, height }, width, height);
    const capped = windowCapError(w);
    if (capped) throw new Error(capped);
    const key = `${index}|${w.x},${w.y},${w.width},${w.height}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const rasters = await image.readRasters({
      samples: [index], interleave: false,
      window: [w.x, w.y, w.x + w.width, w.y + w.height],
    });
    const arr = (Array.isArray(rasters) ? rasters[0] : rasters) as ArrayLike<number> | undefined;
    if (!arr) throw new Error(`Band ${index + 1} could not be read.`);
    const out = toF64(arr, w.width * w.height);
    remember(key, out);
    return out;
  };

  const previewCache = new Map<string, GeoTiffPreview>();
  const readPreview = async (index: number, maxEdge: number): Promise<GeoTiffPreview | null> => {
    if (!previewImage) return null;
    const key = `${index}|${maxEdge}`;
    const hit = previewCache.get(key);
    if (hit) return hit;
    const sw = previewImage.getWidth();
    const sh = previewImage.getHeight();
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const pw = Math.max(1, Math.round(sw * scale));
    const ph = Math.max(1, Math.round(sh * scale));
    // `width`/`height` resampling happens AFTER the decode in geotiff.js, so it
    // shrinks the RESULT, not the work — which is exactly why the decode budget
    // is enforced on the chosen image above rather than here.
    const rasters = await previewImage.readRasters({
      samples: [index], interleave: false, width: pw, height: ph,
    });
    const arr = (Array.isArray(rasters) ? rasters[0] : rasters) as ArrayLike<number> | undefined;
    if (!arr) return null;
    const out: GeoTiffPreview = { data: toF64(arr, pw * ph), width: pw, height: ph };
    previewCache.set(key, out);
    return out;
  };

  return {
    width, height, bandCount, bands, noData, georef, warnings,
    readBand, readPreview, previewAvailable: previewImage !== null,
  };
}

/** Choose which IFD the crop preview decodes: the smallest image that still
 *  resolves the preview reasonably, under the decode budget.
 *
 *  Overviews are identified by the standard heuristic — a SMALLER image with
 *  (roughly) the same aspect ratio — plus an explicit skip of transparency masks
 *  (`NewSubfileType` bit 2), which are the one extra-IFD kind that would
 *  otherwise pass it. Every probe is wrapped: a malformed sub-image must cost us
 *  the preview, not the import. */
async function pickPreviewImage(
  tiff: { getImageCount(): Promise<number>; getImage(i?: number): Promise<GeoTiffImageLike> },
  main: GeoTiffImageLike, width: number, height: number,
): Promise<GeoTiffImageLike | null> {
  const candidates: GeoTiffImageLike[] = [];
  try {
    const count = await tiff.getImageCount();
    const aspect = width / height;
    for (let i = 1; i < count; i++) {
      try {
        const im = await tiff.getImage(i);
        const w = im.getWidth(), h = im.getHeight();
        if (!(w > 0) || !(h > 0) || w > width || h > height) continue;
        const sub = Number((im.fileDirectory as { NewSubfileType?: number } | undefined)?.NewSubfileType ?? 0);
        if (Number.isFinite(sub) && (sub & 4) !== 0) continue; // a transparency mask, not an overview
        if (Math.abs(w / h - aspect) > 0.05 * aspect) continue;
        if (w * h <= PREVIEW_DECODE_PIXELS) candidates.push(im);
      } catch { /* a sub-image we cannot read is simply not a preview source */ }
    }
  } catch { /* single-IFD file, or a reader that cannot enumerate */ }
  if (width * height <= PREVIEW_DECODE_PIXELS) candidates.push(main);
  if (candidates.length === 0) return null;
  // The SMALLEST candidate that still has some detail — decoding a 40 000² main
  // image when a 512² overview exists is pure waste.
  candidates.sort((a, b) => a.getWidth() * a.getHeight() - b.getWidth() * b.getHeight());
  const enough = candidates.find(im => Math.max(im.getWidth(), im.getHeight()) >= PREVIEW_MIN_EDGE);
  return enough ?? candidates[candidates.length - 1]!;
}

/** Below this the preview is too coarse to aim a crop box with, so a bigger
 *  overview (or the main image) is preferred when one is affordable. */
const PREVIEW_MIN_EDGE = 256;

/** The slice of geotiff.js's image we actually use. Structural, so the loader's
 *  types never leak into the pure half of this module. */
interface GeoTiffImageLike {
  getWidth(): number;
  getHeight(): number;
  readRasters(opts: Record<string, unknown>): Promise<unknown>;
  fileDirectory?: unknown;
}
