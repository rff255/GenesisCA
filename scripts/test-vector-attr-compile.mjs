// Compile-level test: a CELL model that WRITES a vector attribute (via Set Vector
// Attribute ← Make Vector) and READS it back (Get Vector Attribute → Break Vector →
// Set a scalar). Confirms lowerVectorAttrs rewrites it into per-component scalar
// float reads/writes that the JS compiler emits — the storage half of the feature.
//   Run from the repo root:  node scripts/test-vector-attr-compile.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileGraph, compileAgentGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { migrateForHarness } from '../src/dev/compileHarness.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-vac-'));
const entryPath = join(ROOT, 'scripts', '__vac_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

const nid = (p) => p + Math.random().toString(36).slice(2, 8);
const N = [], E = [];
const node = (t, c = {}) => { const n = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; N.push(n); return n; };
const edge = (s, sp, tt, tp, cat) => E.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });

const step = node('step');
const mv = node('makeVector', { _port_x: '3', _port_y: '4' });
const setVec = node('setVectorAttribute', { attributeId: 'heading' });
const getVec = node('getVectorAttribute', { attributeId: 'heading' });
const bv = node('breakVector');
const setMag = node('setAttribute', { attributeId: 'mag' });
edge(step, 'do', setVec, 'do', 'flow');
edge(mv, 'vector', setVec, 'value', 'value');
edge(setVec, 'next', setMag, 'do', 'flow');
edge(getVec, 'value', bv, 'vector', 'value');
edge(bv, 'x', setMag, 'value', 'value');

const raw = {
  schemaVersion: 1,
  properties: { name: 'VecCell', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false, updateMode: 'synchronous' },
  attributes: [
    { id: 'heading', name: 'Heading', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '1,0' },
    { id: 'mag', name: 'Mag', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
  ],
  modelAttributes: [], neighborhoods: [], variables: [], indicators: [], mappings: [],
  graphNodes: N, graphEdges: E, macroDefs: [],
};
const model = m.migrateForHarness(raw);
const res = m.compileGraph(model.graphNodes, model.graphEdges, model);

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
if (res.error) { console.log(`COMPILE ERROR: ${res.error}`); process.exit(1); }
const code = res.stepCode;
// The vector WRITE lowered to two scalar component writes with the Make Vector literals.
check('writes heading_vx = 3', /w_heading_vx\[[^\]]*\]\s*=\s*3\b/.test(code));
check('writes heading_vy = 4', /w_heading_vy\[[^\]]*\]\s*=\s*4\b/.test(code));
// The vector READ lowered to a scalar component read feeding mag.
check('reads r_heading_vx', /r_heading_vx\[/.test(code));
// The read goes through an intermediate var (const _v.. = r_heading_vx[idx]); mag
// is then assigned that var — follow the chain.
const rd = code.match(/const (_v\w+) = r_heading_vx\[/);
check('writes mag from heading_vx', !!rd && new RegExp(`w_mag\\[[^\\]]*\\]\\s*=\\s*${rd[1]}\\b`).test(code));
// No un-lowered vector node names survive into the emitted code.
check('no getVectorAttribute leak', !/getVectorAttribute|setVectorAttribute/.test(code));
// The SoA loop-param signature carries the component attrs (not a bare vector id).
const sig = code.slice(0, code.indexOf(')'));
check('signature has all 4 component params', ['r_heading_vx', 'r_heading_vy', 'w_heading_vx', 'w_heading_vy'].every(p => sig.includes(p)));
check('signature has no bare vector param', !/[ ,(]heading[,)]/.test(sig) && !/_heading[,)]/.test(sig));

if (fail) { console.log('\n--- emitted stepCode ---\n' + code.slice(0, 1400)); }
console.log(`${fail === 0 ? 'VECTOR-ATTR JS CELL COMPILE ✓' : `${fail} CELL FAILED`}  (${pass} passed)`);

// ── JS AGENT path: same vector store/read on the agent behaviour graph ─────────
{
  const AN = [], AE = [];
  const an = (t, c = {}) => { const n = { id: nid('a'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; AN.push(n); return n; };
  const ae = (s, sp, tt, tp, cat) => AE.push({ id: nid('e'), source: s.id, target: tt.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  const bs = an('behaviourStep');
  const mv2 = an('makeVector', { _port_x: '7', _port_y: '9' });
  const setV = an('setVectorAttribute', { attributeId: 'facing' });
  ae(bs, 'do', setV, 'do', 'flow');
  ae(mv2, 'vector', setV, 'value', 'value');
  const rawA = {
    schemaVersion: 1,
    properties: { name: 'VecAgent', dimension: '2d', gridWidth: 8, gridHeight: 8, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus' },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 50, maxBonds: 0, worldWidth: 8, worldHeight: 8, defaultRadius: 0.5, agentTarget: 'js', agentUpdateMode: 'async', agentCapabilities: { motion: 'force', body: true } },
    attributes: [], modelAttributes: [], neighborhoods: [], variables: [], indicators: [], mappings: [],
    agentAttributes: [{ id: 'facing', name: 'Facing', type: 'vector', vectorDims: 2, description: '', isModelAttribute: false, defaultValue: '1,0' }],
    agentVariables: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: AN, agentGraphEdges: AE, macroDefs: [],
  };
  const modelA = m.migrateForHarness(rawA);
  const resA = m.compileAgentGraph(modelA.agentGraphNodes, modelA.agentGraphEdges, modelA);
  const ac = (n, c) => { if (!c) { fail++; console.log('FAIL agent ' + n); } };
  if (resA.error) { console.log('AGENT COMPILE ERROR: ' + resA.error); fail++; }
  const bc = resA.behaviourCode || '';
  ac('writes facing_vx = 7', /w_facing_vx\[[^\]]*\]\s*=\s*7\b/.test(bc));
  ac('writes facing_vy = 9', /w_facing_vy\[[^\]]*\]\s*=\s*9\b/.test(bc));
  ac('no vector-node leak', !/getVectorAttribute|setVectorAttribute/.test(bc));
  ac('signature has facing_vx/_vy, no bare facing', /r_facing_vx|w_facing_vx/.test(bc) && !/[ ,(]facing[,)]/.test(bc.slice(0, bc.indexOf(')'))));
  console.log(`VECTOR-ATTR JS AGENT COMPILE ${fail === 0 ? '✓' : '✗'}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL JS VECTOR-ATTR COMPILE CHECKS ✓' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
