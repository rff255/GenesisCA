# AutomatosGT → GenesisCA — Agent Capability Analysis & Expansion Plan

*A study of the author's 2014 creature-sandbox "AutomatosGT" against the 2026 GenesisCA agent platform: what maps across, what is genuinely missing, what to adapt, what to leave behind, and the inspirations worth chasing.*

**Companion:** [ANALYSIS_AUTOMATOSGT_AGENTS.html](ANALYSIS_AUTOMATOSGT_AGENTS.html) (illustrated presentation version).

**Method note.** The old project (`D:/RodrigoFF/Dropbox/AutomatosGT/Prototipos/V1.71` and the newer top-level iteration) was analysed at the source level — every engine file (`scene.py`, `gui.py`, `config.py`) and every agent class (`Passaro`, `Sauva`, `FormigaComum`, `Bola`, `Aranha`, `Bullet`, `Soldado`, `Barata`, `BarataOvo`, `Alert`) — plus the version arc `V0.10 → V1.71`. It is fully runnable on the author's machine (Python 2.7 portable + bundled pygame 1.9.1). Every GenesisCA feasibility claim below was verified against the live GenesisCA source (100+ nodes, three compile targets) by a fan-out of source-reading agents and then adversarially checked. This document folds in those corrections.

---

## 1. What AutomatosGT is

AutomatosGT ("Autômatos GT", 2014) is a **continuous, off-lattice creature sandbox** written in Python 2.7 + pygame. Agents ("seres") float on a **torus world** larger than the viewport, with a god-game camera (pan / zoom / minimap / follow-a-selected-agent). Each **species is a Python class** — bird, leaf-cutter ant, common ant, ball/resource, spider, bullet, soldier, cockroach + egg — with its own sprites, named states, physical parameters, and a fixed per-step **`Decide*` pipeline** (`DecideAge → DecideAppearance → DecideDirection → DecideVelocity → DecidePosition → DecideState → DecideSpawn`).

### The engine (`scene.py`)

- **Spatial-hash neighbour gathering.** The world is tiled; tile size = the biggest vision range in the bestiary; each agent gathers only the 3×3 tile block around it (torus-wrapped). This is exactly the CSR spatial hash GenesisCA later arrived at independently.
- **Directional Field-of-View (the signature mechanic).** Each agent senses neighbours only inside a **heading-relative vision cone** (range `fov_eye_range_` + half-angle `fov_angle_`), and the hit list is **split into LEFT and RIGHT hemifields** — enabling asymmetric steering ("turn away from the side the obstacle is on"). A separate short-range **body-collision list** (radius overlap) drives separation and hard penetration correction. Flags: `blind_` opts an agent out of *sensing*; `body_radius_ ≤ 0` / `fov ≤ 0` makes a "ghost" (unsensed / no-collision).
- **Torus wrap, hard penetration correction** (push overlapping bodies apart by overlap depth), sprite rotation to heading, and a per-species semantic **`type_` tag** (`VIVO` / `OBSTACULO` / `BALA` / `RESIDUO` / `MORTA` / `ALERT`) used for interaction filtering.

### The agents (the interesting part)

| Species | What it demonstrates |
|---|---|
| **Passaro** (bird) | Reynolds **boids** — cohesion / separation / alignment + a "Rhythm" velocity-matching term — computed over **FOV-visible** neighbours, distance-weighted; distance-driven flap animation. |
| **Sauva / FormigaComum** (ants) | **Foraging + carrying**: grab the nearest *untaken* resource, set a mutual-exclusion lock (`is_taken_`) so other ants skip it, drag it rigidly at a fixed offset every step; free ↔ carrying state. |
| **Aranha** (spider) | **Full life-cycle FSM**: egg → adult → corpse → removed, where *each state changes the agent's morphology* (body radius, vision range, colour, sprite). Per-individual randomized timers (`time_to_eclode/die/lay/decompose`). Reproduction by **laying an egg**; death by bullet; corpse **decomposition**. |
| **Bullet** | **Projectile**: straight-line motion, max range (TTL), state change on contact, kill-on-hit. |
| **Barata / BarataOvo** (cockroach) | **Cross-species reproduction**: a cockroach lays an egg *object* that later hatches into a cockroach — birth/death population dynamics across two classes. |
| **Bola** (ball) | An inert **resource/obstacle** — a passive agent that ants carry. |
| **Alert** | A transient **particle/effect** (a "ghost" that vanishes after one step) — used to *visualize* collision / FOV hits in debug mode. |

