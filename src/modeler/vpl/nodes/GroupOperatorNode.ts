import type { NodeTypeDef } from '../types';

export const GroupOperatorNode: NodeTypeDef = {
  type: 'groupOperator',
  label: 'Group Reduce',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'values', label: 'Values', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
    { id: 'index', label: 'Index', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { operation: 'sum' },
  compile: (nodeId, config, inputs) => {
    const values = inputs['values'] || '[]';
    const op = config.operation as string;
    const gi = `_gi${nodeId}`;

    if (op === 'random') {
      return [
        `const _v${nodeId}_index = Math.floor(Math.random() * ${values}.length);`,
        `const _v${nodeId}_result = ${values}[_v${nodeId}_index];`,
      ].join(' ') + '\n';
    }
    if (op === 'max') {
      return [
        `let _v${nodeId}_index = 0;`,
        `for (let ${gi} = 1; ${gi} < ${values}.length; ${gi}++) { if (${values}[${gi}] > ${values}[_v${nodeId}_index]) _v${nodeId}_index = ${gi}; }`,
        `const _v${nodeId}_result = ${values}[_v${nodeId}_index];`,
      ].join(' ') + '\n';
    }
    if (op === 'min') {
      return [
        `let _v${nodeId}_index = 0;`,
        `for (let ${gi} = 1; ${gi} < ${values}.length; ${gi}++) { if (${values}[${gi}] < ${values}[_v${nodeId}_index]) _v${nodeId}_index = ${gi}; }`,
        `const _v${nodeId}_result = ${values}[_v${nodeId}_index];`,
      ].join(' ') + '\n';
    }

    let expr: string;
    switch (op) {
      case 'mul':  expr = `${values}.reduce((s,v) => s * v, 1)`; break;
      case 'mean': expr = `(${values}.reduce((s,v) => s + v, 0) / (${values}.length || 1))`; break;
      case 'and':  expr = `${values}.every(Boolean)`; break;
      case 'or':   expr = `${values}.some(Boolean)`; break;
      default:     expr = `${values}.reduce((s,v) => s + v, 0)`; break; // sum
    }
    return `const _v${nodeId}_index = -1; const _v${nodeId}_result = ${expr};\n`;
  },
};
