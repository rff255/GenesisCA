// EXPLICIT CONTROLS (macros) — functional verification. Phase P1: schema, the
// resolver, the clone fix, the serialization round trips, the write path and the
// EMIT-identity proof.
//
// WHY THIS EXISTS: `check-compile-identity.mjs` proves this phase changed no
// emitted code (it changes NONE — nothing here reaches a compiler) and proves
// NOTHING about whether the resolver is right. This is the other half: a
// synthetic, VALUE-asserting harness that builds a model + macro defs in memory
// and drives the SHIPPED modules (and the REAL `modelReducer` — the
// `test-macro-references` / `test-param-input-mappings` precedent).
//
//   Tier A — RESOLUTION. Every widget-inventory row resolves to the right kind
//     + value; the class-A ADAPTIVE cases follow a live retype through the real
//     reducer (a stored kind would strand a wrong-typed value — R4); a WIRED
//     port reports `wired` with its reason; a deleted node → `orphan-node`, a
//     vanished key → `orphan-key`; `eligibleControlKeys` NEVER offers
//     `_port_bondAttr_*`, `partTag_*`, a count stepper, a `_varName_*` or a
//     display-only key; 2D vs 3D (`hiddenPorts` through `getEffectivePorts`);
//     and the GRAPH KIND (`setAttribute` tag options resolve against
//     `agentAttributes` on Agents and `attributes` on Cells — D10).
//   Tier B — THE CLONE (the highest-risk edit, F1/R1/R2). Controls + groups
//     survive `cloneMacroWithFreshIds`, every `target.nodeId` is REMAPPED, every
//     `id` / `groupId` / `controlId` is PRESERVED, a control never resolves to a
//     node it did not name, and a control-free def clones with NO `controls`
//     key.
//   Tier C — ROUND TRIPS. `.gcaproj`, `.gcamacro` and the cross-tab clipboard
//     preserve the records verbatim; an OLD-shape file loads with none; a
//     malformed `controls` is DROPPED not thrown; `stringifyCompact` does not
//     INLINE the new arrays (R9 — it inlines by KEY NAME).
//   Tier D — CHAINING. A→B→C resolves to the ultimate address in C; a 2-cycle,
//     a self-cycle and an over-deep chain all terminate and report; an orphaned
//     inner control reports; cloning A **and** B in one operation keeps the
//     chain resolving (the `controlId`-preserved argument).
//   Tier E — THE WRITE PATH, through the real reducer. Exactly one node's one
//     key changes; every untouched node keeps its object IDENTITY; controls /
//     groups / edges are `===` untouched; a CHAINED write lands in the NESTED
//     def; a blocked control's write is inert.
//   Tier F — EMIT IDENTITY (the structural proof, R8). A def WITH controls and
//     the same def STRIPPED of both records produce byte-identical
//     `expandMacros` output AND byte-identical compiled JS / WASM / WGSL;
//     adding, renaming, grouping and deleting a control each leave it unchanged.
//   Tier G — CASCADES + the closed instance (P3).
//   Tier H — AUTHORING semantics (P2), through the real reducer.
//   Tier I — CLASS C, ONE SOURCE (P4). Every (nodeType, key) the ~39-site
//     extraction moved returns EXACTLY the list the in-node picker renders, on
//     BOTH graph kinds (D10); the coupled-write keys share their LIST but are
//     never bindable (P1.2 for class C); a class-C control resolves, writes and
//     re-derives its widget; and CaNode is pinned to have NO surviving inline
//     list expression for any of them.
//   Tier K — THE CHAINING PICK ROWS (P4 / D4). A nested macro INSTANCE offers
//     its own def's controls; a row that would close a cycle is refused, and the
//     verdict is the SHIPPED `resolveTarget` seeded with the control being
//     re-bound.
//   Tier J — M1 / M2 / the cross-tab clipboard need NO NEW PASS. The reference
//     bundle is IDENTICAL with and without controls (the reference lives in the
//     node CONFIG, which M1 already scans); a full planImport → applyImportPlan
//     keeps them resolving at the node they named; and a pasted CHAIN lands in
//     the pasted inner def (the preserved-`controlId` argument).
//
// Every tier is negative-controlled by SOURCE MUTATION — see the table in
// docs/PLAN_EXPLICIT_CONTROLS.md §4.
//
// Run from the repo root:  node scripts/test-explicit-controls.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export {
  eligibleControlKeys, resolveTarget, resolveControlDescriptor, applyControlValue,
  inlineWidgetFor, isExcludedControlKey, elementOptionsFor, describeControlTarget,
  SCALAR_CONFIG_KEYS, CLASS_C_KEYS, CONTROL_BLOCK_REASON, CONTROL_MAX_CHAIN_DEPTH,
  ownAttrListFor, tagAttrScopeFor,
  orderByGroup, withGroup, applyInterfaceEdit,
  groupSections, CONTROL_BLOCK_NEEDS_ATTENTION,
} from '../src/modeler/vpl/explicitControls.ts';
export { getControlPick, setControlPick, subscribeControlPick } from '../src/modeler/vpl/graphState.ts';
export { getOpenMacroScope, setOpenMacroScope, subscribeOpenMacroScope } from '../src/modeler/vpl/graphState.ts';
export { cloneMacroWithFreshIds, countMacroInstances } from '../src/model/macroImport.ts';
export { serializeModel, parseModelJSON, buildMacroFile, parseMacroFile } from '../src/model/fileOperations.ts';
export { expandMacros } from '../src/modeler/vpl/compiler/macroExpand.ts';
export { getEffectivePorts } from '../src/modeler/vpl/effectivePorts.ts';
export { getActiveGraphKind, setActiveGraphKind } from '../src/modeler/vpl/graphState.ts';
export { writeGraphClipboard, readGraphClipboard } from '../src/modeler/vpl/graphClipboard.ts';
export { elementSpecFor } from '../src/modeler/vpl/explicitControls.ts';
export { collectMacroExportDefs, collectMacroReferences, buildReferenceBundle, defaultSelection } from '../src/model/macroReferences.ts';
export { planImport, applyImportPlan } from '../src/model/macroImportPlan.ts';
export { collectMacroDefBundle, remapNestedMacroRefs } from '../src/modeler/vpl/graphClipboard.ts';
export { compileAll, migrateForHarness } from '../src/dev/compileHarness.ts';
// The REAL reducer, so what the harness exercises is what the app dispatches.
export { modelReducer } from '../src/model/ModelContext.tsx';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-explicitctl-'));
const entryPath = join(ROOT, 'scripts', '__explicitctl_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });

// The cross-tab clipboard reads localStorage lazily inside its functions, so a
// stub installed after import is enough to drive the SHIPPED path.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};

const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const attr = (id, type, extra = {}) => ({
  id, name: id, type, description: '', isModelAttribute: false, defaultValue: '0', ...extra,
});
const node = (id, nodeType, config = {}) => ({
  id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config },
});
const edge = (id, source, target, sourceHandle, targetHandle) => ({ id, source, target, sourceHandle, targetHandle });

/** The macro def under test. Node ids are deliberately human-readable so a
 *  mis-remap in the clone is legible in a failure message. */
function buildDefA() {
  return {
    id: 'def_a',
    name: 'Def A',
    nodes: [
      node('mi', 'macroInput', { macroDefId: 'def_a' }),
      node('sa', 'setAttribute', { attributeId: 'a_count', _port_value: '7' }),
      node('rnd', 'getRandom', { randomType: 'float', distribution: 'uniform', _port_min: '2', _port_max: '9' }),
      node('sw', 'switch', { mode: 'conditions', caseCount: 2, firstMatchOnly: true }),
      node('cmp', 'statement', { compareType: 'numerical', operation: '>', _port_x: '3', _port_y: '4' }),
      node('fb', 'formBond', { _port_bondAttr_bond_w: '0.5', _port_restLength: '2' }),
      node('dv', 'divideAgent', { partition: 'byBondAttribute', partitionAttributeId: 'bond_w', partTag_0: 'A', conserve: 'area' }),
      node('ex', 'expression', { expression: 'a + b', visibleCount: 2, _varName_a: 'a', _exprW: 300 }),
      node('ca', 'createAgent', { _port_x: '1', _port_y: '2', _port_z: '3' }),
      node('af', 'applyForce', { _port_fx: '1', _port_fy: '2', _port_fz: '3' }),
      node('ps', 'periodicStep', { period: 4, phase: 1 }),
      node('gc', 'getConstant', { constType: 'integer', constValue: '5' }),
      node('mo', 'macroOutput', { macroDefId: 'def_a' }),
    ],
    edges: [
      edge('ea1', 'mi', 'sa', 'output_flow_in', 'input_flow_do'),
    ],
    exposedInputs: [
      { portId: 'in', label: 'In', dataType: 'flow', category: 'flow', internalNodeId: 'sa', internalPortId: 'do' },
    ],
    exposedOutputs: [],
  };
}

function buildModel(overrides = {}) {
  return {
    schemaVersion: 1,
    properties: { name: 'EC Fixture', dimension: '2d', gridWidth: 8, gridHeight: 8, updateMode: 'synchronous', boundaryTreatment: 'torus' },
    topologyMode: { gridCells: true, agents: true },
    attributes: [
      attr('a_alive', 'bool', { defaultValue: 'false' }),
      attr('a_count', 'integer'),
      attr('a_type', 'tag', { tagOptions: ['empty', 'wire', 'head'] }),
      attr('a_flow', 'vector', { vectorDims: 2 }),
      attr('a_speed', 'float', { isModelAttribute: true }),
    ],
    agentAttributes: [
      attr('ag_state', 'tag', { tagOptions: ['idle', 'run', 'rest'] }),
      attr('ag_energy', 'float'),
    ],
    bondAttributes: [attr('bond_w', 'float')],
    neighborhoods: [{ id: 'nb', name: 'moore', description: '', coords: [[0, 1], [1, 0], [0, -1], [-1, 0]] }],
    mappings: [], indicators: [], variables: [], agentVariables: [], sprites: [],
    macroDefs: [buildDefA()],
    graphNodes: [], graphEdges: [],
    centerBased: { maxBonds: 4, maxAgents: 64 },
    ...overrides,
  };
}

const defOf = (model, id) => (model.macroDefs ?? []).find(d => d.id === id);
const nodeOf = (model, defId, nodeId) => defOf(model, defId).nodes.find(n => n.id === nodeId);
const ctl = (id, name, target, extra = {}) => ({ id, name, target, ...extra });
const cfgTarget = (nodeId, configKey) => ({ kind: 'config', nodeId, configKey });

/** Replace ONE def in a model, leaving everything else `===`. */
const withDef = (model, def) => ({ ...model, macroDefs: model.macroDefs.map(d => (d.id === def.id ? def : d)) });

M.setActiveGraphKind('cells');

