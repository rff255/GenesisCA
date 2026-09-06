# Verification harnesses (`scripts/*.mjs`)

> Area doc for **GenesisCA**. The project's regression net: 67 Node harnesses that run the SHIPPED
>
> **Also read** — a change here usually reaches [`compiler-core.md`](compiler-core.md) · [`agent-compilers.md`](agent-compilers.md) · [`agent-engine.md`](agent-engine.md).
> Keep following those onward until a pass turns up nothing new; the reading is not done at the first
> doc that answers your question. See *Read to CLOSURE, not to the first hit* in `../../CLAUDE.md`.
> modules (esbuild-bundled where needed) rather than re-implementations. Generated from the script
> headers on 2026-09-06 — regenerate rather than hand-editing when scripts are added.
>
> **House style, and it is why these are trustworthy:** a harness asserts VALUES, not "it compiled";
> every claim is NEGATIVE-CONTROLLED (usually by a deliberate source mutation that must make it fail);
> and a fixture must DISCRIMINATE (two code paths that agree on it prove nothing). Follow that when adding one.

> **Paths here are repo-root-relative** (e.g. `src/model/types.ts`), exactly as they were in `CLAUDE.md`.
> Read them from the repository root; they will not resolve as links from this directory.

Run one with `node scripts/<name>.mjs`. Several take flags (`--wasm`, `--mutate`, `--self-test`, `--capture`/`--compare`, `--check`) — read the header.

## Gates — run these before calling a change done

| script | what it holds |
|---|---|
| `check-agent-wasm-gate.mjs` | DEV check — for each agent sample model: gate (isAgentGraphWasmSupported) + |
| `check-compile-identity.mjs` | Cross-target compile BYTE-IDENTITY regression tool. |
| `check-no-unseeded-random.mjs` | C7 (P7) — DETERMINISM GATE. |

## Verifiers — structural / invariant harnesses

| script | what it holds |
|---|---|
| `verify-3d-depth-precision.mjs` | 3D depth-precision harness — the bond-vs-agent occlusion contract. |
| `verify-agent-render.mjs` | Agent RENDER-LAYER regression harness. |
| `verify-graph-rewrite.mjs` | GRAPH-REWRITING AUTOMATA — the invariant + oracle harness. |
| `verify-handle-remeasure.mjs` | HANDLE-REMEASURE invariant harness (VPL editor layer). |
| `verify-render-uniform-layouts.mjs` | GPU uniform-layout regression harness — WGSL struct  ⇄  TypedArray writer. |
| `verify-sparse-stepping.mjs` | Correctness proof for "Skip Isolated Empty Cells" (docs/PLAN_LARGE_GRID_PERF.md). |
| `verify-webgpu-attr-write.mjs` | Guards the "drop the CPU sync attribute WRITE buffer on the WebGPU grid target" |
| `verify-webgpu-nbr-table.mjs` | Guards the "drop the dead CPU neighbour table on the WebGPU grid target" |
| `verify-wgsl-float-literals.mjs` | WGSL FLOAT-LITERAL RANGE GUARD. |

## Parity — cross-target bit-identity

| script | what it holds |
|---|---|
| `parity-agent-force.mjs` | Force-pass PARITY harness — JS force loop vs the WASM `forcePass`, for the |
| `parity-agent-wasm.mjs` | JS↔WASM BIT-PARITY harness for the FULL-COVERAGE WASM agent BEHAVIOUR module. |

## Audits — layout & ABI mirror-site drift guards

| script | what it holds |
|---|---|
| `audit-agent-layout.mjs` | STEP 0 — 4-site agent-ABI FIELD-ORDER AUDIT. The three CPU-side ABI mirrors |
| `audit-modelattr-layout.mjs` | MODEL-ATTRIBUTE SLOT LAYOUT AUDIT — the mirror-site drift guard. |

## Feature tests — value-level, one per feature

