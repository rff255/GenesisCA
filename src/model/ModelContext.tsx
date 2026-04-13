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
  GraphEdge,
  GraphNode,
  Indicator,
  IndicatorKind,
  MacroDef,
  Mapping,
  ModelProperties,
  Neighborhood,
  SimulationState,
} from './types';
import { DEFAULT_MODEL, EMPTY_MODEL } from './defaultModel';
import { readModelFile } from './fileOperations';

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
    if (pred(n.data.config, n.data.nodeType)) {
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

// ---------------------------------------------------------------------------
// State & actions
// ---------------------------------------------------------------------------

interface ModelState {
  model: CAModel;
  isDirty: boolean;
  modelVersion: number;
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
  | { type: 'LOAD_MODEL'; model: CAModel }
  | { type: 'MARK_SAVED' }
  | { type: 'SET_SIMULATION_STATE'; state: SimulationState | undefined };

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
      const modelAfterFilter = {
        ...state.model,
        attributes: state.model.attributes.filter(a => a.id !== action.id),
      };
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

      // If tagOptions changed, remap tag indices in node configs
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
        const patched = patchAllNodes(
          updatedModel,
          (cfg, nt) => {
            if ((nt === 'getConstant' && cfg.constType === 'tag' && cfg.tagAttributeId === attrId) ||
                (nt === 'tagConstant' && cfg.attributeId === attrId) ||
                (nt === 'switch' && cfg.tagAttributeId === attrId && cfg.valueType === 'tag')) return true;
            // setAttribute/setNeighborhood/setNeighborByIndex with this tag attr
            if ((nt === 'setAttribute' || nt === 'setNeighborhoodAttribute' || nt === 'setNeighborAttributeByIndex')
                && cfg.attributeId === attrId) return true;
            return false;
          },
          (cfg, nt) => {
            if (nt === 'getConstant') cfg.constValue = remap(cfg.constValue);
            if (nt === 'tagConstant') cfg.tagIndex = Number(remap(cfg.tagIndex));
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
          model: { ...updatedModel, graphNodes: patched.graphNodes, macroDefs: patched.macroDefs },
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
      return { model: EMPTY_MODEL, isDirty: false, modelVersion: state.modelVersion + 1 };

    case 'LOAD_MODEL': {
      const m = action.model;
      // Migration guards for loaded files (same as localStorage)
      if (!m.graphNodes) m.graphNodes = [];
      if (!m.graphEdges) m.graphEdges = [];
      if (!m.macroDefs) m.macroDefs = [];
      if (!m.indicators) m.indicators = [];
      if (!m.properties.tags) m.properties.tags = [];
      if (!m.properties.updateMode) m.properties.updateMode = 'synchronous';
      if (!m.properties.asyncScheme) m.properties.asyncScheme = 'random-order';
      for (const n of m.neighborhoods) { n.margin ??= 2; }
      for (const a of m.attributes) {
        if (a.type === 'tag' && !a.tagOptions) a.tagOptions = [];
      }
      return { model: m, isDirty: false, modelVersion: state.modelVersion + 1 };
    }

    case 'MARK_SAVED':
      return { ...state, isDirty: false };

    case 'SET_SIMULATION_STATE':
      return {
        ...state,
        model: { ...state.model, simulationState: action.state },
      };
  }
}

// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

export interface ModelContextValue {
  model: CAModel;
  isDirty: boolean;
  modelVersion: number;
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
  updateMacro: (id: string, changes: Partial<MacroDef>) => void;
  removeMacro: (id: string) => void;
  addIndicator: (kind: IndicatorKind) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, changes: Partial<Indicator>) => void;
  newModel: () => void;
  loadModel: (model: CAModel) => void;
  markSaved: () => void;
  setSimulationState: (state: SimulationState | undefined) => void;
}

const ModelContext = createContext<ModelContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function createInitialState(): ModelState {
  try {
    const saved = localStorage.getItem('genesisca_autosave');
    if (saved) {
      const model = JSON.parse(saved) as CAModel;
      if (model.schemaVersion && model.properties && model.attributes) {
        // Ensure new fields exist for older saved models
        if (!model.graphNodes) model.graphNodes = [];
        if (!model.graphEdges) model.graphEdges = [];
        if (!model.macroDefs) model.macroDefs = [];
        if (!model.indicators) model.indicators = [];
        if (!model.properties.tags) model.properties.tags = [];
        if (!model.properties.updateMode) model.properties.updateMode = 'synchronous';
        if (!model.properties.asyncScheme) model.properties.asyncScheme = 'random-order';
        for (const n of model.neighborhoods) { n.margin ??= 2; }
        for (const a of model.attributes) {
          if (a.type === 'tag' && !a.tagOptions) a.tagOptions = [];
        }
        return { model, isDirty: false, modelVersion: 0 };
      }
    }
  } catch {
    // ignore parse errors — fall through to default
  }
  return { model: DEFAULT_MODEL, isDirty: false, modelVersion: 0 };
}

const FIRST_LAUNCH_KEY = 'genesisca_has_launched';

export function ModelProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(modelReducer, undefined, createInitialState);

  // On first-ever launch (no autosave), load Game of Life from public/models/
  useEffect(() => {
    const hasAutosave = localStorage.getItem('genesisca_autosave');
    const hasLaunched = localStorage.getItem(FIRST_LAUNCH_KEY);
    if (hasAutosave || hasLaunched) {
      // Not first launch — mark and skip
      if (!hasLaunched) localStorage.setItem(FIRST_LAUNCH_KEY, '1');
      return;
    }
    localStorage.setItem(FIRST_LAUNCH_KEY, '1');

    // Fetch Game of Life .gcaproj
    const base = import.meta.env.BASE_URL;
    fetch(`${base}models/Game Of Life.gcaproj`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(blob => readModelFile(new File([blob], 'Game Of Life.gcaproj')))
      .then(model => dispatch({ type: 'LOAD_MODEL', model }))
      .catch(() => {
        // Silently fall back to the empty default if fetch fails
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save to localStorage (strip simulationState to avoid exceeding quota on large grids)
  useEffect(() => {
    try {
      const { simulationState: _drop, ...modelWithoutState } = state.model;
      localStorage.setItem('genesisca_autosave', JSON.stringify(modelWithoutState));
    } catch {
      // localStorage full or unavailable
    }
  }, [state.model]);

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
    dispatch({ type: 'NEW_MODEL' });
    try { localStorage.removeItem('genesisca_autosave'); } catch { /* ok */ }
  }, []);
  const loadModel = useCallback(
    (model: CAModel) => dispatch({ type: 'LOAD_MODEL', model }),
    [],
  );
  const markSaved = useCallback(
    () => dispatch({ type: 'MARK_SAVED' }),
    [],
  );
  const setSimulationState = useCallback(
    (simState: SimulationState | undefined) =>
      dispatch({ type: 'SET_SIMULATION_STATE', state: simState }),
    [],
  );

  const value = useMemo<ModelContextValue>(
    () => ({
      model: state.model,
      isDirty: state.isDirty,
      modelVersion: state.modelVersion,
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
      updateMacro,
      removeMacro,
      addIndicator,
      removeIndicator,
      updateIndicator,
      newModel,
      loadModel,
      markSaved,
      setSimulationState,
    }),
    [
      state.model,
      state.isDirty,
      state.modelVersion,
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
      updateMacro,
      removeMacro,
      addIndicator,
      removeIndicator,
      updateIndicator,
      newModel,
      loadModel,
      markSaved,
      setSimulationState,
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
