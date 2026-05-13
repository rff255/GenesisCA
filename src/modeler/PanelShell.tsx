import { useRef, type ReactNode } from 'react';
import styles from './PanelShell.module.css';

interface PanelShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Which side of the layout this panel is on. Controls resize handle position. Default: 'left' */
  side?: 'left' | 'right';
}

export function PanelShell({ title, onClose, children, side = 'left' }: PanelShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const isRight = side === 'right';

  return (
    <div
      className={`${styles.panelShell} ${isRight ? styles.panelShellRight : ''}`}
      ref={panelRef}
    >
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
      </div>
      <div className={styles.body}>
        {children}
      </div>
      {/* Outside ear-tab: collapses the panel. Mirrors the simulator-right
          pattern. Arrow points TOWARDS the direction the panel will move. */}
      <button
        className={`${styles.earTab} ${isRight ? styles.earTabLeft : styles.earTabRight}`}
        onClick={onClose}
        title="Close panel"
      >
        {isRight ? '›' : '‹'}
      </button>
      <div
        className={isRight ? styles.resizeHandleLeft : styles.resizeHandle}
        onMouseDown={e => {
          e.preventDefault();
          const panel = panelRef.current;
          if (!panel) return;
          const startX = e.clientX;
          const startW = panel.offsetWidth;
          // Drag-inward-to-collapse, no upper cap. Mirrors the simulator's
          // side-panel behaviour: visual drag clamps at DRAG_MIN so the
          // user sees the panel shrink, and on release below
          // COLLAPSE_THRESHOLD the panel snaps closed via onClose().
          const COLLAPSE_THRESHOLD = 100;
          const DRAG_MIN = 40;
          let lastW = startW;
          const onMove = (ev: MouseEvent) => {
            const delta = isRight ? startX - ev.clientX : ev.clientX - startX;
            lastW = Math.max(DRAG_MIN, startW + delta);
            panel.style.width = lastW + 'px';
            panel.style.minWidth = lastW + 'px';
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (lastW < COLLAPSE_THRESHOLD) onClose();
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
      />
    </div>
  );
}
