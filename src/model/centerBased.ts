import type { CenterBasedConfig, ChargeRange } from './types';

/** Bond-Graph Agents — engine defaults for every live-tunable / ceiling field
 *  on `CenterBasedConfig`. Single source of truth shared by the worker (the
 *  force integrator + allocation), the modeler UI (Properties config section),
 *  and the seed/brush defaults — so a partially-populated or hand-authored
 *  config always runs and the UI shows the same fallback the engine uses.
 *
 *  Force-law grounding (center-based literature, see
 *  docs/INVESTIGATION_CENTER_BASED.md §6.3): rest length `s = 1` cell diameter
 *  (here the per-pair contact distance is the SUM of the two agents' radii so a
 *  default radius of 0.5 gives s = 1.0), cutoff `r_max ≈ 1.5·s`, drag `η = 1`,
 *  and `Δt` auto-clamped against the Mathias-2020 monotonicity bound
 *  `Δt*_mono = ½(r₀−s)/F(r₀)` with a 0.4 safety factor. For a linear spring
 *  `F = μ(d−s)` that bound reduces to `1/(2μ_eff)`, so the engine clamps
 *  `Δt ≤ 0.4 · 1/(2·μ_eff)` where `μ_eff = μ_R + max-bond-λ`. */
export const CENTER_BASED_DEFAULTS = {
  maxAgents: 2000,
  maxBonds: 8,
  worldWidth: 100,
  worldHeight: 100,
  worldDepth: 1,
  repulsionStiffness: 2.0,   // μ_R
  adhesionStiffness: 0.0,    // μ_A (cohesion via bonds by default)
  interactionRange: 1.5,     // r_max / s
  drag: 1.0,                 // η
  timeStep: 0.1,             // Δt_user (pre-clamp)
  momentum: 0.0,             // 0 = overdamped (tissue); ~0.9 = flocking inertia
  maxSpeed: 0.0,             // 0 = uncapped
  neighbourQueryRadius: 5.0, // sizes the spatial-hash bin so Get Nearby Agents within this radius is covered by the 3×3 stencil
  seedCount: 0,
  defaultRadius: 0.5,        // → contact distance 1.0 between two default agents
  growthRate: 0.02,          // radius units per step toward targetRadius
  bondStiffness: 1.0,        // λ when no spring matrix
  bondRestLength: 1.0,       // L when no spring matrix (else = contact distance)
  formDistance: 1.1,         // d_form, × contact distance (auto-bond within)
  breakDistance: 1.6,        // d_break, × contact distance (> d_form — hysteresis)
  positionalIterations: 2,   // Jacobi sweeps for the hard positional collision (more = tighter no-overlap packing)
  layoutIterations: 1,       // force-pass runs per generation (1 = today's engine, byte-identical); see layoutIterationsOf
  chargeStrength: -3,        // k for the long-range charge (NEGATIVE = repulsive); see usesCharge
  chargeMaxDist: 0,          // 0 / absent ⇒ the DERIVED default 8 × bondRestLength (see chargeMaxDistOf)
  bondRequestDepth: 8,       // GRA P4 — per-agent structural-request QUEUE depth (form/break/rewire ops per generation)
} as const;

export type CenterBasedNumericKey = keyof typeof CENTER_BASED_DEFAULTS;

/** A fresh default config (used when the user enables the Agents topology).
 *  `useBondingPhysics: false` is the deliberate NEW default — enabling agents no
 *  longer silently turns on the engine soft-sphere repulsion/adhesion + growth +
 *  auto-bond; the user opts in via the "Use bonding physics" toggle. (Legacy files
 *  that lack the field resolve through `usesBondingPhysics`'s `!customForcesOnly`
 *  fallback, so their behaviour is preserved with no migration.) */
