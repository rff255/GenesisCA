import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { clampRecordFps } from './webmEncoder';

/**
 * GIF encoding for recordings — the DELTA path.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 * The original encoder wrote every captured frame WHOLE: quantize to 256
 * colours, `applyPalette`, `writeFrame` with a local colour table, fixed delay.
 * Nothing about the previous frame was consulted, so a Game-of-Life recording in
 * which 1 % of cells change re-encoded 100 % of the pixels every frame, and a
 * completely frozen simulation cost exactly as much as a churning one.
 *
 * ── What it does now ────────────────────────────────────────────────────────
 * Two optimisations, both of which the GIF format has always had and gifenc does
 * expose:
 *
 *  1. **Identical-frame delay merging** (`mergeIdentical`). A run of frames with
 *     byte-identical pixels is written ONCE with the summed delay. Exactly
 *     equivalent for a viewer (GIF timing is per-frame delay, so N frames of
 *     d ms and one frame of N·d ms are the same animation) and it is the
 *     cheapest possible win: a paused / stalled / slowly-changing stretch
 *     collapses to a single frame.
 *
 *  2. **Transparent-index delta frames** (`delta`). Pixels whose DECODED colour
 *     is already on screen are written as a reserved transparent index and the
 *     frame is tagged `dispose: 1` ("do not dispose" — leave the previous frame
 *     in place), so the decoder keeps them. The frame is still full-size; what
 *     shrinks is the LZW payload, because an unchanged background collapses into
 *     long runs of one index.
 *
 * ── A delta is NOT always smaller, so the choice is MEASURED, not assumed ────
 * The transparent index is a new SYMBOL in the middle of the image, and where
 * the changed pixels are scattered rather than clustered it FRAGMENTS the runs
 * LZW was already compressing — the delta comes out bigger. Measured on the
 * shipped Chromatography model (~32 % of pixels change every step, spread right
 * across the column): whole-file 194 999 B full-frame vs 204 057 B all-delta,
 * i.e. the "optimisation" cost 4 %.
 *
 * So each frame is encoded BOTH ways into a throwaway probe and the SMALLER one
 * is written. That makes the delta path non-regressive by construction rather
 * than by hope, and it adapts within a single recording (a run that is static,
 * then busy, then static gets the right treatment in each stretch). A cheap
 * predictor was evaluated first — comparing the count of adjacent-symbol
 * transitions in the two index arrays called all 11 Chromatography frames
 * correctly — but a prediction that is wrong ships a bigger file than the user
 * asked for, and the exact answer is affordable here: LZW is ~2.0 ms of a
 * ~6.2 ms per-frame encode at 110x512, and GIF encoding happens ONCE, at Stop,
 * for what the format is documented as being for (short clips).
 *
 * ── Three things that are easy to get WRONG here ────────────────────────────
 *
 *  A. **The comparison must be against the DECODED image, not the source RGBA.**
 *     Each frame gets its own quantised palette, so the same source colour can
 *     land on a different palette entry — and therefore a slightly different
 *     RGB — from one frame to the next. Comparing source pixels would mark such
 *     a pixel "unchanged" and leave the OLD colour on screen. So we track
 *     `prevRgb`, the RGB the decoder actually has, and a pixel goes transparent
 *     only when the new frame would paint the identical RGB. That makes the
 *     delta output **decode-identical to writing every frame whole** — which is
 *     the invariant the A/B test asserts, not merely "looks the same".
 *
 *  B. **`dispose` MUST be set explicitly.** gifenc's default (`dispose: -1`)
 *     means "you pick", and its pick for a transparent frame is 2 = restore to
 *     background, i.e. CLEAR the canvas — the exact opposite of a delta frame.
 *
 *  C. **The transparent slot must be appended AFTER `applyPalette`.** Its colour
 *     is never displayed, but if it is present while the palette is being
 *     applied, real pixels can be mapped onto it (its nominal `[0,0,0]` is black,
 *     which CA output is full of) and would silently vanish.
 *
 * ── What gifenc CANNOT do, so we do not attempt it ──────────────────────────
 * **Sub-rect frames.** The GIF format allows a frame to be a small image placed
 * at an (x, y) offset — the classic delta optimisation — but gifenc's
 * `encodeImageDescriptor` hard-codes the position to (0, 0) and takes the frame
 * size from the `width`/`height` arguments, so a changed-region rectangle can
 * only be expressed at the top-left corner. Emitting one would need us to write
 * the image descriptor bytes ourselves around gifenc's LZW output, i.e. to fork
 * the encoder. Not done. The transparent-index delta above already removes most
 * of the cost the sub-rect would have (the untouched area becomes one LZW run);
 * what remains is the per-frame image-descriptor overhead, a few bytes.
 *
 * ── The one deliberate cost ─────────────────────────────────────────────────
 * A delta frame needs a spare palette index, so quantisation targets
 * `GIF_DELTA_COLORS` (255) rather than 256. One colour out of 256 — invisible on
 * any content, and nil on the CA output that quantises to a handful of colours.
 * Set `delta: false` to get the historical 256-colour full-frame output.
 */

