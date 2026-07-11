import type { NodeTypeDef } from '../types';

/** Set Agent Attribute — write an attribute on ANOTHER agent by id (Bond-Graph
 *  Agents). The agent analogue of Set Neighbor Attribute By Index: signal a
 *  neighbour (mark it contacted, push a value onto it, transfer a resource). Feed
 *  a neighbour id from Get Nearby Agents / For Each Bond.
 *
 *  Agent attributes are single-buffered, so the write is immediately visible —
 *  this is an ASYNC-style write (the result can depend on agent iteration order
 *  when several agents write the same target in one step). Use commutative
 *  patterns (accumulate, max) when order matters. The id is range-guarded. */
export const SetAgentAttributeNode: NodeTypeDef = {
  type: 'setAgentAttribute',
  label: 'Set Agent Attribute',
  description: "Write an attribute on another agent by id (signal a neighbour). Immediate (async-style) write. Extra attribute slots (+ Attribute) write several of that agent's attributes through one shared Agent input.",
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (_nodeId, config, inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const a = `((${inputs['agentId'] || '-1'}) | 0)`;
    // Unified spawning: a Created agent is STAGED (alive=0) until Add Agent To World
    // in BOTH the Init Event and the Behaviour graph, so the live-agent guard relaxes
    // to range-only in either root (so a fresh handle can be configured; writing a
    // dead slot is a harmless no-op). Division keeps the strict live-agent guard.
    const guard = (ctx?.agentRoot === 'init' || ctx?.agentRoot === 'behaviour')
      ? `__sa>=0&&__sa<_agentMaxAgents`
      : `__sa>=0&&__sa<highWater&&_alive[__sa]`;
    return `{ const __sa=${a}; if(${guard}) w_${attr}[__sa] = ${inputs['value'] || '0'}; }\n`;
  },
};