export function defaultCenterBasedConfig(): CenterBasedConfig {
  return {
    enabled: true,
    maxAgents: CENTER_BASED_DEFAULTS.maxAgents,
    // 0 by default: bonding physics is OFF for a freshly-enabled Agents topology,
    // so the bond store isn't allocated. Enabling "Use bonding physics" in the
    // Properties panel bumps this to the engine default if it's still 0.
    maxBonds: 0,
    worldWidth: CENTER_BASED_DEFAULTS.worldWidth,
    worldHeight: CENTER_BASED_DEFAULTS.worldHeight,
    useBondingPhysics: false,
    // C4 (P1): a freshly-enabled Agents topology declares an INTENT — Auto picks
    // the fastest agent engine this graph can use (resolved + displayed by
    // `resolveEngines`). Existing files keep whatever they stored; the migration
    // deliberately does NOT flip them to 'auto'.
    agentTarget: 'auto',
  };
}

/** Resolve the "use bonding physics" master toggle. When true, the engine runs the
 *  full center-based soft-sphere + bond springs + growth ramp + auto-bond; when
 *  false, agents move ONLY by graph-authored forces (the custom-force / boids case).
 *  The `?? !customForcesOnly` fallback is the back-compat bridge: a legacy config
 *  that predates `useBondingPhysics` resolves to the old `engineForces =
 *  !customForcesOnly` semantics, so every existing `.gcaproj` keeps its behaviour
 *  with NO migration (absent both ⇒ `!undefined` ⇒ true ⇒ engine physics on, as
 *  before). The worker reads this in `runAgentStep` / `runAgentStructuralPhase`. */
export function usesBondingPhysics(cfg: CenterBasedConfig | undefined | null): boolean {
  return cfg?.useBondingPhysics ?? !cfg?.customForcesOnly;
}

/** Resolve the collision MODE this model runs — the SINGLE source of truth for the
 *  Collision capability's engine effect. `'soft'` = the soft-sphere repulsion FORCE
 *  (a penalty force added to the integrator); `'positional'` = a hard, no-overlap
 *  POSITION-PROJECTION constraint applied after integration (rigid particles);
 *  `'off'` = neither. Profile-aware, INDEPENDENT of the bonding-physics bundle (so a
 *  pure gas collides without cohesion/springs). Legacy files without a profile fall
 *  back to `usesBondingPhysics ? 'soft' : 'off'`, so they're byte-identical (the
 *  shipped/inferred profiles are only ever `soft`/`off`, never `positional`). */
export function collisionMode(cfg: CenterBasedConfig | undefined | null): 'off' | 'soft' | 'positional' {
  const c = cfg?.agentCapabilities?.collision;
  if (c === 'off' || c === 'soft' || c === 'positional') return c;
  return usesBondingPhysics(cfg) ? 'soft' : 'off';
}
/** Any collision on (soft OR positional). */
export function usesEngineCollision(cfg: CenterBasedConfig | undefined | null): boolean {
  return collisionMode(cfg) !== 'off';
}
/** The SOFT-sphere repulsion force runs (gates the force-pass `doCollision`). False
 *  for `positional` — the projection replaces the soft force there. */
export function usesSoftCollision(cfg: CenterBasedConfig | undefined | null): boolean {
  return collisionMode(cfg) === 'soft';
}
/** The hard POSITIONAL projection pass runs (a rigid no-overlap constraint after
 *  integration). Distinct from soft; runs under any Motion (it edits positions). */
export function usesPositionalCollision(cfg: CenterBasedConfig | undefined | null): boolean {
  return collisionMode(cfg) === 'positional';
}

/** C6 (P5) — OBSERVATION ONLY: did a capability-gated resolver actually fall back
 *  to the legacy physics flags for this config?
 *
 *  The Agent Capability Profile is the authoritative source of engine physics.
 *  `LOAD_MODEL` seeds one on every agent model (`migrateAgentCapabilities` →
 *  `inferAgentProfile`) and `serializeModel` writes `centerBased` verbatim, so a
 *  loaded-then-saved file always carries an explicit profile. The `?? legacy` arms
 *  below therefore only ever decide behaviour for a file that reached the engine
 *  WITHOUT going through the migration — a hand-edited `.gcaproj`, or a config
 *  synthesised by a script.
 *
 *  This predicate is the EXACT UNION of the two fallback conditions above, derived
 *  from the same field tests (never a re-implementation of the rules):
 *    - `usesEngineSprings` / `usesEngineGrowth` take their legacy arm iff the whole
 *      `agentCapabilities` object is absent;
 *    - `collisionMode` takes its legacy arm iff `agentCapabilities.collision` is not
 *      one of the three literals (so a partial profile counts too).
 *  `usesBondingPhysics` (the adhesion μ_A knob) is deliberately EXCLUDED: it has no
 *  capability control at all, so it is not a fallback — it is the only mechanism.
 *  See the "legacy physics flags" removal schedule in CLAUDE.md.
 *
 *  Adding this function changes NOTHING about how any resolver resolves. */
