// Logical Expression node — grammar + functional verification.
//
// `logicalExpression` is to `logicOperator` (Logic: AND/OR/XOR/NOT over two
// bools) what `expression` is to `arithmeticOperator`: one node holding a
// free-text BOOLEAN formula over N named bool inputs. It runs on all SIX emit
// surfaces (JS / WASM / WebGPU × cell + agent) and on the Overseer driver.
//
// What this checks (values, not just "it compiled"):
//   1. PARSE level — precedence NOT > AND > XOR > OR, left-associativity, both
//      word and symbol operator forms, parentheses, literals, and the error
//      cases (unknown name, reserved name, bad number, dangling operator,
//      unbalanced parens, empty).
//   2. CELL VALUES — a full 8-row truth-table sweep of `(a AND NOT b) OR (b XOR c)`
//      run through the REAL compiled JS step AND a REAL instantiated WASM module
//      in Node, each row matching the independently-computed truth table, and
//      JS ↔ WASM bit-identical.
//   3. The formula and the equivalent CHAIN of Logic nodes agree row for row —
//      the node's whole premise, and the thing a wrong operand normalisation
//      would break.
//   4. A non-0/1 input (an `any` source) is TRUTHY-tested, not compared to 1,
//      on both JS and WASM.
//   5. WGSL emit shape: a `bool` let built from `&&` / `||` / `!=` / `!`.
//   6. AGENT surfaces — the agent JS behaviour produces the right values, and
//      both agent gates accept the node with a real WASM module + a real WGSL
//      shader built. (JS ↔ WASM agent bit-parity is covered permanently by the
//      `[synthetic] Logical Expression` entry in scripts/parity-agent-wasm.mjs.)
//   7. Registration sweep: the registry entry, the Overseer allowlist, and the
//      node's universality (no `requirements`, so Cells AND Agents).
//
// Run from the repo root:  node scripts/test-logical-expression.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export { compileGraph } from '../src/modeler/vpl/compiler/compile.ts';
export { compileGraphWasm } from '../src/modeler/vpl/compiler/wasm/compile.ts';
export { computeLayoutFromModel, buildViewerIds } from '../src/modeler/vpl/compiler/wasm/layout.ts';
export { compileGraphWebGPU } from '../src/modeler/vpl/compiler/webgpu/compile.ts';
export { migrateForHarness, compileAll } from '../src/dev/compileHarness.ts';
export { buildLogicVarMap, parseLogicExpression, RESERVED_LOGIC } from '../src/modeler/vpl/compiler/expression/logicParser.ts';
export { getNodeDef, getAllNodeDefs } from '../src/modeler/vpl/nodes/registry.ts';
export { OVERSEER_UNIVERSAL_TYPES, detectMissingConfig } from '../src/modeler/vpl/nodes/nodeValidation.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-logicexpr-'));
const entryPath = join(ROOT, 'scripts', '__logicexpr_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};

// ---------------------------------------------------------------------------
// 1. Parse level
// ---------------------------------------------------------------------------
console.log('== parser ==');
{
  const map = M.buildLogicVarMap({}, 3).map; // a, b, c
  const parse = (src) => M.parseLogicExpression(src, map);
  /** Compact AST rendering, fully parenthesised, so a precedence claim is exact. */
  const show = (n) => {
    switch (n.kind) {
      case 'lit': return n.value ? 'T' : 'F';
      case 'var': return n.portId;
      case 'not': return `!${show(n.operand)}`;
      case 'bin': return `(${show(n.left)} ${n.op} ${show(n.right)})`;
    }
  };
  const shape = (src) => { const r = parse(src); return 'error' in r ? `ERR:${r.error}` : show(r.ast); };

  // Precedence: NOT > AND > XOR > OR.
  check('NOT binds tighter than AND', shape('NOT a AND b') === '(!a and b)', shape('NOT a AND b'));
  check('AND binds tighter than XOR', shape('a XOR b AND c') === '(a xor (b and c))', shape('a XOR b AND c'));
  check('XOR binds tighter than OR', shape('a OR b XOR c') === '(a or (b xor c))', shape('a OR b XOR c'));
  check('full ladder NOT>AND>XOR>OR', shape('NOT a AND b XOR c OR a') === '(((!a and b) xor c) or a)', shape('NOT a AND b XOR c OR a'));
  // Associativity: all binary tiers are left-associative.
  check('AND is left-associative', shape('a AND b AND c') === '((a and b) and c)', shape('a AND b AND c'));
  check('OR is left-associative', shape('a OR b OR c') === '((a or b) or c)', shape('a OR b OR c'));
  check('XOR is left-associative', shape('a XOR b XOR c') === '((a xor b) xor c)', shape('a XOR b XOR c'));
  // Parentheses override precedence.
  check('parens override precedence', shape('(a OR b) AND c') === '((a or b) and c)', shape('(a OR b) AND c'));
  check('NOT over a parenthesised group', shape('NOT (a AND b)') === '!(a and b)', shape('NOT (a AND b)'));
  check('double NOT nests', shape('NOT NOT a') === '!!a', shape('NOT NOT a'));
  // Symbol forms parse to the identical AST as the word forms.
  check('symbols ≡ words', shape('!a && b ^ c || a') === shape('NOT a AND b XOR c OR a'), shape('!a && b ^ c || a'));
  check('single & is an AND alias', shape('a & b') === '(a and b)', shape('a & b'));
  check('single | is an OR alias', shape('a | b') === '(a or b)', shape('a | b'));
  // Case-insensitive words + literals.
  check('operators are case-insensitive', shape('a and b Or c') === '((a and b) or c)', shape('a and b Or c'));
  check('true/false literals', shape('true OR false') === '(T or F)', shape('true OR false'));
  check('TRUE/False are case-insensitive', shape('TRUE AND False') === '(T and F)', shape('TRUE AND False'));
  check('1/0 are literals', shape('1 AND 0') === '(T and F)', shape('1 AND 0'));
  // Errors.
  const isErr = (src, re) => { const r = parse(src); return 'error' in r && re.test(r.error); };
  check('empty text errors', isErr('', /empty/i));
  check('whitespace-only errors', isErr('   ', /empty/i));
  check('unknown variable errors', isErr('a AND zzz', /Unknown variable/i), shape('a AND zzz'));
  check('a number other than 0/1 errors', isErr('a AND 2', /not a boolean/i), shape('a AND 2'));
  check('dangling operator errors', isErr('a AND', /end of expression/i), shape('a AND'));
  check('leading binary operator errors', isErr('AND a', /needs a value before it/i), shape('AND a'));
  check('unbalanced paren errors', isErr('(a AND b', /Expected "\)"/), shape('(a AND b'));
  check('unexpected character errors', isErr('a + b', /Unexpected character/i), shape('a + b'));
  check('arithmetic is NOT in this grammar (no functions)', isErr('sqrt(a)', /Unknown variable/i), shape('sqrt(a)'));
  // Reserved names.
  const reserved = M.buildLogicVarMap({ _varName_a: 'and' }, 2);
  check('an operator word is a reserved variable name', reserved.errors.some(e => /reserved/i.test(e)), reserved.errors.join('; '));
  const reservedUpper = M.buildLogicVarMap({ _varName_a: 'TRUE' }, 2);
  check('a literal is reserved case-insensitively', reservedUpper.errors.some(e => /reserved/i.test(e)), reservedUpper.errors.join('; '));
  const dup = M.buildLogicVarMap({ _varName_a: 'x', _varName_b: 'x' }, 2);
  check('duplicate variable names error', dup.errors.some(e => /Duplicate/i.test(e)), dup.errors.join('; '));
  check('math function names are NOT reserved here', !M.RESERVED_LOGIC.has('sqrt'));
  // Custom names resolve.
  const named = M.buildLogicVarMap({ _varName_a: 'alive', _varName_b: 'crowded' }, 2);
  const namedShape = (() => { const r = M.parseLogicExpression('alive AND NOT crowded', named.map); return 'error' in r ? r.error : show(r.ast); })();
  check('custom variable names resolve', namedShape === '(a and !b)', namedShape);
}

// ---------------------------------------------------------------------------
// Shared fixture: the truth table of `(a AND NOT b) OR (b XOR c)`
// ---------------------------------------------------------------------------
const FORMULA = '(a AND NOT b) OR (b XOR c)';
const ROWS = [];
for (let i = 0; i < 8; i++) {
  const a = (i >> 2) & 1, b = (i >> 1) & 1, c = i & 1;
  ROWS.push({ a, b, c, want: ((!!a && !b) || (!!b !== !!c)) ? 1 : 0 });
}
const TOTAL = ROWS.length;
const cellAttr = (id) => ({ id, name: id, type: 'bool', description: '', isModelAttribute: false, defaultValue: 'false' });

const mkGraph = () => {
  const used = new Set();
  const nid = (p) => { let id; do { id = p + Math.random().toString(36).slice(2, 8); } while (used.has(id)); used.add(id); return id; };
  const nodes = [], edges = [];
  const n = (t, c = {}) => { const x = { id: nid('n'), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: t, config: c } }; nodes.push(x); return x; };
  const e = (s, sp, t, tp, cat) => edges.push({ id: nid('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
  return { nodes, edges, n, v: (s, sp, t, tp) => e(s, sp, t, tp, 'value'), f: (s, sp, t, tp) => e(s, sp, t, tp, 'flow') };
};

/** Cell model: `out` ← the formula, `chain` ← the equivalent Logic-node chain. */
const buildCellModel = () => {
  const g = mkGraph();
  const step = g.n('step');
  const ga = g.n('getCellAttribute', { attributeId: 'a' });
  const gb = g.n('getCellAttribute', { attributeId: 'b' });
  const gc = g.n('getCellAttribute', { attributeId: 'c' });

  // --- the node under test ---
  const le = g.n('logicalExpression', { expression: FORMULA, visibleCount: 3 });
  g.v(ga, 'value', le, 'a'); g.v(gb, 'value', le, 'b'); g.v(gc, 'value', le, 'c');
  const setOut = g.n('setAttribute', { attributeId: 'out' });
  g.v(le, 'result', setOut, 'value');
  g.f(step, 'do', setOut, 'do');

  // --- the equivalent chain of Logic nodes (the oracle for check 3) ---
  const notB = g.n('logicOperator', { operation: 'NOT' });
  g.v(gb, 'value', notB, 'a');
  const andL = g.n('logicOperator', { operation: 'AND' });
  g.v(ga, 'value', andL, 'a'); g.v(notB, 'result', andL, 'b');
  const xorR = g.n('logicOperator', { operation: 'XOR' });
  g.v(gb, 'value', xorR, 'a'); g.v(gc, 'value', xorR, 'b');
  const orTop = g.n('logicOperator', { operation: 'OR' });
  g.v(andL, 'result', orTop, 'a'); g.v(xorR, 'result', orTop, 'b');
  const setChain = g.n('setAttribute', { attributeId: 'chain' });
  g.v(orTop, 'result', setChain, 'value');
  g.f(setOut, 'next', setChain, 'do');

  // --- truthiness: a non-0/1 input must be TRUTHY-tested, not `== 1` ---
  const le2 = g.n('logicalExpression', { expression: 'a', visibleCount: 1 });
  const gv = g.n('getCellAttribute', { attributeId: 'raw' });
  g.v(gv, 'value', le2, 'a');
  const setTruthy = g.n('setAttribute', { attributeId: 'truthy' });
  g.v(le2, 'result', setTruthy, 'value');
  g.f(setChain, 'next', setTruthy, 'do');

  return M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'LogicalExpr', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: TOTAL, gridHeight: 1, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    // `raw` is float on purpose: it carries the non-0/1 truthiness probe value.
    attributes: [
      ...['a', 'b', 'c', 'out', 'chain', 'truthy'].map(cellAttr),
      { id: 'raw', name: 'raw', type: 'float', description: '', isModelAttribute: false, defaultValue: '0' },
    ],
    neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });
};

const model = buildCellModel();
// Cell 0 gets 0 (falsy), the rest a non-0/1 value that is truthy on every target.
const RAW = ROWS.map((_, i) => (i === 0 ? 0 : 4));
const RAW_WANT = RAW.map(v => (v !== 0 ? 1 : 0));

// ---------------------------------------------------------------------------
// 2/3/4. Cell JS
// ---------------------------------------------------------------------------
console.log('== cell JS ==');
const js = M.compileGraph(model.graphNodes, model.graphEdges, model);
check('JS compiles', !js.error, js.error ?? '');
let jsOut = null, jsChain = null, jsTruthy = null;
if (!js.error) {
  const params = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL, W: TOTAL, H: 1, D: 1, WH: TOTAL,
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
    _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    order: null, _skipped: new Uint8Array(0),
  };
  for (const id of ['a', 'b', 'c', 'out', 'chain', 'truthy']) {
    bufs[`r_${id}`] = new Uint8Array(TOTAL); bufs[`w_${id}`] = new Uint8Array(TOTAL);
  }
  bufs.r_raw = new Float64Array(TOTAL); bufs.w_raw = new Float64Array(TOTAL);
  ROWS.forEach((r, i) => { bufs.r_a[i] = r.a; bufs.r_b[i] = r.b; bufs.r_c[i] = r.c; });
  bufs.r_raw.set(RAW);
  const missing = params.filter(p => !(p in bufs));
  check('JS step params all resolvable', missing.length === 0, `unknown: ${missing.join(', ')}`);
  if (!missing.length) {
    (0, eval)(js.stepCode)(...params.map(p => bufs[p]));
    jsOut = Array.from(bufs.w_out); jsChain = Array.from(bufs.w_chain); jsTruthy = Array.from(bufs.w_truthy);
    const want = ROWS.map(r => r.want);
    check(`JS truth table of "${FORMULA}" === [${want.join(',')}]`,
      jsOut.every((v, i) => v === want[i]), `got [${jsOut.join(',')}]`);
    check('JS formula ≡ the equivalent chain of Logic nodes',
      jsOut.every((v, i) => v === jsChain[i]), `formula [${jsOut.join(',')}] vs chain [${jsChain.join(',')}]`);
    check('JS truthy-tests a non-0/1 input (never == 1)',
      jsTruthy.every((v, i) => v === RAW_WANT[i]), `got [${jsTruthy.join(',')}] for [${RAW.join(',')}]`);
    check('JS emits a single ? 1 : 0 numeric bool', /\? 1 : 0\)/.test(js.stepCode));
  }
}

