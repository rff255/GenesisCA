#!/usr/bin/env node
/**
 * Generates public/models/Particle Life.gcaproj (and, with EMIT_3D, the
 * 3D variant) — the classic Particle Life sandbox on the Bond-Graph Agents
 * platform, faithful to the Sandbox Science implementation
 * (https://sandbox-science.com/particle-life):
 *
 *   - K species (an agent TAG attribute) with THREE species×species float
 *     lookup tables: `rules` (attraction/repulsion ∈ [−1,1], asymmetric),
 *     `attractMin` (per-pair repulsion-core radius), `attractMax` (per-pair
 *     interaction range) — the axes BIND the agent tag attribute directly.
 *   - The force law per neighbour at distance d with pair values (rule, minR,
 *     maxR):  d < minR   → repel·(d/minR − 1)          (always repulsive)
 *             d < maxR   → tent peaking rule at (minR+maxR)/2, zero at ends
 *     accumulated along the torus-shortest offset (Get Agent Offset).
 *   - Integration: graph friction (v·f via Set Velocity) + engine momentum 1.0
 *     ⇒ v = f·v + Δt·ΣF — the same family as their v+=F·k; v*=friction.
 *   - Spawn: Agent Init → Loop(Count ← model attr N) → Create Agent at a
 *     uniform random position → random species → Add To World.
 *
 * Sliders (bounded model attrs): N, forceFactor, repel, friction, queryRadius.
 * NB queryRadius must stay ≤ neighbourQueryRadius (24, the spatial-hash
 * ceiling) and ≥ the attractMax roll range or far pairs stop interacting.
 *
 * Built programmatically (mirrors gen-boids.mjs). Re-run:
 *   node scripts/gen-particle-life.mjs
 * Re-running preserves any saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMIT_3D = true; // Phase 6 flips this on; both files regenerate per run.

// =============================================================================
// Deterministic helpers
// =============================================================================
const usedIds = new Set();
function newId(prefix) {
  let id;
  do { id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

/** EXACT inline copy of variegation.ts `randomFillTableData` (xorshift32
 *  13/17/5; one density draw per entry + one value draw per rolled entry) with
 *  the float rangeMin/rangeMax policy — so the stored `tableRoll` reproduces
 *  the shipped tableValues byte-for-byte when the user hits Randomize→Apply. */
function randomFillFloat(total, seed, density, lo, hi) {
  let rs = (seed >>> 0) || 0x12345678;
  const next = () => {
    rs = (rs ^ (rs << 13)) >>> 0;
    rs = (rs ^ (rs >>> 17)) >>> 0;
    rs = (rs ^ (rs << 5)) >>> 0;
    return rs / 4294967296;
  };
  const span = hi - lo;
  const out = new Array(total);
  for (let i = 0; i < total; i++) {
    if (next() < density) out[i] = next() * span + lo;
    else out[i] = 0;
  }
  return out;
}

/** Flat row-major → the legacy sparse nested tableValues map (zeros omitted —
 *  the editor's doRandomize conversion). */
function flatToTableValues(flat, labels) {
  const tv = {};
  labels.forEach((rl, i) => {
    const row = {};
    labels.forEach((cl, j) => {
      const v = flat[i * labels.length + j];
      if (v !== 0) row[cl] = v;
    });
    tv[rl] = row;
  });
  return tv;
}

// =============================================================================
// Species + table setup (shared 2D/3D)
// =============================================================================
const SPECIES = ['red', 'green', 'blue', 'yellow', 'purple', 'cyan'];
const K = SPECIES.length;
const SPECIES_COLORS = [
  { r: 230, g: 70, b: 70 }, { r: 95, g: 200, b: 95 }, { r: 90, g: 140, b: 235 },
  { r: 225, g: 200, b: 80 }, { r: 170, g: 110, b: 220 }, { r: 80, g: 200, b: 215 },
];

// Named matrix generators — ports of Sandbox Science rulesGenerator.ts.
function rulesSnake() {
  const m = new Array(K * K).fill(0);
  for (let i = 0; i < K; i++) { m[i * K + i] = 1; m[i * K + ((i + 1) % K)] = 0.2; }
  return m;
}
function rulesRPS() { // rock-paper-scissors: attack next, flee prev, mild self-repel
  const m = new Array(K * K).fill(0);
  for (let i = 0; i < K; i++) {
    m[i * K + i] = -0.1;
    m[i * K + ((i + 1) % K)] = 0.9;
    m[i * K + ((i + K - 1) % K)] = -0.7;
  }
  return m;
}
function rulesSymmetric(seed) { // symmetric random → stable blob "chemistry"
  const m = randomFillFloat(K * K, seed, 1, -1, 1);
  for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) m[j * K + i] = m[i * K + j];
  return m;
}

