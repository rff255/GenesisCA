// Graph-Rewriting Automata (P4) — the JS emit for the three structural-request
// verbs (Form / Break / Rewire Bond). ONE emitter so the three nodes cannot drift
// in slot addressing, lane encoding or overflow handling; the WASM and WebGPU
// emitters mirror it (`agentWasm/compile.ts`, `agentWebgpu/compile.ts`).
//
// Every verb APPENDS one entry to the agent's queue:
//   • the cursor `_brqC` is a per-agent-iteration local (declared in the loop
//     preamble ONLY when the graph uses a verb — that usage gate is what keeps a
//     model without one byte-identical);
//   • it is bumped even when the queue is full, so the op lands in the overflow
//     bucket (entry `D`) whose occupancy IS the overflow flag the drain reports.
// See bondRequestQueue.ts for the entry encoding and why the "+2" bias matters.

import type { CompileContext } from '../types';
import { BOND_REQ_ID_BIAS, BOND_REQ_NONE } from './bondRequestQueue';

export type BondRequestVerb = 'form' | 'break' | 'rewire' | 'between' | 'transfer';

/** Form Bond's optional FIRST-agent port. Unwired ⇒ the historical self→target
 *  form; wired ⇒ the op LOWERS to the Form Between encoding (see `pairWired`). */
export const FORM_BOND_PAIR_PORT = 'agentA';

/** Is Form Bond's optional `agentA` port WIRED?
 *
 *  ⚠️ THE PORT MUST NOT CARRY AN INLINE WIDGET. `inputs[portId]` is set by the JS
 *  compiler from exactly two sources — the edge map (`inputToSource`) and
 *  `getInlineValue`, which returns undefined for a port with no `inlineWidget`.
 *  So for a widget-less port this test IS the edge-map test (which is what the
 *  WASM/WebGPU mirrors read directly). Give `agentA` a widget and an UNWIRED node
 *  would start reading as wired here — and diverge from the other two targets. */
export function formBondPairWiredJS(verb: BondRequestVerb, inputs: Record<string, string>): boolean {
  return verb === 'form' && inputs[FORM_BOND_PAIR_PORT] !== undefined;
}

