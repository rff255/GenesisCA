# INVESTIGATION — HashLife, Golly's algorithms, and O(active) grids in GenesisCA

**Status:** 🔬 **RESEARCH ONLY — NOTHING SHIPPED.** No engine, compiler, worker or UI
file was changed. This document answers a design brainstorm with measurements, a
compatibility analysis and a phased recommendation; the scratch scripts that
produced the numbers live outside the repo (§9 says how to reproduce them).

**Companion:** [INVESTIGATION_HASHLIFE_SPARSE_GRID.html](INVESTIGATION_HASHLIFE_SPARSE_GRID.html)
(diagrams — the active-set mechanism, the quadtree, the chunked layout, the tier table).

**Prompted by** the project owner's brainstorm, quoted verbatim in §0.

**Reads with:** [PLAN_LARGE_GRID_PERF.md](PLAN_LARGE_GRID_PERF.md) (the shipped
feature's own plan), [PERF_REVIEW_LATTICE.md](PERF_REVIEW_LATTICE.md) (where a
lattice generation actually goes), [HUGE_GRID_OPTIMIZATIONS.md](HUGE_GRID_OPTIMIZATIONS.md)
(the memory ceilings; its §5 lists HashLife as out of scope — this document is the
promised second look).

---

## 0. The brainstorm, and the one-paragraph answer

> (brainstorm) maybe hashlife? whatever strategy golly employs to produce
> high-performance updates on the grid avoiding spending processing power on large
> regions without cells that would actually be changing. E.g., game of life rule
> guarantees that any dead cell that is more than the Moore neighborhood away from
> a living cell, will not change its state. Meaning that with an additional data
> structure keeping track of which cells actually need to have its state evaluated,
> will allow for the simulations of structures on huge (potentially infinite like
> golly) grids, without actually processing or allocating memory for all the 'void'
> regions. In practice, I believe the user would have to determine what conditions
> makes a cell be "stable", and which neighborhoods would be used to change that
> status, triggering it to be included in the 'Generation Step' update processing.

**The answer, in one paragraph.** The brainstorm describes three separable things,
and GenesisCA's status on each is very different. (1) *"an additional data structure
keeping track of which cells actually need to be evaluated"* — **already shipped**,
as **Skip Isolated Empty Cells** (SIE), and measured here at **4.6× on a settled
Game-of-Life soup, 356× on an R-pentomino and 6 326× on a lone glider**. (2) *"the
user would have to determine what conditions makes a cell be stable"* — **NOT
shipped**: SIE's predicate is hard-wired to *one value of one attribute means
empty*, and the measurement in §3.3 shows that on the shipped **Wildfire** model
neither available choice works (2.08× and 1.70×, both **degrading over time**) while
the smallest possible generalisation — *a **set** of stable values* — gives
**25.2×, flat**. That is the single highest-value finding in this document, and it
needs **no compiler change at all**. (3) *"without actually allocating memory for
the void regions"*, *"potentially infinite like golly"* — **NOT shipped and not
recommended now**: SIE saves O(active) **compute**, not O(active) **memory** (§1.3),
and an unbounded canvas is a third boundary treatment that touches the SoA layout,
both CPU layouts, the WebGPU buffers, save/load, the brush, the clipboard and both
renderers. **HashLife itself is not a compile target and cannot become one** — it is
a different engine with different transport semantics, restricted to a model class
GenesisCA barely occupies (§4, §5.3).

---

## 1. What GenesisCA already ships

### 1.1 Skip Isolated Empty Cells, precisely

`ModelProperties.skipIsolatedEmpty` ([types.ts](../src/model/types.ts)) +
[activeSet.ts](../src/simulator/engine/activeSet.ts) +
[sparseStepping.ts](../src/modeler/vpl/compiler/sparseStepping.ts). The user picks an
**empty attribute**, an **empty value**, and a **processing range** (a neighbourhood
or a radius+metric). A cell is **ACTIVE** iff it is within that range of at least one
**non-empty** cell; only active cells run the Generation Step and the (post-batch)
Output-Mapping colour pass.

The maintenance is **reference-counted and state-defined, not change-tracking**
(`nearCount: Uint16Array(total)`), which the original plan chose deliberately so the
set stays correct for non-monotonic models. It is rebuilt from scratch after
init / reset / gridInit / loadState / every mutation, and maintained incrementally
from the empty↔non-empty transitions of the cells that were stepped.

**It is genuinely two optimisations under one switch.** Turning it on also switches
the CPU targets to **inline neighbour computation**: the `total × nSz × 4` neighbour
index table is replaced by a `nSz × 4` packed-offset table
([wasm/layout.ts](../src/modeler/vpl/compiler/wasm/layout.ts) line 367). That is what
makes the 300³ Accretor loadable at all on a CPU target — the full table would be
2.8 GB against the wasm32 4 GiB ceiling.

Measured in [PERF_REVIEW_LATTICE.md](PERF_REVIEW_LATTICE.md) §2 (Accretor 128³, WASM):
step **24.2 → 1.75 ms/gen (13.8×)**, init **611 → 61 ms (10.0×)**.

### 1.2 The exact gate (five terms, all mirrored in the worker)

`sparseSteppingEnabled(model)` — **enabled** ∧ **synchronous** ∧ **gridCells** ∧
**no agents** ∧ **no glyphs**; the worker's `setupActiveSet()` mirrors it exactly and
adds four runtime bails that silently fall back to the full loop: an unresolvable
attribute, an unresolvable range, a range of **> 30 000 offsets** (`nearCount` is
`Uint16`), and — subtly — **a constant boundary whose sentinel value is not the empty
value**, because then every border-adjacent cell can transition from a source the
active set does not model.

