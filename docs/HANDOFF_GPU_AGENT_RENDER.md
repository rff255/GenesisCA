# MASTER HANDOFF — GPU-Resident Agent Render & Residency Widening

**Audience**: the ORCHESTRATOR session (coordinates everything) and each
PHASE session (a fresh Opus 4.8 session executing exactly one phase).
This file is the single source of truth for sequence, protocol, and status.

**Mission**: make GPU-resident execution + GPU-side rendering the normal mode
for WebGPU agent models — SandboxScience-class throughput (50k+ agents at
display rate, real-time interaction) — while (1) every existing feature keeps
working (features may cost a readback while actively used, never lose
function) and (2) every gate/optimization keys on GENERAL model properties
(topology, target, capability/usage flags) — never on a specific model's
shape. Design authority: [IMPACT_MAP_GPU_AGENT_RENDER.md](IMPACT_MAP_GPU_AGENT_RENDER.md)
+ [PLAN_GPU_AGENT_RENDER.md](PLAN_GPU_AGENT_RENDER.md) (+ `.html`), background:
[COMPARISON_SANDBOX_SCIENCE_PL.md](COMPARISON_SANDBOX_SCIENCE_PL.md),
[PERF_REVIEW_AGENT_ENGINE.md](PERF_REVIEW_AGENT_ENGINE.md).

---

## 0. Invariants — EVERY phase session obeys these (no exceptions)

1. **Git**: work on branch `optimize`, linear history, one commit per
   milestone with a descriptive message. **NEVER push. NEVER add
   Co-Authored-By or any Claude attribution. NEVER bump the version.**
   PowerShell 5.1 gotcha: no double-quote characters inside `git commit -m
   @'…'@` here-strings (argument mangling); keep messages quote-free.
2. **Scope discipline**: implement YOUR phase only. If an assumption in your
   handoff proves false, STOP, write what you found in your phase doc's
   Completion Report, and end — the orchestrator re-plans. Do not redesign.
3. **First principles**: no gate, emitter, or fast path may test for a
   specific model/rule shape. Only general properties (`topologyMode`,
   resolved agent target, `agentResidentEligible`, usage flags, sprite/
   metaball presence, dims).
4. **Feature preservation**: the readback policy (`free` / `frame` /
   one-shot) is the ONLY sanctioned mechanism for removing per-frame CPU
   work. The one-shot rule lives in ONE place (the worker message
   dispatcher). No feature may ever observe stale agent state.
5. **Verification gates before any commit** (run all that apply):
   - `npx tsc -p tsconfig.app.json --noEmit` and `npm run build`
   - `node scripts/parity-agent-wasm.mjs` (JS↔WASM bit-parity, all entries)
   - `node scripts/parity-agent-force.mjs` (force-pass combos)
   - Compilers touched? → `node scripts/check-compile-identity.mjs`
     baseline discipline (capture on the pre-change commit via git stash,
     compare after; only justified diffs).
   - Perf claims → `node scripts/bench-agent-engine.mjs` numbers in the
     commit message.
   - **REAL-UI in-browser verification is mandatory** (the project rule:
     never conclude "works" from module-level calls alone). Recipes in §3.
6. **Docs consistency in the same phase**: update CLAUDE.md (the feature's
   section), `src/help/HelpView.tsx` where user-visible, README if
   warranted, AND this master's Status Board + your phase doc's Completion
   Report. A phase without its report is NOT done.
7. **Known traps** (all previously hit — do not rediscover them):
   - `sim.worker.ts` contains mojibake comment bytes — anchor Edit
     old_strings on clean ASCII CODE lines, never comment lines.
   - Any new async batch loop in the worker MUST set/clear
     `asyncStepBatchInFlight` (message deferral) — concurrent batches were
     the P0 corruption bug.
   - `device.lost` fires with reason `destroyed` on OUR OWN teardown —
     never report that as an error.
   - Never list the same ArrayBuffer twice in a postMessage transfer list
     (shared length-0 placeholders → DataCloneError).
   - A canvas whose control was transferred has NO 2D context — never
     `putImageData`/resize it from the main thread; the grid direct-render
     comments (SimulatorView.tsx ~:2411) document the discipline.
   - The Browser-pane tab reports hidden → the sim auto-pauses Play; drive
     the worker directly (`window.__simWorker.postMessage({type:'step',
     count:N})`) and never trust rAF/screenshots while occluded — verify
     via canvas pixel reads, worker messages, and DOM probes.
   - Never size a per-thread WGSL array by maxAgents (private-memory
     zero-init collapse — cap pattern `AGENT_GPU_ARRAY_CAP`).
   - WGSL constant-folding rejects non-representable f32 literals (a NaN
     bitcast fails at createShaderModule) — sentinels must be real f32s.

