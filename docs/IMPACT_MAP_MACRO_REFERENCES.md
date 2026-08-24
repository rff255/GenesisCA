# Impact Map — Macro Reference Export & Import Resolution

*A `.gcamacro` carries the model elements its nodes reference, and importing it asks
the user, per element: **Import as new · Remap to existing · Discard**.*

Companion illustrated plan: [PLAN_MACRO_REFERENCES.html](PLAN_MACRO_REFERENCES.html)

---

## Context

A macro is the only way GenesisCA lets a user package a piece of rule logic and move
it between models. Today it packages the **graph** and nothing else: a `.gcamacro` is
`{ schemaVersion: 1, name, description, macroDef }` ([GraphEditor.tsx](../src/modeler/vpl/GraphEditor.tsx)
`exportMacro`, ~L2655), and `macroDef.nodes[].data.config` is full of ids —
`attributeId`, `neighborhoodId`, `mappingId`, `variableId`, … — that name elements of
the **source** model. In any other model those ids resolve to nothing.

That is not hypothetical: three of the four shipped macros in `public/macros/` carry
live dangling ids right now. `Colorize From Neighbors number.gcamacro` opens with

```json
"nodeType": "outputMapping",
"config": { "mappingId": "new_mapping_mo9xiuadam3" }
```

— a mapping id that exists in exactly one model on earth. Dropping that macro into any
other project produces a node wired to nothing, an amber badge, and a manual re-point.
The documented posture is deliberate:

> **Dangling model-element references are EXPECTED** … `detectMissingConfig` badges it …
> **No name-based auto-mapping — deliberately out of scope; a possible follow-up.**
> — CLAUDE.md, "Cross-tab graph clipboard"

**This is that follow-up.** The user's framing:

> allow macros to optionally export the referenced attributes/neighborhoods/mappings/
> variables/indicators/and so on in its definition, so that when imported the user can
> be prompted to include or not those referenced attributes. Ideally with an option to
> pick which ones among the things defined inside they want to include/remap to
> existing … or to discard and let the nodes that were referencing it not reference
> anything (which is what happens today). … It will empower users to explore parts of
> their models independently then bring it together through macros, and more easily mix
> parts of different models skipping all the manual labor and risk of having to define
> and re-wire things by hand.

Three actions, and **Discard is exactly today's behaviour** — which is the strongest
structural property of this design: the new path is a strict superset, so the
zero-references case and the all-discarded case are byte-identical to what ships.

---

## CODE-REALITY FINDINGS THAT CHANGE THE DESIGN

### F1. Nested macros are ALREADY broken on export — and fixing it is a prerequisite

`exportMacro` writes **one** `macroDef`. If that def's subgraph contains a `macro`
instance (nesting is supported — `countMacroInstances` walks `macroDefs[*].nodes`
precisely because "instances can be nested inside other macros",
[macroImport.ts](../src/model/macroImport.ts) L113-134), the file carries the instance
node but **not the def it points at**. Import produces a macro node whose `macroDefId`
names nothing: it compiles to an empty expansion (`expandMacros` finds no def) with no
error anywhere.

The **cross-tab clipboard already solved this** and the code is reusable verbatim:
`collectMacroDefBundle` / `nestedMacroDefIds` / `remapNestedMacroRefs`
([graphClipboard.ts](../src/modeler/vpl/graphClipboard.ts) L63-118), plus the two-pass
"register every id before retargeting" import loop in GraphEditor's paste
(~L2920-2952). **M1 lifts that into the `.gcamacro` file** (`macroDefs?: MacroDef[]`),
because reference collection has to walk the nested defs anyway — a reference used only
inside a nested macro is still a reference the file must carry.

### F2. `danglingRefs.KEY_SPACE` is NOT complete — the audit

`KEY_SPACE` ([danglingRefs.ts](../src/modeler/vpl/compiler/danglingRefs.ts) L35-47) is
the closest thing the codebase has to a registry of "which config key names which id
space", so this feature has to start by asking whether it is complete. It is not. A
sweep of every node definition, `CaNode`'s config UI, `nodeValidation`'s
`detectMissingConfig` switch, the compiler pre-resolve passes and the `ModelContext`
cascades turns up **four classes of reference it does not cover**.

**Class 1 — plain id-valued keys, fully missed:**

