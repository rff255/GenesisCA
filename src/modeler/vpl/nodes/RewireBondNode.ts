import type { NodeTypeDef } from '../types';
import { emitBondRequestJS } from '../compiler/bondRequestEmitJS';

/** Rewire Bond (GRA P4) — MOVE one of this agent's bonds: break the bond to
 *  `From` and form a bond to `To`, as ONE ATOMIC operation.
 *
 *  This is the verb graph-rewriting automata actually name, and atomicity is the
 *  point: the intermediate half-rewired state (edge broken, replacement not yet
 *  formed) never exists, so a degree-preserving rule holds its invariant at EVERY
 *  generation rather than only between them. If anything would reject — there is
 *  no bond to `From`, `To` is dead / out of range / this agent itself, or `To`'s
 *  bond list is full — **nothing at all is applied** (invariant I5).
 *
 *  Applied in the post-step structural phase like Form / Break Bond, and queued:
 *  an agent may issue several ops per step (Model Properties → Bond-Graph Agents →
 *  Bond Requests / Agent / Step). `To === From` re-forms the same edge with the
 *  new rest length / stiffness / bond-attribute values. */
export const RewireBondNode: NodeTypeDef = {
  type: 'rewireBond',
  label: 'Rewire Bond',
  description: 'Atomically move one of this agent\'s bonds from one partner to another (break + form as ONE operation, applied after the step). Nothing is applied if the move cannot be completed.',
  category: 'output',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'fromAgent', label: 'From', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'toAgent', label: 'To', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'restLength', label: 'Rest Length', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'stiffness', label: 'Stiffness', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) =>
    emitBondRequestJS('rewire', inputs, ctx),
};
