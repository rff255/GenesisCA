declare module 'gifenc' {
  export function GIFEncoder(opt?: { initialCapacity?: number; auto?: boolean }): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        /** Colour table for this frame. On the FIRST frame it becomes the GLOBAL
         *  table (and is mandatory); on any later frame it becomes a LOCAL table
         *  (768 bytes for 256 entries). Pass `null`/omit on a later frame to
         *  reuse the global table instead. */
        palette?: number[][] | null;
        /** Milliseconds. gifenc converts to the GIF's centisecond unit. */
        delay?: number;
        /** Disposal method: 0 = unspecified, 1 = do not dispose (leave the frame
         *  in place — what a delta frame needs), 2 = restore to background,
         *  3 = restore to previous. -1 (default) lets gifenc pick, and its pick
         *  for a TRANSPARENT frame is 2, which CLEARS — never what we want. */
        dispose?: number;
        transparent?: boolean;
        transparentIndex?: number;
        repeat?: number;
        colorDepth?: number;
        first?: boolean;
      },
    ): void;
    finish(): void;
    /** Empty the stream and forget that a first frame was written — what makes
     *  one encoder reusable as a size PROBE for successive candidate frames. */
    reset(): void;
    bytes(): Uint8Array;
    /** The written bytes WITHOUT copying them out (unlike `bytes()`). */
    bytesView(): Uint8Array;
  };
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: string; oneBitAlpha?: boolean | number },
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string,
  ): Uint8Array;
}
