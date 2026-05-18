import type { NodeTypeDef } from '../types';

/** Resolve the two face labels touching at a 1-step neighbour encounter in a
 *  fixed direction.
 *
 *  Configured by a single `directionTag` (N/NE/E/SE/S/SW/W/NW). Face encounters
 *  are intrinsic to the spatial structure of the grid (one step in one of 8
 *  fixed directions), so this node does NOT take a neighborhood — it computes
 *  the touching cell directly from the chosen direction's (dr, dc) offset,
 *  honouring the model's boundary treatment.
 *
 *  Outputs:
 *    myFaceLabel    — this cell's face touching the neighbour
 *    theirFaceLabel — the neighbour's face touching this cell
 *  Both are face-label indices into `['none', ...faceLabels]` (`0` = `none`,
 *  `1+` = user-defined labels).
 *
 *  Rotation arithmetic: a cell rotated `k * 90&deg;` has its original slot
 *  `s` now pointing in direction `(s + 2k) mod 8`. To find the face
 *  CURRENTLY pointing at direction `d` we read the slot that ROTATED into
 *  direction `d`: `(d + 2k) & 7`. */
export const GetFacingLabelsNode: NodeTypeDef = {
  type: 'getFacingLabels',
  label: 'Get Facing Labels',
  description: 'Resolves the two face labels touching at a 1-step neighbour encounter in a fixed direction (N/E/S/W/diagonals) — accounts for both cells’ orientations and face patterns. Does not use a neighborhood.',
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'myFaceLabel', label: 'My Face', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'theirFaceLabel', label: 'Their Face', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { directionTag: '' },
  compile: (nodeId, config, _inputs, _boundary, _ctx) => {
    // Pre-resolved by compile.ts preResolveVariegatedNodes:
    //   _resolvedDirIdx — direction index 0..7 (or -1 if unset)
    //   _resolvedDr / _resolvedDc — the (dr, dc) offset for the chosen direction
    //   _boundaryTreatment — copied from model.properties so the emit can pick
    //                        the torus-wrap vs constant-clamp shape
    //   _sourceAttrId    — variegation source attribute id (for species lookup)
    const dirIdx = Number(config._resolvedDirIdx);
    const dr = Number(config._resolvedDr);
    const dc = Number(config._resolvedDc);
    const boundary = (config._boundaryTreatment as string) || 'torus';
    const sourceAttrId = (config._sourceAttrId as string) || '';
    if (!Number.isFinite(dirIdx) || dirIdx < 0) {
      return [
        `const _v${nodeId}_myFaceLabel = 0;`,
        `const _v${nodeId}_theirFaceLabel = 0;`,
      ].join(' ') + '\n';
    }
    // Inline neighbour-cell index. Both branches resolve out-of-bounds to
    // `total` (the boundary sentinel cell) — for torus we never go out of
    // bounds via the modulo wrap; for constant we use total when (nRow, nCol)
    // falls outside the grid.
    const nci = (boundary === 'constant')
      ? `((_nRow${nodeId} >= 0 && _nRow${nodeId} < H && _nCol${nodeId} >= 0 && _nCol${nodeId} < W) ? (_nRow${nodeId} * W + _nCol${nodeId}) : total)`
      : `((((_row + (${dr})) % H + H) % H) * W + (((_col + (${dc})) % W + W) % W))`;
    const myAttrRead = sourceAttrId ? `r_${sourceAttrId}[idx] | 0` : '0';
    const theirAttrRead = sourceAttrId ? `r_${sourceAttrId}[_nci${nodeId}] | 0` : '0';
    const lines: string[] = [];
    if (boundary === 'constant') {
      lines.push(
        `const _nRow${nodeId} = _row + (${dr});`,
        `const _nCol${nodeId} = _col + (${dc});`,
      );
    }
    lines.push(
      `const _nci${nodeId} = ${nci};`,
      `const _myFace${nodeId} = (${dirIdx} + 2 * (r_orientation[idx] | 0)) & 7;`,
      `const _theirFace${nodeId} = (((${dirIdx} + 4) & 7) + 2 * (r_orientation[_nci${nodeId}] | 0)) & 7;`,
      `const _mySpec${nodeId} = ${myAttrRead};`,
      `const _theirSpec${nodeId} = ${theirAttrRead};`,
      `const _v${nodeId}_myFaceLabel = (_mySpec${nodeId} < 0) ? 0 : (_facePatternLookup[_mySpec${nodeId} * 8 + _myFace${nodeId}] | 0);`,
      `const _v${nodeId}_theirFaceLabel = (_nci${nodeId} >= total) ? 0 : (_facePatternLookup[_theirSpec${nodeId} * 8 + _theirFace${nodeId}] | 0);`,
    );
    return lines.join(' ') + '\n';
  },
};
