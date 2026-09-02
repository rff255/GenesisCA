// BY-ID AGENT READERS — an UNWIRED `Agent` id means SELF (the current agent).
//
//  `Get Attribute (by ID)` / `Get Position (by ID)` / `Get Radius (by ID)` used
//  to emit the -1 empty sentinel when their optional `Agent` input was left
//  unwired, which the range guard turned into a silent READ OF 0. That is the
//  same trap the by-id badge was added for — but reading "the current agent" is
//  a perfectly valid use, and it is what the rest of the optional-id family
//  already means (Get Velocity, Set Attribute, Kill Agent, …). So the SEMANTICS
//  moved to the convention and the badge came off.
//
//  What this asserts, on all three agent targets:
//    A. the JS emit — unwired reads `[idx]` with NO `highWater` guard; a WIRED
//       one keeps the guarded form BYTE-FOR-BYTE (the byte-identity discipline).
//    B. the WASM emit — the two shapes produce DIFFERENT module bytes (so the
//       emitter really took the other arm, rather than the JS-only change that
//       would have silently diverged the targets), and both modules instantiate.
//    C. the WGSL emit — unwired indexes `idx`, wired keeps its `select(` guard.
//    D. the SELFLESS-ROOT safety catch — an unwired reader in the Agent Init
//       Event (no `idx` in scope) degrades to the typed default instead of
//       emitting a reference that throws, and `nodeValidation` badges it.
//    E. validation — the three readers are no longer badged when unwired, while
//       the nodes whose unwired id has NO self meaning still are.
//
//  The VALUES (JS ↔ WASM bit-parity + an independent recompute) are covered by
//  the permanent "[synthetic] By-id READERS unwired = self" entry in
//  scripts/parity-agent-wasm.mjs.
//
// Run from the repo root:  node scripts/test-by-id-self-default.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileAgentGraphWasmForModel, isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { detectMissingConfig, detectAgentInitContextIssue } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { setActiveGraphKind } from '../src/modeler/vpl/graphState.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-byid-'));
const entryPath = join(ROOT, 'scripts', '__byid_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

// --------------------------------------------------------------------------
// Model builder: one reader of each kind, its `Agent` port wired or not, its
// result stored into an agent attribute. `root` picks which agent root the
// chain hangs off ('behaviourStep' or 'agentInit').
// --------------------------------------------------------------------------
const READERS = {
  attr: { type: 'getAgentAttribute', port: 'value', config: { attributeId: 'energy' } },
  pos: { type: 'getAgentPosition', port: 'x', config: { mode: 'absolute' } },
  radius: { type: 'getAgentRadius', port: 'value', config: {} },
};

function buildModel({ kind, wired, root = 'behaviourStep', is3d = false }) {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const aN = [], aEd = [];
  const an = (t, c) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; aN.push(n); return n; };
  const aE = (s, sp, tt, tp, cat) => aEd.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

  const rootNode = an(root, {});
  const spec = READERS[kind];
  const reader = an(spec.type, { ...spec.config });
  if (wired) {
    // A CONSTANT id keeps the fixture free of any other agent-SoA reader, so a
    // selfless-root compile fails (or not) for exactly one reason.
    const k = an('getConstant', { constType: 'integer', constValue: '3' });
    aE(k, 'value', reader, 'agentId', 'value');
  }
  const set = an('setAttribute', { attributeId: 'out' });
  aE(reader, spec.port, set, 'value', 'value');

  if (root === 'behaviourStep') {
    aE(rootNode, 'do', set, 'do', 'flow');
  } else {
    // SELFLESS ROOT. Two fixture rules, both load-bearing:
    //  1. `compileAgentGraph` REQUIRES a Behaviour Step root, so add a trivial
    //     reader-free one — without it the whole compile errors and every
    //     assertion on `initCode` is vacuously true over an empty string.
    //  2. The consumer must be the canonical spawn idiom (Create Agent → set BY
    //     HANDLE → Add To World). An UNWIRED Set Attribute emits `w_<attr>[idx]`
    //     in a selfless root all by itself (a separate, pre-existing footgun the
    //     `AGENT_SELF_ONLY_WHEN_UNWIRED` badge preempts), which would make the
    //     "no bare idx" assertion below test the wrong node.
    const bs = an('behaviourStep', {});
    const k0 = an('getConstant', { constType: 'integer', constValue: '0' });
    const s0 = an('setAttribute', { attributeId: 'out' });
    aE(k0, 'value', s0, 'value', 'value');
    aE(bs, 'do', s0, 'do', 'flow');

    const create = an('createAgent', { _port_x: '1', _port_y: '1', _port_radius: '0.5' });
    const add = an('addAgentToWorld', {});
    aE(create, 'handle', set, 'agentId', 'value');
    aE(create, 'handle', add, 'handle', 'value');
    aE(rootNode, 'do', create, 'do', 'flow');
    aE(create, 'next', set, 'do', 'flow');
    aE(set, 'next', add, 'do', 'flow');
  }

  const D = is3d ? 12 : 1;
  return {
    model: M.migrateForHarness({
      schemaVersion: 1,
      properties: { name: 'By-Id Reader Self Default', dimension: is3d ? '3d' : '2d', gridWidth: 40, gridHeight: 40, gridDepth: D, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
      topologyMode: { gridCells: false, agents: true },
      centerBased: { enabled: true, maxAgents: 64, maxBonds: 0, worldWidth: 40, worldHeight: 40, worldDepth: D, seedCount: 8, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
        agentCapabilities: { motion: 'static', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
      attributes: [], modelAttributes: [], neighborhoods: [],
      agentAttributes: [
        { id: 'energy', name: 'Energy', type: 'float', defaultValue: '0' },
        { id: 'out', name: 'Out', type: 'float', defaultValue: '0' },
      ],
      bondAttributes: [],
      variables: [], agentVariables: [], indicators: [], mappings: [],
      graphNodes: [], graphEdges: [], agentGraphNodes: aN, agentGraphEdges: aEd, macroDefs: [],
    }),
    readerId: reader.id,
  };
}

const js = (o) => M.compileAgentGraph(o.model.agentGraphNodes, o.model.agentGraphEdges, o.model);

// --------------------------------------------------------------------------
// A. the JS emit
// --------------------------------------------------------------------------
console.log('\n--- A. JS emit (behaviour root) ---');
/** The self-read expression each reader must produce when unwired. */
const SELF_READ = { attr: 'r_energy[idx]', pos: '_agentX[idx]', radius: '_agentRadius[idx]' };
/** The guarded arm's own temp, minted ONLY by the wired path. `highWater` is a
 *  parameter of the loop signature (and `_agentX[idx]` / `_agentRadius[idx]`
 *  appear in the loop preamble), so those are NOT usable as markers — the temp
 *  name is the one thing unique to the by-id emit. */
const WIRED_TEMP = { attr: '__gaa', pos: '__gaOk', radius: '__gar' };
for (const kind of Object.keys(READERS)) {
  const un = js(buildModel({ kind, wired: false }));
  const wi = js(buildModel({ kind, wired: true }));
  check(`${kind}: unwired compiles clean`, !un.error, un.error);
  check(`${kind}: unwired reads SELF (${SELF_READ[kind]})`, (un.behaviourCode || '').includes(SELF_READ[kind]));
  check(`${kind}: unwired mints NO guarded temp (${WIRED_TEMP[kind]})`, !(un.behaviourCode || '').includes(WIRED_TEMP[kind]));
  check(`${kind}: unwired emits NO -1 sentinel`, !/\(\(-1\) \| 0\)/.test(un.behaviourCode || ''));
  check(`${kind}: WIRED mints the guarded temp + range guard`,
    (wi.behaviourCode || '').includes(WIRED_TEMP[kind]) && /< highWater/.test(wi.behaviourCode || ''));
}
// 3D: the Z output must follow the same rule (self-read, no guarded temp).
{
  const un = js(buildModel({ kind: 'pos', wired: false, is3d: true }));
  check('pos 3D: unwired self-reads x AND z', (un.behaviourCode || '').includes('_agentX[idx]') && (un.behaviourCode || '').includes('_agentZ[idx]'));
  check('pos 3D: unwired mints NO guarded temp', !(un.behaviourCode || '').includes('__gaOk'));
}

// --------------------------------------------------------------------------
// B. the WASM emit — different bytes per arm, and both modules instantiate.
// --------------------------------------------------------------------------
console.log('\n--- B. WASM emit ---');
for (const kind of Object.keys(READERS)) {
  const un = buildModel({ kind, wired: false });
  const wi = buildModel({ kind, wired: true });
  check(`${kind}: WASM gate accepts unwired`, M.isAgentGraphWasmSupported(un.model));
  const a = M.compileAgentGraphWasmForModel(un.model);
  const b = M.compileAgentGraphWasmForModel(wi.model);
  check(`${kind}: unwired module compiles`, !a.error && a.bytes.length > 0, a.error);
  check(`${kind}: wired module compiles`, !b.error && b.bytes.length > 0, b.error);
  const same = a.bytes.length === b.bytes.length && a.bytes.every((v, i) => v === b.bytes[i]);
  check(`${kind}: the two arms emit DIFFERENT bytes`, !same,
    same ? 'identical modules — the WASM emitter did not take the self arm' : '');
  // A module that validates is the only proof the emitted stack is well-formed.
  const ok = (bytes) => { try { new WebAssembly.Module(bytes); return true; } catch { return false; } };
  check(`${kind}: unwired module VALIDATES`, ok(a.bytes));
  check(`${kind}: wired module VALIDATES`, ok(b.bytes));
}

// --------------------------------------------------------------------------
// C. the WGSL emit
// --------------------------------------------------------------------------
console.log('\n--- C. WGSL emit ---');
// A `let … : f32 = agentF32[<base>u + idx];` — the self read, in the exact form
// the `getCellAttribute` arm has always used. (The fixture contains no other
// SoA reader, and the Set Attribute write is an assignment, not a `let`.)
// (the `<base>u +` prefix is absent when the run's base is 0, e.g. the x field)
const WGSL_SELF_READ = /let\s+\S+\s*:\s*f32\s*=\s*agentF32\[\s*(?:\d+u\s*\+\s*)?idx\s*\]/;
for (const kind of Object.keys(READERS)) {
  const un = buildModel({ kind, wired: false });
  const wi = buildModel({ kind, wired: true });
  check(`${kind}: WebGPU gate accepts unwired`, M.isAgentGraphWebGPUSupported(un.model));
  const a = M.compileAgentGraphWebGPUForModel(un.model);
  const b = M.compileAgentGraphWebGPUForModel(wi.model);
  check(`${kind}: unwired shader compiles`, !a.error && !!a.shaderCode, a.error);
  check(`${kind}: wired shader compiles`, !b.error && !!b.shaderCode, b.error);
  check(`${kind}: unwired indexes idx directly`, WGSL_SELF_READ.test(a.shaderCode || ''),
    (a.shaderCode || '').split('\n').filter(l => /agentF32\[/.test(l)).slice(0, 3).join(' | '));
  check(`${kind}: unwired mints NO id guard`, !/aidOk/.test(a.shaderCode || ''));
  check(`${kind}: WIRED keeps select( + the id guard`, /aidOk/.test(b.shaderCode || '') && /select\(0\.0,/.test(b.shaderCode || ''));
  check(`${kind}: WIRED does NOT self-read`, !WGSL_SELF_READ.test(b.shaderCode || ''));
}

// --------------------------------------------------------------------------
// D. the SELFLESS-ROOT safety catch (Agent Init Event — no `idx` in scope)
// --------------------------------------------------------------------------
console.log('\n--- D. selfless root (Agent Init Event) ---');
for (const kind of Object.keys(READERS)) {
  const un = buildModel({ kind, wired: false, root: 'agentInit' });
  const r = js(un);
  check(`${kind}: init compiles clean`, !r.error, r.error);
  const code = r.initCode || '';
  // Guard against a VACUOUS pass: every assertion below is a negative, so an
  // empty initCode (a failed compile) would satisfy all of them.
  check(`${kind}: init emitted real code`, code.length > 0 && /_v/.test(code), JSON.stringify(code));
  // The whole point: NOT a reference to the loop variable the init closure lacks.
  check(`${kind}: init emits NO bare idx`, !/\bidx\b/.test(code), code.slice(0, 200));
  check(`${kind}: init emits NO highWater`, !/\bhighWater\b/.test(code));
  check(`${kind}: init degrades to the typed default (= 0)`, /_v\w+(_x|_y|_z)?\s*=\s*0\b/.test(code), code.slice(0, 200));
  // …and the modeler says so rather than leaving a silent zero.
  M.setActiveGraphKind('agents');
  const badge = M.detectAgentInitContextIssue(un.readerId, un.model);
  check(`${kind}: init placement is BADGED`, badge.length > 0 && /Agent Init Event/.test(badge[0]), badge[0] || '(none)');
}

// --------------------------------------------------------------------------
// E. validation — the badge set follows the semantics
// --------------------------------------------------------------------------
console.log('\n--- E. validation (detectMissingConfig) ---');
M.setActiveGraphKind('agents');
const emptyModel = buildModel({ kind: 'attr', wired: false }).model;
/** Run detectMissingConfig with the `agentId` port reported UNWIRED. */
const badgesUnwired = (nodeType, config) => M.detectMissingConfig(nodeType, config, emptyModel, new Set());
const mentionsAgentInput = (arr) => arr.some(s => /Connect an Agent input/.test(s));

// The three readers: unwired is a valid, documented use — never badged for it.
check('getAgentAttribute: unwired id is NOT badged', !mentionsAgentInput(badgesUnwired('getAgentAttribute', { attributeId: 'energy' })),
  JSON.stringify(badgesUnwired('getAgentAttribute', { attributeId: 'energy' })));
check('getAgentPosition: unwired id is NOT badged', !mentionsAgentInput(badgesUnwired('getAgentPosition', { mode: 'absolute' })));
check('getAgentRadius: unwired id is NOT badged', !mentionsAgentInput(badgesUnwired('getAgentRadius', {})));
// …but a missing ATTRIBUTE is still a real problem.
check('getAgentAttribute: a missing attribute IS still badged', badgesUnwired('getAgentAttribute', { attributeId: '' }).length > 0);

// The nodes whose unwired id has NO self meaning keep the badge.
for (const [t, cfg] of [['getAgentOffset', {}], ['setAgentPosition', {}], ['setAgentRadius', {}], ['applyForceToAgent', {}]]) {
  check(`${t}: unwired id IS still badged`, mentionsAgentInput(badgesUnwired(t, cfg)),
    JSON.stringify(badgesUnwired(t, cfg)));
}
// The rest of the optional-id family was never badged and still isn't.
for (const [t, cfg] of [['getVelocity', {}], ['setVelocity', {}], ['setTargetRadius', {}], ['killAgent', {}]]) {
  check(`${t}: unwired id is NOT badged (unchanged)`, !mentionsAgentInput(badgesUnwired(t, cfg)));
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL BY-ID READER CHECKS PASS ✓' : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
