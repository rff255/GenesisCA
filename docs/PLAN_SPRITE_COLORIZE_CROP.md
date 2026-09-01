# Sprite COLORIZE + sprite CROP — plan

Two additive `SpriteAsset` options, both **render/decode-layer only** (nothing under
`src/modeler/vpl/compiler/`, no worker-protocol change beyond the existing sprite
atlas payload).

Illustrated: [PLAN_SPRITE_COLORIZE_CROP.html](PLAN_SPRITE_COLORIZE_CROP.html).

---

## 1. Colorize — one grayscale sprite, a whole coloured population

**`SpriteAsset.colorize?: boolean`** — absent ⇒ false ⇒ today's behaviour
byte-for-byte. When on, every sprite texel is MULTIPLIED by the agent's colour:

```
out.rgb = texel.rgb × agentColour.rgb / 255     (alpha UNCHANGED)
```

The agent colour is `s.colors` — the same buffer that already supplies sprite
ALPHA, so a Set Cell Looks / Agent Output Mapping colour ramp drives the tint with
no new plumbing. White art → the agent colour exactly; black art stays black;
mid-greys shade.

### The three render paths, and how each multiplies

| path | where | mechanism |
|---|---|---|
| 2D CPU overlay + simulation-scope capture | `resolveAgentSpriteDraw` / `paintAgentSprite` (SimulatorView) | a **cached tinted canvas** per (sprite, frame, quantised colour) |
| 2D worker billboard (A1/A2 direct render, E2 composite) | `agentSpriteWGSL` (agentWebgpuRuntime) | a `SPRITE_FLAG_COLORIZE` bit + a per-instance `tint` varying |
| 3D billboard | `SPRITE_VS`/`SPRITE_FS` (gl3d) | a per-instance `aTint` attribute |

**The CPU tint is EXACT, not a blend-mode approximation.** A `'multiply'` composite
+ `'destination-in'` alpha restore is the usual recipe, but the W3C separable-blend
formula makes a partially-transparent backdrop pixel come out as
`(1−ab)·Cs + ab·Cb·Cs` — i.e. anti-aliased sprite EDGES would be lightened toward
the tint rather than multiplied. Since the result is CACHED (built once per cache
entry, never per draw), a per-pixel pass is affordable and is exactly the GPU
semantic:

```ts
ctx.drawImage(frame, 0, 0);
const d = ctx.getImageData(...).data;
for (i) { d[i] *= r/255; d[i+1] *= g/255; d[i+2] *= b/255; }   // alpha untouched
```

This is the same shape `applyChromaKey` already uses. `getImageData` returns
UN-premultiplied bytes, so this is literally `texel.rgb × tint`.

