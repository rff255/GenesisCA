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
 *   binding 3  nbrIndices     array<i32>    — neighbour cell indices, per nbrhd
 *   binding 4  modelAttrs     array<vec4f, 64>  — uniform, packed scalars/colors
 *   binding 5  indicators     array<atomic<u32>> — one atomic word per indicator
 *   binding 6  rngState       array<u32>    — one u32 per cell (PCG state)
 *   binding 7  control        Control       — { activeViewer: i32, stopFlag: atomic<u32> }
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

/** Bind-group declarations + Control struct + the shared PCG advance helper.
 *  Struct definitions must come before any `var` decl that references them. */
export function emitBindings(layout: WebGPULayout): string {
  // Uniform buffer must be at least 16 bytes (one vec4). Compute the f32-element
  // capacity so the WGSL declaration matches what the worker uploads.
  const modelAttrFloats = Math.max(4, Math.ceil(layout.modelAttrsBytes / 4));
  const modelAttrVec4s = Math.ceil(modelAttrFloats / 4);
  return `// === Bindings ===
struct Control {
  activeViewer : i32,
  stopFlag     : atomic<u32>,
};

@group(0) @binding(0) var<storage, read>       attrsRead    : array<u32>;
@group(0) @binding(1) var<storage, read_write> attrsWrite   : array<u32>;
@group(0) @binding(2) var<storage, read_write> colors       : array<u32>;
@group(0) @binding(3) var<storage, read>       nbrIndices   : array<i32>;
@group(0) @binding(4) var<uniform>             modelAttrs   : array<vec4<f32>, ${modelAttrVec4s}u>;
@group(0) @binding(5) var<storage, read_write> indicators   : array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> rngState     : array<u32>;
@group(0) @binding(7) var<storage, read_write> control      : Control;

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
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

