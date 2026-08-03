// C2 (P3) — GENERATION PIPELINE drift guard.
//
// `describeGenerationPipeline(model)` is a DESCRIPTION of the engine's
// per-generation loop. A description can drift from the thing it describes, so
// this harness pins both halves of the contract:
//
//   1. ACTIVITY ⇔ RESOLVER. Over a matrix of synthetic configs (bonding on/off ×
//      collision off/soft/positional × growth × charge × sparse × sync/async on
//      BOTH layers × agents-only / grid-only / both), the harness independently
//      calls the SAME resolvers the engine calls and asserts each phase's
//      `active` bit equals them. A drift in EITHER direction fails.
//   2. PHASE ORDER against a hard-coded expectation list — so reordering the
//      loop description is a conscious, test-visible edit.
//   3. SHIPPED MODELS — every public/models/*.gcaproj produces a pipeline, plus
//      per-model spot assertions for the five verification models.
//   4. NEGATIVE CONTROLS — deliberately wrong expectations that MUST be caught,
//      proving the harness can fail (a test that only ever passes proves nothing).
//
// Run from the repo root:  node scripts/test-generation-pipeline.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { describeGenerationPipeline, describePipelineGroups, integrationFormula, PRESENTATION_PHASE_IDS } from '../src/model/generationPipeline.ts';
export {
  cbNum, effectiveAgentDt, layoutIterationsOf, resolveMaxBonds,
  usesCharge, chargeParamsOf, usesEngineGrowth, usesEngineSprings,
  usesPositionalCollision, usesSoftCollision, usesBondingPhysics,
} from '../src/model/centerBased.ts';
export { agentGraphUsesBondRequests } from '../src/modeler/vpl/compiler/bondRequestQueue.ts';
export { dividePartitionTableForModel } from '../src/modeler/vpl/compiler/dividePartition.ts';
export { sparseSteppingEnabled } from '../src/modeler/vpl/compiler/sparseStepping.ts';
export { EMPTY_MODEL } from '../src/model/defaultModel.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-pipeline-'));
const entryPath = join(ROOT, 'scripts', '__pipeline_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = (t) => console.log('\n' + t);

const byId = (phases) => Object.fromEntries(phases.map(p => [p.id, p]));
const activeOf = (phases, id) => byId(phases)[id]?.active;

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------

const node = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });

function baseModel(over = {}) {
  return {
    ...structuredClone(M.EMPTY_MODEL),
    topologyMode: { gridCells: true, agents: false },
    graphNodes: [node('s1', 'step')],
    graphEdges: [],
    agentGraphNodes: [],
    agentGraphEdges: [],
    macroDefs: [],
    indicators: [],
    mappings: [],
    ...over,
  };
}

/** An agents model with a configurable capability profile + config. */
function agentModel(caps = {}, cfg = {}, agentNodes = [node('b1', 'behaviourStep')]) {
  return baseModel({
    topologyMode: { gridCells: false, agents: true },
    graphNodes: [],
    agentGraphNodes: agentNodes,
    centerBased: {
      enabled: true, maxAgents: 500, maxBonds: 8,
      worldWidth: 100, worldHeight: 100,
      agentCapabilities: {
        motion: 'force', body: true, collision: 'off', bonds: 'off',
        autoBond: false, growth: false, division: false, lifespan: false,
        populationBirth: false, sensing: false, orientation: false,
        fieldCoupling: false, appearance: false, charge: 'off',
        ...caps,
      },
      ...cfg,
    },
  });
}

// ---------------------------------------------------------------------------
// 1. ACTIVITY ⇔ RESOLVER, over the config matrix
// ---------------------------------------------------------------------------
section('1. Activity bits track the ENGINE resolvers (synthetic config matrix)');

const COLLISIONS = ['off', 'soft', 'positional'];
const BONDS = ['off', 'data', 'physics'];
let matrixCases = 0;

