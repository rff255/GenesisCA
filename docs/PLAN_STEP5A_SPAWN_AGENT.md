# Plan — STEP 5a: Spawn Agent + Spawn Event (Population · Birth)

**Branch:** `absorb_old_automatosgt` · **Milestone:** Agent Capability Profiles (see CLAUDE.md
"Agent Capability Profiles" + HANDOFF_AGENT_CAPABILITY_PROFILES.md §2). · **Do NOT push, do NOT bump
version, do NOT add Co-Authored-By.**

Illustrated mockup: [PLAN_STEP5A_SPAWN_AGENT.html](PLAN_STEP5A_SPAWN_AGENT.html).

---

## 0. Goal + user value

Let the **behaviour graph** spawn NEW agents *mid-step* — eggs, projectiles, offspring, budding,
particle emitters — a genuine population change **during** the run. This is the Population·Birth
capability (`populationBirth`), currently hidden (`HIDDEN_CAP_ROWS_V1`) because its nodes aren't
registered yet. It is **distinct from the always-available INIT-time spawning** (`Create Agent` +
`Add Agent To World` inside the `agentInit` root), which only runs once on load/Reset.

The infra is already anticipated: `AGENT_NODE_REQUIREMENT` maps `spawnAgent`/`spawnEvent →
'populationBirth'`; `estimateAgentFootprint` already reserves the spawn-request bytes
(`1 + 2·8 + 8 + 2·8 + 1 + 2·F`); the `populationBirth` capability row exists with the copy
"Spawn agents mid-step (eggs / projectiles / offspring). Unlocks Spawn Agent + the Spawn Event root."

---

## 1. The two nodes

### `spawnAgent` (flow, `output`, `requirements.bondGraph`) — the request
A behaviour-graph flow node. Ports (mirrors `divideAgent`/`createAgent`):
- `do` (flow in) / `next` (flow out)
- `x`, `y` (float, inline, default 0) — spawn position (world coords). 3D adds `z` (`hiddenPorts`).
- `radius` (float, inline, default 1)
Config: `inheritAttributes?: boolean` (default **true** — the spawned agent copies the PARENT's
current attribute values, exactly like `divideAgent` daughters; false = attribute defaults). Optional
`count`? is **out of scope for v1** (one spawn request per agent per step — see §7 "one-per-step").

Emit (all 3 targets, request-buffer pattern — **identical shape to `divideAgent`**):
```
_spawnRequest[idx] = 1; _spawnX[idx] = <x>; _spawnY[idx] = <y>;[ _spawnZ[idx] = <z>;] _spawnRadius[idx] = <radius>;
```
Nothing is allocated at emit time — the STRUCTURAL PHASE (CPU, serial, target-independent) reads the
request and allocates. So spawning works on the parallel targets (WASM/WebGPU) the same way division
does: the per-agent shader/loop only WRITES a request; the serial CPU pass applies it.

### `spawnEvent` (event root, like `divisionEvent`/`agentInit`) — the per-spawned-agent init
Optional. Runs **once per newly-spawned agent** in the structural phase (after the alloc), the birth
analogue of `divisionEvent` (per-daughter) and `agentInit` (per-init-agent). Value outputs:
- `myX`, `myY`[, `myZ`], `myRadius` — the spawned agent's geometry (so the graph can set attributes
  as a function of where it was born).
- `parentX`, `parentY`[, `parentZ`], `parentHandle` — the SPAWNER's geometry + id (so offspring can
  reference the parent: inherit a mutated attribute, bond to the parent, etc.).
- `DO` flow chain → Set (Self) Attribute / Set Agent Attribute etc. retargeting the spawned agent
  (`ctx.agentRoot === 'spawn'`, the range guard relaxed to `< maxAgents` like `agentInit`, since a
  just-alloc'd slot's `alive` was set by the structural phase before the event runs).

If no `spawnEvent` root exists, the spawned agent simply keeps its inherited / default attributes.

---

## 2. Architecture — mirror `divideAgent` exactly (the low-risk path)

`divideAgent` is the proven precedent for a structural mutation authored in the behaviour graph and
applied in the post-step CPU structural phase, on **all three agent targets**. Spawn is *simpler*
(no eigensolve, no bond partition — just alloc + place + optional event). Reuse every piece:

| Concern | `divideAgent` (existing) | `spawnAgent` (new — same pattern) |
|---|---|---|
| Request fields (SoA) | `divideRequest`(u8) + `divideAxisX/Y/Z`(f64) + `divideAsym`(f64) | `spawnRequest`(u8) + `spawnX/Y/Z`(f64) + `spawnRadius`(f64) |
| JS emit | `_divideRequest[idx]=1; _divideAxisX[idx]=…` | `_spawnRequest[idx]=1; _spawnX[idx]=…` |
| WASM emit | request f64/u8 stores at the SoA offsets | same, at the new offsets |
| WebGPU emit | `AGENT_GPU_REQUEST_FIELDS` f32 stores + readback | append the spawn fields to `AGENT_GPU_REQUEST_FIELDS` |
| Structural phase | §1c: read request → `divideAgent()` → overflow reject → `runDivisionEvent()` | new §1d: read request → `allocAgentSlot`+`initAgentSlot` → overflow reject → `runSpawnEvent()` |
| Per-child event root | `divisionEvent` (`buildDivisionParams`↔`buildDivisionArgs`) | `spawnEvent` (`buildSpawnParams`↔`buildSpawnArgs`, cloned) |
| Overflow | `divideOverflow` → `agentOverflow` notice | `spawnOverflow` → `agentOverflow` notice |
| Capability | — | `AGENT_NODE_REQUIREMENT.spawnAgent = 'populationBirth'` (already present) |

Because the request buffers are written directly into the SoA by the emitted code (NOT passed as
loop params), the loop ABI (`buildAgentLoopParams`↔`buildAgentLoopArgs`↔harness `buildArgs`) is
UNCHANGED — only the SoA layout + the WASM/WebGPU request-field bases grow (the ABI-mirror discipline
applies to those layout sites, exactly as it did when the divide request fields were added).

---

## 3. SoA + layout changes (the ABI-mirror sites — change together)

- **`agentEngine.ts`**: add `spawnRequest` to `AGENT_U8_FIELDS`; `spawnX/spawnY/spawnRadius` to the
  f64 field list (+ `spawnZ` to the 3D-zero list, mirroring `divideAxisZ`); reset all in
  `initAgentSlot` + `freeAgentSlot` (a recycled slot must not inherit a stale spawn request);
  `divideAgent` inheritance already copies attrs — reuse the same inherit helper for spawn.
- **WASM layout** ([agentEngine.ts](../src/simulator/engine/agentEngine.ts) `computeAgentMemoryLayout`):
  append the spawn request region after the divide fields (existing offsets byte-stable → drift-test
  path unaffected).
- **WebGPU layout** ([agentWebgpu/layout.ts](../src/modeler/vpl/compiler/agentWebgpu/layout.ts)):
  append the spawn fields to `AGENT_GPU_REQUEST_FIELDS` (after `killRequest`), so the force-shader
  bases stay byte-identical (the same append-at-end discipline the divide fields used).
- **Structural request readback** (WebGPU runtime): the spawn fields ride the existing request-field
  readback (`readbackAgentStep` already copies the f32 request run into the CPU store) — just widen
  the copied set.

The footprint estimate is ALREADY correct (§0), so no `estimateAgentFootprint` change.

---

## 4. Structural-phase spawn processing (`runAgentStructuralPhase`, sim.worker.ts §1d)

