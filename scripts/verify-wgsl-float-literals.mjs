// WGSL FLOAT-LITERAL RANGE GUARD.
//
// WHY THIS EXISTS (a real shipped defect, 2026-07-31):
//   The WebGPU compilers seeded a `min` fold with the WGSL literal `3.4028235e38`
//   — the *rounded* spelling of f32::MAX. WGSL parses a float literal to f64 and
//   then rejects it if that value does not fit f32, and 3.4028235e38 is
//   340282349999999991754788743781432688640, which is LARGER than f32::MAX
//   (340282346638528859811704183484516925440). Naga therefore rejected the whole
//   shader with "value ... cannot be represented as 'f32'", and the model SILENTLY
//   fell back off the WebGPU target:
//
//     [agents] WebGPU runtime build failed, falling back to JS:
//     [agents/webgpu] behaviour WGSL compile errors:
//       line 198: value 340282349999999991754788743781432688640.0
//                 cannot be represented as 'f32'
//
//   It escaped every existing gate because check-compile-identity HASHES emitted
//   text without ever handing it to a device, and the one shipped model that used
//   `aggregate.min` ships on the WASM agent target.
//
// WHAT IT CHECKS
//   Tier A — compiles EVERY shipped model and scans every emitted WGSL surface
//            (cell-grid step shader, agent behaviour shader, agent output-mapping
//            shaders, agent force-pass shader in all four variants) for a float
//            literal whose f64 value does not fit f32. This is the GENERAL rule:
//            it catches any future out-of-range constant, not just this one.
//   Tier B — asserts the specific bad spelling `3.4028235e38` appears nowhere in
//            src/ outside the documenting comment on WGSL_F32_MAX. Precise, cannot
//            false-positive, and names the exact regression.
//
// NEGATIVE CONTROL
//   node scripts/verify-wgsl-float-literals.mjs --self-test
//   Feeds the checker a synthetic shader carrying the bad literal and asserts it
//   is caught. A guard that only ever passes proves nothing.
import { build } from 'esbuild';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Largest finite f32. A literal above this cannot be represented. */
const F32_MAX = 3.4028234663852886e38;
/** Smallest positive f32 subnormal. A nonzero literal below this underflows to 0. */
const F32_MIN_SUBNORMAL = 1.401298464324817e-45;

/** WGSL decimal float literals: need a '.' or an exponent (bare ints are ints). */
const FLOAT_RE = /(?<![\w.])(\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)([fh])?(?![\w.])/g;

/** Scan one WGSL source for float literals that do not fit f32. */
export function scanWgslFloats(code, label) {
  const bad = [];
  const lines = String(code || '').split('\n');
  lines.forEach((line, i) => {
    // Skip line comments — a documenting comment may legitimately name the value.
    const src = line.replace(/\/\/.*$/, '');
    for (const m of src.matchAll(FLOAT_RE)) {
      const text = m[1];
      const suffix = m[2] || '';
      if (suffix === 'h') continue; // f16 literal, out of scope
      const v = Number(text);
      if (!Number.isFinite(v)) { bad.push({ label, line: i + 1, text, why: 'not finite' }); continue; }
      const a = Math.abs(v);
      if (a > F32_MAX) bad.push({ label, line: i + 1, text, why: `exceeds f32 max (${a} > ${F32_MAX})` });
      else if (a !== 0 && a < F32_MIN_SUBNORMAL) bad.push({ label, line: i + 1, text, why: `underflows f32 to zero (${a})` });
    }
  });
  return bad;
}

