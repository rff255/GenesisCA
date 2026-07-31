import type { NodeTypeDef } from '../types';

/** Periodic Step — an agent event root whose DO chain runs only on generations
 *  where `generation % period === phase`.
 *
 *  ## Why a root and not "just wire the modulo yourself"
 *  A periodic automaton must gate its state update AND its rewrite on the SAME
 *  tick. Updating states every generation while rewriting every 10th silently
 *  builds a *different* automaton, and hand-wired modulo boilerplate makes that
 *  mistake easy and invisible. As a root, the cadence is a property of the whole
 *  chain hanging off it.
 *
 *  **Multiple Periodic Steps are allowed per graph** (unlike Behaviour Step) —
 *  that is the point. Two at `period 2`, phases 0 and 1, reproduce the classic
 *  alternating "states on even ticks, rewrites on odd" scheme; three at 1 / 5 /
 *  50 give a fast, a medium and a slow clock in one model.
 *
 *  ## `Step Index`
 *  ⌊generation / period⌋ — the rule-step counter the rule actually reasons about
 *  (a Periodic Step at period 10 has run `Step Index + 1` times by generation
 *  `generation`). Synthesized ONLY when something reads it.
 *
 *  ## How it runs — a pre-compile LOWERING, so all three targets work by
 *  construction
 *  `periodicExpand.ts` rewrites every Periodic Step into
 *  `Get Generation → Math(%) → Compare(==) → If/Then` hanging off ONE synthesized
 *  (or the user's existing) `behaviourStep`, sequenced with a `Sequence` node.
 *  The compilers, the capability gates and the WASM/WebGPU supported-type sets
 *  therefore never see a `periodicStep` node — they see only primitives they
 *  already emit. Zero per-target emit; bit-parity inherited from the primitives.
 *  A graph with no Periodic Step is a hot-path no-op ⇒ byte-identical.
 *
 *  Deliberately NOT in `SINGLETON_NODE_TYPES` (N per graph); the SYNTHESIZED
 *  `behaviourStep` still satisfies the singleton rule, since the lowering reuses
 *  an existing one when present and creates at most one when absent. */
export const PeriodicStepNode: NodeTypeDef = {
  type: 'periodicStep',
  label: 'Periodic Step',
  description: 'Agent entry point that runs its chain only every Nth generation (generation % Period === Phase). Several are allowed per graph — e.g. two at Period 2, phases 0 and 1, alternate state updates and rewrites. Outputs Step Index = ⌊generation / Period⌋.',
  category: 'event',
  // Event roots are white (the CA-grid standard: Step / Init / Behaviour Step).
  color: '#ffffff',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'stepIndex', label: 'Step Index', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { period: 10, phase: 0 },
  compile: () => '',  // Lowered before compile — see periodicExpand.ts.
};
