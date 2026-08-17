/**
 * CSV import — the pure parsing / decoding / column-mapping core.
 *
 * Two flavours ride this module (see docs/PLAN_CSV_IMPORT.md):
 *   - AGENTS: each CSV row is one agent; columns carry position / velocity /
 *     radius / agent-attribute values → per-agent `pasteAgents` specs.
 *   - GRID:   the CSV IS the board (a line is a grid ROW, a field a grid COLUMN)
 *     and every value goes into ONE chosen cell attribute → `importGridValues`.
 *
 * DOM-free + side-effect-free on purpose: `scripts/test-csv-import.mjs` imports
 * it directly and asserts VALUES (a scientific-workflow feature — the number in
 * the file must be the number in the store, or be reported as defaulted).
 *
 * No new dependency: the RFC-4180 parser below is ~40 lines.
 */

import type { Attribute } from '../model/types';
import { encodeAttrValue } from '../model/attrValueEncoding';
import { vectorComponentIds, vectorDimsOf } from '../modeler/vpl/compiler/vectorAttr';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The delimiters auto-detection considers, in tie-break order. */
export const CSV_DELIMITERS = [',', ';', '\t'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/** The "no delimiter" mode: every CHARACTER of a line is one cell — the classic
 *  ASCII-art board format published CA patterns are actually written in (Life as
 *  `.`/`O`, Wireworld as `.`/`H`/`t`/`#`, a digit grid for an integer attribute).
 *  NEVER returned by `detectDelimiter` — the user selects it explicitly, and it is
 *  GRID-only (one char per column is meaningless for agent x/y columns). */
export const CSV_NO_DELIMITER = 'none';

/** Split CSV text into rows of raw string fields (RFC 4180).
 *
 *  Handles: quoted fields, `""` escapes inside quotes, delimiters and newlines
 *  inside quotes, CRLF and LF, a leading UTF-8 BOM, and a trailing newline (no
 *  phantom final row). Fields are NOT trimmed inside quotes; unquoted fields are
 *  trimmed of surrounding whitespace (spreadsheets export `a, b` freely). */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;      // inside a quoted field
  let wasQuoted = false;   // this field had quotes → don't trim it
  let i = 0;
  const pushField = () => { row.push(wasQuoted ? field : field.trim()); field = ''; wasQuoted = false; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field.trim() === '') { quoted = true; wasQuoted = true; field = ''; i++; continue; }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; pushRow(); i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  // A trailing newline leaves an empty pending row — only keep a final row when
  // it actually carries content.
  if (field.length > 0 || row.length > 0) pushRow();
  // Drop wholly-blank rows (blank lines between blocks, a trailing CRLF).
  return rows.filter(r => r.length > 1 || (r[0] ?? '') !== '');
}

/** Split text into rows where every CHARACTER is one field (the `none` delimiter).
 *
 *  A SEPARATE path from `parseCsvRows` on purpose — RFC-4180 machinery is exactly
 *  wrong for an ASCII board:
 *    - NO quote handling: a `"` is an ordinary cell, and so is a `,` or a `;`.
 *    - NO whitespace trimming: a leading/interior SPACE is a legitimate cell (the
 *      most common "empty" in ASCII art), so a line of spaces is a row of cells.
 *  Strips a UTF-8 BOM, accepts CRLF or LF, and drops LEADING/TRAILING blank lines
 *  (a trailing newline must not create a phantom row). INTERIOR blank lines are
 *  KEPT as zero-length rows: in a board an empty line most plausibly means a row
 *  of empty cells, and dropping it would shift every later row up — silently
 *  corrupting the geometry. Such a row pads entirely with the attribute default
 *  and the padding is counted, so it is visible either way.
 *  Splits by code POINT (`Array.from`), so an astral char counts as one cell. */
export function parseCharRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  return lines.map(l => Array.from(l));
}

/** Pick the delimiter that yields the most consistent field count over the first
 *  lines (and more than one field). Ties → the earlier entry of CSV_DELIMITERS.
 *  NEVER returns `CSV_NO_DELIMITER` — that mode is an explicit user choice. */
