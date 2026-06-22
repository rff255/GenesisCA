# HANDOFF — Agents Phase 2: torus-correct neighbour math, independent compile targets, and the agent brush overhaul

> **You (the next session) are being handed a fully-scoped, build-ready ticket.** Three prior investigation+design efforts (each with an adversarial critique) converged on the milestone below. This document is your **runbook**: an ordered list of small, independently-shippable PRs, each with a concrete change, exact `file:line` anchors, the resolved gotchas, and a runnable acceptance test. Execute it PR-by-PR. Do not re-derive the design — it is settled here, and every adversarial correction has already been folded into the plan (they are NOT left as open questions).
>
> This mirrors the style of [docs/HANDOFF_3D_GRID_CA.md](HANDOFF_3D_GRID_CA.md) — a runbook, not an essay. You write app code, PR by PR, and verify each before moving on.

---

## §0 — Mission, scope, and how to verify in this repo

### 0.1 Mission

Harden and extend the **Bond-Graph Agents — Floating Cells** subsystem (branch `agents_floating_cells`; see the "## Bond-Graph Agents — Floating Cells" section of [CLAUDE.md](../CLAUDE.md)) along three independent workstreams:

1. **Torus-correct neighbour math.** The agent engine wraps every relative vector on a torus, but the *graph* has no primitive that exposes a wrap-correct displacement — so the boids model (and `getCurvature`) subtract raw positions and tear at the seam. Add the missing **Get Agent Offset** primitive (torus-shortest `target − self` + Distance), fix `getCurvature`'s raw subtraction, and rebuild `gen-boids.mjs` to route cohesion/separation through it.
2. **Independent compile targets for grid vs. agents.** Today the grid target (`useWasm`/`useWebGPU`) and the agent loop (hard-JS) are illegitimately coupled by one two-line `useWebGPU=false` hack. Decouple them: add an independent `agentTarget`, drop the hack, and build the GPU-grid↔CPU-agent **field-readback bridge** so "WebGPU grid diffusion + JS agents" works. Then (Phase F) port the agent loop to WASM, unblocking the user's exact example (WebGPU grid + WASM async agents).
3. **The agent-brush UX overhaul.** The simulator's agent brush is a flat 5-button strip with one-agent-per-click seeding, no radius, no drag, no cursor, no config, no inspector. Bring it to cell-brush parity: radius/cluster seed, drag-to-seed, an agent cursor, kill radius, a seed-config panel (typed/initialized tissue), an on-demand agent inspector, and (lower priority) move + bond-paint.

### 0.2 Scope ordering rationale (value × independence)

The PRs are ordered so the highest-value, most self-contained work lands first:

```
PR1 ─ Torus fix: Get Agent Offset + getCurvature wrap + boids rebuild   ← small, high-value, self-contained — DO FIRST
PR2 ─ Agent brush: cursor + radius/cluster seed + drag-to-seed + kill radius   (brush body)
PR3 ─ Agent brush: seed-config panel + agent inspector                          (brush authoring)
PR4 ─ Agent brush: move/drag + bond-paint                                       (brush manipulation, NICE-to-have)
PR5 ─ Independent target SELECTION + GPU-grid field-readback bridge (JS agents)
PR6 ─ Phase F-WASM: agent loop → WebAssembly  (unblocks WASM async agents)
PR7 ─ Phase F-WebGPU: agent loop → WGSL  (the all-GPU path)
```

PR1–PR4 touch **zero compilers** (PR1 adds an agent-graph-only node; PR2–PR4 are simulator-UI + additive worker messages), so the lattice stays byte-identical by construction. PR5 re-sequences the worker step loop. PR6/PR7 are the genuine Phase-F ports.

### 0.3 Explicitly OUT OF SCOPE (state prominently)

- **3D agents** (Phase E — `gl3d.ts` instanced spheres + bond tubes). All of this milestone is **2D agents only**. The orthogonal 3D-grid work shipped on `grid_3d`; do not entangle.
- **WASM/WebGPU emit for `getAgentOffset` / any `bondGraph` node** — deferred to Phase F (PR6/PR7). The agent loop is JS-only until then (`compileAgentGraph` emits JS; agent models force `useWebGPU` off; there is no agent WASM/WGSL emitter yet).
- **Render bond-overlay seam tearing** ([SimulatorView.tsx:1079-1080](../src/simulator/SimulatorView.tsx)) and **`pickAgentAt` seam mispick** ([:3141](../src/simulator/SimulatorView.tsx)) — both confirmed COSMETIC/minor-UX (raw, unwrapped). Deferred; may be folded into PR2 if cheap (see PR2 note 7).
- **`.gcastate` FILE-format agent persistence** (the in-session getState/loadState round-trip already works; file base64 serialization is a separate ticket).
- **A graph-authorable per-PAIR force curve** and a **strict deposit-snapshot** for the closed feedback (the existing fused pass is fine for diffusion models).
- **PR4 marquee multi-select** and **kill-by-type / paint-by-type filters** (Tier-4 polish — keep out of v1).

### 0.4 How to verify in this repo

Four verification surfaces, used at every PR (same as the 3D handoff):

**(a) `tsc -b` before every commit.** Vite's dev server does NOT type-check. Run `npx tsc -b` (or, on the phantom `nodes/tsconfig.json` glitch, `npx tsc -p tsconfig.app.json --noEmit`). New `WorkerMsg` members (`getAgentState`/`moveAgents`/`formBondBatch`, extended `seedAgents.sets`), the new `agentState` response, and `CenterBasedConfig.agentTarget` must type-check with guarded array reads.

