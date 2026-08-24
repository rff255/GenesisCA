// STEP 0 — 4-site agent-ABI FIELD-ORDER AUDIT. The three CPU-side ABI mirrors
// (compile.ts `buildAgent*Params`, the worker's `buildAgent*Args`, the parity
// harness's `buildArgs`) all DERIVE from the shared descriptor `deriveAgentAbi`
// (agentAbi.ts), so they cannot desync in ORDER by construction. This script is
// the standing guard that CATCHES a regression if someone hand-edits a site off
// the descriptor, plus the descriptor's internal invariants:
//
//   (A) compile.ts's PARAM name strings === the descriptor names, per kind, for
//       every shipped agent sample + a synthetic 2D+3D model (the worker + the
//       harness call `buildAgentAbiArgs` directly, so verifying compile matches
//       the descriptor closes the CPU 4-site loop).
//   (C) the 2D field list is a strict PREFIX of the 3D list (append-only z-block).
//   (D) no duplicate field names; every field has a valid cType.
//
// The cross-target SoA field-SET check (CPU AGENT_*_FIELDS vs the WebGPU
// AGENT_GPU_*_FIELDS) becomes load-bearing only once the SoA layout is
// profile-GATED (STEP 3) — until then both targets allocate the full struct, so
// that arm is a documented STEP-3 extension (see the note at the end).
//
// Run:  node scripts/audit-agent-layout.mjs   (exit 1 on any divergence)
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os'; import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'audit-'));
const ep = join(ROOT, 'scripts', '__audit_entry.ts');
writeFileSync(ep, `
export { deriveAgentAbi } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { buildAgentLoopParams, buildDivisionParams, buildAgentInitParams, agentAbiShapeOf } from '../src/modeler/vpl/compiler/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { computeAgentMemoryLayout, agentOctreeNodeReserve } from '../src/simulator/engine/agentEngine.ts';
export { computeAgentWebGPULayout } from '../src/modeler/vpl/compiler/agentWebgpu/layout.ts';
`);
const out = join(dir, 'b.mjs');
await build({ entryPoints: [ep], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(out).href);
const { deriveAgentAbi, buildAgentLoopParams, buildDivisionParams, buildAgentInitParams, agentAbiShapeOf, migrateForHarness,
  computeAgentMemoryLayout, agentOctreeNodeReserve, computeAgentWebGPULayout } = m;

const VALID_CTYPES = new Set(['f64[]', 'i32[]', 'u8[]', 'u32[]', 'clamped[]', 'scalar', 'obj', 'fn']);
const PARAM_FN = { loop: (model) => buildAgentLoopParams(model).params, division: buildDivisionParams, init: buildAgentInitParams };

let fail = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fail++; console.log('  ✗ ' + msg); } };

