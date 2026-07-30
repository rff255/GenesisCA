import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useModel } from '../../model/ModelContext';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import type { Attribute, AttributeType, CAModel, LookupAxis, LookupKeySource } from '../../model/types';
import { LookupTableEditor } from './LookupTableEditor';
import {
  resolveKeyLabels, dedupeCustomLabels, resolveValueTagOptions,
  resolveAxes, isMultiAxisTable, normalizeLookupTable, MAX_LOOKUP_AXES,
} from '../vpl/compiler/variegation';
import { useListReorder } from './useListReorder';
import { NeighborIndexDefaultEditor } from './NeighborIndexDefaultEditor';
import { VariablesPanelSection } from './VariablesPanelSection';
import { MODEL_ELEMENT_DRAG_MIME } from '../vpl/modelElementDrag';
import type { ModelElementDragPayload } from '../vpl/modelElementDrag';
import { setCurrentModelElementDrag, subscribeActiveGraphKind, getActiveGraphKind } from '../vpl/graphState';
import { typeDisplayName } from '../../model/typeLabels';
import { resolveMaxBonds } from '../../model/centerBased';
import { vectorDimsForModel, vectorComponentLabels } from '../vpl/compiler/vectorAttr';
import { NumberField, InlineNumberInput } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';
import { ColorField } from '../vpl/widgets/ColorField';

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

/** A single custom axis-label input. Holds a local DRAFT so typing isn't
 *  disrupted by the on-commit de-duplication (which would otherwise fight the
 *  user keystroke-by-keystroke); commits on blur / Enter. When the committed
 *  value gets de-duplicated (a suffix added) the parent re-renders with the new
 *  label and the effect syncs the draft, so the input shows the final unique name. */
function CustomLabelInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <input
      className={styles.textInput}
      style={{ flex: 1, minWidth: 0, fontSize: '0.66rem' }}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.currentTarget as HTMLInputElement).blur(); } }}
      title="Row/column label (must be unique — duplicates get a suffix)"
    />
  );
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
  // Agent tag attributes are first-class axis sources too (a species-keyed
  // Particle Life-style matrix binds the agent tag directly) — resolveKeyLabels
  // searches model.attributes then agentAttributes.
  const agentTagAttrs = model.topologyMode?.agents ? (model.agentAttributes ?? []).filter(a => a.type === 'tag') : [];
  const current = value
    ? value.kind === 'facePalette' ? `palette:${value.paletteId}`
      : value.kind === 'tagAttribute' ? `tag:${value.attributeId}`
      : value.kind === 'custom' ? 'custom'
      : value.kind === 'intRange' ? 'intRange'
      : 'single'
    : '';
  const customLabels = value?.kind === 'custom' ? value.labels : null;
  const intRange = value?.kind === 'intRange' ? value : null;
  // De-duplicate on every commit so the stored labels are ALWAYS unique — a
  // lookup table's tableValues is keyed by label name, so duplicates collide.
  const setLabels = (labels: string[]) => onChange({ kind: 'custom', labels: dedupeCustomLabels(labels) });
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.66rem' }}>
      <span style={{ color: '#7a8a9a' }}>{label}</span>
      <select
        className={styles.selectInput}
        value={current}
        onChange={e => {
          const v = e.target.value;
          if (v === 'single') { onChange({ kind: 'single' }); return; }
          if (v === 'custom') { onChange({ kind: 'custom', labels: value?.kind === 'custom' ? value.labels : ['A', 'B'] }); return; }
          if (v === 'intRange') { onChange(value?.kind === 'intRange' ? value : { kind: 'intRange', min: 0, max: 8 }); return; }
          const ci = v.indexOf(':');
          if (ci < 0) { onChange(undefined); return; }
          const kind = v.slice(0, ci);
          const id = v.slice(ci + 1);
          onChange(kind === 'palette' ? { kind: 'facePalette', paletteId: id } : { kind: 'tagAttribute', attributeId: id });
        }}
      >
        <option value="">— select —</option>
        <option value="single">Single value (map)</option>
        <option value="custom">Custom labels…</option>
        <option value="intRange">Integer range…</option>
        {palettes.length > 0 && (
          <optgroup label="Face palettes">
            {palettes.map(p => <option key={p.id} value={`palette:${p.id}`}>{p.name}</option>)}
          </optgroup>
        )}
        <optgroup label="Tag attributes">
          {tagAttrs.map(a => <option key={a.id} value={`tag:${a.id}`}>{a.name}</option>)}
        </optgroup>
        {agentTagAttrs.length > 0 && (
          <optgroup label="Agent tag attributes">
            {agentTagAttrs.map(a => <option key={a.id} value={`tag:${a.id}`}>{a.name}</option>)}
          </optgroup>
        )}
      </select>
      {intRange && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <span style={{ color: '#7a8a9a' }}>min</span>
          <NumberField className={styles.numberInput} value={intRange.min} integer
            onNumber={n => onChange({ kind: 'intRange', min: Math.floor(n), max: Math.max(Math.floor(n), intRange.max) })}
            style={{ width: 52, height: 20 }} noSpinner />
          <span style={{ color: '#7a8a9a' }}>max</span>
          <NumberField className={styles.numberInput} value={intRange.max} integer
            onNumber={n => onChange({ kind: 'intRange', min: Math.min(intRange.min, Math.floor(n)), max: Math.floor(n) })}
            style={{ width: 52, height: 20 }} noSpinner />
          <span style={{ color: '#556' }} title="Axis labels are the integers min..max — the natural axis for neighbour-count rule tables">
            ({Math.max(0, intRange.max - intRange.min) + 1} values)
          </span>
        </div>
      )}
      {customLabels && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
          {customLabels.map((lbl, i) => (
            <div key={i} style={{ display: 'flex', gap: 2 }}>
              <CustomLabelInput
                value={lbl}
                onCommit={v => setLabels(customLabels.map((x, j) => (j === i ? v : x)))}
              />
              <button
                className={styles.deleteButton}
                style={{ padding: '0 6px' }}
                onClick={() => setLabels(customLabels.filter((_, j) => j !== i))}
                disabled={customLabels.length <= 1}
                title="Remove label"
              >&times;</button>
            </div>
          ))}
          <button
            className={styles.addButton}
            style={{ fontSize: '0.64rem', padding: '2px 6px' }}
            onClick={() => setLabels([...customLabels, `L${customLabels.length + 1}`])}
          >+ Label</button>
        </div>
      )}
    </div>
  );
}

/** MULTI-AXIS (N-D) Lookup Table axes editor: an ordered list of axes, each
 *  with a display name + a key source (integer range / custom labels / tag
 *  attribute / face palette / single). Discipline mirrors multi-attr slots:
 *  APPEND / REMOVE-LAST only, edit in place — never reorder (the dense
 *  tableData layout and the Table Lookup node's axis_k ports are positional).
 *  Structural edits remap tableData in the reducer (applyAxesRemap). */
