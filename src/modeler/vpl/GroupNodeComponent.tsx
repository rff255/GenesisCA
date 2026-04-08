import { memo, useCallback } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import styles from './GroupNodeComponent.module.css';

function GroupNodeInner({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const nodeData = data as Record<string, unknown>;
  const label = (nodeData.label as string) || 'Group';
  const color = (nodeData.groupColor as string) || '#2d4059';

  const handleLabelChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { ...data, label: e.target.value });
    },
    [id, data, updateNodeData],
  );

  const handleColorChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { ...data, groupColor: e.target.value });
    },
    [id, data, updateNodeData],
  );

  return (
    <div className={styles.group} style={{ borderColor: color, background: `${color}20` }}>
      <NodeResizer
        isVisible={!!selected}
        minWidth={100}
        minHeight={60}
        lineStyle={{ borderColor: color }}
        handleStyle={{ width: 8, height: 8, background: color, borderRadius: 2 }}
      />
      <div className={styles.header} data-drag-handle>
        <input
          className={styles.label}
          value={label}
          onChange={handleLabelChange}
          onClick={e => e.stopPropagation()}
        />
        <input
          type="color"
          className={styles.colorPicker}
          value={color}
          onChange={handleColorChange}
          onClick={e => e.stopPropagation()}
          title="Group color"
        />
      </div>
    </div>
  );
}

export const GroupNodeComponent = memo(GroupNodeInner);
