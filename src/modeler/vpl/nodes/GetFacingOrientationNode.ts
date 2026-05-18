import type { NodeTypeDef } from '../types';

/** Read the orientation of the cell touching this one in a fixed direction.
 *
 *  Configured by a single `directionTag` (N/NE/E/SE/S/SW/W/NW). Face encounters
 *  are intrinsic to the spatial structure of the grid (one step in one of 8
 *  fixed directions), so this node does NOT take a neighborhood — it computes
 *  the touching cell directly from the chosen direction's (dr, dc) offset,
 *  honouring the model's boundary treatment. Mirrors `GetFacingLabels`'
 *  surface. */
export const GetFacingOrientationNode: NodeTypeDef = {
  type: 'getFacingOrientation',
  label: 'Get Facing Orientation',
  description: "Reads the orientation of the neighbour touching this cell in a fixed direction (N/E/S/W/diagonals). Does not use a neighborhood.",
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'value', label: 'Orientation', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { directionTag: '' },
  compile: (nodeId, config) => {
    // Pre-resolved by compile.ts preResolveVariegatedNodes:
    //   _resolvedDirIdx — direction index 0..7 (or -1 if unset)
    //   _resolvedDr / _resolvedDc — the (dr, dc) offset for the chosen direction
    //   _boundaryTreatment — copied from model.properties.
    const dirIdx = Number(config._resolvedDirIdx);
    const dr = Number(config._resolvedDr);
    const dc = Number(config._resolvedDc);
    const boundary = (config._boundaryTreatment as string) || 'torus';
    if (!Number.isFinite(dirIdx) || dirIdx < 0) {
      return `const _v${nodeId} = 0;\n`;
    }
    const nci = (boundary === 'constant')
      ? `((_nRowGF${nodeId} >= 0 && _nRowGF${nodeId} < H && _nColGF${nodeId} >= 0 && _nColGF${nodeId} < W) ? (_nRowGF${nodeId} * W + _nColGF${nodeId}) : total)`
      : `((((_row + (${dr})) % H + H) % H) * W + (((_col + (${dc})) % W + W) % W))`;
    const lines: string[] = [];
    if (boundary === 'constant') {
      lines.push(
        `const _nRowGF${nodeId} = _row + (${dr});`,
        `const _nColGF${nodeId} = _col + (${dc});`,
      );
    }
    lines.push(
      `const _nciGF${nodeId} = ${nci};`,
      `const _v${nodeId} = r_orientation[_nciGF${nodeId}] | 0;`,
    );
    return lines.join(' ') + '\n';
  },
};
