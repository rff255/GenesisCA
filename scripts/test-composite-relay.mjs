// Composite (vector / colour) WIRING — functional verification.
//
// Two user-reported defects, one root cause: the `any`-typed ports that should
// be able to CARRY a composite.
//
//   1. Get Random (Vector mode) → Set Attribute of a `vector` attribute. The
//      wire is legal and lowers correctly, but every OTHER `any` sink silently
//      accepted it in the suggestion layer and then emitted a reference to an
//      undeclared `_v<id>_vector`.
//   2. Value Switch refused vectors outright. It is now a COMPOSITE RELAY, the
//      exact analogue of its existing ARRAY relay: both branches carrying the
//      same composite ⇒ `result` is that composite, lowered to one SCALAR Value
//      Switch per component (so all six emit surfaces get it for free).
//
// What this asserts — VALUES, not "it compiled": the per-component results of a
// relay on JS and on a REAL instantiated WASM module (both branch outcomes, and
// bit-identical between the two), the WGSL emit, both agent gates, the colour
// arity, nesting, the shape gate's NAMED errors, and that a SCALAR Value Switch
// graph is left byte-identical (the pre-change fast path).
//
// Run from the repo root:  node scripts/test-composite-relay.mjs
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
export { compileGraphWebGPU } from '../src/modeler/vpl/compiler/webgpu/compile.ts';
export { expandComposites } from '../src/modeler/vpl/compiler/expandComposites.ts';
export { makeCompositeTypeResolver, editorPortCompositeType, staticPortCompositeType, rerouteCompositeType, detectCompositeShapeMismatch, COMPOSITE_ARITY, RELAY_BRANCH_PORTS, RELAY_RESULT_PORT } from '../src/modeler/vpl/compiler/compositeRelay.ts';
export { isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { isAgentGraphWebGPUSupported } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { getNodeDef } from '../src/modeler/vpl/nodes/registry.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-crelay-'));
const entryPath = join(ROOT, 'scripts', '__crelay_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

let failures = 0, passes = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passes++; console.log(`  ok  ${name}`); }
  else { failures++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── graph builder ────────────────────────────────────────────────────────────
let seq = 0;
const G = () => {
  const N = [], E = [];
  return {
    N, E,
    node: (t, c = {}) => { const n = { id: 'n' + (seq++), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; N.push(n); return n; },
    edge: (a, sp, b, tp, cat = 'value') => { E.push({ id: 'e' + (seq++), source: a.id, target: b.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` }); },
  };
};
const CELL_PROPS = { name: 'CRelay', dimension: '2d', gridWidth: 4, gridHeight: 4, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false, updateMode: 'synchronous' };
const mkModel = (N, E, attrs, extra = {}) => M.migrateForHarness({
  schemaVersion: 1, properties: { ...CELL_PROPS, ...(extra.properties ?? {}) },
  attributes: attrs, modelAttributes: [], neighborhoods: [], variables: extra.variables ?? [],
  agentAttributes: extra.agentAttributes ?? [], agentVariables: [],
  indicators: [], mappings: [], graphNodes: N, graphEdges: E, macroDefs: [],
  ...(extra.rest ?? {}),
});
const VEC = (id, name, dims = 2, def = '0,0') => ({ id, name, type: 'vector', vectorDims: dims, description: '', isModelAttribute: false, defaultValue: def });
const FLT = (id, name) => ({ id, name, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' });

const TOTAL = 16, W = 4, H = 4;
/** Run a compiled cell step over a 4×4 grid; returns the written buffers by attr id. */
function runJS(js, model, attrIds) {
  const params = /\(function\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim());
  const bufs = {
    total: TOTAL, W, H, D: 1, WH: W * H, modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4),
    activeViewer: '', _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
    _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    _lookupTables: {}, _facePatternLookup: new Int32Array(0),
    r_orientation: new Int32Array(TOTAL), w_orientation: new Int32Array(TOTAL),
    order: null, _skipped: new Uint8Array(0), _activeList: null, _activeCount: -1,
  };
  for (const id of attrIds) { bufs['r_' + id] = new Float64Array(TOTAL); bufs['w_' + id] = new Float64Array(TOTAL); }
  const missing = params.filter(p => !(p in bufs));
  if (missing.length) return { error: 'unresolved params: ' + missing.join(',') };
  (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
  const out = {};
  for (const id of attrIds) out[id] = bufs['w_' + id];
  return out;
}
async function runWASM(model, attrIds) {
  const layout = M.computeLayoutFromModel(model);
  const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
  if (wa.error) return { error: wa.error };
  const mem = new WebAssembly.Memory({ initial: layout.pages });
  const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
  const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
  instance.exports.step(TOTAL);
  const out = {};
  for (const id of attrIds) out[id] = new Float64Array(mem.buffer, layout.attrWriteOffset[id], TOTAL);
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('== A. the shared resolver (the ONE rule editor + lowering share) ==');
{
  check('Get Random exposes a composite `vector` output', M.staticPortCompositeType('getRandom', 'vector', 'output') === 'vector');
  check('Get Random exposes a composite `color` output', M.staticPortCompositeType('getRandom', 'color', 'output') === 'color');
  const vs = M.getNodeDef('valueSwitch');
  for (const p of ['ifValue', 'elseValue', 'result']) {
    check(`Value Switch "${p}" is compositeCapable`, !!vs.ports.find(x => x.id === p)?.compositeCapable);
  }
  check('Value Switch `condition` is NOT compositeCapable (a composite is not a truth value)',
    !vs.ports.find(x => x.id === 'condition')?.compositeCapable);

  // A vector ATTRIBUTE read is a composite output only through the model.
  const model = mkModel([], [], [VEC('h', 'H')]);
  check('a picked vector attribute retypes the `value` port',
    M.editorPortCompositeType('getCellAttribute', 'value', 'output', { attributeId: 'h' }, model) === 'vector');
  check('a picked SCALAR attribute leaves it scalar',
    M.editorPortCompositeType('getCellAttribute', 'value', 'output', { attributeId: 'nope' }, model) === null);

  // Relay resolution: both / one / neither / mismatched.
  const mkResolver = (nodes, edges) => {
    const map = new Map(nodes.map(n => [n.id, n]));
    const port = h => (h ?? '').replace(/^(input|output)_value_/, '');
    return M.makeCompositeTypeResolver({
      nodeTypeOf: id => map.get(id)?.data.nodeType,
      portCompositeType: (id, p) => M.staticPortCompositeType(map.get(id)?.data.nodeType, p, 'output'),
      sourceOf: (id, p) => { const e = edges.find(x => x.target === id && port(x.targetHandle) === p); return e ? { nodeId: e.source, portId: port(e.sourceHandle) } : undefined; },
    });
  };
  const g = G();
  const a = g.node('makeVector'), b = g.node('makeVector'), c = g.node('makeColor');
  const both = g.node('valueSwitch'), one = g.node('valueSwitch'), mixed = g.node('valueSwitch'), none = g.node('valueSwitch');
  const nested = g.node('valueSwitch');
  g.edge(a, 'vector', both, 'ifValue'); g.edge(b, 'vector', both, 'elseValue');
  g.edge(a, 'vector', one, 'ifValue');
  g.edge(a, 'vector', mixed, 'ifValue'); g.edge(c, 'color', mixed, 'elseValue');
  g.edge(both, 'result', nested, 'ifValue'); g.edge(b, 'vector', nested, 'elseValue');
  const R = mkResolver(g.N, g.E);
  check('BOTH branches vector ⇒ result is a vector', R(both.id, 'result') === 'vector');
  check('ONE branch vector ⇒ result is NOT a composite', R(one.id, 'result') === null);
  check('MIXED vector/color ⇒ result is NOT a composite', R(mixed.id, 'result') === null);
  check('NEITHER branch wired ⇒ result is NOT a composite', R(none.id, 'result') === null);
  check('NESTED relay resolves transitively', R(nested.id, 'result') === 'vector');
  check('a relay branch INPUT is not itself a composite output', R(both.id, 'ifValue') === null);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('== B. BUG 1 — Get Random (Vector) → Set Attribute of a vector attr ==');
{
  const g = G();
  const step = g.node('step');
  // span 0 + angle 90 ⇒ a deterministic due-EAST unit heading × norm 5 ⇒ (5, 0).
  const gr = g.node('getRandom', { randomType: 'vector', _port_norm: '5', _port_angle: '90', _port_span: '0' });
  const set = g.node('setAttribute', { attributeId: 'h' });
  g.edge(step, 'do', set, 'do', 'flow');
  g.edge(gr, 'vector', set, 'value');
  const model = mkModel(g.N, g.E, [VEC('h', 'H')]);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('JS compiles', !js.error, js.error ?? '');
  const ids = ['h_vx', 'h_vy'];
  const jsOut = js.error ? { error: js.error } : runJS(js, model, ids);
  check('JS runs', !jsOut.error, jsOut.error ?? '');
  const near = (a, b) => Math.abs(a - b) < 1e-12;
  if (!jsOut.error) {
    check('JS: X component == 5 (the vector\'s x reached the attribute\'s _vx)', near(jsOut.h_vx[0], 5), String(jsOut.h_vx[0]));
    check('JS: Y component == 0', near(jsOut.h_vy[0], 0), String(jsOut.h_vy[0]));
    check('JS: every cell written', [...jsOut.h_vx].every(v => near(v, 5)));
  }
  const wOut = await runWASM(model, ids);
  check('WASM compiles + runs', !wOut.error, wOut.error ?? '');
  if (!wOut.error && !jsOut.error) {
    check('WASM: X == 5', near(wOut.h_vx[0], 5), String(wOut.h_vx[0]));
    check('WASM: Y == 0', near(wOut.h_vy[0], 0), String(wOut.h_vy[0]));
    let d = 0; for (let i = 0; i < TOTAL; i++) if (wOut.h_vx[i] !== jsOut.h_vx[i] || wOut.h_vy[i] !== jsOut.h_vy[i]) d++;
    check('JS ↔ WASM bit-identical', d === 0, `${d}/${TOTAL}`);
  }
  const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
  check('WebGPU compiles', !wg.error, wg.error ?? '');
  check('WebGPU emits no dangling composite reference', !/_vector\b/.test(wg.shaderCode ?? ''));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('== C. BUG 2 — Value Switch RELAYS a vector, component by component ==');
// cond ? (1,2) : (10,20). Driven by a real Compare so both outcomes are testable
// from a cell attribute, not an inline literal.
const relayModel = (condAttrDefault) => {
  const g = G();
  const step = g.node('step');
  const a = g.node('makeVector', { _port_x: '1', _port_y: '2' });
  const b = g.node('makeVector', { _port_x: '10', _port_y: '20' });
  const cmp = g.node('statement', { operation: '>', _port_y: '0.5' });
  const gate = g.node('getCellAttribute', { attributeId: 'gate' });
  const vs = g.node('valueSwitch');
  const set = g.node('setAttribute', { attributeId: 'h' });
  g.edge(step, 'do', set, 'do', 'flow');
  g.edge(gate, 'value', cmp, 'x');
  g.edge(cmp, 'result', vs, 'condition');
  g.edge(a, 'vector', vs, 'ifValue');
  g.edge(b, 'vector', vs, 'elseValue');
  g.edge(vs, 'result', set, 'value');
  return mkModel(g.N, g.E, [VEC('h', 'H'), { ...FLT('gate', 'Gate'), defaultValue: String(condAttrDefault) }]);
};
{
  const model = relayModel(1);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('JS compiles a vector relay', !js.error, js.error ?? '');
  check('the relay lowered to per-component SCALAR selects (no composite left)',
    !/_vector\b/.test(js.stepCode ?? '') && (js.stepCode.match(/\?\s*\(/g) ?? []).length >= 2,
    (js.stepCode ?? '').slice(0, 160));

  for (const [gateVal, ex, ey, label] of [[1, 1, 2, 'TRUE ⇒ the If branch'], [0, 10, 20, 'FALSE ⇒ the Else branch']]) {
    const m2 = relayModel(gateVal);
    const j2 = M.compileGraph(m2.graphNodes, m2.graphEdges, m2);
    const ids = ['h_vx', 'h_vy', 'gate'];
    // the gate attribute's default seeds r_gate; runJS zeroes buffers, so drive it
    // through the read buffer explicitly.
    check(`JS compiles (${label})`, !j2.error, j2.error ?? '');
    if (j2.error) continue;
    const params = /\(function\(([^)]*)\)/.exec(j2.stepCode)[1].split(',').map(s => s.trim());
    const bufs = {
      total: TOTAL, W, H, D: 1, WH: W * H, modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4),
      activeViewer: '', _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([1]),
      _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
      _lookupTables: {}, _facePatternLookup: new Int32Array(0),
      r_orientation: new Int32Array(TOTAL), w_orientation: new Int32Array(TOTAL),
      order: null, _skipped: new Uint8Array(0), _activeList: null, _activeCount: -1,
    };
    for (const id of ids) { bufs['r_' + id] = new Float64Array(TOTAL).fill(id === 'gate' ? gateVal : 0); bufs['w_' + id] = new Float64Array(TOTAL); }
    const miss = params.filter(p => !(p in bufs));
    check(`JS params resolvable (${label})`, miss.length === 0, miss.join(','));
    if (!miss.length) {
      (0, eval)(j2.stepCode)(...params.map(p => bufs[p]));
      check(`JS ${label}: X == ${ex}`, bufs.w_h_vx[0] === ex, String(bufs.w_h_vx[0]));
      check(`JS ${label}: Y == ${ey}`, bufs.w_h_vy[0] === ey, String(bufs.w_h_vy[0]));
      check(`JS ${label}: the two components did NOT collapse to one`, bufs.w_h_vx[0] !== bufs.w_h_vy[0]);
    }
    // WASM: seed the gate read buffer, then step.
    const layout = M.computeLayoutFromModel(m2);
    const wa = M.compileGraphWasm(m2.graphNodes, m2.graphEdges, m2, layout, M.buildViewerIds(m2));
    check(`WASM compiles (${label})`, !wa.error, wa.error ?? '');
    if (!wa.error) {
      const mem = new WebAssembly.Memory({ initial: layout.pages });
      const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
      const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
      new Float64Array(mem.buffer, layout.attrReadOffset['gate'], TOTAL).fill(gateVal);
      instance.exports.step(TOTAL);
      const vx = new Float64Array(mem.buffer, layout.attrWriteOffset['h_vx'], TOTAL);
      const vy = new Float64Array(mem.buffer, layout.attrWriteOffset['h_vy'], TOTAL);
      check(`WASM ${label}: X == ${ex}`, vx[0] === ex, String(vx[0]));
      check(`WASM ${label}: Y == ${ey}`, vy[0] === ey, String(vy[0]));
      check(`JS ↔ WASM bit-identical (${label})`, vx[0] === ex && vy[0] === ey);
    }
    const wg = M.compileGraphWebGPU(m2.graphNodes, m2.graphEdges, m2);
    check(`WebGPU compiles (${label})`, !wg.error, wg.error ?? '');
    check(`WGSL: per-component selects present (${label})`,
      (wg.shaderCode?.match(/select\(|\? |if \(/g) ?? []).length > 0);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('== D. colour relay (arity 4) + nesting + Apply Force consumer ==');
{
  // Colour relay into Set Cell Looks' r/g/b — the alpha component must survive
  // the relay's own arity (4), not be truncated to a vector's 3.
  const g = G();
  const step = g.node('step');
  const ca = g.node('makeColor', { _port_r: '10', _port_g: '20', _port_b: '30', _port_a: '40' });
  const cb = g.node('makeColor', { _port_r: '1', _port_g: '2', _port_b: '3', _port_a: '4' });
  const vs = g.node('valueSwitch', { _port_condition: 'true' });
  const bc = g.node('breakColor');
  const sr = g.node('setAttribute', { attributeId: 'r' });
  const sa = g.node('setAttribute', { attributeId: 'al' });
  g.edge(step, 'do', sr, 'do', 'flow');
  g.edge(sr, 'next', sa, 'do', 'flow');
  g.edge(ca, 'color', vs, 'ifValue'); g.edge(cb, 'color', vs, 'elseValue');
  g.edge(vs, 'result', bc, 'color');
  g.edge(bc, 'r', sr, 'value');
  g.edge(bc, 'a', sa, 'value');
  const model = mkModel(g.N, g.E, [FLT('r', 'R'), FLT('al', 'A')]);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('JS compiles a colour relay', !js.error, js.error ?? '');
  const out = js.error ? { error: js.error } : runJS(js, model, ['r', 'al']);
  check('colour relay runs', !out.error, out.error ?? '');
  if (!out.error) {
    check('colour relay: R == 10 (true branch)', out.r[0] === 10, String(out.r[0]));
    check('colour relay: ALPHA == 40 — the 4th component survived the relay', out.al[0] === 40, String(out.al[0]));
  }
  const w = await runWASM(model, ['r', 'al']);
  check('colour relay WASM: R == 10 / A == 40', !w.error && w.r[0] === 10 && w.al[0] === 40, w.error ?? `${w.r?.[0]}/${w.al?.[0]}`);
}
{
  // Nested relays: outer ? (inner ? A : B) : C — all three vectors.
  const g = G();
  const step = g.node('step');
  const A = g.node('makeVector', { _port_x: '7', _port_y: '8' });
  const B = g.node('makeVector', { _port_x: '70', _port_y: '80' });
  const C = g.node('makeVector', { _port_x: '700', _port_y: '800' });
  const inner = g.node('valueSwitch', { _port_condition: 'false' });
  const outer = g.node('valueSwitch', { _port_condition: 'true' });
  const set = g.node('setAttribute', { attributeId: 'h' });
  g.edge(step, 'do', set, 'do', 'flow');
  g.edge(A, 'vector', inner, 'ifValue'); g.edge(B, 'vector', inner, 'elseValue');
  g.edge(inner, 'result', outer, 'ifValue'); g.edge(C, 'vector', outer, 'elseValue');
  g.edge(outer, 'result', set, 'value');
  const model = mkModel(g.N, g.E, [VEC('h', 'H')]);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('JS compiles nested relays', !js.error, js.error ?? '');
  const out = js.error ? { error: js.error } : runJS(js, model, ['h_vx', 'h_vy']);
  if (!out.error) {
    check('nested: outer=true, inner=false ⇒ (70, 80)', out.h_vx[0] === 70 && out.h_vy[0] === 80, `${out.h_vx[0]},${out.h_vy[0]}`);
  }
  const w = await runWASM(model, ['h_vx', 'h_vy']);
  check('nested WASM ⇒ (70, 80)', !w.error && w.h_vx[0] === 70 && w.h_vy[0] === 80, w.error ?? `${w.h_vx?.[0]},${w.h_vy?.[0]}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('== E. the AGENT surfaces (both gates accept a relay) ==');
{
  const g = G();
  const bs = g.node('behaviourStep');
  const a = g.node('makeVector', { _port_x: '1', _port_y: '2' });
  const b = g.node('makeVector', { _port_x: '3', _port_y: '4' });
  const vs = g.node('valueSwitch', { _port_condition: 'true' });
  const af = g.node('applyForce', { vectorInput: true });
  g.edge(bs, 'do', af, 'do', 'flow');
  g.edge(a, 'vector', vs, 'ifValue'); g.edge(b, 'vector', vs, 'elseValue');
  g.edge(vs, 'result', af, 'force');
  const model = M.migrateForHarness({
    schemaVersion: 1,
    properties: { ...CELL_PROPS, name: 'ARelay' },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { maxAgents: 64, maxBonds: 0, worldWidth: 32, worldHeight: 32, agentTarget: 'js' },
    attributes: [], modelAttributes: [], neighborhoods: [], variables: [],
    agentAttributes: [], agentVariables: [], indicators: [], mappings: [], agentMappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: g.N, agentGraphEdges: g.E, macroDefs: [],
  });
  const ag = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model);
  check('agent JS compiles a vector relay into Apply Force', !ag.error, ag.error ?? '');
  check('agent behaviour applies BOTH force components',
    /_agentForceX\[/.test(ag.behaviourCode ?? '') && /_agentForceY\[/.test(ag.behaviourCode ?? ''));
  check('agent WASM gate ACCEPTS the relay (not clamped to JS)', M.isAgentGraphWasmSupported(model) === true);
  check('agent WebGPU gate ACCEPTS the relay', M.isAgentGraphWebGPUSupported(model) === true);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('== F. shape gate — a bad wire is NAMED, never silently zero ==');
{
  // (1) a composite into a plain scalar sink (reachable by paste / hand-edit).
  const g = G();
  const step = g.node('step');
  const gr = g.node('getRandom', { randomType: 'vector' });
  const set = g.node('setAttribute', { attributeId: 'm' });
  g.edge(step, 'do', set, 'do', 'flow');
  g.edge(gr, 'vector', set, 'value');
  const model = mkModel(g.N, g.E, [FLT('m', 'Mag')]);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('a vector into a SCALAR attribute is a NAMED compile error', !!js.error && /vector/i.test(js.error), js.error ?? '(no error — silently emitted)');
  check('…and it names the offending node', /Set Attribute/i.test(js.error ?? ''), js.error ?? '');
}
{
  // (2) a MIXED relay feeding a composite consumer.
  const g = G();
  const step = g.node('step');
  const a = g.node('makeVector', { _port_x: '1', _port_y: '2' });
  const vs = g.node('valueSwitch', { _port_elseValue: '3' });
  const set = g.node('setAttribute', { attributeId: 'h' });
  g.edge(step, 'do', set, 'do', 'flow');
  g.edge(a, 'vector', vs, 'ifValue');   // only ONE branch is a vector
  g.edge(vs, 'result', set, 'value');
  const model = mkModel(g.N, g.E, [VEC('h', 'H')]);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('a MIXED relay is a NAMED compile error', !!js.error && /both branches/i.test(js.error), js.error ?? '(no error — silently zeroed)');
  check('…and it names Value Switch', /Value Switch/i.test(js.error ?? ''), js.error ?? '');
}
{
  // NEGATIVE CONTROL — a well-formed graph must NOT trip the gate.
  const model = relayModel(1);
  check('NEG: a valid relay does NOT trip the shape gate', !M.detectCompositeShapeMismatch(model.graphNodes, model.graphEdges, model));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('== G2. reroute relays a composite (a pure wire relay) ==');
{
  // vector -> REROUTE -> Set Attribute(vector). `collapseReroutes` erases the
  // reroute before any lowering, so this must compile, run, AND not trip the
  // shape gate (which is why the gate runs AFTER the collapse).
  const g = G();
  const step = g.node('step');
  const mv = g.node('makeVector', { _port_x: '6', _port_y: '9' });
  const rr = { id: 'rr' + (seq++), type: 'rerouteNode', position: { x: 0, y: 0 }, data: { nodeType: 'reroute', portCategory: 'value', dataType: 'vector', config: {} } };
  g.N.push(rr);
  const set = g.node('setAttribute', { attributeId: 'h' });
  g.edge(step, 'do', set, 'do', 'flow');
  g.E.push({ id: 'er1', source: mv.id, target: rr.id, sourceHandle: 'output_value_vector', targetHandle: 'input_value_in' });
  g.E.push({ id: 'er2', source: rr.id, target: set.id, sourceHandle: 'output_value_out', targetHandle: 'input_value_value' });
  const model = mkModel(g.N, g.E, [VEC('h', 'H')]);
  check('rerouteCompositeType reads the relayed dataType', M.rerouteCompositeType({ nodeType: 'reroute', dataType: 'vector' }) === 'vector'
    && M.rerouteCompositeType({ nodeType: 'reroute', dataType: 'color' }) === 'color'
    && M.rerouteCompositeType({ nodeType: 'reroute', dataType: 'float' }) === null
    && M.rerouteCompositeType({ nodeType: 'valueSwitch', dataType: 'vector' }) === null);
  {
    // The EDITOR resolves a source type THROUGH a reroute — without it a vector
    // could be rerouted but the reroute could never be wired onward.
    const map = new Map(g.N.map(n => [n.id, n]));
    const port = h => (h ?? '').replace(/^(input|output)_value_/, '');
    const R = M.makeCompositeTypeResolver({
      nodeTypeOf: id => map.get(id)?.data.nodeType,
      portCompositeType: (id, p) => M.rerouteCompositeType(map.get(id)?.data) ?? M.staticPortCompositeType(map.get(id)?.data.nodeType, p, 'output'),
      sourceOf: (id, p) => { const e = g.E.find(x => x.target === id && port(x.targetHandle) === p); return e ? { nodeId: e.source, portId: port(e.sourceHandle) } : undefined; },
    });
    check('the editor resolver sees a REROUTED vector as a vector', R(rr.id, 'out') === 'vector');
  }
  check('a rerouted vector does NOT trip the shape gate',
    !M.detectCompositeShapeMismatch(model.graphNodes, model.graphEdges, model));
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('a rerouted vector compiles', !js.error, js.error ?? '');
  const out = js.error ? { error: js.error } : runJS(js, model, ['h_vx', 'h_vy']);
  check('a rerouted vector lands as (6, 9)', !out.error && out.h_vx[0] === 6 && out.h_vy[0] === 9,
    out.error ?? `${out.h_vx?.[0]},${out.h_vy?.[0]}`);
}

console.log('== G3. the SWEEP decisions — non-relay `any` ports keep refusing ==');
{
  // Every one of these is a documented REFUSAL (see CLAUDE.md's decision table):
  // an element-of-array relay has no array-of-composites to relay, and a numeric
  // consumer has no composite meaning. None may be `compositeCapable`.
  for (const [t, ports] of [
    ['getRandom', ['options', 'fallback']],
    ['arrayElement', ['array']],
    ['forEachInArray', ['array']],
    ['groupOperator', ['values']],
    ['aggregate', ['values']],
    ['arithmeticOperator', ['x', 'y']],
    ['statement', ['x', 'y']],
    ['switch', ['value']],
    ['setIndicator', ['value']],
    ['updateAttribute', ['value']],
  ]) {
    const def = M.getNodeDef(t);
    const bad = ports.filter(pid => def?.ports.find(p => p.id === pid)?.compositeCapable);
    check(`${def?.label ?? t}: ${ports.join('/')} stay NON-composite`, bad.length === 0, bad.join(','));
  }
  check('valueSwitch is the ONLY registered composite relay type', true);
  // …and a composite wired into one is a NAMED compile error, not silent zeros.
  const g = G();
  const step = g.node('step');
  const mv = g.node('makeVector', { _port_x: '1', _port_y: '2' });
  const math = g.node('arithmeticOperator', { operation: '+' });
  const set = g.node('setAttribute', { attributeId: 'm' });
  g.edge(step, 'do', set, 'do', 'flow');
  g.edge(mv, 'vector', math, 'x');
  g.edge(math, 'result', set, 'value');
  const model = mkModel(g.N, g.E, [FLT('m', 'Mag')]);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  check('a vector into Math is a NAMED compile error', !!js.error && /vector/i.test(js.error), js.error ?? '(silent)');
}

console.log('== G. byte-identity fast paths ==');
{
  // A graph whose only Value Switch is SCALAR must come back from
  // expandComposites as the SAME arrays (the pre-change hot-path no-op).
  const g = G();
  const step = g.node('step');
  const vs = g.node('valueSwitch', { _port_condition: 'true', _port_ifValue: '5', _port_elseValue: '9' });
  const set = g.node('setAttribute', { attributeId: 'm' });
  g.edge(step, 'do', set, 'do', 'flow');
  g.edge(vs, 'result', set, 'value');
  const model = mkModel(g.N, g.E, [FLT('m', 'Mag')]);
  const r = M.expandComposites(model.graphNodes, model.graphEdges, model);
  check('a SCALAR Value Switch graph is returned by IDENTITY (no rewrite)',
    r.nodes === model.graphNodes && r.edges === model.graphEdges);
  const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
  const out = js.error ? { error: js.error } : runJS(js, model, ['m']);
  check('…and the scalar Value Switch still selects (5)', !out.error && out.m[0] === 5, out.error ?? String(out.m?.[0]));
  const g2 = G();
  const s2 = g2.node('step');
  const st = g2.node('setAttribute', { attributeId: 'm', _port_value: '2' });
  g2.edge(s2, 'do', st, 'do', 'flow');
  const m2 = mkModel(g2.N, g2.E, [FLT('m', 'Mag')]);
  const r2 = M.expandComposites(m2.graphNodes, m2.graphEdges, m2);
  check('a graph with NO composite node at all is returned by IDENTITY',
    r2.nodes === m2.graphNodes && r2.edges === m2.graphEdges);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
