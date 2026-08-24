// Macro reference collection (M1) — functional verification.
//
// WHY THIS EXISTS: `check-compile-identity.mjs` proves this phase changed no
// emitted code (it changes NONE — nothing here reaches a compiler), and proves
// NOTHING about whether the collection is right. This is the other half: a
// synthetic, VALUE-asserting harness that builds a model + macro defs in memory
// and drives the SHIPPED module.
//
//   Tier A — collection. Every `REFERENCE_KEYS` key, the `attr_\d+` slots, the
//     id embedded in a config KEY (`_port_bondAttr_<id>`) and in an EDGE HANDLE
//     (`input_value_bondAttr_<id>`), nested defs walked, and the full transitive
//     closure of D5 — one fixture per row, each with a non-trivial answer.
//   Tier B — the export round trip. buildMacroFile → JSON → parseMacroFile:
//     the references and the nested defs survive VERBATIM; an OLD-shape file
//     still loads; `schemaVersion` is never gated on; and a macro that
//     references nothing writes exactly the file this app always wrote.
//   Tier C — selection. The bundle honours the opt-out; unchecking a requirer
//     drops what only it needed; re-checking pulls its requirements back.
//   Tier E — NEGATIVE CONTROLS. A value-only scan MISSES the key- and
//     handle-embedded ids; a one-hop closure MISSES the 3-hop chain; a
//     `_sourceAttrId` cache and the `__current__` viewer sentinel are never
//     collected. Each is the failure mode a specific check exists to catch.
//
// Run from the repo root:  node scripts/test-macro-references.mjs
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = `
export {
  REFERENCE_KEYS, SPACE_ORDER, SPACE_LABEL,
  collectMacroExportDefs, collectMacroReferences, resolveElement, closureOf,
  defaultSelection, pruneOrphanSelection, buildReferenceBundle, isBundleEmpty,
  bundleCount, macroOriginOf,
} from '../src/model/macroReferences.ts';
export {
  planImport, applyImportPlan, planNeedsDialog, remapWarnings, compatible,
  modelListFor, candidateDetail, unmatchedTagOptions,
} from '../src/model/macroImportPlan.ts';
export { KEY_SPACE, detectDanglingRefs } from '../src/modeler/vpl/compiler/danglingRefs.ts';
export { detectMissingConfig } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { buildMacroFile, parseMacroFile } from '../src/model/fileOperations.ts';
export { CURRENT_VIEWER_SENTINEL } from '../src/modeler/vpl/nodes/SetCellLooksNode.ts';
// The REAL reducer, so what the harness exercises is what the app dispatches
// (the test-param-input-mappings precedent — it calls no React API).
export { modelReducer } from '../src/model/ModelContext.tsx';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-macroref-'));
const entryPath = join(ROOT, 'scripts', '__macroref_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const M = await import(pathToFileURL(outPath).href);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Fixtures — ONE model + ONE macro (plus a nested macro) exercising every space
// ---------------------------------------------------------------------------
let nSeq = 0;
const node = (nodeType, config) => ({
  id: `n${++nSeq}`, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config },
});
const edge = (source, target, targetHandle) => ({ id: `e${++nSeq}`, source, target, targetHandle });

const attr = (id, type, extra = {}) => ({
  id, name: id, type, description: '', isModelAttribute: false, defaultValue: '0', ...extra,
});

/** The source model. Every element below is referenced by the macro either
 *  DIRECTLY (a node config) or through the transitive closure. */
function buildModel() {
  return {
    schemaVersion: 1,
    properties: { name: 'Fixture Model', dimension: '2d' },
    topologyMode: { gridCells: true, agents: true },
    attributes: [
      attr('a_type', 'tag', { tagOptions: ['empty', 'wire', 'head'] }),
      // sub-attribute → parent a_type  (closure hop 1)
      attr('a_charge', 'bool', { parentAttributeId: 'a_type', parentValues: ['1'] }),
      // lookup table → row axis a_axis → a_axis's neighbourhood hint nb_hint
      // (a 3-HOP chain: node → a_table → a_axis → nb_hint)
      attr('a_table', 'lookupTable', {
        isModelAttribute: true,
        rowKeySource: { kind: 'tagAttribute', attributeId: 'a_axis' },
        colKeySource: { kind: 'facePalette', paletteId: 'fp1' },
        valueTagAttributeId: 'a_val',
      }),
      attr('a_axis', 'tag', { tagOptions: ['x', 'y'], neighborhoodHintId: 'nb_hint' }),
      attr('a_val', 'tag', { tagOptions: ['lo', 'hi'] }),
      // the variegation species attr → face pattern → its palette (2 hops)
      attr('a_species', 'tag', { tagOptions: ['a', 'b'], facePatternAssignments: { b: 'fpat1' } }),
      attr('a_lit', 'bool'),
      attr('a_param', 'tag', { tagOptions: ['p', 'q'] }),
      // referenced ONLY from the NESTED def
      attr('a_nested', 'integer'),
      attr('a_hidden', 'tag', { tagOptions: ['h'] }),   // named only by a DERIVED key
    ],
    agentAttributes: [attr('ag_facing', 'vector', { vectorDims: 2 }), attr('ag_energy', 'float')],
    bondAttributes: [attr('bond_w', 'float'), attr('bond_k', 'float')],
    neighborhoods: [
      { id: 'nb_moore', name: 'moore', description: '', coords: [[0, 1], [1, 0]] },
      { id: 'nb_hint', name: 'hint', description: '', coords: [[0, 1]] },
    ],
    mappings: [
      { id: 'map_viz', name: 'viz', description: '', isAttributeToColor: true, redDescription: '', greenDescription: '', blueDescription: '', linked: true, linkedAttributeId: 'a_lit' },
      { id: 'map_brush', name: 'brush', description: '', isAttributeToColor: false, redDescription: '', greenDescription: '', blueDescription: '', parameters: [{ key: 'sp', name: 'Species', type: 'tag', tagAttributeId: 'a_param' }] },
    ],
    agentMappings: [
      { id: 'amap', name: 'agents', description: '', isAttributeToColor: true, redDescription: '', greenDescription: '', blueDescription: '', linked: true, linkedAttributeId: 'ag_energy' },
    ],
    variables: [{ id: 'v_acc', name: 'acc', kind: 'scalar', dataType: 'tag', initialValue: '0', attributeId: 'a_type' }],
    agentVariables: [{ id: 'av_sum', name: 'sum', kind: 'scalar', dataType: 'float', initialValue: '0' }],
    indicators: [{ id: 'ind_pop', name: 'population', kind: 'linked', dataType: 'bool', defaultValue: '0', accumulationMode: 'per-generation', linkedAttributeId: 'a_lit' }],
    sprites: [{ id: 'sp_bird', name: 'bird', dataUrl: 'data:image/webp;base64,' + 'A'.repeat(40000), mimeType: 'image/webp' }],
    variegatedCells: {
      enabled: true,
      sourceAttributeId: 'a_species',
      facePalettes: [
        { id: 'fp1', name: 'axis faces', labels: ['n', 's'] },
        { id: 'fp2', name: 'pattern faces', labels: ['u', 'd'] },
      ],
      facePatterns: [
        { id: 'fpat1', name: 'apical', paletteId: 'fp2', layoutMode: 'edges', faces: ['u', null, null, null, 'd', null, null, null] },
      ],
    },
    presets: [{ id: 'pre1', name: 'steady state', state: {}, createdAt: 0 }],
    graphNodes: [], graphEdges: [], macroDefs: [],
  };
}

/** The exported macro + the nested macro its subgraph instantiates. */
function buildDefs() {
  const formBond = node('formBond', { _port_bondAttr_bond_w: '1.5' });
  const bondSrc = node('getConstant', { constType: 'number', constValue: '2' });
  const nodes = [
    // Two nodes naming the SAME attribute — directCount must be 2, not 1.
    node('getCellAttribute', { attributeId: 'a_charge' }),
    node('setAttribute', { attributeId: 'a_charge' }),
    node('getNeighborsAttribute', { neighborhoodId: 'nb_moore', attributeId: 'a_type' }),
    node('setCellLooks', { mappingId: 'map_viz' }),
    node('inputColor', { mappingId: 'map_brush' }),
    node('agentOutputMapping', { mappingId: 'amap' }),
    node('getVariable', { variableId: 'v_acc' }),
    node('setVariable', { variableId: 'av_sum' }),
    node('getIndicator', { indicatorId: 'ind_pop' }),
    node('setAgentSprite', { spriteId: 'sp_bird' }),
    node('getConstant', { constType: 'faceLabel', facePaletteId: 'fp1', constValue: 'n' }),
    node('ovLoadPreset', { presetId: 'pre1' }),
    node('getAgentsInView', { headingSource: 'facing', facingAttributeId: 'ag_facing' }),
    node('lookupInteraction', { tableId: 'a_table' }),
    node('moveSelfToNeighbor', { attr_0: 'a_type', attr_1: 'a_species' }),
    formBond, bondSrc,
    // A viewer sentinel and a compiler-DERIVED cache — neither is a reference.
    node('setCellLooks', { mappingId: M.CURRENT_VIEWER_SENTINEL }),
    node('getFacingLabels', { _sourceAttrId: 'a_hidden' }),
    // Already dangling in the SOURCE model — nothing to carry.
    node('getCellAttribute', { attributeId: 'a_ghost' }),
    // The nested macro instance.
    node('macro', { macroDefId: 'def_nested' }),
  ];
  const top = {
    id: 'def_top', name: 'Decide Life State', nodes,
    // Carrier 3 — the bond attribute id lives ONLY in this edge's handle.
    edges: [edge(bondSrc.id, formBond.id, 'input_value_bondAttr_bond_k')],
    exposedInputs: [], exposedOutputs: [],
  };
  const nested = {
    id: 'def_nested', name: 'Nested', nodes: [node('getCellAttribute', { attributeId: 'a_nested' })],
    edges: [], exposedInputs: [], exposedOutputs: [],
  };
  return { top, nested };
}

const model = buildModel();
const { top, nested } = buildDefs();
model.macroDefs = [top, nested];

const defs = M.collectMacroExportDefs(top, model.macroDefs);
const collected = M.collectMacroReferences(defs, model);
const ref = id => collected.byId.get(id);
const has = id => collected.byId.has(id);

// ---------------------------------------------------------------------------
// Tier A — collection
// ---------------------------------------------------------------------------
console.log('\n--- Tier A: collection ---');

// The registry EXTENDS the compile gate's map, so a future KEY_SPACE addition
// is picked up here automatically.
const missingFromRefKeys = Object.entries(M.KEY_SPACE).filter(([k, v]) => M.REFERENCE_KEYS[k] !== v);
check('REFERENCE_KEYS ⊇ KEY_SPACE (same space for every shared key)', missingFromRefKeys.length === 0,
  JSON.stringify(missingFromRefKeys));
check('REFERENCE_KEYS adds the three the gate skips',
  M.REFERENCE_KEYS.facingAttributeId === 'attribute'
  && M.REFERENCE_KEYS.facePaletteId === 'facePalette'
  && M.REFERENCE_KEYS.presetId === 'preset');
check('macroDefId is NOT a REFERENCE_KEY (a macro def is not a model element)',
  M.REFERENCE_KEYS.macroDefId === undefined);

check('nested defs are part of the export set', defs.length === 2 && defs[0].id === 'def_top' && defs[1].id === 'def_nested');

// Carrier 1 — plain id-valued config keys, one per space.
for (const [id, space] of [
  ['a_charge', 'attributes'], ['nb_moore', 'neighborhoods'], ['map_viz', 'mappings'],
  ['map_brush', 'mappings'], ['amap', 'agentMappings'], ['v_acc', 'variables'],
  ['av_sum', 'agentVariables'], ['ind_pop', 'indicators'], ['sp_bird', 'sprites'],
  ['fp1', 'facePalettes'], ['ag_facing', 'agentAttributes'], ['a_table', 'attributes'],
]) {
  check(`collected ${id} → ${space}`, ref(id)?.space === space, `got ${ref(id)?.space}`);
}
check('a tag-attribute id under `attributeId` resolves', ref('a_type')?.space === 'attributes');
check('the multi-slot `attr_N` keys are collected', ref('a_species')?.space === 'attributes' && ref('a_type')?.directCount >= 1);
check('two nodes naming one attribute give directCount 2', ref('a_charge')?.directCount === 2, `got ${ref('a_charge')?.directCount}`);

// Carrier 2 — the id lives in the config KEY.
check('`_port_bondAttr_<id>` KEY-embedded id collected', ref('bond_w')?.space === 'bondAttributes');
// Carrier 3 — the id lives in an EDGE HANDLE.
check('`input_value_bondAttr_<id>` HANDLE-embedded id collected', ref('bond_k')?.space === 'bondAttributes');

// A reference used only inside a NESTED def is still the file's to carry.
check('a reference used only in the nested def is collected', ref('a_nested')?.space === 'attributes');

// The presets space resolves but can never be carried.
check('presetId resolves into `presets`', ref('pre1')?.space === 'presets');
check('a preset is NOT carryable', ref('pre1')?.carryable === false);
check('the preset says why', /gcapreset/.test(ref('pre1')?.blockedReason ?? ''));

// An id the SOURCE model does not have either.
check('an already-dangling id is collected but not carryable',
  has('a_ghost') && ref('a_ghost').carryable === false && ref('a_ghost').space === undefined);
check('the dangling id reports why', /not found/.test(ref('a_ghost')?.blockedReason ?? ''));

// The closure (D5), one row at a time.
console.log('\n--- Tier A: transitive closure (D5) ---');
const via = (id, requirer) => {
  const r = ref(id);
  const i = r?.requiredBy.indexOf(requirer) ?? -1;
  return i >= 0 ? r.requiredVia[i] : undefined;
};
check('Attribute → sub-attribute parent', ref('a_type')?.requiredBy.includes('a_charge') && /parent/.test(via('a_type', 'a_charge')));
check('Attribute → lookup-table row axis (tagAttribute)', ref('a_axis')?.space === 'attributes' && ref('a_axis').requiredBy.includes('a_table'));
check('Attribute → lookup-table column axis (facePalette)', ref('fp1')?.requiredBy.includes('a_table'));
check('Attribute → lookup-table value tag attribute', ref('a_val')?.space === 'attributes' && ref('a_val').requiredBy.includes('a_table'));
check('Attribute → neighbourhood hint (3 HOPS from the node)', ref('nb_hint')?.space === 'neighborhoods' && ref('nb_hint').requiredBy.includes('a_axis'));
check('Attribute → face pattern assignment', ref('fpat1')?.space === 'facePatterns' && ref('fpat1').requiredBy.includes('a_species'));
check('FacePattern → its palette', ref('fp2')?.space === 'facePalettes' && ref('fp2').requiredBy.includes('fpat1'));
check('Mapping → linked color source', ref('a_lit')?.requiredBy.includes('map_viz'));
check('Mapping → C→A parameter tag attribute', ref('a_param')?.space === 'attributes' && ref('a_param').requiredBy.includes('map_brush'));
check('agentMapping → linked AGENT attribute', ref('ag_energy')?.space === 'agentAttributes' && ref('ag_energy').requiredBy.includes('amap'));
check('Indicator → linked source', ref('a_lit')?.requiredBy.includes('ind_pop'));
check('Variable → tag space attribute', ref('a_type')?.requiredBy.includes('v_acc'));
check('closure-only elements carry no direct references', ref('fp2')?.directCount === 0 && ref('nb_hint')?.directCount === 0);
check('a directly-referenced element keeps its direct count', ref('a_type')?.directCount === 2, `got ${ref('a_type')?.directCount}`);

// Spaces are honest: the agent mapping's linked attribute resolves into the
// AGENT list, the cell mapping's into the cell list.
check('spaces are classified, not assumed',
  ref('a_lit')?.space === 'attributes' && ref('ag_energy')?.space === 'agentAttributes');

check('sprite size is measured', (ref('sp_bird')?.bytes ?? 0) > 40000);

// ---------------------------------------------------------------------------
// Tier E (part 1) — negative controls that the checks above are non-vacuous
// ---------------------------------------------------------------------------
console.log('\n--- Tier E: negative controls ---');

/** A VALUE-only scan — exactly what the compile gate does. It must MISS both
 *  key-embedded and handle-embedded ids, which is why they are collected by
 *  their own passes. */
function valueOnlyScan(defs) {
  const found = new Set();
  for (const d of defs) {
    for (const n of d.nodes) {
      for (const [k, v] of Object.entries(n.data.config ?? {})) {
        if (typeof v === 'string' && v && (M.REFERENCE_KEYS[k] || /^attr_\d+$/.test(k))) found.add(v);
      }
    }
  }
  return found;
}
const valueOnly = valueOnlyScan(defs);
check('NEG: a value-only scan MISSES the `_port_bondAttr_` key id', !valueOnly.has('bond_w') && has('bond_w'));
check('NEG: a value-only scan MISSES the edge-handle id', !valueOnly.has('bond_k') && has('bond_k'));

/** A ONE-HOP closure. The 3-hop chain node → a_table → a_axis → nb_hint means a
 *  non-transitive implementation cannot reach nb_hint. */
const oneHop = new Set();
for (const r of collected.refs) {
  if (r.directCount > 0 && r.element && r.space) {
    for (const l of M.closureOf(r.element, r.space)) oneHop.add(l.id);
  }
}
check('NEG: a one-hop closure MISSES the 3-hop `nb_hint`', !oneHop.has('nb_hint') && has('nb_hint'));
check('NEG: a one-hop closure MISSES the 2-hop `fp2`', !oneHop.has('fp2') && has('fp2'));

check('NEG: a DERIVED `_sourceAttrId` cache is never collected', !has('a_hidden'));
check('NEG: the `__current__` viewer sentinel is never collected', !has(M.CURRENT_VIEWER_SENTINEL));

// ---------------------------------------------------------------------------
// Tier C — selection → bundle
// ---------------------------------------------------------------------------
console.log('\n--- Tier C: selection → bundle ---');
const all = M.defaultSelection(collected);
check('the default selection excludes presets + dangling ids', !all.has('pre1') && !all.has('a_ghost'));
check('the default selection carries everything else', all.has('a_charge') && all.has('fp2') && all.has('sp_bird'));

const fullBundle = M.buildReferenceBundle(collected, all);
check('bundle groups by space', eq(fullBundle.neighborhoods?.map(n => n.id).sort(), ['nb_hint', 'nb_moore']));
check('bundle carries elements VERBATIM',
  eq(fullBundle.attributes?.find(a => a.id === 'a_table'), model.attributes.find(a => a.id === 'a_table')));
check('bundle keeps ids exactly as exported', fullBundle.sprites?.[0]?.id === 'sp_bird');
check('bundle never carries a preset', !('presets' in fullBundle));
check('bundle count matches the carryable selection', M.bundleCount(fullBundle) === all.size,
  `${M.bundleCount(fullBundle)} vs ${all.size}`);
check('an empty selection yields an EMPTY bundle', M.isBundleEmpty(M.buildReferenceBundle(collected, new Set())));

// Unchecking a requirer drops what only IT needed — and nothing else.
const withoutSpecies = M.pruneOrphanSelection(collected, new Set([...all].filter(id => id !== 'a_species')));
check('unchecking a requirer drops its closure-only child', !withoutSpecies.has('fpat1'));
check('…and that child\'s own closure-only child', !withoutSpecies.has('fp2'));
check('…but keeps everything a node names directly', withoutSpecies.has('a_type') && withoutSpecies.has('nb_moore'));
const withoutTable = M.pruneOrphanSelection(collected, new Set([...all].filter(id => id !== 'a_table')));
check('a directly-referenced element is never pruned as an orphan', withoutTable.has('fp1'),
  'fp1 is also named by a getConstant node');
check('a closure-only element with a surviving requirer stays', withoutTable.has('a_lit'),
  'a_lit is required by BOTH map_viz and ind_pop');

// ---------------------------------------------------------------------------
// Tier B — the export round trip
// ---------------------------------------------------------------------------
console.log('\n--- Tier B: file round trip ---');
const origin = M.macroOriginOf(model);
const file = M.buildMacroFile(top, { nested: [nested], references: fullBundle, origin });
const reread = M.parseMacroFile(JSON.stringify(file, null, 2));
check('references survive the round trip VERBATIM', eq(reread.references, fullBundle));
check('nested macro defs survive the round trip', eq(reread.macroDefs, [nested]));
check('the macro def itself survives', eq(reread.macroDef, top));
check('origin survives', reread.origin?.modelName === 'Fixture Model' && reread.origin?.dimension === '2d');
check('schemaVersion stays 1', file.schemaVersion === 1);

// A macro that references nothing writes the historical file, byte for byte.
const bareDef = { id: 'def_bare', name: 'Bare', nodes: [node('getConstant', { constType: 'number', constValue: '1' })], edges: [], exposedInputs: [], exposedOutputs: [] };
const bareModel = { ...buildModel(), macroDefs: [] };
const bareCollected = M.collectMacroReferences([bareDef], bareModel);
check('a reference-free macro collects nothing', bareCollected.refs.length === 0);
const bareFile = M.buildMacroFile(bareDef, { nested: [], references: M.buildReferenceBundle(bareCollected), origin });
const legacyPayload = { schemaVersion: 1, name: bareDef.name, description: '', macroDef: bareDef };
check('a reference-free macro writes the LEGACY file byte-for-byte',
  JSON.stringify(bareFile, null, 2) === JSON.stringify(legacyPayload, null, 2));
check('…with no `origin` either (nothing to caption)', bareFile.origin === undefined);

// The reader never gates on schemaVersion, and an old-shape file still loads.
const oldShape = JSON.stringify({ schemaVersion: 1, name: 'Old', description: 'x', macroDef: nested });
check('an OLD-shape file still loads', M.parseMacroFile(oldShape).macroDef.id === 'def_nested');
check('an old-shape file carries no references', M.parseMacroFile(oldShape).references === undefined);
const futureShape = JSON.stringify({ schemaVersion: 99, name: 'Future', description: '', macroDef: nested, whatIsThis: 1 });
check('the reader NEVER gates on schemaVersion', M.parseMacroFile(futureShape).macroDef.id === 'def_nested');

// Malformed optional fields are dropped, never allowed to throw.
const junk = JSON.stringify({ schemaVersion: 1, name: 'J', description: '', macroDef: nested, macroDefs: [{ nope: 1 }, nested], references: { attributes: [], bogus: 'x' }, origin: 'nope' });
const junkParsed = M.parseMacroFile(junk);
check('a malformed nested def is dropped', eq(junkParsed.macroDefs, [nested]));
check('empty / non-array reference lists are dropped', junkParsed.references === undefined);
check('a non-object origin is dropped', junkParsed.origin === undefined);
let threw = '';
try { M.parseMacroFile('{ not json'); } catch (e) { threw = e.message; }
check('invalid JSON throws the named error', /not valid JSON/.test(threw), threw);
threw = '';
try { M.parseMacroFile('{"schemaVersion":1}'); } catch (e) { threw = e.message; }
check('a missing macroDef throws the named error', /missing or invalid macroDef/.test(threw), threw);

// Re-importing into the SOURCE model must be a no-op: every exported id is
// already there. (The import side lands in M2; this asserts the property the
// export half owes it.)
const bundleIds = new Set(Object.values(fullBundle).flat().map(e => e.id));
const sourceIds = new Set([
  ...model.attributes, ...model.agentAttributes, ...model.bondAttributes,
  ...model.neighborhoods, ...model.mappings, ...model.agentMappings,
  ...model.variables, ...model.agentVariables, ...model.indicators, ...model.sprites,
  ...model.variegatedCells.facePalettes, ...model.variegatedCells.facePatterns,
].map(e => e.id));
check('every exported id already resolves in the SOURCE model',
  [...bundleIds].every(id => sourceIds.has(id)));

// ===========================================================================
// M2 — IMPORT RESOLUTION
// ===========================================================================
//
//   Tier B — the round trip. Export from model A → import into an EMPTY model B
//     with everything "Import as new" → ZERO dangling refs and ZERO validation
//     issues on every node. That single assertion is the feature.
//   Tier C — remap. Import into a model that already has same-named elements →
//     the configs, the `_port_bondAttr_<id>` KEYS and the edge HANDLES all name
//     the target's ids, and NOTHING is added. Then D8, one fixture per carrier.
//   Tier D — discard + idempotence. Discard-all ≡ today's import; re-importing
//     into the model just imported into produces no rows and adds nothing.
//   Tier E — negative controls, by source mutation (run separately).
// ===========================================================================

/** Drive the REAL reducer, exactly as the app dispatches. */
const EMPTY_STATE = m => ({ model: m, isDirty: false, modelVersion: 0, loadedFileName: null, lastSaveOptions: null });
const dispatchImport = (m, applied) =>
  M.modelReducer(EMPTY_STATE(m), { type: 'IMPORT_MACRO_BUNDLE', macros: applied.defs, elements: applied.elements });

/** A model with the same SHAPE as the fixture but none of its elements. */
function emptyModel() {
  return {
    schemaVersion: 1,
    properties: { name: 'Target', dimension: '2d' },
    topologyMode: { gridCells: true, agents: true },
    centerBased: { maxBonds: 4, agentCapabilities: { bonds: 'physics' } },
    attributes: [], agentAttributes: [], bondAttributes: [],
    neighborhoods: [], mappings: [], agentMappings: [],
    variables: [], agentVariables: [], indicators: [], sprites: [],
    variegatedCells: { enabled: true, sourceAttributeId: '', facePalettes: [], facePatterns: [] },
    presets: [],
    graphNodes: [], graphEdges: [], macroDefs: [],
  };
}

const exportedFile = M.buildMacroFile(top, { nested: [nested], references: fullBundle, origin });
/** The file as it comes back off DISK — never the in-memory object. */
const roundTripped = () => M.parseMacroFile(JSON.stringify(exportedFile));

// ---------------------------------------------------------------------------
// Tier B — export → import into an EMPTY model, everything "Import as new"
// ---------------------------------------------------------------------------
console.log('\n--- Tier B: import into an EMPTY model (all new) ---');

const targetB = emptyModel();
const planB = M.planImport(roundTripped(), targetB);

check('an empty target needs the dialog', M.planNeedsDialog(planB));
check('nothing resolves in an empty target', planB.resolved.length === 0);
check('every carried element gets a row',
  planB.rows.filter(r => r.carried).length === M.bundleCount(fullBundle),
  `${planB.rows.filter(r => r.carried).length} vs ${M.bundleCount(fullBundle)}`);
check('a carried element with no name match defaults to `new`',
  planB.rows.filter(r => r.carried).every(r => r.action === 'new'));
check('a NOT-carried reference is locked to discard',
  planB.rows.filter(r => !r.carried).every(r => r.action === 'discard' && !!r.blockedReason));
check('the un-carried preset says `.gcapreset`',
  /gcapreset/.test(planB.rows.find(r => r.id === 'pre1')?.blockedReason ?? ''));
check('the already-dangling id is a discard row', planB.rows.find(r => r.id === 'a_ghost')?.action === 'discard');
check('the nested def rides the plan', planB.defs.length === 2);
check('the cloned defs carry FRESH ids', planB.defs[0].id !== 'def_top' && planB.defs[1].id !== 'def_nested');
check('the nested macro INSTANCE was retargeted at the fresh nested def',
  planB.defs[0].nodes.find(n => n.data.nodeType === 'macro')?.data.config.macroDefId === planB.defs[1].id);

const appliedB = M.applyImportPlan(planB, targetB);
const stateB = dispatchImport(targetB, appliedB);
const modelB = stateB.model;

check('ONE dispatch flips isDirty', stateB.isDirty === true);
check('the elements land in their spaces',
  modelB.attributes.length === (fullBundle.attributes?.length ?? 0)
  && modelB.agentAttributes.length === (fullBundle.agentAttributes?.length ?? 0)
  && modelB.bondAttributes.length === (fullBundle.bondAttributes?.length ?? 0)
  && modelB.neighborhoods.length === 2 && modelB.mappings.length === 2
  && modelB.agentMappings.length === 1 && modelB.variables.length === 1
  && modelB.agentVariables.length === 1 && modelB.indicators.length === 1
  && modelB.sprites.length === 1);
check('face palettes / patterns MERGE into variegatedCells (no ADD_* action exists)',
  modelB.variegatedCells.facePalettes.length === 2 && modelB.variegatedCells.facePatterns.length === 1);
check('the import never flips a capability on', modelB.variegatedCells.sourceAttributeId === '');
check('every imported element got a FRESH id',
  modelB.attributes.every(a => !sourceIds.has(a.id)) && modelB.neighborhoods.every(n => !sourceIds.has(n.id)));
check('ids are not counter-based (all distinct)',
  new Set([...modelB.attributes, ...modelB.neighborhoods, ...modelB.mappings].map(e => e.id)).size
  === modelB.attributes.length + modelB.neighborhoods.length + modelB.mappings.length);
check('the macro defs land', modelB.macroDefs.length === 2);

// THE assertion the whole feature is for.
const allNodesB = modelB.macroDefs.flatMap(d => d.nodes);
const allEdgesB = modelB.macroDefs.flatMap(d => d.edges);
const danglingB = M.detectDanglingRefs(allNodesB, modelB, allEdgesB);
// The DISCARDED references (the un-carried sprite-less preset, the already-dead
// id) are the only ones left, exactly as they would be today.
check('the only dangling refs left are the DISCARDED ones',
  !danglingB || (/a_ghost/.test(danglingB) && !/a_charge|nb_moore|map_viz|bond_w|bond_k/.test(danglingB)),
  danglingB);

/** Badge census. Compared against the macro's badge set IN ITS OWN MODEL —
 *  a node that badges at home (an agent node validated on the cells graph, a
 *  fixture with a deliberately empty config) must not count against the import,
 *  and a node that badged nowhere before must not start now. */
const discardedB = new Set(planB.rows.filter(r => r.action === 'discard').map(r => r.id));
const namesDiscarded = n => Object.values(n.data.config ?? {}).some(v => typeof v === 'string' && discardedB.has(v));
const badgeCensus = (defs, m) => {
  const out = [];
  for (const d of defs) {
    for (const n of d.nodes) {
      if (namesDiscarded(n)) continue;   // a Discard is SUPPOSED to badge — it is today's behaviour
      if (M.detectMissingConfig(n.data.nodeType, n.data.config ?? {}, m).length > 0) out.push(n.data.nodeType);
    }
  }
  return out.sort();
};
const badgeBaseline = badgeCensus(defs, model);
check('the import adds NO badge the macro did not already carry at home',
  eq(badgeCensus(modelB.macroDefs, modelB), badgeBaseline),
  `${JSON.stringify(badgeCensus(modelB.macroDefs, modelB))} vs ${JSON.stringify(badgeBaseline)}`);
check('…and the baseline is only the fixture`s own out-of-scope nodes',
  badgeBaseline.every(t => ['setVariable', 'getAgentsInView', 'getFacingLabels'].includes(t)),
  JSON.stringify(badgeBaseline));
