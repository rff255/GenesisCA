/**
 * Sprite decoding + registry (main-thread, render side).
 *
 * Imported sprite assets are decoded here into `ImageBitmap` frames for fast
 * per-agent `drawImage` blitting in `drawAgentsOverlay`. The worker never carries
 * the pixels — it only computes a per-agent sprite slot + frame in the JS agent
 * colour pass. The slot (1-based) indexes `model.sprites`; the registry is keyed
 * by sprite id.
 *
 * Four sources of frames (checked in order):
 *  1. IMAGE SEQUENCE (`frames[]`): each entry is a data URL → one frame.
 *  2. SPRITE SHEET (`sheet`): the single grid image sliced row-major into frames.
 *  3. Animated GIF/WebP/APNG: decoded via WebCodecs `ImageDecoder` (no new dep —
 *     already used for WebM recording), falling back to a single frame.
 *  4. Static image: a single frame.
 *
 * After building the frames, an optional CHROMA KEY (`removeBgColor`) makes pixels
 * within tolerance of the chosen colour transparent (classic magenta/green
 * background removal for traditional sprites).
 */

/** A decoded sprite — one `ImageBitmap` per animation frame + per-frame durations. */
export interface DecodedSprite {
  frames: ImageBitmap[];
  /** ms per frame (parallel to `frames`). Informational — playback is logic-driven. */
  durations: number[];
  width: number;
  height: number;
}

/** The decode-relevant subset of a `SpriteAsset` (structurally a superset field
 *  set, so a full `SpriteAsset` can be passed directly). */
export interface SpriteDecodeSpec {
  id: string;
  dataUrl: string;
  mimeType: string;
  frames?: string[];
  sheet?: { cols: number; rows: number; count?: number; marginX?: number; marginY?: number; spacingX?: number; spacingY?: number };
  removeBgColor?: string;
  removeBgTolerance?: number;
}

// WebCodecs ImageDecoder isn't in the default DOM lib everywhere; declare what we use.
type ImageDecoderCtor = new (init: { data: BufferSource; type: string }) => {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
  decode: (opts: { frameIndex: number }) => Promise<{ image: VideoFrame & { duration?: number | null } }>;
  close: () => void;
};

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** Decode an animated (or static) image blob into frame bitmaps + durations. */
async function decodeImageBlob(blob: Blob, mimeType: string): Promise<{ frames: ImageBitmap[]; durations: number[] }> {
  const Decoder = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  if (Decoder) {
    try {
      const buf = await blob.arrayBuffer();
      const decoder = new Decoder({ data: buf, type: mimeType || blob.type || 'image/png' });
      await decoder.tracks.ready;
      const count = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
      const frames: ImageBitmap[] = [];
      const durations: number[] = [];
      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        frames.push(await createImageBitmap(image));
        durations.push(image.duration ? image.duration / 1000 : 100);
        image.close();
      }
      decoder.close();
      return { frames, durations };
    } catch {
      /* fall through to the single-frame path */
    }
  }
  const bmp = await createImageBitmap(blob);
  return { frames: [bmp], durations: [100] };
}

/** Create a 2D-context canvas (OffscreenCanvas when available, else a DOM canvas). */
function makeCanvas(w: number, h: number): { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D; canvas: OffscreenCanvas | HTMLCanvasElement } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    return { ctx: c.getContext('2d')!, canvas: c };
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { ctx: c.getContext('2d')!, canvas: c };
}

/** Slice one sheet bitmap into `cols*rows` (or `count`) row-major frames. */
async function sliceSheet(bmp: ImageBitmap, sheet: NonNullable<SpriteDecodeSpec['sheet']>): Promise<ImageBitmap[]> {
  const cols = Math.max(1, Math.floor(sheet.cols || 1));
  const rows = Math.max(1, Math.floor(sheet.rows || 1));
  const mx = sheet.marginX || 0, my = sheet.marginY || 0;
  const sx = sheet.spacingX || 0, sy = sheet.spacingY || 0;
  // Derive the cell size from the image minus margins/spacing.
  const cw = Math.max(1, Math.floor((bmp.width - mx - (cols - 1) * sx) / cols));
  const ch = Math.max(1, Math.floor((bmp.height - my - (rows - 1) * sy) / rows));
  const total = Math.min(cols * rows, sheet.count && sheet.count > 0 ? Math.floor(sheet.count) : cols * rows);
  const out: ImageBitmap[] = [];
  for (let n = 0; n < total; n++) {
    const r = Math.floor(n / cols), c = n % cols;
    const x = mx + c * (cw + sx);
    const y = my + r * (ch + sy);
    out.push(await createImageBitmap(bmp, x, y, cw, ch));
  }
  return out;
}

/** Parse a #rgb / #rrggbb colour to [r,g,b] (0-255), else null. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Make pixels within `tol` per channel of `color` transparent. Returns a NEW
 *  ImageBitmap; the input is closed by the caller. */
