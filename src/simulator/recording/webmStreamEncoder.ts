import { Muxer, ArrayBufferTarget } from 'webm-muxer';
import { pickVp9Config, vp9EncoderConfig, type Vp9Choice } from './webmEncoder';

/**
 * Streaming (encode-as-you-go) WebM recorder.
 *
 * The buffered sibling ([webmEncoder.ts](./webmEncoder.ts) `encodeFramesToWebM`)
 * keeps every captured frame as raw RGBA and encodes the whole array at Stop.
 * That costs 2.9-33 MB PER FRAME (see docs/INVESTIGATION_STREAMING_RECORDING.md
 * for the measurements) and OOMs after roughly a minute of 2D — or under 15 s of
 * 3D on a HiDPI display. This class instead hands each frame to the
 * `VideoEncoder` the moment it is captured, so only the COMPRESSED bytes
 * accumulate: measured 5.3 KB/frame on a sparse Game of Life (541x) and
 * 661 KB/frame on a dense Kelp War (4.4x) — content-dependent, but never worse
 * than the raw frame it replaces. Stop becomes a flush instead of a multi-minute
 * freeze.
 *
 * The muxer path is IDENTICAL to the buffered encoder: `addVideoChunk` was
 * already called from the encoder's `output` callback there, so muxing was
 * always incremental. The only thing that changes is WHEN frames are submitted.
 * The encoder configuration comes from the shared `pickVp9Config` /
 * `vp9EncoderConfig`, so a streamed file is configured byte-for-byte like a
 * buffered one (VP9 profile 1 4:4:4 -> profile 0 fallback, all-intra, the same
 * bitrate rule).
 *
 * BACKPRESSURE (the one genuinely new hazard). `encode()` is a non-blocking
 * submission; the encoder itself runs at ~10 fps on dense 900x800 content while
 * capture runs at 30-60. Measured: with no backpressure the queue grows LINEARLY
 * and forever (+7.5 frames/s), and queued `VideoFrame`s do NOT live on the JS
 * heap (GPU/media memory) — so an unbounded queue is an INVISIBLE memory sink,
 * strictly harder to diagnose than today's `RangeError`. The capture site is
 * synchronous (`draw()`) and cannot await, so the only available policy is to
 * DROP: `addFrame` returns false when the queue is full and the caller simply
 * skips that frame. Because every frame is a keyframe, a dropped frame cannot
 * corrupt its neighbours; and because timestamps are derived from the ENCODED
 * frame index, the file always plays at the nominal fps (a drop reads as a
 * skipped generation, not as wrong timing). The caller surfaces the drop count.
 */
export class WebMStreamEncoder {
  /** Max frames allowed to sit in the encoder queue before we start dropping.
   *
   *  DELIBERATELY TINY. The queue's only job is to absorb a frame of jitter — it
   *  is NOT a buffer. A deep queue is actively harmful: queued `VideoFrame`s are
   *  invisible memory (they do not live on the JS heap), and letting the encoder
   *  chew on many expensive frames at once starves the renderer. */
  static readonly QUEUE_CAP = 2;

  /** DUTY-CYCLE GATE — the reason a streaming recording cannot lock up the page.
   *
   *  Chrome's software VP9 encoder is multi-threaded and, at the near-lossless
   *  all-intra settings GenesisCA uses, ONE large frame can cost hundreds of
   *  milliseconds of every core. If frames are submitted as fast as the encoder
   *  drains them, it stays 100 % busy and the main thread is starved — measured
   *  on a 960x960 simulation-scope recording, the page went unresponsive for
   *  tens of seconds while the buffered path on the very same model/scope stayed
   *  at a 121 ms worst-case main-thread gap. Queue depth alone does NOT fix that
   *  (a cap of 2 still jammed): what matters is that the encoder is never given
   *  a moment off.
   *
   *  So the encoder is held to a duty cycle: after a submission, the next one
   *  waits until `DUTY_FACTOR x` the rolling-average encode time has elapsed,
   *  leaving roughly a third of the wall clock free for the renderer. On cheap
   *  content (encode time far below the frame interval) the gate never binds, so
   *  ordinary recordings are unaffected; on expensive content it trades frames —
   *  which the machine could not have encoded in real time anyway — for a page
   *  that stays usable. Dropped frames are counted and surfaced. */
  static readonly DUTY_FACTOR = 1.5;