### The evolution arc (a nice mirror)

`V0.10` was a single-file ant sandbox (a `Seres`/"beings" folder with just `Formiga`). It grew into: **engine/species separation** → **spatial-hash tiling + directional FOV** → **boids flocking** → **camera (pan/zoom/minimap/follow)**. The author independently reinvented spatial partitioning and flocking — the very infrastructure GenesisCA now ships as first-class, compiled, multi-target primitives. A `Machine Learning – Coursera.url` bookmark sits in an early version folder; the ambition to give agents *learning* was already in the air.

---

## 2. The two paradigms, side by side

|  | **AutomatosGT (2014)** | **GenesisCA agents (2026)** |
|---|---|---|
| Agent definition | One Python **class per species** (closed set) | One shared **behaviour graph**; agents carry only user-defined **attributes** (the built-in `type` was deliberately *removed* for a generalist design) |
| Differentiation | Subclassing | A `Switch` node on a `kind` attribute |
| Execution | Interpreted Python, single-thread | **Compiled** to JS **/** WASM **/** WebGPU, 2D **and** 3D, with JS↔WASM bit-parity |
| Sensing | **Directional vision cone** + hemifield split | **Omnidirectional** radius (`Get Nearby Agents`) |
| Collision | Hard penetration correction | Soft-sphere force law (Mathias-2020 CFL clamp) — *superior* |
| Reproduction | **Spawn a new agent mid-step** (egg / bullet / offspring) | `Divide Agent` (splits self); `Create Agent` is **init-only** |
| Update order | Fixed `Decide*` pipeline | Data-flow graph order (more general) |
| World | 2D torus, camera | 2D **+ 3D** torus/bounded, camera + orbit, voxel/sphere renderer |
| Coupling | Agents only | Agents **⇄ cell-grid field bridge** (morphogens/pheromones) |

The headline: **GenesisCA's generalist, compiled platform already subsumes most of AutomatosGT's mechanics as data-driven idioms.** What remains is two genuine gaps and a handful of ergonomic/UX opportunities.

---

## 3. Capability-by-capability verdict