// ---------------------------------------------------------------- self-test
if (process.argv.includes('--self-test')) {
  const good = 'var a: f32 = 3.4028234663852886e38;\nlet b = -3.4028234663852886e38;\nlet c = 1.0;\nlet d = 2.3283064365386963e-10;\n';
  const bad = 'var a: f32 = 3.4028235e38;\nlet b: f32 = -3.4028235e38;\n';
  const worse = 'let x: f32 = 1e39;\nlet y: f32 = 1e-46;\n';
  let fails = 0;
  const expect = (cond, msg) => { if (!cond) { console.error(`FAIL ${msg}`); fails++; } else console.log(`  ok  ${msg}`); };
  expect(scanWgslFloats(good, 'g').length === 0, 'the correct f32-max spelling passes');
  expect(scanWgslFloats(bad, 'b').length === 2, 'the ROUNDED f32-max spelling is caught (both signs)');
  expect(scanWgslFloats(worse, 'w').length === 2, 'a plainly out-of-range literal and an underflow are caught');
  expect(scanWgslFloats('let n = 42u;\nlet m = 7;\nlet k = idx * 64u;', 'i').length === 0, 'integer literals are not float literals');
  expect(scanWgslFloats('// documents 3.4028235e38 as wrong', 'c').length === 0, 'a line comment is ignored');
  console.log(fails === 0 ? '\nself-test PASS' : `\nself-test FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- Tier A
const ENTRY = `
export { compileAll, migrateForHarness } from '../src/dev/compileHarness.ts';
export { compileAgentGraphWebGPUForModel } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { emitAgentForcePassWGSL } from '../src/modeler/vpl/compiler/agentWebgpu/forcePass.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-wgsl-'));
const entryPath = join(ROOT, 'scripts', '__wgsl_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT });
const mod = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

const { compileAll, migrateForHarness, compileAgentGraphWebGPUForModel, emitAgentForcePassWGSL } = mod;

const modelsDir = join(ROOT, 'public', 'models');
const files = readdirSync(modelsDir).filter((f) => f.endsWith('.gcaproj')).sort();

let surfaces = 0;
const findings = [];

for (const f of files) {
  const model = migrateForHarness(JSON.parse(readFileSync(join(modelsDir, f), 'utf8')));
  const name = f.replace(/\.gcaproj$/, '');
  const push = (code, what) => { if (code) { surfaces++; findings.push(...scanWgslFloats(code, `${name} :: ${what}`)); } };

  let r;
  try { r = compileAll(model); } catch (e) { console.error(`  !! ${name}: compileAll threw: ${e?.message || e}`); continue; }
  push(r.webgpu?.shaderCode, 'grid step shader');
  push(r.agent?.webgpu?.shaderCode, 'agent behaviour shader');
  for (const om of r.agent?.webgpu?.omShaders ?? []) push(om.code, `agent OM shader [${om.mappingId}]`);

  // The force pass is a SECOND GPU pipeline the harness does not surface, and it
  // has both a canonical and a bin-sorted MIRROR variant (B1) — a bad constant in
  // one and not the other diverges only for models that engage the mirror.
  try {
    const ar = compileAgentGraphWebGPUForModel(model);
    if (ar?.layout) {
      for (const scatter of [false, true]) for (const mirror of [false, true]) {
        push(emitAgentForcePassWGSL(ar.layout, scatter, mirror), `agent force pass [scatter=${scatter} mirror=${mirror}]`);
      }
    }
  } catch { /* a model whose agent layer does not compile has no force pass to scan */ }
}
rmSync(dir, { recursive: true, force: true });

// ---------------------------------------------------------------- Tier B
const BAD_SPELLING = '3.4028235e38';
const srcFiles = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(p);
  }
})(join(ROOT, 'src'));

const tierB = [];
for (const p of srcFiles) {
  const text = readFileSync(p, 'utf8');
  if (!text.includes(BAD_SPELLING)) continue;
  text.split('\n').forEach((line, i) => {
    if (!line.includes(BAD_SPELLING)) return;
    // The ONE sanctioned mention: the comment documenting why it is wrong.
    if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return;
    tierB.push({ file: p.slice(ROOT.length + 1), line: i + 1, text: line.trim().slice(0, 100) });
  });
}

// ---------------------------------------------------------------- report
console.log(`WGSL float-literal guard`);
console.log(`  Tier A: scanned ${surfaces} emitted WGSL surfaces across ${files.length} models`);
if (findings.length === 0) console.log(`          no out-of-range float literals`);
else for (const b of findings) console.log(`  FAIL   ${b.label} line ${b.line}: '${b.text}' — ${b.why}`);

console.log(`  Tier B: scanned ${srcFiles.length} source files for the rounded f32-max spelling`);
if (tierB.length === 0) console.log(`          '${BAD_SPELLING}' appears only in documentation`);
else for (const b of tierB) console.log(`  FAIL   ${b.file}:${b.line}: ${b.text}`);

const fail = findings.length + tierB.length;
console.log(fail === 0 ? '\nPASS' : `\nFAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
