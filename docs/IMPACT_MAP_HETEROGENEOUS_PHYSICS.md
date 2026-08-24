# Impact Map — Heterogeneous Agent Physics (per-agent participation + per-pair interaction classes)

**Status: DESIGN ONLY.** No implementation follows immediately. This document is the durable
decision record — the today-story, the candidate designs with an honest cross-target cost table,
the recommended shape, the phased plan, and the deferred/rejected register.

Three user asks, one design space:

1. *"Make basic agent properties like collision, bonds and other things not be global, and instead
   defined during agent creation. Also have a way to determine how properties that pertain to the
   interaction between agents (like bond properties) work between only a set of agents determined by
   an attribute value — so the user can define rules for how certain agents interact in certain ways
   with some agents and in other ways with other agents."*
2. *"How would it currently be if we wanted some agents to follow the global physics options and
   others not? I take it that in the case of heterogeneous agents, right now the user would have to
   not use the global physics options, and model it manually as part of their behaviour rule, right?"*
3. The long-standing bond/edge-attributes thread (largely shipped as GRA P2/P3; the *interaction
   class* half is not).

Ask #2 is **confirmed correct, with two nuances** — see §1.

---

## 0. Verified baseline facts (read 2026-08-24)

Everything below was read in the tree, not recalled. These are the load-bearing facts the design rests on.

