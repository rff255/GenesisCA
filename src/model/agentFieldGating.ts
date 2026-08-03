// ===========================================================================
// C9 / Agent Capability Profiles STEP 4 + STEP 6 — the SINGLE source of truth for
//   (a) WHICH optional per-agent SoA fields this model allocates, and
//   (b) WHETHER the engine integrator moves anything at all.
//
// THE LOCKSTEP (why this file exists at all): the field gates decide BYTE
// OFFSETS. A mirror that disagrees does not crash — it reads a NEIGHBOURING
// field's bytes (the documented "+64-cell corruption" class). Five sites need
// the same answer:
//
//   1. computeAgentMemoryLayout   (WASM baked offsets)      ← AgentLayoutExtras.fieldGates
//   2. createAgentStore           (the views over them)     ← opts.fieldGates
//   3. computeAgentWebGPULayout   (f32Base)                 ← AgentWebGPUExtras.fieldGates
//   4. deriveAgentAbi             (the JS param list)       ← AgentAbiShape.gates
//   5. the parity harness buildArgs                         ← the same descriptor
//
// All five derive from `resolveAgentFieldGates(model)` HERE, and the resolved
// object is SHIPPED to the worker on the init/recompile message (the
// `agentBondReqSlots` precedent) rather than recomputed there — so a main-thread
// vs worker disagreement is structurally impossible, not merely unlikely.
//
// THE SAFETY CATCH: a dropped field is a ZERO-LENGTH typed array, never
// `undefined`. On a zero-length TypedArray `a[i] = v` is a SILENT NO-OP, so every
// engine WRITE needs no guard; only READS need care (`a[i]` is `undefined`).
// The three agent compilers therefore emit the typed default (0) for a read of a
// dropped field and skip its writes — see `agentWasm/compile.ts` (`ctx.layout.f64[f]
// === undefined`), `agentWebgpu/compile.ts` (`layout.f32Base[f] === undefined`)
// and the `ctx.agentGates` checks in the JS node emitters.
//
// THE GATES ARE USAGE-WIDENED, never capability-only: `hiddenPorts` + the palette
// gate are cosmetic (the amber badge is informational, non-blocking), so a placed
// `Get Age` keeps compiling with Lifespan off. Gating on the capability alone
// would drop a field a live node reads. Every predicate below is
// `capability OR usage`, and the usage half uses the SAME macro-aware scan the
// existing `agentUsesDensity` / `agentUsesField` flags use.
// ===========================================================================

import type { CAModel, CenterBasedConfig, GraphNode, GraphEdge, MotionMode } from './types';
import { resolveAgentProfile } from './agentCapabilities';
import { usesEngineGrowth, usesSoftCollision, usesBondingPhysics, usesCharge } from './centerBased';

/** Which OPTIONAL per-agent SoA field groups this model allocates. `true` = the
 *  field exists (today's behaviour); `false` = it is a zero-length array and its
 *  compiled reads emit the typed default. */
export interface AgentFieldGates {
  /** `spriteIds` / `spriteFrames` / `spriteSpeeds` / `spriteRotations` /
   *  `spriteScales` — 36 B/agent, and the ONLY group that lives purely in plain
   *  JS arrays (no WASM offset, no GPU run), so gating it moves no baked byte. */
  sprites: boolean;
  /** `age` — 8 B. Written by the force pass on all three targets. */
  age: boolean;
  /** `targetRadius` — 8 B. Read+written by the force-pass growth ramp. */
  targetRadius: boolean;
  /** `density` — 8 B. Written by the force-pass neighbour scan, which is itself
   *  already gated on exactly this predicate (see `resolveAgentFieldGates`). */
  density: boolean;
}

/** Everything allocated — today's layout, and the value every non-agent /
 *  pre-C9 call site uses so it stays byte-identical. */
export const ALL_FIELD_GATES_ON: AgentFieldGates = Object.freeze({
  sprites: true, age: true, targetRadius: true, density: true,
});

/** Normalise a possibly-partial gate record (a hand-edited file, an older worker
 *  message) to a full one, defaulting ABSENT keys to `true` — the safe direction:
 *  an unknown gate allocates rather than drops. */
export function normalizeFieldGates(g?: Partial<AgentFieldGates> | null): AgentFieldGates {
  if (!g) return ALL_FIELD_GATES_ON;
  return {
    sprites: g.sprites !== false,
    age: g.age !== false,
    targetRadius: g.targetRadius !== false,
    density: g.density !== false,
  };
}

// ---------------------------------------------------------------------------
// Macro-aware agent-graph scan (the `agentUsesDensity` shape). The agent
// compilers flatten macros up front, so a capability-implying node inside a macro
// is just as live as a top-level one — missing it would drop a field the compiled
// code reads.
// ---------------------------------------------------------------------------

interface GraphScan { types: Set<string>; sourceHandles: Set<string> }

