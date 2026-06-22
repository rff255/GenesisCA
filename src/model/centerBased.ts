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

/** A fresh default config (used when the user enables the Agents topology). */
export function defaultCenterBasedConfig(): CenterBasedConfig {
  return {
    enabled: true,
    maxAgents: CENTER_BASED_DEFAULTS.maxAgents,
    maxBonds: CENTER_BASED_DEFAULTS.maxBonds,
    worldWidth: CENTER_BASED_DEFAULTS.worldWidth,
    worldHeight: CENTER_BASED_DEFAULTS.worldHeight,
  };
}

/** Resolve a numeric config field to its value or the engine default. */
export function cbNum(cfg: CenterBasedConfig | undefined | null, key: CenterBasedNumericKey): number {
  const v = cfg ? (cfg as unknown as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : CENTER_BASED_DEFAULTS[key];
}

/** Resolve the agent-engine compile target, CLAMPED to what's actually
 *  implemented. The agent loop (`compileAgentGraph`) emits JS only until Phase F
 *  ports it to WASM (PR6) / WebGPU (PR7), so anything other than `'js'` is a
 *  hard dependency on a compiler that does not exist yet. This is the C-D4
 *  file-load safety net (mirrors the grid's worker-side useWasm/useWebGPU
 *  demotion): a hand-edited `agentTarget:'wasm'`/`'webgpu'` config can never
 *  dispatch to a non-existent `compileAgentGraphWasm`/`compileAgentGraphWebGPU`.
 *  PR6/PR7 widen the allow-set as each port lands. INDEPENDENT of the grid
 *  target — the grid can be WebGPU while agents resolve to JS. */
export function agentTargetOf(cfg: CenterBasedConfig | undefined | null): 'js' | 'wasm' | 'webgpu' {
  const t = cfg?.agentTarget;
  if (t === 'js') return 'js';
  if (t === 'wasm' || t === 'webgpu') {
    // Phase F widens this allow-set as each port lands: PR6 deletes the `'wasm'`
    // clamp arm (returns 'wasm'); PR7 deletes the `'webgpu'` arm. This is the
    // ONLY agentTargetOf edit in the whole milestone, and it lives in PR6/PR7
    // (NOT PR1 — the clamp already exists, PR1 only verifies + documents it).
    // eslint-disable-next-line no-console
    console.warn(`[agents] agentTarget='${t}' not yet implemented (Phase F) — clamping to 'js'.`);
    return 'js';
  }
  return 'js';
}
