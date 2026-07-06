import type { NodeTypeDef } from '../types';

/** Get Age — the agent's age in generations (Bond-Graph Agents). Reads the
 *  engine geometry buffer `_agentAge[idx]` (incremented once per step by the
 *  engine). The palette node for the **Lifespan** capability — use it for
 *  age-driven rules (mature at age N, die of old age, a corpse decompose timer)
 *  in any agent context (Behaviour Step exposes the same value as its `myAge`
 *  output; Get Age also works inside the Division Event). Age is engine-owned;
 *  Get Cell Attribute cannot target it (the N4 guardrail). */
export const GetAgeNode: NodeTypeDef = {
  type: 'getAge',
  label: 'Get Age',
  description: "Outputs the agent's age in generations (engine-incremented each step).",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'value', label: 'Age', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId) => `const _v${nodeId} = _agentAge[idx];\n`,
};
