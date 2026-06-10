/** Attribute data types supported by GenesisCA.
 *
 *  `neighborIndex` is stored at runtime as an `Int32Array` (one packed value
 *  per cell) holding `(dr << 16) | (dc & 0xFFFF)` — a sign-extended (dr, dc)
 *  offset pair. Position-only, neighborhood-agnostic. The editor can show a
 *  neighborhood-anchored grid for default-value picking via
 *  `Attribute.neighborhoodHintId`, but the hint is purely UI; the runtime
 *  value is just the packed offset. */
export type AttributeType = 'bool' | 'integer' | 'float' | 'tag' | 'color' | 'neighborIndex' | 'lookupTable';

/** A Lookup Table axis key source. Determines an axis' labels + dimension:
 *  - `facePalette`: labels = `['none', ...palette.labels]` (implicit `none` at 0).
 *  - `tagAttribute`: labels = the referenced tag attribute's `tagOptions` (no
 *    implicit `none`). Lets a table be keyed by cell *type* with no faces at all
 *    (e.g. chromatography PB/J keyed by W/S1/S2/B).
 *  - `single`: a one-element, label-less axis (label = `['value']`). Collapses the
 *    2-D table into a 1-D "map" keyed only by the *other* axis — no bogus
 *    single-option tag attribute needed. */
export type LookupKeySource =
  | { kind: 'facePalette'; paletteId: string }
  | { kind: 'tagAttribute'; attributeId: string }
  | { kind: 'single' };

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
  /** Lookup Table model attributes only: the row-axis key source — a face-label
   *  palette OR a tag attribute. Determines the table's row dimension + the
   *  row-label names used as outer keys in `tableValues`. */
  rowKeySource?: LookupKeySource;
  /** Lookup Table model attributes only: the column-axis key source. May differ
   *  from `rowKeySource` — rectangular tables (e.g. analyte-faces × CD-faces). */
  colKeySource?: LookupKeySource;
  /** Lookup Table model attributes only: when true, the editor mirrors
   *  table[A][B] = table[B][A] on edit (default true). Only meaningful when the
   *  row and column key sources are identical (square). Doesn't affect runtime
   *  storage (the worker holds a full rowDim×colDim Float64Array regardless). */
  symmetric?: boolean;
  /** Lookup Table model attributes only: sparse table values, keyed by
   *  rowLabel string × colLabel string → float. Missing entries default to 0.
   *  A face-palette axis uses the literal `"none"` key at index 0; a
   *  tag-attribute axis uses tag-option names (no implicit `none`). */
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

/** A plain 0–255 RGB triple used by Linked Output Mapping palettes. */
export interface RGB { r: number; g: number; b: number; }

/** A gradient stop for a Linked Output Mapping scale. `position` is in [0,1]
 *  (same space as the Color Scale node) and is mapped onto [linkedMin, linkedMax]
 *  at compile time. */
export interface ColorStop { position: number; r: number; g: number; b: number; }

/** User-overridable colors for a Linked Output Mapping. Absent sub-fields fall
 *  back to auto-generated defaults at compile time (see linkedOutputMappings.ts). */
