import type { NodeTypeDef } from '../types';

/** Write a specific neighbor's orientation. Async-only (sync mode would
 *  have the post-step bulk copy overwrite neighbor writes). The boundary
 *  guard `if (_ni < total)` protects the constant-boundary sentinel cell. */
export const SetNeighborOrientationNode: NodeTypeDef = {
  type: 'setNeighborOrientation',
  label: 'Set Neighbor Orientation',
  description: "Writes a value to one neighbor's orientation. Async-only — sync mode's post-step copy would overwrite the write. Wraps the value via &amp; 3.",
  category: 'output',
  color: '#1976d2',
  requirements: { async: true, variegated: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: { neighborhoodId: '' },
  compile: (nodeId, config, inputs) => {
    const nbrId = (config.neighborhoodId as string) || '_undef';
    const index = inputs['index'] || '0';
    const value = inputs['value'] || '0';
    return [
      `{`,
      `  const _ni${nodeId} = nIdx_${nbrId}[idx * nSz_${nbrId} + ((${index}) | 0)] | 0;`,
      `  if (_ni${nodeId} < total) w_orientation[_ni${nodeId}] = (${value}) & 3;`,
      `}`,
    ].join(' ') + '\n';
  },
};
