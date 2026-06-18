/**
 * WGSL encoder helpers — Wave 3 backend.
 *
 * Generates fragments of WGSL source as plain strings. The orchestrator in
 * compile.ts assembles the final shader module by stitching these together
 * with bind-group declarations, function bodies, and entry-point wrappers.
 *
 * Storage layout (matches the bind group declared by emitBindings):
 *   binding 0  attrsRead      array<u32>    — current generation, read-only
 *   binding 1  attrsWrite     array<u32>    — next generation, written by step
 *   binding 2  colors         array<u32>    — RGBA8, one packed u32 per cell
 *   binding 3  nbrOffsets     array<i32>    — relative (dRow, dCol) pairs per neighbourhood
 *   binding 4  modelAttrs     array<vec4f, 64>  — uniform, packed scalars/colors
 *   binding 5  indicators     array<atomic<u32>> — one atomic word per indicator
 *   binding 6  rngState       array<u32>    — one u32 per cell (PCG state)
 *   binding 7  control        Control       — { activeViewer: i32, stopFlag: atomic<u32> }
 *
 * Neighbour cell indices are NOT stored per-cell. Instead the shared helper
 * `nbrCellIdx(cellIdx, baseOffset, k)` reads the (dRow, dCol) pair at
 * `nbrOffsets[baseOffset + 2k]` / `nbrOffsets[baseOffset + 2k + 1]`, applies
 * the boundary rule (torus wrap or constant-sentinel), and returns the linear
 * cell index. Saves multi-GB of buffer + readback bandwidth on huge grids
 * (see docs/HUGE_GRID_OPTIMIZATIONS.md §2.1).
 *
 * Bool/int/tag/float attrs are all stored as one u32 word per cell on GPU,
 * with bool packed as 0/1, int/tag as bitcast<i32>, float as bitcast<f32>.
 * Per-cell emitters bitcast on read/write.
 */

import type { WebGPULayout } from './layout';

/** Sanitise an arbitrary id into a WGSL-safe identifier suffix. Mirrors the
 *  WASM compiler's `sanitiseExportName` so entry-point names line up across
 *  targets (the worker can pick them out by mappingId). */
export function sanitiseWgslName(s: string): string {
  let r = (s || '').replace(/[^A-Za-z0-9_]/g, '_');
  if (r.length === 0) r = '_';
  if (/^[0-9]/.test(r)) r = '_' + r;
  return r;
}

/** Bind-group declarations + Control struct + the shared PCG advance helper +
 *  the boundary-aware `nbrCellIdx` helper. Struct definitions must come before
 *  any `var` decl that references them. */
