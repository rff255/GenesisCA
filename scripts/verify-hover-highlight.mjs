// HOVER HIGHLIGHT harness — the pure module behind the graph-canvas hover
// gesture. Plan: docs/PLAN_HOVER_HIGHLIGHT.md §5.1.
//
// WHY THIS EXISTS
//   `computeHoverMarks` decides which nodes, dots and wires light when the
//   cursor rests on a node. Nothing about a hover is COMPILED — no schema field,
//   no worker message, no emitted surface — so `check-compile-identity` proves
//   nothing at all about it (it must report "all surfaces unchanged", and that
//   is a gate, not evidence). This harness is the entire regression net, exactly
//   as verify-auto-layout.mjs is for Organize.
//
// HOUSE STYLE
//   Assert VALUES, never "it ran". Every fixture DISCRIMINATES (each is the
//   shape that exposes one specific mistake), and every claim is
//   negative-controlled by a deliberate SOURCE MUTATION that must make the suite
//   FAIL. The shipped module is bundled with esbuild and imported, so what is
//   tested is what ships.
//
//   Section A — H1..H9 / H11 on synthetic fixtures (the three zones, the
//               reroute chain, the reroute fan-out, hovering a dot, the WIRE
//               hover (H7) and the PORT hover (H8), the hysteresis ladder, the
//               colour lift's pinned outputs, and a CYCLIC hand-made dot pair
//               that must not hang).
//   Section B — the SOURCE MIRRORS this feature depends on: the two wire
//               colours are `toRFEdges`' own inline literals; the handle-id
//               PREFIXES the port walk reads are `handleId()`'s own encoding;
//               the CSS block is declared AFTER the trace block (that ordering
//               is the hover-over-trace precedence); the marks are an ATTRIBUTE
//               plus two custom properties, never a class; the port channel is
//               published by every handle and subscribed ONCE; the editor
//               imports the constants instead of re-inlining them.
//   Section C — the LIBRARY SWEEP (H12): every shipped .gcaproj, every scope
//               (root cells / agents / overseer + every macro def), every node,
//               all three zones, PLUS every wired handle and every wire,
//               checked against INDEPENDENT reference walks (edge-scan rounds,
//               not the module's adjacency-map stack).
//
//   H10 (the Alt cone) is P3 and deliberately absent.
//
// Run from the repo root:
//   node scripts/verify-hover-highlight.mjs
//   node scripts/verify-hover-highlight.mjs --controls   (the negative controls)
import { build } from 'esbuild';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
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
const sameSet = (a, b, msg) => {
  const A = [...a].sort(); const B = [...b].sort();
  ok(A.length === B.length && A.every((v, i) => v === B[i]),
    `${msg} — expected {${B.join(', ')}}, got {${A.join(', ')}}`);
};
const section = (t) => { if (!QUIET) console.log(`\n=== ${t} ===`); };

const ENTRY = `
export { buildHoverIndex, computeHoverMarks, zoneForRatio, hoverGlowColor,
         hoverSoftColor, edgeCategoryOf, categoryBaseColor, hoverNodeKind,
         hoverHandleKey, handleDirection,
         HOVER_DWELL_MS, HOVER_GLOW_L, HOVER_WIRE_GLOW_L,
         HOVER_ENTER_LEFT, HOVER_LEAVE_LEFT, HOVER_ENTER_RIGHT, HOVER_LEAVE_RIGHT,
         EDGE_FLOW_COLOR, EDGE_VALUE_COLOR, HOVER_FALLBACK_COLOR
       } from '../src/modeler/vpl/hoverHighlight.ts';
`;

async function loadBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'gca-hover-'));
  const entryPath = join(ROOT, 'scripts', '__hover_entry.ts');
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

const { mod: H, dir: BUNDLE_DIR } = await loadBundle();
const {
  buildHoverIndex, computeHoverMarks, zoneForRatio, hoverGlowColor, hoverSoftColor,
  hoverNodeKind, hoverHandleKey, handleDirection,
  HOVER_DWELL_MS, HOVER_GLOW_L, HOVER_WIRE_GLOW_L,
  HOVER_ENTER_LEFT, HOVER_LEAVE_LEFT, HOVER_ENTER_RIGHT, HOVER_LEAVE_RIGHT,
  EDGE_FLOW_COLOR, EDGE_VALUE_COLOR,
} = H;

// ---------------------------------------------------------------------------
// fixture builders. Handle ids are the REAL encoding (`kind_category_portId`) —
// the module reads the category off them exactly as `toRFEdges` does, so a
// fixture with fake handles would not exercise the code that ships.
// ---------------------------------------------------------------------------
const node = (id) => ({ id, type: 'caNode', data: { nodeType: 'setAttribute' } });
const dot = (id, cat = 'value') => ({ id, type: 'rerouteNode', data: { nodeType: 'reroute', portCategory: cat } });
const group = (id) => ({ id, type: 'groupNode', data: { label: 'g', nodeType: 'group' } });
const comment = (id) => ({ id, type: 'commentNode', data: { text: 'hi' } });

const flowE = (id, s, t) => ({ id, source: s, target: t, sourceHandle: 'output_flow_next', targetHandle: 'input_flow_do' });
const valE = (id, s, t, p = 0) => ({ id, source: s, target: t, sourceHandle: 'output_value_value', targetHandle: `input_value_p${p}` });

/** node marks of one kind, as ids */
const idsOf = (marks, mark) => [...marks.nodes].filter(([, m]) => m === mark).map(([id]) => id);
const edgeIdsOf = (marks, mark) => [...marks.edges].filter(([, m]) => m === mark).map(([id]) => id);
const marksFor = (ix, id, zone) => computeHoverMarks(ix, { kind: 'node', id, zone });
const marksForEdge = (ix, id) => computeHoverMarks(ix, { kind: 'edge', id });
const marksForPort = (ix, nodeId, handleId) => computeHoverMarks(ix, { kind: 'port', nodeId, handleId });

// ---------------------------------------------------------------------------
// SECTION A — the invariants on synthetic fixtures
// ---------------------------------------------------------------------------
section('A — zones, reroute walks, hysteresis, the colour lift');

// --- H1 / H2 / H3: the three zones on a flow chain with a value feed ---------
// A -> B -> C on the exec spine, plus V -> B on a value port. Hovering B's LEFT
// third must reach A and V and NOTHING downstream; the RIGHT third must reach C
// and nothing upstream; the middle must reach nothing at all.
{
  const nodes = [node('A'), node('B'), node('C'), node('V'), group('G'), comment('K')];
  const edges = [flowE('ab', 'A', 'B'), flowE('bc', 'B', 'C'), valE('vb', 'V', 'B')];
  const ix = buildHoverIndex(nodes, edges);

  const left = marksFor(ix, 'B', 'in');
  sameSet(edgeIdsOf(left, 'in'), ['ab', 'vb'], 'H1: left third marks exactly the IN wires');
  eq(edgeIdsOf(left, 'out').length, 0, 'H1: left third marks no OUT wire');
  sameSet(idsOf(left, 'self'), ['B'], 'H1: the hovered node is `self`');
  sameSet(idsOf(left, 'peer'), ['A', 'V'], 'H1: the peers are exactly the real producers');
  eq(idsOf(left, 'relay').length, 0, 'H1: no relay without a reroute');
  eq(left.originId, 'B', 'H1: originId names the hovered node');

  const right = marksFor(ix, 'B', 'out');
  sameSet(edgeIdsOf(right, 'out'), ['bc'], 'H2: right third marks exactly the OUT wires');
  eq(edgeIdsOf(right, 'in').length, 0, 'H2: right third marks no IN wire');
  sameSet(idsOf(right, 'peer'), ['C'], 'H2: the peers are exactly the real consumers');

  const mid = marksFor(ix, 'B', 'self');
  sameSet([...mid.nodes.keys()], ['B'], 'H3: the middle third marks the node ONLY');
  eq(mid.edges.size, 0, 'H3: the middle third marks no wire');

  // `both` is the union of the two sides — the algebraic invariant that keeps a
  // dot's "light both sides" honest.
  const both = marksFor(ix, 'B', 'both');
  sameSet([...both.edges.keys()], ['ab', 'vb', 'bc'], 'H1/H2: `both` is the union of in and out');
  sameSet(idsOf(both, 'peer'), ['A', 'C', 'V'], 'H1/H2: `both` peers are every real neighbour');

  // Groups and comments are skipped BY TYPE — nothing to light.
  eq(marksFor(ix, 'G', 'both'), null, 'H1: a GROUP produces no marks at all');
  eq(marksFor(ix, 'K', 'both'), null, 'H1: a COMMENT produces no marks at all');
  eq(marksFor(ix, 'nope', 'both'), null, 'H1: an id outside the scope produces no marks');
  eq(hoverNodeKind(group('x')), 'other', 'H1: hoverNodeKind(group) = other');
  eq(hoverNodeKind(comment('x')), 'other', 'H1: hoverNodeKind(comment) = other');
  eq(hoverNodeKind(dot('x')), 'reroute', 'H1: hoverNodeKind(reroute) = reroute');
  eq(hoverNodeKind(node('x')), 'node', 'H1: hoverNodeKind(caNode) = node');
  eq(hoverNodeKind({ id: 'x', type: 'caNode', data: {} }), 'other',
    'H1: a node with no nodeType is not a rule node');

  // A terminal node's left third is HONEST: it lights itself and nothing else
  // (it does not "fall through" to the outputs).
  const aLeft = marksFor(ix, 'A', 'in');
  sameSet([...aLeft.nodes.keys()], ['A'], 'H3: a root node\'s left third lights only itself');
  eq(aLeft.edges.size, 0, 'H3: ...and no wire');
}