export function legacyPhysicsFlagsInEffect(cfg: CenterBasedConfig | undefined | null): boolean {
  if (!cfg) return false;
  const caps = cfg.agentCapabilities;
  if (!caps) return true;
  const c = caps.collision;
  return !(c === 'off' || c === 'soft' || c === 'positional');
}

// ---------------------------------------------------------------------------
// L1 — the LONG-RANGE CHARGE force. The one engine force with reach BEYOND
// contact distance, and therefore the only one that can hold a grown structure
// open. Everything below is default-OFF and resolved from the profile, so a model
// without the capability produces byte-identical code on every target.
//
// WHY IT EXISTS (measured, not reasoned — see docs/IMPACT_MAP_GRAPH_LAYOUT_CADENCE):
// the soft-sphere repels only below `sij = ri + rj`, ATTRACTS from there to
// `interactionRange × sij`, and is zero beyond — while bonds rest much further out.
// So a node pushes back only once something is on top of it and a growing bond
// graph collapses: 99.2 % of nodes ended up with an unrelated node inside contact
// distance. Widening `interactionRange` does NOT help (it widens the SEARCH, not
// the force, and past contact the sign flips to adhesion). Charge fixes it.
// ---------------------------------------------------------------------------

/** Resolve whether the engine runs the LONG-RANGE CHARGE pair force. Profile-aware
 *  and, unlike the other physics resolvers, it has **no legacy fallback** — charge
 *  is net-new, so a config without the capability (every pre-L1 `.gcaproj`) can only
 *  ever resolve to `false` and stays byte-identical. An explicit-but-partial profile
 *  (JSON that predates the field) reads `undefined !== 'on'` ⇒ off, by construction. */
export function usesCharge(cfg: CenterBasedConfig | undefined | null): boolean {
  return cfg?.agentCapabilities?.charge === 'on';
}

/** The charge strength `k` (negative = repulsive). Absent ⇒ the engine default. */
export function chargeStrengthOf(cfg: CenterBasedConfig | undefined | null): number {
  return cbNum(cfg, 'chargeStrength');
}

/** The charge CUTOFF distance. A stored positive value wins; otherwise the DERIVED
 *  default `8 × bondRestLength` (DC6). Deliberately NOT a world-absolute constant:
 *  the measured sweet spot is a MULTIPLE of the model's own bond rest length
 *  (quality saturates by ~8×; unbounded merely inflates the layout), so the default
 *  has to scale with the model. Always finite and > 0 so the `min_c` term and the
 *  bin-edge widening below are well-defined. */
export const CHARGE_MAX_DIST_REST_MULTIPLE = 8;
export function chargeMaxDistOf(cfg: CenterBasedConfig | undefined | null): number {
  const v = cfg?.chargeMaxDist;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return CHARGE_MAX_DIST_REST_MULTIPLE * Math.max(1e-6, cbNum(cfg, 'bondRestLength'));
}

// ---------------------------------------------------------------------------
// C10 / P11a — CHARGE RANGE: cutoff (L1) vs GLOBAL (deterministic Barnes–Hut).
//
// `cutoff` is the shipped pair force, truncated at `chargeMaxDist` and evaluated
// inside the neighbour stencil. `global` is a DIFFERENT LAW: no cutoff at all
// (`min_c = 0`), every pair contributes, and the sum is θ-approximated by an
// octree traversal instead of a stencil walk. The two consequences that ripple
// everywhere:
//   • the cutoff PAIR TERM is off under global (`ChargeParams.doCharge`), so the
//     force is never double-counted;
//   • `chargeBinEdgeOf` returns 0 under global — the stencil carries no charge, so
//     widening it would be pure cost (and 3D cost grows with the CUBE of the edge).
// ---------------------------------------------------------------------------

