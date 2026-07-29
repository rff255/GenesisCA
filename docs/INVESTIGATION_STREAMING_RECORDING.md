# Investigation — Streaming / Incremental Video Recording

**Status:** investigation complete; **Tier 1 recommended and implemented** (see the companion
commit). Tier 2 specified, not implemented.
**Date:** 2026-07-29 · **Branch:** `improvements`
**Goal:** make long, high-quality simulator recordings possible for scientific use, instead of
running out of memory after roughly a minute.

---

## 0. TL;DR

| | today | Tier 1 (encode-as-you-go, shipped) | Tier 2 (stream to disk, specified) |
|---|---|---|---|
| what accumulates in RAM | **raw RGBA frames** (2.9–33 MB *each*) | **compressed WebM bytes** (5 KB–660 KB/frame) | **nothing** (bytes go to disk) |
| measured ceiling (this machine, 32 GB) | **~9.3 GB of frames** → OOM `RangeError` | same 9.3 GB budget, but 4.4×–541× more seconds in it | disk / OPFS quota (10 GB) or unbounded (File System Access) |
| 2D dense model @30 fps | **~105 s**, then the app breaks | **~7.8 min** | unbounded |
| 2D sparse model @30 fps | ~105 s (identical — raw frames don't care about content) | **~16 h** (chunk-bound) | unbounded |
| 3D at DPR 2 / 4K @30 fps | **~9–14 s** | minutes | unbounded |
| cost at **Stop** | full encode, UI frozen — **15 s per 150 dense frames** (measured) | ≈ flush only (< 1 s typical) | ≈ flush only |
| user-visible change | — | **none in the normal case**; frames may be *dropped* if the encoder can't keep up (surfaced in the counter) | new "choose a file" step at record start |

**Headline correction to the naive framing:** the win is *not* uniformly "orders of magnitude".
Compression of GenesisCA output ranges over **two orders of magnitude** depending on content —
541× for a sparse Game of Life, **4.4×** for a dense Kelp War — because the encoder is
configured all-intra at 132 Mbps. Tier 1 is still strictly better than today in *every* case
(it can never be worse than the raw frames it replaces, and it removes the stop-time freeze),
but on dense content the single biggest lever is the **encoder configuration**, not the memory
architecture (§6).

---

## 1. What the current pipeline does

[SimulatorView.tsx](../src/simulator/SimulatorView.tsx) captures one frame per **displayed**
frame, inside the `stepped` handler right after `draw()`:

```
stepped → draw() → if (recordingRef.current) { … } → recordedFrames.current.push(ImageData)
```

Three capture paths, all producing an `ImageData` pushed onto `recordedFrames.current`:

| path | source | size |
|---|---|---|
| 3D | `capture3dPixels() ?? gl3d.readPixels()` | the **full WebGL drawing buffer**, `cssW·dpr × cssH·dpr`, **no cap** |
| 2D `simulation` scope | `renderSimulationFrame(960, simCaptureRef)` — composited from the colours buffer + agent snapshot | grid aspect, **long side = 960** |
| 2D `view` scope | display canvas → CPU scratch (`willReadFrequently`) → `getImageData` | display size, downscaled only if `max(w,h) > 960` (`RECORD_MAX`) |

Then `forceFrameOpaque(frame.data)` sets alpha to 255, the dimensions are checked against the
first frame, and the frame is appended.

Nothing is encoded until **Stop & Save**:
[webmEncoder.ts](../src/simulator/recording/webmEncoder.ts) `encodeFramesToWebM(frames, fps)`
picks VP9 profile 1 (4:4:4) → profile 0 (4:2:0), configures a `VideoEncoder` at
`max(4 Mbps, w·h·fps·6)` with `latencyMode: 'quality'` and `contentHint: 'text'`, then loops the
frames encoding **every one as a keyframe** (all-intra). Chunks go into a
`webm-muxer` `Muxer` with an `ArrayBufferTarget`; `finalize()` yields the buffer → `Blob` →
download. GIF goes through `gifenc` (per-frame 256-colour palette, ≤ 512 px).

**Two structural observations that shape everything below.**

1. **The muxer is already incremental.** `addVideoChunk` is called from the encoder's `output`
   callback — chunks are muxed as they are produced. What is batched is only the *submission of
   frames to the encoder*. So Tier 1 does not change the muxing code path at all.
2. **Format and scope are already locked for the duration of a recording.** The format/scope
   `<select>` is rendered only in the `!recording` branch (SimulatorView ~L10734), so a running
   recording cannot change either. This is what makes committing to a WebM encoder at *record
   start* a non-breaking change.

---

## 2. Measured cost model

All numbers measured on this machine unless marked *derived*: Windows 10, 32 GB RAM,
Chrome 148 (Electron 42 shell), `devicePixelRatio = 1`, dev build, simulator pane 898 × 821 CSS px.
`navigator.deviceMemory` = 32.

### 2.1 The ceiling — where it actually falls over

Allocating `new ImageData(960, 624)` (2.396 MB) in a loop and touching a byte of each:

```
framesAllocated : 4094
totalMB         : 9355   (9.36 GB)
err             : RangeError: Failed to construct 'ImageData': Out of memory at ImageData creation
heapUsedMB      : 9431   ← reported usedJSHeapSize
limitMB         : 4096   ← reported jsHeapSizeLimit
elapsedMs       : 1480
```

Three things worth writing down:

* **It throws, it does not crash the tab.** `RangeError` from `new ImageData` /
  `ctx.getImageData`. In the app that throw happens **inside the `stepped` handler**, is not
  caught, and takes down that frame's `draw()`; the next `stepped` retries and throws again. So
  the observed failure mode is *"the simulator stops repainting and the console fills with
  RangeErrors"*, not a clean error message. (Tier 1 does not make this any worse and largely
  moves the ceiling out of reach; a defensive try/catch around the capture is a cheap separate
  hardening.)
