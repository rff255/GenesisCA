# Impact Map — Flow pass-through output port (`next`)

**Request:** every node with a flow input gains a flow OUTPUT so actions can chain
UE-Blueprints-style (`Set A → Set B → Set C`) instead of fanning out N wires from one
DO port or inserting Sequence nodes. Visual companion:
[IMPACT_MAP_FLOW_PASSTHROUGH.html](IMPACT_MAP_FLOW_PASSTHROUGH.html).

## Design

- **Port:** id `next`, `category: 'flow'`, `kind: 'output'`, defined STATICALLY in each
  node's `def.ports`. The id `next` is free (only used as an *operation* config value on
  Update Attribute/Indicator — different namespace).
- **Action (sink) nodes** — all 16 with `IN=[do] OUT=[]` (setAttribute, updateAttribute,
  setVariable, setArrayElement, setColorViewer, setCellGlyph, setIndicator,
  updateIndicator, setNeighborhoodAttribute, setNeighborAttributeByIndex, setOrientation,
  setFacingOrientation, setNeighborOrientationByIndex, moveSelfToNeighbor,
  markCellUpdated, stopEvent): label **NEXT**, the node's only output → renders at the
  top right. Semantics: targets run immediately after the action, same scope.
- **Control nodes** (conditional, loop, forEachInArray, switch): label **DONE**, placed
  FIRST among outputs (top-right, aligned with the flow input — keeps chains on a
  horizontal through-line; branch outputs THEN/ELSE/BODY/CASE_N/DEFAULT hang below).
  Semantics: targets run after the whole construct (after the if/else, after all
  iterations, after the matching case(s)), at the construct's own scope.
- **Excluded:** `sequence` (it IS the sequencing construct; its last THEN is the
  continuation), entry points (no flow input), macro instances + boundary nodes (no
  internal anchor for a pass-through; macro flow outputs stay user-exposed ports).
- **Edge cases:** a forEachInArray with NO array wired skips its body **and its DONE
  chain** (both compilers `continue` — unchanged semantics; an unwired forEach is
  already a validation-badge graph). Flow diamonds via `next` behave like existing
  diamonds (inline re-emission, analyzer diamond-taint hoists values out).

## Performance verdict — no runtime cost

`A.next → B` emits the SAME code as today's `parent → A, parent → B` fan-out (B's lines
placed right after A's). Zero per-cell overhead on all three targets; compile-time cost
is one extra no-op map lookup per flow node. Old models have no `next` edges → all walks
no-op → **byte-identical output** (verified on Game of Life: identical Show Code before/
after). Required by the request ("if it is not a major performance issue, we must add
this") — satisfied.

## Subsystem-by-subsystem

| # | Subsystem | File / site | Change |
|---|---|---|---|
| 1 | Node defs | 20 files in `nodes/` | Static `next` port — first output on sinks (NEXT) AND first among control-node outputs (DONE), placed before the branch ports in the def |
| 2 | Editor render | `CaNode.tsx` switch block; `effectivePorts.ts` switch block | Re-hoist `next` to the FRONT of the outputs after dynamic `case_N` pushes so DONE stays first/top. Everything else (handles, labels, collapse, validation, copy/paste, reroute) is port-generic |
| 3 | JS compiler | `compile.ts` `compileFlowChain` | One line at the end of the per-target dispatch: `compileFlowChain(node.id, 'next', indent)` — emits the chain after the node/construct at the same indent. `collectValueDeps` already iterates ALL flow-output edges (prefix scan) → next-subtree value deps collected automatically |
| 4 | Sink analysis | `sinkAnalysis.ts` `walkFlowNode` | After each typed dispatch (and for terminal actions): `walkFlowOutput(nodeId, 'next', parentScope)` — `next` is TRANSPARENT (no new scope). Diamond bookkeeping (`flowNodeContainingScopes`) covers next-reached nodes because it records before the visited-guard |
| 5 | Volatile hoist | `volatileHoist.ts` `walkNode` | Same transparent walk; next-children become later MEMBERS of the same scope chain, so `emitBefore` placement stays consistent with emission order |
| 6 | Async hazard | `asyncWriteHazard.ts` `walkNode` | Walk `next` with prefix = entry ∪ own writes (actions) / entry ∪ branch-body writes (control nodes). `writesInSubtree` already includes next-subtrees (prefix scan) so sibling accumulation in `walkOutput` is correct unchanged |
| 7 | WASM compiler | `wasm/compile.ts` `compileFlowChain` + `visitFlow` (invariant pre-emit) | End-of-dispatch `compileFlowChain(node.id,'next',ctx)` (bytecode lands after the closed block — WASM structured control flow gives correct placement for free); switch `caseCount===0` `continue` path runs next first. `visitFlow`: walk `next` inside the seen-guard |
| 8 | WebGPU compiler | `webgpu/compile.ts` `compileFlowChain` + `preEmitValueNodes` + `analyzeAlwaysWritten` | Same end-of-dispatch hook (+ the switch `continue` path); preEmit recurses into `next` (same top-scope hoisting as siblings — but NOT for forEach bodies, whose exclusion is body-only; a forEach's next chain is outside the loop); alwaysWritten: a target's next-subtree is as guaranteed as the target itself → union `analyzeAlwaysWritten(node,'next')` into `out` for every node type (a loop's body gives no guarantee but its DONE chain always runs) |
| 9 | Docs | NODES_REFERENCE / Help / README / CLAUDE.md | Port tables + a "Chaining actions" explainer |

**Not touched:** worker/runtime (no new runtime concept), schema/`types.ts` (GraphEdge
already serializes arbitrary handles), `isValidConnection` (flow-cycle BFS + category
checks already cover `next`), macroExpand/rerouteCollapse/accessorCSE/fusion/
loopInvariant (edge-generic or value-only), panel drag + connection-drop menus
(generic over `getEffectivePorts`).

## Order-of-execution rules (user-facing)

1. Targets of one port still run in wiring order (unchanged).
2. A node's `next` chain runs immediately after it — BEFORE the parent port's next
   sibling target. Depth-first, like UE.
3. `DONE` on control nodes runs after the construct completes — regardless of which
   branch ran (or none, e.g. an if with no else whose condition was false).

## Follow-ups (out of scope)

- Sequence keeps its role for fan-style ordering; no DONE port on it.
- Macro instances could expose a synthesized pass-through some day — needs a design for
  "which internal point is 'done'".