export function detectDelimiter(text: string): CsvDelimiter {
  let best: CsvDelimiter = ',';
  let bestScore = -1;
  for (const d of CSV_DELIMITERS) {
    const rows = parseCsvRows(text, d).slice(0, 20);
    if (rows.length === 0) continue;
    const counts = rows.map(r => r.length);
    const first = counts[0]!;
    if (first < 2) continue;
    const consistent = counts.filter(c => c === first).length;
    // Reward field count AND consistency; consistency dominates.
    const score = consistent * 100 + first;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** True when the raw field parses as a finite number (the header heuristic's
 *  and every numeric decode's primitive). Empty is NOT numeric. */
export function isNumericField(raw: string): boolean {
  const s = raw.trim();
  if (s === '') return false;
  const n = Number(s);
  return Number.isFinite(n);
}

/** Header heuristic: the first row is a header iff it holds NO numeric field AND
 *  at least one LATER row DOES hold a numeric field.
 *
 *  Accepts `x,y,radius` over numeric rows; correctly REJECTS a grid of tag NAMES
 *  (no numeric anywhere → the first row is data like every other row). The
 *  dialog exposes a checkbox that overrides this either way. */
export function detectHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0]!;
  if (first.some(isNumericField)) return false;
  for (let r = 1; r < rows.length; r++) if (rows[r]!.some(isNumericField)) return true;
  return false;
}

export interface CsvTable {
  delimiter: string;
  /** Header field names, or null when the file has no header row. */
  header: string[] | null;
  /** DATA rows only (the header row excluded when present). */
  rows: string[][];
  /** The widest data row's field count. */
  width: number;
  /** How many data rows are shorter than `width` (padded on use). */
  ragged: number;
}

/** Parse text into a table: delimiter + header detection (both overridable).
 *
 *  `delimiter: CSV_NO_DELIMITER` takes the char-per-cell path and forces
 *  header OFF UNCONDITIONALLY — a header row cannot exist when every character is
 *  a cell, so the heuristic must not run there. */
export function parseCsvTable(
  text: string,
  opts?: { delimiter?: string; hasHeader?: boolean },
): CsvTable {
  const delimiter = opts?.delimiter ?? detectDelimiter(text);
  if (delimiter === CSV_NO_DELIMITER) {
    const rows = parseCharRows(text);
    let w = 0;
    for (const r of rows) w = Math.max(w, r.length);
    return { delimiter, header: null, rows, width: w, ragged: rows.filter(r => r.length < w).length };
  }
  const all = parseCsvRows(text, delimiter);
  const hasHeader = opts?.hasHeader ?? detectHeader(all);
  const header = hasHeader ? (all[0] ?? []) : null;
  const rows = hasHeader ? all.slice(1) : all;
  let width = 0;
  for (const r of rows) width = Math.max(width, r.length);
  if (header) width = Math.max(width, header.length);
  const ragged = rows.filter(r => r.length < width).length;
  return { delimiter, header, rows, width, ragged };
}

// ---------------------------------------------------------------------------
// Esri ASCII grid (`.asc`) — the GIS raster interchange format
//
// Every GIS on earth exports it, and it is the raster format NetLogo's GIS
// extension and Cell2Fire consume, so supporting it makes GenesisCA directly
// consumable from QGIS/ArcGIS with no new dependency and no projection
// machinery (the universal contract: pre-align upstream — see
// docs/INVESTIGATION_GEOSPATIAL_IO.md).
//
// Shape: up to 6 header lines of `KEY value` (case-insensitive), then the body —
// `ncols * nrows` whitespace-separated values in ROW-MAJOR order.
// ---------------------------------------------------------------------------

/** The NODATA sentinel this app WRITES (and the de-facto industry default). */
export const ASC_NODATA_DEFAULT = -9999;

export interface AscGrid {
  ncols: number;
  nrows: number;
  /** Lower-left CORNER of the lower-left cell (an `xllcenter` header is converted). */
  xllcorner: number;
  yllcorner: number;
  cellSize: number;
  /** Absent `NODATA_value` line ⇒ null (no cell is "no data"). */
  nodataValue: number | null;
  /** True when the header used `xllcenter`/`yllcenter` (already converted above). */
  centerOrigin: boolean;
  /** How many body VALUES were found (before chunking into rows). */
  tokenCount: number;
  /** The body as a `CsvTable`, chunked `ncols` wide — so every existing consumer
   *  (`buildGridValues`, the preview) works unchanged. */
  table: CsvTable;
}

const ASC_HEADER_KEYS = new Set([
  'ncols', 'nrows', 'xllcorner', 'yllcorner', 'xllcenter', 'yllcenter', 'cellsize', 'nodata_value',
]);

/** Cheap detector for routing (the dialog decides its whole shape from this):
 *  the first non-empty line's first token is `ncols`. */
export function isAscGridText(text: string): boolean {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    return (line.split(/\s+/)[0] ?? '').toLowerCase() === 'ncols';
  }
  return false;
}

/** Parse an Esri ASCII grid. Returns null when the text is not one.
 *
 *  The body is read as the spec defines it — a flat stream of `ncols * nrows`
 *  whitespace-separated values in ROW-MAJOR order, chunked into rows of `ncols`
 *  — NOT line-by-line. Every real writer emits exactly one line per row, so the
 *  two readings coincide; the flat read additionally survives a wrapped body.
 *  A short stream leaves the trailing cells missing (padded with the attribute
 *  default and COUNTED by `buildGridValues`, like every other miss); a long one
 *  keeps only the declared `nrows` rows.
 *
 *  Whitespace-tokenised on purpose: `.asc` bodies are commonly space-ALIGNED
 *  (runs of spaces), which the RFC-4180 machinery would read as empty fields. */
export function parseAscGrid(text: string): AscGrid | null {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split('\n');
  const hdr: Record<string, number> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') { if (Object.keys(hdr).length === 0) continue; break; }
    const parts = line.split(/\s+/);
    const key = (parts[0] ?? '').toLowerCase();
    if (!ASC_HEADER_KEYS.has(key)) break;
    const n = Number(parts[1]);
    if (!Number.isFinite(n)) break;
    hdr[key] = n;
  }
  const ncols = Math.round(hdr.ncols ?? 0);
  const nrows = Math.round(hdr.nrows ?? 0);
  if (!(ncols > 0) || !(nrows > 0)) return null;
  const cellSize = Number.isFinite(hdr.cellsize) && hdr.cellsize! > 0 ? hdr.cellsize! : 1;
  const centerOrigin = hdr.xllcenter !== undefined || hdr.yllcenter !== undefined;
  const xll = hdr.xllcorner !== undefined ? hdr.xllcorner
    : hdr.xllcenter !== undefined ? hdr.xllcenter - cellSize / 2 : 0;
  const yll = hdr.yllcorner !== undefined ? hdr.yllcorner
    : hdr.yllcenter !== undefined ? hdr.yllcenter - cellSize / 2 : 0;

  const body = lines.slice(i).join('\n').trim();
  const tokens = body === '' ? [] : body.split(/\s+/);
  const rows: string[][] = [];
  for (let r = 0; r < nrows; r++) {
    const start = r * ncols;
    if (start >= tokens.length) break;                 // stream ran out — short rows
    rows.push(tokens.slice(start, start + ncols));
  }
  const ragged = rows.filter(r => r.length < ncols).length;
  return {
    ncols, nrows, xllcorner: xll, yllcorner: yll, cellSize,
    nodataValue: hdr.nodata_value !== undefined ? hdr.nodata_value : null,
    centerOrigin, tokenCount: tokens.length,
    table: { delimiter: ' ', header: null, rows, width: ncols, ragged },
  };
}

