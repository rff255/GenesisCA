/**
 * MORPH INTO — convert a node into a closely-related node type IN PLACE.
 *
 * The node keeps its ID, its position and its user rename; only `data.nodeType`
 * and `data.config` are replaced, and the edges touching it are re-pointed
 * through the spec's port maps. Keeping the id is what makes the edges survive
 * with no graph-wide rewrite (React Flow addresses an edge by node id + handle
 * id), and it is why a morph is one `setNodes` + one `setEdges` under ONE undo
 * snapshot.
 *
 * WHAT THIS MODULE OWNS: the CURATED table of which type may become which, and
 * how the old config maps onto the new one. It is deliberately conservative —
 * every pair below is a type the user plausibly reached for by mistake, or a
 * refinement of the same idea (a Math chain that wants to be a formula, a
 * comparison that wants to grow into a boolean rule).
 *
 * WHAT THE ENGINE (GraphEditor.morphNode) OWNS, so no spec has to repeat it:
 *   - validating every re-pointed edge against the NEW node's effective ports
 *     with the editor's own `portsCompatible` — an incompatible or unmapped
 *     edge is DROPPED, never repointed onto something merely plausible (the
 *     project's standing drop-never-repoint rule);
 *   - carrying an inline `_port_<old>` → `_port_<new>` when — and only when —
 *     the two ports' `inlineWidget` kinds MATCH (a number carried into a bool
 *     `<select>` renders blank and the user's value is one click from being
 *     lost, so those are reseeded to the new port's default instead);
 *   - seeding every remaining inline port's `defaultValue` (the
 *     `addNodeAtPosition` rule, so the morphed node is self-contained);
 *   - the availability / singleton gates.
 *
 * THE FORMULA MORPHS BAKE UNWIRED OPERANDS AS LITERALS. Compare's `X > 3` with
 * an inline 3 becomes the formula `a > 3`, not a formula `a > b` plus a numeric
 * value hidden on a port whose widget is a bool select. Only the WIRED operands
 * become variables, and they take CONSECUTIVE port letters (a, b, c…) so the
 * formula node opens with exactly as many inputs as it has wires.
 *
 * The reverse directions (a formula back into a single-op node) are best-effort:
 * the formula is PARSED and, when its whole AST is one operator over input
 * variables, that operator is carried across. Anything more complex falls back
 * to the type's default operation and the formula text is lost — which Ctrl+Z
 * restores, and which the menu item's tooltip states up front.
 */

import type { NodeConfig } from './types';
import { ARITHMETIC_UNARY_OPS } from './nodes/ArithmeticOperatorNode';
import {
  buildVarMap, parseExpression, clampVisibleCount, VISIBLE_PORT_IDS,
} from './compiler/expression/parser';
import type { ExprAst } from './compiler/expression/parser';
import { buildLogicVarMap, parseLogicExpression } from './compiler/expression/logicParser';
import type { LogicAst } from './compiler/expression/logicParser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MorphContext {
  /** The node's current config. */
  config: NodeConfig;
  /** Input port ids that currently have an incoming edge. */
  wired: ReadonlySet<string>;
  /** The inline value stored for an input port — `_port_<id>` when set, else
   *  the OLD port's declared `defaultValue`, else '0'. */
  inline: (portId: string) => string;
}

export interface MorphResult {
  /** The complete new config (the engine adds the inline-port carry-over + the
   *  default seeding on top; anything set here wins). */
  config: Record<string, string | number | boolean>;
  /** old INPUT port id → new INPUT port id. An old port with no entry has its
   *  incoming edge dropped. */
  inputMap: Record<string, string>;
  /** old OUTPUT port id → new OUTPUT port id. Same drop rule. */
  outputMap: Record<string, string>;
}

export interface MorphSpec {
  /** Target node type. */
  to: string;
  /** Tooltip on the menu item — says what carries across and what does not. */
  title: string;
  /** Build the new config + port maps, or null when this morph is not
   *  meaningful for the node's CURRENT config (the menu then omits it). */
  build: (ctx: MorphContext) => MorphResult | null;
}

// ---------------------------------------------------------------------------
// Literal helpers
// ---------------------------------------------------------------------------

