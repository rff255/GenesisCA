# Plan — Unified agent spawning: Create Agent + Add To World work in BOTH graphs

**Branch:** `absorb_old_automatosgt` · **Supersedes** the reverted request-based Spawn Agent / Spawn
Event (commit `747f68c`, reverted in `c3ff7ca`). **Do NOT push / bump version / add Co-Authored-By.**

Illustrated mockup: [PLAN_UNIFIED_AGENT_SPAWN.html](PLAN_UNIFIED_AGENT_SPAWN.html).

---

## 0. Why (the user's ask)

The request-based **Spawn Agent + Spawn Event** introduced a **dichotomy**: in the Init Event you
build an agent with **Create Agent → set-by-handle → Add To World** (full, direct control over the
new instance); mid-run you had to flag a request and configure the child in a *separate* Spawn Event
root. That's redundant and cryptic — the classic case that exposes it is **"a bird agent lays an egg
agent"**: the bird should just *make the egg and fill it in*, not request one and configure it
elsewhere.

**The fix (user-directed): one idiom.** Just as **Set Attribute works identically in the Init Event
and the Generation Step**, **Create Agent + Add Agent To World work identically in the Agent Init
Event and the Behaviour Step**. Retire Spawn Agent + Spawn Event (done — reverted; nothing shipped
used them).

The bird then does exactly what you'd expect, in the Behaviour graph:
```
Create Agent (x = myX, y = myY-1, radius = 0.3) → handle
Set Agent Attribute (handle, species = Egg)
Set Agent Attribute (handle, energy  = 10)
Add Agent To World (handle)
```

---

## 1. The one semantic decision: a newborn behaves NEXT step

