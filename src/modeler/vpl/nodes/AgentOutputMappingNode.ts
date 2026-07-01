import type { NodeTypeDef } from '../types';

/** Agent Output Mapping (A→C) — the agent analogue of the lattice `outputMapping`
 *  event root. Roots a per-agent colour/exhibition pass over an entry in
 *  `model.agentMappings`. The agent compiler (`compileAgentGraph`) finds every
 *  `agentOutputMapping` node (user-placed for a STANDALONE mapping, or synthesized
 *  by `injectAgentLinkedOutputMappings` for a LINKED one) and compiles each into a
 *  per-agent loop (`for idx<highWater … colorIdx=idx*4`) that runs AFTER the
 *  behaviour/division graphs, writing the agent `colors` (Set Cell Looks) and, with
 *  sprites, the per-agent `spriteIds`/`spriteFrames` display buffers (Set Agent
 *  Sprite). It runs as a JS colour pass on EVERY agent target (JS/WASM/WebGPU) —
 *  the same posture as today's linked agent colour pass.
 *
 *  `requirements.bondGraph` → only available in an Agents-topology model, on the
 *  Agents sub-tab (and auto-hidden on the Cells graph). `config.mappingId` picks
 *  the agent mapping; the picker lists `model.agentMappings`. */
export const AgentOutputMappingNode: NodeTypeDef = {
  type: 'agentOutputMapping',
  label: 'Agent Output Mapping (A→C)',
  description: 'Entry point for an agent attribute-to-colour view. Runs after the behaviour/division step to paint (and optionally sprite) each agent.',
  category: 'event',
  color: '#ffffff',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { mappingId: '' },
  compile: () => '', // Root node — the agent compiler handles it specially.
};