**WebGPU ignores the feature entirely** and runs the whole grid every generation
(`sieActiveCount()` returns `-1` when the GPU step is ready; surfaced honestly in the
C1 compatibility readout and in the Auto-engine reason string).

### 1.3 What it does NOT do — and this is exactly the brainstorm's gap

| the brainstorm asks for | SIE delivers |
|---|---|
| skip evaluating void regions | ✅ yes — O(active) step + O(active) colour pass |
| *"user determines what makes a cell stable"* | ❌ **no** — hard-wired to `attr === oneValue` |
| don't **allocate** memory for void regions | ❌ **no** — every attribute is still a dense `total`-length typed array |
| huge / *"potentially infinite like golly"* grids | ❌ **no** — the grid is a fixed `W×H×D`; boundary is `constant` or `torus` only |
| on every compile target | ❌ **no** — JS + WASM only; WebGPU runs full |

And it **adds** per-cell bookkeeping: `nearCount` (2 B) + `member` (1 B) + the active
`list` (4 B) = **7 bytes/cell**, i.e. 189 MB at 27M cells. Dwarfed by the 2.8 GB
neighbour table it removes, but it is not free, and on a model whose active set is
near 100% it is pure overhead (the documented MNCA case).

### 1.4 ⚠️ The drift finding: the feature has **zero** users in the shipped library

Swept every `public/models/*.gcaproj`: **exactly one model carries a
`skipIsolatedEmpty` config — the Accretor — and it is `enabled: false`.** So the
27M-cell Accretor ships running the full dispatch every generation while its own
Rule Description tells the user the volume *"is practical because Skip Isolated Empty
Cells is ON"*. [PERF_REVIEW_LATTICE.md](PERF_REVIEW_LATTICE.md) §6 flagged the same
mismatch on 2026-07-24; it is still there.

**This is the practical reason the brainstorm reads as unimplemented.** No shipped
model demonstrates it, so nothing in the app shows it working. Whatever else is
decided here, **fixing that one boolean (or the sentence) is a five-minute change
with more user-visible effect than any tier below.**

---

## 2. What Golly actually does

Golly ships several *algorithms* (an explicit user choice per pattern), not one
engine. From memory of the sources and the Golly help; **no web access was used, so
treat the mechanism descriptions as authoritative-ish and the file names as
recollection.**

### 2.1 QuickLife — tiled, bit-parallel, dirty-region

Alan Hensel's algorithm as adapted by Andrew Trevorrow (`qlifealgo`). The universe is
a hierarchy of small tiles (8×8 leaf blocks) holding **two generations packed
bit-parallel in machine words**; a Life-like 2-state totalistic rule is then evaluated
with bitwise adders, many cells per instruction. Each tile carries a **dirty/active
flag**: a tile is processed only if it or a neighbouring tile changed, and empty tiles
surrounded by empty tiles are unlinked entirely.

**This is precisely the brainstorm's "additional data structure", at tile granularity
rather than cell granularity** — and it is the algorithm Golly uses by default,
because for chaotic patterns it is usually *faster than HashLife*.

Preconditions: 2-state Life-like rules only (the bit-parallel adder is rule-specific).

### 2.2 HashLife — a hash-consed quadtree with memoised time jumps

Bill Gosper, *Exploiting Regularities in Large Cellular Spaces*, **Physica D 10
(1984)**; Golly's implementation is Tomas Rokicki's `hlifealgo`. Two ideas stacked:

1. **Hash-consing (space).** The universe is a quadtree; every node is
   **canonicalised** through a hash table, so two structurally identical subsquares
   anywhere in the universe are *the same object*. Repetition costs nothing.
2. **Memoised super-speed (time).** Each node of level *k* (a 2^k × 2^k square) caches
   its **`result`**: the centre 2^(k−1) square advanced **2^(k−2) generations**,
   computed by combining nine sub-results. The base case (level 2, a 4×4 node) yields
   the centre 2×2 advanced **one** generation. Because the cache is keyed on the node,
   *a pattern that recurs in space **or in time** is computed once* — and the time jump
   is **exponential in the node level**: a big enough node advances 2^k generations for
   one lookup.

That second point is why HashLife can run a Turing-machine or a breeder for 2^60
generations in seconds. It is also why it produces **no intermediate generations**:
you asked for a 2^k jump and it never computed the states in between.

Preconditions, all of them hard:
- a **deterministic** rule (no randomness),
- **translation-invariant** and **time-invariant** (same rule everywhere, always),
- **finite radius** — Rokicki's `hlifealgo` is hard-wired to r = 1,
- an **infinite universe with a uniform (usually empty) background**,
- a **small enough per-cell state** that leaves dedupe.

### 2.3 The other algorithms (and one that matters more than HashLife here)

- **`ghashbase`** — Golly's *generalised* HashLife base class, shared by the
  multi-state algorithms (Generations, JvN, RuleLoader). So HashLife *does* generalise
  beyond 2 states, but the leaf loses the bit-parallel packing and it is slower.
