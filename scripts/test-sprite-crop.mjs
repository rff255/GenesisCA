// Sprite CROP + COLORIZE verification — the pure rules the decoder, the dialog and
// the panel previews all derive from.
//
// Discipline: this asserts VALUES (which source rect a frame resolves to; what a
// tint multiplies to), not "it returned an object". The two load-bearing claims are
//
//   1. ABSENT ⇒ the historical decode, byte-for-byte. A crop that is missing,
//      degenerate, fully outside the frame or selects the whole image must resolve
//      to NULL, because null is what every caller's no-crop fast path keys on.
//   2. The COLORIZE multiply is exactly `rgb x tint, alpha untouched`, and its
//      quantisation is EXACT at both ends — white art under a pure-red agent must
//      be exactly #ff0000, which is the first thing a user checks.
//
// Run from the repo root:  node scripts/test-sprite-crop.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `spriteRegistry` rides along so the DECODE SIGNATURE — what makes an edited crop
// reach the renderer at all — is asserted on the shipped function.
const ENTRY = `export * from '../src/model/spriteCrop.ts';\nexport { spriteDecodeKey } from '../src/simulator/spriteRegistry.ts';\n`;
const dir = mkdtempSync(join(tmpdir(), 'gca-crop-'));
const entryPath = join(ROOT, 'scripts', '__crop_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const src = (p) => readFileSync(join(ROOT, p), 'utf8');

console.log('\n=== Tier A — resolveSpriteCrop: the no-crop cases ALL return null ===');
{
  // Null is not tidiness: every caller's historical path is keyed on it, so any of
  // these returning a rect would put a needless bitmap copy (or a canvas) on a
  // model that asked for no crop at all.
  eq('A1 absent', M.resolveSpriteCrop(undefined, 64, 64), null);
  eq('A2 null', M.resolveSpriteCrop(null, 64, 64), null);
  eq('A3 zero width', M.resolveSpriteCrop({ x: 0, y: 0, width: 0, height: 10 }, 64, 64), null);
  eq('A4 negative height', M.resolveSpriteCrop({ x: 0, y: 0, width: 10, height: -3 }, 64, 64), null);
  eq('A5 NaN', M.resolveSpriteCrop({ x: NaN, y: 0, width: 10, height: 10 }, 64, 64), null);
  eq('A6 fully right of the frame', M.resolveSpriteCrop({ x: 64, y: 0, width: 10, height: 10 }, 64, 64), null);
  eq('A7 fully below the frame', M.resolveSpriteCrop({ x: 0, y: 100, width: 10, height: 10 }, 64, 64), null);
  eq('A8 fully left (negative)', M.resolveSpriteCrop({ x: -20, y: 0, width: 10, height: 10 }, 64, 64), null);
  eq('A9 the WHOLE image is no crop', M.resolveSpriteCrop({ x: 0, y: 0, width: 64, height: 64 }, 64, 64), null);
  eq('A10 larger than the image clamps to the whole image ⇒ null',
    M.resolveSpriteCrop({ x: -5, y: -5, width: 200, height: 200 }, 64, 64), null);
}

console.log('\n=== Tier B — resolveSpriteCrop: real rects, by value ===');
{
  eq('B1 interior rect passes through', M.resolveSpriteCrop({ x: 10, y: 12, width: 20, height: 8 }, 64, 64), { x: 10, y: 12, w: 20, h: 8 });
  // Clamping is per FRAME, which is the whole reason a sequence can carry one rect.
  eq('B2 overhanging right/bottom clamps', M.resolveSpriteCrop({ x: 50, y: 50, width: 40, height: 40 }, 64, 64), { x: 50, y: 50, w: 14, h: 14 });
  eq('B3 straddling the origin clamps', M.resolveSpriteCrop({ x: -4, y: -6, width: 20, height: 20 }, 64, 64), { x: 0, y: 0, w: 16, h: 14 });
  eq('B4 fractional input floors', M.resolveSpriteCrop({ x: 3.9, y: 4.2, width: 10.8, height: 9.1 }, 64, 64), { x: 3, y: 4, w: 10, h: 9 });
  eq('B5 1x1 at the far corner', M.resolveSpriteCrop({ x: 63, y: 63, width: 1, height: 1 }, 64, 64), { x: 63, y: 63, w: 1, h: 1 });

  // THE SEQUENCE CASE: ONE rect against frames of DIFFERENT sizes. The small frame
  // must clamp, and a frame smaller than the rect's origin must degrade to the WHOLE
  // frame rather than to a zero-area bitmap that would take the sprite off screen.
  const rect = { x: 20, y: 20, width: 30, height: 30 };
  eq('B6 sequence — big frame', M.resolveSpriteCrop(rect, 100, 100), { x: 20, y: 20, w: 30, h: 30 });
  eq('B7 sequence — smaller frame clamps', M.resolveSpriteCrop(rect, 40, 45), { x: 20, y: 20, w: 20, h: 25 });
  eq('B8 sequence — frame smaller than the origin ⇒ whole frame', M.resolveSpriteCrop(rect, 16, 16), null);
}

console.log('\n=== Tier C — clampSpriteCrop (the EDITING rule) never vanishes ===');
{
  // The dialog's rect is the thing being dragged, so unlike resolveSpriteCrop it must
  // stay valid and visible at every intermediate value a drag produces.
  eq('C1 in-range passes through', M.clampSpriteCrop({ x: 5, y: 6, width: 10, height: 11 }, 64, 64), { x: 5, y: 6, width: 10, height: 11 });
  eq('C2 negative origin clamps to 0', M.clampSpriteCrop({ x: -10, y: -3, width: 10, height: 10 }, 64, 64), { x: 0, y: 0, width: 10, height: 10 });
  eq('C3 origin past the edge clamps inside', M.clampSpriteCrop({ x: 999, y: 999, width: 10, height: 10 }, 64, 64), { x: 63, y: 63, width: 1, height: 1 });
  eq('C4 oversize clamps to the remaining extent', M.clampSpriteCrop({ x: 60, y: 0, width: 40, height: 40 }, 64, 64), { x: 60, y: 0, width: 4, height: 40 });
  eq('C5 zero size floors to 1 (never a vanished box)', M.clampSpriteCrop({ x: 3, y: 3, width: 0, height: 0 }, 64, 64), { x: 3, y: 3, width: 1, height: 1 });
  eq('C6 fullSpriteCrop is the whole image', M.fullSpriteCrop(80, 40), { x: 0, y: 0, width: 80, height: 40 });
  check('C7 clamping is idempotent', JSON.stringify(M.clampSpriteCrop(M.clampSpriteCrop({ x: -5, y: 300, width: 900, height: 2 }, 64, 64), 64, 64))
    === JSON.stringify(M.clampSpriteCrop({ x: -5, y: 300, width: 900, height: 2 }, 64, 64)));
}

console.log('\n=== Tier D — the FOLD: a full-image rect is not stored ===');
{
  // The `sheetWithCellSize` rule applied to the rectangle: a drag that lands back on
  // the whole image must leave the asset exactly as it was, so every consumer stays
  // on the no-crop path instead of carrying an identity rect forever.
  eq('D1 whole image folds to absent', M.spriteCropPatch({ x: 0, y: 0, width: 64, height: 64 }, 64, 64), { crop: undefined });
  eq('D2 oversize folds to absent (it clamps to the whole image)', M.spriteCropPatch({ x: -9, y: -9, width: 500, height: 500 }, 64, 64), { crop: undefined });
  eq('D3 null clears', M.spriteCropPatch(null, 64, 64), { crop: undefined });
  eq('D4 a real rect is kept, clamped', M.spriteCropPatch({ x: 4, y: 4, width: 200, height: 8 }, 64, 64), { crop: { x: 4, y: 4, width: 60, height: 8 } });
  check('D5 spriteCropIsFull agrees with the fold',
    M.spriteCropIsFull({ x: 0, y: 0, width: 64, height: 64 }, 64, 64) === true
    && M.spriteCropIsFull({ x: 1, y: 0, width: 63, height: 64 }, 64, 64) === false
    && M.spriteCropIsFull(undefined, 64, 64) === true);
}

console.log('\n=== Tier E — the decode signature carries crop, and NOT colorize ===');
{
  const base = { id: 's', dataUrl: 'data:x', mimeType: 'image/png' };
  const k0 = M.spriteDecodeKey(base);
  check('E1 adding a crop changes the decode key', M.spriteDecodeKey({ ...base, crop: { x: 1, y: 2, width: 3, height: 4 } }) !== k0);
  check('E2 EDITING the crop changes the key',
    M.spriteDecodeKey({ ...base, crop: { x: 1, y: 2, width: 3, height: 4 } })
    !== M.spriteDecodeKey({ ...base, crop: { x: 1, y: 2, width: 3, height: 5 } }));
  // colorize is a RENDER-time tint that changes no frame — busting the decode cache
  // for it would re-decode every sprite for nothing.
  check('E3 colorize does NOT change the decode key', M.spriteDecodeKey({ ...base, colorize: true }) === k0);
  check('E4 an unrelated field does not change the key', M.spriteDecodeKey({ ...base, scale: 3, name: 'x' }) === k0);
}

console.log('\n=== Tier F — COLORIZE: the multiply + its quantisation ===');
{
  // The CPU cache quantises the agent colour to 5 bits/channel with a MATCHED pair:
  // round(v*31/255) down, (q<<3)|(q>>2) (≈ q*255/31) back up. Exact at 0 and 255 —
  // which is what makes "white art under a pure-red agent is exactly #ff0000" true —
  // and within 4/255 in between.
  const q5 = v => Math.round(v * 31 / 255);
  const deq = v => { const q = q5(v); return (q << 3) | (q >> 2); };
  eq('F1 0 dequantises to 0', deq(0), 0);
  eq('F2 255 dequantises to 255', deq(255), 255);
  check('F3 the error never exceeds 4/255', (() => {
    let worst = 0;
    for (let v = 0; v <= 255; v++) worst = Math.max(worst, Math.abs(deq(v) - v));
    return worst <= 4;
  })(), 'a visible step would show as banding on a colour ramp');
  // F3 is only a real constraint if a MISMATCHED pair fails it — and the obvious
  // mismatch (the glow cache's floor quantiser against this expansion) reaches 11
  // while STILL mapping white to white, so it would sail past F2/F5 unnoticed.
  check('F3b a MISMATCHED quantiser would NOT hold that bound', (() => {
    let worst = 0;
    for (let v = 0; v <= 255; v++) { const q = v >> 3; worst = Math.max(worst, Math.abs(((q << 3) | (q >> 2)) - v)); }
    return worst > 4;
  })());
  check('F4 dequantisation is monotone', (() => {
    for (let v = 1; v <= 255; v++) if (deq(v) < deq(v - 1)) return false;
    return true;
  })());

  // The multiply itself, on the cases the feature is judged by. EXACT at the ends
  // (that is the point of the quantiser above); within 4/255 in between, which is
  // what 5-bit quantisation costs and is invisible in a tint.
  const mul = (texel, tint) => Math.round(texel * (deq(tint) / 255));
  eq('F5 white texel × a full tint = the tint EXACTLY', [mul(255, 255), mul(255, 0)], [255, 0]);
  check('F5b white texel × a mid tint is within the quantisation bound', Math.abs(mul(255, 128) - 128) <= 4, `got ${mul(255, 128)}`);
  eq('F6 black texel stays black', [mul(0, 255), mul(0, 128)], [0, 0]);
  eq('F7 mid grey shades (the art keeps its shading)', mul(128, 255), 128);
  check('F7b the quantiser in the source is the MATCHED rounding one',
    /Math\.round\(v \* 31 \/ 255\)/.test(src('src/simulator/SimulatorView.tsx')),
    'a floor quantiser against the (q<<3)|(q>>2) expansion is the mismatch F3b describes');

  // The source pins: alpha must NEVER be touched by the tint on any path, or the
  // silhouette changes with the agent's colour.
  const sv = src('src/simulator/SimulatorView.tsx');
  check('F8 the CPU bake multiplies rgb only', /d\[i\] = d\[i\]! \* tr;/.test(sv) && /d\[i \+ 2\] = d\[i \+ 2\]! \* tb;/.test(sv)
    && !/d\[i \+ 3\] =/.test(sv.slice(sv.indexOf('function tintedSpriteFrame'), sv.indexOf('function tintedSpriteFrame') + 2600)));
  check('F9 the CPU dequantisation is the exact-at-both-ends expansion',
    /\(\(qr << 3\) \| \(qr >> 2\)\) \/ 255/.test(sv));
  check('F10 the tint cache is bounded on entries AND pixels, evicting oldest-first',
    /SPRITE_TINT_MAX_ENTRIES/.test(sv) && /SPRITE_TINT_MAX_PIXELS/.test(sv)
    && /SPRITE_TINTS\.keys\(\)\.next\(\)/.test(sv));
  check('F11 the cache is cleared on a re-decode AND on a sprite-set edit',
    (sv.match(/clearSpriteTintCache\(\);/g) ?? []).length >= 2,
    'a stale entry would keep painting the pre-crop / pre-key art');

  const gl = src('src/simulator/render/gl3d.ts');
  check('F12 gl3d multiplies rgb only, alpha untouched', /outColor = vec4\(t\.rgb \* vTint, a\);/.test(gl));
  check('F13 gl3d writes an exact (1,1,1) identity when the asset does not colorize',
    /sp\[so \+ 9\] = meta\.colorize \? snap\.colors\[c\]! \/ 255 : 1;/.test(gl));
  check('F14 the gl3d instance stride has ONE definition', /SPRITE_INST_FLOATS = 12;/.test(gl)
    && /const SS = Gl3DRenderer\.SPRITE_INST_FLOATS \* 4;/.test(gl)
    && !/, 36, /.test(gl.slice(gl.indexOf('this.spriteProg = compileProgram'), gl.indexOf('this.spriteProg = compileProgram') + 1400)),
    'a stale literal 36 stride would read every instance past the first from the wrong offset');
}

console.log('\n=== Tier G — the decoder applies the crop BEFORE the chroma key ===');
{
  const reg = src('src/simulator/spriteRegistry.ts');
  const cropAt = reg.indexOf('if (spec.crop) {');
  const keyAt = reg.indexOf('if (spec.removeBgColor) {');
  check('G1 the crop block exists and precedes the chroma key', cropAt > 0 && keyAt > cropAt,
    'the key must only ever see the pixels the user kept');
  check('G2 the crop resolves through the SHARED rule (not a local reimplementation)',
    /resolveSpriteCrop\(spec\.crop, f\.width, f\.height\)/.test(reg));
  check('G3 a null resolution keeps the ORIGINAL bitmap (no copy, no close)',
    /if \(!r\) \{ cropped\.push\(f\); continue; \}/.test(reg));
  check('G4 a cropped frame closes the bitmap it superseded', /f\.close\(\);\s+\/\/ superseded/.test(reg));
}

rmSync(dir, { recursive: true, force: true });
try { unlinkSync(entryPath); } catch { /* already gone */ }
console.log(failures === 0 ? '\nAll sprite crop/colorize checks passed.' : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
