import type { NodeTypeDef } from '../types';

export const GetRandomNode: NodeTypeDef = {
  type: 'getRandom',
  label: 'Get Random',
  description: 'Generates a random bool (with probability), integer, or float.',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'probability', label: 'P', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { randomType: 'float', min: '0', max: '1' },
  compile: (nodeId, config, inputVars) => {
    const type = config.randomType as string;
    const min = config.min as string || '0';
    const max = config.max as string || '1';
    // Inlined xorshift32 (Marsaglia constants 13/17/5, period 2^32 - 1).
    // _rs is a uint32 declared once per compiled function; the >>> 0 normalises
    // after << overflow so the final divide by 2^32 lands in [0, 1).
    const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
      + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
      + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
    if (type === 'bool') {
      const prob = inputVars.probability ?? '0.5';
      return `${advance} const _v${nodeId} = (_rs / 4294967296) < ${prob} ? 1 : 0;\n`;
    } else if (type === 'integer') {
      return `${advance} const _v${nodeId} = Math.floor((_rs / 4294967296) * (${max} - ${min} + 1)) + ${min};\n`;
    } else {
      return `${advance} const _v${nodeId} = (_rs / 4294967296) * (${max} - ${min}) + ${min};\n`;
    }
  },
};
