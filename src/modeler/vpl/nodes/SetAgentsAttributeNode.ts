import type { NodeTypeDef } from '../types';
import { agentRootHasSelf } from '../types';

/** Set Agents Attribute — write one AGENT attribute on EVERY agent in an id-array
 *  (Generic Agent Platform). The write-many companion to Set Agent Attribute /
 *  the agent analogue of Set Neighbor Attribute By Index over a list. Feed it Get
 *  Nearby Agents / Get Bonded Agents / Filter Agents to signal a whole group
 *  (mark contacted, broadcast a value). Immediate (async-style) writes, each id
 *  range+alive guarded. Runs on all three agent targets (JS / WASM / WebGPU). */
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
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const agents = inputs['agents'] || '[]';
    const v = inputs['value'] || '0';
    const i = `_si${nodeId}`;
    const id = `_sa${nodeId}`;
    // In the Agent Init Event `highWater`/`_alive` aren't in scope (loop/division
    // ABI only), so — like the scalar by-id setters — guard against `_agentMaxAgents`
    // there. Behaviour/loop keeps the `< highWater && _alive` guard byte-identical
    // (WASM/WebGPU parity preserved).
    const guard = !agentRootHasSelf(ctx?.agentRoot)
      ? `${id} >= 0 && ${id} < _agentMaxAgents`
      : `${id} >= 0 && ${id} < highWater && _alive[${id}]`;
    return [
      `{ const __arr=${agents}; const __val=${v};`,
      `for (let ${i} = 0; ${i} < __arr.length; ${i}++) {`,
      `  const ${id} = (__arr[${i}]) | 0;`,
      `  if (${guard}) w_${attr}[${id}] = __val;`,
      `} }`,
    ].join(' ') + '\n';
  },
};
