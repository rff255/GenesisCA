// Set Agent Sprite on the WebGPU agent target — verification.
//
// The last agent-target node gap: `setAgentSprite` wrote five buffers with no GPU
// mirror, so a sprite-driving BEHAVIOUR graph clamped a WebGPU-target model to JS.
// The five runs now live in `agentF32` (AGENT_GPU_SPRITE_FIELDS, appended LAST and
// reserved on the C9 `sprites` gate), so the node emits like any other setter.
//
// Tiers:
//   A  LAYOUT      — reserved iff the gate is on, appended last (no base moves),
//                    exact size, and the layout is untouched for a sprite-free model.
//   B  GATE        — isAgentGraphWebGPUSupported accepts a sprite behaviour; the
//                    diagnosis no longer names the node.
//   C  EMIT        — every facet writes its run, the target/guard shape mirrors
//                    JS/WASM, vector rotation uses atan2 with the zero guard, the
//                    alpha facet is a packed read-modify-write, and `usesSpriteWrite`
//                    is set by a SPRITE-run write only (never by alpha alone).
//   D  SAFETY      — the C9 catch: compiled against a gate-OFF layout every sprite
//                    facet is dropped while the alpha facet survives.
//   E  OM SCOPE    — an Agent Output Mapping containing the node keeps `omSupported
//                    false` (today's CPU-overlay semantics), never the behaviour verdict.
//   F  RESIDENCY   — a sprite-writing behaviour reports the `sprites` blocker.
//   G  RUNTIME     — source invariants pinning the seed + readback + read-plan trio
//                    (they must move together or the readback wipes the CPU state).
//
// Real-GPU compilation + a running sprite model are verified in the browser.
// Run from the repo root:  node scripts/test-agent-sprite-webgpu.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileAgentGraphWebGPUForModel, compileAgentGraphWebGPU, isAgentGraphWebGPUSupported, agentWebGPUExtrasOf } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { computeAgentWebGPULayout, AGENT_GPU_SPRITE_FIELDS } from '../src/modeler/vpl/compiler/agentWebgpu/layout.ts';
export { resolveAgentFieldGates } from '../src/model/agentFieldGating.ts';
export { residencyModelBlockers } from '../src/model/agentResidency.ts';
export { diagnoseTargets } from '../src/model/targetDiagnosis.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-sprite-'));
const entryPath = join(ROOT, 'scripts', '__sprite_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

const SPRITE_FIELDS = M.AGENT_GPU_SPRITE_FIELDS;

const mkG = () => {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const nodes = [], edges = [];
  const n = (t, c = {}) => { const x = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; nodes.push(x); return x; };
  const v = (s, sp, t, tp) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
  const f = (s, sp, t, tp) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });
  return { nodes, edges, n, v, f };
};

