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
    <div className={styles.panelShell} ref={panelRef} style={isRight ? { borderRight: 'none', borderLeft: '1px solid #2d4059' } : undefined}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button className={styles.closeButton} onClick={onClose} title="Close panel">
          &times;
        </button>
      </div>
      <div className={styles.body}>
        {children}
      </div>
      <div
        className={isRight ? styles.resizeHandleLeft : styles.resizeHandle}
        onMouseDown={e => {
          e.preventDefault();
          const panel = panelRef.current;
          if (!panel) return;
          const startX = e.clientX;
          const startW = panel.offsetWidth;
          const onMove = (ev: MouseEvent) => {
            // Right-side panel: dragging left increases width
            const delta = isRight ? startX - ev.clientX : ev.clientX - startX;
            const newW = Math.max(200, Math.min(600, startW + delta));
            panel.style.width = newW + 'px';
            panel.style.minWidth = newW + 'px';
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
      />
    </div>
  );
}
