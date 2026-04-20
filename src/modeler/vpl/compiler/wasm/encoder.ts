/**
 * Minimal WebAssembly binary encoder.
 *
 * Hand-written so we don't ship `wabt.js` (~1MB) just to get from text WAT
 * to a binary module. Surface area covers what GenesisCA's graph compiler
 * actually needs: i32 / f64 numeric ops, locals, linear memory loads/stores,
 * basic control flow (if/else/block/loop/br/br_if), function calls, and
 * module-level glue (types, imports, functions, memory, exports, code).
 *
 * Spec reference: https://webassembly.github.io/spec/core/binary/index.html
 *
 * Design: every helper returns a `Uint8Array` of bytes. Higher-level builders
 * compose those byte arrays with `concat`. The module entry point assembles
 * sections in the spec-mandated order. There's no AST, no IR, no validator —
 * the caller is responsible for emitting well-typed sequences. We trust the
 * graph compiler (callers) to produce valid stack machine code; mistakes
 * surface as `WebAssembly.compile` errors at edit time.
 */

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export const I32 = 0x7f;
export const I64 = 0x7e;
export const F32 = 0x7d;
export const F64 = 0x7c;

export type ValType = typeof I32 | typeof I64 | typeof F32 | typeof F64;

// ---------------------------------------------------------------------------
// LEB128 encoding (unsigned + signed)
// ---------------------------------------------------------------------------

/** Unsigned LEB128 — used for indices, sizes, byte counts. */
export function leb128u(n: number): Uint8Array {
  if (n < 0 || !Number.isFinite(n)) throw new Error(`leb128u: negative/non-finite ${n}`);
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return new Uint8Array(out);
}

/** Signed LEB128 — used for i32.const / i64.const literals. */
export function leb128s(n: number): Uint8Array {
  if (!Number.isFinite(n)) throw new Error(`leb128s: non-finite ${n}`);
  const out: number[] = [];
  let v = n | 0;
  let more = true;
  while (more) {
    const byte = v & 0x7f;
    // Arithmetic right shift to preserve sign bit
    v >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((v === 0 && !signBit) || (v === -1 && signBit)) {
      more = false;
      out.push(byte);
    } else {
      out.push(byte | 0x80);
    }
  }
  return new Uint8Array(out);
}

/** Little-endian f64 (8 bytes) — used for f64.const literals. */
export function f64Le(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n, true);
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/** Concatenate byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** A single byte. */
export function byte(b: number): Uint8Array {
  return new Uint8Array([b & 0xff]);
}

/** Length-prefixed sequence: `vec(x) = leb128u(x.length) ++ x...`. */
export function vec(items: Uint8Array[]): Uint8Array {
  return concat(leb128u(items.length), ...items);
}

/** UTF-8 encode a name with a length prefix (used for imports/exports). */
export function name(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(leb128u(bytes.length), bytes);
}

// ---------------------------------------------------------------------------
// Module structure
// ---------------------------------------------------------------------------

const MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]); // \0asm
const VERSION = new Uint8Array([0x01, 0x00, 0x00, 0x00]);

/** A section is `id:byte ++ leb128u(content.length) ++ content`. */
export function section(id: number, content: Uint8Array): Uint8Array {
  return concat(byte(id), leb128u(content.length), content);
}

/** A function type entry: `0x60 ++ vec(params) ++ vec(results)`. */
export function funcType(params: ValType[], results: ValType[]): Uint8Array {
  return concat(
    byte(0x60),
    vec(params.map(p => byte(p))),
    vec(results.map(r => byte(r))),
  );
}

/** Build a complete WASM module from its sections (omit any that are empty). */
export interface ModuleParts {
  /** Function signatures (each via funcType()). */
  types?: Uint8Array[];
  /** Function-section entries: each is leb128u(typeIdx). */
  funcs?: Uint8Array[];
  /** Export entries: each is `name ++ kind:byte ++ leb128u(idx)`. */
  exports?: Uint8Array[];
  /** Code-section entries: each is a function body (see buildFuncBody). */
  code?: Uint8Array[];
  /** Memory section entries: each is a limits descriptor. */
  memories?: Uint8Array[];
  /** Import entries: each is `module ++ name ++ kind ++ desc`. */
  imports?: Uint8Array[];
}

