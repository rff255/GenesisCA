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
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, formBond, breakBond } from '../src/simulator/engine/agentEngine.ts';
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
  createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, formBond, breakBond,
  compileAgentGraphWasmForModel, instantiateAgentWasm,
  compileAgentGraph, buildAgentAbiArgs, migrateForHarness, agentAttrsOf, cellFieldAttrsOf,
  resolveKeyLabels, normalizeLookupTable,
} = m;

const cbNum = (cfg, k, d) => { const v = cfg?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };

// STEP 0: the harness is now a CONSUMER of the shared ABI descriptor (agentAbi.ts)
// — the SAME `buildAgentAbiArgs` the worker uses — instead of a 4th hand-copy that
// could silently desync. So this parity run also verifies the descriptor-derived
// loop args (the worker's `buildAgentLoopArgs` routes through the same function).
/** Encode an attribute's declared string default to the number its region stores
 *  (the harness analogue of `encodeAttrValue`; bond attrs are bool/int/float/tag). */
function encodeAttr(a) {
  const v = a.defaultValue ?? '';
  if (a.type === 'bool') return v === 'true' || v === '1' ? 1 : 0;
  if (a.type === 'float') { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0;
}

function buildArgs(s, hash, ctx) {
  // P2: `bondAttrs` mirrors the worker's `agentAbiShapeOfStore` — the store's OWN
  // bond-attribute specs (already filtered by `bondAttrsOf` on the way in), so the
  // `_bondAttr_<id>` + `_bondFormAttr_<id>` blocks land in the same slots the
  // compiled param list declares. Omitting it shifts EVERY later arg by the bond
  // count (the `r_`/`w_` block ends up reading the field block, etc.).
  const shape = { is3d: s.worldDepth > 1, agentAttrs: s.attrSpecs, fieldAttrs: ctx.fieldSpecs, hasLookupTables: ctx.hasLookupTables, bondAttrs: s.bondAttrSpecs };
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

// Synthetic: RNG DRAW ORDER across a branch. One getRandom is consumed INSIDE a
// conditional branch; a second + third are consumed by flow nodes AFTER the
// conditional. The JS agent compiler used to hoist a draw whose sink scope is
// agent-loop top into the pre-flow value block (topo order) while the WASM agent
// compiler emits at the flow use site — so the two advanced the shared `_rs`
// stream in a DIFFERENT ORDER and every downstream decision diverged. Each draw
// lands in an agent attribute, so any reordering shows up as a mismatch.
function buildRngOrderModel() {
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
  // Branch-local draw.
  const rndIn = an('getRandom', { randomType: 'float', min: '0', max: '1' });
  const setIn = an('setAttribute', { attributeId: 'inBranch' });
  aE(rndIn, 'value', setIn, 'value', 'value');
  aE(cond, 'then', setIn, 'do', 'flow');
  // Draw consumed AFTER the conditional (a top-level flow node => sink = loop top).
  const rndAfter = an('getRandom', { randomType: 'float', min: '0', max: '1' });
  const setAfter = an('setAttribute', { attributeId: 'afterBranch' });
  aE(rndAfter, 'value', setAfter, 'value', 'value');
  aE(cond, 'next', setAfter, 'do', 'flow');
  // A third draw, also after, so the post-branch ORDER of two draws is pinned too.
  const rndAfter2 = an('getRandom', { randomType: 'integer', min: '-1', max: '1' });
  const setAfter2 = an('setAttribute', { attributeId: 'sel' });
  aE(rndAfter2, 'value', setAfter2, 'value', 'value');
  aE(setAfter, 'next', setAfter2, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'RNG Order Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'static', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'sel', name: 'Sel', type: 'float', defaultValue: '0' },
      { id: 'inBranch', name: 'InBranch', type: 'float', defaultValue: '0' },
      { id: 'afterBranch', name: 'AfterBranch', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Synthetic: a value used BOTH inside a branch AND after it (the JS agent
// compiler used to declare it INSIDE the branch => `_v... is not defined`), plus
// a getVariable read consumed in BOTH branches whose shared PURE input was
// dragged into the FIRST branch by the force-emit. Either defect throws at
// runtime, so simply RUNNING this model is the regression check.
function buildBranchScopeModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  // --- part 1: a getVariable read used in BOTH branches over a SHARED pure input
  const rnd = an('getRandom', { randomType: 'float', min: '0', max: '1' });
  const sv = an('setVariable', { variableId: 'roll' });
  aE(rnd, 'value', sv, 'value', 'value');
  aE(bs, 'do', sv, 'do', 'flow');
  const gv = an('getVariable', { variableId: 'roll' });
  const shared = an('getRadius', {});                       // PURE, used by both branches
  const pA = an('expression', { expression: 'a+1', visibleCount: 1 });
  aE(shared, 'value', pA, 'a', 'value');
  const pB = an('expression', { expression: 'a+2', visibleCount: 1 });
  aE(shared, 'value', pB, 'a', 'value');
  const cmpA = an('statement', { compareType: 'numerical', operation: '<' });
  aE(gv, 'value', cmpA, 'x', 'value'); aE(pA, 'result', cmpA, 'y', 'value');
  const cmpB = an('statement', { compareType: 'numerical', operation: '<' });
  aE(gv, 'value', cmpB, 'x', 'value'); aE(pB, 'result', cmpB, 'y', 'value');
  const gsel = an('getCellAttribute', { attributeId: 'sel' });
  const cond = an('conditional', {});
  aE(gsel, 'value', cond, 'condition', 'value');
  aE(sv, 'next', cond, 'check', 'flow');
  // --- part 2: `shownVal` is consumed by a setAttribute INSIDE `then` (the 2nd
  // statement of the branch, so the branch's own next-chain must be walked) AND
  // by a node AFTER the conditional.
  const shownVal = an('valueSwitch', { _port_ifValue: '5', _port_elseValue: '9' });
  aE(gsel, 'value', shownVal, 'condition', 'value');
  const firstInThen = an('setAttribute', { attributeId: 'mark', _port_value: '1' });
  const secondInThen = an('setAttribute', { attributeId: 'sel' });
  aE(shownVal, 'result', secondInThen, 'value', 'value');
  aE(cond, 'then', firstInThen, 'do', 'flow');
  aE(firstInThen, 'next', secondInThen, 'do', 'flow');
  const inElse = an('setAttribute', { attributeId: 'mark' });
  aE(cmpB, 'result', inElse, 'value', 'value');
  aE(cond, 'else', inElse, 'do', 'flow');
  const afterA = an('setAttribute', { attributeId: 'inBranch' });
  aE(cmpA, 'result', afterA, 'value', 'value');
  aE(cond, 'next', afterA, 'do', 'flow');
  const afterShown = an('setAttribute', { attributeId: 'afterBranch' });
  aE(shownVal, 'result', afterShown, 'value', 'value');
  aE(afterA, 'next', afterShown, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Branch Scope Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'static', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'sel', name: 'Sel', type: 'float', defaultValue: '0' },
      { id: 'mark', name: 'Mark', type: 'float', defaultValue: '0' },
      { id: 'inBranch', name: 'InBranch', type: 'float', defaultValue: '0' },
      { id: 'afterBranch', name: 'AfterBranch', type: 'float', defaultValue: '0' },
    ],
    variables: [],
    agentVariables: [{ id: 'roll', name: 'roll', description: '', kind: 'scalar', dataType: 'float', initialValue: '0' }],
    indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Synthetic: ONE Get Random node, MANY consumers — the "a single draw is shared"
// invariant. A node's value must be drawn ONCE per agent per step and every
// consumer must see that same number, no matter where in the flow it is read.
// The risky shapes are cross-scope: a consumer INSIDE a branch plus one AFTER it
// (the JS compiler emits at the LCA, above the branch; the WASM/WebGPU agent
// compilers emit at first use and drop the cache at branch exit — a re-emit
// there would be a SECOND draw with a different value), and consumers in two
// SIBLING branches. `top` and `after` must always agree; whichever of
// `inThen`/`inElse` ran must agree with them too.
function buildRngSharingModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const rnd = an('getRandom', { randomType: 'float', min: '0', max: '1' });
  // (1) consumer at top level, BEFORE the branch
  const sTop = an('setAttribute', { attributeId: 'top' });
  aE(rnd, 'value', sTop, 'value', 'value');
  aE(bs, 'do', sTop, 'do', 'flow');
  // (2) + (3) consumers in the two SIBLING branches
  const gsel = an('getCellAttribute', { attributeId: 'sel' });
  const cmp = an('statement', { compareType: 'numerical', operation: '>=', _port_y: '0' });
  aE(gsel, 'value', cmp, 'x', 'value');
  const cond = an('conditional', {});
  aE(cmp, 'result', cond, 'condition', 'value');
  aE(sTop, 'next', cond, 'check', 'flow');
  const sThen = an('setAttribute', { attributeId: 'inThen' });
  aE(rnd, 'value', sThen, 'value', 'value');
  aE(cond, 'then', sThen, 'do', 'flow');
  const sElse = an('setAttribute', { attributeId: 'inElse' });
  aE(rnd, 'value', sElse, 'value', 'value');
  aE(cond, 'else', sElse, 'do', 'flow');
  // (4) consumer AFTER the branch, and (5) one reading it THROUGH an expression
  const sAfter = an('setAttribute', { attributeId: 'afterB' });
  aE(rnd, 'value', sAfter, 'value', 'value');
  aE(cond, 'next', sAfter, 'do', 'flow');
  const expr = an('expression', { expression: 'a*10', visibleCount: 1 });
  aE(rnd, 'value', expr, 'a', 'value');
  const sExpr = an('setAttribute', { attributeId: 'viaExpr' });
  aE(expr, 'result', sExpr, 'value', 'value');
  aE(sAfter, 'next', sExpr, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'RNG Sharing Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'static', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'sel', name: 'Sel', type: 'float', defaultValue: '0' },
      { id: 'top', name: 'Top', type: 'float', defaultValue: '0' },
      { id: 'inThen', name: 'InThen', type: 'float', defaultValue: '0' },
      { id: 'inElse', name: 'InElse', type: 'float', defaultValue: '0' },
      { id: 'afterB', name: 'AfterB', type: 'float', defaultValue: '0' },
      { id: 'viaExpr', name: 'ViaExpr', type: 'float', defaultValue: '0' },
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

// Synthetic: the two Vector Op ROTATION ops (rotate2d + rotateAxis / Rodrigues).
// Both are EDITOR SUGAR lowered by `expandComposites` into scalar
// arithmeticOperator nodes (deg→rad multiply + sin/cos + the guarded ÷ that
// normalises the axis), so this guards that the LOWERED node tree is JS↔WASM
// bit-identical — the deg→rad literal, the sin/cos host-import ↔ Math.* pairing,
// and the ÷0→0 axis guard all sit on the path. 3D so rotateAxis is meaningful.
// The agent's own position is rotated by a per-agent angle (radius·37°) and the
// three components are ACCUMULATED into attributes, so any ULP divergence
// compounds within a few steps.
function buildVectorRotateModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  // v = (myX, myY, myZ); angle = myRadius * 37 (a per-agent, non-round angle).
  const mv = an('makeVector', {});
  aE(bs, 'myX', mv, 'x', 'value');
  aE(bs, 'myY', mv, 'y', 'value');
  aE(bs, 'myZ', mv, 'z', 'value');
  const ang = an('arithmeticOperator', { operation: '*', _port_y: '37' });
  aE(bs, 'myRadius', ang, 'x', 'value');

  // (1) rotate2d about Z — Z must pass through untouched.
  const r2 = an('vectorOp', { op: 'rotate2d' });
  aE(mv, 'vector', r2, 'a', 'value');
  aE(ang, 'result', r2, 'angle', 'value');
  const b2 = an('breakVector', {});
  aE(r2, 'result', b2, 'vector', 'value');

  // (2) rotateAxis about an UNnormalised axis built from the agent's own state
  //     (myY, myRadius, myX) — exercises the guarded normalise divide.
  const mk = an('makeVector', {});
  aE(bs, 'myY', mk, 'x', 'value');
  aE(bs, 'myRadius', mk, 'y', 'value');
  aE(bs, 'myX', mk, 'z', 'value');
  const r3 = an('vectorOp', { op: 'rotateAxis' });
  aE(mv, 'vector', r3, 'a', 'value');
  aE(mk, 'vector', r3, 'axis', 'value');
  aE(ang, 'result', r3, 'angle', 'value');
  const b3 = an('breakVector', {});
  aE(r3, 'result', b3, 'vector', 'value');

  // Accumulate all six components so a divergence compounds.
  const u1 = an('updateAttribute', { attributeId: 'r2x', operation: 'increment' });
  aE(b2, 'x', u1, 'value', 'value');
  aE(bs, 'do', u1, 'do', 'flow');
  const u2 = an('updateAttribute', { attributeId: 'r2y', operation: 'increment' });
  aE(b2, 'y', u2, 'value', 'value');
  aE(u1, 'next', u2, 'do', 'flow');
  const u3 = an('updateAttribute', { attributeId: 'r2z', operation: 'increment' });
  aE(b2, 'z', u3, 'value', 'value');
  aE(u2, 'next', u3, 'do', 'flow');
  const u4 = an('updateAttribute', { attributeId: 'r3x', operation: 'increment' });
  aE(b3, 'x', u4, 'value', 'value');
  aE(u3, 'next', u4, 'do', 'flow');
  const u5 = an('updateAttribute', { attributeId: 'r3y', operation: 'increment' });
  aE(b3, 'y', u5, 'value', 'value');
  aE(u4, 'next', u5, 'do', 'flow');
  const u6 = an('updateAttribute', { attributeId: 'r3z', operation: 'increment' });
  aE(b3, 'z', u6, 'value', 'value');
  aE(u5, 'next', u6, 'do', 'flow');
  // The rotated vector also drives a force, so positions diverge too if the math does.
  const af = an('applyForce', {});
  aE(b3, 'x', af, 'fx', 'value');
  aE(b3, 'y', af, 'fy', 'value');
  aE(b3, 'z', af, 'fz', 'value');
  aE(u6, 'next', af, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Vector Rotate Parity Test', dimension: '3d', gridWidth: 24, gridHeight: 24, gridDepth: 12, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, worldDepth: 12, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0.5, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: ['r2x', 'r2y', 'r2z', 'r3x', 'r3y', 'r3z'].map(id => ({ id, name: id, type: 'float', defaultValue: '0' })),
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

// Group Counting / Group Assert OPERAND PORTS. The node defs declare `values` +
// `compare` / `compareHigh` (Count Matching) and `values` + `x` (Group Assert),
// and the JS emitter reads exactly those — but BOTH agent emitters once read
// `value` / `value2`, which no port carries, so a WIRED operand silently fell
// back to 0 on WASM and WebGPU while JS read the real value. No shipped model
// used either node on the AGENT graph, so nothing caught it until the Neighbour
// Census lowering (which synthesizes getConstant → groupCounting.compare) made
// it load-bearing. This synthetic wires all three operands over a bonded 1-ring.
//
// It carries a VALUE invariant recounted from the store's OWN bond list, so it
// fails even if BOTH targets read the wrong port identically (parity alone is a
// mirror test). Bonded (not proximity) so the recount is exact integer work.
function buildGroupOperandModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const gba = an('getBondedAgents', {});
  const gaa = an('getAgentsAttribute', { attributeId: 'state' });
  aE(gba, 'agents', gaa, 'agents', 'value');
  // equals: count neighbours whose state == 1 (the wired `compare` operand).
  const kEq = an('getConstant', { constType: 'integer', constValue: '1' });
  const gcEq = an('groupCounting', { operation: 'equals' });
  aE(gaa, 'values', gcEq, 'values', 'value');
  aE(kEq, 'value', gcEq, 'compare', 'value');
  // between: count neighbours with 0 <= state <= 2 (BOTH operand ports wired).
  const kLo = an('getConstant', { constType: 'integer', constValue: '0' });
  const kHi = an('getConstant', { constType: 'integer', constValue: '2' });
  const gcBt = an('groupCounting', { operation: 'between', lowOp: '>=', highOp: '<=' });
  aE(gaa, 'values', gcBt, 'values', 'value');
  aE(kLo, 'value', gcBt, 'compare', 'value');
  aE(kHi, 'value', gcBt, 'compareHigh', 'value');
  // hasA: is any neighbour's state == -2 (the wired `x` operand)?
  const kHas = an('getConstant', { constType: 'integer', constValue: '-2' });
  const gs = an('groupStatement', { operation: 'hasA' });
  aE(gaa, 'values', gs, 'values', 'value');
  aE(kHas, 'value', gs, 'x', 'value');
  const set = an('setAttribute', { attributeId: 'cEq', extraCount: 2, attr_2: 'cBt', attr_3: 'sHas' });
  aE(gcEq, 'count', set, 'value', 'value');
  aE(gcBt, 'count', set, 'value_2', 'value');
  aE(gs, 'result', set, 'value_3', 'value');
  aE(bs, 'do', set, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Group Operand Ports Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 4, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, bondStiffness: 0, bondRestLength: 1.5, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'data', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'state', name: 'State', type: 'integer', defaultValue: '0' },
      { id: 'cEq', name: 'CountEq', type: 'integer', defaultValue: '0' },
      { id: 'cBt', name: 'CountBetween', type: 'integer', defaultValue: '0' },
      { id: 'sHas', name: 'HasMinus2', type: 'integer', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Neighbour State Census over a 3-option TAG attribute (Graph-Rewriting Automata).
// The node never reaches a compiler — `expandNeighbourCensus` lowers it into
// Get Bonded Agents -> Get Agents Attribute -> one Count Matching per CONSUMED
// state port (+ Array Length for Total) in ALL THREE agent front-ends. All three
// counts AND the total are stored into SEPARATE agent attributes, so a mis-mapped
// port (count_1's chain wired to count_2's output, say) shows as a mismatch rather
// than cancelling out. Bonded (not proximity) so the invariant recount is exact.
function buildCensusModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  const census = an('neighbourCensus', { attributeId: 'kind', source: 'bonded' });
  const set = an('setAttribute', { attributeId: 'c0', extraCount: 3, attr_2: 'c1', attr_3: 'c2', attr_4: 'tot' });
  aE(census, 'count_0', set, 'value', 'value');
  aE(census, 'count_1', set, 'value_2', 'value');
  aE(census, 'count_2', set, 'value_3', 'value');
  aE(census, 'total', set, 'value_4', 'value');
  aE(bs, 'do', set, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Neighbour Census Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 4, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, bondStiffness: 0, bondRestLength: 1.5, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'data', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'kind', name: 'Kind', type: 'tag', defaultValue: '0', tagOptions: ['Red', 'Green', 'Blue'] },
      { id: 'c0', name: 'C0', type: 'integer', defaultValue: '0' },
      { id: 'c1', name: 'C1', type: 'integer', defaultValue: '0' },
      { id: 'c2', name: 'C2', type: 'integer', defaultValue: '0' },
      { id: 'tot', name: 'Tot', type: 'integer', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Recount the census from the store's OWN bond list. `kind` is seeded by the
// harness and never written, so this is exact — and it fails even if BOTH targets
// lower the census identically wrong (parity alone is a mirror test). The harness
// seeds every agent attr with (i%5)-2, so `kind` spans -2..2 and the three tracked
// options 0/1/2 each match a real subset.
function censusInvariant(st) {
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const want = [0, 0, 0];
    let tot = 0;
    const base = i * st.maxBonds;
    for (let k = 0; k < st.bondCount[i]; k++) {
      const p = st.bondPartner[base + k];
      if (p < 0 || p >= st.highWater || !st.alive[p]) continue;
      tot++;
      const v = st.attrRead.kind[p];
      if (v >= 0 && v <= 2) want[v]++;
    }
    const got = [st.attrRead.c0[i], st.attrRead.c1[i], st.attrRead.c2[i]];
    for (let o = 0; o < 3; o++) {
      if (got[o] !== want[o]) return `agent ${i}: count_${o} ${got[o]} !== recount ${want[o]}`;
    }
    if (st.attrRead.tot[i] !== tot) return `agent ${i}: total ${st.attrRead.tot[i]} !== recount ${tot}`;
  }
  return null;
}

// BOND ATTRIBUTES (P2, Graph-Rewriting Automata) — per-EDGE user state.
//
// The rule writes each bond's attributes from ONE SIDE ONLY (the lower-id
// endpoint, gated on `partner > self`) and then reads EVERY bond back — so a
// write that failed to mirror into the partner's slot shows up as a zero read on
// the higher-id agent. Both region kinds are exercised: `w` (float → f64 region)
// and `lbl` (integer → i32 region), written with the SAME value so a region-kind
// mixup is a mismatch rather than a coincidence.
//
// The setup breaks a deterministic subset of the bonds BEFORE the behaviour runs,
// so the ragged slots have already been COMPACTED (swap-with-last) — the emitted
// scan must resolve a partner on its post-compaction slot, not a remembered index.
function buildBondAttrModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

  const bs = an('behaviourStep', {});
  // zero the accumulators
  const z = an('setAttribute', { attributeId: 'sumW', extraCount: 2, attr_2: 'sumL', attr_3: 'nb', _port_value: '0', _port_value_2: '0', _port_value_3: '0' });
  // --- write loop: only the LOWER-id endpoint writes ---
  const feb1 = an('forEachBond', {});
  const gsh = an('getSelfHandle', {});
  const cmp = an('statement', { operation: '>' });
  const cond = an('conditional', {});
  const mul = an('arithmeticOperator', { operation: '*', _port_y: '1000' });
  const add = an('arithmeticOperator', { operation: '+' });
  const sbW = an('setBondAttribute', { attributeId: 'w' });
  const sbL = an('setBondAttribute', { attributeId: 'lbl' });
  // --- read loop: EVERY bond, from whichever side ---
  const feb2 = an('forEachBond', {});
  const gbW = an('getBondAttribute', { attributeId: 'w' });
  const gbL = an('getBondAttribute', { attributeId: 'lbl' });
  const upW = an('updateAttribute', { attributeId: 'sumW', operation: 'increment' });
  const upL = an('updateAttribute', { attributeId: 'sumL', operation: 'increment' });
  const upN = an('updateAttribute', { attributeId: 'nb', operation: 'increment', _port_value: '1' });

  aE(bs, 'do', z, 'do', 'flow');
  aE(z, 'next', feb1, 'do', 'flow');
  aE(feb1, 'body', cond, 'check', 'flow');
  aE(feb1, 'partnerId', cmp, 'x', 'value');
  aE(gsh, 'value', cmp, 'y', 'value');
  aE(cmp, 'result', cond, 'condition', 'value');
  aE(gsh, 'value', mul, 'x', 'value');
  aE(mul, 'result', add, 'x', 'value');
  aE(feb1, 'partnerId', add, 'y', 'value');
  aE(cond, 'then', sbW, 'do', 'flow');
  aE(feb1, 'partnerId', sbW, 'partnerId', 'value');
  aE(add, 'result', sbW, 'value', 'value');
  aE(sbW, 'next', sbL, 'do', 'flow');
  aE(feb1, 'partnerId', sbL, 'partnerId', 'value');
  aE(add, 'result', sbL, 'value', 'value');
  aE(feb1, 'next', feb2, 'do', 'flow');
  aE(feb2, 'body', upW, 'do', 'flow');
  aE(feb2, 'partnerId', gbW, 'partnerId', 'value');
  aE(feb2, 'partnerId', gbL, 'partnerId', 'value');
  aE(gbW, 'value', upW, 'value', 'value');
  aE(upW, 'next', upL, 'do', 'flow');
  aE(gbL, 'value', upL, 'value', 'value');
  aE(upL, 'next', upN, 'do', 'flow');

  return {
    schemaVersion: 1,
    properties: { name: 'Bond Attributes Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 6, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, bondStiffness: 0, bondRestLength: 1.5, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'data', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'sumW', name: 'SumW', type: 'float', defaultValue: '0' },
      { id: 'sumL', name: 'SumL', type: 'integer', defaultValue: '0' },
      { id: 'nb', name: 'NBonds', type: 'integer', defaultValue: '0' },
    ],
    bondAttributes: [
      { id: 'w', name: 'Weight', type: 'float', defaultValue: '0' },
      { id: 'lbl', name: 'Label', type: 'integer', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** Ring + chords, then BREAK a deterministic subset so the ragged bond slots have
 *  already been compacted (swap-with-last) before the behaviour ever runs. */
function setupBondAttrStores(stores) {
  for (const s of stores) {
    for (let i = 0; i < s.highWater; i++) {
      formBond(s, i, (i + 1) % s.highWater, 1.5, 0);
      if (i % 3 === 0) formBond(s, i, (i + 5) % s.highWater, 1.5, 0);
      if (i % 4 === 0) formBond(s, i, (i + 11) % s.highWater, 1.5, 0);
    }
    for (let i = 0; i < s.highWater; i += 5) breakBond(s, i, (i + 1) % s.highWater);
  }
}

/** THE VALUE INVARIANT (not just cross-target agreement — parity is a mirror test
 *  and passes happily when both targets are equally wrong):
 *    • every live bond's value equals `min(i,p)*1000 + max(i,p)`, recomputed here
 *      straight from the store's own bond list — so a one-sided write (the higher
 *      agent reading 0) is caught even if JS and WASM agree;
 *    • the two endpoints' slots hold the SAME value (invariant I2 in the store);
 *    • the float (`w`) and integer (`lbl`) regions agree, so a region-kind mixup
 *      cannot pass;
 *    • the per-agent sums + bond counts match the recount. */
function bondAttrInvariant(st) {
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    let sum = 0, cnt = 0;
    const base = i * st.maxBonds;
    for (let k = 0; k < st.bondCount[i]; k++) {
      const p = st.bondPartner[base + k];
      if (p < 0 || p >= st.highWater || !st.alive[p]) continue;
      const want = Math.min(i, p) * 1000 + Math.max(i, p);
      const gotW = st.bondAttrs.w[base + k], gotL = st.bondAttrs.lbl[base + k];
      if (gotW !== want) return `bond ${i}→${p}: w ${gotW} !== expected ${want}`;
      if (gotL !== want) return `bond ${i}→${p}: lbl ${gotL} !== expected ${want}`;
      // I2 — the partner's slot must hold the SAME value.
      const pb = p * st.maxBonds;
      let mirrored = null;
      for (let j = 0; j < st.bondCount[p]; j++) if (st.bondPartner[pb + j] === i) { mirrored = st.bondAttrs.w[pb + j]; break; }
      if (mirrored === null) return `bond ${i}→${p}: no reverse slot`;
      if (mirrored !== gotW) return `bond ${i}↔${p}: w ${gotW} !== partner side ${mirrored}`;
      sum += want; cnt++;
    }
    if (st.attrRead.sumW[i] !== sum) return `agent ${i}: sumW ${st.attrRead.sumW[i]} !== recount ${sum}`;
    if (st.attrRead.sumL[i] !== sum) return `agent ${i}: sumL ${st.attrRead.sumL[i]} !== recount ${sum}`;
    if (st.attrRead.nb[i] !== cnt) return `agent ${i}: nb ${st.attrRead.nb[i]} !== recount ${cnt}`;
  }
  return null;
}

// A deterministic ring + chord bond topology (identical on both stores). Every
// agent gets 2-3 partners; positions are left as seeded (the rule is topological,
// so geometry is irrelevant here).
function setupRingBondStores(stores) {
  for (const s of stores) {
    for (let i = 0; i < s.highWater; i++) {
      formBond(s, i, (i + 1) % s.highWater, 1.5, 0);
      if (i % 3 === 0) formBond(s, i, (i + 5) % s.highWater, 1.5, 0);
    }
  }
}

// Recount the three group reductions straight from the store's OWN bond list.
// `state` is seeded by the harness and never written, so this is exact.
function groupOperandInvariant(st) {
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    let eq = 0, bt = 0, has = 0;
    const base = i * st.maxBonds;
    for (let k = 0; k < st.bondCount[i]; k++) {
      const p = st.bondPartner[base + k];
      if (p < 0 || p >= st.highWater || !st.alive[p]) continue;
      const v = st.attrRead.state[p];
      if (v === 1) eq++;
      if (v >= 0 && v <= 2) bt++;
      if (v === -2) has = 1;
    }
    if (st.attrRead.cEq[i] !== eq) return `agent ${i}: cEq ${st.attrRead.cEq[i]} !== recount ${eq}`;
    if (st.attrRead.cBt[i] !== bt) return `agent ${i}: cBt ${st.attrRead.cBt[i]} !== recount ${bt}`;
    if (st.attrRead.sHas[i] !== has) return `agent ${i}: sHas ${st.attrRead.sHas[i]} !== recount ${has}`;
  }
  return null;
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
entries.push({ name: '[synthetic] Vector Op rotate2d + rotateAxis (lowered, 3D)', raw: buildVectorRotateModel() });
entries.push({ name: '[synthetic] Curvature + bond currentLength (bonded, hypot↔sqrt)', raw: buildCurvatureModel(), setup: setupCurvatureStores });
entries.push({
  name: '[synthetic] Group operand ports (wired compare / compareHigh / x)',
  raw: buildGroupOperandModel(), setup: setupRingBondStores, invariant: groupOperandInvariant,
});
entries.push({
  name: '[synthetic] Neighbour Census (3-option tag over the bonded 1-ring)',
  raw: buildCensusModel(), setup: setupRingBondStores, invariant: censusInvariant,
});

// ---------------------------------------------------------------------------
// P4 - the STRUCTURAL REQUEST QUEUE synthetic.
//
// One agent issues FOUR explicit ops (break / form / rewire / rewire-with-an-
// unresolvable-side) and then a Loop of 12 more forms - 16 ops against the
// default depth 8, so the queue fills, four loop ops land in real entries and the
// remaining eight all hit the OVERFLOW BUCKET (each overwriting the last, which is
// the documented behaviour: the bucket only has to be OCCUPIED for the drain to
// report the overflow). The parity harness runs the BEHAVIOUR only, so what is
// compared is exactly what the three targets write into the queue.
// ---------------------------------------------------------------------------
function buildBondQueueModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  // `self + k` as a value-node chain (deterministic per agent, no modulo needed:
  // an out-of-range id is a legal REQUEST, the drain is what rejects it).
  const gsh = an('getSelfHandle', {});
  const off = (k) => { const n = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); aE(gsh, 'value', n, 'x', 'value'); return n; };

  const bs = an('behaviourStep', {});
  const brk = an('breakBond', {});
  const frm = an('formBond', { _port_restLength: '3', _port_stiffness: '5', _port_bondAttr_bw: '21' });
  const rw = an('rewireBond', { _port_restLength: '7', _port_stiffness: '11', _port_bondAttr_bw: '22' });
  const rwBad = an('rewireBond', { _port_restLength: '13', _port_stiffness: '17', _port_bondAttr_bw: '23' });
  const lp = an('loop', { mode: 'count', _port_count: '12' });
  const lpForm = an('formBond', { _port_restLength: '0', _port_stiffness: '0', _port_bondAttr_bw: '24' });

  aE(bs, 'do', brk, 'do', 'flow');
  aE(off(1), 'result', brk, 'targetAgent', 'value');
  aE(brk, 'next', frm, 'do', 'flow');
  aE(off(2), 'result', frm, 'targetAgent', 'value');
  aE(frm, 'next', rw, 'do', 'flow');
  aE(off(3), 'result', rw, 'fromAgent', 'value');
  aE(off(4), 'result', rw, 'toAgent', 'value');
  aE(rw, 'next', rwBad, 'do', 'flow');
  aE(off(-1000), 'result', rwBad, 'fromAgent', 'value');   // unresolvable -> BOTH lanes NONE
  aE(off(5), 'result', rwBad, 'toAgent', 'value');
  aE(rwBad, 'next', lp, 'do', 'flow');
  aE(lp, 'body', lpForm, 'do', 'flow');
  // target = self + 100 + loopIndex
  const base100 = off(100);
  const withIdx = an('arithmeticOperator', { operation: '+' });
  aE(base100, 'result', withIdx, 'x', 'value');
  aE(lp, 'index', withIdx, 'y', 'value');
  aE(withIdx, 'result', lpForm, 'targetAgent', 'value');

  return {
    schemaVersion: 1,
    properties: { name: 'Bond Request Queue Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 6, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, bondStiffness: 0, bondRestLength: 1.5, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'data', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [],
    bondAttributes: [{ id: 'bw', name: 'BondW', type: 'float', defaultValue: '0' }],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** THE VALUE INVARIANT - the expected queue is recomputed INDEPENDENTLY here from
 *  the agent index (not read back from the emitted code), so both targets writing
 *  the same WRONG entries would still fail. Lane encoding: 0 empty, 1 unused side,
 *  id+2 otherwise (bondRequestQueue.ts). */
function bondQueueInvariant(st) {
  const NONE = 1, BIAS = 2;
  const slots = st.bondReqSlots, depth = slots - 1;
  if (slots !== 9) return `bondReqSlots ${slots} !== 9 (default depth 8 + the overflow bucket)`;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const b = i * slots;
    // [breakLane, formLane, L, K, bondAttr bw]
    const want = [
      [i + 1 + BIAS, NONE, 0, 0, null],            // 0  break(self+1)
      [NONE, i + 2 + BIAS, 3, 5, 21],              // 1  form(self+2)
      [i + 3 + BIAS, i + 4 + BIAS, 7, 11, 22],     // 2  rewire(self+3 -> self+4)
      [NONE, NONE, 13, 17, 23],                    // 3  rewire with an unresolvable From
      [NONE, i + 100 + BIAS, 0, 0, 24],            // 4  loop k=0
      [NONE, i + 101 + BIAS, 0, 0, 24],            // 5  loop k=1
      [NONE, i + 102 + BIAS, 0, 0, 24],            // 6  loop k=2
      [NONE, i + 103 + BIAS, 0, 0, 24],            // 7  loop k=3
      [NONE, i + 111 + BIAS, 0, 0, 24],            // 8  OVERFLOW bucket = the LAST rejected op (k=11)
    ];
    for (let c = 0; c < slots; c++) {
      const [wb, wf, wl, wk, wa] = want[c];
      if (st.bondBreakReq[b + c] !== wb) return `agent ${i} entry ${c}: breakLane ${st.bondBreakReq[b + c]} !== ${wb}`;
      if (st.bondFormReq[b + c] !== wf) return `agent ${i} entry ${c}: formLane ${st.bondFormReq[b + c]} !== ${wf}`;
      if (st.bondFormL[b + c] !== wl) return `agent ${i} entry ${c}: L ${st.bondFormL[b + c]} !== ${wl}`;
      if (st.bondFormK[b + c] !== wk) return `agent ${i} entry ${c}: K ${st.bondFormK[b + c]} !== ${wk}`;
      if (wa !== null && st.bondFormAttrs.bw[b + c] !== wa) return `agent ${i} entry ${c}: bondAttr bw ${st.bondFormAttrs.bw[b + c]} !== ${wa}`;
    }
    // The queue must have filled EXACTLY to the depth (the terminator rule): no
    // real entry may read as empty, or the drain would truncate and drop later ops.
    for (let c = 0; c < depth; c++) {
      if (st.bondBreakReq[b + c] === 0 && st.bondFormReq[b + c] === 0) return `agent ${i} entry ${c} reads as EMPTY (queue truncation)`;
    }
  }
  return null;
}

entries.push({
  name: '[synthetic] Bond attributes (one-sided write, both-sides read, post-break)',
  raw: buildBondAttrModel(), setup: setupBondAttrStores, invariant: bondAttrInvariant,
});
entries.push({
  name: '[synthetic] Bond request QUEUE (4 ops + a 12-iteration loop, overflow)',
  raw: buildBondQueueModel(), setup: setupBondAttrStores, invariant: bondQueueInvariant,
});
entries.push({ name: '[synthetic] Flow diamond (conditional → shared getRandom chain)', raw: buildDiamondModel() });
entries.push({ name: '[synthetic] RNG draw order (branch draw + post-branch draws)', raw: buildRngOrderModel() });
entries.push({ name: '[synthetic] Branch scope (value used inside AND after a branch)', raw: buildBranchScopeModel() });
entries.push({
  name: '[synthetic] RNG sharing (one draw, many consumers across scopes)',
  raw: buildRngSharingModel(),
  // ONE draw per agent per step, shared by every consumer: the pre-branch read,
  // the post-branch read and the expression-mediated read must all be the same
  // number, and whichever branch ran must have seen it too. A second draw
  // anywhere (e.g. a branch-exit cache drop re-emitting the node) shows up here
  // even if BOTH targets did it identically, which parity could not catch.
  invariant: (st) => {
    for (let i = 0; i < st.highWater; i++) {
      if (!st.alive[i]) continue;
      const top = st.attrRead.top[i], after = st.attrRead.afterB[i];
      const viaExpr = st.attrRead.viaExpr[i];
      const sel = st.attrRead.sel[i];
      const branch = sel >= 0 ? st.attrRead.inThen[i] : st.attrRead.inElse[i];
      if (top !== after) return `agent ${i}: top ${top} !== afterBranch ${after}`;
      if (top !== branch) return `agent ${i}: top ${top} !== in-branch ${branch}`;
      if (Math.abs(viaExpr - top * 10) > 1e-12) return `agent ${i}: viaExpr ${viaExpr} !== top*10 ${top * 10}`;
      if (!(top > 0 && top < 1)) return `agent ${i}: draw ${top} outside [0,1)`;
    }
    return null;
  },
});

for (const { name: f, raw, setup, invariant } of entries) {
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
  // P2: BOTH stores get the model's bond-attribute specs — the wasmBacked one so
  // its baked offsets match the module the compiler emitted (createAgentStore
  // overrides layoutExtras.bondAttrSpecs with these), the JS one so its ragged
  // regions exist at all. `bondAttrSpecs` from the layout extras = bondAttrsOf.
  const bondSpecs = (layoutExtras.bondAttrSpecs ?? []).map(b => {
    const decl = (model.bondAttributes ?? []).find(a => a.id === b.id);
    return { id: b.id, type: b.type, defaultValue: decl ? encodeAttr(decl) : 0 };
  });
  // P4: BOTH stores must get the SAME request-queue stride (the worker ships one
  // number to every target). Without it the plain store would fall back to the
  // config depth while the wasmBacked one uses the usage-gated layout value.
  const bondReqSlots = layoutExtras.bondReqSlots ?? 1;
  const A = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs, bondAttrSpecs: bondSpecs, bondReqSlots });
  const B = createAgentStore(cfg, specs, { wasmBacked: true, syncAttrs, maxHashBins: cMaxHashBins, layoutExtras, bondAttrSpecs: bondSpecs, bondReqSlots });
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
    // P4 - the STRUCTURAL REQUEST QUEUE: compare the WHOLE per-agent entry block
    // (hw * bondReqSlots), not just entry 0, or a divergence in the 2nd..Dth
    // queued op (which is the entire point of the queue) would go unseen.
    const nQ = hw * A.bondReqSlots;
    cmpArr('bondFormReq', A.bondFormReq, B.bondFormReq, nQ);
    cmpArr('bondBreakReq', A.bondBreakReq, B.bondBreakReq, nQ);
    cmpArr('bondFormL', A.bondFormL, B.bondFormL, nQ);
    cmpArr('bondFormK', A.bondFormK, B.bondFormK, nQ);
    for (const id of Object.keys(A.bondFormAttrs)) cmpArr('bondFormAttr_' + id, A.bondFormAttrs[id], B.bondFormAttrs[id], nQ);
    cmpArr('divideAxisX', A.divideAxisX, B.divideAxisX, hw); cmpArr('divideAxisY', A.divideAxisY, B.divideAxisY, hw);
    for (const spec of agentAttrs) cmpArr('attr_' + spec.id, A.attrRead[spec.id], B.attrRead[spec.id], hw);
    // Per-entry VALUE invariant, checked on BOTH stores. Parity alone would pass
    // if both targets were equally wrong, so an entry can assert a semantic
    // property (see the RNG-sharing synthetic) that must hold independently.
    if (invariant && mismatch === 0) {
      for (const [label, st] of [['js', A], ['wasm', B]]) {
        const bad = invariant(st);
        if (bad) { mismatch++; if (!firstField) firstField = `INVARIANT(${label}) ${bad}`; break; }
      }
    }
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