| # | Fact | Evidence |
|---|---|---|
| F1 | **Every engine physics knob is a MODEL-level scalar.** `repulsionStiffness`, `adhesionStiffness`, `interactionRange`, `chargeStrength`, `chargeMaxDist`, `momentum`, `maxSpeed`, `drag`, `timeStep`, `growthRate`, `formDistance`, `breakDistance` are all `number` on `CenterBasedConfig`. | [types.ts](../src/model/types.ts):1199–1323 |
| F2 | **`collision` / `bonds` / `motion` / `growth` / `charge` are MODEL-level capabilities.** `collisionMode(cfg)`, `usesSoftCollision(cfg)`, `usesEngineSprings(cfg)`, `usesEngineGrowth(cfg)`, `usesCharge(cfg)`, `agentMotionMode(cfg)` all take the model config and nothing else. | [centerBased.ts](../src/model/centerBased.ts):94–112, 347–369; [agentFieldGating.ts](../src/model/agentFieldGating.ts):168 |
| F3 | **The pair loop reads only `x/y/z` + `radius` for the neighbour** (`alive[j]` too, on the all-pairs fallback). No user attribute, no mask, nothing else. | JS [sim.worker.ts](../src/simulator/engine/sim.worker.ts):2647–2673 (3D) / 2844–2870 (2D); WASM `emitForcePass` candidate body [agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts):4928–5017; WGSL `neighbourBody` [agentWebgpu/forcePass.ts](../src/modeler/vpl/compiler/agentWebgpu/forcePass.ts):259–286 |
| F4 | **Contact distance is hardcoded `sij = ri + rad[j]`** at all four engine sites (soft 2D/3D hashed + all-pairs, and the positional projection). `rmax = range * sij` with ONE global multiplier. | [sim.worker.ts](../src/simulator/engine/sim.worker.ts):2664–2665, 2692–2693, 2856–2857; [agentEngine.ts](../src/simulator/engine/agentEngine.ts):2651–2655 |
| F5 | **Bond springs are ALREADY per-pair.** `bondRestLength` / `bondStiffness` are per-SLOT `Float64Array`s in the ragged bond store, and the spring force reads them per bond. | [agentEngine.ts](../src/simulator/engine/agentEngine.ts):348, 683–684, 1024–1025; force read [sim.worker.ts](../src/simulator/engine/sim.worker.ts):2784 |
| F6 | **Form Bond exposes both spring parameters as wired value inputs**, resolved with a `0 ⇒ default` rule in the structural phase. So `Table Lookup[myClass][theirClass] → Form Bond.stiffness` works today. | `FormBondNode.ts`:42–43; resolution [agentEngine.ts](../src/simulator/engine/agentEngine.ts):1697–1698 |
| F7 | **`CenterBasedConfig.bondSpringMatrixId` EXISTS IN THE SCHEMA AND IS DEAD.** Documented verbatim as *"`lookupTable` model-attribute id giving per-type-pair bond stiffness λ + rest length L. Absent → a single global λ/L"* — and a repo-wide grep finds **exactly one hit: the declaration itself.** The neighbouring `bondStiffness` / `bondRestLength` comments already call themselves *"used when no spring matrix is set"*. **The declarative per-pair spring matrix was designed and never implemented.** | [types.ts](../src/model/types.ts):1342–1344 |
| F8 | **A per-bond `bondTypeLabel` i32 slot exists, rides the ABI, and NOTHING in the engine reads it for physics** — its only consumer is the bond inspector. | [agentEngine.ts](../src/simulator/engine/agentEngine.ts):347, 685; ABI [agentAbi.ts](../src/modeler/vpl/compiler/agentAbi.ts):312; sole reader [sim.worker.ts](../src/simulator/engine/sim.worker.ts):8961 |
| F9 | **Agent attributes are reachable from the force pass on every target, with no new transport.** JS: the loop is in the worker with `s.attrRead` in scope. WASM: `emitForcePass` receives the whole `AgentMemoryLayout`, so `L.attrOffset[id]` is directly addressable. WebGPU: user attribute runs live **inside `agentF32`**, which the force pass binds at **binding 0**. | [agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts):4849–4857, 553; [agentWebgpu/layout.ts](../src/modeler/vpl/compiler/agentWebgpu/layout.ts):393–394; binding [agentWebgpu/forcePass.ts](../src/modeler/vpl/compiler/agentWebgpu/forcePass.ts):417 |
| F10 | **Lookup TABLES are reachable from the WASM force pass today** (one shared linear memory; `L.lookupTableOffset[id]` is on the same layout object, and the worker copies the tables in at :2501, *before* the force call) — **but NOT from the WGSL force pass.** Tables live in `auxF32`, declared only on the BEHAVIOUR shader at `@binding(9)`. The force BGL declares 0,1,2,3 (+4,5,6,7,8). | WASM [agentEngine.ts](../src/simulator/engine/agentEngine.ts):489–504, copy-in [sim.worker.ts](../src/simulator/engine/sim.worker.ts):2501; GPU table region [agentWebgpu/layout.ts](../src/modeler/vpl/compiler/agentWebgpu/layout.ts):466–487; binding 9 only in [agentWebgpu/compile.ts](../src/modeler/vpl/compiler/agentWebgpu/compile.ts):4511; force BGL [agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts):641–669 + resident mirror :4310–4351 |
| F11 | **The WGSL force pass has NO bond-spring block at all.** `doSprings` is not even a `ForceControl` member. Springs exist only in the JS loop and the WASM `emitBondSprings`. | [agentWebgpu/forcePass.ts](../src/modeler/vpl/compiler/agentWebgpu/forcePass.ts) (no spring emit); WASM [agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts):5424–5480 |
| F12 | **`ForceControl` has a 12-byte budget left.** 33 members × 4 B = 132; `FORCE_CONTROL_BYTES = 144`. **Three more scalars are free**; a fourth needs a bump to 160 or the layout harness's `declared - parsed.size < 16` band fails. It IS registered in the harness. | [agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts):424; registry [verify-render-uniform-layouts.mjs](../scripts/verify-render-uniform-layouts.mjs):160–162, band check :193–195 |
| F13 | **The WASM force pass has three declared arities — 26 / 30 / 32** — via append-only blocks (`FORCE_PASS_PARAMS` + `CHARGE_PASS_PARAMS` + `CHARGE_GLOBAL_PASS_PARAMS`), with a `-1 ⇒ block absent` index sentinel and the worker passing all 32 unconditionally. | [agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts):4767–4798, 4800–4823; worker :2588–2607; asserted [parity-agent-force.mjs](../scripts/parity-agent-force.mjs):626–661 |
| F14 | **On the GPU, the sync attribute commit runs AFTER the force pass** — and the code comment states the exact invariant this feature would break: *"the force pass touches only geometry/velocity, never a user attribute, so its position here is immaterial."* On JS/WASM, `swapAgentAttrs` runs BEFORE the force loop. | [agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts):1623–1648 (comment :1636–1641); JS order [sim.worker.ts](../src/simulator/engine/sim.worker.ts):2542 then :2558 |
| F15 | **The `Δt` stability clamp reads the SCALAR stiffnesses only** — `μ_eff = repulsionStiffness + bondStiffness`, `dt = min(timeStep, 0.2/μ_eff)`. It does not know about per-bond λ, **so a latent too-loose `dt` already exists today** for any model that forms bonds with a stiffness above the config scalar (F6 makes that reachable from the graph). | [centerBased.ts](../src/model/centerBased.ts):450–458 |
| F16 | **The spatial-hash bin edge is derived from `interactionRange` + `neighbourQueryRadius` + `chargeBinEdgeOf`.** The documented trap: any force whose reach can exceed the bin edge is *silently truncated* by the 3×3(×3) stencil — plausible-looking, wrong physics, no error. | [sim.worker.ts](../src/simulator/engine/sim.worker.ts):2393–2399 |
| F17 | **The per-pair physics is >99 % of an agent generation**; cost ∝ `N × density × queryRadius²`. The pair COUNT is the lever, not the compile target. Reference candidate counts: 2D 124/agent at 4× rest, 427 at 8×; 3D 813 / 1728. | CLAUDE.md "Measured truths"; [PERF_REVIEW_AGENT_ENGINE.md](PERF_REVIEW_AGENT_ENGINE.md):53–62 |
| F18 | **The B1 mirror's field list is a pure function of dimensionality** (`agentMirrorFields(is3d)` → `['x','y','radius','vx','vy']` / +z), so it **cannot express a per-model attribute name**. The mirror path does expose the canonical id (`j = sortedId[sp]`), so an uncoalesced `agentF32[base + j]` read is available there. | [agentWebgpu/forcePass.ts](../src/modeler/vpl/compiler/agentWebgpu/forcePass.ts):53–60, 294–301 |

