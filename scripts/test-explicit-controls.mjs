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
} from '../src/modeler/vpl/explicitControls.ts';
export { cloneMacroWithFreshIds, countMacroInstances } from '../src/model/macroImport.ts';
export { serializeModel, parseModelJSON, buildMacroFile, parseMacroFile } from '../src/model/fileOperations.ts';
export { expandMacros } from '../src/modeler/vpl/compiler/macroExpand.ts';
export { getEffectivePorts } from '../src/modeler/vpl/effectivePorts.ts';
export { getActiveGraphKind, setActiveGraphKind } from '../src/modeler/vpl/graphState.ts';
export { writeGraphClipboard, readGraphClipboard } from '../src/modeler/vpl/graphClipboard.ts';
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

  // --- class gate (P4) ----------------------------------------------------
  const withC = M.eligibleControlKeys('setAttribute', nodeOf(model, 'def_a', 'sa').data.config, model, undefined, new Set(['A', 'B', 'C']));
  check('A36 the default classes offer NO element rows (the P4 gate)', !keysOf('sa').includes('attributeId'));
  check('A37 elementOptionsFor is the P4 stub (returns null)', M.elementOptionsFor('setAttribute', 'attributeId', model) === null);
  check('A38 …so enabling class C offers nothing YET', !withC.some(r => r.klass === 'C'));
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
  check('D1 A→B→C resolves to the ULTIMATE address in C', r.ok && r.at.defId === 'def_c' && r.at.nodeId === 'leaf' && r.at.configKey === '_port_min', JSON.stringify(r));
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
  check('D11 …landing in the CLONED leaf def, not the original', rClone.resolved.defId === cC.id);
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

// ---------------------------------------------------------------------------
rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
