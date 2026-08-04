// C8 (P9) — PRESENTATIONAL-GEOMETRY TAINT drift guard.
//
// `analyzeGeometryTaint(model)` answers ONE question — "does geometry ever feed
// a model decision?" — and the pipeline panel labels the whole force / motion /
// layout block on the strength of that answer. A wrong verdict in the
// PRESENTATIONAL direction would promise a freedom the model cannot have, so the
// check must be pinned in both directions:
//
//   1. SHIPPED MODELS vs a recorded HAND-AUDIT. Every public/models/*.gcaproj
//      with an agent layer has an expected verdict written down here, taken from
//      the audit in the C8 Completion Report (docs/HANDOFF_CLARITY_SIMPLIFICATION.md).
//      Tainted models additionally assert WHICH witness kind was found, so
//      "tainted for a different reason" fails too.
//   2. THE CRITERION, on synthetic graphs — one per rule: the
//      Cubic-GRA-midpoint exemption, the geometry-only sinks, the conservative
//      unknown-flow-node default, local variables as conduits, branch-condition
//      taint, the radius gate, the census source, unconditional field deposits,
//      and the two engine-config taints.
//   3. NEGATIVE CONTROLS — deliberately wrong expectations that MUST be caught
//      (a test that only ever passes proves nothing), plus a SOURCE MUTATION
//      run: `--mutate <n>` patches geometryTaint.ts, re-runs, and reports
//      whether the suite noticed.
//
// Run from the repo root:
//   node scripts/test-geometry-taint.mjs            (the suite)
//   node scripts/test-geometry-taint.mjs --witness  (+ print every witness path)
//   node scripts/test-geometry-taint.mjs --mutate   (source-mutation controls)
import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'modeler', 'vpl', 'compiler', 'geometryTaint.ts');

const ENTRY = `
export { analyzeGeometryTaint, PRESENTATION_ONLY_LABEL } from '../src/modeler/vpl/compiler/geometryTaint.ts';
export { describeGenerationPipeline, PRESENTATION_PHASE_IDS } from '../src/model/generationPipeline.ts';
export { EMPTY_MODEL } from '../src/model/defaultModel.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;

async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), 'gca-taint-'));
  const entryPath = join(ROOT, 'scripts', `__taint_entry_${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(entryPath, ENTRY);
  const outPath = join(dir, 'bundle.mjs');
  await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: ROOT });
  rmSync(entryPath, { force: true });
  return import(pathToFileURL(outPath).href + `?t=${Date.now()}`);
}

// ---------------------------------------------------------------------------
// THE HAND-AUDIT (docs/HANDOFF_CLARITY_SIMPLIFICATION.md §C8 Completion Report).
// `via` is the witness kind the audit found; `note` records the reason in one
// line so a future reader does not have to re-derive it.
// ---------------------------------------------------------------------------
const AUDIT = {
  'Ant Necrophoresis':                  { presentational: false, via: ['condition', 'location'], note: 'Read Cells Under gates the pick/drop that writes "carrying"; Affect Cells Under deposits at the position' },
  'Boids - Flocking':                   { presentational: true,  via: [],                        note: 'proximity + offsets + velocity → local variables → Apply Force only' },
  'Boids - Hemifield Vision':           { presentational: true,  via: [],                        note: 'FOV + hemifield counts → local variables → Apply Force only' },
  'Chemotaxis - Aggregation':           { presentational: false, via: ['location'],              note: 'Secrete To Field deposits into the cell field at the agent position' },
  'Cubic GRA':                          { presentational: false, via: ['dataflow'],              note: 'K4 bootstrap: Get Nearby Agents → For Each → Form Bond.targetAgent (geometry → topology)' },
  'Game of Life on Agents':             { presentational: false, via: ['dataflow'],              note: 'Get Nearby Agents → Get Agents Attribute → Aggregate → Set Attribute "alive"' },
  'Graph Metrics - Growth Sweep':       { presentational: false, via: ['engine-config'],         note: 'Divide Agent partition = tension' },
  'Growing Graphs':                     { presentational: true,  via: [],                        note: 'the rule is purely topological (census over BONDED + handle-indexed bootstrap tables); geometry only reaches Create Agent x/y, which is a geometry-only sink' },
  'Life on Bonds':                      { presentational: false, via: ['engine-config'],         note: 'auto-bond builds the bonded ring BY DISTANCE (the rule graph itself is clean)' },
  'Morphogenesis - 3D Tissue':          { presentational: false, via: ['engine-config', 'condition'], note: 'auto-bond + tension partition + (radius, density) → Divide Agent' },
  'Morphogenesis - Differential Tissue':{ presentational: false, via: ['engine-config', 'condition'], note: 'auto-bond + tension partition + (radius, density) → Divide Agent' },
  'Morphogenesis - Growing Tissue':     { presentational: false, via: ['engine-config', 'condition'], note: 'auto-bond + tension partition + radius → Divide Agent' },
  'Particle Life':                      { presentational: true,  via: [],                        note: 'proximity + offsets + species table → Apply Force / Set Velocity only' },
  'Particle Life 3D':                   { presentational: true,  via: [],                        note: 'same as Particle Life, in 3D' },
  'SDCA - Couplers and Decouplers':     { presentational: false, via: ['dataflow'],              note: 'the COUPLERS half: Get Nearby Agents → For Each → Form Bond.targetAgent' },
};

