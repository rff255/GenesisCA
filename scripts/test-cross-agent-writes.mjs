// Cross-agent write semantics — verification.
//   Part A: cross-agent OVERWRITE writes are async-only (sync-mode gate) with the
//           one-hop createAgent-handle exemption (spawn config).
//   Part B: Apply Force To Agent (commutative) — JS emit + WASM gate/module +
//           WebGPU WGSL generation (forceScatterAdd + binding 14 + force binding 4).
//   Part D: the OPTIONAL agent id on Set Attribute — unwired = self (the historical
//           emit, byte-for-byte), wired = the by-id write, on all three targets.
//   Part E: the `setAgentAttribute` RETIREMENT migration — a pure nodeType rename
//           whose output emits byte-identically to a hand-authored Set Attribute.
//   Part F: the `Agent` port is SCALAR-OR-ARRAY — an id ARRAY writes EVERY agent
//           in it (the retired `setAgentsAttribute`), incl. multi-slot x array,
//           plus that node's RETIREMENT migration (rename + one handle rewrite).
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
export { migrateSetAgentAttribute } from '../src/model/setAgentAttributeMigration.ts';
export { migrateSetAgentsAttribute } from '../src/model/setAgentsAttributeMigration.ts';
export { getNodeDef } from '../src/modeler/vpl/nodes/registry.ts';
export { compileGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { getEffectivePorts } from '../src/modeler/vpl/effectivePorts.ts';
export { setActiveGraphKind } from '../src/modeler/vpl/graphState.ts';
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

// (1) sync + a WIRED Set Attribute to an EXISTING agent (from Get Nearby Agents) → ERROR.
{
  const g = mkG();
  const bs = g.n('behaviourStep');
  const near = g.n('getNearbyAgents', { _port_radius: '6' });
  const fe = g.n('forEachInArray');
  const set = g.n('setAttribute', { attributeId: 'sig', _port_value: '1' });
  g.f(bs, 'do', fe, 'do'); g.v(near, 'agents', fe, 'array');
  g.f(fe, 'body', set, 'do'); g.v(fe, 'element', set, 'agentId');
  const m = shell(g, 'sync');
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('sync + wired Set Attribute to existing agent → compile error', !!r.error && /Synchronous/.test(r.error), r.error || 'no error');
}

// (2) SAME graph but ASYNC → compiles (async is the intended home).
{
  const g = mkG();
  const bs = g.n('behaviourStep');
  const near = g.n('getNearbyAgents', { _port_radius: '6' });
  const fe = g.n('forEachInArray');
  const set = g.n('setAttribute', { attributeId: 'sig', _port_value: '1' });
  g.f(bs, 'do', fe, 'do'); g.v(near, 'agents', fe, 'array');
  g.f(fe, 'body', set, 'do'); g.v(fe, 'element', set, 'agentId');
  const m = shell(g, 'async');
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('async + wired Set Attribute to existing agent → compiles', !r.error, r.error);
}

// (3) sync + a WIRED Set Attribute to a freshly-Created handle (spawn config) → EXEMPT, compiles.
{
  const g = mkG();
  const bs = g.n('behaviourStep');
  const create = g.n('createAgent', { _port_x: '1', _port_y: '1', _port_radius: '0.5' });
  const set = g.n('setAttribute', { attributeId: 'sig', _port_value: '9' });
  const add = g.n('addAgentToWorld');
  g.f(bs, 'do', create, 'do'); g.f(create, 'next', set, 'do'); g.f(set, 'next', add, 'do');
  g.v(create, 'handle', set, 'agentId'); g.v(create, 'handle', add, 'handle');
  const m = shell(g, 'sync');
  const r = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('sync + wired Set Attribute on a Create Agent handle → exempt, compiles', !r.error, r.error);
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

// ---------------------------------------------------------------------------
// Part D — Set Attribute's OPTIONAL agent id (unwired = self, wired = by id)
// ---------------------------------------------------------------------------
console.log('\nPart D — Set Attribute: optional agent id');

// The graph-conditional PORT: `agentId` exists only while the editor is on the
// AGENTS sub-tab. Both port consumers (CaNode + effectivePorts) thread
// `getActiveGraphKind()` into the declarative `hiddenPorts` hook, so this pins
// the mechanism itself.
{
  const ids = () => M.getEffectivePorts('setAttribute', { attributeId: 'sig' }).inputs.map(p => p.id);
  M.setActiveGraphKind('cells');
  check('ports: CELLS graph hides `agentId`', !ids().includes('agentId') && ids().includes('value'));
  M.setActiveGraphKind('agents');
  check('ports: AGENTS graph shows `agentId`', ids().includes('agentId'));
  M.setActiveGraphKind('overseer');
  check('ports: OVERSEER graph hides `agentId`', !ids().includes('agentId'));
  M.setActiveGraphKind('cells');   // restore the default for the rest of the run
}

/** A behaviour graph whose single Set Attribute is either self-targeted
 *  (`wired` false) or aimed at a neighbour id (`wired` true). ASYNC so the
 *  cross-agent gate lets the wired form through. */
const buildSetAttrModel = (wired) => {
  const g = mkG();
  const bs = g.n('behaviourStep');
  const set = g.n('setAttribute', { attributeId: 'sig', _port_value: '3' });
  if (wired) {
    const near = g.n('getNearbyAgents', { _port_radius: '6' });
    const fe = g.n('forEachInArray');
    g.f(bs, 'do', fe, 'do'); g.v(near, 'agents', fe, 'array');
    g.f(fe, 'body', set, 'do'); g.v(fe, 'element', set, 'agentId');
  } else {
    g.f(bs, 'do', set, 'do');
  }
  return shell(g, 'async');
};

{
  const m = buildSetAttrModel(false);
  const js = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('JS unwired: the historical self write `w_sig[idx] = 3;`',
    /w_sig\[idx\] = 3;/.test(js.behaviourCode || '') && !/__sa/.test(js.behaviourCode || ''), js.error);
}
{
  const m = buildSetAttrModel(true);
  const js = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  // Exactly the retired Set Agent Attribute emit: a `__sa` temp + the relaxed
  // range-only guard + a by-id write.
  check('JS wired: `{ const __sa=…; if(__sa>=0&&__sa<_agentMaxAgents) w_sig[__sa] = 3; }`',
    /\{ const __sa=\(\(.+?\) \| 0\); if\(__sa>=0&&__sa<_agentMaxAgents\) w_sig\[__sa\] = 3; \}/.test(js.behaviourCode || ''), js.error);
  check('JS wired: no self write remains', !/w_sig\[idx\]/.test(js.behaviourCode || ''));
}
// The two shapes must produce DIFFERENT WASM bytes (wiredness really reaches the
// emitter) and both must pass the gate + compile on the agent targets.
{
  const a = buildSetAttrModel(false), b = buildSetAttrModel(true);
  check('WASM: both shapes pass the gate',
    M.isAgentGraphWasmSupported(a) === true && M.isAgentGraphWasmSupported(b) === true);
  const ra = M.compileAgentGraphWasmForModel(a), rb = M.compileAgentGraphWasmForModel(b);
  check('WASM: both modules compile', !ra.error && !rb.error && ra.bytes?.length > 0 && rb.bytes?.length > 0, ra.error || rb.error);
  check('WASM: the wired module differs from the self one',
    Buffer.from(ra.bytes).toString('base64') !== Buffer.from(rb.bytes).toString('base64'));
  // WebGPU: the wired form is a cross-agent overwrite aimed at a NON-spawn id, so
  // the gate must REJECT it (the documented parallel-write-order fundamental),
  // while the self form is accepted and emits the plain unguarded line.
  check('WebGPU: self form accepted', M.isAgentGraphWebGPUSupported(a) === true);
  check('WebGPU: wired non-spawn form rejected (parallel write order)', M.isAgentGraphWebGPUSupported(b) === false);
  const wa = M.compileAgentGraphWebGPUForModel(a);
  check('WebGPU: self form emits no by-id guard', !wa.error && !/saa/.test(wa.shaderCode || ''), wa.error);
}
// A CELL graph never renders the port, and the compilers gate on
// CompileContext.agentGraph — so the cell emit is the plain historical line.
{
  const m = M.migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'C', dimension: '2d', gridWidth: 8, gridHeight: 8, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false, updateMode: 'synchronous' },
    topologyMode: { gridCells: true, agents: false },
    attributes: [{ id: 'c', name: 'C', type: 'float', defaultValue: '0' }],
    neighborhoods: [], variables: [], indicators: [], mappings: [], macroDefs: [],
    graphNodes: [
      { id: 'st', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'step', config: {} } },
      { id: 'sa', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'setAttribute', config: { attributeId: 'c', _port_value: '5' } } },
    ],
    graphEdges: [{ id: 'e0', source: 'st', target: 'sa', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' }],
    agentGraphNodes: [], agentGraphEdges: [],
  });
  const r = M.compileGraph(m.graphNodes, m.graphEdges, m);
  check('cell graph: Set Attribute still emits the plain `w_c[idx] = 5`',
    /w_c\[idx\] = 5;/.test(r.stepCode || '') && !/__sa/.test(r.stepCode || ''), r.error);
}