async function applyChromaKey(bmp: ImageBitmap, color: string, tol: number): Promise<ImageBitmap> {
  const rgb = parseHex(color);
  if (!rgb) return bmp;
  const [kr, kg, kb] = rgb;
  const { ctx, canvas } = makeCanvas(bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i]! - kr) <= tol && Math.abs(d[i + 1]! - kg) <= tol && Math.abs(d[i + 2]! - kb) <= tol) {
      d[i + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return createImageBitmap(canvas as CanvasImageSource);
}

/** Decode a sprite asset into frame bitmaps + durations, honouring image
 *  sequence / sprite sheet / chroma-key options. */
export async function decodeSpriteAsset(spec: SpriteDecodeSpec): Promise<DecodedSprite> {
  let frames: ImageBitmap[];
  let durations: number[];

  if (spec.frames && spec.frames.length > 0) {
    // Image sequence — each entry is a separate frame image.
    frames = [];
    for (const url of spec.frames) {
      const blob = await dataUrlToBlob(url);
      frames.push(await createImageBitmap(blob));
    }
    durations = frames.map(() => 100);
  } else if (spec.sheet) {
    // Sprite sheet — slice the grid image into frames.
    const blob = await dataUrlToBlob(spec.dataUrl);
    const full = await createImageBitmap(blob);
    frames = await sliceSheet(full, spec.sheet);
    full.close();
    if (frames.length === 0) frames = [await createImageBitmap(blob)];
    durations = frames.map(() => 100);
  } else {
    // Single image / animated GIF/WebP.
    const blob = await dataUrlToBlob(spec.dataUrl);
    const decoded = await decodeImageBlob(blob, spec.mimeType);
    frames = decoded.frames;
    durations = decoded.durations;
  }

  // Optional chroma-key background removal on every frame.
  if (spec.removeBgColor) {
    const tol = spec.removeBgTolerance ?? 24;
    const keyed: ImageBitmap[] = [];
    for (const f of frames) {
      const k = await applyChromaKey(f, spec.removeBgColor, tol);
      keyed.push(k);
      // applyChromaKey returns the SAME bitmap when the colour didn't parse — do
      // NOT close it then, or the frame in `keyed` becomes a detached bitmap and
      // drawImage throws InvalidStateError (breaking the whole agent overlay).
      if (k !== f) f.close();
    }
    frames = keyed;
  }

  const w = frames[0]?.width ?? 1, h = frames[0]?.height ?? 1;
  return { frames, durations, width: w, height: h };
}

/** Back-compat: decode a single image/animated blob (used elsewhere/tests). */
export async function decodeSprite(dataUrl: string, mimeType: string): Promise<DecodedSprite> {
  return decodeSpriteAsset({ id: '', dataUrl, mimeType });
}

/** Stable signature of the decode-relevant fields — re-decode only when it changes. */
function decodeKey(s: SpriteDecodeSpec): string {
  return JSON.stringify([s.dataUrl, s.frames ?? null, s.sheet ?? null, s.removeBgColor ?? null, s.removeBgTolerance ?? null, s.mimeType]);
}

/**
 * Holds decoded sprites keyed by id, re-decoding only when a sprite's decode
 * signature (image / sequence / sheet / chroma-key) changes. `onReady` fires
 * after a (re)decode completes so the caller can request a redraw. Cheap to
 * `sync` every render — unchanged sprites are skipped.
 */
export class SpriteRegistry {
  private map = new Map<string, { key: string; decoded?: DecodedSprite }>();
  constructor(private onReady: () => void) {}

  /** Reconcile against the model's sprite list — decode new/changed, drop removed. */
  sync(sprites: ReadonlyArray<SpriteDecodeSpec>): void {
    const ids = new Set(sprites.map(s => s.id));
    for (const id of [...this.map.keys()]) {
      if (!ids.has(id)) { this.closeEntry(id); this.map.delete(id); }
    }
    for (const s of sprites) {
      const key = decodeKey(s);
      const cur = this.map.get(s.id);
      if (cur && cur.key === key) continue; // unchanged — keep decoded frames
      if (cur?.decoded) cur.decoded.frames.forEach(f => f.close());
      this.map.set(s.id, { key });
      decodeSpriteAsset(s).then(d => {
        const entry = this.map.get(s.id);
        if (entry && entry.key === key) { entry.decoded = d; this.onReady(); }
        else d.frames.forEach(f => f.close()); // superseded mid-decode
      }).catch(() => { /* leave undecoded → renderer draws the fallback circle */ });
    }
  }

  get(id: string): DecodedSprite | undefined { return this.map.get(id)?.decoded; }
  frameCount(id: string): number { return this.map.get(id)?.decoded?.frames.length ?? 0; }

  private closeEntry(id: string): void {
    this.map.get(id)?.decoded?.frames.forEach(f => f.close());
  }

  dispose(): void {
    for (const id of this.map.keys()) this.closeEntry(id);
    this.map.clear();
  }
}
