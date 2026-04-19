/** Attribute data types supported by GenesisCA */
export type AttributeType = 'bool' | 'integer' | 'float' | 'tag' | 'color';

/** A single attribute definition (per-cell or global model attribute) */
export interface Attribute {
  id: string;
  name: string;
  type: AttributeType;
  description: string;
  isModelAttribute: boolean;
  defaultValue: string;
  /** Tag type: named values (value = index into this array) */
  tagOptions?: string[];
  /** Whether numerical bounds are enabled (integer/float model attributes only) */
  hasBounds?: boolean;
  /** Lower bound when hasBounds is true */
  min?: number;
  /** Upper bound when hasBounds is true */
  max?: number;
}

/** A neighborhood definition — list of relative offsets from the central cell */
export interface Neighborhood {
  id: string;
  name: string;
  description: string;
  coords: Array<[number, number]>;
  margin?: number;
  /** Optional tags for individual cells: coord index → tag name */
  tags?: Record<number, string>;
}

/** A color mapping (attribute-to-color for visualization, or color-to-attribute for interaction) */
export interface Mapping {
  id: string;
  name: string;
  description: string;
  isAttributeToColor: boolean;
  redDescription: string;
  greenDescription: string;
  blueDescription: string;
}

export type BoundaryTreatment = 'constant' | 'torus';
export type Topology = '2d-grid';
export type UpdateMode = 'synchronous' | 'asynchronous';
export type AsyncScheme = 'random-order' | 'random-independent' | 'cyclic';

/** Top-level model properties */
export interface ModelProperties {
  name: string;
  author: string;
  goal: string;
  description: string;
  topology: Topology;
  boundaryTreatment: BoundaryTreatment;
  updateMode: UpdateMode;
  asyncScheme: AsyncScheme;
  gridWidth: number;
  gridHeight: number;
  maxIterations: number;
  tags: string[];
}

/** A serialized node in the update rules graph */
export interface GraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { nodeType: string; config: Record<string, string | number | boolean> };
}

/** A serialized edge in the update rules graph */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

/** An exposed port on a macro — maps to an internal node's port */
export interface MacroPort {
  portId: string;
  label: string;
  dataType: string;
  category: 'value' | 'flow';
  internalNodeId: string;    // which internal node this maps to
  internalPortId: string;    // which handle on that internal node
}

/** A reusable macro (subgraph) definition */
export interface MacroDef {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  exposedInputs: MacroPort[];
  exposedOutputs: MacroPort[];
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export type IndicatorKind = 'standalone' | 'linked';
export type LinkedAggregation = 'frequency' | 'total';
export type AccumulationMode = 'per-generation' | 'accumulated';

/** An indicator definition — monitors CA evolution quantitatively */
export interface Indicator {
  id: string;
  name: string;
  kind: IndicatorKind;
  dataType: AttributeType;              // standalone: user-chosen; linked: derived from linked attr (excludes 'color')
  defaultValue: string;                 // standalone: initial/reset value (same format as Attribute.defaultValue)
  accumulationMode: AccumulationMode;
  tagOptions?: string[];                // standalone tag type: named values (like Attribute.tagOptions)
  // Linked-only fields:
  linkedAttributeId?: string;
  linkedAggregation?: LinkedAggregation;
  binCount?: number;                    // float + frequency: number of histogram bins (default 10)
  // Display:
  watched: boolean;                     // eye toggle — controls display in simulator
}

// ---------------------------------------------------------------------------
// Simulation State (Save/Load)
// ---------------------------------------------------------------------------

/** Serialized typed array entry (base64-encoded) */
export interface SerializedTypedArray {
  type: 'uint8' | 'int32' | 'float64';
  data: string;
}

/** Complete simulation state snapshot for .gcastate files.
 *  All fields are optional so the Save Project dialog can include just the grid
 *  state, just the simulator UI controls, both, or neither. */
export interface SimulationState {
  // Grid state
  generation?: number;
  width?: number;
  height?: number;
  attributes?: Record<string, SerializedTypedArray>;
  indicators?: Record<string, number>;
  linkedAccumulators?: Record<string, number | Record<string, number>>;
  colors?: string;
  orderArray?: string;
  // Simulator controls (runtime model-attribute values + UI)
  modelAttrs?: Record<string, number>;
  activeViewer?: string;
  brushColor?: string;
  brushW?: number;
  brushH?: number;
  brushMapping?: string;
  targetFps?: number;
  unlimitedFps?: boolean;
  gensPerFrame?: number;
  unlimitedGens?: boolean;
}

/** A named snapshot of model-attribute values (always) and optionally the cell
 *  grid. Presets let one model ship many parameter variants the user can switch
 *  between in the Simulator (e.g. MNCA threshold sets), without duplicating the
 *  model into separate library entries. */
export interface Preset {
  id: string;
  name: string;
  description?: string;
  /** Embedded SimulationState — always includes modelAttrs; includes grid fields
   *  only when the user checked "Include cell grid state" at save time. Never
   *  includes UI controls (brush, viewer, FPS). */
  state: SimulationState;
  createdAt: number;
}

/** Complete CA model definition */
export interface CAModel {
  schemaVersion: number;
  properties: ModelProperties;
  attributes: Attribute[];
  neighborhoods: Neighborhood[];
  mappings: Mapping[];
  indicators: Indicator[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  macroDefs: MacroDef[];
  simulationState?: SimulationState;
  presets?: Preset[];
}