| key | node(s) | names | badge? | consumer | delete cascade? |
|---|---|---|---|---|---|
| `macroDefId` | `macro`, `macroInput`, `macroOutput` | a **macro def** | — | `expandMacros` | **none** (`REMOVE_MACRO` L1571 has no node cascade) |
| `presetId` | `ovLoadPreset` | a **`Preset`** | ✓ (`nodeValidation` L533) | `overseerRuntime.loadPreset` | **none** (`DELETE_PRESET` L1848) |
| `facePaletteId` | `getConstant` (`constType: 'faceLabel'`) | a **`FaceLabelPalette`** — living inside `variegatedCells.facePalettes` | ✓ (L592) | [compile.ts](../src/modeler/vpl/compiler/compile.ts) L1987 | **none** — there is no `REMOVE_FACE_PALETTE` action at all |
| `facingAttributeId` | Get Agents In View, Sense Hemifield (`headingSource: 'facing'`) | an **agent vector attribute** | ✓ (L775) | [facingSource.ts](../src/modeler/vpl/compiler/facingSource.ts) L30-64 | `REMOVE_AGENT_ATTRIBUTE` clears `attributeId`/`tagAttributeId`/`attr_N` only |

**Class 2 — the id is in the KEY NAME, not the value** (F3): `_port_bondAttr_<attrId>`.

**Class 3 — an INDEX into a model element** (a reorder silently mis-resolves; a delete
leaves an out-of-range index): `partTag_<i>`, `constValue` (tag mode), `case_N_value`,
`_port_x` / `_port_y` / `_port_y2` (`statement` in tag mode), `_port_value` (a
tag-typed `setAttribute` / `setNeighborhoodAttribute` / `setNeighborAttributeByIndex` /
`setBondAttribute`).

**Class 4 — a NAME inside a model element**, not an id: `tagName` / `tag_N_name`
(a **neighborhood tag name** — `getNeighborAttributeByTag`, `neighborIndexFromTag`,
`getNeighborIndexesByTags`), `category` (an indicator's frequency-category name —
`ovReadIndicator`, `ovCollectSpatial`), and `constValue` in `faceLabel` mode (a face
LABEL inside the palette).

Classes 3 and 4 are the reason the remap is not a find-and-replace of ids (D8).

> **DECISION (D2 below): do NOT widen `KEY_SPACE` itself.** `facingSource.ts`
> *deliberately* SKIPS a `facingAttributeId` that "isn't a live VECTOR agent attribute"
> and a dangling `presetId` only reaches the Overseer runtime — widening the gate turns
> two documented graceful skips into hard compile errors on models that run today, for
> zero benefit here. The collection module defines its own map that **imports and
> extends** `KEY_SPACE`, so the shared half cannot drift while the collection side stays
> strictly broader than the compile gate.

Two completeness notes on `KEY_SPACE` itself:

- **Two entries are DEAD.** `neighborhoodHintId` (L42) and `valueTagAttributeId` (L40)
  are *`Attribute` properties*, never node config keys (types.ts L76, L167) — no node
  writes them, so those map entries can never fire. Collection needs them as
  **element→element** references (D5), which is a different mechanism.
- **`attr_\d+` is matched by regex** (`SLOT_ATTR_KEY`, L51) and serves two unrelated node
  families — the multi-attr slots and `moveSelfToNeighbor`'s payload slots.
  `clearDeletedSlotIds` (L219) scopes by node type; collection does not need to.

### F2b. Pre-existing bugs this audit surfaced (recorded, NOT in scope)

Not caused by this feature and not fixed by it, but they are in the blast radius and
should not be re-discovered:

1. **A deleted bond attribute leaves its EDGE behind.** The bond-attribute removal
   cascade (`ModelContext` L1133-1137) prunes the `_port_bondAttr_<id>` config key but
   makes **no `patchAllEdges` call**, so a wire into `input_value_bondAttr_<deletedId>`
   survives, pointing at a port the canvas no longer draws. Contrast the mapping-parameter
   cascade, which does prune edges (L145-204).
2. **The tag-reorder `_port_value` remap has asymmetric coverage** across the three
   parallel sites: the cell path (L847) covers `setAttribute` /
   `setNeighborhoodAttribute` / `setNeighborAttributeByIndex`; the **agent** path (L1073)
   covers `setAttribute` only — while its own predicate (L1061) also matches
   `updateAttribute`, which the patch then never touches; the bond path (L1193) covers
   `setBondAttribute` only.
3. **`REMOVE_MACRO` / `DELETE_PRESET` / face-palette removal have no node cascade at
   all** (table above), so each leaves a live dangling reference that only a badge (or
   nothing) reports.

### F3. A model-element id can be embedded in a config KEY and in an EDGE HANDLE