Each row was verified against live GenesisCA source. Status: **gap** (missing) · **convenience** (authorable today but clumsy/slow) · **today** (fully expressible) · **superior** (GenesisCA's approach wins).

| AutomatosGT capability | GenesisCA status | Verdict | Recommendation |
|---|---|---|---|
| **Runtime spawn during behaviour** (egg / projectile / offspring) | **gap** — `Create Agent` is init-only; `Divide` splits self and can't emit at an offset/velocity | The one true hard gap | **BUILD** (highest value) |
| **Directional FOV** (vision cone + L/R hemifield) | **convenience** — L/R steering *is* authorable via `Get Velocity`+`Get Agent Offset`+dot/cross+`Switch`; but no cone query, no culling, ~6 nodes for what should be 1 | Legibility + performance, not a new capability | **BUILD as sugar** (high value, low risk) |
| Per-agent **FSM + state morphology** | **today** — `kind`/`state` attr + `Switch`; `Set Radius`/`Set Sprite`/output-mapping colour per branch | Already expressible | **DOCUMENT** (idiom + macro + sample) |
| Heterogeneous **species / kinds** | **today** — `kind` attr + `Switch` dispatch; deliberately *not* a built-in type | Already expressible; philosophy-correct | **DOCUMENT** (sample) |
| **Carry / rigid attachment** + resource claim | **today** — `Set Agent Position` (rigid drag) + `Set Agent Attribute` (the `is_taken_` lock) + `Filter Agents` | Already expressible | **DOCUMENT** (macro + sample) |
| **Corpse → decompose** + individual aging | **today** — `age` auto-increments; `Kill Agent`; per-agent random lifespan via `Get Random` in Init **or** an `age==0` first-step `Switch` | Already expressible | **DOCUMENT** (sample) |
| **Collision model** (hard penetration) | **superior** — GenesisCA's soft-sphere avoids tunnelling, is CFL-stable and tunable | Keep soft-sphere | **LEAVE** |
| **`Decide*` pipeline** (fixed phases) | **superior** — graph order is strictly more general | — | **LEAVE** |
| **Sim UX**: follow-cam, drag-to-set-velocity, cone debug, kind picker | **partial** — snapshot already carries `vx/vy/vz`; `paintAgents` already writes velocity; camera hooks exist | Small render-only wins | **ADAPT** (low priority, low risk) |

---

## 4. The genuine gaps — implementation designs

Both designs respect GenesisCA's non-negotiables: **all three compile targets** (JS/WASM/WebGPU), **2D + 3D**, JS↔WASM bit-parity, and the **three mirrored agent-loop ABIs** (`buildAgentLoopParams` ↔ `buildAgentLoopArgs` ↔ the parity-harness `buildArgs`).

### 4.1 — Runtime spawn: **Spawn Agent** node + **Spawn Event** root  ★ highest value

**Problem.** A cockroach can't lay an egg mid-step; a soldier can't fire a bullet; an amoeba can't bud offspring at an offset. `Create Agent` is init-only; `Divide Agent` splits an existing mother at a mechanically-determined position and can't aim.

**Approach — copy the proven Divide/Kill machinery.** Structural mutations in GenesisCA are already **staged into per-agent request buffers during the parallel behaviour pass**, then applied by a **sequential CPU structural phase** (`runAgentStructuralPhase`). Spawn rides the exact same rails — which makes it all-target *by construction*.

**New nodes:**

1. **`Spawn Agent`** (behaviour, flow, `requirements.bondGraph`). Ports: `do` → `next`, plus `x`, `y`, `z` (3D only, `hiddenPorts`), `radius`, **`vx`, `vy`, `vz`** *(velocity — folded in from the critique so projectiles fly)*. No `handle` output (the new slot id isn't known until the sequential commit — unlike `Create Agent`). Config: `attrInit: 'defaults' | 'inherit'` (eggs/bullets start from defaults; offspring inherit the spawner's attributes). Compiles to a **plain staging write** in the per-agent loop — byte-shape-identical to the `Divide Agent` emit:
   ```
   _spawnRequest[idx] = 1;
   _spawnX[idx] = <x | _agentX[idx]>;  _spawnY[idx] = <y | _agentY[idx]>;  (_spawnZ in 3D)
   _spawnRadius[idx] = <radius | 1>;   _spawnVX[idx] = <vx>; _spawnVY[idx] = <vy>;  (…VZ in 3D)
   ```
2. **`Spawn Event`** (a 4th single-agent root, the exact analogue of `Division Event`). Runs **once per newly-committed agent** in the structural phase as a single-agent function. Value-outs: `spawnerId`, `myX/Y/Z`, `myRadius`. Its `DO` chain uses the universal `Set Attribute` / `Set Velocity` / `Set Agent Sprite` over the newborn's `idx` to author arbitrary initial state (`egg.energy=0`, `bullet.ttl=30`, `offspring.generation = parent.generation+1`). Singleton, like `divisionEvent` / `agentInit`.

**Engine (agentEngine.ts + sim.worker.ts):**

- Append SoA request fields (`spawnRequest: Uint8`, `spawnX/Y/Z/Radius/VX/VY/VZ: Float64`) — **appending** keeps every existing region's offsets byte-identical (no-spawn models unchanged). Zero them in `initAgentSlot`/`freeAgentSlot` (recycled slots never carry a stale flag).
- Add a **spawn sub-phase** to `runAgentStructuralPhase`, ordered **death → division → spawn** (fixed + documented — order is parity-load-bearing). Snapshot `highWater` first so newborns landing beyond it aren't re-processed this step (mirrors division). For each alive `i` with a request: `allocAgentSlot` (free-list; **overflow → reject the whole spawn + the existing `agentOverflow` notice**, never wrap) → `initAgentSlot(…, x, y, z, radius)` → write velocity into `s.vx/vy/vz[newId]` (the piece `initAgentSlot` doesn't set — the critique's key fix) → if `inherit`, copy the spawner's `attrRead` into the newborn → record `{spawner, child}` for the Spawn Event.
- `runSpawnEvent(spawnEvents)` modelled 1:1 on `runDivisionEvent`, with its own `buildSpawnParams ↔ buildSpawnArgs` pair (the `w_` block **aliases `attrRead`**, exactly like the division event, or sync-mode writes are lost).

**Per target:** JS — an ordinary flow action (no special-case). WASM — add to `AGENT_WASM_SUPPORTED_TYPES`; emit the same `i32.store8` + `f64.store` request writes the WASM Divide/Kill emitters already do; the commit is shared CPU code → bit-parity by composition. WebGPU — add to `AGENT_WEBGPU_SUPPORTED_TYPES`; stage into `AGENT_GPU_REQUEST_FIELDS`; `readbackAgentStep` maps the request bases → CPU arrays (same round-trip as `divideRequest`); commit + Spawn Event run CPU-side after readback. **Gotcha:** request sentinels written to f32 must be representable ints, *never* a NaN (the divide-axis-NaN close-out lesson — Naga const-folds a NaN bitcast and rejects the shader).

**Scope decisions:** one spawn-per-agent-per-step in v1 (the fixed-width request buffer; bursts/clutches are a nice-to-have `spawnCount` + bounded ring later). `attrInit` is a model-level default in v1 (keeps the request buffer minimal). **Effort: M** — the Divide/Kill precedent covers ~80%; the genuinely new work is the Spawn Event root + ABI pair + the inherit-copy + the velocity write.

**Verification:** add a synthetic spawn model to `scripts/parity-agent-wasm.mjs`; require **0 mismatches over 150 steps** on all samples; browser-verify a projectile stream on JS/WASM/WebGPU and a 3D spawn-at-offset.

### 4.2 — Directional FOV: **Get Agents In View** + **Sense Hemifield**  ★ high value, contained

**Problem (framed honestly).** The *capability* — cone-scoped sensing and left/right asymmetric steering — is authorable **today** inside a `Get Nearby Agents` → `For Each` loop with a `dot` (forward gate) and 2D `cross` (`dx·hy − dy·hx`, the L/R side) fed to a `Switch`. What's missing is **ergonomics, legibility, and culling**: that's ~6 nodes for one idea, and it still gathers the full omnidirectional radius. A native node makes intent legible and prunes the gather.

**Approach — an angle filter injected into the *existing* gather.** The cone test rides the same 3×3(×3) hash-stencil `test(j)` predicate `Get Nearby Agents` already emits. The heading source (`vx/vy/vz`) and the torus-folded offset (`dx/dy/dz`) are *already computed* inside every nearby loop. **Zero new SoA fields, zero new ABI slots, no structural-phase involvement** — it's a pure per-agent read.

**New nodes:**

1. **`Get Agents In View`** (data, array producer). Ports: `Radius`, `HalfAngle` (degrees), optional wired `Heading X/Y/Z`; outputs an `Agents` id array (or `AgentsLeft` + `AgentsRight` when `split=true`). Cone membership = `dot(unitHeading, unitOffset) ≥ cos(halfAngle)`. Reuses the same scratch-slot budget as `Get Nearby Agents`.
2. **`Sense Hemifield`** (data, scalar reduction) — **the Braitenberg primitive.** Runs the same gather *without* materializing an id array, outputting `LeftCount / RightCount / AheadCount` + `Left/RightNearestDist` + `Left/RightNearestId`. Enables "turn away from the crowded side" taxis with no per-agent array — and **consumes no scratch slot**. This is the direct descendant of AutomatosGT's `l_fov_hit`/`r_fov_hit` split.

**Heading source (critique-corrected).** Default = velocity (zero-cost; matches boids). For **still agents** (spawners, eggs) that have no velocity heading, the fallback is *not* a new SoA field: **`spriteRotations` already exists as a per-agent compass-degree facing field, already threaded through all three ABI mirrors and the render snapshot.** Reuse it (this also unifies FOV heading, rigid-carry orientation, and `Set Agent Sprite` rotation on one source). A `headingSource` config selects velocity / stored-facing / wired-input.

**2D vs 3D.** 2D: cone in XY; L/R = sign of the 2D cross. 3D: the cone becomes a **solid angle** around the 3D heading (same `dot ≥ cos(halfAngle)` with the z arm); L/R = sign of the triple product against a stable up-reference (world +Z, swapping to +Y when heading ∥ +Z). `hiddenPorts` hides the Z heading input in 2D. With `halfAngle = 180°` the node compiles to *exactly* the `Get Nearby Agents` bytes (a fast-path — omnidirectional via the FOV node has zero overhead).

**Per target:** clone the `Get Nearby Agents` emit on all three; inject the ~10-line dot-test into the candidate predicate (`cos ≥ cosHalf`, with `cosHalf` hoisted once = `cos(halfAngle·π/180)`; WASM uses the host `cos` import for parity, WGSL uses `cos(radians(...))`). f64 → JS↔WASM bit-parity; f32 → acceptable cone-boundary statistical difference on WebGPU (documented, same class as the existing distance-boundary difference). **Effort: M** — a ~90% clone of the well-tested gather + a scalar dot-test; no engine/SoA/ABI change.

**Risks:** the ÷0 heading guard for zero-velocity agents is the single most important correctness detail; keep the 3D up-reference convention identical across targets or L/R won't parity-match; angle is entered in **degrees** and converted to radians once. Gate both nodes behaviour-root-only (the division/init ABIs lack the `_hash*` buffers), matching `Get Nearby Agents`.

**Bonus (renderer-only):** a **vision-cone debug overlay** for the selected/followed agent (2D canvas arc; 3D `drawLines` fan) — AutomatosGT's FOV-cone debug draw, reborn.

---

## 5. Already achievable today — ship idioms, not nodes

Almost the entire AutomatosGT *lifecycle vocabulary* is expressible now. The deliverable is **packaging**, not machinery — the platform's generalist stance means a built-in `state`/`kind`/`FSM` node would be a regression (it would re-introduce the closed `type` that was deliberately removed).

**Ship a small macro library** (`public/macros/*.gcamacro`, drag-droppable — macros lower to primitives for free on all three targets):

- **State Machine (N-state)** — `MacroInput(state) → Switch(by value) → MacroOutput(one branch per state)`; the user wires each state's body + a `Set Attribute(state)` transition. *Explicitly documented as Switch-sugar, not a built-in FSM.*
- **Rigid Carry** — `Get Agent Offset` → `Set Agent Position(carriee = self + facing·offset)`; the `is_taken_` mutex is a bool `claimed` attribute set via `Set Agent Attribute(by id)`.
- **Lifespan Timer** — reads `age`, compares to a per-agent `lifespan` (assigned via `Get Random` in the Agent Init Event **or**, for brush-seeded agents, under an **`age==0` first-step `Switch`** — the critique's coverage fix), fires a flow-out when expired.
- **Corpse → Decompose** — a two-phase timer `alive →(lifespan)→ corpse →(rot)→ Kill`, gating movement/forces on `state=='alive'`.

**Individual variation** (each agent's lifespan drawn from a distribution) is the loop-pinned `Get Random` idiom — `sinkAnalysis` keeps RNG inside the per-agent loop so per-agent draws survive. Document the two seeding sites (Init Event vs `age==0` first step).

---

## 6. What to leave behind

- **Hard penetration correction** — GenesisCA's soft-sphere (repulsion/adhesion + CFL-clamped overdamped integration) is non-penetrating by design and strictly better. Keep it; document the philosophy so legacy "order matters" intuitions map onto force layering.
- **The fixed `Decide*` pipeline** — replaced by data-flow graph order, which is more general (you can interleave a force with a vision query).
- **Class-per-species architecture** — the opposite paradigm; GenesisCA's compiled, multi-target, attribute-driven model is the point. The species *ideas* survive as sample models, not as an engine feature.
- **A built-in species/type enum or a runtime species picker** — philosophically incompatible with the generalist design. The equivalent is a `kind` attribute + `Switch`, and (UX) named **seed-config presets** you cycle with the scroll wheel.

---

## 7. Simulator UX — small, render-only wins

All four are TypeScript in `SimulatorView.tsx` (+ `gl3d.ts`), zero compiler/engine/parity work (the snapshot already ships `vx/vy/vz`; `paintAgents` already writes velocity; camera hooks exist):

1. **Follow-agent camera** — click an agent → ease `panRef` (2D) / `cam3dRef.target` (3D) toward it each frame; auto-disable on a manual pan; auto-clear + toast on the followed agent's death (guard against free-list id recycling).
2. **Drag-to-set-velocity add-brush** — stage an anchor on LMB-down, draw a live arrow, seed at the anchor with initial velocity = `(cursor − anchor)·scale` (fire an existing `paintAgents{geom:{vx,vy,vz}}` right after the seed — zero ABI change). A plain click still seeds at rest. *Note it's only visually meaningful for `momentum > 0` models.*
3. **Vision-cone debug overlay** — the FOV feature's companion; a "Show vision cone" toggle + range/half-angle numbers; labelled clearly as a *debug visual*, not a change to what `Get Nearby Agents` returns.
4. **Seed-config presets** — save/name/cycle the current agent seed attributes (persisted per-model), the generalist replacement for AutomatosGT's scroll-to-pick-species.

---

## 8. Sample-model gallery — the "living ecosystem" showcase

AutomatosGT's real gift is a *vibe*: a digital terrarium you tinker with. GenesisCA's current agent samples (Boids / Chemotaxis / Tissue) are abstract; a creature gallery would sell the platform far better. Proposed library models (all 2D+3D-capable, all three targets unless noted):

| Model | Inspiration | Showcases | Needs |
|---|---|---|---|
| **Starling Murmuration** | Passaro (bird boids) | 3D flocking in a torus volume; sprite bank-into-heading; velocity-matching | *today* |
| **Leaf-Cutter Column** | Sauva + Bola | Stigmergic pheromone trail (field bridge) + resource carry + mutex claim | *today* |
| **Slime Colony** | Aranha life-cycle | Per-agent FSM + state morphology; division-as-reproduction; corpse→field coupling | *today* |
| **Coral Reef Assembly** | Bola + tissues | Bonded 3D structural growth; substrate-gated (nutrient-field) division | *today* |
| **Wolf & Deer** | Aranha FOV avoidance + herd | Predator vision cone + L/R asymmetric flight + chase/kill | *today (emulated); native FOV collapses it* |
| **Braitenberg Moths** | the atomic FOV idea | Lateralized differential sensing (lover/coward wiring) → emergent taxis | *today (field version); enriches with FOV* |
| **Cockroach Plague** | Barata/BarataOvo + Soldado/Bullet | Cross-kind reproduction at an offset; **aimed projectiles**; 4-kind birth-death ecology | **after Spawn Agent** (bullets need the velocity port) |

The gallery doubles as regression coverage: the "today" models prove the current platform's reach; the last two prove the two new features end-to-end.

---

## 9. Broader inspirations

- **Directional vision completes the sensory toolkit.** GenesisCA already has field gradients (chemotaxis) and omnidirectional proximity. A vision cone rounds out "how an agent perceives" — and the **left/right hemifield** is the minimal-cognition Braitenberg primitive (two numbers → emergent taxis/avoidance). Expose it directly (`Sense Hemifield`).
- **Emit-during-behaviour changes the class of dynamics.** It turns a fixed dividing population into **open-ended birth/death** — projectiles, spores, eggs, particle systems, predator-prey ecologies with real population curves. This is the qualitative expansion.
- **A canonical per-agent facing.** Unify FOV heading, rigid-carry orientation and sprite rotation on the *existing* `spriteRotations` field (already ABI-threaded) instead of everyone re-deriving heading from velocity — and consider a first-class "facing" concept long-term (a still agent that *looks around*).
- **The study loop.** AutomatosGT's *select → follow → inspect* is how you understand an individual in a swarm. GenesisCA has inspect; add follow and the loop closes.
- **Lean into the terrarium.** The god-game framing (place creatures, watch an ecology unfold, follow one, pause and poke) is a compelling *product* story on top of the compute platform — and the sample gallery is the on-ramp.
- **The historical mirror.** AutomatosGT independently reinvented spatial hashing and boids over its version arc; GenesisCA ships those as compiled multi-target infrastructure. The remaining old-project ideas (vision, spawning) are the natural next primitives.

---

## 10. Recommended roadmap

Priority = value × how much it unlocks; effort respects the all-target/2D-3D/three-ABI discipline.

**Phase A — Idioms & gallery (no engine work, immediate).**
Ship the macro library (State Machine / Rigid Carry / Lifespan / Corpse) + the "today" sample models (Murmuration, Leaf-Cutter, Slime Colony, Coral Reef, Wolf & Deer, Braitenberg Moths) + a HelpView "agent patterns" section. Proves and documents the current platform. *Effort: S.*

**Phase B — Directional FOV (`Get Agents In View` + `Sense Hemifield`) + cone debug overlay.**
No engine/SoA/ABI change; a contained clone of the gather on three targets. High legibility/perf payoff; upgrades Wolf & Deer and Braitenberg Moths. *Effort: M.*

**Phase C — Runtime spawn (`Spawn Agent` + `Spawn Event`), with velocity.**
The flagship. Follows the Divide/Kill request-buffer + structural-phase precedent; touches the three ABI mirrors (re-run the parity harness). Unlocks Cockroach Plague + the whole reproduction/projectile class. *Effort: M.*

**Phase D — Simulator UX (follow-cam, drag-velocity brush, seed presets).**
Render-only; polish that makes the terrarium feel alive. *Effort: S–M.*

**Deferred / nice-to-have:** multi-spawn bursts (`spawnCount`); a first-class per-agent facing field; per-hemifield *average* offset/velocity outputs for true Braitenberg wiring; a native FOV node in the division/init events.

---

## 11. Verification checklist (for whoever implements)

- [ ] Every new node compiles + runs on **JS, WASM, and WebGPU** (`compileAll` harness) across **2D and 3D**.
- [ ] `Spawn Agent`: the three ABI mirror pairs (`buildAgentLoopParams`/`Args`/parity `buildArgs`) + `buildSpawnParams`/`Args` edited **together**; `scripts/parity-agent-wasm.mjs` → **0 mismatches** on all samples incl. a synthetic spawn model; WebGPU request sentinels are representable f32 (no NaN); structural-phase order fixed (death → division → spawn); spawned velocity written after `initAgentSlot`; `inherit` copies from post-swap `attrRead`.
- [ ] FOV: `halfAngle=180°` byte-identical to `Get Nearby Agents`; ÷0 heading guard; identical 3D up-reference on all targets; degrees→radians once; behaviour-root-only gate.
- [ ] Every sample model loads + runs on all three targets; the "today" set needs no new nodes.
- [ ] Docs updated in lockstep: `CLAUDE.md` (feature sections + Project Structure), `HelpView.tsx`, `README.md`, `docs/NODES_REFERENCE.md` (node count + tables).

---

*Prepared from a source-level read of AutomatosGT V1.71 (+ arc) and an adversarially-verified feasibility pass over the live GenesisCA agent platform. All feature designs follow GenesisCA's all-target / 2D-3D / three-ABI discipline; nothing proposed ships JS-only or re-introduces a built-in agent type.*
