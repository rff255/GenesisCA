/** Attribute data types supported by GenesisCA.
 *
 *  `neighborIndex` is stored at runtime as an `Int32Array` (one packed value
 *  per cell) holding `(dr << 16) | (dc & 0xFFFF)` — a sign-extended (dr, dc)
 *  offset pair. Position-only, neighborhood-agnostic. The editor can show a
 *  neighborhood-anchored grid for default-value picking via
 *  `Attribute.neighborhoodHintId`, but the hint is purely UI; the runtime
 *  value is just the packed offset. */
export type AttributeType = 'bool' | 'integer' | 'float' | 'tag' | 'color' | 'neighborIndex' | 'interactionTable';

/** A single attribute definition (per-cell or global model attribute) */
export interface Attribute {
  id: string;
  name: string;
  type: AttributeType;
  description: string;
  isModelAttribute: boolean;
  defaultValue: string;
  /** Cell attributes only: value held by out-of-grid cells when boundary
   *  treatment is "constant". When undefined/empty, falls back to defaultValue.
   *  Hidden in the UI unless the model's boundary is set to constant. */
  boundaryValue?: string;
  /** Tag type: named values (value = index into this array) */
  tagOptions?: string[];
  /** Whether numerical bounds are enabled (integer/float model attributes only) */
  hasBounds?: boolean;
  /** Lower bound when hasBounds is true */
  min?: number;
  /** Upper bound when hasBounds is true */
  max?: number;
  /** NeighborIndex attributes only: optional neighborhood id used by the editor's
   *  clickable-grid picker to highlight which offsets belong to a familiar
   *  neighborhood. Not load-bearing at runtime — the stored value is a packed
   *  (dr, dc) i32 offset, independent of any neighborhood. */
  neighborhoodHintId?: string;
  /** Sub-attribute marker — when set, this cell attribute is "only well-defined"
   *  on cells whose parent attribute is in `parentValues`. Reads on non-matching
   *  cells return `undefinedValue`; writes always proceed (storage at non-matching
   *  indices is invisible to reads). Parent must be a Tag or Boolean cell
   *  attribute that is itself not a sub-attribute. Model attributes can't be
   *  sub-attributes. */
  parentAttributeId?: string;
  /** Parent attribute values that "enable" this sub-attribute. Each entry uses
   *  the same string encoding as `defaultValue` — tag indices like "0"/"1"/"2"
   *  for tag parents, or "true"/"false" for bool parents. Multi-value when the
   *  sub-attribute is meaningful on more than one parent value (e.g. charge on
   *  Wire AND Capacitor). */
  parentValues?: string[];
  /** Sub-attributes only: the value returned by a read when the parent's value
   *  is NOT in `parentValues`. Same string encoding as `defaultValue`. */
  undefinedValue?: string;
  /** Variegated Cells: when this attribute is the variegation source (its id
   *  matches `model.variegatedCells.sourceAttributeId`), this map assigns a
   *  `FacePattern.id` to each `tagOption` string. Tag values without an entry
   *  (or with an empty / unresolved id) are treated as non-variegated. Lives
   *  on Attribute because face patterns are inherently per-species. */
  facePatternAssignments?: Record<string, string>;
  /** Interaction Table model attributes only: when true, the editor mirrors
   *  table[A][B] = table[B][A] on edit (default true). Doesn't affect runtime
   *  storage layout (the worker holds a full square Float64Array regardless). */
  symmetric?: boolean;
  /** Interaction Table model attributes only: sparse table values, keyed by
   *  face-label string × face-label string → float. Missing entries default
   *  to 0. The implicit `none` label uses the literal key `"none"`. */
  tableValues?: Record<string, Record<string, number>>;
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
  /** When true, the central cell ([0,0]) is appended to the effective
   *  neighborhood, so neighbor-iterating nodes treat the cell itself as a
   *  member. Default false. Expanded into `coords` at the sim boundary. */
  includeCentralCell?: boolean;
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

/** Comparison operator used in an indicator-based end condition. */
export type EndConditionOp = '==' | '!=' | '>' | '<' | '>=' | '<=';

/** A single indicator-based stop condition.
 *
 *  Scalar indicators: `<indicatorValue> <op> <value>`.
 *
 *  Linked-frequency indicators (value is `Record<category, count>`): the
 *  `category` field names a specific bucket, and the comparison becomes
 *  `frequencyMap[category] <op> <value>`. Example: bool indicator "Alive",
 *  category `true`, op `>=`, value `100` → pause when ≥100 cells are alive. */
export interface IndicatorEndCondition {
  id: string;
  indicatorId: string;
  op: EndConditionOp;
  /** Serialized as a string so int / float / tag / bool all fit one shape.
   *  For scalar indicators: compared to the indicator's numeric value.
   *  For linked-frequency indicators: the target count for `category`. */
  value: string;
  /** Linked-frequency indicators only: the map key to monitor (e.g. `'true'`,
   *  a tag name, or `'42'` for integer frequencies). Absent on scalar conditions. */
  category?: string;
}

/** Optional simulator end conditions. When `enabled` is true, the simulator
 *  auto-pauses as soon as ANY of the configured conditions match. */
export interface EndConditions {
  enabled: boolean;
  /** Max generations: pauses when `generation >= maxGenerations`. Ignored when
   *  undefined or when <= 0. */
  maxGenerations?: number;
  /** Any indicator condition matching triggers the pause (OR semantics). */
  indicatorConditions?: IndicatorEndCondition[];
}

/** Top-level model properties */
export interface ModelProperties {
  name: string;
  /** Author of the rule/model logic (the domain expert or researcher). */
  author: string;
  /** Author of the GenesisCA model file itself (the person who built the graph). */
  modelAuthor: string;
  description: string;
  topology: Topology;
  boundaryTreatment: BoundaryTreatment;
  updateMode: UpdateMode;
  asyncScheme: AsyncScheme;
  gridWidth: number;
  gridHeight: number;
  maxIterations: number;
  tags: string[];
  /** Optional preview image (PNG/JPEG/GIF/WebP, <=2 MB) as a data URL. Shown
   *  on hover in the Models Library. Travels inside the .gcaproj file. */
  thumbnail?: string;
  /** Optional simulator auto-pause rules. Undefined = disabled. */
  endConditions?: EndConditions;
  /** Wave 2: when true, the simulator runs the WASM-compiled step instead of
   *  the JS-compiled step. Off by default. The WASM compiler falls back to JS
   *  silently if the graph references a node type whose WASM emit is not yet
   *  implemented; the user can flip this off at any time to force JS. */
  useWasm?: boolean;
  /** Wave 3: when true, the simulator runs the WGSL-compiled compute shaders
   *  on WebGPU. Mutually exclusive with useWasm — the UI enforces this via a
   *  3-way radio (JS / WASM / WebGPU); a worker-side safety net prefers
   *  WebGPU when both flags are somehow set on a loaded file. Sync mode only:
   *  the UI greys out the async controls when this is on. */
  useWebGPU?: boolean;
  /** WebGPU only: how often (in generations) to read the GPU stop-flag back
   *  to CPU during a step batch. Each readback is a mapAsync round-trip that
   *  stalls the GPU pipeline; raising this trades stop-event timing precision
   *  for throughput. Default 1 (check every step — exact behaviour). With K=8,
   *  a stop event firing at gen 47 may surface at gen 48–54. JS / WASM
   *  ignore this. */
  webgpuStopCheckInterval?: number;
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
  /** Wave A.6: stamped on save by serializeSimState/serializePreset. Loaders
   *  treat absent as v1 (slot-index NI cell-attr arrays) and run a per-element
   *  migration via the loaded model's neighborhoodHintIds. Standalone .gcastate
   *  files saved by older builds carry no version → migrated on load. */
  schemaVersion?: number;
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
  // Model structure controls — saved in presets so a preset can restore its grid
  // dimensions and boundary rule even when cell-grid state isn't embedded.
  boundaryTreatment?: BoundaryTreatment;
  gridWidth?: number;
  gridHeight?: number;
  /** Interaction-table model attribute overrides. Outer key = attribute id; inner
   *  table maps `rowLabel -> colLabel -> float`. Saved in presets so a preset
   *  can swap an entire parameter set (e.g. the 8 Kier 1996 amphiphile sets)
   *  without forcing the user to retype every cell. On apply, this rewrites both
   *  the cached worker tables (via updateInteractionTable) and the model state
   *  (via updateAttribute) so Reset-to-Default snapshots also follow the preset. */
  interactionTables?: Record<string, Record<string, Record<string, number>>>;
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

/** Variegated Cells feature — gated config + face-pattern definitions. Cells
 *  whose source-tag value has an assigned `FacePattern` carry directional
 *  state: an auto-managed orientation (0-3 = 90° rotations) plus face labels
 *  on their 4 edges (and optionally 4 corners). Interactions between adjacent
 *  cells become directional — see HelpView's Variegated Cells section.
 *  When `enabled === false` (or this field is absent), the engine behaves
 *  identically to a non-variegated model — no UI changes, no behavioural
 *  drift. */
export interface FacePattern {
  /** Unique within the model. */
  id: string;
  /** User-facing name (rendered in the Variegated Cells panel and dropdowns). */
  name: string;
  /** `'edges'` exposes only the 4 cardinal slots (N, E, S, W); the 4 corner
   *  slots are locked to `null`. `'edges+corners'` exposes all 8 slots. */
  layoutMode: 'edges' | 'edges+corners';
  /** Length 8: `[N, NE, E, SE, S, SW, W, NW]`. Each entry is a face-label
   *  string from `VariegatedCellsConfig.faceLabels`, or `null` for "no face
   *  at this slot" (treated as the implicit `none` label at runtime). */
  faces: (string | null)[];
}

export interface VariegatedCellsConfig {
  /** Master toggle (single Properties-panel checkbox). When false, all of the
   *  other fields are dormant — they may carry data but the engine ignores it. */
  enabled: boolean;
  /** ID of the Tag cell attribute whose values identify "species" — each tag
   *  option can be assigned a `FacePattern`. Empty string when unset. */
  sourceAttributeId: string;
  /** User-defined face-label palette. The implicit `none` label is always
   *  available (index 0 at runtime) and is NOT stored in this array. */
  faceLabels: string[];
  /** Named face patterns the user can assign to source-attr tag values via
   *  `Attribute.facePatternAssignments`. */
  facePatterns: FacePattern[];
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
  /** Variegated Cells feature config. Absent / `enabled: false` → engine and
   *  UI behave as if the feature didn't exist. See `VariegatedCellsConfig`. */
  variegatedCells?: VariegatedCellsConfig;
}
