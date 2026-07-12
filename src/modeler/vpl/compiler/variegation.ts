/** Variegated Cells — target-independent helpers shared by:
 *    - JS compiler ([compile.ts])
 *    - WASM compiler ([wasm/compile.ts])
 *    - WebGPU compiler ([webgpu/compile.ts])
 *    - Worker runtime ([simulator/engine/sim.worker.ts])
 *
 *  Centralising direction-tag indexing, face-pattern lookup baking, and
 *  interaction-table flattening guarantees byte-level agreement across the
 *  three compile targets. Per the parity contract in the implementation
 *  plan, every consumer imports from this module — never re-derives. */

import type { Attribute, CAModel, LookupAxis, LookupKeySource, Neighborhood } from '../../../model/types';

/** Canonical 8-slot face layout. Index = face slot ID; value = tag name.
 *  Face slot order is clockwise starting from N. The rotation arithmetic
 *  in `GetFacingLabels` uses `+2 * orientation` to step through slots by
 *  90&deg; (orientation 0..3 = 0,90,180,270 CW). */
export const DIRECTION_TAGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type DirectionTag = typeof DIRECTION_TAGS[number];

/** Number of slots in a face pattern (always 8 — corners are addressable
 *  even in edges-only layout, just locked to null). */
export const FACE_SLOT_COUNT = 8;

/** Look up the direction index (0..7) for a face-tag name. Returns -1 when
 *  the tag isn't one of the cardinal / diagonal directions. */
export function directionIndex(tag: string | undefined): number {
  if (!tag) return -1;
  const i = DIRECTION_TAGS.indexOf(tag as DirectionTag);
  return i;
}

/** Given a neighborhood, return an `Int32Array(neighborhood.coords.length)`
 *  mapping coord-slot-index &rarr; direction-index (or -1 if untagged or not
 *  one of the 8 cardinal/diagonal directions).
 *
 *  Baked into the compiled function as a runtime constant so per-cell reads
 *  of `directionMap[i]` are O(1). When a slot's `directionMap[i] === -1`, the
 *  caller treats the face read as `none / none` (out-of-band; no compile
 *  error so partially-tagged neighborhoods still work for direction-aware
 *  slots and pass through for untagged ones). */
export function buildDirectionMap(nbr: Neighborhood | undefined): Int32Array {
  if (!nbr) return new Int32Array(0);
  const out = new Int32Array(nbr.coords.length);
  for (let i = 0; i < nbr.coords.length; i++) {
    const tag = nbr.tags?.[i];
    out[i] = directionIndex(tag);
  }
  return out;
}

/** Shape accepted by `buildFacePatternLookup` — independent of `CAModel` so
 *  both the compilers (which have the full model) and the worker (which
 *  receives only the variegated payload + attr defs) can call into one
 *  helper. */
export interface FacePatternLookupInputs {
  /** Source attribute's tag options (one per species). */
  tagOptions: readonly string[];
  /** `tagOption string -> FacePattern.id`. Empty / missing entries → species
   *  has no pattern (all slots resolve to `none`). */
  facePatternAssignments: Readonly<Record<string, string>>;
  /** All face-label palettes. A pattern resolves its slot labels against the
   *  palette named by its `paletteId`. */
  facePalettes: ReadonlyArray<{ id: string; labels: readonly string[] }>;
  /** All face-pattern definitions (each carries a `paletteId`). */
  facePatterns: ReadonlyArray<{ id: string; paletteId: string; faces: ReadonlyArray<string | null> }>;
}

/** Build the flat species-by-face lookup table. Returns
 *  `Int32Array(tagOptions.length * 8)` where entry `[speciesIdx * 8 + faceIdx]`
 *  is the face-label index in `['none', ...palette.labels]` for THAT species'
 *  palette (the palette of its assigned pattern). `0` = none, `1+` = user
 *  labels within that palette. Different species may use different palettes —
 *  the consuming Lookup Table's row/col key source defines how each index is
 *  interpreted (so the lookup stays one species-keyed array, no per-palette
 *  buffers).
 *
 *  Used by `GetFacingLabels` at runtime: `facePatternLookup[species * 8 + rotatedFaceIdx]`.
 *  Built once on init/recompile; cells rotate by indexing into it via the
 *  precomputed `directionMap`. */
