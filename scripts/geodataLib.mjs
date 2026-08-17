/**
 * Shared helpers for the REAL-DATA library models (`gen-wildfire-sierra.mjs`,
 * `gen-urban-recife.mjs`).
 *
 * Everything here is NODE-ONLY and never bundled into the app: the generators
 * fetch open geographic data over the network, resample it onto a model grid,
 * render a backdrop PNG, and hand back the base64 typed arrays a `.gcaproj`'s
 * embedded `simulationState` / preset needs.
 *
 * THREE rules this module exists to enforce:
 *
 *  1. FETCH ONCE. Every network read is written to `scripts/geodata-cache/`
 *     (gitignored) keyed by exactly the parameters that produced it, so a
 *     re-run of a generator is OFFLINE-STABLE and byte-deterministic. Delete
 *     the cache to re-fetch.
 *
 *  2. WINDOWS, NOT TILES. The Copernicus DEM and ESA WorldCover rasters are
 *     Cloud-Optimized GeoTIFFs served with HTTP range support, so `geotiff`'s
 *     `fromUrl` reads ONLY the tiles covering the requested window — a few
 *     hundred KB out of a 38 MB / 114 MB file.
 *
 *  3. THE ROW FLIP IS THE WHOLE POINT. A GeoTIFF states its TOP-LEFT corner
 *     with Y growing DOWN the image; GenesisCA's `GeoReference` (and Esri
 *     `.asc`) state the LOWER-LEFT corner with Y growing UP, while grid row 0
 *     is the NORTHERNMOST row. `windowGeoref()` does that conversion once and
 *     every consumer derives from it.
 *
 * NO NEW DEPENDENCY: `geotiff` is already a runtime dependency of the app, and
 * the PNG writer below is `node:zlib` + ~60 lines of chunk framing.
 */
import { fromUrl } from 'geotiff';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
export const CACHE_DIR = join(__dirname, 'geodata-cache');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Run `produce()` once and remember its JSON result under `key`. The key must
 *  encode every parameter that affects the result — a window's coordinates, a
 *  bbox, a query — so a changed window can never read a stale cache entry. */
