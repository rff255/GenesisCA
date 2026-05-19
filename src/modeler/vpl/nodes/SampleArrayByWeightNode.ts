import type { NodeTypeDef } from '../types';

/** Pick one index from an input array of non-negative weights, sampled
 *  proportional to those weights (cumulative-sum sampling).
 *
 *  Inputs: `weights` (float array). Outputs: `index` (i32) + `weight` (f32 /
 *  f64) of the picked entry. When the array is empty or the sum of weights is
 *  zero, returns `index = -1`, `weight = 0` — caller gates on `>= 0` to detect
 *  "no valid sample".
 *
 *  The RNG draw advances ONCE per invocation, even when the array is empty or
 *  sum-of-weights is zero. This matches the always-advance semantics of every
 *  other random-using node so different control-flow branches that DO draw
 *  RNG stay in step across compile targets.
 *
 *  Algorithm: u = rand * sum; walk weights[i] accumulating into `acc`; first i
 *  where `u < acc` wins. Numerical-safety fallback: if floating drift puts u >=
 *  sum, return the last index instead of silently returning -1. */
export const SampleArrayByWeightNode: NodeTypeDef = {
  type: 'sampleArrayByWeight',
  label: 'Sample By Weight',
  description: 'Picks one array index sampled proportional to the input weights (cumulative-sum sampling). Returns the chosen index + its weight; index = -1 when the array is empty or sum-of-weights is zero.',
  category: 'aggregation',
  color: '#b71c1c',
  ports: [
    { id: 'weights', label: 'Weights', kind: 'input', category: 'value', dataType: 'float', isArray: true },
    { id: 'index', label: 'Index', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'weight', label: 'Weight', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const weights = inputs['weights'] || '[]';
    // Inlined xorshift32 (matches GetRandomNode).
    const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
      + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
      + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
    const w = `_sbw${nodeId}_w`;
    const sum = `_sbw${nodeId}_s`;
    const u = `_sbw${nodeId}_u`;
    const acc = `_sbw${nodeId}_a`;
    const i = `_sbw${nodeId}_i`;
    const idxVar = `_v${nodeId}_index`;
    const wtVar = `_v${nodeId}_weight`;
    return [
      `${advance}`,
      `const ${w} = ${weights};`,
      `let ${sum} = 0;`,
      `for (let ${i} = 0; ${i} < ${w}.length; ${i}++) ${sum} += ${w}[${i}];`,
      `let ${idxVar} = -1;`,
      `let ${wtVar} = 0;`,
      `if (${sum} > 0) {`,
      `  const ${u} = (_rs / 4294967296) * ${sum};`,
      `  let ${acc} = 0;`,
      `  for (let ${i} = 0; ${i} < ${w}.length; ${i}++) {`,
      `    ${acc} += ${w}[${i}];`,
      `    if (${u} < ${acc}) { ${idxVar} = ${i}; ${wtVar} = ${w}[${i}]; break; }`,
      `  }`,
      // Numerical-safety fallback: if u landed >= sum from FP drift, pick last.
      `  if (${idxVar} < 0) { ${idxVar} = ${w}.length - 1; ${wtVar} = ${w}[${w}.length - 1]; }`,
      `}`,
    ].join(' ') + '\n';
  },
};
