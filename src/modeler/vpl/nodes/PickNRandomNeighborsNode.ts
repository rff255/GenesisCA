import type { NodeTypeDef } from '../types';

export const PickNRandomNeighborsNode: NodeTypeDef = {
  type: 'pickNRandomNeighbors',
  requirements: { lattice2d: true },  // 2-axis packed neighborIndex codec — 2D only
  label: 'Pick N Random Neighbors',
  description: 'Picks N distinct elements at random from a NeighborIndex array (without replacement). Returns at most min(N, input.length) NIs.',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'input', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'n', label: 'N', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '1' },
    { id: 'value', label: 'Picked', kind: 'output', category: 'value', dataType: 'neighborIndex', isArray: true },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const arr = inputs['indexes'] || '[]';
    const n = inputs['n'] || '1';
    // Same xorshift32 stream as GetRandomNode / pickRandomNeighbor for reproducibility.
    const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
      + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
      + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
    // Partial Fisher-Yates over a working copy:
    //  - copy input -> _v{id}_work
    //  - for i in [0, k): swap work[i] with work[i + rand*(L-i)]; result[i] = work[i]
    // Both work and result arrays are pre-allocated as scratch.
    return [
      `const _pnArr${nodeId} = ${arr};`,
      `const _pnL${nodeId} = _pnArr${nodeId}.length;`,
      `const _pnK${nodeId} = Math.min(Math.max(((${n}) | 0), 0), _pnL${nodeId});`,
      `_v${nodeId}_work.length = 0;`,
      `for (let _pi${nodeId} = 0; _pi${nodeId} < _pnL${nodeId}; _pi${nodeId}++) _v${nodeId}_work[_pi${nodeId}] = _pnArr${nodeId}[_pi${nodeId}];`,
      `_v${nodeId}_result.length = 0;`,
      `for (let _pi${nodeId} = 0; _pi${nodeId} < _pnK${nodeId}; _pi${nodeId}++) {`,
      `  ${advance}`,
      `  const _pj${nodeId} = _pi${nodeId} + Math.floor((_rs / 4294967296) * (_pnL${nodeId} - _pi${nodeId}));`,
      `  const _pt${nodeId} = _v${nodeId}_work[_pi${nodeId}];`,
      `  _v${nodeId}_work[_pi${nodeId}] = _v${nodeId}_work[_pj${nodeId}];`,
      `  _v${nodeId}_work[_pj${nodeId}] = _pt${nodeId};`,
      `  _v${nodeId}_result[_pi${nodeId}] = _v${nodeId}_work[_pi${nodeId}];`,
      `}`,
    ].join(' ') + '\n';
  },
};
