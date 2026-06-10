import { useEffect, useRef } from 'react';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import { useModel } from '../../model/ModelContext';
import { useListReorder } from './useListReorder';
import { MODEL_ELEMENT_DRAG_MIME } from '../vpl/modelElementDrag';
import type { ModelElementDragPayload } from '../vpl/modelElementDrag';
import { setCurrentModelElementDrag } from '../vpl/graphState';
import { defaultGradientStops, defaultTagColor } from '../vpl/compiler/linkedOutputMappings';
import { GradientStopsEditor, type GradStop } from '../vpl/widgets/GradientStopsEditor';
import { INTERPOLATION_METHODS } from '../vpl/nodes/interpolationMethods';
import type { Mapping, RGB, ColorStop } from '../../model/types';
import { typeDisplayName } from '../../model/typeLabels';
import styles from './PanelContent.module.css';

function rgbToHex(c: RGB): string {
  const h = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}

function ColorSwatch({ value, onChange }: { value: RGB; onChange: (c: RGB) => void }) {
  return (
    <input
      type="color"
      value={rgbToHex(value)}
      onChange={e => onChange(hexToRgb(e.target.value))}
      style={{ width: 34, height: 22, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
    />
  );
}

/** Linked-mode editor for an Attribute→Color mapping: attribute picker plus
 *  per-type palette controls (color pickers + min/max). */
function LinkedOutputEditor({ selected }: { selected: Mapping }) {
  const { model, updateMapping } = useModel();
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const attr = model.attributes.find(a => a.id === selected.linkedAttributeId && !a.isModelAttribute);

  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 };
  const lblStyle: React.CSSProperties = { fontSize: 12 };

  const setGradient = (next: ColorStop[]) =>
    updateMapping(selected.id, { linkedColors: { ...selected.linkedColors, gradient: next } });

  const handleAttrChange = (id: string) => {
    const a = model.attributes.find(x => x.id === id);
    const changes: Partial<Mapping> = { linkedAttributeId: id, linkedColors: undefined };
    if (a && (a.type === 'float' || a.type === 'integer')) {
      changes.linkedMin = a.min ?? 0;
      changes.linkedMax = a.max ?? (a.type === 'integer' ? 10 : 1);
    } else {
      changes.linkedMin = undefined;
      changes.linkedMax = undefined;
    }
    updateMapping(selected.id, changes);
  };

  return (
    <>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>Linked attribute</label>
        <select
          className={styles.textInput}
          value={selected.linkedAttributeId ?? ''}
          onChange={e => handleAttrChange(e.target.value)}
        >
          <option value="">Select attribute…</option>
          {cellAttrs.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({typeDisplayName(a.type)})</option>
          ))}
        </select>
      </div>

      {attr && attr.type === 'bool' && (() => {
        const g = selected.linkedColors?.gradient ?? defaultGradientStops('bool');
        const c0: ColorStop = g[0] ?? { position: 0, r: 0, g: 0, b: 0 };
        const c1: ColorStop = g[1] ?? { position: 1, r: 255, g: 255, b: 255 };
        return (
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Colors</label>
            <div style={rowStyle}>
              <ColorSwatch value={c0} onChange={c => setGradient([{ position: 0, ...c }, c1])} />
              <span style={lblStyle}>False</span>
            </div>
            <div style={rowStyle}>
              <ColorSwatch value={c1} onChange={c => setGradient([c0, { position: 1, ...c }])} />
              <span style={lblStyle}>True</span>
            </div>
          </div>
        );
      })()}

      {attr && (attr.type === 'float' || attr.type === 'integer') && (() => {
        const g = selected.linkedColors?.gradient ?? defaultGradientStops(attr.type);
        const editorStops: GradStop[] = g.map(s => ({ p: s.position, r: s.r, g: s.g, b: s.b }));
        const onStops = (next: GradStop[]) =>
          setGradient(next.map(s => ({ position: s.p, r: s.r, g: s.g, b: s.b })));
        const min = selected.linkedMin ?? attr.min ?? 0;
        const max = selected.linkedMax ?? attr.max ?? (attr.type === 'integer' ? 10 : 1);
        return (
          <>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Range (maps to the scale&apos;s 0 → 1)</label>
              <div style={rowStyle}>
                <input className={styles.textInput} type="number" step="any" lang="en" inputMode="decimal"
                  style={{ width: 80 }} value={min}
                  onChange={e => updateMapping(selected.id, { linkedMin: Number(e.target.value) })} />
                <span style={lblStyle}>min</span>
                <input className={styles.textInput} type="number" step="any" lang="en" inputMode="decimal"
                  style={{ width: 80 }} value={max}
                  onChange={e => updateMapping(selected.id, { linkedMax: Number(e.target.value) })} />
                <span style={lblStyle}>max</span>
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Color scale</label>
              <GradientStopsEditor stops={editorStops} onChange={onStops} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Curve</label>
              <select
                className={styles.textInput}
                value={(selected.linkedColors?.method as string) || 'linear'}
                onChange={e => updateMapping(selected.id, { linkedColors: { ...selected.linkedColors, method: e.target.value } })}
              >
                {INTERPOLATION_METHODS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </>
        );
      })()}

      {attr && attr.type === 'tag' && (() => {
        const opts = attr.tagOptions ?? [];
        const colorAt = (i: number) => selected.linkedColors?.tag?.[i] ?? defaultTagColor(i, opts.length);
        const setTagAt = (i: number, c: RGB) => {
          const arr = opts.map((_, j) => (j === i ? c : colorAt(j)));
          updateMapping(selected.id, { linkedColors: { ...selected.linkedColors, tag: arr } });
        };
        return (
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Tag colors</label>
            {opts.map((opt, i) => (
              <div key={i} style={rowStyle}>
                <ColorSwatch value={colorAt(i)} onChange={c => setTagAt(i, c)} />
                <span style={lblStyle}>{opt}</span>
              </div>
            ))}
            {opts.length === 0 && <span style={lblStyle}>This tag attribute has no options.</span>}
          </div>
        );
      })()}
    </>
  );
}

