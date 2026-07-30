import type { NodeTypeDef } from '../types';
import { emitBondRequestJS } from '../compiler/bondRequestEmitJS';

/** Form Bond — request a bond between this agent and a target agent (Bond-Graph
 *  Agents). The bond is applied in the post-step structural phase (so it's NOT
 *  async-only — no read-after-write hazard). Symmetric: both agents get a bond
 *  slot. No-op if already bonded, the target is dead, or either bond list is
 *  full (maxBonds — rejects, never wraps).
 *
 *  P4: requests are QUEUED — an agent may issue several bond ops in one step
 *  (depth: Model Properties → Bond-Graph Agents → Bond Requests / Agent / Step);
 *  ops past the depth are rejected whole with a notice.
 *
 *  `targetAgent` is the partner's agent id — typically from ForEachBond's
 *  partner output or a future nearest-agent read; the engine's auto-bond option
 *  (Properties → Agents) forms bonds by proximity without any node. `restLength`
 *  0 = the two agents' contact distance (sum of radii); `stiffness` 0 = the
 *  model's bond stiffness λ. */
export const FormBondNode: NodeTypeDef = {
  type: 'formBond',
  label: 'Form Bond',
  description: 'Request a bond between this agent and a target agent (applied after the step). Requests are queued, so an agent can form several bonds in one step (use Auto-Bond for bulk bonding).',
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
  // P2 — the new bond's INITIAL attribute values ride the queue entry alongside
  // restLength/stiffness (one dynamic input port per declared bond attribute,
  // `bondAttr_<id>`, built by `buildBondAttrPorts`); the structural phase hands
  // them to `formBond`, which writes BOTH slots (I2). A model with no bond
  // attributes emits nothing extra. P4 — the whole append lives in ONE shared
  // emitter so the three verbs cannot drift.
  compile: (_nodeId, _config, inputs, _boundary, ctx) =>
    emitBondRequestJS('form', inputs, ctx),
};
