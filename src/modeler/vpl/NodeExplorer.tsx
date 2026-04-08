import { useState, useMemo, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { getNodeDef } from './nodes/registry';
import styles from './NodeExplorer.module.css';

export interface NodeExplorerHandle {
  focusSearch: () => void;
}

export const NodeExplorer = forwardRef<NodeExplorerHandle>(function NodeExplorer(_props, ref) {
  const [search, setSearch] = useState('');
  const { fitView } = useReactFlow();
  const searchRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusSearch: () => searchRef.current?.focus(),
  }));

  const nodes = useStore(
    useCallback(
      (state: { nodes: Array<{ id: string; type?: string; data: Record<string, unknown>; selected?: boolean }> }) =>
        state.nodes,
      [],
    ),
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return nodes
      .filter(n => {
        if (n.type === 'groupNode' || n.type === 'commentNode') return false;
        const nodeData = n.data as Record<string, unknown>;
        const nodeType = (nodeData.nodeType as string) || '';
        const userLabel = (nodeData.label as string) || '';
        const def = getNodeDef(nodeType);
        const typeName = def?.label || nodeType;
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
          typeLabel: def?.label || nodeType,
          color: def?.color || '#2d4059',
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
      />
      <div className={styles.list}>
        {macros.length > 0 && (
          <>
            <div className={styles.sectionLabel}>Macros</div>
            {macros.map(n => (
              <button key={n.id} className={styles.item} onClick={() => handleFocus(n.id)}>
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
              <button key={n.id} className={styles.item} onClick={() => handleFocus(n.id)}>
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
