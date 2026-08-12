import type { NodeTypeDef } from '../types';
import { emitBondRequestJS } from '../compiler/bondRequestEmitJS';

/** Break Bond — request that the bond between two agents be removed (Bond-Graph
 *  Agents). Applied in the post-step structural phase (symmetric — removed from
 *  both lists). `targetAgent` is typically ForEachBond's partner output (break a
 *  bond by condition, e.g. when over-strained). NOT async-only.
 *
 *  `agentA` names the bond's FIRST endpoint and is OPTIONAL, exactly as on Form
 *  Bond: leave it unwired and it is THIS agent (the common case, and byte-
 *  identical to the pre-port emit on all three agent targets); wire it and the op
 *  LOWERS to the Break Between encoding — BOTH request lanes negated — so one
 *  node covers "unbond me from X" and "cut the edge between X and Y". That
 *  third-party cut is the one edge mutation the self-anchored verbs could not
 *  express (Rewire and Transfer are both anchored at the requester).
 *
 *  A cut that would break nothing (no such edge, a dead or out-of-range id, the
 *  two ids equal) touches NOTHING — invariant I5; see `breakBondBetween`.
 *
 *  P4: requests are QUEUED — an agent may break several bonds in one step (depth:
 *  Model Properties → Bond-Graph Agents → Bond Requests / Agent / Step).
 *
 *  ⚠️ The port carries NO inline widget, deliberately: `formBondPairWiredJS`
 *  reads "is it wired?" off `inputs[...]`, which is the edge-map answer ONLY for
 *  a widget-less port (see bondRequestEmitJS.ts). */
export const BreakBondNode: NodeTypeDef = {
  type: 'breakBond',
  label: 'Break Bond',
  description: 'Request that the bond between two agents be removed (after the step). Agent A defaults to THIS agent when left unwired; wire it to cut the bond between two other agents. Requests are queued, so an agent can break several bonds in one step.',
  category: 'output',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentA', label: 'Agent A (self)', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'targetAgent', label: 'Target', kind: 'input', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) =>
    emitBondRequestJS('break', inputs, ctx),
};
