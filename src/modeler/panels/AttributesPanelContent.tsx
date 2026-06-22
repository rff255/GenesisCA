import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useModel } from '../../model/ModelContext';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import type { Attribute, AttributeType, CAModel, LookupKeySource } from '../../model/types';
import { LookupTableEditor } from './LookupTableEditor';
import { resolveKeyLabels } from '../vpl/compiler/variegation';
import { useListReorder } from './useListReorder';
import { NeighborIndexDefaultEditor } from './NeighborIndexDefaultEditor';
import { VariablesPanelSection } from './VariablesPanelSection';
import { MODEL_ELEMENT_DRAG_MIME } from '../vpl/modelElementDrag';
import type { ModelElementDragPayload } from '../vpl/modelElementDrag';
import { setCurrentModelElementDrag, subscribeActiveGraphKind, getActiveGraphKind } from '../vpl/graphState';
import { typeDisplayName } from '../../model/typeLabels';
import { NumberField, InlineNumberInput } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';

/** Build the drag payload for an attribute row. Cell vs Model attribute drop
 *  on the canvas opens different related-node menus (cell attrs get reads /
 *  writes / neighbor accessors; model attrs get GetModelAttribute). */
function buildAttrDragPayload(attr: Attribute): ModelElementDragPayload {
  if (attr.isModelAttribute) {
    return { kind: 'model-attribute', attributeId: attr.id, isColor: attr.type === 'color' };
  }
  // Schema invariant: cell attrs never have type `'lookupTable'` (the
  // Attributes panel's type dropdown excludes it for cell attrs). Cast away
  // the wider AttributeType to satisfy the drag payload's restricted union.
  return { kind: 'cell-attribute', attributeId: attr.id, attrType: attr.type as 'bool' | 'integer' | 'float' | 'tag' | 'color' | 'neighborIndex' };
}

/** Row/column key-source picker for a Lookup Table attribute. Lists the model's
 *  face-label palettes (only when Variegated Cells is enabled) plus every tag
 *  attribute. An axis keyed by a tag attribute needs no faces at all. */
function KeySourceField({ label, value, model, onChange }: {
  label: string;
  value: LookupKeySource | undefined;
  model: CAModel;
  onChange: (src: LookupKeySource | undefined) => void;
}) {
  const palettes = model.variegatedCells?.enabled ? (model.variegatedCells.facePalettes ?? []) : [];
  const tagAttrs = model.attributes.filter(a => a.type === 'tag');
  const current = value
    ? value.kind === 'facePalette' ? `palette:${value.paletteId}`
      : value.kind === 'tagAttribute' ? `tag:${value.attributeId}`
      : 'single'
    : '';
  return (
    <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.66rem' }}>
      <span style={{ color: '#7a8a9a' }}>{label}</span>
      <select
        className={styles.selectInput}
        value={current}
        onChange={e => {
          const v = e.target.value;
          if (v === 'single') { onChange({ kind: 'single' }); return; }
          const ci = v.indexOf(':');
          if (ci < 0) { onChange(undefined); return; }
          const kind = v.slice(0, ci);
          const id = v.slice(ci + 1);
          onChange(kind === 'palette' ? { kind: 'facePalette', paletteId: id } : { kind: 'tagAttribute', attributeId: id });
        }}
      >
        <option value="">— select —</option>
        <option value="single">Single value (map)</option>
        {palettes.length > 0 && (
          <optgroup label="Face palettes">
            {palettes.map(p => <option key={p.id} value={`palette:${p.id}`}>{p.name}</option>)}
          </optgroup>
        )}
        <optgroup label="Tag attributes">
          {tagAttrs.map(a => <option key={a.id} value={`tag:${a.id}`}>{a.name}</option>)}
        </optgroup>
      </select>
    </label>
  );
}

