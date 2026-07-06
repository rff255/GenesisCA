# Agent Capability Profiles — making the agent engine genuinely universal

*A composable, opt-in decomposition of the agent engine so a model includes only the capabilities it needs — turning the current "center-based soft-body cell" monolith into a substrate that serves particle physics, morphogenesis, vivarium/flocking ecologies, social-network graphs, and abstract agent-CA equally. Absorbs the AutomatosGT-inspired features (directional FOV, runtime spawn) as capabilities rather than bolting them onto a fixed agent.*

**Companion:** [PLAN_AGENT_CAPABILITY_PROFILES.html](PLAN_AGENT_CAPABILITY_PROFILES.html) (illustrated). **Predecessor:** [ANALYSIS_AUTOMATOSGT_AGENTS.md](ANALYSIS_AUTOMATOSGT_AGENTS.md).

> ⚠️ **Pressure-tested — read the handoff for the corrected, authoritative version.** A 15-agent adversarial source audit found this plan **materially overclaims two load-bearing things** (inline-corrected below): (1) `hasAgentSprites` does **not** conditionally ABI-mirror its block — sprites are *unconditionally* threaded; the real template is `hasLookupTables` / the `is3d` trailing block / `agentAccess`. (2) The irreducible core is really **id + alive + position + velocity + force + radius** — those are read *unconditionally* by the integrator, render snapshot, serialize, and the compiled preamble, so **Motion & Body cannot be SoA-gated in v1** (palette-gate only; SoA-gating them is a deferred XL milestone). Layout is **recomputed per profile**, not append-only. The de-risked build order, the shared-infrastructure prerequisite, and the corrected migration live in **[HANDOFF_AGENT_CAPABILITY_PROFILES.md](HANDOFF_AGENT_CAPABILITY_PROFILES.md)** — treat the handoff as authoritative where the two disagree.

---

## 1. The problem — a paradigm is baked into "the agent"

GenesisCA's grid is genuinely generic (attributes, neighbourhoods, mappings — you compose the model). The **agent** is not: it hard-codes one paradigm — a **center-based, soft-body, dividing, bonded cell** — into every agent's structure and the engine's step, whether or not the model uses it.

### What is actually intrinsic today (verified in `agentEngine.ts`)

Every agent, in every model, unconditionally carries:

| Group | Fields | Bytes/agent |
|---|---|---|
| Position (+ integrator double-buffer) | `x,y,z, xNext,yNext,zNext` | 48 |
| Velocity | `vx,vy,vz` | 24 |
| Force accumulator | `forceX,forceY,forceZ` | 24 |
| Body + growth | `radius, targetRadius` | 16 |
| Lifespan | `age` | 8 |
| Division | `divideAxisX/Y/Z, divideAsym, divideRequest` | 33 |
| Bond-form request | `bondFormL, bondFormK, bondFormReq, bondBreakReq` | 24 |
| Reductions / identity | `density, lineage, epoch, bondCount` | 20 |
| Lifecycle flags | `alive, killRequest` | 2 |
| Appearance | `colors` (RGBA) | 4 |
| Bond store (× maxBonds) | `bondPartner/Epoch/TypeLabel, bondRestLength/Stiffness` | 28·maxBonds |

That's **~203 bytes of intrinsic per-agent state + the bond store**, *before* any user attribute. And even the 3D fields (`z, zNext, vz, forceZ, divideAxisZ` = 40 bytes) are allocated in the CPU store for **2D** models.

### The two costs

1. **Conceptual / UX pollution (the one you flagged).** The intrinsic fields surface as **node ports and palette entries that make no sense** for the model at hand. `Behaviour Step` always outputs `myRadius`, `myArea`, `myBondDegree`, `myAge`; the palette always offers `Get Radius`, `Set Target Radius`, `Get Bond Degree`, `Divide Agent`, the whole bond family. A sociologist building a social-network graph, or a physicist building a particle system, is confronted with morphogenesis machinery they will never use — which *directly contradicts* the "generic and universal" promise. The generality is muddied at the exact moment the user is trying to reason about their model.
2. **Memory & compute at scale.** A 100k-node social graph pays ~20 MB for force/division/growth/velocity fields it never touches, plus an engine step that integrates forces nobody applied. A pure particle system pays for a bond store, division axes, and `bondCount` reductions it never reads.

