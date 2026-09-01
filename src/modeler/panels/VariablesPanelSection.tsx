import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useModel } from '../../model/ModelContext';
import type { Variable, VariableDataType, VariableKind } from '../../model/types';
import { useListReorder } from './useListReorder';
import type { PanelMode } from '../ModelerDetailContext';
import { MODEL_ELEMENT_DRAG_MIME } from '../vpl/modelElementDrag';
import type { ModelElementDragPayload } from '../vpl/modelElementDrag';
import { setCurrentModelElementDrag, subscribeActiveGraphKind, getActiveGraphKind } from '../vpl/graphState';
import { typeDisplayName } from '../../model/typeLabels';
import { NumberField, InlineNumberInput } from '../vpl/widgets/InlineWidgets';
import { vectorDimsForModel, vectorComponentLabels } from '../vpl/compiler/vectorAttr';
import styles from './PanelContent.module.css';

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

/** Properties-panel section for Local Variables — per-cell scratch storage
 *  referenced by getVariable / setVariable / setArrayElement nodes. Mirrors
 *  the Indicators section's interaction shape (list + inspector for selected
 *  item, +Variable button, drag-to-reorder). */
/** Local Variables master-detail UI. Lives INSIDE the Attributes panel: the
 *  list renders in the primary panel (`mode='list'`), the selected variable's
 *  editor renders in the shared second detail panel (`mode='detail'`). Selection
 *  is controlled by the parent (AttributesPanelContent), which routes attribute
 *  vs variable selection through one discriminated `attr:`/`var:` slot. */
