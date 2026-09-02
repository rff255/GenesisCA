import type { NodeTypeDef } from '../types';
import { agentRootHasSelf } from '../types';

/** Get Agent Attribute — read an agent's attribute by id (Bond-Graph Agents).
 *  The agent analogue of Get Neighbor Attribute By Index: feed a neighbour id
 *  (from Get Nearby Agents / For Each Bond) to read its type, energy, state, …
 *  — differential adhesion, contact inhibition, signalling.
 *
 *  The `Agent` input is OPTIONAL and its UNWIRED state means SELF — the project
 *  convention every other optional-id agent node already follows (Get Velocity,
 *  Set Attribute, Kill Agent, …; see "Agent action TARGETING" in CLAUDE.md).
 *  It used to emit the −1 empty sentinel, which the range guard turned into a
 *  silent READ OF 0 — plausible, wrong, and reported nowhere. */
export const GetAgentAttributeNode: NodeTypeDef = {
  type: 'getAgentAttribute',
  label: 'Get Agent Attribute',
  agentLabel: 'Get Attribute (by ID)',
  description: "Read an agent's attribute — SELF when the Agent input is empty, else a specific agent by id (the partner from Get Nearby Agents / For Each Bond). Extra attribute slots (+ Attribute) read several of that agent's attributes through one shared Agent input.",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId', label: 'Agent (self)', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    // Unwired ⇒ SELF: `idx` is live by construction, so no range guard (the Get
    // Velocity precedent). EXCEPT in a root with no self (`init` / `spawner`),
    // where `idx` does not exist: degrade to the typed default a failed guard
    // would have produced rather than emit a reference that throws at run time
    // (the Set Velocity / Set Agent Sprite safety-catch shape; `nodeValidation`
    // badges the placement). A READ still has to DECLARE its output var.
    if (!inputs['agentId']) {
      if (!agentRootHasSelf(ctx?.agentRoot)) return `const _v${nodeId} = 0;\n`;
      return `const _v${nodeId} = r_${attr}[idx];\n`;
    }
    // A WIRED id is range-guarded: -1 (the empty sentinel — Pick Random Agent on
    // an empty set) / out-of-range → 0 instead of `r_attr[-1]` = undefined → NaN
    // silently poisoning downstream math (WASM would read adjacent memory).
    const a = `((${inputs['agentId']}) | 0)`;
    return `const __gaa${nodeId} = ${a}; const _v${nodeId} = (__gaa${nodeId} >= 0 && __gaa${nodeId} < highWater) ? r_${attr}[__gaa${nodeId}] : 0;\n`;
  },
};
