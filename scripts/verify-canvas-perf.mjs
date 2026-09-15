// CANVAS PERF harness — the two editor-layer disciplines that keep a large
// graph (hundreds of nodes and wires) responsive on the React Flow canvas.
//
// WHY THIS EXISTS
//   `GraphEditorInner` re-renders on EVERY drag tick, selection change and
//   write-back (`nodes` / `edges` are its state). React Flow copies a fixed
//   list of `<ReactFlow>` props into its zustand store whenever their IDENTITY
//   changes (`defaultEdgeOptions`, `snapGrid`, `onMove`, …) and every
//   `EdgeWrapper` subscribes to `defaultEdgeOptions`; the `EdgeRenderer` is
//   `memo`'d on its callback props. So ONE inline literal on a `<ReactFlow>`
//   prop re-rendered every wire on every tick — measured on a 455-node /
//   445-edge graph: 1780 EdgeWrapper renders and ~130 ms of React work per
//   drag tick, all avoidable (2026-09-14). Nothing about this is COMPILED, so
//   `check-compile-identity` proves nothing here; this harness is the net.
//
// HOUSE STYLE
//   Assert VALUES, never "it ran"; every claim is negative-controlled by a
//   deliberate SOURCE MUTATION that must make the suite FAIL; the shipped
//   module is bundled with esbuild and imported, so what is tested is what
//   ships.
//
//   Section A — the `<ReactFlow>` PROP-IDENTITY discipline, read off the
//               GraphEditor source: every prop is a bare identifier (a module
//               constant or a `useCallback`-bound name) — no inline object /
//               array literal, no inline arrow. The RF_* constants live at
//               module scope and the four callbacks are `useCallback`s.
//   Section B — `setConnectedHandlesFromEdges` (graphState.ts) notifies its
//               subscribers ONLY when some node's connected-handle set actually
//               changed, and keeps the previous Set identity for unchanged
//               nodes (that identity is what lets every CaNode's
//               `useSyncExternalStore` skip a re-render). `setConnectionHazards`
//               keeps the same contract.
//
// Run from the repo root:
//   node scripts/verify-canvas-perf.mjs
//   node scripts/verify-canvas-perf.mjs --controls   (the negative controls)

import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(ROOT, 'src', p);

