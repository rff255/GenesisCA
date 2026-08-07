/**
 * Agent-glow tonemapping — the ONE definition both 2D glow paths derive from:
 * the WebGPU disc/composite pipeline (agentWebgpuRuntime's GLOW_COMPOSE_WGSL) and
 * the Canvas2D overlay (drawAgentGlow in SimulatorView).
 *
 * ARCHITECTURE (ported from SandboxScience's Particle Life renderer — studied
 * files: `assets/particle-life-gpu/shaders/render/particle_render_glow.wgsl`,
 * `.../compose/compose_hdr.wgsl`, `assets/particle-life-gpu-3d/shaders/compose/
 * {bloom,compose_hdr}.wgsl`, and the pipeline/blend setup in
 * `components/particle-life/ParticleLifeGpu{,3D}.vue`. Technique reimplemented,
 * no code copied.)
 *
 *   ACCUMULATE THE HALOS EXACTLY, COMPRESS ONCE.
 *
 * The reference renders every particle's halo ADDITIVELY into an `rgba16float`
 * HDR target — nothing clips, nothing compresses during accumulation — and then a
 * single fullscreen compose pass tonemaps the finished sum (ACES in 2D; a
 * selectable ACES / Reinhard-Jodie / Lottes / AGX in 3D), gamma-encodes it and
 * dithers. That ordering is the whole reason their dense fields read as
 * "well treated" rather than as a white plateau.
 *
 * WHY NO BLEND CAN SUBSTITUTE FOR IT. A per-pair blend is MEMORYLESS: whatever
 * operator you pick, N stacked halos of per-halo display value p give
 * `1 - (1-p)^N` (screen), `min(1, Np)` (additive) or something else in that
 * family — every one of which exhausts the 8-bit display range after ~4 overlaps
 * for any p bright enough to see ONE halo. The plateau is a property of the
 * architecture, not of the operator. Only a real accumulate-then-tonemap can
 * spend its shoulder where the density actually is.
 *
 * THE CURVE — Reinhard, `T(x) = x/(1+x)`, applied to the accumulated MAGNITUDE
 * with the hue kept exact. Chosen over ACES because ACES-Narkowicz maps 1.0 → 0.80
 * with slope 0.21 at the origin: it is scene-referred (1.0 is mid-grey) and would
 * darken a sparse field to a fifth of its brightness. Reinhard has slope 1 at the
 * origin — a faint halo passes through untouched — and a POWER-LAW shoulder, which
 * keeps discriminating far into the highlights (5 overlaps → 0.90, 30 → 0.98,
 * where an exponential shoulder is already flat at 1.0 by 5).
 *
 * Applying it to the MAGNITUDE rather than per-channel is the `c/(1+l)` branch of
 * the reference's `reinhardJodie` taken to its limit, and it is deliberate: both
 * the full Jodie mix and per-channel Reinhard DESATURATE the highlights, and
 * desaturating highlights is precisely the "oversaturated look" that was reported.
 * Measured on the same dense frame at the shipped Intensity 3 — halo pixels with a
 * channel pinned at 255: 37% (old screen+clamp) / 68% (full Jodie) / 2.5%
 * (hue-exact); near-WHITE pixels: 12.7% / 0.18% / 0.03%.
 *
 * SPACE. Accumulation is in DISPLAY units, not linear light — a deliberate
 * deviation from the reference, for two reasons: (1) the glow composites against a
 * backdrop we do not own (the CA grid / the page) through an 8-bit sRGB canvas, so
 * a linear-light round trip could not be closed end to end anyway; (2) it keeps
 * the four sliders (Size / Core / Intensity / Falloff) meaning exactly what they
 * meant, and — decisively — it is the space in which the CPU path's 8-bit
 * accumulation buffer is perceptually uniform.
 */

/** The exposure applied to the accumulated halo sum before the curve. Calibrated
 *  so a LONE halo at the shipped default Intensity 0.6 lands at ~0.49 display
 *  (it used to be exactly 0.6, hard-clamped). The ~20% an isolated halo gives up
 *  is what buys the entire range above it for accumulation — the same trade the
 *  reference makes (its glowIntensity slider tops out at 0.5 and its blend squares
 *  it, so a single particle contributes ~0.25 and the range comes from the sum). */
export const GLOW_TONE_EXPOSURE = 1.6;

