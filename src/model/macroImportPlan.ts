import type {
  Attribute, CAModel, FaceLabelPalette, FacePattern, GraphEdge, GraphNode, Indicator,
  LookupKeySource, MacroDef, MacroFile, MacroOrigin, MacroReferenceBundle, Mapping,
  Neighborhood, SpriteAsset, Variable,
} from './types';
import type {
  BundleSpace, CollectedReference, ElementSpace, ReferenceElement, ReferenceKeySpace,
} from './macroReferences';
import { REFERENCE_KEYS, collectMacroReferences, resolveElement } from './macroReferences';
import { cloneMacroWithFreshIds } from './macroImport';
import { remapNestedMacroRefs } from '../modeler/vpl/graphClipboard';
import { resolveMaxBonds } from './centerBased';

/**
 * Macro IMPORT resolution (M2) — the other half of `macroReferences.ts`.
 *
 * A `.gcamacro` carries the model elements its nodes reference (M1). Importing
 * it into ANOTHER model asks, per unresolved element: **Import as new · Remap to
 * existing · Discard** — and then rewrites the macro's subgraph so every id in
 * it names something in the TARGET model.
 *
 * Everything here is PURE (no DOM, no reducer, no React), so the Node harness
 * drives the shipped code rather than a copy of it. The rewrite returns new defs
 * PLUS the final-id elements, so the caller dispatches ONE atomic action with
 * both halves in the same tick and never reads state back.
 *
 * THE THREE PASSES (D7). Two of the three reference carriers are not config
 * VALUES, and a rewrite that walks `Object.entries(config)` and stops there
 * looks perfectly healthy while silently dropping a bond's initial value — no
 * badge, no compile error, no console line:
 *   1. config VALUES  — `attributeId: 'attr_3'`
 *   2. config KEYS    — `_port_bondAttr_<attrId>`
 *   3. edge HANDLES   — `input_value_bondAttr_<attrId>`
 *
 * THE FOURTH PASS (D8) is not about ids at all: a macro also stores values that
 * are only meaningful RELATIVE to an element — a tag OPTION INDEX, a
 * neighbourhood tag NAME, an indicator CATEGORY, a face LABEL. A remap changes
 * which element an id names, so those are re-derived **by NAME**; where a source
 * name has no counterpart in the target the stored value is LEFT ALONE and
 * REPORTED. Never clamped to 0, never dropped — a wrong-but-plausible tag value
 * is the worst possible outcome, while an out-of-range index renders as an
 * unselected dropdown and an unknown tag name is already badged.
 */

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Mirrors `ModelContext`'s own `generateId`. NEVER counter-based: counters
 *  collide across a reload, which is exactly what an import must not do. */