const SPRITE_ASSET = { id: 'sp1', name: 'bird', dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png' };

/** A minimal agents-only 2D model on the WebGPU agent target. `sprites` controls
 *  whether the model carries a sprite ASSET (the other half of the C9 gate). */
const shell = (g, { sprites = true, agentMappings = [] } = {}) => M.migrateForHarness({
  schemaVersion: 1,
  properties: { name: 'SpriteProbe', dimension: '2d', gridWidth: 24, gridHeight: 24, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
  topologyMode: { gridCells: false, agents: true },
  centerBased: {
    enabled: true, maxAgents: 100, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 20, seedPattern: 'scatter',
    defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5,
    drag: 1, timeStep: 0.1, momentum: 0.9, maxSpeed: 0, neighbourQueryRadius: 8,
    useBondingPhysics: false, autoBond: false, agentTarget: 'webgpu', agentUpdateMode: 'async',
    agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: true, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true },
  },
  attributes: [], modelAttributes: [], neighborhoods: [],
  agentAttributes: [{ id: 'sig', name: 'Sig', type: 'float', defaultValue: '0' }],
  variables: [], agentVariables: [], indicators: [], mappings: [], agentMappings,
  sprites: sprites ? [SPRITE_ASSET] : [],
  graphNodes: [], graphEdges: [], agentGraphNodes: g.nodes, agentGraphEdges: g.edges, macroDefs: [],
});

const ALL_FACETS = {
  spriteId: 'sp1', _spriteSlot: 1,
  setSprite: true, setFrame: true, setSpeed: true, setRotation: true, rotationMode: 'angle', setScale: true, setAlpha: true,
  _port_frame: '3', _port_speed: '0.5', _port_rotation: '90', _port_dirX: '0', _port_dirY: '0', _port_scale: '2', _port_alpha: '128',
};

/** A behaviour graph: Behaviour Step → Set Agent Sprite (given config). */
const spriteModel = (cfg, opts = {}) => {
  const g = mkG();
  const bs = g.n('behaviourStep');
  const sas = g.n('setAgentSprite', cfg);
  g.f(bs, 'do', sas, 'do');
  if (opts.byHandle) {
    // Wire a Create Agent handle (the spawn-configuration shape) so the emitter
    // takes the WIRED branch with its range-only guard.
    const create = g.n('createAgent', { _port_x: '1', _port_y: '1', _port_radius: '0.5' });
    const add = g.n('addAgentToWorld');
    g.f(bs, 'do', create, 'do');   // fan-out: both hang off the root
    g.f(create, 'next', add, 'do');
    g.v(create, 'handle', add, 'handle');
    g.v(create, 'handle', sas, 'agentId');
  }
  return { g, model: shell(g, opts) };
};

// ---------------------------------------------------------------------------
// A — layout
// ---------------------------------------------------------------------------
console.log('\nA — layout');
{
  const off = M.computeAgentWebGPULayout(64, 16, undefined, ['sig'], { gridDepth: 1 });
  const on = M.computeAgentWebGPULayout(64, 16, undefined, ['sig'], { gridDepth: 1, sprites: true });
  check('gate off → no sprite runs reserved', off.spritesReserved === false
    && SPRITE_FIELDS.every(f => off.f32Base[f] === undefined));
  check('gate on → all five runs reserved', on.spritesReserved === true
    && SPRITE_FIELDS.every(f => typeof on.f32Base[f] === 'number'));
  // APPENDED LAST — the reason a sprite model moves no base an existing shader baked.
  const moved = Object.keys(off.f32Base).filter(k => off.f32Base[k] !== on.f32Base[k]);
  check('every pre-existing f32 base is unchanged', moved.length === 0, `moved: ${moved.join(', ')}`);
  check('sprite runs start at the old f32Len', Math.min(...SPRITE_FIELDS.map(f => on.f32Base[f])) === off.f32Len);
  check('f32Len grows by exactly 5 × maxAgents', on.f32Len - off.f32Len === 5 * 64,
    `${off.f32Len} -> ${on.f32Len}`);
  const bases = SPRITE_FIELDS.map(f => on.f32Base[f]);
  check('the five runs are contiguous and distinct', new Set(bases).size === 5
    && bases.every((b, i) => i === 0 || b === bases[i - 1] + 64));
  // The absent-extras default must be OFF (this file's convention), so the callers
  // that pass no extras (the render-only layout, the worker fallback) are unchanged.
  check('absent `sprites` extra ⇒ off', M.computeAgentWebGPULayout(64, 16).spritesReserved === false);
}

// ---------------------------------------------------------------------------
// B — the gate
// ---------------------------------------------------------------------------
console.log('\nB — gate + diagnosis');
{
  const { model } = spriteModel(ALL_FACETS);
  check('C9 sprites gate is on for a sprite behaviour', M.resolveAgentFieldGates(model).sprites === true);
  check('agentWebGPUExtrasOf passes the gate through', M.agentWebGPUExtrasOf(model).sprites === true);
  check('isAgentGraphWebGPUSupported accepts it', M.isAgentGraphWebGPUSupported(model) === true);
  const r = M.compileAgentGraphWebGPUForModel(model);
  check('it compiles with no error', !r.error && r.shaderCode.length > 0, r.error || '');
  const ag = M.diagnoseTargets(model).layers.find(l => l.layer === 'agents');
  const gpu = ag?.verdicts?.find(v => v.engine === 'webgpu');
  check('the WebGPU agent verdict is OK', gpu?.ok === true);
  check('no blocker names setAgentSprite',
    !(gpu?.blockers ?? []).some(b => /setAgentSprite/.test(b.text)),
    JSON.stringify(gpu?.blockers ?? []));
}

// ---------------------------------------------------------------------------
// C — the emit
// ---------------------------------------------------------------------------
console.log('\nC — emit');
const shaderOf = (cfg, opts = {}) => {
  const { model } = spriteModel(cfg, opts);
  const r = M.compileAgentGraphWebGPUForModel(model);
  if (r.error) throw new Error(r.error);
  return { code: r.shaderCode, layout: r.layout, result: r };
};
const runWrites = (code, layout, field) => {
  const base = layout.f32Base[field];
  if (base === undefined) return [];
  return code.split('\n').filter(l => l.includes(`agentF32[${base}u + `) && l.includes('='));
};
{
  const { code, layout, result } = shaderOf(ALL_FACETS);
  check('setSprite writes the baked slot into spriteIds',
    runWrites(code, layout, 'spriteIds').some(l => /=\s*1(\.0)?;/.test(l)));
  check('setFrame writes spriteFrames', runWrites(code, layout, 'spriteFrames').length === 1);
  check('setSpeed writes spriteSpeeds', runWrites(code, layout, 'spriteSpeeds').length === 1);
  check('setRotation (angle) writes spriteRotations', runWrites(code, layout, 'spriteRotations').length === 1);
  check('setScale writes spriteScales', runWrites(code, layout, 'spriteScales').length === 1);
  check('setAlpha is a packed read-modify-write of agentColors',
    /agentColors\[idx\] = \(agentColors\[idx\] & 0x00ffffffu\) \| \(u32\(.+\) << 24u\);/.test(code));
  check('the alpha value is clamped to [0,255]', /clamp\(.+, 0, 255\)/.test(code));
  check('usesSpriteWrite is set', result.usesSpriteWrite === true);
  // UNWIRED target = the current-loop agent, UNGUARDED (the entry point already
  // returned for a dead / out-of-range invocation), exactly like JS/WASM.
  check('unwired target uses idx with no maxAgents guard',
    runWrites(code, layout, 'spriteIds').every(l => l.includes('+ idx]'))
    && !/control\.maxAgents/.test(code));
}
{
  // Vector rotation — atan2(dx, -dy) in degrees, zero vector leaves it untouched.
  const { code, layout } = shaderOf({ ...ALL_FACETS, rotationMode: 'vector', _port_dirX: '1', _port_dirY: '0' });
  const rot = runWrites(code, layout, 'spriteRotations');
  check('vector rotation emits atan2', rot.length === 1 && /atan2\(/.test(rot[0]));
  check('vector rotation converts to degrees', rot.length === 1 && /180\.0 \/ 3\.14159/.test(rot[0]));
  check('vector rotation negates dy (compass, 0 = up)', rot.length === 1 && /atan2\(.+, -\(.+\)\)/.test(rot[0]));
  check('vector rotation is guarded on a non-zero vector',
    rot.length === 1 && /if \(.+ != 0\.0 \|\| .+ != 0\.0\) \{/.test(rot[0]));
  check('the angle input is not read in vector mode', !/_sasRo/.test(code));
}
{
  // WIRED target (a Create Agent handle) — the RANGE-ONLY guard the other by-id
  // setters use, so a staged (alive = 0) newborn can be configured on its handle.
  const { code, layout } = shaderOf(ALL_FACETS, { byHandle: true });
  const w = runWrites(code, layout, 'spriteIds');
  check('wired target is range-guarded on control.maxAgents',
    /if \(.+ >= 0 && .+ < i32\(control\.maxAgents\)\) \{ let .+: u32 =/.test(code));
  check('wired target does NOT check agentAlive', !/agentAlive\[.*sas/.test(code));
  check('wired writes go through the guarded index, not idx',
    w.length === 1 && !w[0].includes('+ idx]'));
}
{
  // Facet independence: only ticked facets write, and alpha ALONE does not turn the
  // sprite round-trip on (it writes agentColors, which every path already carries).
  const { code, layout, result } = shaderOf({ ...ALL_FACETS, setSprite: false, setFrame: false, setSpeed: true, setRotation: false, setScale: false, setAlpha: false });
  check('untouched facets emit nothing',
    runWrites(code, layout, 'spriteIds').length === 0
    && runWrites(code, layout, 'spriteFrames').length === 0
    && runWrites(code, layout, 'spriteRotations').length === 0
    && runWrites(code, layout, 'spriteScales').length === 0
    && runWrites(code, layout, 'spriteSpeeds').length === 1);
  check('a sprite-run write sets usesSpriteWrite', result.usesSpriteWrite === true);
}
{
  const { code, layout, result } = shaderOf({ ...ALL_FACETS, setSprite: false, setFrame: false, setSpeed: false, setRotation: false, setScale: false, setAlpha: true });
  check('alpha-only writes agentColors', /agentColors\[idx\] = \(agentColors\[idx\]/.test(code));
  check('alpha-only writes no sprite run',
    SPRITE_FIELDS.every(f => runWrites(code, layout, f).length === 0));
  check('alpha-only does NOT set usesSpriteWrite', result.usesSpriteWrite === false);
}

// ---------------------------------------------------------------------------
// D — the C9 safety catch (compiled against a gate-OFF layout)
// ---------------------------------------------------------------------------
console.log('\nD — C9 safety catch');
{
  const { model } = spriteModel(ALL_FACETS);
  // Deliberately build the layout WITHOUT the sprite runs (the shape a gated-off
  // model has) and compile the same graph against it — the PX negative-control
  // pattern. Every sprite facet must be dropped; the alpha facet must survive.
  const off = M.computeAgentWebGPULayout(100, 16, undefined, ['sig'], { gridDepth: 1 });
  const r = M.compileAgentGraphWebGPU(model.agentGraphNodes, model.agentGraphEdges, model, off);
  check('gate-off layout still compiles', !r.error, r.error || '');
  check('gate-off drops every sprite facet', r.usesSpriteWrite === false);
  check('gate-off emits no sprite-run write',
    SPRITE_FIELDS.every(f => off.f32Base[f] === undefined) && !/spriteIds/.test(r.shaderCode));
  check('the ALPHA facet survives the gate (it writes agentColors)',
    /agentColors\[idx\] = \(agentColors\[idx\]/.test(r.shaderCode));
}

// ---------------------------------------------------------------------------
// E — Agent Output Mapping scope
// ---------------------------------------------------------------------------
console.log('\nE — OM scope');
{
  // An OM that colours + sets a sprite. The OM module is dispatched ONLY inside the
  // resident batch while every other path colours through the CPU pass, so the node
  // stays CPU-side there: omSupported false (today's semantics), behaviour untouched.
  const g = mkG();
  const bs = g.n('behaviourStep');
  const nop = g.n('setAttribute', { attributeId: 'sig', _port_value: '1' });
  g.f(bs, 'do', nop, 'do');
  const om = g.n('agentOutputMapping', { mappingId: 'am1' });
  const looks = g.n('setCellLooks', { mappingId: 'am1', _port_r: '10', _port_g: '20', _port_b: '30' });
  const sas = g.n('setAgentSprite', ALL_FACETS);
  g.f(om, 'do', looks, 'do'); g.f(looks, 'next', sas, 'do');
  const model = shell(g, { agentMappings: [{ id: 'am1', name: 'View', isAttributeToColor: true, linked: false }] });
  const r = M.compileAgentGraphWebGPUForModel(model);
  check('the BEHAVIOUR verdict is unaffected', M.isAgentGraphWebGPUSupported(model) === true && !r.error);
  check('an OM containing Set Agent Sprite keeps omSupported false', r.omSupported === false);
  check('…and ships no OM shaders', (r.omShaders ?? []).length === 0);
  // Control: the SAME OM without the sprite node DOES compile to a GPU colour pass.
  const g2 = mkG();
  const bs2 = g2.n('behaviourStep');
  const nop2 = g2.n('setAttribute', { attributeId: 'sig', _port_value: '1' });
  g2.f(bs2, 'do', nop2, 'do');
  const om2 = g2.n('agentOutputMapping', { mappingId: 'am1' });
  const looks2 = g2.n('setCellLooks', { mappingId: 'am1', _port_r: '10', _port_g: '20', _port_b: '30' });
  g2.f(om2, 'do', looks2, 'do');
  const m2 = shell(g2, { sprites: false, agentMappings: [{ id: 'am1', name: 'View', isAttributeToColor: true, linked: false }] });
  const r2 = M.compileAgentGraphWebGPUForModel(m2);
  check('NEG: the same OM without the sprite node DOES compile', r2.omSupported === true && (r2.omShaders ?? []).length === 1);
}

// ---------------------------------------------------------------------------
// F — residency
// ---------------------------------------------------------------------------
console.log('\nF — residency');
{
  const baseFacts = {
    residencyClean: true, usesField: false, hasAgentAccessibleField: false,
    usesSpawn: false, usesStop: false, usesIndicators: false, hasStopMessages: false, bondSlots: 0,
  };
  // The SAME config a residency-eligible model carries (the shell's) — a bare
  // object would fall through to the legacy `usesBondingPhysics` defaults and
  // report unrelated blockers.
  const cfg = spriteModel(ALL_FACETS).model.centerBased;
  check('no sprite write ⇒ residency-eligible',
    M.residencyModelBlockers(cfg, baseFacts).length === 0);
  const b = M.residencyModelBlockers(cfg, { ...baseFacts, usesSpriteWrite: true });
  check('a sprite-writing behaviour reports the `sprites` blocker',
    b.length === 1 && b[0].key === 'sprites', JSON.stringify(b));
  check('the blocker names the per-generation CPU frame advance', /sprite frames on the CPU/.test(b[0]?.text ?? ''));
  // The model-derived readout (targetDiagnosis) must agree with the compiler flag.
  const { model } = spriteModel(ALL_FACETS);
  const ag = M.diagnoseTargets(model).layers.find(l => l.layer === 'agents');
  const gpu = ag?.verdicts?.find(v => v.engine === 'webgpu');
  check('the Compatibility readout carries the residency note',
    (gpu?.notes ?? []).some(n => /sets agent sprites/.test(n.text)),
    JSON.stringify(gpu?.notes ?? []));
}

// ---------------------------------------------------------------------------
// G — runtime source invariants (the seed / readback / plan trio)
// ---------------------------------------------------------------------------
console.log('\nG — runtime source invariants');
{
  const src = readFileSync(join(ROOT, 'src', 'simulator', 'engine', 'agentWebgpuRuntime.ts'), 'utf8');
  check('ONE predicate gates the round-trip', /function spriteRunsActive\(/.test(src));
  check('…and it requires BOTH the compile flag and the reserved runs',
    /rt\.usesSpriteWrite && rt\.layout\.spritesReserved/.test(src));
  check('the read PLAN covers the sprite runs under that predicate',
    /if \(spriteRunsActive\(rt\)\) for \(const field of AGENT_GPU_SPRITE_FIELDS\) add\(/.test(src));
  const seeds = (src.match(/spriteRunsActive\(rt\)/g) ?? []).length;
  // plan + upload fill + upload writeBuffer + readbackAgentStep + newborn overlay +
  // readbackAgentFrame = 6. Fewer means one half of the pair went missing, which is
  // exactly the failure that clobbers the CPU sprite ids with zeros.
  check('every seed/readback site is gated by it (6 sites)', seeds === 6, `found ${seeds}`);
  check('the upload seeds from the CPU store', /spriteSrc: Record<string, ArrayLike<number>>/.test(src));
  check('the runtime records the compile flag', /usesSpriteWrite: !!usage\.usesSpriteWrite && layout\.spritesReserved/.test(src));
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