/** The GLOBAL charge's optional CUTOFF distance. Unlike `chargeMaxDistOf` (the
 *  cutoff law, which DERIVES `8 × bondRestLength` when unset) global has **no
 *  derived default**: absent / 0 ⇒ `Infinity` ⇒ every pair contributes, which is
 *  the law C10 shipped, behaviour-identical.
 *
 *  A stored positive value truncates the tree sum exactly the way the reference
 *  implementation does (`calcMultibodyForce`): the coefficient becomes
 *  `1/(1+l²) − 1/(1+maxDist²)` so it reaches zero CONTINUOUSLY at the cutoff, and
 *  nodes/leaf points beyond it are culled. That matters at scale — without it the
 *  far field of N distant nodes sums to ≈ N/l, which grows with the population and
 *  INFLATES the layout without bound.
 *
 *  `Infinity` is the deliberate sentinel rather than a flag: `l² < Infinity` is
 *  always true and `1/(1+Infinity) = 0`, and `x − 0 === x` bit-exactly for every
 *  finite x — so the culled formula collapses to the un-culled one with no second
 *  code path and no drift between the three targets. */
export function chargeGlobalMaxDistOf(cfg: CenterBasedConfig | undefined | null): number {
  const v = cfg?.chargeMaxDist;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : Infinity;
}

/** Which charge law this model runs. Absent ⇒ `'cutoff'` ⇒ byte-identical to L1. */
export function chargeRangeOf(cfg: CenterBasedConfig | undefined | null): ChargeRange {
  return cfg?.chargeRange === 'global' ? 'global' : 'cutoff';
}

/** True when the engine runs the GLOBAL (Barnes–Hut) charge law. Requires the
 *  Charge capability itself — the range is a property OF charge, not a substitute
 *  for it, so a charge-off model can never resolve to global. */
export function usesGlobalCharge(cfg: CenterBasedConfig | undefined | null): boolean {
  return usesCharge(cfg) && chargeRangeOf(cfg) === 'global';
}

/** The Barnes–Hut opening angle θ. A node is accepted as one centre-of-mass body
 *  when `extent² < θ²·d²`; smaller ⇒ more exact + slower. Absent ⇒ 0.9 (znah's
 *  reference value). CLAMPED rather than validated: θ is part of the declared force
 *  law that a `.gcaproj` records, so a hand-edited or out-of-range value must
 *  resolve to something runnable, never throw. The upper bound also keeps the
 *  traversal sane — at very large θ the tree is barely opened and the "law" stops
 *  resembling the pair sum at all. */
export const DEFAULT_CHARGE_THETA = 0.9;
export const MIN_CHARGE_THETA = 0.1;
export const MAX_CHARGE_THETA = 1.5;
export function chargeThetaOf(cfg: CenterBasedConfig | undefined | null): number {
  const v = cfg?.chargeTheta;
  const t = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_CHARGE_THETA;
  return Math.min(MAX_CHARGE_THETA, Math.max(MIN_CHARGE_THETA, t));
}

/** THE TRAP, in one place: how far the spatial-hash bin edge must reach for the
 *  charge force to be complete. The neighbour pass walks a 3×3(×3) stencil, so it
 *  only ever sees pairs closer than ONE bin edge — if the edge does not cover
 *  `chargeMaxDist`, every pair beyond it is invisible and the force is **silently
 *  truncated**: the model looks plausible and the physics is wrong, with no error
 *  anywhere. So every site that computes a bin edge for the force hash joins this
 *  into its `max(...)`. Returns 0 when charge is off ⇒ the `max` is unchanged ⇒ the
 *  hash geometry, and therefore every downstream result, is byte-identical.
 *
 *  Safe for the hash RESERVE by construction: the reserve
 *  (`computeAgentMaxHashBins`) is computed from the SMALLEST possible edge, and a
 *  LARGER edge only ever yields FEWER bins — so widening can never overflow it.
 *  (The reserve itself must NOT be widened: it is baked into the agent memory
 *  layout, so changing it would shift every offset past the hash region.) */
