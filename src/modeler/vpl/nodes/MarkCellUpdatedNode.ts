import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

/** Async-only: marks the cell at the given NeighborIndex as already-updated
 *  for the rest of this generation. The scheduler tests this flag at the top
 *  of each cell iteration and skips the body when set. Used for movement /
 *  particle-conservation models where a cell that "moves into" a neighbor
 *  doesn't want that neighbor to take another turn the same step.
 *
 *  Sync mode has no scheduling concept (all cells run from the same read
 *  buffer in parallel), so this node is async-only — `requirements.async`
 *  drives the validator badge. WebGPU rejects async entirely, so we don't
 *  need a WGSL emitter either.
 *
 *  Mirrors SetNeighborAttributeByIndex's scalar+array branching. */
export const MarkCellUpdatedNode: NodeTypeDef = {
  type: 'markCellUpdated',
  label: 'Mark Cell Updated',
  description: 'Marks the cell at the given NeighborIndex as already-updated for the rest of this generation, so the async scheduler skips it. Accepts an array of NeighborIndices to mark multiple cells at once. Async-only.',
  category: 'output',
  color: '#4a148c',
  requirements: { async: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs, boundary, ctx) => {
    const index = inputs['index'] || '0';
    const b = boundary || 'torus';
    const arrAccess = niCellExprStmts(`_mci${nodeId}`, b, `${nodeId}_a`, ctx?.is3d);
    const sclAccess = niCellExprStmts(`_mcs${nodeId}`, b, `${nodeId}_s`, ctx?.is3d);
    return [
      `const _mcs${nodeId} = (${index}) | 0;`,
      `if (Array.isArray(${index})) {`,
      `  for (let _mai${nodeId} = 0; _mai${nodeId} < (${index}).length; _mai${nodeId}++) {`,
      `    const _mci${nodeId} = ((${index})[_mai${nodeId}]) | 0;`,
      `    if (_mci${nodeId} !== ${0x80000000 | 0}) {`,
      `      ${arrAccess.stmts}`,
      `      if (${arrAccess.cellExpr} < total) _skipped[${arrAccess.cellExpr}] = 1;`,
      `    }`,
      `  }`,
      `} else if (_mcs${nodeId} !== ${0x80000000 | 0}) {`,
      `  ${sclAccess.stmts}`,
      `  if (${sclAccess.cellExpr} < total) _skipped[${sclAccess.cellExpr}] = 1;`,
      `}`,
    ].join(' ') + '\n';
  },
};
