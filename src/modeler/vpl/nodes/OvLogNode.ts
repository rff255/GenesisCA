import type { NodeTypeDef } from '../types';

/** Overseer capture — write a line to the experiment Journal. The text
 *  template supports placeholders: {value} = the wired Value input (blank when
 *  unwired), {gen} = the current generation. */
export const OvLogNode: NodeTypeDef = {
  type: 'ovLog',
  label: 'Log Message',
  description: 'Writes a line to the experiment Journal. Placeholders: {value} = the wired Value, {gen} = the current generation.',
  category: 'output',
  color: '#546e7a',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { text: 'value = {value} (gen {gen})' },
  compile: () => '', // Action — the overseer compiler emits `O.logT(text, value)`
};