function handleMappingDragStart(mappingId: string, isAttributeToColor: boolean) {
  return (e: React.DragEvent) => {
    const payload: ModelElementDragPayload = isAttributeToColor
      ? { kind: 'mapping-a2c', mappingId }
      : { kind: 'mapping-c2a', mappingId };
    e.dataTransfer.setData(MODEL_ELEMENT_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
    setCurrentModelElementDrag(payload);
  };
}

function handleMappingDragEnd() {
  setCurrentModelElementDrag(null);
}

export function MappingsPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const { model, addMapping, removeMapping, updateMapping, reorderMappings } = useModel();
  const [selectedId, setSelectedId] = useDetailSelection('mappings');

  const attrToColor = model.mappings.filter(m => m.isAttributeToColor);
  const colorToAttr = model.mappings.filter(m => !m.isAttributeToColor);

  // Independent reorder within each group — the other group is appended in its existing order.
  const acReorder = useListReorder(attrToColor, newOrder => {
    const map = new Map(attrToColor.map(m => [m.id, m]));
    reorderMappings([...newOrder.map(id => map.get(id)!).filter(Boolean), ...colorToAttr].map(m => m.id));
  });
  const caReorder = useListReorder(colorToAttr, newOrder => {
    const map = new Map(colorToAttr.map(m => [m.id, m]));
    reorderMappings([...attrToColor, ...newOrder.map(id => map.get(id)!).filter(Boolean)].map(m => m.id));
  });

  // Auto-select & scroll to newly added mappings
  const prevCount = useRef(model.mappings.length);
  useEffect(() => {
    if (model.mappings.length > prevCount.current) {
      const newItem = model.mappings[model.mappings.length - 1];
      if (newItem) {
        setSelectedId(newItem.id);
        setTimeout(() => {
          document.getElementById(`mapping-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevCount.current = model.mappings.length;
  }, [model.mappings]);
  const selected = model.mappings.find(m => m.id === selectedId);

  const handleDelete = () => {
    if (selectedId) {
      removeMapping(selectedId);
      setSelectedId(null);
    }
  };

  return (
    <>
      {mode !== 'detail' && (<>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Attribute &rarr; Color (Output)
        </div>
        <div className={styles.list} data-reorder-list>
          {attrToColor.map((m, i) => {
            const isDragging = acReorder.dragState?.id === m.id;
            const srcIdx = acReorder.dragState ? attrToColor.findIndex(x => x.id === acReorder.dragState!.id) : -1;
            const showBefore = acReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = acReorder.dragState?.overIdx === attrToColor.length && i === attrToColor.length - 1 && srcIdx !== i;
            return (
              <div
                key={m.id}
                id={`mapping-${m.id}`}
                data-reorder-row
                className={`${styles.listItem} ${selectedId === m.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => setSelectedId(m.id)}
                draggable
                onDragStart={handleMappingDragStart(m.id, true)}
                onDragEnd={handleMappingDragEnd}
                title={`Drag to canvas to add a node that uses '${m.name}'`}
              >
                <span className={styles.listItemName}>{m.name}</span>
                <span className={styles.listItemBadge}>A&rarr;C</span>
                <button className={styles.dragHandle} title="Drag to reorder"
                  onPointerDown={acReorder.startDrag(m.id)}
                  onClick={e => e.stopPropagation()}>⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addMapping(true)}
          >
            + Add A&rarr;C Mapping
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Color &rarr; Attribute (Input)
        </div>
        <div className={styles.list} data-reorder-list>
          {colorToAttr.map((m, i) => {
            const isDragging = caReorder.dragState?.id === m.id;
            const srcIdx = caReorder.dragState ? colorToAttr.findIndex(x => x.id === caReorder.dragState!.id) : -1;
            const showBefore = caReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = caReorder.dragState?.overIdx === colorToAttr.length && i === colorToAttr.length - 1 && srcIdx !== i;
            return (
              <div
                key={m.id}
                id={`mapping-${m.id}`}
                data-reorder-row
                className={`${styles.listItem} ${selectedId === m.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => setSelectedId(m.id)}
                draggable
                onDragStart={handleMappingDragStart(m.id, false)}
                onDragEnd={handleMappingDragEnd}
                title={`Drag to canvas to add a node that uses '${m.name}'`}
              >
                <span className={styles.listItemName}>{m.name}</span>
                <span className={styles.listItemBadge}>C&rarr;A</span>
                <button className={styles.dragHandle} title="Drag to reorder"
                  onPointerDown={caReorder.startDrag(m.id)}
                  onClick={e => e.stopPropagation()}>⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addMapping(false)}
          >
            + Add C&rarr;A Mapping
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      </>)}

      {mode === 'detail' && selected && (
        <div className={styles.detailEditor}>
          <div className={styles.detailTitle}>Edit: {selected.name}</div>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selected.name}
                onChange={e =>
                  updateMapping(selected.id, { name: e.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.description}
                onChange={e =>
                  updateMapping(selected.id, { description: e.target.value })
                }
              />
            </div>
            {selected.isAttributeToColor && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Color pass</label>
                <select
                  className={styles.textInput}
                  value={selected.linked ? 'linked' : 'standalone'}
                  onChange={e => updateMapping(selected.id, { linked: e.target.value === 'linked' })}
                >
                  <option value="standalone">Standalone</option>
                  <option value="linked">Linked</option>
                </select>
                <span style={{ color: '#888', fontSize: '0.66rem', marginTop: 3, display: 'block' }}>
                  {selected.linked
                    ? 'Auto-generates the color pass from a chosen attribute. If you also add an Output Mapping node for this mapping, the auto pass runs first as a background and your graph overrides the cells it paints.'
                    : 'You build the color pass by hand in the graph (Output Mapping → … → Set Color Viewer).'}
                </span>
              </div>
            )}
            {selected.isAttributeToColor && selected.linked && (
              <LinkedOutputEditor selected={selected} />
            )}
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelRed}`}
              >
                Red Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.redDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    redDescription: e.target.value,
                  })
                }
              />
            </div>
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelGreen}`}
              >
                Green Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.greenDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    greenDescription: e.target.value,
                  })
                }
              />
            </div>
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelBlue}`}
              >
                Blue Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.blueDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    blueDescription: e.target.value,
                  })
                }
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
