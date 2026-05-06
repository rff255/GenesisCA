import type { NodeTypeDef } from '../types';
import {
  DEFAULT_INTERPOLATION_METHOD,
  curvedTVarName,
  emitInterpolationCurveJS,
} from './interpolationMethods';

export const ProportionMapNode: NodeTypeDef = {
  type: 'proportionMap',
  label: 'Proportion Map',
  description: 'Maps X from one range to another using a selectable interpolation curve.',
  category: 'logic',
  color: '#b8860b',
  ports: [
    { id: 'x', label: 'X', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'inMin', label: 'In Min', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'inMax', label: 'In Max', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '1' },
    { id: 'outMin', label: 'Out Min', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'outMax', label: 'Out Max', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '1' },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { method: DEFAULT_INTERPOLATION_METHOD },
  compile: (nodeId, config, inputs) => {
    const x = inputs['x'] || '0';
    const inMin = inputs['inMin'] || '0';
    const inMax = inputs['inMax'] || '1';
    const outMin = inputs['outMin'] || '0';
    const outMax = inputs['outMax'] || '1';
    const method = (config.method as string) || DEFAULT_INTERPOLATION_METHOD;
    // Raw t = (x - inMin) / (inMax - inMin), guarded against zero span.
    const tRawExpr = `((${inMax}) - (${inMin})) !== 0 ? ((${x}) - (${inMin})) / ((${inMax}) - (${inMin})) : 0`;
    const curveSetup = emitInterpolationCurveJS(nodeId, tRawExpr, method);
    const tf = curvedTVarName(nodeId);
    return `${curveSetup} const _v${nodeId} = ((${inMax}) - (${inMin})) !== 0 ? (${outMin}) + ${tf} * ((${outMax}) - (${outMin})) : (${outMin});\n`;
  },
};
