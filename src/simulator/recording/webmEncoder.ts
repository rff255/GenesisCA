import { Muxer, ArrayBufferTarget } from 'webm-muxer';

/**
 * The one place the VP9 encoder configuration is decided. BOTH the buffered
 * encoder below and the streaming encoder ([webmStreamEncoder.ts](./webmStreamEncoder.ts))
 * call this, so a streamed recording is configured byte-for-byte like a buffered
 * one — the only difference between the two paths is WHEN frames are submitted.
 *
 * CA grids have sharp pixel boundaries that DCT-based codecs handle poorly.
 * To keep the output visually lossless we pick the best available config in
 * this order:
 *   1. VP9 profile 1 with 4:4:4 chroma — no chroma subsampling, so per-cell
 *      colours stay crisp. Quality-mode latency, very high bitrate.
 *   2. VP9 profile 0 (4:2:0) — universal fallback. Same high bitrate. The
 *      4:2:0 colour subsampling can blur 1-pixel colour transitions on small
 *      grids, but it's still far better than the GIF path.
 *
 * Throws if `VideoEncoder` is unavailable or the browser rejects every attempt.
 */
export type Vp9Choice = { codec: string; muxerCodec: string; label: string; bitrate: number; fps: number };

/**
 * Recording quality mode — the ONLY thing it changes is the keyframe cadence.
 *
 *  - `standard` (DEFAULT): a keyframe every `GOP_STANDARD` frames. MEASURED on
 *    150 dense Kelp War frames: **3.5x smaller and 1.8x faster to encode** than
 *    all-intra at the same bitrate — the largest single lever available, and the
 *    reason it is now the default (docs/INVESTIGATION_STREAMING_RECORDING.md §6).
 *    A player must decode from the last keyframe, so scrubbing lands on 30-frame
 *    boundaries.
 *  - `archival`: every frame a keyframe (the historical behaviour). Frames stay
 *    independently decodable — frame-by-frame analysis, scrub-exact, and no
 *    interframe prediction bleeding across previously-stable regions, which on
 *    CA content (a 1-cell change in an otherwise static field) is a real effect.
 *
 * NB a DROPPED frame is harmless under BOTH modes: a drop happens before
 * submission, so the encoder only ever sees the frames it was given, in order,
 * and codes each delta against the previously SUBMITTED frame. Nothing can
 * reference a frame that was never encoded — the sequence is shortened, not
 * corrupted (verified by a VideoDecoder round-trip on a with-drops GOP-30 file).
 */
export type RecordQuality = 'standard' | 'archival';
export const DEFAULT_RECORD_QUALITY: RecordQuality = 'standard';
/** Keyframe interval for `standard`. 30 is what §6's measurement used. */
export const GOP_STANDARD = 30;
/** Frames between keyframes for a quality mode (1 = all-intra). */
export function keyFrameIntervalFor(q: RecordQuality): number {
  return q === 'archival' ? 1 : GOP_STANDARD;
}

/** VP9 codes width in 8-pixel units, so this is the width libvpx actually sees. */
export function vp9CodedWidth(w: number): number {
  return Math.ceil(w / 8) * 8;
}

/**
 * Upper bound on the NOMINAL frame rate a recording may declare.
 *
 * The caller passes the simulator's FPS *slider*, and that slider has an
 * "unlimited" position which resolves to the sentinel **999999** — a value that
 * is not a frame rate at all. Unclamped it reached BOTH derived quantities and
 * broke each of them outright:
 *   - `bitrate = w x h x fps x 6` became **4.4 Tbit/s** at 912x804, which
 *     collapsed the encoder's rate control (measured: 71 frames in 0.13 MB,
 *     vs 9.3 MB for the same content at a finite fps), and
 *   - the fallback timing base `1e6 / fps` became **1 microsecond**, so the
 *     whole file's blocks landed inside ~70 us and `<video>` reported
 *     `duration = NaN` — an unplayable file.
 *
 * 120 rather than 60 so a genuinely high-refresh capture is not retimed; every
 * realistic capture rate is far below it. Below 1 fps is equally meaningless
 * (a zero or negative slider would divide by zero), so both ends are clamped.
 */
export const MAX_RECORD_FPS = 120;

/** Clamp an arbitrary caller-supplied frame rate into a usable one. The ONE
 *  place both encoders (and the GIF delay) sanitise the FPS slider. */
export function clampRecordFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 30;
  return Math.min(MAX_RECORD_FPS, Math.max(1, fps));
}

