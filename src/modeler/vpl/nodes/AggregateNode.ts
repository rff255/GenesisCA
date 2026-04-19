import type { NodeTypeDef } from '../types';

export const AggregateNode: NodeTypeDef = {
  type: 'aggregate',
  label: 'Aggregate',
  description: 'Combines multiple connections into one (sum, product, max, min, average, median, AND, OR).',
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
    // Helper names use the _v{id}_* pattern so the macro inliner's existing
    // prefix-replace catches them when this node lives inside a macro.
    const acc = `_v${nodeId}`;
    const arr = `_v${nodeId}_a`;
    const len = `_v${nodeId}_n`;
    const i = `_v${nodeId}_i`;
    // Bind input once: avoids re-evaluating multi-source array literals,
    // and gives V8 a stable shape to optimize the loop against.
    const head = `const ${arr} = ${values}; const ${len} = ${arr}.length;`;
    switch (op) {
      case 'product': return [
        head,
        `let ${acc} = 1;`,
        `for (let ${i} = 0; ${i} < ${len}; ${i}++) ${acc} *= ${arr}[${i}];`,
      ].join(' ') + '\n';
      case 'max': return [
        head,
        `let ${acc} = -Infinity;`,
        `for (let ${i} = 0; ${i} < ${len}; ${i}++) if (${arr}[${i}] > ${acc}) ${acc} = ${arr}[${i}];`,
      ].join(' ') + '\n';
      case 'min': return [
        head,
        `let ${acc} = Infinity;`,
        `for (let ${i} = 0; ${i} < ${len}; ${i}++) if (${arr}[${i}] < ${acc}) ${acc} = ${arr}[${i}];`,
      ].join(' ') + '\n';
      case 'average': return [
        head,
        `let _v${nodeId}_s = 0;`,
        `for (let ${i} = 0; ${i} < ${len}; ${i}++) _v${nodeId}_s += ${arr}[${i}];`,
        `const ${acc} = ${len} > 0 ? _v${nodeId}_s / ${len} : 0;`,
      ].join(' ') + '\n';
      case 'median': return [
        head,
        `const _v${nodeId}_sorted = ${arr}.slice().sort(function(a,b){return a-b});`,
        `const ${acc} = ${len} === 0 ? 0 : (${len} % 2 === 0`,
        `  ? (_v${nodeId}_sorted[${len}/2-1] + _v${nodeId}_sorted[${len}/2]) / 2`,
        `  : _v${nodeId}_sorted[(${len}-1)/2|0]);`,
      ].join(' ') + '\n';
      case 'and': return [
        head,
        `let ${acc} = 1;`,
        `for (let ${i} = 0; ${i} < ${len}; ${i}++) if (!${arr}[${i}]) { ${acc} = 0; break; }`,
      ].join(' ') + '\n';
      case 'or': return [
        head,
        `let ${acc} = 0;`,
        `for (let ${i} = 0; ${i} < ${len}; ${i}++) if (${arr}[${i}]) { ${acc} = 1; break; }`,
      ].join(' ') + '\n';
      default: return [ // sum
        head,
        `let ${acc} = 0;`,
        `for (let ${i} = 0; ${i} < ${len}; ${i}++) ${acc} += ${arr}[${i}];`,
      ].join(' ') + '\n';
    }
  },
};