/** Emit one queue append. `inputs` are the node's resolved value inputs. */
export function emitBondRequestJS(
  verb: BondRequestVerb,
  inputs: Record<string, string>,
  ctx?: CompileContext,
): string {
  const slots = Math.max(1, Math.floor(ctx?.bondReqSlots ?? 1));
  const depth = slots - 1;
  // Form Bond with a WIRED `agentA` IS a Form Between — the same two-id op, so it
  // takes the identical encoding rather than a second one. Unwired keeps the
  // historical `form` arm verbatim, which is what preserves byte identity.
  const pairWired = formBondPairWiredJS(verb, inputs);
  const bPort = verb === 'between' ? 'agentB' : 'targetAgent';
  const L: string[] = ['{'];
  // Append at the cursor, clamped to the overflow bucket; the cursor always bumps
  // so a later op cannot silently reuse a full queue's last real entry.
  L.push(`  const _bq = idx * ${slots} + (_brqC < ${depth} ? _brqC : ${depth}); _brqC++;`);
  if (verb === 'rewire') {
    // BOTH sides must resolve or the entry is an explicit no-op — a rewire whose
    // `From` is unresolvable must NOT degrade into a bare Form (that would RAISE
    // the agent's degree, the exact thing a degree-preserving rule forbids).
    L.push(`  const _bqF = (${inputs['fromAgent'] || '-1'}) | 0;`);
    L.push(`  const _bqT = (${inputs['toAgent'] || '-1'}) | 0;`);
    L.push(`  const _bqOk = _bqF >= 0 && _bqT >= 0;`);
    L.push(`  _bondBreakReq[_bq] = _bqOk ? _bqF + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE};`);
    L.push(`  _bondFormReq[_bq] = _bqOk ? _bqT + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE};`);
  } else if (verb === 'between' || pairWired) {
    // P4b — FORM BETWEEN two OTHER agents. The op kind rides the SIGN of the break
    // lane (see bondRequestQueue.ts): NEGATIVE ⇒ "bond A to B", where a Rewire's
    // POSITIVE break lane means "break self↔from". Zero new fields, so no baked
    // offset moves. Both ids must resolve or the entry is an explicit no-op —
    // still written as (−NONE, NONE) so it stays non-zero and cannot truncate.
    //
    // A Form Bond with a WIRED `agentA` lands here too: "bond A to my Target" is
    // the same two-id op, so it reuses this encoding instead of inventing a
    // second one. Wiring Get Self Handle → Agent A therefore produces the SAME
    // bond as leaving it unwired — the drain's Form Between arm calls the very
    // same `formBond(a, b, …)`, and its extra `alive[a] && a < hw` checks are
    // trivially true when `a` IS the requester (the drain already skipped dead
    // agents and `i < hw` by the loop bound).
    L.push(`  const _bqA = (${inputs['agentA'] || '-1'}) | 0;`);
    L.push(`  const _bqB = (${inputs[bPort] || '-1'}) | 0;`);
    L.push(`  const _bqOk = _bqA >= 0 && _bqB >= 0;`);
    L.push(`  _bondBreakReq[_bq] = _bqOk ? -(_bqA + ${BOND_REQ_ID_BIAS}) : ${-BOND_REQ_NONE};`);
    L.push(`  _bondFormReq[_bq] = _bqOk ? _bqB + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE};`);
  } else if (verb === 'transfer') {
    // B9 — TRANSFER: the mirror image of Form Between's marker. The op kind rides
    // the SIGN of the FORM lane (negative), which no other verb ever writes, so it
    // again costs no new field and moves no baked offset. Both ids must resolve or
    // the entry is an explicit no-op — still (NONE, −NONE) so it stays non-zero
    // AND still decodes as a transfer rather than falling into the break arm.
    L.push(`  const _bqP = (${inputs['partnerAgent'] || '-1'}) | 0;`);
    L.push(`  const _bqT = (${inputs['toAgent'] || '-1'}) | 0;`);
    L.push(`  const _bqOk = _bqP >= 0 && _bqT >= 0;`);
    L.push(`  _bondBreakReq[_bq] = _bqOk ? _bqP + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE};`);
    L.push(`  _bondFormReq[_bq] = _bqOk ? -(_bqT + ${BOND_REQ_ID_BIAS}) : ${-BOND_REQ_NONE};`);
  } else {
    const port = 'targetAgent';
    L.push(`  const _bqT = (${inputs[port] || '-1'}) | 0;`);
    const lane = `_bqT >= 0 ? _bqT + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE}`;
    // The unused side writes BOND_REQ_NONE (1), never 0 — 0 is the drain's
    // "no entry was ever appended here" terminator, so writing it would truncate
    // the queue and silently drop every LATER op this agent issued.
    if (verb === 'form') {
      L.push(`  _bondBreakReq[_bq] = ${BOND_REQ_NONE};`);
      L.push(`  _bondFormReq[_bq] = ${lane};`);
    } else {
      L.push(`  _bondBreakReq[_bq] = ${lane};`);
      L.push(`  _bondFormReq[_bq] = ${BOND_REQ_NONE};`);
    }
  }
  // Break has no form half; TRANSFER re-points an EXISTING edge and keeps its
  // values (read off the partner's slot at drain time), so neither writes the
  // form-half parameter cells — and the drain never reads them for either.
  if (verb !== 'break' && verb !== 'transfer') {
    // The FORM half's parameters (0 ⇒ the engine defaults: contact distance / λ).
    L.push(`  _bondFormL[_bq] = ${inputs['restLength'] || '0'};`);
    L.push(`  _bondFormK[_bq] = ${inputs['stiffness'] || '0'};`);
    // P2 — the new bond's INITIAL attribute values, one dynamic input port per
    // declared bond attribute. Per ENTRY, so queued forms don't smear values.
    for (const a of ctx?.bondAttrs ?? []) {
      L.push(`  _bondFormAttr_${a.id}[_bq] = ${inputs[`bondAttr_${a.id}`] ?? String(a.defaultValue)};`);
    }
  }
  L.push('}');
  return L.join('\n') + '\n';
}
