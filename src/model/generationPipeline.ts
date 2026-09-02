// ===========================================================================
// C2 (P3) — THE GENERATION PIPELINE.
//
// "What happens each generation for THIS model?" — answered as ONE ordered,
// read-only list of phases, each attributed to the user's GRAPH or to the
// ENGINE, tagged with its TEMPO, and carrying the RESOLVED numbers it reads.
//
// WHY IT EXISTS (proposal §1.3): the CA-grid contract is legible — the graph is
// the rule, the engine double-buffers and runs the colour pass. The AGENT
// generation is ~14 interleaved phases, only two of which are the user's graphs,
// and nothing showed the user that sequence, which phases are active for their
// model, or which config values each phase reads.
//
// ---------------------------------------------------------------------------
// THE DESIGN RULE (inherited from C1's targetDiagnosis.ts)
// ---------------------------------------------------------------------------
// Every `active` bit and every resolved number comes from the function the
// ENGINE consults — `usesSoftCollision`, `usesEngineSprings`, `usesCharge`,
// `usesEngineGrowth`, `layoutIterationsOf`, `resolveMaxBonds`,
// `effectiveAgentDt`, `sparseSteppingEnabled`, `agentGraphUsesBondRequests`,
// `dividePartitionTableForModel`, `periodicParams` — never a parallel
// hand-written truth. So this description cannot drift from what runs.
//
// THE ONE DELIBERATE EXCEPTION, stated plainly: a few facts are about the
// GRAPH'S CONTENT rather than the config — "does this model contain a Kill
// Agent node / a Division Event root / a sprite / an Output Mapping". There is
// no resolver for those because the engine simply runs the phase and it is a
// no-op when nothing requests it. Those come from a macro-aware node scan
// (`walkNodes`, the same discipline C1 uses). Where the engine DOES have a
// usage gate for such a question — the bond-request queue's `agentGraphUses-
// BondRequests` (which SIZES the queue) and the division partition's
// `dividePartitionTableForModel` (which the engine INDEXES) — this module calls
// that gate instead of scanning locally.
//
// PHASE ORDER mirrors the shipped loops exactly (sim.worker.ts: `runAgentStep`
// → `runAgentStructuralPhase` → `runStep`, the step-message batch loop, and the
// reset handler's `runInit` → `runGridInit` → `runAgentInit`). Agents step
// BEFORE cells — the documented closed agent↔grid loop (Decision D-FIELD).
//
// PURE. No React, no worker, no compiler state. Safe in a `useMemo` and in a
// Node harness (scripts/test-generation-pipeline.mjs pins both the activity bits
// and the order).
// ===========================================================================

import type { CAModel, CenterBasedConfig, GraphNode } from './types';
import type { NodeConfig } from '../modeler/vpl/types';
import { agentMotionMode, motionIntegrates, motionAppliesForces } from './agentFieldGating';
import {
  cbNum, effectiveAgentDt, layoutIterationsOf, resolveMaxBonds,
  usesCharge, chargeParamsOf, chargeMaxDistOf, chargeGlobalMaxDistOf, usesGlobalCharge, chargeThetaOf,
  usesEngineGrowth, usesEngineSprings, usesPositionalCollision, usesSoftCollision,
  usesBondingPhysics,
} from './centerBased';
import { agentGraphUsesBondRequests } from '../modeler/vpl/compiler/bondRequestQueue';
import { dividePartitionTableForModel } from '../modeler/vpl/compiler/dividePartition';
import { sparseSteppingEnabled } from '../modeler/vpl/compiler/sparseStepping';
import { periodicParams } from '../modeler/vpl/compiler/periodicExpand';
import { agentGraphReadsEngineDensity } from '../modeler/vpl/compiler/densityExpand';
import { analyzeGeometryTaint } from '../modeler/vpl/compiler/geometryTaint';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** WHEN a phase runs — the Appendix A question ("is this the hot path?"),
 *  answerable at a glance instead of by reading the worker.
 *   generation — the hot path; runs N times per rendered frame.
 *   event      — only when its event occurs (a division, per daughter).
 *   frame      — amortized by Gens/Frame; orchestration, not the hot path.
 *   reset      — the cold path; a one-time seeding loop. */
export type PhaseTempo = 'generation' | 'event' | 'frame' | 'reset';

