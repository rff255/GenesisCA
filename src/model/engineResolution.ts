// ===========================================================================
// C4 (P1) — ENGINE RESOLUTION. The single source of "which engine runs this
// model", per layer (CA grid / agents).
//
// The user declares an INTENT (`'auto'`) or an ENGINE (`'wasm'` / `'webgpu'` /
// `'js'`). This module turns that into three values everything else reads:
//
//   selected   what the user picked (may be 'auto')
//   requested  the engine that selection ASKS for (for 'auto', its pick)
//   resolved   what will ACTUALLY run, after the real gates demote
//
// THE DESIGN RULE (inherited from C1): every verdict comes from the function
// that ENFORCES it — `detectWebGPUModelIncompatibilities`,
// `detectWebGPUIncompatibilities`, `isAgentGraphWasmSupported`,
// `isAgentGraphWebGPUSupported`, `agentTargetOf`. Nothing here re-derives a gate,
// so the displayed resolution cannot drift from the engine's own decision.
//
// AUTO POLICY (C5, P10) — *the fastest engine that satisfies the model's
// DECLARED REPRODUCIBILITY CONTRACT* (`reproducibilityOf`):
//
//   grid    WebGPU when every grid gate passes, else WASM.
//           CONTRACT-INDEPENDENT: the GPU grid seeds a per-CELL PCG and
//           `setRngSeed` re-derives those streams, so a fixed seed reproduces a
//           run on this device — it HONOURS Exact. (f32 means the numbers are
//           engine- and device-specific; the reason string says so.)
//   agents  exact       ⇒ WASM if its gate passes, else JS.
//           statistical ⇒ WebGPU if its gate passes, else WASM, else JS.
//           The GPU agent engine seeds its per-agent PCG ONCE at runtime
//           creation and `setRngSeed` never reaches it, so it cannot honour
//           Exact. See [reproducibility.ts](reproducibility.ts) for the measured
//           asymmetry between the two GPU layers.
//
// C4's hard-coded `if (overseerConfig.enabled) pick = 'wasm'` special case is
// GONE: under Exact the agents already land on CPU, which is the requirement it
// was standing in for, and the grid Overseer sample ships on WebGPU precisely
// because a grid sweep does reproduce there.
//
// `resolveEngines` is MEMOISED on the model object (WeakMap). The reducer creates
// a new model object per edit, so this evaluates once per model version and is
// shared by every caller — including the per-node CaNode badge, which would
// otherwise make it O(N²).
// ===========================================================================

import type { CAModel, CenterBasedConfig, EngineChoice, EngineId, GraphNode, ReproducibilityContract } from './types';
import type { NodeConfig } from '../modeler/vpl/types';
import { agentTargetOf } from './centerBased';
import { engineFromLegacyFlags } from './engineFieldMigration';
import { contractViolationFor, reproducibilityOf } from './reproducibility';
import {
  detectWebGPUIncompatibilities, detectWebGPUModelIncompatibilities,
} from '../modeler/vpl/nodes/nodeValidation';
import { isAgentGraphWasmSupported } from '../modeler/vpl/compiler/agentWasm/compile';
import { isAgentGraphWebGPUSupported } from '../modeler/vpl/compiler/agentWebgpu/compile';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface LayerResolution {
  /** What the user selected — may be `'auto'`. */
  selected: EngineChoice;
  /** The engine that selection asks for. For `'auto'`, the engine Auto picked. */
  requested: EngineId;
  /** What will actually run, after the gates demote a rejected explicit choice.
   *  For `'auto'` this always equals `requested` (Auto never picks a failing
   *  engine — that is the point of Auto). */
  resolved: EngineId;
  /** A sentence for the UI. Always set under `'auto'` (why THIS engine); set on
   *  an explicit choice only when the gates demote it. */
  reason: string;
  /** Convenience: `selected === 'auto'`. */
  auto: boolean;
  /** C5 (P10) — set when the RESOLVED engine cannot honour the model's declared
   *  reproducibility contract. Never blocks anything (the engine runs); it is an
   *  amber note. Always absent under `'auto'`, which consults the contract. */
  contractViolation?: string;
}

export interface EngineResolution {
  grid: LayerResolution;
  /** Present only when the Agents topology is on. */
  agents?: LayerResolution;
  /** C5 (P10) — the contract this resolution was computed against. */
  contract: ReproducibilityContract;
}

export const ENGINE_CHOICE_LABEL: Record<EngineChoice, string> = {
  auto: 'Auto',
  js: 'Debug / Reference (JS)',
  wasm: 'WebAssembly',
  webgpu: 'WebGPU',
};

/** The legacy mirror flags for an engine. The ONE place the enum is turned back
 *  into `useWasm` / `useWebGPU` (see `withResolvedEngine`). */
export function engineFlags(e: EngineId): { useWasm: boolean; useWebGPU: boolean } {
  return { useWasm: e === 'wasm', useWebGPU: e === 'webgpu' };
}

