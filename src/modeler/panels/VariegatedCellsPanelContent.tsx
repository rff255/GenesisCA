import { useState } from 'react';
import { useModel } from '../../model/ModelContext';
import type { FacePattern } from '../../model/types';
import styles from './PanelContent.module.css';

/** The 8 face slot indices follow `DIRECTION_TAGS = [N,NE,E,SE,S,SW,W,NW]`.
 *  Rendered as a 3x3 grid; the centre cell labels the pattern and shows the
 *  layout-mode toggle below it. The four corner slots are disabled in
 *  `edges` layout mode (face value forced to null). */
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

  // Empty state: feature disabled.
  if (!enabled) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Variegated Cells</div>
        <div style={{ padding: '12px 8px', fontSize: '0.75rem', color: '#888', lineHeight: 1.4 }}>
          The Variegated Cells feature is currently <strong>off</strong>.
          <br /><br />
          Enable it in <strong>Properties &rsaquo; Execution</strong> by checking
          &ldquo;Use Variegated Cells (Directional Interactions)&rdquo;. Once enabled, this
          panel lets you configure face labels, face patterns, and assign patterns to
          tag-attribute values.
          <br /><br />
          Variegated Cells adds a per-cell <strong>orientation</strong> (0-3 = 90&deg; rotations)
          and face-pattern labels (N/E/S/W edges, optionally corners) for directional
          rules used in chemistry CA models (water-aabb, micelle formation, chirality).
        </div>
      </div>
    );
  }

  const safe = variegated!; // typeguarded by enabled check above
  const sourceAttr = model.attributes.find(a => a.id === safe.sourceAttributeId);
  const tagCellAttrs = model.attributes.filter(
    a => !a.isModelAttribute && a.type === 'tag',
  );

  return (
    <>
      {/* Variegation Source */}
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
            <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 4, display: 'block' }}>
              {tagCellAttrs.length === 0
                ? 'No tag cell attributes defined yet. Add one in the Attributes panel first.'
                : 'Each tag value of this attribute can be assigned a face pattern (in Attributes panel).'}
            </span>
          </div>
        </div>
      </div>

      {/* Face Label Palette */}
      <FaceLabelEditor
        labels={safe.faceLabels}
        onChange={faceLabels => updateVariegatedCells({ faceLabels })}
      />

      {/* Face Patterns */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Face Patterns
          <button
            type="button"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: '0.7rem', cursor: 'pointer', background: '#2d4059', color: '#eee', border: '1px solid #4a6a8a', borderRadius: 3 }}
            onClick={() => addFacePattern()}
            title="Add a new face pattern"
          >+ Add</button>
        </div>
        <div className={styles.fieldGroup}>
          {safe.facePatterns.length === 0 && (
            <div style={{ padding: '6px 0', color: '#888', fontSize: '0.68rem' }}>
              No face patterns yet. Click <strong>+ Add</strong> to create one, then assign it to a
              source-attribute tag value in the Attributes panel.
            </div>
          )}
          {safe.facePatterns.map(pattern => (
            <FacePatternEditor
              key={pattern.id}
              pattern={pattern}
              faceLabels={safe.faceLabels}
              isSourceSet={!!sourceAttr}
              onUpdate={changes => updateFacePattern(pattern.id, changes)}
              onDuplicate={() => duplicateFacePattern(pattern.id)}
              onRemove={() => removeFacePattern(pattern.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Face Label palette editor
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
    if (!v) return;
    if (v === 'none') return; // reserved
    if (labels.includes(v)) return;
    onChange([...labels, v]);
    setDraft('');
  };
  const renameAt = (idx: number, newName: string) => {
    const next = labels.slice();
    next[idx] = newName;
    onChange(next);
  };
  const removeAt = (idx: number) => {
    onChange(labels.filter((_, i) => i !== idx));
  };
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Face Label Palette</div>
      <div className={styles.fieldGroup}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: '#888' }}>
            <span style={{ fontStyle: 'italic' }}>none</span>
            <span style={{ flex: 1, fontSize: '0.62rem' }}>
              (implicit; used for unassigned slots and non-variegated neighbors)
            </span>
          </div>
          {labels.map((label, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="text"
                className={styles.textInput}
                value={label}
                onChange={e => renameAt(i, e.target.value)}
                style={{ flex: 1, fontSize: '0.72rem' }}
              />
              <button
                type="button"
                style={{ padding: '2px 8px', fontSize: '0.7rem', cursor: 'pointer', background: '#2d4059', color: '#eee', border: '1px solid #4a6a8a', borderRadius: 3 }}
                onClick={() => removeAt(i)}
                title={`Remove label "${label}"`}
              >×</button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <input
              type="text"
              className={styles.textInput}
              placeholder="Add a label and press Enter (e.g. H, LP, X, Y)"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              style={{ flex: 1, fontSize: '0.72rem' }}
            />
            <button
              type="button"
              style={{ padding: '2px 8px', fontSize: '0.7rem', cursor: 'pointer', background: '#2d4059', color: '#eee', border: '1px solid #4a6a8a', borderRadius: 3 }}
              onClick={submit}
              disabled={!draft.trim() || labels.includes(draft.trim()) || draft.trim() === 'none'}
            >Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One face-pattern editor block
// ---------------------------------------------------------------------------

function FacePatternEditor({
  pattern,
  faceLabels,
  isSourceSet,
  onUpdate,
  onDuplicate,
  onRemove,
}: {
  pattern: FacePattern;
  faceLabels: string[];
  isSourceSet: boolean;
  onUpdate: (changes: Partial<FacePattern>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const setFaceAt = (idx: number, value: string) => {
    const faces = pattern.faces.slice();
    while (faces.length < 8) faces.push(null);
    faces[idx] = value === 'none' ? null : value;
    onUpdate({ faces });
  };
  const setLayoutMode = (mode: 'edges' | 'edges+corners') => {
    // When switching to 'edges', null out the corner slots (1, 3, 5, 7).
    let faces = pattern.faces.slice();
    while (faces.length < 8) faces.push(null);
    if (mode === 'edges') {
      faces = faces.map((f, i) => (i % 2 === 1 ? null : f));
    }
    onUpdate({ layoutMode: mode, faces });
  };

  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        border: '1px solid #333',
        borderRadius: 4,
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <input
          type="text"
          className={styles.textInput}
          value={pattern.name}
          onChange={e => onUpdate({ name: e.target.value })}
          style={{ flex: 1, fontSize: '0.74rem', fontWeight: 600 }}
        />
        <button
          type="button"
          className={styles.smallButton}
          onClick={onDuplicate}
          title="Duplicate this pattern"
        >Dup</button>
        <button
          type="button"
          className={styles.smallButton}
          onClick={onRemove}
          title="Delete this pattern"
        >×</button>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 6, fontSize: '0.66rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="radio"
            name={`layoutMode-${pattern.id}`}
            checked={pattern.layoutMode === 'edges'}
            onChange={() => setLayoutMode('edges')}
          />
          Edges only (N/E/S/W)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="radio"
            name={`layoutMode-${pattern.id}`}
            checked={pattern.layoutMode === 'edges+corners'}
            onChange={() => setLayoutMode('edges+corners')}
          />
          Edges + corners
        </label>
      </div>

      {/* 3x3 grid of face-label dropdowns */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gridTemplateRows: 'repeat(3, 1fr)',
          gap: 3,
        }}
      >
        {SLOT_GRID_POS.slice(0, 3).map(slot => renderSlot(slot, pattern, faceLabels, setFaceAt))}
        {/* row 1 (W, centre, E) */}
        {renderSlot(SLOT_GRID_POS[3]!, pattern, faceLabels, setFaceAt)}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#1a2030',
            color: '#888',
            fontSize: '0.6rem',
            borderRadius: 2,
            minHeight: 36,
          }}
          title="Cell centre"
        >
          {pattern.name || 'pattern'}
        </div>
        {renderSlot(SLOT_GRID_POS[4]!, pattern, faceLabels, setFaceAt)}
        {/* row 2 */}
        {SLOT_GRID_POS.slice(5, 8).map(slot => renderSlot(slot, pattern, faceLabels, setFaceAt))}
      </div>

      {!isSourceSet && (
        <div style={{ marginTop: 6, fontSize: '0.62rem', color: '#cc8d3a' }}>
          Select a Variegation Source attribute above so you can assign this pattern to a
          tag value (in the Attributes panel).
        </div>
      )}
    </div>
  );
}

function renderSlot(
  slot: { row: number; col: number; idx: number; tag: string },
  pattern: FacePattern,
  faceLabels: string[],
  setFaceAt: (idx: number, value: string) => void,
) {
  const isCorner = slot.idx % 2 === 1;
  const disabled = isCorner && pattern.layoutMode === 'edges';
  const value = pattern.faces[slot.idx] ?? '';
  return (
    <div
      key={slot.idx}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'stretch',
        gap: 1, gridRow: slot.row + 1, gridColumn: slot.col + 1,
      }}
    >
      <span style={{ fontSize: '0.55rem', color: '#888', textAlign: 'center' }}>{slot.tag}</span>
      <select
        disabled={disabled}
        value={value === null ? '' : value}
        onChange={e => setFaceAt(slot.idx, e.target.value || 'none')}
        style={{ fontSize: '0.65rem', padding: '1px 2px', opacity: disabled ? 0.4 : 1 }}
        title={disabled ? 'Corners are disabled in "edges only" layout' : `Face label for ${slot.tag}`}
      >
        <option value="">none</option>
        {faceLabels.map(label => (
          <option key={label} value={label}>{label}</option>
        ))}
      </select>
    </div>
  );
}