function auditModel(name, model) {
  const shape = agentAbiShapeOf(model);
  for (const kind of ['loop', 'division', 'init']) {
    const fields = deriveAgentAbi(kind, shape);
    const names = fields.map(f => f.name);

    // (A) compile's PARAM string === the descriptor names.
    const paramStr = PARAM_FN[kind](model);
    ok(paramStr === names.join(', '), `${name} ${kind}: compile params match the descriptor`);

    // (D) no duplicate names; every cType valid.
    ok(new Set(names).size === names.length, `${name} ${kind}: no duplicate field names`);
    ok(fields.every(f => VALID_CTYPES.has(f.cType)), `${name} ${kind}: all cTypes valid`);

    // (C) 2D is a strict prefix of 3D (append-only z-block).
    //
    // `_generation` (L2) is appended AFTER the 3D block — dead last on every kind,
    // so a graph that does not read the generation keeps its historical signature.
    // That makes it the ONE field that legitimately sits behind the z-block, so the
    // prefix property is asserted on the ABI up to it, plus the separate (stronger)
    // claim that when present it really is last on BOTH sides. Comparing the raw
    // lists instead reports a false divergence for every cadence-using model — as
    // it did the moment the first one shipped (`Cubic GRA`).
    // D3 / D4 joined it with two more DIVISION-only trailing blocks —
    // `__siblingId` and the structural request QUEUE — appended after the 3D block
    // and BEFORE `_generation` (which stays dead last on every kind). They are
    // identical in 2D and 3D, so they must be stripped from BOTH ends before the
    // prefix comparison, exactly like `_generation`; leaving them in reports a
    // false divergence for every model that uses them.
    const TRAILING = '_generation';
    const TRAILING_DIVISION = new Set(['__siblingId', '_bondFormReq', '_bondFormL', '_bondFormK', '_bondBreakReq']);
    const isTrailingGated = (n) => n === TRAILING || TRAILING_DIVISION.has(n) || n.startsWith('_bondFormAttr_');
    const stripTrailing = (a) => { let e = a.length; while (e > 0 && isTrailingGated(a[e - 1])) e--; return a.slice(0, e); };
    const raw2d = deriveAgentAbi(kind, { ...shape, is3d: false }).map(f => f.name);
    const raw3d = deriveAgentAbi(kind, { ...shape, is3d: true }).map(f => f.name);
    ok(raw2d.includes(TRAILING) === raw3d.includes(TRAILING)
      && (!raw2d.includes(TRAILING) || (raw2d[raw2d.length - 1] === TRAILING && raw3d[raw3d.length - 1] === TRAILING)),
      `${name} ${kind}: ${TRAILING}, when present, is LAST in both 2D and 3D`);
    // The two gated division blocks must appear IDENTICALLY in 2D and 3D — they
    // sit behind the z-block, so a dimension-dependent one would silently break
    // the prefix property the strip is hiding.
    const tail = (a) => a.slice(stripTrailing(a).length).join(',');
    ok(tail(raw2d) === tail(raw3d),
      `${name} ${kind}: the trailing gated block is identical in 2D and 3D ('${tail(raw2d)}' vs '${tail(raw3d)}')`);
    const names2d = stripTrailing(raw2d), names3d = stripTrailing(raw3d);
    ok(names3d.length >= names2d.length && names3d.slice(0, names2d.length).join(',') === names2d.join(','),
      `${name} ${kind}: 2D is a strict prefix of 3D (up to the trailing gated block)`);
  }
}

// Every shipped agent sample (2D + 3D) + a synthetic minimal 2D/3D pair.
const P = join(ROOT, 'public', 'models');
let n = 0;
for (const f of readdirSync(P).filter(x => x.endsWith('.gcaproj'))) {
  let raw; try { raw = JSON.parse(readFileSync(join(P, f), 'utf8')); } catch { continue; }
  if (!raw?.topologyMode?.agents) continue;
  auditModel(f.replace('.gcaproj', ''), migrateForHarness(raw));
  n++;
}
// synthetic pair with agent attrs + a field + a lookup table (exercises the
// dynamic r_/w_/_field_ + `_lookupTables` slots in both dimensions).
for (const is3d of [false, true]) {
  const model = migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'syn', dimension: is3d ? '3d' : '2d', gridWidth: 8, gridHeight: 8, gridDepth: is3d ? 8 : 1, boundaryTreatment: 'torus' },
    topologyMode: { gridCells: true, agents: true },
    centerBased: { enabled: true, maxAgents: 16, maxBonds: 3 },
    attributes: [
      { id: 'field1', name: 'f1', type: 'float', defaultValue: '0', agentAccess: 'readWrite' },
      { id: 'lt', name: 'lt', type: 'lookupTable', isModelAttribute: true },
    ],
    agentAttributes: [{ id: 'energy', name: 'e', type: 'float', defaultValue: '0' }],
    neighborhoods: [], mappings: [], indicators: [], variables: [], agentVariables: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: [], agentGraphEdges: [], macroDefs: [],
  });
  auditModel(`synthetic ${is3d ? '3D' : '2D'}`, model);
  n++;
}

