/**
 * Graph → WebAssembly compiler (Wave 2 backend).
 *
 * Emits a WASM module that imports linear memory from the host (the worker)
 * and exports a `step(total: i32) -> void` function. The host already laid
 * out cell attribute arrays and the color buffer in that memory at known
 * offsets — the compiled WASM accesses them directly via load/store.
 *
 * Phase 2B.2 status: skeleton only. The emitted step function iterates
 * 0..total but does no per-cell work. Subsequent phases will:
 *   - 2B.3: add the r→w copy lines (sync mode)
 *   - 2B.4+: port one node type at a time (GetConstant, SetAttribute, ...)
 */

import {
  I32, OP_END, OP_I32_ADD, OP_I32_GE_S, OP_I32_MUL,
  buildFuncBody, buildModule, concat, exportEntry, EXPORT_FUNC,
  funcType, importEntry, importMemoryDesc, leb128u, localsRun,
  opBlock, opBr, opBrIf, opF64Load, opF64Store, opI32Const, opI32Load, opI32Load8U,
  opI32Store, opI32Store8, opLocalGet, opLocalSet, opLoop,
} from './encoder';

export interface WasmCompileResult {
  /** Module bytes ready for `WebAssembly.compile`. */
  bytes: Uint8Array;
  /** Minimum pages the host's memory must have to satisfy the import. The
   *  host already sized memory based on cell-attr layout; this is a sanity
   *  floor (1 page is always fine for the skeleton). */
  minMemoryPages: number;
}

/** What the host tells the WASM compiler about cell-attribute storage.
 *  Offsets and itemBytes match the layout the worker computed and used to
 *  allocate WebAssembly.Memory. */
export interface AttrLayout {
  id: string;
  /** Source attribute type ('bool' | 'integer' | 'tag' | 'float'). */
  type: string;
  /** Byte offset of the read region for this attribute in linear memory. */
  readOffset: number;
  /** Byte offset of the write region. Equals readOffset in async mode. */
  writeOffset: number;
  /** 1 (bool), 4 (integer/tag), 8 (float). */
  itemBytes: number;
}

export interface WasmCompileLayout {
  cellAttrs: AttrLayout[];
  isAsync: boolean;
}

// ---------------------------------------------------------------------------
// Per-attribute load/store opcode pairs by type. We use unsigned 8-bit for
// bool (only 0/1), signed 32-bit for integer/tag, f64 for float.
// ---------------------------------------------------------------------------

function loadOp(type: string, byteOffset: number): Uint8Array {
  switch (type) {
    case 'bool': return opI32Load8U(byteOffset, 0);
    case 'integer': return opI32Load(byteOffset, 2);
    case 'tag': return opI32Load(byteOffset, 2);
    case 'float': return opF64Load(byteOffset, 3);
    default: return opF64Load(byteOffset, 3);
  }
}

function storeOp(type: string, byteOffset: number): Uint8Array {
  switch (type) {
    case 'bool': return opI32Store8(byteOffset, 0);
    case 'integer': return opI32Store(byteOffset, 2);
    case 'tag': return opI32Store(byteOffset, 2);
    case 'float': return opF64Store(byteOffset, 3);
    default: return opF64Store(byteOffset, 3);
  }
}

/**
 * Emit the copy line for one attribute (sync mode only):
 *   write[i] = read[i]
 * The byte address `i * itemBytes` is already on the stack via local 2 (addr).
 * This pattern uses the address twice — once for load, once for store — by
 * tee-ing into a local first.
 *
 * Stack effect: consumes nothing, leaves nothing.
 *  Bytecode shape:
 *    local.get i
 *    i32.const itemBytes
 *    i32.mul
 *    local.tee addr           ; addr = i * itemBytes; leave on stack for load
 *    <load_op> offset=read    ; load value
 *    local.get addr           ; push addr again for store address
 *    ... (load left value on stack) ...
 *    Wait — load consumes addr and pushes value. Then we need to push addr
 *    BEFORE the value for store. Easier: compute addr, push for load, then
 *    store needs (addr, value) on stack in that order.
 *
 * Cleaner ordering:
 *    local.get i; i32.const itemBytes; i32.mul; local.set addr
 *    local.get addr; <load_op> offset=read    ; stack: [value]
 *    local.get addr                            ; stack: [value, addr]
 *    -- store wants addr first, then value -- swap!
 *
 * WASM has no swap. Use the natural store order (addr THEN value):
 *    local.get addr           ; stack: [addr]
 *    local.get addr; <load_op> offset=read   ; stack: [addr, value]
 *    <store_op> offset=write  ; consumes addr, value
 */