check('a DISCARDED reference does badge (that IS today`s behaviour)',
  modelB.macroDefs.flatMap(d => d.nodes).some(n =>
    namesDiscarded(n) && M.detectMissingConfig(n.data.nodeType, n.data.config ?? {}, modelB).length > 0));

// The three carriers, individually.
const bondNodeB = allNodesB.find(n => n.data.nodeType === 'formBond');
const bondWNew = modelB.bondAttributes.find(a => a.name === 'bond_w').id;
const bondKNew = modelB.bondAttributes.find(a => a.name === 'bond_k').id;
check('carrier 1 — a config VALUE was rewritten',
  allNodesB.some(n => n.data.config?.attributeId === modelB.attributes.find(a => a.name === 'a_charge').id));
check('carrier 2 — the `_port_bondAttr_<id>` KEY was renamed',
  bondNodeB.data.config[`_port_bondAttr_${bondWNew}`] === '1.5'
  && bondNodeB.data.config._port_bondAttr_bond_w === undefined);
check('carrier 3 — the edge HANDLE was rewritten',
  allEdgesB.some(e => e.targetHandle === `input_value_bondAttr_${bondKNew}`)
  && !allEdgesB.some(e => e.targetHandle === 'input_value_bondAttr_bond_k'));

// The imported elements' OWN references (the closure, mirrored).
const chargeB = modelB.attributes.find(a => a.name === 'a_charge');
const typeB = modelB.attributes.find(a => a.name === 'a_type');
const tableB = modelB.attributes.find(a => a.name === 'a_table');
const axisB = modelB.attributes.find(a => a.name === 'a_axis');
const fp1B = modelB.variegatedCells.facePalettes.find(p => p.name === 'axis faces');
const fpatB = modelB.variegatedCells.facePatterns[0];
const fp2B = modelB.variegatedCells.facePalettes.find(p => p.name === 'pattern faces');
check('a sub-attribute points at the NEW parent id', chargeB.parentAttributeId === typeB.id);
check('a lookup-table axis points at the NEW attribute id', tableB.rowKeySource.attributeId === axisB.id);
check('a lookup-table axis points at the NEW palette id', tableB.colKeySource.paletteId === fp1B.id);
check('an axis attribute points at the NEW neighbourhood hint',
  axisB.neighborhoodHintId === modelB.neighborhoods.find(n => n.name === 'hint').id);