`_port_bondAttr_<attributeId>` — Form Bond / Rewire Bond expose one input port per bond
attribute, and the port id is `bondAttr_${attrId}` ([bondAttrPorts.ts](../src/modeler/vpl/bondAttrPorts.ts)
L25), so the inline value lands at config key **`_port_bondAttr_<id>`** and any wire
into it carries handle **`input_value_bondAttr_<id>`**.

A value-scan of `Object.entries(config)` — which is exactly what `detectDanglingRefs`
does — **cannot see this**. A remap that rewrites config *values* would leave the key
(and the edge) pointing at the old bond attribute, silently. This is the single
sharpest edge in the whole feature and it needs an explicit rule (D7).

### F4. `.gcamacro` has no reader module and no version gate — so an additive field degrades perfectly

There is no `readMacroFile` in `fileOperations.ts`. Import is inline in
`handleMacroFileSelected` (GraphEditor ~L2689): parse JSON, check `parsed.macroDef` is
an object, hand it to `importMacro`. **`schemaVersion` is never read.** The Vite plugin
that builds `public/macros/index.json` reads only `name` / `description`
([vite.config.ts](../vite.config.ts) L132-156).

So an older build handed a file with `references` **ignores the field entirely and
imports exactly as it does today**. That is textbook graceful degradation and it decides
D4 (no version bump).

### F5. `ADD_*` reducers mint blanks; `DUPLICATE_*` clones something already in the model

Neither shape accepts a supplied element. `ADD_ATTRIBUTE` builds a hard-coded blank
(L546); `DUPLICATE_ATTRIBUTE` looks its source up by id **in `state.model`** (L565).
Import-as-new needs "insert THIS object, with THIS id" — a new action (D9). And the
import must be **atomic**: N elements + the def in one dispatch, or a throw halfway
leaves a model holding orphan attributes and no macro.

### F6. Face palettes have no `ADD_*` action at all

`ADD_FACE_PATTERN` exists (L2053); palettes are edited only through the whole-object
`UPDATE_VARIEGATED_CELLS`. One more reason the import is a single bundle action that
merges `variegatedCells` itself rather than a fan-out of per-space adds.

---

## THE RESOLVED DECISIONS

### D1 — A new pure module `src/model/macroReferences.ts` owns collection, closure and rewriting

DOM-free and reducer-free, so the Node harness drives the shipped code. It exports:

```ts
collectMacroReferences(defs: MacroDef[], model: CAModel): CollectedReferences
buildReferenceBundle(collected, selection): MacroReferenceBundle     // export side
planImport(bundle, model): ImportPlan                                // import side, default actions
applyImportPlan(plan, defs): { defs: MacroDef[]; elements: MacroReferenceBundle } // the rewrite
```

The **rewrite is pure and returns new defs + final-id elements**, so the caller can
dispatch one action with both halves in the same tick — no read-back from state (the
`FileMenu` `metaEdits` two-write discipline).

### D2 — The reference-key registry EXTENDS `KEY_SPACE`; it does not replace or widen it

```ts
// macroReferences.ts
import { KEY_SPACE } from '../modeler/vpl/compiler/danglingRefs';   // ← newly exported
export const REFERENCE_KEYS = {
  ...KEY_SPACE,                 // the compile gate's own list, verbatim
  facingAttributeId: 'attribute',
  facePaletteId:     'facePalette',   // NEW space
  presetId:          'preset',        // NEW space — collected, never carried (D6)
} as const;
```

`KEY_SPACE` gains an `export` keyword and **nothing else**. `detectDanglingRefs`'
behaviour is unchanged, so no model's compile verdict moves. The extension list is
short, sits next to a comment explaining why each entry is here and not there, and the
harness asserts `REFERENCE_KEYS ⊇ KEY_SPACE` so a future `KEY_SPACE` addition is picked
up automatically.

Also handled, and NOT via the value scan:
- the `attr_\d+` slot regex (inherited);
- **`_port_bondAttr_<id>`** — matched by KEY pattern (F3, D7);
- **`macroDefId`** is deliberately absent from `REFERENCE_KEYS`: a macro def is not a
  *model element*, it rides the `macroDefs` bundle (F1) and is collected by
  `collectMacroDefBundle`, which already keys off it;
- classes 3 and 4 of F2 (`partTag_<i>`, `constValue`, `case_N_value`, `_port_x/y/y2`,
  `_port_value`, `tagName`, `tag_N_name`, `category`) are **indices and names inside** an
  element, not ids. They are a *remap* concern (D8), never a collection one.

