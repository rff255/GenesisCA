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
  MacroDef,
  Mapping,
  ModelProperties,
  Neighborhood,
  Preset,
  RGB,
  SimulationState,
  Variable,
  VariegatedCellsConfig,
} from './types';
import { DEFAULT_MODEL, EMPTY_MODEL } from './defaultModel';
import { defaultTagColor } from '../modeler/vpl/compiler/linkedOutputMappings';
import { cloneMacroWithFreshIds } from './macroImport';
import { migrateColorInterpolationNodes } from './colorScaleMigration';
import { migrateTagConstantNodes } from './tagConstantMigration';
import { migrateLookupTables } from './lookupTableMigration';
import { migrateMoveSelfToNeighborNodes } from './moveSelfToNeighborMigration';
import { migrateSetCellLooksNodes } from './setCellLooksMigration';
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

/** Apply patchNodes to both graphNodes and all macroDef subgraphs */
function patchAllNodes(
  model: CAModel,
  pred: (cfg: Record<string, string | number | boolean>, nodeType: string) => boolean,
  patch: (cfg: Record<string, string | number | boolean>, nodeType: string) => Record<string, string | number | boolean>,
): { graphNodes: GraphNode[]; macroDefs: MacroDef[] } {
  const graphNodes = patchNodes(model.graphNodes, pred, patch);
  let macrosChanged = false;
  const macroDefs = (model.macroDefs || []).map(m => {
    const patched = patchNodes(m.nodes, pred, patch);
    if (patched !== m.nodes) { macrosChanged = true; return { ...m, nodes: patched }; }
    return m;
  });
  return { graphNodes, macroDefs: macrosChanged ? macroDefs : (model.macroDefs || []) };
}