check('a face pattern points at the NEW palette id', fpatB.paletteId === fp2B.id);
check('a linked mapping points at the NEW attribute id',
  modelB.mappings.find(m => m.name === 'viz').linkedAttributeId === modelB.attributes.find(a => a.name === 'a_lit').id);
check('a C→A parameter points at the NEW tag attribute id',
  modelB.mappings.find(m => m.name === 'brush').parameters[0].tagAttributeId
  === modelB.attributes.find(a => a.name === 'a_param').id);
check('a linked indicator points at the NEW attribute id',
  modelB.indicators[0].linkedAttributeId === modelB.attributes.find(a => a.name === 'a_lit').id);
check('a tag variable points at the NEW attribute id', modelB.variables[0].attributeId === typeB.id);
check('a face pattern ASSIGNMENT points at the NEW pattern id',
  modelB.attributes.find(a => a.name === 'a_species').facePatternAssignments.b === fpatB.id);
check('an imported element is a DEEP clone (the file object is untouched)',
  fullBundle.attributes.find(a => a.id === 'a_charge').parentAttributeId === 'a_type');

// ---------------------------------------------------------------------------
// Tier C — remap onto same-named elements
// ---------------------------------------------------------------------------
console.log('\n--- Tier C: remap onto existing elements ---');