// D3 / D4 — a synthetic pair that USES both gated division blocks, so the strip
// above is NON-VACUOUS (no shipped model wires `siblingId` or issues a bond
// request from a Division Event, so without this the two new checks would pass
// on a list that never contains the fields they are about). Bond ATTRIBUTES are
// declared too, so the queue block's per-attribute `_bondFormAttr_<id>` cells
// are in the trailing tail as well.
for (const is3d of [false, true]) {
  const node = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
  const model = migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'syndiv', dimension: is3d ? '3d' : '2d', gridWidth: 8, gridHeight: 8, gridDepth: is3d ? 8 : 1, boundaryTreatment: 'torus' },
    topologyMode: { gridCells: false, agents: true },
    centerBased: {
      enabled: true, maxAgents: 16, maxBonds: 4, bondRequestDepth: 4,
      agentCapabilities: {
        motion: 'force', body: true, collision: 'off', charge: 'off', bonds: 'physics', autoBond: false,
        growth: false, division: true, lifespan: false, populationBirth: false, populationDeath: false,
        sensing: false, orientation: false, fieldCoupling: false, appearance: true,
      },
    },
    attributes: [],
    agentAttributes: [{ id: 'energy', name: 'e', type: 'float', defaultValue: '0' }],
    bondAttributes: [{ id: 'w', name: 'w', type: 'float', defaultValue: '0' }],
    neighborhoods: [], mappings: [], indicators: [], variables: [], agentVariables: [],
    graphNodes: [], graphEdges: [], macroDefs: [],
    agentGraphNodes: [node('bs', 'behaviourStep'), node('dv', 'divisionEvent'), node('fb', 'formBond'), node('sa', 'setAttribute', { attributeId: 'energy' })],
    agentGraphEdges: [
      // siblingId → a by-id Set Attribute (D3), and a Form Bond in the division
      // flow chain (D4).
      { id: 'e1', source: 'dv', target: 'sa', sourceHandle: 'output_value_siblingId', targetHandle: 'input_value_agentId' },
      { id: 'e2', source: 'dv', target: 'fb', sourceHandle: 'output_flow_do', targetHandle: 'input_flow_do' },
      { id: 'e3', source: 'fb', target: 'sa', sourceHandle: 'output_flow_next', targetHandle: 'input_flow_do' },
    ],
  });
  const shape = agentAbiShapeOf(model);
  ok(shape.usesDivisionSibling === true && shape.usesDivisionRequests === true,
    `synthetic division ${is3d ? '3D' : '2D'}: (precondition) BOTH gated blocks are on`);
  const names = deriveAgentAbi('division', shape).map(f => f.name);
  ok(names.includes('__siblingId') && names.includes('_bondFormReq') && names.includes('_bondFormAttr_w'),
    `synthetic division ${is3d ? '3D' : '2D'}: the trailing blocks really are in the division ABI`);
  // The blocks are DIVISION-only: no other kind may grow them.
  for (const k of ['loop', 'init', 'input', 'spawner']) {
    ok(!deriveAgentAbi(k, shape).map(f => f.name).includes('__siblingId'),
      `synthetic division ${is3d ? '3D' : '2D'}: '${k}' does not carry __siblingId`);
  }
  auditModel(`synthetic division ${is3d ? '3D' : '2D'}`, model);
  n++;
}


