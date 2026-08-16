/**
 * Backdrop map rules — the ONE source of truth for what a backdrop image may be.
 *
 * `ModelProperties.backdrop` is a user-supplied STILL image (their QGIS /
 * hillshade / satellite export) stored exactly like the thumbnail: a data URL
 * travelling inside the `.gcaproj`. It is drawn UNDER the grid in the 2D
 * simulator and is NEVER read by any rule — SLEUTH's hillshade layer, QGIS's
 * basemap (see docs/INVESTIGATION_GEOSPATIAL_IO.md Tier 3).
 *
 * Deliberately NARROWER than the thumbnail accept list: NO video. A backdrop is
 * blitted every frame under the whole world rect, so it must be a decoded
 * bitmap an `<img>` can hand to `drawImage` — a `<video>` frame source would
 * need its own play/seek lifecycle for no gain.
 *
 * The cap is bigger than the thumbnail's (2 MB) because a legible map export of
 * a real study area is a photographic image, not a 200 px card preview — but it
 * still travels inside the `.gcaproj`, so it stays bounded.
 */

/** 4 MB — a map export is photographic, but it rides inside the `.gcaproj`. */
export const BACKDROP_MAX_BYTES = 4 * 1024 * 1024;

/** `accept` for the backdrop file input. Still images only (see above). */
export const BACKDROP_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

/** Human-readable format list, shared by the panel hint. */
export const BACKDROP_FORMATS_LABEL = 'PNG, JPEG, GIF or WebP';
