/**
 * Rendered logic view of a Logical Expression node's formula — the boolean
 * sibling of `ExpressionFormula`.
 *
 * Walks the SAME `LogicAst` all six emit surfaces emit from (so the picture can
 * never disagree with what runs) and lays it out with the standard symbols:
 * `¬` NOT, `∧` AND, `⊕` XOR, `∨` OR, `⊤` / `⊥` for the literals, and the
 * comparison glyphs `<` `≤` `>` `≥` `=` `≠`.
 *
 * DEPENDENCY-FREE BY DESIGN — plain inline spans, no typesetting library (the
 * app ships under a strict CSP as a single self-contained bundle). The box
 * itself is `ExpressionFormula`'s `FORMULA_ROOT_STYLE`, so the load-bearing
 * `contain: inline-size` rule holds identically for both node types.
 *
 * PARENTHESES ARE RE-DERIVED FROM PRECEDENCE, never echoed from the user's text
 * — the point of a rendered face: `(a AND NOT b) OR (b XOR c)` renders as
 * `a ∧ ¬b ∨ (b ⊕ c)`, dropping the brackets the AND never needed and keeping
 * the one the XOR does.
 *
 * A COMPARISON binds tighter than every boolean operator, so it is an ATOM to
 * them and `n > 2 AND alive` renders bracket-free. The ONE deliberate exception
 * to the precedence rule is a comparison under NOT: `¬n > 2` reads wrong to a
 * human however it parses, so it is rendered `¬(n > 2)` — the way the same
 * statement is written in maths. Legibility is this component's whole job.
 *
 * Renders NOTHING on a parse error: the node already has a validation channel
 * (the red parse-error line + the amber badge).
 */

import React from 'react';
import type { CmpOp, LogicAst, LogicNumAst, LogicOp } from '../compiler/expression/logicParser';
import { FORMULA_ROOT_STYLE } from './ExpressionFormula';

// ---------------------------------------------------------------------------
// Precedence — for parenthesis elision only. Matches the parser's tiers:
// NOT > AND > XOR > OR.
// ---------------------------------------------------------------------------

const P_OR = 1;
const P_XOR = 2;
const P_AND = 3;
const P_NOT = 4;
/** Atoms never need parentheses around them. */
const P_ATOM = 10;

const BIN_PREC: Record<LogicOp, number> = { or: P_OR, xor: P_XOR, and: P_AND };
const BIN_SYM: Record<LogicOp, string> = { or: '∨', xor: '⊕', and: '∧' };

/** `==` renders as the mathematical `=`, `!=` as `≠` — the formula view speaks
 *  maths, not source. */
const CMP_SYM: Record<CmpOp, string> = {
  '<': '<', '<=': '≤', '>': '>', '>=': '≥', '==': '=', '!=': '≠',
};

function prec(a: LogicAst): number {
  switch (a.kind) {
    case 'lit':
    case 'var':
      return P_ATOM;
    // Binds tighter than every boolean tier, so it never needs brackets around
    // it there (the NOT exception is handled at the NOT case, for readability).
    case 'cmp':
      return P_ATOM;
    case 'not':
      return P_NOT;
    case 'bin':
      return BIN_PREC[a.op];
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S = {
  varName: { fontStyle: 'italic' } as React.CSSProperties,
  lit: { fontStyle: 'normal', opacity: 0.85 } as React.CSSProperties,
  op: { padding: '0 0.28em' } as React.CSSProperties,
  not: { padding: '0 0.05em 0 0' } as React.CSSProperties,
} as const;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

type Names = Readonly<Record<string, string>>;

/** Render `a`, wrapping it in parentheses when the surrounding context needs it. */
function child(a: LogicAst, names: Names, needParens: boolean): React.ReactNode {
  const inner = render(a, names);
  return needParens ? <>({inner})</> : inner;
}

/** A comparison OPERAND: a variable reads like one (italic), a number like a
 *  number (upright). */
function renderNum(n: LogicNumAst, names: Names): React.ReactNode {
  return n.kind === 'numvar'
    ? <span style={S.varName}>{names[n.portId] ?? n.portId}</span>
    : <span style={S.lit}>{n.value}</span>;
}

function render(a: LogicAst, names: Names): React.ReactNode {
  switch (a.kind) {
    case 'lit':
      return <span style={S.lit}>{a.value ? '⊤' : '⊥'}</span>;

    case 'var':
      return <span style={S.varName}>{names[a.portId] ?? a.portId}</span>;

    case 'cmp':
      return (
        <>
          {renderNum(a.left, names)}
          <span style={S.op}>{CMP_SYM[a.op]}</span>
          {renderNum(a.right, names)}
        </>
      );

    case 'not':
      // NOT binds tighter than every BOOLEAN operator, so anything looser than
      // an atom needs brackets: `¬(a ∧ b)` differs from `¬a ∧ b`. A nested NOT
      // does not (`¬¬a`). A COMPARISON is bracketed despite binding tighter —
      // the documented readability exception (`¬(n > 2)`, never `¬n > 2`).
      return (
        <>
          <span style={S.not}>¬</span>
          {child(a.operand, names, prec(a.operand) < P_NOT || a.operand.kind === 'cmp')}
        </>
      );

    case 'bin': {
      const p = BIN_PREC[a.op];
      // Every binary operator here is left-associative AND associative
      // (∧, ∨, ⊕ all are), so an equal-precedence child needs no brackets on
      // either side — only a looser one does.
      return (
        <>
          {child(a.left, names, prec(a.left) < p)}
          <span style={S.op}>{BIN_SYM[a.op]}</span>
          {child(a.right, names, prec(a.right) < p)}
        </>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface LogicalFormulaProps {
  /** Parsed formula. Pass `null` (a parse error / empty text) to render nothing. */
  ast: LogicAst | null;
  /** port id → user-facing variable name (the inverse of the parser's var map). */
  names: Names;
  style?: React.CSSProperties;
}

/**
 * Read-only rendered view of a parsed boolean expression. Returns `null` when
 * there is no AST, so a caller can mount it unconditionally.
 */
export const LogicalFormula: React.FC<LogicalFormulaProps> = ({ ast, names, style }) => {
  if (!ast) return null;
  return (
    <div
      style={style ? { ...FORMULA_ROOT_STYLE, ...style } : FORMULA_ROOT_STYLE}
      title="Rendered view of the logical expression"
    >
      {render(ast, names)}
    </div>
  );
};
