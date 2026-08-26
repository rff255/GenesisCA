// Sprite-sheet GRIDDING verification — the pure geometry + frame-selection rules
// the decoder slices with and the dialog draws with.
//
// Discipline: this asserts VALUES (which source rect each frame is), not "it
// returned an array". The load-bearing claim is BACK-COMPAT — a sheet with no
// explicit selection must slice EXACTLY as it did before the selection existed —
// so tier B compares against an INDEPENDENT transcription of the pre-change
// `sliceSheet` arithmetic rather than against the shipped helper itself.
//
// Run from the repo root:  node scripts/test-sprite-sheet.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `spriteRegistry` is bundled too so the DECODE SIGNATURE (which is what makes an
// edited selection reach the renderer) is asserted on the shipped function.
const ENTRY = `export * from '../src/model/spriteSheet.ts';\nexport { spriteDecodeKey } from '../src/simulator/spriteRegistry.ts';\n`;
const dir = mkdtempSync(join(tmpdir(), 'gca-sheet-'));
const entryPath = join(ROOT, 'scripts', '__sheet_entry.ts');
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

/** The PRE-CHANGE `sliceSheet` rect arithmetic, transcribed verbatim from the
 *  shipped decoder as it stood before the frame selection existed. This is the
 *  ground truth tier B compares against — a second implementation, not a mirror. */
function legacyRects(sheet, imgW, imgH) {
  const cols = Math.max(1, Math.floor(sheet.cols || 1));
  const rows = Math.max(1, Math.floor(sheet.rows || 1));
  const mx = sheet.marginX || 0, my = sheet.marginY || 0;
  const sx = sheet.spacingX || 0, sy = sheet.spacingY || 0;
  const cw = Math.max(1, Math.floor((imgW - mx - (cols - 1) * sx) / cols));
  const ch = Math.max(1, Math.floor((imgH - my - (rows - 1) * sy) / rows));
  const total = Math.min(cols * rows, sheet.count && sheet.count > 0 ? Math.floor(sheet.count) : cols * rows);
  const out = [];
  for (let n = 0; n < total; n++) {
    const r = Math.floor(n / cols), c = n % cols;
    out.push({ x: mx + c * (cw + sx), y: my + r * (ch + sy), w: cw, h: ch });
  }
  return out;
}

console.log('\n=== Tier A — grid geometry ===');
{
  const g = M.sheetGrid({ cols: 4, rows: 4 }, 64, 64);
  eq('A1 plain 4x4 over 64x64 → 16x16 cells', [g.cellW, g.cellH], [16, 16]);
  eq('A2 cell count', M.sheetCellCount({ cols: 4, rows: 4 }), 16);

  // 100 - 4 margin - 2 gaps*2 = 92 / 3 cols = 30 (floored);
  //  60 - 2 margin - 1 gap*3  = 55 / 2 rows = 27 (floored).
  const g2 = M.sheetGrid({ cols: 3, rows: 2, marginX: 4, marginY: 2, spacingX: 2, spacingY: 3 }, 100, 60);
  eq('A3 margins + gaps → derived cell size', [g2.cellW, g2.cellH], [30, 27]);
  eq('A4 cell 0 rect', M.sheetCellRect(g2, 0), { x: 4, y: 2, w: 30, h: 27 });
  eq('A5 cell 4 (row 1, col 1) rect', M.sheetCellRect(g2, 4), { x: 36, y: 32, w: 30, h: 27 });
  eq('A6 cell 5 (last) rect', M.sheetCellRect(g2, 5), { x: 68, y: 32, w: 30, h: 27 });

  const g3 = M.sheetGrid({ cols: 0, rows: 0 }, 32, 32);
  eq('A7 degenerate cols/rows floor to 1', [g3.cols, g3.rows, g3.cellW, g3.cellH], [1, 1, 32, 32]);
  const g4 = M.sheetGrid({ cols: 100, rows: 1 }, 10, 10);
  check('A8 an over-fine grid still yields a >=1px cell', g4.cellW >= 1 && g4.cellH >= 1, JSON.stringify(g4));
}

