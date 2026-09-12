// RULE TRACE (P1) — the compiler's TRACE BUILD, the origin table and the
// write-recording sandbox, checked by VALUE and negative-controlled.
//
// What this asserts — through the SHIPPED modules, never a re-implementation:
//
//   A. COVERAGE. For every library model the trace build compiles the SAME set of
//      roots the normal build emits, and EVERY node id that appears in a record
//      (`_tr.v("id"` / `_tr.f("id"` / `_tr.o("id"`) resolves through
//      `resolveTraceOrigin` to a user node of the graph, a node inside a macro
//      def, or the `linked:<mappingId>` sentinel. A lowered id with no origin is
//      a DARK NODE — the failure this check exists to prevent (impact map I6).
//
//   B. VALUES. On deterministic sync models (Game of Life, Extended Wireworld,
//      Life3D → the 3D path, Gray-Scott, plus a synthetic multi-attribute-slot
//      graph) the trace of ONE cell, run against the PRE-step state inside the
//      sandbox, produces own-cell writes EQUAL to what the real JS step wrote for
//      that cell — and where it records no write, the real step left the value
//      alone. That is the claim the whole feature rests on: the traced body IS
//      the engine's body.
//
//   C. FLOW. On two synthetic models whose branch is known from the data (a
//      conditional and a 3-case switch) the recorded `o` port is exactly the one
//      the data selects, and the write that follows is that branch's write. On
//      Game of Life the branch sets must be a FUNCTION of the pre-state (same
//      inputs ⇒ same branches) and must discriminate (≥ 2 distinct sets).
//
//   D. ISOLATION (invariant I2). Every base buffer is hashed before and after a
//      trace and must be byte-identical — the trace is a READER.
//
//   E. AGENTS. Boids' behaviour traced for one agent records the SAME force the
//      real behaviour fn writes for it.
//
//   F. THE RUNNER. The event cap sets `truncated`; `.subarray` on a wrapped
//      argument throws `TraceSandboxEscape`; a throwing fn is captured, not
//      rethrown; the RNG cell is private and stable per (element, generation).
//
//   H. SCOPE MAPPING (P3). `originInScope` decides, for one resolved origin and
//      the macro scope the editor is showing, whether the record is visible here
//      and WHICH node of THIS scope lights up — the rule that makes "a macro
//      instance lights when anything inside it ran" and "entering the instance
//      shows the inner path" one function. Checked against hand-built origins at
//      the root, one level deep, two levels deep, and across two instances of the
//      SAME macro def (whose inner ids are identical — the case a naive
//      "strip the prefix" rule gets wrong).
//
//   J. VALUES (P5). The Trace panel's numbers-to-sentences layer: a raw write
//      (a parameter name, a flat index, a value and what was there) back into
//      "this attribute changed" / "that write was aimed at the cell above" /
//      "a Form Between was queued", plus the root-label vocabulary and the
//      element label. The load-bearing claim is that NOTHING the trace wrote is
//      invisible: every write is claimed by exactly one row builder and the rest
//      surface as generic rows.
//
//   G. NEGATIVE CONTROLS. Three deliberate faults must each FAIL a NAMED check:
//      (1) the record emission removed, (2) the shadow `set` trap broken (writes
//      reaching the base array), (3) a pass's origin fold dropped. These mutate
//      the ARTIFACT (the emitted code / the origin table / the wrapper) rather
//      than the source tree: this harness bundles the real modules with esbuild,
//      so mutating the tree underneath itself would be both racy and destructive.
//      The claim is the same either way — the check detects the fault.
//
// Run from the repo root:  node scripts/test-rule-trace.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileGraph, compileAgentGraph, is3dModel, sparseSteppingEnabled } from '../src/modeler/vpl/compiler/compile.ts';
export { resolveTraceOrigin } from '../src/modeler/vpl/compiler/traceOrigin.ts';
export { originInScope } from '../src/trace/traceOrigin.ts';
export { buildEditorTraceIndex, valueConeFrom, originInEditorScope, buildMacroDefIndex, buildMacroOutputMap, parseTraceHandle } from '../src/trace/traceGraphMap.ts';
export { runTrace, TraceSandboxEscape, traceRngSeed, TRACE_MAX_EVENTS } from '../src/simulator/engine/traceRunner.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { createAgentStore, computeAgentMaxHashBins, buildSpatialHash, seedAgents } from '../src/simulator/engine/agentEngine.ts';
export { buildAgentAbiArgs } from '../src/modeler/vpl/compiler/agentAbi.ts';
export { agentAttrsOf, bondAttrsOf, cellFieldAttrsOf } from '../src/model/attributeScope.ts';
export { resolveAgentFieldGates } from '../src/model/agentFieldGating.ts';
export { resolveKeyLabels, normalizeLookupTable } from '../src/modeler/vpl/compiler/variegation.ts';
export { approximateReason, buildTraceRows, indexWrites, cellCoords, shortestDelta, neighbourOffset, formatOffset, formatCellCoords, traceTargetLabel, traceRootLabel, traceChipLabel, isResetRoot, decodeBondRequest, bondRequestText, formatNumber, formatNI } from '../src/trace/traceValues.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-trace-'));
const entryPath = join(ROOT, 'scripts', '__trace_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const section = (t) => console.log(`\n== ${t} ==`);
/** Run a check that is EXPECTED to fail (a negative control): the named check
 *  must report a failure, and that failure must NOT count against the suite. */
const expectFail = (name, fn) => {
  const before = failures;
  const silent = console.log;
  console.log = () => {};
  let threw = false;
  try { fn(); } catch { threw = true; }
  console.log = silent;
  const detected = failures > before || threw;
  failures = before;
  check(`NEGATIVE CONTROL — ${name} is DETECTED`, detected,
    detected ? '' : 'the check passed with the fault injected');
};

const sha = (s) => createHash('sha256').update(s ?? '').digest('hex').slice(0, 16);
const hashArr = (a) => sha(Array.from(a).join(','));

// ---------------------------------------------------------------------------
// Cell-side state builder — the worker's buffer shapes, by PARAMETER NAME.
//
// Args are assembled from the emitted parameter list (the trace meta's
// `paramNames`, and a regex over the normal fn's signature) rather than mirrored
// positionally — the name-keyed `bufs` pattern `test-global-periodic.mjs` uses.
// A parameter with no entry is a HARD failure, so a new ABI field cannot slip in
// silently as `undefined`.
// ---------------------------------------------------------------------------

const sigParams = (code) => /\(\s*function\s*\(([^)]*)\)/.exec(code)[1].split(',').map(s => s.trim()).filter(Boolean);

const ctorFor = (type) => (
  type === 'bool' ? Uint8Array
    : (type === 'integer' || type === 'tag' || type === 'neighborIndex') ? Int32Array
      : Float64Array);

const mix = (a, b) => {
  let h = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491) >>> 0; h ^= h >>> 13;
  return h >>> 0;
};

/** Deterministic seed value for one cell of one attribute. */
function seedValue(attr, i, k) {
  const h = mix(i, k);
  if (attr.type === 'bool') return h % 2;
  if (attr.type === 'tag') return h % Math.max(1, (attr.tagOptions || ['a']).length);
  if (attr.type === 'integer') return h % 5;
  if (attr.type === 'neighborIndex') return 0;
  return (h % 1000) / 1000;
}

/** Replicates the worker's `buildNeighborIndices` (the NON-sparse branch) — the
 *  per-cell `total × size` index table with `total` as the constant-boundary
 *  sentinel. Sparse models are skipped by the caller (their table is a compact
 *  packed-offset one and the emit decodes it inline). */
function buildNbrTable(nbr, W, H, D, torus) {
  const coords3d = D > 1 ? nbr.coords3d : null;
  const size = coords3d ? coords3d.length : nbr.coords.length;
  const total = W * H * D;
  const idx = new Int32Array(total * size);
  for (let layer = 0; layer < D; layer++) {
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const cell = (layer * H + row) * W + col;
        for (let n = 0; n < size; n++) {
          const c = coords3d ? coords3d[n] : nbr.coords[n];
          const dr = c[0], dc = c[1], dl = c[2] ?? 0;
          let nl = layer + dl, nr = row + dr, nc = col + dc;
          if (nl < 0 || nl >= D || nr < 0 || nr >= H || nc < 0 || nc >= W) {
            if (torus) {
              nl = ((nl % D) + D) % D; nr = ((nr % H) + H) % H; nc = ((nc % W) + W) % W;
            } else { idx[cell * size + n] = total; continue; }
          }
          idx[cell * size + n] = (nl * H + nr) * W + nc;
        }
      }
    }
  }
  return { idx, size };
}

/** Build every buffer a cell root can name, keyed by parameter name. */
function buildCellBufs(model, W, H, D) {
  const total = W * H * D;
  const torus = (model.properties.boundaryTreatment ?? 'torus') === 'torus';
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const bufs = {
    total, W, H, D, WH: W * H,
    activeViewer: '', modelAttrs: {}, _linkedResults: {}, _lookupTables: {},
    colors: new Uint8ClampedArray(total * 4),
    _indicators: new Float64Array((model.indicators || []).length),
    _rngState: new Uint32Array([0x12345678]),
    _stopFlag: new Uint32Array(1),
    glyphCodes: new Uint32Array(total), glyphColors: new Uint32Array(total),
    r_orientation: new Int32Array(total + 1), w_orientation: new Int32Array(total + 1),
    _facePatternLookup: new Int32Array(0),
    order: new Int32Array(total).map((_, i) => i),
    _skipped: new Uint8Array(total),
    _activeList: null, _activeCount: 0,
    _generation: 0,
  };
  // Model attributes (numbers; colour attrs split; lookup tables normalised).
  for (const a of model.attributes) {
    if (!a.isModelAttribute) continue;
    if (a.type === 'color') {
      bufs.modelAttrs[a.id + '_r'] = 10; bufs.modelAttrs[a.id + '_g'] = 20; bufs.modelAttrs[a.id + '_b'] = 30;
    } else if (a.type === 'lookupTable') {
      const rl = M.resolveKeyLabels(a.rowKeySource, model), cl = M.resolveKeyLabels(a.colKeySource, model);
      bufs._lookupTables[a.id] = M.normalizeLookupTable(a.tableValues, rl, cl);
    } else {
      const v = parseFloat(String(a.defaultValue ?? '0'));
      bufs.modelAttrs[a.id] = Number.isFinite(v) ? v : 0;
    }
  }
  // Cell attribute r_/w_ pairs (+1 cell: the constant-boundary sentinel slot).
  const attrTypeById = new Map(model.attributes.map(a => [a.id, a.type]));
  const mkAttr = (id) => {
    const t = attrTypeById.get(id) ?? 'float';
    const C = ctorFor(t);
    return { r: new C(total + 1), w: new C(total + 1) };
  };
  const attrs = {};
  for (const a of cellAttrs) {
    const pair = mkAttr(a.id);
    attrs[a.id] = pair;
    bufs['r_' + a.id] = pair.r;
    bufs['w_' + a.id] = pair.w;
  }
  // Neighbourhood tables.
  for (const nbr of model.neighborhoods || []) {
    const { idx, size } = buildNbrTable(nbr, W, H, D, torus);
    bufs['nIdx_' + nbr.id] = idx;
    bufs['nSz_' + nbr.id] = size;
  }
  return { bufs, attrs, cellAttrs, total };
}

/** Seed the r_ buffers deterministically; leave w_ as the previous generation's. */
function seedCells(model, st) {
  st.cellAttrs.forEach((a, k) => {
    const arr = st.attrs[a.id].r;
    for (let i = 0; i < st.total; i++) arr[i] = seedValue(a, i, k);
  });
}

/** Resolve an emitted parameter list against the bufs map; a missing name is a
 *  failure, never a silent `undefined`. */
function argsFor(params, bufs, label) {
  const missing = params.filter(p => !(p in bufs) && p !== '_traceIdx' && p !== '_tr');
  check(`${label}: every parameter resolves`, missing.length === 0, `unknown: ${missing.join(', ')}`);
  return params.filter(p => p !== '_traceIdx' && p !== '_tr').map(p => bufs[p]);
}

// ===========================================================================
section('A. Coverage — every library model, every recorded id resolves');
// ===========================================================================

const modelsDir = join(ROOT, 'public', 'models');
const modelFiles = readdirSync(modelsDir).filter(f => f.endsWith('.gcaproj')).sort();
const RECORD_ID = /_tr\.[vfo]\("((?:[^"\\]|\\.)*)"/g;

/** Every id a user could click: the top-level graph plus every macro def's
 *  internals (a record inside a macro resolves to an inner id + a macro path). */
function userIdSet(model, kind) {
  const ids = new Set();
  const push = (ns) => { for (const n of ns || []) ids.add(n.id); };
  push(kind === 'agents' ? model.agentGraphNodes : model.graphNodes);
  for (const d of model.macroDefs || []) push(d.nodes);
  return ids;
}

let totalRecords = 0, totalUnresolved = 0, paramProblems = [];
const coverage = [];