// The SHIPPED default matrix: a hand-picked random seed (dense, signed).
const RULES_SEED = 20260721, MIN_SEED = 71, MAX_SEED = 72;
const RULES_FLAT = randomFillFloat(K * K, RULES_SEED, 1, -1, 1);
const MIN_FLAT = randomFillFloat(K * K, MIN_SEED, 1, 3, 6);
const MAX_FLAT = randomFillFloat(K * K, MAX_SEED, 1, 8, 16);

// =============================================================================
// Model builder (2D + 3D share everything except world dims / z arms)
// =============================================================================
function buildModel(is3d) {
  const W = is3d ? 160 : 320, H = is3d ? 110 : 200, D = is3d ? 70 : 1;
  const N_DEFAULT = is3d ? 1200 : 1800;
  const MAX_AGENTS = is3d ? 2400 : 3200;

  // Graph builders — separate node/edge arrays per model.
  const agentNodes = [];
  const agentEdges = [];
  const node = (nodeType, config, col, row) => {
    const n = { id: newId('a'), type: 'caNode', position: { x: col * 240, y: row * 100 }, data: { nodeType, config } };
    agentNodes.push(n);
    return n;
  };
  const edge = (s, sp, t, tp, cat) => {
    agentEdges.push({ id: newId('e'), source: s.id, target: t.id,
      sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  };
  const vE = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
  const fE = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

  // ---- Agent Init: N particles at uniform random positions, random species --
  const ai = node('agentInit', {}, 0, 0);
  const gmaN = node('getModelAttribute', { attributeId: 'numParticles' }, 0, 1.4);
  const lp = node('loop', {}, 1, 0);
  vE(gmaN, 'value', lp, 'count');
  fE(ai, 'do', lp, 'do');
  const r1 = node('getRandom', { randomType: 'float', min: '0', max: '1' }, 1.6, 1.6);
  const r2 = node('getRandom', { randomType: 'float', min: '0', max: '1' }, 1.6, 2.6);
  const exX = node('expression', { expression: 'a*b', visibleCount: 2 }, 2.6, 1.6);
  vE(r1, 'value', exX, 'a'); vE(ai, 'worldWidth', exX, 'b');
  const exY = node('expression', { expression: 'a*b', visibleCount: 2 }, 2.6, 2.6);
  vE(r2, 'value', exY, 'a'); vE(ai, 'worldHeight', exY, 'b');
  let exZ = null;
  if (is3d) {
    const r3 = node('getRandom', { randomType: 'float', min: '0', max: '1' }, 1.6, 3.6);
    exZ = node('expression', { expression: 'a*b', visibleCount: 2 }, 2.6, 3.6);
    vE(r3, 'value', exZ, 'a'); vE(ai, 'worldDepth', exZ, 'b');
  }
  const ca = node('createAgent', { _port_radius: '1.2' }, 3.8, 0);
  vE(exX, 'result', ca, 'x'); vE(exY, 'result', ca, 'y');
  if (exZ) vE(exZ, 'result', ca, 'z');
  const rSp = node('getRandom', { randomType: 'integer', min: '0', max: String(K - 1) }, 3.8, 1.8);
  const saSp = node('setAgentAttribute', { attributeId: 'species' }, 5, 0.8);
  vE(ca, 'handle', saSp, 'agentId'); vE(rSp, 'value', saSp, 'value');
  const aw = node('addAgentToWorld', {}, 6.2, 0);
  vE(ca, 'handle', aw, 'handle');
  fE(lp, 'body', ca, 'do');
  fE(ca, 'next', saSp, 'do');
  fE(saSp, 'next', aw, 'do');

  // ---- Behaviour: friction, then the pairwise force law ---------------------
  const bs = node('behaviourStep', {}, 0, 6);
  // Friction: v ← v·f (a live slider). The engine then integrates with
  // momentum 1.0, so per step v = f·v + (Δt/η)·ΣF — the Sandbox Science
  // scheme up to a constant redefinition.
  const gvSelf = node('getVelocity', {}, 0, 7.6);
  const gmaFric = node('getModelAttribute', { attributeId: 'friction' }, 0, 8.8);
  const exVX = node('expression', { expression: 'a*b', visibleCount: 2 }, 1.1, 7.4);
  vE(gvSelf, 'vx', exVX, 'a'); vE(gmaFric, 'value', exVX, 'b');
  const exVY = node('expression', { expression: 'a*b', visibleCount: 2 }, 1.1, 8.4);
  vE(gvSelf, 'vy', exVY, 'a'); vE(gmaFric, 'value', exVY, 'b');
  let exVZ = null;
  if (is3d) {
    exVZ = node('expression', { expression: 'a*b', visibleCount: 2 }, 1.1, 9.4);
    vE(gvSelf, 'vz', exVZ, 'a'); vE(gmaFric, 'value', exVZ, 'b');
  }
  const sv = node('setVelocity', {}, 2.3, 6);
  vE(exVX, 'result', sv, 'vx'); vE(exVY, 'result', sv, 'vy');
  if (exVZ) vE(exVZ, 'result', sv, 'vz');
  fE(bs, 'do', sv, 'do');

  // Neighbour loop over the query radius (a live slider ≤ the hash ceiling).
  const gmaQ = node('getModelAttribute', { attributeId: 'queryRadius' }, 2.3, 7.6);
  const nb = node('getNearbyAgents', {}, 3.4, 7.2);
  vE(gmaQ, 'value', nb, 'radius');
  const fe = node('forEachInArray', {}, 3.6, 6);
  vE(nb, 'agents', fe, 'array');
  fE(sv, 'next', fe, 'do');

  // Per-neighbour reads: torus-shortest offset + the two species.
  const go = node('getAgentOffset', {}, 4.8, 7.4);
  vE(fe, 'element', go, 'agentId');
  const mySp = node('getCellAttribute', { attributeId: 'species' }, 4.8, 8.8);
  const thSp = node('getAgentAttribute', { attributeId: 'species' }, 4.8, 9.8);
  vE(fe, 'element', thSp, 'agentId');

  // The three per-pair table lookups (species × species).
  const luR = node('lookupInteraction', { tableId: 'rules' }, 6, 8.2);
  vE(mySp, 'value', luR, 'labelA'); vE(thSp, 'value', luR, 'labelB');
  const luMin = node('lookupInteraction', { tableId: 'attractMin' }, 6, 9.4);
  vE(mySp, 'value', luMin, 'labelA'); vE(thSp, 'value', luMin, 'labelB');
  const luMax = node('lookupInteraction', { tableId: 'attractMax' }, 6, 10.6);
  vE(mySp, 'value', luMax, 'labelA'); vE(thSp, 'value', luMax, 'labelB');

  // Piecewise force: repulsion core below minR, tent between minR and maxR.
  const cNear = node('statement', { operation: '<', compareType: 'numerical' }, 7.3, 7);
  vE(go, 'distance', cNear, 'x'); vE(luMin, 'value', cNear, 'y');
  const cIn = node('statement', { operation: '<', compareType: 'numerical' }, 7.3, 8.2);
  vE(go, 'distance', cIn, 'x'); vE(luMax, 'value', cIn, 'y');
  const gmaRep = node('getModelAttribute', { attributeId: 'repel' }, 7.3, 9.4);
  // repel·(d/minR − 1): a=d, b=minR, c=repel
  const exRep = node('expression', { expression: 'c*(a/max(b,0.0001)-1)', visibleCount: 3 }, 8.5, 7);
  vE(go, 'distance', exRep, 'a'); vE(luMin, 'value', exRep, 'b'); vE(gmaRep, 'value', exRep, 'c');
  // tent: d·(1 − |a−mid|/halfSpan), mid=(b+c)/2 — a=d(dist), b=minR, c=maxR, d=rule
  const exTent = node('expression', { expression: 'd*(1-abs(a-(b+c)*0.5)/max((c-b)*0.5,0.0001))', visibleCount: 4 }, 8.5, 8.4);
  vE(go, 'distance', exTent, 'a'); vE(luMin, 'value', exTent, 'b');
  vE(luMax, 'value', exTent, 'c'); vE(luR, 'value', exTent, 'd');
  // In range → tent, else 0; below the core → repulsion overrides.
  const vsIn = node('valueSwitch', { _port_elseValue: '0' }, 9.7, 8.2);
  vE(cIn, 'result', vsIn, 'condition'); vE(exTent, 'result', vsIn, 'ifValue');
  const vsF = node('valueSwitch', {}, 10.9, 7.4);
  vE(cNear, 'result', vsF, 'condition'); vE(exRep, 'result', vsF, 'ifValue');
  vE(vsIn, 'result', vsF, 'elseValue');

  // Scale by forceFactor and project along the unit offset: d·a·b/max(c,ε).
  const gmaFF = node('getModelAttribute', { attributeId: 'forceFactor' }, 10.9, 9);
  const exFx = node('expression', { expression: 'd*a*b/max(c,0.0001)', visibleCount: 4 }, 12.1, 6.6);
  vE(vsF, 'result', exFx, 'a'); vE(go, 'dx', exFx, 'b');
  vE(go, 'distance', exFx, 'c'); vE(gmaFF, 'value', exFx, 'd');
  const exFy = node('expression', { expression: 'd*a*b/max(c,0.0001)', visibleCount: 4 }, 12.1, 7.8);
  vE(vsF, 'result', exFy, 'a'); vE(go, 'dy', exFy, 'b');
  vE(go, 'distance', exFy, 'c'); vE(gmaFF, 'value', exFy, 'd');
  let exFz = null;
  if (is3d) {
    exFz = node('expression', { expression: 'd*a*b/max(c,0.0001)', visibleCount: 4 }, 12.1, 9);
    vE(vsF, 'result', exFz, 'a'); vE(go, 'dz', exFz, 'b');
    vE(go, 'distance', exFz, 'c'); vE(gmaFF, 'value', exFz, 'd');
  }
  const af = node('applyForce', {}, 13.4, 6);
  vE(exFx, 'result', af, 'fx'); vE(exFy, 'result', af, 'fy');
  if (exFz) vE(exFz, 'result', af, 'fz');
  fE(fe, 'body', af, 'do');

  // ---- Attributes -----------------------------------------------------------
  const tableAttr = (id, name, description, flat, roll) => ({
    id, name, description, type: 'lookupTable', isModelAttribute: true,
    defaultValue: '0',
    rowKeySource: { kind: 'tagAttribute', attributeId: 'species' },
    colKeySource: { kind: 'tagAttribute', attributeId: 'species' },
    symmetric: false, valueType: 'float',
    tableValues: flatToTableValues(flat, SPECIES),
    tableRoll: roll,
  });
  const slider = (id, name, description, type, def, min, max) => ({
    id, name, description, type, isModelAttribute: true,
    defaultValue: String(def), hasBounds: true, min, max,
  });
  const attributes = [
    slider('numParticles', 'N (particles)', 'Population size — applied on Reset (the Agent Init spawn loop reads it).', 'integer', N_DEFAULT, 100, MAX_AGENTS),
    // Browser-tuned defaults (2026-07): forceFactor 0.05 + friction 0.8 give
    // vmax ≈ 2 units/step (radii are 3..16) → species-sorted clusters with
    // density 1.6× uniform + same-species neighbour fraction 0.40 vs 0.17 null.
    slider('forceFactor', 'forceFactor', 'Overall force gain.', 'float', 0.05, 0.01, 1),
    slider('repel', 'repel', 'Strength of the short-range repulsion core (below each pair’s min radius).', 'float', 1.5, 0, 3),
    slider('friction', 'friction', 'Velocity keep-fraction per step (1 = frictionless, 0 = full stop).', 'float', 0.8, 0, 0.99),
    slider('queryRadius', 'queryRadius', 'Neighbour search radius. Keep ≥ the attractMax range and ≤ 24 (the spatial-hash ceiling) or far pairs stop interacting.', 'float', 16, 4, 24),
    tableAttr('rules', 'rules', 'Attraction (+) / repulsion (−) per species pair — THE Particle Life matrix. Asymmetric: rules[A][B] is the force ON an A FROM a B.', RULES_FLAT,
      { seed: RULES_SEED, density: 1, rangeMin: -1, rangeMax: 1 }),
    tableAttr('attractMin', 'attractMin', 'Per-pair repulsion-core radius (below it the pair always repels).', MIN_FLAT,
      { seed: MIN_SEED, density: 1, rangeMin: 3, rangeMax: 6 }),
    tableAttr('attractMax', 'attractMax', 'Per-pair interaction range (the tent reaches zero here). Keep ≤ queryRadius.', MAX_FLAT,
      { seed: MAX_SEED, density: 1, rangeMin: 8, rangeMax: 16 }),
  ];

  // ---- Presets: named matrices (generator ports) ----------------------------
  const PRESET_BASE_TIMESTAMP = 1753000000000;
  const presetSpec = [
    { name: 'Random soup (seed 4242)', desc: 'Dense uniform [−1,1) reroll — the classic Particle Life chaos.', flat: randomFillFloat(K * K, 4242, 1, -1, 1) },
    { name: 'Snake', desc: 'Self-cohesion + a weak pull toward the next species — crawling chains.', flat: rulesSnake() },
    { name: 'Rock–Paper–Scissors', desc: 'Chase the next species, flee the previous — endless pursuit spirals.', flat: rulesRPS() },
    { name: 'Stable clusters (symmetric)', desc: 'Symmetric random matrix — settles into blob "molecules".', flat: rulesSymmetric(77) },
  ];
  const presets = presetSpec.map((p, i) => ({
    id: newId('preset_'),
    name: p.name,
    description: p.desc,
    state: {
      schemaVersion: 2,
      interactionTables: { rules: flatToTableValues(p.flat, SPECIES) },
      modelAttrs: {},
    },
    createdAt: PRESET_BASE_TIMESTAMP + i * 1000,
  }));

  // ---- Assembly -------------------------------------------------------------
  const dim = is3d ? ' 3D' : '';
  return {
    schemaVersion: 1,
    properties: {
      name: `Particle Life${dim}`,
      description: `The classic Particle Life sandbox${dim ? ' in a 3D volume' : ''}: K species, a signed attraction/repulsion matrix, per-pair min/max radii — chase spirals, membranes and cell-like blobs emerge from one table.`,
      ruleDescription:
        'Each particle sums a pairwise force over neighbours within queryRadius: below the pair’s ' +
        'attractMin the force is always repulsive (repel·(d/minR−1)); between attractMin and attractMax ' +
        'it follows a tent peaking at the midpoint with height rules[my][their] ∈ [−1,1]. Velocity keeps ' +
        'friction·v each step (graph-side Set Velocity; engine momentum 1). All three tables are live — ' +
        'edit them (or Randomize with a signed range) while playing. rules is ASYMMETRIC: A may chase B ' +
        'while B flees A, which is where the endless pursuit dynamics come from. Presets carry named ' +
        'matrices (snake / rock–paper–scissors / symmetric clusters). N applies on Reset.',
      author: '', projectAuthor: '',
      tags: ['agents', 'particle-life', 'emergence', 'matrix'],
      dimension: is3d ? '3d' : '2d', gridWidth: W, gridHeight: H, gridDepth: D,
      topology: '2d-grid', boundaryTreatment: 'torus',
      useWasm: false, useWebGPU: false,
    },
    topologyMode: { gridCells: false, agents: true },
    centerBased: {
      enabled: true, maxAgents: MAX_AGENTS, maxBonds: 0,
      worldWidth: W, worldHeight: H, ...(is3d ? { worldDepth: D } : {}),
      repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5,
      drag: 1.0, timeStep: 1.0, momentum: 1.0, maxSpeed: 0,
      neighbourQueryRadius: 24, useBondingPhysics: false,
      autoBond: false, growthRate: 0, bondStiffness: 0,
      seedCount: 0, seedPattern: 'scatter', defaultRadius: 1.2,
      agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: {
        motion: 'force', body: true, collision: 'off', bonds: 'off',
        autoBond: false, growth: false, division: false, lifespan: false,
        populationBirth: true, populationDeath: true, sensing: true,
        sensingHeadingSource: 'velocity', orientation: false,
        fieldCoupling: false, appearance: true,
      },
    },
    attributes,
    agentAttributes: [{
      id: 'species', name: 'species', type: 'tag',
      description: 'Particle species — the row/column key of all three interaction tables.',
      isModelAttribute: false, defaultValue: '0', tagOptions: [...SPECIES],
    }],
    modelAttributes: [],
    neighborhoods: [],
    mappings: [],
    agentMappings: [{
      id: 'view_species', name: 'Species', description: 'Colour by species.',
      isAttributeToColor: true, linked: true, linkedAttributeId: 'species',
      linkedColors: { tag: SPECIES_COLORS.map(c => ({ ...c })) },
      redDescription: '', greenDescription: '', blueDescription: '',
    }],
    variables: [],
    indicators: [],
    presets,
    graphNodes: [{ id: newId('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'step', config: {} } }],
    graphEdges: [],
    agentGraphNodes: agentNodes,
    agentGraphEdges: agentEdges,
    macroDefs: [],
  };
}

// =============================================================================
// Emit
// =============================================================================
function emit(model, outPath) {
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      if (prev.properties?.thumbnail) model.properties.thumbnail = prev.properties.thumbnail;
      if (prev.simulationState) model.simulationState = prev.simulationState;
    } catch { /* ignore */ }
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(model, null, 2));
  console.log(`Wrote ${outPath}\n  agent nodes: ${model.agentGraphNodes.length}, edges: ${model.agentGraphEdges.length}, presets: ${model.presets.length}`);
}

emit(buildModel(false), resolve(__dirname, '../public/models/Particle Life.gcaproj'));
if (EMIT_3D) emit(buildModel(true), resolve(__dirname, '../public/models/Particle Life 3D.gcaproj'));
