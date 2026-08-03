# PLAN — C9: Static motion integrator + profile-gated SoA fields

*(Clarity & Simplification phase C9 = Agent Capability Profiles **STEP 4** + **STEP 6**.
The deferred-XL engine phase. §1 of [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md)
applies; the impact map below is written FIRST per the house rule for engine-layout changes.)*

---

## 0. The two goals in one sentence each

- **STEP 4** — a capability that is OFF, and whose field no node or engine phase reads,
  stops **charging memory** for that field on every agent slot.
- **STEP 6** — `Motion: Static` stops the engine **moving anything**; `Motion: Velocity`
  integrates the velocity the graph sets but seeds no engine forces.

---

## 1. IMPACT MAP (subsystem by subsystem)

### 1.1 The four gate-able field groups — and how differently they behave

| group | fields | bytes/agent | where the bytes live | who reads them |
|---|---|---|---|---|
| **Sprites** | `spriteIds` i32 + `spriteFrames`/`spriteSpeeds`/`spriteRotations`/`spriteScales` f64 | **36** | **plain JS arrays only** — NOT in `AGENT_F64_FIELDS`, NOT in the WASM layout, NOT in `AGENT_GPU_F32_FIELDS` | the JS `setAgentSprite` emit, `advanceAgentSprites`, `initAgentSlot`, `divideAgent`, the render snapshot, (de)serialize |
| **Lifespan** | `age` f64 | 8 | `AGENT_F64_FIELDS` + `AGENT_GPU_F32_FIELDS` | force pass (`age += 1`) on **all three** targets, the L3 age-undo loop, `getAge`, `behaviourStep.myAge`, `getAgentState` |
| **Growth** | `targetRadius` f64 | 8 | both layouts | force-pass growth ramp on all three targets, `setTargetRadius`, `setAgentRadius`, `initAgentSlot`, `divideAgent`, `paintAgents` |
| **Collision** | `density` f64 | 8 | both layouts | the force-pass neighbour scan (already gated by `doScan`), `neighbourDensity`, `divideAgent`'s degenerate-axis fallback, `getAgentState` |

**Total: 60 B/agent** when all four are off — 3 MB at 50 000 agents.

### 1.2 THE SAFETY CATCH — one uniform representation

A dropped field is a **ZERO-LENGTH typed array**, never `undefined`. That single choice
buys most of the safety for free, because on a `TypedArray` of length 0:

- **`arr[i] = v` is a silent no-op** (no throw, no growth) — so every engine *write*
  (`initAgentSlot`, `divideAgent`'s daughter seeding, `paintAgents`) needs **no guard at all**;
- `arr.slice()` / `.set()` / `.fill()` are all valid;
- **`arr[i]` reads `undefined`** — this is the ONLY hazard, and it is what the safety catch
  must cover.

So the catch has exactly three shapes, one per compile target, plus a handful of engine reads:

| surface | dropped-field READ becomes |
|---|---|
| **JS agent compiler** | the node emits the literal `0` instead of `_agentAge[idx]` (the ABI param is gone, so a read would be a `ReferenceError` — the loudest possible failure, but still a failure) |
| **WASM agent compiler** | `ctx.layout.f64['age']` is `undefined` ⇒ emit `f64.const 0` instead of the load, and **skip** the store |
| **WebGPU agent compiler** | `layout.f32Base['age']` is `undefined` ⇒ emit `0.0` instead of `agentF32[…]`, and skip the store |
| **engine (TS)** | `?? 0` at the three genuine read sites (`getAgentState`, `divideAgent`'s density fallback, `divideAgent`'s mother `targetRadius`) |

**The catch is implemented and gate-tested BEFORE any field is dropped** (runbook order).

### 1.3 Usage widening — why the capability alone is not the gate

A capability toggle is the user's *intent*; the graph is the *fact*. `hiddenPorts` and the
palette gate are cosmetic (documented: the amber badge is informational, non-blocking), so a
placed `Get Age` keeps compiling with Lifespan off. Gating on the capability alone would
therefore drop a field a live node reads.

Hence every gate is `capability OR usage`, with usage read from the same macro-aware scan the
existing `agentUsesDensity` / `agentUsesField` flags use, and from the same **engine resolvers**
the pipeline panel and the force pass consult:

```
sprites       = model.sprites.length > 0            OR  graph has setAgentSprite
age           = profile.lifespan                    OR  graph has getAge / a wired behaviourStep.myAge
targetRadius  = usesEngineGrowth(cfg)               OR  graph has setTargetRadius / setAgentRadius
                                                    OR  profile.growth
density       = agentUsesDensity(model)             OR  usesSoftCollision(cfg)
                OR usesBondingPhysics(cfg)          OR  usesCharge(cfg)
```

The `density` predicate is deliberately **the scan predicate**: the force-pass neighbour scan
runs iff `bonding || doCollision || doDensity || doCharge`, and that scan is the field's only
writer. So `density` off ⇒ the scan never runs ⇒ nothing writes it, on every target.

### 1.4 THE LOCKSTEP — five mirrors of one number

The gates decide **byte offsets**. A mirror that disagrees does not crash; it reads a
*neighbouring field's bytes* (the documented `+64-cell` corruption class). The mirrors:

1. `computeAgentMemoryLayout` (WASM baked offsets) — via `AgentLayoutExtras.fieldGates`
2. `createAgentStore` (the views over those offsets, and the plain-array path) — via `opts.fieldGates`
3. `computeAgentWebGPULayout` (`f32Base`) — via `AgentWebGPUExtras.fieldGates`
4. `deriveAgentAbi` (the JS param list) — via `AgentAbiShape.gates`
5. the parity harness's `buildArgs` — via the same descriptor

**All five derive from ONE function**, `resolveAgentFieldGates(model)` in the new
`src/model/agentFieldGating.ts`, and the resolved object is **SHIPPED** to the worker on the
init/recompile message (the `agentBondReqSlots` precedent) rather than recomputed there — so a
main-thread/worker disagreement is structurally impossible, not merely unlikely.
`audit-agent-layout.mjs` gains a **gated matrix** (all 16 gate combinations × 2D/3D) asserting
the descriptor, the CPU layout and the GPU layout agree on the field SET.

### 1.5 STEP 6 — the hazard the runbook does not mention

`Ant Necrophoresis` **ships with `motion: 'static'`**, and CLAUDE.md records why its inert
force pass **must still run**:

> "its unconditional `xNext = wrap(x + v)` pass just re-writes the same integer — **but it MUST
> run**, because `swapPositions` commits `xNext` over `x` every step, so a Set-Position write
> would otherwise be reverted."

So a naive "skip the force pass under Static" **reverts every `Set Agent Position` write** and
the ants stop moving. The fix is structural: under Static the engine skips **both** the force
pass **and** the position commit (`swapPositions` / the WebGPU `posCommit` / the L3
relax-commit), so `x` is the single live buffer and a graph write to it survives.

Per target:

| target | Static | Velocity |
|---|---|---|
| **JS** | skip the whole `for (_lit …)` body **and** `swapPositions`; skip the age-undo | run the integrate block with `v` unchanged (`x += v`), no force accumulation, no scan |
| **WASM** | an APPENDED `motionMode : i32` param (conditional arity, the L1 `forcePassParamsFor` precedent) — the worker simply does not call the force pass under Static | `motionMode == 1` ⇒ skip force accumulation + `v` update, keep `x += v` |
| **WebGPU** | `ForceControl.motionMode` — the worker skips the force + commit dispatches | same branch inside the shader |

`motion: 'force'` (every shipped model but one) takes the identical code path it does today ⇒
**byte-identity**.

### 1.6 What is explicitly OUT of scope

- **The Body/Motion SoA gate** (velocity/force/radius fields). The original STEP 6 named it;
  §C9 does not, and it would drag the render snapshot, `getAgentState`, serialize and all three
  integrators into a second layout change in the same phase. `positions + velocity + force +
  radius` stay always-allocated.
- Cadence/location decoupling (C8's follow-up), Barnes-Hut (C10).

---

## 2. Deliverables

1. `src/model/agentFieldGating.ts` — `AgentFieldGates`, `resolveAgentFieldGates(model)`,
   `ALL_FIELD_GATES_ON`, `agentMotionMode(cfg)` + `motionIntegrates` / `motionAppliesForces`.
2. The safety catch in the three agent compilers (default-0 read, skipped write).
3. Gating threaded through the five layout/ABI mirrors + shipped to the worker.
4. STEP 6 on all three targets, incl. the commit-skip.
5. `audit-agent-layout.mjs` gated matrix; `parity-agent-wasm.mjs` static/velocity + gated
   synthetics with VALUE invariants; `parity-agent-force.mjs` motion-mode combos.
6. Docs sweep: CLAUDE.md (rewrite the STEP 4/6 "deferred" section), HelpView (Motion modes),
   README, `HANDOFF_AGENT_CAPABILITY_PROFILES.md` status.

## 3. Verification plan

- `tsc` + `npm run build`; `check-compile-identity --compare` with **every moved surface
  enumerated and justified**; `parity-agent-wasm`, `parity-agent-force`,
  `check-agent-wasm-gate`, `audit-agent-layout`, `test-agent-abi`, `verify-agent-render`,
  `verify-render-uniform-layouts`, `test-generation-pipeline`, `test-geometry-taint`,
  `test-engine-resolve`, `test-agent-capabilities`, `check-no-unseeded-random`,
  `gen-capability-docs --check`.
- In-browser: ≥4 agent samples (one per agent target + GoL-on-agents), plus **Ant
  Necrophoresis** specifically (the Static hazard), plus a Static synthetic proving the force
  pass is skipped.
