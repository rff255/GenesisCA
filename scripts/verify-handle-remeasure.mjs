// HANDLE-REMEASURE invariant harness (VPL editor layer).
//
// WHY THIS EXISTS
//   React Flow keys `internals.handleBounds` by HANDLE id, and a handle id is
//   `${kind}_${category}_${portId}` (types.ts `handleId`). A node whose port set
//   changes without changing the node's HEIGHT gets no ResizeObserver callback,
//   so CaNode nudges React Flow itself with a `useEffect` keyed on a port
//   SIGNATURE. If that signature is built from the bare PORT ids, a port whose
//   CATEGORY flips (value ⇄ flow) while its id stays the same produces NO
//   signature change → no remeasure → the store keeps bounds for a handle the
//   DOM no longer has and none for the one it does → the new handle refuses
//   every connection until something else forces a remeasure.
//
//   That was a real shipped bug: adding a port on a macro boundary node and
//   switching it to Flow made it unconnectable, and adding ANOTHER port (which
//   DOES change the port-id set) was the user's workaround. Measured in the real
//   app against React Flow's own store, before the fix:
//       DOM   ["input_flow_out_0",  "input_value_out_1"]
//       store ["input_value_out_0", "input_value_out_1"]   ← stale, 0 rAF queued
//
// WHAT THIS CAN AND CANNOT PROVE
//   The effect needs a React tree + a live React Flow store, so it cannot run
//   headlessly — these are SOURCE INVARIANTS in the `verify-agent-render.mjs`
//   tier-B style: anchored (function-body scoped, never a bare whole-file grep)
//   assertions on the lines whose absence caused the bug, plus the PREMISES the
//   fix rests on (handleId encodes the category; the macro boundary/instance
//   really does derive a port's category from mutable model data). They catch a
//   deletion/rewiring regression, not a new logic error.
//
//   `--self-test` is the NEGATIVE CONTROL: it re-runs the signature assertions
//   against the pre-fix text and requires them to FAIL.
//
// Run from the repo root:  node scripts/verify-handle-remeasure.mjs
//                          node scripts/verify-handle-remeasure.mjs --self-test
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(ROOT, 'src', p);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const fileCache = new Map();
const readSrc = (rel) => {
  if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(SRC(rel), 'utf8'));
  return fileCache.get(rel);
};

/** Text of a balanced `{...}` block starting at the first line matching `startRe`.
 *  The brace search starts at the END of the match so a regex may consume a
 *  signature / return type and still land on the body brace. Returns '' when the
 *  anchor is gone (⇒ the assertion fails loudly instead of passing vacuously). */
function blockAfter(src, startRe) {
  const m = startRe.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index + m[0].length);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}

const caNode = readSrc('modeler/vpl/CaNode.tsx');
const types = readSrc('modeler/vpl/types.ts');

// ---------------------------------------------------------------------------
// 1. THE PREMISE — a handle id encodes the CATEGORY, so a category flip destroys
//    one handle and creates another. If handleId ever stops encoding it, the
//    signature below silently stops covering the flip.
// ---------------------------------------------------------------------------
section('handleId premise');
{
  const body = blockAfter(types, /export function handleId\s*\(/);
  check('handleId body found', body.length > 0);
  check('handleId encodes kind + category + port id',
    /\$\{\s*port\.kind\s*\}_\$\{\s*port\.category\s*\}_\$\{\s*port\.id\s*\}/.test(body),
    body.trim().slice(0, 120));
}

// ---------------------------------------------------------------------------
// 2. THE FIX — the remeasure signature is the HANDLE ids, not the bare port ids.
// ---------------------------------------------------------------------------
section('remeasure signature');

/** The `const portIdSignature = …;` initialiser text (may span lines). */
function signatureExpr(src) {
  const m = /const portIdSignature\s*=([\s\S]*?);\r?\n/.exec(src);
  return m ? m[1] : '';
}
/** The dep array of the `useEffect` that calls `updateNodeInternals(id)` and is
 *  keyed on `portIdSignature` (there are three such effects in CaNode — the
 *  collapsed fan-out, this one, and the Expression width one). */
function signatureEffectDeps(src) {
  const m = /\}, \[updateNodeInternals, id, portIdSignature\]\)/.exec(src);
  return m ? m[0] : '';
}