---

## 1. Option 0 — the today-story, told honestly

### 1.1 Heterogeneity that ALREADY works

- **Bond springs are fully per-pair.** `restLength` and `stiffness` are per-slot store fields (F5) and Form Bond exposes both as wired ports resolved `0 ⇒ default` (F6). So
  `Table Lookup(stiffnessMatrix)[myClass][theirClass] → Form Bond.stiffness` **works today**, and the
  bond inspector can edit a single edge's λ/L live. This is the one place ask #1 is already answered —
  *at formation time*.
- **Contact distance is already per-pair**, because `sij = ri + rj` (F4). Two big agents repel from
  further apart than two small ones. What is *not* per-pair is the **stiffness** μ_R and the range
  **multiplier**.
- **Per-pair force LAWS of arbitrary complexity** are expressible in the behaviour graph — this is the
  shipped **Particle Life** pattern: a `species` tag agent attribute indexes three `species × species`
  float `lookupTable` model attributes (`rules` / `attractMin` / `attractMax`) through
  `lookupInteraction`, and the result feeds `applyForce`
  ([gen-particle-life.mjs](../scripts/gen-particle-life.mjs):194–254, 257–265).
- **Growth is per-agent-opt-outable** by accident: the ramp is a no-op when `targetRadius === radius`,
  so an agent that never sets a target simply does not grow.
- **A "frozen" agent is expressible in a `motion: 'force'` model** *if* collision is off: with
  `momentum: 0` and no force applied, `v = 0·v + (Δt/η)·0 = 0`.

### 1.2 Where the real walls are

- **Engine soft collision is all-agents-or-nothing.** The loop gates on nothing but liveness and
  radius (F3, F4) — there is no per-agent flag to read. **And shrinking a radius does not opt an agent
  out**: with `ri = 0`, `sij = rad[j] > 0`, so it is still pushed. Both agents would have to be radius
  0, which also kills the disc render and every `ri+rj`-derived quantity (auto-bond distances, the
  default bond rest length).
- **Same for adhesion, charge, positional collision, auto-bond, growth rate, momentum, maxSpeed,
  drag, Δt, and the motion mode** — all model-global (F1, F2).
- **The graph can only ADD to the force accumulator.** Everything a rule computes lands in
  `forceX/Y/Z` via Apply Force; there is no way to subtract or reshape an engine force. So per-pair
  physics today is **all-graph or all-engine**, never a mixture.
- **Interaction CLASSES do not exist as an engine concept** — the class→coefficient step is a
  user-authored node chain, not a resolver the force pass consults.

### 1.3 The answer to ask #2, precisely

**Yes — with two corrections.** Today, a model that needs heterogeneous physics must turn the engine
force off model-wide and re-author it in the behaviour graph. Particle Life is exactly that: it ships
`repulsionStiffness: 0`, `collision: 'off'`, `bonds: 'off'`, `useBondingPhysics: false`, and rebuilds
short-range repulsion as `repel·(d/minR − 1)` in nodes
([gen-particle-life.mjs](../scripts/gen-particle-life.mjs):331–347).

The two corrections:

1. **Bond springs are the exception** — they are already per-pair (§1.1), so "manually in the
   behaviour rule" is not required there.
2. **It is not free.** The graph-authored route costs **13 nodes evaluated per neighbour per agent per
   step** (17 nodes / 35 edges for the per-pair force block — ~46 % of Particle Life's entire node
   budget), and it **pays for a second neighbour walk**: the engine's own scan enumerates
   substantially the same candidate set the behaviour just gathered. That second scan was measured at
   ~70 % of the force-pass cost and, before the density-skip fix, computed nothing at all for this
   model ([PERF_REVIEW_AGENT_ENGINE.md](PERF_REVIEW_AGENT_ENGINE.md) §2). It also loses symmetry: the
   engine applies a pair force to both endpoints once, whereas a graph loop evaluates every *ordered*
   pair, so the 13-node body runs **twice per unordered pair**.

---

## 2. Candidate designs

Four candidates. **(a) and (c) turn out to be one mechanism** — see §3.

### (a) Per-agent capability MASK
A per-agent integer/bool attribute whose bits say *collide? / charge? / spring? / grow?*. The pair
force applies iff both agents' bits are set (AND), i.e. a zero-bit agent is a **ghost** that passes
through everything.

- Expresses ask #2 exactly. Binary only — it cannot say *"A and B interact differently from A and C"*.

### (b) Interaction CLASSES + class×class matrices
A per-agent **tag** attribute is the class; μ_R / μ_A / charge-k / range become `K × K`
`lookupTable` model attributes indexed `[classᵢ][classⱼ]`.

