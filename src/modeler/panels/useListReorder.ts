import { useCallback, useState } from 'react';

/** Pointer-events reorder for a single list of `{ id }` items. Returns a
 *  `startDrag(id)` pointerdown handler for the drag handle, plus the current
 *  drag state so the panel can render a drop-indicator line. The list
 *  container must have `data-reorder-list` and each row `data-reorder-row`
 *  (plus `data-reorder-idx` matching the item's position) so the hook can
 *  find rows without coupling to React tree structure.
 */
export interface DragState {
  id: string;
  overIdx: number;
}

export function useListReorder<T extends { id: string }>(
  items: T[],
  onReorder: (newOrder: string[]) => void,
) {
  const [dragState, setDragState] = useState<DragState | null>(null);

  const startDrag = useCallback((id: string) => (e: React.PointerEvent) => {
    if (items.length <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const listEl = handle.closest('[data-reorder-list]') as HTMLElement | null;
    if (!listEl) return;
    const startIdx = items.findIndex(i => i.id === id);
    if (startIdx < 0) return;
    setDragState({ id, overIdx: startIdx });

    // Track latest overIdx outside React state so pointerup can read it synchronously.
    let latestOverIdx = startIdx;
    const move = (ev: PointerEvent) => {
      const rows = Array.from(listEl.querySelectorAll<HTMLElement>('[data-reorder-row]'));
      let overIdx = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { overIdx = i; break; }
      }
      latestOverIdx = overIdx;
      setDragState(d => (d && d.overIdx !== overIdx ? { ...d, overIdx } : d));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // Clear drag state first; dispatch the reorder AFTER so the parent's
      // reducer update doesn't run inside our own state updater.
      setDragState(null);
      const fromIdx = startIdx;
      let toIdx = latestOverIdx;
      if (toIdx > fromIdx) toIdx--;
      toIdx = Math.max(0, Math.min(items.length - 1, toIdx));
      if (fromIdx >= 0 && fromIdx !== toIdx) {
        const next = [...items];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved!);
        onReorder(next.map(x => x.id));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [items, onReorder]);

  return { startDrag, dragState };
}
