# Follow Mode camera controller — why the shipped one trails, and the standard fix

*2026-07-29 — branch `improvements`. Companion to the "FOLLOW MODE" section of CLAUDE.md.*

## 1. The reported problem

Follow mode keeps the followed agent **at the edge of the deadzone** instead of near the
centre whenever the agent moves at a roughly constant velocity. The user asked for
"some sort of acceleration-based following — something simple — that picks up and
catches up", and whether there is a **common standard solution** to this class of problem.

There is, and the shipped controller is a textbook instance of the failure mode.

## 2. Why the shipped controller has a permanent offset

The shipped law is a **deadzone plus a first-order exponential ease toward the deadzone
EDGE** (`SimulatorView.tsx`):

```
e     = agent − camera                      (torus-folded)
if |e| ≤ dz: do nothing                     (the allowance)
pull  = (|e| − dz·AIM) / |e| · (1 − e^(−k·dt))
cam  += e · pull                            k = 5 /s, dz = 15 % of min(canvas w,h), AIM = 0.9
```

Continuously this is `ẋ_cam = k·(|e| − dz·AIM)` along the error direction — a **first-order
lag whose set-point is the deadzone boundary, not the agent**. For a target moving at a
constant speed `v` the steady state solves `ẋ_cam = v`:

```
e_ss = v/k + dz·AIM
```

Two separate error sources, and *both* are structural:

* `v/k` — the classic first-order tracking lag. Any pure exponential ease has it.
* `dz·AIM` — the camera is *aimed* at the boundary, so it parks there by construction.

With `k = 5`, `dz ≈ 127 px`, `AIM = 0.9` that is `≈ 114 px + v/5` — which is exactly what
the shipped verification measured (mean **104.7 px**, max 129.4 px against a 127.3 px
deadzone) and read as "the camera perpetually trails".

Both terms were deliberate at the time: the big deadzone was the anti-shake allowance, and
`AIM < 1` is *load-bearing* for the shipped design (an exact-edge target is only approached
asymptotically, so `|e| ≤ dz` would never latch and a parked agent produced an endless
stream of sub-pixel writes). The offset is the price of that construction.

## 3. The standard options

| # | Scheme | Ramp (constant-velocity) error | Verdict |
|---|--------|-------------------------------|---------|
| 1 | First-order ease (`ẋ = k·e`) | `v/k` | The shipped scheme. Simple, always trails. |
| 2 | **Critically damped spring** (Unity `SmoothDamp`, second order) | `2v/ω` | The industry-standard camera follow. *Acceleration*-based: the camera carries a velocity state and never jumps. Still trails — a second-order system is still **type 0** with respect to a ramp. |
| 3 | **Velocity feedforward** ("lead the target" / look-ahead) | **0** | Aims at `agent + τ·v_agent`. Cancels the lag *by construction* rather than by gain. Must be low-pass filtered or the target's jitter is injected straight back into the camera. |
| 4 | PID (add an integrator) | 0 | Rejected: wind-up, a third tuning knob, and it *overshoots* — for a camera the ramp error is exactly known, so feedforward beats feedback here. |

**The standard practice is the composition, not any single one:** a *small* deadzone (kills
micro-jitter and lets the camera come to a genuine rest), a **critically damped spring**
(smooth acceleration, no overshoot), and a **filtered velocity feedforward** (kills the
constant-velocity lag). This is what Unity's Cinemachine, Unreal's camera lag + look-ahead,
and essentially every 2-D platformer camera do.

Note the honest comparison in the table: swapping the exponential ease for a spring alone
would have **made the lag worse** for the same responsiveness (`2v/ω` vs `v/k`). The spring
is what makes the motion feel like acceleration; the **feedforward** is what actually
"picks up and catches up".

## 4. The law shipped

Per axis, in world units, once per rAF frame (`dt` clamped to 0.1 s):

```
                                                    ω  = FOLLOW_OMEGA        = 6   rad/s
raw  = fold(agent − agentPrev) / dt                 τ  = FOLLOW_VEL_TAU      = 0.35 s
raw  = clamp(|raw|, maxSpeed)                       maxSpeed = max(W,H,D) per second
fv  += (1 − e^(−dt/τ)) · (raw − fv)                 -- EMA-filtered agent velocity

e    = fold(agent − camera)
if |e| ≤ rest and |camV| ≤ vEps and |fv| ≤ vEps:    -- REST LATCH
    camV = 0;  return                               -- no write, no draw

lead   = (2/ω) · fv                                 -- exactly cancels the spring's ramp lag
change = −(e + lead)                                -- = camera − desired
exp    = 1 / (1 + x + 0.48x² + 0.235x³),  x = ω·dt  -- ≈ e^(−ω·dt), Unity SmoothDamp
temp   = (camV + ω·change)·dt
camV   = (camV − ω·temp)·exp
camera+= (change + temp)·exp − change                -- a pure DELTA (torus-safe)
```

