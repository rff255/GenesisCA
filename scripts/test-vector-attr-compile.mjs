// Compile-level test: a CELL model that WRITES a vector attribute (via Set Vector
// Attribute ← Make Vector) and READS it back (Get Vector Attribute → Break Vector →
// Set a scalar). Confirms lowerVectorAttrs rewrites it into per-component scalar
// float reads/writes that the JS compiler emits — the storage half of the feature.
//   Run from the repo root:  node scripts/test-vector-attr-compile.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileGraph, compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { compileGraphWebGPU } from '../src/modeler/vpl/compiler/webgpu/compile.ts';
export { computeLayoutFromModel, buildViewerIds } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { lowerVectorAttrs, VECTOR_LOWERED, expandVectorVariables, vectorPortDims } from '../src/modeler/vpl/compiler/vectorAttr.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-vac-'));
const entryPath = join(ROOT, 'scripts', '__vac_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

const nid = (p) => p + Math.random().toString(36).slice(2, 8);
const N = [], E = [];
const node = (t, c = {}) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; N.push(n); return n; };
const edge = (s, sp, tt, tp, cat) => E.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

const step = node('step');
const mv = node('makeVector', { _port_x: '3', _port_y: '4' });
const setVec = node('setAttribute', { attributeId: 'heading' });
const getVec = node('getCellAttribute', { attributeId: 'heading' });
const bv = node('breakVector');
const setMag = node('setAttribute', { attributeId: 'mag' });
edge(step, 'do', setVec, 'do', 'flow');
edge(mv, 'vector', setVec, 'value', 'value');
edge(setVec, 'next', setMag, 'do', 'flow');
edge(getVec, 'value', bv, 'vector', 'value');
edge(bv, 'x', setMag, 'value', 'value');