for (const collision of COLLISIONS) {
  for (const bonds of BONDS) {
    for (const growth of [false, true]) {
      for (const charge of ['off', 'on']) {
        for (const autoBond of [false, true]) {
          for (const agentUpdateMode of ['async', 'sync']) {
            for (const growthRate of [0, 0.02]) {
              const m = agentModel(
                { collision, bonds, growth, charge },
                { autoBond, agentUpdateMode, growthRate, layoutIterations: 3 },
              );
              const cfg = m.centerBased;
              const phases = M.describeGenerationPipeline(m);
              matrixCases++;

              // Each assertion re-derives the truth from the ENGINE's OWN resolver.
              eq(activeOf(phases, 'agent.softCollision'), M.usesSoftCollision(cfg),
                `softCollision [${collision}/${bonds}]`);
              eq(activeOf(phases, 'agent.positional'), M.usesPositionalCollision(cfg),
                `positional [${collision}]`);
              eq(activeOf(phases, 'agent.springs'), M.usesEngineSprings(cfg) && M.resolveMaxBonds(cfg) > 0,
                `springs [${bonds}/autoBond=${autoBond}]`);
              eq(activeOf(phases, 'agent.charge'), M.usesCharge(cfg), `charge [${charge}]`);
              eq(activeOf(phases, 'agent.growth'), M.usesEngineGrowth(cfg) && M.cbNum(cfg, 'growthRate') > 0,
                `growth [${growth}/rate=${growthRate}]`);
              eq(activeOf(phases, 'structural.autoBond'),
                M.usesEngineSprings(cfg) && !!cfg.autoBond && M.resolveMaxBonds(cfg) > 0,
                `autoBond [${bonds}/${autoBond}]`);
              eq(activeOf(phases, 'structural.sweep'), M.resolveMaxBonds(cfg) > 0,
                `sweep [${bonds}/autoBond=${autoBond}]`);
              eq(activeOf(phases, 'agent.primeAttrs'), agentUpdateMode === 'sync',
                `primeAttrs [${agentUpdateMode}]`);
              eq(activeOf(phases, 'agent.commitAttrs'), agentUpdateMode === 'sync',
                `commitAttrs [${agentUpdateMode}]`);
              // Always-on engine phases.
              eq(activeOf(phases, 'agent.integrate'), true, 'integrate always active');
              eq(activeOf(phases, 'agent.spatialHash'), true, 'spatial hash always active');
            }
          }
        }
      }
    }
  }
}
console.log(`  (${matrixCases} config combinations)`);

// The force-iteration group header reads the SAME clamped resolver.
for (const layoutIterations of [undefined, 1, 2, 7, 999, -3, 2.7]) {
  const m = agentModel({}, { layoutIterations });
  const groups = M.describePipelineGroups(m);
  const n = M.layoutIterationsOf(m.centerBased);
  ok(groups.forces.detail.includes(String(n)),
    `force group header states ${n} iterations for layoutIterations=${layoutIterations} (got "${groups.forces.detail}")`);
}

// The integration formula carries the EFFECTIVE (clamped) Δt, not the requested one.
{
  const m = agentModel({}, { timeStep: 0.5, repulsionStiffness: 2, bondStiffness: 1.2, momentum: 0.9, maxSpeed: 2, drag: 1 });
  const eff = M.effectiveAgentDt(m.centerBased);
  ok(eff.clamped, 'the Δt fixture is genuinely clamped (0.5 > bound)');
  const f = M.integrationFormula(m.centerBased);
  ok(f.includes('0.9·v'), `formula shows momentum (got "${f}")`);
  ok(f.includes(String(Math.round(eff.dt * 10000) / 10000)), `formula shows the EFFECTIVE Δt ${eff.dt} (got "${f}")`);
  ok(!f.includes('0.5/'), `formula does NOT show the pre-clamp Δt (got "${f}")`);
  ok(f.includes('speed cap 2'), `formula shows the speed cap (got "${f}")`);
  const uncapped = M.integrationFormula({ ...m.centerBased, maxSpeed: 0 });
  ok(uncapped.includes('uncapped'), `maxSpeed 0 reads as uncapped (got "${uncapped}")`);
}

