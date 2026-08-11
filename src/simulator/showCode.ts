/** Show Code — the PORT-READY MODEL DOCUMENT builder.
 *
 *  WHY THIS EXISTS. The compiled functions Show Code used to display are NOT
 *  self-sufficient: they are the *rule*, and the WORKER supplies everything
 *  around them — the grid geometry, the typed-array storage, the neighbour
 *  index tables, the double-buffer/swap discipline, the async visit order, the
 *  RNG stream, the indicator slots, the model-attribute values and the lookup
 *  TABLE DATA. Someone reading only `(function(total, r_alive, w_alive,
 *  nIdx_moore, nSz_moore, …) { … })` cannot port the model: they do not know
 *  what any of those parameters CONTAIN, and several of them are model STATE
 *  that lives nowhere in the emitted text.
 *
 *  So the panel now emits three parts:
 *    1. MODEL DEFINITION  — every fact a port needs, generated from the model.
 *    2. DRIVER SKELETON   — the exact call order + buffer discipline the engine
 *                           performs around the compiled functions, generated
 *                           per model (only the branches this model takes).
 *    3. COMPILED FUNCTIONS — unchanged, with each parameter documented.
 *
 *  THE DISCIPLINE (C1): every displayed fact comes from the function that
 *  ENFORCES it — `buildLoopParams` / `buildCellParams` /
 *  `buildOutputMappingParams` for the signatures, `resolveAxes` +
 *  `buildLookupTablePayload` for table geometry and data, `encodeAttrValue` for
 *  stored values, `resolveMaxBonds` / `effectiveAgentDt` / `chargeParamsOf` /
 *  `layoutIterationsOf` / … for the agent physics. NEVER re-derive a fact here
 *  by hand, and NEVER hand-write a parallel parameter list — the whole point is
 *  that the document cannot drift from the engine.
 */

import type { CAModel, Attribute, Indicator } from '../model/types';
import { buildLoopParams, buildCellParams, buildOutputMappingParams, is3dModel, isAgentModel, agentAbiShapeOf } from '../modeler/vpl/compiler/compile';
import type { CompileResult } from '../modeler/vpl/compiler/compile';
import { buildAgentAbiParams } from '../modeler/vpl/compiler/agentAbi';
import { sparseSteppingEnabled } from '../modeler/vpl/compiler/sparseStepping';
import { resolveAxes, buildLookupTablePayload, normalizeLookupTablePayload } from '../modeler/vpl/compiler/variegation';
import { encodeAttrValue } from '../model/attrValueEncoding';
import { computeDefaultModelAttrs } from '../model/modelAttrDefaults';
import { cellAttrsOf, agentAttrsOf, bondAttrsOf, cellFieldAttrsOf, modelAttrSlotKeys } from '../model/attributeScope';
import {
  resolveMaxBonds, resolveBondRequestDepth, effectiveAgentDt, cbNum,
  collisionMode, usesSoftCollision, usesPositionalCollision,
  usesEngineSprings, usesEngineGrowth,
  usesCharge, usesGlobalCharge, chargeStrengthOf, chargeMaxDistOf,
  chargeGlobalMaxDistOf, chargeBinEdgeOf, chargeThetaOf, chargeRangeOf,
  layoutIterationsOf,
} from '../model/centerBased';
import { agentMotionMode, motionIntegrates, motionAppliesForces, resolveAgentFieldGates } from '../model/agentFieldGating';

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/** A `// ===== TITLE =====` banner. */
function banner(title: string): string {
  const bar = '='.repeat(Math.max(4, 74 - title.length));
  return `// ===== ${title} ${bar}`;
}

/** Every line prefixed `// ` (blank lines stay bare `//`). */
function comment(lines: string[]): string {
  return lines.map(l => (l ? `// ${l}` : '//')).join('\n');
}

/** Fixed-width table rendering: a header row + a rule + the body. */
function table(headers: string[], rows: string[][]): string[] {
  const all = [headers, ...rows];
  const w = headers.map((_, c) => Math.max(...all.map(r => (r[c] ?? '').length)));
  const line = (r: string[]) => r.map((cell, c) => (cell ?? '').padEnd(w[c]!)).join('  ').trimEnd();
  return [line(headers), w.map(n => '-'.repeat(n)).join('  '), ...rows.map(line)];
}

/** Compact numeric literal — trims float noise without losing precision. */
function num(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

/** Wrap a long list of numbers into fixed-width rows. */
function wrapNumbers(values: readonly number[], perRow: number, indent: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < values.length; i += perRow) {
    out.push(indent + values.slice(i, i + perRow).map(num).join(', ') + (i + perRow < values.length ? ',' : ''));
  }
  return out;
}

/** The JS typed array the worker allocates for an attribute type — mirrors
 *  `createTypedArray` in sim.worker.ts. */
function storageFor(type: string): string {
  switch (type) {
    case 'bool': return 'Uint8Array';
    case 'integer': return 'Int32Array';
    case 'tag': return 'Int32Array';
    case 'neighborIndex': return 'Int32Array';
    case 'float': return 'Float64Array';
    default: return 'Float64Array';
  }
}

/** Human note on how a stored number is interpreted, per attribute type. */
function encodingNote(a: Attribute): string {
  switch (a.type) {
    case 'bool': return '0 | 1';
    case 'tag': return `index into [${(a.tagOptions ?? []).join(', ')}]`;
    case 'integer': return 'signed 32-bit integer';
    case 'float': return 'IEEE-754 double';
    case 'neighborIndex': return 'packed (dr,dc[,dl]) — see NEIGHBOUR INDEX CODEC';
    default: return a.type;
  }
}

// ---------------------------------------------------------------------------
// Parameter documentation — derived from the REAL signatures
// ---------------------------------------------------------------------------

/** What one compiled-function parameter contains. Keyed by the parameter NAME
 *  the compiler emitted, so this can never list a parameter the emit does not
 *  have (the names come from `buildLoopParams` & friends). Prefixed names
 *  (`r_<attr>` / `w_<attr>` / `nIdx_<nbr>` / `nSz_<nbr>`) are matched by rule. */
function describeParam(name: string, model: CAModel): string {
  const is3d = is3dModel(model);
  const fixed: Record<string, string> = {
    idx: 'this cell\'s flat index (per-cell entry points only)',
    total: 'cell count = W*H' + (is3d ? '*D' : ''),
    W: 'grid width (columns)',
    H: 'grid height (rows)',
    D: 'grid depth (layers)',
    WH: 'W*H, precomputed for the 3D index decode',
    modelAttrs: 'Record<string, number> — the model-attribute values (see MODEL ATTRIBUTES)',
    colors: 'Uint8ClampedArray, 4 bytes RGBA per cell; write at colorIdx = idx*4',
    activeViewer: 'string — the id of the Attribute→Colour mapping currently displayed',
    _indicators: 'Float64Array, one slot per indicator (see INDICATORS for the slot order)',
    _linkedResults: 'plain object — the compiled step writes linked-indicator aggregates here',
    _rngState: 'Uint32Array(1) — the SHARED xorshift32 stream (see RANDOM NUMBERS)',
    _stopFlag: 'Uint32Array(1) — first-match-wins 1-based stop-event index (see STOP EVENTS)',
    glyphCodes: 'Uint32Array, one Unicode codepoint per cell (0 = no glyph)',
    glyphColors: 'Uint32Array, one packed RGB glyph tint per cell',
    r_orientation: 'Int32Array — per-cell orientation 0..3, READ buffer (Variegated Cells)',
    w_orientation: 'Int32Array — per-cell orientation 0..3, WRITE buffer (Variegated Cells)',
    _facePatternLookup: 'Int32Array — flat species x 8-direction face-label table (Variegated Cells)',
    _lookupTables: 'Record<tableId, Float64Array> — dense row-major tables (see LOOKUP TABLES)',
    order: 'Int32Array(total) — the async VISIT ORDER; iterate `idx = order[i]`',
    _skipped: 'Uint8Array(total) — Mark Cell Updated flags; cleared before every step',
    _activeList: 'Int32Array | null — the active-cell list; null runs the full 0..total loop',
    _activeCount: 'how many entries of _activeList are live',
    _generation: 'the generation being computed now (0-based)',
  };
  if (fixed[name]) return fixed[name]!;
  if (name.startsWith('r_')) {
    const a = model.attributes.find(x => x.id === name.slice(2));
    return `READ buffer for cell attribute "${a?.name ?? name.slice(2)}" (${storageFor(a?.type ?? 'float')})`;
  }
  if (name.startsWith('w_')) {
    const a = model.attributes.find(x => x.id === name.slice(2));
    return `WRITE buffer for cell attribute "${a?.name ?? name.slice(2)}" (${storageFor(a?.type ?? 'float')})`;
  }
  if (name.startsWith('nIdx_')) {
    const id = name.slice(5);
    const n = model.neighborhoods.find(x => x.id === id);
    return `Int32Array(total * nSz_${id}) — neighbour cell indices for "${n?.name ?? id}"; neighbour k of cell idx is nIdx_${id}[idx * nSz_${id} + k]`;
  }
  if (name.startsWith('nSz_')) {
    const id = name.slice(4);
    const n = model.neighborhoods.find(x => x.id === id);
    return `neighbour count for "${n?.name ?? id}" (the table stride)`;
  }
  return '(engine-supplied)';
}

/** Render one signature as a documented parameter list. */
function signatureBlock(label: string, params: string, model: CAModel): string[] {
  const names = params.split(', ').filter(Boolean);
  const rows = names.map((n, i) => [String(i), n, describeParam(n, model)]);
  return ['', label, ...table(['#', 'parameter', 'meaning'], rows)];
}

// ---------------------------------------------------------------------------
// SECTION 1 — MODEL DEFINITION
// ---------------------------------------------------------------------------

/** The compiled AGENT functions (from `compileAgentGraph`), when the model has
 *  agents. Absent ⇒ the agent function section is skipped (the definition +
 *  driver sections still render from the model). */
export interface AgentCodeBundle {
  behaviourCode?: string;
  initCode?: string;
  divisionCode?: string;
  outputMappingCodes?: Array<{ mappingId: string; code: string }>;
  inputMappingCodes?: Array<{ mappingId: string; code: string }>;
}

interface DocOptions {
  /** The LIVE model-attribute values the worker is running with (`modelAttrs`).
   *  Absent ⇒ the section says the values are the declared defaults. */
  modelAttrs?: Record<string, number>;
  /** Which Attribute→Colour mapping is displayed (the `activeViewer` argument). */
  activeViewer?: string;
  /** The resolved engines, for the header line. */
  engineNote?: string;
  /** The compiled agent-graph functions, when the model has agents. */
  agent?: AgentCodeBundle;
}

function sectionOverview(model: CAModel, opts: DocOptions): string {
  const p = model.properties;
  const is3d = is3dModel(model);
  const W = p.gridWidth, H = p.gridHeight, D = is3d ? (p.gridDepth ?? 1) : 1;
  const gridOn = p.topology !== undefined ? model.topologyMode?.gridCells !== false : true;
  const rows: string[][] = [
    ['Model', p.name || '(unnamed)'],
    ['Rule author', p.author || '—'],
    ['Dimension', is3d ? '3D' : '2D'],
    ['Grid', is3d ? `${W} x ${H} x ${D}  (W x H x D)` : `${W} x ${H}  (W x H)`],
    ['Total cells', String(W * H * D)],
    ['Boundary', p.boundaryTreatment === 'torus' ? 'torus (wrap on every axis)' : 'constant (out-of-grid reads hit a sentinel cell)'],
    ['Update mode', p.updateMode === 'asynchronous' ? `asynchronous (${p.asyncScheme ?? 'random-order'})` : 'synchronous'],
    ['Layers', [gridOn ? 'CA grid' : null, isAgentModel(model) ? 'bond-graph agents' : null].filter(Boolean).join(' + ') || 'CA grid'],
  ];
  if (sparseSteppingEnabled(model)) {
    rows.push(['Sparse stepping', 'ON — only ACTIVE cells are stepped (see DRIVER SKELETON)']);
  }
  const out = [
    banner('MODEL DEFINITION'),
    comment([
      'Everything below is MODEL STATE the compiled functions depend on but do not',
      'contain. A port needs all of it.',
      '',
      ...table(['property', 'value'], rows),
    ]),
  ];
  if (opts.engineNote) out.push(comment(['', opts.engineNote]));
  return out.join('\n');
}

function sectionIndexing(model: CAModel): string {
  const is3d = is3dModel(model);
  const lines = is3d
    ? [
        'Cells are stored FLAT, layer-major then row-major:',
        '',
        '    idx = (layer * H + row) * W + col          // layer 0..D-1, row 0..H-1, col 0..W-1',
        '',
        '    layer = (idx / (W*H)) | 0',
        '    rem   = idx - layer * (W*H)',
        '    row   = (rem / W) | 0',
        '    col   = rem - row * W',
      ]
    : [
        'Cells are stored FLAT, row-major:',
        '',
        '    idx = row * W + col                        // row 0..H-1, col 0..W-1',
        '',
        '    row = (idx / W) | 0',
        '    col = idx - row * W',
      ];
  return [
    banner('CELL INDEXING'),
    comment(lines),
  ].join('\n');
}

function sectionCellAttributes(model: CAModel): string {
  const attrs = cellAttrsOf(model);
  if (attrs.length === 0) return '';
  const constant = model.properties.boundaryTreatment !== 'torus';
  const rows = attrs.map(a => [
    a.id,
    a.name,
    a.type,
    storageFor(a.type),
    num(encodeAttrValue(a, a.defaultValue)),
    constant ? num(encodeAttrValue(a, a.boundaryValue || a.defaultValue)) : '—',
    encodingNote(a),
  ]);
  const lines = [
    'One typed array per attribute. Allocate them ALL at init and fill with the',
    'default value.',
    '',
    ...table(['id', 'name', 'type', 'storage', 'default', 'boundary', 'stored value'], rows),
    '',
    constant
      ? `Array length is total + 1 = ${model.properties.gridWidth * model.properties.gridHeight * (is3dModel(model) ? (model.properties.gridDepth ?? 1) : 1) + 1}. The EXTRA cell at index \`total\` is the`
      : `Array length is exactly total. There is no sentinel cell (torus wraps instead).`,
  ];
  if (constant) {
    lines.push(
      'CONSTANT-BOUNDARY SENTINEL: every out-of-grid neighbour lookup resolves to it,',
      'and it holds the "boundary" column above. Nothing ever writes it during a step.',
    );
  }
  // Sub-attributes.
  const subs = attrs.filter(a => a.parentAttributeId);
  if (subs.length > 0) {
    lines.push('', 'SUB-ATTRIBUTES — "only defined when the parent holds one of these values":', '');
    for (const s of subs) {
      const parent = attrs.find(a => a.id === s.parentAttributeId);
      const vals = (s.parentValues ?? []).map(v => (parent ? `${v}${parent.type === 'tag' ? ` (${parent.tagOptions?.[Number(v)] ?? '?'})` : ''}` : v));
      lines.push(`  ${s.name}: defined where ${parent?.name ?? s.parentAttributeId} in {${vals.join(', ')}}`);
      lines.push(`    reads on a non-matching cell yield ${num(encodeAttrValue(s, s.undefinedValue ?? s.defaultValue))} (its "undefined" value)`);
    }
    lines.push(
      '',
      model.properties.updateMode === 'asynchronous'
        ? '  ASYNC: before each step, scrub every non-matching cell back to the default'
        : '  SYNC: the compiled step emits a per-cell conditional copy for these (already',
      model.properties.updateMode === 'asynchronous'
        ? '  (the compiled step cannot do it — read and write share one buffer).'
        : '  inside the function below) instead of the plain bulk copy.',
    );
  }
  return [banner('CELL ATTRIBUTES'), comment(lines)].join('\n');
}

function sectionModelAttributes(model: CAModel, opts: DocOptions): string {
  const mAttrs = model.attributes.filter(a => a.isModelAttribute && a.type !== 'lookupTable');
  if (mAttrs.length === 0) return '';
  // Prefer the LIVE values the worker is running with; fall back to the declared
  // defaults through the SAME resolver the worker seeds from (never a parallel
  // derivation) so the document always carries a real number.
  const hasLive = opts.modelAttrs !== undefined && Object.keys(opts.modelAttrs).length > 0;
  const values = hasLive ? opts.modelAttrs! : computeDefaultModelAttrs(model.attributes);
  const rows: string[][] = [];
  for (const a of mAttrs) {
    const keys = modelAttrSlotKeys(a);
    for (const k of keys) {
      rows.push([k, a.name + (keys.length > 1 ? ` (${k.slice(a.id.length + 1)})` : ''), a.type, num(values[k] ?? 0)]);
    }
  }
  return [
    banner('MODEL ATTRIBUTES  — the `modelAttrs` parameter'),
    comment([
      'Global read-only parameters every cell can read. The compiled code indexes',
      'this object BY THE KEY in the first column. A colour model attribute splits',
      'into four numeric slots (_r/_g/_b/_a) — that split is part of the contract.',
      '',
      ...table(['modelAttrs key', 'name', 'type', 'current value'], rows),
      '',
      hasLive ? 'Values above are the LIVE values the running simulation is using.' : 'Values are the declared defaults.',
    ]),
  ].join('\n');
}

