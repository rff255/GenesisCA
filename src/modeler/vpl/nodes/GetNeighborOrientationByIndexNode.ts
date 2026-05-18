import type { NodeTypeDef } from '../types';
import { niCellExprStmts, INVALID_NI } from '../compiler/niCodec';

/** Read one neighbour's orientation given a packed NeighborIndex. Mirrors
 *  `GetNeighborAttributeByIndex` — no neighborhood config, the NI carries the
 *  (dr, dc) offset inline. If given an array of NIs, takes element [0].
 *
 *  Guards against `INVALID_NI` (the "no neighbor" sentinel that
 *  `pickRandomNeighbor` returns on empty input and `arrayElement` returns on
 *  out-of-range): if the input is INVALID_NI (or an empty array), the result
 *  is `0`. Symmetric with `SetNeighborOrientationByIndex` which guards the
 *  same way. */
export const GetNeighborOrientationByIndexNode: NodeTypeDef = {
  type: 'getNeighborOrientationByIndex',
  label: 'Get Neighbor Orientation By Index',
  description: "Reads one neighbour's orientation at the given NeighborIndex (packed dr/dc). If given an array of indices, reads the first one. Returns 0 when the index is the INVALID_NI sentinel.",
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'value', label: 'Orientation', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs, boundary) => {
    const index = inputs['index'] || '0';
    const niExpr = `_ni${nodeId}`;
    const { stmts, cellExpr } = niCellExprStmts(niExpr, boundary || 'torus', `${nodeId}`);
    // Accept scalar or array (taking element 0). Empty array → INVALID_NI →
    // guard returns 0. Wrap in IIFE so `_v${nodeId}` stays const without leaking
    // niCellExpr locals into the surrounding scope.
    return `const _v${nodeId} = (() => {`
      + ` const _idx${nodeId} = ${index};`
      + ` const ${niExpr} = (Array.isArray(_idx${nodeId}) ? (_idx${nodeId}.length > 0 ? (_idx${nodeId}[0] | 0) : ${INVALID_NI}) : (_idx${nodeId} | 0));`
      + ` if (${niExpr} === ${INVALID_NI}) return 0;`
      + ` ${stmts}`
      + ` return r_orientation[${cellExpr}] | 0;`
      + ` })();\n`;
  },
};