/** Palette size when the delta path is on: one index is reserved as the
 *  transparent (= "keep what is already there") marker. */
export const GIF_DELTA_COLORS = 255;

/** Default long-edge cap for a GIF (the historical value). GIF keeps every
 *  frame's raw pixels in memory until Stop, so it stays modest by default. */
export const GIF_MAX_DEFAULT = 512;

/** Hard ceiling for a user-chosen GIF resolution. Above this a GIF is the wrong
 *  format (256 colours, no interframe prediction beyond the delta above, and
 *  every frame buffered) — the recording should be WebM. */
export const GIF_MAX_HARD = 1024;

/** GIF stores the delay as a 16-bit centisecond count. */
const MAX_DELAY_MS = 65535 * 10;

export interface GifEncodeOptions {
  /** Long-edge cap; frames larger than this are downscaled (nearest-neighbour,
   *  so cell boundaries stay crisp). Default `GIF_MAX_DEFAULT`. */
  maxSize?: number;
  /** Write unchanged pixels as the transparent index. Default true. */
  delta?: boolean;
  /** Collapse runs of pixel-identical frames into one longer-delay frame.
   *  Default true. */
  mergeIdentical?: boolean;
  /** Palette size. Defaults to `GIF_DELTA_COLORS` when `delta`, else 256.
   *  Exposed so a test can hold the palette policy fixed while flipping `delta`,
   *  which is what isolates the delta logic in an A/B. */
  maxColors?: number;
}

export interface GifEncodeStats {
  width: number;
  height: number;
  /** Frames handed in. */
  framesIn: number;
  /** Frames actually written to the file. */
  framesWritten: number;
  /** Frames absorbed into a previous frame's delay (identical pixels). */
  framesMerged: number;
  /** Frames written with a transparent index (i.e. as a delta). */
  deltaFrames: number;
  /** Frames where the delta probe came out BIGGER, so the whole frame was
   *  written instead. Nonzero on dense, scattered-change content. */
  deltaRejected: number;
  /** Bytes the probe says were saved by choosing per frame (delta bytes vs full
   *  bytes, summed over the frames where the delta won). */
  deltaSavedBytes: number;
  /** Frames that reused the global colour table instead of carrying a local one. */
  globalPaletteFrames: number;
  /** Pixels actually re-painted, summed over the written delta frames. */
  changedPixels: number;
  /** Pixels a full-frame encode would have re-painted over the same frames. */
  totalPixels: number;
  bytes: number;
}

/** Do two RGBA buffers hold identical pixels? Compared 4 bytes at a time when
 *  the backing stores are word-aligned (they are, for `ImageData` and for
 *  `getImageData` results — both own their buffer). */
function samePixels(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0 && a.length % 4 === 0) {
    const wa = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
    const wb = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
    for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Are two palettes the same table? Used to decide whether a frame can reuse the
 *  GLOBAL colour table (saving its own 768-byte local one). */
function samePalette(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return false;
  }
  return true;
}

/**
 * Encode captured frames to a GIF blob.
 *
 * `frames` must all share the leader's dimensions (the recorder locks them at
 * the first captured frame); any that do not are skipped.
 */