function copyAttrLine(attr: AttrLayout, iLocalIdx: number, addrLocalIdx: number): Uint8Array {
  return concat(
    // addr = i * itemBytes
    opLocalGet(iLocalIdx),
    opI32Const(attr.itemBytes),
    OP_I32_MUL,
    opLocalSet(addrLocalIdx),
    // store address (first stack arg)
    opLocalGet(addrLocalIdx),
    // value (second stack arg) = load(addr + readOffset)
    opLocalGet(addrLocalIdx),
    loadOp(attr.type, attr.readOffset),
    // store(addr + writeOffset, value)
    storeOp(attr.type, attr.writeOffset),
  );
}

/**
 * Build a WASM module for the current graph + model. Phase 2B.3: emits the
 * sync-mode copy lines (write[i] = read[i] per attr) inside the per-cell
 * loop. No node logic yet — that's 2B.4+.
 *
 * Function locals (after the single i32 param `total`):
 *   local 1: i32 i        — loop counter
 *   local 2: i32 addr     — scratch for `i * itemBytes`
 */
export function compileGraphWasm(layout: WasmCompileLayout): WasmCompileResult {
  const I_LOCAL = 1;
  const ADDR_LOCAL = 2;

  // Build the per-cell body: in sync mode, emit one copy block per attribute.
  // In async mode, no copy lines (single buffer; reads and writes alias).
  const perCellBodyParts: Uint8Array[] = [];
  if (!layout.isAsync) {
    for (const attr of layout.cellAttrs) {
      perCellBodyParts.push(copyAttrLine(attr, I_LOCAL, ADDR_LOCAL));
    }
  }
  const perCellBody = concat(...perCellBodyParts);

  // step(total: i32) -> void
  // i := 0
  // block:
  //   loop:
  //     if (i >= total) br block
  //     <per-cell body>
  //     i += 1
  //     br loop
  //   end
  // end
  const stepExpr = concat(
    opI32Const(0), opLocalSet(I_LOCAL),
    opBlock(),
    opLoop(),
    opLocalGet(I_LOCAL), opLocalGet(0), OP_I32_GE_S, opBrIf(1),
    perCellBody,
    opLocalGet(I_LOCAL), opI32Const(1), OP_I32_ADD, opLocalSet(I_LOCAL),
    opBr(0),
    OP_END,
    OP_END,
  );
  const stepBody = buildFuncBody([localsRun(2, I32)], stepExpr);

  // Memory import descriptor — the host owns the memory; we just need to
  // declare we're importing it so loads/stores resolve. Min pages = 1 is
  // a floor; the host's actual memory is always at least 1 page.
  const memImport = importEntry('env', 'mem', importMemoryDesc(1));

  const bytes = buildModule({
    types: [funcType([I32], [])],
    imports: [memImport],
    funcs: [leb128u(0)], // function 0 uses type 0
    exports: [exportEntry('step', EXPORT_FUNC, 0)],
    code: [stepBody],
  });

  return { bytes, minMemoryPages: 1 };
}

/**
 * Async helper: compile the bytes with `WebAssembly.compile` and return the
 * module. Throws on any compile error (which the host should treat as a
 * "fall back to JS" signal during development).
 */
export async function instantiateWasmStep(
  result: WasmCompileResult,
  memory: WebAssembly.Memory,
): Promise<{ step: (total: number) => void }> {
  const mod = await WebAssembly.instantiate(result.bytes, { env: { mem: memory } });
  const step = mod.instance.exports.step as (total: number) => void;
  return { step };
}
