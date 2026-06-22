import type { NodeTypeDef } from '../types';

/** Divide Agent — request that this agent divide into two daughters (Bond-Graph
 *  Agents). Applied in the post-step structural phase: the engine splits the
 *  agent along its TENSION AXIS (the net-stretch direction of its bonds, a
 *  closed-form 2×2 eigensolve — so a glued cluster elongates + divides along its
 *  mechanical axis), places the daughters at `centroid ± ½·radius·axis`,
 *  partitions each partner bond to the nearer daughter by geometry, and adds a
 *  daughter-daughter bond (when the mother was bonded). Daughters inherit the
 *  mother's attributes; a Division Event graph (if present) can reassign them.
 *  Overflow (maxAgents / maxBonds) rejects the WHOLE division, leaving the agent
 *  unchanged + surfacing a notice — never a half-divided state.
 *
 *  `axisSource` labels the engine axis "tension axis" (a center-based sphere has
 *  no SHAPE long-axis — only the tension proxy is computable). Wire `axisX`/
 *  `axisY` to override the axis (e.g. up a field gradient); `asymmetry` ∈ [0,1]
 *  biases the area split between daughters (0.5 = symmetric). */
export const DivideAgentNode: NodeTypeDef = {
  type: 'divideAgent',
  label: 'Divide Agent',
  description: 'Request the agent divide along its tension axis (applied after the step). Bonds inherited by geometry.',
  category: 'output',
  color: '#ad1457',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'axisX', label: 'Axis X', kind: 'input', category: 'value', dataType: 'float' },
    { id: 'axisY', label: 'Axis Y', kind: 'input', category: 'value', dataType: 'float' },
    { id: 'asymmetry', label: 'Asymmetry', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
  ],
  defaultConfig: { axisSource: 'tension' },
  compile: (_nodeId, _config, inputs) =>
    `_divideRequest[idx] = 1; _divideAxisX[idx] = ${inputs['axisX'] ?? 'NaN'}; _divideAxisY[idx] = ${inputs['axisY'] ?? 'NaN'}; _divideAsym[idx] = ${inputs['asymmetry'] || '0.5'};\n`,
};
