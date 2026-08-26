# Plan — Explicit Controls for Macros

*Implementation plan for [IMPACT_MAP_EXPLICIT_CONTROLS.md](IMPACT_MAP_EXPLICIT_CONTROLS.md).
Four phases, each independently implementable, verifiable and committable by ONE focused
session, each ending green on `tsc -b` + `npm run build` + the gate set.*

Branch: `explicit_controls`. Illustrated companion: [PLAN_EXPLICIT_CONTROLS.html](PLAN_EXPLICIT_CONTROLS.html).

---

## 0. Scope

A macro author promotes an in-node parameter of the subgraph to a **named control on the
closed instance**, and organises ports + controls into **groups**. A control is a **REMOTE
CONTROL**, never a copy: it stores `{ nodeId, configKey }` and reads/writes
`def.nodes[k].data.config[key]` live. There is exactly ONE storage location (**D1**), so
"change either side, the other shows it" is true by construction and **no compiler learns the
feature exists**.

**Non-goals (v1)** — per-instance overrides, count steppers, multi-key editors (gradient
stops, palettes, RGB triples), `_port_bondAttr_*` / `partTag_*`, instance-side port
reordering, per-control "reset to default". Each is in §8 with its reason.

---

## 1. Deviations from the impact map — recorded, never silent

