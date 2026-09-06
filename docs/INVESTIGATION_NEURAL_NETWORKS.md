# INVESTIGATION — Neural networks & Neural Cellular Automata in GenesisCA

**Status: research / brainstorm only — no code, no decisions.** (2026-09-05)

The brainstorm this answers, verbatim:

> Investigate and make a plan on what is missing for us to implement Neural Networks
> inside GenesisCA, whether as standalone neural networks graphs themselves, or as part of
> the cells/agents as being part of their internal models so some of their attributes would
> be outputs of the networks that would be running on their inputs. And how we could train,
> save, load, study it and all that. Related to this investigation is how we could implement
> `Neural Cellular Automatas`.

**The one-line answer.** A Neural CA *is* a GenesisCA model whose rule happens to be a
small dense network with learned constants — every piece of it except the dense layers is
already a node (neighbourhood reads, residual `Update Attribute`, a `Get Random` mask,
`Aggregate max` for the alive mask), and the **weights already have a home that runs on all
three compile targets and travels in the `.gcaproj`: the Lookup Table model attribute**.
What is missing is **three tensor primitives** (`Dense Layer`, `Gather Neighbourhood`,
`Pack`/`Unpack`), **a weight import** (safetensors / npy / TF.js JSON), and — the honest
part — **a training story**: gradient training belongs *outside* GenesisCA in v1 (import
the weights), while **gradient-free training (evolution strategies, Hebbian / local rules)
can live inside**, mostly on the Overseer that already exists.

> Companion: [INVESTIGATION_NEURAL_NETWORKS.html](INVESTIGATION_NEURAL_NETWORKS.html) —
> the three shapes, the NCA-as-graph mapping diagram, the training-route matrix and the
> phased plan, illustrated.
>
> Sibling brainstorm: [INVESTIGATION_SOCIAL_NETWORKS.md](INVESTIGATION_SOCIAL_NETWORKS.md)
> — the "standalone network as agents + bonds" shape below is exactly that document's
> import target, and §5 reuses its directed-edge idiom (§3.6 there).

---

## 0. Honesty notes

- **The NCA architecture numbers in §2 are VERIFIED** against the primary sources this
  session (the Distill *Growing Neural Cellular Automata* article, the *Differentiable Logic
  CA* project page, the μNCA abstract) — quoted, not recalled.
- **Codebase claims** were verified firsthand by direct reads/greps of the current tree;
  the load-bearing ones are marked **[verified]**.
- **Every performance figure in §4.7 is an ESTIMATE from operation counts**, deliberately
  labelled so. Nothing in this document was benchmarked — the primitives do not exist yet.
  The one measured comparison point is the shipped agent-behaviour benchmark
  ([scripts/bench-agent-behaviour.mjs](../scripts/bench-agent-behaviour.mjs): WASM 2–5× JS
  on a heavy per-agent rule), which is the right mental model for a per-cell MLP.
- **Bundle sizes for TF.js / ONNX Runtime Web** are from the projects' own documentation
  (ORT WASM: ~20 MB default, ~8 MB optimised, ~3 MB minimal build) and are the reason §6.2
  recommends against a framework dependency for v1.
- The ML-side design in §4 is a **proposal**, not a decision; it is written against the
  codebase's actual seams so that a later Impact Map can start from something concrete.

---

## 1. The three shapes the question contains

The brainstorm names two ("standalone graphs" / "part of the cells' internal model"); a
third falls out of the second the moment weights differ per agent. They have different
weight stores, different activation stores and different training families, so they must be
kept apart:

| Shape | What a **weight** is | What an **activation** is | Where it runs | Natural training |
|---|---|---|---|---|
| **A. Standalone network** — neurons are AGENTS, synapses are BONDS | a **bond attribute** (`weight`, float) | an **agent attribute** (`activation`, `potential`, `spike`) | the agent behaviour loop, one generation per propagation step | **local rules** (Hebbian, Oja, STDP, perceptron delta) — they *are* CA rules |
| **B. Per-cell / per-agent internal model with SHARED weights** — every cell runs the same small MLP on its own inputs | a **model-level constant array** = a **Lookup Table** | a **per-cell scratch array** = a **Local Variable (array)** | inside the cell / agent step, on every cell every generation | **gradient descent outside, weights imported**; **ES / CMA-ES inside** (Overseer) |
| **C. Per-agent INDIVIDUAL brains** — each agent carries its own weights (neuroevolution) | a **row of a weight-bank table** indexed by the agent's genome id (or per-agent attributes for tiny nets) | as B | as B | **neuroevolution** — mutate on division, select by fitness (`Kill Agent` / `Create Agent` already exist) |

**Neural Cellular Automata are shape B**, exactly. **Graph NCAs** (Grattarola et al. 2021 —
NCA over an arbitrary graph neighbourhood) are shape B running on the agent tier with the
neighbourhood coming from bonds. Shape A is what the classical "neural network as a
dynamical system" literature means — Hopfield nets, spiking networks, reservoir computing,
Kohonen maps — and it is the shape GenesisCA's agent tier was built for.

The design consequence, stated once: **B and C need NEW primitives (§4); A needs almost
nothing new (§5).**

---

## 2. What a Neural CA actually is — the verified architecture

### 2.1 Growing NCA (Mordvintsev, Randazzo, Niklasson & Levin, Distill 2020)

Quoted from the article this session:

- **State**: a **16-value** vector per cell — RGB + alpha (4 visible) + **12 hidden**
  channels "with no predefined meaning".
- **Perception**: **fixed, non-learned** 3×3 filters — the cell's own state (identity),
  **Sobel x** `[[-1,0,1],[-2,0,2],[-1,0,1]]` and **Sobel y** (its transpose) — applied to
  each of the 16 channels, "forming a 16·2+16 = **48**-dimensional perception vector".