/** The grid engine the model SELECTS. Absent `engine` falls back to the legacy
 *  flags, so this is correct even for a model that never went through
 *  `migrateEngineField` (a hand-built model in a script / harness). */
export function selectedGridEngine(model: CAModel): EngineChoice {
  const e = model.properties.engine;
  if (e === 'auto' || e === 'js' || e === 'wasm' || e === 'webgpu') return e;
  return engineFromLegacyFlags(model.properties);
}

/** The agent engine the model SELECTS. Absent ⇒ `'js'` (the historical default —
 *  migration deliberately does not flip existing files to `'auto'`). */
export function selectedAgentEngine(cfg: CenterBasedConfig | undefined | null): EngineChoice {
  const t = cfg?.agentTarget;
  if (t === 'auto' || t === 'js' || t === 'wasm' || t === 'webgpu') return t;
  return 'js';
}

// ---------------------------------------------------------------------------
// The grid gates
// ---------------------------------------------------------------------------

/** Macro-aware node walk (the compilers flatten macros up front, so a node
 *  inside a macro instance is every bit as real as a top-level one). Mirrors
 *  `targetDiagnosis.walkNodes`. */
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

/** Everything blocking the WebGPU GRID engine for this model, straight from the
 *  real gates. A gate that early-outs unless WebGPU is selected is asked
 *  HYPOTHETICALLY via a shallow probe clone — the honest way to answer "could
 *  this model use WebGPU?" without duplicating its logic.
 *
 *  Exported so C1's `diagnoseTargets` builds its class-tagged reasons from the
 *  SAME collection this resolution decides on: verdict and explanation cannot
 *  disagree. */
export function gridWebgpuBlockers(model: CAModel): { modelIssue: string | null; nodeIssues: string[] } {
  const probe: CAModel = { ...model, properties: { ...model.properties, useWebGPU: true } };
  const nodeIssues: string[] = [];
  walkNodes(model.graphNodes, model, (t, cfg) => {
    for (const msg of detectWebGPUIncompatibilities(t, cfg, probe)) nodeIssues.push(msg);
  });
  return { modelIssue: detectWebGPUModelIncompatibilities(probe), nodeIssues };
}