function sectionLookupTables(model: CAModel): string {
  const tables = model.attributes.filter(a => a.isModelAttribute && a.type === 'lookupTable');
  if (tables.length === 0) return '';
  const lines: string[] = [
    '`_lookupTables[<id>]` is a DENSE, ROW-MAJOR Float64Array. Index it with',
    '',
    '    flat = SUM over axes k of  clamp(value_k - min_k, 0, dim_k - 1) * stride_k',
    '',
    'The per-axis clamp is SATURATING (an out-of-range index reads the nearest edge).',
    'The full table DATA is model state — reproduced below so a port needs nothing else.',
  ];
  for (const t of tables) {
    const r = resolveAxes(t, model);
    const data = normalizeLookupTablePayload(buildLookupTablePayload(t, model));
    lines.push('', `--- ${t.name}  (id: ${t.id}) ---`);
    lines.push(`value type: ${t.valueType ?? 'float'}${t.valueTagOptions?.length ? `  [${t.valueTagOptions.join(', ')}]` : ''}`);
    lines.push('');
    lines.push(...table(
      ['axis', 'name', 'dim', 'min', 'stride', 'labels'],
      r.axes.map((ax, i) => [
        String(i), ax.name ?? `Axis ${i}`, String(ax.dim), String(r.mins[i] ?? 0), String(r.strides[i] ?? 1),
        ax.labels.length > 12 ? `${ax.labels.slice(0, 12).join(', ')}, … (${ax.labels.length})` : ax.labels.join(', '),
      ]),
    ));
    lines.push('', `data (${data.length} entries, row-major):`);
    lines.push(...wrapNumbers(Array.from(data), 16, '  '));
  }
  return [banner('LOOKUP TABLES  — the `_lookupTables` parameter'), comment(lines)].join('\n');
}

function sectionNeighborhoods(model: CAModel): string {
  if (model.neighborhoods.length === 0) return '';
  const is3d = is3dModel(model);
  const torus = model.properties.boundaryTreatment === 'torus';
  const lines: string[] = [
    'Each neighbourhood is a list of OFFSETS from the centre cell. The engine',
    'pre-computes a per-cell index table ONCE at init; the compiled code only ever',
    'reads `nIdx_<id>[idx * nSz_<id> + k]`.',
  ];
  for (const n of model.neighborhoods) {
    const coords: readonly (readonly number[])[] = (n.coords3d as readonly number[][] | undefined) ?? n.coords;
    const size = coords.length;
    lines.push('', `--- ${n.name}  (id: ${n.id}, nSz = ${size}${n.includeCentralCell ? ', includes the centre cell' : ''}) ---`);
    if (n.description) lines.push(`${n.description}`);
    const fmt = (c: readonly number[]) => is3d
      ? `(${c[0] ?? 0},${c[1] ?? 0},${c[2] ?? 0})`
      : `(${c[0] ?? 0},${c[1] ?? 0})`;
    lines.push(is3d ? 'offsets (dRow, dCol, dLayer):' : 'offsets (dRow, dCol):');
    for (let i = 0; i < size; i += 8) {
      lines.push('  ' + coords.slice(i, i + 8).map((c, j) => `${String(i + j).padStart(2)}:${fmt(c)}`).join('  '));
    }
    const tags = n.tags ? Object.entries(n.tags) : [];
    if (tags.length > 0) lines.push('tags: ' + tags.map(([k, v]) => `${v} -> slot ${k}`).join(', '));
  }
  lines.push(
    '',
    'BUILDING THE TABLE (once, at init):',
    '',
    ...(is3d
      ? [
          '  for (layer, row, col) over the grid, for each offset k = (dr, dc, dl):',
          '      nLayer = layer + dl;  nRow = row + dr;  nCol = col + dc;',
        ]
      : [
          '  for (row, col) over the grid, for each offset k = (dr, dc):',
          '      nRow = row + dr;  nCol = col + dc;',
        ]),
    '      if out of range:',
    torus
      ? (is3d
          ? '          nLayer = ((nLayer % D) + D) % D;  nRow = ((nRow % H) + H) % H;  nCol = ((nCol % W) + W) % W;'
          : '          nRow = ((nRow % H) + H) % H;  nCol = ((nCol % W) + W) % W;')
      : '          table[idx * nSz + k] = total;   // the SENTINEL cell — done, skip the store below',
    is3d
      ? '      table[idx * nSz + k] = (nLayer * H + nRow) * W + nCol;'
      : '      table[idx * nSz + k] = nRow * W + nCol;',
  );
  return [banner('NEIGHBOURHOODS  — the `nIdx_*` / `nSz_*` parameters'), comment(lines)].join('\n');
}

function sectionNeighborIndexCodec(model: CAModel): string {
  const usesNI = model.attributes.some(a => a.type === 'neighborIndex');
  const codecNodes = new Set(['neighborIndexFromOffset', 'breakDownNeighborIndex', 'flipNeighborIndex', 'getAllNeighborIndexes', 'getNeighborIndexesByTags', 'neighborIndexFromTag', 'getNeighborAttributeByIndex', 'setNeighborAttributeByIndex', 'pickRandomNeighbor', 'pickNRandomNeighbors', 'filterNeighbors', 'joinNeighbors', 'getNeighborsAttrByIndexes']);
  const usesNodes = (model.graphNodes ?? []).some(n => codecNodes.has(String(n.data?.nodeType)));
  if (!usesNI && !usesNodes) return '';
  const is3d = is3dModel(model);
  return [
    banner('NEIGHBOUR INDEX CODEC'),
    comment(is3d
      ? [
          'A "neighbour index" (NI) is a RELATIVE offset packed into one i32:',
          '',
          '    NI = (dr << 20) | (dc << 10) | dl        // three SIGN-EXTENDED 10-bit fields',
          '    dr = (NI << 2)  >> 22                    // range +-511 per axis',
          '    dc = (NI << 12) >> 22',
          '    dl = (NI << 22) >> 22',
          '',
          '    INVALID_NI = 0x80000000                  // "no neighbour"; compare the bit pattern',
          '',
          'Resolve an NI to a cell: apply (dr, dc, dl) to the cell\'s own (row, col, layer)',
          'and wrap/sentinel exactly as the neighbourhood table build does.',
        ]
      : [
          'A "neighbour index" (NI) is a RELATIVE offset packed into one i32:',
          '',
          '    NI = (dr << 16) | (dc & 0xffff)          // two SIGN-EXTENDED 16-bit halves',
          '    dr = NI >> 16',
          '    dc = (NI << 16) >> 16',
          '',
          '    INVALID_NI = 0x80000000                  // "no neighbour"; compare the bit pattern',
          '',
          'Resolve an NI to a cell: apply (dr, dc) to the cell\'s own (row, col) and',
          'wrap/sentinel exactly as the neighbourhood table build does.',
        ]),
  ].join('\n');
}

function sectionRandom(): string {
  return [
    banner('RANDOM NUMBERS  — the `_rngState` parameter'),
    comment([
      'ONE shared xorshift32 stream, held in a Uint32Array(1). The compiled code',
      'reads it into a local at entry and writes it back at exit:',
      '',
      '    let _rs = _rngState[0] || 0x12345678;       // at function entry',
      '    ...',
      '    _rngState[0] = _rs;                          // at function exit',
      '',
      'One draw (the exact sequence every engine uses — reproduce it bit for bit):',
      '',
      '    _rs ^= _rs << 13;  _rs >>>= 0;',
      '    _rs ^= _rs >>> 17; _rs >>>= 0;',
      '    _rs ^= _rs << 5;   _rs >>>= 0;',
      '    u = _rs / 4294967296;                        // in [0, 1)',
      '',
      'The ENGINE draws from the SAME stream for its own randomness (the async visit',
      'order below), always BEFORE calling the step. Seed it with any non-zero u32;',
      'the same seed reproduces a run exactly.',
    ]),
  ].join('\n');
}

function sectionIndicators(model: CAModel): string {
  const inds: Indicator[] = model.indicators ?? [];
  if (inds.length === 0) return '';
  const rows = inds.map((ind, i) => [
    String(i), ind.id, ind.name, ind.kind,
    ind.kind === 'standalone' ? (ind.dataType ?? 'float') : (ind.kind === 'linked' ? `${ind.linkedAggregation ?? 'total'} of ${model.attributes.find(a => a.id === ind.linkedAttributeId)?.name ?? '?'}` : (ind.graphMetric ?? 'nodeCount')),
    ind.accumulationMode ?? 'per-generation',
    ind.kind === 'standalone' ? (ind.defaultValue ?? '0') : '—',
  ]);
  const lines = [
    '`_indicators` is a Float64Array with ONE SLOT PER INDICATOR, in this order:',
    '',
    ...table(['slot', 'id', 'name', 'kind', 'source / aggregation', 'accumulation', 'default'], rows),
    '',
    'STANDALONE indicators are written by the rule (Set/Update Indicator) and read',
    'with Get Indicator. Any slot marked `per-generation` is RESET to its default at',
    'the top of every generation, before the step runs.',
  ];
  if (inds.some(i => i.kind === 'linked')) {
    lines.push(
      '',
      'LINKED indicators are COMPUTED by scanning a cell attribute after the step —',
      'the compiled JS step below already contains that post-loop scan and writes',
      'the result into `_linkedResults`. `accumulated` ones add each generation\'s',
      'value into a running total the engine keeps.',
    );
  }
  if (inds.some(i => i.xAxis === 'rows' || i.xAxis === 'columns' || i.xAxis === 'layers')) {
    lines.push('', 'SPATIAL indicators (rows/columns/layers axis) are a per-position histogram the', 'ENGINE recomputes from the post-step buffer each generation — never accumulated.');
  }
  return [banner('INDICATORS  — the `_indicators` parameter'), comment(lines)].join('\n');
}