- **Update network**: `dense(48 → 128, ReLU)` then `dense(128 → 16, weights_init=0)`,
  **~8 000 parameters**. The output is a **residual delta**: `state += ds`.
- **Stochastic update**: a per-cell mask zeroes the delta with probability **0.5** during
  training (the paper's stand-in for asynchronous updates).
- **Alive mask**: "a cell is considered empty if there is no 'mature' (**alpha > 0.1**)
  cell in its **3×3 neighborhood**" — applied before *and* after the update; empty cells
  are zeroed.
- **Training**: pixel-wise L2 on RGBA after a random **64–96** steps, BPTT with per-variable
  gradient normalisation; a **1 024-state sample pool** with batch **32** for persistence;
  **circular damage** on the 3 lowest-loss samples for regeneration.
- **Deployment**: the interactive demo runs the trained model **in the browser via
  TensorFlow.js and WebGL/GLSL shaders**, with **8-bit** parameters and activations
  (arctan-compressed). That is the existence proof that a trained NCA is a shader — which is
  what GenesisCA's WebGPU target emits.

### 2.2 The variants, and what each one asks of an engine

| Variant | What changes vs 2.1 | The engine feature it needs |
|---|---|---|
| **Texture NCA / μNCA** (Niklasson et al. 2021; Mordvintsev & Niklasson 2021) | no target image — a style/texture loss; μNCA models scale down to **68 parameters** ("a few lines of GLSL or C") | nothing beyond 2.1; at 68 params it is even expressible by hand (§3.2) |
| **Self-classifying MNIST NCA** | cells read a static input channel (the digit) and must agree on a label | an **input** cell attribute never written by the rule — an ordinary attribute |
| **Isotropic / Steerable NCA** (Grattarola et al.; Randazzo et al. 2023) | rotation-invariant perception (Laplacian only), or a per-cell orientation angle steering the Sobel frame | the shipped **Variegated Cells** orientation, or a float `angle` attribute |
| **Graph NCA** (Grattarola, Livi & Alippi 2021) | the 3×3 neighbourhood becomes the node's graph neighbourhood; "NCA can be seen as a special case of Graph Neural Networks" | **agents + bonds** — the `Gather` primitive over `Get Bonded Agents` instead of a lattice neighbourhood |
| **Mesh NCA** | the same on a mesh, WebGL demo on phones | as Graph NCA |
| **Differentiable Logic CA** (Miotti, Niklasson, Randazzo & Mordvintsev 2025) | the state is **binary** (8–128 bits), the update is a **logic-gate circuit** learned with continuous relaxations and then **frozen to pure 0/1 gates** — recovers Game of Life with **336 active gates**; a checkerboard rule needs "just five logic gates" | **nothing** — the frozen artifact *is* a Boolean rule graph; GenesisCA's `Logical Expression` / `Logic` nodes are its native form (§6.5) |
| **Lenia / continuous CA** | not neural, but the same "learned kernel + growth function" family; kernels of radius ~13 (500+ cells) | a large neighbourhood (the Sparse-stepping caveats apply) — outside this document |

**The observation that organises everything below:** *an NCA update is one neighbourhood
gather, two dense layers, one random mask, one max-pool, one residual add.* GenesisCA has
the gather (`Get Neighbors Attribute`), the mask (`Get Random`), the max-pool
(`Aggregate max` over a neighbourhood with the centre cell included), and the residual add
(`Update Attribute increment`). **It does not have a dense layer, and it does not have an
array-of-attributes bridge.** That is the whole gap for shape B.

---

## 3. What is expressible TODAY — verified against the node catalogue

**[verified]** against `registry.ts` (156 registered node types) and the compiler surfaces.

### 3.1 Shape A — local learning on agents + bonds: ✅ today

Every local plasticity rule reads the two endpoint activations and writes the edge:

```
For Each Bond
  ├─ Get Attribute (by ID)[partnerId] → a_j
  ├─ Get Self Attribute → a_i
  ├─ Get Bond Attribute(weight) → w
  └─ Set Bond Attribute(weight, w + η·a_i·a_j)         ← Hebb
                              w + η·a_j·(a_i − w·a_j)   ← Oja
                              w + η·(t_i − a_i)·a_j     ← perceptron / delta
```

and a **weighted sum** over incoming edges is the same loop accumulating into a Local
Variable, followed by an `Expression` (`tanh`, `exp`, `max` all exist in the parser
**[verified]**: `sqrt abs floor ceil round min max pow mod exp log sin cos tan tanh`).
**STDP** needs each endpoint's last-spike generation — one integer agent attribute
(`Get Generation` is universal). A **leaky integrate-and-fire** neuron is three Expression
nodes. A **Hopfield** network is `Aggregate` over `Get Agents Attribute` with weights via
`Get Bond Attribute` — the same loop. **Nothing new is needed for shape A's dynamics or its
local learning.** Its costs and limits are §5.

### 3.2 Shape B at μNCA scale — ✅ today, by hand

A 68-parameter μNCA (4 channels, 3 fixed filters, a 4→4 update) is **12 perception values →
4 outputs**: four `Expression` nodes (8 inputs each — the pool `a…h` **[verified]**), fed by
`Get Neighbor Attribute By Tag` reads on a Moore neighbourhood with compass tags, writing
through `Update Attribute increment`. Roughly 40–60 nodes. Tedious, but a real model, and a
good early demo *before* the primitives exist.

### 3.3 Shape B at Growing-NCA scale — ⚠️ expressible in principle, not in practice

The counts are the argument:

- **Perception**: 16 channels × (8 neighbours + self) = **144 raw reads** per cell, or 48
  filter outputs each a weighted sum of 9 taps. There is **no weighted-sum / dot-product
  primitive over an array [verified]** — `Aggregate` offers sum/product/min/max/average/
  median, `Vector Op dot` is 2–3 components only. So a Sobel is 9 `Get Neighbor Attribute
  By Tag` reads + one 8-input `Expression` (+ one more for the 9th tap) — **~11 nodes per
  filter output, ~500 nodes for the perception alone**.
- **Dense 48 → 128**: an `Expression` takes 8 inputs, so one hidden unit is 6 Expression
  nodes + 5 adds — **~1 400 nodes**; 128 → 16 another ~250.

Two thousand nodes for a rule that is *conceptually* four operations. That is not a model
anyone will build, and it is not a model the editor should be asked to render. **It is
exactly the "lower it or emit it" situation the ALL-TARGET rule describes, and the answer
is a primitive.**

### 3.4 The gap table

| Need | Today | Gap |
|---|---|---|
| shared weight store, all targets, in the file | ✅ **Lookup Table** (§4.1) | none |
| per-cell activation scratch | ✅ **Local Variable (array)** | none (sizing rule §4.2) |
| neighbourhood gather of ONE attribute | ✅ `Get Neighbors Attribute` | of **K attributes as one array** — `Gather` (§4.4) |
| **dense layer** `y = act(Wx + b)` | ❌ | **`Dense Layer`** (§4.3) |
| array → K attributes / K attributes → array | ❌ (Make/Break Vector are 2–3 wide; multi-slot Set Attribute takes scalars) | **`Pack` / `Unpack`** — pure lowerings (§4.5) |
| random per-cell mask | ✅ `Get Random` (bool) | none |
| alive mask (3×3 max of alpha) | ✅ `Get Neighbors Attribute` (Moore + centre) → `Aggregate max` → `Compare` | none |
| residual update | ✅ `Update Attribute increment` | none |
| weight **import** | ❌ | safetensors / npy / TF.js JSON → tables (§6.1) |
| gradient training | ❌ | outside (v1); §6.2 |
| gradient-free training | ⚠️ Overseer has the loop, not the mutate/keep-best verbs | §6.3 |
| per-agent weights (shape C) | ⚠️ a table row per genome works; **no per-agent array attribute** | §4.3's row offset + a mutate op (§6.3) |

---

## 4. The design for shapes B and C — three primitives, one weight store, no new runtime type

### 4.1 Weights = Lookup Tables (the store already exists on every target)

**[verified]** The Lookup Table model attribute is a flat float array with:

- a **live update seam on all three targets** — the worker's `updateLookupTable` handler
  copies into the existing typed-array **view over `wasmMemory`** (so the WASM step reads
  the new values through its baked offset) and calls `uploadInteractionTable` for the
  WebGPU `varAux` buffer; the agent targets carry the same tables in the agent memory
  region (WASM) and the `auxF32` buffer (WebGPU) (`agentWebgpu/layout.ts`
  `lookupTables` **[verified]**);
- **N-D axes** (`MAX_LOOKUP_AXES = 6`, `intRange` axes up to `MAX_INT_RANGE_SPAN = 4096`,
  `MAX_LOOKUP_TABLE_ENTRIES = 1 048 576` **[verified]** in `variegation.ts`) — a weight
  matrix is a 2-axis `intRange × intRange` table; a bias is a 1-axis one;
- **persistence for free** — `tableData` rides the `.gcaproj`, and a preset's
  `interactionTables` / `lookupTableData` snapshot **is a checkpoint** (§7);
- an editor — the matrix-play widget, the seeded **Randomize** block (`randomFillTableData`,
  signed ranges) — i.e. weight *initialisation* is already a UI;
- an Overseer verb — `ovRandomizeTable` re-rolls a table from a seed **at runtime without
  dirtying the model** **[verified]** (the rule-space-search primitive). §6.3 builds on it.

Precision: **f64 on the CPU targets, f32-bitcast on the GPU** — the documented
statistical-parity stance. NCAs are trained in f32 and the Distill demo *ran* at 8 bits, so
this costs nothing the practitioners had not already given up.

Capacity: the Growing NCA's ~8 000 parameters fit in two tables (48×128 + 128×16 = 8 192
entries) and cost 64 KB of `wasmMemory` — nothing. The 1 M-entry cap bounds a single table
at, e.g., 1 024 × 1 024; larger layers would be several tables. That is not a limitation
anything in the NCA literature approaches.

