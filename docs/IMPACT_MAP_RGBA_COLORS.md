# Impact Map — RGBA colours (alpha through the colour-producer chain)

## Context

Every colour picker in GenesisCA is RGB-only. The user's framing was "the engine already takes RGBA
into account, so just update the pickers" — that premise is **half-true**, and the half that is false
determines the entire shape of this work.

**What IS already RGBA (the render sink):**

- The per-cell `colors` buffer is `Uint8ClampedArray` RGBA; the per-agent `s.colors` buffer likewise.
- `setCellLooks` has an `a` input port (integer, inline default `'255'`), emitted on all three
  targets: JS `colors[colorIdx+3] = <a>`, WASM `i32Store8`, WebGPU `(u32(clamp(a,0,255)) << 24u)`.
- The 2D canvas composites `ImageData` alpha source-over; `drawAgentsOverlay` uses the agent colour's
  A as the disc/sprite alpha.
- The 3D voxel renderer culls `alpha === 0` instances outright (`uploadColors` compacts only
  `alpha > 0`) and blends partial alpha under the "Alpha blend" toggle; the WebGPU canvas is
  `alphaMode: 'premultiplied'`.

**What is NOT RGBA (every colour *producer* upstream of the sink):**

| Producer | Output ports | Config keys | Alpha |
|---|---|---|---|
| `colorScale` | `r`, `g`, `b` | `stop_${i}_(position\|r\|g\|b)` | none |
| `categoricalColor` | `r`, `g`, `b` | `entry_${i}_(r\|g\|b)`, `default_(r\|g\|b)` | none |
| `getColorConstant` | `r`, `g`, `b` | `r`, `g`, `b` | none |
| `getModelAttribute` (colour attr) | `value`, `r`, `g`, `b` | — (reads `_r`/`_g`/`_b` slots) | none |
| `RGB` type (`types.ts:214`) | `{ r, g, b }` | — | **no `a` field** |
| `ColorStop` type (`types.ts:219`) | `{ position, r, g, b }` | — | **no `a` field** |
| `linkedOutputMappings.ts` | wires 3 edges (r, g, b) → `setCellLooks` | — | none — `a` falls to `'255'` |

So the alpha channel exists at the *sink* and nowhere upstream of it. Adding alpha to the pickers
alone would produce a value with nowhere to flow. **The work runs sink-backwards**: schema →
producers (ports + emit × 5 compilers) → linked-OM wiring → pickers.

`CLAUDE.md` already predicted this precise gap in the PR7 deferred list: *"the Color Scale +
Categorical Color `a` OUTPUT channel (for linked-OM / hand-built-gradient alpha). Adding it changes
every existing colorScale model's emit unless gated behind an opt-in `hasAlpha` config + the full
multi-output registration (varName/MULTI_OUTPUT/setCachedPort × WASM+WebGPU) + per-stop alpha UI."*
This document is that deferred item, scoped.

**Scope decisions (user-confirmed):**

- **IN** — the colour model attribute gains alpha (`#rrggbb` → `#rrggbbaa`, a 4th `_a` runtime slot).
  This is the highest-risk item: it changes the baked memory layout.
- **OUT (deferred)** — the brush / Colour→Attribute input-mapping direction. `InputColor`'s
  `(_r, _g, _b, idx, …)` ABI stays 3-channel. Image import continues to ignore source alpha.
- **OUT** — every cosmetic picker with no engine path: `bg2d` / `bg3d` backdrop, comment-node and
  group-node colours, indicator chart `seriesColors`, sprite chroma-key. They stay RGB.

This is NOT an implementation plan — it is the precondition to one. One section per subsystem.

---

## The governing safety principle

> **Absent alpha ⇒ 255 ⇒ opaque ⇒ behaviour-identical.**

Every new alpha field is **optional** (`a?: number`) and every parse defaults to 255. No `.gcaproj`
migration is needed, and no existing model can change behaviour, because 255 is exactly what
`setCellLooks`' inline default already writes today. This is the same additive-optional discipline
used by `ruleDescription`, `coords3d`, `agentCapabilities`, and `vectorDims`.

**Behaviour-identity is guaranteed by construction. Byte-identity is not — see the open decision
below, which is the single most important call in this document.**

---

## THE OPEN DECISION — how the `a` output port avoids polluting every existing emit

