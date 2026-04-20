/**
 * Stateful WASM function-body emitter.
 *
 * Holds the byte stream + local declarations for a single function body.
 * Per-node emit code calls helper methods on this object to push opcodes
 * onto the byte stream and to allocate fresh locals on demand.
 *
 * `numParams` is fixed at construction; param indices 0..numParams-1 are
 * NOT counted as `locals` (they're declared in the function type). All
 * allocLocal() returns are >= numParams.
 */

import {
  ValType, F64, I32,
  buildFuncBody, byte, concat, leb128s, leb128u, localsRun,
  opBlock, opBr, opBrIf, opF64Const, opF64Load, opF64Store, opI32Const,
  opI32Load, opI32Load8U, opI32Store, opI32Store8, opIf, opLocalGet,
  opLocalSet, opLocalTee, opLoop,
  OP_ELSE, OP_END, OP_F64_CONVERT_I32_S, OP_I32_TRUNC_F64_S,
} from './encoder';

export class WasmEmitter {
  private bytes: number[] = [];
  private locals: ValType[] = [];

  constructor(public readonly numParams: number) {}

  /** Append raw bytes (any encoder helper output). */
  emit(...parts: Uint8Array[]): void {
    for (const p of parts) for (let i = 0; i < p.length; i++) this.bytes.push(p[i]!);
  }

  /** Allocate a new local of given valtype; returns its index (incl. params). */
  allocLocal(valtype: ValType): number {
    this.locals.push(valtype);
    return this.numParams + this.locals.length - 1;
  }

  /** Build the function body (locals + expr + END). */
  buildBody(): Uint8Array {
    // Group consecutive locals of same type into runs to compress LEB128 output.
    const runs: Uint8Array[] = [];
    let runType: ValType | null = null;
    let runCount = 0;
    for (const t of this.locals) {
      if (t === runType) runCount++;
      else {
        if (runType !== null) runs.push(localsRun(runCount, runType));
        runType = t;
        runCount = 1;
      }
    }
    if (runType !== null) runs.push(localsRun(runCount, runType));
    return buildFuncBody(runs, new Uint8Array(this.bytes));
  }

  // ---- High-level convenience emit helpers (push ops onto the byte stream) ----

  i32Const(n: number): void { this.emit(opI32Const(n)); }
  f64Const(n: number): void { this.emit(opF64Const(n)); }
  localGet(idx: number): void { this.emit(opLocalGet(idx)); }
  localSet(idx: number): void { this.emit(opLocalSet(idx)); }
  localTee(idx: number): void { this.emit(opLocalTee(idx)); }

  i32Load(offset = 0, align = 2): void { this.emit(opI32Load(offset, align)); }
  i32Load8U(offset = 0, align = 0): void { this.emit(opI32Load8U(offset, align)); }
  f64Load(offset = 0, align = 3): void { this.emit(opF64Load(offset, align)); }
  i32Store(offset = 0, align = 2): void { this.emit(opI32Store(offset, align)); }
  i32Store8(offset = 0, align = 0): void { this.emit(opI32Store8(offset, align)); }
  f64Store(offset = 0, align = 3): void { this.emit(opF64Store(offset, align)); }

  /** if (cond_i32) { ... } */
  ifThen(body: () => void): void {
    this.emit(opIf());
    body();
    this.emit(OP_END);
  }
  /** if (cond_i32) { thenBody } else { elseBody } */
  ifThenElse(thenBody: () => void, elseBody: () => void): void {
    this.emit(opIf());
    thenBody();
    this.emit(OP_ELSE);
    elseBody();
    this.emit(OP_END);
  }
  /** block { body } — body can `br 0` to break. */
  block(body: () => void): void {
    this.emit(opBlock());
    body();
    this.emit(OP_END);
  }
  /** loop { body } — body can `br 0` to continue. */
  loop(body: () => void): void {
    this.emit(opLoop());
    body();
    this.emit(OP_END);
  }
  br(labelIdx: number): void { this.emit(opBr(labelIdx)); }
  brIf(labelIdx: number): void { this.emit(opBrIf(labelIdx)); }

  /** Push a raw single-byte op (for OP_I32_ADD etc. constants). */
  op(b: Uint8Array): void { this.emit(b); }

  /** Convert top-of-stack i32 → f64 (signed). */
  i32ToF64(): void { this.emit(OP_F64_CONVERT_I32_S); }
  /** Convert top-of-stack f64 → i32 (signed truncation). */
  f64ToI32(): void { this.emit(OP_I32_TRUNC_F64_S); }
}

/** A reference to a value held in a local. */
export interface LocalRef {
  localIdx: number;
  valtype: ValType;
}

/** A constant inline value (no input wired, port has inline widget). */
export interface InlineRef {
  inline: true;
  value: number; // numeric literal
  valtype: ValType;
}

export type ValueRef = LocalRef | InlineRef;

export function isInline(v: ValueRef | undefined): v is InlineRef {
  return !!v && (v as InlineRef).inline === true;
}

/**
 * A reference to an array materialised in linear memory's per-cell scratch
 * region. `offsetLocal` and `lenLocal` are i32 locals; `offsetLocal` holds the
 * byte offset (an absolute address into wasmMemory) where the first element
 * lives, and `lenLocal` holds the element count. Element addressing:
 *   element[i] = load <elemBytes> at (offsetLocal + i * elemBytes)
 * Producer responsibilities: bump the per-cell scratch top before writing,
 * advance scratchTop past the elements after writing.
 */
export interface ArrayRef {
  kind: 'array';
  offsetLocal: number;
  lenLocal: number;
  elemValtype: ValType;
  elemBytes: number;
}

/** Push a value onto the WASM stack (load from local, or push constant). */
export function pushValue(em: WasmEmitter, v: ValueRef): void {
  if (isInline(v)) {
    if (v.valtype === I32) em.i32Const(v.value | 0);
    else em.f64Const(v.value);
  } else {
    em.localGet(v.localIdx);
  }
}

/** Push a value onto the stack, converting to the requested valtype if needed. */
export function pushValueAs(em: WasmEmitter, v: ValueRef, want: ValType): void {
  pushValue(em, v);
  if (v.valtype !== want) {
    if (want === F64) em.i32ToF64();
    else em.f64ToI32();
  }
}

// ---- LEB128 / byte helpers re-exported for nodes that need raw encoding ----
export { leb128s, leb128u, byte, concat };
