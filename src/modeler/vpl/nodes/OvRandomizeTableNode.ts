import type { NodeTypeDef } from '../types';

/** Overseer action — re-roll a Lookup Table's values from a seed at runtime,
 *  exactly like the editor's Randomize block but RUNTIME-ONLY (the worker
 *  updates; the model DEFINITION does not — no dirty flag, no .gcaproj change,
 *  mirroring Set Model Attribute). The rule-space-search primitive: sweep a
 *  seed with a `forEachInArray` over `ovSweepValues`, Reset + Run Until Stop
 *  each, measure growth, and the journal records every {seed, density} so an
 *  interesting rule reproduces in the editor. Fill is the SAME deterministic
 *  seeded xorshift32 as the editor (variegation.ts `randomFillTableData`), so a
 *  logged seed grows the identical structure. */
export const OvRandomizeTableNode: NodeTypeDef = {
  type: 'ovRandomizeTable',
  label: 'Randomize Table',
  description: "Re-rolls a Lookup Table's values from a seed at a chosen density for the running simulation (runtime-only, like the editor's Randomize block — never edits the model). The rule-space-search primitive; the journal records each seed.",
  category: 'output',
  color: '#3949ab',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'seed', label: 'Seed', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '1' },
    { id: 'density', label: 'Density', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.2' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { tableId: '' },
  compile: () => '', // Action — the overseer compiler emits `await O.randomizeTable(id, seed, density)`
};
