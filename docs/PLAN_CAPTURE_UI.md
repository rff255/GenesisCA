# Plan — reorganising the capture (screenshot + recording) controls

> **STATUS: IMPLEMENTED** (branch `improvements`). See the "As built" section at the end for the
> three deviations from this plan and the measured verification.

Illustrated mockup: [PLAN_CAPTURE_UI.html](PLAN_CAPTURE_UI.html) (self-contained; open in a browser).

## The problem

After the recording-options work (`af394eb` / `bc00e1e`) the simulator transport bar carries **six capture controls,
four of them dropdowns**, permanently docked between `Reset` and the speed readouts:

```
🖫 🗁 │ FPS 60 │ ▶ ⏸ ▶| ■  📷  [PNG (simulation) ▾]  ⏺  [WebM (simulation) ▾]  [Standard ▾]  [Skip frames ▾] │ G/F 1
                            └──────────────── ~470 px, 6 controls ────────────────┘
```

1. **Wasteful width** — only 📷 and ⏺ are pressed during a session; the four selects are per-project (often per-month)
   settings holding permanent real estate on the busiest bar in the app.
2. **Layout instability** — Quality and overload are WebM-only and are *unmounted* for GIF, so switching format removes
   ~185 px and everything to its right jumps, including the G/F readout the user may be reaching for.
3. **Wrong altitude** — configuration sitting inline with actions; the bar mixes "do it now" with "how should it be done".

## Chosen design — Option C, with Option A's chip (user decision)

Capture leaves the transport bar **entirely** and becomes the bottom-most element of the canvas's **right-edge stack**,
directly beneath the stats readout. The summary chip from Option A comes along so the configuration stays glanceable.

```
canvas ┌──────────────────────────────────────────────────────┐
       │                                                      │
       │  [+ − ⛶ ▦ ∞]          ← view controls (unchanged,    │
       │   bottom-left            bottom-LEFT)                 │
       │                                          Gen 12 480   │
       │                                        1 208 agents   │
       │                                     58 fps · 16.9 ms  │  ← .statsOverlay
       │            🖫 🗁 │ FPS 60  G/F 1 │ ▶ ⏸ ▶| ■           │
       │              transport bar          📷 ⏺ [WebM·sim·Std ▾] │  ← NEW capture cluster
       └──────────────────────────────────────────────────────┘
```

Rationale: the transport bar is about **simulation time** (play / step / reset / speed); screenshot and recording are
**output**. Splitting them by purpose declutters conceptually, not just visually — view controls on the left edge,
output on the right edge, time in the middle.

### Two user-requested adjustments (both incorporated)

1. **Bottom-right, under the stats** — *not* appended to the bottom-left view cluster. Output belongs on the right edge
   with the other readouts.
2. **G/F moves beside FPS** on the transport bar — they are the same kind of setting (both open vertical-slider
   popovers) and were previously at opposite ends of the bar.

## Behaviour

- **Chip** = readout + popover trigger, showing `format · area · quality` (e.g. `WebM · sim · Std`).
- **Popover** holds: screenshot area, record format, record area, quality, overload — every binary choice as a
  **two-state segment**, never a dropdown.
- **Inapplicable settings are disabled in place with a reason**, never unmounted (GIF → quality/overload greyed with
  "GIF has no keyframe structure"; 3D → screenshot/record area greyed with "a 3D scene fills the frame").
- **Locked at Start**: while recording, ⏺ becomes ⏹ with the frame count (+ skip count + ⏳ throttle indicator), the
  chip shows the frozen configuration, and the popover is disabled — the encoder requires the configuration to hold
  for the whole run.

## Implementation seams

- All six controls live in one JSX region of [SimulatorView.tsx](../src/simulator/SimulatorView.tsx) — the
  `!recording ? (…) : (…)` block plus the screenshot `<select>` immediately above it. **State and persistence are
  unchanged** (`recordFormat`, `recordScope`, `screenshotScope`, `recordQuality`, `recordOverload` in
  `genesisca_sim_settings`): this is a pure presentation change.
- The G/F block (`speedPopup === 'gpf'`) moves to sit immediately after the FPS block; the divider that currently
  separates capture from G/F is removed and the two readouts share one group.
- New overlay cluster near [`.statsOverlay`](../src/simulator/SimulatorView.module.css) (`bottom: var(--space-6);
  right: var(--space-4)`). **The stats overlay is bottom-anchored, so it must be lifted by the cluster's height** —
  the robust form is a single bottom-right flex column owning both, so they cannot overlap however many stat lines a
  model produces (agent models add several).
- Popover pattern to clone: `speedPopup` / `speedPopupWrapRef` / `styles.speedPopup`. Note it must open **upward-left**
  from a bottom-right anchor (the transport-bar popovers open upward from a centred anchor), and must be
  viewport-clamped. Keep the flush `bottom: 100%` rule — a visual gap between trigger and popover is a hit-test hole
  that fires `pointerleave`.
- **Every new element needs `data-sim-overlay`** — without it, `canvasBrushActive` lets clicks fall through to the
  canvas and paint cells (the documented overlay rule).

## Verification bar

- The transport bar contains **zero** capture controls, and the measured x-position of every remaining bar control is
  **identical in WebM and GIF** (the reflow regression, now trivially true).
- FPS and G/F are adjacent, and both popovers still open (hover + click), dismiss, and drive their values.
- The capture cluster never overlaps the stats overlay: assert measured bounding boxes for a model with few stat lines
  and one with many (an agent model), and after a panel resize.
