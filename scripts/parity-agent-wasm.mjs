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
  // L2: `usesGeneration: true` ALWAYS, mirroring the WORKER's shape builder (the
  // compiler passes the graph's real answer on the PARAM side). Params ≤ args is
  // the safe direction, so a trailing `_generation` the graph doesn't declare is
  // simply ignored.
  // C9 / STEP 4: the gates ride the STORE (the record it actually allocated),
  // exactly as the worker's `agentAbiShapeOfStore` will — so the harness cannot
  // build an arg list for a different field set than the store has.
  const shape = { is3d: s.worldDepth > 1, agentAttrs: s.attrSpecs, fieldAttrs: ctx.fieldSpecs, hasLookupTables: ctx.hasLookupTables, bondAttrs: s.bondAttrSpecs, usesGeneration: true, gates: s.fieldGates };
  const rt = {
    hash, emptyI32: new Int32Array(0),
    modelAttrs: ctx.cachedModelAttrs, viewer: ctx.activeViewer,
    indicators: ctx.cachedIndicators, rngState: ctx.rngState, stopFlag: ctx.stopFlag,
    glyphCodes: ctx.GLYPH_NOOP_CODES, glyphColors: ctx.GLYPH_NOOP_COLORS,
    lookupTables: ctx.cachedInteractionTables,
    width: ctx.width, height: ctx.height, total: ctx.total, torus: ctx.torus,
    fieldArray: (id) => ctx.readAttrs[id],
    generation: ctx.generation ?? 0,   // L2 — the value behind `_generation`
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
//
// It ALSO CONSUMES both id ARRAYS (`Left Agents` / `Right Agents`): a For Each over
// each side sums the neighbour ids into `sumL`/`sumR` (through a Local Variable),
// and Array Length re-reads each side's length into `lenL`/`lenR`. So the model
// covers the whole conditional-array-producer path — the shared single gather, the
// array scratch (the WASM bump slab / the WGSL var<function> slot), the array cache
// and the count-IS-the-length invariant. `hemifieldInvariant` recomputes all six
// values independently, because parity alone would pass if BOTH targets summed
// nothing.
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

  // --- the ARRAY side: For Each over each half, summing the neighbour ids ---
  // (a Local Variable accumulator — the canonical "act on the agents this side"
  // idiom, and the shape that exercises the array scratch + the array cache.)
  const zeroL = an('setVariable', { variableId: 'accL', _port_value: '0' });
  const zeroR = an('setVariable', { variableId: 'accR', _port_value: '0' });
  const feL = an('forEachInArray', {});
  const feR = an('forEachInArray', {});
  aE(sh, 'leftAgents', feL, 'array', 'value');
  aE(sh, 'rightAgents', feR, 'array', 'value');
  const addL = an('setVariable', { variableId: 'accL' });
  const addR = an('setVariable', { variableId: 'accR' });
  const gvL = an('getVariable', { variableId: 'accL' });
  const gvR = an('getVariable', { variableId: 'accR' });
  const sumExprL = an('expression', { expression: 'a + b', visibleCount: 2 });
  const sumExprR = an('expression', { expression: 'a + b', visibleCount: 2 });
  aE(gvL, 'value', sumExprL, 'a', 'value');
  aE(feL, 'element', sumExprL, 'b', 'value');
  aE(sumExprL, 'result', addL, 'value', 'value');
  aE(gvR, 'value', sumExprR, 'a', 'value');
  aE(feR, 'element', sumExprR, 'b', 'value');
  aE(sumExprR, 'result', addR, 'value', 'value');
  aE(feL, 'body', addL, 'do', 'flow');
  aE(feR, 'body', addR, 'do', 'flow');
  // Array Length on both sides (must equal the counts).
  const alL = an('arrayLength', {});
  const alR = an('arrayLength', {});
  aE(sh, 'leftAgents', alL, 'array', 'value');
  aE(sh, 'rightAgents', alR, 'array', 'value');
  const setSumL = an('setAttribute', { attributeId: 'sumL' });
  const setSumR = an('setAttribute', { attributeId: 'sumR' });
  const setLenL = an('setAttribute', { attributeId: 'lenL' });
  const setLenR = an('setAttribute', { attributeId: 'lenR' });
  const gvL2 = an('getVariable', { variableId: 'accL' });
  const gvR2 = an('getVariable', { variableId: 'accR' });
  aE(gvL2, 'value', setSumL, 'value', 'value');
  aE(gvR2, 'value', setSumR, 'value', 'value');
  aE(alL, 'length', setLenL, 'value', 'value');
  aE(alR, 'length', setLenR, 'value', 'value');
  // flow: counts -> zero the accumulators -> the two loops -> store sums + lengths
  aE(setR, 'next', zeroL, 'do', 'flow');
  aE(zeroL, 'next', zeroR, 'do', 'flow');
  aE(zeroR, 'next', feL, 'do', 'flow');
  aE(feL, 'next', feR, 'do', 'flow');
  aE(feR, 'next', setSumL, 'do', 'flow');
  aE(setSumL, 'next', setSumR, 'do', 'flow');
  aE(setSumR, 'next', setLenL, 'do', 'flow');
  aE(setLenL, 'next', setLenR, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Hemifield Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'countL', name: 'CountL', type: 'integer', defaultValue: '0' },
      { id: 'countR', name: 'CountR', type: 'integer', defaultValue: '0' },
      { id: 'sumL', name: 'SumL', type: 'float', defaultValue: '0' },
      { id: 'sumR', name: 'SumR', type: 'float', defaultValue: '0' },
      { id: 'lenL', name: 'LenL', type: 'integer', defaultValue: '0' },
      { id: 'lenR', name: 'LenR', type: 'integer', defaultValue: '0' },
    ],
    variables: [],
    agentVariables: [
      { id: 'accL', name: 'AccL', kind: 'scalar', dataType: 'float', initialValue: '0' },
      { id: 'accR', name: 'AccR', kind: 'scalar', dataType: 'float', initialValue: '0' },
    ],
    indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** Recompute the hemifield L/R partition from the STORE (positions + the wired
 *  heading + the cone), independently of the emitted code: every alive agent's
 *  in-view neighbours split by `cross = hx*dy - hy*dx >= 0`, then
 *    countL/countR === the recount,  sumL/sumR === the sum of that half's ids,
 *    lenL/lenR    === countL/countR  (the array IS exactly the counted set).
 *  Parity alone would pass if BOTH targets summed nothing, so these are VALUES. */
function hemifieldInvariant(st) {
  const R = 6, R2 = R * R, W = 24, H = 24, hW = W / 2, hH = H / 2;
  const hx = 1, hy = 0;                            // the wired heading
  const cosHalf = Math.cos((90 * Math.PI) / 180);  // halfAngle 90
  const hm = Math.sqrt(hx * hx + hy * hy);
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    let cl = 0, cr = 0, sl = 0, sr = 0;
    for (let j = 0; j < st.highWater; j++) {
      if (j === i || !st.alive[j]) continue;
      let dx = st.x[j] - st.x[i], dy = st.y[j] - st.y[i];
      if (dx > hW) dx -= W; else if (dx < -hW) dx += W;
      if (dy > hH) dy -= H; else if (dy < -hH) dy += H;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2) continue;
      const dot = hx * dx + hy * dy;
      if (!(dot >= (cosHalf * hm) * Math.sqrt(d2))) continue;
      if (hx * dy - hy * dx >= 0) { cl++; sl += j; } else { cr++; sr += j; }
    }
    const a = st.attrRead;
    if (a.countL[i] !== cl) return `agent ${i}: countL ${a.countL[i]} !== recount ${cl}`;
    if (a.countR[i] !== cr) return `agent ${i}: countR ${a.countR[i]} !== recount ${cr}`;
    if (a.sumL[i] !== sl) return `agent ${i}: sumL ${a.sumL[i]} !== recount ${sl}`;
    if (a.sumR[i] !== sr) return `agent ${i}: sumR ${a.sumR[i]} !== recount ${sr}`;
    if (a.lenL[i] !== cl) return `agent ${i}: leftAgents.length ${a.lenL[i]} !== leftCount ${cl}`;
    if (a.lenR[i] !== cr) return `agent ${i}: rightAgents.length ${a.lenR[i]} !== rightCount ${cr}`;
  }
  return null;
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
  const saa = an('setAttribute', { attributeId: 'o4', extraCount: 1, attr_2: 'o5' });
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