// Structural sub-steps ride the engine's OWN usage gates.
section('   structural sub-steps use the engine usage gates');
{
  const noVerbs = agentModel({ bonds: 'physics' });
  eq(activeOf(M.describeGenerationPipeline(noVerbs), 'structural.drain'),
    M.agentGraphUsesBondRequests(noVerbs), 'drain off with no queue verb');
  eq(M.agentGraphUsesBondRequests(noVerbs), false, 'the no-verb fixture really has no queue verb');

  for (const verb of ['formBond', 'breakBond', 'rewireBond', 'formBondBetween']) {
    const m = agentModel({ bonds: 'physics' }, {}, [node('b1', 'behaviourStep'), node('v1', verb)]);
    eq(activeOf(M.describeGenerationPipeline(m), 'structural.drain'),
      M.agentGraphUsesBondRequests(m), `drain tracks the queue gate for ${verb}`);
    eq(M.agentGraphUsesBondRequests(m), true, `${verb} really arms the queue gate`);
  }

  const noDiv = agentModel({});
  eq(activeOf(M.describeGenerationPipeline(noDiv), 'structural.divide'),
    M.dividePartitionTableForModel(noDiv).length > 0, 'divide off with no Divide Agent node');
  const withDiv = agentModel({}, {}, [node('b1', 'behaviourStep'), node('d1', 'divideAgent')]);
  eq(activeOf(M.describeGenerationPipeline(withDiv), 'structural.divide'),
    M.dividePartitionTableForModel(withDiv).length > 0, 'divide tracks the partition table');
  eq(M.dividePartitionTableForModel(withDiv).length > 0, true, 'the Divide fixture really populates the table');

  const noKill = agentModel({});
  eq(activeOf(M.describeGenerationPipeline(noKill), 'structural.death'), false, 'deaths off with no Kill Agent');
  const withKill = agentModel({}, {}, [node('b1', 'behaviourStep'), node('k1', 'killAgent')]);
  eq(activeOf(M.describeGenerationPipeline(withKill), 'structural.death'), true, 'deaths on with a Kill Agent');

  // Macro-aware: a verb hidden inside a macro definition still counts.
  const macroModel = agentModel({ bonds: 'physics' }, {}, [node('b1', 'behaviourStep'), node('mi', 'macro', { macroDefId: 'md1' })]);
  macroModel.macroDefs = [{ id: 'md1', name: 'm', nodes: [node('inner', 'divideAgent')], edges: [], exposedInputs: [], exposedOutputs: [] }];
  eq(activeOf(M.describeGenerationPipeline(macroModel), 'structural.divide'), true,
    'a Divide Agent inside a macro def is seen (macro-aware scan)');
}

