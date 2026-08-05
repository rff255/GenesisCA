#!/usr/bin/env node
/**
 * Generates public/models/Amphiphile.gcaproj — the Kier book Example 5.3
 * amphiphile micelle formation model, implemented VERBATIM to the algorithm
 * described in Kier, Seybold & Cheng (2005), "Modeling Chemical Systems Using
 * Cellular Automata", Chapter 2 + Example 5.3 (pp. 85-86), and the companion
 * paper Kier, Cheng, Testa, Carrupt (1996), Pharm. Res. 13:1419.
 *
 * Move-into-empty algorithm (book §2.3.6 + §2.3.4):
 *
 *   Every non-empty cell acts each step (both water AND amphi). For each
 *   non-empty cell C:
 *
 *     1. Cardinal-neighbour reads (vN). For each direction d ∈ {N,E,S,W}:
 *        - kind_d   = neighbour kind at d (empty / water / amphi)
 *        - myFace_d = C's face presented in direction d
 *        - thFace_d = neighbour's face presented at the encounter
 *        - pb_d     = P_B(myFace_d, thFace_d) — bond-break probability
 *        - farKind_d = kind of the cell at distance 2 in direction d (vN2)
 *        - farFace_d = face-label proxy for farKind_d
 *           (empty→none, water→water, amphi→X)
 *        - j_d      = J(myFace_d, farFace_d) — joining probability
 *        - weight_d = (kind_d == empty) ? j_d : 0
 *
 *     2. P_break  = Π_d pb_d  (book §2.3.6: product over all neighbours).
 *        For empty neighbours, P_B(*, none) = 1 (no bond to break — neutral
 *        factor in the product), so pb_d contributes 1.0 there.
 *
 *     3. Bernoulli(P_break). If the roll fails, do nothing.
 *
 *     4. sumW = Σ_d weight_d. If sumW == 0, no empty direction → do nothing.
 *
 *     5. Sample direction d* by cumulative-sum on weight_d (J-weighted
 *        directional preference toward empty cells — book §2.3.5).
 *
 *     6. Move via the "Transfer Cell Attributes to Neighbor" node (Copy To +
 *        Defaults, Include Orientation): copies C's current (kind, ori) to the
 *        cell at NI_{d*}, then resets C's kind to empty + orientation to 0.
 *        The node reads the values straight from the cells at its flow
 *        position, transferring whatever they hold there (here the unchanged
 *        cell-top values — nothing writes kind/ori before the move). Crucially,
 *        ONE empty cell is created at the source, so empties stay uniformly
 *        distributed by construction (no asymmetric-mobility artefact that
 *        destroyed earlier swap-based attempts).
 *
 *   Independently, a "free" amphi (one with all 4 cardinals empty) rotates
 *   every iteration by a uniform random 1..3 90°-step (book §2.3.9).
 *
 * Empty cells never act (book §2.3.4: ingredients move, vacancies don't).
 *
 * The `none` row/column of both interaction tables is pre-populated with 1.0:
 *   - P_B(*, none) = 1: §2.3.6 — the simultaneous break probability is the
 *     product of P_B factors over all bordering ingredients. Where there is
 *     NO ingredient (= empty), there is no bond to break, so the factor is
 *     identity 1.
 *   - J(*, none) = 1: §2.3.5 verbatim — "When J = 1, species A has the same
 *     probability of movement toward or away from B, as when the B cell is
 *     not present." Hence "B not present" (= empty far cell) ≡ J = 1.
 * These are book definitions made explicit so the graph treats all 4
 * directions uniformly without per-direction conditionals — NOT an
 * optimisation that simplifies the theory.
 *
 * Re-run after any tweak:
 *   node scripts/gen-amphiphile.mjs
 *
 * Re-running preserves the saved simulationState + library thumbnail.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Amphiphile.gcaproj');

// --- id generation (CLAUDE.md convention: never counter-based) --------------
const usedIds = new Set();
function newId(prefix) {
  let id;
  do {
    id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

// --- graph builders ----------------------------------------------------------
const graphNodes = [];
const graphEdges = [];

function node(nodeType, config, col, row, label) {
  const n = {
    id: newId('n'),
    type: 'caNode',
    position: { x: col * 220, y: row * 80 },
    data: { nodeType, config },
  };
  if (label) n.data.label = label;
  graphNodes.push(n);
  return n;
}

function edge(srcNode, srcPort, tgtNode, tgtPort, category) {
  graphEdges.push({
    id: newId('e'),
    source: srcNode.id,
    target: tgtNode.id,
    sourceHandle: `output_${category}_${srcPort}`,
    targetHandle: `input_${category}_${tgtPort}`,
  });
}
const vEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'value');
const fEdge = (s, sp, t, tp) => edge(s, sp, t, tp, 'flow');

const PORT_IDS = 'abcdefgh';
function exprNode(expression, varNames, col, row, label) {
  const config = { expression, visibleCount: varNames.length };
  varNames.forEach((nm, i) => { config[`_varName_${PORT_IDS[i]}`] = nm; });
  return node('expression', config, col, row, label);
}

// --- Group (visual area marker) ----------------------------------------------
// Groups in saved .gcaproj files are free-floating area markers — children
// keep their absolute positions and don't carry parentId references (see
// `GraphEditor.tsx`'s defensive parentId scrub at toRFNodes). The group node
// just renders a labeled box behind the contained nodes for visual scoping.
function bboxOf(contents, padX = 30, padY = 60) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of contents) {
    // CaNode default render is ~200×80 (the actual measured size varies with
    // collapsed/expanded state and port count, but the bbox just needs to
    // visually enclose the cluster — measured sizes land at runtime).
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + 200);
    maxY = Math.max(maxY, n.position.y + 80);
  }
  return {
    x: minX - padX, y: minY - padY,
    width: (maxX - minX) + 2 * padX,
    height: (maxY - minY) + 2 * padY,
  };
}
function groupNode(label, contents, color) {
  const bb = bboxOf(contents);
  const g = {
    id: newId('g'),
    type: 'groupNode',
    position: { x: bb.x, y: bb.y },
    data: { label, width: bb.width, height: bb.height, nodeType: 'group', config: {} },
  };
  if (color) g.data.groupColor = color;
  graphNodes.push(g);
  return g;
}

// GetConstant in tag mode emits a fixed tag value (stored as its index). Lets
// the graph reference kinds by NAME (the UI renders "Tag: amphi") instead of
// hardcoded integers in Statement._port_y. The previous tagConstant node was
// retired in favour of getConstant.tag — same picker UI, same compiled int.
function tagConst(tagName, col, row, attrId, tagOptions) {
  const i = tagOptions.indexOf(tagName);
  if (i < 0) throw new Error(`unknown tag: ${tagName}`);
  return node('getConstant', {
    constType: 'tag', tagAttributeId: attrId, constValue: String(i),
  }, col, row, `Tag: ${tagName}`);
}

// =============================================================================
// IDs referenced across the graph
// =============================================================================
const ATTR_KIND = 'kind';
const ATTR_DENS_WATER = 'densityWater';
const ATTR_DENS_AMPHI = 'densityAmphi';
const ATTR_PB = 'tableP_B';
const ATTR_J = 'tableJ';
const PAT_WATER = 'pat_water';
const PAT_AMPHI = 'pat_amphi';
const NBR_VN = 'vN';
const NBR_VN2 = 'vN2';
const MAPPING_SEED = 'seed';
const MAPPING_VIZ = 'viz';

// Tag option order — kind = [empty, water, amphi]. Indices are derived from
// this list via `tagConst()` / SetAttribute's tag-mode inline widget; never
// hardcoded in the graph. Adding/reordering tags doesn't break the script.
const KIND_OPTIONS = ['empty', 'water', 'amphi'];
const FACE_LABELS = ['X', 'Y', 'water'];
// Single face-label palette (this model uses faces on both table axes). Both
// Lookup Tables key rows AND cols by this palette (square, symmetric).
const PALETTE_FACES = 'palette_faces';
// LookupInteraction's underlying tableValues row/col is indexed with `none` at
// position 0 (implicit) and user-labels starting at 1 (none=0, X=1, Y=2,
// water=3). The graph references these by NAME via GetConstant.faceLabel —
// the integer index is resolved at compile time, so reordering FACE_LABELS
// doesn't silently break the per-direction lookup chain.

// =============================================================================
// STEP GRAPH — book-faithful move-into-empty
// =============================================================================
//
// Layout philosophy (D.9): "duplicate cheap, route expensive". Simple accessors
// (getCellAttribute, getOrientation, getConstant.tag, getAllNeighborIndexes,
// getAllFacingLabels, getNeighborsAttrByIndexes) are DUPLICATED locally near
// each consumer instead of routed across the graph. The accessor CSE pass
// (compiler/accessorCSE.ts) merges them into ONE emit at compile time on all
// three targets, so there's no runtime cost. Visually, this keeps edges
// short and each subregion self-contained.
//
// Top row (row 0) is the gating flow chain:
//   stepNode → condOccupied → condBreak → condCanMove → moveSelf
// Each gate's value-input chain sits in the rows immediately below it.
//
// The per-direction forEach loop body lives in its own cluster (cols 4-11,
// rows 6-11) — hangs off condBreak.then and populates `weights[d]`.
//
// The rotation block (cols 13-15, rows 5-10) sits to the right of the loop;
// it feeds the secondary rotation pass at the bottom of the graph (no
// longer wired into moveSelf — rotation is deferred to the rotation pass).

const stepNode = node('step', {}, 0, 0);

// ─── Top gating chain (row 0) ───────────────────────────────────────────────
//   stepNode → condOccupied → condBreak → condCanMove → moveSelf
// Gates declared HERE so subsequent edges can wire to them. The
// `condBreak.then → condCanMove.check` edge is deferred until AFTER the
// forEach loop's `condBreak.then → forEachDirs.do` edge is added, so
// compileFlowChain processes the loop FIRST (which populates weights[d])
// and condCanMove SECOND (which reads sumW). compileFlowChain walks
// targets in edge-insertion order.
const condOccupied = node('conditional', {}, 2, 0, 'If occupied');
fEdge(stepNode, 'do', condOccupied, 'check');
const condBreak = node('conditional', {}, 5, 0, 'If break free');
fEdge(condOccupied, 'then', condBreak, 'check');
const condCanMove = node('conditional', {}, 9, 0, 'If has empty dir');
// condBreak.then → condCanMove.check wired LATER (see "Gate 3" below).

// ─── Rotation values (cols 13-15, rows 5-9) ────────────────────────────────
// Computes `newOri = mod(ori + rotStep, 4)` and the `amphi AND all-cardinals-
// empty` gate. Consumed only by the rotation pass below (setRotOri); moveSelf
// transfers the cell's CURRENT orientation (includeOrientation), so a free
// amphi that moves AND rotates in the same step has the rotation applied at
// the SOURCE cell on the next rotation pass — not at the destination. Sits to
// the right of the forEach body in a compact cluster.
//
// Each accessor here is a LOCAL copy — the CSE pass dedups them at compile
// time, so the graph reads like a self-contained rotation subregion.
const kindRead_rot = node('getCellAttribute', { attributeId: ATTR_KIND }, 13, 5, 'My kind');
const tagAmphi_rot = tagConst('amphi', 13, 6, ATTR_KIND, KIND_OPTIONS);
const isSelfAmphi = node('statement', { operation: '==' }, 14, 5, 'kind == amphi?');
vEdge(kindRead_rot, 'value', isSelfAmphi, 'x');
vEdge(tagAmphi_rot, 'value', isSelfAmphi, 'y');

// "All 4 cardinals are empty" via groupStatement.allIs — a single-node
// shorthand for `kinds[].every(v => v === empty)`.
const niArr_rot = node('getAllNeighborIndexes', { neighborhoodId: NBR_VN }, 13, 7, 'NIs vN');
const kindsArr_rot = node('getNeighborsAttrByIndexes', { attributeId: ATTR_KIND }, 13, 8, 'kinds[4]');
vEdge(niArr_rot, 'indexes', kindsArr_rot, 'indexes');
const tagEmpty_rot = tagConst('empty', 13, 9, ATTR_KIND, KIND_OPTIONS);
const isAllEmpty = node('groupStatement', { operation: 'allIs' }, 15, 8, 'all kinds == empty?');
vEdge(kindsArr_rot, 'values', isAllEmpty, 'values');
vEdge(tagEmpty_rot, 'value', isAllEmpty, 'x');

const rotGateAnd = node('aggregate', { operation: 'and' }, 15, 6, 'amphi AND free?');
vEdge(isSelfAmphi, 'result', rotGateAnd, 'values');
vEdge(isAllEmpty, 'result', rotGateAnd, 'values');

const oriRead_rot = node('getOrientation', {}, 13, 10, 'My ori');
const rotStepRand = node('getRandom', {
  randomType: 'integer', min: '1', max: '3',
}, 13, 11, 'Rot step 1..3');
const newOri = exprNode('mod(ori + step, 4)', ['ori', 'step'], 14, 10, 'newOri');
vEdge(oriRead_rot, 'value', newOri, 'a');
vEdge(rotStepRand, 'value', newOri, 'b');
// newOri is consumed only by the rotation pass below (setRotOri). The
// previous design also fed it into moveSelf via a rotatedOri ValueSwitch
// gated on `rotGateAnd`, so a free amphi that moved + rotated in the same
// step would deliver its post-rotation orientation to the destination.
// Per user review: that conflates "face direction the cell chose to move
// through" with "face presented at the destination" — semantically wrong,
// since the amphi's move was decided based on the PRE-rotation face. The
// move now transfers the current orientation (includeOrientation reads the
// cell's orientation directly), and rotation is deferred to the rotation pass.

// ─── Gate 1: cell is occupied? (cols 1-2, rows 1-2) ───────────────────────
const kindRead_occ = node('getCellAttribute', { attributeId: ATTR_KIND }, 1, 1, 'My kind');
const tagEmpty_occ = tagConst('empty', 1, 2, ATTR_KIND, KIND_OPTIONS);
const isSelfOccupied = node('statement', { operation: '!=' }, 2, 1, 'occupied?');
vEdge(kindRead_occ, 'value', isSelfOccupied, 'x');
vEdge(tagEmpty_occ, 'value', isSelfOccupied, 'y');
vEdge(isSelfOccupied, 'result', condOccupied, 'condition');

// ─── Gate 2: Bernoulli(P_break) (cols 3-5, rows 1-3) ──────────────────────
// Bond-break chain: cardinal-only face labels → P_B vec → Π → Bernoulli.
const allFaces_bond = node('getAllFacingLabels', { cardinalsOnly: true }, 3, 2, 'Faces (cardinals)');
const pbsArr = node('interactionTableMap', { tableId: ATTR_PB }, 4, 2, 'P_B vec[4]');
vEdge(allFaces_bond, 'myFaceLabels', pbsArr, 'myFaces');
vEdge(allFaces_bond, 'theirFaceLabels', pbsArr, 'theirFaces');
const pBreakAgg = node('aggregate', { operation: 'product' }, 4, 1, 'P_break (Π pb_d)');
vEdge(pbsArr, 'values', pBreakAgg, 'values');
const rollBreak = node('getRandom', { randomType: 'bool' }, 5, 1, 'Bernoulli(P_break)');
vEdge(pBreakAgg, 'result', rollBreak, 'probability');
vEdge(rollBreak, 'value', condBreak, 'condition');

// ─── Per-direction loop (cols 4-11, rows 6-11) ────────────────────────────
// The loop body executes once per direction d ∈ {0=N, 1=E, 2=S, 3=W}, with
// the loop counter `d` exposed via `forEachDirs.index`. Each iteration:
//   1. Reads kind_d, myFace_d, farKind_d via arrayElement[d].
//   2. Computes farLabel_d = (farKind==amphi)?X : (farKind==water)?WATER : NONE
//      via a 2× ValueSwitch chain — each switch a direct "if pred, use Y, else Z"
//      semantic lookup (no arithmetic on label indices).
//   3. Computes wt_d = adj_is_empty ? J(myFace_d, farLabel_d) : 0.
//   4. Stores wt_d into the `weights` Local Variable at index d.
// After the loop, `weights` is fully populated for aggregate / weightedRandom
// downstream. Hangs off condBreak.then so it only runs when the cell broke
// its bonds — and is sequenced BEFORE condCanMove (which reads weights).
const niArr_loop = node('getAllNeighborIndexes', { neighborhoodId: NBR_VN }, 3, 6, 'NIs vN');
const niArr2_loop = node('getAllNeighborIndexes', { neighborhoodId: NBR_VN2 }, 3, 7, 'NIs vN2 (far)');
const allFaces_loop = node('getAllFacingLabels', { cardinalsOnly: true }, 3, 8, 'Faces (cardinals)');
const kindsArr_loop = node('getNeighborsAttrByIndexes', { attributeId: ATTR_KIND }, 4, 6, 'kinds[4]');
vEdge(niArr_loop, 'indexes', kindsArr_loop, 'indexes');
const farKindsArr_loop = node('getNeighborsAttrByIndexes', { attributeId: ATTR_KIND }, 4, 7, 'farKinds[4]');
vEdge(niArr2_loop, 'indexes', farKindsArr_loop, 'indexes');

const forEachDirs = node('forEachInArray', {}, 4, 9, 'For each direction d');
vEdge(niArr_loop, 'indexes', forEachDirs, 'array');
fEdge(condBreak, 'then', forEachDirs, 'do');

const kind_d = node('arrayElement', {}, 5, 6, 'kind[d]');
vEdge(kindsArr_loop, 'values', kind_d, 'array');
vEdge(forEachDirs, 'index', kind_d, 'position');

const myFace_d = node('arrayElement', {}, 5, 7, 'myFace[d]');
vEdge(allFaces_loop, 'myFaceLabels', myFace_d, 'array');
vEdge(forEachDirs, 'index', myFace_d, 'position');

const farKind_d = node('arrayElement', {}, 5, 8, 'farKind[d]');
vEdge(farKindsArr_loop, 'values', farKind_d, 'array');
vEdge(forEachDirs, 'index', farKind_d, 'position');

// farKind → face-label proxy. Tag constants live LOCAL to their comparisons.
const tagAmphi_loop = tagConst('amphi', 6, 8, ATTR_KIND, KIND_OPTIONS);
const isFarAmphi = node('statement', { operation: '==' }, 7, 8, 'far==amphi');
vEdge(farKind_d, 'value', isFarAmphi, 'x');
vEdge(tagAmphi_loop, 'value', isFarAmphi, 'y');

const tagWater_loop = tagConst('water', 6, 9, ATTR_KIND, KIND_OPTIONS);
const isFarWater = node('statement', { operation: '==' }, 7, 9, 'far==water');
vEdge(farKind_d, 'value', isFarWater, 'x');
vEdge(tagWater_loop, 'value', isFarWater, 'y');

// Face-label constants — reorder-safe references to the variegated face-label
// list. GetConstant.faceLabel resolves NAME → integer index at compile time
// (none=0, X=1, Y=2, water=3 in this model), so renaming or reordering the
// face-label list in Properties doesn't silently break the chain.
const faceX     = node('getConstant', { constType: 'faceLabel', constValue: 'X' },     6, 7, 'Face: X');
const faceWater = node('getConstant', { constType: 'faceLabel', constValue: 'water' }, 6, 10, 'Face: water');
const faceNone  = node('getConstant', { constType: 'faceLabel', constValue: 'none' },  7, 10, 'Face: none');

const farLabelWaterElse = node('valueSwitch', {}, 8, 9, 'water?WATER:NONE');
vEdge(isFarWater, 'result', farLabelWaterElse, 'condition');
vEdge(faceWater, 'value', farLabelWaterElse, 'ifValue');
vEdge(faceNone, 'value', farLabelWaterElse, 'elseValue');

const farLabel_d = node('valueSwitch', {}, 8, 8, 'amphi?X:above');
vEdge(isFarAmphi, 'result', farLabel_d, 'condition');
vEdge(faceX, 'value', farLabel_d, 'ifValue');
vEdge(farLabelWaterElse, 'result', farLabel_d, 'elseValue');

const j_d = node('lookupInteraction', { tableId: ATTR_J }, 9, 7, 'J(myFace, farLabel)');
vEdge(myFace_d, 'value', j_d, 'labelA');
vEdge(farLabel_d, 'result', j_d, 'labelB');

const tagEmpty_loop = tagConst('empty', 6, 6, ATTR_KIND, KIND_OPTIONS);
const isAdjEmpty = node('statement', { operation: '==' }, 7, 6, 'kind[d]==empty');
vEdge(kind_d, 'value', isAdjEmpty, 'x');
vEdge(tagEmpty_loop, 'value', isAdjEmpty, 'y');

const wt_d = node('valueSwitch', { _port_elseValue: '0' }, 10, 7, 'weight[d]=empty?J:0');
vEdge(isAdjEmpty, 'result', wt_d, 'condition');
vEdge(j_d, 'value', wt_d, 'ifValue');

const setWeight = node('setArrayElement', {
  variableId: 'weights',
}, 11, 9, 'weights[d] ← wt_d');
fEdge(forEachDirs, 'body', setWeight, 'do');
vEdge(forEachDirs, 'index', setWeight, 'index');
vEdge(wt_d, 'result', setWeight, 'value');

// ─── Gate 3: any direction available? (cols 7-9, rows 1-3) ────────────────
// Pure TOPOLOGY question: "does at least one cardinal neighbour have
// kind==empty?". Computed via a single groupStatement.hasA on the cell's
// 4 cardinal kinds[] — independent of the joining weights (the previous
// `sumW > 0` gate accidentally rejected the move when every empty
// neighbour happened to have J(myFace, farLabel)=0, even though the move
// is still topologically valid). Wire the `condBreak.then → condCanMove`
// edge HERE — AFTER the forEach's `do` edge was added — so compileFlowChain
// processes the loop before the gate.
fEdge(condBreak, 'then', condCanMove, 'check');
const niArr_gate = node('getAllNeighborIndexes', { neighborhoodId: NBR_VN }, 7, 1, 'NIs vN');
const kindsArr_gate = node('getNeighborsAttrByIndexes', { attributeId: ATTR_KIND }, 7, 2, 'kinds[4]');
vEdge(niArr_gate, 'indexes', kindsArr_gate, 'indexes');
const tagEmpty_gate = tagConst('empty', 7, 3, ATTR_KIND, KIND_OPTIONS);
const hasEmptyDir = node('groupStatement', { operation: 'hasA' }, 9, 2, 'hasA(empty)?');
vEdge(kindsArr_gate, 'values', hasEmptyDir, 'values');
vEdge(tagEmpty_gate, 'value', hasEmptyDir, 'x');
vEdge(hasEmptyDir, 'result', condCanMove, 'condition');

// ─── moveSelf inputs (cols 9-11, rows 0-2) ────────────────────────────────
// Sample a direction proportional to weights, look up its NI, move. All
// moveSelf feeders sit to the LEFT of moveSelf (col 12) so their outputs
// flow RIGHT into moveSelf's left-side input handles — no same-column
// loop-around edges (which can hide behind the node body and visually
// orphan the source).
const weightsRead_pick = node('getVariable', { variableId: 'weights' }, 9, 1, 'weights[]');
const chosenSamp = node('groupOperator', { operation: 'weightedRandom' }, 10, 0, 'Pick direction');
vEdge(weightsRead_pick, 'value', chosenSamp, 'values');
const niArr_pick = node('getAllNeighborIndexes', { neighborhoodId: NBR_VN }, 10, 1, 'NIs vN');
const chosenNI = node('arrayElement', {}, 11, 0, 'NI of chosen dir');
vEdge(niArr_pick, 'indexes', chosenNI, 'array');
vEdge(chosenSamp, 'index', chosenNI, 'position');

// Move: Copy To the chosen empty neighbour, resetting self to defaults (the
// vacancy). The node reads the attributes directly from the cells, so it
// transfers MY kind + MY CURRENT orientation (includeOrientation) — not the
// post-rotation orientation. Carrying the rotated orientation would mean the
// destination sees a face that didn't drive the move decision; rotation is
// deferred to the rotation pass below.
const moveSelf = node('moveSelfToNeighbor', {
  payloadCount: 1,
  attr_0: ATTR_KIND,
  operation: 'copyTo',
  nonReceiving: 'defaults',
  includeOrientation: true,
}, 12, 0, 'Move self → NI');
fEdge(condCanMove, 'then', moveSelf, 'do');
vEdge(chosenNI, 'value', moveSelf, 'targetNI');

// =============================================================================
// ROTATION PASS — book §2.3.9
// =============================================================================
// "Free cells rotate during every iteration" — gate fires only for amphi cells
// whose 4 cardinals are all empty (book §2.3.9). Independent flow root off
// stepNode; runs every step regardless of whether the cell moved. If a free
// amphi happened to move this step, the rotation applies at the (now-empty)
// SOURCE cell — a no-op for the destination cell which already received the
// pre-rotation orientation via moveSelf. Sits right below the rotation values
// cluster so the gate + apply share the same column span as their inputs
// (rotGateAnd at col 15, newOri at col 14).
const rotRow = 14;

const condRotate = node('conditional', {}, 14, rotRow, 'If amphi+free');
fEdge(stepNode, 'do', condRotate, 'check');
vEdge(rotGateAnd, 'result', condRotate, 'condition');

const setRotOri = node('setOrientation', { _port_value: '0' }, 15, rotRow, 'Apply rotation');
fEdge(condRotate, 'then', setRotOri, 'do');
vEdge(newOri, 'result', setRotOri, 'value');

// =============================================================================
// INIT EVENT — per cell, on Reset
// =============================================================================
// Draw uniform [0, 1]: < densAmphi → amphi (with random orientation), else
// < densAmphi + densWater → water, else empty.
const initRow = 16;
const initNode = node('initEvent', {}, 0, initRow);

const densAmphiAttr = node('getModelAttribute', {
  attributeId: ATTR_DENS_AMPHI, isColorAttr: false,
}, 1, initRow, 'densAmphi');
const densWaterAttr = node('getModelAttribute', {
  attributeId: ATTR_DENS_WATER, isColorAttr: false,
}, 1, initRow + 1, 'densWater');

const seedRandU = node('getRandom', { randomType: 'float', min: '0', max: '1' }, 2, initRow, 'rand [0,1)');

const isAmphiSeed = node('statement', { operation: '<' }, 3, initRow, 'r < densAmphi?');
vEdge(seedRandU, 'value', isAmphiSeed, 'x');
vEdge(densAmphiAttr, 'value', isAmphiSeed, 'y');

const condAmphiSeed = node('conditional', {}, 4, initRow, 'If amphi');
fEdge(initNode, 'do', condAmphiSeed, 'check');
vEdge(isAmphiSeed, 'result', condAmphiSeed, 'condition');

const setKindAmphiInit = node('setAttribute', {
  attributeId: ATTR_KIND, _port_value: String(KIND_OPTIONS.indexOf('amphi')),
}, 5, initRow, 'Kind ← amphi');
fEdge(condAmphiSeed, 'then', setKindAmphiInit, 'do');

const amphiPlusWater = exprNode('a + b', ['a', 'b'], 3, initRow + 2, 'densAmphi+densWater');
vEdge(densAmphiAttr, 'value', amphiPlusWater, 'a');
vEdge(densWaterAttr, 'value', amphiPlusWater, 'b');

const isWaterSeed = node('statement', { operation: '<' }, 4, initRow + 2, 'r < total?');
vEdge(seedRandU, 'value', isWaterSeed, 'x');
vEdge(amphiPlusWater, 'result', isWaterSeed, 'y');

const condWaterSeed = node('conditional', {}, 5, initRow + 2, 'If water');
fEdge(condAmphiSeed, 'else', condWaterSeed, 'check');
vEdge(isWaterSeed, 'result', condWaterSeed, 'condition');

const setKindWaterInit = node('setAttribute', {
  attributeId: ATTR_KIND, _port_value: String(KIND_OPTIONS.indexOf('water')),
}, 6, initRow + 2, 'Kind ← water');
fEdge(condWaterSeed, 'then', setKindWaterInit, 'do');

const randomOriInit = node('getRandom', { randomType: 'orientation' }, 1, initRow + 4, 'Random init ori');
const setOriInit = node('setOrientation', { _port_value: '0' }, 2, initRow + 4, 'Apply init ori');
fEdge(initNode, 'do', setOriInit, 'do');
vEdge(randomOriInit, 'value', setOriInit, 'value');

// =============================================================================
// INPUT MAPPING — paint amphi at cursor
// =============================================================================
const seedRow = 24;
const seedInput = node('inputColor', { mappingId: MAPPING_SEED }, 0, seedRow);
const seedKind = node('setAttribute', {
  attributeId: ATTR_KIND, _port_value: String(KIND_OPTIONS.indexOf('amphi')),
}, 1, seedRow, 'Brush ← amphi');
fEdge(seedInput, 'do', seedKind, 'do');

const seedRand = node('getRandom', { randomType: 'orientation' }, 1, seedRow + 2, 'Brush random ori');
const seedOri = node('setOrientation', { _port_value: '0' }, 2, seedRow + 2, 'Brush apply ori');
fEdge(seedInput, 'do', seedOri, 'do');
vEdge(seedRand, 'value', seedOri, 'value');

// =============================================================================
// OUTPUT MAPPING — viz
// =============================================================================
// Tag-mode switch on kind for empty/water/amphi; amphi case fans out to an
// integer-mode switch on orientation (orientations are 0..3, not tag-named).
const vizRow = 30;
const vizOutput = node('outputMapping', { mappingId: MAPPING_VIZ }, 0, vizRow);
const vizKind = node('getCellAttribute', { attributeId: ATTR_KIND }, 0, vizRow + 1);
const vizOri = node('getOrientation', {}, 0, vizRow + 2);

const kindSwitch = node('switch', {
  mode: 'value',
  firstMatchOnly: true,
  caseCount: 3,
  valueType: 'tag',
  tagAttributeId: ATTR_KIND,
  case_0_value: String(KIND_OPTIONS.indexOf('empty')),
  case_1_value: String(KIND_OPTIONS.indexOf('water')),
  case_2_value: String(KIND_OPTIONS.indexOf('amphi')),
}, 2, vizRow, 'Switch on kind');
fEdge(vizOutput, 'do', kindSwitch, 'check');
vEdge(vizKind, 'value', kindSwitch, 'value');

const emptyColor = node('setColorViewer', {
  mappingId: MAPPING_VIZ,
  _port_r: '15', _port_g: '15', _port_b: '25',
}, 4, vizRow, 'Empty (near-black)');
fEdge(kindSwitch, 'case_0', emptyColor, 'do');

const waterColor = node('setColorViewer', {
  mappingId: MAPPING_VIZ,
  _port_r: '40', _port_g: '90', _port_b: '180',
}, 4, vizRow + 1, 'Water (blue)');
fEdge(kindSwitch, 'case_1', waterColor, 'do');

const oriSwitch = node('switch', {
  mode: 'value',
  firstMatchOnly: true,
  caseCount: 4,
  valueType: 'integer',
  case_0_op: '==', _port_case_0_val: '0',
  case_1_op: '==', _port_case_1_val: '1',
  case_2_op: '==', _port_case_2_val: '2',
  case_3_op: '==', _port_case_3_val: '3',
}, 4, vizRow + 2, 'Switch on orientation');
fEdge(kindSwitch, 'case_2', oriSwitch, 'check');
vEdge(vizOri, 'value', oriSwitch, 'value');

const oriColors = [
  { label: 'Head E → red',    r: '230', g: '60',  b: '60'  },
  { label: 'Head S → orange', r: '240', g: '160', b: '40'  },
  { label: 'Head W → green',  r: '60',  g: '200', b: '90'  },
  { label: 'Head N → cyan',   r: '60',  g: '200', b: '220' },
];
const oriColorNodes = [];
oriColors.forEach((c, i) => {
  const cv = node('setColorViewer', {
    mappingId: MAPPING_VIZ,
    _port_r: c.r, _port_g: c.g, _port_b: c.b,
  }, 6, vizRow + 2 + i, c.label);
  fEdge(oriSwitch, `case_${i}`, cv, 'do');
  oriColorNodes.push(cv);
});

// =============================================================================
// GROUP WRAPPERS — visual scoping for the top-level graph layout (Tier-A.1)
// =============================================================================
// Groups in saved .gcaproj files are free-floating area markers — children
// keep their absolute positions and don't carry parentId references (see
// `GraphEditor.tsx` toRFNodes for the defensive parentId scrub). Wrapping
// well-separated zones in groups lets the top-level layout read as
// "[shared reads] → [4 direction bundles] → [aggregate / sample] → [move]
// + [rotation pass] + [init] + [brush] + [viz]" instead of a dense node soup.
//
// Per-direction groups get distinct labels (N / E / S / W) so the eye can
// jump directly to a specific direction's logic. Non-direction groups
// describe the algorithmic role they play.

// Top gating chain — the main rule's sequential gates with their
// value-input chains. Each gate's accessors live directly below it.
groupNode(
  'Gating chain → move (occupied? → broke bonds? → has empty dir? → move)',
  [
    condOccupied, condBreak, condCanMove, moveSelf,
    kindRead_occ, tagEmpty_occ, isSelfOccupied,
    allFaces_bond, pbsArr, pBreakAgg, rollBreak,
    niArr_gate, kindsArr_gate, tagEmpty_gate, hasEmptyDir,
    weightsRead_pick, chosenSamp, niArr_pick, chosenNI,
  ],
  '#4a6858',
);

// Per-direction loop body — wraps the ForEachInArray loop and its body
// nodes into a single visual block. The runtime visits N/E/S/W in turn,
// but the GRAPH expresses it ONCE.
groupNode(
  'Per-direction body (runs for d ∈ {N, E, S, W})',
  [
    niArr_loop, niArr2_loop, allFaces_loop, kindsArr_loop, farKindsArr_loop,
    forEachDirs, kind_d, myFace_d, farKind_d,
    tagAmphi_loop, tagWater_loop, tagEmpty_loop,
    isFarAmphi, isFarWater,
    faceX, faceWater, faceNone, farLabelWaterElse, farLabel_d,
    j_d, isAdjEmpty, wt_d, setWeight,
  ],
  '#4a5878',
);

// Rotation values (feed the rotation pass below).
groupNode(
  'Rotation values (newOri + amphi-AND-free gate)',
  [
    kindRead_rot, tagAmphi_rot, isSelfAmphi,
    niArr_rot, kindsArr_rot, tagEmpty_rot, isAllEmpty,
    rotGateAnd,
    oriRead_rot, rotStepRand, newOri,
  ],
  '#705038',
);

// Rotation pass (the secondary flow root — applies rotation to non-moving free amphis).
groupNode(
  'Rotation pass (book §2.3.9)',
  [condRotate, setRotOri],
  '#785a4a',
);

// Init Event (per cell on Reset)
groupNode(
  'Init Event — seed random water / amphi by density',
  [
    initNode, densAmphiAttr, densWaterAttr, seedRandU,
    isAmphiSeed, condAmphiSeed, setKindAmphiInit,
    amphiPlusWater, isWaterSeed, condWaterSeed, setKindWaterInit,
    randomOriInit, setOriInit,
  ],
  '#406870',
);

// Input mapping (brush)
groupNode(
  'Brush — paint amphi at cursor (random orientation)',
  [seedInput, seedKind, seedRand, seedOri],
  '#604070',
);

// Visualization
groupNode(
  'Visualization — colour by kind + amphi orientation',
  [vizOutput, vizKind, vizOri, kindSwitch, emptyColor, waterColor, oriSwitch, ...oriColorNodes],
  '#586870',
);

// =============================================================================
// MODEL DEFINITION (non-graph parts)
// =============================================================================
const properties = {
  // Authored creation date — the Models Library card stamp + Newest/Oldest sort.
  createdDate: '2026-05-17',
  name: 'Amphiphile micelle formation (Kier book Example 5.3)',
  author: 'GenesisCA',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'Faithful implementation of Kier, Seybold & Cheng (2005), "Modeling ' +
    'Chemical Systems Using Cellular Automata", Example 5.3 (pp. 85-86). ' +
    'A 3-species CA (empty / water / amphi) on a 40×40 torus, with amphis ' +
    'carrying an X-X-X-Y face pattern (3 hydrophobic body + 1 hydrophilic ' +
    'head). Per step, every non-empty cell picks one of its 4 cardinal ' +
    'directions weighted by the joining probability J toward the far cell ' +
    '2 steps ahead, gated by the bond-break probability P_B = Π P_B(myFace, ' +
    'theirFace) over all bordering ingredients. The cell moves INTO the ' +
    'chosen empty direction (book §2.3.4) — leaving exactly one empty cell ' +
    'at the source, so cell counts and the empty distribution stay uniform. ' +
    '"Free" amphis (all 4 cardinals empty) additionally rotate by a uniform ' +
    'random 1..3 step every iteration (book §2.3.9). Over a few hundred ' +
    'generations, tails (X) cluster together (P_B(X,X)=0.20) while heads ' +
    '(Y) seek water (P_B(Y,water)=0.20) and J(Y,water)=2.0) — the classic ' +
    'surfactant micelle signature. Paint with the "Seed" brush to add ' +
    'amphis at the cursor.',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'asynchronous',
  asyncScheme: 'random-order',
  gridWidth: 40,
  gridHeight: 40,
  maxIterations: 100000,
  tags: ['variegated cells', 'chemistry', 'self-organization', 'amphiphile', 'surfactant', 'micelle', 'movement', 'kier'],
  useWasm: true,
  useWebGPU: false,
};

const attributes = [
  {
    id: ATTR_KIND, name: 'Kind', type: 'tag',
    description:
      'Cell species. Empty cells are unoccupied vacancies (face: none). ' +
      'Water cells are the bulk solvent (face: water on all sides). Amphi ' +
      'cells carry the X-X-X-Y face pattern + orientation.',
    isModelAttribute: false, defaultValue: String(KIND_OPTIONS.indexOf('empty')),
    tagOptions: KIND_OPTIONS,
    facePatternAssignments: { water: PAT_WATER, amphi: PAT_AMPHI },
  },
  {
    id: ATTR_DENS_AMPHI, name: 'Initial amphi density', type: 'float',
    description:
      'Fraction of cells seeded as amphi on Reset. Book default 0.0625 ' +
      '(= 100/1600).',
    isModelAttribute: true, defaultValue: '0.0625', hasBounds: true, min: 0, max: 1,
  },
  {
    id: ATTR_DENS_WATER, name: 'Initial water density', type: 'float',
    description:
      'Fraction of cells seeded as water on Reset (book default 0.625 = ' +
      '1000/1600). The remainder are empty (~31% at the book defaults — the ' +
      'empties are the vacancies that amphis migrate into).',
    isModelAttribute: true, defaultValue: '0.625', hasBounds: true, min: 0, max: 1,
  },
  {
    id: ATTR_PB, name: 'P_B (bond-break, adjacent)', type: 'lookupTable',
    description:
      'Probability of breaking the bond between two adjacent cells (= the ' +
      'cell becoming able to move away from this neighbour). LOW = stable ' +
      '(stays together), HIGH = easily separates. Book Example 5.3 values ' +
      '(page 86): WW 0.25, XX 0.20, YY 0.50, XY 0.50, WX 0.80, WY 0.20. The ' +
      '`none` row/column is 1.0 (no bond to break — book §2.3.6).',
    isModelAttribute: true, defaultValue: '0',
    rowKeySource: { kind: 'facePalette', paletteId: PALETTE_FACES },
    colKeySource: { kind: 'facePalette', paletteId: PALETTE_FACES },
    symmetric: true,
    tableValues: {
      'none':  { 'none': 1,    'X': 1,    'Y': 1,    'water': 1    },
      'X':     { 'none': 1,    'X': 0.20, 'Y': 0.50, 'water': 0.80 },
      'Y':     { 'none': 1,    'X': 0.50, 'Y': 0.50, 'water': 0.20 },
      'water': { 'none': 1,    'X': 0.80, 'Y': 0.20, 'water': 0.25 },
    },
  },
  {
    id: ATTR_J, name: 'J (joining, toward far)', type: 'lookupTable',
    description:
      'Directional preference: J(A, B) is the relative probability that A ' +
      'will move TOWARD a face B sitting two cells ahead in that direction. ' +
      'J = 1 is neutral (book §2.3.5); J > 1 attracts, J < 1 repels. Book ' +
      'Example 5.3 values (page 86): WW 1.70, XX 2.00, YY 0.70, XY 0.70, ' +
      'WX 0.25, WY 2.00. The `none` row/column is 1.0 (no preference toward ' +
      'or away from an absent ingredient — book §2.3.5 verbatim).',
    isModelAttribute: true, defaultValue: '0',
    rowKeySource: { kind: 'facePalette', paletteId: PALETTE_FACES },
    colKeySource: { kind: 'facePalette', paletteId: PALETTE_FACES },
    symmetric: true,
    tableValues: {
      'none':  { 'none': 1,    'X': 1,    'Y': 1,    'water': 1    },
      'X':     { 'none': 1,    'X': 2.00, 'Y': 0.70, 'water': 0.25 },
      'Y':     { 'none': 1,    'X': 0.70, 'Y': 0.70, 'water': 2.00 },
      'water': { 'none': 1,    'X': 0.25, 'Y': 2.00, 'water': 1.70 },
    },
  },
];

const neighborhoods = [
  {
    id: NBR_VN, name: 'Von Neumann (N/E/S/W)',
    description:
      '4 cardinal direct neighbours, ordered N → E → S → W to match the ' +
      'cardinal slots of Get All Facing Labels (slot = direction × 2).',
    coords: [[-1, 0], [0, 1], [1, 0], [0, -1]],
    tags: { 0: 'N', 1: 'E', 2: 'S', 3: 'W' },
  },
  {
    id: NBR_VN2, name: 'Von Neumann ×2 (far N/E/S/W)',
    description:
      '4 cardinal far-neighbours (2 cells away), same N/E/S/W ordering as ' +
      'vN. Used by the J(myFace, farFace) joining-probability lookup.',
    coords: [[-2, 0], [0, 2], [2, 0], [0, -2]],
    tags: { 0: 'N', 1: 'E', 2: 'S', 3: 'W' },
  },
];

const mappings = [
  {
    id: MAPPING_SEED, name: 'Seed amphi', isAttributeToColor: false,
    description: 'Paint to drop amphi molecules at the cursor (with random initial orientation). Painted colour is ignored.',
    redDescription: 'Ignored', greenDescription: 'Ignored', blueDescription: 'Ignored',
  },
  {
    id: MAPPING_VIZ, name: 'Species + Orientation', isAttributeToColor: true,
    description: 'Empty cells render near-black, water cells blue, amphi cells in a 4-colour palette by head direction (E→red, S→orange, W→green, N→cyan).',
    redDescription: 'empty=15, water=40, amphi by orientation',
    greenDescription: 'empty=15, water=90, amphi by orientation',
    blueDescription: 'empty=25, water=180, amphi by orientation',
  },
];

const variegatedCells = {
  enabled: true,
  sourceAttributeId: ATTR_KIND,
  facePalettes: [{ id: PALETTE_FACES, name: 'Faces', labels: FACE_LABELS }],
  facePatterns: [
    {
      id: PAT_WATER, name: 'Water (all-water)',
      paletteId: PALETTE_FACES,
      layoutMode: 'edges',
      faces: ['water', null, 'water', null, 'water', null, 'water', null],
    },
    {
      id: PAT_AMPHI, name: 'Amphiphile (X-X-X-Y)',
      paletteId: PALETTE_FACES,
      layoutMode: 'edges',
      faces: ['X', null, 'Y', null, 'X', null, 'X', null],
    },
  ],
};

// =============================================================================
// PRESETS — Book Example 5.3 + the 8 parameter sets from Kier 1996 Table I
// =============================================================================
// Mapping note: the 1996 paper labels its hydrophobic sector A_y (3 faces) and
// hydrophilic sector A_x (1 face) — the OPPOSITE of common chemistry naming.
// I keep the conventional labels: X = hydrophobic tail (3 faces), Y =
// hydrophilic head (1 face). So paper's `A_y` → my `X`, paper's `A_x` → my `Y`.
//
// Paper Table I varies six values per set: P_B and J for {X-X, W-Y, Y-Y}.
// Paper footnote (a) fixes six others: P_B(W-W)=0.25, J(W-W)=1.0,
// P_B(W-X)=0.9, J(W-X)=0.25, P_B(X-Y)=0.9, J(X-Y)=0.25.
// The book's Example 5.3 uses different fixed values (notably J(W-W)=1.70 and
// less-extreme W-X / X-Y break/joining values) — included as its own preset
// so users can directly compare "book defaults" against the paper's optimal
// set (Set 1 has the largest reported S_y = 3.7).
//
// Stored as ids ⊂ rowLabels ⊂ colLabels → float. The `none` row/column is
// pre-populated with 1.0 (book §2.3.5 + §2.3.6 — neutral defaults for the
// implicit empty-face label).
function buildAmphiphileTables(p) {
  return {
    [ATTR_PB]: {
      'none':  { 'none': 1, 'X': 1,      'Y': 1,      'water': 1      },
      'X':     { 'none': 1, 'X': p.pbXX, 'Y': p.pbXY, 'water': p.pbWX },
      'Y':     { 'none': 1, 'X': p.pbXY, 'Y': p.pbYY, 'water': p.pbWY },
      'water': { 'none': 1, 'X': p.pbWX, 'Y': p.pbWY, 'water': p.pbWW },
    },
    [ATTR_J]: {
      'none':  { 'none': 1, 'X': 1,     'Y': 1,     'water': 1     },
      'X':     { 'none': 1, 'X': p.jXX, 'Y': p.jXY, 'water': p.jWX },
      'Y':     { 'none': 1, 'X': p.jXY, 'Y': p.jYY, 'water': p.jWY },
      'water': { 'none': 1, 'X': p.jWX, 'Y': p.jWY, 'water': p.jWW },
    },
  };
}

// Paper Table I fixed values (footnote a)
const PAPER_FIXED = {
  pbWW: 0.25, jWW: 1.0,
  pbWX: 0.9,  jWX: 0.25,
  pbXY: 0.9,  jXY: 0.25,
};

const presetSpecs = [
  {
    name: 'Book — Example 5.3 defaults',
    description:
      'Kier, Seybold & Cheng (2005), Example 5.3 page 86 — the parameter ' +
      'set the book uses for its micelle-formation demonstration. Produces ' +
      'moderate micelles. NOT identical to any paper Table I set: notably ' +
      'J(W-W) = 1.70 (paper uses 1.0) and J(W-Y) = 2.0 / P_B(W-Y) = 0.20 ' +
      '(very polar head — the paper notes a *modestly* polar head gives ' +
      'larger micelles, so this is intentionally a sub-optimal demo).',
    pbXX: 0.20, jXX: 2.00, pbWY: 0.20, jWY: 2.00, pbYY: 0.50, jYY: 0.70,
    pbWW: 0.25, jWW: 1.70, pbWX: 0.80, jWX: 0.25, pbXY: 0.50, jXY: 0.70,
  },
  {
    name: 'Paper — Set 1 (S_y=3.7, strongest)',
    description:
      'Kier 1996 Table I row 1 — strongest reported micelle formation ' +
      '(average cluster size S_y = 3.7). Very hydrophobic tail ' +
      '(P_B(X-X)=0.1, J(X-X)=4.0) + modestly polar head (P_B(W-Y)=0.7).',
    pbXX: 0.1, jXX: 4.0, pbWY: 0.7, jWY: 0.5, pbYY: 0.3, jYY: 1.0,
    ...PAPER_FIXED,
  },
  {
    name: 'Paper — Set 2 (S_y=3.4)',
    description:
      'Kier 1996 Table I row 2. Differs from Set 1 in P_B(Y-Y) (0.5 vs 0.3) ' +
      'and J(W-Y) (0.6 vs 0.5). Y self-association reduces micelle size.',
    pbXX: 0.1, jXX: 4.0, pbWY: 0.7, jWY: 0.6, pbYY: 0.5, jYY: 1.0,
    ...PAPER_FIXED,
  },
  {
    name: 'Paper — Set 3 (S_y=2.7)',
    description:
      'Kier 1996 Table I row 3. Very polar head (P_B(W-Y)=0.2) + strong ' +
      'tail-tail (P_B(X-X)=0.1). Smaller micelles than Set 1/2 — head loves ' +
      'water too much, so amphis prefer to disperse over forming clusters.',
    pbXX: 0.1, jXX: 4.0, pbWY: 0.2, jWY: 1.0, pbYY: 0.6, jYY: 0.5,
    ...PAPER_FIXED,
  },
  {
    name: 'Paper — Set 4 (S_y=2.3)',
    description:
      'Kier 1996 Table I row 4. Same head as Set 3 (very polar, P_B(W-Y)=0.2) ' +
      'with weaker Y-Y self-association (P_B(Y-Y)=0.3).',
    pbXX: 0.1, jXX: 4.0, pbWY: 0.2, jWY: 1.0, pbYY: 0.3, jYY: 1.0,
    ...PAPER_FIXED,
  },
  {
    name: 'Paper — Set 5 (S_y=1.6)',
    description:
      'Kier 1996 Table I row 5. Weaker tail-tail bond (P_B(X-X)=0.3, ' +
      'J(X-X)=1.0) + modestly polar head. Small micelles (~CMC threshold).',
    pbXX: 0.3, jXX: 1.0, pbWY: 0.7, jWY: 0.5, pbYY: 0.3, jYY: 1.0,
    ...PAPER_FIXED,
  },
  {
    name: 'Paper — Set 6 (S_y=1.5)',
    description:
      'Kier 1996 Table I row 6. Same as Set 5 but with stronger Y-Y ' +
      '(P_B(Y-Y)=0.6, J(Y-Y)=0.5).',
    pbXX: 0.3, jXX: 1.0, pbWY: 0.7, jWY: 0.5, pbYY: 0.6, jYY: 0.5,
    ...PAPER_FIXED,
  },
  {
    name: 'Paper — Set 7 (S_y=1.5)',
    description:
      'Kier 1996 Table I row 7. Very polar head + weak tail-tail. Small ' +
      'micelles — head-water affinity dominates.',
    pbXX: 0.3, jXX: 1.0, pbWY: 0.2, jWY: 1.0, pbYY: 0.3, jYY: 1.0,
    ...PAPER_FIXED,
  },
  {
    name: 'Paper — Set 8 (S_y=1.5, weakest)',
    description:
      'Kier 1996 Table I row 8 — weakest micelles. Very polar head + weak ' +
      'tail-tail + strong Y-Y. No incentive for amphis to cluster.',
    pbXX: 0.3, jXX: 1.0, pbWY: 0.2, jWY: 1.0, pbYY: 0.6, jYY: 0.5,
    ...PAPER_FIXED,
  },
];

// Stable, deterministic timestamps so re-running the generator doesn't churn
// the file just because the wall clock advanced. Year/index encoded in seconds
// since epoch — picked arbitrarily, only matters relatively (preset list is
// sorted by createdAt in the UI).
const PRESET_BASE_TIMESTAMP = 1747000000000;
const presets = presetSpecs.map((spec, i) => ({
  id: newId('preset_'),
  name: spec.name,
  description: spec.description,
  state: {
    schemaVersion: 2,
    interactionTables: buildAmphiphileTables(spec),
  },
  createdAt: PRESET_BASE_TIMESTAMP + i * 1000,
}));

// =============================================================================
// ASSEMBLE & WRITE
// =============================================================================
const model = {
  schemaVersion: 2,
  properties,
  attributes,
  neighborhoods,
  mappings,
  indicators: [],
  // Tier D.4: per-cell scratch storage for the direction sampler. The
  // ForEachInArray loop body writes weights[d] for each cardinal direction;
  // groupOperator.weightedRandom + Aggregate.sum read it after the loop.
  variables: [
    {
      id: 'weights',
      name: 'weights',
      description: 'Per-direction joining weights wt_d = (kind_d == empty) ? J(myFace_d, farLabel_d) : 0',
      kind: 'array',
      dataType: 'float',
      length: 4,
      initialValue: '0',
    },
  ],
  graphNodes,
  graphEdges,
  macroDefs: [],
  presets,
  variegatedCells,
};

mkdirSync(dirname(OUT), { recursive: true });

let preserved = '';
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
    if (prev.simulationState) {
      model.simulationState = prev.simulationState;
      preserved += ' +simulationState';
    }
    if (prev.properties?.thumbnail) {
      model.properties.thumbnail = prev.properties.thumbnail;
      preserved += ' +thumbnail';
    }
  } catch { /* unreadable / older format — write fresh */ }
}

writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf-8');
console.log(
  `Wrote ${OUT}\n  ${graphNodes.length} nodes, ${graphEdges.length} edges, ` +
  `${attributes.length} attributes, ${neighborhoods.length} neighborhoods, ` +
  `${mappings.length} mappings, ${variegatedCells.facePatterns.length} face patterns, ` +
  `${variegatedCells.facePalettes.reduce((n, p) => n + p.labels.length, 0)} face labels${preserved}`,
);
