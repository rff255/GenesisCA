/**
 * BOOLEAN-expression parser for the Logical Expression node.
 *
 * The logic sibling of `parser.ts` (the math Expression node): a tokenizer +
 * recursive-descent parser producing a small target-agnostic AST that all six
 * emit surfaces (JS / WASM / WebGPU × cell + agent) walk through their own
 * emitter (`emitLogicJS` / `emitLogicWasm` / `emitLogicWgsl`).
 *
 * THE BOUNDARY BETWEEN THE TWO GRAMMARS IS **ARITHMETIC**, and only arithmetic.
 * This grammar owns the boolean operators AND the COMPARISONS that produce a
 * boolean (`n > 2`, `a == b`) — Compare and Logic are almost always used
 * together, so keeping them apart forced a two-node chain on the most common
 * rule shape there is. What stays out is every way of COMPUTING a number: no
 * `+ - * /`, no functions, not even negation (a `-` is only a sign on a numeric
 * literal). A computed number still arrives through a port — from a wire, or
 * from a nested Expression node. So each parser still owns one job and stays
 * small and independently verifiable; the Expression node has no boolean
 * operators, and this one has no arithmetic.
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
 *   unary   := 'NOT' unary | cmp
 *   cmp     := numAtom CMPOP numAtom | primary  -- NON-associative (no chaining)
 *   primary := 'true' | 'false' | '1' | '0' | NAME | '(' expr ')'
 *   numAtom := '-'? NUMBER | NAME | '(' numAtom ')'
 *
 * Precedence: CMP > NOT > AND > XOR > OR — the comparison tier binds TIGHTEST,
 * Python's rule, so `NOT a > b` is `NOT (a > b)` and `a > 2 AND b < 3` needs no
 * parentheses. All boolean binary operators are left-associative; comparisons do
 * NOT chain (`a < b < c` is a parse error naming the fix, never a silent
 * `(a < b) < c`).
 *
 * Word operators are case-insensitive (`and` ≡ `AND`), as are the literals
 * (`true` ≡ `TRUE`). Symbol forms: `!` = NOT, `&&` (or `&`) = AND, `^` = XOR,
 * `||` (or `|`) = OR. Comparison operators are `<` `<=` `>` `>=` `==` `!=`, with
 * a bare `=` accepted as an alias for `==` (there is no assignment in this
 * grammar, so nothing for it to be confused with).
 *
 * A NAME is dual-role: bare it is TRUTHY-tested (`alive`), as a comparison
 * operand it is the raw number (`energy > 3`). A NUMBER is a comparison operand;
 * only `0` / `1` may also stand as a boolean literal (any other number used as a
 * boolean is a parse error, since there is no arithmetic here for it to be part
 * of). `true` / `false` are booleans only — compare against `1` / `0` instead.
 */

import type { NodeConfig } from '../../types';
import { VISIBLE_PORT_IDS, MAX_VISIBLE, clampVisibleCount } from './parser';

// Re-exported so a consumer of the logic node only needs this one module.
export { VISIBLE_PORT_IDS, MAX_VISIBLE, clampVisibleCount };

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type LogicOp = 'and' | 'xor' | 'or';

/** The six comparison operators, in their CANONICAL spelling (`=` folds to
 *  `==`). Every emitter maps these to its own target's operator. */
export type CmpOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

/**
 * A comparison OPERAND. Deliberately its own type rather than a `LogicAst`
 * variant: a `var` is truthy-tested and a `numvar` is read raw, and giving the
 * two readings separate node kinds is what makes every emitter's job
 * unambiguous — there is no "which sense is this in?" question to get wrong.
 */
export type LogicNumAst =
  | { kind: 'num'; value: number }
  | { kind: 'numvar'; portId: string };

export type LogicAst =
  | { kind: 'lit'; value: boolean }
  | { kind: 'var'; portId: string }
  | { kind: 'not'; operand: LogicAst }
  | { kind: 'bin'; op: LogicOp; left: LogicAst; right: LogicAst }
  | { kind: 'cmp'; op: CmpOp; left: LogicNumAst; right: LogicNumAst };

/** Words that may not be used as a variable / port name: the operators and the
 *  literals. Compared lower-cased, since both are case-insensitive.
 *
 *  The comparison tier adds NO entry here — every comparison operator is a
 *  SYMBOL, so no existing port name can have been invalidated by it. */
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
  /** For an `op` token this is the CANONICAL form: a word operator
   *  ('not'/'and'/'xor'/'or'), a comparison operator (`CmpOp`), or 'minus'. */
  value: string;
  /** The text the user actually wrote (for error messages). */
  text: string;
  pos: number;
}

