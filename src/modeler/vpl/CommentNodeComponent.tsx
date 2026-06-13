import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import styles from './CommentNodeComponent.module.css';

const DEFAULT_COLOR = '#2d4059';

/** Convert a #rrggbb hex to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Lighten a hex color by the given 0-1 amount for border/outline contrast. */
function lighten(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const r = Math.min(255, Math.round((parseInt(h.slice(0, 2), 16) || 0) + 255 * amount));
  const g = Math.min(255, Math.round((parseInt(h.slice(2, 4), 16) || 0) + 255 * amount));
  const b = Math.min(255, Math.round((parseInt(h.slice(4, 6), 16) || 0) + 255 * amount));
  return `rgb(${r}, ${g}, ${b})`;
}

function CommentNodeInner({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const text = (data as Record<string, unknown>).text as string || '';
  const color = ((data as Record<string, unknown>).color as string) || DEFAULT_COLOR;
  const colorInputRef = useRef<HTMLInputElement>(null);
  // Editing mode: the textarea is inert (node drags normally) until the user
  // double-clicks. While editing, the `nodrag` class hands the mouse back to
  // the textarea so click-drag / shift-click text selection work natively.
  const autoEdit = !!(data as Record<string, unknown>).autoEdit;
  const [editing, setEditing] = useState(autoEdit);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    // React Flow renders a freshly-added node visibility:hidden until it has
    // measured handle bounds, and a `focus()` during that pre-measure frame
    // silently no-ops (the NameInputDialog gotcha) — a single rAF isn't enough
    // because the measure can span several frames. Retry across frames until
    // the textarea is laid out AND focus actually sticks, then select-all and
    // clear the one-shot autoEdit flag. Capped so it can't spin forever.
    let cancelled = false;
    let attempts = 0;
    const tryFocus = () => {
      if (cancelled) return;
      const ta = textAreaRef.current;
      if (ta && ta.offsetParent !== null) {
        ta.focus();
        if (document.activeElement === ta) {
          if (autoEdit) {
            ta.select();
            // One-shot — clear so it never persists into a saved graph.
            updateNodeData(id, { ...data, autoEdit: undefined });
          }
          return;
        }
      }
      if (++attempts < 30) requestAnimationFrame(tryFocus);
    };
    requestAnimationFrame(tryFocus);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateNodeData(id, { ...data, text: e.target.value });
    },
    [id, data, updateNodeData],
  );

  const handleColorChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { ...data, color: e.target.value });
    },
    [id, data, updateNodeData],
  );

  const border = lighten(color, 0.1);

  return (
    <div
      className={styles.comment}
      style={{ background: hexToRgba(color, 0.6), borderColor: border }}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={120}
        minHeight={50}
        lineStyle={{ borderColor: border }}
        handleStyle={{ width: 6, height: 6, background: border, borderRadius: 2 }}
        onResizeEnd={(_, params) =>
          updateNodeData(id, { ...data, width: params.width, height: params.height })
        }
      />
      {selected && (
        <>
          <button
            className={styles.colorSwatch}
            style={{ background: color, borderColor: border }}
            title="Change comment color"
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
            onClick={e => { e.stopPropagation(); colorInputRef.current?.click(); }}
          />
          <input
            ref={colorInputRef}
            type="color"
            value={color}
            onChange={handleColorChange}
            className={styles.hiddenColorInput}
            tabIndex={-1}
          />
        </>
      )}
      <div className={styles.textWrap} onDoubleClick={() => setEditing(true)}>
        <textarea
          ref={textAreaRef}
          className={editing ? `${styles.textArea} nodrag` : styles.textArea}
          style={editing ? undefined : { pointerEvents: 'none' }}
          value={text}
          readOnly={!editing}
          onChange={handleChange}
          onBlur={() => setEditing(false)}
          placeholder="Add a comment..."
        />
      </div>
    </div>
  );
}

export const CommentNodeComponent = memo(CommentNodeInner);
