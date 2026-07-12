import type { NodeTypeDef } from '../types';

/** Overseer data — the canonical parameter-sweep driver: an array of values to
 *  iterate with For Each In Array (each iteration typically Sets a model
 *  attribute, runs K replicates, and aggregates). Two modes:
 *  - linspace: `steps` evenly spaced values from `from` to `to` (inclusive).
 *  - list: an explicit comma-separated list ("1, 2, 5, 10"). */
export const OvSweepValuesNode: NodeTypeDef = {
  type: 'ovSweepValues',
  label: 'Sweep Values',
  description: 'An array of parameter values to sweep — evenly spaced (linspace) or an explicit list. Feed into For Each In Array; set a model attribute per iteration.',
  category: 'data',
  color: '#6a1b9a',
  requirements: { overseer: true },
  ports: [
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'float', isArray: true },
  ],
  defaultConfig: { mode: 'list', list: '1, 2, 5, 10', from: '0', to: '1', steps: '5' },
  compile: (nodeId, config) => {
    if (config.mode === 'linspace') {
      const from = parseFloat(String(config.from ?? '0')) || 0;
      const to = parseFloat(String(config.to ?? '1')) || 0;
      const steps = Math.max(1, Math.floor(parseFloat(String(config.steps ?? '5')) || 1));
      return `const _v${nodeId} = O.linspace(${from}, ${to}, ${steps});\n`;
    }
    const list = String(config.list ?? '')
      .split(',')
      .map(s => parseFloat(s.trim()))
      .filter(n => Number.isFinite(n));
    return `const _v${nodeId} = [${list.join(', ')}];\n`;
  },
};
