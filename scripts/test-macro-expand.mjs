// MACRO EXPANSION — the shared flattening every compile target runs.
//
// WHY THIS EXISTS: `expandMacros` is the ONE place a macro instance becomes flat
// nodes + edges, so a wire it drops disappears from JS, WASM *and* WebGPU at
// once — with no error anywhere. `check-compile-identity.mjs` proves the shipped
// models are unchanged and proves NOTHING about a shape none of them has. This
// harness builds those shapes in memory and drives the SHIPPED module.
//
//   Tier A — A MULTI-FEEDER input port. A macro FLOW input is multi-occupancy,
//     so two outer flow sources legitimately converge on one port. Both must
//     reach every internal consumer of that port. (The historical code kept ONE
//     feeder per targetHandle in a Map and `break`ed on the first match, so a
//     whole flow path vanished at compile time.)
//   Tier B — THE SINGLE-FEEDER PATH IS UNCHANGED, ids included: the shape every
//     macro that shipped before multi-feeder ports existed still takes.
//   Tier C — THE OUTPUT DIRECTION, which was already per-consumer, now also
//     handles SEVERAL internal sources bridging into one port (the flow
//     convergence Create Macro can now emit) with unique edge ids.
//   Tier D — the product rule end to end (F feeders x B bridges), nesting, and
//     an instance whose port is fed by nothing.
//
// NEGATIVE CONTROL: `node scripts/test-macro-expand.mjs --mutate` patches the
// SHIPPED source back to first-match-wins, re-runs and asserts it FAILS, then
// restores byte-exactly.
//
// Run from the repo root:  node scripts/test-macro-expand.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MUTATE = process.argv.includes('--mutate');

const ENTRY = `
export { expandMacros } from '../src/modeler/vpl/compiler/macroExpand.ts';
`;

