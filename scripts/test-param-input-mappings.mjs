// Parameterized Input Mappings — Phase 1 functional verification.
//
// WHY THIS EXISTS: every shipped library model has `Mapping.parameters` ABSENT,
// so `check-compile-identity.mjs` can prove we broke NOTHING and proves NOTHING
// about whether the feature works. This is the other half — a synthetic,
// VALUE-asserting harness that builds models in memory, compiles them, RUNS them
// on JS **and a real instantiated WASM module in Node**, and compares the painted
// attribute VALUES.
//
//   1. The resolver: legacy shape, channel order, `[]` ≠ `undefined`, `color`→3.
//   2. Legacy emit SHAPE: `(function(_r, _g, _b, …` + the single-line triple
//      alias + the WASM `(i32,i32,i32,i32)` type — the byte-identity contract.
//   3. Round-trip VALUES through the real compiled inputColor fn: JS exact, WASM
//      bit-identical, over a 4-parameter / 6-channel mapping.
//   4. ⚠ f64 FIDELITY — a `float` parameter carrying 0.1 arrives as 0.1, not 0.
//      This is the ONE check that catches a stale `valtype: I32` in the WASM
//      `paramRefs` (which does not crash — it reinterprets an f64 param's bits
//      as an i32 local and produces plausible, deterministic garbage).
//   5. Stale edge ⇒ a NAMED compile error, never `_undef`.
//   6. `parameters: []` compiles to a zero-channel entry and paints.
//   7. Agents: the same resolution + emit shape through compileAgentGraph.
//   8. NEGATIVE CONTROLS — a channel-order swap and an f64-truncating payload
//      must both be CAUGHT by the same comparisons the checks above use.
//
// Run from the repo root:  node scripts/test-param-input-mappings.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileGraph, compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel, buildViewerIds } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export {
  inputParamsOf, inputParamsForNode, buildInputParamPorts, encodeChannelValues,
  encodeParamValue, decodeParamValue, channelDefaults, paramTagOptions,
  paramChannelCount, sanitiseParamKey,
} from '../src/model/inputMappingParams.ts';
export { getEffectivePorts } from '../src/modeler/vpl/effectivePorts.ts';
export { detectMissingConfig } from '../src/modeler/vpl/nodes/nodeValidation.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-inputparams-'));
const entryPath = join(ROOT, 'scripts', '__inputparams_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

// ---------------------------------------------------------------------------
// Graph-building helpers (the gen-* / test-ndtable convention)
// ---------------------------------------------------------------------------
const used = new Set();
const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
function mkGraph() {
  const nodes = [], edges = [];
  const node = (nodeType, config) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } }; nodes.push(n); return n; };
  const edge = (s, sp, t, tp, cat) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  return {
    nodes, edges, node,
    vEdge: (s, sp, t, tp) => edge(s, sp, t, tp, 'value'),
    fEdge: (s, sp, t, tp) => edge(s, sp, t, tp, 'flow'),
  };
}

const W = 4, H = 4, TOTAL = W * H;
const PAINT_IDX = 5;

/** The 4-parameter fixture: float · tag · bool · color ⇒ SIX channels. */
const FIXTURE_PARAMS = [
  { key: 'strength', name: 'Strength', type: 'float', defaultValue: '0' },
  { key: 'species', name: 'Species', type: 'tag', tagOptions: ['red', 'green', 'blue'], defaultValue: '0' },
  { key: 'flag', name: 'Flag', type: 'bool', defaultValue: 'false' },
  { key: 'tint', name: 'Tint', type: 'color', defaultValue: '#000000' },
];
/** Written attributes, one per CHANNEL — so a channel-ORDER bug is caught. */
const OUT_ATTRS = [
  { id: 'o_strength', type: 'float' },
  { id: 'o_species', type: 'integer' },
  { id: 'o_flag', type: 'integer' },
  { id: 'o_tr', type: 'integer' },
  { id: 'o_tg', type: 'integer' },
  { id: 'o_tb', type: 'integer' },
];

