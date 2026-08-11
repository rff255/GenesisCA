# Plan — Parameterized Input Mappings

Implementation plan for the design in
[IMPACT_MAP_PARAM_INPUT_MAPPINGS.md](IMPACT_MAP_PARAM_INPUT_MAPPINGS.md). Illustrated mockup:
[PLAN_PARAM_INPUT_MAPPINGS.html](PLAN_PARAM_INPUT_MAPPINGS.html).

**Read the Impact Map first.** This document assumes its decisions (D1–D6) and its three
code-reality findings — in particular that **WebGPU has no input-mapping shader**, so the compile
surfaces are JS + WASM for cells and JS only for agents.

---

## §0 — Non-negotiable invariants (every phase)

1. **`check-compile-identity.mjs` is green across all 29 shipped models on every surface, at the
   end of every phase.** Not "explained", not "re-baselined" — **zero diffs**. The legacy branch of
   `inputParamsOf` exists precisely so this holds by construction.
2. **Nothing reads `mapping.parameters` directly** except the reducer and the editor. Everything
   else goes through `inputParamsOf`. `undefined` ≠ `[]`.
3. **Drop stale edges; never repoint them.** An edge whose port vanished is deleted or reported —
   never silently resolved to a neighbouring channel.
4. **No phase leaves a half-exposed feature.** After Phase 1 a user cannot yet *create* a
   parameterized mapping (no editor), so there is no window in which the feature is reachable but
   incomplete. Phase 1 is verified with a hand-authored fixture.
5. **`tsc -b` + `npm run build` clean before every commit.**
6. Linear history, one commit per phase (or per sub-phase), no version bump, no push.

---

## §1 — Phase sequence

| Phase | Scope | User-visible? | Split seam |
|---|---|---|---|
| **1** | Resolver + node ports + both cell compilers + worker ABI + brush panel | **No** (legacy renders exactly as today) | 1a compilers / 1b runtime+UI |
| **2** | The parameter editor + cascades + the agent side | **Yes** — the feature becomes reachable and consistent | — |
| **3** | Image-dialog channel→parameter + docs sweep | Yes | — |

Sized for 2–3 implementation sessions: Phase 1 is the long one (splittable at 1a/1b), Phases 2 and
3 are each comfortably one.

---

## PHASE 1 — Resolver, ports, compilers, worker, brush panel

**Goal:** the entire engine path works for parameterized mappings, verified against a hand-authored
fixture, with **zero** observable change for every shipped model.

### 1a — Schema, resolver, ports, compilers

**Files**

| File | Change |
|---|---|
| `src/model/types.ts` | `InputParamType`, `InputMappingParam`, `Mapping.parameters?` |
| **`src/model/inputMappingParams.ts`** *(NEW)* | `inputParamsOf`, `ResolvedChannel`, `buildInputParamPorts`, `channelDefaults`, `encodeParamValue`/`decodeParamValue`, `paramTagOptions` |
| `src/modeler/vpl/nodes/InputColorNode.ts` | `ports` shrinks to `do` (value outs become dynamic) |
| `src/modeler/vpl/nodes/AgentInputMappingNode.ts` | same |
| `src/modeler/vpl/effectivePorts.ts` | call `buildInputParamPorts` before the `hiddenPorts` filter |
| `src/modeler/vpl/CaNode.tsx` | same call, **identical concat order** |
| `src/modeler/vpl/nodes/nodeValidation.ts` | extend the `inputColor` / `agentInputMapping` cases |
| `src/modeler/vpl/compiler/danglingRefs.ts` | a consumer wired to an unknown channel port ⇒ NAMED error |
| `src/modeler/vpl/compiler/compile.ts` | the `inputColor` emit block (`:2208`) + the `agentInputMapping` emit block (`:2924`) |
| `src/modeler/vpl/compiler/wasm/compile.ts` | `EntryPointOpts` param types, `paramOutputs` → `LocalRef`, minted func type, the entry emit (`:7684`) |

**Order within 1a** (each step compiles and leaves identity green):

1. Schema + resolver + **the resolver's own unit assertions**. Nothing consumes it yet.
2. Node defs + the two port builders. Legacy resolves to `r`/`g`/`b`, so the canvas is unchanged —
   **verify by loading a shipped model with an input mapping** (`Extended Wireworld`,
   `gas_particles`, `snake`) and confirming the root still shows R/G/B and its wires are intact.
3. JS emit, both roots. Legacy branch emits the verbatim strings. → identity green.
4. WASM emit. Legacy keeps `TYPE_IDX_IDX_RGB` verbatim. → identity green.
5. `danglingRefs` + `nodeValidation`.

