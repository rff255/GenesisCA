/**
 * WASM emitter for the Expression node — walks the shared `ExprAst` and emits
 * f64 bytecode via the `WasmEmitter`.
 *
 * Each AST node is emitted to a fresh f64 local and returned as a `LocalRef`,
 * so a value used twice (`a*a`) just loads the same local twice. All arithmetic
 * runs in f64 to match JS `Number` semantics — same choice the existing
 * `arithmeticOperator` WASM emitter makes.
 *
 * Division / modulo guards mirror `wasm/compile.ts`'s `arithmeticOperator`
 * (`r != 0 ? ... : 0`). `round` is `floor(x + 0.5)` — NOT the native
 * `f64.nearest` (banker's rounding), so it stays consistent with JS/WGSL.
 */

import type { ExprAst, ExprFn } from './parser';
import type { LocalRef, ValueRef } from '../wasm/emitter';
import { WasmEmitter, pushValueAs, isInline } from '../wasm/emitter';
import {
  F64,
  OP_F64_ADD, OP_F64_SUB, OP_F64_MUL, OP_F64_DIV, OP_F64_NE,
  OP_F64_MIN, OP_F64_MAX, OP_F64_SQRT, OP_F64_ABS, OP_F64_NEG,
  OP_F64_FLOOR, OP_F64_CEIL, OP_F64_TRUNC, opCall,
} from '../wasm/encoder';
import {
  POW_FUNC_IDX, EXP_FUNC_IDX, LOG_FUNC_IDX, SIN_FUNC_IDX, COS_FUNC_IDX, TAN_FUNC_IDX, TANH_FUNC_IDX,
} from '../wasm/compile';

const F64_ZERO: ValueRef = { inline: true, value: 0, valtype: F64 };

/**
 * Emit WASM bytecode for an expression AST. Returns the f64 `LocalRef` holding
 * the result. `inputs` maps a port id to its resolved `ValueRef` (same map the
 * WASM compiler hands every value emitter).
 */
export function emitWasm(
  ast: ExprAst,
  em: WasmEmitter,
  inputs: Record<string, ValueRef | undefined>,
): LocalRef {
  return emitNode(ast, em, inputs);
}

/** Allocate an f64 local, store the top of the stack into it, return the ref. */
function store(em: WasmEmitter): LocalRef {
  const localIdx = em.allocLocal(F64);
  em.localSet(localIdx);
  return { localIdx, valtype: F64 };
}

function emitNode(
  ast: ExprAst,
  em: WasmEmitter,
  inputs: Record<string, ValueRef | undefined>,
): LocalRef {
  switch (ast.kind) {
    case 'num':
      em.f64Const(ast.value);
      return store(em);

    case 'var': {
      const ref = inputs[ast.portId] ?? F64_ZERO;
      // An f64 local can be reused directly (handles repeated vars like `a*a`).
      if (!isInline(ref) && ref.valtype === F64) return ref;
      pushValueAs(em, ref, F64);
      return store(em);
    }

    case 'neg': {
      const operand = emitNode(ast.operand, em, inputs);
      em.localGet(operand.localIdx);
      em.op(OP_F64_NEG);
      return store(em);
    }

    case 'bin': {
      const l = emitNode(ast.left, em, inputs);
      const r = emitNode(ast.right, em, inputs);
      if (ast.op === '/' || ast.op === '%') return emitGuardedDivMod(em, ast.op, l, r);
      em.localGet(l.localIdx);
      em.localGet(r.localIdx);
      em.op(ast.op === '+' ? OP_F64_ADD : ast.op === '-' ? OP_F64_SUB : OP_F64_MUL);
      return store(em);
    }

    case 'call': {
      const args = ast.args.map(a => emitNode(a, em, inputs));
      return emitCall(em, ast.fn, args);
    }
  }
}

/**
 * `r != 0 ? (op === '/' ? l / r : l - trunc(l / r) * r) : 0`.
 * Copies the guard shape from `arithmeticOperator` in `wasm/compile.ts`.
 */
function emitGuardedDivMod(em: WasmEmitter, op: '/' | '%', l: LocalRef, r: LocalRef): LocalRef {
  const resLoc = em.allocLocal(F64);
  em.localGet(r.localIdx);
  em.f64Const(0);
  em.op(OP_F64_NE);
  em.ifThenElse(
    () => {
      if (op === '/') {
        em.localGet(l.localIdx);
        em.localGet(r.localIdx);
        em.op(OP_F64_DIV);
      } else {
        // l - trunc(l / r) * r
        em.localGet(l.localIdx);
        em.localGet(l.localIdx);
        em.localGet(r.localIdx);
        em.op(OP_F64_DIV);
        em.op(OP_F64_TRUNC);
        em.localGet(r.localIdx);
        em.op(OP_F64_MUL);
        em.op(OP_F64_SUB);
      }
      em.localSet(resLoc);
    },
    () => {
      em.f64Const(0);
      em.localSet(resLoc);
    },
  );
  return { localIdx: resLoc, valtype: F64 };
}

function emitCall(em: WasmEmitter, fn: ExprFn, args: LocalRef[]): LocalRef {
  switch (fn) {
    case 'sqrt':
      em.localGet(args[0]!.localIdx);
      em.op(OP_F64_SQRT);
      return store(em);
    case 'abs':
      em.localGet(args[0]!.localIdx);
      em.op(OP_F64_ABS);
      return store(em);
    case 'floor':
      em.localGet(args[0]!.localIdx);
      em.op(OP_F64_FLOOR);
      return store(em);
    case 'ceil':
      em.localGet(args[0]!.localIdx);
      em.op(OP_F64_CEIL);
      return store(em);
    case 'round':
      // floor(x + 0.5) — matches emitJS / emitWgsl. NOT native f64.nearest
      // (banker's rounding), which would diverge from Math.round on .5 cases.
      em.localGet(args[0]!.localIdx);
      em.f64Const(0.5);
      em.op(OP_F64_ADD);
      em.op(OP_F64_FLOOR);
      return store(em);
    case 'min':
      em.localGet(args[0]!.localIdx);
      em.localGet(args[1]!.localIdx);
      em.op(OP_F64_MIN);
      return store(em);
    case 'max':
      em.localGet(args[0]!.localIdx);
      em.localGet(args[1]!.localIdx);
      em.op(OP_F64_MAX);
      return store(em);
    case 'pow':
      em.localGet(args[0]!.localIdx);
      em.localGet(args[1]!.localIdx);
      em.emit(opCall(POW_FUNC_IDX));
      return store(em);
    case 'mod':
      return emitGuardedDivMod(em, '%', args[0]!, args[1]!);
    // Unary transcendentals: imported host functions (no native WASM opcode).
    case 'exp':  em.localGet(args[0]!.localIdx); em.emit(opCall(EXP_FUNC_IDX));  return store(em);
    case 'log':  em.localGet(args[0]!.localIdx); em.emit(opCall(LOG_FUNC_IDX));  return store(em);
    case 'sin':  em.localGet(args[0]!.localIdx); em.emit(opCall(SIN_FUNC_IDX));  return store(em);
    case 'cos':  em.localGet(args[0]!.localIdx); em.emit(opCall(COS_FUNC_IDX));  return store(em);
    case 'tan':  em.localGet(args[0]!.localIdx); em.emit(opCall(TAN_FUNC_IDX));  return store(em);
    case 'tanh': em.localGet(args[0]!.localIdx); em.emit(opCall(TANH_FUNC_IDX)); return store(em);
  }
}
