import type { NodeTypeDef } from '../types';

/** Get Self Handle — the CURRENT agent's own handle/id (Bond-Graph Agents).
 *  The agent loop variable is `idx` (Decision D-IDX): this node exposes it as a
 *  value so the agent can pass ITS OWN id to the by-id nodes (Get Agent
 *  Attribute, Get Agent Position/Radius/Offset, Form/Break Bond, …) — e.g. to
 *  have a neighbour reference back to me, or to compare a Get Nearby Agents id
 *  against self. Pairs with Get Nearby Agents (other agents) + For Each Bond. */
export const GetSelfHandleNode: NodeTypeDef = {
  type: 'getSelfHandle',
  label: 'Get Self Handle',
  description: "Outputs the current agent's own handle (its id) — pass it to the by-id nodes (Get Agent Attribute, a wired Set Attribute, Get Agent Position, Form Bond, …).",
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'handle', label: 'Handle', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId) => `const _v${nodeId} = idx;\n`,
};
