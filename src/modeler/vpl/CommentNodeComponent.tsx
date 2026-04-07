import { memo, useCallback } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import styles from './CommentNodeComponent.module.css';

function CommentNodeInner({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const text = (data as Record<string, unknown>).text as string || '';

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateNodeData(id, { ...data, text: e.target.value });
    },
    [id, data, updateNodeData],
  );

  return (
    <div className={styles.comment}>
      <NodeResizer
        isVisible={!!selected}
        minWidth={120}
        minHeight={50}
        lineStyle={{ borderColor: '#4a6080' }}
        handleStyle={{ width: 6, height: 6, background: '#4a6080', borderRadius: 2 }}
      />
      <textarea
        className={styles.textArea}
        value={text}
        onChange={handleChange}
        placeholder="Add a comment..."
      />
    </div>
  );
}

export const CommentNodeComponent = memo(CommentNodeInner);