function sectionStopAndEnd(model: CAModel, result: CompileResult): string {
  const msgs = result.stopMessages ?? [];
  const ec = model.properties.endConditions;
  if (msgs.length === 0 && !ec?.enabled) return '';
  const lines: string[] = [];
  if (msgs.length > 0) {
    lines.push(
      '`_stopFlag` is a Uint32Array(1), cleared to 0 before every generation. A Stop',
      'Event node writes a 1-BASED index into it, first-match-wins:',
      '',
      '    if (_stopFlag[0] === 0) _stopFlag[0] = <n>;',
      '',
      'After the generation, a non-zero value means "pause and show message n-1":',
      '',
      ...msgs.map((m, i) => `    ${i + 1} -> ${JSON.stringify(m)}`),
    );
  }
  if (ec?.enabled) {
    if (lines.length) lines.push('');
    lines.push('END CONDITIONS (checked by the driver after each generation):');
    if (ec.maxGenerations) lines.push(`  - stop when generation >= ${ec.maxGenerations}`);
    for (const c of ec.indicatorConditions ?? []) {
      const ind = (model.indicators ?? []).find(i => i.id === c.indicatorId);
      lines.push(`  - stop when ${ind?.name ?? c.indicatorId}${c.category ? `[${c.category}]` : ''} ${c.op} ${c.value}`);
    }
  }
  return [banner('STOP EVENTS & END CONDITIONS'), comment(lines)].join('\n');
}

function sectionColorAndViewers(model: CAModel, opts: DocOptions): string {
  const oms = model.mappings.filter(m => m.isAttributeToColor);
  const ins = model.mappings.filter(m => !m.isAttributeToColor);
  if (oms.length === 0 && ins.length === 0) return '';
  const lines = [
    '`colors` is a Uint8ClampedArray of 4 bytes (R,G,B,A) per cell:',
    '',
    '    const colorIdx = idx * 4;',
    '',
    'Colour passes are guarded on `activeViewer` (the id of the mapping being',
    'displayed) so one graph can serve several views.',
  ];
  if (oms.length) {
    lines.push('', 'Attribute -> Colour mappings (output; pass the chosen id as `activeViewer`):');
    for (const m of oms) lines.push(`  ${m.id}${opts.activeViewer === m.id ? '  <- currently displayed' : ''}   ${m.name}${m.linked ? '  [linked — the colour pass below is auto-generated]' : ''}`);
  }
  if (ins.length) {
    lines.push('', 'Colour -> Attribute mappings (input; the brush — one call PER PAINTED CELL):');
    for (const m of ins) lines.push(`  ${m.id}   ${m.name}`);
  }
  return [banner('COLOURS & VIEWERS  — the `colors` / `activeViewer` parameters'), comment(lines)].join('\n');
}

function sectionVariegation(model: CAModel): string {
  const v = model.variegatedCells;
  if (!v?.enabled) return '';
  const src = model.attributes.find(a => a.id === v.sourceAttributeId);
  const lines = [
    'Every cell carries an ORIENTATION (0..3 = 0/90/180/270 deg clockwise), stored',
    'in its own Int32Array pair (`r_orientation` / `w_orientation`) with exactly the',
    'same double-buffer discipline as the cell attributes. The sentinel cell (if any)',
    'holds orientation 0.',
    '',
    `Species attribute: ${src?.name ?? v.sourceAttributeId}`,
    '',
    'Face-label palettes:',
    ...v.facePalettes.map(p => `  ${p.name}: none, ${p.labels.join(', ')}`),
    '',
    'Face patterns (8 slots, N/NE/E/SE/S/SW/W/NW), flattened into `_facePatternLookup`',
    'as `[species * 8 + direction] -> label index` (0 = none):',
    ...v.facePatterns.map(fp => `  ${fp.name} [${fp.layoutMode}]: ${(fp.faces ?? []).join(', ')}`),
  ];
  return [banner('VARIEGATED CELLS (orientation + faces)'), comment(lines)].join('\n');
}

// ---------------------------------------------------------------------------
// Agent sections
// ---------------------------------------------------------------------------

function sectionAgents(model: CAModel): string {
  if (!isAgentModel(model)) return '';
  const cfg = model.centerBased;
  const dt = effectiveAgentDt(cfg);
  const maxBonds = resolveMaxBonds(cfg);
  const charge = usesCharge(cfg);
  const gates = resolveAgentFieldGates(model);
  const motion = agentMotionMode(cfg);
  const rows: string[][] = [
    ['maxAgents (slot ceiling)', String(cbNum(cfg, 'maxAgents'))],
    ['world', `${cbNum(cfg, 'worldWidth')} x ${cbNum(cfg, 'worldHeight')}${(cfg?.worldDepth ?? 1) > 1 ? ` x ${cfg?.worldDepth}` : ''}  (1:1 with the cell grid)`],
    ['update mode', cfg?.agentUpdateMode === 'sync' ? 'synchronous (attributes double-buffered)' : 'asynchronous (attributes single-buffered)'],
    ['motion', `${motion}  (integrates: ${motionIntegrates(cfg) ? 'yes' : 'no'}, applies forces: ${motionAppliesForces(cfg) ? 'yes' : 'no'})`],
    ['time step dt', `${num(dt.dt)}${dt.clamped ? `  (requested ${num(dt.requested)}, CLAMPED to 0.2 / mu_eff = ${num(dt.bound)}; mu_eff = ${num(dt.muEff)})` : ''}`],
    ['drag eta', num(cbNum(cfg, 'drag'))],
    ['momentum', num(cbNum(cfg, 'momentum'))],
    ['maxSpeed', cbNum(cfg, 'maxSpeed') > 0 ? num(cbNum(cfg, 'maxSpeed')) : 'uncapped'],
    ['collision', collisionMode(cfg) + (usesPositionalCollision(cfg) ? `  (${cbNum(cfg, 'positionalIterations')} Jacobi sweeps)` : '')],
    ['bond springs', usesEngineSprings(cfg) ? `on (stiffness ${num(cbNum(cfg, 'bondStiffness'))}, rest length ${num(cbNum(cfg, 'bondRestLength'))})` : 'off'],
    ['growth ramp', usesEngineGrowth(cfg) ? `on (rate ${num(cbNum(cfg, 'growthRate'))})` : 'off'],
    ['maxBonds / agent', String(maxBonds) + (maxBonds === 0 ? '  (no bond store allocated)' : '')],
    ['bond request depth', String(resolveBondRequestDepth(cfg))],
    ['force iterations / gen', String(layoutIterationsOf(cfg))],
    ['neighbour query radius', num(cbNum(cfg, 'neighbourQueryRadius'))],
    ['interaction range', num(cbNum(cfg, 'interactionRange')) + ' x contact distance'],
    ['repulsion mu_R', num(cbNum(cfg, 'repulsionStiffness'))],
    ['adhesion mu_A', num(cbNum(cfg, 'adhesionStiffness'))],
  ];
  if (charge) {
    rows.push(['charge', `k = ${num(chargeStrengthOf(cfg))}, range = ${chargeRangeOf(cfg)}` +
      (usesGlobalCharge(cfg)
        ? `, Barnes-Hut theta = ${num(chargeThetaOf(cfg))}${Number.isFinite(chargeGlobalMaxDistOf(cfg)) ? `, cutoff ${num(chargeGlobalMaxDistOf(cfg))}` : ' (unbounded)'}`
        : `, cutoff = ${num(chargeMaxDistOf(cfg))}`)]);
  }
  rows.push(['spatial hash bin edge', `max(interactionRange*2*maxRadius, neighbourQueryRadius${charge ? `, ${num(chargeBinEdgeOf(cfg))}` : ''})`]);

  const lines: string[] = [
    'Agents are off-lattice bodies with continuous positions, held in a parallel',
    'Structure-of-Arrays. The agent world IS the cell grid frame, 1:1.',
    '',
    ...table(['setting', 'resolved value'], rows),
  ];

  // Agent SoA.
  const soa: string[][] = [
    ['x, y' + ((cfg?.worldDepth ?? 1) > 1 ? ', z' : ''), 'Float64Array', 'position'],
    ['xNext, yNext' + ((cfg?.worldDepth ?? 1) > 1 ? ', zNext' : ''), 'Float64Array', 'position double-buffer (committed after the force pass)'],
    ['vx, vy' + ((cfg?.worldDepth ?? 1) > 1 ? ', vz' : ''), 'Float64Array', 'velocity'],
    ['forceX, forceY' + ((cfg?.worldDepth ?? 1) > 1 ? ', forceZ' : ''), 'Float64Array', 'per-generation force accumulator (ZEROED each generation)'],
    ['radius', 'Float64Array', 'current radius'],
    ['alive', 'Uint8Array', '1 = live slot'],
    ['lineage, epoch', 'Int32Array', 'lineage id; epoch is bumped on slot reuse (stale-bond detection)'],
    ['bondCount', 'Int32Array', 'live bond count (engine reduction)'],
  ];
  if (gates.targetRadius) soa.push(['targetRadius', 'Float64Array', 'growth ramp target']);
  if (gates.age) soa.push(['age', 'Float64Array', 'generations alive (+1 per generation)']);
  if (gates.density) soa.push(['density', 'Float64Array', 'neighbour density (engine reduction, one generation stale)']);
  if (maxBonds > 0) {
    soa.push(['bondPartner[i*maxBonds+k]', 'Int32Array', 'ragged bond list — partner slot id']);
    soa.push(['bondPartnerEpoch', 'Int32Array', 'partner epoch stamped at form time']);
    soa.push(['bondRestLength, bondStiffness', 'Float64Array', 'per-bond spring parameters']);
  }
  for (const a of agentAttrsOf(model)) soa.push([a.id, storageFor(a.type), `agent attribute "${a.name}" (${a.type}, default ${num(encodeAttrValue(a, a.defaultValue))})`]);
  lines.push('', 'PER-AGENT STORAGE (one array each, length maxAgents):', '', ...table(['field', 'storage', 'meaning'], soa));

  const bAttrs = bondAttrsOf(model);
  if (bAttrs.length > 0) {
    lines.push('', 'PER-BOND ATTRIBUTES (ragged, same stride as the bond list; a bond is stored',
      'TWICE — once in each endpoint\'s row — and both copies always agree):', '',
      ...table(['id', 'name', 'type', 'storage', 'default'],
        bAttrs.map(a => [a.id, a.name, a.type, a.type === 'float' ? 'Float64Array' : 'Int32Array', num(encodeAttrValue(a, a.defaultValue))])));
  }

  const fieldAttrs = cellFieldAttrsOf(model);
  if (fieldAttrs.length > 0) {
    lines.push('', 'FIELD BRIDGE — cell attributes agents may read/write (`_field_<id>` in the',
      'agent signature; these ARE the cell arrays, not copies):', '',
      ...table(['id', 'name', 'access'], fieldAttrs.map(a => [a.id, a.name, a.agentAccess ?? 'read'])));
  }

  return [banner('BOND-GRAPH AGENTS'), comment(lines)].join('\n');
}

