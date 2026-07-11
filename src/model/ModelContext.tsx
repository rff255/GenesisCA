import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import type { ReactNode } from 'react';
import type {
  Attribute,
  CAModel,
  FacePattern,
  GraphEdge,
  GraphNode,
  Indicator,
  IndicatorKind,
  LookupKeySource,
  MacroDef,
  Mapping,
  ModelProperties,
  Neighborhood,
  Preset,
  RGB,
  SimulationState,
  SpriteAsset,
  Variable,
  VariegatedCellsConfig,
  TopologyMode,
  CenterBasedConfig,
} from './types';
import { DEFAULT_MODEL, EMPTY_MODEL } from './defaultModel';
import { defaultCenterBasedConfig } from './centerBased';
import { defaultAgentCapabilities, migrateAgentCapabilities } from './agentCapabilities';
import { defaultTagColor } from '../modeler/vpl/compiler/linkedOutputMappings';
import { MULTI_ATTR_TYPES } from '../modeler/vpl/compiler/multiAttrExpand';
import { cloneMacroWithFreshIds } from './macroImport';
import { migrateColorInterpolationNodes } from './colorScaleMigration';
import { migrateTagConstantNodes } from './tagConstantMigration';
import { migrateLookupTables } from './lookupTableMigration';
import { migrateMoveSelfToNeighborNodes } from './moveSelfToNeighborMigration';
import { migrateSetCellLooksNodes } from './setCellLooksMigration';
import { migrateAgentAttributeSplit } from './agentAttributeSplitMigration';
import { migrateAgentTypeRemoval } from './agentTypeRemovalMigration';
import { migrateVariableScopeSplit } from './variableScopeMigration';
import { clearAllSavedGraphViewports, setSavedCurrentScope } from '../modeler/vpl/graphState';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(prefix: string): string {
  const base = prefix
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return `${base || 'item'}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// ---------------------------------------------------------------------------
// Node config cleanup helpers — keep graph nodes in sync with model changes
// ---------------------------------------------------------------------------

/** Patch configs of graph nodes matching a predicate */
function patchNodes(
  nodes: GraphNode[],
  pred: (cfg: Record<string, string | number | boolean>, nodeType: string) => boolean,
  patch: (cfg: Record<string, string | number | boolean>, nodeType: string) => Record<string, string | number | boolean>,
): GraphNode[] {
  let changed = false;
  const result = nodes.map(n => {
    if (n.data.config && pred(n.data.config, n.data.nodeType)) {
      changed = true;
      return { ...n, data: { ...n.data, config: patch({ ...n.data.config }, n.data.nodeType) } };
    }
    return n;
  });
  return changed ? result : nodes;
}

/** Apply patchNodes to the Cells graph, the Agents graph, AND all macroDef
 *  subgraphs. Bond-Graph Agents: scanning `agentGraphNodes` too is what keeps a
 *  deleted attribute / neighbourhood / mapping from stranding a `_undef` config
 *  in the agent graph (the same cascade bug class the cells graph has). */
function patchAllNodes(
  model: CAModel,
  pred: (cfg: Record<string, string | number | boolean>, nodeType: string) => boolean,
  patch: (cfg: Record<string, string | number | boolean>, nodeType: string) => Record<string, string | number | boolean>,
): { graphNodes: GraphNode[]; agentGraphNodes: GraphNode[]; macroDefs: MacroDef[] } {
  const graphNodes = patchNodes(model.graphNodes, pred, patch);
  const agentGraphNodes = patchNodes(model.agentGraphNodes ?? [], pred, patch);
  let macrosChanged = false;
  const macroDefs = (model.macroDefs || []).map(m => {
    const patched = patchNodes(m.nodes, pred, patch);
    if (patched !== m.nodes) { macrosChanged = true; return { ...m, nodes: patched }; }
    return m;
  });
  return { graphNodes, agentGraphNodes, macroDefs: macrosChanged ? macroDefs : (model.macroDefs || []) };
}

/** Clear a config field to '' if it matches a deleted ID */
function clearDeletedId(model: CAModel, field: string, deletedId: string) {
  return patchAllNodes(
    model,
    cfg => cfg[field] === deletedId,
    cfg => { cfg[field] = ''; return cfg; },
  );
}

/** Multi-attribute slots: clear any extra `attr_${i}` slot key that names a
 *  deleted attribute on the multi-attr accessor nodes (Get/Set Attribute, Get
 *  Model Attribute, the by-id agent pair). Scoped by node type so
 *  moveSelfToNeighbor's `attr_${i}` payload slots are untouched. */
function clearDeletedSlotIds(model: CAModel, deletedId: string) {
  return patchAllNodes(
    model,
    (cfg, nodeType) => MULTI_ATTR_TYPES.has(nodeType)
      && Object.keys(cfg).some(k => /^attr_\d+$/.test(k) && cfg[k] === deletedId),
    cfg => {
      for (const k of Object.keys(cfg)) {
        if (/^attr_\d+$/.test(k) && cfg[k] === deletedId) cfg[k] = '';
      }
      return cfg;
    },
  );
}

/** Convert legacy `data.parentId` group memberships into absolute positions and
 *  drop the parentId field. Groups are now free-floating area markers (no
 *  parent-child relationship); legacy files stored child positions relative to
 *  the group, so we translate them back to absolute on load so the visual
 *  layout is preserved. Idempotent: no-op when no parentId is present. */
function migrateNodesDropParentId(nodes: GraphNode[]): GraphNode[] {
  const groupPos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    if (n.type === 'groupNode') groupPos.set(n.id, n.position);
  }
  let changed = false;
  const result = nodes.map(n => {
    const data = n.data as Record<string, unknown>;
    if (!data || !('parentId' in data)) return n;
    changed = true;
    const parentId = data.parentId as string | undefined;
    const parent = parentId ? groupPos.get(parentId) : undefined;
    const newData = { ...data };
    delete newData.parentId;
    const position = parent
      ? { x: n.position.x + parent.x, y: n.position.y + parent.y }
      : n.position;
    return { ...n, position, data: newData as GraphNode['data'] };
  });
  return changed ? result : nodes;
}

function migrateLegacyParentIds(model: CAModel): CAModel {
  const graphNodes = migrateNodesDropParentId(model.graphNodes);
  let macrosChanged = false;
  const macroDefs = (model.macroDefs || []).map(m => {
    const migrated = migrateNodesDropParentId(m.nodes);
    if (migrated !== m.nodes) { macrosChanged = true; return { ...m, nodes: migrated }; }
    return m;
  });
  if (graphNodes === model.graphNodes && !macrosChanged) return model;
  return {
    ...model,
    graphNodes,
    macroDefs: macrosChanged ? macroDefs : model.macroDefs,
  };
}

// ---------------------------------------------------------------------------
// State & actions
// ---------------------------------------------------------------------------

interface ModelState {
  model: CAModel;
  isDirty: boolean;
  modelVersion: number;
  /** Name of the file the current model was loaded from / last saved to.
   *  Display-only (shown in the top bar after the project name); never
   *  serialized into the model. Null for new/unsaved models. */
  loadedFileName: string | null;
}

type ModelAction =
  | { type: 'UPDATE_PROPERTIES'; changes: Partial<ModelProperties> }
  | { type: 'ADD_ATTRIBUTE'; isModelAttribute: boolean }
  | { type: 'DUPLICATE_ATTRIBUTE'; sourceId: string }
  | { type: 'REMOVE_ATTRIBUTE'; id: string }
  | { type: 'UPDATE_ATTRIBUTE'; id: string; changes: Partial<Attribute> }
  // Generic Agent Platform: the AGENT attribute set (CAModel.agentAttributes).
  | { type: 'ADD_AGENT_ATTRIBUTE' }
  | { type: 'DUPLICATE_AGENT_ATTRIBUTE'; sourceId: string }
  | { type: 'REMOVE_AGENT_ATTRIBUTE'; id: string }
  | { type: 'UPDATE_AGENT_ATTRIBUTE'; id: string; changes: Partial<Attribute> }
  | { type: 'ADD_NEIGHBORHOOD' }
  | { type: 'DUPLICATE_NEIGHBORHOOD'; sourceId: string }
  | { type: 'REMOVE_NEIGHBORHOOD'; id: string }
  | { type: 'UPDATE_NEIGHBORHOOD'; id: string; changes: Partial<Neighborhood> }
  | { type: 'ADD_MAPPING'; isAttributeToColor: boolean }
  | { type: 'DUPLICATE_MAPPING'; sourceId: string }
  | { type: 'REMOVE_MAPPING'; id: string }
  | { type: 'UPDATE_MAPPING'; id: string; changes: Partial<Mapping> }
  | { type: 'ADD_AGENT_MAPPING' }
  | { type: 'DUPLICATE_AGENT_MAPPING'; sourceId: string }
  | { type: 'REMOVE_AGENT_MAPPING'; id: string }
  | { type: 'UPDATE_AGENT_MAPPING'; id: string; changes: Partial<Mapping> }
  | { type: 'ADD_SPRITE'; sprite: SpriteAsset }
  | { type: 'REMOVE_SPRITE'; id: string }
  | { type: 'UPDATE_SPRITE'; id: string; changes: Partial<SpriteAsset> }
  | { type: 'SET_GRAPH'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'SET_AGENT_GRAPH'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'UPDATE_CENTER_BASED'; changes: Partial<CenterBasedConfig> }
  | { type: 'ADD_MACRO'; macro: MacroDef }
  | { type: 'UPDATE_MACRO'; id: string; changes: Partial<MacroDef> }
  | { type: 'REMOVE_MACRO'; id: string }
  | { type: 'ADD_INDICATOR'; kind: IndicatorKind }
  | { type: 'DUPLICATE_INDICATOR'; sourceId: string }
  | { type: 'REMOVE_INDICATOR'; id: string }
  | { type: 'UPDATE_INDICATOR'; id: string; changes: Partial<Indicator> }
  | { type: 'NEW_MODEL' }
  | { type: 'LOAD_MODEL'; model: CAModel; fileName?: string }
  | { type: 'MARK_SAVED'; fileName?: string }
  | { type: 'SET_SIMULATION_STATE'; state: SimulationState | undefined }
  | { type: 'ADD_PRESET'; preset: Preset }
  | { type: 'DUPLICATE_PRESET'; sourceId: string }
  | { type: 'DELETE_PRESET'; id: string }
  | { type: 'UPDATE_PRESET'; id: string; patch: Partial<Omit<Preset, 'id'>> }
  | { type: 'REORDER_PRESETS'; newOrder: string[] }
  | { type: 'REORDER_ATTRIBUTES'; newOrder: string[] }
  | { type: 'REORDER_AGENT_ATTRIBUTES'; newOrder: string[] }
  | { type: 'REORDER_NEIGHBORHOODS'; newOrder: string[] }
  | { type: 'REORDER_MAPPINGS'; newOrder: string[] }
  | { type: 'REORDER_INDICATORS'; newOrder: string[] }
  | { type: 'REORDER_END_CONDITIONS'; newOrder: string[] }
  // Generic Agent Platform: variable actions carry a `target` (cell | agent).
  | { type: 'ADD_VARIABLE'; target?: 'cell' | 'agent' }
  | { type: 'DUPLICATE_VARIABLE'; sourceId: string; target?: 'cell' | 'agent' }
  | { type: 'REMOVE_VARIABLE'; id: string; target?: 'cell' | 'agent' }
  | { type: 'UPDATE_VARIABLE'; id: string; changes: Partial<Variable>; target?: 'cell' | 'agent' }
  | { type: 'REORDER_VARIABLES'; newOrder: string[]; target?: 'cell' | 'agent' }
  | { type: 'UPDATE_VARIEGATED_CELLS'; changes: Partial<VariegatedCellsConfig> }
  | { type: 'ADD_FACE_PATTERN' }
  | { type: 'REMOVE_FACE_PATTERN'; id: string }
  | { type: 'UPDATE_FACE_PATTERN'; id: string; changes: Partial<FacePattern> }
  | { type: 'DUPLICATE_FACE_PATTERN'; sourceId: string }
  | { type: 'UPDATE_TOPOLOGY_MODE'; changes: Partial<TopologyMode> };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function modelReducer(state: ModelState, action: ModelAction): ModelState {
  switch (action.type) {
    case 'UPDATE_PROPERTIES': {
      let neighborhoods = state.model.neighborhoods;
      // Dimension flip to 3D: seed coords3d = coords with dl=0 on every
      // 2D-authored neighbourhood. Without it the slice editor shows "0 cells"
      // (and the first click clobbers the real coords) while the NI pre-pass /
      // worker consumers disagree about the neighbourhood's contents.
      if (action.changes.dimension === '3d') {
        neighborhoods = neighborhoods.map(n =>
          n.coords3d || n.coords.length === 0
            ? n
            : { ...n, coords3d: n.coords.map(([dr, dc]) => [dr, dc, 0] as [number, number, number]) },
        );
      }
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          neighborhoods,
          properties: { ...state.model.properties, ...action.changes },
        },
      };
    }

    case 'ADD_ATTRIBUTE': {
      const newAttr: Attribute = {
        id: generateId('new_attribute'),
        name: 'new_attribute',
        type: 'bool',
        description: '',
        isModelAttribute: action.isModelAttribute,
        defaultValue: 'false',
      };
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          attributes: [...state.model.attributes, newAttr],
        },
      };
    }

    case 'DUPLICATE_ATTRIBUTE': {
      const source = state.model.attributes.find(a => a.id === action.sourceId);
      if (!source) return state;
      // Deep clone (JSON round-trip — the project convention, graphHistory.ts) so
      // nested fields (tagOptions, parentValues, rowKeySource/colKeySource,
      // tableValues, facePatternAssignments) don't share references. Fresh id +
      // " (copy)" name; APPEND so the panel auto-select lands on the copy. A
      // sub-attribute copy keeps its parentAttributeId (points at the same
      // parent); a linked mapping/variable referencing this attr is unaffected.
      const dup: Attribute = { ...(JSON.parse(JSON.stringify(source)) as Attribute), id: generateId(source.name + '_copy'), name: `${source.name} (copy)` };
      return {
        ...state, isDirty: true,
        model: { ...state.model, attributes: [...state.model.attributes, dup] },
      };
    }

    case 'REMOVE_ATTRIBUTE': {
      // Cascade: any sub-attribute pointing at this one as parent gets detached
      // (parentAttributeId cleared along with parentValues/undefinedValue).
      // Otherwise the dangling parent reference would silently survive in saved
      // files and cause "invalid parent" errors at compile time.
      const filteredAttrs = state.model.attributes
        .filter(a => a.id !== action.id)
        .map(a => {
          let next = a;
          if (next.parentAttributeId === action.id) {
            next = { ...next, parentAttributeId: undefined, parentValues: undefined, undefinedValue: undefined };
          }
          // Lookup Table: detach an axis keyed by the removed tag attribute so
          // the dangling source doesn't survive in saved files.
          if (next.type === 'lookupTable') {
            const rowDangling = next.rowKeySource?.kind === 'tagAttribute' && next.rowKeySource.attributeId === action.id;
            const colDangling = next.colKeySource?.kind === 'tagAttribute' && next.colKeySource.attributeId === action.id;
            if (rowDangling || colDangling) {
              next = {
                ...next,
                rowKeySource: rowDangling ? undefined : next.rowKeySource,
                colKeySource: colDangling ? undefined : next.colKeySource,
              };
            }
            // Tag-valued table sourcing its value labels from the removed tag
            // attribute: detach → fall back to manual valueTagOptions.
            if (next.valueTagAttributeId === action.id) {
              next = { ...next, valueTagAttributeId: undefined };
            }
          }
          return next;
        });
      // Variegation cascade: if the removed attribute was the variegation
      // source, clear sourceAttributeId. We do NOT disable variegatedCells —
      // the user might just be re-pointing the source; preserving facePatterns
      // and faceLabels avoids re-entry burden.
      let variegatedCells = state.model.variegatedCells;
      if (variegatedCells && variegatedCells.sourceAttributeId === action.id) {
        variegatedCells = { ...variegatedCells, sourceAttributeId: '' };
      }
      // Variables cascade: tag variables referencing the removed attr lose
      // their tag space — convert to integer (initialValue is already a
      // stringified number, no parsing needed) and drop attributeId.
      const variables = (state.model.variables || []).map(v =>
        v.attributeId === action.id
          ? { ...v, attributeId: undefined, dataType: 'integer' as const }
          : v,
      );
      // Same cascade for AGENT variables — a tag-typed agent variable bound to
      // the removed attribute would otherwise keep a dangling attributeId.
      const agentVariables = (state.model.agentVariables || []).map(v =>
        v.attributeId === action.id
          ? { ...v, attributeId: undefined, dataType: 'integer' as const }
          : v,
      );
      // Linked Output Mappings cascade: a mapping linked to the removed attribute
      // is fully unlinked (so it falls back to a Standalone empty pass, not a
      // dangling read). The transform also guards this, but clearing keeps the
      // saved model honest.
      const mappingsAfterRemove = state.model.mappings.map(m =>
        m.linkedAttributeId === action.id
          ? { ...m, linked: false, linkedAttributeId: undefined, linkedColors: undefined, linkedMin: undefined, linkedMax: undefined }
          : m,
      );
      const modelAfterFilter = { ...state.model, attributes: filteredAttrs, variegatedCells, variables, agentVariables, mappings: mappingsAfterRemove };
      // Clear stale attributeId and tagAttributeId references in node configs
      const a1 = clearDeletedId(modelAfterFilter, 'attributeId', action.id);
      const a2 = patchAllNodes(
        { ...modelAfterFilter, graphNodes: a1.graphNodes, agentGraphNodes: a1.agentGraphNodes, macroDefs: a1.macroDefs },
        cfg => cfg.tagAttributeId === action.id,
        cfg => { cfg.tagAttributeId = ''; return cfg; },
      );
      // Multi-attribute slots: clear any extra `attr_${i}` slot key naming the
      // deleted attribute on the five accessor nodes (the validation badge then
      // guides re-picking). Scoped by node type so moveSelfToNeighbor's payload
      // slots keep their existing (unchanged) delete behaviour.
      const a3 = clearDeletedSlotIds(
        { ...modelAfterFilter, graphNodes: a2.graphNodes, agentGraphNodes: a2.agentGraphNodes, macroDefs: a2.macroDefs },
        action.id,
      );
      return {
        ...state,
        isDirty: true,
        model: { ...modelAfterFilter, graphNodes: a3.graphNodes, agentGraphNodes: a3.agentGraphNodes, macroDefs: a3.macroDefs },
      };
    }

    case 'UPDATE_ATTRIBUTE': {
      const oldAttr = state.model.attributes.find(a => a.id === action.id);
      // Lookup Table CUSTOM-axis rename: when this attribute's own row/col key
      // source is a `custom`-labels axis whose labels changed (a rename), remap
      // tableValues keys by the same index-paired name heuristic used for tag
      // axes — otherwise renaming a custom label would orphan that row/column's
      // values (they'd read back as 0 on every target). Added labels start empty;
      // removed labels' values drop.
      const remapCustomAxis = (oldSrc?: LookupKeySource, newSrc?: LookupKeySource): Map<string, string | null> | null => {
        if (oldSrc?.kind !== 'custom' || newSrc?.kind !== 'custom') return null;
        const oldL = oldSrc.labels, newL = newSrc.labels;
        if (oldL.length === 0) return null;
        const newSet = new Set(newL);
        const map = new Map<string, string | null>();
        for (let i = 0; i < oldL.length; i++) {
          const on = oldL[i]!;
          if (newSet.has(on)) map.set(on, on);
          else if (newL[i] && !oldL.includes(newL[i]!)) map.set(on, newL[i]!); // rename at index i
          else map.set(on, null); // deleted
        }
        return map;
      };
      const applyCustomAxisRemap = (attr: Attribute): Attribute => {
        if (!oldAttr || oldAttr.type !== 'lookupTable' || !oldAttr.tableValues) return attr;
        if (action.changes.rowKeySource === undefined && action.changes.colKeySource === undefined) return attr;
        const rowMap = remapCustomAxis(oldAttr.rowKeySource, attr.rowKeySource);
        const colMap = remapCustomAxis(oldAttr.colKeySource, attr.colKeySource);
        if (!rowMap && !colMap) return attr;
        const key = (m: Map<string, string | null> | null, k: string): string | null => (m ? (m.has(k) ? m.get(k)! : k) : k);
        const nextTV: Record<string, Record<string, number>> = {};
        for (const [rk, row] of Object.entries(oldAttr.tableValues)) {
          const nrk = key(rowMap, rk);
          if (nrk === null) continue;
          const nextRow: Record<string, number> = {};
          for (const [ck, val] of Object.entries(row)) {
            const nck = key(colMap, ck);
            if (nck === null) continue;
            nextRow[nck] = val;
          }
          nextTV[nrk] = { ...(nextTV[nrk] || {}), ...nextRow };
        }
        return { ...attr, tableValues: nextTV };
      };
      const updatedModel = {
        ...state.model,
        attributes: state.model.attributes.map(a =>
          a.id === action.id ? applyCustomAxisRemap({ ...a, ...action.changes }) : a,
        ),
      };

      // If tagOptions changed, remap tag indices in node configs AND in any
      // sub-attribute's parentValues that points at this attribute as parent.
      if (oldAttr && action.changes.tagOptions && oldAttr.tagOptions) {
        const oldOpts = oldAttr.tagOptions;
        const newOpts = action.changes.tagOptions;
        // Build mapping: old index → new index (or 0 if deleted)
        const indexMap = new Map<number, number>();
        for (let oi = 0; oi < oldOpts.length; oi++) {
          const ni = newOpts.indexOf(oldOpts[oi]!);
          indexMap.set(oi, ni >= 0 ? ni : 0);
        }
        const remap = (val: string | number | boolean | undefined): string => {
          const oldIdx = Number(val) || 0;
          return String(indexMap.get(oldIdx) ?? 0);
        };
        const attrId = action.id;
        // Remap parentValues on sub-attributes that use this attribute as parent.
        // Also drop parentValues entries whose tag was deleted (indexMap value 0
        // is the fallback; if multiple old indices collapse to 0 we dedupe).
        // Variegation source: facePatternAssignments uses STRING keys (tag
        // option names, not indices), so deleted-tag entries get pruned and
        // renamed-tag entries that map to a new name at the same index get
        // ported across. The tag-options edit UI only adds/removes, but the
        // index-pairing rename heuristic survives reorderings cleanly.
        const variegationSourceId = state.model.variegatedCells?.sourceAttributeId;
        const newOptsSet = new Set(newOpts);
        // Old tag-option NAME → new name (or null when deleted). Same index-pairing
        // rename heuristic as facePatternAssignments. Used to remap Lookup Table
        // tableValues keys when this tag attribute is a table's row/col key source.
        const tagNameRemap = new Map<string, string | null>();
        for (let oi = 0; oi < oldOpts.length; oi++) {
          const oldName = oldOpts[oi]!;
          if (newOptsSet.has(oldName)) tagNameRemap.set(oldName, oldName);
          else if (newOpts[oi] && !oldOpts.includes(newOpts[oi]!)) tagNameRemap.set(oldName, newOpts[oi]!);
          else tagNameRemap.set(oldName, null);
        }
        const remapTagKey = (k: string): string | null => (tagNameRemap.has(k) ? tagNameRemap.get(k)! : k);
        const remappedAttrs = updatedModel.attributes.map(sa => {
          let next: Attribute = sa;
          if (sa.parentAttributeId === attrId && sa.parentValues) {
            const deletedOld = new Set<number>();
            for (let oi = 0; oi < oldOpts.length; oi++) {
              if (newOpts.indexOf(oldOpts[oi]!) < 0) deletedOld.add(oi);
            }
            const nextParentValues = Array.from(new Set(
              sa.parentValues
                .filter(v => !deletedOld.has(parseInt(v, 10)))
                .map(v => remap(v)),
            ));
            next = { ...next, parentValues: nextParentValues };
          }
          if (sa.id === attrId && variegationSourceId === attrId && sa.facePatternAssignments) {
            const nextAssign: Record<string, string> = {};
            for (let oi = 0; oi < oldOpts.length; oi++) {
              const oldName = oldOpts[oi]!;
              const v = sa.facePatternAssignments[oldName];
              if (!v) continue;
              if (newOptsSet.has(oldName)) {
                nextAssign[oldName] = v;
              } else if (newOpts[oi] && !oldOpts.includes(newOpts[oi]!)) {
                // Same index, new name not present in oldOpts → rename detected.
                nextAssign[newOpts[oi]!] = v;
              }
              // else: deleted tag, drop assignment.
            }
            next = { ...next, facePatternAssignments: nextAssign };
          }
          // Lookup Table tableValues: remap row/col keys when an axis is keyed
          // by THIS tag attribute (rename → new name, deleted → drop).
          if (sa.type === 'lookupTable' && sa.tableValues) {
            const rowIsTag = sa.rowKeySource?.kind === 'tagAttribute' && sa.rowKeySource.attributeId === attrId;
            const colIsTag = sa.colKeySource?.kind === 'tagAttribute' && sa.colKeySource.attributeId === attrId;
            if (rowIsTag || colIsTag) {
              const nextTV: Record<string, Record<string, number>> = {};
              for (const [rk, row] of Object.entries(sa.tableValues)) {
                const newRk = rowIsTag ? remapTagKey(rk) : rk;
                if (newRk === null) continue;
                const nextRow: Record<string, number> = {};
                for (const [ck, val] of Object.entries(row)) {
                  const newCk = colIsTag ? remapTagKey(ck) : ck;
                  if (newCk === null) continue;
                  nextRow[newCk] = val;
                }
                nextTV[newRk] = { ...(nextTV[newRk] || {}), ...nextRow };
              }
              next = { ...next, tableValues: nextTV };
            }
            // Tag-VALUED table drawing its value labels from THIS tag attribute:
            // the stored cell values are tag INDICES, so a reorder/removal shifts
            // them (a rename is index-stable). Remap by the same indexMap.
            if (next.valueType === 'tag' && next.valueTagAttributeId === attrId && next.tableValues) {
              const remappedTV: Record<string, Record<string, number>> = {};
              for (const [rk, row] of Object.entries(next.tableValues)) {
                const nr: Record<string, number> = {};
                for (const [ck, val] of Object.entries(row)) nr[ck] = Number(remap(val));
                remappedTV[rk] = nr;
              }
              next = { ...next, tableValues: remappedTV };
            }
          }
          return next;
        });
        // Variables cascade: tag variables referencing this attr get their
        // initialValue remapped (same indexMap as graph nodes).
        const remappedVariables = (updatedModel.variables || []).map(v =>
          v.attributeId === attrId && v.dataType === 'tag'
            ? { ...v, initialValue: remap(v.initialValue) }
            : v,
        );
        // Same remap for AGENT variables bound to this tag attribute.
        const remappedAgentVariables = (updatedModel.agentVariables || []).map(v =>
          v.attributeId === attrId && v.dataType === 'tag'
            ? { ...v, initialValue: remap(v.initialValue) }
            : v,
        );
        // Linked Output Mappings cascade: remap per-tag colors by the same
        // indexMap (renamed/reordered options keep their color; deleted options
        // drop out; newly-added options get the transform's default color).
        const remappedMappings = updatedModel.mappings.map(m => {
          if (m.linkedAttributeId !== attrId || !m.linkedColors?.tag) return m;
          const oldTag = m.linkedColors.tag;
          const nextTag: RGB[] = newOpts.map((_opt, ni) => {
            for (const [oi, mappedNi] of indexMap.entries()) {
              if (mappedNi === ni) { const c = oldTag[oi]; if (c) return c; }
            }
            return defaultTagColor(ni, newOpts.length);
          });
          return { ...m, linkedColors: { ...m.linkedColors, tag: nextTag } };
        });
        const remappedModel = { ...updatedModel, attributes: remappedAttrs, variables: remappedVariables, agentVariables: remappedAgentVariables, mappings: remappedMappings };
        const patched = patchAllNodes(
          remappedModel,
          (cfg, nt) => {
            if ((nt === 'getConstant' && cfg.constType === 'tag' && cfg.tagAttributeId === attrId) ||
                (nt === 'switch' && cfg.tagAttributeId === attrId && cfg.valueType === 'tag')) return true;
            // setAttribute/setNeighborhood/setNeighborByIndex with this tag attr
            if ((nt === 'setAttribute' || nt === 'setNeighborhoodAttribute' || nt === 'setNeighborAttributeByIndex')
                && cfg.attributeId === attrId) return true;
            // Compare (statement) in tag mode stores its operands as tag INDICES
            // in _port_x/_port_y/_port_y2 — remap them too, else a tag reorder
            // silently compares the wrong option.
            if (nt === 'statement' && cfg.compareType === 'tag' && cfg.tagAttributeId === attrId) return true;
            return false;
          },
          (cfg, nt) => {
            if (nt === 'getConstant') cfg.constValue = remap(cfg.constValue);
            if (nt === 'switch') {
              const cc = Number(cfg.caseCount) || 0;
              for (let i = 0; i < cc; i++) cfg[`case_${i}_value`] = remap(cfg[`case_${i}_value`]);
            }
            if (nt === 'setAttribute' || nt === 'setNeighborhoodAttribute' || nt === 'setNeighborAttributeByIndex') {
              if (cfg._port_value !== undefined) cfg._port_value = remap(cfg._port_value);
            }
            if (nt === 'statement') {
              if (cfg._port_x !== undefined) cfg._port_x = remap(cfg._port_x);
              if (cfg._port_y !== undefined) cfg._port_y = remap(cfg._port_y);
              if (cfg._port_y2 !== undefined) cfg._port_y2 = remap(cfg._port_y2);
            }
            return cfg;
          },
        );
        return {
          ...state, isDirty: true,
          model: { ...remappedModel, graphNodes: patched.graphNodes, agentGraphNodes: patched.agentGraphNodes, macroDefs: patched.macroDefs },
        };
      }

      // Parent-type change cascade. If the attribute was previously Tag or Bool
      // and is being changed to anything else (including Tag→Bool or Bool→Tag),
      // any sub-attribute that referenced it as parent has stale parentValues
      // (tag indices vs bool 0/1 are encoded differently and don't carry over).
      // Two cases:
      //   - new type is still Tag or Bool → keep the parent link, RESET
      //     parentValues to [] so the user picks again under the new type.
      //   - new type is something else (int/float/color/neighborIndex) → detach
      //     entirely (clear parentAttributeId, parentValues, undefinedValue).
      if (oldAttr && action.changes.type
          && oldAttr.type !== action.changes.type
          && (oldAttr.type === 'tag' || oldAttr.type === 'bool')) {
        const newType = action.changes.type;
        const stillValidParent = newType === 'tag' || newType === 'bool';
        const detached = updatedModel.attributes.map(a => a.parentAttributeId === action.id
          ? stillValidParent
              ? { ...a, parentValues: [] }
              : { ...a, parentAttributeId: undefined, parentValues: undefined, undefinedValue: undefined }
          : a);
        // Variables cascade: when this attribute was a tag and is no longer
        // one, variables that referenced it switch to integer + drop the link.
        const variables = (updatedModel.variables || []).map(v =>
          v.attributeId === action.id && v.dataType === 'tag' && newType !== 'tag'
            ? { ...v, attributeId: undefined, dataType: 'integer' as const }
            : v,
        );
        // Same detach for AGENT variables.
        const agentVariables = (updatedModel.agentVariables || []).map(v =>
          v.attributeId === action.id && v.dataType === 'tag' && newType !== 'tag'
            ? { ...v, attributeId: undefined, dataType: 'integer' as const }
            : v,
        );
        // Linked Output Mappings: tag/bool → other type invalidates the palette;
        // reset colors/domain but keep the link (transform regenerates defaults).
        const mappings = updatedModel.mappings.map(m =>
          m.linkedAttributeId === action.id
            ? { ...m, linkedColors: undefined, linkedMin: undefined, linkedMax: undefined }
            : m,
        );
        return { ...state, isDirty: true, model: { ...updatedModel, attributes: detached, variables, agentVariables, mappings } };
      }

      // Linked Output Mappings: any other attribute type change (e.g. float↔integer)
      // invalidates a linked palette / domain — reset so the transform regenerates
      // type-appropriate defaults (the link itself is preserved).
      if (oldAttr && action.changes.type && oldAttr.type !== action.changes.type) {
        const mappings = updatedModel.mappings.map(m =>
          m.linkedAttributeId === action.id
            ? { ...m, linkedColors: undefined, linkedMin: undefined, linkedMax: undefined }
            : m,
        );
        return { ...state, isDirty: true, model: { ...updatedModel, mappings } };
      }

      return { ...state, isDirty: true, model: updatedModel };
    }

    // ---- Generic Agent Platform: agent attribute set (separate id-space) ----
    case 'ADD_AGENT_ATTRIBUTE': {
      const newAttr: Attribute = {
        id: generateId('agent_attribute'),
        name: 'agent_attribute',
        type: 'float',
        description: '',
        isModelAttribute: false,
        defaultValue: '0',
      };
      return {
        ...state, isDirty: true,
        model: { ...state.model, agentAttributes: [...(state.model.agentAttributes || []), newAttr] },
      };
    }

    case 'DUPLICATE_AGENT_ATTRIBUTE': {
      const list = state.model.agentAttributes || [];
      const source = list.find(a => a.id === action.sourceId);
      if (!source) return state;
      const dup: Attribute = { ...(JSON.parse(JSON.stringify(source)) as Attribute), id: generateId(source.name + '_copy'), name: `${source.name} (copy)` };
      return {
        ...state, isDirty: true,
        model: { ...state.model, agentAttributes: [...list, dup] },
      };
    }

    case 'REMOVE_AGENT_ATTRIBUTE': {
      const filtered = (state.model.agentAttributes || []).filter(a => a.id !== action.id);
      // Unlink any agent output mapping that pointed at the deleted attribute (the
      // synthesis skips a stale link, but clearing it keeps the panel honest) —
      // and drop its stale palette/range so a later re-link starts clean.
      const agentMappings = (state.model.agentMappings ?? []).map(m =>
        m.linkedAttributeId === action.id
          ? { ...m, linkedAttributeId: undefined, linked: false, linkedColors: undefined, linkedMin: undefined, linkedMax: undefined }
          : m,
      );
      // Detach agent tag variables bound to the deleted attribute (mirrors the
      // cell REMOVE_ATTRIBUTE demote-to-integer rule).
      const agentVariables = (state.model.agentVariables ?? []).map(v =>
        v.attributeId === action.id ? { ...v, dataType: 'integer' as const, attributeId: undefined } : v,
      );
      const modelAfter = { ...state.model, agentAttributes: filtered, agentMappings, agentVariables };
      // Clear stale attributeId / tagAttributeId references (scans both graphs +
      // macros) so a removed agent attribute doesn't strand `_undef` in the
      // agent graph.
      const a1 = clearDeletedId(modelAfter, 'attributeId', action.id);
      const a2 = patchAllNodes(
        { ...modelAfter, graphNodes: a1.graphNodes, agentGraphNodes: a1.agentGraphNodes, macroDefs: a1.macroDefs },
        cfg => cfg.tagAttributeId === action.id,
        cfg => { cfg.tagAttributeId = ''; return cfg; },
      );
      // Multi-attribute slots: clear extra `attr_${i}` slot keys naming the
      // deleted agent attribute (mirrors the cell REMOVE_ATTRIBUTE cascade).
      const a3 = clearDeletedSlotIds(
        { ...modelAfter, graphNodes: a2.graphNodes, agentGraphNodes: a2.agentGraphNodes, macroDefs: a2.macroDefs },
        action.id,
      );
      return {
        ...state, isDirty: true,
        model: { ...modelAfter, graphNodes: a3.graphNodes, agentGraphNodes: a3.agentGraphNodes, macroDefs: a3.macroDefs },
      };
    }

    case 'UPDATE_AGENT_ATTRIBUTE': {
      const oldAttr = (state.model.agentAttributes || []).find(a => a.id === action.id);
      let updatedModel = {
        ...state.model,
        agentAttributes: (state.model.agentAttributes || []).map(a =>
          a.id === action.id ? { ...a, ...action.changes } : a),
      };
      // Type change: reset any LINKED agent mapping's palette/range (a stale tag
      // palette can't describe the new type — mirrors the cell UPDATE_ATTRIBUTE
      // cascade), and detach agent tag variables when the type leaves 'tag'.
      if (oldAttr && action.changes.type && action.changes.type !== oldAttr.type) {
        updatedModel = {
          ...updatedModel,
          agentMappings: (updatedModel.agentMappings ?? []).map(m =>
            m.linkedAttributeId === action.id
              ? { ...m, linkedColors: undefined, linkedMin: undefined, linkedMax: undefined }
              : m,
          ),
          agentVariables: action.changes.type !== 'tag'
            ? (updatedModel.agentVariables ?? []).map(v =>
                v.attributeId === action.id ? { ...v, dataType: 'integer' as const, attributeId: undefined } : v)
            : updatedModel.agentVariables,
        };
      }
      // Tag-options remap for agent-graph node configs (getConstant / switch /
      // Compare / setAttribute|setAgentAttribute inline values) + agent tag
      // variables' initialValue. patchAllNodes scans both graphs; the cell graph
      // never references an agent-attribute id, so only the agent graph is affected.
      if (oldAttr && action.changes.tagOptions && oldAttr.tagOptions) {
        const oldOpts = oldAttr.tagOptions, newOpts = action.changes.tagOptions;
        const indexMap = new Map<number, number>();
        for (let oi = 0; oi < oldOpts.length; oi++) {
          const ni = newOpts.indexOf(oldOpts[oi]!);
          indexMap.set(oi, ni >= 0 ? ni : 0);
        }
        const remap = (val: string | number | boolean | undefined): string =>
          String(indexMap.get(Number(val) || 0) ?? 0);
        const attrId = action.id;
        updatedModel = {
          ...updatedModel,
          agentVariables: (updatedModel.agentVariables ?? []).map(v =>
            v.attributeId === attrId && v.dataType === 'tag' ? { ...v, initialValue: remap(v.initialValue) } : v),
        };
        const patched = patchAllNodes(
          updatedModel,
          (cfg, nt) =>
            (nt === 'getConstant' && cfg.constType === 'tag' && cfg.tagAttributeId === attrId) ||
            (nt === 'switch' && cfg.tagAttributeId === attrId && cfg.valueType === 'tag') ||
            // Compare in tag mode stores its operands as tag indices in
            // _port_x/_port_y/_port_y2 — the cell path remaps them; so must we.
            (nt === 'statement' && cfg.compareType === 'tag' && cfg.tagAttributeId === attrId) ||
            ((nt === 'setAttribute' || nt === 'setAgentAttribute' || nt === 'setAgentsAttribute' || nt === 'updateAttribute') && cfg.attributeId === attrId),
          (cfg, nt) => {
            if (nt === 'getConstant') cfg.constValue = remap(cfg.constValue);
            if (nt === 'switch') {
              const cc = Number(cfg.caseCount) || 0;
              for (let i = 0; i < cc; i++) cfg[`case_${i}_value`] = remap(cfg[`case_${i}_value`]);
            }
            if (nt === 'statement') {
              if (cfg._port_x !== undefined) cfg._port_x = remap(cfg._port_x);
              if (cfg._port_y !== undefined) cfg._port_y = remap(cfg._port_y);
              if (cfg._port_y2 !== undefined) cfg._port_y2 = remap(cfg._port_y2);
            }
            if ((nt === 'setAttribute' || nt === 'setAgentAttribute' || nt === 'setAgentsAttribute') && cfg._port_value !== undefined) {
              cfg._port_value = remap(cfg._port_value);
            }
            return cfg;
          },
        );
        return {
          ...state, isDirty: true,
          model: { ...updatedModel, graphNodes: patched.graphNodes, agentGraphNodes: patched.agentGraphNodes, macroDefs: patched.macroDefs },
        };
      }
      return { ...state, isDirty: true, model: updatedModel };
    }

    case 'ADD_NEIGHBORHOOD': {
      const newNbr: Neighborhood = {
        id: generateId('new_neighborhood'),
        name: 'new_neighborhood',
        description: '',
        coords: [],
        margin: 2,
        includeCentralCell: false,
      };
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          neighborhoods: [...state.model.neighborhoods, newNbr],
        },
      };
    }

    case 'DUPLICATE_NEIGHBORHOOD': {
      const source = state.model.neighborhoods.find(n => n.id === action.sourceId);
      if (!source) return state;
      const dup: Neighborhood = {
        id: generateId(source.name + '_copy'),
        name: source.name + ' (copy)',
        description: source.description,
        coords: source.coords.map(([r, c]) => [r, c] as [number, number]),
        margin: source.margin,
        includeCentralCell: source.includeCentralCell,
        // tags is keyed by coord index; the duplicated coords preserve index
        // order, so a shallow copy keeps the same keys valid.
        tags: source.tags ? { ...source.tags } : undefined,
      };
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          neighborhoods: [...state.model.neighborhoods, dup],
        },
      };
    }

    case 'REMOVE_NEIGHBORHOOD': {
      const mAfterNbr = {
        ...state.model,
        neighborhoods: state.model.neighborhoods.filter(n => n.id !== action.id),
      };
      const nbrPatch = clearDeletedId(mAfterNbr, 'neighborhoodId', action.id);
      return {
        ...state, isDirty: true,
        model: { ...mAfterNbr, graphNodes: nbrPatch.graphNodes, agentGraphNodes: nbrPatch.agentGraphNodes, macroDefs: nbrPatch.macroDefs },
      };
    }

    case 'UPDATE_NEIGHBORHOOD':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          neighborhoods: state.model.neighborhoods.map(n =>
            n.id === action.id ? { ...n, ...action.changes } : n,
          ),
        },
      };

    case 'ADD_MAPPING': {
      const newMap: Mapping = {
        id: generateId('new_mapping'),
        name: 'new_mapping',
        description: '',
        isAttributeToColor: action.isAttributeToColor,
        redDescription: '',
        greenDescription: '',
        blueDescription: '',
      };
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          mappings: [...state.model.mappings, newMap],
        },
      };
    }

    case 'DUPLICATE_MAPPING': {
      const source = state.model.mappings.find(m => m.id === action.sourceId);
      if (!source) return state;
      // Definition-level duplicate (fresh id + " (copy)" name). For a LINKED
      // mapping the copy carries linked*/linkedColors → the linked-OM synthesis
      // regenerates its colour pass immediately. For a STANDALONE mapping the
      // hand-built graph nodes still reference the OLD id, so the copy renders a
      // Standalone empty pass until the user wires it (documented; matches the
      // "duplicate the definition" scope of the neighborhood duplicate).
      const dup: Mapping = { ...(JSON.parse(JSON.stringify(source)) as Mapping), id: generateId(source.name + '_copy'), name: `${source.name} (copy)` };
      return {
        ...state, isDirty: true,
        model: { ...state.model, mappings: [...state.model.mappings, dup] },
      };
    }

    case 'REMOVE_MAPPING': {
      const mAfterMap = {
        ...state.model,
        mappings: state.model.mappings.filter(m => m.id !== action.id),
      };
      const mapPatch = clearDeletedId(mAfterMap, 'mappingId', action.id);
      return {
        ...state, isDirty: true,
        model: { ...mAfterMap, graphNodes: mapPatch.graphNodes, agentGraphNodes: mapPatch.agentGraphNodes, macroDefs: mapPatch.macroDefs },
      };
    }

    case 'UPDATE_MAPPING':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          mappings: state.model.mappings.map(m =>
            m.id === action.id ? { ...m, ...action.changes } : m,
          ),
        },
      };

    // Agent Output Mappings — the agent-layer A→C views (linked over agent attrs).
    case 'ADD_AGENT_MAPPING': {
      const firstAgentAttr = (state.model.agentAttributes ?? []).find(a => a.type !== 'color' && a.type !== 'lookupTable');
      const newMap: Mapping = {
        id: generateId('agent_view'),
        name: 'Agent View',
        description: '',
        isAttributeToColor: true,
        // No eligible agent attribute → seed as STANDALONE (a linked mapping with
        // linkedAttributeId undefined would render a broken default view).
        linked: !!firstAgentAttr,
        linkedAttributeId: firstAgentAttr?.id,
        redDescription: '', greenDescription: '', blueDescription: '',
      };
      return {
        ...state, isDirty: true,
        model: { ...state.model, agentMappings: [...(state.model.agentMappings ?? []), newMap] },
      };
    }
    case 'DUPLICATE_AGENT_MAPPING': {
      const list = state.model.agentMappings ?? [];
      const source = list.find(m => m.id === action.sourceId);
      if (!source) return state;
      const dup: Mapping = { ...(JSON.parse(JSON.stringify(source)) as Mapping), id: generateId(source.name + '_copy'), name: `${source.name} (copy)` };
      return {
        ...state, isDirty: true,
        model: { ...state.model, agentMappings: [...list, dup] },
      };
    }
    case 'REMOVE_AGENT_MAPPING': {
      // Cascade like REMOVE_MAPPING: clear the deleted id from node configs
      // (agentOutputMapping roots + setCellLooks on the Agents graph keep
      // `config.mappingId`) — otherwise a standalone agent view leaves a dead
      // compiled pass + a dangling picker value in the saved file.
      const mAfterAgentMap = {
        ...state.model,
        agentMappings: (state.model.agentMappings ?? []).filter(m => m.id !== action.id),
      };
      const agentMapPatch = clearDeletedId(mAfterAgentMap, 'mappingId', action.id);
      return {
        ...state, isDirty: true,
        model: { ...mAfterAgentMap, graphNodes: agentMapPatch.graphNodes, agentGraphNodes: agentMapPatch.agentGraphNodes, macroDefs: agentMapPatch.macroDefs },
      };
    }
    case 'UPDATE_AGENT_MAPPING':
      return {
        ...state, isDirty: true,
        model: {
          ...state.model,
          agentMappings: (state.model.agentMappings ?? []).map(m =>
            m.id === action.id ? { ...m, ...action.changes } : m,
          ),
        },
      };

    case 'ADD_SPRITE':
      return {
        ...state, isDirty: true,
        model: { ...state.model, sprites: [...(state.model.sprites ?? []), action.sprite] },
      };
    case 'REMOVE_SPRITE': {
      // Cascade: clear `spriteId` on any Set Agent Sprite node referencing the
      // deleted asset (so it shows a "Select a sprite" badge instead of a dangling ref).
      const patched = clearDeletedId(state.model, 'spriteId', action.id);
      return {
        ...state, isDirty: true,
        model: {
          ...state.model,
          sprites: (state.model.sprites ?? []).filter(s => s.id !== action.id),
          ...patched,
        },
      };
    }
    case 'UPDATE_SPRITE':
      return {
        ...state, isDirty: true,
        model: {
          ...state.model,
          sprites: (state.model.sprites ?? []).map(s =>
            s.id === action.id ? { ...s, ...action.changes } : s,
          ),
        },
      };

    case 'SET_GRAPH':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          graphNodes: action.nodes,
          graphEdges: action.edges,
        },
      };

    case 'SET_AGENT_GRAPH':
      // Bond-Graph Agents: write-back for the SECOND (agent) rule graph. The
      // GraphEditor's scheduleSync forks to this when the Agents sub-tab is
      // active (mirrors SET_GRAPH for the Cells graph).
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          agentGraphNodes: action.nodes,
          agentGraphEdges: action.edges,
        },
      };

    case 'UPDATE_CENTER_BASED': {
      // Bond-Graph Agents config (force law, ceilings, world bounds, bonds).
      // Seed a default when absent so the first edit lands on a full object.
      const current: CenterBasedConfig = state.model.centerBased ?? defaultCenterBasedConfig();
      return {
        ...state, isDirty: true,
        model: { ...state.model, centerBased: { ...current, ...action.changes } },
      };
    }

    case 'ADD_MACRO':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          macroDefs: [...(state.model.macroDefs || []), action.macro],
        },
      };

    case 'UPDATE_MACRO':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          macroDefs: (state.model.macroDefs || []).map(m =>
            m.id === action.id ? { ...m, ...action.changes } : m,
          ),
        },
      };

    case 'REMOVE_MACRO':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          macroDefs: (state.model.macroDefs || []).filter(m => m.id !== action.id),
        },
      };

    case 'ADD_INDICATOR': {
      const newInd: Indicator = {
        id: generateId('indicator'),
        name: 'new_indicator',
        kind: action.kind,
        dataType: 'integer',
        defaultValue: '0',
        accumulationMode: 'per-generation',
        watched: true,
      };
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          indicators: [...(state.model.indicators || []), newInd],
        },
      };
    }

    case 'DUPLICATE_INDICATOR': {
      const source = (state.model.indicators || []).find(i => i.id === action.sourceId);
      if (!source) return state;
      // Definition-level duplicate (fresh id + " (copy)" name) — deep-clones every
      // field (kind, dataType, linked*, trackedValues, chartSettings, …). A
      // STANDALONE indicator's copy has a fresh id not referenced by any
      // Set/Get/Update-Indicator node, so it starts unwired (mirrors the
      // duplicate-mapping scope); a LINKED indicator's copy aggregates immediately.
      const dup: Indicator = { ...(JSON.parse(JSON.stringify(source)) as Indicator), id: generateId(source.name + '_copy'), name: `${source.name} (copy)` };
      return {
        ...state, isDirty: true,
        model: { ...state.model, indicators: [...(state.model.indicators || []), dup] },
      };
    }

    case 'REMOVE_INDICATOR': {
      const mAfterInd = {
        ...state.model,
        indicators: (state.model.indicators || []).filter(i => i.id !== action.id),
      };
      const indPatch = clearDeletedId(mAfterInd, 'indicatorId', action.id);
      return {
        ...state, isDirty: true,
        model: { ...mAfterInd, graphNodes: indPatch.graphNodes, agentGraphNodes: indPatch.agentGraphNodes, macroDefs: indPatch.macroDefs },
      };
    }

    case 'UPDATE_INDICATOR':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          indicators: (state.model.indicators || []).map(i =>
            i.id === action.id ? { ...i, ...action.changes } : i,
          ),
        },
      };

    case 'NEW_MODEL':
      return { model: EMPTY_MODEL, isDirty: false, modelVersion: state.modelVersion + 1, loadedFileName: null };

    case 'LOAD_MODEL': {
      let m = action.model;
      // Migration guards for loaded files (same as localStorage)
      if (!m.graphNodes) m.graphNodes = [];
      if (!m.graphEdges) m.graphEdges = [];
      if (!m.macroDefs) m.macroDefs = [];
      if (!m.indicators) m.indicators = [];
      if (!m.variables) m.variables = [];
      // Generic Agent Platform: the agent local-variable set (separate id-space).
      if (!m.agentVariables) m.agentVariables = [];
      if (!m.properties.tags) m.properties.tags = [];
      if (!m.properties.updateMode) m.properties.updateMode = 'synchronous';
      if (!m.properties.asyncScheme) m.properties.asyncScheme = 'random-order';
      // v1.8: rename/add — silently drop legacy `goal`, default new `modelAuthor` to ''.
      if ('goal' in m.properties) delete (m.properties as unknown as Record<string, unknown>).goal;
      if (m.properties.modelAuthor === undefined) m.properties.modelAuthor = '';
      // 3D Grid CA / Bond-Graph Morphogenesis (M0a): default the new mode fields
      // so every legacy file loads as the top-left mode-matrix cell (2D grid).
      if (!m.properties.dimension) m.properties.dimension = '2d';
      if (m.properties.gridDepth === undefined) m.properties.gridDepth = 1;
      if (!m.topologyMode) m.topologyMode = { gridCells: true, agents: false };
      // Bond-Graph Agents: default the second (agent) rule graph so every legacy
      // file loads with empty agent arrays. centerBased is seeded only when the
      // Agents topology is on (a non-agent file leaves it absent).
      if (!m.agentGraphNodes) m.agentGraphNodes = [];
      if (!m.agentGraphEdges) m.agentGraphEdges = [];
      if (!m.agentMappings) m.agentMappings = [];
      // Generic Agent Platform: the agent attribute set (separate id-space).
      // Absent in every legacy file; the split migration below populates it for
      // legacy agent models that stored per-agent state in cell attributes.
      if (!m.agentAttributes) m.agentAttributes = [];
      if (m.topologyMode.agents && !m.centerBased) m.centerBased = defaultCenterBasedConfig();
      for (const n of m.neighborhoods) { n.margin ??= 2; n.includeCentralCell ??= false; }
      for (const a of m.attributes) {
        if (a.type === 'tag' && !a.tagOptions) a.tagOptions = [];
      }
      // Groups are free-floating area markers now — translate any legacy
      // child positions (relative to a group) back to absolute and drop
      // data.parentId. Visual layout is preserved.
      m = migrateLegacyParentIds(m);
      // Bond-Graph Agents — migration scope decision: the 5 node-migrators below
      // (colorInterpolation, tagConstant, moveSelfToNeighbor, setCellLooks-merge,
      // lookupTables) operate on `graphNodes` + `macroDefs` only, NOT
      // `agentGraphNodes`. Rationale: every node type they upgrade is a LEGACY
      // node that predates `agentGraphNodes` (which is brand-new this milestone),
      // so an agent graph can never contain one from an old file, and a newly
      // authored agent graph already uses the current node shapes. If a FUTURE
      // migration ever targets a node type usable in agent graphs (e.g. a new
      // setCellLooks revision — setCellLooks IS used for agent appearance), it
      // MUST also scan `agentGraphNodes`, or stale config strands there.
      // Color Scale migration: rewrite legacy colorInterpolation nodes to
      // the new colorScale shape (top-level + all macroDefs). Idempotent.
      {
        const r = migrateColorInterpolationNodes(m.graphNodes, m.graphEdges, m.macroDefs);
        m = { ...m, graphNodes: r.graphNodes, graphEdges: r.graphEdges, macroDefs: r.macroDefs };
      }
      // TagConstant migration: rewrite legacy tagConstant nodes to the
      // equivalent getConstant in tag mode (the picker UI is identical and
      // both emit the same integer). Idempotent.
      {
        const r = migrateTagConstantNodes(m.graphNodes, m.graphEdges, m.macroDefs);
        m = { ...m, graphNodes: r.graphNodes, graphEdges: r.graphEdges, macroDefs: r.macroDefs };
      }
      // Transfer-to-Neighbor migration: upgrade legacy moveSelfToNeighbor nodes
      // (payload/orientation ports + transferOrientation) to the reworked
      // operation/nonReceiving/includeOrientation shape; drop dead payload edges.
      // Idempotent (top-level + all macroDefs).
      {
        const r = migrateMoveSelfToNeighborNodes(m.graphNodes, m.graphEdges, m.macroDefs);
        m = { ...m, graphNodes: r.graphNodes, graphEdges: r.graphEdges, macroDefs: r.macroDefs };
      }
      // Set Cell Looks migration: merge legacy setColorViewer + setCellGlyph
      // nodes into the unified setCellLooks node (glyph nodes get useGlyph:true
      // and their R/G/B remapped to the glyph-color ports). Idempotent.
      {
        const r = migrateSetCellLooksNodes(m.graphNodes, m.graphEdges, m.macroDefs);
        m = { ...m, graphNodes: r.graphNodes, graphEdges: r.graphEdges, macroDefs: r.macroDefs };
      }
      // Lookup Table migration: interactionTable→lookupTable attribute type +
      // variegatedCells.faceLabels→facePalettes[0] + default square key sources.
      // Idempotent. Model-level (attributes + variegatedCells), so no macro pass.
      m = migrateLookupTables(m);
      // Drop the removed built-in agent `type`: setAgentType nodes, createAgent
      // `type` input, behaviourStep `myType`-out edges (agent graph + macroDefs).
      // Idempotent; no-op for non-agent + already-clean models.
      m = migrateAgentTypeRemoval(m);
      // Generic Agent Platform: split legacy agent-state cell attributes into
      // the dedicated agentAttributes[] set + set agentAccess on cell attrs the
      // agent graph reads/writes as a field. No-op for non-agent + already-split
      // models. MUST run AFTER the node migrations (it reads agent-graph configs).
      m = migrateAgentAttributeSplit(m);
      // Move agent-referenced cell variables into the agent variable set (so the
      // agent loop's Get/Set Variable resolve). No-op for non-agent + already-split.
      m = migrateVariableScopeSplit(m);
      // Agent Capability Profiles: seed an explicit profile on an agent model that
      // has none, via the usage-widened inference (legacy files load with an honest,
      // behaviour-preserving profile). MUST run AFTER the agent-attribute/variable
      // splits (the inference scans the agent graph node types). No-op otherwise.
      m = migrateAgentCapabilities(m);
      // 3D model with 2D-authored neighbourhoods (e.g. a file whose dimension was
      // hand-edited, or saved mid-flip by an older build): seed coords3d = coords
      // with dl=0 so the slice editor + the NI codec pre-pass see the same cells
      // the worker's dl=0 fallback simulates.
      if (m.properties.dimension === '3d') {
        const needsSeed = m.neighborhoods.some(n => !n.coords3d && n.coords.length > 0);
        if (needsSeed) {
          m = {
            ...m,
            neighborhoods: m.neighborhoods.map(n =>
              n.coords3d || n.coords.length === 0
                ? n
                : { ...n, coords3d: n.coords.map(([dr, dc]) => [dr, dc, 0] as [number, number, number]) },
            ),
          };
        }
      }
      return { model: m, isDirty: false, modelVersion: state.modelVersion + 1, loadedFileName: action.fileName ?? null };
    }

    case 'MARK_SAVED':
      return { ...state, isDirty: false, loadedFileName: action.fileName ?? state.loadedFileName };

    case 'SET_SIMULATION_STATE':
      return {
        ...state,
        model: { ...state.model, simulationState: action.state },
      };

    case 'ADD_PRESET':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          presets: [...(state.model.presets || []), action.preset],
        },
      };

    case 'DUPLICATE_PRESET': {
      const source = (state.model.presets || []).find(p => p.id === action.sourceId);
      if (!source) return state;
      // Deep-clone the whole preset (incl. the embedded SimulationState / grid
      // snapshot) with a fresh id + " (copy)" name + a new createdAt.
      const dup: Preset = { ...(JSON.parse(JSON.stringify(source)) as Preset), id: generateId('preset'), name: `${source.name} (copy)`, createdAt: Date.now() };
      return {
        ...state, isDirty: true,
        model: { ...state.model, presets: [...(state.model.presets || []), dup] },
      };
    }

    case 'DELETE_PRESET':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          presets: (state.model.presets || []).filter(p => p.id !== action.id),
        },
      };

    case 'UPDATE_PRESET':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          presets: (state.model.presets || []).map(p =>
            p.id === action.id ? { ...p, ...action.patch } : p,
          ),
        },
      };

    case 'REORDER_PRESETS':
      return {
        ...state,
        isDirty: true,
        model: { ...state.model, presets: reorderById(state.model.presets || [], action.newOrder) },
      };

    case 'REORDER_ATTRIBUTES':
      return {
        ...state,
        isDirty: true,
        model: { ...state.model, attributes: reorderById(state.model.attributes, action.newOrder) },
      };

    case 'REORDER_AGENT_ATTRIBUTES':
      return {
        ...state,
        isDirty: true,
        model: { ...state.model, agentAttributes: reorderById(state.model.agentAttributes ?? [], action.newOrder) },
      };

    case 'REORDER_NEIGHBORHOODS':
      return {
        ...state,
        isDirty: true,
        model: { ...state.model, neighborhoods: reorderById(state.model.neighborhoods, action.newOrder) },
      };

    case 'REORDER_MAPPINGS':
      return {
        ...state,
        isDirty: true,
        model: { ...state.model, mappings: reorderById(state.model.mappings, action.newOrder) },
      };

    case 'REORDER_INDICATORS':
      return {
        ...state,
        isDirty: true,
        model: { ...state.model, indicators: reorderById(state.model.indicators, action.newOrder) },
      };

    case 'REORDER_END_CONDITIONS': {
      const ec = state.model.properties.endConditions;
      if (!ec?.indicatorConditions) return state;
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          properties: {
            ...state.model.properties,
            endConditions: {
              ...ec,
              indicatorConditions: reorderById(ec.indicatorConditions, action.newOrder),
            },
          },
        },
      };
    }

    case 'ADD_VARIABLE': {
      // Generic Agent Platform: target the cell or agent variable set.
      const key = action.target === 'agent' ? 'agentVariables' : 'variables';
      const current = state.model[key] || [];
      const newVar: Variable = {
        id: generateId('variable'),
        name: `var_${current.length + 1}`,
        kind: 'scalar',
        dataType: 'float',
        initialValue: '0',
      };
      return {
        ...state, isDirty: true,
        model: { ...state.model, [key]: [...current, newVar] },
      };
    }

    case 'DUPLICATE_VARIABLE': {
      const key = action.target === 'agent' ? 'agentVariables' : 'variables';
      const current = state.model[key] || [];
      const source = current.find(v => v.id === action.sourceId);
      if (!source) return state;
      const dup: Variable = { ...(JSON.parse(JSON.stringify(source)) as Variable), id: generateId('variable'), name: `${source.name}_copy` };
      return {
        ...state, isDirty: true,
        model: { ...state.model, [key]: [...current, dup] },
      };
    }

    case 'REMOVE_VARIABLE': {
      const key = action.target === 'agent' ? 'agentVariables' : 'variables';
      const mAfter: CAModel = {
        ...state.model,
        [key]: (state.model[key] || []).filter(v => v.id !== action.id),
      };
      const patch = clearDeletedId(mAfter, 'variableId', action.id);
      return {
        ...state, isDirty: true,
        model: { ...mAfter, graphNodes: patch.graphNodes, agentGraphNodes: patch.agentGraphNodes, macroDefs: patch.macroDefs },
      };
    }

    case 'UPDATE_VARIABLE': {
      const key = action.target === 'agent' ? 'agentVariables' : 'variables';
      const current = state.model[key] || [];
      // When kind changes from array→scalar, drop `length`. When dataType is no
      // longer tag, drop `attributeId`. Lets the inspector "settle" without the
      // user manually clearing now-irrelevant fields.
      const next = current.map(v => {
        if (v.id !== action.id) return v;
        const updated: Variable = { ...v, ...action.changes };
        if (updated.kind === 'scalar') delete updated.length;
        else if (updated.length === undefined) updated.length = 4;
        if (updated.dataType !== 'tag') delete updated.attributeId;
        return updated;
      });
      return { ...state, isDirty: true, model: { ...state.model, [key]: next } };
    }

    case 'REORDER_VARIABLES': {
      const key = action.target === 'agent' ? 'agentVariables' : 'variables';
      return {
        ...state, isDirty: true,
        model: { ...state.model, [key]: reorderById(state.model[key] || [], action.newOrder) },
      };
    }

    case 'UPDATE_VARIEGATED_CELLS': {
      const current: VariegatedCellsConfig = state.model.variegatedCells ?? {
        enabled: false, sourceAttributeId: '', facePalettes: [], facePatterns: [],
      };
      return {
        ...state, isDirty: true,
        model: { ...state.model, variegatedCells: { ...current, ...action.changes } },
      };
    }

    case 'UPDATE_TOPOLOGY_MODE': {
      const current: TopologyMode = state.model.topologyMode ?? { gridCells: true, agents: false };
      const next = { ...current, ...action.changes };
      if (!next.gridCells && !next.agents) return state;  // reject all-false (defense-in-depth; UI also gates)
      // Seed the agent config + the (empty) agent graph the first time Agents is
      // enabled, so the Properties config section + the Agents sub-tab have
      // something to bind to. Disabling Agents keeps the data (mirrors how
      // variegated data persists) — re-enabling restores it.
      const model = { ...state.model, topologyMode: next };
      if (next.agents) {
        if (!model.centerBased) model.centerBased = defaultCenterBasedConfig();
        else if (!model.centerBased.enabled) model.centerBased = { ...model.centerBased, enabled: true };
        // Agent Capability Profile — seed a friendly paradigm default (Boids) the
        // first time Agents is enabled, so the editor surface + Properties preset
        // row have an explicit profile to reflect (the user re-picks from there).
        if (!model.centerBased.agentCapabilities) {
          model.centerBased = { ...model.centerBased, agentCapabilities: defaultAgentCapabilities() };
        }
        if (!model.agentGraphNodes) model.agentGraphNodes = [];
        if (!model.agentGraphEdges) model.agentGraphEdges = [];
      } else if (model.centerBased?.enabled) {
        model.centerBased = { ...model.centerBased, enabled: false };
      }
      return { ...state, isDirty: true, model };
    }

    case 'ADD_FACE_PATTERN': {
      const current: VariegatedCellsConfig = state.model.variegatedCells ?? {
        enabled: false, sourceAttributeId: '', facePalettes: [], facePatterns: [],
      };
      const newPattern: FacePattern = {
        id: generateId('face_pattern'),
        name: `pattern_${current.facePatterns.length + 1}`,
        paletteId: current.facePalettes[0]?.id ?? '',
        layoutMode: 'edges',
        faces: [null, null, null, null, null, null, null, null],
      };
      return {
        ...state, isDirty: true,
        model: {
          ...state.model,
          variegatedCells: { ...current, facePatterns: [...current.facePatterns, newPattern] },
        },
      };
    }

    case 'DUPLICATE_FACE_PATTERN': {
      const current = state.model.variegatedCells;
      if (!current) return state;
      const src = current.facePatterns.find(p => p.id === action.sourceId);
      if (!src) return state;
      const dup: FacePattern = {
        id: generateId((src.name || 'face_pattern') + '_copy'),
        name: src.name + ' (copy)',
        paletteId: src.paletteId,
        layoutMode: src.layoutMode,
        faces: [...src.faces],
      };
      return {
        ...state, isDirty: true,
        model: {
          ...state.model,
          variegatedCells: { ...current, facePatterns: [...current.facePatterns, dup] },
        },
      };
    }

    case 'REMOVE_FACE_PATTERN': {
      const current = state.model.variegatedCells;
      if (!current) return state;
      const remaining = current.facePatterns.filter(p => p.id !== action.id);
      // Cascade: clear facePatternAssignments entries that referenced the deleted pattern.
      const attributes = state.model.attributes.map(a => {
        if (!a.facePatternAssignments) return a;
        let touched = false;
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(a.facePatternAssignments)) {
          if (v === action.id) { touched = true; continue; }
          next[k] = v;
        }
        return touched ? { ...a, facePatternAssignments: next } : a;
      });
      return {
        ...state, isDirty: true,
        model: {
          ...state.model,
          attributes,
          variegatedCells: { ...current, facePatterns: remaining },
        },
      };
    }

    case 'UPDATE_FACE_PATTERN': {
      const current = state.model.variegatedCells;
      if (!current) return state;
      const facePatterns = current.facePatterns.map(p =>
        p.id === action.id ? { ...p, ...action.changes } : p,
      );
      return {
        ...state, isDirty: true,
        model: { ...state.model, variegatedCells: { ...current, facePatterns } },
      };
    }
  }
}

/** Reorder an array of { id } items by the given ID list. Items not in newOrder
 *  are appended at the end in their current order (defensive against drift). */
function reorderById<T extends { id: string }>(items: T[], newOrder: string[]): T[] {
  const byId = new Map(items.map(x => [x.id, x]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of newOrder) {
    const item = byId.get(id);
    if (item && !seen.has(id)) { out.push(item); seen.add(id); }
  }
  for (const item of items) {
    if (!seen.has(item.id)) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

export interface ModelContextValue {
  model: CAModel;
  isDirty: boolean;
  modelVersion: number;
  /** File the model was loaded from / last saved to (top-bar display only). */
  loadedFileName: string | null;
  updateProperties: (changes: Partial<ModelProperties>) => void;
  addAttribute: (isModelAttribute: boolean) => void;
  duplicateAttribute: (sourceId: string) => void;
  removeAttribute: (id: string) => void;
  updateAttribute: (id: string, changes: Partial<Attribute>) => void;
  /** Generic Agent Platform: agent attribute set (CAModel.agentAttributes). */
  addAgentAttribute: () => void;
  duplicateAgentAttribute: (sourceId: string) => void;
  removeAgentAttribute: (id: string) => void;
  updateAgentAttribute: (id: string, changes: Partial<Attribute>) => void;
  addNeighborhood: () => void;
  duplicateNeighborhood: (sourceId: string) => void;
  removeNeighborhood: (id: string) => void;
  updateNeighborhood: (id: string, changes: Partial<Neighborhood>) => void;
  addMapping: (isAttributeToColor: boolean) => void;
  duplicateMapping: (sourceId: string) => void;
  removeMapping: (id: string) => void;
  updateMapping: (id: string, changes: Partial<Mapping>) => void;
  addAgentMapping: () => void;
  duplicateAgentMapping: (sourceId: string) => void;
  removeAgentMapping: (id: string) => void;
  updateAgentMapping: (id: string, changes: Partial<Mapping>) => void;
  addSprite: (sprite: SpriteAsset) => void;
  removeSprite: (id: string) => void;
  updateSprite: (id: string, changes: Partial<SpriteAsset>) => void;
  setGraph: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  /** Bond-Graph Agents: write-back for the agent rule graph (the second graph). */
  setAgentGraph: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  /** Bond-Graph Agents: partial update of the center-based config (force law,
   *  ceilings, world bounds, bond params). Seeds the object when absent. */
  updateCenterBased: (changes: Partial<CenterBasedConfig>) => void;
  addMacro: (macro: MacroDef) => void;
  /** Deep-clones a MacroDef with fresh IDs and adds it to the project.
   *  Returns the new macroDef id (for referencing from a MacroNode). */
  importMacro: (raw: MacroDef) => string;
  updateMacro: (id: string, changes: Partial<MacroDef>) => void;
  removeMacro: (id: string) => void;
  addIndicator: (kind: IndicatorKind) => void;
  duplicateIndicator: (sourceId: string) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, changes: Partial<Indicator>) => void;
  newModel: () => void;
  loadModel: (model: CAModel, fileName?: string) => void;
  markSaved: (fileName?: string) => void;
  setSimulationState: (state: SimulationState | undefined) => void;
  addPreset: (preset: Preset) => void;
  duplicatePreset: (sourceId: string) => void;
  deletePreset: (id: string) => void;
  updatePreset: (id: string, patch: Partial<Omit<Preset, 'id'>>) => void;
  reorderPresets: (newOrder: string[]) => void;
  reorderAttributes: (newOrder: string[]) => void;
  reorderAgentAttributes: (newOrder: string[]) => void;
  reorderNeighborhoods: (newOrder: string[]) => void;
  reorderMappings: (newOrder: string[]) => void;
  reorderIndicators: (newOrder: string[]) => void;
  reorderEndConditions: (newOrder: string[]) => void;
  /** Variegated Cells — partial update for top-level config (enabled,
   *  sourceAttributeId, faceLabels, facePatterns). Initializes the
   *  `variegatedCells` object on the model when absent. */
  updateVariegatedCells: (changes: Partial<VariegatedCellsConfig>) => void;
  addFacePattern: () => void;
  duplicateFacePattern: (sourceId: string) => void;
  removeFacePattern: (id: string) => void;
  updateFacePattern: (id: string, changes: Partial<FacePattern>) => void;
  /** Local Variables — per-cell scratch storage. */
  addVariable: (target?: 'cell' | 'agent') => void;
  duplicateVariable: (sourceId: string, target?: 'cell' | 'agent') => void;
  removeVariable: (id: string, target?: 'cell' | 'agent') => void;
  updateVariable: (id: string, changes: Partial<Variable>, target?: 'cell' | 'agent') => void;
  reorderVariables: (newOrder: string[], target?: 'cell' | 'agent') => void;
  /** Bond-Graph Morphogenesis topology selection (Grid Cells / Agents). ≥1
   *  flag enforced by the reducer. */
  updateTopologyMode: (changes: Partial<TopologyMode>) => void;
}

const ModelContext = createContext<ModelContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function createInitialState(): ModelState {
  return { model: DEFAULT_MODEL, isDirty: false, modelVersion: 0, loadedFileName: null };
}

export function ModelProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(modelReducer, undefined, createInitialState);

  // One-shot cleanup of legacy localStorage keys from older builds. The app no
  // longer auto-persists the model — users save `.gcaproj` manually and are
  // warned on unload if there are unsaved changes. `genesisca_has_launched` was
  // briefly used to gate the default tab but is unused now that every visit
  // lands on the Library.
  useEffect(() => {
    try { localStorage.removeItem('genesisca_autosave'); } catch { /* ok */ }
    try { localStorage.removeItem('genesisca_has_launched'); } catch { /* ok */ }
  }, []);

  // Warn on close/reload when there are unsaved model changes. Modern browsers
  // show a standardized prompt; the message text can't be customised.
  useEffect(() => {
    if (!state.isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [state.isDirty]);

  const updateProperties = useCallback(
    (changes: Partial<ModelProperties>) =>
      dispatch({ type: 'UPDATE_PROPERTIES', changes }),
    [],
  );
  const addAttribute = useCallback(
    (isModelAttribute: boolean) =>
      dispatch({ type: 'ADD_ATTRIBUTE', isModelAttribute }),
    [],
  );
  const duplicateAttribute = useCallback(
    (sourceId: string) => dispatch({ type: 'DUPLICATE_ATTRIBUTE', sourceId }),
    [],
  );
  const removeAttribute = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_ATTRIBUTE', id }),
    [],
  );
  const updateAttribute = useCallback(
    (id: string, changes: Partial<Attribute>) =>
      dispatch({ type: 'UPDATE_ATTRIBUTE', id, changes }),
    [],
  );
  const addAgentAttribute = useCallback(() => dispatch({ type: 'ADD_AGENT_ATTRIBUTE' }), []);
  const duplicateAgentAttribute = useCallback((sourceId: string) => dispatch({ type: 'DUPLICATE_AGENT_ATTRIBUTE', sourceId }), []);
  const removeAgentAttribute = useCallback((id: string) => dispatch({ type: 'REMOVE_AGENT_ATTRIBUTE', id }), []);
  const updateAgentAttribute = useCallback(
    (id: string, changes: Partial<Attribute>) =>
      dispatch({ type: 'UPDATE_AGENT_ATTRIBUTE', id, changes }),
    [],
  );
  const addNeighborhood = useCallback(
    () => dispatch({ type: 'ADD_NEIGHBORHOOD' }),
    [],
  );
  const duplicateNeighborhood = useCallback(
    (sourceId: string) => dispatch({ type: 'DUPLICATE_NEIGHBORHOOD', sourceId }),
    [],
  );
  const removeNeighborhood = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_NEIGHBORHOOD', id }),
    [],
  );
  const updateNeighborhood = useCallback(
    (id: string, changes: Partial<Neighborhood>) =>
      dispatch({ type: 'UPDATE_NEIGHBORHOOD', id, changes }),
    [],
  );
  const addMapping = useCallback(
    (isAttributeToColor: boolean) =>
      dispatch({ type: 'ADD_MAPPING', isAttributeToColor }),
    [],
  );
  const duplicateMapping = useCallback(
    (sourceId: string) => dispatch({ type: 'DUPLICATE_MAPPING', sourceId }),
    [],
  );
  const removeMapping = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_MAPPING', id }),
    [],
  );
  const updateMapping = useCallback(
    (id: string, changes: Partial<Mapping>) =>
      dispatch({ type: 'UPDATE_MAPPING', id, changes }),
    [],
  );
  const addAgentMapping = useCallback(() => dispatch({ type: 'ADD_AGENT_MAPPING' }), []);
  const duplicateAgentMapping = useCallback((sourceId: string) => dispatch({ type: 'DUPLICATE_AGENT_MAPPING', sourceId }), []);
  const removeAgentMapping = useCallback((id: string) => dispatch({ type: 'REMOVE_AGENT_MAPPING', id }), []);
  const updateAgentMapping = useCallback(
    (id: string, changes: Partial<Mapping>) => dispatch({ type: 'UPDATE_AGENT_MAPPING', id, changes }),
    [],
  );
  const addSprite = useCallback((sprite: SpriteAsset) => dispatch({ type: 'ADD_SPRITE', sprite }), []);
  const removeSprite = useCallback((id: string) => dispatch({ type: 'REMOVE_SPRITE', id }), []);
  const updateSprite = useCallback(
    (id: string, changes: Partial<SpriteAsset>) => dispatch({ type: 'UPDATE_SPRITE', id, changes }),
    [],
  );
  const setGraph = useCallback(
    (nodes: GraphNode[], edges: GraphEdge[]) =>
      dispatch({ type: 'SET_GRAPH', nodes, edges }),
    [],
  );
  const setAgentGraph = useCallback(
    (nodes: GraphNode[], edges: GraphEdge[]) =>
      dispatch({ type: 'SET_AGENT_GRAPH', nodes, edges }),
    [],
  );
  const updateCenterBased = useCallback(
    (changes: Partial<CenterBasedConfig>) =>
      dispatch({ type: 'UPDATE_CENTER_BASED', changes }),
    [],
  );
  const addMacro = useCallback(
    (macro: MacroDef) => dispatch({ type: 'ADD_MACRO', macro }),
    [],
  );
  const importMacro = useCallback(
    (raw: MacroDef): string => {
      const fresh = cloneMacroWithFreshIds(raw);
      dispatch({ type: 'ADD_MACRO', macro: fresh });
      return fresh.id;
    },
    [],
  );
  const updateMacro = useCallback(
    (id: string, changes: Partial<MacroDef>) =>
      dispatch({ type: 'UPDATE_MACRO', id, changes }),
    [],
  );
  const removeMacro = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_MACRO', id }),
    [],
  );
  const addIndicator = useCallback(
    (kind: IndicatorKind) => dispatch({ type: 'ADD_INDICATOR', kind }),
    [],
  );
  const duplicateIndicator = useCallback(
    (sourceId: string) => dispatch({ type: 'DUPLICATE_INDICATOR', sourceId }),
    [],
  );
  const removeIndicator = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_INDICATOR', id }),
    [],
  );
  const updateIndicator = useCallback(
    (id: string, changes: Partial<Indicator>) =>
      dispatch({ type: 'UPDATE_INDICATOR', id, changes }),
    [],
  );
  const newModel = useCallback(() => {
    // Clear every cached GraphEditor viewport and scope so the next
    // ModelerView mount auto-fits the fresh graph from root scope, instead
    // of restoring pan/zoom that was appropriate for the previous model's
    // node layout (or dumping the user into a macro from the prior session
    // that no longer exists in the new model).
    clearAllSavedGraphViewports();
    setSavedCurrentScope(['root']);
    dispatch({ type: 'NEW_MODEL' });
  }, []);
  const loadModel = useCallback(
    (model: CAModel, fileName?: string) => {
      clearAllSavedGraphViewports();
      setSavedCurrentScope(['root']);
      dispatch({ type: 'LOAD_MODEL', model, fileName });
    },
    [],
  );
  const markSaved = useCallback(
    (fileName?: string) => dispatch({ type: 'MARK_SAVED', fileName }),
    [],
  );
  const setSimulationState = useCallback(
    (simState: SimulationState | undefined) =>
      dispatch({ type: 'SET_SIMULATION_STATE', state: simState }),
    [],
  );
  const addPreset = useCallback(
    (preset: Preset) => dispatch({ type: 'ADD_PRESET', preset }),
    [],
  );
  const duplicatePreset = useCallback(
    (sourceId: string) => dispatch({ type: 'DUPLICATE_PRESET', sourceId }),
    [],
  );
  const deletePreset = useCallback(
    (id: string) => dispatch({ type: 'DELETE_PRESET', id }),
    [],
  );
  const updatePreset = useCallback(
    (id: string, patch: Partial<Omit<Preset, 'id'>>) =>
      dispatch({ type: 'UPDATE_PRESET', id, patch }),
    [],
  );
  const reorderPresets = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_PRESETS', newOrder }),
    [],
  );
  const reorderAttributes = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_ATTRIBUTES', newOrder }),
    [],
  );
  const reorderAgentAttributes = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_AGENT_ATTRIBUTES', newOrder }),
    [],
  );
  const reorderNeighborhoods = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_NEIGHBORHOODS', newOrder }),
    [],
  );
  const reorderMappings = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_MAPPINGS', newOrder }),
    [],
  );
  const reorderIndicators = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_INDICATORS', newOrder }),
    [],
  );
  const reorderEndConditions = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_END_CONDITIONS', newOrder }),
    [],
  );
  const updateVariegatedCells = useCallback(
    (changes: Partial<VariegatedCellsConfig>) =>
      dispatch({ type: 'UPDATE_VARIEGATED_CELLS', changes }),
    [],
  );
  const addFacePattern = useCallback(
    () => dispatch({ type: 'ADD_FACE_PATTERN' }),
    [],
  );
  const duplicateFacePattern = useCallback(
    (sourceId: string) => dispatch({ type: 'DUPLICATE_FACE_PATTERN', sourceId }),
    [],
  );
  const removeFacePattern = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_FACE_PATTERN', id }),
    [],
  );
  const updateFacePattern = useCallback(
    (id: string, changes: Partial<FacePattern>) =>
      dispatch({ type: 'UPDATE_FACE_PATTERN', id, changes }),
    [],
  );
  const addVariable = useCallback((target?: 'cell' | 'agent') => dispatch({ type: 'ADD_VARIABLE', target }), []);
  const duplicateVariable = useCallback((sourceId: string, target?: 'cell' | 'agent') => dispatch({ type: 'DUPLICATE_VARIABLE', sourceId, target }), []);
  const removeVariable = useCallback(
    (id: string, target?: 'cell' | 'agent') => dispatch({ type: 'REMOVE_VARIABLE', id, target }), [],
  );
  const updateVariable = useCallback(
    (id: string, changes: Partial<Variable>, target?: 'cell' | 'agent') =>
      dispatch({ type: 'UPDATE_VARIABLE', id, changes, target }), [],
  );
  const reorderVariables = useCallback(
    (newOrder: string[], target?: 'cell' | 'agent') => dispatch({ type: 'REORDER_VARIABLES', newOrder, target }), [],
  );
  const updateTopologyMode = useCallback(
    (changes: Partial<TopologyMode>) => dispatch({ type: 'UPDATE_TOPOLOGY_MODE', changes }), [],
  );

  const value = useMemo<ModelContextValue>(
    () => ({
      model: state.model,
      isDirty: state.isDirty,
      modelVersion: state.modelVersion,
      loadedFileName: state.loadedFileName,
      updateProperties,
      addAttribute,
      duplicateAttribute,
      removeAttribute,
      updateAttribute,
      addAgentAttribute,
      duplicateAgentAttribute,
      removeAgentAttribute,
      updateAgentAttribute,
      addNeighborhood,
      duplicateNeighborhood,
      removeNeighborhood,
      updateNeighborhood,
      addMapping,
      duplicateMapping,
      removeMapping,
      updateMapping,
      addAgentMapping,
      duplicateAgentMapping,
      removeAgentMapping,
      updateAgentMapping,
      addSprite,
      removeSprite,
      updateSprite,
      setGraph,
      setAgentGraph,
      updateCenterBased,
      addMacro,
      importMacro,
      updateMacro,
      removeMacro,
      addIndicator,
      duplicateIndicator,
      removeIndicator,
      updateIndicator,
      newModel,
      loadModel,
      markSaved,
      setSimulationState,
      addPreset,
      duplicatePreset,
      deletePreset,
      updatePreset,
      reorderPresets,
      reorderAttributes,
      reorderAgentAttributes,
      reorderNeighborhoods,
      reorderMappings,
      reorderIndicators,
      reorderEndConditions,
      updateVariegatedCells,
      addFacePattern,
      duplicateFacePattern,
      removeFacePattern,
      updateFacePattern,
      addVariable,
      duplicateVariable,
      removeVariable,
      updateVariable,
      reorderVariables,
      updateTopologyMode,
    }),
    [
      state.model,
      state.isDirty,
      state.modelVersion,
      state.loadedFileName,
      updateProperties,
      addAttribute,
      duplicateAttribute,
      removeAttribute,
      updateAttribute,
      addAgentAttribute,
      duplicateAgentAttribute,
      removeAgentAttribute,
      updateAgentAttribute,
      addNeighborhood,
      duplicateNeighborhood,
      removeNeighborhood,
      updateNeighborhood,
      addMapping,
      duplicateMapping,
      removeMapping,
      updateMapping,
      addAgentMapping,
      duplicateAgentMapping,
      removeAgentMapping,
      updateAgentMapping,
      addSprite,
      removeSprite,
      updateSprite,
      setGraph,
      setAgentGraph,
      updateCenterBased,
      addMacro,
      importMacro,
      updateMacro,
      removeMacro,
      addIndicator,
      duplicateIndicator,
      removeIndicator,
      updateIndicator,
      newModel,
      loadModel,
      markSaved,
      setSimulationState,
      addPreset,
      duplicatePreset,
      deletePreset,
      updatePreset,
      reorderPresets,
      reorderAttributes,
      reorderAgentAttributes,
      reorderNeighborhoods,
      reorderMappings,
      reorderIndicators,
      reorderEndConditions,
      updateVariegatedCells,
      addFacePattern,
      duplicateFacePattern,
      removeFacePattern,
      updateFacePattern,
      addVariable,
      duplicateVariable,
      removeVariable,
      updateVariable,
      reorderVariables,
      updateTopologyMode,
    ],
  );

  return (
    <ModelContext.Provider value={value}>{children}</ModelContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useModel(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) throw new Error('useModel must be used within a ModelProvider');
  return ctx;
}