console.log('\n=== Tier B — BACK-COMPAT: absent selection slices exactly as before ===');
{
  const specs = [
    ['plain 4x4', { cols: 4, rows: 4 }, 64, 64],
    ['count prefix', { cols: 4, rows: 4, count: 6 }, 64, 64],
    ['count above the grid', { cols: 3, rows: 3, count: 99 }, 90, 90],
    ['count 0 (falsy → all)', { cols: 2, rows: 2, count: 0 }, 40, 40],
    ['margins + gaps', { cols: 3, rows: 2, marginX: 4, marginY: 2, spacingX: 2, spacingY: 3 }, 100, 60],
    ['non-square cells', { cols: 5, rows: 2 }, 100, 30],
    ['single cell', { cols: 1, rows: 1 }, 17, 23],
    ['non-integer division', { cols: 3, rows: 3 }, 100, 100],
  ];
  for (const [name, sheet, w, h] of specs) {
    eq(`B: ${name}`, M.sheetFrameRects(sheet, w, h), legacyRects(sheet, w, h));
  }
  // Every cell rect must ALSO agree with the legacy walk when count is absent.
  eq('B: sheetCellRects === legacy full walk', M.sheetCellRects({ cols: 4, rows: 3, marginX: 1, spacingY: 2 }, 81, 62),
     legacyRects({ cols: 4, rows: 3, marginX: 1, spacingY: 2 }, 81, 62));
}

console.log('\n=== Tier C — the ordered selection ===');
{
  const base = { cols: 4, rows: 4 }; // 16 cells of 16x16 over 64x64
  const rectOf = i => M.sheetCellRect(M.sheetGrid(base, 64, 64), i);

  eq('C1 selection order is honoured', M.sheetFrameIndices({ ...base, frames: [5, 2, 9] }), [5, 2, 9]);
  eq('C2 the rects follow that order', M.sheetFrameRects({ ...base, frames: [5, 2, 9] }, 64, 64), [rectOf(5), rectOf(2), rectOf(9)]);

  // A selection is only meaningful if it can differ from the default — assert the
  // fixture DISCRIMINATES, so none of the above could pass by coincidence.
  check('C3 the fixture discriminates (selection !== row-major default)',
    JSON.stringify(M.sheetFrameIndices({ ...base, frames: [5, 2, 9] })) !== JSON.stringify(M.sheetFrameIndices(base)));

  // Duplicates: a ping-pong cycle. Same cell, decoded twice, same rect.
  const pp = M.sheetFrameRects({ ...base, frames: [0, 1, 2, 1] }, 64, 64);
  check('C4 duplicates are kept (4 frames)', pp.length === 4);
  eq('C4b the repeat is the same cell', [pp[1], pp[3]], [rectOf(1), rectOf(1)]);

  eq('C5 out-of-range indices are DROPPED (never clamped)', M.sheetFrameIndices({ ...base, frames: [0, 99, 2, -1] }), [0, 2]);
  check('C5b a dropped index is not silently the last cell',
    !JSON.stringify(M.sheetFrameIndices({ ...base, frames: [99] })).includes('15,15'));

  // All-out-of-range → the row-major default, honouring count. Never frameless.
  eq('C6 a fully stranded selection falls back to the default', M.sheetFrameIndices({ ...base, frames: [40, 50] }), [...Array(16).keys()]);
  eq('C6b … and that default still honours count', M.sheetFrameIndices({ ...base, count: 3, frames: [40] }), [0, 1, 2]);
  eq('C7 an EMPTY selection is treated as absent', M.sheetFrameIndices({ ...base, count: 2, frames: [] }), [0, 1]);

  eq('C8 frames SUPERSEDE count', M.sheetFrameIndices({ ...base, count: 2, frames: [7, 8, 9] }), [7, 8, 9]);
  check('C9 non-integers are dropped', JSON.stringify(M.pruneSheetFrames([1.5, 2, NaN, Infinity], 16)) === JSON.stringify([1, 2]),
    JSON.stringify(M.pruneSheetFrames([1.5, 2, NaN, Infinity], 16)));
  eq('C10 pruning preserves order AND duplicates', M.pruneSheetFrames([3, 99, 3, 0], 4), [3, 3, 0]);
  eq('C11 rowMajorFrames respects count', M.rowMajorFrames({ cols: 3, rows: 3, count: 4 }), [0, 1, 2, 3]);
}