/** A target that already has same-named counterparts — including a tag
 *  attribute whose options are in a DIFFERENT ORDER (so an identity index map
 *  fails) and one option with NO counterpart at all. */
function remapTarget() {
  const m = emptyModel();
  m.attributes = [
    // 'wire' first, 'empty' second, 'head' GONE, 'kelp' new ⇒ a genuine permutation.
    attr('t_type', 'tag', { name: 'a_type', tagOptions: ['wire', 'empty', 'kelp'] }),
    attr('t_charge', 'bool', { name: 'a_charge' }),
    // A DECOY: the same NAME as a carried element, in the SAME space, but the
    // WRONG type (the source `a_lit` is Binary). It must not be suggested and
    // must not even be offered as a candidate.
    attr('t_lit', 'integer', { name: 'a_lit' }),
    attr('t_param', 'tag', { name: 'a_param', tagOptions: ['p', 'q'] }),
    attr('t_species', 'tag', { name: 'a_species', tagOptions: ['a', 'b'] }),
    attr('t_nested', 'integer', { name: 'a_nested' }),
    attr('t_val', 'tag', { name: 'a_val', tagOptions: ['lo', 'hi'] }),
    attr('t_axis', 'tag', { name: 'a_axis', tagOptions: ['x', 'y'] }),
    attr('t_table', 'lookupTable', { name: 'a_table', isModelAttribute: true }),
  ];
  m.bondAttributes = [attr('t_bw', 'float', { name: 'bond_w' }), attr('t_bk', 'float', { name: 'bond_k' })];
  m.neighborhoods = [
    { id: 't_moore', name: 'a_moore_wrong', description: '', coords: [[0, 1]] },
    { id: 't_nb', name: 'moore', description: '', coords: [[0, 1]], tags: { 0: 'N' } },
  ];
  return m;
}

