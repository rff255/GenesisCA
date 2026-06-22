import type { NodeTypeDef } from '../types';

/** For Each Bond — iterate this agent's bonds (Bond-Graph Agents). Runs the BODY
 *  flow once per live bond, exposing the partner's id, the bond's rest length,
 *  its current length, and the 0-based slot index. The agent analogue of For
 *  Each In Array, but over the ragged bond store (no array input). Use it for
 *  per-bond rules: break over-strained bonds (Break Bond on `partner` when
 *  `currentLength` ≫ `restLength`), read a partner's attribute, sum bond strain.
 *
 *  Multi-output (per-iteration outputs resolve via `_v<id>_<port>`); the
 *  compiler emits the bond loop in `compileFlowChain`. */
export const ForEachBondNode: NodeTypeDef = {
  type: 'forEachBond',
  label: 'For Each Bond',
  description: "Iterates this agent's bonds, running BODY per bond with the partner / rest length / current length / index exposed.",
  category: 'flow',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'DONE', kind: 'output', category: 'flow' },
    { id: 'body', label: 'BODY', kind: 'output', category: 'flow' },
    { id: 'partnerId', label: 'Partner', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'restLength', label: 'Rest Length', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'currentLength', label: 'Current Length', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'index', label: 'Index', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: () => '', // compiler handles the bond loop in compileFlowChain
};
