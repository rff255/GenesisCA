import { useMemo } from 'react';
import { useModel } from '../../model/ModelContext';
import type { CAModel } from '../../model/types';
import { REPRODUCIBILITY_LABEL } from '../../model/reproducibility';
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
import { resolveAgentProfile, estimateAgentFootprint } from '../../model/agentCapabilities';
import { Section, CopyButton, Hint } from './propertiesWidgets';
import styles from './PanelContent.module.css';

/**
 * Properties › Diagnostics — READ-ONLY. "What will actually run?" The
 * Compatibility readout (C1), the Generation Pipeline (C2) and the per-agent
 * footprint. Nothing here edits the model; every fact comes from the function
 * that ENFORCES it (`diagnoseTargets`, `describeGenerationPipeline`,
 * `estimateAgentFootprint`), so the readouts cannot drift from the engine.
 *
 * The two readout blocks are moved VERBATIM from the pre-refactor Properties
 * panel (their dense chip styling was designed with the C1/C2 phases and is
 * deliberately kept as-is); the tab only re-homes them.
 */

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


// --- Per-agent footprint (moved out of the capability section) --------------
function FootprintBlock({ model }: { model: CAModel }) {
  const footprint = useMemo(() => estimateAgentFootprint(resolveAgentProfile(model), model), [model]);
  return (
    <div className={styles.fieldGroup}>
      <div className={styles.rowSplit}>
        <span className={styles.rowLabel}>Bytes per agent</span>
        <b style={{ color: 'var(--color-accent)' }}>≈ {footprint.bytesPerAgent} B</b>
      </div>
      {footprint.groups.map((g, i) => (
        <div key={i} className={styles.rowSplit}>
          <span className={`${styles.rowLabel} ${g.core ? styles.rowLabelMuted : ''}`}>{g.label}</span>
          <span className={styles.rowLabelMuted}>{g.bytes} B</span>
        </div>
      ))}
      <Hint>Follows the capability profile: the engine allocates only the field groups the profile (or a node the graph uses) needs.</Hint>
    </div>
  );
}

export function PropertiesDiagnosticsTab() {
  const { model } = useModel();
  const agentsOn = !!model.topologyMode?.agents;
  return (
    <>
      {/* C1 (P2) — which engines this model can use, and why not the others. */}
      <Section
        id="compatibility"
        title="Compatibility"
        action={<CopyButton title="Copy the whole compatibility report as plain text" getText={() => compatibilityToText(model)} />}
      >
        <CompatibilityBlock model={model} />
      </Section>
      {/* C2 (P3) — what actually happens each generation for THIS model. */}
      <Section
        id="pipeline"
        title="Generation Pipeline"
        action={<CopyButton title="Copy the whole generation pipeline as plain text" getText={() => pipelineToText(model)} />}
      >
        <GenerationPipelineBlock model={model} />
      </Section>
      {agentsOn && (
        <Section id="diag.footprint" title="Per-agent footprint">
          <FootprintBlock model={model} />
        </Section>
      )}
    </>
  );
}