/** A NUMERIC literal for either formula grammar. Both accept an optionally
 *  signed number and parentheses around one, so a negative is parenthesised —
 *  valid in the math grammar (`primary := '(' expr ')'`) and in the logic
 *  grammar's comparison operand (`parseNumAtom` handles `(` and a signed
 *  number), and it can never fuse with a preceding operator character. */
function numLiteral(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === 'true') return '1';
  if (s === 'false') return '0';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '0';
  return n < 0 ? `(${n})` : String(n);
}

/** A BOOLEAN literal for the logic grammar. A stored tag/number is truthy-tested
 *  the same way a bare input port is. */
function boolLiteral(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === 'true') return 'true';
  if (s === 'false') return 'false';
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? 'true' : 'false';
}

interface Operand {
  /** OLD input port id. */
  port: string;
  /** How an unwired operand's stored inline value reads in the target grammar. */
  literal: (raw: string) => string;
}

/**
 * Assign the WIRED operands consecutive formula ports (a, b, c…) and give every
 * operand its formula token: its new port letter when wired, the baked literal
 * otherwise.
 *
 * A port may legitimately appear TWICE in the operand list (Compare's X in a
 * between-range test); it is assigned ONE letter and both occurrences reuse the
 * same token.
 */
function assignOperands(
  ctx: MorphContext,
  operands: readonly Operand[],
): { tokens: Record<string, string>; inputMap: Record<string, string>; visibleCount: number } {
  const tokens: Record<string, string> = {};
  const inputMap: Record<string, string> = {};
  let next = 0;
  for (const op of operands) {
    if (tokens[op.port] !== undefined) continue;
    const letter = ctx.wired.has(op.port) ? VISIBLE_PORT_IDS[next] : undefined;
    if (letter !== undefined) {
      next += 1;
      inputMap[op.port] = letter;
      tokens[op.port] = letter;
    } else {
      tokens[op.port] = op.literal(ctx.inline(op.port));
    }
  }
  return { tokens, inputMap, visibleCount: Math.max(1, next) };
}

// ---------------------------------------------------------------------------
// Math ⇄ Math Expression
// ---------------------------------------------------------------------------

/** Every operation the Math node offers. Used when reading an operator back OUT
 *  of a parsed formula. */
const MATH_OPS: ReadonlySet<string> = new Set([
  '+', '-', '*', '/', '%', 'pow', 'min', 'max', 'mean',
  ...ARITHMETIC_UNARY_OPS,
]);

/** Math's BINARY operations as math-grammar formulas.
 *
 *  Every one of these is SEMANTICALLY IDENTICAL to what `ArithmeticOperatorNode`
 *  emits, on every target: `emitJS` guards `/` and `%` against a zero divisor
 *  exactly as the Math node does, and emits `round` as `floor(x + 0.5)` for the
 *  same cross-target parity reason. `mean` becomes `(x + y) / 2`, whose `/`
 *  guard is dead (the divisor is the literal 2). */
const MATH_BINARY_FORMULA: Record<string, (x: string, y: string) => string> = {
  '+': (x, y) => `${x} + ${y}`,
  '-': (x, y) => `${x} - ${y}`,
  '*': (x, y) => `${x} * ${y}`,
  '/': (x, y) => `${x} / ${y}`,
  '%': (x, y) => `${x} % ${y}`,
  pow: (x, y) => `pow(${x}, ${y})`,
  min: (x, y) => `min(${x}, ${y})`,
  max: (x, y) => `max(${x}, ${y})`,
  mean: (x, y) => `(${x} + ${y}) / 2`,
};

function mathToExpression(ctx: MorphContext): MorphResult | null {
  const op = String(ctx.config.operation ?? '+');
  const unary = ARITHMETIC_UNARY_OPS.has(op);
  const operands: Operand[] = unary
    ? [{ port: 'x', literal: numLiteral }]
    : [{ port: 'x', literal: numLiteral }, { port: 'y', literal: numLiteral }];
  const { tokens, inputMap, visibleCount } = assignOperands(ctx, operands);
  const x = tokens.x ?? '0';
  const y = tokens.y ?? '0';
  let expression: string;
  if (unary) {
    expression = op === 'negate' ? `-${x}` : `${op}(${x})`;
  } else {
    expression = (MATH_BINARY_FORMULA[op] ?? MATH_BINARY_FORMULA['+']!)(x, y);
  }
  return {
    config: { expression, visibleCount },
    inputMap,
    outputMap: { result: 'result' },
  };
}

