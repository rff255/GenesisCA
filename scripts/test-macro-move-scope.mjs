// MOVE A SELECTION ACROSS A MACRO BOUNDARY — functional verification.
//
// WHY THIS EXISTS: `check-compile-identity.mjs` proves this feature changed no
// emitted code (it changes NONE — nothing here reaches a compiler) and proves
// NOTHING about whether the rewiring is right. This is the other half: a
// synthetic, VALUE-asserting harness that builds a def + a parent graph in
// memory and drives the SHIPPED `macroMoveScope.ts`, so what it checks is what
// the drop (and the DEV hook) actually run.
//
//   Tier A — MOVE IN. An outer feeder creates a port; a moved node that FED an
//     instance port removes it and internalises its bridges; a moved node that
//     CONSUMED an instance output does the same mirrored; a flow port with a
//     surviving outer feeder is KEPT; one outer source feeding two moved nodes
//     yields ONE port (the 05a668a rule); an outer source that ALREADY feeds the
//     instance is REUSED; edges among moving nodes travel unchanged.
//   Tier B — MOVE OUT. All four crossing cases: `MacroInput.in_k -> moved`
//     (sole consumer ⇒ port removed + rewired from outside; other consumers ⇒
//     port KEPT and the outer source additionally fans out to the moved node);
//     `moved -> MacroOutput.out_k` (port removed, every outer consumer rewired);
//     `staying -> moved` (new OUTPUT port, de-duplicated and REUSED); and
//     `moved -> staying` (new INPUT port, de-duplicated).
//   Tier C — EXPLICIT CONTROLS. A control whose target LEAVES the def is
//     removed for every nodeId-bearing target kind (config / facet / control);
//     a control on a staying node survives with its order intact; emptying the
//     list restores the pristine `controls: undefined` record shape.
//   Tier D — GUARDS. Boundary nodes and singleton event roots can never move;
//     the model-wide instance count sees Agents / Overseer / nested defs (which
//     `countMacroInstances` does not); a missing instance / empty selection is
//     refused rather than half-applied.
//
// NEGATIVE CONTROL: `node scripts/test-macro-move-scope.mjs --mutate` patches
// the SHIPPED source three ways, re-runs the suite for each and asserts it FAILS
// (a harness that can only ever pass proves nothing), then restores byte-exactly.
//
// Run from the repo root:  node scripts/test-macro-move-scope.mjs
import { build } from 'esbuild';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MUTATE = process.argv.includes('--mutate');

const ENTRY = `
export {
  moveIntoMacro, moveOutOfMacro, filterMovableIds, stripControlsForNodes,
  countInstancesEverywhere, MOVE_SCOPE_EXCLUDED_TYPES,
} from '../src/modeler/vpl/macroMoveScope.ts';
export { handleId, parseHandleId } from '../src/modeler/vpl/types.ts';
// The REAL reducer, so the linked-instance cascade the harness exercises is the
// one the app dispatches (the test-macro-references / test-explicit-controls
// precedent).
export { modelReducer } from '../src/model/ModelContext.tsx';
`;