// ===========================================================================
console.log('\n--- Tier A: resolution --------------------------------------');
// ===========================================================================
{
  const model = buildModel();
  const D = (nodeId, key, m = model) =>
    M.resolveControlDescriptor(m, 'def_a', ctl('c1', 'C', cfgTarget(nodeId, key)));

  // Inventory 1 — inline port, number.
  const d1 = D('rnd', '_port_min');
  check('A1 inline number resolves kind+value', d1.kind === 'number' && d1.value === '2' && !d1.block, JSON.stringify(d1));
  // The DEFAULT comes from the port when the key is absent.
  const d1b = D('ca', '_port_radius');
  check('A2 absent key falls back to the port defaultValue', d1b.kind === 'number' && d1b.value === '1', JSON.stringify(d1b));

  // Inventory 5 — the ADAPTIVE `value` widget. The attribute is INTEGER here.
  const dInt = D('sa', '_port_value');
  check('A3 setAttribute.value follows an INTEGER attribute → number', dInt.kind === 'number' && dInt.value === '7', JSON.stringify(dInt));

  // …and it FOLLOWS a live retype driven through the REAL reducer (R4: a stored
  // kind would leave the control writing '7' into a bool/tag slot).
  const toBool = M.modelReducer(
    { model, isDirty: false, modelVersion: 0 },
    { type: 'UPDATE_MACRO', id: 'def_a', changes: { nodes: defOf(model, 'def_a').nodes.map(n => (n.id === 'sa' ? { ...n, data: { ...n.data, config: { ...n.data.config, attributeId: 'a_alive' } } } : n)) } },
  ).model;
  const dBool = D('sa', '_port_value', toBool);
  check('A4 the descriptor FOLLOWS a retype integer→bool', dBool.kind === 'bool', JSON.stringify(dBool));

  const toTag = M.modelReducer(
    { model, isDirty: false, modelVersion: 0 },
    { type: 'UPDATE_MACRO', id: 'def_a', changes: { nodes: defOf(model, 'def_a').nodes.map(n => (n.id === 'sa' ? { ...n, data: { ...n.data, config: { ...n.data.config, attributeId: 'a_type' } } } : n)) } },
  ).model;
  const dTag = D('sa', '_port_value', toTag);
  check('A5 the descriptor FOLLOWS a retype → tag', dTag.kind === 'tag', JSON.stringify(dTag));
  check('A6 the tag OPTIONS come from the NEW attribute', eq(dTag.options, [
    { value: '0', label: 'empty' }, { value: '1', label: 'wire' }, { value: '2', label: 'head' },
  ]), JSON.stringify(dTag.options));

  // A VECTOR attribute suppresses the inline widget entirely.
  const toVec = M.modelReducer(
    { model, isDirty: false, modelVersion: 0 },
    { type: 'UPDATE_MACRO', id: 'def_a', changes: { nodes: defOf(model, 'def_a').nodes.map(n => (n.id === 'sa' ? { ...n, data: { ...n.data, config: { ...n.data.config, attributeId: 'a_flow' } } } : n)) } },
  ).model;
  check('A7 a VECTOR attribute makes the value key non-eligible', D('sa', '_port_value', toVec).block === 'orphan-key');

  // Inventory 6 — Compare's operands swap with compareType.
  check('A8 Compare operand is number under compareType=numerical', D('cmp', '_port_x').kind === 'number');
  const cmpTag = withDef(model, { ...defOf(model, 'def_a'), nodes: defOf(model, 'def_a').nodes.map(n => (n.id === 'cmp' ? { ...n, data: { ...n.data, config: { compareType: 'tag', tagAttributeId: 'a_type' } } } : n)) });
  const dCmpTag = D('cmp', '_port_x', cmpTag);
  check('A9 Compare operand follows compareType=tag (+ options)', dCmpTag.kind === 'tag' && dCmpTag.options?.length === 3, JSON.stringify(dCmpTag));
  const cmpNI = withDef(model, { ...defOf(model, 'def_a'), nodes: defOf(model, 'def_a').nodes.map(n => (n.id === 'cmp' ? { ...n, data: { ...n.data, config: { compareType: 'neighborIndex' } } } : n)) });
  check('A10 compareType=neighborIndex leaves NO inline widget', D('cmp', '_port_x', cmpNI).block === 'orphan-key');

  // Inventory 9/10/11/12 — class B.
  const b1 = D('rnd', 'randomType');
  check('A11 class-B enum select resolves kind+value+options', b1.kind === 'select' && b1.value === 'float' && b1.options.some(o => o.value === 'orientation'), JSON.stringify(b1));
  const b2 = D('sw', 'firstMatchOnly');
  check('A12 class-B checkbox resolves', b2.kind === 'checkbox' && b2.value === 'true', JSON.stringify(b2));
  const b3 = D('ps', 'period');
  check('A13 class-B body number resolves', b3.kind === 'number' && b3.value === '4', JSON.stringify(b3));
  const b4 = D('ex', 'expression');
  check('A14 class-B textarea (the Expression formula) resolves', b4.kind === 'textarea' && b4.value === 'a + b', JSON.stringify(b4));
  const b5 = D('ps', 'phase');
  check('A15 an absent class-B key falls back to the spec default', b5.value === '1');

  // The class-B ADAPTIVE row: getConstant.constValue follows constType.
  check('A16 getConstant.constValue is a NUMBER under constType=integer', D('gc', 'constValue').kind === 'number');
  const gcBool = withDef(model, { ...defOf(model, 'def_a'), nodes: defOf(model, 'def_a').nodes.map(n => (n.id === 'gc' ? { ...n, data: { ...n.data, config: { constType: 'bool', constValue: 'true' } } } : n)) });
  const dGcBool = D('gc', 'constValue', gcBool);
  check('A17 getConstant.constValue becomes a SELECT under constType=bool', dGcBool.kind === 'select' && dGcBool.options.length === 2, JSON.stringify(dGcBool));

  // --- WIRED (D2) ---------------------------------------------------------
  const wired = withDef(model, { ...defOf(model, 'def_a'), edges: [...defOf(model, 'def_a').edges, edge('ew', 'rnd', 'sa', 'output_value_value', 'input_value_value')] });
  const dW = M.resolveControlDescriptor(wired, 'def_a', ctl('c1', 'C', cfgTarget('sa', '_port_value')));
  check('A18 a WIRED port reports block=wired with its reason', dW.block === 'wired' && dW.reason === M.CONTROL_BLOCK_REASON.wired, JSON.stringify(dW));
  check('A19 …and it still RESOLVES (report, never drop)', !!dW.resolved && dW.resolved.nodeId === 'sa');
  check('A20 unwiring it makes the control live again', !D('sa', '_port_value').block);

  // --- ORPHANS ------------------------------------------------------------
  const noNode = withDef(model, { ...defOf(model, 'def_a'), nodes: defOf(model, 'def_a').nodes.filter(n => n.id !== 'sa') });
  const dOrph = M.resolveControlDescriptor(noNode, 'def_a', ctl('c1', 'C', cfgTarget('sa', '_port_value')));
  check('A21 a deleted target node reports orphan-node', dOrph.block === 'orphan-node' && dOrph.reason === M.CONTROL_BLOCK_REASON['orphan-node']);
  check('A22 a key the node does not have reports orphan-key', D('rnd', '_port_nope').block === 'orphan-key');

  // --- R7: the owning def is OPEN for editing -----------------------------
  const dScope = M.resolveControlDescriptor(model, 'def_a', ctl('c1', 'C', cfgTarget('rnd', '_port_min')), ['def_a']);
  check('A23 the OPEN scope blocks the instance-side write (R7)', dScope.block === 'scope-open');
  check('A24 …and an unrelated open scope does not', !M.resolveControlDescriptor(model, 'def_a', ctl('c1', 'C', cfgTarget('rnd', '_port_min')), ['def_other']).block);

  // --- eligibility sweep --------------------------------------------------
  const keysOf = (nodeId, m = model, ...rest) =>
    M.eligibleControlKeys(nodeOf(m, 'def_a', nodeId).data.nodeType, nodeOf(m, 'def_a', nodeId).data.config, m, ...rest)
      .map(k => k.configKey);

  const fbKeys = keysOf('fb');
  check('A25 NEVER offers a _port_bondAttr_* key (D2b)', !fbKeys.some(k => k.startsWith('_port_bondAttr_')), fbKeys.join(','));
  check('A26 …while still offering that node\'s ordinary ports', fbKeys.length > 0, fbKeys.join(','));
  const dvKeys = keysOf('dv');
  check('A27 NEVER offers a partTag_* key (D2b)', !dvKeys.some(k => k.startsWith('partTag_')), dvKeys.join(','));
  check('A28 …and DOES offer divideAgent\'s class-B enums', dvKeys.includes('partition') && dvKeys.includes('conserve'), dvKeys.join(','));
  const exKeys = keysOf('ex');
  check('A29 NEVER offers a count stepper', !exKeys.includes('visibleCount'), exKeys.join(','));
  check('A30 NEVER offers a _varName_* key', !exKeys.some(k => k.startsWith('_varName_')), exKeys.join(','));
  check('A31 NEVER offers a display-only layout key', !exKeys.includes('_exprW') && !exKeys.includes('_exprH'), exKeys.join(','));
  check('A32 …and DOES offer the Expression formula', exKeys.includes('expression'), exKeys.join(','));
  const swKeys = keysOf('sw');
  check('A33 NEVER offers caseCount', !swKeys.includes('caseCount'), swKeys.join(','));

  // The predicate itself, per shape.
  for (const [k, want] of [
    ['_port_bondAttr_bond_w', true], ['partTag_3', true], ['_varName_a', true],
    ['stop_2_position', true], ['entry_0_r', true], ['default_g', true],
    ['extraCount', true], ['caseCount', true], ['visibleCount', true],
    ['payloadCount', true], ['axisCount', true],
    ['_exprW', true], ['_exprH', true], ['_namesExpanded', true], ['_exprExpanded', true],
    ['_port_value', false], ['operation', false], ['attributeId', false],
  ]) check(`A34 isExcludedControlKey('${k}') === ${want}`, M.isExcludedControlKey(k) === want);

  // A wired port is still OFFERED, flagged.
  const wiredRow = M.eligibleControlKeys('setAttribute', nodeOf(model, 'def_a', 'sa').data.config, model, new Set(['input_value_value']))
    .find(r => r.configKey === '_port_value');
  check('A35 pick mode OFFERS a wired port, flagged', !!wiredRow && wiredRow.wired === true, JSON.stringify(wiredRow));

  // --- the class gate, FLIPPED by P4 ---------------------------------------
  const withoutC = M.eligibleControlKeys('setAttribute', nodeOf(model, 'def_a', 'sa').data.config, model, undefined, new Set(['A', 'B']));
  check('A36 the DEFAULT classes now offer element rows (the P4 flip)', keysOf('sa').includes('attributeId'));
  check('A37 elementOptionsFor returns the LIST (the P4 extraction)',
    (M.elementOptionsFor('setAttribute', 'attributeId', model) ?? []).some(o => o.value === 'a_count'));
  check('A38 …and excluding class C still offers nothing', !withoutC.some(r => r.klass === 'C'));
  check('A39 CLASS_C_KEYS names the 11 model-element keys', M.CLASS_C_KEYS.size === 11 && M.CLASS_C_KEYS.has('attributeId') && M.CLASS_C_KEYS.has('presetId'));

  // --- 2D vs 3D (hiddenPorts through getEffectivePorts) -------------------
  const model3d = buildModel({ properties: { ...buildModel().properties, dimension: '3d', gridDepth: 8 } });
  check('A40 2D does NOT offer createAgent._port_z', !keysOf('ca').includes('_port_z'), keysOf('ca').join(','));
  check('A41 3D DOES offer createAgent._port_z', keysOf('ca', model3d).includes('_port_z'), keysOf('ca', model3d).join(','));
  check('A42 2D does NOT offer applyForce._port_fz', !keysOf('af').includes('_port_fz'), keysOf('af').join(','));
  check('A43 3D DOES offer applyForce._port_fz', keysOf('af', model3d).includes('_port_fz'), keysOf('af', model3d).join(','));
  check('A44 a 2D-hidden key resolves as orphan-key', D('ca', '_port_z').block === 'orphan-key');
  check('A45 …and resolves LIVE in 3D', D('ca', '_port_z', model3d).value === '3');

  // --- graph kind (D10) ---------------------------------------------------
  // The SAME setAttribute node, the SAME control, on the two graphs: the tag
  // options must come from the ACTIVE graph's own attribute set.
  const tagCells = M.resolveControlDescriptor(toTag, 'def_a', ctl('c1', 'C', cfgTarget('sa', '_port_value')));
  M.setActiveGraphKind('agents');
  const agentTag = withDef(model, { ...defOf(model, 'def_a'), nodes: defOf(model, 'def_a').nodes.map(n => (n.id === 'sa' ? { ...n, data: { ...n.data, config: { attributeId: 'ag_state', _port_value: '1' } } } : n)) });
  const tagAgents = M.resolveControlDescriptor(agentTag, 'def_a', ctl('c1', 'C', cfgTarget('sa', '_port_value')));
  check('A46 on Agents the options come from agentAttributes (D10)', eq(tagAgents.options, [
    { value: '0', label: 'idle' }, { value: '1', label: 'run' }, { value: '2', label: 'rest' },
  ]), JSON.stringify(tagAgents.options));
  check('A47 the CELL attribute is NOT resolvable on the Agents graph', M.resolveControlDescriptor(toTag, 'def_a', ctl('c1', 'C', cfgTarget('sa', '_port_value'))).block === 'orphan-key');
  M.setActiveGraphKind('cells');
  check('A48 …and on Cells it resolves from model.attributes', eq(tagCells.options, [
    { value: '0', label: 'empty' }, { value: '1', label: 'wire' }, { value: '2', label: 'head' },
  ]));
  check('A49 ownAttrListFor / tagAttrScopeFor follow the active graph', (() => {
    const cells = M.ownAttrListFor(model).map(a => a.id);
    M.setActiveGraphKind('agents');
    const agents = M.ownAttrListFor(model).map(a => a.id);
    M.setActiveGraphKind('cells');
    return cells.includes('a_count') && !cells.includes('ag_state') && agents.includes('ag_state') && !agents.includes('a_count');
  })());

  // --- the subtitle the editor shows --------------------------------------
  const sub = M.describeControlTarget(model, 'def_a', ctl('c1', 'C', cfgTarget('rnd', '_port_min')));
  check('A50 describeControlTarget names node + parameter', /Random/i.test(sub.text) && /Min/i.test(sub.text), sub.text);
  check('A51 …and an unresolvable target shows its REASON', M.describeControlTarget(noNode, 'def_a', ctl('c1', 'C', cfgTarget('sa', '_port_value'))).text === M.CONTROL_BLOCK_REASON['orphan-node']);
  // The node half prefers the author's OWN rename: the editor must name the box
  // they labelled, not one of the four Compare nodes on the canvas.
  const renamedNode = withDef(model, { ...defOf(model, 'def_a'), nodes: defOf(model, 'def_a').nodes.map(n => (n.id === 'rnd' ? { ...n, data: { ...n.data, label: 'Jitter' } } : n)) });
  check('A52 …and it prefers the node\'s USER LABEL over the type label',
    M.describeControlTarget(renamedNode, 'def_a', ctl('c1', 'C', cfgTarget('rnd', '_port_min'))).text === 'Jitter · Min',
    M.describeControlTarget(renamedNode, 'def_a', ctl('c1', 'C', cfgTarget('rnd', '_port_min'))).text);
}

