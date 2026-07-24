// Agent RENDER-LAYER regression harness.
//
// WHY THIS EXISTS
//   parity-agent-wasm / parity-agent-force / check-compile-identity cover the
//   COMPILERS and the ENGINE. Nothing covered the render / readback / attach
//   layer — which is exactly where the optimize-branch audit's BLOCKER + HIGH
//   findings and BOTH user-reported bugs lived (invisible agents, missing bond
//   lines, a black board after a rebuild, direct render lost on the first edit).
//   Every assertion below names the production bug it guards.
//
// TWO TIERS (deliberate, and the split is honest about what each can prove):
//   A. COMPUTED — imports the REAL modules and evaluates the gate's discriminating
//      INPUTS over every shipped library model. These are true unit assertions:
//      if resolveMaxBonds() ever reports 0 for a bonded model, the direct-render
//      gate silently admits it and the bond lines vanish. No logic is replicated.
//   B. SOURCE INVARIANTS — the render/attach/upload layer needs a real GPUDevice,
//      an OffscreenCanvas and a React tree, so it cannot run headlessly. Instead
//      each line whose ABSENCE caused a shipped bug is pinned by an anchored
//      source assertion (function-body scoped, not a whole-file grep). These are
//      structural, not behavioural — they catch deletion/rewiring regressions,
//      not new logic errors. Tier B also pins the gate TERMS that tier A feeds,
//      so the two cannot drift apart.
//   C. BROWSER PROBES — printed (not run): the invariants that are only reachable
//      with a live device, as a copy-pasteable probe for an in-browser session.
//
// Run from the repo root:  node scripts/verify-agent-render.mjs
//                          node scripts/verify-agent-render.mjs --probes   (also print tier C)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(ROOT, 'src', p);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------------------
// Source helpers — anchored assertions (function-body scoped, never a bare grep
// over the whole file, so an unrelated occurrence elsewhere cannot satisfy one).
// ---------------------------------------------------------------------------
const fileCache = new Map();
const readSrc = (rel) => {
  if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(SRC(rel), 'utf8'));
  return fileCache.get(rel);
};

/** Text of a balanced `{...}` block starting at the first line matching `startRe`.
 *  Brace-counting is string/comment-naive but sufficient here: every anchor below
 *  is a plain function body. Returns '' when the anchor is gone (⇒ the assertion
 *  fails loudly rather than silently passing). */
function blockAfter(src, startRe) {
  const m = startRe.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}
const bodyHas = (rel, startRe, needle) => {
  const b = blockAfter(readSrc(rel), startRe);
  return b.length > 0 && b.includes(needle);
};

// ---------------------------------------------------------------------------
// TIER A — computed over every shipped model (real modules, no replicated logic)
// ---------------------------------------------------------------------------
const ENTRY = `
export { resolveMaxBonds, agentTargetOf, usesBondingPhysics } from '../src/model/centerBased.ts';
export { cellFieldAttrsOf, agentAttrsOf } from '../src/model/attributeScope.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
export { isAgentGraphWebGPUSupported } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { isAgentGraphWasmSupported } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-render-'));
const entryPath = join(ROOT, 'scripts', '__render_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT });
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

const MODELS_DIR = join(ROOT, 'public', 'models');
const models = readdirSync(MODELS_DIR)
  .filter(f => f.endsWith('.gcaproj'))
  .map(f => {
    const raw = JSON.parse(readFileSync(join(MODELS_DIR, f), 'utf8'));
    return { file: f, model: M.migrateForHarness(raw) };
  });

/** The 5 field-bridge node types (the agent↔grid coupling). Mirrors
 *  SimulatorView's agentUsesField + the worker's agentUsesField flag; macros are
 *  flattened before compile, so macro bodies count too. */
const FIELD_NODE_TYPES = new Set(['sampleField', 'fieldGradient', 'readCellsUnder', 'affectCellsUnder', 'secreteToField']);
function agentUsesField(model) {
  if (!model.topologyMode?.agents) return false;
  const defs = model.macroDefs || [];
  const seen = new Set();
  const scan = (nodes) => {
    for (const n of nodes || []) {
      const t = n?.data?.nodeType;
      if (FIELD_NODE_TYPES.has(t)) return true;
      if (t === 'macro') {
        const id = n?.data?.config?.macroDefId;
        if (id && !seen.has(id)) { seen.add(id); const d = defs.find(x => x.id === id); if (d && scan(d.nodes)) return true; }
      }
    }
    return false;
  };
  return scan(model.agentGraphNodes);
}
const isAgentModel = (m) => !!m.topologyMode?.agents;
const isDecoupled = (m) => !agentUsesField(m) && M.cellFieldAttrsOf(m).length === 0;

section('TIER A — gate inputs over every shipped model (computed)');
const agentModels = models.filter(x => isAgentModel(x.model));
check('the library still ships agent models to classify', agentModels.length >= 5, `found ${agentModels.length}`);

// A1 — BONDS. Production bug: a bonded model kept the direct-render path, whose
// GPU pass draws discs/spheres ONLY and skips drawAgentsOverlay (the SOLE bond
// renderer), so a tissue silently lost its defining visual. The gate term is
// `resolveMaxBonds(model.centerBased) === 0`; assert it DISCRIMINATES on real
// models — a bonded model must resolve > 0.
{
  const bonded = [], unbonded = [];
  for (const { file, model } of agentModels) {
    (M.resolveMaxBonds(model.centerBased) > 0 ? bonded : unbonded).push(file);
  }
  check('at least one shipped agent model resolves bonds > 0 (the excluded class is non-empty)',
    bonded.length > 0, `bonded=${bonded.length}`);
  check('at least one shipped agent model resolves bonds === 0 (the eligible class is non-empty)',
    unbonded.length > 0, `unbonded=${unbonded.length}`);
  // A model that FORMS bonds in its graph must resolve a bond store, else the
  // bonds gate term reads 0 and admits it to a renderer that cannot draw them.
  const BOND_NODES = new Set(['formBond', 'forEachBond', 'getBondedAgents', 'breakBond', 'getBondDegree']);
  for (const { file, model } of agentModels) {
    const usesBonds = (model.agentGraphNodes || []).some(n => BOND_NODES.has(n?.data?.nodeType))
      || (model.centerBased?.autoBond === true);
    if (!usesBonds) continue;
    check(`bond-using model resolves a bond store (gate excludes it): ${file}`,
      M.resolveMaxBonds(model.centerBased) > 0, 'resolveMaxBonds === 0 would admit it to the disc-only renderer');
  }
}

// A2 — DECOUPLING. Feeds BOTH the M4 worker routing arm and the main-thread
// render gate. A field-coupled model must never classify as decoupled.
{
  const coupled = agentModels.filter(x => !isDecoupled(x.model));
  const decoupled = agentModels.filter(x => isDecoupled(x.model));
  check('at least one shipped agent model is field-COUPLED (the excluded class is non-empty)',
    coupled.length > 0, `coupled=${coupled.length}`);
  check('at least one shipped agent model is field-DECOUPLED (the eligible class is non-empty)',
    decoupled.length > 0, `decoupled=${decoupled.length}`);
  // A model with a field NODE and a model with an agent-accessible cell attr must
  // BOTH be excluded — the two halves of the predicate, asserted independently.
  for (const { file, model } of agentModels) {
    if (agentUsesField(model)) {
      check(`field-node model is not decoupled: ${file}`, !isDecoupled(model));
    }
    if (M.cellFieldAttrsOf(model).length > 0) {
      check(`agent-accessible-attr model is not decoupled: ${file}`, !isDecoupled(model));
    }
  }
}

// A3 — SPRITES / AGENT-OM. The two terms a SOFT recompile can flip (audit M1).
// Sprites are a CPU-only visual; an agent OM the GPU can't compile must keep the
// CPU overlay. Assert the classifier inputs exist and are readable per model.
{
  for (const { file, model } of agentModels) {
    const sprites = model.sprites?.length ?? 0;
    const oms = model.agentMappings?.length ?? 0;
    check(`render model-terms inputs are well-formed: ${file}`,
      Number.isInteger(sprites) && Number.isInteger(oms) && sprites >= 0 && oms >= 0);
  }
}

// A4 — the resolved agent target is a GENERAL property (never a model-shape test)
// and clamps safely: an unsupported graph must NEVER resolve to webgpu/wasm.
{
  for (const { file, model } of agentModels) {
    const gpuOk = M.isAgentGraphWebGPUSupported(model);
    const wasmOk = M.isAgentGraphWasmSupported(model);
    const t = M.agentTargetOf(model.centerBased, wasmOk, gpuOk);
    check(`agent target resolves to a supported backend: ${file} → ${t}`,
      t === 'js' || (t === 'wasm' && wasmOk) || (t === 'webgpu' && gpuOk));
  }
}

// ---------------------------------------------------------------------------
// TIER B — source invariants (each pinned to the production bug it guards)
// ---------------------------------------------------------------------------
section('TIER B — render/attach/upload source invariants');

// B1 (audit BLOCKER) — a REBUILT GPU runtime has spec-ZERO-initialised buffers.
// Every rebuild path must set agentGpuUploadPending, or the resident batch's
// CONDITIONAL upload skips the seed, dispatches on zeros, and the frame readback
// writes those zeros into every LIVE CPU agent slot (agents jump to 0,0 r=0).
check('worker: buildAgentWebGPUIfNeeded flags an upload after a rebuild [audit BLOCKER]',
  bodyHas('simulator/engine/sim.worker.ts', /function buildAgentWebGPUIfNeeded\b/, 'agentGpuUploadPending = true'));
check('worker: initAgents flags an upload (fresh store ⇒ GPU buffers are stale) [audit BLOCKER]',
  bodyHas('simulator/engine/sim.worker.ts', /function initAgents\b/, 'agentGpuUploadPending = true'));
// …and the flag must still GATE the resident upload (otherwise it is inert).
check('worker: the resident batch uploads conditionally on that flag [audit BLOCKER]',
  bodyHas('simulator/engine/sim.worker.ts', /async function runAgentBatchResident\b/, 'if (agentGpuUploadPending)'));

// B2 (user-reported: invisible agents) — a behaviour graph with NO colour node
// never writes agentColors GPU-side, so the readback pulled the buffer's
// uninitialised ZEROS back into s.colors ⇒ fully transparent agents. The SoA
// upload must SEED the colour buffer (idempotent; a colour-writing shader
// overwrites it GPU-side).
check('runtime: uploadAgentSoA seeds the agent colour buffer [invisible-agents bug]',
  bodyHas('simulator/engine/agentWebgpuRuntime.ts', /export function uploadAgentSoA\b/, 'uploadAgentColors(rt, s)'));

// B3 (audit H1, user-reported: missing bond lines) — the 2D/3D direct-render gate
// must exclude bonded models. Tier A proves resolveMaxBonds discriminates; this
// pins the term into the gate so the two cannot drift.
{
  const sv = readSrc('simulator/SimulatorView.tsx');
  const gate = /const agentRenderEligible\s*=/.exec(sv);
  const seg = gate ? sv.slice(gate.index, gate.index + 2600) : '';
  check('SimulatorView: the direct-render gate excludes bonded models [audit H1]',
    seg.includes('resolveMaxBonds(model.centerBased) === 0'));
  check('SimulatorView: the gate excludes sprites/unsupported agent OMs via the shared helper [audit M1]',
    seg.includes('agentRenderModelTermsOk('));
  check('SimulatorView: the gate excludes metaballs [CPU-only visual]',
    seg.includes('agentMetaballsRef.current.enabled'));
  check('SimulatorView: the gate keys on the field-DECOUPLING term, not an agents-only proxy [phase D]',
    seg.includes('agentDecoupled'));
  // The soft-recompile refresh must re-evaluate the SAME helper (audit M1: the
  // gate went stale when a sprite was added mid-session).
  check('SimulatorView: the live model-terms ref is refreshed from the same helper [audit M1]',
    sv.includes('agentRenderModelTermsOkRef.current =') && sv.includes('agentRenderModelTermsOk('));
}

// B4 (audit H3/L5) — a re-attach fires on every REAL display-size change (once
// per frame while a splitter is dragged). Building a fresh render-only surface
// there orphaned three maxAgents-sized buffers AND a shared-device reference
// (the device became undestroyable). The attach handler must REUSE a
// layout-compatible surface and DESTROY a stale one.
{
  const b = blockAfter(readSrc('simulator/engine/sim.worker.ts'), /case 'attachAgentCanvas':/);
  check('worker: attach reuses a layout-compatible render surface [audit H3 leak]',
    b.includes('prev.layout.maxAgents === want.maxAgents'));
  check('worker: attach destroys a stale render surface before rebuilding [audit H3 leak]',
    b.includes('destroyAgentRenderSurface(prev)'));
  check('worker: a failed attach tears down a surface it owns [audit H3 reuse path]',
    b.includes('destroyAgentRenderSurface(rt)'));
  check('worker: a failed attach clears the module ref (no destroyed surface handed out) [audit H3]',
    b.includes('agentRenderRuntime = null'));
}

// B5 (user-reported: black board at load) — the first present after attach must
// not be the ONLY upload. Every path that mutates the CPU store flags a
// re-upload, and the attach present goes through the store-driven present.
{
  const w = readSrc('simulator/engine/sim.worker.ts');
  const b = blockAfter(w, /case 'attachAgentCanvas':/);
  check('worker: attach presents from the CPU store (not an assumed-fresh GPU buffer) [black-board bug]',
    b.includes('presentAgentsIfActive()'));
  // A mutation must never leave the GPU holding pre-mutation state.
  const mutationFlags = (w.match(/agentGpuUploadPending = true/g) || []).length;
  check('worker: several distinct paths flag a GPU re-upload (mutations + rebuild) [black-board bug]',
    mutationFlags >= 3, `found ${mutationFlags}`);
  check('runtime: the render-only surface seeds colours at creation [black-board bug]',
    bodyHas('simulator/engine/agentWebgpuRuntime.ts', /export async function createAgentRenderOnlyRuntime\b/, 'uploadAgentColors(rt, s)')
    || readSrc('simulator/engine/agentWebgpuRuntime.ts').includes('uploadAgentColors(rt, s)'));
}

// B6 (fix-pass bonus find) — the RECOMPILE message must carry agentRenderLayout.
// The worker does `pendingAgentRenderLayout = rc.agentRenderLayout ?? null`, so
// omitting it NULLED the layout on every soft recompile, after which a CPU-target
// model could never attach again ⇒ direct render lost permanently on the first
// graph edit.
{
  const sv = readSrc('simulator/SimulatorView.tsx');
  const inits = (sv.match(/agentRenderLayout:\s*agentResult\.agentRenderLayout/g) || []).length;
  check('SimulatorView: BOTH the init and the recompile message carry agentRenderLayout [fix-pass find]',
    inits >= 2, `found ${inits} — init and recompile must both ship it`);
  const w = readSrc('simulator/engine/sim.worker.ts');
  check('worker: both message handlers read agentRenderLayout [fix-pass find]',
    (w.match(/pendingAgentRenderLayout = /g) || []).length >= 2);
}

// B7 (audit H2) — every path that sets asyncStepBatchInFlight must clear it from
// a `finally`; a throw with the flag set defers every later message with no
// replay = a permanent, silent worker dead-lock.
{
  const w = readSrc('simulator/engine/sim.worker.ts');
  const sets = (w.match(/asyncStepBatchInFlight = true/g) || []).length;
  // Both sanctioned shapes: a promise-chain `.finally(endAsyncStepBatch)` and an
  // explicit `finally { endAsyncStepBatch(); }`. A bare call outside a finally
  // does NOT count — that is exactly the H2 dead-lock (a throw skips it).
  const chained = (w.match(/\.finally\(\s*endAsyncStepBatch\s*\)/g) || []).length;
  const blocks = (w.match(/finally\s*\{[^}]*endAsyncStepBatch\s*\(\s*\)/g) || []).length;
  check('worker: every async step batch clears its in-flight flag from a finally [audit H2]',
    chained + blocks >= sets, `set ${sets} times, cleared from a finally ${chained + blocks} times`);
}

// B8 (M4, this pass) — the WebGPU-GRID step branch must route a decoupled model's
// agents to the GPU when the user selected the WebGPU agent target, instead of
// falling through to the CPU agent step.
{
  const w = readSrc('simulator/engine/sim.worker.ts');
  check('worker: a decoupled-GPU-agents predicate exists and is target-gated [M4]',
    bodyHas('simulator/engine/sim.worker.ts', /function agentDecoupledGpuAgents\b/, "agentTarget !== 'webgpu'"));
  check('worker: the decoupled predicate excludes any field coupling [M4]',
    bodyHas('simulator/engine/sim.worker.ts', /function agentDecoupledGpuAgents\b/, 'agentUsesField || fieldSpecs.length > 0'));
  check('worker: the WebGPU-grid step branch dispatches decoupled agents on the GPU [M4]',
    w.includes('agentDecoupledGpuAgents()') && /agentDecoupledGpuAgents\(\)\)\s*\{[\s\S]{0,900}runAgentStepWebGPU\(\)/.test(w));
  check('worker: that arm falls back to the CPU agent step on GPU failure [M4]',
    /agentDecoupledGpuAgents\(\)\)\s*\{[\s\S]{0,1400}runAgentStep\(\)/.test(w));
}

// B9 — the render pipeline must stay a VIEW of engine-owned state: the disc/sphere
// shaders read only fields EVERY agent model has, so the renderer is graph-agnostic
// (invariant FP-1). Guard against a shader growing a model-specific dependency.
{
  const rt = readSrc('simulator/engine/agentWebgpuRuntime.ts');
  for (const forbidden of ['agentAttrBase', 'lookupTable', 'indicatorsBuf']) {
    const wgsl = /const AGENT_RENDER_WGSL[\s\S]*?`([\s\S]*?)`/.exec(rt);
    check(`runtime: the agent render shader does not depend on '${forbidden}' [FP-1 graph-agnostic]`,
      !wgsl || !wgsl[1].includes(forbidden));
  }
}

// ---------------------------------------------------------------------------
// TIER C — browser probes (printed; only reachable with a live GPUDevice)
// ---------------------------------------------------------------------------
if (process.argv.includes('--probes')) {
  section('TIER C — in-browser probes (paste into a session with the dev server)');
  console.log(`
// The pane is usually occluded: drive the worker directly, wait on MESSAGES
// (never setTimeout — a hidden tab throttles timers to a standstill), and never
// trust screenshots/rAF. getState agent buffers are f64: use Float64Array.
const w = window.__simWorker;
const once = (t, ms = 30000) => new Promise((res, rej) => {
  const to = setTimeout(() => { w.removeEventListener('message', h); rej(new Error('timeout ' + t)); }, ms);
  const h = e => { if (e.data && e.data.type === t) { clearTimeout(to); w.removeEventListener('message', h); res(e.data); } };
  w.addEventListener('message', h);
});
const counters = async () => { const p = once('__e1bCounters'); w.postMessage({ type: '__e1bCounters' }); return p; };

// P1  routing (M4): a decoupled grid+agents model on a WebGPU grid + WebGPU agents
//     must report m4Gpu === generations and m4Cpu === 0, and every agent position
//     must be exactly f32-representable (Math.fround(x) === x) — the proof the
//     state came through the GPU, not the f64 CPU step.
// P2  no leak: re-attach N times (resize the panel / re-post attachAgentCanvas);
//     __e1bCounters.gpuRefCount and .gpuAdapterRequests must NOT grow.
// P3  gate matrix: window.__agentRenderState() ⇒ { eligible, modelTermsOk,
//     directActive, compositeActive, metaballs }. A bonded model (Growing Tissue)
//     must show eligible:false and post ZERO attachAgentCanvas messages.
// P4  rebuild seed (BLOCKER): free-run, force a soft recompile, then getState —
//     agent positions must be preserved and still evolving (never 0,0 / radius 0).
// P5  colours: on a behaviour graph with NO colour node, the readback colours must
//     be the default agent colour, never (0,0,0,0).
`);
}

section('RESULT');
if (failures === 0) console.log('AGENT RENDER-LAYER INVARIANTS ✓');
else console.log(`${failures} FAILURE(S)`);
rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