async function loadBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'gca-movescope-'));
  const entryPath = join(ROOT, 'scripts', '__movescope_entry.ts');
  writeFileSync(entryPath, ENTRY);
  const outPath = join(dir, `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
  const mod = await import(pathToFileURL(outPath).href);
  rmSync(entryPath, { force: true });
  return { mod, dir };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let pass = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else failures.push(msg); }
function eq(a, b, msg) { ok(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
const vIn = p => `input_value_${p}`;
const vOut = p => `output_value_${p}`;
const fIn = p => `input_flow_${p}`;
const fOut = p => `output_flow_${p}`;

const node = (id, nodeType, x = 0, y = 0, config = {}) => ({ id, type: 'caNode', position: { x, y }, data: { nodeType, config } });
const edge = (id, source, sourceHandle, target, targetHandle) => ({ id, source, sourceHandle, target, targetHandle });
const port = (portId, boundaryId, category = 'value') => ({
  portId, label: portId, dataType: 'any', category, internalNodeId: boundaryId, internalPortId: portId,
});

/**
 * The base shape used by most cases:
 *
 *   parent:  SRC ──▶ INST.in_0        INST.out_0 ──▶ DST
 *   def:     mi.in_0 ──▶ A.x          A.value ──▶ mo.out_0
 */
function baseFixture() {
  const def = {
    id: 'macro_1', name: 'M',
    nodes: [
      node('mi', 'macroInput', -300, 0, { macroDefId: 'macro_1' }),
      node('A', 'arithmeticOperator', 0, 0),
      node('mo', 'macroOutput', 300, 0, { macroDefId: 'macro_1' }),
    ],
    edges: [
      edge('b_in', 'mi', vOut('in_0'), 'A', vIn('x')),
      edge('b_out', 'A', vOut('value'), 'mo', vIn('out_0')),
    ],
    exposedInputs: [port('in_0', 'mi')],
    exposedOutputs: [port('out_0', 'mo')],
  };
  const parentNodes = [
    node('SRC', 'getConstant', -400, 0),
    node('INST', 'macro', 0, 0, { macroDefId: 'macro_1' }),
    node('DST', 'setAttribute', 400, 0),
  ];
  const parentEdges = [
    edge('p_in', 'SRC', vOut('value'), 'INST', vIn('in_0')),
    edge('p_out', 'INST', vOut('out_0'), 'DST', vIn('value')),
  ];
  return { def, parentNodes, parentEdges };
}

const findEdge = (edges, pred) => edges.filter(pred);
const hasEdge = (edges, s, sh, t, th) =>
  edges.some(e => e.source === s && e.sourceHandle === sh && e.target === t && e.targetHandle === th);

// ---------------------------------------------------------------------------
async function run(M) {
  pass = 0; failures.length = 0;
  const { moveIntoMacro, moveOutOfMacro, filterMovableIds, stripControlsForNodes, countInstancesEverywhere } = M;

  // =========================================================================
  // Tier A — MOVE IN
  // =========================================================================

  // A1 — an OUTER feeder and an OUTER consumer of the moved node each create ONE port.
  {
    const f = baseFixture();
    f.parentNodes.push(node('N', 'arithmeticOperator', 100, 200), node('S2', 'getConstant', -400, 200), node('D2', 'setAttribute', 400, 200));
    f.parentEdges.push(
      edge('e1', 'S2', vOut('value'), 'N', vIn('x')),
      edge('e2', 'N', vOut('value'), 'D2', vIn('value')),
    );
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['N'] });
    ok(r.ok, 'A1 move-in succeeds');
    eq(r.addedInputPortIds.length, 1, 'A1 one input port added');
    eq(r.addedOutputPortIds.length, 1, 'A1 one output port added');
    eq(r.removedInputPortIds.length + r.removedOutputPortIds.length, 0, 'A1 nothing removed');
    const inP = r.def.exposedInputs.find(p => p.portId === r.addedInputPortIds[0]);
    const outP = r.def.exposedOutputs.find(p => p.portId === r.addedOutputPortIds[0]);
    ok(!!inP && !!outP, 'A1 the new ports are on the def');
    ok(hasEdge(r.parentEdges, 'S2', vOut('value'), 'INST', vIn(inP.portId)), 'A1 outer feeder now wires to the new input port');
    ok(hasEdge(r.parentEdges, 'INST', vOut(outP.portId), 'D2', vIn('value')), 'A1 outer consumer now reads the new output port');
    ok(hasEdge(r.def.edges, 'mi', vOut(inP.portId), 'N', vIn('x')), 'A1 the bridge feeds the moved node inside');
    ok(hasEdge(r.def.edges, 'N', vOut('value'), 'mo', vIn(outP.portId)), 'A1 the moved node bridges to the MacroOutput');
    ok(!r.parentNodes.some(n => n.id === 'N'), 'A1 the moved node left the parent graph');
    ok(r.def.nodes.some(n => n.id === 'N'), 'A1 the moved node is in the def');
    ok(!r.parentEdges.some(e => e.id === 'e1' || e.id === 'e2'), 'A1 the two crossing edges are gone from the parent');
    // the ORIGINAL wiring is untouched
    ok(hasEdge(r.parentEdges, 'SRC', vOut('value'), 'INST', vIn('in_0')), 'A1 the pre-existing input wire survives');
    ok(hasEdge(r.parentEdges, 'INST', vOut('out_0'), 'DST', vIn('value')), 'A1 the pre-existing output wire survives');
  }

  // A2 — a node that FED an instance input port: the port is REMOVED and its
  // bridges become direct internal edges.
  {
    const f = baseFixture();
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['SRC'] });
    ok(r.ok, 'A2 move-in succeeds');
    eq(r.removedInputPortIds.join(','), 'in_0', 'A2 in_0 removed');
    eq(r.def.exposedInputs.length, 0, 'A2 the def has no input port left');
    ok(hasEdge(r.def.edges, 'SRC', vOut('value'), 'A', vIn('x')), 'A2 the moved node feeds A directly inside');
    ok(!r.def.edges.some(e => e.source === 'mi'), 'A2 the MacroInput bridge is gone');
    ok(!r.parentEdges.some(e => e.target === 'INST'), 'A2 no wire into the instance remains');
    eq(r.addedInputPortIds.length, 0, 'A2 no port was added');
  }

  // A3 — a node that CONSUMED an instance output port: mirrored.
  {
    const f = baseFixture();
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['DST'] });
    ok(r.ok, 'A3 move-in succeeds');
    eq(r.removedOutputPortIds.join(','), 'out_0', 'A3 out_0 removed');
    eq(r.def.exposedOutputs.length, 0, 'A3 the def has no output port left');
    ok(hasEdge(r.def.edges, 'A', vOut('value'), 'DST', vIn('value')), 'A3 A feeds the moved node directly inside');
    ok(!r.def.edges.some(e => e.target === 'mo'), 'A3 the MacroOutput bridge is gone');
    ok(!r.parentEdges.some(e => e.source === 'INST'), 'A3 no wire out of the instance remains');
  }

  // A4 — a FLOW input port with a SECOND, non-moving feeder is KEPT.
  {
    const def = {
      id: 'macro_f', name: 'F',
      nodes: [node('mi', 'macroInput', -300, 0, {}), node('A', 'setAttribute', 0, 0), node('mo', 'macroOutput', 300, 0, {})],
      edges: [edge('b', 'mi', fOut('in_0'), 'A', fIn('do'))],
      exposedInputs: [port('in_0', 'mi', 'flow')],
      exposedOutputs: [],
    };
    const parentNodes = [node('F1', 'conditional', -400, 0), node('F2', 'conditional', -400, 200), node('INST', 'macro', 0, 0, { macroDefId: 'macro_f' })];
    const parentEdges = [
      edge('pf1', 'F1', fOut('then'), 'INST', fIn('in_0')),
      edge('pf2', 'F2', fOut('then'), 'INST', fIn('in_0')),
    ];
    const r = moveIntoMacro({ def, parentNodes, parentEdges, instanceNodeId: 'INST', movingIds: ['F1'] });
    ok(r.ok, 'A4 move-in succeeds');
    eq(r.removedInputPortIds.length, 0, 'A4 the flow port is KEPT (F2 still feeds it)');
    ok(hasEdge(r.def.edges, 'F1', fOut('then'), 'A', fIn('do')), 'A4 the moved node feeds A directly');
    ok(hasEdge(r.def.edges, 'mi', fOut('in_0'), 'A', fIn('do')), 'A4 the surviving bridge is still there');
    ok(hasEdge(r.parentEdges, 'F2', fOut('then'), 'INST', fIn('in_0')), 'A4 the other outer feeder is untouched');
  }

  // A5 — THE DE-DUP RULE: one outer source feeding two moved nodes ⇒ ONE port.
  {
    const f = baseFixture();
    f.parentNodes.push(node('N1', 'arithmeticOperator', 100, 200), node('N2', 'arithmeticOperator', 100, 300), node('S2', 'getConstant', -400, 200));
    f.parentEdges.push(
      edge('e1', 'S2', vOut('value'), 'N1', vIn('x')),
      edge('e2', 'S2', vOut('value'), 'N2', vIn('x')),
    );
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['N1', 'N2'] });
    ok(r.ok, 'A5 move-in succeeds');
    eq(r.addedInputPortIds.length, 1, 'A5 ONE input port for one outer source feeding two moved nodes');
    const p = r.addedInputPortIds[0];
    eq(findEdge(r.parentEdges, e => e.target === 'INST' && e.targetHandle === vIn(p)).length, 1, 'A5 exactly one outer wire into it');
    eq(findEdge(r.def.edges, e => e.source === 'mi' && e.sourceHandle === vOut(p)).length, 2, 'A5 it fans out to BOTH consumers inside');
  }

  // A5b — one moved node feeding two outer consumers ⇒ ONE output port that fans out.
  {
    const f = baseFixture();
    f.parentNodes.push(node('N', 'arithmeticOperator', 100, 200), node('D2', 'setAttribute', 400, 200), node('D3', 'setAttribute', 400, 300));
    f.parentEdges.push(
      edge('e1', 'N', vOut('value'), 'D2', vIn('value')),
      edge('e2', 'N', vOut('value'), 'D3', vIn('value')),
    );
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['N'] });
    eq(r.addedOutputPortIds.length, 1, 'A5b ONE output port for one moved source feeding two outer consumers');
    const p = r.addedOutputPortIds[0];
    eq(findEdge(r.parentEdges, e => e.source === 'INST' && e.sourceHandle === vOut(p)).length, 2, 'A5b it fans out to BOTH consumers outside');
    eq(findEdge(r.def.edges, e => e.target === 'mo' && e.targetHandle === vIn(p)).length, 1, 'A5b exactly one bridge inside');
  }

  // A6 — REUSE: an outer source that ALREADY feeds the instance gets no second port.
  {
    const f = baseFixture();
    f.parentNodes.push(node('N', 'arithmeticOperator', 100, 200));
    f.parentEdges.push(edge('e1', 'SRC', vOut('value'), 'N', vIn('x')));
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['N'] });
    ok(r.ok, 'A6 move-in succeeds');
    eq(r.addedInputPortIds.length, 0, 'A6 NO new port — the existing in_0 already carries that source');
    eq(r.def.exposedInputs.length, 1, 'A6 still one input port');
    eq(findEdge(r.parentEdges, e => e.target === 'INST').length, 1, 'A6 still exactly one outer wire into the instance');
    ok(hasEdge(r.def.edges, 'mi', vOut('in_0'), 'N', vIn('x')), 'A6 in_0 now ALSO fans out to the moved node');
    ok(hasEdge(r.def.edges, 'mi', vOut('in_0'), 'A', vIn('x')), 'A6 its original consumer is untouched');
  }

  // A7 — edges AMONG moving nodes travel unchanged.
  {
    const f = baseFixture();
    f.parentNodes.push(node('N1', 'arithmeticOperator', 100, 200), node('N2', 'arithmeticOperator', 200, 200));
    f.parentEdges.push(edge('e1', 'N1', vOut('value'), 'N2', vIn('y')));
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['N1', 'N2'] });
    ok(hasEdge(r.def.edges, 'N1', vOut('value'), 'N2', vIn('y')), 'A7 the internal edge travelled with the pair');
    eq(r.addedInputPortIds.length + r.addedOutputPortIds.length, 0, 'A7 an internal edge creates NO port');
    ok(!r.parentEdges.some(e => e.id === 'e1'), 'A7 it is gone from the parent');
  }

  // A8 — positions convert to def space (relative to the instance).
  {
    const f = baseFixture();
    f.parentNodes[1].position = { x: 500, y: 700 };   // move INST
    f.parentNodes.push(node('N', 'arithmeticOperator', 560, 760));
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['N'] });
    const n = r.def.nodes.find(x => x.id === 'N');
    eq(n.position.x, 60, 'A8 def x = parent x − instance x');
    ok(n.position.y >= 60, 'A8 def y = parent y − instance y (or nudged clear)');
  }

  // =========================================================================
  // Tier B — MOVE OUT
  // =========================================================================

  // B1 — the whole body leaves: BOTH ports go and the outer wires reconnect directly.
  {
    const f = baseFixture();
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['A'] });
    ok(r.ok, 'B1 move-out succeeds');
    eq(r.removedInputPortIds.join(','), 'in_0', 'B1 in_0 removed (no other internal consumer)');
    eq(r.removedOutputPortIds.join(','), 'out_0', 'B1 out_0 removed (its internal source left)');
    ok(hasEdge(r.parentEdges, 'SRC', vOut('value'), 'A', vIn('x')), 'B1 the outer feeder wires straight to the moved node');
    ok(hasEdge(r.parentEdges, 'A', vOut('value'), 'DST', vIn('value')), 'B1 the moved node wires straight to the outer consumer');
    ok(!r.parentEdges.some(e => e.id === 'p_in'), 'B1 the stale wire into the instance is gone');
    ok(!r.parentEdges.some(e => e.id === 'p_out'), 'B1 the stale wire out of the instance is gone');
    ok(r.parentNodes.some(n => n.id === 'A'), 'B1 the node is in the parent graph');
    ok(!r.def.nodes.some(n => n.id === 'A'), 'B1 the node left the def');
    eq(r.def.edges.length, 0, 'B1 both bridges are gone from the def');
  }

  // B2 — `MacroInput.in_k -> moved` with ANOTHER internal consumer: port KEPT
  // and the outer source additionally fans out to the moved node.
  {
    const f = baseFixture();
    f.def.nodes.push(node('B', 'arithmeticOperator', 0, 200));
    f.def.edges.push(edge('b_in2', 'mi', vOut('in_0'), 'B', vIn('x')));
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['A'] });
    ok(r.ok, 'B2 move-out succeeds');
    eq(r.removedInputPortIds.length, 0, 'B2 in_0 is KEPT (B still consumes it)');
    ok(hasEdge(r.parentEdges, 'SRC', vOut('value'), 'INST', vIn('in_0')), 'B2 the outer feeder still feeds the port');
    ok(hasEdge(r.parentEdges, 'SRC', vOut('value'), 'A', vIn('x')), 'B2 …AND now also the moved node (a fan-out from an OUTPUT port)');
    ok(hasEdge(r.def.edges, 'mi', vOut('in_0'), 'B', vIn('x')), 'B2 the surviving bridge is intact');
  }

  // B3 — `moved -> MacroOutput.out_k` with SEVERAL outer consumers: all rewired.
  {
    const f = baseFixture();
    f.parentNodes.push(node('D2', 'setAttribute', 400, 200));
    f.parentEdges.push(edge('p_out2', 'INST', vOut('out_0'), 'D2', vIn('value')));
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['A'] });
    ok(hasEdge(r.parentEdges, 'A', vOut('value'), 'DST', vIn('value')), 'B3 consumer 1 rewired to the moved node');
    ok(hasEdge(r.parentEdges, 'A', vOut('value'), 'D2', vIn('value')), 'B3 consumer 2 rewired to the moved node');
    eq(findEdge(r.parentEdges, e => e.source === 'INST').length, 0, 'B3 no wire out of the instance remains');
    eq(r.removedOutputPortIds.join(','), 'out_0', 'B3 out_0 removed');
  }

  // B4 — `staying -> moved` ⇒ a new OUTPUT port (and a SECOND moved consumer of
  // the same staying source REUSES it — the de-dup rule).
  {
    const f = baseFixture();
    f.def.nodes.push(node('B', 'getConstant', -100, 200), node('C', 'setAttribute', 100, 300));
    f.def.edges.push(
      edge('i1', 'B', vOut('value'), 'A', vIn('y')),
      edge('i2', 'B', vOut('value'), 'C', vIn('value')),
    );
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['A', 'C'] });
    ok(r.ok, 'B4 move-out succeeds');
    eq(r.addedOutputPortIds.length, 1, 'B4 ONE new output port for one staying source feeding two moved nodes');
    const p = r.addedOutputPortIds[0];
    ok(hasEdge(r.def.edges, 'B', vOut('value'), 'mo', vIn(p)), 'B4 the bridge carries the staying source');
    ok(hasEdge(r.parentEdges, 'INST', vOut(p), 'A', vIn('y')), 'B4 the parent reads it into moved node A');
    ok(hasEdge(r.parentEdges, 'INST', vOut(p), 'C', vIn('value')), 'B4 …and into moved node C');
  }

  // B4b — REUSE: a staying source that an existing output port ALREADY carries.
  {
    const f = baseFixture();
    // out_0 already carries A.value; move a node that A also feeds.
    f.def.nodes.push(node('C', 'setAttribute', 100, 300));
    f.def.edges.push(edge('i1', 'A', vOut('value'), 'C', vIn('value')));
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['C'] });
    eq(r.addedOutputPortIds.length, 0, 'B4b NO new output port — out_0 already carries A.value');
    ok(hasEdge(r.parentEdges, 'INST', vOut('out_0'), 'C', vIn('value')), 'B4b the moved node reads the existing port');
    ok(hasEdge(r.parentEdges, 'INST', vOut('out_0'), 'DST', vIn('value')), 'B4b its original consumer is untouched');
  }

  // B5 — `moved -> staying` ⇒ a new INPUT port whose bridge feeds the stayer.
  {
    const f = baseFixture();
    f.def.nodes.push(node('B', 'setAttribute', 200, 200));
    f.def.edges.push(edge('i1', 'A', vOut('value'), 'B', vIn('value')));
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['A'] });
    ok(r.ok, 'B5 move-out succeeds');
    eq(r.addedInputPortIds.length, 1, 'B5 one new input port');
    const p = r.addedInputPortIds[0];
    ok(p !== 'in_0', 'B5 the new port does NOT re-use the id of the port removed in the same move');
    ok(hasEdge(r.parentEdges, 'A', vOut('value'), 'INST', vIn(p)), 'B5 the moved node feeds the instance through it');
    ok(hasEdge(r.def.edges, 'mi', vOut(p), 'B', vIn('value')), 'B5 its bridge feeds the staying node');
  }

  // B6 — edges among moving nodes travel unchanged; positions convert to parent space.
  {
    const f = baseFixture();
    f.parentNodes[1].position = { x: 500, y: 700 };
    f.def.nodes.push(node('B', 'arithmeticOperator', 40, 60));
    f.def.edges.push(edge('i1', 'A', vOut('value'), 'B', vIn('y')));
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['A', 'B'] });
    ok(hasEdge(r.parentEdges, 'A', vOut('value'), 'B', vIn('y')), 'B6 the internal edge travelled with the pair');
    const b = r.parentNodes.find(n => n.id === 'B');
    eq(b.position.x, 540, 'B6 parent x = instance x + def x');
    ok(!r.def.edges.some(e => e.id === 'i1'), 'B6 it is gone from the def');
  }

  // =========================================================================
  // Tier C — EXPLICIT CONTROLS
  // =========================================================================
  {
    const f = baseFixture();
    f.def.nodes.push(node('B', 'getConstant', -100, 200));
    f.def.controls = [
      { id: 'c1', name: 'A op', target: { kind: 'config', nodeId: 'A', configKey: 'operation' } },
      { id: 'c2', name: 'B const', target: { kind: 'config', nodeId: 'B', configKey: 'constValue' } },
      { id: 'c3', name: 'A grad', target: { kind: 'facet', nodeId: 'A', facet: 'gradient' } },
    ];
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['A'] });
    eq(r.removedControlIds.sort().join(','), 'c1,c3', 'C1 both controls targeting the departing node are removed (config AND facet)');
    eq((r.def.controls ?? []).map(c => c.id).join(','), 'c2', 'C1 the control on the staying node survives');
  }
  {
    // A CHAINED control names a nested macro INSTANCE node — which can itself move.
    const f = baseFixture();
    f.def.nodes.push(node('NEST', 'macro', 100, 200, { macroDefId: 'macro_other' }));
    f.def.controls = [{ id: 'c1', name: 'nested', target: { kind: 'control', nodeId: 'NEST', controlId: 'x' } }];
    const r = moveOutOfMacro({ ...f, instanceNodeId: 'INST', movingIds: ['NEST'] });
    eq(r.removedControlIds.join(','), 'c1', 'C2 a chained control whose nested instance leaves is removed');
    eq(r.def.controls, undefined, 'C2 the emptied array restores the pristine `controls: undefined` shape');
  }
  {
    const def = {
      id: 'm', name: 'M', nodes: [node('A', 'x'), node('B', 'x')], edges: [],
      exposedInputs: [], exposedOutputs: [],
      controls: [
        { id: 'c1', name: '1', target: { kind: 'config', nodeId: 'A', configKey: 'k' } },
        { id: 'c2', name: '2', target: { kind: 'config', nodeId: 'B', configKey: 'k' } },
        { id: 'c3', name: '3', target: { kind: 'config', nodeId: 'B', configKey: 'j' } },
      ],
      groups: [{ id: 'g1', name: 'G' }],
    };
    const out = stripControlsForNodes(def, new Set(['A']));
    eq(out.controls.map(c => c.id).join(','), 'c2,c3', 'C3 order is preserved by the shared builder');
    eq(out.groups.length, 1, 'C3 groups are untouched (an empty group is still a valid separator)');
    eq(stripControlsForNodes(def, new Set(['Z'])), def, 'C3 a no-op returns the SAME object');
  }

  // =========================================================================
  // Tier D — GUARDS
  // =========================================================================
  {
    const nodes = [
      node('mi', 'macroInput'), node('mo', 'macroOutput'), node('st', 'step'),
      node('bs', 'behaviourStep'), node('ok1', 'arithmeticOperator'), node('ok2', 'commentNode'),
    ];
    eq(filterMovableIds(nodes, nodes.map(n => n.id)).join(','), 'ok1,ok2', 'D1 boundary nodes and singleton roots can never move');
  }
  {
    const f = baseFixture();
    const r = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: [] });
    eq(r.ok, false, 'D2 an empty selection is refused');
    const r2 = moveIntoMacro({ ...f, instanceNodeId: 'NOPE', movingIds: ['SRC'] });
    eq(r2.ok, false, 'D2 a missing instance is refused');
    const r3 = moveIntoMacro({ ...f, instanceNodeId: 'SRC', movingIds: ['DST'] });
    eq(r3.ok, false, 'D2 a non-macro drop target is refused');
    const r4 = moveIntoMacro({ ...f, instanceNodeId: 'INST', movingIds: ['INST'] });
    eq(r4.ok, false, 'D2 an instance cannot be moved into itself');
  }
  {
    const inst = d => node(`i_${d}`, 'macro', 0, 0, { macroDefId: d });
    const model = {
      graphNodes: [inst('D')],
      agentGraphNodes: [inst('D')],
      overseerGraphNodes: [inst('E')],
      macroDefs: [{ id: 'X', name: 'X', nodes: [inst('D')], edges: [], exposedInputs: [], exposedOutputs: [] }],
    };
    eq(countInstancesEverywhere(model, 'D'), 3, 'D3 the instance count sees Cells + Agents + a nested def');
    eq(countInstancesEverywhere(model, 'E'), 1, 'D3 …and the Overseer graph');
    eq(countInstancesEverywhere(model, 'nope'), 0, 'D3 an unknown def has no instances');
  }

  // =========================================================================
  // Tier E — THE LINKED-INSTANCE CASCADE, through the REAL reducer
  // =========================================================================
  {
    const { modelReducer } = M;
    const inst = (id, defId) => node(id, 'macro', 0, 0, { macroDefId: defId });
    const model = {
      graphNodes: [node('A', 'getConstant'), inst('IA', 'D'), node('B', 'setAttribute')],
      graphEdges: [
        edge('keep', 'A', vOut('value'), 'IA', vIn('in_0')),
        edge('goneOut', 'IA', vOut('out_0'), 'B', vIn('value')),
        edge('unrelated', 'A', vOut('value'), 'B', vIn('other')),
      ],
      agentGraphNodes: [inst('IB', 'D'), node('C', 'setAttribute')],
      agentGraphEdges: [edge('goneAgent', 'IB', vOut('out_0'), 'C', vIn('value'))],
      overseerGraphNodes: [inst('IC', 'D'), node('E', 'setAttribute')],
      overseerGraphEdges: [edge('goneOv', 'IC', vOut('out_0'), 'E', vIn('value'))],
      macroDefs: [
        { id: 'D', name: 'D', nodes: [], edges: [], exposedInputs: [], exposedOutputs: [] },
        { id: 'X', name: 'X', nodes: [inst('ID', 'D')], edges: [edge('goneNested', 'ID', vOut('out_0'), 'ID2', vIn('value'))], exposedInputs: [], exposedOutputs: [] },
        { id: 'Y', name: 'Y', nodes: [inst('IE', 'other')], edges: [edge('keepOther', 'IE', vOut('out_0'), 'Z', vIn('value'))], exposedInputs: [], exposedOutputs: [] },
      ],
    };
    const st0 = { model, isDirty: false };
    const st = modelReducer(st0, { type: 'PRUNE_MACRO_INSTANCE_EDGES', macroDefId: 'D', handles: ['output_value_out_0', 'output_flow_out_0'] });
    const ids = es => es.map(e => e.id).join(',');
    eq(ids(st.model.graphEdges), 'keep,unrelated', 'E1 the Cells graph loses only the wire out of the removed port');
    eq(ids(st.model.agentGraphEdges), '', 'E1 …and the AGENTS graph');
    eq(ids(st.model.overseerGraphEdges), '', 'E1 …and the OVERSEER graph');
    eq(ids(st.model.macroDefs[1].edges), '', 'E1 …and a NESTED def');
    eq(ids(st.model.macroDefs[2].edges), 'keepOther', 'E1 an instance of ANOTHER def is untouched');
    ok(st.isDirty, 'E1 the prune marks the model dirty');
    // An input-side handle (the edge names the port on its TARGET) — the reason
    // `pruneEdges` hands the drop predicate the target node too.
    const st2 = modelReducer(st0, { type: 'PRUNE_MACRO_INSTANCE_EDGES', macroDefId: 'D', handles: ['input_value_in_0'] });
    eq(ids(st2.model.graphEdges), 'goneOut,unrelated', 'E2 a wire INTO a removed input port is dropped');
    const st3 = modelReducer(st0, { type: 'PRUNE_MACRO_INSTANCE_EDGES', macroDefId: 'D', handles: [] });
    ok(st3 === st0, 'E3 an empty handle list is a no-op that returns the SAME state');
    const st4 = modelReducer(st0, { type: 'PRUNE_MACRO_INSTANCE_EDGES', macroDefId: 'D', handles: ['output_value_out_9'] });
    ok(st4 === st0, 'E3 a handle nothing matches is a no-op that returns the SAME state');
  }

  return { pass, failures: [...failures] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const SRC_PATH = join(ROOT, 'src', 'modeler', 'vpl', 'macroMoveScope.ts');

async function once(label) {
  const { mod, dir } = await loadBundle();
  const res = await run(mod);
  rmSync(dir, { recursive: true, force: true });
  if (label) console.log(`  ${label}: ${res.pass} passed, ${res.failures.length} failed`);
  return res;
}

const base = await once(null);
console.log(`macro move-scope: ${base.pass} checks passed, ${base.failures.length} failed`);
for (const f of base.failures) console.log(`  FAIL ${f}`);

if (MUTATE) {
  // NEGATIVE CONTROL — patch the SHIPPED source, prove the suite notices, restore.
  // ⚠ Snapshot as a BUFFER (never a /tmp copy): MSYS translates CRLF→LF there,
  //   so a text round-trip would silently not restore the original bytes.
  const CTX_PATH = join(ROOT, 'src', 'model', 'ModelContext.tsx');
  const MUTATIONS = [
    [SRC_PATH, 'drop the input-port de-dup (one port per crossing EDGE again)',
      'for (const g of groupBy(needInput, srcKey)) {',
      'for (const g of needInput.map(e => ({ key: srcKey(e) + Math.random(), items: [e] }))) {'],
    [SRC_PATH, 'never remove a port whose feeder moved in',
      'if (!outerFeederRemains) {',
      'if (false) {'],
    [SRC_PATH, 'move-out: keep a port whose only internal consumer left',
      'if (!otherConsumer && port) {',
      'if (false && port) {'],
    [CTX_PATH, 'the linked-instance prune ignores the TARGET side (input ports)',
      '|| (isInstance(target) && handles.has(edge.targetHandle))',
      '|| false'],
  ];
  let caught = 0;
  // ⚠ Snapshot as a BUFFER per file: this repo mixes LF (GraphEditor,
  // macroMoveScope) and CRLF (ModelContext), and a text round-trip through /tmp
  // on MSYS silently rewrites the endings.
  const originals = new Map();
  for (const [p] of MUTATIONS) if (!originals.has(p)) originals.set(p, readFileSync(p));
  try {
    for (const [p, label, from, to] of MUTATIONS) {
      const text = originals.get(p).toString('utf8');
      if (!text.includes(from)) { console.log(`  MUTATION ANCHOR MISSING: ${label}`); continue; }
      writeFileSync(p, Buffer.from(text.replace(from, to), 'utf8'));
      const res = await once(`mutation "${label}"`);
      writeFileSync(p, originals.get(p));
      if (res.failures.length > 0) caught++;
      else console.log(`  ⚠ NOT CAUGHT: ${label}`);
    }
  } finally {
    for (const [p, buf] of originals) writeFileSync(p, buf);
  }
  console.log(`negative control: ${caught}/${MUTATIONS.length} mutations caught`);
  if (caught < MUTATIONS.length) process.exit(1);
}

process.exit(base.failures.length === 0 ? 0 : 1);