**The two `paramRefs` registration sites (`wasm/compile.ts:6886` and `:7107`) must change
together.** The second runs after the per-cell cache clear; missing it leaves a stale `I32`
`LocalRef` that reinterprets an f64 parameter's bits. Grep for `valtype: I32` inside the
`paramOutputs` blocks and confirm exactly two hits are edited.

**Verification gates (1a)**

- `node scripts/check-compile-identity.mjs --compare <baseline>` → **29/29 unchanged**.
- **`scripts/test-input-params.mjs`** *(NEW)* — checks 1, 2, 4, 5, 6 of Impact Map §15 half 2.
  Check 4 (an f64 parameter carrying `0.1` arrives as `0.1` through a **real instantiated WASM
  module**) is the one that catches the highest-risk defect; **write it first**.
- `tsc -b`, `npm run build`.

**Rollback:** every change is additive except the two node defs' `ports` arrays. Reverting the
commit restores them; no data has been written to any model file.

### 1b — Worker ABI + brush panel

**Files**

| File | Change |
|---|---|
| `src/simulator/engine/sim.worker.ts` | `PaintMsg` / `PaintAgentsColorMsg` → `values: number[]`; the two handlers' spreads |
| `src/simulator/SimulatorView.tsx` | 5 paint producers drop `r,g,b`; `flushPaintBatch` builds `values`; `flushAgentPaintBatch` likewise; the brush-panel fork; persistence |
| **`src/simulator/InputParamsPanel.tsx`** *(NEW)* | the per-parameter widget list |

**Order**

1. Worker message + handlers (both cell and agent). Legacy `values = [r,g,b]` ⇒ identical calls.
2. Producers + `flushPaintBatch`. The colour read moves from the producers to the flush (one read
   per stroke instead of five sites) — a simplification, and it also fixes a latent inconsistency
   where a mid-stroke colour change was captured per segment.
3. `InputParamsPanel` + the panel fork + the popover gating + persistence
   (`genesisca_input_params_v1:<modelName>`).

**Verification gates (1b)** — with a **hand-authored fixture** `public/models/…` or a
`preview_eval` file-input load (per the documented repro recipe):

- Legacy: paint on **JS**, **WASM**, **WebGPU** grid targets → identical cells to pre-change.
- Parameterized fixture: paint on all three → the authored attribute values, exactly.
- 3D paint via the brush plane (`__sim3dPaint`) on the fixture.
- Agent paint on JS / WASM / WebGPU agent targets (`__agentPaint`).
- Manual tab unaffected; Shift+RMB popover unchanged for legacy.
- `check-compile-identity` still 29/29 (the worker is not a compile surface, but the guard is free).

**Rollback:** the worker message shape is the only cross-boundary change; reverting both files
together restores it. No persisted data is invalidated (the new localStorage key is simply unread).

---

## PHASE 2 — The parameter editor, cascades, and the agent side

**Goal:** the feature becomes reachable, and cells + agents are consistent.

**Files**

| File | Change |
|---|---|
| `src/modeler/panels/MappingsPanelContent.tsx` | `InputParamsEditor` in the C→A detail editor (cell **and** agent); the three R/G/B textareas become A→C-only |
| `src/model/ModelContext.tsx` | `UPDATE_MAPPING` / `UPDATE_AGENT_MAPPING` prune edges for removed channels; **`patchAllEdges`** *(NEW)* |
| `src/simulator/SimulatorView.tsx` | agent brush panel → `InputParamsPanel` (replacing the bare colour input) |

**The new machinery to be careful about:** `patchAllEdges` — the sibling of `patchAllNodes`
(`ModelContext.tsx:93-108`). Nothing in the codebase currently prunes **edges** on a model edit;
`patchAllNodes` only rewrites node *configs*. It must fan across the same four stores
(`graphNodes`, `agentGraphNodes`, `overseerGraphNodes`, every `macroDefs[*]`) and preserve array
identity when nothing changed, exactly like its sibling — otherwise every mapping edit re-renders
every graph.

**The editor's own rules**

- `name` is renameable freely (ports keep their `key`-derived ids — **no wires move**).
- `key` is derived from `name` on **creation only**, sanitised to `[A-Za-z0-9_]`, and thereafter
  independent. Editing a `key` is offered as an explicit *"change identifier (breaks wires)"*
  action, not a text field — or is not offered at all in v1 (recommended: **not offered**; delete +
  re-add is the same operation, more honestly).
- Retyping `color` ⇄ scalar changes the channel count ⇒ the removed channels' edges are pruned.
- A per-parameter `description` replaces the three legacy channel textareas for C→A.

**Verification gates**

