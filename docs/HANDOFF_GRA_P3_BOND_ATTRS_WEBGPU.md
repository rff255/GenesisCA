# PHASE P3 — Bond attributes on the WebGPU agent target

**Read first**: [HANDOFF_GRAPH_REWRITING_AGENTS.md](HANDOFF_GRAPH_REWRITING_AGENTS.md)
§0 (invariants), §3 (verification recipes), §5 (Completion Report template).
Design authority: [IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md)
§3.6, §5, §6.1 (D3) · [PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) §P3.
**Predecessors' reports — read both**: [HANDOFF_GRA_P2_BOND_ATTRIBUTES.md](HANDOFF_GRA_P2_BOND_ATTRIBUTES.md)
(what exists on the CPU) and [HANDOFF_GRA_PX_WEBGPU_SYNC_ATTRS.md](HANDOFF_GRA_PX_WEBGPU_SYNC_ATTRS.md)
(**the read/write-base pattern you inherit**).

**State**: **DONE** (see the Completion Report) · **Depends on**: P2 (the CPU feature) + PX (the pattern) · **Blocks**: nothing

---

## 1. Goal

P2 shipped bond attributes on JS + WASM and made `isAgentGraphWebGPUSupported`
reject them at the **model level**. Lift that rejection by implementing bond
attributes on the GPU — subject to the one genuine hazard in §3.

---

## 2. What you inherit (do not re-derive)

**From PX — the settled pattern.** A second run set + a per-generation **commit
compute pass** (a same-buffer `copyBufferToBuffer` is a WebGPU validation error; the
L1 `posCommit` precedent). Aliased when async ⇒ an async model's shader stays
byte-identical. PX left you an `attrCommit` pass already wired into both the per-gen
path and (dead today, deliberately) the resident loop.

**From P2 — where the gate lives.** Two terms must be lifted **together**:
1. `isAgentGraphWebGPUSupported` rejects at the top on
   `bondAttrsOf(model).length > 0` (`agentWebgpu/compile.ts:3269`).
2. A matching hint arm in `PropertiesPanelContent` keyed on `model.bondAttributes?.length`.

**From P2 — why the gate is model-level, not node-level.** Form Bond grows one
initial-value input per bond attribute. A model could carry bond attributes and never
place a Get/Set node, yet still lose its Form Bond initial values on the GPU. So the
rejection cannot be per-node.

**The current GPU bond store.** Binding 11, `var<storage, read>` (**read-only**),
interleaved stride 2: `bondStore[idx*maxBonds*2 + k*2]` = partner (i32),
`+1` = rest length (f32 bits). `bondStoreLen = maxAgents * maxBonds * 2`.
`usesBondStore` gates the binding's **declaration** — Naga strips an unused storage
global and the bind group then mismatches the pipeline layout (a shipped bug).

---

## 3. THE DECISION you must resolve — `setBondAttribute` is a cross-agent write

**Do not discover this late; it is the crux of the phase.**

A bond is one object stored **twice** — in agent `i`'s row and in agent `p`'s row
(invariant **I2**, non-negotiable). So `setBondAttribute` necessarily writes a word
in **another thread's row**. That is structurally the same hazard the codebase
already gates:

```ts
// agentWebgpu/compile.ts:3361
const CROSS_AGENT_OVERWRITE = new Set(['setAgentAttribute','setAgentsAttribute','setAgentPosition','setAgentRadius']);
```

which the WebGPU gate rejects when reached from the behaviour graph with a wired,
non-spawn-handle id — because a sequential-order-dependent write cannot be honoured
by a parallel dispatch.

**The nuance that may rescue it.** If BOTH endpoints of a bond write it in the same
step, the two threads write the same words. Whether that is a bug depends on the
rule:
- **Symmetric rule** (the canonical SDCA link rule `λ' = ψ(λ, σᵢ, σⱼ)` **is**
  symmetric in `i,j`): both endpoints compute the *identical* value ⇒ the race is
  **benign**, the result is deterministic.
- **Asymmetric rule**: the endpoints compute different values ⇒ genuinely
  order-dependent, and CPU (sequential, index order) and GPU will disagree.
