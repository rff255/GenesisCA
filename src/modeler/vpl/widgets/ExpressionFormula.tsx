/**
 * Rendered math view of an Expression node's formula.
 *
 * Walks the SAME `ExprAst` the three compile targets emit from (so the picture
 * can never disagree with what runs) and lays it out as nested inline HTML:
 * division becomes a stacked fraction, `^` a superscript, `sqrt` a radical,
 * `abs` vertical bars, `%` / `mod` the upright `mod` operator, everything else a
 * function in upright type with its arguments in parentheses.
 *
 * DEPENDENCY-FREE BY DESIGN — no KaTeX/MathJax. The app ships under a strict CSP
 * as a single self-contained bundle (and the presentation export inlines it), so
 * a typesetting library would be both dead weight and a CSP problem. Everything
 * here is flexbox + a `border-top` for the fraction bar and the radical's
 * vinculum.
 *
 * PARENTHESES ARE RE-DERIVED FROM PRECEDENCE, never echoed from the user's text
 * — that is the whole point: `(a*b + c) / (d - e)` renders as a fraction with no
 * parentheses at all, which is what makes a deeply-nested formula readable.
 *
 * Renders NOTHING on a parse error: the node already has a validation channel
 * (the red parse-error line + the amber badge) and a second error surface here
 * would just be noise.
 */

import React from 'react';
import type { ExprAst, ExprFn } from '../compiler/expression/parser';

// ---------------------------------------------------------------------------
// Precedence — for parenthesis elision only (NOT the parser's binding powers).
// ---------------------------------------------------------------------------

const P_SUM = 1;
/** `mod` sits BETWEEN sum and product: `a·b mod c` then reads correctly and
 *  `a · (b mod c)` keeps its parentheses. */
const P_MOD = 1.5;
const P_PROD = 2;
const P_POW = 4;
/** Atoms and self-grouping forms (a stacked fraction, a radical, `f(x)`, `|x|`)
 *  never need parentheses around them. */
const P_ATOM = 10;

/** Functions rendered as `name(args)` — i.e. the ones that already carry their
 *  own parentheses, so they may sit under a superscript unparenthesised. */
const FUNC_FORM: ReadonlySet<ExprFn> = new Set<ExprFn>([
  'floor', 'ceil', 'round', 'min', 'max', 'exp', 'log', 'sin', 'cos', 'tan', 'tanh',
]);

