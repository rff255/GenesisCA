/**
 * The three emitters for the Logical Expression node — JS, WASM and WGSL —
 * walking the shared `LogicAst`.
 *
 * They live in ONE file because each is a dozen lines and the whole point is
 * that the three agree; splitting them across three files (as the math node's
 * emitters are, where each is far larger) would only make a drift easier to miss.
 *
 * EVERY emitter reproduces the `logicOperator` node's numeric conventions on its
 * own target exactly, so a formula and the equivalent chain of Logic nodes are
 * interchangeable:
 *   • an INPUT read as a BOOLEAN is truthy-tested (`!== 0`), never compared to 1;
 *   • the RESULT is the project's numeric bool — 1 / 0 (JS number, WASM i32,
 *     WGSL `bool` on the cell target / 1.0 / 0.0 f32 on the agent target).
 *
 * …and the COMPARISON tier reproduces the `statement` (Compare) node's
 * conventions just as exactly — f64 operands on the CPU targets, f32 on the GPU
 * ones, with `==` / `!=` an EXACT comparison (no epsilon), so `n > 2` in a
 * formula and a Compare node wired to the same source agree row for row.
 *
 * An input therefore has TWO readings, and each is reached through its own
 * accessor: a BOOLEAN one (`pushVarBool` / `varBool`) and a NUMERIC one
 * (`pushVarNum` / `varNum`). Keeping them separate is what lets each of the five
 * call sites keep its own established input-resolution convention (cell
 * `castTo(bool)` vs agent `(x != 0.0)`; cell `pushValueAs(I32)` vs agent
 * `pushValueInputF64` + `!= 0`) instead of this module guessing — and it means
 * the numeric accessor is NEVER invoked for a comparison-free formula, which is
 * what keeps such a formula's emitted output byte-identical to the
 * pre-comparison build on every surface.
 */

import type { CmpOp, LogicAst, LogicNumAst } from './logicParser';
import type { LocalRef } from '../wasm/emitter';
import { WasmEmitter } from '../wasm/emitter';
import {
  I32, OP_I32_EQZ, OP_I32_AND, OP_I32_OR, OP_I32_XOR,
  OP_F64_EQ, OP_F64_NE, OP_F64_LT, OP_F64_GT, OP_F64_LE, OP_F64_GE,
} from '../wasm/encoder';

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------

/** `==` / `!=` map to the STRICT JS forms — exactly what `StatementNode.compile`
 *  emits, so a formula and a Compare node cannot disagree. */
const JS_CMP: Record<CmpOp, string> = {
  '<': '<', '<=': '<=', '>': '>', '>=': '>=', '==': '===', '!=': '!==',
};

/** A negative literal is parenthesised so it can never fuse with a preceding
 *  operator character in the emitted text. */
function jsNumLit(v: number): string { return v < 0 ? `(${v})` : String(v); }

function numJS(n: LogicNumAst, inputVars: Record<string, string>): string {
  return n.kind === 'num' ? jsNumLit(n.value) : `(${inputVars[n.portId] ?? '0'})`;
}

/**
 * Emit a JS expression yielding the project's numeric bool (1 / 0).
 *
 * `inputVars` maps a port id to the already-compiled JS expression for that
 * input — exactly the map the JS compiler hands every node's `compile()`, and
 * already the RAW value, so it serves both readings with no second argument.
 * The `!!(…)` on a boolean variable is the truthy test `logicOperator` performs
 * with its `(a && b) ? 1 : 0` shape; doing it per-variable is what lets the
 * operators nest as real booleans and the single `? 1 : 0` at the top produce
 * 1/0 for any input, including a non-0/1 value an `any` source may deliver.
 */
export function emitLogicJS(ast: LogicAst, inputVars: Record<string, string>): string {
  return `(${boolJS(ast, inputVars)} ? 1 : 0)`;
}

function boolJS(ast: LogicAst, inputVars: Record<string, string>): string {
  switch (ast.kind) {
    case 'lit':
      return ast.value ? 'true' : 'false';
    case 'var':
      return `!!(${inputVars[ast.portId] ?? 'false'})`;
    case 'cmp':
      return `(${numJS(ast.left, inputVars)} ${JS_CMP[ast.op]} ${numJS(ast.right, inputVars)})`;
    case 'not':
      return `!(${boolJS(ast.operand, inputVars)})`;
    case 'bin': {
      const l = boolJS(ast.left, inputVars);
      const r = boolJS(ast.right, inputVars);
      // Both sides are already booleans, so `!==` IS xor.
      const op = ast.op === 'and' ? '&&' : ast.op === 'or' ? '||' : '!==';
      return `(${l} ${op} ${r})`;
    }
  }
}

// ---------------------------------------------------------------------------
// WASM
// ---------------------------------------------------------------------------

/** f64 comparison opcodes — the SAME ones the `statement` (Compare) emitter
 *  uses on both the cell and the agent WASM targets. Each leaves an i32 0/1. */
const WASM_CMP: Record<CmpOp, Uint8Array> = {
  '<': OP_F64_LT, '<=': OP_F64_LE, '>': OP_F64_GT, '>=': OP_F64_GE,
  '==': OP_F64_EQ, '!=': OP_F64_NE,
};