/**
 * Is VP9 profile 1 (4:4:4) SAFE at this frame width?
 *
 * MEASURED Chrome bug (Chrome 148, Windows), not a GenesisCA limitation. This
 * REPLACED a `VP9_444_MAX_WIDTH = 960` max-width guard, which was the wrong
 * SHAPE: a bisect of the original 900-OK / 960-FREEZE bracket showed the failure
 * tracks the CODED WIDTH MODULO 32, not its magnitude — so widths far below 960
 * (640! 864! 896!) froze under the old guard. 13 standalone measurements (no
 * app, no simulation, no WebGPU — just VideoEncoder plus a 50 ms heartbeat),
 * zero contradictions:
 *
 *   | w x h     | coded w | %32 | verdict | 6 frames  | heartbeats | max main gap |
 *   |-----------|---------|-----|---------|-----------|------------|--------------|
 *   |  640x640  |   640   |  0  | FREEZE  | 1 of 6/25s|      2     |      -       |
 *   |  864x864  |   864   |  0  | FREEZE  | 1 of 6/25s|      3     |      -       |
 *   |  880x880  |   880   | 16  | FAST    |   274 ms  |    648     |    69 ms     |
 *   |  896x896  |   896   |  0  | FREEZE  | 1 of 6/25s|      3     |      -       |
 *   |  900x900  |   904   |  8  | slow    |  4863 ms  |      8     |   1008 ms    |
 *   |  912x912  |   912   | 16  | FAST    |   322 ms  |    679     |    71 ms     |
 *   |  912x928  |   912   | 16  | FAST    |   313 ms  |    686     |    71 ms     |
 *   |  914x914  |   920   | 24  | slow    |  4686 ms  |     36     |   1010 ms    |
 *   |  920x920  |   920   | 24  | slow    |  5058 ms  |     67     |   1055 ms    |
 *   |  921x921  |   928   |  0  | FREEZE  | 1 of 6/25s|      0     |      -       |
 *   |  928x928  |   928   |  0  | FREEZE  | 1 of 6/25s|      0     |      -       |
 *   |  928x540  |   928   |  0  | FREEZE  | 1 of 6/25s|      3     |      -       |
 *   |  960x960  |   960   |  0  | FREEZE  | >150 s     |     0     |      -       |
 *   | 1280x720 profile 0  |  0  | FAST    |   192 ms  |    903     |    70 ms     |
 *
 * Three regimes, by coded width mod 32:
 *   0        -> FREEZE: the renderer is starved indefinitely and does NOT recover
 *               (960x960 held for >150 s; only navigating away released it), and
 *               `isConfigSupported` cheerfully reports `supported: true`.
 *   16       -> FAST: ~50 ms/frame with the main thread responsive.
 *   8 or 24  -> SLOW: ~800 ms/frame with ~1 s main-thread stalls — a regime the
 *               original investigation never saw, because it only sampled 900/960.
 *
 * WIDTH-DRIVEN, confirmed twice: 928x540 (501k px) freezes while 920x920 (846k px)
 * does not, and 912x**928** — a bad number in the HEIGHT — is fast.
 *
 * So this returns true only for the ONE measured-fast residue: merely avoiding
 * the frozen class would leave half of all widths at 800 ms/frame, which is the
 * same user-visible harm in slower motion. Everything else falls back to
 * profile 0, which is IMMUNE (1280x720, the worst residue, was the fastest
 * configuration measured); the cost is 4:2:0 chroma subsampling instead of a
 * hung browser.
 *
 * The rule is inferred from one machine and one Chrome build and the cause
 * (likely a libvpx tile/threading path) is unknown, so a different core count
 * could shift it. The mitigation is that GenesisCA controls its own capture
 * widths (RECORD_MAX / snapRecordWidth below) and the fallback is safe at the
 * worst residue — anything unexpected degrades to 4:2:0, never to a freeze.
 */
export function isVp9Profile1Safe(w: number): boolean {
  return vp9CodedWidth(w) % 32 === 16;
}

/**
 * Long-edge cap for 2D recording capture.
 *
 * 912 rather than the historical 960 BECAUSE OF `isVp9Profile1Safe`: 912 is in
 * the measured-FAST residue class (912 % 32 === 16) while 960 is in the FROZEN
 * one, so today's default silently records in 4:2:0 — whose chroma subsampling
 * bleeds exactly the 1-pixel colour transitions CA output is made of. 5% less
 * linear resolution buys full-resolution chroma and a 15x faster encoder.
 *
 * In residue space `=== 16` is the MAXIMUM possible distance from the frozen
 * class (16 coded pixels either side), and capture widths are snapped to exact
 * multiples of 8, so rounding cannot drift across. That is a stronger guarantee
 * than a linear margin — the failure is not linear in width.
 */
