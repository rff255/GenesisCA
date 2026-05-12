import type { Attribute, Neighborhood } from '../../model/types';
import { packNI, unpackNI, INVALID_NI } from '../vpl/compiler/niCodec';
import styles from './PanelContent.module.css';

interface DefaultEditorProps {
  attribute: Attribute;
  neighborhoods: Neighborhood[];
  onChange: (cfg: Partial<Attribute>) => void;
  /** Which value field this editor reads/writes. 'default' (the attribute's
   *  initial value, plus the hint-neighborhood selector), 'boundary' (the
   *  out-of-grid value used under constant boundary treatment), or 'undefined'
   *  (sub-attributes only: the value returned on cells whose parent doesn't
   *  match). The 'boundary' and 'undefined' modes hide the hint selector since
   *  the hint is per-attribute and already shown by the default editor. Defaults
   *  to 'default'. */
  mode?: 'default' | 'boundary' | 'undefined';
}

/** Per-axis clamp range — the runtime packs (dr, dc) as two sign-extended
 *  16-bit halves of an i32, so values outside [-32767, 32767] silently wrap
 *  on encode. We bound the editor inputs to the same range so the UI can't
 *  produce a value the runtime would reinterpret. (-32768 is reserved for
 *  the upper-half of the INVALID_NI sentinel and isn't a useful offset.) */
const AXIS_MIN = -32767;
const AXIS_MAX = 32767;
const clampAxis = (n: number): number => Math.max(AXIS_MIN, Math.min(AXIS_MAX, n | 0));

/** Decode a stored value string into a packed NI. Falls back to 0 (= centre
 *  cell) for empty / non-finite / sentinel values so the editor never enters
 *  a degenerate state — e.g. INVALID_NI's decoded (dr=-32768, dc=0) would
 *  otherwise expand the auto-bounded grid to ~33 000 rows and lock the UI. */
function safeDecode(stored: string | undefined): { packed: number; isSentinel: boolean } {
  if (stored === undefined || stored.length === 0) return { packed: 0, isSentinel: false };
  const n = parseInt(stored, 10);
  if (!Number.isFinite(n)) return { packed: 0, isSentinel: false };
  if (n === INVALID_NI) return { packed: 0, isSentinel: true };
  return { packed: n | 0, isSentinel: false };
}

interface PickerProps {
  /** Current packed (dr, dc) i32. INVALID_NI is normalised to (0, 0) for
   *  display (otherwise its decoded dr = -32768 would blow up the grid
   *  bounds calculation). */
  value: number;
  /** Optional hint neighborhood — when set, the picker shows a clickable
   *  grid spanning the hint's offsets (plus the current value's coordinate,
   *  even if outside the hint, so the selection is always visible). When
   *  null/undefined, the picker falls back to two number inputs (dr + dc). */
  hint?: Neighborhood | null;
  /** Called with the new packed (dr, dc) i32 when the user picks a cell or
   *  edits one of the dr/dc inputs. */
  onChange: (newPacked: number) => void;
  /** Cell size in px for the grid mode. Defaults to 22. Callers with tight
   *  horizontal space (e.g. the simulator side panel) can shrink it. */
  cellSize?: number;
}

/** Pure picker UI for a NeighborIndex value. Used by both the modeler's
 *  per-attribute default-value editor and the simulator's runtime model-attr
 *  panel. Renders either a clickable grid (when `hint` is set) or two
 *  number inputs (otherwise). Does NOT include the hint-neighborhood
 *  selector — that's modeler-specific (changing the hint changes the
 *  per-attribute config, not the picked value). */
