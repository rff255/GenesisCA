# MASTER HANDOFF — Lattice GPU Render & Residency

**Audience**: the ORCHESTRATOR session (coordinates everything) and each
PHASE session (a fresh Opus session executing exactly one phase).
This file is the single source of truth for sequence, protocol, and status.

**Mission**: make the CA grid as fast as the hardware allows **for whatever the
user models** — 2D and 3D, JS / WASM / WebGPU — while (1) every existing feature
keeps working (a feature may cost a readback while actively used, never lose
function) and (2) every gate keys on GENERAL model properties (dimension, depth,
resolved target, topology, glyph usage, SIE flag, boundary, compiler usage
flags) — never on a specific model's shape.

Design authority: [IMPACT_MAP_LATTICE_GPU.md](IMPACT_MAP_LATTICE_GPU.md) +
[PLAN_LATTICE_GPU.md](PLAN_LATTICE_GPU.md) (+ `.html`).
Measurements: [PERF_REVIEW_LATTICE.md](PERF_REVIEW_LATTICE.md).
Architectural precedent (READ IT — this project is its lattice twin):
[HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md).

---

## 0. Invariants — EVERY phase session obeys these (no exceptions)

1. **Git**: work on branch `optimize`, linear history, one commit per milestone
   with a descriptive message, staging **EXPLICIT paths** (never `git add -A`).
   **NEVER push. NEVER add Co-Authored-By or any Claude/Anthropic attribution.
   NEVER bump the version.** PowerShell 5.1 gotcha: no double-quote characters
   inside `git commit -m @'…'@` here-strings; keep messages quote-free (or use a
   message file).
2. **Scope discipline**: implement YOUR phase only. If an assumption in your
   handoff proves false, **STOP**, write what you found in your phase doc's
   Completion Report, and end — the orchestrator re-plans. Do not redesign.
3. **First principles**: no gate, emitter, or fast path may test for a specific
   model / rule shape / node count. Only general properties.
4. **Feature preservation**: the readback policy (`free` / `frame` / one-shot)
   is the ONLY sanctioned mechanism for removing per-frame CPU work. The
   one-shot rule lives in ONE place (the worker message dispatcher). No feature
   may ever observe stale grid state.
5. **Verification gates before any commit** (run all that apply):
   - `npx tsc -p tsconfig.app.json --noEmit` and `npm run build`
   - **Compilers touched? → `node scripts/check-compile-identity.mjs` baseline
     discipline is MANDATORY** (capture on the pre-change commit via git stash,
     compare after; only justified diffs). L1/L2/L5/L6 must be **all-unchanged**.
   - Agent code adjacent? → `node scripts/parity-agent-wasm.mjs` +
     `node scripts/parity-agent-force.mjs`
   - Sparse stepping touched? → `node scripts/verify-sparse-stepping.mjs --wasm`
   - Perf claims → `node scripts/bench-lattice.mjs` numbers in the commit message
   - **REAL-UI in-browser verification is mandatory** (the project rule: never
     conclude "works" from module-level calls alone). Recipes in §3.
6. **Docs consistency in the same phase**: update CLAUDE.md (the feature's
   section), `src/help/HelpView.tsx` where user-visible, README if warranted,
   AND this master's Status Board + your phase doc's Completion Report. A phase
   without its report is NOT done.