* **`jsHeapSizeLimit` (4 GB) does not bound this.** `ImageData` backing stores are external
  array buffers; `usedJSHeapSize` sailed past the reported limit to 9.4 GB. The real bound is
  process/system memory — so **the ceiling is machine-dependent**. A 8 GB laptop will fail far
  sooner than the 9.3 GB seen here, and long before that the machine will be swapping.
* 9.3 GB of frames also means ~9.3 GB that must be *walked again* at Stop, which is why the
  stop-time encode is so slow (§2.4).

### 2.2 Bytes per frame at the real capture sizes

| capture | formula | this window | a hostile-but-realistic case |
|---|---|---|---|
| 2D `view` | `min(1, 960/max(w,h))` of the display canvas | 898×821 → **2.95 MB** | 1920×1080 display → 960×540 → 2.07 MB |
| 2D `simulation` | grid aspect, long side 960 | 300×300 grid → 960×960 → **3.69 MB** | 500×500 grid → 960×960 → 3.69 MB |
| 3D | `cssW·dpr × cssH·dpr`, **uncapped** | 898×821 → **2.95 MB** | DPR 2, 1600×900 pane → 3200×1800 → **23.0 MB**; 4K fullscreen → 3840×2160 → **33.2 MB** |

Notes:

* **The `simulation` scope UPSCALES small grids.** A 300×300 model produces a 960×960 frame —
  *larger* than the display capture. That is a deliberate quality choice, but it means the
  "cheap" scope is often the more expensive one.
* **3D is the outlier and has no cap at all.** `gl3d.readPixels()` returns the whole drawing
  buffer, which is sized `cssW × dpr`. It also allocates **two** buffers per frame (the raw
  `Uint8Array` from `readPixels` plus the y-flipped `Uint8ClampedArray`), so the transient
  allocation rate is 2× the retained rate — that is pure GC pressure on top of the retention.
  Capping 3D capture the way 2D is capped is an independent, trivially safe improvement.

### 2.3 Minutes before OOM (derived from §2.1 + §2.2)

Using the measured 9.3 GB budget:

| per-frame | frames | @30 fps | @60 fps |
|---|---|---|---|
| 2.95 MB (2D view, this window) | 3 170 | **1 m 46 s** | **53 s** |
| 3.69 MB (2D simulation, 300² grid) | 2 535 | **1 m 25 s** | **42 s** |
| 23.0 MB (3D, DPR 2) | 406 | **14 s** | **7 s** |
| 33.2 MB (3D, 4K) | 283 | **9 s** | **5 s** |