export function NeighborIndexValuePicker({ value, hint, onChange, cellSize = 22 }: PickerProps) {
  const isSentinel = value === INVALID_NI;
  const packed = isSentinel ? 0 : (value | 0);
  const { dr: curDr, dc: curDc } = unpackNI(packed);

  // Compute the grid bounds so it fits the hint's offsets (with a sensible minimum).
  let minDr = -1, maxDr = 1, minDc = -1, maxDc = 1;
  if (hint) {
    for (const [dr, dc] of hint.coords) {
      if (dr < minDr) minDr = dr;
      if (dr > maxDr) maxDr = dr;
      if (dc < minDc) minDc = dc;
      if (dc > maxDc) maxDc = dc;
    }
  }
  // Always include the current value's coordinate in the grid bounds, so the
  // user can see what's currently selected even if it's outside the hint.
  // Skip when sentinel — its decoded -32768 row would blow up the grid.
  if (!isSentinel) {
    if (curDr < minDr) minDr = curDr;
    if (curDr > maxDr) maxDr = curDr;
    if (curDc < minDc) minDc = curDc;
    if (curDc > maxDc) maxDc = curDc;
  }
  const rows = maxDr - minDr + 1;
  const cols = maxDc - minDc + 1;

  // Map (dr, dc) → in-hint flag, used to colour the grid cells that are
  // members of the hint neighborhood vs. the ones that are merely available
  // as offsets the user can pick.
  const inHint = new Set<string>();
  if (hint) {
    for (const [dr, dc] of hint.coords) inHint.add(`${dr},${dc}`);
  }

  if (hint) {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
          gridTemplateRows: `repeat(${rows}, ${cellSize}px)`,
          gap: 2,
          justifyContent: 'center',
          padding: 4,
        }}
      >
        {Array.from({ length: rows * cols }, (_, i) => {
          const r = Math.floor(i / cols);
          const c = i % cols;
          const dr = r + minDr;
          const dc = c + minDc;
          const isCenter = dr === 0 && dc === 0;
          const isInNbr = inHint.has(`${dr},${dc}`);
          const isSelected = !isSentinel && dr === curDr && dc === curDc;
          const bg = isCenter
            ? '#37474f'
            : isSelected
              ? '#ffb300'
              : isInNbr
                ? '#1e3a52'
                : 'transparent';
          const border = isInNbr || isCenter ? '1px solid #4cc9f0' : '1px solid #2a3a4a';
          return (
            <div
              key={i}
              onClick={() => onChange(packNI(clampAxis(dr), clampAxis(dc)))}
              title={isCenter ? '(self)' : `(${dr}, ${dc})${isInNbr ? '' : ' — not in hint'}`}
              style={{
                background: bg,
                border,
                cursor: 'pointer',
                fontSize: Math.max(7, Math.min(10, cellSize - 12)),
                color: isSelected ? '#1e2a3a' : '#7a8a9a',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: isSelected ? 600 : 400,
                userSelect: 'none',
              }}
            >
              {isCenter ? '•' : `${dr},${dc}`}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 18 }}>dr</span>
      <input
        className={styles.numberInput}
        type="number"
        step={1}
        min={AXIS_MIN}
        max={AXIS_MAX}
        value={isSentinel ? 0 : curDr}
        onChange={e => {
          const raw = Number(e.target.value);
          const dr = Number.isFinite(raw) ? clampAxis(raw) : 0;
          onChange(packNI(dr, isSentinel ? 0 : curDc));
        }}
      />
      <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 18 }}>dc</span>
      <input
        className={styles.numberInput}
        type="number"
        step={1}
        min={AXIS_MIN}
        max={AXIS_MAX}
        value={isSentinel ? 0 : curDc}
        onChange={e => {
          const raw = Number(e.target.value);
          const dc = Number.isFinite(raw) ? clampAxis(raw) : 0;
          onChange(packNI(isSentinel ? 0 : curDr, dc));
        }}
      />
    </div>
  );
}

/** Wave A.6 default-value editor for a NeighborIndex attribute.
 *
 *  Stored value is now packed `(dr, dc)` i32 — the same NI runtime
 *  representation used in the compiled step / outputMapping functions.
 *
 *  Three-piece UI: (1) hint-neighborhood selector (default mode only),
 *  (2) NeighborIndexValuePicker (grid or dr/dc fallback), (3) status line. */
export function NeighborIndexDefaultEditor({ attribute, neighborhoods, onChange, mode = 'default' }: DefaultEditorProps) {
  const isBoundaryMode = mode === 'boundary';
  const isUndefinedMode = mode === 'undefined';
  const showHintSelector = !isBoundaryMode && !isUndefinedMode;
  const fieldKey: 'defaultValue' | 'boundaryValue' | 'undefinedValue' = isBoundaryMode
    ? 'boundaryValue'
    : isUndefinedMode
      ? 'undefinedValue'
      : 'defaultValue';
  const stored = attribute[fieldKey];
  const hintId = attribute.neighborhoodHintId ?? '';
  const hint = neighborhoods.find(n => n.id === hintId) ?? null;
  const { packed: currentPacked, isSentinel } = safeDecode(stored);
  const { dr: curDr, dc: curDc } = unpackNI(currentPacked);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {showHintSelector && (
        <select
          className={styles.selectInput}
          value={hintId}
          onChange={e => onChange({ neighborhoodHintId: e.target.value || undefined })}
        >
          <option value="">(no hint neighborhood)</option>
          {neighborhoods.map(n => (
            <option key={n.id} value={n.id}>{n.name}</option>
          ))}
        </select>
      )}

      <NeighborIndexValuePicker
        value={currentPacked}
        hint={hint}
        onChange={newPacked => onChange({ [fieldKey]: String(newPacked) } as Partial<Attribute>)}
      />

      <div style={{ fontSize: 11, color: '#7a8a9a' }}>
        {(isBoundaryMode || isUndefinedMode) && stored === undefined ? (
          <em>(blank — falls back to default value)</em>
        ) : isSentinel ? (
          <em style={{ color: '#f44336' }}>Stored value: INVALID_NI sentinel — pick a cell to set a real offset.</em>
        ) : (
          <>Stored value: packed <code>{currentPacked}</code> = (dr {curDr}, dc {curDc})</>
        )}
      </div>
    </div>
  );
}
