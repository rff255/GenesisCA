# INVESTIGATION — lattice movers: mass-conserving movement on a *parallel* CA grid

**Status:** ⚗️ **DESIGN STUDY — NOTHING SHIPPED.** No engine, compiler, node or UI code
changed. What exists is this document, its HTML twin, and a throwaway Node prototype
(kept in the scratchpad, results transcribed into §7) that measures the load-bearing
claims. Per *"Impact Map First"* this is the precursor to a `PLAN_LATTICE_MOVERS.md`,
not a commitment to build.

**How this was produced:** two parallel codebase deep-reads (the async/WebGPU gate
machinery; the neighbourhood + memory-layout + ABI machinery), a five-stage numerical
prototype, and a synthesis pass. Every quantitative claim in §7 was measured, not
reasoned about — including one claim that **failed** and forced a redesign (§7.6).

---

## 1. The brainstorm, verbatim

> (brainstorm) (hard) design a CAGrid mode in which the cells are treated as agents
> that can move around over other cells that are "empty", effectively unlocking the
> ability to use webgpu while having the mass conservation of occupied cells moving
> around and optionally overlapping or colliding, but the main point is: some CAs
> become incompatible with webgpu by having to set neighbors attributes via the
> 'transfer cells attributes to neighbor' node, but if the goal is just to "move" an
> entity that the cell is representing to a neighboring cell, then we could treat it
> as agents that are locked inside a grid and with that enable the use of webgpu to
> simulate those as well, however the "conflict"/"collision" policy needs to be
> determined somehow.

---

## 2. Executive summary

**The diagnosis is right, and the conclusion is stronger than the brainstorm assumes.**

A move-into-a-vacancy rule is *not* fundamentally sequential. What is fundamentally
sequential is the **implementation** GenesisCA currently offers for it: async mode's
single shared buffer, where "is my target empty?" is answered against a board other
cells are mutating. The *rule* only needs one guarantee — **no two entities land on
the same cell** — and that is a **conflict-resolution problem, not an ordering
problem**. Conflict resolution parallelises; ordering does not.

**The recommendation is design (A): a two-phase PROPOSE → RESOLVE step.** Phase 1 is
the user's existing rule, ending in a new `proposeMove` node that writes an *intent*
(a target + a priority) into a per-cell buffer instead of writing the neighbour.
Phase 2 is an **engine-owned** pass in which **every cell writes only itself**,
deciding by two local scans whether it received a mover and whether its own move won.
Both phases are pure functions of the previous buffer, so both are order-independent
and both are ordinary WGSL dispatches.

Measured on the prototype (§7):

- **Mass conservation is EXACT at every generation** under every conflict policy and
  at every density tested, up to a 99 %-full grid — `received == cleared` exactly.
- **The resolve pass is order-independent**: 30 generations × 4 random visit orders
  → **0 mismatching cells**; and 4 policies × 25 generations × 5 orders → **0**.
- **Throughput retained vs. the *correct* sequential reference**: **97 % at 10 %
  occupancy, 92 % at 20 %, 84 % at 35 %**, falling to 43 % at 76 % and 31 % at 90 %.
- **A chain extension recovers the rest at high density** and is sound if — and only
  if — commitment is made monotone (§7.6 documents the version that *broke*
  conservation and why).

**Three findings that reframe the problem:**

1. **The sequential baseline everyone compares against is inflated by a bug-shaped
   artifact.** A naive shuffled sweep re-visits a particle that moved into a
   not-yet-visited cell, so one particle moves **1.6 times per generation** at 10 %
   fill — physically impossible for a "one cell per step" rule. GenesisCA already
   ships `markCellUpdated` to suppress exactly this. Against the *marked* baseline
   the parallel scheme is nearly free at the densities most models run at.

2. **Async is already order-dependent for the case people fear losing.** For a
   packed "train" of movers, a right-to-left sweep advances all *K* cells and a
   left-to-right sweep advances *1* — from the same state, with `markCellUpdated`
   on. The random-order scheme re-rolls that every generation. The parallel scheme
   always gives the left-to-right answer, i.e. **one of the answers async already
   produces**, deterministically.

3. **Enabling WebGPU for the four *shipped* async models buys almost nothing** —
   they are 8 600 to 10 000 cells (§3.3). The value is the **ceiling**: today
   "movement + mass conservation" and "a grid large enough to need the GPU" are
   mutually exclusive. This removes that.

**The cost, stated honestly:** a second dispatch per generation, ~4 bytes/cell of new
memory, a new node, and a semantic that is *deterministic but not identical* to any
particular async run. It does **not** replace async mode — `setNeighborhoodAttribute`
(a broadcast write to a whole neighbourhood) and genuinely order-dependent rules stay
where they are.

---

## 3. The problem, precisely

### 3.1 What is locked off, and by which gate

Two gates, and they are distinct — worth separating because they suggest different
fixes:

| gate | where | what it rejects |
|---|---|---|
| **model-level** | `detectWebGPUModelIncompatibilities` — [nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts):1378 | `updateMode === 'asynchronous'`, outright |
| **node-level** | `detectWebGPUIncompatibilities` — same file, :1292 | `moveSelfToNeighbor`, `setFacingOrientation`, `setNeighborOrientationByIndex`, and `updateIndicator` with `toggle`/`next`/`previous` |

The model-level message is the doctrine statement:

> *"Asynchronous is the SEQUENTIAL update mode (a write is visible to a later cell in
> the same generation), and WebGPU runs cells in parallel. Switch to Synchronous in
> Model Properties, or run this model on a CPU engine (WebAssembly / Debug JS)."*

The remaining three async-only nodes (`setNeighborhoodAttribute`,
`setNeighborAttributeByIndex`, `markCellUpdated`) are *not* in the node-level list by
design — they surface through `detectCapabilityRequirements`' "requires async mode"
badge plus the model-level rejection, which the file's own comment calls "together
unambiguous". `isNodeAvailable` additionally hides all six from the palette in a sync
model, so a user cannot even reach them without first flipping the mode.

