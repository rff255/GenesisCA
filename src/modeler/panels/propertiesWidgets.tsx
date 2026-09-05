import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { PanelId } from '../ActivityBar';
import styles from './PanelContent.module.css';

/**
 * The shared primitives every Properties tab body is built from — see
 * docs/PLAN_PROPERTIES_PANEL_REFACTOR.md §E. The density doctrine (from the
 * capture popover): a control is a label + a control + at most ONE short muted
 * line; the long explanation lives in a `title`; binary / small-enumeration
 * choices are SEGMENTS, not radios with paragraphs; rows never reflow.
 *
 * Also home to the two things the tabs share with other panels — the
 * `genesis-open-modeler-panel` window event (the palette notice + the
 * Variegated card's "Open panel" link use it) and the sub-tab vocabulary.
 */

// --- The four sub-tabs -------------------------------------------------------
export type PropertiesTab = 'setup' | 'execution' | 'agents' | 'diagnostics';
export const PROPERTIES_TABS: PropertiesTab[] = ['setup', 'execution', 'agents', 'diagnostics'];
export const PROPERTIES_TAB_LABEL: Record<PropertiesTab, string> = {
  setup: 'Setup', execution: 'Execution', agents: 'Agents', diagnostics: 'Diagnostics',
};
export const PROPERTIES_TAB_TITLE: Record<PropertiesTab, string> = {
  setup: 'What this model is — its layers, grid and extensions. The switches here decide which graphs, panels and nodes exist.',
  execution: 'How it runs — reproducibility, engines, update modes and performance options.',
  agents: 'How agents behave — capability profile, population, motion and bonding physics.',
  diagnostics: 'What will actually run — read-only readouts computed from the same checks the compilers enforce.',
};

/** Open a named left panel (and, for Properties, a sub-tab) from anywhere —
 *  ModelerView listens. Additive: nothing else has to know about panel state. */
export const OPEN_MODELER_PANEL_EVENT = 'genesis-open-modeler-panel';
export interface OpenModelerPanelDetail { panel: PanelId; propertiesTab?: PropertiesTab }
export function openModelerPanel(panel: PanelId, propertiesTab?: PropertiesTab): void {
  window.dispatchEvent(new CustomEvent<OpenModelerPanelDetail>(OPEN_MODELER_PANEL_EVENT, {
    detail: { panel, propertiesTab },
  }));
}

export function SubTabs({ value, tabs, onChange }: {
  value: PropertiesTab;
  tabs: PropertiesTab[];
  onChange: (t: PropertiesTab) => void;
}) {
  return (
    <div className={styles.subTabs} role="tablist" aria-label="Properties sections">
      {tabs.map(t => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={value === t}
          className={`${styles.subTab} ${value === t ? styles.subTabActive : ''} ${t === 'agents' ? styles.subTabAgents : ''}`}
          title={PROPERTIES_TAB_TITLE[t]}
          onClick={() => onChange(t)}
        >{PROPERTIES_TAB_LABEL[t]}</button>
      ))}
    </div>
  );
}

// --- Collapsible section -----------------------------------------------------
// Collapsed bodies stay MOUNTED (display: none) — a controlled master-detail
// child (the Indicators list) keeps its selection/effects. The collapsed set
// persists in localStorage, keyed by stable section ids (the SAME key the
// pre-refactor panel used, so a user's collapse choices carry over).
const COLLAPSE_LS_KEY = 'genesisca_properties_collapsed';
function readCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function writeCollapsed(id: string, collapsed: boolean) {
  try {
    const s = readCollapsedSet();
    if (collapsed) s.add(id); else s.delete(id);
    localStorage.setItem(COLLAPSE_LS_KEY, JSON.stringify([...s]));
  } catch { /* storage unavailable — session-only collapse */ }
}

