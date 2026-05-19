import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import styles from './GroupNodeComponent.module.css';

function GroupNodeInner({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const nodeData = data as Record<string, unknown>;
  const label = (nodeData.label as string) || 'Group';
  const color = (nodeData.groupColor as string) || '#2d4059';
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleLabelChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { ...data, label: e.target.value });
    },
    [id, data, updateNodeData],
  );

  const handleLabelKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.currentTarget.blur();
    }
  }, []);

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
        lineStyle={{ borderColor: color, pointerEvents: 'auto' }}
        handleStyle={{ width: 8, height: 8, background: color, borderRadius: 2, pointerEvents: 'auto' }}
        onResizeEnd={(_, params) =>
          updateNodeData(id, { ...data, width: params.width, height: params.height })
        }
      />
      <div className={styles.header} data-drag-handle="true">
        {isEditing ? (
          <input
            ref={inputRef}
            className={`${styles.label} ${styles.labelInput} nodrag nopan`}
            value={label}
            onChange={handleLabelChange}
            onBlur={() => setIsEditing(false)}
            onKeyDown={handleLabelKeyDown}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
          />
        ) : (
          <span
            className={styles.label}
            onDoubleClick={() => setIsEditing(true)}
            title="Double-click to rename"
          >
            {label}
          </span>
        )}
        <input
          type="color"
          className={`${styles.colorPicker} nodrag nopan`}
          value={color}
          onChange={handleColorChange}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          title="Group color"
        />
      </div>
    </div>
  );
}

export const GroupNodeComponent = memo(GroupNodeInner);
