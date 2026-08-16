import { useModel } from '../../model/ModelContext';
import type {
  BoundaryTreatment, UpdateMode, AsyncScheme, CAModel,
  EndConditions, EndConditionOp, IndicatorEndCondition,
  SkipIsolatedEmptyConfig, EngineChoice, EngineId, ReproducibilityContract,
} from '../../model/types';
import {
  REPRODUCIBILITY_LABEL, REPRODUCIBILITY_SUMMARY, REPRODUCIBILITY_GUARDRAIL,
} from '../../model/reproducibility';
import {
  diagnoseTargets, ENGINE_LABEL, REASON_CLASS_TAG, REASON_CLASS_TITLE,
  type Reason, type ReasonClass,
} from '../../model/targetDiagnosis';
import {
  describeGenerationPipeline, describePipelineGroups, TEMPO_LABEL, TEMPO_TITLE,
  type PipelinePhase, type PhaseTempo,
} from '../../model/generationPipeline';
import {
  analyzeGeometryTaint, PRESENTATION_ONLY_LABEL, PRESENTATION_ONLY_EXPLAINER,
  GEOMETRY_PROMOTED_EXPLAINER,
} from '../vpl/compiler/geometryTaint';
import { IndicatorsPanelSection } from './IndicatorsPanelSection';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import { useListReorder } from './useListReorder';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import { cbNum, usesBondingPhysics, resolveMaxBonds, effectiveAgentDt, BOND_REQUEST_DEPTH_MAX, CENTER_BASED_DEFAULTS } from '../../model/centerBased';
import type { CenterBasedNumericKey } from '../../model/centerBased';
import { isAgentGraphWasmSupported } from '../vpl/compiler/agentWasm/compile';
import { isAgentGraphWebGPUSupported } from '../vpl/compiler/agentWebgpu/compile';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import { resolveEngines, engineFlags, type LayerResolution } from '../../model/engineResolution';
import { resolveAgentProfile, applyCapabilityEdit } from '../../model/agentCapabilities';
import { isGraphFrequencyMetric, type GraphMetric } from '../../simulator/engine/graphMetrics';
import styles from './PanelContent.module.css';
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

function newCondId(): string {
  return `ec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** The NEUTRAL georeference — cell (0,0)'s lower-left corner at the world origin,
 *  one world unit per cell. It is the base every Georeference field edit spreads
 *  over, so typing ONE number into an absent georef yields a COMPLETE record
 *  instead of a partial one (`GeoReference`'s three numbers are all required).
 *  Deliberately the same fallback `buildAscGrid` writes with no georef stored. */
const defaultGeoref = { xllcorner: 0, yllcorner: 0, cellSize: 1 } as const;

// --- Collapsible section wrapper -------------------------------------------
// Each top-level Properties section collapses via its title row (chevron).
// Collapsed bodies stay MOUNTED (display: none) — the Indicators list is a
// controlled master-detail child whose selection/effects must not reset.
// The collapsed set persists in localStorage, keyed by stable section ids.
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
function CollapsibleSection({ id, title, bare = false, action, children }: {
  id: string;
  title: string;
  /** bare: no own `.section` wrapper — the child brings its own section chrome
   *  (the IndicatorsPanelSection case, with its internal title suppressed). */
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

// --- Copy-to-clipboard action -----------------------------------------------
// The Compatibility / Generation Pipeline readouts are the two things users
// paste into bug reports and chats. Their text was always SELECTABLE (the only
// `user-select: none` in this panel is on the click-to-toggle section titles),
// but hand-dragging a selection over them yields a jumbled string: the content
// is a dense stack of flex rows whose ✓/✗ marks, S/R/F/C class tags, tempo
// chips and row indices interleave with the prose, in a ~300px column that has
// to autoscroll. So each section also gets a Copy button that renders the WHOLE
// section as clean plain text FROM THE SAME DATA the components render (never
// by scraping the DOM — a DOM scrape would drift the moment a chip moves).
//
// `getText` is called ONLY on click, so the (macro-aware, gate-calling) model
// derivations cost nothing per render — no second useMemo beside the block's.
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

function CopyButton({ getText, title }: { getText: () => string; title: string }) {
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

// --- C4 (P1) — the ENGINE radio ---------------------------------------------
// One control per layer: an INTENT (`Auto`) or an engine. Auto shows what it
// resolved to and why, so the pick is never silent. JS is demoted behind an
// "Advanced" reveal — it is the readable semantic reference (and the fallback
// engine), not a production choice.
const ENGINE_LABEL_SHORT: Record<EngineId, string> = { js: 'JS', wasm: 'WebAssembly', webgpu: 'WebGPU' };

// --- C5 (P10) — the declared REPRODUCIBILITY CONTRACT ------------------------
// Placed at the TOP of Execution because it now GOVERNS the Engine radios below:
// `Auto` reads as "the fastest engine that satisfies this contract". A violation
// (an explicit engine the contract cannot cover) shows amber right here rather
// than only in the Compatibility readout further down.
const CONTRACT_ORDER: ReproducibilityContract[] = ['exact', 'statistical'];

function ReproducibilityRadio({ contract, violation, onSelect }: {
  contract: ReproducibilityContract;
  violation: string | null;
  onSelect: (c: ReproducibilityContract) => void;
}) {
  return (
    <div className={styles.field}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <label className={styles.fieldLabel} style={{ margin: 0 }}>Reproducibility</label>
        <span style={{
          fontSize: '0.58rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9, whiteSpace: 'nowrap',
          border: `1px solid ${contract === 'exact' ? 'rgba(92,191,122,.45)' : 'rgba(90,169,224,.45)'}`,
          background: contract === 'exact' ? 'rgba(92,191,122,.13)' : 'rgba(90,169,224,.13)',
          color: contract === 'exact' ? '#5cbf7a' : '#5aa9e0',
        }}>{REPRODUCIBILITY_LABEL[contract]}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        {CONTRACT_ORDER.map(c => (
          <label key={c} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
            <input
              type="radio"
              name="reproducibility"
              checked={contract === c}
              onChange={() => onSelect(c)}
              style={{ marginTop: 2 }}
            />
            <span>
              <strong>{REPRODUCIBILITY_LABEL[c]}</strong>
              <br />
              <span style={{ color: '#888', fontSize: '0.66rem' }}>{REPRODUCIBILITY_SUMMARY[c]}</span>
            </span>
          </label>
        ))}
      </div>
      <span style={{ color: '#777', fontSize: '0.62rem', fontStyle: 'italic', display: 'block', marginTop: 5 }}>
        {REPRODUCIBILITY_GUARDRAIL}
      </span>
      {violation && (
        <div style={{
          fontSize: '0.62rem', color: '#e8c08a', background: 'rgba(224,160,80,.09)',
          border: '1px solid rgba(224,160,80,.4)', borderRadius: 5, padding: '5px 8px', marginTop: 6,
        }}>⚠ {violation}</div>
      )}
    </div>
  );
}

function EngineRadio({ name, label, labelColor, res, onSelect, hints, webgpuTag, footer }: {
  /** Radio group name — must differ between the grid and agent radios. */
  name: string;
  label: string;
  labelColor?: string;
  res: LayerResolution;
  onSelect: (choice: EngineChoice) => void;
  /** Per-engine descriptions (live, so they can reflect this model's gates). */
  hints: Record<EngineChoice, string>;
  /** Small tag next to WebGPU. The GRID's WebGPU engine is synchronous-only;
   *  the AGENT one is not (it runs async agent models), so the tag is per-radio. */
  webgpuTag?: string;
  footer?: ReactNode;
}) {
  // Manual toggle, but ALWAYS open when JS is the current selection — otherwise
  // the selected option would be hidden inside a collapsed reveal.
  const [advOpenState, setAdvOpen] = useState(false);
  const advOpen = advOpenState || res.selected === 'js';
  const demoted = res.resolved !== res.requested;
  const badge = res.auto
    ? { text: `Auto → ${ENGINE_LABEL_SHORT[res.resolved]}`, amber: false }
    : demoted
      ? { text: `${ENGINE_LABEL_SHORT[res.requested]} → running ${ENGINE_LABEL_SHORT[res.resolved]}`, amber: true }
      : null;
  const Option = ({ value, title, tag }: { value: EngineChoice; title: string; tag?: string }) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
      <input
        type="radio"
        name={name}
        checked={res.selected === value}
        onChange={() => onSelect(value)}
        style={{ marginTop: 2 }}
      />
      <span>
        <strong>{title}</strong>
        {tag && <span style={{ marginLeft: 5, fontSize: '0.56rem', color: '#888', border: '1px solid #3a3f49', borderRadius: 3, padding: '0 4px' }}>{tag}</span>}
        <br />
        <span style={{ color: '#888', fontSize: '0.66rem' }}>{hints[value]}</span>
      </span>
    </label>
  );
  return (
    <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <label className={styles.fieldLabel} style={{ margin: 0, color: labelColor }}>{label}</label>
        {badge && (
          <span
            title={res.reason || undefined}
            style={{
              fontSize: '0.58rem', fontWeight: 700, padding: '1px 6px', borderRadius: 9,
              border: `1px solid ${badge.amber ? 'rgba(224,160,80,.45)' : 'rgba(92,191,122,.45)'}`,
              background: badge.amber ? 'rgba(224,160,80,.13)' : 'rgba(92,191,122,.13)',
              color: badge.amber ? '#e0a050' : '#5cbf7a', whiteSpace: 'nowrap',
            }}
          >{badge.text}</span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
        <Option value="auto" title="Auto" tag="recommended" />
        {res.reason && (
          <div style={{
            fontSize: '0.62rem', color: '#9aa3b2', background: '#1b1e25',
            border: '1px solid #22262e', borderLeft: `2px solid ${demoted ? '#e0a050' : '#5cbf7a'}`,
            borderRadius: '0 4px 4px 0', padding: '4px 7px', margin: '-2px 0 2px 19px',
          }}>{res.reason}</div>
        )}
        <Option value="wasm" title="WebAssembly" />
        <Option value="webgpu" title="WebGPU" tag={webgpuTag} />
        <div style={{ marginTop: 4, borderTop: '1px dashed #2f343d', paddingTop: 7 }}>
          <span
            onClick={() => setAdvOpen(o => !o)}
            style={{ fontSize: '0.62rem', color: '#888', cursor: 'pointer', userSelect: 'none' }}
            title="Engines for debugging, not for running models"
          >{advOpen ? '▾' : '▸'} Advanced</span>
          {advOpen && (
            <div style={{ marginTop: 7, paddingLeft: 9, borderLeft: '1px solid #22262e' }}>
              <Option value="js" title="Debug / Reference (JS)" />
            </div>
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}

// --- C1 (P2) — Target Compatibility readout ---------------------------------
// Which engines this model can use, per layer, and WHY not the others. Every
// verdict comes from `diagnoseTargets`, which calls the REAL gates — so this can
// never drift from what the engine does. Read-only: it explains the radios
// above, it never blocks a choice.
const REASON_CLASS_COLOR: Record<ReasonClass, string> = {
  semantics: '#e0605a', reproducibility: '#5aa9e0', fastpath: '#8a8f99', capacity: '#e0a050',
};

function ReasonLine({ reason }: { reason: Reason }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: '0.62rem', color: '#b9bdc5' }}>
      <span
        title={REASON_CLASS_TITLE[reason.class]}
        style={{
          flex: '0 0 auto', fontSize: '0.54rem', fontWeight: 700, lineHeight: 1.35, marginTop: 1,
          padding: '0 3px', borderRadius: 3, border: `1px solid ${REASON_CLASS_COLOR[reason.class]}`,
          color: REASON_CLASS_COLOR[reason.class],
        }}
      >{REASON_CLASS_TAG[reason.class]}</span>
      <span>{reason.text}</span>
    </div>
  );
}

const COMPAT_LEGEND =
  'Legend: S semantics (the engine cannot express it) · R reproducibility (runs, not bit-reproducibly) · '
  + 'F fast path (same results, different speed) · C capacity (a limit with a number).';

/** The Compatibility section as clean plain text — the copy-button counterpart
 *  of `CompatibilityBlock`, built from the SAME `diagnoseTargets` /
 *  `analyzeGeometryTaint` results (kept directly beside it so a change to one
 *  is a change under the other's nose). Called on click only. */
function compatibilityToText(model: CAModel): string {
  const diagnosis = diagnoseTargets(model);
  const out: string[] = [];
  out.push(`Compatibility — ${model.properties.name || 'Untitled Model'}`);
  out.push(`Reproducibility contract: ${REPRODUCIBILITY_LABEL[diagnosis.contract]}`);
  for (const layer of diagnosis.layers) {
    out.push('');
    const status = layer.requested === layer.resolved
      ? `${layer.selected === 'auto' ? 'Auto → ' : ''}running ${ENGINE_LABEL[layer.resolved]}`
      : `requested ${ENGINE_LABEL[layer.requested]} → running ${ENGINE_LABEL[layer.resolved]}`;
    out.push(`${layer.label.toUpperCase()} — ${status}`);
    for (const v of layer.verdicts) {
      out.push(`  ${v.ok ? '✓' : '✗'} ${ENGINE_LABEL[v.engine]}${v.engine === layer.resolved ? '  (running)' : ''}`);
      for (const r of [...v.blockers, ...v.notes]) {
        out.push(`      [${REASON_CLASS_TAG[r.class]}] ${r.text}`);
      }
    }
    if (layer.contractViolation) out.push(`  ⚠ Contract: ${layer.contractViolation.text}`);
  }
  const taint = analyzeGeometryTaint(model);
  if (taint.applicable) {
    out.push('');
    out.push(`${taint.presentational ? 'Layout is presentation' : 'Layout is part of your rule'} — `
      + (taint.presentational ? PRESENTATION_ONLY_EXPLAINER : GEOMETRY_PROMOTED_EXPLAINER));
    if (!taint.presentational && taint.witness) out.push(`  e.g. ${taint.witness.summary}`);
  }
  out.push('');
  out.push(COMPAT_LEGEND);
  out.push('Computed from the same checks the compilers enforce.');
  return out.join('\n');
}

function CompatibilityBlock({ model }: { model: CAModel }) {
  // The agent gates flatten the agent graph, so memoise on the model.
  const diagnosis = useMemo(() => diagnoseTargets(model), [model]);
  if (diagnosis.layers.length === 0) return null;
  return (
    <div className={`${styles.fieldGroup} ${styles.selectableText}`}>
      {diagnosis.layers.map(layer => (
        <div key={layer.layer} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: '0.6rem', color: '#b58fd6', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{layer.label}</span>
            {/* C5 — the declared contract, right where the engine outcome is
                stated: these two lines are one sentence ("Exact, running WASM"). */}
            <span style={{
              marginRight: 'auto', fontSize: '0.54rem', fontWeight: 700, padding: '0 5px', borderRadius: 8,
              border: `1px solid ${diagnosis.contract === 'exact' ? 'rgba(92,191,122,.4)' : 'rgba(90,169,224,.4)'}`,
              color: diagnosis.contract === 'exact' ? '#5cbf7a' : '#5aa9e0', whiteSpace: 'nowrap',
            }} title="The model's declared reproducibility contract (Properties → Execution).">
              {REPRODUCIBILITY_LABEL[diagnosis.contract]}
            </span>
            <span style={{ fontSize: '0.62rem', color: layer.demotionReason ? '#e0a050' : '#888' }}>
              {/* C4 — name the SELECTION as well as the outcome, so "Auto" is
                  never mistaken for an engine of its own. */}
              {layer.requested === layer.resolved
                ? <>{layer.selected === 'auto' && <span style={{ color: '#5cbf7a' }}>Auto → </span>}running <b style={{ color: '#ddd' }}>{ENGINE_LABEL[layer.resolved]}</b></>
                : <>requested <b>{ENGINE_LABEL[layer.requested]}</b> → running <b>{ENGINE_LABEL[layer.resolved]}</b></>}
            </span>
          </div>
          {layer.verdicts.map(v => (
            <div key={v.engine} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', padding: '4px 0', borderTop: '1px solid #22252c' }}>
              <span style={{ flex: '0 0 12px', textAlign: 'center', fontWeight: 700, fontSize: '0.72rem', lineHeight: 1.5, color: v.ok ? '#5cc27a' : '#e0605a' }}>
                {v.ok ? '✓' : '✗'}
              </span>
              <span style={{ flex: '0 0 92px', fontSize: '0.66rem', color: '#ddd' }}>
                {ENGINE_LABEL[v.engine]}
                {v.engine === layer.resolved && <span style={{ display: 'block', color: '#888', fontSize: '0.58rem' }}>running</span>}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {v.blockers.map((r, i) => <ReasonLine key={`b${i}`} reason={r} />)}
                {v.notes.map((r, i) => <ReasonLine key={`n${i}`} reason={r} />)}
              </span>
            </div>
          ))}
          {/* C5 — the layer-level amber line: the engine that IS running cannot
              honour the declared contract. Never a blocker (it runs) — a
              mismatch between what the model claims and what it delivers. */}
          {layer.contractViolation && (
            <div style={{
              marginTop: 5, fontSize: '0.62rem', color: '#e8c08a', background: 'rgba(224,160,80,.09)',
              border: '1px solid rgba(224,160,80,.4)', borderRadius: 5, padding: '5px 8px',
            }}>⚠ <b>Contract:</b> {layer.contractViolation.text}</div>
          )}
        </div>
      ))}
      <GeometryTaintNote model={model} />
      <span style={{ color: '#777', fontSize: '0.58rem', display: 'block', fontStyle: 'italic', borderTop: '1px solid #22252c', paddingTop: 6 }}>
        <b>S</b> semantics (the engine cannot express it) · <b>R</b> reproducibility (runs, not bit-reproducibly) ·
        {' '}<b>F</b> fast path (same results, different speed) · <b>C</b> capacity (a limit with a number).
        Computed from the same checks the compilers enforce. See Help → Bond-Graph Agents → Engine compatibility.
      </span>
    </div>
  );
}

// --- C8 (P9) — is the layout presentation, or part of the rule? -------------
// Deliberately NOT styled as a warning in either state. P9 is a GRANT OF
// FREEDOMS: reading a position is a PROMOTION (the layout physics become part of
// what the simulation computes), not a defect. So the presentational case is
// green + informative and the promoted case is plain grey with its witness.
function GeometryTaintNote({ model }: { model: CAModel }) {
  // The analyzer flattens the agent graph (macros + reroutes), so memoise it on
  // the model exactly like the gates above.
  const taint = useMemo(() => analyzeGeometryTaint(model), [model]);
  if (!taint.applicable) return null;
  const good = taint.presentational;
  return (
    <div style={{
      marginTop: 4, marginBottom: 8, fontSize: '0.62rem', borderRadius: 5, padding: '5px 8px',
      color: good ? '#a8d8b4' : '#b9bdc5',
      background: good ? 'rgba(92,191,122,.08)' : 'rgba(255,255,255,.03)',
      border: `1px solid ${good ? 'rgba(92,191,122,.35)' : '#2a2e36'}`,
    }}>
      <b style={{ color: good ? '#5cbf7a' : '#dfe2e8' }}>
        {good ? 'Layout is presentation' : 'Layout is part of your rule'}
      </b>{' — '}
      {good ? PRESENTATION_ONLY_EXPLAINER : GEOMETRY_PROMOTED_EXPLAINER}
      {!good && taint.witness && (
        <span style={{ display: 'block', marginTop: 3, color: '#8a8f99' }}>
          e.g. <span style={{ color: '#aeb3bc' }}>{taint.witness.summary}</span>
        </span>
      )}
    </div>
  );
}

// --- C2 (P3) — the Generation Pipeline readout ------------------------------
// The ordered, read-only answer to "what happens each generation for THIS
// model?". Owner attribution (your graph vs the engine) is the point, so it is
// carried by a coloured left rail; the tempo chip answers "is this the hot
// path?"; inactive phases stay VISIBLE, struck, naming the capability that
// turns them on (seeing that bond springs exist and are off IS the clarity
// win). Every bit of it comes from `describeGenerationPipeline`, which reads
// the engine's own resolvers — see that module's header.
const TEMPO_STYLE: Record<PhaseTempo, { color: string; border: string; bg: string }> = {
  generation: { color: '#9fd4a8', border: '#38553f', bg: '#16211a' },
  event: { color: '#d7b98a', border: '#5a482c', bg: '#201c14' },
  frame: { color: '#93c2e8', border: '#2f4a63', bg: '#131c25' },
  reset: { color: '#c4a9de', border: '#4b3a5e', bg: '#1c1723' },
};

function TempoChip({ tempo }: { tempo: PhaseTempo }) {
  const s = TEMPO_STYLE[tempo];
  return (
    <span
      title={TEMPO_TITLE[tempo]}
      style={{
        flex: '0 0 auto', fontSize: '0.5rem', letterSpacing: '0.03em', lineHeight: 1.6,
        padding: '0 4px', borderRadius: 3, whiteSpace: 'nowrap', textTransform: 'uppercase',
        color: s.color, border: `1px solid ${s.border}`, background: s.bg,
      }}
    >{TEMPO_LABEL[tempo]}</span>
  );
}

function PhaseRow({ phase, index }: { phase: PipelinePhase; index: number }) {
  const isGraph = phase.owner === 'graph';
  const off = !phase.active;
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'stretch', padding: '3px 0', opacity: off ? 0.62 : 1 }}>
      <span
        title={isGraph ? 'Your graph' : 'The engine'}
        style={{ flex: '0 0 3px', borderRadius: 2, background: isGraph ? '#e8a13a' : '#6b7280' }}
      />
      <span style={{ flex: '0 0 15px', textAlign: 'right', color: '#6a6f78', fontSize: '0.52rem', lineHeight: 1.9, fontVariantNumeric: 'tabular-nums' }}>
        {index}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{
            fontSize: '0.64rem',
            color: off ? '#6a6f78' : (isGraph ? '#e8a13a' : '#dfe2e8'),
            fontWeight: isGraph ? 600 : 400,
            textDecoration: off ? 'line-through' : undefined,
          }}>{phase.title}</span>
          {/* C8 (P9) — this phase only decides WHERE things sit. */}
          {phase.presentation && (
            <span
              title={PRESENTATION_ONLY_EXPLAINER}
              style={{
                flex: '0 0 auto', marginLeft: 'auto', fontSize: '0.5rem', letterSpacing: '0.03em',
                lineHeight: 1.6, padding: '0 4px', borderRadius: 3, whiteSpace: 'nowrap',
                textTransform: 'uppercase', color: '#8fd6a4', border: '1px solid #35553d', background: '#14201a',
              }}
            >presentation</span>
          )}
          <TempoChip tempo={phase.tempo} />
        </span>
        {off
          ? <span style={{ display: 'block', fontSize: '0.56rem', color: '#a8746e', marginTop: 1 }}>off — needs {phase.capability}</span>
          : phase.detail && <span style={{ display: 'block', fontSize: '0.56rem', color: '#8a8f99', marginTop: 1 }}>{phase.detail}</span>}
        {phase.presentation && (
          <span style={{ display: 'block', fontSize: '0.56rem', color: '#7fae8c', fontStyle: 'italic', marginTop: 1 }}>
            {PRESENTATION_ONLY_LABEL}
          </span>
        )}
      </span>
    </div>
  );
}

/** The Generation Pipeline section as clean plain text — the copy-button
 *  counterpart of `GenerationPipelineBlock`, built from the SAME
 *  `describeGenerationPipeline` / `describePipelineGroups` results. Grouped
 *  phases keep their bracket as a header line + an extra indent, so the force
 *  loop still reads as a loop. Called on click only. */
function pipelineToText(model: CAModel): string {
  const phases = describeGenerationPipeline(model);
  const groups = describePipelineGroups(model);
  const out: string[] = [];
  out.push(`Generation Pipeline — ${model.properties.name || 'Untitled Model'}`);
  out.push('Legend: [graph] = your graph · [engine] = the engine · "off — needs X" = inactive for this model.');
  out.push('');
  let lastGroup: string | undefined;
  let n = 0;
  let anyPresentation = false;
  for (const p of phases) {
    if (p.group !== lastGroup) {
      if (p.group) {
        const g = groups[p.group];
        out.push(`  -- ${g?.title ?? p.group}${g?.detail ? ` (${g.detail})` : ''} --`);
      }
      lastGroup = p.group;
    }
    const pad = p.group ? '    ' : '  ';
    const tags = `(${TEMPO_LABEL[p.tempo]})${p.presentation ? '  [presentation]' : ''}`;
    if (p.presentation) anyPresentation = true;
    out.push(`${pad}${String(++n).padStart(2, ' ')}. ${p.owner === 'graph' ? '[graph] ' : '[engine]'} ${p.title}  ${tags}`);
    if (!p.active) out.push(`${pad}      off — needs ${p.capability ?? 'a capability'}`);
    else if (p.detail) out.push(`${pad}      ${p.detail}`);
  }
  out.push('');
  if (anyPresentation) out.push(`[presentation] = ${PRESENTATION_ONLY_LABEL}. ${PRESENTATION_ONLY_EXPLAINER}`);
  out.push('Order and activity come from the same resolvers the engine consults, so this list cannot drift from what runs.');
  return out.join('\n');
}

function GenerationPipelineBlock({ model }: { model: CAModel }) {
  // Both are pure model derivations; the phase walk is macro-aware, so memoise.
  const phases = useMemo(() => describeGenerationPipeline(model), [model]);
  const groups = useMemo(() => describePipelineGroups(model), [model]);
  if (phases.length === 0) return null;
  const anyPresentation = phases.some(p => p.presentation);

  // Render consecutive same-group phases inside one bracket.
  const blocks: Array<{ group?: string; phases: PipelinePhase[] }> = [];
  for (const p of phases) {
    const last = blocks[blocks.length - 1];
    if (last && last.group === p.group) last.phases.push(p);
    else blocks.push({ group: p.group, phases: [p] });
  }
  let n = 0;

  return (
    <div className={`${styles.fieldGroup} ${styles.selectableText}`}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.56rem', color: '#8a8f99', paddingBottom: 5, borderBottom: '1px solid #22252c', marginBottom: 3 }}>
        <span><i style={{ display: 'inline-block', width: 3, height: 10, borderRadius: 2, background: '#e8a13a', verticalAlign: -1, marginRight: 4 }} />your graph</span>
        <span><i style={{ display: 'inline-block', width: 3, height: 10, borderRadius: 2, background: '#6b7280', verticalAlign: -1, marginRight: 4 }} />engine</span>
        <span style={{ color: '#6a6f78' }}>struck = off for this model</span>
        {anyPresentation && <span style={{ color: '#8fd6a4' }}>presentation = decides only where things sit</span>}
      </div>

      {blocks.map((b, bi) => {
        const rows = b.phases.map(p => <PhaseRow key={p.id} phase={p} index={++n} />);
        if (!b.group) return <div key={bi}>{rows}</div>;
        const g = groups[b.group];
        return (
          <div key={bi} style={{ margin: '5px 0 4px 9px', paddingLeft: 8, borderLeft: '1px dashed #333842' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.56rem', color: '#8a8f99', padding: '1px 0 2px', letterSpacing: '0.03em' }}>
              <span>{g?.title ?? b.group}</span>
              {g?.detail && <b style={{ color: '#aeb3bc', fontWeight: 600 }}>{g.detail}</b>}
            </div>
            {rows}
          </div>
        );
      })}

      <span style={{ color: '#777', fontSize: '0.58rem', display: 'block', fontStyle: 'italic', borderTop: '1px solid #22252c', paddingTop: 6, marginTop: 6 }}>
        Order and activity come from the same resolvers the engine consults, so this list cannot
        drift from what runs. <b>Per frame</b> phases are amortized by Gens/Frame; <b>per event</b>
        {' '}phases run only when the event happens. Read-only — it explains the settings above.
      </span>
    </div>
  );
}

export function PropertiesPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const { model, updateProperties, reorderEndConditions, updateVariegatedCells, updateTopologyMode, updateCenterBased, updateOverseerConfig } = useModel();
  // Indicators are a master-detail sub-section: the list lives in this panel,
  // the selected indicator's editor opens in the shared second (detail) panel.
  // Selection rides Properties' single detail slot as an `indicator:<id>` key.
  const [indSel, setIndSel] = useDetailSelection('properties');
  const selIndId = indSel && indSel.startsWith('indicator:') ? indSel.slice(10) : null;
  const selectInd = (id: string | null) => setIndSel(id ? `indicator:${id}` : null);
  const { properties } = model;
  // 3D Grid CA / Bond-Graph Morphogenesis (M0a) mode state.
  const topo = model.topologyMode ?? { gridCells: true, agents: false };
  const is3d = (properties.dimension ?? '2d') === '3d';
  // C4 (P1) — the resolved engine per layer, from the ONE resolver. Everything
  // that used to key off the raw `useWebGPU` / `useWasm` mirror flags reads this
  // instead, so `engine: 'auto'` lights up the same UI an explicit pick does.
  const engines = useMemo(() => resolveEngines(model), [model]);
  const gridIsWebgpu = engines.grid.resolved === 'webgpu';
  const ecReorder = useListReorder(
    properties.endConditions?.indicatorConditions || [],
    reorderEndConditions,
  );

  const ec = properties.endConditions;
  const ecEnabled = !!ec?.enabled;
  const updateEndConditions = (changes: Partial<EndConditions>) => {
    updateProperties({
      endConditions: {
        enabled: ecEnabled,
        maxGenerations: ec?.maxGenerations,
        indicatorConditions: ec?.indicatorConditions,
        ...changes,
      },
    });
  };
  // Spatial indicators (xAxis rows/columns) produce per-position-bin arrays, not
  // a scalar/category count, so they can't drive a numeric end condition.
  const isSpatialIndicator = (i: { kind: string; xAxis?: string }) =>
    i.kind === 'linked' && (i.xAxis === 'rows' || i.xAxis === 'columns' || i.xAxis === 'layers');
  const addIndicatorCondition = () => {
    const firstIndicator = (model.indicators || []).find(i => !isSpatialIndicator(i));
    if (!firstIndicator) return;
    // For linked-frequency indicators, seed a sensible default category so the
    // condition is immediately valid (not every user knows they need one).
    let category: string | undefined;
    let value = firstIndicator.defaultValue ?? '0';
    if (firstIndicator.kind === 'graph'
        && isGraphFrequencyMetric((firstIndicator.graphMetric ?? 'nodeCount') as GraphMetric)) {
      // GRA P6 — the degree histogram's categories are degrees; seed 0.
      category = '0';
      value = '0';
    } else if (firstIndicator.kind === 'linked' && firstIndicator.linkedAggregation === 'frequency') {
      const linkedAttr = (model.attributes || []).find(a => a.id === firstIndicator.linkedAttributeId);
      if (linkedAttr?.type === 'bool') category = 'true';
      else if (linkedAttr?.type === 'tag') category = linkedAttr.tagOptions?.[0] ?? '';
      else if (linkedAttr?.type === 'integer') category = '0';
      // float: leave undefined — UI disables the row
      value = '0'; // frequency count
    }
    const cond: IndicatorEndCondition = {
      id: newCondId(),
      indicatorId: firstIndicator.id,
      op: '==',
      value,
      ...(category !== undefined ? { category } : {}),
    };
    updateEndConditions({ indicatorConditions: [...(ec?.indicatorConditions || []), cond] });
  };
  const updateIndicatorCondition = (id: string, changes: Partial<IndicatorEndCondition>) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).map(c =>
        c.id === id ? { ...c, ...changes } : c,
      ),
    });
  };
  const removeIndicatorCondition = (id: string) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).filter(c => c.id !== id),
    });
  };

  // Detail panel: render only the selected indicator's editor.
  if (mode === 'detail') {
    return <IndicatorsPanelSection mode="detail" selectedId={selIndId} onSelect={selectInd} />;
  }

  return (
    <div className={styles.fieldGroup}>
      <CollapsibleSection id="structure" title="Structure">
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Boundary Treatment</label>
            <select
              className={styles.selectInput}
              value={properties.boundaryTreatment}
              onChange={e =>
                updateProperties({
                  boundaryTreatment: e.target.value as BoundaryTreatment,
                })
              }
            >
              <option value="torus">Torus</option>
              <option value="constant">Constant</option>
            </select>
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Width</label>
              <NumberField
                className={styles.numberInput}
                value={properties.gridWidth}
                min={1}
                integer
                onNumber={n => updateProperties({ gridWidth: n })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Height</label>
              <NumberField
                className={styles.numberInput}
                value={properties.gridHeight}
                min={1}
                integer
                onNumber={n => updateProperties({ gridHeight: n })}
              />
            </div>
            {is3d && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Grid Depth</label>
                <NumberField
                  className={styles.numberInput}
                  value={properties.gridDepth ?? 1}
                  min={1}
                  integer
                  onNumber={n => updateProperties({ gridDepth: n })}
                />
              </div>
            )}
          </div>

          {/* Dimension — 2D lattice vs a W×H×D volume (3D Grid CA milestone). */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label className={styles.fieldLabel} style={{ marginBottom: 4 }}>Dimension</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="dimension"
                  value="2d"
                  checked={!is3d}
                  onChange={() => updateProperties({ dimension: '2d' })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>2D (W&times;H grid)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Classic flat lattice. Rendered with the 2D canvas.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="dimension"
                  value="3d"
                  checked={is3d}
                  onChange={() => {
                    // Variegated Cells is 2D-only — force it off when going 3D.
                    if (model.variegatedCells?.enabled) updateVariegatedCells({ enabled: false });
                    updateProperties({ dimension: '3d', gridDepth: properties.gridDepth ?? 1 });
                  }}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>3D (W&times;H&times;D volume)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Voxel grid with a layer (Z) axis, rendered with an orbit camera + clip plane. Variegated Cells (directional interactions) are unavailable in 3D.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {/* Georeference — where the board sits in the real world. Written by the
              Esri ASCII grid (.asc) import from the file's own header, read back by
              the .asc export, and used by the simulator's world-coordinate readout.
              PRESENTATION + I/O ONLY: no compiler, worker or engine reads it (the C8
              "presentational geometry" doctrine), so it is always editable. */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label className={styles.fieldLabel} style={{ marginBottom: 4 }}>Georeference</label>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>X origin</label>
                <NumberField
                  className={styles.numberInput}
                  value={properties.georef?.xllcorner}
                  placeholder="—"
                  title="World X of the LOWER-LEFT CORNER of the lower-left cell (the Esri xllcorner convention)."
                  onNumber={n => updateProperties({ georef: { ...defaultGeoref, ...properties.georef, xllcorner: n } })}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Y origin</label>
                <NumberField
                  className={styles.numberInput}
                  value={properties.georef?.yllcorner}
                  placeholder="—"
                  title="World Y of the LOWER-LEFT CORNER of the lower-left cell (the Esri yllcorner convention). Y grows UPWARD, so it belongs to the BOTTOM row."
                  onNumber={n => updateProperties({ georef: { ...defaultGeoref, ...properties.georef, yllcorner: n } })}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Cell size</label>
                <NumberField
                  className={styles.numberInput}
                  value={properties.georef?.cellSize}
                  min={0}
                  placeholder="—"
                  title="World units per cell (square cells — the .asc format has no separate X/Y size)."
                  onNumber={n => updateProperties({ georef: { ...defaultGeoref, ...properties.georef, cellSize: n } })}
                />
              </div>
            </div>
            <div className={styles.fieldRow} style={{ marginTop: 6, alignItems: 'flex-end' }}>
              <div className={styles.field} style={{ flex: 1 }}>
                <label className={styles.fieldLabel}>CRS</label>
                <input
                  className={styles.textInput}
                  value={properties.georef?.crs ?? ''}
                  placeholder="e.g. EPSG:32633 (optional)"
                  title="Coordinate reference system. Metadata only — GenesisCA never reprojects; align upstream in a GIS."
                  onChange={e => updateProperties({
                    georef: { ...defaultGeoref, ...properties.georef, crs: e.target.value || undefined },
                  })}
                />
              </div>
              {properties.georef && (
                <button
                  className={styles.deleteButton}
                  style={{ flex: 'none', padding: '4px 10px', fontSize: '0.7rem' }}
                  title="Drop the georeference — exports fall back to the neutral origin 0,0 / cell size 1."
                  onClick={() => updateProperties({ georef: undefined })}
                >
                  Clear
                </button>
              )}
            </div>
            <span style={{ color: '#888', fontSize: '0.66rem' }}>
              Where cell (0,0) sits in the real world. Set automatically by an Esri ASCII
              grid (.asc) import, written back by the .asc export, and shown next to the
              hovered cell in the Simulator. Nothing in the rule reads it.
            </span>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="execution" title="Execution">
        <div className={styles.fieldGroup}>
          {/* C5 (P10) — the declared reproducibility contract. FIRST in the
              section and OUTSIDE the grid-cells gate: it governs the Engine
              radios below (Auto = the fastest engine that satisfies it) and it
              matters most for an agents-only model, where the GPU agent engine
              is the one thing Exact rules out. */}
          <ReproducibilityRadio
            contract={engines.contract}
            violation={engines.agents?.contractViolation ?? engines.grid.contractViolation ?? null}
            onSelect={c => updateProperties({ reproducibility: c })}
          />
          {/* Cell-grid execution — the GRID's update mode + compile target. Hidden
              for an agents-only model (no lattice to simulate); the agent layer's
              own update mode + compile target live in the Bond-Graph Agents block. */}
          {topo.gridCells && (<>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Update Mode</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: gridIsWebgpu ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: gridIsWebgpu ? 0.55 : 1 }}>
                <input
                  type="radio"
                  name="updateMode"
                  value="synchronous"
                  checked={properties.updateMode !== 'asynchronous'}
                  onChange={() => updateProperties({ updateMode: 'synchronous' as UpdateMode })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  {/* C6 (P5) — the doctrine subtitle: teach the engine consequence
                      at the point of choice, in Principle 1's own words. The same
                      pair labels the Agent Update Mode radio below. */}
                  <strong>Synchronous</strong> <em style={{ color: '#9a9a9a', fontStyle: 'normal' }}>(parallel — runs on all engines)</em>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    All cells read from the previous generation and write to the next simultaneously. Classic CA behavior.
                  </span>
                </span>
              </label>
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: gridIsWebgpu ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: gridIsWebgpu ? 0.55 : 1 }}
                title={gridIsWebgpu ? 'This model runs on WebGPU, where cells update in parallel — asynchronous mode is a CPU-engine rule.' : undefined}
              >
                <input
                  type="radio"
                  name="updateMode"
                  value="asynchronous"
                  checked={properties.updateMode === 'asynchronous'}
                  disabled={gridIsWebgpu}
                  onChange={() => updateProperties({ updateMode: 'asynchronous' as UpdateMode })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Asynchronous</strong> <em style={{ color: '#9a9a9a', fontStyle: 'normal' }}>(sequential — CPU engines only)</em>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Cells update one at a time using a single buffer. Each cell sees previous updates within the same generation. Enables number-conserving models.
                  </span>
                </span>
              </label>
            </div>
          </div>
          {properties.updateMode === 'asynchronous' && !gridIsWebgpu && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Asynchronous Update Scheme</label>
              <select
                className={styles.selectInput}
                value={properties.asyncScheme || 'random-order'}
                onChange={e =>
                  updateProperties({ asyncScheme: e.target.value as AsyncScheme })
                }
              >
                <option value="random-order">Random Order</option>
                <option value="random-independent">Random Independent</option>
                <option value="cyclic">Cyclic</option>
              </select>
              <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
                {(properties.asyncScheme || 'random-order') === 'random-order' &&
                  'All cells update once per generation in random order (Fisher-Yates shuffle).'}
                {properties.asyncScheme === 'random-independent' &&
                  'N random cell picks with replacement per generation. Some cells may update 0 or 2+ times.'}
                {properties.asyncScheme === 'cyclic' &&
                  'A fixed random order decided at initialization, reused every generation. Fastest option.'}
              </span>
            </div>
          )}

          {/* C4 (P1) — the ENGINE radio. `Auto` declares an INTENT and shows
              what it resolved to; JS sits behind the Advanced reveal. The
              selection writes `properties.engine` AND its legacy mirror
              (useWasm/useWebGPU) in one dispatch, so an older build opening the
              file — and every consumer that still reads the flags — sees the
              same engine. Picking WebGPU explicitly also forces synchronous
              update mode, exactly as the old radio did. */}
          <EngineRadio
            name="compileTarget"
            label="Engine"
            webgpuTag="sync only"
            res={engines.grid}
            onSelect={choice => {
              const flags = engineFlags(
                choice === 'auto' ? resolveEngines({ ...model, properties: { ...properties, engine: 'auto' } }).grid.requested : choice,
              );
              updateProperties(choice === 'webgpu'
                ? { engine: choice, ...flags, updateMode: 'synchronous' }
                : { engine: choice, ...flags });
            }}
            hints={{
              auto: 'Picks the fastest engine this model can use, and re-picks as you edit. Never picks an engine the model cannot run on.',
              wasm: 'Hand-compiled WASM module — typically several times faster than JS on dense neighborhoods, and exact: f64 math on one shared seeded stream, bit-identical to the JS reference.',
              webgpu: 'WGSL compute shaders on the GPU — for very large grids and math-heavy per-cell work. Runs parallel rules only, so it needs Synchronous update mode, plus a browser with WebGPU. Statistical parity: f32 math + a per-cell RNG, so a fixed seed does not reproduce a run exactly.'
                + (is3d ? ' In 3D, the GPU runs the simulation while the voxel renderer reads colours back each step.' : ''),
              js: 'The readable semantic reference — breakpointable in devtools and the source Show Code displays, but the slowest engine. The other engines are verified against it. Not a production choice.',
            }}
            footer={(
              <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 6, display: 'block' }}>
                Switching restarts the simulator (grid state is lost). The Compatibility block below lists what each engine can run, and why.
              </span>
            )}
          />
          <div>
            {/* B4B — WebGPU stop-check interval. Greyed unless the RESOLVED grid
                engine is WebGPU (so it lights up under `Auto → WebGPU` too). */}
            <div
              className={styles.field}
              style={{ marginTop: 10, opacity: gridIsWebgpu ? 1 : 0.45 }}
              title={
                gridIsWebgpu
                  ? 'Check stop events every N generations. Higher = faster on WebGPU but may overshoot a stop event by up to N-1 generations. JS / WASM ignore this.'
                  : 'WebGPU only — this model does not run on WebGPU.'
              }
            >
              <label className={styles.fieldLabel}>WebGPU stop-check interval</label>
              <NumberField
                className={styles.numberInput}
                min={1}
                integer
                disabled={!gridIsWebgpu}
                value={properties.webgpuStopCheckInterval ?? 1}
                onNumber={n => updateProperties({ webgpuStopCheckInterval: n })}
              />
              <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
                1 = exact (default). Higher values amortize the per-step GPU stall but a stop event may surface up to K-1 generations late.
              </span>
            </div>
          </div>

          {/* Skip Isolated Empty Cells — opt-in large-grid optimization (CA-grid
              only). Only cells within the active range of a non-empty cell run the
              Generation Step + Output Mapping; isolated empty cells are skipped.
              Synchronous mode only; painting stays ungated. */}
          {(() => {
            const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
            const sie = properties.skipIsolatedEmpty;
            const emptyAttr = sie ? cellAttrs.find(a => a.id === sie.emptyAttributeId) : undefined;
            const defaultEmptyValue = (t?: string) => (t === 'bool' ? 'false' : '0');
            const patchSie = (changes: Partial<SkipIsolatedEmptyConfig>) => {
              const base: SkipIsolatedEmptyConfig = sie ?? { enabled: false, emptyAttributeId: '', emptyValue: '0', rangeKind: 'neighborhood' };
              updateProperties({ skipIsolatedEmpty: { ...base, ...changes } });
            };
            const rangeKind = sie?.rangeKind ?? 'neighborhood';
            return (
              <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                  <input type="checkbox" checked={!!sie?.enabled} style={{ marginTop: 2 }}
                    onChange={e => patchSie({ enabled: e.target.checked })} />
                  <span>
                    <strong>Skip Isolated Empty Cells</strong>
                    <span style={{ color: '#888', fontSize: '0.66rem', display: 'block' }}>
                      Large-grid speedup: only cells within a range of a non-empty cell run the Generation Step + Output Mapping; isolated empty cells are skipped. Synchronous mode only; you can still paint any cell.
                    </span>
                  </span>
                </label>
                {sie?.enabled && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 22 }}>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Empty attribute</label>
                      <select className={styles.selectInput} value={sie.emptyAttributeId}
                        onChange={e => { const a = cellAttrs.find(x => x.id === e.target.value); patchSie({ emptyAttributeId: e.target.value, emptyValue: defaultEmptyValue(a?.type) }); }}>
                        <option value="">— select —</option>
                        {cellAttrs.filter(a => a.type === 'tag' || a.type === 'bool' || a.type === 'integer' || a.type === 'float').map(a =>
                          <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                    {emptyAttr && (
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>Empty value</label>
                        {emptyAttr.type === 'tag' ? (
                          <select className={styles.selectInput} value={sie.emptyValue}
                            onChange={e => patchSie({ emptyValue: e.target.value })}>
                            {(emptyAttr.tagOptions ?? []).map((o, i) => <option key={i} value={String(i)}>{o}</option>)}
                          </select>
                        ) : emptyAttr.type === 'bool' ? (
                          <select className={styles.selectInput} value={sie.emptyValue}
                            onChange={e => patchSie({ emptyValue: e.target.value })}>
                            <option value="false">False</option>
                            <option value="true">True</option>
                          </select>
                        ) : (
                          <NumberField className={styles.numberInput} integer={emptyAttr.type === 'integer'}
                            value={Number(sie.emptyValue) || 0} onNumber={n => patchSie({ emptyValue: String(n) })} />
                        )}
                      </div>
                    )}
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Processing range</label>
                      <div style={{ display: 'flex', gap: 12, fontSize: '0.72rem', marginTop: 2 }}>
                        <label style={{ display: 'flex', gap: 4, cursor: 'pointer' }}>
                          <input type="radio" checked={rangeKind === 'neighborhood'} onChange={() => patchSie({ rangeKind: 'neighborhood' })} /> Neighbourhood
                        </label>
                        <label style={{ display: 'flex', gap: 4, cursor: 'pointer' }}>
                          <input type="radio" checked={rangeKind === 'radius'} onChange={() => patchSie({ rangeKind: 'radius' })} /> Distance
                        </label>
                      </div>
                    </div>
                    {rangeKind === 'neighborhood' ? (
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>Range neighbourhood</label>
                        <select className={styles.selectInput} value={sie.neighborhoodId ?? ''}
                          onChange={e => patchSie({ neighborhoodId: e.target.value })}>
                          <option value="">— select —</option>
                          {model.neighborhoods.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                        </select>
                      </div>
                    ) : (
                      <div className={styles.fieldRow}>
                        <div className={styles.field}>
                          <label className={styles.fieldLabel}>Radius</label>
                          {/* max 15: keeps the worst-case (3D chebyshev, 31³) offset
                              set under the engine's 30000-offset cap (nearCount is
                              Uint16 — see setupActiveSet). Sensible ranges are tiny. */}
                          <NumberField className={styles.numberInput} min={1} max={15} integer
                            value={sie.radius ?? 1} onNumber={n => patchSie({ radius: n })} />
                        </div>
                        <div className={styles.field}>
                          <label className={styles.fieldLabel}>Metric</label>
                          <select className={styles.selectInput} value={sie.radiusMetric ?? 'chebyshev'}
                            onChange={e => patchSie({ radiusMetric: e.target.value as SkipIsolatedEmptyConfig['radiusMetric'] })}>
                            <option value="chebyshev">Box (Chebyshev)</option>
                            <option value="manhattan">Diamond (Manhattan)</option>
                            <option value="euclidean">Sphere (Euclidean)</option>
                          </select>
                        </div>
                      </div>
                    )}
                    <span style={{ color: '#888', fontSize: '0.62rem' }}>
                      Effective in synchronous CA-grid-only mode (agent-topology and glyph-drawing models keep the full loop). Empty cells with no non-empty cell within the range keep their state + colour and are not processed each generation. Make sure the range covers your rule's neighbourhood reads.
                    </span>
                  </div>
                )}
              </div>
            );
          })()}
          </>)}

          {/* Topology — which layer(s) the model uses. Grid Cells is the classic
              lattice CA; Bond-Graph Agents is the off-lattice agent rule graph
              (a second graph, switchable via the sub-tab strip above the canvas).
              ≥1 must stay checked (reducer-enforced; whichever is the only checked
              one is also UI-disabled so the user can't uncheck the last one). */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label className={styles.fieldLabel} style={{ marginBottom: 4 }}>Topology</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: (topo.gridCells && !topo.agents) ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: (topo.gridCells && !topo.agents) ? 0.55 : 1 }}
                title={(topo.gridCells && !topo.agents) ? 'At least one topology must stay enabled.' : undefined}
              >
                <input
                  type="checkbox"
                  checked={topo.gridCells}
                  disabled={topo.gridCells && !topo.agents}
                  onChange={e => updateTopologyMode({ gridCells: e.target.checked })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Grid Cells</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    The classic lattice cellular automaton (this app's core).
                  </span>
                </span>
              </label>
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: (topo.agents && !topo.gridCells) ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: (topo.agents && !topo.gridCells) ? 0.55 : 1 }}
                title={(topo.agents && !topo.gridCells) ? 'At least one topology must stay enabled.' : undefined}
              >
                <input
                  type="checkbox"
                  checked={topo.agents}
                  disabled={topo.agents && !topo.gridCells}
                  onChange={e => updateTopologyMode({ agents: e.target.checked })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Bond-Graph Agents</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Off-lattice agents that float in continuous space, joined by bonds that grow and divide into shape (morphogenesis). Adds a second <strong>Agents</strong> rule graph (switch graphs from the tab strip above the canvas). Agents run on their own <strong>Agent Engine</strong> below (Auto / WebAssembly / WebGPU, plus Debug JS under Advanced), independent of the grid&apos;s.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {/* Overseer — the experiment orchestration graph. This checkbox is the
              ONLY place the feature is visible while off: enabling it reveals the
              Overseer graph tab (modeler), its node catalogue, and the simulator
              Experiments panel; disabling hides all of them again. */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label className={styles.fieldLabel} style={{ marginBottom: 4 }}>Overseer</label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem', marginTop: 2 }}>
              <input
                type="checkbox"
                checked={!!model.overseerConfig?.enabled}
                onChange={e => updateOverseerConfig({ enabled: e.target.checked })}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong>Use Overseer (Experiment Orchestration)</strong>
                <br />
                <span style={{ color: '#888', fontSize: '0.66rem' }}>
                  Adds a third <strong>Overseer</strong> graph that automates whole experiments AROUND the
                  simulation: repeat seeded runs, sweep parameters, run until a Stop Event, collect indicator
                  samples, aggregate statistics (mean ± std), and log/capture results — run it from the
                  simulator's <strong>Experiments</strong> panel.
                </span>
              </span>
            </label>
            {model.overseerConfig?.enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, marginLeft: 20 }}>
                <div>
                  <label className={styles.fieldLabel} style={{ marginBottom: 2 }}>Per-run seed policy</label>
                  <select
                    className={styles.selectInput}
                    value={model.overseerConfig?.seedPolicy ?? 'none'}
                    onChange={e => updateOverseerConfig({ seedPolicy: e.target.value as 'none' | 'fixed' | 'sequential' })}
                  >
                    <option value="none">None (graph controls seeding)</option>
                    <option value="fixed">Fixed (every Reset re-seeds with the base seed)</option>
                    <option value="sequential">Sequential (base seed + reset count)</option>
                  </select>
                  <div style={{ color: '#888', fontSize: '0.66rem', marginTop: 2 }}>
                    Auto-seed applied at each Reset Board unless the graph already ran a Set Random Seed this run.
                  </div>
                </div>
                {(model.overseerConfig?.seedPolicy === 'fixed' || model.overseerConfig?.seedPolicy === 'sequential') && (
                  <div>
                    <label className={styles.fieldLabel} style={{ marginBottom: 2 }}>Base seed</label>
                    <NumberField
                      className={styles.numberInput}
                      value={model.overseerConfig?.baseSeed ?? 12345}
                      integer
                      onNumber={v => updateOverseerConfig({ baseSeed: v })}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bond-Graph Agents config — shown when the Agents topology is on.
              Capacity ceilings (allocated once; overflow rejects), the seed
              population, the soft-sphere force law, growth, and bonds. Every
              field is live-tunable except the ceilings (a maxAgents/maxBonds
              change re-allocates → a worker reinit). */}
          {topo.agents && (() => {
            const cb = model.centerBased;
            // "Use bonding physics" master toggle (req 10): when off, the engine
            // applies NO built-in forces (soft-sphere / springs / growth / auto-bond)
            // and the Forces + Bonds rows are hidden — agents move only by the
            // graph's Apply Force / Set Velocity. Resolved with the customForcesOnly
            // back-compat fallback so loaded files reflect their real behaviour.
            const bonding = usesBondingPhysics(cb);
            // Live WASM-target support for the CURRENT agent graph. The WASM agent
            // target is FULL-COVERAGE (the whole catalogue runs with JS bit-parity);
            // the only clamp is a per-node array-scratch-slot budget (too many
            // simultaneous Get-Nearby-Agents producers → JS). When false, picking
            // WASM is honest but the engine falls back to JS (agentTargetOf clamps).
            const agentWasmSupported = isAgentGraphWasmSupported(model);
            // Live WebGPU-target support for the CURRENT agent graph (full
            // catalogue minus the documented fundamentals). When false, picking
            // WebGPU is honest but the engine falls back to JS (agentTargetOf clamps).
            const agentWebgpuSupported = isAgentGraphWebGPUSupported(model);
            // C7: an agent graph with no behaviour root YET (every freshly
            // created agent model). Both gates early-out on exactly this, so
            // naming it keeps the hints from inventing a capacity / fundamentals
            // reason for a graph that simply has no rule in it.
            const agentGraphEmpty = !(model.agentGraphNodes ?? []).some(
              n => n.data.nodeType === 'behaviourStep' || n.data.nodeType === 'periodicStep');
            const noRuleYetHint = 'The Agents graph has no Behaviour Step (or Periodic Step) yet, so there is no per-agent rule to compile. Add one and this re-evaluates.';
            const num = (k: CenterBasedNumericKey) => cbNum(cb, k);
            const NF = (k: CenterBasedNumericKey, opts?: { min?: number; max?: number; step?: number; integer?: boolean }) => (
              <NumberField
                className={styles.numberInput}
                value={num(k)}
                min={opts?.min}
                max={opts?.max}
                step={opts?.step}
                integer={opts?.integer}
                onNumber={n => updateCenterBased({ [k]: n })}
              />
            );
            const Row = (label: string, field: React.ReactNode, hint?: string) => (
              <div style={{ marginBottom: 8 }}>
                <label className={styles.fieldLabel} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span>{label}</span>{field}
                </label>
                {hint && <span style={{ color: '#888', fontSize: '0.62rem', display: 'block' }}>{hint}</span>}
              </div>
            );
            return (
              <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
                <label className={styles.fieldLabel} style={{ marginBottom: 6, color: '#b58fd6' }}>Bond-Graph Agents</label>
                {/* Agent Capability Profile — the preset picker + capability toggles
                    + per-agent footprint. Placed first so the user chooses their
                    paradigm before tuning the numeric force/bond params below; the
                    editor surface (palette / ports / Edit-panel rows) filters to
                    the enabled capabilities. */}
                <AgentCapabilitiesSection model={model} updateCenterBased={updateCenterBased} />
                {/* Agent Update Mode — INDEPENDENT of the grid's Update Mode radio
                    above. The user can run a synchronous grid rule with async
                    agents, and vice versa. Changing it re-allocates the attribute
                    buffers (double- vs single-buffered) → a full reinit (it's in
                    needsFullInit). */}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 4px' }}>Agent Update Mode</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2, marginBottom: 4 }}>
                  {/* C6 (P5) — the same doctrine vocabulary as the grid's Update
                      Mode radio above. The agent CONSEQUENCE differs from the
                      grid's, so the subtitle states it accurately: an async AGENT
                      model DOES run on WebGPU (Growing Tissue ships that way) —
                      what the parallel GPU cannot honour is a cross-agent
                      OVERWRITE, whose order the sequential CPU engines define. */}
                  {([
                    ['async', 'Asynchronous', '(sequential — a cross-agent write needs a CPU engine)', 'Single-buffered attributes — a Set Agent Attribute to a neighbour is immediately visible to a later agent this step (sequential).'],
                    ['sync', 'Synchronous', '(parallel — runs on all engines)', 'Double-buffered attributes — every agent reads the previous step; writes are swapped in at the step’s end (parallel / snapshot semantics). All three agent engines honour it.'],
                  ] as const).map(([val, title, sub, hint]) => (
                    <label key={val} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                      <input
                        type="radio"
                        name="agentUpdateMode"
                        checked={(cb?.agentUpdateMode ?? 'async') === val}
                        onChange={() => updateCenterBased({ agentUpdateMode: val })}
                        style={{ marginTop: 2 }}
                      />
                      <span><strong>{title}</strong> <em style={{ color: '#9a9a9a', fontStyle: 'normal' }}>{sub}</em><br /><span style={{ color: '#888', fontSize: '0.66rem' }}>{hint}</span></span>
                    </label>
                  ))}
                </div>
                <span style={{ color: '#888', fontSize: '0.62rem', display: 'block', marginBottom: 4 }}>
                  Independent of the grid&apos;s Update Mode. Positions are snapshot-integrated in both modes; this governs attribute read/write visibility.
                </span>

                {/* C4 (P1) - the AGENT ENGINE radio, INDEPENDENT of the grid's.
                    Same control, same Auto semantics: Auto picks WebGPU when the
                    agent gates pass, else WASM, else JS - and prefers a CPU engine
                    when the model runs Overseer experiments (sweeps need seed
                    reproducibility). The hints stay LIVE per model: they name what
                    this graph can actually do on each engine. */}
                {engines.agents && (
                  <EngineRadio
                    name="agentCompileTarget"
                    label="Agent Engine"
                    labelColor="#b58fd6"
                    res={engines.agents}
                    onSelect={choice => updateCenterBased({ agentTarget: choice })}
                    hints={{
                      auto: 'Picks the fastest agent engine this graph can use, and re-picks as you edit the agent rule.',
                      wasm: agentWasmSupported
                        ? 'This agent graph runs on WebAssembly with JS bit-parity (the whole node catalogue is supported). Typically 2-5x faster than JS for heavy per-agent rules.'
                        : agentGraphEmpty ? noRuleYetHint
                        : 'Selectable, but this graph has too many simultaneous Get-Nearby-Agents producers for the WASM scratch budget, so it falls back to JS.',
                      webgpu: agentWebgpuSupported
                        ? 'This agent graph runs on WebGPU - the behaviour + force passes dispatch on the GPU. Eligible models (custom forces, async attributes, no bonds/division/field coupling - the Particle Life / Boids class) run whole frames RESIDENT on the GPU: tens of times faster at large populations. Other models use the per-generation path, which pays a CPU-GPU round-trip each step (now sized by the LIVE population, not the Max Agents ceiling); below a few thousand agents JS/WASM is usually faster. Statistical parity: f32 + a per-agent RNG, so Set Random Seed does not pin a run.'
                          + ((model.bondAttributes?.length ?? 0) > 0
                            ? ' BOND ATTRIBUTES run on the GPU too (P3). One caveat: when BOTH endpoints of a bond write the same attribute in the SAME step, which write lands is ORDER-UNDEFINED on the GPU (the CPU engines are sequential, so the higher-id endpoint wins there). Write from one side only (the owner-id idiom), or make the rule symmetric so both endpoints compute the same value - the SDCA link rule is symmetric.'
                            : '')
                        : agentGraphEmpty ? noRuleYetHint
                        : 'Selectable, but this graph uses one of the few WebGPU-fundamental rejects (median / uniform-random aggregate, toggle/next/previous indicator ops, a cross-agent overwrite aimed at a wired agent id - order-dependent under parallel threads - or too many array producers), so it falls back to JS.',
                      js: 'The reference agent engine - full node coverage, and the source Show Code displays. The agent loop is already O(N) via the spatial hash, so JS is workable at small populations.',
                    }}
                    footer={(
                      <span style={{ color: '#888', fontSize: '0.62rem', display: 'block', marginTop: 6, marginBottom: 4 }}>
                        Independent of the grid&apos;s Engine. The grid and agents can run on different engines (e.g. WebGPU grid diffusion + WASM agents).
                      </span>
                    )}
                  />
                )}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 4px' }}>Capacity</div>
                {Row('Max Agents', NF('maxAgents', { min: 1, integer: true }), 'Over-allocated ceiling; overflow rejects (never wraps). Changing it re-inits the engine.')}
                {Row('Max Bonds / Agent', NF('maxBonds', { min: 0, integer: true }), '0 = no bonds (pure-force / charged-particle models); the bond store is then not allocated.')}
                {/* GRA P4 — the per-agent structural-request QUEUE depth. Only
                    meaningful once bonds exist, so it follows Max Bonds. */}
                {resolveMaxBonds(cb) > 0 && Row('Bond Requests / Agent / Step', NF('bondRequestDepth', { min: 1, max: BOND_REQUEST_DEPTH_MAX, integer: true }), 'How many Form / Break / Rewire Bond ops one agent may issue in ONE step — graph rewrites (triangle split, edge swap) need several at once. Ops past this are rejected whole with a notice. Changing it re-inits the engine.')}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>Seeding</div>
                {Row('Seed Count', NF('seedCount', { min: 0, integer: true }), 'Agents laid down on Reset (0 = seed via the brush).')}
                {Row('Default Radius', NF('defaultRadius', { min: 0.01, step: 0.1 }))}
                {/* Seed Pattern — how the Reset seed population is laid out. */}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 4px' }}>Seed Pattern</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2, marginBottom: 4 }}>
                  {([
                    ['compact', 'Compact', 'Centred packed blob — the morphogenesis / tissue start.'],
                    ['scatter', 'Scatter', 'Uniformly random across the world — dispersed flocking / chemotaxis populations.'],
                  ] as const).map(([val, title, hint]) => (
                    <label key={val} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                      <input
                        type="radio"
                        name="agentSeedPattern"
                        checked={(cb?.seedPattern ?? 'compact') === val}
                        onChange={() => updateCenterBased({ seedPattern: val })}
                        style={{ marginTop: 2 }}
                      />
                      <span><strong>{title}</strong><br /><span style={{ color: '#888', fontSize: '0.66rem' }}>{hint}</span></span>
                    </label>
                  ))}
                </div>
                {/* Motion — the velocity integrator; relevant to EVERY agent model
                    (a custom-force boids model lives entirely here), so always shown. */}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>Motion</div>
                {Row('Momentum', NF('momentum', { min: 0, max: 0.999, step: 0.05 }), '0 = overdamped (tissue); ~0.9 = flocking inertia.')}
                {Row('Max Speed', NF('maxSpeed', { min: 0, step: 0.1 }), 'Per-step speed cap (0 = uncapped).')}
                {Row('Neighbour Query Radius', NF('neighbourQueryRadius', { min: 1, step: 0.5 }), 'Get Nearby Agents radius the spatial-hash bin is sized to cover.')}
                {/* C1 (P4) — no silent resolution: when the stability bound
                    actually REDUCES Δt, show the number the engine runs and why.
                    `effectiveAgentDt` is the same helper the worker's
                    clampAgentDt calls, so the two cannot disagree. */}
                {Row('Time Step Δt', NF('timeStep', { min: 0.001, step: 0.05 }))}
                {(() => {
                  const eff = effectiveAgentDt(cb);
                  return (
                    <div style={{ marginTop: -6, marginBottom: 8 }}>
                      {eff.clamped && (
                        <span style={{ color: '#e0a050', fontSize: '0.62rem', display: 'block' }}>
                          → effective Δt <b>{Number(eff.dt.toPrecision(4))}</b> — clamped from {eff.requested} for stability (μ_eff = {Number(eff.muEff.toPrecision(4))})
                        </span>
                      )}
                      <span style={{ color: '#888', fontSize: '0.62rem', display: 'block' }}>
                        Auto-clamped against the stability bound Δt ≤ 0.2 / (Repulsion μ + Bond λ){eff.clamped ? '.' : ` = ${Number(eff.bound.toPrecision(4))} — not binding here.`}
                      </span>
                    </div>
                  );
                })()}
                {Row('Drag η', NF('drag', { min: 0.01, step: 0.1 }), 'Overdamped drag (scales force → velocity).')}

                {/* Use bonding physics master toggle (req 10). OFF = no engine
                    forces (agents move only by graph forces); the Forces + Bonds
                    rows below appear only when ON. */}
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem', margin: '12px 0 4px' }}>
                  <input type="checkbox" checked={bonding} onChange={e => {
                    const on = e.target.checked;
                    // Enabling bonding with no bond capacity is a foot-gun (nothing
                    // can bond). Bump maxBonds to the engine default when turning it
                    // on and the store is still empty.
                    const bumpBonds = on && (cb?.maxBonds ?? 0) <= 0;
                    updateCenterBased(bumpBonds ? { useBondingPhysics: on, maxBonds: CENTER_BASED_DEFAULTS.maxBonds } : { useBondingPhysics: on });
                  }} style={{ marginTop: 2 }} />
                  <span><strong>Use bonding physics</strong><br /><span style={{ color: '#888', fontSize: '0.66rem' }}>Engine soft-sphere repulsion / adhesion + bond springs + growth + auto-bond. Off = agents move only by graph-authored Apply Force / Set Velocity (the &quot;agents that have nothing to do with bonds&quot; case).</span></span>
                </label>
                {bonding && (<>
                  <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>Forces</div>
                  {Row('Repulsion μ', NF('repulsionStiffness', { min: 0, step: 0.1 }), 'Volume-exclusion stiffness.')}
                  {Row('Adhesion μ', NF('adhesionStiffness', { min: 0, step: 0.1 }), 'Free-agent stickiness (0 = cohesion via bonds only).')}
                  {Row('Interaction Range', NF('interactionRange', { min: 1, step: 0.1 }), '× contact distance — the force cutoff.')}
                  {Row('Growth Rate', NF('growthRate', { min: 0, step: 0.01 }), 'Radius units/step toward the target radius.')}
                  <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>Bonds</div>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem', marginBottom: 6 }}>
                    <input type="checkbox" checked={!!cb?.autoBond} onChange={e => {
                      const on = e.target.checked;
                      // Auto-bond FORMS bonds, so reconcile the Agent Capability
                      // profile — turning it on sets Bonds = Physics so the profile
                      // isn't left 'off' (which drops the bond store and would
                      // SILENTLY disable auto-bonding, and would hide the bond palette
                      // nodes). Keeps the two overlapping panel controls consistent.
                      updateCenterBased(on
                        ? { autoBond: true, agentCapabilities: applyCapabilityEdit(resolveAgentProfile(model), 'bonds', 'physics') }
                        : { autoBond: false });
                    }} style={{ marginTop: 2 }} />
                    <span><strong>Auto-bond by distance</strong><br /><span style={{ color: '#888', fontSize: '0.66rem' }}>Bond agents within the form distance; break past the break distance (hysteresis). The simplest path to a glued cluster.</span></span>
                  </label>
                  {Row('Bond Stiffness λ', NF('bondStiffness', { min: 0, step: 0.1 }))}
                  {Row('Bond Rest Length', NF('bondRestLength', { min: 0, step: 0.1 }), 'Spring rest length L for new bonds — the spring force is λ(l − L).')}
                  {Row('Form Distance', NF('formDistance', { min: 1, step: 0.05 }), '× contact (auto-bond within).')}
                  {Row('Break Distance', NF('breakDistance', { min: 1, step: 0.05 }), '× contact (> form — hysteresis).')}
                </>)}
              </div>
            );
          })()}

          {/* End Conditions — optional, collapsible */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={ecEnabled}
                onChange={e => updateEndConditions({ enabled: e.target.checked })}
              />
              <span style={{ fontSize: '0.78rem' }}>End Conditions</span>
            </label>
            <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
              When enabled, the simulator auto-pauses once any of these conditions are met
              (max generations reached, or any indicator rule matches).
            </span>
            {ecEnabled && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Max Generations</label>
                  <NumberField
                    className={styles.numberInput}
                    min={0}
                    integer
                    placeholder="(no limit)"
                    value={ec?.maxGenerations}
                    onNumber={n => updateEndConditions({ maxGenerations: n })}
                    onClear={() => updateEndConditions({ maxGenerations: undefined })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Indicator Conditions</label>
                  {(model.indicators || []).length === 0 && (
                    <span style={{ color: '#888', fontSize: '0.68rem', fontStyle: 'italic' }}>
                      Define at least one indicator to add conditions.
                    </span>
                  )}
                  <div data-reorder-list>
                  {(ec?.indicatorConditions || []).map((cond, condIdx, condArr) => {
                    const ind = (model.indicators || []).find(i => i.id === cond.indicatorId);
                    // GRA P6 — a frequency-shaped GRAPH metric (degree histogram)
                    // is category-keyed like a linked-frequency indicator; its
                    // keys are integers (degrees), so it reuses the integer widget.
                    const isGraphFreq = ind?.kind === 'graph'
                      && isGraphFrequencyMetric((ind.graphMetric ?? 'nodeCount') as GraphMetric);
                    const isFreq = (ind?.kind === 'linked' && ind?.linkedAggregation === 'frequency') || isGraphFreq;
                    const linkedAttr = isFreq && ind?.kind === 'linked'
                      ? (model.attributes || []).find(a => a.id === ind.linkedAttributeId)
                      : undefined;
                    const freqKind = isGraphFreq ? 'integer' : isFreq ? linkedAttr?.type : undefined; // 'bool'|'tag'|'integer'|'float'
                    const floatFreqDisabled = freqKind === 'float';
                    const isDragging = ecReorder.dragState?.id === cond.id;
                    const srcIdx = ecReorder.dragState ? condArr.findIndex(c => c.id === ecReorder.dragState!.id) : -1;
                    const showBefore = ecReorder.dragState?.overIdx === condIdx && srcIdx !== condIdx && srcIdx !== condIdx - 1;
                    const showAfter = ecReorder.dragState?.overIdx === condArr.length && condIdx === condArr.length - 1 && srcIdx !== condIdx;
                    return (
                      <div
                        key={cond.id}
                        data-reorder-row
                        className={`${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                        style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}
                      >
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <select
                            className={styles.selectInput}
                            style={{ flex: 1.4 }}
                            value={cond.indicatorId}
                            onChange={e => {
                              // Clear category on indicator change — the old key may be meaningless for the new indicator.
                              updateIndicatorCondition(cond.id, { indicatorId: e.target.value, category: undefined });
                            }}
                          >
                            {(model.indicators || [])
                              .filter(i => !isSpatialIndicator(i) || i.id === cond.indicatorId)
                              .map(i => (
                                <option key={i.id} value={i.id}>{i.name}</option>
                              ))}
                          </select>
                          {/* Category widget (linked-frequency only) */}
                          {isFreq && freqKind === 'bool' && (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.category ?? 'true'}
                              onChange={e => updateIndicatorCondition(cond.id, { category: e.target.value })}
                              title="Category to monitor (count of cells with this value)"
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          )}
                          {isFreq && freqKind === 'tag' && (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.category ?? (linkedAttr?.tagOptions?.[0] ?? '')}
                              onChange={e => updateIndicatorCondition(cond.id, { category: e.target.value })}
                              title="Tag to monitor (count of cells with this tag)"
                            >
                              {(linkedAttr?.tagOptions || []).map((tag, i) => (
                                <option key={i} value={tag}>{tag}</option>
                              ))}
                            </select>
                          )}
                          {isFreq && freqKind === 'integer' && (
                            <NumberField
                              className={styles.numberInput}
                              integer
                              style={{ flex: 1 }}
                              placeholder="value"
                              value={cond.category}
                              onNumber={n => updateIndicatorCondition(cond.id, { category: String(n) })}
                              onClear={() => updateIndicatorCondition(cond.id, { category: undefined })}
                              title="Integer value to monitor (count of cells with this value)"
                            />
                          )}
                          <select
                            className={styles.selectInput}
                            style={{ width: 52 }}
                            value={cond.op}
                            disabled={floatFreqDisabled}
                            onChange={e => updateIndicatorCondition(cond.id, { op: e.target.value as EndConditionOp })}
                          >
                            <option value="==">==</option>
                            <option value="!=">!=</option>
                            <option value=">">&gt;</option>
                            <option value="<">&lt;</option>
                            <option value=">=">&ge;</option>
                            <option value="<=">&le;</option>
                          </select>
                          {/* Value widget: scalar branches when NOT a frequency indicator;
                              count (number) when frequency (except float-binned, which is disabled) */}
                          {!isFreq && ind?.dataType === 'bool' ? (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.value === '1' || cond.value === 'true' ? 'true' : 'false'}
                              onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                            >
                              <option value="false">false</option>
                              <option value="true">true</option>
                            </select>
                          ) : !isFreq && ind?.dataType === 'tag' ? (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.value}
                              onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                            >
                              {(ind.tagOptions || []).map((tag, i) => (
                                <option key={i} value={String(i)}>{tag}</option>
                              ))}
                            </select>
                          ) : (
                            <NumberField
                              className={styles.numberInput}
                              integer={isFreq || ind?.dataType === 'integer'}
                              style={{ flex: 1 }}
                              value={cond.value}
                              disabled={floatFreqDisabled}
                              placeholder={isFreq ? 'count' : undefined}
                              onNumber={n => updateIndicatorCondition(cond.id, { value: String(n) })}
                            />
                          )}
                          <button
                            className={styles.dragHandle}
                            title="Drag to reorder"
                            onPointerDown={ecReorder.startDrag(cond.id)}
                            onClick={e => e.stopPropagation()}
                          >⋮⋮</button>
                          <button
                            className={styles.deleteButton}
                            style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                            onClick={() => removeIndicatorCondition(cond.id)}
                            title="Remove condition"
                          >
                            &times;
                          </button>
                        </div>
                        {floatFreqDisabled && (
                          <span style={{ color: '#e0a050', fontSize: '0.62rem', fontStyle: 'italic', paddingLeft: 4 }}>
                            Decimal-binned frequency categories depend on runtime range. Change this indicator&apos;s aggregation to Total, or pick a different indicator.
                          </span>
                        )}
                      </div>
                    );
                  })}
                  </div>
                  <button
                    className={styles.addButton}
                    style={{ fontSize: '0.72rem', padding: '2px 8px', marginTop: 4 }}
                    disabled={(model.indicators || []).length === 0}
                    onClick={addIndicatorCondition}
                  >
                    + Add Indicator Condition
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </CollapsibleSection>

      {/* C1 (P2) — which engines this model can use, and why not the others.
          Sits directly under Execution because it explains the Compile Target
          radios there; kept as its OWN collapsible section rather than nested
          inside the (already long) Execution body. */}
      <CollapsibleSection
        id="compatibility"
        title="Compatibility"
        action={<CopyButton title="Copy the whole compatibility report as plain text" getText={() => compatibilityToText(model)} />}
      >
        <CompatibilityBlock model={model} />
      </CollapsibleSection>

      {/* C2 (P3) — what actually happens each generation for THIS model.
          Directly under Compatibility: C1 answers "which engine?", C2 answers
          "what does it do?". Shown for every model — a grid-only model simply
          gets the short list. */}
      <CollapsibleSection
        id="pipeline"
        title="Generation Pipeline"
        action={<CopyButton title="Copy the whole generation pipeline as plain text" getText={() => pipelineToText(model)} />}
      >
        <GenerationPipelineBlock model={model} />
      </CollapsibleSection>

      <CollapsibleSection id="indicators" title="Indicators" bare>
        <IndicatorsPanelSection mode="list" selectedId={selIndId} onSelect={selectInd} hideTitle />
      </CollapsibleSection>

      {/* Variegated Cells — a specialised 2D-grid feature (directional per-cell
          interactions). The most setup-specific option, so it sits LAST, after the
          common Indicators / End Conditions. Only relevant with the CA grid on. */}
      {topo.gridCells && (
        <CollapsibleSection id="variegated" title="Variegated Cells">
          <div className={styles.fieldGroup}>
            <label
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: is3d ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: is3d ? 0.55 : 1 }}
              title={is3d ? 'Variegated Cells is 2D-only (the orientation/face geometry is square-lattice).' : undefined}
            >
              <input
                type="checkbox"
                checked={!is3d && !!model.variegatedCells?.enabled}
                disabled={is3d}
                onChange={e => updateVariegatedCells({ enabled: e.target.checked })}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong>Use Variegated Cells (Directional Interactions){is3d ? ' — 2D only' : ''}</strong>
                <br />
                <span style={{ color: '#888', fontSize: '0.66rem' }}>
                  Adds a per-cell orientation (0-3 = 90&deg; rotations) and face-pattern labels for directional rules (chemistry CA, micelle formation, chiral models). Configure face patterns in the dedicated <strong>Variegated Cells</strong> panel (V) on the left sidebar.{is3d ? ' Not available in 3D models.' : ''}
                </span>
              </span>
            </label>
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}
