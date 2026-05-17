import type { NodeTypeDef } from '../types';

/** Read the current cell's orientation (0..3 = 90&deg; CW rotations). The
 *  orientation buffer is auto-allocated when Variegated Cells is enabled;
 *  this node returns 0 in models that don't have it. */
export const GetOrientationNode: NodeTypeDef = {
  type: 'getOrientation',
  label: 'Get Orientation',
  description: "Reads the current cell's orientation (0-3 = 0/90/180/270&deg; clockwise rotation).",
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'value', label: 'Orientation', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId) => {
    return `const _v${nodeId} = r_orientation[idx] | 0;\n`;
  },
};