// ---------------------------------------------------------------------------
// Part E — the `setAgentAttribute` retirement migration
// ---------------------------------------------------------------------------
console.log('\nPart E — Set Agent Attribute retirement migration');

/** The same graph twice: once with the LEGACY node type, once hand-authored on
 *  the consolidated node. Ids are FIXED so the two are structurally identical —
 *  which is what makes the emitted-code comparison meaningful. `extraCount`
 *  exercises the multi-slot expansion (and its shared-agentId FAN-OUT). */
const buildPair = (type) => ({
  nodes: [
    { id: 'bs', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'behaviourStep', config: {} } },
    { id: 'nb', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'getNearbyAgents', config: { _port_radius: '6' } } },
    { id: 'fe', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'forEachInArray', config: {} } },
    { id: 'sa', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: type, config: { attributeId: 'sig', _port_value: '2', extraCount: 1, attr_2: 'sig2', _port_value_2: '4' } } },
  ],
  edges: [
    { id: 'e0', source: 'bs', target: 'fe', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' },
    { id: 'e1', source: 'nb', target: 'fe', sourceHandle: 'output_value_agents', targetHandle: 'input_value_array' },
    { id: 'e2', source: 'fe', target: 'sa', sourceHandle: 'output_flow_body', targetHandle: 'input_flow_do' },
    { id: 'e3', source: 'fe', target: 'sa', sourceHandle: 'output_value_element', targetHandle: 'input_value_agentId' },
  ],
});
const twoAttrShell = (g) => {
  const m = shell({ nodes: g.nodes, edges: g.edges }, 'async');
  m.agentAttributes = [
    { id: 'sig', name: 'Sig', type: 'float', defaultValue: '0' },
    { id: 'sig2', name: 'Sig2', type: 'float', defaultValue: '0' },
  ];
  return m;
};

