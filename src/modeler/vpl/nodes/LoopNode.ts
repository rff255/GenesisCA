import type { NodeTypeDef } from '../types';

export const LoopNode: NodeTypeDef = {
  type: 'loop',
  label: 'Loop',
  description: 'Repeats the BODY flow. Count mode: N times, Index = 0..N-1. Range mode: Index runs From..To (inclusive, ascending; From > To runs zero times). Index is only meaningful inside the BODY.',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'count', label: 'Count', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '1' },
    // Range mode (config.mode === 'range'): the counter runs From..To INCLUSIVE
    // instead of 0..Count-1 — the natural shape for "for i = n to m" model logic.
    { id: 'from', label: 'From', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'to', label: 'To', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '9' },
    // DONE renders first among outputs (aligned with DO) so chained nodes keep
    // a horizontal through-line; BODY hangs below.
    { id: 'next', label: 'DONE', kind: 'output', category: 'flow' },
    { id: 'body', label: 'BODY', kind: 'output', category: 'flow' },
    // The per-iteration counter (0..Count-1, or From..To in range mode). Like
    // ForEachInArray's `index`, it is only in scope inside the BODY chain — the
    // compilers pin its consumers inside the loop (sinkAnalysis
    // elementDependents + NEVER_INVARIANT).
    { id: 'index', label: 'Index', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // Mode-dependent dead ports (UI-only; the compilers read `mode` and ignore
  // the hidden side): Count mode hides From/To, Range mode hides Count.
  hiddenPorts: (config) => (config.mode === 'range' ? ['count'] : ['from', 'to']),
  defaultConfig: { mode: 'count' },
  compile: () => '', // Compiler handles flow nodes specially
};
