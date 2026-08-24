import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';
import { dividePartitionCode } from '../compiler/dividePartition';

/** Divide Agent — request that this agent divide into two daughters (Bond-Graph
 *  Agents). Applied in the post-step structural phase: the engine splits the
 *  agent along its TENSION AXIS (the net-stretch direction of its bonds, a
 *  closed-form 2×2 eigensolve — so a glued cluster elongates + divides along its
 *  mechanical axis), places the daughters at `centroid ± ½·radius·axis`,
 *  partitions each partner bond to a daughter, and adds a daughter-daughter bond.
 *  Daughters inherit the mother's attributes; a Division Event graph (if present)
 *  can reassign them. Overflow (maxAgents / maxBonds) rejects the WHOLE division,
 *  leaving the agent unchanged + surfacing a notice — never a half-divided state.
 *
 *  `axisSource` labels the engine axis "tension axis" (a center-based sphere has
 *  no SHAPE long-axis — only the tension proxy is computable). Wire `axisX`/
 *  `axisY` to override the axis (e.g. up a field gradient); `asymmetry` ∈ [0,1]
 *  biases the area split between daughters (0.5 = symmetric).
 *
 *  P5 — `partition` says WHICH EDGES each daughter gets (graph rewriting is
 *  DEFINED by that, and geometry is exactly what a rule cannot say):
 *    tension          the geometric split. THE DEFAULT, byte-identical to pre-P5.
 *    alternate        A, B, A, B… in slot order.
 *    byBondAttribute  a named BOND attribute selects the daughter (bool /
 *                     threshold on integer+float / a per-option table on tag).
 *  `daughterBond` is decision D4: `auto` (only when the mother was bonded — the
 *  pre-P5 rule), `always`, or `never`.
 *
 *  D2 — `conserve` says what the daughter RADII conserve:
 *    area    `rA = r·√f`, `rB = r·√(1−f)` ⇒ `rA² + rB² = r²`. THE DEFAULT, and
 *            the historical behaviour in BOTH dimensions.
 *    volume  `rA = r·∛f`, `rB = r·∛(1−f)` ⇒ `rA³ + rB³ = r³`. 3D ONLY (the row
 *            is hidden in 2D and both the resolver and the engine coerce it).
 *  It matters because the area split applied in 3D too, where it is NOT
 *  volume-conserving: at the default symmetric split each daughter is `r/√2`, so
 *  ~29 % of the volume disappears at every division. Like the partition, it
 *  rides the per-model TABLE, so switching it moves no emitted byte.
 *
 *  TRANSPORT: the partition is per-NODE but applied by the ENGINE, so the
 *  compiler collects one table entry per distinct spec and this emit writes its
 *  1-based code into the EXISTING `divideRequest` cell (the `stopMessages` /
 *  `_stopIdx` precedent) — no new store lane, no layout change, no ABI change on
 *  any target. Code 1 is the pre-P5 literal. See
 *  [dividePartition.ts](../compiler/dividePartition.ts). */
export const DivideAgentNode: NodeTypeDef = {
  type: 'divideAgent',
  label: 'Divide Agent',
  agentLabel: 'Divide Self',
  description: 'Request the agent divide along its tension axis (applied after the step). Partition says which bonds each daughter inherits: by geometry (tension), alternating, or by a bond attribute.',
  category: 'output',
  color: '#ad1457',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'axisX', label: 'Axis X', kind: 'input', category: 'value', dataType: 'float' },
    { id: 'axisY', label: 'Axis Y', kind: 'input', category: 'value', dataType: 'float' },
    { id: 'axisZ', label: 'Axis Z', kind: 'input', category: 'value', dataType: 'float' },
    { id: 'asymmetry', label: 'Asymmetry', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
  ],
  // Axis Z only exists in a 3D-agent model.
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['axisZ']),
  defaultConfig: { axisSource: 'tension', partition: 'tension', daughterBond: 'auto', conserve: 'area' },
  compile: (_nodeId, config, inputs, _boundary, ctx) =>
    `_divideRequest[idx] = ${dividePartitionCode(config)}; _divideAxisX[idx] = ${inputs['axisX'] ?? 'NaN'}; _divideAxisY[idx] = ${inputs['axisY'] ?? 'NaN'};${ctx?.is3d ? ` _divideAxisZ[idx] = ${inputs['axisZ'] ?? 'NaN'};` : ''} _divideAsym[idx] = ${inputs['asymmetry'] || '0.5'};\n`,
};