The capture rate is the *display* rate: the capture block sits in the normal (non-unlimited-gens)
`stepped` branch, so it fires once per drawn frame — up to the FPS slider (60 by default, and the
transport showed 61–72 fps actual on Game of Life). Nothing throttles recording capture
independently of display rate. **A 10-minute 60 fps recording is 36 000 frames — 106 GB raw. It
is not "tight", it is off by two orders of magnitude.**

### 2.4 The stop-time cost (the second, quieter failure)

Encoding 150 frames of 898×821:

| content | encode wall time | encoder throughput |
|---|---|---|
| Game of Life (sparse) | 2.06 s | 72.7 fps |
| Kelp War (dense) | **14.95 s** | **10.0 fps** |

Extrapolated to a recording that just fits in memory (3 170 dense frames): **≈ 5 min 17 s of
frozen UI at Stop**, single-shot, with no progress indication beyond the `Encoding WebM…`
tooltip. This is a real usability failure independent of the memory ceiling.

### 2.5 How well GenesisCA output actually compresses

Real frames, captured from running models through the same code path the recorder uses
(display canvas → CPU scratch → `getImageData` → opacify), then fed through the *current*
encoder configuration:

| model | content | 150 frames raw | encoded | ratio | avg chunk | encoder |
|---|---|---|---|---|---|---|
| **Game of Life** (gen ~800, 0.3 % lit still-lifes) | sparse binary | 421.9 MB | **0.78 MB** | **541×** | 5.3 KB | 72.7 fps |
| **Kelp War** (87 % lit, 5 colours, ~20 000 px changing/frame at 1-px scale) | dense high-frequency | 421.9 MB | **96.9 MB** | **4.4×** | 661 KB | 10.0 fps |

Kelp War is the honest worst case for a CA: pixel-scale noise across the whole frame is exactly
what DCT codecs handle worst, and the all-intra + 132 Mbps configuration means the encoder spends
every bit it is allowed to. **Any claim about how much streaming saves must be quoted as a
range, not a number.**

---

## 3. Tier 1 — encode-as-you-go (no disk)

Feed each captured frame to the `VideoEncoder` immediately instead of buffering the raw pixels;
only compressed chunks (already muxed) accumulate. The output file is produced by the same muxer
code as today.

### 3.1 Memory reduction

Retained bytes per frame drop from the raw figures in §2.2 to the compressed figures in §2.5:

| content | raw/frame | compressed/frame | frames in the 9.3 GB budget | @30 fps |
|---|---|---|---|---|
| sparse (GoL) | 2.95 MB | 5.3 KB | ~1.8 M | **~16 h** (irrelevant — file size wins first) |
| dense (Kelp War) | 2.95 MB | 661 KB | ~14 000 | **~7.8 min** |

So: **4.4× more recording time in the worst case, ~500× in the best.** And in the dense case the
limit stops being "the browser dies" and becomes "the file is getting large" — which is a limit
the user can see, reason about and control (§6), rather than a cliff.

Caveat: `webm-muxer`'s `ArrayBufferTarget` **doubles** its backing `ArrayBuffer` when it grows and
`finalize()` then does `buffer.slice(0, pos)` — a second full copy. **Peak in-memory cost is up to
~3× the final file size.** For a 500 MB file that is a ~1.5 GB spike at Stop. This is the main
argument for Tier 2 even after Tier 1 lands; it is not a reason to delay Tier 1.

### 3.2 Backpressure — the one genuinely new hazard

**Two limits, both needed** (the second was added after §6b's investigation showed the first was
not sufficient on its own):

1. a **queue cap** (`QUEUE_CAP = 2`) — the queue's job is to absorb a frame of jitter, not to
   buffer;
2. a **duty-cycle gate** (`DUTY_FACTOR = 1.5`) — after a submission the next one waits until
   1.5 × the rolling-average encode time has elapsed, so the encoder is never held 100 % busy and
   always leaves the renderer roughly a third of the wall clock. On cheap content the gate never
   binds (encode time is far below the frame interval), so ordinary recordings are unaffected.