console.log('\n=== Tier D — folding a selection back into the smallest spec ===');
{
  const base = { cols: 4, rows: 2, marginX: 3, spacingY: 1 }; // 8 cells

  const all = M.sheetWithFrames(base, [0, 1, 2, 3, 4, 5, 6, 7]);
  check('D1 the whole grid in order ⇒ no frames, no count', all.frames === undefined && all.count === undefined);
  eq('D1b … and the grid params survive', [all.cols, all.rows, all.marginX, all.spacingY], [4, 2, 3, 1]);

  const prefix = M.sheetWithFrames(base, [0, 1, 2]);
  check('D2 a row-major prefix ⇒ the legacy count shape', prefix.frames === undefined && prefix.count === 3);

  const custom = M.sheetWithFrames({ ...base, count: 5 }, [4, 5, 6]);
  eq('D3 an arbitrary selection ⇒ frames', custom.frames, [4, 5, 6]);
  check('D3b … and count is cleared (frames supersede it)', custom.count === undefined);

  const dup = M.sheetWithFrames(base, [0, 1, 0]);
  eq('D4 a duplicate is NOT a prefix', dup.frames, [0, 1, 0]);

  const stranded = M.sheetWithFrames(base, [2, 99, 3]);
  eq('D5 out-of-range is pruned on write too', stranded.frames, [2, 3]);

  // The fold must ROUND-TRIP: whatever shape it picks, the frames come back.
  for (const sel of [[0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2], [4, 5, 6], [0, 1, 0], [7]]) {
    eq(`D6 round trip ${JSON.stringify(sel)}`, M.sheetFrameIndices(M.sheetWithFrames(base, sel)), sel);
  }
}

console.log('\n=== Tier E — the decode signature (what makes an edit reach the screen) ===');
{
  const asset = { id: 's1', dataUrl: 'data:image/png;base64,AAA', mimeType: 'image/png', sheet: { cols: 4, rows: 4 } };
  const k0 = M.spriteDecodeKey(asset);
  check('E1 identical specs → identical key', M.spriteDecodeKey({ ...asset }) === k0);
  check('E2 adding a selection CHANGES the key',
    M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, frames: [1, 2] } }) !== k0);
  check('E3 REORDERING the selection changes the key',
    M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, frames: [1, 2] } })
      !== M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, frames: [2, 1] } }));
  check('E4 a DUPLICATE changes the key',
    M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, frames: [1, 2] } })
      !== M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, frames: [1, 2, 1] } }));
  check('E5 a grid param changes the key',
    M.spriteDecodeKey({ ...asset, sheet: { cols: 5, rows: 4 } }) !== k0);
  // A non-decode edit must NOT re-decode (scale/rotation/loop are render meta).
  check('E6 an unrelated field does NOT change the key',
    M.spriteDecodeKey({ ...asset, name: 'renamed', scale: 3, loop: false, rotationOffset: 90 }) === k0);
  // The gizmo's cell-size edit has to reach the decoder the same way a grid edit
  // does — that is what makes a drag show up on the CPU overlay / gl3d / GPU atlas.
  check('E7 an EXPLICIT cell size changes the key',
    M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, cellW: 12 } }) !== k0);
  check('E7b … and changing it again changes it again',
    M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, cellW: 12 } })
      !== M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, cellW: 13 } }));
  check('E7c cellH is independent of cellW',
    M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, cellW: 12, cellH: 12 } })
      !== M.spriteDecodeKey({ ...asset, sheet: { cols: 4, rows: 4, cellW: 12, cellH: 13 } }));
  // The FOLD's payoff: a drag that lands back on the derived geometry produces a
  // record indistinguishable from one that never carried a size — so it does not
  // force a pointless re-decode either.
  check('E8 a folded (absent) size keys identically to a never-sized sheet',
    M.spriteDecodeKey({ ...asset, sheet: M.sheetWithCellSize({ cols: 4, rows: 4 }, 16, 16, 64, 64) }) === k0);
}