function scanAgentGraph(model: CAModel): GraphScan {
  const types = new Set<string>();
  const sourceHandles = new Set<string>();
  const seen = new Set<string>();
  const macroDefs = model.macroDefs ?? [];
  const walk = (nodes?: GraphNode[], edges?: GraphEdge[]): void => {
    for (const e of edges ?? []) if (e.sourceHandle) sourceHandles.add(e.sourceHandle);
    for (const n of nodes ?? []) {
      const t = n.data?.nodeType as string | undefined;
      if (!t) continue;
      types.add(t);
      if (t === 'macro') {
        const defId = (n.data?.config as Record<string, unknown> | undefined)?.macroDefId as string | undefined;
        if (defId && !seen.has(defId)) {
          seen.add(defId);
          const def = macroDefs.find(d => d.id === defId);
          if (def) walk(def.nodes as GraphNode[], def.edges as GraphEdge[]);
        }
      }
    }
  };
  walk(model.agentGraphNodes, model.agentGraphEdges);
  return { types, sourceHandles };
}

/** Is any edge sourced from a port whose id ENDS with `suffix`? Handle ids are
 *  `output_<category>_<portId>`, so a suffix match names the port without
 *  hard-coding the prefix convention. */
function anyPortWired(scan: GraphScan, suffix: string): boolean {
  for (const h of scan.sourceHandles) if (h.endsWith(suffix)) return true;
  return false;
}

/** THE resolver. Capability OR usage, per group. A NON-agent model resolves to
 *  all-on (nothing allocates an agent store anyway) so no caller has to special-case it. */
export function resolveAgentFieldGates(model: CAModel): AgentFieldGates {
  if (!model.topologyMode?.agents) return ALL_FIELD_GATES_ON;
  const cfg = model.centerBased;
  const p = resolveAgentProfile(model);
  const scan = scanAgentGraph(model);

  // SPRITES — the model carries sprite assets, or the graph sets one. (The
  // worker's own `hasAgentSprites` is the assets half; the node half is what
  // keeps a graph that sets a sprite before the asset is imported honest.)
  const sprites = (model.sprites?.length ?? 0) > 0 || scan.types.has('setAgentSprite');

  // LIFESPAN — the capability, a Get Age node, or a WIRED `behaviourStep.myAge`.
  const age = !!p.lifespan || scan.types.has('getAge') || anyPortWired(scan, 'myAge');

  // GROWTH — the resolved engine ramp (`usesEngineGrowth`, the same resolver the
  // force pass and the pipeline panel read), the capability, or a node that
  // WRITES the target radius (`setAgentRadius` writes radius AND targetRadius).
  const targetRadius = !!p.growth || usesEngineGrowth(cfg)
    || scan.types.has('setTargetRadius') || scan.types.has('setAgentRadius');

  // DENSITY — deliberately THE NEIGHBOUR-SCAN PREDICATE. The scan is the field's
  // only writer and runs iff `bonding || softCollision || densityConsumer ||
  // charge`; a consumer is `neighbourDensity` (reads it) or `divideAgent` (whose
  // degenerate-axis fallback reads it in the engine). So density off ⇒ the scan
  // never runs ⇒ nothing writes it, on every target.
  const density = scan.types.has('neighbourDensity') || scan.types.has('divideAgent')
    || usesSoftCollision(cfg) || usesBondingPhysics(cfg) || usesCharge(cfg);

  return { sprites, age, targetRadius, density };
}

// ---------------------------------------------------------------------------
// STEP 6 — the MOTION mode, resolved once.
// ---------------------------------------------------------------------------

/** The resolved motion mode. Absent profile ⇒ `'force'` (the historical engine),
 *  which is what keeps every legacy / pre-C9 call site byte-identical. */
export function agentMotionMode(cfg?: CenterBasedConfig | null): MotionMode {
  return cfg?.agentCapabilities?.motion ?? 'force';
}

/** Does the engine move positions at all this model? `'static'` ⇒ NO: the force
 *  pass AND the position commit are both skipped, so `x` is the single live
 *  buffer and a `Set Agent Position` write survives the generation.
 *
 *  THE HAZARD THIS ENCODES (CLAUDE.md, Ant Necrophoresis): skipping the force
 *  pass while KEEPING `swapPositions` reverts every graph position write, because
 *  the commit copies the stale `xNext` over `x`. The two must be skipped together
 *  — which is why this is one predicate consulted by both sites. */
export function motionIntegrates(cfg?: CenterBasedConfig | null): boolean {
  return agentMotionMode(cfg) !== 'static';
}

/** Does the engine accumulate FORCES (the neighbour scan, springs, charge, the
 *  `v = momentum·v + (Δt/η)·ΣF` update)? Only under `'force'`. Under `'velocity'`
 *  the integrator still advances `x += v`, so `Set Velocity` produces real motion
 *  and coasts (in force mode a momentum-0 model wipes it the same step). */
export function motionAppliesForces(cfg?: CenterBasedConfig | null): boolean {
  return agentMotionMode(cfg) === 'force';
}

/** The numeric motion mode shipped to the WASM force pass / the WebGPU
 *  ForceControl uniform: 0 = static, 1 = velocity, 2 = force. */
export function motionModeCode(cfg?: CenterBasedConfig | null): number {
  const m = agentMotionMode(cfg);
  return m === 'static' ? 0 : m === 'velocity' ? 1 : 2;
}