// --- H4: a reroute CHAIN, A -> r1 -> r2 -> B --------------------------------
{
  const nodes = [node('A'), dot('r1'), dot('r2'), node('B')];
  const edges = [valE('e1', 'A', 'r1'), valE('e2', 'r1', 'r2'), valE('e3', 'r2', 'B')];
  const ix = buildHoverIndex(nodes, edges);
  const m = marksFor(ix, 'B', 'in');
  eq(edgeIdsOf(m, 'in').length, 3, 'H4: hovering B-left lights all THREE segments of the chain');
  sameSet(edgeIdsOf(m, 'in'), ['e1', 'e2', 'e3'], 'H4: ...and they are the right three');
  sameSet(idsOf(m, 'relay'), ['r1', 'r2'], 'H4: both dots are marked `relay`');
  sameSet(idsOf(m, 'peer'), ['A'], 'H4: the peer is the REAL producer at the far end, not the dot');
  eq(m.nodes.get('A'), 'peer', 'H4: A is a peer, not a relay');
  // ...and from the other end.
  const fromA = marksFor(ix, 'A', 'out');
  sameSet(edgeIdsOf(fromA, 'out'), ['e1', 'e2', 'e3'], 'H4: A-right lights the same three segments');
  sameSet(idsOf(fromA, 'peer'), ['B'], 'H4: A-right\'s peer is B');
  sameSet(idsOf(fromA, 'relay'), ['r1', 'r2'], 'H4: A-right marks both dots');
  // The middle third of a node fed only through a chain still lights nothing.
  eq(marksFor(ix, 'B', 'self').edges.size, 0, 'H4: B\'s middle third lights no chain segment');
}

// --- H5: a reroute FAN-OUT, A -> r -> {B, C} --------------------------------
{
  const nodes = [node('A'), dot('r'), node('B'), node('C')];
  const edges = [valE('e1', 'A', 'r'), valE('e2', 'r', 'B'), valE('e3', 'r', 'C')];
  const ix = buildHoverIndex(nodes, edges);
  const m = marksFor(ix, 'A', 'out');
  eq(edgeIdsOf(m, 'out').length, 3, 'H5: A-right lights all THREE segments of the fan-out');
  sameSet(idsOf(m, 'relay'), ['r'], 'H5: one dot, marked relay');
  sameSet(idsOf(m, 'peer'), ['B', 'C'], 'H5: BOTH real consumers are peers');
  // From a leaf, only its own branch of the fan comes back.
  const fromB = marksFor(ix, 'B', 'in');
  sameSet(edgeIdsOf(fromB, 'in'), ['e1', 'e2'], 'H5: B-left walks only its own branch of the fan');
  sameSet(idsOf(fromB, 'peer'), ['A'], 'H5: ...to the one real producer');
}

// --- H6: hovering a DOT lights both sides, whatever zone is asked for -------
{
  const nodes = [node('A'), dot('r1'), dot('r2'), node('B'), node('C')];
  const edges = [valE('e1', 'A', 'r1'), valE('e2', 'r1', 'r2'), valE('e3', 'r2', 'B'), valE('e4', 'r2', 'C')];
  const ix = buildHoverIndex(nodes, edges);
  for (const zone of ['self', 'in', 'out', 'both']) {
    const m = marksFor(ix, 'r2', zone);
    sameSet([...m.edges.keys()], ['e1', 'e2', 'e3', 'e4'],
      `H6: hovering a dot (asked for zone '${zone}') lights BOTH sides`);
    eq(m.nodes.get('r2'), 'self', `H6: the hovered dot is 'self' (zone '${zone}')`);
    eq(m.nodes.get('r1'), 'relay', `H6: the upstream dot is 'relay' (zone '${zone}')`);
    sameSet(idsOf(m, 'peer'), ['A', 'B', 'C'], `H6: every real endpoint is a peer (zone '${zone}')`);
  }
}

// --- H6b: a CYCLIC hand-made dot pair must terminate ------------------------
// `isValidConnection` cannot produce this; a hand-edited `.gcaproj` can, and an
// unguarded walk would spin forever. (The whole suite hangs if this regresses,
// which is the strongest signal available.)
{
  const nodes = [dot('r1'), dot('r2'), node('B')];
  const edges = [valE('e1', 'r1', 'r2'), valE('e2', 'r2', 'r1'), valE('e3', 'r2', 'B')];
  const ix = buildHoverIndex(nodes, edges);
  const m = marksFor(ix, 'B', 'in');
  ok(m !== null, 'H6b: a cyclic dot pair terminates instead of hanging');
  sameSet(idsOf(m, 'relay'), ['r1', 'r2'], 'H6b: both dots in the cycle are relays');
  eq(idsOf(m, 'peer').length, 0, 'H6b: a cycle of dots reaches no real producer');
  const d = marksFor(ix, 'r1', 'both');
  ok(d !== null, 'H6b: hovering a dot INSIDE the cycle terminates too');
  eq(d.nodes.get('r1'), 'self', 'H6b: ...and it is still `self`');
}

// --- H7: hovering a WIRE (I2) -----------------------------------------------
// The subject is the wire: there is NO `self` node, the whole reroute chain it
// belongs to lights in BOTH directions, both real ends are peers, and every
// segment carries the one `wire` token (`in` / `out` are relative to a hovered
// NODE and mean nothing here).
{
  // (a) the plain chain + value feed — no dots at all.
  const nodes = [node('A'), node('B'), node('C'), node('V'), comment('K')];
  const edges = [flowE('ab', 'A', 'B'), flowE('bc', 'B', 'C'), valE('vb', 'V', 'B')];
  const ix = buildHoverIndex(nodes, edges);

  const m = marksForEdge(ix, 'ab');
  sameSet([...m.edges.keys()], ['ab'], 'H7: a dot-free wire lights only itself');
  eq(m.edges.get('ab'), 'wire', 'H7: ...with the `wire` token');
  sameSet(idsOf(m, 'peer'), ['A', 'B'], 'H7: BOTH real endpoints are peers');
  eq(idsOf(m, 'self').length, 0, 'H7: a wire hover marks NO node `self` (the wire is the subject)');
  eq(idsOf(m, 'relay').length, 0, 'H7: no relay without a dot');
  eq(m.originId, 'ab', 'H7: originId names the hovered EDGE');
  // Each wire is its own answer — hovering the value feed reaches V and B only.
  sameSet(idsOf(marksForEdge(ix, 'vb'), 'peer'), ['V', 'B'],
    'H7: the value feed lights its own two ends, not the flow spine\'s');
  sameSet([...marksForEdge(ix, 'vb').edges.keys()], ['vb'], 'H7: ...and only its own segment');
  eq(marksForEdge(ix, 'nope'), null, 'H7: a wire id outside the scope produces no marks');

  // (b) a reroute CHAIN — A -> r1 -> r2 -> B. Hovering the MIDDLE segment must
  //     reach both real ends THROUGH both dots, which is the whole point of I2.
  const cn = [node('A'), dot('r1'), dot('r2'), node('B')];
  const ce = [valE('e1', 'A', 'r1'), valE('e2', 'r1', 'r2'), valE('e3', 'r2', 'B')];
  const cix = buildHoverIndex(cn, ce);
  for (const hovered of ['e1', 'e2', 'e3']) {
    const c = marksForEdge(cix, hovered);
    sameSet([...c.edges.keys()], ['e1', 'e2', 'e3'],
      `H7: hovering ${hovered} lights the WHOLE chain (both directions)`);
    sameSet(idsOf(c, 'peer'), ['A', 'B'], `H7: ...ending at both real endpoints (${hovered})`);
    sameSet(idsOf(c, 'relay'), ['r1', 'r2'], `H7: ...with both dots as relays (${hovered})`);
    ok([...c.edges.values()].every(t => t === 'wire'), `H7: every segment is \`wire\` (${hovered})`);
  }

  // (c) a reroute FAN-OUT — A -> r -> {B, C}. The direction matters: the shared
  //     trunk reaches every consumer; ONE branch reaches only its own consumer
  //     (a sibling branch is a different wire's answer).
  const fn = [node('A'), dot('r'), node('B'), node('C')];
  const fe = [valE('f1', 'A', 'r'), valE('f2', 'r', 'B'), valE('f3', 'r', 'C')];
  const fix = buildHoverIndex(fn, fe);
  const trunk = marksForEdge(fix, 'f1');
  sameSet([...trunk.edges.keys()], ['f1', 'f2', 'f3'], 'H7: the TRUNK of a fan lights every branch');
  sameSet(idsOf(trunk, 'peer'), ['A', 'B', 'C'], 'H7: ...and every real consumer');
  const branch = marksForEdge(fix, 'f2');
  sameSet([...branch.edges.keys()], ['f1', 'f2'], 'H7: ONE branch lights only its own path back to the trunk');
  sameSet(idsOf(branch, 'peer'), ['A', 'B'], 'H7: ...and only its own producer + consumer (not the sibling)');
  sameSet(idsOf(branch, 'relay'), ['r'], 'H7: ...through the dot');

  // (d) a cyclic hand-made dot pair must terminate here too.
  const yn = [dot('r1'), dot('r2'), node('B')];
  const ye = [valE('y1', 'r1', 'r2'), valE('y2', 'r2', 'r1'), valE('y3', 'r2', 'B')];
  const yix = buildHoverIndex(yn, ye);
  const cyc = marksForEdge(yix, 'y1');
  ok(cyc !== null, 'H7: a wire inside a cyclic dot pair terminates instead of hanging');
  sameSet(idsOf(cyc, 'relay'), ['r1', 'r2'], 'H7: ...both dots are relays');
  sameSet(idsOf(cyc, 'peer'), ['B'], 'H7: ...and the one real node downstream is the peer');
}