console.log('\n=== Tier F — the EXPLICIT cell size (the first-cell gizmo) ===');
{
  // ABSENT is the historical path. Assert the derived helper IS the legacy formula
  // for every tier-B spec, so "absent ⇒ byte-for-byte" rests on a second source.
  for (const [name, sheet, w, h] of [
    ['plain 4x4', { cols: 4, rows: 4 }, 64, 64],
    ['margins + gaps', { cols: 3, rows: 2, marginX: 4, marginY: 2, spacingX: 2, spacingY: 3 }, 100, 60],
    ['non-square cells', { cols: 5, rows: 2 }, 100, 30],
    ['non-integer division', { cols: 3, rows: 3 }, 100, 100],
  ]) {
    const legacy = legacyRects(sheet, w, h)[0];
    const d = M.derivedCellSize(sheet, w, h);
    eq(`F1 derived === legacy cell size (${name})`, [d.cellW, d.cellH], [legacy.w, legacy.h]);
    const g = M.sheetGrid(sheet, w, h);
    eq(`F1b … and an ABSENT size resolves to it (${name})`, [g.cellW, g.cellH], [d.cellW, d.cellH]);
  }

  // Hand-computed geometry. 4x4 over 64x64 derives 16x16, so 12x10 DISCRIMINATES.
  const ex = { cols: 4, rows: 4, cellW: 12, cellH: 10 };
  const ge = M.sheetGrid(ex, 64, 64);
  eq('F2 an explicit size is used verbatim', [ge.cellW, ge.cellH], [12, 10]);
  check('F2b the fixture discriminates (explicit !== derived)',
    JSON.stringify([ge.cellW, ge.cellH]) !== JSON.stringify([16, 16]));
  eq('F3 cell 0 rect', M.sheetCellRect(ge, 0), { x: 0, y: 0, w: 12, h: 10 });
  eq('F3b cell 3 (row 0, col 3) rect', M.sheetCellRect(ge, 3), { x: 36, y: 0, w: 12, h: 10 });
  eq('F3c cell 5 (row 1, col 1) rect', M.sheetCellRect(ge, 5), { x: 12, y: 10, w: 12, h: 10 });

  // Explicit size ON TOP of margins + gaps: the step is (cell + gap), from the margin.
  const ex2 = { cols: 3, rows: 2, marginX: 4, marginY: 2, spacingX: 2, spacingY: 3, cellW: 20, cellH: 15 };
  const g2 = M.sheetGrid(ex2, 100, 60);
  eq('F4 explicit size with margins + gaps', [g2.cellW, g2.cellH], [20, 15]);
  eq('F4b cell 0 sits at the margin', M.sheetCellRect(g2, 0), { x: 4, y: 2, w: 20, h: 15 });
  eq('F4c cell 4 (row 1, col 1) steps by cell+gap', M.sheetCellRect(g2, 4), { x: 26, y: 20, w: 20, h: 15 });
  check('F4d the fixture discriminates', JSON.stringify([g2.cellW, g2.cellH]) !== JSON.stringify([30, 27]));

  // THE MOTIVATING CASE — a sheet with trailing dead space. 3 cells of 30 px in a
  // 100 px image: the derived size (33) is WRONG and no cols/rows value can fix it.
  const dead = { cols: 3, rows: 1, cellW: 30, cellH: 30 };
  eq('F5 dead space: derived would be wrong', [M.derivedCellSize(dead, 100, 100).cellW], [33]);
  eq('F5b … the explicit size grids it correctly',
    M.sheetCellRects(dead, 100, 100).map(r => r.x), [0, 30, 60]);

  // One axis explicit, the other derived — they are independent.
  const half = M.sheetGrid({ cols: 4, rows: 4, cellW: 9 }, 64, 64);
  eq('F6 one axis explicit, the other derived', [half.cellW, half.cellH], [9, 16]);

  // Sanitisation: a hand-edited 0 / negative / NaN must never yield a zero-area cell.
  for (const [name, bad] of [['0', 0], ['negative', -5], ['NaN', NaN], ['Infinity', Infinity]]) {
    const g = M.sheetGrid({ cols: 4, rows: 4, cellW: bad, cellH: bad }, 64, 64);
    eq(`F7 a ${name} explicit size falls back to derived`, [g.cellW, g.cellH], [16, 16]);
  }
  eq('F7b a fractional explicit size floors', [M.sheetGrid({ cols: 4, rows: 4, cellW: 7.9 }, 64, 64).cellW], [7]);

  // A cell may now hang off the image. The rect is reported HONESTLY (the decoder's
  // createImageBitmap crops with transparent padding); it is never clamped, because a
  // clamp would silently resize one frame.
  const over = M.sheetCellRect(M.sheetGrid({ cols: 4, rows: 1, cellW: 20, cellH: 20 }, 64, 64), 3);
  eq('F8 a cell past the image edge is reported, not clamped', over, { x: 60, y: 0, w: 20, h: 20 });
  check('F8b … and it really does overhang', over.x + over.w > 64);

  // The selection rides the explicit geometry unchanged.
  eq('F9 frames follow the explicit geometry',
    M.sheetFrameRects({ ...ex, frames: [5, 0] }, 64, 64),
    [M.sheetCellRect(ge, 5), M.sheetCellRect(ge, 0)]);
}