/** The P2 worker looks a root up by KEY and names its sandbox wrappers from the
 *  parameter list, so every emitted root must carry one, every list must end with
 *  `_tr`, and a list must match the emitted signature exactly. */
function checkParamNames(f, meta, roots) {
  for (const [key, code] of roots) {
    if (!code) continue;
    const names = meta.paramNames[key];
    if (!names) { paramProblems.push(`${f}: no paramNames for root "${key}"`); continue; }
    if (names[names.length - 1] !== '_tr') { paramProblems.push(`${f}/${key}: last param is ${names[names.length - 1]}`); continue; }
    const declared = sigParams(code);
    if (declared.join(',') !== names.join(',')) {
      paramProblems.push(`${f}/${key}: paramNames != the emitted signature (${names.length} vs ${declared.length})`);
    }
  }
}
for (const f of modelFiles) {
  const model = M.migrateForHarness(JSON.parse(readFileSync(join(modelsDir, f), 'utf8')));
  let bad = [], records = 0;

  const scan = (codes, kind, ids) => {
    for (const code of codes) {
      if (!code) continue;
      RECORD_ID.lastIndex = 0;
      let m;
      while ((m = RECORD_ID.exec(code)) !== null) {
        records++;
        const id = m[1];
        const o = M.resolveTraceOrigin(id, kind.origin);
        const ok = ids.has(o.nodeId) || o.nodeId.startsWith('linked:');
        if (!ok) bad.push(`${id} -> ${o.nodeId}`);
      }
    }
  };

  const norm = M.compileGraph(model.graphNodes, model.graphEdges, model);
  const tr = M.compileGraph(model.graphNodes, model.graphEdges, model, { trace: true });
  check(`${f}: cell trace build matches the normal build's roots`,
    (!!norm.stepCode) === (!!tr.stepCode)
    && (!!norm.initCode) === (!!tr.initCode)
    && (!!norm.gridInitCode) === (!!tr.gridInitCode)
    && norm.gridPeriodicCodes.length === tr.gridPeriodicCodes.length
    && norm.inputColorCodes.length === tr.inputColorCodes.length
    && norm.outputMappingCodes.length === tr.outputMappingCodes.length
    && (norm.error ?? null) === (tr.error ?? null),
    `normal error=${norm.error ?? '-'} trace error=${tr.error ?? '-'}`);
  if (tr.trace) {
    checkParamNames(f, tr.trace, [
      ['step', tr.stepCode], ['init', tr.initCode], ['gridInit', tr.gridInitCode],
      ...tr.gridPeriodicCodes.map((c, i) => [`gridPeriodic:${Object.keys(tr.trace.paramNames).filter(k => k.startsWith('gridPeriodic:'))[i]?.slice(13)}`, c.code]),
      ...tr.inputColorCodes.map(c => [`inputColor:${c.mappingId}`, c.code]),
      ...tr.outputMappingCodes.map(c => [`outputMapping:${c.mappingId}`, c.code]),
    ]);
    scan([tr.stepCode, tr.initCode, tr.gridInitCode,
      ...tr.gridPeriodicCodes.map(c => c.code),
      ...tr.inputColorCodes.map(c => c.code),
      ...tr.outputMappingCodes.map(c => c.code)], tr.trace, userIdSet(model, 'cells'));
  }

  if (model.topologyMode?.agents) {
    const an = M.compileAgentGraph(model.agentGraphNodes || [], model.agentGraphEdges || [], model, 0);
    const at = M.compileAgentGraph(model.agentGraphNodes || [], model.agentGraphEdges || [], model, 0, { trace: true });
    check(`${f}: agent trace build matches the normal build's roots`,
      (!!an.behaviourCode) === (!!at.behaviourCode)
      && (!!an.divisionCode) === (!!at.divisionCode)
      && (!!an.initCode) === (!!at.initCode)
      && an.periodicCodes.length === at.periodicCodes.length
      && an.outputMappingCodes.length === at.outputMappingCodes.length
      && an.inputMappingCodes.length === at.inputMappingCodes.length
      && (an.error ?? null) === (at.error ?? null),
      `normal error=${an.error ?? '-'} trace error=${at.error ?? '-'}`);
    if (at.trace) {
      checkParamNames(f, at.trace, [
        ['agentBehaviour', at.behaviourCode], ['agentDivision', at.divisionCode], ['agentInit', at.initCode],
        ...at.periodicCodes.map((c, i) => [Object.keys(at.trace.paramNames).filter(k => k.startsWith('agentPeriodic:'))[i], c.code]),
        ...at.outputMappingCodes.map(c => [`agentOutputMapping:${c.mappingId}`, c.code]),
        ...at.inputMappingCodes.map(c => [`agentInputMapping:${c.mappingId}`, c.code]),
      ]);
      scan([at.behaviourCode, at.divisionCode, at.initCode,
        ...at.periodicCodes.map(c => c.code),
        ...at.outputMappingCodes.map(c => c.code),
        ...at.inputMappingCodes.map(c => c.code)], at.trace, userIdSet(model, 'agents'));
    }
  }

  totalRecords += records;
  totalUnresolved += bad.length;
  coverage.push(`${f}: ${records} records` + (bad.length ? `  UNRESOLVED ${bad.length}` : ''));
  if (bad.length) check(`${f}: every recorded id resolves to a user node`, false, bad.slice(0, 4).join(' | '));
}
check(`all ${modelFiles.length} models: every emitted root has a paramNames entry equal to its signature`,
  paramProblems.length === 0, paramProblems.slice(0, 4).join(' | '));
check(`all ${modelFiles.length} models: every recorded id resolves`, totalUnresolved === 0, `${totalUnresolved} dark ids`);
check('the record scan actually saw records', totalRecords > 500, `${totalRecords} records`);
console.log(`  (${totalRecords} records scanned across ${modelFiles.length} models)`);

// ---------------------------------------------------------------------------
// Synthetic graph builders (the conventions the other value harnesses use)
// ---------------------------------------------------------------------------
const mkGraph = () => {
  let seq = 0;
  const nid = (p) => `${p}${seq++}`;
  const nodes = [], edges = [];
  const n = (t, c = {}) => { const x = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; nodes.push(x); return x; };
  const e = (s, sp, t, tp, cat) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  return { nodes, edges, n, v: (s, sp, t, tp) => e(s, sp, t, tp, 'value'), f: (s, sp, t, tp) => e(s, sp, t, tp, 'flow') };
};
const attrDef = (id, type, dflt = '0', extra = {}) =>
  ({ id, name: id, type, description: '', isModelAttribute: false, defaultValue: dflt, ...extra });
const cellModel = (g, attributes, extra = {}) => M.migrateForHarness({
  schemaVersion: 2,
  properties: {
    name: 'TR', description: '', topology: '2d-grid', boundaryTreatment: 'torus',
    updateMode: 'synchronous', gridWidth: 8, gridHeight: 8, dimension: '2d', gridDepth: 1,
    useWasm: false, ...(extra.properties ?? {}),
  },
  attributes, neighborhoods: [], mappings: [], indicators: [],
  graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
  ...extra,
});

// ---------------------------------------------------------------------------
// The shared "trace one cell and compare with the real step" driver
// ---------------------------------------------------------------------------

/** Deep-copy every typed array in `bufs` that the step can touch, so the state
 *  can be restored to PRE-step before the traces run. */
function snapshotBufs(st) {
  const snap = {};
  for (const a of st.cellAttrs) {
    snap['r_' + a.id] = st.attrs[a.id].r.slice();
    snap['w_' + a.id] = st.attrs[a.id].w.slice();
  }
  snap.colors = st.bufs.colors.slice();
  snap._indicators = st.bufs._indicators.slice();
  snap._rngState = st.bufs._rngState.slice();
  snap._stopFlag = st.bufs._stopFlag.slice();
  snap.glyphCodes = st.bufs.glyphCodes.slice();
  snap.glyphColors = st.bufs.glyphColors.slice();
  snap.r_orientation = st.bufs.r_orientation.slice();
  snap.w_orientation = st.bufs.w_orientation.slice();
  return snap;
}
function restoreBufs(st, snap) {
  for (const k of Object.keys(snap)) st.bufs[k].set(snap[k]);
}
/** One hash over every base buffer — the isolation check (invariant I2). */
function hashBufs(st) {
  const parts = [];
  for (const a of st.cellAttrs) { parts.push(hashArr(st.attrs[a.id].r), hashArr(st.attrs[a.id].w)); }
  parts.push(hashArr(st.bufs.colors), hashArr(st.bufs._indicators), hashArr(st.bufs._rngState),
    hashArr(st.bufs._stopFlag), hashArr(st.bufs.glyphCodes), hashArr(st.bufs.glyphColors));
  return sha(parts.join('|'));
}

/** Trace `sampleCount` cells of `model` and assert the own-cell writes equal the
 *  real JS step's post-state. Returns the per-cell trace results for callers that
 *  want to assert on the flow records too. */
function traceVsStep(label, model, dims, sampleCount = 20) {
  const { W, H, D } = dims;
  if (M.sparseSteppingEnabled(model)) { check(`${label}: not a sparse model`, false, 'sparse stepping on — the nbr table shape differs'); return null; }
  if (model.properties.updateMode !== 'synchronous') { check(`${label}: synchronous`, false, model.properties.updateMode); return null; }

  const st = buildCellBufs(model, W, H, D);
  seedCells(model, st);

  const norm = M.compileGraph(model.graphNodes, model.graphEdges, model);
  const tr = M.compileGraph(model.graphNodes, model.graphEdges, model, { trace: true });
  if (norm.error || !norm.stepCode) { check(`${label}: compiles`, false, norm.error ?? 'no step'); return null; }
  if (tr.error || !tr.stepCode) { check(`${label}: trace build compiles`, false, tr.error ?? 'no step'); return null; }

  const pre = snapshotBufs(st);
  // --- the REAL step over the whole grid ---
  const nParams = sigParams(norm.stepCode);
  const nFn = (0, eval)(norm.stepCode);
  nFn(...argsFor(nParams, st.bufs, `${label}/normal step`));
  const post = {};
  for (const a of st.cellAttrs) post[a.id] = st.attrs[a.id].w.slice();

  // --- back to PRE, then trace one cell at a time ---
  restoreBufs(st, pre);
  const beforeHash = hashBufs(st);
  const tParams = tr.trace.paramNames.step;
  check(`${label}: the trace step's params end with _traceIdx, _tr`,
    tParams[tParams.length - 2] === '_traceIdx' && tParams[tParams.length - 1] === '_tr',
    tParams.slice(-3).join(', '));
  const tFn = (0, eval)(tr.stepCode);
  const tArgs = argsFor(tParams, st.bufs, `${label}/trace step`);

  const results = [];
  let mismatches = [], compared = 0;
  const stride = Math.max(1, Math.floor(st.total / sampleCount));
  for (let idx = 0; idx < st.total && results.length < sampleCount; idx += stride) {
    const r = M.runTrace({ fn: tFn, args: tArgs, paramNames: tParams, elementIdx: idx, generation: 0 });
    if (r.error) { mismatches.push(`cell ${idx} threw: ${r.error}`); break; }
    results.push({ idx, r });
    for (const a of st.cellAttrs) {
      const w = r.writes.find(x => x.param === 'w_' + a.id && x.index === idx);
      const want = post[a.id][idx];
      compared++;
      if (w === undefined) {
        // No record ⇒ the rule left this cell's attribute alone ⇒ the real step
        // must have carried the read buffer forward (the bulk copy).
        if (pre['r_' + a.id][idx] !== want) mismatches.push(`cell ${idx} ${a.id}: no trace write but ${pre['r_' + a.id][idx]} -> ${want}`);
      } else if (!Object.is(w.value, want) && Math.abs(w.value - want) > 1e-12) {
        mismatches.push(`cell ${idx} ${a.id}: traced ${w.value} vs real ${want}`);
      }
    }
  }
  check(`${label}: traced own-cell writes EQUAL the real step (${compared} comparisons over ${results.length} cells)`,
    mismatches.length === 0, mismatches.slice(0, 3).join(' | '));
  check(`${label}: the sandbox left every engine buffer byte-identical`,
    hashBufs(st) === beforeHash);
  return { st, pre, post, results, tr, norm, tFn, tParams, tArgs };
}

// ===========================================================================
section('B. VALUES — a traced cell equals the real step, on shipped models');
// ===========================================================================

const shipped = (name) => M.migrateForHarness(JSON.parse(readFileSync(join(modelsDir, name), 'utf8')));
const clamp = (v, hi) => Math.max(2, Math.min(v || hi, hi));

const golModel = shipped('Game Of Life.gcaproj');
const gol = traceVsStep('Game of Life', golModel,
  { W: clamp(golModel.properties.gridWidth, 24), H: clamp(golModel.properties.gridHeight, 24), D: 1 });

const wwModel = shipped('Extended Wireworld.gcaproj');
traceVsStep('Extended Wireworld', wwModel,
  { W: clamp(wwModel.properties.gridWidth, 20), H: clamp(wwModel.properties.gridHeight, 20), D: 1 });

