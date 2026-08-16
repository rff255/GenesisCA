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
 *   - Everything below `openGeoTiff` is PURE and dependency-free (the resampler,
 *     the numeric decode, the georef conversion, the categorical value map), so
 *     `scripts/test-geotiff-import.mjs` asserts VALUES on it without a browser.
 *   - `openGeoTiff` is the only impure part, and it reaches geotiff.js through
 *     `geotiffLoader.ts` — the one module the viewer build aliases away.
 *
 * NO REPROJECTION, by design (the doctrine every surveyed tool follows, and the
 * same one `.asc` import states): if the file's CRS differs from the model's we
 * SAY so and point at QGIS. Alignment happens upstream.
 */

import { encodeAttrValue } from '../model/attrValueEncoding';
import type { GeoReference } from '../model/types';
import type { CsvAttrShape, CsvIssue } from './csvImport';
import { loadGeoTiffLib } from './geotiffLoader';

export { GEOTIFF_SUPPORTED } from './geotiffLoader';

// ---------------------------------------------------------------------------
// Caps — a browser tab, not a GIS workstation
// ---------------------------------------------------------------------------

/** Refuse a raster wider/taller than this on EITHER axis. */
export const GEOTIFF_MAX_DIM = 8192;
/** …and refuse one with more pixels than this in total (a band is read whole at
 *  source resolution so the pure resampler owns the sampling, so the memory is
 *  `pixels × bytesPerSample` per band read). 16 Mpx = a 4096² tile. Crop in QGIS
 *  above that — the error message says so. */
export const GEOTIFF_MAX_PIXELS = 16_777_216;
/** Bands offered in the dialog. Hyperspectral stacks exist; mapping 200 of them
 *  by hand does not. */
export const GEOTIFF_MAX_BANDS = 16;
/** Distinct raw values enumerated for a categorical (tag/bool) band before we
 *  conclude "this is not categorical" and fall back to the plain numeric decode. */
export const GEOTIFF_MAX_DISTINCT = 64;

// ---------------------------------------------------------------------------
// Nearest-neighbour resampling (PURE)
// ---------------------------------------------------------------------------

/** Resample a row-major raster to `dstW × dstH` by NEAREST NEIGHBOUR.
 *
 *  Nearest ONLY, on purpose: a landcover / fuel-model / district raster is
 *  CATEGORICAL, and averaging class codes invents classes that do not exist. It
 *  is the acceptable-if-blunt choice for a continuous band too (a v1 limitation
 *  stated in the dialog and in Help), and it is what `.asc`-era workflows do when
 *  they resample in GDAL with `-r near`.
 *
 *  Centre sampling: destination cell `d` maps to source index
 *  `floor((d + 0.5) · src/dst)`, clamped — so identical dimensions are the
 *  IDENTITY (asserted by the test suite), a 2× downsample takes every other
 *  pixel starting at the first, and an upsample repeats. */
export function resampleNearest(
  src: ArrayLike<number>, srcW: number, srcH: number, dstW: number, dstH: number,
): Float64Array {
  const out = new Float64Array(Math.max(0, dstW * dstH));
  if (dstW < 1 || dstH < 1 || srcW < 1 || srcH < 1) return out;
  // Identity fast path — and it is EXACT, not merely fast: no index arithmetic
  // runs at all, so a same-size import can never be off by a pixel.
  if (srcW === dstW && srcH === dstH) {
    const n = Math.min(out.length, src.length);
    for (let i = 0; i < n; i++) out[i] = src[i] as number;
    return out;
  }
  const sx = new Int32Array(dstW);
  for (let c = 0; c < dstW; c++) {
    sx[c] = Math.min(srcW - 1, Math.max(0, Math.floor(((c + 0.5) * srcW) / dstW)));
  }
  for (let r = 0; r < dstH; r++) {
    const srcRow = Math.min(srcH - 1, Math.max(0, Math.floor(((r + 0.5) * srcH) / dstH))) * srcW;
    const dstRow = r * dstW;
    for (let c = 0; c < dstW; c++) out[dstRow + c] = src[srcRow + sx[c]!] as number;
  }
  return out;
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
  opts?: { noData?: number | null; valueMap?: GeoTiffValueMap },
): GeoTiffBandBuild {
  const raw = resampleNearest(band, srcW, srcH, dstW, dstH);
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
  /** Read ONE band at SOURCE resolution. Cached: the dialog reads a band to build
   *  its value map and again on Apply, and a re-read would re-decompress. */
  readBand(index: number): Promise<Float64Array>;
}

const SAMPLE_FORMAT_LABEL: Record<number, string> = { 1: 'UInt', 2: 'Int', 3: 'Float' };

/** Open a GeoTIFF from raw bytes. Throws a NAMED error when the file is not a
 *  GeoTIFF, or is bigger than a browser tab should attempt. */
export async function openGeoTiff(buffer: ArrayBuffer): Promise<GeoTiffFile> {
  const lib = await loadGeoTiffLib();
  const tiff = await lib.fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  if (!(width > 0) || !(height > 0)) throw new Error('The GeoTIFF declares no raster size.');
  if (width > GEOTIFF_MAX_DIM || height > GEOTIFF_MAX_DIM) {
    throw new Error(`The raster is ${width}×${height}; GenesisCA reads up to ${GEOTIFF_MAX_DIM} on each axis. Crop or resample it in QGIS first.`);
  }
  if (width * height > GEOTIFF_MAX_PIXELS) {
    throw new Error(`The raster holds ${(width * height).toLocaleString()} pixels; GenesisCA reads up to ${GEOTIFF_MAX_PIXELS.toLocaleString()} (a 4096² tile). Crop or resample it in QGIS first.`);
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

  const cache = new Map<number, Float64Array>();
  const readBand = async (index: number): Promise<Float64Array> => {
    const hit = cache.get(index);
    if (hit) return hit;
    const rasters = await image.readRasters({ samples: [index], interleave: false });
    const arr = (Array.isArray(rasters) ? rasters[0] : rasters) as ArrayLike<number> | undefined;
    if (!arr) throw new Error(`Band ${index + 1} could not be read.`);
    // Normalise to Float64 ONCE: every consumer below (the resampler, the value
    // map, the decode) then works on one representation, and an Int32/Uint16
    // band's values survive exactly.
    const out = new Float64Array(width * height);
    const n = Math.min(out.length, arr.length);
    for (let i = 0; i < n; i++) out[i] = arr[i] as number;
    cache.set(index, out);
    return out;
  };

  return { width, height, bandCount, bands, noData, georef, warnings, readBand };
}