export const RECORD_MAX = 912;

/**
 * Long-edge cap for 3D recording capture.
 *
 * 3D `readPixels` returns the WHOLE WebGL drawing buffer (`cssW*dpr x cssH*dpr`)
 * with no cap — measured 23 MB/frame at DPR 2 and 33 MB at 4K, the largest
 * per-frame cost in the codebase, while the 2D paths have been capped all along.
 *
 * Deliberately NOT 912: 1280 keeps far more 3D detail, and 1280 % 32 === 0 means
 * the guard routes it to profile 0 — which is the fastest configuration measured
 * (32 ms/frame at 1280x720). So **3D records in 4:2:0**, which is the right trade:
 * the alternative at this size is a frozen renderer. Screenshots are unaffected
 * (they keep full display resolution).
 */
export const RECORD_MAX_3D = 1280;

/**
 * Lower `w` to the largest width whose CODED width is in the profile-1 FAST
 * residue class, so an arbitrary capture size (a portrait canvas, a tall grid)
 * still gets 4:4:4 instead of falling back to 4:2:0.
 *
 * Only engages above 320 px: below that the ≤31 px reduction would be a large
 * relative change, and small frames are cheap to encode anyway (the guard simply
 * sends them to profile 0). Callers must derive the height from the SAME scale
 * so the aspect ratio is preserved exactly.
 */
export function snapRecordWidth(w: number): number {
  if (!Number.isFinite(w) || w <= 320) return Math.max(1, Math.round(w));
  const v = Math.floor((Math.floor(w) - 16) / 32) * 32 + 16;
  return v >= 16 && v <= w ? v : Math.round(w);
}

export async function pickVp9Config(w: number, h: number, fps: number): Promise<Vp9Choice> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('WebCodecs VideoEncoder is not supported in this browser.');
  }
  // The caller hands us the FPS *slider*, whose "unlimited" position is a
  // 999999 sentinel — see `clampRecordFps` for what that did to the bitrate
  // and to the frame timing before it was clamped.
  const safeFps = clampRecordFps(fps);
  // Pick a near-lossless bitrate. RGB at 8 bpp × pixels × fps is the raw
  // upper bound; VP9 with intra-heavy keyframing reaches visually lossless
  // around 4-6 bpp × fps for sharp content. We target 6 bpp × fps with a
  // 4 Mbps floor so tiny grids still get headroom.
  const bitrate = Math.max(4_000_000, Math.round(w * h * safeFps * 6));

  // The chroma_subsampling field is the 5th dot-segment of the codec string
  // (0=4:2:0v, 1=4:2:0col, 2=4:2:2, 3=4:4:4). Browser support for VP9 profile 1
  // + 4:4:4 in WebCodecs is uneven — Chrome accepts it on most platforms; if it
  // doesn't we fall back to profile 0.
  const attempts = [
    // Offered ONLY in the measured-fast coded-width residue — see
    // `isVp9Profile1Safe`: elsewhere profile 1 does not merely perform poorly,
    // it either freezes the renderer outright or runs at ~800 ms/frame.
    ...(isVp9Profile1Safe(w)
      ? [{ codec: 'vp09.01.10.08.03', muxerCodec: 'V_VP9', label: 'VP9 profile 1 (4:4:4)' }]
      : []),
    { codec: 'vp09.00.10.08', muxerCodec: 'V_VP9', label: 'VP9 profile 0 (4:2:0)' },
  ];
  let configError: Error | null = null;
  for (const attempt of attempts) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: attempt.codec,
        width: w,
        height: h,
        bitrate,
        framerate: safeFps,
        latencyMode: 'quality',
      });
      if (support.supported) return { ...attempt, bitrate, fps: safeFps };
    } catch (err) {
      configError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new Error(
    `No supported VP9 configuration in this browser${configError ? `: ${configError.message}` : ''}`
  );
}

/** The encoder config every GenesisCA recording uses, derived from a `Vp9Choice`. */
export function vp9EncoderConfig(choice: Vp9Choice, w: number, h: number): VideoEncoderConfig {
  return {
    codec: choice.codec,
    width: w,
    height: h,
    bitrate: choice.bitrate,
    framerate: choice.fps,
    bitrateMode: 'constant',
    latencyMode: 'quality',
    // 'text' tells the encoder the source is sharp/synthetic content (UI,
    // pixel art) rather than a noisy camera feed — Chrome's encoder uses
    // smaller block sizes and finer rate control on such content.
    contentHint: 'text',
  };
}