**⚠ "underscore ⇒ compiler-derived" is NOT a safe rule here.** The pre-resolve passes
inject a long list of `_`-prefixed keys that must never be treated as authoritative
references — `_resolvedTagIndex(es)`, `_resolvedPacked`, `_indicatorIdx`, `_stopIdx`,
`_spriteSlot`, `_divideIdx`, `_tagLen`, `_attr_N_default`, `_dims`/`_mins`, and
especially **`_sourceAttrId`** (compile.ts L1964-1969), which *is* an attribute id but is
a CACHE derived from `variegatedCells.sourceAttributeId`. But `_port_*` and
`_varName_*` are **user-authored inline values persisted in the model** — and `_port_*`
is exactly where classes 2 and 3 live. So the module filters by an explicit
derived-key list, not by the prefix.

### D3 — Schema: one optional `references` object carrying VERBATIM elements

```ts
export interface MacroReferenceBundle {
  attributes?: Attribute[];        // cell AND model attributes — one list, `isModelAttribute` discriminates,
                                   // exactly as `CAModel.attributes` does
  agentAttributes?: Attribute[];
  bondAttributes?: Attribute[];
  neighborhoods?: Neighborhood[];
  mappings?: Mapping[];            // A→C and C→A alike (`isAttributeToColor` discriminates)
  agentMappings?: Mapping[];
  variables?: Variable[];
  agentVariables?: Variable[];
  indicators?: Indicator[];
  sprites?: SpriteAsset[];
  facePalettes?: FaceLabelPalette[];
  facePatterns?: FacePattern[];
}

export interface MacroFile {
  schemaVersion: 1;
  name: string;
  description: string;
  macroDef: MacroDef;
  /** F1 — every def the exported def references, transitively. */
  macroDefs?: MacroDef[];
  references?: MacroReferenceBundle;
  /** Purely for the import dialog's header + compatibility warnings. */
  origin?: { modelName?: string; dimension?: '2d' | '3d'; topologyMode?: TopologyMode };
}
```

**Elements travel verbatim, as the exact schema objects.** No parallel "display name +
metadata" record: the dialog reads `name` / `type` / `kind` off the object itself, so
there is nothing to drift when a schema field is added. Element **ids are preserved as
exported** — that is what makes re-importing into the source model a provable no-op
(D10).

`MacroFile` becomes the first real *type* for the format; today it is an inline object
literal in two places.

### D4 — `schemaVersion` stays **1**

The importer never reads it (F4), and an unknown field is ignored by every existing
build. Bumping it would buy nothing and would invite a future strict check to reject
files a current build reads fine. **Rule to carry forward: the `.gcamacro` reader must
never gate on `schemaVersion`.**

### D5 — Transitive closure: enumerated per element type, run to a fixpoint

Collection starts from node configs, then closes over element→element references. The
complete list, read off the schema:

| element | closes over | field |
|---|---|---|
| `Attribute` (any space) | its sub-attribute **parent** | `parentAttributeId` (types.ts L84) |
| | a **neighborhood** (NI picker hint) | `neighborhoodHintId` (L76) |
| | lookup-table axis → **attribute** \| **face palette** | `rowKeySource` / `colKeySource` / `axes[].source` (`{kind:'tagAttribute'}` \| `{kind:'facePalette'}`, L29-51) |
| | tag-valued table's value labels → **attribute** | `valueTagAttributeId` (L167) |
| | **face patterns** assigned to its tag options | `facePatternAssignments` (L112) |
| `Mapping` | linked A→C source → **attribute** | `linkedAttributeId` (L324) |
| | C→A parameter borrowing tag options → **attribute** | `parameters[].tagAttributeId` (L290) |
| `Indicator` | linked source → **attribute** | `linkedAttributeId` (L765) |
| `Variable` | tag space → **attribute** | `attributeId` (L1027) |
| `FacePattern` | its palette | `paletteId` (L947) |
| `Neighborhood`, `SpriteAsset` | — | self-contained |

Worklist to a fixpoint with a `seen` set (the element count is finite, so no depth
guard is needed; `seen` also guards a hand-edited cycle). The closure is **honest about
spaces**: a `linkedAttributeId` on an `agentMappings` entry resolves against
`agentAttributes`, on a `mappings` entry against `attributes` — resolution uses the same
UNION-then-classify shape `idSets` uses, and records which space each id came from.

**Deliberately NOT closed over:** `variegatedCells.sourceAttributeId` (model-level
configuration, not an element reference — importing a face pattern must not drag the
whole variegation setup); `ModelProperties.*`; `centerBased.*`; presets.

### D6 — What is exportable, and what is not

