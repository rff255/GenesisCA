/** Attribute data types supported by GenesisCA.
 *
 *  `neighborIndex` is stored at runtime as an `Int32Array` (one packed value
 *  per cell) holding `(dr << 16) | (dc & 0xFFFF)` — a sign-extended (dr, dc)
 *  offset pair. Position-only, neighborhood-agnostic. The editor can show a
 *  neighborhood-anchored grid for default-value picking via
 *  `Attribute.neighborhoodHintId`, but the hint is purely UI; the runtime
 *  value is just the packed offset. */
/** `vector` is a COMPOSITE stored type: a per-cell / per-agent 2D–3D direction
 *  (`dims = is3dModel ? 3 : 2`). It is never stored as one array — a shared
 *  pre-compile / pre-init transform ([vectorAttr.ts](../modeler/vpl/compiler/vectorAttr.ts)
 *  `expandVectorAttributes`) LOWERS each vector attribute into `dims` scalar
 *  `float` component attributes (`<id>_vx`/`_vy`/`_vz`), so every downstream layer
 *  (all 5 compilers, the worker SoA, save/load) sees only scalar floats — the same
 *  principle by which `expandComposites` lowers a vector *wire*. The `vector`
 *  attribute exists only in `model.attributes`/`agentAttributes` (authoring) + the
 *  transform; `Get/Set Vector Attribute` carry it on one wire, lowered via
 *  Make/Break Vector. `Attribute.defaultValue` = comma-joined `"x,y"`/`"x,y,z"`. */
export type AttributeType = 'bool' | 'integer' | 'float' | 'tag' | 'color' | 'neighborIndex' | 'lookupTable' | 'vector';

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
  | { kind: 'single' }
  /** An arbitrary user-defined ordered set of axis labels, edited directly on
   *  the Lookup Table definition page — not tied to a tag attribute or face
   *  palette. `labels` are the row/column names used as keys in `tableValues`. */
  | { kind: 'custom'; labels: string[] }
  /** An integer-range axis: labels = `String(min) … String(max)` (dimension =
   *  `max − min + 1`). The natural axis kind for count-indexed rule tables
   *  (e.g. Accretor's face/edge/corner neighbour counts 0..6 / 0..12 / 0..8).
   *  At lookup time the wired index is offset by `min` and saturating-clamped
   *  into the axis (axes-mode tables only). */
  | { kind: 'intRange'; min: number; max: number };

/** One axis of a MULTI-AXIS (N-D) Lookup Table — see `Attribute.axes`.
 *  `name` is the display label (axis-port label on the Table Lookup node +
 *  header in the table editor); absent → "Axis N". */
export interface LookupAxis {
  name?: string;
  source: LookupKeySource;
}

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
  /** Generic Agent Platform: CELL attributes only — whether floating agents may
   *  access this cell attribute (the environment/field) via the field-bridge
   *  nodes. `'none'` (absent ⇒ none) = invisible to agents; `'read'` = Sample
   *  Field / Field Gradient / Read Cells Under may target it; `'readWrite'` =
   *  also Affect Cells Under / Secrete To Field. CA cells can NEVER read agent
   *  attributes — that is structural (the cell compilers never see
   *  `agentAttributes`), so there is no inverse flag. Inert on agent attributes
   *  (those live in `CAModel.agentAttributes`, are agent-only, and always
   *  accessible to agents). Gates ONLY the field channel — the agent's own state
   *  lives on `agentAttributes`, never on a cell attribute. */
  agentAccess?: 'none' | 'read' | 'readWrite';
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
   *  rowLabel string × colLabel string → number. Missing entries default to 0.
   *  A face-palette axis uses the literal `"none"` key at index 0; a
   *  tag-attribute axis uses tag-option names (no implicit `none`); a custom
   *  axis uses the user labels. Values are stored as numbers regardless of
   *  `valueType` (bool → 0/1, tag → tag index, integer/float → the number), so
   *  no compiler/worker change is needed — the value type only drives the
   *  editor widget. LEGACY 2-AXIS STORAGE — ignored when `axes` is present
   *  (multi-axis tables store `tableData` instead). */
  tableValues?: Record<string, Record<string, number>>;
  /** MULTI-AXIS (N-D) Lookup Table: when present (1..6 axes), supersedes
   *  `rowKeySource`/`colKeySource` — the table is indexed by one integer per
   *  axis and stored in `tableData`. Absent → the legacy 2-axis path runs
   *  byte-identically (no migration; the editor offers an explicit one-shot
   *  "Convert to multi-axis"). Axis list discipline mirrors multi-attr slots:
   *  append / remove-LAST only, edit in place — never reorder (the storage
   *  layout and the Table Lookup node's `axis_k` ports are positional). */
  axes?: LookupAxis[];
  /** Multi-axis tables only: DENSE row-major values over `axes` in declared
   *  order — `flat = ((i0·d1 + i1)·d2 + i2)…`, length = Π dims. Same number
   *  encoding as `tableValues` (bool 0/1, tag index, int/float). Missing /
   *  short arrays read as 0 (the normalizer zero-fills). */
  tableData?: number[];
  /** Informational: the last "Randomize table" roll's seed + density (+ `min`/
   *  `max`, the integer/tag value range — `min` absent ⇒ the historical lower
   *  bound 1 (tag: option index); + `rangeMin`/`rangeMax`, the uniform float
   *  draw range — absent ⇒ the historical (0,1) — for float-valued tables;
   *  signed ranges like −1..1 are the Particle Life rules matrix) — seeds the
   *  editor fields; journaled by the Overseer's Randomize Table node (whose
   *  runtime re-roll reads these to reproduce the editor's value policy). The
   *  DATA (`tableData` / `tableValues`) stays authoritative — this never
   *  regenerates implicitly. */
  tableRoll?: { seed: number; density: number; min?: number; max?: number; rangeMin?: number; rangeMax?: number };
  /** Lookup Table model attributes only: the data TYPE of the table's cell
   *  values. Absent → `'float'` (Decimal), the historical behaviour. Restricted
   *  to the scalar-numeric types that fit one stored number exactly on all
   *  targets: `bool` / `integer` / `float` / `tag`. (`color` would need a
   *  multi-output read and `neighborIndex` exact-int f32 storage — not yet
   *  offered.) */
  valueType?: AttributeType;
  /** Lookup Table model attributes only, when `valueType === 'tag'`: the named
   *  values for the table's tag-typed cells (stored value = index into this
   *  array, like `tagOptions`). Used when `valueTagAttributeId` is unset (manual
   *  value labels). */
  valueTagOptions?: string[];
  /** Lookup Table model attributes only, when `valueType === 'tag'`: instead of
   *  the manual `valueTagOptions`, draw the tag value space from an EXISTING tag
   *  attribute's `tagOptions` (like a tag-attribute axis key source). Absent →
   *  use `valueTagOptions`. */
  valueTagAttributeId?: string;
  /** Vector attributes only: the component count — `2` = (x, y), `3` = (x, y, z).
   *  Absent ⇒ `2`. Chosen PER ATTRIBUTE (not derived from the model): a 3D model
   *  offers BOTH "Vector (2D)" and "Vector (3D)" (e.g. a horizontal heading vs a
   *  full 3D direction); a 2D model offers only 2D. The lowering
   *  ([vectorAttr.ts](../modeler/vpl/compiler/vectorAttr.ts)) synthesizes this many
   *  scalar-float components (`<id>_vx/_vy`[/`_vz`]). */
  vectorDims?: 2 | 3;
}

/** 3D Grid CA: parametric named-shape spec for a 3D neighbourhood. Materialized
 *  into `coords3d` by `generateCoords3d`. Stored alongside the materialized
 *  coords (coords3d is the runtime source of truth) so the parametric editor can
 *  re-tune; a cascade re-materializes on every spec edit so a stale spec can
 *  never strand the coords. Metric: chebyshev = L∞ (Moore), manhattan = L1
 *  (von Neumann), euclidean = L2 (sphere). */
export type NeighborhoodShapeSpec =
  | { kind: 'moore' | 'vonNeumann' | 'ball' | 'rangeN'; radius: number; metric?: 'chebyshev' | 'manhattan' | 'euclidean' }
  | { kind: 'shell'; rIn: number; rOut: number }
  | { kind: 'ring' | 'disk'; axis: 'x' | 'y' | 'z'; radius: number; width?: number };

/** A neighborhood definition — list of relative offsets from the central cell */
export interface Neighborhood {
  id: string;
  name: string;
  description: string;
  coords: Array<[number, number]>;
  /** 3D Grid CA: when present, this neighbourhood lives in a W×H×D volume and
   *  these `[dr, dc, dl]` 3-tuples are the source of truth for the offset table.
   *  `coords` stays populated as a same-LENGTH 2D projection (so the stride
   *  invariant `coords.length === coords3d.length` holds and the WASM/WebGPU
   *  2D layouts still size correctly). Absent → a classic 2D neighbourhood.
   *  Materialized from `shape` (PR4) by `generateCoords3d`. */
  coords3d?: Array<[number, number, number]>;
  /** 3D Grid CA: the parametric spec that materialized `coords3d` (when the
   *  neighbourhood was built/edited via the parametric panel rather than the
   *  slice editor). Re-tuning the spec re-materializes `coords3d`. */
  shape?: NeighborhoodShapeSpec;
  margin?: number;
  /** Optional tags for individual cells: coord index → tag name */
  tags?: Record<number, string>;
  /** When true, the central cell ([0,0]) is appended to the effective
   *  neighborhood, so neighbor-iterating nodes treat the cell itself as a
   *  member. Default false. Expanded into `coords` at the sim boundary. */
  includeCentralCell?: boolean;
}

