import type { NodeTypeDef } from '../types';

/** Agent Periodic Step — a PER-AGENT event root whose DO chain runs, FOR EVERY
 *  AGENT, only on generations where `generation % period === phase`.
 *
 *  ## PER AGENT, not global — and the label says so
 *  It lowers to a gate INSIDE the per-agent behaviour loop, so its chain runs
 *  once per live agent on a firing generation, with a `self` exactly like the
 *  Behaviour Step. The GLOBAL counterpart — "run this ONCE per firing generation
 *  to add substrate / spawn agents / test an indicator" — is a different root:
 *  **Population Periodic Event** on the Agents graph, **Grid Periodic Event** on
 *  the Cells graph. The unqualified name "Periodic Step" read as global to users,
 *  which is exactly the confusion the `Agent` prefix removes.
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
  label: 'Agent Periodic Step',
  description: 'Runs PER AGENT — its chain runs for EVERY agent, but only every Nth generation (generation % Period === Phase). Several are allowed per graph — e.g. two at Period 2, phases 0 and 1, alternate state updates and rewrites. Outputs Step Index = ⌊generation / Period⌋. For a GLOBAL periodic event (once per firing generation, no self — add substrate, spawn agents, test an indicator) use Population Periodic Event instead.',
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
