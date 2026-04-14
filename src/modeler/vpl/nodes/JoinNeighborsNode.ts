import type { NodeTypeDef } from '../types';

export const JoinNeighborsNode: NodeTypeDef = {
  type: 'joinNeighbors',
  label: 'Join Neighbors',
  description: 'Combines two neighbor index arrays via intersection or union.',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { operation: 'intersection' },
  compile: (nodeId, config, inputs) => {
    const a = inputs['a'] || '[]';
    const b = inputs['b'] || '[]';
    const op = config.operation as string;
    if (op === 'union') {
      // Deduplicated union via Set (acceptable for small neighborhood sizes)
      return `const _v${nodeId} = Array.from(new Set(${a}.concat(${b})));\n`;
    }
    // intersection: keep only elements present in both
    const ji = `_ji${nodeId}`;
    return [
      `_v${nodeId}_result.length = 0; let _v${nodeId}_resLen = 0;`,
      `for (let ${ji} = 0; ${ji} < ${a}.length; ${ji}++) {`,
      `  if (${b}.indexOf(${a}[${ji}]) >= 0) _v${nodeId}_result[_v${nodeId}_resLen++] = ${a}[${ji}];`,
      `}`,
    ].join(' ') + '\n';
  },
};
