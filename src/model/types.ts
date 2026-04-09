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
}

/** A neighborhood definition — list of relative offsets from the central cell */
export interface Neighborhood {
  id: string;
  name: string;
  description: string;
  coords: Array<[number, number]>;
  margin?: number;
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

/** Top-level model properties */
export interface ModelProperties {
  name: string;
  author: string;
  goal: string;
  description: string;
  topology: Topology;
  boundaryTreatment: BoundaryTreatment;
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

/** Complete CA model definition */
export interface CAModel {
  schemaVersion: number;
  properties: ModelProperties;
  attributes: Attribute[];
  neighborhoods: Neighborhood[];
  mappings: Mapping[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  macroDefs: MacroDef[];
}
