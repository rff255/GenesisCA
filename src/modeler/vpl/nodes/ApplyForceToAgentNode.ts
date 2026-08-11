import type { NodeTypeDef } from '../types';
import { agentRootHasSelf } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Apply Force To Agent — add a force vector to ANOTHER agent by id (Bond-Graph
 *  Agents). The cross-agent counterpart to Apply Force (which adds to THIS agent).
 *  Unlike the by-id OVERWRITE writers (Set Agent Attribute / Position / Radius),
 *  this is a COMMUTATIVE accumulate (`force[target] += f`) onto the per-step-zeroed
 *  force buffer that the integrator consumes AFTER the whole behaviour pass — so it
 *  is race-free in BOTH sync and async agent modes (order doesn't matter for a sum,
 *  and it doesn't collide with the target's own Apply Force). This is the physically
 *  correct way to author inter-agent forces: Newton's 3rd law (push B, feel −B),
 *  custom pairwise / Coulomb laws, springs you code yourself, action-at-a-distance.
 *
 *  Feed a target id from Get Nearby Agents / For Each Bond / Get Self Handle / Pick
 *  Random Agent. The id is range+alive guarded. Needs Motion = Force (like Apply
 *  Force). `Force Z` exists only in a 3D-agent model (hidden in 2D). */
export const ApplyForceToAgentNode: NodeTypeDef = {
  type: 'applyForceToAgent',
  label: 'Apply Force To Agent',
  agentLabel: 'Apply Force (by ID)',
  description: 'Add a force vector to another agent by id (commutative — safe in both update modes). Newton\'s 3rd law, custom pairwise forces.',
  category: 'output',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'fx', label: 'Force X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'fy', label: 'Force Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'fz', label: 'Force Z', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['fz']),
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) => {
    const id = `((${inputs['agentId'] || '-1'}) | 0)`;
    // Live-agent guard (behaviour + division). In the Init Event `highWater`/`_alive`
    // aren't in scope (a force written in init is zeroed before the first step anyway),
    // so range-only there — mirrors the by-id setters.
    const guard = !agentRootHasSelf(ctx?.agentRoot)
      ? `__af >= 0 && __af < _agentMaxAgents`
      : `__af >= 0 && __af < highWater && _alive[__af]`;
    const z = ctx?.is3d ? ` _agentForceZ[__af] += ${inputs['fz'] || '0'};` : '';
    return `{ const __af = ${id}; if (${guard}) { _agentForceX[__af] += ${inputs['fx'] || '0'}; _agentForceY[__af] += ${inputs['fy'] || '0'};${z} } }\n`;
  },
};
