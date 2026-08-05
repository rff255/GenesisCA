# Agent brush: drop `Bond`, add `Push` / `Pull`

**Branch** `updates` · illustrated mockup: [PLAN_AGENT_PUSH_PULL_BRUSH.html](PLAN_AGENT_PUSH_PULL_BRUSH.html)

## 1. Why

The agent brush's **Bond** mode (drag a disc, auto-glue every pair inside it that is
already close enough to touch) turned out to have almost no applications: it only ever
did something on a bonded model, it needed the agents to *already* be within
`formDistance × contact`, and Glue (click two agents) covers the deliberate case. It is
removed.

In its place, two modes that work on **every** agent model and give the user a *physical*
way to interact with a running population — the counterpart to **Move**, which is
absolute and translates a whole footprint rigidly:

| | Move | Push / Pull |
|---|---|---|
| geometry | any shape footprint, rigid translation | radial disc / ball around the cursor |
| magnitude | the drag delta, identical for every agent | ∝ **closeness to the centre** (0 at the rim) |
| feel | "pick this clump up and put it there" | "shove things out of the way" / "gather them in" |

## 2. The law

For every live agent within `radius` of the brush centre, with `d` the torus-shortest
distance to the centre:

```
falloff = 1 − d / radius            (1 at the centre, 0 at the rim, linear)
step    = intensity · dt · falloff  (world units this tick)
push:  x += step · (x̂ outward)
pull:  x −= min(step, d) · (x̂ outward)      ← never overshoots past the centre
```

Then wrap (torus) / clamp (bounded) exactly like the Move brush.

**Decisions, and why:**

- **`Intensity` is in world units per second at the centre**, and the caller
  pre-multiplies by the frame `dt` (clamped to 100 ms). Without the `dt` a 144 Hz display
  would push 2.4× faster than a 60 Hz one for the same setting.
- **Position only — no velocity kick.** A kick would feel more like a force, but it
  accumulates: at momentum 0.9 a sustained hold converges to ~10× the per-frame step, and
  at momentum 1.0 (Particle Life) it depends entirely on the model's *own* graph-side
  friction to stay bounded. A position displacement is well defined for every Motion mode
  (`static` / `velocity` / `force`), every momentum value and every compile target, and it
  is exactly what the request asks for ("move agents away or towards the center"). Agents
  with momentum simply resume their own trajectory from the new position — the same
  contract Move already has.
- **The write is `x` AND `xNext`** — the documented `moveAgents` discipline. Writing only
  `x` lets the next integration's position commit snap the agent back.
- **A radial force needs a centre and a radius, so push/pull ignore the brush SHAPE** and
  use a plain disc (2D) / ball (3D) of `agentBrushRadius` — the same field Bond used, so
  the panel gains only one genuinely new control (`Intensity`). Ctrl+LMB-drag resizes that
  radius in these modes regardless of which shape is selected.
- **An agent exactly at the centre** has no outward direction. Push gives it a
  deterministic golden-angle direction derived from its id (so a pile at the cursor still
  explodes outward, reproducibly); pull leaves it alone (`min(step, d) = 0`).

## 3. Where it runs

A new worker message — **`nudgeAgents { x, y, z?, radius, strength, torus, activeViewer }`**
(`strength` signed: `+` outward = push, `−` inward = pull) — applied to the CPU agent
store, exactly like `moveAgents`. So:

- **every agent target works by construction** (JS / WASM / WebGPU): the store is the CPU
  mirror all three share, and the message joins `AGENT_GPU_DEFER_TYPES`, which both defers
  it during an in-flight GPU step readback *and* sets `agentGpuUploadPending`, so the
  resident batch re-uploads the nudged positions on its next submit;
- **2D and 3D are ONE handler** — `z` is only read when `worldDepth > 1`, and the 3D brush
  simply passes the plane-picked cell (the agent world *is* the grid frame 1:1).

**Continuous while held**: an rAF loop (shared by the 2D and 3D pointer handlers) posts at
most one message per frame from the last cursor position, so holding still keeps pushing
and the worker never sees a per-`pointermove` flood.

## 4. Visuals

- Cursor (negative silhouette layer): the effect ring — **solid for Push, dashed for
  Pull** — plus 8 radial ticks with a chevron at the leading end, pointing **outward**
  (push) or **inward** (pull).
- Affected agents (highlight layer): every agent inside the disc gets a ring —
  **amber for Push, teal for Pull** — reusing the Remove/Move/Edit area-highlight path.
- 3D: the volumetric ball outline + the same per-agent rings the other area modes use.

The highlight (not the effect) reads the CPU snapshot, so `push`/`pull` join
`AGENT_BRUSH_MODES_NEEDING_STATE`; the 3 s idle backstop caps that cost.

## 5. What is removed

`AGENT_BRUSH_MODES` / `AgentBrushMode` / `BOND_BRUSH_MODES` lose `bond`;
`scanBondPairsAt`, `scanBondPairs3d`, `flushBondBatch`, `pendingBondPairs`, the
`'agentBond'` drag state, the bond scan-ring cursor and the Bond radius field all go.
Nothing else posted **`formBondBatch`**, so its worker handler, its message interface,
its `WorkerMsg` union member and its `AGENT_GPU_DEFER_TYPES` entry are removed too
(Glue/Cut post single `formBond`/`breakBond`, which stay).

`agentsInRadiusAt` / `agentsInRadius3dAt` are **kept** — they were Bond's scan collectors
and are now Push/Pull's effect-region collectors for the highlight.

Glue and Cut keep their `resolveMaxBonds === 0` gating (they are still structurally inert
without a bond store); Push/Pull are ungated.