const gsModel = shipped('Gray-Scott Reaction-Diffusion.gcaproj');
traceVsStep('Gray-Scott', gsModel,
  { W: clamp(gsModel.properties.gridWidth, 16), H: clamp(gsModel.properties.gridHeight, 16), D: 1 });

// 3D — the `_layer` decode + the 10-bit NI codec path (the 2D/3D dual-impact rule).
const l3dModel = shipped('Life3D.gcaproj');
check('Life3D is a 3D model', M.is3dModel(l3dModel), `${l3dModel.properties.dimension}/${l3dModel.properties.gridDepth}`);
traceVsStep('Life3D (3D)', l3dModel,
  { W: clamp(l3dModel.properties.gridWidth, 10), H: clamp(l3dModel.properties.gridHeight, 10), D: clamp(l3dModel.properties.gridDepth, 6) });

// A synthetic MULTI-ATTRIBUTE-SLOT graph: one Set Attribute writing two attrs.
// The second slot is a LOWERED node (`<id>__ma1`), so this is the origin table
// proving itself by VALUE — the write it produces must land on the right attr.
{
  const g = mkGraph();
  const step = g.n('step');
  const get = g.n('getCellAttribute', { attributeId: 'src' });
  const dbl = g.n('arithmeticOperator', { operation: '*', _port_y: '2' });
  g.v(get, 'value', dbl, 'x');
  // Extra slots are 2-based (slot 1 IS the legacy `attributeId`) — see multiAttrSlotIndices.
  const set = g.n('setAttribute', { attributeId: 'o1', attr_2: 'o2', extraCount: 1, _port_value_2: '9' });
  g.f(step, 'do', set, 'do');
  g.v(dbl, 'result', set, 'value');
  const model = cellModel(g, [attrDef('src', 'float', '0'), attrDef('o1', 'float', '0'), attrDef('o2', 'float', '0')]);
  const res = traceVsStep('Multi-attribute slots (synthetic)', model, { W: 6, H: 6, D: 1 }, 8);
  if (res) {
    const one = res.results[0];
    const w1 = one.r.writes.find(x => x.param === 'w_o1' && x.index === one.idx);
    const w2 = one.r.writes.find(x => x.param === 'w_o2' && x.index === one.idx);
    check('multi-attr: BOTH slots produced a write', !!w1 && !!w2,
      `o1=${w1?.value} o2=${w2?.value}`);
    check('multi-attr: slot 2 wrote its own inline literal (9)', w2?.value === 9, String(w2?.value));
    check('multi-attr: slot 1 wrote 2 x src', Math.abs((w1?.value ?? NaN) - 2 * res.pre.r_src[one.idx]) < 1e-12,
      `${w1?.value} vs ${2 * res.pre.r_src[one.idx]}`);
    // …and the lowered `__ma1` id resolves back to the node the user placed.
    const maId = `${set.id}__ma2`;
    const o = M.resolveTraceOrigin(maId, res.tr.trace.origin);
    check('multi-attr: the lowered slot id resolves to the user node + slot port',
      o.nodeId === set.id && o.portId === 'value_2', JSON.stringify(o));
  }
}

// ===========================================================================
section('C. FLOW — the recorded branch is the one the data selects');
// ===========================================================================
{
  // if (src > 0.5) out = 1 else out = 2
  const g = mkGraph();
  const step = g.n('step');
  const get = g.n('getCellAttribute', { attributeId: 'src' });
  const cmp = g.n('statement', { operation: '>', compareType: 'numerical', _port_y: '0.5' });
  g.v(get, 'value', cmp, 'x');
  const cond = g.n('conditional');
  g.f(step, 'do', cond, 'check');
  g.v(cmp, 'result', cond, 'condition');
  const sThen = g.n('setAttribute', { attributeId: 'out', _port_value: '1' });
  const sElse = g.n('setAttribute', { attributeId: 'out', _port_value: '2' });
  g.f(cond, 'then', sThen, 'do');
  g.f(cond, 'else', sElse, 'do');
  const model = cellModel(g, [attrDef('src', 'float', '0'), attrDef('out', 'float', '0')]);
  const res = traceVsStep('Conditional (synthetic)', model, { W: 8, H: 8, D: 1 }, 16);
  if (res) {
    let bad = [], sawThen = false, sawElse = false;
    for (const { idx, r } of res.results) {
      const taken = r.events.filter(e => e[0] === 'o' && e[1] === cond.id).map(e => e[2]);
      const want = res.pre.r_src[idx] > 0.5 ? 'then' : 'else';
      if (want === 'then') sawThen = true; else sawElse = true;
      if (taken.length !== 1 || taken[0] !== want) bad.push(`cell ${idx}: src=${res.pre.r_src[idx]} took [${taken}] want ${want}`);
      const w = r.writes.find(x => x.param === 'w_out' && x.index === idx);
      if ((w?.value ?? 0) !== (want === 'then' ? 1 : 2)) bad.push(`cell ${idx}: wrote ${w?.value} on the ${want} branch`);
    }
    check('conditional: the recorded branch is exactly the one the data selects', bad.length === 0, bad.slice(0, 3).join(' | '));
    check('conditional: BOTH branches were exercised', sawThen && sawElse);
    // The condition node's own value record must agree with the branch.
    const one = res.results.find(x => res.pre.r_src[x.idx] > 0.5);
    const v = one?.r.events.find(e => e[0] === 'v' && e[1] === cmp.id);
    check('conditional: the condition node recorded a truthy value on the THEN cell',
      !!v && !!v[3], JSON.stringify(v));
  }
}
{
  // A 3-case switch (conditions mode, first match only) over an integer attr.
  const g = mkGraph();
  const step = g.n('step');
  const get = g.n('getCellAttribute', { attributeId: 'k' });
  const sw = g.n('switch', { mode: 'conditions', firstMatchOnly: true, caseCount: 3 });
  g.f(step, 'do', sw, 'check');
  const sets = [];
  for (let i = 0; i < 3; i++) {
    const eq = g.n('statement', { operation: '==', compareType: 'numerical', _port_y: String(i) });
    g.v(get, 'value', eq, 'x');
    g.v(eq, 'result', sw, `case_${i}_cond`);
    const s = g.n('setAttribute', { attributeId: 'out', _port_value: String(10 + i) });
    g.f(sw, `case_${i}`, s, 'do');
    sets.push(s);
  }
  const dflt = g.n('setAttribute', { attributeId: 'out', _port_value: '99' });
  g.f(sw, 'default', dflt, 'do');
  const model = cellModel(g, [attrDef('k', 'integer', '0'), attrDef('out', 'float', '0')]);
  const res = traceVsStep('Switch (synthetic)', model, { W: 8, H: 8, D: 1 }, 16);
  if (res) {
    let bad = [];
    const seen = new Set();
    for (const { idx, r } of res.results) {
      const k = res.pre.r_k[idx];
      const want = k < 3 ? `case_${k}` : 'default';
      seen.add(want);
      const taken = r.events.filter(e => e[0] === 'o' && e[1] === sw.id).map(e => e[2]);
      if (taken.length !== 1 || taken[0] !== want) bad.push(`cell ${idx}: k=${k} took [${taken}] want ${want}`);
      const w = r.writes.find(x => x.param === 'w_out' && x.index === idx);
      const wantV = k < 3 ? 10 + k : 99;
      if (w?.value !== wantV) bad.push(`cell ${idx}: wrote ${w?.value} want ${wantV}`);
    }
    check('switch: the recorded case is exactly the one the value selects', bad.length === 0, bad.slice(0, 3).join(' | '));
    check('switch: several cases AND the default were exercised', seen.size >= 3, [...seen].join(','));
  }
}
if (gol) {
  // On a real model the branch set must be a FUNCTION of the pre-state (same
  // inputs ⇒ same branches) and must DISCRIMINATE (a record that never varies is
  // not evidence of anything).
  const sets = new Map();
  let inconsistent = 0;
  const nbr = golModel.neighborhoods[0];
  const nIdx = gol.st.bufs['nIdx_' + nbr.id], nSz = gol.st.bufs['nSz_' + nbr.id];
  const attr = gol.st.cellAttrs[0];
  for (const { idx, r } of gol.results) {
    const flow = r.events.filter(e => e[0] === 'f' || e[0] === 'o').map(e => e.join(':')).join('>');
    // The cell's full input state: its own attrs + the neighbourhood it reads.
    let key = gol.st.cellAttrs.map(a => gol.pre['r_' + a.id][idx]).join(',');
    for (let k = 0; k < nSz; k++) key += '|' + gol.pre['r_' + attr.id][nIdx[idx * nSz + k]];
    if (sets.has(key) && sets.get(key) !== flow) inconsistent++;
    sets.set(key, flow);
  }
  check('Game of Life: the flow record is a FUNCTION of the pre-state', inconsistent === 0, `${inconsistent} inconsistent`);
  check('Game of Life: the flow records DISCRIMINATE (> 1 distinct path)',
    new Set(sets.values()).size > 1, `${new Set(sets.values()).size} distinct paths`);
}

// ===========================================================================
section('D. ISOLATION — the sandbox is a reader');
// ===========================================================================
if (gol) {
  // A second, blunter statement of I2: run every sampled cell again and hash the
  // whole buffer set around the batch.
  const before = hashBufs(gol.st);
  for (let idx = 0; idx < gol.st.total; idx += 7) {
    M.runTrace({ fn: gol.tFn, args: gol.tArgs, paramNames: gol.tParams, elementIdx: idx, generation: 3 });
  }
  check('Game of Life: 100+ traces leave every buffer byte-identical', hashBufs(gol.st) === before);
  // …and the trace DID write somewhere (else the check above is vacuous).
  const r = M.runTrace({ fn: gol.tFn, args: gol.tArgs, paramNames: gol.tParams, elementIdx: 0, generation: 3 });
  check('…and a trace does record writes (the isolation check is not vacuous)', r.writes.length > 0, `${r.writes.length} writes`);
}