export function encodeFramesToGif(
  frames: ImageData[],
  fps: number,
  opts: GifEncodeOptions = {},
): { blob: Blob; stats: GifEncodeStats } {
  const delta = opts.delta !== false;
  const merge = opts.mergeIdentical !== false;
  const maxSize = opts.maxSize ?? GIF_MAX_DEFAULT;
  const maxColors = opts.maxColors ?? (delta ? GIF_DELTA_COLORS : 256);

  const fw = frames[0]?.width ?? 0;
  const fh = frames[0]?.height ?? 0;
  const stats: GifEncodeStats = {
    width: fw, height: fh, framesIn: frames.length, framesWritten: 0,
    framesMerged: 0, deltaFrames: 0, deltaRejected: 0, deltaSavedBytes: 0,
    globalPaletteFrames: 0, changedPixels: 0, totalPixels: 0, bytes: 0,
  };
  if (frames.length === 0 || fw === 0 || fh === 0) {
    return { blob: new Blob([], { type: 'image/gif' }), stats };
  }

  // Downscale large grids. Both canvases are NEVER DISPLAYED, which is what
  // makes the `getImageData` below safe — doing that on a live canvas
  // de-optimises it out of GPU acceleration permanently.
  let outW = fw, outH = fh;
  if (fw > maxSize || fh > maxSize) {
    const s = maxSize / Math.max(fw, fh);
    outW = Math.max(1, Math.round(fw * s));
    outH = Math.max(1, Math.round(fh * s));
  }
  stats.width = outW; stats.height = outH;
  const needsScale = outW !== fw || outH !== fh;
  let scaleCanvas: HTMLCanvasElement | null = null;
  let scaleCtx: CanvasRenderingContext2D | null = null;
  let srcCanvas: HTMLCanvasElement | null = null;
  let srcCtx: CanvasRenderingContext2D | null = null;
  if (needsScale) {
    scaleCanvas = document.createElement('canvas');
    scaleCanvas.width = outW; scaleCanvas.height = outH;
    scaleCtx = scaleCanvas.getContext('2d', { willReadFrequently: true })!;
    scaleCtx.imageSmoothingEnabled = false;
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = fw; srcCanvas.height = fh;
    srcCtx = srcCanvas.getContext('2d')!;
  }
  /** The frame's pixels at OUTPUT size. Returns a shared scratch when scaling,
   *  so callers that need to keep a copy must clone it. */
  const pixelsOf = (frame: ImageData): Uint8ClampedArray | null => {
    if (frame.width !== fw || frame.height !== fh) return null;
    if (!needsScale) return frame.data;
    srcCtx!.putImageData(frame, 0, 0);
    scaleCtx!.drawImage(srcCanvas!, 0, 0, outW, outH);
    return scaleCtx!.getImageData(0, 0, outW, outH).data;
  };

  const gif = GIFEncoder();
  // Throwaway encoder used to MEASURE a candidate frame's compressed size. It is
  // `reset()` before each probe, so every probe writes the same header + logical
  // screen descriptor + global colour table preamble — a constant that cancels
  // when the two candidates are compared. `bytesView` is a subarray (no copy).
  const probe = GIFEncoder();
  // `reset()` makes the next write a FIRST frame, which gifenc requires a palette
  // for — so one is always supplied here even when the real frame will reuse the
  // global table. Both candidates are probed the same way, so the extra table is
  // a constant that cancels.
  const probeSize = (
    idx: Uint8Array,
    o: Parameters<typeof gif.writeFrame>[3],
    fallbackPalette: number[][],
  ): number => {
    probe.reset();
    probe.writeFrame(idx, outW, outH, { ...o, palette: o?.palette ?? fallbackPalette });
    return probe.bytesView().length;
  };
  const baseDelay = Math.round(1000 / clampRecordFps(fps));
  const n = outW * outH;
  // The RGB the decoder currently has on screen. `null` until the first frame is
  // written. This — not the source RGBA — is what a delta pixel is compared
  // against; see note (A) in the header.
  const prevRgb = delta ? new Uint8Array(n * 3) : null;
  // Flattened palette scratch (an array-of-arrays lookup per pixel is far too
  // slow at 262k pixels/frame).
  const pal = new Uint8Array(256 * 3);
  let globalPalette: number[][] | null = null;
  // A copy of the run's base pixels, so a shared scaling scratch cannot be
  // overwritten while we are still comparing against it.
  let runBase: Uint8ClampedArray | null = null;

  let i = 0;
  while (i < frames.length) {
    const rgba = pixelsOf(frames[i]!);
    if (!rgba) { i++; continue; }

    // ── 1. Identical-frame merge: how many frames repeat this one verbatim? ──
    let reps = 1;
    if (merge) {
      if (!runBase || runBase.length !== rgba.length) runBase = new Uint8ClampedArray(rgba.length);
      runBase.set(rgba);
      while (i + reps < frames.length) {
        const next = pixelsOf(frames[i + reps]!);
        if (!next || !samePixels(next, runBase)) break;
        reps++;
      }
      // pixelsOf() may have clobbered the shared scratch while scanning ahead.
      if (needsScale && reps > 1) rgba.set(runBase);
    }
    stats.framesMerged += reps - 1;

    // ── 2. Quantise + index the WHOLE frame ─────────────────────────────────
    // Note (C): the transparent slot is appended only AFTER applyPalette, so no
    // real pixel can be mapped onto it.
    const palette = quantize(rgba, maxColors);
    const indexed = applyPalette(rgba, palette);
    const transparentIndex = palette.length;
    // The FIRST written frame has nothing on screen to keep, so it is always a
    // whole frame (and its palette becomes the global colour table).
    const first = globalPalette === null;
    const canDelta = delta && !first && prevRgb !== null && transparentIndex < 256;
    if (delta && transparentIndex < 256) palette.push([0, 0, 0]);

    for (let k = 0; k < palette.length; k++) {
      const c = palette[k]!;
      pal[k * 3] = c[0]!; pal[k * 3 + 1] = c[1]!; pal[k * 3 + 2] = c[2]!;
    }

    // ── 3. Turn unchanged pixels transparent (and track what is on screen) ──
    // The delta candidate goes in a COPY: if the probe below rejects it we still
    // need the untouched full-frame indices. `prevRgb` is updated either way —
    // both candidates decode to exactly the same image, which is the whole point.
    let changed = n;
    let deltaIdx: Uint8Array | null = null;
    if (canDelta) {
      changed = 0;
      deltaIdx = indexed.slice();
      for (let p = 0; p < n; p++) {
        const c = indexed[p]! * 3;
        const o = p * 3;
        if (prevRgb![o] === pal[c] && prevRgb![o + 1] === pal[c + 1] && prevRgb![o + 2] === pal[c + 2]) {
          deltaIdx[p] = transparentIndex;
        } else {
          prevRgb![o] = pal[c]!; prevRgb![o + 1] = pal[c + 1]!; prevRgb![o + 2] = pal[c + 2]!;
          changed++;
        }
      }
    } else if (prevRgb) {
      for (let p = 0; p < n; p++) {
        const c = indexed[p]! * 3;
        const o = p * 3;
        prevRgb[o] = pal[c]!; prevRgb[o + 1] = pal[c + 1]!; prevRgb[o + 2] = pal[c + 2]!;
      }
    }
    stats.changedPixels += changed;
    stats.totalPixels += n;

    // ── 4. Write it ─────────────────────────────────────────────────────────
    // A frame whose palette equals the global one carries NO local colour table
    // (`palette: null` → gifenc emits the image descriptor against the global
    // table). CA content usually has a fixed colour set, so this is the common
    // case and it saves the table on every frame after the first.
    const reuseGlobal = !first && samePalette(palette, globalPalette!);
    if (reuseGlobal) stats.globalPaletteFrames++;
    const shared = {
      palette: first || !reuseGlobal ? palette : null,
      delay: Math.min(MAX_DELAY_MS, baseDelay * reps),
    };
    // Note (B): without an explicit dispose a transparent frame would be tagged
    // "restore to background", clearing everything the delta relies on.
    const deltaOpts = { ...shared, transparent: true, transparentIndex, dispose: 1 };
    // MEASURE, don't assume — see the header. Both candidates decode to the same
    // image, so this is a pure size choice with no quality dimension.
    let useDelta = false;
    if (deltaIdx) {
      const bDelta = probeSize(deltaIdx, deltaOpts, palette);
      const bFull = probeSize(indexed, shared, palette);
      useDelta = bDelta < bFull;
      if (useDelta) { stats.deltaFrames++; stats.deltaSavedBytes += bFull - bDelta; }
      else stats.deltaRejected++;
    }
    gif.writeFrame(useDelta ? deltaIdx! : indexed, outW, outH, useDelta ? deltaOpts : shared);
    if (first) globalPalette = palette;
    stats.framesWritten++;
    i += reps;
  }

  gif.finish();
  const bytes = gif.bytes();
  stats.bytes = bytes.length;
  return { blob: new Blob([bytes], { type: 'image/gif' }), stats };
}
