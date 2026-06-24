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
