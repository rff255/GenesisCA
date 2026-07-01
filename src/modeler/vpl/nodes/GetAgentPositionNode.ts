import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Get Agent Position — a specific agent's position by id (Bond-Graph Agents),
 *  with an absolute / relative `mode`:
 *  - ABSOLUTE (default): the raw (X, Y[, Z]) of the agent at `Agent`.
 *  - RELATIVE: the torus-SHORTEST displacement (X, Y[, Z]) from a REFERENCE agent
 *    to `Agent` — `target − reference`, folded to the shortest path across a torus
 *    seam (reuses the engine wrap, reading `_fieldW`/`_fieldH`/`_fieldBoundaryTorus`,
 *    which ride the agent-loop signature). The `Reference` input DEFAULTS to SELF
 *    (the loop agent `idx`) when unwired, so it covers "vector to a neighbour" out
 *    of the box; wiring it yields the offset between ANY two agents.
 *  Feed the `Agent` (and `Reference`) ids from Get Nearby Agents / For Each Bond /
 *  Get Self Handle. Multi-output (`_v<id>_<port>`); `Z` only in a 3D-agent model.
 *  Relative mode is the wrap-correct alternative to hand-subtracting two absolute
 *  reads; `Get Agent Offset` stays for the self→target shape with a Distance out. */
export const GetAgentPositionNode: NodeTypeDef = {
  type: 'getAgentPosition',
  label: 'Get Agent Position',
  description: "Outputs a specific agent's (X, Y, Z) by id — absolute, or (relative mode) the torus-shortest vector from a reference agent (default self).",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'refId', label: 'Reference', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'x', label: 'X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'y', label: 'Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'z', label: 'Z', kind: 'output', category: 'value', dataType: 'float' },
  ],
  // `Reference` shows only in relative mode; `Z` only in a 3D-agent model.
  hiddenPorts: (config, model) => {
    const hidden = is3dModelLike(model) ? [] : ['z'];
    if ((config.mode as string) !== 'relative') hidden.push('refId');
    return hidden;
  },
  defaultConfig: { mode: 'absolute' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const a = `((${inputs['agentId'] || '0'}) | 0)`;
    if ((config.mode as string) === 'relative') {
      // target − reference, folded to the torus-shortest path (mirrors
      // GetAgentOffsetNode minus the Distance output). Reference defaults to
      // SELF (`idx`) when unwired.
      const ref = inputs['refId'] ? `((${inputs['refId']}) | 0)` : 'idx';
      const V = `_v${nodeId}`;
      if (ctx?.is3d) {
        return `const __ga${nodeId}=${a}; const __gr${nodeId}=${ref};`
          + `let __ox${nodeId}=_agentX[__ga${nodeId}]-_agentX[__gr${nodeId}],__oy${nodeId}=_agentY[__ga${nodeId}]-_agentY[__gr${nodeId}],__oz${nodeId}=_agentZ[__ga${nodeId}]-_agentZ[__gr${nodeId}];`
          + `if(_fieldBoundaryTorus){const __W=_fieldW,__H=_fieldH,__D=_fieldD,__hW=__W/2,__hH=__H/2,__hD=__D/2;`
          + `if(__ox${nodeId}>__hW)__ox${nodeId}-=__W;else if(__ox${nodeId}<-__hW)__ox${nodeId}+=__W;`
          + `if(__oy${nodeId}>__hH)__oy${nodeId}-=__H;else if(__oy${nodeId}<-__hH)__oy${nodeId}+=__H;`
          + `if(__oz${nodeId}>__hD)__oz${nodeId}-=__D;else if(__oz${nodeId}<-__hD)__oz${nodeId}+=__D;}`
          + `const ${V}_x=__ox${nodeId},${V}_y=__oy${nodeId},${V}_z=__oz${nodeId};\n`;
      }
      return `const __ga${nodeId}=${a}; const __gr${nodeId}=${ref};`
        + `let __ox${nodeId}=_agentX[__ga${nodeId}]-_agentX[__gr${nodeId}],__oy${nodeId}=_agentY[__ga${nodeId}]-_agentY[__gr${nodeId}];`
        + `if(_fieldBoundaryTorus){const __W=_fieldW,__H=_fieldH,__hW=__W/2,__hH=__H/2;`
        + `if(__ox${nodeId}>__hW)__ox${nodeId}-=__W;else if(__ox${nodeId}<-__hW)__ox${nodeId}+=__W;`
        + `if(__oy${nodeId}>__hH)__oy${nodeId}-=__H;else if(__oy${nodeId}<-__hH)__oy${nodeId}+=__H;}`
        + `const ${V}_x=__ox${nodeId},${V}_y=__oy${nodeId};\n`;
    }
    // absolute (default / mode absent) — byte-identical to the pre-mode emit.
    const z = ctx?.is3d ? ` const _v${nodeId}_z=_agentZ[__ga${nodeId}];` : '';
    return `const __ga${nodeId}=${a}; const _v${nodeId}_x=_agentX[__ga${nodeId}]; const _v${nodeId}_y=_agentY[__ga${nodeId}];${z}\n`;
  },
};
