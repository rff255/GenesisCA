import { memo, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import styles from './CommentNodeComponent.module.css';

function CommentNodeInner({ id, data }: NodeProps) {
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
      <textarea
        className={styles.textArea}
        value={text}
        onChange={handleChange}
        placeholder="Add a comment..."
        rows={3}
      />
    </div>
  );
}

export const CommentNodeComponent = memo(CommentNodeInner);
