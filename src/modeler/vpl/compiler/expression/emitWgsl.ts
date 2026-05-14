/**
 * WGSL emitter for the Expression node — walks the shared `ExprAst` and
 * produces a single WGSL f32 expression string. The WebGPU compiler's
 * `expression` value emitter wraps the result once in an `emitLet`.
 *
 * `inputs` maps a port id to its resolved WGSL `ValueRef` (same map the WebGPU
 * compiler hands every value emitter). All arithmetic is f32 — WGSL has no f64.
 *
 * Division / modulo guards mirror `webgpu/compile.ts`'s `arithmeticOperator`
 * (`select(0.0, …, (r != 0.0))`). `round` is `floor(x + 0.5)` so it stays
 * consistent with the JS and WASM emitters (WGSL's `round` is banker's).
 */

import type { ExprAst, ExprFn } from './parser';
import { castTo, type ValueRef } from '../webgpu/compile';

export function emitWgsl(
  ast: ExprAst,
  inputs: Record<string, ValueRef | undefined>,
): string {
  switch (ast.kind) {
    case 'num':
      return wgslFloatLit(ast.value);

    case 'var': {
      const ref = inputs[ast.portId] ?? { expr: '0.0', type: 'f32' as const };
      return `(${castTo(ref, 'f32')})`;
    }

    case 'neg':
      return `(-${emitWgsl(ast.operand, inputs)})`;

    case 'bin': {
      const l = emitWgsl(ast.left, inputs);
      const r = emitWgsl(ast.right, inputs);
      switch (ast.op) {
        case '+': return `(${l} + ${r})`;
        case '-': return `(${l} - ${r})`;
        case '*': return `(${l} * ${r})`;
        case '/': return `select(0.0, (${l} / ${r}), (${r} != 0.0))`;
        case '%': return `select(0.0, (${l} - trunc((${l}) / (${r})) * (${r})), (${r} != 0.0))`;
      }
      return '0.0';
    }

    case 'call': {
      const a = ast.args.map(x => emitWgsl(x, inputs));
      return emitWgslCall(ast.fn, a);
    }
  }
}

function emitWgslCall(fn: ExprFn, a: string[]): string {
  switch (fn) {
    case 'sqrt':  return `sqrt(${a[0]})`;
    case 'abs':   return `abs(${a[0]})`;
    case 'floor': return `floor(${a[0]})`;
    case 'ceil':  return `ceil(${a[0]})`;
    case 'round': return `floor((${a[0]}) + 0.5)`;
    case 'min':   return `min(${a[0]}, ${a[1]})`;
    case 'max':   return `max(${a[0]}, ${a[1]})`;
    case 'pow':   return `pow(${a[0]}, ${a[1]})`;
    case 'mod':   return `select(0.0, ((${a[0]}) - trunc((${a[0]}) / (${a[1]})) * (${a[1]})), (${a[1]} != 0.0))`;
  }
}

/**
 * WGSL f32 literal. Ensures a decimal point (or exponent) is present so the
 * literal is parsed as a float, not an abstract int. `String()` already emits
 * exponent forms (`1e-7`, `1e+21`) for extreme magnitudes — WGSL accepts those.
 */
export function wgslFloatLit(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  let s = String(v);
  if (!s.includes('.') && !s.includes('e') && !s.includes('E')) s += '.0';
  return s;
}