// ===========================================================================
section('E. AGENTS — a traced agent records the force the real behaviour writes');
// ===========================================================================
{
  const model = shipped('Boids - Flocking.gcaproj');
  const cb = model.centerBased ?? {};
  const norm = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  const tr = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0, { trace: true });
  check('Boids: the agent graph compiles on both builds', !norm.error && !tr.error, `${norm.error ?? ''} ${tr.error ?? ''}`);

  if (!norm.error && !tr.error) {
    const W = model.properties.gridWidth || 100, H = model.properties.gridHeight || 100;
    const attrSpecs = M.agentAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
    const bondSpecs = M.bondAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
    const s = M.createAgentStore(cb, attrSpecs, {
      wasmBacked: false, syncAttrs: cb.agentUpdateMode === 'sync',
      bondAttrSpecs: bondSpecs, fieldGates: M.resolveAgentFieldGates(model),
    });
    s.worldWidth = W; s.worldHeight = H; s.worldDepth = 1;
    const r0 = typeof cb.defaultRadius === 'number' ? cb.defaultRadius : 0.5;
    const N = 48, cols = Math.ceil(Math.sqrt(N));
    M.seedAgents(s, Array.from({ length: N }, (_, i) => ({
      x: 4 + (i % cols) * 2.2 * r0, y: 4 + Math.floor(i / cols) * 2.2 * r0, radius: r0,
    })), r0);
    for (const spec of attrSpecs) {
      const a = s.attrRead[spec.id];
      for (let i = 0; i < s.highWater; i++) a[i] = (i % 5) - 2;
      if (s.attrWrite[spec.id] !== a) s.attrWrite[spec.id].set(a);
    }
    // Give the flock some spread in velocity so the alignment/cohesion terms bite.
    for (let i = 0; i < s.highWater; i++) { s.vx[i] = ((i * 7) % 11) / 11 - 0.5; s.vy[i] = ((i * 13) % 7) / 7 - 0.5; }
    const hash = M.buildSpatialHash(s);

    const total = W * H;
    const readAttrs = {};
    for (const spec of M.cellFieldAttrsOf(model)) {
      const arr = new Float64Array(total);
      for (let i = 0; i < total; i++) arr[i] = ((i * 2654435761) % 997) / 997;
      readAttrs[spec.id] = arr;
    }
    const shape = {
      is3d: false, agentAttrs: s.attrSpecs, fieldAttrs: M.cellFieldAttrsOf(model),
      hasLookupTables: model.attributes.some(a => a.isModelAttribute && a.type === 'lookupTable'),
      bondAttrs: s.bondAttrSpecs, usesGeneration: true, gates: s.fieldGates,
    };
    const rt = {
      hash, emptyI32: new Int32Array(0), modelAttrs: {}, viewer: '',
      indicators: new Float64Array((model.indicators || []).length),
      rngState: new Uint32Array([0x12345678]), stopFlag: new Uint32Array(1),
      glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1), lookupTables: {},
      width: W, height: H, total, torus: model.properties.boundaryTreatment === 'torus',
      fieldArray: (id) => readAttrs[id], generation: 0,
      agentCreate: () => -1, agentAddToWorld: () => {},
    };
    const args = M.buildAgentAbiArgs('loop', shape, s, rt);
    const tParams = tr.trace.paramNames.agentBehaviour;
    // `params <= args` is the engine's documented direction (`_generation` is
    // pushed unconditionally while its parameter is gated), so the declared count
    // may be one SHORT of the arg list — the runner cuts to the declared count.
    check('Boids: the trace behaviour params are the loop ABI + _traceIdx, _tr',
      tParams.length - 2 <= args.length && tParams.length - 2 >= args.length - 1
      && tParams[tParams.length - 2] === '_traceIdx' && tParams[tParams.length - 1] === '_tr',
      `${tParams.length} params vs ${args.length} args`);

    // --- the REAL behaviour, ISOLATED to one agent ---
    // The whole-population run is NOT the reference: in async agent mode agent i's
    // writes are visible to agent j > i within the same step, and a rule may apply
    // force to ANOTHER agent — so `forceX[k]` after a full pass is the sum of every
    // agent's contribution, which a single-agent trace cannot (and must not)
    // reproduce. Lowering `highWater` runs the SHIPPED loop over agent 0 only; the
    // spatial hash still holds the whole flock, so agent 0 sees its real neighbours.
    // Boids DRAWS (Get Random), and the trace runs on a PRIVATE RNG stream seeded
    // from (element, generation) — D1's "re-tracing the same element at the same
    // generation gives the same answer". So the reference run is seeded with THAT
    // seed through the shipped `traceRngSeed`, which makes the comparison exact
    // instead of approximate. (The normal build writes `_rngState[0]` back, so the
    // cell is re-armed before every run.)
    const nFn = (0, eval)(norm.behaviourCode);
    const fullHW = s.highWater;
    s.forceX.fill(0); s.forceY.fill(0);
    s.highWater = 1;
    rt.rngState[0] = M.traceRngSeed(0, 0);
    nFn(...M.buildAgentAbiArgs('loop', shape, s, rt));
    const soloFX = s.forceX[0], soloFY = s.forceY[0];
    s.highWater = fullHW;
    s.forceX.fill(0); s.forceY.fill(0);
    rt.rngState[0] = 0x12345678;
    nFn(...args);
    const realFX = s.forceX.slice(), realFY = s.forceY.slice();
    check('Boids: the real behaviour produced non-zero forces',
      realFX.some(v => v !== 0) || realFY.some(v => v !== 0));

    // --- back to zero, then trace individual agents ---
    s.forceX.fill(0); s.forceY.fill(0);
    const beforeX = hashArr(s.forceX), beforeVX = hashArr(s.vx), beforeA = attrSpecs.map(sp => hashArr(s.attrRead[sp.id])).join('|');
    const tFn = (0, eval)(tr.behaviourCode);
    {
      const r0 = M.runTrace({ fn: (0, eval)(tr.behaviourCode), args, paramNames: tParams, elementIdx: 0, generation: 0 });
      const fx0 = r0.writes.find(w => w.param === '_agentForceX' && w.index === 0);
      const fy0 = r0.writes.find(w => w.param === '_agentForceY' && w.index === 0);
      check('Boids: the traced force EQUALS the isolated real behaviour (agent 0)',
        Math.abs((fx0?.value ?? 0) - soloFX) < 1e-12 && Math.abs((fy0?.value ?? 0) - soloFY) < 1e-12,
        `traced (${fx0?.value}, ${fy0?.value}) vs isolated (${soloFX}, ${soloFY}) vs full-pass (${realFX[0]}, ${realFY[0]})`);
    }
    let bad = [], traced = 0, forced = 0;
    for (let id = 0; id < s.highWater; id += 5) {
      const r = M.runTrace({ fn: tFn, args, paramNames: tParams, elementIdx: id, generation: 0 });
      if (r.error) { bad.push(`agent ${id} threw: ${r.error}`); break; }
      traced++;
      // A self-force rule must write the TRACED agent's force lane and no other:
      // a stray index would mean the single-element body ran for someone else.
      for (const w of r.writes) {
        if ((w.param === '_agentForceX' || w.param === '_agentForceY') && w.index !== id) {
          bad.push(`agent ${id}: wrote ${w.param}[${w.index}]`);
        }
      }
      if (r.writes.some(w => w.param === '_agentForceX' && w.index === id)) forced++;
      if (r.events.length === 0) bad.push(`agent ${id}: empty event log`);
    }
    check(`Boids: every traced agent writes only ITS OWN force lane (${traced} agents)`, bad.length === 0, bad.slice(0, 3).join(' | '));
    check('Boids: every traced agent produced a force write', forced === traced, `${forced}/${traced}`);
    check('Boids: the agent store is untouched by the traces',
      hashArr(s.forceX) === beforeX && hashArr(s.vx) === beforeVX
      && attrSpecs.map(sp => hashArr(s.attrRead[sp.id])).join('|') === beforeA);
  }
}

{
  // A deterministic (RNG-free) agent rule: force from the agent's own attribute and
  // position, plus a self attribute write. No cross-agent write and no draw, so the
  // FULL-population run is a valid per-agent reference for every agent at once.
  const g = mkGraph();
  const bs = g.n('behaviourStep');
  const getK = g.n('getCellAttribute', { attributeId: 'k' });
  const fx = g.n('arithmeticOperator', { operation: '*', _port_y: '2' });
  g.v(getK, 'value', fx, 'x');
  const fy = g.n('arithmeticOperator', { operation: '*', _port_y: '0.5' });
  g.v(bs, 'myX', fy, 'x');
  const af = g.n('applyForce');
  g.f(bs, 'do', af, 'do');
  g.v(fx, 'result', af, 'fx');
  g.v(fy, 'result', af, 'fy');
  const inc = g.n('arithmeticOperator', { operation: '+', _port_y: '1' });
  g.v(getK, 'value', inc, 'x');
  const setK = g.n('setAttribute', { attributeId: 'k' });
  g.f(af, 'next', setK, 'do');
  g.v(inc, 'result', setK, 'value');

  const model = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'TRA', description: '', topology: '2d-grid', boundaryTreatment: 'torus',
      updateMode: 'synchronous', gridWidth: 40, gridHeight: 40, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: [], neighborhoods: [], mappings: [], indicators: [],
    graphNodes: [], graphEdges: [], macroDefs: [],
    agentGraphNodes: g.nodes, agentGraphEdges: g.edges,
    agentAttributes: [{ id: 'k', name: 'k', type: 'float', description: '', defaultValue: '0' }],
    topologyMode: { gridCells: false, agents: true },
    centerBased: {
      maxAgents: 64, seedCount: 0, seedPattern: 'none', worldWidth: 40, worldHeight: 40,
      defaultRadius: 1, maxBonds: 0, agentUpdateMode: 'async',
    },
  });
  const norm = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
  const tr = M.compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0, { trace: true });
  check('synthetic agents: both builds compile', !norm.error && !tr.error, `${norm.error ?? ''} ${tr.error ?? ''}`);
  if (!norm.error && !tr.error) {
    const attrSpecs = M.agentAttrsOf(model).map(a => ({ id: a.id, type: a.type, defaultValue: 0 }));
    const s = M.createAgentStore(model.centerBased, attrSpecs, {
      wasmBacked: false, syncAttrs: false, bondAttrSpecs: [], fieldGates: M.resolveAgentFieldGates(model),
    });
    s.worldWidth = 40; s.worldHeight = 40; s.worldDepth = 1;
    const N = 24;
    M.seedAgents(s, Array.from({ length: N }, (_, i) => ({ x: 2 + (i % 6) * 3, y: 2 + Math.floor(i / 6) * 3, radius: 1 })), 1);
    const kArr = s.attrRead['k'];
    for (let i = 0; i < s.highWater; i++) kArr[i] = (i % 7) - 3;
    const preK = kArr.slice(), preX = s.x.slice();
    const shape = {
      is3d: false, agentAttrs: s.attrSpecs, fieldAttrs: [], hasLookupTables: false,
      bondAttrs: [], usesGeneration: true, gates: s.fieldGates,
    };
    const rt = {
      hash: M.buildSpatialHash(s), emptyI32: new Int32Array(0), modelAttrs: {}, viewer: '',
      indicators: new Float64Array(0), rngState: new Uint32Array([0x12345678]), stopFlag: new Uint32Array(1),
      glyphCodes: new Uint32Array(1), glyphColors: new Uint32Array(1), lookupTables: {},
      width: 40, height: 40, total: 1600, torus: true, fieldArray: () => new Float64Array(0),
      generation: 0, agentCreate: () => -1, agentAddToWorld: () => {},
    };
    const args = M.buildAgentAbiArgs('loop', shape, s, rt);
    s.forceX.fill(0); s.forceY.fill(0);
    (0, eval)(norm.behaviourCode)(...args);
    const realFX = s.forceX.slice(), realFY = s.forceY.slice(), realK = kArr.slice();
    // Back to the pre-step state, then trace every agent.
    kArr.set(preK); s.forceX.fill(0); s.forceY.fill(0);
    const tParams = tr.trace.paramNames.agentBehaviour;
    const tFn = (0, eval)(tr.behaviourCode);
    const before = [hashArr(s.forceX), hashArr(kArr), hashArr(s.x)].join('|');
    let bad = [];
    for (let id = 0; id < s.highWater; id++) {
      const r = M.runTrace({ fn: tFn, args, paramNames: tParams, elementIdx: id, generation: 0 });
      if (r.error) { bad.push(`agent ${id} threw: ${r.error}`); break; }
      const fxw = r.writes.find(w => w.param === '_agentForceX' && w.index === id);
      const fyw = r.writes.find(w => w.param === '_agentForceY' && w.index === id);
      const kw = r.writes.find(w => w.param === 'w_k' && w.index === id);
      if (Math.abs((fxw?.value ?? 0) - realFX[id]) > 1e-12) bad.push(`agent ${id} fx: ${fxw?.value} vs ${realFX[id]}`);
      if (Math.abs((fyw?.value ?? 0) - realFY[id]) > 1e-12) bad.push(`agent ${id} fy: ${fyw?.value} vs ${realFY[id]}`);
      if (Math.abs((kw?.value ?? NaN) - realK[id]) > 1e-12) bad.push(`agent ${id} k: ${kw?.value} vs ${realK[id]}`);
      if (Math.abs((fxw?.value ?? 0) - preK[id] * 2) > 1e-12) bad.push(`agent ${id} fx is not 2k: ${fxw?.value} vs ${preK[id] * 2}`);
      if (Math.abs((fyw?.value ?? 0) - preX[id] * 0.5) > 1e-12) bad.push(`agent ${id} fy is not x/2: ${fyw?.value} vs ${preX[id] * 0.5}`);
    }
    check(`synthetic agents: EVERY traced agent's force + attribute write equals the real behaviour (${s.highWater} agents)`,
      bad.length === 0, bad.slice(0, 3).join(' | '));
    check('synthetic agents: the store is untouched by the traces',
      [hashArr(s.forceX), hashArr(kArr), hashArr(s.x)].join('|') === before);
  }
}

