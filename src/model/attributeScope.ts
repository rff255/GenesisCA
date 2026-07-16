/** Generic Agent Platform — the single source of truth for "which attributes
 *  drive which compiled channel". EVERY consumer (the compiler's param builders,
 *  the worker's arg builders, the agent SoA spec, the panel UI) routes through
 *  these helpers so the two ends of each ABI-mirror pair derive the IDENTICAL
 *  ordered list and cannot drift in ORDER (the runtime arity-desync guard catches
 *  COUNT drift, never an order swap of two same-typed lists). NEVER inline a
 *  `filter(!isModelAttribute)` at a D-IDX / field-bridge site — call a helper.
 *
 *  Two disjoint id-spaces:
 *    - CELL attributes  → `model.attributes` (filter !isModelAttribute). The
 *      lattice CA state AND the agent↔grid field (the environment agents sense /
 *      deposit into). `cellAttrsOf` is byte-identical to the historical
 *      `filter(a => !a.isModelAttribute)`, so a no-agent model compiles unchanged.
 *    - AGENT attributes → `model.agentAttributes`. Agent-only per-agent state.
 *
 *  Because the sets are disjoint, the param prefixes name physically distinct
 *  buffers: `r_<id>`/`w_<id>` (the agent SoA, keyed by agentAttrsOf) and
 *  `_field_<id>` (the cell read buffer, keyed by cellFieldAttrsOf) never alias
 *  even on a coincidental id-string clash. */

import type { Attribute, CAModel } from './types';

/** Cell attributes — the lattice CA state + the field substrate. Byte-identical
 *  to the historical `model.attributes.filter(a => !a.isModelAttribute)`. */
export function cellAttrsOf(model: CAModel): Attribute[] {
  return model.attributes.filter(a => !a.isModelAttribute);
}

/** Agent attributes — agent-only per-agent state (the agent SoA). Empty list
 *  when the model has none (every legacy / non-agent model). */
export function agentAttrsOf(model: CAModel): Attribute[] {
  return model.agentAttributes ?? [];
}

/** Cell attributes agents may READ via the field bridge (Sample Field / Field
 *  Gradient / Read Cells Under). Drives the `_field_<id>` channel — threaded only
 *  for these, so the agent loop signature is trimmed to the accessible set. */
export function cellFieldAttrsOf(model: CAModel): Attribute[] {
  return cellAttrsOf(model).filter(a => a.agentAccess === 'read' || a.agentAccess === 'readWrite');
}

/** Cell attributes agents may WRITE via the field bridge (Affect Cells Under /
 *  Secrete To Field). A subset of `cellFieldAttrsOf` (readWrite ⊆ read|readWrite),
 *  so a writable attr always has a `_field_` slot. */
export function cellFieldWriteAttrsOf(model: CAModel): Attribute[] {
  return cellAttrsOf(model).filter(a => a.agentAccess === 'readWrite');
}

/** The scalar SLOT KEYS a MODEL attribute occupies in the `modelAttrs` channel.
 *
 *  A `color` model attribute has no single numeric value, so it expands into one
 *  scalar slot per channel: `id_r`, `id_g`, `id_b`, `id_a`. Everything else is a
 *  single slot named by the bare id.
 *
 *  ── Why this helper exists (the ABI-mirror rule at the top of this file) ──────
 *  This expansion was inlined at SIX sites that must agree exactly or the baked
 *  offsets desync — and a desync does NOT crash, it silently shifts every
 *  subsequent attribute's offset in one target but not another, so the model runs
 *  and renders plausible garbage. The sites:
 *
 *    1. sim.worker.ts        — cachedModelAttrs writer
 *    2. SimulatorView.tsx    — the `init` message writer
 *    3. wasm/layout.ts       — f64 slot per key
 *    4. webgpu/layout.ts     — f32 slot per key
 *    5. agentWasm/compile.ts — modelAttrKeysOf
 *    6. agentWebgpu/compile  — agentWebGPUExtrasOf
 *
 *  The copy loops that populate those regions are key-driven
 *  (`Object.keys(modelAttrOffset)` → `cachedModelAttrs[key]`), so they inherit any
 *  slot this helper adds for free.
 *
 *  ── SCOPE: this owns the colour expansion ONLY ───────────────────────────────
 *  It deliberately does NOT filter `lookupTable`. The six sites diverge on that
 *  today — the two layouts include it (reserving a slot nothing ever reads),
 *  while SimulatorView and agentWasm skip it. That divergence is pre-existing and
 *  benign, but unifying it here would REMOVE a reserved slot from the layouts and
 *  shift every later attribute's offset on any model with a lookupTable model
 *  attribute (Chromatography, Accretor, Golly). Each caller keeps its own filter;
 *  this helper answers only "what slots does THIS attribute occupy".
 *
 *  Structurally typed (`{id, type}`) so the compiler-side `AttrDef` shape can call
 *  it without importing the full `Attribute`. */
export function modelAttrSlotKeys(attr: { id: string; type: string }): string[] {
  return attr.type === 'color'
    ? [attr.id + '_r', attr.id + '_g', attr.id + '_b', attr.id + '_a']
    : [attr.id];
}