const CMP_OPS: ReadonlySet<string> = new Set<string>(['<', '<=', '>', '>=', '==', '!=']);
const isCmpTok = (t: Token): boolean => t.type === 'op' && CMP_OPS.has(t.value);

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

    // Numbers. A plain decimal (`2`, `0.5`); no exponent form (`e` is an
    // identifier character, so `1e3` would read as `1` followed by a variable
    // `e3`). Whether the value is legal HERE is decided at parse time, not
    // here: `2` is a fine comparison operand and only a bad BOOLEAN, so the
    // "not a boolean" error belongs at the point of use.
    if (isDigit(c)) {
      let j = i;
      while (j < n && (isDigit(src[j]!) || src[j] === '.')) j++;
      const text = src.slice(i, j);
      if (!Number.isFinite(Number(text))) {
        throw new LogicParseError(`"${text}" is not a valid number`, start);
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
    // there is nothing for them to be confused with. Likewise a bare `=` is an
    // alias for `==`: there is no assignment here.
    // `!=` MUST be tested before the bare `!` (NOT), and `<=`/`>=` before their
    // single-character forms.
    if (c === '!') {
      if (src[i + 1] === '=') { tokens.push({ type: 'op', value: '!=', text: '!=', pos: start }); i += 2; continue; }
      tokens.push({ type: 'op', value: 'not', text: '!', pos: start }); i++; continue;
    }
    if (c === '<' || c === '>') {
      const two = src[i + 1] === '=';
      const v = two ? `${c}=` : c;
      tokens.push({ type: 'op', value: v, text: v, pos: start });
      i += two ? 2 : 1;
      continue;
    }
    if (c === '=') {
      const two = src[i + 1] === '=';
      tokens.push({ type: 'op', value: '==', text: two ? '==' : '=', pos: start });
      i += two ? 2 : 1;
      continue;
    }
    if (c === '-') { tokens.push({ type: 'op', value: 'minus', text: '-', pos: start }); i++; continue; }
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
    if (t.type !== 'eof') {
      // A trailing `-` is overwhelmingly an attempt at arithmetic (`a - 2`), so
      // say so rather than the bare "Unexpected".
      if (t.type === 'op' && t.value === 'minus') {
        throw new LogicParseError(
          '"-" may only sign a number — a logical expression has no arithmetic (feed a computed value in through a port)',
          t.pos,
        );
      }
      throw new LogicParseError(`Unexpected "${t.text}"`, t.pos);
    }
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
    return this.parseCmp();
  }

  /**
   * The COMPARISON tier — tighter than NOT, so `NOT a > b` is `NOT (a > b)`.
   *
   * A comparison's operands are NUMERIC while everything above this tier is
   * BOOLEAN, and the two readings share a token (`a` is both a truthy test and a
   * number). Rather than guess, the left operand is parsed SPECULATIVELY as a
   * numeric atom and the position restored unless a comparison operator actually
   * follows — a bounded, one-atom lookahead that keeps `(a) > 2` working while
   * leaving every boolean form to `parsePrimary` untouched.
   */
  private parseCmp(): LogicAst {
    const save = this.pos;
    const left = this.tryNumAtom();
    if (left && isCmpTok(this.peek())) {
      const opTok = this.next();
      const right = this.parseNumAtom();
      const after = this.peek();
      if (isCmpTok(after)) {
        throw new LogicParseError(
          `Chained comparisons are not supported — write "x ${opTok.text} y AND y ${after.text} z"`,
          after.pos,
        );
      }
      return { kind: 'cmp', op: opTok.value as CmpOp, left, right };
    }
    this.pos = save;

    const bool = this.parsePrimary();
    const t = this.peek();
    if (isCmpTok(t)) {
      throw new LogicParseError(
        `"${t.text}" compares numbers — each side must be a number or an input variable`,
        t.pos,
      );
    }
    return bool;
  }

  /** Speculative `parseNumAtom`: returns null (and restores the position) when
   *  the tokens ahead are not a numeric atom. */
  private tryNumAtom(): LogicNumAst | null {
    const save = this.pos;
    try {
      return this.parseNumAtom();
    } catch (e) {
      this.pos = save;
      if (e instanceof LogicParseError) return null;
      throw e;
    }
  }

  /** A comparison operand: an optionally-signed NUMBER, a variable, or either of
   *  those in parentheses. NOT an expression — there is no arithmetic here. */
  private parseNumAtom(): LogicNumAst {
    const t = this.next();

    if (t.type === 'op' && t.value === 'minus') {
      const n = this.next();
      if (n.type !== 'num') {
        throw new LogicParseError(
          '"-" may only sign a number — a logical expression has no arithmetic (feed a computed value in through a port)',
          t.pos,
        );
      }
      return { kind: 'num', value: -Number(n.text) };
    }

    if (t.type === 'num') return { kind: 'num', value: Number(t.text) };

    if (t.type === 'ident') {
      const lower = t.value.toLowerCase();
      if (lower === 'true' || lower === 'false') {
        throw new LogicParseError(`"${t.text}" is a boolean, not a number — compare against 1 / 0`, t.pos);
      }
      const portId = this.varMap.get(t.value);
      if (portId !== undefined) return { kind: 'numvar', portId };
      throw new LogicParseError(`Unknown variable "${t.value}" — no input port is named that`, t.pos);
    }

    if (t.type === 'lparen') {
      const inner = this.parseNumAtom();
      const close = this.peek();
      if (close.type !== 'rparen') {
        throw new LogicParseError(
          `Expected ")"${close.type === 'eof' ? '' : ` but found "${close.text}"`}`, close.pos,
        );
      }
      this.next();
      return inner;
    }

    throw new LogicParseError(
      `Expected a number or an input variable${t.type === 'eof' ? '' : ` but found "${t.text}"`}`,
      t.pos,
    );
  }

  private parsePrimary(): LogicAst {
    const t = this.next();

    if (t.type === 'num') {
      // Only 0 / 1 double as boolean literals. Any other number reaching a
      // BOOLEAN position is a mistake — there is no arithmetic to make it part
      // of an expression, and a comparison would have consumed it above.
      if (t.text === '0' || t.text === '1') return { kind: 'lit', value: t.text === '1' };
      throw new LogicParseError(
        `"${t.text}" is not a boolean — use true/false (or 1/0), or compare it (e.g. "x > ${t.text}")`,
        t.pos,
      );
    }

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
      if (t.value === 'minus') {
        throw new LogicParseError(
          '"-" may only sign a number — a logical expression has no arithmetic (feed a computed value in through a port)',
          t.pos,
        );
      }
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