### The codebase already agrees with you

This isn't a new idea fighting the architecture — it's the architecture's *own trajectory*, half-finished:

- **The built-in agent `type` was deliberately removed** (`agentTypeRemovalMigration.ts`) to make agents carry *only* user attributes. That was step one of exactly this principle.
- **`maxBonds = 0` already collapses the bond store to zero bytes** (`resolveMaxBonds` floors at 0).
- **`useBondingPhysics` already gates** soft-sphere + bond springs + growth + auto-bond behind one master toggle (`usesBondingPhysics(cfg)`), with a zero-migration fallback (`?? !customForcesOnly`).
- **Conditional ABI-mirroring already exists** — `hasLookupTables` appends `_lookupTables` to all three mirrors only when a lookup-table attribute is present, the `is3d` trailing block appends the z-fields only in 3D, and `agentAccess`/`cellFieldAttrsOf` prunes the `_field_` block. *(Correction: the sprite block is **not** an example — sprites are unconditionally threaded, the code comment says "Always threaded"; converting Appearance to a real capability would itself need this template.)*
- **`computeMemoryLayout(gridCells)` already drops** per-cell regions when the grid layer is off.
- **`hiddenPorts(config, model)` already conditionally hides ports** — it is on `Behaviour Step` this instant, hiding `myZ` in 2D.

**The fix is to generalize these four ad-hoc gates into one coherent, dependency-aware system.** No new mechanism is invented; the existing ones are unified and extended to the fields and behaviours that are still hard-coded.

---

## 2. The principle — compose the agent from opt-in capabilities

An agent's structure and the engine's per-step behaviour are **composed from a declared set of capability modules**. A model's **Agent Capability Profile** is the single source of truth from which everything derives:

- **SoA fields** — a capability's fields are allocated only when it's on (the `gridCells` / `maxBonds=0` / `cellFieldAttrsOf` pattern, generalized; the layout is recomputed per profile).
- **Engine step** — a capability contributes its force term / integrator / structural pass only when on (the `useBondingPhysics` pattern, generalized).
- **Palette nodes** — a capability's nodes appear only when on (`requirements`, generalized — same machinery as `bondGraph`/`variegated`/`lattice2d`).
- **Node ports** — intrinsic ports appear only when their capability is on (`hiddenPorts`, generalized).
- **Properties UI** — a capability shows its sub-panel + params only when on.

**The irreducible core** (always present — read every step by the integrator, render snapshot, serialize, and the compiled preamble): a slot **id**, an **`alive`** flag, **position** (`x,y[,z]` + the `Next` double-buffer), **velocity** (`vx,vy[,vz]`), **force** (`forceX,forceY[,forceZ]`), **radius**, and the user's **agent attributes**. *(Corrected per the pressure test: velocity/force/radius are NOT freely gate-able — there is no `Static` path in the engine, so they stay always-allocated in v1 and are hidden at the palette/port level only; SoA-gating them is the deferred XL milestone.)* Everything above the core — Bonds, Collision, Growth, Division, Lifespan, Population, Orientation, Sensing, Field coupling, the Sprite block — is a capability.

**Presets snap the paradigms.** Most users pick a preset (Particle System, Morphogenesis, Vivarium, Social Graph, …); the module toggles are progressive disclosure for power users. Because the graph editor only ever shows the ports and palette nodes for enabled capabilities, **the net effect is dramatically *less* confusion** — a social-graph modeler never sees `radius`, `force`, or `Divide Agent` at all.

---

## 3. The capability modules

