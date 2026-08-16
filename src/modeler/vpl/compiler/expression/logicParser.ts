/**
 * BOOLEAN-expression parser for the Logical Expression node.
 *
 * The logic sibling of `parser.ts` (the math Expression node): a tokenizer +
 * recursive-descent parser producing a small target-agnostic AST that all six
 * emit surfaces (JS / WASM / WebGPU × cell + agent) walk through their own
 * emitter (`emitLogicJS` / `emitLogicWasm` / `emitLogicWgsl`).
 *
 * THE TWO GRAMMARS ARE DELIBERATELY DISJOINT. This one has no arithmetic and no
 * comparisons (that is the Expression node's job) and the Expression node has no
 * boolean operators — keeping them apart is what keeps both parsers small,
 * unambiguous and independently verifiable. Feed a comparison's 1/0 result in
 * through a port when a rule needs both.
 *
 * No dependencies, no `eval` / `new Function`. Imports nothing from the compiler
 * or the node layer (only the shared input-port pool constants), so it is safe
 * to import from the modeler UI (nodeValidation, CaNode, the node definition) as
 * well as from the five compilers.
 *
 * Grammar:
 *   expr    := xorExpr ('OR' xorExpr)*          -- loosest
 *   xorExpr := andExpr ('XOR' andExpr)*
 *   andExpr := unary ('AND' unary)*
 *   unary   := 'NOT' unary | primary            -- tightest
 *   primary := 'true' | 'false' | '1' | '0' | NAME | '(' expr ')'
 *
 * Precedence: NOT > AND > XOR > OR. All binary operators are left-associative.
 * Word operators are case-insensitive (`and` ≡ `AND`), as are the literals
 * (`true` ≡ `TRUE`). Symbol forms: `!` = NOT, `&&` (or `&`) = AND, `^` = XOR,
 * `||` (or `|`) = OR. `1` / `0` are accepted as literals; any other number is a
 * parse error (there is no arithmetic here, so a `2` can only be a mistake).
 */

import type { NodeConfig } from '../../types';
import { VISIBLE_PORT_IDS, MAX_VISIBLE, clampVisibleCount } from './parser';

// Re-exported so a consumer of the logic node only needs this one module.
export { VISIBLE_PORT_IDS, MAX_VISIBLE, clampVisibleCount };

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type LogicOp = 'and' | 'xor' | 'or';

export type LogicAst =
  | { kind: 'lit'; value: boolean }
  | { kind: 'var'; portId: string }
  | { kind: 'not'; operand: LogicAst }
  | { kind: 'bin'; op: LogicOp; left: LogicAst; right: LogicAst };

/** Words that may not be used as a variable / port name: the operators and the
 *  literals. Compared lower-cased, since both are case-insensitive. */
