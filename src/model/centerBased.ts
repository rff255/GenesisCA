import type { CenterBasedConfig } from './types';

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

/** Resolve whether the engine runs its soft-sphere REPULSION — the volume-exclusion
 *  collision — this model. Profile-aware: the Collision capability drives it
 *  (`soft`/`positional` = on, `off` = off), INDEPENDENTLY of the bonding-physics
 *  bundle. So a pure gas (Collision on, "Use bonding physics" off) gets
 *  non-penetrating collision without cohesion or springs. Adhesion + springs +
 *  growth + auto-bond stay under `usesBondingPhysics`. Legacy files without a
 *  profile fall back to the engine-forces master toggle, so they're byte-identical.
 *  (The shipped agent samples' inferred profile has `collision === 'soft' ⟺
 *  usesBondingPhysics`, so their repulsion is byte-identical too.) */
export function usesEngineCollision(cfg: CenterBasedConfig | undefined | null): boolean {
  if (cfg?.agentCapabilities) return cfg.agentCapabilities.collision !== 'off';
  return usesBondingPhysics(cfg);
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