function handleRowDragStart(payload: ModelElementDragPayload) {
  return (e: React.DragEvent) => {
    e.dataTransfer.setData(MODEL_ELEMENT_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
    setCurrentModelElementDrag(payload);
  };
}

function handleRowDragEnd() {
  setCurrentModelElementDrag(null);
}

export function AttributesPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const { model, addAttribute, removeAttribute, updateAttribute, reorderAttributes } = useModel();
  // Bond-Graph Agents: the same cell attributes double as per-agent attributes
  // (Decision D-IDX). On the Agents sub-tab the section header reads "Agent
  // Attributes" — UI-only, the ids are unchanged. (Re-renders on sub-tab swap.)
  const activeGraphKind = useSyncExternalStore(subscribeActiveGraphKind, getActiveGraphKind);
  const cellAttrLabel = (activeGraphKind === 'agents' && model.topologyMode?.agents) ? 'Agent Attributes' : 'Cell Attributes';
  // 3D Grid CA: neighborIndex attribute values pack 3 axes in a 3D model.
  const is3dModel = model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
  // One discriminated selection slot for this panel: `attr:<id>` or `var:<id>`.
  // Attributes and Local Variables share the single second detail panel, so
  // selecting one kind clears the other.
  const [sel, setSel] = useDetailSelection('attributes');
  const selKind: 'attr' | 'var' = sel?.startsWith('var:') ? 'var' : 'attr';
  const selAttrId = sel && selKind === 'attr' ? sel.replace(/^attr:/, '') : null;
  const selVarId = sel && selKind === 'var' ? sel.slice(4) : null;
  const selectAttr = (id: string | null) => setSel(id ? `attr:${id}` : null);
  const selectVar = (id: string | null) => setSel(id ? `var:${id}` : null);

  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);

  // Independent reorder within each group — preserve the other group's order in the combined array.
  const cellReorder = useListReorder(cellAttrs, newOrder => {
    const map = new Map(cellAttrs.map(a => [a.id, a]));
    reorderAttributes([...newOrder.map(id => map.get(id)!).filter(Boolean), ...modelAttrs].map(a => a.id));
  });
  const modelReorder = useListReorder(modelAttrs, newOrder => {
    const map = new Map(modelAttrs.map(a => [a.id, a]));
    reorderAttributes([...cellAttrs, ...newOrder.map(id => map.get(id)!).filter(Boolean)].map(a => a.id));
  });

  // Auto-select & scroll to newly added items
  const prevAttrCount = useRef(model.attributes.length);
  useEffect(() => {
    if (model.attributes.length > prevAttrCount.current) {
      const newItem = model.attributes[model.attributes.length - 1];
      if (newItem) {
        selectAttr(newItem.id);
        setTimeout(() => {
          document.getElementById(`attr-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevAttrCount.current = model.attributes.length;
  }, [model.attributes]);
  const selected = selAttrId ? model.attributes.find(a => a.id === selAttrId) : undefined;

  const handleDelete = () => {
    if (selAttrId) {
      removeAttribute(selAttrId);
      setSel(null);
    }
  };

  return (
    <>
      {mode !== 'detail' && (<>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{cellAttrLabel}</div>
        <div className={styles.list} data-reorder-list>
          {cellAttrs.map((attr, i) => {
            const isDragging = cellReorder.dragState?.id === attr.id;
            const srcIdx = cellReorder.dragState ? cellAttrs.findIndex(a => a.id === cellReorder.dragState!.id) : -1;
            const showBefore = cellReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = cellReorder.dragState?.overIdx === cellAttrs.length && i === cellAttrs.length - 1 && srcIdx !== i;
            return (
              <div
                key={attr.id}
                id={`attr-${attr.id}`}
                data-reorder-row
                className={`${styles.listItem} ${sel === `attr:${attr.id}` ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => selectAttr(attr.id)}
                draggable
                onDragStart={handleRowDragStart(buildAttrDragPayload(attr))}
                onDragEnd={handleRowDragEnd}
                title={`Drag to canvas to add a node that uses '${attr.name}'`}
              >
                <span className={styles.listItemName}>{attr.name}</span>
                <span className={styles.listItemBadge}>{typeDisplayName(attr.type)}</span>
                <button
                  className={styles.dragHandle}
                  title="Drag to reorder"
                  onPointerDown={cellReorder.startDrag(attr.id)}
                  onClick={e => e.stopPropagation()}
                >⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addAttribute(false)}
          >
            + Add Cell Attribute
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Model Attributes</div>
        <div className={styles.list} data-reorder-list>
          {modelAttrs.length === 0 && (
            <p
              style={{
                fontSize: '0.75rem',
                color: '#6080a0',
                fontStyle: 'italic',
                padding: '4px 0',
              }}
            >
              No model attributes defined.
            </p>
          )}
          {modelAttrs.map((attr, i) => {
            const isDragging = modelReorder.dragState?.id === attr.id;
            const srcIdx = modelReorder.dragState ? modelAttrs.findIndex(a => a.id === modelReorder.dragState!.id) : -1;
            const showBefore = modelReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = modelReorder.dragState?.overIdx === modelAttrs.length && i === modelAttrs.length - 1 && srcIdx !== i;
            return (
              <div
                key={attr.id}
                id={`attr-${attr.id}`}
                data-reorder-row
                className={`${styles.listItem} ${sel === `attr:${attr.id}` ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => selectAttr(attr.id)}
                draggable
                onDragStart={handleRowDragStart(buildAttrDragPayload(attr))}
                onDragEnd={handleRowDragEnd}
                title={`Drag to canvas to add a node that uses '${attr.name}'`}
              >
                <span className={styles.listItemName}>{attr.name}</span>
                <span className={styles.listItemBadge}>{typeDisplayName(attr.type)}</span>
                <button
                  className={styles.dragHandle}
                  title="Drag to reorder"
                  onPointerDown={modelReorder.startDrag(attr.id)}
                  onClick={e => e.stopPropagation()}
                >⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addAttribute(true)}
          >
            + Add Model Attribute
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      <VariablesPanelSection mode="list" selectedId={selVarId} onSelect={selectVar} />
      </>)}

      {mode === 'detail' && selKind === 'attr' && selected && (
        <div className={styles.detailEditor}>
          <div className={styles.detailTitle}>Edit: {selected.name}</div>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selected.name}
                onChange={e =>
                  updateAttribute(selected.id, { name: e.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Type</label>
              <select
                className={styles.selectInput}
                value={selected.type}
                onChange={e => {
                  const newType = e.target.value as AttributeType;
                  const resetDefaults: Record<string, string> = {
                    bool: 'false', integer: '0', float: '0', list: '', tag: '', color: '#808080',
                    neighborIndex: '0',
                  };
                  updateAttribute(selected.id, {
                    type: newType,
                    defaultValue: resetDefaults[newType] ?? '',
                  });
                }}
              >
                <option value="bool">Binary</option>
                <option value="integer">Integer</option>
                <option value="float">Decimal</option>
                <option value="tag">Tag</option>
                <option value="neighborIndex">Neighbor Index</option>
                {selected.isModelAttribute && <option value="color">Color</option>}
                {selected.isModelAttribute && <option value="lookupTable">Lookup Table</option>}
              </select>
            </div>
            {selected.type === 'lookupTable' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Lookup Table</label>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <KeySourceField label="Rows" value={selected.rowKeySource} model={model}
                    onChange={src => updateAttribute(selected.id, { rowKeySource: src })} />
                  <KeySourceField label="Columns" value={selected.colKeySource} model={model}
                    onChange={src => updateAttribute(selected.id, { colKeySource: src })} />
                </div>
                <LookupTableEditor
                  attribute={selected}
                  rowLabels={resolveKeyLabels(selected.rowKeySource, model)}
                  colLabels={resolveKeyLabels(selected.colKeySource, model)}
                  onChange={changes => updateAttribute(selected.id, changes)}
                />
              </div>
            )}
            {selected.type !== 'lookupTable' && (<>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Default Value</label>
              {selected.type === 'bool' ? (
                <select
                  className={styles.selectInput}
                  value={selected.defaultValue === 'true' ? 'true' : 'false'}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                >
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              ) : selected.type === 'integer' ? (
                <NumberField
                  className={styles.numberInput}
                  integer
                  value={selected.defaultValue}
                  onNumber={n =>
                    updateAttribute(selected.id, { defaultValue: String(n) })
                  }
                />
              ) : selected.type === 'float' ? (
                <InlineNumberInput
                  className={styles.numberInput}
                  value={selected.defaultValue}
                  onChange={next =>
                    updateAttribute(selected.id, { defaultValue: next })
                  }
                />
              ) : selected.type === 'color' ? (
                <input
                  type="color"
                  value={selected.defaultValue || '#808080'}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                  style={{ width: '100%', height: 30, border: 'none', cursor: 'pointer' }}
                />
              ) : selected.type === 'tag' ? (
                <select
                  className={styles.selectInput}
                  value={selected.defaultValue || '0'}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                >
                  {(selected.tagOptions || []).map((tag, i) => (
                    <option key={i} value={String(i)}>{tag}</option>
                  ))}
                  {(!selected.tagOptions || selected.tagOptions.length === 0) && (
                    <option value="0">(no tags defined)</option>
                  )}
                </select>
              ) : selected.type === 'neighborIndex' ? (
                <NeighborIndexDefaultEditor
                  attribute={selected}
                  onChange={cfg => updateAttribute(selected.id, cfg)}
                  neighborhoods={model.neighborhoods}
                  is3d={is3dModel}
                />
              ) : (
                <input
                  className={styles.textInput}
                  value={selected.defaultValue}
                  onChange={e =>
                    updateAttribute(selected.id, { defaultValue: e.target.value })
                  }
                />
              )}
            </div>

            </>)}
            {/* Boundary Value — cell attributes only, shown when boundary treatment is constant. */}
            {!selected.isModelAttribute && model.properties.boundaryTreatment === 'constant' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} title="Value held by out-of-grid cells when boundary is constant. Blank = use Default Value.">
                  Boundary Value
                </label>
                {selected.type === 'bool' ? (
                  <select
                    className={styles.selectInput}
                    value={selected.boundaryValue ?? selected.defaultValue}
                    onChange={e => updateAttribute(selected.id, { boundaryValue: e.target.value })}
                  >
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                ) : selected.type === 'integer' ? (
                  <NumberField
                    className={styles.numberInput}
                    integer
                    value={selected.boundaryValue}
                    placeholder={`(default: ${selected.defaultValue})`}
                    onNumber={n => updateAttribute(selected.id, { boundaryValue: String(n) })}
                    onClear={() => updateAttribute(selected.id, { boundaryValue: undefined })}
                  />
                ) : selected.type === 'float' ? (
                  <NumberField
                    className={styles.numberInput}
                    value={selected.boundaryValue}
                    placeholder={`(default: ${selected.defaultValue})`}
                    onNumber={n => updateAttribute(selected.id, { boundaryValue: String(n) })}
                    onClear={() => updateAttribute(selected.id, { boundaryValue: undefined })}
                  />
                ) : selected.type === 'tag' ? (
                  <select
                    className={styles.selectInput}
                    value={selected.boundaryValue ?? selected.defaultValue ?? '0'}
                    onChange={e => updateAttribute(selected.id, { boundaryValue: e.target.value })}
                  >
                    {(selected.tagOptions || []).map((tag, i) => (
                      <option key={i} value={String(i)}>{tag}</option>
                    ))}
                    {(!selected.tagOptions || selected.tagOptions.length === 0) && (
                      <option value="0">(no tags defined)</option>
                    )}
                  </select>
                ) : selected.type === 'neighborIndex' ? (
                  <NeighborIndexDefaultEditor
                    attribute={selected}
                    onChange={cfg => updateAttribute(selected.id, cfg)}
                    neighborhoods={model.neighborhoods}
                    mode="boundary"
                    is3d={is3dModel}
                  />
                ) : (
                  <input
                    className={styles.textInput}
                    value={selected.boundaryValue ?? ''}
                    placeholder={`(default: ${selected.defaultValue})`}
                    onChange={e => updateAttribute(selected.id, {
                      boundaryValue: e.target.value === '' ? undefined : e.target.value,
                    })}
                  />
                )}
              </div>
            )}

            {selected.type === 'tag' && (() => {
              const isVariegationSource = !!model.variegatedCells?.enabled
                && model.variegatedCells.sourceAttributeId === selected.id
                && !selected.isModelAttribute;
              const facePatterns = model.variegatedCells?.facePatterns || [];
              const assignments = selected.facePatternAssignments || {};
              return (
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    Tag Options
                    {isVariegationSource && (
                      <span style={{ color: '#6080a0', fontWeight: 'normal', marginLeft: 6, fontSize: '0.66rem' }}>
                        (Variegation Source — assign a face pattern per option)
                      </span>
                    )}
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(selected.tagOptions || []).map((tag, i) => (
                      <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <span style={{ fontSize: '0.7rem', color: '#6080a0', width: 16 }}>{i}</span>
                        <input
                          className={styles.textInput}
                          value={tag}
                          onChange={e => {
                            const opts = [...(selected.tagOptions || [])];
                            opts[i] = e.target.value;
                            updateAttribute(selected.id, { tagOptions: opts });
                          }}
                          style={{ flex: 1 }}
                        />
                        {isVariegationSource && (
                          <select
                            className={styles.selectInput}
                            style={{ flex: 1, fontSize: '0.66rem' }}
                            value={assignments[tag] ?? ''}
                            onChange={e => {
                              const next: Record<string, string> = { ...assignments };
                              if (e.target.value) next[tag] = e.target.value;
                              else delete next[tag];
                              updateAttribute(selected.id, { facePatternAssignments: next });
                            }}
                            title={`Face pattern for tag "${tag}"`}
                          >
                            <option value="">— none (non-variegated) —</option>
                            {facePatterns.map(fp => (
                              <option key={fp.id} value={fp.id}>{fp.name}</option>
                            ))}
                          </select>
                        )}
                        <button
                          className={styles.deleteButton}
                          style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                          onClick={() => {
                            const opts = (selected.tagOptions || []).filter((_, j) => j !== i);
                            updateAttribute(selected.id, { tagOptions: opts });
                          }}
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                    <button
                      className={styles.addButton}
                      style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                      onClick={() => {
                        const opts = [...(selected.tagOptions || []), `tag_${(selected.tagOptions || []).length}`];
                        updateAttribute(selected.id, { tagOptions: opts });
                      }}
                    >
                      + Add Tag
                    </button>
                  </div>
                  {isVariegationSource && facePatterns.length === 0 && (
                    <div style={{ marginTop: 4, color: '#cc8d3a', fontSize: '0.62rem' }}>
                      No face patterns defined yet. Open the Variegated Cells (V) panel to add one.
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Sub-Attribute — cell attributes only. A sub-attribute is "only well-defined"
                on cells whose parent attribute (tag or bool) holds one of the configured
                parent values. Reads on non-matching cells return the undefinedValue. */}
            {!selected.isModelAttribute && (() => {
              const validParents = model.attributes.filter(a =>
                !a.isModelAttribute &&
                a.id !== selected.id &&
                (a.type === 'tag' || a.type === 'bool') &&
                !a.parentAttributeId,
              );
              const parent = validParents.find(p => p.id === selected.parentAttributeId)
                ?? model.attributes.find(p => p.id === selected.parentAttributeId);
              const isSub = !!selected.parentAttributeId;
              return (
                <div className={styles.field}>
                  <label
                    className={styles.fieldLabel}
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    title="When checked, this attribute is only well-defined on cells whose parent attribute is in the chosen parent-values set. Reads on non-matching cells return the undefined value."
                  >
                    <input
                      type="checkbox"
                      checked={isSub}
                      disabled={!isSub && validParents.length === 0}
                      onChange={e => {
                        if (e.target.checked) {
                          const first = validParents[0];
                          if (!first) return;
                          updateAttribute(selected.id, {
                            parentAttributeId: first.id,
                            parentValues: [],
                            undefinedValue: selected.defaultValue,
                          });
                        } else {
                          updateAttribute(selected.id, {
                            parentAttributeId: undefined,
                            parentValues: undefined,
                            undefinedValue: undefined,
                          });
                        }
                      }}
                    />
                    Sub-attribute (only valid under a parent attribute condition)
                  </label>
                  {!isSub && validParents.length === 0 && (
                    <p style={{ fontSize: '0.7rem', color: '#7a8a9a', fontStyle: 'italic', marginTop: 4 }}>
                      Requires at least one tag or binary cell attribute (not itself a sub-attribute) to use as parent.
                    </p>
                  )}
                  {isSub && (
                    <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid #00897b', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div>
                        <label className={styles.fieldLabel}>Parent Attribute</label>
                        <select
                          className={styles.selectInput}
                          value={selected.parentAttributeId ?? ''}
                          onChange={e => updateAttribute(selected.id, {
                            parentAttributeId: e.target.value,
                            parentValues: [],
                          })}
                        >
                          {validParents.map(p => (
                            <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                          ))}
                          {parent && !validParents.some(p => p.id === parent.id) && (
                            <option value={parent.id}>{parent.name} (invalid)</option>
                          )}
                        </select>
                      </div>
                      {parent && (parent.type === 'tag' || parent.type === 'bool') && (
                        <div>
                          <label className={styles.fieldLabel} title="Sub-attribute is only well-defined when the parent's value is in this set.">
                            Parent Values ({parent.name})
                          </label>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {parent.type === 'tag' ? (
                              (parent.tagOptions ?? []).length === 0 ? (
                                <p style={{ fontSize: '0.7rem', color: '#7a8a9a', fontStyle: 'italic' }}>
                                  Parent has no tag options yet.
                                </p>
                              ) : (parent.tagOptions ?? []).map((tag, i) => {
                                const idx = String(i);
                                const checked = (selected.parentValues ?? []).includes(idx);
                                return (
                                  <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={e => {
                                        const cur = new Set(selected.parentValues ?? []);
                                        if (e.target.checked) cur.add(idx); else cur.delete(idx);
                                        updateAttribute(selected.id, { parentValues: Array.from(cur) });
                                      }}
                                    />
                                    <span>{tag}</span>
                                  </label>
                                );
                              })
                            ) : (
                              ['false', 'true'].map(v => {
                                const checked = (selected.parentValues ?? []).includes(v);
                                return (
                                  <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={e => {
                                        const cur = new Set(selected.parentValues ?? []);
                                        if (e.target.checked) cur.add(v); else cur.delete(v);
                                        updateAttribute(selected.id, { parentValues: Array.from(cur) });
                                      }}
                                    />
                                    <span>{v}</span>
                                  </label>
                                );
                              })
                            )}
                          </div>
                          {(selected.parentValues ?? []).length === 0 && (
                            <p style={{ fontSize: '0.7rem', color: '#cc8800', fontStyle: 'italic', marginTop: 4 }}>
                              No parent values selected — reads will always return the undefined value.
                            </p>
                          )}
                        </div>
                      )}
                      <div>
                        <label
                          className={styles.fieldLabel}
                          title="Value returned by a read of this sub-attribute when the parent's value is NOT in the selected set."
                        >
                          Undefined Value
                        </label>
                        {selected.type === 'bool' ? (
                          <select
                            className={styles.selectInput}
                            value={selected.undefinedValue ?? selected.defaultValue}
                            onChange={e => updateAttribute(selected.id, { undefinedValue: e.target.value })}
                          >
                            <option value="false">false</option>
                            <option value="true">true</option>
                          </select>
                        ) : selected.type === 'integer' ? (
                          <NumberField
                            className={styles.numberInput}
                            integer
                            value={selected.undefinedValue ?? selected.defaultValue}
                            onNumber={n => updateAttribute(selected.id, {
                              undefinedValue: String(n),
                            })}
                          />
                        ) : selected.type === 'float' ? (
                          <InlineNumberInput
                            className={styles.numberInput}
                            value={selected.undefinedValue ?? selected.defaultValue}
                            onChange={next => updateAttribute(selected.id, { undefinedValue: next })}
                          />
                        ) : selected.type === 'tag' ? (
                          <select
                            className={styles.selectInput}
                            value={selected.undefinedValue ?? selected.defaultValue ?? '0'}
                            onChange={e => updateAttribute(selected.id, { undefinedValue: e.target.value })}
                          >
                            {(selected.tagOptions ?? []).map((tag, i) => (
                              <option key={i} value={String(i)}>{tag}</option>
                            ))}
                            {(!selected.tagOptions || selected.tagOptions.length === 0) && (
                              <option value="0">(no tags defined)</option>
                            )}
                          </select>
                        ) : selected.type === 'neighborIndex' ? (
                          <NeighborIndexDefaultEditor
                            attribute={selected}
                            onChange={cfg => updateAttribute(selected.id, cfg)}
                            neighborhoods={model.neighborhoods}
                            mode="undefined"
                            is3d={is3dModel}
                          />
                        ) : (
                          <input
                            className={styles.textInput}
                            value={selected.undefinedValue ?? selected.defaultValue}
                            onChange={e => updateAttribute(selected.id, { undefinedValue: e.target.value })}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea
                className={styles.textArea}
                rows={3}
                value={selected.description}
                onChange={e =>
                  updateAttribute(selected.id, {
                    description: e.target.value,
                  })
                }
              />
            </div>

            {selected.isModelAttribute && (selected.type === 'integer' || selected.type === 'float') && (
              <div className={styles.field}>
                <label className={styles.fieldLabel} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={selected.hasBounds ?? false}
                    onChange={e => updateAttribute(selected.id, {
                      hasBounds: e.target.checked,
                      min: selected.min ?? 0,
                      max: selected.max ?? (selected.type === 'integer' ? 100 : 1),
                    })}
                  />
                  Enable Bounds
                </label>
                {selected.hasBounds && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <div style={{ flex: 1 }}>
                      <label className={styles.fieldLabel}>Min</label>
                      <NumberField
                        className={styles.numberInput}
                        integer={selected.type === 'integer'}
                        value={selected.min ?? 0}
                        onNumber={n => updateAttribute(selected.id, { min: n })}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className={styles.fieldLabel}>Max</label>
                      <NumberField
                        className={styles.numberInput}
                        integer={selected.type === 'integer'}
                        value={selected.max ?? (selected.type === 'integer' ? 100 : 1)}
                        onNumber={n => updateAttribute(selected.id, { max: n })}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {mode === 'detail' && selKind === 'var' && selVarId && (
        <VariablesPanelSection mode="detail" selectedId={selVarId} onSelect={selectVar} />
      )}
    </>
  );
}
