import { useEffect, useMemo, useState } from 'react';
import shared from './MacroExportDialog.module.css';
import own from './MacroImportDialog.module.css';
import { describeElement } from './MacroExportDialog';
import type { ElementSpace } from '../model/macroReferences';
import { SPACE_LABEL, SPACE_ORDER } from '../model/macroReferences';
import type { ImportAction, ImportPlan, ImportRow } from '../model/macroImportPlan';
import { modelListFor, remapWarnings } from '../model/macroImportPlan';
import type { CAModel } from '../model/types';

interface Props {
  plan: ImportPlan;
  /** The TARGET model — the remap candidates are its elements, and the live
   *  per-row warnings depend on which of them the user picks. */
  model: CAModel;
  onImport: (rows: ImportRow[]) => void;
  onCancel: () => void;
}

const ACTIONS: { action: ImportAction; label: string }[] = [
  { action: 'new', label: 'Import as new' },
  { action: 'remap', label: 'Remap →' },
  { action: 'discard', label: 'Discard' },
];

/**
 * Import Macro — the resolution dialog.
 *
 * Rows appear ONLY for references the target model does not already have;
 * everything that resolves is summarised and never asked about, which is why
 * re-importing a macro into the model it came from opens no dialog at all.
 *
 * Per unresolved element the default is: an exact name + compatible type match
 * ⇒ **Remap** (rendered as a suggestion, never applied silently), else **Import
 * as new**. **Discard is never a default** — but it is always one click away,
 * and it is exactly today's behaviour.
 *
 * Capability / topology mismatches WARN, never block (D12): the element imports
 * anyway and is inert until the user enables the layer, because blocking would
 * dead-end the legitimate "import the pieces, then turn the layer on" flow.
 */
