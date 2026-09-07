import { useCallback, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { simLayoutApi } from '../simulator/simLayoutState';
import {
  clampLiveSplit,
  getLiveLayout,
  setLiveLayout,
  subscribeLiveLayout,
} from './liveUiState';
import {
  LIVE_LAYOUT_LOCK_REASON,
  getLiveLayoutLocked,
  subscribeLiveLayoutLocked,
} from './liveState';
import styles from './Live.module.css';

interface Props {
  /** `<main>` — the flex container whose box the fraction is measured against. */
  containerRef: RefObject<HTMLElement | null>;
  /** The graph pane (`<main>`'s first child) — the fraction names THIS pane. */
  graphPaneRef: RefObject<HTMLDivElement | null>;
  /** The simulation viewport pane (`<main>`'s simulator wrapper). */
  viewportPaneRef: RefObject<HTMLDivElement | null>;
}

/** `setPointerCapture` throws for a pointerId the browser never issued (a
 *  synthetic event), which would abort the handler mid-gesture — the
 *  `tryCapture` rule from `SpriteSheetDialog`. */
function tryCapture(el: Element, pointerId: number): void {
  try { el.setPointerCapture(pointerId); } catch { /* synthetic pointer */ }
}

function flexFor(fraction: number): string {
  return `${fraction} 1 0%`;
}

/**
 * LIVE MODE — the draggable divider between the graph pane and the simulation
 * viewport pane, and (while the viewport is collapsed) the ear that restores it.
 *
 * It is a Live-ONLY sibling rendered BETWEEN the two pane wrappers in `<main>`.
 * Both wrappers exist in every mode, so inserting this element changes neither
 * wrapper's position in the React tree — the invariant the whole feature rests
 * on (re-parenting `SimulatorView` destroys the worker, the WASM memory, the
 * WebGPU device and the running grid).
 *
 * ⚠ THE DRAG MUTATES THE PANES' INLINE `flex` DIRECTLY and only COMMITS the
 * fraction to `liveUiState` on release — the same discipline the simulator's own
 * side-panel handles use. Routing every pointermove through React state would
 * re-render `<main>` (and therefore both views) tens of times a second.
 *
 * ⚠ AND IT MUST CALL `simLayoutApi`, never rely on the `ResizeObserver`
 * catch-all: see [simLayoutState.ts](../simulator/simLayoutState.ts) for why
 * (stale stretched bitmap + one `OffscreenCanvas` re-attach per drag frame).
 */
export function LiveSplitter({ containerRef, graphPaneRef, viewportPaneRef }: Props) {
  const layout = useSyncExternalStore(subscribeLiveLayout, getLiveLayout);
  const locked = useSyncExternalStore(subscribeLiveLayoutLocked, getLiveLayoutLocked);
  const vertical = layout.dock === 'right';

  /** Fraction of the container the GRAPH pane should take, from a pointer
   *  position. `swapped` flips the panes' visual order (row-/column-reverse),
   *  so the same pointer position means the mirrored fraction. */
  const fractionAt = useCallback((clientX: number, clientY: number): number | null => {
    const box = containerRef.current;
    if (!box) return null;
    const r = box.getBoundingClientRect();
    const raw = vertical
      ? (r.width > 0 ? (clientX - r.left) / r.width : 0.5)
      : (r.height > 0 ? (clientY - r.top) / r.height : 0.5);
    return clampLiveSplit(layout.swapped ? 1 - raw : raw);
  }, [containerRef, vertical, layout.swapped]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (locked || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    tryCapture(handle, e.pointerId);
    let last = layout.split;

    const onMove = (ev: PointerEvent) => {
      const f = fractionAt(ev.clientX, ev.clientY);
      if (f == null) return;
      last = f;
      const g = graphPaneRef.current;
      const v = viewportPaneRef.current;
      if (g) g.style.flex = flexFor(f);
      if (v) v.style.flex = flexFor(1 - f);
      // The one trigger that re-sizes the simulator's backing stores during a
      // continuous gesture, AND holds off the direct-render re-attach.
      simLayoutApi?.scheduleLayoutDraw();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      // Commit — this is what persists, and what App re-renders from.
      setLiveLayout({ split: last });
      // A discrete final size: never make it wait out the 140 ms settle window.
      simLayoutApi?.drawNow();
    };
    // ⚠ On DOCUMENT, not on the handle: `setPointerCapture` is best-effort here
    // (it throws for a pointerId the browser never issued, and is swallowed), and
    // without capture a handle-scoped `pointermove` stops firing the instant the
    // cursor leaves the 6 px bar — i.e. immediately. The simulator's own panel
    // splitters listen on `document` for the same reason.
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }, [locked, layout.split, fractionAt, graphPaneRef, viewportPaneRef]);

  // Collapsed ⇒ there is nothing to divide, so the splitter is HIDDEN (the
  // structurally-impossible disposition) and a restore ear takes its slot.
  if (layout.viewportCollapsed) {
    return (
      <button
        type="button"
        className={`${styles.restoreEar} ${vertical ? '' : styles.restoreEarHorizontal}`}
        title={locked ? LIVE_LAYOUT_LOCK_REASON : 'Show the simulation viewport'}
        disabled={locked}
        onClick={() => { setLiveLayout({ viewportCollapsed: false }); }}
      >
        ‹ Viewport
      </button>
    );
  }

  return (
    <div
      className={[
        styles.splitter,
        vertical ? styles.splitterVertical : styles.splitterHorizontal,
        locked ? styles.splitterLocked : '',
      ].filter(Boolean).join(' ')}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      title={locked ? LIVE_LAYOUT_LOCK_REASON : 'Drag to resize · double-click for 50 / 50'}
      onPointerDown={onPointerDown}
      onDoubleClick={() => { if (!locked) setLiveLayout({ split: 0.5 }); }}
    >
      <span className={styles.grip}>
        <i className={styles.gripDot} /><i className={styles.gripDot} /><i className={styles.gripDot} />
      </span>
    </div>
  );
}
