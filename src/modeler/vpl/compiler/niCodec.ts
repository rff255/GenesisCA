/** Wave A.6 — NeighborIndex codec (packed `(dr, dc)` i32).
 *
 *  Runtime layout:
 *    - Upper 16 bits, sign-extended: dr (row offset)
 *    - Lower 16 bits, sign-extended: dc (column offset)
 *    - Range per axis: ±32 767 — overkill for any realistic neighborhood.
 *
 *  An NI value of `0` decodes to `(0, 0)` — the centre cell itself, a
 *  meaningful position. To distinguish "no neighbor" we use a separate
 *  sentinel: `INVALID_NI = 0x80000000` (i32 min). It decodes to
 *  `(dr=-32768, dc=0)` — far outside any realistic neighborhood. Treat it as
 *  an opaque sentinel: producers emit it as the bit pattern `0x80000000`,
 *  consumers compare against the same bit pattern. Don't rely on the decoded
 *  (-32768, 0) values matching anything meaningful.
 *
 *  Producers that may yield "no neighbor" (e.g. `pickRandomNeighbor` on an
 *  empty array) emit `INVALID_NI`. Consumers (`getNeighborAttributeByIndex`,
 *  `setNeighborAttributeByIndex`) guard with `_ni !== INVALID_NI` before
 *  doing the address calculation.
 *
 *  This module is shared by the JS, WASM and WebGPU compilers. WASM and
 *  WebGPU have their own emit-helper functions (in their respective
 *  `encoder.ts`) that follow the same encoding convention. */

/** Sentinel "no neighbor" NeighborIndex value. */
export const INVALID_NI = 0x80000000 | 0; // -2147483648 as i32

/** Node types whose array output is an NI[] (list of packed (dr, dc) NIs).
 *  Used by `arrayElement` to pick the right out-of-range default —
 *  `INVALID_NI` for NI[], plain `0` (or `false` / `0.0`) for value[] sources
 *  like `getNeighborsAttribute` or position-list outputs of group nodes.
 *  Keep in sync across JS / WASM / WebGPU compilers. */
export const NI_ARRAY_PRODUCERS: ReadonlySet<string> = new Set([
  'getAllNeighborIndexes',
  'getNeighborIndexesByTags',
  'filterNeighbors',
  'joinNeighbors',
  'pickNRandomNeighbors',
]);

/** Pack `(dr, dc)` integer offsets into a single i32 NI value. */
export function packNI(dr: number, dc: number): number {
  return (((dr & 0xFFFF) << 16) | (dc & 0xFFFF)) | 0;
}

/** Unpack an NI value into its `(dr, dc)` integer offsets. */
export function unpackNI(packed: number): { dr: number; dc: number } {
  return {
    dr: packed >> 16,
    dc: (packed << 16) >> 16,
  };
}

// ---------------------------------------------------------------------------
// JS code-gen helpers — emit expressions that operate on packed NI values at
// runtime in the compiled step / inputColor / outputMapping functions.
// ---------------------------------------------------------------------------

/** Emit a JS expression that decodes the dr (row offset) of a packed NI. */
export function niDrExpr(niExpr: string): string {
  return `((${niExpr}) >> 16)`;
}

/** Emit a JS expression that decodes the dc (column offset) of a packed NI. */
export function niDcExpr(niExpr: string): string {
  return `((${niExpr} << 16) >> 16)`;
}

/** Emit a JS expression that packs `(drExpr, dcExpr)` into an NI value. */
export function niPackExpr(drExpr: string, dcExpr: string): string {
  return `(((((${drExpr}) & 0xFFFF) << 16) | ((${dcExpr}) & 0xFFFF)) | 0)`;
}

/** Emit a sequence of JS statements that compute the cell index reached by
 *  applying NI `niExpr` from the current cell `idx`. The result is stored in
 *  a fresh local `_aix${idSuffix}` and the helper returns the NAME of that
 *  local for downstream use.
 *
 *  Requires `_row` and `_col` and (`H`, `W`, `total`) to be in scope at the
 *  call site — emitted once per cell at the top of the loop body by the
 *  compiler.
 *
 *  `boundary === 'torus'` uses modular wrapping (preserves the same semantics
 *  as the legacy `nIdx_<nbrId>` table for torus grids). `boundary === 'constant'`
 *  emits the sentinel cell index `total` for out-of-bounds offsets, matching
 *  the legacy table's constant-boundary behaviour. The boundary mode is baked
 *  at compile time so there's no runtime branch.
 *
 *  When the consumer expects to guard against `INVALID_NI`, it should check
 *  `niExpr !== ${INVALID_NI}` before using the result — this helper does NOT
 *  bake that check in (because some callers want unconditional access for
 *  speed when the input is statically known not to be INVALID_NI). */
export function niCellExprStmts(
  niExpr: string,
  boundary: 'torus' | 'constant',
  idSuffix: string,
): { stmts: string; cellExpr: string } {
  if (boundary === 'torus') {
    return {
      stmts: [
        `const _ar${idSuffix} = ((_row + ((${niExpr}) >> 16)) % H + H) % H;`,
        `const _ac${idSuffix} = ((_col + (((${niExpr}) << 16) >> 16)) % W + W) % W;`,
        `const _aix${idSuffix} = _ar${idSuffix} * W + _ac${idSuffix};`,
      ].join(' '),
      cellExpr: `_aix${idSuffix}`,
    };
  }
  // constant boundary: out-of-bounds → total (sentinel cell that holds the
  // configured boundary value, populated by the worker on init)
  return {
    stmts: [
      `const _ar${idSuffix} = _row + ((${niExpr}) >> 16);`,
      `const _ac${idSuffix} = _col + (((${niExpr}) << 16) >> 16);`,
      `const _aix${idSuffix} = (_ar${idSuffix} >= 0 && _ar${idSuffix} < H && _ac${idSuffix} >= 0 && _ac${idSuffix} < W) ? _ar${idSuffix} * W + _ac${idSuffix} : total;`,
    ].join(' '),
    cellExpr: `_aix${idSuffix}`,
  };
}