// --- H8: hovering a PORT (I1) -----------------------------------------------
// Over ONE handle, only THAT handle's wires (through their chains) and their
// real endpoint(s) light — a strict narrowing of the third, with the node still
// `self`. The direction comes off the handle id's prefix, never from geometry.
{
  //  V0 -> B.p0,  V1 -> B.p1  (two value inputs), B -> {C, D} on two outputs.
  const nodes = [node('V0'), node('V1'), node('A'), node('B'), node('C'), node('D')];
  const edges = [
    flowE('ab', 'A', 'B'),
    valE('v0', 'V0', 'B', 0),
    valE('v1', 'V1', 'B', 1),
    { id: 'bc', source: 'B', target: 'C', sourceHandle: 'output_value_out0', targetHandle: 'input_value_p0' },
    { id: 'bd', source: 'B', target: 'D', sourceHandle: 'output_value_out1', targetHandle: 'input_value_p0' },
  ];
  const ix = buildHoverIndex(nodes, edges);

  eq(handleDirection('input_value_p0'), 'in', 'H8: an `input_` handle is the IN side');
  eq(handleDirection('output_flow_next'), 'out', 'H8: an `output_` handle is the OUT side');
  eq(handleDirection('weird'), null, 'H8: an unparseable handle id has no direction');
  eq(hoverHandleKey('n1', 'input_value_p0'), 'n1|input_value_p0', 'H8: the byHandle key is nodeId|handleId');

  // ONE input handle: its own wire and its own producer, nothing else.
  const p0 = marksForPort(ix, 'B', 'input_value_p0');
  sameSet([...p0.edges.keys()], ['v0'], 'H8: an input handle lights exactly ITS wire');
  eq(p0.edges.get('v0'), 'in', 'H8: ...with the `in` token');
  sameSet(idsOf(p0, 'self'), ['B'], 'H8: the port\'s own node is still `self`');
  sameSet(idsOf(p0, 'peer'), ['V0'], 'H8: ...and only that port\'s producer is a peer');
  eq(p0.originId, 'B', 'H8: originId names the NODE, not the handle');

  const p1 = marksForPort(ix, 'B', 'input_value_p1');
  sameSet(idsOf(p1, 'peer'), ['V1'], 'H8: the OTHER input handle reaches the other producer');
  sameSet([...p1.edges.keys()], ['v1'], 'H8: ...and only its own wire');

  // The flow pin is a handle like any other.
  const pf = marksForPort(ix, 'B', 'input_flow_do');
  sameSet([...pf.edges.keys()], ['ab'], 'H8: the main FLOW input pin lights the exec wire');
  sameSet(idsOf(pf, 'peer'), ['A'], 'H8: ...and its producer');

  // ONE output handle out of two.
  const o0 = marksForPort(ix, 'B', 'output_value_out0');
  sameSet([...o0.edges.keys()], ['bc'], 'H8: an output handle lights exactly ITS wire');
  eq(o0.edges.get('bc'), 'out', 'H8: ...with the `out` token');
  sameSet(idsOf(o0, 'peer'), ['C'], 'H8: ...and only that port\'s consumer');

  // AN UNWIRED PORT IS SELF ONLY — honest, and it is how the user learns.
  const un = marksForPort(ix, 'B', 'input_value_p7');
  sameSet([...un.nodes.keys()], ['B'], 'H8: an UNWIRED handle lights the node only');
  eq(un.edges.size, 0, 'H8: ...and no wire');
  const bad = marksForPort(ix, 'B', 'not_a_handle');
  sameSet([...bad.nodes.keys()], ['B'], 'H8: an unparseable handle id lights the node only');
  eq(bad.edges.size, 0, 'H8: ...and never guesses a direction');

  // THE NARROWING CLAIM, stated as algebra: every port set is a SUBSET of its
  // third, and the union over a side's handles IS that third.
  const left = marksFor(ix, 'B', 'in');
  const right = marksFor(ix, 'B', 'out');
  const unionIn = new Set([...p0.edges.keys(), ...p1.edges.keys(), ...pf.edges.keys()]);
  sameSet(unionIn, [...left.edges.keys()], 'H8: the union over B\'s INPUT handles == its left third');
  const o1 = marksForPort(ix, 'B', 'output_value_out1');
  const unionOut = new Set([...o0.edges.keys(), ...o1.edges.keys()]);
  sameSet(unionOut, [...right.edges.keys()], 'H8: the union over B\'s OUTPUT handles == its right third');
  ok([...p0.edges.keys()].every(id => left.edges.has(id)), 'H8: a port set is a SUBSET of its third');
  ok(p0.edges.size < left.edges.size, 'H8: ...and a strictly SMALLER one when the port count > 1');

  // Groups / comments are skipped by type here too.
  const gix = buildHoverIndex([group('G'), comment('K'), node('B')], []);
  eq(marksForPort(gix, 'G', 'input_value_p0'), null, 'H8: a GROUP handle produces no marks');
  eq(marksForPort(gix, 'nope', 'input_value_p0'), null, 'H8: an id outside the scope produces no marks');

  // A handle THROUGH a reroute chain still ends at the real producer.
  const cn = [node('A'), dot('r1'), dot('r2'), node('B')];
  const ce = [valE('e1', 'A', 'r1'), valE('e2', 'r1', 'r2'), valE('e3', 'r2', 'B', 3)];
  const cix = buildHoverIndex(cn, ce);
  const via = marksForPort(cix, 'B', 'input_value_p3');
  sameSet([...via.edges.keys()], ['e1', 'e2', 'e3'], 'H8: a port fed through a chain lights every segment');
  sameSet(idsOf(via, 'peer'), ['A'], 'H8: ...and the REAL producer at the far end');
  sameSet(idsOf(via, 'relay'), ['r1', 'r2'], 'H8: ...with both dots as relays');

  // ⚠ A HANDLE ON A DOT IS THE DOT. The two handles COVER the 16 px dot, so
  // making them directional would make P1's verified "a dot lights both sides"
  // unreachable with a real mouse.
  for (const hid of ['input_value_in', 'output_value_out']) {
    const d = marksForPort(cix, 'r1', hid);
    sameSet([...d.edges.keys()], ['e1', 'e2', 'e3'], `H8: a handle on a DOT lights both sides (${hid})`);
    eq(d.nodes.get('r1'), 'self', `H8: ...and the dot is still \`self\` (${hid})`);
    sameSet(idsOf(d, 'peer'), ['A', 'B'], `H8: ...reaching both real ends (${hid})`);
    const asNode = marksFor(cix, 'r1', 'both');
    sameSet([...d.edges.keys()], [...asNode.edges.keys()],
      `H8: a dot's handle set is IDENTICAL to the dot's own (${hid}) — P1 behaviour preserved`);
  }
}