export function Section({ id, title, bare = false, action, children }: {
  id: string;
  title: string;
  /** bare: no own `.section` wrapper — the child brings its own section chrome. */
  bare?: boolean;
  /** Optional right-aligned control in the title row (the Copy buttons on the
   *  read-only readouts). It sits INSIDE the click-to-toggle header, so the
   *  control's own onClick must stopPropagation — see CopyButton. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readCollapsedSet().has(id));
  const toggle = () => setCollapsed(c => { writeCollapsed(id, !c); return !c; });
  const titleRow = (
    <div
      className={`${styles.sectionTitle} ${styles.sectionTitleCollapsible}`}
      onClick={toggle}
      title={collapsed ? 'Expand section' : 'Collapse section'}
    >
      <span className={styles.sectionChevron} style={collapsed ? { transform: 'rotate(-90deg)' } : undefined}>▾</span>
      {title}
      {action}
    </div>
  );
  const body = <div style={collapsed ? { display: 'none' } : undefined}>{children}</div>;
  if (bare) return <>{titleRow}{body}</>;
  return <div className={styles.section}>{titleRow}{body}</div>;
}

// --- Copy-to-clipboard action -------------------------------------------------
// The Compatibility / Generation Pipeline readouts are the two things users
// paste into bug reports and chats. Each gets a Copy button that renders the
// WHOLE section as clean plain text FROM THE SAME DATA the components render
// (never by scraping the DOM — a DOM scrape would drift the moment a chip
// moves). `getText` is called ONLY on click, so the (macro-aware, gate-calling)
// model derivations cost nothing per render.
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function CopyButton({ getText, title }: { getText: () => string; title: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const flash = (s: 'ok' | 'fail') => {
    setState(s);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setState('idle'); timer.current = null; }, 1500);
  };
  const onClick = (e: ReactMouseEvent) => {
    // The title row toggles the section — this button must not collapse it.
    e.stopPropagation();
    const text = getText();
    // navigator.clipboard needs a secure context (localhost counts); the
    // textarea+execCommand fallback covers a plain-http LAN preview.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => flash('ok'), () => flash(legacyCopy(text) ? 'ok' : 'fail'));
    } else {
      flash(legacyCopy(text) ? 'ok' : 'fail');
    }
  };
  const cls = state === 'ok' ? styles.sectionActionDone : state === 'fail' ? styles.sectionActionFail : '';
  return (
    <button
      type="button"
      className={`${styles.sectionAction} ${cls}`}
      onClick={onClick}
      title={state === 'fail' ? 'Copy failed — select the text and copy manually' : title}
    >{state === 'ok' ? '✓ Copied' : state === 'fail' ? '✗ Failed' : '⧉ Copy'}</button>
  );
}

// --- Segmented control --------------------------------------------------------
export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** What THIS choice does — the option's own tooltip. */
  title?: string;
  /** Disabled in place, with the reason as its tooltip (the row wrapper also
   *  carries it, because a browser fires no mouse events on a disabled button). */
  disabled?: boolean;
  disabledReason?: string;
}
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  const disabledReason = options.find(o => o.disabled && o.disabledReason)?.disabledReason;
  return (
    <div className={styles.seg} role="radiogroup" aria-label={ariaLabel} title={disabledReason}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`${styles.segBtn} ${value === o.value ? styles.segBtnOn : ''}`}
          disabled={o.disabled}
          title={o.disabled ? o.disabledReason ?? o.title : o.title}
          onClick={() => { if (!o.disabled && value !== o.value) onChange(o.value); }}
        >{o.label}</button>
      ))}
    </div>
  );
}

// --- Rows ---------------------------------------------------------------------
/** A labelled field: label above, control below, the long explanation on the
 *  wrapper's `title` (so a disabled control still explains itself). */
