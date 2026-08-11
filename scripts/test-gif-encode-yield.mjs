/**
 * GIF encode: the yielding path is BYTE-IDENTICAL to the non-yielding one.
 *
 * `encodeFramesToGif` became async so the busy overlay can paint and advance
 * during what is the longest main-thread block in the app (see `busyState.ts`
 * — a progress bar over a synchronous block is a lie). Suspending a loop is
 * only safe if nothing observable is reordered by it, so that is what this
 * asserts DIRECTLY: the same frames encoded with yields disabled
 * (`yieldBudgetMs: Infinity`) and with a yield after EVERY frame
 * (`yieldBudgetMs: 0`) must produce the same bytes and the same stats.
 *
 * The fixtures deliberately exercise all three branches the loop can take, so
 * the comparison is not vacuous:
 *   • runs of pixel-identical frames  → the identical-frame MERGE path
 *   • sparse localised change         → the delta probe WINS
 *   • dense scattered change          → the delta probe LOSES (full frame)
 *   • palette drift                   → the `prevRgb` decoded-image compare
 * A negative control at the end proves the comparison can actually fail.
 *
 * Run: node scripts/test-gif-encode-yield.mjs
 */
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { encodeFramesToGif } from '../src/simulator/recording/gifEncoder.ts';
export { yieldToPaint } from '../src/components/busyState.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-gifyield-'));
const entryPath = join(ROOT, 'scripts', '__gifyield_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({
  entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node',
  outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd(),
});
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

// --- fixtures --------------------------------------------------------------
// `ImageData` does not exist in Node, and the encoder only ever reads
// width/height/data — so a plain object is a faithful stand-in.
// Big enough that a SPARSE change is genuinely cheaper as a delta — at a tiny
// frame size the transparent index's LZW fragmentation always costs more than
// it saves, so the delta probe would reject every frame and the coverage
// assertions below would be vacuous.
const W = 160, H = 120;
const mkFrame = (paint) => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const [r, g, b] = paint(x, y);
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  }
  return { width: W, height: H, data };
};
// Deterministic PRNG so the fixture is identical run to run.
let seed = 0x2f6e2b1;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};

const frames = [];
// (a) three byte-identical frames → merge run
for (let k = 0; k < 3; k++) frames.push(mkFrame(() => [16, 24, 40]));
// (b) a small moving block over a STATIC TEXTURED background → the sparse-change
//     regime where the delta wins. The texture matters: over a flat field the
//     full frame is already one perfect LZW run and the delta can only lose, so
//     the background has to cost real bytes to re-encode for skipping it to pay.
const TEX = [[18, 26, 44], [30, 40, 62], [24, 52, 48], [44, 34, 40]];
const texAt = (x, y) => TEX[((x * 73 + y * 151 + ((x * y) >> 3)) >>> 0) % TEX.length];
for (let k = 0; k < 6; k++) {
  frames.push(mkFrame((x, y) => (x >= 10 + k * 6 && x < 16 + k * 6 && y >= 40 && y < 46)
    ? [240, 200, 60] : texAt(x, y)));
}
// (c) two more identical frames → a second merge run mid-file
for (let k = 0; k < 2; k++) frames.push(mkFrame(() => [16, 24, 40]));
// (d) dense scattered change → the delta probe should REJECT (full frame wins).
//     Drawn from a SMALL palette on purpose: what defeats the delta is change
//     that is dense and scattered, not colour variety — and true RGB noise makes
//     `quantize` (which the encoder runs per frame, twice per probe) pathological.
const NOISE_PALETTE = [[20, 30, 50], [230, 60, 60], [60, 200, 120], [250, 220, 80], [120, 90, 220]];
for (let k = 0; k < 4; k++) {
  frames.push(mkFrame(() => NOISE_PALETTE[Math.floor(rnd() * NOISE_PALETTE.length)]));
}
// (e) palette drift: the same *visual* content with slowly shifting colours,
//     which is what makes the decoded-image (`prevRgb`) compare load-bearing.
for (let k = 0; k < 6; k++) {
  frames.push(mkFrame((x, y) => ((x + y) & 8)
    ? [40 + k * 3, 90 + k * 2, 160 - k * 4] : [200 - k * 5, 60 + k, 30 + k * 6]));
}

const FPS = 20;
const OPTS = { maxSize: 512 };

const hex = (u8) => Buffer.from(u8).toString('hex');
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

console.log(`== fixtures: ${frames.length} frames @ ${W}x${H} ==`);

