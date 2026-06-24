import type { NodeTypeDef } from '../types';

/** Add Agent To World — commit a staged agent (Generic Agent Platform). Phase 2
 *  of the two-phase spawn: takes the `handle` from Create Agent and marks the
 *  agent live (`alive=1`, liveCount++). Any Create Agent whose handle is never
 *  Added is swept back to the free-list at the end of the Init Event (no leak).
 *  Calls the `_agentAddToWorld` host closure. JS-only this milestone. */
export const AddAgentToWorldNode: NodeTypeDef = {
  type: 'addAgentToWorld',
  label: 'Add Agent To World',
  description: 'Commit a staged agent (from Create Agent) — marks it live so the simulation processes it.',
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'handle', label: 'Handle', kind: 'input', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs) => {
    const h = `((${inputs['handle'] || '-1'}) | 0)`;
    return `_agentAddToWorld(${h});\n`;
  },
};