// ---------------------------------------------------------------------------
// SECTION 2 — DRIVER SKELETON
// ---------------------------------------------------------------------------

function sectionDriver(model: CAModel, result: CompileResult): string {
  const p = model.properties;
  const isAsync = p.updateMode === 'asynchronous';
  const scheme = p.asyncScheme ?? 'random-order';
  const gridOn = model.topologyMode?.gridCells !== false;
  const agents = isAgentModel(model);
  const hasInit = !!result.initCode;
  const hasGridInit = !!result.gridInitCode;
  const hasOM = (result.outputMappingCodes ?? []).length > 0;
  const linked = (model.indicators ?? []).some(i => i.kind === 'linked');
  const perGen = (model.indicators ?? []).some(i => i.kind === 'standalone' && (i.accumulationMode ?? 'per-generation') === 'per-generation');
  const variegated = !!model.variegatedCells?.enabled;
  const sparse = sparseSteppingEnabled(model);
  const stops = (result.stopMessages ?? []).length > 0;

  const L: string[] = [];
  L.push('This is what the ENGINE does around the compiled functions. Only the');
  L.push('branches THIS model takes are shown.');
  L.push('');
  L.push('// ---- ONE-TIME SETUP -------------------------------------------------');
  L.push('function init() {');
  if (gridOn) {
    L.push('  // 1. Allocate one typed array per cell attribute and fill with its default.');
    L.push(p.boundaryTreatment === 'torus'
      ? '  //    Length = total.'
      : '  //    Length = total + 1; cell `total` is the boundary sentinel — write each');
    if (p.boundaryTreatment !== 'torus') L.push('  //    attribute\'s boundary value into it (it is never written again).');
    L.push(isAsync
      ? '  //    ASYNC: read and write are the SAME array (single buffer).'
      : '  //    SYNC: allocate a second WRITE array per attribute (double buffer).');
    L.push('  // 2. Build the neighbour index tables (see NEIGHBOURHOODS).');
    L.push('  // 3. Allocate colors = Uint8ClampedArray(total * 4).');
    if (variegated) L.push('  //    Allocate the orientation read/write arrays (Int32Array, filled 0).');
  }
  L.push('  // 4. Seed _rngState[0] with any non-zero u32.');
  if ((model.indicators ?? []).length) L.push('  // 5. _indicators = Float64Array(N); set standalone slots to their defaults.');
  if (isAsync && gridOn) {
    L.push('  // 6. order = Int32Array(total), order[i] = i.');
    if (scheme === 'cyclic') L.push('  //    CYCLIC scheme: shuffle it ONCE here (Fisher-Yates, drawing from _rngState).');
  }
  L.push('}');
  L.push('');
  L.push('// ---- RESET (also runs once on first load) ---------------------------');
  L.push('function reset() {');
  if (gridOn) L.push('  fillEveryCellWithItsDefault();          // both buffers');
  L.push('  generation = 0;');
  if ((model.indicators ?? []).length) L.push('  resetIndicators();');
  if (agents) L.push('  clearAndSeedAgents();                   // re-allocate the agent store from the config');
  if (hasInit) {
    L.push('  // Init Event — the compiled per-cell init function, ONE call, loop inside.');
    L.push('  initFn(...loopArgs);');
    if (!isAsync) L.push('  copy(writeBuffers -> readBuffers);      // SYNC: init wrote the write buffers');
  }
  if (hasGridInit) {
    L.push('  // Grid Init Event — GLOBAL, runs ONCE (not per cell). It runs AFTER the');
    L.push('  // per-cell Init Event, so a global seed is the final word.');
    if (!isAsync) L.push('  copy(readBuffers -> writeBuffers);      // SYNC: preserve untouched cells');
    L.push('  gridInitFn(...loopArgs);');
    if (!isAsync) L.push('  copy(writeBuffers -> readBuffers);');
  }
  if (agents) L.push('  agentInitFn(...agentInitArgs);          // Agent Init Event — AFTER the cell init (D-FIELD)');
  if (hasOM) L.push('  colorPass();');
  L.push('}');
  L.push('');
  L.push('// ---- ONE GENERATION -------------------------------------------------');
  L.push('function runGeneration() {');
  if (agents) {
    L.push('  // AGENTS STEP FIRST, then the cell step (Decision D-FIELD): agents SAMPLE the');
    L.push('  // field as of the previous cell step, then DEPOSIT into the cell READ buffers,');
    L.push('  // and the cell rule below incorporates the deposit in the same generation.');
    L.push('  runAgentGeneration();                   // see AGENT GENERATION below');
  }
  if (gridOn) {
    if (stops) L.push('  _stopFlag[0] = 0;');
    if (perGen) L.push('  resetPerGenerationIndicatorSlots();');
    if (isAsync) {
      L.push('');
      L.push(`  // ASYNC (${scheme}) — the visit order, drawn from the SHARED rng stream`);
      L.push('  // BEFORE the step runs (this is what makes a seeded run reproducible):');
      if (scheme === 'random-order') {
        L.push('  for (let i = total - 1; i > 0; i--) {   // Fisher-Yates: every cell exactly once');
        L.push('    const j = (nextRandom() * (i + 1)) | 0;');
        L.push('    [order[i], order[j]] = [order[j], order[i]];');
        L.push('  }');
      } else if (scheme === 'random-independent') {
        L.push('  for (let i = 0; i < total; i++)         // N picks WITH replacement');
        L.push('    order[i] = (nextRandom() * total) | 0;');
      } else {
        L.push('  // cyclic: `order` keeps the permutation shuffled once at init — no per-step work.');
      }
      L.push('  _skipped.fill(0);                       // Mark Cell Updated flags are per-step');
      const subs = cellAttrsOf(model).filter(a => a.parentAttributeId);
      if (subs.length) L.push('  scrubSubAttributesOnNonMatchingCells();  // see CELL ATTRIBUTES');
    }
    L.push('');
    L.push('  // THE RULE — ONE call; the loop is INSIDE the compiled function.');
    L.push('  stepFn(...loopArgs);                    // see COMPILED FUNCTIONS for the argument order');
    L.push('');
    if (!isAsync) {
      L.push('  // SYNC: the generation just computed lives in the WRITE buffers. Swap them');
      L.push('  // (a reference swap is enough — nothing else holds them).');
      L.push('  [readBuffers, writeBuffers] = [writeBuffers, readBuffers];');
      if (variegated) L.push('  copy(w_orientation -> r_orientation);   // orientation lives at fixed offsets — copy, do not swap');
    } else {
      L.push('  // ASYNC: read and write are one buffer — nothing to swap.');
    }
    if (linked) {
      L.push('  // Linked indicators: the compiled JS step already ran its post-loop scan and');
      L.push('  // filled `_linkedResults`. Accumulated ones add into a running total here.');
    }
    if (sparse) {
      L.push('  // Sparse stepping: update the active-cell set from this generation\'s');
      L.push('  // empty <-> non-empty transitions (only ACTIVE cells could have changed).');
    }
  }
  L.push('  generation++;');
  L.push('}');
  L.push('');
  L.push('// ---- PER FRAME (after a batch of generations) ------------------------');
  if (gridOn) {
    if (hasOM) {
      L.push('colorPass();      // ONE call; loops every cell and writes `colors`');
      L.push('                  // pass the DISPLAYED mapping id as `activeViewer`');
    } else {
      L.push('// This model has no cell Output Mapping: the step itself writes `colors`.');
    }
  }
  if (agents) {
    L.push((model.agentMappings ?? []).length > 0
      ? 'agentColorPass();  // ONE call; loops every agent and writes the per-agent RGBA'
      : '// This model has no Agent Output Mapping: the behaviour writes agent colours');
    if ((model.agentMappings ?? []).length === 0) L.push('// directly (Set Cell Looks), or they stay at the default.');
  }
  if (stops || model.properties.endConditions?.enabled) {
    L.push('checkStopFlagAndEndConditions();   // see STOP EVENTS & END CONDITIONS');
  }
  if ((result.inputColorCodes ?? []).length) {
    L.push('');
    L.push('// ---- PAINTING (user input, not part of a generation) ----------------');
    L.push('// The input-mapping function is PER CELL: call it once for each painted cell');
    L.push('// with that cell\'s idx and the brush colour, then copy the written values');
    L.push('// back into the read buffers so the next generation sees them.');
  }

  const out = [banner('DRIVER SKELETON'), comment(L)];
  if (isAgentModel(model)) out.push(sectionAgentDriver(model));
  return out.join('\n\n');
}

