import { useEffect, useRef, useState } from 'react';
import { useModel } from '../../model/ModelContext';
import type { FaceLabelPalette, FacePattern } from '../../model/types';
import styles from './PanelContent.module.css';

/** 8-slot face layout positioned on a 3x3 grid. Centre cell labels the
 *  pattern; surrounding cells are slot dropdowns. Slot indices follow
 *  `DIRECTION_TAGS = [N, NE, E, SE, S, SW, W, NW]`. */
const SLOT_GRID_POS: Array<{ row: number; col: number; idx: number; tag: string }> = [
  { row: 0, col: 0, idx: 7, tag: 'NW' },
  { row: 0, col: 1, idx: 0, tag: 'N'  },
  { row: 0, col: 2, idx: 1, tag: 'NE' },
  { row: 1, col: 0, idx: 6, tag: 'W'  },
  { row: 1, col: 2, idx: 2, tag: 'E'  },
  { row: 2, col: 0, idx: 5, tag: 'SW' },
  { row: 2, col: 1, idx: 4, tag: 'S'  },
  { row: 2, col: 2, idx: 3, tag: 'SE' },
];

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export function VariegatedCellsPanelContent() {
  const {
    model,
    updateVariegatedCells,
    addFacePattern,
    duplicateFacePattern,
    removeFacePattern,
    updateFacePattern,
  } = useModel();

  const variegated = model.variegatedCells;
  const enabled = !!variegated?.enabled;

  // Selected face pattern (by id, not index, so it survives reorders / removes).
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(null);
  // Auto-select the most recently added pattern.
  const prevCount = useRef(variegated?.facePatterns.length ?? 0);
  useEffect(() => {
    const list = variegated?.facePatterns ?? [];
    if (list.length > prevCount.current) {
      const last = list[list.length - 1];
      if (last) setSelectedPatternId(last.id);
    }
    prevCount.current = list.length;
  }, [variegated?.facePatterns]);

  // Empty-state when the feature is off. Mirrors the messaging the
  // ActivityBar already hides — but the panel can still be reached via the
  // toggle-then-toggle flow, so the CTA is here for completeness.
  if (!enabled) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Variegated Cells</div>
        <p style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-tertiary)', lineHeight: 1.4, margin: 0 }}>
          The Variegated Cells feature is currently <strong>off</strong>. Enable it in{' '}
          <strong>Properties &rsaquo; Execution</strong>. Once on, this panel lets you
          configure face-label palettes, face patterns, and assign patterns to tag-attribute values.
        </p>
      </div>
    );
  }

  const safe = variegated!;
  const palettes = safe.facePalettes ?? [];
  const sourceAttr = model.attributes.find(a => a.id === safe.sourceAttributeId);
  const tagCellAttrs = model.attributes.filter(a => !a.isModelAttribute && a.type === 'tag');
  const selected = safe.facePatterns.find(p => p.id === selectedPatternId) ?? null;

  const handleDuplicate = () => { if (selected) duplicateFacePattern(selected.id); };
  const handleDelete = () => {
    if (selected) {
      removeFacePattern(selected.id);
      setSelectedPatternId(null);
    }
  };

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Variegation Source</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Source attribute (cell, tag)</label>
            <select
              className={styles.selectInput}
              value={safe.sourceAttributeId}
              onChange={e => updateVariegatedCells({ sourceAttributeId: e.target.value })}
            >
              <option value="">— select a tag cell attribute —</option>
              {tagCellAttrs.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--color-text-tertiary)', marginTop: 'var(--space-2)' }}>
              {tagCellAttrs.length === 0
                ? 'No tag cell attributes defined yet. Add one in the Attributes panel first.'
                : 'Each tag value of this attribute can be assigned a face pattern in the Attributes panel.'}
            </span>
          </div>
        </div>
      </div>

      <FacePalettesEditor
        palettes={palettes}
        onChange={facePalettes => updateVariegatedCells({ facePalettes })}
      />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Face Patterns</div>
        <div className={styles.list}>
          {safe.facePatterns.map(pattern => {
            const palName = palettes.find(p => p.id === pattern.paletteId)?.name;
            return (
              <div
                key={pattern.id}
                className={`${styles.listItem} ${selected?.id === pattern.id ? styles.listItemSelected : ''}`}
                onClick={() => setSelectedPatternId(pattern.id)}
              >
                <span className={styles.listItemName}>{pattern.name}</span>
                <span className={styles.listItemBadge}>
                  {palName ? `${palName} · ` : ''}{pattern.layoutMode === 'edges' ? '4 edges' : '8 slots'}
                </span>
              </div>
            );
          })}
          {safe.facePatterns.length === 0 && (
            <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--color-text-tertiary)', padding: 'var(--space-3) var(--space-4)' }}>
              No face patterns yet. Click <strong>+ Add Pattern</strong> below.
            </div>
          )}
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.addButton} onClick={() => addFacePattern()}>+ Add Pattern</button>
          <button className={styles.addButton} onClick={handleDuplicate} disabled={!selected}>
            Duplicate
          </button>
          <button className={styles.deleteButton} onClick={handleDelete} disabled={!selected}>
            Delete
          </button>
        </div>

        {selected && (
          <FacePatternEditor
            pattern={selected}
            palettes={palettes}
            isSourceSet={!!sourceAttr}
            onUpdate={changes => updateFacePattern(selected.id, changes)}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Face palettes editor — a list of named palettes, each with its own label
// list. Patterns reference a palette by id; tables key off a palette or a tag.
// ---------------------------------------------------------------------------

function FacePalettesEditor({
  palettes,
  onChange,
}: {
  palettes: FaceLabelPalette[];
  onChange: (palettes: FaceLabelPalette[]) => void;
}) {
  const addPalette = () => {
    const n = palettes.length + 1;
    onChange([...palettes, { id: genId(), name: `Palette ${n}`, labels: [] }]);
  };
  const updateAt = (idx: number, changes: Partial<FaceLabelPalette>) => {
    onChange(palettes.map((p, i) => (i === idx ? { ...p, ...changes } : p)));
  };
  const removeAt = (idx: number) => onChange(palettes.filter((_, i) => i !== idx));

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Face Label Palettes</div>
      <div className={styles.fieldGroup}>
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>
          Each palette is an independent set of face labels. A face pattern draws its slot
          labels from one palette; Lookup Tables can be keyed by any palette. The implicit
          <code>none</code> label is always present at index&nbsp;0.
        </span>
        {palettes.map((pal, pi) => (
          <div key={pal.id} style={{ border: '1px solid var(--color-border-muted)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
              <input
                className={styles.textInput}
                value={pal.name}
                onChange={e => updateAt(pi, { name: e.target.value })}
                style={{ flex: 1, fontWeight: 600 }}
                title="Palette name"
              />
              <button
                className={styles.deleteButton}
                style={{ padding: 'var(--space-1) var(--space-3)' }}
                onClick={() => removeAt(pi)}
                title={`Remove palette "${pal.name}"`}
              >&times;</button>
            </div>
            <FaceLabelEditor
              labels={pal.labels}
              onChange={labels => updateAt(pi, { labels })}
            />
          </div>
        ))}
        <button
          className={styles.addButton}
          style={{ marginTop: 'var(--space-2)' }}
          onClick={addPalette}
        >
          + Add Palette
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Face Label list editor — input rows with delete + add-new at the bottom.
// Operates on ONE palette's labels.
// ---------------------------------------------------------------------------

function FaceLabelEditor({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (labels: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const v = draft.trim();
    if (!v || v === 'none' || labels.includes(v)) return;
    onChange([...labels, v]);
    setDraft('');
  };
  const renameAt = (idx: number, newName: string) => {
    const next = labels.slice();
    next[idx] = newName;
    onChange(next);
  };
  const removeAt = (idx: number) => onChange(labels.filter((_, i) => i !== idx));
  const addDisabled = !draft.trim() || draft.trim() === 'none' || labels.includes(draft.trim());
  return (
    <div className={styles.fieldGroup} style={{ gap: 'var(--space-2)' }}>
      {labels.map((label, i) => (
        <div key={i} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--color-text-tertiary)', width: 16, flexShrink: 0 }}>
            {i + 1}
          </span>
          <input
            className={styles.textInput}
            value={label}
            onChange={e => renameAt(i, e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            className={styles.deleteButton}
            style={{ padding: 'var(--space-1) var(--space-3)' }}
            onClick={() => removeAt(i)}
            title={`Remove label "${label}"`}
          >&times;</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <input
          className={styles.textInput}
          placeholder="Add a label (e.g. H, LP, X, Y) and press Enter"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          style={{ flex: 1 }}
        />
        <button
          className={styles.addButton}
          style={{ flex: 'none', minWidth: 60 }}
          onClick={submit}
          disabled={addDisabled}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One face-pattern editor block (detail editor section, like Neighborhoods).
// ---------------------------------------------------------------------------

function FacePatternEditor({
  pattern,
  palettes,
  isSourceSet,
  onUpdate,
}: {
  pattern: FacePattern;
  palettes: FaceLabelPalette[];
  isSourceSet: boolean;
  onUpdate: (changes: Partial<FacePattern>) => void;
}) {
  // The palette this pattern draws labels from (default to the first palette).
  const activePaletteId = pattern.paletteId || palettes[0]?.id || '';
  const paletteLabels = palettes.find(p => p.id === activePaletteId)?.labels ?? [];

  const setFaceAt = (idx: number, value: string) => {
    const faces = pattern.faces.slice();
    while (faces.length < 8) faces.push(null);
    faces[idx] = value === 'none' ? null : value;
    onUpdate({ faces });
  };
  const setLayoutMode = (mode: 'edges' | 'edges+corners') => {
    let faces = pattern.faces.slice();
    while (faces.length < 8) faces.push(null);
    if (mode === 'edges') {
      faces = faces.map((f, i) => (i % 2 === 1 ? null : f));
    }
    onUpdate({ layoutMode: mode, faces });
  };
  const setPalette = (paletteId: string) => {
    // Changing palette invalidates existing slot labels — clear them so the
    // user re-picks from the new label space.
    onUpdate({ paletteId, faces: pattern.faces.map(() => null) });
  };

  return (
    <div className={styles.detailEditor}>
      <div className={styles.detailTitle}>{pattern.name || '(unnamed)'}</div>
      <div className={styles.fieldGroup}>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Name</label>
          <input
            className={styles.textInput}
            value={pattern.name}
            onChange={e => onUpdate({ name: e.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Palette</label>
          <select
            className={styles.selectInput}
            value={activePaletteId}
            onChange={e => setPalette(e.target.value)}
          >
            {palettes.length === 0 && <option value="">— add a palette first —</option>}
            {palettes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Layout mode</label>
          <div className={styles.checkboxRow} style={{ gap: 'var(--space-6)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
              <input
                type="radio"
                name={`layoutMode-${pattern.id}`}
                checked={pattern.layoutMode === 'edges'}
                onChange={() => setLayoutMode('edges')}
              />
              Edges only (N/E/S/W)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
              <input
                type="radio"
                name={`layoutMode-${pattern.id}`}
                checked={pattern.layoutMode === 'edges+corners'}
                onChange={() => setLayoutMode('edges+corners')}
              />
              Edges + corners
            </label>
          </div>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Faces</label>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gridTemplateRows: 'repeat(3, auto)',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-2)',
            }}
          >
            {SLOT_GRID_POS.slice(0, 3).map(slot => renderSlot(slot, pattern, paletteLabels, setFaceAt))}
            {renderSlot(SLOT_GRID_POS[3]!, pattern, paletteLabels, setFaceAt)}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--color-bg-canvas)',
                border: '1px dashed var(--color-border-muted)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-text-tertiary)',
                fontSize: 'var(--font-3xs)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                minHeight: 44,
                padding: 'var(--space-2)',
                textAlign: 'center',
              }}
              title="Cell centre"
            >
              {pattern.name || 'pattern'}
            </div>
            {renderSlot(SLOT_GRID_POS[4]!, pattern, paletteLabels, setFaceAt)}
            {SLOT_GRID_POS.slice(5, 8).map(slot => renderSlot(slot, pattern, paletteLabels, setFaceAt))}
          </div>
        </div>
        {!isSourceSet && (
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--color-warning)' }}>
            Select a Variegation Source attribute above so you can assign this pattern to a
            tag value (in the Attributes panel).
          </span>
        )}
      </div>
    </div>
  );
}

function renderSlot(
  slot: { row: number; col: number; idx: number; tag: string },
  pattern: FacePattern,
  paletteLabels: string[],
  setFaceAt: (idx: number, value: string) => void,
) {
  const isCorner = slot.idx % 2 === 1;
  const disabled = isCorner && pattern.layoutMode === 'edges';
  const value = pattern.faces[slot.idx];
  return (
    <div
      key={slot.idx}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 'var(--space-1)',
        gridRow: slot.row + 1,
        gridColumn: slot.col + 1,
      }}
    >
      <span
        style={{
          fontSize: 'var(--font-3xs)',
          color: 'var(--color-text-tertiary)',
          textAlign: 'center',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {slot.tag}
      </span>
      <select
        className={styles.selectInput}
        disabled={disabled}
        value={value === null || value === undefined ? '' : value}
        onChange={e => setFaceAt(slot.idx, e.target.value || 'none')}
        style={{
          padding: 'var(--space-1) var(--space-2)',
          fontSize: 'var(--font-2xs)',
          opacity: disabled ? 0.45 : 1,
        }}
        title={disabled ? 'Corners are disabled in "edges only" layout' : `Face label for ${slot.tag}`}
      >
        <option value="">none</option>
        {paletteLabels.map(label => (
          <option key={label} value={label}>{label}</option>
        ))}
      </select>
    </div>
  );
}