/**
 * Emit WASM bytecode for a logic AST. Returns the **i32** `LocalRef` holding
 * 0/1.
 *
 * `pushVarBool(portId)` must leave an i32 0/1 on the stack for that input — the
 * cell target pushes `pushValueAs(…, I32); i32Const(0); i32.ne`, the agent
 * target `pushValueInputF64(…); f64Const(0); f64.ne`. Both already normalise, so
 * every boolean operator below can use the plain bitwise ops.
 *
 * `pushVarNum(portId)` must leave an **f64** on the stack — the RAW value, for a
 * comparison operand (cell: `pushValueAs(…, F64)`; agent: `pushValueInputF64`).
 * It is never called for a comparison-free formula.
 *
 * The agent target converts the returned i32 to f64 at the call site (its value
 * refs are uniformly f64), exactly as its `emitLogic` does.
 */
export function emitLogicWasm(
  ast: LogicAst,
  em: WasmEmitter,
  pushVarBool: (portId: string) => void,
  pushVarNum: (portId: string) => void,
): LocalRef {
  return emitNode(ast, em, pushVarBool, pushVarNum);
}

/** Allocate an i32 local, store the top of the stack into it, return the ref. */
function store(em: WasmEmitter): LocalRef {
  const localIdx = em.allocLocal(I32);
  em.localSet(localIdx);
  return { localIdx, valtype: I32 };
}

function pushNumWasm(n: LogicNumAst, em: WasmEmitter, pushVarNum: (portId: string) => void): void {
  if (n.kind === 'num') em.f64Const(n.value);
  else pushVarNum(n.portId);
}

function emitNode(
  ast: LogicAst,
  em: WasmEmitter,
  pushVarBool: (portId: string) => void,
  pushVarNum: (portId: string) => void,
): LocalRef {
  switch (ast.kind) {
    case 'lit':
      em.i32Const(ast.value ? 1 : 0);
      return store(em);

    case 'var':
      pushVarBool(ast.portId);
      return store(em);

    case 'cmp':
      pushNumWasm(ast.left, em, pushVarNum);
      pushNumWasm(ast.right, em, pushVarNum);
      em.op(WASM_CMP[ast.op]); // f64 compare -> i32 0/1
      return store(em);

    case 'not': {
      const operand = emitNode(ast.operand, em, pushVarBool, pushVarNum);
      em.localGet(operand.localIdx);
      em.op(OP_I32_EQZ); // 0 -> 1, non-0 -> 0
      return store(em);
    }

    case 'bin': {
      const l = emitNode(ast.left, em, pushVarBool, pushVarNum);
      const r = emitNode(ast.right, em, pushVarBool, pushVarNum);
      em.localGet(l.localIdx);
      em.localGet(r.localIdx);
      // Both operands are 0/1, so the bitwise ops ARE the logical ones.
      em.op(ast.op === 'and' ? OP_I32_AND : ast.op === 'or' ? OP_I32_OR : OP_I32_XOR);
      return store(em);
    }
  }
}

// ---------------------------------------------------------------------------
// WGSL
// ---------------------------------------------------------------------------

/** A numeric literal in a form WGSL types as f32: always carrying a decimal
 *  point (a bare `2` is an AbstractInt), and parenthesised when negative. */
function wgslNumLit(v: number): string {
  let s = String(v);
  if (!/[.eE]/.test(s)) s += '.0';
  return v < 0 ? `(${s})` : s;
}

function numWgsl(n: LogicNumAst, varNum: (portId: string) => string): string {
  return n.kind === 'num' ? wgslNumLit(n.value) : `(${varNum(n.portId)})`;
}

/**
 * Emit a WGSL **bool** expression. `varBool(portId)` returns the WGSL bool
 * expression for that input — the cell target `castTo(ref, 'bool')`, the agent
 * target `(<f32 expr> != 0.0)`. `varNum(portId)` returns the RAW **f32**
 * expression for a comparison operand — the cell target `castTo(ref, 'f32')`,
 * the agent target the bare `inF32`. Comparisons therefore run in f32 here, the
 * documented WebGPU precision difference the `statement` node already carries.
 *
 * The caller binds the result: the cell target with `emitLet(ctx, 'bool', …)`
 * (matching `logicOperator`), the agent target with
 * `emitLet(ctx, 'f32', select(0.0, 1.0, …))`.
 */
export function emitLogicWgsl(
  ast: LogicAst,
  varBool: (portId: string) => string,
  varNum: (portId: string) => string,
): string {
  switch (ast.kind) {
    case 'lit':
      return ast.value ? 'true' : 'false';
    case 'var':
      return `(${varBool(ast.portId)})`;
    case 'cmp':
      // WGSL spells all six comparison operators exactly as the AST does.
      return `(${numWgsl(ast.left, varNum)} ${ast.op} ${numWgsl(ast.right, varNum)})`;
    case 'not':
      return `!(${emitLogicWgsl(ast.operand, varBool, varNum)})`;
    case 'bin': {
      const l = emitLogicWgsl(ast.left, varBool, varNum);
      const r = emitLogicWgsl(ast.right, varBool, varNum);
      // WGSL has no `^^`; on two bools `!=` is xor (the same form
      // `logicOperator`'s WGSL emit uses).
      const op = ast.op === 'and' ? '&&' : ast.op === 'or' ? '||' : '!=';
      return `(${l} ${op} ${r})`;
    }
  }
}
