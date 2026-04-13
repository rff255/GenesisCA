import type { NodeTypeDef } from '../types';

export const AggregateNode: NodeTypeDef = {
  type: 'aggregate',
  label: 'Aggregate',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'values', label: 'Values', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { operation: 'sum' },
  compile: (nodeId, config, inputs) => {
    const values = inputs['values'] || '[]';
    const op = config.operation as string;
    switch (op) {
      case 'product': return `const _v${nodeId} = ${values}.reduce(function(s,v){return s*v},1);\n`;
      case 'max':     return `const _v${nodeId} = ${values}.reduce(function(s,v){return s>v?s:v},-Infinity);\n`;
      case 'min':     return `const _v${nodeId} = ${values}.reduce(function(s,v){return s<v?s:v},Infinity);\n`;
      case 'average': return `const _v${nodeId} = ${values}.reduce(function(s,v){return s+v},0) / (${values}.length || 1);\n`;
      case 'median': {
        return [
          `const _agg${nodeId} = ${values}.slice().sort(function(a,b){return a-b});`,
          `const _v${nodeId} = _agg${nodeId}.length % 2 === 0`,
          `  ? (_agg${nodeId}[_agg${nodeId}.length/2-1] + _agg${nodeId}[_agg${nodeId}.length/2]) / 2`,
          `  : _agg${nodeId}[Math.floor(_agg${nodeId}.length/2)];`,
        ].join(' ') + '\n';
      }
      default: return `const _v${nodeId} = ${values}.reduce(function(s,v){return s+v},0);\n`; // sum
    }
  },
};
