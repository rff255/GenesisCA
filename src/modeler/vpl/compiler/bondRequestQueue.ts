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
// so ONE entry expresses all three self-relative verbs and `rewireBond` is ATOMIC
// by construction (break + form are one entry, applied together or not at all —
// invariant I5), rather than two queued ops that could half-apply.
//
// THE +2 ENCODING is what lets the drain stop at the first empty slot: every
// emitted op writes a NON-ZERO value into BOTH lanes (the unused side writes 1),
// so `0` unambiguously means "no op was ever written here". Without it a Form
// Bond whose target resolved to -1 would write 0 and truncate the queue,
// silently dropping every LATER op the agent issued this step.
//
// ─────────────────────────────────────────────────────────────────────────────
// P4b — FORM BETWEEN, and why its op kind rides the SIGN of the break lane.
//
// A Form Bond with its `agentA` port WIRED bonds two agents named by id, so it
// needs TWO agent ids in one entry — which is exactly what a REWIRE already uses
// both lanes for. The two op kinds therefore collide and must be disambiguated.
// (This encoding shipped with a dedicated `formBondBetween` NODE, since retired
// into Form Bond — see `formBondBetweenMigration.ts`. Only the second spelling
// went away; the encoding and the engine's drain arm are unchanged.)
//
// A new "op kind" lane was rejected: `bondFormReq`/`bondBreakReq` sit MID-LIST in
// `AGENT_I32_FIELDS` (and `AGENT_GPU_F32_FIELDS`), so any additional field shifts
// every later baked offset and diffs every agent model's WASM bytes / WGSL shader
// (the constraint P5 hit and documented). Instead the kind rides the SIGN of the
// break lane, which costs ZERO new fields and therefore moves ZERO offsets:
//
//   verb              bondBreakReq            bondFormReq
//   ───────────────── ─────────────────────── ────────────────────────
//   Form(self→t)      NONE  (+1)              t+2   | NONE
//   Break(self,t)     t+2   | NONE            NONE  (+1)
//   Rewire(from→to)   from+2 | NONE  (>0)     to+2  | NONE   (>0)
//   FormBetween(a,b)  −(a+2) | −NONE  (<0)    b+2   | NONE   (>0)
//   Transfer(b,→to)   b+2   | NONE   (>0)     −(to+2) | −NONE (<0)
//
// A NEGATIVE break lane means "this entry is a Form Between"; its magnitude decodes
// with the same `+2` bias. Every lane is signed on every target (`bondFormReq` /
// `bondBreakReq` are `AGENT_I32_FIELDS` ⇒ Int32Array on the CPU, i32 in the WASM
// layout, and an f32 run on the GPU), so nothing is truncated or wrapped.
//
// The "never write 0" rule survives: an unresolvable Form Between writes `−NONE`
// (−1) and `NONE` (+1), which is still non-zero on both lanes — so it cannot
// truncate the queue — and decodes to a<0 / b<0, i.e. an explicit no-op entry.
// The drain's terminator test (`bl === 0 && fl === 0`) is untouched.
//
// ─────────────────────────────────────────────────────────────────────────────
// TRANSFER — the third-party IN-PLACE rewire, on the mirror-image sign.
//
// `transferBond(b, me → to)` hands the requesting agent's edge with `b` over to
// `to`, rewriting `b`'s slot IN PLACE so `b`'s ordering is preserved (znah's
// `node[node.indexOf(i)] = j`). Rewire is break+form at the REQUESTER, which
// scrambles the receiver's slot order — the one remaining structural difference
// the `Growing Graphs` port had against its reference.
//
// It needs the same two ids Form Between does, so it needs its own marker, and
// the break lane's sign is taken. The FORM lane's sign is still free (a Form,
// Break, Rewire or Form Between never writes it negative), so
// **`fl < 0` ⇒ TRANSFER**: `bl = b + 2` (the third party) and `fl = −(to + 2)`;
// the requester is implicit. Zero new fields, zero moved offsets, and the queue
// stride / ABI / layouts are untouched — the same argument P4b made.
//
// ⚠️ DECODE ORDER IS LOAD-BEARING. The `fl < 0` branch must sit immediately after
// the existing `bl < 0` branch. Fall through and `to = fl − 2` goes negative,
// the entry lands in the plain-BREAK arm with `from = b`, and the transfer
// silently degrades to a bare Break — an edge vanishes with no error anywhere.
//
// An unresolvable transfer writes `NONE` (+1) / `−NONE` (−1): still non-zero on
// both lanes (so it cannot truncate), still `fl < 0` (so it decodes as a
// TRANSFER, not as a bare Break of `b`), and both ids decode to −1 ⇒ a no-op.
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
  'formBond', 'breakBond', 'rewireBond', 'transferBond',
]);

/** Lane value meaning "this side of the entry is unused" (a plain Form has no
 *  break side; a plain Break has no form side). Distinct from 0 = empty slot. */
export const BOND_REQ_NONE = 1;
/** Lane encoding for an agent id: `v + BOND_REQ_ID_BIAS`. */
export const BOND_REQ_ID_BIAS = 2;
/** P4b — the op-kind marker for FORM BETWEEN: the break lane is NEGATED (see the
 *  encoding table in this file's header). A negative break lane is the ONLY thing
 *  that distinguishes a Form Between from a Rewire, since both fill both lanes. */
export const BOND_REQ_BETWEEN_SIGN = -1;
/** The op-kind marker for TRANSFER: the FORM lane is NEGATED (the mirror image of
 *  Form Between's negated break lane — see the encoding table above). A negative
 *  form lane is the ONLY thing distinguishing a Transfer from a Rewire. */
export const BOND_REQ_TRANSFER_SIGN = -1;

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