Insert AFTER division (so a daughter can't also spawn the same step) and BEFORE auto-bond:
```
const spawnEvents = [];   // { child, parent, ... } for the spawnEvent root
let spawnOverflow = false;
const preHW = s.highWater;                       // iterate only the pre-spawn population
for (let i = 0; i < preHW; i++) {
  if (!alive[i] || !s.spawnRequest[i]) continue;
  s.spawnRequest[i] = 0;
  const child = allocAgentSlot(s);               // free-list first, else grow, else -1
  if (child < 0) { spawnOverflow = true; continue; }   // reject → notice, never a partial spawn
  initAgentSlot(s, child, s.spawnX[i], s.spawnY[i], is3d ? s.spawnZ[i] : 0, s.spawnRadius[i]);
  if (inheritAttributes) copyAgentAttrs(s, i, child);  // same helper divideAgent uses
  spawnEvents.push({ child, parent: i });
}
if (spawnOverflow) self.postMessage({ type:'agentOverflow', message: `… during spawn …` });
if (spawnEvents.length) runSpawnEvent(spawnEvents);
```
`runSpawnEvent` mirrors `runDivisionEvent`: build the per-child args, call the compiled `spawnEvent`
fn for each. Newly-spawned agents land beyond `preHW`, so they don't spawn again this step
(bounded — no runaway within a single step; the population still grows unboundedly across steps by
design, capped by `maxAgents`).

---

## 5. Spawn Event root compile (mirror `divisionEvent` + `agentInit`)

- `compileAgentGraph` gains a `spawnEvent` root → `spawnCode` (a single-agent fn, like `divisionCode`).
- `buildSpawnParams`↔`buildSpawnArgs` (clone of `buildDivisionParams`↔`buildDivisionArgs`, adding the
  `parent*` reads) — the THREE-mirror discipline (compile params / worker args / harness `buildArgs`).
- `spawnEvent` + `spawnAgent` join `MULTI_OUTPUT_TYPES` / `NEVER_INVARIANT` / `NEVER_PURE_TYPES` as
  `divisionEvent`/`divideAgent` do.
- The by-id setters relax their guard to `< maxAgents` when `ctx.agentRoot === 'spawn'` (as
  `agentInit` does), since the child slot is freshly alloc'd.
- WASM/WebGPU: `spawnEvent` is a **CPU-on-JS root** (like `divisionEvent`/`agentInit` — runs over the
  same wasmBacked memory, bit-exact), so it is NOT in the behaviour-reachable gate set → a graph with
  a Spawn Event still runs its BEHAVIOUR on WASM/WebGPU. Only the `spawnAgent` REQUEST write needs the
  WASM/WebGPU emitter (a handful of stores — trivial, mirrors `divideAgent`).

---

## 6. Capability gating (already wired — just flip it on)

- Remove `populationBirth` from `HIDDEN_CAP_ROWS_V1` (its two nodes now exist).
- `AGENT_NODE_REQUIREMENT.spawnAgent`/`spawnEvent = 'populationBirth'` is ALREADY present → the
  palette gate (`isNodeAvailable`) + the badge (`detectCapabilityRequirements`) + the closure
  (`applyCapabilityEdit`: Population·Birth ⇒ Motion, already in `computeCapabilityClosure`) all work
  for free.
- `estimateAgentFootprint` already counts the spawn bytes.

---

## 7. Design decisions (resolve before coding)

1. **One spawn per agent per step (v1)** — a single `spawnRequest` flag per agent, like `divideRequest`.
   A `count` port (N spawns) is a v2 follow-on (needs a small per-agent request queue; not worth the
   complexity for v1 — a Loop in the behaviour can't spawn N since the request is one-flag; document
   the limit + badge). **Recommend: one-per-step v1.**
2. **Attribute inheritance default = parent's values (`inheritAttributes: true`)** — matches
   `divideAgent` daughters + is the useful default (offspring resemble the parent); the Spawn Event
   can override. **Recommend: inherit-by-default.**
3. **Spawn Event optional** — if absent, the child keeps inherited/default attrs (no error). The
   `parentHandle` output lets offspring reference the spawner. **Recommend: ship both nodes; the event
   is optional.**
4. **Sprites** — a spawned agent inherits the parent's sprite id/frame/speed via the inherit copy
   (like `divideAgent`'s daughter-B inherit) — free, no extra work.

---

## 8. Verification bar (ALL required — same rigor as the vector-v2 pass)

1. `compileAll` / the agent gates: a Spawn model compiles on JS + the WASM/WebGPU **behaviour** gates
   (`isAgentGraphWasmSupported`/`…WebGPUSupported`) return true (spawnAgent's request write is in the
   allowlist; spawnEvent is a CPU root, not gate-checked).
2. **Real worker run, all agent targets**: a behaviour rule "spawn a child at my position + radius/2
   when age > K" grows the population; `getAgentState`/the snapshot confirms children exist at the
   right positions with inherited attrs; a Spawn Event that sets a child attr is observed. Overflow
   at `maxAgents` surfaces the notice + never corrupts (free-list intact).
3. **JS↔WASM bit-parity** ([scripts/parity-agent-wasm.mjs](../scripts/parity-agent-wasm.mjs)): add a
   synthetic spawn model; the 8 shipped samples + the new one stay 0-mismatch (the request write is
   f64/exact; the structural alloc is target-independent CPU).
4. `check-agent-wasm-gate.mjs` all ✓; `tsc -p tsconfig.app.json --noEmit` + `npm run build` clean.
5. **Docs**: CLAUDE.md (a Spawn subsection under Agent Capability Profiles / the agent platform),
   HelpView, README, NODES_REFERENCE (node count +2, the two rows), the memory
   `project_agent_capability_profiles.md`.

---

## 9. File touch-list (estimate)

- New: `src/modeler/vpl/nodes/SpawnAgentNode.ts`, `SpawnEventNode.ts` + registry.
- `agentEngine.ts` (SoA fields + reset + `computeAgentMemoryLayout` + `copyAgentAttrs` reuse).
- `sim.worker.ts` (`runAgentStructuralPhase` §1d + `runSpawnEvent` + `buildSpawnArgs`).
- `compile.ts` (`compileAgentGraph` spawn root + `buildSpawnParams` + the guard relax + the lists).
- `agentWasm/compile.ts` + `agentWebgpu/{compile,layout}.ts` (the `spawnAgent` request-store emitter +
  the request-field append).
- `agentWebgpuRuntime.ts` (widen the request readback).
- `agentCapabilities.ts` (drop `populationBirth` from `HIDDEN_CAP_ROWS_V1`).
- `scripts/parity-agent-wasm.mjs` (+ synthetic spawn model), NODES_REFERENCE / HelpView / README / CLAUDE.md / memory.

**Risk:** medium — it mirrors `divideAgent` closely (the hardest parts, the parallel-target request
plumbing + the CPU structural phase + the per-child event root, all already exist and are verified),
so the main work is careful replication + the three-mirror ABI for the new `spawnEvent` root. The
one genuinely new decision is the `parent*` outputs on the Spawn Event (division has only daughter
geometry; spawn wants the parent too).