function exprVar(a: ExprAst): string | null {
  return a.kind === 'var' ? a.portId : null;
}

/** Read a single Math operation back out of a parsed math formula. Returns null
 *  for anything that is not exactly one operator over distinct input variables. */
function matchMathShape(ast: ExprAst): { operation: string; inputMap: Record<string, string> } | null {
  if (ast.kind === 'bin') {
    const l = exprVar(ast.left);
    const r = exprVar(ast.right);
    if (l && r && l !== r) return { operation: ast.op, inputMap: { [l]: 'x', [r]: 'y' } };
    return null;
  }
  if (ast.kind === 'neg') {
    const l = exprVar(ast.operand);
    if (l) return { operation: 'negate', inputMap: { [l]: 'x' } };
    return null;
  }
  if (ast.kind === 'call') {
    // `mod` is the function spelling of the Math node's `%`.
    const operation = ast.fn === 'mod' ? '%' : ast.fn;
    if (!MATH_OPS.has(operation)) return null;
    const a0 = ast.args[0];
    const l = a0 ? exprVar(a0) : null;
    if (!l) return null;
    if (ast.args.length === 1) return { operation, inputMap: { [l]: 'x' } };
    const a1 = ast.args[1];
    const r = a1 ? exprVar(a1) : null;
    if (ast.args.length === 2 && r && r !== l) return { operation, inputMap: { [l]: 'x', [r]: 'y' } };
    return null;
  }
  return null;
}

function expressionToMath(ctx: MorphContext): MorphResult {
  let operation = '+';
  // Positional fallback — the first two visible ports become X and Y, so a
  // formula too complex to read back still keeps its wires.
  let inputMap: Record<string, string> = { a: 'x', b: 'y' };
  const visibleCount = clampVisibleCount(ctx.config.visibleCount);
  const { map, errors } = buildVarMap(ctx.config, visibleCount);
  if (errors.length === 0) {
    const res = parseExpression(String(ctx.config.expression ?? ''), map);
    if (!('error' in res)) {
      const m = matchMathShape(res.ast);
      if (m) { operation = m.operation; inputMap = m.inputMap; }
    }
  }
  return { config: { operation }, inputMap, outputMap: { result: 'result' } };
}

// ---------------------------------------------------------------------------
// Compare ⇄ Logical Expression / Math
// ---------------------------------------------------------------------------

const COMPARE_OPS: ReadonlySet<string> = new Set(['==', '!=', '>', '<', '>=', '<=']);

function compareToLogical(ctx: MorphContext): MorphResult | null {
  // A NeighborIndex comparison is EXACT on every target only because Compare
  // emits a dedicated i32 branch for it on WebGPU; Logical Expression's
  // comparison tier is f32 there, which cannot hold a packed NI exactly. Refuse
  // rather than ship a morph that is right on the CPU and wrong on the GPU.
  if (ctx.config.compareType === 'neighborIndex') return null;
  const op = String(ctx.config.operation ?? '==');
  const between = op === 'between' || op === 'notBetween';
  const operands: Operand[] = between
    ? [
      { port: 'x', literal: numLiteral },
      { port: 'y', literal: numLiteral },
      { port: 'y2', literal: numLiteral },
    ]
    : [{ port: 'x', literal: numLiteral }, { port: 'y', literal: numLiteral }];
  const { tokens, inputMap, visibleCount } = assignOperands(ctx, operands);
  const x = tokens.x ?? '0';
  const y = tokens.y ?? '0';
  let expression: string;
  if (between) {
    const y2 = tokens.y2 ?? '0';
    const lo = ctx.config.lowOp === '>' ? '>' : '>=';
    const hi = ctx.config.highOp === '<' ? '<' : '<=';
    // Comparisons bind tighter than AND, so the inner pair needs no parens —
    // but NOT binds tighter than AND, so the notBetween form DOES.
    const inside = `${x} ${lo} ${y} AND ${x} ${hi} ${y2}`;
    expression = op === 'notBetween' ? `NOT (${inside})` : inside;
  } else {
    expression = `${x} ${COMPARE_OPS.has(op) ? op : '=='} ${y}`;
  }
  return {
    config: { expression, visibleCount },
    inputMap,
    outputMap: { result: 'result' },
  };
}

