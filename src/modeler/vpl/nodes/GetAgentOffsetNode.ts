import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

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
  agentLabel: 'Get Offset (by ID)',
  description: 'Torus-shortest (dX, dY) and Distance from this agent to a target — for wrap-correct neighbour vectors.',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId',  label: 'Agent',    kind: 'input',  category: 'value', dataType: 'integer' },
    { id: 'dx',       label: 'dX',       kind: 'output', category: 'value', dataType: 'float' },
    { id: 'dy',       label: 'dY',       kind: 'output', category: 'value', dataType: 'float' },
    { id: 'dz',       label: 'dZ',       kind: 'output', category: 'value', dataType: 'float' },
    { id: 'distance', label: 'Distance', kind: 'output', category: 'value', dataType: 'float' },
  ],
  // dZ only exists in a 3D-agent model.
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['dz']),
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    // -1 = the empty sentinel; range-guarded → zero vector + zero distance
    // instead of NaN offsets from `_agentX[-1]` (WASM: adjacent-memory reads).
    const a = `((${inputs['agentId'] || '-1'}) | 0)`;
    const V = `_v${nodeId}`;
    const ok = `__goOk${nodeId}`;
    if (ctx?.is3d) {
      // 3D: add the z arm with the depth torus-wrap (`_fieldD`); distance = hypot of all 3.
      return `const __go${nodeId}=${a};`
        + `const ${ok}=__go${nodeId}>=0&&__go${nodeId}<highWater;`
        + `let __odx${nodeId}=0,__ody${nodeId}=0,__odz${nodeId}=0;`
        + `if(${ok}){`
        + `__odx${nodeId}=_agentX[__go${nodeId}]-_agentX[idx];__ody${nodeId}=_agentY[__go${nodeId}]-_agentY[idx];__odz${nodeId}=_agentZ[__go${nodeId}]-_agentZ[idx];`
        + `if(_fieldBoundaryTorus){const __W=_fieldW,__H=_fieldH,__D=_fieldD,__hW=__W/2,__hH=__H/2,__hD=__D/2;`
        + `if(__odx${nodeId}>__hW)__odx${nodeId}-=__W;else if(__odx${nodeId}<-__hW)__odx${nodeId}+=__W;`
        + `if(__ody${nodeId}>__hH)__ody${nodeId}-=__H;else if(__ody${nodeId}<-__hH)__ody${nodeId}+=__H;`
        + `if(__odz${nodeId}>__hD)__odz${nodeId}-=__D;else if(__odz${nodeId}<-__hD)__odz${nodeId}+=__D;}}`
        + `const ${V}_dx=__odx${nodeId},${V}_dy=__ody${nodeId},${V}_dz=__odz${nodeId},${V}_distance=${ok}?Math.hypot(__odx${nodeId},__ody${nodeId},__odz${nodeId}):0;\n`;
    }
    return `const __go${nodeId}=${a};`
      + `const ${ok}=__go${nodeId}>=0&&__go${nodeId}<highWater;`
      + `let __odx${nodeId}=0,__ody${nodeId}=0;`
      + `if(${ok}){`
      + `__odx${nodeId}=_agentX[__go${nodeId}]-_agentX[idx];__ody${nodeId}=_agentY[__go${nodeId}]-_agentY[idx];`
      + `if(_fieldBoundaryTorus){const __W=_fieldW,__H=_fieldH,__hW=__W/2,__hH=__H/2;`
      + `if(__odx${nodeId}>__hW)__odx${nodeId}-=__W;else if(__odx${nodeId}<-__hW)__odx${nodeId}+=__W;`
      + `if(__ody${nodeId}>__hH)__ody${nodeId}-=__H;else if(__ody${nodeId}<-__hH)__ody${nodeId}+=__H;}}`
      + `const ${V}_dx=__odx${nodeId},${V}_dy=__ody${nodeId},${V}_distance=${ok}?Math.hypot(__odx${nodeId},__ody${nodeId}):0;\n`;
  },
};
