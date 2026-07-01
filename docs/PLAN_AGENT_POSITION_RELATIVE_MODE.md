# Plan — Get Agent Position: Absolute / Relative mode

## Context

`getAgentPosition` (Bond-Graph Agents) currently outputs **only** the absolute
position `(X, Y[, Z])` of a specific agent given an integer handle. To get a
*relative* vector (e.g. cohesion / separation / "steer toward neighbour"), users
must reach for the separate `getAgentOffset` node, which only ever measures from
**self** (the loop index `idx`).

The user wants **one node** that toggles between:

- **Absolute** — raw position of the agent at `agentId` (today's behaviour).
- **Relative** — the torus-shortest displacement `target.pos − ref.pos`, where
  the reference defaults to **self** but can optionally be any agent via a new
  `refId` input. This also subsumes "offset between two arbitrary agents".

**Backward compatibility is mandatory:** every existing `getAgentPosition` node
(serialized `config: {}`, no `mode`) must compile **byte-identically** on JS /
WASM / WebGPU. New nodes default to `mode: 'absolute'`; every emitter treats an
absent `mode` as absolute.

`getAgentOffset` is **kept** (it ships the `Distance` output and is the ergonomic
self→target shape, referenced across docs/examples). Relative `getAgentPosition`
generalizes it (arbitrary reference, no Distance); the two coexist and their CSE
keys differ by `nodeType`, so there's no merge hazard.

## Design decisions

| Decision | Choice |
|---|---|
| Config | `mode: 'absolute' \| 'relative'`, default `'absolute'` |
| Reference input | new `refId` integer port, **hidden in absolute mode**, defaults to `idx` (self) when unwired |
| Relative math | mirror `getAgentOffset`'s torus fold (`_fieldW/_fieldH/_fieldD/_fieldBoundaryTorus`) — wrap-correct, **not** naive subtraction |
| Outputs | stay `X/Y/Z` (carry the displacement in relative mode); **no** Distance output |
| Targets | JS / WASM / WebGPU lockstep, 2D + 3D |

No ABI change: the world-bound params relative mode reads are **already** threaded
through the agent loop (`getAgentOffset` uses them).

## Implementation

### 1. Node def — [GetAgentPositionNode.ts](src/modeler/vpl/nodes/GetAgentPositionNode.ts)
- `defaultConfig: { mode: 'absolute' }`.
- Add `refId` integer input port after `agentId` (label "Reference").
- `hiddenPorts(config, model)`: hide `z` in 2D (as today) **and** hide `refId`
  unless `config.mode === 'relative'` (mirror the combined-condition pattern in
  [ApplyForceNode.ts](src/modeler/vpl/nodes/ApplyForceNode.ts)).
- `compile()`: branch on `config.mode`.
  - **absolute** → return today's exact string (untouched).
  - **relative** → mirror [GetAgentOffsetNode.ts](src/modeler/vpl/nodes/GetAgentOffsetNode.ts)
    but with `ref = inputs['refId'] ? '((refId)|0)' : 'idx'`, output ports
    `_v<id>_x/_y/_z`, no distance line. 3D arm (`__oz` + `_fieldD` fold) gated on
    `ctx?.is3d`. Unwired-input idiom: `inputs['refId'] ? … : 'idx'` (precedent:
    [GetVelocityNode.ts](src/modeler/vpl/nodes/GetVelocityNode.ts)).

### 2. WASM — [agentWasm/compile.ts](src/modeler/vpl/compiler/agentWasm/compile.ts)
- The `getAgentPosition` case branches on `mode`; absolute arm unchanged.
- Relative arm = a near-clone of `compileAgentOffset` with: ref local detected via
  `ctx.adj.inputToSource.get(\`${node.id}:refId\`)` → else `ctx.idxLocal` (precedent:
  the `getVelocity` case); **no** distance/hypot; cache results under `:x/:y/:z`
  (the multi-output caching contract — one emit fills all axes). Reuse the existing
  `foldTorus` helper. `getAgentPosition` stays in `AGENT_WASM_SUPPORTED_TYPES`.

### 3. WebGPU — [agentWebgpu/compile.ts](src/modeler/vpl/compiler/agentWebgpu/compile.ts)
- Same branch + relative clone of `compileAgentOffset`: ref name via
  `ctx.adj.inputToSource.get(...)` → else `'idx'`; no distance; cache `:x/:y/:z`;
  reuse the `if (control.fieldTorus != 0u) { … }` fold. `z` ref falls back to
  `'0.0'` in 2D. `Control` already carries fieldW/H/D/fieldTorus. Stays in
  `AGENT_WEBGPU_SUPPORTED_TYPES`.

### 4. CaNode UI — [CaNode.tsx](src/modeler/vpl/CaNode.tsx)
- Add a `mode` `<select>` (Absolute / Relative) for `getAgentPosition`, mirroring
  the existing Filter/Join Agents config selects, written via the single
  `updateConfig('mode', …)` pattern. Writing `config.mode` re-runs `hiddenPorts`
  so the `refId` handle appears/disappears live; call `updateNodeInternals(id)` on
  change if the handle doesn't reposition automatically.

### 5. Registries / validation — **no change**
`MULTI_OUTPUT_TYPES`, `NEVER_INVARIANT`, and the CSE purity set already cover
`getAgentPosition` correctly; `mode` has a default and `refId` is optional, so
`nodeValidation.ts` needs no case.

### 6. Docs (keep all sources in sync)
- `CLAUDE.md` — the `getAgentPosition` parenthetical in the agent neighbour-access
  bullet.
- [HelpView.tsx](src/help/HelpView.tsx) — the "Get Agent Position / Offset" bullet
  + soften the "use Offset, not raw subtraction" caveat (relative mode is now
  wrap-correct too).
- `README.md` — the agent neighbour-access sentence.
- [docs/NODES_REFERENCE.md](docs/NODES_REFERENCE.md) — the `getAgentPosition` row
  (both modes, `refId` input, all-three-targets note) + cross-reference to
  `getAgentOffset`.

## Verification

- **Byte-identity (absolute):** `compileAll` ([compileHarness.ts](src/dev/compileHarness.ts))
  on a model with an existing absolute `getAgentPosition`, before/after — JS
  `behaviourCode` char-identical, WASM bytes identical, WGSL identical. Re-run the
  standard agent baselines (Boids polarization, the JS↔WASM bit-parity samples).
- **Correctness (relative):** a tiny model where relative `getAgentPosition`
  (refId unwired) equals `getAgentOffset`'s (dX, dY[, dZ]) for the same target —
  including a **torus-seam** case (target & reference on opposite sides → vector
  points the short way). Wired `refId` → equals `target.pos − ref.pos` folded.
- **Cross-target:** JS↔WASM bit-parity (f64, exact); WebGPU run (f32, close — same
  tolerance as existing WebGPU agent parity).