| space | exportable | reasoning |
|---|---|---|
| attributes (cell / model / agent / bond) | **yes** | the point of the feature |
| neighborhoods, mappings (both directions), agent mappings, variables (both), indicators | **yes** | small, self-contained after closure |
| **sprites** | **yes**, but per-element opt-out and a size shown | referenced by `setAgentSprite.spriteId`, and self-contained — the whole asset is a base64 `dataUrl` (types.ts L348). It is also the only element that can be **megabytes**, which is precisely why per-element checkboxes earn their keep (D11) |
| **face palettes + face patterns** | **yes** | `getConstant.faceLabel` needs the palette (F2) and `facePatternAssignments` needs the patterns. Small. They live inside `variegatedCells`, so import merges rather than appends (F6) |
| **presets** | **NO** | a `Preset` embeds a whole `SimulationState` — a base64 grid snapshot plus the agent store. `.gcapreset` already exists for exactly this, with its own import path. A collected `presetId` is shown in the dialog as **"cannot be carried — presets export separately as `.gcapreset`"** and is always discarded |
| macro defs (nested) | **yes** | F1 — but they ride `macroDefs`, not `references` |

### D7 — Remap rewrites config VALUES, config KEYS **and** edge handles

Three passes over every def in the bundle (top-level + nested), for every element id the
plan remaps `old → new`:

1. **Values** — any `config[k]` whose key is in `REFERENCE_KEYS` (or matches `attr_\d+`)
   and whose value is `old`.
2. **Keys** — `_port_bondAttr_<old>` → `_port_bondAttr_<new>` (F3). Rename the key,
   preserve the value.
3. **Edge handles** — `input_value_bondAttr_<old>` → `…_<new>` on `edge.targetHandle`.

Pass 3 is what a "rewrite the configs" implementation forgets. Without it the wire
still lands on the port the *old* attribute would have rendered, which after the remap
is a port that no longer exists — a silently dropped initial value, reported by nothing
(the bond-attr ports are derived from `model.bondAttributes`, so the canvas simply draws
a different port set).

**Input-mapping channel ports are the mirror case and are handled by reporting, not
rewriting.** An `inputColor` / `agentInputMapping` root's value outputs are keyed by
*parameter key* (`output_value_<paramKey>`); remapping the mapping onto an existing one
whose `parameters` differ leaves those edges stale. `detectDanglingRefs` already reports
exactly this by name (its STALE CHANNEL block, L109-149) and the standing rule is
**drop stale edges, never repoint them**. So: the dialog **warns** when the remap target
declares a different parameter key set, the import proceeds, and the compile gate names
what broke.

### D8 — INDICES and NAMES inside a remapped element: remap **by name**, report what cannot be matched, never guess

The hard case, and F2's classes 3 and 4. A remap changes *which element* an id names —
but a macro also stores values that are only meaningful **relative to that element**:

| carrier | what it means | after a remap |
|---|---|---|
| `constValue` (tag), `_port_value`, `case_N_value`, `_port_x`/`_port_y`/`_port_y2`, `partTag_<i>` (keyed *by* index), `_port_bondAttr_<id>` for a tag attribute | an **index into `tagOptions`** | means a different option unless the option ORDER matches |
| `tagName`, `tag_N_name` | a **neighborhood tag NAME** (`Neighborhood.tags`) | resolves to a different offset, or to nothing |
| `category` (`ovReadIndicator`, `ovCollectSpatial`) | an indicator **frequency-category name** | reads a category the target indicator may not have |
| `constValue` in `faceLabel` mode | a **face LABEL** inside the palette | ditto |
| `Attribute.parentValues`, `Variable.initialValue`, `Indicator.defaultValue` | tag indices *inside imported elements* | must be remapped when their tag attribute is remapped |

**Rule, uniform across all of them:** build the correspondence **by NAME** — for tag
attributes an `oldIndex → newIndex` map over `tagOptions`; for neighborhood tags, face
labels and indicator categories the name is already the stored value, so the "map" is
simply a membership check. Apply it where it resolves. Where a source name has **no
counterpart in the target, leave the stored value untouched and REPORT it** — in the
dialog's per-row summary *before* the import, and in a post-import notice after it.

**Never clamp to 0, and never drop.** A wrong-but-plausible tag value is the worst
possible outcome; an out-of-range index renders as an unselected dropdown and an unknown
tag name is already badged — both visible.

This mirrors the shape `ModelContext` already uses for a tagOptions rename/reorder
(`remapLookupTableForTagChange` L390; the `partTag_` remap at L1202-1205 is the existing
precedent for remapping an index embedded in a KEY). Note that those cascades have
asymmetric coverage across the cell/agent/bond paths (F2b.2) — the import's map must be
written from the enumerated table above, **not** by copying one of them.

