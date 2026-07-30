// Graph-Rewriting Automata (P4) — the per-agent STRUCTURAL REQUEST QUEUE.
//
// WHY. Form Bond and Break Bond used to write a SINGLE cell per agent, so a
// later call in the same generation silently REPLACED an earlier one. Every
// degree-preserving graph rewrite (triangle split, pair annihilation, edge swap)
// needs 2–5 edge mutations at one node in ONE step; emulating that across
// generations makes the intermediate states violate the very invariant the rule
// preserves — which is why invariant I6 was untestable before this phase.
//
// THE SHAPE (one place, so all four consumers agree — the baked-offset lockstep):
//
//   slots  = D + 1              D = resolveBondRequestDepth(cfg)
//   base   = idx * slots        agent-major, exactly like the ragged bond store
//   slot c ∈ [0, D)             the QUEUE, drained in slot order
//   slot D                      the OVERFLOW BUCKET — written by every op past
//                               the queue, applied by NONE; its occupancy IS the
//                               overflow flag (so the drain needs no cursor array
//                               and the ABI keeps its exact field list).
//
// Per slot the queue reuses the EXISTING request arrays as lanes:
//
//   bondBreakReq[base+c]  the BREAK side   0 = slot empty · 1 = none · v+2 = agent v
//   bondFormReq [base+c]  the FORM side    0 = slot empty · 1 = none · v+2 = agent v
//   bondFormL / bondFormK / bondFormAttr_<id>   the FORM half's parameters
//
// so ONE entry expresses all three verbs and `rewireBond` is ATOMIC by
// construction (break + form are one entry, applied together or not at all —
// invariant I5), rather than two queued ops that could half-apply.
//
// THE +2 ENCODING is what lets the drain stop at the first empty slot: every
// emitted op writes a NON-ZERO value into BOTH lanes (the unused side writes 1),
// so `0` unambiguously means "no op was ever written here". Without it a Form
// Bond whose target resolved to -1 would write 0 and truncate the queue,
// silently dropping every LATER op the agent issued this step.
//
// BYTE IDENTITY. `bondReqSlotsForModel` returns **1** for a model whose agent
// graph contains none of the three verbs, which reproduces the pre-P4 layout
// exactly (arrays sized `maxAgents`, `base = idx`). That is a general USAGE
// property of the model — not a rule-shape test — and is what keeps every
// shipped model's WASM bytes / WGSL shader / JS behaviour byte-identical.

import type { CAModel } from '../../../model/types';
import { resolveBondRequestDepth } from '../../../model/centerBased';

/** The flow nodes that append an entry to the queue. Adding a verb means adding
 *  it HERE (so the layout sizes the queue) and to each target's emitter. */
export const BOND_REQUEST_NODE_TYPES: ReadonlySet<string> = new Set([
  'formBond', 'breakBond', 'rewireBond',
]);

/** Lane value meaning "this side of the entry is unused" (a plain Form has no
 *  break side; a plain Break has no form side). Distinct from 0 = empty slot. */
export const BOND_REQ_NONE = 1;
/** Lane encoding for an agent id: `v + BOND_REQ_ID_BIAS`. */
export const BOND_REQ_ID_BIAS = 2;

/** Does this model's AGENT graph use any queue verb? Scans the top-level agent
 *  graph AND every macro definition's nodes — a macro instance on the agent graph
 *  expands to its internals at compile time, and this runs BEFORE expansion. Over-
 *  counting (a macro def that is never instantiated) only makes the queue bigger,
 *  never wrong; under-counting would silently truncate it, so the scan is
 *  deliberately conservative. */
export function agentGraphUsesBondRequests(model: CAModel | null | undefined): boolean {
  if (!model) return false;
  if (model.topologyMode && model.topologyMode.agents === false) return false;
  for (const n of model.agentGraphNodes ?? []) {
    if (BOND_REQUEST_NODE_TYPES.has(n.data?.nodeType ?? '')) return true;
  }
  for (const def of model.macroDefs ?? []) {
    for (const n of def.nodes ?? []) {
      if (BOND_REQUEST_NODE_TYPES.has(n.data?.nodeType ?? '')) return true;
    }
  }
  return false;
}

/** The queue STRIDE (`D + 1`, including the overflow bucket) this model's agent
 *  store / memory layouts must reserve. **1 when the graph uses no queue verb** —
 *  the pre-P4 shape, so an unrelated model is byte-identical on every target. */
export function bondReqSlotsForModel(model: CAModel | null | undefined): number {
  if (!agentGraphUsesBondRequests(model)) return 1;
  return resolveBondRequestDepth(model?.centerBased) + 1;
}
