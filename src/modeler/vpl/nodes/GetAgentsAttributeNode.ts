import type { NodeTypeDef } from '../types';

/** Get Agents Attribute — the KEYSTONE gather: read one AGENT attribute over a
 *  whole id-array → a values array (Generic Agent Platform). The agent analogue
 *  of Get Neighbors Attr By Indexes, minus the NeighborIndex codec (elements are
 *  plain agent ids, read at `r_<attr>[id]`). Feed it Get Nearby Agents / Get
 *  Bonded Agents / Filter Agents; pipe the values into Aggregate / Group Counting
 *  / Group Reduce — this is what makes a totalistic CA over a grid of agents AND
 *  stigmergy density reductions composable. Per-agent, impure. Emitted on ALL
 *  THREE agent targets (JS + WASM + WebGPU — see AGENT_WASM_SUPPORTED_TYPES /
 *  AGENT_WEBGPU_SUPPORTED_TYPES; the older "JS-only" note was stale). */
export const GetAgentsAttributeNode: NodeTypeDef = {
  type: 'getAgentsAttribute',
  label: 'Get Agents Attribute',
  description: 'Reads one agent attribute over an id-array (Get Nearby/Bonded/Filter Agents) → a values array for Aggregate / Group Counting.',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agents', label: 'Agents', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'any', isArray: true },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs) => {
    const attr = config.attributeId as string || '_undef';
    const agents = inputs['agents'] || '[]';
    const i = `_gi${nodeId}`;
    const id = `_ga${nodeId}`;
    const vl = `_v${nodeId}_valsLen`;
    return [
      `_v${nodeId}_vals.length = 0; let ${vl} = 0;`,
      `for (let ${i} = 0; ${i} < ${agents}.length; ${i}++) {`,
      `  const ${id} = (${agents}[${i}]) | 0;`,
      // Skip empty (-1) / out-of-range / dead ids — an absent agent "doesn't
      // exist" so it's excluded from the gather (iteration-context semantics),
      // matching Set Agents Attribute's guard. Without it a -1 / dead id from a
      // hand-built array would push undefined and poison a downstream Aggregate.
      `  if (${id} >= 0 && ${id} < highWater && _alive[${id}]) _v${nodeId}_vals[${vl}++] = r_${attr}[${id}];`,
      `}`,
    ].join(' ') + '\n';
  },
};