function sectionAgentDriver(model: CAModel): string {
  const cfg = model.centerBased;
  const iters = layoutIterationsOf(cfg);
  const soft = usesSoftCollision(cfg);
  const springs = usesEngineSprings(cfg);
  const growth = usesEngineGrowth(cfg);
  const charge = usesCharge(cfg);
  const positional = usesPositionalCollision(cfg);
  const maxBonds = resolveMaxBonds(cfg);
  const dt = effectiveAgentDt(cfg);
  const sync = cfg?.agentUpdateMode === 'sync';
  const is3dWorld = (cfg?.worldDepth ?? 1) > 1;
  const torus = model.properties.boundaryTreatment === 'torus';
  const fieldAttrs = cellFieldAttrsOf(model);

  const stencil = `3x3${is3dWorld ? 'x3' : ''}`;
  const foldNote = torus ? '   // TORUS: minimum-image fold, e.g. if (dx > W/2) dx -= W; else if (dx < -W/2) dx += W;' : '';
  const L: string[] = [];
  let stepNo = 0;
  const N = () => `  // ${++stepNo}.`;
  L.push('function runAgentGeneration() {');
  L.push(N() + ' ZERO the force accumulators (forceX/Y[/Z]) for slots [0, highWater).');
  L.push('  //    NB the loop bound is `highWater` (slots may be holes) — `liveCount` is a');
  L.push('  //    display tally, never a loop bound. Skip a slot when alive[i] === 0.');
  L.push(N() + ' BUILD THE SPATIAL HASH — uniform bins, CSR (binStart[nBins+1] prefix sums');
  L.push('  //    + binAgents[] grouped by bin). ONCE per generation, before the behaviour,');
  L.push('  //    so the rule\'s neighbour queries and the force pass share it.');
  L.push('  //      maxR    = max(defaultRadius, max radius over live agents)');
  L.push(`  //      binEdge = max(interactionRange*2*maxR, neighbourQueryRadius${charge && !usesGlobalCharge(cfg) ? ', chargeMaxDist' : ''})`);
  L.push(`  //    Every neighbour query sweeps the ${stencil} bin stencil around the agent, so`);
  L.push('  //    the bin edge MUST cover the widest force reach — otherwise far pairs are');
  L.push('  //    silently invisible (wrong physics, no error).');
  L.push('  //    Fewer than 3 bins on any axis ⇒ no hash; fall back to an all-pairs loop.');
  if (charge && usesGlobalCharge(cfg)) {
    L.push('  //    Also BUILD THE BARNES-HUT OCTREE (global charge), once per generation,');
    L.push('  //    from the same positions the hash saw.');
  }
  if (sync) L.push(N() + ' SYNC agent attributes: copy read -> write before the behaviour runs.');
  L.push(N() + ' THE RULE — ONE call per generation; the per-agent loop is INSIDE.');
  L.push('  agentBehaviourFn(...agentLoopArgs);');
  if (sync) L.push('  //    SYNC: swap the agent attribute read/write buffers now.');
  if (fieldAttrs.length) {
    L.push('  //    FIELD BRIDGE: field READS inside the behaviour sample the cell arrays as');
    L.push('  //    of the PREVIOUS cell step (a step-start snapshot); field WRITES deposit');
    L.push('  //    into the cell READ arrays, which the cell step below then consumes.');
  }
  L.push('');
  L.push(`  // ---- FORCE PASS  (runs ${iters} time${iters === 1 ? '' : 's'} per generation) ----`);
  L.push(`  for (let it = 0; it < ${iters}; it++) {`);
  L.push('    for each live agent i:');
  L.push('      F = (forceX[i], forceY[i]' + (is3dWorld ? ', forceZ[i]' : '') + ');');
  L.push('      // ^ the graph-authored force (Apply Force), NOT cleared between iterations:');
  L.push('      //   it is a constant external force for this generation.');
  if (soft || (charge && !usesGlobalCharge(cfg))) {
    L.push(`      for each neighbour j in the ${stencil} stencil:`);
    L.push('        (dx, dy' + (is3dWorld ? ', dz' : '') + ') = p_j - p_i;' + foldNote);
    L.push('        d2 = dx*dx + dy*dy' + (is3dWorld ? ' + dz*dz' : '') + ';');
  }
  if (charge && !usesGlobalCharge(cfg)) {
    // The cutoff-charge term is applied FIRST — before the soft-sphere rmax reject.
    L.push(`        // CHARGE FIRST (its cutoff R = ${num(chargeMaxDistOf(cfg))} is far wider than the`);
    L.push('        // soft-sphere cutoff, so it must be added before that reject):');
    L.push('        if (d2 !== 0 && d2 <= R*R) {');
    L.push(`          c = k * (1/(1 + d2) - 1/(1 + R*R));   // k = ${num(chargeStrengthOf(cfg))}, R = ${num(chargeMaxDistOf(cfg))}`);
    L.push('          F += c * (dx, dy' + (is3dWorld ? ', dz' : '') + ');            // note: times the RAW delta, not the unit vector');
    L.push('        }');
  }
  if (soft) {
    L.push('        s    = radius[i] + radius[j];         // the PAIR contact distance');
    L.push(`        rmax = ${num(cbNum(cfg, 'interactionRange'))} * s;                        // interactionRange * s`);
    L.push('        if (d2 === 0 || d2 >= rmax*rmax) continue;');
    L.push('        density[i]++;                          // the engine "neighbour density" reduction');
    L.push('        d = sqrt(d2);');
    L.push(`        mu = (d < s) ? ${num(cbNum(cfg, 'repulsionStiffness'))} : ${num(cbNum(cfg, 'adhesionStiffness'))};      // mu_R below contact, mu_A above`);
    L.push('        F += (mu * (d - s) / d) * (dx, dy' + (is3dWorld ? ', dz' : '') + ');   // i.e. mu * (d - s) * rhat');
  }
  if (charge && usesGlobalCharge(cfg)) {
    const R = chargeGlobalMaxDistOf(cfg);
    L.push('      // CHARGE (GLOBAL): sum EVERY pair through the Barnes-Hut octree. A node is');
    L.push(`      // treated as ONE body at its centre of mass when  extent^2 < ${num(chargeThetaOf(cfg))}^2 * d^2,`);
    L.push('      // otherwise descend; at a leaf, sum its points individually.');
    L.push(Number.isFinite(R)
      ? `      //   term = mass * (1/(1 + d2) - 1/(1 + R*R)),  R = ${num(R)}   // truncated`
      : '      //   term = mass * (1/(1 + d2))                              // unbounded reach');
    L.push(`      // Accumulate the terms, then multiply ONCE by k = ${num(chargeStrengthOf(cfg))}.`);
    L.push('      // Self lands in a leaf at d = 0, whose term is multiplied by a zero delta.');
  }
  if (springs && maxBonds > 0) {
    L.push('      for each bond slot k of agent i (k < bondCount[i]):');
    L.push('        j = bondPartner[i*maxBonds + k];');
    L.push('        if (j < 0 || !alive[j] || bondPartnerEpoch[i*maxBonds+k] !== epoch[j]) continue;   // stale');
    L.push('        d = |p_j - p_i|;' + (torus ? '                       // same minimum-image fold' : ''));
    L.push('        F += (bondStiffness[i*maxBonds+k] * (d - bondRestLength[i*maxBonds+k]) / d) * (p_j - p_i);');
    L.push(`        // i.e. lambda * (l - L) * rhat, with PER-BOND lambda and L (form-time defaults:`);
    L.push(`        // lambda = ${num(cbNum(cfg, 'bondStiffness'))}, L = ${num(cbNum(cfg, 'bondRestLength'))}; a rest length of 0 means "the pair's contact distance").`);
  }
  if (motionIntegrates(cfg)) {
    L.push('      // INTEGRATE');
    if (motionAppliesForces(cfg)) {
      L.push(`      v = ${num(cbNum(cfg, 'momentum'))} * v + (${num(dt.dt)} / ${num(cbNum(cfg, 'drag'))}) * F;        // momentum*v + (dt/eta)*F`);
    } else {
      L.push('      // motion = "velocity": v is whatever the RULE set — F is ignored.');
    }
    if (cbNum(cfg, 'maxSpeed') > 0) L.push(`      if (|v| > ${num(cbNum(cfg, 'maxSpeed'))}) v *= ${num(cbNum(cfg, 'maxSpeed'))} / |v|;      // |v| over ${is3dWorld ? 'x,y,z' : 'x,y'}`);
    L.push('      pNext = p + v;');
    L.push(torus
      ? '      pNext = ((pNext % worldSize) + worldSize) % worldSize;   // wrap, per axis'
      : '      pNext = clamp(pNext, 0, worldSize);                      // per axis, [0, size] inclusive');
  } else {
    L.push(`      // MOTION IS "${agentMotionMode(cfg)}" — the engine does NOT move agents. The force`);
    L.push('      // accumulation, the integration AND the position commit are ALL skipped');
    L.push('      // together: committing alone would copy a stale pNext over p and revert');
    L.push('      // every Set Agent Position the rule made.');
  }
  L.push('      age[i] += 1;');
  if (growth) L.push(`      // GROWTH: radius moves toward targetRadius by at most ${num(cbNum(cfg, 'growthRate') / iters)} (= rate/iterations),`);
  if (growth) L.push('      // clamped so it never overshoots. N steps of rate/N land exactly where one');
  if (growth) L.push('      // step of rate would.');
  if (motionIntegrates(cfg)) L.push('    commit pNext -> p for every agent;      // end of this iteration');
  L.push('  }');
  if (iters > 1) L.push(`  // age was incremented once per iteration — subtract ${iters - 1} so a generation is +1.`);
  if (positional) {
    const pIters = Math.max(1, Math.floor(cbNum(cfg, 'positionalIterations')));
    L.push('');
    L.push(`  // ---- POSITIONAL COLLISION (${pIters} Jacobi sweep${pIters === 1 ? '' : 's'}) ----`);
    L.push('  // Rigid no-overlap projection. Each sweep reads the sweep-START positions and');
    L.push('  // accumulates a HALF-overlap push per overlapping pair, applying them all at');
    L.push('  // once — so it is ORDER-INDEPENDENT:');
    L.push('  //     if (0 < d < s_ij)  corr_i -= 0.5 * (s_ij - d)/d * (p_j - p_i)');
    L.push('  // then p += corr, wrapped/clamped as above. Its hash uses the UN-widened edge');
    L.push('  // max(interactionRange*2*maxR, neighbourQueryRadius) — contact distance only.');
  }
  L.push('');
  L.push('  // ---- STRUCTURAL PHASE — ONCE per generation, on the SETTLED state ----');
  L.push('  // (never inside the force loop: replaying it would re-apply every queued op)');
  const depth = resolveBondRequestDepth(cfg);
  if (maxBonds > 0) {
    L.push(`  // a. DRAIN each agent's bond REQUEST QUEUE in slot order (= the order the rule`);
    L.push(`  //    issued them). Stride is depth + 1 = ${depth + 1}: entry ${depth} is the OVERFLOW`);
    L.push('  //    BUCKET — written by any op past the depth, applied by none.');
    L.push('  //    Each entry has TWO lanes (breakLane, formLane), encoded:');
    L.push('  //        0        empty  (the first 0/0 entry terminates the queue)');
    L.push('  //        1        this side unused');
    L.push('  //        v + 2    agent v');
    L.push('  //    Decode IN THIS ORDER (a wrong order silently becomes a different op):');
    L.push('  //        breakLane < 0  -> FORM BETWEEN a = -breakLane-2 and b = formLane-2');
    L.push('  //        formLane  < 0  -> TRANSFER: rewrite b = breakLane-2\'s slot holding me');
    L.push('  //                          to point at -formLane-2, IN PLACE');
    L.push('  //        both >= 0      -> REWIRE from -> to (ATOMIC: one entry, both sides)');
    L.push('  //        only form >= 0 -> FORM      only break >= 0 -> BREAK');
    L.push('  //    An op that cannot complete is REJECTED WHOLE — never half-applied. A bond');
    L.push('  //    is stored TWICE (once in each endpoint\'s row) and both copies must always');
    L.push('  //    agree; removing one compacts by swapping the LAST slot into the hole, which');
    L.push('  //    moves BOTH endpoints\' rows.');
  }
  L.push('  // b. DEATHS: free the slot, break ALL its bonds, bump its epoch (so any bond');
  L.push('  //    still pointing at the recycled slot reads as stale).');
  L.push('  // c. DIVISIONS: iterate only the PRE-division population, so daughters (which');
  L.push('  //    land beyond it) are not re-divided this generation. Split the mother along');
  L.push('  //    its tension axis, partition its bonds between the daughters, then run the');
  L.push('  //    Division Event once per daughter. Capacity overflow rejects the WHOLE');
  L.push('  //    division — never a half-rewired partner.');
  if (cfg?.autoBond && maxBonds > 0 && springs) {
    L.push(`  // d. AUTO-BOND by distance, over its OWN hash at edge ${num(cbNum(cfg, 'breakDistance'))}*2*maxR:`);
    L.push(`  //      form when d < ${num(cbNum(cfg, 'formDistance'))} * (radius[i] + radius[j])`);
    L.push(`  //      break when d > ${num(cbNum(cfg, 'breakDistance'))} * (radius[i] + radius[j])`);
    L.push('  //    form < break is the HYSTERESIS band. Handle each pair once, from the lower');
    L.push('  //    id; iterate bond slots BACKWARDS when breaking (breaking compacts).');
  }
  if (maxBonds > 0) L.push('  // e. SWEEP stale bonds (partner epoch mismatch = the slot was recycled).');
  if (resolveAgentFieldGates(model).sprites) L.push('  // f. ADVANCE sprite frames: frame += speed, once per generation.');
  L.push('}');
  return comment(L);
}

