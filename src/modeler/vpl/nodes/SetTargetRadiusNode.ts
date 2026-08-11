import type { NodeTypeDef } from '../types';

/** Set Target Radius — set the radius an agent grows toward (Bond-Graph
 *  Agents). The engine ramps the agent's actual radius toward this target each
 *  step (at `growthRate`); a bigger radius means stronger volume-exclusion
 *  pressure on its neighbours, which (Phase C) drives division on reaching the
 *  target. Writes the engine buffer `_agentTargetRadius[id]`.
 *
 *  TARGETING — the standard optional-id convention: `Agent` unwired = SELF
 *  (byte-identical to the historical self-only node), wired = that agent by id.
 *  Set Agent Radius (by id) sets the CURRENT radius; this sets the GROWTH TARGET,
 *  so before the optional id there was no way at all to make ANOTHER agent grow
 *  or shrink (e.g. a signalling cell enlarging its neighbours).
 *
 *  A WIRED write is a cross-agent OVERWRITE (last writer wins), so — exactly like
 *  Set Agent Radius — it is rejected in SYNCHRONOUS agent mode and by the WebGPU
 *  agent gate unless the target is a Create Agent handle; such a model runs on the
 *  sequential JS / WASM targets. */
export const SetTargetRadiusNode: NodeTypeDef = {
  type: 'setTargetRadius',
  label: 'Set Target Radius',
  description: "Set the radius an agent grows toward — Agent empty = self, else that agent by id (the engine ramps the actual radius each step).",
  category: 'output',
  color: '#4527a0',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Target', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
  ],
  defaultConfig: {},
  compile: (_nodeId, _config, inputs, _boundary, ctx) => {
    // C9 SAFETY CATCH: with the Growth field gated off there is no
    // `_agentTargetRadius` param and no ramp to feed, so the write is dropped.
    if (ctx?.agentGates && !ctx.agentGates.targetRadius) return '';
    // Unwired ⇒ the historical self-write, byte-for-byte.
    if (!inputs['agentId']) return `_agentTargetRadius[idx] = ${inputs['value'] || '1'};\n`;
    const guard = (ctx?.agentRoot === 'init' || ctx?.agentRoot === 'behaviour')
      ? `__st >= 0 && __st < _agentMaxAgents`
      : `__st >= 0 && __st < highWater && _alive[__st]`;
    return `{ const __st = ((${inputs['agentId']}) | 0); if (${guard}) _agentTargetRadius[__st] = ${inputs['value'] || '1'}; }\n`;
  },
};