/** Clear a config field to '' if it matches a deleted ID */
function clearDeletedId(model: CAModel, field: string, deletedId: string) {
  return patchAllNodes(
    model,
    cfg => cfg[field] === deletedId,
    cfg => { cfg[field] = ''; return cfg; },
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
  | { type: 'REMOVE_ATTRIBUTE'; id: string }
  | { type: 'UPDATE_ATTRIBUTE'; id: string; changes: Partial<Attribute> }
  | { type: 'ADD_NEIGHBORHOOD' }
  | { type: 'DUPLICATE_NEIGHBORHOOD'; sourceId: string }
  | { type: 'REMOVE_NEIGHBORHOOD'; id: string }
  | { type: 'UPDATE_NEIGHBORHOOD'; id: string; changes: Partial<Neighborhood> }
  | { type: 'ADD_MAPPING'; isAttributeToColor: boolean }
  | { type: 'REMOVE_MAPPING'; id: string }
  | { type: 'UPDATE_MAPPING'; id: string; changes: Partial<Mapping> }
  | { type: 'SET_GRAPH'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'ADD_MACRO'; macro: MacroDef }
  | { type: 'UPDATE_MACRO'; id: string; changes: Partial<MacroDef> }
  | { type: 'REMOVE_MACRO'; id: string }
  | { type: 'ADD_INDICATOR'; kind: IndicatorKind }
  | { type: 'REMOVE_INDICATOR'; id: string }
  | { type: 'UPDATE_INDICATOR'; id: string; changes: Partial<Indicator> }
  | { type: 'NEW_MODEL' }
  | { type: 'LOAD_MODEL'; model: CAModel; fileName?: string }
  | { type: 'MARK_SAVED'; fileName?: string }
  | { type: 'SET_SIMULATION_STATE'; state: SimulationState | undefined }
  | { type: 'ADD_PRESET'; preset: Preset }
  | { type: 'DELETE_PRESET'; id: string }
  | { type: 'UPDATE_PRESET'; id: string; patch: Partial<Omit<Preset, 'id'>> }
  | { type: 'REORDER_ATTRIBUTES'; newOrder: string[] }
  | { type: 'REORDER_NEIGHBORHOODS'; newOrder: string[] }
  | { type: 'REORDER_MAPPINGS'; newOrder: string[] }
  | { type: 'REORDER_INDICATORS'; newOrder: string[] }
  | { type: 'REORDER_END_CONDITIONS'; newOrder: string[] }
  | { type: 'ADD_VARIABLE' }
  | { type: 'REMOVE_VARIABLE'; id: string }
  | { type: 'UPDATE_VARIABLE'; id: string; changes: Partial<Variable> }
  | { type: 'REORDER_VARIABLES'; newOrder: string[] }
  | { type: 'UPDATE_VARIEGATED_CELLS'; changes: Partial<VariegatedCellsConfig> }
  | { type: 'ADD_FACE_PATTERN' }
  | { type: 'REMOVE_FACE_PATTERN'; id: string }
  | { type: 'UPDATE_FACE_PATTERN'; id: string; changes: Partial<FacePattern> }
  | { type: 'DUPLICATE_FACE_PATTERN'; sourceId: string };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function modelReducer(state: ModelState, action: ModelAction): ModelState {
  switch (action.type) {
    case 'UPDATE_PROPERTIES':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          properties: { ...state.model.properties, ...action.changes },
        },
      };

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
      // Linked Output Mappings cascade: a mapping linked to the removed attribute
      // is fully unlinked (so it falls back to a Standalone empty pass, not a
      // dangling read). The transform also guards this, but clearing keeps the
      // saved model honest.
      const mappingsAfterRemove = state.model.mappings.map(m =>
        m.linkedAttributeId === action.id
          ? { ...m, linked: false, linkedAttributeId: undefined, linkedColors: undefined, linkedMin: undefined, linkedMax: undefined }
          : m,
      );
      const modelAfterFilter = { ...state.model, attributes: filteredAttrs, variegatedCells, variables, mappings: mappingsAfterRemove };
      // Clear stale attributeId and tagAttributeId references in node configs
      const a1 = clearDeletedId(modelAfterFilter, 'attributeId', action.id);
      const a2 = patchAllNodes(
        { ...modelAfterFilter, graphNodes: a1.graphNodes, macroDefs: a1.macroDefs },
        cfg => cfg.tagAttributeId === action.id,
        cfg => { cfg.tagAttributeId = ''; return cfg; },
      );
      return {
        ...state,
        isDirty: true,
        model: { ...modelAfterFilter, graphNodes: a2.graphNodes, macroDefs: a2.macroDefs },
      };
    }

    case 'UPDATE_ATTRIBUTE': {
      const oldAttr = state.model.attributes.find(a => a.id === action.id);
      const updatedModel = {
        ...state.model,
        attributes: state.model.attributes.map(a =>
          a.id === action.id ? { ...a, ...action.changes } : a,
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
        const remappedModel = { ...updatedModel, attributes: remappedAttrs, variables: remappedVariables, mappings: remappedMappings };
        const patched = patchAllNodes(
          remappedModel,
          (cfg, nt) => {
            if ((nt === 'getConstant' && cfg.constType === 'tag' && cfg.tagAttributeId === attrId) ||
                (nt === 'switch' && cfg.tagAttributeId === attrId && cfg.valueType === 'tag')) return true;
            // setAttribute/setNeighborhood/setNeighborByIndex with this tag attr
            if ((nt === 'setAttribute' || nt === 'setNeighborhoodAttribute' || nt === 'setNeighborAttributeByIndex')
                && cfg.attributeId === attrId) return true;
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
            return cfg;
          },
        );
        return {
          ...state, isDirty: true,
          model: { ...remappedModel, graphNodes: patched.graphNodes, macroDefs: patched.macroDefs },
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
        // Linked Output Mappings: tag/bool → other type invalidates the palette;
        // reset colors/domain but keep the link (transform regenerates defaults).
        const mappings = updatedModel.mappings.map(m =>
          m.linkedAttributeId === action.id
            ? { ...m, linkedColors: undefined, linkedMin: undefined, linkedMax: undefined }
            : m,
        );
        return { ...state, isDirty: true, model: { ...updatedModel, attributes: detached, variables, mappings } };
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
        model: { ...mAfterNbr, graphNodes: nbrPatch.graphNodes, macroDefs: nbrPatch.macroDefs },
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

    case 'REMOVE_MAPPING': {
      const mAfterMap = {
        ...state.model,
        mappings: state.model.mappings.filter(m => m.id !== action.id),
      };
      const mapPatch = clearDeletedId(mAfterMap, 'mappingId', action.id);
      return {
        ...state, isDirty: true,
        model: { ...mAfterMap, graphNodes: mapPatch.graphNodes, macroDefs: mapPatch.macroDefs },
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

    case 'REMOVE_INDICATOR': {
      const mAfterInd = {
        ...state.model,
        indicators: (state.model.indicators || []).filter(i => i.id !== action.id),
      };
      const indPatch = clearDeletedId(mAfterInd, 'indicatorId', action.id);
      return {
        ...state, isDirty: true,
        model: { ...mAfterInd, graphNodes: indPatch.graphNodes, macroDefs: indPatch.macroDefs },
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
      if (!m.properties.tags) m.properties.tags = [];
      if (!m.properties.updateMode) m.properties.updateMode = 'synchronous';
      if (!m.properties.asyncScheme) m.properties.asyncScheme = 'random-order';
      // v1.8: rename/add — silently drop legacy `goal`, default new `modelAuthor` to ''.
      if ('goal' in m.properties) delete (m.properties as unknown as Record<string, unknown>).goal;
      if (m.properties.modelAuthor === undefined) m.properties.modelAuthor = '';
      for (const n of m.neighborhoods) { n.margin ??= 2; n.includeCentralCell ??= false; }
      for (const a of m.attributes) {
        if (a.type === 'tag' && !a.tagOptions) a.tagOptions = [];
      }
      // Groups are free-floating area markers now — translate any legacy
      // child positions (relative to a group) back to absolute and drop
      // data.parentId. Visual layout is preserved.
      m = migrateLegacyParentIds(m);
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

    case 'REORDER_ATTRIBUTES':
      return {
        ...state,
        isDirty: true,
        model: { ...state.model, attributes: reorderById(state.model.attributes, action.newOrder) },
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
      const current = state.model.variables || [];
      const newVar: Variable = {
        id: generateId('variable'),
        name: `var_${current.length + 1}`,
        kind: 'scalar',
        dataType: 'float',
        initialValue: '0',
      };
      return {
        ...state, isDirty: true,
        model: { ...state.model, variables: [...current, newVar] },
      };
    }

    case 'REMOVE_VARIABLE': {
      const mAfter: CAModel = {
        ...state.model,
        variables: (state.model.variables || []).filter(v => v.id !== action.id),
      };
      const patch = clearDeletedId(mAfter, 'variableId', action.id);
      return {
        ...state, isDirty: true,
        model: { ...mAfter, graphNodes: patch.graphNodes, macroDefs: patch.macroDefs },
      };
    }

    case 'UPDATE_VARIABLE': {
      const current = state.model.variables || [];
      // When kind changes from array→scalar, drop `length`. When dataType is no
      // longer tag, drop `attributeId`. Lets the inspector "settle" without the
      // user manually clearing now-irrelevant fields.
      const variables = current.map(v => {
        if (v.id !== action.id) return v;
        const next: Variable = { ...v, ...action.changes };
        if (next.kind === 'scalar') delete next.length;
        else if (next.length === undefined) next.length = 4;
        if (next.dataType !== 'tag') delete next.attributeId;
        return next;
      });
      return { ...state, isDirty: true, model: { ...state.model, variables } };
    }

    case 'REORDER_VARIABLES': {
      return {
        ...state, isDirty: true,
        model: { ...state.model, variables: reorderById(state.model.variables || [], action.newOrder) },
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
  removeAttribute: (id: string) => void;
  updateAttribute: (id: string, changes: Partial<Attribute>) => void;
  addNeighborhood: () => void;
  duplicateNeighborhood: (sourceId: string) => void;
  removeNeighborhood: (id: string) => void;
  updateNeighborhood: (id: string, changes: Partial<Neighborhood>) => void;
  addMapping: (isAttributeToColor: boolean) => void;
  removeMapping: (id: string) => void;
  updateMapping: (id: string, changes: Partial<Mapping>) => void;
  setGraph: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  addMacro: (macro: MacroDef) => void;
  /** Deep-clones a MacroDef with fresh IDs and adds it to the project.
   *  Returns the new macroDef id (for referencing from a MacroNode). */
  importMacro: (raw: MacroDef) => string;
  updateMacro: (id: string, changes: Partial<MacroDef>) => void;
  removeMacro: (id: string) => void;
  addIndicator: (kind: IndicatorKind) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, changes: Partial<Indicator>) => void;
  newModel: () => void;
  loadModel: (model: CAModel, fileName?: string) => void;
  markSaved: (fileName?: string) => void;
  setSimulationState: (state: SimulationState | undefined) => void;
  addPreset: (preset: Preset) => void;
  deletePreset: (id: string) => void;
  updatePreset: (id: string, patch: Partial<Omit<Preset, 'id'>>) => void;
  reorderAttributes: (newOrder: string[]) => void;
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
  addVariable: () => void;
  removeVariable: (id: string) => void;
  updateVariable: (id: string, changes: Partial<Variable>) => void;
  reorderVariables: (newOrder: string[]) => void;
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
  const removeAttribute = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_ATTRIBUTE', id }),
    [],
  );
  const updateAttribute = useCallback(
    (id: string, changes: Partial<Attribute>) =>
      dispatch({ type: 'UPDATE_ATTRIBUTE', id, changes }),
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
  const removeMapping = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_MAPPING', id }),
    [],
  );
  const updateMapping = useCallback(
    (id: string, changes: Partial<Mapping>) =>
      dispatch({ type: 'UPDATE_MAPPING', id, changes }),
    [],
  );
  const setGraph = useCallback(
    (nodes: GraphNode[], edges: GraphEdge[]) =>
      dispatch({ type: 'SET_GRAPH', nodes, edges }),
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
  const deletePreset = useCallback(
    (id: string) => dispatch({ type: 'DELETE_PRESET', id }),
    [],
  );
  const updatePreset = useCallback(
    (id: string, patch: Partial<Omit<Preset, 'id'>>) =>
      dispatch({ type: 'UPDATE_PRESET', id, patch }),
    [],
  );
  const reorderAttributes = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_ATTRIBUTES', newOrder }),
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
  const addVariable = useCallback(() => dispatch({ type: 'ADD_VARIABLE' }), []);
  const removeVariable = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_VARIABLE', id }), [],
  );
  const updateVariable = useCallback(
    (id: string, changes: Partial<Variable>) =>
      dispatch({ type: 'UPDATE_VARIABLE', id, changes }), [],
  );
  const reorderVariables = useCallback(
    (newOrder: string[]) => dispatch({ type: 'REORDER_VARIABLES', newOrder }), [],
  );

  const value = useMemo<ModelContextValue>(
    () => ({
      model: state.model,
      isDirty: state.isDirty,
      modelVersion: state.modelVersion,
      loadedFileName: state.loadedFileName,
      updateProperties,
      addAttribute,
      removeAttribute,
      updateAttribute,
      addNeighborhood,
      duplicateNeighborhood,
      removeNeighborhood,
      updateNeighborhood,
      addMapping,
      removeMapping,
      updateMapping,
      setGraph,
      addMacro,
      importMacro,
      updateMacro,
      removeMacro,
      addIndicator,
      removeIndicator,
      updateIndicator,
      newModel,
      loadModel,
      markSaved,
      setSimulationState,
      addPreset,
      deletePreset,
      updatePreset,
      reorderAttributes,
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
      removeVariable,
      updateVariable,
      reorderVariables,
    }),
    [
      state.model,
      state.isDirty,
      state.modelVersion,
      state.loadedFileName,
      updateProperties,
      addAttribute,
      removeAttribute,
      updateAttribute,
      addNeighborhood,
      duplicateNeighborhood,
      removeNeighborhood,
      updateNeighborhood,
      addMapping,
      removeMapping,
      updateMapping,
      setGraph,
      addMacro,
      importMacro,
      updateMacro,
      removeMacro,
      addIndicator,
      removeIndicator,
      updateIndicator,
      newModel,
      loadModel,
      markSaved,
      setSimulationState,
      addPreset,
      deletePreset,
      updatePreset,
      reorderAttributes,
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
      removeVariable,
      updateVariable,
      reorderVariables,
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
