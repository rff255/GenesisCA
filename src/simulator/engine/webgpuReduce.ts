/// <reference types="@webgpu/types" />
/**
 * O5 — GPU-side reduction for watched linked indicators.
 *
 * For models with watched linked indicators (typical pattern: Wireworld's
 * linked-frequency on the `state` tag attribute), the per-step CPU pipeline
 * was: readback the source attribute's full bytes → iterate every cell on
 * one CPU thread → produce {category: count} histogram. At 25M cells that's
 * ~50 ms per step.
 *
 * This module dispatches a small compute shader that does the reduction on
 * the GPU directly. The reductions buffer is tiny (one u32 per slot, bounded
 * by attribute cardinality) so the per-step readback is cheap.
 *
 * Supported (GPU-eligible):
 *   - total aggregation on integer / tag / bool attrs (atomicAdd<u32>)
 *   - frequency on bool (2 slots: false / true)
 *   - frequency on tag (N slots, N = tagOptions.length)
 *
 * Falls back to CPU readback + computeLinkedIndicatorsFromBuffer:
 *   - total on float (no atomicAdd<f32> in WGSL; would need CAS loop)
 *   - frequency on integer (unbounded cardinality)
 *   - frequency on float (needs min/max pre-pass)
 *   - non-watched indicators (we only do watched ones)
 *
 * Accumulation mode is handled OUTSIDE this module: per-generation
 * indicators take the new value; accumulated indicators add it to a CPU-
 * resident running accumulator. We don't try to keep the accumulator on GPU.
 */

import type { WebGPULayout, WebGPULayoutAttr } from '../../modeler/vpl/compiler/webgpu/layout';

export interface LinkedDef {
  id: string;
  accumulationMode: string;
  attrId?: string;
  attrType?: string;
  aggregation?: string;
  binCount?: number;
  tagOptions?: string[];
  watched?: boolean;
}

export interface ReductionPlanEntry {
  id: string;
  attrId: string;
  attrType: string;
  aggregation: 'total' | 'frequency';
  /** First slot index in the reductions buffer (slot = u32 word). */
  slotOffset: number;
  /** Number of slots claimed (1 for total; 2 for bool freq; N for tag freq). */
  slotCount: number;
  /** For tag frequency: the tag option names so the worker can label the
   *  result histogram. */
  tagOptions?: string[];
  /** Cell-attr word offset in the attrsRead storage buffer (cells per attr). */
  attrWordOffset: number;
  /** Generated WGSL entry-point name. */
  entry: string;
}

export interface ReductionPlan {
  entries: ReductionPlanEntry[];
  /** Total u32 slots needed by all entries (sum of slotCount). At least 4
   *  (storage buffers must be ≥ 4 bytes; we round up so the buffer alloc is
   *  always non-degenerate). */
  totalSlots: number;
}

/** Build a reduction plan from the worker's linkedDefs + the WebGPU layout.
 *  Skips any indicator whose aggregation isn't GPU-eligible — those keep
 *  using the existing CPU readback fallback. */
export function buildReductionPlan(linkedDefs: LinkedDef[], layout: WebGPULayout): ReductionPlan {
  const entries: ReductionPlanEntry[] = [];
  let cursor = 0;
  for (const d of linkedDefs) {
    if (!d.watched) continue;
    if (!d.attrId || !d.attrType || !d.aggregation) continue;
    const attr = layout.attrs.find(a => a.id === d.attrId);
    if (!attr) continue;
    let slotCount = 0;
    let aggregation: 'total' | 'frequency';
    if (d.aggregation === 'total') {
      // Float total would require an atomic CAS loop — defer to CPU. Color
      // attrs are non-numeric and don't appear here either.
      if (d.attrType !== 'integer' && d.attrType !== 'tag' && d.attrType !== 'bool') continue;
      slotCount = 1;
      aggregation = 'total';
    } else if (d.aggregation === 'frequency') {
      if (d.attrType === 'bool') slotCount = 2;
      else if (d.attrType === 'tag') slotCount = (d.tagOptions || []).length;
      else continue; // integer / float frequency on CPU
      if (slotCount <= 0) continue;
      aggregation = 'frequency';
    } else continue;

    entries.push({
      id: d.id,
      attrId: d.attrId,
      attrType: d.attrType,
      aggregation,
      slotOffset: cursor,
      slotCount,
      tagOptions: d.tagOptions,
      attrWordOffset: attr.wordOffset,
      entry: `reduce_${entries.length}`,
    });
    cursor += slotCount;
  }
  return { entries, totalSlots: Math.max(4, cursor) };
}

/** Generate the WGSL source for the reduction shader module. One entry-point
 *  per plan entry. Each entry-point dispatches `total` invocations and uses
 *  atomic ops on the reductions buffer to accumulate. */
