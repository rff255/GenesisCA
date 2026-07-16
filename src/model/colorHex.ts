/** Shared alpha-aware colour-hex helpers.
 *
 *  THE single source of truth for hex ⇄ RGBA in the engine-path colour sites
 *  (colour model attributes, Colour Scale / Categorical Color / Colour Constant
 *  palettes, Linked Output Mapping palettes, and the `ColorField` widget).
 *
 *  Why this module exists: the codebase grew three divergent hex-helper pairs
 *  with subtly different behaviour — a regex/black-fallback pair, a 24-bit-mask
 *  pair that silently corrupts an 8-digit hex into the wrong channels, and a
 *  third inline copy — plus two `toHexColor` clones that fall back to `#888888`
 *  on anything they don't recognise. Alpha cannot be threaded safely through
 *  that, so the engine-path sites converge here.
 *
 *  NOT adopted by the out-of-scope cosmetic sites (brush colour, indicator chart
 *  series colours, sprite chroma-key, comment/group node colours) — those remain
 *  RGB-only by design, and must never *receive* an 8-digit hex.
 *
 *  ── The round-trip invariant (load-bearing) ──────────────────────────────────
 *  `rgbaToHex` emits **6 digits when alpha is 255**. An opaque colour therefore
 *  round-trips to the exact string it had before alpha existed, so every saved
 *  `.gcaproj` and every default stays byte-identical. Alpha only widens the
 *  encoding when it is actually used.
 */

/** An 0–255 RGBA quadruple. Unlike the schema's `RGB`/`ColorStop` (where `a?` is
 *  optional and absent means opaque), `a` here is always resolved. */
export interface RGBA { r: number; g: number; b: number; a: number; }

/** Fully-opaque alpha. Absent alpha resolves to this everywhere. */
export const OPAQUE = 255;

const clamp255 = (n: number): number =>
  !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 255 ? 255 : Math.round(n);

const HEX_RE = /^#?([0-9a-f]{3,8})$/i;

/** Parse `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` (with or without the `#`) to
 *  RGBA. Alpha defaults to {@link OPAQUE} when the notation carries none — the
 *  invariant that keeps every pre-alpha value behaving exactly as before.
 *
 *  Returns `fallback` (default opaque black) for anything unparseable, matching
 *  the forgiving posture of the helpers it replaces: a malformed colour must not
 *  throw inside a render or a compile. */
export function hexToRgba(hex: string | undefined | null, fallback?: RGBA): RGBA {
  const fb: RGBA = fallback ?? { r: 0, g: 0, b: 0, a: OPAQUE };
  if (typeof hex !== 'string') return fb;
  const m = HEX_RE.exec(hex.trim());
  if (!m) return fb;
  const h = m[1]!;
  // Shorthand: each nibble is doubled (#abc → #aabbcc), per CSS Color.
  if (h.length === 3 || h.length === 4) {
    const dup = (i: number) => parseInt(h[i]! + h[i]!, 16);
    return {
      r: dup(0), g: dup(1), b: dup(2),
      a: h.length === 4 ? dup(3) : OPAQUE,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : OPAQUE,
    };
  }
  return fb; // 5 or 7 digits — not a valid CSS hex colour.
}

/** RGBA → `#rrggbb` when opaque, `#rrggbbaa` otherwise.
 *
 *  The opaque→6-digit rule is what preserves byte-identity for every existing
 *  model: a colour that never touches alpha serialises exactly as it always did.
 *  An absent/undefined `a` is treated as opaque. */
export function rgbaToHex(c: { r: number; g: number; b: number; a?: number }): string {
  const h2 = (n: number) => clamp255(n).toString(16).padStart(2, '0');
  const a = c.a === undefined ? OPAQUE : clamp255(c.a);
  const rgb = `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
  return a === OPAQUE ? rgb : `${rgb}${h2(a)}`;
}

/** The 6-digit `#rrggbb` prefix of any supported notation.
 *
 *  `<input type="color">` cannot represent alpha — it silently TRUNCATES an
 *  8-digit value to 6 rather than rejecting it (verified: `#ff000080` → `#ff0000`
 *  on Chrome 148; the spec's `alpha` attribute is Safari-18.4-only at ~12% global
 *  support). So the native picker is fed the RGB part explicitly and alpha is
 *  carried by a separate control — never round-tripped through the element. */
export function hexRgbPart(hex: string | undefined | null): string {
  const { r, g, b } = hexToRgba(hex);
  return rgbaToHex({ r, g, b, a: OPAQUE });
}

/** RGBA → a CSS `rgba()` string, for swatch/gradient previews. */
export function rgbaToCss(c: { r: number; g: number; b: number; a?: number }): string {
  const a = c.a === undefined ? OPAQUE : clamp255(c.a);
  return `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${(a / 255).toFixed(3)})`;
}

/** True when the colour is fully opaque (or declares no alpha at all).
 *
 *  The predicate behind the byte-identity guarantee: an all-opaque palette takes
 *  the pre-alpha emit path and wires no `a` edge, so its compiled output is
 *  unchanged. Callers use it to decide whether alpha exists *at all* for a node
 *  or mapping. */
export function isOpaque(c: { a?: number } | undefined | null): boolean {
  return !c || c.a === undefined || clamp255(c.a) === OPAQUE;
}