- **One-sided rule** (P2's D2 `ownerId` idiom — write only the bonds you own): only
  one thread writes ⇒ no race at all.

Symmetry is a **model** property, not a general one, so a gate cannot test it.

**Your job: measure, then choose, then state the choice.** Build a both-endpoints-
write model with an **asymmetric** rule and run it on real hardware. Then take one:

- **(A) Allow, and document.** `setBondAttribute` is supported on WebGPU; concurrent
  writes to the same bond from both endpoints are **order-undefined on WebGPU** —
  write from one side, or make the rule symmetric. Document in the node description,
  HelpView and CLAUDE.md.
- **(B) Gate it.** Add `setBondAttribute` to `CROSS_AGENT_OVERWRITE`, so a model that
  *writes* bond attributes in its behaviour clamps to WASM/JS while **reads and Form
  Bond initial values still run on the GPU**. Strictly consistent with the existing
  precedent.

**Recommendation: (A), if and only if your measurement shows the one-sided and
symmetric cases are exact and only the asymmetric case diverges** — because (B)
clamps SDCA (whose link rule writes every step) off the GPU entirely, and the
asymmetric case is already undefined-by-nature rather than newly broken. If the
measurement shows something worse — for example a torn or lost write even in the
one-sided case — take (B) and say so. **Either choice is acceptable if it is
measured and stated. An unmeasured choice is not.**

---

## 4. Scope — what you build

1. **Layout** — widen `bondStore` from stride 2 to `2 + N` through **one shared
   constant** (`BOND_STRIDE` or similar). **Never** a find-and-replace over the
   `* 2u` sites; there are several and a missed one reads the wrong lane silently.
   Add `bondAttrBase` / `bondAttrWriteBase` per the PX pattern, aliased when async.
2. **Binding** — promote binding 11 to `var<storage, read_write>` when bond
   attributes are present (decision **D3**), keeping `usesBondStore` gating the
   declaration.
3. **Emit** — `getBondAttribute` (scan the row for the partner, epoch-valid; **no
   bond ⇒ the attribute's default**, never garbage) and, per §3, `setBondAttribute`
   (both slots). Reads via the read base, writes via the write base.
4. **Form Bond initial values → the GPU request fields.** This is the reason the gate
   is model-level; it is easy to forget because no Get/Set node need be present.
5. **Commit** — fold the bond runs into PX's existing `attrCommit` pass if the
   regions are contiguous (widen the baked literals); otherwise a second pass. Say
   which.
6. **Runtime** — upload/readback the attribute lanes in `agentWebgpuRuntime.ts`.
7. **Lift the gate** — both terms from §2, together.

**Out of scope**: the request queue (P4), division partition (P5), residency
widening, `forEachBond` exposing attributes (P2 deferred it deliberately — its four
outputs are id-cached in three emitters).

---

## 5. Exit gate — all must pass, all recorded

| # | Criterion |
|---|---|
| **I2 on the GPU** | bond symmetry holds every generation of a 200-generation run — extend `verify-graph-rewrite`'s Tier for the GPU path, negative-controlled |
| **Cross-target agreement** | the same bond-attribute model on JS, WASM and WebGPU: **structural invariants I1–I4 hold exactly on all three**; values agree exactly for a one-sided rule (bond attributes are integer/tag/bool exactly, and float within f32) |
| **The §3 measurement** | recorded with numbers, and the decision (A) or (B) stated with its reasoning |
| **Async byte-identical** | `check-compile-identity --compare .gra-baseline/compile-identity-PX.json` — a model without bond attributes must be unchanged on every surface. Justify every diff. |
| Real GPU | `createShaderModule` 0 errors + 0 validation errors, 2D **and** 3D; a real in-browser run with 0 worker/GPU errors |
| Standard gates | tsc · build · `parity-agent-wasm` · `check-agent-wasm-gate` · `audit-agent-layout` · `test-agent-abi` · `verify-graph-rewrite` · `verify-agent-render` · `verify-render-uniform-layouts` |

**Verification traps** (both cost a predecessor a confusing run):
- The service worker runtime-caches model `.gcaproj` (StaleWhileRevalidate), so a
  browser probe fetching a file you just edited gets the **pre-edit** copy. Use
  `fetch(url + '?t=' + Date.now(), { cache: 'reload' })`.
- The Browser pane may report hidden ⇒ Play auto-pauses. Drive the worker directly
  (`window.__simWorker.postMessage({type:'step', count:N})`). `getState.agents.*`
  ships **Float64**; only the render snapshot is f32.

---

## 6. Assumptions to check FIRST (stop and report if any is false)

1. **PX's `attrCommit` pass exists and is wired into the per-gen path**, and its
   read/write-base accessor is the single point through which attribute access flows.
   If PX took a different design than its report states, re-read before building on it.
2. **The bond store's stride-2 literal is confined to a small, findable set of sites.**
   If it is scattered beyond a handful, say so before widening — a missed site is a
   silent wrong-lane read.
3. **`usesBondStore` genuinely gates the binding declaration** (the Naga strip trap).

---

## Completion Report — P3

**State**: **DONE**

**Commit(s)**: `c7d2de0` — `feat(agents): bond attributes on the WebGPU agent target`

**Files touched**

```
 CLAUDE.md                                        (the P3 section + the P2 gate paragraph corrected)
 README.md                                        (the bond-attributes bullet: all three targets + the caveat)
 docs/NODES_REFERENCE.md                          (scope note + rows 121/122)
 docs/HANDOFF_GRAPH_REWRITING_AGENTS.md           (Status Board)
 src/help/HelpView.tsx                            (Bond Attributes: all three targets + the order-undefined caveat)
 src/modeler/panels/PropertiesPanelContent.tsx    (BOTH gate-hint arms lifted, together)
 src/modeler/vpl/nodes/SetBondAttributeNode.ts    (description + the doc comment: the WebGPU caveat)
 src/modeler/vpl/compiler/agentWebgpu/layout.ts   (bondSlotStride/bondSlotStrideOf, bondAttrIds/Word/IsFloat, bondFormAttrBase, extras.bondAttrs)
 src/modeler/vpl/compiler/agentWebgpu/compile.ts  (the 3 bond helpers + 3 rewired sites, get/setBondAttribute, Form Bond's request runs, usesBondStoreWrite, the read_write binding, AGENT_VALUE_NO_HOIST, extras, the GATE LIFT)
 src/modeler/vpl/compiler/compile.ts              (dynamic INLINE-widget port resolution — the JS-only Form Bond defect)
 src/simulator/engine/agentWebgpuRuntime.ts       (stride-aware upload + readbackAgentBondStore + the form-attr runs + buffer usage / bind-group type)
 src/simulator/engine/sim.worker.ts               (the bond-store readback before the structural phase + the usage flag)
 src/simulator/SimulatorView.tsx                  (usesBondStoreWrite threaded to the worker)
 scripts/verify-graph-rewrite.mjs                 (TIER F — 29 checks + a mutation negative control; Tier D's gate assertion flipped)
 .gra-baseline/compile-identity-P3.json           (the baseline for P4)
```

### What shipped

1. **The bondStore slot widened from `[partner, restBits]` to `[partner, restBits, ...attrs]`** through **ONE** stride definition — `AgentWebGPULayout.bondSlotStride` (+ the exported `bondSlotStrideOf`). All three pre-existing bond emitters (Get Curvature / Get Bonded Agents / For Each Bond) now index through `bondRowBaseExpr` + `bondSlotWord`; there is no stride literal anywhere else. `bondAttrWord[id] = 2+i`, `bondAttrIsFloat[id]` (float ⇒ f32 bits, exactly like restLength; bool/integer/tag ⇒ a plain i32 word, mirroring the CPU `bondAttrKind`).
2. **`getBondAttribute` / `setBondAttribute` WGSL emitters.** Get scans the live bond row for the partner (the same membership rule For Each Bond uses) and reads the slot word; **no such bond ⇒ the attribute's default**, via a bounds-clamped index because WGSL `select` evaluates both arms. Set writes **BOTH** rows (I2), the partner one range+alive guarded.
3. **Binding 11 is promoted to `read_write` only when a Set emitter ran** (`ctx.usesBondStoreWrite`, decision **D3**), threaded to the runtime so the bind-group entry becomes `storage` and the buffer gains COPY_SRC. `usesBondStore` still gates the DECLARATION (the Naga strip trap). A read-only bond model keeps the pre-P3 `read` binding.
4. **Form Bond's initial values reach the GPU** through one per-agent f32 request run per bond attribute (`bondFormAttrBase`, the sibling of `bondFormL`/`bondFormK`), appended AFTER every other f32 run so all pre-P3 bases stay byte-stable, and read back into `s.bondFormAttrs`. This is the reason P2's gate had to be model-level.
5. **Runtime round-trip**: `uploadAgentBondStore` widened to write the attribute lanes; new **`readbackAgentBondStore`** copies ONLY the attribute words back (partner/restLength are CPU-owned), and it runs **before `runAgentStructuralPhase`** so a bond broken this step drops its values with its slot.
6. **BOTH gate terms lifted together** — the model-level `bondAttrsOf(model).length > 0` reject and the `PropertiesPanelContent` hint arm; the supported hint gains the order-undefined caveat when the model declares bond attributes.

### Decisions resolved

| ID | Decision taken | Why |
|---|---|---|
| **D3** (the §3 crux) | **(A) ALLOW + document.** `setBondAttribute` runs on WebGPU; concurrent writes to the same bond from BOTH endpoints in one step are **order-undefined there**. | Measured (table below): the **one-sided** and **symmetric** idioms — the only ones P2's D2 permits — are **exact** on the GPU, structurally and by value. Only the **asymmetric** case diverges, and that case is *already* invalid on every target (D2: "a genuinely asymmetric bond attribute is impossible without breaking I2"). Option (B) would have added `setBondAttribute` to `CROSS_AGENT_OVERWRITE`, clamping every bond-attribute-WRITING model off the GPU — i.e. essentially every GRA rule, since an SDCA link rule writes every step. Documented in the node description, HelpView, the Properties hint and CLAUDE.md. |
| Bond attributes are **SINGLE-buffered** on the GPU — **PX's read/write-base pattern is deliberately NOT copied** | The CPU targets are single-buffered *by P2's explicit design*, even under `agentUpdateMode: 'sync'` ([agentEngine.ts](../src/simulator/engine/agentEngine.ts): "a bond is one object stored twice, so a write goes to BOTH slots — there is no read/write double buffer to keep in step"). Adding a GPU write region + commit pass would have made a sync model's GPU result **deterministically differ from its CPU result** — a NEW cross-target divergence, and cross-target agreement is an explicit exit gate. Handoff §4.1's prescription is therefore not followed to the letter; the reasoning is recorded here rather than STOPping, since it is *less* structure and the option that satisfies the gate. Safe because a bonded model is never residency-eligible (`agentResidentEligible` requires `s.maxBonds === 0`), so the bond store round-trips every generation. **Follow-up for the orchestrator**: true *synchronous* bond semantics would need a CPU double buffer too — an all-three-targets change, not a GPU one. |
| Attribute words live INSIDE the bond slot (stride 2+N) rather than in a separate parallel region | Keeps ONE stride and ONE base expression, so the compaction-free GPU indexing is a single arithmetic form the harness can check exhaustively; a parallel region would double the index shapes an emitter must get right. |

### Assumptions that proved FALSE

**None of the three §6 assumptions.** All held:

1. **PX's `attrCommit` pass exists and is wired** into `dispatchAgentStep` (agentWebgpuRuntime.ts:1125) *and* `dispatchResidentBatch` (:2703), built only under `layout.syncAttrs`, and `attrAt(ctx, attr, idx, 'read'|'write')` is the single accessor. (P3 does not extend it — see the single-buffer decision above.)
2. **The stride-2 literal was confined to a small findable set**: three emit sites (`emitGetCurvature`, `emitGetBondedAgents`, `emitForEachBond`), one layout line, one runtime upload. All five now derive from `bondSlotStride`.
3. **`usesBondStore` genuinely gates the binding declaration** (`hasBondStore = ctx.usesBondStore && layout.bondStoreLen > 0`), and the runtime mirrors it.

**One PRE-EXISTING (P2) defect found and fixed** — a JS-only divergence, not an assumption failure:
- Form Bond's per-bond-attribute **INLINE widget** values were silently dropped on the **JS** target. `compileFlowChain`'s generic branch resolved inline values from `def.ports` (STATIC only) and wired dynamic ports from the edge map, so a DYNAMIC port with an inline widget and NO wire fell through entirely and the node used the attribute default. WASM/WebGPU read `_port_*` straight from config and were correct. **Measured**: with `_port_bondAttr_lbl: '5'`, JS read `lbl = 0` while WASM and WebGPU read `5`. Fixed in [compile.ts](../src/modeler/vpl/compiler/compile.ts) by also resolving `buildBondAttrPorts(nodeType, model).inputs` — the ONE editor port builder, so the compiler cannot drift from what the canvas draws. Byte-identity unaffected (no shipped model declares bond attributes). ⚠️ The general rule: **a dynamic input port with an inline widget needs an explicit resolution path in the JS compiler**; only `formBond` has one today, and `switch`'s dynamic value ports have their own branch.

### THE §3 MEASUREMENT

Real GPU, real worker, `agentUpdateMode: 'sync'`, agents-only ring topologies built by auto-bond (32 agents / 32 edges; a 512-agent variant for the asymmetric case), 4 trials each. `agentTarget` confirmed `webgpu` with `agentRuntimeReady: true` and the on-screen chip reading `agents WebGPU` — not a JS fallback.

| rule shape | CPU (JS ≡ WASM) | WebGPU | I2 on the GPU |
|---|---|---|---|
| **one-sided** — only `partnerId > Get Self Handle` writes; `w += 1` each gen | `w == 10` on all 32 edges | **identical: 0 of 32 edges differ** | **holds** (0 tears) |
| **symmetric** — both endpoints write `seed_i + seed_p` | correct (1, 31, 3, 5, …) | **identical: 0 of 32 differ, on 3 consecutive trials** | **holds** |
| **asymmetric** — both endpoints write their OWN handle | `max(i,p)` on every edge (the last writer in index order); JS ≡ WASM | **30 of 32 edges differ** (and **510 of 512** on the large variant): the LOWER id wins; **2 edges TEAR I2** (the bond's two slots disagree) | **VIOLATED on 2 edges** |
| **Form Bond initial values** (wired + inline) | correct | **identical** | holds |
| **integer lane** (Set Bond Attribute on the `lbl` integer attribute) | `lbl == 7`, float lane untouched at 0 | **identical**, integer-typed | holds |

Notes: the GPU outcome was *stable across trials on this device* at both N=32 and N=512 — a driver/scheduling artifact, **not a guarantee**; WebGPU orders nothing between invocations. The tear is the finding the handoff's "something worse" clause asks about, but it occurs **only in the asymmetric case**, never in the one-sided one — so per §3's own criterion, **(A)** stands.

### Verification

| Gate | Result |
|---|---|
| tsc / build | ✓ `npx tsc -p tsconfig.app.json --noEmit` clean · `npm run build` clean (42 precache entries) |
| parity-agent-wasm | ✓ ALL AGENT SAMPLES: JS↔WASM BIT-PARITY (every entry + every synthetic, incl. `[synthetic] Bond attributes`) |
| check-agent-wasm-gate | ✓ every sample `GATE✓ COMPILE✓ INST✓` |
| audit-agent-layout / test-agent-abi | ✓ 156 checks, all 4 CPU sites in lockstep · ✓ 28 ABI tests |
| check-compile-identity | ✓ vs `.gra-baseline/compile-identity-PX.json` — **26 models, all surfaces unchanged** (no shipped model declares bond attributes ⇒ stride stays 2 ⇒ the emitted WGSL is verbatim). P3 baseline captured for P4. |
| verify-graph-rewrite | ✓ **135 passed, 0 failed** (106 → 135; the new **Tier F**), Tier D's gate assertion flipped to "WebGPU ACCEPTS" |
| Others | ✓ parity-agent-force (7) · verify-agent-render · verify-render-uniform-layouts · test-bonds-allocation (16) · test-agent-capabilities (75) · audit-modelattr-layout (18) · test-cross-agent-writes |
| Real in-browser run | see below |

**Tier F** (shader + layout level, since node has no GPU): the layout arithmetic (stride, word indices, `bondStoreLen`, the request runs appended LAST, the SoA growing by exactly one run per attribute); **stride consistency over the WHOLE emitted shader** with a **MUTATION negative control** — forcing `bondSlotStride` back to 2 while the attribute words still say 2/3 is CAUGHT (the exact wrong-lane risk the handoff names); a no-bond-attribute model emitting the pre-P3 `* 2u` form; the `read_write` promotion + **exactly two** bond-store writes per Set (own row + partner row anchored on `== i32(idx)`) = **I2 at the shader level**; the alive+range guard; Form Bond's per-attribute request writes; a read-ONLY model keeping the `read` binding and NOT asking for a writable store; 3D (stride 4, consistent); bonds=off (no store, no words).

**Real GPU / real worker** (0 console errors and 0 worker/GPU errors across every session):
- **I2 over 200 generations on WebGPU, with mid-run CHURN**: two bonds broken at generations 50, 51 and 120 (so the CPU compaction interleaves with the GPU readback) — **I1/I2/I3/I4 green at EVERY one of the 200 generations**, 0 value errors, edge count 32 → 30 → back to 32 as auto-bond re-formed them.
- **Cross-target agreement, 2D**: JS ≡ WASM ≡ WebGPU with **0 differing edges of 32** on the one-sided model, the symmetric model (3 GPU trials), the Form-Bond-initial-values model, and the integer-lane variant.
- **Cross-target agreement, 3D** (the same ring in a `dimension: '3d'`, depth-8 world): JS ≡ WASM ≡ WebGPU, 0 differing of 32, 0 invariant errors — the 3D shader path compiles and runs with stride 4.
- **Regression smoke on shipped bonded WebGPU models**: `Morphogenesis - Growing Tissue` grows 12 → 24 agents with 36 bond edges and 0 invariant errors and **zero bond-attribute lanes** (unchanged); `Life on Bonds` reaches 4096 edges with **every one of its 1024 agents at degree 8** and 0 invariant errors.

### Invariants

| ID | Held? | Evidence |
|---|---|---|
| **I1** handshake | **YES** | `Σ bondCount == 2 × distinct bonds` at every one of the 200 GPU generations (with breaks + re-forms), and on every cross-target run (2D + 3D). Tier A/C/D unchanged and green. |
| **I2** symmetry | **YES for every VALID rule shape** (one-sided, symmetric, Form Bond) — 200 GPU generations with churn, 0 tears; the higher-id endpoint reads back what the lower one wrote. **Deliberately NOT guaranteed for an ASYMMETRIC both-endpoints write on WebGPU** (2 of 32 edges torn — measured, decided, documented; that shape already contradicts P2's D2 on every target). Tier F pins the two-row write at the shader level; Tier D's engine-level negative controls unchanged. |
| **I3** no dangling | **YES** | Every generation of the 200-gen GPU run (which breaks bonds mid-run) and every cross-target run. |
| **I4** capacity | **YES** | Every generation of the same runs (`maxBonds` 4). |
| **I5** atomicity | *n/a in P3* | P3 raises no structural requests of its own. Form Bond's both-sides-or-neither rule is unchanged and its attribute values ride it (a rejected form writes no attribute either). Arrives properly with P4. |

### Known gaps / follow-ups for the next phase

1. **True SYNCHRONOUS bond-attribute semantics are an ALL-THREE-TARGETS change, not a GPU one.** Bond attributes are single-buffered on every target, so a rule that reads a bond attribute another agent writes in the SAME step is sequential-order-dependent on the CPU and order-undefined on the GPU. If the milestone wants a genuinely simultaneous link rule (`λ' = ψ(λ, σᵢ, σⱼ)` reading the PREVIOUS `λ`), the CPU store needs a `bondAttrsWrite` + a swap mirroring `attrRead`/`attrWrite`, and only then does a GPU write region make sense. **Do not schedule the GPU half alone.**
2. **`setBondAttribute` is deliberately NOT in `CROSS_AGENT_OVERWRITE`.** If a future phase adds a general "this write races" gate, remember that bond writes are exempt BY DECISION (A), with the reasoning above — re-litigate it with a measurement, not by pattern-matching the node shape.
3. **`forEachBond` still does not expose bond attributes** (P2 deferred it; its four outputs are id-cached in three emitters — now including this one, `ctx.forEachBondStack`). Get Bond Attribute inside the body covers it.
4. **No shipped sample declares bond attributes**, so `check-compile-identity` proves only that nothing regressed — the feature itself is covered by Tier D/F + the parity synthetic + the throwaway browser models (generated, measured, deleted). **P7 should ship an SDCA sample**, which would be the first real coverage; write its link rule **symmetric or one-sided** so it is exact on WebGPU.
5. **The JS dynamic-inline-port fix is general infrastructure.** Any future node with dynamic input ports carrying inline widgets must be added to that resolution (today it resolves `buildBondAttrPorts`); the symptom of missing it is silent per-target divergence, not an error.