**Defence in depth exists:** [webgpu/compile.ts](../src/modeler/vpl/compiler/webgpu/compile.ts)
carries explicit rejecting handlers for `setNeighborhoodAttribute` (:3304),
`setNeighborAttributeByIndex` (:3308), `setFacingOrientation` (:3336) and
`setNeighborOrientationByIndex` (:3340). `markCellUpdated` and `moveSelfToNeighbor`
have **no WGSL handler at all** and fall through to the generic unknown-node error.

### 3.2 What actually needs sequentiality — and what only looks like it does

The six async-only nodes are *not* one category. Sorting them is the whole design:

| node | writes | why it is async-only today | genuinely order-dependent? |
|---|---|---|---|
| `moveSelfToNeighbor` | one target cell + (optionally) self | *"sync mode's post-step bulk copy would overwrite those writes"* | **NO** — it is a *permutation*: at most one payload arrives per cell. That is a conflict problem. |
| `setNeighborAttributeByIndex` | one (or an array of) neighbour cells | same | **NO** when used as a move (gas_particles, snake); **YES** if two cells legitimately write the same neighbour with different values and the last-writer matters. |
| `setNeighborhoodAttribute` | *every* cell of a neighbourhood | same | **YES, structurally** — it is a broadcast, so N writers per cell is the intent, not an accident. No arbitration can preserve that. |
| `setFacingOrientation` | one neighbour's orientation | same | Same shape as `setNeighborAttributeByIndex`. |
| `setNeighborOrientationByIndex` | one/array of neighbours' orientation | same | Same. |
| `markCellUpdated` | the scheduler's `_skipped` flag | *"Sync mode has no scheduling concept"* | **N/A** — it exists *only* to patch a sequential artifact. In a two-phase scheme it is **unnecessary** (§7.2). |

**The load-bearing observation.** Read `moveSelfToNeighbor`'s own doc comment:

> *Async-only. It writes neighbour cells (copyTo / swap / copyFrom+defaults) — sync
> mode's post-step bulk copy would overwrite those writes.*

That is a statement about **the buffer discipline**, not about the rule's semantics.
The rule wants "this entity is now one cell over". The reason it needs the *live*
buffer is that it must see whether the target is *still* empty after earlier cells
moved. Give it a mechanism that answers "did I get the cell?" *after* everyone has
asked, and the live buffer stops being necessary.

**Both shipped movement models are exactly this shape.** Amphiphile and
Chromatography both configure the node identically in the load-bearing respect:

```js
operation: 'copyTo', nonReceiving: 'defaults'
```

`copyTo` + `defaults` **is** the move-into-a-vacancy idiom: the payload goes to the
target and the source resets, leaving exactly one vacancy. Amphiphile adds
`includeOrientation: true` and a payload of one attribute (`kind`); Chromatography's
payload is one attribute (`cellType`). Their decision graphs differ (Amphiphile:
per-face interaction table + Bernoulli break-free + weighted direction sample;
Chromatography: the same skeleton plus a gravity boost on the south weight) but both
end at a single `moveSelfToNeighbor` fed by a `groupOperator{weightedRandom}` →
`arrayElement` chain that produces one target NI.

### 3.3 The scale observation — and why it changes the goal

Every shipped async model is **small**:

| model | grid | cells | target | async-only nodes used |
|---|---|---|---|---|
| Amphiphile | 100 × 100 | 10 000 | WASM | `moveSelfToNeighbor` ×1 |
| Chromatography | 43 × 200 | 8 600 | WASM | `moveSelfToNeighbor` ×1 |
| gas_particles | 100 × 100 | 10 000 | WASM | `setNeighborAttributeByIndex` ×1 |
| snake | 100 × 100 | 10 000 | WASM | `setNeighborAttributeByIndex` ×3 + `markCellUpdated` ×1 (inside a macro) |

All four are `boundaryTreatment: torus`, `asyncScheme: random-order`, `useWasm: true`.

At ten thousand cells WASM is comfortably faster than a GPU round-trip. **So the
honest goal is not "make these four faster."** It is:

> Today, a GenesisCA model may have *movement with mass conservation*, **or** a grid
> big enough to need WebGPU. Never both.

For comparison, the Accretor ships at **300³ = 27 M cells** on the WebGPU grid; the
WASM/JS neighbour table alone would be ~2.8 GB there, which is why the WebGPU path
stores only relative offsets. A moving-entity model at that scale is currently
inexpressible — not slow, *inexpressible*. That ceiling is the prize.

### 3.4 Why "just make async work on the GPU" is not on the table

Async is a *specification* of sequential semantics: `orderArray` is a per-generation
Fisher–Yates permutation and the compiled loop is
`for (_i…) { const idx = order[_i]; if (_skipped[idx]) continue; … }`
over a single buffer where `attrsB[attr.id] = arrA`. A parallel dispatch has no
"earlier cell". Emulating it on a GPU means either serialising the dispatch (a
1-thread kernel — catastrophically slower than WASM) or changing the semantics, which
is what this document proposes doing *explicitly and under a different name*.

---

## 4. Survey — parallel mass-conserving formalisms

From the literature, with the property that matters here in the last column. "Exact"
means the count of entities is invariant by construction, not by tuning.