- **`jvnalgo`** — up to 256 states (von Neumann's self-replicator), its own tiled
  representation.
- **`ltlalgo` — Larger than Life.** Big-radius totalistic rules on a bounded grid,
  which it makes tractable with **running/cumulative sums** — an O(1) neighbourhood
  sum per cell instead of O(r²). **This, not HashLife, is the Golly idea that maps
  most directly onto a GenesisCA pain point** (MNCA: 229 ms/gen and a 693 MB
  neighbour table at 512²). See §5.5.
- **`ruleloaderalgo`** — RuleTable / RuleTree: a rule given as a transition *table*.
  GenesisCA's `lookupTable` attribute is the same idea reached from the other end.

### 2.4 Where HashLife is pathological

Golly's own help says it plainly, and §3.4 measures it: for **chaotic patterns with
random input**, HashLife's hash table explodes (nothing dedupes), memory grows without
bound (Golly exposes a hash-memory limit and a garbage collector), and QuickLife is
usually faster. HashLife wins on **structured, repetitive, sparse** patterns —
methuselahs, spaceship guns, metacell constructions, anything with large still or
periodic regions.

---

## 3. Measurements

### 3.1 Method

Node scripts (outside the repo) built with the project's own harness idiom: esbuild
the TypeScript into a bundle and drive **the real shipped code** —
`compileAll()` from [compileHarness.ts](../src/dev/compileHarness.ts) for a *real
compiled step function*, and [activeSet.ts](../src/simulator/engine/activeSet.ts) for
the *real* active-set maintenance. The step's argument list is read out of the
compiled source by name, so nothing is mis-positioned. Fixtures are the **shipped**
`Game of Life.gcaproj` and `Wildfire - Sierra Nevada.gcaproj` (its embedded
landscape decoded from the model's own base64 `simulationState`).

Three predicates are compared, all dilated by the same Moore range:

| | sources of the dilation | soundness |
|---|---|---|
| **empty** | cells whose value ≠ the empty value | **shipped** — sound if the range ⊇ the read-neighbourhood |
| **stable-set** | cells whose value ∉ a user-declared *set* | proposed §5.1 — same condition |
| **dirty** | cells that **changed** last step | proposed §5.2 — needs an extra assertion (§5.2) |
| *oracle* | cells that **will** change — not implementable, the theoretical floor | — |

**Cross-check (not assumed):** the hand-rolled dilation count used for the value-set
sweep was verified against the shipped `rebuildActiveSet()` on a real 200×200 board
for two different single values — **30 727 = 30 727 and 40 000 = 40 000, exact match**.

### 3.2 Game of Life — the shipped predicate is already good; "stable" adds ~1.8×

512², 2000 generations, torus, shipped `Game of Life.gcaproj` step (verified **pure**:
no RNG draw, no model-attribute read, no indicator read).

| fixture | work: **full** | **empty** | **dirty** | *oracle* | speedup empty | speedup dirty | dirty ÷ empty |
|---|---|---|---|---|---|---|---|
| soup p=0.35 | 524.3M | 114.1M (21.8%) | 67.6M (12.9%) | 16.8M (3.2%) | **4.60×** | **7.76×** | 1.69× |
| R-pentomino | 524.3M | 1.5M (0.3%) | 0.8M (0.2%) | 0.18M (0.03%) | **355.8×** | **655.8×** | 1.84× |
| acorn | 524.3M | 2.8M (0.5%) | 1.7M (0.3%) | 0.40M (0.08%) | **185.4×** | **313.4×** | 1.69× |
| single glider | 524.3M | 0.1M | 0.04M | 0.01M | **6 325.9×** | **12 482.5×** | 1.97× |

*(work = cell-steps evaluated, summed over the run.)*

Per-generation shape on a 300² soup, showing why the integral looks the way it does:

| gen | alive | changed | active(empty) | active(dirty) |
|---|---|---|---|---|
| 1 | 33 013 | 30 850 | 89 157 (**99.1%**) | 86 524 (96.1%) |
| 10 | 20 559 | 19 300 | 71 894 (79.9%) | 65 167 (72.4%) |
| 100 | 8 454 | 6 590 | 33 125 (36.8%) | 24 731 (27.5%) |
| 800 | 4 667 | 2 825 | 20 224 (22.5%) | 11 568 (12.9%) |
| 2000 | 2 925 | 1 199 | 13 505 (15.0%) | 5 128 (**5.7%**) |

**Three readings.**
1. **A fresh soup is the worst case for any dilation predicate** — 99.1% active at
   generation 1. Sparse stepping is an *asymptotic* win as a pattern settles, never
   an opening-frame one.
2. **The "stable" generalisation buys ~1.7–2.0× over "empty" on Life.** Real, worth
   having, but *not* a different order of magnitude — because the thing it unlocks on
   Life is skipping **still lifes**, and at generation 2000 those are 58.2% of the live
   population (measured at 1024²: 35 879 alive, 15 007 changing next generation).
3. **The dilation itself costs 3.5–6.8×** over the oracle. Irreducible for any
   conservative range-based predicate; the only way past it is a per-cell "will I
   change" test, which is the rule itself.

### 3.3 ⭐ Wildfire — where the shipped predicate provably cannot work

The shipped `Wildfire - Sierra Nevada` (200², real Copernicus/ESA landscape from the
model's embedded board, a 198-cell ignition line, 260 generations). Its `state` tag is
**Unburned / Burning / Burned** — and **Burned is a terminal, non-empty, permanently
static state**. The shipped predicate can name only *one* value as empty:

| gen | unburned | burning | burned | active, `empty=Unburned` | active, `empty=Burned` | active, **`stable={Unburned,Burned}`** |
|---|---|---|---|---|---|---|
| 0 | 39 802 | 198 | 0 | 600 (1.5%) | 40 000 (100.0%) | 600 (1.5%) |
| 29 | 34 780 | 1 003 | 4 217 | 5 895 (14.7%) | 36 518 (91.3%) | 2 052 (5.1%) |
| 99 | 24 410 | 673 | 14 917 | 16 324 (40.8%) | 25 984 (65.0%) | 1 404 (3.5%) |
| 199 | 13 102 | 1 066 | 25 832 | 28 100 (70.3%) | 15 723 (39.3%) | 2 097 (5.2%) |
| 259 | 7 033 | 189 | 32 778 | 33 942 (**84.9%**) | 8 813 (22.0%) | 445 (**1.1%**) |

| over 260 gens | full | `empty=Unburned` | `empty=Burned` | **`stable={Unburned,Burned}`** |
|---|---|---|---|---|
| work | 10.4M | 5.0M (48.1%) | 6.1M (58.8%) | **0.4M (4.0%)** |
| speedup | 1× | **2.08×** | **1.70×** | **25.19×** |

**Both shipped choices degrade monotonically** — one tracks the growing burn scar, the
other the shrinking unburned region — while the **value-set** predicate tracks the
**fire front** and stays flat at 1–5%. **12× better than the best shipped option, on a
shipped model, from a change that touches no compiler.**

*(Aside, relevant to §4: this step **draws from the RNG, reads a model attribute and
reads a lookup table** — so the same model is a categorical HashLife non-candidate.)*

### 3.4 The memoisation story — 8×8 tile dedup (HashLife's leaf level)

Distinct 8×8 tiles out of 4 096, 512² board, as a proxy for how much a hash-consed
quadtree would collapse:

| fixture | t = 0 | t = 2000 |
|---|---|---|
| soup p=0.35 | **4 096 / 4 096 (100.0%)** | 1 074 / 4 096 (26.2%) |
| R-pentomino | 4 / 4 096 (0.1%) | 45 / 4 096 (1.1%) |
| acorn | 2 / 4 096 (0.0%) | 83 / 4 096 (2.0%) |
| single glider | 2 / 4 096 (0.1%) | 5 / 4 096 (0.1%) |

**Exactly the published behaviour**: a random soup dedupes *not at all* on arrival and
only ~4× once settled; sparse structured patterns dedupe 50–800×. This is the whole
HashLife trade in one table — and note that a GenesisCA model with a **float**
attribute has effectively zero dedup by construction.

### 3.5 The memory story — 64×64 chunks (Tier B's actual win)

1024² grid, after 2000 generations, one bool attribute:

| fixture | alive | occupied chunks | **+ halo** | dense bytes | chunked bytes | ratio |
|---|---|---|---|---|---|---|
| soup p=0.35 | 35 879 | 256 / 256 | 256 (100%) | 4.0 MB | 4.00 MB | **1.0×** |
| R-pentomino | 116 | 10 / 256 | 46 (18%) | 4.0 MB | 0.72 MB | **5.6×** |
| single glider | 5 | 4 / 256 | 16 (6%) | 4.0 MB | 0.25 MB | **16.0×** |

Two honest readings: the halo costs a lot at 64² granularity (10 occupied chunks
become 46 allocated), and **the win is entirely a function of the grid-to-structure
ratio** — it is 1.0× for a soup and unbounded only in the limit where the grid is
"infinite". Which is the real point: for an *unbounded* canvas, dense storage is not
wasteful, it is **impossible**, and chunking is the enabling mechanism rather than an
optimisation.

---

## 4. Mapping onto GenesisCA's engine — the compatibility matrix

GenesisCA's step is a **compiled, user-authored graph**, not a fixed rule. Anything
that memoises "this neighbourhood produces this result" is betting on the step being a
**pure function of the cells in its read-neighbourhood**. Here is where that bet loses:

| GenesisCA feature | active-set predicate (Tiers A/B/D) | HashLife memoisation (Tier C) |
|---|---|---|
| **RNG** — `getRandom`, `pickRandomNeighbor`, `pickNRandomNeighbors`, `aggregate.random`, `groupOperator.random`/`weightedRandom` | ✅ fine (the predicate bounds *where* change can happen, not whether) | ⛔ **fatal** — the step is not a function of the neighbourhood; a shared xorshift stream is also global mutable state |
| **Indicators** — `setIndicator` / `updateIndicator` / `getIndicator` | ✅ fine (worker-side, unchanged) | ⛔ **fatal** — order-dependent mutation of one shared accumulator, and a 2^k jump never visits the generations that would have written it |
| **Model attributes** (`getModelAttribute`) | ✅ fine | ⚠️ possible but hostile — a live slider is the interaction idiom; every move invalidates the whole memo table |
| **Lookup tables** | ✅ fine | ⚠️ same — live-editable (`updateLookupTable`) |
| **Stop Events / End Conditions** | ✅ fine | ⛔ a super-speed jump skips the generation the stop fired in; the whole point of the transport's `stopFlag` is per-generation |
| **`Get Generation`** (C-phase cadence) | ⚠️ breaks a *dirty* predicate (§5.2) | ⛔ time-varying rule — HashLife's node result is time-invariant by construction |
| **Asynchronous update mode** | ⛔ already excluded (shuffled sequential order) | ⛔ fatal |
| **Agents / the field bridge** | ⛔ already excluded (deposits bypass the active set) | ⛔ fatal |
| **Glyphs** | ⛔ already excluded (per-pass zero-fill assumes a full repaint) | ⛔ the renderer is dense-buffer-based |
| **Sub-attributes, variegation/orientation** | ✅ fine | ⚠️ just more state per cell → a bigger leaf key → less dedup |
| **Float attributes** | ✅ fine | ⛔ effectively fatal — a float leaf key never repeats, so dedup ≈ 0 |
| **Neighbourhood radius > 1** (MNCA, Coagulation, the 3D Accretor) | ✅ fine (the range is the user's own choice) | ⛔ the classic node algebra is r = 1; r > 1 needs a bigger base case and different combination arithmetic |
| **3D** | ✅ fine (`activeSet.ts` is dimension-generic today) | ⚠️ an *octree*, 8 children and 27 sub-results — a separate implementation |
| **Torus / constant boundary** | ✅ fine | ⛔ HashLife assumes an infinite uniform background; neither shipped boundary is one |
| **WebGPU** | ⚠️ needs stream compaction (Tier D) | ⛔ pointer-chasing memoised recursion over a hash table — no GPU form |

**How much of the shipped library could a HashLife path even accept? — MEASURED,
not estimated.** A sweep compiled every one of the **31** shipped `.gcaproj` files and
tested its *emitted step* against the gate {no RNG draw, no `modelAttrs` read, no
indicator read/write, sync, r = 1, no float cell attributes, 2D, no agents}:

| verdict | count | models |
|---|---|---|
| **RULE-PURE** | **3** | Game Of Life · General 2D CA (Golly style) · GoL Replicate Statistics |
| agents-only (no grid) | 12 | the whole agent library |
| rejected | 16 | below |

**All three survivors are the same rule.** The 16 rejections, by blocker (a model can
carry several): **live model attributes 13** — the single commonest, and the least
surprising, since a live slider is exactly what GenesisCA is for; **RNG 7**;
**radius > 1: 4** (MNCA r = 14, Coagulation r = 3, Amphiphile and Chromatography r = 2);
**async 4**; **3D 2** (an octree, not a quadtree); **indicators 2**; **float attributes
2**; **agents 2**. Note **Extended Wireworld**: its 4 states would need
`ghashbase`-style generalisation, but the gate stops it earlier on a model attribute
and an indicator — so even the "one other plausible candidate" is not one today.

---

## 5. The design space

Five candidates, ordered by *value per unit of risk*, not by ambition.

### 5.1 Tier A0 — a **set** of stable values (⭐ RECOMMENDED)

**User contract.** The "Empty value" control becomes "**Stable values**": a
multi-select over the chosen attribute's values. A cell is a *source* iff its value is
**not** in the set; active = within range of a source. Every existing config is the
one-element case, so the semantics are a strict superset.

**Schema** (additive, absent ⇒ today's behaviour, no migration):

```ts
export interface SkipIsolatedEmptyConfig {
  enabled: boolean;
  emptyAttributeId: string;
  emptyValue: string;            // KEPT — the legacy single value
  stableValues?: string[];       // NEW — when present, supersedes emptyValue
  rangeKind: 'neighborhood' | 'radius';
  …
}
```

**Why it is nearly free.** The predicate lives **entirely in the worker**. The
compiled step receives only `_activeList` / `_activeCount`; it has never known what
"empty" means. So:

| subsystem | impact |
|---|---|
| `activeSet.ts` | `emptyVal: number` → `stable: Set<number>` (or a small sorted `Int32Array` + a linear scan — sets are ≤ 8 values in practice); `isEmptyAt` becomes `stable.has(v)`. **~10 lines.** |
| worker `setupActiveSet` | decode N values instead of one; the constant-boundary sentinel guard becomes "the sentinel value must be **in** the stable set". |
| **JS compiler** | **none** |
| **WASM compiler** | **none** |
| **WebGPU compiler** | **none** (already ignores the feature) |
| `sparseStepping.ts` | **none** — the gate is unchanged |
| ModelContext cascades | the tagOptions remap and the attribute-delete clear must map over the array instead of the scalar |
| Properties UI | one `<select>` → a checkbox list (the Track-Categories editor pattern already exists) |
| save/load | array in `.gcaproj`; absent ⇒ legacy path |
| 2D/3D | identical — `activeSet.ts` is already dimension-generic |
| verification | `verify-sparse-stepping.mjs` gains a multi-value fixture; `check-compile-identity` must stay **byte-identical for all models** (it will, by construction — no emitter is touched) |

**Measured payoff:** Wildfire **2.08× → 25.19×** (§3.3). Urban Growth (Water / Road /
Urban all terminal) is the same shape. Accretion models are unchanged (one value).

**Soundness burden on the user** is *the same one that already ships*: today they must
guarantee the range ⊇ the rule's read-neighbourhood; now they additionally guarantee
that *a cell all of whose range is stable does not change*. Both are opt-in, both
belong in the tooltip, and neither is machine-checkable in general.

### 5.2 Tier A1 — an optional **quiescence** (dirty) term

**User contract.** A checkbox: *"also treat a cell as a source for one generation
after it changes"*. Sources = (value ∉ stable set) ∪ (changed last step). With the
stable set = *all* values, this degenerates to pure QuickLife-style dirty-region
tracking — which is the only way to skip a Game-of-Life **still life**.

**Payoff:** the §3.2 column — **1.7–2.0× on top of A0 for Life-like rules**, nothing
for wildfire-shaped rules (already flat at 1%).

**Two honest costs, and they are why this is a separate tier.**

1. **It is history-based, so it breaks the "state-defined" property the current design
   chose on purpose** (`activeSet.ts` header: *"state-defined … NOT change-tracking —
   robust"*). It cannot be rebuilt from state after a load/reset/paint; every such
   event must conservatively mark everything dirty — which QuickLife also does, but it
   is a real new invariant to hold across ~8 mutation handlers.
2. **It is unsound for a rule that can change spontaneously.** *"A cell changes only
   if it or a range-neighbour changed"* is true for a deterministic rule reading only
   its range — and **false** for a rule that draws from the RNG, reads a model
   attribute the user just moved, reads `Get Generation`, or reads an indicator. That
   must be an explicit user assertion (like the range), and the UI should say so.
   *(It happens to be safe on Wildfire only because `burnTimer` ticks every generation
   and therefore keeps burning cells dirty — a fragile accident, not a guarantee.)*

**Recommendation:** ship only after A0, gated behind its own checkbox with the
assertion spelled out. It must also union with A0's term, never replace it.

### 5.3 Tier A2 — a **graph-authored** stability predicate

The brainstorm's literal wording (*"the user would have to determine what conditions
makes a cell be stable"*) invites a boolean expression over the cell's own state — a
second tiny event root (`Stability Predicate`) compiled per target.

**Why not now.** It is a new compiled entry point on **all three targets** (a second
per-cell loop, a fourth compile surface for `check-compile-identity`, and a WASM
export + a WGSL entry to keep in lockstep), evaluated **per cell per generation** —
so a full-grid pass just to decide who to skip. That is self-defeating unless it is
itself maintained incrementally, which needs its own transition detection over
*whatever* the predicate reads. Meanwhile §3.3 shows a **value set** already captures
the realistic cases (terminal states, multi-phase substrates).

**Recommendation:** don't. Revisit only if a real model appears whose stability is not
expressible as "one attribute's value is in a set" — e.g. `state == Burned OR (fuel ==
Water)`, which would justify **a set per attribute, AND-ed** (still worker-only, still
no compiler change) before it justifies a compiled predicate.

### 5.4 Tier B — O(active) **memory**: chunked storage + an unbounded canvas

**The brainstorm's *"without allocating memory for the void regions"* and *"infinite
like golly"*.** Replace each attribute's dense `total`-length typed array with a
**chunk map**: fixed 32³/64² blocks allocated on demand, plus a third
`boundaryTreatment: 'unbounded'`.

**Subsystem impact — this is where the honesty lives.** It is not a storage change; it
is a change to the project's central invariant that *a cell is a flat index into a
dense array*.

| subsystem | impact |
|---|---|
| SoA + `wasmMemory` | ⛔ **structural.** Every attribute is a view at a **baked** offset (`layout.attrReadOffset[id]`); the WASM module indexes `base + idx*width`. A chunk map means an indirection in **every** attribute access on **every** target, or a per-chunk dispatch loop. |
| neighbour access | ⛔ a neighbour may live in another chunk → per-access chunk resolution, or the classic **halo/ghost-cell** exchange per chunk per generation. |
| flat cell index | ⛔ `idx` is *everywhere* — the compiled step's loop variable, `Get Cell Position`, the NI codec, paint/`writeRegion`/`readRegion`, the clipboard, the inspector, indicators. An unbounded canvas also makes the index unbounded (int32 runs out at 2^31 cells; a 3-tuple key is the alternative). |
| WebGPU | ⛔ storage buffers are flat and fixed-size; chunked = a re-uploaded chunk table + indirection in the shader, or one dispatch per chunk. |
| colours + renderers | ⛔ `colors` is a dense `total×4` view; the 2D blit, the L1 WGSL voxel pass and gl3d all index it densely. |
| save/load | ⚠️ `.gcastate` serialises whole typed arrays (base64) — sparse form needed. |
| indicators | ⚠️ every linked scan is `for i in 0..total`. |
| brush / clipboard / GIS import | ⚠️ all address a bounded rectangle. |
| UI | ⚠️ Grid Width/Height/Depth stop being the model's extent; the renderer needs a viewport-driven camera rather than a fit-to-grid one. |

**And §3.5 says the payoff is 1.0× for a soup, 5.6× for a methuselah and 16× for a
glider at 1024².** The genuine value is only in the limit case the brainstorm names —
*unbounded* — where it is enabling rather than optimising.

**Recommendation:** **defer, and if it is ever wanted, scope it as its own milestone
with its own Impact Map** (it is comfortably larger than the 3D Grid CA milestone).
Note that Tier C *requires* it: HashLife has no meaning on a fixed torus.

### 5.5 Tier C — a real HashLife path

**How a model would be detected.** A compile-time purity analysis of the step graph —
which GenesisCA is unusually well equipped for, because the machinery exists:
`accessorCSE.ts` already classifies node purity, and
[geometryTaint.ts](../src/modeler/vpl/compiler/geometryTaint.ts) is a working
precedent for a whole-graph static verdict with a *witness*. The gate would be:
no RNG, no indicator read/write, no `getModelAttribute`, no `Get Generation`, no stop
event, sync, no agents, no glyphs, r = 1, no float attributes, `boundaryTreatment ===
'unbounded'` (Tier B).

**How the rule becomes a leaf.** *Not* by enumerating a table — for S states a 4×4 leaf
has S^16 configurations (GoL 65 536 ✅; Wireworld 4.3×10⁹ ❌). The correct construction
is Golly's own: **compute the base case by calling the compiled step on a 4×4 window**
(the compiled JS step is a plain function over typed arrays — a 4×4 constant-boundary
grid is trivially constructible), and **memoise only nodes actually encountered**.
Dedup, not enumeration, is what makes it tractable — and §3.4 measures dedup collapsing
to nothing on chaotic input.

**What "super speed" would mean for the rest of the app** — this is the part that makes
it a *different engine*:

- the transport's generation counter jumps by 2^k; **there are no intermediate
  generations**, so the gens/frame control becomes a step *exponent*;
- **indicator series get holes** (they are per-generation samples);
- **end conditions and Stop Events cannot fire mid-jump** — they would have to bound
  the jump, which destroys the win;
- **recording/GIF** captures only the sampled generations;
- **the renderer changes**: there is no dense `colors` buffer to blit; Golly renders by
  walking the quadtree to a zoom-dependent depth. Every GenesisCA render path (2D blit,
  WebGPU present, L1 voxel pass, gl3d) assumes the dense buffer.

**Does it belong in GenesisCA?** On the evidence: **no, not as a compile target, and
not now.** It accepts **3 of the 31 shipped models, and all three are the same rule** (§4), needs Tier B first, needs its own renderer and
its own transport semantics, and its headline benefit (exponential time jumps) is
orthogonal to what GenesisCA is for — watching a rule evolve, measuring it with
indicators, and interacting with it. If it is ever built it should be a **fourth
`EngineChoice`** ("Pattern Explorer") with its own gate and its own honest C1
compatibility row — architecturally the same shape as the existing `js | wasm |
webgpu` selector, so the Auto policy simply never picks it.

### 5.6 Tier D — WebGPU stream compaction (= [PERF_REVIEW_LATTICE](PERF_REVIEW_LATTICE.md) L3)

**Contract:** none — SIE stops being a documented no-op on WebGPU. **Same results,
just faster**, so nothing user-facing changes except the removal of the
`AUTO_GRID_SPARSE` caveat string and the C1/C3 "ignored on WebGPU" note.

**Mechanism** (already shipped once, for agents): a per-generation GPU
**count → prefix-scan → scatter** producing a compacted active-index buffer, then an
**indirect dispatch** over it — exactly `agentWebgpuRuntime.ts`'s resident spatial-hash
build. The transition detection can ride the same pass (compare read vs write).

**Cost:** a real GPU-side rewrite of the active set (the CPU `nearCount` dilation does
not port directly — the GPU form is "mark, then compact", recomputed per generation
rather than reference-counted). **But it is the only tier that makes the feature
all-target**, and the Accretor 300³ marginal cost (2.35 ms/gen) suggests the ceiling
is elsewhere anyway — L1 already fixed the 3D render tax; L3's real prize is unblocking
*much larger sparse volumes*.

**Recommendation:** worth doing, **after** A0 — do not build the GPU version of a
predicate that is about to be generalised.

### 5.7 Adjacent finding — Larger-than-Life's running sums (not in the brainstorm, but the biggest single lattice win available)

Golly's `ltlalgo` makes big-radius *totalistic* rules O(1) per cell with cumulative
sums. GenesisCA's MNCA-class models are exactly that shape and are its worst measured
lattice case: **229 ms/gen and a 693 MB neighbour table at 512²**
([PERF_REVIEW_LATTICE](PERF_REVIEW_LATTICE.md) §2), and SIE is documented as
*measurably worse* for them. A compile-time recognition of *"this is a sum/count of one
attribute over a contiguous box or disc"* → a summed-area-table pass would collapse
that to O(1) per cell per ring on **all three targets** (a prefix-sum is trivially
GPU-friendly, unlike everything else in this document).

**This is a much better fit for GenesisCA's actual model population than HashLife**,
and it is recorded here so it is not lost. It deserves its own investigation.

---

## 6. The ALL-TARGET DELIVERY rule

The project rule: a feature runs on JS, WASM **and** WebGPU unless there is a
*documented fundamental incompatibility*. Where each tier stands:

| tier | JS | WASM | WebGPU | verdict |
|---|---|---|---|---|
| **A0** stable value set | ✅ | ✅ | ⚠️ inherits SIE's existing documented no-op | **Not a new violation** — it generalises a predicate that is *already* CPU-only, and adds no per-target emit. Tier D closes the gap for both. |
| **A1** quiescence term | ✅ | ✅ | ⚠️ same | same |
| **A2** graph predicate | ✅ | ✅ | ✅ (would have to be) | would be a genuine 3-target obligation — part of why it is not recommended |
| **B** chunked memory | ⚠️ | ⚠️ | ⚠️ | all three would have to change together; that is the milestone, not an exception |
| **C** HashLife | ✅ | ⚠️ | ⛔ | **a genuine fundamental incompatibility**: memoised recursion over a hash-consed pointer graph with dynamic allocation has no GPU form — the same class as *async mode on WebGPU*. Acceptable **only** if HashLife is modelled as a fourth **engine choice** (which the C4 `EngineChoice` machinery already supports) rather than as a *feature* a model uses. As a feature it would be an ALL-TARGET violation. |
| **D** GPU compaction | ✅ | ✅ | ✅ | it *removes* an existing gap |

---

## 7. Recommendation and phased plan

### Phase 0 — fix the drift (minutes, no design)

Either set `skipIsolatedEmpty.enabled = true` on the shipped **Accretor** (and
re-measure, since it also ships `useWebGPU: true`, where the feature is a no-op — so
the honest fix may be *both* the flag and the engine, or the sentence), or correct its
Rule Description. Today the library documents a feature that no shipped model uses.
**Highest user-visible value per unit of effort in this whole document.**

### Phase 1 — Tier A0, the stable value **set** (⭐ the recommendation)

Worker + schema + UI only; **zero compiler surface**. Gates: `check-compile-identity`
must be *29 models, all surfaces unchanged* **by construction**;
`verify-sparse-stepping.mjs` extended with a multi-value 2D fixture *and* a 3D one,
asserting sparse == full byte-for-byte. Ship a demonstrator: enabling it on **Wildfire**
with `stable = {Unburned, Burned}` is a 25× measured win and makes the feature visible
in the library for the first time.

Subsystem impact table: §5.1. Per the *Impact Map First* rule this is 4 subsystems
(worker, schema/cascades, UI, verification) with **no** compiler or renderer impact —
small enough that §5.1 *is* the impact map.

### Phase 2 — Tier A1, the optional quiescence term (only if a Life-like model wants it)

Adds ~1.8× on Life-shaped rules, adds a history-based invariant across every mutation
handler, and needs an explicit "my rule has no spontaneous change" assertion in the UI.
Do not start it before Phase 1 ships and someone actually wants it.

### Phase 3 — Tier D, WebGPU stream compaction

Makes the feature all-target and unblocks large sparse volumes on the GPU. Reuse the
agent resident-hash count→scan→scatter. Own Impact Map.

### Explicitly NOT planned

- **Tier A2** (graph-authored predicate) — a value set covers the real cases at a
  fraction of the cost.
- **Tier B** (chunked / unbounded) — a milestone-sized change whose measured payoff is
  1.0×–16× at realistic grid sizes; only worth it if *unbounded* itself becomes a goal.
- **Tier C** (HashLife) — a different engine, for 3 shipped models that are all one
  rule (§4), requiring B first.

---

## 8. Retry preconditions

Do not re-open **Tier B** unless: an actual model wants a canvas larger than the WASM /
GPU ceiling *and* is sparse (§3.5 says the ratio must be ≥ ~100:1 grid-to-structure
before chunking pays), **or** "unbounded universe" becomes a stated product goal.

Do not re-open **Tier C** unless **all** of: Tier B has shipped an unbounded canvas;
≥ 3 **distinct rules** pass the purity gate of §5.5 — three variants of Game of Life,
which is exactly today's measured answer, is not three rules; someone wants 2^30-generation jumps
badly enough to accept a transport with no intermediate generations, no per-generation
indicators and no stop events; and a quadtree renderer is acceptable alongside the four
existing render paths. Re-run §3.4's tile-dedup measurement on the candidate models
first — **if dedup is below ~10×, HashLife will lose to the existing WASM step.**

Do open **§5.7 (running sums)** on its own merits at any time; it needs none of the
above.

---

## 9. Reproducing

The scratch scripts are not repo files (per the research-only scope). Each is
~120 lines and rebuildable from this recipe — the pattern is
[scripts/verify-sparse-stepping.mjs](../scripts/verify-sparse-stepping.mjs):

1. esbuild an entry that re-exports `compileAll` / `migrateForHarness` from
   [src/dev/compileHarness.ts](../src/dev/compileHarness.ts) and the whole public
   surface of [src/simulator/engine/activeSet.ts](../src/simulator/engine/activeSet.ts);
2. load a shipped `.gcaproj`, `migrateForHarness` it, `compileAll` it;
3. **read the step's parameter names out of `res.js.stepCode`** (`(function(total, W,
   H, r_alive, w_alive, nIdx_moore, nSz_moore, modelAttrs, colors, activeViewer,
   _indicators, _linkedResults, _rngState, _stopFlag, glyphCodes, glyphColors) {…}`)
   and build the argument array **by name** — positional guessing is how this goes
   wrong;
4. build the neighbour table honouring the model's own `boundaryTreatment` (constant
   ⇒ buffers of length `total + 1`, OOB → the sentinel index `total`);
5. drive `buildActiveOffsets` / `createActiveSet` / `rebuildActiveSet` /
   `applyTransition` / `compactActiveSet` in lockstep with the step, exactly as
   `runStep` does — maintenance **before** the buffer swap, `r` = pre-step, `w` =
   post-step;
6. for a value-**set** predicate, replace `attr[idx] === emptyVal` with
   `set.has(attr[idx])` in a hand-rolled dilation — and **cross-check it against the
   shipped `rebuildActiveSet` for the single-value case** (§3.1) before believing any
   number it produces.
7. for the §4 purity sweep, `compileAll` every `public/models/*.gcaproj` and test the
   emitted `js.stepCode` **body** for `modelAttrs[`, `_indicators[`, and an RNG
   *advance* — the `_rs = (…)` / `_rs ^=` forms, **after stripping the unconditional
   `let _rs = _rngState[0]` prologue and its write-back**, which every step carries
   whether or not it draws. Radius comes from the model's own `coords3d ?? coords`,
   not from the emitted code.

Measurements were taken on the development machine, 2026-09-05, Node 22.
**Quote the ratios; re-measure the absolutes.**