export function VariablesPanelSection({ mode = 'list', selectedId, onSelect }: {
  mode?: PanelMode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const {
    model, addVariable: addVariableRaw, duplicateVariable: duplicateVariableRaw, removeVariable: removeVariableRaw,
    updateVariable: updateVariableRaw, reorderVariables,
  } = useModel();
  // Generic Agent Platform: the Agents sub-tab edits the AGENT variable set
  // (model.agentVariables, separate id-space); the Cells sub-tab edits the cell
  // variables. All mutations carry the matching `target`; local wrappers keep the
  // call sites below unchanged.
  const activeGraphKind = useSyncExternalStore(subscribeActiveGraphKind, getActiveGraphKind);
  const agentMode = activeGraphKind === 'agents' && !!model.topologyMode?.agents;
  const target: 'cell' | 'agent' = agentMode ? 'agent' : 'cell';
  const addVariable = () => addVariableRaw(target);
  const duplicateVariable = (id: string) => duplicateVariableRaw(id, target);
  const removeVariable = (id: string) => removeVariableRaw(id, target);
  const updateVariable = (id: string, changes: Parameters<typeof updateVariableRaw>[1]) => updateVariableRaw(id, changes, target);
  const variables = (agentMode ? model.agentVariables : model.variables) || [];
  const reorder = useListReorder(variables, (newOrder: string[]) => reorderVariables(newOrder, target));

  const prevCount = useRef(variables.length);
  const prevScope = useRef(agentMode);
  useEffect(() => {
    // A Cells↔Agents tab swap switches WHICH list `variables` binds to — the
    // length delta across lists is not an add, so reset the baseline instead of
    // spuriously auto-selecting (and opening the detail editor for) the last item.
    if (prevScope.current !== agentMode) {
      prevScope.current = agentMode;
      prevCount.current = variables.length;
      return;
    }
    if (variables.length > prevCount.current) {
      const newItem = variables[variables.length - 1];
      if (newItem) {
        onSelect(newItem.id);
        setTimeout(() => {
          document.getElementById(`var-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevCount.current = variables.length;
  }, [variables, agentMode]);
  const selected = variables.find(v => v.id === selectedId);

  // Tag-type variables borrow a tag attribute's tag space. Cell variables may
  // bind any cell or model tag attribute; agent variables bind AGENT tag
  // attributes plus the shared MODEL tag attributes (cell tag attrs are not
  // visible to the agent loop).
  const tagAttrs = agentMode
    ? [...(model.agentAttributes ?? []), ...model.attributes.filter(a => a.isModelAttribute)].filter(a => a.type === 'tag')
    : model.attributes.filter(a => a.type === 'tag');
  const selTagAttr = selected?.attributeId
    ? tagAttrs.find(a => a.id === selected.attributeId)
    : undefined;

  return (
    <>
      {mode !== 'detail' && (
      <div className={styles.section}>
      <div className={styles.sectionTitle}>{agentMode ? 'Agent Variables' : 'Local Variables'}</div>
      <div className={styles.sectionHelp}>
        {agentMode
          ? "Per-agent scratch storage referenced by Get / Set Variable nodes. Each agent sees a fresh copy initialised to the variable's Initial Value at the start of every step — not persisted between steps or shared across agents."
          : "Per-cell scratch storage referenced by Get / Set Variable nodes. Each cell sees a fresh copy initialised to the variable's Initial Value at the start of every step — not persisted between steps or shared across cells."}
      </div>

      <div className={styles.list} data-reorder-list>
        {variables.map((v, i) => {
          const isDragging = reorder.dragState?.id === v.id;
          const srcIdx = reorder.dragState ? variables.findIndex(x => x.id === reorder.dragState!.id) : -1;
          const showBefore = reorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
          const showAfter = reorder.dragState?.overIdx === variables.length && i === variables.length - 1 && srcIdx !== i;
          return (
            <div
              key={v.id}
              id={`var-${v.id}`}
              data-reorder-row
              className={`${styles.listItem} ${styles.listItemDraggable} ${v.id === selectedId ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
              onClick={() => onSelect(v.id === selectedId ? null : v.id)}
              draggable
              onDragStart={handleRowDragStart({ kind: 'variable', variableId: v.id, varKind: v.kind })}
              onDragEnd={handleRowDragEnd}
              title={`Drag to canvas to add a node that uses '${v.name}'`}
            >
              <span className={styles.listItemName}>{v.name}</span>
              <span className={styles.listItemBadge}>
                {v.kind === 'array' ? `${typeDisplayName(v.dataType)}[${v.length ?? '?'}]` : typeDisplayName(v.dataType)}
              </span>
              <button className={styles.dragHandle} title="Drag to reorder"
                onPointerDown={reorder.startDrag(v.id)}
                onClick={e => e.stopPropagation()}>⋮⋮</button>
            </div>
          );
        })}
      </div>

      <div className={styles.buttonRow}>
        <button className={styles.addButton} onClick={addVariable}>+ Variable</button>
        <button className={styles.addButton} onClick={() => selectedId && duplicateVariable(selectedId)} disabled={!selectedId}>Duplicate</button>
      </div>
      </div>
      )}

      {mode === 'detail' && selected && (
        <div className={styles.detailEditor}>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selected.name}
                onChange={e => updateVariable(selected.id, { name: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <input
                className={styles.textInput}
                value={selected.description ?? ''}
                placeholder="(optional)"
                onChange={e => updateVariable(selected.id, { description: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Kind</label>
              <select
                className={styles.selectInput}
                value={selected.kind}
                onChange={e => {
                  const kind = e.target.value as VariableKind;
                  // An array can't be a vector in v1 (vectors are scalar-only): switching
                  // to Array while the type is vector would leave an invalid
                  // {kind:'array', dataType:'vector'} that expands away yet still lists in
                  // Set Array Element → runtime `_var_<id> is not defined`. Reset the type
                  // to Decimal (+ clear vectorDims) on that transition.
                  const patch: Partial<Variable> = { kind };
                  if (kind === 'array' && selected.dataType === 'vector') {
                    patch.dataType = 'float';
                    patch.vectorDims = undefined;
                    patch.initialValue = '0';
                  }
                  updateVariable(selected.id, patch);
                }}
              >
                <option value="scalar">Scalar</option>
                <option value="array">Array</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Data Type</label>
              <select
                className={styles.selectInput}
                value={selected.dataType === 'vector' ? (selected.vectorDims === 3 ? 'vector3' : 'vector2') : selected.dataType}
                onChange={e => {
                  const raw = e.target.value;
                  const isVec = raw === 'vector2' || raw === 'vector3';
                  const dt = (isVec ? 'vector' : raw) as VariableDataType;
                  const vDims = raw === 'vector3' ? 3 : 2;
                  const defaults: Record<string, string> = {
                    bool: 'false', integer: '0', float: '0', tag: '0',
                  };
                  updateVariable(selected.id, {
                    dataType: dt,
                    vectorDims: isVec ? vDims : undefined,
                    initialValue: isVec ? (vDims === 3 ? '0,0,0' : '0,0') : (defaults[dt] || '0'),
                  });
                }}
              >
                <option value="bool">Binary</option>
                <option value="integer">Integer</option>
                <option value="float">Decimal</option>
                <option value="tag">Tag</option>
                {/* Vector = a per-cell/agent transient direction (one accumulator
                    instead of separate X/Y[/Z] floats). Scalar variables only. The
                    3D option also stays visible when this variable is ALREADY a 3D
                    vector (e.g. authored in a 3D model, then switched to 2D) so the
                    dropdown never misreports its real type. */}
                {selected.kind === 'scalar' && <option value="vector2">Vector (2D)</option>}
                {selected.kind === 'scalar' && (vectorDimsForModel(model) === 3 || (selected.dataType === 'vector' && selected.vectorDims === 3)) && <option value="vector3">Vector (3D)</option>}
              </select>
            </div>

            {selected.kind === 'array' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Length</label>
                <NumberField
                  className={styles.numberInput}
                  min={1}
                  max={65536}
                  integer
                  value={selected.length ?? 4}
                  onNumber={n => updateVariable(selected.id, { length: n })}
                />
              </div>
            )}

            {selected.dataType === 'tag' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Tag Attribute</label>
                <select
                  className={styles.selectInput}
                  value={selected.attributeId ?? ''}
                  onChange={e => updateVariable(selected.id, { attributeId: e.target.value || undefined })}
                >
                  <option value="">Select tag attribute...</option>
                  {tagAttrs.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Initial Value</label>
              {selected.dataType === 'vector' ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  {vectorComponentLabels(selected.vectorDims === 3 ? 3 : 2).map((lbl, i) => {
                    const parts = String(selected.initialValue ?? '').split(',');
                    return (
                      <div key={i} style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.6rem', color: '#999' }}>{lbl}</label>
                        <InlineNumberInput
                          className={styles.numberInput}
                          value={(parts[i] ?? '0').trim()}
                          onChange={next => {
                            const dims = selected.vectorDims === 3 ? 3 : 2;
                            const cur = String(selected.initialValue ?? '').split(',');
                            const out = Array.from({ length: dims }, (_, k) => (k === i ? next : (cur[k] ?? '0').trim()));
                            updateVariable(selected.id, { initialValue: out.join(',') });
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : selected.dataType === 'bool' ? (
                <select
                  className={styles.selectInput}
                  value={selected.initialValue === 'true' || selected.initialValue === '1' ? 'true' : 'false'}
                  onChange={e => updateVariable(selected.id, { initialValue: e.target.value })}
                >
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              ) : selected.dataType === 'tag' && selTagAttr?.tagOptions ? (
                <select
                  className={styles.selectInput}
                  value={selected.initialValue || '0'}
                  onChange={e => updateVariable(selected.id, { initialValue: e.target.value })}
                >
                  {selTagAttr.tagOptions.map((name, idx) => (
                    <option key={idx} value={String(idx)}>{name}</option>
                  ))}
                </select>
              ) : (
                <InlineNumberInput
                  className={styles.numberInput}
                  value={selected.initialValue}
                  onChange={next => updateVariable(selected.id, { initialValue: next })}
                />
              )}
            </div>

            <button
              className={styles.deleteButton}
              onClick={() => { removeVariable(selected.id); onSelect(null); }}
            >
              Delete Variable
            </button>
          </div>
        </div>
      )}
    </>
  );
}
