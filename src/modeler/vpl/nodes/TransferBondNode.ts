import type { NodeTypeDef } from '../types';
import { emitBondRequestJS } from '../compiler/bondRequestEmitJS';

/** Transfer Bond (GRA B9) — hand THIS agent's edge with one partner over to a new
 *  partner, rewriting the partner's slot IN PLACE.
 *
 *  WHY IT IS NOT `Rewire Bond`. Rewire is break + form AT THIS AGENT, and the
 *  engine's break compacts by swapping the LAST slot into the freed one while a
 *  form APPENDS. So a rewire SCRAMBLES THE OTHER AGENT'S adjacency order: the
 *  partner loses this agent from slot p, its last entry jumps into p, and the new
 *  partner receives the bond at the end of its own list. Transfer overwrites the
 *  partner's slot where it stands, so the partner's ORDER is preserved — the
 *  in-place `reconnect` a graph automaton's reference implementations perform.
 *
 *  Slot order is not cosmetic for a rewriting rule: a cubic triangle split keeps
 *  bond slot 0 and hands slots 1 and 2 to its daughters, so which neighbour each
 *  daughter inherits is decided by slot order and propagates into every later
 *  split — and into the embedding — forever.
 *
 *  THE BOND KEEPS ITS VALUES. It is the same edge re-pointed, so its rest length,
 *  stiffness and every bond attribute travel with it (and the mirror slot at the
 *  new partner is stamped identically — invariant I2). That is why this node has
 *  no rest-length / stiffness / bond-attribute inputs: there is nothing to supply.
 *
 *  Semantics — a whole-op rejection, never a partial state (invariant I5):
 *  no-op unless this agent is actually bonded to `Partner`, `New Partner` is a
 *  live agent distinct from both, `Partner` is not ALREADY bonded to `New Partner`
 *  (that would give it a double edge), and `New Partner` has a free bond slot.
 *  Degrees afterwards: `Partner` unchanged, this agent −1, `New Partner` +1.
 *
 *  Like every structural verb it rides this agent's own request queue and is
 *  applied in the post-step structural phase, so no agent ever writes another
 *  agent's request rows (which is why the WebGPU emit needs no atomics). */
export const TransferBondNode: NodeTypeDef = {
  type: 'transferBond',
  label: 'Transfer Bond',
  description: 'Hand this agent\'s bond with Partner over to New Partner, rewriting Partner\'s bond slot IN PLACE so Partner\'s ordering is preserved (Rewire Bond scrambles it). The bond keeps its rest length, stiffness and attributes.',
  category: 'output',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'partnerAgent', label: 'Partner', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'toAgent', label: 'New Partner', kind: 'input', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) =>
    emitBondRequestJS('transfer', inputs, ctx),
};