export function buildFacePatternLookup(input: FacePatternLookupInputs): Int32Array {
  const { tagOptions, facePatternAssignments, facePalettes, facePatterns } = input;
  // Per-palette label→index map (index into ['none', ...palette.labels]).
  const paletteIndex = new Map<string, Map<string, number>>();
  for (const pal of facePalettes) {
    const m = new Map<string, number>();
    const labels = ['none', ...pal.labels];
    for (let i = 0; i < labels.length; i++) m.set(labels[i]!, i);
    paletteIndex.set(pal.id, m);
  }
  const out = new Int32Array(tagOptions.length * FACE_SLOT_COUNT);
  for (let s = 0; s < tagOptions.length; s++) {
    const tagName = tagOptions[s]!;
    const patternId = facePatternAssignments[tagName];
    if (!patternId) continue; // species has no pattern → all slots `none` (= 0)
    const pattern = facePatterns.find(p => p.id === patternId);
    if (!pattern) continue;
    const labelIndex = paletteIndex.get(pattern.paletteId);
    if (!labelIndex) continue; // pattern's palette missing → all slots `none`
    for (let f = 0; f < FACE_SLOT_COUNT; f++) {
      const slot = pattern.faces[f];
      if (slot === null || slot === undefined) continue; // `none` (= 0)
      const idx = labelIndex.get(slot);
      if (idx !== undefined) out[s * FACE_SLOT_COUNT + f] = idx;
    }
  }
  return out;
}

/** Convenience overload: build the lookup directly from a `CAModel`. */
export function buildFacePatternLookupFromModel(model: CAModel): Int32Array {
  const v = model.variegatedCells;
  if (!v?.enabled) return new Int32Array(0);
  const source = model.attributes.find(a => a.id === v.sourceAttributeId);
  if (!source || source.type !== 'tag' || source.isModelAttribute) return new Int32Array(0);
  return buildFacePatternLookup({
    tagOptions: source.tagOptions ?? [],
    facePatternAssignments: source.facePatternAssignments ?? {},
    facePalettes: v.facePalettes,
    facePatterns: v.facePatterns,
  });
}

/** Make a list of axis labels UNIQUE — a lookup table's `tableValues` is keyed by
 *  label NAME, so two columns with the same name would share one storage cell
 *  (editing one edits both) and leave "ghost" empty columns after a rename. Later
 *  duplicates get a ` (2)`/` (3)` suffix (first occurrence keeps its name); an
 *  empty label becomes `label`. Deterministic, so re-resolving is stable. Used at
 *  resolve time (defensive, for hand-edited files) AND by the custom-label editor
 *  on commit (so duplicates never enter the model). No-op for already-unique lists. */