export function MacroImportDialog({ plan, model, onImport, onCancel }: Props) {
  const [rows, setRows] = useState<ImportRow[]>(() => plan.rows.map(r => ({ ...r })));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const groups = useMemo(() => {
    const bySpace = new Map<ElementSpace, ImportRow[]>();
    for (const row of rows) {
      const list = bySpace.get(row.space) ?? [];
      list.push(row);
      bySpace.set(row.space, list);
    }
    return bySpace;
  }, [rows]);

  /** Closure metadata names its requirer by ID; the dialog shows names. */
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of plan.rows) m.set(r.id, r.name);
    for (const r of plan.resolved) m.set(r.id, r.name);
    return m;
  }, [plan]);

  const setRow = (id: string, changes: Partial<ImportRow>) =>
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...changes } : r)));

  const counts = useMemo(() => {
    let imported = 0, remapped = 0, discarded = 0, warnings = 0;
    for (const r of rows) {
      if (r.action === 'new') { imported++; if (r.inertWarning) warnings++; }
      else if (r.action === 'remap') {
        remapped++;
        const target = r.remapTargetId ? modelListFor(model, r.space).find(t => t.id === r.remapTargetId) : undefined;
        if (target && r.element) warnings += remapWarnings(r.space, r.element, target).length;
      } else discarded++;
    }
    return { imported, remapped, discarded, warnings };
  }, [rows, model]);

  const originLine = (() => {
    const o = plan.origin;
    if (!o?.modelName) return null;
    const bits: string[] = [];
    if (o.dimension) bits.push(o.dimension.toUpperCase());
    if (o.topologyMode) {
      const layers = [o.topologyMode.gridCells !== false ? 'grid' : null, o.topologyMode.agents ? 'agents' : null].filter(Boolean);
      if (layers.length > 0) bits.push(layers.join(' + '));
    }
    return `from ${o.modelName}${bits.length ? ` (${bits.join(', ')})` : ''} · `;
  })();

  const renderRow = (row: ImportRow) => {
    const target = row.remapTargetId ? modelListFor(model, row.space).find(t => t.id === row.remapTargetId) : undefined;
    const live = row.action === 'remap' && target && row.element ? remapWarnings(row.space, row.element, target) : [];
    const suggested = row.suggestionId
      ? row.candidates.find(c => c.id === row.suggestionId)
      : undefined;
    const closureOnly = row.directCount === 0 && row.requiredBy.length > 0;
    return (
      <div key={row.id} className={`${shared.row} ${closureOnly ? shared.indent : ''}`} style={{ cursor: 'default' }}>
        <div className={shared.rowMain}>
          <div>
            <span className={shared.name}>{row.name}</span>
            <span className={shared.kind}> · {describeElement(row)}</span>
          </div>
          {!row.carried && <div className={shared.meta}>{row.blockedReason}</div>}
          {row.carried && suggested && row.action === 'remap' && row.remapTargetId === suggested.id && (
            <div className={`${shared.meta} ${own.suggest}`}>
              ↔ matched by name — <b>{suggested.name}</b> ({suggested.detail}) in this model
            </div>
          )}
          {row.carried && !suggested && row.action === 'new' && (
            <div className={shared.meta}>no match in this model — a new element will be created</div>
          )}
          {row.carried && row.action === 'new' && row.inertWarning && (
            <div className={`${shared.meta} ${shared.warn}`}>⚠ {row.inertWarning}</div>
          )}
          {row.action === 'discard' && row.carried && (
            <div className={shared.meta}>discarded — nodes naming it will reference nothing (today’s behaviour)</div>
          )}
          {live.map((w, i) => (
            <div key={i} className={`${shared.meta} ${shared.warn}`}>⚠ {w}</div>
          ))}
          {closureOnly && row.requiredVia[0] && (
            <div className={shared.meta}>
              pulled in by <i>{nameOf.get(row.requiredBy[0] ?? '') ?? row.requiredBy[0]}</i> → {row.requiredVia[0]}
            </div>
          )}
        </div>
        <div className={own.controls}>
          <span className={own.seg}>
            {ACTIONS.map(({ action, label }) => {
              const noCandidates = action === 'remap' && row.candidates.length === 0;
              const disabled = !row.carried ? action !== 'discard' : noCandidates;
              const title = !row.carried
                ? row.blockedReason
                : noCandidates
                  ? `no compatible ${SPACE_LABEL[row.space].toLowerCase()} in this model`
                  : undefined;
              return (
                <button
                  key={action}
                  type="button"
                  title={title}
                  disabled={disabled}
                  className={`${own.segBtn} ${action === 'discard' ? own.segDiscard : ''} ${row.action === action ? own.segOn : ''}`}
                  onClick={() => setRow(row.id, {
                    action,
                    remapTargetId: action === 'remap'
                      ? (row.remapTargetId ?? row.suggestionId ?? row.candidates[0]?.id)
                      : row.remapTargetId,
                  })}
                >
                  {label}
                </button>
              );
            })}
          </span>
          {row.action === 'remap' && row.candidates.length > 0 && (
            <select
              className={own.select}
              value={row.remapTargetId ?? ''}
              onChange={e => setRow(row.id, { remapTargetId: e.target.value })}
            >
              {row.candidates.map(c => (
                <option key={c.id} value={c.id}>{c.name} · {c.detail}</option>
              ))}
            </select>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={shared.backdrop} onClick={onCancel}>
      <div className={shared.dialog} style={{ width: 720 }} onClick={e => e.stopPropagation()}>
        <div className={shared.header}>
          <div className={shared.title}>Import Macro — “{plan.macroName}”</div>
          <div className={shared.subtitle}>
            {originLine}
            {rows.length} reference{rows.length === 1 ? '' : 's'} need{rows.length === 1 ? 's' : ''} a decision
            {plan.resolved.length > 0 && ` · ${plan.resolved.length} already present`}
          </div>
        </div>

        <div className={shared.body}>
          {SPACE_ORDER.map(space => {
            const list = groups.get(space);
            if (!list || list.length === 0) return null;
            return (
              <div key={space}>
                <div className={shared.section}>{SPACE_LABEL[space]}</div>
                {list.map(renderRow)}
              </div>
            );
          })}

          {plan.resolved.length > 0 && (
            <div>
              <div className={shared.section}>Already present — nothing to do</div>
              <div className={own.resolvedList}>
                {plan.resolved.map(r => r.name).join(' · ')}
              </div>
            </div>
          )}
        </div>

        <div className={shared.actions}>
          <span className={own.summary}>
            {counts.imported} new · {counts.remapped} remapped · {counts.discarded} discarded
            {counts.warnings > 0 && ` · ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`}
          </span>
          <div className={shared.btnRow}>
            <button type="button" className={shared.btnSecondary} onClick={onCancel}>Cancel</button>
            <button type="button" className={shared.btnPrimary} onClick={() => onImport(rows)}>Import</button>
          </div>
        </div>
      </div>
    </div>
  );
}
