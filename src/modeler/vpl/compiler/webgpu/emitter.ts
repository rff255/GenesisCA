/**
 * WgslEmitter — Wave 3 backend.
 *
 * Stateful per-function source builder. Mirrors the WASM `WasmEmitter` API
 * surface (line-based emit, locals allocator, multi-output cache) but produces
 * WGSL source instead of bytecode. The orchestrator in `compile.ts` walks the
 * graph and calls per-node emitters which use this class to assemble their
 * fragments.
 *
 * Step 1 scope: skeleton class with the API the orchestrator and per-node
 * emitters will use. Step 4 fills in the per-node emitter dispatch tables.
 */

/** A reference to a WGSL value: either a named local or an inline literal. */
export type ValueRef =
  | { kind: 'local'; name: string; type: WgslType }
  | { kind: 'inline'; expr: string; type: WgslType };

/** A reference to a WGSL array materialised in workgroup-private memory. */
export interface ArrayRef {
  kind: 'array';
  /** The array variable's WGSL name. */
  name: string;
  /** Length expression (may be a constant or a local name). */
  lenExpr: string;
  elemType: WgslType;
}

export type WgslType = 'i32' | 'u32' | 'f32' | 'bool';

export class WgslEmitter {
  private lines: string[] = [];
  private localCounter = 0;
  /** Multi-output node cache: nodeId → portId → ValueRef. Mirrors the WASM
   *  emitter's `valueLocals` map — when a node has multiple outputs (color
   *  channels, macro outputs), each is registered here so consumers fetch the
   *  right named local. */
  readonly valueLocals = new Map<string, Map<string, ValueRef>>();

  /** Append a raw WGSL line to the body. */
  emit(line: string): void { this.lines.push(line); }

  /** Allocate a fresh local variable name (no `let` emission yet). */
  allocLocal(prefix: string = 'l'): string {
    return `_${prefix}${this.localCounter++}`;
  }

  /** Emit `let <name> = <expr>;` and return a ValueRef pointing to it. */
  emitLet(name: string, type: WgslType, expr: string): ValueRef {
    this.lines.push(`  let ${name}: ${type} = ${expr};`);
    return { kind: 'local', name, type };
  }

  /** Emit `var <name> = <expr>;` (mutable). */
  emitVar(name: string, type: WgslType, expr: string): ValueRef {
    this.lines.push(`  var ${name}: ${type} = ${expr};`);
    return { kind: 'local', name, type };
  }

  /** Cache a multi-output port result. */
  setCachedPort(nodeId: string, portId: string, ref: ValueRef): void {
    let m = this.valueLocals.get(nodeId);
    if (!m) { m = new Map(); this.valueLocals.set(nodeId, m); }
    m.set(portId, ref);
  }

  getCachedPort(nodeId: string, portId: string): ValueRef | undefined {
    return this.valueLocals.get(nodeId)?.get(portId);
  }

  /** Reset per-cell state (multi-output cache, local counter). Called at the
   *  top of each cell iteration so locals don't accumulate across cells. */
  resetPerCell(): void {
    this.valueLocals.clear();
    this.localCounter = 0;
  }

  /** Render the assembled body. */
  build(): string {
    return this.lines.join('\n') + '\n';
  }
}

/** Convert a runtime value into the WGSL literal that produces it. */
export function wgslLiteral(v: number | boolean, type: WgslType): string {
  if (type === 'bool') return v ? 'true' : 'false';
  if (type === 'u32') return `${Math.max(0, Math.floor(Number(v)))}u`;
  if (type === 'i32') return `${Math.floor(Number(v))}`;
  // f32 — always emit a decimal point so WGSL parses as float.
  const n = Number(v);
  if (Number.isInteger(n)) return `${n}.0`;
  return `${n}`;
}