// ===========================================================================
section('F. THE RUNNER — cap, escape, error capture, private RNG, shadow reads');
// ===========================================================================
{
  const base = new Float64Array([1, 2, 3, 4, 5]);
  const paramNames = ['arr', '_rngState', 'fn', '_traceIdx', '_tr'];
  const rng = new Uint32Array([7]);
  const stub = () => 42;

  // Shadow read-after-write + no leak.
  {
    let readBack = null;
    const fn = (arr, rs, f, idx, tr) => {
      arr[1] = 99;
      readBack = arr[1];
      tr.v('n1', 'value', arr[1]);
      tr.v('n1', 'arr', arr);
    };
    const r = M.runTrace({ fn, args: [base, rng, stub], paramNames, elementIdx: 1, generation: 0 });
    check('runner: a read after a write sees the WRITE', readBack === 99, String(readBack));
    // ALIASING BY IDENTITY: the same array under two names (async `r === w`) is
    // ONE shadow — a write through `w` is visible through `r` (the engine's
    // single-buffer semantics); with `sharedProxies: false` (the WebGPU dropped-
    // write-buffer case) the two names keep separate shadows and `r` stays pre-state.
    {
      const aliased = new Float64Array([10, 20, 30]);
      const names = ['r_a', 'w_a', '_rngState', '_traceIdx', '_tr'];
      let seenShared = null, seenSplit = null;
      const fnA = (r, w, rs, idx, tr) => { w[idx] = 77; seenShared = r[idx]; };
      M.runTrace({ fn: fnA, args: [aliased, aliased, rng], paramNames: names, elementIdx: 1, generation: 0 });
      const fnB = (r, w, rs, idx, tr) => { w[idx] = 77; seenSplit = r[idx]; };
      M.runTrace({ fn: fnB, args: [aliased, aliased, rng], paramNames: names, elementIdx: 1, generation: 0, sharedProxies: false });
      check('runner: an ALIASED buffer (r === w) shares ONE shadow by default — r sees the write through w', seenShared === 77, String(seenShared));
      check('runner: with sharedProxies:false the aliased names keep separate shadows — r stays pre-state', seenSplit === 20, String(seenSplit));
      check('runner: the aliased base array is untouched either way', aliased[1] === 20, String(aliased[1]));
    }
    check('runner: the base array is untouched', base[1] === 2, String(base[1]));
    const w = r.writes.find(x => x.param === 'arr' && x.index === 1);
    check('runner: the write is recorded with its previous value', w && w.value === 99 && w.prev === 2, JSON.stringify(w));
    const arrEv = r.events.find(e => e[0] === 'v' && e[2] === 'arr');
    check('runner: an array value is recorded as a bounded COPY with its true length',
      arrEv && arrEv[3] && arrEv[3].len === 5 && arrEv[3].arr[1] === 99, JSON.stringify(arrEv?.[3]));
  }
  // Bulk writers are no-ops.
  {
    const other = new Float64Array([9, 9, 9, 9, 9]);
    const fn = (arr) => { arr.set(other); arr.fill(7); };
    M.runTrace({ fn, args: [base, rng, stub], paramNames, elementIdx: 0, generation: 0 });
    check('runner: .set / .fill on a wrapped buffer are no-ops', base[0] === 1 && base[4] === 5);
  }
  // The escape guard.
  {
    let threw = null;
    try {
      M.runTrace({ fn: (arr) => arr.subarray(0, 2), args: [base, rng, stub], paramNames, elementIdx: 0, generation: 0 });
    } catch (e) { threw = e; }
    check('runner: .subarray on a wrapped buffer throws TraceSandboxEscape',
      threw instanceof M.TraceSandboxEscape, String(threw));
  }
  // Errors are captured, never rethrown.
  {
    const r = M.runTrace({ fn: () => { throw new Error('boom'); }, args: [base, rng, stub], paramNames, elementIdx: 0, generation: 0 });
    check('runner: a throwing trace is captured into result.error', r.error === 'boom', String(r.error));
  }
  // The event cap.
  {
    const fn = (arr, rs, f, idx, tr) => { for (let i = 0; i < M.TRACE_MAX_EVENTS + 500; i++) tr.f('n' + i); };
    const r = M.runTrace({ fn, args: [base, rng, stub], paramNames, elementIdx: 0, generation: 0 });
    check('runner: the event log is capped and flagged truncated',
      r.truncated === true && r.events.length === M.TRACE_MAX_EVENTS, `${r.events.length} events`);
  }
  // The RNG cell is PRIVATE and stable per (element, generation).
  {
    const seen = [];
    const fn = (arr, rs, f, idx, tr) => { seen.push(rs[0]); rs[0] = 12345; };
    M.runTrace({ fn, args: [base, rng, stub], paramNames, elementIdx: 4, generation: 9 });
    M.runTrace({ fn, args: [base, rng, stub], paramNames, elementIdx: 4, generation: 9 });
    M.runTrace({ fn, args: [base, rng, stub], paramNames, elementIdx: 5, generation: 9 });
    check('runner: the engine RNG cell is never touched', rng[0] === 7, String(rng[0]));
    check('runner: the same (element, generation) draws the same seed', seen[0] === seen[1], seen.join(','));
    check('runner: a different element draws a different seed', seen[2] !== seen[0], seen.join(','));
    check('runner: the seed is never 0 (a dead xorshift stream)',
      M.traceRngSeed(0, 0) !== 0 && M.traceRngSeed(-1, -1) !== 0);
  }
  // Host functions are stubbed and recorded.
  {
    let got;
    const names = ['arr', '_rngState', '_agentCreate', '_traceIdx', '_tr'];
    const fn = (arr, rs, create, idx, tr) => { got = create(1, 2, 3, 4); };
    const r = M.runTrace({ fn, args: [base, rng, () => { throw new Error('the real closure ran'); }], paramNames: names, elementIdx: 0, generation: 0 });
    check('runner: _agentCreate is stubbed to -1 (a trace must not spawn)', got === -1, String(got));
    const q = r.events.find(e => e[0] === 'q');
    check('runner: the stubbed call is recorded as a request event',
      q && q[1] === '_agentCreate' && q[2][0] === 1, JSON.stringify(q));
  }
  // A GLOBAL root (no `_traceIdx` in the param list) gets ONLY `_tr`.
  {
    let arity = null;
    const fn = function (a, b) { arity = arguments.length; };
    M.runTrace({ fn, args: [base], paramNames: ['arr', '_tr'], generation: 0 });
    check('runner: a global root receives exactly one trailing arg (_tr)', arity === 2, String(arity));
  }
}

// ===========================================================================
section('G. NEGATIVE CONTROLS — each fault must FAIL a named check');
// ===========================================================================
{
  // (1) The record emission removed.
  const tr = M.compileGraph(golModel.graphNodes, golModel.graphEdges, golModel, { trace: true });
  const countRecords = (code) => (code.match(/_tr\.v\(/g) || []).length;
  check('control: the Game of Life trace step DOES emit value records', countRecords(tr.stepCode) > 5, String(countRecords(tr.stepCode)));
  expectFail('the _tr.v emission removed', () => {
    const stripped = tr.stepCode.replace(/_tr\.v\([^;]*\);/g, '');
    check('Game of Life: the trace step emits value records', countRecords(stripped) > 5, String(countRecords(stripped)));
  });

  // (2) The shadow `set` trap broken — writes reach the base array.
  expectFail('the shadow set trap broken (writes reach the base buffer)', () => {
    const base = new Float64Array([1, 2, 3]);
    const before = hashArr(base);
    // A deliberately BROKEN wrapper: pass the live array straight through.
    const brokenArgs = [base];
    ((arr) => { arr[0] = 42; })(...brokenArgs);
    check('the sandbox left every engine buffer byte-identical', hashArr(base) === before);
  });

  // (3) A pass's origin fold dropped.
  let lowered = null, model3 = null, tr3 = null;
  for (const f of modelFiles) {
    const m = M.migrateForHarness(JSON.parse(readFileSync(join(modelsDir, f), 'utf8')));
    const t = M.compileGraph(m.graphNodes, m.graphEdges, m, { trace: true });
    if (!t.trace) continue;
    const ids = new Set();
    RECORD_ID.lastIndex = 0;
    let mm;
    while ((mm = RECORD_ID.exec(t.stepCode || '')) !== null) ids.add(mm[1]);
    const hit = [...ids].find(id => t.trace.origin[id]);
    if (hit) { lowered = hit; model3 = m; tr3 = t; break; }
  }
  check('control: at least one shipped model records a LOWERED id', !!lowered, String(lowered));
  if (lowered) {
    const ids = userIdSet(model3, 'cells');
    const o = M.resolveTraceOrigin(lowered, tr3.trace.origin);
    check('control: with the origin table, that id resolves to a user node',
      ids.has(o.nodeId) || o.nodeId.startsWith('linked:'), JSON.stringify(o));
    expectFail('the origin fold dropped (an empty table)', () => {
      const o2 = M.resolveTraceOrigin(lowered, {});
      check('every recorded id resolves to a user node', ids.has(o2.nodeId) || o2.nodeId.startsWith('linked:'), JSON.stringify(o2));
    });
  }
}

// ===========================================================================
// ===========================================================================
section('H. SCOPE MAPPING — originInScope (P3)');
// ===========================================================================
{
  const inScope = M.originInScope;
  const at = (nodeId, ...macroPath) => (macroPath.length ? { nodeId, macroPath } : { nodeId });

  // --- the ROOT scope -----------------------------------------------------
  {
    const r = inScope(at('n1'), []);
    check('scope []: a top-level node is visible AS ITSELF', r.visible && r.nodeId === 'n1', JSON.stringify(r));
  }
  {
    const r = inScope(at('inner1', 'instA'), []);
    check('scope []: a node inside a macro rolls up to the INSTANCE node',
      r.visible && r.nodeId === 'instA', JSON.stringify(r));
  }
  {
    const r = inScope(at('deep', 'instA', 'instB'), []);
    check('scope []: a node two levels deep rolls up to the OUTERMOST instance',
      r.visible && r.nodeId === 'instA', JSON.stringify(r));
  }

  // --- INSIDE one instance ------------------------------------------------
  {
    const r = inScope(at('inner1', 'instA'), ['instA']);
    check('scope [instA]: its own inner node is visible AS ITSELF',
      r.visible && r.nodeId === 'inner1', JSON.stringify(r));
  }
  {
    const r = inScope(at('n1'), ['instA']);
    check('scope [instA]: a TOP-LEVEL node is NOT visible', !r.visible, JSON.stringify(r));
  }
  {
    const r = inScope(at('inner1', 'instC'), ['instA']);
    check('scope [instA]: another instance is NOT visible', !r.visible, JSON.stringify(r));
  }
  {
    const r = inScope(at('deep', 'instA', 'instB'), ['instA']);
    check('scope [instA]: a nested node lights the NESTED INSTANCE (one level down)',
      r.visible && r.nodeId === 'instB', JSON.stringify(r));
  }

  // --- NESTED scope -------------------------------------------------------
  {
    const r = inScope(at('deep', 'instA', 'instB'), ['instA', 'instB']);
    check('scope [instA,instB]: the node itself', r.visible && r.nodeId === 'deep', JSON.stringify(r));
  }
  {
    const r = inScope(at('deep', 'instA', 'instB'), ['instA', 'instX']);
    check('scope [instA,instX]: a different nested instance is NOT visible', !r.visible, JSON.stringify(r));
  }
  {
    const r = inScope(at('inner1', 'instA'), ['instA', 'instB']);
    check('a SHALLOWER origin is not visible in a DEEPER scope', !r.visible, JSON.stringify(r));
  }

  // --- the SAME def instanced twice: identical inner ids, different paths ---
  {
    const a = inScope(at('sharedInner', 'instA'), ['instA']);
    const b = inScope(at('sharedInner', 'instB'), ['instA']);
    check('two instances of ONE macro def stay apart (same inner id, different path)',
      a.visible && a.nodeId === 'sharedInner' && !b.visible, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    const rootA = inScope(at('sharedInner', 'instA'), []);
    const rootB = inScope(at('sharedInner', 'instB'), []);
    check('…and at the root they light their OWN instance node',
      rootA.nodeId === 'instA' && rootB.nodeId === 'instB', `${rootA.nodeId} / ${rootB.nodeId}`);
  }

  // --- through the REAL resolver ------------------------------------------
  // The origins above are hand-built; this proves the pair composes on a table
  // of the shape `expandMacros` actually folds (a macro-prefixed lowered id).
  {
    const table = { 'minstA_inner1': { nodeId: 'inner1', macroPath: ['instA'] } };
    const resolved = M.resolveTraceOrigin('minstA_inner1', table);
    const root = inScope(resolved, []);
    const inner = inScope(resolved, ['instA']);
    check('resolveTraceOrigin → originInScope composes (root ⇒ instance, inside ⇒ inner)',
      root.visible && root.nodeId === 'instA' && inner.visible && inner.nodeId === 'inner1',
      `${JSON.stringify(root)} / ${JSON.stringify(inner)}`);
  }

  // NEGATIVE CONTROL: the "strip the scope prefix and take what is left" rule a
  // scope mapping is usually written as — it lights the LAST element instead of
  // the next one down, so a two-level path lights the wrong node at the root.
  expectFail('a scope rule that takes the LAST path element instead of the next one', () => {
    const naive = (o) => ({ visible: true, nodeId: (o.macroPath ?? []).at(-1) ?? o.nodeId });
    const r = naive(at('deep', 'instA', 'instB'));
    check('scope []: a node two levels deep rolls up to the OUTERMOST instance',
      r.visible && r.nodeId === 'instA', JSON.stringify(r));
  });
  // NEGATIVE CONTROL: no prefix test at all — every instance would light.
  expectFail('a scope rule with no prefix test (every instance lights)', () => {
    const naive = (o, scope) => ({ visible: true, nodeId: (o.macroPath ?? [])[scope.length] ?? o.nodeId });
    const r = naive(at('inner1', 'instC'), ['instA']);
    check('scope [instA]: another instance is NOT visible', !r.visible, JSON.stringify(r));
  });
}


section('I. THE EDITOR MAP — reroute chains, the value cone, the two id spaces (P4)');
// ===========================================================================
{
  const idx = M.buildEditorTraceIndex;
  const cone = M.valueConeFrom;
  const inEditorScope = M.originInEditorScope;

  const vNode = (id) => ({ id, type: 'caNode', data: { nodeType: 'compare', config: {} } });
  const rNode = (id, cat = 'value') => ({ id, type: 'rerouteNode', data: { nodeType: 'reroute', portCategory: cat } });
  const vEdge = (id, s, sp, t, tp) => ({ id, source: s, sourceHandle: `output_value_${sp}`, target: t, targetHandle: `input_value_${tp}` });
  const fEdge = (id, s, sp, t, tp) => ({ id, source: s, sourceHandle: `output_flow_${sp}`, target: t, targetHandle: `input_flow_${tp}` });

  // --- a REROUTE CHAIN: A -> R1 -> R2 -> B, one lowered edge, three editor ones
  {
    const nodes = [vNode('A'), rNode('R1'), rNode('R2'), vNode('B')];
    const edges = [
      vEdge('e1', 'A', 'result', 'R1', 'in'),
      { id: 'e2', source: 'R1', sourceHandle: 'output_value_out', target: 'R2', targetHandle: 'input_value_in' },
      { id: 'e3', source: 'R2', sourceHandle: 'output_value_out', target: 'B', targetHandle: 'input_value_x' },
    ];
    const ix = idx(nodes, edges);
    const origins = ['e1', 'e2', 'e3'].map(e => ix.edgeOrigin.get(e));
    check('reroute chain: EVERY editor segment resolves to the ONE real source port',
      origins.every(o => o && o.nodeId === 'A' && o.portId === 'result' && o.category === 'value'),
      JSON.stringify(origins));
    check('reroute chain: both DOTS relay that same source port',
      ix.rerouteOrigin.get('R1')?.nodeId === 'A' && ix.rerouteOrigin.get('R2')?.nodeId === 'A',
      JSON.stringify([...ix.rerouteOrigin]));
    check('reroute chain: the consumer value source is A, not a dot',
      JSON.stringify(ix.valueSources.get('B')) === JSON.stringify(['A']),
      JSON.stringify([...ix.valueSources]));
    check('a reroute is NOT itself a value consumer', !ix.valueSources.has('R1') && !ix.valueSources.has('R2'));
  }

  // --- a FLOW reroute: the taken wire must know the REAL node it ends on
  {
    const nodes = [vNode('IF'), rNode('RF', 'flow'), vNode('SET')];
    const edges = [
      fEdge('f1', 'IF', 'then', 'RF', 'in'),
      { id: 'f2', source: 'RF', sourceHandle: 'output_flow_out', target: 'SET', targetHandle: 'input_flow_do' },
    ];
    const ix = idx(nodes, edges);
    check('flow reroute: the first segment already carries IF:then',
      ix.edgeOrigin.get('f1')?.portId === 'then' && ix.edgeOrigin.get('f1')?.category === 'flow');
    check('flow reroute: the first segment REAL target is SET (not the dot)',
      JSON.stringify(ix.edgeTargets.get('f1')) === JSON.stringify(['SET']),
      JSON.stringify(ix.edgeTargets.get('f1')));
  }

  // --- fan-out + a dangling dot (the shapes `collapseReroutes` also tolerates)
  {
    const nodes = [vNode('A'), rNode('R'), vNode('B'), vNode('C'), rNode('D')];
    const edges = [
      vEdge('e1', 'A', 'result', 'R', 'in'),
      { id: 'e2', source: 'R', sourceHandle: 'output_value_out', target: 'B', targetHandle: 'input_value_x' },
      { id: 'e3', source: 'R', sourceHandle: 'output_value_out', target: 'C', targetHandle: 'input_value_x' },
      { id: 'e4', source: 'D', sourceHandle: 'output_value_out', target: 'C', targetHandle: 'input_value_y' },
    ];
    const ix = idx(nodes, edges);
    check('fan-out: both consumers resolve to A',
      ix.edgeOrigin.get('e2')?.nodeId === 'A' && ix.edgeOrigin.get('e3')?.nodeId === 'A');
    check('a dot relaying NOTHING contributes no origin and no source',
      !ix.edgeOrigin.has('e4') && JSON.stringify(ix.valueSources.get('C')) === JSON.stringify(['A']),
      JSON.stringify([...ix.valueSources]));
  }

  // --- THE VALUE CONE ------------------------------------------------------
  {
    // GET -> CMP -> IF(flow) ; STRAY -> OTHER, which nothing executed reads
    const nodes = ['GET', 'CMP', 'IF', 'STRAY', 'OTHER'].map(vNode);
    const edges = [
      vEdge('e1', 'GET', 'value', 'CMP', 'x'),
      vEdge('e2', 'CMP', 'result', 'IF', 'condition'),
      vEdge('e3', 'STRAY', 'value', 'OTHER', 'x'),
    ];
    const ix = idx(nodes, edges);
    const c = cone(['IF'], ix);
    check('the cone of a flow node is its TRANSITIVE value inputs',
      c.has('CMP') && c.has('GET'), JSON.stringify([...c]));
    check('a value node nothing executed reads is OUTSIDE the cone',
      !c.has('STRAY') && !c.has('OTHER'), JSON.stringify([...c]));
    check('the cone of nothing is empty', cone([], ix).size === 0);
    // A cycle cannot be drawn by the editor, but a hand-edited file could.
    const cyc = idx(nodes, [...edges, vEdge('e4', 'CMP', 'result', 'GET', 'x')]);
    check('a value CYCLE terminates', cone(['IF'], cyc).size === 2);
  }

  // --- THE TWO ID SPACES ---------------------------------------------------
  // One def `D`, instanced TWICE (`iA`, `iB`). The editor's scope names `D`.
  {
    const defOf = (i) => ({ iA: 'D', iB: 'D', iX: 'E' }[i] ?? i);
    const rec = (nodeId, ...macroPath) => (macroPath.length ? { nodeId, macroPath } : { nodeId });

    const rootA = inEditorScope(rec('inner', 'iA'), [], defOf);
    const rootB = inEditorScope(rec('inner', 'iB'), [], defOf);
    check('root scope: each instance lights its OWN node',
      rootA.nodeId === 'iA' && rootB.nodeId === 'iB', `${rootA.nodeId}/${rootB.nodeId}`);

    const inA = inEditorScope(rec('inner', 'iA'), ['D'], defOf);
    const inB = inEditorScope(rec('inner', 'iB'), ['D'], defOf);
    check('inside def D: BOTH instances light the def own node (the editor edits the DEF)',
      inA.visible && inA.nodeId === 'inner' && inB.visible && inB.nodeId === 'inner',
      `${JSON.stringify(inA)}/${JSON.stringify(inB)}`);

    const other = inEditorScope(rec('inner', 'iX'), ['D'], defOf);
    check('inside def D: an instance of a DIFFERENT def is not visible', !other.visible, JSON.stringify(other));

    const top = inEditorScope(rec('n1'), ['D'], defOf);
    check('inside def D: a TOP-LEVEL node is not visible', !top.visible, JSON.stringify(top));

    const nested = inEditorScope(rec('deep', 'iA', 'iN'), ['D'], defOf);
    check('inside def D: a nested record lights the NESTED INSTANCE node (instance space)',
      nested.visible && nested.nodeId === 'iN', JSON.stringify(nested));

    const plain = inEditorScope(rec('n1'), [], defOf);
    check('a top-level record at the root scope is itself', plain.visible && plain.nodeId === 'n1');
  }

  // --- the macro instance -> def index, and the OUTPUT bridge --------------
  {
    const root = [
      { id: 'iA', data: { nodeType: 'macro', config: { macroDefId: 'D' } } },
      { id: 'n1', data: { nodeType: 'compare', config: {} } },
    ];
    const defNodes = [
      { id: 'iN', data: { nodeType: 'macro', config: { macroDefId: 'E' } } },
      { id: 'inner', data: { nodeType: 'compare', config: {} } },
      { id: 'mo', data: { nodeType: 'macroOutput', config: {} } },
    ];
    const index = M.buildMacroDefIndex([root, defNodes]);
    check('the instance index maps every macro instance, at every level',
      index.get('iA') === 'D' && index.get('iN') === 'E' && !index.has('n1'),
      JSON.stringify([...index]));

    const bridge = M.buildMacroOutputMap([{
      id: 'D',
      nodes: defNodes,
      edges: [{ id: 'x1', source: 'inner', sourceHandle: 'output_value_result', target: 'mo', targetHandle: 'input_value_out_0' }],
    }]);
    check('the macroOutput bridge maps inner:port -> the INSTANCE output port',
      JSON.stringify(bridge.get('D')?.get('inner:result')) === JSON.stringify(['out_0']),
      JSON.stringify([...(bridge.get('D') ?? [])]));
    check('a def with no macroOutput contributes nothing',
      M.buildMacroOutputMap([{ id: 'Z', nodes: [], edges: [] }]).size === 0);
  }

  // NEGATIVE CONTROL: an index that stops at the IMMEDIATE source — the naive
  // reading of an edge — leaves a reroute chain dark past the first dot.
  expectFail('an edge origin that does not walk the reroute chain', () => {
    const naive = (edges) => new Map(edges.map(e => [e.id, {
      nodeId: e.source, portId: e.sourceHandle.split('_').slice(2).join('_'), category: 'value',
    }]));
    const edges = [
      vEdge('e1', 'A', 'result', 'R1', 'in'),
      { id: 'e3', source: 'R2', sourceHandle: 'output_value_out', target: 'B', targetHandle: 'input_value_x' },
    ];
    const built = naive(edges);
    const origins = ['e1', 'e3'].map(e => built.get(e));
    check('reroute chain: EVERY editor segment resolves to the ONE real source port',
      origins.every(o => o && o.nodeId === 'A' && o.portId === 'result' && o.category === 'value'),
      JSON.stringify(origins));
  });

  // NEGATIVE CONTROL: comparing the trace's INSTANCE path against the editor's
  // DEF scope directly (i.e. `originInScope` with no translation) — nothing
  // inside any macro would ever light.
  expectFail('a scope test that compares instance ids against a DEF scope', () => {
    const r = M.originInScope({ nodeId: 'inner', macroPath: ['iA'] }, ['D']);
    check('inside def D: BOTH instances light the def own node (the editor edits the DEF)',
      r.visible && r.nodeId === 'inner', JSON.stringify(r));
  });
}

// ===========================================================================
section('J. VALUES (P5) — raw writes back into the sentences the panel shows');
// ===========================================================================
// The Trace panel renders what `traceValues.ts` returns and decides nothing
// about what a write MEANS, so this section IS the panel's correctness: a
// parameter name, a flat index and two numbers must come back out as "this
// attribute changed", "that write was aimed at the neighbour above", "a Form
// Between was queued" — and NOTHING the trace wrote may go missing on the way.
{
  const W = 10, H = 10;
  const dims2d = { W, H, D: 1 };
  const dims3d = { W: 4, H: 4, D: 4 };
  const idx = 55;                       // (r 5, c 5) on a 10x10 grid
  const attrs = [
    { id: 'alive', name: 'alive', type: 'bool' },
    { id: 'age', name: 'age', type: 'integer' },
    { id: 'energy', name: 'energy', type: 'float' },
  ];
  const cellTarget = { kind: 'cell', idx };
  const rowsOf = (writes, extra = {}) => M.buildTraceRows({
    target: cellTarget, writes, events: [], attrs, dims: dims2d,
    snapshot: { alive: 1, age: 3, energy: 4.25 }, ...extra,
  });
  const rowFor = (res, key) => res.rows.find(r => r.key === key);

  // --- current → next, and the accent ------------------------------------
  {
    const res = rowsOf([
      { param: 'w_alive', index: idx, value: 0, prev: 1 },
      { param: 'w_age', index: idx, value: 0, prev: 3 },
    ]);
    const alive = rowFor(res, 'attr:alive');
    check('a written attribute reads current -> next and is marked CHANGED',
      alive?.current?.v === 1 && alive?.next?.v === 0 && alive.changed === true,
      JSON.stringify(alive));
    const energy = rowFor(res, 'attr:energy');
    check('an UNwritten attribute mirrors current and is marked unchanged',
      energy?.current?.v === 4.25 && energy?.next?.v === 4.25
      && energy.changed === false && energy.unchanged === true,
      JSON.stringify(energy));
    check('rows keep DECLARATION order (A6 — a changed row is accented, never re-sorted)',
      res.rows.slice(0, 3).map(r => r.key).join(',') === 'attr:alive,attr:age,attr:energy',
      res.rows.map(r => r.key).join(','));
    check('a write that lands on the SAME value is not accented',
      rowFor(rowsOf([{ param: 'w_age', index: idx, value: 3, prev: 3 }]), 'attr:age').changed === false);
  }

  // --- neighbour writes ---------------------------------------------------
  {
    // idx 55 = (5,5); idx 45 = (4,5) -> (dr -1, dc 0).
    const res = rowsOf([{ param: 'w_energy', index: 45, value: 4.65, prev: 4.25 }]);
    const nbr = rowFor(res, 'nbr:energy:45');
    check('a write at ANOTHER index becomes a neighbour row with the right offset',
      nbr?.name === '(-1, 0) energy' && nbr.note === 'write to another cell',
      JSON.stringify(nbr));
    check('the traced cell own-attribute row is NOT consumed by the neighbour write',
      rowFor(res, 'attr:energy').unchanged === true);
    // The torus edge: row 0 writing row 9 of a 10-row grid is `dr -1`, not `dr +9`.
    const wrapped = M.neighbourOffset(5, 95, dims2d);
    check('a wrapped neighbour write reads as the SHORT offset, not the long way round',
      wrapped.dr === -1 && wrapped.dc === 0, JSON.stringify(wrapped));
    // 3D: the layer axis.
    const o3 = M.neighbourOffset(1 * 16 + 1 * 4 + 1, 2 * 16 + 1 * 4 + 1, dims3d);
    check('3D: a write one layer up decodes as (dr, dc, dl) with dl = +1',
      o3.dr === 0 && o3.dc === 0 && o3.dl === 1 && M.formatOffset(o3, true) === '(0, 0, 1)',
      JSON.stringify(o3));
  }

  // --- colour, indicators, stop -------------------------------------------
  {
    const res = rowsOf([
      { param: 'colors', index: idx * 4, value: 32, prev: 0 },
      { param: 'colors', index: idx * 4 + 1, value: 32, prev: 0 },
      { param: 'colors', index: idx * 4 + 2, value: 32, prev: 0 },
      { param: 'colors', index: idx * 4 + 3, value: 255, prev: 255 },
      { param: '_indicators', index: 1, value: 7, prev: 6 },
      { param: '_stopFlag', index: 0, value: 2, prev: 0 },
    ], { indicatorNames: ['births', 'deaths'], stopMessage: 'All cells died' });
    const col = rowFor(res, 'colour');
    check('the Output Mapping colour is read off the colors run as an RGB triple',
      col?.next?.kind === 'hex' && col.next.rgb.join(',') === '32,32,32', JSON.stringify(col));
    const ind = rowFor(res, 'indicator:1');
    check('an indicator write is NAMED from the model order (index 1 = deaths)',
      ind?.name === 'deaths' && ind.current.v === 6 && ind.next.v === 7, JSON.stringify(ind));
    check('a raised stop flag shows the RESOLVED message, not the flag index',
      rowFor(res, 'stop')?.next?.text === 'All cells died');
    check('a stop flag the panel could not resolve still says it was raised',
      M.buildTraceRows({
        target: cellTarget, writes: [{ param: '_stopFlag', index: 0, value: 1, prev: 0 }],
        events: [], attrs, dims: dims2d,
      }).rows.find(r => r.key === 'stop')?.next?.text === 'raised');
    check('the alpha byte is claimed, not shown as a mystery write', res.unknownCount === 0);
  }

  // --- NOTHING THE TRACE WROTE MAY BE INVISIBLE ---------------------------
  {
    const res = rowsOf([{ param: '_someFutureLane', index: 4, value: 9, prev: 0 }]);
    const raw = rowFor(res, 'raw:_someFutureLane:4');
    check('a write NO builder claims still surfaces as a generic param[index] row',
      raw?.name === '_someFutureLane[4]' && raw.next.v === 9 && res.unknownCount === 1,
      JSON.stringify(raw));
  }

  // --- vectors -------------------------------------------------------------
  {
    const vecAttrs = [{ id: 'vel', name: 'vel', type: 'vector', vectorDims: 2 }];
    const res = M.buildTraceRows({
      target: cellTarget, events: [], attrs: vecAttrs, dims: dims2d,
      snapshot: { vel_vx: 1, vel_vy: 2 },
      writes: [{ param: 'w_vel_vy', index: idx, value: 5, prev: 2 }],
    });
    const row = res.rows.find(r => r.key === 'attr:vel');
    check('a vector attribute is recombined from its lowered components',
      row?.current?.v.join(',') === '1,2' && row.next.v.join(',') === '1,5' && row.changed === true,
      JSON.stringify(row));
    check('a vector component write is claimed by its vector row', res.unknownCount === 0);
  }

  // --- agents ---------------------------------------------------------------
  {
    const id = 7;
    const agentAttrs = [{ id: 'energy', name: 'energy', type: 'float' }];
    const agentRows = (writes, events = []) => M.buildTraceRows({
      target: { kind: 'agent', id }, writes, events, attrs: agentAttrs, dims: dims2d,
      snapshot: { energy: 4.2, x: 184.2, y: 96.7, vx: 0.81, vy: -0.34, radius: 1.8, age: 5 },
      bondReqSlots: 2,
    });
    const res = agentRows([
      { param: '_agentVX', index: id, value: 0.79, prev: 0.81 },
      { param: '_agentForceX', index: id, value: -0.02, prev: 0 },
      { param: '_agentForceY', index: id, value: 0.53, prev: 0.5 },
      { param: '_divideRequest', index: id, value: 1, prev: 0 },
      { param: 'w_energy', index: id, value: 3.7, prev: 4.2 },
    ]);
    const rowK = (k) => res.rows.find(r => r.key === k);
    check('velocity reads from the ABI\'s UPPER-case axis params (_agentVX)',
      rowK('velocity')?.next?.v[0] === 0.79 && rowK('velocity').changed === true,
      JSON.stringify(rowK('velocity')));
    // The accumulator is shared with the engine's own force pass, so the rule's
    // contribution is value − prev, not the absolute cell.
    const f = rowK('force');
    check('Force applied is the DELTA this rule added, not the accumulator total',
      Math.abs(f.next.v[0] - (-0.02)) < 1e-12 && Math.abs(f.next.v[1] - 0.03) < 1e-12,
      JSON.stringify(f));
    check('a divide request is shown as QUEUED, not applied',
      rowK('req:divide')?.next?.text === 'Divide' && rowK('req:divide').note === 'queued, not applied');
    check('an agent attribute still reads current -> next', rowK('attr:energy')?.next?.v === 3.7);
    check('every agent write above is claimed', res.unknownCount === 0, String(res.unknownCount));

    const q = agentRows([], [['q', '_agentCreate', [1]]]);
    check('Create Agent is a HOST call, so it arrives as a q event and still gets a row',
      q.rows.some(r => r.next?.text === 'Create Agent'));

    // Bond verbs: the queue entry for slot 0 of agent 7 is index 7*2 + 0 = 14.
    const bond = agentRows([
      { param: '_bondBreakReq', index: 14, value: -(3 + 2), prev: 0 },
      { param: '_bondFormReq', index: 14, value: 9 + 2, prev: 0 },
      { param: '_bondFormL', index: 14, value: 0, prev: 0 },
      { param: '_bondFormK', index: 14, value: 0, prev: 0 },
    ]);
    check('a Form Between entry decodes into "Form bond #3 <-> #9"',
      bond.rows.some(r => r.next?.text === 'Form bond #3 ↔ #9'),
      JSON.stringify(bond.rows.filter(r => r.name === 'Request')));
    check('the form-half parameter cells are claimed by the request row',
      bond.unknownCount === 0, String(bond.unknownCount));
  }

  // --- the bond-lane truth table (the mirror of bondRequestEmitJS) ---------
  {
    const B = 2, NONE = 1;
    const cases = [
      ['form', [NONE, 5 + B], 'form', 5],
      ['break', [5 + B, NONE], 'break', 5],
      ['rewire', [3 + B, 9 + B], 'rewire', 3],
      ['form between', [-(3 + B), 9 + B], 'formBetween', 3],
      ['break between', [-(3 + B), -(9 + B)], 'breakBetween', 3],
      ['transfer', [3 + B, -(9 + B)], 'transfer', 3],
    ];
    for (const [name, [b, f], verb, a] of cases) {
      const r = M.decodeBondRequest(b, f);
      check(`bond lanes (${b}, ${f}) decode as ${name}`, r?.verb === verb && r.a === a, JSON.stringify(r));
    }
    check('an entry that was never appended decodes as nothing',
      M.decodeBondRequest(0, 0) === null);
    check('an unresolvable endpoint is NAMED, never printed as #-1',
      M.bondRequestText({ verb: 'form', a: -1, b: -1 }) === 'Form bond → unresolved');
  }

  // --- labels ---------------------------------------------------------------
  {
    const names = {
      mapping: id => (id === 'm1' ? 'Heat' : undefined),
      agentMapping: id => (id === 'a1' ? 'Species' : undefined),
      periodicNode: id => (id === 'n9' ? 'Rain' : undefined),
    };
    const L = (k) => M.traceRootLabel(k, names);
    check('the root vocabulary names every shipped root',
      L('step') === 'Step' && L('init') === 'Init' && L('gridInit') === 'Grid Init'
      && L('agentBehaviour') === 'Behaviour' && L('agentInit') === 'Agent Init'
      && L('agentDivision') === 'Division'
      && L('outputMapping:m1') === 'Output Mapping (Heat)'
      && L('inputColor:m1') === 'Brush (Heat)'
      && L('agentOutputMapping:a1') === 'Agent View (Species)'
      && L('agentInputMapping:a1') === 'Agent Brush (Species)'
      && L('gridPeriodic:n9') === 'Periodic (Rain)',
      [L('step'), L('outputMapping:m1'), L('gridPeriodic:n9')].join(' | '));
    check('a mapping whose name cannot be resolved still reads as its KIND',
      L('outputMapping:gone') === 'Output Mapping');
    check('a RESET-time root shows "Reset", not "gen 0"',
      M.traceChipLabel('init', 0, names) === 'Reset · Init'
      && M.isResetRoot('gridInit') && M.isResetRoot('agentInit') && !M.isResetRoot('step'));
    check('a generation root shows its generation',
      M.traceChipLabel('step', 412, names) === 'gen 412 · Step');
    // P7b / F11 — the 3D form NAMES the layer axis ("(layer 2, 1, 3)"), because a
    // bare triple gives the reader no way to tell which number is the layer, and
    // the Live chip and this header had drifted into disagreeing about it. ONE
    // formatter (`formatCellCoords`) now serves both surfaces.
    check('the element label carries the NAMED layer in 3D and omits it in 2D',
      M.traceTargetLabel({ kind: 'cell', idx: 55 }, dims2d) === 'Cell (5, 5)'
      && M.traceTargetLabel({ kind: 'cell', idx: 2 * 16 + 1 * 4 + 3 }, dims3d) === 'Cell (layer 2, 1, 3)'
      && M.traceTargetLabel({ kind: 'agent', id: 1487 }, dims2d) === 'Agent #1487');
    check('the Live chip and the panel header share ONE coordinate formatter',
      M.formatCellCoords(55, dims2d) === '(5, 5)'
      && M.formatCellCoords(2 * 16 + 1 * 4 + 3, dims3d) === '(layer 2, 1, 3)'
      && M.traceTargetLabel({ kind: 'cell', idx: 55 }, dims2d) === `Cell ${M.formatCellCoords(55, dims2d)}`);
    check('numbers print compactly (an integer bare, a decimal trimmed)',
      M.formatNumber(3) === '3' && M.formatNumber(4.25) === '4.25'
      && M.formatNumber(1 / 3) === '0.3333');
    check('an offset prints with the layer axis only in 3D',
      M.formatOffset({ dr: -1, dc: 0, dl: 0 }, false) === '(-1, 0)'
      && M.formatOffset({ dr: -1, dc: 0, dl: 2 }, true) === '(-1, 0, 2)');
    check('a flat index decodes to (layer, row, col) the way the engine does',
      JSON.stringify(M.cellCoords(2 * 16 + 1 * 4 + 3, dims3d)) === JSON.stringify({ l: 2, r: 1, c: 3 }),
      JSON.stringify(M.cellCoords(2 * 16 + 1 * 4 + 3, dims3d)));
    check('shortestDelta is the identity on an axis that cannot wrap',
      M.shortestDelta(0, 3, 1) === 3 && M.shortestDelta(1, 2, 10) === 1);
  }

  // --- the approximate caveat ---------------------------------------------
  {
    const R = (o) => M.approximateReason({
      asyncCells: false, agentsAsync: false, agentsWriteField: false,
      usesRng: false, webgpu: false, kind: 'cells', ...o,
    });
    check('asynchronous cells is named first, because it changes the answer most',
      R({ asyncCells: true, usesRng: true }) === 'approximate under asynchronous updates');
    check('an agent trace names the agent update mode, not the cell one',
      R({ kind: 'agents', agentsAsync: true, asyncCells: true })
        === 'approximate — agent attributes update asynchronously');
    check('a cell rule under running agents names the FIELD deposit',
      R({ agentsWriteField: true }) === 'approximate — agents deposit into the field after this trace',
      R({ agentsWriteField: true }));
    check('the field term is a CELL-side reason only',
      R({ kind: 'agents', agentsWriteField: true, usesRng: true })
        === 'approximate — the rule draws random numbers');
    check('a reason the panel cannot name still points at the badge',
      /badge/.test(R({})), R({}));
  }

  // NEGATIVE CONTROL: a neighbour offset computed as a plain difference — the
  // naive reading — puts a torus-edge write nine rows away instead of one.
  expectFail('a neighbour offset that does not take the short way round a wrap', () => {
    const naive = (from, to, d) => ({ dr: Math.floor(to / d.W) - Math.floor(from / d.W), dc: 0, dl: 0 });
    const o = naive(5, 95, dims2d);
    check('a wrapped neighbour write reads as the SHORT offset, not the long way round',
      o.dr === -1 && o.dc === 0, JSON.stringify(o));
  });

  // NEGATIVE CONTROL: a decoder that reads only the MAGNITUDES of the two lanes
  // — a Form Between (negative break lane) then reads as a Rewire, i.e. the
  // panel would tell the user their rule broke a bond it never touched.
  expectFail('a bond decoder that ignores the lane SIGNS', () => {
    const signless = (b, f) => ({ verb: (Math.abs(b) === 1 ? 'form' : 'rewire'), a: Math.abs(b) - 2 });
    const r = signless(-(3 + 2), 9 + 2);
    check('bond lanes (-5, 11) decode as form between', r.verb === 'formBetween', JSON.stringify(r));
  });

  // NEGATIVE CONTROL: a row builder that emits only the writes it RECOGNISES —
  // the failure mode the `claimed` set exists to prevent, where the panel
  // quietly omits something the rule did.
  expectFail('a values table that drops the writes it does not recognise', () => {
    const dropped = { rows: [], unknownCount: 0 };
    const raw = dropped.rows.find(r => r.key === 'raw:_someFutureLane:4');
    check('a write NO builder claims still surfaces as a generic param[index] row',
      raw?.name === '_someFutureLane[4]', 'the write vanished from the table');
  });
}


// ===========================================================================
section('K. P7b — the review findings: the write-side name, the root record, the sandbox');
// ===========================================================================
//
// Three of the adversarial review's findings were failures of the SHIPPED
// modules that every existing section walked straight past, so each one gets a
// check that drives the real code and a negative control that re-injects the
// fault.
{
  // --- F1. AN ALIASED BUFFER REPORTS ITS WRITES UNDER THE WRITE-SIDE NAME ---
  //
  // Section B returns early on every non-synchronous model (the real step it
  // compares against needs a double buffer), which is exactly why this went
  // unseen: under `updateMode: 'asynchronous'` the engine passes ONE array as
  // both `r_<id>` and `w_<id>`, the sandbox gives it ONE shadow, and its `param`
  // used to be the FIRST name that reached it — always the read name, because
  // every ABI lists the `r_` block first. The Values tab keys NEXT by `w_<id>`,
  // so the row said "unchanged" while the real write fell out as a generic
  // unknown row. Driven here through the REAL compiled trace fn with the
  // worker's own aliasing.
  const asyncCase = (file, gridCap) => {
    const model = shipped(file);
    check(`${file}: is an asynchronous model`,
      model.properties.updateMode === 'asynchronous', model.properties.updateMode);
    const W = clamp(model.properties.gridWidth, gridCap);
    const H = clamp(model.properties.gridHeight, gridCap);
    const st = buildCellBufs(model, W, H, 1);
    // THE WORKER'S RULE: `writeAttrs = (isAsync || attrWriteAliased) ? attrsA : attrsB`.
    for (const a of st.cellAttrs) { st.attrs[a.id].w = st.attrs[a.id].r; st.bufs['w_' + a.id] = st.bufs['r_' + a.id]; }
    st.bufs.w_orientation = st.bufs.r_orientation;
    seedCells(model, st);

    const tr = M.compileGraph(model.graphNodes, model.graphEdges, model, { trace: true });
    if (tr.error || !tr.stepCode) { check(`${file}: trace build compiles`, false, tr.error ?? 'no step'); return; }
    const params = tr.trace.paramNames.step;
    const fn = (0, eval)(tr.stepCode);
    const args = argsFor(params, st.bufs, `${file}/async trace`);

    // Find a cell whose rule actually writes something — an all-quiet cell would
    // make every assertion below vacuously true.
    let hit = null;
    for (let idx = 0; idx < st.total && hit === null; idx++) {
      const r = M.runTrace({ fn, args, paramNames: params, elementIdx: idx, generation: 7 });
      if (r.error) { check(`${file}: the async trace runs`, false, r.error); return; }
      if (r.writes.some(w => w.index === idx && w.param.startsWith('w_'))) hit = { idx, r };
    }
    check(`${file}: some cell's rule writes its OWN cell`, hit !== null,
      'no own-cell write found anywhere on the grid');
    if (!hit) return;

    const readNamed = hit.r.writes.filter(w => /^r_/.test(w.param));
    check(`${file}: NO write is filed under a read-side (r_) name`,
      readNamed.length === 0, readNamed.map(w => w.param).join(', '));

    const attrs = model.attributes.filter(a => !a.isModelAttribute)
      .map(a => ({ id: a.id, name: a.name, type: a.type, ...(a.vectorDims ? { vectorDims: a.vectorDims } : {}) }));
    const snapshot = {};
    for (const a of attrs) snapshot[a.id] = st.bufs['r_' + a.id][hit.idx];
    const rowsInput = {
      target: { kind: 'cell', idx: hit.idx }, dims: { W, H, D: 1 },
      attrs, writes: hit.r.writes, events: hit.r.events, snapshot,
      indicatorNames: (model.indicators || []).map(i => i.name),
    };
    const built = M.buildTraceRows(rowsInput);
    check(`${file}: every write is CLAIMED by a row (unknownCount 0)`,
      built.unknownCount === 0,
      built.rows.filter(r => r.key.startsWith('raw:')).map(r => r.name).join(', '));
    const changedAttrRows = built.rows.filter(r => r.key.startsWith('attr:') && r.changed);
    check(`${file}: the rule's own-cell write shows as a CHANGED attribute row`,
      changedAttrRows.length > 0,
      built.rows.filter(r => r.key.startsWith('attr:')).map(r => `${r.name}=${r.changed}`).join(' '));

    // NEGATIVE CONTROL — re-file the same writes under the READ-side name, i.e.
    // exactly what the runner did before P7b, and watch the table go blind.
    expectFail(`${file}: an aliased write filed under its READ name`, () => {
      const mis = hit.r.writes.map(w => ({ ...w, param: w.param.replace(/^w_/, 'r_') }));
      const blind = M.buildTraceRows({ ...rowsInput, writes: mis });
      check('every write is CLAIMED by a row (unknownCount 0)', blind.unknownCount === 0);
      check('the own-cell write shows as a CHANGED attribute row',
        blind.rows.some(r => r.key.startsWith('attr:') && r.changed));
    });
  };
  asyncCase('snake.gcaproj', 16);
  asyncCase('Amphiphile.gcaproj', 16);

  // --- F2. THE ROOT NODE RECORDS THAT IT RAN ------------------------------
  //
  // The root's body IS the emitted wrapper, so nothing in the log named it: a
  // breakpoint on a Generation Step node could never fire, while still forcing
  // the every-generation cadence (and, on WebGPU, its readback). The root is now
  // flow event 0 of every trace.
  const rootCase = (file, gridCap) => {
    const model = shipped(file);
    const stepNode = model.graphNodes.find(n => n.data.nodeType === 'step');
    if (!stepNode) { check(`${file}: has a Generation Step root`, false); return null; }
    const W = clamp(model.properties.gridWidth, gridCap);
    const H = clamp(model.properties.gridHeight, gridCap);
    const D = M.is3dModel(model) ? clamp(model.properties.gridDepth, 6) : 1;
    const st = buildCellBufs(model, W, H, D);
    if (model.properties.updateMode === 'asynchronous') {
      for (const a of st.cellAttrs) { st.attrs[a.id].w = st.attrs[a.id].r; st.bufs['w_' + a.id] = st.bufs['r_' + a.id]; }
      st.bufs.w_orientation = st.bufs.r_orientation;
    }
    seedCells(model, st);
    const tr = M.compileGraph(model.graphNodes, model.graphEdges, model, { trace: true });
    if (tr.error || !tr.stepCode) { check(`${file}: trace build compiles`, false, tr.error ?? 'no step'); return null; }
    const params = tr.trace.paramNames.step;
    const fn = (0, eval)(tr.stepCode);
    const args = argsFor(params, st.bufs, `${file}/root record`);
    const r = M.runTrace({ fn, args, paramNames: params, elementIdx: Math.floor(st.total / 2), generation: 3 });
    check(`${file}: the root trace runs`, r.error === undefined, r.error);
    const flows = r.events.filter(e => e[0] === 'f');
    check(`${file}: the ROOT is flow event 0 (so a breakpoint on it can fire)`,
      flows.length > 0 && flows[0][1] === stepNode.id,
      `${flows.length} flow events, first = ${flows[0] ? flows[0][1] : 'none'}`);
    check(`${file}: the root records itself exactly ONCE (no double count)`,
      flows.filter(e => e[1] === stepNode.id).length === 1,
      String(flows.filter(e => e[1] === stepNode.id).length));
    // …and it names the flow port it opened, so P4 can light the wire leaving it.
    const firstF = r.events.findIndex(e => e[0] === 'f');
    const nextO = r.events.slice(firstF).find(e => e[0] === 'o');
    check(`${file}: the root names the DO port it took`,
      !!nextO && nextO[1] === stepNode.id && nextO[2] === 'do',
      JSON.stringify(nextO));
    return { r, stepNode };
  };
  const golRoot = rootCase('Game Of Life.gcaproj', 16);
  rootCase('Life3D.gcaproj', 8);            // 3D — the dual-impact rule
  rootCase('Extended Wireworld.gcaproj', 16);
  rootCase('snake.gcaproj', 16);            // asynchronous
  rootCase('Kelp War.gcaproj', 16);         // macro-heavy

  // NEGATIVE CONTROL — drop the root's own record (the pre-P7b compiler) and the
  // "flow event 0 is the root" claim must collapse.
  if (golRoot) {
    expectFail('a trace build that records no `f` for its own root', () => {
      const stripped = golRoot.r.events.filter(e => !(e[0] === 'f' && e[1] === golRoot.stepNode.id));
      const flows = stripped.filter(e => e[0] === 'f');
      check('the ROOT is flow event 0 (so a breakpoint on it can fire)',
        flows.length > 0 && flows[0][1] === golRoot.stepNode.id);
    });
  }

  // --- F4. THE SANDBOX DENIES METHODS BY DEFAULT ---------------------------
  //
  // The `get` trap used to fall through to `Reflect.get(...).bind(target)`, so
  // every method ran against the REAL array: `.push` / `.splice` / `.pop` /
  // `.unshift` wrote straight through invariant I2, and a read-only method would
  // have read AROUND this trace's shadow.
  const escapes = (label, body, base) => {
    const before = JSON.stringify(Array.from(base));
    let name = '';
    try {
      M.runTrace({ fn: (w, _tr) => body(w), args: [base], paramNames: ['w_x', '_tr'], elementIdx: 0, generation: 1 });
    } catch (e) { name = (e && e.name) || ''; }
    check(`the sandbox refuses ${label} and the base array is untouched`,
      name === 'TraceSandboxEscape' && JSON.stringify(Array.from(base)) === before,
      `threw ${name || 'NOTHING'}, base ${before} -> ${JSON.stringify(Array.from(base))}`);
  };
  escapes('.push()', (w) => w.push(99), [1, 2, 3, 4]);
  escapes('.splice()', (w) => w.splice(0, 1, 42), [1, 2, 3, 4]);
  escapes('.pop()', (w) => w.pop(), [1, 2, 3, 4]);
  escapes('.unshift()', (w) => w.unshift(7), [1, 2, 3, 4]);
  escapes('.indexOf() (a READ-ONLY method would read around the shadow)', (w) => w.indexOf(2), [1, 2, 3, 4]);
  escapes('.subarray()', (w) => w.subarray(0, 1), new Float64Array([1, 2, 3]));
  escapes('.slice()', (w) => w.slice(0, 1), new Float64Array([1, 2, 3]));

  // …while the BULK WRITERS stay deliberate no-ops (dropping the whole-grid copy
  // is the trace build's own design, not an escape).
  for (const [label, body] of [['set', (w) => w.set([9, 9, 9])], ['fill', (w) => w.fill(7)]]) {
    const base = new Float64Array([1, 2, 3]);
    const out = M.runTrace({ fn: (w, _tr) => body(w), args: [base], paramNames: ['w_x', '_tr'], elementIdx: 0, generation: 1 });
    check(`a bulk .${label}() is a silent no-op, not an escape`,
      out.error === undefined && Array.from(base).join(',') === '1,2,3',
      `err=${out.error ?? '-'} base=${Array.from(base).join(',')}`);
  }

  // …and an indexed write still lands in the SHADOW and is reported.
  {
    const base = new Float64Array([1, 2, 3]);
    const out = M.runTrace({
      fn: (w, _tr) => { w[1] = 8; _tr.v('n', 'value', w[1]); },
      args: [base], paramNames: ['w_x', '_tr'], elementIdx: 0, generation: 1,
    });
    check('an indexed write is shadowed, reported, and read back as the NEW value',
      base[1] === 2 && out.writes.length === 1 && out.writes[0].param === 'w_x'
      && out.writes[0].value === 8 && out.writes[0].prev === 2
      && out.events.some(e => e[0] === 'v' && e[3] === 8),
      JSON.stringify(out.writes));
  }

  // NEGATIVE CONTROL — the ALLOW-by-default trap this replaced.
  expectFail('a shadow proxy that binds unknown methods to the base array', () => {
    const base = [1, 2, 3, 4];
    const before = JSON.stringify(base);
    const leaky = new Proxy(base, {
      get(t, p) { const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v; },
    });
    let name = '';
    try { leaky.push(99); } catch (e) { name = (e && e.name) || ''; }
    check('the sandbox refuses .push() and the base array is untouched',
      name === 'TraceSandboxEscape' && JSON.stringify(base) === before);
  });
}

// ===========================================================================
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0
  ? '\nRULE TRACE (P1+P3+P4+P5+P7b) ✓  (all checks passed)'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