export function Field({ label, title, children, disabled }: {
  label: string; title?: string; children: ReactNode; disabled?: boolean;
}) {
  return (
    <div className={styles.field} title={title} style={disabled ? { opacity: 0.5 } : undefined}>
      <label className={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

/** Label on the left, a fixed-width control on the right — the shape every
 *  numeric agent parameter takes. `title` carries the full explanation. */
export function FieldRow({ label, title, children, muted }: {
  label: string; title?: string; children: ReactNode; muted?: boolean;
}) {
  return (
    <div className={styles.rowSplit} title={title}>
      <span className={`${styles.rowLabel} ${muted ? styles.rowLabelMuted : ''}`}>{label}</span>
      {children}
    </div>
  );
}

/** The one muted line under a control. */
export function Hint({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <div className={`${styles.oneLine} ${warn ? styles.oneLineWarn : ''}`}>{children}</div>;
}

/** Uppercase mini heading inside a section. */
export function SubLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className={styles.subLabel}><span>{children}</span>{right}</div>;
}

/** A checkbox row — label + one tooltip, no paragraph. */
export function CheckRow({ checked, onChange, label, title, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; title?: string; disabled?: boolean;
}) {
  return (
    <label className={styles.checkboxRow} title={title} style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// --- Cards --------------------------------------------------------------------
/** A layer / extension / master toggle with its own config body. The header
 *  toggles; `unlocks` names what the switch turns on elsewhere in the app. */
export function ToggleCard({ title, on, onChange, line, unlocks, disabled, disabledReason, children }: {
  title: string;
  on: boolean;
  onChange: (on: boolean) => void;
  /** One short muted line under the title. */
  line?: ReactNode;
  /** "Unlocks:" — graphs, panels, node families. */
  unlocks?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  /** Config revealed while the card is on. */
  children?: ReactNode;
}) {
  const toggle = () => { if (!disabled) onChange(!on); };
  return (
    <div
      className={`${styles.card} ${on ? styles.cardOn : ''} ${disabled ? styles.cardDisabled : ''}`}
      title={disabled ? disabledReason : undefined}
    >
      <div className={styles.cardHead} onClick={toggle}>
        <input
          type="checkbox"
          className={styles.switch}
          checked={on}
          disabled={disabled}
          onClick={e => e.stopPropagation()}
          onChange={e => { if (!disabled) onChange(e.target.checked); }}
          aria-label={title}
        />
        <span className={styles.cardTitle}>{title}</span>
      </div>
      {line && <div className={styles.cardLine}>{line}</div>}
      {unlocks && <div className={styles.cardUnlocks}><b>Unlocks:</b> {unlocks}</div>}
      {on && children && <div className={styles.cardBody} onClick={e => e.stopPropagation()}>{children}</div>}
    </div>
  );
}

// --- Advanced reveal ----------------------------------------------------------
export function Advanced({ open, onToggle, title, children }: {
  open: boolean; onToggle: () => void; title?: string; children: ReactNode;
}) {
  return (
    <div>
      <button type="button" className={styles.advToggle} onClick={onToggle} title={title}>
        <span>{open ? '▾' : '▸'}</span> Advanced
      </button>
      {open && <div className={styles.advBody}>{children}</div>}
    </div>
  );
}

// --- Badges + callouts --------------------------------------------------------
export function Badge({ kind, title, children }: { kind: 'ok' | 'warn' | 'info'; title?: string; children: ReactNode }) {
  const cls = kind === 'ok' ? styles.badgeOk : kind === 'warn' ? styles.badgeWarn : styles.badgeInfo;
  return <span className={`${styles.badge} ${cls}`} title={title}>{children}</span>;
}

export function Callout({ kind, children }: { kind: 'ok' | 'warn' | 'info'; children: ReactNode }) {
  const cls = kind === 'ok' ? styles.calloutOk : kind === 'warn' ? styles.calloutWarn : styles.calloutInfo;
  return <div className={`${styles.callout} ${cls}`}>{children}</div>;
}

export function LinkButton({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  return <button type="button" className={styles.linkBtn} onClick={onClick} title={title}>{children}</button>;
}
