// ===========================================================================
// C5 (P10) — THE DECLARED REPRODUCIBILITY CONTRACT.
//
// How much run-to-run variance a model tolerates used to be a SIDE EFFECT of
// which engine radio was pressed: picking the WebGPU agent target silently meant
// "I accept that a fixed seed will not reproduce this run". This module makes it
// a declared property instead, so `Auto` (C4) reads as one sentence:
//
//     Auto = the fastest engine that satisfies the declared contract.
//
// THE ASYMMETRY BETWEEN THE TWO GPU LAYERS IS REAL AND MEASURED — it is why the
// contract does not simply mean "no GPU":
//
//   WebGPU GRID    per-CELL PCG seeded from a global seed, and `setRngSeed`
//                  RE-DERIVES those streams (`seedRngState`). A fixed seed
//                  therefore DOES reproduce a run on this device — measured on a
//                  5-run Overseer sweep (460.8 ± 15.707, identical across
//                  presses). f32 means the numbers differ from the CPU engines
//                  and may differ across devices, but the run is pinned.
//                  ⇒ HONOURS Exact.
//
//   WebGPU AGENTS  per-AGENT PCG seeded ONCE at runtime creation; `setRngSeed`
//                  never reaches it, so an Overseer sweep does not reproduce
//                  across two presses of Run Experiment. This is exactly why the
//                  library's documented sweep exceptions (Cubic GRA, Graph
//                  Metrics) are AGENT-target exceptions, while the grid Overseer
//                  sample ships on WebGPU.
//                  ⇒ CANNOT honour Exact.
//
// So: Exact keeps AGENTS on a CPU engine and leaves the GRID free.
//
// This module is deliberately import-free of `engineResolution` (which imports
// `reproducibilityOf` from here). The violation predicate is told what RESOLVED
// rather than resolving anything itself — the caller passes the answer from
// `resolveEngines`, so there is exactly one resolution in the system.
// ===========================================================================

import type { CAModel, EngineId, ReproducibilityContract } from './types';

/** The contract this model declares. Absent ⇒ `'exact'` — the safe default, and
 *  what every legacy CPU model already delivers. */
export function reproducibilityOf(model: CAModel): ReproducibilityContract {
  return model.properties?.reproducibility === 'statistical' ? 'statistical' : 'exact';
}

export const REPRODUCIBILITY_LABEL: Record<ReproducibilityContract, string> = {
  exact: 'Exact',
  statistical: 'Statistical',
};

/** The one-line meaning of each contract — shared by the Properties radio, the
 *  Compatibility readout and Help so the wording cannot drift. */
export const REPRODUCIBILITY_SUMMARY: Record<ReproducibilityContract, string> = {
  exact: 'Bit-reproducible: a fixed seed pins a run, so oracles, replays and differential comparisons hold. Auto keeps agents on a CPU engine.',
  statistical: 'Runs are draws from the same distribution; sweeps use repeats + aggregates. Auto may use the GPU agent engine (f32, per-agent RNG).',
};

/** The proposal's guardrail, stated in the UI next to the choice. */
export const REPRODUCIBILITY_GUARDRAIL =
  'Statistical covers stochastic variance around the SAME rule — it never licenses answering a different question.';

/** What a file that predates the field declares: `'statistical'` iff it already
 *  runs its agents on the GPU (i.e. it has been living with per-agent-RNG
 *  variance all along), otherwise `'exact'`.
 *
 *  Takes the RESOLVED agent engine — the answer `resolveEngines` produced — so
 *  the inference records what the model actually does rather than re-deriving
 *  it. `null` = the model has no agent layer. */
export function inferContract(resolvedAgentEngine: EngineId | null): ReproducibilityContract {
  return resolvedAgentEngine === 'webgpu' ? 'statistical' : 'exact';
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

/** Does this engine satisfy the contract on this layer?
 *
 *  `'statistical'` is a TOLERANCE, so every engine satisfies it (an exact engine
 *  trivially delivers "the same distribution"). Only `'exact'` can be violated,
 *  and only by the WebGPU AGENT engine — see the module header. */
export function engineHonoursContract(
  layer: 'grid' | 'agents',
  engine: EngineId,
  contract: ReproducibilityContract,
): boolean {
  if (contract === 'statistical') return true;
  return !(layer === 'agents' && engine === 'webgpu');
}

/** The user-facing sentence for a violated contract, or `null` when the engine
 *  honours it. The engine is the RESOLVED one, supplied by the caller.
 *
 *  Auto consults the contract, so a violation is always a deliberate EXPLICIT
 *  choice — hence the sentence names both ways out. */
export function contractViolationFor(
  layer: 'grid' | 'agents',
  engine: EngineId,
  contract: ReproducibilityContract,
): string | null {
  if (engineHonoursContract(layer, engine, contract)) return null;
  return 'This model declares Exact, but the WebGPU agent engine seeds its per-agent RNG once when it starts and Set Random Seed never reaches it — so a fixed seed does not reproduce a run, and an Overseer sweep gives different numbers each time. Switch the Agent Engine to Auto or WebAssembly, or declare Statistical.';
}

/** The short amber headline for the same condition (chip tooltips, panel notes). */
export function contractViolationHeadline(layer: 'grid' | 'agents'): string {
  return layer === 'agents'
    ? 'Agents run on WebGPU, which cannot honour the declared Exact contract.'
    : 'This layer cannot honour the declared Exact contract.';
}

// ---------------------------------------------------------------------------
// Overseer sweep methodology
// ---------------------------------------------------------------------------

/** The one-line answer to *"is a single run a result?"*, shown in the Overseer
 *  Experiments panel. `tone` picks the colour; `'warn'` is a live violation. */
export interface SweepMethodology {
  tone: 'exact' | 'statistical' | 'warn';
  text: string;
}

/** What the declared contract implies for an Overseer sweep, given the engines
 *  that actually resolved. The RESOLVED engines are passed in (from
 *  `resolveEngines`) rather than re-derived here — one resolution, many readers.
 *
 *  Under `'exact'` the answer still depends on whether a GPU layer is running:
 *  the GPU grid pins a run on THIS device but its f32 numbers are not comparable
 *  with a CPU run, which is precisely the thing a sweep must not get wrong. */
export function describeSweepMethodology(
  contract: ReproducibilityContract,
  resolved: { grid: EngineId; agents: EngineId | null },
  violation: string | null,
): SweepMethodology {
  if (violation) return { tone: 'warn', text: violation };
  if (contract === 'statistical') {
    return {
      tone: 'statistical',
      text: 'Statistical contract — runs are draws from one distribution. Use repeats + aggregates (Collect Sample → Series Stat: mean / std / ci95); a single run is not a result.',
    };
  }
  const gpu = resolved.grid === 'webgpu' || resolved.agents === 'webgpu';
  return gpu
    ? {
      tone: 'exact',
      text: 'Exact contract — Set Random Seed pins a run on this device. A layer runs on the GPU in f32, so these numbers are engine- and device-specific: do not compare them against a CPU run.',
    }
    : {
      tone: 'exact',
      text: 'Exact contract — Set Random Seed pins each run bit-exactly; two presses of Run Experiment produce identical numbers.',
    };
}
