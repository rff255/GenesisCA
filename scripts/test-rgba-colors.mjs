// RGBA colours — the regression standard for alpha through the colour-producer chain.
//
//   node scripts/test-rgba-colors.mjs
//
// WHY THIS EXISTS: the shipped library provides ZERO coverage for the paths this
// feature adds. Audited across all 23 models in public/models:
//
//   * colour MODEL ATTRIBUTE (the `_a` slot)  ->  0 models   <- the HIGHEST-risk subsystem
//   * getColorConstant                        ->  0 models
//   * makeColor / breakColor                  ->  0 models
//   * agent linked OM                         ->  0 models
//
// So `check-compile-identity.mjs` can prove we did not BREAK anything, but it can
// prove nothing about whether the new code WORKS. That is this file's job, and it
// asserts VALUES (an alpha of 128 arrives as 128) rather than "it compiled" —
// following the scripts/test-grid-dimensions.mjs precedent, which exists because
// bit-parity alone would happily pass if both targets were wrong together.
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export * from '../src/model/colorHex.ts';
export { compileGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel, buildViewerIds } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { compileGraphWebGPU } from '../src/modeler/vpl/compiler/webgpu/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { colorScaleHasAlpha } from '../src/modeler/vpl/nodes/ColorScaleNode.ts';
export { categoricalHasAlpha } from '../src/modeler/vpl/nodes/CategoricalColorNode.ts';
export { colorConstantHasAlpha } from '../src/modeler/vpl/nodes/GetColorConstantNode.ts';
export { getNodeDef } from '../src/modeler/vpl/nodes/registry.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-rgba-'));
const entryPath = join(ROOT, 'scripts', '__rgba_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let pass = 0, fail = 0;
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL  ${what}\n        expected ${e}\n        actual   ${a}`); }
};
const section = (s) => console.log(`\n── ${s}`);

// ───────────────────────────────────────────────────────────── colorHex
section('colorHex — parsing');
eq(M.hexToRgba('#808080'), { r: 128, g: 128, b: 128, a: 255 }, '6-digit → opaque (absent alpha = 255)');
eq(M.hexToRgba('#80808000'), { r: 128, g: 128, b: 128, a: 0 }, '8-digit → alpha 0');
eq(M.hexToRgba('#ff000080'), { r: 255, g: 0, b: 0, a: 128 }, '8-digit → alpha 128');
eq(M.hexToRgba('#abc'), { r: 170, g: 187, b: 204, a: 255 }, '3-digit shorthand doubles nibbles');
eq(M.hexToRgba('#abcd'), { r: 170, g: 187, b: 204, a: 221 }, '4-digit shorthand carries alpha');
eq(M.hexToRgba('808080'), { r: 128, g: 128, b: 128, a: 255 }, 'leading # optional');
eq(M.hexToRgba('  #ff000080  '), { r: 255, g: 0, b: 0, a: 128 }, 'whitespace tolerated');

section('colorHex — malformed input must not throw (render/compile safety)');
eq(M.hexToRgba(undefined), { r: 0, g: 0, b: 0, a: 255 }, 'undefined → opaque black fallback');
eq(M.hexToRgba(''), { r: 0, g: 0, b: 0, a: 255 }, 'empty → fallback');
eq(M.hexToRgba('not-a-colour'), { r: 0, g: 0, b: 0, a: 255 }, 'garbage → fallback');
eq(M.hexToRgba('#12345'), { r: 0, g: 0, b: 0, a: 255 }, '5 digits is not valid CSS → fallback');
eq(M.hexToRgba('#1234567'), { r: 0, g: 0, b: 0, a: 255 }, '7 digits is not valid CSS → fallback');
eq(M.hexToRgba('#zzzzzz'), { r: 0, g: 0, b: 0, a: 255 }, 'non-hex chars → fallback');
eq(M.hexToRgba('#xyz', { r: 1, g: 2, b: 3, a: 4 }), { r: 1, g: 2, b: 3, a: 4 }, 'custom fallback honoured');

section('colorHex — THE ROUND-TRIP INVARIANT (protects every saved .gcaproj)');
eq(M.rgbaToHex({ r: 128, g: 128, b: 128, a: 255 }), '#808080', 'opaque emits 6 digits, NOT #808080ff');
eq(M.rgbaToHex({ r: 128, g: 128, b: 128 }), '#808080', 'absent alpha emits 6 digits');
eq(M.rgbaToHex({ r: 128, g: 128, b: 128, a: 128 }), '#80808080', 'non-opaque widens to 8 digits');
eq(M.rgbaToHex({ r: 128, g: 128, b: 128, a: 0 }), '#80808000', 'alpha 0 widens (0 !== absent)');
for (const h of ['#000000', '#ffffff', '#808080', '#4cc9f0', '#e8a13a']) {
  eq(M.rgbaToHex(M.hexToRgba(h)), h, `opaque round-trip is byte-identical: ${h}`);
}
for (const h of ['#00000000', '#ffffff01', '#4cc9f080']) {
  eq(M.rgbaToHex(M.hexToRgba(h)), h, `alpha round-trip is byte-identical: ${h}`);
}

section('colorHex — clamping');
eq(M.rgbaToHex({ r: -5, g: 300, b: 128, a: 999 }), '#00ff80', 'out-of-range clamps; a=999→255→6 digits');
eq(M.rgbaToHex({ r: 1.6, g: 1.4, b: 0, a: 255 }), '#020100', 'fractional channels round');
eq(M.rgbaToHex({ r: NaN, g: 0, b: 0, a: 255 }), '#000000', 'NaN → 0, never "NaN" in the hex');

section('colorHex — hexRgbPart (what the native picker is fed)');
// <input type="color"> SILENTLY truncates an 8-digit value (#ff000080 -> #ff0000,
// verified on Chrome 148; the spec `alpha` attr is Safari-18.4-only, ~12% global).
// So alpha is never round-tripped through the element — it is carried separately.
eq(M.hexRgbPart('#ff000080'), '#ff0000', '8-digit → 6-digit RGB part for the native picker');
eq(M.hexRgbPart('#ff0000'), '#ff0000', '6-digit passes through');
eq(M.hexRgbPart('#abcd'), '#aabbcc', 'shorthand expands, alpha dropped');
eq(M.hexRgbPart(undefined), '#000000', 'undefined → black, no throw');

section('colorHex — isOpaque (the predicate behind byte-identity)');
eq(M.isOpaque({ r: 0, g: 0, b: 0 }), true, 'absent alpha is opaque');
eq(M.isOpaque({ r: 0, g: 0, b: 0, a: 255 }), true, 'a=255 is opaque');
eq(M.isOpaque({ r: 0, g: 0, b: 0, a: 254 }), false, 'a=254 is NOT opaque');
eq(M.isOpaque({ r: 0, g: 0, b: 0, a: 0 }), false, 'a=0 is NOT opaque (fully transparent ≠ absent)');
eq(M.isOpaque(undefined), true, 'undefined colour treated as opaque');

section('colorHex — rgbaToCss');
eq(M.rgbaToCss({ r: 33, g: 145, b: 140 }), 'rgba(33, 145, 140, 1.000)', 'absent alpha → 1.0');
eq(M.rgbaToCss({ r: 33, g: 145, b: 140, a: 128 }), 'rgba(33, 145, 140, 0.502)', 'alpha 128 → ~0.5');

// ═══════════════════════════════════════════════════════════════════════════
// THE OPTION-A GATE — the port and the emit must never disagree.
// ═══════════════════════════════════════════════════════════════════════════
section('Option A — hasAlpha gates BOTH the port and the emit');
const hidesA = (type, cfg) => (M.getNodeDef(type).hiddenPorts?.(cfg, null) ?? []).includes('a');

// Colour Scale
eq(M.colorScaleHasAlpha({ stopCount: 2, stop_0_r: '0', stop_1_r: '255' }), false,
   'colorScale: no alpha keys → opaque');
eq(M.colorScaleHasAlpha({ stopCount: 2, stop_0_a: '255', stop_1_a: '255' }), false,
   'colorScale: explicit 255 still counts as opaque (drag-to-full leaves no trace)');
eq(M.colorScaleHasAlpha({ stopCount: 2, stop_0_a: '128', stop_1_a: '255' }), true,
   'colorScale: any non-255 stop declares alpha');
eq(M.colorScaleHasAlpha({ stopCount: 2, stop_0_a: '0', stop_1_a: '255' }), true,
   'colorScale: alpha 0 declares alpha');
eq(hidesA('colorScale', { stopCount: 2, stop_0_r: '0' }), true, 'colorScale: opaque → A port hidden');
eq(hidesA('colorScale', { stopCount: 2, stop_0_a: '128' }), false, 'colorScale: alpha → A port shown');

// Categorical Color — the default counts too, not just the entries.
eq(M.categoricalHasAlpha({ count: 2, entry_0_r: '1', entry_1_r: '2' }), false,
   'categoricalColor: no alpha keys → opaque');
eq(M.categoricalHasAlpha({ count: 2, entry_1_a: '10' }), true,
   'categoricalColor: an entry declares alpha');
eq(M.categoricalHasAlpha({ count: 2, default_a: '10' }), true,
   'categoricalColor: the out-of-range DEFAULT declares alpha');
eq(hidesA('categoricalColor', { count: 1 }), true, 'categoricalColor: opaque → A port hidden');
eq(hidesA('categoricalColor', { count: 1, entry_0_a: '5' }), false, 'categoricalColor: alpha → A port shown');

// Colour Constant
eq(M.colorConstantHasAlpha({ r: '1', g: '2', b: '3' }), false, 'getColorConstant: no alpha key → opaque');
eq(M.colorConstantHasAlpha({ r: '1', a: '255' }), false, 'getColorConstant: explicit 255 → opaque');
eq(M.colorConstantHasAlpha({ r: '1', a: '0' }), true, 'getColorConstant: alpha 0 declares alpha');
eq(hidesA('getColorConstant', { r: '1' }), true, 'getColorConstant: opaque → A port hidden');
eq(hidesA('getColorConstant', { r: '1', a: '7' }), false, 'getColorConstant: alpha → A port shown');

// Get Model Attribute — NOT gated: a colour model attr always has an _a slot.
eq(hidesA('getModelAttribute', { isColorAttr: true }), false,
   'getModelAttribute: colour attr always exposes A (the _a slot always exists)');
eq(hidesA('getModelAttribute', { isColorAttr: false }), true,
   'getModelAttribute: non-colour attr hides A (exposes Value)');

section('Option A — the opaque EMIT is the verbatim pre-alpha form');
const emitOf = (type, cfg, inputs = {}) => M.getNodeDef(type).compile('N', cfg, inputs, null, null);
eq(emitOf('getColorConstant', { r: '1', g: '2', b: '3' }),
   'const _vN_r = 1; const _vN_g = 2; const _vN_b = 3;\n',
   'getColorConstant opaque emit is unchanged (no dead _a const)');
eq(emitOf('getColorConstant', { r: '1', g: '2', b: '3', a: '128' }),
   'const _vN_r = 1; const _vN_g = 2; const _vN_b = 3; const _vN_a = 128;\n',
   'getColorConstant alpha emit adds the _a channel');
eq(/_vN_a/.test(emitOf('colorScale', { stopCount: 2, stop_0_position: '0', stop_0_r: '0', stop_1_position: '1', stop_1_r: '255' })),
   false, 'colorScale opaque emit contains NO _a variable');
eq(/_vN_a/.test(emitOf('colorScale', { stopCount: 2, stop_0_position: '0', stop_0_r: '0', stop_0_a: '0', stop_1_position: '1', stop_1_r: '255', stop_1_a: '255' })),
   true, 'colorScale alpha emit contains the _a variable');

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME VALUES — compile a real model and RUN the JS step. Asserts VALUES,
// not "it compiled": bit-parity alone would pass if both targets were wrong.
// ═══════════════════════════════════════════════════════════════════════════
const mkGraph = () => {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const nodes = [], edges = [];
  const n = (t, c = {}) => { const x = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; nodes.push(x); return x; };
  const e = (s, sp, t, tp, cat) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  return { nodes, edges, n, v: (s, sp, t, tp) => e(s, sp, t, tp, 'value'), f: (s, sp, t, tp) => e(s, sp, t, tp, 'flow') };
};
const cellAttr = (id) => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' });
const W = 4, H = 4, TOTAL = W * H;

/** Compile `g` against a model and RUN the JS step, returning the buffer bag. */
const runJS = (g, attrs, modelAttrs) => {
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'RGBA', description: '', topology: '2d-grid', boundaryTreatment: 'torus',
      updateMode: 'synchronous', gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1,
      useWasm: false,
    },
    attributes: attrs, neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  if (js.error) return { error: js.error };
  const params = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL, W, H, D: 1, WH: W * H,
    modelAttrs: modelAttrs ?? {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
    _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    order: null, _skipped: new Uint8Array(0), _activeList: null, _activeCount: -1,
  };
  for (const a of attrs) {
    if (a.isModelAttribute) continue;
    bufs['r_' + a.id] = new Float64Array(TOTAL);
    bufs['w_' + a.id] = new Float64Array(TOTAL);
  }
  const missing = params.filter(p => !(p in bufs));
  if (missing.length) return { error: `unresolved step params: ${missing.join(', ')}` };
  (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
  return { bufs, code: js.stepCode };
};

section('RUNTIME — colour model attribute: the _a slot reaches Get Model Attribute');
{
  // The `_a` slot is the HIGHEST-risk subsystem and has ZERO library coverage —
  // no shipped model has a colour attribute at all. This is its only test.
  const g = mkGraph();
  const step = g.n('step');
  const gm = g.n('getModelAttribute', { attributeId: 'tint', isColorAttr: true });
  const sa = g.n('setAttribute', { attributeId: 'oa' });
  g.f(step, 'do', sa, 'do');
  g.v(gm, 'a', sa, 'value');
  const attrs = [
    cellAttr('oa'),
    { id: 'tint', name: 'tint', type: 'color', description: '', isModelAttribute: true, defaultValue: '#ff000080' },
  ];
  // modelAttrs is built exactly as the worker / SimulatorView build it, via the
  // same hexToRgba — so this covers the writer contract too.
  const c = M.hexToRgba('#ff000080');
  const ma = { tint_r: c.r, tint_g: c.g, tint_b: c.b, tint_a: c.a };
  eq(ma, { tint_r: 255, tint_g: 0, tint_b: 0, tint_a: 128 }, 'writer: #ff000080 → r/g/b/a slots');
  const out = runJS(g, attrs, ma);
  eq(out.error, undefined, 'colour model attr model compiles on JS');
  if (!out.error) {
    const all = [...out.bufs.w_oa];
    eq(all.every(v => v === 128), true, `Get Model Attribute .a === 128 on every cell (got ${all[0]})`);
    eq(/modelAttrs\["tint_a"\]/.test(out.code), true, 'emit reads the tint_a slot');
  }
}

section('RUNTIME — Colour Constant alpha reaches the colors buffer via Set Cell Looks');
{
  const g = mkGraph();
  const step = g.n('step');
  const cc = g.n('getColorConstant', { r: '10', g: '20', b: '30', a: '128' });
  const scl = g.n('setCellLooks', { mappingId: '__current__', useGlyph: false, setBackground: true });
  g.f(step, 'do', scl, 'do');
  g.v(cc, 'r', scl, 'r'); g.v(cc, 'g', scl, 'g'); g.v(cc, 'b', scl, 'b'); g.v(cc, 'a', scl, 'a');
  const out = runJS(g, [cellAttr('dummy')], {});
  eq(out.error, undefined, 'Colour Constant + Set Cell Looks compiles on JS');
  if (!out.error) {
    const px = [...out.bufs.colors.slice(0, 4)];
    eq(px, [10, 20, 30, 128], 'colors[0..3] === [10, 20, 30, 128] — alpha reached the SINK');
  }
}

section('RUNTIME — Colour Scale alpha INTERPOLATES (a midpoint value, not just presence)');
{
  // t = 0.5 between alpha 0 @ p0 and alpha 200 @ p1 → 100 under the linear curve.
  const g = mkGraph();
  const step = g.n('step');
  const cs = g.n('colorScale', {
    method: 'linear', stopCount: 2,
    stop_0_position: '0', stop_0_r: '0', stop_0_g: '0', stop_0_b: '0', stop_0_a: '0',
    stop_1_position: '1', stop_1_r: '255', stop_1_g: '255', stop_1_b: '255', stop_1_a: '200',
    _port_t: '0.5',
  });
  const sa = g.n('setAttribute', { attributeId: 'oa' });
  g.f(step, 'do', sa, 'do');
  g.v(cs, 'a', sa, 'value');
  const out = runJS(g, [cellAttr('oa')], {});
  eq(out.error, undefined, 'Colour Scale alpha model compiles on JS');
  if (!out.error) eq(out.bufs.w_oa[0], 100, `alpha at t=0.5 between 0 and 200 === 100 (got ${out.bufs.w_oa[0]})`);
}

section('RUNTIME — Categorical Color alpha selects per entry + falls back to default_a');
{
  const mk = (idx) => {
    const g = mkGraph();
    const step = g.n('step');
    const cc = g.n('categoricalColor', {
      count: 2,
      entry_0_r: '0', entry_0_a: '11',
      entry_1_r: '0', entry_1_a: '22',
      default_r: '0', default_a: '33',
      _port_index: String(idx),
    });
    const sa = g.n('setAttribute', { attributeId: 'oa' });
    g.f(step, 'do', sa, 'do');
    g.v(cc, 'a', sa, 'value');
    return runJS(g, [cellAttr('oa')], {});
  };
  eq(mk(0).bufs?.w_oa[0], 11, 'index 0 → entry_0 alpha 11');
  eq(mk(1).bufs?.w_oa[0], 22, 'index 1 → entry_1 alpha 22');
  eq(mk(9).bufs?.w_oa[0], 33, 'out-of-range index → default_a 33');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