**Why not a new "tensor" attribute type?** Because a table already *is* one, on every
target, with its layout lockstep (`resolveAxes` is the ONE resolver every mirror derives
from) already paid for. Adding a second flat-float-array store would duplicate the most
drift-prone plumbing in the codebase.

### 4.2 Activations = Local Variable arrays

**[verified]** array Local Variables are per-cell/per-agent scratch on all three targets
(JS typed array refilled per cell, WASM per-cell scratch, WGSL `var<function>` arrays). Two
consequences for a 128-wide hidden layer:

- **Sizes must be compile-time constants** — the WGSL array is fixed-size and the WASM
  scratch is a bump pointer. A `Dense Layer`'s in/out widths are therefore **node config**,
  validated against the referenced tables' dims at compile time (a `nodeValidation` badge
  when they disagree — never a silent truncation).
- **The WebGPU per-thread register budget is real.** The agent target already caps per-thread
  arrays at `AGENT_GPU_ARRAY_CAP = 2048` **[verified]**; a 48 + 128 + 16 = 192-float working
  set is comfortable, a 1 024-wide hidden layer is not. This is the same "cost it on the
  worst case" discipline as the hub in the social-network document — cost a dense layer on
  its *widest* layer.

### 4.3 `Dense Layer` — the one primitive that needs real emit

