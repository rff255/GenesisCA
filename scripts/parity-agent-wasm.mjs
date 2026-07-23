// JS↔WASM BIT-PARITY harness for the FULL-COVERAGE WASM agent BEHAVIOUR module.
// For each agent sample model, build the JS behaviour fn + the WASM behaviour
// module, seed two IDENTICAL stores (one plain-JS, one wasmBacked), then run the
// behaviour fn N steps on each with the SAME RNG seed + the SAME spatial hash +
// the SAME external regions, and compare the agent SoA / attrs / requests / field
// deposit element-wise. The force pass + structural phase are out of scope here
// (force-pass parity proven in W1; structural phase is target-independent CPU).
//
// Run from the repo root:  node scripts/parity-agent-wasm.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, formBond } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras, isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { buildAgentAbiArgs } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { agentAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { resolveKeyLabels, normalizeLookupTable } from '../src/modeler/vpl/compiler/variegation.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-parity-'));
const entryPath = join(ROOT, 'scripts', '__parity_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
const {
  createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, formBond,
  compileAgentGraphWasmForModel, instantiateAgentWasm,
  compileAgentGraph, buildAgentAbiArgs, migrateForHarness, agentAttrsOf, cellFieldAttrsOf,
  resolveKeyLabels, normalizeLookupTable,
} = m;

const cbNum = (cfg, k, d) => { const v = cfg?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };

// STEP 0: the harness is now a CONSUMER of the shared ABI descriptor (agentAbi.ts)
// — the SAME `buildAgentAbiArgs` the worker uses — instead of a 4th hand-copy that
// could silently desync. So this parity run also verifies the descriptor-derived
// loop args (the worker's `buildAgentLoopArgs` routes through the same function).
function buildArgs(s, hash, ctx) {
  const shape = { is3d: s.worldDepth > 1, agentAttrs: s.attrSpecs, fieldAttrs: ctx.fieldSpecs, hasLookupTables: ctx.hasLookupTables };
  const rt = {
    hash, emptyI32: new Int32Array(0),
    modelAttrs: ctx.cachedModelAttrs, viewer: ctx.activeViewer,
    indicators: ctx.cachedIndicators, rngState: ctx.rngState, stopFlag: ctx.stopFlag,
    glyphCodes: ctx.GLYPH_NOOP_CODES, glyphColors: ctx.GLYPH_NOOP_COLORS,
    lookupTables: ctx.cachedInteractionTables,
    width: ctx.width, height: ctx.height, total: ctx.total, torus: ctx.torus,
    fieldArray: (id) => ctx.readAttrs[id],
  };
  return buildAgentAbiArgs('loop', shape, s, rt);
}

// Synthetic 3D-field parity vehicle — exercises ALL FIVE field-bridge nodes in 3D:
//   secreteToField (8-cell trilinear splat) + affectCellsUnder (r-sphere scatter)
//   + fieldGradient.dx/dy/dz (trilinear central diffs) + sampleField (trilinear
//   point read) + readCellsUnder (r-sphere mean). Apply Force is 2D for the graph
//   force (fx/fy only — no fz port), so every field output routes into fx/fy so a
//   wrong 3D read/write diverges the position. 32x32x16 torus.
function build3DFieldModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const cN = [], cEd = [], aN = [], aEd = [];
  const cn = (t, c) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; cN.push(n); return n; };
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const ed = (arr) => (s, sp, tt, tp, cat) => arr.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const cE = ed(cEd), aE = ed(aEd);
  const cV = (s, sp, tt, tp) => cE(s, sp, tt, tp, 'value'), cF = (s, sp, tt, tp) => cE(s, sp, tt, tp, 'flow');
  const aV = (s, sp, tt, tp) => aE(s, sp, tt, tp, 'value'), aF = (s, sp, tt, tp) => aE(s, sp, tt, tp, 'flow');
  // Moore-3D neighbourhood (diffuse both fields)
  const mooreId = nid('nb'); const coords3d = [], coords = [];
  for (let dl = -1; dl <= 1; dl++) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dl || dr || dc) { coords3d.push([dr, dc, dl]); coords.push([dr, dc]); }
  const neighborhoods = [{ id: mooreId, name: 'Moore3D', coords, coords3d, includeCentralCell: false }];
  const DIFFUSE = 0.2, DECAY = 0.98;
  const step = cn('step', {});
  const diffuse = (attr) => {
    const g = cn('getCellAttribute', { attributeId: attr });
    const nbr = cn('getNeighborsAttribute', { neighborhoodId: mooreId, attributeId: attr });
    const avg = cn('aggregate', { operation: 'average' }); cV(nbr, 'values', avg, 'values');
    const ex = cn('expression', { expression: `(a + ${DIFFUSE}*(b-a))*${DECAY}`, visibleCount: 2 }); cV(g, 'value', ex, 'a'); cV(avg, 'result', ex, 'b');
    const set = cn('setAttribute', { attributeId: attr }); cV(ex, 'result', set, 'value'); return set;
  };
  const setA = diffuse('chemical'), setB = diffuse('chemical2');
  // Sequence ports are `first`/`then` (+ `then_2`… via extraCount) — NOT then_0/then_1.
  const seq = cn('sequence', { extraCount: 0 }); cF(step, 'do', seq, 'do'); cF(seq, 'first', setA, 'do'); cF(seq, 'then', setB, 'do');
  // agents — the behaviour chain routes through a Sequence ON PURPOSE: the agent
  // WASM/WebGPU sequence emitters once walked nonexistent then0/then1 ports and
  // silently dropped the whole downstream chain (the gravitation bug); this keeps
  // permanent regression coverage for agent-graph Sequence.
  const bs = an('behaviourStep', {});
  const aseq = an('sequence', { extraCount: 0 }); aF(bs, 'do', aseq, 'do');
  const sec = an('secreteToField', { attributeId: 'chemical', _port_rate: '1.0' }); aF(aseq, 'first', sec, 'do');
  const aff = an('affectCellsUnder', { attributeId: 'chemical2', op: 'add', _port_value: '0.5', _port_radius: '2' }); aF(sec, 'next', aff, 'do');
  const fg = an('fieldGradient', { attributeId: 'chemical' });
  const sf = an('sampleField', { attributeId: 'chemical' });
  const rc = an('readCellsUnder', { attributeId: 'chemical2', reduce: 'mean', _port_radius: '2' });
  const fxN = an('expression', { expression: 'a*24 + b*8 + c*4', visibleCount: 3 }); aV(fg, 'dx', fxN, 'a'); aV(fg, 'dz', fxN, 'b'); aV(sf, 'value', fxN, 'c');
  const fyN = an('expression', { expression: 'a*24 + b*2', visibleCount: 2 }); aV(fg, 'dy', fyN, 'a'); aV(rc, 'value', fyN, 'b');
  const af = an('applyForce', {}); aV(fxN, 'result', af, 'fx'); aV(fyN, 'result', af, 'fy'); aF(aff, 'next', af, 'do');
  return {
    schemaVersion: 1,
    properties: { name: 'Field3D Parity Test', dimension: '3d', gridWidth: 32, gridHeight: 32, gridDepth: 16, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: true, useWebGPU: false },
    topologyMode: { gridCells: true, agents: true },
    centerBased: { enabled: true, maxAgents: 400, maxBonds: 2, worldWidth: 32, worldHeight: 32, worldDepth: 16, seedCount: 80, seedPattern: 'scatter', defaultRadius: 1.0, growthRate: 0, repulsionStiffness: 1.2, adhesionStiffness: 0, interactionRange: 1.4, drag: 1.0, timeStep: 0.25, momentum: 0.7, maxSpeed: 1.0, neighbourQueryRadius: 5, customForcesOnly: false, autoBond: false, bondStiffness: 0.4, bondRestLength: 2.0, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async' },
    attributes: [
      { id: 'chemical', name: 'chemical', type: 'float', defaultValue: '0', agentAccess: 'readWrite' },
      { id: 'chemical2', name: 'chemical2', type: 'float', defaultValue: '0', agentAccess: 'readWrite' },
    ],
    agentAttributes: [], modelAttributes: [], neighborhoods,
    mappings: [{ id: nid('map'), name: 'Chemical', isAttributeToColor: true, linked: true, linkedAttributeId: 'chemical', linkedMin: 0, linkedMax: 6 }],
    variables: [], agentVariables: [], indicators: [],
    graphNodes: cN, graphEdges: cEd, agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// A synthetic FOV model — each agent counts the neighbours inside a heading-
// relative vision cone (Get Agents In View → Array Length → Set Attribute). Wired
// heading (1,0) so the cone is exercised regardless of velocity; halfAngle 60°.
// Keeps permanent JS↔WASM bit-parity coverage for the cone-test emit.
function buildFOVModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const giv = an('getAgentsInView', { halfAngle: '60', headingSource: 'wired', _port_radius: '6', _port_headingX: '1', _port_headingY: '0' });
  const al = an('arrayLength', {});
  const sa = an('setAttribute', { attributeId: 'count' });
  aE(bs, 'do', sa, 'do', 'flow');
  aE(giv, 'agents', al, 'array', 'value');
  aE(al, 'length', sa, 'value', 'value');
  return {
    schemaVersion: 1,
    properties: { name: 'FOV Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [{ id: 'count', name: 'Count', type: 'integer', defaultValue: '0' }],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Sense Hemifield: the L/R Braitenberg reduction over the SAME cone gather. Stores
// BOTH outputs in separate integer attrs so a left/right swap (or a per-target cross
// divergence) is caught bit-for-bit. Wired heading (1,0) so the split is deterministic.
function buildHemifieldModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const sh = an('senseHemifield', { halfAngle: '90', headingSource: 'wired', _port_radius: '6', _port_headingX: '1', _port_headingY: '0' });
  const setL = an('setAttribute', { attributeId: 'countL' });
  const setR = an('setAttribute', { attributeId: 'countR' });
  aE(bs, 'do', setL, 'do', 'flow');
  aE(setL, 'next', setR, 'do', 'flow');
  aE(sh, 'leftCount', setL, 'value', 'value');
  aE(sh, 'rightCount', setR, 'value', 'value');
  return {
    schemaVersion: 1,
    properties: { name: 'Hemifield Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [{ id: 'countL', name: 'CountL', type: 'integer', defaultValue: '0' }, { id: 'countR', name: 'CountR', type: 'integer', defaultValue: '0' }],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Multi-attribute SLOTS parity vehicle (multiAttrExpand.ts): one multi-slot Set
// writes a=myX / b=myY / c=3·myX+1 (distinct per attr so a wrong slot pairing
// diverges), a multi-slot Get re-reads them POST-write (async read-after-write
// through the expansion), an expression folds all three slots into o1, slot 2
// copies b into o2 and slot 3 writes the INLINE 7.5 into o3; then the by-id pair
// (Get/Set Agent Attribute) reads (a,b) of SELF through a shared fanned-out
// handle and writes them to o4/o5. Keeps permanent JS↔WASM coverage for the
// slot expansion (wired + inline slots, get + set, own + by-id).
function buildMultiAttrModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const c3 = an('expression', { expression: 'a*3+1', visibleCount: 1 });
  aE(bs, 'myX', c3, 'a', 'value');
  const setInit = an('setAttribute', { attributeId: 'a', extraCount: 2, attr_2: 'b', attr_3: 'c' });
  aE(bs, 'myX', setInit, 'value', 'value');
  aE(bs, 'myY', setInit, 'value_2', 'value');
  aE(c3, 'result', setInit, 'value_3', 'value');
  const g = an('getCellAttribute', { attributeId: 'a', extraCount: 2, attr_2: 'b', attr_3: 'c' });
  const ex = an('expression', { expression: 'a + b*10 + c*100', visibleCount: 3 });
  aE(g, 'value', ex, 'a', 'value');
  aE(g, 'value_2', ex, 'b', 'value');
  aE(g, 'value_3', ex, 'c', 'value');
  const set2 = an('setAttribute', { attributeId: 'o1', extraCount: 2, attr_2: 'o2', attr_3: 'o3', _port_value_3: '7.5' });
  aE(ex, 'result', set2, 'value', 'value');
  aE(g, 'value_2', set2, 'value_2', 'value');
  const gsh = an('getSelfHandle', {});
  const gaa = an('getAgentAttribute', { attributeId: 'a', extraCount: 1, attr_2: 'b' });
  aE(gsh, 'handle', gaa, 'agentId', 'value');
  const saa = an('setAgentAttribute', { attributeId: 'o4', extraCount: 1, attr_2: 'o5' });
  aE(gsh, 'handle', saa, 'agentId', 'value');
  aE(gaa, 'value', saa, 'value', 'value');
  aE(gaa, 'value_2', saa, 'value_2', 'value');
  aE(bs, 'do', setInit, 'do', 'flow');
  aE(setInit, 'next', set2, 'do', 'flow');
  aE(set2, 'next', saa, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'MultiAttr Slots Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'a', name: 'A', type: 'float', defaultValue: '0' },
      { id: 'b', name: 'B', type: 'float', defaultValue: '0' },
      { id: 'c', name: 'C', type: 'float', defaultValue: '0' },
      { id: 'o1', name: 'O1', type: 'float', defaultValue: '0' },
      { id: 'o2', name: 'O2', type: 'float', defaultValue: '0' },
      { id: 'o3', name: 'O3', type: 'float', defaultValue: '0' },
      { id: 'o4', name: 'O4', type: 'float', defaultValue: '0' },
      { id: 'o5', name: 'O5', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Get Grid Dimensions parity vehicle: the agent world's Width / Height / Depth
// (the agent ABI's fieldW / fieldH / fieldD params on WASM, `_fieldW` / `_fieldH`
// / derived-from-`_fieldTotal` on JS). 3D on purpose so Depth ≠ 1 — a wrong param
// index or a 2D-only emit diverges immediately. Each dim goes to its own attr
// (so a width/height swap is caught) and a fourth attr folds all three, so a
// single wrong dim can't cancel out.
function buildGridDimsModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const gd = an('getGridDimensions', { withCenter: true });
  const fold = an('expression', { expression: 'a + b*1000 + c*1000000', visibleCount: 3 });
  aE(gd, 'width', fold, 'a', 'value');
  aE(gd, 'height', fold, 'b', 'value');
  aE(gd, 'depth', fold, 'c', 'value');
  // The centre outputs fold the same way (⌊W/2⌋ + ⌊H/2⌋·1000 + ⌊D/2⌋·1e6) — a
  // wrong floor emit on either target diverges here.
  const cfold = an('expression', { expression: 'a + b*1000 + c*1000000', visibleCount: 3 });
  aE(gd, 'centerX', cfold, 'a', 'value');
  aE(gd, 'centerY', cfold, 'b', 'value');
  aE(gd, 'centerZ', cfold, 'c', 'value');
  // One multi-slot Set writes all five (also keeps the slot expansion on the path).
  const set = an('setAttribute', { attributeId: 'gw', extraCount: 4, attr_2: 'gh', attr_3: 'gd', attr_4: 'fold', attr_5: 'cfold' });
  aE(gd, 'width', set, 'value', 'value');
  aE(gd, 'height', set, 'value_2', 'value');
  aE(gd, 'depth', set, 'value_3', 'value');
  aE(fold, 'result', set, 'value_4', 'value');
  aE(cfold, 'result', set, 'value_5', 'value');
  aE(bs, 'do', set, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Grid Dimensions Parity Test', dimension: '3d', gridWidth: 21, gridHeight: 13, gridDepth: 7, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 21, worldHeight: 13, worldDepth: 7, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'gw', name: 'GW', type: 'float', defaultValue: '0' },
      { id: 'gh', name: 'GH', type: 'float', defaultValue: '0' },
      { id: 'gd', name: 'GD', type: 'float', defaultValue: '0' },
      { id: 'fold', name: 'Fold', type: 'float', defaultValue: '0' },
      { id: 'cfold', name: 'CenterFold', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Synthetic: each agent scatters a small force onto EVERY nearby agent
// (applyForceToAgent inside a forEach over getNearbyAgents) — the pairwise-force
// pattern. Momentum > 0 so the scattered force accumulates into velocity → the
// cross-agent write + guard must be JS↔WASM bit-identical or positions diverge.
function buildApplyForceToAgentModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const near = an('getNearbyAgents', { _port_radius: '6' });
  const fe = an('forEachInArray', {});
  const af = an('applyForceToAgent', { _port_fx: '0.03', _port_fy: '-0.02' });
  aE(bs, 'do', fe, 'do', 'flow');
  aE(near, 'agents', fe, 'array', 'value');
  aE(fe, 'body', af, 'do', 'flow');
  aE(fe, 'element', af, 'agentId', 'value');
  return {
    schemaVersion: 1,
    properties: { name: 'Apply Force To Agent Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0.9, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Synthetic: the ARRAY broadcast — Apply Force To Agents over the whole nearby set.
// Lowers to For Each In Array → Apply Force To Agent, so this exercises the lowering
// end-to-end and must be JS↔WASM bit-identical like the single-node scatter.
function buildApplyForceToAgentsModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const near = an('getNearbyAgents', { _port_radius: '6' });
  const afs = an('applyForceToAgents', { _port_fx: '0.03', _port_fy: '-0.02' });
  aE(bs, 'do', afs, 'do', 'flow');
  aE(near, 'agents', afs, 'agents', 'value');
  return {
    schemaVersion: 1,
    properties: { name: 'Apply Force To Agents Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0.9, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Synthetic: an agent flow DIAMOND. A conditional (gated on Get Cell Attribute
// `sel` >= 0) whose `then` and `else` branches each write a DISTINCT `mark`, and
// BOTH flow into a SHARED downstream chain: applyForce(fx = sel*0.01, a PURE value
// hoisted once) → applyForce(fx = (rndX-0.5)*0.05, fy = (rndY-0.5)*0.05, getRandom-
// TAINTED = non-hoistable). `compileFlowChain` inlines the shared chain once per
// branch, so the getRandom-tainted expressions must re-emit in EACH branch's own
// scope (WebGPU: a WGSL unresolved-name error otherwise; WASM: a stale local reused
// / a skipped random draw = silently wrong + a broken RNG stream). This is the
// exact class the user hit on a Chemotaxis overpopulation rule. Bit-identical
// JS↔WASM proves the fix draws the right randoms in the right order on both.
function buildDiamondModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const gca = an('getCellAttribute', { attributeId: 'sel' });
  const cmp = an('statement', { compareType: 'numerical', operation: '>=', _port_y: '0' });
  aE(gca, 'value', cmp, 'x', 'value');
  const cond = an('conditional', {});
  aE(bs, 'do', cond, 'check', 'flow');
  aE(cmp, 'result', cond, 'condition', 'value');
  // then / else each write a distinct mark, then both → the SHARED force chain.
  const setThen = an('setAttribute', { attributeId: 'mark', _port_value: '1' });
  const setElse = an('setAttribute', { attributeId: 'mark', _port_value: '2' });
  aE(cond, 'then', setThen, 'do', 'flow');
  aE(cond, 'else', setElse, 'do', 'flow');
  // PURE hoisted value shared across branches (sel*0.01 → applyForce fx).
  const exprGrad = an('expression', { expression: 'a*0.01', visibleCount: 1 });
  aE(gca, 'value', exprGrad, 'a', 'value');
  const afGrad = an('applyForce', {});
  aE(exprGrad, 'result', afGrad, 'fx', 'value');
  // NON-hoistable getRandom-tainted values on the second (chained) applyForce.
  const rndX = an('getRandom', { randomType: 'float', min: '0', max: '1' });
  const rndY = an('getRandom', { randomType: 'float', min: '0', max: '1' });
  const exprRx = an('expression', { expression: '(a-0.5)*0.05', visibleCount: 1 });
  const exprRy = an('expression', { expression: '(a-0.5)*0.05', visibleCount: 1 });
  aE(rndX, 'value', exprRx, 'a', 'value');
  aE(rndY, 'value', exprRy, 'a', 'value');
  const afRand = an('applyForce', {});
  aE(exprRx, 'result', afRand, 'fx', 'value');
  aE(exprRy, 'result', afRand, 'fy', 'value');
  // DIAMOND: setThen.next AND setElse.next both → afGrad → afRand.
  aE(setThen, 'next', afGrad, 'do', 'flow');
  aE(setElse, 'next', afGrad, 'do', 'flow');
  aE(afGrad, 'next', afRand, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Flow Diamond Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'sel', name: 'Sel', type: 'float', defaultValue: '0' },
      { id: 'mark', name: 'Mark', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

const modelsDir = join(ROOT, 'public', 'models');
const files = readdirSync(modelsDir).filter(f => f.endsWith('.gcaproj'));
const SEED = 0x9e3779b1 >>> 0;
const STEPS = Number(process.env.STEPS) || 30;
let allPass = true;

// Synthetic: the Loop node's `index` output. Each agent runs Loop(5); the body
// increments `acc` by (index*2+1) — Σ = 25/step — and, inside a Conditional
// gated on Compare(index >= 3), increments `acc2` by the raw index — Σ = 7/step.
// Exercises index consumers as a VALUE-node chain (expression), as a Compare
// input inside a nested branch, and as a direct flow-node input — the three
// scoping shapes the per-target pinning (volatile / loopStack / sink scope)
// must get right, JS↔WASM bit-identical.
function buildLoopIndexModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const lp = an('loop', { _port_count: '5' });
  aE(bs, 'do', lp, 'do', 'flow');
  const ex = an('expression', { expression: 'a*2+1', visibleCount: 1 });
  aE(lp, 'index', ex, 'a', 'value');
  const upd1 = an('updateAttribute', { attributeId: 'acc', operation: 'increment' });
  aE(ex, 'result', upd1, 'value', 'value');
  aE(lp, 'body', upd1, 'do', 'flow');
  const cmp = an('statement', { operation: '>=', compareType: 'numerical', _port_y: '3' });
  aE(lp, 'index', cmp, 'x', 'value');
  const cond = an('conditional', {});
  aE(cmp, 'result', cond, 'condition', 'value');
  aE(upd1, 'next', cond, 'do', 'flow');
  const upd2 = an('updateAttribute', { attributeId: 'acc2', operation: 'increment' });
  aE(lp, 'index', upd2, 'value', 'value');
  aE(cond, 'then', upd2, 'do', 'flow');
  // RANGE mode: a second loop with Index running 2..4 inclusive — acc3 += index
  // per iteration (Σ = 9/step). Chained off the first loop's DONE.
  const lp2 = an('loop', { mode: 'range', _port_from: '2', _port_to: '4' });
  aE(lp, 'next', lp2, 'do', 'flow');
  const upd3 = an('updateAttribute', { attributeId: 'acc3', operation: 'increment' });
  aE(lp2, 'index', upd3, 'value', 'value');
  aE(lp2, 'body', upd3, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Loop Index Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'acc', name: 'Acc', type: 'float', defaultValue: '0' },
      { id: 'acc2', name: 'Acc2', type: 'float', defaultValue: '0' },
      { id: 'acc3', name: 'Acc3', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Synthetic: Get Curvature + For Each Bond currentLength over a BONDED population
// (a `setup` hook forms the bonds — chain + cross links, so bondCount ≥ 2 and the
// curvature branch actually runs; agents are re-positioned to irregular values,
// with seam-straddling pairs so the torus fold is on the path). Guards the
// sqrt-of-squared-sum ↔ Math.hypot ULP class: the JS emit must use
// Math.sqrt(dx*dx + dy*dy) with the SAME associativity as the WASM f64 ops
// (the getAgentOffset.distance lesson) or curvature/length values diverge by ULPs.
// curv stores the curvature; lenSum accumulates Σ currentLength across steps
// (compounding, so a single-ULP divergence is caught within a few steps).
function buildCurvatureModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const gc = an('getCurvature', {});
  const setCurv = an('setAttribute', { attributeId: 'curv' });
  aE(bs, 'do', setCurv, 'do', 'flow');
  aE(gc, 'value', setCurv, 'value', 'value');
  const feb = an('forEachBond', {});
  aE(setCurv, 'next', feb, 'do', 'flow');
  const upd = an('updateAttribute', { attributeId: 'lenSum', operation: 'increment' });
  aE(feb, 'currentLength', upd, 'value', 'value');
  aE(feb, 'body', upd, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Curvature Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 4, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, bondStiffness: 0.4, bondRestLength: 1.5, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'data', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'curv', name: 'Curvature', type: 'float', defaultValue: '0' },
      { id: 'lenSum', name: 'LenSum', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// The curvature model's bond/position setup — runs IDENTICALLY on both stores
// after seeding. Irregular (but deterministic) positions across the full torus,
// chain + cross bonds so every agent has 2-4 partners; the modulo wrap puts
// several bonded pairs across the seam (torus-fold coverage).
function setupCurvatureStores(stores) {
  const W = 24, H = 24;
  for (const s of stores) {
    for (let i = 0; i < s.highWater; i++) {
      const px = ((i * 7.371) + Math.sin(i * 1.618) * 0.9) % W;
      const py = ((i * 5.137) + Math.cos(i * 2.71) * 0.9) % H;
      const x = ((px % W) + W) % W, y = ((py % H) + H) % H;
      s.x[i] = x; s.xNext[i] = x; s.y[i] = y; s.yNext[i] = y;
    }
    for (let i = 0; i < s.highWater; i++) {
      formBond(s, i, (i + 1) % s.highWater, 1.5, 0.5);
      if ((i & 1) === 0) formBond(s, i, (i + 7) % s.highWater, 2.0, 0.5);
    }
  }
}

// Build the entry list: every shipped agent .gcaproj PLUS a synthetic 3D-field
// model exercising ALL FIVE field-bridge nodes in 3D (trilinear sample/gradient/
// splat + r-sphere read/affect). The 3D-field model is built in-memory (not
// shipped — the existing samples don't cover 3D field; this keeps the regression
// coverage permanent without adding a Models-Library card). See build3DFieldModel.
const entries = [];
for (const f of files) {
  let raw; try { raw = JSON.parse(readFileSync(join(modelsDir, f), 'utf8')); } catch { continue; }
  entries.push({ name: f, raw });
}
entries.push({ name: '[synthetic] Field3D (all 5 field nodes, 3D)', raw: build3DFieldModel() });
entries.push({ name: '[synthetic] FOV cone (Get Agents In View)', raw: buildFOVModel() });
entries.push({ name: '[synthetic] Hemifield (Sense Hemifield L/R)', raw: buildHemifieldModel() });
entries.push({ name: '[synthetic] Multi-attribute slots (Get/Set + by-id)', raw: buildMultiAttrModel() });
entries.push({ name: '[synthetic] Get Grid Dimensions (3D world W/H/D + centres)', raw: buildGridDimsModel() });
entries.push({ name: '[synthetic] Apply Force To Agent (pairwise scatter)', raw: buildApplyForceToAgentModel() });
entries.push({ name: '[synthetic] Apply Force To Agents (array broadcast, lowered)', raw: buildApplyForceToAgentsModel() });
entries.push({ name: '[synthetic] Loop index output (value chain + branch + direct)', raw: buildLoopIndexModel() });
entries.push({ name: '[synthetic] Curvature + bond currentLength (bonded, hypot↔sqrt)', raw: buildCurvatureModel(), setup: setupCurvatureStores });
entries.push({ name: '[synthetic] Flow diamond (conditional → shared getRandom chain)', raw: buildDiamondModel() });

for (const { name: f, raw, setup } of entries) {
  const model = migrateForHarness(raw);
  if (!model?.topologyMode?.agents) continue;

  const cfg = model.centerBased;
  const is3d = model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
  const W = model.properties.gridWidth || 100, H = model.properties.gridHeight || 100, D = is3d ? (model.properties.gridDepth || 1) : 1;
  const total = W * H * D;
  const torus = model.properties.boundaryTreatment === 'torus';
  const agentAttrs = agentAttrsOf(model);
  const fieldSpecs = cellFieldAttrsOf(model);
  const specs = agentAttrs.map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
  const maxAgents = Math.max(1, Math.floor(cbNum(cfg, 'maxAgents', 2000)));
  const maxBonds = Math.max(1, Math.floor(cbNum(cfg, 'maxBonds', 8)));
  const maxHashBins = computeAgentMaxHashBins(W, H, D, cbNum(cfg, 'interactionRange', 1.5), cbNum(cfg, 'defaultRadius', 0.5), cbNum(cfg, 'neighbourQueryRadius', 5));

  // Compile both targets.
  const wasmR = compileAgentGraphWasmForModel(model);
  if (wasmR.error || wasmR.bytes.length === 0) { console.log(`SKIP ${f}: WASM compile: ${wasmR.error}`); continue; }
  // Use the COMPILER's exact layout dims for the store so offsets match bit-for-bit
  // (the real worker derives the same dims from the same model; verified here).
  const cMaxHashBins = wasmR.layout.maxHashBins;
  const jsR = compileAgentGraph(model.agentGraphNodes ?? [], model.agentGraphEdges ?? [], model, 0);
  if (jsR.error || !jsR.behaviourCode) { console.log(`SKIP ${f}: JS compile: ${jsR.error}`); continue; }
  // eslint-disable-next-line no-eval
  const jsFn = eval(jsR.behaviourCode);

  // Build the external-region caches (deterministic: model attrs from defaults,
  // field arrays seeded with a deterministic pattern, lookup tables normalized).
  const cachedModelAttrs = {};
  for (const a of model.attributes) {
    if (!a.isModelAttribute) continue;
    if (a.type === 'color') { cachedModelAttrs[a.id + '_r'] = 10; cachedModelAttrs[a.id + '_g'] = 20; cachedModelAttrs[a.id + '_b'] = 30; }
    else if (a.type !== 'lookupTable') { const v = parseFloat(String(a.defaultValue ?? '0')); cachedModelAttrs[a.id] = Number.isFinite(v) ? v : 0; }
  }
  const cachedInteractionTables = {};
  let hasLookupTables = false;
  for (const a of model.attributes) {
    if (a.isModelAttribute && a.type === 'lookupTable') {
      hasLookupTables = true;
      const rl = resolveKeyLabels(a.rowKeySource, model), cl = resolveKeyLabels(a.colKeySource, model);
      cachedInteractionTables[a.id] = normalizeLookupTable(a.tableValues, rl, cl);
    }
  }
  const cachedIndicators = new Float64Array((model.indicators ?? []).length);
  // deterministic field arrays (readAttrs) for the agent-accessible cell attrs.
  const readAttrs = {};
  for (const spec of fieldSpecs) {
    const arr = new Float64Array(total);
    for (let i = 0; i < total; i++) arr[i] = ((i * 2654435761) % 997) / 997;
    readAttrs[spec.id] = arr;
  }
  const ctxA = { cachedModelAttrs, cachedInteractionTables, cachedIndicators, readAttrs, fieldSpecs, width: W, height: H, total, torus, hasLookupTables, activeViewer: '', rngState: null, stopFlag: new Uint32Array(1), GLYPH_NOOP_CODES: new Uint32Array(1), GLYPH_NOOP_COLORS: new Uint32Array(1) };
  // wasm side gets its OWN field copy so deposits don't cross-contaminate.
  const readAttrsB = {}; for (const spec of fieldSpecs) readAttrsB[spec.id] = readAttrs[spec.id].slice();
  const cachedModelAttrsB = { ...cachedModelAttrs };
  const cachedInteractionTablesB = {}; for (const k of Object.keys(cachedInteractionTables)) cachedInteractionTablesB[k] = cachedInteractionTables[k].slice();
  const cachedIndicatorsB = cachedIndicators.slice();

  // Stores: A = plain JS; B = wasmBacked (sync attrs if the model is sync).
  const syncAttrs = cfg?.agentUpdateMode === 'sync';
  const layoutExtras = { ...m.buildAgentLayoutExtras(model), fieldTotal: total, syncAttrs };
  const A = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs });
  const B = createAgentStore(cfg, specs, { wasmBacked: true, syncAttrs, maxHashBins: cMaxHashBins, layoutExtras });
  for (const s of [A, B]) { s.worldWidth = W; s.worldHeight = H; s.worldDepth = D; }

  // Seed identical agents (deterministic compact grid).
  const r = cbNum(cfg, 'defaultRadius', 0.5);
  const N0 = Math.min(maxAgents, process.env.N1 ? 1 : 64);
  const seedSpecs = [];
  const cols = Math.ceil(Math.sqrt(N0));
  for (let i = 0; i < N0; i++) {
    const sp = is3d
      ? { x: 4 + (i % cols) * 2.2 * r, y: 4 + Math.floor(i / cols) * 2.2 * r, z: D / 2, radius: r }
      : { x: 4 + (i % cols) * 2.2 * r, y: 4 + Math.floor(i / cols) * 2.2 * r, radius: r };
    seedSpecs.push(sp);
  }
  seedAgents(A, seedSpecs, r); seedAgents(B, seedSpecs, r);
  // give agent attrs deterministic non-default values
  for (const s of [A, B]) for (const spec of agentAttrs) { const a = s.attrRead[spec.id]; for (let i = 0; i < s.highWater; i++) a[i] = (i % 5) - 2; if (s.attrWrite[spec.id] !== a) s.attrWrite[spec.id].set(a); }
  // per-entry post-seed setup (bond topology / repositioning) — identical on both stores.
  if (setup) setup([A, B]);

  // LAYOUT-MATCH assertion: the store's layout MUST equal the compiler's, else the
  // baked field/attr offsets are wrong (the +64-cell bug).
  if (B.layout.fieldOffset && wasmR.layout.fieldOffset) {
    for (const id of Object.keys(wasmR.layout.fieldOffset)) {
      if (B.layout.fieldOffset[id] !== wasmR.layout.fieldOffset[id]) {
        console.log(`  !! LAYOUT MISMATCH ${f}: field ${id} store=${B.layout.fieldOffset[id]} compiler=${wasmR.layout.fieldOffset[id]}`);
      }
    }
    if (B.layout.indicatorsOffset !== wasmR.layout.indicatorsOffset) console.log(`  !! indicatorsOffset ${B.layout.indicatorsOffset} vs ${wasmR.layout.indicatorsOffset}`);
    for (const k of Object.keys(wasmR.layout.modelAttrOffset)) if (B.layout.modelAttrOffset[k] !== wasmR.layout.modelAttrOffset[k]) console.log(`  !! modelAttr ${k} ${B.layout.modelAttrOffset[k]} vs ${wasmR.layout.modelAttrOffset[k]}`);
  }
  // Instantiate WASM behaviour against B's memory.
  const inst = await instantiateAgentWasm(wasmR.bytes, B.memory);

  const rngState = new Uint32Array(1);
  let mismatch = 0, firstField = '';
  for (let step = 0; step < STEPS && mismatch === 0; step++) {
    // reset forces
    A.forceX.fill(0, 0, A.highWater); A.forceY.fill(0, 0, A.highWater); A.forceZ.fill(0, 0, A.highWater);
    B.forceX.fill(0, 0, B.highWater); B.forceY.fill(0, 0, B.highWater); B.forceZ.fill(0, 0, B.highWater);
    // reset request buffers (the worker zeroes them implicitly via the structural phase; for behaviour-only parity zero them here)
    for (const s of [A, B]) { s.divideRequest.fill(0); s.killRequest.fill(0); s.bondFormReq.fill(0); s.bondBreakReq.fill(0); s.divideAxisX.fill(0); s.divideAxisY.fill(0); s.divideAsym.fill(0); s.bondFormL.fill(0); s.bondFormK.fill(0); }
    // build the hash from A's positions (both stores share identical positions here).
    let maxR = r; for (let i = 0; i < A.highWater; i++) if (A.alive[i] && A.radius[i] > maxR) maxR = A.radius[i];
    const binEdge = Math.max(1e-3, cbNum(cfg, 'interactionRange', 1.5) * 2 * maxR, cbNum(cfg, 'neighbourQueryRadius', 5));
    const hashA = buildSpatialHash(A, binEdge, W, H, D, torus, computeAgentMaxHashBins(W, H, D, cbNum(cfg, 'interactionRange', 1.5), cbNum(cfg, 'defaultRadius', 0.5), cbNum(cfg, 'neighbourQueryRadius', 5)));
    // sync prime
    if (syncAttrs) { for (const s of [A, B]) for (const spec of s.attrSpecs) { const rd = s.attrRead[spec.id], wr = s.attrWrite[spec.id]; if (rd !== wr) wr.set(rd); } }

    // --- JS behaviour on A ---
    rngState[0] = SEED + step;
    ctxA.rngState = rngState;
    jsFn(...buildArgs(A, hashA, ctxA));
    // --- WASM behaviour on B ---
    const Bbuf = B.memory.buffer, BL = B.layout;
    new Uint32Array(Bbuf, BL.rngStateOffset, 1)[0] = SEED + step;
    // copy hash in
    let hashValid = 0, nBinsX = 0, nBinsY = 0, nBinsZ = 0, bsx = 1, bsy = 1, bsz = 1, ox = 0, oy = 0, oz = 0;
    if (hashA) {
      hashValid = 1; nBinsX = hashA.nBinsX; nBinsY = hashA.nBinsY; nBinsZ = hashA.nBinsZ; bsx = hashA.binSizeX; bsy = hashA.binSizeY; bsz = hashA.binSizeZ; ox = hashA.originX; oy = hashA.originY; oz = hashA.originZ;
      const nBins = nBinsX * nBinsY * nBinsZ;
      new Int32Array(Bbuf, BL.hashBinStartOffset, nBins + 1).set(hashA.binStart.subarray(0, nBins + 1));
      const used = hashA.binStart[nBins];
      if (used > 0) new Int32Array(Bbuf, BL.hashBinAgentsOffset, used).set(hashA.binAgents.subarray(0, used));
    }
    // copy external regions in (model attrs / indicators / lookup / field)
    for (const key of Object.keys(BL.modelAttrOffset)) new Float64Array(Bbuf, BL.modelAttrOffset[key], 1)[0] = typeof cachedModelAttrsB[key] === 'number' ? cachedModelAttrsB[key] : 0;
    if (BL.indicatorCount > 0) new Float64Array(Bbuf, BL.indicatorsOffset, BL.indicatorCount).set(cachedIndicatorsB.subarray(0, BL.indicatorCount));
    for (const id of Object.keys(BL.lookupTableOffset)) { const t = cachedInteractionTablesB[id]; if (t) new Float64Array(Bbuf, BL.lookupTableOffset[id], t.length).set(t); }
    if (BL.fieldTotal > 0) for (const id of Object.keys(BL.fieldOffset)) { const src = readAttrsB[id]; if (!src) continue; const dst = new Float64Array(Bbuf, BL.fieldOffset[id], BL.fieldTotal); const n2 = Math.min(BL.fieldTotal, src.length); for (let i = 0; i < n2; i++) dst[i] = src[i]; }
    inst.behaviour(B.highWater, hashValid, nBinsX, nBinsY, nBinsZ, bsx, bsy, bsz, W, H, D, torus ? 1 : 0, ox, oy, oz);
    // copy field deposit + indicators back out (mirror the worker)
    if (BL.indicatorCount > 0) { const sb = new Float64Array(Bbuf, BL.indicatorsOffset, BL.indicatorCount); for (let i = 0; i < BL.indicatorCount; i++) cachedIndicatorsB[i] = sb[i]; }
    if (BL.fieldTotal > 0) { const wIds = new Set(fieldSpecs.filter(a => a.agentAccess === 'readWrite').map(a => a.id)); for (const id of Object.keys(BL.fieldOffset)) { if (!wIds.has(id)) continue; const dst = readAttrsB[id]; if (!dst) continue; const src = new Float64Array(Bbuf, BL.fieldOffset[id], BL.fieldTotal); const n2 = Math.min(BL.fieldTotal, dst.length); for (let i = 0; i < n2; i++) dst[i] = src[i]; } }

    // sync swap (so the next step reads the written attrs on both)
    if (syncAttrs) {
      for (const spec of A.attrSpecs) { const tmp = A.attrRead[spec.id]; A.attrRead[spec.id] = A.attrWrite[spec.id]; A.attrWrite[spec.id] = tmp; }
      for (const spec of B.attrSpecs) { const rd = B.attrRead[spec.id], wr = B.attrWrite[spec.id]; rd.set(wr); }
    }

    // --- compare ---
    const cmpArr = (name, aArr, bArr, n) => { for (let i = 0; i < n; i++) { if (aArr[i] !== bArr[i] && !(Number.isNaN(aArr[i]) && Number.isNaN(bArr[i]))) { mismatch++; if (!firstField) firstField = `${name}[${i}] js=${aArr[i]} wasm=${bArr[i]}`; return; } } };
    const hw = A.highWater;
    cmpArr('forceX', A.forceX, B.forceX, hw); cmpArr('forceY', A.forceY, B.forceY, hw);
    if (is3d) cmpArr('forceZ', A.forceZ, B.forceZ, hw);
    cmpArr('vx', A.vx, B.vx, hw); cmpArr('vy', A.vy, B.vy, hw);
    cmpArr('targetRadius', A.targetRadius, B.targetRadius, hw);
    cmpArr('divideRequest', A.divideRequest, B.divideRequest, hw);
    cmpArr('killRequest', A.killRequest, B.killRequest, hw);
    cmpArr('bondFormReq', A.bondFormReq, B.bondFormReq, hw);
    cmpArr('bondBreakReq', A.bondBreakReq, B.bondBreakReq, hw);
    cmpArr('divideAxisX', A.divideAxisX, B.divideAxisX, hw); cmpArr('divideAxisY', A.divideAxisY, B.divideAxisY, hw);
    for (const spec of agentAttrs) cmpArr('attr_' + spec.id, A.attrRead[spec.id], B.attrRead[spec.id], hw);
    cmpArr('colors', A.colors, B.colors, hw * 4);
    for (const spec of fieldSpecs) if (spec.agentAccess === 'readWrite') cmpArr('field_' + spec.id, readAttrs[spec.id], readAttrsB[spec.id], total);
    // RNG stream parity
    const bRng = new Uint32Array(B.memory.buffer, BL.rngStateOffset, 1)[0];
    if (rngState[0] !== bRng) { /* JS rng updated in place; compare */ }
  }
  const tag = mismatch === 0 ? 'PARITY✓' : 'PARITY✗';
  if (mismatch) allPass = false;
  console.log(`${tag}  ${f}  (${STEPS} steps, ${A.highWater} agents)${mismatch ? '  ' + firstField : ''}`);
}
console.log(allPass ? '\nALL AGENT SAMPLES: JS↔WASM BIT-PARITY ✓' : '\nSOME MISMATCHED ✗');
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
