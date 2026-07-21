# PLAN — Particle Life (sample + matrix-play UX + enabling features)

**Goal:** make GenesisCA simulate [Sandbox Science Particle Life](https://sandbox-science.com/particle-life)
(2D **and** 3D) as shipped library samples, and make "playing with the interaction
matrices" first-class: signed seeded randomization, named matrix generators, and a
drag-to-adjust diverging-color matrix widget.

**Ground truth (their source, `SandboxScience-master`):**
- Per-pair interaction = THREE K×K matrices (`rulesMatrix` ∈ [-1,1], `minRadiusMatrix`,
  `maxRadiusMatrix`), asymmetric, all editable with the same drag-matrix UI
  (`RulesMatrix.vue` / `MinMatrix.vue` / `MaxMatrix.vue`).
- Force law (`particleComputeForces.wgsl`): for neighbour at distance `d` with pair
  values `(rule, minR, maxR)`:
  - `d < minR` → `force = repel · (d/minR − 1)` (always repulsive, rule-independent)
  - `minR ≤ d < maxR` → `mid = (minR+maxR)/2; force = rule − (rule/(mid−minR))·|d−mid|`
    (tent peaking at `mid`, zero at both ends)
  - accumulate `F += force · r̂` (torus-folded when wrapping).
- Integration (`particleAdvance.wgsl`): `v += F · forceFactor · dt·60` (forces pass),
  then `v *= pow(1−friction, dt·60)`, `x += v·dt`. Wall modes: repel(bounce)/wrap/none.
- Spatial hash bin size tracks the live max of the maxRadius matrix (`currentMaxRadius`).
- Matrix UI: diverging cell colors (dark neutral → cyan attract / red repel, |v| =
  saturation), horizontal drag-on-cell ±0.01/px (Pointer Lock), hover value tooltip,
  click select + Ctrl multi-select, a slider editing the selection (or ALL cells),
  species color swatches as headers, named generators (random / symmetric / snake /
  chains×3 / rock-paper-scissors / bipartite / hub-and-spokes / concentric shells).
- Defaults: 6000 particles, 7 colors, friction 0.3, minR rand ∈ [30,60], maxR ∈ [90,150].

**GenesisCA mapping (verified):** agents-only model, species = agent tag attribute,
three 2-axis float `lookupTable` model attributes, Get Nearby Agents (self-excluded,
radius wired) → For Each → Get Agent Offset (torus-shortest dX/dY[/dZ] + Distance) →
3× Table Lookup → Expression tent (FN set has `abs/min/max`; `/` is ÷0→0 guarded) →
valueSwitch piecewise → Apply Force. Friction in-graph (Get Velocity → `v·f` →
Set Velocity, `f` a bounded model attr = sim-side slider) with engine `momentum: 1.0`
(engine then does `v += (Δt/η)·F_graph` — same integrator family as theirs).
Spawn: Agent Init → Loop (Count **wired** from a Get Model Attribute `N`) →
Create Agent(rand·W, rand·H) → Set Agent Attribute(handle, species, rand 0..K−1) →
Add Agent To World. Rendering: linked Agent Output Mapping (species → categorical).
`modelAttrs` + `_lookupTables` are already in every agent ABI (agentAbi.ts:216/232);
`lookupInteraction` is in both agent WASM/WebGPU allowlists.

---

## Phases (each = one commit, each gated on the verification listed)

Baseline: `check-compile-identity --capture` snapshot taken pre-change (23 models) →
`scratchpad/identity-baseline-pl.json`. **Every phase re-runs `--compare` and must be
green** (none of Phases 1–7 touches compiler emit for existing models).

### Phase 2 — signed/ranged random table fill (the one functional blocker)
`randomFillTableData` (variegation.ts:359) fills floats in [0,1) sparse-by-density;
Particle Life needs dense uniform **[-1,1)** rules + radii within a user range.
- `TableFillPolicy` += optional `min?/max?` (float mode: non-zero entries drawn
  uniform in [min,max) — absent ⇒ the exact old (0,1) draw, **byte-identical**;
  density semantics unchanged, density 1 = dense).
- `Attribute.tableRoll` += optional `min?/max?` (persisted like `max`; float-only).
- LookupTableEditor Randomize block: Min/Max NumberFields for float tables
  (default 0/1); stored in `tableRoll` so a re-roll reproduces.
- Overseer `deps.randomizeTable` (SimulatorView ~:1251): float policy reads
  `attr.tableRoll?.min/max` (mirrors the integer `tableRoll?.max` read) — the
  runtime re-roll reproduces the editor's value policy. Node schema unchanged.
- `scripts/test-ndtable.mjs`: determinism + range + back-compat assertions.
- Out of scope: `gen-accretor.mjs`'s inline fill copy (its own file, untouched).

### Phase 3 — lookup-table axes/value-tag bind AGENT tag attributes
`resolveKeyLabels` tagAttribute arm (variegation.ts:188) + `resolveValueTagOptions`
(:155) search `model.attributes` only — the agent-attribute split never reached them.
- Both resolvers: `model.attributes` then `model.agentAttributes` (ids are globally
  unique; cell/model attrs win on a hypothetical collision).
- `KeySourceField` (AttributesPanelContent:60): an "Agent tag attributes" optgroup
  (only when `topologyMode.agents`). Same for the value-tag source dropdown if it
  filters, and `LookupAxesEditor` inherits via KeySourceField.
- ModelContext cascades: EXTRACT the UPDATE_ATTRIBUTE lookup-table tag-remap block
  (~:589–653: tableValues key remap + N-D tableData axis remap + tag-VALUED index
  remap) into a shared helper; call it from **UPDATE_AGENT_ATTRIBUTE**'s
  tagOptions-change path too. Mirror the REMOVE_ATTRIBUTE dangling-source detach
  (~:351–363 + the axes arm) into **REMOVE_AGENT_ATTRIBUTE**.
- Reinit correctness: `attrsStructurallyEqual` already compares `agentAttributes`
  (tagOptions included) → an agent tagOptions edit reinits the worker and the table
  regions re-derive through `resolveAxes`/`buildLookupTablePayload(model)` — all six
  compile surfaces inherit label resolution from the ONE resolver.
- Verify: compile-identity green (no existing model keys a table by an agent attr);
  a synthetic agent-tag-keyed table resolves + compiles on JS+WASM (Phase 4's sample
  is the end-to-end proof; parity harness covers it if it globs samples).

### Phase 4 — 2D "Particle Life" library sample (`scripts/gen-particle-life.mjs`)
Agents-only (`gridCells:false`), torus, world 320×200. `species` agent tag attr, K=6
(red/green/blue/yellow/purple/cyan) + linked agent OM with the matching palette.
THREE 2-axis float tables keyed `species×species` (Phase 3): `rules` (roll seed,
density 1, min −1 max 1), `attractMin` (min 3 max 6), `attractMax` (min 8 max 16) —
`symmetric: false`. Model attrs (bounded → sliders): `N` (int 200..3000, default
1800), `forceFactor` (0.01..1, ~0.15), `repel` (0..3, 1), `friction` (0..0.99, 0.85 =
keep-fraction), `queryRadius` (4..24, 16 — wired into Get Nearby Agents; config
`neighbourQueryRadius: 24` = the hash ceiling ≥ the maxRadius roll range **and** the
slider max — documented in the model description). `centerBased`: Particle profile
(`useBondingPhysics:false`, collision off, `maxBonds:0`, `momentum:1.0`, `maxSpeed:0`,
`timeStep:1`, `drag:1`, `maxAgents:3200`, `agentTarget:'wasm'`).
Behaviour graph: friction first (Get Velocity → `v·f` → Set Velocity), then the
neighbour loop (offset → 3 lookups → Compare×2 + valueSwitch×2 + Expressions →
Apply Force). Presets: 4–6 named matrices (ports of their generators: random seeds /
snake / rock-paper-scissors / chains) as parameter-only presets carrying
`interactionTables` for all three tables + `modelAttrs`.
- Verify (the all-target gate): harness `compileAll` — agent JS clean, WASM gate
  accepts + module instantiates, WebGPU shader compiles; JS↔WASM bit-parity;
  browser run — clusters form from a seeded rules matrix, no NaN, indicator-free
  steady FPS; Reset re-rolls positions; sliders live; matrix edit live.

### Phase 5 — matrix-play widget (LookupTableEditor upgrade; editor-only)
For **float-valued** tables (legacy 2-axis AND the N-D last-two-axes grid), a new
default "Matrix" view (toggle back to "Values" = the existing NumberField grid):
- Diverging-color cells: dark neutral → cyan (positive) / red (negative), |v| =
  saturation, normalized by `max(|tableRoll.min|,|tableRoll.max|, max|v|)`. Hover
  tooltip with the value. (Their exact scheme, theme-token-adjusted.)
- **Drag-on-cell** horizontal adjust (pointer capture, step = range/150 per px);
  click (no move) selects; Ctrl+click multi-selects; a slider row below edits the
  selection — or ALL cells when nothing is selected. Symmetric mode keeps writing
  through the existing `set()` mirror.
- Fill-pattern dropdown + quick actions in/next to the Randomize block:
  generators ported from their `rulesGenerator.ts` into `src/model/matrixGenerators.ts`
  (pure, seeded with the house xorshift32 where random): Uniform random, Symmetric
  random, Snake, Chains A/B/C, Rock-Paper-Scissors, Bipartite, Hub & Spokes,
  Concentric shells (square tables only for the structural ones) + actions
  Zero / Symmetrize / Transpose / Negate / Mutate (seeded ±10%-of-range noise).
- bool/tag/integer tables keep their existing widgets untouched. Both call sites
  (Attributes panel + the simulator **left**-panel model-attribute editor) inherit.
- Verify: tsc; compile-identity green (editor-only); browser drive — drag a cell,
  multi-select + slider, generator fill, Values-view round-trip, live during Play.

### Phase 6 — 3D sample (same gen script, parameterized)
`dimension:'3d'`, world ~160×110×70, N≈1200, radii scaled down; force law gains the
z arm (Get Agent Offset dZ → fz → Apply Force Force Z; spawn z = rand·depth via Get
Grid Dimensions). Verify: JS↔WASM parity, WebGPU 3D shader compile, browser run in
the 3D agent view (sphere impostors), clusters in the volume.

### Phase 7 — docs sweep + final gates
CLAUDE.md (new section; ALSO fix the stale "simulator right panel" note in the
Chromatography section — the table editor lives in the **left** panel), README,
HelpView. Final: `tsc -b`, `npm run build`, compile-identity `--compare`,
`parity-agent-wasm`, `test-ndtable`, `check-agent-wasm-gate`.

### Phase 8 (stretch, only if 0–7 land clean) — 2D point-splat render fast path
`drawAgentsOverlay`: when radius-in-px ≤ ~2.5 and no sprites/metaballs/bonds, splat
`fillRect` instead of per-agent `arc()`. Render-only; visual parity at normal zoom.

## Deferred (documented, not in this effort)
K-stepper compound control; attract/repel force brush; Pointer-Lock drag polish;
per-pair min≤max cross-table constraint in the editor; PR7c GPU residency (the
100k-particle tier); bounce walls (engine clamp ≠ velocity inversion — the samples
use torus).

## Risk rules
- Never touch per-target emit; all phases are helper/editor/sample layers.
- compile-identity `--compare` after every phase; parity + gate after 4/6.
- One commit per phase on `Improvements` (linear history, no merges, no version bump).
