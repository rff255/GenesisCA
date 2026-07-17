import type { NodeTypeDef } from '../types';

export const LoopNode: NodeTypeDef = {
  type: 'loop',
  label: 'Loop',
  description: 'Repeats the BODY flow N times. Index outputs the current iteration (0-based) — only meaningful inside the BODY.',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'count', label: 'Count', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '1' },
    // DONE renders first among outputs (aligned with DO) so chained nodes keep
    // a horizontal through-line; BODY hangs below.
    { id: 'next', label: 'DONE', kind: 'output', category: 'flow' },
    { id: 'body', label: 'BODY', kind: 'output', category: 'flow' },
    // The per-iteration counter (0..Count-1). Like ForEachInArray's `index`,
    // it is only in scope inside the BODY chain — the compilers pin its
    // consumers inside the loop (sinkAnalysis elementDependents + NEVER_INVARIANT).
    { id: 'index', label: 'Index', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: () => '', // Compiler handles flow nodes specially
};