/** Build a cell model whose input mapping declares `parameters` (or, when
 *  `parameters` is undefined, the LEGACY colour mapping). One `setAttribute`
 *  per channel, chained through the `next` pass-through, so each channel's value
 *  lands in its own attribute. */
function buildCellModel({ parameters, channelPorts, extraAttrs = [] }) {
  const g = mkGraph();
  g.node('step', {});                                   // required root
  const ic = g.node('inputColor', { mappingId: 'P' });
  let prev = null;
  channelPorts.forEach((portId, i) => {
    const out = OUT_ATTRS[i];
    if (!out) return;
    const set = g.node('setAttribute', { attributeId: out.id });
    if (prev === null) g.fEdge(ic, 'do', set, 'do');
    else g.fEdge(prev, 'next', set, 'do');
    g.vEdge(ic, portId, set, 'value');
    prev = set;
  });
  const mapping = {
    id: 'P', name: 'Params', description: '', isAttributeToColor: false,
    redDescription: '', greenDescription: '', blueDescription: '',
  };
  if (parameters !== undefined) mapping.parameters = parameters;
  return M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'Param Input Test', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: [
      ...OUT_ATTRS.slice(0, Math.max(channelPorts.length, 1)).map(a => ({
        id: a.id, name: a.id, type: a.type, description: '', isModelAttribute: false, defaultValue: '0',
      })),
      ...extraAttrs,
    ],
    neighborhoods: [], mappings: [mapping], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
}

/** Run a compiled inputColor JS fn for one cell, returning the written values.
 *  Parses the emitted parameter list (the test-ndtable pattern) so the harness
 *  never hard-codes the ABI it is verifying. */
function runJsInputColor(model, code, channelValues, idx = PAINT_IDX) {
  const m = /\(\s*function\s*\(([^)]*)\)/.exec(code);
  if (!m) return { error: 'no param list' };
  const params = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const bufs = {
    idx, total: TOTAL, W, H, D: 1, WH: W * H,
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {}, _linkedResults: {},
    _rngState: new Uint32Array([0x12345678]), _stopFlag: new Uint32Array(1),
    glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    r_orientation: new Int32Array(TOTAL), w_orientation: new Int32Array(TOTAL),
    _facePatternLookup: new Int32Array(0), _lookupTables: {},
    _generation: 0,
  };
  for (const a of cellAttrs) {
    const Ctor = a.type === 'float' ? Float64Array : Int32Array;
    bufs[`r_${a.id}`] = new Ctor(TOTAL);
    bufs[`w_${a.id}`] = new Ctor(TOTAL);
  }
  // The CHANNEL args lead the signature; everything after is the cell ABI.
  const nCh = channelValues.length;
  const abiParams = params.slice(nCh);
  const missing = abiParams.filter(p => !(p in bufs));
  if (missing.length) return { error: `unknown params: ${missing.join(', ')}` };
  const fn = (0, eval)(code);
  fn(...channelValues, ...abiParams.map(p => bufs[p]));
  const out = {};
  for (const a of cellAttrs) out[a.id] = bufs[`w_${a.id}`][idx];
  return { out, leadingParams: params.slice(0, nCh) };
}