/** Serialise a row-major value block as an Esri ASCII grid.
 *
 *  Values are written as plain NUMBERS (never a tag NAME): `.asc` is a numeric
 *  raster, and "integer codes + a separate code→class table" is exactly how the
 *  field encodes categorical layers (Cell2Fire fuel models, NLCD classes). A tag
 *  therefore exports its INDEX and a binary its 0/1 — both of which
 *  `decodeCsvValue` reads straight back, so the ROUND TRIP is exact.
 *
 *  A non-finite value is written as the NODATA sentinel (the honest "no value
 *  here"), which the import turns back into the attribute default. */
export function buildAscGrid(
  values: ArrayLike<number>,
  width: number,
  height: number,
  georef?: { xllcorner: number; yllcorner: number; cellSize: number } | null,
  opts?: { nodataValue?: number; maxRows?: number },
): string {
  const nodata = opts?.nodataValue ?? ASC_NODATA_DEFAULT;
  const x = georef?.xllcorner ?? 0;
  const y = georef?.yllcorner ?? 0;
  const cs = georef && georef.cellSize > 0 ? georef.cellSize : 1;
  const lines = [
    `ncols ${width}`,
    `nrows ${height}`,
    `xllcorner ${x}`,
    `yllcorner ${y}`,
    `cellsize ${cs}`,
    `NODATA_value ${nodata}`,
  ];
  const n = opts?.maxRows === undefined ? height : Math.min(height, opts.maxRows);
  for (let r = 0; r < n; r++) {
    const fields: string[] = new Array(width);
    for (let c = 0; c < width; c++) {
      const v = values[r * width + c];
      fields[c] = v === undefined || !Number.isFinite(v) ? String(nodata) : String(v);
    }
    lines.push(fields.join(' '));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

/** A per-cell decode outcome. `ok:false` ⇒ `value` is the attribute's DEFAULT
 *  (never a guess) and the caller counts + reports the miss. */
export interface CsvDecode { value: number; ok: boolean }

const TRUE_WORDS = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

/** Attribute shape this module needs (a structural subset of `Attribute`). */
export interface CsvAttrShape {
  id: string;
  name?: string;
  type: string;
  defaultValue?: string;
  tagOptions?: string[];
  vectorDims?: number;
}

/** Parse a plain number field (positions, velocities, radius, vector
 *  components). Returns null when it is not a finite number. */
export function parseCsvNumber(raw: string): number | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Decode one raw CSV field into the numeric form the worker stores for `attr`.
 *
 *   integer  → any finite number, ROUNDED
 *   float    → any finite number
 *   bool     → 1/0, true/false, yes/no, t/f, on/off (case-insensitive)
 *   tag      → the option NAME (case-insensitive exact) or a numeric index in range
 *   other    → the attribute default (a colour / lookupTable is not a per-cell scalar)
 *
 *  Anything unparseable yields the attribute's default with `ok:false`. */
export function decodeCsvValue(attr: CsvAttrShape, raw: string): CsvDecode {
  const fallback = encodeAttrValue(attr, undefined);
  const s = (raw ?? '').trim();
  switch (attr.type) {
    case 'integer':
    case 'neighborIndex': {
      const n = parseCsvNumber(s);
      return n === null ? { value: fallback, ok: false } : { value: Math.round(n), ok: true };
    }
    case 'float': {
      const n = parseCsvNumber(s);
      return n === null ? { value: fallback, ok: false } : { value: n, ok: true };
    }
    case 'bool': {
      const l = s.toLowerCase();
      if (TRUE_WORDS.has(l)) return { value: 1, ok: true };
      if (FALSE_WORDS.has(l)) return { value: 0, ok: true };
      return { value: fallback, ok: false };
    }
    case 'tag': {
      const opts = attr.tagOptions ?? [];
      const l = s.toLowerCase();
      const byName = opts.findIndex(o => o.toLowerCase() === l);
      if (byName >= 0) return { value: byName, ok: true };
      // A field is TRIMMED above (spreadsheets pad freely), so an option whose
      // own name carries leading/trailing whitespace could never be matched by
      // name — even from a file this app itself wrote. Fall back to comparing
      // the TRIMMED option name; strictly additive (the exact match above still
      // wins), and it closes the export→import round trip for such an option.
      const byTrimmed = opts.findIndex(o => o.trim().toLowerCase() === l);
      if (byTrimmed >= 0) return { value: byTrimmed, ok: true };
      const n = parseCsvNumber(s);
      if (n !== null && Number.isInteger(n) && n >= 0 && n < opts.length) return { value: n, ok: true };
      return { value: fallback, ok: false };
    }
    default:
      return { value: fallback, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Character → value mapping (the `none` delimiter's core)
// ---------------------------------------------------------------------------

/** A character found in a char-per-cell file, with how often it occurs. */
export interface CsvCharInfo { char: string; count: number }

/** char → the value it stands for, in the CANONICAL `Attribute.defaultValue`
 *  string encoding (a tag is its INDEX string, a bool is `'true'`/`'false'`,
 *  numbers are decimal) so it feeds `encodeAttrValue` and the existing inline
 *  widgets unchanged. An ABSENT key or `''` means UNMAPPED → the attribute
 *  default (counted + reported, never silent).
 *
 *  This map is what makes "the value has to fit in a single char" a non-issue:
 *  ANY character can stand for ANY value, so `a → 10` works for an integer
 *  attribute. Digits are merely the auto-seed. */
export type CsvCharMap = Record<string, string>;

/** The distinct characters of a char-per-cell table with their counts, most
 *  frequent first (the board's "background" char leads), ties by code point.
 *  SPACE is included — it is a real cell the user may want to map. */
export function distinctChars(table: CsvTable): CsvCharInfo[] {
  const counts = new Map<string, number>();
  for (const row of table.rows) for (const ch of row) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return [...counts.entries()]
    .map(([char, count]) => ({ char, count }))
    .sort((a, b) => (b.count - a.count) || (a.char < b.char ? -1 : a.char > b.char ? 1 : 0));
}

/** Printable label for a character in the mapping table (space / tab are cells
 *  too, and an invisible row in the UI would be unusable). */
export function charLabel(ch: string): string {
  if (ch === ' ') return '␣ (space)';
  if (ch === '\t') return '⇥ (tab)';
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20) return `\\x${cp.toString(16).padStart(2, '0')}`;
  return ch;
}

const BOOL_TRUE_CHARS = ['1', '#', 'O', 'o', 'X', 'x', '*'];
const BOOL_FALSE_CHARS = ['0', '.', '-', 'b'];

/** Conservative auto-seed for the char map — every seed is visible and editable
 *  in the dialog's table, and anything not seeded stays UNMAPPED (→ default).
 *
 *  integer / float / neighborIndex: a DIGIT stands for its own numeric value.
 *  tag: a DIGIT stands for that tag INDEX when in range; otherwise a char that
 *    case-insensitively matches the FIRST LETTER of EXACTLY ONE tag option stands
 *    for that option (Wireworld `H`→Head, `t`→tail) — only when unambiguous, so
 *    two options sharing an initial seed neither.
 *  bool: the universal CA-ASCII conventions — `1 # O o X x *` → true,
 *    `0 . - b` → false (Life plaintext `.O`, RLE `bo`).
 *  SPACE is deliberately never seeded (the coordinator's rule: space → default). */
export function autoSeedCharMap(chars: Array<CsvCharInfo | string>, attr: CsvAttrShape): CsvCharMap {
  const list = chars.map(c => (typeof c === 'string' ? c : c.char));
  const map: CsvCharMap = {};
  const tagOpts = attr.tagOptions ?? [];
  // For a tag attribute: which initials are UNAMBIGUOUS?
  const initialToIdx = new Map<string, number | null>();
  if (attr.type === 'tag') {
    for (let i = 0; i < tagOpts.length; i++) {
      const k = (tagOpts[i] ?? '').charAt(0).toLowerCase();
      if (k === '') continue;
      initialToIdx.set(k, initialToIdx.has(k) ? null : i);  // null = ambiguous
    }
  }
  for (const ch of list) {
    if (ch === ' ') continue;
    const isDigit = ch >= '0' && ch <= '9';
    if (attr.type === 'tag') {
      if (isDigit) {
        const n = Number(ch);
        if (n < tagOpts.length) { map[ch] = String(n); continue; }
      }
      const idx = initialToIdx.get(ch.toLowerCase());
      if (idx !== undefined && idx !== null) map[ch] = String(idx);
      continue;
    }
    if (attr.type === 'bool') {
      if (BOOL_TRUE_CHARS.includes(ch)) map[ch] = 'true';
      else if (BOOL_FALSE_CHARS.includes(ch)) map[ch] = 'false';
      continue;
    }
    // integer / float / neighborIndex
    if (isDigit) map[ch] = ch;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Column targets (agents)
// ---------------------------------------------------------------------------

export type CsvGeomField = 'x' | 'y' | 'z' | 'vx' | 'vy' | 'vz' | 'radius';

export type CsvTarget =
  | { kind: 'ignore' }
  | { kind: 'geom'; field: CsvGeomField }
  | { kind: 'attr'; attrId: string }
  | { kind: 'vec'; attrId: string; comp: number };

/** Serialise a target into the `<option value>` key (and back) — one string per
 *  target so the column selects stay plain DOM. */
export function targetKey(t: CsvTarget): string {
  switch (t.kind) {
    case 'ignore': return 'ignore';
    case 'geom': return `geom:${t.field}`;
    case 'attr': return `attr:${t.attrId}`;
    case 'vec': return `vec:${t.attrId}:${t.comp}`;
  }
}

export function parseTargetKey(key: string): CsvTarget {
  if (key.startsWith('geom:')) return { kind: 'geom', field: key.slice(5) as CsvGeomField };
  if (key.startsWith('attr:')) return { kind: 'attr', attrId: key.slice(5) };
  if (key.startsWith('vec:')) {
    const rest = key.slice(4);
    const i = rest.lastIndexOf(':');
    return { kind: 'vec', attrId: rest.slice(0, i), comp: Number(rest.slice(i + 1)) || 0 };
  }
  return { kind: 'ignore' };
}

/** Lower-case + strip everything that is not a letter or digit — so `Vel X`,
 *  `vel_x`, `vel.x` and `velX` all normalise to `velx`. */
export function normaliseName(s: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const GEOM_ALIASES: Record<string, CsvGeomField> = {
  x: 'x', posx: 'x', positionx: 'x', px: 'x',
  y: 'y', posy: 'y', positiony: 'y', py: 'y',
  z: 'z', posz: 'z', positionz: 'z', pz: 'z', layer: 'z',
  vx: 'vx', velx: 'vx', velocityx: 'vx',
  vy: 'vy', vely: 'vy', velocityy: 'vy',
  vz: 'vz', velz: 'vz', velocityz: 'vz',
  radius: 'radius', r: 'radius', size: 'radius',
};

const COMP_LETTERS = ['x', 'y', 'z'];

/** Every target the Agents mode can offer, in menu order. */
export function agentTargetOptions(attrs: CsvAttrShape[], is3d: boolean): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [{ key: 'ignore', label: '(ignore)' }];
  const geom: CsvGeomField[] = is3d
    ? ['x', 'y', 'z', 'vx', 'vy', 'vz', 'radius']
    : ['x', 'y', 'vx', 'vy', 'radius'];
  for (const f of geom) out.push({ key: `geom:${f}`, label: f });
  for (const a of attrs) {
    if (a.type === 'vector') {
      const dims = vectorDimsOf(a);
      for (let c = 0; c < dims; c++) out.push({ key: `vec:${a.id}:${c}`, label: `${a.name ?? a.id}.${COMP_LETTERS[c]}` });
    } else if (a.type !== 'color' && a.type !== 'lookupTable') {
      out.push({ key: `attr:${a.id}`, label: a.name ?? a.id });
    }
  }
  return out;
}

/** Auto-map columns to targets.
 *
 *  With a header: geometry aliases first (x/y/z/vx/vy/vz/radius and the obvious
 *  spellings), then an exact normalised agent-attribute NAME match, then
 *  `<vectorName><x|y|z>` for vector components. Unmatched → ignore.
 *  Without a header: everything ignored except the first two columns → x, y.
 *  Every result is user-overridable in the dialog. */
export function autoMapAgentColumns(
  header: string[] | null,
  attrs: CsvAttrShape[],
  is3d: boolean,
  width: number,
): string[] {
  if (!header) {
    return Array.from({ length: width }, (_, i) => (i === 0 ? 'geom:x' : i === 1 ? 'geom:y' : 'ignore'));
  }
  const used = new Set<string>();
  const take = (key: string): string => { if (used.has(key)) return 'ignore'; used.add(key); return key; };
  return Array.from({ length: width }, (_, i) => {
    const n = normaliseName(header[i] ?? '');
    if (n === '') return 'ignore';
    const g = GEOM_ALIASES[n];
    if (g && (is3d || (g !== 'z' && g !== 'vz'))) return take(`geom:${g}`);
    const exact = attrs.find(a => a.type !== 'vector' && a.type !== 'color' && a.type !== 'lookupTable' && normaliseName(a.name ?? a.id) === n);
    if (exact) return take(`attr:${exact.id}`);
    for (const a of attrs) {
      if (a.type !== 'vector') continue;
      const dims = vectorDimsOf(a);
      const base = normaliseName(a.name ?? a.id);
      for (let c = 0; c < dims; c++) {
        if (n === base + COMP_LETTERS[c]) return take(`vec:${a.id}:${c}`);
      }
    }
    return 'ignore';
  });
}

// ---------------------------------------------------------------------------
// Agent spec building
// ---------------------------------------------------------------------------

export interface CsvIssue { row: number; column: string; raw: string; reason: string }

export interface CsvAgentSpec {
  x: number; y: number; z?: number;
  radius?: number; vx?: number; vy?: number; vz?: number;
  sets: Array<{ attrId: string; value: number }>;
}

export interface CsvAgentBuild {
  agents: CsvAgentSpec[];
  /** Rows dropped because x or y was missing/unparseable. */
  skippedRows: number;
  /** Individual fields that fell back to the attribute default. */
  badValues: number;
  /** Rows whose position lay outside the world (the worker wraps or clamps). */
  outOfBounds: number;
  issues: CsvIssue[];
}

const MAX_ISSUES = 12;

/** Build the per-agent `pasteAgents` specs from a parsed table + column targets.
 *
 *  A row with no parseable x AND y is SKIPPED (an agent without a position is
 *  meaningless); every other miss falls back to the attribute default and is
 *  counted. `world` only drives the out-of-bounds COUNT — the worker owns the
 *  actual wrap/clamp inside `pasteAgents`. */
export function buildAgentSpecs(
  table: CsvTable,
  targetKeys: string[],
  attrs: CsvAttrShape[],
  world: { w: number; h: number; d: number },
  is3d: boolean,
): CsvAgentBuild {
  const attrById = new Map(attrs.map(a => [a.id, a]));
  const targets = targetKeys.map(parseTargetKey);
  const colName = (i: number) => table.header?.[i] ?? `column ${i + 1}`;
  const out: CsvAgentBuild = { agents: [], skippedRows: 0, badValues: 0, outOfBounds: 0, issues: [] };
  const note = (row: number, col: number, raw: string, reason: string) => {
    out.badValues++;
    if (out.issues.length < MAX_ISSUES) out.issues.push({ row, column: colName(col), raw, reason });
  };

  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    let x: number | null = null, y: number | null = null, z: number | null = null;
    let radius: number | null = null, vx: number | null = null, vy: number | null = null, vz: number | null = null;
    const sets: Array<{ attrId: string; value: number }> = [];
    for (let c = 0; c < targets.length; c++) {
      const t = targets[c]!;
      if (t.kind === 'ignore') continue;
      const raw = row[c] ?? '';
      if (t.kind === 'geom') {
        const n = parseCsvNumber(raw);
        if (n === null) {
          if (t.field !== 'x' && t.field !== 'y') note(r + 1, c, raw, 'not a number');
          continue;
        }
        switch (t.field) {
          case 'x': x = n; break; case 'y': y = n; break; case 'z': z = n; break;
          case 'vx': vx = n; break; case 'vy': vy = n; break; case 'vz': vz = n; break;
          case 'radius': radius = n; break;
        }
      } else if (t.kind === 'vec') {
        const attr = attrById.get(t.attrId);
        if (!attr) continue;
        const ids = vectorComponentIds(attr.id, vectorDimsOf(attr));
        const id = ids[t.comp];
        if (!id) continue;
        const n = parseCsvNumber(raw);
        if (n === null) { note(r + 1, c, raw, 'not a number'); sets.push({ attrId: id, value: 0 }); continue; }
        sets.push({ attrId: id, value: n });
      } else {
        const attr = attrById.get(t.attrId);
        if (!attr) continue;
        const d = decodeCsvValue(attr, raw);
        if (!d.ok) note(r + 1, c, raw, `not a valid ${attr.type} value`);
        sets.push({ attrId: attr.id, value: d.value });
      }
    }
    if (x === null || y === null) { out.skippedRows++; continue; }
    const spec: CsvAgentSpec = { x, y, sets };
    if (is3d) spec.z = z ?? 0;
    if (radius !== null) spec.radius = radius;
    if (vx !== null) spec.vx = vx;
    if (vy !== null) spec.vy = vy;
    if (is3d && vz !== null) spec.vz = vz;
    const oob = x < 0 || x >= world.w || y < 0 || y >= world.h || (is3d && ((spec.z ?? 0) < 0 || (spec.z ?? 0) >= world.d));
    if (oob) out.outOfBounds++;
    out.agents.push(spec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grid value building
// ---------------------------------------------------------------------------

export interface CsvGridBuild {
  /** Row-major, length width*height. */
  values: Float64Array;
  width: number;
  height: number;
  badValues: number;
  /** Cells that had no field at all (ragged rows padded with the default). */
  paddedCells: number;
  /** `.asc` only: cells whose raw value equalled the file's `NODATA_value`. They
   *  take the attribute default like any other miss, but are counted SEPARATELY
   *  — "outside the study area" is a legitimate statement, not a parse failure. */
  nodataCells?: number;
  issues: CsvIssue[];
  /** `none` mode only: the distinct characters that carried NO mapping (their
   *  cells took the attribute default). Reported per CHARACTER, not per cell — a
   *  100×100 board with one unmapped background char would otherwise flood the
   *  per-cell issue list with identical entries. */
  unmappedChars?: string[];
}

/** Build the flat row-major value block for `importGridValues`.
 *
 *  CONVENTION: a CSV LINE is a grid ROW (height) and a FIELD is a grid COLUMN
 *  (width) — a 12-line × 9-field file gives a 9 wide × 12 tall grid. Ragged rows
 *  are padded with the attribute default and counted.
 *
 *  `charMap` (the `none` delimiter) replaces the per-type field decode with a
 *  char → value lookup: a mapped char yields its value, an UNMAPPED char (absent
 *  key or `''`, and SPACE by default) yields the attribute default and is counted.
 *  Without it the DELIMITED path below is untouched.
 *
 *  `nodataValue` (the `.asc` header's `NODATA_value`) is compared against the raw
 *  field NUMERICALLY, BEFORE the per-type decode: a match takes the attribute
 *  default and is counted in `nodataCells` rather than as an unparseable value.
 *  `null`/`undefined` ⇒ the historical path, unchanged. */
export function buildGridValues(
  table: CsvTable,
  attr: CsvAttrShape,
  charMap?: CsvCharMap,
  nodataValue?: number | null,
): CsvGridBuild {
  const height = table.rows.length;
  const width = table.width;
  const values = new Float64Array(Math.max(0, width * height));
  const fallback = encodeAttrValue(attr, undefined);
  if (charMap) {
    const out: CsvGridBuild = { values, width, height, badValues: 0, paddedCells: 0, issues: [], unmappedChars: [] };
    const seen = new Set<string>();
    // Pre-encode each mapping ONCE (a board is large; the map is tiny).
    const enc = new Map<string, number>();
    for (const [ch, raw] of Object.entries(charMap)) {
      if (raw === undefined || raw === '') continue;
      enc.set(ch, encodeAttrValue(attr, raw));
    }
    for (let r = 0; r < height; r++) {
      const row = table.rows[r]!;
      for (let c = 0; c < width; c++) {
        const o = r * width + c;
        if (c >= row.length) { values[o] = fallback; out.paddedCells++; continue; }
        const ch = row[c]!;
        const v = enc.get(ch);
        if (v === undefined) {
          values[o] = fallback;
          out.badValues++;
          if (!seen.has(ch)) {
            seen.add(ch);
            out.unmappedChars!.push(ch);
            if (out.issues.length < MAX_ISSUES) {
              out.issues.push({ row: r + 1, column: `column ${c + 1}`, raw: charLabel(ch), reason: 'unmapped character → default' });
            }
          }
          continue;
        }
        values[o] = v;
      }
    }
    return out;
  }
  const hasNodata = nodataValue !== undefined && nodataValue !== null && Number.isFinite(nodataValue);
  const out: CsvGridBuild = { values, width, height, badValues: 0, paddedCells: 0, issues: [] };
  if (hasNodata) out.nodataCells = 0;
  for (let r = 0; r < height; r++) {
    const row = table.rows[r]!;
    for (let c = 0; c < width; c++) {
      const o = r * width + c;
      if (c >= row.length) { values[o] = fallback; out.paddedCells++; continue; }
      if (hasNodata) {
        const n = parseCsvNumber(row[c]!);
        if (n !== null && n === nodataValue) { values[o] = fallback; out.nodataCells!++; continue; }
      }
      const d = decodeCsvValue(attr, row[c]!);
      values[o] = d.value;
      if (!d.ok) {
        out.badValues++;
        if (out.issues.length < MAX_ISSUES) out.issues.push({ row: r + 1, column: `column ${c + 1}`, raw: row[c]!, reason: `not a valid ${attr.type} value` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resampling a parsed grid onto the model's own grid (the `.asc` "resample"
// fit). Same kernels the GeoTIFF importer uses, so a `.asc` and a GeoTIFF over
// the same ground pick the same cells.
// ---------------------------------------------------------------------------

/** Nearest-resample a parsed TABLE, cell text and all.
 *
 *  Resampling the STRINGS rather than numbers is deliberate: nearest picks ONE
 *  whole source cell, so every downstream behaviour `buildGridValues` already
 *  has — a tag matched by NAME, the `none`-mode char map, the per-cell issue
 *  reporting, ragged-row padding — keeps working unchanged. Turning the board
 *  into numbers first would silently drop tag-by-name support.
 *
 *  Indexing is `resampleNearest`'s, so the two agree cell for cell. */
export function resampleCsvTable(table: CsvTable, dstW: number, dstH: number): CsvTable {
  const srcW = table.width, srcH = table.rows.length;
  if (dstW < 1 || dstH < 1 || srcW < 1 || srcH < 1) {
    return { ...table, rows: [], width: Math.max(0, dstW), ragged: 0 };
  }
  if (srcW === dstW && srcH === dstH) return table;
  const sx = new Int32Array(dstW);
  for (let c = 0; c < dstW; c++) sx[c] = Math.min(srcW - 1, Math.max(0, Math.floor(((c + 0.5) * srcW) / dstW)));
  const rows: string[][] = [];
  let ragged = 0;
  for (let r = 0; r < dstH; r++) {
    const src = table.rows[Math.min(srcH - 1, Math.max(0, Math.floor(((r + 0.5) * srcH) / dstH)))]!;
    const row: string[] = new Array(dstW);
    let short = false;
    for (let c = 0; c < dstW; c++) {
      const v = src[sx[c]!];
      // A ragged SOURCE row keeps being ragged after the resample — the padding
      // (and its count) stays `buildGridValues`' job, exactly as before.
      if (v === undefined) { short = true; row.length = c; break; }
      row[c] = v;
    }
    if (short) ragged++;
    rows.push(row);
  }
  return { ...table, rows, width: dstW, ragged };
}

/** Read a parsed table as raw NUMBERS, row-major, padded/unparseable → NaN.
 *
 *  Only the AVERAGE path needs this — a mean is undefined over text — and it is
 *  offered only for numeric targets, where an `.asc` body is numeric by
 *  definition. NaN survives to the decode, which reports it as a miss. */
export function csvTableToNumbers(table: CsvTable): { data: Float64Array; width: number; height: number } {
  const width = table.width, height = table.rows.length;
  const data = new Float64Array(Math.max(0, width * height));
  for (let r = 0; r < height; r++) {
    const row = table.rows[r]!;
    for (let c = 0; c < width; c++) {
      const raw = row[c];
      const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
      data[r * width + c] = Number.isFinite(n) ? n : NaN;
    }
  }
  return { data, width, height };
}

// ---------------------------------------------------------------------------
// EXPORT — the mirror of everything above.
//
// The acceptance criterion is the ROUND TRIP: whatever these emit must come
// back through `parseCsvTable` + `autoMapAgentColumns` + `buildAgentSpecs` (or
// `buildGridValues`) as the same values, with NO manual column fixing. That is
// why the headers are spelled exactly as the auto-map's aliases / attribute
// names, and why numbers go through `String(v)` — JS Number→String is the
// shortest representation that round-trips an f64 EXACTLY, so a position never
// loses a bit on the way out and back.
// ---------------------------------------------------------------------------

/** Quote a field per RFC 4180 when it would otherwise not survive the parser.
 *
 *  Needed when the field carries the delimiter, a quote, or a newline — and ALSO
 *  when it has leading/trailing whitespace, because `parseCsvRows` TRIMS an
 *  unquoted field (so `" a "` unquoted would come back as `a`). Attribute and
 *  tag names are user text and can contain any of these. */
export function csvEscape(field: string, delimiter = ','): string {
  const s = field ?? '';
  const needs =
    s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') ||
    s !== s.trim();
  return needs ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Join one row of already-raw fields, escaping each. */
export function csvRow(fields: string[], delimiter = ','): string {
  return fields.map(f => csvEscape(f, delimiter)).join(delimiter);
}

/** Serialise ONE stored number back into the text form `decodeCsvValue` reads.
 *
 *   bool → `true` / `false`      (a TRUE_WORDS / FALSE_WORDS member)
 *   tag  → the option NAME       (decoded case-insensitively on the way back);
 *          an out-of-range index falls back to the raw number so nothing is lost
 *   else → `String(v)`           (exact f64 round-trip)
 *
 *  A non-finite value (a NaN radius on a broken agent) emits an EMPTY field —
 *  `"NaN"` would re-import as the attribute default anyway, and a blank says
 *  "no value here" honestly. */
export function formatCsvValue(attr: CsvAttrShape, v: number): string {
  if (!Number.isFinite(v)) return '';
  switch (attr.type) {
    case 'bool': return v ? 'true' : 'false';
    case 'tag': {
      const opts = attr.tagOptions ?? [];
      const i = Math.round(v);
      return i >= 0 && i < opts.length ? opts[i]! : String(v);
    }
    default: return String(v);
  }
}

/** Format a bare geometry number (position / velocity / radius / a vector
 *  component) — always the exact-round-trip decimal, blank when non-finite. */
export function formatCsvNumber(v: number): string {
  return Number.isFinite(v) ? String(v) : '';
}

/** One exported agent column: its HEADER (spelled so the import auto-maps it
 *  back with no user action) and where its value comes from. */
export interface CsvAgentExportColumn {
  header: string;
  /** Set for the built-in geometry columns. */
  geom?: CsvGeomField;
  /** Set for an attribute column — the key into the agent's `attrs` record
   *  (a VECTOR attribute's component id, exactly what `buildAgentSpecs` writes). */
  storeId?: string;
  /** How to format the value (a vector component formats as a plain float). */
  attr?: CsvAttrShape;
}

/** The columns an agent export writes, in order: position, velocity, radius,
 *  then every agent attribute (a `vector` attribute once PER COMPONENT).
 *
 *  The headers are the auto-map's own vocabulary — `x`/`y`/`z`/`vx`/`vy`/`vz`/
 *  `radius` are `GEOM_ALIASES` keys, an attribute uses its NAME (matched by
 *  `normaliseName`), and a vector component uses `<Name>.<x|y|z>` (which
 *  normalises to `<name><comp>`, the exact form the auto-map looks for).
 *
 *  ⚠ An agent attribute NAMED like a geometry field (an attribute called
 *  "radius") is claimed by the geometry alias on re-import — a pre-existing
 *  ambiguity of the auto-map, not introduced here; the column is still written
 *  and the user can re-target it in the dialog. */
export function agentExportColumns(attrs: CsvAttrShape[], is3d: boolean): CsvAgentExportColumn[] {
  const out: CsvAgentExportColumn[] = [];
  const geom: CsvGeomField[] = is3d
    ? ['x', 'y', 'z', 'vx', 'vy', 'vz', 'radius']
    : ['x', 'y', 'vx', 'vy', 'radius'];
  for (const f of geom) out.push({ header: f, geom: f });
  for (const a of attrs) {
    if (a.type === 'vector') {
      const dims = vectorDimsOf(a);
      const ids = vectorComponentIds(a.id, dims);
      for (let c = 0; c < dims; c++) {
        out.push({
          header: `${a.name ?? a.id}.${COMP_LETTERS[c]}`,
          storeId: ids[c]!,
          attr: { id: ids[c]!, name: a.name, type: 'float' },
        });
      }
    } else if (a.type !== 'color' && a.type !== 'lookupTable') {
      out.push({ header: a.name ?? a.id, storeId: a.id, attr: a });
    }
  }
  return out;
}

/** One live agent, in exactly the shape the worker's `readAgents` / `getState`
 *  reply carries (so the caller maps nothing). `attrs` is keyed by STORE id. */
export interface CsvAgentRow {
  x: number; y: number; z?: number;
  vx: number; vy: number; vz?: number;
  radius: number;
  attrs: Record<string, number>;
}

/** Build the agents CSV: a header row, then one row per live agent. */
export function buildAgentCsv(
  rows: CsvAgentRow[],
  attrs: CsvAttrShape[],
  is3d: boolean,
  opts?: { delimiter?: string; maxRows?: number },
): string {
  const delimiter = opts?.delimiter ?? ',';
  const cols = agentExportColumns(attrs, is3d);
  const lines = [csvRow(cols.map(c => c.header), delimiter)];
  const n = opts?.maxRows === undefined ? rows.length : Math.min(rows.length, opts.maxRows);
  for (let r = 0; r < n; r++) {
    const a = rows[r]!;
    lines.push(csvRow(cols.map(c => {
      if (c.geom) {
        switch (c.geom) {
          case 'x': return formatCsvNumber(a.x);
          case 'y': return formatCsvNumber(a.y);
          case 'z': return formatCsvNumber(a.z ?? 0);
          case 'vx': return formatCsvNumber(a.vx);
          case 'vy': return formatCsvNumber(a.vy);
          case 'vz': return formatCsvNumber(a.vz ?? 0);
          case 'radius': return formatCsvNumber(a.radius);
        }
      }
      const v = a.attrs[c.storeId!];
      return v === undefined ? '' : formatCsvValue(c.attr!, v);
    }), delimiter));
  }
  return lines.join('\n');
}

/** Build the grid CSV from a row-major value block — the exact inverse of
 *  `buildGridValues`: a LINE is a grid ROW, a FIELD is a grid COLUMN, and NO
 *  header row (the Grid import defaults to no-header, so a header would be read
 *  back as a row of cells). */
export function buildGridCsv(
  values: ArrayLike<number>,
  width: number,
  height: number,
  attr: CsvAttrShape,
  opts?: { delimiter?: string; maxRows?: number },
): string {
  const delimiter = opts?.delimiter ?? ',';
  const n = opts?.maxRows === undefined ? height : Math.min(height, opts.maxRows);
  const lines: string[] = [];
  for (let r = 0; r < n; r++) {
    const fields: string[] = new Array(width);
    for (let c = 0; c < width; c++) fields[c] = formatCsvValue(attr, values[r * width + c] ?? 0);
    lines.push(csvRow(fields, delimiter));
  }
  return lines.join('\n');
}

/** The cell attributes a Grid import can target (per-cell scalars only; a
 *  `vector` attribute contributes one entry PER COMPONENT, keyed by its real
 *  component id so the value lands in the buffer the worker owns). */
export function gridTargetOptions(cellAttrs: Attribute[]): Array<{ id: string; label: string; attr: CsvAttrShape }> {
  const out: Array<{ id: string; label: string; attr: CsvAttrShape }> = [];
  for (const a of cellAttrs) {
    if (a.isModelAttribute) continue;
    if (a.type === 'vector') {
      const dims = vectorDimsOf(a);
      const ids = vectorComponentIds(a.id, dims);
      for (let c = 0; c < dims; c++) {
        out.push({ id: ids[c]!, label: `${a.name}.${COMP_LETTERS[c]}`, attr: { id: ids[c]!, name: a.name, type: 'float' } });
      }
    } else if (a.type !== 'color' && a.type !== 'lookupTable') {
      out.push({ id: a.id, label: a.name, attr: a as unknown as CsvAttrShape });
    }
  }
  return out;
}