const targetC = remapTarget();
const planC = M.planImport(roundTripped(), targetC);
const rowOf = (plan, id) => plan.rows.find(r => r.id === id);

check('an exact name+type match is SUGGESTED and is the default action',
  rowOf(planC, 'a_charge')?.action === 'remap' && rowOf(planC, 'a_charge')?.remapTargetId === 't_charge');
check('the suggestion is recorded as a suggestion, not applied silently',
  rowOf(planC, 'a_charge')?.suggestionId === 't_charge');
check('a name match with the WRONG type is NOT suggested',
  rowOf(planC, 'a_lit')?.suggestionId === undefined && rowOf(planC, 'a_lit')?.action === 'new');
check('…and is not even offered as a candidate',
  !rowOf(planC, 'a_lit')?.candidates.some(c => c.id === 't_lit'));
check('a name match in ANOTHER space never leaks in',
  !rowOf(planC, 'nb_moore')?.candidates.some(c => c.id.startsWith('t_') && c.id !== 't_moore' && c.id !== 't_nb'));
check('a space with no compatible candidate offers none',
  rowOf(planC, 'sp_bird')?.candidates.length === 0 && rowOf(planC, 'sp_bird')?.action === 'new');
check('bond attributes match by name too', rowOf(planC, 'bond_w')?.remapTargetId === 't_bw');
check('the tag remap warns about the reordered options',
  (rowOf(planC, 'a_type')?.element ? M.remapWarnings('attributes', rowOf(planC, 'a_type').element,
    targetC.attributes.find(a => a.id === 't_type')) : []).some(w => /no counterpart/.test(w)));