const raw = {
  schemaVersion: 1,
  properties: { name: 'VecCell', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false, updateMode: 'synchronous' },
  attributes: [
    { id: 'heading', name: 'Heading', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '1,0' },
    { id: 'mag', name: 'Mag', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
  ],
  modelAttributes: [], neighborhoods: [], variables: [], indicators: [], mappings: [],
  graphNodes: N, graphEdges: E, macroDefs: [],
};
const model = m.migrateForHarness(raw);
const res = m.compileGraph(model.graphNodes, model.graphEdges, model);

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
if (res.error) { console.log(`COMPILE ERROR: ${res.error}`); process.exit(1); }
const code = res.stepCode;
// The vector WRITE lowered to two scalar component writes with the Make Vector literals.
check('writes heading_vx = 3', /w_heading_vx\[[^\]]*\]\s*=\s*3\b/.test(code));
check('writes heading_vy = 4', /w_heading_vy\[[^\]]*\]\s*=\s*4\b/.test(code));
// The vector READ lowered to a scalar component read feeding mag.
check('reads r_heading_vx', /r_heading_vx\[/.test(code));
// The read goes through an intermediate var (const _v.. = r_heading_vx[idx]); mag
// is then assigned that var — follow the chain.
const rd = code.match(/const (_v\w+) = r_heading_vx\[/);
check('writes mag from heading_vx', !!rd && new RegExp(`w_mag\\[[^\\]]*\\]\\s*=\\s*${rd[1]}\\b`).test(code));
// No un-lowered vector node names survive into the emitted code.
check('no getVectorAttribute leak', !/getVectorAttribute|setVectorAttribute/.test(code));
// The SoA loop-param signature carries the component attrs (not a bare vector id).
const sig = code.slice(0, code.indexOf(')'));
check('signature has all 4 component params', ['r_heading_vx', 'r_heading_vy', 'w_heading_vx', 'w_heading_vy'].every(p => sig.includes(p)));
check('signature has no bare vector param', !/[ ,(]heading[,)]/.test(sig) && !/_heading[,)]/.test(sig));

if (fail) { console.log('\n--- emitted stepCode ---\n' + code.slice(0, 1400)); }
console.log(`${fail === 0 ? 'VECTOR-ATTR JS CELL COMPILE ✓' : `${fail} CELL FAILED`}  (${pass} passed)`);

// ── JS AGENT path: same vector store/read on the agent behaviour graph ─────────
{
  const AN = [], AE = [];
  const an = (t, c = {}) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; AN.push(n); return n; };
  const ae = (s, sp, tt, tp, cat) => AE.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep');
  const mv2 = an('makeVector', { _port_x: '7', _port_y: '9' });
  const setV = an('setAttribute', { attributeId: 'facing' });
  ae(bs, 'do', setV, 'do', 'flow');
  ae(mv2, 'vector', setV, 'value', 'value');
  const rawA = {
    schemaVersion: 1,
    properties: { name: 'VecAgent', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus' },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 50, maxBonds: 0, worldWidth: 8, worldHeight: 8, defaultRadius: 0.5, agentTarget: 'js', agentUpdateMode: 'async', agentCapabilities: { motion: 'force', body: true } },
    attributes: [], modelAttributes: [], neighborhoods: [], variables: [], indicators: [], mappings: [],
    agentAttributes: [{ id: 'facing', name: 'Facing', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '1,0' }],
    agentVariables: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: AN, agentGraphEdges: AE, macroDefs: [],
  };
  const modelA = m.migrateForHarness(rawA);
  const resA = m.compileAgentGraph(modelA.agentGraphNodes, modelA.agentGraphEdges, modelA);
  const ac = (n, c) => { if (!c) { fail++; console.log('FAIL agent ' + n); } };
  if (resA.error) { console.log('AGENT COMPILE ERROR: ' + resA.error); fail++; }
  const bc = resA.behaviourCode || '';
  ac('writes facing_vx = 7', /w_facing_vx\[[^\]]*\]\s*=\s*7\b/.test(bc));
  ac('writes facing_vy = 9', /w_facing_vy\[[^\]]*\]\s*=\s*9\b/.test(bc));
  ac('no vector-node leak', !/getVectorAttribute|setVectorAttribute/.test(bc));
  ac('signature has facing_vx/_vy, no bare facing', /r_facing_vx|w_facing_vx/.test(bc) && !/[ ,(]facing[,)]/.test(bc.slice(0, bc.indexOf(')'))));
  console.log(`VECTOR-ATTR JS AGENT COMPILE ${fail === 0 ? '✓' : '✗'}`);
}

