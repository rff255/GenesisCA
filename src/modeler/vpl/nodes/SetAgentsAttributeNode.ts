import type { NodeTypeDef } from '../types';

/** Set Agents Attribute — write one AGENT attribute on EVERY agent in an id-array
 *  (Generic Agent Platform). The write-many companion to Set Agent Attribute /
 *  the agent analogue of Set Neighbor Attribute By Index over a list. Feed it Get
 *  Nearby Agents / Get Bonded Agents / Filter Agents to signal a whole group
 *  (mark contacted, broadcast a value). Immediate (async-style) writes, each id
 *  range+alive guarded. JS-only this milestone. */
export const SetAgentsAttributeNode: NodeTypeDef = {
  type: 'setAgentsAttribute',
  label: 'Set Agents Attribute',
  description: 'Writes one attribute on every agent in an id-array (Get Nearby/Bonded/Filter Agents). Immediate writes.',
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agents', label: 'Agents', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const attr = config.attributeId as string || '_undef';
    const agents = inputs['agents'] || '[]';
    const v = inputs['value'] || '0';
    const i = `_si${nodeId}`;
    const id = `_sa${nodeId}`;
    return [
      `{ const __arr=${agents}; const __val=${v};`,
      `for (let ${i} = 0; ${i} < __arr.length; ${i}++) {`,
      `  const ${id} = (__arr[${i}]) | 0;`,
      `  if (${id} >= 0 && ${id} < highWater && _alive[${id}]) w_${attr}[${id}] = __val;`,
      `} }`,
    ].join(' ') + '\n';
  },
};