- Create a parameterized mapping through the real UI, wire its ports, paint → correct values.
- Delete a wired parameter → the edge is **gone**, no crash, no dangling badge on unrelated nodes.
- Rename a parameter → the wire **survives** and the port label updates.
- Retype `float` → `color` → three ports appear, `updateNodeInternals` fires (the port-signature
  effect), a connection to the new ports is accepted immediately (this is the exact bug that effect
  exists for).
- Cell and agent editors are the same component and behave identically.
- `check-compile-identity` 29/29; `parity-agent-wasm`, `test-agent-abi`, `verify-agent-render`.

**Rollback:** the editor is additive UI; `patchAllEdges` is only invoked from the two
`UPDATE_*_MAPPING` reducers. Reverting leaves models with `parameters` intact and readable by
Phase 1's engine — i.e. **a Phase 2 revert does not break a model authored under Phase 2**, only
the ability to edit its parameters.

---

## PHASE 3 — Image dialog channel→parameter, docs sweep

**Files**

| File | Change |
|---|---|
| `src/simulator/ImageMappingDialog.tsx` | the channel→parameter table (shown only for non-legacy mappings) |
| `src/simulator/SimulatorView.tsx` | `applyImageMapping` carries `channels` into `importImage` |
| `src/simulator/engine/sim.worker.ts` | `ImportImageMsg.channels?`; `applyImageCell` builds the values vector |
| `src/simulator/imageMapping.ts` | **NO CHANGE** (deliberate — see Impact Map §11) |
| `CLAUDE.md` | the input-mapping architecture section; **delete the false "inputColor shader" claim (line ~1576)** |
| `src/modeler/vpl/compiler/webgpu/compile.ts` | delete the same false claim in the `:3947` comment |
| `src/help/HelpView.tsx` | input mappings: parameters, the brush panel, the image step |
| `docs/NODES_REFERENCE.md` | `inputColor` + `agentInputMapping` port rows become "dynamic (per mapping parameters)" |
| `README.md` | only if the one-to-three-sentence feature summary changes |
| `src/simulator/showCode.ts` | the per-mapping section (`:819`, `:1185`) **and `:1192`, which asserts in prose that "the emitted function takes `(_r, _g, _b)` ahead of these"** — added by the Show Code commit `250e645`. Both must read the resolver. |

**Verification gates**

- Image import, **both** `resize` and paste-`center`, legacy → byte-identical result to pre-change.
- Parameterized: assign R→param A, `lum`→param B, const→param C; import; verify per-cell values.
- Presentation export → open the standalone `.html` → paint with a parameterized brush.
- Full gate sweep: `check-compile-identity`, `test-input-params`, `parity-agent-wasm`,
  `test-agent-abi`, `audit-agent-layout`, `verify-agent-render`, `check-agent-wasm-gate`,
  `tsc -b`, `npm run build`.

**Rollback:** each file is independently revertable; the `channels` field is optional, so an older
worker ignores it and takes the legacy path.

---

## §2 — The verification matrix (what proves what)

| Claim | Proven by |
|---|---|
| No shipped model changed | `check-compile-identity` 29/29, **every phase** |
| The WASM f64 channels are real | `test-input-params` check 4 — a real instantiated module in Node |
| JS ≡ WASM for parameterized mappings | `test-input-params` check 3 (bit-identical) |
| Agents behave like cells | `parity-agent-wasm` + the same fixture painted on all three agent targets |
| Deleting a parameter cannot silently mis-wire | `test-input-params` check 5 (named error) + the Phase 2 UI check |
| `[]` is not `undefined` | `test-input-params` check 6 |
| Paint works on the WebGPU grid target | real-UI check (readback → JS fn → `patchWebGPUCells`) |
| Image import unchanged for legacy | real-UI check, both modes |

**The one check to write first:** `test-input-params` check 4. It is the only gate that catches a
stale `valtype: I32` in `paramRefs`, which is the highest-risk silent defect in the whole change.

---

## §3 — Coordination note

**`src/simulator/showCode.ts` — resolved, but note what landed.** The concurrent Show Code
workstream committed `250e645` ("Show Code emits a port-ready model document") while this plan was
being written. It did not move the input-mapping block (`:819`, `:1185` are unchanged), but it
**added a new hardcoded assumption at `:1192`** — the prose line *"plus the brush colour: the
emitted function takes `(_r, _g, _b)` ahead of these."*

That line is now the **most user-visible** statement of the very assumption this feature abolishes:
Show Code's whole purpose after `250e645` is to be a *port-ready* document, so a parameterized
mapping that still claims `(_r, _g, _b)` would emit a document that does not describe the code it
sits next to. Phase 3 must rewrite it from the resolver — listing the channel names and, for a
`tag` parameter, the option→index table (which `250e645` already does for lookup tables, so the
convention exists).

Rebase rather than merge if that file moves again.