  private readonly muxer: Muxer<ArrayBufferTarget>;
  private readonly encoder: VideoEncoder;
  private readonly microsPerFrame: number;
  /** Canvas round-trip fallback, built only if the direct RGBA buffer path is
   *  unavailable. See `addFrame` for why the buffer path is strongly preferred. */
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  private encodedIndex = 0;
  private droppedFrames = 0;
  private chunkBytes = 0;
  private encoderError: Error | null = null;
  private finished = false;
  private cancelled = false;
  /** Submit timestamps of frames still in the encoder, oldest first. Chunks come
   *  out in submission order, so a FIFO gives each frame's true encode latency. */
  private readonly inFlight: number[] = [];
  private avgEncodeMs = 0;
  private lastSubmitAt = 0;

  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly codecLabel: string;

  private constructor(w: number, h: number, choice: Vp9Choice) {
    this.width = w;
    this.height = h;
    this.fps = choice.fps;
    this.codecLabel = choice.label;
    this.microsPerFrame = 1_000_000 / choice.fps;

    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: choice.muxerCodec, width: w, height: h, frameRate: choice.fps },
    });

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.chunkBytes += chunk.byteLength;
        const submittedAt = this.inFlight.shift();
        if (submittedAt !== undefined) {
          const took = performance.now() - submittedAt;
          // EMA, seeded by the first sample so the gate reacts immediately.
          this.avgEncodeMs = this.avgEncodeMs === 0 ? took : this.avgEncodeMs * 0.7 + took * 0.3;
        }
        // Guard: a chunk can still arrive after cancel() closed the encoder in
        // some implementations; muxing into a finalized muxer would throw.
        if (!this.cancelled) this.muxer.addVideoChunk(chunk, meta);
      },
      error: (err) => {
        this.encoderError = err instanceof Error ? err : new Error(String(err));
      },
    });
    this.encoder.configure(vp9EncoderConfig(choice, w, h));

  }

  /** Build a VideoFrame from the captured pixels.
   *
   *  PREFERRED: the direct RGBA BufferInit constructor — a pure CPU copy of the
   *  ImageData we already hold. The obvious alternative (putImageData into an
   *  OffscreenCanvas, then `new VideoFrame(canvas)`) round-trips every frame
   *  through the GPU: putImageData uploads and the VideoFrame snapshot reads
   *  back, synchronously, on the main thread. That is cheap in isolation but
   *  contends badly with a WebGPU model that is already driving the GPU hard —
   *  measured, a 960x960 simulation-scope recording of a WebGPU model froze the
   *  page within ~150 ms, i.e. within the first two frames and long before any
   *  queue or duty-cycle limit could engage. The buffer path touches no GPU.
   *  The canvas path is kept only as a fallback for engines without BufferInit. */
  private makeVideoFrame(frame: ImageData, timestamp: number, duration: number): VideoFrame {
    if (WebMStreamEncoder.bufferInitOk !== false) {
      try {
        const vf = new VideoFrame(frame.data, {
          format: 'RGBA',
          codedWidth: this.width,
          codedHeight: this.height,
          timestamp,
          duration,
        });
        WebMStreamEncoder.bufferInitOk = true;
        return vf;
      } catch {
        WebMStreamEncoder.bufferInitOk = false;
      }
    }
    if (!this.ctx) {
      // Reuse a single canvas across frames; a fresh one per frame would
      // balloon GPU memory on long recordings.
      this.canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(this.width, this.height)
        : (() => { const c = document.createElement('canvas'); c.width = this.width; c.height = this.height; return c; })();
      this.ctx = (this.canvas as OffscreenCanvas | HTMLCanvasElement).getContext('2d') as
        OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
      if (!this.ctx) throw new Error('Could not acquire 2D context for the streaming WebM encode canvas');
    }
    this.ctx.putImageData(frame, 0, 0);
    return new VideoFrame(this.canvas as CanvasImageSource, { timestamp, duration });
  }

  /** Whether `new VideoFrame(buffer, { format: 'RGBA', … })` works here.
   *  Probed once on the first frame; null = not yet probed. */
  private static bufferInitOk: boolean | null = null;

  /**
   * Probe the browser for a usable VP9 configuration and build the encoder.
   * `isConfigSupported` is async, so the caller must be prepared to hold the
   * first frame or two while this resolves. Rejects if no configuration is
   * supported — the caller should then fall back to buffered recording.
   */
  static async create(width: number, height: number, fps: number): Promise<WebMStreamEncoder> {
    const choice = await pickVp9Config(width, height, fps);
    return new WebMStreamEncoder(width, height, choice);
  }

  /** Frames actually handed to the encoder. */
  get encodedCount(): number { return this.encodedIndex; }
  /** Frames refused because the encoder queue was full (or it had errored). */
  get droppedCount(): number { return this.droppedFrames; }
  /** Compressed bytes produced so far — the real memory cost of the recording. */
  get bufferedBytes(): number { return this.chunkBytes; }
  /** Non-null once the encoder has reported an error; the recorder is then dead. */
  get error(): Error | null { return this.encoderError; }

  /**
   * Submit one captured frame. Returns false if the frame was DROPPED (queue
   * full, encoder errored, or the recorder is already finished/cancelled) —
   * the caller should count it, not retry it.
   *
   * Frames whose dimensions differ from the configured ones are refused: the
   * encoder is fixed-size, and the caller already locks dimensions on the first
   * captured frame.
   */
  addFrame(frame: ImageData): boolean {
    if (this.finished || this.cancelled || this.encoderError) { this.droppedFrames++; return false; }
    if (frame.width !== this.width || frame.height !== this.height) { this.droppedFrames++; return false; }
    if (this.encoder.encodeQueueSize >= WebMStreamEncoder.QUEUE_CAP) { this.droppedFrames++; return false; }
    const now = performance.now();
    // Duty-cycle gate (see DUTY_FACTOR): never keep the encoder 100 % busy.
    if (this.avgEncodeMs > 0 && now - this.lastSubmitAt < this.avgEncodeMs * WebMStreamEncoder.DUTY_FACTOR) {
      this.droppedFrames++;
      return false;
    }
    const videoFrame = this.makeVideoFrame(
      frame,
      Math.round(this.encodedIndex * this.microsPerFrame),
      Math.round(this.microsPerFrame),
    );
    try {
      // Force every frame to be a keyframe — at this bitrate the size overhead
      // is acceptable, and on CA models even a 1-cell change can confuse
      // interframe prediction enough to bleed across previously-stable regions.
      // All-intra keeps frames independent and visually faithful (and makes a
      // dropped frame harmless).
      this.encoder.encode(videoFrame, { keyFrame: true });
    } catch (err) {
      this.encoderError = err instanceof Error ? err : new Error(String(err));
      videoFrame.close();
      this.droppedFrames++;
      return false;
    }
    videoFrame.close();
    this.inFlight.push(now);
    this.lastSubmitAt = now;
    this.encodedIndex++;
    return true;
  }

  /** Flush the encoder, finalize the container and hand back the file. Rejects
   *  with the encoder's error if one occurred at any point during the recording. */
  async finish(): Promise<Blob> {
    if (this.cancelled) throw new Error('Recording was cancelled');
    if (this.finished) throw new Error('Recording already finished');
    this.finished = true;
    await this.encoder.flush();
    this.encoder.close();
    if (this.encoderError) throw this.encoderError;
    if (this.encodedIndex === 0) throw new Error('No frames were encoded');
    this.muxer.finalize();
    return new Blob([this.muxer.target.buffer], { type: 'video/webm' });
  }

  /** Abandon the recording and release the encoder. Safe to call more than
   *  once, and safe after `finish()`. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (!this.finished) {
      try { this.encoder.close(); } catch { /* already closed / never configured */ }
    }
  }
}