// ---------------------------------------------------------------------------
// 2/3/4. Cell WASM (real instantiated module)
// ---------------------------------------------------------------------------
console.log('== cell WASM ==');
const layout = M.computeLayoutFromModel(model);
const wa = M.compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, M.buildViewerIds(model));
check('WASM compiles', !wa.error, wa.error ?? '');
if (!wa.error) {
  const mem = new WebAssembly.Memory({ initial: layout.pages });
  const env = { mem, pow: Math.pow, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan, tanh: Math.tanh, fmod: (a, b) => a % b };
  const { instance } = await WebAssembly.instantiate(wa.bytes, { env });
  const rd = (id) => new Uint8Array(mem.buffer, layout.attrReadOffset[id], TOTAL);
  ROWS.forEach((r, i) => { rd('a')[i] = r.a; rd('b')[i] = r.b; rd('c')[i] = r.c; });
  new Float64Array(mem.buffer, layout.attrReadOffset['raw'], TOTAL).set(RAW);
  instance.exports.step(TOTAL);
  const wOut = Array.from(new Uint8Array(mem.buffer, layout.attrWriteOffset['out'], TOTAL));
  const wChain = Array.from(new Uint8Array(mem.buffer, layout.attrWriteOffset['chain'], TOTAL));
  const wTruthy = Array.from(new Uint8Array(mem.buffer, layout.attrWriteOffset['truthy'], TOTAL));
  const want = ROWS.map(r => r.want);
  check(`WASM truth table === [${want.join(',')}]`, wOut.every((v, i) => v === want[i]), `got [${wOut.join(',')}]`);
  check('WASM formula ≡ the equivalent chain of Logic nodes',
    wOut.every((v, i) => v === wChain[i]), `formula [${wOut.join(',')}] vs chain [${wChain.join(',')}]`);
  check('WASM truthy-tests a non-0/1 input',
    wTruthy.every((v, i) => v === RAW_WANT[i]), `got [${wTruthy.join(',')}] for [${RAW.join(',')}]`);
  if (jsOut) {
    check('JS ↔ WASM bit-identical (formula)', wOut.every((v, i) => v === jsOut[i]),
      `js [${jsOut.join(',')}] vs wasm [${wOut.join(',')}]`);
    check('JS ↔ WASM bit-identical (truthiness)', wTruthy.every((v, i) => v === jsTruthy[i]),
      `js [${jsTruthy.join(',')}] vs wasm [${wTruthy.join(',')}]`);
  }
}

