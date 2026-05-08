import type { NodeTypeDef } from '../types';

export const FlipNeighborIndexNode: NodeTypeDef = {
  type: 'flipNeighborIndex',
  label: 'Flip Neighbor Index',
  description: 'Mirrors a NeighborIndex horizontally (negates dCol), vertically (negates dRow), or both. Returns -1 if the flipped offset is not in the configured neighborhood.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: { neighborhoodId: '', mode: 'horizontal' },
  compile: (nodeId, config, inputs) => {
    const idx = inputs['index'] || '0';
    // _resolvedFlipTable is a JSON array set by the compiler pre-pass: index N -> flipped slot
    // (or -1 if the flipped offset isn't present in the neighborhood). We emit a closure-scoped
    // Int32Array (allocated once before the per-cell loop via scratchNodes registration in
    // compileValueNode), and look up by input slot at runtime.
    const tableJSON = config._resolvedFlipTable as string | undefined;
    const table: number[] = tableJSON ? JSON.parse(tableJSON) : [];
    // Inline ternary chain for small neighborhoods (cheaper than allocating a per-cell array).
    // For very large neighborhoods (>32 slots) this becomes unwieldy; falls through to -1.
    if (table.length === 0) return `const _v${nodeId} = -1;\n`;
    const guarded = `(_flipIn${nodeId} | 0)`;
    let expr = '-1';
    for (let i = table.length - 1; i >= 0; i--) {
      expr = `(${guarded} === ${i} ? ${table[i]} : ${expr})`;
    }
    return [
      `const _flipIn${nodeId} = ${idx};`,
      `const _v${nodeId} = ${expr};`,
    ].join(' ') + '\n';
  },
};