// ---------------------------------------------------------------------------
// Synthetic graph builder — the smallest agent model that exercises one rule.
// ---------------------------------------------------------------------------
function node(id, nodeType, config = {}) {
  return { id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } };
}
const vEdge = (s, sp, t, tp) => ({ id: `${s}.${sp}->${t}.${tp}`, source: s, target: t, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
const fEdge = (s, sp, t, tp) => ({ id: `${s}.${sp}=>${t}.${tp}`, source: s, target: t, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });

function makeModel(M, nodes, edges, extra = {}) {
  const base = JSON.parse(JSON.stringify(M.EMPTY_MODEL));
  return {
    ...base,
    topologyMode: { gridCells: false, agents: true },
    agentGraphNodes: nodes,
    agentGraphEdges: edges,
    agentAttributes: [
      { id: 'a', name: 'A', type: 'float', defaultValue: '0', description: '' },
    ],
    agentVariables: [
      { id: 'v', name: 'V', kind: 'scalar', dataType: 'float', initialValue: '0', description: '' },
    ],
    ...extra,
    centerBased: { ...(base.centerBased ?? {}), ...(extra.centerBased ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
async function runSuite(M, { quiet = false, showWitness = false } = {}) {
  let pass = 0; const failures = [];
  const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
  const eq = (a, b, msg) => ok(a === b, `${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

  // === 1. SHIPPED MODELS vs the hand-audit ==================================
  const modelsDir = join(ROOT, 'public', 'models');
  const files = readdirSync(modelsDir).filter(f => f.endsWith('.gcaproj')).sort();
  const seen = new Set();
  for (const f of files) {
    const name = f.replace(/\.gcaproj$/, '');
    const model = M.migrateForHarness(JSON.parse(readFileSync(join(modelsDir, f), 'utf8')));
    const r = M.analyzeGeometryTaint(model);

    if (!model.topologyMode?.agents) {
      ok(r.applicable === false, `${name}: a grid-only model must report applicable=false`);
      ok(r.presentational === false, `${name}: applicable=false implies presentational=false`);
      continue;
    }
    const expect = AUDIT[name];
    if (!expect) { failures.push(`${name}: agent model with NO recorded hand-audit — audit it and add it to AUDIT`); continue; }
    seen.add(name);
    ok(r.applicable === true, `${name}: an agent model must report applicable=true`);
    eq(r.presentational, expect.presentational, `${name}: verdict (audit: ${expect.note})`);
    if (expect.presentational) {
      eq(r.witnesses.length, 0, `${name}: a presentational model must carry no witness`);
      ok(r.witness === undefined, `${name}: a presentational model must have witness undefined`);
    } else {
      ok(r.witnesses.length > 0, `${name}: a tainted model must carry at least one witness`);
      ok(r.witness !== undefined, `${name}: a tainted model must expose its first witness`);
      const vias = [...new Set(r.witnesses.map(w => w.via))].sort();
      for (const v of expect.via) ok(vias.includes(v), `${name}: expected a '${v}' witness (audit: ${expect.note}), got [${vias}]`);
      // Every witness must be readable end to end.
      for (const w of r.witnesses) {
        ok(typeof w.summary === 'string' && w.summary.length > 10, `${name}: witness summary must be a readable sentence`);
        ok(w.steps.length > 0, `${name}: witness must carry at least one step`);
        ok(w.steps[w.steps.length - 1].sinkKind !== undefined, `${name}: the last witness step must name the sink`);
      }
    }
    if (showWitness && !quiet) {
      console.log(`  ${r.presentational ? 'PRESENTATIONAL' : 'TAINTED       '}  ${name}`);
      for (const w of r.witnesses) console.log(`        · [${w.via}] ${w.summary}`);
    }
  }
  for (const name of Object.keys(AUDIT)) {
    ok(seen.has(name), `AUDIT lists "${name}" but no such shipped agent model was found (stale audit entry)`);
  }

  // === 2. THE CRITERION, on synthetic graphs ===============================
  const V = m => M.analyzeGeometryTaint(m).presentational;

  // 2a. THE CUBIC-GRA-MIDPOINT RULE — geometry into a position write is a closed
  //     loop and stays presentational.
  {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('p', 'getSelfPosition'), node('c', 'createAgent'), node('add', 'addAgentToWorld'),
    ], [
      fEdge('r', 'do', 'c', 'do'), fEdge('c', 'next', 'add', 'do'),
      vEdge('p', 'x', 'c', 'x'), vEdge('p', 'y', 'c', 'y'), vEdge('c', 'handle', 'add', 'handle'),
    ]);
    eq(V(m), true, 'midpoint rule: Get Self Position → Create Agent.x/y must stay presentational');
  }
  // …but the SAME position into a non-geometry port of the same verb taints.
  {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('p', 'getSelfPosition'), node('s', 'setAttribute', { attributeId: 'a' }),
    ], [fEdge('r', 'do', 's', 'do'), vEdge('p', 'x', 's', 'value')]);
    eq(V(m), false, 'a position written into an ATTRIBUTE must taint');
  }

  // 2b. GEOMETRY-ONLY SINKS never taint.
  for (const [type, port] of [['applyForce', 'fx'], ['setVelocity', 'vx'], ['setAgentPosition', 'x'], ['setTargetRadius', 'value']]) {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('p', 'getSelfPosition'), node('s', type),
    ], [fEdge('r', 'do', 's', 'do'), vEdge('p', 'x', 's', port)]);
    eq(V(m), true, `geometry → ${type}.${port} must stay presentational`);
  }

  // 2c. THE CONSERVATIVE DEFAULT — an unknown flow node taints.
  {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('p', 'getSelfPosition'), node('s', 'someFutureStateWriter'),
    ], [fEdge('r', 'do', 's', 'do'), vEdge('p', 'x', 's', 'value')]);
    eq(V(m), false, 'an UNKNOWN flow node fed geometry must taint (the conservative default)');
  }

  // 2d. LOCAL VARIABLES ARE CONDUITS — taint flows through, the write itself is
  //     not a sink (this is what keeps Boids presentational).
  {
    const conduitOnly = makeModel(M, [
      node('r', 'behaviourStep'), node('p', 'getSelfPosition'),
      node('sv', 'setVariable', { variableId: 'v' }), node('gv', 'getVariable', { variableId: 'v' }),
      node('f', 'applyForce'),
    ], [
      fEdge('r', 'do', 'sv', 'do'), fEdge('sv', 'next', 'f', 'do'),
      vEdge('p', 'x', 'sv', 'value'), vEdge('gv', 'value', 'f', 'fx'),
    ]);
    eq(V(conduitOnly), true, 'a variable holding geometry that only reaches Apply Force stays presentational');

    const throughVar = makeModel(M, [
      node('r', 'behaviourStep'), node('p', 'getSelfPosition'),
      node('sv', 'setVariable', { variableId: 'v' }), node('gv', 'getVariable', { variableId: 'v' }),
      node('s', 'setAttribute', { attributeId: 'a' }),
    ], [
      fEdge('r', 'do', 'sv', 'do'), fEdge('sv', 'next', 's', 'do'),
      vEdge('p', 'x', 'sv', 'value'), vEdge('gv', 'value', 's', 'value'),
    ]);
    eq(V(throughVar), false, 'taint must flow THROUGH a local variable into an attribute write');
  }

  // 2e. BRANCH-CONDITION TAINT — a constant written under a geometric condition
  //     is still a geometric decision.
  {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('d', 'neighbourDensity'), node('c', 'statement', { operation: '>' }),
      node('if', 'conditional'), node('s', 'setAttribute', { attributeId: 'a', _port_value: '1' }),
    ], [
      fEdge('r', 'do', 'if', 'check'), fEdge('if', 'then', 's', 'do'),
      vEdge('d', 'value', 'c', 'x'), vEdge('c', 'result', 'if', 'condition'),
    ]);
    eq(V(m), false, 'a CONSTANT write under a geometry-derived branch condition must taint');
    const w = M.analyzeGeometryTaint(m).witness;
    eq(w?.via, 'condition', 'the branch-condition witness must be classified as `condition`');
  }
  // The `next` chain of that conditional is NOT inside the branch.
  {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('d', 'neighbourDensity'), node('c', 'statement', { operation: '>' }),
      node('if', 'conditional'), node('f', 'applyForce'), node('s', 'setAttribute', { attributeId: 'a', _port_value: '1' }),
    ], [
      fEdge('r', 'do', 'if', 'check'), fEdge('if', 'then', 'f', 'do'), fEdge('if', 'next', 's', 'do'),
      vEdge('d', 'value', 'c', 'x'), vEdge('c', 'result', 'if', 'condition'),
    ]);
    eq(V(m), true, 'a write on the conditional\'s NEXT chain runs regardless, so it must not be gated');
  }

  // 2f. THE RADIUS GATE — a body-radius read is geometry only while the engine
  //     growth ramp advances it.
  {
    const nodes = [node('r', 'behaviourStep'), node('s', 'setAttribute', { attributeId: 'a' })];
    const edges = [fEdge('r', 'do', 's', 'do'), vEdge('r', 'myRadius', 's', 'value')];
    const growing = makeModel(M, nodes, edges, {
      centerBased: { growthRate: 0.05, agentCapabilities: { motion: 'force', body: true, growth: true, collision: 'off', bonds: 'off', charge: 'off', autoBond: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    });
    const still = makeModel(M, nodes, edges, {
      centerBased: { growthRate: 0, agentCapabilities: { motion: 'force', body: true, growth: false, collision: 'off', bonds: 'off', charge: 'off', autoBond: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } },
    });
    eq(V(growing), false, 'radius → attribute taints WHEN the engine growth ramp advances the radius');
    eq(V(still), true, 'radius → attribute is clean when growth is off (the graph owns the radius)');
  }

  // 2g. THE CENSUS SOURCE — bonded is topology, nearby is proximity.
  for (const [source, expected] of [['bonded', true], ['nearby', false]]) {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('n', 'neighbourCensus', { attributeId: 'a', source }),
      node('s', 'setAttribute', { attributeId: 'a' }),
    ], [fEdge('r', 'do', 's', 'do'), vEdge('n', 'count_1', 's', 'value')]);
    eq(V(m), expected, `Neighbour Census over '${source}' → attribute must be ${expected ? 'clean' : 'tainted'}`);
  }

  // 2h. FIELD DEPOSITS taint unconditionally — the LOCATION is the position.
  for (const type of ['affectCellsUnder', 'secreteToField']) {
    const m = makeModel(M, [node('r', 'behaviourStep'), node('s', type, { attributeId: 'f', _port_value: '1' })],
      [fEdge('r', 'do', 's', 'do')]);
    eq(V(m), false, `${type} must taint even with a constant value (the deposit location is the position)`);
    eq(M.analyzeGeometryTaint(m).witness?.via, 'location', `${type} witness must be classified as \`location\``);
  }

  // 2i. TOPOLOGY IS NOT GEOMETRY.
  {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('b', 'getBondDegree'), node('s', 'setAttribute', { attributeId: 'a' }),
    ], [fEdge('r', 'do', 's', 'do'), vEdge('b', 'value', 's', 'value')],
    { centerBased: { maxBonds: 4, agentCapabilities: { motion: 'force', body: true, bonds: 'data', collision: 'off', charge: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } } });
    eq(V(m), true, 'bond degree (topology) → attribute must stay presentational');
  }
  // …but forEachBond.currentLength IS a distance.
  {
    const m = makeModel(M, [
      node('r', 'behaviourStep'), node('fb', 'forEachBond'), node('s', 'setAttribute', { attributeId: 'a' }),
    ], [fEdge('r', 'do', 'fb', 'do'), fEdge('fb', 'body', 's', 'do'), vEdge('fb', 'currentLength', 's', 'value')],
    { centerBased: { maxBonds: 4, agentCapabilities: { motion: 'force', body: true, bonds: 'data', collision: 'off', charge: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } } });
    eq(V(m), false, 'For Each Bond · currentLength → attribute must taint (it is a distance)');
    // …while partnerId out of the SAME node stays clean.
    const clean = makeModel(M, [
      node('r', 'behaviourStep'), node('fb', 'forEachBond'), node('s', 'setAttribute', { attributeId: 'a' }),
    ], [fEdge('r', 'do', 'fb', 'do'), fEdge('fb', 'body', 's', 'do'), vEdge('fb', 'partnerId', 's', 'value')],
    { centerBased: { maxBonds: 4, agentCapabilities: { motion: 'force', body: true, bonds: 'data', collision: 'off', charge: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true } } });
    eq(V(clean), true, 'For Each Bond · partnerId → attribute must stay clean (port-level granularity)');
  }

  // 2j. ENGINE-GEOMETRIC CONFIG, with nothing at all in the graph.
  {
    const bare = [node('r', 'behaviourStep')];
    const caps = over => ({ motion: 'force', body: true, collision: 'off', bonds: 'physics', charge: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true, ...over });
    const clean = makeModel(M, bare, [], { centerBased: { maxBonds: 4, autoBond: false, agentCapabilities: caps({}) } });
    eq(V(clean), true, 'a bonded model with auto-bond OFF and no rule stays presentational');
    const auto = makeModel(M, bare, [], { centerBased: { maxBonds: 4, autoBond: true, agentCapabilities: caps({ autoBond: true }) } });
    eq(V(auto), false, 'auto-bond ON must taint (the engine builds topology from distance)');
    eq(M.analyzeGeometryTaint(auto).witness?.via, 'engine-config', 'auto-bond witness must be `engine-config`');

    const tension = makeModel(M,
      [node('r', 'behaviourStep'), node('d', 'divideAgent', { partition: 'tension' })],
      [fEdge('r', 'do', 'd', 'do')],
      { centerBased: { maxBonds: 4, autoBond: false, agentCapabilities: caps({ division: true }) } });
    eq(V(tension), false, 'a reachable Divide Agent with the TENSION partition must taint');
    const alternate = makeModel(M,
      [node('r', 'behaviourStep'), node('d', 'divideAgent', { partition: 'alternate' })],
      [fEdge('r', 'do', 'd', 'do')],
      { centerBased: { maxBonds: 4, autoBond: false, agentCapabilities: caps({ division: true }) } });
    eq(V(alternate), true, 'the ALTERNATE partition is slot-based, so it must not taint');
    // An UNREACHABLE tension divide never runs, so it must not taint.
    const orphan = makeModel(M,
      [node('r', 'behaviourStep'), node('d', 'divideAgent', { partition: 'tension' })], [],
      { centerBased: { maxBonds: 4, autoBond: false, agentCapabilities: caps({ division: true }) } });
    eq(V(orphan), true, 'an UNREACHABLE Divide Agent must not taint (it never runs)');
  }

  // 2k. EVERY AGENT ROOT is covered, not just the behaviour step.
  for (const root of ['agentInit', 'divisionEvent', 'agentOutputMapping']) {
    const m = makeModel(M, [
      node('r', root), node('p', 'getSelfPosition'), node('s', 'setAttribute', { attributeId: 'a' }),
    ], [fEdge('r', 'do', 's', 'do'), vEdge('p', 'x', 's', 'value')]);
    eq(V(m), false, `a geometry → attribute path in the ${root} root must taint`);
  }

  // 2l. A GRID-ONLY model is not applicable, and its verdict is never "true".
  {
    const m = { ...JSON.parse(JSON.stringify(M.EMPTY_MODEL)), topologyMode: { gridCells: true, agents: false } };
    const r = M.analyzeGeometryTaint(m);
    eq(r.applicable, false, 'a grid-only model must be inapplicable');
    eq(r.presentational, false, 'an inapplicable model must not claim to be presentational');
  }

  // === 3. THE PIPELINE INTEGRATION ========================================
  {
    const presentational = makeModel(M, [
      node('r', 'behaviourStep'), node('p', 'getSelfPosition'), node('f', 'applyForce'),
    ], [fEdge('r', 'do', 'f', 'do'), vEdge('p', 'x', 'f', 'fx')]);
    const tainted = makeModel(M, [
      node('r', 'behaviourStep'), node('p', 'getSelfPosition'), node('s', 'setAttribute', { attributeId: 'a' }),
    ], [fEdge('r', 'do', 's', 'do'), vEdge('p', 'x', 's', 'value')]);
    const marked = m => M.describeGenerationPipeline(m).filter(ph => ph.presentation).map(ph => ph.id);
    const good = marked(presentational);
    ok(good.length > 0, 'a presentational model must mark at least one pipeline phase');
    for (const id of good) ok(M.PRESENTATION_PHASE_IDS.has(id), `only mover phases may be marked — ${id} is not one`);
    ok(good.includes('agent.integrate'), 'the integrator must be marked on a presentational model');
    eq(marked(tainted).length, 0, 'a tainted model must mark NO pipeline phase');
    // Grid phases are never presentation, whatever the agent verdict.
    ok(!good.some(id => id.startsWith('cell.')), 'no CELL phase may ever be marked presentation');
  }

  // === 4. IN-HARNESS NEGATIVE CONTROLS ====================================
  // Deliberately wrong expectations that MUST be caught by the same helpers.
  const controls = [
    ['Cubic GRA is presentational', () => {
      const model = M.migrateForHarness(JSON.parse(readFileSync(join(modelsDir, 'Cubic GRA.gcaproj'), 'utf8')));
      return M.analyzeGeometryTaint(model).presentational === true;
    }],
    ['Boids is tainted', () => {
      const model = M.migrateForHarness(JSON.parse(readFileSync(join(modelsDir, 'Boids - Flocking.gcaproj'), 'utf8')));
      return M.analyzeGeometryTaint(model).presentational === false;
    }],
    ['an attribute write is a geometry-only sink', () => V(makeModel(M,
      [node('r', 'behaviourStep'), node('p', 'getSelfPosition'), node('s', 'setAttribute', { attributeId: 'a' })],
      [fEdge('r', 'do', 's', 'do'), vEdge('p', 'x', 's', 'value')])) === true],
    ['Apply Force taints', () => V(makeModel(M,
      [node('r', 'behaviourStep'), node('p', 'getSelfPosition'), node('f', 'applyForce')],
      [fEdge('r', 'do', 'f', 'do'), vEdge('p', 'x', 'f', 'fx')])) === false],
    ['auto-bond is harmless', () => {
      const caps = { motion: 'force', body: true, collision: 'off', bonds: 'physics', charge: 'off', autoBond: true, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false, appearance: true };
      return V(makeModel(M, [node('r', 'behaviourStep')], [], { centerBased: { maxBonds: 4, autoBond: true, agentCapabilities: caps } })) === true;
    }],
    ['a grid-only model is presentational', () => M.analyzeGeometryTaint({ ...JSON.parse(JSON.stringify(M.EMPTY_MODEL)), topologyMode: { gridCells: true, agents: false } }).presentational === true],
  ];
  let caught = 0, missed = 0;
  for (const [label, holds] of controls) {
    if (holds()) { missed++; failures.push(`NEGATIVE CONTROL NOT CAUGHT: "${label}" should be false but held`); }
    else caught++;
  }

  return { pass, failures, controls: { caught, missed } };
}

// ---------------------------------------------------------------------------
// SOURCE MUTATION — patch geometryTaint.ts, re-run, report whether we noticed.
// A structural harness that only ever passes proves nothing.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  ['drop the attribute-write sink (make every unknown flow node clean)',
    src => src.replace(
      `      } else if (!CONTROL_FLOW.has(t)) {`,
      `      } else if (false && !CONTROL_FLOW.has(t)) {`)],
  ['treat Apply Force as a tainting sink (break the closed-loop rule)',
    src => src.replace(
      `  'applyForce', 'applyForceToAgent', 'applyForceToAgents',\n`, ``)],
  ['drop the createAgent geometry-port exemption (break the Cubic-GRA-midpoint rule)',
    src => src.replace(
      `  createAgent: new Set(['x', 'y', 'z', 'radius']),`,
      `  createAgent: new Set([]),`)],
  ['ignore auto-bond',
    src => src.replace(
      `  const autoBondActive = usesEngineSprings(cfg) && !!cfg?.autoBond && resolveMaxBonds(cfg) > 0;`,
      `  const autoBondActive = false;`)],
  ['make branch conditions never taint',
    src => src.replace(
      `      const branchGate: Gate = gateHits.length > 0`,
      `      const branchGate: Gate = false && gateHits.length > 0`)],
];

async function main() {
  const args = process.argv.slice(2);
  const showWitness = args.includes('--witness');

  if (args.includes('--mutate')) {
    const original = readFileSync(SRC, 'utf8');
    let caught = 0, missed = 0;
    try {
      for (const [label, patch] of MUTATIONS) {
        const mutated = patch(original);
        if (mutated === original) { console.error(`  MUTATION ANCHOR MISSING: ${label}`); missed++; continue; }
        writeFileSync(SRC, mutated);
        const Mm = await loadModule();
        const res = await runSuite(Mm, { quiet: true });
        if (res.failures.length > 0) { caught++; console.log(`  CAUGHT (${res.failures.length} failures): ${label}`); }
        else { missed++; console.error(`  NOT CAUGHT: ${label}`); }
      }
    } finally {
      writeFileSync(SRC, original);
    }
    console.log(`\nsource mutations: ${caught} caught, ${missed} missed`);
    process.exit(missed === 0 ? 0 : 1);
  }

  const M = await loadModule();
  if (showWitness) console.log('\nSHIPPED MODEL VERDICTS');
  const res = await runSuite(M, { showWitness });
  for (const f of res.failures) console.error('  FAIL ' + f);
  console.log(`\ngeometry taint: ${res.pass} passed, ${res.failures.length} failed · negative controls ${res.controls.caught} caught, ${res.controls.missed} missed`);
  process.exit(res.failures.length === 0 && res.controls.missed === 0 ? 0 : 1);
}

await main();