export const RESERVED_LOGIC: ReadonlySet<string> = new Set<string>([
  'not', 'and', 'xor', 'or', 'true', 'false',
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Variable map — user-facing names → port ids
// ---------------------------------------------------------------------------

export interface LogicVarMapResult {
  /** user-facing variable name → port id (one of VISIBLE_PORT_IDS). */
  map: Map<string, string>;
  /** Human-readable problems (invalid / duplicate / reserved names). */
  errors: string[];
}

/**
 * Build the name→portId map for a Logical Expression node from its config. Each
 * visible port's name is `config['_varName_' + portId]` (trimmed) or, if blank,
 * the port id itself — so a fresh node already works with `a AND b`.
 *
 * Mirrors the math node's `buildVarMap`, with its own reserved set: the logic
 * grammar reserves the operator words + literals rather than the function names.
 */
export function buildLogicVarMap(
  config: NodeConfig | undefined,
  visibleCount: number,
): LogicVarMapResult {
  const cfg = config ?? {};
  const map = new Map<string, string>();
  const errors: string[] = [];
  const n = clampVisibleCount(visibleCount);
  for (let i = 0; i < n; i++) {
    const portId = VISIBLE_PORT_IDS[i]!;
    const raw = cfg[`_varName_${portId}`];
    const name = (typeof raw === 'string' && raw.trim()) ? raw.trim() : portId;
    if (!IDENT_RE.test(name)) {
      errors.push(`Invalid variable name "${name}" on port ${portId.toUpperCase()}`);
      continue;
    }
    if (RESERVED_LOGIC.has(name.toLowerCase())) {
      errors.push(`Variable name "${name}" is reserved (it is an operator or a literal)`);
      continue;
    }
    if (map.has(name)) {
      errors.push(`Duplicate variable name "${name}"`);
      continue;
    }
    map.set(name, portId);
  }
  return { map, errors };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokType = 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'eof';

interface Token {
  type: TokType;
  /** For an `op` token this is the CANONICAL word form ('not'/'and'/'xor'/'or'). */
  value: string;
  /** The text the user actually wrote (for error messages). */
  text: string;
  pos: number;
}

class LogicParseError extends Error {
  constructor(message: string, public readonly pos: number) {
    super(message);
    this.name = 'LogicParseError';
  }
}

function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isIdentStart(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
}
function isIdentPart(c: string): boolean { return isIdentStart(c) || isDigit(c); }

/** Word operators, lower-cased. Anything else that looks like an identifier is a
 *  variable or a literal. */
const WORD_OPS: Record<string, string> = { not: 'not', and: 'and', xor: 'xor', or: 'or' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    const start = i;

    // Numbers: only the boolean literals 0 and 1 are meaningful here. A longer
    // run is consumed whole so the error names what the user actually typed.
    if (isDigit(c)) {
      let j = i;
      while (j < n && (isDigit(src[j]!) || src[j] === '.')) j++;
      const text = src.slice(i, j);
      if (text !== '0' && text !== '1') {
        throw new LogicParseError(
          `"${text}" is not a boolean — use true/false (or 1/0)`, start,
        );
      }
      tokens.push({ type: 'num', value: text, text, pos: start });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j]!)) j++;
      const text = src.slice(i, j);
      const word = WORD_OPS[text.toLowerCase()];
      tokens.push(word
        ? { type: 'op', value: word, text, pos: start }
        : { type: 'ident', value: text, text, pos: start });
      i = j;
      continue;
    }

    // Symbol operators. `&&`/`||` are the canonical forms; the single-character
    // `&`/`|` are accepted as aliases — this grammar has no bitwise operator, so
    // there is nothing for them to be confused with.
    if (c === '!') { tokens.push({ type: 'op', value: 'not', text: '!', pos: start }); i++; continue; }
    if (c === '^') { tokens.push({ type: 'op', value: 'xor', text: '^', pos: start }); i++; continue; }
    if (c === '&') {
      const two = src[i + 1] === '&';
      tokens.push({ type: 'op', value: 'and', text: two ? '&&' : '&', pos: start });
      i += two ? 2 : 1;
      continue;
    }
    if (c === '|') {
      const two = src[i + 1] === '|';
      tokens.push({ type: 'op', value: 'or', text: two ? '||' : '|', pos: start });
      i += two ? 2 : 1;
      continue;
    }
    if (c === '(') { tokens.push({ type: 'lparen', value: c, text: c, pos: start }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: c, text: c, pos: start }); i++; continue; }

    throw new LogicParseError(`Unexpected character "${c}"`, start);
  }
  tokens.push({ type: 'eof', value: '', text: '', pos: n });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent — one level per precedence tier)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[], private readonly varMap: Map<string, string>) {}

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }

  parse(): LogicAst {
    const expr = this.parseOr();
    const t = this.peek();
    if (t.type !== 'eof') throw new LogicParseError(`Unexpected "${t.text}"`, t.pos);
    return expr;
  }

  /** One left-associative binary tier. */
  private parseBinary(op: LogicOp, nextTier: () => LogicAst): LogicAst {
    let left = nextTier();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || t.value !== op) break;
      this.next();
      left = { kind: 'bin', op, left, right: nextTier() };
    }
    return left;
  }

  private parseOr(): LogicAst { return this.parseBinary('or', () => this.parseXor()); }
  private parseXor(): LogicAst { return this.parseBinary('xor', () => this.parseAnd()); }
  private parseAnd(): LogicAst { return this.parseBinary('and', () => this.parseUnary()); }

  private parseUnary(): LogicAst {
    const t = this.peek();
    if (t.type === 'op' && t.value === 'not') {
      this.next();
      return { kind: 'not', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): LogicAst {
    const t = this.next();

    if (t.type === 'num') return { kind: 'lit', value: t.value === '1' };

    if (t.type === 'lparen') {
      const inner = this.parseOr();
      const close = this.peek();
      if (close.type !== 'rparen') {
        throw new LogicParseError(
          `Expected ")"${close.type === 'eof' ? '' : ` but found "${close.text}"`}`, close.pos,
        );
      }
      this.next();
      return inner;
    }

    if (t.type === 'ident') {
      const lower = t.value.toLowerCase();
      if (lower === 'true') return { kind: 'lit', value: true };
      if (lower === 'false') return { kind: 'lit', value: false };
      const portId = this.varMap.get(t.value);
      if (portId !== undefined) return { kind: 'var', portId };
      throw new LogicParseError(
        `Unknown variable "${t.value}" — no input port is named that`, t.pos,
      );
    }

    if (t.type === 'op') {
      throw new LogicParseError(`"${t.text}" needs a value before it`, t.pos);
    }

    throw new LogicParseError(
      `Unexpected ${t.type === 'eof' ? 'end of expression' : `"${t.text}"`}`,
      t.pos,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LogicParseResult = { ast: LogicAst } | { error: string; position?: number };

/**
 * Parse a boolean-expression source string against a variable map. Returns
 * either `{ ast }` or `{ error, position? }`. Never throws.
 */
export function parseLogicExpression(src: string, varMap: Map<string, string>): LogicParseResult {
  if (!src.trim()) return { error: 'Expression is empty' };
  try {
    const tokens = tokenize(src);
    return { ast: new Parser(tokens, varMap).parse() };
  } catch (e) {
    if (e instanceof LogicParseError) return { error: e.message, position: e.pos };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