// --- 1. byte identity: no yields vs a yield after EVERY frame ---------------
console.log('== chunked vs sync byte identity ==');
const sync = await M.encodeFramesToGif(frames, FPS, { ...OPTS, yieldBudgetMs: Infinity });
const chunked = await M.encodeFramesToGif(frames, FPS, { ...OPTS, yieldBudgetMs: 0 });
const budgeted = await M.encodeFramesToGif(frames, FPS, { ...OPTS }); // shipped default (16 ms)

const bSync = await bytesOf(sync.blob);
const bChunk = await bytesOf(chunked.blob);
const bBudget = await bytesOf(budgeted.blob);

check('the fixture actually encodes something', bSync.length > 200, `${bSync.length} B`);
check('yield-every-frame is byte-identical to no-yield',
  bSync.length === bChunk.length && hex(bSync) === hex(bChunk),
  `${bSync.length} B vs ${bChunk.length} B`);
check('the SHIPPED default budget is byte-identical to no-yield',
  hex(bSync) === hex(bBudget), `${bSync.length} B vs ${bBudget.length} B`);
check('stats identical (no-yield vs yield-every-frame)',
  JSON.stringify(sync.stats) === JSON.stringify(chunked.stats),
  `${JSON.stringify(sync.stats)} vs ${JSON.stringify(chunked.stats)}`);

// --- 2. the fixture really exercises every branch ---------------------------
console.log('== fixture coverage (so the identity check is not vacuous) ==');
const s = sync.stats;
check('merge path taken', s.framesMerged > 0, `framesMerged=${s.framesMerged}`);
check('delta path taken', s.deltaFrames > 0, `deltaFrames=${s.deltaFrames}`);
check('delta REJECTED at least once', s.deltaRejected > 0, `deltaRejected=${s.deltaRejected}`);
check('global palette reused at least once', s.globalPaletteFrames > 0, `globalPaletteFrames=${s.globalPaletteFrames}`);
check('frames actually written', s.framesWritten > 1 && s.framesWritten < frames.length,
  `framesWritten=${s.framesWritten} of ${frames.length}`);

// --- 3. progress reporting --------------------------------------------------
console.log('== onProgress ==');
const seenDone = [];
const seenTotal = new Set();
await M.encodeFramesToGif(frames, FPS, {
  ...OPTS, yieldBudgetMs: 0,
  onProgress: (done, total) => { seenDone.push(done); seenTotal.add(total); },
});
check('onProgress fires', seenDone.length > 0, `${seenDone.length} calls`);
check('onProgress is monotonic non-decreasing',
  seenDone.every((v, i) => i === 0 || v >= seenDone[i - 1]), JSON.stringify(seenDone));
check('onProgress total is the input frame count',
  seenTotal.size === 1 && seenTotal.has(frames.length), [...seenTotal].join(','));
check('onProgress ends at 100%', seenDone[seenDone.length - 1] === frames.length,
  `last=${seenDone[seenDone.length - 1]} of ${frames.length}`);
check('onProgress never exceeds the total', seenDone.every(v => v <= frames.length));

// --- 4. yielding really happened (otherwise 1 proves nothing) ---------------
console.log('== the yield is real ==');
{
  // A macrotask posted BEFORE the encode starts must be able to run DURING it.
  // With no yields it can only run after the whole encode has finished.
  let ranDuring = false;
  let finished = false;
  const timer = setTimeout(() => { ranDuring = !finished; }, 0);
  await M.encodeFramesToGif(frames, FPS, { ...OPTS, yieldBudgetMs: 0 });
  finished = true;
  clearTimeout(timer);
  await new Promise(r => setTimeout(r, 0));
  check('the event loop runs during a yielding encode', ranDuring);
}
{
  let ranDuring = false;
  let finished = false;
  const timer = setTimeout(() => { ranDuring = !finished; }, 0);
  await M.encodeFramesToGif(frames, FPS, { ...OPTS, yieldBudgetMs: Infinity });
  finished = true;
  clearTimeout(timer);
  await new Promise(r => setTimeout(r, 0));
  check('NEG: the event loop does NOT run during a non-yielding encode', !ranDuring);
}

// --- 5. negative control: the byte comparison can fail ----------------------
console.log('== NEG: the comparison is not vacuous ==');
{
  const other = await M.encodeFramesToGif(frames, FPS, { ...OPTS, yieldBudgetMs: 0, delta: false });
  const bOther = await bytesOf(other.blob);
  check('NEG: a genuinely different encode produces different bytes',
    hex(bOther) !== hex(bSync), `${bOther.length} B vs ${bSync.length} B`);
  const dropped = frames.slice(0, frames.length - 1);
  const bDropped = await bytesOf((await M.encodeFramesToGif(dropped, FPS, OPTS)).blob);
  check('NEG: dropping one frame changes the bytes', hex(bDropped) !== hex(bSync));
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
