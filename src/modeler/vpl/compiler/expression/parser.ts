/**
 * Math-expression parser for the Expression node.
 *
 * Tokenizer + precedence-climbing recursive-descent parser producing a small
 * target-agnostic AST. The three compile targets (JS / WASM / WebGPU) each walk
 * this same AST via their own emitter (`emitJS` / `emitWasm` / `emitWgsl`).
 *
 * No dependencies, no `eval` / `new Function`. This module imports nothing from
 * the compiler or the node layer, so it is safe to import from the modeler UI
 * (nodeValidation, the node definition) as well as from the three compilers.
 *
 * Supported grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := ('-' | '+')? power
 *   power   := primary ('^' unary)?            -- right-associative
 *   primary := NUMBER | NAME | NAME '(' args ')' | '(' expr ')'
 * (precedence is actually implemented via precedence-climbing, not the literal
 * grammar above, but the binding powers match it.)
 *
 * Functions are the cross-target-safe set only: sqrt abs floor ceil round min
 * max pow mod. Transcendentals (sin/cos/exp/log) are intentionally NOT
 * supported — WASM has no native opcodes/imports for them. Adding them later
 * means new WASM env imports plus matching WGSL/JS emit.
 */

import type { NodeConfig } from '../../types';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type ExprFn =
  | 'sqrt' | 'abs' | 'floor' | 'ceil' | 'round' | 'min' | 'max' | 'pow' | 'mod';

export type ExprAst =
  | { kind: 'num'; value: number }
  | { kind: 'var'; portId: string }
  | { kind: 'neg'; operand: ExprAst }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '%'; left: ExprAst; right: ExprAst }
  | { kind: 'call'; fn: ExprFn; args: ExprAst[] };

/** Fixed arity per supported function. */
const FN_ARITY: Record<ExprFn, number> = {
  sqrt: 1, abs: 1, floor: 1, ceil: 1, round: 1,
  min: 2, max: 2, pow: 2, mod: 2,
};

/** Named constants resolved to numeric literals at parse time. A port named
 *  `pi`/`e` shadows these (the var map is checked before the constant table). */
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Names that may not be used as variable / port names — the function names.
 *  Constant names (`pi`, `e`) are intentionally NOT reserved: a port may be
 *  named `e`, in which case it shadows the constant. */
export const RESERVED: ReadonlySet<string> = new Set<string>(Object.keys(FN_ARITY));

/** The fixed pool of input port ids for the Expression node. */
export const VISIBLE_PORT_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
export const MAX_VISIBLE = VISIBLE_PORT_IDS.length;
export const DEFAULT_VISIBLE_COUNT = 3;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Variable map — user-facing names → port ids
// ---------------------------------------------------------------------------

export interface VarMapResult {
  /** user-facing variable name → port id (one of VISIBLE_PORT_IDS). */
  map: Map<string, string>;
  /** Human-readable problems (invalid / duplicate / reserved names). */
  errors: string[];
}

/** Clamp a raw `visibleCount` config value into `[1, MAX_VISIBLE]`. */
export function clampVisibleCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_VISIBLE_COUNT;
  return Math.max(1, Math.min(MAX_VISIBLE, Math.floor(n)));
}

/**
 * Build the name→portId map for an Expression node from its config. Each
 * visible port's name is `config['_varName_' + portId]` (trimmed) or, if blank,
 * the port id itself — so a fresh node already works with `a + b`.
 */
export function buildVarMap(config: NodeConfig | undefined, visibleCount: number): VarMapResult {
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
    if (RESERVED.has(name)) {
      errors.push(`Variable name "${name}" is reserved (it is a function name)`);
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

type TokType = 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  type: TokType;
  value: string;
  num?: number;
  pos: number;
}

class ParseError extends Error {
  constructor(message: string, public readonly pos: number) {
    super(message);
    this.name = 'ParseError';
  }
}

function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isIdentStart(c: string): boolean {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
}
function isIdentPart(c: string): boolean { return isIdentStart(c) || isDigit(c); }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    const start = i;

    // Number: [0-9]*('.'[0-9]*)? with optional [eE][+-]?[0-9]+ exponent, OR
    // a leading '.' followed by digits. The exponent is only consumed when it
    // is well-formed — otherwise a trailing `e` is left to tokenise as an ident
    // (so `2e` parses as `2 * e`-style errors rather than a bad number).
    if (isDigit(c) || (c === '.' && i + 1 < n && isDigit(src[i + 1]!))) {
      let j = i;
      while (j < n && isDigit(src[j]!)) j++;
      if (j < n && src[j] === '.') { j++; while (j < n && isDigit(src[j]!)) j++; }
      if (j < n && (src[j] === 'e' || src[j] === 'E')) {
        let k = j + 1;
        if (k < n && (src[k] === '+' || src[k] === '-')) k++;
        if (k < n && isDigit(src[k]!)) {
          while (k < n && isDigit(src[k]!)) k++;
          j = k;
        }
      }
      const text = src.slice(i, j);
      const num = Number(text);
      if (!Number.isFinite(num)) throw new ParseError(`Invalid number "${text}"`, start);
      tokens.push({ type: 'num', value: text, num, pos: start });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j]!)) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: start });
      i = j;
      continue;
    }

    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '^') {
      tokens.push({ type: 'op', value: c, pos: start });
      i++;
      continue;
    }
    if (c === '(') { tokens.push({ type: 'lparen', value: c, pos: start }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: c, pos: start }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: c, pos: start }); i++; continue; }

    throw new ParseError(`Unexpected character "${c}"`, start);
  }
  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (precedence climbing)
