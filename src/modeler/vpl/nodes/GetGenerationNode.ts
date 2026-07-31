import type { NodeTypeDef } from '../types';

/** Get Generation — the 0-based index of the generation currently being
 *  computed. UNIVERSAL: available on BOTH the Cells graph and the Agents graph
 *  (there is ONE counter — the worker's `generation` — so a cell rule and an
 *  agent rule running in the same generation read the same number).
 *
 *  ## Pinned semantics (L2 — later phases rely on these)
 *  - The counter is **0-based** and names the generation being computed *now*:
 *    the FIRST step after a Reset reads `0`, the second `1`, … The worker
 *    increments it at the END of a step, so every rule that runs during
 *    generation *g* — cell step, agent behaviour, agent output mapping — reads
 *    exactly `g`.
 *  - **Init events read 0.** Reset sets the counter to 0 *before* running the
 *    cell Init Event, the Grid Init Event and the Agent Init Event, so a seeding
 *    rule always sees 0 regardless of how long the previous run lasted.
 *  - **The Division Event reads the generation the division happened in.** It
 *    runs inside the structural phase of generation *g* (after the behaviour,
 *    before the increment), so it reads `g` — the same value the behaviour that
 *    requested the division read.
 *  - **Cells and agents share one counter.** The agent step runs before the cell
 *    step within a generation, and the counter is bumped once per generation, so
 *    both layers read the same value.
 *
 *  ## Why it exists
 *  Rule CADENCE is model semantics: "rewrite the graph every 10th generation,
 *  update states on the others" is a property of the automaton, not an engine
 *  knob. Before this node there was no way to read the generation from a cell or
 *  agent rule at all (`Get Generation` in the Overseer is a different, protocol-
 *  level node). Compose it directly —
 *  `Get Generation → Math(%) → Compare(==) → If/Then` — or use the **Periodic
 *  Step** root, which is exactly that chain as an event root.
 *
 *  ## Threading (all six compile surfaces; NO new per-target algorithm)
 *  - **Cell JS** — a trailing `_generation` step/cell/output-mapping param,
 *    appended only when the graph reads it (the sparse-stepping discipline), so
 *    a model that doesn't use it emits byte-identical code.
 *  - **Cell WASM** — an i32 cell in `wasmMemory` at `layout.generationOffset`,
 *    appended at the END of the memory layout so every existing baked offset is
 *    unchanged ⇒ the module is byte-identical when the node is unused. One
 *    mechanism serves EVERY entry point (step / init / grid init / input colour /
 *    output mapping) with zero signature changes.
 *  - **Cell WebGPU** — `Control.generation`, declared only when used.
 *  - **Agent JS** — a trailing `_generation` ABI field (see agentAbi.ts).
 *  - **Agent WASM** — an f64 cell in the agent memory at
 *    `layout.generationOffset` (same append-at-the-end reasoning).
 *  - **Agent WebGPU** — a `genCounter` STORAGE buffer, not a uniform: the
 *    resident batch encodes every generation of a batch into ONE submit with no
 *    CPU touch point in between, so a uniform-supplied generation would be frozen
 *    for the whole batch. The per-generation `posCommit` pass bumps the counter
 *    GPU-side instead (see agentWebgpuRuntime.ts).
 *
 *  Pure + input-free ⇒ loop-invariant, so it is hoisted out of the per-cell /
 *  per-agent loop on every target (it is constant within a generation). */
export const GetGenerationNode: NodeTypeDef = {
  type: 'getGeneration',
  label: 'Get Generation',
  description: 'Outputs the current generation number (0-based: the first step after a Reset is 0). Use it to give a rule its own cadence — e.g. Get Generation → Math (%) → Compare (==) → If/Then — or reach for the Periodic Step root, which is that chain as an event root.',
  agentDescription: 'Outputs the current generation number (0-based). Cells and agents share one counter. Init events read 0; a Division Event reads the generation the division happened in.',
  category: 'data',
  color: '#1565c0',
  ports: [
    { id: 'value', label: 'Generation', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: {},
  compile: (nodeId) => `const _v${nodeId} = _generation;\n`,
};
