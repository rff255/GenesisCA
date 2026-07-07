import type { CAModel } from '../../model/types';

/** Data types that flow through value ports.
 *
 *  `neighborIndex` is a packed `i32` carrying `((dr + 128) << 8) | ((dc + 128) & 0xFF)` —
 *  an offset relative to the current cell, with 8-bit signed components. It is distinct
 *  from `integer` to prevent the silent index-kind hazards (cell-idx vs coord-idx vs
 *  list-position) that previously surfaced as wrong-cell lookups at runtime. */
/** `vector` is a 2D/3D vector value, carried as a JS `[x, y, z]` array (z = 0 in
 *  a 2D model). `color` is an RGBA value carried as `[r, g, b, a]`. Both are
 *  bundled composite types (the Unreal/Blender Make/Break pattern) so the graph
 *  passes a whole vector/colour on one wire instead of per-component scalars.
 *  Built with Make Vector / Make Color, taken apart with Break Vector / Break
 *  Colour, and combined with Vector Op. JS compile target only — a model that
 *  uses them on the grid clamps to the Debug/Reference (JS) engine (the agent
 *  WASM/WebGPU targets clamp to JS too). */
export type PortDataType = 'bool' | 'integer' | 'float' | 'neighborIndex' | 'vector' | 'color' | 'any';

/** Port direction */
export type PortKind = 'input' | 'output';

/** Port category — value carries data, flow carries execution order */
export type PortCategory = 'value' | 'flow';

/** Definition of a port on a node */
export interface PortDef {
  id: string;
  label: string;
  kind: PortKind;
  category: PortCategory;
  dataType?: PortDataType;  // only for value ports
  isArray?: boolean;        // true for array-typed value ports (e.g., neighbor values)
  /** Dual-mode relay flag — a scalar-typed port (`isArray` false) that may ALSO
   *  carry an array shape depending on its wiring. Only `valueSwitch`'s
   *  ifValue/elseValue/result use this: when both branches relay arrays the
   *  result is an array (the compilers handle this via `producesArray` /
   *  `sourceYieldsArray`). Consumed ONLY by the connection-suggestion layer
   *  (`portsCompatible` in GraphEditor) so the compatible-nodes menu / panel-drag
   *  offer such ports in array contexts too. Has no effect on `isValidConnection`
   *  (which already permits the wiring) or on any compiler. */
  arrayCapable?: boolean;
  /** Inline widget type for unconnected input ports (Unreal Blueprint style) */
  inlineWidget?: 'number' | 'bool' | 'color' | 'tag' | 'glyph';
  /** Default value for inline widget when port is unconnected */
  defaultValue?: string;
}

/** Configuration stored per-node-instance in the graph */
export interface NodeConfig {
  [key: string]: string | number | boolean;
}

/** Compile-time helpers that wrap raw `r_<attrId>[idx]` / `w_<attrId>[idx]`
 *  access with sub-attribute parent-check guards when the attribute is a
 *  sub-attribute. Regular attributes pass through unchanged. Nodes that emit
 *  attribute reads should call these instead of inlining the buffer access. */
export interface CompileContext {
  /** Read expression for an attribute at the given cell index expression.
   *  Regular attribute → `r_<id>[<idxExpr>]`. Sub-attribute → ternary that
   *  returns `undefinedValue` when the parent's value at `<idxExpr>` is not in
   *  the configured `parentValues` set. */
  readAttrExpr(attrId: string, idxExpr: string, opts?: { fromWriteBuffer?: boolean }): string;
  /** Expression that evaluates true when the parent's value at `<idxExpr>` is
   *  in the configured `parentValues` set. Returns null when the attribute is
   *  not a sub-attribute. Used by iteration nodes (FilterNeighbors,
   *  GetNeighborsAttribute) to short-circuit non-matching cells. */
  parentMatchesExpr(attrId: string, idxExpr: string, opts?: { fromWriteBuffer?: boolean }): string | null;
  /** Returns the configured `defaultValue` for an attribute as a JS literal
   *  string (e.g., '0' for tag index 0, '1.5' for float). Falls back to a
   *  type-appropriate zero. */
  defaultValueLiteral(attrId: string): string;
  /** 3D Grid CA: true when the model is a 3D volume (dimension==='3d' && depth>1).
   *  NI-codec nodes use it to pick the 3-axis pack/unpack + the `_layer`/`WH`
   *  cell-resolution. Absent/false → the 2D 16-bit codec (byte-identical). */
  is3d?: boolean;
  /** Generic Agent Platform: which agent root the current compile is emitting
   *  (`'init'` = the once-per-reset Agent Init Event, `'behaviour'` = behaviourStep,
   *  `'division'` = divisionEvent). Used by Set Agent Attribute / the by-id setters
   *  to relax the live-agent guard in the init context (a freshly Created agent is
   *  STAGED — alive=0 — until Add Agent To World commits it). Absent on cell roots. */
  agentRoot?: 'init' | 'behaviour' | 'division';
}

