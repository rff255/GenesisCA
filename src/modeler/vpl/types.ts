/** Data types that flow through value ports */
export type PortDataType = 'bool' | 'integer' | 'float' | 'any';

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
}

/** Configuration stored per-node-instance in the graph */
export interface NodeConfig {
  [key: string]: string | number | boolean;
}

/** Definition of a node type */
export interface NodeTypeDef {
  type: string;
  label: string;
  category: 'data' | 'logic' | 'aggregation' | 'flow' | 'output' | 'color';
  color: string;
  ports: PortDef[];
  defaultConfig: NodeConfig;
  /** Emit JS code for this node. Returns code string. */
  compile: (nodeId: string, config: NodeConfig, inputVars: Record<string, string>) => string;
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
