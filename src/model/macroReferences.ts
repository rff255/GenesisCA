import type {
  Attribute, CAModel, FaceLabelPalette, FacePattern, GraphEdge, GraphNode, Indicator,
  LookupKeySource, MacroDef, MacroOrigin, MacroReferenceBundle, Mapping, Neighborhood,
  Preset, SpriteAsset, Variable,
} from './types';
import { KEY_SPACE } from '../modeler/vpl/compiler/danglingRefs';
import { CURRENT_VIEWER_SENTINEL } from '../modeler/vpl/nodes/SetCellLooksNode';
import { collectMacroDefBundle } from '../modeler/vpl/graphClipboard';
import { getNodeDef } from '../modeler/vpl/nodes/registry';

/**
 * Macro reference collection — which MODEL ELEMENTS a macro's subgraph names.
 *
 * A macro is the only way to move a piece of rule logic between models, but its
 * nodes are full of ids (`attributeId`, `neighborhoodId`, `mappingId`, …) that
 * name elements of the SOURCE model. In any other model those ids resolve to
 * nothing: the node arrives wired to a ghost, badged amber, and the user
 * re-points it by hand. This module is the first half of the fix — it works out
 * exactly what a macro references, so a `.gcamacro` can CARRY those elements.
 *
 * Everything here is PURE (no DOM, no reducer, no React), so the Node harness
 * drives the shipped code rather than a copy of it.
 *
 * The three carriers of a reference, all of which are collected:
 *   1. a config VALUE under a known key (`attributeId: 'attr_3'`);
 *   2. a config KEY with the id embedded in it (`_port_bondAttr_<attrId>`);
 *   3. an EDGE HANDLE with the id embedded in it (`input_value_bondAttr_<id>`).
 * A value scan alone — which is what the compile gate `detectDanglingRefs` does
 * — sees only the first.
 */

// ---------------------------------------------------------------------------
// The key registry
// ---------------------------------------------------------------------------

/** The id space a config key may name. A SUPERSET of `danglingRefs`' own
 *  `IdSpace`: `facePalette` / `preset` are spaces the compile gate deliberately
 *  does not check, and `facePattern` is reachable only through the closure. */
export type ReferenceKeySpace =
  | 'attribute' | 'neighborhood' | 'mapping' | 'indicator' | 'variable' | 'sprite'
  | 'facePalette' | 'facePattern' | 'preset';

/**
 * Config keys whose VALUE is a model-element id.
 *
 * EXTENDS the compile gate's own `KEY_SPACE` — spread first, so a key added
 * there is picked up here automatically and the shared half cannot drift. The
 * three additions are references the gate deliberately does not police (see the
 * comment on `KEY_SPACE`).
 *
 * `macroDefId` is deliberately ABSENT: a macro def is not a model element. It
 * rides `MacroFile.macroDefs` and is collected by `collectMacroDefBundle`.
 */
export const REFERENCE_KEYS: Record<string, ReferenceKeySpace> = {
  ...KEY_SPACE,
  /** Get Agents In View / Sense Hemifield with `headingSource: 'facing'`. */
  facingAttributeId: 'attribute',
  /** Get Constant in `faceLabel` mode. */
  facePaletteId: 'facePalette',
  /** Overseer Load Preset. Collected so the export dialog can SAY it cannot be
   *  carried (`.gcapreset` owns that transport) rather than silently omit it. */
  presetId: 'preset',
};

/** `attr_0`, `attr_1`, … — the multi-attribute slots and `moveSelfToNeighbor`'s
 *  payload slots. Matched by regex, exactly as the compile gate does. */
const SLOT_ATTR_KEY = /^attr_\d+$/;

/** Form Bond / Rewire Bond expose one input port per BOND ATTRIBUTE, and the
 *  port id embeds the attribute id — so the inline value lands at this config
 *  key and any wire into it carries `input_value_bondAttr_<id>`. */
const PORT_BOND_ATTR_KEY = /^_port_bondAttr_(.+)$/;
const EDGE_BOND_ATTR_HANDLE = /^input_value_bondAttr_(.+)$/;

/**
 * Compiler-DERIVED config keys that must never be read as an authoritative
 * reference. None of them currently collides with `REFERENCE_KEYS` (they are
 * matched by exact key name), so this list is defence-in-depth — but it is an
 * EXPLICIT list rather than an "underscore ⇒ derived" rule, because `_port_*`
 * and `_varName_*` are user-authored inline values persisted in the model and
 * `_port_bondAttr_<id>` is one of the three reference carriers above.
 *
 * `_sourceAttrId` is the sharpest of them: it IS an attribute id, but it is a
 * CACHE of `variegatedCells.sourceAttributeId` injected by the pre-resolve pass.
 */