Two kinds: **state** capabilities add per-agent fields (+ their nodes/ports); **behaviour** capabilities add an automatic engine step (+ its params) and usually depend on a state capability. Dependencies are auto-enforced (enabling a dependent auto-enables its prerequisite, exactly as enabling bonding physics already bumps `maxBonds` off 0).

| Capability | Kind | Provides (fields · nodes · ports) | Engine contribution | Depends on |
|---|---|---|---|---|
| **Position** *(core)* | state | `x,y[,z]`; `Set/Get Agent Position`, `Get Agent Offset`; `myX/Y[/Z]` | — (rendered; spatial-hashed) | — |
| **Motion** | state+behaviour | mode **Static / Velocity / Force**. Velocity→`vx,vy[,vz]`; Force→ +`forceX/Y[/Z]`, `xNext/yNext`. `Set Velocity`, `Apply Force`, `Get Velocity` | Static: writes go direct. Velocity: `pos += v·dt`. Force: `v = inertia·v + (dt/η)·F; pos += v` | Position |
| ↳ **Inertia** (momentum) | param | `momentum` slider | keeps velocity between steps | Motion=Force |
| ↳ **Drag / damping** | param | `η` (drag) | overdamped relaxation | Motion=Force |
| ↳ **Speed limit** | param | `maxSpeed` | caps `|v|` | Motion=Force |
| **Body / Extent** | state | `radius`; `Get/Set Agent Radius`; `myRadius`, `myArea` | render as disc/sphere (else point) | Position |
| **Collision** | behaviour | mode **Soft-sphere / Positional**; `density`; `Neighbour Density` | soft repulsion/adhesion force **or** hard penetration correction (AutomatosGT-style) | Body (+ Motion=Force for soft) |
| **Bonds** | state+behaviour | mode **Data / Physics**. Data→ bond store, `epoch`, `bondCount`; `Form/Break Bond`, `For Each Bond`, `Get Bonded Agents`, `Get Bond Degree`; `myBondDegree`; **edge rendering**. Physics→ +`bondRestLength/Stiffness/bondForm*` | Data: none (connectivity only). Physics: spring forces | Position (+ Motion=Force for Physics) |
| ↳ **Auto-bond** | behaviour | `autoBond`, form/break distances | engine forms/breaks bonds by proximity | Bonds |
| **Growth** | behaviour | `targetRadius`, `growthRate`; `Set Target Radius` | `radius → targetRadius` per step | Body |
| **Division** | state+behaviour | `divideAxis*, divideAsym, divideRequest`; `Divide Agent`; **Division Event** root | structural-phase split (tension-axis eigensolve; spread-axis fallback) | Position (Bonds for the mechanical axis) |
| **Lifespan** | state+behaviour | `age`; `Get Age`; `myAge` | auto-increment `age` | — |
| **Population** | state+behaviour | birth: `spawn*` + **Spawn Agent** node + **Spawn Event** root; death: `killRequest` + **Kill Agent**; `maxAgents` | structural-phase spawn / free-list death | Position |
| **Orientation / facing** | state | `facing` (reuse `spriteRotations`); heading for FOV, sprite rotation, rigid-carry | — | Position |
| **Sensing** | behaviour | spatial hash; `Get Nearby Agents`; **`Get Agents In View`**, **`Sense Hemifield`** (directional FOV) | builds the neighbour hash | Position (auto-on when a query or Collision is used) |
| **Field coupling** | behaviour | `Sample Field`, `Field Gradient`, `Read/Affect Cells Under`, `Secrete To Field` | agent ⇄ cell-grid morphogen bridge | a cell attr with `agentAccess` (already gated) |
| **Appearance** | state | per-agent `colors` (only if an output mapping / Set Cell Looks writes it); sprites (already `hasAgentSprites`) | render | Position |

> **Directional FOV** (from the AutomatosGT plan) is the **Sensing** module's cone variant + **Orientation** for the heading. **Runtime spawn** is the **Population** module's birth half. **Carrying** is **Bonds = Data** (edges, no springs) + `Set Agent Position`. They stop being special cases and become natural members of the capability set.