// --- H9: the hysteresis ladder ----------------------------------------------
{
  eq(HOVER_ENTER_LEFT, 0.30, 'H9: the LEFT enter threshold is 0.30');
  eq(HOVER_LEAVE_LEFT, 0.36, 'H9: the LEFT leave threshold is 0.36');
  eq(HOVER_ENTER_RIGHT, 0.70, 'H9: the RIGHT enter threshold is 0.70');
  eq(HOVER_LEAVE_RIGHT, 0.64, 'H9: the RIGHT leave threshold is 0.64');
  eq(HOVER_DWELL_MS, 90, 'H9: the dwell is one 90 ms constant');

  // Entering from nowhere.
  eq(zoneForRatio(0.29, null), 'in', 'H9: 0.29 enters LEFT');
  eq(zoneForRatio(0.31, null), 'self', 'H9: 0.31 from nowhere is the MIDDLE (no hysteresis to inherit)');
  eq(zoneForRatio(0.71, null), 'out', 'H9: 0.71 enters RIGHT');
  eq(zoneForRatio(0.69, null), 'self', 'H9: 0.69 from nowhere is the MIDDLE');
  eq(zoneForRatio(0.5, null), 'self', 'H9: the centre is the MIDDLE');

  // The ladder the plan names: once LEFT, 0.31/0.34/0.35 stay; 0.37 leaves.
  let z = zoneForRatio(0.29, null);
  for (const r of [0.31, 0.34, 0.35, 0.36]) {
    z = zoneForRatio(r, z);
    eq(z, 'in', `H9: ${r} STAYS left after entering at 0.29 (hysteresis)`);
  }
  z = zoneForRatio(0.37, z);
  eq(z, 'self', 'H9: 0.37 finally leaves LEFT');

  // Mirrored on the right.
  z = zoneForRatio(0.71, null);
  for (const r of [0.69, 0.66, 0.65, 0.64]) {
    z = zoneForRatio(r, z);
    eq(z, 'out', `H9: ${r} STAYS right after entering at 0.71 (hysteresis)`);
  }
  z = zoneForRatio(0.63, z);
  eq(z, 'self', 'H9: 0.63 finally leaves RIGHT');

  // Hysteresis must not smear ACROSS the node: leaving left at 0.8 lands right.
  eq(zoneForRatio(0.8, 'in'), 'out', 'H9: a jump from the left third to past 0.70 lands RIGHT');
  eq(zoneForRatio(0.2, 'out'), 'in', 'H9: ...and the mirror');
  // A dot\'s fixed zone re-enters the plain thresholds.
  eq(zoneForRatio(0.5, 'both'), 'self', 'H9: `both` inherits no hysteresis');
  // Out-of-range ratios are clamped, never NaN-propagated.
  eq(zoneForRatio(-3, null), 'in', 'H9: a ratio below 0 clamps LEFT');
  eq(zoneForRatio(9, null), 'out', 'H9: a ratio above 1 clamps RIGHT');
}

// --- H11: the colour lift, pinned -------------------------------------------
// ⚠ These are the numbers the LIVE prototype's finding turned into code: the raw
// `def.color` fills are too dark to read as a glow, so the ring is a LIGHTNESS
// LIFT of them (hue + saturation kept). A fill already at/above the target is
// returned unchanged, which is what keeps the white event roots white.
{
  eq(HOVER_GLOW_L, 0.62, 'H11: the node glow target lightness is 0.62');
  eq(HOVER_WIRE_GLOW_L, 0.72, 'H11: a WIRE is lifted further (0.72) — a stroke on the canvas');

  eq(hoverGlowColor('#1b5e20'), '#68d470', 'H11: conditional #1b5e20 -> a readable mint');
  eq(hoverGlowColor('#b71c1c'), '#e55757', 'H11: getCellAttribute #b71c1c -> a salmon');
  eq(hoverGlowColor('#4a148c'), '#9755e7', 'H11: setAttribute #4a148c -> a lavender');
  eq(hoverGlowColor('#5e35b1'), '#8c6ad2', 'H11: macro instance #5e35b1');
  eq(hoverGlowColor('#b8860b'), '#f4c248', 'H11: expression #b8860b');
  eq(hoverGlowColor('#e65100'), '#ff813d', 'H11: aggregation #e65100');
  eq(hoverGlowColor('#ffffff'), '#ffffff', 'H11: a white event root stays WHITE (already above target)');
  eq(hoverGlowColor('#b0b8c0'), '#b0b8c0', 'H11: a light fill stays as it is');
  eq(hoverGlowColor('#abc'), '#aabbcc', 'H11: 3-digit input is tolerated and expanded');
  eq(hoverGlowColor('1b5e20'), '#68d470', 'H11: a missing # is tolerated');
  eq(hoverGlowColor('#1B5E20'), '#68d470', 'H11: UPPER-case input gives the same answer as lower');
  eq(hoverGlowColor('#000000'), '#9e9e9e', 'H11: pure black lifts up the grey axis (no hue to keep)');
  eq(hoverGlowColor('oops'), '#b0b8c0', 'H11: an unparseable colour falls back, never throws');
  eq(hoverGlowColor(''), '#b0b8c0', 'H11: ...and so does an empty one');

  // The hue really is preserved: the lift must not desaturate towards white
  // (that was the rejected `color-mix(c 55%, white)` alternative).
  const lift = hoverGlowColor('#1b5e20');
  const [lr, lg, lb] = [1, 3, 5].map(i => parseInt(lift.slice(i, i + 2), 16));
  ok(lg > lr + 60 && lg > lb + 60, `H11: the lifted green is still GREEN-dominant (${lift})`);
  ok((Math.max(lr, lg, lb) + Math.min(lr, lg, lb)) / 2 / 255 > 0.60,
    `H11: ...and it really reached the target lightness (${lift})`);

  // The wire colours, and the soft halo written as the second property.
  eq(hoverGlowColor(EDGE_FLOW_COLOR, HOVER_WIRE_GLOW_L), '#9cd39f', 'H11: a FLOW wire glows a light green');
  eq(hoverGlowColor(EDGE_VALUE_COLOR, HOVER_WIRE_GLOW_L), '#7bd7f4', 'H11: a VALUE wire glows a light cyan');
  eq(hoverSoftColor('#68d470'), 'rgba(104, 212, 112, 0.5)', 'H11: --hover-c-soft is an rgba() of the lifted hue');
  eq(hoverSoftColor('#68d470', 0.25), 'rgba(104, 212, 112, 0.25)', 'H11: ...with the alpha it is asked for');
  eq(hoverSoftColor('nope'), 'rgba(176, 184, 192, 0.5)', 'H11: the soft halo falls back too');
}

// ---------------------------------------------------------------------------
// SECTION B — the source mirrors
// ---------------------------------------------------------------------------
section('B — source mirrors (wire colours, CSS ordering, attribute-not-class)');

const editorSrc = readFileSync(SRC('modeler/vpl/GraphEditor.tsx'), 'utf8');
const editorCss = readFileSync(SRC('modeler/vpl/GraphEditor.module.css'), 'utf8');
const hoverSrc = readFileSync(SRC('modeler/vpl/hoverHighlight.ts'), 'utf8');

// B1 — the two wire colours are `toRFEdges`' OWN inline literals. A hovered wire
// glows in its own category colour (decision D1), so this module has to know
// what that colour is — and a drift here would silently glow the wrong hue.
{
  const m = /sourceHandle\.includes\('flow'\)\s*\?\s*'(#[0-9a-fA-F]{6})'\s*:\s*'(#[0-9a-fA-F]{6})'/.exec(editorSrc);
  ok(!!m, 'B1: `toRFEdges`\'s inline stroke literals are still findable in GraphEditor.tsx');
  if (m) {
    eq(EDGE_FLOW_COLOR, m[1], 'B1: EDGE_FLOW_COLOR mirrors the FLOW stroke toRFEdges paints');
    eq(EDGE_VALUE_COLOR, m[2], 'B1: EDGE_VALUE_COLOR mirrors the VALUE stroke toRFEdges paints');
  }
}

// B2 — the CSS ordering IS the hover-over-trace precedence. Same specificity, so
// whichever block is declared LAST wins on a wire that is both trace-lit and
// hovered; the plan wants the hover to win while the cursor is on it.
{
  const iTrace = editorCss.indexOf('RULE TRACE (P4)');
  // Anchored on the prefix, not the phase list: the block's heading gains a
  // phase every time the feature grows ("(P1)" → "(P1 + P2)").
  const iHover = editorCss.indexOf('HOVER HIGHLIGHT (P1');
  ok(iTrace >= 0, 'B2: the RULE TRACE css block is still there');
  ok(iHover >= 0, 'B2: the HOVER HIGHLIGHT css block exists');
  ok(iHover > iTrace, 'B2: the HOVER block is declared AFTER the TRACE block (the precedence)');
  const iTraceWire = editorCss.indexOf('[data-trace~="value"] .react-flow__edge-path');
  const iHoverWire = editorCss.indexOf('[data-hover] .react-flow__edge-path');
  ok(iHoverWire > iTraceWire && iTraceWire > 0,
    'B2: the hovered-wire RULE specifically comes after the trace-lit-wire rule');
}