Design notes, each load-bearing:

* **`lead = (2/ω)·fv` is the exact cancellation, not a tuned look-ahead.** A critically
  damped spring tracking a ramp settles at `p_des − p_cam = 2v/ω`; putting `2v/ω` into
  `p_des` makes `p_cam = agent`. Nothing to tune.
* **The velocity is derived from successive render-snapshot positions**, not from the
  engine's `vx/vy`. It therefore needs **no worker plumbing** (no `setAgentSnapshotVelocity`
  coupling, none of the "an un-requested snapshot field silently reads as 0" trap) and it
  works for models whose engine velocity is meaningless — Ant Necrophoresis moves its ants
  with `Set Agent Position` and leaves `vx/vy` at zero, and a snapshot-velocity feedforward
  would silently do nothing there.
* **The raw sample is speed-clamped to one world extent per second.** A teleport moves the
  agent a whole world in one frame ⇒ an implied ~60 worlds/s ⇒ a feedforward that flings the
  camera far past the agent. Measured below: **144 px of overshoot without the clamp, 0.0 px
  with it.** No real agent approaches one world per second, so the clamp never touches
  genuine motion.
* **The deadzone became a REST LATCH, not a set-point.** It no longer shrinks the error
  (that is precisely what parks the camera on the boundary) — it only decides when the
  controller may stop writing. It gates on position **and** camera velocity **and** filtered
  agent velocity, so it cannot fire mid-flight, and it cannot stall a genuine slow follow.
  Because the spring drives `e → 0` and `camV → 0`, the latch is reached in finite time —
  `FOLLOW_AIM_INSIDE` and its asymptotic-chase problem are gone entirely.
* **Everything is a delta**, so the torus fold applies unchanged and no absolute position is
  ever compared across a seam.

## 5. Measured characterization

`scripts/`-free 1-D simulation of both laws at 60 fps, scale 7 px/cell, canvas 850 px
(so the shipped deadzone is 127 px and the new rest radius 25 px). Reproduced in the
browser afterwards — see the CLAUDE.md FOLLOW MODE section for the live numbers.

**Constant velocity — steady-state screen offset**

| agent speed | OLD mean / max | NEW mean / max |
|---|---|---|
| 2 cells/s | 103.7 / 127.3 px | **0.11 / 0.11 px** |
| 5 cells/s | 126.8 / 127.3 px | **0.27 / 0.27 px** |
| 10 cells/s | 128.0 / 128.0 px | **0.54 / 0.54 px** |
| 20 cells/s | 141.4 / 141.4 px | **1.08 / 1.08 px** |

**Jitter rejection — agent oscillates ±1 cell** (camera amplitude, agent amplitude = 1.0)

| frequency | OLD | NEW |
|---|---|---|
| 1 Hz | 0.0000 | 0.869 |
| 3 Hz | 0.0000 | 0.176 |
| 6 Hz | 0.0000 | 0.045 |

The honest trade: the old controller was *perfectly* still for anything inside 15 % of the
canvas, including slow real motion. The new one follows a **1 Hz ±1-cell wander** almost
fully — but smoothly, and that is a genuine motion at the scale of a cell, not shake. True
shake is high-frequency (a sim stepping at ≥10 Hz jitters at ≥10 Hz) and is attenuated by
the spring's second-order roll-off to a few percent. The rest latch then removes the last
sub-pixel dribble when the agent actually stops.

**Parked** — the agent stops 30 cells off-centre: the latch fires at **1.5 s** and the
controller performs **0 writes** thereafter (frames 300–600 of the run). Identical to the
shipped behaviour, which is the invariant that mattered.

**Teleport (+90 cells, then still)** — with the clamp: 1 error sign change, **0.001 cells
(0.0 px) of overshoot**. Without the clamp: **20.6 cells (144 px) of overshoot**.

**Acceleration from rest to 10 cells/s cruise** — error peaks at 10.2 px, is 7.5 px at 1 s,
0.1 px at 2 s, and stays at 0.5 px thereafter. That is the "picks up and catches up" the
report asked for.

## 6. What did NOT change

The rAF loop shape (one loop for both dimensions, params through refs, `last = 0` while
hidden, `dt` clamped to 0.1 s), the torus-shortest folding, the 2-D wrap-only-when-infinity-
is-off rule, the 3-D always-wrap rule, cancel-on-manual-pan/orbit, zoom does **not** cancel,
teardown on close / death / model load, and the `window.__simFollowState()` DEV hook (which
gained `camV` and `agentV` so the controller state is observable from an occluded pane).
