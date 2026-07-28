#!/usr/bin/env node
/**
 * Generates public/models/Ant Necrophoresis.gcaproj — the classic Deneubourg
 * corpse-clustering (necrophoresis) model, done DISCRETELY and with EXACT MASS
 * CONSERVATION.
 *
 * The invariant this model is built around:
 *
 *     (corpses lying on the grid) + (corpses being carried) = constant
 *
 * How that is guaranteed structurally:
 *   - `corpse` is an INTEGER cell attribute holding 0 or 1 — a corpse is a
 *     discrete item occupying a cell, never a decimal density.
 *   - Ants live on INTEGER cell positions. They are spawned at integer cells by
 *     the Agent Init Event and moved one cell per step by Set Position (the
 *     engine integrator is inert: no forces, momentum 0, so it only re-wraps the
 *     torus). Because the position is exactly integral, an r = 0.5 disk covers
 *     EXACTLY ONE cell — so Read/Affect Cells Under act on the single cell the
 *     ant stands on, never a smeared blob.
 *   - PICK UP is gated on `cell == 1` and writes `set 0`; DROP is gated on
 *     `cell == 0` and writes `set 1`. Both are `set`, not add/subtract, so the
 *     field can never leave {0, 1} and mass can never be manufactured.
 *   - Each ant carries at most one corpse (`carrying` is a bool), and the agent
 *     loop is SEQUENTIAL on the JS/WASM agent targets, so two ants can never
 *     take the same corpse in one step.
 *
 * The rule (Deneubourg et al. 1991 / Bonabeau et al.), with f = the fraction of
 * occupied cells in the ant's sensing disk:
 *   - empty-handed, standing on a corpse:  P(pick) = (k1 / (k1 + f))²   — falls with density
 *   - carrying,     standing on empty:     P(drop) = (f  / (k2 + f))²   — rises with density
 * Autocatalytic: piles are unlikely to be robbed and likely to be added to, so a
 * few cemeteries win and grow.
 *
 * Re-run: node scripts/gen-ant-necrophoresis.mjs   (preserves thumbnail/state)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Ant Necrophoresis.gcaproj');

let c = 0;
const newId = (p) => p + (c++).toString(36) + Math.random().toString(36).slice(2, 6);

// --- CELL graph (the substrate: seed the corpse field; the grid has no rule) ---
const cn = [], ce = [];
const cnode = (nodeType, config, col, row) => { const n = { id: newId('c'), type: 'caNode', position: { x: col * 215, y: row * 95 }, data: { nodeType, config: config || {} } }; cn.push(n); return n; };
const cV = (s, sp, t, tp) => ce.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
const cF = (s, sp, t, tp) => ce.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });

// Corpses never move on their own — the Generation Step is intentionally empty.
cnode('step', {}, 0, 0);
const ie = cnode('initEvent', {}, 0, 2);
const gmSeed = cnode('getModelAttribute', { attributeId: 'seedDensity' }, 0, 3.2);
const seedRnd = cnode('getRandom', { randomType: 'bool' }, 1, 3.2);
cV(gmSeed, 'value', seedRnd, 'probability');
const seedSet = cnode('setAttribute', { attributeId: 'corpse' }, 2, 2);
cV(seedRnd, 'value', seedSet, 'value');
cF(ie, 'do', seedSet, 'do');

// --- AGENT graph ---
const an = [], ae = [];
const anode = (nodeType, config, col, row) => { const n = { id: newId('a'), type: 'caNode', position: { x: col * 215, y: row * 95 }, data: { nodeType, config: config || {} } }; an.push(n); return n; };
const aV = (s, sp, t, tp) => ae.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
const aF = (s, sp, t, tp) => ae.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });

// ---- Agent Init Event: spawn `ants` workers on integer cells -----------------
const ai = anode('agentInit', {}, 0, 0);
const gmAnts = anode('getModelAttribute', { attributeId: 'ants' }, 0, 1.2);
const iLoop = anode('loop', { mode: 'count' }, 1, 0);
aV(gmAnts, 'value', iLoop, 'count');
aF(ai, 'do', iLoop, 'do');
const iDims = anode('getGridDimensions', {}, 1, 2);
const iRx = anode('getRandom', { randomType: 'float' }, 2, 1);
const iRy = anode('getRandom', { randomType: 'float' }, 2, 2);
// floor(u * W) → a uniform integer cell column/row (grid-size independent).
const iEx = anode('expression', { expression: 'floor(u*W)', visibleCount: 2, _varName_a: 'u', _varName_b: 'W' }, 3, 1);
aV(iRx, 'value', iEx, 'a'); aV(iDims, 'width', iEx, 'b');
const iEy = anode('expression', { expression: 'floor(u*H)', visibleCount: 2, _varName_a: 'u', _varName_b: 'H' }, 3, 2);
aV(iRy, 'value', iEy, 'a'); aV(iDims, 'height', iEy, 'b');
const iCreate = anode('createAgent', { _port_radius: '0.42' }, 4, 0);
aV(iEx, 'result', iCreate, 'x'); aV(iEy, 'result', iCreate, 'y');
const iAdd = anode('addAgentToWorld', {}, 5, 0);
aV(iCreate, 'handle', iAdd, 'handle');
aF(iLoop, 'body', iCreate, 'do');
aF(iCreate, 'next', iAdd, 'do');

// ---- Behaviour Step ---------------------------------------------------------
const bs = anode('behaviourStep', {}, 0, 5);

// Sensing. `here` = the single cell under the ant (r = 0.5 at an integer
// position covers exactly one cell); `dens` = the occupied FRACTION over the
// sensing disk (mean of a 0/1 field).
const gmSense = anode('getModelAttribute', { attributeId: 'senseRadius' }, 0, 6.4);
const dens = anode('readCellsUnder', { attributeId: 'corpse', reduce: 'mean' }, 1, 6.4);
aV(gmSense, 'value', dens, 'radius');
const here = anode('readCellsUnder', { attributeId: 'corpse', reduce: 'max', _port_radius: '0.5' }, 1, 7.6);
const carry = anode('getCellAttribute', { attributeId: 'carrying' }, 1, 5);

// The decision is BRANCH-FREE: one dice roll, one probability, one action.
// Carrying selects which probability / which cell test / which write applies
// (Value Switch), instead of two mirrored branches. That keeps every random
// draw on the single top-level path, so each ant consumes the shared RNG
// stream in exactly the same order on every compile target.

// P(drop) = (f/(k2+f))²  — rises with density; P(pick) = (k1/(k1+f))² — falls.
const gmK2 = anode('getModelAttribute', { attributeId: 'k2' }, 2, 3.4);
const pDrop = anode('expression', { expression: 'pow(f/(f+k2),2)', visibleCount: 2, _varName_a: 'f', _varName_b: 'k2' }, 3, 3.4);
aV(dens, 'value', pDrop, 'a'); aV(gmK2, 'value', pDrop, 'b');
const gmK1 = anode('getModelAttribute', { attributeId: 'k1' }, 2, 4.6);
const pPick = anode('expression', { expression: 'pow(k1/(f+k1),2)', visibleCount: 2, _varName_a: 'f', _varName_b: 'k1' }, 3, 4.6);
aV(dens, 'value', pPick, 'a'); aV(gmK1, 'value', pPick, 'b');
const pAct = anode('valueSwitch', {}, 4, 4);
aV(carry, 'value', pAct, 'condition'); aV(pDrop, 'result', pAct, 'ifValue'); aV(pPick, 'result', pAct, 'elseValue');

// ONE random draw serves the whole step — the dice roll AND the walk direction.
// u is split into a direction index k = floor(u*9) (the 3x3 step neighbourhood)
// and the leftover fraction roll = u*9 - k, which is still uniform in [0,1).
// A single draw means every compile target advances the shared RNG stream
// exactly once per ant, in the same place — no ordering to disagree about.
const rU = anode('getRandom', { randomType: 'float' }, 3, 6);
const eK = anode('expression', { expression: 'floor(u*9)', visibleCount: 1, _varName_a: 'u' }, 4, 6);
aV(rU, 'value', eK, 'a');
const roll = anode('expression', { expression: 'u*9 - k', visibleCount: 2, _varName_a: 'u', _varName_b: 'k' }, 5, 6);
aV(rU, 'value', roll, 'a'); aV(eK, 'result', roll, 'b');
const probOk = anode('statement', { operation: '<', compareType: 'numerical' }, 6, 4.6);
aV(roll, 'result', probOk, 'x'); aV(pAct, 'result', probOk, 'y');

// A drop needs an EMPTY cell; a pick-up needs an OCCUPIED one. Both gates are
// what make the transfer conservative.
const cellEmpty = anode('statement', { operation: '<', compareType: 'numerical', _port_y: '0.5' }, 4, 6.4);
aV(here, 'value', cellEmpty, 'x');
const cellFull = anode('statement', { operation: '>', compareType: 'numerical', _port_y: '0.5' }, 4, 7.6);
aV(here, 'value', cellFull, 'x');
const cellOk = anode('valueSwitch', {}, 5, 7);
aV(carry, 'value', cellOk, 'condition'); aV(cellEmpty, 'result', cellOk, 'ifValue'); aV(cellFull, 'result', cellOk, 'elseValue');

const act = anode('logicOperator', { operation: 'AND' }, 6, 5.5);
aV(probOk, 'result', act, 'a'); aV(cellOk, 'result', act, 'b');
const condAct = anode('conditional', {}, 7, 5.5);
aV(act, 'result', condAct, 'condition');

// Carrying → put a corpse down (cell 1, carrying false); empty-handed → take it
// up (cell 0, carrying true). `set`, never add/subtract, so the cell value can
// only ever be 0 or 1.
const newCell = anode('valueSwitch', { _port_ifValue: '1', _port_elseValue: '0' }, 7, 3.6);
aV(carry, 'value', newCell, 'condition');
const newCarry = anode('valueSwitch', { _port_ifValue: '0', _port_elseValue: '1' }, 7, 7.4);
aV(carry, 'value', newCarry, 'condition');
const transfer = anode('affectCellsUnder', { attributeId: 'corpse', op: 'set', _port_radius: '0.5' }, 8, 4.6);
aV(newCell, 'result', transfer, 'value');
const setCarry = anode('setAttribute', { attributeId: 'carrying' }, 9, 4.6);
aV(newCarry, 'result', setCarry, 'value');
aF(bs, 'do', condAct, 'check');
aF(condAct, 'then', transfer, 'do');
aF(transfer, 'next', setCarry, 'do');

// ---- Colour -----------------------------------------------------------------
// The post-action carrying state, computed purely (act ? newCarry : carry) —
// no second read of the attribute, so every target colours the same ant red.
const shownCarry = anode('expression', { expression: 'c + act*(1-2*c)', visibleCount: 2, _varName_a: 'act', _varName_b: 'c' }, 10, 6.2);
aV(act, 'result', shownCarry, 'a');
aV(carry, 'value', shownCarry, 'b');
const cc = anode('categoricalColor', {
  count: 2,
  entry_0_r: 140, entry_0_g: 145, entry_0_b: 160,   // empty-handed worker
  entry_1_r: 240, entry_1_g: 70, entry_1_b: 60,     // carrying a corpse
  default_r: 255, default_g: 255, default_b: 255,
}, 11, 5.2);
aV(shownCarry, 'result', cc, 'index');
const scl = anode('setCellLooks', { mappingId: '__current__' }, 11, 5.2);
aV(cc, 'r', scl, 'r'); aV(cc, 'g', scl, 'g'); aV(cc, 'b', scl, 'b');
aF(condAct, 'next', scl, 'do');

// ---- Move: exactly one cell per step, on the integer lattice ----------------
// dx, dy ∈ {-1, 0, 1}; the new coordinate is wrapped by hand so the ant stays on
// an exact integer cell (the engine integrator is inert: no forces, momentum 0).
const pos = anode('getSelfPosition', {}, 11, 6.6);
const bDims = anode('getGridDimensions', {}, 11, 7.8);
// dx, dy ∈ {-1,0,1} decoded from the same draw's direction index k.
const dxR = anode('expression', { expression: '(k - floor(k/3)*3) - 1', visibleCount: 1, _varName_a: 'k' }, 11, 9);
aV(eK, 'result', dxR, 'a');
const dyR = anode('expression', { expression: 'floor(k/3) - 1', visibleCount: 1, _varName_a: 'k' }, 11, 10);
aV(eK, 'result', dyR, 'a');
const nx = anode('expression', { expression: '(x+dx) - floor((x+dx)/W)*W', visibleCount: 3, _varName_a: 'x', _varName_b: 'dx', _varName_c: 'W' }, 12, 6.6);
aV(pos, 'x', nx, 'a'); aV(dxR, 'result', nx, 'b'); aV(bDims, 'width', nx, 'c');
const ny = anode('expression', { expression: '(y+dy) - floor((y+dy)/H)*H', visibleCount: 3, _varName_a: 'y', _varName_b: 'dy', _varName_c: 'H' }, 12, 8);
aV(pos, 'y', ny, 'a'); aV(dyR, 'result', ny, 'b'); aV(bDims, 'height', ny, 'c');
const self = anode('getSelfHandle', {}, 12, 5.4);
const move = anode('setAgentPosition', {}, 13, 6.6);
aV(self, 'handle', move, 'agentId');
aV(nx, 'result', move, 'x'); aV(ny, 'result', move, 'y');
aF(scl, 'next', move, 'do');

const W = 80, H = 80;
const model = {
  schemaVersion: 1,
  properties: {
    name: 'Ant Necrophoresis',
    description: 'Worker ants cluster scattered corpses into cemeteries by a density-dependent pick-up / drop rule — stigmergy through the agent↔grid field bridge. Corpses are discrete items and the total is exactly conserved.',
    ruleDescription: [
      'Each cell holds 0 or 1 corpse (the `corpse` integer attribute — the shared field). Ants are agents on integer cell positions that step to one of their 8 neighbours (or stay) each generation.',
      '',
      'An ant senses f, the fraction of occupied cells within Sense Radius. Empty-handed and standing ON a corpse it picks it up with probability (k1/(k1+f))², which FALLS with density — isolated corpses get carried off. Carrying and standing on an EMPTY cell it drops with probability (f/(k2+f))², which RISES with density — corpses land on growing piles. That feedback is autocatalytic, so a few cemeteries win and grow.',
      '',
      'Mass conservation is structural, not approximate: a pick-up is gated on the cell holding a corpse and writes 0; a drop is gated on the cell being empty and writes 1; each ant carries at most one corpse. So corpses on the ground + corpses in transit is constant, and the "Corpses on ground" indicator only ever dips by at most the number of ants. The agent loop is sequential on the JS/WASM agent targets, so two ants can never claim the same corpse.',
      '',
      'Tune Ants, Seed Density, Sense Radius, and the pick/drop constants k1 and k2 live; Ants and Seed Density apply on Reset. Colour: red = carrying.',
    ].join('\n'),
    author: 'Deneubourg et al.', modelAuthor: '', tags: ['agents', 'stigmergy', 'necrophoresis', 'self-organisation', 'field'],
    dimension: '2d', gridWidth: W, gridHeight: H, gridDepth: 1, topology: '2d-grid',
    boundaryTreatment: 'torus', updateMode: 'synchronous', asyncScheme: 'random-order',
    maxIterations: 0, useWasm: true, useWebGPU: false,
  },
  topologyMode: { gridCells: true, agents: true },
  centerBased: {
    // The engine is fully inert: the ants move ONLY via Set Position, so the
    // integrator must not perturb them (no forces, momentum 0, no growth/bonds).
    // The agent target is WASM, not WebGPU: the sequential agent loop is what
    // guarantees two ants never claim the same corpse in one step.
    enabled: true, agentTarget: 'wasm', maxAgents: 400, maxBonds: 0,
    worldWidth: W, worldHeight: H,
    seedCount: 0, seedPattern: 'scatter', defaultRadius: 0.42, growthRate: 0,
    repulsionStiffness: 0, adhesionStiffness: 0, bondStiffness: 0, interactionRange: 1,
    drag: 1, timeStep: 1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 2,
    customForcesOnly: true, useBondingPhysics: false, autoBond: false,
    agentUpdateMode: 'async',
    agentCapabilities: {
      motion: 'static', body: true, collision: 'off', bonds: 'off', autoBond: false,
      growth: false, division: false, lifespan: false, populationBirth: false,
      populationDeath: false, sensing: false, sensingHeadingSource: 'velocity',
      orientation: false, fieldCoupling: true, appearance: true,
    },
  },
  attributes: [
    { id: 'corpse', name: 'corpse', type: 'integer', description: 'A dead ant lying on this cell (0 or 1) — the field the workers cluster', isModelAttribute: false, defaultValue: '0', agentAccess: 'readWrite' },
    { id: 'ants', name: 'Ants', type: 'integer', description: 'Number of worker ants (applies on Reset)', isModelAttribute: true, defaultValue: '120', hasBounds: true, min: 10, max: 400 },
    { id: 'seedDensity', name: 'Seed Density', type: 'float', description: 'Fraction of cells seeded with a corpse (applies on Reset)', isModelAttribute: true, defaultValue: '0.12', hasBounds: true, min: 0.01, max: 0.5 },
    { id: 'senseRadius', name: 'Sense Radius', type: 'float', description: 'Radius of the disk an ant averages to estimate local corpse density', isModelAttribute: true, defaultValue: '2.5', hasBounds: true, min: 1, max: 6 },
    { id: 'k1', name: 'k1 (pick)', type: 'float', description: 'Pick-up constant — P(pick) = (k1/(k1+f))². Lower = fussier, only truly isolated corpses get lifted.', isModelAttribute: true, defaultValue: '0.1', hasBounds: true, min: 0.01, max: 1 },
    { id: 'k2', name: 'k2 (drop)', type: 'float', description: 'Drop constant — P(drop) = (f/(k2+f))². Lower = drops more readily, so piles seed faster.', isModelAttribute: true, defaultValue: '0.3', hasBounds: true, min: 0.01, max: 1 },
  ],
  agentAttributes: [
    { id: 'carrying', name: 'carrying', type: 'bool', description: 'Is this ant carrying a corpse?', isModelAttribute: false, defaultValue: 'false' },
  ],
  neighborhoods: [],
  mappings: [{
    id: 'viz', name: 'Corpses', description: 'Corpses on the ground (ants drawn on top; red = carrying)', isAttributeToColor: true,
    redDescription: '', greenDescription: '', blueDescription: '',
    linked: true, linkedAttributeId: 'corpse', linkedMin: 0, linkedMax: 1,
    linkedColors: { method: 'linear', gradient: [
      { position: 0, r: 16, g: 16, b: 22 },
      { position: 1, r: 245, g: 225, b: 155 },
    ] },
  }],
  variables: [],
  agentVariables: [],
  indicators: [{
    id: 'ground', name: 'Corpses on ground', kind: 'linked', dataType: 'integer',
    defaultValue: '0', accumulationMode: 'per-generation',
    linkedAttributeId: 'corpse', linkedAggregation: 'total', watched: true,
  }],
  graphNodes: cn, graphEdges: ce,
  agentGraphNodes: an, agentGraphEdges: ae, macroDefs: [],
};

if (existsSync(OUT)) {
  try { const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.properties?.thumbnail) model.properties.thumbnail = prev.properties.thumbnail;
  } catch { /* ignore */ }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2));
console.log('Wrote ' + OUT + '  cell nodes: ' + cn.length + ', agent nodes: ' + an.length);
