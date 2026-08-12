import type { NodeTypeDef } from '../types';
import { agentRootRelaxesGuard } from '../types';

/** Set Attribute — write a value into an attribute of the current CELL, or (on
 *  the Agents graph) of an agent.
 *
 *  TARGETING — the standard optional-id convention, mirroring Get Velocity /
 *  Set Velocity / Kill Agent: on the AGENTS graph the node exposes an `Agent`
 *  input. Unwired = the CURRENT agent (byte-identical to the historical
 *  self-only node); wired = that agent by id — feed Get Nearby Agents / For
 *  Each Bond / Pick Random Agent to signal a neighbour (mark it contacted, push
 *  a value onto it, transfer a resource), or a Create Agent handle to configure
 *  a newborn. This REPLACED the separate `setAgentAttribute` ("Set Attribute (by
 *  ID)"), whose emit the wired arm reproduces verbatim on all three agent
 *  targets — see `setAgentAttributeMigration.ts`.
 *
 *  The `agentId` port is HIDDEN on the Cells graph (a lattice cell has no agent
 *  id), via the `graph` argument of the declarative `hiddenPorts` hook. The
 *  COMPILERS additionally gate on `CompileContext.agentGraph`, so a hand-edited
 *  cell graph carrying an agent-only edge still emits the plain cell write.
 *
 *  A WIRED write IS a cross-agent OVERWRITE (last writer wins, so the outcome
 *  depends on the order agents run in), which puts it in exactly the same
 *  machinery as Set Velocity / Set Agent Position / Set Agent Radius: rejected at
 *  compile time in SYNCHRONOUS agent mode (it would race the target's own
 *  self-update), and rejected by the WebGPU agent gate when the id is wired to
 *  anything but a Create Agent handle (parallel threads have no defined write
 *  order) — so such a model runs on the sequential JS / WASM targets. Agent
 *  attributes are single-buffered in async mode, so the write is immediately
 *  visible to a later agent this step; use commutative patterns (accumulate,
 *  max) when order matters. The id is range-guarded either way.
 *
 *  Extra attribute slots (+ Attribute) write several attributes in slot order,
 *  each with its own input port; a wired `Agent` FANS OUT to every slot, so one
 *  node writes N attributes on one target (see `multiAttrExpand.ts`). */
export const SetAttributeNode: NodeTypeDef = {
  type: 'setAttribute',
  label: 'Set Attribute',
  description: 'Writes a value to an attribute of the current cell. Extra attribute slots (+ Attribute) write several attributes in slot order, each with its own input port.',
  agentDescription: "Writes a value to an agent's attribute — Agent empty = the current agent, else that agent by id (signal a neighbour, or configure a Create Agent handle). Extra attribute slots (+ Attribute) write several attributes through one shared Agent input.",
  category: 'output',
  color: '#4a148c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
  ],
  // An agent id is meaningless on the lattice, so the port only exists on the
  // Agents graph. Absent `graph` (a caller that has no active-graph context)
  // resolves to the conservative cell shape.
  hiddenPorts: (_config, _model, graph) => (graph === 'agents' ? [] : ['agentId']),
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const value = inputs['value'] || '0';
    void nodeId;
    // Unwired (and every CELL root) ⇒ the historical self-write, byte-for-byte.
    // `agentId` carries no inline widget, so `inputs['agentId']` is set iff an
    // edge feeds it — the Set Velocity wiredness test.
    if (!ctx?.agentGraph || !inputs['agentId']) return `w_${attr}[idx] = ${value};\n`;
    // Wired ⇒ EXACTLY what the retired `setAgentAttribute` emitted (so a migrated
    // model's code is byte-identical): unified spawning stages a Created agent at
    // alive=0 until Add Agent To World in BOTH the Init Event and the Behaviour
    // graph, so the live-agent guard relaxes to range-only in either root (a fresh
    // handle must be configurable; writing a dead slot is a harmless no-op).
    // Division keeps the strict live-agent guard.
    const a = `((${inputs['agentId']}) | 0)`;
    const guard = agentRootRelaxesGuard(ctx?.agentRoot)
      ? `__sa>=0&&__sa<_agentMaxAgents`
      : `__sa>=0&&__sa<highWater&&_alive[__sa]`;
    return `{ const __sa=${a}; if(${guard}) w_${attr}[__sa] = ${value}; }\n`;
  },
};
