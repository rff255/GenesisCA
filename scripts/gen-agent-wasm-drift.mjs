#!/usr/bin/env node
/**
 * Generates public/models/Agent WASM Drift Test.gcaproj — a MINIMAL, fully
 * DETERMINISTIC Bond-Graph Agents model used to prove JS↔WASM agent-loop
 * BIT-PARITY for PR6b-1 (the WASM agent-loop architecture skeleton).
 *
 * The rule (spring toward the world centre, no RNG, no neighbours, no bonds):
 *   behaviourStep:
 *     fx = (cx - myX) * k          // pull toward centre X
 *     fy = (cy - myY) * k          // pull toward centre Y
 *     applyForce(fx, fy)
 *     setTargetRadius(0.5)         // keep radius constant (growthRate 0 anyway)
 *
 * Exercises EXACTLY the PR6b-1 supported node set: behaviourStep, getSelfPosition,
 * getConstant, arithmeticOperator (Math), applyForce, setTargetRadius. Seeded
 * COMPACT (no Math.random in the seed), momentum 0 (overdamped), 2D — so the
 * trajectory is reproducible and the engine force-integration + structural phase
 * (shared JS on both targets) makes JS and WASM bit-identical given identical
 * per-step forces.
 *
 * Re-run: node scripts/gen-agent-wasm-drift.mjs  (preserves thumbnail/simState).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Agent WASM Drift Test.gcaproj');

const usedIds = new Set();
function newId(prefix) {
  let id;
  do { id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

const agentNodes = [];
const agentEdges = [];
function node(nodeType, config, col, row) {
  const n = { id: newId('a'), type: 'caNode', position: { x: col * 230, y: row * 95 }, data: { nodeType, config } };
  agentNodes.push(n);
  return n;
}
function edge(s, sp, t, tp, cat) {
  agentEdges.push({ id: newId('e'), source: s.id, target: t.id,
    sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
}
const vEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
const fEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

const W = 60, H = 60;
const K = 0.05;       // spring constant toward centre
const CX = W / 2, CY = H / 2;

// --- agent rule graph ---
const bs = node('behaviourStep', {}, 0, 2);
const pos = node('getSelfPosition', {}, 1, 2);

// fx = (cx - myX) * k   →   Math('-', cx, myX) then Math('*', that, k)
const cxConst = node('getConstant', { constType: 'float', constValue: String(CX) }, 1, 0);
const dx = node('arithmeticOperator', { operation: '-' }, 2, 0);   // cx - myX
vEdge(cxConst, 'value', dx, 'x');
vEdge(pos, 'x', dx, 'y');
const fx = node('arithmeticOperator', { operation: '*', _port_y: String(K) }, 3, 0); // (cx-myX) * k
vEdge(dx, 'result', fx, 'x');

const cyConst = node('getConstant', { constType: 'float', constValue: String(CY) }, 1, 4);
const dy = node('arithmeticOperator', { operation: '-' }, 2, 4);   // cy - myY
vEdge(cyConst, 'value', dy, 'x');
vEdge(pos, 'y', dy, 'y');
const fy = node('arithmeticOperator', { operation: '*', _port_y: String(K) }, 3, 4); // (cy-myY) * k
vEdge(dy, 'result', fy, 'x');

const af = node('applyForce', {}, 4, 2);
vEdge(fx, 'result', af, 'fx');
vEdge(fy, 'result', af, 'fy');
fEdge(bs, 'do', af, 'do');

const str = node('setTargetRadius', { _port_value: '0.5' }, 5, 2);
fEdge(af, 'next', str, 'do');

// =============================================================================
const model = {
  schemaVersion: 1,
  properties: {
    name: 'Agent WASM Drift Test',
    description: 'Minimal deterministic agents (spring toward centre) — the JS↔WASM agent-loop bit-parity vehicle for PR6b-1.',
    ruleDescription: 'Each agent reads its own position, computes a centre-pulling force ((centre − pos)·k), and applies it. No RNG, no neighbours, no bonds — fully deterministic, so JS and WASM agent loops must be bit-identical.',
    author: '', projectAuthor: '', tags: ['agents', 'wasm', 'test', 'parity'],
    dimension: '2d', gridWidth: W, gridHeight: H, gridDepth: 1,
    topology: '2d-grid', boundaryTreatment: 'constant',
    useWasm: false, useWebGPU: false,
  },
  topologyMode: { gridCells: true, agents: true },
  centerBased: {
    enabled: true, maxAgents: 64, maxBonds: 2, worldWidth: W, worldHeight: H,
    seedCount: 16, seedPattern: 'compact', defaultRadius: 0.5, growthRate: 0,
    repulsionStiffness: 2.0, adhesionStiffness: 0.0, interactionRange: 1.5, drag: 1.0, timeStep: 0.1,
    momentum: 0.0, maxSpeed: 0.0, neighbourQueryRadius: 5.0, customForcesOnly: false,
    autoBond: false, bondStiffness: 1.0, bondRestLength: 1.0, formDistance: 1.1, breakDistance: 1.6,
    // PR6b-1: select the WASM agent target (the gate runs the model on WASM only
    // if isAgentGraphWasmSupported — this model is, so it does).
    agentTarget: 'wasm',
  },
  attributes: [],
  modelAttributes: [],
  neighborhoods: [],
  mappings: [],
  variables: [],
  indicators: [],
  graphNodes: [{ id: newId('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'step', config: {} } }],
  graphEdges: [],
  agentGraphNodes: agentNodes,
  agentGraphEdges: agentEdges,
  macroDefs: [],
};

if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    if (prev.properties?.thumbnail) model.properties.thumbnail = prev.properties.thumbnail;
    if (prev.simulationState) model.simulationState = prev.simulationState;
  } catch { /* ignore */ }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2));
console.log(`Wrote ${OUT}\n  agent nodes: ${agentNodes.length}, edges: ${agentEdges.length}`);
