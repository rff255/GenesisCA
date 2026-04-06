import type { NodeTypeDef } from '../types';

export const GetConstantNode: NodeTypeDef = {
  type: 'getConstant',
  label: 'Get Constant',
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
    } else {
      value = String(parseInt(raw, 10) || 0);
    }
    return `const _v${nodeId} = ${value};\n`;
  },
};
