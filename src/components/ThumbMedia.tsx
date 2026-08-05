import type { CSSProperties } from 'react';
import { isVideoThumbnail } from '../model/thumbnail';

interface ThumbMediaProps {
  /** Data URL (embedded thumbnail) or sidecar URL (Models Library). */
  src: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Renders a model thumbnail — a still image via `<img>`, a WebM clip via a
 * silently auto-looping `<video>`. ONE component so the branch can't drift
 * between the three render sites (Info panel preview, Models Library hover
 * popover, standalone viewer About panel); the caller's `className`/`style`
 * apply identically to both elements, so sizing/fit rules are shared.
 *
 * The video is `muted` + `playsInline` (both REQUIRED for autoplay to be
 * allowed without a user gesture), `loop`, and `preload="auto"` so a short clip
 * starts immediately in a hover popover. `controls` is deliberately absent — a
 * thumbnail is decoration, not a player.
 */
export function ThumbMedia({ src, alt = '', className, style }: ThumbMediaProps) {
  if (isVideoThumbnail(src)) {
    return (
      <video
        src={src}
        className={className}
        style={style}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-label={alt || undefined}
      />
    );
  }
  return <img src={src} alt={alt} className={className} style={style} />;
}