// ===========================================================================
console.log('\n--- Tier B: the clone (F1 / R1 / R2) ------------------------');
// ===========================================================================
{
  const base = buildDefA();
  const withCtls = {
    ...base,
    controls: [
      ctl('ctl_1', 'Seed min', cfgTarget('rnd', '_port_min'), { groupId: 'g_tuning', description: 'the low bound' }),
      ctl('ctl_2', 'Cell value', cfgTarget('sa', '_port_value')),
      ctl('ctl_3', 'Nested', { kind: 'control', nodeId: 'inner', controlId: 'inner_ctl' }),
    ],
    groups: [{ id: 'g_tuning', name: 'Tuning' }, { id: 'g_adv', name: 'Advanced' }],
    exposedInputs: base.exposedInputs.map(p => ({ ...p, groupId: 'g_tuning' })),
    nodes: [...base.nodes, node('inner', 'macro', { macroDefId: 'def_b' })],
  };
  const cloned = M.cloneMacroWithFreshIds(withCtls);

  check('B1 controls SURVIVE the clone', Array.isArray(cloned.controls) && cloned.controls.length === 3, JSON.stringify(cloned.controls));
  check('B2 groups SURVIVE the clone', eq(cloned.groups, withCtls.groups));
  // Keep every LATER check reportable when B1 fails (the "revert the literal"
  // negative control) — a crash here would hide the rest of the tier.
  if (!Array.isArray(cloned.controls)) cloned.controls = [{ id: '?', name: '?', target: cfgTarget('?', '?') }, { id: '?', name: '?', target: cfgTarget('?', '?') }, { id: '?', name: '?', target: { kind: 'control', nodeId: '?', controlId: '?' } }];
  if (!Array.isArray(cloned.groups)) cloned.groups = [];
  check('B3 the PORT groupId survives', cloned.exposedInputs[0].groupId === 'g_tuning');

  // Build old→new node maps by structural identity (the config values are unique).
  const newById = new Map(cloned.nodes.map(n => [n.id, n]));
  const oldById = new Map(withCtls.nodes.map(n => [n.id, n]));
  const idOfType = (nodes, nodeType, marker) => nodes.find(n => n.data.nodeType === nodeType && (marker === undefined || JSON.stringify(n.data.config).includes(marker)))?.id;
  const newRnd = idOfType(cloned.nodes, 'getRandom');
  const newSa = idOfType(cloned.nodes, 'setAttribute');
  const newInner = idOfType(cloned.nodes, 'macro');

  check('B4 every node id was REGENERATED', cloned.nodes.every(n => !oldById.has(n.id)));
  check('B5 target.nodeId REMAPPED — config kind', cloned.controls[0].target.nodeId === newRnd && cloned.controls[0].target.nodeId !== 'rnd', cloned.controls[0].target.nodeId);
  check('B6 target.nodeId REMAPPED — the second config control', cloned.controls[1].target.nodeId === newSa && cloned.controls[1].target.nodeId !== 'sa');
  check('B7 target.nodeId REMAPPED — CONTROL (chained) kind too', cloned.controls[2].target.nodeId === newInner && cloned.controls[2].target.nodeId !== 'inner', cloned.controls[2].target.nodeId);
  check('B8 control.id PRESERVED', cloned.controls.map(c => c.id).join(',') === 'ctl_1,ctl_2,ctl_3');
  check('B9 control.groupId PRESERVED', cloned.controls[0].groupId === 'g_tuning');
  check('B10 control.name + description VERBATIM', cloned.controls[0].name === 'Seed min' && cloned.controls[0].description === 'the low bound');
  check('B11 target.configKey PRESERVED', cloned.controls[0].target.configKey === '_port_min');
  check('B12 chained target.controlId PRESERVED (the portId rule)', cloned.controls[2].target.controlId === 'inner_ctl');
  check('B13 group.id PRESERVED', cloned.groups.map(g => g.id).join(',') === 'g_tuning,g_adv');

  // R2 — the failure mode WORSE than a vanished control: it survives and edits
  // the WRONG node. Resolve on both sides and compare what the address lands on.
  const modelBefore = buildModel({ macroDefs: [withCtls] });
  const modelAfter = buildModel({ macroDefs: [{ ...cloned, id: 'def_a' }] });
  const identityOf = (m, key) => {
    const c = (m.macroDefs[0].controls ?? []).find(x => x.target.configKey === key);
    if (!c) return `NO CONTROL for ${key}`;
    const d = M.resolveControlDescriptor(m, 'def_a', c);
    const n = m.macroDefs[0].nodes.find(x => x.id === d.resolved?.nodeId);
    return `${n?.data.nodeType}:${JSON.stringify(n?.data.config)}`;
  };
  check('B14 a control never resolves to a node it did not name (R2)',
    identityOf(modelBefore, '_port_min') === identityOf(modelAfter, '_port_min'),
    `${identityOf(modelBefore, '_port_min')} vs ${identityOf(modelAfter, '_port_min')}`);
  check('B15 …and the second control likewise',
    identityOf(modelBefore, '_port_value') === identityOf(modelAfter, '_port_value'));
  check('B16 the cloned control still resolves to a LIVE value',
    M.resolveControlDescriptor(modelAfter, 'def_a', cloned.controls[0]).value === '2');

  // Invariant 8 — a control-free def clones with NO `controls` key at all.
  const plain = M.cloneMacroWithFreshIds(buildDefA());
  check('B17 a control-free def clones with NO `controls` key', !('controls' in plain), Object.keys(plain).join(','));
  check('B18 …and NO `groups` key', !('groups' in plain), Object.keys(plain).join(','));
  check('B19 the clone still remaps ports as it always did', plain.exposedInputs[0].internalNodeId !== 'sa' && plain.nodes.some(n => n.id === plain.exposedInputs[0].internalNodeId));
}