export function chargeBinEdgeOf(cfg: CenterBasedConfig | undefined | null): number {
  // C10: GLOBAL charge does not ride the stencil at all (the octree carries it),
  // so it must NOT widen the edge — the widening exists solely to make the pair
  // term complete, and in 3D the candidate count grows with the CUBE of the edge.
  return usesCharge(cfg) && !usesGlobalCharge(cfg) ? chargeMaxDistOf(cfg) : 0;
}

/** The charge constants the force integrator actually consumes, PRECOMPUTED once
 *  per step — the SINGLE source shared by the JS force loop, the WASM force-pass
 *  arg list, and both WebGPU dispatch sites (per-gen + resident). Precomputing
 *  `maxD2` and `minC` here (rather than in each integrator) is the same discipline
 *  as `dtOverEta`: all four surfaces then fold bit-identical constants instead of
 *  each re-deriving them, which is what makes JS↔WASM bit-parity hold. Charge off
 *  ⇒ every field 0 ⇒ each surface's `doCharge` branch is never taken. */
export interface ChargeParams {
  /** Run the CUTOFF pair term inside the neighbour stencil. Deliberately keeps its
   *  exact pre-C10 meaning, so every existing consumer is unchanged: it is FALSE
   *  under global charge (whose term lives in the tree traversal instead), which is
   *  what stops the force being counted twice. */
  doCharge: boolean;
  chargeK: number;
  /** The squared cutoff BOTH laws read. Cutoff law ⇒ `chargeMaxDistOf²`. GLOBAL ⇒
   *  `chargeGlobalMaxDistOf²`, i.e. `Infinity` unless the model set one. Charge off
   *  ⇒ 0 (inert, as before). */
  chargeMaxD2: number;
  /** `1/(1+maxD2)` — the term that takes the coefficient continuously to zero at the
   *  cutoff. 0 under an un-cut GLOBAL law (`1/(1+Infinity)`), which is what makes the
   *  culled arithmetic collapse to the un-culled arithmetic bit-exactly. */
  chargeMinC: number;
  /** C10 — run the GLOBAL Barnes–Hut traversal instead of the pair term. */
  doChargeTree: boolean;
  /** C10 — θ², precomputed here (the `dtOverEta` discipline) so all four force
   *  surfaces fold the identical constant and JS↔WASM bit-parity holds. */
  chargeTheta2: number;
}
export function chargeParamsOf(cfg: CenterBasedConfig | undefined | null): ChargeParams {
  const on = usesCharge(cfg);
  const global = usesGlobalCharge(cfg);
  // The pair term runs for CUTOFF charge only.
  const doCharge = on && !global;
  // The cutoff law DERIVES a default (8 × rest); the global law does not (absent ⇒
  // Infinity ⇒ every pair, exactly the law C10 shipped). Charge off ⇒ 0, inert.
  const maxD = global ? chargeGlobalMaxDistOf(cfg) : doCharge ? chargeMaxDistOf(cfg) : 0;
  const chargeMaxD2 = maxD * maxD;
  const theta = chargeThetaOf(cfg);
  return {
    doCharge,
    // `chargeK` is read by BOTH laws, so it follows the capability, not the range.
    chargeK: on ? chargeStrengthOf(cfg) : 0,
    chargeMaxD2, chargeMinC: 1 / (1 + chargeMaxD2),
    doChargeTree: global,
    chargeTheta2: global ? theta * theta : 0,
  };
}

// ---------------------------------------------------------------------------
// L3 — LAYOUT ITERATIONS. How many times the force integrator runs per
// generation. An ENGINE knob (numerical relaxation), never a graph node.
// ---------------------------------------------------------------------------