export function emitBindings(layout: WebGPULayout): string {
  // Uniform buffer must be at least 16 bytes (one vec4). Compute the f32-element
  // capacity so the WGSL declaration matches what the worker uploads.
  const modelAttrFloats = Math.max(4, Math.ceil(layout.modelAttrsBytes / 4));
  const modelAttrVec4s = Math.ceil(modelAttrFloats / 4);

  // Boundary-baked nbrCellIdx helper. Width/height/sentinel are emitted as
  // literals so each grid-size produces a unique shader (so the pipeline
  // cache invalidates correctly via shaderHashOf when the user resizes).
  // Torus has no sentinel; constant returns SENTINEL on out-of-bounds, which
  // points at the +1 slot in attrsRead/Write that the worker fills with the
  // attribute's boundary value at upload time.
  const gw = layout.gridWidth;
  const gh = layout.gridHeight;
  const gd = layout.gridDepth;             // 3D Grid CA: layer count (1 → 2D)
  const wh = gw * gh;                       // cells per layer
  const isTorus = layout.boundaryTreatment === 'torus';
  // The NI-codec helper `nbrCellIdxFromNi` resolves a packed offset NI to a cell
  // index. 2D = 2-axis (dr<<16|dc); 3D = three 10-bit fields (dr<<20|dc<<10|dl)
  // resolved via the layer. The 2D branch is byte-for-byte identical to the
  // pre-3D emit so the 2D pipeline-cache hash is preserved.
  let nbrCellIdxFromNiFn: string;
  if (gd > 1) {
    nbrCellIdxFromNiFn = isTorus ? `
// 3D Grid CA: packed (dr, dc, dl) NIs — three sign-extended 10-bit fields.
fn nbrCellIdxFromNi(cellIdx: u32, ni: i32) -> i32 {
  let dr: i32 = (ni << 2) >> 22;
  let dc: i32 = (ni << 12) >> 22;
  let dl: i32 = (ni << 22) >> 22;
  let layer: i32 = i32(cellIdx) / ${wh};
  let rem: i32 = i32(cellIdx) - layer * ${wh};
  let row: i32 = rem / ${gw};
  let col: i32 = rem % ${gw};
  let nl: i32 = ((layer + dl) % ${gd} + ${gd}) % ${gd};
  let nr: i32 = ((row + dr) % ${gh} + ${gh}) % ${gh};
  let nc: i32 = ((col + dc) % ${gw} + ${gw}) % ${gw};
  return (nl * ${gh} + nr) * ${gw} + nc;
}` : `
fn nbrCellIdxFromNi(cellIdx: u32, ni: i32) -> i32 {
  let dr: i32 = (ni << 2) >> 22;
  let dc: i32 = (ni << 12) >> 22;
  let dl: i32 = (ni << 22) >> 22;
  let layer: i32 = i32(cellIdx) / ${wh};
  let rem: i32 = i32(cellIdx) - layer * ${wh};
  let row: i32 = rem / ${gw};
  let col: i32 = rem % ${gw};
  let nl: i32 = layer + dl;
  let nr: i32 = row + dr;
  let nc: i32 = col + dc;
  if (nl < 0 || nl >= ${gd} || nr < 0 || nr >= ${gh} || nc < 0 || nc >= ${gw}) {
    return ${layout.sentinelIndex};
  }
  return (nl * ${gh} + nr) * ${gw} + nc;
}`;
  } else {
    nbrCellIdxFromNiFn = isTorus ? `
// Wave A.6: variant for packed (dr, dc) NIs. dr in upper 16 bits, dc in lower.
fn nbrCellIdxFromNi(cellIdx: u32, ni: i32) -> i32 {
  let dr: i32 = ni >> 16;
  let dc: i32 = (ni << 16) >> 16;
  let row: i32 = i32(cellIdx) / ${gw};
  let col: i32 = i32(cellIdx) % ${gw};
  let nr: i32 = ((row + dr) % ${gh} + ${gh}) % ${gh};
  let nc: i32 = ((col + dc) % ${gw} + ${gw}) % ${gw};
  return nr * ${gw} + nc;
}` : `
fn nbrCellIdxFromNi(cellIdx: u32, ni: i32) -> i32 {
  let dr: i32 = ni >> 16;
  let dc: i32 = (ni << 16) >> 16;
  let row: i32 = i32(cellIdx) / ${gw};
  let col: i32 = i32(cellIdx) % ${gw};
  let nr: i32 = row + dr;
  let nc: i32 = col + dc;
  if (nr < 0 || nr >= ${gh} || nc < 0 || nc >= ${gw}) {
    return ${layout.sentinelIndex};
  }
  return nr * ${gw} + nc;
}`;
  }
  // `nbrCellIdx` (offset-table neighbours, used by getNeighborsAttribute etc.) —
  // 2D emits the verbatim 2-axis helper (byte-identical); 3D reads a 3rd offset
  // (stride 3) and wraps/clamps the layer.
  let nbrCellIdxCore: string;
  if (gd > 1) {
    nbrCellIdxCore = isTorus ? `
fn nbrCellIdx(cellIdx: u32, baseOffset: u32, k: i32) -> i32 {
  let dr: i32 = nbrOffsets[baseOffset + u32(k) * 3u];
  let dc: i32 = nbrOffsets[baseOffset + u32(k) * 3u + 1u];
  let dl: i32 = nbrOffsets[baseOffset + u32(k) * 3u + 2u];
  let layer: i32 = i32(cellIdx) / ${wh};
  let rem: i32 = i32(cellIdx) - layer * ${wh};
  let row: i32 = rem / ${gw};
  let col: i32 = rem % ${gw};
  let nl: i32 = ((layer + dl) % ${gd} + ${gd}) % ${gd};
  let nr: i32 = ((row + dr) % ${gh} + ${gh}) % ${gh};
  let nc: i32 = ((col + dc) % ${gw} + ${gw}) % ${gw};
  return (nl * ${gh} + nr) * ${gw} + nc;
}` : `
fn nbrCellIdx(cellIdx: u32, baseOffset: u32, k: i32) -> i32 {
  let dr: i32 = nbrOffsets[baseOffset + u32(k) * 3u];
  let dc: i32 = nbrOffsets[baseOffset + u32(k) * 3u + 1u];
  let dl: i32 = nbrOffsets[baseOffset + u32(k) * 3u + 2u];
  let layer: i32 = i32(cellIdx) / ${wh};
  let rem: i32 = i32(cellIdx) - layer * ${wh};
  let row: i32 = rem / ${gw};
  let col: i32 = rem % ${gw};
  let nl: i32 = layer + dl;
  let nr: i32 = row + dr;
  let nc: i32 = col + dc;
  if (nl < 0 || nl >= ${gd} || nr < 0 || nr >= ${gh} || nc < 0 || nc >= ${gw}) {
    return ${layout.sentinelIndex};
  }
  return (nl * ${gh} + nr) * ${gw} + nc;
}`;
  } else {
    nbrCellIdxCore = isTorus ? `
fn nbrCellIdx(cellIdx: u32, baseOffset: u32, k: i32) -> i32 {
  let dr: i32 = nbrOffsets[baseOffset + u32(k) * 2u];
  let dc: i32 = nbrOffsets[baseOffset + u32(k) * 2u + 1u];
  let row: i32 = i32(cellIdx) / ${gw};
  let col: i32 = i32(cellIdx) % ${gw};
  let nr: i32 = ((row + dr) % ${gh} + ${gh}) % ${gh};
  let nc: i32 = ((col + dc) % ${gw} + ${gw}) % ${gw};
  return nr * ${gw} + nc;
}` : `
fn nbrCellIdx(cellIdx: u32, baseOffset: u32, k: i32) -> i32 {
  let dr: i32 = nbrOffsets[baseOffset + u32(k) * 2u];
  let dc: i32 = nbrOffsets[baseOffset + u32(k) * 2u + 1u];
  let row: i32 = i32(cellIdx) / ${gw};
  let col: i32 = i32(cellIdx) % ${gw};
  let nr: i32 = row + dr;
  let nc: i32 = col + dc;
  if (nr < 0 || nr >= ${gh} || nc < 0 || nc >= ${gw}) {
    return ${layout.sentinelIndex};
  }
  return nr * ${gw} + nc;
}`;
  }
  const nbrCellIdxFn = nbrCellIdxCore + nbrCellIdxFromNiFn;

  return `// === Bindings ===
struct Control {
  activeViewer : i32,
  stopFlag     : atomic<u32>,
};

@group(0) @binding(0) var<storage, read>       attrsRead    : array<u32>;
@group(0) @binding(1) var<storage, read_write> attrsWrite   : array<u32>;
@group(0) @binding(2) var<storage, read_write> colors       : array<u32>;
@group(0) @binding(3) var<storage, read>       nbrOffsets   : array<i32>;
@group(0) @binding(4) var<uniform>             modelAttrs   : array<vec4<f32>, ${modelAttrVec4s}u>;
@group(0) @binding(5) var<storage, read_write> indicators   : array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> rngState     : array<u32>;
@group(0) @binding(7) var<storage, read_write> control      : Control;
@group(0) @binding(8) var<storage, read>       varAux       : array<u32>;
@group(0) @binding(9) var<storage, read_write> glyphCodes   : array<u32>;
@group(0) @binding(10) var<storage, read_write> glyphColors  : array<u32>;
${nbrCellIdxFn}

// PCG hash + per-cell advance. Mirrors the per-cell stream model in the
// runtime: each cell owns its own rngState[cellIdx] and updates it in place.
// JS/WASM use a single shared xorshift32 stream — WebGPU's per-cell streams
// produce different sequences for the same seed. This is intentional and
// documented as a target-specific behaviour.
fn pcg_hash(input: u32) -> u32 {
  var state: u32 = input * 747796405u + 2891336453u;
  let word: u32 = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rand_advance(cell: u32) -> u32 {
  let prev: u32 = rngState[cell];
  let next: u32 = pcg_hash(prev + 1u);
  rngState[cell] = next;
  return next;
}
fn rand_f32(cell: u32) -> f32 {
  // Map u32 → [0, 1). 1.0 / 2^32 ≈ 2.3283064e-10.
  return f32(rand_advance(cell)) * 2.3283064365386963e-10;
}
`;
}

