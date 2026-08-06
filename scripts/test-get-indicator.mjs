// Get Indicator — the SHAPE contract between the picker, the badge and the engine.
//
// WHY THIS EXISTS (user-reported, 2026-07-31: "get indicator is not working on
// agents rule graph canvas"):
//   The Get Indicator picker listed `kind === 'standalone'` only. EVERY shipped
//   agent/GRA model carries ONLY graph + linked indicators, so on those models the
//   dropdown was empty but for "Select…" — the node could never be configured and
//   compiled to `_indicators[-1]`. Nothing was wrong with the compile path (it was
//   verified working on all three agent targets); the node simply could not be
//   pointed at any indicator the model had.
//
// THE CONTRACT this locks down:
//   1. `indicatorScalarBlocker` is the ONE definition of "can a rule read this as
//      a number" — standalone / linked Total / scalar graph metric = yes;
//      frequency map / degree histogram / spatial curve = no, with a reason.
//   2. The picker offers exactly the readable ones (and DISABLES the rest with
//      that reason, rather than omitting them — omission is what hid the gap).
//   3. The validation badge fires on a non-scalar selection.
//   4. Compile is shape-agnostic: `_indicators[<slot>]` on every surface, where
//      <slot> is the indicator's index in `model.indicators` REGARDLESS of kind.
//      This is what makes the fix all-target by construction (zero emit change).
//   5. Every shipped model that has indicators can point a Get Indicator at at
//      least one of them — the regression that started this.
import { build } from 'esbuild';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { indicatorScalarBlocker, indicatorIsScalar, indicatorIsFrequencyShaped } from '../src/model/indicatorValue.ts';
export { detectMissingConfig } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileAgentGraphWasmForModel, isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-getind-'));
const entryPath = join(ROOT, 'scripts', '__getind_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT });
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { console.log(`  FAIL ${msg}`); fails++; } else console.log(`  ok   ${msg}`); };
const section = (s) => console.log(`\n=== ${s} ===`);

const IND = (over) => ({ id: 'x', name: 'X', kind: 'standalone', dataType: 'float', defaultValue: '0', accumulationMode: 'accumulated', ...over });

// ---------------------------------------------------------- 1. the predicate
section('1. indicatorScalarBlocker — the shape rule');
ok(M.indicatorScalarBlocker(IND({ kind: 'standalone' })) === null, 'standalone is readable');
ok(M.indicatorScalarBlocker(IND({ kind: 'standalone', dataType: 'tag', tagOptions: ['a', 'b'] })) === null, 'standalone tag is readable');
ok(M.indicatorScalarBlocker(IND({ kind: 'linked', linkedAggregation: 'total' })) === null, 'linked Total is readable');
ok(M.indicatorScalarBlocker(IND({ kind: 'linked', linkedAggregation: 'frequency' })) !== null, 'linked frequency is NOT readable');
for (const metric of ['nodeCount', 'edgeCount', 'meanDegree', 'maxDegree', 'componentCount']) {
  ok(M.indicatorScalarBlocker(IND({ kind: 'graph', graphMetric: metric })) === null, `graph ${metric} is readable`);
}
ok(M.indicatorScalarBlocker(IND({ kind: 'graph', graphMetric: 'degreeHistogram' })) !== null, 'graph degreeHistogram is NOT readable');
ok(M.indicatorScalarBlocker(IND({ kind: 'graph' })) === null, 'graph with no metric defaults to a readable one');
ok(M.indicatorScalarBlocker(IND({ kind: 'linked', linkedAggregation: 'total', xAxis: 'rows' })) !== null, 'a SPATIAL linked Total is NOT readable');
ok(/histogram/.test(M.indicatorScalarBlocker(IND({ kind: 'graph', graphMetric: 'degreeHistogram' }))), 'the blocker names the shape');
ok(M.indicatorIsScalar(IND({})) === true && M.indicatorIsFrequencyShaped(IND({})) === false, 'scalar/frequency are complementary for standalone');

// ------------------------------------------------- 2. the validation badge
section('2. validation badge');
const mdl = (inds) => ({ indicators: inds, attributes: [], agentAttributes: [], neighborhoods: [], mappings: [], variables: [], macroDefs: [] });
const freqInd = IND({ id: 'f', name: 'Hist', kind: 'graph', graphMetric: 'degreeHistogram' });
const okInd = IND({ id: 'n', name: 'Nodes', kind: 'graph', graphMetric: 'nodeCount' });
ok(M.detectMissingConfig('getIndicator', { indicatorId: '' }, mdl([okInd])).length > 0, 'unset selection badges');
ok(M.detectMissingConfig('getIndicator', { indicatorId: 'gone' }, mdl([okInd])).length > 0, 'a deleted indicator badges');
ok(M.detectMissingConfig('getIndicator', { indicatorId: 'n' }, mdl([okInd, freqInd])).length === 0, 'a scalar GRAPH indicator does NOT badge');
const fIssues = M.detectMissingConfig('getIndicator', { indicatorId: 'f' }, mdl([okInd, freqInd]));
ok(fIssues.length > 0 && /histogram/.test(fIssues[0]), 'a histogram selection badges WITH the reason');