const DERIVED_KEYS = new Set([
  '_sourceAttrId', '_resolvedTagIndex', '_resolvedTagIndexes', '_resolvedPacked',
  '_resolvedDirIdx', '_resolvedDr', '_resolvedDc', '_indicatorIdx', '_stopIdx',
  '_spriteSlot', '_divideIdx', '_tagLen', '_dims', '_mins', '_rowCount', '_colCount',
]);

// ---------------------------------------------------------------------------
// Where an element LIVES
// ---------------------------------------------------------------------------

/** A key of `MacroReferenceBundle` — and, identically, of `CAModel` (or of
 *  `variegatedCells` for the two face spaces). */
export type BundleSpace =
  | 'attributes' | 'agentAttributes' | 'bondAttributes'
  | 'neighborhoods' | 'mappings' | 'agentMappings'
  | 'variables' | 'agentVariables'
  | 'indicators' | 'sprites' | 'facePalettes' | 'facePatterns';

/** Every space an element can be resolved into. `presets` is resolvable but NOT
 *  carryable (a preset embeds a whole SimulationState — `.gcapreset` owns it). */
export type ElementSpace = BundleSpace | 'presets';

export type ReferenceElement =
  | Attribute | Neighborhood | Mapping | Variable | Indicator
  | SpriteAsset | FaceLabelPalette | FacePattern | Preset;

/** Display order for the export/import dialogs — grouped the way the panels are. */
export const SPACE_ORDER: ElementSpace[] = [
  'attributes', 'agentAttributes', 'bondAttributes',
  'neighborhoods', 'mappings', 'agentMappings',
  'variables', 'agentVariables', 'indicators', 'sprites',
  'facePalettes', 'facePatterns', 'presets',
];

export const SPACE_LABEL: Record<ElementSpace, string> = {
  attributes: 'Attributes',
  agentAttributes: 'Agent attributes',
  bondAttributes: 'Bond attributes',
  neighborhoods: 'Neighborhoods',
  mappings: 'Mappings',
  agentMappings: 'Agent mappings',
  variables: 'Local variables',
  agentVariables: 'Agent variables',
  indicators: 'Indicators',
  sprites: 'Sprites',
  facePalettes: 'Face palettes',
  facePatterns: 'Face patterns',
  presets: 'Presets',
};

// ---------------------------------------------------------------------------
// The collected shape
// ---------------------------------------------------------------------------

export interface CollectedReference {
  /** The id exactly as it appears in the macro's configs. */
  id: string;
  /** The key space(s) the reference was collected under, in encounter order. */
  keySpaces: ReferenceKeySpace[];
  /** Which model list it resolved into — `undefined` when the SOURCE model does
   *  not have it either (an already-dangling reference; nothing to carry). */
  space?: ElementSpace;
  /** The element, VERBATIM. `undefined` when unresolved. */
  element?: ReferenceElement;
  /** `element.name` when resolved, else the raw id. */
  name: string;
  /** Labels of the nodes that reference it DIRECTLY. Empty ⇒ pulled in only by
   *  the transitive closure. */
  directFrom: string[];
  /** How many direct references there are (nodes may repeat a label). */
  directCount: number;
  /** Ids of the elements whose closure pulled this one in. */
  requiredBy: string[];
  /** Why the closure pulled it in, parallel to `requiredBy` (for the dialog's
   *  "pulled in by X → sub-attribute parent" line). */
  requiredVia: string[];
  /** Approximate serialized size, in characters of JSON. Only interesting for
   *  sprites, which are the one element that can be megabytes. */
  bytes: number;
  /** False ⇒ this reference will dangle on import no matter what the user
   *  picks: it resolves to nothing in the source model, or it lives in a space
   *  a `.gcamacro` cannot carry (presets). */
  carryable: boolean;
  /** Human-readable reason, when `carryable` is false. */
  blockedReason?: string;
}