`VideoEncoder.encode()` is a non-blocking submission. Measured main-thread cost of the extra work
per frame (`putImageData` into a reusable `OffscreenCanvas` + `new VideoFrame` + `encode`):
**0.76 ms/frame** (114 ms for 150 frames). That is affordable in `draw()`.

But the *encoder* runs at 10 fps on dense content while capture runs at 30–60. A probe feeding
dense frames at a 30 fps cadence for 20 s with **no** backpressure:

```
submitted 361 · encoded 206 · encodeQueueSize grew LINEARLY to 150 (≈ +7.5/s)
JS heap delta over the whole 20 s: 2–74 MB (noise)
```

Two conclusions:

* **The queue grows without bound** and would reach ~27 000 frames in an hour.
* **Queued `VideoFrame`s are not on the JS heap.** The heap delta stayed at noise level while 150
  frames sat queued. They live in GPU / media memory, i.e. **an unbounded queue is an invisible
  memory sink** — it would not show up in `performance.memory` and would fail in a way that is
  much harder to diagnose than today's `RangeError`.

Therefore **backpressure is mandatory**, and because the capture site (`draw()`) is synchronous
and cannot `await`, the only available policy is:

> before capturing, if `encodeQueueSize >= CAP`, **skip this frame entirely** (do not even
> `getImageData`).

That makes dropped frames a user-visible possibility on dense/large models. Mitigations chosen:

* a generous cap (**8**) — at 0.1 s/frame that is ~0.8 s of buffered work, so ordinary jitter
  never drops anything;
* timestamps derived from the **encoded** frame index, so the video always plays at the nominal
  fps and a drop shows up as a skipped generation rather than as wrong timing;
* the drop count is surfaced in the transport counter (`REC 1200f · 37 dropped`) so it is never
  silent.

This is strictly better than today, where the same throughput shortfall is not avoided — it is
*deferred* into a multi-minute frozen Stop, and the memory it costs meanwhile is what kills the
tab.

### 3.3 Interaction with the existing configuration

* **All-intra keyframing is preserved** (`{ keyFrame: true }` on every frame). Frame independence
  is the reason drops are harmless — every frame decodes standalone, so a dropped frame cannot
  corrupt its neighbours. Changing the GOP would be a *separate* decision (§6).
* **The VP9 profile 1 → profile 0 fallback is preserved**, but the probe (`isConfigSupported`,
  which is `async`) has to run *before* the first frame is submitted. Because the frame
  dimensions are only known at the first captured frame, the encoder is created **lazily on
  frame 1**; frames captured while the probe is in flight are held in a small pending array
  (typically 1–3 frames) and drained when it resolves. If the probe fails, the recorder falls
  back to today's raw buffering and the existing stop-time encode.
* **`forceFrameOpaque` stays.** The 2D canvas is cleared transparent; without opacifying, margins
  and translucent cells composite against whatever the encoder assumes.
