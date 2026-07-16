# Plan — RGBA colours (alpha through the colour-producer chain)

Illustrated companion: [PLAN_RGBA_COLORS.html](PLAN_RGBA_COLORS.html).
Precondition: [IMPACT_MAP_RGBA_COLORS.md](IMPACT_MAP_RGBA_COLORS.md) — read it first; this document
does not repeat the subsystem analysis.

## Goal

Alpha flows end-to-end from every colour **producer** to the `colors` buffer, on **all five
compilers** (JS / WASM / WebGPU × cell + agent), across **2D and 3D**, for **grid and agent** models.

## Non-goals (user-confirmed)

- The Colour→Attribute (brush / image-import) direction. `InputColor`'s `(_r, _g, _b, idx, …)` ABI is
  untouched.
- Cosmetic pickers with no engine path: `bg2d`/`bg3d`, comment/group node colours, indicator chart
  `seriesColors`, sprite chroma-key.

## The invariant that makes this safe

> **Absent alpha ⇒ 255 ⇒ opaque ⇒ behaviour-identical, and (under Option A) byte-identical.**

Every alpha field is optional; every parser defaults to 255. No `.gcaproj` migration.

## The design decision (Impact Map §"THE OPEN DECISION") — Option A

The `a` output port is gated by `hiddenPorts(config)`: it exists only when the node's palette actually
declares an alpha. An all-opaque `colorScale`/`categoricalColor`/`getColorConstant` emits **exactly**
today's three-var form → the `check-compile-identity.mjs` baseline stays green and remains a real
regression net. `injectLinkedOutputMappings` mirrors this: it wires the 4th `a` edge only when the
palette carries a non-255 alpha (the `expandComposites`-style hot-path no-op).

## Steps

Each step ends green (`npx tsc -b` + the relevant check) and is independently revertable.

### 1 — Schema + hex widening
- `types.ts`: `RGB.a?`, `ColorStop.a?`.
- Colour-attribute hex parsers accept **both** `#rrggbb` and `#rrggbbaa` (`a = len >= 9 ? … : 255`).
- No behaviour change. Verify: `tsc -b`.

### 2 — The `_a` runtime slot + a new layout audit ⚠ highest risk
- All **six** mirror sites in one commit: `sim.worker.ts:4676`, `SimulatorView.tsx:537`,
  `wasm/layout.ts:343`, `webgpu/layout.ts:257`, `agentWasm/compile.ts:4808`,
  `agentWebgpu/compile.ts:3584`.
- **New** `scripts/audit-modelattr-layout.mjs` — asserts all six agree on the slot list for a given
  model. This is the insurance against the partial-edit failure mode (silent offset desync, no crash).
- Land `scripts/test-rgba-colors.mjs` alongside — the library has **zero** colour-attribute coverage,
  so this step is untestable without a synthetic.

### 3 — JS node ports + emit (Option A)
- `colorScale` (`stop_${i}_a`), `categoricalColor` (`entry_${i}_a`, `default_a`),
  `getColorConstant` (`a`), `getModelAttribute` (`a` joins the r/g/b `hiddenPorts` group).
- All four are already in `MULTI_OUTPUT_TYPES` → `_v<id>_a` resolves via the existing convention; no
  `varName()` special case, no scratch registration.
- Verify: compile-identity on the representative 6 stays **green**.

### 4 — The four non-JS compilers (lockstep)
- `wasm/compile.ts`, `webgpu/compile.ts` (all four nodes); `agentWasm/compile.ts`,
  `agentWebgpu/compile.ts` (`categoricalColor` + `getModelAttribute` — the shipped agent-colouring
  idiom).
- Each needs `setCachedPort(ctx, id, 'a', …)` so consumers resolve the port.
- Verify: cross-target compile via the dev harness; `parity-agent-wasm.mjs` green.

### 5 — Linked OM conditional wiring
- `linkedOutputMappings.ts` + `agentLinkedOutputMappings.ts`: 4th `a` edge only when the palette
  carries non-255 alpha.

### 6 — UI pickers, via ONE shared `ColorField`

The native `<input type="color" alpha>` is **not viable** — Safari 18.4+ only (12.58% global; Chrome
❌ through 150, Edge ❌, Firefox ❌), and it truncates an 8-digit hex *silently*. It would work only in
the browser where GenesisCA's WebGPU/Tauri story is weakest. See Impact Map §10 for the measurement.

- **New `src/modeler/vpl/widgets/ColorField.tsx`** — a checkerboard-backed swatch showing the true
  `rgba()` composite, opening a popover with the native picker (RGB) + an alpha slider (0–255).
  Follows the `BrushColorPopover.tsx` precedent. Ships the single alpha-aware `hexToRgba`/`rgbaToHex`
  pair that the engine-path sites adopt.
- `GradientStopsEditor.tsx` **first** — the shared widget serves both the Color Scale node and the
  linked float/integer editor. `GradStop +a`, `sampleAt`/`interp` widen, CSS bar `rgb()` → `rgba()`
  over a checkerboard.
- Then `MappingsPanelContent` (`ColorSwatch` → `ColorField`, bool + tag), `CaNode`
  (`ColorScaleEditor`, `CategoricalColorEditor`, `getColorConstant`),
  `AttributesPanelContent:711` (`#rrggbbaa`), `SimulatorView:7839` (the `_a` write).
- Net: seven bespoke picker layouts collapse to one component — **less** code than the status quo.

### 7 — Docs sweep (atomic with the feature, per CLAUDE.md)
- `CLAUDE.md` — retire the PR7 deferred note; document the Option-A gating.
- `HelpView.tsx`, `README.md`, `docs/NODES_REFERENCE.md` (port tables for the four widened nodes).

## Verification

**Representative 6** for `check-compile-identity.mjs` (chosen on audit evidence to span 2D/3D ×
grid/agents × every linked-OM palette kind):

Game Of Life (linked bool) · Gray-Scott (linked float → `colorScale`) · Kelp War (linked tag →
`categoricalColor`) · Accretor (3D grid, hand `categoricalColor` + alpha-0 culling + sparse) ·
Morphogenesis Differential Tissue (2D agents) · Morphogenesis 3D Tissue (3D agents).

**Synthetic coverage is mandatory** — these paths have zero library usage: colour model attribute
(the `_a` slot), `getColorConstant`, `makeColor`/`breakColor`, agent linked OM.

`scripts/test-rgba-colors.mjs` asserts **values**, not just "it compiles":
1. Colour model attr `#rrggbb80` → `Get Model Attribute.a` == **128** on JS, WASM, WebGPU.
2. `getColorConstant` alpha → `setCellLooks.a` → `colors[idx*4+3]` exact.
3. `colorScale` alpha **interpolates** (assert a midpoint value).
4. `categoricalColor` alpha selects flat + falls back to `default_a`.
5. All-opaque palette ⇒ byte-identical emit (the Option-A guarantee).
6. `#rrggbbaa` save → load round-trip.

**Runtime** (behaviour, not just compile): a transparent→opaque linked float OM stepped through the
**real worker** on JS / WASM / WebGPU, asserting the `colors` alpha bytes agree; plus a 3D check that
alpha-0 cells stay culled by `uploadColors`.

## Rollback

Steps are independently revertable. Step 2 is the only one touching runtime layout; if it regresses,
reverting it alone restores the 3-slot split without touching the node/emit work.