/** Hard ceiling on `layoutIterations` — the force pass is the most expensive
 *  phase of a generation, so a mistyped 1000 must not hang the worker. 32 is far
 *  past the useful range (the reference runs 2). */
export const MAX_LAYOUT_ITERATIONS = 32;

/** Force-pass iterations per generation. Absent / ≤ 1 ⇒ **1**, i.e. exactly
 *  today's engine, byte-for-byte — there is no legacy fallback to get wrong.
 *  Clamped to `[1, MAX_LAYOUT_ITERATIONS]` and floored, so every consumer (the JS
 *  loop, the WASM dispatch, both GPU paths) resolves the SAME integer from the
 *  SAME place and they cannot disagree about how many iterations a generation is. */
export function layoutIterationsOf(cfg: CenterBasedConfig | undefined | null): number {
  const v = cfg?.layoutIterations;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(MAX_LAYOUT_ITERATIONS, Math.floor(v)));
}

/** Resolve whether the engine runs its bond SPRINGS this model. Profile-aware:
 *  the Bonds capability drives it (`physics` = springs on, `data`/`off` = no
 *  springs — Data bonds are connectivity edges only), INDEPENDENTLY of the
 *  bonding-physics bundle. So the Bonds dropdown's Data-vs-Physics choice is a
 *  REAL behavioural distinction, not just a palette relabel. Legacy files without
 *  a profile fall back to `usesBondingPhysics` (byte-identical); the migration
 *  inference widens `bonds→physics` whenever the legacy bundle ran springs, so
 *  migrated files reproduce their old spring behaviour exactly. */
export function usesEngineSprings(cfg: CenterBasedConfig | undefined | null): boolean {
  if (cfg?.agentCapabilities) return cfg.agentCapabilities.bonds === 'physics';
  return usesBondingPhysics(cfg);
}

/** Resolve whether the engine runs its growth RAMP (radius → targetRadius) this
 *  model. Profile-aware: the Growth capability drives it, INDEPENDENTLY of the
 *  bonding-physics bundle — so ticking Growth + placing Set Target Radius actually
 *  ramps (previously the ramp was gated on `usesBondingPhysics`, so the node was a
 *  silent no-op without it). Legacy files without a profile fall back to
 *  `usesBondingPhysics` (byte-identical); the migration inference sets `growth`
 *  whenever the legacy bundle ramped (usesBondingPhysics ∧ growthRate>0).
 *  NON-byte-identical edge case (intended, matches NO shipped model): a legacy
 *  file with the engine OFF (`customForcesOnly`/`!useBondingPhysics`) BUT a
 *  positive `growthRate` AND a Set Target Radius node used to FREEZE the ramp
 *  (the node was a silent no-op); the inference now reads `growth=true` from the
 *  node, so it ramps — i.e. the previously-dead node starts working (the fix). */
export function usesEngineGrowth(cfg: CenterBasedConfig | undefined | null): boolean {
  if (cfg?.agentCapabilities) return !!cfg.agentCapabilities.growth;
  return usesBondingPhysics(cfg);
}

