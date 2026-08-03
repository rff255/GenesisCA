# Implementation Handoff — Agent Capability Profiles **(v1.1, hardened)**

*Twice-audited against live source: a feasibility pressure-test (verdict GO-WITH-FIXES; corrected the design overclaims) and a skeptical implementation-plan hardening review (drafted the missing specs, caught the sequencing/consistency defects). **This v1.1 is the authoritative, implementation-ready spec** — it embeds the concrete artifacts (types, presets, dependency graph, migration algorithm, field order, audit scripts, Spawn Event) an implementer works from directly.*

**Plan (architecture + rationale):** [PLAN_AGENT_CAPABILITY_PROFILES.md](PLAN_AGENT_CAPABILITY_PROFILES.md) · **Presentation:** [HANDOFF_AGENT_CAPABILITY_PROFILES.html](HANDOFF_AGENT_CAPABILITY_PROFILES.html) · **Origin:** [ANALYSIS_AUTOMATOSGT_AGENTS.md](ANALYSIS_AUTOMATOSGT_AGENTS.md)

> **File:line references** are audit anchors — "look near here," confirm before editing.

---

## 0. Verdict — GO-WITH-FIXES (hardened)

> **STATUS (2026-08-03): the milestone is COMPLETE.** STEP 0-5 shipped earlier; **STEP 4 (profile-gated
> SoA fields) and STEP 6 (the Static / Velocity motion integrator) shipped as Clarity phase C9** on branch
> `GRA` — see [HANDOFF_CLARITY_SIMPLIFICATION.md](HANDOFF_CLARITY_SIMPLIFICATION.md) §C9 and the
> "STEP 4 + STEP 6 — SHIPPED (C9)" section of the repo `CLAUDE.md`. Deviations from the plan below, all
> documented there: the `AGENT_*_FIELDS` reorder was NOT needed (the gates simply skip a field, and a
> given profile produces one consistent layout at every mirror); the gate hook is `AgentAbiShape.gates`
> rather than the per-field `gate(profile)` closure (the SHAPE is the gate — the P2 bond-block precedent);
> and the WebGPU agent SoA layout stays UNGATED by choice (its runs are a per-generation mirror, not the
> model's memory), though its emitters carry the safety catch.

The architecture is sound and *is* the codebase's own trajectory (`type`-removal, `maxBonds=0`, `useBondingPhysics`, `hasLookupTables`, `agentAccess`, `gridCells`, `is3d` are real precedents). Both audits agree the split is clean: **STEP 0 + STEP 1 (editor-surface gating, no SoA/engine change) can proceed and deliver the entire clarity win at near-zero risk** — the compiler stays unconditional, so those steps are provably behaviour-preserving. Everything heavier is gated behind three prerequisites the hardening review made concrete: **(1)** a *layout-agnostic* shared ABI descriptor + a **field-order** audit (not arity-only); **(2)** the complete **mode-aware dependency graph** as one source-of-truth consumed at three gates; **(3)** a **usage-widened** migration. Before the first real SoA gate (STEP 3) add the **structural-phase sub-step refactor**, **macro-internals re-validation**, and the **linked-mapping gate**. Before STEP 4, **reorder the interleaved `AGENT_*_FIELDS`** to append-at-stable-slot. WebGPU needs its **own L∞ harness** (bit-parity is impossible).

---

## 1. The corrections that changed the design (from the feasibility audit)

| # | The design plan claimed… | The source says… | Consequence |
|---|---|---|---|
| **C1** | `hasAgentSprites` conditionally ABI-mirrors its block | Sprites are **unconditionally** threaded — the comment literally says *"Always threaded"* | The real conditional-ABI template is **`hasLookupTables`** (compile.ts ~2276 ↔ worker ~1058), the **`is3d` trailing block** (~2293 ↔ ~1068), and **`agentAccess`/`cellFieldAttrsOf`** (~2284). *(The Sprite-block gate in STEP 4 is the **first** conversion of a previously-unconditional block — so its risk sits **above** Bonds, which already has the `maxBonds=0` precedent.)* |
| **C2** | Core = id+alive+position+attrs; Motion & Body are gate-able | position **+ velocity + force + radius** are read **unconditionally** by the integrator, render snapshot (`store.vx.slice()` — throws if unallocated), serialize/deserialize, `getAgentState`, and the compiled `myRadius`/`myArea` preamble. **No `Static` path exists.** | Motion & Body are **palette-gated only** in v1; SoA-gating them is the deferred XL milestone (STEP 6). |
| **C3** | Omitting a capability keeps offsets byte-identical ("append-only") | Field lists **interleave** position/velocity/force/radius/age; `computeAgentMemoryLayout` **recomputes** per profile. CPU (`AGENT_F64_FIELDS`) & WebGPU (`AGENT_GPU_F32_FIELDS`) are **separate, differently-ordered** lists. | Gate template = **append-at-a-stable-slot** driving **both** CPU and GPU together; byte-identity holds only at a constant profile. The interleaved lists must be **reordered** (STEP 4 prerequisite, §3.5). |
| **C4** | Three ABI mirrors stay in lockstep "because all read the profile" | The parity harness `buildArgs` is a **third, independent hand-written** copy; the arity assertion (worker ~3519) catches count mismatch but **not order shifts under matched arity** | Build the shared **layout-agnostic** descriptor source (§3.6) **first**, and gate on a **field-order audit**. |
| **C5** | Migration: absent ⇒ "Full" | `defaultCenterBasedConfig()` ships `maxBonds:0` + `useBondingPhysics:false`; a config-only inference would **mislabel** a `maxBonds:0` file that *wires* `Form Bond` | Migration is **config base widened by a graph-usage scan** — the scan can only **add** capabilities (never remove), so it is always behaviour-preserving (§3.4). |

Also corrected: `colors` is **always** allocated; **no `Get Age` node exists** (add one in STEP 4); the **`Spawn Event` root is net-new** (§3.7); `lineage`/`epoch`/`bondCount` are **always-allocated core reductions** (never a toggle — §2).

---

## 2. The honest irreducible core

**Always-allocated (palette-gated only — never SoA-gated before STEP 6):** `alive` (u8), `colors` (RGBA u8), position (`x,y[,z]` + `xNext,yNext[,zNext]`), velocity (`vx,vy[,vz]`), force (`forceX,forceY[,forceZ]`), `radius`, and the always-on i32 reductions **`lineage`, `epoch`, `bondCount`** (`epoch` = the dangling-bond generation counter, source-confirmed **not** part of the free-list; `bondCount` is pushed **unconditionally** into `buildAgentLoopParams` ~2245 — it **must stay in the ABI even when Bonds=off**, or every downstream param shifts). The agent **id** is the array index, not a stored field. User `agentAttributes` ride their own `attrRead/attrWrite`.

**Core footprint (honest):** ≈ **89 bytes/agent in 2D** (`alive 1 + colors 4 + position 4×8 + velocity 2×8 + force 2×8 + radius 8 + lineage/epoch/bondCount 3×4`) and ≈ **121 bytes in 3D** (+ `z,zNext,vz,forceZ` 4×8). **The Properties footprint readout MUST be bound to `computeAgentMemoryLayout(profile)` — not a hand-typed number** (the plan's "96 B" mockup was mathematically impossible; core alone exceeds it). The "cost of generality" the readout sells is the **gate-able groups on top of core**, not core itself.

**Gate-able groups (add to core):** `age` (Lifespan, 8), `targetRadius` (Body/Growth, 8), `density` (Collision/Sensing, 8), `divideAxis*/divideAsym/divideRequest` (Division), `bondFormL/K/bondFormReq/bondBreakReq` + the bond store `28·maxBonds` (Bonds), `killRequest` (Population.Death), the sprite block (Appearance), the spawn block (Population.Birth, §3.7). These are what a tightened preset actually drops.

---

## 3. Concrete specs to embed (built by the hardening review)

### 3.1 — `AgentCapabilities` type (additive on `CenterBasedConfig`)

```ts
// src/model/types.ts
export type MotionMode    = 'static' | 'velocity' | 'force';
export type CollisionMode = 'off' | 'soft' | 'positional';   // soft⇒Motion=force; positional works under any Motion
export type BondsMode     = 'off' | 'data' | 'physics';      // data = edges only (no springs)

export interface AgentCapabilities {
  motion: MotionMode;                 // v1: always-allocated; toggle = palette-gate only (SoA-gate = STEP 6)
  body: boolean;                      // v1: always-allocated; radius surface + disc/sphere render
  collision: CollisionMode;
  bonds: BondsMode;
  autoBond: boolean;                  // requires bonds === 'physics'
  growth: boolean;                    // requires body
  division: boolean;                  // requires body (+ bonds for the tension axis; spread-axis fallback if off)
  lifespan: boolean;                  // age
  populationBirth: boolean;           // Spawn (net-new, STEP 5a)
  populationDeath: boolean;           // Kill (effectively always-on in v1)
  sensing: boolean;                   // spatial hash + Get Nearby Agents + FOV
  sensingHeadingSource: 'velocity' | 'facing' | 'wired';  // 'facing' ⇒ requires orientation
  orientation: boolean;              // facing (reuses spriteRotations, decoupled in STEP 5c)
  fieldCoupling: boolean;            // requires ≥1 cell attr with agentAccess !== 'none'
  appearance: boolean;               // colors always-allocated; sprites conditional
}
// centerBased.ts: `agentCapabilities?: AgentCapabilities`  (absent ⇒ config-aware migration, §3.4)

// The layout-agnostic ABI descriptor field (§3.6):
export interface AgentAbiField {
  name: string;                      // '_agentVX' / '_spawnRequest' / …
  cType: 'f64' | 'i32' | 'u8';
  gate?: (p: AgentCapabilities) => boolean;   // omitted ⇒ always present (core)
  resolve?: (store: AgentStore, model: CAModel, ctx: unknown) => unknown;  // worker/harness value
  comment?: string;
}
```

### 3.2 — The 7 presets (`agentPresets.ts`). **`Full` ≡ `Morphogenesis` (deep-equal — a STEP 1 gate).**

```ts
PARTICLE     = {motion:'force',  body:true,  collision:'soft', bonds:'off',     autoBond:false, growth:false, division:false, lifespan:false, populationBirth:false, populationDeath:true,  sensing:false, sensingHeadingSource:'velocity', orientation:false, fieldCoupling:false, appearance:true}
BOIDS        = {motion:'force',  body:true,  collision:'off',  bonds:'off',     autoBond:false, growth:false, division:false, lifespan:false, populationBirth:false, populationDeath:false, sensing:true,  sensingHeadingSource:'velocity', orientation:true,  fieldCoupling:false, appearance:true}
VIVARIUM     = {motion:'force',  body:true,  collision:'soft', bonds:'off',     autoBond:false, growth:false, division:true,  lifespan:true,  populationBirth:true,  populationDeath:true,  sensing:true,  sensingHeadingSource:'velocity', orientation:true,  fieldCoupling:false, appearance:true}
MORPHOGENESIS = FULL = {motion:'force', body:true, collision:'soft', bonds:'physics', autoBond:true, growth:true, division:true, lifespan:true, populationBirth:true, populationDeath:true, sensing:true, sensingHeadingSource:'velocity', orientation:false, fieldCoupling:true, appearance:true}
SOCIAL_GRAPH = {motion:'static', body:false, collision:'off',  bonds:'data',    autoBond:false, growth:false, division:false, lifespan:false, populationBirth:false, populationDeath:false, sensing:false, sensingHeadingSource:'velocity', orientation:false, fieldCoupling:false, appearance:true}
CA_ON_AGENTS = {motion:'static', body:true,  collision:'off',  bonds:'off',     autoBond:false, growth:false, division:false, lifespan:false, populationBirth:false, populationDeath:false, sensing:true,  sensingHeadingSource:'velocity', orientation:false, fieldCoupling:false, appearance:true}
CUSTOM       = <last-edited object; editing any toggle flips the picker to Custom>
```
*Honesty note baked into the UI: `motion`/`body` are always-allocated in v1 regardless of the toggle — the toggle only palette-gates. SoA-gating them is STEP 6.*

### 3.3 — Complete mode-aware dependency graph (`agentCapabilityDependencies.ts` — one source consumed at THREE gates)

| Capability (mode) | Hard deps (auto-enabled) | Enhanced-by (hint, not auto) | Data dep (validated) |
|---|---|---|---|
| Position (core) | — | — | — |
| Motion = static/velocity/force | Position | — | — |
| Body | Position | — | — |
| Collision = **soft** | Body, **Motion=force** | — | — |
| Collision = **positional** | Body | — | — |
| Bonds = data | Position | — | — |
| Bonds = physics | Position, **Motion=force** | — | — |
| Auto-bond | **Bonds=physics**, Motion=force | — | — |
| Growth | Body | Bonds=physics (synergy) | — |
| Division | Body | **Bonds** (tension axis; spread-axis fallback if off) | — |
| Lifespan | — | — | — |
| Population.Birth (Spawn) | Position, **Motion** (velocity payload) | — | — |
| Population.Death (Kill) | — | — | — |
| Orientation | Position | Sensing / Sprites | — |
| Sensing (FOV) | Position | **Orientation** (only if `sensingHeadingSource ≠ 'velocity'`) | — |
| Field coupling | Position | — | **≥1 cell attr with `agentAccess`**; per-node: a wired attr must have `agentAccess` |
| Appearance | Position | — | — |

**Three enforcement gates from the one source:** (1) **UI** — `computeCapabilityClosure(enabled)` transitively auto-enables hard deps on toggle (mirrors how enabling bonding physics already bumps `maxBonds` off 0); (2) **compile** — `validateNodeRequirements(node, profile)` → **informational** badge in STEP 1, **blocking** error from STEP 3; (3) **migration** — `inferProfileFromGraph` unions wired-node requirements + closes (§3.4). **Division fallback table:** `{Body✓,Bonds✓}` = tension-axis eigensolve; `{Body✓,Bonds✗}` = spread-axis (a *silent geometry change* — surface Bonds as an "enhances Division" UI hint); `{Body✗}` = invalid → auto-enable Body.

### 3.4 — Usage-aware migration (config base **widened** by a graph scan, never narrowed)

```ts
function inferAgentProfile(model): AgentCapabilities {
  if (model.centerBased?.agentCapabilities) return model.centerBased.agentCapabilities;  // explicit wins
  const cfg = model.centerBased;
  // 1. CONFIG BASE — behaviour-safe: a maxBonds:0 file already allocates zero bond store today.
  //    (else-branch also covers legacy files predating these fields via `usesBondingPhysics ?? !customForcesOnly`.)
  let p = (resolveMaxBonds(cfg) === 0) ? clone(PARTICLE) : clone(FULL);
  // 2. USAGE WIDENING — scan can only ADD caps ⇒ always behaviour-preserving.
  const used = new Set<string>();
  for (const n of [...model.agentGraphNodes, ...macroInternalNodes(model)])
    detectCapabilityRequirements(n.data.nodeType, model).forEach(r => used.add(r));
  if (used.has('bonds') && p.bonds === 'off') p.bonds = 'data';   // widen; keep 'physics' if config had it
  if (used.has('bonds:physics')) p.bonds = 'physics';
  if (used.has('division')) { p.division = true; p.body = true; }
  if (used.has('body'))     p.body = true;
  if (used.has('growth'))   { p.growth = true; p.body = true; }
  if (used.has('lifespan')) p.lifespan = true;
  if (used.has('fieldCoupling')) p.fieldCoupling = true;
  if (used.has('sensing'))  p.sensing = true;
  if (used.has('populationBirth')) { p.populationBirth = true; if (p.motion === 'static') p.motion = 'velocity'; }
  // 3. dependency closure
  return computeCapabilityClosure(p);
}
```
**Key safety property (source-confirmed):** config-only inference is *SoA-behaviour-safe* (a `maxBonds:0` file already has no functional bond store) but *palette-dishonest* — a `maxBonds:0` file that wires `Form Bond` would be mislabeled bare Particle and its nodes hidden. The usage-widen unions those capabilities back in (Bonds=Data), so the preset is honest **and** behaviour never changes. **`detectCapabilityRequirements` must cover EVERY capability-implying node — including nodes reachable only inside macros and inside the division/init/spawn/output-mapping roots**, or the inferred profile silently under-widens (a latent palette bug from STEP 3; benign in STEP 1 since the compiler is unconditional).

**Versioned `AgentStatePayload`:** `v1` = legacy → treated as Full on load; `v2` = profile-aware, carrying the capability set. On load, validate compatibility and **reject loudly** ("saved state has bonds but this profile disables them") — never `copyInto`-crash or silently zero.

### 3.5 — Revised `AGENT_*_FIELDS` order (append-at-stable-slot; STEP 4 prerequisite)

Today's lists interleave gate-able fields mid-sequence (`…radius,targetRadius,age,divideAxis*…`), so gating any of them shifts all downstream offsets. Reorder to **core-first, each gate-able group at a pinned append slot** so disabling a group zeroes its stride *without* shifting core offsets:

```
AGENT_F64_FIELDS (revised):
  [CORE, always]   x, y, xNext, yNext, vx, vy, forceX, forceY, radius
  [Lifespan]       age
  [Body/Growth]    targetRadius
  [Collision]      density
  [Division]       divideAxisX, divideAxisY, divideAsym
  [Bonds=physics]  bondFormL, bondFormK
  [3D trailing, is3d only]   z, zNext, vz, forceZ, divideAxisZ, (spawnZ)
AGENT_I32_FIELDS:  lineage, epoch, bondCount  [ALWAYS — core reductions]  + [Bonds=physics] bondFormReq, bondBreakReq
AGENT_U8_FIELDS:   alive [ALWAYS]  + [Division] divideRequest  + [Population.Death] killRequest
```
**Invariant:** appending a group never shifts an existing group's offset; disabling a group sets its stride 0 (`computeAgentMemoryLayout(profile)` zeroes disabled strides). The WebGPU `AGENT_GPU_F32_FIELDS` keeps its own native order but is gated by the **same predicate set** — the audit (§3.6) checks the field **sets** match across targets, not the order. The reorder must itself pass the **Full-profile byte-identity + parity** gate before any capability is gated.

### 3.6 — Shared **layout-agnostic** ABI descriptor + the 4-site **field-order audit** (S1 redefined)

The critical correction: **S1 is NOT one ordered list** — CPU and GPU layouts differ in order (and GPU omits `divideAxis*` and the i32 reductions). S1 is a **descriptor SET** (logical fields + gate predicates + `cType`); each target re-orders into its native layout, gated by the **same** predicates:

```
deriveAgentLayouts(profile, model) -> { cpuF64[], cpuI32[], cpuU8[], gpuF32[], gpuI32[] }   // each in its target order
```
The three CPU-side ABI mirrors (`buildAgentLoopParams` names ↔ `buildAgentLoopArgs` values ↔ harness `buildArgs`) consume the **CPU-order** layout; the WebGPU layout consumes `gpuF32/gpuI32`. **STEP 0's gate is a FIELD-ORDER audit, not arity** — `scripts/audit-agent-layout.mjs`:
- re-derive the ordered field-name list from all **four** sites (compile params, worker args, harness args, GPU layout);
- **(a)** the three CPU-side lists are byte-identical in **name AND order**; **(b)** GPU field **set** === CPU field set (order may differ, f64↔f32); **(c)** the 2D field list is a **prefix** of the 3D list (append-only z-block); **(d)** per-field `cType`/stride match;
- report divergences verbatim (`compile has [_agentX,_agentY,_agentZ] but worker has [_agentX,_agentY]`); exit 1 on any. **This single check makes the whole ABI-desync class detectable** (the arity assertion cannot).

### 3.7 — Spawn Event spec (STEP 5a; a new `docs/` note may expand this)

A per-model root firing **once per structural phase, AFTER death, BEFORE step-end**. Fields (append-at-stable-slot, gated on `populationBirth`): `spawnRequest(u8)`, `spawnX/Y[/Z](f64)`, `spawnRadius(f64)`, `spawnVX/VY[/VZ](f64)`, `spawnInherit(u8)` — zeroed in `initAgentSlot` AND `freeAgentSlot`. Flow: the Behaviour Step's **Spawn Agent** node writes `spawnRequest[idx]=1` + payloads → the gated structural sub-pass `allocAgentSlot()`s each, seeds the daughter from the payload, then runs the **Spawn Event** root (user logic may mutate/reject) → `spawnRequest` cleared. Overflow (`maxAgents`) → the existing `agentOverflow` notice, never wraps; a leak-sweep frees Created-but-not-committed slots (mirror `agentInit`'s discipline). Its params ride a `deriveSpawnAbi(profile, model)` pair **added to the S1 descriptor source**, so the 4-site field-order audit covers it automatically. Initial velocity is written to `s.vx/vy/vz[newId]` after `initAgentSlot` (the piece `initAgentSlot` doesn't set — so projectiles fly).

---

## 4. Shared infrastructure (build before the steps it gates)

- **S1** — the layout-agnostic descriptor + `deriveAgentLayouts` + the 4-site field-order audit (§3.6). *Prerequisite for STEP 0.*
- **S2** — profile-driven `computeAgentMemoryLayout(profile)` gating **both** CPU and GPU lists from the same predicates; zeroes disabled strides. *Prerequisite for STEP 3; requires the §3.5 reorder before STEP 4.*
- **S3** — the `AgentCapabilities` profile on `model.centerBased`, carried into the store, consulted by **every** consumer: `snapshotAgentsForRender(store, profile)`, the Edit-panel row filter, `getAgentState` field selection, serialize/deserialize.
- **S4** — the mode-aware dependency graph (§3.3) as `agentCapabilityDependencies.ts`, consumed at the three gates. **Moved into STEP 1** (declarative/low-risk; STEP 1's preset UI + migration both need it).
- **S5** — usage-aware migration (§3.4) + versioned `AgentStatePayload`.
- **S6** — the cross-target layout + field-order audit script (§3.6) + a golden byte-identity harness (per shipped `.gcaproj`: JS `behaviourCode` SHA256 + WASM bytes SHA256 + WGSL SHA256 + ordered ABI descriptor + layout offsets, diffed on load) + a WebGPU L∞ harness (§7). *Wired into STEP 0/3/4/5 gates.*

---

## 5. De-risked build order

Every engine-touching step: `npx tsc -b` + `npm run build` clean; `parity-agent-wasm.mjs` **0 mismatches** (Full stays bit-identical throughout); `audit-agent-layout.mjs` green; WebGPU L∞ harness green where applicable.

**STEP 0 · Shared ABI derivation (prerequisite, lands no capability).** Build **S1** (layout-agnostic descriptor + `deriveAgentLayouts`); refactor the loop/division/init mirror pairs + the harness to consume it. *Gate:* the **4-site field-order audit** passes for Full (byte-identical to today); parity 0 mismatches. *Converts the harness from a 4th hand-copy into a consumer of the single source — the biggest desync-risk reduction.*

**STEP 1 · Editor-surface gating (SAFE — ship it).** Add the `AgentCapabilities` schema + **S4 dependency graph** (moved forward) + presets + **usage-aware migration (S5)** + the Properties "Agent Capabilities" panel (footprint bound to `computeAgentMemoryLayout`) + `requirements` capability tags on nodes (existing `isNodeAvailable`) + `hiddenPorts` on `Behaviour Step`/`Division Event` + the **agent-brush Edit-panel row filter** + the **`getAgentState` inspector field filter** + the **linked-agent-mapping gate** (skip/error a mapping on a gated attr; a model-level Properties badge) + **macro-internals informational re-validation** after `expandMacros`. **NO SoA/engine change.** ⚠ **`hiddenPorts` is purely cosmetic:** the compiler still emits the `myRadius` preamble, so **an existing wire into `myRadius` under Body=off keeps compiling**; the amber badge is **informational** (non-blocking) in v1 and becomes **blocking** only from STEP 3. *Gate:* every preset shows only its paradigm's nodes/ports/rows; the Full preset deep-equals Morphogenesis; all `.gcaproj` load byte-identically (`test-hidden-ports-compile`, `test-preset-ui`, `test-migration-inference`, `test-agent-mapping-gate`, `test-macro-internals`). **Delivers the entire clarity win at near-zero risk.**

**STEP 2 · Redraw the honest core (docs + validation commit, no SoA code).** Commit §2 into the plan (version it: PLAN v1.0 pre-impl, HANDOFF v1.1 binding). Turn the STEP-1 informational dependency badges into the committed validation surface. *(S4's enforcement already shipped in STEP 1 — STEP 2 is the documentation + the badge-severity contract, not new machinery.)*

**STEP 3 · First real SoA gate — Bonds + Field coupling (pipeline proof).** Gate the bond field group (90% there via `maxBonds=0`) + Field coupling through S1/S2. **Refactor `runAgentStructuralPhase` into capability-gated sub-steps** (`if(hasBonds) runBondFormBreak; if(hasDeath) runDeath; if(hasDivision) runDivision; if(bonds==='physics'&&autoBond) runAutoBond`) — each checks its arrays are allocated before iterating (**B2**). `_agentBondCount` **stays in the ABI** even when Bonds=off (**B1a**). Data-vs-Physics splits the spring pass in the force loop. Macro-internals re-validation becomes **blocking**. *Gate:* `audit-agent-layout` (now a STEP-3 gate, run for **Particle/Social-Graph/Vivarium**, not just Full), `test-bonds-allocation` (Bonds=off ⇒ `bondPartner/bondRestLength` zero-length; mem = `maxAgents·core`, no `+28·maxBonds`), `test-structural-guards` (each capability OFF ⇒ sub-pass provably skipped), WebGPU L∞. **Proves profile→ABI→layout end-to-end on the easiest capability.**

**STEP 4 · Append-at-stable-slot gates — Sprite-block · Lifespan · Growth · Division.** *(Retitled from "append-only" — Division has an unconditional structural read + reads `radius`/`bondCount`.)* **First: reorder `AGENT_*_FIELDS` to §3.5** (a standalone commit that must pass Full byte-identity + parity before any gate). Then gate each group at its stable slot; structural reads guarded together with allocation; dependencies enforced. Sprite-block: convert its **unconditional** ABI to the conditional template (the first such conversion — risk above Bonds). Lifespan: gate `age` + increment + `myAge` + **add a `Get Age` node**. Growth: decouple from bonding (a new ramp flag; `growthRate` no longer `→0` via `!usesBondingPhysics`). Division: add the fallback table (§3.3). *Gate:* parity **+ `audit-agent-layout` after EACH**, all presets.

**STEP 5 · Net-new capabilities (split, independent fail-fast gates).**
- **5a Spawn** (Population.Birth) — Spawn Event root (§3.7) + `deriveSpawnAbi` in S1 + `spawn*` fields + `initAgentSlot`/`freeAgentSlot` zeroing + the free-list/overflow/leak-sweep discipline. *Deps:* STEP 3 core + Motion (velocity payload). *Highest-risk net-new item.*
- **5b FOV + Sensing** — `Get Agents In View` / `Sense Hemifield` (AutomatosGT plan §4.2). *Deps:* Sensing; Orientation if `headingSource ≠ velocity`.
- **5c Orientation decoupled from Sprites** — split the sprite ABI monolith so `spriteRotations` threads under `(hasSprites OR hasOrientation)`. *Deps:* Appearance/`spriteRotations`.
*Gate (each):* parity + `audit-agent-layout` + WebGPU L∞ + browser end-to-end on JS/WASM/WebGPU, 2D+3D.

**STEP 6 · Deferred XL — Motion=Static + Body SoA-gate.** Only after 0–5. Explicit `Static` integrator/force-pass branches on JS 2D+3D + WASM + WebGPU + snapshot/serialize guards. **No `.gcaproj` breakage:** a Motion=Static file saved in STEP 1–5 (where the toggle was a no-op saved as intent) loads Static; the STEP-6 integrator branch replicates the STEP-1–5 always-on-but-unused velocity. Until STEP 6, Motion/Body are **palette-gated-only**.

---

## 6. Blocker & major-risk checklist (carry into every step)

- [ ] **B1 · Field-order audit before any field gate** (§3.6) — the arity assertion catches count mismatch but **not** order shifts under matched arity. *(STEP 0.)*
- [ ] **B1a · `_agentBondCount` stays in all 3 CPU ABI mirrors even when Bonds=off** — it is a core reduction; deleting it shifts every downstream param. *(STEP 3, `test-bondcount-param-invariant`.)*
- [ ] **B2 · `runAgentStructuralPhase` refactored into capability-gated sub-steps** — `killRequest`/`divideRequest`/`bondFormReq` reads go OOB the moment allocation is gated. *(STEP 3.)*
- [ ] **B3 · CPU and GPU layouts driven by the same predicates** — separate ordered lists; the audit checks field *sets* match. *(S2/S6.)*
- [x] **B4 · Motion/Body stay always-allocated in v1** — no `Static` path exists; SoA-gating is STEP 6.
- [ ] **B5 · Macro internals re-validated after `expandMacros`** — a `Divide`/`Form Bond` inside a macro bypasses palette gating; informational badge in STEP 1, blocking from STEP 3. *(STEP 1/3.)*
- [ ] **B6 · Linked agent output mappings on gated attributes gated** — a mapping on `radius`/`age` with the capability off dangles (`_undef`); skip/error + a model badge. *(STEP 1.)*
- [ ] **M1 · Versioned `AgentStatePayload`** — reject incompatible-profile loads loudly.
- [ ] **M2 · Retag + gate `density`** (`NeighbourDensityNode` off `{bondGraph}` → `{collision/sensing}`; the unconditional force-loop write gated).
- [ ] **M3 · Decouple Growth from bonding** (a new ramp flag).
- [ ] **M4 · Gate the spatial hash** (built unconditionally today; build only when Sensing or soft-Collision needs it).
- [ ] **M5 · The mode-aware dependency graph is one source consumed at all three gates** (UI auto-enable, compile validation, migration inference).
- [ ] **M6 · Migration is usage-*widened*** (config base + graph-scan union; never narrower than the graph uses).
- [ ] **M7 · `detectCapabilityRequirements` covers every capability-implying node** — including inside macros and the division/init/spawn/output-mapping roots — or migration under-widens.
- [ ] **M8 · Footprint readout bound to `computeAgentMemoryLayout(profile)`** (not a hand-typed number).

---

## 7. Verification test matrix

| Artifact | Steps | Asserts |
|---|---|---|
| `parity-agent-wasm.mjs` *(existing)* | 0,1,3,4,5 | JS↔WASM 0 mismatches on all 9 samples; **Full stays bit-identical throughout** |
| `audit-agent-layout.mjs` *(new, S1/S6)* | 0,3,4 | 4-site **field-order** match; GPU set === CPU set; 2D is a prefix of 3D; per-field `cType`/stride |
| `golden-byte-identity.mjs` *(new)* | 0,1,3 | per shipped `.gcaproj`: `behaviourCode`/WASM/WGSL SHA256 + ABI descriptor + layout offsets unchanged for Full/inferred |
| `verify-agent-webgpu-gate.mjs` *(new)* | 3,4,5 | GPU↔CPU **L∞** (spatial < 1e-4, scalar < 1e-3, counts exact), 20 steps — bit-parity is impossible (f32/PCG) |
| `test-migration-inference.mjs` *(new)* | 1 | every `maxBonds × useBondingPhysics × wired-node` combo infers the correct **widened** profile; compiled output unchanged |
| `test-bonds-allocation.mjs` *(new)* | 3 | Bonds=off ⇒ bond arrays zero-length; mem = `maxAgents·core` (no `+28·maxBonds`) |
| `test-structural-guards.mjs` *(new)* | 3,4 | each structural capability OFF ⇒ its sub-pass provably skipped (no OOB read) |
| `test-hidden-ports-compile.mjs` *(new)* | 1 | capability OFF + port WIRED ⇒ the field preamble is **present** in emitted code (no `undefined` at runtime) |
| `test-preset-ui.mjs` *(new)* | 1 | per preset: visible palette nodes + Behaviour-Step ports + Edit-panel rows == expected; footprint within ±2% of `computeAgentMemoryLayout` |
| `test-macro-internals.mjs` *(new)* | 1,3 | `Divide`/`Form Bond` inside a macro under a disabled cap ⇒ badge (STEP 1) / compile-error (STEP 3); macro field-coupling node vs `cellFieldAttrsOf` |
| `test-bondcount-param-invariant.mjs` *(new)* | 3 | `_agentBondCount` present in all 3 CPU mirrors regardless of `maxBonds` |
| `test-agent-mapping-gate.mjs` *(new)* | 1,3 | a linked agent mapping on a gated attr ⇒ skipped/errored + model badge |
| browser end-to-end | 5 | Spawn / FOV / Orientation on JS/WASM/WebGPU, 2D+3D |

---

## 8. Residual risks (accepted, watch)

- **The `AGENT_*_FIELDS` reorder (STEP 4 prereq)** touches CPU baked offsets, the WASM layout, and the GPU F32 list; a reorder byte-identical for Full but wrong for a gated profile only surfaces when a preset is tested → **run `audit-agent-layout` for Particle/Social-Graph/Vivarium, not just Full**.
- **WebGPU L∞ tolerances are a judgement call** — chaotic bond-physics/division models can exceed 1e-4 over 20 steps by legitimate f32 drift; the bands may need per-sample tuning + a documented "behavioural, not numerical" fallback for the heaviest models, or the gate false-fails.
- **The usage-aware migration scan depends on `detectCapabilityRequirements` completeness** (M7) — a missed node type silently under-widens (benign in STEP 1, a latent palette bug from STEP 3).
- **Spawn (5a) is the highest-risk net-new item** — a new structural mutation + free-list interaction (leak-sweep + overflow + sync-mode double-buffer), the same bug class that bit `agentInit`; needs the full parity + browser proof.
- **Division's Bonds fallback silently changes division geometry** when a Morphogenesis model disables Bonds (correct but unexpected) — surface Bonds as an "enhances Division" UI hint, not a silent switch.
- **Custom profiles multiply the test surface** — the matrix covers the paradigm presets, not arbitrary Custom combinations; the layout audit only catches a bad field-set if that exact combination is enumerated. Add a fuzz pass over dependency-valid Custom profiles if this becomes a support burden.

---

## 9. What ships when

| Milestone | Delivers | Risk |
|---|---|---|
| **STEP 0** | layout-agnostic ABI derivation + field-order audit | low |
| **STEP 1** | schema + S4 deps + presets + usage-aware migration + Properties panel + palette/port/Edit/mapping/macro gating → **the whole clarity win** | **near-zero** |
| **STEP 2** | honest-core doc commit + badge-severity contract | low |
| **STEP 3** | Bonds + Field-coupling SoA gate + structural sub-step refactor (pipeline proof) | medium |
| **STEP 4** | `AGENT_*_FIELDS` reorder + Sprite-block/Lifespan/Growth/Division gates | medium–high |
| **STEP 5a/b/c** | Spawn · FOV · Orientation (net-new) | 5a high, 5b/5c medium |
| **STEP 6** | Motion=Static · Body SoA-gate | high (XL) |

**The headline is unchanged and now hardened:** ship **STEP 0 + STEP 1** to deliver the entire "generic & universal" clarity win — a social-graph or particle author never sees morphogenesis machinery — at near-zero engine risk, *before touching a single SoA byte*. The three prerequisites (layout-agnostic ABI + field-order audit; the mode-aware dependency graph as one source; usage-widened migration) are what make everything after it safe; the concrete specs above are drop-in.

---

*Twice-audited (feasibility pressure-test + implementation-plan hardening review, 30 agents total across the two passes). Verdict GO-WITH-FIXES. v1.1 embeds the drafted `AgentCapabilities` type, the 7 presets, the mode-aware dependency graph, the usage-aware migration, the append-at-stable-slot field order, the layout-agnostic ABI descriptor + field-order audit, the Spawn Event spec, and the full verification matrix — so an implementer can build STEP 0 + STEP 1 today and gate the genuinely-appendable capabilities behind proven, tested prerequisites.*