// ── VECTOR LOCAL VARIABLE (the accumulated-force case): one vector variable
// instead of separate X/Y floats. Read → add → write back.
{
  const VN = [], VE = [];
  const vn = (t, c = {}) => { const n = { id: nid('v'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; VN.push(n); return n; };
  const ve = (s, sp, tt, tp, cat) => VE.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const stp = vn('step');
  const cur = vn('getVariable', { variableId: 'acc' });          // read accumulator
  const delta = vn('makeVector', { _port_x: '1', _port_y: '2' });      // a delta
  const add = vn('vectorOp', { op: 'add' });                          // acc + delta
  const setAcc = vn('setVariable', { variableId: 'acc' });       // write back
  ve(stp, 'do', setAcc, 'do', 'flow');
  ve(cur, 'value', add, 'a', 'value');
  ve(delta, 'vector', add, 'b', 'value');
  ve(add, 'result', setAcc, 'value', 'value');
  const rawV = {
    schemaVersion: 1,
    properties: { name: 'VecVar', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'synchronous' },
    attributes: [], modelAttributes: [], neighborhoods: [], indicators: [], mappings: [],
    variables: [{ id: 'acc', name: 'Acc', kind: 'scalar', dataType: 'vector', vectorDims: 2, initialValue: '0,0' }],
    graphNodes: VN, graphEdges: VE, macroDefs: [],
  };
  const modelV = m.migrateForHarness(rawV);
  const resV = m.compileGraph(modelV.graphNodes, modelV.graphEdges, modelV);
  const vc = (n, c) => { if (!c) { fail++; console.log('FAIL var ' + n); } };
  if (resV.error) { console.log('VAR COMPILE ERROR: ' + resV.error); fail++; }
  const sc = resV.stepCode || '';
  // The vector variable expanded into two float scratch variables (allocated + written).
  vc('declares _var_acc_vx', /_var_acc_vx/.test(sc));
  vc('declares _var_acc_vy', /_var_acc_vy/.test(sc));
  vc('reads _var_acc_vx in the add', /_var_acc_vx/.test(sc) && /\+/.test(sc));
  vc('writes _var_acc_vx =', /_var_acc_vx\s*=/.test(sc));
  vc('writes _var_acc_vy =', /_var_acc_vy\s*=/.test(sc));
  vc('no vector-node leak', !/getVectorVariable|setVectorVariable/.test(sc));
  vc('no bare _var_acc scalar (only components)', !/_var_acc\s*=/.test(sc) && !/_var_acc\b(?!_v)/.test(sc.replace(/_var_acc_v[xyz]/g, '')));
  console.log(`VECTOR LOCAL VARIABLE COMPILE ${fail === 0 ? '✓' : '✗'}`);
}

// ── WASM CELL: the same cell vector model must compile (compiler layout ≡ the
// worker's, since both call computeLayoutFromModel/computeMemoryLayout which now
// expand vector attrs). A byte-level "does it compile without error" check.
{
  const layout = m.computeLayoutFromModel(model);
  const viewerIds = m.buildViewerIds(model);
  const resW = m.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, viewerIds);
  const wc = (n, c) => { if (!c) { fail++; console.log('FAIL wasm ' + n); } };
  wc('no wasm compile error', !resW.error);
  wc('wasm bytes emitted', resW.bytes && resW.bytes.length > 8);
  // The layout must carry the component attr offsets (not the bare vector id).
  wc('layout has heading_vx offset', layout.attrReadOffset && ('heading_vx' in layout.attrReadOffset));
  wc('layout has heading_vy offset', layout.attrReadOffset && ('heading_vy' in layout.attrReadOffset));
  wc('layout has NO bare heading offset', layout.attrReadOffset && !('heading' in layout.attrReadOffset));
  console.log(`VECTOR-ATTR WASM CELL COMPILE ${fail === 0 ? '✓' : '✗'}${resW.error ? ' — ' + resW.error : ''}`);
}

// ── TIER A: neighbour READ of a vector cell attr (getNeighborAttributeByIndex) on
// ALL THREE targets. The shared NI index fans out to BOTH component readers. ───────
{
  const NN = [], NE = [];
  const nn = (t, c = {}) => { const n = { id: nid('nr'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; NN.push(n); return n; };
  const ne = (s, sp, tt, tp, cat) => NE.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const stp = nn('step');
  const nifo = nn('neighborIndexFromOffset', { _port_dr: '0', _port_dc: '1' });
  const getN = nn('getNeighborAttributeByIndex', { attributeId: 'flow' });
  const bvN = nn('breakVector');
  const setOut = nn('setAttribute', { attributeId: 'outX' });
  ne(stp, 'do', setOut, 'do', 'flow');
  ne(nifo, 'value', getN, 'index', 'value');
  ne(getN, 'value', bvN, 'vector', 'value');
  ne(bvN, 'x', setOut, 'value', 'value');
  const rawN = {
    schemaVersion: 1,
    properties: { name: 'VecNbr', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'synchronous' },
    attributes: [
      { id: 'flow', name: 'Flow', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '2,3' },
      { id: 'outX', name: 'OutX', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
    ],
    modelAttributes: [], neighborhoods: [], variables: [], indicators: [], mappings: [],
    graphNodes: NN, graphEdges: NE, macroDefs: [],
  };
  const mN = m.migrateForHarness(rawN);
  const rj = m.compileGraph(mN.graphNodes, mN.graphEdges, mN);
  const nc = (n, c) => { if (!c) { fail++; console.log('FAIL nbr-read ' + n); } };
  if (rj.error) { console.log('NBR-READ JS ERROR: ' + rj.error); fail++; }
  const jc = rj.stepCode || '';
  nc('reads r_flow_vx (component, not bare vector)', /r_flow_vx\[/.test(jc));
  nc('no bare r_flow read', !/r_flow\[/.test(jc));
  nc('no vector node name leak', !/getVectorAttribute|setVectorAttribute/.test(jc));
  // WASM + WebGPU compile clean.
  const lay = m.computeLayoutFromModel(mN), vids = m.buildViewerIds(mN);
  const rw = m.compileGraphWasm(mN.graphNodes, mN.graphEdges, mN, lay, vids);
  nc('WASM compiles', !rw.error && rw.bytes.length > 8);
  nc('WASM layout has flow_vx/_vy, no bare flow', ('flow_vx' in lay.attrReadOffset) && ('flow_vy' in lay.attrReadOffset) && !('flow' in lay.attrReadOffset));
  const rg = m.compileGraphWebGPU(mN.graphNodes, mN.graphEdges, mN);
  nc('WebGPU compiles', !rg.error && (rg.shaderCode || '').length > 8);
  console.log(`VECTOR NBR-READ (getNeighborAttributeByIndex) 3-TARGET ${fail === 0 ? '✓' : '✗'}${rw.error ? ' wasm:' + rw.error : ''}${rg.error ? ' webgpu:' + rg.error : ''}`);
}

// ── TIER A: neighbour WRITE of a vector cell attr (setNeighborAttributeByIndex),
// ASYNC (JS + WASM; WebGPU rejects async). breakVector + a component-write chain. ──
{
  const WN = [], WE = [];
  const wn = (t, c = {}) => { const n = { id: nid('nw'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; WN.push(n); return n; };
  const we = (s, sp, tt, tp, cat) => WE.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const stp = wn('step');
  const nifo = wn('neighborIndexFromOffset', { _port_dr: '0', _port_dc: '1' });
  const mkv = wn('makeVector', { _port_x: '5', _port_y: '6' });
  const setN = wn('setNeighborAttributeByIndex', { attributeId: 'flow' });
  we(stp, 'do', setN, 'do', 'flow');
  we(nifo, 'value', setN, 'index', 'value');
  we(mkv, 'vector', setN, 'value', 'value');
  const rawW = {
    schemaVersion: 1,
    properties: { name: 'VecNbrW', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'asynchronous', asyncScheme: 'random-order' },
    attributes: [{ id: 'flow', name: 'Flow', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '0,0' }],
    modelAttributes: [], neighborhoods: [], variables: [], indicators: [], mappings: [],
    graphNodes: WN, graphEdges: WE, macroDefs: [],
  };
  const mW = m.migrateForHarness(rawW);
  const rj = m.compileGraph(mW.graphNodes, mW.graphEdges, mW);
  const wc = (n, c) => { if (!c) { fail++; console.log('FAIL nbr-write ' + n); } };
  if (rj.error) { console.log('NBR-WRITE JS ERROR: ' + rj.error); fail++; }
  const jc = rj.stepCode || '';
  wc('writes w_flow_vx = 5', /w_flow_vx\[[^\]]*\]\s*=\s*5\b/.test(jc));
  wc('writes w_flow_vy = 6', /w_flow_vy\[[^\]]*\]\s*=\s*6\b/.test(jc));
  wc('no bare w_flow write', !/w_flow\[/.test(jc));
  const lay = m.computeLayoutFromModel(mW), vids = m.buildViewerIds(mW);
  const rw = m.compileGraphWasm(mW.graphNodes, mW.graphEdges, mW, lay, vids);
  wc('WASM compiles', !rw.error && rw.bytes.length > 8);
  console.log(`VECTOR NBR-WRITE (setNeighborAttributeByIndex) JS+WASM ${fail === 0 ? '✓' : '✗'}${rw.error ? ' wasm:' + rw.error : ''}`);
}

// ── TIER A: by-id AGENT read of a vector agent attr (getAgentAttribute), on the
// agent behaviour graph. The shared agent id fans out to both component readers. ───
{
  const GN = [], GE = [];
  const gn = (t, c = {}) => { const n = { id: nid('ag'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; GN.push(n); return n; };
  const ge = (s, sp, tt, tp, cat) => GE.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = gn('behaviourStep');
  const self = gn('getSelfHandle');
  const getA = gn('getAgentAttribute', { attributeId: 'facing' });
  const bvA = gn('breakVector');
  const setA = gn('setAttribute', { attributeId: 'mag' });
  ge(bs, 'do', setA, 'do', 'flow');
  ge(self, 'value', getA, 'agentId', 'value');
  ge(getA, 'value', bvA, 'vector', 'value');
  ge(bvA, 'x', setA, 'value', 'value');
  const rawG = {
    schemaVersion: 1,
    properties: { name: 'VecAgentById', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus' },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 50, maxBonds: 0, worldWidth: 8, worldHeight: 8, defaultRadius: 0.5, agentTarget: 'js', agentUpdateMode: 'async', agentCapabilities: { motion: 'force', body: true } },
    attributes: [], modelAttributes: [], neighborhoods: [], variables: [], indicators: [], mappings: [],
    agentAttributes: [
      { id: 'facing', name: 'Facing', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '1,0' },
      { id: 'mag', name: 'Mag', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
    ],
    agentVariables: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: GN, agentGraphEdges: GE, macroDefs: [],
  };
  const mG = m.migrateForHarness(rawG);
  const rA = m.compileAgentGraph(mG.agentGraphNodes, mG.agentGraphEdges, mG);
  const gc = (n, c) => { if (!c) { fail++; console.log('FAIL agent-by-id ' + n); } };
  if (rA.error) { console.log('AGENT-BY-ID ERROR: ' + rA.error); fail++; }
  const bc = rA.behaviourCode || '';
  gc('reads r_facing_vx (component, not bare vector)', /r_facing_vx\[/.test(bc));
  gc('no bare r_facing read', !/r_facing\[/.test(bc));
  console.log(`VECTOR AGENT-BY-ID READ (getAgentAttribute) ${fail === 0 ? '✓' : '✗'}`);
}

// ── Direct transform unit tests: the getNeighborAttributeByTag _resolvedTagIndex
// bake (WASM/WebGPU have no tag pre-pass) + moveSelfToNeighbor slot expansion. ──────
{
  const dc = (n, c) => { if (!c) { fail++; console.log('FAIL transform ' + n); } };
  // getNeighborAttributeByTag → component readers with the tag index baked (index 1).
  const tagModel = m.migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'T', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'synchronous' },
    attributes: [{ id: 'flow', name: 'F', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '0,0' }],
    modelAttributes: [],
    neighborhoods: [{ id: 'nb', name: 'NB', description: '', margin: 2, includeCentralCell: false, coords: [[-1, 0], [0, 1]], tags: { 1: 'up' } }],
    variables: [], indicators: [], mappings: [], graphNodes: [], graphEdges: [], macroDefs: [],
  });
  const tagNode = { id: 'gt1', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'getNeighborAttributeByTag', config: { neighborhoodId: 'nb', attributeId: 'flow', tagName: 'up' } } };
  const lo = m.lowerVectorAttrs([tagNode], [], tagModel);
  const tagReaders = lo.nodes.filter(n => n.data.nodeType === 'getNeighborAttributeByTag');
  dc('tag read lowered to 2 component readers', tagReaders.length === 2);
  dc('component readers carry neighborhoodId + tagName', tagReaders.every(n => n.data.config.neighborhoodId === 'nb' && n.data.config.tagName === 'up'));
  dc('_resolvedTagIndex baked (=1) on both readers', tagReaders.every(n => n.data.config._resolvedTagIndex === 1));
  dc('readers reference flow_vx / flow_vy', tagReaders.map(n => n.data.config.attributeId).sort().join(',') === 'flow_vx,flow_vy');
  dc('a makeVector was synthesized', lo.nodes.some(n => n.data.nodeType === 'makeVector'));

  // moveSelfToNeighbor slot expansion: 1 vector slot → 2 component slots.
  const mvModel = m.migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'MV', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'asynchronous', asyncScheme: 'random-order' },
    attributes: [
      { id: 'flow', name: 'F', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '4,9' },
      { id: 'cnt', name: 'C', type: 'integer', description: '', isModelAttribute: false, defaultValue: '7' },
    ],
    modelAttributes: [], neighborhoods: [], variables: [], indicators: [], mappings: [], graphNodes: [], graphEdges: [], macroDefs: [],
  });
  const moveNode = { id: 'mv1', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'moveSelfToNeighbor', config: { payloadCount: 2, attr_0: 'flow', attr_1: 'cnt', operation: 'copyTo', nonReceiving: 'defaults' } } };
  const lm = m.lowerVectorAttrs([moveNode], [], mvModel);
  const mvOut = lm.nodes.find(n => n.data.nodeType === 'moveSelfToNeighbor');
  dc('moveSelfToNeighbor cloned (not the original object)', mvOut && mvOut !== moveNode);
  dc('original move config unmutated (still payloadCount 2, attr_0 flow)', moveNode.data.config.payloadCount === 2 && moveNode.data.config.attr_0 === 'flow');
  dc('expanded to payloadCount 3', mvOut.data.config.payloadCount === 3);
  dc('slots = flow_vx, flow_vy, cnt', [mvOut.data.config.attr_0, mvOut.data.config.attr_1, mvOut.data.config.attr_2].join(',') === 'flow_vx,flow_vy,cnt');
  dc('_attr defaults baked (4, 9, 7)', mvOut.data.config._attr_0_default === '4' && mvOut.data.config._attr_1_default === '9' && mvOut.data.config._attr_2_default === '7');

  // The refined validation set: getCellAttribute lowered, getNeighborsAttribute NOT.
  dc('VECTOR_LOWERED includes the newly-lowered nodes', ['getNeighborAttributeByIndex', 'getNeighborAttributeByTag', 'getAgentAttribute', 'setNeighborAttributeByIndex', 'setNeighborhoodAttribute', 'setAttribute', 'moveSelfToNeighbor'].every(t => m.VECTOR_LOWERED.has(t)));
  dc('VECTOR_LOWERED excludes array-of-vectors / updateAttribute', !m.VECTOR_LOWERED.has('getNeighborsAttribute') && !m.VECTOR_LOWERED.has('getAgentsAttribute') && !m.VECTOR_LOWERED.has('filterNeighbors') && !m.VECTOR_LOWERED.has('updateAttribute'));
  console.log(`VECTOR TRANSFORM UNIT (tag-index bake + move slots + VECTOR_LOWERED) ${fail === 0 ? '✓' : '✗'}`);
}

// ── TIER V: vector LOCAL VARIABLE **runtime values** on JS + a REAL instantiated
// WASM module + the WGSL emit shape. The blocks above assert the emitted SHAPE;
// this one asserts the NUMBERS, which is the only thing that catches a component
// swap, a collapsed pair, or an `initialValue` that never reached the components.
//
// Two models, because they exercise different halves of the lowering:
//   (a) INIT   — read the variable WITHOUT writing it: proves `expandVectorVariables`
//                split `initialValue` "5,7" into per-component seeds (X=5, Y=7).
//   (b) RW     — Set Variable ← Make Vector(3,4), then Get Variable → Break Vector:
//                proves the Set/Get round trip keeps the components DISTINCT and in
//                order, and that the read sees the post-write value (flow order).
//   (c) ACC    — the canonical accumulator: acc(1,10) + delta(3,4) via Vector Op,
//                written back through the variable. Asymmetric on purpose so an
//                x/y swap or a collapsed pair cannot pass.
{
  const TOTAL = 4, W = 2, H = 2;
  const cellBufs = (ids) => {
    const b = {
      total: TOTAL, W, H, D: 1, WH: W * H, modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4),
      activeViewer: '', _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
      _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
      _lookupTables: {}, _facePatternLookup: new Int32Array(0),
      r_orientation: new Int32Array(TOTAL), w_orientation: new Int32Array(TOTAL),
      order: null, _skipped: new Uint8Array(0), _activeList: null, _activeCount: -1,
    };
    for (const id of ids) { b['r_' + id] = new Float64Array(TOTAL); b['w_' + id] = new Float64Array(TOTAL); }
    return b;
  };
  const outAttrs = [
    { id: 'ox', name: 'OX', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
    { id: 'oy', name: 'OY', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
  ];
  const mkVarModel = (nodes, edges, initial) => m.migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'VecVarRun', dimension: '2d', gridWidth: W, gridHeight: H, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', updateMode: 'synchronous' },
    attributes: outAttrs, modelAttributes: [], neighborhoods: [], indicators: [], mappings: [],
    variables: [{ id: 'acc', name: 'Acc', kind: 'scalar', dataType: 'vector', vectorDims: 2, initialValue: initial }],
    graphNodes: nodes, graphEdges: edges, macroDefs: [],
  });

  /** Build one of the three graphs. `mode`: 'init' | 'rw' | 'acc'. */
  const buildVarGraph = (mode) => {
    const VN = [], VE = [];
    const vn = (t, c = {}) => { const n = { id: nid('rv'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; VN.push(n); return n; };
    const ve = (s, sp, tt, tp, cat) => VE.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
    const stp = vn('step');
    const setOX = vn('setAttribute', { attributeId: 'ox' });
    const setOY = vn('setAttribute', { attributeId: 'oy' });
    let head = stp, headPort = 'do';
    if (mode !== 'init') {
      // Set Variable ← (Make Vector, or acc + delta through Vector Op).
      const setAcc = vn('setVariable', { variableId: 'acc' });
      if (mode === 'rw') {
        const mkv = vn('makeVector', { _port_x: '3', _port_y: '4' });
        ve(mkv, 'vector', setAcc, 'value', 'value');
      } else {
        const cur = vn('getVariable', { variableId: 'acc' });
        const delta = vn('makeVector', { _port_x: '3', _port_y: '4' });
        const add = vn('vectorOp', { op: 'add' });
        ve(cur, 'value', add, 'a', 'value');
        ve(delta, 'vector', add, 'b', 'value');
        ve(add, 'result', setAcc, 'value', 'value');
      }
      ve(head, headPort, setAcc, 'do', 'flow');
      head = setAcc; headPort = 'next';
    }
    // Read the variable back and split it into the two scalar out-attributes.
    const get = vn('getVariable', { variableId: 'acc' });
    const brk = vn('breakVector');
    ve(get, 'value', brk, 'vector', 'value');
    ve(brk, 'x', setOX, 'value', 'value');
    ve(brk, 'y', setOY, 'value', 'value');
    ve(head, headPort, setOX, 'do', 'flow');
    ve(setOX, 'next', setOY, 'do', 'flow');
    return { VN, VE };
  };

  // (initial, mode) → the expected (X, Y) after ONE step.
  const CASES = [
    { mode: 'init', initial: '5,7', ex: 5, ey: 7, label: 'initialValue "5,7" seeds the components' },
    { mode: 'rw', initial: '0,0', ex: 3, ey: 4, label: 'Set(3,4) then Get round-trips distinct components' },
    { mode: 'acc', initial: '1,10', ex: 4, ey: 14, label: 'accumulate acc(1,10) + delta(3,4)' },
  ];
  let tierFail = 0;
  const vr = (n, c, got) => { if (!c) { fail++; tierFail++; console.log(`FAIL varrun ${n}${got !== undefined ? ' — got ' + got : ''}`); } };

  for (const cs of CASES) {
    const { VN, VE } = buildVarGraph(cs.mode);
    const mdl = mkVarModel(VN, VE, cs.initial);

    // ── JS: run the compiled step and read the written out-attributes.
    const js = m.compileGraph(mdl.graphNodes, mdl.graphEdges, mdl);
    vr(`JS compiles (${cs.label})`, !js.error, js.error);
    if (!js.error) {
      const params = /\(function\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim());
      const bufs = cellBufs(['ox', 'oy']);
      const miss = params.filter(p => !(p in bufs));
      vr(`JS params resolvable (${cs.label})`, miss.length === 0, miss.join(','));
      if (!miss.length) {
        (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
        vr(`JS ${cs.label}: X == ${cs.ex}`, bufs.w_ox[0] === cs.ex, bufs.w_ox[0]);
        vr(`JS ${cs.label}: Y == ${cs.ey}`, bufs.w_oy[0] === cs.ey, bufs.w_oy[0]);
        vr(`JS ${cs.label}: the components did NOT collapse`, bufs.w_ox[0] !== bufs.w_oy[0]);
        vr(`JS ${cs.label}: every cell agrees`, [...bufs.w_ox].every(v => v === cs.ex) && [...bufs.w_oy].every(v => v === cs.ey));
      }
    }

    // ── WASM: a REAL instantiated module over the same model.
    const layout = m.computeLayoutFromModel(mdl);
    const wa = m.compileGraphWasm(mdl.graphNodes, mdl.graphEdges, mdl, layout, m.buildViewerIds(mdl));
    vr(`WASM compiles (${cs.label})`, !wa.error, wa.error);
    if (!wa.error) {
      const mem = new WebAssembly.Memory({ initial: layout.pages });
      const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
      const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
      instance.exports.step(TOTAL);
      const ox = new Float64Array(mem.buffer, layout.attrWriteOffset['ox'], TOTAL);
      const oy = new Float64Array(mem.buffer, layout.attrWriteOffset['oy'], TOTAL);
      vr(`WASM ${cs.label}: X == ${cs.ex}`, ox[0] === cs.ex, ox[0]);
      vr(`WASM ${cs.label}: Y == ${cs.ey}`, oy[0] === cs.ey, oy[0]);
      vr(`JS ↔ WASM bit-identical (${cs.label})`, ox[0] === cs.ex && oy[0] === cs.ey);
    }

    // ── WebGPU: the emit must reference BOTH component scratch vars and no bare one.
    const wg = m.compileGraphWebGPU(mdl.graphNodes, mdl.graphEdges, mdl);
    vr(`WGSL compiles (${cs.label})`, !wg.error, wg.error);
    if (!wg.error) {
      const sh = wg.shaderCode || '';
      vr(`WGSL ${cs.label}: declares both variable components`, /_var_acc_vx/.test(sh) && /_var_acc_vy/.test(sh));
      vr(`WGSL ${cs.label}: no bare _var_acc`, !/_var_acc\b(?!_v)/.test(sh.replace(/_var_acc_v[xyz]/g, '')));
    }
  }

  // The variable expansion itself, by value — the seeds the UI's per-component
  // Initial Value editor writes must be what the components are initialised to.
  const exp = m.expandVectorVariables([{ id: 'acc', name: 'Acc', kind: 'scalar', dataType: 'vector', vectorDims: 3, initialValue: '5,7,9' }]);
  vr('expandVectorVariables → 3 float components', exp.length === 3 && exp.every(v => v.dataType === 'float' && v.kind === 'scalar'));
  vr('component ids are _vx/_vy/_vz', exp.map(v => v.id).join(',') === 'acc_vx,acc_vy,acc_vz');
  vr('component initialValues split 5 / 7 / 9', exp.map(v => v.initialValue).join(',') === '5,7,9');
  vr('an ARRAY-kind vector is NOT expanded (scalar-only type)',
    m.expandVectorVariables([{ id: 'a', name: 'A', kind: 'array', dataType: 'vector', length: 4, initialValue: '0,0' }]).length === 1);

  console.log(`VECTOR LOCAL VARIABLE RUNTIME VALUES (JS + real WASM + WGSL) ${tierFail === 0 ? '✓' : '✗'}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL JS+WASM+WEBGPU VECTOR-ATTR COMPILE CHECKS ✓' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
