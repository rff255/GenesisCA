# Impact Map — Value Switch as a conditional array relay

## Context

`valueSwitch` ("Value Switch") is a ternary value selector: `result = condition ? ifValue : elseValue`.
Its ports are declared `dataType: 'any'`, scalar (no `isArray`). It was designed as a **scalar**
node, but on the **JS** target it transparently relays *whatever* its inputs hold — including a
NeighborIndex (NI) array — because JS variables are dynamically typed and the emit is a blind
`const _v<id> = (cond) ? (ifV) : (elV)`.

A user wired two NI arrays (e.g. `filterNeighbors.result`) into `ifValue` / `elseValue` and the
`result` into `pickRandomNeighbor.indexes` ("pick a random neighbour from set A or set B depending
on a condition"). It compiles and runs correctly on **JS**, but the **WASM** target rejects it:

```
[wasm] recompile failed, falling back to JS:
  pickRandomNeighbor: input "indexes" must come from an array-producing node
  (filterNeighbors / getNeighborIndexesByTags / joinNeighbors)
```

**WebGPU** would reject it the same way. Root cause: both backends gate array-input resolution on
`isArrayProducer(nodeType)` — a purely **type-based** allowlist that does not include `valueSwitch`.

This is a clean **compiler-lockstep gap**: JS supports conditional array selection through
`valueSwitch`; WASM/WebGPU do not. The editor already permits the wiring (`isValidConnection` checks
NI dataType compatibility, which `'any'` passes; it does not enforce array→scalar shape).

**Goal:** make `valueSwitch` a first-class **conditional array selector** on all three targets, so
`cond ? arrayA : arrayB` works whenever both branches are arrays — achieving lockstep. Scalar
`valueSwitch` behaviour stays byte-identical.

This is NOT an implementation plan — it is the precondition to one. One section per subsystem.

---

## The core design challenge — `valueSwitch` is *dual-mode*

`valueSwitch` produces a **scalar** when fed scalars and an **array** when fed arrays. The mode is
**not** knowable from `nodeType` alone (contrast `getVariable`, whose array-ness is in its config:
the referenced variable's `kind`). It depends on what is wired to `ifValue` / `elseValue`.

`isArrayProducer(nodeType: string)` therefore cannot answer the question. We need a **context-aware**
predicate:

```
producesArray(node, ctx):
  if isArrayProducer(node.type):           return true            # static producers
  if node.type === 'valueSwitch':
     ifSrc   = source feeding `${node.id}:ifValue`
     elseSrc = source feeding `${node.id}:elseValue`
     if !ifSrc || !elseSrc:                return false           # a branch is an inline scalar
     return producesArray(ifSrc) && producesArray(elseSrc)        # recursive (memoized, cycle-guarded)
  return false
```

- **Both** branches must be array producers → array mode (the node selects between two arrays).
- **Exactly one** branch an array, the other a scalar → **malformed**; the array emitter raises a
  compile error rather than silently picking one (shapes must match).
- Recursion handles `valueSwitch → valueSwitch` chains (the value graph is a DAG; memoize + an
  in-progress guard make it O(N)).

`getVariable` is left exactly as it is (returns `true` from `isArrayProducer`, disambiguated by its
own array/scalar emitter via the variable's `kind`).

`producesArray` replaces the *source-node* `isArrayProducer(...)` checks (the ones that ask "does the
node feeding this port emit an array?"). It does **not** replace `isArrayProducer` used as a
table-membership test (e.g. "is there an `ARRAY_NODE_EMITTERS` entry"), nor the `NI_ARRAY_PRODUCERS`
checks (those decide an NI-vs-0 fallback sentinel and are orthogonal).

---

## 1. Type system / editor validation

- `dataType` union: **no change**. `valueSwitch` ports stay `'any'`; array-ness is structural.
- `isValidConnection` (GraphEditor): **no change** — already allows array→`'any'`-scalar and
  `'any'`-scalar→array NI wiring. The user's two edges are already legal.
- `portsCompatible` (the *menu / panel-drag* compatibility, GraphEditor.tsx:113): rejects
  array-source → scalar-target, so the **compatible-nodes menu** does not *suggest* `valueSwitch`
  when dragging from an array output. The manual wire still works. **Optional follow-up** (out of
  scope for the fix): teach the menu that `valueSwitch` is an array-capable relay. Listed under Open
  Decisions.
- `nodeValidation.ts`: **optional** amber-badge when a `valueSwitch` has one array branch + one
  scalar branch (the compiler will error regardless). Nice-to-have.

## 2. JS compiler (`compiler/compile.ts`)

- **CORRECTION (caught during verification by inspecting emitted code, not just "compiles"):** the
  initial "no change" read was WRONG. The *producer* side is free — `const _v<id> = (cond) ? (ifV) :
  (elV)` already holds the chosen array. But the **consumer** side wraps: `valueSwitch.result` is a
  scalar-typed port, so the isArray-input resolution emitted `const _pickArr = [_v<id>]` (a 1-element
  array of the array), so `pickRandomNeighbor` silently picked element 0 instead of a random element.
- **Fix:** `sourceYieldsArray(srcNodeId, srcPortId)` — a JS-local recursive helper (the JS analogue of
  `producesArray`; JS stays port-based because its array-ness is per-output-port, not per-nodeType):
  true for a static `isArray` output port, an array-kind `getVariable`, or a `valueSwitch` whose both
  branches yield arrays. The isArray-input resolution now passes a yields-array source through
  (`srcName`) instead of wrapping (`[srcName]`). This *extends* the pre-existing array-kind-getVariable
  pass-through that was already there. Scalar `valueSwitch` → isArray port still wraps (correct).
- (Sink/volatile/CSE analysers are target-independent and already see `valueSwitch` as an ordinary
  value node; no array-specific handling needed there because JS has no static array representation.)

## 3. WASM compiler (`compiler/wasm/compile.ts`)

- **New `ARRAY_NODE_EMITTERS['valueSwitch']`.** Resolve `ifValue` + `elseValue` as `ArrayRef`
  (`resolveInputArray`), evaluate `condition` as a scalar I32. Both branch arrays are already
  materialised in per-cell bump-pointer scratch (the node's contract is "both inputs always
  evaluate"), so the result is a **zero-copy select** of the offset/length pair:
  `resultOffset = select(ifOff, elseOff, cond)`, `resultLen = select(ifLen, elseLen, cond)`,
  `elemValtype` from either branch (assert both equal; error on mismatch). Return that `ArrayRef`.
- **`valueSwitch` stays in `VALUE_NODE_EMITTERS`** (scalar mode). Dual-registered, exactly like
  `getVariable`. The scalar emitter should assert it is *not* an array relay (defensive).
- **Add `producesArray(node, ctx)`** (memoized in ctx) and replace the **source-disambiguation**
  `isArrayProducer(srcNode.data.nodeType)` calls with it. Call sites to convert:
  - `resolveInputArray` gate (≈ line 4800) — the broad one; covers `pickRandomNeighbor`,
    `arrayElement`, `arrayLength`, `forEachInArray`, `pickNRandomNeighbors`, `joinNeighbors.a/b`,
    `getNeighborsAttrByIndexes.indexes`, `interactionTableMap`, `setNeighborAttributeByIndex.index`,
    `setNeighborOrientationByIndex.index`.
  - `emitAggregateOrCount` single-ArrayRef source (≈ 2550)
  - aggregate/count array-source path (≈ 2338)
  - groupOperator weightedRandom/random single-array-source (≈ 1408)
  - setNeighborAttributeByIndex index-array (≈ 5318)
  - setNeighborOrientationByIndex index-array (≈ 5610)
- Pre-emit walk (`emitValuesForScope` / sink consumption): an array-relay `valueSwitch` must route
  through `compileArrayNode`, not the scalar `compileValueNode`. Mirror the `getVariable` handling.
- `NI_ARRAY_PRODUCERS` membership (the INVALID_NI fallback in `arrayElement`, line 934) — a
  `valueSwitch` relaying NI arrays should arguably inherit "NI" for the empty/out-of-range sentinel.
  Decide: extend the NI check through `valueSwitch` (recursively) too, or accept `0` fallback for
  the relayed case. (Open decision — low stakes; only affects the sentinel on empty/OOB.)

## 4. WebGPU compiler (`compiler/webgpu/compile.ts`)

- **New array emitter for `valueSwitch`.** WGSL `var<function>` arrays are fixed-size and cannot
  alias, so this is a **copy**, not a pointer-select: allocate `result` with
  `maxLen = max(ifArr.maxLen, elseArr.maxLen)`, then
  `if (cond) { for k<ifLen: result[k]=ifArr[k]; result_len=ifLen } else { …elseArr… }`.
  Assert `elemType` match. Return the result `ArrayRef`.
- Same **`producesArray(node, ctx)`** helper; replace the source-disambiguation `isArrayProducer`
  sites (≈ lines 744 gate, 943, 990, 1600, 2163, 2273, 2521, 3046/3051 & 3149 pre-emit walks).
- `preEmitValueNodes` + `suppressVolatile`/`forceCurrentScope` paths must treat an array-relay
  `valueSwitch` as an array producer (route to `compileArrayNode`), mirroring `getVariable` at 3149.
- **No new rejection** in `detectWebGPUIncompatibilities` — the copy-loop relay is fully supported on
  WebGPU. (Only the pre-existing general `aggregate.median` / `groupOperator.random` rejections still
  apply, independent of this feature.)
- WGSL has no f64 etc. — same precision caveats as all other array nodes; not new.

## 5. Node catalogue / docs

- `docs/NODES_REFERENCE.md`: update the `valueSwitch` entry — note it relays arrays (dual-mode), and
  that selecting between two NI arrays then feeding `pickRandomNeighbor` is the canonical pattern.
- `CLAUDE.md`: add a short note (compiler section) — `valueSwitch` is a dual-mode value/array relay;
  `producesArray()` context-aware predicate; WASM = zero-copy offset/len select, WebGPU = copy loop,
  JS = free.
- `src/help/HelpView.tsx`: update if Value Switch is described there.
- Node count unchanged (no new node type). `CategoricalColor`-style registry edits: none.

## 6. Verification (all three targets)

Build a probe graph (via `window.__simWorker` direct postMessage, the documented reliable harness):
- `filterNeighbors` (or `getNeighborIndexesByTags`) → `valueSwitch.ifValue`
- a second array source → `valueSwitch.elseValue`
- a `condition` source → `valueSwitch.condition`
- `valueSwitch.result` → `pickRandomNeighbor.indexes`

Assert: compiles with **no errors** on JS / WASM / WebGPU; the picked neighbour comes from the
correct branch array per the condition (parity across targets, modulo the documented RNG-stream
differences). Then exercise the other array consumers reached via the shared `resolveInputArray`
gate — `arrayElement`, `arrayLength`, `forEachInArray`, `aggregate` — fed from a `valueSwitch`.
Confirm a **scalar** `valueSwitch` is byte-identical (no dispatch regression). `npx tsc -b` clean.

---

## Open design decisions

1. **Both-branches-array requirement.** Require BOTH `ifValue` & `elseValue` to be array producers
   for array mode (recommended — unambiguous, matches "shapes must match"); error on a mixed
   array/scalar pair. Alternative (reject): treat as array if *either* is an array — rejected because
   it silently tolerates a malformed graph.
2. **NI sentinel inheritance.** **DECIDED: do NOT recurse.** The `NI_ARRAY_PRODUCERS`-driven
   `arrayElement` empty/OOB fallback (`INVALID_NI` vs `0`) stays type-based on all three targets.
   Reason: **JS already uses the `0` fallback** for a valueSwitch-relayed NI array (its `_elemKind`
   is `'value'` because `NI_ARRAY_PRODUCERS.has('valueSwitch')` is false), so recursing the check on
   WASM/WebGPU would DIVERGE from JS. Parity > the marginally-more-correct `INVALID_NI`. The
   canonical case — `pickRandomNeighbor` — always uses `INVALID_NI` regardless of source, so it is
   unaffected. (Implemented as decided: the `NI_ARRAY_PRODUCERS` checks were left untouched; only the
   `isArrayProducer` *array-producer* checks were swapped to `ctx.producesArray`.)
3. **Editor menu suggestion (`portsCompatible`).** **DONE (follow-up).** Added `PortDef.arrayCapable`
   (set on valueSwitch's ifValue/elseValue/result); `portsCompatible` (GraphEditor) + the `shapesMate`
   mirror (modelElementDrag) relax the array→scalar rejection when the target port is `arrayCapable`,
   threaded via `ConnectionOrigin.arrayCapable` + `getOriginPortInfo`. Both drag directions now offer
   Value Switch in array contexts. Verified: the panel-drag path via the exported
   `computeCompatibleHandlesForDrag` (Value Switch If/Else now offered for a Neighborhood drag, scalar
   consumers unregressed); the connection-drop menu uses the identical mirror + threading (tsc + code
   review; a live synthetic connection-drag test was not run as React Flow's onConnectEnd is unreliable
   to drive synthetically).
4. **`producesArray` placement.** Per-target duplicate (mirrors the existing duplicated
   `isArrayProducer`) vs. one shared helper parameterised by `(node, inputToSource, nodeMap)` in a
   common compiler util. Recommend a shared helper to avoid drift (lockstep risk if duplicated).

## Recommended step sequence

1. Shared `producesArray` helper (or per-target, decision #4) + memo cache field on each ctx.
2. WASM: array emitter + dual-registration + swap the 6 source-disambiguation sites + pre-emit route.
3. WebGPU: array emitter (copy loop) + swap the ~10 sites + pre-emit route.
4. Docs sweep (NODES_REFERENCE + CLAUDE.md + Help).
5. Cross-target verification + `tsc -b`.

(JS needed a consumer-side fix after all — `sourceYieldsArray` so the isArray-input resolution
passes an array-relay source through instead of wrapping it `[src]`; see §2. Caught during
verification by inspecting emitted code, which is why the compile probe dumped the actual JS/WGSL.)

## Verification outcome (2026-05-27)

Verified via a standalone cross-target **compile probe** (`filterless` graph:
`getAllNeighborIndexes ×2 (Moore + von Neumann) → valueSwitch → pickRandomNeighbor →
getNeighborAttributeByIndex → setAttribute`) + **emitted-code inspection** on all three targets
(throwaway script, since deleted):
- **JS** — `const _v_sw = cond ? _v_ganiA : _v_ganiB; const _pickArr = _v_sw;` (no wrap; distinct
  branch arrays). Pre-fix it emitted `[_v_sw]` (the silent element-0 bug).
- **WASM** — compiles (no array-producer error); zero-copy `OP_SELECT` of the two branches' offset/len.
- **WebGPU** — `if (cond) { copy _arrAllNbr1 } else { copy _arrAllNbr2 } ; <random pick over result>`.
- **Scalar valueSwitch** regression guard compiles on all three (WebGPU uses the scalar `select`, no
  array copy).
- `npx tsc -b` clean.

NOT done: live simulator runtime (instantiate WASM / dispatch WebGPU on GPU and observe pixels) — the
compile + emit evidence is decisive for this compile-path change, but a live run was not performed.