// ---------------------------------------------------------------------------

/** Binary operator binding powers. Higher binds tighter. `^` is right-assoc
 *  (right < left). Unary minus sits between `*` and `^`. */
const BINARY_BP: Record<string, { left: number; right: number }> = {
  '+': { left: 1, right: 2 },
  '-': { left: 1, right: 2 },
  '*': { left: 3, right: 4 },
  '/': { left: 3, right: 4 },
  '%': { left: 3, right: 4 },
  '^': { left: 6, right: 5 },
};
const UNARY_BP = 5;

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[], private readonly varMap: Map<string, string>) {}

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }

  private expect(type: TokType, what: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new ParseError(`Expected ${what}${t.type === 'eof' ? '' : ` but found "${t.value}"`}`, t.pos);
    }
    return this.next();
  }

  parse(): ExprAst {
    const expr = this.parseExpr(0);
    const t = this.peek();
    if (t.type !== 'eof') throw new ParseError(`Unexpected "${t.value}"`, t.pos);
    return expr;
  }

  private parseExpr(minBp: number): ExprAst {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op') break;
      const bp = BINARY_BP[t.value];
      if (!bp || bp.left < minBp) break;
      this.next();
      const right = this.parseExpr(bp.right);
      left = t.value === '^'
        ? { kind: 'call', fn: 'pow', args: [left, right] }
        : { kind: 'bin', op: t.value as '+' | '-' | '*' | '/' | '%', left, right };
    }
    return left;
  }

  private parsePrefix(): ExprAst {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      const operand = this.parseExpr(UNARY_BP);
      return t.value === '-' ? { kind: 'neg', operand } : operand;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprAst {
    const t = this.next();

    if (t.type === 'num') return { kind: 'num', value: t.num! };

    if (t.type === 'lparen') {
      const inner = this.parseExpr(0);
      this.expect('rparen', '")"');
      return inner;
    }

    if (t.type === 'ident') {
      // Function call: NAME '(' args ')'
      if (this.peek().type === 'lparen') {
        if (!(t.value in FN_ARITY)) {
          throw new ParseError(`Unknown function "${t.value}"`, t.pos);
        }
        const fn = t.value as ExprFn;
        this.next(); // consume '('
        const args: ExprAst[] = [];
        if (this.peek().type !== 'rparen') {
          args.push(this.parseExpr(0));
          while (this.peek().type === 'comma') {
            this.next();
            args.push(this.parseExpr(0));
          }
        }
        this.expect('rparen', '")"');
        const arity = FN_ARITY[fn];
        if (args.length !== arity) {
          throw new ParseError(
            `${fn}() takes ${arity} argument${arity === 1 ? '' : 's'}, got ${args.length}`,
            t.pos,
          );
        }
        return { kind: 'call', fn, args };
      }

      // Variable — checked before the constant table so a port named `e`/`pi`
      // shadows the constant.
      const portId = this.varMap.get(t.value);
      if (portId !== undefined) return { kind: 'var', portId };

      // Named constant.
      if (t.value in CONSTANTS) return { kind: 'num', value: CONSTANTS[t.value]! };

      // A bare function name used as a value.
      if (t.value in FN_ARITY) {
        throw new ParseError(`"${t.value}" is a function — write ${t.value}(...)`, t.pos);
      }

      throw new ParseError(`Unknown variable "${t.value}" — no input port is named that`, t.pos);
    }

    throw new ParseError(
      `Unexpected ${t.type === 'eof' ? 'end of expression' : `"${t.value}"`}`,
      t.pos,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ParseResult = { ast: ExprAst } | { error: string; position?: number };

/**
 * Parse a math-expression source string against a variable map. Returns either
 * `{ ast }` or `{ error, position? }`. Never throws.
 */
export function parseExpression(src: string, varMap: Map<string, string>): ParseResult {
  if (!src.trim()) return { error: 'Expression is empty' };
  try {
    const tokens = tokenize(src);
    return { ast: new Parser(tokens, varMap).parse() };
  } catch (e) {
    if (e instanceof ParseError) return { error: e.message, position: e.pos };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