export function dedupeCustomLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    let name = raw === '' ? 'label' : raw;
    if (seen.has(name)) {
      let n = 2;
      while (seen.has(`${name} (${n})`)) n++;
      name = `${name} (${n})`;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Resolve a `tag`-value-type Lookup Table's tag value labels: an existing tag
 *  attribute's `tagOptions` when `valueTagAttributeId` is set, else the manual
 *  `valueTagOptions`. Used by the table cell editor (the InlineTagSelect). */
export function resolveValueTagOptions(
  attr: { valueTagAttributeId?: string; valueTagOptions?: string[] },
  model: CAModel,
): string[] {
  if (attr.valueTagAttributeId) {
    const src = model.attributes.find(a => a.id === attr.valueTagAttributeId);
    return src?.tagOptions ? [...src.tagOptions] : [];
  }
  return attr.valueTagOptions ? [...attr.valueTagOptions] : [];
}

/** Resolve a Lookup Table axis key source to its ordered label list — the
 *  single source of truth for axis dimension + tableValues key names, shared by
 *  compilers, editor, and worker:
 *    - `facePalette` → `['none', ...palette.labels]` (implicit none at index 0).
 *    - `tagAttribute` → the tag attribute's `tagOptions` (no implicit none).
 *    - `single` → `['value']` (a one-element axis → 1-D map keyed by the other axis).
 *    - `custom` → the user labels, deduplicated (unique keys).
 *  Returns `[]` when the source is unset or its referent is missing. */
export function resolveKeyLabels(
  source: LookupKeySource | undefined,
  model: CAModel,
): string[] {
  if (!source) return [];
  if (source.kind === 'single') return ['value'];
  if (source.kind === 'custom') return dedupeCustomLabels(source.labels);
  if (source.kind === 'intRange') {
    const min = Number.isFinite(source.min) ? Math.floor(source.min) : 0;
    const rawMax = Number.isFinite(source.max) ? Math.floor(source.max) : min;
    const max = Math.max(min, Math.min(rawMax, min + MAX_INT_RANGE_SPAN - 1));
    const out: string[] = [];
    for (let v = min; v <= max; v++) out.push(String(v));
    return out;
  }
  if (source.kind === 'facePalette') {
    const pal = model.variegatedCells?.facePalettes.find(p => p.id === source.paletteId);
    return pal ? ['none', ...pal.labels] : [];
  }
  const attr = model.attributes.find(a => a.id === source.attributeId);
  return attr?.tagOptions ? [...attr.tagOptions] : [];
}

/** Flatten a lookup-table value map into a row-major `Float64Array` of size
 *  `rowLabels.length * colLabels.length`, indexed `(rowIdx * colLabels.length +
 *  colIdx)` (stride = colLabels.length). `tableValues` outer keys are rowLabel
 *  names, inner keys colLabel names. Missing entries default to 0. Rectangular
 *  tables (rowLabels ≠ colLabels) are fully supported; symmetric tables are
 *  stored as full matrices so reads never consult the `symmetric` flag (the
 *  editor enforces mirror-on-edit; storage is straightforward). */
export function normalizeLookupTable(
  values: Record<string, Record<string, number>> | undefined,
  rowLabels: readonly string[],
  colLabels: readonly string[],
): Float64Array {
  const rows = rowLabels.length;
  const cols = colLabels.length;
  const out = new Float64Array(rows * cols);
  if (!values) return out;
  for (let i = 0; i < rows; i++) {
    const row = values[rowLabels[i]!];
    if (!row) continue;
    for (let j = 0; j < cols; j++) {
      const v = row[colLabels[j]!];
      if (typeof v === 'number') out[i * cols + j] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MULTI-AXIS (N-D) Lookup Tables — see docs/PLAN_ND_LOOKUP_TABLES.md.
// `resolveAxes` is the single source of truth for an N-D table's geometry
// (dims / strides / mins / labels); EVERY consumer (all 5 compilers, the
// worker payload builders, the editor, validation) derives from it — never
// re-derives — so the baked emit offsets and the runtime buffer layout can't
// desync (the layout-lockstep discipline). Legacy 2-axis tables (no `axes`)
// resolve as N=2 with numbers identical to the historical
// `resolveKeyLabels(rowKeySource)/resolveKeyLabels(colKeySource)` pair.
// ---------------------------------------------------------------------------

/** Hard cap on axis count (the Table Lookup node carries `axis_0..axis_5`
 *  static ports — the expression-node sliced-static-ports pattern). */
export const MAX_LOOKUP_AXES = 6;
/** Hard cap on one `intRange` axis' label count (min..max span). */
export const MAX_INT_RANGE_SPAN = 4096;
/** Hard cap on a table's total entry count (8 MB as f64 in WASM memory /
 *  4 MB as f32 in the GPU varAux buffer). The editor warns far earlier. */
export const MAX_LOOKUP_TABLE_ENTRIES = 1048576;

export interface ResolvedLookupAxis {
  /** Display name (axis-port label + editor header). */
  name: string;
  /** Ordered labels (intRange axes: `String(min)..String(max)`). */
  labels: string[];
  /** Axis dimension (`labels.length || 1` — an unresolved axis degenerates to 1). */
  dim: number;
  /** Index offset: a wired lookup index is `value - min` (0 for label axes). */
  min: number;
}

export interface ResolvedLookupAxes {
  axes: ResolvedLookupAxis[];
  dims: number[];
  mins: number[];
  /** Row-major strides over `axes` in declared order (last axis contiguous). */
  strides: number[];
  /** Π dims — the flat table length. */
  total: number;
  /** True when `attr.axes` drove the resolution (multi-axis mode); false =
   *  the legacy rowKeySource/colKeySource pair resolved as N=2. */
  isMultiAxis: boolean;
}

/** True when the attribute is a multi-axis (N-D) lookup table. */
export function isMultiAxisTable(attr: Pick<Attribute, 'axes'> | undefined): boolean {
  return !!attr?.axes && attr.axes.length > 0;
}

/** Resolve a Lookup Table's full axis geometry — multi-axis (`attr.axes`) or
 *  legacy 2-axis (rowKeySource/colKeySource as N=2). */
export function resolveAxes(
  attr: Pick<Attribute, 'axes' | 'rowKeySource' | 'colKeySource'>,
  model: CAModel,
): ResolvedLookupAxes {
  const multi = isMultiAxisTable(attr);
  const list: Array<{ name?: string; source: LookupKeySource | undefined }> = multi
    ? (attr.axes as LookupAxis[]).slice(0, MAX_LOOKUP_AXES)
    : [{ source: attr.rowKeySource }, { source: attr.colKeySource }];
  const axes: ResolvedLookupAxis[] = list.map((ax, i) => {
    const labels = resolveKeyLabels(ax.source, model);
    const src = ax.source;
    const min = src?.kind === 'intRange' && Number.isFinite(src.min) ? Math.floor(src.min) : 0;
    const fallback = multi ? `Axis ${i}` : (i === 0 ? 'Row' : 'Col');
    return { name: ax.name || fallback, labels, dim: labels.length || 1, min };
  });
  const dims = axes.map(a => a.dim);
  const strides = new Array<number>(dims.length).fill(1);
  for (let i = dims.length - 2; i >= 0; i--) strides[i] = strides[i + 1]! * dims[i + 1]!;
  const total = dims.reduce((a, b) => a * b, 1);
  return { axes, dims, mins: axes.map(a => a.min), strides, total, isMultiAxis: multi };
}

/** The worker-facing table payload shape (mirrors the worker's
 *  `InteractionTablePayload`): legacy tables ship labels + sparse values,
 *  multi-axis tables ship `dims` + the dense `data`. */
export interface LookupTablePayloadLike {
  rowLabels?: readonly string[];
  colLabels?: readonly string[];
  values?: Record<string, Record<string, number>>;
  dims?: readonly number[];
  data?: readonly number[];
}

/** Payload-level normalizer — the N-D-aware sibling of `normalizeLookupTable`
 *  (which stays verbatim for the legacy 2-axis shape). Dense multi-axis data is
 *  length-clamped + zero-filled + non-finite-scrubbed so a short/hand-edited
 *  `tableData` can never leak NaN into the sim. */
export function normalizeLookupTablePayload(p: LookupTablePayloadLike): Float64Array {
  if (p.dims && p.dims.length > 0) {
    const total = p.dims.reduce((a, b) => a * Math.max(1, Math.floor(b) || 1), 1);
    const out = new Float64Array(total);
    const src = p.data;
    if (src) {
      const n = Math.min(total, src.length);
      for (let i = 0; i < n; i++) {
        const v = src[i];
        if (typeof v === 'number' && Number.isFinite(v)) out[i] = v;
      }
    }
    return out;
  }
  return normalizeLookupTable(p.values, p.rowLabels ?? [], p.colLabels ?? []);
}

/** Build the worker `interactionTables` payload entry for one lookup-table
 *  model attribute (used by SimulatorView's init/recompile builders and the
 *  updateLookupTable posts — ONE builder so the shipped shape can't drift). */
export function buildLookupTablePayload(
  attr: Attribute,
  model: CAModel,
): { id: string; rowLabels: string[]; colLabels: string[]; values: Record<string, Record<string, number>>; dims?: number[]; mins?: number[]; data?: number[] } {
  if (isMultiAxisTable(attr)) {
    const r = resolveAxes(attr, model);
    return { id: attr.id, rowLabels: [], colLabels: [], values: {}, dims: r.dims, mins: r.mins, data: attr.tableData ? [...attr.tableData] : [] };
  }
  return {
    id: attr.id,
    rowLabels: resolveKeyLabels(attr.rowKeySource, model),
    colLabels: resolveKeyLabels(attr.colKeySource, model),
    values: attr.tableValues || {},
  };
}

/** The seeded random-fill value policy: how a non-zero entry's value is drawn. */
export interface TableFillPolicy {
  /** The table's `valueType` (absent ⇒ 'float'). */
  valueType: string;
  /** integer/tag: the count of distinct NON-ZERO values (entries drawn
   *  uniformly from 1..valueCount). tag ⇒ tagOptions.length − 1. */
  valueCount: number;
}

/** Deterministic seeded random table fill — THE one implementation shared by
 *  the editor's "Randomize table" button and the Overseer's Randomize Table
 *  node (D-NDT-6). xorshift32 (13/17/5, the house PRNG), always exactly one
 *  draw per entry plus one value draw per non-zero entry, so the output is a
 *  pure function of (seed, density, total, policy) on any machine.
 *  `density` = P(entry ≠ 0); values: bool → 1, integer/tag → uniform over
 *  1..valueCount, float → uniform (0,1). */
export function randomFillTableData(
  total: number,
  seed: number,
  density: number,
  policy: TableFillPolicy,
): number[] {
  let rs = (seed >>> 0) || 0x12345678;
  const next = () => {
    rs = (rs ^ (rs << 13)) >>> 0;
    rs = (rs ^ (rs >>> 17)) >>> 0;
    rs = (rs ^ (rs << 5)) >>> 0;
    return rs / 4294967296;
  };
  const d = Math.min(1, Math.max(0, density));
  const vt = policy.valueType || 'float';
  const count = Math.max(1, Math.floor(policy.valueCount) || 1);
  const out = new Array<number>(Math.max(0, total | 0));
  for (let i = 0; i < out.length; i++) {
    if (next() < d) {
      if (vt === 'bool') { next(); out[i] = 1; }
      else if (vt === 'float') out[i] = next();
      else out[i] = 1 + Math.floor(next() * count);
    } else out[i] = 0;
  }
  return out;
}

/** Structurally remap a dense `tableData` across an AXES-LIST change (the
 *  reducer cascade for editing a multi-axis table's own axes): per-axis
 *  label-NAME matching (which covers intRange grow/shrink/shift for free —
 *  intRange labels are the stringified values) with the index-paired rename
 *  heuristic for `custom` axes; appended axes place the old data at index 0;
 *  removed (trailing — the remove-LAST discipline) axes keep the slice at
 *  index 0. Deterministic; unmatched labels zero-fill. */
export function remapTableDataForAxesChange(
  data: readonly number[] | undefined,
  oldResolved: ResolvedLookupAxes,
  newResolved: ResolvedLookupAxes,
  oldAxes: readonly LookupAxis[] | undefined,
  newAxes: readonly LookupAxis[] | undefined,
): number[] {
  const oldN = oldResolved.axes.length;
  const newN = newResolved.axes.length;
  let work: number[] = data ? [...data] : new Array<number>(oldResolved.total).fill(0);
  let dims = oldResolved.dims.slice();
  // 1. Drop removed trailing axes (collapse each to dim 1 keeping index 0 —
  //    trailing 1-dims don't change the flat layout, so they just fall off).
  if (newN < oldN) {
    for (let i = oldN - 1; i >= newN; i--) {
      work = remapTableDataAxis(work, dims, i, [0]);
      dims[i] = 1;
    }
    dims = dims.slice(0, newN);
  }
  // 2. Appended axes: trailing 1-dims leave the flat layout unchanged.
  while (dims.length < newN) dims.push(1);
  // 3. Per-axis remap to the new labels.
  for (let i = 0; i < newN; i++) {
    const newLabels = newResolved.axes[i]!.labels.length > 0 ? newResolved.axes[i]!.labels : ['value'];
    let indexMap: number[];
    if (i >= oldN) {
      // Appended axis: old data lands at index 0, the rest zero-fills.
      indexMap = newLabels.map((_, j) => (j === 0 ? 0 : -1));
    } else {
      const oldLabels = oldResolved.axes[i]!.labels.length > 0 ? oldResolved.axes[i]!.labels : ['value'];
      const isCustom = oldAxes?.[i]?.source?.kind === 'custom' && newAxes?.[i]?.source?.kind === 'custom';
      indexMap = newLabels.map((name, j) => {
        const oi = oldLabels.indexOf(name);
        if (oi >= 0) return oi;
        // Custom axes: index-paired rename heuristic (same as the legacy
        // tableValues cascade) — the label at the same position was renamed.
        if (isCustom && oldLabels[j] !== undefined && !newLabels.includes(oldLabels[j]!)) return j;
        return -1;
      });
    }
    const identity = indexMap.length === dims[i] && indexMap.every((v, j) => v === j);
    if (identity) continue;
    work = remapTableDataAxis(work, dims, i, indexMap);
    dims[i] = indexMap.length;
  }
  return work;
}

/** Structurally remap a dense `tableData` along ONE axis (the N-D analogue of
 *  the label-keyed `tableValues` remap cascades): `indexMap[newIdx] = oldIdx`
 *  (or -1/undefined ⇒ the new slot zero-fills). Powers tag rename/reorder on a
 *  referenced tag attribute, custom-label edits, intRange grow/shrink/shift,
 *  and axis-source detach (collapse to dim 1 keeping old index 0). */
export function remapTableDataAxis(
  data: readonly number[] | undefined,
  dims: readonly number[],
  axisIdx: number,
  indexMap: readonly number[],
): number[] {
  const n = dims.length;
  const newDims = dims.slice();
  newDims[axisIdx] = indexMap.length;
  const oldStrides = new Array<number>(n).fill(1);
  const newStrides = new Array<number>(n).fill(1);
  for (let i = n - 2; i >= 0; i--) {
    oldStrides[i] = oldStrides[i + 1]! * dims[i + 1]!;
    newStrides[i] = newStrides[i + 1]! * newDims[i + 1]!;
  }
  const totalNew = newDims.reduce((a, b) => a * b, 1);
  const out = new Array<number>(totalNew).fill(0);
  if (!data || totalNew === 0) return out;
  for (let flat = 0; flat < totalNew; flat++) {
    let rem = flat;
    let oldFlat = 0;
    let ok = true;
    for (let a = 0; a < n; a++) {
      const idx = Math.floor(rem / newStrides[a]!);
      rem -= idx * newStrides[a]!;
      const oldIdx = a === axisIdx ? indexMap[idx] : idx;
      if (oldIdx === undefined || oldIdx < 0 || oldIdx >= dims[a]!) { ok = false; break; }
      oldFlat += oldIdx * oldStrides[a]!;
    }
    if (ok) {
      const v = data[oldFlat];
      if (typeof v === 'number') out[flat] = v;
    }
  }
  return out;
}
