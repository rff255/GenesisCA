# Plan — Multi-Attribute Slots on Get/Set Attribute (cells + agents + model attrs)

**Goal.** Generalize the attribute accessor nodes to a dynamic number of attribute slots —
one node reads/writes N attributes — the way `Transfer Cell Attributes To Neighbor` has
payload slots and `Switch`/`Sequence` have dynamic ports. This collapses the "5 Get nodes +
5 wires just to read 5 attributes" clutter into one compact node per direction.

Illustrated mockup: [PLAN_MULTI_ATTR_SLOTS.html](PLAN_MULTI_ATTR_SLOTS.html).

## Scope — the five accessor nodes

| Node | Graphs | Extra slots add |
|---|---|---|
| `getCellAttribute` (Get Cell/Self Attribute) | Cells + Agents | extra VALUE **outputs** |
| `setAttribute` (Set Cell/Self Attribute) | Cells + Agents | extra VALUE **inputs** (type-adaptive inline widgets) |
| `getModelAttribute` | Cells + Agents | extra VALUE outputs (color model attr → per-slot R/G/B outputs) |
| `getAgentAttribute` (by-id) | Agents | extra outputs; the ONE `Agent` id input is shared by all slots |
| `setAgentAttribute` (by-id) | Agents | extra inputs; shared `Agent` id input |

NOT in scope: `updateAttribute` (per-slot op × slot matrix — separate feature),
`setAgentsAttribute` (bulk array write), neighbour reads/writes (carry NI/neighborhood
semantics per slot — separate feature).

## Config / port encoding (backward compatible — slot 1 unchanged)

- Slot 1 stays the legacy `attributeId` + port `value` (and `r`/`g`/`b` for a color model
  attr). Every existing file/edge loads byte-identically; `extraCount` absent ⇒ 0.