7. **Known traps** — the agent arc's §0.7 list applies **verbatim** to this
   project; re-read it in [HANDOFF_GPU_AGENT_RENDER.md](HANDOFF_GPU_AGENT_RENDER.md) §0.
   The ones that bite hardest here:
   - `sim.worker.ts` contains mojibake comment bytes — anchor `Edit` old_strings
     on clean ASCII **code** lines, never comment lines.
   - Any new async batch loop in the worker MUST set/clear
     `asyncStepBatchInFlight` (message deferral) — concurrent batches were the
     P0 corruption bug.
   - `device.lost` fires with reason `destroyed` on OUR OWN teardown — never
     report that as an error.
   - Never list the same ArrayBuffer twice in a postMessage transfer list.
   - A canvas whose control was transferred has NO 2D context — never
     `putImageData` / resize it from the main thread.
   - The Browser-pane tab reports **hidden** → the sim auto-pauses Play; drive
     the worker directly and never trust rAF/screenshots while occluded.
   - Never size a per-thread WGSL array by a population/grid count
     (private-memory zero-init collapse — the `AGENT_GPU_ARRAY_CAP` lesson).
   - WGSL constant-folding rejects non-representable f32 literals (a NaN bitcast
     fails at `createShaderModule`) — sentinels must be real f32s.
   - Branch scope: diff/count against **`origin/master`**, NEVER the local
     `master` ref (stale in this repo).
   - **Always acquire the GPU device through
     [sharedGpuDevice.ts](../src/simulator/engine/sharedGpuDevice.ts)** and
     release on every teardown path — never `requestAdapter` a second device.
     The adapter-request counter must stay at 1 across rebuilds.
   - **New lattice traps found by this review** (do not rediscover):
     - `tryInstantiateWasmModule` resolves a **promise** — a `step` posted in the
       same turn as `init` silently runs the JS fallback. Any harness or probe
       must yield a macrotask between them.
     - The `colorPass` message runs its body in an **async IIFE**, so a
       synchronous timer around `post()` measures nothing.
     - `skipIsolatedEmpty` must reach the **compile** as well as the init message
       — `sparseSteppingEnabled` drives the emitted loop AND the baked layout;
       overriding only one side is a silent offset desync.
     - `colors` is a **view over `wasmMemory`** at a baked offset. It cannot be
       transferred, reassigned, or double-buffered. Copy into it, never replace it.
   - **Found by L1** (see its Completion Report for the full write-ups):
     - **Capture the identity baseline with `git stash`, and capture it TWICE.**
       L1's first pre-change capture produced an Accretor variant that three
       later captures never reproduced — a phantom "you broke the compiler".
       Compare two captures of the SAME tree before trusting any DIFF.
     - **Never hand-post a message a main-thread driver also owns** (e.g.
       `setGridUiSync` / `setAgentUiSync`): the driver's mirror ref then
       disagrees with the worker and the next real UI action looks broken.
     - **Per-frame latency measured in an occluded pane is unusable above
       ~10 ms** (a control experiment produced a strictly-cheaper configuration
       measuring 14× slower). Use interleaved A/B; never quote an absolute.
     - **A large-grid runtime rebuild can exceed a 30 s eval timeout**
       (`seedRngState` alone builds a 108 MB array at 27M cells) — bound every
       probe issued around a Recompile with `performance.now()`.
     - **A backtick inside a WGSL comment terminates the TS template literal**
       holding the shader.

## 1. Phase sequence + dependency graph

```
L1 (3D WGSL voxel render, worker-side)      ← READY, fully specified
  └→ L3 (sparse stepping on WebGPU)         [refine after L1]
L2 (pipelined step batches)                 ← READY (opens with a re-measure gate)
L5 (instData sized by visible cells)        ← tiny, independent
L6 (widen GPU indicator reductions)         [refine]
L4 (inline neighbours on CPU targets)       [refine — A/B-gated, may be cancelled]
```

Launch order: **L1 → L2 → L5 → L3 → L6 → L4**.
"[refine]" = the orchestrator expands that phase's handoff using the completed
prior phases' Completion Reports before launching it.

## 2. Phase handoff documents

- **L1**: [HANDOFF_LATTICE_GPU_L1.md](HANDOFF_LATTICE_GPU_L1.md) — complete, execute as written.
- **L2**: [HANDOFF_LATTICE_GPU_L2.md](HANDOFF_LATTICE_GPU_L2.md) — complete, execute as written
  (note its mandatory measure-first gate: the phase may legitimately end in
  "cancelled, documented").
- **L3 / L4 / L5 / L6**: seeded in [PLAN_LATTICE_GPU.md](PLAN_LATTICE_GPU.md).
  The orchestrator writes `HANDOFF_LATTICE_GPU_<phase>.md` for each before
  launch (same template as L1: objective / gate / exact work items with
  file:line anchors / do-not-touch list / verification checklist / Completion
  Report skeleton).

## 3. Session protocol (for every phase session)

**Boot (read ONLY this — context discipline):**
1. This master's §0 Invariants + §3 + your phase row in §4.
2. Your phase handoff doc, top to bottom.
3. The IMPACT MAP + PLAN sections your handoff points at.
4. The CLAUDE.md sections your handoff lists (not the whole file).