// B3 — the marks are an ATTRIBUTE + two custom properties, never a class, and
// the ring is on the INNER element so it composes with the selection ring and
// the trace halo without combination rules.
{
  ok(/\[data-hover~="self"\] > \*/.test(editorCss), 'B3: the self ring targets the INNER element (`> *`)');
  ok(/\[data-hover~="peer"\] > \*/.test(editorCss), 'B3: ...and so does the peer ring');
  ok(/\[data-hover~="relay"\] > \*/.test(editorCss), 'B3: ...and the relay ring');
  // A wrapper rule would read `:global(.react-flow__node[data-hover~="x"]) {` —
  // i.e. no child combinator before the closing paren. `[^){>]*` is what makes
  // this a real test rather than a tautology.
  ok(!/\.react-flow__node\[data-hover[^){>]*\)\s*\{/.test(editorCss),
    'B3: no hover box-shadow is put on the WRAPPER itself (it would need 2³ combination rules)');
  ok(/stroke: var\(--hover-c\) !important/.test(editorCss),
    'B3: the wire stroke uses !important (toRFEdges puts the colour in an INLINE style)');
  ok(/\.react-flow__edge:not\(\.selected\)\[data-hover\]/.test(editorCss),
    'B3: a SELECTED wire stays red (`:not(.selected)`)');
  // The glow SNAPS in (user feedback 2026-09-14): no transition on any hover rule.
  // Isolate the HOVER HIGHLIGHT block so the editor's other transitions (the
  // toggle buttons, the scope notice) cannot mask a regression here.
  {
    const hoverBlock = editorCss.slice(editorCss.indexOf('HOVER HIGHLIGHT'));
    ok(hoverBlock.length > 0 && !/transition\s*:/.test(hoverBlock),
      'B3: the hover rules carry NO transition — the ring and halo appear at full strength at once');
  }
  ok(editorSrc.includes("setAttribute('data-hover'"), 'B3: the editor writes the data-hover ATTRIBUTE');
  ok(editorSrc.includes("removeAttribute('data-hover')"), 'B3: ...and removes it on clear');
  ok(editorSrc.includes("setProperty('--hover-c'"), 'B3: the per-element colour is an inline custom property');
  ok(editorSrc.includes("setProperty('--hover-c-soft'"), 'B3: ...and so is the translucent halo');
  ok(!/classList\.(add|remove)\(['"][^'"]*hover/.test(editorSrc),
    'B3: the hover NEVER touches classList (React Flow rebuilds className)');
}

// B5 — THE HANDLE-ID ENCODING the port walk reads. `handleDirection` decides
// which side a handle is on from its PREFIX alone; that is only legitimate
// because `handleId()` builds every handle id as `<kind>_<category>_<portId>`.
// A rename there would silently make every port hover directionless.
{
  const typesSrc = readFileSync(SRC('modeler/vpl/types.ts'), 'utf8');
  ok(/return `\$\{port\.kind\}_\$\{port\.category\}_\$\{port\.id\}`;/.test(typesSrc),
    'B5: `handleId()` still encodes <kind>_<category>_<portId>');
  ok(/\^\(input\|output\)_\(value\|flow\)_/.test(typesSrc),
    'B5: ...and `parseHandleId` still agrees on the two kind literals');
  // The real ids the editor renders, run through the module.
  eq(handleDirection('input_flow_do'), 'in', 'B5: a real main-flow INPUT id resolves IN');
  eq(handleDirection('output_flow_next'), 'out', 'B5: a real main-flow OUTPUT id resolves OUT');
  eq(handleDirection('input_value_in'), 'in', 'B5: a real REROUTE input id resolves IN');
  eq(handleDirection('output_value_out'), 'out', 'B5: ...and its output id resolves OUT');
}

// B6 — THE PORT CHANNEL (I1) is wired end to end: published by EVERY handle the
// editor renders, subscribed ONCE, and never put in React state.
{
  const stateSrc = readFileSync(SRC('modeler/vpl/graphState.ts'), 'utf8');
  const caSrc = readFileSync(SRC('modeler/vpl/CaNode.tsx'), 'utf8');
  const rerouteSrc = readFileSync(SRC('modeler/vpl/RerouteNodeComponent.tsx'), 'utf8');

  ok(/export function setHoveredPort/.test(stateSrc), 'B6: graphState owns the setHoveredPort channel');
  ok(/export function subscribeHoveredPort/.test(stateSrc), 'B6: ...with the connectingFrom subscribe pattern');
  ok(/hoveredPortListeners\.forEach/.test(stateSrc), 'B6: ...and the setter notifies its listeners');
  ok(/data-nodeid/.test(stateSrc) && /data-handleid/.test(stateSrc),
    'B6: the publishers read the ids off React Flow\'s own handle dataset');

  // EVERY handle publishes. CaNode renders four (collapsed strip, the header's
  // main flow pin, the two body port maps); the reroute dot renders two.
  const caHandles = (caSrc.match(/<Handle\b/g) ?? []).length;
  const caEnter = (caSrc.match(/onMouseEnter=\{onHandleHoverEnter\}/g) ?? []).length;
  const caLeave = (caSrc.match(/onMouseLeave=\{onHandleHoverLeave\}/g) ?? []).length;
  eq(caEnter, caHandles, `B6: every one of CaNode's ${caHandles} <Handle> sites publishes on enter`);
  eq(caLeave, caHandles, 'B6: ...and clears on leave');
  const rHandles = (rerouteSrc.match(/<Handle\b/g) ?? []).length;
  eq((rerouteSrc.match(/onMouseEnter=\{onHandleHoverEnter\}/g) ?? []).length, rHandles,
    `B6: both of the reroute dot's ${rHandles} handles publish too`);

  // ⚠ CaNode PUBLISHES AND NEVER SUBSCRIBES — a memoised node must not
  // re-render because the cursor crossed a handle.
  ok(!/subscribeHoveredPort/.test(caSrc), 'B6: CaNode never SUBSCRIBES to the port channel');
  ok(!/subscribeHoveredPort/.test(rerouteSrc), 'B6: ...and neither does the reroute dot');
  ok(!/hoveredPort/.test(caSrc.replace(/onHandleHover(Enter|Leave)/g, '')),
    'B6: CaNode does not read the channel at all (it only hands over the two publishers)');
  const subs = (editorSrc.match(/subscribeHoveredPort/g) ?? []).length;
  eq(subs, 2, 'B6: exactly ONE subscriber — the editor (the import + the one effect)');
  ok(/setHoveredPort\(null\)/.test(editorSrc),
    'B6: the editor drops the module-global channel on unmount / scope change');
}

// B7 — the WIRE seams (I2) are composed with the trace's, exactly as the node
// seams are, and the link-splice press stands the hover down.
{
  ok(/onEdgeMouseEnter=\{onEdgeMouseEnterCombined\}/.test(editorSrc),
    'B7: onEdgeMouseEnter is ONE composed callback (trace tooltip + hover)');
  ok(/onEdgeMouseLeave=\{onEdgeMouseLeaveCombined\}/.test(editorSrc),
    'B7: ...and so is onEdgeMouseLeave');
  ok(/onEdgeMouseMove=\{onHoverEdgeMove\}/.test(editorSrc),
    'B7: the wire re-arm uses React Flow\'s onEdgeMouseMove seam');
  ok(/onTraceEdgeEnter\(event, edge\)/.test(editorSrc),
    'B7: the trace tooltip is still called from the composed edge enter');
  // The press-and-hold link splice must clear the mark: the press selects the
  // wire (red outranks the hover) or opens a menu over it, and `mouseleave` may
  // never fire. The clear sits inside the gesture's own `onDown`.
  const iDown = editorSrc.indexOf("const edgeEl = target.closest('.react-flow__edge')");
  ok(iDown > 0, 'B7: the link-splice pointerdown handler is still findable');
  ok(iDown > 0 && /clearHoverRef\.current\(\)/.test(editorSrc.slice(iDown, iDown + 900)),
    'B7: ...and it stands the hover down on the press');
}

// B4 — the editor consumes the module rather than re-deriving it, and the pure
// module stays DOM-free (the harness bundles it standalone).
{
  ok(/from '\.\/hoverHighlight'/.test(editorSrc), 'B4: GraphEditor imports the pure module');
  ok(/kind: 'port', nodeId:/.test(editorSrc), 'B4: the editor asks for a PORT target (I1)');
  ok(/kind: 'edge', id:/.test(editorSrc), 'B4: ...and for an EDGE target (I2)');
  for (const sym of ['buildHoverIndex', 'computeHoverMarks', 'zoneForRatio', 'hoverGlowColor',
    'hoverSoftColor', 'HOVER_DWELL_MS']) {
    ok(editorSrc.includes(sym), `B4: the editor uses ${sym} instead of re-implementing it`);
  }
  for (const forbidden of ['document.', 'window.', 'getBoundingClientRect', "from 'react'", 'useRef']) {
    ok(!hoverSrc.includes(forbidden), `B4: hoverHighlight.ts is DOM-free (no ${forbidden})`);
  }
  // The stand-down list is wired, not just documented.
  ok(/isConnectingGlobal/.test(editorSrc), 'B4: the wire-drag stand-down signal is read');
  ok(/onSelectionStart=/.test(editorSrc), 'B4: box-select stands the hover down');
  ok(/onNodeMouseMove=/.test(editorSrc), 'B4: the thirds are driven by React Flow\'s onNodeMouseMove seam');
  ok((editorSrc.match(/clearHoverRef\.current\(\)/g) ?? []).length >= 4,
    'B4: every stand-down routes through the one clear (drag / connect / menu / scope)');
}

// ---------------------------------------------------------------------------
// SECTION C — H12, the library sweep against an INDEPENDENT reference walk
// ---------------------------------------------------------------------------
section('C — library sweep (every shipped .gcaproj, every scope, every node, 3 zones)');

const MODELS_DIR = join(ROOT, 'public', 'models');
const modelFiles = readdirSync(MODELS_DIR).filter(f => f.endsWith('.gcaproj')).sort();

const isDot = (n) => n.type === 'rerouteNode' || n.data?.nodeType === 'reroute';
const isLive = (n) => isDot(n) || (n.type !== 'groupNode' && n.type !== 'commentNode' && typeof n.data?.nodeType === 'string' && !!n.data.nodeType);

/**
 * THE ORACLE — deliberately a DIFFERENT traversal from the module's: rounds of a
 * full edge SCAN over a frontier set, with no adjacency maps at all. Two
 * implementations that share a walk would agree on each other's bugs.
 */
function refClosure(nodes, edges, id, dir) {
  const dots = new Set(nodes.filter(isDot).map(n => n.id));
  const markedEdges = new Set();
  const peers = new Set();
  const relays = new Set();
  let frontier = new Set([id]);
  const visited = new Set([id]);
  while (frontier.size > 0) {
    const next = new Set();
    for (const e of edges) {
      const near = dir === 'in' ? e.target : e.source;
      const far = dir === 'in' ? e.source : e.target;
      if (!frontier.has(near)) continue;
      markedEdges.add(e.id);
      if (dots.has(far)) {
        relays.add(far);
        if (!visited.has(far)) { visited.add(far); next.add(far); }
      } else {
        peers.add(far);
      }
    }
    frontier = next;
  }
  return { markedEdges, peers, relays };
}

/**
 * THE SEEDED ORACLE — the same rounds-of-a-full-edge-scan traversal, but started
 * from a SET OF WIRES instead of a node. It is what makes a port probe (I1) and
 * a wire probe (I2) checkable against something that is not the module: neither
 * of those subjects is a node, so `refClosure` cannot express them.
 */
function refFromWires(nodes, edges, seedIds, dir) {
  const dots = new Set(nodes.filter(isDot).map(n => n.id));
  const markedEdges = new Set(seedIds);
  const peers = new Set();
  const relays = new Set();
  let frontier = new Set();
  for (const e of edges) if (seedIds.has(e.id)) frontier.add(dir === 'in' ? e.source : e.target);
  const expanded = new Set();
  while (frontier.size > 0) {
    const next = new Set();
    for (const id of frontier) {
      if (!dots.has(id)) { peers.add(id); continue; }
      relays.add(id);
      if (expanded.has(id)) continue;
      expanded.add(id);
      for (const e of edges) {
        if ((dir === 'in' ? e.target : e.source) !== id) continue;
        markedEdges.add(e.id);
        next.add(dir === 'in' ? e.source : e.target);
      }
    }
    frontier = next;
  }
  return { markedEdges, peers, relays };
}

const sameIds = (a, b) => a.size === b.size && [...a].every(v => b.has(v));
const unionOf = (...sets) => { const o = new Set(); for (const s of sets) for (const v of s) o.add(v); return o; };

let scopeCount = 0, nodeChecks = 0, dotScopes = 0, portChecks = 0, edgeChecks = 0;
let worstMs = 0, worstScope = '';
for (const f of modelFiles) {
  const model = JSON.parse(readFileSync(join(MODELS_DIR, f), 'utf8'));
  const scopes = [
    ['cells', model.graphNodes ?? [], model.graphEdges ?? []],
    ['agents', model.agentGraphNodes ?? [], model.agentGraphEdges ?? []],
    ['overseer', model.overseerGraphNodes ?? [], model.overseerGraphEdges ?? []],
    ...(model.macroDefs ?? []).map(d => [`macro:${d.name}`, d.nodes ?? [], d.edges ?? []]),
  ];
  for (const [tag, gnodes, gedges] of scopes) {
    if (gnodes.length === 0) continue;
    const label = `${f}/${tag}`;
    scopeCount++;
    const scopeIds = new Set(gnodes.map(n => n.id));
    const edgeIdsInScope = new Set(gedges.map(e => e.id));
    if (gnodes.some(isDot)) dotScopes++;
    const t0 = Date.now();
    const ix = buildHoverIndex(gnodes, gedges);
    // The index itself must agree with the file about what is in the scope.
    if (ix.kindOf.size !== gnodes.length) {
      failures.push(`H12 ${label}: the index lost nodes (${ix.kindOf.size} of ${gnodes.length})`);
    } else passed++;

    for (const n of gnodes) {
      if (!isLive(n)) {
        if (computeHoverMarks(ix, { kind: 'node', id: n.id, zone: 'both' }) !== null) {
          failures.push(`H12 ${label}/${n.id}: a group/comment produced marks`);
        } else passed++;
        continue;
      }
      const dotHere = isDot(n);
      const refIn = refClosure(gnodes, gedges, n.id, 'in');
      const refOut = refClosure(gnodes, gedges, n.id, 'out');

      for (const zone of ['in', 'out', 'both', 'self']) {
        const m = computeHoverMarks(ix, { kind: 'node', id: n.id, zone });
        nodeChecks++;
        if (!m) { failures.push(`H12 ${label}/${n.id}/${zone}: no marks for a live node`); continue; }

        // (a) NOTHING outside the scope is ever marked.
        let strayN = 0, strayE = 0;
        for (const id of m.nodes.keys()) if (!scopeIds.has(id)) strayN++;
        for (const id of m.edges.keys()) if (!edgeIdsInScope.has(id)) strayE++;
        if (strayN || strayE) {
          failures.push(`H12 ${label}/${n.id}/${zone}: ${strayN} node + ${strayE} edge ids outside the scope`);
          continue;
        }
        passed++;

        // (b) EVERY marked edge touches marked nodes at BOTH ends — the set is a
        //     connected neighbourhood, never a floating wire.
        let dangling = 0;
        for (const eid of m.edges.keys()) {
          const e = gedges.find(x => x.id === eid);
          if (!e || !m.nodes.has(e.source) || !m.nodes.has(e.target)) dangling++;
        }
        if (dangling) {
          failures.push(`H12 ${label}/${n.id}/${zone}: ${dangling} marked edge(s) with an unmarked endpoint`);
          continue;
        }
        passed++;

        // (c) the hovered node is always, and only, `self`
        if (m.nodes.get(n.id) !== 'self' || idsOf(m, 'self').length !== 1) {
          failures.push(`H12 ${label}/${n.id}/${zone}: the hovered node is not the single 'self'`);
          continue;
        }
        passed++;

        // (d) against the ORACLE. A dot ignores the zone and lights both sides.
        const effective = dotHere ? 'both' : zone;
        const wantEdges = new Set();
        const wantPeers = new Set();
        const wantRelays = new Set();
        for (const [side, ref] of [['in', refIn], ['out', refOut]]) {
          if (effective !== side && effective !== 'both') continue;
          for (const v of ref.markedEdges) wantEdges.add(v);
          for (const v of ref.peers) wantPeers.add(v);
          for (const v of ref.relays) wantRelays.add(v);
        }
        wantPeers.delete(n.id); wantRelays.delete(n.id);
        const gotEdges = new Set(m.edges.keys());
        const gotPeers = new Set(idsOf(m, 'peer'));
        const gotRelays = new Set(idsOf(m, 'relay'));
        const same = (a, b) => a.size === b.size && [...a].every(v => b.has(v));
        if (!same(gotEdges, wantEdges)) {
          failures.push(`H12 ${label}/${n.id}/${zone}: edge set != oracle (${gotEdges.size} vs ${wantEdges.size})`);
          continue;
        }
        passed++;
        if (!same(gotPeers, wantPeers)) {
          failures.push(`H12 ${label}/${n.id}/${zone}: peer set != oracle (${gotPeers.size} vs ${wantPeers.size})`);
          continue;
        }
        passed++;
        if (!same(gotRelays, wantRelays)) {
          failures.push(`H12 ${label}/${n.id}/${zone}: relay set != oracle (${gotRelays.size} vs ${wantRelays.size})`);
          continue;
        }
        passed++;

        // (e) THE DEGREE CLAIM. Through reroutes, |in| + |out| must account for
        //     every wire the node really touches: the marked segments on each
        //     side start with exactly the node's own incident wires.
        if (effective === 'both') {
          const ownIn = gedges.filter(e => e.target === n.id).map(e => e.id);
          const ownOut = gedges.filter(e => e.source === n.id).map(e => e.id);
          const missing = [...ownIn, ...ownOut].filter(id => !gotEdges.has(id));
          if (missing.length) {
            failures.push(`H12 ${label}/${n.id}: ${missing.length} incident wire(s) unmarked at full degree`);
            continue;
          }
          passed++;
          // With no dot adjacent, the closure IS the degree — an exact count.
          const dots = new Set(gnodes.filter(isDot).map(x => x.id));
          const adjacentDot = [...ownIn].some(id => dots.has(gedges.find(e => e.id === id).source))
            || [...ownOut].some(id => dots.has(gedges.find(e => e.id === id).target));
          if (!adjacentDot) {
            if (gotEdges.size !== ownIn.length + ownOut.length) {
              failures.push(`H12 ${label}/${n.id}: reroute-free degree ${gotEdges.size} != ${ownIn.length + ownOut.length}`);
              continue;
            }
            passed++;
          }
        }

        // (f) in ∪ out == both, and the two edge sets are disjoint.
        if (zone === 'both' && !dotHere) {
          const a = new Set(computeHoverMarks(ix, { kind: 'node', id: n.id, zone: 'in' }).edges.keys());
          const b = new Set(computeHoverMarks(ix, { kind: 'node', id: n.id, zone: 'out' }).edges.keys());
          const union = new Set([...a, ...b]);
          if (!same(union, gotEdges)) {
            failures.push(`H12 ${label}/${n.id}: in ∪ out != both`);
            continue;
          }
          passed++;
          if ([...a].some(v => b.has(v))) {
            failures.push(`H12 ${label}/${n.id}: the in and out closures overlap`);
            continue;
          }
          passed++;
        }

        // (g) the middle third lights the node and nothing else
        if (zone === 'self' && !dotHere) {
          if (m.edges.size !== 0 || m.nodes.size !== 1) {
            failures.push(`H12 ${label}/${n.id}: the middle third lit ${m.nodes.size} nodes / ${m.edges.size} wires`);
            continue;
          }
          passed++;
        }
      }

      // --- H8 ON THE LIBRARY: every WIRED HANDLE of this node --------------
      // The narrowing claim, on real graphs: each port's set agrees with the
      // SEEDED oracle, is a SUBSET of its third, and the UNION over a side's
      // handles IS that third (so the thirds really are the coarse default and
      // nothing falls between two handles).
      if (!dotHere) {
        const byHandleHere = { in: new Map(), out: new Map() };
        for (const e of gedges) {
          if (e.target === n.id && e.targetHandle) {
            const s = byHandleHere.in.get(e.targetHandle) ?? new Set();
            s.add(e.id); byHandleHere.in.set(e.targetHandle, s);
          }
          if (e.source === n.id && e.sourceHandle) {
            const s = byHandleHere.out.get(e.sourceHandle) ?? new Set();
            s.add(e.id); byHandleHere.out.set(e.sourceHandle, s);
          }
        }
        for (const [side, ref] of [['in', refIn], ['out', refOut]]) {
          const handles = byHandleHere[side];
          const incident = gedges
            .filter(e => (side === 'in' ? e.target : e.source) === n.id).map(e => e.id);
          const handled = unionOf(...handles.values());
          // Every incident wire belongs to SOME handle: an edge with no handle
          // id would sit inside the third but inside no port set.
          if (handled.size !== incident.length) {
            failures.push(`H8 ${label}/${n.id}/${side}: ${incident.length - handled.size} incident wire(s) carry no handle id`);
          } else passed++;

          const union = new Set();
          let sideOk = true;
          for (const [hid, seeds] of handles) {
            portChecks++;
            const pm = computeHoverMarks(ix, { kind: 'port', nodeId: n.id, handleId: hid });
            if (!pm) { failures.push(`H8 ${label}/${n.id}/${hid}: no marks for a wired handle`); sideOk = false; continue; }
            if (handleDirection(hid) !== side) {
              failures.push(`H8 ${label}/${n.id}/${hid}: the id prefix says ${handleDirection(hid)}, the wiring says ${side}`);
              sideOk = false; continue;
            }
            if (pm.nodes.get(n.id) !== 'self' || idsOf(pm, 'self').length !== 1) {
              failures.push(`H8 ${label}/${n.id}/${hid}: the port's own node is not the single 'self'`);
              sideOk = false; continue;
            }
            let stray = 0;
            for (const id of pm.nodes.keys()) if (!scopeIds.has(id)) stray++;
            for (const id of pm.edges.keys()) if (!edgeIdsInScope.has(id)) stray++;
            if (stray) {
              failures.push(`H8 ${label}/${n.id}/${hid}: ${stray} id(s) outside the scope`);
              sideOk = false; continue;
            }
            const oracle = refFromWires(gnodes, gedges, seeds, side);
            const wantP = new Set(oracle.peers); wantP.delete(n.id);
            const wantR = new Set(oracle.relays); wantR.delete(n.id);
            const gotE = new Set(pm.edges.keys());
            if (!sameIds(gotE, oracle.markedEdges)
              || !sameIds(new Set(idsOf(pm, 'peer')), wantP)
              || !sameIds(new Set(idsOf(pm, 'relay')), wantR)) {
              failures.push(`H8 ${label}/${n.id}/${hid}: port set != seeded oracle (${gotE.size} vs ${oracle.markedEdges.size} wires)`);
              sideOk = false; continue;
            }
            if ([...gotE].some(id => !ref.markedEdges.has(id))) {
              failures.push(`H8 ${label}/${n.id}/${hid}: the port set is NOT a subset of its third`);
              sideOk = false; continue;
            }
            if ([...pm.edges.values()].some(t => t !== side)) {
              failures.push(`H8 ${label}/${n.id}/${hid}: a port wire carries the wrong token`);
              sideOk = false; continue;
            }
            passed++;
            for (const id of gotE) union.add(id);
          }
          if (sideOk && handled.size === incident.length) {
            if (!sameIds(union, ref.markedEdges)) {
              failures.push(`H8 ${label}/${n.id}/${side}: the union over the handles (${union.size}) != the third (${ref.markedEdges.size})`);
            } else passed++;
          }
        }
        // An UNWIRED handle lights the node only — on every real node.
        const un = computeHoverMarks(ix, { kind: 'port', nodeId: n.id, handleId: 'input_value___harness_unwired__' });
        if (!un || un.edges.size !== 0 || un.nodes.size !== 1 || un.nodes.get(n.id) !== 'self') {
          failures.push(`H8 ${label}/${n.id}: an UNWIRED handle did not light the node only`);
        } else passed++;
      }
    }

    // --- H7 ON THE LIBRARY: every WIRE ------------------------------------
    for (const e of gedges) {
      edgeChecks++;
      const m = computeHoverMarks(ix, { kind: 'edge', id: e.id });
      if (!m) { failures.push(`H7 ${label}/${e.id}: no marks for a real wire`); continue; }
      passed++;
      if (m.edges.get(e.id) !== 'wire' || [...m.edges.values()].some(t => t !== 'wire')) {
        failures.push(`H7 ${label}/${e.id}: a chain segment carries a token other than 'wire'`);
        continue;
      }
      passed++;
      if (idsOf(m, 'self').length !== 0) {
        failures.push(`H7 ${label}/${e.id}: a wire hover marked a node 'self'`);
        continue;
      }
      passed++;
      let stray = 0;
      for (const id of m.nodes.keys()) if (!scopeIds.has(id)) stray++;
      for (const id of m.edges.keys()) if (!edgeIdsInScope.has(id)) stray++;
      if (stray) { failures.push(`H7 ${label}/${e.id}: ${stray} id(s) outside the scope`); continue; }
      passed++;
      // BOTH ends of the hovered wire are in the set (the dot at a chain's
      // elbow as a relay, a real node as a peer) — never a floating wire.
      if (!m.nodes.has(e.source) || !m.nodes.has(e.target)) {
        failures.push(`H7 ${label}/${e.id}: an endpoint of the HOVERED wire is unmarked`);
        continue;
      }
      passed++;
      const up = refFromWires(gnodes, gedges, new Set([e.id]), 'in');
      const down = refFromWires(gnodes, gedges, new Set([e.id]), 'out');
      if (!sameIds(new Set(m.edges.keys()), unionOf(up.markedEdges, down.markedEdges))
        || !sameIds(new Set(idsOf(m, 'peer')), unionOf(up.peers, down.peers))
        || !sameIds(new Set(idsOf(m, 'relay')), unionOf(up.relays, down.relays))) {
        failures.push(`H7 ${label}/${e.id}: chain != the two seeded oracle walks`);
        continue;
      }
      passed++;
    }
    const ms = Date.now() - t0;
    if (ms > worstMs) { worstMs = ms; worstScope = `${label} (${gnodes.length} nodes)`; }
  }
}
if (!QUIET) {
  console.log(`  [C] ${modelFiles.length} models, ${scopeCount} scopes (${dotScopes} with reroutes), ${nodeChecks} node×zone + ${portChecks} handle + ${edgeChecks} wire probes; slowest scope ${worstMs} ms on ${worstScope}`);
}
ok(scopeCount >= 30, `C: the sweep really visited the library (${scopeCount} scopes)`);
ok(dotScopes >= 1, `C: at least one swept scope has REROUTES (${dotScopes})`);
ok(nodeChecks >= 2000, `C: the sweep is broad (${nodeChecks} node×zone probes)`);
ok(portChecks >= 1000, `C: every wired HANDLE in the library was probed (${portChecks})`);
ok(edgeChecks >= 1000, `C: every WIRE in the library was probed (${edgeChecks})`);

// ---------------------------------------------------------------------------
// RESULT
// ---------------------------------------------------------------------------
rmSync(BUNDLE_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — `--controls`
//   Each applies a deliberate SOURCE MUTATION to the SHIPPED module, re-runs the
//   whole suite in a child process, and requires it to FAIL. A control that
//   passes means the assertion it targets does not discriminate. The source is
//   restored byte-exactly afterwards, whatever happens.
// ---------------------------------------------------------------------------
if (process.argv.includes('--controls')) {
  const TARGET = SRC('modeler/vpl/hoverHighlight.ts');
  const original = readFileSync(TARGET, 'utf8');
  /** ⚠ LINE ENDINGS. `core.autocrlf` checks these sources out as CRLF on
   *  Windows while this harness is written with `\n`, so a multi-line anchor
   *  compared literally would be reported "GONE" on one platform and matched on
   *  the other — a control that silently stops discriminating. Every anchor is
   *  therefore translated to the working tree's own EOL before matching. */
  const EOL = original.includes('\r\n') ? '\r\n' : '\n';
  const applyAnchor = (src, from, to) => {
    const needle = from.split('\n').join(EOL);
    if (!src.includes(needle)) return null;
    return src.split(needle).join(to.split('\n').join(EOL));
  };
  const CONTROLS = [
    {
      n: 1, targets: 'H4 / H5 / H12 (the reroute WALK)',
      what: 'stop walking THROUGH a dot (mark it, but never follow its own wires)',
      edits: [
        ['        for (const u of index.inByNode.get(src) ?? []) stack.push(u);', '        void 0;'],
        ['        for (const u of index.outByNode.get(tgt) ?? []) stack.push(u);', '        void 0;'],
      ],
    },
    {
      n: 2, targets: 'H1 / H2 / H12 (which side a third means)',
      what: 'swap in and out — the left third walks DOWNSTREAM',
      edits: [[
        "  if (zone === 'in' || zone === 'both') {\n    walkUp(index, index.inByNode.get(subjectId) ?? [], nodes, edges, 'in', new Set([subjectId]));\n  }\n  if (zone === 'out' || zone === 'both') {\n    walkDown(index, index.outByNode.get(subjectId) ?? [], nodes, edges, 'out', new Set([subjectId]));\n  }",
        "  if (zone === 'in' || zone === 'both') {\n    walkDown(index, index.outByNode.get(subjectId) ?? [], nodes, edges, 'in', new Set([subjectId]));\n  }\n  if (zone === 'out' || zone === 'both') {\n    walkUp(index, index.inByNode.get(subjectId) ?? [], nodes, edges, 'out', new Set([subjectId]));\n  }",
      ]],
    },
    {
      n: 3, targets: 'H9 (the hysteresis)',
      what: 'drop the hysteresis — the zone is decided by the raw thresholds alone',
      edits: [[
        "  if (prev === 'in' && r <= HOVER_LEAVE_LEFT) return 'in';\n  if (prev === 'out' && r >= HOVER_LEAVE_RIGHT) return 'out';",
        '  void prev;',
      ]],
    },
    {
      n: 4, targets: 'H11 (the colour lift)',
      what: 'lighten with the wrong curve (a 55/45 mix towards white instead of an HSL lift)',
      edits: [[
        '  const s = d / (1 - Math.abs(2 * l - 1));',
        '  const s = 0;',
      ]],
    },
    {
      n: 5, targets: 'H4 / H5 / H6 / H12 (the relay mark)',
      what: 'skip the `relay` mark on a dot (the chain still lights, the dots do not)',
      edits: [
        ["      if (!nodes.has(src)) nodes.set(src, 'relay');", '      void src;'],
        ["      if (!nodes.has(tgt)) nodes.set(tgt, 'relay');", '      void tgt;'],
      ],
    },
    {
      n: 6, targets: 'H6 / H12 (a dot has no thirds)',
      what: 'let a reroute dot obey the asked-for zone instead of always lighting both sides',
      edits: [[
        "  const zone: HoverZone = kind === 'reroute' ? 'both' : target.zone;",
        '  const zone: HoverZone = target.zone;',
      ]],
    },
    {
      n: 8, targets: 'H8 / C-handle sweep (the port walk reads the HANDLE)',
      what: 'let a port hover walk the whole SIDE instead of that one handle\'s wires',
      edits: [[
        '    const seeds = index.byHandle.get(hoverHandleKey(subjectId, target.handleId)) ?? [];',
        '    const seeds = (dir === \'in\' ? index.inByNode.get(subjectId) : index.outByNode.get(subjectId)) ?? [];',
      ]],
    },
    {
      n: 9, targets: 'H7 / C-wire sweep (a wire lights BOTH ways)',
      what: 'drop the downstream half of a wire hover (only the producer end lights)',
      edits: [[
        "    walkDown(index, [w], nodes, edges, 'wire', new Set<string>());",
        '    void walkDown;',
      ]],
    },
    {
      n: 10, targets: 'H8 (a handle on a DOT is the dot)',
      what: 'let a reroute\'s handle obey its own direction instead of lighting both sides',
      edits: [[
        "      walkUp(index, index.inByNode.get(subjectId) ?? [], nodes, edges, 'in', new Set([subjectId]));\n      walkDown(index, index.outByNode.get(subjectId) ?? [], nodes, edges, 'out', new Set([subjectId]));\n      return { nodes, edges, originId: subjectId };",
        "      if (handleDirection(target.handleId) === 'in') walkUp(index, index.inByNode.get(subjectId) ?? [], nodes, edges, 'in', new Set([subjectId]));\n      else walkDown(index, index.outByNode.get(subjectId) ?? [], nodes, edges, 'out', new Set([subjectId]));\n      return { nodes, edges, originId: subjectId };",
      ]],
    },
    {
      // The bug this suite actually caught while P2 was being written: one
      // `seen` set shared by the two walks truncates the downstream half of a
      // chain, but ONLY when a dot is reachable both ways — i.e. on a cycle.
      n: 11, targets: 'H7 (one `seen` set PER DIRECTION)',
      what: 'share one `seen` set between the up- and down-walks of a wire hover',
      edits: [[
        "    walkUp(index, [w], nodes, edges, 'wire', new Set<string>());\n    walkDown(index, [w], nodes, edges, 'wire', new Set<string>());",
        "    const shared = new Set<string>();\n    walkUp(index, [w], nodes, edges, 'wire', shared);\n    walkDown(index, [w], nodes, edges, 'wire', shared);",
      ]],
    },
    {
      n: 7, targets: 'H1 / H12 (groups and comments are skipped BY TYPE)',
      what: 'let a group / comment be a hover subject',
      edits: [[
        "  if (!kind || kind === 'other') return null;",
        '  if (!kind) return null;',
      ]],
    },
  ];
  console.log('\n=== NEGATIVE CONTROLS (each mutation must make the suite FAIL) ===');
  const { execFileSync } = await import('child_process');
  let controlFailures = 0;
  try {
    for (const c of CONTROLS) {
      let mutated = original;
      let applied = true;
      for (const [from, to] of c.edits) {
        const next = applyAnchor(mutated, from, to);
        if (next === null) { applied = false; break; }
        mutated = next;
      }
      if (!applied) {
        console.log(`FAIL  control ${c.n}: the mutation anchor is GONE — ${c.what}`);
        controlFailures++;
        continue;
      }
      writeFileSync(TARGET, mutated);
      let suiteFailed = false;
      let out = '';
      try {
        out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify-hover-highlight.mjs'), '--quiet'],
          { cwd: ROOT, encoding: 'utf8' });
      } catch (err) {
        suiteFailed = true;
        out = String(err.stdout ?? '');
      }
      writeFileSync(TARGET, original);
      const summary = out.trim().split('\n').pop() ?? '';
      if (suiteFailed) console.log(`  ok  control ${c.n} — ${c.what} ⇒ ${c.targets} FAILS (${summary})`);
      else { console.log(`FAIL  control ${c.n} — ${c.what} ⇒ the suite still PASSED (${summary})`); controlFailures++; }
    }
  } finally {
    writeFileSync(TARGET, original);
    if (readFileSync(TARGET, 'utf8') !== original) { console.log('FAIL  the source was NOT restored byte-exactly'); controlFailures++; }
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
    ? `HOVER HIGHLIGHT ✓ — ${passed} checks passed`
    : `${failures.length} FAILURE(S) — ${passed} checks passed`);
} else {
  console.log(`${failures.length} failure(s), ${passed} checks passed`);
}
process.exit(failures.length === 0 ? 0 : 1);
