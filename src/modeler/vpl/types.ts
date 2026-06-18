import type { CAModel } from '../../model/types';

/** Data types that flow through value ports.
 *
 *  `neighborIndex` is a packed `i32` carrying `((dr + 128) << 8) | ((dc + 128) & 0xFF)` —
 *  an offset relative to the current cell, with 8-bit signed components. It is distinct
 *  from `integer` to prevent the silent index-kind hazards (cell-idx vs coord-idx vs
 *  list-position) that previously surfaced as wrong-cell lookups at runtime. */
export type PortDataType = 'bool' | 'integer' | 'float' | 'neighborIndex' | 'any';

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
  /** 3D Grid CA: requires a 2D lattice (`dimension !== '3d'`). Set on the
   *  `neighborIndex` family (the 2-axis packNI codec has no third offset), so
   *  those nodes are hidden from the palette / add-node menu in 3D models and
   *  badged if present. `getNeighborAttributeByTag` (flat coord index) is the
   *  3D substitute. */
  lattice2d?: boolean;
}

/** Definition of a node type */
export interface NodeTypeDef {
  type: string;
  label: string;
  category: 'event' | 'data' | 'logic' | 'aggregation' | 'flow' | 'output' | 'color';
  color: string;
  /** Short one-sentence tooltip for the Add-Node menu and explorer. */
  description?: string;
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