/** True when the WebGPU grid engine can run this model at all. */
export function gridWebgpuOk(model: CAModel): boolean {
  const b = gridWebgpuBlockers(model);
  return !b.modelIssue && b.nodeIssues.length === 0;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const AUTO_GRID_GPU = 'Every WebGPU gate passes, so Auto runs the grid on the GPU.';
// C5 — the asymmetry, stated where the user meets it: Exact still allows the GPU
// GRID, because the grid's RNG is seeded per cell and `setRngSeed` reaches it.
const AUTO_GRID_GPU_EXACT = ' Exact still allows the GPU here: the grid seeds a per-cell RNG that Set Random Seed re-derives, so a fixed seed reproduces a run on this device (the f32 numbers are engine- and device-specific — do not compare them against a CPU run).';
const AUTO_GRID_SPARSE = ' Note: Skip Isolated Empty Cells is ignored on WebGPU — the GPU runs the whole grid every generation.';
const AUTO_AGENTS_GPU = 'This model declares Statistical and the GPU can run this agent graph, so Auto picks WebGPU.';
const AUTO_AGENTS_EXACT = 'This model declares Exact, so Auto keeps agents on WebAssembly — exact, seedable and bit-identical to the JS reference. (The WebGPU agent engine seeds its per-agent RNG once at start-up and Set Random Seed never reaches it.)';
const AUTO_AGENTS_EXACT_JS = 'This model declares Exact, so Auto keeps agents off the GPU — and the WASM agent engine cannot run this graph, so it falls back to the JS reference engine.';
const AUTO_AGENTS_WASM = 'The GPU cannot run this agent graph, so Auto picks WebAssembly — exact, seedable and bit-identical to the JS reference.';
const AUTO_AGENTS_JS = 'Neither compiled agent engine can run this graph, so Auto falls back to the JS reference engine.';

function resolveGridLayer(model: CAModel): LayerResolution {
  const selected = selectedGridEngine(model);

  if (selected === 'auto') {
    // The GRID policy is contract-INDEPENDENT (see the module header): the GPU
    // grid honours Exact. The contract only changes what the reason SAYS.
    if (gridWebgpuOk(model)) {
      const sparse = model.properties.skipIsolatedEmpty?.enabled ? AUTO_GRID_SPARSE : '';
      const contract = reproducibilityOf(model) === 'exact' ? AUTO_GRID_GPU_EXACT : '';
      return { selected, requested: 'webgpu', resolved: 'webgpu', reason: AUTO_GRID_GPU + contract + sparse, auto: true };
    }
    const b = gridWebgpuBlockers(model);
    const why = b.modelIssue ?? b.nodeIssues[0] ?? 'a WebGPU gate rejects this model';
    return {
      selected, requested: 'wasm', resolved: 'wasm', auto: true,
      reason: `Auto picked WebAssembly — ${why}`,
    };
  }

  // An EXPLICIT choice is never silently replaced. It compiles, and if a gate
  // rejects it the worker falls back to JS loudly (the compile error + C3's
  // fallback event + the amber chip) — that is the documented grid demotion.
  const requested = selected;
  if (requested === 'webgpu' && !gridWebgpuOk(model)) {
    const b = gridWebgpuBlockers(model);
    return {
      selected, requested, resolved: 'js', auto: false,
      reason: b.modelIssue ?? b.nodeIssues[0] ?? 'a WebGPU gate rejects this model',
    };
  }
  return { selected, requested, resolved: requested, reason: '', auto: false };
}

function resolveAgentLayer(model: CAModel): LayerResolution {
  const cfg = model.centerBased;
  const selected = selectedAgentEngine(cfg);
  const wasmOk = isAgentGraphWasmSupported(model);
  const webgpuOk = isAgentGraphWebGPUSupported(model);

  if (selected === 'auto') {
    // C5 — the DECLARED CONTRACT decides whether the GPU is a candidate at all.
    // Exact cannot be honoured by the WebGPU agent engine (per-agent RNG seeded
    // once, `setRngSeed` never reaches it), so Auto never offers it there.
    const exact = reproducibilityOf(model) === 'exact';
    let pick: EngineId;
    let reason: string;
    if (exact) {
      pick = wasmOk ? 'wasm' : 'js';
      reason = wasmOk ? AUTO_AGENTS_EXACT : AUTO_AGENTS_EXACT_JS;
    } else if (webgpuOk) {
      pick = 'webgpu'; reason = AUTO_AGENTS_GPU;
    } else if (wasmOk) {
      pick = 'wasm'; reason = AUTO_AGENTS_WASM;
    } else {
      pick = 'js'; reason = AUTO_AGENTS_JS;
    }
    return { selected, requested: pick, resolved: pick, reason, auto: true };
  }

  const requested = selected;
  // The REAL clamp, from the engine's own safety net — asked with the model's
  // own config, whose `agentTarget` IS `selected` here (that is where `selected`
  // came from), so this is the same answer the compile path gets.
  const resolved = agentTargetOf(cfg, wasmOk, webgpuOk);
  const reason = resolved === requested ? '' : (requested === 'webgpu'
    ? 'This agent graph uses a node or op the WebGPU agent shader cannot express, so the engine falls back to JS.'
    : 'This agent graph exceeds a WASM agent capacity budget, so the engine falls back to JS.');
  return { selected, requested, resolved, reason, auto: false };
}

const cache = new WeakMap<CAModel, EngineResolution>();

/** Which engine each layer will run. Pure + memoised on the model object. */
export function resolveEngines(model: CAModel): EngineResolution {
  const hit = cache.get(model);
  if (hit) return hit;
  const contract = reproducibilityOf(model);
  const out: EngineResolution = { grid: resolveGridLayer(model), contract };
  if (model.topologyMode?.agents) out.agents = resolveAgentLayer(model);
  // C5 — flag a RESOLVED engine that cannot honour the declared contract. The
  // predicate is told what resolved rather than resolving anything itself, so
  // there is exactly one resolution in the system. Auto consults the contract,
  // so this can only ever fire on an explicit choice.
  for (const [layer, r] of [['grid', out.grid], ['agents', out.agents]] as const) {
    if (!r) continue;
    const v = contractViolationFor(layer, r.resolved, contract);
    if (v) r.contractViolation = v;
  }
  cache.set(model, out);
  return out;
}

/** Bake the resolution into the LEGACY MIRROR (`useWasm` / `useWebGPU`) and into
 *  a concrete `centerBased.agentTarget`, so every downstream consumer — the
 *  compilers, the worker init message, the layout builders — keeps reading the
 *  representation it always read.
 *
 *  It bakes the **requested** engine, not the resolved one: for an EXPLICIT
 *  choice the requested target must still be COMPILED, because that compile's
 *  error is what produces the user-visible message and C3's fallback event. Auto
 *  never picks a failing engine, so for `'auto'` requested ≡ resolved.
 *
 *  Returns the SAME object reference when nothing changes, so memoisation and
 *  effect dependency arrays are untouched for every existing model. */
export function withResolvedEngine(model: CAModel): CAModel {
  const r = resolveEngines(model);
  const flags = engineFlags(r.grid.requested);
  const gridStale = !!model.properties.useWasm !== flags.useWasm
    || !!model.properties.useWebGPU !== flags.useWebGPU;
  // ONLY an 'auto' selection needs baking on the agent side: an explicit choice
  // IS `centerBased.agentTarget` already, and an ABSENT one already means 'js'
  // (writing 'js' back would add a field to every legacy file for no reason).
  const agentStale = !!r.agents && r.agents.auto && !!model.centerBased
    && model.centerBased.agentTarget !== r.agents.requested;
  if (!gridStale && !agentStale) return model;
  const out: CAModel = { ...model };
  if (gridStale) out.properties = { ...model.properties, ...flags };
  if (agentStale && model.centerBased) {
    out.centerBased = { ...model.centerBased, agentTarget: r.agents!.requested };
  }
  return out;
}
