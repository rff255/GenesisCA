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
  // C9 SAFETY CATCH: with the Lifespan field gated off there is no `_agentAge`
  // param, so emit the typed default rather than a dangling identifier. The gate
  // is usage-widened ON THIS NODE, so this is the defensive second line.
  compile: (nodeId, _config, _inputs, _boundary, ctx) =>
    `const _v${nodeId} = ${ctx?.agentGates && !ctx.agentGates.age ? '0' : '_agentAge[idx]'};\n`,
};
