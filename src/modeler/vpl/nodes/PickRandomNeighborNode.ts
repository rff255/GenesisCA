import type { NodeTypeDef } from '../types';

export const PickRandomNeighborNode: NodeTypeDef = {
  type: 'pickRandomNeighbor',
  label: 'Pick Random Neighbor',
  description: 'Picks one element at random from a NeighborIndex array (e.g. the result of Filter Neighbors). Returns INVALID_NI (0x80000000) if the array is empty.',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'input', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const arr = inputs['indexes'] || '[]';
    // Use the same xorshift32 stream as GetRandomNode so all RNG draws share one state
    // and stay reproducible across compile targets.
    const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
      + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
      + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
    return [
      `${advance}`,
      `const _pickArr${nodeId} = ${arr};`,
      `const _v${nodeId} = _pickArr${nodeId}.length === 0 ? ${0x80000000 | 0} : _pickArr${nodeId}[Math.floor((_rs / 4294967296) * _pickArr${nodeId}.length)];`,
    ].join(' ') + '\n';
  },
};
