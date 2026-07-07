// Unit test for the pure vector-attribute lowering helpers (vectorAttr.ts).
//   Run from the repo root:  node scripts/test-vector-attr.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `export * from '../src/modeler/vpl/compiler/vectorAttr.ts';`;
const dir = mkdtempSync(join(tmpdir(), 'gca-vecattr-'));
const entryPath = join(ROOT, 'scripts', '__vecattr_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} want ${w}`); }
};

// dims from model
eq('dims 2D', m.vectorDimsForModel({ properties: { dimension: '2d', gridDepth: 1 } }), 2);
eq('dims 3D', m.vectorDimsForModel({ properties: { dimension: '3d', gridDepth: 8 } }), 3);
eq('dims 3d-1-layer', m.vectorDimsForModel({ properties: { dimension: '3d', gridDepth: 1 } }), 2); // is3dModelLike needs depth>1
eq('dims null', m.vectorDimsForModel(null), 2);

// component ids
eq('ids 2', m.vectorComponentIds('heading', 2), ['heading_vx', 'heading_vy']);
eq('ids 3', m.vectorComponentIds('heading', 3), ['heading_vx', 'heading_vy', 'heading_vz']);
eq('labels 3', m.vectorComponentLabels(3), ['X', 'Y', 'Z']);

// default parse/encode
eq('parse "1,0"', m.parseVectorDefault('1,0', 2), [1, 0]);
eq('parse "1, 2, 3"', m.parseVectorDefault('1, 2, 3', 3), [1, 2, 3]);
eq('parse short', m.parseVectorDefault('5', 3), [5, 0, 0]);
eq('parse empty', m.parseVectorDefault('', 2), [0, 0]);
eq('parse junk', m.parseVectorDefault('a,b', 2), [0, 0]);
eq('encode', m.encodeVectorDefault([1, 0, -2], 3), '1,0,-2');

// isVectorAttr / hasVectorAttrs
eq('isVector', m.isVectorAttr({ type: 'vector' }), true);
eq('isVector float', m.isVectorAttr({ type: 'float' }), false);
eq('isVector null', m.isVectorAttr(null), false);

// expandVectorAttributes — identity when no vector attrs
const scalars = [{ id: 'a', name: 'A', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' }];
eq('expand identity', m.expandVectorAttributes(scalars, 2) === scalars, true);

// expandVectorAttributes — a 2D vector cell FIELD attr (agentAccess inherited) + boundary split
const attrs = [
  { id: 'flow', name: 'Flow', type: 'vector', description: 'field', isModelAttribute: false, defaultValue: '1,-2', boundaryValue: '0,0', agentAccess: 'read' },
  { id: 'x', name: 'X', type: 'integer', description: '', isModelAttribute: false, defaultValue: '0' },
];
const expanded2 = m.expandVectorAttributes(attrs, 2);
eq('expand 2D count', expanded2.length, 3); // flow_vx, flow_vy, x
eq('expand 2D flow_vx', expanded2[0], { id: 'flow_vx', name: 'Flow X', type: 'float', description: 'field', isModelAttribute: false, defaultValue: '1', boundaryValue: '0', agentAccess: 'read' });
eq('expand 2D flow_vy default', expanded2[1].defaultValue, '-2');
eq('expand 2D passthrough', expanded2[2].id, 'x');

// 3D expansion → 3 components
const expanded3 = m.expandVectorAttributes([{ id: 'v', name: 'V', type: 'vector', description: '', isModelAttribute: false, defaultValue: '1,2,3' }], 3);
eq('expand 3D count', expanded3.length, 3);
eq('expand 3D ids', expanded3.map(a => a.id), ['v_vx', 'v_vy', 'v_vz']);
eq('expand 3D defaults', expanded3.map(a => a.defaultValue), ['1', '2', '3']);
eq('expand 3D no-boundary', expanded3[0].boundaryValue, undefined);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL VECTOR-ATTR HELPER TESTS ✓' : `${fail} FAILED`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