async function loadBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'gca-macroexpand-'));
  const entryPath = join(ROOT, 'scripts', '__macroexpand_entry.ts');
  writeFileSync(entryPath, ENTRY);
  const outPath = join(dir, `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
  const mod = await import(pathToFileURL(outPath).href);
  rmSync(entryPath, { force: true });
  return { mod, dir };
}

let pass = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else failures.push(msg); }
function eq(a, b, msg) { ok(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const vIn = p => `input_value_${p}`;
const vOut = p => `output_value_${p}`;
const fIn = p => `input_flow_${p}`;
const fOut = p => `output_flow_${p}`;

const node = (id, nodeType, config = {}) => ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } });
const edge = (id, source, sourceHandle, target, targetHandle) => ({ id, source, sourceHandle, target, targetHandle });
const port = (portId, boundaryId, category = 'value') => ({
  portId, label: portId, dataType: 'any', category, internalNodeId: boundaryId, internalPortId: portId,
});

/** Does the flattened graph carry this exact wire? */
const has = (edges, s, sh, t, th) =>
  edges.some(e => e.source === s && e.sourceHandle === sh && e.target === t && e.targetHandle === th);

async function run(M) {
  pass = 0; failures.length = 0;
  const { expandMacros } = M;

  // The instance is `INST`, so every internal node comes back as `mINST_<id>`.
  const P = id => `mINST_${id}`;

  // =========================================================================
  // Tier A — a MULTI-FEEDER input port
  // =========================================================================
  {
    // def:  mi.in_0 (flow) ──▶ A.do
    // outer: FA.next ─┐
    //        FB.next ─┴──▶ INST.in_0
    const def = {
      id: 'D', name: 'M',
      nodes: [node('mi', 'macroInput'), node('A', 'setAttribute'), node('mo', 'macroOutput')],
      edges: [edge('b0', 'mi', fOut('in_0'), 'A', fIn('do'))],
      exposedInputs: [port('in_0', 'mi', 'flow')],
      exposedOutputs: [],
    };
    const nodes = [node('FA', 'conditional'), node('FB', 'conditional'), node('INST', 'macro', { macroDefId: 'D' })];
    const edges = [
      edge('pa', 'FA', fOut('next'), 'INST', fIn('in_0')),
      edge('pb', 'FB', fOut('next'), 'INST', fIn('in_0')),
    ];
    const r = expandMacros(nodes, edges, { macroDefs: [def] });
    ok(!r.error, 'A1 expansion succeeds');
    ok(!r.nodes.some(n => ['macro', 'macroInput', 'macroOutput'].includes(n.data.nodeType)), 'A1 no boundary/instance node survives');
    ok(has(r.edges, 'FA', fOut('next'), P('A'), fIn('do')), 'A1 feeder FA reaches the internal consumer');
    ok(has(r.edges, 'FB', fOut('next'), P('A'), fIn('do')), 'A1 feeder FB reaches it TOO — the dropped-feeder bug');
    eq(r.edges.length, 2, 'A1 exactly the two wires, nothing invented');
    eq(new Set(r.edges.map(e => e.id)).size, r.edges.length, 'A1 the expanded edge ids are unique');
  }

  // A2 — a multi-feeder port that ALSO fans out inside: the full F x B product.
  {
    const def = {
      id: 'D', name: 'M',
      nodes: [node('mi', 'macroInput'), node('A', 'setAttribute'), node('B', 'setAttribute'), node('mo', 'macroOutput')],
      edges: [
        edge('b0', 'mi', fOut('in_0'), 'A', fIn('do')),
        edge('b1', 'mi', fOut('in_0'), 'B', fIn('do')),
      ],
      exposedInputs: [port('in_0', 'mi', 'flow')],
      exposedOutputs: [],
    };
    const nodes = [node('FA', 'conditional'), node('FB', 'conditional'), node('INST', 'macro', { macroDefId: 'D' })];
    const edges = [
      edge('pa', 'FA', fOut('next'), 'INST', fIn('in_0')),
      edge('pb', 'FB', fOut('next'), 'INST', fIn('in_0')),
    ];
    const r = expandMacros(nodes, edges, { macroDefs: [def] });
    eq(r.edges.length, 4, 'A2 2 feeders x 2 bridges = 4 expanded wires');
    for (const f of ['FA', 'FB']) for (const t of ['A', 'B']) {
      ok(has(r.edges, f, fOut('next'), P(t), fIn('do')), `A2 ${f} reaches ${t}`);
    }
    eq(new Set(r.edges.map(e => e.id)).size, 4, 'A2 all four ids are distinct');
  }

  // =========================================================================
  // Tier B — the SINGLE-feeder path is unchanged, ids included
  // =========================================================================
  {
    const def = {
      id: 'D', name: 'M',
      nodes: [node('mi', 'macroInput'), node('A', 'arithmeticOperator'), node('mo', 'macroOutput')],
      edges: [
        edge('b0', 'mi', vOut('in_0'), 'A', vIn('x')),
        edge('b1', 'A', vOut('value'), 'mo', vIn('out_0')),
      ],
      exposedInputs: [port('in_0', 'mi')],
      exposedOutputs: [port('out_0', 'mo')],
    };
    const nodes = [node('SRC', 'getConstant'), node('INST', 'macro', { macroDefId: 'D' }), node('DST', 'setAttribute')];
    const edges = [
      edge('pin', 'SRC', vOut('value'), 'INST', vIn('in_0')),
      edge('pout', 'INST', vOut('out_0'), 'DST', vIn('value')),
    ];
    const r = expandMacros(nodes, edges, { macroDefs: [def] });
    eq(r.edges.length, 2, 'B1 a plain value macro expands to exactly two wires');
    ok(has(r.edges, 'SRC', vOut('value'), P('A'), vIn('x')), 'B1 the outer source feeds the internal node');
    ok(has(r.edges, P('A'), vOut('value'), 'DST', vIn('value')), 'B1 the internal node feeds the outer consumer');
    // The historical ids: an input bridge keeps `m<inst>_<defEdgeId>`, and an
    // output one keeps the OUTER edge's own id.
    eq(r.edges.find(e => e.target === P('A'))?.id, 'mINST_b0', 'B1 the input wire keeps its historical id');
    eq(r.edges.find(e => e.source === P('A'))?.id, 'pout', 'B1 the output wire keeps the outer edge id');
    eq(r.nodes.length, 3, 'B1 SRC + DST + the one internal node');
  }

  // =========================================================================
  // Tier C — the OUTPUT direction
  // =========================================================================
  // C1 — one internal source, TWO outer consumers (the fan-out that already worked).
  {
    const def = {
      id: 'D', name: 'M',
      nodes: [node('mi', 'macroInput'), node('A', 'arithmeticOperator'), node('mo', 'macroOutput')],
      edges: [edge('b1', 'A', vOut('value'), 'mo', vIn('out_0'))],
      exposedInputs: [],
      exposedOutputs: [port('out_0', 'mo')],
    };
    const nodes = [node('INST', 'macro', { macroDefId: 'D' }), node('D1', 'setAttribute'), node('D2', 'setAttribute')];
    const edges = [
      edge('o1', 'INST', vOut('out_0'), 'D1', vIn('value')),
      edge('o2', 'INST', vOut('out_0'), 'D2', vIn('value')),
    ];
    const r = expandMacros(nodes, edges, { macroDefs: [def] });
    eq(r.edges.length, 2, 'C1 both consumers keep their wire');
    ok(has(r.edges, P('A'), vOut('value'), 'D1', vIn('value')), 'C1 consumer 1');
    ok(has(r.edges, P('A'), vOut('value'), 'D2', vIn('value')), 'C1 consumer 2');
  }

  // C2 — TWO internal sources bridging into ONE output port (the flow
  // convergence Create Macro now emits), one outer consumer.
  {
    const def = {
      id: 'D', name: 'M',
      nodes: [node('mi', 'macroInput'), node('A', 'setAttribute'), node('B', 'setAttribute'), node('mo', 'macroOutput')],
      edges: [
        edge('b1', 'A', fOut('next'), 'mo', fIn('out_0')),
        edge('b2', 'B', fOut('next'), 'mo', fIn('out_0')),
      ],
      exposedInputs: [],
      exposedOutputs: [port('out_0', 'mo', 'flow')],
    };
    const nodes = [node('INST', 'macro', { macroDefId: 'D' }), node('OUT', 'conditional')];
    const edges = [edge('o1', 'INST', fOut('out_0'), 'OUT', fIn('do'))];
    const r = expandMacros(nodes, edges, { macroDefs: [def] });
    eq(r.edges.length, 2, 'C2 both internal sources reach the outer consumer');
    ok(has(r.edges, P('A'), fOut('next'), 'OUT', fIn('do')), 'C2 internal source A');
    ok(has(r.edges, P('B'), fOut('next'), 'OUT', fIn('do')), 'C2 internal source B');
    eq(new Set(r.edges.map(e => e.id)).size, 2, 'C2 the two expanded wires have DISTINCT ids');
  }

  // =========================================================================
  // Tier D — nesting, and a port nothing feeds
  // =========================================================================
  // D1 — a multi-feeder port INSIDE a nested macro still expands both feeders.
  {
    const inner = {
      id: 'IN', name: 'inner',
      nodes: [node('imi', 'macroInput'), node('Z', 'setAttribute'), node('imo', 'macroOutput')],
      edges: [edge('ib', 'imi', fOut('in_0'), 'Z', fIn('do'))],
      exposedInputs: [port('in_0', 'imi', 'flow')],
      exposedOutputs: [],
    };
    // The outer def holds the inner INSTANCE, fed by two of its own flow inputs.
    const outer = {
      id: 'D', name: 'outer',
      nodes: [node('mi', 'macroInput'), node('NEST', 'macro', { macroDefId: 'IN' }), node('mo', 'macroOutput')],
      edges: [
        edge('b0', 'mi', fOut('in_0'), 'NEST', fIn('in_0')),
        edge('b1', 'mi', fOut('in_1'), 'NEST', fIn('in_0')),
      ],
      exposedInputs: [port('in_0', 'mi', 'flow'), port('in_1', 'mi', 'flow')],
      exposedOutputs: [],
    };
    const nodes = [node('FA', 'conditional'), node('FB', 'conditional'), node('INST', 'macro', { macroDefId: 'D' })];
    const edges = [
      edge('pa', 'FA', fOut('next'), 'INST', fIn('in_0')),
      edge('pb', 'FB', fOut('next'), 'INST', fIn('in_1')),
    ];
    const r = expandMacros(nodes, edges, { macroDefs: [outer, inner] });
    ok(!r.error, 'D1 the nested expansion succeeds');
    ok(!r.nodes.some(n => ['macro', 'macroInput', 'macroOutput'].includes(n.data.nodeType)), 'D1 fully flat');
    eq(r.edges.length, 2, 'D1 both outer feeders survive two levels of expansion');
    const zid = r.nodes.find(n => n.data.nodeType === 'setAttribute')?.id;
    ok(has(r.edges, 'FA', fOut('next'), zid, fIn('do')), 'D1 FA reaches the doubly-nested consumer');
    ok(has(r.edges, 'FB', fOut('next'), zid, fIn('do')), 'D1 FB does too');
  }

  // D2 — a bridge whose port has NO outer feeder emits nothing (and does not throw).
  {
    const def = {
      id: 'D', name: 'M',
      nodes: [node('mi', 'macroInput'), node('A', 'setAttribute'), node('mo', 'macroOutput')],
      edges: [edge('b0', 'mi', fOut('in_0'), 'A', fIn('do'))],
      exposedInputs: [port('in_0', 'mi', 'flow')],
      exposedOutputs: [],
    };
    const r = expandMacros([node('INST', 'macro', { macroDefId: 'D' })], [], { macroDefs: [def] });
    eq(r.edges.length, 0, 'D2 an unfed input port contributes no wire');
    eq(r.nodes.length, 1, 'D2 …but the internal node is still expanded');
  }

  return { pass, failures: [...failures] };
}

const SRC_PATH = join(ROOT, 'src', 'modeler', 'vpl', 'compiler', 'macroExpand.ts');

async function once(label) {
  const { mod, dir } = await loadBundle();
  const res = await run(mod);
  rmSync(dir, { recursive: true, force: true });
  if (label) console.log(`  ${label}: ${res.pass} passed, ${res.failures.length} failed`);
  return res;
}

const base = await once(null);
console.log(`macro expand: ${base.pass} checks passed, ${base.failures.length} failed`);
for (const f of base.failures) console.log(`  FAIL ${f}`);

if (MUTATE) {
  // NEGATIVE CONTROL — put the historical first-match-wins logic back and prove
  // the suite notices. Snapshot as a BUFFER, never a /tmp copy: MSYS translates
  // CRLF→LF there, so a text round-trip would not restore the original bytes.
  const original = readFileSync(SRC_PATH);
  const MUTATIONS = [
    ['first-match-wins: only ONE outer feeder per input port reaches inside',
      'const feeders = extInMap.get(epPortId) ?? [];',
      'const feeders = (extInMap.get(epPortId) ?? []).slice(0, 1);'],
    ['the output arm stops looping its internal bridges',
      'const seen = outBridgeSeen.get(epPortId) ?? 0;',
      'const seen = outBridgeSeen.get(epPortId) ?? 0; if (seen > 0) { outBridgeSeen.set(epPortId, seen + 1); continue; }'],
  ];
  let caught = 0;
  for (const [label, from, to] of MUTATIONS) {
    const txt = original.toString('utf8');
    if (!txt.includes(from)) { console.log(`  MUTATION ANCHOR MISSING: ${label}`); continue; }
    writeFileSync(SRC_PATH, Buffer.from(txt.replace(from, to), 'utf8'));
    try {
      const res = await once(`mutation "${label}"`);
      if (res.failures.length > 0) caught++;
      else console.log(`  NOT CAUGHT: ${label}`);
    } finally {
      writeFileSync(SRC_PATH, original);
    }
  }
  console.log(`negative control: ${caught}/${MUTATIONS.length} mutations caught`);
  if (caught !== MUTATIONS.length) process.exitCode = 1;
}

if (base.failures.length > 0) process.exitCode = 1;
