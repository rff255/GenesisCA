# Plan — `vector` stored attribute type + Orientation (`facing` FOV heading)

Branch `absorb_old_automatosgt`. Continues the Agent Capability Profiles milestone (STEP 5c). User decision (2026-07-07): the Orientation `facing` heading source stores facing in a **normal agent attribute** (all-target for free — NOT the JS-only `spriteRotations`), **and** facing must be settable as a **vector**, which requires a first-class **`vector` stored attribute type**.

## The core insight — a vector attribute is *lowered to scalar floats*, exactly like a vector *wire*

`vector` already exists as a **`PortDataType`** (a wire), but it is pure editor sugar that [expandComposites.ts](../src/modeler/vpl/compiler/expandComposites.ts) lowers to scalar `arithmeticOperator`/`getConstant` nodes **before any target compiles** — so there is *zero* vector-specific emit in any compiler. A **stored** vector attribute is genuinely new (storage + serialization), BUT we make it ride the same principle:

> **A `vector` attribute is lowered to N scalar `float` component attributes (`<id>_vx`, `<id>_vy`[, `<id>_vz`]) at the compiler + worker boundary, so every downstream layer (all 5 compilers, the worker SoA, file I/O) sees only scalar floats — the same pattern as `color`'s `_r/_g/_b` model-attr split and `expandComposites`' wire lowering.**

`dims = is3dModel(model) ? 3 : 2` (a 2D model → `(x, y)`; a 3D model → `(x, y, z)`), matching how the vector *wire* nodes hide the Z port in 2D. No explicit `vectorDims` schema field — derive from the model, like everything else 2D/3D.

### Why this is low-risk despite touching a load-bearing invariant
- The components are ordinary `float` attributes. `float` already works on **all 3 cell targets + both agent targets, 2D+3D, with full save/load** (`ATTR_TYPE_MAP` has `float64`). So the expansion produces only already-verified scalar machinery.
- The vector attribute exists **only** in `model.attributes` / `model.agentAttributes` (the UI + authoring layer) and in the two lowering transforms. It never reaches a scalar-only consumer.

## Architecture — two shared transforms (siblings of `expandComposites` / `macroExpand`)

New module **`src/modeler/vpl/compiler/vectorAttr.ts`**:
- `vectorComponentIds(attrId, dims): string[]` — the ONE synthesizer of `<id>_vx/_vy/_vz` (the `_r/_g/_b` analogue).
- `expandVectorAttributes(attrs, dims): Attribute[]` — replaces each `vector` attr with its `dims` scalar `float` component attrs (name `"<name> X"` etc.), preserving order. Applied to the attribute list at every compiler + the worker-init boundary.
- `isVectorAttr(attr)`, `vectorLabels(dims)`.

**Node lowering** — fold into the existing `expandComposites` pass (it already runs on every front-end, cell + agent):
- `getVectorAttribute` (config `attributeId`, output a `vector` wire) → a synthesized `makeVector` fed by `getCellAttribute(<id>_vx)`, `getCellAttribute(<id>_vy)`[, `…_vz`]. `expandComposites` then lowers the `makeVector` to scalars — so the whole thing bottoms out at scalar-float attribute reads.
- `setVectorAttribute` (config `attributeId`, input a `vector` wire) → a synthesized `breakVector` whose components feed `setAttribute(<id>_vx/_vy/_vz)`.
- The scalar `getCellAttribute`/`setAttribute` on `<id>_vx` resolve because `expandVectorAttributes` put those component attrs in the compiler's attribute list.

So both new nodes reuse the **already-verified** Make/Break-Vector lowering + the scalar attribute machinery — **no new per-target emit**.

## Transform application boundaries (the coverage risk — must hit ALL)
`expandVectorAttributes` must be applied to the attribute list seen by:
1. **Cell compilers** — `compileGraph` (JS), `compileGraphWasm`, `compileGraphWebGPU` (each derives cell attrs from `model.attributes`).
2. **Agent compilers** — `compileAgentGraph`, `compileAgentGraphWasm`, `compileAgentGraphWebGPU` (via `agentAttrsOf`).
3. **Worker init** — the `init`/`recompile` message attributes built in [SimulatorView.tsx](../src/simulator/SimulatorView.tsx) (both `attributes` and `agentAttributes`), so the worker SoA allocates the component arrays; file I/O then serializes them as plain float64 records automatically.
4. **The dev harness** `compileAll` (so parity/verify see the same expansion).