## 1. Phase sequence + dependency graph

```
A1 (resident direct render, 2D agents-only)   ← READY, fully specified
  └→ A2 (same renderer, snapshot-fed: JS/WASM + per-gen GPU)  ← READY
  └→ C  (3D free-mode WGSL sphere render; gl3d keeps frame mode)  [refine first]
B1 (bin-sorted mirror — engine force pass)     ← READY (independent of A)
  └→ B2 (compiler: fused gather over sorted runs)             [refine first]
D (field-decoupled grid+agents residency + two-canvas composite) [refine first]
  └→ E (unified GPUDevice — resident field bridge, one canvas) [refine after D]
F (eligibility widening: sync attrs / springs+growth / positional-as-GPU /
   spawn polling / stop readback / atomic indicators / structural
   request-polling — each its own mini-milestone)              [refine per item]
```
Launch order: **A1 → A2 → B1 → B2 → C → D → E → F** (F items may interleave
after B1). "[refine first]" = the orchestrator expands that phase's handoff
using the completed prior phases' Completion Reports before launching it.

## 2. Phase handoff documents

- **A1**: [HANDOFF_GPU_AGENT_RENDER_A1.md](HANDOFF_GPU_AGENT_RENDER_A1.md) — complete, execute as written.
- **A2 + B1 + B2**: [HANDOFF_GPU_AGENT_RENDER_A2_B.md](HANDOFF_GPU_AGENT_RENDER_A2_B.md) — A2/B1 complete; B2 has its design + an explicit refine step.
- **C, D, E, F**: seeded in [PLAN_GPU_AGENT_RENDER.md](PLAN_GPU_AGENT_RENDER.md) § Extension roadmap.
  The orchestrator writes `HANDOFF_GPU_AGENT_RENDER_<phase>.md` for each
  before launch (same template as A1: objective / exact work items with
  file:line anchors / verification checklist / do-not-touch list /
  Completion Report skeleton).

## 3. Session protocol (for every phase session)

**Boot (read ONLY this — context discipline):**
1. This master's §0 Invariants + §3 + your phase row in §4.
2. Your phase handoff doc, top to bottom.
3. The IMPACT MAP + PLAN sections your handoff points at.
4. The CLAUDE.md sections your handoff lists (not the whole file).

**Work loop**: implement the work items in order → run the §0.5 gates →
in-browser verification per your handoff's checklist → docs (§0.6) →
commit → fill your Completion Report → update the Status Board row → end.

**In-browser recipes** (dev server `npm run dev`, drive via the preview):
- Load a model: fetch the `.gcaproj`, inject via the FileMenu
  `<input type=file>` (DataTransfer + `change`), after stubbing
  `window.confirm/alert`.
- Drive steps: `window.__simWorker.postMessage({type:'step',count:N})`;
  capture `stepped`/`error` via an added listener. Flip UI state through
  REAL clicks on the actual buttons/radios (they respond to `.click()`).
- Read pixels from a DISPLAY canvas via `drawImage` to a scratch +
  `getImageData` on the scratch (never `getImageData` a live canvas).
- Boids flocking metric: polarization = |Σv|/Σ|v| over ~200 steps
  (expect >0.99 from a cold start; ~0.03-0.45 = broken).

**Completion Report skeleton** (append to your phase doc):
`## Completion Report (<date>)` — commits; what changed vs the spec
(deviations + why); measured numbers; new gotchas discovered; anything the
next phase must know.

## 4. STATUS BOARD (the orchestrator + each session keep this current)

