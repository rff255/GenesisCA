/**
 * Sprite decoding + registry (main-thread, render side).
 *
 * Imported sprite assets (static images / animated GIFs / WebP) are decoded here
 * into `ImageBitmap` frames for fast per-agent `drawImage` blitting in
 * `drawAgentsOverlay`. The worker never carries the pixels — it only computes a
 * per-agent sprite slot + optional frame in the JS agent colour pass. The slot
 * (1-based) indexes `model.sprites`; the registry is keyed by sprite id.
 *
 * Decoding uses WebCodecs `ImageDecoder` (animated GIF/WebP/PNG natively, no new
 * dependency — the project already relies on WebCodecs for WebM recording). When
 * `ImageDecoder` is unavailable, it falls back to `createImageBitmap` (a single
 * frame — static images work everywhere; an animated GIF degrades to its first
 * frame). The same Chromium-first posture as WebGPU / WebM recording.
 */

/** A decoded sprite — one `ImageBitmap` per animation frame + per-frame durations. */
export interface DecodedSprite {
  frames: ImageBitmap[];
  /** ms per frame (parallel to `frames`). */
  durations: number[];
  width: number;
  height: number;
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

/** Decode a sprite asset into frame bitmaps + durations. */
export async function decodeSprite(dataUrl: string, mimeType: string): Promise<DecodedSprite> {
  const blob = await dataUrlToBlob(dataUrl);
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
        // VideoFrame.duration is microseconds; default to 100 ms when absent (static).
        durations.push(image.duration ? image.duration / 1000 : 100);
        image.close();
      }
      decoder.close();
      const w = frames[0]?.width ?? 1, h = frames[0]?.height ?? 1;
      return { frames, durations, width: w, height: h };
    } catch {
      /* fall through to the single-frame path */
    }
  }
  // Fallback: a single frame (static images everywhere; animated → first frame).
  const bmp = await createImageBitmap(blob);
  return { frames: [bmp], durations: [100], width: bmp.width, height: bmp.height };
}

interface SpriteSpec { id: string; dataUrl: string; mimeType: string }

/**
 * Holds decoded sprites keyed by id, re-decoding only when a sprite's data URL
 * changes. `onReady` fires after a (re)decode completes so the caller can request
 * a redraw. Cheap to `sync` every render — unchanged sprites are skipped.
 */
export class SpriteRegistry {
  private map = new Map<string, { url: string; decoded?: DecodedSprite }>();
  constructor(private onReady: () => void) {}

  /** Reconcile against the model's sprite list — decode new/changed, drop removed. */
  sync(sprites: ReadonlyArray<SpriteSpec>): void {
    const ids = new Set(sprites.map(s => s.id));
    for (const id of [...this.map.keys()]) {
      if (!ids.has(id)) { this.closeEntry(id); this.map.delete(id); }
    }
    for (const s of sprites) {
      const cur = this.map.get(s.id);
      if (cur && cur.url === s.dataUrl) continue; // unchanged — keep decoded frames
      if (cur?.decoded) cur.decoded.frames.forEach(f => f.close());
      this.map.set(s.id, { url: s.dataUrl });
      decodeSprite(s.dataUrl, s.mimeType).then(d => {
        const entry = this.map.get(s.id);
        if (entry && entry.url === s.dataUrl) { entry.decoded = d; this.onReady(); }
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