{
  const legacy = buildPair('setAgentAttribute');
  const migrated = M.migrateSetAgentAttribute({ agentGraphNodes: legacy.nodes, agentGraphEdges: legacy.edges, macroDefs: [] });
  const mn = migrated.agentGraphNodes.find(n => n.id === 'sa');
  check('migration: nodeType flips to setAttribute', mn.data.nodeType === 'setAttribute');
  check('migration: config carried over verbatim',
    JSON.stringify(mn.data.config) === JSON.stringify(legacy.nodes.find(n => n.id === 'sa').data.config));
  check('migration: EDGES untouched (same array reference — every handle id already matched)',
    migrated.agentGraphEdges === legacy.edges);
  check('migration: node ids + order preserved',
    migrated.agentGraphNodes.map(n => n.id).join(',') === 'bs,nb,fe,sa');
  check('migration: idempotent (same reference on a clean model)',
    M.migrateSetAgentAttribute(migrated) === migrated);
  const inMac = M.migrateSetAgentAttribute({
    agentGraphNodes: [], agentGraphEdges: [],
    macroDefs: [{ id: 'm', nodes: buildPair('setAgentAttribute').nodes, edges: [] }],
  });
  check('migration: macroDefs swept', inMac.macroDefs[0].nodes.find(n => n.id === 'sa').data.nodeType === 'setAttribute');

  // THE LOAD-BEARING CHECK — a migrated legacy graph and a hand-authored one emit
  // byte-identical code on JS *and* WASM (the guarantee the shipped models rely on).
  const mMig = twoAttrShell({ nodes: migrated.agentGraphNodes, edges: migrated.agentGraphEdges });
  const mNew = twoAttrShell(buildPair('setAttribute'));
  const jsMig = M.compileAgentGraph(mMig.agentGraphNodes, mMig.agentGraphEdges, mMig, 0);
  const jsNew = M.compileAgentGraph(mNew.agentGraphNodes, mNew.agentGraphEdges, mNew, 0);
  check('migrated == hand-authored: JS behaviour code byte-identical',
    !jsMig.error && !jsNew.error && jsMig.behaviourCode === jsNew.behaviourCode, jsMig.error || jsNew.error);
  check('migrated: the by-id write survives multi-slot expansion (BOTH slots guarded)',
    (jsMig.behaviourCode.match(/if\(__sa>=0&&__sa<_agentMaxAgents\)/g) || []).length === 2
    && /w_sig\[__sa\] = 2;/.test(jsMig.behaviourCode) && /w_sig2\[__sa\] = 4;/.test(jsMig.behaviourCode));
  const wMig = M.compileAgentGraphWasmForModel(mMig), wNew = M.compileAgentGraphWasmForModel(mNew);
  check('migrated == hand-authored: WASM module bytes byte-identical',
    !wMig.error && !wNew.error && wMig.bytes.length > 0
    && Buffer.from(wMig.bytes).toString('base64') === Buffer.from(wNew.bytes).toString('base64'),
    wMig.error || wNew.error);
}

