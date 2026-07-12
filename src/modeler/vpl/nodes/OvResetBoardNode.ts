import type { NodeTypeDef } from '../types';

/** Overseer action — full Reset semantics: defaults + cell Init Event + agent
 *  init, generation → 0, indicators re-init. Maps to the worker `reset`
 *  message (awaited). The per-run auto-seed policy (Model Properties >
 *  Overseer) applies here. */
export const OvResetBoardNode: NodeTypeDef = {
  type: 'ovResetBoard',
  label: 'Reset Board',
  description: 'Resets the simulation like the transport Reset: defaults + Init Events, generation back to 0, indicators re-initialised. Typically the first step of each run.',
  category: 'output',
  color: '#3949ab',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '', // Action — the overseer compiler emits `await O.reset()`
};