---

## 4. Paradigm presets

A preset is a named set of enabled capabilities + sensible params. Selecting one sets the toggles; editing any toggle flips the picker to **Custom**.

| Capability → / Preset ↓ | Motion | Body | Collision | Bonds | Growth | Division | Lifespan | Population | Sensing | Orientation |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Particle System** | Force +inertia +drag +maxSpeed | ○ | ○ soft | — | — | — | — | — | ○ | — |
| **Boids / Flocking** | Force +inertia +drag | ○ | — | — | — | — | — | — | ● FOV | ● |
| **Vivarium / Ecology** | Force +inertia +drag | ○ | ○ | — | — | ○ | ● | ● birth+death | ● FOV | ● |
| **Morphogenesis / Cells** *(= today)* | Force | ● | ● soft | ● Physics +auto | ● | ● | ● | ● | ● | ○ |
| **Social Network / Graph** | Static *(or layout)* | — | — | ● **Data** | — | — | — | — | ○ | — |
| **CA-on-Agents** | Static | ○ | — | ○ Data | — | — | — | — | ● | — |
| **Blank / Custom** | — | — | — | — | — | — | — | — | — | — |

● default-on · ○ optional/available · — off. *"Social Network" is the key proof: bonds as pure **data** (visualize + traverse edges, no springs), static/computed layout, and none of radius/force/division/age exist — the graph editor shows only Position, Bonds, attributes, and Sensing.*

---

## 5. How it gates — extending four proven mechanisms

Nothing here is speculative; each row extends a mechanism already in the codebase:

| Concern | Existing mechanism | Generalization |
|---|---|---|
| **SoA allocation** | `computeMemoryLayout(gridCells)` drops cell regions; `maxBonds=0` drops the bond store; the `_field_` block drops via `cellFieldAttrsOf` | `computeAgentMemoryLayout(profile, …)` **recomputes** the layout per profile, including a gate-able group only when its capability is on (via the append-at-a-stable-slot template). *(Corrected: NOT "append-only, offsets byte-identical" — the field lists are interleaved, so omitting one shifts downstream offsets; byte-identity holds only when the profile is held constant across targets. The CPU `AGENT_F64_FIELDS` and WebGPU `AGENT_GPU_F32_FIELDS` are separate ordered lists and must be gated together.)* |
| **Engine step** | `usesBondingPhysics(cfg)` skips soft-sphere/springs/growth/auto-bond | Each capability's step contribution is guarded by its flag. `runAgentStep` composes {velocity/force integrate, collision, springs, growth} from the profile; the structural phase composes {division, spawn, death, auto-bond}. Motion=Static skips the integrator entirely. |
| **Palette** | `requirements: {bondGraph, variegated, lattice2d, async}` + `isNodeAvailable` hide nodes | Add capability tags (`requires: {body}`, `{motion:'force'}`, `{bonds:true}`, `{division}`, `{lifespan}`, `{population}`) consulted by the same `isNodeAvailable`. Disabled-capability nodes vanish from palette / quick-add / connection-drop; placed violators get the amber badge. |
| **Ports** | `hiddenPorts(config, model)` hides `myZ` in 2D | `Behaviour Step` hides `myRadius`/`myArea` (Body off), `myBondDegree` (Bonds off), `myAge` (Lifespan off). `Division Event` / `Spawn Event` ports gate likewise. |
| **ABI mirrors** | `hasLookupTables` / the `is3d` trailing block conditionally append params to `buildAgentLoopParams`/`Args`/harness `buildArgs` | Each capability's params conditionally join the mirror pairs via **one shared `deriveAgentAbi(profile)` descriptor source** consumed by all four sites (the three mirrors + the parity harness) — a prerequisite (STEP 0) so the harness stops being a hand-written 4th copy that can silently desync. |

