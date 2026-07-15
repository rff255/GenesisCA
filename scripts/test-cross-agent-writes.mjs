// Cross-agent write semantics — verification.
//   Part A: cross-agent OVERWRITE writes are async-only (sync-mode gate) with the
//           one-hop createAgent-handle exemption (spawn config).
//   Part B: Apply Force To Agent (commutative) — JS emit + WASM gate/module +
//           WebGPU WGSL generation (forceScatterAdd + binding 14 + force binding 4).
// JS↔WASM runtime bit-parity for Apply Force To Agent lives in parity-agent-wasm.mjs.
// Real-GPU shader compilation is verified in the browser (createShaderModule).
//
// Run from the repo root:  node scripts/test-cross-agent-writes.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileAgentGraphWasmForModel, isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { emitAgentForcePassWGSL } from '../src/modeler/vpl/compiler/agentWebgpu/forcePass.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-xagent-'));
const entryPath = join(ROOT, 'scripts', '__xagent_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

const mkG = () => {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const nodes = [], edges = [];
  const n = (t, c = {}) => { const x = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; nodes.push(x); return x; };
  const v = (s, sp, t, tp) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
  const f = (s, sp, t, tp) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });
  return { nodes, edges, n, v, f };
};

// A minimal agent model shell (2D, customForces so only graph forces apply).
const shell = (g, updateMode, extra = {}) => M.migrateForHarness({
  schemaVersion: 1,
  properties: { name: 'X', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
  topologyMode: { gridCells: false, agents: true },
  centerBased: { enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 20, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0.9, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'js', agentUpdateMode: updateMode,
    agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
  attributes: [], modelAttributes: [], neighborhoods: [],
  agentAttributes: [{ id: 'sig', name: 'Sig', type: 'float', defaultValue: '0' }],
  variables: [], agentVariables: [], indicators: [], mappings: [],
  graphNodes: [], graphEdges: [], agentGraphNodes: g.nodes, agentGraphEdges: g.edges, macroDefs: [], ...extra,
});

// ---------------------------------------------------------------------------
// Part A — sync-mode cross-agent OVERWRITE gate
// ---------------------------------------------------------------------------
console.log('\nPart A — sync-mode cross-agent overwrite gate');

// (1) sync + setAgentAttribute to an EXISTING agent (from Get Nearby Agents) → ERROR.
{
  const g = mkG();
  const bs = g.n('behaviourStep');
  const near = g.n('getNearbyAgents', { _port_radius: '6' });
  const fe = g.n('forEachInArray');
  const set = g.n('setAgentAttribute', { attributeId: 'sig', _port_value: '1' });
  g.f(bs, 'do', fe, 'do'); g.v(near, 'agents', fe, 'array');
  g.f(fe, 'body', set, 'do'); g.v(fe, 'element', set, 'agentId');
  const m = shell(g, 'sync');
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('sync + Set Agent Attribute to existing agent → compile error', !!r.error && /Synchronous/.test(r.error), r.error || 'no error');
}

// (2) SAME graph but ASYNC → compiles (async is the intended home).
{
  const g = mkG();
  const bs = g.n('behaviourStep');
  const near = g.n('getNearbyAgents', { _port_radius: '6' });
  const fe = g.n('forEachInArray');
  const set = g.n('setAgentAttribute', { attributeId: 'sig', _port_value: '1' });
  g.f(bs, 'do', fe, 'do'); g.v(near, 'agents', fe, 'array');
  g.f(fe, 'body', set, 'do'); g.v(fe, 'element', set, 'agentId');
  const m = shell(g, 'async');
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('async + Set Agent Attribute to existing agent → compiles', !r.error, r.error);
}

// (3) sync + setAgentAttribute to a freshly-Created handle (spawn config) → EXEMPT, compiles.
{
  const g = mkG();
  const bs = g.n('behaviourStep');
  const create = g.n('createAgent', { _port_x: '1', _port_y: '1', _port_radius: '0.5' });
  const set = g.n('setAgentAttribute', { attributeId: 'sig', _port_value: '9' });
  const add = g.n('addAgentToWorld');
  g.f(bs, 'do', create, 'do'); g.f(create, 'next', set, 'do'); g.f(set, 'next', add, 'do');
  g.v(create, 'handle', set, 'agentId'); g.v(create, 'handle', add, 'handle');
  const m = shell(g, 'sync');
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('sync + Set Agent Attribute on a Create Agent handle → exempt, compiles', !r.error, r.error);
}

// ---------------------------------------------------------------------------
// Part B — Apply Force To Agent, all three targets
// ---------------------------------------------------------------------------
console.log('\nPart B — Apply Force To Agent (JS / WASM / WebGPU)');

const buildForceModel = (is3d) => {
  const g = mkG();
  const bs = g.n('behaviourStep');
  const near = g.n('getNearbyAgents', { _port_radius: '6' });
  const fe = g.n('forEachInArray');
  const af = g.n('applyForceToAgent', { _port_fx: '0.03', _port_fy: '-0.02', _port_fz: '0.01' });
  g.f(bs, 'do', fe, 'do'); g.v(near, 'agents', fe, 'array');
  g.f(fe, 'body', af, 'do'); g.v(fe, 'element', af, 'agentId');
  const extra = is3d ? { properties: { name: 'X', dimension: '3d', gridWidth: 24, gridHeight: 24, gridDepth: 8, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false } } : {};
  const m = shell(g, 'async', extra);
  if (is3d) m.centerBased.worldDepth = 8;
  return m;
};

// JS
{
  const m = buildForceModel(false);
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('JS: compiles', !r.error, r.error);
  check('JS: emits cross-agent force accumulate (_agentForceX[__af] +=)', /_agentForceX\[__af\]\s*\+=/.test(r.behaviourCode || ''));
}

// WASM
{
  const m = buildForceModel(false);
  check('WASM: gate accepts applyForceToAgent', M.isAgentGraphWasmSupported(m) === true);
  const r = M.compileAgentGraphWasmForModel(m);
  check('WASM: module compiles (bytes emitted)', !!r && !r.error && r.bytes && r.bytes.length > 0, r && r.error);
}

// WebGPU — 2D
{
  const m = buildForceModel(false);
  check('WebGPU: gate accepts applyForceToAgent', M.isAgentGraphWebGPUSupported(m) === true);
  const r = M.compileAgentGraphWebGPUForModel(m);
  check('WebGPU: behaviour shader compiled (no error)', !r.error, r.error);
  check('WebGPU: usesForceScatter flag set', r.usesForceScatter === true);
  check('WebGPU: behaviour declares binding 14 forceScatter', /@binding\(14\)[^\n]*forceScatter\s*:\s*array<atomic<u32>>/.test(r.shaderCode));
  check('WebGPU: behaviour emits forceScatterAdd helper + calls', /fn forceScatterAdd/.test(r.shaderCode) && /forceScatterAdd\(/.test(r.shaderCode));
  const force = M.emitAgentForcePassWGSL(r.layout, r.usesForceScatter);
  check('WebGPU: force pass declares binding 4 forceScatter', /@binding\(4\)[^\n]*forceScatter\s*:\s*array<u32>/.test(force));
  check('WebGPU: force pass folds scatter into seed (bitcast<f32>(forceScatter[)', /bitcast<f32>\(forceScatter\[/.test(force));
  // A NO-force-scatter force pass (Boids) must NOT reference forceScatter (byte-safe).
  const forcePlain = M.emitAgentForcePassWGSL(r.layout, false);
  check('WebGPU: force pass WITHOUT scatter has no forceScatter reference', !/forceScatter/.test(forcePlain));
}

// WebGPU — 3D (z component + region 2*MA)
{
  const m = buildForceModel(true);
  const r = M.compileAgentGraphWebGPUForModel(m);
  check('WebGPU 3D: compiles + usesForceScatter', !r.error && r.usesForceScatter === true, r.error);
  const MA = r.layout.maxAgents;
  check('WebGPU 3D: behaviour scatters Z region (2*maxAgents stride)', new RegExp(`forceScatterAdd\\(${2 * MA}u`).test(r.shaderCode), `MA=${MA}`);
  const force = M.emitAgentForcePassWGSL(r.layout, r.usesForceScatter);
  check('WebGPU 3D: force pass reads Z scatter region', new RegExp(`forceScatter\\[${2 * MA}u`).test(force));
}

// ---------------------------------------------------------------------------
// Part C — Apply Force To Agents (array broadcast) lowers to For Each → single node
// ---------------------------------------------------------------------------
console.log('\nPart C — Apply Force To Agents (array broadcast, lowered)');

const buildForceArrayModel = (is3d) => {
  const g = mkG();
  const bs = g.n('behaviourStep');
  const near = g.n('getNearbyAgents', { _port_radius: '6' });
  const afs = g.n('applyForceToAgents', { _port_fx: '0.03', _port_fy: '-0.02', _port_fz: '0.01' });
  g.f(bs, 'do', afs, 'do'); g.v(near, 'agents', afs, 'agents');
  const extra = is3d ? { properties: { name: 'X', dimension: '3d', gridWidth: 24, gridHeight: 24, gridDepth: 8, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false } } : {};
  const m = shell(g, 'async', extra);
  if (is3d) m.centerBased.worldDepth = 8;
  return m;
};

// JS — lowers to For Each In Array (a `for` loop) wrapping the single-node force accumulate.
{
  const m = buildForceArrayModel(false);
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('JS: array node compiles', !r.error, r.error);
  check('JS: lowered to For Each (emits a for-loop)', /for\s*\(/.test(r.behaviourCode || ''));
  check('JS: reuses the single-node force accumulate (_agentForceX[__af] +=)', /_agentForceX\[__af\]\s*\+=/.test(r.behaviourCode || ''));
  check('JS: no applyForceToAgents survives (lowered away)', !/applyForceToAgents/.test(r.behaviourCode || ''));
}
// WASM — the gate sees only forEach + applyForceToAgent (both supported) → accepts.
{
  const m = buildForceArrayModel(false);
  check('WASM: gate accepts (via lowering)', M.isAgentGraphWasmSupported(m) === true);
  const r = M.compileAgentGraphWasmForModel(m);
  check('WASM: module compiles', !!r && !r.error && r.bytes && r.bytes.length > 0, r && r.error);
}
// WebGPU — same, and the force-scatter path is reached through the lowered single node.
{
  const m = buildForceArrayModel(false);
  check('WebGPU: gate accepts (via lowering)', M.isAgentGraphWebGPUSupported(m) === true);
  const r = M.compileAgentGraphWebGPUForModel(m);
  check('WebGPU: compiles + usesForceScatter (via lowered single node)', !r.error && r.usesForceScatter === true, r.error);
  check('WebGPU: emits forceScatterAdd', /forceScatterAdd\(/.test(r.shaderCode));
}
// 3D — the z force lowers through too.
{
  const m = buildForceArrayModel(true);
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('JS 3D: array node emits z accumulate', /_agentForceZ\[__af\]\s*\+=/.test(r.behaviourCode || ''), r.error);
}

console.log(failures === 0 ? '\nALL CROSS-AGENT-WRITE CHECKS ✓' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