| # | Impact map | This plan | Why |
|---|---|---|---|
| **V1** | Phases **E1 / E2 / E3** (core+UI / groups+class C / chaining) | **P1 / P2 / P3 / P4** (core / authoring / consumption / class C + chaining + docs) | E1 bundles the resolver, the clone fix, pick mode, the boundary editor, instance rows and six harness tiers into one session. That is two-to-three sessions of work with one commit at the end and no intermediate green point. The split is along the **consumer boundary** (nothing UI in P1; authoring in P2; consumption in P3), which is what makes each phase independently verifiable. |
| **V2** | Chaining (`kind:'control'`) is **E3**, last | **`ControlTarget`'s second arm, `resolveTarget` recursion, the cycle guard and harness tier D ship in P1**; only the chaining **authoring UX** waits for P4 | The recursion is ~25 lines and it decides the resolver's *signature* and its *return shape* (a resolved write address may live in a DIFFERENT def than the control). Deferring it means changing that signature — and every call site — in the last phase. Shipping the type + the resolution early costs nothing and freezes the contract; the UX (clicking a nested instance's control row in pick mode) is genuinely separable. |
| **V3** | Class **C** (model-element pickers) is **E2**, with groups | Class C is **P4** | Class C is a 32-call-site extraction inside live UI (`grep -c "updateConfig('attributeId'…"` = 32) and is only *needed* the moment the instance renders a picker. Pairing it with groups makes P2 half-refactor; pairing it with instance rendering makes P3 heavy. It stands alone, and **P4 flips a single class gate on** (`eligibleControlKeys` filters by class), so P1–P3 ship with A + B and are complete on their own terms. |
| **V4** | Groups are **E2** | Groups' **schema** is P1, their **editor** is P2, their **instance rendering** is P3 | Groups cut across the same three consumer boundaries as controls; splitting them the same way keeps each phase's surface coherent. No behaviour differs. |
| **V5** | D7 site 2 — `createMacroFromSelection` "seed the two fields (empty arrays or omitted)" | **Omit them. No edit to that site; the plan asserts the absence instead.** | `stringifyCompact` drops `undefined` properties but WOULD write `"controls": []`. Seeding empty arrays changes the serialized JSON of every newly-created macro for zero gain, and breaks invariant 8 ("absent ⇒ today's files, exactly"). |
| **V6** | D9 — pick mode renders "an outline/overlay on **each eligible widget**" | **Class A (inline port widgets) outlines the REAL widget in place; classes B/C use a resolver-driven overlay LIST on the node** | Class A is ONE render site (`inlineWidgetWrapper`, CaNode.tsx L4032) — a literal in-place outline is cheap and is what the user described. Classes B/C are ~50 scattered JSX blocks; wrapping each is a large, drift-prone surface. The overlay list is rendered **from `eligibleControlKeys` output**, so it structurally cannot offer something the resolver does not know about. Within D9's letter ("outline/overlay"); recorded because it is a visible UX choice. |

Everything else follows D1–D10 as written.

---

## 2. Schema — exact shapes (P1)

[src/model/types.ts](../src/model/types.ts), immediately after `MacroPort` (L710-718) and
inside `MacroDef` (L720-727):

```ts
/** What an explicit control points AT. Never a value — the value lives in the
 *  target's own config (D1: ONE storage location). */
export type ControlTarget =
  /** an internal node's config key inside THIS def */
  | { kind: 'config';  nodeId: string; configKey: string }
  /** a nested macro INSTANCE's own control — chaining (D4) */
  | { kind: 'control'; nodeId: string; controlId: string };

/** A parameter of the subgraph promoted to a named control on the closed instance. */
export interface MacroControl {
  /** def-local, stable — the `MacroPort.portId` rule: PRESERVED across clones. */
  id: string;
  /** author-given label shown on the instance. */
  name: string;
  target: ControlTarget;
  /** membership in `MacroDef.groups` (D5). Absent ⇒ ungrouped. */
  groupId?: string;
  /** optional tooltip. */
  description?: string;
}

/** A named section of the macro's interface — display metadata only (D5). */
export interface MacroInterfaceGroup {
  /** def-local, stable — PRESERVED across clones, like `MacroControl.id`. */
  id: string;
  name: string;
}
```

```ts
export interface MacroPort {
  …existing 6 fields…
  groupId?: string;          // NEW — D5
}

export interface MacroDef {
  …existing 6 fields…
  controls?: MacroControl[]; // NEW — ordered within their group
  groups?: MacroInterfaceGroup[]; // NEW — ORDERED; render order of the sections
}
```

**Naming rule (R9 / F2):** no sub-array in these records may be named `nodes`, `edges` or
`coords` — `stringifyCompact` ([fileOperations.ts](../src/model/fileOperations.ts) L170-181)
inlines those by KEY NAME. `controls` / `groups` are safe and pretty-print normally.

**Absent ⇒ today's behaviour, byte for byte.** No migration, no `LOAD_MODEL` guard.

---

## 3. The resolver — `src/modeler/vpl/explicitControls.ts` (new, P1)

The **ONE** definition of eligibility, widget kind, option lists and the write address —
the `buildCensusPorts` / `buildInputParamPorts` / `applyLookupAxisPorts` dual-consumption
discipline. Dependency direction: it imports `effectivePorts`, `registry`, `graphState`,
`attributeScope`; **nothing imports it from a compiler**.

```ts
export type ControlWidgetKind =
  | 'number' | 'bool' | 'tag' | 'glyph'          // class A (inline port widgets)
  | 'select' | 'checkbox' | 'text' | 'textarea' | 'color'  // class B
  | 'element';                                    // class C (P4)

/** ONE eligible parameter of ONE node — what pick mode offers. */
export interface ControlKeyDescriptor {
  configKey: string;
  /** the parameter's own label — the default control name and the pick-mode row text. */
  label: string;
  kind: ControlWidgetKind;
  klass: 'A' | 'B' | 'C';
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** class A only: the port is WIRED inside the macro (D2) — offered, but the
   *  control will render disabled with that reason. */
  wired?: boolean;
}

/** The fully-resolved WRITE ADDRESS of a control — note `defId` may be a NESTED
 *  def when the control is chained (D4). */
export interface ResolvedTarget { defId: string; nodeId: string; configKey: string }

export type ControlBlock =
  | 'orphan-node'      // the target node was deleted inside the macro
  | 'orphan-key'       // the key no longer exists on that node
  | 'orphan-control'   // the nested macro's control this points at was removed
  | 'cycle'            // circular chain
  | 'wired'            // the bound port is wired inside the macro
  | 'scope-open';      // the owning def is the currently-open scope (R7)

/** What the instance renders. `null` is never returned — an unresolvable control
 *  comes back with `block` set so it can be shown DISABLED WITH ITS REASON (D8:
 *  report, never drop). */
export interface ControlDescriptor {
  kind: ControlWidgetKind;
  value: string;
  label: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  resolved: ResolvedTarget | null;
  block?: ControlBlock;
  reason?: string;     // the user-facing sentence for `block`
}

// --- the API -------------------------------------------------------------
export const CONTROL_MAX_CHAIN_DEPTH = 20;   // mirrors expandMacros / MAX_MACRO_DEPTH

export function eligibleControlKeys(
  nodeType: string, config: NodeConfig, model: CAModel,
  connectedHandles?: ReadonlySet<string>,
  classes?: ReadonlySet<'A'|'B'|'C'>,          // P4 flips 'C' on
): ControlKeyDescriptor[];

export function resolveTarget(
  macroDefs: readonly MacroDef[], defId: string, target: ControlTarget,
  seen?: Set<string>, depth?: number,
): { ok: true; at: ResolvedTarget } | { ok: false; block: ControlBlock };

export function resolveControlDescriptor(
  model: CAModel, defId: string, control: MacroControl,
  openScopeIds?: readonly string[],            // R7
): ControlDescriptor;

/** The ONE-dispatch write builder (D6). Returns the def that OWNS the key and
 *  its fully-patched node array — the caller does exactly one `updateMacro`. */
export function applyControlValue(
  model: CAModel, defId: string, control: MacroControl, value: string,
): { defId: string; nodes: GraphNode[] } | null;

/** Class A: the ADAPTIVE widget swap, lifted out of CaNode and called back by it
 *  (R4/R5). Covers setAttribute/updateAttribute/setNeighborhoodAttribute/
 *  setNeighborAttributeByIndex/setCellAtPosition `value`, Compare's x/y operands,
 *  the multi-attr slot tag options, and the vector-attr suppression. */
export function inlineWidgetFor(
  nodeType: string, config: NodeConfig, port: PortDef, model: CAModel,
): { kind: 'number'|'bool'|'tag'|'glyph' | null; tagOptions?: string[] };

/** Class B: the declarative (nodeType, key) → widget table. */
export const SCALAR_CONFIG_KEYS: ReadonlyMap<string, ReadonlyMap<string, ScalarKeySpec>>;

/** Class C (P4): the ~11 model-element list expressions, extracted from CaNode's
 *  per-nodeType JSX and CALLED BACK by it. */
export function elementOptionsFor(
  nodeType: string, configKey: string, model: CAModel,
): ReadonlyArray<{ value: string; label: string }> | null;

/** D2b + D3 exclusions, in ONE predicate so a future key inherits the rule. */
export function isExcludedControlKey(configKey: string): boolean;
```

`isExcludedControlKey` returns **true** for: `_port_bondAttr_*`, `partTag_*` (**D2b** —
renamed/permuted by 5 code paths, F3), the count steppers `extraCount` / `caseCount` /
`visibleCount` / `payloadCount` / `axisCount` (**structural**), `_varName_*`, the multi-key
families `stop_*` / `entry_*` / `default_*`, and the display-only `_exprW` / `_exprH` /
`_namesExpanded` / `_exprExpanded`.

---

## 4. Phase P1 — schema, resolver, the clone fix, the harness

**No UI behaviour changes.** Ends green and committable; the feature is not yet reachable
from the app.

### Files

| file | edit |
|---|---|
| [src/model/types.ts](../src/model/types.ts) L710-727 | the four additive shapes of §2 |
| **[src/model/macroImport.ts](../src/model/macroImport.ts) L96-108** | **🔴 THE critical edit.** Add `controls` + `groups` to the returned literal; remap **`target.nodeId` for BOTH kinds** through `idMap` (mirror `remapPort` L96-99); **PRESERVE** `control.id`, `control.groupId`, `control.target.controlId` and every `group.id`. Extend the doc block at L21-34 with the new remap/preserve rows. |
| **`src/modeler/vpl/explicitControls.ts`** (new) | the whole API of §3 |
| [src/modeler/vpl/CaNode.tsx](../src/modeler/vpl/CaNode.tsx) L3934-3996 | **extraction only, zero behaviour change**: replace the inline adaptive-widget block with a call to `inlineWidgetFor(...)`. This is the R5 dual-consumption discipline, established before anything consumes it. |
| [src/model/fileOperations.ts](../src/model/fileOperations.ts) L851-854 | `isMacroDefLike` — additionally DROP a `controls` / `groups` that is present but not an array (never throw; `parseMacroFile`'s two named errors are the only throws) |
| `scripts/test-explicit-controls.mjs` (new) | tiers A / B / C / D / E / F |

`createMacroFromSelection` ([GraphEditor.tsx](../src/modeler/vpl/GraphEditor.tsx) L3648-3653)
is **deliberately untouched** — see deviation **V5**. P1's tier C asserts a freshly-created
macro serializes with no `controls` key at all.

### The clone fix, verbatim shape

```ts
const remapPort = (p: MacroPort): MacroPort => ({
  ...p,                                            // carries groupId for free
  internalNodeId: idMap.get(p.internalNodeId) ?? p.internalNodeId,
});
const remapControl = (c: MacroControl): MacroControl => ({
  ...c,                                            // id, name, groupId, description PRESERVED
  target: c.target.kind === 'config'
    ? { ...c.target, nodeId: idMap.get(c.target.nodeId) ?? c.target.nodeId }
    : { ...c.target, nodeId: idMap.get(c.target.nodeId) ?? c.target.nodeId },
  //     ^ controlId PRESERVED — the portId rule (macroImport.ts L31-34): it is a
  //       def-local id an OUTER def names, and both defs clone in one operation.
});

return {
  id: newMacroId, name: raw.name, nodes, edges,
  exposedInputs:  raw.exposedInputs.map(remapPort),
  exposedOutputs: raw.exposedOutputs.map(remapPort),
  ...(raw.controls ? { controls: raw.controls.map(remapControl) } : {}),
  ...(raw.groups   ? { groups:   raw.groups.map(g => ({ ...g })) } : {}),
};
```

The conditional spreads matter: a def with no controls must clone to a def with **no
`controls` key**, not `controls: []` (invariant 8).

### Harness tiers (P1)

`node scripts/test-explicit-controls.mjs` — esbuild-bundled entry over the SHIPPED modules
and the **real `modelReducer`** (the `test-macro-references` / `test-param-input-mappings`
precedent).

| tier | asserts |
|---|---|
| **A — resolution** | every inventory row (§ impact map "widget inventory" 1-14) resolves to the right `kind` + `value`; the class-A **adaptive** cases follow a live retype (drive `setAttribute` bool→tag→float through the reducer and assert the descriptor's `kind` follows and its `options` come from the NEW attribute); a WIRED port reports `block:'wired'` with a reason; a deleted node → `orphan-node`, a vanished key → `orphan-key`; `eligibleControlKeys` **never** offers `_port_bondAttr_*`, `partTag_*`, a count stepper, a `_varName_*` or a display-only key; **2D vs 3D** — the same `createAgent` / `applyForce` fixture offers `_port_z` / `_port_fz` in a 3D model and does NOT in a 2D one (the `hiddenPorts` path through `getEffectivePorts`); **graph kind** — a `setAttribute` control's tag options resolve against `agentAttributes` on the Agents graph and `attributes` on Cells (`getActiveGraphKind`, D10). |
| **B — the clone** | build a def with 3 controls (config + chained) + 2 groups + a grouped port → `cloneMacroWithFreshIds` → every `target.nodeId` **remapped**, `control.id` / `groupId` / `controlId` / `group.id` **preserved**, `name` / `description` verbatim; **a control never resolves to a node it did not name** (resolve pre- and post-clone and compare the resolved node's `nodeType` + config); a control-free def clones with **no `controls` key**. |
| **C — round trips** | `.gcaproj` (`serializeModel` → `parseModelJSON`) and `.gcamacro` (`buildMacroFile` → `JSON.stringify` → `parseMacroFile`) preserve controls + groups **verbatim**; an OLD-shape file (no keys) loads with none; a `schemaVersion: 99` file still parses; a malformed `controls: 7` is DROPPED not thrown; the cross-tab clipboard payload (`JSON.stringify` + `validate`) round-trips them; **`stringifyCompact` does not inline** the new arrays (assert the exact JSON text has `controls` pretty-printed). |
| **D — chaining resolution** | A→B→C resolves to the ultimate `{defId, nodeId, configKey}` in C; a 2-cycle and a self-cycle both terminate and report `block:'cycle'`; a depth-21 chain reports rather than recursing; an inner control deleted → `orphan-control`; cloning A **and** B in one operation (`applyImportPlan`'s two-def shape) keeps the chain resolving — the `controlId`-preserved argument. |
| **E — the write path** | drive `applyControlValue` → **one** `UPDATE_MACRO` through the real reducer: exactly one node's one config key changes; **no other node's identity moves** (assert `===` on every untouched node object); `controls` / `groups` / `edges` are untouched (`===`); a chained write lands in the **nested** def, and the outer def is untouched; a second LINKED instance reads the new value from the same `model.macroDefs`. |
| **F — EMIT identity (the structural proof)** | a def **with** controls/groups and the same def **stripped of both records** (identical config values) produce byte-identical `expandMacros` output **and** byte-identical compiled JS / WASM bytes / WGSL; adding, renaming, grouping and deleting a control each leave the emit unchanged; `accessorCSE`'s purity key for every internal node is unchanged. |

### Negative controls — by SOURCE MUTATION (write B before the fix)

| mutation | must fail |
|---|---|
| revert `cloneMacroWithFreshIds` to the 6-field literal | tier B "controls survive a clone" |
| drop the `target.nodeId` remap (keep the field) | tier B "a control never resolves to a node it did not name" |
| freeze the widget kind (store it on the control and read it back) | tier A "the descriptor follows a retype" |
| delete the `_port_bondAttr_` arm of `isExcludedControlKey` | tier A "never offers a renamed key" |
| make `applyControlValue` dispatch the outer def for a chained control | tier E "a chained write lands in the nested def" |
| leak the control record into `node.data.config` | tier F emit identity |

### Gates (P1, and every later phase)

```
node scripts/check-compile-identity.mjs --capture <scratch>/baseline-ec.json   # from CLEAN branch HEAD
… make the change …
node scripts/check-compile-identity.mjs --compare <scratch>/baseline-ec.json   # ALL models, ALL surfaces unchanged
npx tsc -b            (or: npx tsc -p tsconfig.app.json --noEmit)
npm run build
node scripts/test-explicit-controls.mjs
node scripts/test-macro-references.mjs        # M1/M2 unregressed
node scripts/check-agent-wasm-gate.mjs
```

The baseline lives **outside the repo** (the session scratchpad). A later session that has
lost it re-captures with `git stash` → `--capture` → `git stash pop` (the documented A/B
recipe). Byte identity is expected trivially green here — no compiler file is opened for
writing — so it is the **gate**, not the expectation.

### Done when

Every tier green, all six mutations caught, byte identity clean, and `grep -rn "controls"
src/modeler/vpl/compiler/` returns nothing.

---

## 5. Phase P2 — authoring: the interface editor + pick mode + groups

The macro author can create, name, group, re-bind and delete explicit parameters. The closed
instance still renders nothing (that is P3), so the phase is verified through the editor
itself + the def state.

### Files

| file | edit |
|---|---|
| [src/modeler/vpl/graphState.ts](../src/modeler/vpl/graphState.ts) | the pick-mode global, in the exact shape of `activeGraphKind` (L57-72): private `let`, `getControlPick()`, `subscribeControlPick(fn) => unsubscribe`, `setControlPick(v)` with an equality guard that notifies. `export type ControlPick = { defId: string; controlId: string \| 'new'; groupId?: string } \| null` |
| [src/modeler/vpl/CaNode.tsx](../src/modeler/vpl/CaNode.tsx) L3876-3922 | the boundary-node body block gains **EXPLICIT PARAMETERS** and **GROUPS** sections under the existing port rows, on the **MacroInput** node only (the "interface in" node; groups serve both port lists) |
| CaNode.tsx L254-370 | four control CRUD callbacks + three group CRUD callbacks, each in the `addPort` / `removePort` / `renamePort` shape (L324-367): build the whole array, **one** `updateMacro` |
| CaNode.tsx L4032 + the body config blocks | **pick-mode rendering** — see below |
| CaNode.tsx (top of the component) | `useSyncExternalStore(subscribeControlPick, getControlPick)` |
| [src/modeler/vpl/GraphEditor.tsx](../src/modeler/vpl/GraphEditor.tsx) L1315-1346 | `setControlPick(null)` in the scope-switch effect and in the unmount cleanup (**R10**) |
| [src/App.tsx](../src/App.tsx) / the model-load seam | `setControlPick(null)` on `modelVersion` change (R10) |

### Pick mode (deviation **V6**)

```ts
setControlPick({ defId, controlId: 'new' })      // + Explicit Parameter
setControlPick({ defId, controlId: c.id })       // ✎ Edit — re-bind an existing control
```

- Entered **only** from the boundary node's editor, so the eligible nodes are already on
  screen and `defId` is the currently-open scope by construction.
- While active, every CaNode whose id belongs to that def renders:
  - **class A** — the real `inlineWidgetWrapper` (L4032) gains a `pickable` outline class and
    a **capture-phase** `onClickCapture` that BINDS and `stopPropagation()`s instead of
    editing;
  - **classes B/C** — a compact overlay list at the top of the body, ONE row per
    `eligibleControlKeys` entry, each row `[label] [current value]`, click to bind. Rendered
    **from the resolver's output**, so it cannot offer what the resolver does not know.
- A node with zero eligible keys renders **no** overlay (the enabled-control doctrine).
- **Esc cancels** — capture-phase on `document` + `stopPropagation` so it cannot reach the
  editor's own Escape handling (the `KeyboardShortcutsOverlay` precedent).
- **Auto-cancels** on scope change, unmount and model load (R10).
- **DEV hook** `window.__setControlPick(pick)` (`import.meta.env.DEV`-gated, the
  `__openConnectionDropMenu` precedent) — React Flow ignores synthetic pointer events, so
  this is the only way to drive pick mode from `preview_eval`.

Binding writes, in one `updateMacro`:

```ts
const ctrl: MacroControl = {
  id: `ctl_${Date.now().toString(36)}${Math.random().toString(36).slice(2,5)}`,
  name: descriptor.label,                 // the parameter's own label, editable after
  target: { kind: 'config', nodeId, configKey },
  ...(pick.groupId ? { groupId: pick.groupId } : {}),
};
updateMacro(defId, { controls: [...(def.controls ?? []), ctrl] });
setControlPick(null);
```

### The editor rows

```
PORTS
  [Rate            ] [Val▾] [Group ▾] [×]
EXPLICIT PARAMETERS
  [Diffusion rate  ]        [Group ▾] [✎] [×]
     Get Random · Max                              ← mono subtitle: the bound target
  [Wrap edges      ]        [Group ▾] [✎] [×]
     Switch · First match only
  + Explicit Parameter
GROUPS
  [Tuning          ] [×]
  [Advanced        ] [×]
  + Group
```

- The subtitle is `` `${displayNodeLabel(getNodeDef(nodeType))} · ${descriptor.label}` `` from
  the resolver — an unresolvable target shows its **reason** in `--bad` instead.
- The **Group ▾** select carries `(none)` + every `def.groups` entry.
- Assigning a **PORT** to a group **REORDERS `exposedInputs` / `exposedOutputs`** so the handle
  order matches the display order (**D5 / F8**): ungrouped first in their existing order, then
  each group in `groups` order. **No edge is touched** — the bridge matches by `portId`
  ([macroExpand.ts](../src/modeler/vpl/compiler/macroExpand.ts) L88-95), CaNode maps by
  `portId` (L379-392), edges carry `input_value_<portId>`.
- Deleting a group **clears** the `groupId` of its members (it does not delete them).

### Harness tier (P2) — H, authoring semantics through the real reducer

| asserts |
|---|
| add / rename / delete a control produce exactly the expected `controls` array with **one** dispatch; the other def fields are `===` unchanged |
| re-binding an existing control (`✎`) replaces `target` and **preserves `id` + `name` + `groupId`** |
| assigning a port to a group reorders `exposedInputs` to `[ungrouped…, group1…, group2…]`, the **portId SET is identical**, and `def.edges` is `===` unchanged |
| deleting a group clears its members' `groupId` and deletes no control and no port |
| adding a group to a def with none creates `groups`; removing the last one leaves `groups: []` (harmless) or removes the key — assert whichever the implementation chooses, consistently |
| `eligibleControlKeys` with `classes` excluding `'C'` returns no `element` rows (the P4 gate) |

**NEG mutations:** (1) make group assignment NOT reorder → the order check fails; (2) rebuild
`exposedInputs` by index-splice that drops the last port → the portId-set check fails; (3)
make `✎` mint a fresh control id → the preserve check fails; (4) drop the pick-mode
auto-cancel from the scope effect → a scope-switch check (pick is null after a simulated
scope change) fails.

### Real-UI recipe (P2)

Dev server, Modeler, a model with a macro.

1. Enter the macro → the MacroInput node shows **EXPLICIT PARAMETERS** with `+ Explicit
   Parameter`.
2. Click it → `window.__controlPickState?.()` (or read `getControlPick()` via a dev import)
   is `{defId, controlId:'new'}`; eligible inline widgets carry the `pickable` class; a node
   with class-B keys shows the overlay list.
3. Click an eligible widget → the control appears in the editor with the parameter's label
   and the right mono subtitle; pick mode is null.
4. **Esc** during pick mode cancels and does **not** reset the simulator / close the editor.
5. Add two groups, assign one port and one control to each → read `model.macroDefs` back and
   confirm `exposedInputs` reordered while the **edge list is byte-identical** (capture
   `JSON.stringify(edges)` before/after).
6. Switch scope (exit the macro) while pick mode is armed → it is null.

⚠ **Gotchas to honour:** React Flow node drags / connection drags / box-select ignore
synthetic pointer events — use the DEV hook, not a synthetic `pointerdown`. `preview_fill`
does not trigger React `onChange` — use the native setter + `input` event for the name
fields. `preview_eval` returning a Promise serializes as `{}` — stash to `window.__x`. The
console-log buffer persists across reloads — hook `console.error` fresh before asserting "no
errors".

### Done when

Tier H green, four mutations caught, `--compare` clean, and the real-UI recipe passes with 0
fresh console errors.

---

## 6. Phase P3 — consumption: the closed instance renders its interface

### Files

| file | edit |
|---|---|
| [src/modeler/vpl/CaNode.tsx](../src/modeler/vpl/CaNode.tsx) body div (L1343-3923), macro branch | **the controls section**: ungrouped rows first, then each group in `def.groups` order under a `.sect`-style header. Row = `[label] [widget]`, label-left / widget-right. |
| CaNode.tsx same block | the **linked-count badge** beside the section header when `countMacroInstances(model, defId) >= 2` (**D1** — the sharing must be visible at the point of editing) |
| CaNode.tsx same block | disabled-with-reason rendering for every `ControlBlock` |
| CaNode.tsx L653-661 (`configIssues`, macro branch) | one new roll-up line: `N control${…} need attention` when any control resolves with a `block`. The dep array already contains `model.macroDefs` (L688) — **no dep change needed**. |
| CaNode.tsx | the write handler: `applyControlValue` → **one** `updateMacro`, reading `model.macroDefs` **inside the callback** (the `commitAgentSweep` ref-leads-state trap), never a captured closure |

**No `updateNodeInternals` for control rows** (**F6**): handles are absolutely-positioned
siblings at `PORT_TOP_BASE + i*portSpacing` (L866-869) rendered **after** the body div, so
body height moves no handle. A **group reorder of PORTS** *does* need one — that lands here
too, keyed on the exposed-port id signature (the documented port-set remeasure discipline).

A **collapsed** node returns before the body (L1189-1290), so controls vanish when collapsed —
consistent with every other body widget. An **empty interface renders no section at all**.

### The reason strings (user-facing, one per `ControlBlock`)

| block | rendering |
|---|---|
| `wired` | *"wired inside the macro"* — greyed, value shown read-only |
| `orphan-node` | *"its target node was deleted inside the macro"* |
| `orphan-key` | *"the parameter it points at no longer exists"* |
| `orphan-control` | *"the macro's control this points at was removed"* |
| `cycle` | *"circular reference"* |
| `scope-open` | *"the macro is open for editing — edit it there"* (**R7**) |

**`scope-open` is the R7 mitigation**: only reachable under macro recursion (an instance of B
inside B's own subgraph, F5), where an instance-side write would be clobbered by the next
100 ms debounce tick. CaNode reads the open scope from a graphState mirror of
`currentScopeRef` (a second tiny global in the same shape) rather than prop-drilling.

### Harness tier (P3) — G, cascades

| asserts |
|---|
| delete the target node inside the macro (through the reducer's `UPDATE_MACRO`) → the descriptor reports `orphan-node`, **the control is still present in `def.controls`** (report, never drop) and `configIssues` gains a line |
| `REMOVE_ATTRIBUTE` (and agent attribute / neighborhood / mapping / indicator / variable / sprite) → the existing cascade blanks the value **inside `macroDefs[*].nodes`** (F4) and the control **still resolves**, now reading `''`; the internal node's own `detectMissingConfig` badge is what surfaces it |
| a tagOptions **reorder** leaves a bound `_port_value` control reading the **remapped** index (drive `UPDATE_ATTRIBUTE` and compare against the remap the reducer applies to node configs) |
| `REMOVE_MACRO` of a nested def → a chained control reports `orphan-control`, is not deleted |
| a wired target: add an edge into the bound port through `updateMacro({edges})` → `block:'wired'`; remove it → live again |
| the write path is **inert** while blocked (a disabled control's handler is never wired; assert `applyControlValue` returns `null` for a blocked control) |

**NEG mutations:** (1) auto-delete an orphaned control in the resolver → the report-don't-drop
check fails; (2) resolve a wired port as live → the wired check fails; (3) read the def from a
captured closure instead of live context in the write handler (simulate by passing a stale
model) → the "a second edit sees the first" check fails.

### Real-UI recipe (P3)

1. **Round trip both ways.** Bind a control → exit the macro → the closed instance shows the
   row with the **live value**. Edit it on the instance → re-enter the macro → the internal
   widget shows the new value. Reverse: edit inside → exit → the instance shows it.
2. **Two linked instances on one canvas** — edit one, the other updates **in the same paint**
   (F7, no new machinery). Then right-click → **Duplicate → Duplicate Independent** and prove
   they diverge.
3. **Groups** render as headers in `def.groups` order, ungrouped first; the **edge list is
   byte-identical** before/after a port grouping (capture `JSON.stringify` of the model's
   edges).
4. A **wired** target renders disabled with its reason; unwire it inside the macro → live.
5. Delete the target node inside the macro → the row greys out with its reason **and** the
   instance shows the amber badge; Ctrl+Z restores the node and the row goes live again (the
   reason auto-delete was rejected).
6. Collapse the instance → controls vanish; expand → they return. **Handles do not move**
   (measure `getBoundingClientRect().top` of each handle before/after adding a control — F6).
7. A macro with **no** controls renders no section (no empty header).

### Done when

Tier G green, three mutations caught, `--compare` clean, the seven-step recipe passes, and the
handle-offset measurement in step 6 shows **0 px** movement.

---

## 7. Phase P4 — class C, chaining UX, M1/M2 interplay, docs, final gates

### 7a. Class C — the model-element pickers (the 32-site extraction)

`elementOptionsFor(nodeType, configKey, model)` becomes the **single source** of the ~11
element lists, and **CaNode calls it back** from its 32 `updateConfig('<idKey>', …)` picker
blocks. Keys: `attributeId`, `neighborhoodId`, `mappingId`, `indicatorId`, `variableId`,
`spriteId`, `tableId`, `tagAttributeId`, `facingAttributeId`, `partitionAttributeId`,
`presetId`.

- The list expressions move **verbatim** — including their `getActiveGraphKind()`-dependent
  scoping (`ownAttrList` / `tagAttrScope`, CaNode.tsx L263-280). **D10 requirement**: the
  control's picker must resolve with the **same** `getActiveGraphKind()` the in-node picker
  uses; identical semantics, no new rule.
- `eligibleControlKeys` is then called with class `'C'` enabled — one gate flip.
- The refactor is mechanical and grep-driven; do it as ONE sweep, then a single review pass,
  then verify. (The house lesson: implement every site first, review, then run the sweep —
  iterative implement-test-fix thrashes.)

**Tier I — one source:** for every (nodeType, key) pair, `elementOptionsFor` returns exactly
the list the in-node picker renders (assert against a table derived from the model fixture,
built for BOTH graph kinds); `grep` asserts CaNode has **no** surviving inline list expression
for those 11 keys. **NEG:** make `elementOptionsFor` ignore `getActiveGraphKind()` → the
Agents-graph parity check fails.

**R6 is documented, not fixed**: a universal macro instanced on Cells *and* Agents offers two
different lists for one shared value. That sharp edge is **pre-existing** (it is exactly what
happens today when you open the macro from each graph) and it degrades **loudly** — a dangling
id badges via `detectMissingConfig` and bubbles onto the instance. Goes in Help.

### 7b. Chaining UX

Pick mode, when it hits a **`macro` instance node** inside the open def, offers that def's
**controls** as the eligible rows (`eligibleControlKeys` is not used there — the rows come
from `nestedDef.controls`), and binding writes
`{ kind: 'control', nodeId, controlId }`. Everything else — resolution, the cycle guard, the
write address, the clone — already shipped in P1.

Tier D (P1) covers the resolution. P4 adds the **UI** rows + a real-UI check:

> Macro **A** contains an instance of macro **B**. In A, `+ Explicit Parameter` → click B's
> instance → its control list appears → bind one. Close A → editing A's row changes **B's
> internal widget** (verify by entering B). Export A as `.gcamacro`, import into a **second
> model**, and the chain still resolves.

### 7c. M1 / M2 interplay — verify, don't extend

| subsystem | expected | how P4 proves it |
|---|---|---|
| **M1** `collectMacroReferences` ([macroReferences.ts](../src/model/macroReferences.ts) L236-265) | **NO change.** A control stores `{nodeId, configKey}`; the referenced element id stays in the node config, which M1 already scans. **D2b** is what keeps this true (`_port_bondAttr_*` is the one key shape that would make a control a fourth carrier). | tier J: a def **with** class-C controls exports a reference bundle **identical** to the same def without them |
| **M2** `applyImportPlan` passes 1-4 ([macroImportPlan.ts](../src/model/macroImportPlan.ts)) | **NO new pass.** The def is cloned through `cloneMacroWithFreshIds` (L302), which P1 fixed; passes 2 and 4 rename `_port_bondAttr_*` / permute `partTag_*`, and **no control may name either** | tier J: assert `isExcludedControlKey` returns true for every key shape passes 2/4 touch; then run a full `planImport` → `applyImportPlan` on a def with controls and assert they survive and resolve |
| **cross-tab clipboard** ([graphClipboard.ts](../src/modeler/vpl/graphClipboard.ts)) | `collectMacroDefBundle` + the paste clone carry controls; `remapNestedMacroRefs` (L106-118) retargets a nested `macroDefId`, and preserved `controlId`s make the chain land | tier J + the real two-tab recipe below |

### 7d. Docs sweep (the mandatory consistency pass)

| doc | what |
|---|---|
| **CLAUDE.md** | a new **"Explicit Controls"** subsection under *Macro System*, after M2: the remote-control principle (D1), the three classes + the exclusions, the clone rule (invariant 4), report-never-drop, groups reordering ports (F8), the ONE-dispatch write, the R6 cross-graph caveat, and the harness name. Update the *Linked vs Independent Copies* section to say a control is internals-editing reachable from outside. Add `explicitControls.ts` + `test-explicit-controls.mjs` to the **Project Structure** tree. |
| **HelpView.tsx** | a Macros subsection: how to add an Explicit Parameter, that linked copies **share** the value and Duplicate Independent is the way to vary it, what "wired inside the macro" means, and the cross-graph caveat |
| **README.md** | only if the one-to-three-sentence Macros summary changes — it likely does not (the README's `## Features` is deliberately high-level) |
| **docs/NODES_REFERENCE.md** | **no change** — no node type is added or altered; the node COUNT is unchanged |

### Final gate set (P4)

Everything in §4 plus: `node scripts/test-macro-references.mjs`, `node
scripts/check-compile-identity.mjs --compare`, `node scripts/test-explicit-controls.mjs` (all
tiers A-J), `npx tsc -b`, `npm run build` (**both** builds — the viewer build too).

### Real-UI recipes (P4)

1. Class C: bind an `attributeId` control → the instance's dropdown lists **exactly** what the
   in-node dropdown lists; pick a different attribute → enter the macro → the node's dropdown
   shows it.
2. Chaining, as §7b.
3. Export `.gcamacro` → import into a **second model** → controls survive, resolve, and the
   M2 dialog behaves exactly as before (no new rows).
4. **Cross-tab clipboard**: copy a macro instance in tab A, paste in tab B (a different model)
   → the def arrives with its controls and they resolve.
5. **"Make Independent Copy"** from the linked-count badge → the copy's controls point at the
   copy's own nodes (the R2 proof, in the UI).

---

## 8. Follow-ups register — out of v1, with reasons

| deferred | reason | what it would take |
|---|---|---|
| **Per-instance overrides** (Blender's model) | **D1.** Needs an override map on the instance config, an application pass inside `expandMacros` (a **compiler** change on the shared front-end all six surfaces run), a dirty/reset UI and a conflict rule against in-macro edits — and it silently redefines "linked". The user asked for sync. | a compiler phase of its own |
| **`_port_bondAttr_*` / `partTag_*` bindings** | **D2b.** They are the only key shapes any path renames, deletes or permutes (F3), and `_port_bondAttr_*` embeds a model-element id. | a fifth `applyImportPlan` pass in lockstep with 2 and 4, participation in three ModelContext cascades, and a fourth `collectMacroReferences` arm — four coupled edits in four files, each failing plausibly-but-wrong with no error |
| **Count steppers** (`extraCount`, `caseCount`, `visibleCount`, `payloadCount`, `axisCount`) | **structural** — they change which PORTS the internal node has, hence what `expandMacros` emits and which internal edges survive. A non-author must not be able to break the macro's wiring from outside. | a port-set reconciliation contract |
| **Multi-key editors** — gradient stops, categorical palettes, RGB triples, `_varName_*` | one-control-one-value does not hold | a composite control type |
| **Instance-side port reordering** | the interface belongs to the author; the instance is a consumer | — |
| **A per-control default + "Reset"** | needs a stored default, i.e. a **second value** — exactly what D1 rejects | could be *derived* from `port.defaultValue` / the node def, without storage |
| **Preventing macro self-recursion** | pre-existing; three independent depth guards already anticipate it (`expandMacros` 20, `MAX_MACRO_DEPTH` 20, `isMacroAvailableOnGraph`'s `seen`). R7 works around it with `scope-open`. | a small fix of its own, worth doing |
| **A macro-level "interface" panel** (edit without entering) | the boundary editor is where ports already live; a second surface is scope creep | — |

---

## 9. Risk register → the phase that retires each

| # | Risk | Failure mode | Retired by |
|---|---|---|---|
| **R1** | `cloneMacroWithFreshIds` not extended (F1) | every import / paste / independent-duplicate silently returns a def with **no controls**; the macro still works, the interface is just gone, no error anywhere | **P1** — tier B + the revert-the-literal mutation, written **before** the fix |
| **R2** | `target.nodeId` not remapped in the clone | worse: the control **survives and resolves to a DIFFERENT node**, editing the wrong parameter — plausible-but-wrong, silent | **P1** — tier B's "never resolves to a node it did not name" + its mutation; **P4** recipe 5 in the real UI |
| **R3** | a renamed key gets bound (D2b breached) | the control edits a key nothing reads, or the WRONG tag slot | **P1** — `isExcludedControlKey` + tier A's exclusion sweep; **P4** tier J re-asserts against M2's passes |
| **R4** | a stored widget kind | a retype (attribute bool→tag) leaves the control writing `'5'` into a tag slot | **P1** — derive live (D2); tier A drives a real retype |
| **R5** | class-C list drift after the extraction | the instance offers a list the node cannot use | **P4** — dual consumption + tier I's one-call-site grep |
| **R6** | cross-graph attribute scope (D10) | two linked instances on Cells and Agents offer different lists for one shared value | **not fixed — documented.** Pre-existing; degrades loudly (badge bubbles). P4 Help + CLAUDE.md |
| **R7** | recursion clobber (F5) | an instance-side edit against the currently-open def is overwritten 100 ms later | **P3** — the `scope-open` block |
| **R8** | byte-identity drift | a control record leaks into a config or a purity key | **P1** — tier F + `--compare` on every phase |
| **R9** | `stringifyCompact` name collision (F2) | a sub-array named `nodes`/`edges`/`coords` silently inlines | **P1** — the naming rule + tier C's exact-JSON assertion |
| **R10** | pick mode stranded | a pick armed across a scope switch binds into the wrong def | **P2** — auto-cancel on scope change / unmount / model load |

---

## 10. Invariants — the checklist every phase must leave true

1. **ONE storage location.** A control never holds a value; `resolveControlDescriptor` reads
   `def.nodes[k].data.config[key]` every render.
2. **The widget kind is DERIVED, never stored.**
3. **A control never changes what compiles.** Adding, renaming, grouping or deleting one
   leaves `expandMacros`' output — and every compiled surface — byte-identical.
4. **`cloneMacroWithFreshIds` remaps `target.nodeId` and preserves `control.id` /
   `controlId` / `groupId` / `group.id`** — the `portId` rule.
5. **Report, never drop.** An orphaned, circular, wired or scope-blocked control renders
   disabled **with its reason** and badges; it is never silently deleted or silently applied.
6. **Grouping a port reorders its array; edges are untouched** (F8), and the instance
   re-measures its handles.
7. **One dispatch per edit**, built from live context state, targeting the def that OWNS the
   key (which may be a nested def).
8. **Absent `controls` / `groups` ⇒ today's rendering and today's files, exactly** — including
   the absence of the keys themselves on a freshly created macro.

---

## 11. Deviations found during P1 — 2026-08-26

*Recorded, never silent (the §1 discipline). Everything not listed here followed
the plan as written. P1's gates: `tsc` · `npm run build` (both builds) ·
`check-compile-identity --compare` **31 models, all surfaces unchanged** ·
`test-explicit-controls` **143 checks** with all six source mutations proven
caught · `test-macro-references` · `test-param-input-mappings` ·
`test-agent-abi` · `test-c9-gates` · `check-agent-wasm-gate`.*

| # | Plan | What shipped | Why |
|---|---|---|---|
| **P1.1** | §4 — "`explicitControls.ts` (new) \| the whole API of §3", where §3 annotates `elementOptionsFor` "(class C (P4))" | The class-C **signature**, the `'element'` kind, `CLASS_C_KEYS` (the 11 key names) and the `classes` gate all ship; **`elementOptionsFor` returns `null`** and the default `classes` is `{A,B}`, so class C offers nothing until P4 fills it | Doing the 32-site extraction in P1 IS P4. Shipping the signature now freezes the contract before P4 moves the JSX lists into it — V2's own reasoning, applied to class C. Tier A asserts the gate explicitly (A36-A39), so it cannot rot |
| **P1.2** | §3 — class B is "a declarative table `(nodeType, key) → { kind, options }`" | It is, **and it is an ALLOWLIST that deliberately OMITS every COUPLED-WRITE key** — `getConstant.constType` (resets `constValue` + `facePaletteId`), `statement.compareType` (resets the operands), and every `*Id` picker that re-seeds a dependent value | **New reasoning, not in the plan.** A control writes exactly ONE key. A key whose in-node editor writes SEVERAL cannot be faithfully driven by a one-key write — it produces a state the in-node editor never produces, silently. That is D2b's and D3's argument applied to the WRITE SHAPE instead of the key shape. Being an allowlist, the table excludes them by not naming them; `isExcludedControlKey` stays the ACTIVE filter for class A, whose key set is port-DERIVED |
| **P1.3** | §4 — "replace the inline adaptive-widget block with a call to `inlineWidgetFor(...)`" | That, **plus `ownAttrListFor(model)` / `tagAttrScopeFor(model)` extracted alongside it**, with CaNode calling both | The adaptive swap READS those two scopes. Leaving them in CaNode would have meant a second copy inside the resolver — the exact drift the extraction exists to prevent. Pure move; tier A49 pins that both follow `getActiveGraphKind()` |
| **P1.4** | §4 — "`isMacroDefLike` — additionally DROP a `controls` / `groups` that is present but not an array" | A **sibling** `sanitizeMacroDefRecords<T>(d)` applied to `macroDef` AND each nested def; `isMacroDefLike` is unchanged | `isMacroDefLike` is a type GUARD returning `boolean` — it structurally cannot drop a field. The helper returns the SAME reference when there is nothing to drop (the migration-identity convention), so a clean file's def is still passed through untouched (tiers C12-C15) |
| **P1.5** | §3 — six `ControlBlock` values | **Seven**: `orphan-def` added | Reachable and DISTINCT: `REMOVE_MACRO` of a nested def leaves a chained target whose macro is gone, which is a different sentence from "the control it points at was removed" (tier D8 vs D7) |
| **P1.6** | §3 — `applyControlValue(model, defId, control, value)` | `+ openScopeIds?` | Without it a **scope-open** control's write would not be inert, and R7's whole mitigation is that the disabled row's handler does nothing. Tier E13 |
| **P1.7** | §3 API list | **`describeControlTarget(model, defId, control)` added** | §5's editor row spec needs the `Node label · Parameter label` mono subtitle (and an unresolvable target's REASON in its place). Deriving it from the SAME descriptor is what stops the editor naming a parameter the resolver does not know about. P2 consumes it; tiers A50/A51 |
| **P1.8** | §4 "Done when — `grep -rn "controls" src/modeler/vpl/compiler/` returns nothing" | It returns **ONE** hit: an unrelated English word in an `agentWasm/compile.ts` comment (*"`skipSelf` controls whether…"*) | The literal grep is too broad. The harness pins the real invariant instead — tier **F6** (no compiler file imports `explicitControls`) and **F7** (`/\bMacroControl\b\|\.controls\b/`), both of which return nothing, and F7 NAMES the offending file when the "leak the record" mutation is applied |

### Verification notes worth keeping

- **The `UPDATE_MACRO` action is FLAT** — `{ type, id, changes }`, not `{ type, payload }`. The first harness draft used a `payload` wrapper; the reducer silently no-ops on an unknown shape, so 12 checks failed with *plausible* values (the pre-retype descriptor) rather than an error. Drive the reducer, then assert the model actually MOVED.
- **The CaNode extraction was A/B'd through the REAL UI and is BIT-IDENTICAL.** `git stash push -- src/modeler/vpl/CaNode.tsx` gives the pre-extraction build from the same tree; loading `Extended Wireworld`, expanding all 50 collapsed nodes and fingerprinting **every** inline widget (element, type, value, full option list, `top`), **every** external port label and **every** input handle's offset yields **381 rows, hash `537ea16b`, 0 rows differing** on both sides (51 widgets / 205 labels / 125 handles). The adaptive ladder was then driven live on the new build: tag → `SELECT`, integer → `InlineNumberInput`, bool → `InlineBoolSelect`, back to tag, with the option list following the attribute each time; edits commit and survive a Modeler → Simulator → Modeler round trip through the model. 0 console errors.
- **⚠ Never `git checkout <file>` to revert a source mutation on an unstaged file** — it restores from the INDEX and destroys the session's work. Every mutation in this phase was reverted from a copy in the scratchpad, and the A/B used `git stash push -- <file>` / `git stash pop` (the documented recipe) with a byte-compare against the copy afterwards.
- **The mutation harness needs to be CRLF-agnostic** — this repo's sources are CRLF, so a multi-line `String.replace` with `\n` never matches. Mutate line-by-line on a `/\r?\n/` split.

### What P2 inherits

- `resolveControlDescriptor` / `describeControlTarget` / `applyControlValue` / `eligibleControlKeys` are the four calls the authoring UI needs; none of them can return `null` for a live control, and every unresolvable one carries `block` + a sentence from `CONTROL_BLOCK_REASON`.
- `eligibleControlKeys` takes `connectedHandles` — build it from `def.edges` the way `countMacroSubgraphIssues` does (nodeValidation.ts L825-832); a wired port is still OFFERED, flagged `wired: true`, so pick mode can say so rather than hiding it.
- Nothing in P1 reads or writes `graphState`'s pick-mode global — it does not exist yet; P2 adds it in the `activeGraphKind` shape.
- The class-B table is where a newly-authorable scalar key goes. Add coupled-write keys ONLY with a rule for their sibling writes (P1.2).
