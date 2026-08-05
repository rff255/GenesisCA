/**
 * Model thumbnail media rules — the ONE source of truth for what a thumbnail
 * may be and how to tell a still image from a video clip.
 *
 * `ModelProperties.thumbnail` is a data URL (schema unchanged), but it may now
 * carry a `video/webm` clip as well as a still image — the simulator can RECORD
 * WebM, so a recording is the most natural thing to show off a model with. A
 * video can NOT be rendered by an `<img>`, so every render site routes through
 * `<ThumbMedia>` ([src/components/ThumbMedia.tsx]), which branches on
 * `isVideoThumbnail`.
 *
 * Detection covers BOTH shapes a thumbnail is referenced by:
 *   - the embedded data URL (`data:video/webm;base64,…`) — the modeler panel and
 *     the standalone viewer;
 *   - the Vite plugin's extracted sidecar FILENAME/URL (`<file>.thumb.webm`) —
 *     the Models Library.
 * `.webp` (a still) and `.webm` (a clip) differ in their last character only, so
 * the extension test must be exact.
 */

/** 2 MB — the same ceiling for images and clips. */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** `accept` for the thumbnail file input. */
export const THUMBNAIL_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/webm';

/** Human-readable format list, shared by the panel hint. */
export const THUMBNAIL_FORMATS_LABEL = 'PNG, JPEG, GIF, WebP, or WebM video';

/** True when the thumbnail is a video clip (a data URL or a `.webm` sidecar). */
export function isVideoThumbnail(src: string | undefined | null): boolean {
  if (!src) return false;
  if (src.startsWith('data:')) return /^data:video\//i.test(src);
  return /\.webm(?:$|[?#])/i.test(src);
}