- Expresses ask #1 in full, and **subsumes (a)** (a class row of zeros is a ghost).
- **The elegant part: no new storage format and no new editor.** A class matrix is an ordinary
  `lookupTable` model attribute with both axes bound to a tag AGENT attribute — *precisely what
  Particle Life already declares* ([gen-particle-life.mjs](../scripts/gen-particle-life.mjs):257–265) —
  so it inherits the shipped matrix-play editor, the seeded Randomize, the presets and the tag-rename
  cascades. The schema addition is a **pointer** ("which table plays the μ_R role"), not a table type.

### (c) Per-agent scalar coefficient attributes
A per-agent float attribute (e.g. `hardness`); the pair coefficient is `f(sᵢ, sⱼ)` for a fixed
combination rule (product / min / mean).

- Continuous ("soft agents and hard agents"), no tables, no discrete classes.
- Cannot express non-monotone pair structure (*A attracts B but repels C*) — that needs a matrix.
- **With `product`, a 0/1 value IS the mask of (a).**

### (d) Doctrine — graph-side only
Build nothing; document Particle Life as *the* pattern, and maybe add convenience nodes.

- Zero engine cost, zero risk. But it declines both asks, keeps the 13-node-per-neighbour tax and the
  duplicated neighbour walk, and leaves per-agent engine-collision opt-out **inexpressible at any
  price** (§1.2).

### 2.1 Cost table

Per-pair cost is quoted against a pair body that today runs ~20 float ops (torus fold, `d²`, `sij`,
`rmax`, cutoff, `sqrt`, a select, a divide, 2–3 fused multiply-adds).

| | (a) mask | (b) class matrix | (c) agent scale | (d) doctrine |
|---|---|---|---|---|
| **New per-agent SoA field** | none — a declared agent attribute (F9) | none | none | — |
| **New WASM ABI params** | 0 (offsets baked; `emitForcePass` already holds the layout, F9) | 0 (F10) | 0 | — |
| **New WGSL bindings** | **0** — attribute runs are inside `agentF32` @0 (F9) | **1** — `auxF32` @9 on **two** BGLs (per-gen :641–669 **and** resident mirror :4310–4351) + widen `bufAux` (F10) | **0** | — |
| **`ForceControl` slots** | 1 of the 3 free (F12) | 1–2 of the 3 free | 1 | — |
| **Pair-loop added work** | 1 load (j) + 1 test | 1 load (j) + 2 int ops + 1 table load + 1 mul | 1 load (j) + 1 mul | 0 |
| **Estimated pair-body cost** | **+5–10 %** | **+15–25 %** per modulated force | **+5–10 %** | 0 |
| **Cost when unused** | **zero** (gated emit) | **zero** | **zero** | 0 |
| **B1 mirror** | uncoalesced `agentF32[base+j]` via `sortedId` (F18) | same | same | — |
| **Residency** | **unaffected** — read-only per-agent data already uploaded with the SoA | **unaffected** — the table is static per generation, like `auxF32` | **unaffected** | — |
| **Bond springs** | n/a | **free via F7** — resolves at formation, no force-loop change | n/a | already works (F6) |
| **Answers ask #1** | partly | **yes** | partly | no |
| **Answers ask #2** | **yes** | yes (a zero row) | **yes** | no |

> ⚠ **These are ESTIMATES**, derived from the op-count of the existing pair body against the documented
> ">99 % of a generation" measurement (F17). They are not measured. The gate for every phase is a
> measured A/B with [`scripts/bench-agent-engine.mjs`](../scripts/bench-agent-engine.mjs), the tool of
> record — *"rerun it after any engine change to see which phase moved."*

---

## 3. RECOMMENDED — "the pair modulator", staged

### 3.1 The spine

> **Every engine pair-force coefficient becomes `scalar × m_ij`, where `m_ij` is resolved from agent
> i's and agent j's own values. Absent modulator ⇒ `m = 1` ⇒ byte-identical.**

Two resolution modes behind **one hook**:

| mode | resolution | delivers |
|---|---|---|
| `agentScale` | a per-agent numeric attribute for each side, combined by `product` (default) / `min` / `mean` | (a) **and** (c) |
| `classMatrix` | a per-agent **tag** attribute (the class) indexing a `K × K` `lookupTable` model attribute | (b) |