export function emitReductionShader(plan: ReductionPlan, total: number): string {
  const lines: string[] = [];
  lines.push('// O5 reduction shader — generated per recompile.');
  lines.push('@group(0) @binding(0) var<storage, read> attrsRead : array<u32>;');
  lines.push('@group(0) @binding(1) var<storage, read_write> reductions : array<atomic<u32>>;');
  lines.push('');

  for (const e of plan.entries) {
    const slot = (off: number) => `${e.slotOffset + off}u`;
    const wordExpr = e.attrWordOffset === 0 ? `attrsRead[idx]` : `attrsRead[${e.attrWordOffset}u + idx]`;
    lines.push(`@compute @workgroup_size(64)`);
    lines.push(`fn ${e.entry}(@builtin(global_invocation_id) gid: vec3<u32>) {`);
    lines.push(`  let idx: u32 = gid.x;`);
    lines.push(`  if (idx >= ${total}u) { return; }`);
    lines.push(`  let raw : u32 = ${wordExpr};`);
    if (e.aggregation === 'total') {
      if (e.attrType === 'bool') {
        // bool stored as 0/1; sum is the count of true cells.
        lines.push(`  atomicAdd(&reductions[${slot(0)}], raw);`);
      } else {
        // integer / tag stored as bitcast<i32>. Reinterpret as i32 then add to
        // the slot. WGSL has no atomicAdd<i32>; we add the u32 bit pattern.
        // For non-negative values this matches integer add. For negative
        // values the modular arithmetic still gives the correct sum modulo
        // 2^32, and the worker decodes the result via bitcast<i32> on
        // readback so the displayed total is signed-correct as long as the
        // true sum fits in i32.
        lines.push(`  atomicAdd(&reductions[${slot(0)}], raw);`);
      }
    } else { // frequency
      if (e.attrType === 'bool') {
        lines.push(`  if (raw == 0u) { atomicAdd(&reductions[${slot(0)}], 1u); }`);
        lines.push(`  else           { atomicAdd(&reductions[${slot(1)}], 1u); }`);
      } else { // tag
        const cap = e.slotCount;
        lines.push(`  let tagVal: i32 = bitcast<i32>(raw);`);
        lines.push(`  if (tagVal >= 0 && tagVal < ${cap}) {`);
        lines.push(`    atomicAdd(&reductions[${e.slotOffset}u + u32(tagVal)], 1u);`);
        lines.push(`  }`);
      }
    }
    lines.push(`}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

/** Decode the reductions buffer (a Uint32Array) into the {indicatorId →
 *  number | Record<category, number>} shape that linkedResults expects. */
export function decodeReductions(plan: ReductionPlan, raw: Uint32Array): Record<string, number | Record<string, number>> {
  const out: Record<string, number | Record<string, number>> = {};
  for (const e of plan.entries) {
    if (e.aggregation === 'total') {
      // Bit-reinterpret as i32 so negative-sums (rare but possible for int
      // attrs that hold negative values) decode correctly.
      const u = raw[e.slotOffset] ?? 0;
      out[e.id] = (u | 0); // u32 → i32
    } else if (e.aggregation === 'frequency') {
      if (e.attrType === 'bool') {
        out[e.id] = {
          'false': raw[e.slotOffset] ?? 0,
          'true': raw[e.slotOffset + 1] ?? 0,
        };
      } else { // tag
        const opts = e.tagOptions || [];
        const freq: Record<string, number> = {};
        for (let i = 0; i < e.slotCount; i++) {
          const name = opts[i];
          if (name !== undefined) freq[name] = raw[e.slotOffset + i] ?? 0;
        }
        out[e.id] = freq;
      }
    }
  }
  return out;
}

/** Set of indicator ids that are handled by the GPU plan. Useful for the
 *  worker to suppress the corresponding entries when computing linked
 *  results from CPU-side readback (so we don't double-count). */
export function gpuHandledIds(plan: ReductionPlan): Set<string> {
  const s = new Set<string>();
  for (const e of plan.entries) s.add(e.id);
  return s;
}

/** Set of attr ids that, after GPU reduction, no longer need to be readback
 *  to CPU. (An attr is needed on CPU only if some watched-linked indicator
 *  on it was NOT covered by the GPU plan.) The worker uses this to shrink
 *  the watched-attrs readback in finalizeStepWebGPU. */
export function gpuHandledAttrIds(plan: ReductionPlan, allWatched: LinkedDef[]): Set<string> {
  const handledByGpu = new Set<string>();
  for (const e of plan.entries) handledByGpu.add(e.id);
  // For each watched indicator, an attr is "still needed on CPU" if any
  // watched indicator on it isn't GPU-handled.
  const needsCpu = new Set<string>();
  for (const d of allWatched) {
    if (!d.watched || !d.attrId) continue;
    if (!handledByGpu.has(d.id)) needsCpu.add(d.attrId);
  }
  // Attrs the GPU handles AND aren't needed on CPU.
  const gpuHandled = new Set<string>();
  for (const e of plan.entries) {
    if (!needsCpu.has(e.attrId)) gpuHandled.add(e.attrId);
  }
  return gpuHandled;
}

// Used only by the unit-test harness; keeping unused-symbol guard quiet.
export type { WebGPULayoutAttr };