function generateId(prefix: string): string {
  const base = prefix.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return `${base || 'item'}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type ImportAction = 'new' | 'remap' | 'discard';

export interface RemapCandidate {
  id: string;
  name: string;
  /** One-line "why this is a plausible target" (type / kind), for the dropdown. */
  detail: string;
}

export interface ImportRow {
  /** The element id exactly as it appears in the macro's configs. */
  id: string;
  space: ElementSpace;
  name: string;
  /** The carried element, VERBATIM. Absent ⇒ the file does not carry it, so the
   *  only possible outcome is Discard (today's dangling behaviour). */
  element?: ReferenceElement;
  carried: boolean;
  action: ImportAction;
  /** The chosen remap target's id, when `action === 'remap'`. */
  remapTargetId?: string;
  /** Same-space, type-COMPATIBLE elements of the target model. Empty ⇒ Remap is
   *  offered disabled with its reason (an enabled control must do something). */
  candidates: RemapCandidate[];
  /** An exact name + compatible type match, when one exists — the DEFAULT, and
   *  always rendered as a suggestion, never applied silently. */
  suggestionId?: string;
  directFrom: string[];
  directCount: number;
  requiredBy: string[];
  requiredVia: string[];
  bytes: number;
  /** Capability / topology mismatch — the element imports anyway and is inert
   *  until the layer is enabled (D12: warn, never block). */
  inertWarning?: string;
  /** Why only Discard is possible, when `carried` is false. */
  blockedReason?: string;
}

export interface ResolvedReference {
  id: string;
  name: string;
  space: ElementSpace;
}

export interface ImportPlan {
  macroName: string;
  /** The top-level def FIRST, then every nested def, already cloned with fresh
   *  ids (which also runs the node migrations) and cross-remapped so a nested
   *  macro instance names its freshly-imported def. */
  defs: MacroDef[];
  rows: ImportRow[];
  /** References the target model ALREADY has — summarised, never asked about.
   *  Zero rows ⇒ no dialog, and the import is exactly today's. */
  resolved: ResolvedReference[];
  origin?: MacroOrigin;
}

export interface AppliedImport {
  /** The rewritten defs — values, keys, edge handles and tag indices. */
  defs: MacroDef[];
  /** ONLY the "import as new" elements, already carrying their final ids. */
  elements: MacroReferenceBundle;
  /** Everything a remap could not carry over by name, plus the parameter-key
   *  mismatches — reported after the import, never guessed at. */
  notices: string[];
  counts: { imported: number; remapped: number; discarded: number };
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/** Where a reference collected under a key space lives when the file does NOT
 *  carry it (so there is no bundle list to read the space off). Display only —
 *  such a row is locked to Discard. */
const DEFAULT_SPACE: Record<ReferenceKeySpace, ElementSpace> = {
  attribute: 'attributes',
  neighborhood: 'neighborhoods',
  mapping: 'mappings',
  indicator: 'indicators',
  variable: 'variables',
  sprite: 'sprites',
  facePalette: 'facePalettes',
  facePattern: 'facePatterns',
  preset: 'presets',
};

/** The target model's list for a space. `facePalettes` / `facePatterns` live
 *  inside `variegatedCells`, which is why the import MERGES that object rather
 *  than appending to a top-level list (F6 — palettes have no ADD_* action). */
export function modelListFor(model: CAModel, space: ElementSpace): ReferenceElement[] {
  switch (space) {
    case 'attributes': return model.attributes ?? [];
    case 'agentAttributes': return model.agentAttributes ?? [];
    case 'bondAttributes': return model.bondAttributes ?? [];
    case 'neighborhoods': return model.neighborhoods ?? [];
    case 'mappings': return model.mappings ?? [];
    case 'agentMappings': return model.agentMappings ?? [];
    case 'variables': return model.variables ?? [];
    case 'agentVariables': return model.agentVariables ?? [];
    case 'indicators': return model.indicators ?? [];
    case 'sprites': return model.sprites ?? [];
    case 'facePalettes': return model.variegatedCells?.facePalettes ?? [];
    case 'facePatterns': return model.variegatedCells?.facePatterns ?? [];
    case 'presets': return model.presets ?? [];
  }
}

/** A CAModel-shaped VIEW of a reference bundle, so the one collection engine can
 *  resolve the macro's ids against the FILE exactly as it resolves them against
 *  a model — including the transitive closure between carried elements. */
function bundleAsModel(bundle: MacroReferenceBundle): CAModel {
  return {
    attributes: bundle.attributes ?? [],
    agentAttributes: bundle.agentAttributes ?? [],
    bondAttributes: bundle.bondAttributes ?? [],
    neighborhoods: bundle.neighborhoods ?? [],
    mappings: bundle.mappings ?? [],
    agentMappings: bundle.agentMappings ?? [],
    variables: bundle.variables ?? [],
    agentVariables: bundle.agentVariables ?? [],
    indicators: bundle.indicators ?? [],
    sprites: bundle.sprites ?? [],
    variegatedCells: {
      enabled: false, sourceAttributeId: '',
      facePalettes: bundle.facePalettes ?? [],
      facePatterns: bundle.facePatterns ?? [],
    },
    presets: [],
  } as unknown as CAModel;
}

// ---------------------------------------------------------------------------
// Type compatibility (D10) — "compatible" is per space, and it is what decides
// both the suggestion and which candidates the Remap dropdown may offer.
// ---------------------------------------------------------------------------

export function compatible(space: ElementSpace, a: ReferenceElement, b: ReferenceElement): boolean {
  switch (space) {
    case 'attributes':
    case 'agentAttributes':
    case 'bondAttributes': {
      const x = a as Attribute, y = b as Attribute;
      // `isModelAttribute` is a real semantic split inside ONE list (a model
      // attribute is a global parameter, a cell attribute is per-cell state).
      return x.type === y.type && !!x.isModelAttribute === !!y.isModelAttribute;
    }
    case 'mappings':
    case 'agentMappings':
      return !!(a as Mapping).isAttributeToColor === !!(b as Mapping).isAttributeToColor;
    case 'variables':
    case 'agentVariables': {
      const x = a as Variable, y = b as Variable;
      return x.kind === y.kind && x.dataType === y.dataType;
    }
    case 'indicators':
      return (a as Indicator).kind === (b as Indicator).kind;
    // Neighborhoods, sprites, palettes and patterns carry no type discriminator.
    default:
      return true;
  }
}

/** The dropdown's one-line "what is this" — read off the object itself, so
 *  there is nothing to drift when a schema field is added. */
export function candidateDetail(space: ElementSpace, el: ReferenceElement): string {
  switch (space) {
    case 'attributes':
    case 'agentAttributes':
    case 'bondAttributes': {
      const a = el as Attribute;
      return a.type === 'tag' ? `tag (${a.tagOptions?.length ?? 0})` : a.type;
    }
    case 'mappings':
    case 'agentMappings':
      return (el as Mapping).isAttributeToColor ? 'A→C' : 'C→A';
    case 'variables':
    case 'agentVariables': {
      const v = el as Variable;
      return `${v.kind} · ${v.dataType}`;
    }
    case 'indicators': return (el as Indicator).kind;
    case 'neighborhoods': {
      const n = el as Neighborhood;
      return `${(n.coords3d?.length ?? n.coords?.length ?? 0)} cells`;
    }
    case 'facePalettes': return `${(el as FaceLabelPalette).labels?.length ?? 0} labels`;
    case 'sprites': return (el as SpriteAsset).mimeType ?? 'sprite';
    default: return '';
  }
}

/** Capability / topology gating (D12) — the element imports ANYWAY; this is the
 *  sentence the dialog shows so the inertness is not a surprise. */
function inertWarningFor(model: CAModel, space: ElementSpace): string | undefined {
  switch (space) {
    case 'bondAttributes':
      return resolveMaxBonds(model.centerBased) > 0
        ? undefined
        : 'inert until Properties → Bond-Graph Agents → Bonds is enabled';
    case 'agentAttributes':
    case 'agentMappings':
    case 'agentVariables':
      return model.topologyMode?.agents
        ? undefined
        : 'inert until Properties → Bond-Graph Agents is enabled';
    case 'facePalettes':
    case 'facePatterns':
      return model.variegatedCells?.enabled
        ? undefined
        : 'inert until Properties → Variegated Cells is enabled';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// planImport
// ---------------------------------------------------------------------------

function firstResolve(model: CAModel, id: string, keySpaces: ReferenceKeySpace[]) {
  for (const ks of keySpaces) {
    const hit = resolveElement(model, id, ks);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Work out, per referenced element, whether the TARGET model already has it and
 * — when it does not — what the user's options are.
 *
 * The defs are cloned here (fresh ids + the node migrations) so the plan carries
 * exactly the defs the rewrite will operate on. Cancelling costs nothing: the
 * clone is dropped and nothing was dispatched.
 */
export function planImport(file: MacroFile, model: CAModel): ImportPlan {
  // --- 1. Clone every def, then retarget the nested macro instances -------
  const rawDefs: MacroDef[] = [file.macroDef, ...(file.macroDefs ?? [])];
  const defIdMap = new Map<string, string>();
  const cloned = rawDefs.map(d => {
    const c = cloneMacroWithFreshIds(d);
    defIdMap.set(d.id, c.id);
    return c;
  });
  // F1 — a `macro` instance inside a def still names the OLD def id; the clone
  // only retargets `macroInput`/`macroOutput` boundary nodes at their own def.
  const defs = cloned.map(d => remapNestedMacroRefs(d, defIdMap));

  // --- 2. Collect the references against the FILE's own bundle -------------
  // Resolving against a bundle-shaped model gives, in one pass: which ids the
  // file carries, which it does not, the space each carried element belongs to,
  // and the closure metadata the dialog shows ("pulled in by X → Y").
  const bundle = file.references ?? {};
  const collected = collectMacroReferences(defs, bundleAsModel(bundle));

  const rows: ImportRow[] = [];
  const resolved: ResolvedReference[] = [];
  const seen = new Set<string>();

  const addRow = (
    id: string, space: ElementSpace, element: ReferenceElement | undefined,
    meta: Pick<CollectedReference, 'directFrom' | 'directCount' | 'requiredBy' | 'requiredVia' | 'bytes'>,
    blockedReason?: string,
  ) => {
    const name = (element as { name?: string } | undefined)?.name || id;
    const candidates: RemapCandidate[] = element
      ? modelListFor(model, space)
        .filter(t => compatible(space, element, t))
        .map(t => ({ id: t.id, name: (t as { name?: string }).name || t.id, detail: candidateDetail(space, t) }))
      : [];
    const lower = name.trim().toLowerCase();
    const suggestion = candidates.find(c => c.name === name) ?? candidates.find(c => c.name.trim().toLowerCase() === lower);
    rows.push({
      id, space, name, element, carried: !!element,
      action: element ? (suggestion ? 'remap' : 'new') : 'discard',
      remapTargetId: suggestion?.id,
      candidates,
      suggestionId: suggestion?.id,
      directFrom: meta.directFrom, directCount: meta.directCount,
      requiredBy: meta.requiredBy, requiredVia: meta.requiredVia, bytes: meta.bytes,
      inertWarning: element ? inertWarningFor(model, space) : undefined,
      blockedReason,
    });
  };

  for (const ref of collected.refs) {
    seen.add(ref.id);
    // Already in the target ⇒ resolved. Not a row (D10) — which is what makes a
    // re-import into the source model a provable no-op.
    const inTarget = firstResolve(model, ref.id, ref.keySpaces);
    if (inTarget) {
      resolved.push({ id: ref.id, name: (inTarget.element as { name?: string }).name || ref.id, space: inTarget.space });
      continue;
    }
    const space = ref.space ?? DEFAULT_SPACE[ref.keySpaces[0] ?? 'attribute'];
    const blocked = ref.element
      ? undefined
      : ref.keySpaces.includes('preset')
        ? 'presets export separately as .gcapreset — this reference will dangle'
        : 'not carried by this file — this reference will dangle';
    addRow(ref.id, space, ref.element, ref, blocked);
  }

  // A hand-edited file may carry an element nothing in the subgraph names. It is
  // still an element the user may want, so it gets a row rather than vanishing.
  for (const [space, list] of Object.entries(bundle) as [BundleSpace, ReferenceElement[] | undefined][]) {
    for (const el of list ?? []) {
      if (seen.has(el.id)) continue;
      seen.add(el.id);
      if (modelListFor(model, space).some(t => t.id === el.id)) {
        resolved.push({ id: el.id, name: (el as { name?: string }).name || el.id, space });
        continue;
      }
      addRow(el.id, space, el, { directFrom: [], directCount: 0, requiredBy: [], requiredVia: [], bytes: 0 });
    }
  }

  return { macroName: file.macroDef.name || file.name, defs, rows, resolved, origin: file.origin };
}

// ---------------------------------------------------------------------------
// Remap warnings the DIALOG shows live (they depend on the chosen target)
// ---------------------------------------------------------------------------

/** Tag options that exist in the source element but NOT in the remap target —
 *  every stored index naming one of them is left as-is and reported (D8). */
export function unmatchedTagOptions(source: ReferenceElement, target: ReferenceElement): string[] {
  const a = (source as Attribute).tagOptions, b = (target as Attribute).tagOptions;
  if (!a || !b) return [];
  const have = new Set(b);
  return a.filter(o => !have.has(o));
}

/**
 * Everything a remap onto THIS target cannot carry over. Shown per row while the
 * user picks, and repeated in the post-import notices. Never blocks (D7/D8/D12).
 */
export function remapWarnings(space: ElementSpace, source: ReferenceElement, target: ReferenceElement): string[] {
  const out: string[] = [];
  switch (space) {
    case 'attributes':
    case 'agentAttributes':
    case 'bondAttributes': {
      const a = source as Attribute, b = target as Attribute;
      if (a.type === 'tag') {
        const missing = unmatchedTagOptions(a, b);
        const reordered = (a.tagOptions ?? []).some((o, i) => b.tagOptions?.[i] !== o);
        if (missing.length > 0) {
          out.push(`tag options remapped by NAME — ${missing.map(m => `“${m}”`).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no counterpart and ${missing.length === 1 ? 'is' : 'are'} left as-is`);
        } else if (reordered) {
          out.push('the target’s tag options are in a different order — indices are remapped by NAME');
        }
      }
      if (a.type === 'lookupTable') {
        const dims = (x: Attribute) => (x.axes?.length ?? (x.rowKeySource || x.colKeySource ? 2 : 0));
        if (dims(a) !== dims(b)) out.push(`the target lookup table has ${dims(b)} axes, this one has ${dims(a)}`);
      }
      return out;
    }
    case 'mappings':
    case 'agentMappings': {
      // D7's mirror case: an input mapping's value outputs are keyed by PARAMETER
      // KEY, so a target declaring a different set leaves those edges stale. The
      // standing rule is DROP stale edges, never repoint them — so this warns and
      // the compile gate names what broke.
      const a = source as Mapping, b = target as Mapping;
      if (a.isAttributeToColor) return out;
      const ak = (a.parameters ?? []).map(p => p.key).sort().join('|');
      const bk = (b.parameters ?? []).map(p => p.key).sort().join('|');
      if (ak !== bk) out.push('the target declares different input-mapping parameters — wires into the removed channels will be reported by the compile gate');
      return out;
    }
    case 'neighborhoods': {
      const a = source as Neighborhood, b = target as Neighborhood;
      const have = new Set(Object.values(b.tags ?? {}));
      const missing = [...new Set(Object.values(a.tags ?? {}))].filter(t => t && !have.has(t));
      if (missing.length > 0) out.push(`the target has no tag named ${missing.map(m => `“${m}”`).join(', ')} — Get Neighbor By Tag will badge`);
      return out;
    }
    case 'facePalettes': {
      const a = source as FaceLabelPalette, b = target as FaceLabelPalette;
      const have = new Set(b.labels ?? []);
      const missing = (a.labels ?? []).filter(l => !have.has(l));
      if (missing.length > 0) out.push(`the target palette has no label ${missing.map(m => `“${m}”`).join(', ')} — stored face labels are left as-is`);
      return out;
    }
    case 'indicators': {
      const a = source as Indicator, b = target as Indicator;
      if (a.trackedValues && b.trackedValues) {
        const have = new Set(b.trackedValues);
        const missing = a.trackedValues.filter(c => !have.has(c));
        if (missing.length > 0) out.push(`the target tracks different categories — ${missing.map(m => `“${m}”`).join(', ')} not among them`);
      }
      return out;
    }
    default:
      return out;
  }
}

// ---------------------------------------------------------------------------
// applyImportPlan — the rewrite
// ---------------------------------------------------------------------------

/** `attr_0`, `attr_1`, … — the multi-attribute slots and `moveSelfToNeighbor`'s
 *  payload slots, matched exactly as the collection engine matches them. */
const SLOT_ATTR_KEY = /^attr_(\d+)$/;
const PORT_BOND_ATTR_KEY = /^_port_bondAttr_(.+)$/;
const EDGE_BOND_ATTR_HANDLE = /^(input_value_bondAttr_)(.+)$/;

/** Node types whose `_port_value` (and, multi-slot, `_port_value_<i>`) holds a
 *  TAG INDEX into the attribute the node writes. Written from the enumerated
 *  table of D8, deliberately NOT copied from one of `ModelContext`'s three
 *  parallel cascades — their coverage is asymmetric (F2b.2). */
const TAG_VALUE_SETTERS = new Set([
  'setAttribute', 'updateAttribute', 'setNeighborhoodAttribute',
  'setNeighborAttributeByIndex', 'setBondAttribute',
]);

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const first = `${base} (imported)`;
  if (!taken.has(first)) return first;
  for (let i = 2; ; i++) {
    const candidate = `${base} (imported ${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

function remapKeySource(src: LookupKeySource | undefined, idMap: Map<string, string>): LookupKeySource | undefined {
  if (!src) return src;
  if (src.kind === 'tagAttribute') {
    const next = idMap.get(src.attributeId);
    return next ? { ...src, attributeId: next } : src;
  }
  if (src.kind === 'facePalette') {
    const next = idMap.get(src.paletteId);
    return next ? { ...src, paletteId: next } : src;
  }
  return src;
}

/**
 * Rewrite an IMPORTED element's own element→element references through the id
 * map, so a sub-attribute imported alongside its parent points at the NEW parent
 * — the mirror of the closure that collected it (D5).
 */
function rewriteElementRefs(el: ReferenceElement, space: ElementSpace, idMap: Map<string, string>): ReferenceElement {
  const map = (id: string | undefined) => (id ? idMap.get(id) ?? id : id);
  switch (space) {
    case 'attributes':
    case 'agentAttributes':
    case 'bondAttributes': {
      const a = { ...(el as Attribute) };
      a.parentAttributeId = map(a.parentAttributeId);
      a.neighborhoodHintId = map(a.neighborhoodHintId);
      a.valueTagAttributeId = map(a.valueTagAttributeId);
      a.rowKeySource = remapKeySource(a.rowKeySource, idMap);
      a.colKeySource = remapKeySource(a.colKeySource, idMap);
      if (a.axes) a.axes = a.axes.map(ax => ({ ...ax, source: remapKeySource(ax.source, idMap)! }));
      if (a.facePatternAssignments) {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(a.facePatternAssignments)) next[k] = map(v) ?? v;
        a.facePatternAssignments = next;
      }
      return a;
    }
    case 'mappings':
    case 'agentMappings': {
      const m = { ...(el as Mapping) };
      m.linkedAttributeId = map(m.linkedAttributeId);
      if (m.parameters) m.parameters = m.parameters.map(p => ({ ...p, tagAttributeId: map(p.tagAttributeId) }));
      return m;
    }
    case 'indicators': {
      const i = { ...(el as Indicator) };
      i.linkedAttributeId = map(i.linkedAttributeId);
      return i;
    }
    case 'variables':
    case 'agentVariables': {
      const v = { ...(el as Variable) };
      v.attributeId = map(v.attributeId);
      return v;
    }
    case 'facePatterns': {
      const p = { ...(el as FacePattern) };
      p.paletteId = map(p.paletteId) ?? p.paletteId;
      return p;
    }
    default:
      return { ...(el as object) } as ReferenceElement;
  }
}

/** A tag attribute that was REMAPPED: every stored index into its options has to
 *  be re-derived by NAME. Keyed by the attribute's id AFTER the id rewrite, so
 *  the tag pass runs on already-retargeted configs. */
interface TagRemap {
  /** The TARGET attribute's id — what the configs name after pass 1/2/3. */
  newId: string;
  indexMap: Map<number, number>;
  unmatched: string[];
  sourceName: string;
  targetName: string;
}

function tagIndexRemap(source: Attribute, target: Attribute): { indexMap: Map<number, number>; unmatched: string[] } {
  const indexMap = new Map<number, number>();
  const unmatched: string[] = [];
  (source.tagOptions ?? []).forEach((opt, oi) => {
    const ni = (target.tagOptions ?? []).indexOf(opt);
    if (ni >= 0) indexMap.set(oi, ni);
    else unmatched.push(opt);
  });
  return { indexMap, unmatched };
}

/** Re-derive one stored tag index. An index with no counterpart is returned
 *  UNCHANGED — never clamped, never dropped (D8). */
function remapIndexValue(raw: unknown, indexMap: Map<number, number>): unknown {
  if (typeof raw !== 'string' && typeof raw !== 'number') return raw;
  const oi = Number(raw);
  if (!Number.isInteger(oi)) return raw;
  const ni = indexMap.get(oi);
  return ni === undefined ? raw : String(ni);
}

/**
 * Apply the user's choices: mint ids, clone the elements, and rewrite the defs
 * so every reference in them names something in the TARGET model.
 *
 * Returns both halves, so the caller dispatches ONE action carrying the final
 * ids — no read-back from state, no half-imported model.
 */
export function applyImportPlan(plan: ImportPlan, model: CAModel): AppliedImport {
  const idMap = new Map<string, string>();
  const notices: string[] = [];
  const counts = { imported: 0, remapped: 0, discarded: 0 };
  const elements: MacroReferenceBundle = {};
  const tagRemaps: TagRemap[] = [];
  /** Names already taken in each target space, so an import-as-new never
   *  silently shadows an element the user declined to remap onto. */
  const takenNames = new Map<ElementSpace, Set<string>>();
  const namesFor = (space: ElementSpace) => {
    let s = takenNames.get(space);
    if (!s) {
      s = new Set(modelListFor(model, space).map(e => (e as { name?: string }).name ?? ''));
      takenNames.set(space, s);
    }
    return s;
  };

  // --- Pass 0: decide every final id BEFORE anything is rewritten ---------
  const staged: { row: ImportRow; el: ReferenceElement }[] = [];
  for (const row of plan.rows) {
    if (row.action === 'new' && row.element) {
      const names = namesFor(row.space);
      const name = uniqueName((row.element as { name?: string }).name ?? row.id, names);
      names.add(name);
      const newId = generateId(row.space.replace(/s$/, ''));
      idMap.set(row.id, newId);
      // DEEP clone — the element came out of a parsed file, and the rewrite
      // below assigns into nested arrays (`parentValues`, `axes`).
      const clone = JSON.parse(JSON.stringify(row.element)) as ReferenceElement;
      staged.push({ row, el: { ...(clone as object), id: newId, name } as ReferenceElement });
      counts.imported++;
    } else if (row.action === 'remap' && row.remapTargetId && row.element) {
      idMap.set(row.id, row.remapTargetId);
      counts.remapped++;
      const target = modelListFor(model, row.space).find(t => t.id === row.remapTargetId);
      if (target) {
        for (const w of remapWarnings(row.space, row.element, target)) {
          notices.push(`${row.name} → ${(target as { name?: string }).name ?? row.remapTargetId}: ${w}`);
        }
        const src = row.element as Attribute;
        if (src.type === 'tag' && (target as Attribute).type === 'tag') {
          const { indexMap, unmatched } = tagIndexRemap(src, target as Attribute);
          tagRemaps.push({
            newId: row.remapTargetId, indexMap, unmatched,
            sourceName: row.name, targetName: (target as { name?: string }).name ?? row.remapTargetId,
          });
        }
      }
    } else {
      // Discard — the id is deliberately absent from `idMap`, so it survives the
      // rewrite untouched and dangles exactly as it does today.
      counts.discarded++;
    }
  }

  // --- Pass 0b: the imported elements' OWN references ---------------------
  for (const { row, el } of staged) {
    const space = row.space as BundleSpace;
    const rewritten = rewriteElementRefs(el, row.space, idMap);
    const list = (elements[space] ??= []) as ReferenceElement[];
    list.push(rewritten);
  }

  // --- Pass 1/2: config VALUES and config KEYS ---------------------------
  const rewriteNode = (n: GraphNode): GraphNode => {
    const cfg = n.data?.config as Record<string, unknown> | undefined;
    if (!cfg) return n;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cfg)) {
      // Pass 2 — the id lives in the KEY. Rename it, preserve the value.
      const bond = PORT_BOND_ATTR_KEY.exec(key);
      if (bond) {
        const mapped = idMap.get(bond[1] ?? '');
        if (mapped) { next[`_port_bondAttr_${mapped}`] = value; changed = true; continue; }
        next[key] = value;
        continue;
      }
      // Pass 1 — a plain id-valued key.
      if (typeof value === 'string' && (REFERENCE_KEYS[key] || SLOT_ATTR_KEY.test(key))) {
        const mapped = idMap.get(value);
        if (mapped) { next[key] = mapped; changed = true; continue; }
      }
      next[key] = value;
    }
    return changed ? { ...n, data: { ...n.data, config: next as GraphNode['data']['config'] } } : n;
  };

  // --- Pass 3: EDGE HANDLES ---------------------------------------------
  const rewriteEdge = (e: GraphEdge): GraphEdge => {
    const m = EDGE_BOND_ATTR_HANDLE.exec(e.targetHandle ?? '');
    if (!m) return e;
    const mapped = idMap.get(m[2] ?? '');
    return mapped ? { ...e, targetHandle: `${m[1]}${mapped}` } : e;
  };

  let defs = plan.defs.map(d => ({
    ...d,
    nodes: d.nodes.map(rewriteNode),
    edges: d.edges.map(rewriteEdge),
  }));

  // --- Pass 4: the values that are only meaningful RELATIVE to an element --
  if (tagRemaps.length > 0) {
    defs = defs.map(d => ({ ...d, nodes: d.nodes.map(n => applyTagRemaps(n, tagRemaps)) }));
    for (const t of tagRemaps) {
      if (t.unmatched.length > 0) {
        notices.push(`${t.sourceName} → ${t.targetName}: ${t.unmatched.map(o => `“${o}”`).join(', ')} left as stored (no counterpart in the target’s options)`);
      }
    }
    // The same indices live INSIDE imported elements: a sub-attribute's
    // `parentValues` index its (possibly remapped) parent's options, and a tag
    // variable's `initialValue` indexes its attribute's.
    remapElementTagValues(elements, idMap, tagRemaps);
  }

  return { defs, elements, notices, counts };
}

/** The D8 carriers, enumerated. `attrId` here is the id the config names AFTER
 *  the id rewrite — i.e. the remap TARGET's id. */
function applyTagRemaps(n: GraphNode, remaps: TagRemap[]): GraphNode {
  const cfg = n.data?.config as Record<string, unknown> | undefined;
  if (!cfg) return n;
  const nodeType = n.data?.nodeType as string;
  let out: Record<string, unknown> | null = null;
  const write = (key: string, value: unknown) => {
    if (!out) out = { ...cfg };
    out[key] = value;
  };

  for (const { newId, indexMap } of remaps) {
    if (indexMap.size === 0) continue;
    const R = (v: unknown) => remapIndexValue(v, indexMap);

    if (nodeType === 'getConstant' && cfg.constType === 'tag' && cfg.tagAttributeId === newId) {
      write('constValue', R(cfg.constValue));
    }
    if (nodeType === 'switch' && cfg.valueType === 'tag' && cfg.tagAttributeId === newId) {
      const cc = Number(cfg.caseCount) || 0;
      for (let i = 0; i < cc; i++) {
        const key = `case_${i}_value`;
        if (cfg[key] !== undefined) write(key, R(cfg[key]));
      }
    }
    if (nodeType === 'statement' && cfg.compareType === 'tag' && cfg.tagAttributeId === newId) {
      for (const key of ['_port_x', '_port_y', '_port_y2']) {
        if (cfg[key] !== undefined) write(key, R(cfg[key]));
      }
    }
    if (TAG_VALUE_SETTERS.has(nodeType)) {
      if (cfg.attributeId === newId && cfg._port_value !== undefined) write('_port_value', R(cfg._port_value));
      // Multi-attribute slots: slot i's attribute is `attr_i`, its inline value
      // `_port_value_i`.
      for (const [key, value] of Object.entries(cfg)) {
        const slot = SLOT_ATTR_KEY.exec(key);
        if (!slot || value !== newId) continue;
        const vk = `_port_value_${slot[1]}`;
        if (cfg[vk] !== undefined) write(vk, R(cfg[vk]));
      }
    }
    // Form / Rewire Bond's per-bond-attribute initial value — the KEY was already
    // retargeted by pass 2, so it is the NEW id we look for here.
    const bondKey = `_port_bondAttr_${newId}`;
    if (cfg[bondKey] !== undefined) write(bondKey, R(cfg[bondKey]));
    // P5 — Divide Agent's per-option daughter table is keyed BY OPTION INDEX, so
    // a differently-ordered target must PERMUTE it, not merely re-read it.
    if (nodeType === 'divideAgent' && cfg.partitionAttributeId === newId) {
      const src = out ?? cfg;
      const moved: Record<string, unknown> = {};
      const drop: string[] = [];
      for (const key of Object.keys(src)) {
        if (!key.startsWith('partTag_')) continue;
        const oi = Number(key.slice('partTag_'.length));
        drop.push(key);
        const ni = indexMap.get(oi);
        // An option with no counterpart keeps its ORIGINAL slot rather than
        // being silently reassigned to a different daughter.
        moved[`partTag_${ni ?? oi}`] = src[key];
      }
      if (drop.length > 0) {
        if (!out) out = { ...cfg };
        for (const key of drop) delete out[key];
        for (const [k, v] of Object.entries(moved)) out[k] = v;
      }
    }
  }
  return out ? { ...n, data: { ...n.data, config: out as GraphNode['data']['config'] } } : n;
}

/** Tag indices stored INSIDE the elements being imported, whose meaning depends
 *  on an element that was REMAPPED rather than imported alongside them. */
function remapElementTagValues(
  elements: MacroReferenceBundle, idMap: Map<string, string>, remaps: TagRemap[],
): void {
  void idMap;
  const byNewId = new Map(remaps.map(r => [r.newId, r]));
  for (const space of ['attributes', 'agentAttributes', 'bondAttributes'] as const) {
    for (const a of (elements[space] ?? []) as Attribute[]) {
      // `parentAttributeId` has ALREADY been rewritten by `rewriteElementRefs`,
      // so it names the target id directly.
      const r = a.parentAttributeId ? byNewId.get(a.parentAttributeId) : undefined;
      if (r && a.parentValues) a.parentValues = a.parentValues.map(v => String(remapIndexValue(v, r.indexMap)));
    }
  }
  for (const space of ['variables', 'agentVariables'] as const) {
    for (const v of (elements[space] ?? []) as Variable[]) {
      const r = v.attributeId ? byNewId.get(v.attributeId) : undefined;
      if (r && v.dataType === 'tag') v.initialValue = String(remapIndexValue(v.initialValue, r.indexMap));
    }
  }
}

/**
 * True when the plan needs the USER — i.e. at least one row where more than one
 * outcome is possible (D10).
 *
 * A row for a reference the file does NOT carry offers only Discard, so a file
 * made entirely of those (every pre-M1 `.gcamacro`, the four shipped ones
 * included) opens no dialog and imports on exactly the path it always did,
 * dangling ids and amber badges and all. Such rows are still SHOWN once the
 * dialog is open for something else, so the user learns why a node arrived
 * unwired — they just never open it on their own.
 */
export function planNeedsDialog(plan: ImportPlan): boolean {
  return plan.rows.some(r => r.carried);
}
