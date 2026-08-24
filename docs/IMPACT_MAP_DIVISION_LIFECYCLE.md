# Impact Map — Division & Agent Lifecycle

**Status:** D1 + D2 + D3 + D4 **SHIPPED** (2026-08-23); Feature 3 (the Spawn Event) and Design B remain deferred with their designs recorded here. Originally written as design-only. Companion illustrated plan:
[PLAN_DIVISION_LIFECYCLE.html](PLAN_DIVISION_LIFECYCLE.html).

Four coupled features on the bond-graph agent tier, all of them about **the moment an agent
comes into existence**:

| # | Feature | Decision |
|---|---|---|
| 1 | Divide Agent → references to the two daughters | **Design A (staged handles) REJECTED. Design C (empower the Division Event) ADOPTED — SHIPPED as D3 (`siblingId`) + D4 (structural requests + a second drain). Design B (per-daughter payload ports) DEFERRED.** |
| 2 | Division conserves AREA, not volume (3D) | **Add `conserve: 'area' \| 'volume'` to the Divide Agent node, default `'area'`, transported on the EXISTING partition table. Add a 3D-only `myVolume` output. NO Get/Set Area nodes.** |
| 3 | An on-spawn event for every newborn | **DEFER.** Full design recorded; ship the cheap 80 % (document the existing Init-Event loop-over-seeded-agents idiom) instead. |
| 4 | Interactions + invariants | Section 5. Includes one **latent footgun** and one **harness gap** found while grounding this doc. |

---

## 1. Verified baseline (read 2026-08-23)

Everything below was read in the code, not inferred. Line numbers are as of `tasks_batch_2026_08`
@ `6a8c443`.

### 1.1 A division is a REQUEST, applied at the end of the step

`DivideAgentNode.compile` ([DivideAgentNode.ts](../src/modeler/vpl/nodes/DivideAgentNode.ts))
emits, at its flow position in the **behaviour** pass:

```js
_divideRequest[idx] = <partition code>; _divideAxisX[idx] = …; _divideAxisY[idx] = …; _divideAsym[idx] = …;
```

The WASM ([agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts):3061-3071) and
WebGPU ([agentWebgpu/compile.ts](../src/modeler/vpl/compiler/agentWebgpu/compile.ts):2630-2635)
emitters write the same cells. **Nothing happens at that flow position** — the actual split runs
later, in `runAgentStructuralPhase` ([sim.worker.ts](../src/simulator/engine/sim.worker.ts):3685),
whose order is fixed:

```
1.  drainAgentBondRequests(s, lambda)      ← the P4 structural request queue (bonds)
1b. death            (killRequest → freeAgentSlot)
1c. division         (divideRequest → divideAgent), collecting divideEvents
    runDivisionEvent(divideEvents)         ← per daughter, JS on CPU on every target
2.  auto-bond by distance (+ hysteresis)
3.  sweepStaleBonds
```

Consequences that constrain every design in section 2:

- **At the Divide Agent node's flow position the daughters do not exist, and may never exist.**
  `divideAgent` ([agentEngine.ts](../src/simulator/engine/agentEngine.ts):2024) returns `-2` when
  the resolved partition would overflow either daughter's bond capacity (`if (aFinal > mb || bFinal > mb) return -2;`
  — :2125), `-1` when the agent ceiling is hit (`allocAgentSlot` returns -1 — :2126) or when the
  mother's position/radius is non-finite. **Invariant I5: a rejected division leaves the graph
  EXACTLY as it was.** The worker treats every negative return as "capacity", surfacing one
  `agentOverflow` notice.
- **The bond queue drains BEFORE division.** A queued Form Bond naming a not-yet-existing daughter
  is rejected by `formBond`'s own liveness gate. Reordering is not available: `Growing Graphs`'
  five-op split and `Cubic GRA`'s rewrites both depend on their queued ops applying against the
  **pre-division** adjacency in the same generation.
- **`divideRequest` is ONE cell per agent.** Two Divide Agent nodes reached in the same step
  collapse to one division carrying the **last** node's partition code (last write wins).

### 1.2 Daughter A reuses the mother's slot

`divideAgent` step 6: *"daughter A — reuse mother slot i; shrink + relocate, reset age, clear
request"*. Daughter B is a fresh slot from `allocAgentSlot` (:2126), which is **free-list-first**
— so daughter B can land on a slot a Kill freed *earlier in the same structural phase*, i.e.
**below** the division loop's cursor. That is safe today only because `initAgentSlot` zeroes
`divideRequest` on the recycled slot (:1169), so the loop cannot re-divide it.

Contrast the **behaviour**-graph spawn closures (`agentBehaviourCreate`,
[sim.worker.ts](../src/simulator/engine/sim.worker.ts):1147-1156) and the brush closures
(`makeBrushSpawnClosures`, :1976), which are deliberately **grow-only** (`s.highWater++`) so a slot
freed earlier in the same pass can never be handed straight back.

### 1.3 The two-phase spawn idiom, and its guard relaxation

`Create Agent` returns a `handle` and STAGES the slot at `alive = 0`; `Add Agent To World` commits
it. A `Create` never `Add`ed is swept (`freeStagedSlot`). Between the two, the by-id setters must
be able to write a slot that is *not alive* — which is exactly what
`agentRootRelaxesGuard` ([types.ts](../src/modeler/vpl/types.ts):88) encodes:

```ts
return agentRoot === 'init' || agentRoot === 'behaviour'
    || agentRoot === 'input' || agentRoot === 'spawner';
```

`'division'` is deliberately **excluded** — it never spawns, so its emitted guard stays the strict
`__sa>=0 && __sa<highWater && _alive[__sa]` (see `SetAttributeNode.compile`,
[SetAttributeNode.ts](../src/modeler/vpl/nodes/SetAttributeNode.ts):113).

On WebGPU there is no CPU closure to call, so `createAgent` bump-allocates with
`atomicAdd(&spawnCursor, 1u)` and writes the child directly
([agentWebgpu/compile.ts](../src/modeler/vpl/compiler/agentWebgpu/compile.ts):2688); the CPU
reconciles `[highWater, cursor)` after readback (`readbackAgentStep` in
[agentWebgpuRuntime.ts](../src/simulator/engine/agentWebgpuRuntime.ts)), committing the alive ones
via `initAgentSlot` and `freeStagedSlot`-ing the rest.

### 1.4 The division split conserves AREA — in 2D *and* 3D

[agentEngine.ts](../src/simulator/engine/agentEngine.ts):2132-2133, verbatim:

```js
const rA = r * Math.sqrt(Math.max(1e-4, aFrac));
const rB = r * Math.sqrt(Math.max(1e-4, 1 - aFrac));
```

So `rA² + rB² = r²` exactly, in **both** dimensions — there is no `cbrt` anywhere in `src/`
outside three unrelated call sites (a seed-cube side, a metaball resolution, a sphere sampler).
In 3D that means **volume is not conserved**: at the default symmetric split (`asym = 0.5`),

```
rA = rB = r/√2 = 0.7071·r    ⇒   VA + VB = 2·(1/√2)³·V = 0.7071·V
```

i.e. **~29 % of the volume disappears at every symmetric 3D division**. Volume-conserving radii
would be `r·∛f` (0.7937·r at f = 0.5) — ~12 % larger.

Shipped models that divide: `Morphogenesis - Growing Tissue`, `Morphogenesis - Differential Tissue`,
`Morphogenesis - 3D Tissue`, `Graph Metrics - Growth Sweep`. **`Morphogenesis - 3D Tissue` is the
one 3D model affected**, and per the standing rule (*shipped model configs are deliberate*) its
behaviour must not change.

Related: the engine growth ramp is linear **on radius**
(`s.radius[i] = … cur + Math.sign(dd) * growthIter`, [sim.worker.ts](../src/simulator/engine/sim.worker.ts):2792),
so any conserve mode is orthogonal to growth. `myArea` is emitted as `Math.PI * r * r` on the
behaviour root ([compile.ts](../src/modeler/vpl/compiler/compile.ts):2875) and the division root
(:2914) — **including in 3D**, where πr² is a disc area, neither a surface area nor a volume.

### 1.5 The Division Event is JS-on-CPU on every target — and that is cheap leverage

`AGENT_WASM_CPU_ROOT_TYPES` ([agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts):222)
is `{ divisionEvent, agentInit, createAgent, addAgentToWorld }`; the WebGPU agent compiler compiles
the behaviour root only. So **the `division` ABI kind has exactly two mirrors** — the compile-side
`buildDivisionParams` ([compile.ts](../src/modeler/vpl/compiler/compile.ts):2520) and the worker's
`buildDivisionArgs` ([sim.worker.ts](../src/simulator/engine/sim.worker.ts)) — plus the parity
harness. **No WASM bytes and no WGSL are involved.** Widening it is therefore an order of magnitude
cheaper than widening the `loop` kind.

Its current shape ([agentAbi.ts](../src/modeler/vpl/compiler/agentAbi.ts) `deriveAgentAbi`):

- leading scalars `idx, __daughterIndex, __axisDefaultX, __axisDefaultY`;
- the `singleAgent` bond **read** slice (`_bondPartner`, `_bondRestLength`, `_bondPartnerEpoch`,
  `maxBonds`) + the P2 `_bondAttr_*` block;
- **NO request-queue block** (`_bondFormReq` / `_bondBreakReq` / `_bondFormL` / `_bondFormK` /
  `_bondFormAttr_*` are `kind === 'loop'` only);
- `w_<attr>` **aliases `attrRead`** (writes land on the live buffer, because the structural phase
  runs after `swapAgentAttrs`);
- the trailing 3D block, then the usage-gated `_generation` (dead last).

### 1.6 The spawn paths, enumerated

| # | Path | Per-newborn hook today |
|---|---|---|
| 1 | Engine seeding (`seedCount`/`seedPattern`, `initAgents` → `seedAgents`) | **none** — attribute defaults only |
| 2 | Agent Init Event `Create Agent → … → Add Agent To World` | full by-handle configuration |
| 3 | Behaviour-graph Create/Add (unified spawning) | full by-handle configuration |
| 4 | **Division** | the **Division Event**, per daughter |
| 5 | Add brush (`seedAgents` message + `sets`) | the seed-config panel (per-attribute values) |
| 6 | Spawner input mapping (`spawnAgentsBrush`) | a graph — full by-handle configuration |
| 7 | Editor input mapping (`paintAgentsColor`) | a graph — full by-handle configuration |
| 8 | `pasteAgents` (clipboard, CSV import, GeoJSON import) | per-agent values from the source data |
| 9 | `loadState` / preset restore | not a birth — restores a whole population |