/**
 * CPU-ONLY — the log-domain encoding scale.
 *
 * Canvas2D has no float render target, so the overlay cannot accumulate the halo
 * sum the way the HDR pipeline does. It accumulates it ENCODED instead, and the
 * encoding is exact rather than a fudge: Canvas2D `'screen'` is
 * `c ← s + c − s·c` on premultiplied colours, i.e. `(1−c) ← (1−c)(1−s)`. So if
 * each halo sprite bakes its alpha as `s = 1 − exp(−E·g)`, the accumulated buffer
 * holds EXACTLY
 *
 *     c = 1 − exp(−E · Σ g)
 *
 * — a bijective, monotone encoding of the exact sum, with NO clipping (c < 1
 * always) and, being logarithmic, far more resolution at the low end than a
 * scaled-down additive buffer would have. One `-log` decode per byte (a 256-entry
 * LUT) recovers Σ and the same Reinhard-Jodie curve then runs on it.
 *
 * E is chosen PER INTENSITY so the encodable range is a constant number of
 * OVERLAPPING HALOS rather than a constant sum: a single halo always encodes to
 * ~18% of the byte range, and the buffer saturates at ~27 overlaps whatever the
 * Intensity slider says.
 */
export function glowEncodeScale(intensity: number): number {
  return 0.2 / Math.max(1e-3, Math.max(1, intensity));
}

/** The byte the encoding treats as "saturated" — 255 means Σ = ∞, so the decode
 *  caps it at the midpoint of the last quantisation step instead (≈ 6.9/E,
 *  i.e. ~35 overlapping halos), which keeps the tonemap finite and the densest
 *  cores just short of pure white rather than NaN. */
const GLOW_DECODE_CAP = 1 - 0.25 / 255;

/**
 * The CPU decode+tonemap, as an SVG `feFuncA` transfer TABLE.
 *
 * WHY A FILTER AND NOT A PIXEL LOOP (measured, and it is the whole reason this
 * design works): reading the accumulation back to tonemap it in JS is not a
 * readback cost, it is a FLUSH cost — Chromium defers the thousands of blended
 * `drawImage` calls and the first read forces them synchronously.
 * `getImageData(0,0,1,1)` on the scratch measured **17.5 ms**, exactly the same
 * as reading the whole thing, while the identical blits with NO read cost 9-11 ms
 * total. So ANY per-pixel CPU pass roughly triples the glow's cost at ~5k agents.
 * A transfer function applied on the BLIT keeps every pixel on the GPU.
 *
 * IT WORKS BECAUSE THE MAGNITUDE LIVES IN THE ALPHA CHANNEL. SVG filter
 * primitives operate on UN-premultiplied RGBA, so for a scratch accumulated with
 * `'screen'` from sprites of premultiplied `(colour·a, a)`:
 *   - the alpha accumulates by the same screen rule ⇒ `A = 1 − exp(−E·Σg)`,
 *     the exact log encoding of the halo sum;
 *   - un-premultiplying gives `C = colour` (the hue), which the R/G/B funcs pass
 *     through untouched;
 *   - `feFuncA` remaps A → `T(Σ)`, and re-premultiplication yields
 *     `colour · T(Σ)` — a valid premultiplied pixel (rgb ≤ a) that the final
 *     SCREEN blit consumes exactly like the GPU compose does.
 *
 * HOW CLOSE THE TWO PATHS ARE, MEASURED (one hue, N overlapping halos at their
 * peak, Intensity 0.6, through the real filter against the GPU's formula):
 *   - the MAGNITUDE — the tonemapped brightness, which is what the shoulder and
 *     the whole plateau argument are about — matches to **≤ 0.4/255 at every N
 *     from 1 to 30**. That is the part that must agree, and it does, exactly.
 *   - the HUE matches to ≤ 11/255 out to ~5 overlaps, then the CPU DESATURATES
 *     progressively (80/255 on the weak channels at 30 overlaps). The GPU keeps
 *     the hue perfectly exact because it has the true per-channel sum; the CPU
 *     recovers the hue as `cb/ab`, and for a channel below 1 the screen
 *     accumulation `1-(1-c·a)^N` creeps up faster than `ab` does.
 * So: same curve, same limits, and the divergence is confined to the hue of the
 * very densest cores — where the CPU's mild desaturation is the ordinary filmic
 * behaviour anyway. Both are far from the old path, which at that density had
 * 52% of its lit pixels at near-white with 61-pixel flat plateaus.
 *
 * 256 entries = one per input byte, so the piecewise-linear interpolation is
 * exact for an 8-bit accumulation.
 */
export function glowTransferTable(encScale: number): string {
  const out: string[] = [];
  for (let i = 0; i < 256; i++) {
    const c = Math.min(GLOW_DECODE_CAP, i / 255);
    const v = (-Math.log(1 - c) / encScale) * GLOW_TONE_EXPOSURE;
    out.push((v / (1 + v)).toFixed(5));
  }
  return out.join(' ');
}