| Phase | Status | Session/commits | Notes |
|---|---|---|---|
| A1 resident direct render | **DONE + ORCHESTRATOR-REVIEWED** | `optimize` 3bdd5f4 | render pipeline + readback policy + one-shot rule + gate/attach/UI-sync/glow; session verified (Boids direct render, flocking 0.9991, staleness probes) + orchestrator re-ran gates, audited the diff surface (no compilers/gl3d/engine), and independently confirmed the CPU fallback path + mutation/one-shot correctness on an OM model. Composited pixels USER-CONFIRMED (Boids visible on the WebGPU target in the real app, 2026-07-22) — A1 fully closed. |
| A1.5 GPU agent-OM colour pass | READY — handoff written ([HANDOFF_GPU_AGENT_RENDER_A15.md](HANDOFF_GPU_AGENT_RENDER_A15.md)); launch after B1 lands (both touch agentWebgpuRuntime.ts) | — | The A1 OM-exclusion gate term (`agentMappings.length === 0`, SimulatorView:3995) is CORRECT but excludes OM-coloured models — incl. Particle Life itself — from the resident fast path (OM colours are CPU-computed into `s.colors`; the render reads GPU `agentColors`). Remedy: compile agent OM graphs into a per-agent GPU colour pass writing `agentColors` (the agentWebgpu emitters already exist — behaviour setCellLooks does exactly this), active-viewer switch re-dispatches it. Compiler-touching → full identity/parity discipline. NB A2 covers OM models on CPU targets for free (the snapshot already carries OM colours). |
| A2 snapshot-fed renderer | **DONE** (session-verified) | `optimize` (this session) | Render-only surface (`createAgentRenderOnlyRuntime` + tight `uploadAgentRenderFields`) for CPU (JS/WASM) targets; gate widened (dropped webgpu-target + OM-exclusion terms). Session-verified in-browser: Particle Life on WASM+OM ENGAGES (6 OM species colours in `s.colors`), Boids on JS ENGAGES (flocks 0.998), free mode ships 0 snapshot + liveCount at 50k, fallbacks (3D/grid+agents/sprites) keep CPU path, 0 errors. Handler-ms ~12 ms sync-vs-free delta at 50k is INDICATIVE (hidden-pane 0-px canvas makes the real draw a no-op — needs a visible pane, like A1). Re-attach storm while occluded is PRE-EXISTING A1 SHARED behaviour (Boids-webgpu storms identically), not an A2 regression. `git diff --stat` = the same 3 files (no compilers/gl3d/engine). Completion Report in the A2_B doc. **ORCHESTRATOR-REVIEWED**: gates re-run green, diff audited (same 3 files), PL-on-WASM free mode + liveCount independently confirmed in-browser. **Re-attach storm HOTFIXED by the orchestrator** (shared A1/A2: `max(1,0)` attach dims vs raw 0×0 occluded parent → re-attach per draw; real risk = Overseer stepping in a hidden tab): draw() re-attaches only on a REAL size change (`parentW/H >= 2`) — verified 0 attach posts during occluded stepping. User eyeball found a REGRESSION (black at load until Play/interaction — the initial state used to show); orchestrator root-caused + hotfixed: the ack-time draw() blitted the attach present (made with a NULL camera → zero uniform → black), the camera-triggered present then landed in the placeholder but NOTHING re-blitted until the next stepped. Fix = (a) `postAgentCamera` re-blits via double-rAF after the post (the grid compositor-lag trick), (b) the worker's `setAgentCamera` presents FromStore when the store is fresh (raw when residency-stale — a stale upload would clobber GPU truth). LESSON for C/D/E: every present-only path needs a main-thread re-blit follow-up, and the FIRST present after attach must not be the only upload. Awaiting user re-confirmation of load-shows-initial-state. |
| B1 sorted mirror (force pass) | ready (independent) | — | handoff complete |
| B2 fused gather (compiler) | blocked on B1 | — | design in A2_B doc; refine before launch |
| C 3D sphere render | blocked on A1 | — | refine before launch |
| D field-decoupled grid+agents | after A2 | — | refine before launch |
| E unified device | after D | — | refine after D's report |
| F eligibility widening | after B1 (items independent) | — | one mini-handoff per item |

## 5. Orchestrator duties

1. Launch one phase session at a time (fresh Opus 4.8 session; boot prompt
   below). Never two sessions touching the same files concurrently.
2. On completion: read the Completion Report, spot-check the gates yourself
   (rerun parity + one in-browser probe), review the diff
   (`git diff <prev>..HEAD --stat` + read the risky hunks), and only then
   mark the Status Board row done.
3. Refine the next phase's handoff with what the report taught.
4. Keep the user informed per phase: what shipped, measured numbers, what's
   next. The user handles all pushes/releases.

**Boot prompt template** (fill `<PHASE>`; paste as the session's task):
> Work in C:\- Genesis\GenesisCA on branch `optimize`. You are executing
> phase `<PHASE>` of the GPU-Resident Agent Render project. Read
> docs/HANDOFF_GPU_AGENT_RENDER.md sections 0, 3 and your row in 4, then
> docs/HANDOFF_GPU_AGENT_RENDER_<PHASE>.md in full, then the impact-map/plan
> sections it references. Execute exactly that phase: implement, verify
> every gate (including real-UI in-browser checks), update the docs it
> lists, commit on `optimize` (never push, no co-author, no version bump),
> fill in your Completion Report, update the master Status Board, and stop.
> If any stated assumption is false, stop and record findings instead of
> redesigning.