function compareToMath(ctx: MorphContext): MorphResult | null {
  // Only a NUMERICAL comparison has operands arithmetic can act on — a tag / bool
  // / NeighborIndex Compare carries option indices and bit patterns.
  const t = ctx.config.compareType;
  if (t !== undefined && t !== 'numerical') return null;
  return {
    config: { operation: '+' },
    inputMap: { x: 'x', y: 'y' },
    outputMap: { result: 'result' },
  };
}

function mathToCompare(_ctx: MorphContext): MorphResult {
  return {
    config: { operation: '==', lowOp: '>=', highOp: '<=', compareType: 'numerical' },
    inputMap: { x: 'x', y: 'y' },
    outputMap: { result: 'result' },
  };
}

// ---------------------------------------------------------------------------
// Logic ⇄ Logical Expression
// ---------------------------------------------------------------------------

function logicToLogical(ctx: MorphContext): MorphResult {
  const op = String(ctx.config.operation ?? 'OR').toUpperCase();
  const unary = op === 'NOT';
  const operands: Operand[] = unary
    ? [{ port: 'a', literal: boolLiteral }]
    : [{ port: 'a', literal: boolLiteral }, { port: 'b', literal: boolLiteral }];
  const { tokens, inputMap, visibleCount } = assignOperands(ctx, operands);
  const a = tokens.a ?? 'false';
  const b = tokens.b ?? 'false';
  const expression = unary
    ? `NOT ${a}`
    : `${a} ${op === 'AND' || op === 'XOR' ? op : 'OR'} ${b}`;
  return {
    config: { expression, visibleCount },
    inputMap,
    outputMap: { result: 'result' },
  };
}

function logicVar(a: LogicAst): string | null {
  return a.kind === 'var' ? a.portId : null;
}

function matchLogicShape(ast: LogicAst): { operation: string; inputMap: Record<string, string> } | null {
  if (ast.kind === 'bin') {
    const l = logicVar(ast.left);
    const r = logicVar(ast.right);
    if (l && r && l !== r) return { operation: ast.op.toUpperCase(), inputMap: { [l]: 'a', [r]: 'b' } };
    return null;
  }
  if (ast.kind === 'not') {
    const l = logicVar(ast.operand);
    if (l) return { operation: 'NOT', inputMap: { [l]: 'a' } };
  }
  return null;
}

function logicalToLogic(ctx: MorphContext): MorphResult {
  let operation = 'OR';
  let inputMap: Record<string, string> = { a: 'a', b: 'b' };
  const visibleCount = clampVisibleCount(ctx.config.visibleCount);
  const { map, errors } = buildLogicVarMap(ctx.config, visibleCount);
  if (errors.length === 0) {
    const res = parseLogicExpression(String(ctx.config.expression ?? ''), map);
    if (!('error' in res)) {
      const m = matchLogicShape(res.ast);
      if (m) { operation = m.operation; inputMap = m.inputMap; }
    }
  }
  return { config: { operation }, inputMap, outputMap: { result: 'result' } };
}

// ---------------------------------------------------------------------------
// The two formula nodes are TWINS
// ---------------------------------------------------------------------------

/** Math Expression ⇄ Logical Expression. They share the whole editor surface —
 *  the same 8-port pool, `visibleCount`, `_varName_*`, and the width/collapse
 *  keys — so EVERY port id maps to itself and every wire survives. The formula
 *  TEXT carries across too: it is exactly the thing the user typed and wants to
 *  keep, and a formula that does not parse in the other grammar is already
 *  reported by the node's own amber badge.
 *
 *  The inline `_port_*` values are NOT carried (the engine's widget-match rule
 *  drops them): one node's ports are numbers, the other's are bools. */