- `extraCount: number` — number of EXTRA slots. Slots are indexed **2..extraCount+1**
  (mirrors Sequence's `then_2…`).
- Per slot `i`: config `attr_${i}` (attribute id); port `value_${i}` (get: output, set:
  input); set nodes also store the inline value at `_port_value_${i}`. A color model attr
  in slot `i` of `getModelAttribute` exposes ports `r_${i}`/`g_${i}`/`b_${i}` (resolved
  live from the model — no per-slot `isColorAttr` config to go stale).
- Removing a slot removes the LAST one (Sequence's rule) — never shifts lower slots, so a
  wired `value_2` can't silently re-pair with a different attribute.

## Compiler strategy — ONE shared expansion pass, zero per-target emit

New `src/modeler/vpl/compiler/multiAttrExpand.ts` — `expandMultiAttrs(nodes, edges, model)`,
the exact pattern of `expandMacros` / `collapseReroutes` / `lowerVectorAttrs` /
`expandComposites`: a target-independent graph transform that rewrites every multi-slot
accessor into the SINGLE-slot primitives all five compilers already emit. After it runs, no
compiler, analyzer (sink/CSE/loop-invariance/volatile/asyncWriteHazard), gate
(`isAgentGraphWasmSupported`/`isAgentGraphWebGPUSupported`), or emitter ever sees a
multi-slot node — **JS / WASM / WebGPU, cell + agent, 2D + 3D all work by construction**
(the ALL-TARGET DELIVERY rule satisfied the sanctioned way).

- **Get nodes** → keep the original (config pruned to slot 1) + one synthesized single-slot
  clone per extra slot; consumers of `value_${i}` (or `r/g/b_${i}`) rewire to the clone's
  `value` (`r`/`g`/`b`). `getAgentAttribute`'s shared `agentId` edge FANS OUT (original
  keeps it; each clone gets a copy — reusing the one source node, N edges), mirroring
  `lowerVectorAttrs`' fan-out.
- **Set nodes** → the original (slot 1) heads a synthesized linear flow splice
  `do → set(slot1) → set(slot2) → … → set(slotN) → next` (exactly `lowerVectorAttrs`'
  component-write chain). `value_${i}` edges retarget to clone i's `value`;
  `_port_value_${i}` inline values copy to the clone's `_port_value`; the original's `next`
  consumers re-source from the last clone. Slots therefore execute in slot order — in
  async mode a later slot's read-after-write sees earlier slots' writes, matching a
  hand-built chain byte-for-byte.
- Synthesized ids are deterministic (`${origId}__ma${i}`) so WASM/WebGPU recompiles are
  byte-stable. Stale slot edges (a dangling `value_9` beyond the current `extraCount`) are
  dropped, never passed through (they would silently alias slot 1's variable).
- **Ordering:** runs immediately AFTER `collapseReroutes` and BEFORE `lowerFacingSource` /
  `lowerVectorAttrs` in all SIX front-ends (JS `compileGraph`, JS `compileAgentGraph`,
  `wasm/compile.ts`, `webgpu/compile.ts`, agentWasm + agentWebgpu `flattenAgentGraph`) — so
  a VECTOR attribute in an extra slot becomes a single-slot get/set that `lowerVectorAttrs`
  then lowers normally (vector slots work on every target for free).
- Hot-path no-op: returns the same arrays when no node has `extraCount > 0` — every
  existing model compiles byte-identically.

## Editor

Shared helpers in `src/modeler/vpl/multiAttr.ts` consumed by CaNode + effectivePorts +
isValidConnection so the three can't drift:

- `MULTI_ATTR_GET_TYPES` / `MULTI_ATTR_SET_TYPES` / `MULTI_ATTR_TYPES`, slot key helpers,
  `resolveSlotAttr` (graph-correct scope: model attrs for `getModelAttribute`, agent attrs
  for the by-id pair, cell∪agent own-scope for the universal pair — ids are globally
  unique), and `buildExtraSlotPorts(nodeType, config, model)` — the ONE place that builds
  the dynamic `value_${i}` ports: label = attribute name, dataType `vector` when the slot
  attr is a vector (else `any`), color model attr → `r/g/b_${i}` integer outputs, set-node
  inline widget by attr type (bool/tag/number; none for vector/color/NI — the same mapping
  as the primary port's `effectiveWidget` swap).
- **CaNode**: pushes `buildExtraSlotPorts` results into inputPorts/outputPorts (next to the
  switch/sequence dynamic-port blocks); one generic config block renders the extra slot
  rows (per-slot attribute dropdown over the same list as the primary + `+ Attribute` /
  `− last` buttons — the moveSelfToNeighbor slot-row look); the inline-widget block learns
  per-slot widgets + per-slot tagOptions for `value_${i}` ports; collapsed labels append
  `+N`. The existing port-id-signature `updateNodeInternals` effect already re-measures
  handles on any slot change.
- **effectivePorts**: same `buildExtraSlotPorts` push (panel-drag + drop-menu compatibility
  see the real port set).
- **isValidConnection**: `value_${i}` ports resolve their vector-ness via a port-aware
  helper (`slotVectorDims`) so a vector attr in an extra slot only wires vector↔vector —
  the same rule the primary `value` port gets from `vectorPortDims`.

## Validation + cascades

- `detectMissingConfig`: per-slot "Select an attribute (slot N)" using the same graph-aware
  scope per node type as the primary check.
- `REMOVE_ATTRIBUTE` / `REMOVE_AGENT_ATTRIBUTE` cascade: clear any `attr_${i}` slot key
  equal to the deleted id on the five multi-attr node types (scoped so
  `moveSelfToNeighbor`'s slots keep their existing behaviour).

## Verification

1. `npx tsc -p tsconfig.app.json --noEmit` + `npm run build`.
2. Dev harness `compileAll`: (a) byte-identity on existing models (GoL, Life3D — all 3
   targets); (b) a multi-slot cell model compiles on JS/WASM/WebGPU and the JS emit equals
   the hand-built N-node equivalent's semantics.
3. Runtime worker check (all 3 cell targets): a 2-slot Set + 2-slot Get model steps
   correctly.
4. Agent parity: `scripts/parity-agent-wasm.mjs` (all samples + a multi-slot synthetic) —
   0 mismatches; agent gates still accept.
5. Docs sweep: CLAUDE.md, HelpView, NODES_REFERENCE.md.
