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

interface NumberFieldProps {
  /** Canonical external value. undefined/null render as an empty field. */
  value: number | string | undefined | null;
  /** Called with committed finite numbers, already clamped (and rounded when
   *  `integer`). Transitional typing states (`-`, `.`, `1e-`) never commit. */
  onNumber: (n: number) => void;
  /** Called when the field is cleared (blur on empty). When absent, blurring
   *  an empty/invalid field restores the last committed value instead. */
  onClear?: () => void;
  min?: number;
  max?: number;
  /** Round committed values to the nearest integer. */
  integer?: boolean;
  className?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
}

/**
 * Drop-in replacement for panel `<input type="number">` sites, sharing
 * InlineNumberInput's draft/commit model (so typing a leading `-` or a
 * partial decimal is never wiped by the controlled-input loop) but exposing
 * a numeric API with min/max clamping. ALL number entry in panels and the
 * simulator should go through this (or InlineNumberInput for string-config
 * sites) — never a raw `<input type="number">`.
 */
export function NumberField(props: NumberFieldProps) {
  const external = props.value === undefined || props.value === null ? '' : String(props.value);
  const [draft, setDraft] = useState<string>(external);
  const lastCommittedRef = useRef<string>(external);

  useEffect(() => {
    if (external !== lastCommittedRef.current) {
      setDraft(external);
      lastCommittedRef.current = external;
    }
  }, [external]);

  const clamp = (n: number): number => {
    let v = n;
    if (props.min !== undefined && v < props.min) v = props.min;
    if (props.max !== undefined && v > props.max) v = props.max;
    if (props.integer) v = Math.round(v);
    return v;
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraft(raw);
    if (TRANSITIONAL.has(raw)) return;
    if (EXPONENT_PARTIAL.test(raw)) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const v = clamp(n);
    // Live-commit only values that survive clamping unchanged — otherwise
    // typing "1" toward "15" with min=10 would snap to 10 mid-keystroke.
    // Out-of-range drafts settle on blur.
    if (v === n) {
      lastCommittedRef.current = raw;
      props.onNumber(v);
    }
  };

  const onBlur = () => {
    const raw = draft;
    if (raw === '' && props.onClear) {
      lastCommittedRef.current = '';
      props.onClear();
      return;
    }
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n)) {
      const v = clamp(n);
      const canonical = String(v);
      lastCommittedRef.current = canonical;
      setDraft(canonical);
      props.onNumber(v);
    } else {
      // Invalid / empty without onClear: restore the last committed value.
      setDraft(lastCommittedRef.current);
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
      placeholder={props.placeholder}
      title={props.title}
      style={props.style}
      disabled={props.disabled}
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

interface InlineGlyphInputProps {
  /** Codepoint stored as a decimal string. '0' / '' = no glyph. */
  value: string;
  onChange: (next: string) => void;
  className?: string;
  onMouseDown?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

const GLYPH_STARTER_PALETTE = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖', '○', '△', '★'];
const GLYPH_PICKER_TITLE = 'Type any character — starters: ' + GLYPH_STARTER_PALETTE.join(' ');

function decodeCodepoint(cpStr: string): string {
  const cp = parseInt(cpStr, 10);
  if (!Number.isFinite(cp) || cp <= 0) return '';
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

function encodeFirstCodepoint(s: string): string {
  if (s.length === 0) return '0';
  const cp = s.codePointAt(0);
  return cp !== undefined ? String(cp) : '0';
}

/**
 * Text-input widget for picking a Unicode glyph. Stores the codepoint as a
 * decimal string; the visible character is decoded for display. Typing a new
 * character overwrites the previous one (we keep only the LAST codepoint, so
 * users can overwrite without first clearing).
 */
export function InlineGlyphInput(props: InlineGlyphInputProps) {
  const display = decodeCodepoint(props.value);
  return (
    <input
      type="text"
      className={props.className}
      value={display}
      // Take the LAST character typed so the user can overwrite without
      // clearing first ("type x to replace y"); ignore leading carry-over.
      onChange={e => {
        const v = e.target.value;
        if (v.length === 0) { props.onChange('0'); return; }
        const codepoints = Array.from(v);
        const ch = codepoints[codepoints.length - 1] ?? '';
        props.onChange(encodeFirstCodepoint(ch));
      }}
      onMouseDown={props.onMouseDown}
      onClick={props.onClick}
      title={GLYPH_PICKER_TITLE}
      placeholder="·"
      style={{ textAlign: 'center', ...props.style }}
    />
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