// ---------------------------------------------------------------------------
// Part F — the `Agent` port is SCALAR-OR-ARRAY (+ the Set Agents Attribute retire)
// ---------------------------------------------------------------------------
console.log('\nPart F — Set Attribute: id ARRAY (write-many) + Set Agents Attribute retirement');

// The retired node is gone from the registry — one Set Attribute, no second
// spelling of the same write.
check('registry: `setAgentsAttribute` is no longer a node type', M.getNodeDef('setAgentsAttribute') === undefined);
check('registry: `setAttribute` is still there', M.getNodeDef('setAttribute') !== undefined);

// The port stays scalar-TYPED (an id) but is ARRAY-CAPABLE, which is what makes
// the connection-suggestion layer offer the agent-array producers on it.
{
  M.setActiveGraphKind('agents');
  const p = M.getEffectivePorts('setAttribute', { attributeId: 'sig' }).inputs.find(x => x.id === 'agentId');
  check('ports: `agentId` is arrayCapable (suggestion layer offers array sources)',
    !!p && p.arrayCapable === true && p.isArray !== true);
  M.setActiveGraphKind('cells');
}

/** A behaviour graph whose Set Attribute takes the WHOLE Get Nearby Agents id
 *  array on its `Agent` port (no For Each — the node loops internally). */