- The popover opens/dismisses per the shipped rules, is **disabled while recording**, and every setting round-trips
  through `genesisca_sim_settings`.
- A real recording started from the new UI still produces a valid file with the selected quality/overload behaviour —
  i.e. the presentation change did not disturb the locked-at-Start contract.
- 3D: the area rows are disabled-with-reason rather than absent.

## Two rules that outlive this change

1. **Never unmount an inapplicable control** — disable it in place with a reason. Stable geometry, and the user learns
   *why*.
2. **A binary choice is a two-state segment, not a dropdown.**

---

## As built

Landed as a **pure presentation change**: `git diff --stat` is
[SimulatorView.tsx](../src/simulator/SimulatorView.tsx) + [SimulatorView.module.css](../src/simulator/SimulatorView.module.css)
only. The five state values and their `genesisca_sim_settings` round-trip, `recording/*`, the encoder, the capture caps
and the recording state machine are all untouched.

### Three deviations from the plan (all discovered by verification)

1. **The cluster sits at `bottom: 68px`, not in the transport bar's band.** The plan (and the mockup) put the right-hand
   stack at the very bottom alongside the centred bar. Measured, the bar reaches the right edge on a narrower canvas and
   covered the cluster's buttons — at 900×620 the bar's box overlapped the cluster's, and at 1199×977 it still clipped a
   3 px sliver. The stats overlay had always lived in that band, but *a covered readout is merely ugly; a covered button
   is broken*. 68px = the bar row's ~51 px + its 12 px inset + margin, mirroring `.zoomControls`' 60px on the left edge.
   Left (view) and right (output) clusters now share a baseline.
2. **The "why" lines are stacked in one grid cell, not swapped.** Disabling the control in place was not sufficient:
   swapping the long WebM explanation for the short GIF reason shrank the popover 406 → 280 px and slid every row —
   including the *Record format* row just clicked — **125 px** out from under the cursor. `.captureWhyStack` renders both
   variants in the same grid cell (`grid-area: 1/1`) and hides the inactive one with `visibility`, so the box is always
   as tall as the taller variant. Re-measured: **dY = 0 on every row** across a WebM↔GIF flip.
3. **Both 3D-disabled area rows state the reason**, not just the screenshot one (a disabled row with no explanation is
   exactly the failure the rule exists to prevent).

### Verification (all driven through the real UI in a visible browser)

| Claim | Evidence |
| --- | --- |
| Zero capture controls on the bar | 8 buttons, **0 `<select>`**; order = save/load │ FPS G/F │ ▶ ⏸ ▶\| ■ |
| No reflow on format change | every bar control's x identical in WebM and GIF (515.18 / 551.18 / 600.18 / 662.07 / 729.41 / 763.13 / 813.13 / 850.10) |
| Popover geometry stable | popover height **421.42 px in both formats**; all 5 rows dY = 0 |
| Never unmounted | GIF: 5 rows present, Quality + overload `RowDisabled` with both segment buttons `disabled`; 3D: both area rows likewise |
| No stats/cluster overlap | gap **exactly 4 px**, `overlap: false` — 5-line grid model and 6-line agent model, at 1400×900, 1199×977 and 900×620 |
| No bar/cluster overlap | `barVsCluster: false` at 900×620 and 1199×977; all three cluster buttons hit-test to themselves |
| Popover behaviour | real hover opens (flush, gap 0 px, right-aligned, opens upward, inside viewport); crossing into it keeps it open; outside pointerdown closes it; Escape closes it **without** firing Esc=reset (Gen stayed 1) |
| Hovering 📷/⏺ does *not* open it | `capturePopOpen: false` while really hovering the camera button |
| Locked at Start | mid-recording the chip is `disabled`, shows the frozen `WebM · sim · Std`, and clicking it does not open the popover; ⏺ → `⏹ 446 −451` |
| Persistence | all five keys written; survive a reload (`WebM · view · Arch ▾` restored, all 5 segments correct) |
| `data-sim-overlay` | worker-postMessage spy: canvas click → `paintManual` (positive control); cluster padding, stack gap, stats strip and inside-popover clicks → **zero** paint messages |
| Real screenshot | valid PNG (`89 50 4e 47`); **the area setting demonstrably reaches the capture**: `simulation` → 720×720 (grid aspect), `view` → 980×864 (= the display canvas) |
| Real recording | started and stopped from the new cluster → valid WebM (`1a 45 df a3`), 2.5 MB / 446 frames |
| Quality reaches the encoder | measured at `VideoEncoder.encode` (not inferred from file size): **Standard = 8 keyframes / 223 frames (GOP 27.9)**, **Archival = 328 / 328 (GOP 1.0)**; matched Reset-to-Reset runs give **5.11× bytes/frame** for Archival — inside the documented ~3.5–6× band |
| FPS / G-F | adjacent; both popovers open on hover *and* click, one at a time; sliders drive + persist their values; grabbing the FPS slider while ∞ is on **unticks it** |
| Gates | `tsc -p tsconfig.app.json --noEmit`, `npm run build`, `scripts/verify-agent-render.mjs`, 0 console errors on a fresh load |

**Note on a red herring:** the first Standard-vs-Archival file-size comparison came out *inverted*. It was confounded by
board content (the runs covered different boards). Measuring at the encoder API instead of the file settled it, and a
matched Reset-to-Reset re-run then showed the expected 5.1× — a reminder that **file size is a proxy; the encoder call is
the evidence**.
