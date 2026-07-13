/** Shared, pure active-cell maintenance for the "Skip Isolated Empty Cells"
 *  optimization (docs/PLAN_LARGE_GRID_PERF.md, Feature A).
 *
 *  A cell is ACTIVE iff it is within the *active range* of at least one NON-empty
 *  cell (a non-empty cell is within range 0 of itself → always active). Only
 *  active cells run the Generation Step + the Output Mapping colour pass; isolated
 *  empty cells (no non-empty cell within range) are skipped — they keep their
 *  state + colour (the "empty" appearance, established by the initial full colour
 *  pass / default fill).
 *
 *  Reference-counted (`nearCount`) so it stays correct for MONOTONIC (accretion —
 *  the active set only grows) AND non-monotonic models (cells can go
 *  empty↔non-empty; the counts go up and down, and stale list entries are pruned
 *  by `compactActiveSet`).
 *
 *  Used by BOTH the worker (sim.worker.ts) AND the verification harness
 *  (scripts/verify-sparse-stepping.mjs) — ONE source of truth, no divergence.
 *
 *  The range is SYMMETRIZED (`+off` and `−off`) so the active set correctly
 *  covers a cell that READS a non-empty cell regardless of range symmetry, as
 *  long as the chosen range ⊇ the model's read-neighbourhood (the user's
 *  responsibility — it is an opt-in feature and they pick the range). */

export type RangeMetric = 'chebyshev' | 'manhattan' | 'euclidean';

export interface ActiveDims {
  width: number;
  height: number;
  depth: number;   // 1 in 2D
  total: number;   // width*height*depth
  is3d: boolean;
  torus: boolean;  // true = torus wrap; false = constant boundary (drop out-of-bounds)
}

export interface ActiveSet {
  dims: ActiveDims;
  /** Flat SYMMETRIC dilation offsets `[dl,dr,dc, dl,dr,dc, …]` including origin. */
  offsets: Int32Array;
  offCount: number;
  emptyVal: number;
  nearCount: Uint16Array; // length total — # of non-empty cells within range of each cell
  list: Int32Array;       // length total (capacity) — active indices in [0, count)
  member: Uint8Array;     // length total — 1 iff idx currently in `list`
  count: number;
  staleCount: number;     // # of list entries whose nearCount later dropped to 0
}

/** A neighbourhood coord triple is stored as `[dr, dc, dl]` in the model
 *  (`coords3d`); a 2D `coords` entry is `[dr, dc]` (dl = 0). */
export type ActiveRangeSpec =
  | { kind: 'neighborhood'; coords: ReadonlyArray<ReadonlyArray<number>> }
  | { kind: 'radius'; radius: number; metric: RangeMetric; is3d: boolean };

/** Build the SYMMETRIC dilation offset set (incl. the origin) from a
 *  neighbourhood's coords ([dr,dc[,dl]]) OR a radius+metric. Deduped. */
export function buildActiveOffsets(spec: ActiveRangeSpec): { offsets: Int32Array; offCount: number } {
  const seen = new Set<string>();
  const out: number[] = [];
  const push = (dl: number, dr: number, dc: number) => {
    const k = dl + ',' + dr + ',' + dc;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(dl, dr, dc);
  };
  push(0, 0, 0);
  if (spec.kind === 'neighborhood') {
    for (const c of spec.coords) {
      const dr = c[0] ?? 0, dc = c[1] ?? 0, dl = c[2] ?? 0;
      push(dl, dr, dc);
      push(-dl, -dr, -dc);
    }
  } else {
    const R = Math.max(0, Math.floor(spec.radius));
    const zr = spec.is3d ? R : 0;
    for (let dl = -zr; dl <= zr; dl++)
      for (let dr = -R; dr <= R; dr++)
        for (let dc = -R; dc <= R; dc++) {
          let inside: boolean;
          if (spec.metric === 'chebyshev') inside = Math.max(Math.abs(dl), Math.abs(dr), Math.abs(dc)) <= R;
          else if (spec.metric === 'manhattan') inside = Math.abs(dl) + Math.abs(dr) + Math.abs(dc) <= R;
          else inside = dl * dl + dr * dr + dc * dc <= R * R;
          if (inside) push(dl, dr, dc);
        }
  }
  return { offsets: Int32Array.from(out), offCount: out.length / 3 };
}