/**
 * Encode a sequence of ImageData frames to a WebM blob (VP9, video-only,
 * no scaling). The output dimensions match `frames[0].width` × `frames[0].height`.
 *
 * Caller must check `isWebMSupported()` first — this function throws if
 * `VideoEncoder` is unavailable or if the browser rejects every VP9 codec
 * configuration we try.
 *
 * CA grids have sharp pixel boundaries that DCT-based codecs handle poorly.
 * To keep the output visually lossless we pick the best available config in
 * this order:
 *   1. VP9 profile 1 with 4:4:4 chroma — no chroma subsampling, so per-cell
 *      colours stay crisp. Quality-mode latency, very high bitrate.
 *   2. VP9 profile 0 (4:2:0) — universal fallback. Same high bitrate. The
 *      4:2:0 colour subsampling can blur 1-pixel colour transitions on small
 *      grids, but it's still far better than the GIF path.
 */
export async function encodeFramesToWebM(
  frames: ImageData[],
  fps: number,
  quality: RecordQuality = DEFAULT_RECORD_QUALITY,
  /** Wall-clock capture time (ms, `performance.now()`) of each frame, parallel
   *  to `frames`. When supplied the file is timed from these instead of from
   *  the nominal fps, so it plays back at the speed it was captured — see
   *  `WebMStreamEncoder.addFrame` for why that matters. */
  captureTimesMs?: number[],
): Promise<Blob> {
  if (frames.length === 0) throw new Error('No frames to encode');
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('WebCodecs VideoEncoder is not supported in this browser.');
  }

  const w = frames[0]!.width;
  const h = frames[0]!.height;
  const chosen = await pickVp9Config(w, h, fps);
  const safeFps = chosen.fps;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: chosen.muxerCodec,
      width: w,
      height: h,
      frameRate: safeFps,
    },
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => { encoderError = err instanceof Error ? err : new Error(String(err)); },
  });

  encoder.configure(vp9EncoderConfig(chosen, w, h));

  // Reuse a single OffscreenCanvas across frames; constructing a fresh canvas
  // per frame would balloon GPU memory on large recordings.
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : (() => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
      })();
  const ctx = (canvas as OffscreenCanvas | HTMLCanvasElement).getContext('2d') as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not acquire 2D context for WebM encode canvas');

  const microsPerFrame = 1_000_000 / safeFps;
  // The keyframe cadence is the ONE thing the quality mode changes, and it is
  // read from the SAME shared helper the streaming encoder uses — so a buffered
  // file and a streamed one are configured identically in every respect.
  const gop = keyFrameIntervalFor(quality);
  const useRealTimes = !!captureTimesMs && captureTimesMs.length === frames.length;
  const baseMs = useRealTimes ? captureTimesMs![0]! : 0;
  let emitted = 0;
  let lastTs = -1;
  for (let i = 0; i < frames.length; i++) {
    if (encoderError) break;
    const frame = frames[i]!;
    // Defensive: skip frames that don't match the leader's dimensions.
    if (frame.width !== w || frame.height !== h) continue;
    ctx.putImageData(frame, 0, 0);
    // Real capture times when we have them (so the file lasts as long as the
    // recording did), else the historical constant-rate fallback. `VideoEncoder`
    // requires strictly increasing timestamps, hence the max().
    const timestamp = useRealTimes
      ? Math.max(lastTs + 1, Math.round((captureTimesMs![i]! - baseMs) * 1000))
      : Math.round(emitted * microsPerFrame);
    const duration = useRealTimes && lastTs >= 0
      ? Math.max(1, timestamp - lastTs)
      : Math.round(microsPerFrame);
    lastTs = timestamp;
    const videoFrame = new VideoFrame(canvas as CanvasImageSource, { timestamp, duration });
    // `archival` forces every frame to be a keyframe: on CA models even a 1-cell
    // change can confuse interframe prediction enough to bleed across
    // previously-stable regions, and independent frames make per-frame analysis
    // (and any dropped frame) trivially safe. `standard` keyframes every GOP for
    // a 3.5x smaller, 1.8x faster encode.
    encoder.encode(videoFrame, { keyFrame: emitted % gop === 0 });
    videoFrame.close();
    emitted++;
  }

  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;
  muxer.finalize();

  const { buffer } = muxer.target;
  return new Blob([buffer], { type: 'video/webm' });
}

export function isWebMSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}
