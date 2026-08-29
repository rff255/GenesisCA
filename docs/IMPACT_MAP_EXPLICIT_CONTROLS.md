# Impact Map — Explicit Controls for Macros

*A macro author can promote any in-node parameter of the subgraph to a **named control on
the closed instance**, and organise ports and controls into **groups** — so a ready-made
macro is tunable without opening it.*

---

## Context

A macro already externalises **connections**: `MacroDef.exposedInputs` / `exposedOutputs`
([types.ts](../src/model/types.ts) L710-727) become handles on the closed instance
([CaNode.tsx](../src/modeler/vpl/CaNode.tsx) L375-394), and the author edits that list from
the boundary node's little port editor (CaNode.tsx L3876-3922). Everything else a node
carries is **unreachable from outside**:

- **inline port widgets** — the `_port_<portId>` number / bool / tag / glyph boxes that
  stand in for a wire (CaNode.tsx L3996-4069). **148 declared across the node registry**
  (140 `number`, 6 `bool`, 1 `tag`, 1 `glyph`) before the type-adaptive swaps;
- **body widgets** — the Expression formula, the count steppers, the Periodic Step
  period/phase, the FOV half-angle;
- **picklists** — the attribute / neighbourhood / mapping / indicator / variable / sprite /
  table dropdowns, plus ~30 op / mode selects and ~12 checkboxes.

All of it lives in `def.nodes[k].data.config` and is editable **only by entering the macro
and understanding its internals**. The user's framing:

> Macros can already externalize input/output ports … but most nodes carry IN-NODE
> parameters that are not connections … Explicit Controls … the author can add Explicit
> Parameters the same way ports are added today … adding one enters a PICK MODE that
> highlights all eligible parameters on all nodes visible in the macro canvas … those
> parameters will control their father parameter which is being replicated there, so if the
> user changes the original parent control or the externalized, they should sync … GROUP
> SECTIONS … explicit controls of explicit controls of other macros inside a macro.

The precedent is Blender's node-group interface and Unreal's *instance-editable* Blueprint
variables. The structural bet of this design — and the reason it can ship without touching a
compiler — is that **a control is a REMOTE CONTROL, not a copy**: it stores a *pointer* to an
existing config key, never a second value.

---

## CODE-REALITY FINDINGS THAT SHAPE THE DESIGN

### F1. `cloneMacroWithFreshIds` returns a hand-written 6-field literal — a new field is SILENTLY DROPPED

[macroImport.ts](../src/model/macroImport.ts) L101-108:

```ts
return {
  id: newMacroId, name: raw.name, nodes, edges,
  exposedInputs:  raw.exposedInputs.map(remapPort),
  exposedOutputs: raw.exposedOutputs.map(remapPort),
};
```

**No spread of `raw`.** Every clone path loses anything not listed: `.gcamacro` import
([macroImportPlan.ts](../src/model/macroImportPlan.ts) L302), `importMacro` /
"Make Independent Copy" ([ModelContext.tsx](../src/model/ModelContext.tsx) L2456,
CaNode.tsx L798-806), paste of a foreign or local def
([GraphEditor.tsx](../src/modeler/vpl/GraphEditor.tsx) L3099, L3116), duplicate-with-selection
(L3199).

`remapPort` (macroImport.ts L96-99) is also the **only** place `internalNodeId` is put through
`idMap` — the exact treatment a control's `nodeId` needs. **This is the single most important
line in the whole feature**, and the doc block at L21-34 is the checklist to extend.

### F2. Serialization is FREE everywhere else — verified, not assumed

- **`.gcaproj`** — `stringifyCompact` ([fileOperations.ts](../src/model/fileOperations.ts)
  L157-198) is a whole-object walker with **no field picking**; `undefined` object
  properties are dropped (L191-192), so optional fields cost nothing when absent.
- **`.gcamacro` write** — `buildMacroFile` L831-849 passes `macroDef: def` **by reference**
  (L839); `downloadMacroFile` L902-904 is a plain `JSON.stringify` of the whole file.
- **`.gcamacro` read** — `parseMacroFile` L866-894 rebuilds the FILE envelope field-by-field
  but casts `raw.macroDef` **through untouched** (L881). MacroDef-level fields survive. It
  deliberately **never gates on `schemaVersion`** (L859-864), so an older build ignores the
  new keys and imports exactly as it always did.
- **Cross-tab clipboard** — `JSON.stringify` + a permissive `validate` that shape-checks only
  `id`/`nodes` ([graphClipboard.ts](../src/modeler/vpl/graphClipboard.ts) L126-148).

⚠ **Two `stringifyCompact` traps**: an array whose parent key is literally `nodes`, `edges`
or `coords` inherits the one-line-per-item inlining (L170-181) by NAME. Do not name a
sub-array in the new records `nodes` / `edges` / `coords`.

### F3. THREE places RENAME a config key — a binding that names one goes stale silently

Everything else is a stable key name. These are not:

| what | where |
|---|---|
| `REMOVE_BOND_ATTRIBUTE` **deletes** `_port_bondAttr_<attrId>` | ModelContext.tsx L1139-1143 |
| `REMOVE_BOND_ATTRIBUTE` **deletes** every `divideAgent.partTag_*` | ModelContext.tsx L1147-1155 |
| `UPDATE_BOND_ATTRIBUTE` **PERMUTES** `partTag_<i>` keys on a tagOptions reorder | ModelContext.tsx L1205-1215 |
| `applyImportPlan` pass 2 **renames** `_port_bondAttr_<oldId>` → `<newId>` | macroImportPlan.ts L668-675 |
| `applyImportPlan` pass 4 **permutes** `partTag_<i>` | macroImportPlan.ts L763-783 |

