import { useState, useMemo, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { getNodeDef } from './nodes/registry';
import { displayNodeLabel } from './graphState';
import styles from './NodeExplorer.module.css';

export interface NodeExplorerHandle {
  focusSearch: () => void;
}

/** The only node fields this panel renders: `id`, `type`, `data.nodeType`, `data.label`
 *  (colour/description are derived from `nodeType` via the registry). */
type ExplorerNode = { id: string; type?: string; data: Record<string, unknown>; selected?: boolean };

/** Equality gate for the `useStore(state => state.nodes)` subscription.
 *
 *  React Flow replaces the `nodes` ARRAY (and the moved node's object) on every
 *  pointermove of a node drag, so a bare `state.nodes` subscription re-rendered
 *  this panel — re-filtering, re-mapping and re-rendering every row — once per
 *  drag tick, for data a drag cannot change. Measured on the production build at
 *  400 nodes: 7.8 → 15.0 ms median per drag tick with the panel open (mean
 *  8.0 → 21.9 ms), i.e. the panel roughly DOUBLED the cost of dragging.
 *
 *  Comparing only the fields above makes a position change a no-op here (the
 *  `x === y` fast path means an unmoved node costs one identity compare), while
 *  a rename / add / delete / retype / reorder still returns false and re-renders.
 *  Selection is deliberately NOT compared — the rows don't render it. */
function sameExplorerNodes(a: ExplorerNode[], b: ExplorerNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x === y) continue;
    if (x.id !== y.id || x.type !== y.type) return false;
    if (x.data !== y.data && (x.data?.nodeType !== y.data?.nodeType || x.data?.label !== y.data?.label)) return false;
  }
  return true;
}

const selectExplorerNodes = (state: { nodes: ExplorerNode[] }) => state.nodes;

export const NodeExplorer = forwardRef<NodeExplorerHandle>(function NodeExplorer(_props, ref) {
  const [search, setSearch] = useState('');
  const { fitView } = useReactFlow();
  const searchRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusSearch: () => searchRef.current?.focus(),
  }));

  const nodes = useStore(selectExplorerNodes, sameExplorerNodes);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return nodes
      .filter(n => {
        if (n.type === 'groupNode' || n.type === 'commentNode') return false;
        const nodeData = n.data as Record<string, unknown>;
        const nodeType = (nodeData.nodeType as string) || '';
        const userLabel = (nodeData.label as string) || '';
        const def = getNodeDef(nodeType);
        const typeName = (def ? displayNodeLabel(def) : '') || nodeType;
        if (!q) return true;
        return typeName.toLowerCase().includes(q) || userLabel.toLowerCase().includes(q) || nodeType.toLowerCase().includes(q);
      })
      .map(n => {
        const nodeData = n.data as Record<string, unknown>;
        const nodeType = (nodeData.nodeType as string) || '';
        const userLabel = (nodeData.label as string) || '';
        const def = getNodeDef(nodeType);
        return {
          id: n.id,
          typeLabel: (def ? displayNodeLabel(def) : '') || nodeType,
          color: def?.color || '#2d4059',
          description: def?.description,
          userLabel,
          isMacro: nodeType === 'macro',
        };
      });
  }, [nodes, search]);

  const macros = filtered.filter(n => n.isMacro);
  const regular = filtered.filter(n => !n.isMacro);

  const handleFocus = useCallback((nodeId: string) => {
    fitView({ nodes: [{ id: nodeId }], duration: 300, padding: 0.5 });
  }, [fitView]);

  return (
    <div className={styles.explorer}>
      <input
        ref={searchRef}
        className={styles.search}
        type="text"
        placeholder="Search nodes..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            if (search) {
              // First Esc: clear the search (blur so a second Esc reaches ModelerView and closes the panel)
              setSearch('');
              e.currentTarget.blur();
              e.stopPropagation();
            } else {
              // Empty: blur so ModelerView's keydown handler gets the Esc
              e.currentTarget.blur();
            }
          }
        }}
      />
      <div className={styles.list}>
        {macros.length > 0 && (
          <>
            <div className={styles.sectionLabel}>Macros</div>
            {macros.map(n => (
              <button key={n.id} className={styles.item} title={n.description} onClick={() => handleFocus(n.id)}>
                <span className={styles.dot} style={{ background: n.color }} />
                <span className={styles.itemLabel}>{n.userLabel || n.typeLabel}</span>
                <span className={styles.itemType}>{n.typeLabel}</span>
              </button>
            ))}
          </>
        )}
        {regular.length > 0 && (
          <>
            {macros.length > 0 && <div className={styles.sectionLabel}>Nodes</div>}
            {regular.map(n => (
              <button key={n.id} className={styles.item} title={n.description} onClick={() => handleFocus(n.id)}>
                <span className={styles.dot} style={{ background: n.color }} />
                <span className={styles.itemLabel}>{n.userLabel || n.typeLabel}</span>
                {n.userLabel && <span className={styles.itemType}>{n.typeLabel}</span>}
              </button>
            ))}
          </>
        )}
        {filtered.length === 0 && (
          <div className={styles.empty}>No nodes found</div>
        )}
      </div>
    </div>
  );
});