// ---------------------------------------------------------------------------
// 5. Cell WebGPU (emit-level)
// ---------------------------------------------------------------------------
console.log('== cell WebGPU ==');
const wg = M.compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
check('WebGPU compiles', !wg.error, wg.error ?? '');
if (!wg.error) {
  const s = wg.shaderCode;
  // The whole formula binds to one `bool` let named `lexp…` (the emitLet tag).
  check('WGSL binds the formula to a bool let', /let\s+_?lexp\w*\s*:\s*bool\s*=/.test(s), s.slice(0, 120));
  const m = /let\s+_?lexp\w*\s*:\s*bool\s*=\s*([^;]+);/.exec(s);
  const expr = m ? m[1] : '';
  check('WGSL uses && for AND', /&&/.test(expr), expr);
  check('WGSL uses || for OR', /\|\|/.test(expr), expr);
  check('WGSL uses != for XOR (no ^^ in WGSL)', /!=/.test(expr) && !/\^\^/.test(expr), expr);
  check('WGSL uses ! for NOT', /!\(/.test(expr), expr);
}

// ---------------------------------------------------------------------------
// 6. Agent surfaces
// ---------------------------------------------------------------------------
console.log('== agents ==');
{
  const g = mkGraph();
  const bs = g.n('behaviourStep', {});
  const ga = g.n('getCellAttribute', { attributeId: 'a' });
  const gb = g.n('getCellAttribute', { attributeId: 'b' });
  const gc = g.n('getCellAttribute', { attributeId: 'c' });
  const le = g.n('logicalExpression', { expression: FORMULA, visibleCount: 3 });
  g.v(ga, 'value', le, 'a'); g.v(gb, 'value', le, 'b'); g.v(gc, 'value', le, 'c');
  const set = g.n('setAttribute', { attributeId: 'out' });
  g.v(le, 'result', set, 'value');
  g.f(bs, 'do', set, 'do');

  const agentAttr = (id) => ({ id, name: id, type: 'bool', description: '', isModelAttribute: false, defaultValue: 'false' });
  const agentModel = M.migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'LogicalExprAgents', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 64, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 8, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: ['a', 'b', 'c', 'out'].map(agentAttr),
    variables: [], agentVariables: [], indicators: [], mappings: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: g.nodes, agentGraphEdges: g.edges, macroDefs: [],
  });

  const all = M.compileAll(agentModel);
  check('agent JS compiles', !all.agent.error, all.agent.error ?? '');
  check('agent WASM gate accepts logicalExpression', all.agent.wasm.supported, all.agent.wasm.error ?? 'gate rejected');
  check('agent WASM module built', !all.agent.wasm.error && all.agent.wasm.bytesLen > 0, all.agent.wasm.error ?? `${all.agent.wasm.bytesLen} bytes`);
  check('agent WebGPU gate accepts logicalExpression', all.agent.webgpu.supported, all.agent.webgpu.error ?? 'gate rejected');
  check('agent WGSL built + uses select(0.0, 1.0, …)',
    !all.agent.webgpu.error && /select\(0\.0, 1\.0,/.test(all.agent.webgpu.shaderCode), all.agent.webgpu.error ?? '');

  // Agent JS VALUES — run the compiled behaviour over 8 agents, one per row.
  if (!all.agent.error) {
    const code = all.agent.behaviourCode;
    const params = /\(\s*function\s*\(([^)]*)\)/.exec(code)[1].split(',').map(s => s.trim()).filter(Boolean);
    const N = TOTAL;
    const bufs = {
      highWater: N, _alive: new Uint8Array(N).fill(1),
      colors: new Uint8ClampedArray(N * 4),
      _rngState: new Uint32Array([0x12345678]), _stopFlag: new Uint32Array(1),
      _indicators: {}, modelAttrs: {}, activeViewer: '',
    };
    for (const id of ['a', 'b', 'c', 'out']) {
      bufs[`r_${id}`] = new Uint8Array(N); bufs[`w_${id}`] = bufs[`r_${id}`]; // async: write aliases read
    }
    ROWS.forEach((r, i) => { bufs.r_a[i] = r.a; bufs.r_b[i] = r.b; bufs.r_c[i] = r.c; });
    // Everything else the ABI asks for that this graph never touches.
    const missing = params.filter(p => !(p in bufs));
    for (const p of missing) bufs[p] = p.startsWith('_agent') || p.startsWith('_hash') || p.startsWith('_field') || p.startsWith('_bond')
      ? new Float64Array(N * 4) : 0;
    (0, eval)(code)(...params.map(p => bufs[p]));
    const got = Array.from(bufs.r_out);
    const want = ROWS.map(r => r.want);
    check(`agent JS truth table === [${want.join(',')}]`, got.every((v, i) => v === want[i]), `got [${got.join(',')}]`);
  }
}

