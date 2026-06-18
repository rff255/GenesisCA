import type { NodeTypeDef } from '../types';

/** Multi-output: `result` is the joined NI array; `count` is its final length
 *  exposed as a scalar so downstream graphs don't need a separate
 *  `arrayLength` node when they care about "how many neighbors were joined".
 *  Mirrors FilterNeighbors' two-port shape. */
export const JoinNeighborsNode: NodeTypeDef = {
  type: 'joinNeighbors',
  requirements: { lattice2d: true },  // 2-axis packed neighborIndex codec — 2D only
  label: 'Join Neighbors',
  description: 'Combines two neighbor index arrays via intersection or union. Outputs both the joined NI array and its element count.',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'count', label: 'Count', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { operation: 'intersection' },
  compile: (nodeId, config, inputs) => {
    const a = inputs['a'] || '[]';
    const b = inputs['b'] || '[]';
    const op = config.operation as string;
    const cnt = `_v${nodeId}_count`;
    if (op === 'union') {
      // Deduplicated union via Set (acceptable for small neighborhood sizes).
      const setName = `_jset${nodeId}`;
      const elem = `_je${nodeId}`;
      return [
        `_v${nodeId}_result.length = 0; let ${cnt} = 0;`,
        `const ${setName} = new Set(${a}.concat(${b}));`,
        `for (const ${elem} of ${setName}) _v${nodeId}_result[${cnt}++] = ${elem};`,
      ].join(' ') + '\n';
    }
    // intersection: keep only elements present in both
    const ji = `_ji${nodeId}`;
    return [
      `_v${nodeId}_result.length = 0; let ${cnt} = 0;`,
      `for (let ${ji} = 0; ${ji} < ${a}.length; ${ji}++) {`,
      `  if (${b}.indexOf(${a}[${ji}]) >= 0) _v${nodeId}_result[${cnt}++] = ${a}[${ji}];`,
      `}`,
    ].join(' ') + '\n';
  },
};
