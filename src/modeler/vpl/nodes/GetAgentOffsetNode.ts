import type { NodeTypeDef } from '../types';

/** Get Agent Offset — the torus-SHORTEST displacement (dX, dY) from THIS agent
 *  to a target agent by id, plus Distance (Bond-Graph Agents). Use this — NOT
 *  raw position subtraction — for cohesion / separation / "steer toward
 *  neighbour" math so it stays correct across a torus seam. Mirrors the engine's
 *  wrap (reads `_fieldW`/`_fieldH`/`_fieldBoundaryTorus`, which ride the agent
 *  loop signature). dX = target − self (points TOWARD the target), matching the
 *  engine's attractive-force sign (force `+k·dx`). Multi-output (`_v<id>_<port>`). */
export const GetAgentOffsetNode: NodeTypeDef = {
  type: 'getAgentOffset',
  label: 'Get Agent Offset',
  description: 'Torus-shortest (dX, dY) and Distance from this agent to a target — for wrap-correct neighbour vectors.',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId',  label: 'Agent',    kind: 'input',  category: 'value', dataType: 'integer' },
    { id: 'dx',       label: 'dX',       kind: 'output', category: 'value', dataType: 'float' },
    { id: 'dy',       label: 'dY',       kind: 'output', category: 'value', dataType: 'float' },
    { id: 'distance', label: 'Distance', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const a = `((${inputs['agentId'] || '0'}) | 0)`;
    const V = `_v${nodeId}`;
    return `const __go${nodeId}=${a};`
      + `let __odx${nodeId}=_agentX[__go${nodeId}]-_agentX[idx],__ody${nodeId}=_agentY[__go${nodeId}]-_agentY[idx];`
      + `if(_fieldBoundaryTorus){const __W=_fieldW,__H=_fieldH,__hW=__W/2,__hH=__H/2;`
      + `if(__odx${nodeId}>__hW)__odx${nodeId}-=__W;else if(__odx${nodeId}<-__hW)__odx${nodeId}+=__W;`
      + `if(__ody${nodeId}>__hH)__ody${nodeId}-=__H;else if(__ody${nodeId}<-__hH)__ody${nodeId}+=__H;}`
      + `const ${V}_dx=__odx${nodeId},${V}_dy=__ody${nodeId},${V}_distance=Math.hypot(__odx${nodeId},__ody${nodeId});\n`;
  },
};
