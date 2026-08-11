import type { NodeTypeDef } from '../types';
import { agentRootHasSelf, agentRootRelaxesGuard } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Set Velocity — set an agent's velocity directly (Generic Agent Platform).
 *  The momentum companion to Apply Force: it seeds the integration velocity
 *  `_agentVX/VY[id]` rather than accumulating a force. Integration-safe (NOT a
 *  teleport — positions still come from the engine integrator).
 *
 *  TARGETING — the standard optional-id convention, mirroring Get Velocity:
 *  `Agent` unwired = SELF (byte-identical to the historical self-only node),
 *  wired = that agent by id (feed Get Nearby Agents / For Each Bond / Pick
 *  Random Agent) — e.g. a knock-back that sets a neighbour's velocity outright.
 *
 *  A WIRED Set Velocity IS a cross-agent OVERWRITE (the last writer wins, so the
 *  outcome depends on the order agents run in), which puts it in exactly the same
 *  machinery as Set Agent Attribute / Position / Radius: rejected at compile time
 *  in SYNCHRONOUS agent mode (it would race the target's own self-update), and
 *  rejected by the WebGPU agent gate when the id is wired to anything but a
 *  Create Agent handle (parallel threads have no defined write order) — so such a
 *  model runs on the sequential JS / WASM targets. For an ORDER-INDEPENDENT way
 *  to influence another agent's motion use Apply Force To Agent (a commutative
 *  `+=` accumulate), which is safe in both modes on every target.
 *
 *  NOTE: only meaningful when the model's Momentum is > 0. Under the default
 *  overdamped mode (momentum 0) the integrator recomputes velocity from the
 *  force each step, so a Set Velocity write is overwritten — use Apply Force
 *  there instead. The `Vz` input exists only in a 3D-agent model (hidden in 2D). */
export const SetVelocityNode: NodeTypeDef = {
  type: 'setVelocity',
  label: 'Set Velocity',
  description: "Sets an agent's velocity directly — Agent empty = self, else that agent by id (needs Momentum > 0; the momentum companion to Apply Force).",
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'vx', label: 'Vx', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'vy', label: 'Vy', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'vz', label: 'Vz', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['vz']),
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) => {
    // Unwired ⇒ the historical self-write, byte-for-byte — EXCEPT in a root with
    // no self (`init` / `spawner`), where `idx` does not exist: degrade to a
    // no-op rather than emit a reference that throws at run time (the Set Agent
    // Sprite precedent; `nodeValidation` badges the placement).
    if (!inputs['agentId']) {
      if (!agentRootHasSelf(ctx?.agentRoot)) return '';
      const z = ctx?.is3d ? ` _agentVZ[idx] = ${inputs['vz'] || '0'};` : '';
      return `_agentVX[idx] = ${inputs['vx'] || '0'}; _agentVY[idx] = ${inputs['vy'] || '0'};${z}\n`;
    }
    const id = `((${inputs['agentId']}) | 0)`;
    // Same guard arms as the other by-id setters: unified spawning stages a
    // Created agent at alive=0 until Add To World in BOTH Init and Behaviour, so
    // the guard relaxes to range-only there; elsewhere it requires a live agent.
    const guard = agentRootRelaxesGuard(ctx?.agentRoot)
      ? `__sv >= 0 && __sv < _agentMaxAgents`
      : `__sv >= 0 && __sv < highWater && _alive[__sv]`;
    // A wired Set Velocity IS valid in the Agent Init Event (seed a newborn's
    // velocity on its Create Agent handle — `_agentVX/VY` + `_agentMaxAgents` are
    // all in the init ABI). `_agentVZ` is NOT: per deriveAgentAbi the init kind's
    // 3D block carries only `_agentZ`. So drop the z half there rather than emit an
    // undefined symbol — the C9 "no param ⇒ no write" safety-catch shape. The
    // SPAWNER kind shares the init 3D block (only `_agentZ`), so the same drop
    // applies there — `agentRootHasSelf` is exactly that pair.
    const zWrite = (ctx?.is3d && agentRootHasSelf(ctx?.agentRoot)) ? ` _agentVZ[__sv] = ${inputs['vz'] || '0'};` : '';
    return `{ const __sv = ${id}; if (${guard}) { _agentVX[__sv] = ${inputs['vx'] || '0'}; _agentVY[__sv] = ${inputs['vy'] || '0'};${zWrite} } }\n`;
  },
};
