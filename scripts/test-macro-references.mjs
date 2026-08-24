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
export { KEY_SPACE } from '../src/modeler/vpl/compiler/danglingRefs.ts';
export { buildMacroFile, parseMacroFile } from '../src/model/fileOperations.ts';
export { CURRENT_VIEWER_SENTINEL } from '../src/modeler/vpl/nodes/SetCellLooksNode.ts';
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

rmSync(entryPath, { force: true });
rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
