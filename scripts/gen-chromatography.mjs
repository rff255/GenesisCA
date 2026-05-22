#!/usr/bin/env node
/**
 * Generates public/models/Chromatography.gcaproj — the Kier, Cheng & Karnes
 * (2000) chromatography model, "A Cellular Automata Model of Chromatography",
 * Biomed. Chromatogr. 14:530-534.
 *
 * A 43x200 async CA "column" with four ingredients on a torus (the paper's
 * recirculating "cylinder"):
 *   - W  : solvent / mobile phase (~69% of cells)
 *   - B  : stationary phase (immobile; ~600 cells)
 *   - S1 : weakly-retained solute (10 cells, injected on the first row)
 *   - S2 : strongly-retained solute (10 cells, injected on the first row)
 *   - empty : vacancies (~24%) the mobile phase flows through
 *
 * Movement (Kier move-into-empty + gravity), per non-empty non-B cell, per step:
 *   1. Gate: act only if occupied AND not B (B is immobile; empty never acts).
 *   2. For each cardinal direction d (N/E/S/W):
 *        pb_d   = PB(myType, neighbourType_d)        // break factor
 *        wt_d   = (neighbour_d empty)
 *                   ? J(myType, farType_d) + (d == South ? G : 0)   // join + gravity
 *                   : 0
 *      where farType_d is the cell 2 steps away in d (extended von Neumann k).
 *   3. Bernoulli(Pi pb_d): if the roll fails, the cell is "bonded" and stays.
 *      Empty neighbours contribute PB(*, empty)=1 (no bond), so the product is
 *      over occupied neighbours only.
 *   4. If any cardinal is empty, sample a direction d* proportional to wt_d and
 *      MOVE into that empty cell (moveSelfToNeighbor; source becomes empty —
 *      mass conserved).
 *
 * GRAVITY (the crux). Cheng & Kier 1995 (JCICS 35:1054, the oil-water paper this
 * model cites for the gravity term) defines gravity as a vertical SWAP with an
 * occupied neighbour, expressed as a ratio against the move-into-vacancy baseline
 * P0 = P(move toward a vacant k while j vacant) — the SAME baseline J is a ratio
 * against. The chromatography paper SIMPLIFIES this: "the gravity term is literally
 * the probability of a cell moving to a position further down the column." So here
 * G is a single per-species downward-move tendency on the P0 / J scale: we ADD G to
 * the SOUTH empty-move weight. Since J and G share that baseline they add in weight
 * space; at the paper's G=10 the south term dominates the lateral J's, so P(move
 * down | space below) is high and monotonic in G (the Table-4 flow-rate trend).
 * "Moving to a position further down" = falling into the empty cell below; flow is
 * vacancy-mediated. (The source's true swap — descending THROUGH an occupied cell —
 * is the part chromatography dropped; not implemented.)
 *
 * RETENTION / SEPARATION. S2 has a strong affinity for B (low PB(S2,B)=0.10 so it
 * rarely breaks free; high J(S2,B)=2.0 so it is drawn toward B), so it gets caught
 * on stationary cells and migrates slowly. S1 has a weak affinity (PB(S1,B)=0.90,
 * J(S1,B)=0.20) and flows fast. Started together at the top, the two pull apart into
 * two peaks — the chromatogram (the "chromatogram" spatial indicator reproduces the
 * paper's Figure 3: population vs column position, one curve per species).
 *
 * Compile target: WASM (moveSelfToNeighbor is async-only → WebGPU excluded). JS works
 * too. Re-running preserves the saved simulationState + library thumbnail.
 *
 *   node scripts/gen-chromatography.mjs
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/models/Chromatography.gcaproj');

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
function groupNode(label, contents, color) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of contents) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + 200);
    maxY = Math.max(maxY, n.position.y + 80);
  }
  const g = {
    id: newId('g'),
    type: 'groupNode',
    position: { x: minX - 30, y: minY - 60 },
    data: {
      label, nodeType: 'group', config: {},
      width: (maxX - minX) + 60, height: (maxY - minY) + 90,
    },
  };
  if (color) g.data.groupColor = color;
  graphNodes.push(g);
  return g;
}

// =============================================================================
// IDs referenced across the graph
// =============================================================================
const ATTR_CELLTYPE = 'cellType';
const ATTR_PB = 'PB';
const ATTR_J = 'J';
const ATTR_GRAVITY = 'gravity';
const ATTR_DENS_W = 'densW';
const ATTR_DENS_B = 'densB';
const ATTR_DENS_SOLUTE = 'densSolute';
const NBR_NEAR = 'near';
const NBR_FAR = 'far';
const MAPPING_VIZ = 'viz';
const VAR_PB = 'pbFactors';
const VAR_W = 'weights';

// Tag option order — index 0..4. South = NBR_NEAR coord index 2.
const CELL_OPTIONS = ['empty', 'W', 'B', 'S1', 'S2'];
const SOUTH_INDEX = 2;
// Solutes are injected on this row (near the top). A small offset below row 0 keeps a
// solute from wrapping to the column foot via the vertical torus (see Init Event).
const INJECTION_ROW = 2;

function tagConst(tagName, col, row) {
  const i = CELL_OPTIONS.indexOf(tagName);
  if (i < 0) throw new Error(`unknown tag: ${tagName}`);
  return node('getConstant', {
    constType: 'tag', tagAttributeId: ATTR_CELLTYPE, constValue: String(i),
  }, col, row, `Tag: ${tagName}`);
}
function intConst(value, col, row) {
  return node('getConstant', { constType: 'integer', constValue: String(value) }, col, row, `Int: ${value}`);
}

// =============================================================================
// STEP GRAPH — Kier move-into-empty + gravity
// =============================================================================
const stepNode = node('step', {}, 0, 0);

// ─── Shared reads (cols 0-2, rows 1-4) ───────────────────────────────────────
const myType = node('getCellAttribute', { attributeId: ATTR_CELLTYPE }, 0, 1, 'My type');
const niArrNear = node('getAllNeighborIndexes', { neighborhoodId: NBR_NEAR }, 0, 2, 'NIs (near N/E/S/W)');
const niArrFar = node('getAllNeighborIndexes', { neighborhoodId: NBR_FAR }, 0, 3, 'NIs (far)');
const nbrTypes = node('getNeighborsAttrByIndexes', { attributeId: ATTR_CELLTYPE }, 1, 2, 'neighbour types[4]');
vEdge(niArrNear, 'indexes', nbrTypes, 'indexes');
const farTypes = node('getNeighborsAttrByIndexes', { attributeId: ATTR_CELLTYPE }, 1, 3, 'far types[4]');
vEdge(niArrFar, 'indexes', farTypes, 'indexes');
const tagEmpty = tagConst('empty', 0, 4);
const tagB = tagConst('B', 0, 5);
const gravityAttr = node('getModelAttribute', { attributeId: ATTR_GRAVITY, isColorAttr: false }, 0, 6, 'gravity G');
const const2 = intConst(SOUTH_INDEX, 0, 7);

// ─── Top gating chain (row 0) ────────────────────────────────────────────────
//   step → condCanAct → condBreak → condCanMove → moveSelf
const condCanAct = node('conditional', {}, 2, 0, 'If mobile (occupied, not B)');
fEdge(stepNode, 'do', condCanAct, 'check');
const condBreak = node('conditional', {}, 6, 0, 'If broke free');
const condCanMove = node('conditional', {}, 8, 0, 'If empty dir');

// ─── Gate 1: mobile? (occupied AND not B) ────────────────────────────────────
const isOccupied = node('statement', { operation: '!=' }, 1, 0, 'type != empty');
vEdge(myType, 'value', isOccupied, 'x');
vEdge(tagEmpty, 'value', isOccupied, 'y');
const isNotB = node('statement', { operation: '!=' }, 1, 1, 'type != B');
vEdge(myType, 'value', isNotB, 'x');
vEdge(tagB, 'value', isNotB, 'y');
const canAct = node('aggregate', { operation: 'and' }, 2, 1, 'mobile? (W/S1/S2)');
vEdge(isOccupied, 'result', canAct, 'values');
vEdge(isNotB, 'result', canAct, 'values');
vEdge(canAct, 'result', condCanAct, 'condition');

// ─── Per-direction loop (cols 2-6, rows 3-9) ─────────────────────────────────
// Runs once per cardinal d ∈ {0=N,1=E,2=S,3=W}. Fills pbFactors[d] and weights[d].
// Hangs off condCanAct.then (edge added BEFORE the condBreak edge so the loop
// runs first and the break/move gates read the populated arrays).
const forEachDirs = node('forEachInArray', {}, 2, 4, 'For each direction d');
vEdge(niArrNear, 'indexes', forEachDirs, 'array');
fEdge(condCanAct, 'then', forEachDirs, 'do');

const nbrType_d = node('arrayElement', {}, 3, 3, 'neighbour[d]');
vEdge(nbrTypes, 'values', nbrType_d, 'array');
vEdge(forEachDirs, 'index', nbrType_d, 'position');

const farType_d = node('arrayElement', {}, 3, 4, 'far[d]');
vEdge(farTypes, 'values', farType_d, 'array');
vEdge(forEachDirs, 'index', farType_d, 'position');

// PB(myType, neighbour[d]) → pbFactors[d]
const pb_d = node('lookupInteraction', { tableId: ATTR_PB }, 4, 3, 'PB(my, nbr)');
vEdge(myType, 'value', pb_d, 'labelA');
vEdge(nbrType_d, 'value', pb_d, 'labelB');
const setPb = node('setArrayElement', { variableId: VAR_PB }, 5, 3, 'pbFactors[d] ← PB');
fEdge(forEachDirs, 'body', setPb, 'do');
vEdge(forEachDirs, 'index', setPb, 'index');
vEdge(pb_d, 'value', setPb, 'value');

// weight[d] = (neighbour[d] empty) ? ( J(my, far) + (d==South ? G : 0) ) : 0
const isEmpty_d = node('statement', { operation: '==' }, 4, 5, 'nbr[d]==empty');
vEdge(nbrType_d, 'value', isEmpty_d, 'x');
vEdge(tagEmpty, 'value', isEmpty_d, 'y');
const jOcc_d = node('lookupInteraction', { tableId: ATTR_J }, 4, 6, 'J(my, far)');
vEdge(myType, 'value', jOcc_d, 'labelA');
vEdge(farType_d, 'value', jOcc_d, 'labelB');
// weight[d] = (neighbour[d] empty) ? J(my, far) : 0.  Gravity is added to the SOUTH
// weight AFTER the loop (below). The loop must only feed the index into
// arrayElement / setArrayElement — never into a compare/expression — or the JS
// loop-invariance pass hoists that index-reader out of the loop and its `_fei`
// counter is undefined at runtime (WASM tolerates it; JS does not). emp is 1/0
// from the == statement, so emp*jv = (empty ? J : 0).
const wt_d = exprNode('emp * jv', ['emp', 'jv'], 5, 6, 'weight[d] = empty?J:0');
vEdge(isEmpty_d, 'result', wt_d, 'a');
vEdge(jOcc_d, 'value', wt_d, 'b');
const setWt = node('setArrayElement', { variableId: VAR_W }, 6, 6, 'weights[d] ← weight');
fEdge(forEachDirs, 'body', setWt, 'do');
vEdge(forEachDirs, 'index', setWt, 'index');
vEdge(wt_d, 'result', setWt, 'value');

// ─── Post-loop: add gravity G to the SOUTH weight (weights[2]) when south empty ──
// weights[2] += southEmpty ? G : 0 — equivalent to adding G inside the loop, but
// uses the CONSTANT south index (2) so nothing reads the forEach loop-index here
// (JS-hoist-safe). Runs after the loop, before the gates (edge #2 off condCanAct.then).
const southType = node('arrayElement', {}, 2, 10, 'neighbour[S]');
vEdge(nbrTypes, 'values', southType, 'array');
vEdge(const2, 'value', southType, 'position');
const southFar = node('arrayElement', {}, 2, 11, 'far[S]');
vEdge(farTypes, 'values', southFar, 'array');
vEdge(const2, 'value', southFar, 'position');
const southEmpty = node('statement', { operation: '==' }, 3, 10, 'south empty?');
vEdge(southType, 'value', southEmpty, 'x');
vEdge(tagEmpty, 'value', southEmpty, 'y');
const jOccSouth = node('lookupInteraction', { tableId: ATTR_J }, 3, 11, 'J(my, far[S])');
vEdge(myType, 'value', jOccSouth, 'labelA');
vEdge(southFar, 'value', jOccSouth, 'labelB');
// OVERWRITE weights[2] = southEmpty ? (J(my, far[S]) + G) : 0 — recomputed fresh, NOT a
// read-modify-write. Indexing a single element of a Local Variable via
// getVariable+arrayElement tripped a JS-compile scoping bug; overwriting with a freshly
// computed value sidesteps it and is behaviourally identical (loop already wrote
// weights[2]=empty?J:0; this overwrites it WITH gravity, edge order guarantees after-loop).
const wSouth = exprNode('e * (j + g)', ['e', 'j', 'g'], 4, 11, 'weights[S] = empty?(J+G):0');
vEdge(southEmpty, 'result', wSouth, 'a');
vEdge(jOccSouth, 'value', wSouth, 'b');
vEdge(gravityAttr, 'value', wSouth, 'c');
const boostSouth = node('setArrayElement', { variableId: VAR_W }, 5, 11, 'weights[S] ← empty?(J+G):0');
fEdge(condCanAct, 'then', boostSouth, 'do');   // edge #2 off condCanAct.then (runs after the loop)
vEdge(const2, 'value', boostSouth, 'index');
vEdge(wSouth, 'result', boostSouth, 'value');

// ─── Gate 2: Bernoulli(Π pb_d) (cols 5-6, rows 0-1) ──────────────────────────
// Wired AFTER the forEach + south-boost edges so the loop runs first (populates
// pbFactors/weights) and the south boost second.
fEdge(condCanAct, 'then', condBreak, 'check');
const pbRead = node('getVariable', { variableId: VAR_PB }, 4, 1, 'pbFactors[]');
const pbProduct = node('aggregate', { operation: 'product' }, 5, 1, 'P_break (Π pb_d)');
vEdge(pbRead, 'value', pbProduct, 'values');
const rollBreak = node('getRandom', { randomType: 'bool' }, 6, 1, 'Bernoulli(P_break)');
vEdge(pbProduct, 'result', rollBreak, 'probability');
vEdge(rollBreak, 'value', condBreak, 'condition');

// ─── Gate 3: any empty direction? (cols 7-8, rows 1-2) ───────────────────────
fEdge(condBreak, 'then', condCanMove, 'check');
const hasEmptyDir = node('groupStatement', { operation: 'hasA' }, 7, 1, 'hasA(empty)?');
vEdge(nbrTypes, 'values', hasEmptyDir, 'values');
vEdge(tagEmpty, 'value', hasEmptyDir, 'x');
vEdge(hasEmptyDir, 'result', condCanMove, 'condition');

// ─── Sample direction & move (cols 8-10, rows 0-2) ───────────────────────────
const weightsRead = node('getVariable', { variableId: VAR_W }, 7, 0, 'weights[]');
const chosenSamp = node('groupOperator', { operation: 'weightedRandom' }, 8, 0, 'Pick direction');
vEdge(weightsRead, 'value', chosenSamp, 'values');
const chosenNI = node('arrayElement', {}, 9, 0, 'NI of chosen dir');
vEdge(niArrNear, 'indexes', chosenNI, 'array');
vEdge(chosenSamp, 'index', chosenNI, 'position');
const myTypePayload = node('getCellAttribute', { attributeId: ATTR_CELLTYPE }, 9, 1, 'My type');
const moveSelf = node('moveSelfToNeighbor', {
  payloadCount: 1, attr_0: ATTR_CELLTYPE, transferOrientation: false,
}, 10, 0, 'Move self → NI');
fEdge(condCanMove, 'then', moveSelf, 'do');
vEdge(chosenNI, 'value', moveSelf, 'targetNI');
vEdge(myTypePayload, 'value', moveSelf, 'payload_0');

// =============================================================================
// INIT EVENT — per cell, on Reset: seed the recirculating column
// =============================================================================
// The column is a FULL torus — the paper's "cylinder with ingredients flowing back
// to the top of the system". It wraps BOTH horizontally (the tube circumference) and
// vertically (a cell exiting the bottom re-enters at the top), so the gravity-driven
// mobile phase recirculates as continuous flow and nothing piles up against a bottom
// edge. (Contrast Cheng & Kier 1995's oil-water model, a CLOSED cylinder with two
// immovable boundary rows where the liquids settle into static layers — that is NOT
// this model.) Row 0 (the top — the paper's injection point) is the solute injection
// band; every other row is the column bulk (W / B / empty). One uniform draw r per
// cell drives both.
const initRow = 12;
const initNode = node('initEvent', {}, 0, initRow);

const densW = node('getModelAttribute', { attributeId: ATTR_DENS_W, isColorAttr: false }, 1, initRow + 4, 'densW');
const densB = node('getModelAttribute', { attributeId: ATTR_DENS_B, isColorAttr: false }, 1, initRow + 5, 'densB');
const densSolute = node('getModelAttribute', { attributeId: ATTR_DENS_SOLUTE, isColorAttr: false }, 1, initRow + 1, 'densSolute');
const rInit = node('getRandom', { randomType: 'float', min: '0', max: '1' }, 1, initRow, 'r ∈ [0,1)');
const injRowConst = intConst(INJECTION_ROW, 1, initRow + 6);

// --- Injection band (row INJECTION_ROW, near the top) = solutes; every other row =
//     column bulk. The band sits a couple of rows BELOW the very top edge: on the
//     vertical torus, row 0's north neighbour is the bottom row (199), so a solute
//     injected at row 0 can take the one upward move that wraps it to the column's
//     foot, showing up as a spurious blip at the far end of the chromatogram. A
//     small offset removes that (a solute would have to climb several rows against
//     gravity to wrap) and is negligible vs the paper's "row 1" on a 200-row column. ---
const isRow1 = node('statement', { operation: '==' }, 2, initRow, `y == ${INJECTION_ROW} (near top)?`);
vEdge(initNode, 'y', isRow1, 'x');
vEdge(injRowConst, 'value', isRow1, 'y');
const condRow1 = node('conditional', {}, 3, initRow, 'If injection row');
fEdge(initNode, 'do', condRow1, 'check');
vEdge(isRow1, 'result', condRow1, 'condition');

// injection band (condRow1.then): r<densSolute → S1; r<2·densSolute → S2; else W
const isS1 = node('statement', { operation: '<' }, 4, initRow - 1, 'r < densSolute?');
vEdge(rInit, 'value', isS1, 'x');
vEdge(densSolute, 'value', isS1, 'y');
const condS1 = node('conditional', {}, 5, initRow - 1, 'If S1');
fEdge(condRow1, 'then', condS1, 'check');
vEdge(isS1, 'result', condS1, 'condition');
const setS1 = node('setAttribute', { attributeId: ATTR_CELLTYPE, _port_value: String(CELL_OPTIONS.indexOf('S1')) }, 6, initRow - 1, 'type ← S1');
fEdge(condS1, 'then', setS1, 'do');

const twoDensSolute = exprNode('s * 2', ['s'], 4, initRow + 1, '2·densSolute');
vEdge(densSolute, 'value', twoDensSolute, 'a');
const isS2 = node('statement', { operation: '<' }, 5, initRow + 1, 'r < 2·densSolute?');
vEdge(rInit, 'value', isS2, 'x');
vEdge(twoDensSolute, 'result', isS2, 'y');
const condS2 = node('conditional', {}, 6, initRow + 1, 'If S2');
fEdge(condS1, 'else', condS2, 'check');
vEdge(isS2, 'result', condS2, 'condition');
const setS2 = node('setAttribute', { attributeId: ATTR_CELLTYPE, _port_value: String(CELL_OPTIONS.indexOf('S2')) }, 7, initRow + 1, 'type ← S2');
fEdge(condS2, 'then', setS2, 'do');
const setWrow0 = node('setAttribute', { attributeId: ATTR_CELLTYPE, _port_value: String(CELL_OPTIONS.indexOf('W')) }, 7, initRow + 2, 'type ← W');
fEdge(condS2, 'else', setWrow0, 'do');

// column bulk (condRow1.else): r<densB → B; r<densB+densW → W; else empty
const isB = node('statement', { operation: '<' }, 4, initRow + 4, 'r < densB?');
vEdge(rInit, 'value', isB, 'x');
vEdge(densB, 'value', isB, 'y');
const condB = node('conditional', {}, 5, initRow + 4, 'If B');
fEdge(condRow1, 'else', condB, 'check');
vEdge(isB, 'result', condB, 'condition');
const setB = node('setAttribute', { attributeId: ATTR_CELLTYPE, _port_value: String(CELL_OPTIONS.indexOf('B')) }, 6, initRow + 4, 'type ← B');
fEdge(condB, 'then', setB, 'do');

const densBplusW = exprNode('b + w', ['b', 'w'], 4, initRow + 5, 'densB + densW');
vEdge(densB, 'value', densBplusW, 'a');
vEdge(densW, 'value', densBplusW, 'b');
const isWbulk = node('statement', { operation: '<' }, 5, initRow + 5, 'r < densB+densW?');
vEdge(rInit, 'value', isWbulk, 'x');
vEdge(densBplusW, 'result', isWbulk, 'y');
const condWbulk = node('conditional', {}, 6, initRow + 5, 'If W');
fEdge(condB, 'else', condWbulk, 'check');
vEdge(isWbulk, 'result', condWbulk, 'condition');
const setWbulk = node('setAttribute', { attributeId: ATTR_CELLTYPE, _port_value: String(CELL_OPTIONS.indexOf('W')) }, 7, initRow + 5, 'type ← W');
fEdge(condWbulk, 'then', setWbulk, 'do');
// condWbulk.else → leave empty (default), no write.

// =============================================================================
// GROUP WRAPPERS (visual scoping)
// =============================================================================
groupNode('Shared reads', [myType, niArrNear, niArrFar, nbrTypes, farTypes, tagEmpty, tagB, gravityAttr, const2], '#3a4a5a');
groupNode('Gating chain → move (mobile? → broke free? → empty dir? → move)',
  [condCanAct, condBreak, condCanMove, moveSelf, isOccupied, isNotB, canAct,
   pbRead, pbProduct, rollBreak, hasEmptyDir, weightsRead, chosenSamp, chosenNI, myTypePayload], '#4a6858');
groupNode('Per-direction body (runs for d ∈ {N,E,S,W})',
  [forEachDirs, nbrType_d, farType_d, pb_d, setPb, isEmpty_d, jOcc_d, wt_d, setWt], '#4a5878');
groupNode('South gravity boost (weights[S] = empty ? J+G : 0)',
  [southType, southFar, southEmpty, jOccSouth, wSouth, boostSouth], '#5a4a78');
groupNode('Init Event — injection band (near the top) → column bulk',
  [initNode, densW, densB, densSolute, rInit, injRowConst,
   isRow1, condRow1,
   isS1, condS1, setS1, twoDensSolute, isS2, condS2, setS2, setWrow0,
   isB, condB, setB, densBplusW, isWbulk, condWbulk, setWbulk], '#406870');

// =============================================================================
// MODEL DEFINITION (non-graph parts)
// =============================================================================
const properties = {
  name: 'Chromatography (Kier, Cheng & Karnes 2000)',
  author: 'Lemont B. Kier, Chao-Kun Cheng, H. Thomas Karnes',
  modelAuthor: 'Rodrigo F. Figueiredo',
  description:
    'Faithful reproduction of Kier, Cheng & Karnes (2000), "A Cellular Automata ' +
    'Model of Chromatography" (Biomed. Chromatogr. 14:530-534). A 43×200 column on a ' +
    'full torus — the paper\'s "cylinder with ingredients flowing back to the top of ' +
    'the system": it wraps both horizontally (the tube circumference) and vertically ' +
    '(cells leaving the bottom re-enter at the top), so the gravity-driven mobile ' +
    'phase recirculates as continuous flow and never just drains to the bottom. It ' +
    'holds solvent W, immobile stationary phase B, and two solutes S1/S2, governed by ' +
    'pairwise break (PB) and join (J) probabilities + a downward gravity flow G ' +
    'applied to every mobile component (the "force pushing the mobile phase"). The ' +
    'strongly-retained solute S2 (low PB, high J with B) lags the weakly-retained S1, ' +
    'so a band injected at the top separates into two peaks as it flows down — watch ' +
    'the "Chromatogram" indicator (population vs column position, reproducing Fig. 3). ' +
    'Click Reset to inject the band, then Play. Switch presets to explore the paper\'s ' +
    'parameter studies (affinity, flow rate, solvent polarity, stationary-phase ' +
    'solvation). Gravity follows the paper\'s definition ("the probability of a cell ' +
    'moving to a position further down the column"): an additive downward push on the ' +
    'move into the open cell below, on the same baseline scale as J (Cheng & Kier ' +
    '1995, JCICS 35:1054).',
  topology: '2d-grid',
  boundaryTreatment: 'torus',
  updateMode: 'asynchronous',
  asyncScheme: 'random-order',
  gridWidth: 43,
  gridHeight: 200,
  maxIterations: 100000,
  tags: ['chemistry', 'chromatography', 'separation', 'movement', 'gravity', 'kier', 'lookup table', 'chromatogram'],
  useWasm: true,
  useWebGPU: false,
};

// --- Standard interaction tables (paper Table 1), symmetric, keyed by cellType.
//     `empty` row/col = 1 for both: PB(*,empty)=1 (no bond to break),
//     J(*,empty)=1 (neutral baseline — no joining preference toward a vacancy).
function buildTables(o) {
  // o overrides specific symmetric pairs; defaults are paper Table 1.
  const pb = {
    WW: 0.90, WB: 0.90, WS1: 0.90, WS2: 0.90,
    BB: 0.999, BS1: 0.90, BS2: 0.10,
    S1S1: 0.90, S1S2: 0.90, S2S2: 0.90,
    ...(o.pb || {}),
  };
  const j = {
    WW: 0.10, WB: 0.10, WS1: 0.10, WS2: 0.10,
    BB: 0.001, BS1: 0.20, BS2: 2.00,
    S1S1: 0.10, S1S2: 0.10, S2S2: 0.10,
    ...(o.j || {}),
  };
  // `empty` rows/cols are 1.0 (neutral): no bond to break (PB=1) and no joining
  // preference (J=1 — the baseline gravity/J share).
  return {
    [ATTR_PB]: {
      empty: { empty: 1, W: 1, B: 1, S1: 1, S2: 1 },
      W: { empty: 1, W: pb.WW, B: pb.WB, S1: pb.WS1, S2: pb.WS2 },
      B: { empty: 1, W: pb.WB, B: pb.BB, S1: pb.BS1, S2: pb.BS2 },
      S1: { empty: 1, W: pb.WS1, B: pb.BS1, S1: pb.S1S1, S2: pb.S1S2 },
      S2: { empty: 1, W: pb.WS2, B: pb.BS2, S1: pb.S1S2, S2: pb.S2S2 },
    },
    [ATTR_J]: {
      empty: { empty: 1, W: 1, B: 1, S1: 1, S2: 1 },
      W: { empty: 1, W: j.WW, B: j.WB, S1: j.WS1, S2: j.WS2 },
      B: { empty: 1, W: j.WB, B: j.BB, S1: j.BS1, S2: j.BS2 },
      S1: { empty: 1, W: j.WS1, B: j.BS1, S1: j.S1S1, S2: j.S1S2 },
      S2: { empty: 1, W: j.WS2, B: j.BS2, S1: j.S1S2, S2: j.S2S2 },
    },
  };
}
const STANDARD = buildTables({});

const attributes = [
  {
    id: ATTR_CELLTYPE, name: 'Cell type', type: 'tag',
    description:
      'Which ingredient occupies the cell. empty = vacancy (the mobile phase ' +
      'flows through these); W = solvent / mobile phase; B = stationary phase ' +
      '(immobile); S1 = weakly-retained solute; S2 = strongly-retained solute.',
    isModelAttribute: false, defaultValue: String(CELL_OPTIONS.indexOf('empty')),
    tagOptions: CELL_OPTIONS,
  },
  {
    id: ATTR_PB, name: 'PB (break probability)', type: 'lookupTable',
    description:
      'Probability that two adjacent cells break their bond (= the cell can move ' +
      'away from that neighbour). LOW = strong affinity (stays bonded → retained), ' +
      'HIGH = weak affinity (breaks easily → mobile). Keyed by cell type on both ' +
      'axes; the `empty` row/col is 1.0 (no bond to break). Paper Table 1: B–S1 0.90 ' +
      '(weak), B–S2 0.10 (strong — S2 is retained).',
    isModelAttribute: true, defaultValue: '0',
    rowKeySource: { kind: 'tagAttribute', attributeId: ATTR_CELLTYPE },
    colKeySource: { kind: 'tagAttribute', attributeId: ATTR_CELLTYPE },
    symmetric: true,
    tableValues: STANDARD[ATTR_PB],
  },
  {
    id: ATTR_J, name: 'J (join / trajectory)', type: 'lookupTable',
    description:
      'Relative probability that a cell moves TOWARD a given type sitting two cells ' +
      'ahead across a vacancy (the extended von Neumann "k" cell). J = 1 neutral, ' +
      '> 1 attracts, < 1 repels. Keyed by cell type on both axes; `empty` = 1.0 ' +
      '(neutral). Paper Table 1: B–S1 0.20 (weak attraction), B–S2 2.00 (strong — ' +
      'S2 is drawn to the stationary phase).',
    isModelAttribute: true, defaultValue: '0',
    rowKeySource: { kind: 'tagAttribute', attributeId: ATTR_CELLTYPE },
    colKeySource: { kind: 'tagAttribute', attributeId: ATTR_CELLTYPE },
    symmetric: true,
    tableValues: STANDARD[ATTR_J],
  },
  {
    id: ATTR_GRAVITY, name: 'Gravity (flow rate)', type: 'float',
    description:
      'The downward flow term — "the probability of a cell moving to a position ' +
      'further down the column" (paper). Added to the south (down) move weight, on ' +
      'the same baseline scale as J, so larger G = faster migration = shorter ' +
      'retention. Paper standard 10; flow-rate study sweeps 2 / 5 / 10.',
    isModelAttribute: true, defaultValue: '10', hasBounds: true, min: 0, max: 50,
  },
  {
    id: ATTR_DENS_W, name: 'Solvent density (init)', type: 'float',
    description: 'Fraction of column-bulk cells (every row below the top) seeded as solvent W on Reset. Paper ≈ 0.69.',
    isModelAttribute: true, defaultValue: '0.69', hasBounds: true, min: 0, max: 1,
  },
  {
    id: ATTR_DENS_B, name: 'Stationary density (init)', type: 'float',
    description: 'Fraction of column-bulk cells (every row below the top) seeded as immobile stationary phase B on Reset. Paper ≈ 0.07 (600 of 8600 cells). "≥3 cells apart" constraint not enforced (random placement).',
    isModelAttribute: true, defaultValue: '0.07', hasBounds: true, min: 0, max: 1,
  },
  {
    id: ATTR_DENS_SOLUTE, name: 'Solute density (init, per species)', type: 'float',
    description: 'Fraction of the injection row (near the top of the column) seeded as each solute (S1 and S2 get this fraction each; the rest of the row is W). Paper ≈ 0.23 (10 of 43 cells per solute).',
    isModelAttribute: true, defaultValue: '0.23', hasBounds: true, min: 0, max: 0.5,
  },
];

const neighborhoods = [
  {
    id: NBR_NEAR, name: 'Cardinal (N/E/S/W)',
    description: '4 direct cardinal neighbours, ordered N → E → S → W. South = index 2 (the "down the column" direction; gravity boosts this slot).',
    coords: [[-1, 0], [0, 1], [1, 0], [0, -1]],
    tags: { 0: 'N', 1: 'E', 2: 'S', 3: 'W' },
  },
  {
    id: NBR_FAR, name: 'Cardinal ×2 (extended k)',
    description: '4 cardinal cells two steps away (the extended von Neumann "k" cells), same N/E/S/W order. Used by the J(myType, farType) joining-trajectory lookup.',
    coords: [[-2, 0], [0, 2], [2, 0], [0, -2]],
    tags: { 0: 'N', 1: 'E', 2: 'S', 3: 'W' },
  },
];

const mappings = [
  {
    id: MAPPING_VIZ, name: 'Cell type', isAttributeToColor: true,
    description: 'Colours each cell by ingredient: empty near-black, W blue, B grey, S1 green, S2 red. (Linked categorical mapping — auto-generated from the cell type.)',
    redDescription: 'By cell type', greenDescription: 'By cell type', blueDescription: 'By cell type',
    linked: true,
    linkedAttributeId: ATTR_CELLTYPE,
    linkedColors: {
      tag: [
        { r: 15, g: 15, b: 25 },    // empty
        { r: 40, g: 90, b: 180 },   // W
        { r: 120, g: 120, b: 120 }, // B
        { r: 60, g: 200, b: 90 },   // S1
        { r: 230, g: 60, b: 60 },   // S2
      ],
    },
  },
];

const indicators = [
  {
    id: 'chromatogram',
    name: 'Chromatogram (solute population vs column position)',
    kind: 'linked',
    dataType: 'tag',
    defaultValue: '0',
    linkedAttributeId: ATTR_CELLTYPE,
    linkedAggregation: 'frequency',
    trackedValues: ['S1', 'S2'],      // chart ONLY the two solutes (exclude W/B/empty, which would flatten them)
    accumulationMode: 'per-generation',
    xAxis: 'rows',          // bin along the 200-long flow axis
    spatialBinMode: 'absolute',
    spatialBinSize: 10,     // paper's "groups of 10 rows" → 20 position bins
    watched: true,
  },
];

const variables = [
  {
    id: VAR_PB, name: 'pbFactors',
    description: 'Per-direction break factor pb_d = PB(myType, neighbourType_d). Product → Bernoulli break gate.',
    kind: 'array', dataType: 'float', length: 4, initialValue: '1',
  },
  {
    id: VAR_W, name: 'weights',
    description: 'Per-direction move weight wt_d = (neighbour_d empty) ? J(myType, farType_d) + (south ? G : 0) : 0. Sampled by weightedRandom.',
    kind: 'array', dataType: 'float', length: 4, initialValue: '0',
  },
];

// =============================================================================
// PRESETS — the paper's parameter studies (Tables 1, 2, 4, 5, 6, 7)
// =============================================================================
const presetSpecs = [
  {
    name: 'Standard — two-solute separation (Table 1)',
    description: 'Paper Table 1 standard rule set + gravity 10. S1 (weak B-affinity) outruns S2 (strong B-affinity); the injected band separates into two peaks (Fig. 3).',
    tables: STANDARD, gravity: 10,
  },
  // --- Table 2: solute affinity for the stationary phase (single-solute sweep).
  //     Both solutes share the swept (PB, J) with B so the chromatogram shows one
  //     merged peak whose position reflects that affinity (lower migration =
  //     higher capacity factor k'). Compare peak positions across the 5 presets.
  ...[
    { pb: 0.10, j: 2.00, k: 1.193 },
    { pb: 0.30, j: 1.20, k: 0.246 },
    { pb: 0.50, j: 0.80, k: 0.158 },
    { pb: 0.70, j: 0.60, k: 0.096 },
    { pb: 0.90, j: 0.20, k: 0.035 },
  ].map(s => ({
    name: `Affinity — PB(SB)=${s.pb.toFixed(2)}, J(SB)=${s.j.toFixed(2)} (k'=${s.k}) [Table 2]`,
    description: `Paper Table 2: both solutes given the same stationary-phase affinity. Capacity factor k'=${s.k}. Higher affinity (lower PB, higher J) → slower migration → peak stays higher up the column.`,
    tables: buildTables({
      pb: { BS1: s.pb, BS2: s.pb },
      j: { BS1: s.j, BS2: s.j },
    }),
    gravity: 10,
  })),
  // --- Table 4: flow rate (vary gravity only).
  ...[2, 5, 10].map(g => ({
    name: `Flow rate — gravity ${g} [Table 4]`,
    description: `Paper Table 4: standard tables, gravity (flow rate) = ${g}. Faster flow → shorter retention. Watch both solute peaks reach the bottom sooner as gravity rises.`,
    tables: STANDARD, gravity: g,
  })),
  // --- Table 5: mobile-phase solvent polarity (vary W–W self-association).
  ...[
    { pb: 0.90, j: 0.10, label: 'non-polar' },
    { pb: 0.50, j: 0.70, label: 'intermediate' },
    { pb: 0.25, j: 1.50, label: 'polar' },
  ].map(s => ({
    name: `Solvent polarity — PB(W)=${s.pb.toFixed(2)}, J(W)=${s.j.toFixed(2)} (${s.label}) [Table 5]`,
    description: `Paper Table 5: W–W self-association encodes solvent polarity. ${s.label}. Migration is faster in non-polar solvents (reversed-phase behaviour).`,
    tables: buildTables({ pb: { WW: s.pb }, j: { WW: s.j } }),
    gravity: 10,
  })),
  // --- Table 6: stationary-phase solvation (vary W–B).
  ...[
    { pb: 0.90, j: 0.10, rs: 1.125 },
    { pb: 0.50, j: 0.80, rs: 0.667 },
    { pb: 0.20, j: 1.50, rs: 0.556 },
  ].map(s => ({
    name: `Stationary solvation — PB(WB)=${s.pb.toFixed(2)}, J(WB)=${s.j.toFixed(2)} (Rs=${s.rs}) [Table 6]`,
    description: `Paper Table 6: solvation of the stationary phase (W–B interaction). Resolution Rs=${s.rs}. Greater solvation of B → poorer resolution between the two solute peaks.`,
    tables: buildTables({ pb: { WB: s.pb }, j: { WB: s.j } }),
    gravity: 10,
  })),
  // --- Table 7: solute + stationary-phase solvation (vary W–B = W–S together).
  ...[
    { pb: 0.90, j: 0.20 },
    { pb: 0.20, j: 1.50 },
  ].map(s => ({
    name: `Solute+stationary solvation — PB=${s.pb.toFixed(2)}, J=${s.j.toFixed(2)} [Table 7]`,
    description: `Paper Table 7: solvation of BOTH the solutes and the stationary phase (W–B, W–S1, W–S2 set together). Stronger solvent–solute interaction reduces retention and resolution.`,
    tables: buildTables({
      pb: { WB: s.pb, WS1: s.pb, WS2: s.pb },
      j: { WB: s.j, WS1: s.j, WS2: s.j },
    }),
    gravity: 10,
  })),
];

// Stable, deterministic timestamps so re-running doesn't churn the file.
const PRESET_BASE_TIMESTAMP = 1747000000000;
const presets = presetSpecs.map((spec, i) => ({
  id: newId('preset_'),
  name: spec.name,
  description: spec.description,
  state: {
    schemaVersion: 2,
    interactionTables: spec.tables,
    modelAttrs: { [ATTR_GRAVITY]: spec.gravity },
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
  indicators,
  variables,
  graphNodes,
  graphEdges,
  macroDefs: [],
  presets,
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
  `${mappings.length} mappings, ${indicators.length} indicators, ` +
  `${presets.length} presets${preserved}`,
);