*(Consistency across the paths: the WebGPU atlas is PREMULTIPLIED, and
`premult = straight × a`, so `(straight × tint) × a = premult × tint` — multiplying
the premultiplied rgb by the tint and leaving alpha alone is the same operation.
gl3d's atlas is straight-alpha and multiplies directly.)*

### The CPU cache

* Key = `spriteId | frameIndex | quantisedColour`, colour quantised to **5
  bits/channel** — the glow sprite cache's rule, so a Color-Scale agent viewer with
  hundreds of distinct colours collapses to a handful of canvases.
* **Dequantised as `(q<<3) | (q>>2)`**, NOT the glow cache's midpoint `(q<<3)|4`:
  that expansion is exact at both ends (0→0, 31→255), so a white sprite under a
  pure-red agent tints to exactly `#ff0000`, which is the semantic users will check.
  Max error elsewhere ≤ 4/255.
* Bounded on BOTH entry count (512) and total pixels (16 M ≈ 64 MB of RGBA),
  evicting **oldest-first** (Map insertion order) — never a wholesale clear on
  pressure.
* Cleared when the registry re-decodes (`onReady`) and on any sprite-set edit: the
  cached canvases are derived from `ImageBitmap`s the registry closes, so keying by
  `(id, frame)` would otherwise hold stale art after a crop/chroma edit.
* Cached as a **canvas, not an ImageBitmap** — the draw path is synchronous and
  `createImageBitmap` is async.

### The GPU paths

* **2D worker**: `SPRITE_FLAG_COLORIZE = 8` joins `LOOP`/`ORIENT`/`ABSOLUTE` as a
  FLAG BIT, so `SPRITE_META_BYTES` (32) and the packing never move — the precedent
  `SPRITE_FLAG_ABSOLUTE` set. The VS unpacks the agent's rgb into a `tint` varying
  (`vec3(1,1,1)` when off); the FS multiplies `t.rgb` by it. `t.rgb * vec3(1.0)` is
  bit-identical to `t.rgb`, so the OFF path is unchanged by construction.
* **3D**: the sprite instance record goes **9 → 12 floats**
  (`…, alpha, tintR, tintG, tintB`, stride 36 → 48), the tint written as `(1,1,1)`
  when the asset does not colorize. Chosen over packing the tint into one uint
  attribute (which would need the `vertexAttribIPointer` + `Uint32Array`-view
  juggling the voxel index uses) because the sprite instance buffer is small — 12
  floats × 10 k agents is 480 KB — and a uniform float record keeps one code path.
* Both are re-shipped/re-uploaded on a colorize flip for free: the `model.sprites`
  effect already sets `spriteAtlasDirtyRef` (→ `setSpriteAtlas` + a forced instance
  re-upload) and calls `shipSpriteAtlas` (→ the worker's meta buffer). The decode
  signature is deliberately NOT busted — colorize is render-time, so re-decoding
  would be pure waste.

---

## 2. Crop — for plain images, GIFs and frame sequences

Sprite SHEETS are cropped by their grid; a plain image / animated GIF / frame
sequence had no cropping at all and relied on the file being pre-trimmed.

**`SpriteAsset.crop?: { x, y, width, height }`** — source pixels, additive, absent
⇒ no crop. Applied at **DECODE time** (like the chroma key): after frame
extraction, before the chroma key, via `createImageBitmap(bmp, x, y, w, h)`.

* `src/model/spriteCrop.ts` — a dependency-free, DOM-free leaf (the `spriteSheet.ts`
  pattern) owning the ONE resolution rule, so the decoder, the dialog, the panel
  previews and the harness all agree:
  * `resolveSpriteCrop(crop, w, h)` → the clamped rect, or **null** meaning "use the
    whole frame". Clamped **per frame** (a sequence's frames may differ in size);
    a rect that is degenerate or falls fully outside a frame degrades to the FULL
    frame — never a zero-area bitmap.
  * `spriteWithCrop(...)` folds a rect equal to the full image back to ABSENT,
    mirroring `sheetWithCellSize` — a drag that lands back on the whole image keeps
    the legacy record shape.
* `spriteDecodeKey` gains `crop`, so an edit re-decodes → the registry's existing
  `onReady` flows the new frames to the CPU overlay, the gl3d atlas and the worker
  atlas with no extra wiring.
* Applied uniformly to every frame source (including a sheet's cells, where it
  reads as "trim each cell"); the UI only OFFERS it for non-sheet assets, because a
  sheet crops through its grid.

### The dialog

A lean **`SpriteCropDialog.tsx`** rather than an option inside `SpriteSheetDialog`
(that dialog is grid-specific: cols/rows/margins/gaps, the ordered cell strip, the
first-cell gizmo — none of which a plain image has). It inherits the established
discipline verbatim:

* a **FIXED-size letterboxed viewport** (the drag "feedback loop" rule — sizing the
  viewport to the image reflows the card mid-drag),
* pan (middle/right drag) + wheel zoom at the cursor, `−`/`+`/`Fit`,
* a crop box: drag inside to MOVE, drag the corner handle to RESIZE, drag outside to
  DRAW a new one; hit priority **handle → inside → outside**,
* `tryCapture` on real drags only (capturing on a plain press is what makes a canvas
  undrivable from a synthetic pointer event, and a synthetic pointerId throws),
* numeric x / y / w / h `NumberField`s + a **Full image** reset,
* a frame stepper for a sequence / animated source, so the box can be judged against
  a frame other than 0,
* Escape / backdrop-click cancels; Apply folds and writes.

Reached from the sprite detail editor as **Crop…** (with an "x,y w×h" summary and a
**Clear** when set). Deliberately NOT offered at IMPORT time: the sheet dialog is
the import step because a sheet is unusable until gridded, whereas an image is
perfectly usable uncropped — one fewer modal in the common path.

### Previews

`useSpriteFrameSrc` (the ONE preview source — list thumbnail, detail image and the
chroma-key `SpriteBgPicker`) applies the sheet rect and THEN the crop, matching the
decode order. So the picker samples within the cropped region, which is what the
user is looking at.

---

## 3. What is deliberately NOT done

* No colorize on the **agent DISC** path — a disc is already drawn in the agent's
  colour.
* No per-frame crop rects (one rect per asset; a sequence with differing crops is a
  sequence of differently-cropped files).
* No import-time crop modal (see above).
* No compiler change of any kind: `check-compile-identity` must stay at 29 models,
  all surfaces unchanged.
