import type { NodeTypeDef } from '../types';

/** Resolve the face labels touching at a given neighbor encounter.
 *
 *  Inputs: neighborhood (config) + slot index (0..nbrSize-1 — runtime
 *  value). Outputs: `myFaceLabel` (this cell's face touching the neighbor)
 *  and `theirFaceLabel` (the neighbor's face touching this cell). Both
 *  are face-label indices into `['none', ...faceLabels]` (`0` = `none`,
 *  `1+` = user-defined labels).
 *
 *  Compile-time inputs come from the main compile.ts loop:
 *  - `_sourceAttrId`: the variegation source attribute's id (read for both
 *    cells to get their species index).
 *  - `_directionMap`: JSON-encoded `int[]` mapping slot index → direction
 *    index (0..7 for cardinal/diagonal, -1 otherwise). Baked from the
 *    neighborhood's tags using `DIRECTION_TAGS`.
 *
 *  Rotation arithmetic: a cell rotated `k * 90°` has its original slot
 *  `s` now pointing in direction `(s + 2k) mod 8`. To find the face
 *  CURRENTLY pointing at direction `d` we invert: `s = (d - 2k) mod 8`,
 *  but since the lookup is indexed by post-rotation slot we emit
 *  `(d + 2k) & 7` — which reads the slot that ROTATED into direction `d`,
 *  matching the spec's worked example for water-aabb encounters. */
export const GetFacingLabelsNode: NodeTypeDef = {
  type: 'getFacingLabels',
  label: 'Get Facing Labels',
  description: 'Resolves the two face labels touching at a neighbor encounter — accounts for both cells\' orientations and face patterns.',
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'myFaceLabel', label: 'My Face', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'theirFaceLabel', label: 'Their Face', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { neighborhoodId: '' },
  compile: (nodeId, config, inputs) => {
    const nbrId = (config.neighborhoodId as string) || '_undef';
    const index = inputs['index'] || '0';
    // Pre-resolved by the compile.ts main loop (see preResolveVariegatedNodes).
    // Fall back to '0'/'[]' when the model lacks a variegation source —
    // every read collapses to the implicit `none` label (index 0).
    const sourceAttrId = (config._sourceAttrId as string) || '';
    const directionMapJson = (config._directionMap as string) || '[]';
    const myAttrRead = sourceAttrId ? `r_${sourceAttrId}[idx] | 0` : '0';
    const theirAttrRead = sourceAttrId ? `r_${sourceAttrId}[_nci${nodeId}] | 0` : '0';
    return [
      `const _ni${nodeId} = ((${index}) | 0);`,
      `const _nci${nodeId} = nIdx_${nbrId}[idx * nSz_${nbrId} + _ni${nodeId}] | 0;`,
      `const _dmap${nodeId} = ${directionMapJson};`,
      `const _dir${nodeId} = (_ni${nodeId} >= 0 && _ni${nodeId} < _dmap${nodeId}.length) ? (_dmap${nodeId}[_ni${nodeId}] | 0) : -1;`,
      `const _myFace${nodeId} = (_dir${nodeId} + 2 * (r_orientation[idx] | 0)) & 7;`,
      `const _theirFace${nodeId} = (((_dir${nodeId} + 4) & 7) + 2 * (r_orientation[_nci${nodeId}] | 0)) & 7;`,
      `const _mySpec${nodeId} = ${myAttrRead};`,
      `const _theirSpec${nodeId} = ${theirAttrRead};`,
      `const _v${nodeId}_myFaceLabel = (_dir${nodeId} < 0 || _mySpec${nodeId} < 0) ? 0 : (_facePatternLookup[_mySpec${nodeId} * 8 + _myFace${nodeId}] | 0);`,
      `const _v${nodeId}_theirFaceLabel = (_dir${nodeId} < 0 || _nci${nodeId} >= total) ? 0 : (_facePatternLookup[_theirSpec${nodeId} * 8 + _theirFace${nodeId}] | 0);`,
    ].join(' ') + '\n';
  },
};