const buildArrayModel = (type, extra = {}) => ({
  nodes: [
    { id: 'bs', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'behaviourStep', config: {} } },
    { id: 'nb', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'getNearbyAgents', config: { _port_radius: '6' } } },
    { id: 'sa', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: type, config: { attributeId: 'sig', _port_value: '7', ...extra } } },
  ],
  edges: [
    { id: 'e0', source: 'bs', target: 'sa', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' },
    { id: 'e1', source: 'nb', target: 'sa', sourceHandle: 'output_value_agents',
      targetHandle: type === 'setAgentsAttribute' ? 'input_value_agents' : 'input_value_agentId' },
  ],
});

// --- the JS array arm: the write-many loop, with the STRICT live-agent guard ---
{
  const m = twoAttrShell(buildArrayModel('setAttribute'));
  const js = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  check('JS array: emits the `_si`/`_sa` write-many loop over the id array',
    /const __arr=_v\w+; const __val=7;/.test(js.behaviourCode || '')
    && /for \(let _sisa = 0; _sisa < __arr\.length; _sisa\+\+\)/.test(js.behaviourCode || '')
    && /const _sasa = \(__arr\[_sisa\]\) \| 0;/.test(js.behaviourCode || ''), js.error);
  check('JS array: each id keeps the STRICT live-agent guard (an array comes from a live query)',
    /if \(_sasa >= 0 && _sasa < highWater && _alive\[_sasa\]\) w_sig\[_sasa\] = __val;/.test(js.behaviourCode || ''));
  check('JS array: neither the self nor the scalar by-id arm is emitted',
    !/w_sig\[idx\]/.test(js.behaviourCode || '') && !/__sa=/.test(js.behaviourCode || ''));
}

// --- the three modes are three DIFFERENT emits on JS *and* WASM ---
{
  const self = buildSetAttrModel(false);
  const scalar = buildSetAttrModel(true);
  const arr = twoAttrShell(buildArrayModel('setAttribute'));
  const [a, b, c] = [self, scalar, arr].map(m => M.compileAgentGraphWasmForModel(m));
  check('WASM: all three modes pass the gate',
    [self, scalar, arr].every(m => M.isAgentGraphWasmSupported(m) === true));
  check('WASM: all three modules compile', !a.error && !b.error && !c.error && c.bytes?.length > 0,
    a.error || b.error || c.error);
  const b64 = (r) => Buffer.from(r.bytes).toString('base64');
  check('WASM: the array module differs from BOTH the self and the scalar-by-id ones',
    b64(c) !== b64(a) && b64(c) !== b64(b));
  // WebGPU: an ARRAY id is a cross-agent OVERWRITE aimed at a non-spawn target,
  // so the same parallel-write-order gate that rejects the scalar form rejects it.
  check('WebGPU: array-wired form rejected by the cross-agent gate', M.isAgentGraphWebGPUSupported(arr) === false);
  // …but the EMIT exists (defence in depth — an OM module has its own gate).
  const w = M.compileAgentGraphWebGPUForModel(arr);
  check('WebGPU: the array arm emits the sasK/sasId/sasV write-many loop',
    !w.error && /sasV/.test(w.shaderCode || '') && /sasK/.test(w.shaderCode || '') && /sasId/.test(w.shaderCode || ''), w.error);
}

