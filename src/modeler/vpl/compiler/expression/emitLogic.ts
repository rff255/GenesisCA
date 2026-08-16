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
 *   • an INPUT is truthy-tested (`!== 0`), never compared to 1;
 *   • the RESULT is the project's numeric bool — 1 / 0 (JS number, WASM i32,
 *     WGSL `bool` on the cell target / 1.0 / 0.0 f32 on the agent target).
 *
 * The var accessor is a CALLBACK on the string targets and a stack-pusher on
 * WASM, so each of the five call sites keeps its own established input-resolution
 * convention (cell `castTo(bool)` vs agent `(x != 0.0)`, cell `pushValueAs(I32)`
 * vs agent `pushValueInputF64` + `!= 0`) instead of this module guessing.
 */

import type { LogicAst } from './logicParser';
import type { LocalRef } from '../wasm/emitter';
import { WasmEmitter } from '../wasm/emitter';
import { I32, OP_I32_EQZ, OP_I32_AND, OP_I32_OR, OP_I32_XOR } from '../wasm/encoder';

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------

/**
 * Emit a JS expression yielding the project's numeric bool (1 / 0).
 *
 * `inputVars` maps a port id to the already-compiled JS expression for that
 * input — exactly the map the JS compiler hands every node's `compile()`. The
 * `!!(…)` on a variable is the truthy test `logicOperator` performs with its
 * `(a && b) ? 1 : 0` shape; doing it per-variable is what lets the operators
 * nest as real booleans and the single `? 1 : 0` at the top produce 1/0 for any
 * input, including a non-0/1 value an `any` source may deliver.
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

/**
 * Emit WASM bytecode for a logic AST. Returns the **i32** `LocalRef` holding
 * 0/1.
 *
 * `pushVarBool(portId)` must leave an i32 0/1 on the stack for that input — the
 * cell target pushes `pushValueAs(…, I32); i32Const(0); i32.ne`, the agent
 * target `pushValueInputF64(…); f64Const(0); f64.ne`. Both already normalise, so
 * every operator below can use the plain bitwise ops.
 *
 * The agent target converts the returned i32 to f64 at the call site (its value
 * refs are uniformly f64), exactly as its `emitLogic` does.
 */
export function emitLogicWasm(
  ast: LogicAst,
  em: WasmEmitter,
  pushVarBool: (portId: string) => void,
): LocalRef {
  return emitNode(ast, em, pushVarBool);
}

/** Allocate an i32 local, store the top of the stack into it, return the ref. */
function store(em: WasmEmitter): LocalRef {
  const localIdx = em.allocLocal(I32);
  em.localSet(localIdx);
  return { localIdx, valtype: I32 };
}

function emitNode(
  ast: LogicAst,
  em: WasmEmitter,
  pushVarBool: (portId: string) => void,
): LocalRef {
  switch (ast.kind) {
    case 'lit':
      em.i32Const(ast.value ? 1 : 0);
      return store(em);

    case 'var':
      pushVarBool(ast.portId);
      return store(em);

    case 'not': {
      const operand = emitNode(ast.operand, em, pushVarBool);
      em.localGet(operand.localIdx);
      em.op(OP_I32_EQZ); // 0 -> 1, non-0 -> 0
      return store(em);
    }

    case 'bin': {
      const l = emitNode(ast.left, em, pushVarBool);
      const r = emitNode(ast.right, em, pushVarBool);
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

/**
 * Emit a WGSL **bool** expression. `varBool(portId)` returns the WGSL bool
 * expression for that input — the cell target `castTo(ref, 'bool')`, the agent
 * target `(<f32 expr> != 0.0)`.
 *
 * The caller binds the result: the cell target with `emitLet(ctx, 'bool', …)`
 * (matching `logicOperator`), the agent target with
 * `emitLet(ctx, 'f32', select(0.0, 1.0, …))`.
 */
export function emitLogicWgsl(ast: LogicAst, varBool: (portId: string) => string): string {
  switch (ast.kind) {
    case 'lit':
      return ast.value ? 'true' : 'false';
    case 'var':
      return `(${varBool(ast.portId)})`;
    case 'not':
      return `!(${emitLogicWgsl(ast.operand, varBool)})`;
    case 'bin': {
      const l = emitLogicWgsl(ast.left, varBool);
      const r = emitLogicWgsl(ast.right, varBool);
      // WGSL has no `^^`; on two bools `!=` is xor (the same form
      // `logicOperator`'s WGSL emit uses).
      const op = ast.op === 'and' ? '&&' : ast.op === 'or' ? '||' : '!=';
      return `(${l} ${op} ${r})`;
    }
  }
}
