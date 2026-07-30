# Plan — Recording options: quality mode, lossless capture, capture-resolution caps

**Status:** planned · **Date:** 2026-07-30 · **Branch:** `improvements`
**Illustrated mockup:** [PLAN_RECORDING_OPTIONS.html](./PLAN_RECORDING_OPTIONS.html)
**Prior art / measurements:** [INVESTIGATION_STREAMING_RECORDING.md](./INVESTIGATION_STREAMING_RECORDING.md)

This plan implements the user's answers to that investigation's §8 open questions. Three of the
five answers are behaviour changes visible in the transport bar, so the repo's illustrated-plan
rule applies.

---

## 0. The decisions being implemented

| # | question | answer | scope here |
|---|---|---|---|
| 1 | is dropping frames acceptable? | **ship both** — drop stays the default, add an opt-in *never skip* that slows the simulation instead | §2 |
| 2 | all-intra default, or move it? | **move it** — GOP-30 becomes the default; all-intra becomes an opt-in *Archival* mode | §3 |
| 3 | Tier 2 destination (disk streaming) | **deferred by decision** — not implemented, and marked as such so it is not re-litigated | §6 |
| 4 | Tauri binary save | *not this plan* (a separate session owns it) | — |
| 5 | 3D capture resolution | **cap the long edge at 1280** | §4 |
| 6 | move `RECORD_MAX` off the VP9 4:4:4 freeze width | **yes — but the bisect changed what "off it" means** | §5 |

---

## 1. What the bisect found (and why it rewrites §6b of the investigation)

The investigation bracketed a Chrome software-VP9 **profile 1 (4:4:4)** renderer freeze between
a healthy 900×900 and a frozen 960×540, and shipped the guard `VP9_444_MAX_WIDTH = 960`
(*"profile 1 only below width 960"*). This plan's first task was to bisect that bracket before
choosing a new number. **The bisect falsified the threshold model.**