Only **(1)** has no hook at all, and even there the agents exist before `runAgentInit` runs, at ids
`[0, seedIndexBase)` — see section 4.

---

## 2. Feature 1 — daughter references from Divide Agent

> *"'Divide Self' should ideally provide as output ports the references to the two daughters as an
> alternative to having to rely on the division event, since at the division moment is when the user
> would have the most contextual information to set attributes on the daughters, bonds and such."*

The request bundles two sub-needs, and they have very different costs:

- **(i) set daughter ATTRIBUTES with behaviour-step context.** Expressible today, awkwardly: write
  the context into an agent attribute immediately before Divide Agent; both daughters inherit it
  **verbatim** (`divideAgent` step 5 copies every `attrRead` entry to daughter B; daughter A *is*
  the mother slot), and the Division Event reads it. Cost: one carrier attribute per context value.
- **(ii) form a BOND from a daughter to a third party.** **Not expressible at all.** P5's partition
  only redistributes the mother's *existing* bonds; D4's `daughterBond` only adds the A–B bond; and
  the Division Event's ABI carries no request queue, so Form Bond is unusable there. The only
  workaround is to flag the daughter and let its own behaviour step form the bond **one generation
  later** — which is precisely the transient-intermediate-state problem GRA rules exist to avoid.

### 2.1 Design A — staged daughter handles: **REJECTED**

*Shape:* at the Divide Agent flow position, pre-allocate both daughters (the Create Agent idiom) and
expose two `handle` outputs; the structural phase adopts those slots instead of allocating, or
sweeps them if the division is rejected.

Analysed honestly, and it fails on its own central promise:

1. **Daughter A's handle IS the mother, so writes through it cannot be rolled back.** Handle A can
   only be `idx` (the mother's slot — moving daughter A to a new slot would invalidate every
   `bondPartner` entry pointing at the mother and defeat the whole reason the slot is reused). So a
   "set daughter A's energy" write during the behaviour pass:
   - **is visible to the rest of the step** — this agent's own later reads and every neighbour
     reading it by id see the daughter value on a still-undivided mother;
   - **cannot be undone when the division is rejected** (capacity, non-finite position), which
     breaks **I5** as the user experiences it: a rejected division would leave a *modified* agent.
   Daughter B has no such problem (its writes land on a slot the sweep returns to the free list,
   where `initAgentSlot` clears them), so the flaw is specific to — and unavoidable for — A.
2. **The only fix is a shadow buffer**, i.e. buffer every by-handle write and replay it at commit:
   2 × (every agent attribute + geometry) × `maxAgents` of new per-agent state, a new ABI block, new
   WASM baked offsets, new GPU runs, and a "pending handle" encoding every by-id setter must decode.
   That is far larger than the whole rest of this document.
3. **Ordering blocks the bond half anyway.** A Form Bond naming staged daughter B is drained
   *before* division, when B is `alive = 0`, so `formBond` rejects it. Fixing that needs either a
   reordering (a semantic change to every shipped GRA model — rejected) or a second drain — and once
   a second drain exists, the Division Event route (2.3) needs no staging at all.
4. **GPU cost.** The reconcile currently sorts `[hw, cursor)` into *committed* and *staged-and-swept*.
   A division-staged slot is a third category (alive = 0 but must be handed to `divideAgent`, not
   freed), which needs a new lane to mark it — appendable, but real work on a path this feature does
   not otherwise touch.
5. **Multi-node edge.** Two Divide Agent nodes on one agent already collapse to one division; with
   staging, the losing node leaks a staged slot that a new sweep must reclaim.

**Decision: do not build Design A.** Record the reasoning here so it is not re-proposed. (The
literal "output the ids, read-only" variant is also rejected: a value output whose value does not
exist at its own flow position is the enabled-control-that-does-nothing anti-pattern.)

### 2.2 Design B — per-daughter payload ports: **DEFERRED**

*Shape:* Divide Agent grows per-daughter initial-value input ports (one pair per agent attribute,
built by a shared port builder like Form Bond's per-bond-attribute ports), the values ride the
request, and `divideAgent` stamps them at commit.

**Sound** — race-free, whole-or-nothing by construction, no handle lifetime, and it works
identically on all three targets because it is only more request lanes. But:

- It addresses **only sub-need (i)** — it structurally cannot express "bond daughter B to X".
- Its marginal value over *carrier attribute + Division Event* is real but modest: fewer carrier
  attributes and asymmetric assignment without a `daughterIndex` switch.
- It is the **expensive** half: N agent attributes × 2 daughters × `maxAgents` f64 lanes, on the CPU
  layout **and** the WASM baked offsets **and** the GPU SoA. A usage gate (only wired attributes get
  a lane, unioned across every Divide Agent node, model-derived like `bondReqSlotsForModel`) keeps
  it byte-identical for everything else, but the machinery is a phase of its own.

**Decision: defer.** Revisit only if authoring friction persists after Feature 1's adopted design
ships. It is the natural D-phase after this document's plan.

### 2.3 Design C — empower the Division Event: **ADOPTED**

The Division Event runs **after** `divideAgent` has committed: both daughters exist, both are alive,
both ids are known, and the graph is settled. Everything the user asked for is expressible there —
what is missing is (a) the *identity* of the other daughter and (b) the ability to issue structural
requests. Both are small, and both are cheap **because the division root is JS-on-CPU on every
target** (§1.5).

**C1 — a `siblingId` value output on Division Event.**
`runDivisionEvent` already holds `{ mother, a, b }` for every event
([sim.worker.ts](../src/simulator/engine/sim.worker.ts):1893), so the sibling is free to pass. With
it, one Division Event invocation can set **both** daughters' attributes by id — the strict
`_alive[__sa]` guard the division root emits is satisfied, because both daughters are alive at that
point. This alone covers sub-need (i) with no new storage anywhere.

**C2 — the structural request queue in the `division` ABI, plus a SECOND drain.**
Add the `loop` kind's queue block (`_bondFormReq`, `_bondBreakReq`, `_bondFormL`, `_bondFormK`,
`_bondFormAttr_*`) to the `division` kind and run `drainAgentBondRequests` a second time, right
after `runDivisionEvent(divideEvents)`. This is safe by construction, and each reason was verified:

- **The drain zeroes each entry before decoding it**
  ([agentEngine.ts](../src/simulator/engine/agentEngine.ts):1673 —
  `s.bondBreakReq[base + c] = 0; s.bondFormReq[base + c] = 0;`), so a second pass re-applies nothing
  and picks up only what the division events queued.
- **Both daughters' queues are provably empty at that moment.** Daughter A's is the mother's, drained
  in step 1; daughter B's was cleared by `initAgentSlot` → `clearAgentBondRequests`.
- **No layout change.** `bondReqSlotsForModel`
  ([bondRequestQueue.ts](../src/modeler/vpl/compiler/bondRequestQueue.ts)) scans
  `model.agentGraphNodes` — which is the whole agent graph, division subtree included — so a queue
  verb in a Division Event **already** sizes the queue today.
- **I5 is inherited per op** (`formBond` / `breakBond` / `rewireBond` / `transferBond` are each
  whole-or-nothing), and the overflow bucket is still never applied.

**C2 also closes a latent footgun.** No compile-time gate was found that stops a Form Bond being
placed in a Division Event today: `AGENT_SELF_ONLY_TYPES`
([nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts):1009) lists the bond verbs for the
**init** root only, and the JS emitter would happily emit `_bondFormReq[…]` — a reference the
division signature does not carry, so the division function throws at runtime
(`_bondFormReq is not defined`), `agentDivisionFn` is nulled and every later division event is
silently skipped. **Either C2 lands (making it work) or a validation badge lands (making it
refuse); leaving it as-is is the one option that is wrong.**

### 2.4 The recommendation, stated

1. **Build C1 then C2.** Together they give the user what they asked for at the only point where it
   is sound, and C2 closes the one thing that is genuinely inexpressible today.