console.log('\n=== Tier G — folding the cell size back to the smallest spec ===');
{
  const base = { cols: 4, rows: 4, marginX: 0, marginY: 0 }; // derives 16x16 over 64x64

  const folded = M.sheetWithCellSize(base, 16, 16, 64, 64);
  check('G1 a size EQUAL to the derived one is not stored',
    folded.cellW === undefined && folded.cellH === undefined);
  eq('G1b … and the grid params survive', [folded.cols, folded.rows], [4, 4]);
  check('G1c … so it keys identically to a never-sized sheet',
    JSON.stringify(folded) === JSON.stringify(base));

  const kept = M.sheetWithCellSize(base, 12, 10, 64, 64);
  eq('G2 a size that DIFFERS is stored', [kept.cellW, kept.cellH], [12, 10]);

  const mixed = M.sheetWithCellSize(base, 16, 10, 64, 64);
  check('G3 the axes fold independently', mixed.cellW === undefined && mixed.cellH === 10);

  const cleared = M.sheetWithCellSize({ ...base, cellW: 12, cellH: 10 }, null, null, 64, 64);
  check('G4 null clears an existing explicit size', cleared.cellW === undefined && cleared.cellH === undefined);

  // The fold compares against the derived size of the spec WITHOUT the old explicit
  // keys — otherwise an explicit size would compare against itself and never fold.
  const remargined = M.sheetWithCellSize({ ...base, marginX: 4, cellW: 99 }, 15, 16, 64, 64);
  check('G5 the comparison uses the CURRENT derived size', remargined.cellW === undefined,
    JSON.stringify(remargined));
  eq('G5b … (that derived size really is 15)', [M.derivedCellSize({ ...base, marginX: 4 }, 64, 64).cellW], [15]);

  for (const [name, bad] of [['0', 0], ['negative', -3], ['fractional', 12.7]]) {
    const s = M.sheetWithCellSize(base, bad, null, 64, 64);
    check(`G6 a ${name} size is sanitised on write`, s.cellW === undefined || s.cellW >= 1,
      JSON.stringify(s));
  }
  eq('G6b a fractional size floors on write', [M.sheetWithCellSize(base, 12.7, null, 64, 64).cellW], [12]);

  // ROUND TRIP: whatever shape the fold picks, the size comes back out of sheetGrid.
  for (const [w, h] of [[16, 16], [12, 10], [1, 1], [64, 64], [16, 10], [30, 16]]) {
    const g = M.sheetGrid(M.sheetWithCellSize(base, w, h, 64, 64), 64, 64);
    eq(`G7 round trip ${w}x${h}`, [g.cellW, g.cellH], [w, h]);
  }

  // The two folds compose: a selection fold must not disturb the size, or vice versa.
  const both = M.sheetWithCellSize(M.sheetWithFrames({ ...base, cellW: 12 }, [2, 1]), 12, null, 64, 64);
  eq('G8 the frame fold and the size fold compose', [both.frames, both.cellW, both.count], [[2, 1], 12, undefined]);
}

rmSync(dir, { recursive: true, force: true });
try { unlinkSync(entryPath); } catch { /* already gone */ }
console.log(failures === 0 ? '\nAll sprite-sheet checks passed.' : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