/** A plain 0–255 RGB(A) colour used by Linked Output Mapping palettes.
 *
 *  `a` is OPTIONAL and **absent means fully opaque (255)** — the invariant that
 *  keeps every pre-alpha model byte-identical: an opaque palette serialises with
 *  no `a` key (`stringifyCompact` drops `undefined`), emits the pre-alpha
 *  three-channel form, and wires no alpha edge. See `colorHex.ts`. */
export interface RGB { r: number; g: number; b: number; a?: number; }

/** A gradient stop for a Linked Output Mapping scale. `position` is in [0,1]
 *  (same space as the Color Scale node) and is mapped onto [linkedMin, linkedMax]
 *  at compile time. `a` is optional; absent = opaque (see {@link RGB}). */
export interface ColorStop { position: number; r: number; g: number; b: number; a?: number; }

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

/** The value types an INPUT-mapping parameter may declare. Deliberately NARROWER
 *  than `AttributeType`: a brush can supply a number, a flag, a category or a
 *  colour — it cannot supply a neighbour index, a lookup table or (yet) a vector.
 *  `color` is the only multi-CHANNEL type (3 channels); every other type is 1. */
export type InputParamType = 'bool' | 'integer' | 'float' | 'tag' | 'color';

/** What an AGENT Color→Attribute mapping's brush DOES when the user paints.
 *
 *  · `editor`  — the historical shape (and the resolved default when absent): the
 *                graph runs ONCE PER AGENT the brush footprint covers, with that
 *                agent as `self`. It edits the agents it touches — and, since the
 *                `input` ABI carries the grow-only spawn closures + the kill
 *                request lane, it may also spawn agents AROUND them or remove
 *                them.
 *  · `spawner` — the graph runs ONCE PER BRUSH APPLICATION with NO self: it
 *                receives the brush's world POSITION + RADIUS and creates agents
 *                itself (Create Agent → set-by-handle → Add Agent To World),
 *                distributing them however the rule likes. This is the shape the
 *                editor kind structurally cannot express: an editor with an empty
 *                footprint runs zero times, so "click empty space to add agents"
 *                has nowhere to hook.
 *
 *  Cell (lattice) C→A mappings have no kind — a cell brush is always per-cell. */
export type InputBrushKind = 'editor' | 'spawner';

/** One declared parameter of a Color→Attribute (input) mapping. Each parameter
 *  becomes N value-output ports on the mapping's event root (`inputColor` /
 *  `agentInputMapping`) and one type-adaptive widget in the brush panel.
 *
 *  `key` vs `name` is LOAD-BEARING: port ids + ABI names derive from `key`, so
 *  the editor renames `name` freely without touching a single wire. */
