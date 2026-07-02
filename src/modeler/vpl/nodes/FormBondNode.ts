import type { NodeTypeDef } from '../types';

/** Form Bond — request a bond between this agent and a target agent (Bond-Graph
 *  Agents). The bond is applied in the post-step structural phase (so it's NOT
 *  async-only — no read-after-write hazard). Symmetric: both agents get a bond
 *  slot. No-op if already bonded, the target is dead, or either bond list is
 *  full (maxBonds — rejects, never wraps).
 *
 *  `targetAgent` is the partner's agent id — typically from ForEachBond's
 *  partner output or a future nearest-agent read; the engine's auto-bond option
 *  (Properties → Agents) forms bonds by proximity without any node. `restLength`
 *  0 = the two agents' contact distance (sum of radii); `stiffness` 0 = the
 *  model's bond stiffness λ. */
export const FormBondNode: NodeTypeDef = {
  type: 'formBond',
  label: 'Form Bond',
  description: 'Request a bond between this agent and a target agent (applied after the step). One request per agent per step — a later call this step replaces an earlier one (use Auto-Bond for bulk bonding).',
  category: 'output',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'targetAgent', label: 'Target', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'restLength', label: 'Rest Length', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'stiffness', label: 'Stiffness', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs) =>
    `_bondFormReq[idx] = ((${inputs['targetAgent'] || '-1'}) | 0) + 1; _bondFormL[idx] = ${inputs['restLength'] || '0'}; _bondFormK[idx] = ${inputs['stiffness'] || '0'};\n`,
};
