import type { NodeTypeDef } from '../types';

export const GetRandomNode: NodeTypeDef = {
  type: 'getRandom',
  label: 'Get Random',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { randomType: 'float', min: '0', max: '1' },
  compile: (nodeId, config) => {
    const type = config.randomType as string;
    const min = config.min as string || '0';
    const max = config.max as string || '1';
    if (type === 'bool') {
      return `const _v${nodeId} = Math.random() > 0.5;\n`;
    } else if (type === 'integer') {
      return `const _v${nodeId} = Math.floor(Math.random() * (${max} - ${min} + 1)) + ${min};\n`;
    } else {
      return `const _v${nodeId} = Math.random() * (${max} - ${min}) + ${min};\n`;
    }
  },
};