2. **Do not build A**, for the I5/mother-slot reason above.
3. **Defer B**, and re-evaluate after C ships.
4. **Document the carrier-attribute idiom** ("write your context to an agent attribute immediately
   before Divide Agent; both daughters inherit it verbatim") in HelpView and the Divide Agent node
   description — it is the answer today and it stays the answer for values that are cheaper to carry
   than to re-derive.

Honest limitation to state in the docs: **the Division Event still cannot see behaviour-step LOCAL
VARIABLES** (they are per-agent per-step scratch and are gone by the structural phase). The carrier
attribute is the bridge, and Design B would not change that either — it would only move the carrier
from an attribute to a port.

---

## 3. Feature 2 — area vs volume conservation

### 3.1 Decision

Add **`conserve: 'area' | 'volume'`** to the Divide Agent node.

- **Default `'area'`** — byte-identical to today's `Math.sqrt` split, so all four shipped dividing
  models (and every user file) are untouched.
- **`'volume'`** uses `rA = r·∛f`, `rB = r·∛(1−f)`, so `rA³ + rB³ = r³`.
- **In 2D the option is HIDDEN, and the ENGINE coerces it.** The two modes are *not* the same
  arithmetic in 2D (∛ ≠ √), but "conserve r³" is physically meaningless on a disc, so the config row
  is hidden for a 2D-agent model **and** the resolver returns `'area'` when `D <= 1` — the standing
  rule that a hidden control must have its *state* handled, not just its markup, so a hand-edited 2D
  file cannot silently change behaviour.

### 3.2 Transport — reuse the P5 partition table, so this costs nothing on any target

`conserve` is a **per-node constant**, exactly like the partition mode — so it belongs in
`DividePartitionSpec` ([dividePartition.ts](../src/modeler/vpl/compiler/dividePartition.ts)), not in
a request lane. That gives, for free:

- **no new store field, no ABI field, no layout change, and no emitter change on any of the three
  targets** — every emitter already writes `dividePartitionCode(config)` into the existing
  `divideRequest` cell;
- per-node fidelity plus dedupe;
- structured-clone-safe transport in the init/recompile message (one more string).

**The byte-identity argument, spelled out.** `dividePartitionKey` gains a `|${conserve}` suffix. Every
existing spec resolves to `'area'`, so **the same suffix is appended to every key** — the relative
sort order is unchanged, so every assigned 1-based code is unchanged, so `_divideIdx` is unchanged,
so the emitted text/bytes/WGSL are unchanged. (This is exactly the kind of change that could
silently renumber codes if the new field were inserted *inside* the key; it must be appended.)

> **SHIPPED REFINEMENT (D2, 2026-08-23).** The implementation appends the suffix **only for the
> non-default `'volume'`**, so an area spec produces the *byte-identical* pre-D2 key rather than a
> uniformly-extended one. Both forms preserve the sort order — no key can be a proper prefix of
> another, since all five fields are `|`-delimited and the last is one of three non-prefixing words
> (`auto` / `always` / `never`) — but leaving existing keys untouched is strictly stronger and makes
> the claim decidable by inspection instead of by that argument. A collision is impossible either
> way: a volume key ends `|volume`, an area key ends in its `daughterBond` word. The resolver also
> coerces `'volume' → 'area'` for a 2D model (in addition to the engine's `D <= 1` coercion), so a
> 2D file's key and code are unchanged whatever its config says.

Total production change: `DividePartitionSpec` + `dividePartitionFromConfig` + `dividePartitionKey`
+ `DEFAULT_DIVIDE_PARTITION`, the two `Math.sqrt` lines in `divideAgent` (behind a resolved mode),
and one CaNode config row.

### 3.3 Reading volume: add `myVolume` (3D only), and no Area nodes

- **`myVolume` output** on Behaviour Step and Division Event, `hiddenPorts`-gated on
  `is3dModelLike`, emitting `(4/3)·π·r³` at the same three sites `myArea` is emitted
  ([compile.ts](../src/modeler/vpl/compiler/compile.ts):2875/2914,
  [agentWasm/compile.ts](../src/modeler/vpl/compiler/agentWasm/compile.ts):955,
  [agentWebgpu/compile.ts](../src/modeler/vpl/compiler/agentWebgpu/compile.ts):847). **A
  "conserve volume" option with no way to read volume is a half-feature**, which is why this rides
  the same phase — but it is a clearly separable sub-item if the session runs long. Usage-gated like
  every other multi-output port, so an unused port costs nothing.
- **NO `Get Area` / `Set Area` nodes.** `Get Area` is `Get Radius` + one Math node; `Set Area` is one
  Expression (`sqrt(A/π)`) + `Set Agent Radius`. Neither earns a catalogue slot under the standing
  anti-bloat rule, and in 3D the word "area" is wrong anyway.
- **Document the πr² wart.** `myArea` is πr² *even in a 3D model*. Changing it is off the table
  (shipped models read it, and it is on all three targets), so the node descriptions and HelpView
  must say plainly: *"Area is πr² — a disc area, in 2D and 3D alike; use Volume in 3D."*

---

## 4. Feature 3 — an on-spawn event: **DEFER**

### 4.1 Why not now

Against building it:

- **Only one of the nine spawn paths (§1.6) has no hook at all** — engine seeding — and even that has
  a working idiom today (§4.3).
- **The composition semantics have no obviously-right answer, at eight call sites.** Does a Spawn
  Event run *before* or *after* a `pasteAgents` row's values (before = overwritten, after =
  overwrites the imported data)? Before or after the Add-brush seed-config panel? Does it run for
  division daughters — where it would double up with the Division Event, and in what order? Every
  one of those becomes folklore the moment it is guessed at, and each is invisible until a user hits
  it.
- Graph-spawned agents (paths 2, 3, 6, 7) **already** have full by-handle configuration at the spawn
  site, which is strictly more expressive than a hook: the spawner knows *why* it is spawning.

For building it (recorded honestly): a Spawn Event is the only way to state a **population-wide
invariant** — "every agent, however it was born, gets a random phase" — in one place. That is a real
value, but it is a convenience over a correctness gap, and it can be added later without disturbing
anything shipped.

### 4.2 The design, if a later session builds it

- **Root:** `agentSpawnEvent` (event category, white, `requirements.bondGraph`, singleton).
- **Ports:** `DO` flow out; `spawnSource` (integer/tag: 0 seed, 1 init, 2 behaviour, 3 division,
  4 brush, 5 paste/import) so a rule can branch; `myX`/`myY`/`myZ`/`myRadius` for convenience
  (all derivable from the self accessors, so optional).
- **ABI kind:** a new `spawn` kind — structurally the existing `input` kind (single-agent, leading
  `idx`, `w_` aliasing `attrRead`, no hash) minus the brush block. **JS-on-CPU on every target**, the
  same posture `division` and `agentInit` already take.
- **Ordering, decided per path (this table is the deliverable, not an afterthought):** it runs
  **last** on every path — after the seed values, after the paste/import row, after the brush
  panel's sets, after the Division Event. "Last" is the only rule that composes: the event can then
  read what the path supplied and override deliberately, and no path silently loses its data.
- **Call sites:** `initAgents` (after `seedAgents`), `runAgentInit` (after the leak sweep),
  `runAgentStep`'s spawn sweep, `runAgentStructuralPhase` (after `runDivisionEvent`),
  `seedAgents`/`spawnAgentsBrush`/`paintAgentsColor`/`pasteAgents` message handlers.
- **Residency:** a per-generation CPU touch point only when the behaviour graph spawns — i.e. it adds
  nothing, since `usesSpawn` is already a residency blocker
  ([agentResidency.ts](../src/model/agentResidency.ts)).

### 4.3 The cheap 80 % to ship instead

Engine-seeded agents occupy ids `[0, seedIndexBase)` — `_agentSeedBase` is `s.highWater` captured at
the **top** of `runAgentInit` ([sim.worker.ts](../src/simulator/engine/sim.worker.ts):1833), i.e.
*after* `initAgents()` laid the seed baseline. The Agent Init Event already exposes it as the
**Seed Index Base** output ([AgentInitNode.ts](../src/modeler/vpl/nodes/AgentInitNode.ts)), and a
by-id `Set Attribute` **is** valid in the init root (`agentRootRelaxesGuard('init')` is true, so it
emits the range-only guard, which the init ABI carries).

So this works **today** and nobody knows it:

```
Agent Init Event ─ DO ─▶ Loop (Count = Seed Index Base)
                              └─ body ─▶ Set Attribute (Agent = Loop.index, value = …)
```

**Action: document that idiom** (HelpView + the Agent Init Event node description), and consider
relabelling the port *"Seeded Count / Seed Index Base"* so it reads as the loop bound it is. That is
a doc change plus at most one label, and it removes most of the felt gap.

---

## 5. Interactions, subsystems and invariants

### 5.1 Subsystem impact table

| Subsystem | Feature 1 (C1 `siblingId`) | Feature 1 (C2 queue + 2nd drain) | Feature 2 (`conserve`) | Feature 3 (deferred) |
|---|---|---|---|---|
| Schema (`types.ts`) | — | — | — | — |
| Node defs | `divisionEvent` +1 output | none (existing bond verbs become valid) | `divideAgent` config + `myVolume` on 2 roots | new root |
| `dividePartition.ts` | — | — | **spec + key + resolver** (the whole transport) | — |
| `bondRequestQueue.ts` | — | none (`bondReqSlotsForModel` already scans the division subtree) | — | — |
| `agentAbi.ts` | +1 **gated, trailing** scalar on `division` | + the queue block on `division`, **gated** | — | new `spawn` kind |
| JS agent compiler | preamble for the new output | nothing (the bond emitters are already generic) | — | new root compile |
| WASM agent compiler | **none** (division is a CPU root) | **none** | **none** (emit unchanged) | none |
| WebGPU agent compiler | **none** | **none** | **none** | none |
| `agentEngine.ts` | — | — | the two `Math.sqrt` lines | — |
| `sim.worker.ts` | `buildDivisionArgs` + `runDivisionEvent` | one extra `drainAgentBondRequests` call + its overflow notice | consumes `spec.conserve` | 8 call sites |
| Capability gates | — | bond verbs already require `bonds` | division already requires `division` | — |
| `nodeValidation.ts` | — | **remove the latent footgun** (§2.3) | badge an unresolvable conserve? (not needed — it is a closed enum) | — |
| `geometryTaint.ts` | `siblingId` is an agent id, **not geometry** — no source | bond verbs are already `STRUCTURAL_VERBS` | `conserve` is config, not a wire | new root in `ROOT_TYPES` |
| Serialization | — | — | one config key (already covered by the whole-object walker) | — |
| Residency | — | — | — | no new blocker |

### 5.2 Invariants each feature must preserve

| Invariant | Exposure |
|---|---|
| **I1** handshake (`Σdeg = 2\|E\|`) | C2 — every op still goes through the engine verbs |
| **I2** bond symmetry | C2 — same |
| **I3** no dangling | C2 — same |
| **I4** capacity | C2 — `formBond` rejects on either side full |
| **I5** whole-or-nothing | **the binding constraint on Design A** (§2.1); C2 inherits it per op |
| **I6** degree preservation | C2 — a division-event Rewire is atomic, as in the behaviour pass |
| **I7** conservation across division | Feature 2 changes *radii*, never the bond multiset — I7 untouched |
| **2D is a strict PREFIX of 3D** (ABI) | C1/C2's new fields must be appended **after** the 3D block (the `_generation` precedent), and `audit-agent-layout.mjs` must learn to strip them like it strips `_generation` |
| **The `AgentAbiShape` mirror rule** | every shape builder — `agentAbiShapeOf` ([compile.ts](../src/modeler/vpl/compiler/compile.ts):2526), `agentAbiShapeOfStore` ([sim.worker.ts](../src/simulator/engine/sim.worker.ts):1784), and the parity harness — must carry the new flags, or every later arg shifts |

### 5.3 The gate-side asymmetry decision (do not copy `_generation` blindly)

`_generation` is param-gated but **always** passed, which the worker's DEV arity assert tolerates as
`params ∈ {args − 1, args}`. Adding a *second* always-passed-but-param-gated field would widen that
tolerance to `args − 2` and weaken the check.

**Decision: gate C1 and C2 SYMMETRICALLY.** Unlike the generation counter, the worker can cheaply
know whether the division graph uses them — ship `usesDivisionSibling` / `usesDivisionRequests`
flags in the init/recompile message alongside the other compiler-derived flags, and gate both the
param side and the arg side on them. The arity assert then stays exact.

### 5.4 Byte-identity mechanism, per feature

| Feature | Mechanism | Surface |
|---|---|---|
| C1 | symmetric usage gate on the ABI shape | `agent.divisionCode` unchanged unless the graph wires the port |
| C2 | symmetric usage gate + the second drain gated on the same flag | `agent.divisionCode` and the structural phase both unchanged for every shipped model |
| Feature 2 | **key-suffix** append ⇒ identical sort order ⇒ identical `_divideIdx` | all surfaces unchanged, on all three targets |

### 5.5 ⚠ Harness gap found while grounding this document

**`scripts/check-compile-identity.mjs` does not hash the division or init code.** Its surface list
([check-compile-identity.mjs](../scripts/check-compile-identity.mjs):44-63) captures
`agent.behaviourCode`, `agent.wasm.bytes`, `agent.webgpu.shader`, `agent.webgpu.om` — but **not**
`agent.divisionCode` and **not** the agent init code. Every change in this document's Feature-1 plan
lands squarely in that blind spot: a division-ABI regression would pass the project's primary
byte-identity gate silently.

**This must be fixed before, not after, Feature 1** — it is phase D1 below.

> **SHIPPED (D1, 2026-08-23).** `compileAll` now returns `agent.divisionCode` + `agent.initCode` and
> the script hashes both. Non-vacuous on the shipped library: 2 models carry a Division Event
> (Morphogenesis — 3D Tissue / Differential Tissue) and 7 carry an Agent Init Event. An OLD baseline
> stays usable — `--compare` iterates the baseline's own keys, so the new surfaces are simply absent
> there rather than reported as diffs.

### 5.6 Harnesses to extend

- **`scripts/check-compile-identity.mjs`** — add the missing surfaces (D1), then re-baseline.
- **`scripts/verify-graph-rewrite.mjs`** — tiers A…P exist (K retired); **Tier Q** is the next free
  letter. New tier for C2: a division event that forms/breaks a bond, asserting I1–I4 immediately
  after, plus the negative control that the op does **not** apply twice (the second drain re-running
  a first-pass op).
- **`scripts/parity-agent-wasm.mjs`** — the division root is CPU-only, so parity is not the right
  gate for C1/C2; its `[synthetic] Division partition` entry **does** cover Feature 2's transport and
  must be extended with a `conserve: 'volume'` spec so the key/code assignment is pinned.
- **`scripts/test-agent-abi.mjs`** — the `division` kind's arg list against an independent
  expectation, with and without each new gate.
- **`scripts/audit-agent-layout.mjs`** — teach it to strip the new trailing gated fields before the
  2D-prefix-of-3D comparison (it already does this for `_generation`).

### 5.7 Standing risks

- **The second drain's overflow message** would fire twice in a step for a graph that overflows in
  both passes. Deduplicate, or label the second one ("during division events") — a repeated
  identical toast reads as a bug.
- **`divideAgent`'s return codes are conflated by the caller.** `-1` (ceiling / dead / non-finite)
  and `-2` (bond capacity) both surface as *"Agent or bond capacity reached"*. Not caused by this
  work, but any phase touching that loop should split the message — a non-finite mother reported as
  "capacity reached" sends the user to the wrong setting.
- **Free-list-first allocation in `divideAgent` vs grow-only everywhere else** (§1.2) is a genuine
  asymmetry. It is safe today; any future staging design must re-derive that safety rather than
  assume it.

---

## 6. Phased implementation plan

Ordered **safest-first**. Each phase is sized for one session and carries its own gates. The
headline feature is D4; D2 can be pulled ahead of D3 if the user prefers the visible win first.

### D1 — close the byte-identity blind spot *(tiny, prerequisite)*

- Add `agent.divisionCode` and the agent **init** code to `check-compile-identity.mjs`'s surface
  list; re-capture the baseline.
- Gates: `check-compile-identity --capture` then `--compare` on an unmodified tree (must be clean);
  `npx tsc -p tsconfig.app.json --noEmit`.
- **Why first:** every later phase's central claim ("no shipped model changes") is unverifiable
  without it.

### D2 — `conserve: 'area' | 'volume'` (+ 3D `myVolume`) *(small)*

- `DividePartitionSpec.conserve` + `dividePartitionFromConfig` + `dividePartitionKey`
  (**suffix**, §3.2) + `DEFAULT_DIVIDE_PARTITION`.
- `divideAgent`'s two radius lines behind a resolved mode; engine coerces to `'area'` when `D <= 1`.
- CaNode config row, hidden in 2D.
- `myVolume` output on Behaviour Step + Division Event, 3D-gated, emitted at the three `myArea` sites.
- Docs: the πr² wart (§3.3), the 29 %-volume-loss fact, and that `'area'` remains the default.
- Gates: `check-compile-identity` (**29 models, all surfaces unchanged** — the phase's headline
  claim); `test-agent-abi`; `parity-agent-wasm` with the extended division-partition synthetic;
  `verify-graph-rewrite` Tier H (the partition tier) still green; a real-worker 3D run showing
  `rA³ + rB³ = r³` under `'volume'` and `rA² + rB² = r²` under `'area'`.

### D3 — Division Event `siblingId` *(small)*

- One output port; one **gated, trailing** ABI scalar with a `usesDivisionSibling` flag shipped both
  ways (§5.3); `runDivisionEvent` passes the other daughter.
- Docs: the "one event sets both daughters" idiom, and the carrier-attribute idiom for context.
- Gates: `check-compile-identity` (now covering `agent.divisionCode` — must be unchanged for every
  shipped model, since none wires the port); `test-agent-abi` with and without the gate;
  `audit-agent-layout`; a real-worker run asserting each daughter reads the other's id.

> **SHIPPED (D3, 2026-08-23).** The port is `siblingId` ("Sibling"), the ABI scalar is `__siblingId`,
> and both are gated on **`agentUsesDivisionSibling`** ([divisionUse.ts](../src/modeler/vpl/compiler/divisionUse.ts)),
> SHIPPED to the worker in the init/recompile message so the gate is symmetric exactly as §5.3
> decided. Two refinements worth recording. **(a) The compiler emits the `_v<id>_siblingId` alias
> from the SAME model-level predicate that gates the param, NOT from its own flattened-edge test** —
> which makes the predicate's direction load-bearing: `true`-but-unwired is a dead `const`,
> `false`-but-wired is an undeclared identifier. It is therefore a deliberate SUPERSET (it also scans
> any macroDef that itself holds a `divisionEvent`), and every flattening preserves the edge's
> SOURCE, so a raw-model scan really is one. **(b) The block sits after the 3D block but BEFORE
> `_generation`**, which stays dead last on every kind — so `audit-agent-layout`'s "the trailing
> field is LAST on both sides" claim and the worker's `params ∈ {args − 1, args}` tolerance both keep
> their shape; the audit gained a generic trailing-gated strip plus a new (stronger) claim that the
> gated tail is IDENTICAL in 2D and 3D.

### D4 — Division Event structural requests + the second drain *(medium — the headline)*

- The `loop` queue block added to the `division` ABI kind, gated by `usesDivisionRequests`.
- A second `drainAgentBondRequests` after `runDivisionEvent`, gated on the same flag; overflow
  message disambiguated (§5.7).
- Node availability/validation: the four bond verbs become legitimately valid in the division root
  (and the latent footgun of §2.3 disappears with them).
- Gates: `check-compile-identity`; a new **Tier Q** in `verify-graph-rewrite.mjs` — a daughter bonds
  a third party in the same generation, with I1–I4 asserted immediately after, an I5 rejection case
  (capacity), and a **negative control proving the second drain does not re-apply a first-pass op**
  (source-mutate the entry-zeroing to see it fail); `test-agent-abi`; `audit-agent-layout`; a
  real-worker run on all three agent targets (the behaviour target varies even though the division
  root does not — that combination is exactly what must not regress).

> **SHIPPED (D4, 2026-08-23).** `usesDivisionRequests` gates the ABI block AND the second drain,
> shipped to the worker beside D3's flag. Refinements and findings:
>
> - **The usage scan is DIVISION-SUBTREE-SCOPED, and that is not optional.** A whole-graph scan
>   would hand every GRA model that rewrites bonds in its BEHAVIOUR step *and* carries a Division
>   Event a queue block it never uses, diffing its `agent.divisionCode`. The scan therefore walks
>   reachability from the division root over the model's own edges (the `behaviourReachedIds` shape).
>   Pinned in `test-agent-abi` Tier 4 both ways: a behaviour-chain bond verb must NOT widen the ABI,
>   a reached macro whose body holds one MUST.
> - **The `_brqC` cursor is one `let` at the top of the division fn.** It is a SINGLE-agent function,
>   so per-invocation is per-"iteration"; each of the two calls starts at slot 0 of its own agent's
>   provably-empty queue.
> - **The second drain is additionally gated on `divideEvents.length > 0`** — no division, no events,
>   nothing to drain.
> - **No `nodeValidation` change was needed.** The init-invalid set (`AGENT_SELF_ONLY_TYPES` /
>   `AGENT_SELF_ONLY_WHEN_UNWIRED`) is scoped to the **init and spawner** roots — there was no
>   division-root validity machinery at all, which is precisely why §2.3's footgun existed. Making
>   the verbs work removes it.
> - **Gates as run:** `check-compile-identity` **31 models, all surfaces unchanged**;
>   `verify-graph-rewrite` **643 → 699** (Tier Q, 56 checks, including the cross-target arm below);
>   `test-agent-abi` **629 → 1048**; `audit-agent-layout` **347 → 443**; `parity-agent-wasm` green;
>   `tsc` clean. The entry-zeroing source mutation fails **4 Tier-Q checks by name** (23 harness-wide)
>   and was reverted.
> - **⚠ The "all three agent targets" run used the NODE harness, not a browser** (the Chrome tooling
>   was unreachable in that session). Tier Q §6 runs the JS behaviour and a REAL instantiated WASM
>   behaviour module over a wasmBacked store through the SHIPPED structural-phase order and asserts
>   they produce the IDENTICAL bond graph and sibling ids; the WebGPU arm proves the gate + shader
>   and that the shader carries no division-root code (so the division stays the same CPU fn). A real
>   browser pass is still worth doing.

### Deferred, with reasons

| Item | Why deferred |
|---|---|
| **Design B — per-daughter payload ports** | Sound but expensive (lanes on three layouts); the adopted C1/C2 covers the same sub-need. Revisit only on measured authoring friction. |
| **Design A — staged daughter handles** | **Rejected**, not deferred: daughter A is the mother slot, so by-handle writes cannot be rolled back on a rejected division (I5). §2.1. |
| **Agent Spawn Event** | Deferred with a complete design (§4.2). Ship the documented Init-Event idiom (§4.3) instead. |
| **`myArea` → a dimension-correct name/value** | Shipped models read it on all three targets; renaming or redefining it is churn for a documentation problem. Document instead. |
| **Splitting `divideAgent`'s `-1`/`-2` overflow messages** | Real but unrelated; fold into whichever phase next touches the division loop. |
