# Impact Map — Parameterized Input Mappings (declared parameters replace hardcoded R/G/B)

## Context

An **Input Mapping (C→A)** is the graph that runs when the user paints. Today its entire
interface to the outside world is three hardcoded integer outputs — `r`, `g`, `b` — fed by a
colour picker. The user's decision:

> *"We must abolish the assumption that input mappings will have r,g,b."*

Each input mapping should declare its **own named parameter list** (name + type, drawn from the
existing attribute type vocabulary). Each parameter becomes an output port on the mapping's event
root; the brush panel renders one type-adaptive widget per parameter. A brush that stamps
`species = Predator, energy = 40, hungry = true` should say exactly that, not encode it in a
colour the graph has to decode.

Three further constraints from the same decision:

- **Image import keeps working, and gains a channel→parameter step.** *"Image importing is already
  solved in another way, and we could adjust the image mapping to map the R,G,B of the pixels onto
  parameters of a chosen input mapping if the user wishes so."*
- **Cells and agents must end up CONSISTENT.** The agent side (`agentInputMapping`) landed one
  commit ago (`0a19905`) with the same hardcoded R/G/B; it is reshaped by the same change.
- **Brush-geometry outputs are v2, explicitly out of scope** (see §Follow-ups).

This is NOT an implementation plan — it is the precondition to one. One section per subsystem.

---

## CODE-REALITY FINDINGS THAT CONTRADICT THE DESIGN BRIEF

Three assumptions in the framing turned out to be false. Each changes the scope.

### 1. There is NO WebGPU input-mapping shader. The cell surface count is TWO, not three.

Searched exhaustively: `inputColor` appears **twice** in `src/modeler/vpl/compiler/webgpu/`, and
**zero** times in `src/simulator/engine/webgpuRuntime.ts`. Both hits are non-emitting — an error
guard (`webgpu/compile.ts:3302`, *"entry-point node has no value emit"*) and a stale comment. The
WGSL emit loop (`webgpu/compile.ts:4110-4188`) produces exactly `step`, `init`, and
`outputMapping_<id>`; `WebGPUEntryPoints` has only those three fields. The compiler's own header
says so:

> *"InputColor (paint) stays on the JS path — per-click workload too small to amortise GPU dispatch."*

On the WebGPU target a paint is: `readbackAttrs` → the **JS** `inputColor` fn on the CPU →
`patchWebGPUCells(idxs)` → colour pass. (WASM and WebGPU are mutually exclusive, so on the WebGPU
target the JS fn is *always* the one that runs — `sim.worker.ts:7344`.)

⇒ **The all-target obligation for this feature is JS + WASM, plus an unchanged CPU-patch path on
WebGPU.** Nothing WGSL is written, read, or verified by this work.

*(Two stale claims to fix while here: `webgpu/compile.ts:3947` and `CLAUDE.md:1576` both list
"inputColor" among the entry-point shaders. Neither is true.)*

### 2. The JS and WASM input ABIs have DIFFERENT shapes and DIFFERENT argument orders.

| target | signature | source |
|---|---|---|
| JS | `(_r, _g, _b, idx, total, W, H[, D, WH], r_*…, w_*…, …)` — **colour LEADS** | `compile.ts:2231` |
| WASM | `inputColor_<sanitisedId>(i32 idx, i32 r, i32 g, i32 b)` — **`idx` LEADS**, all four i32 | `wasm/compile.ts:7703` + `TYPE_IDX_IDX_RGB` |

The JS colour params are prepended at the emit site and are *not* part of `buildCellParams`; the
worker spreads them in front (`icEntry.fn(c.r, c.g, c.b, ...buildCellArgs(idx))`). WASM resolves
r/g/b through `paramRefs` — a `{portId → LocalRef}` map seeded from
`paramOutputs: { r: 1, g: 2, b: 3 }` with `numParams: 4`, documented as *"Number of **i32** params"*.

⇒ Two independent ABI generalisations, not one. And the WASM one has a **type problem**: a `float`
parameter cannot be i32. See §Subsystem 5.

### 3. The paint payload's per-cell `r,g,b` is already uniform in practice — and `paintAgentsColor`
is already message-level.

`PaintMsg.cells` is `Array<{row, col, layer?, r, g, b}>`, but **all five producers** read the same
`brushColorRef.current` once per stroke segment (`SimulatorView.tsx` 8179, 10580, 10647, 10713 +
the shared `brushCellsAt`). There is exactly **one** `type: 'paint'` producer in the codebase
(`SimulatorView.tsx:10542`). Per-cell colour is dead generality.

Meanwhile the agent twin already got this right: `paintAgentsColor { ids, r, g, b, mappingId,
activeViewer }` — **message-level**, per-stroke.

⇒ The parameterized payload should be **message-level `values: number[]`**, which makes the cell
and agent messages structurally identical (constraint 4) and *removes* an allocation per painted
cell. Per-pixel variation stays where it belongs: `importImage`.

---

## The governing safety principle

> **`parameters` absent ⇒ the LEGACY colour mapping ⇒ byte-identical emit on every surface.**

`Mapping.parameters` is optional. A resolver mints, for an absent list, exactly one parameter whose
**port ids are `r`, `g`, `b`** and whose **ABI names are `_r`, `_g`, `_b`** (JS) / **param indices
1, 2, 3 as i32** (WASM). Every downstream consumer reads the resolver's output and never
re-derives. Legacy models therefore keep:

- their exact `.gcaproj` bytes (no field written),
- their exact edge handles (`output_value_r` — `handleId()` is `${kind}_${category}_${id}`),
- their exact emitted JS string and their exact WASM function type + body.

This is the same additive-optional discipline as `coords3d`, `agentCapabilities`, `vectorDims`,
`ruleDescription` — and the same *"Option A"* byte-identity-by-construction gate the RGBA milestone
used.

### ⚠ The sharp edge: `undefined` ≠ `[]`