// ---------------------------------------------------------------------------
// 7. Registration sweep
// ---------------------------------------------------------------------------
console.log('== registration ==');
{
  const def = M.getNodeDef('logicalExpression');
  check('registered in ALL_NODES', !!def);
  if (def) {
    check('has a description', typeof def.description === 'string' && def.description.length > 20);
    check('universal (no requirements ⇒ Cells AND Agents)', !def.requirements);
    check('8 bool inputs + a bool result', def.ports.filter(p => p.kind === 'input').length === 8
      && def.ports.every(p => p.dataType === 'bool'), JSON.stringify(def.ports.map(p => `${p.id}:${p.dataType}`)));
    check('inputs carry the bool inline widget (Logic-node parity)',
      def.ports.filter(p => p.kind === 'input').every(p => p.inlineWidget === 'bool' && p.defaultValue === 'false'));
    check('defaults to 3 visible inputs + an empty formula',
      def.defaultConfig.visibleCount === 3 && def.defaultConfig.expression === '');
  }
  check('in the Overseer allowlist', M.OVERSEER_UNIVERSAL_TYPES.has('logicalExpression'));
  // Validation badge.
  const bad = M.detectMissingConfig('logicalExpression', { expression: 'a AND', visibleCount: 3 }, model);
  check('a parse error raises a badge', bad.some(i => /Formula error/i.test(i)), bad.join('; '));
  const empty = M.detectMissingConfig('logicalExpression', { expression: '', visibleCount: 3 }, model);
  check('an empty formula raises a badge', empty.some(i => /Enter a formula/i.test(i)), empty.join('; '));
  const good = M.detectMissingConfig('logicalExpression', { expression: 'a AND b', visibleCount: 3 }, model);
  check('a valid formula raises no badge', good.length === 0, good.join('; '));
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
