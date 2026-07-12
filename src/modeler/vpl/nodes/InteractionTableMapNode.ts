import type { NodeTypeDef } from '../types';
import { lookupNodeDims, lookupNodeMins } from './LookupInteractionNode';

/** Vectorised Table Lookup over parallel index arrays.
 *
 *  Inputs: `myFaces` (row indices) + `theirFaces` (column indices) — parallel
 *  int arrays, typically the two outputs of `Get All Facing Labels` in
 *  cardinal-only mode, but any parallel index arrays work. Output: `values`
 *  (float array, one lookup per slot).
 *
 *  Equivalent to N scalar `Table Lookup` chains, but as a single node and a
 *  single per-cell loop. The canonical chemistry idiom — book §2.3.5 / §2.3.6
 *  J and P_B factors aggregated per direction — drops to two `Table Map` +
 *  `Aggregate` pipelines instead of an unrolled per-direction subgraph.
 *
 *  The output array length matches the shorter of the two input arrays, so
 *  mismatched-length feeds degrade gracefully. Out-of-range indices read
 *  uninitialised table memory (same trust model as the scalar `Table Lookup`).
 */
export const InteractionTableMapNode: NodeTypeDef = {
  type: 'interactionTableMap',
  label: 'Table Map',
  description: 'Vectorised Table Lookup: indexes a Lookup Table model attribute by two parallel index arrays (rows + cols), returns an array of the looked-up values (numbers matching the table’s value type).',
  category: 'data',
  color: '#1976d2',
  ports: [
    { id: 'myFaces', label: 'Rows', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'theirFaces', label: 'Cols', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'float', isArray: true },
  ],
  defaultConfig: { tableId: '' },
  compile: (nodeId, config, inputs) => {
    const tableId = (config.tableId as string) || '';
    const myFaces = inputs['myFaces'] || '[]';
    const theirFaces = inputs['theirFaces'] || '[]';
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
    const dims = lookupNodeDims(config);
    if (dims) {
      // Multi-axis table: supported ONLY when it has exactly 2 axes (the node's
      // shape is two parallel index arrays). N≠2 is rejected by nodeValidation +
      // the compilers' pre-resolve; emit an empty array defensively here.
      if (dims.length !== 2) return `${out}.length = 0;\n`;
      const mins = lookupNodeMins(config);
      const d0 = Math.max(1, Math.floor(Number(dims[0]) || 1));
      const d1 = Math.max(1, Math.floor(Number(dims[1]) || 1));
      const m0 = Math.floor(Number(mins[0]) || 0);
      const m1 = Math.floor(Number(mins[1]) || 0);
      const rawA = m0 !== 0 ? `((${myFaces}[${i}]) | 0) - ${m0}` : `(${myFaces}[${i}]) | 0`;
      const rawB = m1 !== 0 ? `((${theirFaces}[${i}]) | 0) - ${m1}` : `(${theirFaces}[${i}]) | 0`;
      return [
        `${out}.length = 0;`,
        `const ${tbl} = _lookupTables[${JSON.stringify(tableId)}];`,
        `if (${tbl}) {`,
        `  const ${n} = Math.min(${myFaces}.length, ${theirFaces}.length);`,
        `  for (let ${i} = 0; ${i} < ${n}; ${i}++) {`,
        `    const ${a} = Math.min(Math.max(${rawA}, 0), ${d0 - 1});`,
        `    const ${b} = Math.min(Math.max(${rawB}, 0), ${d1 - 1});`,
        `    ${out}[${i}] = ${tbl}[${a} * ${d1} + ${b}] || 0;`,
        `  }`,
        `}`,
      ].join(' ') + '\n';
    }
    // Legacy 2-axis — BYTE-IDENTICAL to the pre-N-D emit (no clamp).
    // colCount = column key source's label count (row-major stride).
    const colCount = Number(config._colCount) || 1;
    return [
      `${out}.length = 0;`,
      `const ${tbl} = _lookupTables[${JSON.stringify(tableId)}];`,
      `if (${tbl}) {`,
      `  const ${n} = Math.min(${myFaces}.length, ${theirFaces}.length);`,
      `  for (let ${i} = 0; ${i} < ${n}; ${i}++) {`,
      `    const ${a} = (${myFaces}[${i}]) | 0;`,
      `    const ${b} = (${theirFaces}[${i}]) | 0;`,
      `    ${out}[${i}] = ${tbl}[${a} * ${colCount} + ${b}] || 0;`,
      `  }`,
      `}`,
    ].join(' ') + '\n';
  },
};