```
Dense Layer
  in:  x (array, float)          config: weights = <table id>   (2-axis, out × in)
  out: y (array, float)                  bias    = <table id | none>  (1-axis, out)
                                         activation = linear | relu | leaky_relu | tanh | sigmoid
                                         rowOffset port (integer, optional — shape C, below)
```

- **Semantics**: `y[o] = act( b[o] + Σ_i W[o][i] · x[i] )`, `i` ascending — **the
  accumulation ORDER is part of the contract** so JS and WASM stay bit-identical (the
  `Math.hypot` lesson: never a fused or reordered sum on one target). WGSL runs f32.
- **Per target**: JS a nested `for` over the table view; WASM a nested loop over the table
  region at its baked offset (the `emitLoop` pattern) with the f64 accumulate in a local;
  WGSL a nested `for` over `varAux` / `auxF32` (the same dims baked by `resolveAxes`).
  `tanh`/`exp` already exist as host imports on WASM (`TANH_FUNC_IDX` **[verified]**) and
  as WGSL intrinsics, so no new import is needed; `sigmoid` = `1/(1+exp(−z))`.
- **Shape C — the `rowOffset` port**: a **weight BANK** is one 2-axis table
  `[genome × param]`; an agent's brain is the row `rowOffset = Get Self Attribute(genomeId)`
  (or `Get Self Handle`). With the 4 096-span `intRange` axis and the 1 M-entry cap that is
  **128 genomes × 8 192 params, or 4 096 genomes × 256 params** — the neuroevolution regime
  (small brains, many agents). No per-agent array attribute is needed for this; the table
  *is* the population's genome array.
- **Registration checklist** (the standing rules): a value node, pure ⇒ CSE-eligible,
  NOT `NEVER_INVARIANT` (it hoists if its input does), in `NODES_REFERENCE`, all three
  agent-target supported sets, `detectMissingConfig` for the table ids and the dims
  agreement, a `capabilityMatrix.gen.ts` regeneration.

### 4.4 `Gather Neighbourhood` — K attributes over a neighbourhood as ONE array

```
Gather Neighbourhood
  config: neighbourhood, attributes[] (K), includeSelf     → out: x (array, K × (nSz [+1]))
```

Layout `[attr0 @ slot0..nSz, attr1 @ …]`, self last. It is `Get Neighbors Attribute`
K times plus a concatenation — and it could **LOWER** to exactly that (K existing gathers +
`setArrayElement` writes into a Local Variable array) with zero per-target emit, the
`expandX` pattern. A native emit would only save the copy. **Recommendation: lower first.**

**The perception layer needs no primitive of its own.** Sobel/identity/Laplacian are
*linear*, so "perception = fixed filters" is **`Gather` (raw 144 values) → `Dense` with a
FIXED 48 × 144 table** — the same node, a table the importer writes once. That is also more
general (any fixed kernel, any neighbourhood, 3D for free) and it is how the Distill
implementation actually computes it (a depthwise convolution is a matrix).

On the agent tier `Gather` reads `Get Bonded Agents → Get Agents Attribute` per attribute —
which is what makes a **Graph NCA** the same graph with one node swapped.

### 4.5 `Pack` / `Unpack` — the array ⇄ attributes bridge, as pure lowerings

- `Pack(attrs[K]) → array` lowers to K `Get Self Attribute` + K `setArrayElement` into a
  Local Variable array.
- `Unpack(array, attrs[K], mode = set | add)` lowers to K `arrayElement` reads + the
  **multi-slot** `Set Attribute` / `Update Attribute increment` (both shipped) — so the
  NCA's residual `state += ds` is native, and so is "some of a cell's attributes are outputs
  of the network".

Both are `expandComposites`-class transforms: **zero per-target emit, all six surfaces by
construction, byte-identical when absent.** They are also independently useful (the
"there is no per-agent array attribute" gap the social-network document notes is largely a
Pack/Unpack gap).

### 4.6 The Growing NCA, as a GenesisCA graph

With 4.3–4.5, the whole rule is ~10 nodes on the Cells graph:

```
[Generation Step]
  ├─ Gather(moore+self, ch0..ch15) ──► Dense(percept 48×144 fixed) ──► Dense(128, relu) ──► Dense(16, linear) = ds
  ├─ Get Random(bool, p=0.5) ──► If ──► Unpack(ds, ch0..ch15, add)          ← stochastic residual update
  ├─ Get Neighbors Attribute(alpha, moore+self) ──► Aggregate(max) ──► Compare(> 0.1)
  │        └─► If NOT alive ──► Set Attribute(ch0..ch15 = 0)                  ← alive mask
  └─ [Output Mapping] ch0..ch3 → RGBA via Set Cell Looks (alpha = ch3·255)
```

Attributes: 16 float cell attributes (`ch0..ch15`; the first four are RGBA). Tables: three
(perception, W1+b1, W2+b2 — biases as 1-axis tables). Everything else is shipped. **3D is
free**: `Gather` over a 26+1 neighbourhood gives a 432-wide input; only the table dims
change.

The random mask draws one `Get Random` per cell per step — on JS/WASM from the shared
xorshift32, on WebGPU from the per-cell PCG (the documented difference; it changes nothing
qualitative for a rule that was *trained* under a random mask).

### 4.7 Cost model — ESTIMATES from operation counts, not measurements

Per cell per generation, the 2.1 architecture: perception 48 × 144 = 6 912 MAC (or 432 as
three fixed 9-tap filters), hidden 48 × 128 = 6 144, output 128 × 16 = 2 048 —
**≈ 15 k MAC as a dense perception, ≈ 8.6 k MAC as fixed filters**. Against the shipped
engine's measured behaviour (WASM 2–5× JS on heavy per-agent rules; WebGPU orders of
magnitude beyond on dense per-cell arithmetic):