**(b) The cross-target compiler-import harness (byte-shape parity, NO UI).** The regression guarantee for PR1 + PR5. Cache-bust EVERY import (`?t=Date.now()` — Vite's dev module cache is sticky for compiler files):

```js
const t = '?t=' + Date.now();
const { compileGraph }      = await import('/src/modeler/vpl/compiler/compile.ts' + t);
const { compileGraphWasm }  = await import('/src/modeler/vpl/compiler/wasm/compile.ts' + t);
const { computeLayoutFromModel } = await import('/src/modeler/vpl/compiler/wasm/layout.ts' + t);
const { compileGraphWebGPU }= await import('/src/modeler/vpl/compiler/webgpu/compile.ts' + t);
const { EMPTY_MODEL }       = await import('/src/model/defaultModel.ts' + t);
// Or use the DEV harness directly:
const { compileAll } = await import('/src/dev/compileHarness.ts' + t);
const r = compileAll(model);   // → { js:{stepCode, fullCode, agent:{behaviourCode}}, wasm:{bytesJoined}, webgpu:{shaderCode} }
```

The load-bearing use: compile **Game of Life / Gray-Scott / Life3D / snake** BEFORE and AFTER a change and assert `js.stepCode` string-equal, `wasm.bytesJoined` byte-equal, `webgpu.shaderCode` string-equal. This is how PR1 proves the lattice is untouched (the agent-only node never appears in a lattice graph) and PR5 proves the JS/WASM grid step path is unchanged.

**(c) The worker via `window.__simWorker` (headless engine correctness).** Exposed in DEV ([SimulatorView.tsx](../src/simulator/SimulatorView.tsx)) for direct `postMessage`. After init, post a message and await the next `stepped`/response; read the agent render snapshot from `agentsRef` (shipped every `stepped`) and `getState` for the full holey store (`attrRead` per attr). This is how you verify seeding/kill/inspect/move/bond numerically before driving any UI.

**(d) `preview_eval` for UI.** `preview_eval` has a ~30s tool timeout; `preview_screenshot` times out on the busy agent canvas — prefer DOM-query + snapshot-state `preview_eval` checks. Synthetic pointer events do NOT reliably drive canvas drags — drive features through their refs / `window.__sim*` hooks, or assert via the worker round-trip.

---

## §0.5 — Critique corrections — APPLY THESE (they amend the PRs below)

Each workstream's adversarial review caught **ship-a-bug** issues. They are authoritative and **already folded into the PRs**; this section is the index so you can confirm none slipped.

### Torus fix (PR1) — three corrections, all resolved in PR1

- **C-T1 (BLOCKER) — division-event param scope.** `getAgentOffset` and the wrapped `getCurvature` reference `_fieldW`/`_fieldH`/`_fieldBoundaryTorus`. These ride the **agent-loop** signature (`buildAgentLoopParams` [compile.ts:2038](../src/modeler/vpl/compiler/compile.ts), torus at [:2069](../src/modeler/vpl/compiler/compile.ts)) but are **ABSENT from `buildDivisionParams`** ([compile.ts:2019](../src/modeler/vpl/compiler/compile.ts)). The nodes are gated by graph KIND, not root, so they're freely placeable in a `divisionEvent` graph → `ReferenceError`. **`getCurvature` is ALREADY division-unsafe** today (it references `_agentBondCount`/`maxBonds`/`_bondPartner`, also absent from division params), and `fieldGradient` is *documented* as wire-into-Divide-Agent-axis yet `_field_*` is absent there too — a pre-existing latent bug the sweep missed. **Resolution (PR1, the right call): expand `buildDivisionParams` + its worker mirror `buildDivisionArgs` ([sim.worker.ts:493](../src/simulator/engine/sim.worker.ts)) to include the field + bond + velocity + hash params** the behaviour root already carries, so any agent read node is division-safe. See PR1 step 5.
- **C-T2 (BLOCKER) — broken boids expression rebuild.** Expression node ports are a **FIXED pool `a`–`h` sliced by `visibleCount`** ([ExpressionNode.ts:10](../src/modeler/vpl/nodes/ExpressionNode.ts)), NOT renumbered. The dossier's draft set `visibleCount:6` but referenced `g` (speed) — `g` wouldn't exist. **Resolution: keep `visibleCount:7`, drop ONLY the `c`-input edge (cohesion no longer subtracts self; `c` stays unwired→0, harmless since the formula doesn't reference it), and use the single corrected `FFORM2` literal** (the draft's intermediate `FFORM` with the unterminated `${KPROP` must NOT survive). See PR1 step 6.
- **C-T3 — prove byte-identity, don't assert it.** The "lattice unaffected because the node is agent-only" claim is true but must be *run* through `compileAll` on the four baselines, not reasoned about. In PR1's DoD.

### Independent targets (PR5–PR7) — five corrections, all resolved

- **C-D1 (BLOCKER) — do NOT unify the per-generation loops into one `async` helper.** The dossier proposed one `runOneGeneration()` called from both the sync JS/WASM loop ([sim.worker.ts:3090](../src/simulator/engine/sim.worker.ts)) and the async WebGPU loop ([~:3046](../src/simulator/engine/sim.worker.ts)). But `ensureCpuAttrsFresh()` is `await`-ed — **you cannot `await` in the synchronous JS/WASM `for` loop**, and an `async` helper that the sync loop ignores is NOT byte-identical. **Resolution: keep the JS/WASM per-generation body as the existing inline code (literally unchanged), and add the agent interleave + field bridge ONLY inside the WebGPU branch.** Two paths, not one. See PR5 step 4.
- **C-D2 (BLOCKER) — WebGPU direct-render vs. agent overlay.** WebGPU *direct* render writes to an OffscreenCanvas and skips the colors readback the agent overlay's main-thread composite needs. **Resolution: agent models on a WebGPU grid MUST stay on the colors-READBACK render path** (gate `pendingCanvasAttach` on `!agentModel`, mirroring the 3D `!is3D` gate). Document the (modest) perf cost. See PR5 step 3.
- **C-D3 — prove lattice byte-identity from "path unchanged," not "flags false."** Because PR5 leaves the JS/WASM loop literally untouched, byte-identity follows by construction — but still run `compileAll` on the four baselines in PR5's DoD.
- **C-D4 — `agentTarget` mutual-exclusion + async rejection.** `agentTarget='webgpu'` ⊥ async-agent mode must be enforced at BOTH the UI gate and a worker-side `agentTargetOf` clamp (the file-load safety net), mirroring the grid's two-layer enforcement. PR5 ships the clamp-to-`'js'` safety net; PR7 adds the UI gate when WebGPU agents land.
- **C-D5 — CUT the "optional consolidation" PR.** Consolidation that threatens byte-identity is anti-valuable here. There is no consolidation PR in this plan.

### Agent brush (PR2–PR4) — four corrections, all resolved

- **C-B1 (FACTUAL ERROR) — `agentOverflow` is NOT surfaced.** The worker *posts* `agentOverflow` (3 sites incl. [sim.worker.ts:772](../src/simulator/engine/sim.worker.ts), [:3772](../src/simulator/engine/sim.worker.ts)) but **SimulatorView's message dispatch has no handler for it** (verified: the dispatch at [SimulatorView.tsx:1454+](../src/simulator/SimulatorView.tsx) handles `stepped`/`stopEvent`/etc., no `agentOverflow` case). Bulk cluster-seed + drag-seed will hammer `maxAgents`. **Resolution: add the handler (toast/notice) in PR2.** See PR2 step 1.
- **C-B2 — Shift+LMB inspect cannot "fall through" as a sibling block.** The cell-sweep Shift+LMB branch ([SimulatorView.tsx:3579](../src/simulator/SimulatorView.tsx)) runs FIRST and `return`s before the agent block ([:3608](../src/simulator/SimulatorView.tsx)). **Resolution: inject the `pickAgentAt(...) >= 0` check INSIDE the `:3579` branch (before the sweep starts), not as a new block.** PR3 step 5.
- **C-B3 — `brushShapeOffsets` is NOT reusable for agent seeding.** It returns **integer cell offsets**; agents need continuous jittered world positions. **Resolution: `agentSeedPoints` (sunflower/Poisson) is NEW code; only `brushShape`/`brushRadius` *state* is reused.** PR2 step 3.
- **C-B4 — do NOT share the `pendingPaintRaf` token between seed and paint.** `flushPaintBatch` is hard-wired to post `paint`/`paintManual`. **Resolution: drag-seed gets a SEPARATE `pendingSeedPoints` buffer AND a separate rAF token** (a shared token's `cancelAnimationFrame` clobbers the other). Plus `canvasAgentBrushActive` must clear on the overlay-bail path ([:3562](../src/simulator/SimulatorView.tsx)) AND on pointer-up. PR2 steps 4–5.

---

## §1 — Design recap (the verified facts you're building on)

**The three workstreams are independent.** PR1 (a new agent-graph node + a node-emit wrap fix + a sample-model regen) shares no files with PR5 (worker step-loop re-sequence + schema field) or PR2–PR4 (simulator-UI + worker messages). Ship them in any interleaving; the order above is by value/independence.

**Workstream 1 — torus root cause (CONFIRMED).** `getNearbyAgents` correctly wraps its distance test ([GetNearbyAgentsNode.ts:28](../src/modeler/vpl/nodes/GetNearbyAgentsNode.ts)), so the neighbour LIST is right. But `getSelfPosition` ([GetSelfPositionNode.ts:23](../src/modeler/vpl/nodes/GetSelfPositionNode.ts)) and `getAgentPosition` ([GetAgentPositionNode.ts:22](../src/modeler/vpl/nodes/GetAgentPositionNode.ts)) emit **raw array indexing** (correct — they *are* positions), and `gen-boids.mjs:75-78,110-133` then computes `myX - nbrX` **unwrapped** → cohesion points the wrong way across nearly the whole 120-wide world; separation pushes toward the neighbour. Alignment via `getVelocity` ([GetVelocityNode.ts:22](../src/modeler/vpl/nodes/GetVelocityNode.ts)) is wrap-INDEPENDENT (velocity is already a delta) — leave it. **Verdict: a missing primitive (wrap-aware displacement), not an engine bug.** The engine's 17 relative-vector sites are all torus-correct (force soft-sphere [sim.worker.ts:628,647](../src/simulator/engine/sim.worker.ts), bond springs [:674](../src/simulator/engine/sim.worker.ts), integration wrap [:697](../src/simulator/engine/sim.worker.ts), hash stencil [:621](../src/simulator/engine/sim.worker.ts), auto-bond [:789,819](../src/simulator/engine/sim.worker.ts), `tensionAxis`/`divideAgent` [agentEngine.ts:486,535,557](../src/simulator/engine/agentEngine.ts), the field samplers). The **one engine-side graph-node bug** is `getCurvature` ([GetCurvatureNode.ts:28](../src/modeler/vpl/nodes/GetCurvatureNode.ts)): `dx=_agentX[p]-_agentX[idx]` raw → a bonded partner across the seam gives a huge wrong unit vector. Fix it in the same pass as the primitive.

**Reproduced (hard number, re-confirm before PR1 and after):** on the 120×120 torus Boids model, seed a pair 6 units apart ACROSS the seam (`(3,40)` + `(117,40)`) vs an identical pair mid-grid (`(57,80)` + `(63,80)`), `clearAgents` then `seedAgents`, step 12, read `snapshot.vx`. **Current (buggy):** the boundary pair is pulled toward each other THE LONG WAY (toward grid-centre) at combined |vx| ≈ **0.82** — raw cohesion on a 114-unit delta — while the mid pair correctly separates at ≈ **0.20**. **After PR1:** the boundary pair must behave like the mid pair (separate across the seam), combined |vx| in the same regime as mid, no long-way convergence. This is the canonical regression for the fix.

**Workstream 2 — the coupling (CONFIRMED).** `initGrid` allocates ONE `wasmMemory`; `readAttrs = attrsA` are typed-array **views** over it ([sim.worker.ts:1313-1337](../src/simulator/engine/sim.worker.ts)). The JS agent loop's field args (`buildAgentLoopArgs` [:508](../src/simulator/engine/sim.worker.ts), `readAttrs[spec.id]`) are those same views — so **WASM-grid + JS-agents already works (shared bytes, no bridge)**. WebGPU-grid is blocked only because (a) under WebGPU, attrs go GPU-resident (`gpuOwnsAttrs` flips true after `runStepWebGPU` [:1839](../src/simulator/engine/sim.worker.ts)), so the agent gather/deposit on the CPU `readAttrs` mirror is stale/invisible; AND (b) the WebGPU step branch ([:3046](../src/simulator/engine/sim.worker.ts)) **never calls `runAgentStep()`** (the agent interleave lives only in the JS/WASM branch [:3090](../src/simulator/engine/sim.worker.ts)). The bridge primitives already exist: `ensureCpuAttrsFresh`/`readbackAttrs` ([:1566-1576](../src/simulator/engine/sim.worker.ts)), `uploadAttrs` (init [:1116](../src/simulator/engine/sim.worker.ts)). The force-disable hack is at [SimulatorView.tsx:1922-1924](../src/simulator/SimulatorView.tsx) (init) + [:2323-2325](../src/simulator/SimulatorView.tsx) (recompile), and its own comment already describes the intended decoupling.

**The feasibility matrix** (G = grid target, A = agent target; "field model" = the agent graph uses any of `sampleField`/`fieldGradient`/`readCellsUnder`/`affectCellsUnder`/`secreteToField`):

| G ↓ \ A → | **JS agent** | **WASM agent** | **WebGPU agent** |
|---|---|---|---|
| **JS grid** | ✅ today (shared CPU arrays) | ⚙ PR6. Field: shared `wasmMemory` views ⇒ no bridge | ⚙ PR7 + bridge |
| **WASM grid** | ✅ today (shared `wasmMemory`, no bridge) | ⚙ PR6. **Same `wasmMemory` ⇒ no bridge — cleanest pair** | ⚙ PR7 + bridge |
| **WebGPU grid** | 🔵 **PR5.** No-field: trivial. Field: needs the readback bridge — NO agent-loop port | ⚙ PR6 + bridge (the user's example) | 🟣 PR7, all-GPU |

**Bridge-need rule (precise):** a per-step field bridge is needed **iff** grid attrs and the agent loop have **different memory residency** AND the model is a **field model**. Same residency (both CPU/`wasmMemory` views) → no bridge (shared bytes). The "no bridge" claim is about the shared **field** arrays (`readAttrs`, total-length), NOT the agent's own per-agent `attrRead`/`attrWrite` (`maxAgents`-length, single-buffer).

**Workstream 3 — the brush data paths (CONFIRMED).** Today: 5 modes (`AgentBrushMode = 'seed'|'kill'|'glue'|'cut'|'paint'` [SimulatorView.tsx:697](../src/simulator/SimulatorView.tsx)); one agent per click; `pickAgentAt` ([:3133](../src/simulator/SimulatorView.tsx)) nearest-within-radius; agent modes consume plain LMB at the down event and `return` at [:3630](../src/simulator/SimulatorView.tsx) BEFORE the cell-brush block (so the mousemove paint path never fires — gap #2). The worker protocol is ALREADY richer than the UI: `seedAgents` takes a position array with per-spec `type`/`lineage`/`radius` ([:312](../src/simulator/engine/sim.worker.ts), handler [:3766](../src/simulator/engine/sim.worker.ts)); `paintAgents` ([:327](../src/simulator/engine/sim.worker.ts), handler [:3802](../src/simulator/engine/sim.worker.ts)) writes per-agent `attrRead`+`attrWrite`; `killAgents` takes an id array ([:323](../src/simulator/engine/sim.worker.ts)). The render snapshot (`snapshotAgentsForRender` [agentEngine.ts:647](../src/simulator/engine/agentEngine.ts)) carries x/y/vx/vy/radius/alive/colors/type/bonds but **NOT** `bondCount`/`density`/attr values — they exist on the store ([:80,81,110](../src/simulator/engine/agentEngine.ts)) and are trivially readable by an on-demand `getAgentState {id}` handler.

---

## §2 — The PR plan

> **Branch discipline:** all work on the `agents_floating_cells` branch (or a child of it). Never push, never add Co-Authored-By lines (the user handles all git). Per CLAUDE.md, a non-trivial UI/behaviour change needs an illustrated HTML mockup alongside the plan — **already built: `docs/MOCKUP_AGENTS_PHASE2.html`** (§1 torus before/after vectors, §2 the brush panel + cursor states + inspector, §3 the independent-targets radios + dual-target dataflow). Keep it in sync if the design shifts.

---

### PR1 — Torus fix: Get Agent Offset + getCurvature wrap + boids rebuild

**Goal.** Add ONE new agent-graph node, **Get Agent Offset** (torus-shortest `(dX, dY)` from this agent to a target + Distance), fix `getCurvature`'s raw partner subtraction, expand `buildDivisionParams`/`buildDivisionArgs` so any agent read node is division-safe, and rebuild `gen-boids.mjs` to route cohesion/separation through the offset. JS-only (agent loop); lattice byte-identical; WASM/WebGPU deferred to PR6/PR7.

**Files & symbols.**
- NEW `src/modeler/vpl/nodes/GetAgentOffsetNode.ts`.
- `src/modeler/vpl/nodes/registry.ts:23` (imports — after `GetAgentPositionNode`), `:118` (`ALL_NODES` — after `GetAgentPositionNode`).
- `src/modeler/vpl/compiler/loopInvariant.ts:125` (`NEVER_INVARIANT`, after `'getAgentPosition'`).
- `src/modeler/vpl/compiler/compile.ts:67` (`MULTI_OUTPUT_TYPES`); `:2019` (`buildDivisionParams`); `:2038-2069` (`buildAgentLoopParams` — the param set to MIRROR into division params).
- `src/simulator/engine/sim.worker.ts:493` (`buildDivisionArgs` — the worker mirror of division params); `:508` (`buildAgentLoopArgs` — the arg set to mirror).
- `src/modeler/vpl/nodes/GetCurvatureNode.ts:28` (raw partner offset — wrap it).
- `scripts/gen-boids.mjs:68-78` (per-neighbour body), `:110-133` (post-loop cohesion force).
- `src/modeler/vpl/compiler/accessorCSE.ts:83` (`NEVER_PURE_TYPES` — **verify** `getAgentOffset` need: see note below).

**The change.**

**Step 1 — new node** `GetAgentOffsetNode.ts` (mirrors `getAgentPosition`'s shape exactly):

```ts
import type { NodeTypeDef } from '../types';

/** Get Agent Offset — the torus-SHORTEST displacement (dX, dY) from THIS agent
 *  to a target agent by id, plus Distance (Bond-Graph Agents). Use this — NOT
 *  raw position subtraction — for cohesion / separation / "steer toward
 *  neighbour" math so it stays correct across a torus seam. Mirrors the engine's
 *  wrap (reads `_fieldW`/`_fieldH`/`_fieldBoundaryTorus`, which ride the agent
 *  loop signature). dX = target − self (points TOWARD the target), matching the
 *  engine's attractive-force sign (force `+k·dx`). Multi-output (`_v<id>_<port>`). */
export const GetAgentOffsetNode: NodeTypeDef = {
  type: 'getAgentOffset',
  label: 'Get Agent Offset',
  description: 'Torus-shortest (dX, dY) and Distance from this agent to a target — for wrap-correct neighbour vectors.',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'agentId',  label: 'Agent',    kind: 'input',  category: 'value', dataType: 'integer' },
    { id: 'dx',       label: 'dX',       kind: 'output', category: 'value', dataType: 'float' },
    { id: 'dy',       label: 'dY',       kind: 'output', category: 'value', dataType: 'float' },
    { id: 'distance', label: 'Distance', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const a = `((${inputs['agentId'] || '0'}) | 0)`;
    const V = `_v${nodeId}`;
    return `const __go${nodeId}=${a};`
      + `let __odx${nodeId}=_agentX[__go${nodeId}]-_agentX[idx],__ody${nodeId}=_agentY[__go${nodeId}]-_agentY[idx];`
      + `if(_fieldBoundaryTorus){const __W=_fieldW,__H=_fieldH,__hW=__W/2,__hH=__H/2;`
      + `if(__odx${nodeId}>__hW)__odx${nodeId}-=__W;else if(__odx${nodeId}<-__hW)__odx${nodeId}+=__W;`
      + `if(__ody${nodeId}>__hH)__ody${nodeId}-=__H;else if(__ody${nodeId}<-__hH)__ody${nodeId}+=__H;}`
      + `const ${V}_dx=__odx${nodeId},${V}_dy=__ody${nodeId},${V}_distance=Math.hypot(__odx${nodeId},__ody${nodeId});\n`;
  },
};
```

**Step 2 — wiring (3 edits, mirroring `getAgentPosition`):**
- `registry.ts:23`: `import { GetAgentOffsetNode } from './GetAgentOffsetNode';`
- `registry.ts:118`: insert `GetAgentOffsetNode,` after `GetAgentPositionNode,` in `ALL_NODES`.
- `loopInvariant.ts:125`: add `'getAgentOffset',` after `'getAgentPosition',` in `NEVER_INVARIANT` (it reads per-agent `_agentX[idx]`; without this a consumer hoists above the agent-loop preamble → `_agentX is not defined`).
- `compile.ts:67`: add `'getAgentOffset'` to `MULTI_OUTPUT_TYPES` (three outputs resolve via `_v<id>_<port>`).

**Step 3 — CSE purity (verify, likely no-op).** `getAgentOffset` reads positions, which are read-only within a step (writes go to xNext). It is pure WITHIN a step, same as `getAgentPosition` (which is NOT in `NEVER_PURE_TYPES` — verified [accessorCSE.ts:83](../src/modeler/vpl/compiler/accessorCSE.ts) lists `getIndicator`/`getVariable`/`getAgentAttribute`). **Do NOT add `getAgentOffset` to `NEVER_PURE_TYPES`** — match `getAgentPosition`'s treatment (CSE-eligible). State this explicitly in the PR.

**Step 4 — fix `getCurvature` (#14)** at [GetCurvatureNode.ts:28](../src/modeler/vpl/nodes/GetCurvatureNode.ts). ⚠️ `getCurvature.compile()` is a **single inline IIFE string** — inside its `for(let _k…)` loop it currently has `const dx = _agentX[p]-_agentX[idx], dy = _agentY[p]-_agentY[idx]; const d = Math.hypot(dx,dy);`. Do NOT paste the block below as a standalone statement (it would re-`const d` and drop an `if` into expression context). Instead, **edit that inline sequence in place**: change the `const dx,dy` to `let`, splice the wrap block immediately before the existing `const d = Math.hypot(dx,dy)` (which reads `_agentX[idx]`, so `_fieldW`/`_fieldH`/`_fieldBoundaryTorus` are already in the agent-loop scope). The resulting inner sequence:

```js
let dx = _agentX[p]-_agentX[idx], dy = _agentY[p]-_agentY[idx];
if (_fieldBoundaryTorus){const _cw=_fieldW,_ch=_fieldH,_chw=_cw/2,_chh=_ch/2;
  if(dx>_chw)dx-=_cw;else if(dx<-_chw)dx+=_cw; if(dy>_chh)dy-=_ch;else if(dy<-_chh)dy+=_ch;}
const d = Math.hypot(dx, dy);
```
Keep it as one concatenated IIFE string (escape/inline as the existing emit does); the multi-line form above is for readability only.

**Step 5 — division-event param scope (BLOCKER C-T1).** Both `getAgentOffset` and the now-wrapped `getCurvature` (and, pre-existingly, `fieldGradient`/`getVelocity`/the neighbour-access family) reference symbols absent from `buildDivisionParams`. ⚠️ **Accurate diagnosis** (the dossier overstated this): `buildDivisionParams` ([compile.ts:2022-2024](../src/modeler/vpl/compiler/compile.ts)) ALREADY includes `_agentBondCount` and `_agentDensity` — those are NOT missing. The genuinely-ABSENT symbols the agent-read nodes need are: **`_alive`, `highWater`, `_agentVX`, `_agentVY`, `maxBonds`, `_bondPartner`, `_fieldW`/`_fieldH`/`_fieldTotal`/`_fieldBoundaryTorus`, and the `_field_<id>` arrays.** Add EXACTLY these (division is a single-agent, non-loop function — do NOT blindly copy all of `buildAgentLoopParams`, which would drag in the loop-control/request buffers `_divideRequest`/`_killRequest`/`_bondFormReq`/`_hash*`/`_agentForceX`/`_agentForceY` that division legitimately omits). Concretely: insert `_alive`, `highWater` at the front (before `idx`? — no, after the `__axis*` defaults, alongside the other engine buffers), add `_agentVX`, `_agentVY`, `maxBonds`, `_bondPartner` to the engine-buffer block, and append the field block (`_fieldW`/`_fieldH`/`_fieldTotal`/`_fieldBoundaryTorus` + `for (const a of cellAttrs) parts.push('_field_'+a.id)`) exactly as `buildAgentLoopParams` does at [:2069-2070](../src/modeler/vpl/compiler/compile.ts). Mirror the SAME additions, SAME order, into the worker's `buildDivisionArgs` ([sim.worker.ts:493](../src/simulator/engine/sim.worker.ts)) — the two MUST stay positionally identical (the ABI-desync hazard, same discipline as `buildLoopArgs`↔`buildLoopParams`). This also fixes the pre-existing `fieldGradient`/`getVelocity`-in-division latent crash. **Acceptance: wire a `getAgentOffset` AND a `getCurvature` into a `divisionEvent`, recompile, and confirm no `ReferenceError` (the division fn runs per daughter).** Note: `getNearbyAgents` in a `divisionEvent` is intentionally NOT supported (the `_hash*` buffers stay out of division); if a future need arises, add them then.

**Step 6 — rebuild `gen-boids.mjs` (BLOCKER C-T2 resolved).** Replace the per-neighbour raw position read + raw subtraction with an offset, sum **offsets** (not positions), and drop the `myX`/`myY` cohesion subtraction. Alignment (`getVelocity`) unchanged. Keep `KCOH/KALI/KSEP/KPROP/CRUISE`, momentum, maxSpeed.

Per-neighbour body (replaces `:68-78`):
```js
const go = node('getAgentOffset', {}, 3, 5);     // dX,dY,Distance self→neighbour
vEdge(fe, 'element', go, 'agentId');
const gv = node('getVelocity', {}, 3, 6.2);       // unchanged (alignment)
vEdge(fe, 'element', gv, 'agentId');
// Separation = −offset / (d²+1)  (push AWAY, inverse-distance).  a=dX b=dY
const exSepX = node('expression', { expression: '-a/(a*a+b*b+1)', visibleCount: 2 }, 3, 7.4);
vEdge(go, 'dx', exSepX, 'a'); vEdge(go, 'dy', exSepX, 'b');
const exSepY = node('expression', { expression: '-b/(a*a+b*b+1)', visibleCount: 2 }, 3, 8.6);
vEdge(go, 'dx', exSepY, 'a'); vEdge(go, 'dy', exSepY, 'b');
```

Accumulators — sum **offsets**, not positions:
```js
const acCnt = accum('cnt',  null,   null, '1');
const acSX  = accum('sumX', go,     'dx');   // Σ (nbr−self) X   (was gp,'x' raw position)
const acSY  = accum('sumY', go,     'dy');   // Σ (nbr−self) Y
const acVX  = accum('sumVX', gv,    'vx');   // unchanged
const acVY  = accum('sumVY', gv,    'vy');   // unchanged
const acPX  = accum('sepX', exSepX, 'result');
const acPY  = accum('sepY', exSepY, 'result');
```

Post-loop force (replaces the cohesion term; **drop only the `c`=myX edge**, keep `visibleCount:7`). `sumX/n` is now the **mean offset to the local centroid** — cohesion needs NO `myX` subtraction. Variable map: `a=Σoff b=count d=Σvel e=Σsep f=myVel g=speed` (slot `c` stays unwired/0; the formula does not reference it):
```js
const FFORM2 = `((a/max(b,1))*${KCOH} + (d/max(b,1)-f)*${KALI} + e*${KSEP})*min(b,1)`
             + ` + (${CRUISE}/max(g,0.001)-1)*f*${KPROP}`;
const exFX = node('expression', { expression: FFORM2, visibleCount: 7 }, 8, 1.5);
vEdge(gSumX,'value',exFX,'a'); vEdge(gCnt,'value',exFX,'b');
vEdge(gVX,'value',exFX,'d');   vEdge(gSepX,'value',exFX,'e');
vEdge(gvSelf,'vx',exFX,'f');   vEdge(exSpeed,'result',exFX,'g');
// NOTE: the old `vEdge(bs,'myX',exFX,'c')` is REMOVED. Do NOT renumber d→c etc.
const exFY = node('expression', { expression: FFORM2, visibleCount: 7 }, 8, 3.5);
vEdge(gSumY,'value',exFY,'a'); vEdge(gCnt,'value',exFY,'b');
vEdge(gVY,'value',exFY,'d');   vEdge(gSepY,'value',exFY,'e');
vEdge(gvSelf,'vy',exFY,'f');   vEdge(exSpeed,'result',exFY,'g');
```
Confirm `min(b,1)` still gates the cohesion+alignment+separation block (it does in `FFORM2`). `bs.myX`/`myY` outputs may now be unused — harmless, leave the ports. Re-run `node scripts/gen-boids.mjs`. (The script's preserve-`simulationState`+thumbnail re-run tail keeps the existing snapshot.)

**Acceptance test.**
1. `tsc -b` clean (prepend the node path).
2. **Numeric boundary case** (the proof) via `window.__simWorker` on Boids (120×120 torus): place agent P at `(1, 60)`, neighbour Q at `(119, 60)`. ⚠️ sign: raw `Q−P = +118`; the torus-shortest fold is `118−120 = −2`, so **Get Agent Offset (P→Q) must emit `dX ≈ −2`** (Q sits 2 units to P's LEFT via the seam), `dY = 0`, `Distance ≈ 2` — NOT the raw `+118`. Then cohesion on P (only Q nearby): `sumX/n = −2` → cohesion-x `< 0` (pulls −x toward Q via the seam); separation on P: `−dX/(d²+1) = +2/5 > 0` (pushes +x away); at d=2 separation dominates → **net force-x `> 0`** (P separates from Q across the seam). Q→P: `dX ≈ +2` (mirror). The **decisive regression** (already reproduced — see §1): seed a boundary pair 6 apart across the seam + an identical mid-grid pair, step 12, and assert the **boundary pair's combined |vx| matches the mid pair's** (~0.2, separating) — NOT the pre-fix long-way ~0.82. (Verified post-fix: boundary 0.21 vs mid 0.20.)
3. **Polarization** preserved: run ~2000 steps, compute `|Σv|/Σ|v|` over live agents → must reach **~0.99** (the fix corrects boundary behaviour; the global metric is unchanged or better; pre-rebuild it climbed 0.008→0.99 already, so confirm it still does).
4. **Seam crossing** smooth: seed a tight flock translating +x; through the x=W→0 crossing the snapshot `vx`/`vy` variance stays low (no heading flips at the seam).
5. **Curvature (#14)**: a bonded sheet straddling the seam — interior agents read curvature ≈ 0 (not spuriously →1).
6. **Division-safety (C-T1)**: a model with `getAgentOffset` + `getCurvature` wired into a `divisionEvent` compiles and runs divisions with no `ReferenceError`.
7. **Lattice byte-identity (C-T3)**: `compileAll` on Game of Life / Gray-Scott / Life3D / snake → `{js,wasm,webgpu}` byte-identical to baseline (the new type never appears in a lattice graph; the `MULTI_OUTPUT_TYPES`/`NEVER_INVARIANT` additions are agent types never reached by lattice compiles).

**Risk/lockstep note.** JS-only (the agent loop is JS). WASM/WebGPU emit for `getAgentOffset` lands in PR6/PR7 (no WASM/WGSL emitter exists yet; `requirements.bondGraph` + the JS-only agent path keep this safe). Keep `getAgentPosition` raw — it's an absolute position needed for field seeding. The division-param expansion (step 5) is the non-obvious blocker; mirror the two lists exactly.

**Docs:** update the "## Bond-Graph Agents — Floating Cells" node catalogue in [CLAUDE.md](../CLAUDE.md) (add Get Agent Offset under "Neighbour access" + the curvature-wrap fix + the division-param expansion), [README.md](../README.md), [HelpView.tsx](../src/help/HelpView.tsx), [docs/NODES_REFERENCE.md](NODES_REFERENCE.md) (table + node count + the diagrams), and [docs/SUMMARY_AGENTS_FLOATING_CELLS.html](SUMMARY_AGENTS_FLOATING_CELLS.html).

---

### PR2 — Agent brush: cursor + radius/cluster seed + drag-to-seed + kill radius

**Goal.** The brush body / parity core. Add an agent cursor (radius ring + hover highlight + staged-glue highlight), radius/cluster seeding (a jittered disc per click), drag-to-seed (a spacing-throttled stream via a dedicated rAF batcher), and a kill radius (client-side id collection — no new worker message). Plus the missing `agentOverflow` handler. **Zero compiler touch.**

**Files & symbols.**
- `src/simulator/SimulatorView.tsx`: state block `:697-701` (`AgentBrushMode`, `agentBrushModeRef`, `agentGlueAnchorRef`); pointer handler `:3603-3635` (plain-LMB mode dispatch, `return` at `:3630`, RMB-cancel `:3633`); overlay-bail `:3562`; `pickAgentAt` `:3133`; `seedAgentsAt` `:3151`; `screenToWorld` `:3110` (already torus-wraps); the rAF batcher `flushPaintBatch` `:3230` / `pendingPaintCells` `:783` / `paintAt` `:3361` (drag-paint torus fold at `:3377`); `draw()` + `drawAgentsOverlay` `:1079`; the negative-silhouette cursor trick `:1232-1300` (esp. the `difference` composite `:1277`); the `AGENT BRUSH` pill block `:4910-4934` (panel, `data-sim-overlay` `:4911`); the message dispatch `:1454+` (add the `agentOverflow` case); settings-persist effect (`brushRadius` save `:528`).
- Worker: `seedAgents` `:3766` / `killAgents` `:3793` (both reused as-is).

**The change.**

**Step 1 — `agentOverflow` handler (C-B1, FACTUAL FIX).** In the message dispatch (`:1454+`, beside `stopEvent` at `:1641`), add `else if (msg.type === 'agentOverflow') { showToast(msg.message); }` (reuse the existing `showToast`/notice mechanism). Without this the worker's overflow posts are silently dropped — and cluster/drag seed are exactly what hit `maxAgents`.

**Step 2 — brush state + ref mirrors.** Extend the state block (`:697`):
```ts
const [agentBrushRadius, setAgentBrushRadius] = useState(8);     // world units
const [agentSeedDensity, setAgentSeedDensity] = useState(0.05);  // agents / unit²
const [agentSeedSpacing, setAgentSeedSpacing] = useState(6);     // drag-stream spacing, world units
```
Mirror each into a ref (pointer handlers read refs, not state). Persist `agentBrushRadius`/`agentSeedDensity`/`agentSeedSpacing` into `genesisca_sim_settings` (the effect at `:528`). UI: a `Radius` + `Density` + `Spacing` row using **`NumberField`** (the mandated number input), shown when mode ∈ {seed, kill}; put every control inside the `data-sim-overlay` panel.

**Step 3 — radius/cluster seed (C-B3: NEW code, not reuse).** New helper `agentSeedPoints(centerWorld, radius, density): Array<{x,y}>` — sample `N = density·π·r²` points via a **sunflower spiral** (or Poisson rejection) so they don't stack. **Boundary-correct placement (C-B7):** the agent world IS the grid 1:1, so wrap each point with `((x%W)+W)%W` **only when `model.properties.boundaryTreatment==='torus'`**; for a bounded model, **clamp** to `[0, W)`/`[0, H)` (or drop out-of-bounds points) — never torus-wrap a bounded world. This is genuinely new — `brushShapeOffsets` returns integer cell offsets (wrong type). On a seed-mode click, post ONE `seedAgents` with the full point list + `type: agentSeedTypeRef.current` per spec (the worker already batches at `:3770`).

**Step 4 — drag-to-seed (C-B4: SEPARATE buffer + token; S1: own active flag).** Add `pendingSeedPoints` (a ref array) and a **separate** `pendingSeedRaf` token — do NOT reuse `pendingPaintRaf` (its `flushPaintBatch` posts `paint`/`paintManual` and a shared token's `cancelAnimationFrame` clobbers the other). Add a `canvasAgentBrushActive` flag set on seed-mode down (mirror `canvasBrushActive` at `:3664`), cleared on the overlay-bail path (`:3562`) AND on pointer-up. On `mousemove` while active, if `dist(cur,last) >= spacing`, walk the segment in `spacing` steps (when `boundaryTreatment==='torus'` use the torus-shortest fold — copy the signed-delta wrap at `:3377`; for a bounded model walk the straight segment with no fold), append a disc-cluster per step to `pendingSeedPoints`, schedule the rAF. `flushSeedBatch()` posts one `seedAgents` with all accumulated points and clears (cancel-on-flush, one rAF in flight). On up: synchronous `flushSeedBatch()` + clear the flag.

**Step 5 — agent cursor.** In `draw()`, after `drawAgentsOverlay`, when `isAgentModel` and the mode is a radius mode: stroke the brush-radius ring at the cursor world→screen (cell transform), `globalCompositeOperation='difference'` + white (the `:1277` trick; `ctx.save`/`restore` so it doesn't leak), tiled in infinity mode. When a hover pick exists (`pickAgentAt` at the live cursor, throttled to **on-change** like the 3D `setHoverCells` pattern — never per-raw-move full redraws), outline that agent (kill mode → warm/red tint). Highlight `agentGlueAnchorRef` with a distinct accent ring + a dashed line to the cursor (fixes the invisible-staging gap). State: `agentCursorWorldRef` updated on `mousemove`; redraw only when the hovered agent or cursor cell changes.

**Step 6 — kill radius (no new message).** On kill-down/drag, collect ids from `agentsRef.current` whose `(x,y)` is within `radius` of the click (torus-aware distance), post the existing `killAgents([...ids])`. The snapshot is current every `stepped` (`:1459`), so client-side collection is correct. Single-nearest stays the radius=0 fallback; keep `pickAgentAt` for inspect/move/glue.

**Step 7 (OPTIONAL fold-in) — bond-overlay seam wrap + `pickAgentAt` seam wrap.** Cheap cosmetic fixes if you're in the file: in `drawAgentsOverlay` (`:1079-1080`) draw a seam-crossing bond as the torus-shortest segment (wrap `ax[j]−ax[i]`); in `pickAgentAt` (`:3141`) fold `snap.x[i]−wpt.x` to the torus-shortest. Neither affects the simulation; ship only if trivial.

**Acceptance test.**
1. `tsc -b` clean.
2. **Cluster seed**: post `seedAgents` with a 40-point disc → `liveCount` rose by ~40 (minus overflow) and the new `x/y` all lie within `radius` of center (torus-aware).
3. **Drag stream**: simulate the segment walk in eval → one `seedAgents` of M evenly-spaced points; assert consecutive-seed spacing ≈ `spacing` and `liveCount` delta == M.
4. **Kill radius**: seed a blob, collect ids within `r` client-side, `killAgents`, assert those ids are now `alive[id]===0` and `liveCount` dropped by the count.
5. **Overflow surfaced (C-B1)**: seed past `maxAgents` → the toast/notice fires (assert the dispatch's `agentOverflow` branch ran).
6. **Lattice byte-identity**: `compileAll` on the four baselines unchanged (no compiler touch — by construction).

**Risk/lockstep note.** Simulator-UI + reused worker messages only. The traps are the SEPARATE rAF token (C-B4) and clearing `canvasAgentBrushActive` on both the overlay-bail and pointer-up paths (S1 — a drag starting on canvas and releasing over the panel must not leave it stuck). Per CLAUDE.md, ship `docs/MOCKUP_AGENTS_PHASE2.html` (the expanded-seed panel + the canvas cursor states).

---

### PR3 — Agent brush: seed-config panel + agent inspector

**Goal.** The authoring core. A seed-config panel (Type dropdown + per-attribute initial values, Manual-Brush-style) that turns "spawn blobs" into "paint typed, initialized tissue"; and an on-demand agent inspector (id/pos/vel/radius/type/bonds/density + per-agent attr values via a `getAgentState` round-trip — NOT a fattened snapshot). **Zero compiler touch.**

**Files & symbols.**
- NEW `agentState` worker response + extended `SeedAgentsMsg.sets`.
- `src/simulator/engine/sim.worker.ts`: `SeedAgentsMsg` type `:312`; `seedAgents` handler `:3766` (the post-init `sets` loop); `WorkerMsg` union `:339`; `paintAgents` handler `:3802` (the `sets`-apply reference); the store fields `attrRead`/`bondCount`/`density` ([agentEngine.ts:80,81,110](../src/simulator/engine/agentEngine.ts)); `initAgentSlot`/`seedAgents` ([agentEngine.ts:273-274](../src/simulator/engine/agentEngine.ts)).
- `src/simulator/SimulatorView.tsx`: the `AGENT BRUSH` panel `:4910`; the cell-sweep Shift+LMB branch `:3579` (return at `:3600`); the agent-mode block `:3608`; `encodeAttrValue` import (`src/model/attrValueEncoding.ts`); the cell inspector chrome (`InspectCellPopover.tsx`) to mirror.
- Reuse `ManualBrushPanel.tsx` pattern + `InlineNumberInput`/`InlineBoolSelect`/`InlineTagSelect`/`NeighborIndexValuePicker`.

**The change.**

**Step 1 — seed-config state.** `agentSeedType: number` (ref + persisted in `genesisca_sim_settings`) and `agentSeedAttrs: Record<attrId,{enabled,value}>` keyed **per-model** (`genesisca_manual_brush_v1`-style key — attr ids are model-specific; do NOT persist globally). Signature-keyed merge effect when the attribute SET changes (mirror Manual Brush).

**Step 2 — UI.** A `▸ Seed config` disclosure under the mode strip (keeps the overlay compact). Rows mirror `ManualBrushPanel`: `[Type ▾]`, then per attribute `[✓] name [type-appropriate widget]`. Unchecked rows seed the engine default; dim them (`opacity:0.4; pointer-events:none`).

**Step 3 — extend `seedAgents` with `sets` (S4: worker-side post-init loop, NOT an `initAgentSlot` signature change).** Add `sets?: Array<{attrId,value}>` to `SeedAgentsMsg` (`:312`). In the worker `seedAgents` handler (`:3766`), after the engine `seedAgents` returns the new ids, apply `sets` per new id by writing `attrRead[attrId][id]` (and `attrWrite[...][id]` for next-step consistency) — exactly what `paintAgents` (`:3802`) already does; factor a shared helper. Encode values UI-side via `encodeAttrValue` before posting. `type` rides the existing per-spec field. (Do NOT touch `initAgentSlot`'s signature — both `seedAgents` and `divideAgent` call it.)

**Step 4 — `getAgentState` inspector data path (the crux — Option A, NOT snapshot fattening).** New message `getAgentState {id}` → worker reads `attrRead[*][id]` + geometry + `bondCount[id]` + `density[id]` + the bond list, posts `agentState {id, x, y, vx, vy, radius, type, bondDegree, density, attrs: Record<attrId,number>, bonds:[...]}`. A non-live id returns a null/empty response (no crash). **Reject fattening `snapshotAgentsForRender`** — it would pay `Σattrs × highWater × bytes` every frame for every agent when you inspect one; the round-trip is one tiny message per click (mirrors the cell inspector's on-demand nature). Live-refresh while pinned: re-request on a **low-Hz poll** (S3 — a per-`stepped` round-trip per pinned popover compounds with multiple popovers; the low-Hz poll is the safer default).

**Step 5 — inspector UI + the Shift+LMB hit-test (C-B2: INSIDE the `:3579` branch).** Reuse the `InspectCellPopover` chrome (or a sibling `InspectAgentPopover`): `#id`, `(x,y)`, `|v|` + heading glyph, `radius`, `Type N (label)`, `bonds: k`, `density`, then the attr rows. Anchor at the click; re-derive the agent's screen pos each frame from the snapshot for the connector line (the agent moves). **Inject the inspect claim INSIDE the cell-sweep Shift+LMB branch at `:3579`** (which requires `!ctrl && !alt && !meta`, runs first, and `return`s at `:3600`): at the TOP of that branch, `if (isAgentModelRef.current && pickAgentAt(...) >= 0) { open the agent inspector; return; }` else fall through to the cell sweep. Do NOT add a sibling block after `:3608` — it's unreachable. Widen the inspect hit-test to "nearest within `max(agentRadius, pickRadius)`" so tiny agents are clickable.

**Acceptance test.**
1. `tsc -b` clean (the new `WorkerMsg` members + `agentState` response type with guarded array reads).
2. **Seed config**: extend `seedAgents` with `sets`; seed 5 typed agents with `energy=2`; `getState` (full store round-trips `attrRead`) → `type[id]===chosen` and `attrRead.energy[id]===2` for the new ids.
3. **Inspector path**: post `getAgentState {id}` → response carries `attrs.energy`, `bondDegree===bondCount[id]`, geometry matching the snapshot; a non-live id returns null/empty (no crash).
4. **Coexistence (C-B2)**: with `isAgentModel`, Shift+LMB over **empty space** still opens the cell sweep inspector (agent inspect claims only when `pickAgentAt>=0`); Paint Field mode still deposits to the cell field unchanged.
5. **Lattice byte-identity**: `compileAll` on the four baselines unchanged.

**Risk/lockstep note.** The single decision that matters: inspector via on-demand `getAgentState`, not snapshot fattening — keeps the per-frame transfer lean at the 2000-agent / 174-steps-sec scale. Ship `docs/MOCKUP_AGENTS_PHASE2.html`'s inspector panel (fold into PR2's mockup or extend it).

---

### PR4 — Agent brush: move/drag + bond-paint (NICE-to-have)

**Goal.** Manipulation tools (lower priority — the engine's auto-bond-by-distance already covers most tissue). A Move/Select mode (pick + drag an agent live, bonds stretch) and a Bond-paint mode (drag a stroke, auto-glue every near pair). **Zero compiler touch.** Ship independently; defer marquee multi-select and type filters.

**Files & symbols.**
- NEW worker messages `moveAgents {moves:[{id,x,y}], torus}` and (only if bond-paint ships) `formBondBatch {pairs:[[a,b],...]}`.
- `src/simulator/engine/sim.worker.ts`: `formBond` handler `:3824` (the per-pair reference); `WorkerMsg` union `:339`; the store `x`/`y`/`xNext`/`yNext` ([agentEngine.ts SoA](../src/simulator/engine/agentEngine.ts)); `formBond`/`hasBond` engine helpers.
- `src/simulator/SimulatorView.tsx`: the agent-mode dispatch `:3608`; RMB-cancel `:3633`; `pickAgentAt` `:3133`; the rAF batcher pattern (reuse the discipline, own buffer/token per C-B4).

**The change.**

**Step 1 — Move mode.** New `moveAgents` handler: write `x/y` AND `xNext/yNext` (so the next integration doesn't snap back), clamp/wrap to world bounds, sweep no bonds. Pointer: Move mode down → `pickAgentAt` → `draggingAgentRef`; on drag, rAF-batched `moveAgents([{id, ...world}])` (own token); on up, final flush. **S2 (resolved): RMB mid-drag cancels the move** (revert to the pre-drag pos); document that with the sim playing, the spring force fights the drag per frame (acceptable — "pin and watch it relax"; the per-frame `moveAgents` interleaves nondeterministically with `runAgentStep`'s integration, which is fine for a manual nudge).

**Step 2 — Bond-paint mode.** On drag, scan the snapshot for agents within `radius` of the stroke; for each adjacent pair within `formDistance·contact` (the engine's auto-bond threshold from `centerBased`) that isn't already bonded (`snapshot.bonds` has the pairs), queue it; dedup client-side. Flush as a new `formBondBatch {pairs}` (loops `formBond` in the worker) — only add this message **when the feature actually ships** (don't add a speculative message).

**Acceptance test.**
1. `tsc -b` clean.
2. **Move**: `moveAgents([{id,x,y}])` → `x[id]/y[id]` updated AND a subsequent `step` doesn't revert them (xNext was set).
3. **Bond-paint**: seed two near agents, `formBondBatch([[a,b]])` → `snapshot.bonds` contains the pair and `bondCount` rose on both; re-batching the same pair is idempotent (no double bond).
4. **Lattice byte-identity**: `compileAll` on the four baselines unchanged.

**Risk/lockstep note.** Pure UI + additive messages. Keep marquee multi-select and kill-by-type out of v1.

---

### PR5 — Independent target SELECTION + GPU-grid field-readback bridge (JS agents)

**Goal.** Decouple the agent target from the grid target. Add `CenterBasedConfig.agentTarget` (default `'js'`, clamped to implemented targets), a Properties radio (WASM/WebGPU disabled "coming soon"), drop the two force-disable hacks, detect field models, and add the GPU-grid↔CPU-agent field bridge **inside the WebGPU step branch only** (NOT a unified async helper). Unblocks "WebGPU grid diffusion + JS agents" with no agent-loop port.

**Files & symbols.**
- `src/model/types.ts:579` (`CenterBasedConfig` — add `agentTarget?`).
- `src/model/centerBased.ts:54` (`cbNum` resolver — add `agentTargetOf`).
- `src/modeler/panels/PropertiesPanelContent.tsx` (Bond-Graph Agents section, `updateCenterBased`).
- `src/simulator/SimulatorView.tsx:1922-1924` (init force-disable — REMOVE), `:2323-2325` (recompile force-disable — REMOVE), the `needsFullInit` predicate `:2272-2274` (add `agentTarget`), the `pendingCanvasAttach` gate (add `!agentModel`), where `compileAgentModel()` runs (compute `agentUsesField`).
- `src/simulator/engine/sim.worker.ts:3046` (WebGPU step branch — add the agent interleave + bridge), `:3090` (JS/WASM loop — LEAVE UNCHANGED), `ensureCpuAttrsFresh`/`readbackAttrs` `:1566-1576`, `uploadAttrs` `:1116`, `gpuOwnsAttrs` `:1564,1839`, `runStepWebGPU` `:1812`, `runAgentStep` (the agent step), `buildAgentLoopArgs` `:508`.
- `src/dev/compileHarness.ts` (`compileAll` already returns `js.agent.behaviourCode`).

**The change.**

**Step 1 — schema + resolver.** Add to `CenterBasedConfig` (`types.ts:579`), additive/optional:
```ts
/** Agent-engine compile target, INDEPENDENT of the grid target
 *  (model.properties.useWasm/useWebGPU). 'js' (default) until Phase F ports
 *  compileAgentGraph to WASM/WebGPU. Grid and agents can differ:
 *  e.g. grid='webgpu' (diffusion) + agentTarget='wasm' (async agents). */
agentTarget?: 'js' | 'wasm' | 'webgpu';
```
Add `agentTargetOf(cfg): 'js'|'wasm'|'webgpu'` to `centerBased.ts` (mirror `cbNum`), **clamping to what's implemented** — in PR5 anything other than `'js'` → `'js'` (with a one-line console note). This is the C-D4 file-load safety net. Keep `agentTarget` on `centerBased` (not `properties`) so a non-agent model never carries it and it's decoupled from the grid `useWasm`/`useWebGPU` pair.

**Step 2 — Properties UI.** In **Properties → Bond-Graph Agents**, an **Agent Compile Target** 3-way radio (JS default / WebAssembly / WebGPU), visually paralleling the grid's Compile Target radio, with WASM + WebGPU **rendered but `disabled` + "coming soon (Phase F)"** (the 3D-milestone pattern). Sub-label: *"Independent of the grid's Compile Target. The grid and agents can run on different targets (e.g. WebGPU grid diffusion + WASM agents)."* Changing `agentTarget` forces a recompile; a residency-changing target forces a full reinit — add `agentTarget` to `needsFullInit` (`:2272-2274`). PR7 enables the WebGPU radio + adds the `agentTarget='webgpu'` ⊥ async-agent UI gate (C-D4).

**Step 3 — drop the hacks + keep agent+WebGPU on the readback render path (C-D2).** ⚠️ **Ordering guard (C-D6):** Step 1's `agentTargetOf` clamp (anything ≠ `'js'` → `'js'`) MUST land in the SAME commit as — and logically before — this hack removal. Removing the force-disable while a hand-edited `agentTarget:'wasm'` file could reach the dispatch would route to a non-existent `compileAgentGraphWasm`. With the clamp in place first, every target resolves to `'js'` until PR6, so removing the hacks is safe. Remove `SimulatorView.tsx:1922-1924` and `:2323-2325`. The grid target now flows through unmodified. **Gate `pendingCanvasAttach` on `!agentModel`** (mirror the 3D `!is3D` gate) so an agent model on a WebGPU grid stays on the colors-READBACK render path — the agent overlay needs the main-thread colors composite, which WebGPU *direct* render skips. Document the modest per-step readback cost for agent+WebGPU models.

**Step 4 — `agentUsesField` + the WebGPU-branch bridge (C-D1: TWO paths, not one).** At compile, scan the agent graph for any of the five field nodes (`sampleField`/`fieldGradient`/`readCellsUnder`/`affectCellsUnder`/`secreteToField`); ship a boolean `agentUsesField` in init/recompile; the worker stores it. **Leave the JS/WASM loop at `:3090` LITERALLY UNCHANGED** (this is what guarantees lattice byte-identity by construction — C-D3). Add the interleave ONLY in the WebGPU async branch (`:3046`), which is already `async` so the `await` fits:
```ts
// inside the WebGPU step branch, per generation, BEFORE runStepWebGPU():
if (agentStore) {
  if (agentUsesField && gpuOwnsAttrs) { await ensureCpuAttrsFresh(); /* GPU→CPU; flips gpuOwnsAttrs=false */ }
  runAgentStep();                                  // gather reads readAttrs (fresh); deposit writes readAttrs
  if (agentUsesField) { uploadAttrs(rt, readAttrs); gpuOwnsAttrs = false; }   // CPU→GPU, before the cell step
}
runStepWebGPU();                                   // GPU cell CA consumes the deposit; gpuOwnsAttrs=true
```
For a **no-field** WebGPU-grid agent model: the two bridge lines are skipped — `runAgentStep()` writes only the agent SoA + `colors`, then `runStepWebGPU()`. Instrument `readbackAttrs` call-count = 0 for no-field models (C-D5 / cheapest regression guard).

**Step 5 — agent step stays JS.** `agentTargetOf` resolves to `'js'`, so `runAgentStep()` is unchanged. The dispatch-on-target generalization lands in PR6.

**Acceptance test.**
1. `tsc -b` clean.
2. **GPU grid + JS agents, field model**: load Chemotaxis, flip the grid to WebGPU, `agentTarget='js'` → the field builds on GPU, agents aggregate; compare bin counts to the WASM-grid baseline (match within float-drift tolerance).
3. **No-field on GPU grid**: Boids on a WebGPU grid → flock forms; instrument `readbackAttrs` call count == **0** (no spurious per-step readback).
4. **`gpuOwnsAttrs` transitions (C-D1/C-D2)**: assert the sequence per gen for a field model (`true → readback → false → upload(stays false) → step → true`) with an instrumented test — don't rely on "mirror the mutation handlers."
5. **Lattice byte-identity (C-D3)**: `compileAll` on Game of Life / Gray-Scott / Life3D / snake on all three grid targets byte-identical to baseline — proven from "the JS/WASM step path is literally unchanged code," confirmed by the harness.
6. **getState residency (C-D5 item 6)**: a no-field WebGPU-grid agent model `getState` serializes BOTH the GPU attrs (readback) AND the agent SoA — confirm the existing in-session round-trip is residency-independent (likely already true; state it).

**Risk/lockstep note.** The single underestimated risk was the async-helper unification — DO NOT do it (C-D1). Keep the JS/WASM loop untouched; the bridge lives only in the WebGPU branch. There is NO consolidation PR (C-D5). The deposit-conflict semantics (many CPU agents → one cell, sequential apply) is safe in PR5 (you upload the *resolved* CPU `readAttrs`); it only becomes a real decision in PR7.

**Docs:** ship `docs/MOCKUP_AGENTS_PHASE2.html` (the two independent radios side-by-side + the GPU-grid/CPU-agent field-bridge data-flow diagram). Update CLAUDE.md (the Bond-Graph Agents "compile target" note), README, HelpView.

---

### PR6 — Phase F-WASM: agent loop → WebAssembly

**Goal.** Port `compileAgentGraph` to WASM (`compileAgentGraphWasm`), dispatch `runAgentStep()` on `agentTargetOf`, enable the WASM radio. Unblocks the user's exact example: **WebGPU grid diffusion + WASM async agents**. Field models share `wasmMemory` with a WASM grid (no bridge); with a WebGPU grid, reuse PR5's residency bridge (now CPU/`wasmMem` ↔ GPU).

**Files & symbols.**
- NEW `src/modeler/vpl/compiler/agentWasm/*` (or extend `wasm/compile.ts`) — `compileAgentGraphWasm` (sibling of `compileAgentGraph` [compile.ts:2107](../src/modeler/vpl/compiler/compile.ts)).
- `src/simulator/engine/sim.worker.ts`: `runAgentStep` (dispatch on `agentTargetOf`, mirroring how `runStep` dispatches on the grid target at `:1636-1653`); `buildAgentLoopArgs` `:508` (the ABI to mirror in WASM); the WASM agent runtime allocations.
- `src/model/centerBased.ts` (`agentTargetOf` — widen the allow-set to include `'wasm'`).
- `src/modeler/panels/PropertiesPanelContent.tsx` (enable the WASM radio).
- `src/dev/compileHarness.ts` (`compileAll` — add `wasm.agent`).
- Emit ALL referenced agent value nodes incl. the new `getAgentOffset` (PR1) — this is where its WASM emitter lands.

**The change (sketch — the port is the bulk of the work).**
- `compileAgentGraphWasm` mirrors `compileAgentGraph`: flatten macros, strip reroutes, accessor-CSE, find `behaviourStep`, emit the per-agent loop. The loop variable stays `idx` (D-IDX), Local Variables inject via the WASM `emitVariableStorage`/`emitVariableReset` pattern, and the spatial-hash params + field args must MIRROR `buildAgentLoopArgs` exactly (the ABI-desync hazard — same discipline as `buildLoopArgs`↔`buildLoopParams`). `divisionEvent` compiles to a single-agent WASM function (mirror `buildDivisionParams`/`buildDivisionArgs` — note PR1 already expanded both).
- `runAgentStep()` dispatches: `agentTargetOf(cfg) === 'wasm'` → the WASM driver, else the JS driver.
- **The structural phase stays JS** (`runAgentStructuralPhase` — division/bonds mutate the holey store + ragged bonds; inherently serial graph mutations). Run it after the WASM force pass, exactly as the JS engine does. **Async agent application order** (sequential deposit) is naturally preserved (WASM is sequential). `gpuOwnsAttrs` bridge correctness is unchanged from PR5.
- Emit the `getAgentOffset` WASM emitter (the torus wrap as WASM ops reading `_fieldW`/`_fieldH`/`_fieldBoundaryTorus` from the WASM agent-loop signature) + `getCurvature`'s wrap.

**Acceptance test.**
1. `tsc -b` clean.
2. **JS↔WASM agent parity**: Boids / Tissue / Chemotaxis on `agentTarget='wasm'` match the JS-agent baseline (polarization curve, tissue count/bonds, chemotaxis bins) within tolerance.
3. **The user's example**: WebGPU grid + WASM async agents (a chemotaxis field model) runs end-to-end with 0 errors and a correct aggregation (bins match the JS-agent baseline within float-drift).
4. **Scale**: the 2000-boid benchmark on WASM beats the 174-steps/sec JS ceiling.
5. **Lattice byte-identity**: `compileAll` on the four baselines unchanged (the agent compiler is separate; the grid compilers are untouched).

**Risk/lockstep note.** The ABI mirror (`buildAgentLoopArgs` ↔ WASM signature) and the structural-phase-stays-JS decision are the load-bearing calls. Async is the natural agent mode (single-buffer SoA — write aliases read). The `getAgentOffset` WASM emit must match the JS wrap byte-for-behaviour.

---

### PR7 — Phase F-WebGPU: agent loop → WGSL (the all-GPU path)

**Goal.** Port `compileAgentGraph` to WGSL (`compileAgentGraphWebGPU`): the spatial hash + force integration + neighbour pass as compute shaders; the structural phase stays CPU (serial graph mutations). The 🟣 optimization: when grid AND agents are both WebGPU on ONE device, share the attrs buffer so the field bridge becomes zero-copy. Enable the WebGPU radio + the async-rejection gate.

**Files & symbols.**
- NEW `src/modeler/vpl/compiler/agentWebgpu/*` — `compileAgentGraphWebGPU`.
- `src/simulator/engine/sim.worker.ts`: `runAgentStep` dispatch (add `'webgpu'`); the agent GPU runtime (buffers/pipelines/readback); the same-device shared-attrs check for the zero-copy bridge (else fall back to the PR5 bridge).
- `src/model/centerBased.ts` (`agentTargetOf` — add `'webgpu'`).
- `src/modeler/panels/PropertiesPanelContent.tsx` (enable WebGPU radio + the UI gate).
- `src/modeler/vpl/nodes/nodeValidation.ts` (reject `agentTarget='webgpu'` ⊥ async-agent, mirroring the grid's async rejection — C-D4).

**The change (sketch).**
- `compileAgentGraphWebGPU`: spatial hash + force integration + neighbour pass as compute shaders. The **structural phase stays CPU** (division/bonds — read back agent state, mutate on CPU, re-upload; like a GPU particle system with CPU emission). The 🟣 ideal: grid + agents both WebGPU on one device → share the attrs buffer (zero-copy field access, no readback) — gate behind a same-device check, else the PR5 bridge.
- **Decisions to flag and resolve in the PR:** per-cell PCG vs shared xorshift (documented cross-target RNG divergence — same tradeoff as the grid); f32-only drift (no f64); the structural-phase CPU round-trip ordering; **deposit-conflict resolution (many agents → one cell)** — the CPU sequential semantics must become an atomic min/max/add on GPU (a real semantics decision — pick one and document it). **Async agent mode is REJECTED on WebGPU** (same as the grid's async rejection) — enforce at BOTH the UI gate and the `agentTargetOf` clamp.
- Emit the `getAgentOffset` WGSL emitter (the torus wrap in WGSL).

**Acceptance test.**
1. `tsc -b` clean.
2. **All-GPU parity**: Chemotaxis on `agentTarget='webgpu'` + WebGPU grid matches the CPU baselines statistically (not bit-exact — f32/PCG divergence is expected and documented).
3. **Scale**: 10k+ agents shows the GPU win over WASM.
4. **Async rejection (C-D4)**: `agentTarget='webgpu'` + async agents is rejected at the UI gate AND clamped by `agentTargetOf` on a hand-edited file.
5. **Lattice byte-identity**: the four baselines unchanged.

**Risk/lockstep note.** The deposit-conflict semantics is the genuine new decision (atomic on GPU vs sequential on CPU). Async-on-WebGPU rejection needs the two-layer enforcement. The structural-phase CPU round-trip is the same call as PR6.

---

## §3 — Cross-cutting gotchas

1. **The agent loop is JS-only until Phase F.** `compileAgentGraph` emits JS that's `eval`-ed in the worker ([sim.worker.ts:2360](../src/simulator/engine/sim.worker.ts)); there is NO `compileAgentGraphWasm`/`compileAgentGraphWebGPU` until PR6/PR7. So **any `agentTarget` other than `'js'` is a hard dependency on the port** — `agentTargetOf` clamps to `'js'` until each lands. The `getAgentOffset` WASM/WGSL emitters (PR1's node) are deferred to PR6/PR7 for exactly this reason.

2. **`buildDivisionParams` ↔ `buildDivisionArgs` AND `buildAgentLoopParams` ↔ `buildAgentLoopArgs` must mirror EXACTLY** (compile.ts [:2019](../src/modeler/vpl/compiler/compile.ts)/[:2038](../src/modeler/vpl/compiler/compile.ts) ↔ sim.worker.ts [:493](../src/simulator/engine/sim.worker.ts)/[:508](../src/simulator/engine/sim.worker.ts)). PR1 expands the division pair; PR6 mirrors the agent-loop pair into WASM. A desync silently passes the wrong values onto the next slot (same hazard class as `buildLoopArgs`↔`buildLoopParams`). The division-param expansion is also a pre-existing latent fix (`fieldGradient`/`getCurvature` were already division-unsafe).

3. **The torus wrap is one canonical block** — `if (delta > half) delta -= span; else if (delta < -half) delta += span`, reading `_fieldW`/`_fieldH`/`_fieldBoundaryTorus`. The engine uses it at 17 sites (all correct); the GRAPH primitive (`getAgentOffset`) and `getCurvature` are the two places it was missing. Any future graph node that subtracts two agent positions MUST route through `getAgentOffset` — keep `getAgentPosition` raw (it's an absolute position for field seeding).

4. **Do NOT unify the per-generation loops (PR5).** The JS/WASM loop ([:3090](../src/simulator/engine/sim.worker.ts)) is synchronous and must stay literally unchanged (byte-identity by construction). `ensureCpuAttrsFresh()` is `async`; the field bridge lives ONLY in the already-async WebGPU branch ([:3046](../src/simulator/engine/sim.worker.ts)). Two paths, never one.

5. **Bridge-need rule (PR5–PR7).** A per-step field bridge is needed iff grid attrs and the agent loop have **different memory residency** AND the model is a **field model**. Same residency (both CPU/`wasmMemory` views) → no bridge (shared bytes — the field arrays `readAttrs`, total-length, NOT the per-agent `attrRead`). No-field models never bridge (agents never touch `readAttrs`). Both-WebGPU-one-device → zero-copy shared buffer (PR7).

6. **`agentOverflow` is real and was silently dropped (PR2).** The worker posts it at 3 sites — [:772](../src/simulator/engine/sim.worker.ts) (division), [:3772](../src/simulator/engine/sim.worker.ts) (`seedAgents`), [:3784](../src/simulator/engine/sim.worker.ts) (`createAgent`); SimulatorView had no handler. Add it in PR2 — cluster/drag seed are precisely the overflow triggers. Division overflow REJECTS the whole division (never a half-rewired partner — the riskiest engine bug, already handled).

7. **The inspector is on-demand, never a fattened snapshot (PR3).** `snapshotAgentsForRender` deliberately omits `attrRead`/`bondCount`/`density` to keep the per-step transfer lean at 2000 agents. `getAgentState {id}` is one tiny round-trip per inspect click; live-refresh via a low-Hz poll, not per-`stepped`.

8. **Agent modes consume plain unmodified LMB; Shift/Ctrl/Alt still route to cell tooling.** The cell-sweep Shift+LMB branch ([:3579](../src/simulator/SimulatorView.tsx)) runs FIRST and `return`s — inject the agent-inspect claim INSIDE it (PR3), not as a sibling block. The `data-sim-overlay` panel keeps clicks off the canvas; `Paint Field` mode is the untouched escape hatch to the cell brush.

9. **Zero compiler touch for PR1–PR4.** PR1 adds an agent-graph-only node (never in a lattice graph); PR2–PR4 are simulator-UI + additive worker messages. The lattice baselines stay byte-identical by construction — but RUN `compileAll` on Game of Life / Gray-Scott / Life3D / snake at each PR's DoD anyway (don't assert it; prove it).

---

## §4 — What this milestone unblocks

- **PR1 (Get Agent Offset)** makes *any* wrap-correct neighbour-vector rule authorable — not just boids, but "steer toward leader," gradient-to-neighbour, chemotaxis-up-a-gradient, and the morphogenesis interaction forces — all of which were quietly wrong on a torus. It's the missing primitive the whole flocking/sensing class needs.
- **PR2–PR4 (the brush)** turn the agent simulator from a debug-poke tool into an authoring surface: paint typed, initialized tissue; cull regions; inspect per-agent state; hand-author seams. This is the on-ramp for users building agent models the way the cell brush is for lattice models.
- **PR5 (independent targets + the field bridge)** delivers "GPU diffusion + (JS) agents" — the common case — with NO agent-loop port, and builds the residency bridge PR6 reuses verbatim.
- **PR6 (Phase F-WASM)** lands the user's exact request (WebGPU grid + WASM async agents) and raises the agent-count ceiling past ~10k (the spatial hash already keeps the JS loop O(N) at 174 steps/sec for 2000 boids — the port raises the ceiling, it doesn't fix a bottleneck).
- **PR7 (Phase F-WebGPU)** is the all-GPU path (🟣) — both grid and agents on the GPU, the zero-copy shared-attrs field for same-device models, and the scale headroom for very large agent populations.

Nothing here forecloses Phase E (3D agents — the `gl3d.ts` instanced-sphere + bond-tube renderer reuses the 3D-grid camera/clip/instancing framework already shipped on `grid_3d`).

---

## §5 — Definition-of-done checklist

- [ ] **PR1** — `GetAgentOffsetNode.ts` (dX/dY/Distance, torus-shortest `target−self`, `requirements.bondGraph`); registry + `NEVER_INVARIANT` + `MULTI_OUTPUT_TYPES` wired; `getCurvature` partner offset wrapped; `buildDivisionParams`/`buildDivisionArgs` expanded so agent reads are division-safe; `gen-boids.mjs` rebuilt (offset-based cohesion/separation, `visibleCount:7`, `c`-edge dropped, single `FFORM2`); P→Q boundary case `dX≈+2`; polarization ~0.99; division-safe; **lattice byte-identical on 4 baselines**; docs (CLAUDE.md/README/HelpView/NODES_REFERENCE/SUMMARY html).
- [ ] **PR2** — `agentOverflow` handler added (toast); agent cursor (radius ring + hover highlight + staged-glue highlight, `difference` composite, on-change redraw); `agentSeedPoints` jittered-disc seed (NEW, not `brushShapeOffsets`); drag-to-seed (SEPARATE `pendingSeedPoints` + rAF token; `canvasAgentBrushActive` cleared on overlay-bail + pointer-up); kill radius (client-side id collection, no new message); `docs/MOCKUP_AGENTS_PHASE2.html`; lattice byte-identical.
- [ ] **PR3** — seed-config panel (Type + per-attr values, Manual-Brush-style, per-model persist); `seedAgents` extended with `sets` (worker post-init loop, not `initAgentSlot` signature); `getAgentState {id}` round-trip + `agentState` response (NOT snapshot fattening; low-Hz live refresh); inspector popover; Shift+LMB inspect injected INSIDE the `:3579` cell-sweep branch (falls through when `pickAgentAt<0`); lattice byte-identical; docs.
- [ ] **PR4** — `moveAgents` (writes x/y+xNext/yNext; RMB cancels mid-drag); bond-paint + `formBondBatch` (only if shipped); idempotent re-bond; marquee/type-filters deferred; lattice byte-identical.
- [ ] **PR5** — `CenterBasedConfig.agentTarget` + `agentTargetOf` (clamp-to-`'js'` safety net); Properties radio (WASM/WebGPU disabled); force-disable hacks removed; `pendingCanvasAttach` gated on `!agentModel` (agent+WebGPU stays on readback render); `agentUsesField` detected; field bridge added ONLY in the WebGPU branch (JS/WASM loop literally unchanged); `gpuOwnsAttrs` transition asserted; no-field models do 0 readbacks; GPU-grid+JS-agent Chemotaxis matches baseline; **lattice byte-identical from path-unchanged on all 3 grid targets**; `docs/MOCKUP_AGENTS_PHASE2.html`; docs.
- [ ] **PR6** — `compileAgentGraphWasm`; `runAgentStep` dispatch on `agentTargetOf`; ABI mirror (`buildAgentLoopArgs` ↔ WASM); structural phase stays JS; `getAgentOffset` WASM emit; WASM radio enabled; JS↔WASM agent parity (Boids/Tissue/Chemotaxis); the user's example (WebGPU grid + WASM async agents) runs 0-error; 2000-boid WASM beats 174 steps/sec; lattice byte-identical.
- [ ] **PR7** — `compileAgentGraphWebGPU` (hash + force + neighbour as compute; structural phase CPU); same-device zero-copy attrs bridge (else PR5 bridge); deposit-conflict atomic semantics decided + documented; `agentTarget='webgpu'` ⊥ async enforced at UI gate + `agentTargetOf` clamp; `getAgentOffset` WGSL emit; all-GPU Chemotaxis statistically matches; 10k-agent scale win; lattice byte-identical.
- [ ] **Global** — `npx tsc -b` clean at every commit; every lattice baseline byte-identical across all 3 grid targets before/after each PR; documentation lockstep (CLAUDE.md + HelpView + README + NODES_REFERENCE for the new node + the `agentTarget` field + the brush) updated atomically with the code; on the `agents_floating_cells` branch; no push, no Co-Authored-By; HTML mockups for PR2/PR3 + PR5 per the CLAUDE.md UI/behaviour-change rule.

---

### TL;DR

Three independent workstreams, ordered by value/independence. **PR1 (torus fix)** is small, high-value, self-contained — DO FIRST: add **Get Agent Offset** (torus-shortest `target−self` + Distance), wrap `getCurvature`'s raw partner subtraction, **expand `buildDivisionParams`/`buildDivisionArgs`** so any agent read is division-safe (the blocker the dossier missed), and rebuild `gen-boids.mjs` to sum offsets not positions (`visibleCount:7`, drop the `c`-edge, one `FFORM2`). **PR2–PR4 (the agent brush)** bring it to cell-brush parity: cursor + radius/cluster/drag seed + kill radius + the `agentOverflow` handler (PR2), seed-config + on-demand `getAgentState` inspector (PR3), move + bond-paint (PR4, NICE). **PR5–PR7 (independent targets)**: add `agentTarget` + drop the force-disable hack + the GPU-grid↔CPU-agent field bridge added ONLY in the WebGPU branch (never a unified async helper) with JS/WASM left literally unchanged (PR5), then the Phase-F WASM (PR6, unblocks the user's WebGPU-grid + WASM-async-agents example) and WebGPU (PR7, all-GPU) agent-loop ports. PR1–PR4 touch zero compilers (lattice byte-identical by construction); PR5 proves it from "path unchanged," not "flags false." Every adversarial correction (division-param scope, the broken boids expression, the async-loop unification, WebGPU-direct-render vs. overlay, the silent `agentOverflow` drop, `brushShapeOffsets` ≠ jittered disc, the shared rAF token, the Shift+LMB handler ordering) is folded in, not left open.
