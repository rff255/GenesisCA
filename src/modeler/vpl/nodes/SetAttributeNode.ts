import type { NodeTypeDef } from '../types';
import { agentRootHasSelf, agentRootRelaxesGuard } from '../types';

/** Set Attribute — write a value into an attribute of the current CELL, or (on
 *  the Agents graph) of an agent.
 *
 *  TARGETING — the standard optional-id convention, mirroring Get Velocity /
 *  Set Velocity / Kill Agent, and additionally SCALAR-OR-ARRAY like the lattice
 *  `setNeighborAttributeByIndex`. On the AGENTS graph the node exposes one
 *  `Agent` input with THREE modes:
 *    - UNWIRED        ⇒ the CURRENT agent (byte-identical to the historical
 *                       self-only node);
 *    - a SCALAR id    ⇒ that agent — feed Get Self Handle / For Each Bond /
 *                       Pick Random Agent to signal a neighbour, or a Create
 *                       Agent handle to configure a newborn;
 *    - an ID ARRAY    ⇒ EVERY agent in it — feed Get Nearby / Bonded / Filter
 *                       Agents to broadcast to a whole group.
 *  So one verb covers self, one and many. This REPLACED the separate
 *  `setAgentAttribute` ("Set Attribute (by ID)") — the scalar arm reproduces its
 *  emit verbatim (`setAgentAttributeMigration.ts`) — and the separate
 *  `setAgentsAttribute` ("Set Agents Attribute"), whose emit the ARRAY arm
 *  reproduces verbatim on all three agent targets
 *  (`setAgentsAttributeMigration.ts`).
 *
 *  The scalar/array split is decided at COMPILE time by the ONE shared
 *  `isAgentIdArraySource` predicate (`compiler/agentIdArray.ts`), never by a
 *  runtime shape test — an array coerced with `(arr) | 0` would silently resolve
 *  to agent 0. The JS compiler passes the answer in as `config._agentIdIsArray`
 *  (the `_indexesConnected` / `_leftAgentsUsed` convention); the two agent
 *  backends ask the predicate directly.
 *
 *  ⚠ The two wired arms guard DIFFERENTLY, and that is deliberate (each keeps
 *  the retired node's semantics byte-for-byte): a SCALAR id may be a STAGED
 *  Create Agent handle (`alive = 0` until Add Agent To World), so it takes the
 *  relaxed range-only guard wherever spawning can stage one; an ARRAY comes from
 *  a live-agent query, so each id keeps the strict `< highWater && alive` guard
 *  outside the selfless roots.
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
  agentDescription: "Writes a value to an agent's attribute — Agent empty = the current agent, a scalar id = that agent (signal a neighbour, or configure a Create Agent handle), an id ARRAY (Get Nearby / Bonded / Filter Agents) = every agent in it. Extra attribute slots (+ Attribute) write several attributes through one shared Agent input.",
  category: 'output',
  color: '#4a148c',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    // Scalar-typed but ARRAY-CAPABLE: `isValidConnection` already permits an
    // array source here; the flag is what makes the connection-suggestion layer
    // OFFER the agent-array producers in both drag directions.
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer', arrayCapable: true },
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
    // Unwired (and every CELL root) ⇒ the historical self-write, byte-for-byte.
    // `agentId` carries no inline widget, so `inputs['agentId']` is set iff an
    // edge feeds it — the Set Velocity wiredness test.
    if (!ctx?.agentGraph || !inputs['agentId']) return `w_${attr}[idx] = ${value};\n`;
    // Wired to an ID ARRAY ⇒ EXACTLY what the retired `setAgentsAttribute`
    // emitted, down to the `_si`/`_sa` local names and the `agentRootHasSelf`
    // guard — so a migrated model's code is byte-identical. The JS compiler
    // decided the shape via the shared `isAgentIdArraySource` and passed it in.
    if (config._agentIdIsArray) {
      const agents = inputs['agentId'];
      const i = `_si${nodeId}`;
      const id = `_sa${nodeId}`;
      const arrGuard = !agentRootHasSelf(ctx?.agentRoot)
        ? `${id} >= 0 && ${id} < _agentMaxAgents`
        : `${id} >= 0 && ${id} < highWater && _alive[${id}]`;
      return [
        `{ const __arr=${agents}; const __val=${value};`,
        `for (let ${i} = 0; ${i} < __arr.length; ${i}++) {`,
        `  const ${id} = (__arr[${i}]) | 0;`,
        `  if (${arrGuard}) w_${attr}[${id}] = __val;`,
        `} }`,
      ].join(' ') + '\n';
    }
    void nodeId;
    // Wired to a SCALAR ⇒ EXACTLY what the retired `setAgentAttribute` emitted (so a migrated
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