**The one real discipline:** a field group and its engine-step contribution must be gated **together** — omit `forceX/Y` *and* skip the force integrate; omit the bond store *and* skip spring/auto-bond passes. This is precisely what `gridCells:false` (drop regions + skip cell step) and `useBondingPhysics:false` (skip physics) already do; the implementer follows that template per capability and re-runs the parity harness (0 mismatches) after each.

---

## 6. UI / UX

**Model Properties → new "Agent Capabilities" section** (shown only when `topologyMode.agents`), placed above the existing Bond-Graph Agents numeric params:

1. **Preset picker** (a row of paradigm chips: Particle · Boids · Vivarium · Morphogenesis · Social Graph · CA-on-Agents · Custom). Picking one sets the toggles; editing a toggle → "Custom." A one-line description of the selected paradigm sits under it.
2. **Capability rows** (progressive disclosure) — each is an enable toggle + (when on) its params + a live "unlocks: `Apply Force`, `Get Velocity` · adds ports: —" hint. Dependencies auto-enable/disable and are shown (e.g. toggling **Collision** on auto-enables **Body**; **Bonds=Physics** requires **Motion=Force**).
3. **Motion** is a segmented control (Static / Velocity / Force), revealing inertia/drag/maxSpeed only in Force mode.
4. **Live per-agent footprint** — a small "≈ N bytes/agent · M nodes · K ports" readout that updates as capabilities toggle, making the cost of generality legible (a genuinely nice touch — the user *sees* the social-graph agent shrink to a fraction of the morphogenesis agent).

**The compounding UX win:** because the palette, the quick-add/connection-drop menus, and the `Behaviour Step` ports all filter to enabled capabilities, the graph a user builds is *scoped to their paradigm*. The social-network author literally cannot see (and cannot accidentally wire) `radius`, `force`, or division. That is the "generic and universal" promise delivered — universality by *composition*, not by piling every feature onto one fixed agent.

