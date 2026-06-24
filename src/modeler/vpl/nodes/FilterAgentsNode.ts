import type { NodeTypeDef } from '../types';

/** Filter Agents — keep the agents in an id-array whose AGENT attribute passes a
 *  comparison (Generic Agent Platform). The agent analogue of Filter Neighbors,
 *  minus the NeighborIndex codec: the array elements are plain agent ids, read
 *  directly from the agent SoA at `r_<attr>[id]`. Feed it Get Nearby Agents /
 *  Get Bonded Agents; iterate the result with For Each In Array or aggregate it.
 *  Multi-output: `result` (the kept ids) + `count` (its length). JS-only. */
export const FilterAgentsNode: NodeTypeDef = {
  type: 'filterAgents',
  label: 'Filter Agents',
  description: 'Keeps the agents whose attribute passes the comparison. Outputs the filtered id array + its count.',
  category: 'aggregation',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agents', label: 'Agents', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'compare', label: 'Compare', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Filtered', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
    { id: 'count', label: 'Count', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { attributeId: '', operation: 'equals' },
  compile: (nodeId, config, inputs) => {
    const attr = config.attributeId as string || '_undef';
    const compare = inputs['compare'] || '0';
    const op = config.operation as string;
    const agents = inputs['agents'] || '[]';
    const fi = `_fi${nodeId}`;
    const id = `_fa${nodeId}`;
    const cnt = `_v${nodeId}_count`;
    const elem = `r_${attr}[${id}]`;
    let cond: string;
    switch (op) {
      case 'notEquals':    cond = `${elem} !== ${compare}`; break;
      case 'greater':      cond = `${elem} > ${compare}`; break;
      case 'lesser':       cond = `${elem} < ${compare}`; break;
      case 'greaterEqual': cond = `${elem} >= ${compare}`; break;
      case 'lesserEqual':  cond = `${elem} <= ${compare}`; break;
      default:             cond = `${elem} === ${compare}`; break; // equals
    }
    return [
      `_v${nodeId}_result.length = 0; let ${cnt} = 0;`,
      `for (let ${fi} = 0; ${fi} < ${agents}.length; ${fi}++) {`,
      `  const ${id} = (${agents}[${fi}]) | 0;`,
      // Skip empty (-1) / out-of-range / dead ids BEFORE the comparison —
      // r_attr[-1] is undefined and (e.g.) `undefined !== compare` would KEEP a
      // dead id, poisoning a downstream gather. Mirrors Get Agents Attribute.
      `  if (${id} >= 0 && ${id} < highWater && _alive[${id}] && (${cond})) _v${nodeId}_result[${cnt}++] = ${id};`,
      `}`,
    ].join(' ') + '\n';
  },
};