function assertSignature(src, label, expectFixed) {
  const expr = signatureExpr(src);
  const usesHandleId = /\.map\(\s*handleId\s*\)/.test(expr) || /handleId\(/.test(expr);
  const usesBarePortId = /\.map\(\s*\(?\s*p\s*\)?\s*=>\s*p\.id\s*\)/.test(expr);
  const bothSides = (expr.match(/inputPorts/g) || []).length >= 1 && (expr.match(/outputPorts/g) || []).length >= 1;
  const ok = expr.length > 0 && usesHandleId && !usesBarePortId && bothSides;
  if (expectFixed) {
    check(`${label}: portIdSignature initialiser found`, expr.length > 0);
    check(`${label}: signature is built from handleId(...)`, usesHandleId, expr.trim().slice(0, 160));
    check(`${label}: signature does NOT use bare p.id (the pre-fix form)`, !usesBarePortId, expr.trim().slice(0, 160));
    check(`${label}: signature covers BOTH inputPorts and outputPorts`, bothSides);
  }
  return ok;
}
assertSignature(caNode, 'CaNode', true);
check('the remeasure effect is keyed on portIdSignature',
  signatureEffectDeps(caNode).length > 0,
  'expected a useEffect with deps [updateNodeInternals, id, portIdSignature]');
check('handleId is imported by CaNode', /import \{[^}]*\bhandleId\b[^}]*\} from '\.\/types'/.test(caNode));

// ---------------------------------------------------------------------------
// 3. THE SITE — a macro boundary node / closed instance derives each port's
//    CATEGORY from mutable model data (MacroPort.category, edited by the
//    boundary node's Val/Flow select), which is what makes the id stable while
//    the handle id moves. If these stop being category-mutable the fix is inert
//    (and this harness should be revisited rather than silently kept).
// ---------------------------------------------------------------------------
section('category-mutable port sites');
{
  const catFromDef = (caNode.match(/category:\s*p\.category \|\| 'value' as const/g) || []).length;
  check('macro / macroInput / macroOutput derive category from the MacroDef port (4 sites)',
    catFromDef === 4, `found ${catFromDef}`);
  const changer = blockAfter(caNode, /const changePortCategory = useCallback\(/);
  check('changePortCategory writes MacroPort.category', /\{ \.\.\.p, category: cat \}/.test(changer));
  check('the boundary editor offers a value ⇄ flow select',
    /changePortCategory\(/.test(caNode) && /value="flow"/.test(caNode));
}

// ---------------------------------------------------------------------------
// 4. THE CONSEQUENCE the signature also has to cover — the FIRST flow port is
//    lifted out of the body into the header, so a category flip re-indexes every
//    surviving body port. Without a remeasure their recorded positions go stale
//    too (measured: `input_value_out_1` stayed at y=50 while the DOM had it at
//    y=28).
// ---------------------------------------------------------------------------
section('main-flow lift (why the OTHER ports go stale too)');
check('mainFlowIn lifts the first flow INPUT out of the body',
  /const mainFlowIn = inputPorts\.find\(p => p\.category === 'flow'\)/.test(caNode));
check('mainFlowOut lifts the first flow OUTPUT out of the body',
  /outputPorts\.find\(p => p\.category === 'flow'\)/.test(caNode));
check('the body port lists exclude the lifted ports',
  /const bodyInputPorts = mainFlowIn \? inputPorts\.filter/.test(caNode) &&
  /const bodyOutputPorts = mainFlowOut \? outputPorts\.filter/.test(caNode));

// ---------------------------------------------------------------------------
// 5. NEGATIVE CONTROL — the pre-fix text must FAIL the section-2 assertions.
// ---------------------------------------------------------------------------
if (process.argv.includes('--self-test')) {
  section('SELF-TEST (negative control)');
  const preFix = caNode.replace(
    /const portIdSignature\s*=[\s\S]*?;\r?\n/,
    "const portIdSignature = inputPorts.map(p => p.id).join(',') + '|' + outputPorts.map(p => p.id).join(',');\n",
  );
  check('the pre-fix mutation applied', preFix !== caNode);
  const stillPasses = assertSignature(preFix, 'pre-fix', false);
  check('pre-fix signature FAILS the handleId assertions', !stillPasses,
    'the bare-p.id form was accepted — this harness would not have caught the bug');
}

section('RESULT');
if (failures === 0) console.log('HANDLE-REMEASURE INVARIANTS ✓');
else console.log(`${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
