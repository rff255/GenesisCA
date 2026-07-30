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

export type BondRequestVerb = 'form' | 'break' | 'rewire' | 'between';

/** Emit one queue append. `inputs` are the node's resolved value inputs. */
export function emitBondRequestJS(
  verb: BondRequestVerb,
  inputs: Record<string, string>,
  ctx?: CompileContext,
): string {
  const slots = Math.max(1, Math.floor(ctx?.bondReqSlots ?? 1));
  const depth = slots - 1;
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
  } else if (verb === 'between') {
    // P4b — FORM BETWEEN two OTHER agents. The op kind rides the SIGN of the break
    // lane (see bondRequestQueue.ts): NEGATIVE ⇒ "bond A to B", where a Rewire's
    // POSITIVE break lane means "break self↔from". Zero new fields, so no baked
    // offset moves. Both ids must resolve or the entry is an explicit no-op —
    // still written as (−NONE, NONE) so it stays non-zero and cannot truncate.
    L.push(`  const _bqA = (${inputs['agentA'] || '-1'}) | 0;`);
    L.push(`  const _bqB = (${inputs['agentB'] || '-1'}) | 0;`);
    L.push(`  const _bqOk = _bqA >= 0 && _bqB >= 0;`);
    L.push(`  _bondBreakReq[_bq] = _bqOk ? -(_bqA + ${BOND_REQ_ID_BIAS}) : ${-BOND_REQ_NONE};`);
    L.push(`  _bondFormReq[_bq] = _bqOk ? _bqB + ${BOND_REQ_ID_BIAS} : ${BOND_REQ_NONE};`);
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
  if (verb !== 'break') {
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