A multi-output value node emits all of its output ports together. If `colorScale` unconditionally
gains `const _v<id>_a = 255;`, then **every model with a linked float/integer output mapping gains a
dead const line** in its emitted JS / WASM bytes / WGSL. The line is provably dead (nothing consumes
it; V8 and the WASM/WGSL optimisers elide it), so **behaviour is identical** — but the
`check-compile-identity.mjs` baseline goes red across ~10 models, which destroys the cheapest tool
we have for proving this change is safe.

Three candidate resolutions:

### Option A — `hiddenPorts` gates the `a` port on config (RECOMMENDED)

`readColorScaleStops` / `readCategoricalEntries` return `a?: number` (undefined = opaque). The node's
`hiddenPorts(config)` hides the `a` output whenever **no** stop/entry declares an alpha. Emit branches
on the same predicate: all-opaque → emit exactly today's three vars (**byte-identical**); any alpha
declared → emit the four-var form.

- **Pro:** byte-identity holds for every existing model *by construction*, so
  `check-compile-identity.mjs` stays green and remains a real regression net. Uses an existing,
  well-understood mechanism (`hiddenPorts` already gates `getModelAttribute`'s r/g/b vs value on
  `isColorAttr`, and `setCellLooks`' own `a` port in glyph mode).
- **Con:** the `a` output port appears/disappears as the user touches the alpha slider. Mitigated by
  the existing config-driven port-set `updateNodeInternals` effect in `CaNode.tsx`, which already
  re-measures handle bounds on exactly this kind of change (the Vector-Op port-set bug).
- **Con:** a user who wires `a` and *then* sets every stop back to 255 loses the port and the edge
  goes unread. Same semantics as every other `hiddenPorts` user — hiding is UI-only and pre-existing
  edges simply go unread, which is documented as always-safe.

### Option B — always emit, re-baseline the identity sweep

Accept the additive dead-const, re-capture the baseline, and review the diff (every hunk should be
exactly one `+ const _v<id>_a = 255;`).

- **Pro:** simplest emit; no port ever moves.
- **Con:** burns the one cheap safety net on this very change, and permanently normalises "the
  baseline moved, but trust me, the diff was fine". Rejected on those grounds.

### Option C — opt-in `hasAlpha` boolean config (the CLAUDE.md sketch)

An explicit per-node checkbox.

- **Pro:** byte-identical; port stability is explicit.
- **Con:** it is Option A with a manual toggle bolted on — the user must tick a box before the alpha
  slider does anything. Strictly worse UX for the same guarantee.

**Recommendation: Option A.** It is the only one that keeps byte-identity *and* keeps the alpha
slider directly meaningful.

**The linked-OM corollary:** `injectLinkedOutputMappings` must wire the `a` edge into `setCellLooks`
**only when the palette actually carries a non-255 alpha**. An all-opaque palette synthesizes exactly
today's three edges → byte-identical. This is the same hot-path-no-op discipline as
`expandComposites` / `expandMultiAttrs` / `collapseReroutes`.

---

## Subsystem 1 — Schema (`src/model/types.ts`)

```ts
export interface RGB { r: number; g: number; b: number; a?: number; }        // absent = 255
export interface ColorStop { position: number; r: number; g: number; b: number; a?: number; }
```

`LinkedColorSet` needs no change (its `gradient: ColorStop[]` / `tag: RGB[]` widen transitively).

- **Serialization:** `stringifyCompact` already filters `undefined` properties, so an opaque palette
  round-trips byte-identically through `.gcaproj`. **No migration.**
- **Risk:** low. Both types are structural, no discriminated unions.

---

## Subsystem 2 — Colour attribute encoding (`#rrggbb` → `#rrggbbaa`)

A colour attribute stores its value in the shared `Attribute.defaultValue: string` as a 7-char hex,
parsed positionally by `hex.slice(1,3) / (3,5) / (5,7)`.

- Widen to accept **both** 7-char and 9-char: `a = hex.length >= 9 ? parseInt(hex.slice(7,9),16) : 255`.
- `boundaryValue` and `undefinedValue` take the same treatment (same field, same parser).
- `attrValueEncoding.ts` needs **no change** — it explicitly does not handle `'color'` (colour is not
  a single per-cell number; it falls to `default:`).
- **Risk:** medium. The parse sites are duplicated — see Subsystem 3. Any site left at 7-char silently
  reads alpha as opaque rather than crashing, which is a *quiet* failure mode. Every site must be
  found, not most.

---

## Subsystem 3 — The `_a` runtime slot (⚠ HIGHEST RISK — memory layout)

A colour **model** attribute is split into three scalar slots (`id_r`, `id_g`, `id_b`). Adding `id_a`
appends a 4th. This pattern is **duplicated across six mirror sites** that must agree exactly, or the
baked offsets desync and every downstream attribute reads the wrong memory:

| # | Site | Shape |
|---|---|---|
| 1 | `sim.worker.ts:4676` | `cachedModelAttrs[id + '_r'/'_g'/'_b']` from hex |
| 2 | `SimulatorView.tsx:537` | same split, for the `init` message |
| 3 | `wasm/layout.ts:343` | 3 × f64 slots, `off += 8` each |
| 4 | `webgpu/layout.ts:257` | 3 × f32, `modelCursor += 4` each |
| 5 | `agentWasm/compile.ts:4808` | agent-loop model-attr read |
| 6 | `agentWebgpu/compile.ts:3584` | agent-loop model-attr read |

**Why appending `_a` after `_b` is safe:** offsets are assigned by a sequential cursor over
`modelAttrs`. Appending a 4th slot shifts every *subsequent* attribute's offset — but it shifts them
**identically in all six sites**, because all six iterate the same list in the same order. This is the
same invariant that `computeAgentMemoryLayout`'s appended `stopFlagOffset` relied on.

**The real hazard is a partial edit** — updating the compiler's layout but not the worker's writer
(or vice versa) produces a silently-wrong grid, not a crash. This is precisely the "+64-cell
corruption" class documented for the vector-attribute ABI mirrors.

- **WebGPU alignment note:** `modelAttrsBytes` rounds up to 16; a 4th f32 per colour attr changes
  which models cross a 16-byte boundary. The rounding is already there, so this is size-only.
- **Coverage gap (critical):** **no shipped model has a colour attribute** — `colorAttr = 0` across
  all 23 library models. The library therefore provides **zero** regression coverage for this
  subsystem. A synthetic model is mandatory (see Subsystem 9).
- **Byte-identity:** unaffected for all 23 library models, precisely *because* none has a colour attr.
  The layout only changes for models this change is adding the capability for.

---

## Subsystem 4 — Node ports + JS emit

Four nodes gain an `a` output port and its config. All four are already in `MULTI_OUTPUT_TYPES`, so
`varName()` resolves `_v<id>_a` via the existing `_v${id}_${portId}` convention — **no `varName()`
special case needed**, and no scratch registration (none of these allocate scratch).

| Node | New config | New port | Notes |
|---|---|---|---|
| `colorScale` | `stop_${i}_a` | `a` (integer, out) | alpha interpolates across stops with the same curve as r/g/b |
| `categoricalColor` | `entry_${i}_a`, `default_a` | `a` (integer, out) | flat select, no blending |
| `getColorConstant` | `a` | `a` (integer, out) | |
| `getModelAttribute` | — | `a` (integer, out) | `hiddenPorts` must group `a` with r/g/b on `isColorAttr` |

`getModelAttribute`'s existing `hiddenPorts` already switches r/g/b vs `value` on `isColorAttr` — `a`
joins the r/g/b group. `colorScale`/`categoricalColor`/`getColorConstant` gain a *new* `hiddenPorts`
per the Option-A decision.

- **Alpha interpolation semantics:** straight (non-premultiplied) alpha, same curve as the colour
  channels. Matches how `GradientStopsEditor.sampleAt` already works for r/g/b.
- **Risk:** low-medium. The emit shape is a mechanical 4th channel alongside three existing ones.

---

## Subsystems 5–8 — The four non-JS compilers (lockstep)

Each needs the `a` channel emitted **and** `setCachedPort(ctx, id, 'a', …)` so consumers resolve it.

| # | Compiler | Sites |
|---|---|---|
| 5 | `wasm/compile.ts` | `colorScale`, `categoricalColor`, `getColorConstant`, `getModelAttribute` value emitters |
| 6 | `webgpu/compile.ts` | same four |
| 7 | `agentWasm/compile.ts` | `categoricalColor` + `getModelAttribute` (both in `AGENT_WASM_SUPPORTED_TYPES`) |
| 8 | `agentWebgpu/compile.ts` | `categoricalColor` + `getModelAttribute` |

The agent compilers matter because **`categoricalColor` is the shipped agent-colouring idiom** — four
of the five hand-placed `categoricalColor` instances in the library are in agent models
(Morphogenesis ×2, GoL-on-Agents, Ant Necrophoresis).

- **WebGPU f32:** alpha rides the same f32 path as r/g/b; `setCellLooks` already clamps and packs it
  into bits 24–31. No precision concern (0–255 integers are exact in f32).
- **Risk:** medium — four parallel emitters is exactly the drift surface `CLAUDE.md`'s
  compiler-lockstep rule exists to guard. Mitigation is the cross-target compile check, which can be
  run without driving the UI via the dev harness.

---

## Subsystem 9 — Linked Output Mappings (cell + agent)

`linkedOutputMappings.ts` (`injectLinkedOutputMappings`) and its agent mirror
`agentLinkedOutputMappings.ts` (`injectAgentLinkedOutputMappings`) each synthesize:

```
getCellAttribute → colorScale | categoricalColor ──r,g,b──> setCellLooks
```

Add a 4th `a` edge **conditionally** — only when the resolved palette carries a non-255 alpha
(the hot-path no-op). Defaults `defaultGradientStops()` / `defaultTagColor()` return no `a` → opaque →
three edges → byte-identical.

**Coverage note:** `colorScale` and `categoricalColor` are *synthesized here*, which is why they
appear in **zero** `.gcaproj` files despite being exercised by ~10 library models. The
compile-identity sweep does cover them (it hashes emitted output, not model files) — but any audit
that greps the models will wrongly conclude they're unused.

`linkedAgent = 0` across the library: **no shipped model uses an agent linked OM.** That path needs
synthetic coverage too.

---

## Subsystem 10 — UI pickers (engine paths only)

### The native `alpha` attribute is not an option (measured, not assumed)

The HTML spec added `<input type="color" alpha>` (plus `colorspace`). It is **Safari 18.4+ only —
12.58% global support; Chrome ❌ through 150, Edge ❌, Firefox ❌**
([caniuse](https://caniuse.com/wf-input-color-alpha)). Probed directly in a Chrome 148 renderer:

```
idlAlphaPresent:      false
value = '#ff000080'  →  '#ff0000'      // silently TRUNCATED, no error
colorSpace IDL:       ABSENT
```

Two reasons it is rejected for GenesisCA specifically:

1. **It lights up in exactly the wrong browser.** WebGPU and the Tauri shell are Chromium-bound
   (`CLAUDE.md`: macOS/Linux Tauri uses WebKit → the simulator falls back to WASM/JS). Native alpha
   would work only where the app is least capable, and be dark for the Chromium users who are the
   actual audience.
2. **It fails silently.** An 8-digit hex is truncated, not rejected — the same quiet-corruption class
   as the `BrushColorPopover` 24-bit mask. A progressive-enhancement branch would give ~87% of users a
   different control *and* still require the fallback to be built, i.e. more code for worse
   consistency.

### The decision — ONE shared `ColorField` component

Rather than bolting an alpha `NumberField` beside each of the seven swatches, extract a single
`src/modeler/vpl/widgets/ColorField.tsx`:

- A **checkerboard-backed swatch button** rendering the true `rgba()` composite (alpha is *visible*,
  not just a number).
- Click → a small popover: the native `<input type="color">` for RGB + an **alpha slider (0–255)**.
- Follows the existing `BrushColorPopover.tsx` precedent (swatch → popover with channel fields), and
  the `NameInputDialog` promise/anchor pattern for placement.

Consequences:

- **Seven ad-hoc picker layouts collapse to one component** — less code than the status quo, not more.
- Lets the three divergent hex-helper pairs be deleted in favour of one pair (see hazards below).
- One consistent control in every browser; no capability branch.

`<input type="color">` remains the RGB sub-control inside `ColorField` — it is universally supported
for 6-digit hex, which is all it is asked for.

### The sites `ColorField` replaces

| Site | Writes | Notes |
|---|---|---|
| `GradientStopsEditor.tsx:178` | `GradStop {p,r,g,b}` → `+a` | **Shared widget** — one edit serves the Color Scale node *and* the linked float/integer editor. `sampleAt`/`interp` (lines 33–54) and the CSS bar (`rgb(...)` → `rgba(...)`, line 92) all widen. |
| `MappingsPanelContent.tsx:105` (`ColorSwatch`) | bool 2-stop + tag `RGB[]` | `rgbToHex`/`hexToRgb` (lines 16–24) are 6-digit-only. |
| `CaNode.tsx:106` (`ColorScaleEditor`) | `stop_<i>_*` | thin wrapper over `GradientStopsEditor`. |
| `CaNode.tsx:138` (`CategoricalColorEditor`) | `entry_<i>_*`, `default_*` | `type E = {r,g,b}` → `+a`. |
| `CaNode.tsx:2369` (`getColorConstant`) | config `r,g,b` | already has three `InlineNumberInput` channels — add a 4th. |
| `AttributesPanelContent.tsx:711` | `Attribute.defaultValue` hex | the `#rrggbbaa` site. |
| `SimulatorView.tsx:7839` | `runtimeModelAttrs[id+'_r'/'_g'/'_b']` | add the `_a` write. |

**Explicitly NOT touched** (confirmed out of scope): `setCellLooks`' own `renderColorPicker`
(`CaNode.tsx:1817`) already has an `a` *port* with an inline widget — it needs no picker change;
`BrushColorPopover`, `SimulatorView` brush colour, `bg2d`/`bg3d`, comment/group node colours,
`IndicatorDisplay` / `IndicatorsPanelSection` `seriesColors`, sprite chroma-key.

**Latent hazards found (must not regress):** three duplicated hex-helper pairs with divergent
behaviour — `MappingsPanelContent.tsx:16` (regex, black fallback), `BrushColorPopover.tsx:14`
(**24-bit mask — an 8-digit hex silently corrupts into the wrong channels**), `SimulatorView.tsx:5788`
— plus two copies of `toHexColor` (`IndicatorDisplay.tsx:77`, `IndicatorsPanelSection.tsx:379`) that
**silently fall back to `#888888` on any 8-digit hex**.

`ColorField` ships with **one** alpha-aware `hexToRgba` / `rgbaToHex` pair (accepting 6- and 8-digit),
which the engine-path sites adopt. Brush and chart colours are out of scope and keep their own
helpers — so the standing requirement is that an 8-digit hex must never *reach* them. Since a colour
model attribute's `defaultValue` can now be 9 chars, and `SimulatorView`'s brush is a different field
entirely, the two never meet — but this is an explicit review assertion, not an assumption.

- **Risk:** low individually; the volume is the risk. `ColorField` reduces the volume from seven
  bespoke layouts to one.

---

## Subsystem 11 — `ModelContext` cascades

- `UPDATE_ATTRIBUTE` tagOptions remap already remaps `linkedColors.tag[]` by `indexMap` — it copies
  whole `RGB` objects, so `a` rides along **for free**. Verify, don't rewrite.
- `UPDATE_ATTRIBUTE` type-change resets `linkedColors` — unaffected.
- `REMOVE_ATTRIBUTE` unlink — unaffected.
- **Risk:** very low, but must be *checked* rather than assumed.

---

## Subsystem 12 — Accessor CSE

`purityKey` serialises config minus compiler-injected `_`-prefixed keys, **except** `_port_*` and
`_varName_*`. New keys (`stop_0_a`, `entry_0_a`, `default_a`, `a`) carry no leading underscore → they
are included in the key automatically. `setCellLooks`' `_port_a` is `_port_`-prefixed → already kept.

**No change needed.** Two `colorScale` nodes differing only in alpha correctly get different keys and
will not be merged.

- **Risk:** none. Documented here because getting it wrong would silently merge distinct palettes.

---

## Subsystem 13 — Save / load / export

- `.gcaproj`: additive optional fields; `stringifyCompact` drops `undefined`. No migration.
- `.gcastate`: carries no palette data. Unaffected.
- Presentation export (`.html`): embeds the whole `CAModel` verbatim. Unaffected.
- **Risk:** none.

---

## Subsystem 14 — Verification (⚠ the library does not cover this change)

Per the user's direction, the compile-identity sweep runs on a **representative 6**, not all 23.
Selected on the audit evidence, to span 2D/3D × grid/agents × every linked-OM palette kind:

| Model | Covers |
|---|---|
| **Game Of Life** | 2D grid, linked **bool** OM — the canonical baseline |
| **Gray-Scott Reaction-Diffusion** | 2D grid, linked **float** OM → synthesized `colorScale`; CSE-heavy |
| **Kelp War** | 2D grid, linked **tag** OM → synthesized `categoricalColor` |
| **Accretor** | 3D grid, hand-placed `categoricalColor` + `setCellLooks` **already using alpha-0 culling**; sparse stepping; N-D tables |
| **Morphogenesis - Differential Tissue** | 2D **agents**, agent colour pass via `categoricalColor` |
| **Morphogenesis - 3D Tissue** | 3D **agents** |

*(General 2D CA (Golly style) is the natural 7th — it is the only model with a linked **integer** OM —
if a cheap slot is available.)*

**The coverage gap that matters more than the sweep.** These library paths have **zero** shipped
coverage and are exactly where the new code lives:

| Path | Library usage | Consequence |
|---|---|---|
| Colour **model attribute** (the `_a` slot) | **0 models** | The highest-risk subsystem is entirely untested by the library |
| `getColorConstant` | **0 models** | New `a` config/port untested |
| `makeColor` / `breakColor` | **0 models** | Already alpha-capable; nothing proves it |
| **Agent** linked OM | **0 models** | The agent injection path untested |

⇒ **A synthetic test model is mandatory**, not optional — following the established
`scripts/parity-agent-wasm.mjs` / `scripts/test-ndtable.mjs` precedent of building models in-memory
and running them on JS **and** a real instantiated WASM module in Node. Proposed
`scripts/test-rgba-colors.mjs` asserting **values**, not just "it compiles":

1. A colour model attribute with `#rrggbb80` → `Get Model Attribute.a` reads **128** on JS, WASM, WebGPU.
2. `getColorConstant` with alpha → `setCellLooks.a` → `colors[idx*4+3]` holds the exact value.
3. `colorScale` alpha **interpolates** across stops (assert a midpoint value, not just presence).
4. `categoricalColor` alpha selects flat per entry + falls back to `default_a`.
5. An all-opaque palette emits **byte-identically** to the pre-change baseline (the Option-A guarantee).
6. Round-trip: `#rrggbbaa` → save → load → identical.

**Runtime verification** (behaviour, not just compile): a linked float OM with a
transparent→opaque gradient, stepped through the **real worker** on JS / WASM / WebGPU, asserting the
`colors` buffer's alpha bytes match on all three. Plus a 3D check that alpha-0 cells are culled by
`uploadColors` (the renderer's existing behaviour must not regress).

**Note on `parity-agent-wasm.mjs`:** the agent JS↔WASM bit-parity harness must stay green; a
`categoricalColor`-with-alpha synthetic belongs in it permanently, mirroring how `buildFOVModel` /
`buildGridDimsModel` were added.

---

## Cross-cutting risk summary

| Subsystem | Risk | Why |
|---|---|---|
| 3 — `_a` runtime slot | **HIGH** | 6 mirror sites; partial edit ⇒ silent corruption; **zero library coverage** |
| 5–8 — four compilers | **MEDIUM** | Lockstep drift surface |
| 2 — hex widening | **MEDIUM** | Duplicated parsers; a missed site fails *quietly* (reads opaque) |
| 4 — node ports/emit | LOW-MED | Mechanical, but gated on the Option-A decision |
| 9 — linked OM | LOW-MED | Conditional wiring is what preserves byte-identity |
| 10 — UI pickers | LOW | Volume, not depth |
| 1, 11, 12, 13 | LOW / NONE | Additive-optional; CSE and cascades work unchanged |

## The one thing most likely to go wrong

A partial edit of the six `_a` mirror sites. It does not crash — it silently shifts every subsequent
model attribute's offset in one target but not another, so the model *runs* and renders plausible
garbage on WASM while JS looks fine. The audit script `scripts/audit-agent-layout.mjs` exists for
exactly this class on the agent side; the model-attr split has **no equivalent audit**. Adding one
(assert all six sites agree on the slot list for a given model) is cheap and is the highest-value
piece of insurance in this plan.

---

## Recommended sequencing

Each step ends green and is independently revertable.

1. **Schema + hex widening** (S1, S2) — types gain `a?`, parsers accept 9-char. No behaviour change.
2. **The `_a` slot + its audit script** (S3) — all six mirror sites in one commit, plus the new audit.
   Land the synthetic test alongside; this is the step the library cannot cover.
3. **JS node ports + emit** (S4) under Option A — `hiddenPorts` gating, byte-identity verified.
4. **The four non-JS compilers** (S5–S8) — one commit, cross-target compile parity checked.
5. **Linked OM conditional wiring** (S9, cell + agent).
6. **UI pickers** (S10) — the shared `GradientStopsEditor` first (it serves two callers).
7. **Docs sweep** — `CLAUDE.md` (retire the PR7 deferred note), `HelpView.tsx`, `README.md`,
   `docs/NODES_REFERENCE.md` (port tables for the four widened nodes).
