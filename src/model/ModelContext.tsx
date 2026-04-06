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
  Mapping,
  ModelProperties,
  Neighborhood,
} from './types';
import { DEFAULT_MODEL } from './defaultModel';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let nextId = 1;
function generateId(prefix: string): string {
  const base = prefix
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return `${base || 'item'}_${nextId++}`;
}

// ---------------------------------------------------------------------------
// State & actions
// ---------------------------------------------------------------------------

interface ModelState {
  model: CAModel;
  isDirty: boolean;
}

type ModelAction =
  | { type: 'UPDATE_PROPERTIES'; changes: Partial<ModelProperties> }
  | { type: 'ADD_ATTRIBUTE'; isModelAttribute: boolean }
  | { type: 'REMOVE_ATTRIBUTE'; id: string }
  | { type: 'UPDATE_ATTRIBUTE'; id: string; changes: Partial<Attribute> }
  | { type: 'ADD_NEIGHBORHOOD' }
  | { type: 'REMOVE_NEIGHBORHOOD'; id: string }
  | { type: 'UPDATE_NEIGHBORHOOD'; id: string; changes: Partial<Neighborhood> }
  | { type: 'ADD_MAPPING'; isAttributeToColor: boolean }
  | { type: 'REMOVE_MAPPING'; id: string }
  | { type: 'UPDATE_MAPPING'; id: string; changes: Partial<Mapping> }
  | { type: 'SET_GRAPH'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'NEW_MODEL' }
  | { type: 'LOAD_MODEL'; model: CAModel }
  | { type: 'MARK_SAVED' };

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

    case 'REMOVE_ATTRIBUTE':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          attributes: state.model.attributes.filter(a => a.id !== action.id),
        },
      };

    case 'UPDATE_ATTRIBUTE':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          attributes: state.model.attributes.map(a =>
            a.id === action.id ? { ...a, ...action.changes } : a,
          ),
        },
      };

    case 'ADD_NEIGHBORHOOD': {
      const newNbr: Neighborhood = {
        id: generateId('new_neighborhood'),
        name: 'new_neighborhood',
        description: '',
        coords: [],
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

    case 'REMOVE_NEIGHBORHOOD':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          neighborhoods: state.model.neighborhoods.filter(
            n => n.id !== action.id,
          ),
        },
      };

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

    case 'REMOVE_MAPPING':
      return {
        ...state,
        isDirty: true,
        model: {
          ...state.model,
          mappings: state.model.mappings.filter(m => m.id !== action.id),
        },
      };

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

    case 'NEW_MODEL':
      return { model: DEFAULT_MODEL, isDirty: false };

    case 'LOAD_MODEL':
      return { model: action.model, isDirty: false };

    case 'MARK_SAVED':
      return { ...state, isDirty: false };
  }
}

// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

export interface ModelContextValue {
  model: CAModel;
  isDirty: boolean;
  updateProperties: (changes: Partial<ModelProperties>) => void;
  addAttribute: (isModelAttribute: boolean) => void;
  removeAttribute: (id: string) => void;
  updateAttribute: (id: string, changes: Partial<Attribute>) => void;
  addNeighborhood: () => void;
  removeNeighborhood: (id: string) => void;
  updateNeighborhood: (id: string, changes: Partial<Neighborhood>) => void;
  addMapping: (isAttributeToColor: boolean) => void;
  removeMapping: (id: string) => void;
  updateMapping: (id: string, changes: Partial<Mapping>) => void;
  setGraph: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  newModel: () => void;
  loadModel: (model: CAModel) => void;
  markSaved: () => void;
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
        return { model, isDirty: false };
      }
    }
  } catch {
    // ignore parse errors — fall through to default
  }
  return { model: DEFAULT_MODEL, isDirty: false };
}

export function ModelProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(modelReducer, undefined, createInitialState);

  // Auto-save to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('genesisca_autosave', JSON.stringify(state.model));
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

  const value = useMemo<ModelContextValue>(
    () => ({
      model: state.model,
      isDirty: state.isDirty,
      updateProperties,
      addAttribute,
      removeAttribute,
      updateAttribute,
      addNeighborhood,
      removeNeighborhood,
      updateNeighborhood,
      addMapping,
      removeMapping,
      updateMapping,
      setGraph,
      newModel,
      loadModel,
      markSaved,
    }),
    [
      state.model,
      state.isDirty,
      updateProperties,
      addAttribute,
      removeAttribute,
      updateAttribute,
      addNeighborhood,
      removeNeighborhood,
      updateNeighborhood,
      addMapping,
      removeMapping,
      updateMapping,
      setGraph,
      newModel,
      loadModel,
      markSaved,
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
