import type { NodeTypeDef } from '../types';
import { agentRootHasSelf } from '../types';

/** Get Agent Radius — an agent's radius by id (Bond-Graph Agents). For
 *  size-aware neighbour interactions (e.g. a separation force scaled by the
 *  partner's size). Feed a neighbour id from Get Nearby Agents / For Each Bond.
 *
 *  The `Agent` input is OPTIONAL and its UNWIRED state means SELF (the project
 *  convention — see "Agent action TARGETING" in CLAUDE.md); it used to emit the
 *  −1 sentinel, i.e. a silent read of 0. `Get Radius` remains the dedicated
 *  self reader. */
export const GetAgentRadiusNode: NodeTypeDef = {
  type: 'getAgentRadius',
  label: 'Get Agent Radius',
  agentLabel: 'Get Radius (by ID)',
  description: "An agent's radius — SELF when the Agent input is empty, else a specific agent by id.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId', label: 'Agent (self)', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Radius', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    // Unwired ⇒ SELF (unguarded — `idx` is live by construction); in a selfless
    // root (`init` / `spawner`) there is no `idx`, so degrade to the 0 a failed
    // guard would have produced. See GetAgentAttributeNode for the full rationale.
    if (!inputs['agentId']) {
      if (!agentRootHasSelf(ctx?.agentRoot)) return `const _v${nodeId} = 0;\n`;
      return `const _v${nodeId} = _agentRadius[idx];\n`;
    }
    // A WIRED id is range-guarded: -1 (the empty sentinel) / out-of-range → 0,
    // not a NaN from `_agentRadius[-1]` (WASM would read adjacent memory).
    return `const __gar${nodeId} = ((${inputs['agentId']}) | 0); const _v${nodeId} = (__gar${nodeId} >= 0 && __gar${nodeId} < highWater) ? _agentRadius[__gar${nodeId}] : 0;\n`;
  },
};