| script | what it holds |
|---|---|
| `test-agent-abi.mjs` | STEP 0 verification for the shared agent-ABI descriptor: prove that |
| `test-agent-capabilities.mjs` | STEP 1 verification for Agent Capability Profiles: preset closure-stability + |
| `test-agent-sprite-webgpu.mjs` | Set Agent Sprite on the WebGPU agent target — verification. |
| `test-archetypes.mjs` | C7 (P6) — MODEL ARCHETYPE gate. |
| `test-asc-import.mjs` | Esri ASCII grid (.asc) import / export verification. |
| `test-assert-viewer.mjs` | Assert Active Output Mapping — functional verification on ALL THREE cell |
| `test-bonds-allocation.mjs` | STEP 3 verification: the Bonds capability gates the ragged bond store. A |
| `test-by-id-self-default.mjs` | BY-ID AGENT READERS — an UNWIRED `Agent` id means SELF (the current agent). |
| `test-c9-gates.mjs` | C9 — the STANDING GUARD for (STEP 4) profile-gated agent SoA fields and |
| `test-composite-relay.mjs` | Composite (vector / colour) WIRING — functional verification. |
| `test-cross-agent-writes.mjs` | Cross-agent write semantics — verification. |
| `test-csv-export.mjs` | CSV export — serialization + the ROUND TRIP through the import machinery. |
| `test-csv-import.mjs` | CSV import — parser / decoder / column-mapping verification. |
| `test-engine-resolve.mjs` | C4 (P1) — ENGINE RESOLUTION gate. |
| `test-explicit-controls.mjs` | EXPLICIT CONTROLS (macros) — functional verification. Phase P1: schema, the |
| `test-generation-pipeline.mjs` | C2 (P3) — GENERATION PIPELINE drift guard. |
| `test-geojson-import.mjs` | GeoJSON vector import verification. |
| `test-geometry-taint.mjs` | C8 (P9) — PRESENTATIONAL-GEOMETRY TAINT drift guard. |
| `test-geotiff-import.mjs` | GeoTIFF import verification. |
| `test-get-indicator.mjs` | Get Indicator — the SHAPE contract between the picker, the badge and the engine. |
| `test-get-random.mjs` | Get Random overhaul — functional verification of the parameterised intervals, |
| `test-gif-encode-yield.mjs` | GIF encode: the yielding path is BYTE-IDENTICAL to the non-yielding one. |
| `test-global-periodic.mjs` | GLOBAL PERIODIC EVENTS — Grid Periodic Event (cells) + Population Periodic |
| `test-grid-dimensions.mjs` | Get Grid Dimensions — functional verification across all six compile surfaces. |
| `test-growing-graphs-physics.mjs` | PHYSICS-PARITY harness for `Growing Graphs` — our engine's layout vs a Node port |
| `test-hemifield-logic.mjs` | LOGIC check for Sense Hemifield (the L/R Braitenberg reduction). Parity proves |
| `test-layout-iterations.mjs` | L3 — `layoutIterations`: the engine knob that runs the force integrator N times |
| `test-logical-expression.mjs` | Logical Expression node — grammar + functional verification. |
| `test-loop-index.mjs` | Loop node `index` output — functional verification (grid targets). |
| `test-macro-expand.mjs` | MACRO EXPANSION — the shared flattening every compile target runs. |
| `test-macro-move-scope.mjs` | MOVE A SELECTION ACROSS A MACRO BOUNDARY — functional verification. |
| `test-macro-references.mjs` | Macro reference collection (M1) — functional verification. |
| `test-math-int-ops.mjs` | Math node unary ops — floor / ceil / round / negate — functional verification. |
| `test-ndtable.mjs` | N-D Lookup Table functional verification (PR1). |
| `test-overseer-compile.mjs` | DEV check — compiles synthetic Overseer graphs and RUNS the emitted async |
| `test-param-input-mappings.mjs` | Parameterized Input Mappings — Phase 1 functional verification. |
| `test-positional-collision.mjs` | Behaviour test for the HARD positional collision (resolvePositionalCollisions): |
| `test-rgba-colors.mjs` | RGBA colours — the regression standard for alpha through the colour-producer chain. |
| `test-rule-cadence.mjs` | L2 — RULE CADENCE: `Get Generation` (universal) + `Periodic Step` (agents). |
| `test-sprite-crop.mjs` | Sprite CROP + COLORIZE verification — the pure rules the decoder, the dialog and |
| `test-sprite-sheet.mjs` | Sprite-sheet GRIDDING verification — the pure geometry + frame-selection rules |
| `test-torus-neighbours.mjs` | TORUS SEAM regression test for the agent NEIGHBOUR QUERY (Get Nearby Agents / |
| `test-vector-attr-compile.mjs` | Compile-level test: a CELL model that WRITES a vector attribute (via Set Vector |
| `test-vector-attr.mjs` | Unit test for the pure vector-attribute lowering helpers (vectorAttr.ts). |
| `test-vector-rotate.mjs` | Vector Op — Rotate (2D) + Rotate Around Axis (3D): functional verification. |

## Benchmarks & probes (measurement, not gates)

| script | what it holds |
|---|---|
| `bench-agent-behaviour.mjs` | HEAVY-RULE BENCHMARK — the agent BEHAVIOUR fn (the new full-coverage surface) |
| `bench-agent-engine.mjs` | AGENT ENGINE END-TO-END PHASE PROFILER — where does each millisecond of a |
| `bench-agent-force.mjs` | DEV-only scale benchmark — the agent FORCE INTEGRATOR (the hot per-step agent |
| `bench-lattice.mjs` | LATTICE (CA GRID) END-TO-END PHASE PROFILER — the grid sibling of |
| `bench-spatial-index.mjs` | SPATIAL INDEX BENCHMARK — C11 / proposal P11 item 2 ("adaptive spatial index"). |
| `probe-graph-layout.mjs` | PROBE / GATE — does a grown bond-graph lay out readably, or collapse into a |

---

## The two that gate almost everything

- **`check-compile-identity.mjs`** — hashes every shipped model's emitted output on every surface
  (JS step / grid-init / WASM bytes / WGSL / agent behaviour / agent division / agent init / overseer).
  `--capture` a baseline, `--compare` after. **A new emitted surface MUST be added to its list** — a
  surface it does not hash is a surface with no regression net at all.
- **`parity-agent-wasm.mjs`** — JS↔WASM bit-parity over every agent sample plus permanent synthetics.
  Parity is a MIRROR test: it passes when both targets are equally wrong, so entries carry a VALUE
  `invariant(store)` that recomputes the expected answer independently.

