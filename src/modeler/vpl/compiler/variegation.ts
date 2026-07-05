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

import type { CAModel, LookupKeySource, Neighborhood } from '../../../model/types';

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

/** Resolve a Lookup Table axis key source to its ordered label list — the
 *  single source of truth for axis dimension + tableValues key names, shared by
 *  compilers, editor, and worker:
 *    - `facePalette` → `['none', ...palette.labels]` (implicit none at index 0).
 *    - `tagAttribute` → the tag attribute's `tagOptions` (no implicit none).
 *    - `single` → `['value']` (a one-element axis → 1-D map keyed by the other axis).
 *  Returns `[]` when the source is unset or its referent is missing. */
export function resolveKeyLabels(
  source: LookupKeySource | undefined,
  model: CAModel,
): string[] {
  if (!source) return [];
  if (source.kind === 'single') return ['value'];
  if (source.kind === 'custom') return [...source.labels];
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