A `configKey` of `_port_bondAttr_<attrId>` additionally embeds a **model-element id**, making
a bound control a *fourth carrier* of an attribute reference that
`collectMacroReferences` ([macroReferences.ts](../src/model/macroReferences.ts) L236-265)
does not scan — it reads only `def.nodes[*].data.config` and `def.edges[*].targetHandle`.

**This finding produces a scope boundary (D3b), not a pile of new passes.**

### F4. 20 cascades blank a bound key's VALUE inside macro defs — and that is CORRECT

`patchAllNodes` (ModelContext.tsx L98-113) walks `macroDefs[*].nodes` and rebuilds each def as
`{ ...m, nodes: patched }` (L109) — a spread, so control records survive. `clearDeletedId`
(L207-214) sets the value to `''` rather than deleting the key. Every `REMOVE_*`
(attribute / agent attribute / bond attribute / neighborhood / mapping / agent mapping /
sprite / indicator / variable) and both tagOptions remaps go through it.

Because a control **reads the config live**, it needs *nothing*: it simply starts showing the
cleared value, and the internal node's own `detectMissingConfig` badge bubbles onto the
instance (CaNode.tsx L653-661). **That is a direct dividend of def-level storage (D1).**

### F5. Editing inside a macro writes back LIVE on a 100 ms debounce, and it writes ONLY `nodes`/`edges`

GraphEditor.tsx L945-962:

```ts
updateMacro(scopeId, { nodes: gn, edges: ge });   // the macro write-back
```

`UPDATE_MACRO` is a **shallow one-level merge** (ModelContext.tsx L1598-1608), so a separate
`controls` key is preserved across every in-macro edit. There is deliberately **no on-exit
flush** for macro scope (L979-980 — "the shared macroDef is already debounce-written").

The scope-switch effect (L1315-1346) seeds the canvas **directly from `def.nodes` with ids
unchanged** and its deps are `[currentScope, modelVersion, activeGraph]` — so an
instance-side control edit made from a *parent* scope cannot fight the canvas.

**The one exception is macro RECURSION** — an instance of B inside B's own subgraph. Nothing
prevents it structurally; `expandMacros` carries a depth-20 guard,
`isMacroAvailableOnGraph` a `seen` set ([nodeValidation.ts](../src/modeler/vpl/nodes/nodeValidation.ts)
L1188-1222) and `countMacroSubgraphIssues` a `MAX_MACRO_DEPTH` of 20 (L804, L813). There, an
instance-side write to the *currently open* def would be clobbered by the next debounce tick.

### F6. Handle offsets are INDEPENDENT of body height — the instance UI is free

Port handles are absolutely-positioned siblings rendered **after** the body div, at
`top: PORT_TOP_BASE + i * portSpacing` (CaNode.tsx L866-869, L3927-4078). The body
(`<div className={styles.body}>`, L1343-3923) grows the node's HEIGHT and moves no handle —
the Expression-node precedent, verified here against the port maths. Control rows in the body
therefore need **no `updateNodeInternals`**.

A collapsed node returns before the body (L1189-1290), so controls vanish when collapsed —
consistent with every other body widget.

### F7. Context updates already re-render every instance — sync is free

CaNode consumes `useModel()` (L258) and is `memo`'d on `id`/`selected`/`dragging`/`data`
(L4155-4161). `React.memo` does **not** block context propagation — the comment at L4152-4154
says so explicitly, and the boundary port editor already relies on it. A `model.macroDefs`
change re-renders **every** instance, so two linked instances sync with no new machinery.
`configIssues`' dep array already lists `model.macroDefs` (L688).

### F8. Exposed ports are matched by `portId`, never by index — so grouping may REORDER them

`expandMacros` bridges by parsing the handle and comparing `parsed.portId === epPortId`
([macroExpand.ts](../src/modeler/vpl/compiler/macroExpand.ts) L88-95); CaNode maps
`p.portId` → handle id (L379-392); existing edges carry `input_value_<portId>`.

**Reordering `exposedInputs` therefore moves the visual row order and nothing else** — no
edge is touched. That is what lets groups reorder the arrays instead of introducing a
display order that disagrees with the handle order.

### F9. Exposed ports are NOT reconciled when an internal node is deleted — the orphan precedent

Deleting a node inside a macro view flows through `handleNodesChange` → `scheduleSync` →
`updateMacro({nodes, edges})`. `exposedInputs` / `exposedOutputs` are left alone; only the
boundary nodes themselves are undeletable (GraphEditor.tsx L1580-1592, L2953-2958).
**Report-don't-drop is the house behaviour here already.**

---

## THE RESOLVED DECISIONS

### D1 — The value lives in the MacroDef. A control is a REMOTE CONTROL, not a copy.

**Decision: def-level storage. There is exactly ONE storage location — `def.nodes[k].data.config[key]` — and the control points at it.**

Rationale:

1. **Every in-macro parameter is already def-level.** There is no per-instance storage of any
   kind today; `expandMacros` copies internal nodes **verbatim**
   (`newNodes.push({ ...inner, id: prefix + inner.id })`, macroExpand.ts L76).