/** Capability requirements for a node type. A node whose requirements aren't
 *  met by the current model is:
 *    - hidden from the palette and Add-Node menu (so users don't add nodes
 *      that won't work),
 *    - flagged with an amber `!` badge if already in the graph (so loading a
 *      `.gcaproj` that doesn't satisfy a requirement still surfaces the issue),
 *    - rejected by the compilers (defence-in-depth — runtime never silently
 *      misbehaves on a requirement violation).
 *
 *  Requirements are additive: a node satisfies the gate iff ALL flags hold for
 *  the current model. Adding a new capability flag means adding a check in
 *  `detectCapabilityRequirements` in `nodes/nodeValidation.ts`. */
export interface NodeRequirements {
  /** Requires `model.properties.updateMode === 'asynchronous'`. */
  async?: boolean;
  /** Requires `model.variegatedCells?.enabled === true`. */
  variegated?: boolean;
  /** 3D Grid CA: requires a 2D lattice (`dimension !== '3d'`). Generic 2D-only
   *  capability gate — a node carrying it is hidden from the palette / add-node
   *  menu in 3D models and badged if present. **Currently no node sets this**:
   *  the `neighborIndex` family was un-gated once the 3-axis (dr, dc, dl) codec
   *  landed on all three targets (it now packs three 10-bit fields in 3D). The
   *  flag is kept as infrastructure for any future genuinely-2D-only node. */
  lattice2d?: boolean;
  /** Bond-Graph Agents: an AGENT-world node (behaviourStep, GetSelfPosition,
   *  DivideAgent, FormBond, AffectCellsUnder, …). Available only when the model
   *  has `topologyMode.agents` enabled AND the user is editing the Agents rule
   *  graph (the active sub-tab is `'agents'`). Hidden everywhere else. */
  bondGraph?: boolean;
  /** Bond-Graph Agents: a LATTICE-world node (grid / neighbourhood reads, the
   *  classic CA set) that has no meaning in an agent rule graph. Hidden when the
   *  user is editing the Agents rule graph (active sub-tab `'agents'`). A node
   *  with neither `bondGraph` nor `lattice` is available in both graphs (e.g.
   *  arithmetic, Get Constant — pure value plumbing). */
  lattice?: boolean;
}

/** Definition of a node type */
export interface NodeTypeDef {
  type: string;
  label: string;
  /** Optional alternate display label shown when the node sits in the AGENTS
   *  graph (active sub-tab `'agents'`). Lets a UNIVERSAL node read naturally in
   *  both contexts — e.g. `getCellAttribute` shows "Get Cell Attribute" on the
   *  Cells graph and "Get Self Attribute" on the Agents graph (it reads the
   *  current agent's own attribute there). Display-only: the node `type` /
   *  compile path are unchanged. Consumed by CaNode + the palette + the add-node
   *  menu via `displayNodeLabel(def)`. */
  agentLabel?: string;
  category: 'event' | 'data' | 'logic' | 'aggregation' | 'flow' | 'output' | 'color';
  color: string;
  /** Short one-sentence tooltip for the Add-Node menu and explorer. */
  description?: string;
  /** Optional alternate `description` shown in the AGENTS graph (pairs with
   *  `agentLabel`). Display-only. */
  agentDescription?: string;
  /** Per-node capability gating (async-only, variegated-only, ...). See
   *  `NodeRequirements`. Undefined = available in any model. */
  requirements?: NodeRequirements;
  ports: PortDef[];
  /** Optional: ids of STATIC ports that carry no meaning under the current
   *  config and should be HIDDEN in the editor (e.g. Math's `y` for the unary
   *  `sqrt`/`abs` ops, Update Indicator's `value` for `toggle`/`next`/`previous`).
   *  Applied as a final filter by BOTH CaNode's render path AND
   *  `effectivePorts.getEffectivePorts`, so the rule lives once on the node def
   *  instead of being duplicated (and risking drift) across both. Hiding is
   *  UI-only — the compilers ignore the dead port anyway, and any pre-existing
   *  edge into it simply goes unread. Nodes that ADD or transform ports per
   *  config (switch/sequence/expression) keep that logic inline; this hook is
   *  only for removing static ports. */
  hiddenPorts?: (config: NodeConfig, model?: CAModel) => string[];
  defaultConfig: NodeConfig;
  /** Emit JS code for this node. Returns code string.
   *  `boundary` is the model's boundary treatment ('torus' | 'constant'),
   *  needed by NI access emitters to inline the right cell-index expression.
   *  `ctx` provides sub-attribute-aware read helpers; nodes that emit attribute
   *  reads MUST call ctx.readAttrExpr instead of inlining `r_<id>[idx]` so the
   *  parent-check guard is applied when the attribute is a sub-attribute.
   *  Other nodes may ignore both. */
  compile: (
    nodeId: string,
    config: NodeConfig,
    inputVars: Record<string, string>,
    boundary?: 'torus' | 'constant',
    ctx?: CompileContext,
  ) => string;
}

/** Handle ID encoding: combine port kind, category, and port id */
export function handleId(port: Pick<PortDef, 'id' | 'kind' | 'category'>): string {
  return `${port.kind}_${port.category}_${port.id}`;
}

/** Parse a React Flow handle ID back to its parts */
export function parseHandleId(id: string): { kind: PortKind; category: PortCategory; portId: string } | null {
  const match = id.match(/^(input|output)_(value|flow)_(.+)$/);
  if (!match) return null;
  return {
    kind: match[1] as PortKind,
    category: match[2] as PortCategory,
    portId: match[3]!,
  };
}