**Simulator side:** the render already adapts (points vs discs vs spheres; bonds drawn iff Bonds on; the agent brush's Edit panel already enumerates geometry rows — gate those to enabled capabilities too). The AutomatosGT-inspired follow-camera / drag-velocity / cone-overlay from the predecessor plan slot in unchanged.

---

## 7. Migration & back-compat (non-negotiable)

Every existing `.gcaproj` and every shipped sample must load byte-identically. The pattern is the proven `useBondingPhysics ?? !customForcesOnly` one:

- **Absent profile ⇒ a config-aware inference** *(corrected — a flat "always Full" is wrong: new models ship `maxBonds:0` + `useBondingPhysics:false`, which can't allocate a bond store)*: absent + `maxBonds:0` ⇒ **Particle** (no bonds); absent + `maxBonds>0` / `useBondingPhysics` ⇒ **Full / Morphogenesis** (all on). Both reproduce today's behaviour for the file in hand; legacy files stay byte-identical.
- **New models** start from a chosen preset (default: whichever the "New Agent Model" flow offers — likely Vivarium or Boids, not the heavyweight Full).
- **Optional smarter migration** (nice-to-have): infer a *tighter* profile for a legacy file by scanning its agent graph for which intrinsic nodes/ports are actually wired, then enable only those — but only when it's provably behaviour-preserving (else fall back to Full). Ship the safe "legacy ⇒ Full" first.
- The existing `customForcesOnly` / `useBondingPhysics` / `topologyMode` / `agentTarget` fields fold into the profile (or are derived from it) without losing their current semantics.

---

## 8. How the AutomatosGT features re-slot (revising the predecessor plan)

The predecessor plan proposed FOV and Spawn as additions to a fixed agent. Under capability profiles they become **capability members**, which is cleaner and answers the exact "don't muddy the generality" concern:

- **Directional FOV** → the **Sensing** capability's cone nodes (`Get Agents In View`, `Sense Hemifield`) + the **Orientation** capability for the heading source. They appear only when Sensing (and, for stored-facing, Orientation) is on — a physics-particle or social-graph model never sees them.
- **Runtime spawn** → the **Population** capability's birth half (`Spawn Agent` + `Spawn Event`). A fixed-population model (morphogenesis-without-birth, or a static graph) never sees it. `Kill Agent` is the death half of the same capability.
- **Carry / attachment** → **Bonds = Data** + `Set Agent Position` — no springs, no physics; the mutex is a user bool attribute. It's the *same* mechanism the social-network preset uses, which is the point.
- **State machine / kinds / corpse / lifecycle** → unchanged from the predecessor plan (attributes + `Switch` + macros); **Lifespan** gates the `age`/`myAge` surface so a model that doesn't age never sees it.

---

## 9. Honest notes

- **Position stays core.** An agent without a position isn't a spatial agent. (Even a social graph wants layout positions — computed by a force-directed *Motion=Force* pass, or set directly in *Static* mode.)
- **Presets prevent toggle-overload.** ~10 capabilities is a lot of switches; the preset picker is the front door, module toggles are for power users, and dependency auto-enforcement keeps invalid combinations from arising.
- **The primary win is clarity; the memory win is real but secondary** for small populations and large for big ones (a 100k-node social graph or a million-particle system stops paying for morphogenesis fields). Both are worth it; lead with clarity.
- **All-target discipline is unchanged.** Every capability must gate identically across JS/WASM/WebGPU and 2D/3D, and edit the three ABI mirror pairs together — the same rule every agent feature already follows.
- **Don't over-fragment.** Inertia/drag/maxSpeed are *params of Motion=Force*, not separate capabilities; Growth+Division could even share a "Morphogenesis" toggle. Keep the module count at the coarsest grouping that still cleanly separates the paradigms in the preset matrix.

---

## 10. Roadmap

Sequenced so the **clarity win lands first at low risk**, memory/compute wins follow, and the new capabilities arrive already-modular.

**Phase 1 — Profile schema + presets + port/palette gating (clarity, low risk).**
Add `AgentCapabilities` to the schema + the "legacy ⇒ Full" migration. Wire `requirements` capability tags on the existing agent nodes and `hiddenPorts` on `Behaviour Step` / `Division Event`. Build the Properties "Agent Capabilities" panel + preset picker + footprint readout. **No engine/SoA change yet** — capabilities gate only the *editor surface* (palette + ports + UI). This alone delivers the "generic and universal" feel: each paradigm shows only its relevant nodes/ports. *Effort: M.*

**Phase 2 — Conditional SoA + engine-step composition (memory/compute).**
Extend `computeAgentMemoryLayout` + the three ABI mirrors to include each field group per the profile; compose `runAgentStep` + the structural phase from the enabled behaviours (Motion=Static skips the integrator; no-Bonds skips springs/auto-bond; etc.). Re-run the parity harness after each capability. *Effort: L (careful, but each capability is a `gridCells:false`-style gate).*

**Phase 3 — New capabilities as modules: Directional FOV (Sensing) + Runtime Spawn (Population) + the AutomatosGT idioms/gallery.**
The predecessor plan's build items, now landing as capability members. *Effort: M (per the predecessor plan).*

**Phase 4 — Social-graph & particle-system first-class support.**
The two paradigms the current engine serves *worst*: **Bonds=Data edge rendering + a force-directed layout Motion mode** (social networks), and a **Motion=Force particle preset** with inertia/drag/collision tuned for physics. Each is mostly a preset + a small render/layout addition once Phases 1–2 exist. Ship sample models (a social-network layout; an N-body / SPH-lite particle demo) alongside the vivarium gallery. *Effort: M.*

---

*This reframes the agent platform from "one fixed cell that does everything" to "compose the agent you need." It resolves the generality critique at its root (the intrinsic attributes and engine physics become opt-in), it makes the AutomatosGT features clean capability members rather than bolt-ons, and it unlocks paradigms the current engine can't express cleanly — social-network graphs, pure particle systems, abstract agent-CA — while keeping morphogenesis as simply the "everything on" preset. Every step extends a gating mechanism already in the codebase; nothing new is invented, and legacy models stay byte-identical.*
