import type { NodeTypeDef } from '../types';

/** Get Bond Degree — the number of LIVE bonds the agent currently has
 *  (Bond-Graph Agents). Reads the engine reduction `_agentBondCount[idx]`. A
 *  FIRST-CLASS node (NOT an Average over the bond list): the bond store is a
 *  ragged per-agent array with free-list holes, so the live degree is the
 *  maintained count, not the array length. 0 until bonds are formed (Phase B). */
export const GetBondDegreeNode: NodeTypeDef = {
  type: 'getBondDegree',
  label: 'Get Bond Degree',
  description: 'Outputs the number of live bonds connected to the agent.',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'value', label: 'Degree', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId) => `const _v${nodeId} = _agentBondCount[idx];\n`,
};