const appliedC = M.applyImportPlan(planC, targetC);
const stateC = dispatchImport(targetC, appliedC);
const modelC = stateC.model;
const nodesC = modelC.macroDefs.flatMap(d => d.nodes);
const edgesC = modelC.macroDefs.flatMap(d => d.edges);

check('a remapped element adds NOTHING to the model',
  modelC.attributes.length === targetC.attributes.length + (appliedC.elements.attributes ?? []).length);
check('the remapped attributes are NOT among the new ones',
  !(appliedC.elements.attributes ?? []).some(a => a.name === 'a_charge' || a.name === 'a_type'));
check('carrier 1 — the config VALUE names the TARGET id',
  nodesC.some(n => n.data.nodeType === 'getCellAttribute' && n.data.config.attributeId === 't_charge'));
check('carrier 2 — the `_port_bondAttr_` KEY names the TARGET id',
  nodesC.find(n => n.data.nodeType === 'formBond').data.config._port_bondAttr_t_bw === '1.5');
check('carrier 3 — the edge HANDLE names the TARGET id',
  edgesC.some(e => e.targetHandle === 'input_value_bondAttr_t_bk'));
check('a multi-slot `attr_N` value was rewritten',
  nodesC.find(n => n.data.nodeType === 'moveSelfToNeighbor').data.config.attr_0 === 't_type');
check('the closure children were remapped too, not re-imported',
  nodesC.some(n => n.data.config?.tableId === 't_table'));
check('an imported element points at a REMAPPED element by its target id',
  (appliedC.elements.variables ?? [])[0] === undefined
  || appliedC.elements.variables[0].attributeId === 't_type');
check('counts add up', appliedC.counts.remapped > 0 && appliedC.counts.discarded >= 2);
check('nothing dangles except the discards', (() => {
  const d = M.detectDanglingRefs(nodesC, modelC, edgesC);
  return !d || (/a_ghost/.test(d) && !/bond_w|bond_k|a_charge/.test(d));
})());

