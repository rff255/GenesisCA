import type { NodeTypeDef } from '../types';

/** Write the orientation of the cell touching this one in a fixed direction.
 *
 *  Configured by a single `directionTag` (N/NE/E/SE/S/SW/W/NW). Async-only —
 *  sync mode's post-step bulk copy would overwrite the neighbour write.
 *  Mirrors `GetFacingOrientation`'s surface. The `& 3` wrap matches
 *  `SetOrientation`. */
export const SetFacingOrientationNode: NodeTypeDef = {
  type: 'setFacingOrientation',
  label: 'Set Facing Orientation',
  description: "Writes a value to the orientation of the neighbour touching this cell in a fixed direction. Async-only; wraps the value via &amp; 3.",
  category: 'output',
  color: '#1976d2',
  requirements: { async: true, variegated: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { directionTag: '' },
  compile: (nodeId, config, inputs) => {
    const value = inputs['value'] || '0';
    const dirIdx = Number(config._resolvedDirIdx);
    const dr = Number(config._resolvedDr);
    const dc = Number(config._resolvedDc);
    const boundary = (config._boundaryTreatment as string) || 'torus';
    if (!Number.isFinite(dirIdx) || dirIdx < 0) {
      return '';
    }
    const nci = (boundary === 'constant')
      ? `((_nRowSF${nodeId} >= 0 && _nRowSF${nodeId} < H && _nColSF${nodeId} >= 0 && _nColSF${nodeId} < W) ? (_nRowSF${nodeId} * W + _nColSF${nodeId}) : total)`
      : `((((_row + (${dr})) % H + H) % H) * W + (((_col + (${dc})) % W + W) % W))`;
    const lines: string[] = ['{'];
    if (boundary === 'constant') {
      lines.push(
        `  const _nRowSF${nodeId} = _row + (${dr});`,
        `  const _nColSF${nodeId} = _col + (${dc});`,
      );
    }
    lines.push(
      `  const _nciSF${nodeId} = ${nci};`,
      `  if (_nciSF${nodeId} < total) w_orientation[_nciSF${nodeId}] = (${value}) & 3;`,
      `}`,
    );
    return lines.join(' ') + '\n';
  },
};