/** Wrap a per-cell body in a compute-shader entry point with workgroup-size 64.
 *  Caller passes the inner body assuming `idx: u32` is the linear cell index. */
export function emitEntryPoint(name: string, total: number, body: string): string {
  return `@compute @workgroup_size(64)
fn ${name}(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx: u32 = gid.x;
  if (idx >= ${total}u) { return; }
${body}
}
`;
}

/** Emit per-cell bulk-copy lines for sync mode: every attr's slot at `idx` is
 *  copied from attrsRead to attrsWrite. Per-node SetAttribute emitters then
 *  overwrite specific cells. Anything not written by a node retains its
 *  previous-generation value.
 *
 *  Optional `skipAttrIds`: attrs that are guaranteed to be written by a
 *  setAttribute on every flow path (and never read via updateAttribute) — the
 *  copy is dead bandwidth for them. The compiler's dataflow analysis (P8) is
 *  responsible for proving the guarantee; this helper just trusts the set. */
export function emitPerCellCopyPreamble(layout: WebGPULayout, skipAttrIds?: ReadonlySet<string>): string {
  const lines: string[] = [];
  for (const a of layout.attrs) {
    if (skipAttrIds && skipAttrIds.has(a.id)) continue;
    const w = a.wordOffset;
    if (w === 0) {
      lines.push(`  attrsWrite[idx] = attrsRead[idx];`);
    } else {
      lines.push(`  attrsWrite[${w}u + idx] = attrsRead[${w}u + idx];`);
    }
  }
  // Variegated Cells: same sync-mode discipline — copy orientation r→w so
  // SetOrientation writes overlay on a fresh copy of the read buffer. The
  // attrsBufA / attrsBufB swap (which already handles cell-attr ping-pong)
  // also flips orientation read↔write.
  if (layout.variegatedEnabled && layout.orientationBytes > 0) {
    const w = layout.orientationWordOffset;
    lines.push(`  attrsWrite[${w}u + idx] = attrsRead[${w}u + idx];`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

