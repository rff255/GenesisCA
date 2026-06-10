import type { NodeTypeDef } from '../types';

export const ForEachInArrayNode: NodeTypeDef = {
  type: 'forEachInArray',
  label: 'For Each In Array',
  description: 'Iterates over each element of an input array, running the BODY flow with the current element + 0-based index exposed via output ports.',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'array', label: 'Array', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    // DONE renders first among outputs (aligned with DO) so chained nodes keep
    // a horizontal through-line; BODY + the per-iteration Element/Index hang below.
    { id: 'next', label: 'DONE', kind: 'output', category: 'flow' },
    { id: 'body', label: 'BODY', kind: 'output', category: 'flow' },
    { id: 'element', label: 'Element', kind: 'output', category: 'value', dataType: 'any' },
    { id: 'index', label: 'Index', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: () => '', // Compiler handles flow nodes specially in compileFlowChain
};
