// HEAVY-RULE BENCHMARK — the agent BEHAVIOUR fn (the new full-coverage surface)
// on JS vs WASM. Times a HEAVY per-agent rule (neighbour gather → Get Agents
// Attribute → Aggregate, a Lookup Table, several Compares + conditionals + per-
// agent math), NOT the trivial Boids force loop. The force pass + structural phase
// are excluded (force-pass = W1 wash; structural = target-independent). This is the
// "does WASM pull ahead as per-agent rule complexity grows?" measurement.
//
// Run from the repo root:  node scripts/bench-agent-behaviour.mjs
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { resolveKeyLabels, normalizeLookupTable } from '../src/modeler/vpl/compiler/variegation.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-benchb-'));
const entryPath = join(ROOT, 'scripts', '__benchb_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
const { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents, compileAgentGraphWasmForModel, instantiateAgentWasm, resolveKeyLabels, normalizeLookupTable } = m;

const nb = (id, t, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config } });
const fe = (s, sh, t, th) => ({ id: s + '->' + t + '~' + Math.random().toString(36).slice(2, 6), source: s, sourceHandle: sh, target: t, targetHandle: th });

// HEAVY per-agent rule (a chromatography-in-agents style):
//   nearby = GetNearbyAgents(r)
//   vals   = GetAgentsAttribute(nearby, kind)
//   sum    = Aggregate.sum(vals);  avg = Aggregate.average(vals);  cnt over nearby
//   tbl    = LookupTable(myKind, neighbourMeanKind) (interaction PB)
//   expr chains over sum/avg/tbl/myAge -> several Compares -> Conditionals -> setAttribute + applyForce
const W = 200, H = 200;
const nodes = [
  nb('beh', 'behaviourStep'),
  nb('na', 'getNearbyAgents', { _port_radius: '6' }),
  nb('ga', 'getAgentsAttribute', { attributeId: 'kind' }),
  nb('agSum', 'aggregate', { operation: 'sum' }),
  nb('agAvg', 'aggregate', { operation: 'average' }),
  nb('agMax', 'aggregate', { operation: 'max' }),
  nb('gMine', 'getCellAttribute', { attributeId: 'kind' }),
  nb('tbl', 'lookupInteraction', { tableId: 'PB' }),
  nb('ex1', 'expression', { expression: 'a*b + c', visibleCount: 3, _varName_a: 'a', _varName_b: 'b', _varName_c: 'c' }),
  nb('ex2', 'expression', { expression: 'sin(a) + sqrt(abs(b)) + c*0.5', visibleCount: 3, _varName_a: 'a', _varName_b: 'b', _varName_c: 'c' }),
  nb('c1', 'statement', { operation: '>', _port_y: '2.5' }),
  nb('c2', 'statement', { operation: '<', _port_y: '0.5' }),
  nb('cond1', 'conditional'),
  nb('cond2', 'conditional'),
  nb('sa1', 'setAttribute', { attributeId: 'energy' }),
  nb('sa2', 'setAttribute', { attributeId: 'energy' }),
  nb('af', 'applyForce'),
  nb('myE', 'getCellAttribute', { attributeId: 'energy' }),
];
const edges = [
  fe('na', 'output_value_value', 'ga', 'input_value_agents'),
  fe('ga', 'output_value_values', 'agSum', 'input_value_values'),
  fe('ga', 'output_value_values', 'agAvg', 'input_value_values'),
  fe('ga', 'output_value_values', 'agMax', 'input_value_values'),
  fe('gMine', 'output_value_value', 'tbl', 'input_value_labelA'),
  fe('agMax', 'output_value_result', 'tbl', 'input_value_labelB'),
  fe('agSum', 'output_value_result', 'ex1', 'input_value_a'),
  fe('agAvg', 'output_value_result', 'ex1', 'input_value_b'),
  fe('tbl', 'output_value_value', 'ex1', 'input_value_c'),
  fe('ex1', 'output_value_value', 'ex2', 'input_value_a'),
  fe('myE', 'output_value_value', 'ex2', 'input_value_b'),
  fe('agAvg', 'output_value_result', 'ex2', 'input_value_c'),
  fe('ex2', 'output_value_value', 'c1', 'input_value_x'),
  fe('ex1', 'output_value_value', 'c2', 'input_value_x'),
  fe('beh', 'output_flow_do', 'cond1', 'input_flow_do'),
  fe('c1', 'output_value_value', 'cond1', 'input_value_condition'),
  fe('cond1', 'output_flow_then', 'sa1', 'input_flow_do'),
  fe('ex2', 'output_value_value', 'sa1', 'input_value_value'),
  fe('cond1', 'output_flow_else', 'cond2', 'input_flow_do'),
  fe('c2', 'output_value_value', 'cond2', 'input_value_condition'),
  fe('cond2', 'output_flow_then', 'sa2', 'input_flow_do'),
  fe('ex1', 'output_value_value', 'sa2', 'input_value_value'),
  fe('cond1', 'output_flow_next', 'af', 'input_flow_do'),
  fe('ex1', 'output_value_value', 'af', 'input_value_fx'),
  fe('ex2', 'output_value_value', 'af', 'input_value_fy'),
];
const tableVals = {}; for (let i = 0; i < 5; i++) { tableVals['k' + i] = {}; for (let j = 0; j < 5; j++) tableVals['k' + i]['k' + j] = 0.1 + 0.15 * ((i * 7 + j) % 5); }
const model = {
  properties: { gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, boundaryTreatment: 'torus' },
  topologyMode: { gridCells: true, agents: true },
  centerBased: { enabled: true, maxAgents: 0, maxBonds: 4, worldWidth: W, worldHeight: H, defaultRadius: 0.5, interactionRange: 1.5, neighbourQueryRadius: 6, momentum: 0.9, maxSpeed: 2, timeStep: 0.1, drag: 1, useBondingPhysics: false, agentUpdateMode: 'async' },
  agentGraphNodes: nodes, agentGraphEdges: edges, agentVariables: [],
  graphNodes: [], graphEdges: [], macroDefs: [], variables: [],
  attributes: [
    { id: 'kind', name: 'kind', type: 'tag', tagOptions: ['k0', 'k1', 'k2', 'k3', 'k4'], defaultValue: '0', isModelAttribute: false },
    { id: 'energy', name: 'energy', type: 'float', defaultValue: '1', isModelAttribute: false },
    { id: 'PB', name: 'PB', type: 'lookupTable', isModelAttribute: true, rowKeySource: { kind: 'tagAttribute', attributeId: 'kind' }, colKeySource: { kind: 'tagAttribute', attributeId: 'kind' }, tableValues: tableVals },
  ],
  agentAttributes: [
    { id: 'kind', name: 'kind', type: 'tag', tagOptions: ['k0', 'k1', 'k2', 'k3', 'k4'], defaultValue: '0' },
    { id: 'energy', name: 'energy', type: 'float', defaultValue: '1' },
  ],
  neighborhoods: [], indicators: [], mappings: [],
};