/** Resolve a numeric config field to its value or the engine default. */
export function cbNum(cfg: CenterBasedConfig | undefined | null, key: CenterBasedNumericKey): number {
  const v = cfg ? (cfg as unknown as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : CENTER_BASED_DEFAULTS[key];
}

/** Resolve the per-agent bond-slot ceiling — the SINGLE source of truth for the
 *  ragged bond store's stride, shared by the worker (`createAgentStore`), the
 *  baked-offset memory layout (`computeAgentMemoryLayout`), and the WASM agent
 *  compiler so all three agree byte-for-byte. **0 is allowed** (the pure-force /
 *  charged-particle case — agents with no bonds): the bond regions then collapse
 *  to zero bytes. Floors at 0, NOT 1, so a model that wants no bonds allocates
 *  no bond store. (The WebGPU agent layout already floors at 0 independently.) */
export function resolveMaxBonds(cfg: CenterBasedConfig | undefined | null): number {
  // Agent Capability Profiles (STEP 3): the Bonds capability is AUTHORITATIVE for
  // the ragged bond store. `bonds === 'off'` drops it to zero bytes regardless of
  // the config's `maxBonds` ceiling — the memory gate, riding the already-tested
  // maxBonds=0 code path (pure-force models). The profile is inferred + seeded on
  // load (`migrateAgentCapabilities`), so every model has a consistent value; a
  // config without a profile (mid-migration / hand-edited) keeps its full ceiling
  // (a safe superset — the bond store is allocated but unused). Because the bond
  // arrays are RAGGED (`maxAgents·maxBonds`), the compiled per-agent code loops
  // `b < bondCount[idx]` (= 0 when no bonds form) and never indexes the 0-length
  // store, so this is byte-identical output for any model that forms no bonds.
  //
  // SAFETY NET (self-review): the store is dropped to 0 only when NO bonds are
  // intended — the profile's Bonds is off AND the engine's auto-bond won't form
  // any (`useBondingPhysics` + `autoBond`). Without the auto-bond clause a user who
  // turns on the legacy "Use bonding physics" + "Auto-bond" checkboxes while the
  // (separately-edited) profile still reads `bonds: 'off'` would get 0 → auto-bond
  // SILENTLY never fires. A collision-only physics model (soft-sphere, no auto-bond,
  // no bond nodes) still gets the memory win (bonds off + autoBond false).
  const bondsIntended = cfg?.agentCapabilities?.bonds !== 'off'
    || (usesBondingPhysics(cfg) && !!cfg?.autoBond);
  if (!bondsIntended) return 0;
  return Math.max(0, Math.floor(cbNum(cfg, 'maxBonds')));
}

/** GRA P4 — the per-agent structural-request QUEUE depth `D`: how many bond
 *  form / break / rewire ops one agent may issue in a single generation. The
 *  SINGLE source of truth shared by the store (`createAgentStore`), the baked
 *  memory layout (`computeAgentMemoryLayout`), the WebGPU agent layout, and all
 *  three emitters — so the stride they bake and the arrays they index can never
 *  disagree (the baked-offset lockstep). Clamped to [1, 64]: 1 reproduces the
 *  historical single-slot behaviour, 64 is a sanity ceiling (the queue costs
 *  `(D+1)` cells per agent per lane). */
export const BOND_REQUEST_DEPTH_MAX = 64;
export function resolveBondRequestDepth(cfg: CenterBasedConfig | undefined | null): number {
  const v = Math.floor(cbNum(cfg, 'bondRequestDepth'));
  if (!Number.isFinite(v)) return CENTER_BASED_DEFAULTS.bondRequestDepth;
  return Math.min(BOND_REQUEST_DEPTH_MAX, Math.max(1, v));
}

// ---------------------------------------------------------------------------
// C1 (P4 — "no silent resolution") — the EFFECTIVE force-integration timestep.
// ---------------------------------------------------------------------------

/** The clamped force-integration timestep, plus everything needed to EXPLAIN the
 *  clamp. The Mathias-2020 monotonicity bound for a linear spring `F = μ(d−s)` is
 *  `Δt*_mono = 1/(2·μ_eff)`, so `Δt ← min(Δt_user, 0.4·Δt*_mono) = 0.2/μ_eff`
 *  with `μ_eff = μ_R + λ_max` (see CENTER_BASED_DEFAULTS' header).
 *
 *  Extracted from the worker's `clampAgentDt` (which now calls this) so the
 *  Properties readout and the engine resolve the SAME number from the SAME
 *  place — the `resolveMaxBonds` single-source discipline. The arithmetic is
 *  verbatim (same operands, same order), so the engine is byte-identical.
 *
 *  `clamped` is true only when the bound actually REDUCES the user's value, so
 *  a model sitting exactly on the bound reads as unclamped (nothing to explain). */
export interface EffectiveAgentDt {
  /** `timeStep` as the user wrote it (or the engine default). */
  requested: number;
  /** What the integrator actually uses. */
  dt: number;
  /** μ_eff = repulsion μ_R + bond λ (floored at 1e-6 so the bound is finite). */
  muEff: number;
  /** The stability bound 0.2 / μ_eff. */
  bound: number;
  /** True iff the bound reduced `requested`. */
  clamped: boolean;
}
export function effectiveAgentDt(cfg: CenterBasedConfig | undefined | null): EffectiveAgentDt {
  const muR = cbNum(cfg, 'repulsionStiffness');
  const lambda = cbNum(cfg, 'bondStiffness');
  const muEff = Math.max(1e-6, muR + lambda);
  const requested = cbNum(cfg, 'timeStep');
  const bound = 0.2 / muEff;
  const dt = Math.min(requested, bound);
  return { requested, dt, muEff, bound, clamped: dt < requested };
}

/** Resolve the agent-engine compile target, CLAMPED to what's actually
 *  implemented. The agent loop (`compileAgentGraph`) emits JS by default; WASM
 *  (PR6) and WebGPU (PR7) run only the supported node subsets. This is the C-D4
 *  file-load safety net (mirrors the grid's worker-side useWasm/useWebGPU
 *  demotion): a hand-edited `agentTarget:'wasm'`/`'webgpu'` config can never
 *  dispatch to a compiler the model's graph doesn't support — it falls back to a
 *  safe target. INDEPENDENT of the grid target — the grid can be WASM while
 *  agents resolve to WebGPU, or vice versa. */
export function agentTargetOf(
  cfg: CenterBasedConfig | undefined | null,
  /** PR6b-1: the result of `isAgentGraphWasmSupported(model)`. When the user
   *  selected `'wasm'`, the target resolves to `'wasm'` ONLY if the agent graph
   *  uses the WASM-supported node subset; otherwise it clamps to `'js'`. Default
   *  `false` (e.g. callers that have no model handy / pre-PR6b call sites) keeps
   *  the original always-clamp behaviour. */
  wasmSupported = false,
  /** PR7: the result of `isAgentGraphWebGPUSupported(model)`. When the user
   *  selected `'webgpu'`, the target resolves to `'webgpu'` ONLY if the agent
   *  graph uses the WebGPU-supported (Boids) node subset; otherwise it clamps to
   *  `'js'` (NOT 'wasm' — keep the fallback simple + always-runnable). Default
   *  `false` so pre-PR7 callers keep clamping a `'webgpu'` config to JS. */
  webgpuSupported = false,
): 'js' | 'wasm' | 'webgpu' {
  const t = cfg?.agentTarget;
  if (t === 'auto') {
    // C4 (P1) — the file-load SAFETY NET for an 'auto' config that reaches the
    // engine un-baked. The model-level Auto policy (including the Overseer
    // preference, which needs the whole model) lives in `resolveEngines`, and
    // `withResolvedEngine` bakes a concrete target before any compile path calls
    // this — so this arm is a fallback, not the policy.
    if (webgpuSupported) return 'webgpu';
    if (wasmSupported) return 'wasm';
    return 'js';
  }
  if (t === 'js') return 'js';
  if (t === 'wasm') {
    // PR6b: the WASM agent loop exists for the supported node subset. Run on
    // WASM only when the whole agent graph is supported; otherwise the clamp
    // keeps JS safe.
    if (wasmSupported) return 'wasm';
    // eslint-disable-next-line no-console
    console.warn(`[agents] agentTarget='wasm' but the agent graph uses nodes not yet ported to the WASM agent loop — clamping to 'js'.`);
    return 'js';
  }
  if (t === 'webgpu') {
    // PR7: the WebGPU agent loop (behaviour + force shaders) exists for the Boids
    // node subset. Run on WebGPU only when the whole agent graph is supported;
    // otherwise clamp to JS (the always-runnable fallback).
    if (webgpuSupported) return 'webgpu';
    // eslint-disable-next-line no-console
    console.warn(`[agents] agentTarget='webgpu' but the agent graph uses nodes not yet ported to the WebGPU agent loop (or is 3D) — clamping to 'js'.`);
    return 'js';
  }
  return 'js';
}