/** WHOSE code this phase is. The whole point of the panel. */
export type PhaseOwner = 'graph' | 'engine';

export interface PipelinePhase {
  /** Stable id — the harness's order expectation and C8's `presentation` hook
   *  key off this, so renaming one is a deliberate, test-visible edit. */
  id: string;
  title: string;
  owner: PhaseOwner;
  tempo: PhaseTempo;
  /** Does this phase do anything for THIS model? */
  active: boolean;
  /** When inactive: what turns it on (a capability / a setting / a node). */
  capability?: string;
  /** Resolved numbers or a one-line explanation of what the phase does. */
  detail?: string;
  /** Groups consecutive phases under a bracket in the UI (the force-iteration
   *  loop and the structural phase). */
  group?: string;
  /** C8 (P9) — set on the force / motion / layout phases when
   *  `analyzeGeometryTaint` finds that no rule reads geometry into a decision.
   *  Those phases then decide only WHERE things sit, so the UI renders
   *  "presentation only — does not affect your rule". Absent/false means
   *  geometry is load-bearing (a promotion, not a problem — see P9). */
  presentation?: boolean;
}

/** Group headers, so the UI can label a bracket with its own resolved number
 *  ("×2 iterations") without re-deriving it. */
export interface PipelineGroup {
  id: string;
  title: string;
  detail?: string;
}

/** The bracket headers for a model's grouped phases, each carrying its own
 *  RESOLVED number (the force loop's iteration count comes from
 *  `layoutIterationsOf` — the same clamped resolver every engine surface reads,
 *  so the header cannot claim a count the engine does not run). */
export function describePipelineGroups(model: CAModel): Record<string, PipelineGroup> {
  const iterations = layoutIterationsOf(model.centerBased);
  return {
    forces: {
      id: 'forces', title: 'Engine forces & motion',
      detail: iterations === 1 ? '×1 iteration' : `×${iterations} iterations per generation`,
    },
    structural: {
      id: 'structural', title: 'Structural phase',
      detail: 'topology changes · CPU on every engine',
    },
  };
}

/** C8 (P9) — the phases that MOVE things: the force-iteration loop plus the
 *  positional-collision projection. When the taint check passes, these are the
 *  block P9 calls presentation ("where things sit"), so they carry the label.
 *  The spatial hash is deliberately NOT here — it is a query structure the
 *  RULE also uses (a proximity query reads it), not a mover. */
export const PRESENTATION_PHASE_IDS: ReadonlySet<string> = new Set([
  'agent.forceReset', 'agent.charge', 'agent.softCollision', 'agent.springs',
  'agent.integrate', 'agent.growth', 'agent.positional',
]);

export const TEMPO_LABEL: Record<PhaseTempo, string> = {
  generation: 'per generation',
  event: 'per event',
  frame: 'per frame',
  reset: 'once per reset',
};

export const TEMPO_TITLE: Record<PhaseTempo, string> = {
  generation: 'The hot path — this runs once per generation, i.e. N times per rendered frame.',
  event: 'Runs only when its event occurs, not every generation.',
  frame: 'Runs once per rendered frame (amortized by Gens/Frame) — orchestration, not the hot path.',
  reset: 'Cold path — runs once, on load and on Reset.',
};

// ---------------------------------------------------------------------------
// Macro-aware node scan (the `walkNodes` discipline from targetDiagnosis.ts —
// the compilers flatten macros up front, so a node inside a macro instance is
// every bit as real as a top-level one).
// ---------------------------------------------------------------------------

function walkNodes(
  roots: ReadonlyArray<GraphNode> | undefined,
  model: CAModel,
  visit: (nodeType: string, config: NodeConfig) => void,
): void {
  const macroDefs = model.macroDefs ?? [];
  const seen = new Set<string>();
  const scan = (nodes: ReadonlyArray<GraphNode> | undefined): void => {
    for (const n of nodes ?? []) {
      const t = n.data?.nodeType as string | undefined;
      if (!t) continue;
      const cfg = (n.data?.config ?? {}) as NodeConfig;
      if (t === 'macro') {
        const defId = cfg.macroDefId as string | undefined;
        if (defId && !seen.has(defId)) {
          seen.add(defId);
          scan(macroDefs.find(d => d.id === defId)?.nodes as ReadonlyArray<GraphNode> | undefined);
        }
        continue;
      }
      visit(t, cfg);
    }
  };
  scan(roots);
}