export interface InputMappingParam {
  /** Stable identifier. Port ids + ABI names derive from it; NEVER changed by a
   *  display rename. Sanitised to `[A-Za-z0-9_]`. */
  key: string;
  /** User-facing label (port labels, brush rows). */
  name: string;
  type: InputParamType;
  description?: string;
  /** Canonical string encoding, identical to `Attribute.defaultValue`
   *  (bool `'true'`/`'false'`, tag = option index, colour = `#rrggbb`). */
  defaultValue?: string;
  /** tag only — the inline option list … */
  tagOptions?: string[];
  /** … or borrowed live from an existing tag attribute (cell or agent). Takes
   *  precedence over `tagOptions` when it resolves. */
  tagAttributeId?: string;
  /** integer/float only — brush-widget bounds. NOT clamped by the engine. */
  min?: number;
  max?: number;
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
  /** Color→Attribute only. ABSENT ⇒ the LEGACY single `color` parameter whose
   *  ports are exactly `r`/`g`/`b` — every shipped model, byte-identically.
   *  EMPTY ⇒ deliberately NO parameters (a stamp that ignores the brush).
   *  The two are DIFFERENT: always resolve through `inputParamsOf()`
   *  (src/model/inputMappingParams.ts) — never read this field directly. */
  parameters?: InputMappingParam[];
  /** AGENT Color→Attribute mappings only. ABSENT ⇒ `'editor'` — the historical
   *  per-painted-agent brush, so every existing file is unchanged and there is no
   *  migration. Ignored for cell mappings and for A→C views. Always resolve
   *  through `inputBrushKindOf()` (src/model/inputMappingParams.ts) — never read
   *  this field directly (the `parameters` discipline). */
  brushKind?: InputBrushKind;
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

/** An imported sprite asset (static image or animated GIF/WebP) used as an
 *  optional exhibition layer for AGENT output mappings. The original file is kept
 *  as a base64 data URL so the `.gcaproj` stays self-contained; frames are decoded
 *  on the MAIN THREAD (via WebCodecs `ImageDecoder`) into `ImageBitmap`s for fast
 *  per-agent blitting — the worker never carries the pixels (it only holds a
 *  per-agent sprite slot + current frame + speed in the agent SoA). Referenced by
 *  `setAgentSprite` nodes via `id`. Absent/empty in every legacy file + non-sprite
 *  model.
 *
 *  PLAYBACK is NOT a simulator transport — it is driven by the agent's LOGIC via
 *  the Set Agent Sprite node (set sprite / set frame / set speed, speed in frames
 *  per simulation step, negative = reverse). The per-agent frame is advanced each
 *  step by the per-agent speed (in the engine). `loop` only decides how the
 *  RENDER wraps an out-of-range frame: true (default) cycles, false clamps to the
 *  last frame ("play once"). */
export interface SpriteAsset {
  id: string;
  name: string;
  /** Original image file as a `data:<mime>;base64,…` URL (PNG/JPEG/GIF/WebP). */
  dataUrl: string;
  mimeType: string;
  /** SIZE — what `scale` (and a per-agent Set Agent Sprite `Scale` override) MEANS:
   *  - `'radius'` (default, and the reading every pre-sizeMode file keeps): a
   *    MULTIPLIER of the agent's diameter, so the art tracks the agent's body.
   *  - `'absolute'`: the drawn size in WORLD UNITS — the agent's radius is not
   *    consulted at all, so the sprite is exactly as big as the rule asks for.
   *  Either way the number is the sprite's LONGEST side; the other is shortened by
   *  the frame aspect. One reading per ASSET, so the Sprite Library field and the
   *  Set Agent Sprite `Scale` port can never mean two different things. */
  sizeMode?: 'radius' | 'absolute';
  /** Size — a multiplier of the agent diameter (`sizeMode` absent / `'radius'`) or
   *  the drawn size in world units (`'absolute'`). Default 1. */
  scale?: number;
  /** Render wrap mode: true (default) loops the frame index, false clamps it to
   *  the last frame so the animation holds at its end ("play once"). */
  loop?: boolean;
  /** ROTATION — the direction the sprite art faces when unrotated, in degrees
   *  where 0 = up (12 o'clock) and angles increase clockwise (a compass). Used to
   *  align the art with the agent's heading when `orientToVelocity` is on. */
  defaultDirection?: number;
  /** ROTATION — auto-rotate each agent's sprite to point along its velocity
   *  vector (heading), accounting for `defaultDirection`. Render-side (reads the
   *  snapshot vx/vy), so it works on every agent compile target. */
  orientToVelocity?: boolean;
  /** ROTATION — a fixed extra rotation (degrees, clockwise) applied on top. */
  rotationOffset?: number;
  /** CHROMA KEY — when set, pixels within `removeBgTolerance` per channel of this
   *  `#rrggbb` colour are made transparent at decode time (classic magenta /
   *  green-screen background removal for traditional sprites). */
  removeBgColor?: string;
  /** Per-channel 0–255 tolerance for `removeBgColor` (default 24). */
  removeBgTolerance?: number;
  /** IMAGE SEQUENCE — an ordered list of frame data URLs. When present (length
   *  ≥ 1) these ARE the animation frames (traditional multi-image animation);
   *  `dataUrl` is the first frame (also the library thumbnail). */
  frames?: string[];
  /** SPRITE SHEET — slice the single grid image in `dataUrl` into frames
   *  (row-major). Classic RPGMaker / pixel-art sheet import. */
  sheet?: SpriteSheetSpec;
}

/** Grid layout of a sprite sheet — how to slice one image into animation frames
 *  (row-major, left-to-right then top-to-bottom). See `spriteSheet.ts` for the
 *  cell geometry + the frame-selection rules every consumer derives from. */
export interface SpriteSheetSpec {
  /** Number of columns and rows of cells in the sheet. */
  cols: number;
  rows: number;
  /** Number of frames to take (row-major). Absent → cols*rows (all cells).
   *  IGNORED when `frames` is present (an explicit list already says how many). */
  count?: number;
  /** FRAME SELECTION — an ORDERED list of grid-cell indices (row-major, in the
   *  `0 .. cols*rows-1` index space) that ARE the animation, in that order.
   *  Real sheets hold several unrelated things, so the frames are a SELECTION
   *  over the cells rather than "the first N of them"; the order is the user's,
   *  and DUPLICATES are allowed (`[0,1,2,1]` is a ping-pong cycle).
   *  ABSENT ⇒ the historical row-major `count` behaviour, byte-for-byte. */
  frames?: number[];
  /** EXPLICIT cell size in image pixels. ABSENT ⇒ the size is DERIVED from the
   *  image, the margins and the gaps (`(imgW - marginX - (cols-1)*spacingX) / cols`)
   *  — the historical behaviour, byte-for-byte, so every sheet authored before the
   *  first-cell gizmo slices exactly as it always did.
   *
   *  It exists because the derived size is locked to the FULL image extent: a sheet
   *  with trailing dead space on the right/bottom cannot be gridded correctly by
   *  cols/rows alone, and a smoothly scalable gizmo cannot be expressed through
   *  integer cell COUNTS. The dialog folds an explicit size that equals the derived
   *  one back to ABSENT, so a drag that lands on the derived geometry keeps the
   *  legacy record shape. See `spriteSheet.ts` — the one definition. */
  cellW?: number;
  cellH?: number;
  /** Pixel offset from the top-left of the image to the first cell. */
  marginX?: number;
  marginY?: number;
  /** Pixel gap between adjacent cells. */
  spacingX?: number;
  spacingY?: number;
}

export type BoundaryTreatment = 'constant' | 'torus';
export type Topology = '2d-grid';
/** Lattice dimensionality. `2d` (default/absent) is the classic W×H grid;
 *  `3d` makes the lattice a W×H×D volume (the 3D Grid CA milestone). The
 *  engine is dimension-agnostic (`total = W*H*D`, a 3-tuple offset table, a
 *  `_layer` decode); only the renderer differs. */
export type Dimension = '2d' | '3d';
/** C4 (P1) — a compile ENGINE, per layer. `'js'` is the readable semantic
 *  reference (and the always-runnable fallback), not a production choice. */
export type EngineId = 'js' | 'wasm' | 'webgpu';
/** What the user SELECTED for a layer: a concrete engine, or `'auto'` = "the
 *  fastest engine this model can use", resolved + displayed by `resolveEngines`. */
export type EngineChoice = EngineId | 'auto';
/** C5 (P10) — how much run-to-run variance this model tolerates, DECLARED rather
 *  than inherited from which engine happens to be selected.
 *
 *  `'exact'`       bit-reproducible trajectories: a fixed seed pins a run, so
 *                  oracles, replays and differential comparisons hold.
 *  `'statistical'` runs are draws from the same distribution; sweeps use N
 *                  repeats + aggregates (mean / std / ci95).
 *
 *  It is an input to `Auto` (see `resolveEngines`), never an override of an
 *  explicit engine choice. GUARDRAIL: Statistical covers stochastic variance
 *  around the SAME rule — it never licenses answering a different question. */
export type ReproducibilityContract = 'exact' | 'statistical';
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

/** Where cell (0,0) sits in the real world, and how big a cell is there.
 *
 *  PRESENTATION + I/O METADATA ONLY — nothing in any compiler, the worker or the
 *  engine reads it (the C8 "presentational geometry" doctrine). It is written by
 *  the Esri ASCII grid (`.asc`) import from the file's own header and read back by
 *  the `.asc` export so a board leaves GenesisCA georeferenced exactly as it
 *  arrived. Additive + optional; old files load unchanged.
 *
 *  Origin convention is the Esri one: `xllcorner`/`yllcorner` are the coordinates
 *  of the LOWER-LEFT CORNER of the lower-left cell (an `xllcenter` header is
 *  converted on import). */
export interface GeoReference {
  xllcorner: number;
  yllcorner: number;
  /** World units per cell (square cells — the format has no separate x/y size). */
  cellSize: number;
  /** Coordinate reference system, when a format carries one. `.asc` does NOT, so
   *  it stays absent there; a future GeoTIFF import would fill it. */
  crs?: string;
}

/** A static map image drawn UNDER the grid in the 2D simulator.
 *
 *  PRESENTATION ONLY — nothing reads it but the 2D draw path (SLEUTH's hillshade
 *  layer / QGIS's basemap; see docs/INVESTIGATION_GEOSPATIAL_IO.md Tier 3). It is
 *  stretched to the WORLD RECT (the same destination the grid blit uses), so it
 *  lines up with the cells by construction and needs no separate anchor.
 *  Stored like the thumbnail — a data URL travelling inside the `.gcaproj`.
 *  Additive + optional; old files load unchanged. */
export interface MapBackdrop {
  /** A still-image data URL — see [backdrop.ts](./backdrop.ts) for the accepted
   *  formats and the size cap. */
  dataUrl: string;
}

/** Top-level model properties */
export interface ModelProperties {
  name: string;
  /** Author of the rule/model logic (the domain expert or researcher). */
  author: string;
  /** Author of the GenesisCA model file itself (the person who built the graph). */
  modelAuthor: string;
  /** Short summary — shown on Models Library cards (UI label: "Summary"). */
  description: string;
  /** Long-form explanation of how the rule works (UI label: "Rule Description").
   *  Not shown on Library cards — for in-depth notes the author deems important. */
  ruleDescription?: string;
  /** Optional usage instructions written by the model author, surfaced in the
   *  SIMULATOR (an "Instructions" overlay button) — how to interact with the
   *  model, what to try, what to look for. Plain text; line breaks preserved.
   *  Additive + optional, so old files load unchanged. */
  instructions?: string;
  /** Authored creation date as an ISO calendar date (`YYYY-MM-DD`). Set by the
   *  model author in the Info panel; powers the Models Library card stamp and
   *  its Newest/Oldest sort. Deliberately AUTHORED, not derived: the file's
   *  mtime (and birthtime) churn on every build / checkout, so a derived date
   *  says nothing about when the model was actually made. Absent → no date is
   *  shown anywhere (silence beats a misleading number). See
   *  [createdDate.ts](./createdDate.ts). Additive + optional; old files load
   *  unchanged. */
  createdDate?: string;
  /** Does Reset RESTORE the model's embedded board (`simulationState`) instead of
   *  reseeding the grid from the Init Events? Absent ⇒ false ⇒ the historical
   *  behaviour.
   *
   *  It decides only the DEFAULT action of the ■ Reset button (and the Esc /
   *  Backspace shortcut). BOTH actions are always reachable from the Reset
   *  button's own menu (hover or right-click it), so neither becomes unreachable
   *  whichever way the flag is set.
   *
   *  It exists for a board that is DATA rather than a seeded pattern: an imported
   *  GIS landscape (or any board the user painted and saved) cannot be regenerated
   *  from Init Events, so a plain Reset wipes it. The restore runs AFTER the reset,
   *  and `loadState` skips attributes the snapshot does not carry — so a partial
   *  board (e.g. terrain saved, fire state not) restores its own layers while every
   *  other attribute keeps its freshly-reset defaults.
   *
   *  UI + orchestration ONLY: no compiler, worker or engine reads it. Inert — and
   *  hidden — unless the model actually carries an embedded board. Additive +
   *  optional; old files load unchanged. */
  resetRestoresBoard?: boolean;
  /** Opt-in gate for the GEOGRAPHIC (GIS) tool surfaces — the Georeference block,
   *  the Backdrop map, and the `.asc` / GeoTIFF / GeoJSON import + `.asc` export
   *  affordances. Absent ⇒ OFF, so the overwhelming majority of models (which are
   *  not maps) never see any of it.
   *
   *  UI ONLY: no compiler, worker or engine reads this — it decides which controls
   *  RENDER, never what a rule computes. Turning it off HIDES the surfaces; it
   *  never deletes a stored `georef` or `backdrop`.
   *
   *  Set automatically when a geographic import applies (the discovery path — a
   *  dropped `.tif` always opens its dialog regardless of this flag), and inferred
   *  as true on LOAD for a pre-gate file that already carries a georef/backdrop.
   *  Additive + optional; old files load unchanged. */
  gisTools?: boolean;
  /** Where the board sits in the real world (origin + cell size). Written by the
   *  Esri ASCII grid (`.asc`) import from the file's header, read back by the
   *  `.asc` export. Presentation + I/O only — see {@link GeoReference}. */
  georef?: GeoReference;
  /** Optional static map image drawn UNDER the grid in the 2D simulator (the
   *  georeferenced sibling of `bg2d`'s flat colour). Presentation only — see
   *  {@link MapBackdrop}. */
  backdrop?: MapBackdrop;
  topology: Topology;
  boundaryTreatment: BoundaryTreatment;
  updateMode: UpdateMode;
  asyncScheme: AsyncScheme;
  gridWidth: number;
  gridHeight: number;
  /** 3D Grid CA: number of layers along Z. Absent / `1` → `W*H*1 === W*H`,
   *  byte-identical to the 2D engine. Only meaningful when `dimension === '3d'`. */
  gridDepth?: number;
  maxIterations: number;
  tags: string[];
  /** Optional preview media (PNG/JPEG/GIF/WebP image, or a `video/webm` clip —
   *  e.g. a simulator recording, <=2 MB) as a data URL. Shown on hover in the
   *  Models Library. Travels inside the .gcaproj file. Render sites must go
   *  through `<ThumbMedia>` — an `<img>` cannot display a WebM clip. */
  thumbnail?: string;
  /** Optional simulator auto-pause rules. Undefined = disabled. */
  endConditions?: EndConditions;
  /** C4 (P1) — the CA-grid ENGINE the user selected. `'auto'` means "pick the
   *  fastest engine this model can use" and is resolved (and DISPLAYED) by
   *  `resolveEngines` in [engineResolution.ts](engineResolution.ts); the other
   *  three name an engine explicitly. Absent ⇒ `migrateEngineField` derives the
   *  EXPLICIT equivalent of the legacy `useWebGPU`/`useWasm` flags on load, so a
   *  legacy file behaves byte-identically and never silently becomes `'auto'`.
   *
   *  This is the field the UI writes. `useWasm`/`useWebGPU` below are its
   *  RESOLVED MIRROR (see their doc comments). */
  engine?: EngineChoice;
  /** C5 (P10) — the declared REPRODUCIBILITY CONTRACT. Absent ⇒ `'exact'`
   *  (the safe default, and what every legacy CPU model already delivers);
   *  `migrateReproducibilityField` infers `'statistical'` on load for a file
   *  whose RESOLVED agent engine is WebGPU, i.e. one that already runs with
   *  per-agent-RNG variance.
   *
   *  Consumed by `resolveEngines` (Auto picks the fastest engine that satisfies
   *  it) and displayed everywhere the engine is. See
   *  [reproducibility.ts](reproducibility.ts). */
  reproducibility?: ReproducibilityContract;
  /** Wave 2: when true, the simulator runs the WASM-compiled step instead of
   *  the JS-compiled step.
   *
   *  **C4: this is now the RESOLVED MIRROR of `engine`, not the user's choice.**
   *  It is kept because it is the representation every downstream consumer
   *  already reads (the worker init message, `computeLayoutFromModel`, the
   *  WebGPU/WASM node gates, the CaNode badge), which is what makes the engine
   *  enum byte-identical for existing models AND lets an older build open a file
   *  written by a newer one. `withResolvedEngine(model)` bakes it from `engine`
   *  at every consumption point and at save time. In-app code should read
   *  `resolveEngines(model)` rather than this flag; the flag may lag a graph edit
   *  on an `'auto'` model until the next engine write / save.
   *  REMOVAL SCHEDULE: one release cycle of back-compat, then the mirror goes and
   *  `engine` becomes the only representation. */
  useWasm?: boolean;
  /** Wave 3: when true, the simulator runs the WGSL-compiled compute shaders
   *  on WebGPU. Mutually exclusive with useWasm — the UI enforces this via the
   *  Engine radio; a worker-side safety net prefers WebGPU when both flags are
   *  somehow set on a loaded file. Sync mode only: the UI greys out the async
   *  controls when this is on.
   *
   *  **C4: the RESOLVED MIRROR of `engine`** — see `useWasm` above. */
  useWebGPU?: boolean;
  /** WebGPU only: how often (in generations) to read the GPU stop-flag back
   *  to CPU during a step batch. Each readback is a mapAsync round-trip that
   *  stalls the GPU pipeline; raising this trades stop-event timing precision
   *  for throughput. Default 1 (check every step — exact behaviour). With K=8,
   *  a stop event firing at gen 47 may surface at gen 48–54. JS / WASM
   *  ignore this. */
  webgpuStopCheckInterval?: number;
  /** 3D Grid CA: lattice dimensionality. Absent → `'2d'` (legacy + every
   *  existing file). When `'3d'`, the grid is `gridWidth × gridHeight × gridDepth`
   *  and the simulator uses the WebGL2 voxel renderer. */
  dimension?: Dimension;
  /** Opt-in large-grid optimization ("Skip Isolated Empty Cells"): the worker
   *  processes the Generation Step + Output Mapping ONLY for cells within the
   *  active range of a non-empty cell, skipping isolated empty cells (the growing
   *  SURFACE, not the whole volume). Only meaningful when the model uses the CA
   *  grid (`topologyMode.gridCells !== false`) + synchronous update mode. Absent
   *  / `enabled:false` → every cell processed (byte-identical). Painting is never
   *  gated by this. See docs/PLAN_LARGE_GRID_PERF.md. */
  skipIsolatedEmpty?: SkipIsolatedEmptyConfig;
}

/** Config for the "Skip Isolated Empty Cells" optimization (all fields required
 *  when `enabled`). "Empty" is defined by (emptyAttributeId, emptyValue); the
 *  active range (within which empty cells near a non-empty cell are still
 *  processed) is a neighbourhood or a radius. Additive/optional on
 *  ModelProperties — old files load unchanged. */
export interface SkipIsolatedEmptyConfig {
  enabled: boolean;
  /** Which cell attribute defines "empty". */
  emptyAttributeId: string;
  /** The value that means "empty", encoded like `Attribute.defaultValue`
   *  (tag index string / "true"|"false" / a number string). */
  emptyValue: string;
  /** How the active range is defined. */
  rangeKind: 'neighborhood' | 'radius';
  /** rangeKind==='neighborhood': the neighbourhood whose offsets are the range. */
  neighborhoodId?: string;
  /** rangeKind==='radius': the radius in cells (default 1). */
  radius?: number;
  /** rangeKind==='radius': the distance metric (default 'chebyshev' = Moore box). */
  radiusMetric?: 'chebyshev' | 'manhattan' | 'euclidean';
}

/** A serialized node in the update rules graph */
export interface GraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  /** `label` is the author's OWN rename — the strip CaNode draws above the type
   *  header (`renameNode`, and the name a macro instance carries). Optional and
   *  heterogeneous by design: comment / group / reroute nodes carry their own
   *  extra keys here too. */
  data: { nodeType: string; config: Record<string, string | number | boolean>; label?: string };
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

/** What an EXPLICIT CONTROL points AT. Never a value — the value lives in the
 *  target's own config, so there is exactly ONE storage location (D1) and
 *  "change either side, the other shows it" holds by construction. */
export type ControlTarget =
  /** an internal node's config key inside THIS def */
  | { kind: 'config'; nodeId: string; configKey: string }
  /** a nested macro INSTANCE's own control — chaining (D4) */
  | { kind: 'control'; nodeId: string; controlId: string }
  /**
   * A MULTI-KEY EDITOR of an internal node — a gradient, a palette, an RGB(A)
   * triple (D11). The binding names the FACET, never its member keys, and the
   * write goes through the NODE'S OWN writer, so the config shape an instance
   * edit produces is identical to the in-node editor's BY CONSTRUCTION.
   *
   * That is what dissolves the original one-control-one-key exclusion: the
   * coupled-write rule forbids a control that writes ONE of several keys the
   * in-node editor writes together — it says nothing about a control that
   * drives the whole editor through the very function the node uses.
   *
   * `facet` is a def-local NAME from `explicitControls.FACET_SPECS` (a string
   * here so `types.ts` stays engine-import-free, the `graphMetric` precedent).
   */
  | { kind: 'facet'; nodeId: string; facet: string };

/** A parameter of the subgraph promoted to a named control on the CLOSED
 *  instance — a REMOTE CONTROL, never a copy.
 *
 *  ⚠ `id` is def-local and STABLE across clones — the `MacroPort.portId` rule
 *  (macroImport.ts L31-34): an OUTER def's chained target names it, and both
 *  defs clone in one operation, so preserving it keeps the chain resolving.
 *  `target.nodeId` by contrast MUST go through the clone's `idMap`. */
export interface MacroControl {
  id: string;
  /** author-given label shown on the instance */
  name: string;
  target: ControlTarget;
  /** Membership in `MacroDef.groups` (D5). Absent ⇒ ungrouped.
   *
   *  ⚠ This is the BOUNDARY MARKER of a POSITIONAL model, not a user-picked
   *  field (D5b): the interface is ONE flat ordered list of controls and group
   *  SEPARATORS, and a control belongs to whichever separator it sits under.
   *  Every edit builder re-derives this key from the resulting positions and
   *  leaves the `controls` array in canonical form (ungrouped head, then each
   *  group's members CONTIGUOUSLY, in `groups` order), so "position in the
   *  array" and "membership" can never disagree. Never write it by hand — go
   *  through `applyInterfaceEdit`. */
  groupId?: string;
  /** optional tooltip */
  description?: string;
}

/** A named section of the macro's interface — display metadata only (D5).
 *  ORDERED: the array order IS the order of the SEPARATORS in the flat
 *  interface list, and therefore the order of the group boxes on the closed
 *  instance. Reordering the array (by dragging a separator) is what moves a
 *  whole section. */
export interface MacroInterfaceGroup {
  /** def-local, stable — PRESERVED across clones, like `MacroControl.id`. */
  id: string;
  name: string;
}

/** A reusable macro (subgraph) definition */
export interface MacroDef {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  exposedInputs: MacroPort[];
  exposedOutputs: MacroPort[];
  /** Explicit Controls (D1) — ordered within their group. ABSENT ⇒ today's
   *  rendering and today's files, exactly; no migration.
   *  ⚠ Naming rule (R9): `stringifyCompact` inlines an array by its parent KEY
   *  NAME (`nodes` / `edges` / `coords`), so no sub-array in these records may
   *  carry one of those names. `controls` / `groups` pretty-print normally. */
  controls?: MacroControl[];
  /** The interface's named sections (D5) — ORDERED. */
  groups?: MacroInterfaceGroup[];
}

// ---------------------------------------------------------------------------
// `.gcamacro` — the macro file format
// ---------------------------------------------------------------------------

/** The model elements a `.gcamacro` carries alongside its subgraph, so a macro
 *  dropped into ANOTHER model can bring the attributes / neighborhoods /
 *  mappings / variables / indicators / sprites / face palettes its nodes name.
 *
 *  Elements travel **VERBATIM, as the exact schema objects** — there is no
 *  parallel "display name + metadata" record to drift when a schema field is
 *  added, and the ids are preserved exactly as exported, which is what makes
 *  re-importing into the SOURCE model a provable no-op.
 *
 *  One list per model list, so `space → CAModel[space]` is the identity: cell
 *  and model attributes share `attributes` (as `CAModel.attributes` does —
 *  `isModelAttribute` discriminates) and both mapping directions share
 *  `mappings` (`isAttributeToColor` discriminates).
 *
 *  Deliberately ABSENT: presets (a `Preset` embeds a whole `SimulationState`;
 *  `.gcapreset` owns that transport) and macro defs (nested defs ride
 *  `MacroFile.macroDefs`, since a macro def is not a model element). */
export interface MacroReferenceBundle {
  attributes?: Attribute[];
  agentAttributes?: Attribute[];
  bondAttributes?: Attribute[];
  neighborhoods?: Neighborhood[];
  mappings?: Mapping[];
  agentMappings?: Mapping[];
  variables?: Variable[];
  agentVariables?: Variable[];
  indicators?: Indicator[];
  sprites?: SpriteAsset[];
  facePalettes?: FaceLabelPalette[];
  facePatterns?: FacePattern[];
}

/** Where an exported macro came from — shown in the import dialog's header and
 *  used for its compatibility warnings. Purely informational; nothing resolves
 *  against it. */
export interface MacroOrigin {
  modelName?: string;
  dimension?: Dimension;
  topologyMode?: TopologyMode;
}

/** A `.gcamacro` file. `macroDef` + the three metadata fields are the historical
 *  shape; everything else is ADDITIVE and optional, so an older build ignores
 *  the new keys and imports exactly as it always did.
 *
 *  ⚠ `schemaVersion` stays **1** and the reader must NEVER gate on it: the
 *  format's only compatibility mechanism is "unknown keys are ignored", and a
 *  strict version check would reject files a current build reads fine. */
export interface MacroFile {
  schemaVersion: 1;
  name: string;
  description: string;
  macroDef: MacroDef;
  /** Every OTHER def the exported def references, transitively — a macro
   *  instance may live inside a macro's subgraph, and the def it points at
   *  lives in the source model, which the importing model has no access to. */
  macroDefs?: MacroDef[];
  /** The model elements the subgraph references (+ their transitive closure). */
  references?: MacroReferenceBundle;
  origin?: MacroOrigin;
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

/** `graph` (GRA P6) is the agent-tier measurement kind: a graph-global quantity
 *  (node/edge count, degree stats, components) computed by the worker over the
 *  bond-graph agent population. It has no compiler presence at all — nothing
 *  writes it from a rule graph, so it is READ-ONLY like `linked`. */
export type IndicatorKind = 'standalone' | 'linked' | 'graph';
export type LinkedAggregation = 'frequency' | 'total';
export type AccumulationMode = 'per-generation' | 'accumulated';

/** Indicator X-axis. `generation` (default/absent) is the classic time-history
 *  behavior. `rows` / `columns` turn the indicator into a live spatial histogram
 *  (a chromatogram): the per-step value becomes `Record<seriesKey, number[]>`,
 *  each array indexed by position bin along the chosen axis. `layers` is the
 *  3D-only Z-axis sibling of `rows`/`columns` (bins by `Math.floor(i/(W*H))`).
 *  Spatial is a cell-aggregation, so it is only valid on **linked** indicators. */
export type IndicatorXAxis = 'generation' | 'rows' | 'columns' | 'layers';

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
  /** Time-series X-axis window = the number of most-recent generations to show
   *  on the chart (scalar sparkline + frequency multi-line / stacked-area).
   *  Absent → show the full stored history (default). Does NOT apply to spatial
   *  (position-binned) charts or the current-gen "Bars" freq view. */
  window?: number;
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
  // Graph-only field (GRA P6):
  /** Which graph-global quantity this indicator measures. Absent on a `graph`
   *  indicator ⇒ `nodeCount`. Meaningless (and ignored) for the other kinds.
   *  Typed as a string here so `types.ts` stays free of engine imports; the
   *  canonical union is `GraphMetric` in `simulator/engine/graphMetrics.ts`. */
  graphMetric?: string;
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

/** Bond-Graph Agents — the base64-serialized agent runtime state. Mirrors the
 *  worker's AgentStatePayload structurally: `buffers` holds every ArrayBuffer
 *  field keyed by its payload name (x, y, vx, vy, radius, …, freeList, the bond
 *  store arrays, colors, sprite state; z/vz only for 3D saves), so new payload
 *  fields round-trip without a schema change. */
export interface SerializedAgentState {
  highWater: number;
  liveCount: number;
  freeTop: number;
  /** Bond stride at save time — the loader rejects a mismatch LOUDLY. */
  maxBonds: number;
  buffers: Record<string, string>;
  attrs: Record<string, { kind: string; data: string }>;
  /** P2 — USER BOND attributes, one ragged base64 buffer per attribute (the
   *  per-EDGE analogue of `attrs`). Optional: absent in every pre-P2 file and in
   *  any model with no bond attributes → each attribute loads at its default. */
  bondAttrs?: Record<string, { kind: string; data: string }>;
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
  /** 3D Grid CA: layer count. Absent → 1 (a 2D snapshot, byte-identical). */
  depth?: number;
  attributes?: Record<string, SerializedTypedArray>;
  indicators?: Record<string, number>;
  linkedAccumulators?: Record<string, number | Record<string, number>>;
  colors?: string;
  orderArray?: string;
  /** Bond-Graph Agents: the agent population (positions / velocities / attrs /
   *  bonds / sprites), base64-encoded from the worker's AgentStatePayload.
   *  Absent on pre-agents saves and non-agent models — the loader then re-seeds
   *  the agent layer to its starting configuration. */
  agents?: SerializedAgentState;
  // Simulator controls (runtime model-attribute values + UI)
  modelAttrs?: Record<string, number>;
  activeViewer?: string;
  /** The active AGENT viewer (the two-layer viewer bar's Agents row). */
  activeAgentViewer?: string;
  brushColor?: string;
  brushW?: number;
  brushH?: number;
  /** Brush stamp shape + per-shape params (rect uses brushW/H). String union
   *  kept inline to avoid importing the SimulatorView component type here. */
  brushShape?: 'rect' | 'circle' | 'ring' | 'line';
  brushRadius?: number;
  brushRingWidth?: number;
  brushLineWidth?: number;
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
  /** 3D Grid CA: layer count, restored alongside gridWidth/gridHeight so a
   *  preset can carry its volume dimensions. Absent → 1. */
  gridDepth?: number;
  /** Lookup-table model attribute overrides. Outer key = attribute id; inner
   *  table maps `rowLabel -> colLabel -> float`. Saved in presets so a preset
   *  can swap an entire parameter set (e.g. the 8 Kier 1996 amphiphile sets)
   *  without forcing the user to retype every cell. On apply, this rewrites both
   *  the cached worker tables (via updateLookupTable) and the model state
   *  (via updateAttribute) so Reset-to-Default snapshots also follow the preset.
   *  Field name retained as `interactionTables` for back-compat with presets
   *  saved before the Lookup Table rename. */
  interactionTables?: Record<string, Record<string, Record<string, number>>>;
  /** MULTI-AXIS lookup-table overrides (the axes-mode sibling of
   *  `interactionTables`): outer key = attribute id, value = the dense
   *  row-major `tableData` flat array. Legacy 2-axis tables keep riding
   *  `interactionTables`; old presets load unchanged. */
  lookupTableData?: Record<string, number[]>;
}

/** A named snapshot of model-attribute values (always) and optionally the BOARD
 *  (the cell grid and/or the agent population). Presets let one model ship many
 *  parameter variants the user can switch between in the Simulator (e.g. MNCA
 *  threshold sets), without duplicating the model into separate library entries. */
export interface Preset {
  id: string;
  name: string;
  description?: string;
  /** Embedded SimulationState — always includes modelAttrs; includes the board
   *  fields (grid attrs/colors AND, for an agent model, `agents`) only when the
   *  user checked "Include board state" at save time. Never includes UI
   *  controls (brush, viewer, FPS). */
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
/** `vector` (scalar kind only) is a per-cell / per-agent transient direction — the
 *  variable analogue of the `vector` ATTRIBUTE type. Lowered by
 *  [vectorAttr.ts](../modeler/vpl/compiler/vectorAttr.ts) into `vectorDims` scalar
 *  `float` component variables (`<id>_vx/_vy[/_vz]`) before compile, so a vector
 *  accumulator (e.g. summed forces) is ONE variable instead of two/three floats.
 *  `Get/Set Vector Variable` carry it on one wire, lowered via Make/Break Vector. */
export type VariableDataType = 'bool' | 'integer' | 'float' | 'tag' | 'vector';

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
  /** Vector dataType only (scalar kind): component count — `2` = (x, y), `3` =
   *  (x, y, z). Absent ⇒ 2. Chosen per variable (a 3D model offers both), like
   *  `Attribute.vectorDims`. `initialValue` is the comma-joined `"x,y[,z]"`. */
  vectorDims?: 2 | 3;
}

/** Bond-Graph Morphogenesis: which topology layer(s) the model uses. At least
 *  one must be true (reducer-enforced). `gridCells` is the classic lattice CA;
 *  `agents` is the bond-graph agent layer (off-lattice floating cells joined by
 *  bonds that grow + divide). NB: distinct from the legacy
 *  `ModelProperties.topology` string enum — leave that untouched. */
export interface TopologyMode {
  gridCells: boolean;
  agents: boolean;
}

// ===========================================================================
// Agent Capability Profiles — an opt-in decomposition of the agent engine so a
// model declares only the capabilities it needs. The profile is the single
// source of truth from which the editor surface derives: which palette nodes /
// Behaviour-Step ports / Edit-panel rows appear, and (Phase 2+) which SoA field
// groups + engine-step passes are allocated. See `model/agentCapabilities.ts`
// for the presets, dependency graph, migration inference, and footprint helper.
//
// v1 (STEP 0/1) is EDITOR-SURFACE ONLY: `motion`/`body` are always-allocated in
// the engine regardless of their toggle (there is no `Static` integrator path
// yet — SoA-gating them is a later XL milestone), so toggling them only
// palette-/port-gates. Everything above the honest core (Bonds, Collision,
// Growth, Division, Lifespan, Population, Orientation, Sensing, Field coupling,
// Appearance) is a genuine capability.
// ===========================================================================

/** How an agent moves. `static` = writes go direct (no integrator); `velocity`
 *  = `pos += v·dt`; `force` = `v = inertia·v + (dt/η)·F; pos += v`. v1 always
 *  allocates the velocity/force fields regardless — this is a palette/port gate. */
export type MotionMode = 'static' | 'velocity' | 'force';
/** Collision handling — two GENUINELY different models. `soft` = the soft-sphere
 *  volume-exclusion FORCE (a penalty force `μ_R·(d−s)` added to the integrator;
 *  overlap is transient, non-penetrating only in the stiff limit; springy; requires
 *  Motion=Force). `positional` = a HARD, rigid no-overlap CONSTRAINT — after
 *  integration, overlapping pairs are projected apart to exactly touching (a Jacobi
 *  position-projection, `positionalIterations` sweeps); zero overlap; works under
 *  any Motion (it edits positions directly). `off` = neither. Adhesion / springs /
 *  growth are orthogonal. See `collisionMode`/`usesSoftCollision`/
 *  `usesPositionalCollision` in centerBased.ts + docs/PLAN_POSITIONAL_COLLISION. */
export type CollisionMode = 'off' | 'soft' | 'positional';
/** Bond handling. `data` = connectivity edges only (traverse / render, carry NO
 *  force); `physics` = spring forces (requires Motion=Force); `off` = none. The
 *  Data-vs-Physics choice is a real engine distinction — springs are gated on
 *  `usesEngineSprings` (bonds==='physics'), NOT the legacy bonding bundle. */
export type BondsMode = 'off' | 'data' | 'physics';
/** C10 / P11a — the REACH of the long-range charge, i.e. which charge LAW runs.
 *  `cutoff` (the default; absent ⇒ this) is the L1 finite-cutoff pair force
 *  evaluated inside the neighbour stencil. `global` drops the cutoff and evaluates
 *  every pair through a deterministic Barnes–Hut octree (`CenterBasedConfig.
 *  chargeTheta`). Approximate ≠ nondeterministic: the CPU tree is bit-reproducible;
 *  θ changes WHICH law you run, not whether it repeats. */
export type ChargeRange = 'cutoff' | 'global';
/** Long-range charge. `on` adds a repulsive pair force with a FINITE cutoff to the
 *  fused neighbour pass — `f_ij = k·(1/(1+d²) − 1/(1+maxDist²))·(p_j − p_i)`, the
 *  `− min_c` term taking it continuously to zero at the cutoff instead of stepping.
 *  It is the ONLY force in the engine with reach beyond contact distance, so it is
 *  what opens a grown bond graph (see `usesCharge` in centerBased.ts). Requires
 *  Motion=Force. `off` (the default) is byte-identical to the pre-charge engine. */
export type ChargeMode = 'off' | 'on';

/** The declared capability set for a model's agents — the Agent Capability
 *  Profile. Additive on `CenterBasedConfig.agentCapabilities`; absent ⇒ a
 *  config-aware, usage-widened inference (`inferAgentProfile`) that reproduces
 *  the file's current behaviour, so legacy `.gcaproj` load byte-identically. */
export interface AgentCapabilities {
  /** Motion mode. v1: always-allocated; toggle = palette/port gate only. */
  motion: MotionMode;
  /** Body / extent — a radius surface + disc/sphere render. v1: always-allocated. */
  body: boolean;
  /** Collision handling (needs Body; `soft` needs Motion=Force). */
  collision: CollisionMode;
  /** LONG-RANGE charge — a repulsive `1/(1+d²)` pair force with a finite cutoff
   *  (`chargeStrength` / `chargeMaxDist`), the force that can OPEN a grown
   *  structure. The soft-sphere only pushes back BELOW contact distance, so a
   *  bond-graph whose springs rest far past contact collapses into a jammed
   *  packing; charge is what holds it open (measured: overlap 99.2 % → 0 %).
   *  Needs Motion=Force (it is a force). Default `'off'` ⇒ absent on every
   *  legacy file ⇒ byte-identical. */
  charge: ChargeMode;
  /** Bonds (needs Position; `physics` needs Motion=Force). */
  bonds: BondsMode;
  /** Engine auto-forms/breaks bonds by proximity (requires bonds='physics'). */
  autoBond: boolean;
  /** Radius ramps toward a target radius each step (requires Body). */
  growth: boolean;
  /** Structural-phase division (requires Body; Bonds enhances the tension axis). */
  division: boolean;
  /** Per-agent `age` auto-increment. */
  lifespan: boolean;
  /** Population birth — the Spawn Agent node + Spawn Event root (net-new). */
  populationBirth: boolean;
  /** Population death — the Kill Agent node (effectively always-on in v1). */
  populationDeath: boolean;
  /** Spatial hash + Get Nearby Agents + the directional-FOV nodes. */
  sensing: boolean;
  /** Heading source for the FOV nodes. `facing` requires Orientation. */
  sensingHeadingSource: 'velocity' | 'facing' | 'wired';
  /** Per-agent facing (reuses `spriteRotations`) — FOV heading / sprite rotation. */
  orientation: boolean;
  /** Agent ⇄ cell-grid morphogen field bridge (needs ≥1 cell attr with agentAccess). */
  fieldCoupling: boolean;
  /** Per-agent appearance — `colors` (always allocated) + optional sprites. */
  appearance: boolean;
}

/** Bond-Graph Agents (center-based off-lattice cells) configuration.
 *
 *  Present on a model whose `topologyMode.agents` is on (seeded by the reducer
 *  when the user enables the topology). Every numeric field is either an
 *  over-allocated ceiling (allocated once at init) or a live-tunable force /
 *  bond parameter; when absent the engine substitutes a documented default
 *  (`CENTER_BASED_DEFAULTS` in `model/centerBased.ts`), so a hand-authored or
 *  partially-populated file always runs. `maxAgents` / `maxBonds` overflow
 *  REJECTS + surfaces (never wraps — the Amphiphile-NI-poisoning class). */
export interface CenterBasedConfig {
  /** Master toggle — mirrors `topologyMode.agents`. Kept so the config can
   *  carry data while the topology is toggled off (like VariegatedCellsConfig). */
  enabled: boolean;
  /** Over-allocated agent-slot ceiling (allocate-once at init). */
  maxAgents: number;
  /** Per-agent bond-slot ceiling — the ragged bond store's stride. */
  maxBonds: number;
  /** GRA P4 — the per-agent STRUCTURAL REQUEST QUEUE depth: how many bond
   *  form / break / rewire ops one agent may issue in ONE generation. Absent ⇒ the
   *  engine default (8). A degree-preserving graph rewrite (triangle split, pair
   *  annihilation, edge swap) needs 2–5 edge mutations at one node in one step, so
   *  a single request slot made those rules inexpressible. Ops past the depth are
   *  REJECTED WHOLE (never wrapped, never half-applied — invariant I5) and surface
   *  an `agentOverflow` notice. Changing it re-lays-out the agent store (a full
   *  worker reinit). */
  bondRequestDepth?: number;
  /** Continuous world width. In a grid+agents model the field grid (W×H cells)
   *  maps onto these bounds 1:1; in an agents-only model these ARE the bounds. */
  worldWidth: number;
  /** Continuous world height. */
  worldHeight: number;
  /** 3D world depth (Phase E — agents are 2D in v1). */
  worldDepth?: number;
  // --- Force integrator (engine-owned soft-sphere; all live-tunable) ---
  /** Repulsion stiffness μ_R (volume exclusion). */
  repulsionStiffness?: number;
  /** Free-agent adhesion stiffness μ_A (0 = cohesion comes from bonds only). */
  adhesionStiffness?: number;
  /** Interaction cutoff as a multiple of the contact distance (`r_max / s`). */
  interactionRange?: number;
  /** Overdamped drag coefficient η. */
  drag?: number;
  /** User timestep Δt — auto-clamped against the monotonicity bound at init /
   *  on any force-param change. */
  timeStep?: number;
  /** Velocity persistence ∈ [0, 0.999] (the worker clamps; the Properties field
   *  caps at the same 0.999). **THIS IS THE ENGINE'S FRICTION / DAMPING KNOB** —
   *  the integrator is `v ← momentum·v + (Δt/η)·F`, so below 1 the velocity decays
   *  geometrically and a constant force settles at the finite terminal speed
   *  `(Δt/η)·F / (1 − momentum)`. 0 = fully overdamped (tissue — velocity not
   *  carried, byte-identical to the original integrator); ~0.9 gives inertia for
   *  flocking/boids; 0.999 ≈ frictionless (v_∞ = 1000·(Δt/η)·F, i.e. practically
   *  unbounded — that, not a missing feature, is what "agents accelerate forever"
   *  means).
   *
   *  A rule that damps its OWN velocity in the graph (Get Velocity → ×f → Set
   *  Velocity, as Particle Life does to expose friction as a live model-attribute
   *  slider) is NOT a second mechanism: the behaviour runs BEFORE the force pass,
   *  so that composes to `v ← (momentum·f)·v + (Δt/η)·F` — exactly `momentum × f`.
   *  Friction applied AFTER the force add, `(v + kF)·f`, is likewise `momentum = f`
   *  with `η' = η/f`. Neither placement reaches a behaviour momentum cannot. */
  momentum?: number;
  /** Optional speed cap (per step). 0 / absent = uncapped. Boids use it to keep
   *  a roughly constant cruising speed. */
  maxSpeed?: number;
  /** LONG-RANGE charge strength `k` (`agentCapabilities.charge === 'on'`).
   *  NEGATIVE = repulsive (the layout-opening case; absent ⇒ the engine default
   *  −3). The pair force is `k·(1/(1+d²) − 1/(1+maxDist²))·(p_j − p_i)`, applied
   *  to every pair within `chargeMaxDist` IN ADDITION to soft-sphere + springs. */
  chargeStrength?: number;
  /** Long-range charge CUTOFF distance (world units) — used by `chargeRange:
   *  'cutoff'` only. Absent ⇒ a DERIVED default of 8 × `bondRestLength`: measured,
   *  layout quality saturates by ~8× the bond rest length and a larger cutoff mostly
   *  inflates the layout. It must NOT be a world-absolute constant: it scales with
   *  the model's own bond length.
   *  **It also widens the spatial-hash bin edge** (`chargeBinEdgeOf`) so the 3×3(×3)
   *  stencil actually covers it — without that the force is silently truncated. */
  chargeMaxDist?: number;
  /** C10 / P11a — WHICH CHARGE LAW runs. `'cutoff'` (absent ⇒ this, so every
   *  pre-C10 file is byte-identical) is the L1 pair force evaluated inside the
   *  neighbour stencil and truncated at `chargeMaxDist`. `'global'` drops the cutoff
   *  entirely (`min_c = 0`) and evaluates EVERY pair through a deterministic
   *  Barnes–Hut octree — the unbounded reach a finite-cutoff hash structurally
   *  cannot express. It is a different LAW, not a speed-up of the same one: a model
   *  that switches follows a different trajectory (and says so in its file), exactly
   *  as changing any other physics parameter does. Still fully deterministic on the
   *  CPU targets — same positions ⇒ same Morton order ⇒ bit-identical forces. */
  chargeRange?: ChargeRange;
  /** Barnes–Hut opening angle for `chargeRange: 'global'`. A node is treated as a
   *  single centre-of-mass body when `extent² < θ²·d²`; smaller θ ⇒ more exact and
   *  slower. Absent ⇒ 0.9 (the reference value). Clamped to
   *  [`MIN_CHARGE_THETA`, `MAX_CHARGE_THETA`] by `chargeThetaOf` — θ is part of the
   *  declared law, so an out-of-range value must resolve, never throw. */
  chargeTheta?: number;
  /** Jacobi sweeps for the HARD positional collision (`agentCapabilities.collision
   *  === 'positional'`): more sweeps ⇒ tighter no-overlap packing (a single sweep
   *  resolves an isolated pair exactly; dense packing converges over a few).
   *  Absent ⇒ the engine default (2). Ignored for soft / off collision. */
  positionalIterations?: number;
  /** L3 — how many times the FORCE PASS runs per generation (numerical relaxation).
   *  Absent / 1 ⇒ exactly today's behaviour, byte-for-byte. > 1 lets the layout
   *  settle further per rewrite without inflating the generation counter, which
   *  matters for a growing bond graph: the reference layout engine runs ~120
   *  relaxation iterations per second against a much slower rewrite rate, while
   *  GenesisCA runs one force pass per generation.
   *
   *  This is an ENGINE knob, deliberately NOT a graph node — it is solver
   *  relaxation, not rule logic, the same category as `positionalIterations`
   *  (Impact Map §1.6: putting it in the graph would be like exposing an ODE's
   *  step count as a node). The rule's OWN cadence — "rewrite every Nth
   *  generation" — is model semantics and lives in the graph, as `Periodic Step`.
   *
   *  Semantics of the extra iterations: they are PURE RELAXATION. `age` and the
   *  growth ramp still advance exactly ONCE per generation, and the structural
   *  phase (the bond request-queue drain, division, death, auto-bond) still runs
   *  exactly once per generation, after the last iteration. The graph-authored
   *  Apply Force is held constant across the iterations (it is an external force
   *  for that generation), and the spatial hash is built once per generation —
   *  per-iteration displacement is tiny next to the bin edge. */
  layoutIterations?: number;
  /** When true, the engine's built-in soft-sphere repulsion/adhesion is OFF —
   *  ALL motion comes from the graph's Apply Force (pure custom-force models
   *  like boids). LEGACY: superseded by `useBondingPhysics` (the inverse master
   *  toggle). Read only as the back-compat fallback in `usesBondingPhysics()`
   *  when `useBondingPhysics` is absent — so old `.gcaproj` files load unchanged. */
  customForcesOnly?: boolean;
  /** Master "use bonding physics" toggle (the inverse of `customForcesOnly`).
   *  When ON, the full center-based engine runs: soft-sphere repulsion/adhesion +
   *  bond springs + the growth ramp + auto-bond. When OFF, NONE of those engine
   *  forces apply — agents move only by graph-authored Apply Force / Set Velocity
   *  (+ explicit division/death/Form-Bond nodes), the "agents that have nothing to
   *  do with bonds" case. DEFAULT OFF for a freshly-enabled Agents topology (so
   *  enabling agents no longer silently turns on growth/repulsion/adhesion).
   *  Resolved via `usesBondingPhysics(cfg) = useBondingPhysics ?? !customForcesOnly`
   *  — when absent (legacy files) it falls back to the old `!customForcesOnly`
   *  semantics, reproducing every existing model with NO migration. */
  useBondingPhysics?: boolean;
  /** The radius (cell units) Get Nearby Agents queries are expected to use. It
   *  sizes the spatial-hash bin so a query within this radius is covered by the
   *  3×3 bin stencil (a larger value = larger bins = more candidates per bin). */
  neighbourQueryRadius?: number;
  // --- Seeding (Reset + seed-brush defaults) ---
  /** Agents seeded on Reset (0 = the author seeds via the brush / Init Event). */
  seedCount?: number;
  /** Initial seeding layout. 'compact' (default) = a centred packed blob (the
   *  morphogenesis starting point). 'scatter' = uniformly random across the
   *  world (dispersed populations — flocking, chemotaxis aggregation).
   *  'none' = NO automatic seeding at all: the population comes entirely from
   *  the Agent Init Event and/or the Add brush. It is a genuine third option,
   *  not "seedCount 0" — the count keeps its value (so switching back to a
   *  pattern restores it) and 'none' draws NOTHING from the seeded RNG stream
   *  (C7/P7: the scatter placement is the only seeding path that advances it,
   *  so a 'none' model's stream is byte-identical to an unseeded one). ABSENT
   *  ⇒ 'compact' ⇒ today's behaviour, so old files need no migration. */
  seedPattern?: 'compact' | 'scatter' | 'none';
  /** Default agent radius (the rest contact distance between two agents is the
   *  sum of their radii). */
  defaultRadius?: number;
  /** Radius units per step an agent's radius ramps toward its target radius
   *  (set by Set Target Radius). Phase C couples it to the cell cycle. */
  growthRate?: number;
  // --- Bonds (Phase B) ---
  /** `lookupTable` model-attribute id giving per-type-pair bond stiffness λ +
   *  rest length L. Absent → a single global λ/L from `bondStiffness`/`bondRestLength`. */
  bondSpringMatrixId?: string;
  /** Global bond stiffness λ used when no spring matrix is set. */
  bondStiffness?: number;
  /** Global bond rest length L used when no spring matrix is set. */
  bondRestLength?: number;
  /** Auto-form distance d_form, as a multiple of the two agents' contact
   *  distance (sum of radii). Engine hysteresis requires d_form < d_break. */
  formDistance?: number;
  /** Auto-break distance d_break (same units as formDistance). */
  breakDistance?: number;
  /** When true, the engine automatically bonds any two unbonded agents that
   *  come within `formDistance` and breaks bonds stretched past `breakDistance`
   *  (the hysteresis prevents per-step flicker). The simplest path to a glued
   *  cluster; explicit Form Bond / Break Bond nodes + the glue brush give
   *  per-rule control on top. */
  autoBond?: boolean;
  /** Agent ENGINE, INDEPENDENT of the grid engine (`properties.engine`). Grid
   *  and agents can differ: e.g. a WebGPU grid (diffusion) driving WASM agents.
   *
   *  C4 (P1): `'auto'` = "the fastest engine this agent graph can use", resolved
   *  + displayed by `resolveEngines`. Absent ⇒ the historical `'js'` resolution
   *  (migration deliberately does NOT flip existing files to `'auto'`).
   *  A concrete value is clamped to what the graph actually supports by
   *  `agentTargetOf` (the file-load safety net). */
  agentTarget?: EngineChoice;
  /** Agent update synchronicity, INDEPENDENT of the grid's
   *  `model.properties.updateMode`. The user can run a synchronous grid rule
   *  with asynchronous agents, and vice versa.
   *  - `'async'` (DEFAULT — byte-identical to pre-feature behaviour): the agent
   *    attribute buffers are single-buffered (`attrWrite` aliases `attrRead`), so
   *    a `Set Attribute` write aimed at a neighbour is IMMEDIATELY visible to a
   *    later agent in the same step (sequential semantics).
   *  - `'sync'`: the attribute buffers are double-buffered — every agent reads the
   *    PREVIOUS step's attributes and writes go to a separate buffer swapped in at
   *    the end of the step (parallel/snapshot semantics; the prerequisite for the
   *    forthcoming WebGPU agent target, which runs agents in parallel). Positions
   *    are snapshot-integrated in BOTH modes (the force law reads one position
   *    snapshot); this flag governs the ATTRIBUTE read/write visibility. */
  agentUpdateMode?: 'sync' | 'async';
  /** Agent Capability Profile — the declared set of enabled capabilities (Motion,
   *  Body, Collision, Bonds, Growth, Division, Lifespan, Population, Sensing,
   *  Orientation, Field coupling, Appearance). Drives the editor surface (palette
   *  nodes / Behaviour-Step ports / Edit-panel rows) and, from Phase 2, the SoA
   *  layout + engine-step composition. Absent ⇒ a config-aware, usage-widened
   *  inference (`inferAgentProfile` in `model/agentCapabilities.ts`) that
   *  reproduces the file's current behaviour — so legacy `.gcaproj` load
   *  byte-identically. Seeded to a friendly default when the Agents topology is
   *  first enabled. */
  agentCapabilities?: AgentCapabilities;
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
  /** Bond-Graph Agents: the SECOND rule graph (the off-lattice agent behaviour
   *  rule). `graphNodes`/`graphEdges` above is the Grid-Cells (lattice) graph
   *  and is unchanged (zero migration). Absent / empty in every legacy file +
   *  in any non-agent model. `macroDefs` is SHARED by both graphs. */
  agentGraphNodes?: GraphNode[];
  agentGraphEdges?: GraphEdge[];
  /** Generic Agent Platform: the AGENT attribute set — agent-only per-agent
   *  state, a SEPARATE id-space from `attributes` (the cell/model attributes).
   *  Agents read/write these (own state via Get/Set Attribute on the Agents
   *  graph, other agents via Get Agent Attribute / a by-id Set Attribute); CA cells can never
   *  access them. Always `isModelAttribute: false` (globals are still the shared
   *  model attributes, read via Get Model Attribute). Absent/empty in every
   *  legacy file + non-agent model. Resolved everywhere via `agentAttrsOf` in
   *  `model/attributeScope.ts`. The `_field_<id>` bridge stays keyed by the CELL
   *  attributes (`cellFieldAttrsOf`), so the two id-spaces never collide. */
  agentAttributes?: Attribute[];
  /** Graph-Rewriting Automata (P2): the BOND attribute set — per-EDGE user state,
   *  a THIRD id-space alongside `attributes` (cell/model) and `agentAttributes`.
   *  A bond is one object stored twice (both endpoints carry a slot), so a bond
   *  attribute is SYMMETRIC: Set Bond Attribute writes BOTH slots and invariant I2
   *  requires them to agree. Read/written via Get/Set Bond Attribute (by partner
   *  id) and seeded at Form Bond time.
   *
   *  ONLY `bool` / `integer` / `float` / `tag` are offered (decision D1) — the
   *  scalar-numeric set that fits one number exactly on every target. `vector` /
   *  `color` / `neighborIndex` are excluded: a vector bond attribute would need
   *  the `lowerVectorAttrs` treatment on a RAGGED store, a separate milestone.
   *  The UI dropdown enforces it and the store/layout skip anything else
   *  defensively (a hand-edited file cannot allocate a shape no target can read).
   *
   *  Absent/empty in every legacy file + non-agent model; a Bonds-capability-off
   *  model allocates ZERO bond-attribute bytes (`resolveMaxBonds` → 0). */
  bondAttributes?: Attribute[];
  /** Generic Agent Platform: the AGENT Attribute→Color output mappings — separate
   *  "views" of the agent population, the agent analogue of `mappings` (the CELL-grid
   *  mappings). Each is an A→C view over the AGENT attribute set, **Standalone OR
   *  Linked** (like the cell output mappings): `linked` ⇒ the compiler synthesizes a
   *  per-agent colour pass (getCellAttribute[agentAttr] → colorScale/categorical →
   *  setCellLooks) from `linkedAttributeId` (resolved against `agentAttributes`);
   *  Standalone ⇒ the user wires an `agentOutputMapping` graph on the Agents tab
   *  (→ Set Cell Looks / Set Agent Sprite). A Linked mapping that ALSO has a user
   *  `agentOutputMapping` root runs the auto pass first as a background then the user
   *  graph (override-after-background). When BOTH `mappings` (cell) and `agentMappings`
   *  (agent) are non-empty the simulator shows a two-layer viewer selection.
   *  Absent/empty in every legacy file + non-agent model. Only A→C (agent input
   *  mappings are deferred). */
  agentMappings?: Mapping[];
  /** Imported sprite assets (static images / animated GIFs) — the optional agent
   *  exhibition layer. Referenced by `setAgentSprite` nodes in an agent output
   *  mapping graph. Travels inside the `.gcaproj` (each a base64 data URL). Absent
   *  / empty in every legacy file + non-sprite model. */
  sprites?: SpriteAsset[];
  macroDefs: MacroDef[];
  /** Local Variables — per-cell mutable storage referenced by getVariable /
   *  setVariable / setArrayElement nodes. Empty / absent → no variables in
   *  the model. */
  variables?: Variable[];
  /** Generic Agent Platform: the AGENT local-variable set — per-agent scratch
   *  storage for the Agents rule graph, a SEPARATE id-space from `variables`
   *  (the cell variables). The agent behaviour/division/init loops resolve their
   *  Get/Set Variable nodes against this list; the cell step uses `variables`.
   *  Absent/empty in every legacy file + non-agent model. */
  agentVariables?: Variable[];
  simulationState?: SimulationState;
  presets?: Preset[];
  /** Variegated Cells feature config. Absent / `enabled: false` → engine and
   *  UI behave as if the feature didn't exist. See `VariegatedCellsConfig`. */
  variegatedCells?: VariegatedCellsConfig;
  /** Bond-Graph Morphogenesis topology selection. Absent →
   *  `{ gridCells: true, agents: false }` (the LOAD_MODEL migration seeds it).
   *  ≥1 flag must be true (reducer-enforced). */
  topologyMode?: TopologyMode;
  /** Bond-Graph Agents config (force law, ceilings, world bounds, bond params).
   *  Seeded when `topologyMode.agents` is enabled; absent / `enabled: false` →
   *  the agent engine is dormant. See `CenterBasedConfig`. */
  centerBased?: CenterBasedConfig;
  /** Overseer — the THIRD rule graph: experiment orchestration AROUND the
   *  simulation (loops over runs, parameter sweeps, statistical aggregation,
   *  capture). Absent / empty in every legacy file + any model with the
   *  Overseer disabled. `macroDefs` is SHARED with the other two graphs. */
  overseerGraphNodes?: GraphNode[];
  overseerGraphEdges?: GraphEdge[];
  /** Overseer feature config. Absent / `enabled: false` → the feature is
   *  completely invisible (no graph tab, no palette nodes, no Experiments
   *  panel) — the ONLY sign of it is the enable checkbox in Model Properties.
   *  See `OverseerConfig`. */
  overseerConfig?: OverseerConfig;
}

/** Overseer (experiment orchestration) feature config. All fields beyond
 *  `enabled` are optional with safe defaults. */
export interface OverseerConfig {
  /** Master gate. Off → zero UI/compile/runtime footprint. */
  enabled: boolean;
  /** Per-run auto-seed applied by the runtime when a run starts WITHOUT an
   *  explicit Set Random Seed node having run first this run:
   *  - 'none' (default): never auto-seed — the graph is in full control.
   *  - 'fixed': every Reset re-seeds with `baseSeed`.
   *  - 'sequential': run k re-seeds with `baseSeed + k` (k = Reset count). */
  seedPolicy?: 'none' | 'fixed' | 'sequential';
  baseSeed?: number;
  /** Ceiling for in-memory Save Snapshot slots (default 4). */
  maxSnapshotSlots?: number;
}