export async function cached(key, produce) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${key}.json`);
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { /* refetch */ }
  }
  process.stdout.write(`  fetching ${key} … `);
  const value = await produce();
  writeFileSync(file, JSON.stringify(value), 'utf-8');
  process.stdout.write('done\n');
  return value;
}

// ---------------------------------------------------------------------------
// Typed-array <-> base64 (the exact encoding `arrayBufferToBase64` produces)
// ---------------------------------------------------------------------------

export function toBase64(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
}
export function fromBase64(b64, Ctor) {
  const buf = Buffer.from(b64, 'base64');
  // COPY rather than view: Node pools small Buffers, so `buf.byteOffset` is not
  // guaranteed to be a multiple of BYTES_PER_ELEMENT and a typed-array view
  // would throw "start offset must be a multiple of N".
  const out = new Ctor(buf.byteLength / Ctor.BYTES_PER_ELEMENT);
  Buffer.from(out.buffer, out.byteOffset, out.byteLength).set(buf);
  return out;
}

// ---------------------------------------------------------------------------
// Cloud-Optimized GeoTIFF window reads
// ---------------------------------------------------------------------------

/**
 * Read the pixel window of `url` covering the geographic box
 * `[west, south, east, north]` (degrees, EPSG:4326). Returns the raw samples
 * plus the window's OWN georeference so the caller never has to re-derive it.
 *
 * The window is snapped OUTWARD to whole source pixels; `west`/`north` in the
 * result are the true corner of the returned block, which may differ from the
 * request by up to one source pixel.
 */
export async function readCogWindow({ url, key, west, south, east, north, dtype = 'f32' }) {
  const meta = await cached(key, async () => {
    const tiff = await fromUrl(url);
    const img = await tiff.getImage();
    const bb = img.getBoundingBox();               // [minX, minY, maxX, maxY]
    const W = img.getWidth(), H = img.getHeight();
    const rx = (bb[2] - bb[0]) / W, ry = (bb[3] - bb[1]) / H;
    // Snap OUTWARD to whole source pixels, with an epsilon so a window whose
    // edges land exactly on a pixel boundary (the usual case — both sources are
    // on the 1/3600° graticule) does not gain a spurious extra row/column from
    // floating-point drift. A 201-wide block resampled onto 200 cells would
    // misregister the whole layer by up to half a cell.
    const EPS = 1e-6;
    const x0 = Math.max(0, Math.floor((west - bb[0]) / rx + EPS));
    const x1 = Math.min(W, Math.ceil((east - bb[0]) / rx - EPS));
    const y0 = Math.max(0, Math.floor((bb[3] - north) / ry + EPS));
    const y1 = Math.min(H, Math.ceil((bb[3] - south) / ry - EPS));
    if (x1 <= x0 || y1 <= y0) throw new Error(`window [${west},${south},${east},${north}] falls outside ${url}`);
    const raster = (await img.readRasters({ window: [x0, y0, x1, y1] }))[0];
    const w = x1 - x0, h = y1 - y0;
    const arr = dtype === 'u8' ? Uint8Array.from(raster) : Float32Array.from(raster);
    return {
      w, h, resX: rx, resY: ry,
      west: bb[0] + x0 * rx, north: bb[3] - y0 * ry,
      dtype, b64: toBase64(arr),
    };
  });
  return { ...meta, values: fromBase64(meta.b64, meta.dtype === 'u8' ? Uint8Array : Float32Array) };
}

// ---------------------------------------------------------------------------
// OpenStreetMap (Overpass)
// ---------------------------------------------------------------------------

/** Overpass refuses requests without a User-Agent (HTTP 406). */
const OVERPASS_UA = 'GenesisCA-model-generator/1.0 (+https://github.com/rff255/GenesisCA)';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Run an Overpass QL query, trying the mirrors in order. Cached by `key`. */
export async function overpass(key, query) {
  return cached(key, async () => {
    let lastErr = 'no endpoint tried';
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': OVERPASS_UA },
          body: 'data=' + encodeURIComponent(query),
        });
        if (r.status !== 200) { lastErr = `${ep} -> HTTP ${r.status}`; continue; }
        return await r.json();
      } catch (e) { lastErr = `${ep} -> ${e.message}`; }
    }
    throw new Error(`Overpass failed: ${lastErr}`);
  });
}

/** Overpass `out geom;` ways → GeoJSON LineString features (built by hand — the
 *  API returns lat/lon vertex lists, and GeoJSON wants [lon, lat]). */
export function waysToLineStrings(overpassJson) {
  const out = [];
  for (const el of overpassJson.elements ?? []) {
    const g = el.geometry;
    if (!Array.isArray(g) || g.length < 2) continue;
    out.push({
      highway: el.tags?.highway ?? 'road',
      name: el.tags?.name ?? '',
      coords: g.map(p => [p.lon, p.lat]),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The model window: geography <-> grid
// ---------------------------------------------------------------------------

/**
 * The GenesisCA georeference for a model grid of `nx × ny` cells whose
 * SOUTH-WEST corner is `(west, south)` and whose cells are `cellDeg` degrees
 * square. This is the single source of truth for both the `.gcaproj`'s
 * `properties.georef` and every world<->cell conversion in a generator.
 */
export function windowGeoref(west, south, cellDeg, nx, ny, crs = 'EPSG:4326') {
  return {
    georef: { xllcorner: west, yllcorner: south, cellSize: cellDeg, crs },
    west, south, east: west + nx * cellDeg, north: south + ny * cellDeg,
    nx, ny, cellDeg,
  };
}

/** Metres per degree of latitude / longitude at `lat` (WGS84 spherical
 *  approximation — good to ~0.5 % over a few km, which is all a slope needs). */
export function metresPerDegree(lat) {
  const rad = (lat * Math.PI) / 180;
  return { perLat: 111132.92 - 559.82 * Math.cos(2 * rad), perLon: 111412.84 * Math.cos(rad) - 93.5 * Math.cos(3 * rad) };
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/**
 * Horn's 3×3 slope + a standard hillshade, both from a row-major elevation
 * grid in metres. `mx`/`my` are the cell size in metres along the column and
 * row axes (they differ on a lat/lon graticule).
 *
 * Returns `{ shade: Float64Array (0..1), slopePct: Float64Array }`. The
 * illumination is the cartographic default: azimuth 315° (from the NW),
 * altitude 45°.
 */
export function terrain(elev, w, h, mx, my, { azimuth = 315, altitude = 45, zFactor = 1 } = {}) {
  const shade = new Float64Array(w * h);
  const slopePct = new Float64Array(w * h);
  const az = ((360 - azimuth + 90) * Math.PI) / 180;
  const zen = ((90 - altitude) * Math.PI) / 180;
  const at = (c, r) => elev[Math.min(h - 1, Math.max(0, r)) * w + Math.min(w - 1, Math.max(0, c))];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const a = at(c - 1, r - 1), b = at(c, r - 1), cc = at(c + 1, r - 1);
      const d = at(c - 1, r), f = at(c + 1, r);
      const g = at(c - 1, r + 1), hh = at(c, r + 1), i = at(c + 1, r + 1);
      // Row index grows SOUTHWARD, so dz/dy is negated to point north-up.
      const dzdx = ((cc + 2 * f + i) - (a + 2 * d + g)) / (8 * mx);
      const dzdy = ((g + 2 * hh + i) - (a + 2 * b + cc)) / (8 * my);
      const slope = Math.atan(zFactor * Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      let v = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
      if (!(v > 0)) v = 0;
      shade[r * w + c] = v;
      slopePct[r * w + c] = Math.tan(slope) * 100;
    }
  }
  return { shade, slopePct };
}

/** Multi-source BFS distance (in CELLS, 8-connected → Chebyshev-like) from
 *  every cell where `isSource(i)` is true. Unreached cells get `cap`. */
export function distanceField(w, h, isSource, cap = 255) {
  const dist = new Int32Array(w * h).fill(-1);
  let frontier = [];
  for (let i = 0; i < w * h; i++) if (isSource(i)) { dist[i] = 0; frontier.push(i); }
  let d = 0;
  while (frontier.length > 0 && d < cap) {
    const next = [];
    d++;
    for (const i of frontier) {
      const r = (i / w) | 0, c = i - r * w;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= h || nc < 0 || nc >= w) continue;
          const j = nr * w + nc;
          if (dist[j] !== -1) continue;
          dist[j] = d; next.push(j);
        }
      }
    }
    frontier = next;
  }
  for (let i = 0; i < w * h; i++) if (dist[i] === -1) dist[i] = cap;
  return dist;
}

// ---------------------------------------------------------------------------
// PNG (8-bit RGB, no dependency — node:zlib + chunk framing)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode a row-major RGB byte array (`w*h*3`) as an 8-bit PNG Buffer.
 *  Filter type 0 (None) on every row — CA/hillshade imagery deflates well
 *  enough without per-row filter search, and it keeps this to ~20 lines. */
export function encodePNG(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function pngDataUrl(w, h, rgb) {
  return 'data:image/png;base64,' + encodePNG(w, h, rgb).toString('base64');
}

/** Bilinear upsample of a row-major scalar field. Used to lift a hillshade
 *  computed at the DEM's own resolution up to the finer land-cover grid the
 *  backdrop is drawn on — nearest would make the shading visibly blocky. */
export function upsampleBilinear(src, sw, sh, dw, dh) {
  const out = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Box-average downscale of an RGB byte image (for the thumbnail). */
export function downscaleRGB(rgb, w, h, dw, dh) {
  const out = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * h) / dh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * w) / dw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / dw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * w + sx) * 3;
          r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2]; n++;
        }
      }
      const o = (y * dw + x) * 3;
      out[o] = (r / n) | 0; out[o + 1] = (g / n) | 0; out[o + 2] = (b / n) | 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TypeScript module loading (for the shipped pure rasterisation kernels)
// ---------------------------------------------------------------------------

/** Bundle a `src/**.ts` module with esbuild and import it — the pattern the
 *  verification scripts use. Needed for modules with extension-less relative
 *  imports, which Node's own type-stripping resolver cannot follow. */