A mid-step Create allocates a slot **beyond the current behaviour-loop bound** (`highWater` is the
loop bound captured at loop start; Create bumps the store's highWater, which the fixed loop bound
does not see). So the new agent:
- is fully formed + configured **this** step (the parent sets its attributes immediately via the handle),
- but **does not run its own behaviour until the next** step (a newborn isn't born already running).

This matches the Init Event (an agent created in Init behaves from step 1) and is the intuitive,
race-free default. Overflow (past `maxAgents`) → Create returns **handle `-1`**, and the downstream
Set/Add no-op — identical to how Create already handles overflow in Init.

---

## 2. Why it's feasible on all three agent targets (the parallelism question, honestly)

The earlier "you can't allocate in a parallel loop" concern only applies to WebGPU. The JS and WASM
behaviour loops run **sequentially** (one agent per iteration), so they use the *same* allocation the
Init Event already uses.

| Target | Behaviour-loop execution | Create Agent |
|---|---|---|
| **JS** | sequential `for idx<highWater` | the **same** `_agentCreate`/`_agentAddToWorld` host closures Init uses, threaded into the behaviour loop ABI. Grow-only alloc. Trivial. |
| **WASM** | sequential loop in one module call | `env.agentCreate(x,y,z,r)->i32` + `env.agentAddToWorld(id)` **host imports** callable from the behaviour module (writes the new slot in the shared wasmBacked memory). Moderate. |
| **WebGPU** | **parallel** compute shader | an **atomic bump allocator**: `let h = atomicAdd(&control.spawnCursor, 1u);` reserves a unique slot; the shader writes the child's geometry/attrs to it; the CPU reconciles (marks `[highWater, cursor)` alive, updates liveCount) after the readback. Overflow when `cursor >= maxAgents`. The real work. |

**Grow-only alloc (all targets, consistent):** behaviour-time Create appends at `highWater` (never
reuses a free-list hole *mid-loop*, which could sit ahead of the loop cursor and get double-processed
this step). Freed slots (from Kill Agent) are reclaimed by Division (post-loop, safe) + a trailing-
dead-slot trim + Reset. **v1 caveat:** a model that continuously Kills middle agents AND Creates,
with no Division, grows `highWater` over time (holes reclaimed only at Reset) — documented; a
future born-flag + free-list reuse removes it. This matches the WebGPU atomic-grow behaviour, so all
three targets are consistent.

---

## 3. Implementation

### Loop ABI (`agentAbi.ts`)
- Add `_agentCreate` (fn), `_agentAddToWorld` (fn), `_agentMaxAgents` (scalar) to the **`'loop'`**
  kind — the SAME three fields the `'init'` kind already leads with (just non-leading in the loop).
  The worker's `buildAgentLoopArgs` (derives from the descriptor) + the parity harness + the DEV
  arity assert pick them up automatically. `test-agent-abi.mjs` reference updated.

### JS (`compile.ts` + `sim.worker.ts`)
- `createAgent`/`addAgentToWorld` already compile to `_agentCreate(...)` / `_agentAddToWorld(h)` at
  their flow position (the existing Init special-case is root-agnostic) — nothing to change in the
  emit; they now resolve against the loop-ABI closures under the behaviour root.
- Worker `runAgentStep`: before the behaviour fn, build **grow-only** `agentCreate` (bump highWater,
  `initAgentSlot`, stage `alive=0`, record in a `created` list) + `agentAddToWorld` (commit only
  created ids). After the behaviour, **leak-sweep** trailing staged-not-added slots.
- **By-id setter guard:** `Set Agent Attribute` / `Set Agent Position` / `Set Agent Radius` on a
  freshly-Created (staged, `alive=0`) handle must land. Extend the existing `agentRoot === 'init'`
  guard-relax (to `< _agentMaxAgents`) to the **behaviour** root too — writing to a dead/staged slot
  is observationally harmless (dead slots aren't read/rendered), and this is what lets set-by-handle
  work mid-step exactly as in Init. `getNearbyAgents` only returns live agents, so real neighbour
  writes are unaffected.

### WASM (`agentWasm/compile.ts`)
- Add `createAgent`/`addAgentToWorld` to `AGENT_WASM_SUPPORTED_TYPES` with emitters that call two new
  `env.agentCreate` / `env.agentAddToWorld` imports (after the existing math imports; `*_FUNC_IDX`
  bookkeeping). The imports (JS closures the worker supplies at instantiate) do the grow-only alloc
  over the shared memory.

### WebGPU (`agentWebgpu/*` + `agentWebgpuRuntime.ts`)
- Add a `spawnCursor` atomic<u32> to the Control buffer, init to `highWater` each dispatch.
- `createAgent` emits `atomicAdd`, writes x/xNext/y/yNext/radius (and a `committed` flag on Add) to
  the reserved slot; `addAgentToWorld` sets the committed flag. `setAgentAttribute`/position/radius
  by handle already write agent SoA by id.
- Runtime: after the dispatch, read `spawnCursor` + the committed flags; for each committed new slot
  mark it alive + read its attrs/position back into the CPU store; bump `highWater`/`liveCount`.
  Overflow when `cursor > maxAgents`.

### Capability (`agentCapabilities.ts`)
- **Decision:** keep `populationBirth` **un-hidden** and let it gate the **behaviour-context**
  availability of Create/Add (they stay **always** available in the Init Event — that's the core
  init-spawn path). So a Particle model that never spawns mid-run doesn't show mid-run spawning, and
  ticking Population·Birth is what unlocks Create/Add inside the Behaviour graph. (If this proves
  awkward in `isNodeAvailable`'s per-graph check, fall back to: Create/Add always available, retire
  `populationBirth` — but the capability is the honest-core choice.)

---

## 4. Verification bar (all required)

1. **Real-worker bird/egg on JS + WASM + WebGPU:** a bird whose behaviour Creates an egg at
   `myX/myY-1`, sets the egg's `species=Egg` + `energy=10` by the handle, and Adds it → the egg
   exists next step at the right position with the right attributes; the bird keeps its own. The
   newborn does NOT run its behaviour the step it's born.
2. **Overflow:** past `maxAgents`, Create returns -1, the Set/Add no-op, no corruption.
3. **JS↔WASM parity** (a synthetic Create-in-behaviour model) + all 8 samples unregressed;
   `test-agent-abi` (loop kind now carries the 3 closures) + `audit-agent-layout` + the WASM gate pass.
4. `tsc -p tsconfig.app.json --noEmit` + `npm run build` clean.
5. **Docs:** CLAUDE.md (replace the STEP 5a spawn section), HelpView (the spawning section — one
   idiom now), README, NODES_REFERENCE (no new nodes — Create/Add just work in both graphs), memory.

---

## 5. Non-goals / v1 limitations (documented)
- **One idiom, two-phase kept** (Create → configure → Add) — consistent with Init; a Create not
  followed by Add is swept (leak-free for the common sequential case).
- **Grow-only bloat under kill+create churn without Division** (§2) — reclaimed at Reset; a future
  born-flag + free-list reuse removes it.
- Newborns behave next step (not the step they're created) — the intuitive default.