| Grid | MAC / generation | JS (est.) | WASM (est.) | WebGPU (est.) |
|---|---|---|---|---|
| 64 × 64 (the Distill demo's own size) | 35–60 M | ~0.1–0.3 s | ~0.05–0.1 s | ≪ 1 frame |
| 100 × 100 | 86–150 M | ~0.3–0.6 s | ~0.1–0.3 s | ~1–3 ms |
| 300 × 300 | 0.8–1.4 G | seconds | ~1–2 s | ~10–30 ms |
| 1000 × 1000 | 8.6–15 G | minutes | ~15–40 s | ~0.1–0.3 s |

The shape of that table is the point: **an NCA at any interesting size is a WebGPU
feature**, exactly as the 3D voxel grid is — and the all-target rule still holds (JS and
WASM run it correctly, as the reference and the fallback). The weight reads are the same
8 k floats for every thread, so the GPU cost is arithmetic-bound, not bandwidth-bound.

### 4.8 What the primitives do NOT change

No new value-runtime type (arrays and tables already exist), no new worker message, no new
memory region (tables are already laid out), no ABI change (a Local Variable array is
function-scope scratch). `check-compile-identity` stays byte-identical for every model that
does not place the nodes — the same argument every lowering has shipped under.

---

## 5. Shape A — standalone networks as agents + bonds

### 5.1 What works, and works well

| Network | Mapping | Status |
|---|---|---|
| **Hopfield / attractor nets** | activations as agent attrs, symmetric weights as a float bond attribute, `Aggregate` over `Get Agents Attribute × Get Bond Attribute` | ✅ today; Hebbian storage ✅ (§3.1) |
| **Spiking (LIF / Izhikevich)** with delays | membrane `v`, recovery `u` as attrs; `spike` bool; a `delay` **integer bond attribute** + `Get Generation` | ✅ today — a Brian/NEST-style time-stepped SNN is a natural agent model; STDP ✅ |
| **Kohonen SOM** | neurons on a lattice — literally the **cell** grid with a weight vector per cell (K float attrs); the winner search is global ⇒ a `Get Indicator` of the min-distance + `groupOperator.min`'s `position` | ✅ small K; awkward beyond |
| **Reservoir / echo-state** | a random sparse recurrent agent graph + a linear readout **on one agent** running a `Dense Layer` | ✅ with §4.3 |
| **Layered feed-forward MLP** | a `layer` tag attribute; layer ℓ updates on generation phase ℓ via **`Agent Periodic Step`** (period = depth, phase = layer) — the rule-cadence feature exists precisely for this | ✅ expressible; ⚠️ costly (below) |
| **Graph NCA** | §4 primitives on the agent tier with `Gather` over bonds | with §4 |

**Directedness** uses the social-network document's §3.6 idiom (a `source` integer bond
attribute; reciprocal arcs as a lo/hi pair). A **feed-forward** network is directed by
construction (layer index decides direction), so it needs no attribute at all.

### 5.2 The honest limit — the same `maxBonds` ceiling, from the other side

A dense layer as *bonds* costs `maxBonds = fan-in` slots for every agent (the ELLPACK
store). A 784 → 100 → 10 MLP as agents is 894 agents with `maxBonds = 784`: **894 × 784 ×
28 B ≈ 19.6 MB** for 79 400 real edges, and every propagation step is a `For Each Bond` over
784 slots — for a network a single agent running one `Dense Layer` computes in 78 k MACs.

So the recommendation is a division of labour, not a preference: **shape A for networks
whose *topology* is the model** (sparse, recurrent, spiking, plastic, growing — everything
the GRA milestone is good at), **shape B for networks whose *arithmetic* is the model**
(dense inference). And the bridge between them is one sentence: **"a standalone MLP is a
population of size 1 running `Dense Layer` nodes"** — the same primitive serves both.

---

## 6. Training — the honest map

### 6.1 Train outside, import weights — the v1 story, and the practitioners' own

Every NCA paper trains in PyTorch/JAX/TF for thousands of steps with BPTT and Adam and then
*deploys* the frozen weights (the Distill demo ships TF.js exports). The v1 story is the
same: **a weight importer that writes lookup tables**, mapping tensors by name.

| Format | Shape | Cost to read | Verdict |
|---|---|---|---|
| **safetensors** (HF) | 8-byte header length + a JSON header `{name: {dtype, shape, data_offsets}}` + raw little-endian data | **~40 lines, no dependency** | ✅ primary — the modern interchange, exportable from every framework |
| **`.npy` / `.npz`** (NumPy) | magic + a Python-dict header + raw data; `.npz` is a zip of `.npy` | ~30 lines + zip inflate (`DecompressionStream` is native) | ✅ second — what a Colab cell writes by default |
| **TF.js layers model** (`model.json` + `weights.bin`) | JSON manifest naming tensors + shapes + one concatenated binary | ~40 lines | ✅ third — **the Distill Colab's own export format** |
| ONNX | protobuf graph | a protobuf decoder + a graph walk | ❌ v1 — heavy, and we only want the tensors |
| PyTorch `.pt` | pickle | unsafe/undecodable in the browser by design | ❌ (users `torch.save` a state_dict → safetensors in one line) |

The dialog is the `.asc`/GeoTIFF importer's shape: list the tensors, map each to a new or
existing table (2-axis `intRange × intRange` from the tensor's shape; a 1-D tensor to a
1-axis table), report dtype/shape/dims mismatches loudly, write `tableData`. **No compiler
impact, no worker impact** (`updateLookupTable` already exists) — the same structural
argument the GIS importers shipped under.

### 6.2 Gradient training IN GenesisCA — what it would really take

Backprop through an NCA is backprop **through the unrolled CA**: 64–96 generations, every
cell, the whole `Gather → Dense → Dense → mask → residual` chain, plus the sample pool. Three
routes, ranked by honesty:

1. **A differentiable framework as a dependency** (TF.js core + WebGPU backend, or ONNX
   Runtime Web with training). Two costs. *Size*: ORT's WASM is **~20 MB by default, ~8 MB
   optimised, ~3 MB in a minimal build** (its own docs); TF.js core + a backend is a
   multi-MB addition to an app whose whole shell is ~3 MB and whose **single-file
   presentation export** already had to alias the 500 KB GeoTIFF reader out of the viewer.
   *Architecture*: the rule graph would need a **fourth emitter** — "emit this graph as
   framework ops" — for the differentiable node subset (no async mode, no order-dependent
   indicators, no structural verbs), i.e. a fourth compile target kept in lockstep. That is
   a milestone, not a feature.
2. **A hand-written reverse pass for the NCA subgraph only.** The trainable NCA is
   *exactly* `Gather → Dense(relu) → Dense → mask → residual`, whose backward pass is
   textbook (transpose-matmuls and a ReLU mask; `Gather`'s adjoint is a scatter-add). A
   "Train NCA" panel could run its OWN forward+backward on WebGPU in the worker — a
   dedicated compute-shader pair, not a general autodiff — with the sample pool, damage and
   the L2 loss reading a `target` cell attribute (which the image importer already writes).
   **Honest scope: a few thousand lines, WebGPU-only by nature, and it must be verified
   against a reference trainer (gradient-check against JAX on a tiny grid) before anyone
   trusts a loss curve.** This is the route if in-app training is ever wanted.
3. **None** — v1. Import weights (§6.1); train elsewhere.

**Recommendation: 3 for v1, keep 2 on the table, never 1.** The measured GPU/CPU
asymmetry (§4.7) means route 2 would not even *want* the CPU targets.

### 6.3 Gradient-FREE training in GenesisCA — the Overseer is most of an ES loop already

Evolution strategies need: perturb the weights, run, measure, keep the better. **[verified]**
the Overseer already has run/measure/keep-book: `ovResetBoard`, `ovRunGenerations` (fixed
count — the ensemble-average discipline), `ovReadIndicator`, `ovCollectSample` /
`ovSeriesStat` (mean/std/ci95), `ovSetSeed` with the seed policy, `ovSetModelAttribute`,
**`ovRandomizeTable`** (re-roll a table from a seed at a density — *runtime-only, never
dirties the model*), journal + CSV export. What is missing is small and specific:

| Missing verb | Semantics | Why it is cheap |
|---|---|---|
| **`ovPerturbTable(table, σ, seed)`** | `T ← T + σ·N(0,1)` from a seed, runtime-only | the same `deps.randomizeTable` seam with a different fill (a seeded Gaussian; `randomFillTableData` is the precedent) |
| **`ovSnapshotTable` / `ovRestoreTable`** (or *keep-best*) | copy the live table to a named slot; restore it — the ES "reject the mutation" step | the worker already holds the table as a typed array; a snapshot is `.slice()` |
| **`ovCommitTable`** | write the live (trained) table back into the MODEL's `tableData` | the one deliberate exception to "runtime-only" — it is how training *saves* |
| **a loss indicator** | `Σ_cells (ch − target)²` | ✅ **expressible today**: a `target` cell attribute written by the image importer + one `Expression` per channel + a **linked Total indicator** — no new node |

With those four verbs a **(1+λ)-ES / hill climb** is an Overseer graph: `perturb → reset →
run 64 → read loss → keep or restore`, journaled, exportable, reproducible under the seed
policy. **CMA-ES** wants the covariance update, which is an Overseer arithmetic graph over
`ovSeriesStat` outputs — feasible but a real protocol to write. Cost, honestly: an
8 000-parameter ES needs thousands of evaluations × 64–96 generations each — hours at
100×100 on WebGPU, and the Overseer drives **one** worker sequentially (its planned worker
pool, PR4 in `PLAN_OVERSEER.md`, is what would make a population run in parallel). **For
μNCA-scale nets (68–600 params) ES in the app is entirely realistic on today's hardware**;
for a Growing NCA it is a demo of the mechanism, not a replacement for §6.1.

**Shape C — neuroevolution of per-agent brains** is the same verbs at agent grain:
`rowOffset = genomeId`, a fitness attribute, **`Kill Agent` / `Create Agent` for selection
(shipped)**, and a **mutate-row** verb (a per-agent `ovPerturbTable` over one row — or, on
the agent graph, a `Mutate Table Row` flow node so the mutation happens *in the rule* at
division time, the way `divideAgent` already hands a daughter its mother's attributes). The
genome copy-on-division is a table-row copy; both are one worker message each. This is the
NEAT-*style* regime (fixed topology, evolved weights); true NEAT (evolving topology) is
shape A's `Form Bond`/`Rewire Bond` verbs on a network of neuron-agents — expressible today,
slow.

### 6.4 Local learning rules — already there

§3.1. Hebbian, Oja, perceptron delta, STDP, BCM: all local, all `Set Bond Attribute`, all on
every agent target (bond attributes emit on JS/WASM/WebGPU — GRA P3). **This is the one
training family GenesisCA supports *natively and now*, and it is the biologically
meaningful one for a CA/ABM tool.** A "Hebbian assembly" sample (§9) should ship before
any of §4 exists.

### 6.5 Differentiable Logic CA — import the trained circuit as a native graph

The DiffLogic CA's frozen artifact is a **list of binary gates** over a bit-state — Game of
Life in **336 gates** — and GenesisCA's `Logical Expression` / `Logic` nodes are literally
that. A generator (`scripts/gen-difflogic-import.mjs`, or an `.gcamacro` emitter) that
turns a gate list into a rule graph is a few hundred lines, needs **no engine or compiler
change**, and makes GenesisCA the *inference* side of that paper: train the circuit outside,
run it here on all three targets with **exact** (Boolean) parity — the one NN family where
the GPU/CPU precision stance does not even apply.

---

## 7. Save, load, study

| Concern | Answer | Status |
|---|---|---|
| **Save weights** | they are lookup tables ⇒ `tableData` in the `.gcaproj` | ✅ today |
| **Checkpoints** | a **preset** snapshots every table (`interactionTables` / `lookupTableData`) — "epoch 500" is a preset; `.gcapreset` exports one | ✅ today |
| **Load pretrained** | §6.1 importer → tables | new (NN1) |
| **Export weights** | a table → safetensors/npy/CSV export (the CSV export dialog is the shape) | new, small |
| **Read the model** | **Show Code prints every lookup table dense** with its axis dims/strides **[verified]** — the whole network is in the port-ready document | ✅ today |
| **Inspect activations** | the cell/agent inspectors show every attribute incl. the 12 hidden channels; an **Agent/cell Output Mapping** colours by any hidden channel or by a Dense output written to an attribute | ✅ today |
| **Measure** | linked indicators over any channel; the loss indicator (§6.3); graph indicators for shape A | ✅ today |
| **Reproduce** | Overseer seed policy + journaled table seeds | ✅ today |
| **Share** | the standalone `.html` export embeds the tables with the model — a trained NCA becomes a single self-running file | ✅ today |

That column of ✅ is the reason to put weights in tables rather than anywhere new.

---

## 8. Coverage — what each family needs

| Model | Shape | Expressible today? | With §4 primitives | Training path |
|---|---|---|---|---|
| Hopfield / Hebbian assembly | A | ✅ | — | local (today) |
| Spiking net + STDP | A | ✅ | — | local (today) |
| Kohonen SOM (small K) | cell / A | ✅ | cleaner with Pack | local (today) |
| Reservoir + linear readout | A + B | ⚠️ readout by hand | ✅ | readout: ES or import |
| Dense MLP inference (one agent / every cell) | B | ❌ practical | ✅ | import |
| μNCA texture (≤ 100 params) | B | ✅ by hand | ✅ | import; ES in-app realistic |
| **Growing NCA** | B | ❌ practical | ✅ (~10 nodes) | import (v1); hand-rolled BPTT (route 2) later |
| Self-classifying / conditional NCA | B | as Growing + an input attribute | ✅ | import |
| Steerable / isotropic NCA | B | ✅ with Variegated orientation | ✅ | import |
| Graph NCA | B on agents | ❌ practical | ✅ (`Gather` over bonds) | import |
| Neuroevolved agent brains | C | ⚠️ tiny brains as attributes | ✅ (row-offset bank) | ES / neuroevolution in-app (§6.3) |
| DiffLogic CA (frozen circuit) | boolean rule | ✅ via a generator | — | trained outside; **exact** here |
| Lenia | continuous CA | large-kernel caveats | — | not neural — out of scope |

---

## 9. Recommendation + phased plan

**Ship NN1 and NN2; write the samples in NN0 first; keep NN3 as the honest "if we ever".**

### NN0 — samples with what exists (no code change)

1. **Hebbian assembly** — agents on a ring + random long-range bonds, a `weight` float bond
   attribute, Hebb + Oja normalisation; store two patterns by clamping, recall by cueing with
   the agent brush. Shows shape A end to end on three targets.
2. **μNCA by hand** — a 4-channel texture NCA from `Expression` nodes, weights typed in from
   the paper's Colab export. The "before" picture for NN1.
3. **The loss indicator idiom** — a `target` attribute filled by the image importer, an
   `Expression` per channel, a linked Total indicator. Reused by NN2.

### NN1 — the tensor primitives + weight import ★ the whole unlock

| Subsystem | Change | Notes |
|---|---|---|
| **schema** | *(none)* | weights are lookup tables; activations are Local Variables |
| **nodes** | **`denseLayer`** (real emit ×3 cell + ×3 agent), **`gatherNeighborhood`**, **`packAttributes`**, **`unpackAttributes`** (the last three as **lowerings** in a new `tensorExpand.ts`, wired after `collapseReroutes` in all six front-ends — the `censusExpand` placement) | the dense emit is a nested loop per target; **accumulation order is the contract** (JS ≡ WASM bit-identical) |
| **compiler** | `tensorExpand.ts`; `denseLayer` in `VALUE_NODE_EMITTERS` (WASM/WGSL, cell + agent) and both agent supported-type sets; `nodeValidation` dims-vs-table checks; `NEVER_INVARIANT`/purity: pure | a model without the nodes is byte-identical (`check-compile-identity`) |
| **worker / engine** | *(none)* | `updateLookupTable` is the live seam |
| **import** | **new `src/simulator/weightsImport.ts`** (safetensors + npy/npz + TF.js JSON, dependency-free) + a dialog mapping tensors → tables; a transport-menu item + `genesis-open-weights-file` drop | the `.asc`/GeoTIFF importer's shape; no viewer alias needed (tiny) |
| **UI** | the Dense/Gather/Pack/Unpack config blocks; a "dims mismatch" badge | |
| **docs** | Help "Neural CA" recipe, `NODES_REFERENCE` (+4 nodes), README one line, `capabilityMatrix.gen.ts` regen | |
| **harness** | **`scripts/test-tensor-nodes.mjs`**: Dense VALUES on JS + a real WASM module bit-identical; the WGSL shape; a hand-computed 2-layer net; the lowerings' byte-identity when absent; a permanent `[synthetic] Dense Layer` parity entry with a VALUE invariant | the standing negative-control discipline (source mutations that must fail) |
| **sample** | **Growing NCA (pretrained)** — the Distill lizard/emoji weights exported from the authors' Colab by the project author (not transcribed), 64×64 → resize to taste, WebGPU | the demo of the whole feature; regeneration on brush damage is the money shot |

**ALL-TARGET DELIVERY**: `denseLayer` emits on JS, WASM and WebGPU (cell + agent); the other
three are lowerings. Nothing is JS-only, nothing is clamped. WebGPU is the *fast* target,
not the only one.

### NN2 — training without gradients + the DiffLogic bridge

- Overseer verbs: **`ovPerturbTable`**, **`ovSnapshotTable`/`ovRestoreTable`**,
  **`ovCommitTable`**; an **ES sample** training a μNCA texture in-app (journaled, seeded).
- Shape C: a **`Mutate Table Row`** agent flow node + a **copy-row-on-division** hook; a
  **neuroevolution sample** (agents with 16-param brains foraging on a field; fitness =
  `Get Age` or an energy attribute; selection = `Kill Agent`).
- **DiffLogic import generator** (`gen-difflogic-import.mjs` → a `.gcamacro` / model) with
  the Game-of-Life circuit as the regression fixture (exact parity vs the shipped GoL).
- Table **export** (safetensors / CSV).

### NN3 — deferred, with the reason

| Deferred | Why |
|---|---|
| In-app **gradient** training (route 2, a hand-rolled BPTT for the NCA subgraph on WebGPU) | thousands of lines, WebGPU-only by nature, needs gradient-checking against an external reference; only worth it once NN1's inference is in daily use |
| A differentiable **compile target** / framework dependency (route 1) | a fourth lockstep target + a multi-MB dependency the single-file export cannot carry; the wrong trade for this app |
| Per-agent **array attributes** | the row-offset weight bank covers the neuroevolution case; a general array attribute is its own (large) schema milestone |
| ONNX / PyTorch pickle import | protobuf / pickle decoders for tensors we can get as safetensors in one line |
| Attention / transformer-style NCAs | a `softmax` over a neighbourhood array is one more primitive on top of NN1 — add when a model asks |
| Lenia | not neural; its large-kernel cost is the sparse-stepping document's problem |

---

## 10. Risks / open questions

- **Bit parity of the dot product across JS/WASM** is a *contract* (§4.3), and WGSL's f32
  accumulation will differ; an NCA's dynamics are chaotic enough that JS and WebGPU runs
  diverge visibly after a few hundred steps. That is the documented stance, but it will be
  the first thing an NCA user notices — say it in the sample's description.
- **Per-thread register pressure on WebGPU** (§4.2) bounds the widest layer; the badge must
  state the number, not merely refuse.
- **`Get Random` on WebGPU is per-cell PCG** — a trained NCA does not care; a *training*
  loop reproducing a paper might.
- **Where does "train" live in the UI?** The Overseer panel is the honest home for ES (it
  already owns run/measure/journal); a dedicated "Train" panel is only justified by route 2.
- **Weight import naming**: tensors arrive named `dense_1/kernel:0` or `layers.0.weight`;
  the dialog maps by hand the first time and should remember the mapping per model
  (the `genesisca_input_params_v1:<model>` persistence pattern).
- **Presets as checkpoints** are only checkpoints if the tables are *in* the preset —
  the "include board state" discipline applies (a trained table can be hundreds of KB).
- **The alive mask needs `includeCentralCell`** on the Moore neighbourhood (the 3×3 max
  includes the cell itself); a neighbourhood without it silently makes every cell's own
  alpha irrelevant. Document it in the sample.

---

## 11. Sources

Verified online this session: Mordvintsev, Randazzo, Niklasson & Levin, *Growing Neural
Cellular Automata*, Distill 2020 (`distill.pub/2020/growing-ca`) — the architecture,
training and browser-deployment quotes in §2.1; Miotti, Niklasson, Randazzo & Mordvintsev,
*Differentiable Logic Cellular Automata* (project page
`google-research.github.io/self-organising-systems/difflogic-ca/`, arXiv 2506.04912) — the
gate counts in §2.2/§6.5; Mordvintsev & Niklasson, *μNCA: Texture Generation with
Ultra-Compact Neural Cellular Automata* (arXiv 2111.13545) — the 68-parameter figure; ONNX
Runtime Web's deployment docs (`onnxruntime.ai/docs/tutorials/web/deploy.html`, the WASM
size figures in §6.2); the TensorFlow.js README (WebGPU backend, per-package imports). From
the literature: Grattarola, Livi & Alippi, *Learning Graph Cellular Automata* (NeurIPS
2021); Randazzo et al., *Growing Steerable NCA* (2023); Niklasson et al., *Self-Organising
Textures* (Distill 2021); Pajouheshgar et al., *Mesh NCA*; Petersen et al., *Deep
Differentiable Logic Gate Networks* (NeurIPS 2022); Stanley & Miikkulainen, *NEAT* (2002);
Salimans et al., *Evolution Strategies as a Scalable Alternative to RL* (2017).

In-repo cross-references: `CLAUDE.md`'s "N-Dimensional Lookup Tables", "Local Variables",
"Overseer", "Graph-Rewriting Automata", "Bond-Graph Agents", "Rule Cadence" and "ALL-TARGET
DELIVERY" sections; [PLAN_ND_LOOKUP_TABLES.md](PLAN_ND_LOOKUP_TABLES.md) (the table
plumbing this design reuses); [PLAN_OVERSEER.md](PLAN_OVERSEER.md) (PR4 worker pool, PR5
EA sample — the training loop's home); [INVESTIGATION_SOCIAL_NETWORKS.md](INVESTIGATION_SOCIAL_NETWORKS.md)
(shape A's import target and the `maxBonds` ceiling §5.2 re-derives);
[INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md) §2.8 (ELLPACK).