function formulaTwin(ctx: MorphContext): MorphResult {
  const config: Record<string, string | number | boolean> = {
    expression: String(ctx.config.expression ?? ''),
    visibleCount: clampVisibleCount(ctx.config.visibleCount),
  };
  for (const id of VISIBLE_PORT_IDS) {
    const nm = ctx.config[`_varName_${id}`];
    if (typeof nm === 'string' && nm.trim()) config[`_varName_${id}`] = nm;
  }
  for (const key of ['_exprW', '_exprH', '_namesExpanded', '_exprExpanded'] as const) {
    const v = ctx.config[key];
    if (v !== undefined) config[key] = v;
  }
  const inputMap: Record<string, string> = {};
  for (const id of VISIBLE_PORT_IDS) inputMap[id] = id;
  return { config, inputMap, outputMap: { result: 'result' } };
}

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------

/**
 * Curated morph table, keyed by the SOURCE node type.
 *
 * Deliberately NOT here, and why:
 *   - Get Cell Attribute ⇄ Get Neighbor Attribute By Index: the neighbour read
 *     needs an `index` the own-cell read has no counterpart for, so the mapping
 *     is not clean and one direction would always leave a required port unwired.
 *   - anything crossing the value/flow boundary: a flow node's `do`/`next` have
 *     no value counterpart, so every edge would be dropped — a morph that
 *     disconnects the node is just a delete plus a re-add.
 */
export const NODE_MORPHS: Readonly<Record<string, readonly MorphSpec[]>> = {
  arithmeticOperator: [
    {
      to: 'expression',
      title: 'Rewrite this Math node as a formula. The operation becomes the formula text; '
        + 'a wired operand becomes a variable, an unwired one is baked in as its number. '
        + 'Every Math operation compiles identically in a formula.',
      build: mathToExpression,
    },
    {
      to: 'statement',
      title: 'Compare the two operands instead of computing with them. X, Y and the wires keep '
        + 'their places; the operation resets to "==" (there is no arithmetic counterpart).',
      build: mathToCompare,
    },
  ],
  expression: [
    {
      to: 'logicalExpression',
      title: 'Same ports, same variable names, same text — read as a BOOLEAN formula instead of a '
        + 'math one. Every wire survives; a formula that has no meaning in the other grammar is '
        + 'flagged by the node badge.',
      build: formulaTwin,
    },
    {
      to: 'arithmeticOperator',
      title: 'Collapse the formula back into a single Math node. A formula that is exactly one '
        + 'operation over two inputs keeps that operation; anything longer resets to "+" and the '
        + 'formula text is lost (Ctrl+Z restores it).',
      build: expressionToMath,
    },
  ],
  statement: [
    {
      to: 'logicalExpression',
      title: 'Grow this comparison into a boolean formula you can extend with AND / OR / NOT. '
        + 'The comparison becomes the formula text; an unwired operand is baked in as its value.',
      build: compareToLogical,
    },
    {
      to: 'arithmeticOperator',
      title: 'Compute with the two operands instead of comparing them. X, Y and the wires keep '
        + 'their places; the operation resets to "+".',
      build: compareToMath,
    },
  ],
  logicOperator: [
    {
      to: 'logicalExpression',
      title: 'Grow this Logic node into a boolean formula you can extend. The operation becomes '
        + 'the formula text; an unwired operand is baked in as true / false.',
      build: logicToLogical,
    },
  ],
  logicalExpression: [
    {
      to: 'expression',
      title: 'Same ports, same variable names, same text — read as a MATH formula instead of a '
        + 'boolean one. Every wire survives; a formula that has no meaning in the other grammar is '
        + 'flagged by the node badge.',
      build: formulaTwin,
    },
    {
      to: 'logicOperator',
      title: 'Collapse the formula back into a single Logic node. A formula that is exactly one '
        + 'AND / OR / XOR / NOT over inputs keeps that operator; anything longer resets to "OR" '
        + 'and the formula text is lost (Ctrl+Z restores it).',
      build: logicalToLogic,
    },
  ],
};

/** Does this node type have any morph at all? Cheap gate for the context menu. */
export function hasMorphs(nodeType: string): boolean {
  return (NODE_MORPHS[nodeType]?.length ?? 0) > 0;
}