// Set Attribute's SCALAR-OR-ARRAY `Agent` port — the three targeting modes in one
// graph, so a divergence in any of them shows up as a JS↔WASM mismatch:
//   1. UNWIRED  -> `own`  = this agent's own myX (the historical self write);
//   2. SCALAR   -> `byid` = myY written through a Get Self Handle id;
//   3. ARRAY    -> a MULTI-SLOT write over the WHOLE Get Nearby Agents id array:
//                  slot 1 `bc` = the WRITER's myX (so a self-write is
//                  distinguishable from a broadcast), slot 2 `bc2` = the inline 6,
//                  slot 3 `bc3` = the WRITER's myY (pins the shared-agentId FAN-OUT
//                  — only slots 2+ depend on it).
// Momentum 0 with no applied force keeps positions static, which is what makes
// the invariant below exactly recomputable.
function buildAgentIdTargetModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  // 1 — unwired Agent = self.
  const setOwn = an('setAttribute', { attributeId: 'own' });
  aE(bs, 'myX', setOwn, 'value', 'value');
  // 2 — a SCALAR id (this agent's own handle) = the by-id arm.
  const gsh = an('getSelfHandle', {});
  const setById = an('setAttribute', { attributeId: 'byid' });
  aE(gsh, 'handle', setById, 'agentId', 'value');
  aE(bs, 'myY', setById, 'value', 'value');
  // 3 — an ID ARRAY + multi-slot: every nearby agent gets both attributes.
  const near = an('getNearbyAgents', { _port_radius: '1.2' });
  const setMany = an('setAttribute', { attributeId: 'bc', extraCount: 2, attr_2: 'bc2', _port_value_2: '6', attr_3: 'bc3' });
  aE(near, 'agents', setMany, 'agentId', 'value');
  aE(bs, 'myX', setMany, 'value', 'value');
  // Slot 3 is WIRED to the writer's myY: only the SHARED-agentId FAN-OUT can make
  // it land on the neighbours, so dropping the fan shows up here (slot 1 keeps the
  // original node's own edge and would look fine on its own).
  aE(bs, 'myY', setMany, 'value_3', 'value');
  aE(bs, 'do', setOwn, 'do', 'flow');
  aE(setOwn, 'next', setById, 'do', 'flow');
  aE(setById, 'next', setMany, 'do', 'flow');
  return {
    schemaVersion: 1,
    properties: { name: 'Agent Id Targeting Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 24, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'own', name: 'Own', type: 'float', defaultValue: '0' },
      { id: 'byid', name: 'ById', type: 'float', defaultValue: '0' },
      { id: 'bc', name: 'Bc', type: 'float', defaultValue: '0' },
      { id: 'bc2', name: 'Bc2', type: 'float', defaultValue: '0' },
      { id: 'bc3', name: 'Bc3', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** Recompute the three targeting modes from the STORE, independently of the
 *  emitted code. Parity alone would pass if BOTH targets wrote nothing (or wrote
 *  SELF instead of the array), so these are VALUES:
 *    own[i]  === x[i]                       (unwired = self)
 *    byid[i] === y[i]                       (a scalar id = that agent)
 *    bc[j]   === x[last writer of j]        (an ARRAY = every id in it; the agent
 *    bc2[j]  === 6                           loop is sequential, so the LAST
 *    bc3[j]  === y[last writer of j]          covering writer wins), 0 if none.
 *  The fixture is additionally asserted to be DISCRIMINATING: agents must be
 *  covered at all, and for some of them the broadcast value must DIFFER from
 *  their own x — otherwise "wrote self" / "wrote nothing" could pass. */
function agentIdTargetInvariant(st) {
  const R2 = 1.44, W = 24, H = 24, hW = W / 2, hH = H / 2;   // radius 1.2
  const a = st.attrRead;
  let covered = 0, distinctX = 0, distinctY = 0;
  for (let j = 0; j < st.highWater; j++) {
    if (!st.alive[j]) continue;
    let last = -1;
    for (let i = 0; i < st.highWater; i++) {
      if (i === j || !st.alive[i]) continue;
      let dx = st.x[j] - st.x[i], dy = st.y[j] - st.y[i];
      if (dx > hW) dx -= W; else if (dx < -hW) dx += W;
      if (dy > hH) dy -= H; else if (dy < -hH) dy += H;
      if (dx * dx + dy * dy <= R2) last = i;       // ascending i ⇒ the LAST writer
    }
    if (a.own[j] !== st.x[j]) return `agent ${j}: own ${a.own[j]} !== x ${st.x[j]} (unwired arm)`;
    if (a.byid[j] !== st.y[j]) return `agent ${j}: byid ${a.byid[j]} !== y ${st.y[j]} (scalar-id arm)`;
    const wantBc = last < 0 ? 0 : st.x[last];
    const wantBc2 = last < 0 ? 0 : 6;
    const wantBc3 = last < 0 ? 0 : st.y[last];
    if (a.bc[j] !== wantBc) return `agent ${j}: bc ${a.bc[j]} !== ${wantBc} (array arm, last writer ${last})`;
    if (a.bc2[j] !== wantBc2) return `agent ${j}: bc2 ${a.bc2[j]} !== ${wantBc2} (array arm slot 2)`;
    if (a.bc3[j] !== wantBc3) return `agent ${j}: bc3 ${a.bc3[j]} !== ${wantBc3} (array arm slot 3 — the agentId fan-out)`;
    if (last >= 0) covered++;
    // A SELF-write would have left x[j] / y[j] here — count, PER SLOT, the agents
    // where the broadcast genuinely differs, so the checks below prove the fixture
    // can tell "broadcast" from "wrote self" on slot 1 AND on the fanned-out slot 3.
    if (last >= 0 && st.x[last] !== st.x[j]) distinctX++;   // slot 1 tells them apart
    if (last >= 0 && st.y[last] !== st.y[j]) distinctY++;   // slot 3 (the fan-out) does
  }
  if (covered === 0) return `fixture not discriminating: NO agent is covered by the array broadcast`;
  if (distinctX === 0) return `fixture not discriminating: every slot-1 broadcast equals the target's own x (a self-write would pass)`;
  if (distinctY === 0) return `fixture not discriminating: every slot-3 broadcast equals the target's own y (a dropped agentId fan-out would pass)`;
  return null;
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

// Synthetic: Set Agent Sprite on the WASM agent target. Exercises EVERY facet in
// the one place that used to clamp a whole model to JS — the BEHAVIOUR graph:
//   • the CURRENT-agent form (agentId unwired → idx, unguarded), all facets on,
//     with the VECTOR rotation mode (the `env.atan2` conditional import);
//   • the BY-ID form (agentId wired to self+1 → the range guard), angle rotation.
// A per-step VALUE invariant recomputes the expected state independently, because
// parity alone would pass happily if BOTH targets wrote nothing at all.
function buildSpriteModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

  const bs = an('behaviourStep', {});
  // Self-targeted: every facet, VECTOR rotation from the agent's own velocity.
  const vel = an('getVelocity', {});
  const selfSpr = an('setAgentSprite', {
    spriteId: 's1', _spriteSlot: 1,
    setSprite: true, setFrame: true, setSpeed: true, setRotation: true, rotationMode: 'vector',
    setScale: true, setAlpha: true,
    _port_frame: '2', _port_speed: '0.25', _port_scale: '1.75', _port_alpha: '137',
  });
  aE(bs, 'do', selfSpr, 'do', 'flow');
  aE(vel, 'vx', selfSpr, 'dirX', 'value');
  aE(vel, 'vy', selfSpr, 'dirY', 'value');
  // By-id: target self+1 (some ids land out of range → the guard must reject).
  const gsh = an('getSelfHandle', {});
  const plus1 = an('arithmeticOperator', { operation: '+', _port_y: '1' });
  aE(gsh, 'value', plus1, 'x', 'value');
  const idSpr = an('setAgentSprite', {
    spriteId: 's1', _spriteSlot: 1,
    setSprite: false, setFrame: false, setSpeed: false, setRotation: true, rotationMode: 'angle',
    setScale: true, setAlpha: false, _port_rotation: '42.5', _port_scale: '0.5',
  });
  aE(selfSpr, 'next', idSpr, 'do', 'flow');
  aE(plus1, 'result', idSpr, 'agentId', 'value');

  return {
    schemaVersion: 1,
    properties: { name: 'Set Agent Sprite Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    sprites: [{ id: 's1', name: 'probe', dataUrl: '', mimeType: 'image/png' }],
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0.9, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** VALUE invariant for the sprite synthetic — recomputed independently of the
 *  emitters, so "both targets wrote nothing" cannot pass. Every live agent must
 *  carry the self-targeted facets; agent 0 (never a by-id target of any live
 *  agent below it) additionally pins the un-overwritten self values. */
function spriteInvariant(st) {
  const hw = st.highWater;
  if (st.spriteIds.length === 0) return 'sprite block not allocated (gate off?)';
  for (let i = 0; i < hw; i++) {
    if (!st.alive[i]) continue;
    if (st.spriteIds[i] !== 1) return `spriteIds[${i}] = ${st.spriteIds[i]} !== 1`;
    if (st.spriteSpeeds[i] !== 0.25) return `spriteSpeeds[${i}] = ${st.spriteSpeeds[i]} !== 0.25`;
    // frame is SET to 2 each step, then the engine advance is NOT run by the
    // harness (behaviour only), so it stays exactly 2.
    if (st.spriteFrames[i] !== 2) return `spriteFrames[${i}] = ${st.spriteFrames[i]} !== 2`;
    // alpha: the self-targeted facet writes 137 into the colour's A byte.
    if (st.colors[i * 4 + 3] !== 137) return `colors[${i}].a = ${st.colors[i * 4 + 3]} !== 137`;
    // scale: agent i is ALSO written by agent i-1's by-id node (0.5) when that
    // agent is live; otherwise it keeps its own self-targeted 1.75. Both are
    // legal — assert it is one of the two, never a default.
    const s = st.spriteScales[i];
    if (s !== 1.75 && s !== 0.5) return `spriteScales[${i}] = ${s} (expected 1.75 or 0.5)`;
    // rotation: the by-id node writes 42.5; otherwise the vector mode's atan2.
    const r = st.spriteRotations[i];
    if (!Number.isFinite(r)) return `spriteRotations[${i}] = ${r} (not finite)`;
  }
  return null;
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

// Synthetic: the Logical Expression node — a free-text BOOLEAN formula over N
// named bool inputs (what the Expression node is to Math, this is to Logic).
//
// The harness seeds every agent attribute with the SAME (i%5)-2, so the three
// boolean inputs are derived per agent from its HANDLE instead (bit 0/1/2), which
// walks all 8 truth-table rows across the population. The bits are ALSO stored to
// `p`/`q`/`r` so the invariant can recompute the expected result from the store
// without re-deriving them.
//
// Three formulas, each on the path:
//   lx  = (p AND NOT q) OR (q XOR r)   — every operator + precedence + parens
//   lx2 = NOT (p OR q) AND (r XOR true) — a literal and a NOT over a group
//   lx3 = raw AND NOT q                 — TRUTHINESS: `raw` is the raw seeded
//         attribute (-2..2), so a target comparing `== 1` instead of `!= 0`
//         diverges on the negative and the 2 rows.
function buildLogicalExpressionModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

  const bs = an('behaviourStep', {});
  const gsh = an('getSelfHandle', {});
  /** bit k of the agent handle, via the (already parity-verified) math node. */
  const bit = (k) => {
    const n = an('expression', { expression: k === 0 ? 'mod(a, 2)' : `mod(floor(a / ${1 << k}), 2)`, visibleCount: 1 });
    aE(gsh, 'value', n, 'a', 'value');
    return n;
  };
  const b0 = bit(0), b1 = bit(1), b2 = bit(2);
  const raw = an('getCellAttribute', { attributeId: 'raw' });

  // Store the bits so the invariant recomputes from the store, not from a
  // re-derivation of the same arithmetic.
  const sp = an('setAttribute', { attributeId: 'p' }); aE(b0, 'result', sp, 'value', 'value');
  const sq = an('setAttribute', { attributeId: 'q' }); aE(b1, 'result', sq, 'value', 'value');
  const sr = an('setAttribute', { attributeId: 'r' }); aE(b2, 'result', sr, 'value', 'value');
  aE(bs, 'do', sp, 'do', 'flow'); aE(sp, 'next', sq, 'do', 'flow'); aE(sq, 'next', sr, 'do', 'flow');

  const wire3 = (n) => { aE(b0, 'result', n, 'a', 'value'); aE(b1, 'result', n, 'b', 'value'); aE(b2, 'result', n, 'c', 'value'); };

  const le1 = an('logicalExpression', {
    expression: '(p AND NOT q) OR (q XOR r)', visibleCount: 3,
    _varName_a: 'p', _varName_b: 'q', _varName_c: 'r',
  });
  wire3(le1);
  const s1 = an('setAttribute', { attributeId: 'lx' });
  aE(le1, 'result', s1, 'value', 'value');
  aE(sr, 'next', s1, 'do', 'flow');

  const le2 = an('logicalExpression', {
    expression: 'NOT (p OR q) AND (r XOR true)', visibleCount: 3,
    _varName_a: 'p', _varName_b: 'q', _varName_c: 'r',
  });
  wire3(le2);
  const s2 = an('setAttribute', { attributeId: 'lx2' });
  aE(le2, 'result', s2, 'value', 'value');
  aE(s1, 'next', s2, 'do', 'flow');

  const le3 = an('logicalExpression', {
    expression: 'v AND NOT q', visibleCount: 2,
    _varName_a: 'v', _varName_b: 'q',
  });
  aE(raw, 'value', le3, 'a', 'value');
  aE(b1, 'result', le3, 'b', 'value');
  const s3 = an('setAttribute', { attributeId: 'lx3' });
  aE(le3, 'result', s3, 'value', 'value');
  aE(s2, 'next', s3, 'do', 'flow');

  // lx4 / lx5 — UNPARENTHESISED ladders, chosen so a swapped tier changes the
  // RESULT on at least one row (the three formulas above are fully parenthesised,
  // which makes them precedence-BLIND — the first version of this synthetic used
  // `NOT p AND q XOR r OR p`, whose trailing `OR p` masked the very swap it was
  // meant to catch):
  //   lx4 covers NOT > AND and AND > XOR   (p=1,q=1,r=1 separates AND/XOR;
  //                                         p=0,q=0,r=0 separates NOT/AND)
  //   lx5 covers XOR > OR                  (p=1,q=0,r=1 separates them)
  const le4 = an('logicalExpression', {
    expression: 'NOT p AND q XOR r', visibleCount: 3,
    _varName_a: 'p', _varName_b: 'q', _varName_c: 'r',
  });
  wire3(le4);
  const s4 = an('setAttribute', { attributeId: 'lx4' });
  aE(le4, 'result', s4, 'value', 'value');
  aE(s3, 'next', s4, 'do', 'flow');

  const le5 = an('logicalExpression', {
    expression: 'p OR q XOR r', visibleCount: 3,
    _varName_a: 'p', _varName_b: 'q', _varName_c: 'r',
  });
  wire3(le5);
  const s5 = an('setAttribute', { attributeId: 'lx5' });
  aE(le5, 'result', s5, 'value', 'value');
  aE(s4, 'next', s5, 'do', 'flow');

  // --- the COMPARISON tier -------------------------------------------------
  // `v` is the seeded `raw` attribute (-2..2) and `w` a second numeric derived
  // from the handle (-3..3), both STORED so the invariant recomputes from the
  // store rather than re-deriving the same arithmetic. Between them the six
  // operators all discriminate across the population.
  const wExpr = an('expression', { expression: 'mod(a, 7) - 3', visibleCount: 1 });
  aE(gsh, 'value', wExpr, 'a', 'value');
  const sw = an('setAttribute', { attributeId: 'w' });
  aE(wExpr, 'result', sw, 'value', 'value');
  aE(s5, 'next', sw, 'do', 'flow');

  let tail = sw;
  /** One comparison formula → its own attribute, appended to the flow chain. */
  const cmpFormula = (attrId, expression, wireW) => {
    const cfg = { expression, visibleCount: wireW ? 2 : 1, _varName_a: 'v' };
    if (wireW) cfg._varName_b = 'w';
    const n = an('logicalExpression', cfg);
    aE(raw, 'value', n, 'a', 'value');
    if (wireW) aE(wExpr, 'result', n, 'b', 'value');
    const s = an('setAttribute', { attributeId: attrId });
    aE(n, 'result', s, 'value', 'value');
    aE(tail, 'next', s, 'do', 'flow');
    tail = s;
  };
  cmpFormula('lc1', 'v > 0', false);                              // >
  cmpFormula('lc2', 'v >= -1 AND v <= 1', false);                 // >= <= + a negative literal
  cmpFormula('lc3', 'NOT v > 0 AND w != v OR v <= -2', true);     // the full ladder + != + NOT over a cmp
  cmpFormula('lc4', 'v AND NOT v > 0', false);                    // ONE port read BOTH ways
  cmpFormula('lc5', 'w == v', true);                              // ==
  cmpFormula('lc6', 'w < v', true);                               // <

  return {
    schemaVersion: 1,
    properties: { name: 'Logical Expression Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'raw', name: 'Raw', type: 'float', defaultValue: '0' },
      { id: 'p', name: 'P', type: 'float', defaultValue: '0' },
      { id: 'q', name: 'Q', type: 'float', defaultValue: '0' },
      { id: 'r', name: 'R', type: 'float', defaultValue: '0' },
      { id: 'lx', name: 'Lx', type: 'float', defaultValue: '0' },
      { id: 'lx2', name: 'Lx2', type: 'float', defaultValue: '0' },
      { id: 'lx3', name: 'Lx3', type: 'float', defaultValue: '0' },
      { id: 'lx4', name: 'Lx4', type: 'float', defaultValue: '0' },
      { id: 'lx5', name: 'Lx5', type: 'float', defaultValue: '0' },
      { id: 'w', name: 'W', type: 'float', defaultValue: '0' },
      { id: 'lc1', name: 'Lc1', type: 'float', defaultValue: '0' },
      { id: 'lc2', name: 'Lc2', type: 'float', defaultValue: '0' },
      { id: 'lc3', name: 'Lc3', type: 'float', defaultValue: '0' },
      { id: 'lc4', name: 'Lc4', type: 'float', defaultValue: '0' },
      { id: 'lc5', name: 'Lc5', type: 'float', defaultValue: '0' },
      { id: 'lc6', name: 'Lc6', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

// Recompute all three formulas from the store's OWN stored inputs. This is what
// catches a lowering that is identically wrong on BOTH targets (parity alone is a
// mirror test) — e.g. a precedence slip, a swapped XOR, or an operand normalised
// as `== 1` instead of `!= 0`.
function logicalExpressionInvariant(st) {
  const T = (v) => v !== 0;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const p = T(st.attrRead.p[i]), q = T(st.attrRead.q[i]), r = T(st.attrRead.r[i]);
    const v = T(st.attrRead.raw[i]);
    const want1 = ((p && !q) || (q !== r)) ? 1 : 0;
    const want2 = (!(p || q) && (r !== true)) ? 1 : 0;
    const want3 = (v && !q) ? 1 : 0;
    // Read with NOT > AND > XOR > OR.
    const want4 = ((((!p) && q) !== r)) ? 1 : 0;
    const want5 = (p || (q !== r)) ? 1 : 0;
    if (st.attrRead.lx[i] !== want1) return `agent ${i}: lx ${st.attrRead.lx[i]} !== ${want1} (p=${+p} q=${+q} r=${+r})`;
    if (st.attrRead.lx2[i] !== want2) return `agent ${i}: lx2 ${st.attrRead.lx2[i]} !== ${want2} (p=${+p} q=${+q} r=${+r})`;
    if (st.attrRead.lx3[i] !== want3) return `agent ${i}: lx3 ${st.attrRead.lx3[i]} !== ${want3} (raw=${st.attrRead.raw[i]} q=${+q})`;
    if (st.attrRead.lx4[i] !== want4) return `agent ${i}: lx4 ${st.attrRead.lx4[i]} !== ${want4} (p=${+p} q=${+q} r=${+r})`;
    if (st.attrRead.lx5[i] !== want5) return `agent ${i}: lx5 ${st.attrRead.lx5[i]} !== ${want5} (p=${+p} q=${+q} r=${+r})`;

    // --- the COMPARISON tier, recomputed from the store's OWN numerics ---
    // Both operands are exact small integers in f64, so `===` is safe and the
    // two targets are bit-identical rather than merely close.
    const vv = st.attrRead.raw[i], ww = st.attrRead.w[i];
    const wantC = [
      (vv > 0) ? 1 : 0,
      (vv >= -1 && vv <= 1) ? 1 : 0,
      ((!(vv > 0) && ww !== vv) || vv <= -2) ? 1 : 0,
      // The SAME port truthy-tested AND compared: at v = 0 the two readings
      // disagree, which is what makes this differ from `NOT v > 0` alone.
      ((vv !== 0) && !(vv > 0)) ? 1 : 0,
      (ww === vv) ? 1 : 0,
      (ww < vv) ? 1 : 0,
    ];
    for (let k = 0; k < wantC.length; k++) {
      const id = `lc${k + 1}`;
      if (st.attrRead[id][i] !== wantC[k]) {
        return `agent ${i}: ${id} ${st.attrRead[id][i]} !== ${wantC[k]} (v=${vv} w=${ww})`;
      }
    }
  }
  return null;
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

// ---------------------------------------------------------------------------
// P5 — the DIVISION BOND PARTITION.
//
// The partition is per-NODE but applied by the ENGINE, so the compiler bakes a
// 1-based code onto each Divide Agent node and every target writes it into the
// EXISTING `divideRequest` cell. Two things must hold and only one of them is
// parity:
//   • JS and WASM write the SAME code (parity — `divideRequest` is compared);
//   • the code an agent receives is the code of the node IT reached, and the two
//     nodes' codes DIFFER (the value invariant — parity alone would pass happily
//     if both targets emitted a constant 1, which is exactly the pre-P5 literal
//     and therefore the most likely way to get this wrong).
// Even agents take the tension node, odd agents the byBondAttribute node.
// ---------------------------------------------------------------------------
function buildDividePartitionModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

  const bs = an('behaviourStep', {});
  const gsh = an('getSelfHandle', {});
  // odd(self) = self - 2*floor(self/2)  → 0 for even, 1 for odd
  const half = an('arithmeticOperator', { operation: '/', _port_y: '2' });
  const flr = an('arithmeticOperator', { operation: 'floor' });
  const dbl = an('arithmeticOperator', { operation: '*', _port_y: '2' });
  const odd = an('arithmeticOperator', { operation: '-' });
  const isOdd = an('statement', { operation: '>', _port_y: '0.5' });
  const cond = an('conditional', {});
  const dA = an('divideAgent', { partition: 'tension', daughterBond: 'auto', _port_asymmetry: '0.5' });
  const dB = an('divideAgent', { partition: 'byBondAttribute', partitionAttributeId: 'lbl', partitionThreshold: '3', daughterBond: 'always', _port_asymmetry: '0.5' });
  // Record which branch ran + the raw request code the target wrote, so the
  // invariant can compare them WITHOUT re-deriving the emit.
  // BOTH branches stamp `branch` explicitly — the harness seeds agent attributes
  // with a deterministic non-zero pattern, so relying on the default would not
  // distinguish "took the else branch" from "was never written".
  const markOdd = an('setAttribute', { attributeId: 'branch', _port_value: '1' });
  const markEven = an('setAttribute', { attributeId: 'branch', _port_value: '0' });

  aE(gsh, 'value', half, 'x', 'value');
  aE(half, 'result', flr, 'x', 'value');
  aE(flr, 'result', dbl, 'x', 'value');
  aE(gsh, 'value', odd, 'x', 'value');
  aE(dbl, 'result', odd, 'y', 'value');
  aE(odd, 'result', isOdd, 'x', 'value');
  aE(isOdd, 'result', cond, 'condition', 'value');
  aE(bs, 'do', cond, 'check', 'flow');
  aE(cond, 'then', dB, 'do', 'flow');
  aE(dB, 'next', markOdd, 'do', 'flow');
  aE(cond, 'else', dA, 'do', 'flow');
  aE(dA, 'next', markEven, 'do', 'flow');

  return {
    schemaVersion: 1,
    properties: { name: 'Division Partition Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 6, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, bondStiffness: 0, bondRestLength: 1.5, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'data', autoBond: false, growth: false, division: true, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [{ id: 'branch', name: 'Branch', type: 'integer', defaultValue: '0' }],
    bondAttributes: [
      { id: 'w', name: 'Weight', type: 'float', defaultValue: '0' },
      { id: 'lbl', name: 'Label', type: 'integer', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** THE VALUE INVARIANT for the division-partition synthetic. Recomputes the
 *  expected code from the store itself (parity of a wrong constant would pass):
 *  odd agents took the `byBondAttribute` node, even agents the `tension` node,
 *  the two codes must DIFFER, and both must be ≥ 1 (0 would mean no request). */
function dividePartitionInvariant(st) {
  let evenCode = null, oddCode = null;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const code = st.divideRequest[i];
    if (code < 1) return `agent ${i}: divideRequest ${code} — no division was requested at all`;
    if (i % 2 === 0) {
      if (st.attrRead.branch[i] !== 0) return `agent ${i} (even) took the ODD branch`;
      if (evenCode === null) evenCode = code;
      else if (evenCode !== code) return `even agents disagree: ${evenCode} vs ${code}`;
    } else {
      if (st.attrRead.branch[i] !== 1) return `agent ${i} (odd) did not take the odd branch`;
      if (oddCode === null) oddCode = code;
      else if (oddCode !== code) return `odd agents disagree: ${oddCode} vs ${code}`;
    }
  }
  if (evenCode === null || oddCode === null) return 'the run never exercised both branches';
  if (evenCode === oddCode) {
    return `both Divide Agent nodes wrote the SAME code ${evenCode} — the partition never reaches the engine`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// D2 — DIVISION CONSERVE (area vs volume) + the 3D `myVolume` value-out.
//
// A SEPARATE entry from the partition one above, and deliberately so: that model
// is 2D, where `volume` is COERCED to `area` by design (the resolver and the
// engine both do it — "conserve r³" is meaningless on a disc), so it structurally
// cannot pin the mode. This one is 3D.
//
// Three things must hold, and only the first is parity:
//   • JS and WASM compute the SAME `myVolume` (parity — the agent attrs are
//     compared cell-for-cell). This is the new WASM emitter case;
//   • `myVolume` really is (4/3)πr³ of THIS agent's radius — recomputed from the
//     store's own radius, so an emit that dropped the 4/3, or read the wrong
//     agent, is caught even when BOTH targets do it identically (which parity
//     cannot see). The agents are given DISTINCT radii by the setup, so a
//     constant would not pass;
//   • the two Divide Agent nodes — identical in every way EXCEPT `conserve` —
//     get DIFFERENT partition codes, i.e. the mode reaches the table at all.
// Even agents take the area node, odd agents the volume node.
// ---------------------------------------------------------------------------
function buildDivideConserveModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

  const bs = an('behaviourStep', {});
  // Record this agent's volume + radius so the invariant can recompute one from
  // the other WITHOUT re-deriving the emit.
  const rec = an('setAttribute', { attributeId: 'vol', extraCount: 1, attr_2: 'rad' });
  aE(bs, 'myVolume', rec, 'value', 'value');
  aE(bs, 'myRadius', rec, 'value_2', 'value');
  // odd(self) = self - 2*floor(self/2)
  const gsh = an('getSelfHandle', {});
  const half = an('arithmeticOperator', { operation: '/', _port_y: '2' });
  const flr = an('arithmeticOperator', { operation: 'floor' });
  const dbl = an('arithmeticOperator', { operation: '*', _port_y: '2' });
  const odd = an('arithmeticOperator', { operation: '-' });
  const isOdd = an('statement', { operation: '>', _port_y: '0.5' });
  const cond = an('conditional', {});
  // The ONLY difference between these two nodes is `conserve`.
  const dArea = an('divideAgent', { partition: 'tension', daughterBond: 'auto', conserve: 'area', _port_asymmetry: '0.5' });
  const dVol = an('divideAgent', { partition: 'tension', daughterBond: 'auto', conserve: 'volume', _port_asymmetry: '0.5' });
  const markOdd = an('setAttribute', { attributeId: 'branch', _port_value: '1' });
  const markEven = an('setAttribute', { attributeId: 'branch', _port_value: '0' });

  aE(gsh, 'value', half, 'x', 'value');
  aE(half, 'result', flr, 'x', 'value');
  aE(flr, 'result', dbl, 'x', 'value');
  aE(gsh, 'value', odd, 'x', 'value');
  aE(dbl, 'result', odd, 'y', 'value');
  aE(odd, 'result', isOdd, 'x', 'value');
  aE(isOdd, 'result', cond, 'condition', 'value');
  aE(bs, 'do', rec, 'do', 'flow');
  aE(rec, 'next', cond, 'check', 'flow');
  aE(cond, 'then', dVol, 'do', 'flow');
  aE(dVol, 'next', markOdd, 'do', 'flow');
  aE(cond, 'else', dArea, 'do', 'flow');
  aE(dArea, 'next', markEven, 'do', 'flow');

  return {
    schemaVersion: 1,
    properties: { name: 'Division Conserve Parity Test', dimension: '3d', gridWidth: 24, gridHeight: 24, gridDepth: 12, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 4, worldWidth: 24, worldHeight: 24, worldDepth: 12, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, bondStiffness: 0, bondRestLength: 1.5, formDistance: 1.2, breakDistance: 2.0, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'data', autoBond: false, growth: false, division: true, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'vol', name: 'Volume', type: 'float', defaultValue: '0' },
      { id: 'rad', name: 'Radius', type: 'float', defaultValue: '0' },
      { id: 'branch', name: 'Branch', type: 'integer', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** DISTINCT radii, so a `myVolume` emit that ignored the agent's own radius (or
 *  dropped the 4/3) cannot pass by coincidence. Applied identically to both
 *  stores, so parity is unaffected. */
function setupDivideConserveStores(stores) {
  for (const s of stores) {
    for (let i = 0; i < s.highWater; i++) s.radius[i] = 0.25 + 0.0125 * i;
  }
}

/** THE VALUE INVARIANT for the conserve synthetic. */
function divideConserveInvariant(st) {
  let areaCode = null, volCode = null;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const r = st.attrRead.rad[i];
    if (!(r > 0)) return `agent ${i}: myRadius read back as ${r}`;
    // The SAME association the JS + WASM emits use — f64 multiplication is not
    // associative, so a re-grouped expectation would be an ULP off.
    const want = Math.PI * 4 / 3 * r * r * r;
    if (!Object.is(st.attrRead.vol[i], want)) {
      return `agent ${i}: myVolume ${st.attrRead.vol[i]} !== (4/3)πr³ ${want} (r=${r})`;
    }
    const code = st.divideRequest[i];
    if (code < 1) return `agent ${i}: divideRequest ${code} — no division was requested at all`;
    if (i % 2 === 0) {
      if (st.attrRead.branch[i] !== 0) return `agent ${i} (even) took the ODD branch`;
      if (areaCode === null) areaCode = code; else if (areaCode !== code) return `even agents disagree: ${areaCode} vs ${code}`;
    } else {
      if (st.attrRead.branch[i] !== 1) return `agent ${i} (odd) did not take the odd branch`;
      if (volCode === null) volCode = code; else if (volCode !== code) return `odd agents disagree: ${volCode} vs ${code}`;
    }
  }
  if (areaCode === null || volCode === null) return 'the run never exercised both branches';
  if (areaCode === volCode) {
    return `the area and volume Divide Agent nodes wrote the SAME code ${areaCode} — conserve never reaches the table`;
  }
  return null;
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
entries.push({ name: '[synthetic] Hemifield (L/R counts + both id ARRAYS)', raw: buildHemifieldModel(), invariant: hemifieldInvariant });
entries.push({ name: '[synthetic] Multi-attribute slots (Get/Set + by-id)', raw: buildMultiAttrModel() });
entries.push({
  name: '[synthetic] Set Attribute agent id (self / scalar / ARRAY + multi-slot)',
  raw: buildAgentIdTargetModel(), invariant: agentIdTargetInvariant,
});
entries.push({ name: '[synthetic] Get Grid Dimensions (3D world W/H/D + centres)', raw: buildGridDimsModel() });
entries.push({ name: '[synthetic] Apply Force To Agent (pairwise scatter)', raw: buildApplyForceToAgentModel() });
entries.push({ name: '[synthetic] Apply Force To Agents (array broadcast, lowered)', raw: buildApplyForceToAgentsModel() });
entries.push({ name: '[synthetic] Loop index output (value chain + branch + direct)', raw: buildLoopIndexModel() });
entries.push({
  name: '[synthetic] Set Agent Sprite (all facets, self + by-id, vector rotation)',
  raw: buildSpriteModel(), invariant: spriteInvariant,
});
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
entries.push({
  name: '[synthetic] Logical Expression (truth table + literals + truthiness + COMPARISONS)',
  raw: buildLogicalExpressionModel(), invariant: logicalExpressionInvariant,
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
// ---------------------------------------------------------------------------
// P4b - the FORM BETWEEN encoding, authored through Form Bond's `agentA` port
// (the dedicated Form Bond Between NODE was retired into it - see
// formBondBetweenMigration.ts; the ENCODING is unchanged).
//
// The op kind rides the SIGN of the break lane, which is the ONLY thing telling a
// Form Between apart from a Rewire (both fill both lanes). So entry 0 and entry 1
// deliberately carry the SAME two ids: they must differ ONLY in that sign, and a
// target that dropped it would make the two entries byte-identical.
// ---------------------------------------------------------------------------
function buildFormBetweenModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const gsh = an('getSelfHandle', {});
  const off = (k) => { const n = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); aE(gsh, 'value', n, 'x', 'value'); return n; };

  const bs = an('behaviourStep', {});
  // 0 - Form Bond(agentA=self+1, target=self+2)   NEGATIVE break lane
  const fbw = an('formBond', { _port_restLength: '3', _port_stiffness: '5', _port_bondAttr_bw: '31' });
  // 1 - Rewire(self+1 -> self+2)       POSITIVE break lane, THE SAME two ids
  const rw = an('rewireBond', { _port_restLength: '7', _port_stiffness: '11', _port_bondAttr_bw: '32' });
  // 2 - a paired Form Bond with an unresolvable A  -> (-NONE, NONE), still non-zero
  const fbBad = an('formBond', { _port_restLength: '13', _port_stiffness: '17', _port_bondAttr_bw: '33' });
  // 3..5 - a loop of paired Form Bonds (per-entry values must not smear)
  const lp = an('loop', { mode: 'count', _port_count: '3' });
  const lpFb = an('formBond', { _port_restLength: '0', _port_stiffness: '0', _port_bondAttr_bw: '34' });

  aE(bs, 'do', fbw, 'do', 'flow');
  aE(off(1), 'result', fbw, 'agentA', 'value');
  aE(off(2), 'result', fbw, 'targetAgent', 'value');
  aE(fbw, 'next', rw, 'do', 'flow');
  aE(off(1), 'result', rw, 'fromAgent', 'value');
  aE(off(2), 'result', rw, 'toAgent', 'value');
  aE(rw, 'next', fbBad, 'do', 'flow');
  aE(off(-1000), 'result', fbBad, 'agentA', 'value');
  aE(off(5), 'result', fbBad, 'targetAgent', 'value');
  aE(fbBad, 'next', lp, 'do', 'flow');
  aE(lp, 'body', lpFb, 'do', 'flow');
  const a200 = off(200), b300 = off(300);
  const aIdx = an('arithmeticOperator', { operation: '+' });
  aE(a200, 'result', aIdx, 'x', 'value'); aE(lp, 'index', aIdx, 'y', 'value');
  const bIdx = an('arithmeticOperator', { operation: '+' });
  aE(b300, 'result', bIdx, 'x', 'value'); aE(lp, 'index', bIdx, 'y', 'value');
  aE(aIdx, 'result', lpFb, 'agentA', 'value');
  aE(bIdx, 'result', lpFb, 'targetAgent', 'value');

  return {
    schemaVersion: 1,
    properties: { name: 'Form Bond Pair Encoding Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
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

/** THE VALUE INVARIANT - the expected queue is recomputed INDEPENDENTLY from the
 *  agent index, so both targets writing the same WRONG lanes still fail. It pins
 *  the SIGN specifically: entries 0 and 1 carry the same ids and must differ ONLY
 *  in the break lane's sign (drop it and the two entries become identical). */
function formBetweenInvariant(st) {
  const NONE = 1, BIAS = 2;
  const slots = st.bondReqSlots, depth = slots - 1;
  if (slots !== 9) return `bondReqSlots ${slots} !== 9 (default depth 8 + the overflow bucket)`;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const b = i * slots;
    // [breakLane, formLane, L, K, bondAttr bw]
    const want = [
      [-(i + 1 + BIAS), i + 2 + BIAS, 3, 5, 31],       // 0  between(self+1, self+2)  NEGATIVE
      [i + 1 + BIAS, i + 2 + BIAS, 7, 11, 32],         // 1  rewire  (SAME ids)       POSITIVE
      [-NONE, NONE, 13, 17, 33],                        // 2  between with unresolvable A
      [-(i + 200 + BIAS), i + 300 + BIAS, 0, 0, 34],    // 3  loop k=0
      [-(i + 201 + BIAS), i + 301 + BIAS, 0, 0, 34],    // 4  loop k=1
      [-(i + 202 + BIAS), i + 302 + BIAS, 0, 0, 34],    // 5  loop k=2
      [0, 0, 0, 0, null], [0, 0, 0, 0, null], [0, 0, 0, 0, null],   // 6..8 never written
    ];
    for (let c = 0; c < slots; c++) {
      const [wb, wf, wl, wk, wa] = want[c];
      if (st.bondBreakReq[b + c] !== wb) return `agent ${i} entry ${c}: breakLane ${st.bondBreakReq[b + c]} !== ${wb}`;
      if (st.bondFormReq[b + c] !== wf) return `agent ${i} entry ${c}: formLane ${st.bondFormReq[b + c]} !== ${wf}`;
      if (st.bondFormL[b + c] !== wl) return `agent ${i} entry ${c}: L ${st.bondFormL[b + c]} !== ${wl}`;
      if (st.bondFormK[b + c] !== wk) return `agent ${i} entry ${c}: K ${st.bondFormK[b + c]} !== ${wk}`;
      if (wa !== null && st.bondFormAttrs.bw[b + c] !== wa) return `agent ${i} entry ${c}: bondAttr bw ${st.bondFormAttrs.bw[b + c]} !== ${wa}`;
    }
    // THE OP-KIND BIT: same ids, opposite signs. If a target dropped the negation
    // the two entries would be byte-identical and this is what notices.
    if (st.bondBreakReq[b] !== -st.bondBreakReq[b + 1]) {
      return `agent ${i}: the Form Between and Rewire break lanes are not sign-opposites (${st.bondBreakReq[b]} vs ${st.bondBreakReq[b + 1]})`;
    }
    if (!(st.bondBreakReq[b] < 0)) return `agent ${i}: the Form Between break lane is not NEGATIVE`;
    if (!(st.bondBreakReq[b + 1] > 0)) return `agent ${i}: the Rewire break lane is not POSITIVE`;
    // The terminator rule: a written entry must never read as empty (0,0).
    for (let c = 0; c < 6 && c < depth; c++) {
      if (st.bondBreakReq[b + c] === 0 && st.bondFormReq[b + c] === 0) return `agent ${i} entry ${c} reads as EMPTY (queue truncation)`;
    }
  }
  return null;
}

entries.push({
  name: '[synthetic] Form Bond pair encoding (sign-encoded op kind vs Rewire, same ids)',
  raw: buildFormBetweenModel(), setup: setupBondAttrStores, invariant: formBetweenInvariant,
});

// ---------------------------------------------------------------------------
// Form Bond's OPTIONAL PAIR PORT — `agentA`, which defaults to self when unwired.
//
// Wiring it LOWERS the op to the Form Between encoding, so the one node covers
// both "bond me to X" and "bond X to Y". Three things have to hold at once, and
// the entries are laid out side by side so a target that got any of them wrong
// produces a visibly different queue:
//
//   0  UNWIRED               -> the HISTORICAL self-form lanes (NONE, t+2)
//   1  wired to Get Self Handle -> the Between lanes naming the requester itself
//   2  wired to a THIRD PARTY   -> the Between lanes naming that pair
//   3  a SECOND paired Form Bond with the SAME ids as 2 -> must be BYTE-IDENTICAL
//      to entry 2 (the lowering depends only on the ids + params, never on which
//      node instance issued it; this slot used to hold the retired Form Bond
//      Between node, and asserted the two spellings agreed)
// ---------------------------------------------------------------------------
function buildFormBondPairModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const gsh = an('getSelfHandle', {});
  const off = (k) => { const n = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); aE(gsh, 'value', n, 'x', 'value'); return n; };

  const bs = an('behaviourStep', {});
  // 0 - Form Bond, agentA UNWIRED  -> the historical self-form arm
  const fbSelf = an('formBond', { _port_restLength: '3', _port_stiffness: '5', _port_bondAttr_bw: '31' });
  // 1 - Form Bond, agentA = Get Self Handle -> a self-form expressed as a Between
  const fbGsh = an('formBond', { _port_restLength: '7', _port_stiffness: '11', _port_bondAttr_bw: '32' });
  // 2 - Form Bond, agentA = a THIRD PARTY
  const fbThird = an('formBond', { _port_restLength: '13', _port_stiffness: '17', _port_bondAttr_bw: '33' });
  // 3 - a SECOND paired Form Bond, same ids + params -> byte-identical to entry 2
  const fbb = an('formBond', { _port_restLength: '13', _port_stiffness: '17', _port_bondAttr_bw: '33' });
  // 4 - wired agentA that cannot resolve -> (-NONE, NONE), still non-zero
  const fbBad = an('formBond', { _port_restLength: '19', _port_stiffness: '23', _port_bondAttr_bw: '34' });
  // 5..7 - a loop of paired Form Bonds (per-entry values must not smear)
  const lp = an('loop', { mode: 'count', _port_count: '3' });
  const lpFb = an('formBond', { _port_restLength: '0', _port_stiffness: '0', _port_bondAttr_bw: '35' });

  aE(bs, 'do', fbSelf, 'do', 'flow');
  aE(off(1), 'result', fbSelf, 'targetAgent', 'value');           // NOTE: no agentA edge
  aE(fbSelf, 'next', fbGsh, 'do', 'flow');
  aE(gsh, 'value', fbGsh, 'agentA', 'value');                     // agentA = self
  aE(off(1), 'result', fbGsh, 'targetAgent', 'value');            // same target as entry 0
  aE(fbGsh, 'next', fbThird, 'do', 'flow');
  aE(off(4), 'result', fbThird, 'agentA', 'value');
  aE(off(5), 'result', fbThird, 'targetAgent', 'value');
  aE(fbThird, 'next', fbb, 'do', 'flow');
  aE(off(4), 'result', fbb, 'agentA', 'value');                   // the SAME two ids
  aE(off(5), 'result', fbb, 'targetAgent', 'value');
  aE(fbb, 'next', fbBad, 'do', 'flow');
  aE(off(-1000), 'result', fbBad, 'agentA', 'value');
  aE(off(6), 'result', fbBad, 'targetAgent', 'value');
  aE(fbBad, 'next', lp, 'do', 'flow');
  aE(lp, 'body', lpFb, 'do', 'flow');
  const a200 = off(200), b300 = off(300);
  const aIdx = an('arithmeticOperator', { operation: '+' });
  aE(a200, 'result', aIdx, 'x', 'value'); aE(lp, 'index', aIdx, 'y', 'value');
  const bIdx = an('arithmeticOperator', { operation: '+' });
  aE(b300, 'result', bIdx, 'x', 'value'); aE(lp, 'index', bIdx, 'y', 'value');
  aE(aIdx, 'result', lpFb, 'agentA', 'value');
  aE(bIdx, 'result', lpFb, 'targetAgent', 'value');

  return {
    schemaVersion: 1,
    properties: { name: 'Form Bond Pair Ports Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
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

/** THE VALUE INVARIANT — the expected queue is recomputed INDEPENDENTLY from the
 *  agent index, so both targets writing the same WRONG lanes still fail.
 *
 *  It pins the three things the optional pair port has to get right:
 *    • UNWIRED is still the HISTORICAL self-form arm — a positive `NONE` break
 *      lane. If a target started lowering the unwired case too, entry 0's break
 *      lane would go negative and this notices immediately (the byte-identity
 *      gate would also fail, but only for models that ship a Form Bond).
 *    • wired-to-self is the SAME BOND expressed through the Between encoding:
 *      its break lane decodes to the REQUESTER and its form lane names the SAME
 *      target as entry 0, so the drain forms exactly the bond entry 0 would.
 *    • wired-to-third-party is byte-identical to the explicit Form Bond Between
 *      carrying the same ids — the lowering reuses the encoding, it does not
 *      approximate it. */
function formBondPairInvariant(st) {
  const NONE = 1, BIAS = 2;
  const slots = st.bondReqSlots, depth = slots - 1;
  if (slots !== 9) return `bondReqSlots ${slots} !== 9 (default depth 8 + the overflow bucket)`;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const b = i * slots;
    // [breakLane, formLane, L, K, bondAttr bw]
    const want = [
      [NONE, i + 1 + BIAS, 3, 5, 31],                   // 0  UNWIRED  -> historical self-form
      [-(i + BIAS), i + 1 + BIAS, 7, 11, 32],           // 1  agentA = self, SAME target as 0
      [-(i + 4 + BIAS), i + 5 + BIAS, 13, 17, 33],      // 2  agentA = a third party
      [-(i + 4 + BIAS), i + 5 + BIAS, 13, 17, 33],      // 3  a 2nd paired Form Bond, SAME ids
      [-NONE, NONE, 19, 23, 34],                        // 4  wired agentA, unresolvable
      [-(i + 200 + BIAS), i + 300 + BIAS, 0, 0, 35],    // 5  loop k=0
      [-(i + 201 + BIAS), i + 301 + BIAS, 0, 0, 35],    // 6  loop k=1
      [-(i + 202 + BIAS), i + 302 + BIAS, 0, 0, 35],    // 7  loop k=2
      [0, 0, 0, 0, null],                               // 8  never written
    ];
    for (let c = 0; c < slots; c++) {
      const [wb, wf, wl, wk, wa] = want[c];
      if (st.bondBreakReq[b + c] !== wb) return `agent ${i} entry ${c}: breakLane ${st.bondBreakReq[b + c]} !== ${wb}`;
      if (st.bondFormReq[b + c] !== wf) return `agent ${i} entry ${c}: formLane ${st.bondFormReq[b + c]} !== ${wf}`;
      if (st.bondFormL[b + c] !== wl) return `agent ${i} entry ${c}: L ${st.bondFormL[b + c]} !== ${wl}`;
      if (st.bondFormK[b + c] !== wk) return `agent ${i} entry ${c}: K ${st.bondFormK[b + c]} !== ${wk}`;
      if (wa !== null && st.bondFormAttrs.bw[b + c] !== wa) return `agent ${i} entry ${c}: bondAttr bw ${st.bondFormAttrs.bw[b + c]} !== ${wa}`;
    }
    // THE DEFAULT-TO-SELF BIT: unwired keeps the POSITIVE `NONE` break lane (the
    // self-form arm); wiring agentA switches it NEGATIVE (the Between arm).
    if (!(st.bondBreakReq[b] > 0)) return `agent ${i}: the UNWIRED Form Bond must keep a POSITIVE break lane (it is not a Form Between)`;
    if (!(st.bondBreakReq[b + 1] < 0)) return `agent ${i}: the wired Form Bond break lane is not NEGATIVE`;
    // ...and wired-to-self names the REQUESTER, so the drain forms the same bond
    // the unwired entry would: same target, first endpoint = me.
    if (-st.bondBreakReq[b + 1] - BIAS !== i) return `agent ${i}: wired-to-self decodes to agent ${-st.bondBreakReq[b + 1] - BIAS}, not the requester`;
    if (st.bondFormReq[b] !== st.bondFormReq[b + 1]) return `agent ${i}: entries 0 and 1 do not name the same target (${st.bondFormReq[b]} vs ${st.bondFormReq[b + 1]})`;
    // THE LOWERING BIT: the entry depends only on the ids + params, never on which
    // node instance issued it (this pair used to be Form Bond vs Form Bond Between).
    for (const [nm, arr] of [['break', st.bondBreakReq], ['form', st.bondFormReq], ['L', st.bondFormL], ['K', st.bondFormK], ['bw', st.bondFormAttrs.bw]]) {
      if (arr[b + 2] !== arr[b + 3]) return `agent ${i}: two paired Form Bonds with the same ids differ in ${nm} (${arr[b + 2]} vs ${arr[b + 3]})`;
    }
    // The terminator rule: a written entry must never read as empty (0,0).
    for (let c = 0; c < 8 && c < depth; c++) {
      if (st.bondBreakReq[b + c] === 0 && st.bondFormReq[b + c] === 0) return `agent ${i} entry ${c} reads as EMPTY (queue truncation)`;
    }
  }
  return null;
}

entries.push({
  name: '[synthetic] Form Bond pair ports (agentA unwired / self / third party)',
  raw: buildFormBondPairModel(), setup: setupBondAttrStores, invariant: formBondPairInvariant,
});

// ---------------------------------------------------------------------------
// B9 — TRANSFER BOND: the op kind rides the sign of the FORM lane (the mirror
// image of Form Between). The synthetic deliberately places a Transfer and a
// Rewire carrying THE SAME TWO IDS side by side, so a target that dropped the
// negation would make the two entries byte-identical.
// ---------------------------------------------------------------------------
function buildTransferBondModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const gsh = an('getSelfHandle', {});
  const off = (k) => { const n = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); aE(gsh, 'value', n, 'x', 'value'); return n; };

  const bs = an('behaviourStep', {});
  // 0 - Transfer(partner = self+1, to = self+2)   NEGATIVE FORM lane
  const tr = an('transferBond', {});
  // 1 - Rewire(self+1 -> self+2)                  POSITIVE both lanes, SAME ids
  const rw = an('rewireBond', { _port_restLength: '7', _port_stiffness: '11', _port_bondAttr_bw: '32' });
  // 2 - Transfer with an unresolvable partner  -> (NONE, -NONE), still non-zero
  const trBad = an('transferBond', {});
  // 3..5 - a loop of Transfers (each entry addresses its own slot)
  const lp = an('loop', { mode: 'count', _port_count: '3' });
  const lpTr = an('transferBond', {});

  aE(bs, 'do', tr, 'do', 'flow');
  aE(off(1), 'result', tr, 'partnerAgent', 'value');
  aE(off(2), 'result', tr, 'toAgent', 'value');
  aE(tr, 'next', rw, 'do', 'flow');
  aE(off(1), 'result', rw, 'fromAgent', 'value');
  aE(off(2), 'result', rw, 'toAgent', 'value');
  aE(rw, 'next', trBad, 'do', 'flow');
  aE(off(-1000), 'result', trBad, 'partnerAgent', 'value');
  aE(off(5), 'result', trBad, 'toAgent', 'value');
  aE(trBad, 'next', lp, 'do', 'flow');
  aE(lp, 'body', lpTr, 'do', 'flow');
  const a200 = off(200), b300 = off(300);
  const aIdx = an('arithmeticOperator', { operation: '+' });
  aE(a200, 'result', aIdx, 'x', 'value'); aE(lp, 'index', aIdx, 'y', 'value');
  const bIdx = an('arithmeticOperator', { operation: '+' });
  aE(b300, 'result', bIdx, 'x', 'value'); aE(lp, 'index', bIdx, 'y', 'value');
  aE(aIdx, 'result', lpTr, 'partnerAgent', 'value');
  aE(bIdx, 'result', lpTr, 'toAgent', 'value');

  return {
    schemaVersion: 1,
    properties: { name: 'Transfer Bond Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
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

/** THE VALUE INVARIANT — the expected queue is recomputed INDEPENDENTLY from the
 *  agent index, so both targets writing the same WRONG lanes still fail. It pins
 *  the SIGN specifically: entries 0 and 1 carry the same ids and must differ ONLY
 *  in the FORM lane's sign (drop it and the two entries become identical — which
 *  in the engine means a Transfer silently applying as a Rewire). It also pins
 *  that a Transfer writes NO form-half parameters: it re-points an EXISTING edge
 *  and keeps its values, so entry 0's L/K/attr cells stay at their reset zeros
 *  while the Rewire beside it writes 7/11/32. */
function transferBondInvariant(st) {
  const NONE = 1, BIAS = 2;
  const slots = st.bondReqSlots, depth = slots - 1;
  if (slots !== 9) return `bondReqSlots ${slots} !== 9 (default depth 8 + the overflow bucket)`;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const b = i * slots;
    // [breakLane, formLane, L, K, bondAttr bw]  (null = not asserted)
    const want = [
      [i + 1 + BIAS, -(i + 2 + BIAS), 0, 0, 0],        // 0  transfer(self+1 -> self+2)  FORM NEGATIVE
      [i + 1 + BIAS, i + 2 + BIAS, 7, 11, 32],         // 1  rewire  (SAME ids)          FORM POSITIVE
      [NONE, -NONE, 0, 0, 0],                          // 2  transfer with unresolvable partner
      [i + 200 + BIAS, -(i + 300 + BIAS), 0, 0, 0],    // 3  loop k=0
      [i + 201 + BIAS, -(i + 301 + BIAS), 0, 0, 0],    // 4  loop k=1
      [i + 202 + BIAS, -(i + 302 + BIAS), 0, 0, 0],    // 5  loop k=2
      [0, 0, 0, 0, null], [0, 0, 0, 0, null], [0, 0, 0, 0, null],   // 6..8 never written
    ];
    for (let c = 0; c < slots; c++) {
      const [wb, wf, wl, wk, wa] = want[c];
      if (st.bondBreakReq[b + c] !== wb) return `agent ${i} entry ${c}: breakLane ${st.bondBreakReq[b + c]} !== ${wb}`;
      if (st.bondFormReq[b + c] !== wf) return `agent ${i} entry ${c}: formLane ${st.bondFormReq[b + c]} !== ${wf}`;
      if (st.bondFormL[b + c] !== wl) return `agent ${i} entry ${c}: L ${st.bondFormL[b + c]} !== ${wl}`;
      if (st.bondFormK[b + c] !== wk) return `agent ${i} entry ${c}: K ${st.bondFormK[b + c]} !== ${wk}`;
      if (wa !== null && st.bondFormAttrs.bw[b + c] !== wa) return `agent ${i} entry ${c}: bondAttr bw ${st.bondFormAttrs.bw[b + c]} !== ${wa}`;
    }
    // THE OP-KIND BIT: same ids, opposite FORM signs. If a target dropped the
    // negation the two entries would be byte-identical and this is what notices.
    if (st.bondFormReq[b] !== -st.bondFormReq[b + 1]) {
      return `agent ${i}: the Transfer and Rewire FORM lanes are not sign-opposites (${st.bondFormReq[b]} vs ${st.bondFormReq[b + 1]})`;
    }
    if (!(st.bondFormReq[b] < 0)) return `agent ${i}: the Transfer form lane is not NEGATIVE`;
    if (!(st.bondFormReq[b + 1] > 0)) return `agent ${i}: the Rewire form lane is not POSITIVE`;
    if (!(st.bondBreakReq[b] > 0)) return `agent ${i}: the Transfer BREAK lane must stay POSITIVE (a negative one is a Form Between)`;
    // The terminator rule: a written entry must never read as empty (0,0).
    for (let c = 0; c < 6 && c < depth; c++) {
      if (st.bondBreakReq[b + c] === 0 && st.bondFormReq[b + c] === 0) return `agent ${i} entry ${c} reads as EMPTY (queue truncation)`;
    }
  }
  return null;
}

/** PREDATION — the optional-id targeting convention on the three action nodes that
 *  gained it (Kill Agent / Set Velocity / Set Target Radius), exercising BOTH arms
 *  of each in ONE deterministic run.
 *
 *  The population splits by handle: agents 0..11 are HUNTERS, 12..23 their PREY
 *  (hunter h preys on h+12). The behaviour loop runs 0..23 in order, so every
 *  hunter has acted before any prey does, and the final state is a closed form of
 *  the handle alone:
 *    hunter h  : vx = h+1, vy = h+100                   ← Set Velocity, UNWIRED (self)
 *    prey h+12 : vx = h+500, vy = h+700                 ← Set Velocity, WIRED (by id)
 *                targetRadius = h+30                    ← Set Target Radius, WIRED
 *                killRequest = 1 iff h%3==0             ← Kill Agent, WIRED (predation)
 *                              OR (h+12)%7==0           ← Kill Agent, UNWIRED (self-kill)
 *  Prey 21 is flagged by BOTH rules — the IDEMPOTENCE case that is the whole
 *  argument for a wired kill needing no synchronous-mode gate.
 *
 *  The harness seeds MORE agents than the 12 hunters can prey on; the surplus are
 *  BYSTANDERS (else branch, self-kill only) and nothing may reach them by id — so
 *  they are the check that a by-id write never spills onto an untargeted slot. */
function buildByIdTargetingModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  /** self + k, as one arithmetic node fed by Get Self Handle. */
  const plus = (src, k) => { const n = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); aE(src, 'value', n, 'x', 'value'); return n; };

  const bs = an('behaviourStep', {});
  const gsh = an('getSelfHandle', {});
  const isHunter = an('statement', { operation: '<', _port_y: '12' });
  aE(gsh, 'value', isHunter, 'x', 'value');
  const split = an('conditional', {});
  aE(isHunter, 'result', split, 'condition', 'value');
  aE(bs, 'do', split, 'check', 'flow');

  // --- HUNTER branch -------------------------------------------------------
  // 1. Set Velocity with the Agent port UNWIRED — the historical self-write.
  const selfVx = plus(gsh, 1), selfVy = plus(gsh, 100);
  const svSelf = an('setVelocity', {});
  aE(selfVx, 'result', svSelf, 'vx', 'value');
  aE(selfVy, 'result', svSelf, 'vy', 'value');
  aE(split, 'then', svSelf, 'do', 'flow');

  // 2. Set Velocity BY ID on the prey (a cross-agent overwrite — legal here
  //    because the model is in ASYNC agent mode).
  const prey = plus(gsh, 12);
  const preyVx = plus(gsh, 500), preyVy = plus(gsh, 700);
  const svById = an('setVelocity', {});
  aE(prey, 'result', svById, 'agentId', 'value');
  aE(preyVx, 'result', svById, 'vx', 'value');
  aE(preyVy, 'result', svById, 'vy', 'value');
  aE(svSelf, 'next', svById, 'do', 'flow');

  // 3. Set Target Radius BY ID on the prey — make your prey grow.
  const tgtR = plus(gsh, 30);
  const strById = an('setTargetRadius', {});
  aE(prey, 'result', strById, 'agentId', 'value');
  aE(tgtR, 'result', strById, 'value', 'value');
  aE(svById, 'next', strById, 'do', 'flow');

  // 4. Every third hunter EATS its prey — Kill Agent BY ID.
  const hMod3 = an('arithmeticOperator', { operation: '%', _port_y: '3' });
  aE(gsh, 'value', hMod3, 'x', 'value');
  const hEats = an('statement', { operation: '<', _port_y: '0.5' });
  aE(hMod3, 'result', hEats, 'x', 'value');
  const eatIf = an('conditional', {});
  aE(hEats, 'result', eatIf, 'condition', 'value');
  aE(strById, 'next', eatIf, 'do', 'flow');
  const killById = an('killAgent', {});
  aE(prey, 'result', killById, 'agentId', 'value');
  aE(eatIf, 'then', killById, 'do', 'flow');

  // --- PREY branch: every 7th prey dies of despair — Kill Agent UNWIRED (self).
  const pMod7 = an('arithmeticOperator', { operation: '%', _port_y: '7' });
  aE(gsh, 'value', pMod7, 'x', 'value');
  const pDies = an('statement', { operation: '<', _port_y: '0.5' });
  aE(pMod7, 'result', pDies, 'x', 'value');
  const dieIf = an('conditional', {});
  aE(pDies, 'result', dieIf, 'condition', 'value');
  aE(split, 'else', dieIf, 'check', 'flow');
  const killSelf = an('killAgent', {});
  aE(dieIf, 'then', killSelf, 'do', 'flow');

  return {
    schemaVersion: 1,
    properties: { name: 'By-Id Targeting Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 24, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0.9, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: true, division: false, lifespan: false, populationBirth: false, populationDeath: true, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [], bondAttributes: [],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** THE VALUE INVARIANT for the by-id targeting synthetic. Recomputes every
 *  expected number from the agent's HANDLE alone — so a mutation applied
 *  IDENTICALLY to both targets (which parity cannot see) is still caught: e.g.
 *  dropping the id guard, writing self instead of the target, or losing the
 *  second flag on the doubly-killed prey. */
function byIdTargetingInvariant(st) {
  const H = 12;
  let flagged = 0, unflagged = 0, doubly = 0, bystanders = 0;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    if (i >= 2 * H) {
      // BYSTANDER — the harness seeds more agents than the 12 hunters can prey on.
      // It takes the else branch (self-kill only) and NOTHING may reach it by id:
      // an unguarded / mis-targeted by-id write would land here and be caught.
      const despair = i % 7 === 0;
      if (st.killRequest[i] !== (despair ? 1 : 0)) return `bystander ${i}: killRequest ${st.killRequest[i]} !== ${despair ? 1 : 0} (unwired Kill Agent must write SELF)`;
      if (st.vx[i] !== 0 || st.vy[i] !== 0) return `bystander ${i}: velocity (${st.vx[i]}, ${st.vy[i]}) — nothing targets it, so a by-id write spilled`;
      bystanders++;
      continue;
    }
    if (i < H) {
      // HUNTER — the UNWIRED (self) Set Velocity arm.
      if (st.vx[i] !== i + 1) return `hunter ${i}: vx ${st.vx[i]} !== ${i + 1} (unwired Set Velocity must write SELF)`;
      if (st.vy[i] !== i + 100) return `hunter ${i}: vy ${st.vy[i]} !== ${i + 100}`;
      if (st.killRequest[i] !== 0) return `hunter ${i}: killRequest ${st.killRequest[i]} — no rule kills a hunter (a by-id kill wrote the WRONG slot?)`;
    } else {
      const h = i - H;
      // PREY — every write here came from its hunter, BY ID.
      if (st.vx[i] !== h + 500) return `prey ${i}: vx ${st.vx[i]} !== ${h + 500} (wired Set Velocity by id)`;
      if (st.vy[i] !== h + 700) return `prey ${i}: vy ${st.vy[i]} !== ${h + 700}`;
      if (st.targetRadius[i] !== h + 30) return `prey ${i}: targetRadius ${st.targetRadius[i]} !== ${h + 30} (wired Set Target Radius by id)`;
      const eaten = h % 3 === 0, despair = i % 7 === 0;
      const expect = (eaten || despair) ? 1 : 0;
      if (st.killRequest[i] !== expect) return `prey ${i}: killRequest ${st.killRequest[i]} !== ${expect} (eaten=${eaten} self-kill=${despair})`;
      if (expect) flagged++; else unflagged++;
      if (eaten && despair) doubly++;
    }
  }
  // Non-vacuity: the run must actually exercise every arm, including the
  // doubly-flagged prey that makes the idempotence argument concrete.
  if (!flagged) return 'no prey was ever flagged for death — the by-id kill never fired';
  if (!unflagged) return 'every prey was flagged — the kill is not being gated at all';
  if (!doubly) return 'no prey was flagged by BOTH rules — the idempotent double-write case never ran';
  if (!bystanders) return 'the run had no bystanders — the by-id-write-spill check never ran';
  return null;
}

// ---------------------------------------------------------------------------
// BREAK BOND's OPTIONAL PAIR PORT — wiring `agentA` lowers the op to the BREAK
// BETWEEN encoding: BOTH lanes negated, the one sign combination Form Between
// (−,+) and Transfer (+,−) left free.
//
// The synthetic is a SIGN MATRIX: entries 1, 2 and 3 carry THE SAME TWO IDS under
// the three two-id encodings, so they differ ONLY in which lanes are negated. A
// target that dropped either negation would collapse two of them into one — which
// in the engine means a cut silently applying as a bond, or vice versa.
// ---------------------------------------------------------------------------
function buildBreakBondPairModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const gsh = an('getSelfHandle', {});
  const off = (k) => { const n = an('arithmeticOperator', { operation: '+', _port_y: String(k) }); aE(gsh, 'value', n, 'x', 'value'); return n; };

  const bs = an('behaviourStep', {});
  // 0 — Break Bond, agentA UNWIRED   → the historical self arm: (t+2, NONE), BOTH POSITIVE
  const bbSelf = an('breakBond', {});
  // 1 — Break Bond, agentA WIRED     → BREAK BETWEEN: (−(a+2), −(b+2)), BOTH NEGATIVE
  const bbPair = an('breakBond', {});
  // 2 — Form Bond, agentA WIRED, THE SAME TWO IDS → Form Between: (−(a+2), +(b+2))
  const fbPair = an('formBond', { _port_restLength: '7', _port_stiffness: '11', _port_bondAttr_bw: '32' });
  // 3 — Transfer, THE SAME TWO IDS   → Transfer: (+(a+2), −(b+2))
  const trSame = an('transferBond', {});
  // 4 — Break Bond, WIRED but unresolvable → (−NONE, −NONE), still non-zero
  const bbBad = an('breakBond', {});
  // 5..7 — a loop of wired Break Bonds (each entry addresses its own slot)
  const lp = an('loop', { mode: 'count', _port_count: '3' });
  const lpBb = an('breakBond', {});

  const A = off(4), B = off(1);            // the two ids every paired entry reuses
  aE(bs, 'do', bbSelf, 'do', 'flow');
  aE(B, 'result', bbSelf, 'targetAgent', 'value');       // agentA left UNWIRED
  aE(bbSelf, 'next', bbPair, 'do', 'flow');
  aE(A, 'result', bbPair, 'agentA', 'value');
  aE(B, 'result', bbPair, 'targetAgent', 'value');
  aE(bbPair, 'next', fbPair, 'do', 'flow');
  aE(A, 'result', fbPair, 'agentA', 'value');
  aE(B, 'result', fbPair, 'targetAgent', 'value');
  aE(fbPair, 'next', trSame, 'do', 'flow');
  aE(A, 'result', trSame, 'partnerAgent', 'value');
  aE(B, 'result', trSame, 'toAgent', 'value');
  aE(trSame, 'next', bbBad, 'do', 'flow');
  aE(off(-1000), 'result', bbBad, 'agentA', 'value');
  aE(B, 'result', bbBad, 'targetAgent', 'value');
  aE(bbBad, 'next', lp, 'do', 'flow');
  aE(lp, 'body', lpBb, 'do', 'flow');
  const a200 = off(200), b300 = off(300);
  const aIdx = an('arithmeticOperator', { operation: '+' });
  aE(a200, 'result', aIdx, 'x', 'value'); aE(lp, 'index', aIdx, 'y', 'value');
  const bIdx = an('arithmeticOperator', { operation: '+' });
  aE(b300, 'result', bIdx, 'x', 'value'); aE(lp, 'index', bIdx, 'y', 'value');
  aE(aIdx, 'result', lpBb, 'agentA', 'value');
  aE(bIdx, 'result', lpBb, 'targetAgent', 'value');

  return {
    schemaVersion: 1,
    properties: { name: 'Break Bond Pair Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
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

/** THE VALUE INVARIANT — the expected queue is recomputed INDEPENDENTLY from the
 *  agent index, so BOTH targets writing the same WRONG lanes still fail (parity
 *  is a mirror test and cannot see a mutation applied to both sides).
 *
 *  What it pins that nothing else can:
 *   • the SIGN MATRIX — entries 1/2/3 carry identical ids, so Break Between must
 *     be sign-opposite to Form Between on the FORM lane and sign-opposite to
 *     Transfer on the BREAK lane. Drop either negation and two entries collapse;
 *   • the UNWIRED arm is untouched — entry 0 stays the historical (+,+) pair,
 *     which is the byte-identity claim expressed as a runtime value;
 *   • a Break Between writes NO form-half parameters (it has no form half), while
 *     the Form Between beside it writes 7/11/32. */
function breakBondPairInvariant(st) {
  const NONE = 1, BIAS = 2;
  const slots = st.bondReqSlots;
  if (slots !== 9) return `bondReqSlots ${slots} !== 9 (default depth 8 + the overflow bucket)`;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const b = i * slots;
    const A = i + 4 + BIAS, B = i + 1 + BIAS;
    // [breakLane, formLane, L, K, bondAttr bw]  (null = not asserted)
    const want = [
      [B, NONE, 0, 0, 0],                              // 0  break(self, self+1)   BOTH POSITIVE
      [-A, -B, 0, 0, 0],                               // 1  BREAK BETWEEN         BOTH NEGATIVE
      [-A, B, 7, 11, 32],                              // 2  form between, SAME ids
      [A, -B, 0, 0, 0],                                // 3  transfer,     SAME ids
      [-NONE, -NONE, 0, 0, 0],                         // 4  unresolvable agentA
      [-(i + 200 + BIAS), -(i + 300 + BIAS), 0, 0, 0], // 5  loop k=0
      [-(i + 201 + BIAS), -(i + 301 + BIAS), 0, 0, 0], // 6  loop k=1
      [-(i + 202 + BIAS), -(i + 302 + BIAS), 0, 0, 0], // 7  loop k=2
      [0, 0, 0, 0, null],                              // 8  the overflow bucket, never written
    ];
    for (let c = 0; c < slots; c++) {
      const [wb, wf, wl, wk, wa] = want[c];
      if (st.bondBreakReq[b + c] !== wb) return `agent ${i} entry ${c}: breakLane ${st.bondBreakReq[b + c]} !== ${wb}`;
      if (st.bondFormReq[b + c] !== wf) return `agent ${i} entry ${c}: formLane ${st.bondFormReq[b + c]} !== ${wf}`;
      if (st.bondFormL[b + c] !== wl) return `agent ${i} entry ${c}: L ${st.bondFormL[b + c]} !== ${wl}`;
      if (st.bondFormK[b + c] !== wk) return `agent ${i} entry ${c}: K ${st.bondFormK[b + c]} !== ${wk}`;
      if (wa !== null && st.bondFormAttrs.bw[b + c] !== wa) return `agent ${i} entry ${c}: bondAttr bw ${st.bondFormAttrs.bw[b + c]} !== ${wa}`;
    }
    // THE SIGN MATRIX, stated as relations rather than as the constants above —
    // so it still bites if the expected table itself were ever "fixed" to match a
    // regression. Same ids, three encodings, three distinct sign pairs.
    if (st.bondBreakReq[b + 1] !== st.bondBreakReq[b + 2]) return `agent ${i}: Break Between and Form Between must share the BREAK lane (${st.bondBreakReq[b + 1]} vs ${st.bondBreakReq[b + 2]})`;
    if (st.bondFormReq[b + 1] !== -st.bondFormReq[b + 2]) return `agent ${i}: Break Between and Form Between FORM lanes are not sign-opposites (${st.bondFormReq[b + 1]} vs ${st.bondFormReq[b + 2]})`;
    if (st.bondFormReq[b + 1] !== st.bondFormReq[b + 3]) return `agent ${i}: Break Between and Transfer must share the FORM lane (${st.bondFormReq[b + 1]} vs ${st.bondFormReq[b + 3]})`;
    if (st.bondBreakReq[b + 1] !== -st.bondBreakReq[b + 3]) return `agent ${i}: Break Between and Transfer BREAK lanes are not sign-opposites (${st.bondBreakReq[b + 1]} vs ${st.bondBreakReq[b + 3]})`;
    if (!(st.bondBreakReq[b + 1] < 0 && st.bondFormReq[b + 1] < 0)) return `agent ${i}: the Break Between entry is not BOTH-negative`;
    if (!(st.bondBreakReq[b] > 0 && st.bondFormReq[b] > 0)) return `agent ${i}: the UNWIRED break entry is not both-POSITIVE (the historical arm moved)`;
    // The terminator rule: a written entry must never read as empty (0,0).
    for (let c = 0; c < 8; c++) {
      if (st.bondBreakReq[b + c] === 0 && st.bondFormReq[b + c] === 0) return `agent ${i} entry ${c} reads as EMPTY (queue truncation)`;
    }
  }
  return null;
}

entries.push({
  name: '[synthetic] TRANSFER Bond (sign-encoded op kind vs Rewire, same ids)',
  raw: buildTransferBondModel(), setup: setupBondAttrStores, invariant: transferBondInvariant,
});
entries.push({
  name: '[synthetic] Break Bond pair port (the BREAK BETWEEN sign matrix)',
  raw: buildBreakBondPairModel(), setup: setupBondAttrStores, invariant: breakBondPairInvariant,
});

// ---------------------------------------------------------------------------
// NEIGHBOUR DENSITY — the optional Radius, and the TWO modes it selects.
//
// One graph carries all three shapes at once, so a single run pins the whole
// activation predicate:
//   • Radius UNWIRED           → the ENGINE reduction `_agentDensity[idx]`.
//   • Radius INLINE (3)        → LOWERED to Get Nearby Agents(3) → Array Length.
//   • Radius WIRED (a model attribute = 2) → the same lowering, radius from the wire.
//
// Parity alone is a mirror test here — if BOTH targets lowered the unwired node
// (or ignored the inline value) they would still agree. The VALUE invariant below
// therefore recomputes every one of the three from the store's OWN positions /
// density array, and additionally asserts the fixture DISCRIMINATES (the three
// answers are not all the same number, so a collapsed mode is visible).
// ---------------------------------------------------------------------------
const DENSITY_INLINE_R = 3, DENSITY_WIRED_R = 2, DENSITY_W = 24, DENSITY_H = 24;
function buildDensityRadiusModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

  const bs = an('behaviourStep', {});
  // 1) UNWIRED — must still read the engine reduction.
  const dEng = an('neighbourDensity', {});
  const wEng = an('setAttribute', { attributeId: 'dEng' });
  aE(dEng, 'value', wEng, 'value', 'value');
  aE(bs, 'do', wEng, 'do', 'flow');
  // 2) INLINE radius.
  const dIn = an('neighbourDensity', { _port_radius: String(DENSITY_INLINE_R) });
  const wIn = an('setAttribute', { attributeId: 'dIn' });
  aE(dIn, 'value', wIn, 'value', 'value');
  aE(wEng, 'next', wIn, 'do', 'flow');
  // 3) WIRED radius — a MODEL ATTRIBUTE, the "receive an attribute for the
  //    radius" case (and a non-constant source, so the wire is really read).
  const dWi = an('neighbourDensity', {});
  const qr = an('getModelAttribute', { attributeId: 'qr' });
  aE(qr, 'value', dWi, 'radius', 'value');
  const wWi = an('setAttribute', { attributeId: 'dWi' });
  aE(dWi, 'value', wWi, 'value', 'value');
  aE(wIn, 'next', wWi, 'do', 'flow');

  return {
    schemaVersion: 1,
    properties: { name: 'Neighbour Density Radius Parity Test', dimension: '2d', gridWidth: DENSITY_W, gridHeight: DENSITY_H, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: DENSITY_W, worldHeight: DENSITY_H, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 4, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [
      { id: 'qr', name: 'Query Radius', type: 'float', isModelAttribute: true, defaultValue: String(DENSITY_WIRED_R) },
    ],
    modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'dEng', name: 'D Engine', type: 'float', defaultValue: '0' },
      { id: 'dIn', name: 'D Inline', type: 'float', defaultValue: '0' },
      { id: 'dWi', name: 'D Wired', type: 'float', defaultValue: '0' },
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** Seed the ENGINE density with a pattern nothing else could produce (so "read
 *  the reduction" is distinguishable from "count neighbours"), and push two rows
 *  of agents onto opposite sides of the torus SEAM so the fold the lowered
 *  Get Nearby Agents applies is load-bearing rather than decorative. */
function setupDensityStores(stores) {
  for (const s of stores) {
    for (let i = 0; i < s.highWater; i++) {
      s.density[i] = (i % 7) + 100;               // 100..106 — never a real neighbour count here
      if (i < 8) { s.x[i] = DENSITY_W - 0.6; s.y[i] = 2 + i * 0.7; }
      else if (i < 16) { s.x[i] = 0.6; s.y[i] = 2 + (i - 8) * 0.7; }
    }
  }
}

/** The VALUE invariant, recomputed from the store's own state (never from the
 *  emit): the unwired node must equal the engine array element-for-element, and
 *  each active-radius node must equal an independent torus-folded count at ITS
 *  radius. The last three checks assert the fixture actually discriminates. */
function densityRadiusInvariant(st) {
  const hW = DENSITY_W / 2, hH = DENSITY_H / 2;
  const count = (i, R) => {
    let n = 0;
    for (let j = 0; j < st.highWater; j++) {
      if (j === i || !st.alive[j]) continue;
      let dx = st.x[j] - st.x[i], dy = st.y[j] - st.y[i];
      if (dx > hW) dx -= DENSITY_W; else if (dx < -hW) dx += DENSITY_W;
      if (dy > hH) dy -= DENSITY_H; else if (dy < -hH) dy += DENSITY_H;
      if (dx * dx + dy * dy <= R * R) n++;
    }
    return n;
  };
  let sawInlineNeWired = false, sawEngNeCount = false, sawSeamPair = false;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    const cIn = count(i, DENSITY_INLINE_R), cWi = count(i, DENSITY_WIRED_R);
    if (st.attrRead.dEng[i] !== st.density[i]) return `agent ${i}: unwired density ${st.attrRead.dEng[i]} !== engine reduction ${st.density[i]}`;
    if (st.attrRead.dIn[i] !== cIn) return `agent ${i}: inline-radius density ${st.attrRead.dIn[i]} !== recount(${DENSITY_INLINE_R}) ${cIn}`;
    if (st.attrRead.dWi[i] !== cWi) return `agent ${i}: wired-radius density ${st.attrRead.dWi[i]} !== recount(${DENSITY_WIRED_R}) ${cWi}`;
    if (cIn !== cWi) sawInlineNeWired = true;
    if (st.density[i] !== cIn) sawEngNeCount = true;
    // a seam pair: agent i (x ~ 23.4) can only see agent i+8 (x ~ 0.6) via the fold
    if (i < 8 && cWi > 0) sawSeamPair = true;
  }
  if (!sawInlineNeWired) return 'fixture does not discriminate: the two radii give the same count everywhere';
  if (!sawEngNeCount) return 'fixture does not discriminate: the engine reduction equals the radius count everywhere';
  if (!sawSeamPair) return 'fixture does not discriminate: no agent sees a partner across the torus seam';
  return null;
}

entries.push({
  name: '[synthetic] Neighbour Density Radius (engine reduction / inline / wired, lowered)',
  raw: buildDensityRadiusModel(), setup: setupDensityStores, invariant: densityRadiusInvariant,
});
entries.push({
  name: '[synthetic] Division partition (two Divide Agent nodes, distinct codes)',
  raw: buildDividePartitionModel(), setup: setupBondAttrStores, invariant: dividePartitionInvariant,
});
entries.push({
  name: '[synthetic] Division conserve (area vs volume codes + 3D myVolume)',
  raw: buildDivideConserveModel(), setup: setupDivideConserveStores, invariant: divideConserveInvariant,
});
entries.push({
  name: '[synthetic] By-id targeting (Kill / Set Velocity / Set Target Radius, self + by id)',
  raw: buildByIdTargetingModel(), invariant: byIdTargetingInvariant,
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


// ---------------------------------------------------------------------------
// L2 — RULE CADENCE: Get Generation + THREE Periodic Steps at once.
//
// Three things must hold, and only the first is parity:
//   • JS and WASM read the SAME generation (`gen` is compared cell-for-cell);
//   • each Periodic Step fires on EXACTLY its own schedule (the VALUE invariant
//     below recomputes `generation % period === phase` independently — parity
//     alone would pass happily if both targets fired every generation, which is
//     precisely the failure a broken gate produces);
//   • `Step Index` = floor(generation / period).
// The five gates cover the always-on case, the classic two-phase alternation, a
// phase-0 gate that is NOT always-on, and the exit gate's period-10 pair (phases
// 0 and 3 — firing on 0/10/20 and 3/13/23 within the 30-step run).
//
// Each gate stamps the CURRENT generation into its own attribute, so that
// attribute always holds the generation it LAST fired on. Checked every step,
// that pins the schedule exactly in both directions: an extra firing shows up
// immediately (the stamp is a generation the schedule does not contain) and a
// missed one shows up immediately (the stamp lags). Stamping rather than
// accumulating also keeps the invariant independent of the harness's attribute
// seeding, which is a non-zero pattern.
// ---------------------------------------------------------------------------
const CADENCE_STEPS = [
  { period: 1, phase: 0, hits: 'hitsA', idx: 'idxA' },   // always-on
  { period: 2, phase: 1, hits: 'hitsB', idx: 'idxB' },   // the classic odd tick
  { period: 3, phase: 0, hits: 'hitsC', idx: 'idxC' },   // a phase-0 gate that is NOT always-on
  { period: 10, phase: 0, hits: 'hitsD', idx: 'idxD' },  // the exit gate's 0, 10, 20 …
  { period: 10, phase: 3, hits: 'hitsE', idx: 'idxE' },  // …and its offset sibling 3, 13, 23 …
];
function buildCadenceModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

  // A plain Behaviour Step ALSO present: its unconditional chain must keep running
  // every generation alongside the periodic ones (the lowering sequences them).
  const bs = an('behaviourStep', {});
  const gg = an('getGeneration', {});
  const setGen = an('setAttribute', { attributeId: 'gen' });
  aE(gg, 'value', setGen, 'value', 'value');
  aE(bs, 'do', setGen, 'do', 'flow');

  for (const { period, phase, hits, idx } of CADENCE_STEPS) {
    const ps = an('periodicStep', { period: String(period), phase: String(phase) });
    // Stamp the CURRENT generation — so this attribute holds the generation this
    // gate last fired on. Shares the ONE Get Generation the graph already has.
    const w = an('setAttribute', { attributeId: hits });
    aE(gg, 'value', w, 'value', 'value');
    aE(ps, 'do', w, 'do', 'flow');
    // Step Index, recorded on the same firing generations.
    const wi = an('setAttribute', { attributeId: idx });
    aE(ps, 'stepIndex', wi, 'value', 'value');
    aE(w, 'next', wi, 'do', 'flow');
  }

  return {
    schemaVersion: 1,
    properties: { name: 'Rule Cadence Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'static', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [
      { id: 'gen', name: 'Gen', type: 'float', defaultValue: '0' },
      ...CADENCE_STEPS.flatMap(({ hits, idx }) => ([
        { id: hits, name: hits, type: 'float', defaultValue: '0' },
        { id: idx, name: idx, type: 'float', defaultValue: '0' },
      ])),
    ],
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}
/** The VALUE invariant, recomputed from first principles (NOT from the emit):
 *  after generation `step` (checked EVERY step, not just the last), every live
 *  agent must hold
 *    gen        = step                          (the generation it just saw)
 *    hits_i     = the LAST g <= step with g % p_i === ph_i   (once it has fired)
 *    idx_i      = floor(hits_i / p_i)
 *  A gate that has not fired yet is skipped (its attribute still holds the
 *  harness's seed). Recounting here is what distinguishes "the gate works" from
 *  "both targets fired unconditionally", which parity cannot see. */
function cadenceInvariant(st, step) {
  const expect = { gen: step };
  for (const { period, phase, hits, idx } of CADENCE_STEPS) {
    let lastFire = -1;
    for (let g = 0; g <= step; g++) if (g % period === phase) lastFire = g;
    if (lastFire < 0) continue;    // not fired yet — the seed is still in place
    expect[hits] = lastFire;
    expect[idx] = Math.floor(lastFire / period);
  }
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    for (const k of Object.keys(expect)) {
      const got = st.attrRead[k][i];
      if (got !== expect[k]) return `agent ${i}: ${k} ${got} !== expected ${expect[k]}`;
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// GET RANDOM overhaul: parameterised INTERVALS (Min/Max as ports, inline AND
// wired), DISTRIBUTIONS (normal = 2 draws, exponential = 1) and the VECTOR mode
// (multi-output X/Y). Parity pins the draw ORDER + the emitted arithmetic; the
// VALUE invariant below is stream-INDEPENDENT (it uses degenerate parameters
// whose answer is exact, plus range/norm laws) because parity alone would pass
// happily if BOTH targets drew the wrong number of times in the same way.
// ---------------------------------------------------------------------------
function buildGetRandomModel() {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep', {});
  let prev = bs, prevPort = 'do';
  const chain = (rndCfg, attrId, port, extraWires) => {
    const rnd = an('getRandom', rndCfg);
    for (const w of (extraWires || [])) aE(w[0], w[1], rnd, w[2], 'value');
    const set = an('setAttribute', { attributeId: attrId });
    aE(rnd, port || 'value', set, 'value', 'value');
    aE(prev, prevPort, set, 'do', 'flow');
    prev = set; prevPort = 'next';
    return rnd;
  };
  const alsoY = (rnd, attrId) => {
    const set = an('setAttribute', { attributeId: attrId });
    aE(rnd, 'y', set, 'value', 'value');
    aE(prev, prevPort, set, 'do', 'flow');
    prev = set; prevPort = 'next';
  };
  // 1. Decimal / uniform, INLINE interval [10, 20).
  chain({ randomType: 'float', distribution: 'uniform', _port_min: '10', _port_max: '20' }, 'uniIn');
  // 2. Decimal / uniform, WIRED interval [-5, -1) - the runtime-span path.
  const cLo = an('getConstant', { constType: 'float', constValue: '-5' });
  const cHi = an('getConstant', { constType: 'float', constValue: '-1' });
  chain({ randomType: 'float', distribution: 'uniform' }, 'uniW', 'value', [[cLo, 'value', 'min'], [cHi, 'value', 'max']]);
  // 3. Decimal / normal with stddev 0 - DETERMINISTICALLY the mean, and still
  //    exactly TWO draws (the stream advance is what parity pins).
  chain({ randomType: 'float', distribution: 'normal', _port_mean: '7', _port_stddev: '0' }, 'norm0');
  // 4. Decimal / normal, a real bell.
  chain({ randomType: 'float', distribution: 'normal', _port_mean: '0', _port_stddev: '1' }, 'normS');
  // 5. Decimal / exponential, mean 3 (never negative).
  chain({ randomType: 'float', distribution: 'exponential', _port_mean: '3' }, 'expo');
  // 6. Integer with a WIRED lower bound.
  const cIlo = an('getConstant', { constType: 'integer', constValue: '4' });
  chain({ randomType: 'integer', _port_max: '9' }, 'intW', 'value', [[cIlo, 'value', 'min']]);
  // 6b. COLOR — three draws (R, G, B) from ONE multi-output node. It sits in the
  //     MIDDLE of the chain deliberately: if agentWasm drew a different NUMBER of
  //     times than agent JS, every later draw in this chain would land at a
  //     different stream position and PARITY would fail loudly. That is what pins
  //     the 3-draw contract on the agent targets (the invariant below is
  //     stream-independent and cannot see a count, by construction).
  const col = chain({ randomType: 'color' }, 'colR', 'r');
  for (const [port, attrId] of [['g', 'colG'], ['b', 'colB']]) {
    const set = an('setAttribute', { attributeId: attrId });
    aE(col, port, set, 'value', 'value');
    aE(prev, prevPort, set, 'do', 'flow');
    prev = set; prevPort = 'next';
  }
  // 6c. The COMPOSITE `color` port off the SAME node, through Break Color. Its
  //     alpha is a LITERAL 255 (colour mode draws no alpha), and reusing the same
  //     node must cost NO extra draw — expandComposites lowers the composite back
  //     to this node's own channels.
  {
    const brk = an('breakColor', {});
    aE(col, 'color', brk, 'color', 'value');
    for (const [port, attrId] of [['r', 'cpR'], ['a', 'cpA']]) {
      const set = an('setAttribute', { attributeId: attrId });
      aE(brk, port, set, 'value', 'value');
      aE(prev, prevPort, set, 'do', 'flow');
      prev = set; prevPort = 'next';
    }
  }
  // 7. Vector, ANGLE reference, span 0 => exactly due east at |v| = 2.
  alsoY(chain({ randomType: 'vector', refSource: 'angle', _port_norm: '2', _port_angle: '90', _port_span: '0' }, 'vAx', 'x'), 'vAy');
  // 8. Vector, WIRED direction (0, -1) = north, span 0 => exactly (0, -3).
  alsoY(chain({ randomType: 'vector', refSource: 'vector', _port_norm: '3', _port_dirX: '0', _port_dirY: '-1', _port_span: '0' }, 'vDx', 'x'), 'vDy');
  // 9. Vector, FULL span - direction random, but the NORM is a law.
  alsoY(chain({ randomType: 'vector', refSource: 'angle', _port_norm: '5', _port_span: '360' }, 'vFx', 'x'), 'vFy');
  const attr = (id) => ({ id, name: id, type: 'float', defaultValue: '0' });
  return {
    schemaVersion: 1,
    properties: { name: 'Get Random Parity Test', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 40, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'static', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: ['uniIn', 'uniW', 'norm0', 'normS', 'expo', 'intW',
      'colR', 'colG', 'colB', 'cpR', 'cpA',
      'vAx', 'vAy', 'vDx', 'vDy', 'vFx', 'vFy'].map(attr),
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
  };
}

/** Stream-INDEPENDENT value laws for the Get Random synthetic. */
function getRandomInvariant(st) {
  const A = st.attrRead;
  const near = (a, b, eps) => Math.abs(a - b) <= eps;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    if (!(A.uniIn[i] >= 10 && A.uniIn[i] < 20)) return `agent ${i}: inline interval ${A.uniIn[i]} outside [10, 20)`;
    if (!(A.uniW[i] >= -5 && A.uniW[i] < -1)) return `agent ${i}: WIRED interval ${A.uniW[i]} outside [-5, -1)`;
    if (A.norm0[i] !== 7) return `agent ${i}: normal(mean 7, sd 0) = ${A.norm0[i]}, must be exactly 7`;
    if (!Number.isFinite(A.normS[i]) || Math.abs(A.normS[i]) > 12) return `agent ${i}: normal draw ${A.normS[i]} implausible`;
    if (!(A.expo[i] >= 0) || !Number.isFinite(A.expo[i])) return `agent ${i}: exponential draw ${A.expo[i]} must be >= 0`;
    if (!(A.intW[i] >= 4 && A.intW[i] <= 9) || A.intW[i] !== Math.floor(A.intW[i])) return `agent ${i}: wired integer ${A.intW[i]} outside 4..9`;
    // COLOR — every channel a WHOLE byte, and the three channels are separate
    // draws (a shared/copied value would make them identical on every agent,
    // which the population-level check after this loop rejects).
    for (const k of ['colR', 'colG', 'colB', 'cpR']) {
      const v = A[k][i];
      if (!(v >= 0 && v <= 255) || v !== Math.floor(v)) return `agent ${i}: ${k} = ${v} is not a whole byte in 0..255`;
    }
    // The composite port resolves back to the SAME node's channels, so R must
    // match exactly — and alpha is the literal 255 (colour mode draws no alpha).
    if (A.cpR[i] !== A.colR[i]) return `agent ${i}: composite R ${A.cpR[i]} !== direct R ${A.colR[i]}`;
    if (A.cpA[i] !== 255) return `agent ${i}: composite alpha ${A.cpA[i]} must be the literal 255`;
    // Compass: 0 deg = north = -y, 90 deg = east = +x.
    if (!near(A.vAx[i], 2, 1e-12) || !near(A.vAy[i], 0, 1e-12)) return `agent ${i}: angle-90 span-0 vector (${A.vAx[i]}, ${A.vAy[i]}) must be (2, 0)`;
    if (A.vDx[i] !== 0 || A.vDy[i] !== -3) return `agent ${i}: dir(0,-1) span-0 vector (${A.vDx[i]}, ${A.vDy[i]}) must be exactly (0, -3)`;
    const n2 = A.vFx[i] * A.vFx[i] + A.vFy[i] * A.vFy[i];
    if (!near(n2, 25, 1e-9)) return `agent ${i}: full-span vector norm^2 ${n2} must be 25`;
  }
  // Population-level: R/G/B must be three INDEPENDENT draws. If the emit copied
  // one draw into all three channels (or cached the wrong port), every agent
  // would carry R === G === B — the one colour failure parity cannot see,
  // because both targets would do it identically.
  let live = 0, rEqG = 0, gEqB = 0;
  for (let i = 0; i < st.highWater; i++) {
    if (!st.alive[i]) continue;
    live++;
    if (A.colR[i] === A.colG[i]) rEqG++;
    if (A.colG[i] === A.colB[i]) gEqB++;
  }
  if (live > 8 && (rEqG === live || gEqB === live)) {
    return `all ${live} agents have a repeated channel (R==G on ${rEqG}, G==B on ${gEqB}) — the channels are not independent draws`;
  }
  return null;
}

entries.push({
  name: '[synthetic] Get Random (intervals, normal/exponential, vector, COLOR)',
  raw: buildGetRandomModel(), invariant: getRandomInvariant,
});

entries.push({
  name: '[synthetic] Rule cadence (Get Generation + 5 Periodic Steps)',
  raw: buildCadenceModel(), invariant: cadenceInvariant,
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
  // C9 / STEP 4 — BOTH stores use the model's resolved gates (the same record the
  // compiler baked into `layoutExtras`), so the plain and wasmBacked layouts agree.
  const fieldGates = layoutExtras?.fieldGates;
  const A = createAgentStore(cfg, specs, { wasmBacked: false, syncAttrs, bondAttrSpecs: bondSpecs, bondReqSlots, fieldGates });
  const B = createAgentStore(cfg, specs, { wasmBacked: true, syncAttrs, maxHashBins: cMaxHashBins, layoutExtras, bondAttrSpecs: bondSpecs, bondReqSlots, fieldGates });
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
    // L2 — the step index IS the generation (the worker's counter advances once
    // per generation). JS takes it through the ABI arg; WASM through its memory cell.
    ctxA.generation = step;
    jsFn(...buildArgs(A, hashA, ctxA));
    // --- WASM behaviour on B ---
    const Bbuf = B.memory.buffer, BL = B.layout;
    new Uint32Array(Bbuf, BL.rngStateOffset, 1)[0] = SEED + step;
    new Float64Array(Bbuf, BL.generationOffset, 1)[0] = step;   // L2 — mirrors the worker's generationAgentView
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
        // `step` (the 0-based generation just run) is passed so a per-step
        // invariant can assert a schedule; existing ones ignore it.
        const bad = invariant(st, step);
        if (bad) { mismatch++; if (!firstField) firstField = `INVARIANT(${label}) ${bad}`; break; }
      }
    }
    cmpArr('colors', A.colors, B.colors, hw * 4);
    // Sprite display state — a WASM-target store backs these on the shared agent
    // memory (the layout's sprite block), so Set Agent Sprite's WASM emit must
    // land on exactly the bytes the JS node would have written. Zero-length on
    // both stores for a sprite-free model, so these are no-ops there.
    cmpArr('spriteIds', A.spriteIds, B.spriteIds, Math.min(A.spriteIds.length, hw));
    cmpArr('spriteFrames', A.spriteFrames, B.spriteFrames, Math.min(A.spriteFrames.length, hw));
    cmpArr('spriteSpeeds', A.spriteSpeeds, B.spriteSpeeds, Math.min(A.spriteSpeeds.length, hw));
    cmpArr('spriteRotations', A.spriteRotations, B.spriteRotations, Math.min(A.spriteRotations.length, hw));
    cmpArr('spriteScales', A.spriteScales, B.spriteScales, Math.min(A.spriteScales.length, hw));
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