export async function loadTsModule(relPath, tag) {
  const { build } = await import('esbuild');
  const entryPath = join(ROOT, 'scripts', `__${tag}_entry.ts`);
  writeFileSync(entryPath, `export * from '../${relPath}';\n`, 'utf-8');
  const dir = mkdtempSync(join(tmpdir(), `gca-${tag}-`));
  const outfile = join(dir, 'bundle.mjs');
  await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error', absWorkingDir: ROOT });
  return import(pathToFileURL(outfile).href);
}

// ---------------------------------------------------------------------------
// Model assembly helpers
// ---------------------------------------------------------------------------

/** A deterministic id generator — same call order ⇒ same ids, so re-running a
 *  generator with an unchanged window produces a stable diff. */
export function idFactory(seed) {
  let n = 0;
  return (prefix) => `${prefix}${seed}${(n++).toString(36).padStart(3, '0')}`;
}

/** Graph builder — the `node()` / `vEdge()` / `fEdge()` trio every gen script
 *  uses, with the ids threaded from `idFactory` so output is deterministic. */
export function graphBuilder(newId) {
  const nodes = [], edges = [];
  const node = (nodeType, config, col, row, label) => {
    const n = {
      id: newId('n'), type: 'caNode',
      position: { x: col * 240, y: row * 92 },
      data: label ? { nodeType, config, label } : { nodeType, config },
    };
    nodes.push(n);
    return n;
  };
  const edge = (s, sp, t, tp, cat) => {
    edges.push({
      id: newId('e'), source: s.id, target: t.id,
      sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}`,
    });
  };
  return {
    nodes, edges, node,
    vEdge: (s, sp, t, tp) => edge(s, sp, t, tp, 'value'),
    fEdge: (s, sp, t, tp) => edge(s, sp, t, tp, 'flow'),
  };
}

/**
 * Build an Expression node's config. `formula` uses the display NAMES; `names`
 * is the ordered list of input port names (max 8). The caller wires the ports
 * `a`,`b`,… in the same order.
 */
export function exprConfig(formula, names) {
  if (names.length > 8) throw new Error(`Expression takes at most 8 inputs, got ${names.length}`);
  const cfg = { expression: formula, visibleCount: names.length };
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  names.forEach((nm, i) => { cfg[`_varName_${ids[i]}`] = nm; });
  return cfg;
}
export const EXPR_PORTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/**
 * The embedded `simulationState` grid block, in exactly the shape
 * `serializeSimState` writes (see src/model/fileOperations.ts).
 *
 * `layers` maps a cell-attribute id to `{ type, data }` where `type` is the
 * ON-DISK typed-array kind from `ATTR_TYPE_MAP` (`'int32'` for integer/tag,
 * `'uint8'` for bool, `'float64'` for float) and `data` is the matching typed
 * array. An attribute NOT listed keeps its default on load (the worker's
 * `loadState` skips a missing entry), so only the DATA layers need shipping.
 */
export function gridStateBlock({ width, height, layers, colors, boundaryTreatment }) {
  const attributes = {};
  for (const [id, { type, data }] of Object.entries(layers)) {
    attributes[id] = { type, data: toBase64(data) };
  }
  return {
    schemaVersion: 2,
    boundaryTreatment,
    gridWidth: width, gridHeight: height, gridDepth: 1,
    width, height, depth: 1,
    attributes,
    colors: toBase64(colors),
  };
}
