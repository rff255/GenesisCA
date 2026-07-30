import type { NodeTypeDef } from '../types';
import { emitBondRequestJS } from '../compiler/bondRequestEmitJS';

/** Form Bond Between (GRA P4b) — bond two OTHER agents, chosen by id.
 *
 *  Form Bond is self-to-target, so an edge joining two agents that are BOTH
 *  someone else cannot be created by it. That gap is not academic: the canonical
 *  cubic **triangle split** (`v` with neighbours `a,b,c` → `v₁,v₂,v₃`, with the
 *  triangle closed) needs the edge `v₂–v₃` joining two agents CREATED THIS STEP —
 *  neither is `self`, and neither runs its own behaviour until the next
 *  generation. Without this verb the split has to be spread over two generations,
 *  which leaves an intermediate state where `E ≠ 3N/2` and two nodes have degree
 *  2 — i.e. it violates exactly the invariant the rule exists to preserve.
 *
 *  The request rides the REQUESTING agent's own queue, carrying both ids in its
 *  payload, so no agent ever writes another agent's request rows (which is why the
 *  WebGPU emit still needs no atomics). Applied in the post-step structural phase
 *  like every other bond verb.
 *
 *  Semantics — a whole-op rejection, never a partial state (invariant I5):
 *  no-op if either id is out of range / dead / the two are the same agent, if they
 *  are already bonded, or if EITHER bond list is full. The bond is symmetric with
 *  identical rest length, stiffness and bond-attribute values on both sides (I2).
 *  `restLength` 0 = the two agents' contact distance (sum of radii); `stiffness`
 *  0 = the model's bond stiffness λ. */
export const FormBondBetweenNode: NodeTypeDef = {
  type: 'formBondBetween',
  label: 'Form Bond Between',
  description: 'Request a bond between two OTHER agents, by id (applied after the step). The edge a self-to-target Form Bond cannot make - e.g. joining two agents this rule just created.',
  category: 'output',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentA', label: 'Agent A', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'agentB', label: 'Agent B', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'restLength', label: 'Rest Length', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'stiffness', label: 'Stiffness', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: {},
  // Like Form Bond / Rewire Bond, the new edge's INITIAL bond-attribute values ride
  // the queue entry through one dynamic port per declared bond attribute
  // (`bondAttr_<id>`, built by `buildBondAttrPorts`). The whole append lives in ONE
  // shared emitter so the four verbs cannot drift in slot addressing or encoding.
  compile: (_nodeId, _config, inputs, _boundary, ctx) =>
    emitBondRequestJS('between', inputs, ctx),
};