2. **It is the only reading of the user's sync requirement that is self-consistent.**
   "change either, the other shows it" *is* one storage location. Two locations plus
   bidirectional sync is a distributed-consistency problem with no winner rule, and the first
   conflict (edit inside the macro while an instance override exists) has no correct answer.
3. **Zero compiler impact, structurally.** Per-instance overrides would need an
   override-application step inside `expandMacros` — the shared front-end all six compile
   surfaces run — putting byte-identity at risk for every existing model. Def-level storage
   means the compilers never learn the feature exists.
4. **It is exactly consistent with documented linked-copy semantics**: "editing any
   instance's internals updates ALL of them" (CLAUDE.md, *Linked vs Independent Copies*). A
   control is internals-editing reachable from outside; it must behave the same way.

**Consequence, and it must be stated on the instance UI**: two linked instances share one
value. Per-instance variation is already a first-class, discoverable action — right-click →
**Duplicate → Duplicate Independent** (GraphEditor.tsx L2897-2907, L4597) or the linked-count
badge's **Make Independent Copy** (CaNode.tsx L798-806). The instance's controls section shows
the existing linked-count badge beside its header when `countMacroInstances >= 2`, so the
sharing is visible at the point of editing.

**Rejected — per-instance overrides (Blender's model).** Needs: an override map on the
instance node's config, an application pass in `expandMacros` (compiler change), a
per-instance dirty/reset UI, a conflict rule against in-macro edits, and it silently changes
what "linked" means. The user asked for sync, not for overrides.

### D2 — A binding is `{ nodeId, configKey }`; the widget kind is DERIVED LIVE, never stored

```ts
export type ControlTarget =
  | { kind: 'config';  nodeId: string; configKey: string }   // an internal node's config key
  | { kind: 'control'; nodeId: string; controlId: string };  // a nested macro INSTANCE's control (D4)

export interface MacroControl {
  id: string;                 // def-local, stable — like MacroPort.portId
  name: string;               // author-given label
  target: ControlTarget;
  groupId?: string;           // D5
  description?: string;       // optional tooltip
}
```

- **`nodeId` is the id as stored in `def.nodes`**, which is also the live React Flow id inside
  the macro view (the scope effect seeds ids unchanged, F5) — so pick mode can record the id
  it clicked with no translation.
- **Nothing about the widget is stored.** `resolveControlDescriptor(def, control, model)`
  reads `(nodeType, config, key)` at render time and returns
  `{ kind, value, options?, disabled?, reason? }`. That is the only way a live retype can't
  strand a copy: `setAttribute`'s `value` widget flips bool↔tag↔number with the picked
  attribute (CaNode.tsx L3942-3955) and `statement`'s operands flip with `compareType`
  (L3981-3994). A stored kind would show the wrong editor and write a wrong-typed value with
  no error anywhere.
- **A WIRED target renders DISABLED IN PLACE with the reason.** In-node, a wired port hides
  its widget (`showWidget = effectiveWidget && !isConnected`, L3996) because the compiler reads
  the edge and the `_port_*` value is dead. On the instance the control must say so
  ("wired inside the macro") rather than silently offering a number nothing consumes — the
  *temporarily unavailable ⇒ grey it, reason in the tooltip* arm of the enabled-control
  doctrine. Wiredness comes from `def.edges` via the same `connectedByNode` build
  `countMacroSubgraphIssues` already does (nodeValidation.ts L825-832).

### D2b — Keys that are RENAMED by the machinery are NOT bindable

**Excluded from binding: `_port_bondAttr_*` and `partTag_*`.**

They are the **only** two key shapes any code path renames, deletes or permutes (F3), and
`_port_bondAttr_*` additionally embeds a model-element id, which would make a control a fourth
reference carrier `collectMacroReferences` does not scan. Excluding them turns a whole class of
silent staleness into a non-issue and costs almost nothing: a bond-attribute *initial value* on
Form Bond and the Divide Agent partition tag matrix are niche parameters, and both remain
editable in the macro exactly as today.

**The alternative — allowing them — would require**: a fifth rewrite pass in
`applyImportPlan` in lockstep with passes 2 and 4, participation in three ModelContext
cascades, and a fourth arm on `collectMacroReferences`' Pass 1. Four coupled edits in four
files, each of whose failure mode is *plausible-but-wrong with no error*. Deferred to the
follow-ups register.

### D3 — What is exposable, and by what mechanism

**ONE resolver, DUALLY CONSUMED** — the `buildCensusPorts` / `buildBondAttrPorts` /
`buildInputParamPorts` / `applyLookupAxisPorts` discipline. New module
`src/modeler/vpl/explicitControls.ts`:

```ts
eligibleControlKeys(nodeType, config, model): ControlKeyDescriptor[]   // pick-mode highlight
resolveControlDescriptor(def, control, model): ControlDescriptor | null // instance render
elementOptionsFor(nodeType, configKey, model): Attribute[] | ...        // class C lists
```

Three classes:

| class | what | mechanism |
|---|---|---|
| **A — inline port widgets** | every `_port_<portId>` | The port set comes from `getEffectivePorts(nodeType, config, model)` ([effectivePorts.ts](../src/modeler/vpl/effectivePorts.ts)) — which already covers Switch cases, multi-attr slots, census, Form Bond, input-mapping channels, lookup axes and `hiddenPorts`. The widget kind comes from `port.inlineWidget` plus the two adaptive swaps, lifted out of CaNode into the resolver and consumed by BOTH. |
| **B — scalar config keys** | ~30 enum selects, ~12 checkboxes, ~10 number fields, ~9 text/textarea (incl. the Expression `expression` key) | A declarative table `(nodeType, key) → { kind, options }`. These render from primitives; no model lookup. |
| **C — model-element pickers** | `attributeId`, `neighborhoodId`, `mappingId`, `indicatorId`, `variableId`, `spriteId`, `tableId`, `tagAttributeId`, `facingAttributeId`, `partitionAttributeId`, `presetId` | `elementOptionsFor` — the ~20 list expressions **extracted from CaNode's per-nodeType JSX and called back by it**, so the offered list can never drift from the in-node picker's. |
| **D — multi-key editors (FACETS, D11)** | a Color Scale's gradient, a Categorical Color's palette, a Color Constant's RGB(A) | `FACET_SPECS` — an allowlist of `(nodeType → facet → { read, write, widget })` whose `read`/`write` **ARE the node's own exported pair** (`readColorScaleStopsRaw`/`writeColorScaleStops`, `readCategoricalEntries`+`readCategoricalDefault`/`writeCategoricalPalette`, `readColorConstant`/`writeColorConstant`). The instance renders the SAME widget component the node does. |

**OUT of v1, each with its reason:**

| excluded | why |
|---|---|
| Count steppers (`extraCount`, `caseCount`, `visibleCount`, `payloadCount`, `axisCount`) | **STRUCTURAL** — they change which PORTS the internal node has, hence what `expandMacros` emits and which internal edges survive. A non-author must not be able to break the macro's wiring from the outside. |
| Gradient stops (`stop_N_*`), categorical palettes (`entry_N_*`), the RGB triples, **one key at a time** | **MULTI-KEY** — one control ↔ one value does not hold. ⚠ **This exclusion is about a control binding one MEMBER of a coupled write, and it STANDS**: `isExcludedControlKey` still refuses every one of those keys. The EDITORS themselves are bindable since **D11 / class D**, as whole FACETS written by the node's own writer — see the table row below. |
| `_varName_*` (Expression variable names) | multi-key *and* structural (they relabel ports). |
| `_exprW` / `_exprH` / `_namesExpanded` / `_exprExpanded` | display-only keys; never eligible. |
| `_port_bondAttr_*`, `partTag_*` | D2b. |
| The lookup-table editor, the sprite-sheet dialog | not node config at all — they edit `Attribute` objects. |

`visionColor` (a single-key `ColorField`) **is** eligible; the `r`/`g`/`b` triple on Set Cell
Looks is not.

### D4 — Chaining: the target is `(nested instance node, that def's control id)`

`{ kind: 'control', nodeId, controlId }` where `nodeId` is a `macro` **instance node inside
this def**. `resolveTarget` recurses: look up the instance's `config.macroDefId` → find the
control with `controlId` in that def → recurse until a `config` target is reached.

- **Cycle guard**: a `seen` set of `(defId, controlId)` plus a depth cap mirroring the three
  existing guards (`expandMacros` 20, `MAX_MACRO_DEPTH` 20, `isMacroAvailableOnGraph`'s `seen`).
  A cycle resolves to `null` → the control renders disabled with "circular reference".
- **Id remap (F1)**: `target.nodeId` goes through `idMap` for **both** kinds — the
  `remapPort` treatment. `controlId` is **PRESERVED**, for exactly the reason
  `portId`/`internalPortId` are (macroImport.ts L31-34): it is a def-local id that an
  *outer* def's chained target names, and both defs are cloned in the same operation, so
  preserving it keeps the chain resolving. `remapNestedMacroRefs`
  (graphClipboard.ts L106-118) already retargets the instance's `macroDefId` to the cloned
  inner def, whose control ids were preserved — the chain lands.
- **Orphan (inner control deleted)**: **report, don't drop** — resolve to `null`, render
  disabled with "the macro's control this points at was removed", badge the instance. The M2
  precedent (report an unmatched reference; never guess, never clamp).

### D5 — Groups: an ordered list on the def, membership by id on ports AND controls

```ts
export interface MacroInterfaceGroup { id: string; name: string; }
// MacroDef.groups?: MacroInterfaceGroup[];   // ORDERED
// MacroPort.groupId?: string;
// MacroControl.groupId?: string;
```

- **Absent `groups` / absent `groupId` ⇒ flat, byte-for-byte today's rendering.** No
  migration.
- **Assigning a PORT to a group REORDERS `exposedInputs` / `exposedOutputs`** so the handle
  order matches the displayed order. F8 proves that is free: the bridge match is by `portId`,
  CaNode maps by `portId`, and edges carry `input_value_<portId>` — **no edge is touched**.
  The instance needs one `updateNodeInternals` on a reorder (the documented port-set
  remeasure discipline).
- **Render order on the instance**: ungrouped members first, in their existing order, then
  each group in `groups` order under its header — so adding a group never reorders what was
  already there.
- Groups are **display metadata**. Nothing in a compiler reads them.

### D6 — Sync: one dispatch, and propagation is free

An instance-side control edit computes the whole patched node array and dispatches **once**:

```ts
updateMacro(defId, { nodes: def.nodes.map(n => n.id === nodeId
  ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } } : n) });
```

- **One dispatch, never two** — the documented "never call `updateConfig` twice in sequence"
  trap; build the merged object first.
- **Read `model.macroDefs` inside the callback**, not from a captured closure — the
  `commitAgentSweep` ref-leads-state trap.
- **Propagation costs nothing (F7)**: the context change re-renders every CaNode, so both
  linked instances and any open boundary editor show the new value on the next paint.
- **In-macro edits reach the instance through the existing debounce** (F5): the underlying
  widget writes React Flow node data → `scheduleSync` → `updateMacro({nodes, edges})` → the
  instance re-renders. The `controls` key survives the shallow merge.
- **THE ONE CLOBBER HAZARD — a def open as the current scope.** Only reachable under macro
  recursion (F5). Mitigation: the instance's controls render **disabled with the reason**
  when `currentScopeRef.current.includes(targetDefId)`. Recorded as a risk, not a blocker.

### D7 — Serialization and import/export: free everywhere except the clone

**Free (F2)**: `.gcaproj` write + read, `.gcamacro` write + read, the cross-tab clipboard,
`UPDATE_MACRO`, `patchAllNodes`/`patchAllEdges`, `remapNestedMacroRefs`, `applyImportPlan`'s
four passes — every one of them either walks generically or spreads `{ ...def, … }`.

**Not free — the exhaustive list of edits:**

| # | site | what |
|---|---|---|
| 1 | `cloneMacroWithFreshIds` — macroImport.ts L101-108 | **add `controls` + `groups` to the literal**, and remap each `target.nodeId` through `idMap` (mirror `remapPort` L96-99). Preserve `control.id` and `groupId`. **Without this the feature does not survive a single import.** |
| 2 | `createMacroFromSelection` — GraphEditor.tsx L3648-3653 | seed the two fields (empty arrays or omitted). |
| 3 | `isMacroDefLike` — fileOperations.ts L851-854 | optional: drop a malformed `controls` array rather than accepting it. |

**Back-compat both ways**: an old `.gcaproj` / `.gcamacro` simply has no `controls` (absent ⇒
flat, no section); a new file read by an older build is ignored by
`parseMacroFile`'s pass-through and the unknown-keys rule (F2).

### D8 — Cascades and validation: report, never drop

| event | behaviour |
|---|---|
| the target node is deleted inside the macro | the resolver returns `null`; the control renders **disabled with "its target node was deleted"** and the instance gets a badge. **Auto-deleting is rejected**: the delete is undoable, Ctrl+Z restores the node but would not restore a destroyed control, so a single mis-click would silently destroy the author's named interface. This matches F9's existing behaviour for exposed ports. |
| the target config key vanishes (a count stepper shrinks the slot set) | same. |
| a model element is deleted | **nothing to do** — the existing cascades blank the value inside `macroDefs[*].nodes` (F4) and the control reads it live. The internal node's own badge bubbles up. |
| the whole macro def is deleted | the instance already badges via the existing `macroDefId` resolution. |
| a bound port becomes WIRED | disabled with the reason (D2). |

**Badge site**: CaNode.tsx L653-661, the `nodeData.nodeType === 'macro'` branch of
`configIssues`, whose dep array already contains `model.macroDefs` (L688). One new line
alongside the internal-warnings roll-up.

### D9 — UI mechanics

**Pick mode** — a graphState module-global with `useSyncExternalStore`, in the shape of
`activeGraphKind` (graphState.ts L57-72) / `connectingFrom` (L245-269): private `let`, getter,
`subscribe` returning an unsubscribe, equality-guarded setter that notifies.

```ts
type ControlPick = { defId: string; controlId: string | 'new'; groupId?: string } | null;
```

- Entered from the boundary node's interface editor, so the eligible nodes are on screen.
- While active, every CaNode subscribes and renders an **outline/overlay on each eligible
  widget** (`eligibleControlKeys` says which), with a **capture-phase click** that BINDS
  instead of editing.
- **Esc cancels** — capture-phase on `document` + `stopPropagation`, so it cannot reach the
  editor's own Escape handling (the KeyboardShortcutsOverlay precedent).
- **Auto-cancels** on scope change, on unmount and on a model load — a pick armed against a
  def that is no longer on screen is a dead mode.

**Interface editor** — the boundary-node body block (CaNode.tsx L3876-3922) gains an
**Explicit Parameters** section under the existing port rows, on the **MacroInput** node (the
"interface in" node; groups live there too and serve both port lists). Rows mirror the port
rows exactly: `[name input] [group select] [✎ Edit → pick mode] [× Delete]`, plus
`+ Explicit Parameter` and `+ Group`. All four CRUD callbacks follow the
`addPort`/`removePort`/`renamePort` pattern (L324-367) — build the whole array, one
`updateMacro`.

**Instance rendering** — rows inside the body div, label-left / widget-right, with group
headers. F6 proves this changes only the node's height. The linked-count badge sits beside
the section header when `countMacroInstances >= 2` (D1). An **empty interface renders no
section at all** — the enabled-control doctrine.

### D10 — Scope

**Universal by construction.** Macros are shared across Cells / Agents / Overseer;
`isMacroAvailableOnGraph` (nodeValidation.ts L1188-1222) already gates which graphs a def may
appear on, by node *requirements*. The feature adds no per-graph behaviour of its own.

**The one graph-kind coupling** is class C: `ownAttrList` / `tagAttrScope`
(CaNode.tsx L263-280) resolve against `getActiveGraphKind()`, the ACTIVE CANVAS's graph. A
universal macro instanced on both graphs offers two different lists for one shared value.
**That sharp edge is pre-existing** (it is exactly what happens today when you open the macro
from each graph) and it degrades **loudly** — a dangling id badges via `detectMissingConfig`
and bubbles onto the instance. **Requirement**: the control's picker must resolve with the
SAME `getActiveGraphKind()` the in-node picker uses — identical semantics, no new rule — and
the caveat is documented in Help.

**Out of v1**: per-instance overrides (D1), multi-key composite editors and count steppers
(D3), renamed/permuted keys (D2b), reordering exposed ports from the *instance*, exposing an
internal node's wiring, and a per-control "reset to default".

---

## The widget inventory

| # | Widget class | Config key shape | Scale | v1 |
|---|---|---|---|---|
| 1 | Inline port — number | `_port_<portId>` | 140 declared | ✅ A |
| 2 | Inline port — bool | `_port_<portId>` | 6 | ✅ A |
| 3 | Inline port — tag | `_port_<portId>` | 1 declared + adaptive | ✅ A |
| 4 | Inline port — glyph | `_port_glyph` | 1 | ✅ A |
| 5 | Adaptive `value` (setAttribute / updateAttribute / setNeighborhoodAttribute / setNeighborAttributeByIndex / setCellAtPosition) | `_port_value` | 5 types | ✅ A — kind derived live (CaNode L3942-3955) |
| 6 | Adaptive operands (Compare) | `_port_x` / `_port_y` / `_port_y2` | 1 type | ✅ A (L3981-3994) |
| 7 | Multi-attr slot inline | `_port_value_<N>` | 5 types | ✅ A |
| 8 | Switch case value inline | `_port_case_<i>_val` | 1 | ✅ A |
| 9 | Enum `<select>` | `operation` ×14, `op` ×3, `mode` ×4, `constType`, `distribution`, `randomType`, `refSource`, `partition`, `daughterBond`, `conserve`, `reduce`, `source`, `headingSource`, `rotationMode`, `method`, `scope`, `lowOp`, `highOp`, `nonReceiving`, `category` | ~30 keys | ✅ B |
| 10 | Checkbox | `firstMatchOnly`, `cardinalsOnly`, `withCenter`, `vectorInput`, `includeOrientation`, `setSprite`/`setFrame`/`setSpeed`/… | ~12 | ✅ B |
| 11 | Body number (`NumberField`) | `halfAngle`, `period`, `phase`, `partitionThreshold`, `from`, `to`, `steps` | ~10 | ✅ B |
| 12 | Text / textarea | `expression`, `message`, `label`, `text`, `series`, `chart`, `list`, `tagName`, `directionTag` | ~9 | ✅ B |
| 13 | Single-key colour (`ColorField`) | `visionColor` | 2 sites | ✅ B |
| 14 | Model-element picker | `attributeId` ×10, `mappingId` ×6, `neighborhoodId` ×4, `indicatorId` ×4, `variableId`, `spriteId`, `tableId`, `tagAttributeId`, `facingAttributeId`, `partitionAttributeId`, `presetId` | ~11 keys / ~40 JSX blocks | ✅ C (E2 — via extraction) |
| 15 | Bond-attr initial value | `_port_bondAttr_<attrId>` | Form Bond / Rewire Bond | ❌ **D2b** — the key is renamed by 2 paths and carries an element id |
| 16 | Divide partition tag matrix | `partTag_<i>` | 1 | ❌ **D2b** — the keys are PERMUTED on a tagOptions reorder |
| 17 | Count steppers | `extraCount`, `caseCount`, `visibleCount`, `payloadCount`, `axisCount` | ~5 | ❌ structural (changes the port set) |
| 18 | Gradient stops | `stop_N_position/_r/_g/_b/_a` | Color Scale, linked OM | ❌ multi-key |
| 19 | Categorical palette | `entry_N_*`, `default_*`, `count` | 1 | ❌ multi-key |
| 20 | RGB triples | `_port_r` / `_port_g` / `_port_b` as a colour | Set Cell Looks, Colour Constant | ❌ multi-key as a colour; the three numbers are individually bindable via #1 |
| 21 | Expression variable names | `_varName_<portId>` | 2 types | ❌ multi-key + structural |
| 22 | Expression layout | `_exprW`, `_exprH`, `_namesExpanded`, `_exprExpanded` | 2 types | ❌ display-only, never eligible |
| 23 | Lookup-table editor, sprite-sheet dialog | not node config | — | ❌ edits `Attribute` objects |

---

## Subsystem impact

| File | Change | Risk |
|---|---|---|
| `src/model/types.ts` L710-727 | `MacroControl`, `MacroInterfaceGroup`, `ControlTarget`; `MacroDef.controls?` / `.groups?`; `MacroPort.groupId?` | none — additive |
| **`src/model/macroImport.ts` L96-108** | **add both fields to the returned literal; remap `target.nodeId`; preserve `control.id` / `groupId`** | 🔴 **highest — silent drop (F1)** |
| `src/modeler/vpl/explicitControls.ts` **(new)** | `eligibleControlKeys`, `resolveControlDescriptor`, `elementOptionsFor`, `resolveTarget` (cycle-guarded) | med — the resolver is the whole feature |
| `src/modeler/vpl/CaNode.tsx` | ① instance body: control rows + group headers ② boundary editor: the Explicit Parameters + Groups section ③ pick-mode overlay + capture-phase click ④ **class-C list extraction** (call `elementOptionsFor` from ~20 JSX blocks) ⑤ orphan badge at L653-661 | med — ④ is a real refactor of live UI |
| `src/modeler/vpl/graphState.ts` | the pick-mode global + subscribe/set (shape of L57-72) | low |
| `src/modeler/vpl/GraphEditor.tsx` L3648-3653 | seed the fields on macro creation; cancel pick mode on scope change | low |
| `src/modeler/vpl/nodes/nodeValidation.ts` | orphaned / circular / wired-target issues, surfaced through the existing macro roll-up | low |
| `src/model/fileOperations.ts` L851-854 | optional shape check | low |
| `src/help/HelpView.tsx`, `README.md`, `docs/NODES_REFERENCE.md` | the docs-consistency sweep | low |
| **compilers** (`macroExpand`, `accessorCSE`, all six emit surfaces) | **NONE** | — |

**Why the compilers need nothing**: a control is metadata beside `nodes`/`edges`.
`expandMacros` copies internal nodes verbatim; `accessorCSE`'s purity key hashes
`node.data.config` and skips `_`-prefixed keys except `_port_*` / `_varName_*`
(accessorCSE.ts L251-256) — a control record is not in a node config at all, so it cannot
perturb a key. **This must be PROVEN, not assumed** — see the verification tier F.

---

## Invariants the implementation must preserve

1. **ONE storage location.** A control never holds a value. `resolveControlDescriptor` reads
   `def.nodes[k].data.config[key]` every render.
2. **The widget kind is derived, never stored.**
3. **A control never changes what compiles.** Adding, renaming, grouping or deleting a control
   leaves `expandMacros`' output byte-identical.
4. **`cloneMacroWithFreshIds` remaps `target.nodeId` and preserves `control.id` / `groupId`** —
   the `portId` rule.
5. **Report, never drop.** An orphaned, circular or wired-target control renders disabled with
   its reason and badges; it is never silently deleted or silently applied.
6. **Grouping a port reorders its array; edges are untouched** (F8), and the instance
   re-measures its handles.
7. **One dispatch per edit**, computed from live context state.
8. **Absent `controls` / `groups` ⇒ today's rendering and today's files, exactly.**

---

## Risk register — ranked by how SILENTLY it fails

| # | Risk | Failure mode | Mitigation |
|---|---|---|---|
| **R1** | `cloneMacroWithFreshIds` not extended (F1) | Every import / paste / independent-duplicate silently returns a def with **no controls**. The macro still works; the interface is just gone. No error anywhere. | Harness tier B with a **source-mutation** negative control that reverts the literal. |
| **R2** | `target.nodeId` not remapped in the clone | Worse than R1: the control **survives and resolves to a DIFFERENT internal node** whose id happens to collide, editing the wrong parameter. Plausible-but-wrong with no error. | Tier B asserts the remap *and* that a control never resolves to a node it did not name. |
| **R3** | Binding a renamed key (D2b breached) | `_port_bondAttr_*` renamed on import (macroImportPlan L668-675) or `partTag_*` permuted (L763-783, ModelContext L1205-1215) → the control edits a key nothing reads, or edits the WRONG tag slot. | D2b excludes them; the harness asserts `eligibleControlKeys` never returns either shape. |
| **R4** | Stored widget kind | A retype (attribute bool→tag) leaves the control writing `'5'` into a tag slot. | D2 — derive live. Tier A drives a retype and asserts the descriptor follows. |
| **R5** | Class-C list drift after extraction | The instance offers a different list than the in-node picker → a value the node cannot use. | Dual consumption: CaNode **calls** `elementOptionsFor`. Tier A asserts one call site per key. |
| **R6** | Cross-graph attribute scope (D10) | Two linked instances on Cells and Agents offer different lists for one shared value. | Pre-existing; degrades loudly (badge bubbles). Documented + risk-registered. |
| **R7** | Recursion clobber (F5) | An instance-side edit against the currently-open def is overwritten 100 ms later. | Disable the control when the def is in `currentScope`. |
| **R8** | Byte-identity drift | A control record leaks into a config or a purity key. | `check-compile-identity` + tier F. |
| **R9** | `stringifyCompact` name collision (F2) | A sub-array named `nodes`/`edges`/`coords` silently inlines. | Naming rule; tier C round-trips the exact JSON. |
| **R10** | Pick mode stranded | A pick armed across a scope switch binds into the wrong def. | Auto-cancel on scope change / unmount / model load. |

---

## Verification

**`node scripts/check-compile-identity.mjs --compare <baseline>` — 29+ models, every surface
unchanged.** Expected trivially green (no compiler file is opened for writing); it is the
*gate*, not the expectation.

**New: `scripts/test-explicit-controls.mjs`** — a Node harness in the house style, driving the
SHIPPED modules (and the REAL `modelReducer`, the `test-param-input-mappings` precedent), with
**every tier negative-controlled by SOURCE MUTATION**.

| tier | asserts |
|---|---|
| **A — resolution** | every (nodeType, key) in the inventory resolves to the right kind + value; a live retype flips the kind; a wired target reports `disabled` + reason; a deleted node/key resolves `null`; `eligibleControlKeys` never offers `_port_bondAttr_*`, `partTag_*`, a count stepper or a display-only key. |
| **B — the clone** | build a def with controls + groups → `cloneMacroWithFreshIds` → `target.nodeId` **remapped**, `control.id` / `groupId` **preserved**, everything else verbatim; a control never resolves to a node it did not name. **NEG: revert the literal → controls vanish; drop the remap → the control resolves to the wrong node.** |
| **C — round trips** | `.gcaproj` (`serializeModel` → `parseModelJSON`) and `.gcamacro` (`buildMacroFile` → `parseMacroFile`) preserve controls + groups verbatim; an OLD-shape file loads with none; a NEW file's controls are ignored by the pass-through rules; the cross-tab clipboard round-trips them. |
| **D — chaining** | A→B→C resolves to the ultimate config key; a cycle terminates and reports; an orphaned inner control resolves `null`; a paste that clones A **and** B keeps the chain resolving (the `controlId`-preserved argument). |
| **E — the write path** | drive a control edit through the **real reducer**: exactly one node's one config key changes, no other node moves, `controls`/`groups`/`edges` are untouched; a second LINKED instance reads the new value; **NEG: a second dispatch clobbers the first.** |
| **F — EMIT identity (the structural proof)** | a def **with** controls and the same def **without the records** (same config values) produce byte-identical `expandMacros` output *and* byte-identical compiled JS / WASM bytes / WGSL; adding, renaming, grouping and deleting a control each leave the emit unchanged; `accessorCSE`'s purity key is unchanged. |
| **G — cascades** | delete the target node → `null` + badge; delete a model element → the existing cascade blanks the value and the control still resolves; a tagOptions remap leaves a bound `_port_value` control reading the remapped index. |

**Real-UI recipes** (the repo standard — drive the actual UI, read observed values back):

1. Enter a macro → `+ Explicit Parameter` → pick mode highlights eligible widgets → click one
   → name it → exit → the closed instance shows the row with the live value.
2. Edit it on the instance → re-enter the macro → the internal widget shows the new value.
   Reverse the direction.
3. **Two linked instances on one canvas** — edit one, the other updates the same paint.
   Then **Duplicate Independent** and prove they diverge.
4. Groups: add two, assign ports and controls, confirm headers render and **no edge moves**
   (compare the edge list before/after).
5. Export `.gcamacro` → import into a **second model** → the controls survive and resolve.
6. A wired target renders disabled with its reason; unwire it inside the macro and the
   control becomes live.
7. Delete the target node inside the macro → the control greys out and the instance badges.
8. Chained: macro A exposes macro B's control; editing on A's instance changes B's internal
   widget.

---

## Phases

**E1 — schema, storage, classes A + B.** `MacroControl` / `ControlTarget`, the clone fix
(F1), the resolver for inline widgets and scalar config keys, pick mode, the boundary
editor, instance rows, the orphan badge, tiers A/B/C/E/F/G. **No groups, no chaining, no
element pickers.** Shippable on its own — it already covers the 148 inline widgets and the
Expression formula.

**E2 — groups + class C.** `MacroInterfaceGroup`, `groupId` on ports and controls, the
reorder-on-group rule (F8), and the `elementOptionsFor` extraction with CaNode calling back.

**E3 — chaining.** `{ kind: 'control' }`, `resolveTarget` recursion, the cycle guard, tier D.

---

## Deferred, with reasons

| deferred | reason |
|---|---|
| **Per-instance overrides** | D1. Would need a compiler change and a conflict rule; the user asked for sync. |
| **`_port_bondAttr_*` / `partTag_*` bindings** | D2b — four coupled edits across four files, each failing silently. Revisit with a fifth `applyImportPlan` pass + a fourth `collectMacroReferences` arm. |
| **Count steppers** | D3 — **structural**: they change the internal node's PORT set, hence what `expandMacros` emits and which internal edges survive. |
| ~~**Multi-key editors**~~ | **SHIPPED as D11 / class D** (plan §17). The exclusion was about binding one MEMBER of a coupled write; a FACET binds the whole editor and writes through the node's own writer. `_varName_*` stays out — it is multi-key *and* structural. |
| **Reordering exposed PORTS from the instance** | the interface is the author's; the instance is a consumer. |
| **A per-control default + "reset"** | needs a stored default, i.e. a second value — exactly what D1 rejects. Could be derived from `port.defaultValue` later. |
| **Preventing macro self-recursion** | pre-existing (three independent depth guards already anticipate it); R7 works around it. Worth its own small fix. |
| **A macro-level "interface" panel** (edit the interface without entering) | the boundary editor is where ports already live; a second surface is scope creep. |

---

## The one thing most likely to go wrong

**`cloneMacroWithFreshIds` (macroImport.ts L101-108).** It is a hand-written object literal in
a file nobody edits, on the path of *every* import, paste and independent duplicate. Forget it
and the feature works perfectly in the session that authored the macro and is **empty
everywhere else** — with no error, no badge and no console line. Remap `target.nodeId` wrongly
and it is worse: the control resolves to a different node and edits the wrong parameter.

Write tier B first, and write its source-mutation negative control before writing the fix.