| formalism | mechanism | parallel? | conservation | determinism | fit for GenesisCA |
|---|---|---|---|---|---|
| **Margolus / block (partitioning) CA** (Toffoli & Margolus 1987) | Partition into 2×2 blocks; the rule maps a whole block to a whole block; the partition offset alternates each generation | **Yes, perfectly** — blocks are disjoint, one writer per block | **Exact by construction** — the rule is a permutation on block contents | Fully deterministic; no arbitration exists | Strong, but a **different rule shape** (block-local, not cell-local). See design (B). |
| **Lattice-gas CA** — HPP (1973), FHP (1986) | Each cell holds *b* directional **channels**; a propagate step shifts each channel to the neighbour; a collide step permutes channels within a cell | Yes — propagate is a shift, collide is cell-local | **Exact** — channel occupancy is permuted, never created | Deterministic (or a fixed random collision table) | Elegant, but requires re-modelling an entity as a set of channels. Not a drop-in for "an occupied cell". |
| **Nagel–Schreckenberg traffic** (1992) | Cells compute a *gap* to the next occupant and move up to that gap; the gap is read from the previous state | Yes | **Exact** — the gap rule guarantees no two vehicles target one cell | Deterministic given the randomisation seed | Only works on a **1-D directed lane** where a total order exists. |
| **Propose / arbitrate / commit** (the "intention" scheme; ubiquitous in parallel pedestrian and traffic models, e.g. Blue & Adler; Burstedde et al.'s floor-field CA) | Every mover writes ONE target intent; every target picks ONE winner by a policy; losers stay | **Yes** — both phases read the previous state | **Exact** — one arrival per cell by arbitration | **Deterministic if the tie-break is** (index, hash, or a seeded priority) | **Direct fit.** This is design (A). |
| **Exclusion processes** (TASEP/ASEP; Chopard & Droz's parallel exclusion rules) | Hop to a neighbour iff empty; the *parallel* update needs an explicit conflict rule (this is the well-known "parallel TASEP" subtlety) | Yes | Exact once a conflict rule is fixed | Depends on the conflict rule | The theoretical grounding for (A): the literature is explicit that a parallel exclusion process is **only defined once you name the collision policy** — precisely the brainstorm's own closing concern. |
| **Agents on a lattice with an occupancy map** | Each mover is a first-class agent; the grid stores an owner id; a claim is an atomic CAS on the occupancy cell | Yes | Exact (a CAS grants exactly one claimant) | **Non-deterministic** — the CAS winner depends on dispatch order | This is design (C). Conservative but not reproducible, and it changes the data model. |

**The literature's own verdict on the brainstorm's closing sentence** — *"the
conflict/collision policy needs to be determined somehow"* — is that this is not an
implementation detail but the **definition** of a parallel exclusion process. Two
parallel CAs with the same hop rule and different collision rules are different
models. That argues for making the policy an explicit, named, per-model setting
rather than an engine constant.

---

## 5. Design alternatives

### (A) Two-phase `proposeMove` / engine resolve — **RECOMMENDED**

#### A.1 The mechanism

A generation becomes **two passes over the grid**:

**Phase 1 — PROPOSE** (the user's existing rule, unchanged except its last node).
Reads the previous buffer; writes the new buffer as today; and, where the rule would
have called `moveSelfToNeighbor`, calls **`proposeMove`** instead, which writes a
single word into a per-cell **intent** buffer:

```
intent[idx] = (priority << 8) | (slot + 1)      // 0 == "no proposal"
```

- `slot` — the index into the mover neighbourhood (Moore-3D is 26 slots, so 8 bits is
  ample). Storing the **slot**, not a packed NI, is deliberate: the resolve needs to
  invert the offset, and a slot indexes the offset table directly.
- `priority` — 24 bits, produced by the chosen policy (§6).

Encoding both in one `u32` means the arbitration key **is** the intent word: an
unsigned compare gives "highest priority, then highest slot", and the source cell
index breaks the remaining ties. That is a **total order**, hence deterministic.

**Phase 2 — RESOLVE** (engine-owned; not user-authored). Every cell `c` performs two
local scans and **writes only itself**:

```
scan 1  "am I a destination?"   for each slot s: src = cell at (c − offset[s])
                                if intent[src] names slot s → candidate
                                winner = argmax(intent[src], −src)
                                if a winner exists → I take its payload

scan 2  "did my own move win?"  if intent[c] names slot s:
                                  t = cell at (c + offset[s])
                                  recompute scan 1 AT t
                                  if its winner is me → I vacate (write defaults)

if both fire, scan 1 wins  (I moved out AND someone moved in → I hold theirs)
```

**This is the crux, and it is what makes the scheme a legal GPU kernel.** The obvious
implementation — "the destination cell writes the source's vacancy" — reintroduces
the very cross-cell write we are removing. Because the arbitration is a *pure
function* of (previous buffer, intent buffer), a source can **independently
recompute** whether it won, so no cell ever writes another cell, no scratch buffer is
needed, no barrier is needed and no atomics are needed. Cost: `2 × O(nbrSize)` per
cell — the same order as one ordinary neighbour gather.

#### A.2 Buffer discipline (and a small bonus)

The sync engine today does: bulk-copy `w ← r`, run the rule (writes `w`), then swap
(JS) or bulk-copy `w → r` (WASM, because its offsets are baked).

With a resolve pass, the natural arrangement is **two ping-pongs per generation**:

```
rule    : reads A, writes B   (+ writes intent)
resolve : reads B, writes A   (carry forward, or apply the transfer)
```

The resolve is already a full per-cell pass, so it **subsumes the copy**: a cell that
neither received nor vacated writes `A[c] = B[c]`. Two swaps return to A each
generation — which means **the WASM path loses its bulk `w → r` copy**, a small
throughput win that partly offsets the second pass.

Reading payloads from **B** (post-rule) preserves `moveSelfToNeighbor`'s documented
"post-update semantics": a rule that sets an attribute and *then* moves carries the
updated value. Reading from B is safe because the rule pass has fully completed — B
is immutable during the resolve.

**Non-payload attributes stay with the cell**, exactly as the existing node specifies;
only `attr_0…attr_N` (and optionally orientation) transfer.

#### A.3 The inverse neighbourhood

Scan 1 needs, for each slot `s` with offset `d`, the cell at `−d`. Three options, and
the codebase already picked one for us:

- ❌ **A second `nIdx` table.** `total × nSz × 4` bytes — the dominant per-cell cost
  (2.8 GB at 300³ Moore-3D). Doubling it is a non-starter.
- ✅ **Compute it inline from the negated offset**, reusing `niCellExprStmts` (JS) /
  `pushInlineNbrCellIdx` (WASM) / `nbrCellIdxFromNi` (WGSL) with the wrap and
  constant-boundary sentinel logic those already implement. **This is what the
  WebGPU path does for *all* neighbour access already** (`nbrOffsets` stores only
  relative coords), and what sparse-stepping does on the CPU.
- The negated offsets are a `nSz`-entry table — kilobytes, not gigabytes.

**Note:** the constant-boundary sentinel (index `total`) must never be a proposal
target. `fillBoundarySentinel()` currently populates cell attributes only; the resolve
must treat `total` as "not a real cell" rather than reading an intent for it.

#### A.4 Where the intent buffer lives

| target | placement | why |
|---|---|---|
| **JS / WASM** | a `total × 4` region **appended after `generationOffset`** in `computeMemoryLayout` ([wasm/layout.ts](../src/modeler/vpl/compiler/wasm/layout.ts)) | The file documents this discipline explicitly for `activeList` (*"Appended LAST so a non-sparse module's offsets are byte-identical"*) and `generation`. Gate the **bytes** (0 when the model has no mover), never the offset. |
| **WebGPU** | an appended per-cell `u32` region **inside the `attrs` buffer**, at an `intentWordOffset` | The **orientation precedent** — variegation's per-cell orientation already rides `attrsRead`/`attrsWrite` rather than taking a binding. The grid pipeline already uses **10 storage buffers**, and CLAUDE.md records that conservative adapters cap `maxStorageBuffersPerShaderStage` at 8 (with `sharedGpuDevice.ts` retrying at *default* limits on failure). **Pack, don't add a binding.** The `emitPerCellCopyPreamble` must skip the intent region. |

4 bytes/cell against the ~9 B/cell a typical model's write buffer costs.

#### A.5 The ABI

`_generation` is currently the **last** parameter, and the worker pushes it
*unconditionally* while the compiler declares it *conditionally* — the documented
"params ≤ args is the safe direction" rule. A new parameter must therefore be
appended **after** `_generation`, in all of `buildLoopParams`, `buildCellParams`,
`buildOutputMappingParams` **and** after `args.push(generation)` in `buildLoopArgs` /
`buildCellArgs`, with the gate predicate identical on both sides.

⚠️ **A trap:** `nbrTableDropped` detection is a source scan with the regex
`/nIdx_\w*\[/`. Do not name the new parameter anything matching it.

#### A.6 What the user's graph looks like

The delta is **one node**. Both shipped movement models become:

```
… weightedRandom → arrayElement("NI of chosen dir") →  proposeMove   (was: moveSelfToNeighbor)
```

`proposeMove` keeps `moveSelfToNeighbor`'s entire config schema — `payloadCount`,
`attr_N`, `operation`, `nonReceiving`, `includeOrientation` — because those describe
what the **resolve** must transfer. Amphiphile's separate rotation flow root and
Chromatography's gravity/weight machinery are untouched.

⚠️ **A new node, not a mode on the old one.** Making `moveSelfToNeighbor` compile to
propose/resolve in sync mode and to its current emit in async mode would give the
same graph two different semantics depending on a setting elsewhere — precisely the
kind of invisible coupling the project's honesty rules exist to prevent.

#### A.7 Interactions to get right

| subsystem | interaction |
|---|---|
| **Skip Isolated Empty Cells** | The resolve must run on every cell that could *receive*, i.e. the active set dilated by the mover neighbourhood. SIE's existing contract already requires the processing range to cover the rule's read neighbourhood; this extends it to the **move** neighbourhood. Same contract, one more clause. |
| **Indicators** | The linked-indicator scan and the spatial scan must run **after the resolve**, not after the rule — otherwise they count the pre-move board. The scan is already post-step in the worker; the hook simply moves to the end of phase 2. |
| **Sub-attributes** | A payload sub-attribute carries its parent-match semantics: transferring it to a cell whose parent does not match must respect the guard, or be refused at validation. **Recommend refusing** a sub-attribute payload in v1 — the semantics of "move a value that is only defined when the parent matches" deserve their own decision. |
| **Variegation / orientation** | `includeOrientation` transfers the orientation word with the payload, exactly as today. Amphiphile relies on this. Orientation already has read/write regions and rides `attrs` on WebGPU, so it costs nothing new. |
| **3D** | The intent slot indexes the neighbourhood; the inverse offset is a 3-tuple negation. Nothing in the scheme is 2-D-specific. `packNI3`'s 10-bit thirds are not needed — we store a **slot**, not a packed NI. |
| **WebGPU dispatch** | The resolve pass must use `dispatchCells` (the 2-D workgroup tiling). A flat 1-D dispatch silently no-ops past ~4.19 M cells — exactly the regime this feature is *for*. |
| **`markCellUpdated`** | Becomes unnecessary: each cell acts exactly once. Its purpose was to patch the sequential re-visit artifact (§7.2). |
| **Save/load, presets** | The intent buffer is per-generation scratch. It must **not** be serialised. |

#### A.8 Honest limitations

- **It is not bit-identical to any async run**, and cannot be — async's answer depends
  on a shuffle. It is deterministic *in its own right*, which async is not across
  visit orders (§7.4).
- **A single generation moves a mover at most one cell**, so a packed train advances
  one cell per generation rather than cascading — the same answer async gives under
  an unfavourable order. The chain extension (§7.6) recovers cascades at a cost.
- **`setNeighborhoodAttribute` is not addressed.** A broadcast write to a whole
  neighbourhood has N legitimate writers per cell; no arbitration preserves that.
  It stays async-only, correctly.

---

### (B) Margolus block partitioning as an update mode

`updateMode: 'block'`. Partition the grid into 2×2 (2×2×2 in 3D) blocks; the rule
sees the whole block and writes the whole block; the partition offset alternates each
generation so information crosses block boundaries.

**Strengths.** Conflict-free *by construction* — there is no policy to choose, which
is the brainstorm's stated difficulty dissolved rather than solved. Exactly
conservative if the block rule is a permutation. Fully deterministic. Measured: **mass
exact over 200 generations, deterministic across runs** (§7.7).

**Why it is not the recommendation.**

1. **It is a different rule shape.** GenesisCA's entire node catalogue is *cell*-local
   (`idx`, `_row`/`_col`, neighbour gathers). A block rule needs block-local ports —
   "my four cells" — which is a new port kind, new emit shape, new UI, and a rule the
   existing catalogue cannot express. That is a much larger surface than (A).
2. **It cannot express the shipped models.** Amphiphile's move is driven by a
   per-face interaction table over a *von Neumann* neighbourhood and a weighted
   sample over four directions; a 2×2 block cannot see that neighbourhood.
3. **The alternation is visible.** Block CAs have a characteristic 2-generation
   period and block-aligned artifacts that users must design around.

**Where it *would* win:** genuinely conservative physics — lattice gases, HPP/FHP
fluids, exact-conservation diffusion. That is a legitimate future mode, and it
composes with (A) rather than competing (a model picks one). Record it; do not build
it first.

---

### (C) Lattice-locked agents (the brainstorm's literal reading)

Reuse the agent engine: `Motion: static`, integer positions, and an engine-owned
`occupancy` cell attribute; add a "Move To Cell" agent node whose conflict is resolved
by the engine.

**This already exists, by hand.** `Ant Necrophoresis` does exactly it: ants live on
exact integer cell positions, are placed by the Agent Init Event via `floor(u·W)`, and
move one cell per step with `Set Agent Position` plus a hand-written torus wrap. Its
generator notes that the engine integrator is inert (`customForcesOnly`, `momentum 0`,
`motion: 'static'`) but **must still run**, because `swapPositions` commits `xNext`
over `x` every step.

**Why it does not achieve the goal.**

1. **A GPU resolve needs atomics, and gives up determinism.** The agent structural
   phase (bond requests, division, death) is **CPU/JS on every target, by design** —
   a per-generation CPU touch point. Draining move requests there forfeits precisely
   the WebGPU residency the brainstorm is after. A GPU-side resolve would be an
   `atomicCompareExchangeWeak` claim on the occupancy cell — expressible in WGSL, and
   conservative — but the winner depends on dispatch order, so **the model stops
   being reproducible**. Contrast (A), whose arbitration is a deterministic total
   order. Given the project's reproducibility contract (`exact` vs `statistical`),
   that is a real and visible downgrade.
2. **Population scale is off by orders of magnitude.** The agent engine is measured
   at ~50 k agents (≈20 ms/generation resident at 50 k). A 300³ grid is **27 million**
   entities. A 5000² grid is 25 million. A lattice-mover model at the scale that
   motivates WebGPU is **three orders of magnitude** past the agent engine's tested
   range, and the agent SoA is `maxAgents`-sized regardless of occupancy.
3. **Every cell attribute must migrate.** The entity's state becomes agent
   attributes; the substrate becomes a field read through the field bridge; and
   rendering, brushing, indicators, save/load and the cell inspector all change
   meaning. That is a model-authoring migration, not a compile-target unlock.

**Verdict:** the right tool when entities are **sparse** relative to the grid (a few
thousand ants on 10 000 cells). Wrong when entities *are* the grid. Note in the docs
that Ant Necrophoresis is the worked example of this pattern; do not promote it to a
mode.

---

### (D) Do nothing; document the workaround

Async on WASM is already the fastest CPU path, and all four shipped async models are
≤ 10 000 cells where WASM is entirely adequate.

**The cost of (D) is not slowness — it is a ceiling.** A moving-entity model cannot be
written at the scale where WebGPU matters. Because the gate is a compile-time
rejection with a clear message, the failure is at least *loud*: a user gets the
"switch to Synchronous or run on a CPU engine" sentence, not a silent slowdown.

(D) is the correct answer **if** no one wants a large moving-entity model. That is a
product question, not a technical one, and it is the one question this document
cannot answer.

---

## 6. Conflict / collision policy catalogue

All are one-line changes to how `priority` is computed in phase 1, or to the
comparison in phase 2. All were measured mass-exact (§7.1).

| policy | priority source | winner | determinism | notes |
|---|---|---|---|---|
| **Deterministic index** | constant 0 | lowest (or highest) source cell index | **Bit-exact on all three targets.** No RNG at all. | Introduces a spatial bias — a mover to the "left" systematically wins. Best for reproducible research runs; worst for isotropy. |
| **Random priority (shared stream)** | `xorshift32` from the shared `_rngState` | highest priority | **Bit-exact JS ↔ WASM**; WebGPU differs (per-cell PCG) | Matches the existing `getRandom` posture exactly: *"Same global seed → different sequences. Statistical behaviour matches; deterministic replay across targets does not."* |
| **Random priority (per-cell hash)** | `hash(cellIdx, generation, salt)` | highest priority | **Bit-exact on ALL THREE targets** — a pure function of position and time, independent of dispatch order | Measured deterministic (§7.4). **Recommended default:** it is the only unbiased policy that is also cross-target reproducible. |
| **Attribute priority** | a chosen cell attribute (quantised to 24 bits) | highest attribute value | Deterministic given the board | "Heavier/older/hungrier wins." Ties fall through to the index tie-break. Makes the policy part of the *model*, which is often what a scientist wants. |
| **Reject on conflict** | — | nobody moves | Deterministic | Strongest exclusion: contested cells stay empty for a generation. Measured ~22 % fewer moves at 35 % fill. Useful when a contested site should represent congestion. |
| **Swap (mutual intent)** | — | both move | Deterministic | **Needs no arbitration at all.** A pair pointing at each other is symmetric; a `src < dst` guard fires it exactly once. It is the *only* mechanism that still mixes a completely full grid — measured 511.7 swaps/generation at **100 % occupancy** with exact conservation (§7.5). Composes with any of the above. |
| **Overlap allowed** | — | all move | Deterministic if the accumulate is commutative | Drop exclusion: the target is a *count*, incremented by each arrival. Conserves the count, not the identity. Cheap (it is an add, not an arbitration), but it is a different model — payload identity is lost. |
| **Bounce** | — | losers reverse | Deterministic given the above | A loser writes a reversed velocity/orientation instead of staying put. Requires a velocity-like attribute; a natural add-on, not a v1 primitive. |

**Recommendation:** ship **deterministic-index** and **per-cell-hash random** in v1
(one biased-but-exact, one unbiased-and-exact), plus **swap** since it is nearly free.
Attribute-priority and reject are small follow-ons. Overlap and bounce are separate
features wearing a policy's clothes.

---

## 7. Measurements

A five-stage Node prototype (scratchpad: `lattice-movers-proto{,2,3,4,5}.mjs`) on a
64×64 torus with a von Neumann neighbourhood, the engine's own `xorshift32`, and — in
the final stage — **the exact self-write-only resolve of §A.1**. Every number below is
measured output.

### 7.1 Mass conservation

The self-write-only resolve, 200 generations per density:

| fill | n₀ | n_final | min | max | received/gen | cleared/gen | verdict |
|---|---|---|---|---|---|---|---|
| 10 % | 456 | 456 | 456 | 456 | 439.5 | 439.5 | **EXACT at every generation** |
| 35 % | 1463 | 1463 | 1463 | 1463 | 1212.4 | 1212.4 | **EXACT at every generation** |
| 65 % | 2718 | 2718 | 2718 | 2718 | 1261.0 | 1261.0 | **EXACT at every generation** |
| 90 % | 3679 | 3679 | 3679 | 3679 | 416.5 | 416.5 | **EXACT at every generation** |
| 99 % | 4050 | 4050 | 4050 | 4050 | 46.0 | 46.0 | **EXACT at every generation** |

`received == cleared` exactly at every density: every payload that leaves a cell
arrives at exactly one other cell. The earlier target-writes-source variant was also
exact under all four policies (index / random / attr / reject) at 95 % and 99 % fill.

### 7.2 The re-visit pathology — the sequential baseline is not what you think

Moves **per generation per particle**:

| fill | sequential, naive | sequential, `markCellUpdated` | parallel 2-phase | **retention** |
|---|---|---|---|---|
| 10 % | 1.614 | 1.000 | 0.966 | **97 %** |
| 20 % | 1.570 | 0.999 | 0.918 | **92 %** |
| 35 % | 1.496 | 0.992 | 0.831 | **84 %** |
| 50 % | 1.351 | 0.954 | 0.679 | **71 %** |
| 65 % | 1.110 | 0.844 | 0.467 | **55 %** |
| 76 % | 0.844 | 0.684 | 0.293 | **43 %** |
| 90 % | 0.382 | 0.337 | 0.103 | **31 %** |

A naive shuffled sweep exceeds **one move per particle per generation** — impossible
for a rule that moves an entity at most one cell per step. The cause is that a
particle which moves into a not-yet-visited cell is visited *again*. `markCellUpdated`
exists precisely to suppress this (its doc: *"a cell that 'moves into' a neighbor
doesn't want that neighbor to take another turn the same step"*).

**Against the corrected baseline the parallel scheme is nearly free below ~35 %
occupancy** — the regime most models live in. It costs real throughput in dense
regimes, where §7.6's extension applies.

### 7.3 Order independence — the parallel-safety proof

- Self-write-only resolve: 30 generations × 4 random visit orders on 48×48 →
  **0 mismatching cells**.
- Target-writes-source resolve: 4 policies × 25 generations × 5 orders →
  **0 mismatches**.

A parallel dispatch may schedule cells in any order; the result is invariant.

### 7.4 Determinism

Same seed, two runs, 50 generations, hashes compared:

- shared-`xorshift32` priority — **MATCH** for all four policies.
- per-cell-hash priority — **MATCH** for all four policies. Being a pure function of
  `(cellIdx, generation, salt)`, this source is independent of dispatch order and is
  therefore the cross-target-reproducible option.

### 7.5 Swap needs no arbitration

64×64 at **100 % occupancy**, 100 generations: **51 174 mutual-intent swaps** (511.7
per generation), occupancy 4096 → 4096 (**exact**). A pair that points at each other
is symmetric; the `i < j` guard fires it exactly once. It is the only mechanism that
mixes a grid with no vacancies at all.

### 7.6 The chain extension — and the version that broke

**The train.** A row of *K* movers with one vacancy ahead, moves in **one** generation:

| K | seq R→L (marked) | seq L→R (marked) | parallel (vacancy-only) | parallel (chain-aware) |
|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 1 |
| 2 | 2 | 1 | 1 | 2 |
| 4 | 4 | 1 | 1 | 4 |
| 8 | 8 | 1 | 1 | 8 |
| 16 | 16 | 1 | 1 | 16 |

Two things to read off this. **First: async is already order-dependent here** — from
the same state, with `markCellUpdated` on, right-to-left gives *K* and left-to-right
gives *1*. The parallel answer (1) is one of the answers async already produces.
**Second: chain-awareness recovers the full cascade** — because a cell may name a
target that is *itself* leaving.

> ⚠️ **The naive chain rule BREAKS conservation, and the prototype caught it.**
> "I may enter T because T is committed to leave" is **unsound**: T's commitment can
> be revoked when T loses the arbitration at *its own* target. Then I overwrite a
> payload that never left. Measured: mass **BROKEN** at 35 / 65 / 76 / 90 % fill.
>
> The fix is to make commitment **monotone**: a destination, once claimed, leaves
> play, and a claim is only granted to the winner of that destination's arbitration.
> Each round is one parallel pass. With that correction:

| fill | R=0 | R=1 | R=2 | R=4 | R=8 | seq (marked) | conservation |
|---|---|---|---|---|---|---|---|
| 35 % | 845 | 1007 | 1051 | 1063 | 1063 | 1430 | **EXACT** |
| 50 % | 875 | 1128 | 1207 | 1241 | 1245 | 2006 | **EXACT** |
| 65 % | 738 | 1007 | 1124 | 1187 | 1199 | 2289 | **EXACT** |
| 76 % | 552 | 797 | 907 | 991 | 1004 | 2156 | **EXACT** |
| 90 % | 248 | 379 | 448 | 507 | 521 | 1251 | **EXACT** |

Retention vs. sequential rises from **20 % → 42 %** at 90 % fill for 8 extra rounds;
R rounds move chains of depth up to R+1 (measured: K=16 needs R=16 for the full
cascade, R=8 gives 9).

*(These absolute numbers use a "blind walk" proposal rule — pick a direction, go if
it is free — so they are internally consistent but **not** cell-for-cell comparable
with §7.2's table, which uses the shipped models' "pick among the empty neighbours"
rule. The R=0 → R=8 *ratios* are the meaningful figures.)*

**Cost:** R extra parallel passes per generation, i.e. R extra GPU dispatches, plus a
per-cell `committed`/`claimed` flag. **Recommendation: not in v1.** Ship R=0, which
is 84–97 % retention in the common density range, and keep this measured record for
when a dense model needs it.

### 7.7 Margolus, for comparison

200 generations, 2×2 alternating blocks with a random per-block rotation:
n₀ 1463 → n_final 1463, min = max = 1463 (**exact**), 1463 moves/generation (every
occupied cell moves every generation — a rotation displaces all four block cells),
and **deterministic across runs**. Conflict-free by construction; no policy exists to
choose. Confirms design (B)'s strengths, and its very different rule shape.

### 7.8 Does it still behave like the same model?

**Diffusion.** Both the sequential and the parallel rule produce ordinary random walks
(MSD linear in *t*). The parallel one diffuses more slowly, in proportion to its lower
accepted-move rate — a **time rescaling**, not different physics. A rate parameter
absorbs it.

**Column separation** (a Chromatography-shaped fixture: 43×200, gravity bias, two
solutes with different stickiness, 400 generations, mean *unwrapped* downward
displacement):

| model | S1 (weak, stick .20) | S2 (strong, stick .70) | separation | occupancy |
|---|---|---|---|---|
| sequential (marked) | 16.8 | 7.3 | 9.5 | 5220 (**exact**) |
| parallel 2-phase | 8.4 | 4.8 | 3.6 | 5220 (**exact**) |

Both separate the solutes in the **same order and direction** — the weak solute elutes
ahead of the strong one. The parallel column advances less per generation, so the same
separation needs more generations. Same phenomenon, rescaled clock.

---

## 8. Recommendation

**Build (A).** A new `proposeMove` node plus an engine-owned resolve pass, with the
conflict policy as an explicit per-model setting. Keep async mode exactly as it is;
this is an *additional* way to express movement, not a replacement.

**Name it honestly.** The model-level setting should say what it is — e.g.
`moverPolicy: 'index' | 'hash' | 'attribute' | 'reject'` on `ModelProperties`, absent
⇒ the feature is off ⇒ every existing model byte-identical. Nothing here should be
called "async on the GPU"; it is a different, deterministic semantic.

### 8.1 Impact Map — subsystem by subsystem

| # | subsystem | change |
|---|---|---|
| 1 | **Schema** ([types.ts](../src/modeler/vpl/types.ts)) | `ModelProperties.moverPolicy?: MoverPolicy` and `moverNeighborhoodId?`. Additive + optional; **absent ⇒ off ⇒ no migration**. |
| 2 | **ModelContext** | Cascade `moverNeighborhoodId` on neighbourhood delete (the existing `clearDeletedId` pattern). LOAD_MODEL needs no guard (absent is the off state). |
| 3 | **Node** | New `proposeMove` — `NodeTypeDef` cloning `moveSelfToNeighbor`'s ports (`do`/`next`/`targetNI`) and its **entire config schema**. `requirements: {}` (sync-legal). Register in `ALL_NODES`; bump the catalogue count. |
| 4 | **Validation** | `detectMissingConfig`: badge a `proposeMove` in a model with no `moverPolicy`. Refuse a **sub-attribute** payload in v1. `LATTICE_ONLY_TYPES` gains it. `moveSelfToNeighbor` and `proposeMove` in the *same* graph is a compile error (two movement mechanisms, one payload). |
| 5 | **Layout** ([wasm/layout.ts](../src/modeler/vpl/compiler/wasm/layout.ts)) | `intentOffset`/`intentBytes`, appended **after `generationOffset`**; `gridCells && hasMover ? total*4 : 0`. |
| 6 | **JS compiler** ([compile.ts](../src/modeler/vpl/compiler/compile.ts)) | `proposeMove` emitter (writes the packed intent word). A **new resolve entry point** — a second compiled function, emitted only when the model has a mover, sharing the loop preamble and the `decodeCoordLines` machinery. Append `_intent` to the three param builders **after `_generation`**. |
| 7 | **WASM compiler** | The same two emitters; a second exported function (`resolve`) alongside `step`/`init`/`inputColor_*`/`outputMapping_*`. New func type if the arity differs. |
| 8 | **WebGPU compiler** | The `intentWordOffset` region inside `attrs`; the propose emitter; a **`resolve` entry point** dispatched with the swapped bind group. `emitPerCellCopyPreamble` must **skip** the intent region. Must use `dispatchCells`. |
| 9 | **Worker** ([sim.worker.ts](../src/simulator/engine/sim.worker.ts)) | The intent view alongside `generationCellView`; `runStep` gains the resolve call and the second ping-pong; the WASM sync bulk copy is **replaced** by the resolve's carry-forward; `buildLoopArgs` pushes `_intent` after `generation`. WebGPU: a second dispatch per generation. |
| 10 | **Indicators** | Move the linked/spatial scan hook to after the resolve. |
| 11 | **Sparse stepping** | Dilate the active set by the mover neighbourhood; extend the documented range contract. |
| 12 | **Save/load** | **Nothing.** The intent buffer is per-generation scratch and must not be serialised. |
| 13 | **UI** | A "Movement" block in Properties → Execution: the policy radio + the mover neighbourhood picker, shown only when a `proposeMove` node exists. Per the enabled-control doctrine, hide it otherwise. |
| 14 | **Docs** | CLAUDE.md (the WebGPU reject list — the pointer is already added), HelpView, README if the Features summary changes, `docs/NODES_REFERENCE.md` (table + counts). |
| 15 | **Harnesses** | `check-compile-identity.mjs` — **every existing model byte-identical on every surface** (the gate). A new `scripts/test-lattice-movers.mjs` asserting conservation, order independence and determinism, with source-mutation negative controls. JS↔WASM bit-parity for index and shared-RNG policies. Real-GPU verification of the resolve dispatch. |

### 8.2 Phased plan

Honouring **ALL-TARGET DELIVERY** and **2D + 3D from day one** — neither is a later
phase.

| phase | scope | gate |
|---|---|---|
| **P0** | This document + `PLAN_LATTICE_MOVERS.md` + HTML mockup of the Properties block and the graph delta | Owner decision on §5 (A vs D) and on the v1 policy set |
| **P1** | The mechanism: schema, node, intent buffer, propose + resolve on **JS, WASM and WebGPU**, **2D and 3D**, `operation: 'copyTo'` only, policies **index** + **hash** | `check-compile-identity` 100 % unchanged; conservation + order-independence + determinism harness with negative controls; JS↔WASM bit-parity; a real-GPU run |
| **P2** | `swap` (mutual intent), `attribute` and `reject` policies | Harness extended per policy |
| **P3** | Samples: a **parallel** Amphiphile/Chromatography variant shipped *alongside* the async originals (not replacing them — they are the reference semantics), and one **new large-grid** model that is inexpressible today. That last one is the feature's actual justification. | Real-GPU run at ≥1 M cells |
| **P4** | Docs sweep; `NODES_REFERENCE` counts | — |
| **later** | The chain extension (§7.6) with a bounded R; `copyFrom`; bounce/overlap | Re-measure before committing |

### 8.3 What would kill this

State the falsifiers up front:

- **If the resolve pass costs more than one extra dispatch's worth of time.** Two
  scans of `O(nbrSize)` per cell is one ordinary gather; if measurement says
  otherwise on a real GPU at scale, the economics change.
- **If nobody wants a large moving-entity model.** §3.3 shows the existing four gain
  little. P3's new sample is the test: if it cannot be made compelling, choose (D).
- **If the semantic difference is unacceptable to the owner.** The parallel rule is
  not the async rule. It is *a* correct parallel exclusion process, deterministic and
  exactly conserving — but a model ported across will not reproduce its old
  trajectory. That is a product judgement, and it belongs to the owner.

---

## 9. Appendix — facts verified in the codebase

Recorded so a later reader need not re-derive them.

- **Async loop shape** ([compile.ts](../src/modeler/vpl/compiler/compile.ts) ~:2216):
  `for (let _i = 0; _i < total; _i++) { const idx = order[_i]; if (_skipped[idx] !== 0) continue; … }`.
- **Single-buffer aliasing** ([sim.worker.ts](../src/simulator/engine/sim.worker.ts) :4623-4639):
  `if (isAsync || attrWriteAliased) { attrsB[attr.id] = arrA; }` … `writeAttrs = (isAsync || attrWriteAliased) ? attrsA : attrsB;`.
- **Sync post-step** (:5266-5292): WASM bulk-copies `w → r` (baked offsets); JS swaps refs.
- **`_skipped` is cleared every step** (:5180-5185) — per-step transient, never persisted.
- **Async order is drawn from the shared seeded stream** *before* the step runs, which
  is what makes an async model reproducible at all.
- **Neighbour table stride is `coords.length`** even in 3D, so `nIdx_<n>[idx*nSz+k]`
  is "3D for free"; the constant-boundary sentinel is index `total`, populated by
  `fillBoundarySentinel()`.
- **Sparse stepping already stores packed NIs** (`nSz` entries, not `total × nSz`) and
  decodes inline — the precedent for computing the inverse neighbour inline.
- **`INVALID_NI = 0x80000000`**; bit 31 is free in *both* the 2-D (16-bit halves) and
  3-D (10-bit thirds) encodings.
- **WebGPU grid uses 11 bindings (0–10), 10 of them storage.** Orientation rides
  `attrsRead`/`attrsWrite` at `orientationWordOffset`; lookup tables ride `varAux`;
  `generation` rides `Control`'s existing padding. **The established answer to "I need
  more per-cell state" is to pack, not to add a binding.**
- **`_generation` is the last ABI parameter**, pushed unconditionally by the worker and
  declared conditionally by the compiler ("params ≤ args is the safe direction").
- **`nbrTableDropped` detection is the regex `/nIdx_\w*\[/`** over emitted code.
