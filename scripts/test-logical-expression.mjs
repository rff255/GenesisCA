// Logical Expression node — grammar + functional verification.
//
// `logicalExpression` is to `logicOperator` (Logic: AND/OR/XOR/NOT over two
// bools) what `expression` is to `arithmeticOperator`: one node holding a
// free-text BOOLEAN formula over N named inputs — and, since the COMPARISON
// tier, it absorbs `statement` (Compare) too, so `n > 2 AND NOT crowded` is one
// node instead of three. It runs on all SIX emit surfaces (JS / WASM / WebGPU ×
// cell + agent) and on the Overseer driver.
//
// What this checks (values, not just "it compiled"):
//   1. PARSE level — precedence CMP > NOT > AND > XOR > OR, left-associativity,
//      both word and symbol operator forms, parentheses, literals, and the error
//      cases (unknown name, reserved name, bad number, dangling operator,
//      unbalanced parens, empty).
//   1b. The COMPARISON tier — the six operators + the `=` alias, numeric
//      literals (decimal / negative), a variable read BOTH ways in one formula,
//      the non-associativity (a chained comparison is an error naming the fix),
//      and the "no arithmetic" boundary (`-a`, `a - 2`, a boolean group as an
//      operand, `true` as a number).
//   2. CELL VALUES — a full 8-row truth-table sweep of `(a AND NOT b) OR (b XOR c)`
//      run through the REAL compiled JS step AND a REAL instantiated WASM module
//      in Node, each row matching the independently-computed truth table, and
//      JS ↔ WASM bit-identical.
//   2b. COMPARISON VALUES — an 8-row sweep over a fixture PROVEN to discriminate
//      (every operator's column carries both values and no two operators agree
//      on all 8 rows, so confusing any two is visible), on the same real JS step
//      and real WASM module, bit-identical: all six operators var-vs-var, a
//      mixed formula spanning every tier, negative + decimal literals, and ONE
//      port read both truthy and numerically in one formula.
//   3. The formula and the equivalent CHAIN of Logic nodes agree row for row —
//      the node's whole premise, and the thing a wrong operand normalisation
//      would break. Since the comparison tier, EVERY operator is additionally
//      compared against a real `statement` (Compare) node, and the mixed formula
//      against a hand-wired Compare + Logic chain.
//   4. A non-0/1 input (an `any` source) is TRUTHY-tested, not compared to 1,
//      on both JS and WASM.
//   5. WGSL emit shape: a `bool` let built from `&&` / `||` / `!=` / `!`, and a
//      comparison one built from the six WGSL comparison operators over f32.
//   5b. BACKWARDS COMPATIBILITY — a comparison-FREE formula with an UNWIRED port
//      (whose inline constant is the ONE thing the `any` port re-typing touches)
//      still emits the i32 bool cast, never the f32 one. `check-compile-identity`
//      pins the whole shipped library on top.
//   6. AGENT surfaces — the agent JS behaviour produces the right values for the
//      boolean AND the comparison formula (the latter against a hand-wired
//      Compare + Logic chain), and both agent gates accept the node with a real
//      WASM module + a real WGSL shader carrying the f32 comparisons. (JS ↔ WASM
//      agent bit-parity is covered permanently by the `[synthetic] Logical
//      Expression` entry in scripts/parity-agent-wasm.mjs.)
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
// 1b. The comparison tier
// ---------------------------------------------------------------------------
console.log('== comparison grammar ==');
{
  const map = M.buildLogicVarMap({}, 3).map; // a, b, c
  const parse = (src) => M.parseLogicExpression(src, map);
  const num = (n) => (n.kind === 'num' ? `#${n.value}` : n.portId);
  const show = (n) => {
    switch (n.kind) {
      case 'lit': return n.value ? 'T' : 'F';
      case 'var': return n.portId;
      case 'cmp': return `(${num(n.left)} ${n.op} ${num(n.right)})`;
      case 'not': return `!${show(n.operand)}`;
      case 'bin': return `(${show(n.left)} ${n.op} ${show(n.right)})`;
    }
  };
  const shape = (src) => { const r = parse(src); return 'error' in r ? `ERR:${r.error}` : show(r.ast); };
  const isErr = (src, re) => { const r = parse(src); return 'error' in r && re.test(r.error); };

  // All six operators parse, and a NAME on either side is the RAW number
  // (`numvar`), never the truthy `var`.
  for (const [src, want] of [
    ['a < b', '(a < b)'], ['a <= b', '(a <= b)'], ['a > b', '(a > b)'],
    ['a >= b', '(a >= b)'], ['a == b', '(a == b)'], ['a != b', '(a != b)'],
  ]) check(`"${src}" parses`, shape(src) === want, shape(src));
  check('"=" is an alias for "=="', shape('a = b') === shape('a == b'), shape('a = b'));
  check('"!" still means NOT when not followed by "="', shape('!a') === '!a', shape('!a'));
  check('"!=" is not read as NOT', shape('a != 2') === '(a != #2)', shape('a != 2'));

  // Numeric literals: integers, decimals, negatives.
  check('integer literal operand', shape('a > 2') === '(a > #2)', shape('a > 2'));
  check('decimal literal operand', shape('a > 2.5') === '(a > #2.5)', shape('a > 2.5'));
  check('negative literal operand', shape('a > -3') === '(a > #-3)', shape('a > -3'));
  check('negative literal on the LEFT', shape('-3 < a') === '(#-3 < a)', shape('-3 < a'));
  check('negative decimal literal', shape('a >= -0.5') === '(a >= #-0.5)', shape('a >= -0.5'));
  check('literal-vs-literal is legal (a constant)', shape('1 < 2') === '(#1 < #2)', shape('1 < 2'));
  check('a parenthesised numeric operand', shape('(a) > 2') === '(a > #2)', shape('(a) > 2'));

  // PRECEDENCE — the comparison tier is TIGHTEST (Python's rule).
  check('CMP binds tighter than NOT', shape('NOT a > b') === '!(a > b)', shape('NOT a > b'));
  check('CMP binds tighter than AND', shape('a > 1 AND b < 2') === '((a > #1) and (b < #2))', shape('a > 1 AND b < 2'));
  check('CMP binds tighter than XOR', shape('a > 1 XOR b') === '((a > #1) xor b)', shape('a > 1 XOR b'));
  check('CMP binds tighter than OR', shape('a > 1 OR b') === '((a > #1) or b)', shape('a > 1 OR b'));
  check('full ladder CMP>NOT>AND>XOR>OR',
    shape('NOT a > 1 AND b < 2 XOR c OR a == 0')
      === '(((!(a > #1) and (b < #2)) xor c) or (a == #0))',
    shape('NOT a > 1 AND b < 2 XOR c OR a == 0'));
  check('parens still override', shape('NOT (a > 1 AND b)') === '!((a > #1) and b)', shape('NOT (a > 1 AND b)'));

  // A variable read BOTH ways in one formula — bare it is truthy, in a
  // comparison it is the raw number.
  check('one variable, both readings', shape('a AND b > 2') === '(a and (b > #2))', shape('a AND b > 2'));
  check('the SAME variable, both readings', shape('a AND a > 2') === '(a and (a > #2))', shape('a AND a > 2'));

  // NON-associative: a chain is an error that names the fix.
  check('chained comparison errors', isErr('a < b < c', /Chained comparisons/i), shape('a < b < c'));
  check('the chain error names the AND rewrite', isErr('a < b < c', /AND/), shape('a < b < c'));
  check('mixed chain errors too', isErr('1 <= a <= 5', /Chained comparisons/i), shape('1 <= a <= 5'));

  // The "no arithmetic" boundary.
  check('"-" may not negate a variable', isErr('-a > 0', /no arithmetic/i), shape('-a > 0'));
  check('subtraction errors', isErr('a - 2 > 0', /no arithmetic/i), shape('a - 2 > 0'));
  check('a trailing "-" errors', isErr('a AND b - 1', /no arithmetic/i), shape('a AND b - 1'));
  check('addition is still an unexpected character', isErr('a + 2 > 0', /Unexpected character/i), shape('a + 2 > 0'));
  check('a boolean GROUP cannot be compared', isErr('(a AND b) > 2', /compares numbers/i), shape('(a AND b) > 2'));
  check('a boolean LITERAL cannot be compared', isErr('true > 1', /compares numbers/i), shape('true > 1'));
  check('a three-term chain errors as a chain', isErr('a > b > c', /Chained comparisons/i), shape('a > b > c'));
  check('a dangling comparison operator errors',
    isErr('a >', /Expected a number or an input variable/i), shape('a >'));
  check('an unknown variable in a comparison errors',
    isErr('zzz > 1', /Unknown variable/i), shape('zzz > 1'));

  // The pre-comparison grammar is untouched where it should be.
  check('a non-0/1 number is STILL not a boolean', isErr('a AND 2', /not a boolean/i), shape('a AND 2'));
  check('…and the error suggests comparing it', isErr('a AND 2', /x > 2/), shape('a AND 2'));
  check('0/1 are STILL boolean literals', shape('1 AND 0') === '(T and F)', shape('1 AND 0'));
  check('a malformed number errors', isErr('a > 1.2.3', /not a valid number/i), shape('a > 1.2.3'));

  // RESERVED_LOGIC did not grow — every comparison operator is a SYMBOL, so no
  // existing port name can have been invalidated.
  check('RESERVED_LOGIC is exactly the 4 operator words + 2 literals',
    M.RESERVED_LOGIC.size === 6
    && ['not', 'and', 'xor', 'or', 'true', 'false'].every(w => M.RESERVED_LOGIC.has(w)),
    [...M.RESERVED_LOGIC].join(','));
  const cmpNamed = M.buildLogicVarMap({ _varName_a: 'n', _varName_b: 'lt' }, 2);
  check('a port may still be named anything non-reserved (e.g. "lt")',
    cmpNamed.errors.length === 0, cmpNamed.errors.join('; '));
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

// ---------------------------------------------------------------------------
// Shared fixture: the COMPARISON tier
// ---------------------------------------------------------------------------
// `n` / `m` per row, chosen so EVERY operator DISCRIMINATES — each one's 8-row
// result must contain both a 0 and a 1, and no two operators may agree on all
// eight rows. A fixture on which `<` and `<=` happen to coincide would pass a
// build that had confused them, which is the whole failure this tier exists to
// catch (asserted below, not assumed).
const CMP_N = [-5, -1.5, 0, 2, 2.5, 4, 5, 7];
const CMP_M = [0, -1.5, 3, 2, 1, 9, 5, 2];
const CMP_OPS = [
  { key: 'lt', op: '<', js: (x, y) => x < y },
  { key: 'le', op: '<=', js: (x, y) => x <= y },
  { key: 'gt', op: '>', js: (x, y) => x > y },
  { key: 'ge', op: '>=', js: (x, y) => x >= y },
  { key: 'eq', op: '==', js: (x, y) => x === y },
  { key: 'ne', op: '!=', js: (x, y) => x !== y },
];

// Every expected value below is recomputed INDEPENDENTLY from CMP_N / CMP_M —
// never read back out of the parser or an emitter under test.
const CMP_MIXED = 'NOT n > 2 AND m != n OR n <= -1.5';
const cmpMixedWant = (i) =>
  ((!(CMP_N[i] > 2) && CMP_M[i] !== CMP_N[i]) || CMP_N[i] <= -1.5) ? 1 : 0;
// Negative + decimal literals, all the way through every emitter.
const CMP_LIT = 'n >= -1.5 AND n != 2.5';
const cmpLitWant = (i) => (CMP_N[i] >= -1.5 && CMP_N[i] !== 2.5) ? 1 : 0;
// The SAME port read BOTH ways in ONE formula: bare it is TRUTHY-tested, inside
// a comparison it is the raw number. (Row 2 is n = 0, where the two readings
// disagree — which is what makes this differ from `NOT n > 2` alone.)
const CMP_DUAL = 'n AND NOT n > 2';
const cmpDualWant = (i) => (CMP_N[i] !== 0 && !(CMP_N[i] > 2)) ? 1 : 0;
// A bool input truthy-tested alongside a numeric comparison of another port.
const CMP_MIX2 = 'b AND n > 2';
const cmpMix2Want = (i) => (ROWS[i].b !== 0 && CMP_N[i] > 2) ? 1 : 0;

const CMP_OUT = CMP_OPS.flatMap(o => [`cf_${o.key}`, `co_${o.key}`]);
const BOOL_ATTRS = [
  'a', 'b', 'c', 'out', 'chain', 'truthy',
  ...CMP_OUT, 'cmix', 'comix', 'clit', 'cdual', 'cmix2',
];
const FLOAT_ATTRS = ['raw', 'n', 'm'];

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

  // --- the COMPARISON tier ---------------------------------------------------
  // `tail` walks the flow chain so each probe's write happens in order.
  let tail = setTruthy;
  const gn = g.n('getCellAttribute', { attributeId: 'n' });
  const gm = g.n('getCellAttribute', { attributeId: 'm' });
  /** Append `<attrId> ← <resultPort of node>` to the flow chain. */
  const write = (src, port, attrId) => {
    const s = g.n('setAttribute', { attributeId: attrId });
    g.v(src, port, s, 'value');
    g.f(tail, 'next', s, 'do');
    tail = s;
  };
  /** A Compare node — the ORACLE. `y` is a wired node or an inline constant. */
  const cmpNode = (op, xSrc, y) => {
    const cfg = { operation: op, compareType: 'numerical' };
    if (typeof y !== 'object') cfg._port_y = String(y);
    const s = g.n('statement', cfg);
    g.v(xSrc, 'value', s, 'x');
    if (typeof y === 'object') g.v(y, 'value', s, 'y');
    return s;
  };

  // 1. Per OPERATOR: `n <op> m` as a formula, and the equivalent Compare node.
  //    Both operands are VARIABLES, so this exercises the numeric accessor on
  //    both sides of every operator.
  for (const { key, op } of CMP_OPS) {
    const f = g.n('logicalExpression', { expression: `n ${op} m`, visibleCount: 2, _varName_a: 'n', _varName_b: 'm' });
    g.v(gn, 'value', f, 'a'); g.v(gm, 'value', f, 'b');
    write(f, 'result', `cf_${key}`);
    write(cmpNode(op, gn, gm), 'result', `co_${key}`);
  }

  // 2. A MIXED formula vs the equivalent hand-wired Compare + Logic chain —
  //    `NOT n > 2 AND m != n OR n <= -1.5`.
  {
    const f = g.n('logicalExpression', { expression: CMP_MIXED, visibleCount: 2, _varName_a: 'n', _varName_b: 'm' });
    g.v(gn, 'value', f, 'a'); g.v(gm, 'value', f, 'b');
    write(f, 'result', 'cmix');

    const notGt = g.n('logicOperator', { operation: 'NOT' });
    g.v(cmpNode('>', gn, 2), 'result', notGt, 'a');
    const andL = g.n('logicOperator', { operation: 'AND' });
    g.v(notGt, 'result', andL, 'a');
    g.v(cmpNode('!=', gm, gn), 'result', andL, 'b');
    const orTop2 = g.n('logicOperator', { operation: 'OR' });
    g.v(andL, 'result', orTop2, 'a');
    g.v(cmpNode('<=', gn, -1.5), 'result', orTop2, 'b');
    write(orTop2, 'result', 'comix');
  }

  // 3. Negative + decimal literals; 4. the dual reading of ONE port;
  //    5. a bool truthy test alongside a numeric comparison.
  for (const [expr, attrId, vc] of [[CMP_LIT, 'clit', 1], [CMP_DUAL, 'cdual', 1]]) {
    const f = g.n('logicalExpression', { expression: expr, visibleCount: vc, _varName_a: 'n' });
    g.v(gn, 'value', f, 'a');
    write(f, 'result', attrId);
  }
  {
    const f = g.n('logicalExpression', { expression: CMP_MIX2, visibleCount: 2, _varName_a: 'b', _varName_b: 'n' });
    g.v(gb, 'value', f, 'a'); g.v(gn, 'value', f, 'b');
    write(f, 'result', 'cmix2');
  }

  return M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'LogicalExpr', description: '', topology: '2d-grid',
      boundaryTreatment: 'torus', updateMode: 'synchronous',
      gridWidth: TOTAL, gridHeight: 1, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    // The FLOAT attrs are float on purpose: `raw` carries the non-0/1
    // truthiness probe, `n` / `m` the comparison operands (fractional and
    // negative values that only survive as f64/f32).
    attributes: [
      ...BOOL_ATTRS.map(cellAttr),
      ...FLOAT_ATTRS.map(id => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' })),
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
let jsOut = null, jsChain = null, jsTruthy = null, jsCmp = null;
if (!js.error) {
  const params = /\(\s*function\s*\(([^)]*)\)/.exec(js.stepCode)[1].split(',').map(s => s.trim()).filter(Boolean);
  const bufs = {
    total: TOTAL, W: TOTAL, H: 1, D: 1, WH: TOTAL,
    modelAttrs: {}, colors: new Uint8ClampedArray(TOTAL * 4), activeViewer: '',
    _indicators: {}, _linkedResults: {}, _rngState: new Uint32Array([0x12345678]),
    _stopFlag: new Uint32Array(1), glyphCodes: new Uint32Array(0), glyphColors: new Uint32Array(0),
    order: null, _skipped: new Uint8Array(0),
  };
  for (const id of BOOL_ATTRS) {
    bufs[`r_${id}`] = new Uint8Array(TOTAL); bufs[`w_${id}`] = new Uint8Array(TOTAL);
  }
  for (const id of FLOAT_ATTRS) {
    bufs[`r_${id}`] = new Float64Array(TOTAL); bufs[`w_${id}`] = new Float64Array(TOTAL);
  }
  ROWS.forEach((r, i) => { bufs.r_a[i] = r.a; bufs.r_b[i] = r.b; bufs.r_c[i] = r.c; });
  bufs.r_raw.set(RAW); bufs.r_n.set(CMP_N); bufs.r_m.set(CMP_M);
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

    // --- the COMPARISON tier, by VALUE ---
    jsCmp = {};
    for (const id of [...CMP_OUT, 'cmix', 'comix', 'clit', 'cdual', 'cmix2']) {
      jsCmp[id] = Array.from(bufs[`w_${id}`]);
    }
    // The fixture must DISCRIMINATE, or none of the checks below prove anything:
    // every operator's column carries both values, and no two columns agree on
    // all 8 rows (so confusing any two operators is visible).
    const cols = CMP_OPS.map(o => jsCmp[`cf_${o.key}`].join(''));
    check('the fixture discriminates: every operator column has both a 0 and a 1',
      cols.every(s => s.includes('0') && s.includes('1')), cols.join(' | '));
    check('the fixture discriminates: no two operators agree on all 8 rows',
      new Set(cols).size === CMP_OPS.length, cols.join(' | '));

    for (const { key, op, js: fn } of CMP_OPS) {
      const want = CMP_N.map((n, i) => (fn(n, CMP_M[i]) ? 1 : 0));
      check(`JS "n ${op} m" === [${want.join(',')}]`,
        jsCmp[`cf_${key}`].every((v, i) => v === want[i]), `got [${jsCmp[`cf_${key}`].join(',')}]`);
      check(`JS "n ${op} m" ≡ the equivalent Compare node`,
        jsCmp[`cf_${key}`].every((v, i) => v === jsCmp[`co_${key}`][i]),
        `formula [${jsCmp[`cf_${key}`].join(',')}] vs Compare [${jsCmp[`co_${key}`].join(',')}]`);
    }
    const mixWant = CMP_N.map((_, i) => cmpMixedWant(i));
    check(`JS "${CMP_MIXED}" === [${mixWant.join(',')}]`,
      jsCmp.cmix.every((v, i) => v === mixWant[i]), `got [${jsCmp.cmix.join(',')}]`);
    check('JS mixed formula ≡ the equivalent Compare + Logic node chain',
      jsCmp.cmix.every((v, i) => v === jsCmp.comix[i]),
      `formula [${jsCmp.cmix.join(',')}] vs chain [${jsCmp.comix.join(',')}]`);
    const litWant = CMP_N.map((_, i) => cmpLitWant(i));
    check(`JS negative/decimal literals "${CMP_LIT}" === [${litWant.join(',')}]`,
      jsCmp.clit.every((v, i) => v === litWant[i]), `got [${jsCmp.clit.join(',')}]`);
    const dualWant = CMP_N.map((_, i) => cmpDualWant(i));
    check(`JS one port read BOTH ways "${CMP_DUAL}" === [${dualWant.join(',')}]`,
      jsCmp.cdual.every((v, i) => v === dualWant[i]), `got [${jsCmp.cdual.join(',')}]`);
    // …and that dual reading is NOT the same thing as the comparison alone —
    // otherwise the check above would pass on a build that dropped the truthy half.
    check('…and it differs from the comparison alone (the truthy half is real)',
      dualWant.some((v, i) => v !== ((!(CMP_N[i] > 2)) ? 1 : 0)), `${dualWant.join(',')}`);
    const mix2Want = CMP_N.map((_, i) => cmpMix2Want(i));
    check(`JS bool + comparison "${CMP_MIX2}" === [${mix2Want.join(',')}]`,
      jsCmp.cmix2.every((v, i) => v === mix2Want[i]), `got [${jsCmp.cmix2.join(',')}]`);
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
  new Float64Array(mem.buffer, layout.attrReadOffset['n'], TOTAL).set(CMP_N);
  new Float64Array(mem.buffer, layout.attrReadOffset['m'], TOTAL).set(CMP_M);
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

  // --- the COMPARISON tier on a REAL WASM module ---
  const wRd = (id) => Array.from(new Uint8Array(mem.buffer, layout.attrWriteOffset[id], TOTAL));
  for (const { key, op, js: fn } of CMP_OPS) {
    const want = CMP_N.map((n, i) => (fn(n, CMP_M[i]) ? 1 : 0));
    const got = wRd(`cf_${key}`);
    check(`WASM "n ${op} m" === [${want.join(',')}]`, got.every((v, i) => v === want[i]), `got [${got.join(',')}]`);
    const oracle = wRd(`co_${key}`);
    check(`WASM "n ${op} m" ≡ the equivalent Compare node`,
      got.every((v, i) => v === oracle[i]), `formula [${got.join(',')}] vs Compare [${oracle.join(',')}]`);
    if (jsCmp) {
      check(`JS ↔ WASM bit-identical ("n ${op} m")`, got.every((v, i) => v === jsCmp[`cf_${key}`][i]),
        `js [${jsCmp[`cf_${key}`].join(',')}] vs wasm [${got.join(',')}]`);
    }
  }
  for (const [id, want, label] of [
    ['cmix', CMP_N.map((_, i) => cmpMixedWant(i)), CMP_MIXED],
    ['clit', CMP_N.map((_, i) => cmpLitWant(i)), CMP_LIT],
    ['cdual', CMP_N.map((_, i) => cmpDualWant(i)), CMP_DUAL],
    ['cmix2', CMP_N.map((_, i) => cmpMix2Want(i)), CMP_MIX2],
  ]) {
    const got = wRd(id);
    check(`WASM "${label}" === [${want.join(',')}]`, got.every((v, i) => v === want[i]), `got [${got.join(',')}]`);
    if (jsCmp) {
      check(`JS ↔ WASM bit-identical ("${label}")`, got.every((v, i) => v === jsCmp[id][i]),
        `js [${jsCmp[id].join(',')}] vs wasm [${got.join(',')}]`);
    }
  }
  check('WASM mixed formula ≡ the equivalent Compare + Logic node chain',
    wRd('cmix').every((v, i) => v === wRd('comix')[i]),
    `formula [${wRd('cmix').join(',')}] vs chain [${wRd('comix').join(',')}]`);
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

  // --- the COMPARISON tier's WGSL shape ---
  // Every `logicalExpression` binds to a `lexp…` bool let, so the comparison
  // formulas' operators all live in that set of lines.
  const lets = [...s.matchAll(/let\s+_?lexp\w*\s*:\s*bool\s*=\s*([^;]+);/g)].map(m => m[1]);
  const all = lets.join('\n');
  for (const op of ['<', '<=', '>', '>=', '==', '!=']) {
    // Spaced form — how `emitLogicWgsl` writes it — so ` < ` cannot match `<=`.
    check(`WGSL emits the ${op} comparison`, all.includes(` ${op} `), all.slice(0, 200));
  }
  check('WGSL comparison literals carry a decimal point (f32, not AbstractInt)',
    / 2\.0\)/.test(all) || / 2\.0 /.test(all), all.slice(0, 300));
  check('WGSL negative literals are parenthesised', /\(-1\.5\)/.test(all), all.slice(0, 300));
  check('WGSL decimal literal survives', /2\.5/.test(all), all.slice(0, 300));
  // WGSL has no `===`; the equality operators are the plain ones.
  check('WGSL uses == / != (never ===)', !/===/.test(all), all.slice(0, 200));
}

// ---------------------------------------------------------------------------
// 5b. BACKWARDS COMPATIBILITY — a comparison-FREE formula is untouched
// ---------------------------------------------------------------------------
// The comparison tier required the 8 input ports to be re-declared `any` (so
// the discovery layer offers this node to numeric sources). That changes how an
// UNWIRED port's inline constant is typed — the ONE thing that could move a
// pre-comparison formula's emitted output. Both the WASM and the WebGPU
// emitters fold an integral inline back to the i32 form the `bool` declaration
// used to produce; these checks pin that, and `check-compile-identity` pins the
// whole shipped library on top.
console.log('== backwards compatibility ==');
{
  const g = mkGraph();
  const step = g.n('step');
  const ga = g.n('getCellAttribute', { attributeId: 'a' });
  const gb = g.n('getCellAttribute', { attributeId: 'b' });
  // visibleCount 3 with only a + b wired: port `c` is UNWIRED, so its inline
  // constant is exactly the case the port-typing change touches.
  const le = g.n('logicalExpression', { expression: '(a AND NOT b) OR (c XOR true)', visibleCount: 3 });
  g.v(ga, 'value', le, 'a'); g.v(gb, 'value', le, 'b');
  const set = g.n('setAttribute', { attributeId: 'out' });
  g.v(le, 'result', set, 'value');
  g.f(step, 'do', set, 'do');
  const m2 = M.migrateForHarness({
    schemaVersion: 2,
    properties: {
      name: 'BackCompat', description: '', topology: '2d-grid', boundaryTreatment: 'torus',
      updateMode: 'synchronous', gridWidth: 4, gridHeight: 1, dimension: '2d', gridDepth: 1, useWasm: false,
    },
    attributes: ['a', 'b', 'out'].map(cellAttr),
    neighborhoods: [], mappings: [], indicators: [],
    graphNodes: g.nodes, graphEdges: g.edges, macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  });

  const wgB = M.compileGraphWebGPU(m2.graphNodes, m2.graphEdges, m2);
  check('back-compat fixture compiles on WebGPU', !wgB.error, wgB.error ?? '');
  if (!wgB.error) {
    const line = /let\s+_?lexp\w*\s*:\s*bool\s*=\s*([^;]+);/.exec(wgB.shaderCode)?.[1] ?? '';
    // The UNWIRED port `c` reads as the i32 form `(0 != 0)`, exactly as it did
    // when the ports were declared `bool` — NOT the f32 `(0.0 != 0.0)` that an
    // unfolded `any` port would have produced.
    check('an UNWIRED port still emits the i32 bool cast `(0 != 0)`',
      line.includes('(0 != 0)'), line);
    check('…and NOT the f32 form `(0.0 != 0.0)`', !line.includes('(0.0 != 0.0)'), line);
    check('a comparison-free formula emits NO f32 comparison', !/ [<>]=? /.test(line), line);
  }

  const jsB = M.compileGraph(m2.graphNodes, m2.graphEdges, m2);
  check('back-compat fixture compiles on JS', !jsB.error, jsB.error ?? '');
  if (!jsB.error) {
    check('JS emits the unchanged truthy form for an unwired port',
      /!!\(0\)|!!\(false\)/.test(jsB.stepCode), 'no !!( … ) for the unwired port');
  }

  const layB = M.computeLayoutFromModel(m2);
  const waB = M.compileGraphWasm(m2.graphNodes, m2.graphEdges, m2, layB, M.buildViewerIds(m2));
  check('back-compat fixture compiles on WASM', !waB.error, waB.error ?? '');
  if (!waB.error) {
    // The WASM twin of the WGSL pin above. Unfolded, the unwired port's inline
    // would push `f64.const 0` (0x44 + eight 0x00) and truncate it back to i32
    // (0xAA) — a 10-byte signature that is ABSENT from the folded build and
    // PRESENT without the fold (verified by source mutation: removing the fold
    // grows this module 308 → 316 bytes and makes this signature appear).
    // NOTE: no shipped model uses `logicalExpression`, so `check-compile-identity`
    // cannot cover this — this check and the WGSL one above are the only
    // permanent guards the fold has.
    const bytes = Buffer.from(waB.bytes);
    const sig = Buffer.from([0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0xAA]);
    check('an UNWIRED port emits i32.const, not f64.const→i32.trunc',
      !bytes.includes(sig), `module ${bytes.length} bytes`);
  }
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

  // The COMPARISON tier on the agent surfaces: the mixed formula (every tier,
  // NOT over a comparison, a var-vs-var comparison and a negative decimal
  // literal) plus the equivalent Compare + Logic chain as the oracle.
  const gn = g.n('getCellAttribute', { attributeId: 'n' });
  const gm = g.n('getCellAttribute', { attributeId: 'm' });
  const lec = g.n('logicalExpression', { expression: CMP_MIXED, visibleCount: 2, _varName_a: 'n', _varName_b: 'm' });
  g.v(gn, 'value', lec, 'a'); g.v(gm, 'value', lec, 'b');
  const setC = g.n('setAttribute', { attributeId: 'cmix' });
  g.v(lec, 'result', setC, 'value');
  g.f(set, 'next', setC, 'do');

  const aCmp = (op, xSrc, y) => {
    const cfg = { operation: op, compareType: 'numerical' };
    if (typeof y !== 'object') cfg._port_y = String(y);
    const s = g.n('statement', cfg);
    g.v(xSrc, 'value', s, 'x');
    if (typeof y === 'object') g.v(y, 'value', s, 'y');
    return s;
  };
  const aNot = g.n('logicOperator', { operation: 'NOT' });
  g.v(aCmp('>', gn, 2), 'result', aNot, 'a');
  const aAnd = g.n('logicOperator', { operation: 'AND' });
  g.v(aNot, 'result', aAnd, 'a'); g.v(aCmp('!=', gm, gn), 'result', aAnd, 'b');
  const aOr = g.n('logicOperator', { operation: 'OR' });
  g.v(aAnd, 'result', aOr, 'a'); g.v(aCmp('<=', gn, -1.5), 'result', aOr, 'b');
  const setCo = g.n('setAttribute', { attributeId: 'comix' });
  g.v(aOr, 'result', setCo, 'value');
  g.f(setC, 'next', setCo, 'do');

  const agentAttr = (id) => ({ id, name: id, type: 'bool', description: '', isModelAttribute: false, defaultValue: 'false' });
  const agentFloat = (id) => ({ id, name: id, type: 'float', description: '', isModelAttribute: false, defaultValue: '0' });
  const agentModel = M.migrateForHarness({
    schemaVersion: 1,
    properties: { name: 'LogicalExprAgents', dimension: '2d', gridWidth: 24, gridHeight: 24, gridDepth: 1, topology: '2d-grid', boundaryTreatment: 'torus', useWasm: false, useWebGPU: false },
    topologyMode: { gridCells: false, agents: true },
    centerBased: { enabled: true, maxAgents: 64, maxBonds: 0, worldWidth: 24, worldHeight: 24, seedCount: 8, seedPattern: 'scatter', defaultRadius: 0.5, growthRate: 0, repulsionStiffness: 2, adhesionStiffness: 0, interactionRange: 1.5, drag: 1, timeStep: 0.1, momentum: 0, maxSpeed: 0, neighbourQueryRadius: 8, useBondingPhysics: false, autoBond: false, agentTarget: 'wasm', agentUpdateMode: 'async',
      agentCapabilities: { motion: 'force', body: true, collision: 'off', bonds: 'off', autoBond: false, growth: false, division: false, lifespan: false, populationBirth: false, populationDeath: false, sensing: false, orientation: false, fieldCoupling: false, appearance: true } },
    attributes: [], modelAttributes: [], neighborhoods: [],
    agentAttributes: [...['a', 'b', 'c', 'out', 'cmix', 'comix'].map(agentAttr), ...['n', 'm'].map(agentFloat)],
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
    for (const id of ['a', 'b', 'c', 'out', 'cmix', 'comix']) {
      bufs[`r_${id}`] = new Uint8Array(N); bufs[`w_${id}`] = bufs[`r_${id}`]; // async: write aliases read
    }
    for (const id of ['n', 'm']) {
      bufs[`r_${id}`] = new Float64Array(N); bufs[`w_${id}`] = bufs[`r_${id}`];
    }
    ROWS.forEach((r, i) => { bufs.r_a[i] = r.a; bufs.r_b[i] = r.b; bufs.r_c[i] = r.c; });
    bufs.r_n.set(CMP_N); bufs.r_m.set(CMP_M);
    // Everything else the ABI asks for that this graph never touches.
    const missing = params.filter(p => !(p in bufs));
    for (const p of missing) bufs[p] = p.startsWith('_agent') || p.startsWith('_hash') || p.startsWith('_field') || p.startsWith('_bond')
      ? new Float64Array(N * 4) : 0;
    (0, eval)(code)(...params.map(p => bufs[p]));
    const got = Array.from(bufs.r_out);
    const want = ROWS.map(r => r.want);
    check(`agent JS truth table === [${want.join(',')}]`, got.every((v, i) => v === want[i]), `got [${got.join(',')}]`);

    // The comparison tier on the agent JS surface: independently-computed truth,
    // and the equivalent hand-wired Compare + Logic chain agreeing row for row.
    const gotC = Array.from(bufs.r_cmix), gotO = Array.from(bufs.r_comix);
    const wantC = CMP_N.map((_, i) => cmpMixedWant(i));
    check(`agent JS "${CMP_MIXED}" === [${wantC.join(',')}]`,
      gotC.every((v, i) => v === wantC[i]), `got [${gotC.join(',')}]`);
    check('agent JS mixed formula ≡ the equivalent Compare + Logic node chain',
      gotC.every((v, i) => v === gotO[i]), `formula [${gotC.join(',')}] vs chain [${gotO.join(',')}]`);
  }

  // The agent WGSL must carry the comparison operators over f32 — the agent
  // numeric accessor is the bare `inF32`, so a comparison emits raw f32 operands
  // (the documented WebGPU precision difference the Compare node already has).
  if (!all.agent.webgpu.error) {
    const sh = all.agent.webgpu.shaderCode;
    const lets = [...sh.matchAll(/let\s+_?lgx\w*\s*:\s*f32\s*=\s*select\(0\.0, 1\.0,\s*([\s\S]*?)\);/g)].map(m => m[1]).join('\n');
    for (const op of ['>', '!=', '<=']) {
      check(`agent WGSL emits the ${op} comparison`, lets.includes(` ${op} `), lets.slice(0, 200));
    }
    check('agent WGSL negative literal is parenthesised', /\(-1\.5\)/.test(lets), lets.slice(0, 200));
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
    // The 8 inputs are declared `any`, NOT `bool` — the SAME typing the Compare
    // node gives its own operands, and for the same reason: `portsCompatible`
    // (the connection-drop menu + the drag highlight) filters on the declared
    // type, so a `bool` declaration would hide this node from exactly the
    // numeric sources the comparison tier exists for. The RESULT stays `bool`.
    const ins = def.ports.filter(p => p.kind === 'input');
    check('8 `any` inputs + a bool result',
      ins.length === 8 && ins.every(p => p.dataType === 'any')
      && def.ports.find(p => p.id === 'result')?.dataType === 'bool',
      JSON.stringify(def.ports.map(p => `${p.id}:${p.dataType}`)));
    const cmpDef = M.getNodeDef('statement');
    check('…the same operand typing the Compare node uses',
      cmpDef.ports.filter(p => ['x', 'y'].includes(p.id)).every(p => p.dataType === 'any'),
      JSON.stringify(cmpDef.ports.map(p => `${p.id}:${p.dataType}`)));
    check('inputs keep the bool inline widget (an UNWIRED operand is True/False)',
      ins.every(p => p.inlineWidget === 'bool' && p.defaultValue === 'false'));
    // A NEW node opens with TWO inputs (the `a AND b` shape), matching its Math
    // Expression sibling. Distinct from parser.DEFAULT_VISIBLE_COUNT (3), which
    // is only the fallback for a config that never declared the key at all.
    check('defaults to 2 visible inputs + an empty formula',
      def.defaultConfig.visibleCount === 2 && def.defaultConfig.expression === '');
  }
  check('in the Overseer allowlist', M.OVERSEER_UNIVERSAL_TYPES.has('logicalExpression'));
  // Validation badge.
  const bad = M.detectMissingConfig('logicalExpression', { expression: 'a AND', visibleCount: 3 }, model);
  check('a parse error raises a badge', bad.some(i => /Formula error/i.test(i)), bad.join('; '));
  const empty = M.detectMissingConfig('logicalExpression', { expression: '', visibleCount: 3 }, model);
  check('an empty formula raises a badge', empty.some(i => /Enter a formula/i.test(i)), empty.join('; '));
  const good = M.detectMissingConfig('logicalExpression', { expression: 'a AND b', visibleCount: 3 }, model);
  check('a valid formula raises no badge', good.length === 0, good.join('; '));
  // …and the same for a COMPARISON formula, whose errors must reach the badge
  // with the message that names the fix.
  const cmpCfg = (e) => ({ expression: e, visibleCount: 2, _varName_a: 'n', _varName_b: 'm' });
  const okCmp = M.detectMissingConfig('logicalExpression', cmpCfg('n > 2 AND m <= 5'), model);
  check('a valid COMPARISON formula raises no badge', okCmp.length === 0, okCmp.join('; '));
  const chained = M.detectMissingConfig('logicalExpression', cmpCfg('n < m < 3'), model);
  check('a chained comparison raises a badge naming the AND rewrite',
    chained.some(i => /Chained comparisons/i.test(i) && /AND/.test(i)), chained.join('; '));
  const arith = M.detectMissingConfig('logicalExpression', cmpCfg('n - 2 > 0'), model);
  check('arithmetic raises a badge pointing at a port',
    arith.some(i => /no arithmetic/i.test(i)), arith.join('; '));
}

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