/** Compile the model to WASM, instantiate for real, call `inputColor_P`. */
async function runWasmInputColor(model, channelValues, idx = PAINT_IDX) {
  const layout = M.computeLayoutFromModel(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
  if (wa.error) return { error: wa.error };
  const copy = wa.bytes.buffer.slice(wa.bytes.byteOffset, wa.bytes.byteOffset + wa.bytes.byteLength);
  if (!WebAssembly.validate(copy)) return { error: 'module does not validate' };
  const mem = new WebAssembly.Memory({ initial: layout.pages });
  const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
  const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
  const fn = instance.exports['inputColor_P'];
  if (typeof fn !== 'function') return { error: 'no inputColor_P export' };
  fn(idx, ...channelValues);
  const out = {};
  for (const a of model.attributes.filter(x => !x.isModelAttribute)) {
    const off = layout.attrWriteOffset[a.id];
    const arr = a.type === 'float' ? new Float64Array(mem.buffer, off, TOTAL) : new Int32Array(mem.buffer, off, TOTAL);
    out[a.id] = arr[idx];
  }
  return { out, bytes: wa.bytes, layout };
}

// ===========================================================================
console.log('== 1. the resolver ==');
// ===========================================================================
{
  const legacy = M.inputParamsOf(undefined);
  check('absent parameters ⇒ legacy', legacy.legacy === true);
  check('legacy port ids are exactly r/g/b', legacy.channels.map(c => c.portId).join(',') === 'r,g,b');
  check('legacy ABI names are exactly _r/_g/_b', legacy.channels.map(c => c.argName).join(',') === '_r,_g,_b');
  check('legacy labels are R/G/B', legacy.channels.map(c => c.label).join(',') === 'R,G,B');
  check('legacy is ONE color parameter', legacy.params.length === 1 && legacy.params[0].param.type === 'color');

  // ⚠ THE SHARP EDGE: `[]` is NOT `undefined`.
  const empty = M.inputParamsOf({ id: 'x', parameters: [] });
  check('[] ⇒ NOT legacy', empty.legacy === false);
  check('[] ⇒ zero channels', empty.channels.length === 0);
  check('NEG: [] does not resolve to the legacy r/g/b trio', empty.channels.length !== 3);

  const res = M.inputParamsOf({ id: 'P', parameters: FIXTURE_PARAMS });
  check('declared ⇒ NOT legacy', res.legacy === false);
  check('color → 3 channels, scalars → 1 (6 total)', res.channels.length === 6);
  check('channel ORDER follows declaration',
    res.channels.map(c => c.portId).join(',') === 'strength,species,flag,tint_r,tint_g,tint_b',
    res.channels.map(c => c.portId).join(','));
  check('declared ABI names carry the _p_ prefix',
    res.channels.map(c => c.argName).join(',') === '_p_strength,_p_species,_p_flag,_p_tint_r,_p_tint_g,_p_tint_b');
  check('port dataTypes follow the parameter type',
    res.channels.map(c => c.dataType).join(',') === 'float,integer,bool,integer,integer,integer');
  check('paramChannelCount: color 3, others 1',
    M.paramChannelCount('color') === 3 && M.paramChannelCount('float') === 1 && M.paramChannelCount('tag') === 1);

  // Defensive de-duplication: `tint` (colour) mints tint_r; a sibling keyed
  // literally `tint_r` must NOT collide onto the same port / ABI name.
  const dup = M.inputParamsOf({ id: 'D', parameters: [
    { key: 'tint', name: 'Tint', type: 'color' },
    { key: 'tint_r', name: 'Clash', type: 'integer' },
  ] });
  const ids = dup.channels.map(c => c.portId);
  check('colliding port ids are de-duplicated', new Set(ids).size === ids.length, ids.join(','));

  // Value encoding.
  const vals = M.encodeChannelValues(res, { strength: '2.5', species: '1', flag: 'true', tint: '#0a141e' });
  check('encodeChannelValues → the flat payload, in channel order',
    JSON.stringify(vals) === JSON.stringify([2.5, 1, 1, 10, 20, 30]), JSON.stringify(vals));
  const defs = M.channelDefaults(res);
  check('channelDefaults falls back per parameter', JSON.stringify(defs) === JSON.stringify([0, 0, 0, 0, 0, 0]), JSON.stringify(defs));
  check('decodeParamValue(color) round-trips', M.decodeParamValue(FIXTURE_PARAMS[3], [10, 20, 30]) === '#0a141e');
  check('encodeParamValue(bool) is 1/0', M.encodeParamValue(FIXTURE_PARAMS[2], 0, 'true') === 1 && M.encodeParamValue(FIXTURE_PARAMS[2], 0, 'false') === 0);
  check('sanitiseParamKey strips illegal chars', M.sanitiseParamKey('a b-c!') === 'a_b_c_');
}

// ===========================================================================
console.log('== 2. ports: the two mirrored builders agree, legacy is unchanged ==');
// ===========================================================================
{
  const legacyModel = { mappings: [{ id: 'L', isAttributeToColor: false }], agentMappings: [] };
  const paramModel = { mappings: [{ id: 'P', isAttributeToColor: false, parameters: FIXTURE_PARAMS }], agentMappings: [] };

  const bLegacy = M.buildInputParamPorts('inputColor', { mappingId: 'L' }, legacyModel);
  check('builder: legacy ⇒ R/G/B outputs', bLegacy.outputs.map(p => p.id).join(',') === 'r,g,b');
  const bNone = M.buildInputParamPorts('inputColor', { mappingId: '' }, undefined);
  check('builder: NO model ⇒ legacy shape (panel-drag path, no crash)', bNone.outputs.map(p => p.id).join(',') === 'r,g,b');
  const bParam = M.buildInputParamPorts('inputColor', { mappingId: 'P' }, paramModel);
  check('builder: declared ⇒ one output per channel',
    bParam.outputs.map(p => p.id).join(',') === 'strength,species,flag,tint_r,tint_g,tint_b');

  // effectivePorts must produce the SAME set (the dual-consumption discipline).
  const ep = M.getEffectivePorts('inputColor', { mappingId: 'P' }, paramModel);
  check('effectivePorts mirrors the builder (DO first, then channels)',
    ep.outputs.map(p => p.id).join(',') === 'do,strength,species,flag,tint_r,tint_g,tint_b',
    ep.outputs.map(p => p.id).join(','));
  const epLegacy = M.getEffectivePorts('inputColor', { mappingId: 'L' }, legacyModel);
  check('effectivePorts legacy ⇒ do,r,g,b (the historical port set)',
    epLegacy.outputs.map(p => p.id).join(',') === 'do,r,g,b');
  const epAgent = M.getEffectivePorts('agentInputMapping', { mappingId: 'A' },
    { mappings: [], agentMappings: [{ id: 'A', isAttributeToColor: false, parameters: [{ key: 'e', name: 'E', type: 'integer' }] }] });
  check('effectivePorts resolves an AGENT mapping from agentMappings',
    epAgent.outputs.map(p => p.id).join(',') === 'do,e');
}

// ===========================================================================
console.log('== 3. LEGACY emit shape (the byte-identity contract) ==');
// ===========================================================================
{
  const model = buildCellModel({ parameters: undefined, channelPorts: ['r', 'g', 'b'] });
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('legacy JS compiles', !js.error, js.error ?? '');
  const code = js.inputColorCodes[0]?.code ?? '';
  check('legacy JS header is `(function(_r, _g, _b, …`', code.startsWith('(function(_r, _g, _b, '), code.slice(0, 40));
  const icId = model.graphNodes.find(n => n.data.nodeType === 'inputColor').id;
  check('legacy JS alias line is the historical single-line triple const',
    code.includes(`  const _v${icId}_r = _r; const _v${icId}_g = _g; const _v${icId}_b = _b;\n`));

  const layout = M.computeLayoutFromModel(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
  check('legacy WASM compiles', !wa.error, wa.error ?? '');
  // Type section: 4 fixed types, and the inputColor func uses index 2
  // (TYPE_IDX_IDX_RGB = (i32,i32,i32,i32)) — no minted type is appended.
  const sec = readTypeSection(wa.bytes);
  check('legacy WASM type section has exactly the 4 fixed types', sec.count === 4, `count=${sec.count}`);
  check('legacy WASM type 2 is (i32,i32,i32,i32)->()',
    JSON.stringify(sec.types[2]) === JSON.stringify({ params: [0x7f, 0x7f, 0x7f, 0x7f], results: [] }),
    JSON.stringify(sec.types[2]));
}

// ===========================================================================
console.log('== 4. VALUES through the real compiled fns (JS + real WASM) ==');
// ===========================================================================
const CHANNEL_PORTS = ['strength', 'species', 'flag', 'tint_r', 'tint_g', 'tint_b'];
// strength 2.5 · species=green(1) · flag=true(1) · tint #0a141e → 10,20,30
const PAYLOAD = [2.5, 1, 1, 10, 20, 30];
const EXPECTED = { o_strength: 2.5, o_species: 1, o_flag: 1, o_tr: 10, o_tg: 20, o_tb: 30 };
let jsValues = null;
{
  const model = buildCellModel({ parameters: FIXTURE_PARAMS, channelPorts: CHANNEL_PORTS });
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('parameterized JS compiles', !js.error, js.error ?? '');
  const code = js.inputColorCodes[0]?.code ?? '';
  check('parameterized JS header carries the _p_ channel args',
    code.startsWith('(function(_p_strength, _p_species, _p_flag, _p_tint_r, _p_tint_g, _p_tint_b, '),
    code.slice(0, 90));
  const r = runJsInputColor(model, code, PAYLOAD);
  check('JS run: no ABI mismatch', !r.error, r.error ?? '');
  if (!r.error) {
    jsValues = r.out;
    let bad = [];
    for (const [k, v] of Object.entries(EXPECTED)) if (r.out[k] !== v) bad.push(`${k}=${r.out[k]}≠${v}`);
    check('JS: every channel lands in its own attribute, in order', bad.length === 0, bad.join(' '));
    // NEGATIVE CONTROL — a channel-ORDER swap must be caught by that comparison.
    const swapped = { ...EXPECTED, o_tr: EXPECTED.o_tg, o_tg: EXPECTED.o_tr };
    const wouldFail = Object.entries(swapped).some(([k, v]) => r.out[k] !== v);
    check('NEG: a channel-order swap is CAUGHT by the value comparison', wouldFail);
  }

  const wr = await runWasmInputColor(model, PAYLOAD);
  check('parameterized WASM compiles + instantiates', !wr.error, wr.error ?? '');
  if (!wr.error) {
    let bad = [];
    for (const [k, v] of Object.entries(EXPECTED)) if (wr.out[k] !== v) bad.push(`${k}=${wr.out[k]}≠${v}`);
    check('WASM: every channel lands in its own attribute, in order', bad.length === 0, bad.join(' '));
    if (jsValues) {
      const diff = Object.keys(EXPECTED).filter(k => wr.out[k] !== jsValues[k]);
      check('JS ↔ WASM bit-identical', diff.length === 0, diff.join(','));
    }
    // The minted signature: (i32 idx, f64 × 6) -> ().
    const sec = readTypeSection(wr.bytes);
    const minted = sec.types.find(t => t.params.length === 7 && t.params[0] === 0x7f && t.params.slice(1).every(p => p === 0x7c));
    check('WASM minted a (i32, f64×6) type for the parameterized entry', !!minted,
      JSON.stringify(sec.types.map(t => t.params)));
  }
}

// ===========================================================================
console.log('== 5. ⚠ f64 FIDELITY — the stale-`valtype: I32` detector ==');
// ===========================================================================
{
  // ONE float parameter carrying 0.1. Under a stale `valtype: I32` in paramRefs
  // the WASM entry reinterprets the f64 param's BITS as an i32 local: no crash,
  // no validation error, just a plausible wrong number.
  const params = [{ key: 'v', name: 'V', type: 'float', defaultValue: '0' }];
  const model = buildCellModel({ parameters: params, channelPorts: ['v'] });
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('f64 fixture JS compiles', !js.error, js.error ?? '');
  const r = runJsInputColor(model, js.inputColorCodes[0].code, [0.1]);
  check('JS: a float parameter carrying 0.1 arrives as 0.1', r.out?.o_strength === 0.1, String(r.out?.o_strength));

  const wr = await runWasmInputColor(model, [0.1]);
  check('f64 fixture WASM compiles + instantiates', !wr.error, wr.error ?? '');
  if (!wr.error) {
    check('WASM: a float parameter carrying 0.1 arrives as 0.1 (NOT 0, NOT bit-garbage)',
      wr.out.o_strength === 0.1, String(wr.out.o_strength));
    check('NEG: 0.1 did not truncate to an integer', wr.out.o_strength !== 0 && wr.out.o_strength !== Math.trunc(wr.out.o_strength));
    // A second, adversarial value: 1/3 has no short binary form, so any
    // i32 reinterpretation or f32 narrowing shows up immediately.
    const wr2 = await runWasmInputColor(model, [1 / 3]);
    check('WASM: 1/3 survives the ABI exactly', wr2.out?.o_strength === 1 / 3, String(wr2.out?.o_strength));
    const r2 = runJsInputColor(model, js.inputColorCodes[0].code, [1 / 3]);
    check('JS ↔ WASM bit-identical on 1/3', r2.out?.o_strength === wr2.out?.o_strength);
  }
}

// ===========================================================================
console.log('== 6. `parameters: []` — a zero-channel entry that still paints ==');
// ===========================================================================
{
  // The graph writes a CONSTANT (no channel wires) — the "stamp" mapping.
  const g = mkGraph();
  g.node('step', {});
  const ic = g.node('inputColor', { mappingId: 'P' });
  const k = g.node('getConstant', { constType: 'integer', constValue: '7' });
  const set = g.node('setAttribute', { attributeId: 'o_strength' });
  g.fEdge(ic, 'do', set, 'do');
  g.vEdge(k, 'value', set, 'value');
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'Empty Params', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: [{ id: 'o_strength', name: 'o', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' }],
    neighborhoods: [],
    mappings: [{ id: 'P', name: 'Stamp', description: '', isAttributeToColor: false, redDescription: '', greenDescription: '', blueDescription: '', parameters: [] }],
    indicators: [], graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('zero-channel JS compiles', !js.error, js.error ?? '');
  const code = js.inputColorCodes[0]?.code ?? '';
  check('zero-channel JS header has NO leading channel args (no syntax error)',
    code.startsWith('(function(idx, '), code.slice(0, 30));
  const r = runJsInputColor(model, code, []);
  check('zero-channel JS paints the constant', r.out?.o_strength === 7, String(r.out?.o_strength));
  const wr = await runWasmInputColor(model, []);
  check('zero-channel WASM compiles + paints the constant', !wr.error && wr.out?.o_strength === 7, wr.error ?? String(wr.out?.o_strength));
}

// ===========================================================================
console.log('== 7. STALE EDGE ⇒ a NAMED compile error, never `_undef` ==');
// ===========================================================================
{
  // The graph is wired from `tint_r`, but the mapping now declares only `energy`.
  const model = buildCellModel({
    parameters: [{ key: 'energy', name: 'Energy', type: 'float' }],
    channelPorts: ['tint_r'],
  });
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('stale-edge graph produces a compile ERROR', !!js.error);
  check('…and the error NAMES the vanished parameter',
    (js.error ?? '').includes('tint_r'), js.error ?? '(none)');
  check('NEG: the error is not the generic missing-model-element text alone',
    (js.error ?? '').includes('no longer declares'), js.error ?? '(none)');

  // The Modeler badge covers the same case (needs the connected-handle set).
  const issues = M.detectMissingConfig('inputColor', { mappingId: 'P' }, model, new Set(['output_value_tint_r']));
  check('detectMissingConfig badges the stale wire',
    issues.some(s => s.includes('tint_r')), issues.join(' | '));
  const none = M.detectMissingConfig('inputColor', { mappingId: 'P' }, model, new Set(['output_value_energy']));
  check('NEG: a LIVE wire is not badged', !none.some(s => s.includes('no longer declares')), none.join(' | '));
  const emptyDecl = M.detectMissingConfig('inputColor', { mappingId: 'P' },
    { ...model, mappings: [{ ...model.mappings[0], parameters: [] }] }, new Set(['output_value_r']));
  check('a wire into a NO-parameter mapping is badged',
    emptyDecl.some(s => s.includes('declares no parameters')), emptyDecl.join(' | '));
  const quiet = M.detectMissingConfig('inputColor', { mappingId: 'P' },
    { ...model, mappings: [{ ...model.mappings[0], parameters: [] }] }, new Set(['output_flow_do']));
  check('NEG: an UNWIRED no-parameter mapping is a valid stamp (no badge)',
    !quiet.some(s => s.includes('declares no parameters')), quiet.join(' | '));
}

// ===========================================================================
console.log('== 8. AGENTS — the same resolution + emit shape ==');
// ===========================================================================
{
  const g = mkGraph();
  g.node('behaviourStep', {});                            // required agent root
  const im = g.node('agentInputMapping', { mappingId: 'AP' });
  const set = g.node('setAttribute', { attributeId: 'ae' });
  g.fEdge(im, 'do', set, 'do');
  g.vEdge(im, 'energy', set, 'value');
  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'Agent Param Input', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: [], neighborhoods: [], mappings: [], indicators: [],
    agentAttributes: [{ id: 'ae', name: 'ae', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' }],
    agentMappings: [{
      id: 'AP', name: 'AParams', description: '', isAttributeToColor: false,
      redDescription: '', greenDescription: '', blueDescription: '',
      parameters: [{ key: 'energy', name: 'Energy', type: 'float' }],
    }],
    graphNodes: [], graphEdges: [], agentGraphNodes: g.nodes, agentGraphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: false, agents: true },
    centerBased: { maxAgents: 64, maxBonds: 0, worldWidth: W, worldHeight: H },
  });
  const ag = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
  check('agent graph compiles', !ag.error, ag.error ?? '');
  const code = ag.inputMappingCodes?.[0]?.code ?? '';
  check('agent parameterized header carries the _p_ channel arg',
    code.startsWith('(function(_p_energy, '), code.slice(0, 60));
  check('agent alias line aliases the channel to the port var',
    code.includes(`const _v${im.id}_energy = _p_energy;`));

  // …and the LEGACY agent mapping is unchanged.
  const g2 = mkGraph();
  g2.node('behaviourStep', {});
  const im2 = g2.node('agentInputMapping', { mappingId: 'AL' });
  const set2 = g2.node('setAttribute', { attributeId: 'ae' });
  g2.fEdge(im2, 'do', set2, 'do');
  g2.vEdge(im2, 'g', set2, 'value');
  const legacyModel = M.migrateForHarness({
    ...model,
    agentMappings: [{ id: 'AL', name: 'ALegacy', description: '', isAttributeToColor: false, redDescription: '', greenDescription: '', blueDescription: '' }],
    agentGraphNodes: g2.nodes, agentGraphEdges: g2.edges,
  });
  const ag2 = M.compileAgentGraph(legacyModel.agentGraphNodes, legacyModel.agentGraphEdges, legacyModel);
  check('legacy agent graph compiles', !ag2.error, ag2.error ?? '');
  const code2 = ag2.inputMappingCodes?.[0]?.code ?? '';
  check('legacy agent header is `(function(_r, _g, _b, …`', code2.startsWith('(function(_r, _g, _b, '), code2.slice(0, 40));
  check('legacy agent alias line is the historical single-line triple const',
    code2.includes(`  const _v${im2.id}_r = _r; const _v${im2.id}_g = _g; const _v${im2.id}_b = _b;\n`));
}

// ---------------------------------------------------------------------------
/** Minimal WASM type-section reader — enough to assert the entry signatures. */
function readTypeSection(bytes) {
  let p = 8;                                   // magic + version
  while (p < bytes.length) {
    const id = bytes[p++];
    let size = 0, shift = 0, b;
    do { b = bytes[p++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    if (id !== 1) { p += size; continue; }
    const end = p + size;
    let count = 0; shift = 0;
    do { b = bytes[p++]; count |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const types = [];
    for (let i = 0; i < count && p < end; i++) {
      p++;                                     // 0x60 func
      let np = 0; shift = 0;
      do { b = bytes[p++]; np |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      const params = [];
      for (let j = 0; j < np; j++) params.push(bytes[p++]);
      let nr = 0; shift = 0;
      do { b = bytes[p++]; nr |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      const results = [];
      for (let j = 0; j < nr; j++) results.push(bytes[p++]);
      types.push({ params, results });
    }
    return { count, types };
  }
  return { count: 0, types: [] };
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
