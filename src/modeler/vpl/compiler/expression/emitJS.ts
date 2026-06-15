/**
 * JS emitter for the Expression node — walks the shared `ExprAst` and produces
 * a single JS expression string.
 *
 * `inputVars` maps a port id to the already-compiled JS expression for that
 * input (a `_v<id>` variable name, an inline literal, etc.) — exactly the
 * `inputVars` map the JS compiler hands every node's `compile()`.
 *
 * Division and modulo are guarded against a zero divisor the same way
 * `ArithmeticOperatorNode` does, so behaviour matches the existing Math node.
 * `round` is emitted as `Math.floor(x + 0.5)` (NOT `Math.round`) so it stays
 * bit-consistent with the WASM and WGSL emitters, which avoid banker's rounding.
 */

import type { ExprAst } from './parser';

export function emitJS(ast: ExprAst, inputVars: Record<string, string>): string {
  switch (ast.kind) {
    case 'num':
      return numLit(ast.value);

    case 'var':
      return `(${inputVars[ast.portId] ?? '0'})`;

    case 'neg':
      return `(-${emitJS(ast.operand, inputVars)})`;

    case 'bin': {
      const l = emitJS(ast.left, inputVars);
      const r = emitJS(ast.right, inputVars);
      switch (ast.op) {
        case '+': return `(${l} + ${r})`;
        case '-': return `(${l} - ${r})`;
        case '*': return `(${l} * ${r})`;
        case '/': return `(${r} !== 0 ? ${l} / ${r} : 0)`;
        case '%': return `(${r} !== 0 ? ${l} % ${r} : 0)`;
      }
      return '0';
    }

    case 'call': {
      const a = ast.args.map(x => emitJS(x, inputVars));
      switch (ast.fn) {
        case 'sqrt':  return `Math.sqrt(${a[0]})`;
        case 'abs':   return `Math.abs(${a[0]})`;
        case 'floor': return `Math.floor(${a[0]})`;
        case 'ceil':  return `Math.ceil(${a[0]})`;
        case 'round': return `Math.floor(${a[0]} + 0.5)`;
        case 'min':   return `Math.min(${a[0]}, ${a[1]})`;
        case 'max':   return `Math.max(${a[0]}, ${a[1]})`;
        case 'pow':   return `Math.pow(${a[0]}, ${a[1]})`;
        case 'mod':   return `(${a[1]} !== 0 ? ${a[0]} % ${a[1]} : 0)`;
        case 'exp':   return `Math.exp(${a[0]})`;
        case 'log':   return `Math.log(${a[0]})`;
        case 'sin':   return `Math.sin(${a[0]})`;
        case 'cos':   return `Math.cos(${a[0]})`;
        case 'tan':   return `Math.tan(${a[0]})`;
        case 'tanh':  return `Math.tanh(${a[0]})`;
      }
      return '0';
    }
  }
}

/** Numeric literal — the parser guarantees a finite value; normalise -0 to 0. */
function numLit(v: number): string {
  return Object.is(v, -0) ? '0' : String(v);
}
