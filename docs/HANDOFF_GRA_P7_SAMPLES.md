# PHASE P7 — The flagship samples (Cubic GRA, SDCA) + the documentation sweep

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3, §5. Design authority:
[PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P7, §4 (oracles **O6**, **O8**), §5 ·
[IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md) §6.2 (why our
operation set is safe to define ourselves).

**State**: **DONE** (see the Completion Report) · **Depends on**: P1–P6 + P4b (all DONE) ·
**This is the final phase — the milestone is COMPLETE.**

---

## 1. Why this phase exists

Every capability is now in place and individually verified. **Nothing yet shows a
user what the milestone is FOR.** This phase ships the two models that make the
capability legible, and proves the milestone's headline oracle **O6** inside a real
library model rather than a synthetic.

---

## 2. Sample A — `Cubic GRA` (the flagship)

A 3-regular graph rewriting itself while **staying** 3-regular. The rule is a
**table** and a **Randomize button**; the Overseer sweeps rule space and reports which
rules grow, die or blow up. That is the whole thesis of the milestone in one model.

### 2.1 The operation set (ours, deliberately — Impact Map §6.2)

| op | effect | ΔN | ΔE |
|---|---|---|---|
| **triangle split** — `v(a,b,c)` → `v₁,v₂,v₃`, `v₁–a`, `v₂–b`, `v₃–c`, triangle `v₁v₂v₃` | each new node: 1 external + 2 triangle = deg 3 | +2 | +3 |
| **edge swap** — `(a–b, c–d)` → `(a–c, b–d)` | — | 0 | 0 |
| **idle** | — | 0 | 0 |

`E = 3N/2` is preserved exactly (`3N/2 + 3 = 3(N+2)/2`). ⚠️ This is **our** set, not a
claim about Suzudo's — see Impact Map §6.2. Say so in the model description; do not
claim faithfulness to a specific paper.

**Triangle contract** (the inverse, ΔN −2 / ΔE −3) is **optional**. Include it only
if it lands cleanly; a growth-only rule already exercises O6 fully. If you skip it,
say so.

### 2.2 Build notes handed down (do not rediscover these)

- **The split is 5 queue ops** — 2 Rewire Bond + 3 Form Bond Between. Create Agent and
  Add Agent To World are host calls consuming **no** queue slot. It keeps `v₁` at
  degree 3 throughout, so it runs at **`maxBonds: 3`** and needs **no raised queue
  depth** (P4b).
- **The K4 bootstrap cannot live in the Agent Init Event** — Form Bond is init-invalid
  (it writes the queue at `idx`). Seed from the **behaviour graph gated on
  `myBondDegree == 0`**; a newborn already has degree 3 by its first behaviour step,
  so it never re-seeds (P4b).
- **Seed deterministically**: `seedPattern: 'scatter'` uses `Math.random()`. A rule
  reading bond degree is geometry-coupled, so use **`compact`** or the sweep will not
  reproduce (P6).
- **Sweep on JS/WASM, not the WebGPU agent target.** `setRngSeed` re-seeds the shared
  xorshift32 stream, but the WebGPU agent PCG is seeded once at runtime creation and
  never re-seeded, so a WebGPU-agent experiment does not reproduce (P6). Ship the
  sample on `wasm` and say why in the description.
- **The rule table**: census (`Neighbour Census` over the state attribute) → N-D
  Lookup Table (**tag-valued**: Idle / Split / Swap) → Switch → the verbs. Seeded
  **Randomize** so the user can roll rules. Clone P6's `Graph Metrics - Growth Sweep`
  Overseer graph and swap in this rule.
- **Graph indicators**: `nodeCount`, `edgeCount`, `maxDegree`, `degreeHistogram`.
  A cubic graph reads `maxDegree == 3` with the whole histogram in bucket 3 — **no
  degree-regularity metric is needed** (P6).

### 2.3 Exit oracle — **O6, in the shipped model**

Over **≥ 200 generations** of the shipped `Cubic GRA`, at **every** generation:

```
min degree == max degree == 3        and        E == 3N/2
```

plus I1–I5. **This is the milestone's headline result.** Add it to
`scripts/verify-graph-rewrite.mjs` as a permanent tier that loads the shipped model,
and **negative-control it** (e.g. omit the `v₂–v₃` edge ⇒ O6 must break while I1–I4
stay green — P4b already proved this control works).

---

## 3. Sample B — `SDCA — Couplers and Decouplers`

Ilachinski & Halpern 1987 (**verified** in `INVESTIGATION_GRAPH_CA.md` §13): a value
rule *plus* a link rule, dual-coupled — values evolve on the topology, topology
evolves on the values. Add the Nowotny & Requardt **hysteresis** band (on above λ₂,
off below λ₁, λ₂ ≥ λ₁) as the standard anti-flicker device.

- **Couplers / decouplers** = Form Bond / Break Bond driven by the endpoint states and
  the current link value.
- The **link value** is a **bond attribute** (P2/P3) — this is the model that shows
  why bond attributes exist.
- **⚠️ Document the link-update semantics honestly.** Bond attributes are
  **single-buffered on all three targets** (P3's standing decision), so a link write
  is visible to a later reader in the same generation, while *agent* attributes under
  sync are not. Say this in the model description and in Help. Do **not** attempt to
  fix it here — it is an all-three-targets change of its own (P3, P4).

### 3.1 Exit oracle — **O8**

- With thresholds that never fire ⇒ topology **exactly invariant**.
- Drive the neighbour density **up across λ₂ and back down to between λ₂ and λ₁** —
  the edge must **turn on once and not flicker**. A symmetric single threshold would
  flicker; that is the test.

---

## 4. Optional third sample (only if time allows)

A **typed-tissue** model exercising P5's `byBondAttribute` division ("apical bonds to
daughter A"). **No shipped sample uses a non-default partition** (P5), so this would
be its first real coverage. Skip it rather than rush it; say which you did.

---

## 5. The documentation sweep

The milestone's docs must read as one coherent feature, not eight phase reports.

- **`CLAUDE.md`** — a single coherent **Graph-Rewriting Automata** section covering
  the census, bond attributes, the request queue + Rewire + Form Bond Between, the
  division partition, graph indicators, and the samples. Fold in the per-phase text
  that accumulated; remove duplication. Update the Project Structure tree.
- **`src/help/HelpView.tsx`** — a user-facing "Graph-Rewriting Automata" section: what
  it is, the census → table → verb idiom, and how to read the samples.
- **`README.md`** — the feature and the two samples.
- **`docs/NODES_REFERENCE.md`** — final node counts + rows + Mermaid.
- **Library compile-target policy** — apply it to the new samples, **with the two
  documented exceptions stated in each model's description** (`Cubic GRA` on `wasm`
  for sweep reproducibility; anything else you deviate on).
- **The master handoff §2 Status Board** — mark P7 DONE and the milestone complete.

---

## 6. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **O6 in the shipped model** | ≥200 generations, `min deg == max deg == 3` and `E == 3N/2` at EVERY generation, negative-controlled |
| **O8** | hysteresis: no flicker in the band; invariant topology when thresholds never fire |
| **I1–I5** | hold every generation of both samples, ≥500 generations |
| **Both samples run on their gated-in targets** | 0 worker/console errors |
| **A VISIBLE-pane look** | the force-directed embedding is the entire point — **someone must actually look at both models rendering**. Take a screenshot of each. If the pane cannot be displayed, say so explicitly rather than claiming a visual check you did not make. |
| Byte identity | `check-compile-identity --compare .gra-baseline/compile-identity-P4b.json` — the 27 existing models unchanged; the new ones report as NEW |
| Standard gates | tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` · `parity-agent-force` |

---

## 7. Assumptions to check FIRST (stop and report if any is false)

1. **The 5-op triangle split works from a library model's graph**, not just P4b's
   synthetic — same verbs, same order. Build it small and check O6 before adding the
   rule table on top.
2. **A tag-valued N-D Lookup Table can drive a Switch to three verbs** in an agent
   behaviour graph (the P1 macro shape). If the macro needs adjusting for the verb
   set, that is in scope; a structural blocker is not.
3. **`ovRandomizeTable` re-rolls the rule the sweep reads**, and the sweep reproduces
   on `wasm`. P6 verified this on its own sample — confirm on yours before building
   the whole protocol.

---

## Completion Report — P7

**State**: **DONE**

**Commit**: `78c294f` — feat(gra): the flagship samples - Cubic GRA and SDCA - plus the milestone docs sweep

**Files touched**

```
 scripts/gen-cubic-gra.mjs                        NEW  -> public/models/Cubic GRA.gcaproj
 scripts/gen-sdca.mjs                             NEW  -> public/models/SDCA - Couplers and Decouplers.gcaproj
 public/models/Cubic GRA.gcaproj                  NEW
 public/models/SDCA - Couplers and Decouplers.gcaproj  NEW
 scripts/verify-graph-rewrite.mjs                 + TIERS K and L (355 -> 405 checks) + the shipped-model rig
 CLAUDE.md                                        the EIGHT per-phase sections folded into ONE `## Graph-Rewriting Automata (GRA)` section
                                                  (+ the four-gaps table, the samples subsection, the O6/O8 evidence, the Project Structure tree,
                                                   the library compile-target policy's three documented exceptions)
 src/help/HelpView.tsx                            + "Graph-Rewriting Automata — census -> table -> verb" + the bond-attribute single-buffering caveat
 README.md                                        twelve -> fourteen samples, with both flagships described
 docs/NODES_REFERENCE.md                          scope: the milestone is COMPLETE at 151/148 and added NO new node types in P7
 docs/HANDOFF_GRAPH_REWRITING_AGENTS.md           Status Board: P7 DONE, milestone COMPLETE
```

**No engine, compiler, node, schema or UI-logic file was touched.** This is a
samples-and-docs phase, and `check-compile-identity` proves it: **27 models, all surfaces
unchanged**, with the two new models reported as NEW.

### What shipped

1. **`Cubic GRA`** — the flagship. A 3-regular graph that rewrites itself while STAYING
   3-regular, driven by two 8-cell tag-valued rule tables with Randomize, plus an Overseer
   sweep over rule space. **O6 holds at EVERY generation** (below).
2. **`SDCA — Couplers and Decouplers`** — Ilachinski & Halpern's dual coupling with the
   Nowotny–Requardt hysteresis band, the link value carried as a **bond attribute**. **O8
   verified with a single-threshold negative control** (below).
3. **`verify-graph-rewrite.mjs` Tiers K and L** (355 → **405** checks) — permanent tiers that
   load the SHIPPED `.gcaproj` files and run them through their OWN compiled behaviour over a
   real agent store and the real structural drain, so a later edit to a generator that
   quietly breaks a rule fails here. **Three negative controls.**
4. **The documentation sweep** — CLAUDE.md's eight accumulated per-phase sections folded into
   one capability-organised section, HelpView, README, NODES_REFERENCE, the library
   compile-target policy, and this Status Board.

### Decisions resolved

| ID | Decision taken | Why |
|---|---|---|
| **§2.1 the operation set** | **triangle split + idle. NO edge swap, NO triangle contract.** | The contract is explicitly optional in §2.1 and a growth-only rule exercises O6 fully. The **edge swap is not expressible** with the current verb set — see "Assumptions" below; it is a genuine finding, recorded rather than worked around. |
| **NEW — the split needs an INDEPENDENT-SET gate, and it is load-bearing** | every agent rolls a random priority into an agent attribute each generation; only an agent whose STORED priority is strictly below every bonded neighbour's may rewrite. | Two ADJACENT agents rewriting in the same generation is the ONE way the 5-op split breaks: the mother's Rewire needs its edge to `b` to still exist when the queue drains, and a splitting `b` would have re-pointed it away. Strict inequality cannot hold both ways ⇒ the rewriters are pairwise non-adjacent **for ANY priorities**, so the guarantee needs only that everyone reads the same generation's values — which synchronous update gives for free. NON-adjacent rewriters provably never conflict (each one's Rewire-break precedes its own Form Between on a shared neighbour, so that neighbour dips to 2 and returns to 3). **Negative-controlled in Tier K**: forcing the gate true breaks O6. The same roll doubles as the rate knob. |
| **NEW — a population END CONDITION is part of the O6 contract** | pause at `nodes >= 3000` against `maxAgents: 6000`. | At the agent cap `createAgent` returns −1, the split's Rewire finds no target and degrades to a bare break, and the graph stops being cubic. A 2× margin cannot be crossed in one generation. Verified in-app: with Split Rate forced to 1, Play auto-paused at gen 25 / N = 3046. The sweep uses `ovRunUntilStop`, which respects it, so a blow-up rule is CLASSIFIED, not fatal. |
| **NEW — the Switch discriminates Idle vs Split; the ORIENTATION is arithmetic** | `caseCount 1`, case 0 = Idle (unwired), **DEFAULT** = the split chain, with `keepIdx = verb − 1`. | Routing three split cases to the same chain would emit the 20-node split body three times (a flow diamond into a shared body). One emission, same idiom, and the tag table still drives a Switch — which is what assumption 2 asked to be proven. |
| **`Cubic GRA` target = `wasm`** | a documented exception to the library policy. | P6's finding: `setRngSeed` re-seeds the shared xorshift32 stream JS/WASM use, but never reaches the WebGPU agent PCG, so a WebGPU sweep does not reproduce. **Both gates ACCEPT the model** — nothing is clamped. |
| **`SDCA` target = `webgpu`** | the library policy, unmodified. | Both gates accept; there is no sweep whose reproducibility would be at stake. |
| **SDCA spawns from the Agent Init Event**, not `seedPattern` | `seedCount: 0` + a Loop over Create → Add → Set Agent Attribute. | `seedPattern: 'scatter'` uses `Math.random()` (P6), so the initial condition would sit outside the replayable stream. Spawning from the graph draws positions AND the symmetry-breaking initial states from the shared xorshift32 stream. |
| **The optional third sample (typed tissue) was SKIPPED** | §4 permits it. | Both flagships needed their invariants proven with negative controls and a real-app run; a rushed third sample would have added surface without adding an oracle. `byBondAttribute` division therefore still has **no shipped coverage** (it has harness coverage from P5) — recorded in the deferred list. |

### Assumptions that proved FALSE

**None of the three §7 assumptions.** All three were checked before anything was built on top:

1. **The 5-op triangle split works from a library model's graph — CONFIRMED, and checked
   FIRST as instructed.** A split-only build of the generator, run headless through the real
   compiled behaviour and the real `drainAgentBondRequests`, held O6 for 220 generations
   before the rule table was added. Same verbs, same order as P4b's synthetic.
2. **A tag-valued N-D Lookup Table drives a Switch to the verbs — CONFIRMED**, including the
   part that was not obvious: **axis 0 is a `tagAttribute` axis bound to an AGENT tag
   attribute** and resolves correctly (`dims [2,4]`, labels `Dormant,Active`) on all three
   targets. No macro adjustment was needed.
3. **`ovRandomizeTable` re-rolls the rule the sweep reads, and the sweep reproduces on
   `wasm` — CONFIRMED in the real Overseer panel**: 12 rules in 1.7 s, both tables re-rolled
   and journalled per `{seed, density}`, and **two presses of Run Experiment give identical
   series**.

**One finding that is NOT an assumption failure but is the phase's most substantive
discovery — the EDGE SWAP is inexpressible.** §2.1's table lists it; it cannot be built.

> A degree-neutral rewiring needs an agent to **break an edge between two OTHER agents**.
> `breakBond` and `rewireBond` are self-relative (they break `self–x`); `formBondBetween` only
> ADDS. Enumerating every combination with ΔE = 0 and all-zero degree deltas: two rewires at
> one agent cancel to a no-op; break+form is a no-op unless it changes a degree; break+between
> leaves the requester at −1; and any zero-sum set requires a third-party BREAK. **A single
> agent therefore cannot perform a degree-preserving edge swap**, and a two-agent protocol
> would need each side to know the other's chosen partners — i.e. **2-hop bond visibility**,
> which does not exist (`getBondedAgents` / `forEachBond` are self-only).
>
> The missing dual is a **`Break Bond Between`** verb (a `P4c`-shaped phase: it would ride the
> same queue with the same sign-encoded payload). This does **not** block the milestone: O6 is
> the exit gate and the split alone satisfies it, the operation set is explicitly ours to
> define (Impact Map §6.2), and §2.1 already treats the inverse operation as optional. The
> model's Rule Description and CLAUDE.md both state it plainly rather than quietly omitting it.

**One harness bug found and fixed while building Tier L** (worth recording because it is a
silent-corruption class): the shipped-model rig omitted **`shape.bondAttrs`** when calling
`buildAgentAbiArgs`. The ABI descriptor emits one `_bondAttr_<id>` + one `_bondFormAttr_<id>`
param per bond attribute, so omitting it **SHIFTS every later argument** — `modelAttrs` landed
on a bond array, every model-attribute read became `undefined`, the whole link rule computed
`NaN`, and **nothing errored anywhere**: the model simply did nothing. The fix is one line,
and the reason it is worth a paragraph is that the same shape mistake in production code is
exactly the "+64-cell corruption" class the milestone has been guarding against all along.

### Verification

| Gate | Result |
|---|---|
| tsc / build | ✓ `npx tsc -p tsconfig.app.json --noEmit` clean · `npm run build` clean (42 precache entries) |
| parity-agent-wasm | ✓ ALL agent samples + all 23 synthetics JS↔WASM **bit-identical** — including the two NEW models, which the harness globs automatically |
| check-agent-wasm-gate | ✓ **14/14** `GATE✓ COMPILE✓ INST✓` (Cubic GRA 5733 b / 28 node types; SDCA 4905 b / 20) |
| audit-agent-layout / test-agent-abi | ✓ 192 checks, all 4 CPU sites in lockstep · ✓ 28 ABI tests |
| check-compile-identity | ✓ vs `.gra-baseline/compile-identity-P4b.json` — **27 models, ALL surfaces unchanged**; the two new models reported NEW |
| verify-graph-rewrite | ✓ **405 passed, 0 failed** (355 → 405; the new **Tiers K and L**) |
| verify-agent-render / parity-agent-force | ✓ · ✓ (7 checks) |
| Real in-browser run | see below — **both models were LOOKED AT and screenshotted** |

**O6 — the milestone's headline, in the SHIPPED model.**

- **Harness Tier K**: `min degree == max degree == 3` AND `E == 3N/2` after **every one of 220
  generations** at the shipped Split Rate — **847 triangle splits**, N 4 → 1698 — with I1–I4
  green every generation, no queue overflow, and the growth law **exact** (`N = 4 + 2t`,
  `E = 6 + 3t`, which is the observable form of **I5**: a half-applied split would put N and E
  off the closed form). Plus a **500-generation** run at a slower Split Rate (32 splits, N →
  68), same checks.
- The **independent-set property is asserted directly**: over all 220 generations, no two
  ADJACENT agents ever raised structural requests in the same generation, while up to **25**
  agents rewrote per generation at peak (so the gate is a set, not a singleton).
- **Negative control A** (P4b's decisive one, now on the shipped graph): delete ONLY the Form
  Bond Between whose two endpoints are both newborns ⇒ **O6 breaks**, while I1–I4 stay
  GREEN — proving the tier tests O6 and not something weaker.
- **Negative control B**: force the priority gate's Value Switch condition to a constant true
  ⇒ adjacent rewriters collide and the graph stops being cubic.
- **In the real application** (dev server, real worker, WASM agent target), at generation 270:
  **N = 5120, E = 7680 = 3N/2, min degree = max degree = 3**, handshake exact, **0 dangling
  bonds** — recomputed page-side from a `getState` payload, independently of the indicators.
  The live indicators agreed (`maxDeg 3`, degree histogram entirely in bucket 3).
- **Across the whole Overseer sweep**: the `maxDegree` series over 12 randomly rolled rules
  reads **mean 3, std 0, min 3, max 3**, while N spans **4 … 274** — O6 holds across rule
  space, including the rules that blow up.

**O8 — hysteresis, in the SHIPPED SDCA.**

- **Harness Tier L**, with `Agreement Bonus = 0` so the pair drive is exactly the global Drive
  and the experiment is unambiguous: thresholds that never fire ⇒ topology **EXACTLY
  invariant** over 40 generations (20 links, edge-set equality); inside the band an edgeless
  graph **stays edgeless**; above λ₂ **292 links form**; back inside the band **they STAY
  (292 → 292 — no flicker)**; below λ₁ they all break. I1–I4 after every generation.
- **Negative control**: the identical manoeuvre with `λ₁ == λ₂` (one symmetric threshold)
  **destroys every link** on the way back — the band is what preserves them.
- **The bond attribute is really carried on the edge**: after 20 generations at drive 0.8,
  every one of 201 live link slots has converged to 0.8, and **I2** confirms both stored
  copies of every link value agree.
- **500 generations at the shipped settings**: I1–I4 after every one, with the link count
  changing on **496 of 500** generations (couplers and decouplers both live — not a fixed
  point).
- **In the real application** (WebGPU agent target), the same five-step manoeuvre driven
  through the worker: **0 → 0 → 293 → 293 → 0**, and the single-threshold control collapsed to
  **0**. Identical qualitative result to the harness on a different target.

**THE VISIBLE-PANE LOOK — done, not claimed.** The Browser pane reported
`document.hidden === false`, so this was a genuine visual check with screenshots:

- **Cubic GRA** renders as a force-directed **cubic mesh** — amber (Active) / slate (Dormant)
  nodes joined by bond lines, every node visibly carrying three edges, triangles from the
  splits clearly visible. Captured at N = 18 (structure legible edge-by-edge) and at N = 106
  (the mesh as a whole), plus the dense N = 5120 blob.
- **SDCA** renders as a live evolving **network** across the torus — cyan (On) / slate (Off)
  nodes with an ever-changing link set, the "links (E)" sparkline visibly churning, 220 nodes
  / 263 links / mean degree 2.39 / 45 components. The Model Attributes panel shows the State
  Rule table and the Drive / Agreement / Couple sliders.
- **0 console errors and 0 worker errors** across the whole session (a fresh `console.error`
  hook was installed before each model load, per the project's persistent-buffer rule).

### Invariants

| ID | Held? | Evidence |
|---|---|---|
| **I1** handshake | **YES** | Every generation of Tier K (220 + 500 gens), Tier L (500 gens), and the real-app recount at N = 5120. |
| **I2** symmetry | **YES** | `checkBondSymmetry` over every per-slot field each generation in both tiers; plus the explicit SDCA check that both stored copies of every link value agree. |
| **I3** no dangling | **YES** | Same runs; 0 dangling in the real-app recount. |
| **I4** capacity | **YES** | Same runs, at a TIGHT `maxBonds 3` for the cubic model — nothing ever transiently over-bonds. |
| **I5** atomicity | **YES** | Observably: the cubic growth law is EXACT (`N = 4 + 2t`, `E = 6 + 3t`) over 847 splits — a half-applied split would break it. No queue overflow occurred in either sample. |
| **I6** degree preservation | **YES — the headline** | O6 above: 220 + 500 harness generations, 270 real-app generations, and the whole 12-rule sweep. Negative-controlled two ways. |

---

## Milestone retrospective — Graph-Rewriting Automata, end to end

### What the eight phases delivered

| Phase | Delivered |
|---|---|
| **P1** | The **Neighbour State Census** — the multiset a graph rule is *allowed* to read — as ONE node, **lowered** to existing nodes so all three agent targets work with zero per-target emit. Plus the `GRA Rule Table` macro, the `Life on Bonds` differential sample, and `verify-graph-rewrite.mjs` itself. Found a pre-existing operand-port defect in both agent `groupCounting`/`groupStatement` emitters (fixed) and the WebGPU sync-attribute race (deferred to PX). |
| **P2** | **Bond attributes** — a third attribute id-space, ragged store, `_bondAttr_` ABI, Get/Set Bond Attribute, Form Bond initial values, panel + inspector, JS + WASM. Found a **THIRD** compaction path (`sweepStaleBonds`) the Impact Map's enumeration had missed. |
| **PX** | **Synchronous agent attributes are double-buffered on WebGPU** — a second per-attribute run + a per-generation commit compute pass. Reproduced the race first (123/56/32/32 of 1024 cells wrong, varying run to run), then 0/0/0. Every async shader stayed byte-identical. |
| **P3** | Bond attributes on **WebGPU** — the bondStore slot widened 2 → 2+N through ONE stride constant, binding 11 promoted to `read_write` only when a Set emitter runs. Measured that one-sided and symmetric writes are EXACT on the GPU and only the asymmetric both-endpoints write diverges — a shape P2's D2 already forbids everywhere. |
| **P4** | The **structural request QUEUE** (bounded, per-agent, with an overflow bucket) + the atomic **Rewire Bond** verb. I5 proven: D+3 ops apply exactly D, the rest rejected WHOLE. 500 generations of pure rewiring conserve N, E and the full degree multiset. |
| **P4b** | **Form Bond Between** — third-party bond formation, the op kind riding the **SIGN** of the break lane so **zero new fields** and zero moved offsets. This is the phase that made the triangle split possible in ONE generation. |
| **P5** | The **division bond partition** (tension / alternate / byBondAttribute) + the `daughterBond` policy, with `tension` proven byte-identical three separate ways. |
| **P6** | **Graph indicators** — a third `Indicator.kind` computing N, E, mean/max degree, the degree histogram and connected components over the agent population, readable by the Overseer with no Overseer change. Found that `seedPattern: 'scatter'` and the WebGPU agent PCG both break sweep reproducibility. |
| **P7** | The two **flagship samples** + the docs sweep, and **O6 proven inside a shipped model** rather than a synthetic. |

### The four gaps from Impact Map §1 — all closed

| # | Gap | Status |
|---|---|---|
| **G1** | one structural request slot per agent per step | **CLOSED** (P4 queue + Rewire; completed by P4b's Form Bond Between). The cubic triangle split — 2 Rewire + 3 Form Between + 2 host spawns — now lands in ONE generation at a tight `maxBonds 3`. |
| **G2** | division partitions bonds geometrically | **CLOSED** (P5). A rule can now say *which* daughter gets *which* edge, by attribute, by alternation, or by the old geometry. |
| **G3** | no bond attributes | **CLOSED** (P2 + P3), on **all three** agent targets, with I2 machine-checked over every per-slot field and a 500-generation compaction audit against an independent truth map. |
| **G4** | no neighbour-state census | **CLOSED** (P1), and closed the *cheap* way — a lowering, so it cost no per-target emit and no gate exception. |

### What remains deferred — the honest list

1. **`Break Bond Between`** — the missing dual of `Form Bond Between`, and the reason the
   **edge swap** is not in the Cubic GRA's operation set. Without it no agent can issue a
   degree-neutral rewiring of a non-incident edge. A `P4c`-shaped phase: same queue, same
   sign-encoded payload space. **This is the single highest-value follow-up.**
2. **2-hop bond visibility** ("the bonds of agent X"). Everything today is self-only
   (`getBondedAgents` / `forEachBond`), which is what forces coordination protocols to run
   through published agent attributes. Deliberately out of scope (Impact Map §6.3 keeps the
   design at the 1-ring), but it is what a two-agent edge swap would need.
3. **Synchronous BOND attributes.** They are single-buffered on all three targets by P3's
   standing decision, so a link write is visible to a later reader in the same generation.
   Harmless for a symmetric link rule (and documented in the SDCA sample and in Help), but a
   genuinely synchronous link rule would need the PX treatment on **all three targets at
   once** — never the GPU half alone.
4. **`byBondAttribute` division has no SHIPPED sample.** P5 covers it in the harness (I7 / O4 /
   O9 over 1000 divisions in every mode) but no library model exercises it; the optional
   "Bond-Typed Tissue" sample was skipped rather than rushed.
5. **The triangle CONTRACT** (the split's inverse, ΔN −2 / ΔE −3). Optional per §2.1 and not
   built. It needs an agent to kill two OTHER agents, so like the edge swap it is really a
   third-party-verb question.
6. **P8, the visual before/after motif editor** — never scheduled; it would introduce a
   *fourth* graph-shaped editing surface and needs an explicit decision (Impact Map §6.4).
7. **Rotation systems / planarity / genus** — explicit non-goals (Impact Map §6.3). The bond
   store is a set with swap-with-last compaction, not an ordered cyclic adjacency.
8. **Overseer seed policy does not reach the WebGPU agent PCG.** A small, self-contained
   follow-up (re-seed the agent PCG from `setRngSeed`); until then, sweeps ship on `wasm`.
