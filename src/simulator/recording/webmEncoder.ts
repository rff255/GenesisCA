import { Muxer, ArrayBufferTarget } from 'webm-muxer';

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
export async function encodeFramesToWebM(frames: ImageData[], fps: number): Promise<Blob> {
  if (frames.length === 0) throw new Error('No frames to encode');
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('WebCodecs VideoEncoder is not supported in this browser.');
  }

  const w = frames[0]!.width;
  const h = frames[0]!.height;
  const safeFps = fps > 0 && Number.isFinite(fps) ? fps : 30;

  // Pick a near-lossless bitrate. RGB at 8 bpp × pixels × fps is the raw
  // upper bound; VP9 with intra-heavy keyframing reaches visually lossless
  // around 4-6 bpp × fps for sharp content. We target 6 bpp × fps with a
  // 4 Mbps floor so tiny grids still get headroom.
  const bitrate = Math.max(4_000_000, Math.round(w * h * safeFps * 6));

  // Try high-quality 4:4:4 first. The chroma_subsampling field is the 5th
  // dot-segment of the codec string (0=4:2:0v, 1=4:2:0col, 2=4:2:2, 3=4:4:4).
  // Browser support for VP9 profile 1 + 4:4:4 in WebCodecs is uneven — Chrome
  // accepts it on most platforms; if it doesn't we fall back to profile 0.
  type Attempt = { codec: string; muxerCodec: string; label: string };
  const attempts: Attempt[] = [
    { codec: 'vp09.01.10.08.03', muxerCodec: 'V_VP9', label: 'VP9 profile 1 (4:4:4)' },
    { codec: 'vp09.00.10.08', muxerCodec: 'V_VP9', label: 'VP9 profile 0 (4:2:0)' },
  ];

  let chosen: Attempt | null = null;
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
      if (support.supported) {
        chosen = attempt;
        break;
      }
    } catch (err) {
      configError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (!chosen) {
    throw new Error(
      `No supported VP9 configuration in this browser${configError ? `: ${configError.message}` : ''}`
    );
  }

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

  encoder.configure({
    codec: chosen.codec,
    width: w,
    height: h,
    bitrate,
    framerate: safeFps,
    bitrateMode: 'constant',
    latencyMode: 'quality',
    // 'text' tells the encoder the source is sharp/synthetic content (UI,
    // pixel art) rather than a noisy camera feed — Chrome's encoder uses
    // smaller block sizes and finer rate control on such content.
    contentHint: 'text',
  });

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
  for (let i = 0; i < frames.length; i++) {
    if (encoderError) break;
    const frame = frames[i]!;
    // Defensive: skip frames that don't match the leader's dimensions.
    if (frame.width !== w || frame.height !== h) continue;
    ctx.putImageData(frame, 0, 0);
    const videoFrame = new VideoFrame(canvas as CanvasImageSource, {
      timestamp: Math.round(i * microsPerFrame),
      duration: Math.round(microsPerFrame),
    });
    // Force every frame to be a keyframe — at the bitrate above, the size
    // overhead is acceptable, and on CA models even a 1-cell change can
    // confuse interframe prediction enough to bleed across previously-stable
    // regions. All-intra keeps frames independent and visually faithful.
    encoder.encode(videoFrame, { keyFrame: true });
    videoFrame.close();
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
