import type { NodeTypeDef } from '../types';

/** Write the current cell's orientation. The value is clamped to 0..3 via
 *  `& 3` so any integer input produces a valid rotation. Sync mode: the
 *  write lands in `w_orientation` and becomes visible after the post-step
 *  swap. Async mode: writes go directly to the shared buffer (visible to
 *  subsequent cells in the same generation). */
export const SetOrientationNode: NodeTypeDef = {
  type: 'setOrientation',
  label: 'Set Orientation',
  description: "Writes the current cell's orientation (0-3 = 0/90/180/270&deg; clockwise). Values outside 0-3 are wrapped via &amp; 3.",
  category: 'output',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs) => {
    const value = inputs['value'] || '0';
    return `w_orientation[idx] = (${value}) & 3;\n`;
  },
};