const COUNTS = [500, 2000, 8000];
console.log('HEAVY per-agent rule (nearby gather + 3 aggregates + lookup table + 2 expressions + 2 compares + 2 conditionals):\n');
console.log('   N    | JS steps/s | WASM steps/s | speedup');
console.log('--------|------------|--------------|--------');
for (const N of COUNTS) {
  model.centerBased.maxAgents = N + 16;
  const wasmR = compileAgentGraphWasmForModel(model);
  if (wasmR.error) { console.log(`  ${N}: WASM compile err ${wasmR.error}`); continue; }
  const { compileAgentGraph } = m;
  const jsR = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  const jsFn = eval(jsR.behaviourCode);
  const specs = [{ id: 'kind', type: 'tag', defaultValue: 0 }, { id: 'energy', type: 'float', defaultValue: 1 }];
  const cMaxHashBins = wasmR.layout.maxHashBins;
  const A = createAgentStore(model.centerBased, specs, { wasmBacked: false });
  const layoutExtras = { ...m.buildAgentLayoutExtras(model), fieldTotal: W * H };
  const B = createAgentStore(model.centerBased, specs, { wasmBacked: true, maxHashBins: cMaxHashBins, layoutExtras });
  for (const s of [A, B]) { s.worldWidth = W; s.worldHeight = H; s.worldDepth = 1; }
  // scatter-seed N agents
  const seedSpecs = []; for (let i = 0; i < N; i++) seedSpecs.push({ x: 1 + Math.random() * (W - 2), y: 1 + Math.random() * (H - 2), radius: 0.5 });
  seedAgents(A, seedSpecs, 0.5); seedAgents(B, seedSpecs, 0.5);
  for (const s of [A, B]) { for (let i = 0; i < s.highWater; i++) s.attrRead['kind'][i] = i % 5; }
  // caches
  const cachedModelAttrs = {};
  const cachedInteractionTables = { PB: normalizeLookupTable(tableVals, resolveKeyLabels(model.attributes[2].rowKeySource, model), resolveKeyLabels(model.attributes[2].colKeySource, model)) };
  const cachedIndicators = new Float64Array(0);
  // hash (built once; positions don't change in behaviour-only bench)
  const hash = buildSpatialHash(A, Math.max(1.5, 6), W, H, 1);
  const rngState = new Uint32Array(1);
  const EMPTY = new Int32Array(0);
  const jsArgs = () => { const a = [ A.alive, A.highWater, A.x, A.y, A.radius, A.targetRadius, A.age, A.type, A.lineage, A.bondCount, A.density, A.vx, A.vy, A.forceX, A.forceY, hash ? 1 : 0, hash ? hash.binStart : EMPTY, hash ? hash.binAgents : EMPTY, hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, A.divideRequest, A.divideAxisX, A.divideAxisY, A.divideAsym, A.killRequest, A.bondPartner, A.bondPartnerEpoch, A.bondRestLength, A.bondStiffness, A.bondTypeLabel, A.maxBonds, A.bondFormReq, A.bondFormL, A.bondFormK, A.bondBreakReq ]; a.push(A.attrRead['kind'], A.attrRead['energy']); a.push(A.attrWrite['kind'], A.attrWrite['energy']); a.push(cachedModelAttrs, A.colors, '', cachedIndicators, rngState, new Uint32Array(1), new Uint32Array(1), new Uint32Array(1)); a.push(cachedInteractionTables); a.push(W, H, W * H, 1); return a; };
  // copy hash + lookup into B once
  const Bbuf = B.memory.buffer, BL = B.layout;
  if (hash) { const nBins = hash.nBinsX * hash.nBinsY * hash.nBinsZ; new Int32Array(Bbuf, BL.hashBinStartOffset, nBins + 1).set(hash.binStart.subarray(0, nBins + 1)); const used = hash.binStart[nBins]; if (used > 0) new Int32Array(Bbuf, BL.hashBinAgentsOffset, used).set(hash.binAgents.subarray(0, used)); }
  for (const id of Object.keys(BL.lookupTableOffset)) { const t = cachedInteractionTables[id]; if (t) new Float64Array(Bbuf, BL.lookupTableOffset[id], t.length).set(t); }
  const inst = await instantiateAgentWasm(wasmR.bytes, B.memory);
  const callWasm = () => inst.behaviour(B.highWater, hash ? 1 : 0, hash ? hash.nBinsX : 0, hash ? hash.nBinsY : 0, 0, hash ? hash.binSizeX : 1, hash ? hash.binSizeY : 1, 1, W, H, 1, 1);

  // warmup
  for (let i = 0; i < 5; i++) { jsFn(...jsArgs()); callWasm(); }
  const time = (fn) => { const reps = N >= 8000 ? 30 : N >= 2000 ? 80 : 200; const t0 = performance.now(); for (let i = 0; i < reps; i++) fn(); const dt = performance.now() - t0; return reps / (dt / 1000); };
  const jsSps = time(() => jsFn(...jsArgs()));
  const waSps = time(callWasm);
  console.log(`${String(N).padStart(7)} | ${jsSps.toFixed(0).padStart(10)} | ${waSps.toFixed(0).padStart(12)} | ${(waSps / jsSps).toFixed(2)}x`);
}
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });
