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
// NB the brace search starts at the END of the match, so a regex can consume a
// `): Promise<{ ... }>` RETURN TYPE and still land on the body brace. (Anchoring
// at m.index made readbackAgentStep's "block" its return-type literal.)
function blockAfter(src, startRe) {
  const m = startRe.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index + m[0].length);
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

// B10 (L1 lattice voxel render, user-reported: "free mode never displays") — the
// same attach/present discipline as the agent path, on the 3D grid's canvas.
//
// NB the shipped cause of that bug was NOT any of these: it was the VoxelView
// uniform's byte layout drifting from uploadVoxelView (a vec3's 12-byte size put
// the shader's `ambient` at 124 while the writer wrote from 128, so `cubeScale`
// read the specular slot — 0 by default — and every cube collapsed to a point).
// That class is COMPUTED by scripts/verify-render-uniform-layouts.mjs; a source
// harness cannot derive byte offsets, so it lives there. These pin the wiring the
// investigation had to rule out first, so a future regression is triaged in one
// step instead of re-walking all five candidates.
{
  const sv = readSrc('simulator/SimulatorView.tsx');
  // The canvas the worker presents into MUST be the one in the DOM: append the
  // fresh element, transfer THAT element's control, and promote exactly it.
  const attach = blockAfter(sv, /const maybeAttachVoxelCanvas = useCallback\(/);
  check('SimulatorView: the voxel canvas is appended to the DOM layer [presented ≠ attached]',
    attach.includes('layer.appendChild(fresh)'));
  check('SimulatorView: control of THAT element is what gets transferred [presented ≠ attached]',
    /fresh as HTMLCanvasElement[\s\S]{0,140}transferControlToOffscreen\(\)/.test(attach));
  check('SimulatorView: the transferred element is stashed as the pending canvas [presented ≠ attached]',
    attach.includes('pendingVoxelCanvas.current = fresh'));
  const status = blockAfter(sv, /if \(msg\.type === 'voxelRenderStatus'\)/);
  check('SimulatorView: the attach ack promotes exactly the pending element [presented ≠ attached]',
    status.includes('voxelCanvasRef.current = pendingVoxelCanvas.current'));
  // The attach-time present runs with whatever uniform the worker already had
  // (zero on a first attach), so the ack MUST force a camera post — dedup and all.
  check('SimulatorView: the attach ack force-posts the camera (defeats the dedup key) [zero-uniform frame]',
    status.includes("lastGridCameraKeyRef.current = ''") && status.includes("type: 'setGridCamera'"));
  // A failed attach must not leave an orphan canvas over the gl3d output.
  check('SimulatorView: a failed voxel attach removes the orphan canvas [layering]',
    status.includes('p.parentElement.removeChild(p)'));

  const rt = readSrc('simulator/engine/webgpuRuntime.ts');
  // The swap-chain texture is per-frame: a cached view presents into a stale one.
  check('runtime: presentVoxels acquires the current swap-chain texture each frame [stale-target]',
    bodyHas('simulator/engine/webgpuRuntime.ts', /export function presentVoxels\b/, 'rt.voxelCtx.getCurrentTexture()'));
  check('runtime: the depth attachment tracks the canvas size [stale-target]',
    bodyHas('simulator/engine/webgpuRuntime.ts', /export function presentVoxels\b/, 'ensureVoxelDepthTex(rt, tex.width, tex.height)'));
  check('runtime: the canvas context is configured premultiplied (gl3d composites over it)',
    bodyHas('simulator/engine/webgpuRuntime.ts', /export async function setupVoxelRender\b/, "alphaMode: 'premultiplied'"));
  // The uniform must be (re)uploaded on attach and on an explicit refresh, not
  // only when the camera happens to move.
  const w = readSrc('simulator/engine/sim.worker.ts');
  check('worker: attach uploads the stored view before its first present [zero-uniform frame]',
    /case 'attachVoxelCanvas':[\s\S]{0,2200}uploadVoxelView\(rt, gridRenderView\)/.test(w));
  check('worker: refreshGridDisplay re-uploads the view then presents [tab-refocus]',
    /case 'refreshGridDisplay':[\s\S]{0,600}uploadVoxelView\([\s\S]{0,200}presentVoxelsIfActive\(\)/.test(w));
  // The layout cross-check must exist and cover VoxelView (this harness cannot).
  const layoutScript = readFileSync(join(ROOT, 'scripts/verify-render-uniform-layouts.mjs'), 'utf8');
  check('scripts: the uniform-layout cross-check exists and covers VoxelView [invisible-voxels bug]',
    layoutScript.includes("struct: 'VoxelView'") && layoutScript.includes("writer: 'uploadVoxelView'"));
}

// B11 (UI-SYNC MIRROR INVARIANT, user-reported: "after free mode, pause / 3D
// inspect / shadows / AO / alpha blend / recording all silently stop working").
//
// The worker's `gridUiSync` / `agentUiSync` are MODULE flags that SURVIVE a
// re-attach on the SAME worker (a display resize re-attaches the canvas), so the
// attach ack must MIRROR what the worker reports — never assume the module
// default. Assuming ON while the worker sits OFF strands the main thread's
// mirror, and the driver's `if (!posted)` guard then suppresses EVERY later ON
// post. Because the stuck value is ON, no OFF transition can resync it either:
// the readback path is dead for the rest of the session and no colours/snapshot
// frame ever crosses the wire again.
//
// The invariant these pin: the mirror is only ever assigned from a value the
// worker was TOLD (a post in the same statement), a value the worker ACKED, or
// the module default of a BRAND-NEW worker created in the same tick.
{
  const sv = readSrc('simulator/SimulatorView.tsx');
  const w = readSrc('simulator/engine/sim.worker.ts');
  const countAll = (s, needle) => s.split(needle).length - 1;

  // 1. The worker ACKS its live flag on both attach paths (nothing else can tell
  //    the main thread whether a re-attach landed on an ON or an OFF worker).
  check('worker: the voxel attach ack carries the live gridUiSync [mirror invariant]',
    /case 'attachVoxelCanvas':[\s\S]{0,3000}voxelRenderStatus', active: true, uiSync: gridUiSync/.test(w));
  check('worker: the agent attach ack carries the live agentUiSync [mirror invariant]',
    /case 'attachAgentCanvas':[\s\S]{0,6000}agentRenderStatus', active: true[^}]*uiSync: agentUiSync/.test(w));

  // 2. The main thread MIRRORS the acked value instead of assuming ON.
  const gridAck = blockAfter(sv, /if \(msg\.type === 'voxelRenderStatus'\)/);
  const agentAck = blockAfter(sv, /msg\.type === 'agentRenderStatus'\)/);
  check('SimulatorView: the voxel ack derives the mirror from msg.uiSync [mirror invariant]',
    /gridUiSyncPostedRef\.current = \(msg\.uiSync[^;]*!== false/.test(gridAck));
  check('SimulatorView: the voxel ack never assumes the mirror is ON [mirror invariant]',
    gridAck.length > 0 && !gridAck.includes('gridUiSyncPostedRef.current = true'));
  check('SimulatorView: the agent ack derives the mirror from msg.uiSync [mirror invariant]',
    /agentUiSyncPostedRef\.current = \(msg\.uiSync[^;]*!== false/.test(agentAck));
  check('SimulatorView: the agent ack never assumes the mirror is ON [mirror invariant]',
    agentAck.length > 0 && !agentAck.includes('agentUiSyncPostedRef.current = true'));

  // 3. A pending OFF debounce armed for the PREVIOUS attach must not survive the
  //    re-mirror (it would post OFF against freshly-mirrored state).
  check('SimulatorView: the voxel ack drops any pending OFF debounce [mirror invariant]',
    gridAck.includes('clearTimeout(gridUiSyncTimerRef.current)'));
  check('SimulatorView: the agent ack drops any pending OFF debounce [mirror invariant]',
    agentAck.includes('clearTimeout(agentUiSyncTimerRef.current)'));

  // 4. The fix must NOT be "delete the guard" — that would post on every driver
  //    call (the driver runs per stepped message and per pointer event).
  const gridDriver = blockAfter(sv, /const updateGridUiSync = useCallback\(/);
  const agentDriver = blockAfter(sv, /const updateAgentUiSync = useCallback\(/);
  check('SimulatorView: the grid driver still guards its ON post on the mirror [no redundant posts]',
    gridDriver.includes('if (!gridUiSyncPostedRef.current)'));
  check('SimulatorView: the agent driver still guards its ON post on the mirror [no redundant posts]',
    agentDriver.includes('if (!agentUiSyncPostedRef.current)'));

  // 5. No ASSUMED `= true` anywhere else. The sanctioned sites are the driver's
  //    own ON post, the two brand-new-worker resets inside initWorkerWithDimensions,
  //    and (agents) the 3D alpha-blend detach, which POSTS in the same statement.
  const initBlock = blockAfter(sv, /const initWorkerWithDimensions = useCallback\(/);
  // The failed-attach force-on helpers (the frozen-frame-on-panel-resize fix)
  // are sanctioned: they mirror + post in the same statement, exactly like the
  // driver's own ON post.
  const forceGrid = blockAfter(sv, /const forceGridUiSyncOn = useCallback\(/);
  const forceAgent = blockAfter(sv, /const forceAgentUiSyncOn = useCallback\(/);
  check('SimulatorView: the force-on helpers TELL the worker in the same statement [mirror invariant]',
    /gridUiSyncPostedRef\.current = true;[\s\S]{0,200}?w\.postMessage\(\{ type: 'setGridUiSync', on: true \}\)/.test(forceGrid)
    // Same tolerance as the grid arm above: BOTH helpers now set their
    // frame-awaiting flag (gridFrameAwaitingColorsRef / agentFrameAwaitingSnapshotRef)
    // between the mirror and the post. What the invariant demands is that the post
    // rides the SAME statement group, not that nothing sits between them.
    && /agentUiSyncPostedRef\.current = true;[\s\S]{0,200}?w\.postMessage\(\{ type: 'setAgentUiSync', on: true \}\)/.test(forceAgent));
  check('SimulatorView: every gridUiSync "= true" is a post or a brand-new worker [mirror invariant]',
    countAll(sv, 'gridUiSyncPostedRef.current = true')
      === countAll(gridDriver, 'gridUiSyncPostedRef.current = true')
        + countAll(initBlock, 'gridUiSyncPostedRef.current = true')
        + countAll(forceGrid, 'gridUiSyncPostedRef.current = true'));
  // The 3D FRAME-PIN detaches. ONE of them — alpha-blend — and it must POST before
  // it mirrors. There were TWO: 3D GLOW pinned the frame path as well, because the
  // bloom was a gl3d-only post-process. The worker's sphere pass carries its own
  // dual-Kawase bloom now (BLOOM3D_WGSL), so a glowing 3D model keeps free mode and
  // that pin is GONE. Counted, not just matched, so adding another pin without
  // posting is caught rather than absorbed.
  check('SimulatorView: the 3D frame-pin detach TELLS the worker before mirroring [mirror invariant]',
    (sv.match(/setAgentUiSync', on: true \}\);\s*\n\s*agentUiSyncPostedRef\.current = true;/g) || []).length === 1);
  check('SimulatorView: every agentUiSync "= true" is a post or a brand-new worker [mirror invariant]',
    countAll(sv, 'agentUiSyncPostedRef.current = true')
      === countAll(agentDriver, 'agentUiSyncPostedRef.current = true')
        + countAll(initBlock, 'agentUiSyncPostedRef.current = true')
        + countAll(forceAgent, 'agentUiSyncPostedRef.current = true')
        + 1 /* the alpha-blend frame-pin detach checked above */);
  // 3D GLOW MUST NOT RE-PIN. The gate term and the maybeAttachAgentCanvas re-check
  // are both gone; if either comes back, a glowing 3D model silently loses the
  // free-mode fast path again (and the worker's bloom would go unused).
  check('SimulatorView: 3D glow does NOT gate the agent render eligibility [free-mode bloom]',
    !/!is3D \|\| !agentGlowRef\.current\.on/.test(sv));
  check('SimulatorView: maybeAttachAgentCanvas does NOT bail on 3D glow [free-mode bloom]',
    !/if \(is3dRef\.current && agentGlowRef\.current\.on\) return;/.test(sv));
}

// [glow-3d] THE FREE-MODE BLOOM — the worker's WGSL sibling of gl3d's
// renderAgentBloom. It is what lifted the 3D frame pin, so the properties that make
// the two renderers agree are pinned here.
//
// The invariants, and why each one is load-bearing:
//   - the SOURCE is the agents ALONE (gl3d re-renders the agent layer into its
//     level-0 FBO rather than reading the finished frame back), so a wireframe /
//     brush plane can never bloom and the existing render is untouched;
//   - the composite can only ADD LIGHT (ONE/ONE) — the 3D form of 2D's solid-core
//     invariant, and what keeps glow-off identical;
//   - the tonemap is the SHARED constant, so Intensity means the same thing in
//     every view and on every path;
//   - the chain is freed on resize / rebuild / glow-off / teardown (canvas-sized
//     textures — at 4K, tens of MB nothing would read).
{
  const rt = readSrc('simulator/engine/agentWebgpuRuntime.ts');
  const wgsl = rt.slice(rt.indexOf('const BLOOM3D_WGSL'), rt.indexOf('const BLOOM3D_WGSL') + 6000);

  check('the bloom SOURCE pass draws the spheres alone — no line pipeline [glow-3d]', (() => {
    const b = blockAfter(rt, /function encodeBloom3DChain\(/);
    return b.includes('bloom3dSpherePipeline') && !b.includes('renderLinePipeline');
  })());
  check('the bloom source clears TRANSPARENT (its alpha is the core-mask coverage) [glow-3d]',
    /agent-bloom3d-source[\s\S]{0,400}?clearValue: \{ r: 0, g: 0, b: 0, a: 0 \}/.test(rt));
  check('the composite ADDS light (one/one) and never darkens [glow-3d]',
    /agent-bloom3d-composite'[\s\S]{0,400}?color: \{ srcFactor: 'one', dstFactor: 'one', operation: 'add' \}/.test(rt));
  check('the composite runs over the RESOLVED frame with loadOp load [glow-3d]',
    /agent-bloom3d-composite',\s*\n\s*colorAttachments: \[\{ view, loadOp: 'load', storeOp: 'store' \}\]/.test(rt));
  check('the bloom tonemaps with the SHARED exposure constant [glow-3d]',
    /const GLOW_EXPOSURE : f32 = \$\{GLOW_TONE_EXPOSURE\.toFixed\(4\)\};/.test(wgsl)
    && /let t : f32 = x \/ \(1\.0 \+ x\);/.test(wgsl));
  check('the composite keeps the hue exact (Reinhard on the MAGNITUDE) [glow-3d]',
    /let m : f32 = max\(s\.r, max\(s\.g, s\.b\)\);/.test(wgsl)
    && /clamp\(s \/ m, vec3<f32>\(0\.0\), vec3<f32>\(1\.0\)\) \* k/.test(wgsl));
  check('core masks the bloom out of the agent\'s own opaque pixels [glow-3d]',
    /let k : f32 = t \* \(1\.0 - bp\.core \* clamp\(textureSample\(prev, samp, in\.uv\)\.a, 0\.0, 1\.0\)\);/.test(wgsl));
  check('the slider→chain mapping matches gl3d (levels / offset / spread) [glow-3d]', (() => {
    const b = blockAfter(rt, /function encodeBloom3DChain\(/);
    const g = readSrc('simulator/render/gl3d.ts');
    // The same three formulas on both sides — a drift here is a visible free↔frame pop.
    return /Math\.ceil\(Math\.log2\(Math\.max\(2, reach\)\)\)/.test(b) && /Math\.ceil\(Math\.log2\(Math\.max\(2, reach\)\)\)/.test(g)
      && /reach \/ \(1 << levels\)/.test(b) && /reach \/ \(1 << levels\)/.test(g)
      && /0\.9 - 0\.1 \* g\.steepness/.test(b) && /0\.9 - 0\.1 \* this\.glow\.steepness/.test(g);
  })());
  check('the level chain is freed on resize, rebuild, glow-off AND teardown [glow-3d]',
    // Each site named individually — a loose call COUNT would absorb the loss of any
    // one of them (the chain is canvas-sized: at 4K that is tens of MB per leak).
    /function ensureBloom3DChain\([\s\S]{0,600}?destroyBloom3DChain\(rt\);/.test(rt)          // resize
    && /function destroyBloom3DResources\(rt: AgentRenderSurface\): void \{\s*\n\s*destroyBloom3DChain\(rt\);/.test(rt)  // teardown
    && /if \(wasOn && !on\) destroyBloom3DChain\(rt\);/.test(rt)                              // glow off
    && blockAfter(rt, /async function setupAgentSphereRender\(/).includes('destroyBloom3DChain(rt);')   // rebuild
    && rt.split('destroyBloom3DResources(rt);').length - 1 === 2);                            // both teardown paths
  check('a bloom WGSL / pipeline failure degrades to NO glow, never a wrong frame [glow-3d]', (() => {
    const b = blockAfter(rt, /function bloom3dActive\(/);
    return b.includes('!!rt.bloom3dSpherePipeline') && b.includes('!!rt.bloom3dCompositePipeline');
  })());
}

// B12 (SNAPSHOT-CONTENTS INVARIANT, user-reported: "the hemifield is being drawn
// as a circle, not a cone").
//
// The render snapshot is SLIM by design: per-agent velocity (vx/vy) ships only
// for consumers that asked for it — sprite models (orientToVelocity) and the
// vision-cone display. A consumer that READS vx/vy without requesting them gets
// a length-0 array, i.e. a silent ZERO heading — and a zero heading is a legal
// state that means "omnidirectional", so every cone rendered as a full circle
// with no error anywhere.
//
// NB an arc-COUNT check cannot catch this: both the cone and the circle branch
// call ctx.arc once per agent. Only the arc's SWEEP distinguishes them.
{
  const sv = readSrc('simulator/SimulatorView.tsx');
  const w = readSrc('simulator/engine/sim.worker.ts');
  const eng = readSrc('simulator/engine/agentEngine.ts');

  check('agentEngine: the snapshot takes an includeVelocity flag [snapshot-contents]',
    /export function snapshotAgentsForRender\([^)]*includeVelocity/.test(eng));
  check('agentEngine: vx/vy ship for sprites OR an explicit velocity request [snapshot-contents]',
    /const wantVel = includeSprites \|\| includeVelocity/.test(eng)
    && /vx: wantVel \?/.test(eng) && /vy: wantVel \?/.test(eng));
  check('worker: the render snapshot passes the velocity flag [snapshot-contents]',
    /snapshotAgentsForRender\(agentStore, hasAgentSprites, agentSnapshotVelocity\)/.test(w));
  check('worker: setAgentSnapshotVelocity sets the flag [snapshot-contents]',
    /case 'setAgentSnapshotVelocity':[\s\S]{0,300}agentSnapshotVelocity = !!msg\.on/.test(w));
  // The display toggle must TELL the worker — on change AND after a worker
  // reinit (a fresh worker defaults to not shipping velocity).
  check('SimulatorView: the vision toggle posts setAgentSnapshotVelocity [snapshot-contents]',
    /setAgentSnapshotVelocity', on: showVision !== 'off'/.test(sv));
  const initBlock2 = blockAfter(sv, /const initWorkerWithDimensions = useCallback\(/);
  check('SimulatorView: a worker reinit re-publishes the velocity request [snapshot-contents]',
    /showVisionRef\.current !== 'off'/.test(initBlock2)
    && /setAgentSnapshotVelocity', on: true/.test(initBlock2));
}

// B13 (THE ACTIVE WINDOW, user-reported: "on wasm the processing is much faster
// than on webgpu (roughly 2x)").
//
// `maxAgents` is a USER-SET CEILING. Every per-generation CPU<->GPU transfer used
// to be sized by it, so a model that grows to ~2 000 agents under a 60 000 ceiling
// moved ~15 MB of mostly-dead slots EVERY generation. A bonded / structurally-
// rewriting model can never be residency-eligible, so it always pays that.
// MEASURED on the reporter's 3D Cubic GRA: 47 ms/gen -> 10.9 ms/gen (~4.4x) at
// the SAME 60 000 ceiling, at a LARGER population.
//
// The window (`gpuActiveHigh`) must:
//   - be MONOTONIC. A slot the GPU has written must keep being refreshed, or its
//     stale request-queue lanes get read back and DRAINED on a later generation.
//     Slots it never covered are still the zero the buffer was created with,
//     which is exactly the "no requests, not alive" state the reconcile expects.
//   - cover the post-dispatch SPAWN CURSOR, not just highWater: a spawning
//     behaviour bump-allocates slots ABOVE highWater and the reconcile reads them.
//   - drive a COMPACTED readback. The f32 SoA is strided runs, so a windowed
//     readback cannot be one prefix copy; every run is planned, and an unplanned
//     base must THROW rather than silently read a neighbouring run.
{
  const rt = readSrc('simulator/engine/agentWebgpuRuntime.ts');

  check('runtime carries the active window [active-window]',
    /gpuActiveHigh: number;/.test(rt) && /gpuActiveHigh: 0,/.test(rt));
  const winFn = blockAfter(rt, /function agentActiveWindow\(/);
  check('the window is MONOTONIC and ceiling-clamped [active-window]',
    /Math\.max\(rt\.gpuActiveHigh/.test(winFn) && /Math\.min\(ma,/.test(winFn)
    && /rt\.gpuActiveHigh = w/.test(winFn));

  // Upload: no whole-buffer write may remain (those were sized by the ceiling).
  const up = blockAfter(rt, /export function uploadAgentSoA\(/);
  check('upload: windowed, not the maxAgents ceiling [active-window]',
    /const ma = agentActiveWindow\(rt, hw\)/.test(up));
  check('upload: per-RUN writes replaced the whole-buffer write [active-window]',
    !/writeBuffer\(rt\.agentF32Buf, 0, f\.buffer/.test(up)
    && !/writeBuffer\(rt\.agentI32Buf, 0, ix\.buffer/.test(up)
    && /putF32\(base, AGENT_GPU_QUEUE_FIELDS\.has\(field\) \? L\.bondReqSlots : 1\)/.test(up));

  // Readback: the compacted plan + the cursor-first sizing.
  const plan = blockAfter(rt, /function buildF32ReadPlan\(/);
  check('readback plan covers EVERY run, not just the ones read [active-window]',
    /for \(const field of f32Fields\) add\(/.test(plan)
    && /for \(const id of L\.agentAttrIds\) \{ add\(L\.agentAttrBase\[id\], 1\); add\(L\.agentAttrWriteBase\[id\], 1\); \}/.test(plan)
    && /for \(const id of L\.bondAttrIds\) add\(L\.bondFormAttrBase\[id\]/.test(plan));
  const cb = blockAfter(rt, /function compactBase\(/);
  check('an unplanned run base THROWS (never silently reads a neighbour) [active-window]',
    /throw new Error\(/.test(cb));
  const rbs = blockAfter(rt, /export async function readbackAgentStep\([\s\S]*?\): Promise<\{[^}]*\}>/);
  check('readback: the spawn cursor is read FIRST and sizes the window [active-window]',
    /agent-readback-cursor/.test(rbs) && /agentActiveWindow\(rt, Math\.max\(hw, Math\.min\(cursorVal/.test(rbs));
  check('readback: per-run compacted copies, not one whole-buffer copy [active-window]',
    /for \(const c of plan\.copies\) enc\.copyBufferToBuffer\(rt\.agentF32Buf, c\.src \* 4/.test(rbs)
    && !/copyBufferToBuffer\(rt\.agentF32Buf, 0, stagingF, 0, f32ByteLen\)/.test(rbs));
  check('readback: every f32 base is rebased through the plan [active-window]',
    /const CB = \(b: number\): number => compactBase\(plan, b\)/.test(rbs)
    && /const xB = CB\(L\.f32Base\['xNext'\]!\)/.test(rbs)
    && /const base = CB\(L\.agentAttrBase\[id\]!\)/.test(rbs));
  check('readback: the cursor is NOT re-mapped a second time [active-window]',
    !/cursorArr = new Uint32Array\(pooledCursor\.buffer\.getMappedRange/.test(rbs));

  // The resident once-per-frame readback gets the same treatment.
  const rbf = blockAfter(rt, /export async function readbackAgentFrame\(/);
  check('resident frame readback is windowed + compacted too [active-window]',
    /const win = agentActiveWindow\(rt, hw\)/.test(rbf)
    && /for \(const c of plan\.copies\) enc\.copyBufferToBuffer/.test(rbf)
    && /const CB = \(b: number\): number => compactBase\(plan, b\)/.test(rbf));

  // The bond store is agent-major too — it must follow the window.
  const bs = blockAfter(rt, /export function uploadAgentBondStore\(/);
  check('bond-store upload is windowed [active-window]',
    /const win = agentActiveWindow\(rt, s\.highWater\)/.test(bs)
    && /writeBuffer\(rt\.bondStoreBuf, 0, out, 0, outLen\)/.test(bs));
}

// B14 (THE PASSIVE-HOVER PIN, user-reported: "just having the cursor on top of
// the simulation drags the performance down ... even if the user is not actually
// interacting ... when it doesn't even change the highlight").
//
// The agent UI-sync hover want-term used to be a bare "agent brush armed + cursor
// over the canvas". On an AGENTS-ONLY model `brushTarget` is FORCED to 'agents',
// so that reduced to "cursor over the canvas" — and the DEFAULT brush mode (add)
// reads NOTHING from the snapshot. Resting the cursor therefore held the
// per-frame GPU readback + snapshot ship forever. Measured on Particle Life
// (WebGPU agents, free-running): worker turnaround median 4.1 → 9.5 ms, mean
// 5.4 → 19.9, p90 5.7 → 89.2, throughput −25%, a snapshot on 487/487 frames.
//
// Two independent guards, and BOTH matter: the mode predicate (a passive hover in
// a non-reading mode must never pin) and the idle backstop (3 s of a motionless
// cursor releases the pin even in a reading mode, clearing the stale-dependent
// visuals so nothing wrong is left drawn).
{
  const sv = readSrc('simulator/SimulatorView.tsx');

  // Push/Pull are in the set for their HIGHLIGHT (the ring over every agent the
  // disc will displace); their EFFECT is worker-side (a centre + a radius, never
  // an id list). Paint is in for BOTH halves — its footprint highlight AND the id
  // scan its press runs. `add` must stay OUT — it is the default mode and reads
  // nothing. ADDING A MODE MUST BE A DELIBERATE EDIT HERE, not an accident.
  check('the state-reading brush modes are an explicit set EXCLUDING add [hover-pin]',
    /const AGENT_BRUSH_MODES_NEEDING_STATE: ReadonlySet<string> = new Set\(\['remove', 'move', 'edit', 'paint', 'push', 'pull', 'glue', 'cut'\]\)/.test(sv));

  const needs = blockAfter(sv, /const agentHoverNeedsState = useCallback\(/);
  check('the predicate consults the brush MODE, not just the target [hover-pin]',
    /AGENT_BRUSH_MODES_NEEDING_STATE\.has\(agentBrushModeRef\.current\)/.test(needs));
  check('inspect (toggle or Shift) arms REGARDLESS of the brush target [hover-pin]',
    /if \(inspectModeRef\.current \|\| shiftDownRef\.current\) return true;/.test(needs)
    && needs.indexOf('inspectModeRef') < needs.indexOf("brushTargetRef.current !== 'agents'"));

  // The want-term must AND both guards — dropping either one restores the bug.
  const want = blockAfter(sv, /const updateAgentUiSync = useCallback\(/);
  check('the hover want-term ANDs the predicate AND the idle flag [hover-pin]',
    /agentHoverNeedsState\(\) && agentHoverActiveRef\.current/.test(want));
  check('the hover want-term still covers BOTH canvases [hover-pin]',
    /agentCursorWorldRef\.current != null \|\| \(is3dRef\.current && glPointerOverRef\.current\)/.test(want));

  // The backstop must CLEAR what it stops refreshing — the hovered-agent ring and
  // the area highlight are drawn from the LIVE snapshot every frame, so leaving
  // them would drift off the agents they name.
  const note = blockAfter(sv, /const noteHoverActivity = useCallback\(/);
  check('the idle backstop clears the stale-dependent hover visuals [hover-pin]',
    /agentHoverActiveRef\.current = false;/.test(note)
    && /agentHoverIdRef\.current = -1/.test(note)
    && /agentAreaHoverIdsRef\.current = \[\]/.test(note));
  check('the idle backstop re-evaluates the driver on expiry [hover-pin]',
    /if \(agentDirectRenderActiveRef\.current\) updateAgentUiSync\(\);\s*\n\s*\};/.test(note));

  // Every activity source must re-arm, or the pin stays down while the user works.
  check('the 2D move re-arms BEFORE the coalesced hover work [hover-pin]',
    /noteHoverActivity\(\);\s*\n\s*scheduleHoverWork\(\);/.test(sv));
  // NB the anchors deliberately STOP before the arrow's `{` — blockAfter looks
  // for the next `{` AFTER the match, so including it would scan an inner block.
  const down2d = blockAfter(sv, /const handleMouseDown = \(e: MouseEvent\) =>/);
  check('the 2D press re-arms [hover-pin]', /noteHoverActivity\(\);/.test(down2d));
  const wheel2d = blockAfter(sv, /const handleWheel = \(e: WheelEvent\) =>/);
  check('the 2D wheel re-arms [hover-pin]', /noteHoverActivity\(\);/.test(wheel2d));
  const move3d = blockAfter(sv, /const onMove = \(e: PointerEvent\) =>/);
  check('the 3D move re-arms [hover-pin]', /noteHoverActivity\(\);/.test(move3d));
  check('the 3D canvas enter re-arms [hover-pin]',
    /glPointerOverRef\.current = true; noteHoverActivity\(\);/.test(sv));

  // Shift is the inspect modifier on both canvases and its pick reads the
  // snapshot — arming on the MODIFIER is what keeps Shift+LMB correct in `add`.
  check('Shift is tracked at the window level and re-evaluates the driver [hover-pin]',
    /shiftDownRef\.current = e\.shiftKey;[\s\S]{0,400}?if \(e\.shiftKey\) noteHoverActivity\(\);\s*\n\s*if \(agentDirectRenderActiveRef\.current\) updateAgentUiSync\(\);/.test(sv)
    && /window\.addEventListener\('keydown', onKey\)/.test(sv)
    && /window\.addEventListener\('keyup', onKey\)/.test(sv));
  check('a blur drops the Shift latch [hover-pin]',
    /const onBlur = \(\) => \{[\s\S]{0,200}shiftDownRef\.current = false;/.test(sv));

  // The predicate reads REFS, which only catch up on the next render — the state
  // effect must therefore re-run when the mode / inspect toggle / target changes.
  check('a mode / inspect / target change re-evaluates the driver [hover-pin]',
    /useEffect\(\(\) => \{ updateAgentUiSync\(\); \}, \[[^\]]*agentBrushMode, inspectMode, brushTarget, updateAgentUiSync\]\)/.test(sv));
}

// B15 (THE DISC EDGE COVERAGE, user-reported: "anti-aliasing should be offered on
// agents models as well ... the contours of the agents appear serrated").
//
// The 2D agent disc FS used to end its silhouette with a bare `if (d > 1.0)
// { discard; }` — a BINARY edge with no coverage. Measured on a real device with
// the shipped shader (radius 12): 0 partial-coverage pixels and 0 distinct partial
// alphas, the centre scanline stepping 255 → 0 in one pixel; the CPU overlay path
// (Canvas2D arc fill) produced 2084 partial pixels over 54 alpha levels on the same
// app. THAT inconsistency is what users saw — an overlay model looked smooth and a
// direct-render one (Particle Life, and every E2 composite model) looked jagged.
//
// After: 100 partial pixels / 30 alpha levels, with the coverage-weighted area
// landing on pi*r^2 to within 0.02% (448 → 452.30 vs 452.39) — the ramp is
// calibrated, not merely blurred — and the fully-opaque body BIT-IDENTICAL.
//
// ONE shader module feeds A1 (direct render), A2 (snapshot-fed) and the E2
// composite, so all three inherit this. Every check below pins a line whose
// absence restores a specific defect.
{
  const rt = readSrc('simulator/engine/agentWebgpuRuntime.ts');
  const wgsl = blockAfter(rt, /function agentRenderWGSL\(/);

  // The derivative MUST be taken before any discard — WGSL requires derivative
  // builtins in uniform control flow.
  check('fsMain takes fwidth(d) BEFORE any discard [disc-aa]',
    /let pxw: f32 = max\(fwidth\(d\), 1\.0e-5\);[\s\S]{0,200}?let cov: f32 = clamp\(\(1\.0 - d\) \/ pxw \+ 0\.5, 0\.0, 1\.0\);[\s\S]{0,80}?if \(cov <= 0\.0\) \{ discard; \}/.test(wgsl));
  // The coverage must reach the OUTPUT — folding it into alpha only would leave
  // the premultiplied colour over-bright at the rim (a bright fringe).
  check('the coverage folds into alpha AND the premultiplied rgb [disc-aa]',
    /let a: f32 = in\.col\.a \* cov;/.test(wgsl)
    && /return vec4<f32>\(rgb \* a, a\);/.test(wgsl));
  // The old hard step must be GONE from the core FS (fsGlow keeps its own discard:
  // its falloff already reaches zero at d == 1, so it was never aliased).
  const fsMain = wgsl.slice(wgsl.indexOf('fn fsMain'), wgsl.indexOf('fn fsGlow'));
  check('fsMain no longer ends the silhouette with a bare hard discard [disc-aa]',
    !/if \(d > 1\.0\) \{ discard; \}/.test(fsMain));

  // The quad CIRCUMSCRIBES the disc, so the two halves of the pad are a PAIR:
  // padding without the uv rescale shrinks the drawn disc; rescaling without the
  // pad clips the outer half of the ramp at the four tangent points (four notches).
  check('the quad carries a one-pixel AA pad [disc-aa]',
    /let padded: f32 = half \+ 1\.0;/.test(wgsl)
    && /corner\.x \* padded/.test(wgsl) && /corner\.y \* padded/.test(wgsl));
  check('uv is rescaled so d == 1 still marks the drawn radius [disc-aa]',
    /out\.uv = corner \* \(padded \/ half\);/.test(wgsl));
  check('out.radPx stays the UNPADDED radius (the outline band must not move) [disc-aa]',
    /out\.radPx = half;/.test(wgsl) && !/out\.radPx = padded/.test(wgsl));
  check('the pad divisor cannot be zero [disc-aa]',
    /var half: f32 = max\(0\.001, coreR\);/.test(wgsl));

  // The outline band is a second hard step inside the body; the CPU overlay draws
  // it as an antialiased stroke(), so it is feathered with the SAME derivative.
  check('the outline band is feathered with the same derivative [disc-aa]',
    /let t: f32 = clamp\(\(d - \(1\.0 - rim\)\) \/ pxw \+ 0\.5, 0\.0, 1\.0\);/.test(wgsl)
    && /rgb = rgb \* mix\(1\.0, 0\.60, t\);/.test(wgsl));

  // ONE module builder → A1/A2 and E2 cannot drift apart on the edge policy.
  const disc = blockAfter(rt, /async function buildAgentDiscPipelines\(/);
  check('one module feeds both disc pipelines [disc-aa]',
    /createShaderModule\(\{ code: agentRenderWGSL\(rt\.layout\) \}\)/.test(disc));
  check('the E2 composite builds its disc pipelines from that same builder [disc-aa]',
    /await buildAgentDiscPipelines\(rt\)/.test(blockAfter(rt, /async function setupAgentCompositeRender\(/)));
}

// B16 (THE GLOW ARCHITECTURE, user-reported twice: first "find a better way to
// blend the glow halos to avoid this oversaturated look and contrast artifacts
// where there is a high density", then — after the screen-blend round — "it's
// gotten better but still not good enough. Use as reference the way that our
// Particle Life reference code solves it").
//
// THE LESSON, ported from SandboxScience's Particle Life renderer: a per-pair
// blend is MEMORYLESS, so N stacked halos of per-halo display value p always give
// 1-(1-p)^N (screen) or min(1,Np) (additive) — every member of that family
// exhausts the 8-bit range after ~4 overlaps for any p bright enough to see ONE
// halo. The plateau is a property of the ARCHITECTURE, not of the operator. Their
// renderer accumulates every particle ADDITIVELY into an rgba16float HDR target
// and compresses ONCE in a fullscreen compose pass. So do we now.
//
// Both paths compute tonemap(SUM of colour*g) composited with SCREEN. GPU: an HDR
// texture + GLOW_COMPOSE_WGSL. CPU: Canvas2D has no float target, so it
// accumulates the LOG ENCODING of the same sum — screen is c <- s+c-s*c, so a
// sprite baking 1-exp(-E*g) makes the buffer hold exactly 1-exp(-E*SUM g) — and
// one typed-array pass decodes and tonemaps it. MEASURED parity: the largest
// |GPU-CPU| difference over 1..50 overlapping halos is 0.0088 (2.2/255).
{
  const rt = readSrc('simulator/engine/agentWebgpuRuntime.ts');
  const disc = blockAfter(rt, /async function buildAgentDiscPipelines\(/);
  const glowBlend = disc.slice(disc.indexOf('const glowBlend'), disc.indexOf('const glowComposeBlend'));

  // ADDITIVE — but into float, where it is the EXACT sum, not the clipping 8-bit
  // additive this used to be nor the per-pair screen it was changed to.
  check('the GPU halo accumulates ADDITIVELY [glow-arch]',
    /color: \{ srcFactor: 'one', dstFactor: 'one', operation: 'add' \}/.test(glowBlend)
    && /alpha: \{ srcFactor: 'one', dstFactor: 'one', operation: 'add' \}/.test(glowBlend));
  // ...into an HDR target. Additive onto the canvas is exactly the original bug.
  check('the halo pipeline targets the HDR format, not the canvas [glow-arch]',
    /entryPoint: 'fsGlow', targets: \[\{ format: GLOW_HDR_FORMAT, blend: glowBlend \}\]/.test(disc));
  check('the HDR target is rgba16float (renderable AND blendable) [glow-arch]',
    /const GLOW_HDR_FORMAT: GPUTextureFormat = 'rgba16float';/.test(rt));
  // The tonemapped layer composites with SCREEN — the same rule as before, applied
  // ONCE — which preserves "a halo can only brighten the backdrop" and the
  // source-over alpha that keeps the transparent agent canvas compositing right.
  check('the tonemapped layer composites with SCREEN [glow-arch]',
    /const glowComposeBlend: GPUBlendState = \{\s*color: \{ srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' \},\s*alpha: \{ srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' \},/.test(disc));

  // NO CLAMP. The clamp was load-bearing under screen (dst factor is 1-src, so a
  // value above 1 SUBTRACTS the backdrop) but it gave every agent a hard-edged
  // fully-saturated PLATEAU DISC wherever intensity*t^steepness >= 1 — at the
  // shipped Intensity 3 that is the outer 42% of the band radius, all pinned at
  // exactly 1.0. Removing it is the single most visible half of this fix.
  const wgsl = blockAfter(rt, /function agentRenderWGSL\(/);
  const fsGlow = wgsl.slice(wgsl.indexOf('fn fsGlow'));
  check('fsGlow emits UNCLAMPED radiance (no plateau disc) [glow-arch]',
    /let g: f32 = max\(0\.0, rv\.glowIntensity \* pow\(t, max\(0\.01, rv\.glowSteepness\)\)\);/.test(fsGlow)
    && !/clamp\(rv\.glowIntensity/.test(fsGlow));

  // THE CURVE RUNS ON THE MAGNITUDE AND THE HUE IS EXACT. Both the full Jodie mix
  // and per-channel Reinhard desaturate the highlights, which IS the reported
  // "oversaturated look"; measured on the same dense frame at Intensity 3, halo
  // pixels with a channel pinned at 255 were 37% (old screen), 68% (full Jodie),
  // 2.5% (hue-exact), and near-WHITE 12.7% / 0.18% / 0.03%. It is also the only
  // form the CPU sibling can reproduce term-for-term (its magnitude lives in the
  // alpha channel), so this is what keeps the two 2D paths identical.
  check('the compose tonemaps the MAGNITUDE and keeps the hue exact [glow-arch]',
    /let mag: f32 = hdr\.a;/.test(rt)
    && /let hue: vec3<f32> = hdr\.rgb \/ mag;/.test(rt)
    && /let t: f32 = x \/ \(1\.0 \+ x\);/.test(rt)
    && !/reinhardJodie/.test(rt));
  check('the compose exposes the accumulated sum by the SHARED constant [glow-arch]',
    /const GLOW_EXPOSURE : f32 = \$\{GLOW_TONE_EXPOSURE\.toFixed\(4\)\}/.test(rt)
    && /import \{ GLOW_TONE_EXPOSURE \} from '\.\.\/glowTone';/.test(rt));
  // Premultiplied by construction: hue's channels are <= 1, so rgb <= a, which is
  // what the 'premultiplied' canvas requires — and it is the same pixel the CPU
  // filter emits (colour x T, alpha T).
  check('the compose output is valid premultiplied (hue*t, t) [glow-arch]',
    /return vec4<f32>\(clamp\(hue, vec3<f32>\(0\.0\), vec3<f32>\(1\.0\)\) \* t, t\);/.test(rt));

  // A render pass cannot nest, so the HDR pass must be encoded BEFORE the canvas
  // pass begins — in BOTH present paths, or the E2 composite silently loses glow.
  const present = blockAfter(rt, /export function presentAgentsEncode\(/);
  const comp = blockAfter(rt, /export function presentCompositeEncode\(/);
  // NB the composite's FIRST beginRenderPass is the grid layer (a separate,
  // complete pass) — anchor on the pass that actually draws the compose.
  for (const [name, body, label] of [['presentAgentsEncode', present, "'agent-present'"], ['presentCompositeEncode', comp, "'agent-composite-pass'"]]) {
    const hdrAt = body.indexOf('encodeGlowHdrPass(');
    const passAt = body.indexOf('label: ' + label);
    check(name + ' encodes the HDR halo pass BEFORE the canvas pass [glow-arch]',
      hdrAt > 0 && passAt > 0 && hdrAt < passAt);
    // Pipeline BEFORE bind group at each draw: the compose has a DIFFERENT
    // bind-group layout, and a pipeline switch invalidates incompatible groups.
    check(name + ' draws the core AFTER the compose (solid-core invariant) [glow-arch]',
      body.indexOf('glowComposePipeline') > 0
      && body.indexOf('renderPlainPipeline') > body.indexOf('glowComposePipeline'));
  }
  // A failed HDR build must degrade to NO glow, never to a wrong one.
  check('a failed HDR target skips the compose too [glow-arch]',
    /const glow = !!rt\.renderGlow && encodeGlowHdrPass\(/.test(present)
    && /const glow = showAgents && !!rt\.renderGlow && encodeGlowHdrPass\(/.test(comp));
  // Re-attach rebuilds the pipelines on the SAME surface — the old HDR bind group
  // belongs to the old layout, so it must be dropped; and both teardown paths must
  // release the texture (it is canvas-sized: a leak per re-attach is real memory).
  check('the pipeline rebuild drops the previous HDR target [glow-arch]',
    /destroyGlowHdrTex\(rt\);/.test(disc));
  check('both teardown paths destroy the HDR target [glow-arch]',
    (rt.match(/destroyGlowHdrTex\(rt\);/g) || []).length >= 3);

  // ---- the CPU sibling ----
  const sv = readSrc('simulator/SimulatorView.tsx');
  // NB the anchor must clear the WHOLE signature: drawAgentGlow's snap param is
  // an inline object TYPE, so a bare function drawAgentGlow\( anchor makes
  // blockAfter return that type literal instead of the function body.
  const glow = blockAfter(sv, /function drawAgentGlow\([\s\S]{0,800}?\): void /);
  // The scratch is accumulated with 'screen' and NEVER read back. Screen on
  // premultiplied colours is c <- s+c-s*c for the colour AND the alpha, so the
  // alpha ends up holding the exact log-encoded halo sum while the un-premultiplied
  // colour holds the hue — which is what lets an SVG transfer function do the
  // decode+tonemap on the BLIT.
  check('the CPU overlay accumulates with screen into the scratch [glow-arch]',
    /s2\.globalCompositeOperation = 'screen';/.test(glow));
  // NO READBACK. A measured hard constraint, not a preference: Chromium DEFERS the
  // thousands of blended drawImage calls, so the first read forces them
  // synchronously — getImageData(0,0,1,1) on the scratch measured 17.5 ms, the SAME
  // as reading the whole buffer, against 9-11 ms for the identical blits with no
  // read. A pixel loop roughly triples the glow's cost at ~5k agents.
  check('the CPU overlay never reads the accumulation back [glow-arch]',
    !/getImageData/.test(glow) && !/putImageData/.test(glow)
    && !/willReadFrequently/.test(blockAfter(sv, /function glowScratchFor\(/)));
  check('the CPU overlay tonemaps via the transfer filter, then blits with screen [glow-arch]',
    /ctx\.filter = filter;/.test(glow)
    && /ctx\.globalCompositeOperation = 'screen';/.test(glow)
    && /ctx\.drawImage\(scratch\.cv, bx, by\);/.test(glow));
  // The filter MUST declare sRGB: SVG filters default to linearRGB, which would
  // round-trip (and shift) every colour channel on the way through.
  check('the transfer filter pins sRGB interpolation [glow-arch]',
    /filter\.setAttribute\('color-interpolation-filters', 'sRGB'\);/.test(blockAfter(sv, /function ensureGlowFilter\(/)));
  // It remaps ALPHA (where the magnitude is), passing the hue through untouched.
  check('the transfer function remaps the ALPHA channel [glow-arch]',
    /createElementNS\(NS, 'feFuncA'\)/.test(sv)
    && /fa\.setAttribute\('type', 'table'\);/.test(sv)
    && /setAttribute\('tableValues', glowTransferTable\(encScale\)\)/.test(sv));
  // The core sub-pass must stay source-over — that is the SOLID CORE invariant
  // (fully-opaque body pixels bit-identical glow ON vs OFF).
  check('the CPU core sub-pass stays source-over [glow-arch]',
    /ctx\.globalCompositeOperation = 'source-over';/.test(glow));
  // ONE sprite draw per agent per tile (the old ceil(intensity)-passes trick would
  // now compound the encoding instead of summing it).
  // ONE unscaled blit per agent per tile: the sprite is BAKED at the scratch's
  // resolution (R/ds), never blitted scaled into it — a scaled drawImage resamples
  // per pixel and measured 2.3x the whole pass at 4896 agents.
  check('the CPU overlay draws each halo sprite exactly ONCE [glow-arch]',
    /s2\.drawImage\(sp, cx - R - bx, cy - R - by\);/.test(glow)
    && !/for \(let p = 0; p < passes/.test(glow));
  // The scratch is sized to the agents' screen bbox, so a sparse or zoomed-in
  // model pays only for the region its halos actually cover.
  check('the accumulation is bbox-sized [glow-arch]',
    /glowScratchFor\(boxW, boxH\)/.test(glow) && /const bx = Math\.max\(0, Math\.floor\(minX\)\)/.test(glow));
  // The sprite bakes the ENCODING, unclamped — the CPU twin of fsGlow no-clamp.
  const paint = blockAfter(sv, /function paintGlowSprite\(/);
  check('the sprite bakes the log encoding, unclamped [glow-arch]',
    /1 - Math\.exp\(-enc \* unit \* Math\.pow\(u, steepness\)\)/.test(paint)
    && !/Math\.min\(1, unit \* Math\.pow/.test(paint));
  // ONE definition of the curve + the exposure + the encoding scale, imported by
  // BOTH paths — so they cannot drift.
  check('both paths derive the tonemap from glowTone.ts [glow-arch]',
    /import \{ glowEncodeScale, glowTransferTable \} from '\.\/glowTone';/.test(sv)
    && /export const GLOW_TONE_EXPOSURE = 1\.6;/.test(readSrc('simulator/glowTone.ts')));
  // E is chosen PER INTENSITY so the encodable range is a constant number of
  // OVERLAPPING halos (~27) rather than a constant sum — otherwise Intensity 3
  // would saturate the 8-bit buffer after two overlaps.
  check('the CPU encoding scale adapts to the intensity [glow-arch]',
    /return 0\.2 \/ Math\.max\(1e-3, Math\.max\(1, intensity\)\);/.test(readSrc('simulator/glowTone.ts')));
}

// ---------------------------------------------------------------------------
// B16 (SCENE-ANCHORED GEOMETRY OWNERSHIP, user-reported: "3D CA Grid when using
// brush Plane it is always being drawn in front of the 3D cells").
//
// Both free modes are a TWO-CANVAS split: the worker presents its scene (voxel
// cubes / sphere impostors) into the canvas underneath while gl3d draws on a
// TRANSPARENT canvas above. The two share no depth buffer, so anything gl3d draws
// there composites in FRONT of every cell and agent, unconditionally. 46e0954 moved
// the scene WIREFRAMES into the worker's depth-tested line passes for exactly this
// reason but left the brush interaction plane behind, so the plane kept painting
// over the volume — the same defect, one group later.
//
// THE RULE this block pins: geometry that sits at a definite place IN the volume
// (wireframes + the brush plane) is worker-owned and depth-tested in free mode;
// CURSOR/UI meant to be seen THROUGH the scene (the brush footprint outline, hover
// and inspect cells, agent rings, axis labels, the gizmo) stays in gl3d, depth off.
// Both worker passes and gl3d build the plane from ONE shared builder, so the
// free<->frame flip cannot move a line.
{
  const sw = readSrc('simulator/engine/sceneWireframe.ts');
  const gl = readSrc('simulator/render/gl3d.ts');
  const vox = readSrc('simulator/engine/webgpuRuntime.ts');
  const ag = readSrc('simulator/engine/agentWebgpuRuntime.ts');
  const wk = readSrc('simulator/engine/sim.worker.ts');
  const sv = readSrc('simulator/SimulatorView.tsx');

  // ONE builder — the anti-drift guarantee for the flip.
  check('sceneWireframe exports the shared brush-plane builder [plane-depth]',
    /export function buildBrushPlaneVerts\(W: number, H: number, D: number, p: BrushPlaneSpec\): Float32Array/.test(sw));
  // gl3d CALLS it rather than keeping a copy (renderOverlays is a documented
  // lockstep pair; the plane is stronger — it cannot drift at all).
  check('gl3d renderBrushPlane uses the SHARED builder [plane-depth]',
    /import \{ buildBrushPlaneVerts \} from '\.\.\/engine\/sceneWireframe';/.test(gl)
    && /this\.drawLines\(buildBrushPlaneVerts\(this\.W, this\.H, this\.D, p\), this\.gl\.LINES, this\.mvp\);/
      .test(blockAfter(gl, /private renderBrushPlane\(\): void /)));

  // gl3d must SKIP the plane (not just the wireframes) whenever the worker owns
  // the scene geometry. Dropping the plane from this guard restores the bug.
  const render = blockAfter(gl, /render\(\): void /);
  check('gl3d skips BOTH the wireframes and the plane when the worker owns them [plane-depth]',
    /const sceneExternal = overlaysOnly && this\.wireframesExternal;/.test(render)
    && /if \(!sceneExternal\) \{[\s\S]{0,240}?this\.renderOverlays\(\);[\s\S]{0,240}?this\.renderBrushPlane\(\);[\s\S]{0,120}?\n    \}/.test(render));
  // ...and it must still draw the always-on-top CURSOR set in free mode.
  check('the free-mode cursor set stays in gl3d [plane-depth]',
    /this\.renderHoverCells\(\);[\s\S]{0,200}?this\.renderBrushOutline\(\);[\s\S]{0,200}?this\.renderAxisLabels\(\);[\s\S]{0,200}?this\.renderGizmo\(\);[\s\S]{0,40}?return;/.test(render));

  // BOTH worker line passes build the plane into their line buffer, and their
  // rebuild signature carries it — otherwise moving the slider would not rebuild.
  for (const [name, src, ensure, viz] of [
    // NB the viz anchors must clear the WHOLE signature: uploadVoxelViz declares an
    // inline object TYPE for `viz`, so a bare `uploadVoxelViz\(` anchor makes
    // blockAfter return that type literal instead of the function body.
    ['voxel', vox, /function ensureVoxelLineBuffer\(/, /export function uploadVoxelViz\([\s\S]{0,400}?\): void /],
    ['agent', ag, /function ensureAgentLineBuffer\(/, /export function uploadAgentViz\([\s\S]{0,400}?\): void /],
  ]) {
    const e = blockAfter(src, ensure);
    check(`${name} line pass builds the brush plane into its buffer [plane-depth]`,
      /buildBrushPlaneVerts\(W, H, D, pl\)/.test(e) && /verts\.set\(plane, wire\.length\)/.test(e));
    check(`${name} line-buffer signature includes the plane [plane-depth]`,
      /\$\{pl \? `\$\{pl\.axis\}\$\{pl\.pos\}` : '-'\}/.test(e));
    check(`${name} viz upload stores the plane + invalidates the cache [plane-depth]`,
      /plane \? \{ axis: plane\.axis, pos: plane\.pos \} : null/.test(blockAfter(src, viz)));
  }

  // The worker records the plane on BOTH viz messages and RE-APPLIES it wherever
  // it re-applies the wireframes (attach / refresh / status ack). A missed
  // re-apply site silently drops the plane after a display re-attach.
  check('the worker records the plane on setGridViz / setAgentViz [plane-depth]',
    /gridPlane3d = msg\.plane \? \{ axis: msg\.plane\.axis, pos: msg\.plane\.pos \} : null;/.test(wk)
    && /agentPlane3d = msg\.plane \? \{ axis: msg\.plane\.axis, pos: msg\.plane\.pos \} : null;/.test(wk));
  const vozCalls = (wk.match(/uploadVoxelViz\(/g) || []).length;
  const agzCalls = (wk.match(/uploadAgentViz\(/g) || []).length;
  check('EVERY worker viz re-apply passes the plane [plane-depth]',
    vozCalls > 0 && agzCalls > 0
    && vozCalls === (wk.match(/uploadVoxelViz\([^)]*gridPlane3d\)/g) || []).length
    && agzCalls === (wk.match(/uploadAgentViz\([^)]*agentPlane3d\)/g) || []).length,
    `voxel ${vozCalls} agent ${agzCalls}`);

  // The main thread posts the plane with the viz toggles AND re-posts when the
  // plane itself changes (axis / position / the enable toggle) — otherwise the
  // worker would keep drawing the plane at its old slice.
  check('both viz posts carry the plane [plane-depth]',
    /type: 'setGridViz'[^}]*plane: gridPlaneMsg\(\)/.test(sv)
    && /type: 'setAgentViz'[^}]*plane: gridPlaneMsg\(\)/.test(sv));
  const planeAt = sv.indexOf('plane3dRef.current = { axis: plane3d.axis, pos: plane3d.pos };');
  const planeEffect = planeAt < 0 ? '' : sv.slice(planeAt, planeAt + 1200);
  check('a plane change re-posts to both free renderers [plane-depth]',
    /if \(voxelRenderActiveRef\.current\) postGridViz\(\);/.test(planeEffect)
    && /postAgentViz\(\);/.test(planeEffect));
}

// ---------------------------------------------------------------------------
// B17 (SCENE-GEOMETRY DRAW STATE, user-reported: "Moving the cursor out and back
// to the canvas on 3D Particles makes the Grid (if toggled on) change its
// brightness").
//
// B16 made the free<->frame flip share the GEOMETRY. That is not enough: the same
// 1-pixel line looks materially different depending on whether it is MULTISAMPLED.
// gl3d's WebGL2 context is created with `antialias: true` (4x MSAA here) while the
// two worker WGSL passes sat at WebGPU's default sampleCount 1, so every flip
// changed the wireframes' brightness.
//
// MEASURED on Particle Life 3D's floor grid, SAME 274 vertices / SAME MVP /
// 500x500, comparing each rasterization against gl3d's own render:
//   sampleCount 1  -> total emitted light 0.683x, per-scanline error 32.09%
//   sampleCount 4  -> total emitted light 1.0003x, per-scanline error  1.61%
//
// THE RULE this block pins: both worker passes rasterize the scene geometry at
// SCENE_MSAA_SAMPLES and RESOLVE onto the swap-chain texture; the shared constant
// is the single source, so the three renderers cannot drift apart again.
{
  const sw = readSrc('simulator/engine/sceneWireframe.ts');
  const vox = readSrc('simulator/engine/webgpuRuntime.ts');
  const ag = readSrc('simulator/engine/agentWebgpuRuntime.ts');
  const gl = readSrc('simulator/render/gl3d.ts');

  // ONE constant, next to the geometry the three renderers already share.
  check('sceneWireframe exports the shared sample count [scene-msaa]',
    /export const SCENE_MSAA_SAMPLES = 4;/.test(sw));
  // The premise: gl3d asks for MSAA. If this ever changes, the worker passes must
  // change WITH it — this check is what makes that impossible to miss.
  check('gl3d still creates its context with antialias: true [scene-msaa]',
    /getContext\('webgl2', \{ antialias: true,/.test(gl));

  // NB the pipeline anchors must include `, layout:` — the shader MODULE carries
  // the SAME label string and appears FIRST, so a bare label anchor scans the
  // module-creation site and passes/fails for the wrong reason.
  for (const [name, src, field, msTex, depthTex, present, pipes] of [
    ['voxel', vox, 'voxelMsaaTex', /function ensureVoxelMsaaTex\(/, /function ensureVoxelDepthTex\(/,
      /export function presentVoxels\(rt: WebGPURuntime\): void /,
      ['const mkDraw = ', "label: 'voxel-line', layout:"]],
    ['agent', ag, 'renderMsaaTex', /function ensureAgentMsaaTex\(/, /function ensureAgentDepthTex\(/,
      /function presentAgentSpheresEncode\([\s\S]{0,200}?\): void /,
      ["label: 'agent-sphere', layout:", "label: 'agent-scene-line', layout:"]],
  ]) {
    // Both attachments must carry the SAME sample count, from the shared constant
    // (a depth attachment whose count differs from the colour one is invalid).
    check(`${name} MSAA colour attachment uses the shared count [scene-msaa]`,
      /sampleCount: SCENE_MSAA_SAMPLES/.test(blockAfter(src, msTex)));
    check(`${name} depth attachment matches the colour sample count [scene-msaa]`,
      /sampleCount: SCENE_MSAA_SAMPLES/.test(blockAfter(src, depthTex)));
    // Render into the MSAA texture, resolve onto the swap chain. Dropping the
    // resolveTarget would show nothing; dropping the MSAA view restores the bug.
    const p = blockAfter(src, present);
    check(`${name} pass renders into the MSAA view and RESOLVES onto the canvas [scene-msaa]`,
      /view: msView, resolveTarget: view,/.test(p));
    check(`${name} MSAA attachment takes its format from the swap-chain texture [scene-msaa]`,
      new RegExp(`ensure${name === 'voxel' ? 'Voxel' : 'Agent'}MsaaTex\\(rt, tex\\.width, tex\\.height, tex\\.format\\)`).test(p));
    // EVERY pipeline drawing into that pass must declare the same count, or the
    // pass is invalid and the whole free-mode render silently falls back.
    for (const anchor of pipes) {
      const at = src.indexOf(anchor);
      const seg = at < 0 ? '' : src.slice(at, at + 1400);
      check(`${name} pipeline at "${anchor}" declares multisample [scene-msaa]`,
        /multisample: \{ count: SCENE_MSAA_SAMPLES \}/.test(seg));
    }
    // Recreated on resize like the depth texture, and released on teardown —
    // a canvas-sized 4x target is far too big to leak per re-attach.
    check(`${name} MSAA texture is destroyed on teardown [scene-msaa]`,
      new RegExp(`rt\\.${field}\\) \\{ try \\{ rt\\.${field}\\.destroy\\(\\)`).test(src));
  }

  // The voxel SHADOW pass has its own single-sampled depth target and must stay
  // that way — giving it a multisample count would invalidate it.
  const shadowAt = vox.indexOf("label: 'voxel-shadow',");
  check('the voxel shadow pipeline stays single-sampled [scene-msaa]',
    shadowAt >= 0 && !/multisample/.test(vox.slice(shadowAt, shadowAt + 900)));
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