/** `listBuffer` (optional): a pre-allocated Int32Array of capacity `total` to
 *  use as the active list — the worker passes a VIEW over wasmMemory at
 *  `layout.activeListOffset` so the sparse WASM step reads the live list with
 *  zero copies (the JS step reads the same view through its `_activeList` arg). */
export function createActiveSet(dims: ActiveDims, offsets: Int32Array, offCount: number, emptyVal: number, listBuffer?: Int32Array): ActiveSet {
  return {
    dims, offsets, offCount, emptyVal,
    nearCount: new Uint16Array(dims.total),
    list: listBuffer && listBuffer.length >= dims.total ? listBuffer : new Int32Array(dims.total),
    member: new Uint8Array(dims.total),
    count: 0,
    staleCount: 0,
  };
}

/** `attr[idx] === emptyVal`. `attr` is any indexable numeric array (typed array). */
export function isEmptyAt(attr: { [i: number]: number }, idx: number, emptyVal: number): boolean {
  return attr[idx] === emptyVal;
}

/** Add (delta +1) or remove (delta −1) a non-empty cell's contribution to the
 *  nearCount of every cell in its range dilation, maintaining the active list. */
function dilate(as: ActiveSet, idx: number, delta: 1 | -1): void {
  const { width: W, height: H, depth: D, torus, is3d } = as.dims;
  const WH = W * H;
  const layer = is3d ? (idx / WH) | 0 : 0;
  const rem = idx - layer * WH;
  const row = (rem / W) | 0;
  const col = rem - row * W;
  const off = as.offsets, nc = as.nearCount, list = as.list, member = as.member;
  const oc = as.offCount;
  for (let k = 0; k < oc; k++) {
    const base = k * 3;
    let nl = layer + off[base]!;
    let nr = row + off[base + 1]!;
    let ncol = col + off[base + 2]!;
    if (torus) {
      nl = ((nl % D) + D) % D;
      nr = ((nr % H) + H) % H;
      ncol = ((ncol % W) + W) % W;
    } else if (nl < 0 || nl >= D || nr < 0 || nr >= H || ncol < 0 || ncol >= W) {
      continue;
    }
    const m = (nl * H + nr) * W + ncol;
    const before = nc[m]!;
    const after = before + delta;
    nc[m] = after;
    if (delta === 1) {
      if (before === 0 && member[m] === 0) { list[as.count++] = m; member[m] = 1; }
    } else if (after === 0) {
      as.staleCount++;
    }
  }
}

/** Rebuild the active set from scratch by scanning the whole grid once (O(total)
 *  reads + O(nonEmpty × offCount) marks). Call after init / reset / gridInit /
 *  loadState. `attr` is the "empty" attribute's cell array (read buffer). */
export function rebuildActiveSet(as: ActiveSet, attr: { [i: number]: number }): void {
  as.nearCount.fill(0);
  as.member.fill(0);
  as.count = 0;
  as.staleCount = 0;
  const total = as.dims.total;
  const ev = as.emptyVal;
  for (let i = 0; i < total; i++) {
    if (attr[i] !== ev) dilate(as, i, 1);
  }
}

/** Apply a single cell's empty↔non-empty transition. No-op if unchanged. */
export function applyTransition(as: ActiveSet, idx: number, wasEmpty: boolean, isEmptyNow: boolean): void {
  if (wasEmpty === isEmptyNow) return;
  dilate(as, idx, isEmptyNow ? -1 : 1);  // became empty → −1; became non-empty → +1
}

/** Drop stale entries (nearCount fell to 0). O(count). Monotonic (accretion)
 *  models never accumulate stale entries, so this is a no-op there. */
export function compactActiveSet(as: ActiveSet): void {
  let w = 0;
  const list = as.list, nc = as.nearCount, member = as.member, n = as.count;
  for (let r = 0; r < n; r++) {
    const idx = list[r]!;
    if (nc[idx]! > 0) list[w++] = idx;
    else member[idx] = 0;
  }
  as.count = w;
  as.staleCount = 0;
}
