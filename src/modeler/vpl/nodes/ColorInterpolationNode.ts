import type { NodeTypeDef } from '../types';
import {
  DEFAULT_INTERPOLATION_METHOD,
  curvedTVarName,
  emitInterpolationCurveJS,
} from './interpolationMethods';

export const ColorInterpolationNode: NodeTypeDef = {
  type: 'colorInterpolation',
  label: 'Color Interpolate',
  description: 'Interpolates between two RGB colors using T in [0, 1] with a selectable curve.',
  category: 'color',
  color: '#006064',
  ports: [
    { id: 't', label: 'Interp. Point', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
    { id: 'r1', label: 'From R', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'g1', label: 'From G', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'b1', label: 'From B', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'r2', label: 'To R', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
    { id: 'g2', label: 'To G', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
    { id: 'b2', label: 'To B', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
    { id: 'r', label: 'R', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'g', label: 'G', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'b', label: 'B', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { method: DEFAULT_INTERPOLATION_METHOD },
  compile: (nodeId, config, inputs) => {
    const t = inputs['t'] || '0.5';
    const r1 = inputs['r1'] || '0';
    const g1 = inputs['g1'] || '0';
    const b1 = inputs['b1'] || '0';
    const r2 = inputs['r2'] || '255';
    const g2 = inputs['g2'] || '255';
    const b2 = inputs['b2'] || '255';
    const method = (config.method as string) || DEFAULT_INTERPOLATION_METHOD;
    const curveSetup = emitInterpolationCurveJS(nodeId, t, method);
    const tf = curvedTVarName(nodeId);
    return [
      curveSetup,
      `const _v${nodeId}_r = Math.round((${r1}) + ${tf} * ((${r2}) - (${r1})));`,
      `const _v${nodeId}_g = Math.round((${g1}) + ${tf} * ((${g2}) - (${g1})));`,
      `const _v${nodeId}_b = Math.round((${b1}) + ${tf} * ((${b2}) - (${b1})));`,
    ].join(' ') + '\n';
  },
};