// ---------------------------------------------------------------------------
// harness plumbing
// ---------------------------------------------------------------------------
const QUIET = process.argv.includes('--quiet');
let passed = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) passed++; else failures.push(msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (t) => { if (!QUIET) console.log(`\n=== ${t} ===`); };

const ENTRY = `
export {
  setConnectedHandlesFromEdges, getConnectedHandlesForNode, subscribeConnectedHandles,
  setConnectionHazards, getConnectionHazardsForNode, subscribeConnectionHazards,
} from '../src/modeler/vpl/graphState.ts';
`;

async function loadBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'gca-canvas-perf-'));
  const entryPath = join(ROOT, 'scripts', '__canvas_perf_entry.ts');
  writeFileSync(entryPath, ENTRY);
  const outPath = join(dir, `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await build({
    entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node',
    outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd(),
  });
  const mod = await import(pathToFileURL(outPath).href);
  rmSync(entryPath, { force: true });
  return { mod, dir };
}

// ---------------------------------------------------------------------------
// SECTION A — the <ReactFlow> prop-identity discipline (source anchors)
// ---------------------------------------------------------------------------
section('A — <ReactFlow> props keep a stable identity');
{
  const editor = readFileSync(SRC('modeler/vpl/GraphEditor.tsx'), 'utf8').replace(/\r\n/g, '\n');

  // The JSX tag: from the line that is exactly `<ReactFlow` to the line that is
  // exactly `>` at the same indentation (the props sit one per line between).
  const open = editor.search(/^(\s*)<ReactFlow\s*$/m);
  ok(open >= 0, 'A0: the <ReactFlow opening tag is on its own line');
  const indent = (editor.slice(open).match(/^(\s*)</) ?? ['', ''])[1];
  const closeRe = new RegExp(`^${indent}>\\s*$`, 'm');
  const rest = editor.slice(open);
  const closeAt = rest.search(closeRe);
  ok(closeAt > 0, 'A0: the opening tag closes with a bare `>` line');
  const tag = rest.slice(0, closeAt);
  const lines = tag.split('\n').slice(1).map(l => l.trim()).filter(l => l && !l.startsWith('//'));

  // Group the lines into props: a prop starts with `name=`, a bare `name`, or a
  // spread `{...`. Lines that start with neither belong to the previous prop
  // (a multi-line value).
  const props = [];
  for (const l of lines) {
    const startsProp = /^[A-Za-z][A-Za-z0-9]*(=|$)/.test(l) || l.startsWith('{...');
    if (startsProp || props.length === 0) props.push(l); else props[props.length - 1] += '\n' + l;
  }
  ok(props.length >= 30, `A1: parsed a plausible prop list (${props.length} props)`);

  let inlineLiterals = 0, inlineArrows = 0, multiLine = 0;
  const offenders = [];
  for (const p of props) {
    if (p.startsWith('{...')) {
      // The viewport seed spread is the ONE allowed non-identifier: it decides
      // `defaultViewport` vs `fitView` for the INITIAL render only.
      ok(p.includes('defaultViewport') && p.includes('fitView'),
        'A2: the only spread on <ReactFlow> is the initial-viewport seed');
      continue;
    }
    const m = p.match(/^([A-Za-z0-9]+)=(.*)$/s);
    if (!m) continue;                       // a bare boolean prop
    const [, name, value] = m;
    if (value.includes('\n')) { multiLine++; offenders.push(`${name} (multi-line)`); }
    if (/^\{\s*[[{]/.test(value)) { inlineLiterals++; offenders.push(`${name} (inline literal)`); }
    if (value.includes('=>')) { inlineArrows++; offenders.push(`${name} (inline arrow)`); }
  }
  eq(inlineLiterals, 0, `A3: no inline object/array literal on a <ReactFlow> prop [${offenders.join(', ')}]`);
  eq(inlineArrows, 0, `A4: no inline arrow function on a <ReactFlow> prop [${offenders.join(', ')}]`);
  eq(multiLine, 0, `A5: every <ReactFlow> prop value is a one-line identifier [${offenders.join(', ')}]`);

  // The constants exist at MODULE scope (before the component) and the tag uses them.
  const componentAt = editor.indexOf('export function GraphEditorInner()');
  ok(componentAt > 0, 'A6: GraphEditorInner is where it was');
  const head = editor.slice(0, componentAt);
  for (const [c, prop] of [
    ['RF_DEFAULT_EDGE_OPTIONS', 'defaultEdgeOptions'], ['RF_SNAP_GRID', 'snapGrid'],
    ['RF_PAN_ON_DRAG', 'panOnDrag'], ['RF_DELETE_KEY_CODES', 'deleteKeyCode'], ['RF_PRO_OPTIONS', 'proOptions'],
  ]) {
    ok(new RegExp(`^const ${c}\\b`, 'm').test(head), `A7: ${c} is a module-scope constant`);
    ok(tag.includes(`${prop}={${c}}`), `A7: <ReactFlow ${prop}> is bound to ${c}`);
  }
  // The four callbacks are useCallback-bound and are what the tag passes.
  const body = editor.slice(componentAt);
  for (const [cb, prop] of [
    ['onRfInit', 'onInit'], ['onRfMouseMove', 'onMouseMove'], ['onRfMove', 'onMove'], ['onEdgeDoubleClick', 'onEdgeDoubleClick'],
  ]) {
    ok(body.includes(`const ${cb} = useCallback(`), `A8: ${cb} is a useCallback`);
    ok(tag.includes(`${prop}={${cb}}`), `A8: <ReactFlow ${prop}> is bound to ${cb}`);
  }
  // `onMove` is a STORE-TRACKED field in React Flow (the reason it must be
  // stable) — pin that against the installed dependency so the discipline is
  // re-examined if React Flow ever changes its list.
  const rf = readFileSync(join(ROOT, 'node_modules/@xyflow/react/dist/esm/index.js'), 'utf8');
  const tracked = rf.match(/const reactFlowFieldsToTrack = \[([\s\S]*?)\];/);
  ok(!!tracked, 'A9: React Flow still declares reactFlowFieldsToTrack');
  const trackedNames = tracked ? [...tracked[1].matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]) : [];
  for (const f of ['defaultEdgeOptions', 'snapGrid', 'onMove']) ok(trackedNames.includes(f), `A9: React Flow tracks \`${f}\` in its store (why it must be identity-stable)`);
}

// ---------------------------------------------------------------------------
// SECTION B — the connected-handles / hazards stores notify only on change
// ---------------------------------------------------------------------------
section('B — graphState notifies only on a real change');
const { mod: G, dir: BUNDLE_DIR } = await loadBundle();
{
  const edgesA = () => [
    { id: 'e1', source: 'A', sourceHandle: 'output_value_v', target: 'B', targetHandle: 'input_value_x' },
    { id: 'e2', source: 'A', sourceHandle: 'output_flow_next', target: 'C', targetHandle: 'input_flow_do' },
  ];
  let notifies = 0;
  const unsub = G.subscribeConnectedHandles(() => { notifies++; });

  G.setConnectedHandlesFromEdges(edgesA());
  eq(notifies, 1, 'B1: the first population notifies');
  const setA = G.getConnectedHandlesForNode('A');
  const setB = G.getConnectedHandlesForNode('B');
  eq(setA.size, 2, 'B1: A records both its output handles');
  ok(setB.has('input_value_x'), 'B1: B records its input handle');

  G.setConnectedHandlesFromEdges(edgesA());                 // a FRESH but equal edge list
  eq(notifies, 1, 'B2: an equal edge list (a drag tick) does NOT notify');
  ok(G.getConnectedHandlesForNode('A') === setA, 'B2: A keeps its Set identity');
  ok(G.getConnectedHandlesForNode('B') === setB, 'B2: B keeps its Set identity');

  const edgesB = [...edgesA(), { id: 'e3', source: 'D', sourceHandle: 'output_value_v', target: 'B', targetHandle: 'input_value_y' }];
  G.setConnectedHandlesFromEdges(edgesB);
  eq(notifies, 2, 'B3: a new wire notifies once');
  ok(G.getConnectedHandlesForNode('A') === setA, 'B3: the untouched node keeps its Set identity');
  ok(G.getConnectedHandlesForNode('B') !== setB && G.getConnectedHandlesForNode('B').has('input_value_y'), 'B3: the touched node gets a new Set');

  G.setConnectedHandlesFromEdges(edgesA());
  eq(notifies, 3, 'B4: removing a wire notifies');
  eq(G.getConnectedHandlesForNode('D').size, 0, 'B4: a node with no wires reads the empty set');
  G.setConnectedHandlesFromEdges([]);
  eq(notifies, 4, 'B5: clearing every wire notifies');
  G.setConnectedHandlesFromEdges([]);
  eq(notifies, 4, 'B5: clearing an already-empty store does not');
  unsub();

  // The hazards store: same contract (pinned, not new).
  let hz = 0;
  const unsubH = G.subscribeConnectionHazards(() => { hz++; });
  G.setConnectionHazards(new Map([['B', ['h1']]]));
  eq(hz, 1, 'B6: a new hazard notifies');
  const listB = G.getConnectionHazardsForNode('B');
  G.setConnectionHazards(new Map([['B', ['h1']]]));
  eq(hz, 1, 'B6: an equal hazard map does not notify');
  ok(G.getConnectionHazardsForNode('B') === listB, 'B6: the unchanged list keeps its identity');
  G.setConnectionHazards(new Map());
  eq(hz, 2, 'B6: clearing notifies');
  unsubH();
}
rmSync(BUNDLE_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — `--controls`
//   Each applies a deliberate SOURCE MUTATION to a SHIPPED file, re-runs the
//   whole suite in a child process, and requires it to FAIL. The source is
//   restored byte-exactly afterwards, whatever happens.
// ---------------------------------------------------------------------------
if (process.argv.includes('--controls')) {
  const CONTROLS = [
    {
      n: 1, file: 'modeler/vpl/GraphEditor.tsx', targets: 'A3 / A7 (an inline literal on a tracked prop)',
      what: 'put the defaultEdgeOptions object literal back inline',
      edits: [['defaultEdgeOptions={RF_DEFAULT_EDGE_OPTIONS}', "defaultEdgeOptions={{ style: { stroke: '#4cc9f0', strokeWidth: 2 }, interactionWidth: 15 }}"]],
    },
    {
      n: 2, file: 'modeler/vpl/GraphEditor.tsx', targets: 'A4 / A8 (an inline arrow on a memo/tracked prop)',
      what: 'put the onEdgeDoubleClick arrow back inline',
      edits: [['onEdgeDoubleClick={onEdgeDoubleClick}', 'onEdgeDoubleClick={(_event, edge) => { setEdges(eds => eds.filter(e => e.id !== edge.id)); scheduleSync(); }}']],
    },
    {
      n: 3, file: 'modeler/vpl/graphState.ts', targets: 'B2 / B5 (notify only on change)',
      what: 'notify the connected-handles subscribers unconditionally',
      edits: [['  if (changed) connectedHandlesListeners.forEach(fn => fn());', '  connectedHandlesListeners.forEach(fn => fn());']],
    },
    {
      n: 4, file: 'modeler/vpl/graphState.ts', targets: 'B2 / B3 (the per-node Set identity)',
      what: 'stop reusing the previous Set for an unchanged node',
      edits: [['      if (same) { next.set(nodeId, prevSet); continue; }', '      if (same) { changed = true; }']],
    },
  ];
  console.log('\n=== NEGATIVE CONTROLS (each mutation must make the suite FAIL) ===');
  const { execFileSync } = await import('child_process');
  let controlFailures = 0;
  const originals = new Map();   // path -> Buffer (restored BYTE-exactly; GraphEditor.tsx carries NUL bytes)
  const originalOf = (file) => { const p = SRC(file); if (!originals.has(p)) originals.set(p, readFileSync(p)); return originals.get(p); };
  try {
    for (const c of CONTROLS) {
      const target = SRC(c.file);
      const buf = originalOf(c.file);
      const original = buf.toString('utf8');
      /** ⚠ LINE ENDINGS — `core.autocrlf` checks graphState.ts out as CRLF on
       *  Windows while this harness is written with `\n`; every anchor is
       *  translated to the file's own EOL before matching. */
      const EOL = original.includes('\r\n') ? '\r\n' : '\n';
      let mutated = original;
      let applied = true;
      for (const [from, to] of c.edits) {
        const needle = from.split('\n').join(EOL);
        if (!mutated.includes(needle)) { applied = false; break; }
        mutated = mutated.split(needle).join(to.split('\n').join(EOL));
      }
      if (!applied) {
        console.log(`FAIL  control ${c.n}: the mutation anchor is GONE — ${c.what}`);
        controlFailures++;
        continue;
      }
      writeFileSync(target, mutated);
      let suiteFailed = false;
      let out = '';
      try {
        out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify-canvas-perf.mjs'), '--quiet'],
          { cwd: ROOT, encoding: 'utf8' });
      } catch (err) {
        suiteFailed = true;
        out = String(err.stdout ?? '');
      }
      writeFileSync(target, buf);
      const summary = out.trim().split('\n').pop() ?? '';
      if (suiteFailed) console.log(`  ok  control ${c.n} — ${c.what} ⇒ ${c.targets} FAILS (${summary})`);
      else { console.log(`FAIL  control ${c.n} — ${c.what} ⇒ the suite still PASSED (${summary})`); controlFailures++; }
    }
  } finally {
    for (const [p, buf] of originals) {
      writeFileSync(p, buf);
      if (!readFileSync(p).equals(buf)) { console.log(`FAIL  ${p} was NOT restored byte-exactly`); controlFailures++; }
    }
  }
  console.log(controlFailures === 0
    ? `NEGATIVE CONTROLS ✓ — ${CONTROLS.length}/${CONTROLS.length} discriminate`
    : `${controlFailures} CONTROL FAILURE(S)`);
  process.exit(failures.length === 0 && controlFailures === 0 ? 0 : 1);
}

if (!QUIET) {
  section('RESULT');
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(failures.length === 0
    ? `CANVAS PERF ✓ — ${passed} checks passed`
    : `${failures.length} FAILURE(S) — ${passed} checks passed`);
} else {
  console.log(`${failures.length} failure(s), ${passed} checks passed`);
}
process.exit(failures.length === 0 ? 0 : 1);
