import type { NodeTypeDef } from '../types';
import { agentRootHasSelf } from '../types';

/** Kill Agent — request that an agent die (Bond-Graph Agents). Applied in the
 *  post-step structural phase: the slot is recycled to the free-list, ALL its
 *  bonds (both directions) are broken, and its slot epoch is bumped so any stale
 *  bond pointing at the recycled slot is swept (the dangling-bond ABI). Use it
 *  for apoptosis / necrosis (e.g. a hypoxic agent dies) — or, with the `Agent`
 *  input wired, for PREDATION ("consume" a neighbour).
 *
 *  TARGETING — the standard optional-id convention: `Agent` unwired = SELF
 *  (byte-identical to the historical self-only node), wired = that agent by id
 *  (feed Get Nearby Agents / For Each Bond / Pick Random Agent / Get Self Handle).
 *
 *  WHY A WIRED KILL NEEDS NO SYNC-MODE GATE (unlike the by-id OVERWRITE setters):
 *  a kill is a FLAG SET TO A CONSTANT — `killRequest[target] = 1` — consumed once
 *  by the CPU structural phase at the end of the step. Setting the same value is
 *  IDEMPOTENT and ORDER-INDEPENDENT, so N agents all electing to kill the same
 *  target produce exactly the same result in any order, and it cannot collide
 *  with that target's own self-update (which never writes killRequest to 0). That
 *  is the same commutativity argument that exempts Apply Force To Agent's `+=`
 *  accumulate — so this node is deliberately NOT in `CROSS_AGENT_OVERWRITE`
 *  (compile.ts' synchronous-mode gate) and NOT in the WebGPU agent gate's
 *  wired-non-spawn reject set. On WebGPU the flag store is a plain non-atomic
 *  write of 1.0 into another slot's `killRequest` run: a benign race, because
 *  every racing writer writes the identical value.
 *
 *  The id is RANGE-guarded (`[0, maxAgents)`), matching every other by-id writer;
 *  the structural phase separately gates on `alive`, so flagging a dead or unborn
 *  slot is a no-op (and a recycled slot is cleared by `initAgentSlot`). */
export const KillAgentNode: NodeTypeDef = {
  type: 'killAgent',
  label: 'Kill Agent',
  description: 'Request that an agent die — recycled + all bonds broken (applied after the step). Agent empty = self, else that agent by id (predation).',
  category: 'output',
  color: '#ad1457',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) => {
    // WIREDNESS decides the emit, and it is read from the resolved input map
    // BEFORE anything is minted — the Form Bond `agentA` discipline. Unwired ⇒
    // the historical single statement, byte-for-byte — EXCEPT in a root with no
    // self (`init` / `spawner`), where `idx` does not exist: a no-op beats a
    // reference that throws (`nodeValidation` badges the placement).
    if (!inputs['agentId']) return agentRootHasSelf(ctx?.agentRoot) ? `_killRequest[idx] = 1;\n` : '';
    const id = `((${inputs['agentId']}) | 0)`;
    return `{ const __ka = ${id}; if (__ka >= 0 && __ka < _agentMaxAgents) _killRequest[__ka] = 1; }\n`;
  },
};
