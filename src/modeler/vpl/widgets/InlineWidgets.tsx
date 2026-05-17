import { useEffect, useRef, useState } from 'react';

/**
 * Centralized inline-widget primitives used by the VPL node editor.
 *
 * The previous implementation inlined `<input type="number">` directly in
 * CaNode.tsx at every site that needed a numeric port widget. That made the
 * minus-sign typing bug — Chromium's `<input type="number">` returns
 * `.value === ''` while only `-` is in the buffer, which on a controlled
 * input wipes the keystroke on every re-render — impossible to fix without
 * touching every call site. These components encapsulate the fix so future
 * UX work (keyboard handling, ARIA, theming) lands in one place.
 *
 * All components forward `onMouseDown` / `onClick` so callers can plumb
 * React Flow's `stopDrag` handlers without leaking node-editor concerns
 * into the widget itself.
 */

interface InlineNumberInputProps {
  /** Controlled-from-config canonical string. */
  value: string;
  /** Called with committed values only — either a parseable number string or ''. */
  onChange: (next: string) => void;
  className?: string;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  placeholder?: string;
  /** Advisory only (type="text" doesn't enforce); kept for future-proofing. */
  min?: number;
  max?: number;
  step?: number | 'any';
  /** Inline style overrides for sizing in dense panel layouts. */
  style?: React.CSSProperties;
}

const TRANSITIONAL = new Set(['', '-', '-.', '.', '+', '+.']);
const EXPONENT_PARTIAL = /^[+-]?\d*\.?\d*[eE][+-]?$/;

/**
 * Numeric input that supports transitional typing states (`-`, `.`, `1e-`).
 *
 * Uses `type="text"` + `inputMode="decimal"` instead of `type="number"`:
 * the latter sanitises invalid intermediate states to `''`, which a
 * controlled-input loop then writes back, wiping the user's keystroke.
 * Local `draft` state holds the in-progress text; commits propagate only
 * for finite-number parses (or on blur).
 */
export function InlineNumberInput(props: InlineNumberInputProps) {
  const [draft, setDraft] = useState<string>(props.value);
  // Track what we last committed so we can detect external parent updates
  // (project load, undo, programmatic change) and resync without ping-pong.
  const lastCommittedRef = useRef<string>(props.value);

  useEffect(() => {
    if (props.value !== lastCommittedRef.current) {
      setDraft(props.value);
      lastCommittedRef.current = props.value;
    }
  }, [props.value]);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraft(raw);
    if (TRANSITIONAL.has(raw)) return;
    if (EXPONENT_PARTIAL.test(raw)) return;
    const n = Number(raw);
    if (Number.isFinite(n)) {
      lastCommittedRef.current = raw;
      props.onChange(raw);
    }
  };

  const onBlur = () => {
    const raw = draft;
    if (raw === '') {
      lastCommittedRef.current = '';
      props.onChange('');
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const canonical = String(n);
      lastCommittedRef.current = canonical;
      setDraft(canonical);
      props.onChange(canonical);
    } else {
      lastCommittedRef.current = '';
      setDraft('');
      props.onChange('');
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      lang="en"
      className={props.className}
      value={draft}
      onChange={onChange}
      onBlur={onBlur}
      onMouseDown={props.onMouseDown}
      onClick={props.onClick}
      title={props.title}
      placeholder={props.placeholder}
      style={props.style}
      data-min={props.min}
      data-max={props.max}
      data-step={props.step}
    />
  );
}

interface InlineBoolSelectProps {
  /** 'true' or 'false'; anything else renders as 'false'. */
  value: string;
  onChange: (next: 'true' | 'false') => void;
  className?: string;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  style?: React.CSSProperties;
}

export function InlineBoolSelect(props: InlineBoolSelectProps) {
  return (
    <select
      className={props.className}
      value={props.value === 'true' ? 'true' : 'false'}
      onChange={e => props.onChange(e.target.value as 'true' | 'false')}
      onMouseDown={props.onMouseDown}
      onClick={props.onClick}
      title={props.title}
      style={props.style}
    >
      <option value="true">True</option>
      <option value="false">False</option>
    </select>
  );
}

interface InlineTagSelectProps {
  /** Tag index as a string. */
  value: string;
  options: string[];
  onChange: (next: string) => void;
  className?: string;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  style?: React.CSSProperties;
}

export function InlineTagSelect(props: InlineTagSelectProps) {
  const opts = props.options ?? [];
  return (
    <select
      className={props.className}
      value={props.value || '0'}
      onChange={e => props.onChange(e.target.value)}
      onMouseDown={props.onMouseDown}
      onClick={props.onClick}
      title={props.title}
      style={props.style}
    >
      {opts.map((t, ti) => (
        <option key={ti} value={String(ti)}>{t}</option>
      ))}
      {opts.length === 0 && <option value="0">(no tags)</option>}
    </select>
  );
}