// ---------------------------------------------------------------------------
// SECTION 3 — COMPILED FUNCTIONS
// ---------------------------------------------------------------------------

/** What one AGENT-signature parameter contains. Names come from the shared ABI
 *  descriptor (`buildAgentAbiParams`), so this can never list a field the emit
 *  does not have. */
function describeAgentParam(name: string, model: CAModel): string {
  const fixed: Record<string, string> = {
    highWater: 'exclusive loop bound over agent SLOTS (some may be dead holes)',
    _alive: 'Uint8Array — 1 = live slot; skip every other index',
    _agentX: 'Float64Array — agent x positions (in CELL units: the agent world IS the grid frame)',
    _agentY: 'Float64Array — agent y positions',
    _agentZ: 'Float64Array — agent z positions',
    _agentXNext: 'Float64Array — the position double-buffer the force pass writes',
    _agentYNext: 'Float64Array — position double-buffer (y)',
    _agentZNext: 'Float64Array — position double-buffer (z)',
    _agentVX: 'Float64Array — velocity x',
    _agentVY: 'Float64Array — velocity y',
    _agentVZ: 'Float64Array — velocity z',
    _agentForceX: 'Float64Array — force accumulator x (ZEROED before the behaviour runs)',
    _agentForceY: 'Float64Array — force accumulator y',
    _agentForceZ: 'Float64Array — force accumulator z',
    _agentRadius: 'Float64Array — current radius',
    _agentTargetRadius: 'Float64Array — the growth-ramp target',
    _agentAge: 'Float64Array — generations alive',
    _agentDensity: 'Float64Array — neighbour density (engine reduction, one generation stale)',
    _agentLineage: 'Int32Array — lineage id',
    _agentEpoch: 'Int32Array — bumped on slot reuse (stale-bond detection)',
    _bondCount: 'Int32Array — live bond count per agent',
    _bondPartner: 'Int32Array(maxAgents*maxBonds) — ragged bond list; slot k of agent i is [i*maxBonds+k]',
    _bondPartnerEpoch: 'Int32Array — the partner epoch stamped when the bond formed',
    _bondRestLength: 'Float64Array — per-bond rest length L',
    _bondStiffness: 'Float64Array — per-bond spring stiffness lambda',
    maxBonds: 'the bond-list stride',
    _divideRequest: 'Uint8Array — structural REQUEST: 1-based divide-partition code (0 = none)',
    _killRequest: 'Uint8Array — structural REQUEST: 1 = kill me at the structural phase',
    _divideAxisX: 'Float64Array — requested division axis x (0,0[,0] = "use the tension axis")',
    _divideAxisY: 'Float64Array — requested division axis y',
    _divideAxisZ: 'Float64Array — requested division axis z',
    _divideAsym: 'Float64Array — requested area split (0 = the default 0.5)',
    _bondFormReq: 'Int32Array — bond request QUEUE, form lane (see the driver skeleton for the encoding)',
    _bondBreakReq: 'Int32Array — bond request QUEUE, break lane',
    _bondFormL: 'Float64Array — queued form rest length (0 = the pair contact distance)',
    _bondFormK: 'Float64Array — queued form stiffness (0 = the config default)',
    _bondReqSlots: 'the request-queue stride = depth + 1 (the last entry is the overflow bucket)',
    _hashValid: '1 when the spatial hash was built (0 = fall back to an all-pairs scan)',
    _hashBinStart: 'Int32Array(nBins+1) — CSR prefix sums',
    _hashBinAgents: 'Int32Array — agent ids grouped by bin',
    _hashNBinsX: 'bin count on x', _hashNBinsY: 'bin count on y', _hashNBinsZ: 'bin count on z',
    _hashBinSizeX: 'bin edge on x', _hashBinSizeY: 'bin edge on y', _hashBinSizeZ: 'bin edge on z',
    _hashOriginX: 'hash origin x (0 on a torus; the agents\' bbox min otherwise)',
    _hashOriginY: 'hash origin y', _hashOriginZ: 'hash origin z',
    _fieldW: 'field/world width (cells)', _fieldH: 'field/world height', _fieldD: 'field/world depth',
    _fieldTotal: 'field cell count', _fieldBoundaryTorus: '1 when the world wraps',
    _agentColors: 'Uint8ClampedArray — 4 bytes RGBA per agent',
    _spriteIds: 'Int32Array — 0 = no sprite, else a 1-based sprite slot',
    _spriteFrames: 'Float64Array — current (fractional) frame',
    _spriteSpeeds: 'Float64Array — frames advanced per generation',
    _spriteRotations: 'Float64Array — compass degrees (0 = north, clockwise)',
    _spriteScales: 'Float64Array — size multiplier (0 = use the sprite asset default)',
    _agentCreate: 'host call: stage a new agent slot, returns its handle (-1 on overflow)',
    _agentAddToWorld: 'host call: commit a staged handle (makes it alive)',
    _agentMaxAgents: 'the slot ceiling',
    _generation: 'the generation being computed now (0-based)',
    modelAttrs: 'Record<string, number> — the model-attribute values (see MODEL ATTRIBUTES)',
    _indicators: 'Float64Array — one slot per indicator (see INDICATORS)',
    _rngState: 'Uint32Array(1) — the SHARED xorshift32 stream (see RANDOM NUMBERS)',
    _stopFlag: 'Uint32Array(1) — first-match-wins stop-event index',
    _lookupTables: 'Record<tableId, Float64Array> — see LOOKUP TABLES',
    activeViewer: 'string — the agent view currently displayed',
    colorIdx: 'this agent\'s colour byte offset (idx * 4)',
    idx: 'this agent\'s slot index',
  };
  if (fixed[name]) return fixed[name]!;
  if (name.startsWith('_field_')) {
    const a = model.attributes.find(x => x.id === name.slice(7));
    return `the CELL array for "${a?.name ?? name.slice(7)}" — the field bridge reads AND deposits here`;
  }
  if (name.startsWith('_bondAttr_')) {
    const a = (model.bondAttributes ?? []).find(x => x.id === name.slice(10));
    return `ragged per-bond attribute "${a?.name ?? name.slice(10)}" ([i*maxBonds+k]); a bond is stored in BOTH endpoints' rows`;
  }
  if (name.startsWith('_bondFormAttr_')) {
    const a = (model.bondAttributes ?? []).find(x => x.id === name.slice(14));
    return `queued initial value of bond attribute "${a?.name ?? name.slice(14)}" for a Form Bond request`;
  }
  if (name.startsWith('r_')) {
    const a = agentAttrsOf(model).find(x => x.id === name.slice(2));
    return `READ buffer for agent attribute "${a?.name ?? name.slice(2)}" (${storageFor(a?.type ?? 'float')})`;
  }
  if (name.startsWith('w_')) {
    const a = agentAttrsOf(model).find(x => x.id === name.slice(2));
    return `WRITE buffer for agent attribute "${a?.name ?? name.slice(2)}"` +
      (model.centerBased?.agentUpdateMode === 'sync' ? ' (a SEPARATE buffer — sync mode)' : ' (ALIASES the read buffer — async mode)');
  }
  return '(engine-supplied)';
}

