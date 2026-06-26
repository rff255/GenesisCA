// Micro-debug: compile a behaviourStep -> setAttribute(out, readCellsUnder/fieldGradient)
// and compare JS vs WASM for ONE agent at a fixed position over a known field.
import { build } from 'esbuild';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { createAgentStore, seedAgents } from '../src/simulator/engine/agentEngine.ts';
export { compileAgentGraphWasmForModel, instantiateAgentWasm, buildAgentLayoutExtras } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-dbg-'));
const entryPath = join(ROOT, 'scripts', '__dbg_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
const { createAgentStore, seedAgents, compileAgentGraphWasmForModel, instantiateAgentWasm, compileAgentGraph } = m;

const nb = (id, t, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config } });
const fe = (s, sh, t, th) => ({ id: s + '->' + t, source: s, sourceHandle: sh, target: t, targetHandle: th });
const W = 40, H = 40;
// graph: behaviour -> setAttribute(out = fieldGradient.dx)
const USE_SECRETE = process.env.SECRETE === '1';
const USE_SAMPLE = process.env.SAMPLE === '1';
const nodes = USE_SECRETE ? [
  nb('beh', 'behaviourStep'),
  nb('sc', 'secreteToField', { attributeId: 'chem', _port_rate: '2.5' }),
  nb('sf', 'sampleField', { attributeId: 'chem' }),
  nb('sa', 'setAttribute', { attributeId: 'out' }),
] : USE_SAMPLE ? [
  nb('beh', 'behaviourStep'),
  nb('sf', 'sampleField', { attributeId: 'chem' }),
  nb('sa', 'setAttribute', { attributeId: 'out' }),
] : [
  nb('beh', 'behaviourStep'),
  nb('fg', 'fieldGradient', { attributeId: 'chem' }),
  nb('sa', 'setAttribute', { attributeId: 'out' }),
];
const PORT = process.env.PORT || 'dx';
const edges = USE_SECRETE ? [
  fe('beh', 'output_flow_do', 'sc', 'input_flow_do'),
  fe('sc', 'output_flow_next', 'sa', 'input_flow_do'),
  fe('sf', 'output_value_value', 'sa', 'input_value_value'),
] : USE_SAMPLE ? [
  fe('beh', 'output_flow_do', 'sa', 'input_flow_do'),
  fe('sf', 'output_value_value', 'sa', 'input_value_value'),
] : [
  fe('beh', 'output_flow_do', 'sa', 'input_flow_do'),
  fe('fg', 'output_value_' + PORT, 'sa', 'input_value_value'),
];
const model = {
  properties: { gridWidth: W, gridHeight: H, dimension: '2d', gridDepth: 1, boundaryTreatment: 'torus' },
  topologyMode: { gridCells: true, agents: true },
  centerBased: { enabled: true, maxAgents: 16, maxBonds: 4, worldWidth: W, worldHeight: H, defaultRadius: 0.5, agentUpdateMode: 'async' },
  agentGraphNodes: nodes, agentGraphEdges: edges, agentVariables: [],
  graphNodes: [], graphEdges: [], macroDefs: [], variables: [],
  attributes: [
    { id: 'out', name: 'out', type: 'float', defaultValue: '0', isModelAttribute: false },
    { id: 'chem', name: 'chem', type: 'float', defaultValue: '0', isModelAttribute: false, agentAccess: 'read' },
  ],
  agentAttributes: [{ id: 'out', name: 'out', type: 'float', defaultValue: '0' }],
  neighborhoods: [], indicators: [], mappings: [],
};

const total = W * H;
const chem = new Float64Array(total);
const MODE = process.env.FIELD || 'noise';
for (let i = 0; i < total; i++) chem[i] = MODE === 'ramp' ? (i % W) : MODE === 'row' ? Math.floor(i / W) : MODE === 'idx' ? i : ((i * 2654435761) % 997) / 997;