**Work loop**: implement the work items in order → run the §0.5 gates →
in-browser verification per your handoff's checklist → docs (§0.6) → commit →
fill your Completion Report → update the Status Board row → end.

**Measurement tooling**
- `node scripts/bench-lattice.mjs` — the per-phase lattice profiler (real
  `sim.worker.ts` + real WASM; `ONLY=gol,life3d` / `MODELS=` env filters). Rerun
  after any change and put the numbers in the commit message.
- `node scripts/bench-agent-engine.mjs` — the agent sibling (only if you touch
  agent-adjacent code).

**In-browser recipes** (dev server via `preview_start` on `.claude/launch.json`'s
`dev` config; the pane reports `document.hidden`, so drive the worker directly):
- **Load a model, optionally patched**: fetch the `.gcaproj`, mutate the JSON
  (e.g. `properties.gridWidth/gridDepth/useWebGPU/useWasm/skipIsolatedEmpty`),
  wrap it in a `File`, inject via the FileMenu `<input type=file accept=".gcaproj">`
  (DataTransfer + a `change` event) after stubbing `window.confirm/alert/prompt`.
  This is the REAL load path and needs no repo file. If the input is missing,
  click the `File ▾` button first.
- **Drive steps**: `window.__simWorker.postMessage({type:'step', count:N,
  activeViewer:<A→C mapping id>, skipColorPass:true|false})` and resolve on the
  next `stepped`. **`count: 0` is the fixed-cost probe** — the batch loop runs
  zero generations but still does the colour pass + finalize + `sendColors`, so
  `count:0` vs `count:1` vs `count:N` decomposes fixed vs marginal exactly.
- **Detect the render path**: `stepped.colors` present ⇒ the colours crossed the
  wire (readback path); absent ⇒ direct render owns the display.
- **Main-thread cost**: wrap `worker.onmessage` and time the `stepped` branch.
- **Resize**: the Grid Dimensions W/H(/D) fields + the `Resize` button respond to
  a native-setter `input`+`change` and `.click()`.
- **Never** trust composited pixels or `readPixels` on a default framebuffer
  while occluded. Prove GPU work via `getCompilationInfo`, buffer readbacks
  (`copyBufferToBuffer` + `mapAsync`), worker protocol, and `pushErrorScope`.
  Pixel/visual claims are deferred to an orchestrator/user spot-check in a
  **visible** pane — say so explicitly in the Completion Report.

**Completion Report skeleton** (append to your phase doc):
`## Completion Report (<date>)` — commits; what changed vs the spec (deviations
+ why); measured numbers (before/after from `bench-lattice.mjs` and the browser
probes); new gotchas discovered; what the next phase must know.

## 4. STATUS BOARD (the orchestrator + each session keep this current)