/** Which node types this model's two rule graphs contain (macro-aware). The
 *  graph-CONTENT half of the pipeline's activity bits — see the header. */
interface GraphContent {
  cell: Set<string>;
  agent: Set<string>;
  /** Every Agent Periodic Step's resolved cadence, via the lowering's OWN clamp. */
  cadences: Array<{ period: number; phase: number }>;
  /** Every Grid Periodic Event's resolved cadence (the CELL graph's GLOBAL root). */
  gridCadences: Array<{ period: number; phase: number }>;
  /** Every Population Periodic Event's resolved cadence (the AGENT graph's GLOBAL root). */
  agentCadences: Array<{ period: number; phase: number }>;
}

function graphContent(model: CAModel): GraphContent {
  const cell = new Set<string>();
  const agent = new Set<string>();
  const cadences: Array<{ period: number; phase: number }> = [];
  const gridCadences: Array<{ period: number; phase: number }> = [];
  const agentCadences: Array<{ period: number; phase: number }> = [];
  walkNodes(model.graphNodes, model, (t, cfg) => {
    cell.add(t);
    if (t === 'gridPeriodic') gridCadences.push(periodicParams(cfg as unknown as Record<string, unknown>));
  });
  walkNodes(model.agentGraphNodes, model, (t, cfg) => {
    agent.add(t);
    if (t === 'periodicStep') {
      cadences.push(periodicParams(cfg as unknown as Record<string, unknown>));
    }
    if (t === 'agentPeriodic') agentCadences.push(periodicParams(cfg as unknown as Record<string, unknown>));
  });
  return { cell, agent, cadences, gridCadences, agentCadences };
}

/** "every 10th generation (phase 0)" / "2 cadences: ×10 (phase 0), ×3 (phase 1)". */
function describeCadences(cs: Array<{ period: number; phase: number }>): string {
  if (cs.length === 1) {
    const c = cs[0]!;
    return c.period === 1 ? 'every generation' : `every ${c.period}th generation (phase ${c.phase})`;
  }
  return `${cs.length} cadences: ${cs.map(c => `×${c.period} (phase ${c.phase})`).join(', ')}`;
}

const hasAny = (set: Set<string>, ...types: string[]) => types.some(t => set.has(t));

// ---------------------------------------------------------------------------
// Formatting helpers — a resolved number reads as a number, not 0.30000000004.
// ---------------------------------------------------------------------------

function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  // 4 significant decimals is enough for every engine constant, and trims the
  // f64 noise a raw String() would show.
  return String(Math.round(v * 10000) / 10000);
}

/** The integration formula with THIS model's resolved numbers, e.g.
 *  `v = 0.9·v + (0.05/1)·ΣF, speed cap 2.0`. The Δt is the EFFECTIVE one (C1's
 *  shared helper — the same value `clampAgentDt` gives the integrator), so a
 *  clamped model shows what actually runs rather than what was typed. */
export function integrationFormula(cfg: CenterBasedConfig | undefined | null): string {
  // C9 / STEP 6 — the motion mode decides whether there IS an integration.
  const mode = agentMotionMode(cfg);
  if (mode === 'static') return 'nothing moves — positions change only when your graph writes them';
  if (mode === 'velocity') return 'x += v — the velocity your graph set, no engine force';
  const momentum = Math.max(0, Math.min(0.999, cbNum(cfg, 'momentum')));
  const eta = Math.max(1e-6, cbNum(cfg, 'drag'));
  const maxSpeed = Math.max(0, cbNum(cfg, 'maxSpeed'));
  const dt = effectiveAgentDt(cfg).dt;
  const cap = maxSpeed > 0 ? `speed cap ${num(maxSpeed)}` : 'uncapped';
  return `v = ${num(momentum)}·v + (${num(dt)}/${num(eta)})·ΣF · ${cap}`;
}

// ---------------------------------------------------------------------------
// The phases
// ---------------------------------------------------------------------------

/** Describe one generation of THIS model, in execution order.
 *
 *  Read-only and pure: it answers "what does the model ASK for", from the model
 *  alone. Whether a fast path actually ENGAGED at runtime is a different
 *  question (C3's diagnostics), deliberately not mixed in here. */