Cleanest single seam: expand inside `agentAttrsOf` / `cellAttrsOf` / `cellFieldAttrsOf` ([attributeScope.ts](../src/model/attributeScope.ts)) for the compiler+worker paths, and keep the **UI** on the raw `model.attributes`/`model.agentAttributes` (which still contain the one vector attr). Audit every caller of those helpers to confirm none is a UI-list consumer that would then show the components. Where a UI consumer uses them, route it to a raw variant.

## Get/Set node UX + the FOV `facing` heading source
- **Get Vector Attribute** / **Set Vector Attribute** — `requirements: { bondGraph }`-agnostic (work on cell OR agent graph). Config = an attribute picker restricted to `vector`-typed attrs of the active graph. Ports: a single `vector` wire (Z auto-hidden in 2D via the existing composite handle). Read `Get Vector Attribute → Break Vector → (x, y[, z])`; write `(x, y[, z]) → Make Vector → Set Vector Attribute`.
- **FOV `facing` heading source** (the two Sensing nodes): add `facing` to `headingSource` (velocity / wired / **facing**) + a `facingAttributeId` config. The heading resolves from the facing attribute:
  - **vector** facing attr ⇒ heading = its components directly (`hx = r_<id>_vx[idx]`, …). No trig — exact, all-target.
  - **float** facing attr (compass degrees) ⇒ `hx = sin(deg·π/180)`, `hy = -cos(deg·π/180)` (compass 0 = up = −y). WASM's `sin`/`cos` are the JS `Math.sin/cos` host imports ⇒ JS↔WASM bit-identical; WebGPU native (statistical).
  - `facing` is offered only when the **Orientation** capability is on (gate in `isNodeAvailable` / the config UI), and it un-hides the Orientation capability row.

## UI
- **Attribute type dropdown** ([AttributesPanelContent.tsx](../src/modeler/panels/AttributesPanelContent.tsx)) gains **Vector** (cell + agent; not model in v1). Default editor = `dims` `NumberField`s (X/Y[/Z]); `resetDefaults` → `"0,0"`/`"0,0,0"`.
- **Cell inspector** ([InspectCellPopover.tsx](../src/simulator/InspectCellPopover.tsx)) shows a vector attr as `(x X, y Y[, z Z])` by reading its component cell values.
- **typeLabels** `vector → "Vector"`. Drag payload + `handleVector` CSS already exist.
- **Manual brush / agent Edit panel**: a vector row = `dims` number fields writing the components (via the existing per-attribute set path over the component ids).

## Encoding
- `Attribute.defaultValue` for a vector = `"x,y"`/`"x,y,z"` (comma-joined). New `encodeVectorValue(attr, dims): number[]` / `decodeVectorValue(comps): string` in [attrValueEncoding.ts](../src/model/attrValueEncoding.ts) (the scalar `encodeAttrValue`/`decodeAttrValue` stay untouched; the expansion helper splits the default string across the component `float` attrs).

## Explicitly out of scope (v1)
- **Model** vector attributes (v1 = cell + agent only; a model vector attr would need the color-style model-attr split in more places).
- Vector as a **sub-attribute PARENT** (a parent must be a scalar match — forbid in validation; a vector CHILD is fine).
- Vector → color mappings, vector aggregation/indicators.

## Verification (the all-target + 2D/3D matrix)
1. `npx tsc -p tsconfig.app.json --noEmit` + `npm run build`.
2. **Dev-harness `compileAll`** on a cell model + an agent model with a vector attr → JS/WASM/WebGPU all compile, 2D + 3D (proves the expansion covers every compiler).
3. **A real worker run per target** (JS/WASM/WebGPU): store a vector, read it back via `getState` — the component arrays round-trip.
4. **Save/load** a `.gcaproj`/`.gcastate` with a vector attr (the `ATTR_TYPE_MAP` silent-float64 gate — the #1 risk).
5. **JS↔WASM agent parity** (`parity-agent-wasm.mjs`) + a synthetic facing model (set facing vector → FOV heading).
6. **Real-GPU** WebGPU shader compile for the facing-vector FOV path.
7. Adversarial review workflow.

## Biggest risks (from the surface map)
1. **`ATTR_TYPE_MAP` silent float64 fallback** — a vector attr not expanded before serialization corrupts the save. Mitigated by expanding at the worker-init boundary so file I/O only ever sees the float components.
2. **Cross-target switch divergence** — mitigated by the *expansion* design (components are plain floats; no per-target `vector` arm needed) + the harness matrix.
3. **UI-vs-compiler list split** — `agentAttrsOf`/`cellAttrsOf` feed BOTH; the UI must keep the raw one-vector list while the compilers/worker get the expanded list. Audit every caller.