`parameters: undefined` means **legacy colour**. `parameters: []` means **explicitly no
parameters** (a stamp that ignores the brush entirely — a legitimate thing to author). Any
`mapping.parameters?.length ? … : legacy` test silently mis-classifies `[]` as legacy.

**Mitigation:** the distinction is made in **exactly one place** — the resolver — and nothing else
is allowed to read `mapping.parameters` directly. A grep for `\.parameters` outside
`inputMappingParams.ts` should return only the reducer and the editor. This is the
`resolveMaxBonds` / `resolveAxes` / `agentAbiShapeOf` discipline.

---

## THE RESOLVED DECISIONS

### D1 — Resolver, not migration. **RESOLVER.**

| | Resolver (`inputParamsOf(mapping)`) | One-shot LOAD_MODEL migration |
|---|---|---|
| Byte-identity of emit | by construction (legacy branch emits verbatim strings) | achievable, but only if the migrated param reproduces `r`/`g`/`b` exactly — the same care, with a live file rewrite behind it |
| `.gcaproj` on load→save | unchanged | **every shipped model gains a `parameters` block on the next save** |
| load→save→load fixed point | trivially holds | holds, but the first save is a one-way rewrite |
| Precedent | `resolveMaxBonds`, `resolveAxes`, `bondAttrsOf`, `agentAttrsOf`, `resolveAgentFieldGates`, `layoutIterationsOf`, `effectiveAgentDt`, `collisionMode` | `migrateAgentCapabilities`, `migrateEngineField` (both used where a value must be *inferred*, not defaulted) |
| Downstream code paths | one (the resolver's output) | one |

The migrations in this codebase exist where the correct value must be **inferred from usage** and
cannot be re-derived cheaply (capability profiles, the engine field). Here the correct value is a
**constant** — "the legacy colour parameter" — so a resolver is strictly better: same single code
path, no file rewrite, no risk of a migration that produces a *nearly*-legacy parameter.

**Decision: `src/model/inputMappingParams.ts`, exporting `inputParamsOf(mapping)`.** No migration,
no schema version bump.

### D2 — The `color` parameter type: THREE channel ports, not a composite `color` port.

Two candidate shapes for a parameter of type `color`:

- **(a) one composite port** with `dataType: 'color'`, decomposed by a `Break Color` node.
- **(b) three integer channel ports** `<key>_r` / `<key>_g` / `<key>_b`.

**(b), for three reasons:**

1. **The legacy default must expose ports named exactly `r`, `g`, `b`** — otherwise every existing
   wire's `sourceHandle` (`output_value_r`) dangles. Under (b) the legacy param is simply a `color`
   param whose channel ids are the un-prefixed `r`/`g`/`b`; under (a) the legacy shape would have
   to be special-cased *anyway*, and differently from every user-added colour.
2. **A composite output on an EVENT ROOT is a new producer kind for `expandComposites`.** That pass
   resolves composite values by walking back to real scalar sources (`vecComponentsOf` /
   `scalarSourceOf`) through `makeColor` / `breakColor` / `vectorOp`. An entry-point root that
   *originates* a composite is not in its vocabulary. Adding it is real work in a pass every model
   runs, for no gain here.
3. **The ABI is a flat list of numbers either way.** A composite port would be lowered to three
   scalars before reaching any emitter, so (a) buys nothing at the engine and costs a lowering.

This gives the load-bearing abstraction of the whole design:

> **A parameter has N CHANNELS. `color` → 3; every other type → 1. The port list, the ABI argument
> list, and the `values` payload are all the flat channel list, in declared order.**

Legacy = one `color` parameter = three channels = `[r, g, b]` = today, exactly.

**A user-added colour parameter named `tint` yields ports `tint_r` / `tint_g` / `tint_b`.** The
brush panel still shows it as ONE `ColorField` (the checkerboard swatch + popover already built for
the RGBA milestone) — the channel split is an engine detail, not a UI one.

### D3 — What a NEW C→A mapping defaults to: **the legacy colour parameter (i.e. write nothing).**

`ADD_MAPPING(false)` / `ADD_AGENT_MAPPING(false)` keep seeding **no** `parameters` field. A new
mapping is therefore the familiar colour brush, and the parameter editor opens showing one row —
`Brush colour · Colour` — which the user can rename, retype, or extend.

Rejected alternative: seeding `parameters: [{key:'color', …}]` explicitly. It makes every new model
carry the block (so a "did the user touch parameters?" question becomes unanswerable), and it
creates a second representation of the same thing — precisely what D1's single-resolver rule
exists to prevent.

Rejected alternative: an empty list + an editor prompt. It breaks the *"a new mapping behaves like
the old one"* expectation for the overwhelmingly common case, and makes the first paint a no-op.

### D4 — WASM: emit parameterized entries too (do NOT clamp to JS).

The tempting shortcut is to emit only legacy mappings on WASM and let parameterized ones fall
through to the JS fn — the worker's per-mapping fallback **already exists and already works**
(`wasmInputColorFns[key]` missing ⇒ `wasmIcFn = null` ⇒ the JS branch runs), and the agent side is
JS-on-CPU on every target by design.

It is still the wrong call, for one measured reason: **`importImage` runs the input-mapping
function once per cell over the WHOLE grid** (`sim.worker.ts:8278` — `for (let idx = 0; idx <
total; idx++)`). At 5000² that is 25 M invocations. Paint is event tempo; **image import is not**.
Clamping parameterized mappings to JS would make "use a named parameter instead of the green
channel" a silent 25 M-call performance cliff on the WASM target — textbook
`CLAUDE.md` partial-delivery anti-pattern.

**Decision: parameterized mappings emit a WASM entry with the signature
`(i32 idx, f64 c0, f64 c1, … f64 cN)`** — one f64 per CHANNEL, minted as a fresh function type per
arity. Legacy keeps `TYPE_IDX_IDX_RGB` = `(i32,i32,i32,i32)` verbatim.

**Why f64 for every channel rather than per-type i32/f64:** `EntryPointOpts.numParams` is
documented as *"Number of **i32** params"* and `paramRefs` seeds `valtype: I32` unconditionally. A
mixed-type signature means threading a valtype list through both. A uniform-f64 convention needs
one list of arities, matches the agent ABI (f64 throughout) and the JS ABI (untyped numbers), and
is exact for every integer/bool/tag value we can produce (all ≤ 2⁵³). The existing `pushValueAs`
machinery already converts f64→i32 where a consumer wants an integer.

**Escape hatch, if measurement says the WASM work is disproportionate:** the JS fallback is one
line of *absence* (don't emit the export) and is already exercised. It can be taken as a documented
temporary state — but only with the image-import cost stated in the release note, never silently.

### D5 — The worker payload: message-level `values: number[]`, ordered by CHANNEL.

```ts
interface PaintMsg { type:'paint'; cells:Array<{row;col;layer?}>; mappingId; values:number[]; activeViewer }
interface PaintAgentsColorMsg { type:'paintAgentsColor'; ids:number[]; mappingId; values:number[]; activeViewer }
```

Legacy resolves to `values: [r, g, b]`, so the two handlers keep calling
`fn(...values, ...buildCellArgs(idx))` / `wasmFn(idx, ...values)` and the emitted code is unchanged.
Per-cell `r,g,b` is deleted (dead generality — finding 3), which shrinks the per-cell payload.

This also makes the cell and agent messages **structurally identical** — the user's consistency
requirement, satisfied in the protocol and not just the UI.

### D6 — Parameter VALUE persistence: reuse the Manual-Brush precedent, do not widen `SimulationState`.

Today: `brushColor` is persisted in `genesisca_sim_settings` **and** serialized into
`SimulationState` (`types.ts:719-728`, written by `serializeSimState` under `wantControls`,
restored at `SimulatorView.tsx:12448`). Manual-brush per-attribute values are persisted **only** in
a per-model localStorage key `genesisca_manual_brush_v1:<modelName>` and are **never** in
`.gcastate` or presets.

**Decision:**
- The **legacy** colour parameter's value continues to live in `brushColor` — unchanged, so every
  existing `.gcastate` and every "Save with simulator controls" keeps round-tripping.
- **Declared** parameter values live in a new per-model key
  `genesisca_input_params_v1:<modelName>` → `Record<mappingId, Record<channelId, string>>`,
  mirroring the manual brush exactly. **No `SimulationState` field, no `fileOperations` change.**

Rationale: parameter values are per-user brush state (like the manual brush), not model state; and
widening `SimulationState` would require a shape whose keys are mapping-and-parameter-specific,
which cannot be validated on load against a *different* model.

---

## Subsystem 1 — Schema (`src/model/types.ts`)

```ts
export type InputParamType = 'bool' | 'integer' | 'float' | 'tag' | 'color';

export interface InputMappingParam {
  /** Stable identifier. Port ids + ABI names derive from it; NEVER renamed by a display rename. */
  key: string;
  /** User-facing label (ports, brush rows, image channel picker). */
  name: string;
  type: InputParamType;
  description?: string;
  /** Canonical string encoding, identical to `Attribute.defaultValue`. */
  defaultValue?: string;
  /** tag only — the option list. Either inline options … */
  tagOptions?: string[];
  /** … or borrowed live from an existing tag attribute (cell OR agent, per the
   *  `resolveKeyLabels` precedent). Takes precedence over `tagOptions`. */
  tagAttributeId?: string;
  /** integer/float only — brush-widget bounds (a slider appears when both are set,
   *  mirroring the model-attribute convention). NOT clamped by the engine. */
  min?: number;
  max?: number;
}

export interface Mapping {
  …
  /** Color→Attribute only. ABSENT ⇒ the legacy single `color` parameter whose
   *  ports are exactly r/g/b (see inputMappingParams.ts). EMPTY ⇒ deliberately
   *  no parameters. The two are DIFFERENT — always go through inputParamsOf(). */
  parameters?: InputMappingParam[];
}
```

**`key` vs `name` is load-bearing.** Ports and ABI names derive from `key`; the editor renames
`name` freely without touching a single wire. A `key` change is a destructive operation (see
Subsystem 12).

**Not reused: `Attribute`.** It carries ~20 fields meaningless here (`isModelAttribute`,
`parentAttributeId`, `agentAccess`, `tableData`, `vectorDims`…) and its `AttributeType` includes
`neighborIndex` / `lookupTable` / `vector`, none of which a brush can supply. A narrow type is the
honest one. (`vector` is a plausible future addition — it lowers to 2–3 channels exactly like
`color` — but it is not in scope.)

**Serialization:** `stringifyCompact` filters `undefined` properties, so a legacy mapping writes
nothing. Arrays of objects round-trip. **No migration, no schema version bump.**

- **Risk:** LOW. Purely additive.

---

## Subsystem 2 — The resolver (`src/model/inputMappingParams.ts`) — NEW, the single source of truth

```ts
export interface ResolvedChannel {
  paramKey: string;          // owning parameter
  /** Port id AND edge-handle suffix. Legacy: 'r' | 'g' | 'b'. */
  portId: string;
  /** JS ABI identifier. Legacy: '_r' | '_g' | '_b'. */
  argName: string;
  label: string;             // port label, e.g. 'Energy' or 'Tint R'
  dataType: 'integer' | 'float' | 'bool';   // the PORT's declared type
}
export interface ResolvedInputParams {
  /** TRUE only when `mapping.parameters` was absent. Drives every byte-identity branch. */
  legacy: boolean;
  params: ResolvedParam[];   // each with its own channels[]
  channels: ResolvedChannel[];  // the FLAT list — ports, ABI, values payload all iterate THIS
}
export function inputParamsOf(mapping: Mapping | undefined): ResolvedInputParams;
```

Companion pure helpers (same file, so the rules exist once):

- `channelDefaults(resolved, model)` → `number[]` — the payload the brush sends before the user
  touches anything; legacy → the current `brushColor` decode.
- `encodeParamValue(param, channelIdx, raw: string) → number` / `decodeParamValue` — reusing
  `encodeAttrValue`'s vocabulary so the brush widgets and the payload agree.
- `paramTagOptions(param, model)` — resolves `tagAttributeId` live, searching cell then agent
  attributes (the `findTagAttrById` precedent), else `tagOptions`.

**Channel id rule (one place, five consumers):**

| param | channels |
|---|---|
| legacy `color` | `r`, `g`, `b` — arg names `_r`, `_g`, `_b` |
| `color` key `tint` | `tint_r`, `tint_g`, `tint_b` — args `_p_tint_r`, … |
| any scalar key `energy` | `energy` — arg `_p_energy` |

The `_p_` prefix guarantees no collision with the cell ABI's `r_<attr>` / `w_<attr>` /
`nIdx_<nbr>` / `_rngState` namespace. `key` must be sanitised to `[A-Za-z0-9_]` on entry
(the editor enforces it; the resolver re-sanitises defensively).

- **Risk:** LOW in itself, but this file is the **keystone** — every byte-identity guarantee in this
  document is a statement about its legacy branch.

---

## Subsystem 3 — Node ports (`inputColor`, `agentInputMapping`) — the dynamic-port checklist

Both roots' `def.ports` shrink to just `do`; the value outputs become **dynamic, resolved from the
mapping** the node's `config.mappingId` names. This is the census/multi-slot pattern applied to an
event root, and the repo's recipe is explicit:

1. **One shared builder** — `buildInputParamPorts(nodeType, config, model)` in
   `inputMappingParams.ts` (next to the resolver, matching `buildCensusPorts` in `censusExpand.ts`).
2. **Consumed by BOTH** `effectivePorts.getEffectivePorts` (before the `hiddenPorts` filter) **and**
   `CaNode.tsx`'s derivation block — **with the identical concat order**. The comment in
   `effectivePorts.ts:12-15` is the standing rule: *"they MUST stay in sync"*.
3. **Handle remeasure is free** — `CaNode.tsx:811-814`'s `portIdSignature` effect already fires
   `updateNodeInternals(id)` on any visible-port-set change. Changing a mapping's parameters while
   its root sits on the canvas is exactly the "same height, different ports" case that effect
   exists for.
4. **Stale edges are DROPPED, never repointed.** A wire from a deleted/renamed parameter's port
   must not fall through to another channel — that is the `STALE_SLOT_HANDLE` hazard
   (`multiAttrExpand.ts:179-183`: *"an unclaimed handle left here would fall through … and silently
   resolve to the WRONG variable"*). Unlike the multi-slot case there is **no pre-compile expansion
   pass** here (the root is compiled directly), so the drop belongs in the compiler's own resolution:
   a consumer wired to an unknown `portId` must produce a **named compile error**, not `_undef`.
   `detectDanglingRefs` is the established precedent for exactly this.
5. **`nodeValidation.detectMissingConfig`** already covers `inputColor` / `agentInputMapping`
   (mapping selected / direction-scoped). Add: *"this mapping declares no parameters"* only if the
   node has wired value edges — otherwise `parameters: []` is a perfectly valid stamp mapping.

⚠ **`getEffectivePortsForType(def, resolvedConfig)` does NOT forward a model**
(`effectivePorts.ts:167-172`). It is used by the panel-drag compatibility check for a
not-yet-spawned node. With no model the builder cannot resolve a mapping ⇒ it must return the
**legacy r/g/b** shape (which is also the right answer, since a freshly-dropped root has
`mappingId: ''`). No signature change needed; just don't crash.

- **Risk:** MEDIUM. Two mirrored call sites, and the stale-edge rule is the one that fails
  *silently* if missed.

---

## Subsystem 4 — JS cell compiler (`compiler/compile.ts`)

Three touch points, all in the `inputColor` block (`compile.ts:2208-2249`):

| today | parameterized |
|---|---|
| `(function(_r, _g, _b, ${cellParams}) {` | `(function(${channels.map(c=>c.argName).join(', ')}, ${cellParams}) {` |
| `const _v<id>_r = _r; const _v<id>_g = _g; const _v<id>_b = _b;` | one `const _v<id>_<portId> = <argName>;` per channel, **joined on the same line** for the legacy case |
| `varName()` → `_v<id>_<portId>` (already generic) | unchanged — `inputColor` is already in `MULTI_OUTPUT_TYPES` (`compile.ts:87`) |

**`compileValueNode`'s early return `if (nodeType === 'inputColor') return \`_v${nodeId}\`;`
(`compile.ts:832`) is untouched** — it short-circuits the root so no value emitter is consulted;
resolution happens purely through the alias lines.

**Byte-identity:** the legacy branch must reproduce the two strings *character for character*,
including the single-line triple-`const`. This is one `if (resolved.legacy)` around a template.

`agentInputMapping` (`compile.ts:2924-2971`) takes the identical treatment; its emit is already the
same shape (`(function(_r, _g, _b, ${imParams}) {` + the alias line).

**⚠ `buildCellParams` is EXPORTED and consumed by `showCode.ts:1159`.** The colour params are *not*
part of it (they are prepended at the emit site), so `buildCellParams` itself needs **no change** —
but `showCode.ts:1185`'s per-mapping section renders the signature and must render the resolved
channel names instead of a hardcoded `_r, _g, _b`. **Another agent is concurrently working on Show
Code — this is the one file where the two workstreams meet.**

- **Risk:** LOW-MEDIUM. Mechanical, but the byte-identity branch is unforgiving.

---

## Subsystem 5 — WASM cell compiler (`compiler/wasm/compile.ts`) — ⚠ the highest-risk subsystem

Four coupled changes at the entry-point emitter:

1. **`EntryPointOpts.numParams`** — documented *"Number of i32 params (1 for step/outputMapping =
   total; 4 for inputColor = idx,r,g,b)"* — becomes a param **type list**
   (`paramTypes: Valtype[]`), or gains a sibling. `iLocalSource: 'param0'` is unaffected: `idx`
   stays local 0.
2. **`paramOutputs: Record<string, number>`** (portId → param index, valtype hardcoded `I32` at
   `wasm/compile.ts:6890` **and again** at `:7107` after the per-cell cache clear) becomes
   `Record<string, LocalRef>` so each channel carries its own valtype. **Both registration sites
   must change** — the second one is easy to miss and would silently read an f64 param as i32.
3. **The function type.** `TYPE_IDX_IDX_RGB = 2` is a module constant. Parameterized entries need a
   **minted type per arity**: `funcType([I32, ...channels.map(() => F64)], [])`. Legacy keeps
   index 2 verbatim, so a legacy module's type section is unchanged.
4. **The worker's invocation** — `wasmIcFn(idx, ...values)` (Subsystem 8).

**Why this is the risk peak:** a wrong valtype in `paramRefs` does not crash. It reinterprets the
bits of an f64 parameter as an i32 local and produces plausible garbage — the same *quiet* failure
class as the model-attribute slot desync. The mitigation is a **synthetic value-asserting harness**
that runs a real instantiated WASM module in Node and compares against the JS fn (Subsystem 15).

**Also note** `wasm/compile.ts:6842` — the sparse-stepping loop variant is *"never init/inputColor"*
— unaffected, and `:6409` skips inputColor in the pre-emit walk — unaffected.

- **Risk:** **HIGH.** Type-system surgery on an emitter with two mirrored registration sites and a
  silent failure mode.

---

## Subsystem 6 — WebGPU cell compiler — **NO CHANGE**

Per finding 1: there is no inputColor shader. `patchWebGPUCells` moves the CPU-written cells to the
GPU and is parameter-agnostic (it copies attribute words, not colours). The pre-paint
`readbackAttrs` guard (`sim.worker.ts:7345`) is likewise agnostic.

The only work here is **deleting two false claims** (`webgpu/compile.ts:3947`, `CLAUDE.md:1576`).

- **Risk:** NONE.

---

## Subsystem 7 — Agent compiler (`compileAgentGraph`) — reshape of `0a19905`

The agent input mapping is **JS-on-CPU on every agent target** by design, so there is exactly one
emit site: `compile.ts:2924-2971`, `(function(_r, _g, _b, ${buildAgentInputParams(model)}) {`.

The `'input'` ABI kind in `agentAbi.ts` **needs no change at all** — the brush channels are
*prepended by the caller*, outside the shared descriptor (documented at
`compile.ts:2521-2527`). Only the prepended prefix and the alias line move to the resolver.

`agentInputMapping` must join `MULTI_OUTPUT_TYPES` — **it already did** (`compile.ts:99`).

The hazard-eligibility list (`compile.ts:543-551`) already includes `agentInputMapping` because its
`w_` block aliases `attrRead`; unaffected by parameters.

- **Risk:** LOW. One emit site, one prefix.

---

## Subsystem 8 — Worker protocol + handlers (`sim.worker.ts`)

| # | Site | Change |
|---|---|---|
| 1 | `PaintMsg` (`:357`) | `cells` loses `r,g,b`; message gains `values: number[]` |
| 2 | `case 'paint'` (`:7264`) | `icEntry.fn(...msg.values, ...buildCellArgs(idx))`; `wasmIcFn(idx, ...msg.values)` |
| 3 | `PaintAgentsColorMsg` (`:658`) | `r,g,b` → `values: number[]` |
| 4 | `case 'paintAgentsColor'` (`:8472`) | same spread |
| 5 | `ImportImageMsg` (`:393`) | gains `channels?: ChannelSource[]` (Subsystem 11) |
| 6 | `case 'importImage'` (`:8232`) | `applyImageCell` builds the values vector per pixel |

**Everything else in these handlers is untouched** and must stay so: the WASM sync pre-normalisation
(`readAttrs !== attrsA` → copy → swap), the per-cell write-back loop, the WebGPU
`readbackAttrs`-then-`patchWebGPUCells` round-trip, the `AGENT_GPU_DEFER_TYPES` membership of
`paint`/`paintManual`/`paintAgentsColor`, and the `paintManual` handler (which never consults an
input mapping at all).

**Two pre-existing asymmetries to preserve or fix deliberately, not by accident:**

- An **empty `mappingId`** resolves to `inputColorFns[0]` on JS but to `null` on WASM
  (`:7269-7270`), so an unnamed mapping silently runs JS even under `useWasm`. Pre-existing;
  parameters make it worse (the JS fn's arity would be the *first* mapping's, not the intended
  one's). **Recommend: make the empty-id fallback explicit on both, or drop it.**
- `paint` has a silent "set the first bool attribute" fallback when no fn resolves (`:7305`);
  `importImage` instead `break`s. Under parameters the bool fallback is even less meaningful.
  **Recommend: leave both exactly as they are** — changing them is a separate behaviour decision.

- **Risk:** MEDIUM. Six mirrored sites; the two ABI spreads are the ones that must match the
  emitters exactly.

---

## Subsystem 9 — Brush UI (`SimulatorView.tsx`) — cell + agent

**The seam is remarkably narrow** (measured): `flushPaintBatch` (`:10514`) is the *only* cell
egress, and it **already** has a branch that discards colour and substitutes a per-attribute value
list — the `MANUAL_BRUSH_MAPPING_ID` branch. The five producers stuff `{r,g,b}` into cells that
that branch throws away. So:

1. **The five producers stop reading `brushColorRef`** and stop writing `r,g,b` into cells. They
   push `{row, col, layer?}`.
2. **`flushPaintBatch` gains a third branch shape:** manual (unchanged) · legacy colour
   (`values = hexToRgb(brushColorRef.current)` — one read, at flush) · parameterized
   (`values = channels.map(c => encodeParamValue(...))` from the new param state).
3. **`InputParamsPanel`** — a new sibling of `ManualBrushPanel`, same row grammar
   (`[name] [widget]`, no per-row checkbox: a parameter is an argument, not an optional write),
   reusing `InlineBoolSelect` / `InlineNumberInput` / `InlineTagSelect` and **`ColorField`** for a
   `color` parameter. An `integer`/`float` parameter with both `min` and `max` gets a slider beside
   the number field (the model-attribute convention).
4. **The UI fork is one ternary** (`:14598-14630`): Manual → `ManualBrushPanel`; a mapping whose
   resolved params are legacy → today's colour row **verbatim**; otherwise → `InputParamsPanel`.
5. **Shift/Ctrl/Alt+RMB colour popover** (`:11112`, `BrushColorPopover`): shown iff the active
   mapping resolves to **exactly one `color` parameter** (which includes every legacy mapping →
   today's behaviour unchanged). With several colour parameters it binds to the first and its
   header names it; with none it is **hidden** (an enabled control must do something —
   `CLAUDE.md`'s standing rule).
6. **Agent side** (`:14860-14889`): the same `InputParamsPanel`, replacing the bare
   `<input type="color">` + read-only "r, g, b" readout. This is where constraint 4 (cell/agent
   consistency) becomes visible to the user.
7. **Persistence** per D6: `brushColor` unchanged; a new per-model
   `genesisca_input_params_v1:<modelName>` store, merged on a signature key derived from the
   resolved channel list (the `cellAttrSig` pattern at `:2428-2437`) so a parameter retype resets
   just that row.

**Ctrl+wheel mapping cycle** (`:10770-10784`) and the tab strip are unchanged — they select
mappings, not parameters. The agent Paint-mode gating (`agentBrushModesFor(…, inputMappings.length > 0)`)
is unchanged.

- **Risk:** MEDIUM. Volume, not depth — but item 1 touches five call sites including two 3D ones.

---

## Subsystem 10 — The Manual Brush (interaction, not change)

`MANUAL_BRUSH_MAPPING_ID = '__manual__'` is a runtime-only sentinel that **bypasses any compiled
input mapping** and writes attributes directly. It is orthogonal to parameters and needs **no
change**.

Worth stating because the two now look similar in the UI (both render a list of typed widgets), and
they are semantically opposite:

| | Manual Brush | Parameterized mapping |
|---|---|---|
| Writes | attributes, directly | whatever the *graph* decides |
| Widgets | one per cell ATTRIBUTE | one per declared PARAMETER |
| Per-row checkbox | yes (skip this attribute) | no (an argument is always passed) |
| Sub-attribute parent gating | yes | n/a |
| Persistence | `genesisca_manual_brush_v1:` | `genesisca_input_params_v1:` |

- **Risk:** NONE, but the UI must keep them visually distinguishable (the Manual tab stays
  rightmost and separately styled).

---

## Subsystem 11 — Image → cells (`ImageMappingDialog` + `imageMapping.ts` + `importImage`)

Today: `gridifyImage` produces one RGBA pixel per output cell; the worker feeds `r,g,b` (alpha
deliberately ignored) into the input-mapping fn per cell.

**The channel→parameter step** — shown **only** when the chosen mapping resolves to non-legacy
parameters (legacy = today's dialog, verbatim):

```ts
type ChannelSource =
  | { kind: 'pixel'; ch: 'r'|'g'|'b'|'a'|'lum' }   // sampled per cell
  | { kind: 'const'; value: number };              // uniform, from the brush widget
interface ImportImageMsg { …; channels?: ChannelSource[] }   // one per RESOLVED channel, in order
```

A table with one row per parameter channel and a source dropdown. Sensible auto-assignment: the
first three channels take R/G/B; the rest default to `const` seeded from the brush panel's current
value. `applyImageCell` builds the values vector per pixel and spreads it exactly like `paint`.

**What "average" / "invert" / "binarize" mean under parameters** — they are **pixel-space**
operations and stay exactly where they are (in `gridifyImage`, before any parameter mapping):

- **average** — samples the cell's mean colour. Unchanged meaning.
- **invert** — `255 − channel`. Unchanged.
- **binarize** — collapses RGB to 0/255 by luminance threshold. Under parameters this is most
  useful via the `lum` source (a boolean-ish channel), so the dialog should surface **`lum`** as a
  first-class source rather than making the user binarize and then read R.
- `mask` (the binarize-true flags) continues to serve **only** the manual path. Unchanged.

**Recommendation:** keep `imageMapping.ts` **completely unchanged**. The channel assignment is a
consumer of its output, not a modification of it.

- **Risk:** LOW-MEDIUM. Self-contained; the only cross-cutting piece is the new message field.

---

## Subsystem 12 — The editor (`MappingsPanelContent`) + cascades (`ModelContext`)

The cell C→A detail editor currently shows **three fixed textareas** —
`redDescription` / `greenDescription` / `blueDescription` (`:1009-1059`). Those fields are
*documentation for the three hardcoded channels*, and they are rendered for **both** directions
even though they only ever meant anything for C→A.

**Decision:** the parameter list editor **replaces** them for a C→A mapping. Each parameter row
carries its own `description`, which is strictly more expressive. The three legacy fields:

- stay in the schema (they are in every shipped `.gcaproj`; removing them is a migration),
- are **still rendered for an A→C mapping** (unchanged — the R/G/B of an output mapping is a real
  thing to document),
- for a **legacy** C→A mapping, seed the three channel descriptions when the user first opens the
  parameter editor (one-way, on explicit edit — never on load).

**The parameter row editor:** `[⋮⋮ drag] [name] [type ▾] [type-specific: tag options / min-max /
default] [description] [×]` + `+ Parameter`, following the Lookup-Table `LookupAxesEditor`
precedent — **append and remove-LAST only for the KEY space**, but with free reordering of the
*display* list, because unlike lookup axes the ports are keyed by `key`, not position.

**Cascades — the three destructive operations:**

| operation | effect on wires | rule |
|---|---|---|
| **rename** (`name`) | none | `key` is untouched — this is why they are separate fields |
| **retype** | the port's `dataType` changes | keep the wire; a `color`↔scalar change alters the CHANNEL COUNT ⇒ treat as delete+add for the removed channels |
| **delete** / key change | ports vanish | **DROP the edges** — never repoint (`STALE_SLOT_HANDLE` rule) |

Implementation: `UPDATE_MAPPING` / `UPDATE_AGENT_MAPPING` gain a post-step that, when
`changes.parameters` is present, computes the removed channel port-ids and prunes matching edges
from `graphNodes`/`agentGraphNodes`/`macroDefs` via a **new `patchAllEdges` sibling** of
`patchAllNodes` (`ModelContext.tsx:93-108`) — the existing helper patches node *configs*, and
nothing today prunes edges on a model edit. **This is genuinely new machinery and the plan must
call it out.**

`REMOVE_MAPPING`'s existing `clearDeletedId(model, 'mappingId', id)` cascade is unchanged and
already covers both roots (it is key-based).

- **Risk:** MEDIUM-HIGH. `patchAllEdges` is new; an edge left pointing at a vanished port is
  exactly the silent-wrong-variable class.

---

## Subsystem 13 — Validation, analyzers, CSE

- **`detectMissingConfig`** — see Subsystem 3.
- **`detectDanglingRefs`** — the natural home for "this root's graph reads a parameter the mapping
  no longer declares", producing a NAMED compile error instead of `_undef`.
- **Accessor CSE (`purityKey`)** — entry-point roots are excluded from CSE outright
  (`accessorCSE.ts`'s entry-point list), so **no change**. Worth stating: getting it wrong would
  merge two roots.
- **`loopInvariant` / `sinkAnalysis` / `asyncWriteHazard` / `geometryTaint`** — all key off node
  TYPE and flow structure, never off port ids. `agentInputMapping` was added to each by `0a19905`.
  **No change**, but each should be re-run in the harness because the *port set* changing is a new
  input shape for them.
- **`LATTICE_ONLY_TYPES`** already hides `inputColor` on the Agents sub-tab. Unchanged.

- **Risk:** LOW.

---

## Subsystem 14 — Save / load / export / Show Code

- **`.gcaproj`** — additive optional array; `stringifyCompact` drops `undefined`. **No migration.**
- **`.gcastate` / presets** — unchanged (D6). `brushColor` keeps its `SimulationState` slot.
- **Presentation export** — embeds the whole `CAModel` verbatim; the viewer mounts `SimulatorView`,
  so a parameterized brush works there for free. **Verify** the viewer's brush panel renders.
- **Show Code** (`showCode.ts:819, 1159, 1185`) — the per-mapping section header must print the
  resolved signature. ⚠ **Concurrent workstream — coordinate.**

- **Risk:** LOW.

---

## Subsystem 15 — Verification (the library gives ZERO coverage for the new path)

Every shipped model has `parameters` absent. So `check-compile-identity.mjs` can prove we broke
**nothing** and proves **nothing** about whether the feature works. Both halves are needed.

### Half 1 — byte-identity (the safety net)

`node scripts/check-compile-identity.mjs --capture` before, `--compare` after, **all 29 models,
every surface**. Expected: **zero diffs**, at every phase. This is achievable by construction (the
resolver's legacy branch) and any diff is a bug, not a re-baseline.

### Half 2 — a synthetic value-asserting harness (`scripts/test-input-params.mjs`, NEW)

Following `test-ndtable.mjs` / `test-get-random.mjs`: build models in memory, compile them, run
them on **JS and a REAL instantiated WASM module in Node**, and assert **VALUES**:

1. **Legacy identity** — a legacy mapping's emitted JS string and WASM bytes are byte-equal to a
   pre-change capture; the WASM type section still uses `(i32,i32,i32,i32)`.
2. **Channel order** — a 4-parameter mapping (`float`, `tag`, `bool`, `color`) yields 6 channels in
   declared order; ports, ABI names and the values payload all agree.
3. **Round-trip values** — paint with `[2.5, 3, 1, 10, 20, 30]` and read back each written
   attribute: exact on JS, **bit-identical** on WASM.
4. **f64 fidelity** — a `float` parameter carrying `0.1` arrives as `0.1`, not `0`. *(This is the
   single check that would have caught a stale `valtype: I32` in `paramRefs`.)*
5. **Stale edge** — a graph wired to a since-deleted parameter's port produces a **named compile
   error**, not `_undef`.
6. **`[]` vs `undefined`** — an explicitly-empty parameter list compiles to a zero-argument entry
   and paints without error; an absent one is legacy.
7. **Agent parity** — the same assertions through `compileAgentGraph`, plus a permanent entry in
   `scripts/parity-agent-wasm.mjs`.

### Half 3 — the real UI (per surface, per target)

A hand-authored fixture `.gcaproj` with one legacy and one parameterized mapping:

| check | why |
|---|---|
| Paint on **JS**, **WASM** and **WebGPU** grid targets | three worker paths (JS fn, WASM fn, readback+patch) |
| Paint an **agent** on JS / WASM / WebGPU agent targets | the agent fn is JS on all three; the defer set differs |
| **3D** paint via the brush plane | `paint3dRef` is a separate producer |
| **Image import**, both `resize` and paste-`center` | the per-pixel path + the region path |
| **Manual tab** still works and still bypasses everything | the sentinel |
| **Shift+RMB popover** appears for legacy, hides with no colour param | the "enabled control" rule |
| **Presentation export** → open the `.html` → paint | the viewer mounts the same panel |
| Delete a parameter with a wired port → the edge is gone, no crash | the cascade |

### Half 4 — the existing gates, all green

`tsc -b` · `npm run build` · `check-compile-identity` · `parity-agent-wasm` · `test-agent-abi` ·
`audit-agent-layout` · `verify-agent-render` · `check-agent-wasm-gate`.

---

## Cross-cutting risk summary

| Subsystem | Risk | Why |
|---|---|---|
| 5 — WASM entry types | **HIGH** | Two mirrored `paramRefs` sites; a wrong valtype is silent, not fatal |
| 12 — editor cascades | **MED-HIGH** | `patchAllEdges` is new machinery; a stale edge resolves to the wrong variable |
| 3 — dynamic ports | MEDIUM | Two mirrored builders; the stale-edge rule fails silently |
| 8 — worker ABI | MEDIUM | Six sites; the two spreads must match the emitters exactly |
| 9 — brush UI | MEDIUM | Volume (5 producers, 2 panels, 2 dimensions) |
| 2 — the resolver | LOW* | *Trivial code, but every byte-identity claim rests on it |
| 4, 7 — JS emits | LOW-MED | Mechanical; unforgiving legacy branch |
| 11 — image dialog | LOW-MED | Self-contained |
| 1, 13, 14 — schema, analyzers, save | LOW | Additive / no-change |
| 6 — WebGPU | NONE | No inputColor shader exists |

## The one thing most likely to go wrong

**A parameterized WASM entry whose `paramRefs` still says `I32`.** It compiles, instantiates, runs,
and writes plausible values — an f64 `0.1` read as an i32 local is garbage, but *deterministic*
garbage that looks like a modelling mistake. It will not be caught by byte-identity (legacy is
untouched), nor by "does it compile", nor by painting an integer parameter. Only check 4 of the
synthetic harness catches it. **Write that check first.**

Second most likely: an **edge left pointing at a deleted parameter's port**, which the compiler
resolves to `_v<id>_<goneKey>` — an identifier the alias block no longer declares. On JS that is a
loud `ReferenceError` inside the worker; on WASM it is a compile error. Loud either way *if* the
dangling-ref gate covers it; silent-wrong only if a *different* channel happens to claim the id,
which is why key sanitisation and drop-don't-repoint both matter.

---

## Follow-ups (v2 — recorded, NOT planned)

These are deliberately out of scope. Recorded here so the register exists in one place.

- **F1 — Brush-geometry outputs.** Extra event-root outputs — *distance from brush centre*,
  *brush radius*, *normalized falloff* — enabling authored falloff (soft brushes, gradient stamps)
  without any per-cell payload growth: the brush centre + radius ride the message and the **worker**
  computes the per-cell distance. Explicitly deferred by the user. Note the design above is already
  compatible: geometry outputs are a *separate* port group from declared parameters, so they do not
  disturb the channel list or the values payload.
- **F2 — Image → agent-population initialization.** "Paint agents from an image": each
  above-threshold pixel spawns an agent, with pixel channels feeding an agent input mapping's
  parameters. The channel→parameter machinery in Subsystem 11 is exactly the piece this would
  reuse; the missing half is a spawn-from-mask worker message.
- **F3 — A `vector` parameter type.** Lowers to 2–3 channels exactly like `color`; the resolver's
  channel abstraction already accommodates it. Left out only to keep the type set minimal.
- **F4 — Retire the cell WASM input-mapping entry entirely**, making input mappings JS-on-CPU on
  every target like the agent side. Attractive for uniformity; blocked on the `importImage`
  full-grid cost (finding/D4). Would be a deliberate, separately-verified byte-identity break.
- **F5 — Fix the empty-`mappingId` JS/WASM fallback asymmetry** (Subsystem 8).
- **F6 — Parameter presets.** A named set of parameter values per mapping ("Predator brush",
  "Prey brush"), swappable from the tab strip. Natural once parameters exist.
- **F7 — A tag parameter's INLINE option list as a graph-side tag SOURCE.** *(Investigated
  2026-08-11 on a user question — "since it doesn't define an actual tag type … should we just use
  the indexes?" — and deliberately NOT shipped. The honest answer, now stated in the editor and in
  Help, is: yes, the channel carries the index; bind a **tag attribute** if you want the names in
  the graph.)*

  The wanted behaviour: let Get Constant / Compare / Switch pick an option **by name** from a
  parameter's inline list, the way they already do from a tag ATTRIBUTE. Those nodes resolve their
  option names from `config.tagAttributeId`, an ATTRIBUTE id; a parameter lives in a different id
  space, so it needs a synthetic source (`param:<mappingId>:<key>` or similar).

  **Blast radius, as measured** — this is *not* a UI-only change, which is why it was not folded
  into the hint:
  1. `CaNode.tsx` — `tagAttrScope` (one place) plus the three pickers, the option resolution and
     the collapsed labels that read it. UI only.
  2. `nodeValidation.ts` — `findTagAttr` / `hasTagAttr` must accept the synthetic id, or every such
     node is badged "Select a tag attribute".
  3. **`compiler/danglingRefs.ts` — `KEY_SPACE` maps `tagAttributeId` to the `'attribute'` id
     space, so a synthetic id fails the pre-compile dangling-reference gate with a NAMED compile
     error.** This is the decisive one: it makes the feature **compiler-gate-visible**, i.e. exactly
     the "do not half-ship" boundary.
  4. `ModelContext.tsx` — the three tag cascades. A tag ATTRIBUTE's rename/reorder/removal already
     remaps the stored INDICES in `getConstant.constValue` / `statement._port_x` / `switch` cases; an
     inline list edited in the Mappings panel would need the same remap on `UPDATE_MAPPING` /
     `UPDATE_AGENT_MAPPING` (and on deleting the parameter or the whole mapping). Without it a
     reorder silently re-points every constant at the wrong option — a silent-wrong-value bug of the
     class this repo's cascade rules exist to prevent.
  5. A scoping question with no obvious answer: a cell input mapping's parameters are only
     meaningful inside that mapping's ROOT, but the cell graph is one graph shared with the Step and
     Init roots, so the synthetic source would be offerable in places the parameter does not exist.

  The compilers themselves are **unaffected** (they emit tag INDICES; nothing outside `danglingRefs`
  reads `tagAttributeId` on a compile path), so the work is tractable — it is the cascade in (4)
  plus the gate in (3) that make it its own verified pass rather than a rider.

**Note on the Clarity initiative's register.** `docs/HANDOFF_CLARITY_SIMPLIFICATION.md` §3 is a
"FOLLOW-UPS REGISTER (post-initiative)" and is the project-wide home for deferred work. It belongs
to that workstream and is **not edited by this document**; if this feature ships, F1–F6 are the
candidates to fold into it.