export function describeGenerationPipeline(model: CAModel): PipelinePhase[] {
  const out: PipelinePhase[] = [];
  const push = (p: PipelinePhase) => { out.push(p); };

  const gridOn = model.topologyMode?.gridCells !== false;
  const agentsOn = !!model.topologyMode?.agents;
  const cfg = model.centerBased;
  const content = graphContent(model);

  // =========================================================================
  // RESET — the init roots. They run once, before generation 1, in this order
  // (worker reset handler: runInit → runGridInit → runAgentInit).
  // =========================================================================
  if (gridOn) {
    push({
      id: 'init.cell', title: 'Your Init Event', owner: 'graph', tempo: 'reset',
      active: content.cell.has('initEvent'),
      capability: 'an Init Event node in the Cells graph',
      detail: 'runs once per cell, on load and on Reset',
    });
    push({
      id: 'init.grid', title: 'Your Grid Init Event', owner: 'graph', tempo: 'reset',
      active: content.cell.has('gridInit'),
      capability: 'a Grid Init Event node in the Cells graph',
      detail: 'runs ONCE globally — free-form procedural seeding',
    });
  }
  if (agentsOn) {
    push({
      id: 'init.agent', title: 'Your Agent Init Event', owner: 'graph', tempo: 'reset',
      active: content.agent.has('agentInit'),
      capability: 'an Agent Init Event node in the Agents graph',
      detail: 'runs ONCE — spawns the starting population',
    });
  }

  // =========================================================================
  // PER GENERATION — the GLOBAL periodic events first (they run at the TOP of
  // the generation so a substrate write / a spawn is visible to THIS
  // generation's rules), then agents, then the cell CA (the closed agent↔grid
  // loop: the agent gathers the field as of the previous cell step, deposits,
  // THEN the cell CA steps and incorporates the deposit).
  // =========================================================================
  if (gridOn) {
    push({
      id: 'periodic.grid', title: 'Your Grid Periodic Event', owner: 'graph', tempo: 'generation',
      active: content.cell.has('gridPeriodic'),
      capability: 'a Grid Periodic Event node in the Cells graph',
      detail: content.gridCadences.length > 0
        ? `runs ONCE globally on ${describeCadences(content.gridCadences)}`
        : 'runs ONCE globally every Nth generation — before both layers step',
    });
  }
  if (agentsOn) {
    push({
      id: 'periodic.agent', title: 'Your Population Periodic Event', owner: 'graph', tempo: 'generation',
      active: content.agent.has('agentPeriodic'),
      capability: 'a Population Periodic Event node in the Agents graph',
      detail: content.agentCadences.length > 0
        ? `runs ONCE globally (not per agent) on ${describeCadences(content.agentCadences)}`
        : 'runs ONCE globally (not per agent) every Nth generation — before the behaviour',
    });
  }
  if (agentsOn) {
    const syncAttrs = cfg?.agentUpdateMode === 'sync';
    const bonds = resolveMaxBonds(cfg);
    const springs = usesEngineSprings(cfg);
    const charge = usesCharge(cfg);
    // C10 — GLOBAL charge does NOT ride the stencil (the octree carries it), so it
    // neither widens the bin edge nor joins the scan gate.
    const chargeGlobal = usesGlobalCharge(cfg);
    const chargeCutoff = charge && !chargeGlobal;
    const softCollision = usesSoftCollision(cfg);
    const positional = usesPositionalCollision(cfg);
    const growthOn = usesEngineGrowth(cfg) && cbNum(cfg, 'growthRate') > 0;
    // The SHARED consumer predicate (agentFieldGating + SimulatorView read the same
    // one): `divideAgent` always, `neighbourDensity` only while its Radius is
    // INACTIVE — an active Radius lowers the node to a fresh Get Nearby Agents
    // count, so the engine reduction has no reader and the scan does not run.
    const usesDensity = agentGraphReadsEngineDensity(model);
    // The neighbour scan runs when ANY of its three consumers do — the worker's
    // own `doScan = doForce || agentUsesDensity || doCharge`.
    const scan = softCollision || usesBondingPhysics(cfg) || usesDensity || chargeCutoff;

    push({
      id: 'agent.forceReset', title: 'Reset force accumulators', owner: 'engine', tempo: 'generation',
      // C9 / STEP 6 — only Force motion accumulates engine forces at all.
      active: motionAppliesForces(cfg), capability: 'Motion = Force',
      detail: 'per-generation forces start at zero — your Apply Force adds into them',
    });
    push({
      id: 'agent.spatialHash', title: 'Build spatial hash', owner: 'engine', tempo: 'generation',
      active: true,
      detail: `neighbour queries up to radius ${num(cbNum(cfg, 'neighbourQueryRadius'))}${
        scan && chargeCutoff ? ` (widened to the charge cutoff ${num(chargeMaxDistOf(cfg))})` : ''
      } · O(N), not O(N²)`,
    });
    push({
      id: 'agent.primeAttrs', title: 'Prime synchronous attribute buffer', owner: 'engine', tempo: 'generation',
      active: syncAttrs,
      capability: 'Agent Update Mode = Synchronous',
      detail: 'clone read → write, so the behaviour reads the PREVIOUS generation',
    });

    const cadence = content.cadences.length > 0
      ? ` · cadence ${content.cadences.map(c => `every ${c.period}${c.phase ? ` (phase ${c.phase})` : ''}`).join(', ')}`
      : '';
    // The closed agent↔grid loop (Decision D-FIELD): the field IS the lattice CA.
    // A field node makes the deposit happen HERE, inside the behaviour — which is
    // exactly why the agent half runs BEFORE the cell half.
    const FIELD_NODES = ['sampleField', 'fieldGradient', 'readCellsUnder', 'affectCellsUnder', 'secreteToField'];
    const fieldNote = gridOn && hasAny(content.agent, ...FIELD_NODES)
      ? ' · reads/writes the cell field here — your deposit is what the cell step below then sees'
      : '';
    push({
      id: 'agent.behaviour', title: 'Your Behaviour Step graph', owner: 'graph', tempo: 'generation',
      active: hasAny(content.agent, 'behaviourStep', 'periodicStep'),
      capability: 'a Behaviour Step (or Periodic Step) node in the Agents graph',
      detail: `runs once per agent · ${syncAttrs ? 'synchronous (parallel reads)' : 'asynchronous (sequential — a write is visible to a later agent this generation)'}${cadence}${fieldNote}`,
    });
    push({
      id: 'agent.commitAttrs', title: 'Commit synchronous attribute writes', owner: 'engine', tempo: 'generation',
      active: syncAttrs,
      capability: 'Agent Update Mode = Synchronous',
      detail: 'the written buffer becomes the live one',
    });

    // --- the force-iteration loop ------------------------------------------
    push({
      id: 'agent.charge', title: 'Long-range charge', owner: 'engine', tempo: 'generation',
      group: 'forces', active: charge, capability: 'Charge',
      detail: !charge ? undefined
        : chargeGlobal
          // GLOBAL sums through the octree rather than the stencil. Its cutoff is
          // OPTIONAL (absent ⇒ genuinely every pair), so the sentence has to say
          // which of the two laws is running rather than assume the unbounded one.
          ? `k = ${num(chargeParamsOf(cfg).chargeK)} · GLOBAL (Barnes–Hut θ = ${num(chargeThetaOf(cfg))}) — summed through a deterministic octree, ${
            Number.isFinite(chargeGlobalMaxDistOf(cfg))
              ? `truncated at ${num(chargeGlobalMaxDistOf(cfg))}`
              : 'every pair interacts (no cutoff)'}`
          : `k = ${num(chargeParamsOf(cfg).chargeK)} · cutoff ${num(chargeMaxDistOf(cfg))} (the only engine force with reach past contact)`,
    });
    push({
      id: 'agent.softCollision', title: 'Soft-sphere collision', owner: 'engine', tempo: 'generation',
      group: 'forces', active: softCollision, capability: 'Collision = Soft-sphere',
      detail: softCollision
        ? `repulsion μ_R = ${num(cbNum(cfg, 'repulsionStiffness'))}${usesBondingPhysics(cfg) ? ` · adhesion μ_A = ${num(cbNum(cfg, 'adhesionStiffness'))}` : ''} · range ${num(cbNum(cfg, 'interactionRange'))}×contact`
        : undefined,
    });
    push({
      id: 'agent.springs', title: 'Bond springs', owner: 'engine', tempo: 'generation',
      group: 'forces', active: springs && bonds > 0, capability: 'Bonds = Physics',
      detail: springs && bonds > 0
        ? `λ = ${num(cbNum(cfg, 'bondStiffness'))} · rest length ${num(cbNum(cfg, 'bondRestLength'))}`
        : undefined,
    });
    push({
      // C9 / STEP 6 — under Motion = Static the engine writes no position at all
      // (the force pass AND the position commit are both skipped), so the row is
      // OFF and names the capability that turns it back on.
      id: 'agent.integrate', title: 'Integrate & commit positions', owner: 'engine', tempo: 'generation',
      group: 'forces', active: motionIntegrates(cfg), capability: 'Motion (Velocity or Force)',
      detail: integrationFormula(cfg),
    });
    push({
      id: 'agent.growth', title: 'Growth ramp', owner: 'engine', tempo: 'generation',
      group: 'forces', active: growthOn, capability: 'Growth',
      detail: growthOn ? `radius → target, ${num(cbNum(cfg, 'growthRate'))} per generation` : undefined,
    });

    push({
      id: 'agent.positional', title: 'Positional collision projection', owner: 'engine', tempo: 'generation',
      active: positional, capability: 'Collision = Positional',
      detail: positional
        ? `${Math.max(1, Math.floor(cbNum(cfg, 'positionalIterations')))} Jacobi sweeps — a rigid no-overlap constraint after integration`
        : undefined,
    });

    // --- the structural phase ----------------------------------------------
    // CPU on EVERY engine (serial surgery on a ragged store) — the documented
    // reason a bonded model is never GPU-resident.
    const usesQueue = agentGraphUsesBondRequests(model);
    const divides = dividePartitionTableForModel(model).length > 0;
    const kills = content.agent.has('killAgent');
    const autoBond = springs && !!cfg?.autoBond && bonds > 0;
    push({
      id: 'structural.drain', title: 'Drain bond-request queue', owner: 'engine', tempo: 'generation',
      group: 'structural', active: usesQueue,
      capability: 'a Form / Break / Rewire / Form Between Bond node',
      detail: usesQueue
        ? `up to ${cbNum(cfg, 'bondRequestDepth')} requests per agent per generation, applied in the order your graph issued them`
        : undefined,
    });
    push({
      id: 'structural.death', title: 'Deaths', owner: 'engine', tempo: 'generation',
      group: 'structural', active: kills, capability: 'a Kill Agent node',
      detail: kills ? 'recycle killed agents — breaks their bonds and bumps the slot epoch' : undefined,
    });
    push({
      id: 'structural.divide', title: 'Divisions', owner: 'engine', tempo: 'generation',
      group: 'structural', active: divides, capability: 'a Divide Agent node',
      detail: divides ? describeDivision(model) : undefined,
    });
    push({
      id: 'agent.divisionEvent', title: 'Your Division Event graph', owner: 'graph', tempo: 'event',
      group: 'structural', active: content.agent.has('divisionEvent'),
      capability: 'a Division Event node in the Agents graph',
      detail: 'runs once per daughter, per division',
    });
    push({
      id: 'structural.autoBond', title: 'Auto-bond by distance', owner: 'engine', tempo: 'generation',
      group: 'structural', active: autoBond, capability: 'Auto-bond with Bonds = Physics',
      detail: autoBond
        ? `form within ${num(cbNum(cfg, 'formDistance'))}×contact · break past ${num(cbNum(cfg, 'breakDistance'))}×contact`
        : undefined,
    });
    push({
      id: 'structural.sweep', title: 'Stale-bond sweep', owner: 'engine', tempo: 'generation',
      group: 'structural', active: bonds > 0, capability: 'Bonds',
      detail: bonds > 0 ? 'drops bonds whose partner slot was recycled' : undefined,
    });

    push({
      id: 'agent.sprites', title: 'Advance sprite frames', owner: 'engine', tempo: 'generation',
      active: (model.sprites?.length ?? 0) > 0, capability: 'a sprite in the Sprite Library',
      detail: 'animation is logic-driven — it only advances while the simulation runs',
    });
  }

  // --- the cell half -------------------------------------------------------
  if (gridOn) {
    const isAsync = model.properties.updateMode === 'asynchronous';
    const sparse = sparseSteppingEnabled(model);
    push({
      id: 'cell.asyncOrder', title: 'Shuffle cell update order', owner: 'engine', tempo: 'generation',
      active: isAsync, capability: 'Update Mode = Asynchronous',
      detail: isAsync ? `scheme: ${model.properties.asyncScheme ?? 'random-order'}` : undefined,
    });
    push({
      id: 'cell.step', title: 'Your Generation Step graph', owner: 'graph', tempo: 'generation',
      active: content.cell.has('step'), capability: 'a Generation Step node in the Cells graph',
      detail: `runs once per cell · ${isAsync
        ? 'asynchronous (sequential — a write is visible to a later cell this generation)'
        : 'synchronous (parallel — every cell reads the previous generation)'}`,
    });
    push({
      id: 'cell.sparse', title: 'Skip isolated empty cells', owner: 'engine', tempo: 'generation',
      active: sparse, capability: 'Skip Isolated Empty Cells (synchronous CA-grid models without glyphs)',
      detail: sparse ? 'only cells near a non-empty cell are stepped — same results, O(active) instead of O(total)' : undefined,
    });
    push({
      id: 'cell.swap', title: 'Double-buffer swap', owner: 'engine', tempo: 'generation',
      active: !isAsync, capability: 'Update Mode = Synchronous',
      detail: !isAsync ? "the written buffer becomes the next generation's read buffer" : undefined,
    });
  }

  // Indicators aggregate over BOTH layers' state (linked = cell attributes,
  // graph = the agent bond graph), so the phase belongs to neither half.
  const indicatorCount = (model.indicators ?? []).filter(i => i.kind !== 'standalone').length;
  push({
    id: 'indicators', title: 'Indicator aggregation', owner: 'engine', tempo: 'generation',
    active: indicatorCount > 0, capability: 'a linked or graph indicator',
    detail: indicatorCount > 0 ? `${indicatorCount} computed indicator${indicatorCount === 1 ? '' : 's'}` : undefined,
  });

  // =========================================================================
  // PER FRAME — the colour passes. Amortized by Gens/Frame, so they are NOT
  // the hot path (Appendix A).
  // =========================================================================
  if (gridOn) {
    const oms = (model.mappings ?? []).filter(m => m.isAttributeToColor);
    const linked = oms.filter(m => m.linked).length;
    push({
      id: 'color.cells', title: 'Colour pass — cells (A→C)', owner: oms.length > linked ? 'graph' : 'engine',
      tempo: 'frame', active: oms.length > 0, capability: 'an Attribute→Color mapping',
      detail: oms.length > 0
        ? `${oms.length} view${oms.length === 1 ? '' : 's'}${linked === oms.length ? ' (all auto-generated from an attribute)' : ''}`
        : undefined,
    });
  }
  if (agentsOn) {
    // Only the A->C half is a colour pass; `agentMappings` also holds the C->A
    // INPUT mappings, which run on a user PAINT gesture, not per generation.
    const ams = (model.agentMappings ?? []).filter(m => m.isAttributeToColor);
    push({
      id: 'color.agents', title: 'Colour pass — agents (A→C)', owner: 'engine', tempo: 'frame',
      active: ams.length > 0, capability: 'an Agent Output Mapping',
      detail: ams.length > 0
        ? `${ams.length} agent view${ams.length === 1 ? '' : 's'} — otherwise agents are coloured by Set Cell Looks in the behaviour`
        : undefined,
    });
  }

  // C8 (P9) — when no rule reads geometry into a decision, the movers above are
  // presentation. The verdict comes from `analyzeGeometryTaint`, which is the
  // single source for it (the C1 readout and Help read the same function).
  if (agentsOn) {
    const taint = analyzeGeometryTaint(model);
    if (taint.applicable && taint.presentational) {
      for (const p of out) if (PRESENTATION_PHASE_IDS.has(p.id)) p.presentation = true;
    }
  }

  return out;
}

/** The division phase's detail line, from the SAME partition table the engine
 *  indexes at runtime (`dividePartitionTableForModel`). */
function describeDivision(model: CAModel): string {
  const table = dividePartitionTableForModel(model);
  const modes = [...new Set(table.map(s => s.mode))];
  const label: Record<string, string> = {
    tension: 'tension axis',
    alternate: 'alternating bond slots',
    byBondAttribute: 'by bond attribute',
  };
  const partition = modes.map(m => label[m] ?? m).join(' / ');
  const policies = [...new Set(table.map(s => s.daughterBond))];
  return `bonds partitioned by ${partition} · daughter–daughter bond: ${policies.join(' / ')}`;
}