function agentSignatureBlock(label: string, params: string, model: CAModel): string[] {
  const names = params.split(', ').filter(Boolean);
  return ['', label, ...table(['#', 'parameter', 'meaning'], names.map((n, i) => [String(i), n, describeAgentParam(n, model)]))];
}

function sectionAgentCompiled(model: CAModel, agent: AgentCodeBundle): string {
  const shape = agentAbiShapeOf(model);
  const parts: string[] = [];
  const add = (title: string, note: string[], params: string | null, code: string) => {
    parts.push(['', banner(title), comment(params ? agentSignatureBlock('arguments, in order:', params, model).concat(['', ...note]) : note), code].join('\n'));
  };
  if (agent.behaviourCode) {
    add('Agent Behaviour Step — the agent rule, once per generation',
      ['The per-agent loop is INSIDE. Skip a slot when _alive[idx] === 0.'],
      buildAgentAbiParams('loop', shape), agent.behaviourCode);
  }
  if (agent.initCode) {
    add('Agent Init Event — ONCE globally, on Reset (no per-agent loop)',
      ['Runs AFTER the cell Init Event (Decision D-FIELD): a rule that spawns agents',
        'by reading the field must see the seeded substrate.'],
      buildAgentAbiParams('init', shape), agent.initCode);
  }
  if (agent.divisionCode) {
    add('Agent Division Event — once per DAUGHTER, inside the structural phase',
      ['A single-agent function (no loop): call it for each daughter of each division.'],
      buildAgentAbiParams('division', shape), agent.divisionCode);
  }
  for (const om of agent.outputMappingCodes ?? []) {
    const m = (model.agentMappings ?? []).find(x => x.id === om.mappingId);
    add(`Agent Output Mapping (colour pass): ${m?.name || om.mappingId}`,
      ['Writes the per-agent RGBA buffer. Runs on the CPU on every compile target.'],
      buildAgentAbiParams('loop', shape), om.code);
  }
  for (const im of agent.inputMappingCodes ?? []) {
    const m = (model.agentMappings ?? []).find(x => x.id === im.mappingId);
    add(`Agent Input Mapping (brush): ${m?.name || im.mappingId} — once PER PAINTED AGENT`,
      ['A single-agent function; the brush colour arrives ahead of these arguments.'],
      buildAgentAbiParams('input', shape), im.code);
  }
  if (parts.length === 0) return '';
  return [banner('COMPILED AGENT FUNCTIONS'), ...parts].join('\n');
}

function sectionCompiled(model: CAModel, result: CompileResult): string {
  const parts: string[] = [banner('COMPILED FUNCTIONS')];
  parts.push(comment([
    'Each is a self-contained JS expression evaluating to a function. The loop over',
    'cells is INSIDE (call it once per generation, not once per cell) — except the',
    'input-mapping functions, which are called once per painted cell.',
  ]));

  const loop = buildLoopParams(model).params;
  const om = buildOutputMappingParams(model);
  const cell = buildCellParams(model);

  if (result.stepCode) {
    parts.push([
      '',
      banner('Step function — the rule, once per generation'),
      comment(signatureBlock('arguments, in order:', loop, model)),
      result.stepCode,
    ].join('\n'));
  }
  if (result.initCode) {
    parts.push([
      '',
      banner('Init Event — once per cell, on Reset'),
      comment(['same argument list as the step function.']),
      result.initCode,
    ].join('\n'));
  }
  if (result.gridInitCode) {
    parts.push([
      '',
      banner('Grid Init Event — ONCE globally, on Reset'),
      comment(['same argument list as the step function; there is no per-cell loop.']),
      result.gridInitCode,
    ].join('\n'));
  }
  for (const ic of result.inputColorCodes ?? []) {
    const m = model.mappings.find(mp => mp.id === ic.mappingId);
    parts.push([
      '',
      banner(`Input Mapping (brush): ${m?.name || ic.mappingId} — once PER PAINTED CELL`),
      comment(signatureBlock('arguments, in order:', cell, model).concat([
        '',
        'plus the brush colour: the emitted function takes (_r, _g, _b) ahead of these.',
      ])),
      ic.code,
    ].join('\n'));
  }
  for (const omc of result.outputMappingCodes ?? []) {
    const m = model.mappings.find(mp => mp.id === omc.mappingId);
    parts.push([
      '',
      banner(`Output Mapping (colour pass): ${m?.name || omc.mappingId}`),
      comment(signatureBlock('arguments, in order:', om, model)),
      omc.code,
    ].join('\n'));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Build the whole port-ready document. */
export function buildModelDocument(model: CAModel, result: CompileResult, opts: DocOptions = {}): string {
  const sections = [
    sectionOverview(model, opts),
    sectionIndexing(model),
    sectionCellAttributes(model),
    sectionModelAttributes(model, opts),
    sectionLookupTables(model),
    sectionNeighborhoods(model),
    sectionNeighborIndexCodec(model),
    sectionVariegation(model),
    sectionColorAndViewers(model, opts),
    sectionRandom(),
    sectionIndicators(model),
    sectionStopAndEnd(model, result),
    sectionAgents(model),
    sectionDriver(model, result),
    sectionCompiled(model, result),
    opts.agent && isAgentModel(model) ? sectionAgentCompiled(model, opts.agent) : '',
  ].filter(Boolean);
  return sections.join('\n\n');
}