// Cell-layer bits.
section('   cell-layer bits track their resolvers');
for (const updateMode of ['synchronous', 'asynchronous']) {
  for (const sieEnabled of [false, true]) {
    const m = baseModel({
      properties: {
        ...structuredClone(M.EMPTY_MODEL.properties),
        updateMode, asyncScheme: 'random-order',
        skipIsolatedEmpty: sieEnabled
          ? { enabled: true, emptyAttributeId: 'a', emptyValue: '0', rangeKind: 'radius', radius: 1, radiusMetric: 'chebyshev' }
          : undefined,
      },
    });
    const phases = M.describeGenerationPipeline(m);
    eq(activeOf(phases, 'cell.sparse'), M.sparseSteppingEnabled(m), `sparse [${updateMode}/${sieEnabled}]`);
    eq(activeOf(phases, 'cell.swap'), updateMode !== 'asynchronous', `swap [${updateMode}]`);
    eq(activeOf(phases, 'cell.asyncOrder'), updateMode === 'asynchronous', `asyncOrder [${updateMode}]`);
    eq(activeOf(phases, 'cell.step'), true, 'cell step active (a step root is present)');
  }
}
// Sparse is documented as ignored on agent models — the resolver says so; assert
// the panel agrees rather than claiming a speed-up the engine will not take.
{
  const m = baseModel({
    topologyMode: { gridCells: true, agents: true },
    agentGraphNodes: [node('b1', 'behaviourStep')],
    properties: {
      ...structuredClone(M.EMPTY_MODEL.properties),
      updateMode: 'synchronous',
      skipIsolatedEmpty: { enabled: true, emptyAttributeId: 'a', emptyValue: '0', rangeKind: 'radius', radius: 1, radiusMetric: 'chebyshev' },
    },
  });
  eq(activeOf(M.describeGenerationPipeline(m), 'cell.sparse'), M.sparseSteppingEnabled(m),
    'sparse OFF on an agent model (the documented exclusion)');
  eq(M.sparseSteppingEnabled(m), false, 'the resolver really excludes agent models');
}

// Topology shapes the list.
section('   topology decides which halves appear');
{
  const gridOnly = M.describeGenerationPipeline(baseModel());
  ok(gridOnly.every(p => !p.id.startsWith('agent.') && !p.id.startsWith('structural.') && p.id !== 'init.agent' && p.id !== 'color.agents'),
    'grid-only model has NO agent phases');
  ok(gridOnly.some(p => p.id === 'cell.step'), 'grid-only model has the cell step');

  const agentsOnly = M.describeGenerationPipeline(agentModel());
  ok(agentsOnly.every(p => !p.id.startsWith('cell.') && p.id !== 'init.cell' && p.id !== 'init.grid' && p.id !== 'color.cells'),
    'agents-only model has NO cell phases');
  ok(agentsOnly.some(p => p.id === 'agent.behaviour'), 'agents-only model has the behaviour step');

  const both = baseModel({ topologyMode: { gridCells: true, agents: true }, agentGraphNodes: [node('b1', 'behaviourStep')], centerBased: agentModel().centerBased });
  const bothPhases = M.describeGenerationPipeline(both);
  ok(bothPhases.some(p => p.id === 'agent.behaviour') && bothPhases.some(p => p.id === 'cell.step'),
    'both-topology model has both halves');
  const iAgent = bothPhases.findIndex(p => p.id === 'agent.behaviour');
  const iCell = bothPhases.findIndex(p => p.id === 'cell.step');
  ok(iAgent < iCell, 'AGENTS step BEFORE cells (the documented closed agent↔grid loop)');
}

// ---------------------------------------------------------------------------
// 2. PHASE ORDER — hard-coded. Changing the loop description must be a
//    conscious edit of THIS list (the runbook's explicit requirement).
// ---------------------------------------------------------------------------
section('2. Phase ORDER matches the documented loops');

const EXPECTED_ORDER_BOTH = [
  // reset roots (worker reset handler: runInit → runGridInit → runAgentInit)
  'init.cell', 'init.grid', 'init.agent',
  // agent generation (runAgentStep)
  'agent.forceReset', 'agent.spatialHash', 'agent.primeAttrs',
  'agent.behaviour', 'agent.commitAttrs',
  // the force-iteration loop
  'agent.charge', 'agent.softCollision', 'agent.springs', 'agent.integrate', 'agent.growth',
  'agent.positional',
  // the structural phase (runAgentStructuralPhase)
  'structural.drain', 'structural.death', 'structural.divide', 'agent.divisionEvent',
  'structural.autoBond', 'structural.sweep',
  'agent.sprites',
  // the cell generation (runStep)
  'cell.asyncOrder', 'cell.step', 'cell.sparse', 'cell.swap',
  'indicators',
  // per frame
  'color.cells', 'color.agents',
];

