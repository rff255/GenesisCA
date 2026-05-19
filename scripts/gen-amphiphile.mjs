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
 *     6. Move atomically: write C's (kind, ori) to the cell at NI_{d*};
 *        set C's kind to empty + orientation to 0. The reads in step 1 are
 *        captured into JS / WASM / WGSL `const` locals before any flow write
 *        fires (SSA discipline, per CLAUDE.md), so the four writes see the
 *        pre-move snapshot — atomicity comes for free without any new
 *        compiler primitive. Crucially, ONE empty cell is created at the
 *        source, so empties stay uniformly distributed by construction (no
 *        asymmetric-mobility artefact that destroyed earlier swap-based
 *        attempts).
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

// TagConstant emits a fixed tag value (stored as its index). Lets the graph
// reference kinds by NAME (the UI renders "Tag: amphi") instead of hardcoded
// integers in Statement._port_y.
function tagConst(tagName, col, row, attrId, tagOptions) {
  const i = tagOptions.indexOf(tagName);
  if (i < 0) throw new Error(`unknown tag: ${tagName}`);
  return node('tagConstant', {
    attributeId: attrId, tagIndex: i,
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
// LookupInteraction's underlying tableValues row/col is indexed with `none` at
// position 0 (implicit) and user-labels starting at 1. So:
//   none=0, X=1, Y=2, water=3
const FACE_NONE = 0;
const FACE_X = 1;
const FACE_WATER = 3;

// =============================================================================
// STEP GRAPH — book-faithful move-into-empty
// =============================================================================
const stepNode = node('step', {}, 0, 0);

// --- Top reads (shared across all 4 directions; SSA-emitted at cell scope) --
const kindRead = node('getCellAttribute', { attributeId: ATTR_KIND }, 1, 1, 'My kind');
const oriRead = node('getOrientation', {}, 1, 2, 'My ori');
const niArr = node('getAllNeighborIndexes', { neighborhoodId: NBR_VN }, 1, 3, 'NIs vN');
const niArr2 = node('getAllNeighborIndexes', { neighborhoodId: NBR_VN2 }, 1, 4, 'NIs vN2 (far)');
// Tier-B.0: cardinalsOnly produces 4-slot N/E/S/W arrays instead of 8-slot
// Moore. The per-direction reads below use slot d directly (not 2*d).
const allFaces = node('getAllFacingLabels', { cardinalsOnly: true }, 1, 5, 'Facing labels[4] cardinals');
// Vectorized neighbor-kind reads. Each is one node returning a 4-element array,
// indexed per-direction below via arrayElement. Replaces 4× scalar
// getNeighborAttributeByIndex chains per neighborhood (8 nodes → 2). See
// `GetNeighborsAttrByIndexes` — it's a registered ARRAY_NODE_EMITTER on JS,
// WASM, and WebGPU, so this works on all three compile targets (the comment
// at the top of this file warning about getNeighborsAttribute does NOT apply
// to this node — different node, different compile path).
const kindsArr = node('getNeighborsAttrByIndexes', { attributeId: ATTR_KIND }, 1, 6, 'kinds[4] adj');
vEdge(niArr, 'indexes', kindsArr, 'indexes');
const farKindsArr = node('getNeighborsAttrByIndexes', { attributeId: ATTR_KIND }, 1, 7, 'farKinds[4]');
vEdge(niArr2, 'indexes', farKindsArr, 'indexes');

// --- Shared tag constants (referenced by Statements across the graph) ------
const tagEmpty = tagConst('empty', 2, 8, ATTR_KIND, KIND_OPTIONS);
const tagWater = tagConst('water', 2, 9, ATTR_KIND, KIND_OPTIONS);
const tagAmphi = tagConst('amphi', 2, 10, ATTR_KIND, KIND_OPTIONS);

// --- Per-direction factors via ForEachInArray loop (Tier D.4) ------------
// The loop body executes once per direction d ∈ {0=N, 1=E, 2=S, 3=W}, with
// the loop-counter `d` exposed via `forEachDirs.index`. Each iteration:
//   1. Reads kind_d, myFace_d, farKind_d via arrayElement[d] from the shared
//      kindsArr / allFaces / farKindsArr arrays.
//   2. Computes farLabel_d = (farKind==amphi)?X : (farKind==water)?WATER : NONE
//      via a 2× ValueSwitch chain — each switch is a direct "if predicate,
//      use Y, else use Z" semantic lookup (no arithmetic on label indices).
//   3. Computes wt_d = adj_is_empty ? J(myFace_d, farLabel_d) : 0.
//   4. Stores wt_d into the `weights` Local Variable at index d.
//
// After the loop, `weights` is a fully populated 4-element array readable
// by aggregate / groupOperator.weightedRandom downstream. Replaces 4×
// unrolled copies of the same 10-node subgraph (40 nodes) with a single
// loop instance running 4 times at runtime (~12 nodes total).
//
// Tier-B.1: P_B factors stay vectorised in `pbsArr` (single InteractionTableMap
// outside the loop) since they don't need per-direction farLabel assembly.
const pbsArr = node('interactionTableMap', { tableId: ATTR_PB }, 10, 12, 'P_B vec[4]');
vEdge(allFaces, 'myFaceLabels', pbsArr, 'myFaces');
vEdge(allFaces, 'theirFaceLabels', pbsArr, 'theirFaces');

const pBreakAgg = node('aggregate', { operation: 'product' }, 11, 12, 'P_break (Π pb_d)');
vEdge(pbsArr, 'values', pBreakAgg, 'values');

// ForEachInArray loop — iterates the 4 cardinal NIs in niArr; the body uses
// `forEachDirs.index` as the direction slot d (0..3). The flow input `do`
// fires from condBreak.then (so weights are populated only when the cell is
// occupied + broke its bonds — same gate as the move below). The array
// input is niArr, whose length 4 drives the iteration count; we don't read
// `element` (the NI itself) — the body uses `index` instead.
const forEachDirs = node('forEachInArray', {}, 3, 14, 'For each direction d');
vEdge(niArr, 'indexes', forEachDirs, 'array');

const kind_d = node('arrayElement', {}, 4, 14, 'kind[d]');
vEdge(kindsArr, 'values', kind_d, 'array');
vEdge(forEachDirs, 'index', kind_d, 'position');

const myFace_d = node('arrayElement', {}, 4, 15, 'myFace[d]');
vEdge(allFaces, 'myFaceLabels', myFace_d, 'array');
vEdge(forEachDirs, 'index', myFace_d, 'position');

const farKind_d = node('arrayElement', {}, 4, 16, 'farKind[d]');
vEdge(farKindsArr, 'values', farKind_d, 'array');
vEdge(forEachDirs, 'index', farKind_d, 'position');

const isFarAmphi = node('statement', { operation: '==' }, 5, 16, 'farKind==amphi');
vEdge(farKind_d, 'value', isFarAmphi, 'x');
vEdge(tagAmphi, 'value', isFarAmphi, 'y');

const isFarWater = node('statement', { operation: '==' }, 5, 17, 'farKind==water');
vEdge(farKind_d, 'value', isFarWater, 'x');
vEdge(tagWater, 'value', isFarWater, 'y');

const farLabelWaterElse = node('valueSwitch', {
  _port_ifValue: String(FACE_WATER),
  _port_elseValue: String(FACE_NONE),
}, 6, 16, 'farLabel: water?else none');
vEdge(isFarWater, 'result', farLabelWaterElse, 'condition');

const farLabel_d = node('valueSwitch', {
  _port_ifValue: String(FACE_X),
}, 6, 17, 'farLabel: amphi?X:above');
vEdge(isFarAmphi, 'result', farLabel_d, 'condition');
vEdge(farLabelWaterElse, 'result', farLabel_d, 'elseValue');

const j_d = node('lookupInteraction', { tableId: ATTR_J }, 7, 14, 'J(myFace, farLabel)');
vEdge(myFace_d, 'value', j_d, 'labelA');
vEdge(farLabel_d, 'result', j_d, 'labelB');

const isAdjEmpty = node('statement', { operation: '==' }, 7, 15, 'kind[d]==empty');
vEdge(kind_d, 'value', isAdjEmpty, 'x');
vEdge(tagEmpty, 'value', isAdjEmpty, 'y');

const wt_d = node('valueSwitch', { _port_elseValue: '0' }, 8, 14, 'weight[d] = empty?J:0');
vEdge(isAdjEmpty, 'result', wt_d, 'condition');
vEdge(j_d, 'value', wt_d, 'ifValue');

// Store wt_d into the `weights` Local Variable at index d.
const setWeight = node('setArrayElement', {
  variableId: 'weights',
}, 9, 14, 'weights[d] ← wt_d');
fEdge(forEachDirs, 'body', setWeight, 'do');
vEdge(forEachDirs, 'index', setWeight, 'index');
vEdge(wt_d, 'result', setWeight, 'value');

const weightsRead = node('getVariable', { variableId: 'weights' }, 10, 14, 'weights[]');

const sumWAgg = node('aggregate', { operation: 'sum' }, 11, 14, 'sumW (Σ weights)');
vEdge(weightsRead, 'value', sumWAgg, 'values');

// "All 4 cardinals are empty" via groupCounting (count where kind==empty) ==
// 4. Used by the rotation gate. Replaces the previous 4× per-direction
// `aggregate.and` over per-direction adjE booleans.
const emptyCount = node('groupCounting', {
  operation: 'equals',
}, 8, 19, 'count(kind == empty)');
vEdge(kindsArr, 'values', emptyCount, 'values');
vEdge(tagEmpty, 'value', emptyCount, 'compare');

const isAllEmpty = node('statement', { operation: '==', _port_y: '4' }, 9, 19, 'count == 4 ?');
vEdge(emptyCount, 'count', isAllEmpty, 'x');

// --- Rotation values (computed early so the move sequence can use them) ---
// See the rotation pass below for the algorithmic explanation. We compute
// `rotatedOri` here (a VALUE node, no flow yet) so writePushOri can push the
// post-rotation orientation to the destination — otherwise a free amphi that
// moves and rotates in the same step loses its rotation effect (the move
// clears the source, the rotation pass writes to that now-empty cell, and the
// destination cell keeps the pre-rotation orientation, making rotation
// invisible to the user).
const isSelfAmphi = node('statement', { operation: '==' }, 10, 21, 'My kind == amphi?');
vEdge(kindRead, 'value', isSelfAmphi, 'x');
vEdge(tagAmphi, 'value', isSelfAmphi, 'y');

// isAllEmpty: already declared above (via groupCounting + statement). Reused
// as one of the two inputs to rotGateAnd.
const rotGateAnd = node('aggregate', { operation: 'and' }, 10, 22, 'amphi AND free?');
vEdge(isSelfAmphi, 'result', rotGateAnd, 'values');
vEdge(isAllEmpty, 'result', rotGateAnd, 'values');

const rotStepRand = node('getRandom', {
  randomType: 'integer', min: '1', max: '3',
}, 10, 21, 'Rotation step 1..3');

const newOri = exprNode('mod(ori + step, 4)', ['ori', 'step'], 10, 22, 'newOri');
vEdge(oriRead, 'value', newOri, 'a');
vEdge(rotStepRand, 'value', newOri, 'b');

const rotatedOri = node('valueSwitch', {}, 10, 23, 'rotatedOri = gate ? new : ori');
vEdge(rotGateAnd, 'result', rotatedOri, 'condition');
vEdge(newOri, 'result', rotatedOri, 'ifValue');
vEdge(oriRead, 'value', rotatedOri, 'elseValue');

// --- Conditional chain: only-occupied + Bernoulli(P_break) + sumW > 0 -----
const isSelfOccupied = node('statement', { operation: '!=' }, 2, 1, 'My cell occupied?');
vEdge(kindRead, 'value', isSelfOccupied, 'x');
vEdge(tagEmpty, 'value', isSelfOccupied, 'y');

const condOccupied = node('conditional', {}, 3, 0, 'If occupied');
fEdge(stepNode, 'do', condOccupied, 'check');
vEdge(isSelfOccupied, 'result', condOccupied, 'condition');

const rollBreak = node('getRandom', { randomType: 'bool' }, 11, 14, 'Bernoulli(P_break)');
vEdge(pBreakAgg, 'result', rollBreak, 'probability');

const condBreak = node('conditional', {}, 4, 0, 'If break free');
fEdge(condOccupied, 'then', condBreak, 'check');
vEdge(rollBreak, 'value', condBreak, 'condition');

// Populate `weights` BEFORE the sumW gate fires. The forEach loop and the
// downstream condCanMove both hang off `condBreak.then` — compileFlowChain
// processes them in edge-add order, so the for-loop emits first, then the
// `if (sumPos)` gate. Same `if (rollBreak)` block contains both.
fEdge(condBreak, 'then', forEachDirs, 'do');

const sumPos = node('statement', { operation: '>' }, 11, 16, 'sumW > 0?');
vEdge(sumWAgg, 'result', sumPos, 'x');
// _port_y defaults to '0' via Statement's inline widget — no need to set.

const condCanMove = node('conditional', {}, 5, 0, 'If has empty dir');
fEdge(condBreak, 'then', condCanMove, 'check');
vEdge(sumPos, 'result', condCanMove, 'condition');

// --- Direction sampling (Tier-D.2: GroupOperator.weightedRandom) ----------
// Reads the `weights` Local Variable (populated by the ForEachInArray loop
// above) and samples one index proportional to the weights — the same shape
// as the book's `d* = sample(weights)` step.
const chosenSamp = node('groupOperator', { operation: 'weightedRandom' }, 12, 14, 'Pick direction');
vEdge(weightsRead, 'value', chosenSamp, 'values');

// chosenNI = niArr[chosenSamp.index]
const chosenNI = node('arrayElement', {}, 13, 18, 'NI of chosen dir');
vEdge(niArr, 'indexes', chosenNI, 'array');
vEdge(chosenSamp, 'index', chosenNI, 'position');

// --- Move sequence (Tier-B.3: single MoveSelfToNeighbor node) -------------
// Replaces the 5-node atomic-write sequence (sequence + setNeighborAttr +
// setNeighborOri + setAttribute + setOrientation) with one node. Payloads
// (kindRead, rotatedOri) are SSA-snapshot at cell-top before any flow write
// fires — atomicity is intrinsic to the JS / WASM compile pipeline, NOT a
// new primitive. Clear-to-defaultValue (empty kind, ori=0) is automatic.
const moveSelf = node('moveSelfToNeighbor', {
  payloadCount: 1,
  attr_0: ATTR_KIND,
  transferOrientation: true,
}, 7, 0, 'Move self → NI');
fEdge(condCanMove, 'then', moveSelf, 'do');
vEdge(chosenNI, 'value', moveSelf, 'targetNI');
vEdge(kindRead, 'value', moveSelf, 'payload_0');
// rotatedOri (NOT oriRead): so a free amphi that rotates AND moves the same
// step carries its rotation effect to the destination instead of losing it to
// the source cell that's about to be cleared. For non-free or non-amphi cells
// rotGateAnd is false, ValueSwitch returns oriRead, behaviour unchanged.
vEdge(rotatedOri, 'result', moveSelf, 'orientation');

// =============================================================================
// ROTATION PASS — book §2.3.9
// =============================================================================
// "Free cells rotate during every iteration" — gate fires only for amphi cells
// whose 4 cardinals are all empty. Defensive against the corner case where a
// free amphi doesn't move (impossible under strict book parameters since
// P_break=1 and sumW=4 for free amphi, but the gate stays here so the
// rotation rule is correctly applied regardless of move). The actual rotation
// effect on a moving free amphi is carried via `rotatedOri` consumed by the
// move sequence above; this pass only matters if the move didn't fire.
const rotRow = 26;

const condRotate = node('conditional', {}, 5, rotRow, 'If amphi+free');
fEdge(stepNode, 'do', condRotate, 'check');
vEdge(rotGateAnd, 'result', condRotate, 'condition');

const setRotOri = node('setOrientation', { _port_value: '0' }, 9, rotRow, 'Apply rotation');
fEdge(condRotate, 'then', setRotOri, 'do');
vEdge(rotatedOri, 'result', setRotOri, 'value');

// =============================================================================
// INIT EVENT — per cell, on Reset
// =============================================================================
// Draw uniform [0, 1]: < densAmphi → amphi (with random orientation), else
// < densAmphi + densWater → water, else empty.
const initRow = 36;
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
const seedRow = 44;
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
const vizRow = 50;
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

// Per-direction loop body — wraps the 9 nodes the ForEachInArray loop runs
// per iteration into a single visual block. Replaces 4× unrolled direction
// groups (Tier B + earlier) — the runtime still visits N/E/S/W in turn, but
// the GRAPH expresses it ONCE.
groupNode(
  'Per-direction body (runs for d ∈ {N, E, S, W})',
  [
    forEachDirs, kind_d, myFace_d, farKind_d,
    isFarAmphi, isFarWater, farLabelWaterElse, farLabel_d,
    j_d, isAdjEmpty, wt_d, setWeight,
  ],
  '#4a5878',
);

// Shared cell reads — the inputs every direction draws from. Lives at the
// top of the per-direction column.
groupNode(
  'Shared reads (this cell + array-of-4 neighbour kinds)',
  [kindRead, oriRead, niArr, niArr2, allFaces, kindsArr, farKindsArr],
  '#4a6858',
);

// Move sequence (atomic single MoveSelfToNeighbor node)
groupNode(
  'Move sequence (atomic push self → chosenNI, clear self)',
  [moveSelf],
  '#705038',
);

// Rotation pass (the secondary flow root)
groupNode(
  'Rotation pass (book §2.3.9 — free amphis rotate every step)',
  [condRotate, setRotOri],
  '#705038',
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
    id: ATTR_PB, name: 'P_B (bond-break, adjacent)', type: 'interactionTable',
    description:
      'Probability of breaking the bond between two adjacent cells (= the ' +
      'cell becoming able to move away from this neighbour). LOW = stable ' +
      '(stays together), HIGH = easily separates. Book Example 5.3 values ' +
      '(page 86): WW 0.25, XX 0.20, YY 0.50, XY 0.50, WX 0.80, WY 0.20. The ' +
      '`none` row/column is 1.0 (no bond to break — book §2.3.6).',
    isModelAttribute: true, defaultValue: '0',
    symmetric: true,
    tableValues: {
      'none':  { 'none': 1,    'X': 1,    'Y': 1,    'water': 1    },
      'X':     { 'none': 1,    'X': 0.20, 'Y': 0.50, 'water': 0.80 },
      'Y':     { 'none': 1,    'X': 0.50, 'Y': 0.50, 'water': 0.20 },
      'water': { 'none': 1,    'X': 0.80, 'Y': 0.20, 'water': 0.25 },
    },
  },
  {
    id: ATTR_J, name: 'J (joining, toward far)', type: 'interactionTable',
    description:
      'Directional preference: J(A, B) is the relative probability that A ' +
      'will move TOWARD a face B sitting two cells ahead in that direction. ' +
      'J = 1 is neutral (book §2.3.5); J > 1 attracts, J < 1 repels. Book ' +
      'Example 5.3 values (page 86): WW 1.70, XX 2.00, YY 0.70, XY 0.70, ' +
      'WX 0.25, WY 2.00. The `none` row/column is 1.0 (no preference toward ' +
      'or away from an absent ingredient — book §2.3.5 verbatim).',
    isModelAttribute: true, defaultValue: '0',
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
  faceLabels: FACE_LABELS,
  facePatterns: [
    {
      id: PAT_WATER, name: 'Water (all-water)',
      layoutMode: 'edges',
      faces: ['water', null, 'water', null, 'water', null, 'water', null],
    },
    {
      id: PAT_AMPHI, name: 'Amphiphile (X-X-X-Y)',
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
  `${variegatedCells.faceLabels.length} face labels${preserved}`,
);