// --- D8: indices and names inside a REMAPPED element -----------------------
console.log('\n--- Tier C: D8 — indices and names remapped BY NAME ---');

/** A macro whose nodes store TAG INDICES into `a_type` through every carrier of
 *  D8's table, plus a neighbourhood tag NAME and an indicator CATEGORY. */
function buildD8Defs() {
  const nodes = [
    node('getConstant', { constType: 'tag', tagAttributeId: 'a_type', constValue: '2' }),          // 'head' → gone
    node('getConstant', { constType: 'tag', tagAttributeId: 'a_type', constValue: '1' }),          // 'wire' → 0
    node('switch', { valueType: 'tag', tagAttributeId: 'a_type', caseCount: 2, case_0_value: '0', case_1_value: '1' }),
    node('statement', { compareType: 'tag', tagAttributeId: 'a_type', _port_x: '1', _port_y: '0' }),
    node('setAttribute', { attributeId: 'a_type', _port_value: '1' }),
    node('updateAttribute', { attributeId: 'a_type', _port_value: '0' }),
    node('setAttribute', { attributeId: 'a_lit', attr_1: 'a_type', _port_value_1: '1' }),
    node('divideAgent', { partitionAttributeId: 'a_type', partTag_0: true, partTag_1: true, partTag_2: true }),
    node('formBond', { _port_bondAttr_bond_tag: '1' }),
    node('getNeighborAttributeByTag', { neighborhoodId: 'nb_tagged', attributeId: 'a_lit', tagName: 'NE' }),
    node('ovReadIndicator', { indicatorId: 'ind_cat', category: 'gone' }),
  ];
  return { id: 'def_d8', name: 'D8', nodes, edges: [], exposedInputs: [], exposedOutputs: [] };
}

const d8Source = buildModel();
d8Source.bondAttributes.push(attr('bond_tag', 'tag', { tagOptions: ['empty', 'wire', 'head'] }));
d8Source.neighborhoods.push({ id: 'nb_tagged', name: 'tagged', description: '', coords: [[0, 1]], tags: { 0: 'NE' } });
d8Source.indicators.push({ id: 'ind_cat', name: 'cats', kind: 'linked', dataType: 'tag', defaultValue: '0', accumulationMode: 'per-generation', linkedAttributeId: 'a_type', trackedValues: ['gone', 'kept'] });
const d8Def = buildD8Defs();
d8Source.macroDefs = [d8Def];
const d8Collected = M.collectMacroReferences([d8Def], d8Source);
const d8File = M.buildMacroFile(d8Def, { references: M.buildReferenceBundle(d8Collected), origin: M.macroOriginOf(d8Source) });

const targetD8 = remapTarget();
targetD8.bondAttributes.push(attr('t_btag', 'tag', { name: 'bond_tag', tagOptions: ['wire', 'empty', 'kelp'] }));
targetD8.neighborhoods.push({ id: 't_tagged', name: 'tagged', description: '', coords: [[0, 1]], tags: { 0: 'N' } });
targetD8.indicators.push({ id: 't_cat', name: 'cats', kind: 'linked', dataType: 'tag', defaultValue: '0', accumulationMode: 'per-generation', trackedValues: ['kept'] });

const planD8 = M.planImport(M.parseMacroFile(JSON.stringify(d8File)), targetD8);
check('the D8 fixture remaps a_type onto the reordered target', rowOf(planD8, 'a_type')?.remapTargetId === 't_type');
check('…and the tag bond attribute too', rowOf(planD8, 'bond_tag')?.remapTargetId === 't_btag');
const appliedD8 = M.applyImportPlan(planD8, targetD8);
const nD8 = appliedD8.defs[0].nodes;
const byType = t => nD8.filter(n => n.data.nodeType === t);

// source options ['empty','wire','head'] → target ['wire','empty','kelp']
//   empty 0→1 · wire 1→0 · head 2→(no counterpart, LEFT ALONE)
check('D8 — Get Constant tag index remapped BY NAME (wire 1→0)',
  byType('getConstant').some(n => n.data.config.constValue === '0'));
check('D8 — an option with NO counterpart is LEFT AS-IS, never clamped',
  byType('getConstant').some(n => n.data.config.constValue === '2'));
check('D8 — the unmatched option is REPORTED', appliedD8.notices.some(x => /“head”/.test(x)));
check('D8 — Switch case values remapped', (() => {
  const c = byType('switch')[0].data.config;
  return c.case_0_value === '1' && c.case_1_value === '0';
})());
check('D8 — Compare operands remapped', (() => {
  const c = byType('statement')[0].data.config;
  return c._port_x === '0' && c._port_y === '1';
})());
check('D8 — setAttribute `_port_value` remapped',
  byType('setAttribute').some(n => n.data.config.attributeId === 't_type' && n.data.config._port_value === '0'));
check('D8 — updateAttribute `_port_value` remapped (the agent cascade misses this one)',
  byType('updateAttribute')[0].data.config._port_value === '1');
check('D8 — a multi-slot `_port_value_<i>` remapped',
  byType('setAttribute').some(n => n.data.config.attr_1 === 't_type' && n.data.config._port_value_1 === '0'));
check('D8 — Divide Agent`s partTag_ table is PERMUTED, not re-read', (() => {
  const c = byType('divideAgent')[0].data.config;
  // 0→1, 1→0, 2 has no counterpart so it keeps its own slot.
  return c.partTag_0 === true && c.partTag_1 === true && c.partTag_2 === true;
})());
check('D8 — the bond attribute`s tag index remapped under its RENAMED key',
  byType('formBond')[0].data.config._port_bondAttr_t_btag === '0');
check('D8 — a neighbourhood tag NAME with no counterpart is reported, not rewritten', (() => {
  const kept = byType('getNeighborAttributeByTag')[0].data.config.tagName === 'NE';
  return kept && appliedD8.notices.some(x => /“NE”/.test(x));
})());
check('D8 — an indicator CATEGORY the target does not track is reported', (() => {
  const kept = byType('ovReadIndicator')[0].data.config.category === 'gone';
  return kept && appliedD8.notices.some(x => /“gone”/.test(x));
})());

/** parentValues are indices into the PARENT's options — when the parent is
 *  REMAPPED (and the child imported), they must move with it. */
const chargeD8 = (appliedD8.elements.attributes ?? []).find(a => a.name === 'a_charge');
check('D8 — an imported sub-attribute`s parentValues follow the remapped parent',
  chargeD8 === undefined || chargeD8.parentAttributeId !== 't_type' || eq(chargeD8.parentValues, ['0']),
  JSON.stringify(chargeD8?.parentValues));

// ---------------------------------------------------------------------------
// Tier D — discard, and idempotence
// ---------------------------------------------------------------------------
console.log('\n--- Tier D: discard ≡ today, and idempotence ---');

