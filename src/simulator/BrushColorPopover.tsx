import { useEffect, useRef, useLayoutEffect, useState } from 'react';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import styles from './BrushColorPopover.module.css';

interface Props {
  /** Viewport x/y where the popover should anchor (top-left) */
  x: number;
  y: number;
  color: string; // #rrggbb
  onChange: (hex: string) => void;
  onClose: () => void;
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r: number, g: number, b: number) {
  const clamp = (v: number) => Math.max(0, Math.min(255, v | 0));
  return '#' + [clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function BrushColorPopover({ x, y, color, onChange, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { r, g, b } = hexToRgb(color);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp to viewport after mount so the popover never spills off-screen
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    setPos({
      left: Math.max(margin, Math.min(x, maxLeft)),
      top: Math.max(margin, Math.min(y, maxTop)),
    });
  }, [x, y]);

  // Close on outside click or Escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Delay binding so the mousedown that opened the popover doesn't immediately close it
    const t = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const setChannel = (which: 'r' | 'g' | 'b', v: number) => {
    const cur = { r, g, b };
    cur[which] = v;
    onChange(rgbToHex(cur.r, cur.g, cur.b));
  };

  return (
    <div
      ref={rootRef}
      className={styles.popover}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={e => e.preventDefault()}
    >
      <div className={styles.header}>
        <div className={styles.swatch} style={{ background: color }} />
        <span className={styles.hex}>{color.toUpperCase()}</span>
        <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">&times;</button>
      </div>
      <div className={styles.rgbRow}>
        <label className={styles.label}>R</label>
        <NumberField className={styles.input} min={0} max={255} integer value={r}
          onNumber={n => setChannel('r', n)} />
        <label className={styles.label}>G</label>
        <NumberField className={styles.input} min={0} max={255} integer value={g}
          onNumber={n => setChannel('g', n)} />
        <label className={styles.label}>B</label>
        <NumberField className={styles.input} min={0} max={255} integer value={b}
          onNumber={n => setChannel('b', n)} />
      </div>
      <div className={styles.nativeRow}>
        <label className={styles.nativeLabel}>Full picker</label>
        <input className={styles.nativePicker} type="color" value={color}
          onChange={e => onChange(e.target.value)} />
      </div>
    </div>
  );
}