**The collapse that makes this cheap:** *`agentScale` over a **bool** attribute with the `product`
rule IS the participation mask.* `1 × 1 = 1`, anything else `= 0`. So candidates (a) and (c) are not
two features — they are one mechanism with one combination rule, and **H1 alone closes ask #2**.
`classMatrix` is then a *widening of the same hook* (swap "read a number" for "read a class and index
a matrix"), not a second mechanism.

**Multiplicative, not replacing** — deliberately. It keeps the model-global slider meaningful (the
"an enabled control must do something" rule), makes `1.0` the byte-identical no-op, and gives
Particle Life semantics for free: a matrix entry in `[-1, 1]` multiplying μ_R flips repulsion into
attraction per class pair.

### 3.2 Proposed schema (additive, absent ⇒ today, no migration)

```ts
/** How a per-pair coefficient is resolved from the two agents. */
type PairModulator =
  | { kind: 'agentScale'; attributeId: string; combine?: 'product' | 'min' | 'mean' }
  | { kind: 'classMatrix'; tableId: string };

/** Per-pair physics modulation. Absent ⇒ the homogeneous engine, byte-identical. */
interface AgentPhysicsModulation {
  /** The tag AGENT attribute every `classMatrix` is indexed by. */
  classAttributeId?: string;
  repulsion?: PairModulator;   // μ_R
  adhesion?: PairModulator;    // μ_A
  charge?: PairModulator;      // k
  /** Participation in the hard positional-collision projection (CPU, all targets). */
  positional?: PairModulator;
  // range / cutoff — DEFERRED, see §6.
}
// on CenterBasedConfig:
//   physicsModulation?: AgentPhysicsModulation;
```

Bond springs use the **existing** `bondSpringMatrixId` (F7) rather than a `PairModulator` — they
resolve once at formation into per-bond storage, not per pair per step (§3.3, H3).

### 3.3 The phases

| | phase | delivers | risk |
|---|---|---|---|
| **H0** | Ordering + clamp honesty (fold into H1) | correctness pre-req | low |
| **H1** | The modulator hook, `agentScale` mode | **ask #2, completely** | low–med |
| **H2** | `classMatrix` mode | **ask #1, forces** | med |
| **H3** | Implement `bondSpringMatrixId` | **ask #1, bonds** | **lowest — independent, can be pulled forward** |

**H3 is independent of H1/H2 and touches no pair loop.** It resolves λ/L from a `K × K` table at Form
Bond / auto-bond time into the per-bond slots that already exist (F5, F6), so it is *pure structural
phase*. It revives a dead schema field designed for exactly this (F7) and can ship first if the bond
half of ask #1 is the priority.

---

## 4. Subsystem-by-subsystem

### 4.1 Schema / types ([types.ts](../src/model/types.ts))
- **H1/H2:** `PairModulator` + `AgentPhysicsModulation` + `CenterBasedConfig.physicsModulation?`. All optional.
- **H3:** none — `bondSpringMatrixId` already exists (F7). Only its *doc comment* changes (from
  aspirational to normative), plus a companion `bondRestMatrixId?` if L is to be tabled separately, or
  a second value column.
- No `.gcaproj` migration on any phase: absent ⇒ today.

### 4.2 Resolvers ([centerBased.ts](../src/model/centerBased.ts))
The ONE-resolver discipline (`resolveMaxBonds` / `chargeParamsOf` / `layoutIterationsOf`) applies:
- `pairModulatorFor(cfg, force) → ResolvedModulator | null` — the single source every surface reads.
- `modulationBinEdgeOf(cfg)` — **0 for H1/H2** (strength-only modulation never changes reach), a real
  value only if §6's range modulator is ever built. Introducing it now, returning 0, documents the
  contract at the site of the trap (the `chargeBinEdgeOf` precedent, F16).
- **`effectiveAgentDt` must take the table/scale MAX** for μ_R and λ, not the scalar (F15). Note this
  fixes a **pre-existing latent bug**: a bond formed today via Form Bond with a stiffness above the
  config scalar already gets a too-loose `dt` and sits outside the Mathias bound.

### 4.3 Field gating ([agentFieldGating.ts](../src/model/agentFieldGating.ts))
**No new gate is needed** — the modulator reads a *declared agent attribute*, which is allocated
because the user declared it, not because a capability asked for it. This is the design's main
memory win over adding a dedicated SoA field. The C9 five-mirror lockstep is untouched.

### 4.4 Capability profiles ([agentCapabilities.ts](../src/model/agentCapabilities.ts))
- No new `AgentCapKey`. The modulator is a *parameterisation* of capabilities that already exist —
  a model with `collision: 'off'` has nothing to modulate.
- The Properties row for each modulator is shown only when its force is on (the hide-when-
  structurally-impossible doctrine).

### 4.5 JS engine ([sim.worker.ts](../src/simulator/engine/sim.worker.ts))
- Hoist `mi` (agent i's scale/class) beside `ri` at :2630 / :2826; read `mj` beside `rad[j]` at
  :2664 / :2856; multiply into `F`. **Both the 2D and 3D arms, and both the stencil and all-pairs
  fallbacks — four sites** (the documented verbatim-2D-fast-path rule: do not branchlessly merge them).
- Positional collision: one predicate in `resolvePositionalCollisions`
  ([agentEngine.ts](../src/simulator/engine/agentEngine.ts):2651) — CPU on every target, so this is
  the cheapest opt-out in the whole feature.
- **H3:** `formBond` / the auto-bond pass consult the matrix when `bondFormK` is 0
  ([agentEngine.ts](../src/simulator/engine/agentEngine.ts):1697–1698) — the `0 ⇒ default` rule becomes
  `0 ⇒ matrix ?? default`.

### 4.6 WASM agent compiler ([agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts))
- Two-line emit per force: hoist `pushF64Elem(L.attrOffset[id], i)` next to :5059; read
  `pushF64Elem(L.attrOffset[id], jL)` next to :4972; multiply into the coefficient.
- `emitForcePass` **already receives the whole `AgentMemoryLayout`** (:4849), so both attribute and
  lookup-table offsets are addressable with **no signature change and no new ABI param** (F9, F10).
  Resolve *which* id at the call site (:5947) — `agentAttrKindOf` needs `ctx.model`.
- **Byte identity:** gate `em.allocLocal` on the same predicate. An unconditional local changes the
  module's local section even if nothing reads it (the `treeOn` precedent, :4886–4895).
- If a scalar knob is genuinely needed, follow the **append-only** block convention (F13) and pass it
  unconditionally from the worker.

### 4.7 WebGPU agent compiler + runtime
- **H1:** zero new bindings — read `agentF32[f32Base[attrId] + j]` (F9). Gate at *runtime* on a
  `ForceControl` field (shader text is not compile-identity-checked; the convention at
  [forcePass.ts](../src/modeler/vpl/compiler/agentWebgpu/forcePass.ts):118–125). **1 of the 3 free
  slots** (F12) — append LAST, add a **literal-index** writer line in `uploadAgentForceControl`, and
  re-run the layout harness.
- **H2 — the one genuinely new WebGPU surface:** a conditional `@binding(9) auxF32` on the force
  shader, entries in **BOTH** force BGLs (per-gen :641–669 **and** the resident B1 mirror
  :4310–4351 — they build separate bind groups and *will* diverge if only one is updated), and a
  widened `bufAux` predicate (:568/:578) so a model whose *force pass alone* needs the table still
  allocates the buffer. Keep the declaration conditional — **Naga strips a declared-but-unused storage
  global**, producing a bind-group mismatch.
- **Emit the term from ONE shared helper interpolated into both `neighbourBody` and `mirrorBody`** —
  the `chargeTerm` / `chargeTreeTraversal` precedent (:127–226). Two hand-written copies is precisely
  how the canonical and mirror pipelines drift.
- **H3:** nothing. Bond springs are not in the WGSL force pass at all (F11).

### 4.8 ⚠ THE ORDERING HAZARD (H0 — must land with H1)
On the GPU the per-generation order is **behaviour → force → attrCommit**
([agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts):1623–1648), and the comment
there states the invariant this feature invalidates, verbatim:

> *"the force pass touches only geometry/velocity, never a user attribute, so its position here is
> immaterial."*

On JS/WASM, `swapAgentAttrs` runs at :2542 and the force loop at :2558 — i.e. **before**. So under
**synchronous** agent mode, a class/scale attribute written by the behaviour this generation would be
read by the force pass on JS/WASM but **not** on WebGPU: a silent one-generation cross-target
divergence, in a mode whose entire point is deterministic snapshot semantics.

**Recommended fix: move the attr-commit pass BEFORE the force pass.** It is free today — the commit
touches only attribute runs while the force pass touches positions / velocity / density / radius /
age, so the two are disjoint and reordering is behaviourally invisible until this feature lands. Do it
in H1 and update that comment to say *why* the order is now load-bearing.

*(Alternatives considered: have the force pass read the WRITE run under sync — needs
`agentAttrWriteBase` plumbed into the force pass, and inverts the meaning of "committed"; or define
the read as one generation stale like `density` — but then JS/WASM must be made to lag too, which is
strictly more work for a worse semantic.)*

### 4.9 UI ([AgentCapabilitiesSection.tsx](../src/modeler/panels/AgentCapabilitiesSection.tsx))
A new **"Per-pair physics"** block under Forces. The shape is **binding an attribute to a physics
role** — the same idea as a lookup-table axis binding a tag attribute:

```
PER-PAIR PHYSICS
  Interaction class   [ species  ▾ ]        (tag agent attributes only)
  Repulsion  μ_R      [ Class matrix ▾ ] [ repulsionMatrix ▾ ]   [ Edit matrix ]
  Adhesion   μ_A      [ Uniform      ▾ ]
  Charge     k        [ Agent scale  ▾ ] [ charge ▾ ] combine [ × ▾ ]
  Positional          [ Agent scale  ▾ ] [ solid  ▾ ] combine [ × ▾ ]
  Bond springs λ / L  [ Class matrix ▾ ] [ springMatrix ▾ ]      [ Edit matrix ]
```

**"Edit matrix" opens the SHIPPED matrix-play editor** — `LookupTableEditor`'s diverging-colour grid
with drag-to-adjust, multi-select, the fill-pattern generators and seeded Randomize. Zero new editor
code. A row renders only when its force is enabled.

### 4.10 Diagnostics + docs
- **C1 Compatibility** — no new blocker. The modulator runs on all three targets; H2's only asymmetry
  (the WebGPU binding) is an implementation cost, not a capability gate.
- **C2 Generation Pipeline** — the force rows' `detail` gains e.g.
  `μ_R = 2.0 × class matrix "repulsionMatrix" [species × species]`, derived from the resolver.
- **C3 diagnostics** — nothing (no new fast path).
- **C8 geometry taint — NO CHANGE, and the reason is worth recording.** The taint criterion is
  *geometry → non-geometric state*. A class/scale attribute is read by the ENGINE and written by an
  ordinary `setAttribute`, so nothing new flows into the graph. Note the inverse precedent:
  `RADIUS_SOURCE_PORTS` makes a radius read a geometry source **only when the engine growth ramp
  advances it** ([geometryTaint.ts](../src/modeler/vpl/compiler/geometryTaint.ts):195–203) — i.e. the
  rule is *"an attribute the ENGINE writes inside the force loop becomes a geometry source."* The
  modulator is engine-**read**, never engine-written, so it stays ordinary state. **Invariant: if a
  future phase makes the engine WRITE a per-agent physics output, it must be added to
  `RADIUS_SOURCE_PORTS`' sibling table.**
- CLAUDE.md, HelpView (the §7 FAQ), README if the Features summary changes, NODES_REFERENCE only if
  nodes are added (H1–H3 add none).

### 4.11 Verification
| gate | what it must show |
|---|---|
| [`check-compile-identity.mjs`](../scripts/check-compile-identity.mjs) | **all shipped models byte-identical on every surface** — the headline gate; every phase is absent-⇒-today |
| [`parity-agent-force.mjs`](../scripts/parity-agent-force.mjs) | JS↔WASM **bit-parity** on new modulated combos (2D/3D × torus/bounded × each mode × on/off), plus the arity contract if a param is added |
| [`parity-agent-wasm.mjs`](../scripts/parity-agent-wasm.mjs) | a permanent synthetic with a **VALUE invariant** — parity alone passes if both targets are equally wrong |
| [`verify-render-uniform-layouts.mjs`](../scripts/verify-render-uniform-layouts.mjs) | `ForceControl` still fully written, nothing in padding (F12) |
| [`audit-agent-layout.mjs`](../scripts/audit-agent-layout.mjs) / [`test-agent-abi.mjs`](../scripts/test-agent-abi.mjs) | the four ABI mirrors agree |
| real GPU | both force pipelines (canonical **and** B1 mirror) compile and agree; the sync-ordering fix verified with a discriminating fixture |
| [`bench-agent-engine.mjs`](../scripts/bench-agent-engine.mjs) | **measured A/B** replacing §2.1's estimates — and **zero regression with the modulator off** |
| source mutation | each new invariant proven failable (the house standard) |

---

## 5. Invariants the design must preserve

1. **ABSENT ⇒ BYTE-IDENTICAL.** No modulator ⇒ every target emits verbatim today's code. On WASM that
   means gating `allocLocal`; on WebGPU it means a runtime-gated uniform field and a *conditional*
   binding declaration.
2. **The pair coefficient is a pure function of `(valueᵢ, valueⱼ)`** — symmetric in the two agents
   unless the matrix is deliberately asymmetric. The engine applies each pair force once to both
   endpoints; an asymmetric matrix means `m_ij ≠ m_ji`, so **each direction must be evaluated with its
   own index order** (Particle Life's `rules[A][B]` is *"force ON an A FROM a B"*).
3. **REACH IS NOT MODULATED** (H1–H3). Strength only. The moment a per-pair *range* exists, the
   spatial-hash bin edge must take the table MAX or the stencil silently truncates (F16) — which is
   exactly why §6 defers it.
4. **The Δt clamp must see the maximum** stiffness any pair can reach, not the scalar (F15).
5. **One resolver, read by every surface** — UI, all three force passes, the pipeline panel, the dt
   clamp. Never a re-implementation.
6. **ONE emit helper feeds both WGSL pipelines** (canonical + B1 mirror), the `chargeTerm` precedent.
7. **Residency stays unaffected.** The modulator is read-only per-agent data already crossing the bus,
   and the class table is static per generation. It must not become a `residencyModelBlockers` entry.
8. **The engine never WRITES a modulator value** — that is what keeps it out of the geometry-taint
   source set (§4.10).

---

## 6. Deferred / Rejected

| item | verdict | why |
|---|---|---|
| **Per-pair RANGE / cutoff** (`interactionRange`, `chargeMaxDist` as matrices) | **DEFERRED — its own phase** | It alone feeds the spatial-hash bin edge (F16). The mitigation is known and cheap (take the table MAX into `binEdge`), so this is a scheduling choice, not a blocker — but a wider bin edge multiplies the candidate count, which IS the perf lever (F17). Ship strength modulation first, measure, then decide. |
| **Per-agent MOTION mode** (static agents among movers) | **REJECTED for now** | Needs a per-agent branch in the integrate block AND the position commit on three targets, and interacts with the C9 "skip force + integrate + commit TOGETHER" rule (the documented Ant Necrophoresis hazard, [sim.worker.ts](../src/simulator/engine/sim.worker.ts):2298–2307). `agentScale = 0` on every force plus `momentum: 0` gives a *nearly* static agent — it still yields to the positional projection, which the `positional` modulator then covers. Revisit only if that residue proves insufficient. |
| **Per-pair Δt / drag / momentum / maxSpeed** | **REJECTED** | Not pair quantities — they are integrator properties of a single agent. A per-agent `maxSpeed` is a *separate, easy* feature (one attribute read in the integrate block); a per-*pair* one is meaningless. |
| **Per-pair growth rate / lifespan** | **REJECTED** | Same reason. Growth already has a per-agent opt-out via `targetRadius` (§1.1). |
| **Making `bondTypeLabel` drive a live spring law** | **DEFERRED** | The per-bond i32 class slot exists, rides the ABI and is read by nothing but the inspector (F8). Once H3 lands, stamping the class at formation and resolving λ per generation from it is a small step — but it moves the spring coefficient back INTO the per-bond loop, so it needs its own measurement. |
| **Editing a live bond's λ / L after formation** | **DEFERRED** | `Set Bond Attribute` reaches user bond attributes only; λ/L are not addressable as bond attributes (the bond inspector can, per edge). Today the graph-side route is break + re-form, which costs a generation. |
| **Porting Particle Life's three tables into the engine** | **FOLLOW-UP, not a phase** | Once H2 lands, PL's `rules` matrix is exactly a `classMatrix` on μ_R. The prize is real (13 nodes/neighbour → 0, and one neighbour walk instead of two), but `attractMin`/`attractMax` are *range* tables — blocked on the deferred §6 row above. **Do not re-run `gen-particle-life.mjs` to try it**: the shipped `.gcaproj` has deliberately drifted from its generator (tuned `maxAgents` / world size), and shipped model configs are the author's choice. |
| **A dedicated per-agent physics SoA field** (instead of reusing a declared attribute) | **REJECTED** | It would add a C9 field gate, five mirror sites and per-agent bytes, to duplicate storage the user already declares. Reusing an agent attribute is why the WGSL cost is zero new bindings (F9). |
| **Non-multiplicative modulation** (replace the scalar rather than scale it) | **REJECTED** | Multiplicative makes `1.0` the byte-identical no-op and keeps the model-global slider meaningful. Replacement would make the slider inert whenever a modulator is set — the enabled-but-inert control the UI doctrine forbids. |
| **Doctrine-only (candidate d)** | **REJECTED** | Declines both asks and leaves per-agent engine-collision opt-out inexpressible at any price (§1.2). Its one genuine contribution — documenting the Particle Life pattern — is kept as §7. |

---

## 7. FAQ — for HelpView, near-verbatim

> **Can some agents ignore the global physics while others follow it?**
>
> Not today, with two exceptions. The engine's physics settings — Collision, Charge, Adhesion, Growth,
> Motion and the force strengths — are **model-wide**: they apply to every agent, and there is no
> per-agent switch. If you need genuinely heterogeneous agents right now, the pattern is to turn the
> engine force off for the whole model (Collision = Off, Use bonding physics unticked) and author the
> force yourself in the Behaviour Step, using **Get Nearby Agents → For Each In Array → Get Agent
> Offset → Apply Force**. The shipped **Particle Life** sample does exactly this, and it is worth
> opening as a template: an agent tag attribute (`species`) indexes a species × species Lookup Table,
> so each pair of species gets its own interaction strength.
>
> The two exceptions:
>
> - **Bond springs are already per-pair.** Form Bond takes **Rest Length** and **Stiffness** as wired
>   inputs, so you can feed each new bond a value from a Lookup Table indexed by the two agents'
>   attributes — different bond stiffness for different pairings, with no engine setting involved. You
>   can also edit a single bond's values in the bond inspector (Shift+click a bond line).
> - **Body size is per-agent**, and the engine's contact distance is the SUM of the two agents' radii —
>   so bigger agents already push apart from further away. Note this is not an opt-out: an agent with
>   radius 0 is still pushed by its neighbour's radius.
>
> Be aware of the cost: an engine force is one fused pass over the neighbour list, while a
> graph-authored one runs your node chain **once per neighbour per agent per step** — and the engine
> still walks the neighbours for its own bookkeeping. For a few hundred agents this is comfortable; at
> tens of thousands the node count per neighbour is the thing that decides your frame rate.

---

## 8. Open questions for the owner

1. **Phase order.** H3 (the bond spring matrix) is independent, lowest-risk, and revives a schema field
   already written for it (F7). Should it ship *first*, or does ask #2 (H1) come first?
2. **Combination rule default.** `product` is proposed (it makes bool ⇒ mask fall out). Is `min`
   ("the softest agent wins") wanted as the default for collision instead?
3. **Class attribute type.** Tag-only (K is then bounded and the matrix axes are the shipped
   `tagAttribute` kind), or should an integer attribute be allowed with an `intRange` axis?
4. **Should H1 also modulate the ADHESION coefficient**, or is adhesion (which has no capability of its
   own, only `useBondingPhysics`) better left alone until it gets one?
5. **The §4.8 reorder** touches shipped GPU dispatch. Confirm it should land as part of H1 rather than
   as its own reviewed change.