{
  const both = baseModel({
    topologyMode: { gridCells: true, agents: true },
    agentGraphNodes: [node('b1', 'behaviourStep')],
    centerBased: agentModel().centerBased,
  });
  const ids = M.describeGenerationPipeline(both).map(p => p.id);
  eq(JSON.stringify(ids), JSON.stringify(EXPECTED_ORDER_BOTH),
    'full (grid + agents) phase order');
}
{
  // Sub-lists must be ORDER-PRESERVING projections of the full list, so a
  // topology-specific list can never reorder relative to the canonical one.
  const gridIds = M.describeGenerationPipeline(baseModel()).map(p => p.id);
  const agentIds = M.describeGenerationPipeline(agentModel()).map(p => p.id);
  const isSubsequence = (sub, full) => {
    let i = 0;
    for (const s of sub) { i = full.indexOf(s, i); if (i < 0) return false; i++; }
    return true;
  };
  ok(isSubsequence(gridIds, EXPECTED_ORDER_BOTH), 'grid-only list is an ordered projection');
  ok(isSubsequence(agentIds, EXPECTED_ORDER_BOTH), 'agents-only list is an ordered projection');
}
// Every phase carries a valid tempo + owner, and ids are unique.
{
  const both = baseModel({
    topologyMode: { gridCells: true, agents: true },
    agentGraphNodes: [node('b1', 'behaviourStep')],
    centerBased: agentModel().centerBased,
  });
  const phases = M.describeGenerationPipeline(both);
  const TEMPOS = new Set(['generation', 'event', 'frame', 'reset']);
  ok(phases.every(p => TEMPOS.has(p.tempo)), 'every phase has a valid tempo');
  ok(phases.every(p => p.owner === 'graph' || p.owner === 'engine'), 'every phase has a valid owner');
  ok(new Set(phases.map(p => p.id)).size === phases.length, 'phase ids are unique');
  ok(phases.every(p => p.active || p.capability), 'every INACTIVE phase names what turns it on');
  // C8 (P9) now WRITES `presentation`, but only on the mover phases and only when
  // the taint check passes. `both` has a bare Behaviour Step with no geometry read,
  // so it IS presentational — the invariant that must hold either way is that no
  // phase OUTSIDE the mover set is ever marked (the cell half especially).
  ok(phases.every(p => p.presentation === undefined || M.PRESENTATION_PHASE_IDS.has(p.id)),
    'only the force/motion/layout phases may carry `presentation` (C8)');
  ok(phases.filter(p => p.id.startsWith('cell.') || p.id.startsWith('color.') || p.id.startsWith('init.'))
    .every(p => p.presentation === undefined), 'cell / colour / init phases are never `presentation`');
  // The reset roots really are the cold path, the colour passes really are per frame.
  const idx = Object.fromEntries(phases.map((p, i) => [p.id, i]));
  ok(phases.filter(p => p.tempo === 'reset').every(p => idx[p.id] < idx['agent.behaviour']),
    'reset-tempo phases come before the per-generation ones');
  ok(phases.filter(p => p.tempo === 'frame').every(p => idx[p.id] > idx['cell.step']),
    'frame-tempo phases come last');
  eq(byId(phases)['agent.divisionEvent'].tempo, 'event', 'the Division Event is EVENT tempo');
  eq(byId(phases)['agent.behaviour'].owner, 'graph', 'the Behaviour Step is the USER\'s');
  eq(byId(phases)['agent.integrate'].owner, 'engine', 'integration is the ENGINE\'s');
}

// ---------------------------------------------------------------------------
// 3. SHIPPED MODELS
// ---------------------------------------------------------------------------
section('3. Every shipped library model produces a pipeline');