function LookupAxesEditor({ attr, model, onUpdate }: {
  attr: Attribute;
  model: CAModel;
  onUpdate: (changes: Partial<Attribute>) => void;
}) {
  const axes = attr.axes ?? [];
  const resolved = resolveAxes(attr, model);
  const setAxes = (next: LookupAxis[]) => onUpdate({ axes: next });
  const setAxis = (i: number, ax: LookupAxis) => setAxes(axes.map((a, j) => (j === i ? ax : a)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
      {axes.map((ax, i) => (
        <div key={i} style={{
          display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 6px',
          border: '1px solid var(--color-border, #2a3548)', borderRadius: 5,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}>
            <span style={{ color: 'var(--color-accent, #e8a13a)', fontFamily: 'monospace' }}>{i}</span>
            <CustomLabelInput
              value={ax.name || `Axis ${i}`}
              onCommit={v => setAxis(i, { ...ax, name: v || `Axis ${i}` })}
            />
            <span style={{ color: '#556', whiteSpace: 'nowrap' }}>dim {resolved.axes[i]?.dim ?? 1}</span>
          </div>
          <KeySourceField label="" value={ax.source} model={model}
            onChange={src => setAxis(i, { ...ax, source: src ?? { kind: 'single' } })} />
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button className={styles.addButton} style={{ fontSize: '0.64rem', padding: '2px 8px' }}
          disabled={axes.length >= MAX_LOOKUP_AXES}
          onClick={() => setAxes([...axes, { name: `Axis ${axes.length}`, source: { kind: 'intRange', min: 0, max: 8 } }])}
        >+ Axis</button>
        <button className={styles.deleteButton} style={{ fontSize: '0.64rem', padding: '2px 8px' }}
          disabled={axes.length <= 1}
          onClick={() => setAxes(axes.slice(0, -1))}
          title="Remove the LAST axis (axes never reorder — storage and node ports are positional)"
        >− last</button>
        <span style={{ color: '#556', fontSize: '0.62rem' }}>
          {resolved.total.toLocaleString()} entries
        </span>
      </div>
    </div>
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
  const {
    model, addAttribute, duplicateAttribute, removeAttribute: removeAttributeRaw, updateAttribute: updateAttributeRaw, reorderAttributes,
    addAgentAttribute, duplicateAgentAttribute, removeAgentAttribute, updateAgentAttribute, reorderAgentAttributes,
    addBondAttribute, duplicateBondAttribute, removeBondAttribute, updateBondAttribute, reorderBondAttributes,
  } = useModel();
  // Generic Agent Platform: on the Agents sub-tab the primary list shows the
  // AGENT attribute set (model.agentAttributes — a separate id-space), with its
  // own +Add / edit / delete; the Cells sub-tab shows cell attributes (+ an
  // Agent Access control). (Re-renders on sub-tab swap via the external store.)
  const activeGraphKind = useSyncExternalStore(subscribeActiveGraphKind, getActiveGraphKind);
  const agentMode = activeGraphKind === 'agents' && !!model.topologyMode?.agents;
  const cellAttrLabel = agentMode ? 'Agent Attributes' : 'Cell Attributes';
  // 3D Grid CA: neighborIndex attribute values pack 3 axes in a 3D model.
  const is3dModel = model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
  // One discriminated selection slot for this panel: `attr:<id>` or `var:<id>`.
  // Attributes and Local Variables share the single second detail panel, so
  // selecting one kind clears the other.
  // P2 adds a THIRD kind: `bond:<id>` (a per-EDGE attribute). Same single detail
  // panel, so selecting one kind clears the others. ⚠ `ModelerView.selectedItemName`
  // MUST resolve the `bond:` prefix or the detail PanelShell (gated on
  // `detailItemName != null`) silently never mounts — the exact bug that shipped
  // once for agent attributes.
  const [sel, setSel] = useDetailSelection('attributes');
  const selKind: 'attr' | 'var' | 'bond' = sel?.startsWith('var:') ? 'var' : sel?.startsWith('bond:') ? 'bond' : 'attr';
  const selAttrId = sel && selKind === 'attr' ? sel.replace(/^attr:/, '') : null;
  const selVarId = sel && selKind === 'var' ? sel.slice(4) : null;
  const selBondId = sel && selKind === 'bond' ? sel.slice(5) : null;
  const selectAttr = (id: string | null) => setSel(id ? `attr:${id}` : null);
  const selectVar = (id: string | null) => setSel(id ? `var:${id}` : null);
  const selectBond = (id: string | null) => setSel(id ? `bond:${id}` : null);

  const agentAttrList = model.agentAttributes ?? [];
  // Bond attributes are AGENT-ONLY and meaningless without bonds — the section is
  // shown on the Agents sub-tab of a model whose Bonds capability is on.
  const bondAttrList = model.bondAttributes ?? [];
  const bondsOn = agentMode && resolveMaxBonds(model.centerBased) > 0;
  // The PRIMARY list (top section): agent attrs on the Agents tab, cell attrs
  // otherwise. The Model Attributes section (below) is shared in both.
  const cellAttrs = agentMode ? agentAttrList : model.attributes.filter(a => !a.isModelAttribute);
  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);

  // Independent reorder within each group — preserve the other group's order in the combined array.
  const cellReorder = useListReorder(cellAttrs, newOrder => {
    if (agentMode) {
      // Agent attributes are their own list — reorder it directly. NB the order
      // is load-bearing for the agent store/ABI (agentAttrsOf), but a reorder
      // forces a full worker reinit via the attrsStructurallyEqual signature.
      reorderAgentAttributes(newOrder);
      return;
    }
    const map = new Map(cellAttrs.map(a => [a.id, a]));
    reorderAttributes([...newOrder.map(id => map.get(id)!).filter(Boolean), ...modelAttrs].map(a => a.id));
  });
  // The bond-attribute order is load-bearing (it drives the ragged region order in
  // the agent memory layout AND the `_bondAttr_<id>` ABI block), but a reorder
  // forces a full worker reinit via the `attrsStructurallyEqual` signature.
  const bondReorder = useListReorder(bondAttrList, newOrder => reorderBondAttributes(newOrder));
  const modelReorder = useListReorder(modelAttrs, newOrder => {
    const map = new Map(modelAttrs.map(a => [a.id, a]));
    reorderAttributes([...cellAttrs, ...newOrder.map(id => map.get(id)!).filter(Boolean)].map(a => a.id));
  });

  // Auto-select & scroll to newly added items (cell/model attrs AND agent attrs).
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
  const prevAgentAttrCount = useRef(agentAttrList.length);
  useEffect(() => {
    if (agentAttrList.length > prevAgentAttrCount.current) {
      const newItem = agentAttrList[agentAttrList.length - 1];
      if (newItem) {
        selectAttr(newItem.id);
        setTimeout(() => {
          document.getElementById(`attr-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevAgentAttrCount.current = agentAttrList.length;
  }, [agentAttrList]);
  const prevBondAttrCount = useRef(bondAttrList.length);
  useEffect(() => {
    if (bondAttrList.length > prevBondAttrCount.current) {
      const newItem = bondAttrList[bondAttrList.length - 1];
      if (newItem) {
        selectBond(newItem.id);
        setTimeout(() => {
          document.getElementById(`attr-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevBondAttrCount.current = bondAttrList.length;
  }, [bondAttrList]);

  // Generic Agent Platform: the selected attribute may be an AGENT attribute
  // (separate id-space) or a cell/model attribute. Resolve from both, and route
  // edits/deletes to the right reducer so the detail editor's many
  // updateAttribute(selected.id, …) call sites stay unchanged.
  // P2: a `bond:` selection resolves against the BOND list and routes its edits to
  // the bond reducers, so the shared detail editor below needs no per-kind branch
  // beyond the type restriction + the cell-only sections it already gates.
  const selected = selAttrId
    ? (agentAttrList.find(a => a.id === selAttrId) ?? model.attributes.find(a => a.id === selAttrId))
    : selBondId
      ? bondAttrList.find(a => a.id === selBondId)
      : undefined;
  const selectedIsAgent = !!selAttrId && agentAttrList.some(a => a.id === selAttrId);
  const selectedIsBond = !!selBondId && bondAttrList.some(a => a.id === selBondId);
  const updateAttribute = (id: string, changes: Partial<Attribute>) =>
    (selectedIsBond ? updateBondAttribute : selectedIsAgent ? updateAgentAttribute : updateAttributeRaw)(id, changes);
  const removeAttribute = (id: string) =>
    (selectedIsBond ? removeBondAttribute : selectedIsAgent ? removeAgentAttribute : removeAttributeRaw)(id);
  const addPrimary = () => (agentMode ? addAgentAttribute() : addAttribute(false));

  const handleDelete = () => {
    if (selBondId) { removeBondAttribute(selBondId); setSel(null); return; }
    if (selAttrId) {
      removeAttribute(selAttrId);
      setSel(null);
    }
  };

  // Duplicate the selected attribute (routes to the agent set when the selected
  // attr is an agent attribute). The list-grew auto-select effect selects the
  // appended copy.
  const handleDuplicate = () => {
    if (!selAttrId) return;
    if (selectedIsAgent) duplicateAgentAttribute(selAttrId);
    else duplicateAttribute(selAttrId);
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
            onClick={addPrimary}
          >
            {agentMode ? '+ Add Agent Attribute' : '+ Add Cell Attribute'}
          </button>
          <button className={styles.addButton} onClick={handleDuplicate} disabled={!selAttrId}>
            Duplicate
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
          <button className={styles.addButton} onClick={handleDuplicate} disabled={!selAttrId}>
            Duplicate
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      {/* Graph-Rewriting Automata (P2): BOND attributes — per-EDGE user state.
          Agents-only, and only when the Bonds capability is on (no bonds ⇒ no
          edges to carry it, and the store allocates zero bond-attribute bytes). */}
      {bondsOn && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Bond Attributes</div>
          <p className={styles.sectionHelp}>
            Per-EDGE state carried by a bond. A bond is one object stored at both
            endpoints, so a bond attribute is symmetric — writing it from either
            agent updates both sides.
          </p>
          <div className={styles.list} data-reorder-list>
            {bondAttrList.length === 0 && (
              <p style={{ fontSize: '0.75rem', color: '#6080a0', fontStyle: 'italic', padding: '4px 0' }}>
                No bond attributes defined.
              </p>
            )}
            {bondAttrList.map((attr, i) => {
              const isDragging = bondReorder.dragState?.id === attr.id;
              const srcIdx = bondReorder.dragState ? bondAttrList.findIndex(a => a.id === bondReorder.dragState!.id) : -1;
              const showBefore = bondReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
              const showAfter = bondReorder.dragState?.overIdx === bondAttrList.length && i === bondAttrList.length - 1 && srcIdx !== i;
              return (
                <div
                  key={attr.id}
                  id={`attr-${attr.id}`}
                  data-reorder-row
                  className={`${styles.listItem} ${sel === `bond:${attr.id}` ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                  onClick={() => selectBond(attr.id)}
                >
                  <span className={styles.listItemName}>{attr.name}</span>
                  <span className={styles.listItemBadge}>{typeDisplayName(attr.type)}</span>
                  <button
                    className={styles.dragHandle}
                    title="Drag to reorder"
                    onPointerDown={bondReorder.startDrag(attr.id)}
                    onClick={e => e.stopPropagation()}
                  >⋮⋮</button>
                </div>
              );
            })}
          </div>
          <div className={styles.buttonRow}>
            <button className={styles.addButton} onClick={() => addBondAttribute()}>
              + Add Bond Attribute
            </button>
            <button className={styles.addButton} onClick={() => selBondId && duplicateBondAttribute(selBondId)} disabled={!selBondId}>
              Duplicate
            </button>
            <button className={styles.deleteButton} onClick={handleDelete} disabled={!selBondId}>
              Delete
            </button>
          </div>
        </div>
      )}

      <VariablesPanelSection mode="list" selectedId={selVarId} onSelect={selectVar} />
      </>)}

      {mode === 'detail' && (selKind === 'attr' || selKind === 'bond') && selected && (
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
                value={selected.type === 'vector' ? (selected.vectorDims === 3 ? 'vector3' : 'vector2') : selected.type}
                onChange={e => {
                  const raw = e.target.value;
                  // "Vector (2D)" / "Vector (3D)" are synthetic values → type='vector'
                  // + the component count. Distinct from the composite `vector` WIRE.
                  const isVec = raw === 'vector2' || raw === 'vector3';
                  const newType = (isVec ? 'vector' : raw) as AttributeType;
                  const vDims = raw === 'vector3' ? 3 : 2;
                  const resetDefaults: Record<string, string> = {
                    bool: 'false', integer: '0', float: '0', list: '', tag: '', color: '#808080',
                    neighborIndex: '0',
                  };
                  updateAttribute(selected.id, {
                    type: newType,
                    vectorDims: isVec ? vDims : undefined,
                    defaultValue: isVec ? (vDims === 3 ? '0,0,0' : '0,0') : (resetDefaults[newType] ?? ''),
                  });
                }}
              >
                <option value="bool">Binary</option>
                <option value="integer">Integer</option>
                <option value="float">Decimal</option>
                <option value="tag">Tag</option>
                {/* Vector = a stored 2D/3D direction (cell / agent only). "Vector (3D)"
                    is offered only in a 3D model — OR when this attribute is ALREADY a
                    3D vector (authored in a 3D model, then switched to 2D) so the
                    dropdown never misreports its real type as "Binary". */}
                {!selected.isModelAttribute && !selectedIsBond && <option value="vector2">Vector (2D)</option>}
                {!selected.isModelAttribute && !selectedIsBond && (vectorDimsForModel(model) === 3 || (selected.type === 'vector' && selected.vectorDims === 3)) && <option value="vector3">Vector (3D)</option>}
                {/* A packed lattice-offset type is meaningless for an off-lattice agent. */}
                {!selectedIsAgent && !selectedIsBond && <option value="neighborIndex">Neighbor Index</option>}
                {selected.isModelAttribute && <option value="color">Color</option>}
                {selected.isModelAttribute && <option value="lookupTable">Lookup Table</option>}
              </select>
            </div>
            {/* Generic Agent Platform: whether floating agents may read/write this
                cell attribute (the environment/field) via the field-bridge nodes.
                Cell attributes only, and only when the model has agents. */}
            {!selected.isModelAttribute && !selectedIsAgent && !selectedIsBond && model.topologyMode?.agents && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Agent access</label>
                <select
                  className={styles.selectInput}
                  value={selected.agentAccess ?? 'none'}
                  onChange={e => updateAttribute(selected.id, { agentAccess: e.target.value as 'none' | 'read' | 'readWrite' })}
                  title="Whether agents can read (Sample/Read Field) or read+write (Affect/Secrete) this cell attribute"
                >
                  <option value="none">None</option>
                  <option value="read">Read</option>
                  <option value="readWrite">Read &amp; Write</option>
                </select>
              </div>
            )}
            {selected.type === 'lookupTable' && (() => {
              const isMulti = isMultiAxisTable(selected);
              // Explicit one-shot conversions between the two storage modes.
              // legacy → multi: seed axes from the row/col sources and flatten
              // tableValues into the dense tableData. multi → legacy (N=2
              // only): carry the two sources back and rebuild the sparse map.
              const convertToMulti = () => {
                const rowL = resolveKeyLabels(selected.rowKeySource, model);
                const colL = resolveKeyLabels(selected.colKeySource, model);
                const axes: LookupAxis[] = [
                  { name: 'Rows', source: selected.rowKeySource ?? { kind: 'single' } },
                  { name: 'Columns', source: selected.colKeySource ?? { kind: 'single' } },
                ];
                const tableData = Array.from(normalizeLookupTable(selected.tableValues, rowL, colL));
                updateAttribute(selected.id, { axes, tableData });
              };
              const convertToLegacy = () => {
                const r = resolveAxes(selected, model);
                if (r.axes.length !== 2) return;
                const [rowAx, colAx] = [r.axes[0]!, r.axes[1]!];
                const data = selected.tableData ?? [];
                const tv: Record<string, Record<string, number>> = {};
                rowAx.labels.forEach((rl, i) => {
                  const row: Record<string, number> = {};
                  colAx.labels.forEach((cl, j) => {
                    const v = data[i * colAx.dim + j];
                    if (typeof v === 'number' && v !== 0) row[cl] = v;
                  });
                  tv[rl] = row;
                });
                updateAttribute(selected.id, {
                  axes: undefined, tableData: undefined,
                  rowKeySource: selected.axes?.[0]?.source, colKeySource: selected.axes?.[1]?.source,
                  tableValues: tv,
                });
              };
              return (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Lookup Table</label>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Axes mode</label>
                  <select
                    className={styles.selectInput}
                    value={isMulti ? 'multi' : 'legacy'}
                    onChange={e => {
                      if (e.target.value === 'multi' && !isMulti) convertToMulti();
                      else if (e.target.value === 'legacy' && isMulti) convertToLegacy();
                    }}
                    title={isMulti && (selected.axes?.length ?? 0) !== 2
                      ? 'Switching back to rows × columns needs exactly 2 axes'
                      : 'Rows × columns (classic), or up to 6 positional axes (N-D rule tables — e.g. state × face/edge/corner neighbour counts)'}
                  >
                    <option value="legacy">Rows × columns (2-axis)</option>
                    <option value="multi">Multi-axis (up to {MAX_LOOKUP_AXES})</option>
                  </select>
                </div>
                {isMulti ? (
                  <LookupAxesEditor attr={selected} model={model}
                    onUpdate={changes => updateAttribute(selected.id, changes)} />
                ) : (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'flex-start' }}>
                    <KeySourceField label="Rows" value={selected.rowKeySource} model={model}
                      onChange={src => updateAttribute(selected.id, { rowKeySource: src })} />
                    <KeySourceField label="Columns" value={selected.colKeySource} model={model}
                      onChange={src => updateAttribute(selected.id, { colKeySource: src })} />
                  </div>
                )}
                {/* Value type of the table cells (Decimal by default). bool/integer/
                    float/tag are stored as one number → no compiler change. Each
                    dropdown gets its own stacked field (like the attribute Type
                    dropdown) so it stays contained instead of spanning the panel. */}
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Value type</label>
                  <select
                    className={styles.selectInput}
                    value={selected.valueType ?? 'float'}
                    onChange={e => {
                      const vt = e.target.value as Attribute['type'];
                      const changes: Partial<Attribute> = { valueType: vt };
                      if (vt === 'tag' && (selected.valueTagOptions ?? []).length === 0) changes.valueTagOptions = ['A', 'B'];
                      updateAttribute(selected.id, changes);
                    }}
                    title="Data type of the table's cell values"
                  >
                    <option value="bool">{typeDisplayName('bool')}</option>
                    <option value="integer">{typeDisplayName('integer')}</option>
                    <option value="float">{typeDisplayName('float')}</option>
                    <option value="tag">{typeDisplayName('tag')}</option>
                  </select>
                </div>
                {selected.valueType === 'tag' && (
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Tag values from</label>
                    <select
                      className={styles.selectInput}
                      value={selected.valueTagAttributeId ? `tag:${selected.valueTagAttributeId}` : 'custom'}
                      onChange={e => {
                        const v = e.target.value;
                        if (v === 'custom') {
                          const changes: Partial<Attribute> = { valueTagAttributeId: undefined };
                          if ((selected.valueTagOptions ?? []).length === 0) changes.valueTagOptions = ['A', 'B'];
                          updateAttribute(selected.id, changes);
                        } else {
                          updateAttribute(selected.id, { valueTagAttributeId: v.slice(4) });
                        }
                      }}
                      title="Tag value labels: define them manually, or reuse an existing tag attribute's options"
                    >
                      <option value="custom">Custom values…</option>
                      <optgroup label="From tag attribute">
                        {model.attributes.filter(a => a.type === 'tag').map(a => (
                          <option key={a.id} value={`tag:${a.id}`}>{a.name}</option>
                        ))}
                      </optgroup>
                      {model.topologyMode?.agents && (model.agentAttributes ?? []).some(a => a.type === 'tag') && (
                        <optgroup label="From agent tag attribute">
                          {(model.agentAttributes ?? []).filter(a => a.type === 'tag').map(a => (
                            <option key={a.id} value={`tag:${a.id}`}>{a.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </div>
                )}
                {selected.valueType === 'tag' && !selected.valueTagAttributeId && (() => {
                  const opts = selected.valueTagOptions ?? [];
                  const setOpts = (o: string[]) => updateAttribute(selected.id, { valueTagOptions: o });
                  return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                      {opts.map((o, i) => (
                        <div key={i} style={{ display: 'flex', gap: 2 }}>
                          <input
                            className={styles.textInput}
                            style={{ width: 70, fontSize: '0.64rem' }}
                            value={o}
                            onChange={e => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))}
                            title={`Tag value ${i}`}
                          />
                          <button className={styles.deleteButton} style={{ padding: '0 6px' }}
                            onClick={() => setOpts(opts.filter((_, j) => j !== i))} disabled={opts.length <= 1}>&times;</button>
                        </div>
                      ))}
                      <button className={styles.addButton} style={{ fontSize: '0.64rem', padding: '2px 6px' }}
                        onClick={() => setOpts([...opts, `T${opts.length}`])}>+ Value</button>
                    </div>
                  );
                })()}
                <LookupTableEditor
                  attribute={selected}
                  rowLabels={resolveKeyLabels(selected.rowKeySource, model)}
                  colLabels={resolveKeyLabels(selected.colKeySource, model)}
                  valueTagOptions={resolveValueTagOptions(selected, model)}
                  axesResolved={isMulti ? resolveAxes(selected, model) : undefined}
                  onChange={changes => updateAttribute(selected.id, changes)}
                />
              </div>
              );
            })()}
            {selected.type !== 'lookupTable' && (<>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Default Value</label>
              {selected.type === 'vector' ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  {vectorComponentLabels(selected.vectorDims === 3 ? 3 : 2).map((lbl, i) => {
                    const parts = String(selected.defaultValue ?? '').split(',');
                    return (
                      <div key={i} style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.6rem', color: '#999' }}>{lbl}</label>
                        <InlineNumberInput
                          className={styles.numberInput}
                          value={(parts[i] ?? '0').trim()}
                          onChange={next => {
                            const dims = selected.vectorDims === 3 ? 3 : 2;
                            const cur = String(selected.defaultValue ?? '').split(',');
                            const out = Array.from({ length: dims }, (_, k) => (k === i ? next : (cur[k] ?? '0').trim()));
                            updateAttribute(selected.id, { defaultValue: out.join(',') });
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : selected.type === 'bool' ? (
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
                // `defaultValue` accepts #rrggbb (alpha absent → opaque) or
                // #rrggbbaa; ColorField emits 6 digits when opaque, so an opaque
                // colour round-trips to exactly the string it had before alpha.
                // The worker / SimulatorView split it into the id_r/_g/_b/_a slots.
                <ColorField
                  value={selected.defaultValue || '#808080'}
                  onChange={hex => updateAttribute(selected.id, { defaultValue: hex })}
                  style={{ width: '100%', height: 30 }}
                  title="Default colour — alpha is exposed to the graph via Get Model Attribute's A output"
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
            {!selected.isModelAttribute && !selectedIsAgent && !selectedIsBond && model.properties.boundaryTreatment === 'constant' && (
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
            {/* Sub-attributes are a cell-only concept (agents have no parent-cell
                relationship), so hide the editor for agent attributes. Also hidden for
                a `vector` attr: its scalar-float component expansion doesn't carry the
                parent-match fields (parentAttributeId/parentValues/undefinedValue), so a
                sub-attribute constraint on a vector would be a silent no-op. */}
            {!selected.isModelAttribute && !selectedIsAgent && !selectedIsBond && selected.type !== 'vector' && (() => {
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