// ===========================================================================
console.log('\n--- Tier C: round trips -------------------------------------');
// ===========================================================================
{
  const def = {
    ...buildDefA(),
    controls: [ctl('ctl_1', 'Seed min', cfgTarget('rnd', '_port_min'), { groupId: 'g1', description: 'lo' })],
    groups: [{ id: 'g1', name: 'Tuning' }],
    exposedInputs: buildDefA().exposedInputs.map(p => ({ ...p, groupId: 'g1' })),
  };
  const model = buildModel({ macroDefs: [def] });

  // --- .gcaproj -----------------------------------------------------------
  const json = M.serializeModel(model);
  const back = M.parseModelJSON(json);
  check('C1 .gcaproj preserves controls VERBATIM', eq(back.macroDefs[0].controls, def.controls), JSON.stringify(back.macroDefs[0].controls));
  check('C2 .gcaproj preserves groups VERBATIM', eq(back.macroDefs[0].groups, def.groups));
  check('C3 .gcaproj preserves MacroPort.groupId', back.macroDefs[0].exposedInputs[0].groupId === 'g1');

  // R9 — `stringifyCompact` inlines an array by its parent KEY NAME
  // (`nodes`/`edges`/`coords`). `controls`/`groups` must PRETTY-PRINT.
  check('C4 stringifyCompact does NOT inline `controls`', /"controls":\s*\[\s*\n/.test(json), json.slice(json.indexOf('"controls"'), json.indexOf('"controls"') + 60));
  check('C5 stringifyCompact does NOT inline `groups`', /"groups":\s*\[\s*\n/.test(json));

  // …and an ABSENT record must not appear at all (invariant 8).
  const plainJson = M.serializeModel(buildModel());
  check('C6 a control-free model writes NO `controls` key', !plainJson.includes('"controls"'));
  check('C7 …and NO `groups` key', !plainJson.includes('"groups"'));

  // --- .gcamacro ----------------------------------------------------------
  const file = M.buildMacroFile(def, { description: 'x' });
  const roundTripped = M.parseMacroFile(JSON.stringify(file));
  check('C8 .gcamacro preserves controls VERBATIM', eq(roundTripped.macroDef.controls, def.controls));
  check('C9 .gcamacro preserves groups VERBATIM', eq(roundTripped.macroDef.groups, def.groups));

  // An OLD-shape file loads with none (back-compat both ways).
  const oldFile = M.parseMacroFile(JSON.stringify({ schemaVersion: 1, name: 'old', macroDef: buildDefA() }));
  check('C10 an OLD-shape .gcamacro loads with NO controls', !('controls' in oldFile.macroDef));
  // The format never gates on schemaVersion.
  const v99 = M.parseMacroFile(JSON.stringify({ ...file, schemaVersion: 99 }));
  check('C11 schemaVersion: 99 still parses (unknown keys are ignored)', eq(v99.macroDef.controls, def.controls));

  // A MALFORMED record is DROPPED, never thrown past the two named errors.
  const bad = M.parseMacroFile(JSON.stringify({ schemaVersion: 1, name: 'b', macroDef: { ...def, controls: 7, groups: 'nope' } }));
  check('C12 a malformed `controls` is DROPPED not thrown', !('controls' in bad.macroDef), JSON.stringify(bad.macroDef.controls));
  check('C13 a malformed `groups` is DROPPED not thrown', !('groups' in bad.macroDef));
  const badNested = M.parseMacroFile(JSON.stringify({ schemaVersion: 1, name: 'b', macroDef: buildDefA(), macroDefs: [{ ...def, controls: { nope: 1 } }] }));
  check('C14 …in a NESTED def too', !('controls' in badNested.macroDefs[0]) && eq(badNested.macroDefs[0].groups, def.groups));
  check('C15 a CLEAN def is passed through by IDENTITY', M.parseMacroFile(JSON.stringify(file)).macroDef !== undefined);

  // --- the cross-tab clipboard -------------------------------------------
  store.clear();
  M.writeGraphClipboard({ kind: 'cells', nodes: [node('mx', 'macro', { macroDefId: 'def_a' })], edges: [], macroDefs: [def] });
  const read = M.readGraphClipboard();
  check('C16 the cross-tab clipboard round-trips controls', eq(read.payload.macroDefs[0].controls, def.controls), JSON.stringify(read?.payload?.macroDefs?.[0]?.controls));
  check('C17 …and groups', eq(read.payload.macroDefs[0].groups, def.groups));
}

// ===========================================================================
console.log('\n--- Tier D: chaining resolution (D4) ------------------------');
// ===========================================================================
{
  // A ─(instance nA_b)→ B ─(instance nB_c)→ C, whose `leaf` node owns the key.
  const defC = {
    id: 'def_c', name: 'C', nodes: [node('leaf', 'getRandom', { randomType: 'float', _port_min: '42' })], edges: [],
    exposedInputs: [], exposedOutputs: [],
    controls: [ctl('c_leaf', 'Leaf min', cfgTarget('leaf', '_port_min'))],
  };
  const defB = {
    id: 'def_b', name: 'B', nodes: [node('nB_c', 'macro', { macroDefId: 'def_c' })], edges: [],
    exposedInputs: [], exposedOutputs: [],
    controls: [ctl('c_mid', 'Mid', { kind: 'control', nodeId: 'nB_c', controlId: 'c_leaf' })],
  };
  const defA = {
    id: 'def_a2', name: 'A', nodes: [node('nA_b', 'macro', { macroDefId: 'def_b' })], edges: [],
    exposedInputs: [], exposedOutputs: [],
    controls: [ctl('c_top', 'Top', { kind: 'control', nodeId: 'nA_b', controlId: 'c_mid' })],
  };
  const model = buildModel({ macroDefs: [defA, defB, defC] });

  const r = M.resolveTarget(model.macroDefs, 'def_a2', defA.controls[0].target);
  check('D1 A→B→C resolves to the ULTIMATE address in C', r.ok && r.at?.defId === 'def_c' && r.at.nodeId === 'leaf' && r.at.configKey === '_port_min', JSON.stringify(r));
  const d = M.resolveControlDescriptor(model, 'def_a2', defA.controls[0]);
  check('D2 …and the descriptor reads C\'s LIVE value', d.value === '42' && d.kind === 'number' && !d.block, JSON.stringify(d));

  // A 2-CYCLE: B's control points back at A's.
  const cycModel = buildModel({
    macroDefs: [
      { ...defA, nodes: [node('nA_b', 'macro', { macroDefId: 'def_b' })], controls: [ctl('c_top', 'Top', { kind: 'control', nodeId: 'nA_b', controlId: 'c_mid' })] },
      { ...defB, nodes: [node('nB_a', 'macro', { macroDefId: 'def_a2' })], controls: [ctl('c_mid', 'Mid', { kind: 'control', nodeId: 'nB_a', controlId: 'c_top' })] },
      defC,
    ],
  });
  const rc = M.resolveTarget(cycModel.macroDefs, 'def_a2', cycModel.macroDefs[0].controls[0].target);
  check('D3 a 2-cycle TERMINATES and reports block=cycle', !rc.ok && rc.block === 'cycle', JSON.stringify(rc));
  check('D4 …and the descriptor shows the reason', M.resolveControlDescriptor(cycModel, 'def_a2', cycModel.macroDefs[0].controls[0]).reason === M.CONTROL_BLOCK_REASON.cycle);

  // A SELF-cycle: a def whose control points at its own instance's control.
  const selfDef = {
    id: 'def_s', name: 'S', nodes: [node('me', 'macro', { macroDefId: 'def_s' })], edges: [],
    exposedInputs: [], exposedOutputs: [],
    controls: [ctl('c_self', 'Self', { kind: 'control', nodeId: 'me', controlId: 'c_self' })],
  };
  const selfModel = buildModel({ macroDefs: [selfDef] });
  const rs = M.resolveTarget(selfModel.macroDefs, 'def_s', selfDef.controls[0].target);
  check('D5 a SELF-cycle terminates and reports', !rs.ok && rs.block === 'cycle', JSON.stringify(rs));

  // A chain LONGER than the depth cap reports rather than recursing.
  const N = M.CONTROL_MAX_CHAIN_DEPTH + 3;
  const deepDefs = [];
  for (let i = 0; i < N; i++) {
    deepDefs.push(i === N - 1
      ? { id: `d${i}`, name: `d${i}`, nodes: [node('leaf', 'getRandom', { randomType: 'float', _port_min: '1' })], edges: [], exposedInputs: [], exposedOutputs: [], controls: [ctl('c', 'c', cfgTarget('leaf', '_port_min'))] }
      : { id: `d${i}`, name: `d${i}`, nodes: [node('nx', 'macro', { macroDefId: `d${i + 1}` })], edges: [], exposedInputs: [], exposedOutputs: [], controls: [ctl('c', 'c', { kind: 'control', nodeId: 'nx', controlId: 'c' })] });
  }
  const deepModel = buildModel({ macroDefs: deepDefs });
  const rd = M.resolveTarget(deepModel.macroDefs, 'd0', deepDefs[0].controls[0].target);
  check(`D6 a depth-${N} chain reports rather than recursing`, !rd.ok && rd.block === 'cycle', JSON.stringify(rd));

  // Orphans along the chain.
  const noInner = buildModel({ macroDefs: [defA, { ...defB, controls: [] }, defC] });
  check('D7 a deleted INNER control reports orphan-control', M.resolveControlDescriptor(noInner, 'def_a2', defA.controls[0]).block === 'orphan-control');
  const noDef = buildModel({ macroDefs: [defA, defC] });
  check('D8 a deleted nested DEF reports orphan-def', M.resolveControlDescriptor(noDef, 'def_a2', defA.controls[0]).block === 'orphan-def');
  const notMacro = buildModel({ macroDefs: [{ ...defA, nodes: [node('nA_b', 'getRandom', {})] }, defB, defC] });
  check('D9 a chained target on a NON-macro node reports orphan-node', M.resolveControlDescriptor(notMacro, 'def_a2', defA.controls[0]).block === 'orphan-node');

  // The `controlId`-preserved argument: clone A **and** B in ONE operation
  // (applyImportPlan's two-def shape) and assert the chain still resolves.
  const cA = M.cloneMacroWithFreshIds(defA);
  const cB = M.cloneMacroWithFreshIds(defB);
  const cC = M.cloneMacroWithFreshIds(defC);
  // remapNestedMacroRefs' job: retarget each instance's macroDefId to the clone.
  const remap = new Map([['def_a2', cA.id], ['def_b', cB.id], ['def_c', cC.id]]);
  const retarget = d => ({ ...d, nodes: d.nodes.map(n => (n.data.nodeType === 'macro' && remap.has(n.data.config.macroDefId) ? { ...n, data: { ...n.data, config: { ...n.data.config, macroDefId: remap.get(n.data.config.macroDefId) } } } : n)) });
  const clonedModel = buildModel({ macroDefs: [retarget(cA), retarget(cB), retarget(cC)] });
  const rClone = M.resolveControlDescriptor(clonedModel, cA.id, cA.controls[0]);
  check('D10 cloning A and B in ONE operation keeps the chain resolving', rClone.value === '42' && !rClone.block, JSON.stringify(rClone));
  check('D11 …landing in the CLONED leaf def, not the original', rClone.resolved?.defId === cC.id);
}

// ===========================================================================
console.log('\n--- Tier E: the write path (D6) -----------------------------');
// ===========================================================================
{
  const def = {
    ...buildDefA(),
    controls: [
      ctl('ctl_1', 'Seed min', cfgTarget('rnd', '_port_min')),
      ctl('ctl_w', 'Wired', cfgTarget('sa', '_port_value')),
    ],
    groups: [{ id: 'g1', name: 'Tuning' }],
  };
  const model = buildModel({ macroDefs: [def] });

  const patch = M.applyControlValue(model, 'def_a', def.controls[0], '99');
  check('E1 applyControlValue names the def that OWNS the key', patch.defId === 'def_a');
  const next = M.modelReducer({ model, isDirty: false, modelVersion: 0 },
    { type: 'UPDATE_MACRO', id: patch.defId, changes: { nodes: patch.nodes } }).model;
  const nDef = defOf(next, 'def_a');

  check('E2 exactly ONE node\'s ONE key changed', nodeOf(next, 'def_a', 'rnd').data.config._port_min === '99');
  check('E3 …and its SIBLING keys are untouched', nodeOf(next, 'def_a', 'rnd').data.config._port_max === '9' && nodeOf(next, 'def_a', 'rnd').data.config.randomType === 'float');
  const moved = nDef.nodes.filter((n, i) => n !== defOf(model, 'def_a').nodes[i]);
  check('E4 NO other node object moved (identity)', moved.length === 1 && moved[0].id === 'rnd', moved.map(n => n.id).join(','));
  check('E5 `controls` is === untouched', nDef.controls === def.controls);
  check('E6 `groups` is === untouched', nDef.groups === def.groups);
  check('E7 `edges` is === untouched', nDef.edges === def.edges);
  check('E8 the control now READS the new value', M.resolveControlDescriptor(next, 'def_a', def.controls[0]).value === '99');

  // A SECOND edit sees the first (the write is built from LIVE state).
  const patch2 = M.applyControlValue(next, 'def_a', def.controls[0], '100');
  const next2 = M.modelReducer({ model: next, isDirty: false, modelVersion: 0 },
    { type: 'UPDATE_MACRO', id: patch2.defId, changes: { nodes: patch2.nodes } }).model;
  check('E9 a second edit sees the first', M.resolveControlDescriptor(next2, 'def_a', def.controls[0]).value === '100');

  // A LINKED second instance reads the same def — sharing is the point (D1).
  const linked = { ...next2, graphNodes: [node('mx1', 'macro', { macroDefId: 'def_a' }), node('mx2', 'macro', { macroDefId: 'def_a' })] };
  check('E10 two LINKED instances read the same value (D1)',
    M.countMacroInstances(linked, 'def_a') === 2 &&
    M.resolveControlDescriptor(linked, 'def_a', def.controls[0]).value === '100');

  // A BLOCKED control's write is INERT (a disabled row's handler must do nothing).
  const wiredModel = withDef(model, { ...def, edges: [...def.edges, edge('ew', 'rnd', 'sa', 'output_value_value', 'input_value_value')] });
  check('E11 a WIRED control\'s write is inert (returns null)', M.applyControlValue(wiredModel, 'def_a', def.controls[1], '5') === null);
  const orphanModel = withDef(model, { ...def, nodes: def.nodes.filter(n => n.id !== 'rnd') });
  check('E12 an ORPHANED control\'s write is inert', M.applyControlValue(orphanModel, 'def_a', def.controls[0], '5') === null);
  check('E13 a SCOPE-OPEN control\'s write is inert (R7)', M.applyControlValue(model, 'def_a', def.controls[0], '5', ['def_a']) === null);

  // A CHAINED write lands in the NESTED def, and the outer def is untouched.
  const defInner = {
    id: 'def_in', name: 'In', nodes: [node('leaf', 'getRandom', { randomType: 'float', _port_min: '1' })], edges: [],
    exposedInputs: [], exposedOutputs: [], controls: [ctl('c_leaf', 'Leaf', cfgTarget('leaf', '_port_min'))],
  };
  const defOuter = {
    id: 'def_out', name: 'Out', nodes: [node('nx', 'macro', { macroDefId: 'def_in' })], edges: [],
    exposedInputs: [], exposedOutputs: [], controls: [ctl('c_out', 'Out', { kind: 'control', nodeId: 'nx', controlId: 'c_leaf' })],
  };
  const chainModel = buildModel({ macroDefs: [defOuter, defInner] });
  const cPatch = M.applyControlValue(chainModel, 'def_out', defOuter.controls[0], '77');
  // Reportable rather than a crash: the "dispatch the OUTER def" negative
  // control makes this return null, and a throw here would hide E15-E17.
  check('E14 a CHAINED write targets the NESTED def', cPatch?.defId === 'def_in', String(cPatch?.defId));
  const chained = cPatch
    ? M.modelReducer({ model: chainModel, isDirty: false, modelVersion: 0 },
      { type: 'UPDATE_MACRO', id: cPatch.defId, changes: { nodes: cPatch.nodes } }).model
    : chainModel;
  check('E15 …the value lands in the INNER node', nodeOf(chained, 'def_in', 'leaf').data.config._port_min === '77');
  check('E16 …and the OUTER def is === untouched', defOf(chained, 'def_out') === defOuter);
  check('E17 …and the chained control now reads it', M.resolveControlDescriptor(chained, 'def_out', defOuter.controls[0]).value === '77');
}

// ===========================================================================
console.log('\n--- Tier F: EMIT identity (the structural proof, R8) ---------');
// ===========================================================================
{
  // A COMPILABLE model whose Step chain runs THROUGH a macro instance, so the
  // def's internals really do reach every emitter.
  const emitDef = {
    id: 'def_e', name: 'E',
    nodes: [
      node('mi', 'macroInput', { macroDefId: 'def_e' }),
      node('sa', 'setAttribute', { attributeId: 'a_count', _port_value: '7' }),
    ],
    edges: [edge('e1', 'mi', 'sa', 'output_flow_in', 'input_flow_do')],
    exposedInputs: [{ portId: 'in', label: 'In', dataType: 'flow', category: 'flow', internalNodeId: 'sa', internalPortId: 'do' }],
    exposedOutputs: [],
  };
  const baseModel = M.migrateForHarness(buildModel({
    macroDefs: [emitDef],
    graphNodes: [node('st', 'step', {}), node('mx', 'macro', { macroDefId: 'def_e' })],
    graphEdges: [edge('g1', 'st', 'mx', 'output_flow_do', 'input_flow_in')],
  }));

  const surfaces = m => {
    const exp = M.expandMacros(m.graphNodes, m.graphEdges, m);
    const c = M.compileAll(m);
    return JSON.stringify({
      expandNodes: exp.nodes, expandEdges: exp.edges, expandError: exp.error,
      js: c.js.stepCode, jsFull: c.js.fullCode, jsErr: c.js.error,
      wasm: c.wasm.bytesJoined, wasmLen: c.wasm.bytesLen, wasmErr: c.wasm.error,
      wgsl: c.webgpu.shaderCode, wgslErr: c.webgpu.error,
    });
  };

  const baseline = surfaces(baseModel);
  check('F1 the fixture actually COMPILES (so the proof is not vacuous)',
    M.compileAll(baseModel).js.stepCode.length > 0 && !M.compileAll(baseModel).js.error,
    M.compileAll(baseModel).js.error ?? '');
  check('F2 …and its macro really EXPANDED (the internal node is emitted)',
    M.expandMacros(baseModel.graphNodes, baseModel.graphEdges, baseModel).nodes.some(n => n.data.nodeType === 'setAttribute'));

  const variants = {
    'one control added': { ...emitDef, controls: [ctl('k1', 'Value', cfgTarget('sa', '_port_value'))] },
    'the control RENAMED': { ...emitDef, controls: [ctl('k1', 'A totally different name', cfgTarget('sa', '_port_value'))] },
    'a second control + groups': {
      ...emitDef,
      controls: [ctl('k1', 'Value', cfgTarget('sa', '_port_value'), { groupId: 'g1' }), ctl('k2', 'Other', cfgTarget('sa', 'attributeId'))],
      groups: [{ id: 'g1', name: 'Tuning' }, { id: 'g2', name: 'Advanced' }],
    },
    'ports GROUPED': { ...emitDef, groups: [{ id: 'g1', name: 'Tuning' }], exposedInputs: emitDef.exposedInputs.map(p => ({ ...p, groupId: 'g1' })) },
    'every control DELETED again': { ...emitDef, controls: [], groups: [] },
  };
  for (const [name, def] of Object.entries(variants)) {
    const m = M.migrateForHarness({ ...baseModel, macroDefs: [def] });
    check(`F3 emit is BYTE-IDENTICAL — ${name}`, surfaces(m) === baseline);
  }

  // A control record must never leak into a node config — the accessorCSE
  // purity key hashes `node.data.config`, so a leak would perturb it (and the
  // byte-identity above is exactly what would break).
  const withCtl = M.migrateForHarness({ ...baseModel, macroDefs: [variants['a second control + groups']] });
  const expanded = M.expandMacros(withCtl.graphNodes, withCtl.graphEdges, withCtl);
  check('F4 no expanded node config mentions a control record',
    expanded.nodes.every(n => !Object.keys(n.data.config ?? {}).some(k => k === 'controls' || k === 'groups' || k.startsWith('ctl_'))));
  check('F5 the def-level records never reach the expanded graph',
    !JSON.stringify(expanded.nodes).includes('"A totally different name"') && !JSON.stringify(expanded.nodes).includes('Tuning'));

  // Nothing under compiler/ may import the resolver.
  const grep = (await import('fs')).readdirSync;
  const walk = d => grep(join(ROOT, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const compilerFiles = walk(join('src', 'modeler', 'vpl', 'compiler')).filter(f => f.endsWith('.ts'));
  const readFile = (await import('fs')).readFileSync;
  const offenders = compilerFiles.filter(f => readFile(join(ROOT, f), 'utf8').includes('explicitControls'));
  check('F6 NOTHING under compiler/ imports explicitControls', offenders.length === 0, offenders.join(','));
  const ctlMentions = compilerFiles.filter(f => /\bMacroControl\b|\.controls\b/.test(readFile(join(ROOT, f), 'utf8')));
  check('F7 no compiler file reads `.controls`', ctlMentions.length === 0, ctlMentions.join(','));
}

// ===========================================================================
console.log('\n--- Tier G: cascades + the closed instance (P3) --------------');
// ===========================================================================
{
  const { readFileSync } = await import('fs');
  const src = f => readFileSync(join(ROOT, f), 'utf8');

  /** Drive one reducer action the way the app dispatches it. */
  const run = (model, action) => M.modelReducer({ model, isDirty: false, modelVersion: 0 }, action).model;
  /** The in-macro edit path: patch ONE node's config through `UPDATE_MACRO`,
   *  which is exactly what the open canvas's debounced `scheduleSync` does. */
  const patchNode = (model, defId, nodeId, config) => run(model, {
    type: 'UPDATE_MACRO', id: defId,
    changes: {
      nodes: defOf(model, defId).nodes.map(n =>
        (n.id === nodeId ? { ...n, data: { ...n.data, config: { ...n.data.config, ...config } } } : n)),
    },
  });
  const descOf = (model, defId, controlId, openScopes) => {
    const c = defOf(model, defId).controls.find(k => k.id === controlId);
    return M.resolveControlDescriptor(model, defId, c, openScopes);
  };

  /** The def a closed instance renders: three controls (a class-A number, a
   *  class-B number and an ADAPTIVE class-A tag) and one group, so an ordering
   *  or a kind bug is legible in a failure message. */
  const instDef = () => ({
    id: 'def_g', name: 'G',
    nodes: [
      node('mi', 'macroInput', { macroDefId: 'def_g' }),
      node('rnd', 'getRandom', { randomType: 'float', distribution: 'uniform', _port_min: '2', _port_max: '9' }),
      node('ps', 'periodicStep', { period: 4, phase: 1 }),
      node('sa', 'setAttribute', { attributeId: 'a_type', _port_value: '2' }),
      node('mo', 'macroOutput', { macroDefId: 'def_g' }),
    ],
    edges: [],
    exposedInputs: [], exposedOutputs: [],
    controls: [
      ctl('c_max', 'Max', cfgTarget('rnd', '_port_max')),
      ctl('c_per', 'Period', cfgTarget('ps', 'period'), { groupId: 'gT' }),
      ctl('c_val', 'Kind', cfgTarget('sa', '_port_value')),
    ],
    groups: [{ id: 'gT', name: 'Tuning' }],
  });

  // --- SECTIONS: the instance renders in the EDITOR's order ----------------
  {
    const m0 = buildModel({ macroDefs: [instDef()] });
    const d = defOf(m0, 'def_g');
    const secs = M.groupSections(d.controls, d.groups);
    check('G1 ungrouped head first, then each group under its header',
      eq(secs.map(s => [s.group?.name ?? null, s.items.map(i => i.id)]),
        [[null, ['c_max', 'c_val']], ['Tuning', ['c_per']]]),
      JSON.stringify(secs.map(s => [s.group?.name ?? null, s.items.map(i => i.id)])));
    // THE structural claim: the instance's order IS `orderByGroup`'s — the same
    // call the boundary editor reorders `exposedInputs` with.
    check('G2 …and the FLATTENED sections are exactly `orderByGroup`',
      eq(secs.flatMap(s => s.items), M.orderByGroup(d.controls, d.groups)));
    check('G3 every control appears EXACTLY once', secs.flatMap(s => s.items).length === d.controls.length);

    const dead = M.groupSections(
      [ctl('x', 'X', cfgTarget('ps', 'period'), { groupId: 'gone' })], d.groups);
    check('G4 a DEAD groupId renders in the ungrouped head, not under a phantom header',
      dead.length === 1 && dead[0].group === undefined);
    check('G5 an EMPTY interface produces NO section (no header, no gap)',
      M.groupSections([], d.groups).length === 0);
  }

  // --- LIVE values, both directions (D1) -----------------------------------
  {
    let m = buildModel({ macroDefs: [instDef()] });
    check('G6 each control reads the target node\'s LIVE config',
      descOf(m, 'def_g', 'c_max').value === '9'
      && descOf(m, 'def_g', 'c_per').value === '4'
      && descOf(m, 'def_g', 'c_val').value === '2');
    check('G7 …and the KIND is derived, not stored (the tag control is a tag)',
      descOf(m, 'def_g', 'c_val').kind === 'tag'
      && eq(descOf(m, 'def_g', 'c_val').options?.map(o => o.label), ['empty', 'wire', 'head'])
      && descOf(m, 'def_g', 'c_max').kind === 'number'
      && descOf(m, 'def_g', 'c_per').kind === 'number');

    // INSIDE → INSTANCE: an in-macro edit reaches the instance with no
    // propagation machinery at all (there is one storage location).
    m = patchNode(m, 'def_g', 'rnd', { _port_max: '42' });
    check('G8 an IN-MACRO edit shows on the instance immediately', descOf(m, 'def_g', 'c_max').value === '42');

    // INSTANCE → INSIDE: `applyControlValue` + ONE `updateMacro`.
    const before = defOf(m, 'def_g');
    const patch = M.applyControlValue(m, 'def_g', before.controls[0], '7');
    check('G9 the write targets the def that OWNS the key', patch && patch.defId === 'def_g');
    const m2 = run(m, { type: 'UPDATE_MACRO', id: patch.defId, changes: { nodes: patch.nodes } });
    const after = defOf(m2, 'def_g');
    check('G10 …exactly one node\'s one key moved',
      nodeOf(m2, 'def_g', 'rnd').data.config._port_max === '7'
      && nodeOf(m2, 'def_g', 'rnd').data.config._port_min === '2');
    check('G11 …every UNTOUCHED node keeps its object identity',
      after.nodes.every((n, i) => n.id === 'rnd' || n === before.nodes[i]));
    check('G12 …`controls` / `groups` / `edges` are === untouched',
      after.controls === before.controls && after.groups === before.groups && after.edges === before.edges);
    check('G13 …and a SECOND read (a linked sibling instance) sees it',
      descOf(m2, 'def_g', 'c_max').value === '7');

    // Two instances of the SAME def on the canvas: both resolve from
    // `model.macroDefs`, so "linked instances share" is structural.
    const linked = { ...m2, graphNodes: [
      node('inst1', 'macro', { macroDefId: 'def_g' }),
      node('inst2', 'macro', { macroDefId: 'def_g' }),
    ] };
    check('G14 two instances share ONE def (the linked-count badge\'s input)',
      M.countMacroInstances(linked, 'def_g') === 2);
  }

  // --- the target node is DELETED inside the macro (D8) --------------------
  {
    const m0 = buildModel({ macroDefs: [instDef()] });
    const m = run(m0, {
      type: 'UPDATE_MACRO', id: 'def_g',
      changes: { nodes: defOf(m0, 'def_g').nodes.filter(n => n.id !== 'rnd') },
    });
    const d = descOf(m, 'def_g', 'c_max');
    check('G15 a deleted target node reports `orphan-node` with its reason',
      d.block === 'orphan-node' && d.reason === M.CONTROL_BLOCK_REASON['orphan-node']);
    check('G16 …the control is STILL PRESENT (report, never drop — Ctrl+Z must restore both)',
      defOf(m, 'def_g').controls.length === 3
      && !!defOf(m, 'def_g').controls.find(c => c.id === 'c_max'));
    check('G17 …it counts toward the instance BADGE', M.CONTROL_BLOCK_NEEDS_ATTENTION.has('orphan-node'));
    check('G18 …and its write is INERT (structurally, not by UI convention)',
      M.applyControlValue(m, 'def_g', defOf(m, 'def_g').controls[0], '1') === null);
    check('G19 …while the SIBLING controls are unaffected',
      !descOf(m, 'def_g', 'c_per').block && descOf(m, 'def_g', 'c_per').value === '4');
  }

  // --- a MODEL ELEMENT is deleted: the existing cascade does the work (F4) --
  {
    const m0 = buildModel({ macroDefs: [instDef()] });
    const m = run(m0, { type: 'REMOVE_ATTRIBUTE', id: 'a_type' });
    check('G20 the existing cascade cleared the id INSIDE `macroDefs[*].nodes` (F4)',
      nodeOf(m, 'def_g', 'sa').data.config.attributeId === '');
    check('G21 …unrelated controls still resolve LIVE',
      descOf(m, 'def_g', 'c_max').value === '9' && descOf(m, 'def_g', 'c_per').value === '4');
    // The bound `value` port's widget is ADAPTIVE: with no attribute the node
    // renders no value widget at all, so the parameter genuinely no longer
    // exists. Reported, not silently retyped to a bare number (P3.2).
    const dv = descOf(m, 'def_g', 'c_val');
    check('G22 …and the control bound to the now-typeless value reports `orphan-key`', dv.block === 'orphan-key');
    check('G23 …but is NOT deleted', !!defOf(m, 'def_g').controls.find(c => c.id === 'c_val'));
  }

  // --- a tagOptions REORDER remaps the bound index -------------------------
  {
    const m0 = buildModel({ macroDefs: [instDef()] });
    check('G24 (precondition) the tag control reads index 2 = "head"',
      descOf(m0, 'def_g', 'c_val').value === '2');
    // Move 'head' from index 2 to index 0 — the reducer remaps `_port_value`
    // inside macroDefs, so the control must follow the VALUE, not the index.
    const m = run(m0, { type: 'UPDATE_ATTRIBUTE', id: 'a_type', changes: { tagOptions: ['head', 'empty', 'wire'] } });
    const stored = nodeOf(m, 'def_g', 'sa').data.config._port_value;
    check('G25 the reducer remapped the stored index (2 → 0)', stored === '0', String(stored));
    const d = descOf(m, 'def_g', 'c_val');
    check('G26 …and the control reads the REMAPPED index, still naming "head"',
      d.value === stored && d.options?.[Number(d.value)]?.label === 'head', JSON.stringify(d.options));
  }

  // --- a CHAINED control: `orphan-control` then `orphan-def` ---------------
  {
    const outer = () => ({
      id: 'def_o', name: 'Outer',
      nodes: [node('mi', 'macroInput', { macroDefId: 'def_o' }), node('inner', 'macro', { macroDefId: 'def_g' })],
      edges: [], exposedInputs: [], exposedOutputs: [],
      controls: [ctl('c_chain', 'Chained max', { kind: 'control', nodeId: 'inner', controlId: 'c_max' })],
    });
    const m0 = buildModel({ macroDefs: [instDef(), outer()] });
    const chained = defOf(m0, 'def_o').controls[0];
    check('G27 (precondition) the chain resolves into the NESTED def',
      M.resolveControlDescriptor(m0, 'def_o', chained).value === '9'
      && M.applyControlValue(m0, 'def_o', chained, '5').defId === 'def_g');

    const noCtl = run(m0, {
      type: 'UPDATE_MACRO', id: 'def_g',
      changes: { controls: defOf(m0, 'def_g').controls.filter(c => c.id !== 'c_max') },
    });
    check('G28 removing the inner control reports `orphan-control`',
      M.resolveControlDescriptor(noCtl, 'def_o', chained).block === 'orphan-control');
    check('G29 …and the OUTER control is not deleted', defOf(noCtl, 'def_o').controls.length === 1);

    const noDef = run(m0, { type: 'REMOVE_MACRO', id: 'def_g' });
    check('G30 removing the nested DEF reports `orphan-def`',
      M.resolveControlDescriptor(noDef, 'def_o', chained).block === 'orphan-def');
    check('G31 …both orphan kinds count toward the badge',
      M.CONTROL_BLOCK_NEEDS_ATTENTION.has('orphan-control') && M.CONTROL_BLOCK_NEEDS_ATTENTION.has('orphan-def'));
  }

  // --- a bound port becomes WIRED, then unwired ----------------------------
  {
    const m0 = buildModel({ macroDefs: [instDef()] });
    const wired = run(m0, {
      type: 'UPDATE_MACRO', id: 'def_g',
      changes: { edges: [edge('ew', 'ps', 'rnd', 'output_flow_next', 'input_value_max')] },
    });
    const d = descOf(wired, 'def_g', 'c_max');
    check('G32 a WIRED target renders disabled with its reason',
      d.block === 'wired' && d.reason === M.CONTROL_BLOCK_REASON.wired);
    check('G33 …showing the value READ-ONLY (not blanked)', d.value === '9');
    check('G34 …its write is inert', M.applyControlValue(wired, 'def_g', defOf(wired, 'def_g').controls[0], '1') === null);
    check('G35 …and it does NOT badge — a wired parameter is a normal macro',
      !M.CONTROL_BLOCK_NEEDS_ATTENTION.has('wired'));
    const unwired = run(wired, { type: 'UPDATE_MACRO', id: 'def_g', changes: { edges: [] } });
    check('G36 unwiring makes it live again, at the same value',
      !descOf(unwired, 'def_g', 'c_max').block && descOf(unwired, 'def_g', 'c_max').value === '9');
  }

  // --- R7: the def is OPEN for editing ------------------------------------
  {
    const m0 = buildModel({ macroDefs: [instDef()] });
    const c = defOf(m0, 'def_g').controls[0];
    check('G37 a control whose def is OPEN renders disabled with the R7 reason',
      M.resolveControlDescriptor(m0, 'def_g', c, ['def_g']).block === 'scope-open');
    check('G38 …its write is inert (else the next debounce tick would clobber it)',
      M.applyControlValue(m0, 'def_g', c, '1', ['def_g']) === null);
    check('G39 …with the def CLOSED it is live', !M.resolveControlDescriptor(m0, 'def_g', c, []).block
      && M.applyControlValue(m0, 'def_g', c, '1', []) !== null);
    check('G40 …and it does NOT badge — the state lasts exactly as long as the macro is open',
      !M.CONTROL_BLOCK_NEEDS_ATTENTION.has('scope-open'));

    // A CHAINED control blocks on the def that OWNS THE KEY, not the outer one.
    const outer = {
      id: 'def_o2', name: 'Outer2',
      nodes: [node('inner', 'macro', { macroDefId: 'def_g' })], edges: [],
      exposedInputs: [], exposedOutputs: [],
      controls: [ctl('c_chain', 'Chained', { kind: 'control', nodeId: 'inner', controlId: 'c_max' })],
    };
    const m1 = { ...m0, macroDefs: [...m0.macroDefs, outer] };
    const ch = outer.controls[0];
    check('G41 a chained control blocks when the NESTED def is open',
      M.resolveControlDescriptor(m1, 'def_o2', ch, ['def_g']).block === 'scope-open');
    check('G42 …and NOT when only the outer def is open',
      !M.resolveControlDescriptor(m1, 'def_o2', ch, ['def_o2']).block);
  }

  // --- the open-scope mirror (the graphState global) ----------------------
  {
    let hits = 0;
    const un = M.subscribeOpenMacroScope(() => { hits++; });
    M.setOpenMacroScope(['root']);
    check('G43 the `root` sentinel is filtered out — it names no def',
      eq([...M.getOpenMacroScope()], []) && hits === 0);
    M.setOpenMacroScope(['root', 'def_g']);
    check('G44 a scope change notifies and exposes the def ids',
      hits === 1 && eq([...M.getOpenMacroScope()], ['def_g']));
    const ref = M.getOpenMacroScope();
    M.setOpenMacroScope(['root', 'def_g']);
    check('G45 an EQUAL scope keeps the SAME reference (useSyncExternalStore demands it)',
      hits === 1 && M.getOpenMacroScope() === ref);
    M.setOpenMacroScope(['root', 'def_g', 'def_o']);
    check('G46 a deeper scope notifies and carries the whole chain',
      hits === 2 && eq([...M.getOpenMacroScope()], ['def_g', 'def_o']));
    M.setOpenMacroScope([]);
    check('G47 clearing notifies', hits === 3 && M.getOpenMacroScope().length === 0);
    un();
    M.setOpenMacroScope(['root', 'x']);
    check('G48 unsubscribing really unsubscribes', hits === 3);
    M.setOpenMacroScope([]);
  }

  // --- the instance rendering, pinned in SOURCE (it lives in React) --------
  {
    const cn = src(join('src', 'modeler', 'vpl', 'CaNode.tsx'));
    check('G49 the instance renders with `groupSections` — the SAME order the editor applies',
      cn.includes('groupSections(controls, mdef?.groups ?? [])'));
    check('G50 …gated on a NON-EMPTY interface (no empty header — the enabled-control doctrine)',
      cn.includes("nodeData.nodeType === 'macro' && controlSections.length > 0"));
    // "Report, never drop", at the RENDER: a blocked control must still get a
    // row (disabled, with its reason). Filtering them out would hide the very
    // thing the author has to fix — and the def keeps them (G16) either way.
    check('G50b …and renders a row for EVERY control, blocked ones included',
      cn.includes('rows: sec.items.map(control => ({'));
    check('G51 the write is ONE `updateMacro`, at the def that OWNS the key',
      cn.includes('updateMacro(patch.defId, { nodes: patch.nodes });'));
    check('G52 …built from the LIVE model ref, never a captured closure',
      cn.includes('applyControlValue(modelRef.current, macroDefId, control, value, getOpenMacroScope())'));
    check('G53 …and a blocked control returns null, so the handler is inert',
      /const patch = M?\.?applyControlValue[\s\S]{0,120}?if \(!patch\) return;/.test(cn));
    check('G54 the badge rolls up only the BROKEN blocks',
      cn.includes('CONTROL_BLOCK_NEEDS_ATTENTION.has(r.desc.block)')
      && cn.includes("${controlIssueCount === 1 ? 'needs' : 'need'} attention"));
    // F6: handles are absolutely-positioned siblings rendered AFTER the body, so
    // body height moves NO handle. A control must therefore NOT trigger a
    // remeasure — and a port GROUP reorder gets one free from `portIdSignature`.
    const nudges = [...cn.matchAll(/updateNodeInternals\(id\);?\s*\n\s*\}, \[([^\]]*)\]/g)].map(m => m[1]);
    check('G55 NO `updateNodeInternals` depends on the controls (F6 — rows move no handle)',
      nudges.every(dep => !dep.includes('controlSections') && !dep.includes('controlIssueCount')),
      nudges.join(' | '));
    check('G56 …while a port reorder still remeasures through `portIdSignature`',
      nudges.some(dep => dep.includes('portIdSignature')));
    check('G57 the linked-count badge sits on the section header (D1 — sharing must be visible)',
      /ctlSectionHeader[\s\S]{0,400}?linkCount >= 2/.test(cn));
    // A COLLAPSED node returns before the body div, so controls vanish with
    // every other body widget and the BADGE is what still says "needs
    // attention". (Not drivable through the UI on a macro instance — its
    // double-click ENTERS the macro — so it is pinned structurally.)
    const iCollapse = cn.indexOf('if (!showExpanded) {');
    check('G60 a COLLAPSED node returns BEFORE the body, so it renders no controls',
      iCollapse > 0 && iCollapse < cn.indexOf('${styles.body} nodrag')
      && iCollapse < cn.indexOf('controlSections.length > 0'));

    const ge = src(join('src', 'modeler', 'vpl', 'GraphEditor.tsx'));
    const scopeEffect = ge.slice(ge.indexOf('// Switch displayed graph when scope OR the active graph'));
    const scopeBody = scopeEffect.slice(0, scopeEffect.indexOf('}, [currentScope, modelVersion, activeGraph]);'));
    // ⚠ A `.includes()` here would also match the line COMMENTED OUT — the
    // exact way this mutation slipped through on the first run. Require a real
    // STATEMENT: only whitespace may precede it.
    check('G58 the editor mirrors the OPEN SCOPE on every scope / graph / model change',
      /(^|\n)[ \t]*setOpenMacroScope\(currentScope\);/.test(scopeBody));
    check('G59 …and clears it on unmount (no editor, no open scope)',
      /setControlPick\(null\);\s*\n(\s*\/\/[^\n]*\n)*\s*setOpenMacroScope\(\[\]\);/.test(ge));
  }
}

// ===========================================================================
console.log('\n--- Tier H: authoring semantics (P2) -------------------------');
// ===========================================================================
{
  const { readFileSync } = await import('fs');
  const src = f => readFileSync(join(ROOT, f), 'utf8');

  // A def with THREE ports and TWO controls, so an ordering bug is legible.
  const ifaceDef = () => ({
    id: 'def_i', name: 'Iface',
    nodes: [
      node('mi', 'macroInput', { macroDefId: 'def_i' }),
      node('rnd', 'getRandom', { randomType: 'float', _port_min: '2', _port_max: '9' }),
      node('ps', 'periodicStep', { period: 4, phase: 1 }),
      node('mo', 'macroOutput', { macroDefId: 'def_i' }),
    ],
    edges: [edge('ei1', 'mi', 'rnd', 'output_flow_p1', 'input_flow_do')],
    exposedInputs: [
      { portId: 'p1', label: 'P1', dataType: 'flow', category: 'flow', internalNodeId: 'rnd', internalPortId: 'do' },
      { portId: 'p2', label: 'P2', dataType: 'any', category: 'value', internalNodeId: 'rnd', internalPortId: 'min' },
      { portId: 'p3', label: 'P3', dataType: 'any', category: 'value', internalNodeId: 'rnd', internalPortId: 'max' },
    ],
    exposedOutputs: [
      { portId: 'q1', label: 'Q1', dataType: 'any', category: 'value', internalNodeId: 'rnd', internalPortId: 'value' },
    ],
    controls: [
      ctl('k1', 'Min', cfgTarget('rnd', '_port_min')),
      ctl('k2', 'Period', cfgTarget('ps', 'period'), { groupId: 'gA' }),
    ],
    groups: [{ id: 'gA', name: 'Tuning' }],
  });

  /** Drive ONE authoring edit the way the editor does: the SHIPPED semantics
   *  builder, then the REAL reducer. Returns the next model + the def. */
  const editDef = (model, defId, edit) => {
    const changes = M.applyInterfaceEdit(defOf(model, defId), edit);
    const next = M.modelReducer({ model, isDirty: false, modelVersion: 0 },
      { type: 'UPDATE_MACRO', id: defId, changes }).model;
    return { model: next, def: defOf(next, defId), changes };
  };
  const portIdSet = ps => [...ps.map(p => p.portId)].sort().join(',');

  // --- controls: add / rename / remove ------------------------------------
  {
    const m0 = buildModel({ macroDefs: [ifaceDef()] });
    const base = defOf(m0, 'def_i');
    const added = editDef(m0, 'def_i', { kind: 'control-add', control: ctl('k3', 'Phase', cfgTarget('ps', 'phase')) });
    check('H1 add appends exactly one control, in order', eq(added.def.controls.map(c => c.id), ['k1', 'k2', 'k3']));
    check('H2 …and nothing else on the def moved (===)',
      added.def.nodes === base.nodes && added.def.edges === base.edges
      && added.def.exposedInputs === base.exposedInputs && added.def.groups === base.groups);
    check('H3 …a single dispatch carries ONLY `controls`', eq(Object.keys(added.changes), ['controls']));

    const renamed = editDef(m0, 'def_i', { kind: 'control-rename', controlId: 'k1', name: 'Lower bound' });
    check('H4 rename changes ONLY the name', renamed.def.controls[0].name === 'Lower bound'
      && eq(renamed.def.controls[0].target, base.controls[0].target)
      && renamed.def.controls[0].id === 'k1');
    check('H5 …and leaves the OTHER control === untouched', renamed.def.controls[1] === base.controls[1]);

    const removed = editDef(m0, 'def_i', { kind: 'control-remove', controlId: 'k1' });
    check('H6 remove drops exactly that control', eq(removed.def.controls.map(c => c.id), ['k2']));

    // The LAST control removed restores the pristine record shape (invariant 8).
    const emptied = editDef(removed.model, 'def_i', { kind: 'control-remove', controlId: 'k2' });
    check('H7 removing the LAST control leaves NO `controls` key', emptied.def.controls === undefined);
    check('H8 …so it serializes with no key at all',
      !JSON.stringify(M.serializeModel(emptied.model)).includes('"controls"'));
    check('H9 …and it clones with no key either (invariant 8)',
      M.cloneMacroWithFreshIds(emptied.def).controls === undefined);
  }

  // --- re-binding (the ✎ path) --------------------------------------------
  {
    const m0 = buildModel({ macroDefs: [ifaceDef()] });
    const before = defOf(m0, 'def_i').controls[1];
    const r = editDef(m0, 'def_i', { kind: 'control-rebind', controlId: 'k2', target: cfgTarget('rnd', '_port_max') });
    const after = r.def.controls[1];
    check('H10 re-bind replaces the TARGET', eq(after.target, cfgTarget('rnd', '_port_max')));
    check('H11 …and PRESERVES id + name + groupId',
      after.id === before.id && after.name === before.name && after.groupId === before.groupId,
      JSON.stringify(after));
    check('H12 …and the control now resolves to the NEW parameter',
      M.resolveControlDescriptor(r.model, 'def_i', after).value === '9');
    check('H13 …while the sibling control is === untouched', r.def.controls[0] === defOf(m0, 'def_i').controls[0]);
  }

  // --- grouping a PORT reorders; NO edge is touched (D5 / F8) --------------
  {
    let m = buildModel({ macroDefs: [ifaceDef()] });
    const base = defOf(m, 'def_i');
    const edgesJson = JSON.stringify(base.edges);
    m = editDef(m, 'def_i', { kind: 'group-add', group: { id: 'gB', name: 'Advanced' } }).model;
    // p1 → gB, p3 → gA  ⇒  [ungrouped p2, gA: p3, gB: p1]
    m = editDef(m, 'def_i', { kind: 'port-group', side: 'in', portId: 'p1', groupId: 'gB' }).model;
    const r = editDef(m, 'def_i', { kind: 'port-group', side: 'in', portId: 'p3', groupId: 'gA' });
    const ins = r.def.exposedInputs;
    check('H14 the port array is REORDERED [ungrouped…, gA…, gB…]',
      eq(ins.map(p => p.portId), ['p2', 'p3', 'p1']), ins.map(p => p.portId).join(','));
    check('H15 …the portId SET is IDENTICAL', portIdSet(ins) === portIdSet(base.exposedInputs));
    check('H16 …every port object still carries its own label + internal mapping',
      ins.every(p => base.exposedInputs.some(b => b.portId === p.portId && b.label === p.label && b.internalPortId === p.internalPortId)));
    check('H17 …`def.edges` is === UNTOUCHED (F8: the bridge matches by portId)',
      r.def.edges === base.edges && JSON.stringify(r.def.edges) === edgesJson);
    check('H18 …and the OUTPUT port array is === untouched', r.def.exposedOutputs === base.exposedOutputs);
    check('H19 …the dispatch carried ONLY `exposedInputs`', eq(Object.keys(r.changes), ['exposedInputs']));

    // Un-grouping DELETES the key — "ungrouped" is the ABSENT state.
    const un = editDef(r.model, 'def_i', { kind: 'port-group', side: 'in', portId: 'p3', groupId: '' });
    check('H20 un-grouping removes the groupId KEY (absent ⇒ today\'s files)',
      !('groupId' in (un.def.exposedInputs.find(p => p.portId === 'p3') ?? { groupId: 1 })));
    check('H21 …and it moves back to the ungrouped head', eq(un.def.exposedInputs.map(p => p.portId), ['p2', 'p3', 'p1']));

    // The OUTPUT side reorders through the same edit, independently.
    const outR = editDef(r.model, 'def_i', { kind: 'port-group', side: 'out', portId: 'q1', groupId: 'gA' });
    check('H22 the OUTPUT array groups independently', outR.def.exposedOutputs[0]?.groupId === 'gA'
      && outR.def.exposedInputs === r.def.exposedInputs);
  }

  // --- grouping a CONTROL --------------------------------------------------
  {
    let m = buildModel({ macroDefs: [ifaceDef()] });
    m = editDef(m, 'def_i', { kind: 'group-add', group: { id: 'gB', name: 'Advanced' } }).model;
    const r = editDef(m, 'def_i', { kind: 'control-group', controlId: 'k1', groupId: 'gB' });
    check('H23 controls reorder the same way [ungrouped…, gA…, gB…]',
      eq(r.def.controls.map(c => c.id), ['k2', 'k1']), r.def.controls.map(c => c.id).join(','));
    check('H24 …the control SET is identical and nothing lost its target',
      r.def.controls.length === 2 && r.def.controls.every(c => c.target.kind === 'config'));
  }

  // --- deleting a group CLEARS membership and DELETES NOTHING -------------
  {
    let m = buildModel({ macroDefs: [ifaceDef()] });
    m = editDef(m, 'def_i', { kind: 'port-group', side: 'in', portId: 'p2', groupId: 'gA' }).model;
    const before = defOf(m, 'def_i');
    const r = editDef(m, 'def_i', { kind: 'group-remove', groupId: 'gA' });
    check('H25 the group is gone — and it was the LAST, so no `groups` key', r.def.groups === undefined);
    // `?? []` throughout: a MUTATION must produce a legible FAIL, never a crash
    // that hides every later check.
    const survivors = r.def.controls ?? [];
    check('H26 …every PORT survives', portIdSet(r.def.exposedInputs) === portIdSet(before.exposedInputs));
    check('H27 …every CONTROL survives', eq(survivors.map(c => c.id).sort(), ['k1', 'k2']));
    check('H28 …their groupId KEYS are cleared, not blanked',
      r.def.exposedInputs.every(p => !('groupId' in p)) && survivors.every(c => !('groupId' in c)));
    check('H29 …and the controls still resolve',
      !!survivors[0] && !M.resolveControlDescriptor(r.model, 'def_i', survivors[0]).block);
  }

  // --- groups: add to a def with NONE / remove the last --------------------
  {
    const bare = { ...ifaceDef(), controls: undefined, groups: undefined };
    const m0 = buildModel({ macroDefs: [bare] });
    const g = editDef(m0, 'def_i', { kind: 'group-add', group: { id: 'g1', name: 'One' } });
    check('H30 adding a group to a def with none CREATES the array', eq(g.def.groups, [{ id: 'g1', name: 'One' }]));
    const gone = editDef(g.model, 'def_i', { kind: 'group-remove', groupId: 'g1' });
    check('H31 removing the last group leaves NO `groups` key', gone.def.groups === undefined);
    check('H32 …and no `controls` key is invented for a control-free def', gone.def.controls === undefined);
    const named = editDef(g.model, 'def_i', { kind: 'group-rename', groupId: 'g1', name: 'Renamed' });
    check('H33 group rename changes only the name', eq(named.def.groups, [{ id: 'g1', name: 'Renamed' }]));
  }

  // --- orderByGroup is a TOTAL partition ----------------------------------
  {
    const items = [{ groupId: 'x' }, {}, { groupId: 'dead' }, { groupId: 'y' }, { groupId: 'x' }];
    const out = M.orderByGroup(items, [{ id: 'y', name: 'Y' }, { id: 'x', name: 'X' }]);
    check('H34 orderByGroup keeps EVERY member exactly once', out.length === items.length
      && items.every(i => out.filter(o => o === i).length === 1));
    check('H35 …ungrouped first (a DEAD groupId counts as ungrouped), then groups in order',
      eq(out.map(o => o.groupId ?? '-'), ['-', 'dead', 'y', 'x', 'x']), JSON.stringify(out));
    check('H36 …and it is stable within a bucket', out[3] === items[0] && out[4] === items[4]);
  }

  // --- the P4 class gate ---------------------------------------------------
  {
    const model = buildModel();
    const rows = M.eligibleControlKeys('setAttribute', { attributeId: 'a_count' }, model, undefined, new Set(['A', 'B']));
    check('H37 with class C excluded there is no `element` row', rows.every(r => r.kind !== 'element' && r.klass !== 'C'));
    check('H38 …and the A/B rows are still offered', rows.length > 0);
  }

  // --- pick mode: the module global ---------------------------------------
  {
    let hits = 0;
    const un = M.subscribeControlPick(() => { hits++; });
    M.setControlPick(null);
    check('H39 setting null over null does not notify', hits === 0);
    M.setControlPick({ defId: 'def_i', controlId: 'new' });
    check('H40 arming notifies and is readable', hits === 1 && M.getControlPick()?.controlId === 'new');
    M.setControlPick({ defId: 'def_i', controlId: 'new' });
    check('H41 an EQUAL but fresh object does not notify (memo churn guard)', hits === 1);
    M.setControlPick({ defId: 'def_i', controlId: 'k1' });
    check('H42 a DIFFERENT pick notifies', hits === 2 && M.getControlPick()?.controlId === 'k1');
    M.setControlPick(null);
    check('H43 cancelling notifies and clears', hits === 3 && M.getControlPick() === null);
    un();
    M.setControlPick({ defId: 'x', controlId: 'new' });
    check('H44 unsubscribing really unsubscribes', hits === 3);
    M.setControlPick(null);
  }

  // --- the R10 wiring, pinned in SOURCE (it lives in a React component) ----
  {
    const ge = src(join('src', 'modeler', 'vpl', 'GraphEditor.tsx'));
    // The scope-switch effect's deps carry `modelVersion`, so ONE cancel there
    // covers a scope change, a graph swap AND a model load.
    const scopeEffect = ge.slice(ge.indexOf('// Switch displayed graph when scope OR the active graph'));
    const scopeBody = scopeEffect.slice(0, scopeEffect.indexOf('}, [currentScope, modelVersion, activeGraph]);'));
    check('H45 pick mode auto-cancels on a scope change / graph swap / model load',
      scopeBody.includes('setControlPick(null)') && scopeBody.length > 0);
    check('H46 …and the scope effect really does depend on modelVersion',
      scopeEffect.includes('}, [currentScope, modelVersion, activeGraph]);'));
    check('H47 Esc cancels pick mode, capture-phase, and only when armed',
      /keydown[\s\S]{0,200}?true\)/.test(ge) && ge.includes("if (e.key !== 'Escape' || !getControlPick()) return;"));
    check('H48 …and the editor is torn down with pick mode cancelled (unmount)',
      /removeEventListener\('keydown', onKey, true\);\s*setControlPick\(null\);/.test(ge));
    check('H49 the DEV hook exists (React Flow ignores synthetic pointer events)',
      ge.includes('__setControlPick'));

    const cn = src(join('src', 'modeler', 'vpl', 'CaNode.tsx'));
    check('H50 the boundary editor dispatches through the ONE semantics builder',
      cn.includes('applyInterfaceEdit(macroDefForBoundary, edit)'));
    check('H51 …and a bind is ONE updateMacro through the same builder',
      /updateMacro\(pick\.defId, applyInterfaceEdit\(pickDef, edit\)\)/.test(cn));
    check('H52 pick mode only offers keys `eligibleControlKeys` returned',
      cn.includes('return eligibleControlKeys(nodeData.nodeType, nodeData.config, model, connectedInputHandles);'));
    check('H53 …and only for a node that really belongs to the picked def',
      cn.includes("if (!pickDef || !pickDef.nodes.some(n => n.id === id)) return [];"));
  }
}

// ===========================================================================
console.log('\n--- Tier I: class C — ONE source for the element lists (P4) ---');
// ===========================================================================
{
  const { readFileSync } = await import('fs');
  const src = f => readFileSync(join(ROOT, f), 'utf8');
  const cn = src(join('src', 'modeler', 'vpl', 'CaNode.tsx'));
  const model = buildModel({
    mappings: [
      { id: 'm_out', name: 'Viz', isAttributeToColor: true },
      { id: 'm_in', name: 'Brush', isAttributeToColor: false },
    ],
    agentMappings: [
      { id: 'am_out', name: 'Agent Viz', isAttributeToColor: true },
      { id: 'am_in', name: 'Agent Brush', isAttributeToColor: false },
    ],
    indicators: [
      { id: 'i_std', name: 'Pop', kind: 'standalone', dataType: 'integer' },
      { id: 'i_freq', name: 'Census', kind: 'linked', linkedAttributeId: 'a_type', linkedAggregation: 'frequency' },
      { id: 'i_spat', name: 'Chromatogram', kind: 'linked', linkedAttributeId: 'a_type', linkedAggregation: 'frequency', xAxis: 'rows' },
    ],
    variables: [
      { id: 'v_s', name: 'acc', kind: 'scalar', dataType: 'float', initialValue: '0' },
      { id: 'v_a', name: 'buf', kind: 'array', dataType: 'float', length: 4, initialValue: '0' },
    ],
    agentVariables: [{ id: 'av_s', name: 'agAcc', kind: 'scalar', dataType: 'float', initialValue: '0' }],
    sprites: [{ id: 'sp', name: 'Bird', dataUrl: 'data:,', mimeType: 'image/png' }],
    presets: [{ id: 'p1', name: 'Slow', createdAt: 0 }],
  });
  // A lookup-table + a color model attribute, so the ov* / getModelAttribute
  // filters have something to include AND something to exclude.
  model.attributes = [...model.attributes,
    { ...attr('a_table', 'lookupTable'), isModelAttribute: true },
    { ...attr('a_tint', 'color'), isModelAttribute: true },
  ];
  const ids = (nodeType, key) => (M.elementOptionsFor(nodeType, key, model) ?? []).map(o => o.value);

  // --- THE COVERAGE TABLE: every (nodeType, key) the extraction moved, with
  //     the id list derived INDEPENDENTLY from the fixture. -------------------
  M.setActiveGraphKind('cells');
  const CELLS = [
    ['getCellAttribute', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['setAttribute', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['setCellAtPosition', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['updateAttribute', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['getAgentsAttribute', 'attributeId', ['', 'ag_state', 'ag_energy']],
    ['filterAgents', 'attributeId', ['', 'ag_state', 'ag_energy']],
    ['getAgentAttribute', 'attributeId', ['', 'ag_state', 'ag_energy']],
    ['getBondAttribute', 'attributeId', ['', 'bond_w']],
    ['setBondAttribute', 'attributeId', ['', 'bond_w']],
    ['divideAgent', 'partitionAttributeId', ['', 'bond_w']],
    ['neighbourCensus', 'attributeId', ['', 'ag_state']],
    ['sampleField', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['secreteToField', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['getNeighborsAttribute', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['getNeighborsAttribute', 'neighborhoodId', ['', 'nb']],
    ['setNeighborhoodAttribute', 'neighborhoodId', ['', 'nb']],
    ['getNeighborAttributeByIndex', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['filterNeighbors', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['getNeighborAttributeByTag', 'neighborhoodId', ['', 'nb']],
    ['getNeighborAttributeByTag', 'attributeId', ['', 'a_alive', 'a_count', 'a_type', 'a_flow']],
    ['getAllNeighborIndexes', 'neighborhoodId', ['', 'nb']],
    ['neighborIndexFromTag', 'neighborhoodId', ['', 'nb']],
    ['getNeighborIndexesByTags', 'neighborhoodId', ['', 'nb']],
    ['getModelAttribute', 'attributeId', ['', 'a_speed', 'a_table', 'a_tint']],
    ['ovSetModelAttribute', 'attributeId', ['', 'a_speed']],   // color + lookupTable + vector excluded
    ['getAgentsInView', 'facingAttributeId', ['']],            // no vector AGENT attribute in the fixture
    ['senseHemifield', 'facingAttributeId', ['']],
    ['setIndicator', 'indicatorId', ['', 'i_std']],
    ['updateIndicator', 'indicatorId', ['', 'i_std']],
    ['getIndicator', 'indicatorId', ['', 'i_std', 'i_freq', 'i_spat']],
    ['ovReadIndicator', 'indicatorId', ['', 'i_std', 'i_freq']],
    ['ovCollectSpatial', 'indicatorId', ['', 'i_spat']],
    ['getVariable', 'variableId', ['', 'v_s', 'v_a']],
    ['setVariable', 'variableId', ['', 'v_s']],
    ['setArrayElement', 'variableId', ['', 'v_a']],
    ['setCellLooks', 'mappingId', ['', '__current__', 'm_out']],
    ['inputColor', 'mappingId', ['', 'm_in']],
    ['outputMapping', 'mappingId', ['', 'm_out']],
    ['assertActiveViewer', 'mappingId', ['', 'm_out']],
    ['agentOutputMapping', 'mappingId', ['', 'am_out']],
    ['agentInputMapping', 'mappingId', ['', 'am_in']],
    ['setAgentSprite', 'spriteId', ['', 'sp']],
    ['ovRandomizeTable', 'tableId', ['', 'a_table']],
    ['lookupInteraction', 'tableId', ['', 'a_table']],
    ['interactionTableMap', 'tableId', ['', 'a_table']],
    ['ovLoadPreset', 'presetId', ['', 'p1']],
    ['getConstant', 'tagAttributeId', ['', 'a_type']],
    ['statement', 'tagAttributeId', ['', 'a_type']],
    ['switch', 'tagAttributeId', ['', 'a_type']],
  ];
  let bad = 0;
  for (const [nt, key, want] of CELLS) if (!eq(ids(nt, key), want)) { bad++; console.log(`      ${nt}.${key} = ${JSON.stringify(ids(nt, key))} want ${JSON.stringify(want)}`); }
  check(`I1 all ${CELLS.length} (nodeType, key) element lists are exact on the CELLS graph`, bad === 0);
  check('I2 …and every one of them really resolves (no missing table row)',
    CELLS.every(([nt, key]) => M.elementOptionsFor(nt, key, model) !== null));

  // --- D10: the SAME call, on the Agents graph, gives the AGENT lists --------
  M.setActiveGraphKind('agents');
  check('I3 an OWN-attribute list follows getActiveGraphKind() (Agents)',
    eq(ids('setAttribute', 'attributeId'), ['', 'ag_state', 'ag_energy']));
  check('I4 …the VARIABLE list too', eq(ids('getVariable', 'variableId'), ['', 'av_s']));
  check('I5 …and setCellLooks lists the AGENT views (sentinel kept)',
    eq(ids('setCellLooks', 'mappingId'), ['', '__current__', 'am_out']));
  check('I6 a graph-INDEPENDENT list is unchanged by the swap', eq(ids('getAllNeighborIndexes', 'neighborhoodId'), ['', 'nb']));
  M.setActiveGraphKind('cells');

  // --- the option METADATA a class-C list can carry -------------------------
  const indOpts = M.elementOptionsFor('getIndicator', 'indicatorId', model);
  check('I7 Get Indicator lists a non-scalar indicator DISABLED with its reason',
    indOpts.find(o => o.value === 'i_freq')?.disabled === true && !!indOpts.find(o => o.value === 'i_freq')?.title);
  check('I8 …and a scalar one selectable', indOpts.find(o => o.value === 'i_std')?.disabled === undefined);
  check('I9 the leading PLACEHOLDER is part of the shared list',
    indOpts[0].value === '' && M.elementOptionsFor('getNeighborsAttribute', 'neighborhoodId', model)[0].label === 'Neighborhood...');

  // --- COUPLED keys: list shared, key NOT bindable (P1.2 for class C) -------
  const COUPLED = [
    ['updateAttribute', 'attributeId'], ['updateIndicator', 'indicatorId'],
    ['getModelAttribute', 'attributeId'], ['getConstant', 'tagAttributeId'],
    ['statement', 'tagAttributeId'], ['switch', 'tagAttributeId'],
    ['getNeighborIndexesByTags', 'neighborhoodId'],
  ];
  check('I10 every coupled-write key is FLAGGED coupled', COUPLED.every(([nt, k]) => M.elementSpecFor(nt, k)?.coupled === true));
  check('I11 …its LIST is still shared with the in-node picker', COUPLED.every(([nt, k]) => (M.elementOptionsFor(nt, k, model) ?? []).length > 0));
  check('I12 …and it is NEVER offered as a control', COUPLED.every(([nt, k]) =>
    !M.eligibleControlKeys(nt, {}, model).some(r => r.configKey === k)));
  {
    // A control naming one REPORTS rather than half-writing a state the in-node
    // editor never produces.
    const def = { ...buildDefA(), controls: [ctl('c_bad', 'Attr', cfgTarget('gmA', 'attributeId'))] };
    def.nodes = [...def.nodes, node('gmA', 'getModelAttribute', { attributeId: 'a_speed' })];
    const m2 = withDef(model, def);
    const d = M.resolveControlDescriptor(m2, 'def_a', def.controls[0]);
    check('I13 a control bound to a coupled key reports orphan-key', d.block === 'orphan-key' && !!d.reason);
    check('I14 …and its write is inert', M.applyControlValue(m2, 'def_a', def.controls[0], 'a_tint') === null);
  }

  // --- a live class-C control end to end ------------------------------------
  {
    const def = { ...buildDefA(), controls: [ctl('c_attr', 'Target attribute', cfgTarget('sa', 'attributeId'))] };
    const m2 = withDef(model, def);
    const d = M.resolveControlDescriptor(m2, 'def_a', def.controls[0]);
    check('I15 a class-C control resolves as an `element` with the live value', d.kind === 'element' && d.value === 'a_count' && !d.block);
    check('I16 …carrying the SAME list the in-node picker renders',
      eq((d.options ?? []).map(o => o.value), ids('setAttribute', 'attributeId')));
    const patch = M.applyControlValue(m2, 'def_a', def.controls[0], 'a_type');
    const next = patch && M.modelReducer({ model: m2, isDirty: false, modelVersion: 0 }, { type: 'UPDATE_MACRO', id: patch.defId, changes: { nodes: patch.nodes } });
    check('I17 …and a write lands on the internal node', nodeOf(next.model, 'def_a', 'sa').data.config.attributeId === 'a_type');
    check('I18 …the ADAPTIVE value widget then follows the new type (tag)',
      M.resolveControlDescriptor(next.model, 'def_a', ctl('c_v', 'V', cfgTarget('sa', '_port_value'))).kind === 'tag');
  }

  // --- ONE SOURCE, pinned in the SHIPPED CaNode ----------------------------
  check('I19 CaNode renders every element picker from `elementOptionsFor`',
    cn.includes('elementOptionsFor(nodeData.nodeType, configKey, model)'));
  const optionCalls = (cn.match(/\{elementOptions\('/g) ?? []).length;
  check(`I20 …at all 39 picker sites (found ${optionCalls})`, optionCalls === 39);
  for (const [re, what] of [
    [/<option value="">Attribute\.\.\.<\/option>/, 'Attribute...'],
    [/<option value="">Neighborhood\.\.\.<\/option>/, 'Neighborhood...'],
    [/<option value="">Bond attribute\.\.\.<\/option>/, 'Bond attribute...'],
    [/<option value="">Select Mapping\.\.\.<\/option>/, 'Select Mapping...'],
    [/<option value="">Select variable\.\.\.<\/option>/, 'Select variable...'],
    [/<option value="">Select Sprite\.\.\.<\/option>/, 'Select Sprite...'],
    [/<option value="">Tag attr\.\.\.<\/option>/, 'Tag attr...'],
    [/<option value="">Select preset\.\.\.<\/option>/, 'Select preset...'],
    [/indicatorScalarBlocker/, 'the Get Indicator blocker expression'],
    [/CURRENT_VIEWER_SENTINEL}>Current Simulator Selected/, 'the setCellLooks sentinel option'],
  ]) check(`I21 …with NO surviving inline list for “${what}”`, !re.test(cn));
}

// ===========================================================================
console.log('\n--- Tier K: the CHAINING pick rows (P4 / D4) ------------------');
// ===========================================================================
{
  const { readFileSync } = await import('fs');
  const cn = readFileSync(join(ROOT, 'src', 'modeler', 'vpl', 'CaNode.tsx'), 'utf8');

  // A→B: `outer` holds an instance of `inner`; binding in A offers B's controls.
  const inner = {
    id: 'def_in', name: 'Inner', nodes: [node('n1', 'getRandom', { randomType: 'float', _port_max: '9' })],
    edges: [], exposedInputs: [], exposedOutputs: [],
    controls: [ctl('ci', 'Max', cfgTarget('n1', '_port_max'))],
  };
  const outer = {
    id: 'def_out', name: 'Outer', nodes: [node('inst', 'macro', { macroDefId: 'def_in' })],
    edges: [], exposedInputs: [], exposedOutputs: [],
  };
  const model = { ...buildModel(), macroDefs: [inner, outer] };

  /** The row computation CaNode performs, with the VERDICT from the SHIPPED
   *  resolver — so a change to `resolveTarget` moves these checks. */
  const rowsFor = (m, pick, nodeId) => {
    const defs = m.macroDefs;
    const pickDef = defs.find(d => d.id === pick.defId);
    if (!pickDef || !pickDef.nodes.some(n => n.id === nodeId)) return [];
    const host = pickDef.nodes.find(n => n.id === nodeId);
    const innerDef = defs.find(d => d.id === host?.data?.config?.macroDefId);
    return (innerDef?.controls ?? []).map(c => {
      const seen = pick.controlId === 'new' ? new Set() : new Set([`${pick.defId}::${pick.controlId}`]);
      const res = M.resolveTarget(defs, pick.defId, { kind: 'control', nodeId, controlId: c.id }, seen);
      return { id: c.id, name: c.name, cycle: !res.ok && res.block === 'cycle' };
    });
  };

  const rows = rowsFor(model, { defId: 'def_out', controlId: 'new' }, 'inst');
  check('K1 a nested macro instance offers the INNER def\'s controls', rows.length === 1 && rows[0].id === 'ci' && rows[0].name === 'Max');
  check('K2 …and none of them is flagged circular', rows.every(r => !r.cycle));
  check('K3 a node that is not in the picked def offers nothing', rowsFor(model, { defId: 'def_out', controlId: 'new' }, 'nope').length === 0);
  check('K4 a macro instance pointing at NO def offers nothing',
    rowsFor({ ...model, macroDefs: [inner, { ...outer, nodes: [node('inst', 'macro', {})] }] }, { defId: 'def_out', controlId: 'new' }, 'inst').length === 0);
  check('K5 a macro whose def declares no controls offers nothing',
    rowsFor({ ...model, macroDefs: [{ ...inner, controls: undefined }, outer] }, { defId: 'def_out', controlId: 'new' }, 'inst').length === 0);

  // Binding writes the CHAINED target through the same one-dispatch builder.
  {
    const edit = { kind: 'control-add', control: ctl('co', 'Inner max', { kind: 'control', nodeId: 'inst', controlId: 'ci' }) };
    const changes = M.applyInterfaceEdit(outer, edit);
    const m2 = { ...model, macroDefs: [inner, { ...outer, ...changes }] };
    const d = M.resolveControlDescriptor(m2, 'def_out', changes.controls[0]);
    check('K6 a bound chained control resolves LIVE, into the NESTED def', !d.block && d.value === '9' && d.resolved?.defId === 'def_in');

    // ✎ RE-BIND: offering the outer control's OWN chain back to itself must be
    // refused. `mutual` re-exposes `co` from `inner`, so binding `co` → `cm`
    // would close the loop `co → cm → co`.
    const innerMut = { ...inner, nodes: [...inner.nodes, node('back', 'macro', { macroDefId: 'def_out' })],
      controls: [...inner.controls, ctl('cm', 'Loop', { kind: 'control', nodeId: 'back', controlId: 'co' })] };
    const m3 = { ...model, macroDefs: [innerMut, { ...outer, ...changes }] };
    const reRows = rowsFor(m3, { defId: 'def_out', controlId: 'co' }, 'inst');
    const loopRow = reRows.find(r => r.id === 'cm');
    check('K7 re-binding REFUSES a row that would close a cycle', !!loopRow && loopRow.cycle === true);
    // …and the SEED is what catches it: the same row resolves cleanly without
    // it, so the `${defId}::${controlId}` pre-seed in CaNode (pinned by K12) is
    // load-bearing rather than decorative.
    check('K7b …and the ✎ SEED is what catches it (unseeded, the same row resolves)',
      M.resolveTarget(m3.macroDefs, 'def_out', { kind: 'control', nodeId: 'inst', controlId: 'cm' }, new Set()).ok === true);
    check('K8 …while the harmless sibling row stays bindable', reRows.find(r => r.id === 'ci')?.cycle === false);
    check('K9 …and the same row IS offered when adding a NEW control (no loop yet)',
      rowsFor(m3, { defId: 'def_out', controlId: 'new' }, 'inst').find(r => r.id === 'cm')?.cycle === false);
  }

  // --- pinned in the SHIPPED CaNode (a React component the harness cannot mount)
  check('K10 the chaining rows come from the NESTED def\'s controls, not eligibleControlKeys',
    /const pickControlRows = useMemo\(\(\) => \{[\s\S]{0,900}?\(inner\?\.controls \?\? \[\]\)\.map/.test(cn));
  check('K11 …only for a `macro` node that belongs to the picked def',
    /if \(!controlPick \|\| nodeData\.nodeType !== 'macro'\) return \[\];/.test(cn)
    && /if \(!pickDef \|\| !pickDef\.nodes\.some\(n => n\.id === id\)\) return \[\];[\s\S]{0,400}?macroDefId/.test(cn));
  check('K12 …the cycle verdict is the SHIPPED resolveTarget, seeded on the ✎ path',
    /new Set<string>\(\[`\$\{controlPick\.defId\}::\$\{controlPick\.controlId\}`\]\)/.test(cn)
    && /res = resolveTarget\(defs, controlPick\.defId, \{ kind: 'control', nodeId: id, controlId: c\.id \}, seen\)/.test(cn));
  check('K13 …a circular row is rendered DISABLED and cannot bind',
    /disabled=\{r\.cycle\}/.test(cn) && /if \(!r\.cycle\) bindPickTarget\(\{ kind: 'control', nodeId: id, controlId: r\.id \}/.test(cn));
  check('K14 …and both row kinds bind through the ONE dispatch path',
    /const bindPick = useCallback\(\s*\(configKey: string, label: string\) => bindPickTarget\(\{ kind: 'config', nodeId: id, configKey \}, label\)/.test(cn));
}

// ===========================================================================
console.log('\n--- Tier J: M1 / M2 / clipboard need NO new pass (P4) ---------');
// ===========================================================================
{
  const model = buildModel();
  // A def whose class-C control names an attribute the node config ALREADY
  // names — the whole M1 argument: the reference lives in the CONFIG, which M1
  // already scans, so a control adds no fourth carrier.
  const plain = buildDefA();
  const withCtl = {
    ...buildDefA(),
    controls: [
      ctl('c1', 'Target attribute', cfgTarget('sa', 'attributeId')),
      ctl('c2', 'Value', cfgTarget('sa', '_port_value'), { groupId: 'g1' }),
    ],
    groups: [{ id: 'g1', name: 'Tuning' }],
  };
  const refsOf = def => {
    const c = M.collectMacroReferences(M.collectMacroExportDefs(def, [def]), model);
    return c.refs.map(r => `${r.space}:${r.id}`).sort();
  };
  check('J1 M1 collects the SAME references with and without controls', eq(refsOf(plain), refsOf(withCtl)));
  check('J2 …and it really collected something (the check is not vacuous)', refsOf(plain).length > 0);

  // M2 passes 2 and 4 rename `_port_bondAttr_*` and permute `partTag_*`; no
  // control may name either, which is what keeps those passes control-blind.
  check('J3 every key shape M2 renames/permutes is excluded from binding',
    M.isExcludedControlKey('_port_bondAttr_bond_w') && M.isExcludedControlKey('partTag_0') && M.isExcludedControlKey('partTag_12'));

  // --- a FULL planImport → applyImportPlan on a def with controls -----------
  {
    const file = M.buildMacroFile(withCtl, [withCtl], model);
    const parsed = M.parseMacroFile(JSON.stringify(file));
    const plan = M.planImport(parsed, model);
    const applied = M.applyImportPlan(plan, model);
    const imported = applied.defs[0];
    check('J4 M2 imports the def WITH its controls + groups',
      (imported.controls ?? []).length === 2 && (imported.groups ?? []).length === 1);
    check('J5 …ids / names / groupId PRESERVED', imported.controls[0].id === 'c1' && imported.controls[1].groupId === 'g1' && imported.groups[0].id === 'g1');
    check('J6 …target.nodeId REMAPPED to the fresh node (R2)',
      imported.controls[0].target.nodeId !== 'sa' && imported.nodes.some(n => n.id === imported.controls[0].target.nodeId));
    const m2 = { ...model, macroDefs: [...model.macroDefs, ...applied.defs] };
    const d = M.resolveControlDescriptor(m2, imported.id, imported.controls[0]);
    check('J7 …and the imported control RESOLVES, to a setAttribute node', !d.block && d.kind === 'element');
    check('J8 …at the node it named, not another one',
      m2.macroDefs.find(x => x.id === imported.id).nodes.find(n => n.id === d.resolved?.nodeId)?.data.nodeType === 'setAttribute');
    check('J9 M2 raised no extra rows for the controls', plan.rows.every(r => r.space !== 'controls'));
  }

  // --- the cross-tab clipboard ---------------------------------------------
  {
    // A→B chain: the outer def's control points at the inner def's control.
    const inner = {
      id: 'def_in', name: 'Inner', nodes: [node('n1', 'getRandom', { randomType: 'float', _port_max: '3' })],
      edges: [], exposedInputs: [], exposedOutputs: [],
      controls: [ctl('ci', 'Max', cfgTarget('n1', '_port_max'))],
    };
    const outer = {
      id: 'def_out', name: 'Outer', nodes: [node('mi2', 'macro', { macroDefId: 'def_in' })],
      edges: [], exposedInputs: [], exposedOutputs: [],
      controls: [ctl('co', 'Inner max', { kind: 'control', nodeId: 'mi2', controlId: 'ci' })],
    };
    const m3 = { ...model, macroDefs: [inner, outer] };
    const instance = node('inst', 'macro', { macroDefId: 'def_out' });
    const bundle = M.collectMacroDefBundle([instance], m3.macroDefs);
    check('J10 the clipboard bundles BOTH defs, controls intact',
      bundle.length === 2 && bundle.every(d => (d.controls ?? []).length === 1));
    store.clear();
    M.writeGraphClipboard({ kind: 'cells', nodes: [instance], edges: [], macroDefs: bundle });
    const read = M.readGraphClipboard().payload;
    check('J11 …and they survive the JSON round trip',
      read.macroDefs.length === 2 && read.macroDefs.every(d => (d.controls ?? []).length === 1));

    // The paste: clone both, then retarget the nested macroDefId — the shape
    // GraphEditor's paste uses. A PRESERVED controlId is what lands the chain.
    const cInner = M.cloneMacroWithFreshIds(read.macroDefs.find(d => d.id === 'def_in'));
    const cOuterRaw = M.cloneMacroWithFreshIds(read.macroDefs.find(d => d.id === 'def_out'));
    const cOuter = M.remapNestedMacroRefs(cOuterRaw, new Map([['def_in', cInner.id]]));
    const m4 = { ...model, macroDefs: [cInner, cOuter] };
    const res = M.resolveTarget(m4.macroDefs, cOuter.id, cOuter.controls[0].target);
    check('J12 a pasted CHAIN still resolves, into the pasted INNER def',
      res.ok && res.at.defId === cInner.id && res.at.configKey === '_port_max');
    check('J13 …at the inner def\'s own remapped node', res.ok && cInner.nodes.some(n => n.id === res.at.nodeId));
    const d = M.resolveControlDescriptor(m4, cOuter.id, cOuter.controls[0]);
    check('J14 …and the outer instance renders it live', !d.block && d.value === '3');
  }
}

// ---------------------------------------------------------------------------
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