const modelsDir = join(ROOT, 'public', 'models');
const files = readdirSync(modelsDir).filter(f => f.endsWith('.gcaproj')).sort();
const loaded = {};
for (const f of files) {
  const raw = JSON.parse(readFileSync(join(modelsDir, f), 'utf8'));
  const model = M.migrateForHarness(raw.model ?? raw);
  loaded[f] = model;
  const phases = M.describeGenerationPipeline(model);
  ok(phases.length > 0, `${f}: non-empty pipeline`);
  ok(phases.every(p => p.active || p.capability), `${f}: every inactive phase is explained`);
  // The same resolver spot-check, on REAL configs this time.
  const cfg = model.centerBased;
  if (model.topologyMode?.agents) {
    eq(activeOf(phases, 'agent.springs'), M.usesEngineSprings(cfg) && M.resolveMaxBonds(cfg) > 0, `${f}: springs`);
    eq(activeOf(phases, 'agent.charge'), M.usesCharge(cfg), `${f}: charge`);
    eq(activeOf(phases, 'agent.softCollision'), M.usesSoftCollision(cfg), `${f}: soft collision`);
    eq(activeOf(phases, 'structural.drain'), M.agentGraphUsesBondRequests(model), `${f}: drain`);
    eq(activeOf(phases, 'structural.divide'), M.dividePartitionTableForModel(model).length > 0, `${f}: divide`);
  }
  if (model.topologyMode?.gridCells !== false) {
    eq(activeOf(phases, 'cell.sparse'), M.sparseSteppingEnabled(model), `${f}: sparse`);
  }
}
console.log(`  (${files.length} models)`);

section('   the five verification models say what the runbook expects');
const P = (f) => M.describeGenerationPipeline(loaded[f]);
{
  // Boids — motion active; bonds / springs / growth / division struck.
  const b = byId(P('Boids - Flocking.gcaproj'));
  ok(b['agent.integrate'].active, 'Boids: integration active');
  ok(b['agent.behaviour'].active, 'Boids: behaviour graph active');
  ok(!b['agent.springs'].active, 'Boids: bond springs OFF');
  ok(!b['agent.growth'].active, 'Boids: growth OFF');
  ok(!b['structural.divide'].active, 'Boids: divisions OFF');
  ok(!b['structural.sweep'].active, 'Boids: bond sweep OFF (no bond store)');

  // Growing Tissue — springs + growth + division + structural active.
  const t = byId(P('Morphogenesis - Growing Tissue.gcaproj'));
  ok(t['agent.springs'].active, 'Tissue: bond springs ON');
  ok(t['agent.growth'].active, 'Tissue: growth ON');
  ok(t['structural.divide'].active, 'Tissue: divisions ON');
  ok(t['structural.sweep'].active, 'Tissue: bond sweep ON');
  ok(/v = .+·v \+ \(.+\/.+\)·ΣF/.test(t['agent.integrate'].detail), `Tissue: resolved integration formula (got "${t['agent.integrate'].detail}")`);

  // Ant Necrophoresis — sequential agents; a field model.
  const a = byId(P('Ant Necrophoresis.gcaproj'));
  ok(/sequential/.test(a['agent.behaviour'].detail), `Ant: behaviour tagged sequential (got "${a['agent.behaviour'].detail}")`);
  ok(a['cell.step'] !== undefined, 'Ant: has the cell half (the corpse field IS the grid)');

  // Game Of Life — grid-only short list.
  const g = P('Game Of Life.gcaproj');
  ok(g.every(p => !p.id.startsWith('agent.') && !p.id.startsWith('structural.')), 'GoL: no agent phases');
  ok(byId(g)['cell.step'].active, 'GoL: cell step active');
  ok(byId(g)['cell.swap'].active, 'GoL: double-buffer swap active (synchronous)');
  ok(g.length <= 10, `GoL: short list (${g.length} phases)`);

  // Cubic GRA — structural queue drain + a Periodic Step cadence.
  const c = byId(P('Cubic GRA.gcaproj'));
  ok(c['structural.drain'].active, 'Cubic GRA: bond-request queue drain ACTIVE');
  ok(/\d+ requests per agent/.test(c['structural.drain'].detail), `Cubic GRA: drain states its depth (got "${c['structural.drain'].detail}")`);
  ok(/cadence/.test(c['agent.behaviour'].detail), `Cubic GRA: behaviour notes its cadence (got "${c['agent.behaviour'].detail}")`);
  ok(c['agent.charge'].active, 'Cubic GRA: long-range charge ACTIVE');
}

