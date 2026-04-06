import { memo, useCallback } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import styles from './GroupNodeComponent.module.css';

function GroupNodeInner({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const nodeData = data as Record<string, unknown>;
  const label = (nodeData.label as string) || 'Group';

  const handleLabelChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { ...data, label: e.target.value });
    },
    [id, data, updateNodeData],
  );

  return (
    <div className={styles.group}>
      <NodeResizer
        isVisible={!!selected}
        minWidth={100}
        minHeight={60}
        lineStyle={{ borderColor: '#4a6080' }}
        handleStyle={{ width: 8, height: 8, background: '#4a6080', borderRadius: 2 }}
      />
      <input
        className={styles.label}
        value={label}
        onChange={handleLabelChange}
        onClick={e => e.stopPropagation()}
      />
    </div>
  );
}

export const GroupNodeComponent = memo(GroupNodeInner);
