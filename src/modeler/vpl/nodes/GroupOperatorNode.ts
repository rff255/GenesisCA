import type { NodeTypeDef } from '../types';

export const GroupOperatorNode: NodeTypeDef = {
  type: 'groupOperator',
  label: 'Group Reduce',
  description: 'Reduces an array to a single value (sum, product, mean, min, max, AND, OR, random pick, weighted random pick).',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'values', label: 'Values', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
    { id: 'index', label: 'Position', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { operation: 'sum' },
  compile: (nodeId, config, inputs) => {
    const values = inputs['values'] || '[]';
    const op = config.operation as string;
    const gi = `_gi${nodeId}`;

    if (op === 'random') {
      // Uniform pick via the shared _rs xorshift32 stream (NOT Math.random) so JS
      // matches the WASM target and stays reproducible from a given RNG state.
      // Always advances the stream once (even on empty input) to mirror the
      // always-advance semantics of every other RNG-using node. index = -1,
      // result = 0 when the input array is empty. Same floor((_rs/2^32)*len)
      // formula WASM uses, so both targets pick the same index for a given state.
      const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
        + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
        + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
      return [
        `${advance}`,
        `let _v${nodeId}_index = -1; let _v${nodeId}_result = 0;`,
        `if (${values}.length > 0) { _v${nodeId}_index = Math.floor((_rs / 4294967296) * ${values}.length); _v${nodeId}_result = ${values}[_v${nodeId}_index]; }`,
      ].join(' ') + '\n';
    }
    if (op === 'weightedRandom') {
      // Cumulative-sum sampling over the input weights. Uses the shared _rs
      // xorshift32 stream so empty/zero-sum cells still advance the RNG once,
      // matching the always-advance semantics of every other RNG-using node.
      // index = -1, result = 0 when empty or sum == 0.
      const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
        + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
        + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
      const w = `_gw${nodeId}`;
      const sum = `_gs${nodeId}`;
      const u = `_gu${nodeId}`;
      const acc = `_ga${nodeId}`;
      return [
        `${advance}`,
        `const ${w} = ${values};`,
        `let ${sum} = 0;`,
        `for (let ${gi} = 0; ${gi} < ${w}.length; ${gi}++) ${sum} += ${w}[${gi}];`,
        `let _v${nodeId}_index = -1;`,
        `let _v${nodeId}_result = 0;`,
        `if (${sum} > 0) {`,
        `  const ${u} = (_rs / 4294967296) * ${sum};`,
        `  let ${acc} = 0;`,
        `  for (let ${gi} = 0; ${gi} < ${w}.length; ${gi}++) {`,
        `    ${acc} += ${w}[${gi}];`,
        `    if (${u} < ${acc}) { _v${nodeId}_index = ${gi}; _v${nodeId}_result = ${w}[${gi}]; break; }`,
        `  }`,
        // Numerical-safety fallback: FP drift can put u >= sum; pick last.
        `  if (_v${nodeId}_index < 0) { _v${nodeId}_index = ${w}.length - 1; _v${nodeId}_result = ${w}[${w}.length - 1]; }`,
        `}`,
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