Standalone probe (no app, no simulation, no WebGPU — just `VideoEncoder` + a 50 ms heartbeat,
6 frames of synthetic sharp content at the app's own bitrate rule). Every row measured on
Chrome 148 / Windows 10 / 32 GB:

| w × h | coded w (÷8 ceil) | coded w mod 32 | verdict | 6 frames | heartbeats | max main-thread gap |
|---|---|---|---|---|---|---|
| 640 × 640 | 640 | **0** | **FREEZE** | 1 of 6 in 25 s | 2 | — |
| 864 × 864 | 864 | **0** | **FREEZE** | 1 of 6 in 25 s | 3 | — |
| 880 × 880 | 880 | **16** | OK **fast** | **274 ms** (46 ms/f) | 648 | 69 ms |
| 896 × 896 | 896 | **0** | **FREEZE** | 1 of 6 in 25 s | 3 | — |
| 900 × 900 | 904 | 8 | OK *slow* | 4 863 ms (810 ms/f) | 8 | **1 008 ms** |
| 912 × 912 | 912 | **16** | OK **fast** | **322 ms** (54 ms/f) | 679 | 71 ms |
| 912 × 928 | 912 | **16** | OK **fast** | **313 ms** (52 ms/f) | 686 | 71 ms |
| 914 × 914 | 920 | 24 | OK *slow* | 4 686 ms (781 ms/f) | 36 | **1 010 ms** |
| 920 × 920 | 920 | 24 | OK *slow* | 5 058 ms (843 ms/f) | 67 | **1 055 ms** |
| 921 × 921 | 928 | **0** | **FREEZE** | 1 of 6 in 25 s | 0 | — |
| 928 × 928 | 928 | **0** | **FREEZE** | 1 of 6 in 25 s | 0 | — |
| 928 × 540 | 928 | **0** | **FREEZE** | 1 of 6 in 25 s | 3 | — |
| 960 × 960 | 960 | **0** | **FREEZE** (>150 s, only released by navigating away) | 1 of 6 | 0 | — |
| **1280 × 720, profile 0** | 1280 | 0 | OK **fast** | **192 ms** (32 ms/f) | 903 | 70 ms |

**The model — 13 points, zero contradictions.** With `cw = ceil(w / 8) * 8` (VP9 codes width in
8-pixel units):

```
cw % 32 ===  0   →  FREEZE   (renderer starved indefinitely; never recovers on its own)
cw % 32 === 16   →  FAST     (~50 ms/frame, main thread responsive)
cw % 32 ===  8   →  SLOW     (~800 ms/frame, ~1 s main-thread stalls)
cw % 32 === 24   →  SLOW     (same)
```

Four consequences, in order of importance:

1. **The shipped guard is the wrong *shape*, not merely the wrong number.** `w < 960` lets 640,
   864 and 896 through — all of which **freeze today, in the shipped build**. This is a live
   defect, strictly worse than the investigation described. The guard must become a residue test.
2. **It is width-driven, confirmed twice on this machine.** 928 × 540 (501 k px) freezes while
   920 × 920 (846 k px) does not, and 912 × **928** — a bad number in the *height* — is fast.
   Only the width matters.
3. **There is a third regime the investigation never saw.** 900/914/920 "worked" in the original
   probe, but they are ~15× slower per frame than 880/912 and stall the main thread for a full
   second. A guard that merely avoids `≡ 0` would leave half of all widths in this regime. The
   guard therefore requires the *one measured-fast residue*, not merely "not the frozen one".
4. **Profile 0 is immune.** 1280 × 720 (≡ 0, the worst residue) encodes at 32 ms/frame with 903
   heartbeats. So the profile-0 fallback is sound and the 3D cap can sit on a ≡ 0 width safely.

**Reproducing it:** the probe is ~80 lines of standalone HTML (`?w=&h=&p=&n=`); it writes progress
to `localStorage` on every heartbeat so a hard freeze still leaves a trail, and the freeze is
escaped by navigating away. Worth filing upstream — see §7.

---

## 2. Decision 1 — a lossless ("never skip frames") option

### Today
`WebMStreamEncoder.addFrame` refuses a frame when the encoder queue is at `QUEUE_CAP` (2) or when
the `DUTY_FACTOR` (1.5) duty-cycle gate has not elapsed. The caller counts the refusal and the
transport shows `REC 1200f · 37 dropped`. Frames are never queued without bound — queued
`VideoFrame`s live in GPU/media memory and are an invisible sink.

### The constraint that dictates the design
`draw()` is synchronous and cannot `await` the encoder — that is exactly why the drop policy
exists. So "slow the simulation" cannot live at the capture site. It must live where the loop is
**already asynchronous**: the step pipeline.

That pipeline is a chain, not a timer:

```
sendNextStep()  →  worker  →  'stepped' message  →  draw()  →  capture frame
                                                          →  rAF tick → sendNextStep()
```

The `tick` closure at the tail of the `stepped` handler already *retries on rAF* until
`elapsed >= msPerFrame`. **Adding one more reason to retry is the whole feature.**

### The change
* `WebMStreamEncoder` gains `readyForNextFrame()` — the existing accept predicate (queue below
  cap **and** duty gate elapsed) exposed as a query — and `addFrame(frame, force)`.
* **Drop mode** (default) is byte-for-byte today: `addFrame(frame)`.
* **Lossless mode**: `addFrame(frame, true)` bypasses the cap and the duty gate, so a captured
  frame is *always* submitted; then the `tick` loop refuses to issue the next step batch until
  `readyForNextFrame()` is true.

Because capture happens exactly once per issued step, and a step is only issued when the queue is
below the cap, **the queue is bounded by the cap plus one** — the invisible-memory hazard is
avoided without ever refusing a frame. The simulation simply runs at the encoder's rate.

### It must not be able to hang
Three guards:

* **Hard cap.** `addFrame(force)` still refuses past `LOSSLESS_HARD_CAP = 8`. In the play loop
  this is unreachable (the throttle keeps it at ≤ 2); it exists so a burst of *manual* steps
  cannot grow the queue without bound.
* **Stall timeout.** If the tick loop has been waiting on the encoder for more than
  `LOSSLESS_STALL_MS = 8 000` ms — an order of magnitude beyond the worst measured per-frame
  encode — the recording **degrades to drop mode for the rest of the run** and raises a one-time
  toast. It never oscillates back, so there is no flapping.
* **Legibility.** While the loop is waiting, the stats overlay's REC readout shows
  `⏺ REC 412f ⧗ waiting for encoder`, so a slowed simulation never reads as a hang.

### Manual Step and pause
* A manual Step in lossless mode force-submits, so it cannot silently lose its frame (the whole
  point of the mode). Only hammering Step past 8 queued frames reaches the hard cap, and that is
  counted and shown like any other drop.
* Pausing produces no `stepped` messages, so nothing is captured and the encoder drains — the
  mode is inert while paused, exactly as the drop policy is.

### Locked at Start
Like format and scope, the selector renders only in the `!recording` branch, so the mode is fixed
for the run — which is what lets the throttle assume a single policy.

**Acceptance:** a lossless recording that completes reports **0 dropped**, and on dense content
its capture rate is measurably below the drop-mode rate on the same model.

---

## 3. Decision 2 — GOP-30 becomes the default; all-intra becomes "Archival"

Measured in the investigation on 150 dense Kelp War frames: **GOP 30 is 3.5× smaller and 1.8×
faster** than all-intra at the same bitrate. That is the largest single lever available.

* New `RecordQuality = 'standard' | 'archival'`, default `'standard'`.
* `keyFrameIntervalFor(q)` → `30` for standard, `1` for archival. Both the streaming encoder and
  the buffered fallback take the quality and emit `{ keyFrame: index % interval === 0 }`.
  **That sharing is load-bearing** — a streamed file must be configured exactly like a buffered
  one, which is why `pickVp9Config` / `vp9EncoderConfig` are already shared.
* **The bitrate rule is unchanged** (`max(4 Mbps, w·h·fps·6)`). The investigation also measured a
  40 Mbps cap as a 3.1× win, but at an unmeasured quality cost — out of scope here.

### What a dropped frame does under GOP-30 — verified, not assumed
The claim to check is that a drop *shortens* the sequence rather than corrupting it.

A drop happens **before submission**: `addFrame` returns false and `encoder.encode()` is never
called for that frame. The encoder therefore only ever sees the frames it was given, **in order**,
and codes each delta frame against the previously *submitted* frame. The bitstream is internally
consistent by construction — there is no reference to a frame that was never encoded. Timestamps
come from the *encoded* index, so the file still plays at the nominal rate.

The only user-visible effect is that the video jumps a few generations, exactly as under
all-intra. **Verification:** decode a GOP-30 recording taken with deliberate drops through
`VideoDecoder` and assert it yields exactly `encodedCount` frames with zero decode errors — a
size or keyframe-flag check alone cannot distinguish "shortened" from "corrupt".

### The honest trade, to be stated in the UI and Help
* **Standard (GOP 30)** — far smaller files, faster encoding, so the simulation runs closer to
  full speed while recording. A player must decode from the last keyframe, so scrubbing lands on
  30-frame boundaries.
* **Archival (all-intra)** — every frame decodes independently: frame-by-frame analysis,
  scrub-exact, and each frame is visually faithful with no interframe prediction bleeding across
  previously-stable regions (the original reason for the choice on CA content). ~3.5× larger,
  ~1.8× slower to encode.

---

## 4. Decision 5 — cap the 3D capture at 1280 on the long edge

`capture3dPixels()` / `gl3d.readPixels()` return the **whole WebGL drawing buffer** at
`cssW · dpr × cssH · dpr` with no cap — measured **23 MB/frame** at DPR 2 and **33 MB** at 4K, the
largest per-frame cost anywhere in the codebase, while the 2D paths have been capped all along.

* New `RECORD_MAX_3D = 1280` (long edge), applied **only in the recording capture block** —
  screenshots keep full display resolution.
* Downscale with the same de-opt-safe discipline as 2D: `putImageData` onto a never-displayed
  source canvas, `drawImage` scaled onto a never-displayed `willReadFrequently` scratch,
  `getImageData` that. **Never `getImageData` a live canvas** (the persistent ~6× penalty).
* **Deliberately not 960**, and — post-bisect — deliberately **not** a `≡ 16 (mod 32)` width
  either: 1280 ≡ 0, so the guard routes 3D to profile 0. That is the documented consequence the
  decision anticipated: **3D records in 4:2:0.** It is the right trade — the alternative is a
  frozen renderer, and §1 shows profile 0 at 1280 is the fastest configuration measured.

---

## 5. Decision 6 — `RECORD_MAX` and the profile-1 guard

The decision was "move `RECORD_MAX` slightly below the freeze threshold so the default keeps
crisp 4:4:4". §1 shows there is no threshold to sit below — so the *intent* is honoured with the
residue model instead:

| constant | old | new | why |
|---|---|---|---|
| `RECORD_MAX` | 960 | **912** | 912 ≡ **16** (mod 32) — the one measured-**fast** class. 5 % smaller than today, and unlike today it is genuinely 4:4:4. |
| `VP9_444_MAX_WIDTH` | 960 | *removed* | A max-width guard cannot express this failure (640 freezes). Replaced by `isVp9Profile1Safe(w)` = `ceil(w/8)*8 % 32 === 16`. |
| `RECORD_MAX_3D` | — | **1280** | §4. ≡ 0 → profile 0, verified fast. |

**Margin.** In residue space, `≡ 16` is the maximum possible distance from the frozen class — 16
coded pixels from `≡ 0` on either side, and every capture width is snapped to an exact multiple of
8 so rounding cannot drift across. That is a stronger guarantee than a linear margin, because the
failure is not linear in width.

**Snapping arbitrary widths.** The "current view" scope derives its width from the display canvas
and the "simulation" scope from the grid aspect, so arbitrary widths occur. `snapRecordWidth(w)`
lowers the width to the largest value ≤ w in the fast class (and derives the height from the same
scale, so the aspect ratio is preserved exactly). It only engages above 320 px, bounding the
resolution change at under 10 %; below that the width is left alone and the guard sends it to
profile 0. Net: the common case is 4:4:4 and *nothing* ever lands in the 800 ms/frame slow class.

**Residual uncertainty, stated plainly.** The residue rule is inferred from 13 points on one
machine and one Chrome build; the underlying cause (likely a libvpx tile/threading path) is
unknown, and a machine with a different core count could plausibly shift it. The mitigation is
that GenesisCA controls its own capture widths and the fallback (profile 0) was measured fast at
the worst residue. Anything unexpected degrades to 4:2:0, never to a freeze.

---

## 6. Decision 3 — Tier 2 is deferred by decision

Streaming the muxer output to disk (File System Access, or OPFS as a fallback) is **not being
implemented**, by the user's decision. The investigation's §4 measurements stand and its
recommendation section will be marked `DEFERRED BY DECISION` so a future reader does not
re-litigate it: Tier 1 already moved the ceiling from ~105 s to 4.4×–541× longer, and GOP-30
multiplies that again by ~3.5× on the dense content that bounds it.

---

## 7. The UI change

Two compact `<select>`s join the existing format/scope select in the transport bar, **rendered
only while not recording** (so all four choices lock together at Start) and **only for WebM**
(GIF has neither a GOP nor a streaming encoder — it buffers by design):

```
 ⏺  [WebM (simulation) ▾]  [Standard ▾]  [Skip frames ▾]      ← not recording
 ⏹ 412  ⧗                                                      ← recording, throttled
```

* **Quality** — `Standard` (GOP 30) / `Archival` (all-intra). Long explanation in the `title`.
* **On overload** — `Skip frames` (today) / `Never skip` (slow the simulation).
* The stats overlay REC readout gains `⧗ waiting for encoder` while the lossless throttle holds
  the loop, next to the existing `· N dropped`.

See the mockup for before/after and the decision table rendered visually.

---

## 8. Verification plan (the bar for the implementation commit)

Real recordings driven through the actual Record button, blob-intercepted and inspected:

1. **GOP cadence** — decode both modes with `VideoDecoder` and count keyframes: standard must
   show a keyframe every 30 frames, archival every frame. Not inferred from file size.
2. **The GOP-30 win** — size and encode time for both modes on identical content.
3. **Lossless** — 0 drops, a capture rate measurably below drop mode on the same dense model, no
   hang, and the throttle indicator visible.
4. **Drop mode unchanged** — same behaviour as today.
5. **3D cap** — encoded dimensions ≤ 1280 on the long edge; per-frame cost falls.
6. **The freeze test (safety-critical)** — at the new 2D default, a ≥ 150-frame recording must
   complete with `vp09.01.…` selected and **no** renderer freeze; report the max main-thread gap.
   A regression here would break every user, so it is proven, not argued.
7. **GIF unregressed** — asserts **0** `encode()` calls during a GIF recording (it buffers).
8. **Abort/cancel** leaks nothing and a subsequent recording works.

Plus `npx tsc -p tsconfig.app.json --noEmit`, `npm run build`, and
`node scripts/verify-agent-render.mjs` (the SimulatorView source census).