export function buildModule(parts: ModuleParts): Uint8Array {
  const sections: Uint8Array[] = [MAGIC, VERSION];
  if (parts.types && parts.types.length > 0) sections.push(section(1, vec(parts.types)));
  if (parts.imports && parts.imports.length > 0) sections.push(section(2, vec(parts.imports)));
  if (parts.funcs && parts.funcs.length > 0) sections.push(section(3, vec(parts.funcs)));
  if (parts.memories && parts.memories.length > 0) sections.push(section(5, vec(parts.memories)));
  if (parts.exports && parts.exports.length > 0) sections.push(section(7, vec(parts.exports)));
  if (parts.code && parts.code.length > 0) sections.push(section(10, vec(parts.code)));
  return concat(...sections);
}

// ---------------------------------------------------------------------------
// Function body assembly
// ---------------------------------------------------------------------------

/** A locals run: `count ++ valtype`. Group consecutive locals of the same type. */
export function localsRun(count: number, type: ValType): Uint8Array {
  return concat(leb128u(count), byte(type));
}

/**
 * Wrap a code expression as a complete function body for the Code section.
 *  body = leb128u(size) ++ vec(localRuns) ++ expr ++ END(0x0B)
 */
export function buildFuncBody(localRuns: Uint8Array[], expr: Uint8Array): Uint8Array {
  const inner = concat(vec(localRuns), expr, byte(0x0b));
  return concat(leb128u(inner.length), inner);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const EXPORT_FUNC = 0x00;
export const EXPORT_MEMORY = 0x02;

export function exportEntry(exportName: string, kind: number, idx: number): Uint8Array {
  return concat(name(exportName), byte(kind), leb128u(idx));
}

// ---------------------------------------------------------------------------
// Opcodes (the ones we use in graph-compiled code)
// ---------------------------------------------------------------------------

// Control flow
export const OP_UNREACHABLE = byte(0x00);
export const OP_NOP = byte(0x01);
export const OP_END = byte(0x0b);
export const OP_RETURN = byte(0x0f);

export function opBlock(blockType: number = 0x40): Uint8Array { return concat(byte(0x02), byte(blockType)); }
export function opLoop(blockType: number = 0x40): Uint8Array { return concat(byte(0x03), byte(blockType)); }
export function opIf(blockType: number = 0x40): Uint8Array { return concat(byte(0x04), byte(blockType)); }
export const OP_ELSE = byte(0x05);
export function opBr(labelIdx: number): Uint8Array { return concat(byte(0x0c), leb128u(labelIdx)); }
export function opBrIf(labelIdx: number): Uint8Array { return concat(byte(0x0d), leb128u(labelIdx)); }
export function opCall(funcIdx: number): Uint8Array { return concat(byte(0x10), leb128u(funcIdx)); }

// Locals
export function opLocalGet(idx: number): Uint8Array { return concat(byte(0x20), leb128u(idx)); }
export function opLocalSet(idx: number): Uint8Array { return concat(byte(0x21), leb128u(idx)); }
export function opLocalTee(idx: number): Uint8Array { return concat(byte(0x22), leb128u(idx)); }

// Memory ops — memarg is `align:leb128u ++ offset:leb128u`. Default align matches natural type.
function memarg(align: number, offset: number): Uint8Array {
  return concat(leb128u(align), leb128u(offset));
}
export function opI32Load(offset: number = 0, align: number = 2): Uint8Array { return concat(byte(0x28), memarg(align, offset)); }
export function opI64Load(offset: number = 0, align: number = 3): Uint8Array { return concat(byte(0x29), memarg(align, offset)); }
export function opF32Load(offset: number = 0, align: number = 2): Uint8Array { return concat(byte(0x2a), memarg(align, offset)); }
export function opF64Load(offset: number = 0, align: number = 3): Uint8Array { return concat(byte(0x2b), memarg(align, offset)); }
export function opI32Load8U(offset: number = 0, align: number = 0): Uint8Array { return concat(byte(0x2d), memarg(align, offset)); }
export function opI32Store(offset: number = 0, align: number = 2): Uint8Array { return concat(byte(0x36), memarg(align, offset)); }
export function opF64Store(offset: number = 0, align: number = 3): Uint8Array { return concat(byte(0x39), memarg(align, offset)); }
export function opI32Store8(offset: number = 0, align: number = 0): Uint8Array { return concat(byte(0x3a), memarg(align, offset)); }

// Constants
export function opI32Const(n: number): Uint8Array { return concat(byte(0x41), leb128s(n)); }
export function opF64Const(n: number): Uint8Array { return concat(byte(0x44), f64Le(n)); }

// i32 comparisons and arithmetic (subset — extend as needed)
export const OP_I32_EQZ = byte(0x45);
export const OP_I32_EQ = byte(0x46);
export const OP_I32_NE = byte(0x47);
export const OP_I32_LT_S = byte(0x48);
export const OP_I32_GT_S = byte(0x4a);
export const OP_I32_LE_S = byte(0x4c);
export const OP_I32_GE_S = byte(0x4e);
export const OP_I32_ADD = byte(0x6a);
export const OP_I32_SUB = byte(0x6b);
export const OP_I32_MUL = byte(0x6c);
export const OP_I32_DIV_S = byte(0x6d);
export const OP_I32_REM_S = byte(0x6f);
export const OP_I32_AND = byte(0x71);
export const OP_I32_OR = byte(0x72);
export const OP_I32_XOR = byte(0x73);
export const OP_I32_SHL = byte(0x74);
export const OP_I32_SHR_U = byte(0x76);

// f64 comparisons and arithmetic (subset)
export const OP_F64_EQ = byte(0x61);
export const OP_F64_NE = byte(0x62);
export const OP_F64_LT = byte(0x63);
export const OP_F64_GT = byte(0x64);
export const OP_F64_LE = byte(0x65);
export const OP_F64_GE = byte(0x66);
export const OP_F64_ABS = byte(0x99);
export const OP_F64_NEG = byte(0x9a);
export const OP_F64_TRUNC = byte(0x9b);
export const OP_F64_FLOOR = byte(0x9c);
export const OP_F64_CEIL = byte(0x9d);
export const OP_F64_NEAREST = byte(0x9e);
export const OP_F64_SQRT = byte(0x9f);
export const OP_F64_ADD = byte(0xa0);
export const OP_F64_SUB = byte(0xa1);
export const OP_F64_MUL = byte(0xa2);
export const OP_F64_DIV = byte(0xa3);
export const OP_F64_MIN = byte(0xa4);
export const OP_F64_MAX = byte(0xa5);

// Conversions
export const OP_I32_TRUNC_F64_S = byte(0xaa);
export const OP_F64_CONVERT_I32_S = byte(0xb7);
export const OP_F64_CONVERT_I32_U = byte(0xb8);

// Select (i32-cond, picks val1 if cond non-zero, val2 otherwise)
export const OP_SELECT = byte(0x1b);

// Memory limits descriptor (no max): 0x00 ++ leb128u(min)
export function memLimits(minPages: number): Uint8Array {
  return concat(byte(0x00), leb128u(minPages));
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export const IMPORT_FUNC = 0x00;
export const IMPORT_MEMORY = 0x02;

/** Build an import-section entry. `kindAndDesc` is the kind byte + its descriptor. */
export function importEntry(moduleName: string, importName: string, kindAndDesc: Uint8Array): Uint8Array {
  return concat(name(moduleName), name(importName), kindAndDesc);
}

/** Memory import descriptor: kind 0x02 + limits. */
export function importMemoryDesc(minPages: number): Uint8Array {
  return concat(byte(IMPORT_MEMORY), memLimits(minPages));
}

/** Func import descriptor: kind 0x00 + leb128u(typeIdx). */
export function importFuncDesc(typeIdx: number): Uint8Array {
  return concat(byte(IMPORT_FUNC), leb128u(typeIdx));
}

// ---------------------------------------------------------------------------
// Self-test: build, instantiate, and call a tiny add(i32, i32) -> i32 module.
// Returns the computed sum (e.g. 5 for add(2, 3)) or throws on any failure.
// Used at dev startup to verify the encoder produces a valid module end-to-end.
// ---------------------------------------------------------------------------

export async function selfTestAdd(): Promise<number> {
  const expr = concat(
    opLocalGet(0),
    opLocalGet(1),
    OP_I32_ADD,
  );
  const body = buildFuncBody(/* no locals beyond params */ [], expr);
  const bytes = buildModule({
    types: [funcType([I32, I32], [I32])],
    funcs: [leb128u(0)], // function 0 uses type 0
    exports: [exportEntry('add', EXPORT_FUNC, 0)],
    code: [body],
  });
  const mod = await WebAssembly.instantiate(bytes);
  const add = mod.instance.exports.add as (a: number, b: number) => number;
  const result = add(2, 3);
  if (result !== 5) throw new Error(`selfTestAdd: expected 5, got ${result}`);
  return result;
}

/**
 * Memory-import smoke test: the WASM module imports a JS-allocated memory,
 * then loops over [offset, offset+count) summing one byte at a time.
 * Validates the load/loop/branch pipeline that real cell-attr access will use.
 *
 * Function: sumBytes(offset: i32, count: i32) -> i32
 *
 * Locals:
 *   0 (param): offset — incremented in the loop
 *   1 (param): count  — overwritten with `end` (offset + count) at entry
 *   2:        sum    — running total
 */
export async function selfTestMemorySum(): Promise<number> {
  const expr = concat(
    // end := offset + count, store back into local 1 (we don't need count again)
    opLocalGet(0), opLocalGet(1), OP_I32_ADD, opLocalSet(1),
    // sum := 0
    opI32Const(0), opLocalSet(2),
    // outer block (label 1 from loop's POV) — used as the break target
    opBlock(),
    //   loop (label 0 from loop's POV)
    opLoop(),
    //     if (offset >= end) br 1  // exit the block (and the loop)
    opLocalGet(0), opLocalGet(1), OP_I32_GE_S, opBrIf(1),
    //     sum += i32.load8_u(offset)
    opLocalGet(2), opLocalGet(0), opI32Load8U(), OP_I32_ADD, opLocalSet(2),
    //     offset += 1
    opLocalGet(0), opI32Const(1), OP_I32_ADD, opLocalSet(0),
    //     br 0  // continue loop
    opBr(0),
    OP_END, // end loop
    OP_END, // end block
    // return sum
    opLocalGet(2),
  );

  const body = buildFuncBody(
    [localsRun(1, I32)], // 1 i32 local beyond the 2 params
    expr,
  );
  const bytes = buildModule({
    types: [funcType([I32, I32], [I32])],
    imports: [importEntry('env', 'mem', importMemoryDesc(1))],
    funcs: [leb128u(0)],
    exports: [exportEntry('sumBytes', EXPORT_FUNC, 0)],
    code: [body],
  });

  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new Uint8Array(memory.buffer);
  for (let i = 0; i < 10; i++) view[i] = i + 1; // bytes 1..10 -> sum 55

  const mod = await WebAssembly.instantiate(bytes, { env: { mem: memory } });
  const sumBytes = mod.instance.exports.sumBytes as (off: number, cnt: number) => number;
  const result = sumBytes(0, 10);
  if (result !== 55) throw new Error(`selfTestMemorySum: expected 55, got ${result}`);
  return result;
}