const wasmR = compileAgentGraphWasmForModel(model);
if (wasmR.error) { console.log('WASM err', wasmR.error); process.exit(1); }
const jsR = compileAgentGraph(model.agentGraphNodes, model.agentGraphEdges, model, 0);
const jsFn = eval(jsR.behaviourCode);

const specs = [{ id: 'out', type: 'float', defaultValue: 0 }];
const A = createAgentStore(model.centerBased, specs, { wasmBacked: false });
const B = createAgentStore(model.centerBased, specs, { wasmBacked: true, maxHashBins: wasmR.layout.maxHashBins, layoutExtras: { ...m.buildAgentLayoutExtras(model), fieldTotal: total } });
for (const s of [A, B]) { s.worldWidth = W; s.worldHeight = H; s.worldDepth = 1; }
seedAgents(A, [{ x: 8.3, y: 8.7, radius: 0.5 }], 0.5);
seedAgents(B, [{ x: 8.3, y: 8.7, radius: 0.5 }], 0.5);

// JS args (minimal: only the field block matters)
const EMPTY = new Int32Array(0);
function args(s, readChem) {
  const a = [ s.alive, s.highWater, s.x, s.y, s.radius, s.targetRadius, s.age, s.type, s.lineage, s.bondCount, s.density, s.vx, s.vy, s.forceX, s.forceY, 0, EMPTY, EMPTY, 0, 0, 1, 1, s.divideRequest, s.divideAxisX, s.divideAxisY, s.divideAsym, s.killRequest, s.bondPartner, s.bondPartnerEpoch, s.bondRestLength, s.bondStiffness, s.bondTypeLabel, s.maxBonds, s.bondFormReq, s.bondFormL, s.bondFormK, s.bondBreakReq ];
  a.push(s.attrRead['out']); a.push(s.attrWrite['out']);
  a.push({}, s.colors, '', new Float64Array(0), new Uint32Array(1), new Uint32Array(1), new Uint32Array(1), new Uint32Array(1));
  a.push(W, H, total, 1); a.push(readChem);
  return a;
}
jsFn(...args(A, chem));
const buf = B.memory.buffer, BL = B.layout;
new Float64Array(buf, BL.fieldOffset['chem'], total).set(chem);
const inst = await instantiateAgentWasm(wasmR.bytes, B.memory);
inst.behaviour(B.highWater, 0, 0, 0, 0, 1, 1, 1, W, H, 1, 1);
console.log('A.x,y=', A.x[0], A.y[0], ' B.x,y=', B.x[0], B.y[0]);
// dump the 4 cells the dx=sample(8.8,8.7) reads + check WASM region copy
const wchem = new Float64Array(buf, BL.fieldOffset['chem'], total);
let copyOk = true; for (let i = 0; i < total; i++) if (wchem[i] !== chem[i]) { copyOk = false; break; }
console.log('field copy ok:', copyOk);
// JS manual sample at 8.8,8.7
const fs = (px,py)=>{let x0=Math.floor(px),y0=Math.floor(py);const tx=px-x0,ty=py-y0;let x1=x0+1,y1=y0+1;x0=((x0%W)+W)%W;x1=((x1%W)+W)%W;y0=((y0%H)+H)%H;y1=((y1%H)+H)%H;return chem[y0*W+x0]*(1-tx)*(1-ty)+chem[y0*W+x1]*tx*(1-ty)+chem[y1*W+x0]*(1-tx)*ty+chem[y1*W+x1]*tx*ty;};
console.log('JS sampleField manual(8.3,8.7)=', fs(8.3,8.7));
console.log('JS dx manual=', fs(8.8,8.7)-fs(7.8,8.7));
console.log('JS out  =', A.attrRead['out'][0]);
console.log('WASM out=', B.attrRead['out'][0]);
console.log('diff    =', A.attrRead['out'][0] - B.attrRead['out'][0]);
rmSync(entryPath, { force: true }); rmSync(dir, { recursive: true, force: true });
