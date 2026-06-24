#!/usr/bin/env node
/**
 * Generates public/models/Ant Necrophoresis.gcaproj — a STIGMERGY model from the
 * Generic Agent Platform: worker ants cluster dead-ant "corpses" into cemeteries
 * via a simple density-dependent pick-up / drop rule (Deneubourg et al.).
 *
 * It exercises the closed agent↔grid feedback (the field bridge) + the agent
 * compute stack:
 *   - `corpse` is a CELL attribute (the environment/field), agentAccess readWrite.
 *   - Ants (agents, `carrying` bool) random-walk via Apply Force.
 *   - Read Cells Under(corpse) → the LOCAL corpse density under each ant.
 *   - Empty-handed: PICK UP probability is HIGH where density is LOW (isolated
 *     corpse), via a sigmoid — Affect Cells Under(corpse, subtract).
 *   - Carrying: DROP probability is HIGH where density is HIGH (a growing pile),
 *     via the inverse sigmoid — Affect Cells Under(corpse, add). Autocatalytic:
 *     piles attract more drops, so clusters self-enhance (sigmoidal growth).
 *   - The corpse field is seeded ~18% by the CELL Init Event; a linked Output
 *     Mapping renders it as a heatmap, ants drawn on top (red = carrying).
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

// --- CELL graph (the substrate: seed + render the corpse field) ---
const cn = [], ce = [];
const cnode = (nodeType, config, col, row) => { const n = { id: newId('c'), type: 'caNode', position: { x: col * 210, y: row * 90 }, data: { nodeType, config: config || {} } }; cn.push(n); return n; };
const cV = (s, sp, t, tp) => ce.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
const cF = (s, sp, t, tp) => ce.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });
cnode('step', {}, 0, 0);
const ie = cnode('initEvent', {}, 0, 2);
const seedRnd = cnode('getRandom', { randomType: 'bool', _port_probability: '0.18' }, 1, 1);
const seedSet = cnode('setAttribute', { attributeId: 'corpse' }, 2, 2);
cV(seedRnd, 'value', seedSet, 'value');
cF(ie, 'do', seedSet, 'do');

// --- AGENT graph (the necrophoresis rule) ---
const an = [], ae = [];
const anode = (nodeType, config, col, row) => { const n = { id: newId('a'), type: 'caNode', position: { x: col * 210, y: row * 88 }, data: { nodeType, config: config || {} } }; an.push(n); return n; };
const aV = (s, sp, t, tp) => ae.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_value_${sp}`, targetHandle: `input_value_${tp}` });
const aF = (s, sp, t, tp) => ae.push({ id: newId('e'), source: s.id, target: t.id, sourceHandle: `output_flow_${sp}`, targetHandle: `input_flow_${tp}` });

const bs = anode('behaviourStep', {}, 0, 4);
// 1. random walk
const r1 = anode('getRandom', { randomType: 'float' }, 1, 0);
const r2 = anode('getRandom', { randomType: 'float' }, 1, 1.2);
const wx = anode('expression', { expression: '(a-0.5)*1.4', visibleCount: 1 }, 2, 0);
aV(r1, 'value', wx, 'a');
const wy = anode('expression', { expression: '(a-0.5)*1.4', visibleCount: 1 }, 2, 1.2);
aV(r2, 'value', wy, 'a');
const af = anode('applyForce', {}, 3, 0.6);
aV(wx, 'result', af, 'fx');
aV(wy, 'result', af, 'fy');
// colour by carrying
const myCarry = anode('getCellAttribute', { attributeId: 'carrying' }, 1, 3);
const cc = anode('categoricalColor', { count: 2, entry_0_r: 150, entry_0_g: 150, entry_0_b: 160, entry_1_r: 235, entry_1_g: 70, entry_1_b: 70, default_r: 0, default_g: 0, default_b: 0 }, 2, 3);
aV(myCarry, 'value', cc, 'index');
const scl = anode('setCellLooks', { mappingId: '__current__' }, 3, 3);
aV(cc, 'r', scl, 'r'); aV(cc, 'g', scl, 'g'); aV(cc, 'b', scl, 'b');
// 2. sense local corpse density
const dens = anode('readCellsUnder', { attributeId: 'corpse', reduce: 'mean' }, 1, 5);
// inject a radius via inline (_port already default 2). Use a bigger radius.
dens.data.config._port_radius = '3';
// 3. decision: if carrying → maybe drop; else → maybe pick.
const condCarry = anode('conditional', {}, 4, 4);
aV(myCarry, 'value', condCarry, 'condition');
// DROP branch (carrying): pDrop = 1/(1+exp(-10*(d-0.12)))  (rises with density)
const pDrop = anode('expression', { expression: '1/(1+exp(-10*(a-0.12)))', visibleCount: 1 }, 5, 1.5);
aV(dens, 'value', pDrop, 'a');
const dropRoll = anode('getRandom', { randomType: 'float' }, 5, 2.6);
const dropCmp = anode('statement', { operation: '<', compareType: 'numerical' }, 6, 2);
aV(dropRoll, 'value', dropCmp, 'x'); aV(pDrop, 'result', dropCmp, 'y');
const condDrop = anode('conditional', {}, 7, 2);
aV(dropCmp, 'result', condDrop, 'condition');
const dropAffect = anode('affectCellsUnder', { attributeId: 'corpse', op: 'add', _port_value: '1', _port_radius: '0.8' }, 8, 1.5);
const setDropped = anode('setAttribute', { attributeId: 'carrying', _port_value: 'false' }, 9, 1.5);
aF(condDrop, 'then', dropAffect, 'do');
aF(dropAffect, 'next', setDropped, 'do');
aF(condCarry, 'then', condDrop, 'check');
// PICK branch (empty): pPick = 1/(1+exp(10*(d-0.12)))  (falls with density);
// also require some corpse present (density > 0.02).
const pPick = anode('expression', { expression: '1/(1+exp(10*(a-0.12)))', visibleCount: 1 }, 5, 5);
aV(dens, 'value', pPick, 'a');
const pickRoll = anode('getRandom', { randomType: 'float' }, 5, 6);
const pickCmp = anode('statement', { operation: '<', compareType: 'numerical' }, 6, 5);
aV(pickRoll, 'value', pickCmp, 'x'); aV(pPick, 'result', pickCmp, 'y');
const hasCorpse = anode('statement', { operation: '>', compareType: 'numerical', _port_y: '0.02' }, 6, 6.2);
aV(dens, 'value', hasCorpse, 'x');
const pickAnd = anode('logicOperator', { operation: 'AND' }, 7, 5.5);
aV(pickCmp, 'result', pickAnd, 'a'); aV(hasCorpse, 'result', pickAnd, 'b');
const condPick = anode('conditional', {}, 8, 5.5);
aV(pickAnd, 'result', condPick, 'condition');
const pickAffect = anode('affectCellsUnder', { attributeId: 'corpse', op: 'subtract', _port_value: '1', _port_radius: '0.8' }, 9, 5);
const setPicked = anode('setAttribute', { attributeId: 'carrying', _port_value: 'true' }, 10, 5);
aF(condPick, 'then', pickAffect, 'do');
aF(pickAffect, 'next', setPicked, 'do');
aF(condCarry, 'else', condPick, 'check');
// behaviour flow chain: walk → colour → decision
aF(bs, 'do', af, 'do');
aF(af, 'next', scl, 'do');
aF(scl, 'next', condCarry, 'check');

const W = 60, H = 60;
const model = {
  schemaVersion: 1,
  properties: {
    name: 'Ant Necrophoresis',
    description: 'Worker ants cluster corpses into cemeteries by a density-dependent pick-up/drop rule — stigmergy via the agent↔grid field bridge. The classic self-organising clustering of Deneubourg et al.',
    ruleDescription: 'The `corpse` cell attribute is the shared field. Ants (agents) random-walk and sense the local corpse density (Read Cells Under). Empty-handed, an ant picks up a corpse with a probability that FALLS with density (isolated corpses get carried off). Carrying, it drops with a probability that RISES with density (onto growing piles) — autocatalytic, so a few clusters win and grow sigmoidally. Colour: red = carrying.',
    author: 'Deneubourg et al.', modelAuthor: '', tags: ['agents', 'stigmergy', 'necrophoresis', 'self-organisation', 'field'],
    dimension: '2d', gridWidth: W, gridHeight: H, gridDepth: 1, topology: '2d-grid',
    boundaryTreatment: 'torus', updateMode: 'synchronous', asyncScheme: 'random-order',
    maxIterations: 0, useWasm: false, useWebGPU: false,
  },
  topologyMode: { gridCells: true, agents: true },
  centerBased: {
    enabled: true, maxAgents: 120, maxBonds: 2, worldWidth: W, worldHeight: H,
    seedCount: 70, seedPattern: 'scatter', defaultRadius: 0.9, growthRate: 0,
    repulsionStiffness: 0, adhesionStiffness: 0, interactionRange: 1.5, drag: 1.0, timeStep: 0.6,
    momentum: 0.55, maxSpeed: 0.9, neighbourQueryRadius: 4, customForcesOnly: true, autoBond: false,
    agentUpdateMode: 'async',
  },
  attributes: [{ id: 'corpse', name: 'corpse', type: 'float', description: 'Dead-ant density (the field ants cluster)', isModelAttribute: false, defaultValue: '0', agentAccess: 'readWrite' }],
  agentAttributes: [{ id: 'carrying', name: 'carrying', type: 'bool', description: 'Is the ant carrying a corpse?', isModelAttribute: false, defaultValue: 'false' }],
  neighborhoods: [],
  mappings: [{
    id: 'viz', name: 'Corpse field', description: 'Corpse density heatmap (ants drawn on top)', isAttributeToColor: true,
    redDescription: '', greenDescription: '', blueDescription: '',
    linked: true, linkedAttributeId: 'corpse', linkedMin: 0, linkedMax: 4,
    linkedColors: { method: 'linear', gradient: [
      { position: 0, r: 18, g: 18, b: 26 }, { position: 0.35, r: 60, g: 40, b: 30 },
      { position: 0.7, r: 170, g: 120, b: 50 }, { position: 1, r: 250, g: 230, b: 150 },
    ] },
  }],
  variables: [], agentVariables: [],
  indicators: [],
  graphNodes: cn, graphEdges: ce,
  agentGraphNodes: an, agentGraphEdges: ae, macroDefs: [],
};

if (existsSync(OUT)) {
  try { const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.properties?.thumbnail) model.properties.thumbnail = prev.properties.thumbnail;
    if (prev.simulationState) model.simulationState = prev.simulationState;
  } catch { /* ignore */ }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2));
console.log('Wrote ' + OUT + '  cell nodes: ' + cn.length + ', agent nodes: ' + an.length);
