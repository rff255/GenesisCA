# MASTER HANDOFF — Graph-Rewriting Automata on the Bond-Graph Agent tier

**Audience**: the ORCHESTRATOR session (coordinates everything) and each PHASE
session (a fresh session executing exactly one phase). This file is the single
source of truth for sequence, protocol, and status.

**Mission**: make GenesisCA a place to *study* Graph-Rewriting Automata — automata
whose graph is rewritten by local rules — with an authoring surface that is a
**table and a handful of verbs**, never a gluing morphism. Along the way, deliver
the long-recorded **bond attributes** capability.

**Design authority**: [IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md)
+ [PLAN_GRAPH_REWRITING_AGENTS.md](PLAN_GRAPH_REWRITING_AGENTS.md) (+ `.html` mockup).
**Background**: [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md) (the *other*
substrate — static graph CA on the lattice; its Phase 6 is what this milestone
supersedes), [HANDOFF_AGENTS_FLOATING_CELLS.md](HANDOFF_AGENTS_FLOATING_CELLS.md)
(the agent tier's own runbook).

---

## 0. Invariants — EVERY phase session obeys these (no exceptions)

1. **Git**: work on the branch the orchestrator names, linear history, one commit
   per milestone with a descriptive message. **NEVER push. NEVER add Co-Authored-By
   or any Claude attribution. NEVER bump the version.** PowerShell 5.1 gotcha: no
   double-quote characters inside `git commit -m @'…'@` here-strings; keep messages
   quote-free.
2. **Scope discipline**: implement YOUR phase only. **If an assumption in your
   handoff proves false, STOP**, write what you found in your phase doc's Completion
   Report, and end — the orchestrator re-plans. Do not redesign, do not "just also
   fix" the next phase.
3. **All-target delivery**: a phase either lands JS + WASM + WebGPU for its agent
   nodes, or it uses the **existing capability gate** to reject cleanly with a stated
   user-visible reason (the PR6b-1/2/3 precedent). **Never add a node type to a silent
   JS clamp.** If you feel tempted, that is the signal to STOP per rule 2.
4. **First principles**: no gate, emitter, or fast path may test for a specific
   model or rule shape — only general properties (`topologyMode`, resolved agent
   target, capability profile, usage flags, dims).
5. **The graph invariants are the contract** (Impact Map §5). I1 (handshake lemma)
   and I2 (bond symmetry) must hold after every generation in every phase from P2
   onward. If your change can break them, it needs a test in
   `scripts/verify-graph-rewrite.mjs` *with a negative control*.
6. **Verification gates before any commit** (run all that apply):
   - `npx tsc -p tsconfig.app.json --noEmit` and `npm run build`
   - `node scripts/parity-agent-wasm.mjs` — JS↔WASM **bit-parity**, all entries.
     A phase that adds agent nodes adds a **permanent synthetic** here.
   - `node scripts/check-agent-wasm-gate.mjs` — every sample GATE✓ COMPILE✓ INST✓
   - `node scripts/audit-agent-layout.mjs` + `node scripts/test-agent-abi.mjs` —
     mandatory for **any** phase touching the store layout or the ABI descriptor
   - `node scripts/parity-agent-force.mjs` if the force pass is touched
   - `node scripts/check-compile-identity.mjs` — baseline discipline (capture on the
     pre-change commit via `git stash`, compare after; **only justified diffs**)
   - `node scripts/verify-graph-rewrite.mjs` — the invariant oracles (created in P1)
   - **REAL in-browser verification is mandatory** (project rule: never conclude
     "works" from module-level calls alone). Recipes in §3.
7. **Docs consistency in the same commit**: CLAUDE.md (the feature's section),
   `src/help/HelpView.tsx` where user-visible, README if warranted,
   `docs/NODES_REFERENCE.md` for node-catalogue changes (table row + counts +
   Mermaid), AND this master's Status Board + your phase doc's Completion Report.
   **A phase without its Completion Report is NOT done.**
8. **Known traps** (all previously hit in this codebase — do not rediscover them):
   - `sim.worker.ts` contains mojibake comment bytes — anchor `Edit` old_strings on
     clean ASCII **code** lines, never comment lines.
   - **Baked-offset lockstep**: the agent store's layout and the compiler's layout
     must derive from the SAME inputs. A mismatch does not crash — it silently reads
     the wrong memory (the documented "+64-cell corruption" class).
   - **Compaction lockstep**: there are **THREE** swap-with-last sites, not two —
     `removeBondSlot` (used by Break Bond AND death via `breakAllBonds`) and
     **`sweepStaleBonds`**, which carries its own copy (P2 finding; the Impact Map
     §3.5 names only the first two). Since P2 they ALL call the field-list-driven
     `moveBondSlot`, so a new ragged bond field goes in `store.bondSlotArrays` and
     nowhere else. A field missed by any of them corrupts silently on the first bond
     removal. Invariant **I2** + the compaction audit are the tests — write them first.
   - Any new async batch loop in the worker MUST set/clear `asyncStepBatchInFlight`
     from a `finally` — a throw with the flag set dead-locks the worker silently.
   - Naga **strips an unused WGSL storage global** ⇒ the bind group mismatches the
     pipeline layout. Every conditional binding needs its `uses*` flag.
   - Never size a per-thread WGSL array by `maxAgents` (private-memory zero-init
     collapse — the `AGENT_GPU_ARRAY_CAP` pattern).
   - WGSL constant-folds non-representable f32 literals at `createShaderModule`
     (a NaN bitcast fails) — sentinels must be real f32s.
   - **The agent store arrays are f64**; `getState.agents.{x,y,vx,vy,radius,…}` ships
     **Float64** buffers. Read them with `new Float64Array(buf)` — only the render
     snapshot (`stepped`'s `agents`) is f32. Dump `byteLength / hw` (8 ⇒ f64) before
     ever concluding corruption.
   - Adding a node type requires edits in **five** places or it half-works: the def,
     the registry, `AGENT_*_SUPPORTED_TYPES` (×2), `nodeValidation.detectMissingConfig`,
     and — for array producers / per-iteration values — `AGENT_VALUE_NO_HOIST` and the
     scratch-slot budget. The parity harness is what catches the misses.
   - The Browser pane may report hidden ⇒ the sim auto-pauses Play; drive the worker
     directly (`window.__simWorker.postMessage({type:'step', count:N})`) and verify
     via worker messages / `getState` / DOM probes, not screenshots.
   - Branch scope: diff against **`origin/master`**, never the local `master` ref
     (it is stale in this repo).

---

## 1. Phase sequence + dependency graph

```
P1 Census + Rule-Table macro + Life-on-Bonds     ← DONE
  └→ P2 Bond attributes: schema/store/CPU ABI/JS+WASM   ← DONE
       └→ PX WebGPU sync agent attributes (double-buffer) ← DONE
            └→ P3 Bond attributes: WebGPU                [refine after P2+PX]
P4 Structural request QUEUE + Rewire verb        ← independent of P2/P3  [refine first]
  └→ P5 Combinatorial division (per-bond assignment)     [refine after P4]
P6 Graph indicators + Overseer sweep             ← independent           [refine first]
P7 Samples (Cubic GRA, SDCA) + docs sweep        ← needs P4, P5, P6      [refine last]
P8 Visual motif editor                           [STRETCH — not scheduled]
```

**Launch order**: P1 → P2 → **PX** → P3 → P4 → P5 → P6 → P7.

**Why PX was inserted (orchestrator decision, 2026-07-30).** P1 found that
`agentUpdateMode: 'sync'` is not honoured on the WebGPU agent target — the behaviour
shader reads neighbours' attributes from the same `agentF32` region it writes, with
no double buffer, so a sync model races. Measured: the SHIPPED, census-free
`Game of Life on Agents` is wrong by 18/1024 cells on its own WebGPU target (0 on
JS/WASM). It is **pre-existing and not caused by P1**, but it is in scope for this
milestone for three reasons: (1) **GRA rules are canonically synchronous**, so the
milestone's own flagship samples would be silently wrong on WebGPU; (2) it blocks
`Life on Bonds` from following the library's WebGPU-where-gated-in policy; (3) P3
must decide whether GPU **bond** attributes need the same double buffer, and it
should inherit a settled pattern rather than invent one that PX then changes.
Sequenced **before** P3 for reason (3).

"[refine first]" = the orchestrator expands that phase's handoff **immediately
before launching it**, using what the preceding phases actually found. Do not
pre-write speculative handoffs — the P2/P3 layout findings will change P4/P5's text.

**Parallelism**: P4 is file-disjoint from P2/P3 *in principle* (worker + request
buffers vs. store + layouts) but both touch `agentEngine.ts`. Serialise unless
throughput genuinely demands otherwise.

---

## 2. Status board

The orchestrator updates this after reading each phase's Completion Report.

| Phase | Handoff doc | State | Session | Commit | Notes |
|---|---|---|---|---|---|
| P1 Census + Rule Table | [HANDOFF_GRA_P1_CENSUS.md](HANDOFF_GRA_P1_CENSUS.md) | **DONE** | 2026-07-30 | `2a8fb42` + `502ae8d` | Census + lowering on all 3 targets, `Life on Bonds`, GRA Rule Table macro, `verify-graph-rewrite.mjs` (58 checks). O7/O11/O3 + I1/I3/I4 green. **Two things to read**: (a) a pre-existing operand-port defect in BOTH agent `groupCounting`/`groupStatement` emitters was P1-blocking and is fixed in its own commit `2a8fb42`; (b) **`agentUpdateMode: 'sync'` is NOT honoured on the WebGPU agent target** — a pre-existing race that makes the SHIPPED census-free GoL-on-Agents wrong by 18/1024 cells there. **Decide before P3.** |
| P2 Bond attrs (CPU) | [HANDOFF_GRA_P2_BOND_ATTRIBUTES.md](HANDOFF_GRA_P2_BOND_ATTRIBUTES.md) | **DONE** | 2026-07-30 | `a4eb632` | `CAModel.bondAttributes` (bool/int/float/tag), ragged store, `_bondAttr_`/`_bondFormAttr_` ABI, Get/Set Bond Attribute + Form Bond initial values, panel + inspector, JS+WASM bit-parity. I1–I4 green, 500-gen compaction audit negative-controlled at the ENGINE level, 26 models byte-identical. **Three things to read**: (a) **a THIRD compaction path** (`sweepStaleBonds`) exists that the Impact Map's enumeration missed — handled by the mandated field-list-driven helper, but §3.5's prose needs correcting; (b) the ABI **`gate(profile)` hook is still unused and should NOT be made live** — no caller passes a profile; the SHAPE is the gate; (c) the WebGPU gate rejects at MODEL level (`bondAttrsOf(model).length > 0`), so P3 must lift that term, not just add node types. |
| PX WebGPU sync agent attrs | [HANDOFF_GRA_PX_WEBGPU_SYNC_ATTRS.md](HANDOFF_GRA_PX_WEBGPU_SYNC_ATTRS.md) | **DONE** | 2026-07-30 | `9b45b1e` | The §3.1 design shipped: a second per-attribute run (`agentAttrWriteBase`, **aliased when async** ⇒ every async shader byte-identical) + a per-generation **commit compute pass** (`copyBufferToBuffer` on one buffer is a validation error — the L1 `posCommit` precedent). Reproduced first (**123/56/32/32 of 1024 wrong, varying run to run**; JS/WASM 0) → **0/0/0** after, alive count landing on the exact JS/WASM value; exact over 50/20/100 gens across 3 seeds. **`Life on Bonds` flipped to `webgpu`** and its **O7 differential passes ON THE GPU** (0/1024). `check-compile-identity`: 26 models, exactly 2 diffs, both the SYNC models' `agent.webgpu.shader`. New **Tier E** in `verify-graph-rewrite` (106 checks) with 2 negative controls. **All three §5 assumptions held.** |
| P3 Bond attrs (WebGPU) | *(refine after P2+PX)* | BLOCKED | — | — | needs P2's layout decisions + D3. **PX settled the pattern to inherit**: `bondAttrWriteBase` alongside `bondAttrBase` (aliased when async) + ONE `bondAttrAt(…, 'read'\|'write')` accessor + the commit folded into the existing `attrCommit` pass if the regions are laid out contiguously. NB bond attributes are SYMMETRIC (one value, two slots), so a Set writes two rows — under sync both go to the write region and the partner still reads the previous generation, which is correct. P2 left it a **model-level** gate term (`bondAttrsOf(model).length > 0` at the top of `isAgentGraphWebGPUSupported`) + a Properties hint arm keyed on `model.bondAttributes?.length` — both must be lifted together |
| P4 Request queue + Rewire | *(refine first)* | PLANNED | — | — | the atomicity unblock; enables O5/O6 |
| P5 Division partition | *(refine after P4)* | PLANNED | — | — | needs P4 queue + P2 attrs |
| P6 Graph indicators | *(refine first)* | PLANNED | — | — | feeds the Overseer sweep |
| P7 Samples + docs | *(refine last)* | PLANNED | — | — | Cubic GRA + SDCA |
| P8 Motif editor | — | NOT SCHEDULED | — | — | separate decision (D8) |

**States**: READY (fully specified, launchable) · BLOCKED (needs a predecessor's
findings) · PLANNED (specified in the plan, handoff not yet written) · IN PROGRESS ·
DONE (Completion Report written + verified) · REPLANNED (assumption failed).

---

## 3. Verification recipes

### 3.1 The invariant harness — `scripts/verify-graph-rewrite.mjs`
**Created in P1, extended by every later phase.** Reusable checkers over a `getState`
agent payload:

```
checkHandshake(state)        → I1 : Σ bondCount == 2 × |distinct bonds|
checkBondSymmetry(state)     → I2 : both slots agree on every field (P2+)
checkNoDangling(state)       → I3 : partners in range, alive, != self
checkCapacity(state, maxB)   → I4 : bondCount <= maxBonds
checkDegreeRegular(state, d) → I6 : min==max==d and E == d·N/2
```

**Every invariant needs a negative-control mutation** proving it fails when broken
(the project's harness rule — a harness that only ever passes is worthless). Follow
`scripts/verify-agent-render.mjs`'s tier structure.

### 3.2 Driving the real worker from the browser
The Browser pane may report hidden ⇒ Play auto-pauses. Drive it directly:

```js
// step N generations, then read the graph back
window.__simWorker.postMessage({ type: 'step', count: 50 });
window.__simWorker.postMessage({ type: 'getState' });   // listen for the reply
```

Bonds ride the `stepped` snapshot (flat pairs) and `getState` (the full ragged
store). `getAgentState {id}` returns one agent's live bond list — the cheapest probe
for I2/I3 spot checks.

### 3.3 Cross-target agreement
- **JS ↔ WASM**: **bit-identical** (both f64, both sequential). Any divergence is a
  bug — use `scripts/parity-agent-wasm.mjs`, and add a permanent synthetic for your
  phase's nodes.
- **WebGPU**: **statistical**, not bit-identical (f32 + per-agent PCG — the
  documented stance). But the **structural invariants I1–I4 hold exactly** on every
  target. That is the WebGPU acceptance criterion: not "same numbers", but
  "same invariants + same qualitative outcome".

### 3.4 Byte-identity discipline
Any compiler-touching phase captures a `check-compile-identity` baseline on the
pre-change commit (`git stash`), then compares. A lowering pass (P1's census) must be
a **hot-path no-op** when the feature is unused ⇒ every shipped model unchanged.

---

## 4. Phase-session boot prompt (template)

The orchestrator pastes this, filling `{{…}}`:

```
You are implementing exactly ONE phase of the Graph-Rewriting Automata milestone.

1. Read docs/HANDOFF_GRAPH_REWRITING_AGENTS.md §0 (invariants), §1 (sequence),
   §3 (verification recipes). Obey §0 without exception.
2. Read your phase doc: {{PHASE_DOC}}. That is your scope. Nothing else.
3. Read docs/IMPACT_MAP_GRAPH_REWRITING_AGENTS.md §3 (capability audit) and §5
   (the invariants) for context on WHY.
4. Branch: {{BRANCH}}. Do not push. Do not bump the version. No Claude attribution
   in commits.
5. If any assumption in your phase doc proves FALSE: STOP, write the finding in
   your phase doc's Completion Report, and end your session. Do not redesign.
6. Before committing, run every applicable gate in §0.6 and record the results.
7. Finish by writing the Completion Report in your phase doc AND updating the
   Status Board row in the master handoff.
```

---

## 5. Completion Report template

Every phase doc ends with this, filled in. The orchestrator reads **only** this to
decide whether to continue or re-plan.

```markdown
## Completion Report — P{{n}}

**State**: DONE | REPLANNED (assumption failed)
**Commit(s)**: {{sha — subject}}
**Files touched**: {{git diff --stat}}

### What shipped
- …

### Decisions resolved
| ID | Decision taken | Why |
|---|---|---|

### Assumptions that proved FALSE
(the orchestrator re-plans from this section — be specific and cite the code)
- …

### Verification
| Gate | Result |
|---|---|
| tsc / build | |
| parity-agent-wasm | |
| check-agent-wasm-gate | |
| audit-agent-layout / test-agent-abi | |
| check-compile-identity | |
| verify-graph-rewrite (which oracles) | |
| Real in-browser run (what was observed) | |

### Invariants
| ID | Held? | Evidence |
|---|---|---|
| I1 handshake | | |
| I2 symmetry | | |
| I3 no dangling | | |
| I4 capacity | | |
| I5 atomicity | | |

### Known gaps / follow-ups for the next phase
- …
```

---

## 6. Orchestrator decision rules

After each Completion Report:

1. **Any "assumption proved FALSE" entry** ⇒ re-plan that phase's successors before
   launching them. The most likely candidates are the WebGPU `bondStore` write
   decision (D3) and the queue-depth semantics (D5).
2. **Any invariant not held** ⇒ do NOT advance. Either the phase is incomplete or an
   invariant is wrong; both need a decision, not a next session.
3. **`check-compile-identity` diffs on models that should be untouched** ⇒ the change
   is not as additive as claimed. Investigate before advancing.
4. **A phase that used a silent JS clamp** ⇒ reject; rule §0.3 exists precisely
   because that shortcut is how a target silently rots.
5. **Refine the next phase's handoff** from what this one found, then launch.