export interface LinkedColorSet {
  /** bool (2 stops at positions 0/1) / float / integer gradient stops. Stores
   *  the full Color-Scale stop list (positions + colors), so palette presets
   *  with non-uniform spacing round-trip exactly. */
  gradient?: ColorStop[];
  /** Interpolation curve for the gradient (Color Scale method); default linear. */
  method?: string;
  /** tag: per tag-option color; index i == tag option i. */
  tag?: RGB[];
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
  // --- Linked Output Mappings (Attribute→Color only; ignored when isAttributeToColor=false) ---
  /** When true, the color pass is auto-generated from `linkedAttributeId`.
   *  Absent/false = Standalone (the classic hand-built color graph). */
  linked?: boolean;
  /** Cell attribute whose value drives the auto color pass. Resolved live by id
   *  at compile time; an empty/invalid/deleted id makes the mapping behave as
   *  not-linked (graceful default colors). */
  linkedAttributeId?: string;
  /** float/integer gradient domain. Seeded from the attribute's bounds at link
   *  time, user-editable thereafter. */
  linkedMin?: number;
  linkedMax?: number;
  /** Optional user color overrides; absent → auto defaults. */
  linkedColors?: LinkedColorSet;
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
   *  the JS-compiled step. **Default for new models** (EMPTY_MODEL sets it true).
   *  The WASM compiler falls back to JS silently if the graph references a node
   *  type whose WASM emit is not implemented (rare — node coverage is complete);
   *  the user can flip this off at any time to force JS. */
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

/** Indicator X-axis. `generation` (default/absent) is the classic time-history
 *  behavior. `rows` / `columns` turn the indicator into a live spatial histogram
 *  (a chromatogram): the per-step value becomes `Record<seriesKey, number[]>`,
 *  each array indexed by position bin along the chosen axis. Spatial is a
 *  cell-aggregation, so it is only valid on **linked** indicators. */
export type IndicatorXAxis = 'generation' | 'rows' | 'columns';

/** Spatial position-binning mode. `slices` divides the axis into a fixed number
 *  of equal bands (relative — survives grid resize). `absolute` uses a fixed
 *  number of rows/columns per band (re-derives bin count when the grid resizes). */
export type SpatialBinMode = 'slices' | 'absolute';

/** Per-indicator chart display settings. Every field is optional — absent
 *  means "dynamic / default" (data-driven axis range, 2 tick labels, palette
 *  colors). Stored on the Indicator as the model-level DEFAULTS; the simulator
 *  keeps a per-field OVERRIDE layer on top (persisted in sim settings and in
 *  SimulationState under "Simulator controls"). */
export interface IndicatorChartSettings {
  /** Fixed Y-axis minimum. Absent → dynamic (follows the data). */
  yMin?: number;
  /** Fixed Y-axis maximum. Absent → dynamic (follows the data). */
  yMax?: number;
  /** Number of Y-axis tick labels incl. min+max (2–11). Absent → 2. */
  yTicks?: number;
  /** Per-series color overrides keyed by category (bool → "true"/"false",
   *  tag → option name, freq buckets → value/bin key). Scalar charts use the
   *  single key "value". Absent entries fall back to the theme palette. */
  seriesColors?: Record<string, string>;
}

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
  binCount?: number;                    // float + frequency: number of *value* histogram bins (default 10)
  /** Categorical (bool/tag) frequency only: the subset of category values to
   *  track/chart (bool → "true"/"false"; tag → tag-option names). Absent or
   *  empty = track ALL categories (default / back-compat). Lets a chart focus on
   *  a few categories so a dominant one doesn't flatten the rest on a shared
   *  Y-axis. Filtered at the worker's message-assembly step, so it applies to
   *  generation- and spatial-axis frequency on every compile target. */
  trackedValues?: string[];
  // Spatial X-axis (linked-only; absent ⇒ 'generation' = classic time-history):
  /** When 'rows'/'columns', the indicator is a live spatial histogram binned by
   *  cell position along that axis. Standalone indicators stay Generation-only. */
  xAxis?: IndicatorXAxis;
  /** Position-binning mode for spatial indicators (default 'slices'). */
  spatialBinMode?: SpatialBinMode;
  /** slices mode: number of equal position bands along the axis (default 50,
   *  clamped to [2, axisLength]). Distinct from `binCount` (value bins). */
  spatialBinCount?: number;
  /** absolute mode: rows/columns per band (default 1). Bin count derives from
   *  ceil(axisLength / spatialBinSize) at runtime. */
  spatialBinSize?: number;
  // Display:
  watched: boolean;                     // eye toggle — controls display in simulator
  /** Chart display defaults (axis range / ticks / series colors). The
   *  simulator's per-indicator gear popover edits a runtime override layer on
   *  top of these; field-level merge, override wins. */
  chartSettings?: IndicatorChartSettings;
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
  /** Simulator-side per-indicator chart-settings overrides (gear popover) —
   *  field-level layer over each Indicator.chartSettings. */
  indicatorChartOverrides?: Record<string, IndicatorChartSettings>;
  // Model structure controls — saved in presets so a preset can restore its grid
  // dimensions and boundary rule even when cell-grid state isn't embedded.
  boundaryTreatment?: BoundaryTreatment;
  gridWidth?: number;
  gridHeight?: number;
  /** Lookup-table model attribute overrides. Outer key = attribute id; inner
   *  table maps `rowLabel -> colLabel -> float`. Saved in presets so a preset
   *  can swap an entire parameter set (e.g. the 8 Kier 1996 amphiphile sets)
   *  without forcing the user to retype every cell. On apply, this rewrites both
   *  the cached worker tables (via updateLookupTable) and the model state
   *  (via updateAttribute) so Reset-to-Default snapshots also follow the preset.
   *  Field name retained as `interactionTables` for back-compat with presets
   *  saved before the Lookup Table rename. */
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
/** A named, ordered set of face labels. Multiple palettes let different cell
 *  species carry independent label spaces (e.g. analyte faces A0–A3 vs CD faces
 *  B0–B2 in an enantiomer model) that key different Lookup Tables. The implicit
 *  `none` label is always available (index 0 at runtime) and is NOT stored in
 *  `labels`. */
export interface FaceLabelPalette {
  /** Unique within the model. */
  id: string;
  /** User-facing name (rendered in the Variegated Cells panel + dropdowns). */
  name: string;
  /** User-defined labels (without the implicit `none`). */
  labels: string[];
}

export interface FacePattern {
  /** Unique within the model. */
  id: string;
  /** User-facing name (rendered in the Variegated Cells panel and dropdowns). */
  name: string;
  /** Which `FaceLabelPalette` this pattern's slot labels come from. A species
   *  assigned this pattern carries face labels in this palette's space. */
  paletteId: string;
  /** `'edges'` exposes only the 4 cardinal slots (N, E, S, W); the 4 corner
   *  slots are locked to `null`. `'edges+corners'` exposes all 8 slots. */
  layoutMode: 'edges' | 'edges+corners';
  /** Length 8: `[N, NE, E, SE, S, SW, W, NW]`. Each entry is a face-label
   *  string from this pattern's palette (`paletteId`), or `null` for "no face
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
  /** User-defined face-label palettes. Each `FacePattern` references one by id.
   *  Migrated from the legacy single `faceLabels: string[]` into one palette. */
  facePalettes: FaceLabelPalette[];
  /** Named face patterns the user can assign to source-attr tag values via
   *  `Attribute.facePatternAssignments`. */
  facePatterns: FacePattern[];
}

/** Local Variables — per-cell mutable storage in the update-rules graph.
 *
 *  A Variable lets a graph rule "declare a value here, mutate it in a loop,
 *  read it elsewhere" — bridging the gap between pure dataflow and the
 *  imperative pseudocode most CA rules are written in (e.g. "for each
 *  direction d, weights[d] = compute(d); then sample by weights"). Each cell
 *  gets its own copy, populated fresh at the start of every cell iteration
 *  by resetting to `initialValue`. Variables don't persist across steps —
 *  treat them as scratch space local to one cell-step's computation.
 *
 *  Read via `getVariable` (value node), write via `setVariable` (scalar) or
 *  `setArrayElement` (array). Defined globally on the model (Properties
 *  panel) so multiple graph nodes can reference the same variable by id. */
export type VariableKind = 'scalar' | 'array';
export type VariableDataType = 'bool' | 'integer' | 'float' | 'tag';

export interface Variable {
  id: string;
  name: string;
  description?: string;
  kind: VariableKind;
  dataType: VariableDataType;
  /** Array kind only: number of elements. Allocated once at compile time. */
  length?: number;
  /** Initial value populated into every cell's copy at the start of each cell
   *  iteration. Same string encoding as `Attribute.defaultValue` — tag
   *  indices as `"0"`/`"1"`/..., bools as `"true"`/`"false"`, numbers as
   *  decimal strings. For arrays, ALL elements reset to this value (uniform
   *  fill is the v1 semantics; per-index init can be added later). */
  initialValue: string;
  /** Tag dataType only: tag attribute defining the tag space (its
   *  `tagOptions` provides the named values for the initialValue dropdown). */
  attributeId?: string;
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
  /** Local Variables — per-cell mutable storage referenced by getVariable /
   *  setVariable / setArrayElement nodes. Empty / absent → no variables in
   *  the model. */
  variables?: Variable[];
  simulationState?: SimulationState;
  presets?: Preset[];
  /** Variegated Cells feature config. Absent / `enabled: false` → engine and
   *  UI behave as if the feature didn't exist. See `VariegatedCellsConfig`. */
  variegatedCells?: VariegatedCellsConfig;
}
