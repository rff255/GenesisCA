import type { NodeTypeDef } from '../types';

/** Get Bonded Agents — the array of this agent's bonded partners (Generic Agent
 *  Platform). The data sibling of For Each Bond: outputs the partner ids as an
 *  array you can feed to Filter Agents / Join Agents / Get Agents Attribute /
 *  Aggregate, exactly like Get Nearby Agents. Relies on the engine's per-step
 *  stale-bond sweep (so the partner list is clean by behaviour time); the alive
 *  guard is defensive. Per-agent (never hoisted). Emitted on ALL THREE agent
 *  targets (JS + WASM + WebGPU — see AGENT_WASM_SUPPORTED_TYPES /
 *  AGENT_WEBGPU_SUPPORTED_TYPES; the older "JS-only" note was stale). */
export const GetBondedAgentsNode: NodeTypeDef = {
  type: 'getBondedAgents',
  label: 'Get Bonded Agents',
  description: "Outputs this agent's bonded partners as an array — filter / join / aggregate them like Get Nearby Agents.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agents', label: 'Agents', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
  ],
  defaultConfig: {},
  compile: (nodeId) => {
    const V = `_v${nodeId}`;
    return `const ${V}=[];{const __bc=_agentBondCount[idx],__base=idx*maxBonds;`
      + `for(let __k=0;__k<__bc;__k++){const __p=_bondPartner[__base+__k];if(__p>=0&&__p<highWater&&_alive[__p])${V}.push(__p);}}\n`;
  },
};