// ---------------------------------------------------------------------------
// 4. NEGATIVE CONTROLS — the harness must be able to FAIL.
// ---------------------------------------------------------------------------
section('4. Negative controls (each MUST be caught)');

let caught = 0, missed = 0;
const control = (name, cond) => {
  if (cond) { caught++; console.log(`  caught: ${name}`); }
  else { missed++; console.error(`  NOT CAUGHT: ${name}`); }
};

{
  // (a) A wrong ORDER expectation must not match.
  const both = baseModel({
    topologyMode: { gridCells: true, agents: true },
    agentGraphNodes: [node('b1', 'behaviourStep')],
    centerBased: agentModel().centerBased,
  });
  const ids = M.describeGenerationPipeline(both).map(p => p.id);
  const swapped = [...EXPECTED_ORDER_BOTH];
  const i = swapped.indexOf('agent.behaviour'), j = swapped.indexOf('agent.integrate');
  [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
  control('order check rejects a swapped expectation', JSON.stringify(ids) !== JSON.stringify(swapped));

  // (b) Cells-before-agents would be caught.
  control('agent-before-cell check is real',
    ids.indexOf('agent.behaviour') < ids.indexOf('cell.step'));

  // (c) A resolver-mismatched activity bit is detectable: flipping the config
  //     MUST flip the phase. If the panel hard-coded `true`, this fails.
  const off = agentModel({ collision: 'off' });
  const on = agentModel({ collision: 'soft' });
  control('soft-collision bit genuinely follows the config',
    activeOf(M.describeGenerationPipeline(off), 'agent.softCollision') === false
    && activeOf(M.describeGenerationPipeline(on), 'agent.softCollision') === true);

  // (d) Same for growth — and specifically the growthRate > 0 half, which a
  //     naive `capabilities.growth` read would get WRONG.
  const gCapNoRate = agentModel({ growth: true }, { growthRate: 0 });
  const gCapRate = agentModel({ growth: true }, { growthRate: 0.02 });
  control('growth bit requires BOTH the capability and a positive rate',
    activeOf(M.describeGenerationPipeline(gCapNoRate), 'agent.growth') === false
    && activeOf(M.describeGenerationPipeline(gCapRate), 'agent.growth') === true);

  // (e) The queue-drain bit must follow the GRAPH, not the config.
  const noVerb = agentModel({ bonds: 'physics' });
  const verb = agentModel({ bonds: 'physics' }, {}, [node('b1', 'behaviourStep'), node('f1', 'formBond')]);
  control('drain bit genuinely follows the graph contents',
    activeOf(M.describeGenerationPipeline(noVerb), 'structural.drain') === false
    && activeOf(M.describeGenerationPipeline(verb), 'structural.drain') === true);

  // (f) The Δt shown must be the CLAMPED one — a naive `cbNum(cfg,'timeStep')`
  //     would print 0.5 here.
  const clamped = agentModel({}, { timeStep: 0.5, repulsionStiffness: 2, bondStiffness: 1.2 });
  const f = M.integrationFormula(clamped.centerBased);
  control('integration formula shows the clamped Δt, not the requested one', !f.includes('(0.5/'));
}

// ---------------------------------------------------------------------------
console.log('');
if (missed > 0) console.error(`NEGATIVE CONTROLS: ${missed} not caught`);
console.log(`GENERATION PIPELINE: ${pass} passed, ${fail} failed · negative controls ${caught} caught, ${missed} missed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 && missed === 0 ? 0 : 1);
