import type { NodeTypeDef } from '../types';

/** Vectorised LookupInteraction over parallel face-label arrays.
 *
 *  Inputs: `myFaces` + `theirFaces` (parallel int arrays — typically the two
 *  outputs of `Get All Facing Labels` in cardinal-only mode). Output: `values`
 *  (float array, one lookup per slot).
 *
 *  Equivalent to N scalar `LookupInteraction` chains, but as a single node and
 *  a single per-cell loop instead of N wired pairs. The canonical chemistry
 *  idiom — book §2.3.5 / §2.3.6 J and P_B factors aggregated per direction —
 *  drops to two `InteractionTableMap` + `Aggregate` pipelines instead of an
 *  unrolled per-direction subgraph.
 *
 *  The output array length matches the shorter of the two input arrays, so
 *  mismatched-length feeds degrade gracefully instead of crashing. Out-of-range
 *  labels read uninitialised table memory (same trust model as the scalar
 *  `LookupInteraction` — practical models stay within [0, labelCount)).
 */
export const InteractionTableMapNode: NodeTypeDef = {
  type: 'interactionTableMap',
  label: 'Interaction Table Map',
  description: 'Vectorised LookupInteraction: indexes an Interaction Table model attribute by two parallel face-label arrays, returns a float array of looked-up values.',
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'myFaces', label: 'My Faces', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'theirFaces', label: 'Their Faces', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'float', isArray: true },
  ],
  defaultConfig: { tableId: '' },
  compile: (nodeId, config, inputs) => {
    const tableId = (config.tableId as string) || '';
    const myFaces = inputs['myFaces'] || '[]';
    const theirFaces = inputs['theirFaces'] || '[]';
    const labelCount = Number(config._labelCount) || 1;
    const out = `_v${nodeId}_vals`;
    if (!tableId) {
      // No table → output stays empty but at least the variable exists.
      return `${out}.length = 0;\n`;
    }
    const i = `_itm${nodeId}_i`;
    const n = `_itm${nodeId}_n`;
    const tbl = `_itm${nodeId}_t`;
    const a = `_itm${nodeId}_a`;
    const b = `_itm${nodeId}_b`;
    return [
      `${out}.length = 0;`,
      `const ${tbl} = _interactionTables[${JSON.stringify(tableId)}];`,
      `if (${tbl}) {`,
      `  const ${n} = Math.min(${myFaces}.length, ${theirFaces}.length);`,
      `  for (let ${i} = 0; ${i} < ${n}; ${i}++) {`,
      `    const ${a} = (${myFaces}[${i}]) | 0;`,
      `    const ${b} = (${theirFaces}[${i}]) | 0;`,
      `    ${out}[${i}] = ${tbl}[${a} * ${labelCount} + ${b}] || 0;`,
      `  }`,
      `}`,
    ].join(' ') + '\n';
  },
};
