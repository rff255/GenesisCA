import { useState, useEffect, useRef } from 'react';
import { useModel } from '../../model/ModelContext';
import { useListReorder } from './useListReorder';
import styles from './PanelContent.module.css';

export function MappingsPanelContent() {
  const { model, addMapping, removeMapping, updateMapping, reorderMappings } = useModel();
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

      {selected && (
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