export interface CollectedReferences {
  /** Every reference found, in encounter order (direct refs first, then the
   *  elements their closure pulled in). */
  refs: CollectedReference[];
  byId: Map<string, CollectedReference>;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** The defs a macro export must carry: the def itself, plus every def its
 *  subgraph references transitively (F1 — a macro instance can live inside a
 *  macro's subgraph, and the def it names lives only in the source model). */
export function collectMacroExportDefs(def: MacroDef, allDefs: MacroDef[]): MacroDef[] {
  const nested = collectMacroDefBundle(def.nodes, allDefs).filter(d => d.id !== def.id);
  return [def, ...nested];
}

function nodeLabel(n: GraphNode): string {
  const data = n.data as { label?: string; nodeType: string };
  return data.label ?? getNodeDef(data.nodeType)?.label ?? data.nodeType;
}

interface Raw {
  id: string;
  keySpaces: Set<ReferenceKeySpace>;
  directFrom: string[];
  directCount: number;
  requiredBy: string[];
  requiredVia: string[];
}

/**
 * Every model element the given defs reference — the config values, the ids
 * embedded in config KEYS and edge HANDLES, and the transitive closure of
 * element→element references (D5).
 *
 * Pass the WHOLE export set (`collectMacroExportDefs`): a reference used only
 * inside a nested macro is still a reference the file must carry.
 */
export function collectMacroReferences(defs: MacroDef[], model: CAModel): CollectedReferences {
  const raw = new Map<string, Raw>();
  const order: string[] = [];

  const touch = (id: string, keySpace: ReferenceKeySpace): Raw => {
    let r = raw.get(id);
    if (!r) {
      r = { id, keySpaces: new Set(), directFrom: [], directCount: 0, requiredBy: [], requiredVia: [] };
      raw.set(id, r);
      order.push(id);
    }
    r.keySpaces.add(keySpace);
    return r;
  };
  const direct = (id: string, keySpace: ReferenceKeySpace, label: string) => {
    if (!id) return;
    const r = touch(id, keySpace);
    r.directCount++;
    if (!r.directFrom.includes(label)) r.directFrom.push(label);
  };

  // --- Pass 1: the node configs + edge handles of every def in the set ---
  for (const def of defs) {
    for (const n of def.nodes) {
      const cfg = (n.data as { config?: Record<string, unknown> } | undefined)?.config;
      if (!cfg) continue;
      const label = nodeLabel(n);
      for (const [key, value] of Object.entries(cfg)) {
        if (DERIVED_KEYS.has(key)) continue;
        // Carrier 2 — the id is in the KEY, not the value.
        const bondAttr = PORT_BOND_ATTR_KEY.exec(key);
        if (bondAttr) { direct(bondAttr[1] ?? '', 'attribute', label); continue; }
        if (typeof value !== 'string' || value === '') continue;
        // Carrier 1 — a plain id-valued key.
        const space = REFERENCE_KEYS[key] ?? (SLOT_ATTR_KEY.test(key) ? 'attribute' : undefined);
        if (!space) continue;
        // `__current__` is the "whichever viewer is selected" sentinel, not a mapping.
        if (space === 'mapping' && value === CURRENT_VIEWER_SENTINEL) continue;
        direct(value, space, label);
      }
    }
    // Carrier 3 — the id is in the edge HANDLE. A wired bond-attribute port has
    // no `_port_bondAttr_<id>` config key of its own, so a config scan alone
    // would miss the reference entirely.
    const byId = new Map(def.nodes.map(n => [n.id, n]));
    for (const e of def.edges as GraphEdge[]) {
      const m = EDGE_BOND_ATTR_HANDLE.exec(e.targetHandle ?? '');
      if (!m) continue;
      const target = byId.get(e.target);
      direct(m[1] ?? '', 'attribute', target ? nodeLabel(target) : 'Form Bond');
    }
  }

  // --- Pass 2: resolve + close over element→element references, to a fixpoint ---
  const refs: CollectedReference[] = [];
  const byId = new Map<string, CollectedReference>();
  const queue = [...order];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const r = raw.get(id)!;
    const keySpaces = [...r.keySpaces];
    let resolved: { element: ReferenceElement; space: ElementSpace } | undefined;
    for (const ks of keySpaces) {
      resolved = resolveElement(model, id, ks);
      if (resolved) break;
    }
    const carryable = !!resolved && resolved.space !== 'presets';
    const ref: CollectedReference = {
      id,
      keySpaces,
      space: resolved?.space,
      element: resolved?.element,
      name: (resolved?.element as { name?: string } | undefined)?.name || id,
      directFrom: r.directFrom,
      directCount: r.directCount,
      requiredBy: r.requiredBy,
      requiredVia: r.requiredVia,
      bytes: resolved ? approxBytes(resolved.element) : 0,
      carryable,
      blockedReason: !resolved
        ? 'not found in this model — this reference already dangles'
        : resolved.space === 'presets'
          ? 'presets export separately as .gcapreset'
          : undefined,
    };
    refs.push(ref);
    byId.set(id, ref);

    if (!resolved) continue;
    for (const link of closureOf(resolved.element, resolved.space)) {
      if (!link.id) continue;
      const child = touch(link.id, link.keySpace);
      if (!child.requiredBy.includes(id)) {
        child.requiredBy.push(id);
        child.requiredVia.push(link.via);
      }
      if (!seen.has(link.id)) queue.push(link.id);
    }
  }

  return { refs, byId };
}

function approxBytes(el: ReferenceElement): number {
  try { return JSON.stringify(el).length; } catch { return 0; }
}

// ---------------------------------------------------------------------------
// Resolution — union over the spaces a key may name, then CLASSIFY
// ---------------------------------------------------------------------------

function find<T extends { id: string }>(list: T[] | undefined, id: string): T | undefined {
  return (list ?? []).find(x => x.id === id);
}

/** Resolve an id under one key space, returning WHICH model list it came from.
 *  Attributes / mappings / variables each span two or three lists, so the
 *  lookup is a union and the space is whichever list actually held it. */
export function resolveElement(
  model: CAModel, id: string, keySpace: ReferenceKeySpace,
): { element: ReferenceElement; space: ElementSpace } | undefined {
  const hit = (element: ReferenceElement | undefined, space: ElementSpace) =>
    element ? { element, space } : undefined;
  switch (keySpace) {
    case 'attribute':
      return hit(find(model.attributes, id), 'attributes')
        ?? hit(find(model.agentAttributes, id), 'agentAttributes')
        ?? hit(find(model.bondAttributes, id), 'bondAttributes');
    case 'neighborhood':
      return hit(find(model.neighborhoods, id), 'neighborhoods');
    case 'mapping':
      return hit(find(model.mappings, id), 'mappings')
        ?? hit(find(model.agentMappings, id), 'agentMappings');
    case 'variable':
      return hit(find(model.variables, id), 'variables')
        ?? hit(find(model.agentVariables, id), 'agentVariables');
    case 'indicator':
      return hit(find(model.indicators, id), 'indicators');
    case 'sprite':
      return hit(find(model.sprites, id), 'sprites');
    case 'facePalette':
      return hit(find(model.variegatedCells?.facePalettes, id), 'facePalettes');
    case 'facePattern':
      return hit(find(model.variegatedCells?.facePatterns, id), 'facePatterns');
    case 'preset':
      return hit(find(model.presets, id), 'presets');
  }
}

// ---------------------------------------------------------------------------
// The transitive closure (D5) — enumerated per element type
// ---------------------------------------------------------------------------

interface ClosureLink { id: string; keySpace: ReferenceKeySpace; via: string }

function keySourceLinks(src: LookupKeySource | undefined, via: string): ClosureLink[] {
  if (!src) return [];
  if (src.kind === 'tagAttribute') return [{ id: src.attributeId, keySpace: 'attribute', via }];
  if (src.kind === 'facePalette') return [{ id: src.paletteId, keySpace: 'facePalette', via }];
  return [];
}

/**
 * The element→element references, read off the schema. This is an ENUMERATED
 * table, not a generic id-shaped-field scan: `variegatedCells.sourceAttributeId`
 * and everything on `ModelProperties` / `centerBased` are model-level
 * CONFIGURATION, not element references — importing a face pattern must not
 * drag the whole variegation setup along with it.
 */
export function closureOf(element: ReferenceElement, space: ElementSpace): ClosureLink[] {
  const out: ClosureLink[] = [];
  switch (space) {
    case 'attributes':
    case 'agentAttributes':
    case 'bondAttributes': {
      const a = element as Attribute;
      if (a.parentAttributeId) out.push({ id: a.parentAttributeId, keySpace: 'attribute', via: 'sub-attribute parent' });
      if (a.neighborhoodHintId) out.push({ id: a.neighborhoodHintId, keySpace: 'neighborhood', via: 'neighbor-index picker hint' });
      if (a.valueTagAttributeId) out.push({ id: a.valueTagAttributeId, keySpace: 'attribute', via: 'lookup-table value labels' });
      out.push(...keySourceLinks(a.rowKeySource, 'lookup-table row axis'));
      out.push(...keySourceLinks(a.colKeySource, 'lookup-table column axis'));
      (a.axes ?? []).forEach((ax, i) => out.push(...keySourceLinks(ax.source, `lookup-table axis ${i + 1}`)));
      for (const patternId of Object.values(a.facePatternAssignments ?? {})) {
        if (patternId) out.push({ id: patternId, keySpace: 'facePattern', via: 'face pattern assignment' });
      }
      return out;
    }
    case 'mappings':
    case 'agentMappings': {
      const m = element as Mapping;
      if (m.linkedAttributeId) out.push({ id: m.linkedAttributeId, keySpace: 'attribute', via: 'linked color source' });
      for (const p of m.parameters ?? []) {
        if (p.tagAttributeId) out.push({ id: p.tagAttributeId, keySpace: 'attribute', via: `parameter "${p.name || p.key}" tag options` });
      }
      return out;
    }
    case 'indicators': {
      const i = element as Indicator;
      if (i.linkedAttributeId) out.push({ id: i.linkedAttributeId, keySpace: 'attribute', via: 'linked source' });
      return out;
    }
    case 'variables':
    case 'agentVariables': {
      const v = element as Variable;
      if (v.attributeId) out.push({ id: v.attributeId, keySpace: 'attribute', via: 'tag space' });
      return out;
    }
    case 'facePatterns': {
      const p = element as FacePattern;
      if (p.paletteId) out.push({ id: p.paletteId, keySpace: 'facePalette', via: 'face label palette' });
      return out;
    }
    // Neighborhoods, sprites, face palettes and presets are self-contained.
    default:
      return out;
  }
}

// ---------------------------------------------------------------------------
// Selection → bundle (the export side)
// ---------------------------------------------------------------------------

/** Every reference that CAN be carried — the export dialog's default selection. */
export function defaultSelection(collected: CollectedReferences): Set<string> {
  return new Set(collected.refs.filter(r => r.carryable).map(r => r.id));
}

/**
 * Drop any selected element that exists ONLY because something else needed it,
 * once nothing selected needs it any more (D11 — "unchecking a requirer unchecks
 * what only it needed"). Runs to a fixpoint: a chain A → B → C collapses when A
 * is unchecked. An element referenced DIRECTLY by a node is never pruned.
 */
export function pruneOrphanSelection(collected: CollectedReferences, selected: ReadonlySet<string>): Set<string> {
  const out = new Set(selected);
  for (;;) {
    let changed = false;
    for (const ref of collected.refs) {
      if (!out.has(ref.id)) continue;
      if (ref.directCount > 0) continue;                 // a node names it outright
      if (ref.requiredBy.some(id => out.has(id))) continue;
      out.delete(ref.id);
      changed = true;
    }
    if (!changed) return out;
  }
}

/** The `references` payload for a `.gcamacro`. Elements travel VERBATIM and
 *  keep their exported ids (which is what makes a re-import into the source
 *  model a no-op). `selected` absent ⇒ everything carryable. */
export function buildReferenceBundle(
  collected: CollectedReferences, selected?: ReadonlySet<string>,
): MacroReferenceBundle {
  const bundle: MacroReferenceBundle = {};
  const seen = new Set<string>();
  for (const ref of collected.refs) {
    if (!ref.carryable || !ref.element || !ref.space || ref.space === 'presets') continue;
    if (selected && !selected.has(ref.id)) continue;
    const key = `${ref.space}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const space = ref.space as BundleSpace;
    const list = (bundle[space] ??= []) as ReferenceElement[];
    list.push(ref.element);
  }
  return bundle;
}

export function isBundleEmpty(bundle: MacroReferenceBundle | undefined): boolean {
  if (!bundle) return true;
  return Object.values(bundle).every(list => !list || list.length === 0);
}

/** Total element count in a bundle — the dialog's "N definitions" headline. */
export function bundleCount(bundle: MacroReferenceBundle | undefined): number {
  if (!bundle) return 0;
  return Object.values(bundle).reduce((n, list) => n + (list?.length ?? 0), 0);
}

/** The origin stamp for a `.gcamacro` — informational only (the import dialog's
 *  header + its compatibility warnings). */
export function macroOriginOf(model: CAModel): MacroOrigin {
  const origin: MacroOrigin = {};
  const name = model.properties?.name?.trim();
  if (name) origin.modelName = name;
  if (model.properties?.dimension) origin.dimension = model.properties.dimension;
  if (model.topologyMode) origin.topologyMode = { ...model.topologyMode };
  return origin;
}
