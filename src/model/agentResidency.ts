// ===========================================================================
// C1 (P2 / P4) — the MODEL-DERIVABLE half of GPU-residency eligibility.
//
// `agentResidentEligible()` in sim.worker.ts mixes two kinds of term:
//
//   RUNTIME  — the GPU runtime exists and is ready, the resolved agent target is
//              webgpu, the Simulate-agents layer toggle is on. Only the worker
//              can know these.
//   MODEL    — everything else: config resolvers (update mode, collision mode,
//              springs, bond store, growth) + facts about the compiled agent
//              graph (structural writes, field nodes, spawn / stop / indicators).
//              These are knowable BEFORE running, which is exactly what the
//              Properties compatibility readout needs.
//
// This module owns the MODEL half, and the worker CALLS it for those terms —
// the `resolveMaxBonds` / `modelAttrSlotKeys` single-source discipline. The two
// therefore cannot drift, and the main thread never imports the worker.
//
// Residency is a CLASS-F (fast path) property: an ineligible model runs exactly
// the same simulation on the per-generation GPU path, only slower. Nothing here
// is ever an error.
// ===========================================================================

import type { CenterBasedConfig } from './types';
import {
  cbNum, usesEngineGrowth, usesEngineSprings, usesPositionalCollision, usesGlobalCharge,
} from './centerBased';

/** Facts about the compiled agent graph that residency depends on. The worker
 *  holds them as module state (fed by the init/recompile message); the UI
 *  derives them from the model + the WebGPU agent compile result. Naming them
 *  in ONE interface is what lets both sides feed the same predicate. */
export interface ResidencyGraphFacts {
  /** `!usesStructural && !usesRadiusWrite` from the WebGPU agent compiler —
   *  the BEHAVIOUR graph emits no Divide / Form / Break / Rewire / Kill and no
   *  radius write. (Compiler-scoped: an Init-Event spawn does not block.) */
  residencyClean: boolean;
  /** A field-bridge node is reachable in the agent graph (the per-generation
   *  CPU↔GPU field round-trip). */
  usesField: boolean;
  /** Some cell attribute grants agent access (the worker's `fieldSpecs`). */
  hasAgentAccessibleField: boolean;
  /** The behaviour shader bump-allocates agents (Create Agent) — the spawn
   *  reconcile is per-generation CPU work. */
  usesSpawn: boolean;
  /** The behaviour shader can raise the shared stop flag (Stop Event). */
  usesStop: boolean;
  /** The behaviour shader reads/writes indicators (accumulation needs per-gen sync). */
  usesIndicators: boolean;
  /** The model declares Stop Event messages (cell and/or agent). */
  hasStopMessages: boolean;
  /** Allocated bond slots per agent. The WORKER passes its store's real
   *  `maxBonds` (what was actually allocated); the UI passes the PREDICTION
   *  `resolveMaxBonds(cfg)` — the same number by construction (`createAgentStore`
   *  calls that resolver), but the worker deliberately reports the allocation it
   *  holds rather than re-deriving it, so a live config edit that has not yet
   *  re-allocated can never make the engine and the readout disagree about what
   *  the engine is doing. */
  bondSlots: number;
}

/** One reason a model cannot run whole frames resident on the GPU. `key` is
 *  stable (tests / diagnostics), `text` is user-facing. */
export interface ResidencyBlocker { key: string; text: string }

/** The MODEL-derivable residency blockers, ordered most-fundamental first so a
 *  surface that shows only the first reason shows the most explanatory one.
 *  Empty ⇒ the model clears every term this side can decide; the worker still
 *  applies its runtime terms on top.
 *
 *  NB the caller supplies `facts` — this function deliberately does NOT scan the
 *  graph itself, because the worker already has the answers (from the init
 *  message) and the UI already computes them for the compile path. Splitting it
 *  this way is what keeps ONE predicate serving both. */
export function residencyModelBlockers(
  cfg: CenterBasedConfig | undefined | null,
  facts: ResidencyGraphFacts,
): ResidencyBlocker[] {
  const out: ResidencyBlocker[] = [];
  // 1. Structural rewriting — THE reason a bonded / GRA model is never resident.
  //    Applying a Form/Break/Rewire/Divide/Kill is serial data-structure surgery
  //    on a ragged store (per-agent capacity, free list, swap-with-last
  //    compaction that rewrites BOTH endpoints), so it is CPU on every target.
  if (!facts.residencyClean) {
    out.push({ key: 'structural', text: 'the behaviour graph rewrites structure (Divide / Form / Break / Rewire / Kill Agent, or a radius write) — the structural phase is CPU work between generations on every engine' });
  }
  // 2. A bond STORE at all: partner / restLength are CPU-owned, so they would
  //    need uploading + reading back each generation regardless.
  if (usesEngineSprings(cfg) || facts.bondSlots > 0) {
    out.push({ key: 'bonds', text: 'the model uses bonds — the bond store is CPU-owned, so it must cross the bus every generation' });
  }
  // 3. The agent↔grid field bridge is a per-generation CPU round-trip.
  if (facts.usesField || facts.hasAgentAccessibleField) {
    out.push({ key: 'field', text: 'the agent layer is coupled to a cell field — the morphogen bridge runs per generation' });
  }
  // 4. Synchronous agent attributes need the CPU-side double-buffer swap.
  if (cfg?.agentUpdateMode === 'sync') {
    out.push({ key: 'syncAttrs', text: 'Agent Update Mode is Synchronous — the attribute double-buffer is committed per generation' });
  }
  // 4b. C10 — GLOBAL charge rebuilds a Barnes–Hut octree on the CPU every
  //     generation and uploads it, which is precisely the per-generation CPU
  //     touch point residency exists to remove. (A GPU tree BUILD would lift
  //     this; it is a recorded follow-up, not a gap being hidden.)
  if (usesGlobalCharge(cfg)) {
    out.push({ key: 'chargeGlobal', text: 'Charge range is Global (Barnes–Hut) — the tree is rebuilt on the CPU and uploaded every generation' });
  }
  // 5. The hard positional projection is a CPU pass after integration.
  if (usesPositionalCollision(cfg)) {
    out.push({ key: 'positional', text: 'Collision is Positional (hard) — the projection pass runs on the CPU after each integration' });
  }
  // 6. Growth changes radii, which changes the spatial-hash bin edge mid-batch.
  if (usesEngineGrowth(cfg) && cbNum(cfg, 'growthRate') > 0) {
    out.push({ key: 'growth', text: 'Growth is on — radii change every generation, so the spatial hash cannot be held fixed for a whole batch' });
  }
  // 7-9. Per-generation CPU reconcile / drain / sync.
  if (facts.usesSpawn) {
    out.push({ key: 'spawn', text: 'the behaviour graph spawns agents (Create Agent) — newborns are reconciled on the CPU each generation' });
  }
  if (facts.usesStop || facts.hasStopMessages) {
    out.push({ key: 'stop', text: 'the model has a Stop Event — the stop flag is drained on the CPU each generation' });
  }
  if (facts.usesIndicators) {
    out.push({ key: 'indicators', text: 'the behaviour graph reads or writes indicators — accumulators are synced per generation' });
  }
  return out;
}