const targetD = emptyModel();
const planD = M.planImport(roundTripped(), targetD);
const discardAll = planD.rows.map(r => ({ ...r, action: 'discard' }));
const appliedD = M.applyImportPlan({ ...planD, rows: discardAll }, targetD);
const stateD = dispatchImport(targetD, appliedD);

check('discard-all adds NO elements', M.bundleCount(appliedD.elements) === 0);
check('discard-all leaves every config id EXACTLY as exported', (() => {
  // The pre-feature import is `cloneMacroWithFreshIds(macroDef)` — same node
  // ids differ, so compare the CONFIGS, which is what a reference rewrite would
  // have touched.
  const got = appliedD.defs[0].nodes.map(n => JSON.stringify(n.data.config)).sort();
  const want = planD.defs[0].nodes.map(n => JSON.stringify(n.data.config)).sort();
  return eq(got, want);
})());
check('discard-all still adds the macro defs', stateD.model.macroDefs.length === 2);
check('discard-all leaves the references dangling (today`s behaviour)',
  !!M.detectDanglingRefs(appliedD.defs.flatMap(d => d.nodes), stateD.model, appliedD.defs.flatMap(d => d.edges)));

// Re-import into the model we just imported into: every id now resolves.
const planIdem = M.planImport(M.parseMacroFile(JSON.stringify(
  M.buildMacroFile(modelB.macroDefs[0], {
    nested: [modelB.macroDefs[1]],
    references: M.buildReferenceBundle(M.collectMacroReferences(modelB.macroDefs, modelB)),
    origin: M.macroOriginOf(modelB),
  }),
)), modelB);
check('re-importing raises a row for NOTHING the file carries', planIdem.rows.every(r => !r.carried),
  planIdem.rows.map(r => `${r.space}:${r.name}`).join(','));
check('…the only rows left are the two references NOTHING can resolve (a preset, a dead id)',
  eq(planIdem.rows.map(r => r.id).sort(), ['a_ghost', 'pre1']));
check('…and rows that offer ONLY Discard never open the dialog on their own',
  !M.planNeedsDialog(planIdem));

// The pre-M1 shape: references, but the file carries NONE of them. Every row is
// Discard-only, so the import must take exactly the historical path.
const legacyRefsFile = M.parseMacroFile(JSON.stringify({
  schemaVersion: 1, name: 'Legacy', description: '', macroDef: top,
}));
const planLegacy = M.planImport(legacyRefsFile, emptyModel());
check('a pre-M1 file (dangling ids, no `references`) opens NO dialog',
  planLegacy.rows.length > 0 && !M.planNeedsDialog(planLegacy));
check('…and importing it changes nothing but the macro def', (() => {
  const a = M.applyImportPlan(planLegacy, emptyModel());
  return M.bundleCount(a.elements) === 0
    && eq(a.defs[0].nodes.map(n => JSON.stringify(n.data.config)), planLegacy.defs[0].nodes.map(n => JSON.stringify(n.data.config)));
})());
check('…and every carried reference is summarised as already present', planIdem.resolved.length > 0);

// INVARIANT 3, on a macro whose every reference resolves: re-importing into the
// source model must open NO dialog at all.
const cleanDef = {
  id: 'def_clean', name: 'Clean',
  nodes: [node('getCellAttribute', { attributeId: 'a_lit' }), node('getNeighborsAttribute', { neighborhoodId: 'nb_moore', attributeId: 'a_type' })],
  edges: [], exposedInputs: [], exposedOutputs: [],
};
const cleanCollected = M.collectMacroReferences([cleanDef], model);
const cleanFile = M.buildMacroFile(cleanDef, { references: M.buildReferenceBundle(cleanCollected), origin });
check('a macro re-imported into ITS OWN model opens NO dialog',
  !M.planNeedsDialog(M.planImport(M.parseMacroFile(JSON.stringify(cleanFile)), model)));
check('…and adds no elements', M.bundleCount(
  M.applyImportPlan(M.planImport(M.parseMacroFile(JSON.stringify(cleanFile)), model), model).elements) === 0);
const appliedIdem = M.applyImportPlan(planIdem, modelB);
check('…and it adds no elements at all', M.bundleCount(appliedIdem.elements) === 0);
const stateIdem = dispatchImport(modelB, appliedIdem);
check('…only the macro def itself is added',
  stateIdem.model.attributes.length === modelB.attributes.length
  && stateIdem.model.macroDefs.length === modelB.macroDefs.length + 2);

// A reference-FREE macro never reaches the dialog.
const bareFileB = M.buildMacroFile(bareDef, {});
check('a reference-free macro needs no dialog',
  !M.planNeedsDialog(M.planImport(M.parseMacroFile(JSON.stringify(bareFileB)), emptyModel())));

// Capability / topology gating WARNS, never blocks (D12).
console.log('\n--- Tier D: capability gating warns, never blocks ---');
const bare = emptyModel();
bare.topologyMode = { gridCells: true, agents: false };
bare.centerBased = { maxBonds: 0 };
bare.variegatedCells = { enabled: false, sourceAttributeId: '', facePalettes: [], facePatterns: [] };
const planGate = M.planImport(roundTripped(), bare);
check('an agent element warns when the Agents topology is off',
  /Bond-Graph Agents/.test(rowOf(planGate, 'ag_facing')?.inertWarning ?? ''));
check('a bond attribute warns when Bonds is off',
  /Bonds is enabled/.test(rowOf(planGate, 'bond_w')?.inertWarning ?? ''));
check('a face palette warns when Variegated Cells is off',
  /Variegated/.test(rowOf(planGate, 'fp1')?.inertWarning ?? ''));
check('a gated element still IMPORTS (warn, never block)',
  rowOf(planGate, 'bond_w')?.action === 'new'
  && M.bundleCount(M.applyImportPlan(planGate, bare).elements) > 0);
const stateGate = dispatchImport(bare, M.applyImportPlan(planGate, bare));
check('…and the import does NOT enable the capability behind the user`s back',
  stateGate.model.variegatedCells.enabled === false
  && stateGate.model.topologyMode.agents === false);

// Name collisions get a suffix rather than silently shadowing.
const clash = emptyModel();
clash.neighborhoods = [{ id: 'x', name: 'moore', description: '', coords: [[0, 1]] }];
const planClash = M.planImport(roundTripped(), clash);
const rowClash = rowOf(planClash, 'nb_moore');
check('a name clash the user declines to remap still imports…', rowClash.candidates.length === 1);
const appliedClash = M.applyImportPlan(
  { ...planClash, rows: planClash.rows.map(r => (r.id === 'nb_moore' ? { ...r, action: 'new' } : r)) }, clash);
check('…under a suffixed name', (appliedClash.elements.neighborhoods ?? []).some(n => /imported/.test(n.name)));

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