| Phase | Status | Session/commits | Notes |
|---|---|---|---|
| **Planning** | **DONE** | `optimize` (this session) | Built `scripts/bench-lattice.mjs` (drives the REAL worker with a `self` shim + a WASM-engaged assertion). Measured CPU targets across 8 models × 2–3 sizes and the WebGPU path in-browser on NVIDIA Pascal. Headline: a 3D WebGPU grid spends 15–320× more time on the render round trip than on the simulation (Accretor 300³ = 2.35 ms sim inside a 758 ms frame); 2D WebGPU pays a flat ~7 ms per-batch fence; CPU targets reserve 128–693 MB neighbour tables with 0.45–2.0 s init; SIE is worth 13.8× but is CPU-only. Docs: PERF_REVIEW_LATTICE.md, IMPACT_MAP_LATTICE_GPU.md, PLAN_LATTICE_GPU.md(+.html), this master, L1 + L2 handoffs. |
| **L1 3D WGSL voxel render** | **DONE** | `optimize` — "perf(lattice): L1 worker-side WGSL voxel render for 3D WebGPU grids" | Compaction (alpha + buried cull) → indirect instanced cubes, presented from the worker into a canvas layered under gl3d; gl3d renders overlays only in free mode. **Accretor 300³: 753 → 123 ms/worker frame (≈6.2×), fixed cost 860 → 8.7 ms**, plus the main-thread rescan + 103 MB/frame gone. Zero compiler changes (identity: 25 models unchanged). Shadows/AO/alpha blend are frame-mode features. Report + deviations + new gotchas: [HANDOFF_LATTICE_GPU_L1.md](HANDOFF_LATTICE_GPU_L1.md) §8. **Post-ship regression fixed (2026-07-24, §9)**: the present was hooked ONLY to the colour pass, which `skipColorPass` (∞ G/F) switches off → free mode presented nothing and the volume froze at generation 0 ("the canvas turns black"); and passive hover pinned frame mode so there was no speedup with the cursor on the canvas. Now: refresh+present once per BATCH whenever the voxel canvas is live, the ∞ G/F fast path still runs the (cheap) free-mode `draw()` so the canvas is actually shown, and the pointer term is narrowed to gesture / Inspect-armed / Shift-held. **Post-ship regression #2 fixed (2026-07-24, §10) — free mode never displayed ANYTHING**: the `VoxelView` uniform's byte layout drifted from `uploadVoxelView` (a `vec3<f32>` is align 16 but SIZE 12, so the shader's `ambient` sat at byte 124 while the writer wrote from 128) — the shader read `cubeScale` out of the specular slot, which is 0 by default, so every cube collapsed to a zero-size point and the pass rasterised nothing. Invisible to every probe because `bg`'s vec4 alignment re-syncs the layout, so the compaction (the only thing a GPU-buffer readback sees) stayed correct. Fix = `@align(16) ambient`. **Screenshot-verified in the real app** (structure visible + growing while playing; hiding gl3d leaves it on screen; seamless pause handoff; Life3D 96³ WebGPU; 2D-WebGPU and 3D-WASM unchanged). New computed harness [scripts/verify-render-uniform-layouts.mjs](../scripts/verify-render-uniform-layouts.mjs) (WGSL struct ⇄ TypedArray writer, negative-controlled) + a B10 block in `verify-agent-render.mjs`. **Still needs a visible-pane eyeball for lighting parity vs gl3d.** |
| L2 pipelined step batches | READY — not started (opens with a measure-first gate) | — | [HANDOFF_LATTICE_GPU_L2.md](HANDOFF_LATTICE_GPU_L2.md) |
| L5 instData sizing | not started | — | tiny; fold into a session with room |
| L3 sparse stepping on WebGPU | blocked on L1 refinement | — | design in PLAN §L3 |
| L6 GPU indicator reductions | not started | — | design in PLAN §L6 |
| L4 inline neighbours (CPU) | blocked on refinement — **value unproven** | — | design in PLAN §L4; opens with an A/B that may cancel the phase |

## 5. Orchestrator duties

1. Launch one phase session at a time (fresh session; boot prompt below). Never
   two sessions touching the same files concurrently. **And never `git add -A`
   while a phase session is in flight** — stage EXPLICIT paths only.
2. On completion: read the Completion Report, spot-check the gates yourself
   (rerun `bench-lattice.mjs` + one in-browser probe), review the diff
   (`git diff <prev>..HEAD --stat` + read the risky hunks), and only then mark
   the Status Board row done.
3. Refine the next phase's handoff with what the report taught.
4. Keep the user informed per phase: what shipped, measured numbers, what's
   next. The user handles all pushes/releases.
5. **Surface to the user** (from the planning session, not a code change): the
   shipped `Accretor.gcaproj` has `skipIsolatedEmpty.enabled = false` while its
   own `ruleDescription` says the feature is ON — see PERF_REVIEW §6.

**Boot prompt template** (fill `<PHASE>`; paste as the session's task):
> Work in C:\- Genesis\GenesisCA on branch `optimize`. You are executing phase
> `<PHASE>` of the Lattice GPU Render & Residency project. Read
> docs/HANDOFF_LATTICE_GPU.md sections 0, 3 and your row in 4, then
> docs/HANDOFF_LATTICE_GPU_<PHASE>.md in full, then the impact-map/plan sections
> it references. Execute exactly that phase: implement, verify every gate
> (including real-UI in-browser checks), update the docs it lists, commit on
> `optimize` staging explicit paths (never push, no co-author, no version bump),
> fill in your Completion Report, update the master Status Board, and stop. If
> any stated assumption is false, stop and record findings instead of
> redesigning.
