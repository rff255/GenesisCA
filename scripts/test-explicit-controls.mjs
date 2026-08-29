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
  eligibleControlKeys, partitionPickTargets, resolveTarget, resolveControlDescriptor, applyControlValue,
  inlineWidgetFor, isExcludedControlKey, elementOptionsFor, describeControlTarget,
  SCALAR_CONFIG_KEYS, CLASS_C_KEYS, CONTROL_BLOCK_REASON, CONTROL_MAX_CHAIN_DEPTH,
  ownAttrListFor, tagAttrScopeFor,
  orderByGroup, withGroup, applyInterfaceEdit,
  groupSections, CONTROL_BLOCK_NEEDS_ATTENTION,
  interfaceRows, reorderInterface, ifaceGroupRowId, ifaceItemRowId,
  collapsedGroupIds, toggleCollapsedGroup, CTL_COLLAPSED_KEY,
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
export { applyControlFacet, controlTargetOf, facetSpecFor, FACET_SPECS } from '../src/modeler/vpl/explicitControls.ts';
export { readColorScaleStopsRaw, writeColorScaleStops, colorScaleHasAlpha } from '../src/modeler/vpl/nodes/ColorScaleNode.ts';
export { readCategoricalEntries, readCategoricalDefault, writeCategoricalPalette, categoricalHasAlpha } from '../src/modeler/vpl/nodes/CategoricalColorNode.ts';
export { readColorConstant, writeColorConstant, colorConstantHasAlpha } from '../src/modeler/vpl/nodes/GetColorConstantNode.ts';
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
    // A SECOND port, so the clone's port ORDER — which is the handle order on
    // every instance — is legible rather than vacuous.
    exposedInputs: [
      ...base.exposedInputs,
      { portId: 'in2', label: 'In2', dataType: 'any', category: 'value', internalNodeId: 'rnd', internalPortId: 'min' },
    ],
    nodes: [...base.nodes, node('inner', 'macro', { macroDefId: 'def_b' })],
  };
  const cloned = M.cloneMacroWithFreshIds(withCtls);

  check('B1 controls SURVIVE the clone', Array.isArray(cloned.controls) && cloned.controls.length === 3, JSON.stringify(cloned.controls));
  check('B2 groups SURVIVE the clone', eq(cloned.groups, withCtls.groups));
  // Keep every LATER check reportable when B1 fails (the "revert the literal"
  // negative control) — a crash here would hide the rest of the tier.
  if (!Array.isArray(cloned.controls)) cloned.controls = [{ id: '?', name: '?', target: cfgTarget('?', '?') }, { id: '?', name: '?', target: cfgTarget('?', '?') }, { id: '?', name: '?', target: { kind: 'control', nodeId: '?', controlId: '?' } }];
  if (!Array.isArray(cloned.groups)) cloned.groups = [];
  check('B3 the PORT ORDER survives the clone (it IS the handle order)',
    eq(cloned.exposedInputs.map(p => p.portId), ['in', 'in2']));
  check('B3b …and no port carries a `groupId` (ports are group-free, D5b)',
    cloned.exposedInputs.every(p => !('groupId' in p)));

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
    exposedInputs: [
      ...buildDefA().exposedInputs,
      { portId: 'in2', label: 'In2', dataType: 'any', category: 'value', internalNodeId: 'rnd', internalPortId: 'min' },
    ],
  };
  const model = buildModel({ macroDefs: [def] });

  // --- .gcaproj -----------------------------------------------------------
  const json = M.serializeModel(model);
  const back = M.parseModelJSON(json);
  check('C1 .gcaproj preserves controls VERBATIM', eq(back.macroDefs[0].controls, def.controls), JSON.stringify(back.macroDefs[0].controls));
  check('C2 .gcaproj preserves groups VERBATIM', eq(back.macroDefs[0].groups, def.groups));
  check('C3 .gcaproj preserves the exposed-port ORDER (the handle order)',
    eq(back.macroDefs[0].exposedInputs.map(p => p.portId), ['in', 'in2']));

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
    'controls REORDERED across a separator': {
      ...emitDef,
      controls: [ctl('k2', 'Other', cfgTarget('sa', 'attributeId')), ctl('k1', 'Value', cfgTarget('sa', '_port_value'), { groupId: 'g2' })],
      groups: [{ id: 'g2', name: 'Advanced' }, { id: 'g1', name: 'Tuning' }],
    },
    'every control DELETED again': { ...emitDef, controls: [], groups: [] },
  };
  for (const [name, def] of Object.entries(variants)) {
    const m = M.migrateForHarness({ ...baseModel, macroDefs: [def] });
    check(`F3 emit is BYTE-IDENTICAL — ${name}`, surfaces(m) === baseline);
  }

  // F8, directly: reordering the exposed PORTS reorders the handles and changes
  // NO emitted byte, because every bridge matches by `portId`. Compared against
  // its own two-port twin rather than the one-port baseline.
  {
    const p2 = { portId: 'in2', label: 'In2', dataType: 'any', category: 'value', internalNodeId: 'sa', internalPortId: 'value' };
    const twoPorts = { ...emitDef, exposedInputs: [...emitDef.exposedInputs, p2] };
    const swapped = { ...emitDef, exposedInputs: [p2, ...emitDef.exposedInputs] };
    const mk = d => M.migrateForHarness({ ...baseModel, macroDefs: [d] });
    check('F3b a PORT REORDER is emit-identical (F8: the bridge matches by portId)',
      surfaces(mk(twoPorts)) === surfaces(mk(swapped)));
  }

  // The per-INSTANCE collapse state lives on the macro node's own config, which
  // IS hashed by accessor-CSE's purity key — so it has to be provably inert.
  {
    const collapsed = M.migrateForHarness({
      ...baseModel,
      macroDefs: [variants['a second control + groups']],
      graphNodes: baseModel.graphNodes.map(n => (n.data.nodeType === 'macro'
        ? { ...n, data: { ...n.data, config: { ...n.data.config, [M.CTL_COLLAPSED_KEY]: 'g1,g2' } } }
        : n)),
    });
    check('F3c the instance COLLAPSE STATE is emit-invisible', surfaces(collapsed) === baseline);
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
    // An EMPTY group is a real, draggable separator in the EDITOR but must draw
    // no box on the instance — a chevron that reveals nothing is exactly the
    // enabled control the doctrine forbids.
    check('G5b an EMPTY group draws NO box on the instance',
      eq(M.groupSections(d.controls, [...d.groups, { id: 'gEmpty', name: 'Empty' }])
        .map(s => s.group?.id ?? null), [null, 'gT']));
    check('G5c …while the EDITOR still lists its separator row',
      M.interfaceRows(d.controls, [...d.groups, { id: 'gEmpty', name: 'Empty' }], c => c.id)
        .some(r => r.kind === 'group' && r.group.id === 'gEmpty'));
    // Both boxes and the head come from the ONE partition, so a group whose
    // members are NOT contiguous in the array still renders as one box.
    check('G5d sections come from `interfaceRows`, so a non-canonical array still renders one box per group',
      eq(M.groupSections(
        [ctl('a', 'A', cfgTarget('ps', 'period'), { groupId: 'gT' }), ctl('b', 'B', cfgTarget('ps', 'phase')),
          ctl('c', 'C', cfgTarget('rnd', '_port_max'), { groupId: 'gT' })], d.groups)
        .map(s => [s.group?.id ?? null, s.items.map(i => i.id)]),
      [[null, ['b']], ['gT', ['a', 'c']]]));
  }

  // --- the per-INSTANCE collapse state (D5b) -------------------------------
  {
    check('G5e absent ⇒ every group expanded', M.collapsedGroupIds({}).size === 0);
    check('G5f …and an EMPTY string too (the pristine all-expanded value)',
      M.collapsedGroupIds({ [M.CTL_COLLAPSED_KEY]: '' }).size === 0);
    check('G5g a comma list reads back as its ids',
      eq([...M.collapsedGroupIds({ [M.CTL_COLLAPSED_KEY]: 'g1,g2' })].sort(), ['g1', 'g2']));
    const on = M.toggleCollapsedGroup({}, 'g1');
    check('G5h toggling collapses', on === 'g1');
    check('G5i …toggling again expands, back to the pristine value',
      M.toggleCollapsedGroup({ [M.CTL_COLLAPSED_KEY]: on }, 'g1') === '');
    check('G5j …and a second group joins the list without disturbing the first',
      eq([...M.collapsedGroupIds({ [M.CTL_COLLAPSED_KEY]: M.toggleCollapsedGroup({ [M.CTL_COLLAPSED_KEY]: 'g1' }, 'g2') })].sort(), ['g1', 'g2']));
    // It is a DISPLAY key: no control may ever bind it (it is in the
    // display-only exclusion set), which is what keeps it off every emit path.
    check('G5k the collapse key is NOT a bindable parameter', M.isExcludedControlKey(M.CTL_COLLAPSED_KEY));
    check('G5l …and it follows the compiler-invisible naming convention',
      M.CTL_COLLAPSED_KEY.startsWith('_') && !M.CTL_COLLAPSED_KEY.startsWith('_port_') && !M.CTL_COLLAPSED_KEY.startsWith('_varName_'));
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

  // --- PORTS: a plain reorder; NO edge is touched (D5b / F8) ---------------
  {
    const m = buildModel({ macroDefs: [ifaceDef()] });
    const base = defOf(m, 'def_i');
    const edgesJson = JSON.stringify(base.edges);
    const r = editDef(m, 'def_i', { kind: 'port-reorder', side: 'in', order: ['p3', 'p1', 'p2'] });
    const ins = r.def.exposedInputs;
    check('H14 the port array takes exactly the order it was given',
      eq(ins.map(p => p.portId), ['p3', 'p1', 'p2']), ins.map(p => p.portId).join(','));
    check('H15 …the portId SET is IDENTICAL', portIdSet(ins) === portIdSet(base.exposedInputs));
    check('H16 …every port object still carries its own label + internal mapping',
      ins.every(p => base.exposedInputs.some(b => b.portId === p.portId && b.label === p.label && b.internalPortId === p.internalPortId)));
    check('H17 …`def.edges` is === UNTOUCHED (F8: the bridge matches by portId)',
      r.def.edges === base.edges && JSON.stringify(r.def.edges) === edgesJson);
    check('H18 …and the OUTPUT port array is === untouched', r.def.exposedOutputs === base.exposedOutputs);
    check('H19 …the dispatch carried ONLY `exposedInputs`', eq(Object.keys(r.changes), ['exposedInputs']));
    check('H19b …no port ever gains a `groupId` (ports are group-free)',
      ins.every(p => !('groupId' in p)));

    // Misplace, never DROP: an `order` computed against a stale render still
    // has to bring every port back.
    const partial = editDef(m, 'def_i', { kind: 'port-reorder', side: 'in', order: ['p3', 'ghost'] });
    check('H20 an `order` naming an unknown port ignores it and keeps every real one',
      eq(partial.def.exposedInputs.map(p => p.portId), ['p3', 'p1', 'p2']));
    const dup = editDef(m, 'def_i', { kind: 'port-reorder', side: 'in', order: ['p2', 'p2', 'p1'] });
    check('H21 …and a DUPLICATED id is taken once', eq(dup.def.exposedInputs.map(p => p.portId), ['p2', 'p1', 'p3']));

    // The OUTPUT side reorders through the same edit, independently.
    const outR = editDef(r.model, 'def_i', { kind: 'port-reorder', side: 'out', order: ['q1'] });
    check('H22 the OUTPUT side reorders independently',
      eq(Object.keys(outR.changes), ['exposedOutputs']) && outR.def.exposedInputs === r.def.exposedInputs);
  }

  // --- CONTROLS: positional membership (D5b) -------------------------------
  {
    const G = M.ifaceGroupRowId, I = M.ifaceItemRowId;
    let m = buildModel({ macroDefs: [ifaceDef()] });
    m = editDef(m, 'def_i', { kind: 'group-add', group: { id: 'gB', name: 'Advanced' } }).model;
    const rows = M.interfaceRows(defOf(m, 'def_i').controls, defOf(m, 'def_i').groups, c => c.id);
    check('H23 the flat list is [ungrouped…, sep gA, gA…, sep gB] — an EMPTY group still gets a separator',
      eq(rows.map(r => (r.kind === 'group' ? `#${r.group.id}` : r.item.id)), ['k1', '#gA', 'k2', '#gB']),
      JSON.stringify(rows.map(r => (r.kind === 'group' ? `#${r.group.id}` : r.item.id))));

    // Drag k1 UNDER the gB separator ⇒ it JOINS gB, purely by position.
    const joined = editDef(m, 'def_i', { kind: 'control-reorder', order: [G('gA'), I('k2'), G('gB'), I('k1')] });
    check('H24 a control dropped under a separator JOINS that group',
      joined.def.controls.find(c => c.id === 'k1')?.groupId === 'gB');
    check('H24b …and the array comes back CANONICAL (position ⇔ membership)',
      eq(joined.def.controls.map(c => [c.id, c.groupId ?? '-']), [['k2', 'gA'], ['k1', 'gB']]),
      JSON.stringify(joined.def.controls.map(c => [c.id, c.groupId ?? '-'])));
    check('H24c …the control SET is identical and nothing lost its target',
      joined.def.controls.length === 2 && joined.def.controls.every(c => c.target.kind === 'config'));

    // Drag k2 ABOVE the first separator ⇒ it is UN-grouped, and the key is
    // DELETED rather than blanked ("ungrouped" is the ABSENT state).
    const freed = editDef(joined.model, 'def_i', { kind: 'control-reorder', order: [I('k2'), G('gA'), G('gB'), I('k1')] });
    check('H25 a control dropped above every separator is UN-grouped',
      !('groupId' in (freed.def.controls.find(c => c.id === 'k2') ?? { groupId: 1 })));

    // Drag the gB SEPARATOR up over k1 ⇒ the separator moves ALONE and CAPTURES
    // what now falls under it. This is the whole positional model in one edit.
    const captured = editDef(m, 'def_i', { kind: 'control-reorder', order: [G('gB'), I('k1'), G('gA'), I('k2')] });
    check('H26 dragging a SEPARATOR up captures what now sits under it',
      captured.def.controls.find(c => c.id === 'k1')?.groupId === 'gB');
    check('H26b …and the SECTION order followed the separator',
      eq(captured.def.groups.map(g => g.id), ['gB', 'gA']));
    check('H26c …so the dispatch carried `groups` as well as `controls`',
      eq(Object.keys(captured.changes).sort(), ['controls', 'groups']));
    check('H26d …and NOTHING was dropped', eq(captured.def.controls.map(c => c.id).sort(), ['k1', 'k2']));

    // A pure reorder INSIDE one bucket must not touch the group order at all.
    let m3 = buildModel({ macroDefs: [ifaceDef()] });
    m3 = editDef(m3, 'def_i', {
      kind: 'control-add',
      control: ctl('k3', 'Phase', cfgTarget('ps', 'phase'), { groupId: 'gA' }),
    }).model;
    const swapped = editDef(m3, 'def_i', { kind: 'control-reorder', order: [I('k1'), G('gA'), I('k3'), I('k2')] });
    check('H27 a swap WITHIN one group reorders only that bucket',
      eq(swapped.def.controls.map(c => c.id), ['k1', 'k3', 'k2']));
    check('H27b …and leaves `groups` out of the dispatch entirely',
      eq(Object.keys(swapped.changes), ['controls']));

    // Round trip: what the editor renders IS what the array stores.
    const rt = M.reorderInterface(swapped.def.controls, swapped.def.groups, c => c.id,
      M.interfaceRows(swapped.def.controls, swapped.def.groups, c => c.id).map(r => r.rowId));
    check('H27c interfaceRows → reorderInterface is the IDENTITY on a canonical array',
      eq(rt.items, swapped.def.controls) && eq(rt.groups, swapped.def.groups));

    // Misplace, never drop — same rule as the ports.
    const stale = editDef(m3, 'def_i', { kind: 'control-reorder', order: [I('k3'), I('nope')] });
    check('H27d a stale `order` keeps every control and every group',
      eq(stale.def.controls.map(c => c.id).sort(), ['k1', 'k2', 'k3'])
      && eq(stale.def.groups.map(g => g.id), ['gA']));
  }

  // --- deleting a separator MERGES upward and DELETES NOTHING -------------
  {
    const G = M.ifaceGroupRowId, I = M.ifaceItemRowId;
    let m = buildModel({ macroDefs: [ifaceDef()] });
    m = editDef(m, 'def_i', { kind: 'group-add', group: { id: 'gB', name: 'Advanced' } }).model;
    // [k1 (ungrouped)] [gA: k2] [gB: k3]
    m = editDef(m, 'def_i', {
      kind: 'control-add', control: ctl('k3', 'Phase', cfgTarget('ps', 'phase'), { groupId: 'gB' }),
    }).model;
    const before = defOf(m, 'def_i');
    const flat = d => M.interfaceRows(d.controls ?? [], d.groups ?? [], c => c.id)
      .filter(r => r.kind === 'item').map(r => r.item.id);

    const r = editDef(m, 'def_i', { kind: 'group-remove', groupId: 'gB' });
    const survivors = r.def.controls ?? [];   // `?? []` so a MUTATION FAILs legibly
    check('H28 every control survives a separator delete', eq(survivors.map(c => c.id).sort(), ['k1', 'k2', 'k3']));
    check('H28b …the deleted group\'s members MERGE into the section ABOVE',
      survivors.find(c => c.id === 'k3')?.groupId === 'gA');
    check('H28c …so not one control changes row', eq(flat(r.def), flat(before)));
    check('H28d …and the ports are untouched', portIdSet(r.def.exposedInputs) === portIdSet(before.exposedInputs));

    // Removing the FIRST separator un-groups its members (there is nothing above).
    const first = editDef(m, 'def_i', { kind: 'group-remove', groupId: 'gA' });
    check('H29 removing the FIRST separator un-groups its members, key DELETED',
      !('groupId' in ((first.def.controls ?? []).find(c => c.id === 'k2') ?? { groupId: 1 })));
    check('H29b …and they still resolve',
      !M.resolveControlDescriptor(first.model, 'def_i', (first.def.controls ?? []).find(c => c.id === 'k2')).block);
    check('H29c …and it is a NO-OP for a group that does not exist',
      eq(M.applyInterfaceEdit(before, { kind: 'group-remove', groupId: 'ghost' }), {}));
  }

  // --- removing the last group -------------------------------------------
  {
    let m = buildModel({ macroDefs: [ifaceDef()] });
    const before = defOf(m, 'def_i');
    const r = editDef(m, 'def_i', { kind: 'group-remove', groupId: 'gA' });
    check('H25b the LAST group removed leaves NO `groups` key', r.def.groups === undefined);
    check('H25c …and every control survives, un-grouped',
      eq((r.def.controls ?? []).map(c => c.id).sort(), ['k1', 'k2'])
      && (r.def.controls ?? []).every(c => !('groupId' in c)));
    check('H25d …with the ports untouched', r.def.exposedInputs === before.exposedInputs);
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

    // --- the D5b wiring, pinned in SOURCE (it lives in a React component) ---
    check('H54 the boundary editor renders the FLAT list from `interfaceRows`',
      /const ifaceRows = useMemo\(\s*\n?\s*\(\) => interfaceRows\(macroDefForBoundary\?\.controls/.test(cn));
    check('H55 …the PORT list dispatches `port-reorder` through the ONE builder',
      /editInterface\(\{ kind: 'port-reorder', side: isMacroInput \? 'in' : 'out', order \}\)/.test(cn));
    check('H56 …and the CONTROL list dispatches `control-reorder` with the flat ROW ids',
      /editInterface\(\{ kind: 'control-reorder', order \}\)/.test(cn)
      && cn.includes('ifaceReorder.startDrag(row.rowId)'));
    check('H57 …both lists reorder through the SHARED `useListReorder` hook',
      cn.includes("import { useListReorder } from '../panels/useListReorder';")
      && /const portReorder = useListReorder\(/.test(cn) && /const ifaceReorder = useListReorder\(/.test(cn));
    // "Groups become separators, NOT memberships": the dropdown is gone, so a
    // group can only ever be joined by DROPPING a row under its separator.
    check('H58 there is no group-membership dropdown left anywhere',
      !cn.includes("kind: 'control-group'") && !cn.includes("kind: 'port-group'")
      && !/value=\{(c|p)\.groupId \?\? ''\}/.test(cn));
    check('H59 the closed instance toggles collapse through the ONE helper, on the INSTANCE config',
      /updateConfig\(CTL_COLLAPSED_KEY, toggleCollapsedGroup\(nodeData\.config, groupId\)\)/.test(cn));

    // A group box may wrap CONTROL rows only: a handle inside a collapsible
    // region would VANISH with its box, taking its edges' anchor with it.
    const secStart = cn.indexOf('{nodeData.nodeType === \'macro\' && controlSections.length > 0 && (');
    const secEnd = cn.indexOf('{nodeData.nodeType === \'macro\' && (', secStart + 1);
    const section = cn.slice(secStart, secEnd);
    check('H60 the instance\'s interface section renders NO handle',
      secStart > 0 && secEnd > secStart && !section.includes('<Handle'), `${secStart}..${secEnd}`);
    check('H61 …and only the group BODY is conditional on the collapse state',
      /\{!collapsed && <div className=\{styles\.ctlGroupBody\}>\{rows\}<\/div>\}/.test(section));
    check('H62 …while the UNGROUPED head is never collapsible',
      section.includes('if (!sec.group) return <Fragment key={`__ungrouped_${si}`}>{rows}</Fragment>;'));
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
  // The key/facet rows go through `controlTargetOf`, which is the ONE place a
  // row's shape decides the target's shape — nothing in CaNode branches on class.
  check('K14 …and both row kinds bind through the ONE dispatch path',
    /const bindPick = useCallback\(\s*\(row: ControlKeyDescriptor\) => bindPickTarget\(controlTargetOf\(id, row\), row\.label\)/.test(cn));
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

// ===========================================================================
console.log('\n--- Tier L: pick-mode HOTSPOTS — the eligibility intersection ---');
// ===========================================================================
// Pick mode offers every eligible parameter with a translucent hotspot measured
// ON TOP of its own widget. The position comes from a `data-ctl-key` DOM marker
// and the AUTHORITY comes from `eligibleControlKeys`; `partitionPickTargets` is
// where the two meet, so it is the piece that must never let a marker invent a
// target. The DOM half cannot run in Node, so it is pinned in SOURCE below.
{
  const row = (configKey, klass = 'B', extra = {}) => ({ configKey, label: configKey, kind: 'select', klass, ...extra });
  const rows = [row('_port_a', 'A'), row('operation'), row('attributeId', 'C'), row('_port_b', 'A', { wired: true })];

  {
    const p = M.partitionPickTargets(rows, new Set(['operation', 'attributeId']));
    check('L1 a measured eligible key gets a HOTSPOT',
      eq(p.hotspots.map(r => r.configKey), ['operation', 'attributeId']));
    check('L2 …and an unmeasured one falls back instead of vanishing',
      eq(p.fallback.map(r => r.configKey), ['_port_a', '_port_b']));
    check('L3 the two sides PARTITION the offer — every row exactly once',
      p.hotspots.length + p.fallback.length === rows.length
      && new Set([...p.hotspots, ...p.fallback].map(r => r.configKey)).size === rows.length);
    check('L4 …preserving each side\'s own order', p.fallback[0].configKey === '_port_a');
    check('L5 …and carrying the row through verbatim (the `wired` flag survives)',
      p.fallback[1].wired === true);
  }
  {
    // THE INVARIANT: a marker is a POSITION source, never an authority. A
    // coupled class-C picker IS marked in the DOM (it shares its element list)
    // but is never eligible, so it must not become bindable.
    const p = M.partitionPickTargets(rows, new Set(['operation', 'tagAttributeId', 'constType']));
    check('L6 a MEASURED key that is not eligible is DROPPED, never invented',
      p.hotspots.length + p.fallback.length === rows.length
      && ![...p.hotspots, ...p.fallback].some(r => r.configKey === 'tagAttributeId' || r.configKey === 'constType'));
    check('L7 nothing measured ⇒ everything falls back',
      M.partitionPickTargets(rows, new Set()).fallback.length === rows.length);
    check('L8 everything measured ⇒ everything is a hotspot',
      M.partitionPickTargets(rows, new Set(rows.map(r => r.configKey))).hotspots.length === rows.length);
    check('L9 no eligible rows ⇒ no offer at all',
      M.partitionPickTargets([], new Set(['operation'])).hotspots.length === 0);
  }

  // --- MARKER COVERAGE: every class-B/C parameter the resolver can offer has a
  //     widget marked in CaNode, or its hotspot could never be measured. -----
  {
    const { readFileSync } = await import('fs');
    const cn = readFileSync(join(ROOT, 'src', 'modeler', 'vpl', 'CaNode.tsx'), 'utf8');
    const model = buildModel({
      mappings: [{ id: 'm_out', name: 'Viz', isAttributeToColor: true }],
      indicators: [{ id: 'i_std', name: 'Pop', kind: 'standalone', dataType: 'integer' }],
      variables: [{ id: 'v_s', name: 'acc', kind: 'scalar', dataType: 'float', initialValue: '0' }],
      sprites: [{ id: 'sp', name: 'Bird', dataUrl: 'data:,', mimeType: 'image/png' }],
    });
    const types = new Set([...M.SCALAR_CONFIG_KEYS.keys()]);
    for (const t of ['getCellAttribute', 'setCellLooks', 'getVariable', 'setAgentSprite', 'lookupInteraction']) types.add(t);
    // …and every node that declares a class-D FACET, so an unmarked multi-key
    // editor fails here rather than shipping a parameter pick mode cannot offer.
    for (const t of M.FACET_SPECS.keys()) types.add(t);
    const want = new Set();
    const wantFacets = new Set();
    for (const t of types) {
      for (const r of M.eligibleControlKeys(t, {}, model)) {
        // class A is marked ONCE, generically, in the input-port loop.
        if (r.klass === 'D') wantFacets.add(r.facet);
        else if (r.klass !== 'A') want.add(r.configKey);
      }
    }
    const missingFacets = [...wantFacets].filter(f => !cn.includes(`data-ctl-facet="${f}"`));
    // A handful of keys are marked through a SHARED render helper rather than a
    // literal, so the attribute never appears as a string. Named here (with the
    // helper pinned below) so the coverage check stays honest instead of being
    // loosened to a substring match that would pass on nothing at all.
    const DYNAMIC_MARKERS = new Map([
      // `setAgentSprite`'s six facet checkboxes all render through one `cbx`.
      ['setSprite', 'cbx'], ['setFrame', 'cbx'], ['setSpeed', 'cbx'],
      ['setRotation', 'cbx'], ['setScale', 'cbx'], ['setAlpha', 'cbx'],
    ]);
    const missing = [...want].filter(k => !cn.includes(`data-ctl-key="${k}"`) && !DYNAMIC_MARKERS.has(k));
    check(`L10 every class-B/C parameter has a marked widget (${want.size} keys)`,
      missing.length === 0, missing.join(' '));
    check('L10b …and the shared-helper markers really are marked, once, by that helper',
      /const cbx = \(key: string,[\s\S]{0,400}?data-ctl-key=\{key\}/.test(cn)
      && [...DYNAMIC_MARKERS.keys()].every(k => cn.includes(`cbx('${k}'`)));
    check(`L10c every class-D FACET has a marked editor block (${wantFacets.size} facets)`,
      wantFacets.size >= 3 && missingFacets.length === 0, missingFacets.join(' '));
    check('L11 …and the coverage set is not vacuous', want.size > 40, String(want.size));
    check('L12 class A is marked ONCE, from the port loop', cn.includes('data-ctl-key={configKey}'));
    check('L13 …and the chaining rows carry their own marker',
      cn.includes('data-ctl-chain={chainId}') && cn.includes('chainId={control.id}'));
  }

  // --- the mechanism, pinned in SOURCE (it lives in a React component) ------
  {
    const { readFileSync } = await import('fs');
    const cn = readFileSync(join(ROOT, 'src', 'modeler', 'vpl', 'CaNode.tsx'), 'utf8');
    const css = readFileSync(join(ROOT, 'src', 'modeler', 'vpl', 'CaNode.module.css'), 'utf8');
    check('L14 the hotspots come from the SHARED intersection, not a local filter',
      /partitionPickTargets\(pickRows, measuredPickKeys, measuredPickFacets\)/.test(cn));
    check('L15 the measure reads ALL THREE marker kinds off the node root',
      cn.includes("root.querySelectorAll<HTMLElement>('[data-ctl-key],[data-ctl-facet],[data-ctl-chain]')"));
    // React Flow scales the viewport; deriving the zoom from the node itself
    // keeps every node off the store's pan/zoom re-render path.
    check('L16 …and derives the zoom from the NODE, never from the store',
      cn.includes('const zoom = rootRect.width / root.offsetWidth;')
      && !/useStore\([^)]*transform/.test(cn));
    check('L17 the measure→setState loop is broken by an identity-preserving compare',
      /samePickRects\(prev\.keys, keys\) && samePickRects\(prev\.facets, facets\) && samePickRects\(prev\.chains, chains\)\s*\r?\n?\s*\? prev :/.test(cn));
    check('L18 the ResizeObserver is installed only while ARMED',
      /if \(!pickArmed \|\| !root \|\| typeof ResizeObserver === 'undefined'\) return;/.test(cn));
    // The class-A widget is inert because the hotspot takes the pointer — the
    // old inert-capture handlers and the `.pickable` outline are both gone.
    check('L19 the class-A widget needs no capture handlers of its own',
      !cn.includes('onClickCapture') && !cn.includes('styles.pickable'));
    check('L20 …and `.pickable` is gone from the stylesheet', !css.includes('.pickable'));
    check('L21 the always-on B/C LIST is gone — the fallback shows only what is NOT on screen',
      !cn.includes('pickOverlayRows')
      && /\{pickFallbackRows\.map/.test(cn) && /\{pickChainFallback\.map/.test(cn));
    // ⚠ CRLF: anchor on `\r?\n`, never a bare `\n` (this file is CRLF on disk).
    check('L22 the hotspot layer is the LAST child of the node root (paints on top)',
      /\{pickChainHotspots\.map[\s\S]*?\r?\n {4}<\/div>\r?\n {2}\);\r?\n\}/.test(cn));
    check('L23 the hotspot is absolutely positioned from the measured box',
      /style=\{\{ left: box\.l, top: box\.t, width: box\.w, height: box\.h \}\}/.test(cn));
    check('L24 …and is translucent, so the widget reads THROUGH it',
      /\.pickHotspot \{[\s\S]*?opacity: 0\.\d+;/.test(css));
    check('L25 a chained row that would CYCLE is offered but refused',
      cn.includes('styles.pickHotspotBlocked') && /disabled=\{r\.cycle\}/.test(cn));
  }
}

// ===========================================================================
console.log('\n--- Tier M: class D — MULTI-KEY EDITORS as FACETS (D11) --------');
// ===========================================================================
// A facet binds a WHOLE multi-key editor and writes through the NODE'S OWN
// writer, which is what dissolves v1's one-control-one-value exclusion. The
// property that makes it safe is EQUIVALENCE: the config an instance edit
// produces must be byte-identical to the same edit made inside the macro — so
// the load-bearing checks here compare the two configs, not just "it changed".
{
  const gradCfg = () => ({
    method: 'linear', stopCount: 2,
    stop_0_position: '0', stop_0_r: '0', stop_0_g: '0', stop_0_b: '0',
    stop_1_position: '1', stop_1_r: '255', stop_1_g: '255', stop_1_b: '255',
  });
  const palCfg = () => ({ count: 2, entry_0_r: '10', entry_0_g: '20', entry_0_b: '30', entry_1_r: '40', entry_1_g: '50', entry_1_b: '60', default_r: '1', default_g: '2', default_b: '3' });
  const constCfg = () => ({ r: '10', g: '20', b: '30' });

  /** A def whose three internal nodes each carry one multi-key editor. */
  const buildFacetDef = () => ({
    id: 'def_f', name: 'Facets',
    nodes: [
      node('mi', 'macroInput', { macroDefId: 'def_f' }),
      node('cs', 'colorScale', gradCfg()),
      node('cc', 'categoricalColor', palCfg()),
      node('gk', 'getColorConstant', constCfg()),
      node('mo', 'macroOutput', { macroDefId: 'def_f' }),
    ],
    edges: [],
    exposedInputs: [], exposedOutputs: [],
  });
  const facetModel = (controls) => buildModel({
    macroDefs: [{ ...buildFacetDef(), ...(controls ? { controls } : {}) }],
  });
  const fTarget = (nodeId, facet) => ({ kind: 'facet', nodeId, facet });
  const cfgOf = (model, defId, nodeId) => nodeOf(model, defId, nodeId).data.config;

  // --- eligibility ---------------------------------------------------------
  {
    const m = facetModel();
    const gRows = M.eligibleControlKeys('colorScale', gradCfg(), m);
    const gFacets = gRows.filter(r => r.klass === 'D');
    check('M1 Color Scale offers its GRADIENT as one facet',
      gFacets.length === 1 && gFacets[0].facet === 'colorScaleStops' && gFacets[0].kind === 'facet',
      JSON.stringify(gFacets));
    check('M1b …with an empty configKey — a facet has no single key to name',
      gFacets[0].configKey === '');
    check('M2 …and its `method` stays a SEPARATE class-B parameter',
      gRows.some(r => r.klass === 'B' && r.configKey === 'method'));
    // THE COUPLED-WRITE RULE STILL HOLDS: the members are never bindable.
    const memberKeys = ['stop_0_r', 'stop_1_position', 'stopCount', 'entry_0_g', 'default_b', 'count'];
    check('M3 the facet\'s MEMBER keys are still refused, one by one',
      memberKeys.every(k => M.isExcludedControlKey(k))
      && !gRows.some(r => memberKeys.includes(r.configKey)), memberKeys.filter(k => !M.isExcludedControlKey(k)).join(' '));
    check('M3b …and a hand-edited control naming ONE member reports `orphan-key`',
      memberKeys.every(k => M.resolveControlDescriptor(
        facetModel([ctl('c_x', 'X', cfgTarget('cs', k))]), 'def_f', ctl('c_x', 'X', cfgTarget('cs', k)),
      ).block === 'orphan-key'));
    const pRows = M.eligibleControlKeys('categoricalColor', palCfg(), m).filter(r => r.klass === 'D');
    check('M4 Categorical Color offers its PALETTE as one facet',
      pRows.length === 1 && pRows[0].facet === 'categoricalPalette');
    const kRows = M.eligibleControlKeys('getColorConstant', constCfg(), m).filter(r => r.klass === 'D');
    check('M5 Color Constant offers its RGB(A) as one facet',
      kRows.length === 1 && kRows[0].facet === 'colorConstant');
    check('M6 a node with NO multi-key editor offers no facet at all',
      M.eligibleControlKeys('statement', {}, m).every(r => r.klass !== 'D'));
    check('M7 `controlTargetOf` reads the row\'s shape — facet vs config',
      eq(M.controlTargetOf('cs', gFacets[0]), { kind: 'facet', nodeId: 'cs', facet: 'colorScaleStops' })
      && eq(M.controlTargetOf('cs', gRows.find(r => r.configKey === 'method')),
        { kind: 'config', nodeId: 'cs', configKey: 'method' }));
  }

  // --- the descriptor ------------------------------------------------------
  {
    const controls = [
      ctl('c_g', 'Ramp', fTarget('cs', 'colorScaleStops')),
      ctl('c_p', 'Palette', fTarget('cc', 'categoricalPalette')),
      ctl('c_k', 'Tint', fTarget('gk', 'colorConstant')),
    ];
    const m = facetModel(controls);
    const dg = M.resolveControlDescriptor(m, 'def_f', controls[0]);
    check('M8 a gradient facet resolves to the node\'s OWN raw (unsorted) parse',
      dg.kind === 'facet' && !dg.block && dg.facet.widget === 'gradient'
      && eq(dg.facet.stops, M.readColorScaleStopsRaw(gradCfg())), JSON.stringify(dg));
    check('M8b …and carries no scalar `value` (a gradient has no one string)', dg.value === '');
    const dp = M.resolveControlDescriptor(m, 'def_f', controls[1]);
    check('M9 a palette facet resolves to entries + the out-of-range default',
      dp.facet.widget === 'palette' && dp.facet.entries.length === 2
      && eq(dp.facet.fallback, { r: 1, g: 2, b: 3, a: undefined }), JSON.stringify(dp.facet));
    const dk = M.resolveControlDescriptor(m, 'def_f', controls[2]);
    check('M10 a colour facet resolves to a COMPLETE rgba (absent a ⇒ opaque)',
      dk.facet.widget === 'color' && eq(dk.facet.color, { r: 10, g: 20, b: 30, a: 255 }));
    check('M11 the interface editor names the facet by its own label',
      M.describeControlTarget(m, 'def_f', controls[0]).text.endsWith('· Gradient')
      && M.describeControlTarget(m, 'def_f', controls[1]).text.endsWith('· Palette'));

    // D8 — report, never drop.
    const gone = { ...m, macroDefs: [{ ...m.macroDefs[0], nodes: m.macroDefs[0].nodes.filter(n => n.id !== 'cs') }] };
    check('M12 a deleted target node reports `orphan-node`',
      M.resolveControlDescriptor(gone, 'def_f', controls[0]).block === 'orphan-node');
    const retyped = {
      ...m,
      macroDefs: [{ ...m.macroDefs[0], nodes: m.macroDefs[0].nodes.map(n => (n.id === 'cs' ? node('cs', 'statement', {}) : n)) }],
    };
    check('M13 …and a node RETYPED out of its facet reports `orphan-key`',
      M.resolveControlDescriptor(retyped, 'def_f', controls[0]).block === 'orphan-key');
    check('M14 a hand-edited unknown facet name reports `orphan-key`, never throws',
      M.resolveControlDescriptor(m, 'def_f', ctl('c_x', 'X', fTarget('cs', 'nonsense'))).block === 'orphan-key');
    // R7 — the def is open for editing.
    check('M15 an OPEN def reports `scope-open` and is not writable',
      M.resolveControlDescriptor(m, 'def_f', controls[0], ['def_f']).block === 'scope-open'
      && M.applyControlFacet(m, 'def_f', controls[0], { widget: 'gradient', stops: [] }, ['def_f']) === null);
  }

  // --- ⚠ THE EQUIVALENCE: an instance write == the same in-node write -------
  {
    const controls = [
      ctl('c_g', 'Ramp', fTarget('cs', 'colorScaleStops')),
      ctl('c_p', 'Palette', fTarget('cc', 'categoricalPalette')),
      ctl('c_k', 'Tint', fTarget('gk', 'colorConstant')),
    ];
    const m = facetModel(controls);

    const nextStops = [
      { p: 0, r: 255, g: 0, b: 0 },
      { p: 0.5, r: 0, g: 255, b: 0 },
      { p: 1, r: 0, g: 0, b: 255 },
    ];
    const patchG = M.applyControlFacet(m, 'def_f', controls[0], { widget: 'gradient', stops: nextStops });
    const instG = patchG.nodes.find(n => n.id === 'cs').data.config;
    // THE in-node edit, verbatim: the node's own writer over the same config.
    const inNodeG = M.writeColorScaleStops(gradCfg(), nextStops);
    check('M16 a gradient instance write is BYTE-IDENTICAL to the in-node write',
      eq(instG, inNodeG), JSON.stringify(instG) + ' vs ' + JSON.stringify(inNodeG));
    check('M16b …so it grows the stop count and keeps every unrelated key',
      instG.stopCount === 3 && instG.stop_2_b === '255' && instG.method === 'linear');
    check('M17 …and every UNTOUCHED node keeps its object identity',
      patchG.defId === 'def_f'
      && patchG.nodes.filter(n => n.id !== 'cs').every((n, i) => n === m.macroDefs[0].nodes.filter(x => x.id !== 'cs')[i]));

    const nextEntries = [{ r: 9, g: 9, b: 9 }];
    const nextDefault = { r: 7, g: 7, b: 7 };
    const patchP = M.applyControlFacet(m, 'def_f', controls[1], { widget: 'palette', entries: nextEntries, fallback: nextDefault });
    const instP = patchP.nodes.find(n => n.id === 'cc').data.config;
    check('M18 a palette instance write is BYTE-IDENTICAL to the in-node write',
      eq(instP, M.writeCategoricalPalette(palCfg(), nextEntries, nextDefault)));
    check('M18b …and the removed entry\'s keys are GONE, not left stale',
      instP.count === 1 && instP.entry_1_r === undefined);

    const patchK = M.applyControlFacet(m, 'def_f', controls[2], { widget: 'color', color: { r: 1, g: 2, b: 3, a: 255 } });
    const instK = patchK.nodes.find(n => n.id === 'gk').data.config;
    check('M19 a colour instance write is BYTE-IDENTICAL to the in-node write',
      eq(instK, M.writeColorConstant(constCfg(), { r: 1, g: 2, b: 3, a: 255 })));

    // ── THE OPTION-A ALPHA GATE, which the facet inherits from the writer ──
    const withAlpha = M.applyControlFacet(m, 'def_f', controls[0], {
      widget: 'gradient',
      stops: [{ p: 0, r: 0, g: 0, b: 0, a: 128 }, { p: 1, r: 255, g: 255, b: 255 }],
    }).nodes.find(n => n.id === 'cs').data.config;
    check('M20 a NON-opaque instance edit writes every stop\'s `a`',
      withAlpha.stop_0_a === '128' && withAlpha.stop_1_a === '255'
      && M.colorScaleHasAlpha(withAlpha) === true);
    const backOpaque = M.applyControlFacet({ ...m, macroDefs: [{ ...m.macroDefs[0], nodes: m.macroDefs[0].nodes.map(n => (n.id === 'cs' ? { ...n, data: { ...n.data, config: withAlpha } } : n)) }] },
      'def_f', controls[0], { widget: 'gradient', stops: [{ p: 0, r: 0, g: 0, b: 0 }, { p: 1, r: 255, g: 255, b: 255 }] })
      .nodes.find(n => n.id === 'cs').data.config;
    check('M21 …and dragging alpha back to full leaves NO `a` key at all',
      backOpaque.stop_0_a === undefined && backOpaque.stop_1_a === undefined
      && M.colorScaleHasAlpha(backOpaque) === false);
    const kAlphaBack = M.applyControlFacet(
      { ...m, macroDefs: [{ ...m.macroDefs[0], nodes: m.macroDefs[0].nodes.map(n => (n.id === 'gk' ? { ...n, data: { ...n.data, config: { ...constCfg(), a: '40' } } } : n)) }] },
      'def_f', controls[2], { widget: 'color', color: { r: 10, g: 20, b: 30, a: 255 } },
    ).nodes.find(n => n.id === 'gk').data.config;
    check('M22 …the colour facet DELETES its `a` key the same way',
      kAlphaBack.a === undefined && M.colorConstantHasAlpha(kAlphaBack) === false);

    // A mismatched widget is REFUSED rather than coerced.
    check('M23 a value whose widget does not match the facet is refused',
      M.applyControlFacet(m, 'def_f', controls[0], { widget: 'palette', entries: [], fallback: { r: 0, g: 0, b: 0 } }) === null);
    check('M24 a SCALAR write against a facet control is refused (never half a state)',
      M.applyControlValue(m, 'def_f', controls[0], 'nonsense') === null
      && eq(cfgOf(m, 'def_f', 'cs'), gradCfg()));
    check('M25 …and a FACET write against a scalar control is refused too',
      M.applyControlFacet(facetModel([ctl('c_m', 'Curve', cfgTarget('cs', 'method'))]), 'def_f',
        ctl('c_m', 'Curve', cfgTarget('cs', 'method')), { widget: 'gradient', stops: [] }) === null);
  }

  // --- the clone (R2 — the highest-risk edit) ------------------------------
  {
    const controls = [
      ctl('c_g', 'Ramp', fTarget('cs', 'colorScaleStops')),
      ctl('c_k', 'Tint', fTarget('gk', 'colorConstant')),
    ];
    const src = { ...buildFacetDef(), controls };
    const clone = M.cloneMacroWithFreshIds(src);
    const csClone = clone.nodes.find(n => n.data.nodeType === 'colorScale');
    const cg = clone.controls.find(c => c.id === 'c_g');
    check('M26 the clone carries the facet controls', clone.controls.length === 2);
    check('M27 …REMAPS `target.nodeId` (an un-remapped one edits the WRONG node)',
      cg.target.nodeId === csClone.id && cg.target.nodeId !== 'cs');
    check('M28 …and PRESERVES the facet NAME and the control id',
      cg.target.kind === 'facet' && cg.target.facet === 'colorScaleStops' && cg.id === 'c_g');
    const cloneModel = buildModel({ macroDefs: [clone] });
    const dc = M.resolveControlDescriptor(cloneModel, clone.id, cg);
    check('M29 …so the cloned control still resolves, to ITS OWN node',
      !dc.block && dc.resolved.nodeId === csClone.id && dc.facet.widget === 'gradient');
    check('M30 a facet-free def still clones with NO `controls` key',
      M.cloneMacroWithFreshIds(buildFacetDef()).controls === undefined);
  }

  // --- chaining onto a facet (D4 × D11) ------------------------------------
  {
    const inner = { ...buildFacetDef(), controls: [ctl('ic', 'Inner ramp', fTarget('cs', 'colorScaleStops'))] };
    const outer = {
      id: 'def_o', name: 'Outer',
      nodes: [node('inst', 'macro', { macroDefId: 'def_f' })],
      edges: [], exposedInputs: [], exposedOutputs: [],
      controls: [ctl('oc', 'Ramp', { kind: 'control', nodeId: 'inst', controlId: 'ic' })],
    };
    const m = buildModel({ macroDefs: [inner, outer] });
    const res = M.resolveTarget(m.macroDefs, 'def_o', outer.controls[0].target);
    check('M31 a chain ending in a FACET resolves to the inner def\'s node + facet',
      res.ok && res.at.defId === 'def_f' && res.at.nodeId === 'cs' && res.at.facet === 'colorScaleStops');
    const d = M.resolveControlDescriptor(m, 'def_o', outer.controls[0]);
    check('M32 …and renders the inner editor under the OUTER control\'s name',
      d.kind === 'facet' && d.label === 'Ramp' && !d.block && d.facet.widget === 'gradient');
    const patch = M.applyControlFacet(m, 'def_o', outer.controls[0], {
      widget: 'gradient', stops: [{ p: 0, r: 1, g: 2, b: 3 }, { p: 1, r: 4, g: 5, b: 6 }],
    });
    check('M33 …and a chained facet write lands in the NESTED def',
      patch.defId === 'def_f' && patch.nodes.find(n => n.id === 'cs').data.config.stop_0_r === '1');
    check('M34 …while the OPEN inner def still blocks the outer control (R7)',
      M.resolveControlDescriptor(m, 'def_o', outer.controls[0], ['def_f']).block === 'scope-open');
  }

  // --- serialization / sanitize -------------------------------------------
  {
    const controls = [ctl('c_g', 'Ramp', fTarget('cs', 'colorScaleStops'))];
    const m = facetModel(controls);
    const round = M.parseModelJSON(M.serializeModel(m));
    check('M35 a facet target survives the `.gcaproj` round trip verbatim',
      eq(defOf(round, 'def_f').controls, controls));
    const mf = M.parseMacroFile(JSON.stringify(M.buildMacroFile(m.macroDefs[0])));
    check('M36 …and the `.gcamacro` round trip', eq(mf.macroDef.controls, controls));
    const bad = JSON.parse(JSON.stringify(M.buildMacroFile(m.macroDefs[0])));
    bad.macroDef.controls = 'nope';
    check('M37 …while a malformed `controls` is still DROPPED, never thrown',
      M.parseMacroFile(JSON.stringify(bad)).macroDef.controls === undefined);
  }

  // --- pick mode: the facet namespace --------------------------------------
  {
    const rows = [
      { configKey: 'method', label: 'Curve', kind: 'select', klass: 'B' },
      { configKey: '', facet: 'colorScaleStops', label: 'Gradient', kind: 'facet', klass: 'D' },
    ];
    const p = M.partitionPickTargets(rows, new Set(['method']), new Set(['colorScaleStops']));
    check('M38 a measured FACET gets a hotspot, from its OWN namespace',
      p.hotspots.length === 2 && p.hotspots[1].facet === 'colorScaleStops');
    // ⚠ The two namespaces are kept apart on purpose: a config key that happened
    // to share a facet's name must never claim its hotspot.
    check('M39 a facet measured only as a KEY falls back — the namespaces do not mix',
      M.partitionPickTargets(rows, new Set(['method', 'colorScaleStops']), new Set()).fallback.length === 1
      && M.partitionPickTargets(rows, new Set(['method', 'colorScaleStops']), new Set()).fallback[0].facet === 'colorScaleStops');
    check('M40 …and a measured facet that is not eligible is DROPPED, never invented',
      M.partitionPickTargets([rows[0]], new Set(['method']), new Set(['colorScaleStops'])).hotspots.length === 1);
  }

  // --- emit identity (R8), the structural proof ----------------------------
  {
    const stripped = facetModel();
    const withCtl = facetModel([ctl('c_g', 'Ramp', fTarget('cs', 'colorScaleStops'))]);
    const flat = (m) => JSON.stringify(M.expandMacros(
      [node('inst', 'macro', { macroDefId: 'def_f' })], [], m.macroDefs,
    ));
    check('M41 a facet control changes NOTHING that reaches a compiler',
      flat(stripped) === flat(withCtl));
  }

  // --- the shared widget + the writers, pinned in SOURCE --------------------
  {
    const { readFileSync } = await import('fs');
    const cn = readFileSync(join(ROOT, 'src', 'modeler', 'vpl', 'CaNode.tsx'), 'utf8');
    const ec = readFileSync(join(ROOT, 'src', 'modeler', 'vpl', 'explicitControls.ts'), 'utf8');
    // DUAL CONSUMPTION: the instance renders the SAME component the node does.
    check('M42 the in-node palette editor renders the SHARED widget',
      cn.includes('<CategoricalPaletteEditor') && cn.includes("from './widgets/CategoricalPaletteEditor'"));
    check('M43 …and both editors write through the NODE\'S OWN writer, not a local copy',
      cn.includes('writeCategoricalPalette(nodeData.config') && cn.includes('writeColorScaleStops(nodeData.config')
      && cn.includes('writeColorConstant(nodeData.config')
      // the hand-rolled entry loop the extraction replaced is gone
      && !/\^entry_\\d\+_\(r\|g\|b\|a\)\$/.test(cn));
    check('M44 …and the facet WRITE goes through the spec\'s writer, never key by key',
      /spec\.write\(cfg, value\)/.test(ec) && /if \(!spec \|\| spec\.widget !== value\.widget\) return null;/.test(ec));
    check('M45 the instance renders the same two widgets for its facet rows',
      /case 'facet'/.test(cn) && /<GradientStopsEditor[\s\S]{0,200}onFacetChange\(\{ widget: 'gradient'/.test(cn)
      && /<CategoricalPaletteEditor[\s\S]{0,300}onFacetChange\(\{ widget: 'palette'/.test(cn));
    check('M46 …inside a `nodrag` wrapper, so dragging a stop never drags the NODE',
      /case 'facet': \{[\s\S]{0,900}className="nodrag"/.test(cn));
  }
}

// ---------------------------------------------------------------------------
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