* **GIF is unchanged.** `gifenc` needs the raw RGBA of each frame for `quantize` /
  `applyPalette`, so a GIF recording keeps buffering `ImageData` exactly as today. GIF is capped
  at 512 px and 256 colours and remains a *short-clip* format; this is now documented in Help.
  (GIF *could* be streamed too — `gif.writeFrame` appends to an internal byte buffer, so
  quantising per frame at capture time is viable — but it is out of scope here and the win is
  smaller because GIF's own byte stream is far less compact than VP9.)
* **fps is locked at record start** instead of read at Stop. The encoder needs the frame rate at
  `configure()` time. Today, changing the FPS slider mid-recording silently changes the *playback
  rate* of the whole file at Stop while the capture cadence had already varied — so locking is
  arguably more correct, not less. Worth one line in Help.
* **Pause / resume:** there is no pause control for recording today (pausing the *simulation*
  simply stops producing `stepped` messages, so no frames are captured and the video has no gap).
  Streaming behaves identically — the encoder just receives nothing.
* **Cancel:** every existing abort site (`initWorkerWithDimensions`, unmount) must call
  `cancel()` on the encoder so the `VideoEncoder` and muxer are released. Missing this leaks a
  hardware encoder session.
* **Encoder error mid-recording:** today an error surfaces at Stop. With streaming it can surface
  at any time; the recorder records it, stops accepting frames, and `finish()` rejects with it so
  Stop reports it exactly as today (and never hangs).

### 3.4 3D

The 3D path produces a fresh `ImageData` per frame and feeds the same buffer, so it streams with
no path-specific code. The only 3D-specific risk is that an uncapped drawing buffer may exceed
the encoder's maximum supported dimensions — which `isConfigSupported` reports, and which
therefore lands in the documented fallback to raw buffering. (Independently: **capping the 3D
capture resolution the way 2D is capped is the single cheapest 3D recording improvement
available** and is recommended as a follow-up, §7.)

### 3.5 Risk assessment for Tier 1

| risk | severity | mitigation |
|---|---|---|
| dropped frames on dense/large models | medium — user-visible | index-based timestamps, drop count in the UI, documented |
| the encoder starving the main thread | **high — found in testing** | root-caused to a Chrome profile-1 bug (§6b) and fixed there; the duty-cycle gate additionally bounds sustained load |
| lazy async encoder creation races the first frames | low | small pending array, drained on resolve; fall back to raw buffering on failure |
| an encoder error mid-recording | low | recorded, frames stop being accepted, surfaced at Stop |
| leaked encoder on abort | low | `cancel()` at every existing abort site |
| the `ArrayBufferTarget` 3× finalize spike | medium on huge files | documented; removed by Tier 2 |
| regressing GIF / 3D / the `willReadFrequently` discipline | low | GIF and the capture sources are untouched; the change is confined to *where the finished `ImageData` goes* |

**Verdict: low risk. Recommended and implemented.** The change is additive, confined to one new
module plus the disposition of an already-produced `ImageData`, and it degrades to today's
behaviour on any failure.

---

## 4. Tier 2 — stream to disk

`webm-muxer` 5.1.4 ships two targets for this (both confirmed present in the installed build's
`.d.ts`):

* **`StreamTarget({ onData(data, position), chunked, chunkSize })`** — callbacks as data is
  produced. **The `position` argument is load-bearing:** without `streaming: true` the muxer
  writes non-monotonically (it seeks back to patch the Segment size, duration and cues at
  finalize). A consumer that just appends chunks would silently produce a corrupt file. Passing
  `streaming: true` makes writes monotonic but **disables duration and seeking** — a file that
  plays but cannot be scrubbed, which is unacceptable for scientific review.
* **`FileSystemWritableFileStreamTarget(stream, { chunkSize })`** — a chunked `StreamTarget`
  wired to a `FileSystemWritableFileStream`, which supports `write({ type: 'write', position, data })`.
  This is the target designed for exactly this problem, and it handles the seek-back correctly.

### 4.1 (a) File System Access — `showSaveFilePicker()`

`showSaveFilePicker` requires transient user activation. **The Record button click is a user
gesture**, so the picker can legitimately open at record *start*. Availability here:
`typeof showSaveFilePicker !== 'undefined'` → **true**.

* **Pros:** no quota at all — the file is written straight to the user's chosen path, so the
  recording is bounded only by disk. Nothing is ever held in memory. The user gets the file where
  they wanted it, with no download step.
* **Cons:**
  * **Browser support is narrower than everything else GenesisCA relies on.** Chromium yes;
    **Firefox and Safari do not implement `showSaveFilePicker`.** GIF/WebM fallback logic already
    exists for WebCodecs, so a second capability gate is not new — but it is a second one.
  * **UX change:** the user must pick a destination *before* recording, which is a real change to
    the Record button's behaviour and therefore **does require an illustrated HTML mockup** under
    the repo's plan rule (§8).
  * **Crash/cancel:** if the tab dies mid-recording the file is left partially written and
    unfinalized (playable by tolerant players, not by all). Cancelling must `stream.abort()` and,
    ideally, remove the file — but a `FileSystemFileHandle` obtained from the picker can be
    `remove()`d only in newer Chromium; otherwise a zero-byte/partial file is left behind.
* **Tauri shell:** WebView2 is Chromium and recent versions implement FSA, and Tauri v2 serves the
  app from a secure-context origin — but this is **unverified** and the Tauri shell historically
  needed a native path (the existing text-only `save_text_file` Rust command). A binary streaming
  path in the Tauri shell would need a *new* Rust command (`open_write_stream` /
  `write_at(position, bytes)` / `close`) — documented here, deliberately not built.

### 4.2 (b) OPFS — origin-private file system

No gesture required, no picker; write to an origin-private file, then hand the user a download
whose `File` is disk-backed.

**Measured here:**

```
200 MB sequential write : 965 ms  → 207 MB/s
seek-back patch at pos 0: correct (file head read back as 01 02 03 04 07 07 07 07)
navigator.storage.estimate().quota : 10 GB
URL.createObjectURL(opfsFile)      : works
```

* **Pros:** works with no picker and no user decision; the seek-back the muxer needs is supported;
  207 MB/s is far above any plausible encoder output rate (dense = ~20 MB/s at 30 fps), so the
  write is never the bottleneck. Broader support than FSA (OPFS is in Chrome, Edge, Firefox and
  Safari).
* **Cons:**
  * **Quota-bound: 10 GB here** (a share of free disk, so smaller on a full drive). Better than
    the 9.3 GB raw ceiling but still finite — it moves the wall rather than removing it.
  * **The final hand-off is the open question.** `URL.createObjectURL(file)` on an OPFS `File`
    works, and Chrome's blob store is disk-backed, so an `<a download>` *should* stream from disk
    rather than materialise the file in memory. **This was not proven** — it needs a >4 GB
    recording to test conclusively, and it is the single assumption Tier 2b rests on. If it turns
    out to copy, OPFS buys nothing over Tier 1 at the moment of download.
  * **Orphaned files:** a crash or a cancel leaves the OPFS file behind, silently consuming the
    origin's quota. A sweep of stale `*.webm` entries at simulator start-up is required.

### 4.3 Recommendation between (a) and (b)

**Prefer (a) File System Access, with (b) OPFS as the fallback where FSA is unavailable and
Tier 1 as the fallback where neither is.** (a) is the only option that is genuinely unbounded and
the only one with no hand-off question; (b)'s quota and unproven download path make it a
mitigation rather than a solution. Both share the same `webm-muxer` target abstraction, so the
recorder built for Tier 1 accepts either by swapping the target — which is why Tier 1 is the
right first step regardless of which Tier 2 variant ships.

---

## 5. Alternatives considered and rejected

**`MediaRecorder` + `canvas.captureStream()`.** The obvious "the browser does it for you"
answer, and it streams natively. Rejected:

* **It samples on the compositor's clock, not on simulation steps.** GenesisCA's contract is one
  captured frame per *displayed* frame; `captureStream` produces frames when the canvas is
  painted and the compositor runs, dropping or duplicating to hit the requested rate. A recording
  would no longer correspond 1:1 to the run.
* **No per-frame control** — no `keyFrame` flag, so the deliberate all-intra choice (documented
  in `webmEncoder.ts`: interframe prediction bleeds across previously-stable regions on CA
  content) is unavailable, and the bitrate is VBR-ish with no `contentHint: 'text'`.
* **It cannot serve the `simulation` scope at all.** That scope is not a canvas that is on screen
  — `renderSimulationFrame` composites it on demand into an offscreen. `captureStream` only
  observes a real canvas's paints.
* It would also not help the 3D path, which reads a WebGL buffer explicitly.

**Encode in a Web Worker.** `VideoEncoder` is available in workers, and `ImageData`'s buffer is
transferable, so the 0.76 ms/frame of main-thread submission could be moved off-thread.
Rejected *for now*: 0.76 ms/frame is not a measured problem (the 100 ms/frame is already
off-thread inside the encoder), and it would mean either complicating the sim worker or adding a
third worker plus a message hop. Worth revisiting only if profiling ever shows the submission
cost mattering.

**Do nothing, document the limits.** Rejected: the limits are ~1–2 minutes for 2D and **under
15 seconds for 3D on a HiDPI display**, and the failure mode is an uncaught `RangeError` that
stops the simulator repainting rather than a message. That is not a documentable behaviour, it is
a bug.

---

## 6. The other lever: the encoder configuration

Measured on the same 150 dense Kelp War frames (898×821), varying one thing at a time:

| configuration | encoded | ratio | KB/frame | encoder fps |
|---|---|---|---|---|
| **current** — VP9 p1 4:4:4, all-intra, quality, 132 Mbps | 96.9 MB | 4.4× | 661 | 10.0 |
| VP9 p0 4:2:0, all-intra, quality | 83.1 MB | 5.1× | 567 | 13.6 |
| VP9 p1 4:4:4, all-intra, **realtime** latency | 96.9 MB | 4.4× | 661 | 9.8 |
| VP9 p1 4:4:4, **GOP = 30** (delta frames) | 27.3 MB | 15.4× | 187 | 18.4 |
| VP9 p1 4:4:4, all-intra, **40 Mbps** | 30.9 MB | 13.7× | 211 | 14.0 |

Reading:

* The encoder is **bitrate-saturated** on dense content: 661 KB × 30 fps ≈ 158 Mbps against a
  132 Mbps CBR target. Lowering the target to 40 Mbps gives **3.1× smaller files and 1.4× faster
  encoding** — at some (unmeasured) quality cost.
* **GOP = 30 gives 3.5× smaller and 1.8× faster.** That is the largest single lever measured. It
  trades away the documented all-intra property, which exists for a real reason on CA content and
  which also makes dropped frames harmless.
* `latencyMode: 'realtime'` does nothing measurable here — no reason to change it.

**Recommendation: expose a quality choice** (e.g. *Archival* = today's all-intra 132 Mbps,
*Balanced* = all-intra ~40 Mbps, *Long recording* = GOP 30 at ~40 Mbps) rather than silently
changing the current behaviour. This is a **user-visible change and would need an illustrated
mockup**; it is deliberately *not* part of the Tier 1 implementation, which preserves today's
output configuration exactly.

---

## 6b. A pre-existing Chrome bug the implementation surfaced (fixed)

Implementing Tier 1 exposed a **latent defect in the shipped recorder**, unrelated to streaming:

> **Chrome's software VP9 profile 1 (4:4:4) encoder freezes the renderer at a coded width of
> 960** — the exact width GenesisCA's capture cap produces.

Isolated with a standalone probe — no app, no simulation, no WebGPU, just `VideoEncoder` plus a
50 ms heartbeat — encoding six frames of a synthetic gradient:

| size | pixels | profile | result |
|---|---|---|---|
| 898 × 821 | 737 k | 1 (4:4:4) | fine (many real recordings) |
| 900 × 900 | 810 k | 1 (4:4:4) | **fine** — 124 ms/frame, 13 ms worst main-thread gap |
| **960 × 540** | **518 k** | 1 (4:4:4) | **FREEZE** after 1 frame — *the fewest pixels of any case* |
| **960 × 960** | 922 k | 1 (4:4:4) | **FREEZE** after 1–2 frames; 1 chunk in 60 s |
| 960 × 960 | 922 k | 0 (4:2:0) | **fine** — 124 ms/frame, 12 ms worst gap |

Three things make this serious:

* **It is width-driven, not size-driven.** 960 × 540 has fewer pixels than the perfectly healthy
  900 × 900 and still freezes; the identical 960 × 960 workload on profile 0 is fine. Lowering
  the bitrate from 337 Mbps to 40 Mbps did **not** help either — so neither total work nor
  bitrate is the trigger.
* **`isConfigSupported` reports it as `supported: true`,** so the existing preference order picks
  it happily.
* **960 is exactly `RECORD_MAX` and exactly `renderSimulationFrame(960, …)`,** so the default
  simulation scope lands on width 960 for any roughly-square or landscape grid. **The buffered
  encoder hits this too** — it submits every frame in a tight loop at Stop, so pressing Stop on
  such a recording today freezes the page for the whole recording at once. Streaming did not
  create the bug; it just made it visible in the first second instead of at the end.

**Fix (in the shared `pickVp9Config`, so it repairs both paths):** profile 1 is only offered
below `VP9_444_MAX_WIDTH = 960`; at or above it the picker starts at profile 0, which was
measured to handle the identical workload at 124 ms/frame with the main thread untouched. The
cost is 4:2:0 chroma subsampling on frames that currently hang the browser.

**Verified after the fix:** Gray-Scott at the 960 × 960 simulation scope now selects
`vp09.00.10.08`, records 59 frames with a **136 ms** worst main-thread gap (vs. *frozen after
100 ms* before, and vs. 121 ms for the buffered control on the same model and scope) and
downloads a valid file; Kelp War at 898 × 821 still selects `vp09.01.10.08.03` with a 120 ms
worst gap — no regression for the sizes that were healthy.

The threshold is an empirical lower bound on a failure region this investigation did not fully
characterise. Two follow-ups worth having: check whether the freeze reproduces on other machines
and Chrome versions (it may be a libvpx tiling/threading path specific to widths that are large
multiples of 64), and consider filing it upstream.

---

## 7. Recommendation and phased plan

**Phase 1 — Tier 1, encode-as-you-go (implemented in this branch).**
New `src/simulator/recording/webmStreamEncoder.ts` (a `WebMStreamEncoder` class:
`create(w,h,fps)` / `addFrame(ImageData) → boolean` / `finish() → Blob` / `cancel()` /
`dropped` / `encoded` / `bufferedBytes` / `error`), plus four seams in
[SimulatorView.tsx](../src/simulator/SimulatorView.tsx):

1. `startRecording` — reset the streaming state alongside the existing raw state.
2. the capture block (~L4596) — where the finished `ImageData` is disposed of: hand it to the
   stream encoder if one is live, create the encoder lazily on the first frame, otherwise push to
   `recordedFrames` exactly as today.
3. `stopRecording` — `await enc.finish()` → download, else today's path unchanged.
4. every abort site (`initWorkerWithDimensions`, the unmount cleanup) — `cancel()`.

No behaviour change for GIF, for the 3D capture source, for the `willReadFrequently` discipline,
or for the muxer/output configuration.

**Phase 2 — cap the 3D capture resolution** (apply the 2D `RECORD_MAX` rule to
`capture3dPixels` / `readPixels`, and avoid the double allocation in `readPixels`). Small,
self-contained, removes the worst per-frame cost in the codebase. Arguably the highest
value-per-line item in this whole document. Needs a mockup only if the cap is user-facing;
as an internal cap matching 2D it is exempt.

**Phase 3 — a recording quality selector** (§6). Needs a mockup.

**Phase 4 — Tier 2, stream to disk.** `showSaveFilePicker` at record start with an OPFS
fallback, swapping the muxer target. Needs a mockup (new flow at record start), an OPFS orphan
sweep, and a decision on the Tauri shell (a new binary-streaming Rust command, or accept Tier 1
there).

**On the illustrated-plan rule:** Phase 1 is exempt — it is a pure-internal pipeline change with
identical user-visible behaviour, the one exception being the drop counter, which is an addition
to an existing readout rather than a new flow. Phases 3 and 4 are **not** exempt: a quality
selector and a file-picker-at-record-start are new UI and new behaviour, and each needs a
self-contained HTML mockup alongside its plan at implementation time.

---

## 8. Open questions for the user

1. **Is dropping frames acceptable** on dense/large models when the encoder cannot keep up, given
   the alternative today is an OOM? The current implementation drops and reports; the other
   option is to slow the *simulation* to the encoder's rate, which changes what "60 fps" means.
2. **Quality vs. length.** §6 shows 3–3.5× smaller files are one setting away. Is the all-intra,
   near-lossless default the right archival default, with a "long recording" mode alongside — or
   should the default itself move?
3. **Tier 2 destination.** File System Access (unbounded, Chromium-only, picker at record start)
   or OPFS (no picker, 10 GB quota, download hand-off unproven)? Or both, with FSA preferred?
4. **The Tauri shell** currently has only a text-only `save_text_file` command. Is a binary
   streaming command worth adding, or should the native shell simply keep Tier 1?
5. **3D capture resolution.** Capping it (matching 2D) changes the resolution of existing 3D
   recordings. Cap it, make it a setting, or leave it uncapped and merely documented? Note the
   2D cap is currently 960 — the exact width that trips the Chrome bug in §6b — so if a 3D cap is
   added it should not be 960 either.
6. **The Chrome VP9 profile-1 freeze (§6b)** — worth reproducing on your machines and filing
   upstream? And is `VP9_444_MAX_WIDTH = 960` the right conservative line, or should GenesisCA
   simply move `RECORD_MAX` off 960 so profile 1 stays available at the default scope?