// --- MULTI-SLOT x ARRAY: the shared `Agent` array fans out to every slot ---
{
  const m = twoAttrShell(buildArrayModel('setAttribute', { extraCount: 1, attr_2: 'sig2', _port_value_2: '8' }));
  const js = M.compileAgentGraph(m.agentGraphNodes, m.agentGraphEdges, m, 0);
  const loops = (js.behaviourCode || '').match(/for \(let _si\w+ = 0;/g) || [];
  check('multi-slot x array: ONE write-many loop per slot (the agentId edge fans out)',
    loops.length === 2, `got ${loops.length}`);
  check('multi-slot x array: both attributes written inside their own guarded loop',
    /w_sig\[_sa\w+\] = __val;/.test(js.behaviourCode || '') && /w_sig2\[_sa\w+\] = __val;/.test(js.behaviourCode || ''));
  check('multi-slot x array: the two slot values are the two inline values',
    /const __val=7;/.test(js.behaviourCode || '') && /const __val=8;/.test(js.behaviourCode || ''));
  const w = M.compileAgentGraphWasmForModel(m);
  check('multi-slot x array: WASM compiles', !w.error && w.bytes?.length > 0, w.error);
}

// --- the RETIREMENT migration ---
{
  const legacy = buildArrayModel('setAgentsAttribute');
  const migrated = M.migrateSetAgentsAttribute({ agentGraphNodes: legacy.nodes, agentGraphEdges: legacy.edges, macroDefs: [] });
  const mn = migrated.agentGraphNodes.find(n => n.id === 'sa');
  check('migration: nodeType flips to setAttribute', mn.data.nodeType === 'setAttribute');
  check('migration: config carried over verbatim',
    JSON.stringify(mn.data.config) === JSON.stringify(legacy.nodes.find(n => n.id === 'sa').data.config));
  check('migration: the id edge is retargeted `agents` -> `agentId`',
    migrated.agentGraphEdges.find(e => e.id === 'e1').targetHandle === 'input_value_agentId');
  check('migration: every other edge + every edge id is untouched',
    migrated.agentGraphEdges.map(e => e.id).join(',') === 'e0,e1'
    && migrated.agentGraphEdges.find(e => e.id === 'e0').targetHandle === 'input_flow_do');
  check('migration: node ids + order preserved', migrated.agentGraphNodes.map(n => n.id).join(',') === 'bs,nb,sa');
  check('migration: idempotent (same reference on a clean model)',
    M.migrateSetAgentsAttribute(migrated) === migrated);
  const macSrc = buildArrayModel('setAgentsAttribute');
  const inMac = M.migrateSetAgentsAttribute({
    agentGraphNodes: [], agentGraphEdges: [],
    macroDefs: [{ id: 'm', nodes: macSrc.nodes, edges: macSrc.edges }],
  });
  check('migration: macroDefs swept (node + handle)',
    inMac.macroDefs[0].nodes.find(n => n.id === 'sa').data.nodeType === 'setAttribute'
    && inMac.macroDefs[0].edges.find(e => e.id === 'e1').targetHandle === 'input_value_agentId');

  // THE LOAD-BEARING CHECK — a migrated legacy graph and a hand-authored one emit
  // byte-identical code on JS *and* WASM (what makes the retire a no-op for files).
  const mMig = twoAttrShell({ nodes: migrated.agentGraphNodes, edges: migrated.agentGraphEdges });
  const mNew = twoAttrShell(buildArrayModel('setAttribute'));
  const jsMig = M.compileAgentGraph(mMig.agentGraphNodes, mMig.agentGraphEdges, mMig, 0);
  const jsNew = M.compileAgentGraph(mNew.agentGraphNodes, mNew.agentGraphEdges, mNew, 0);
  check('migrated == hand-authored: JS behaviour code byte-identical',
    !jsMig.error && !jsNew.error && jsMig.behaviourCode === jsNew.behaviourCode, jsMig.error || jsNew.error);
  const wMig = M.compileAgentGraphWasmForModel(mMig), wNew = M.compileAgentGraphWasmForModel(mNew);
  check('migrated == hand-authored: WASM module bytes byte-identical',
    !wMig.error && !wNew.error && wMig.bytes.length > 0
    && Buffer.from(wMig.bytes).toString('base64') === Buffer.from(wNew.bytes).toString('base64'),
    wMig.error || wNew.error);
  const gMig = M.compileAgentGraphWebGPUForModel(mMig), gNew = M.compileAgentGraphWebGPUForModel(mNew);
  check('migrated == hand-authored: WGSL byte-identical',
    !gMig.error && !gNew.error && gMig.shaderCode === gNew.shaderCode, gMig.error || gNew.error);
}


console.log(failures === 0 ? '\nALL CROSS-AGENT-WRITE CHECKS ✓' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