**Scope note, stated honestly:** whether `_port_value` holds a tag index is
*node-type-and-target-type* dependent (CaNode's `effectiveWidget` swap keys off the
chosen attribute's `type`). M2 implements the remap for the enumerated set; anything
outside it is reported rather than guessed, and M3 audits for stragglers.

The **alternative considered and rejected**: forbid remapping a tag attribute onto one
whose options differ (offer only Import as new). Too restrictive — remapping
`cellType` onto the target model's own `cellType` is *the* motivating case, and in
practice the options usually match exactly, in which case the map is the identity.

### D9 — Import is ONE new reducer action, carrying final ids

```ts
{ type: 'IMPORT_MACRO_BUNDLE',
  macros: MacroDef[],              // the top-level def + its nested defs, already rewritten
  elements: MacroReferenceBundle } // only the "import as new" elements, already carrying final ids
```

Ids are minted on the main thread by `applyImportPlan` (via the same
`Date.now()+Math.random()` convention `generateId` / `genId` use — **never counter-based**,
per the standing rule), so the def rewrite and the elements agree without reading state
back. The reducer appends per space, merges `variegatedCells` for palettes/patterns, and
flips `isDirty` **once**.

Atomic by construction: one dispatch, one state transition. No half-imported model.

### D10 — Default action per element, and when the dialog does not appear at all

- An element id that **already exists in the target model** is *resolved*. It is not a
  row. It is summarised as "already present (N)".
- **No unresolved references ⇒ no dialog.** Import proceeds exactly as today. This is
  what keeps the four shipped macros and every existing `.gcamacro` on the current path,
  and it makes re-importing a macro into its source model a provable no-op.
- Otherwise, per unresolved element, the default is:
  1. an **exact name + compatible type** match in the same space → **Remap to it**,
     rendered as a suggestion (`↔ matched by name`), never applied silently;
  2. else → **Import as new**.
- **Discard is never a default.** It is always one click away, and it is today's
  behaviour.

"Compatible type" is per space: attributes must match `type` (and, for `lookupTable`,
axis dimensionality is *checked and warned about*, not enforced); mappings must match
`isAttributeToColor`; variables must match `kind` + `dataType`; indicators must match
`kind`.

### D11 — Export: embed by default, with per-element opt-out

The user said *optionally* export and *prompted* on import. The decision that matters is
at import (that is where the target model exists and where remapping is possible), so
the export side stays one click for the common case:

- **Export Macro…** opens a small dialog listing every collected reference, grouped by
  space, **all checked**, each row showing name · type · size-when-large (sprites).
- Unchecking an element removes it from the bundle; its references dangle on import,
  which is precisely the Discard outcome.
- A **"Reference-free template"** shortcut unchecks everything — which is how a template
  macro like `GRA Rule Table.gcamacro` (whose reference ids are deliberately BLANK, so
  it collects nothing anyway) stays possible by construction.
- Closure is transparent: an element pulled in only by closure is shown indented under
  its requirer, and unchecking a requirer unchecks what only it needed.

### D12 — Capability / topology gating: **warn, never block**

`bondAttributes` are invisible while the Bonds capability is off (`bondAttrsOf` returns
`[]` when `resolveMaxBonds(centerBased) <= 0`, [attributeScope.ts](../src/model/attributeScope.ts));
`agentAttributes` / `agentMappings` need `topologyMode.agents`; face palettes need
`variegatedCells.enabled` (and variegation is 2D-only). The import **appends them
anyway** and the dialog warns:

> These will be inert until you enable **Bond-Graph Agents → Bonds** in Properties.

Reasoning: the existing capability + validation machinery already badges every one of
these states, blocking would dead-end the legitimate "import the pieces, then turn the
layer on" flow, and auto-enabling a capability is a far larger blast radius than an
import should have. **No auto-enable in M2** — an opt-in "also enable X" checkbox is a
recorded follow-up.

### D13 — Compiler impact: **ZERO**, and that is structural

Every reference resolves to an ordinary model element, and the def's configs are
rewritten *before* the model reaches any compiler. No compiler learns a key, a space or
a shape. `check-compile-identity.mjs` must report **29 models, all surfaces unchanged**
at every phase; that is a gate, not an expectation.

### D14 — Undo: the documented asymmetry, unchanged

Ctrl+Z is graph-only history. Imported elements live in model state and are **not**
undone — the same asymmetry "Make Independent Copy" already has (CLAUDE.md: *"Ctrl+Z
reverts the retarget but leaves an orphan MacroDef"*). `undoMacro` must **not** remove
imported elements either: by the time it runs, an attribute may be referenced by a node
the user has since wired by hand. Documented, not fixed.

---

## Subsystem impact

| # | Subsystem | File(s) | Change |
|---|---|---|---|
| 1 | Schema | `src/model/types.ts` | `MacroFile`, `MacroReferenceBundle` (new, additive; no `CAModel` change) |
| 2 | **Reference engine** | `src/model/macroReferences.ts` **(NEW)** | collection, closure, plan, rewrite — pure |
| 3 | Dangling-ref registry | `compiler/danglingRefs.ts` | **`export`** on `KEY_SPACE`. Nothing else |
| 4 | Macro clone | `src/model/macroImport.ts` | `cloneMacroWithFreshIds` gains an optional reference-remap map, applied AFTER the migrations (a legacy `setColorViewer` node's `mappingId` must be rewritten in its migrated form) |
| 5 | Export | `GraphEditor.tsx` `exportMacro` + **`MacroExportDialog.tsx` (NEW)** | collect → dialog → bundle + nested defs (F1) |
| 6 | Import | `GraphEditor.tsx` `handleMacroFileSelected`, `spawnPalettePayload` + **`MacroImportDialog.tsx` (NEW)** | parse → plan → dialog (only when rows exist) → rewrite → one dispatch |
| 7 | Reducer | `src/model/ModelContext.tsx` | `IMPORT_MACRO_BUNDLE` + its context callback + **both `useMemo` dep arrays** (the standing trap) |
| 8 | Clipboard | `graphClipboard.ts` | **UNCHANGED in M1/M2** — see Deferred |
| 9 | Validation | `nodeValidation.ts` | unchanged; it is the safety net that reports whatever Discard leaves behind |
| 10 | Compilers | — | **none** (D13) |
| 11 | Verification | `scripts/test-macro-references.mjs` **(NEW)** | reducer-driven round trips |
| 12 | Docs | `HelpView.tsx`, `README.md`, `CLAUDE.md` | the Macro System chapter gains a Reference Export section |

### Invariants the implementation must preserve

1. **Zero references ⇒ byte-identical file and byte-identical behaviour.** A macro that
   references nothing exports the same JSON it does today (modulo the new optional keys
   being absent) and imports through the same code path.
2. **All-Discard ⇒ today's behaviour, exactly.**
3. **Re-import into the source model is a no-op**: every id resolves, no rows, no dialog,
   no elements added.
4. **Ids are never counter-based** (the standing rule; collisions after a reload).
5. **One dispatch per import** (D9).
6. **The def rewrite is total**: values, keys, and edge handles (D7).
7. **`check-compile-identity` 29/29 unchanged** at every phase.

---

## Verification — `scripts/test-macro-references.mjs`

Reducer-driven, following the `test-param-input-mappings.mjs` precedent (`modelReducer`
is exported at [ModelContext.tsx](../src/model/ModelContext.tsx) L520 and bundles cleanly
in Node — it calls no React API), so what the harness exercises is what the app
dispatches, gate and all.

**Tier A — collection.** Every `REFERENCE_KEYS` key found; the `attr_\d+` slots; the
`_port_bondAttr_<id>` **key-embedded** id (a value scan must FAIL this fixture); nested
defs walked; the full transitive closure per element type of D5 — each with a fixture
whose answer is non-trivial (e.g. a lookup table whose row axis is a tag attribute that
is *itself* the parent of a sub-attribute).

**Tier B — the round trip.** Export a macro from model A → import into an **empty**
model B with everything "Import as new" → assert `detectDanglingRefs(...) === undefined`
and `detectMissingConfig` reports zero issues on every node. That single assertion is
the feature.

**Tier C — remap.** Import into a model that already has same-named elements → the def's
configs, the `_port_bondAttr_<id>` keys **and** the edge handles all name the target's
ids; nothing was added to the model. Then D8, one fixture per row of its table:
**tag indices remapped by name** against a target whose options are in a *different
order* (so an identity map fails), an unmatched option asserting it is REPORTED and left
alone, a **neighborhood tag name** (`tagName`) that exists / does not exist in the remap
target, and an `ovReadIndicator.category` against an indicator with different tracked
values.

**Tier D — discard + idempotence.** Discard-all ≡ the pre-feature import (compare the
resulting `graphNodes` JSON against a run through the old path); re-import into the model
just imported into adds nothing and produces no rows.

**Tier E — negative controls, by source mutation.** Drop the edge-handle pass (Tier C
fails); drop the key-rename pass (Tier C fails); make the closure non-transitive (Tier
A/B fail); make `generateId` return a constant (collision assertions fail). Each must be
caught by exactly the check that names it.

**Existing gates:** `check-compile-identity` (29/29), `test-param-input-mappings`,
`test-agent-capabilities`, `tsc -p tsconfig.app.json --noEmit`, `npm run build`.

**Real UI (M2):** export a macro from Kelp War carrying an attribute + a neighborhood +
a linked mapping; import into a fresh model — assert the simulator compiles and runs
with no banner; then import the same file into a model that already has a same-named
attribute and remap onto it; then discard everything and confirm the amber badges are
exactly the ones that ship today.

---

## Phases

Each is one Opus session. Every phase ends green on the gates above.

### **M1 — Collection, schema, export** (no import change)

- F1's nested-def bundle (`macroDefs`), reusing `collectMacroDefBundle` / `nestedMacroDefIds`.
- `macroReferences.ts`: `REFERENCE_KEYS` (D2), collection, closure (D5).
- `MacroFile` / `MacroReferenceBundle` types; `KEY_SPACE` exported.
- Export dialog (D11).
- Harness Tier A + the export half of Tier B.
- **User-visible outcome:** files get richer. Import is unchanged, old builds ignore the
  new fields (F4), so this phase cannot regress anything.
- Docs: Help's Macro section gains "what a macro carries".

### **M2 — Import resolution** (the feature)

- `planImport` + `applyImportPlan` (D7, D8, D10).
- `MacroImportDialog` — per-element rows, three actions, name-match suggestion, the
  gating warnings (D12), the parameter-key warning (D7), the preset note (D6).
- `IMPORT_MACRO_BUNDLE` reducer + callback + both dep arrays (D9).
- Wire `handleMacroFileSelected`; the dialog appears only when rows exist (D10).
- Harness Tiers B–E; the real-UI script.
- Docs: Help + README + the CLAUDE.md Macro chapter.

### **M3 — Reach and polish**

- Palette **default-macro drop** through the same path (silent when zero rows, so the
  four shipped macros are unchanged).
- Tag-index straggler audit (D8's scope note).
- Optional "also enable the required capability" checkbox (D12's follow-up).
- Optionally re-export the shipped `public/macros/*.gcamacro` with references, which
  turns three of them from "drops with dangling ids" into "drops working" — a visible
  win, and a real regression risk if done earlier.

---

## Deferred, with reasons

- **Cross-tab clipboard references.** The clipboard already bundles macro defs, but its
  localStorage payload is capped at `MAX_STORED_CHARS = 2 MB`
  ([graphClipboard.ts](../src/modeler/vpl/graphClipboard.ts) L28) and shares the ~5 MB
  origin quota with every other `genesisca_*` key. Adding attributes is cheap; adding
  **sprites** is not. Paste keeps today's dangling-badge behaviour. If it is ever done,
  the honest shape is "elements yes, sprites never".
- **Presets** (D6) — `.gcapreset` owns that.
- **Auto-enabling capabilities on import** (D12).
- **A `KEY_SPACE` widening** for `macroDefId` / `facingAttributeId` / `facePaletteId` /
  `presetId`, and pruning its two dead entries (F2) — a genuine gap in the *compile
  gate*, deliberately not fixed here: two of them are documented graceful skips, so
  changing them is a behaviour change unrelated to this feature. Recorded so it is not
  re-discovered.
- **The three pre-existing cascade bugs of F2b** (the un-pruned bond-attribute edge, the
  asymmetric `_port_value` tag remap, the three missing delete cascades). Each is a
  small, independent fix with its own verification; folding them into this feature would
  blur what its harness is proving.
- **Name-based auto-mapping without a prompt.** Explicitly out: the standing rule is
  that a name match is a *suggestion*, never a silent rewrite.

---

## The one thing most likely to go wrong

**A remap that rewrites config values and stops there.** Two of the three reference
carriers are not values: the `_port_bondAttr_<id>` config **key** and the
`input_value_bondAttr_<id>` edge **handle** (F3). Both survive a value-only rewrite
looking perfectly healthy, and the failure — a bond's initial value silently reverting
to the attribute default — surfaces nowhere: no badge, no compile error, no console
line. Tier C's edge-handle assertion and its negative control exist specifically for
this.

The runner-up is **D8's tag indices**, whose failure mode is the same shape: plausible,
silent, and wrong.
