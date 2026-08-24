import type { NodeTypeDef } from '../types';

/** Neighbour Density — how many OTHER agents are near this one (Bond-Graph
 *  Agents). A FIRST-CLASS local-density measure, distinct from bond degree (a
 *  free-floating agent has density but no bonds). Drives crowding rules (divide
 *  when uncrowded, jam when packed, differential adhesion).
 *
 *  TWO MODES, decided by the optional **Radius** input:
 *   - **Radius unwired / 0 (the default)** — reads the ENGINE reduction
 *     `_agentDensity[idx]`: the agents inside the engine's own interaction cutoff
 *     `interactionRange × (r_i + r_j)` — a RELATIVE range that scales with the
 *     pair's radii — counted for free by the fused force pass, and therefore ONE
 *     GENERATION STALE (the force pass runs after the behaviour).
 *   - **Radius wired or > 0** — a FRESH count, this generation, of the other
 *     alive agents within that ABSOLUTE radius. The node is LOWERED before any
 *     target compiles into `Get Nearby Agents(radius) → Array Length`
 *     (`densityExpand.ts`), so it runs on JS / WASM / WebGPU with zero per-target
 *     emit and costs one spatial-hash query. Keep the radius ≤ the model's
 *     Neighbour Query Radius (Properties › Motion): the hash stencil is sized to
 *     that, so a larger radius silently under-counts. */
export const NeighbourDensityNode: NodeTypeDef = {
  type: 'neighbourDensity',
  label: 'Neighbour Density',
  description: 'Outputs how many other agents are nearby (local crowding). Radius unwired/0 = the engine’s interaction range (free, one generation stale); wire or type a Radius for a fresh count at that absolute distance.',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    // 0 / blank = "use the engine reduction" — which is why a fresh node keeps
    // the historical behaviour and every existing model is byte-identical.
    { id: 'radius', label: 'Radius (0 = engine range)', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Density', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  // Reached ONLY in engine-reduction mode: an active Radius lowers the node away
  // (densityExpand.ts) before any front-end compiles it.
  // C9 SAFETY CATCH: the density field's gate INCLUDES this node, so an off gate
  // means nothing ever computes density — read the typed default.
  compile: (nodeId, _config, _inputs, _boundary, ctx) =>
    `const _v${nodeId} = ${ctx?.agentGates && !ctx.agentGates.density ? '0' : '_agentDensity[idx]'};\n`,
};