// ---------------------------------------------------------------------------
// C10 / P11a - THE OCTREE REGIONS. The tree lives in the agent memory at baked
// offsets (WASM) and in two GPU buffers (WebGPU). Both are appended LAST and
// reserved ONLY for a GLOBAL-charge model, so the audit proves exactly two
// things: (a) a model WITHOUT global charge is byte-identical (the regions add
// nothing at all and move no existing offset), and (b) a model WITH it lays out
// non-overlapping, correctly sized, in-bounds runs on BOTH targets.
// ---------------------------------------------------------------------------
{
  const MA = 128, NODES = agentOctreeNodeReserve(MA);
  const base = computeAgentMemoryLayout(MA, 0, [], 64, {});
  const tree = computeAgentMemoryLayout(MA, 0, [], 64, { chargeTreeNodes: NODES });

  ok(base.chargeTreeNodes === 0, 'C10 WASM layout: charge-off reserves 0 tree nodes');
  ok(base.totalBytes < tree.totalBytes, 'C10 WASM layout: the tree regions cost bytes only under global charge');
  ok(base.generationOffset === tree.generationOffset, 'C10 WASM layout: appending the tree moves no existing offset (generationOffset)');
  ok(base.hashBinStartOffset === tree.hashBinStartOffset, 'C10 WASM layout: appending the tree moves no existing offset (hashBinStartOffset)');
  ok(base.stopFlagOffset === tree.stopFlagOffset, 'C10 WASM layout: appending the tree moves no existing offset (stopFlagOffset)');

  const runs = [
    ['sortedX', tree.treeSortedXOffset, MA * 8, 8], ['sortedY', tree.treeSortedYOffset, MA * 8, 8], ['sortedZ', tree.treeSortedZOffset, MA * 8, 8],
    ['nodeCx', tree.treeNodeCxOffset, NODES * 8, 8], ['nodeCy', tree.treeNodeCyOffset, NODES * 8, 8],
    ['nodeCz', tree.treeNodeCzOffset, NODES * 8, 8], ['nodeExt', tree.treeNodeExtOffset, NODES * 8, 8],
    ['nodeStart', tree.treeNodeStartOffset, NODES * 4, 4], ['nodeEnd', tree.treeNodeEndOffset, NODES * 4, 4], ['nodeNext', tree.treeNodeNextOffset, NODES * 4, 4],
  ];
  ok(tree.chargeTreeNodes === NODES, 'C10 WASM layout: the node reserve is the shared agentOctreeNodeReserve');
  for (const [name, off, bytes, align] of runs) {
    ok(off + bytes <= tree.totalBytes, `C10 WASM layout: ${name} fits inside totalBytes`);
    ok(off % align === 0, `C10 WASM layout: ${name} is ${align}-byte aligned`);
  }
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    ok(a[1] + a[2] <= b[1] || b[1] + b[2] <= a[1], `C10 WASM layout: ${a[0]} and ${b[0]} do not overlap`);
  }

  const gOff = computeAgentWebGPULayout(MA, 64, undefined, [], {});
  const gOn = computeAgentWebGPULayout(MA, 64, undefined, [], { chargeTreeNodes: NODES });
  ok(gOff.chargeTreeNodes === 0 && gOff.chargeTreeF32Len === 0 && gOff.chargeTreeI32Len === 0,
    'C10 WebGPU layout: charge-off declares no tree runs (=> no bindings => byte-identical shader)');
  ok(gOff.f32Len === gOn.f32Len && gOff.i32Len === gOn.i32Len,
    'C10 WebGPU layout: the tree lives in its OWN buffers - the agent SoA runs are untouched');
  ok(gOn.chargeTreeF32Len === NODES * 4 + MA * 3, 'C10 WebGPU layout: the f32 tree buffer holds 4 node runs + 3 point runs');
  ok(gOn.chargeTreeI32Len === NODES * 3, 'C10 WebGPU layout: the i32 tree buffer holds 3 node runs');
  const gRuns = [
    ['cx', gOn.treeNodeCxBase, NODES], ['cy', gOn.treeNodeCyBase, NODES], ['cz', gOn.treeNodeCzBase, NODES], ['ext', gOn.treeNodeExtBase, NODES],
    ['sx', gOn.treeSortedXBase, MA], ['sy', gOn.treeSortedYBase, MA], ['sz', gOn.treeSortedZBase, MA],
  ];
  for (const g of gRuns) ok(g[1] + g[2] <= gOn.chargeTreeF32Len, `C10 WebGPU layout: ${g[0]} run fits the f32 buffer`);
  for (let i = 0; i < gRuns.length; i++) for (let j = i + 1; j < gRuns.length; j++) {
    const a = gRuns[i], b = gRuns[j];
    ok(a[1] + a[2] <= b[1] || b[1] + b[2] <= a[1], `C10 WebGPU layout: ${a[0]} and ${b[0]} runs do not overlap`);
  }
  const gI = [['start', gOn.treeNodeStartBase], ['end', gOn.treeNodeEndBase], ['next', gOn.treeNodeNextBase]];
  for (const g of gI) ok(g[1] + NODES <= gOn.chargeTreeI32Len, `C10 WebGPU layout: ${g[0]} run fits the i32 buffer`);
  ok(new Set(gI.map(x => x[1])).size === 3, 'C10 WebGPU layout: the three i32 node runs are distinct');
}

console.log(`\naudited ${n} agent models × 3 kinds — ${checks} checks`);
console.log(fail === 0 ? 'AGENT ABI FIELD-ORDER AUDIT ✓ (all 4 CPU sites in lockstep via the descriptor)' : `AUDIT FAILED ✗ (${fail} divergences)`);
console.log('NOTE: the cross-target SoA field-SET arm (CPU AGENT_*_FIELDS vs WebGPU AGENT_GPU_*_FIELDS) activates in STEP 3, when the layout becomes profile-gated.');
rmSync(ep, { force: true });
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