function prec(a: ExprAst): number {
  switch (a.kind) {
    case 'num':
    case 'var':
      return P_ATOM;
    case 'neg':
      return P_PROD;
    case 'bin':
      if (a.op === '/') return P_ATOM;      // stacked fraction groups itself
      if (a.op === '%') return P_MOD;
      return (a.op === '+' || a.op === '-') ? P_SUM : P_PROD;
    case 'call':
      if (a.fn === 'pow') return P_POW;
      if (a.fn === 'mod') return P_MOD;
      return P_ATOM;                        // radical / |x| / f(x)
  }
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** The parser folds `pi` / `e` to literals, so recover the glyphs rather than
 *  showing 3.141592653589793 in the middle of a formula. */
function fmtNum(v: number): string {
  if (v === Math.PI) return 'π';
  if (v === Math.E) return 'e';
  if (Number.isInteger(v)) return String(v);
  const s = String(v);
  return s.length <= 9 ? s : Number(v.toPrecision(6)).toString();
}

// ---------------------------------------------------------------------------
// Styles (inline — the widgets layer carries no CSS modules)
// ---------------------------------------------------------------------------

/** The formula box itself. Exported because the Logical Expression node's
 *  renderer (LogicalFormula) is the same box with different contents — sharing
 *  it is what keeps the `contain: inline-size` rule below true for both. */
export const FORMULA_ROOT_STYLE: React.CSSProperties = {
  fontSize: '0.72rem',
  lineHeight: 1.15,
  color: 'var(--color-text-secondary)',
  // A CaNode is content-sized, so a `nowrap` row of stacked fractions would
  // WIDEN the whole node (measured: 193 → 472 px on a long formula) — and
  // `max-width: 100%` cannot stop it, because the parent's width is itself
  // derived from its children's max-content. `contain: inline-size` makes
  // this box's inline size independent of its contents: its max-content
  // contribution drops to zero, the flex column's default stretch gives it
  // the real body width, and the formula scrolls inside it instead.
  contain: 'inline-size',
  alignSelf: 'stretch',
  overflowX: 'auto',
  overflowY: 'hidden',
  padding: '2px 0',
  whiteSpace: 'nowrap',
  // A formula is a picture, not text to select word-by-word; letting a drag
  // start a selection inside the node body fights React Flow's node drag.
  userSelect: 'none',
};

const S = {
  root: FORMULA_ROOT_STYLE,
  varName: { fontStyle: 'italic' } as React.CSSProperties,
  fn: { fontStyle: 'normal' } as React.CSSProperties,
  op: { padding: '0 0.18em' } as React.CSSProperties,
  frac: {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    verticalAlign: 'middle',
    margin: '0 0.15em',
  } as React.CSSProperties,
  fracNum: { padding: '0 0.3em 1px' } as React.CSSProperties,
  fracDen: { padding: '1px 0.3em 0', borderTop: '1px solid currentColor' } as React.CSSProperties,
  radicand: { borderTop: '1px solid currentColor', padding: '1px 0.15em 0 0.05em' } as React.CSSProperties,
  bar: { padding: '0 0.05em' } as React.CSSProperties,
} as const;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type Names = Readonly<Record<string, string>>;

function parens(inner: React.ReactNode): React.ReactNode {
  return <>({inner})</>;
}

/** Render `a`, wrapping it in parentheses when the surrounding context needs it. */
function child(a: ExprAst, names: Names, needParens: boolean): React.ReactNode {
  const inner = render(a, names);
  return needParens ? parens(inner) : inner;
}

function binary(
  op: '+' | '-' | '*' | 'mod',
  left: ExprAst,
  right: ExprAst,
  names: Names,
): React.ReactNode {
  const p = op === 'mod' ? P_MOD : (op === '+' || op === '-') ? P_SUM : P_PROD;
  // Left-associative on every operator here, so an equal-precedence left child
  // never needs parentheses. The right child does when it binds looser, when
  // the operator is non-associative (`-`, `mod`), or when it is a negation
  // (`a · (−b)` reads far better than `a · −b`).
  const lp = prec(left) < p;
  const rp = prec(right) < p
    || (prec(right) === p && (op === '-' || op === 'mod'))
    || right.kind === 'neg';
  const sym = op === '+' ? '+' : op === '-' ? '−' : op === '*' ? '·' : 'mod';
  return (
    <>
      {child(left, names, lp)}
      <span style={op === 'mod' ? { ...S.op, ...S.fn, padding: '0 0.35em' } : S.op}>{sym}</span>
      {child(right, names, rp)}
    </>
  );
}

function render(a: ExprAst, names: Names): React.ReactNode {
  switch (a.kind) {
    case 'num':
      return <span>{fmtNum(a.value)}</span>;

    case 'var':
      return <span style={S.varName}>{names[a.portId] ?? a.portId}</span>;

    case 'neg':
      // Only a sum needs the parentheses; `−a·b` is standard notation.
      return <>{'−'}{child(a.operand, names, prec(a.operand) < P_PROD)}</>;

    case 'bin':
      if (a.op === '/') {
        return (
          <span style={S.frac}>
            <span style={S.fracNum}>{render(a.left, names)}</span>
            <span style={S.fracDen}>{render(a.right, names)}</span>
          </span>
        );
      }
      if (a.op === '%') return binary('mod', a.left, a.right, names);
      return binary(a.op, a.left, a.right, names);

    case 'call': {
      const args = a.args;
      if (a.fn === 'pow' && args.length === 2) {
        const base = args[0]!;
        // A superscript attaches to whatever sits immediately left of it, so a
        // base that is not an atom or an already-parenthesised function form
        // MUST be bracketed — `(−a)²` and `(a+b)²` differ from `−a²` / `a+b²`,
        // and a radical/fraction base would visually swallow the exponent.
        const bare = base.kind === 'num' || base.kind === 'var'
          || (base.kind === 'call' && (FUNC_FORM.has(base.fn) || base.fn === 'abs'));
        return (
          <>
            {child(base, names, !bare)}
            <sup style={{ fontSize: '0.8em' }}>{render(args[1]!, names)}</sup>
          </>
        );
      }
      if (a.fn === 'mod' && args.length === 2) return binary('mod', args[0]!, args[1]!, names);
      if (a.fn === 'sqrt' && args.length === 1) {
        return (
          <span>
            {'√'}<span style={S.radicand}>{render(args[0]!, names)}</span>
          </span>
        );
      }
      if (a.fn === 'abs' && args.length === 1) {
        return (
          <span>
            <span style={S.bar}>|</span>{render(args[0]!, names)}<span style={S.bar}>|</span>
          </span>
        );
      }
      return (
        <span>
          <span style={S.fn}>{a.fn}</span>(
          {args.map((arg, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ paddingRight: '0.3em' }}>,</span>}
              {render(arg, names)}
            </React.Fragment>
          ))}
          )
        </span>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ExpressionFormulaProps {
  /** Parsed formula. Pass `null` (a parse error / empty text) to render nothing. */
  ast: ExprAst | null;
  /** port id → user-facing variable name (the inverse of the parser's var map). */
  names: Names;
  style?: React.CSSProperties;
}

/**
 * Read-only rendered view of a parsed expression. Returns `null` when there is
 * no AST, so a caller can mount it unconditionally.
 */
export const ExpressionFormula: React.FC<ExpressionFormulaProps> = ({ ast, names, style }) => {
  if (!ast) return null;
  return (
    <div style={style ? { ...S.root, ...style } : S.root} title="Rendered view of the expression">
      {render(ast, names)}
    </div>
  );
};

/** port id → variable name, from the parser's name → port id map. */
export function namesFromVarMap(map: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, portId] of map) out[portId] = name;
  return out;
}
