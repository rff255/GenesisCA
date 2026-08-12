// Graph-Rewriting Automata (P4) — the JS emit for the structural-request verbs
// (Form / Break / Rewire / Transfer Bond, plus the two-id ops Form Bond and Break
// Bond lower to when their `agentA` port is wired). ONE emitter so the nodes
// cannot drift in slot addressing, lane encoding or overflow handling; the WASM
// and WebGPU emitters mirror it (`agentWasm/compile.ts`, `agentWebgpu/compile.ts`).
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

/** The NODE verbs. `between` is deliberately NOT one: the Form Bond Between node
 *  was retired (see `formBondBetweenMigration.ts`) — "bond A to B" is now Form
 *  Bond with its `agentA` port wired, which LOWERS to the between ENCODING. That
 *  encoding is very much alive; only the second spelling of it is gone. */
export type BondRequestVerb = 'form' | 'break' | 'rewire' | 'transfer';
/** A verb plus the lowered op kinds the emitters actually branch on. */
export type BondRequestOp = BondRequestVerb | 'between' | 'breakBetween';

/** Form Bond's and Break Bond's optional FIRST-agent port. Unwired ⇒ the
 *  historical self-anchored op; wired ⇒ the op LOWERS to its two-id encoding
 *  (Form Between / Break Between — see `pairWired`). The two nodes share the port
 *  id + label deliberately: it is the same question ("which agent is the first
 *  endpoint?") with the same default. */
export const FORM_BOND_PAIR_PORT = 'agentA';

/** The verbs whose optional `agentA` port lowers them to a two-id op. */
const PAIR_PORT_VERBS: ReadonlySet<BondRequestVerb> = new Set(['form', 'break']);

/** Is this node's optional `agentA` port WIRED?
 *
 *  ⚠️ THE PORT MUST NOT CARRY AN INLINE WIDGET. `inputs[portId]` is set by the JS
 *  compiler from exactly two sources — the edge map (`inputToSource`) and
 *  `getInlineValue`, which returns undefined for a port with no `inlineWidget`.
 *  So for a widget-less port this test IS the edge-map test (which is what the
 *  WASM/WebGPU mirrors read directly). Give `agentA` a widget and an UNWIRED node
 *  would start reading as wired here — and diverge from the other two targets. */
export function formBondPairWiredJS(verb: BondRequestVerb, inputs: Record<string, string>): boolean {
  return PAIR_PORT_VERBS.has(verb) && inputs[FORM_BOND_PAIR_PORT] !== undefined;
}

/** Emit one queue append. `inputs` are the node's resolved value inputs. */
export function emitBondRequestJS(
  verb: BondRequestVerb,
  inputs: Record<string, string>,
  ctx?: CompileContext,
): string {
  const slots = Math.max(1, Math.floor(ctx?.bondReqSlots ?? 1));
  const depth = slots - 1;
  // A Form or Break Bond with a WIRED `agentA` is a two-id op, so it takes that
  // verb's two-id encoding. Unwired keeps the historical arm verbatim, which is
  // what preserves byte identity.
  const effVerb: BondRequestOp = formBondPairWiredJS(verb, inputs)
    ? (verb === 'break' ? 'breakBetween' : 'between')
    : verb;
  const L: string[] = ['{'];
  // Append at the cursor, clamped to the overflow bucket; the cursor always bumps
  // so a later op cannot silently reuse a full queue's last real entry.
  L.push(`  const _bq = idx * ${slots} + (_brqC < ${depth} ? _brqC : ${depth}); _brqC++;`);
  if (effVerb === 'rewire') {
    // BOTH sides must resolve or the entry is an explicit no-op — a rewire whose
    // `From` is unresolvable must NOT degrade into a bare Form (that would RAISE
    // the agent's degree, the exact thing a degree-preserving rule forbids).
    L.push(`  const _bqF = (${inputs['fromAgent'] || '-1'}) | 0;`);
    L.push(`  const _bqT = (${inputs['toAgent'] || '-1'}) | 0;`);
    L.push(`  const _bqOk = _bqF >= 0 && _bqT >= 0;`);
    L.push(`  _bondBreakReq[_bq] = _bqOk ? _bqF + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE};`);
    L.push(`  _bondFormReq[_bq] = _bqOk ? _bqT + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE};`);
  } else if (effVerb === 'between') {
    // P4b — FORM BETWEEN two agents named by id. The op kind rides the SIGN of the
    // break lane (see bondRequestQueue.ts): NEGATIVE ⇒ "bond A to B", where a
    // Rewire's POSITIVE break lane means "break self↔from". Zero new fields, so no
    // baked offset moves. Both ids must resolve or the entry is an explicit no-op
    // — still written as (−NONE, NONE) so it stays non-zero and cannot truncate.
    //
    // This is the ONLY authoring path to the encoding since the Form Bond Between
    // node was retired: a Form Bond with a WIRED `agentA` IS "bond A to my
    // Target". Wiring Get Self Handle → Agent A therefore produces the SAME bond
    // as leaving it unwired — the drain's Form Between arm calls the very same
    // `formBond(a, b, …)`, and its extra `alive[a] && a < hw` checks are trivially
    // true when `a` IS the requester (the drain already skipped dead agents and
    // `i < hw` by the loop bound).
    L.push(`  const _bqA = (${inputs['agentA'] || '-1'}) | 0;`);
    L.push(`  const _bqB = (${inputs['targetAgent'] || '-1'}) | 0;`);
    L.push(`  const _bqOk = _bqA >= 0 && _bqB >= 0;`);
    L.push(`  _bondBreakReq[_bq] = _bqOk ? -(_bqA + ${BOND_REQ_ID_BIAS}) : ${-BOND_REQ_NONE};`);
    L.push(`  _bondFormReq[_bq] = _bqOk ? _bqB + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE};`);
  } else if (effVerb === 'breakBetween') {
    // BREAK BETWEEN — sever the bond between two agents named by id, neither of
    // which need be the requester. The op kind rides BOTH lane signs (the one
    // combination Form Between and Transfer left free), so it again costs no new
    // field and moves no baked offset. Both ids must resolve or the entry is an
    // explicit no-op — still written as (−NONE, −NONE) so it stays non-zero AND
    // still decodes as this verb rather than as a Form Between.
    L.push(`  const _bqA = (${inputs['agentA'] || '-1'}) | 0;`);
    L.push(`  const _bqB = (${inputs['targetAgent'] || '-1'}) | 0;`);
    L.push(`  const _bqOk = _bqA >= 0 && _bqB >= 0;`);
    L.push(`  _bondBreakReq[_bq] = _bqOk ? -(_bqA + ${BOND_REQ_ID_BIAS}) : ${-BOND_REQ_NONE};`);
    L.push(`  _bondFormReq[_bq] = _bqOk ? -(_bqB + ${BOND_REQ_ID_BIAS}) : ${-BOND_REQ_NONE};`);
  } else if (effVerb === 'transfer') {
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
    if (effVerb === 'form') {
      L.push(`  _bondBreakReq[_bq] = ${BOND_REQ_NONE};`);
      L.push(`  _bondFormReq[_bq] = ${lane};`);
    } else {
      L.push(`  _bondBreakReq[_bq] = ${lane};`);
      L.push(`  _bondFormReq[_bq] = ${BOND_REQ_NONE};`);
    }
  }
  // Neither Break kind has a form half; TRANSFER re-points an EXISTING edge and
  // keeps its values (read off the partner's slot at drain time), so none of the
  // three writes the form-half parameter cells — and the drain reads them for none.
  if (effVerb !== 'break' && effVerb !== 'breakBetween' && effVerb !== 'transfer') {
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