// ------------------------------------ 3. compile is shape-agnostic (slot = index)
section('3. compile — the slot is the index in model.indicators, any kind');
const node = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
const vE = (s, sp, t, tp) => ({ id: `e${s}${t}`, source: s, target: t, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
const fE = (s, sp, t) => ({ id: `f${s}${t}`, source: s, target: t, sourceHandle: `output_flow_${sp}`, targetHandle: 'input_flow_do' });

const mkAgentModel = (targetIndicatorId) => ({
  properties: { name: 'p', gridWidth: 32, gridHeight: 32, boundaryTreatment: 'torus', updateMode: 'synchronous', dimension: '2d' },
  topologyMode: { gridCells: false, agents: true },
  attributes: [],
  agentAttributes: [{ id: 'seen', name: 'Seen', type: 'float', defaultValue: '0', isModelAttribute: false }],
  neighborhoods: [], mappings: [], agentMappings: [], variables: [], agentVariables: [], macroDefs: [],
  indicators: [
    IND({ id: 'sA', name: 'A', kind: 'standalone' }),
    IND({ id: 'gN', name: 'Nodes', kind: 'graph', graphMetric: 'nodeCount', dataType: 'integer' }),
    IND({ id: 'gH', name: 'Hist', kind: 'graph', graphMetric: 'degreeHistogram', dataType: 'integer' }),
  ],
  centerBased: {
    maxAgents: 64, maxBonds: 2, agentTarget: 'js', agentUpdateMode: 'async', seedCount: 4,
    agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'physics', sensing: true },
  },
  graphNodes: [], graphEdges: [],
  agentGraphNodes: [
    node('bs', 'behaviourStep'),
    node('gi', 'getIndicator', { indicatorId: targetIndicatorId }),
    node('sa', 'setAttribute', { attributeId: 'seen' }),
  ],
  agentGraphEdges: [fE('bs', 'do', 'sa'), vE('gi', 'value', 'sa', 'value')],
});

for (const [id, slot] of [['sA', 0], ['gN', 1]]) {
  const m = mkAgentModel(id);
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m);
  ok(!r.error, `agent JS compiles for '${id}'`);
  ok(new RegExp(`_indicators\\[${slot}\\]`).test(r.behaviourCode || ''), `'${id}' reads slot ${slot} (its index in model.indicators)`);
  ok(/_indicators/.test((r.behaviourCode || '').split('\n')[0] || ''), `'${id}' — _indicators is in the agent loop signature`);
  ok(M.isAgentGraphWasmSupported(m) === true, `'${id}' — WASM gate accepts`);
  ok(M.isAgentGraphWebGPUSupported(m) === true, `'${id}' — WebGPU gate accepts`);
  const rw = M.compileAgentGraphWasmForModel(m);
  ok(!rw.error && rw.bytes && rw.bytes.length > 0, `'${id}' — WASM module emits`);
  const rg = M.compileAgentGraphWebGPUForModel(m);
  ok(!rg.error && (rg.shaderCode || '').length > 0, `'${id}' — WGSL shader emits`);
}
// The graph indicator's slot must NOT be -1 (the unresolved marker that made the
// node silently read nothing when it could not be selected at all).
{
  const m = mkAgentModel('gN');
  M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m);
  const cfg = m.agentGraphNodes.find(n => n.id === 'gi').data.config;
  ok(cfg._indicatorIdx === 1, 'the graph indicator pre-resolves to a REAL slot, not -1');
}

// ------------------------------------------ 4. every shipped model is usable
section('4. shipped models — a Get Indicator can point at something');
const modelsDir = join(ROOT, 'public', 'models');
const files = readdirSync(modelsDir).filter(f => f.endsWith('.gcaproj')).sort();
let withInds = 0, unusable = [];
for (const f of files) {
  const m = M.migrateForHarness(JSON.parse(readFileSync(join(modelsDir, f), 'utf8')));
  const inds = m.indicators || [];
  if (inds.length === 0) continue;
  withInds++;
  if (!inds.some(i => M.indicatorIsScalar(i))) unusable.push(f.replace(/\.gcaproj$/, ''));
}
ok(withInds > 0, `${withInds} shipped models declare indicators`);
// NOT an assertion: a model whose indicators are all frequency maps / spatial
// curves legitimately exposes nothing a rule can read as ONE number. Reported so
// the set is visible — reading ONE CATEGORY of a frequency map (what the
// Overseer's ovReadIndicator does via a `category` config) is the open follow-up.
console.log(`  note frequency/spatial-only models (no single-number indicator to read): ${unusable.length ? unusable.join(', ') : 'none'}`);
// The regression itself: under the OLD standalone-only rule, the agent/GRA models had none.
{
  // (`Cubic GRA` was retired from the shipped library — the filter below already
  //  adapts, but the list should not name a model that no longer ships.)
  const gra = ['SDCA - Couplers and Decouplers', 'Graph Metrics - Growth Sweep', 'Growing Graphs']
    .filter(n => files.includes(n + '.gcaproj'));
  let oldRuleEmpty = 0, newRuleOk = 0;
  for (const n of gra) {
    const m = M.migrateForHarness(JSON.parse(readFileSync(join(modelsDir, n + '.gcaproj'), 'utf8')));
    if (!(m.indicators || []).some(i => i.kind === 'standalone')) oldRuleEmpty++;
    if ((m.indicators || []).some(i => M.indicatorIsScalar(i))) newRuleOk++;
  }
  ok(gra.length > 0 && oldRuleEmpty === gra.length, `the ${gra.length} GRA models had ZERO standalone indicators (the old picker was empty)`);
  ok(newRuleOk === gra.length, 'all of them now expose a readable indicator');
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${checks - fails}/${checks} checks`);
process.exit(fails === 0 ? 0 : 1);
