import type { NodeTypeDef } from '../types';

/** Pick Random Agent — pick one id at random from an agent id-array (Generic
 *  Agent Platform). The agent analogue of Pick Random Neighbor; the empty
 *  sentinel is -1 (not INVALID_NI). Shares the same xorshift32 `_rs` stream as
 *  Get Random so all draws stay reproducible. Per-agent, impure. JS-only. */
export const PickRandomAgentNode: NodeTypeDef = {
  type: 'pickRandomAgent',
  label: 'Pick Random Agent',
  description: 'Picks one agent at random from an id-array (e.g. Get Nearby Agents / Filter Agents). Returns -1 when empty.',
  category: 'aggregation',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agents', label: 'Agents', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'value', label: 'Agent', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const arr = inputs['agents'] || '[]';
    const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
      + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
      + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
    return [
      `${advance}`,
      `const _pickAg${nodeId} = ${arr};`,
      `const _v${nodeId} = _pickAg${nodeId}.length === 0 ? -1 : ((_pickAg${nodeId}[Math.floor((_rs / 4294967296) * _pickAg${nodeId}.length)]) | 0);`,
    ].join(' ') + '\n';
  },
};
