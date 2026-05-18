import type { NodeTypeDef } from '../types';

export const GetConstantNode: NodeTypeDef = {
  type: 'getConstant',
  label: 'Get Constant',
  description: 'Emits a fixed value. Type selector picks the domain: bool, integer, float, tag, or orientation (0/90/180/270 with the directional picker).',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { constType: 'integer', constValue: '0' },
  compile: (nodeId, config) => {
    const type = config.constType as string;
    const raw = config.constValue as string;
    let value: string;
    if (type === 'bool') {
      // Use 1/0 for typed array compatibility (Uint8Array stores 0/1)
      value = raw === 'true' ? '1' : '0';
    } else if (type === 'float') {
      value = String(parseFloat(raw) || 0);
    } else if (type === 'orientation') {
      // Orientation is the integer 0..3 (N/E/S/W). Out-of-range falls back to 0
      // so a misconfigured node still emits a valid orientation value.
      const n = parseInt(raw, 10);
      value = String(Number.isFinite(n) && n >= 0 && n <= 3 ? n : 0);
    } else {
      value = String(parseInt(raw, 10) || 0);
    }
    return `const _v${nodeId} = ${value};\n`;
  },
};
