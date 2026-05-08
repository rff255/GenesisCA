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
  /** Inline widget type for unconnected input ports (Unreal Blueprint style) */
  inlineWidget?: 'number' | 'bool' | 'color' | 'tag';
  /** Default value for inline widget when port is unconnected */
  defaultValue?: string;
}

/** Configuration stored per-node-instance in the graph */
export interface NodeConfig {
  [key: string]: string | number | boolean;
}

/** Definition of a node type */
export interface NodeTypeDef {
  type: string;
  label: string;
  category: 'event' | 'data' | 'logic' | 'aggregation' | 'flow' | 'output' | 'color';
  color: string;
  /** Short one-sentence tooltip for the Add-Node menu and explorer. */
  description?: string;
  ports: PortDef[];
  defaultConfig: NodeConfig;
  /** Emit JS code for this node. Returns code string.
   *  `boundary` is the model's boundary treatment ('torus' | 'constant'),
   *  needed by NI access emitters to inline the right cell-index expression.
   *  Other nodes may ignore it. */
  compile: (
    nodeId: string,
    config: NodeConfig,
    inputVars: Record<string, string>,
    boundary?: 'torus' | 'constant',
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
