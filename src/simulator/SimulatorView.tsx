import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { compileGraph } from '../modeler/vpl/compiler/compile';
import { hasGlyphsInModel } from '../modeler/vpl/compiler/glyphsUsage';
import { compileGraphWasm } from '../modeler/vpl/compiler/wasm/compile';
import { computeLayoutFromModel, buildViewerIds } from '../modeler/vpl/compiler/wasm/layout';
import { unpackNI, INVALID_NI } from '../modeler/vpl/compiler/niCodec';
import { resolveKeyLabels } from '../modeler/vpl/compiler/variegation';
import { NeighborIndexValuePicker } from '../modeler/panels/NeighborIndexDefaultEditor';
import { LookupTableEditor } from '../modeler/panels/LookupTableEditor';
import { compileGraphWebGPU } from '../modeler/vpl/compiler/webgpu/compile';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { encodeFramesToWebM, isWebMSupported } from './recording/webmEncoder';
import { getGlyphTile } from './recording/glyphAtlas';
import { IndicatorDisplay } from './IndicatorDisplay';
import { BrushColorPopover } from './BrushColorPopover';
import { ManualBrushPanel } from './ManualBrushPanel';
import { InspectCellPopover, InspectHoverLink, type InspectPopoverState } from './InspectCellPopover';
import { PresetSaveDialog } from './PresetSaveDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { serializeSimState, serializePreset, downloadStateFile, readStateFile, base64ToArrayBuffer, deserializeTypedArray, migrateSimulationStateV1toV2 } from '../model/fileOperations';
import type { Attribute, CAModel, IndicatorChartSettings, Preset, SimulationState } from '../model/types';
import { encodeAttrValue } from '../model/attrValueEncoding';
import styles from './SimulatorView.module.css';

const SIM_SETTINGS_KEY = 'genesisca_sim_settings';

function loadSimSettings(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SIM_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

// --- Manual Brush ---
// Sentinel mapping ID for the runtime-only "Manual" tab in the brush mapping
// strip. Doesn't collide with real mapping IDs (which are nanoid-like).
export const MANUAL_BRUSH_MAPPING_ID = '__manual__';

export interface ManualBrushAttrEntry {
  enabled: boolean;
  /** Canonical string encoding, identical to Attribute.defaultValue. */
  value: string;
}
export type ManualBrushModelState = Record<string /* attrId */, ManualBrushAttrEntry>;

const MANUAL_BRUSH_KEY_PREFIX = 'genesisca_manual_brush_v1:';
function manualBrushStorageKey(modelName: string): string {
  // Models don't have a stable id field, so we key on the user-visible name.
  // Renaming a model resets brush state (acceptable UX wart — values are
  // re-derived from each attribute's defaultValue with all rows enabled).
  return MANUAL_BRUSH_KEY_PREFIX + (modelName.trim() || '__unnamed__');
}
function loadManualBrush(modelName: string): ManualBrushModelState | null {
  try {
    const raw = localStorage.getItem(manualBrushStorageKey(modelName));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ManualBrushModelState;
  } catch { /* ignore */ }
  return null;
}
function saveManualBrush(modelName: string, state: ManualBrushModelState): void {
  try {
    localStorage.setItem(manualBrushStorageKey(modelName), JSON.stringify(state));
  } catch { /* localStorage full */ }
}

// "Include central cell" is a schema-level flag that is compiled away before
// simulation: a neighborhood with the flag set gets [0,0] appended to its
// effective `coords`, so the worker + all three compilers (which iterate
// `coords` / read `coords.length`) treat the cell itself as a member with no
// code changes of their own. This MUST be applied as the first transform at
// every point the model is handed to the compile/sim pipeline — applying it
// per-site risks the worker's neighbor tables and the compiled `nSz_<nbr>`
// desyncing. Returns the same model reference when no neighborhood uses it.
function withEffectiveNeighborhoods(model: CAModel): CAModel {
  if (!model.neighborhoods.some(n => n.includeCentralCell)) return model;
  return {
    ...model,
    neighborhoods: model.neighborhoods.map(n => {
      if (!n.includeCentralCell) return n;
      // Guard against a hand-edited file that already lists [0,0] — never
      // double-count the central cell.
      if (n.coords.some(([r, c]) => r === 0 && c === 0)) return n;
      return { ...n, coords: [...n.coords, [0, 0] as [number, number]] };
    }),
  };
}

// Build the runtime model-attribute value map from each model attribute's
// declared default. Shared by worker init and the "Reset to Default" button.
function computeDefaultModelAttrs(attributes: Attribute[]): Record<string, number> {
  const mAttrs: Record<string, number> = {};
  for (const a of attributes) {
    if (!a.isModelAttribute) continue;
    switch (a.type) {
      case 'bool': mAttrs[a.id] = a.defaultValue === 'true' ? 1 : 0; break;
      case 'integer': mAttrs[a.id] = parseInt(a.defaultValue, 10) || 0; break;
      case 'float': mAttrs[a.id] = parseFloat(a.defaultValue) || 0; break;
      case 'neighborIndex': {
        // Stored value is the packed (dr, dc) i32 (see NeighborIndexDefaultEditor).
        // INVALID_NI on a model attribute is meaningless at runtime — normalize to 0.
        const n = parseInt(a.defaultValue, 10);
        mAttrs[a.id] = (Number.isFinite(n) && n !== INVALID_NI) ? (n | 0) : 0;
        break;
      }
      case 'color': {
        const hex = a.defaultValue || '#808080';
        mAttrs[a.id + '_r'] = parseInt(hex.slice(1, 3), 16) || 0;
        mAttrs[a.id + '_g'] = parseInt(hex.slice(3, 5), 16) || 0;
        mAttrs[a.id + '_b'] = parseInt(hex.slice(5, 7), 16) || 0;
        break;
      }
      case 'lookupTable':
        // Lives in `interactionTables` worker payload (separate from the
        // scalar `modelAttrs` record). Don't allocate a slot here.
        break;
      default: mAttrs[a.id] = 0;
    }
  }
  return mAttrs;
}

/** Compare two attribute lists for STRUCTURAL changes only — the kind of changes
 *  that affect worker init (buffer layout, indicator ids, sub-attribute parent
 *  checks, variegated face-pattern lookup size, sentinel-cell defaults). Returns
 *  true when the only differences are in live-tunable fields that the running
 *  worker can absorb without a reinit:
 *    - name / description / hasBounds / min / max / symmetric: pure UI fields,
 *      never read by the worker.
 *    - tableValues: interaction-table data, pushed via updateInteractionTable.
 *      Lives outside the cell-attr / model-attr layout.
 *  The existing reference-equality check `prev.attributes === model.attributes`
 *  forced a reinit on EVERY updateAttribute (the reducer always rebuilds the
 *  array). That wiped the grid whenever a preset, Reset-to-Default, or in-panel
 *  interaction-table edit fired — even though none of those touch buffer layout.
 *  This structural compare keeps the existing "reinit on shape change" semantic
 *  while letting live-tunable updates flow through without disturbing the grid. */
function attrsStructurallyEqual(prev: Attribute[], curr: Attribute[]): boolean {
  if (prev === curr) return true;
  if (prev.length !== curr.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!, b = curr[i]!;
    if (a === b) continue;
    if (a.id !== b.id) return false;
    if (a.type !== b.type) return false;
    if (a.isModelAttribute !== b.isModelAttribute) return false;
    if (a.defaultValue !== b.defaultValue) return false;
    if (a.boundaryValue !== b.boundaryValue) return false;
    if (a.parentAttributeId !== b.parentAttributeId) return false;
    if (a.undefinedValue !== b.undefinedValue) return false;
    if (a.neighborhoodHintId !== b.neighborhoodHintId) return false;
    // tagOptions order matters (face-pattern lookup keys + node-config tag indices)
    const at = a.tagOptions, bt = b.tagOptions;
    const al = at?.length ?? 0, bl = bt?.length ?? 0;
    if (al !== bl) return false;
    for (let j = 0; j < al; j++) if (at![j] !== bt![j]) return false;
    // parentValues order matters (sub-attribute parent-check)
    const ap = a.parentValues, bp = b.parentValues;
    const apl = ap?.length ?? 0, bpl = bp?.length ?? 0;
    if (apl !== bpl) return false;
    for (let j = 0; j < apl; j++) if (ap![j] !== bp![j]) return false;
    // facePatternAssignments: compare as a key→value map
    const fpaA = a.facePatternAssignments ?? {};
    const fpaB = b.facePatternAssignments ?? {};
    const fpaKeys = new Set([...Object.keys(fpaA), ...Object.keys(fpaB)]);
    for (const k of fpaKeys) if (fpaA[k] !== fpaB[k]) return false;
    // Lookup Table key sources: changing which palette / tag attribute an axis
    // uses changes the table's dimensions → memory layout → requires full reinit.
    if (JSON.stringify(a.rowKeySource) !== JSON.stringify(b.rowKeySource)) return false;
    if (JSON.stringify(a.colKeySource) !== JSON.stringify(b.colKeySource)) return false;
  }
  return true;
}

/** Layout-affecting signature of the variegation config: the source attribute
 *  (drives facePatternLookup size) + each palette's label COUNT (drives the
 *  dimensions of any facePalette-keyed Lookup Table). A change here resizes
 *  wasmMemory regions, so it must force a full worker reinit rather than a soft
 *  recompile (which would leave stale-sized table views and crash on set()). */
function variegatedLayoutKey(model: CAModel): string {
  const v = model.variegatedCells;
  if (!v?.enabled) return 'off';
  const palettes = (v.facePalettes ?? []).map(p => `${p.id}:${p.labels.length}`).join(',');
  return `${v.sourceAttributeId}|${palettes}`;
}

// Tiny chevron icons used by the viewer / transport bar collapse toggles. Inline
// SVG (not Unicode glyphs) so the up and down variants are pixel-identical —
// fonts can't be relied on to render ⌃ and ⌄ at the same width.
const ChevronUpIcon = () => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <polyline points="1,5 5,1 9,5" />
  </svg>
);
const ChevronDownIcon = () => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <polyline points="1,1 5,5 9,1" />
  </svg>
);

export function SimulatorView({ visible = true }: { visible?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { model, modelVersion, updateIndicator, setSimulationState, addPreset, deletePreset, updatePreset, updateProperties, updateAttribute } = useModel();
  const workerRef = useRef<Worker | null>(null);
  const pendingStep = useRef(false);

  const saved = useRef(loadSimSettings());

  const [generation, setGeneration] = useState(0);
  // Generation is throttled into React state (~10 Hz) but kept up-to-date in
  // a ref every step. Synchronous readers (filename in screenshot/save-state
  // downloads, end-condition evaluation, etc.) read the ref so they see the
  // exact current value; only the visible "Gen X" + indicator panel re-render
  // tick at the throttled rate. Removes the per-step React reconcile that
  // was the second-largest per-frame cost behind the canvas-width reset.
  const generationRef = useRef(0);
  const lastGenSetTime = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [targetFps, setTargetFps] = useState((saved.current.targetFps as number) ?? 30);
  const [unlimitedFps, setUnlimitedFps] = useState((saved.current.unlimitedFps as boolean) ?? false);
  const [gensPerFrame, setGensPerFrame] = useState((saved.current.gensPerFrame as number) ?? 1);
  const [unlimitedGens, setUnlimitedGens] = useState((saved.current.unlimitedGens as boolean) ?? false);
  const [compileError, setCompileError] = useState('');
  const [activeViewer, setActiveViewer] = useState((saved.current.activeViewer as string) ?? '');
  const [showCode, setShowCode] = useState(false);
  const [compiledCode, setCompiledCode] = useState('');
  const [actualFps, setActualFps] = useState(0);
  const [actualGps, setActualGps] = useState(0);
  const [brushColor, setBrushColor] = useState((saved.current.brushColor as string) ?? '#4cc9f0');
  const [brushW, setBrushW] = useState((saved.current.brushW as number) ?? 1);
  const [brushH, setBrushH] = useState((saved.current.brushH as number) ?? 1);
  const [brushMapping, setBrushMapping] = useState((saved.current.brushMapping as string) ?? '');
  // Manual Brush — per-model state: which cell attrs are being set, and to
  // what value. Persisted per-model name in localStorage (see helpers above).
  // The merge effect below seeds defaults whenever the attribute list changes.
  const [manualBrush, setManualBrush] = useState<ManualBrushModelState>({});
  const manualBrushRef = useRef<ManualBrushModelState>({});
  useEffect(() => { manualBrushRef.current = manualBrush; }, [manualBrush]);
  const [showBrushCursor, setShowBrushCursor] = useState((saved.current.showBrushCursor as boolean) ?? true);
  const [showGridlines, setShowGridlines] = useState((saved.current.showGridlines as boolean) ?? false);
  // Infinity canvas: when the model uses torus boundary, the grid tiles into the
  // viewport so the user can pan endlessly across the wrap seams. Settings flag
  // persists across sessions, but the boundary-treatment guard below forces it
  // off whenever the active model isn't torus.
  const [infinityCanvas, setInfinityCanvas] = useState((saved.current.infinityCanvas as boolean) ?? false);
  // Per-cell glyph overlay: minimum cell pixel size below which glyphs are
  // hidden. Glyphs are unreadable at small cell sizes and the per-cell
  // drawImage loop is wasted work — gate it at the configured threshold.
  // Held in a ref (no UI control yet) — tunable via the persisted
  // `genesisca_sim_settings.glyphMinPx` localStorage key.
  const glyphMinPxRef = useRef<number>(
    (typeof saved.current.glyphMinPx === 'number' && saved.current.glyphMinPx > 0)
      ? (saved.current.glyphMinPx as number)
      : 6,
  );

  // Indicator values from worker
  // Indicator values stored in ref (not state) to avoid extra re-renders on every step.
  // The component already re-renders from setGeneration, so ref values are read during that render.
  // Scalar (standalone/linked-total) → number; linked-frequency → Record<cat,number>;
  // spatial (xAxis rows/columns) → Record<seriesKey, number[]> (per-position-bin
  // series). IndicatorDisplay branches on the indicator's xAxis to render.
  const indicatorValuesRef = useRef<Record<string, number | Record<string, number> | Record<string, number[]>>>({});
  // For scalar indicators: number[] of samples over time.
  // For linked-frequency indicators: Record<category, number[]> so each category
  // gets its own time series (drives multi-line / stacked-area charts).
  const indicatorHistoryRef = useRef<Record<string, number[] | Record<string, number[]>>>({});
  const chartExpandedRef = useRef<Set<string>>(new Set());
  // Per-indicator viz mode for frequency indicators. Default = 'bars' when absent.
  type VizMode = 'bars' | 'multiline' | 'stacked';
  const [indicatorVizModes, setIndicatorVizModes] = useState<Record<string, VizMode>>(() => {
    try {
      const raw = localStorage.getItem(SIM_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.indicatorVizModes && typeof parsed.indicatorVizModes === 'object') {
          return parsed.indicatorVizModes as Record<string, VizMode>;
        }
      }
    } catch { /* fall through */ }
    return {};
  });
  // Per-indicator set of legend categories the user has dimmed in the Lines/Stack
  // charts (runtime display-only, NOT saved into .gcaproj — distinct from the
  // model-level `trackedValues`). Stored in localStorage as Record<id, string[]>.
  const [indicatorHiddenCategories, setIndicatorHiddenCategories] = useState<Record<string, Set<string>>>(() => {
    try {
      const raw = localStorage.getItem(SIM_SETTINGS_KEY);
      if (raw) {
        const stored = JSON.parse(raw).indicatorHiddenCategories;
        if (stored && typeof stored === 'object') {
          const out: Record<string, Set<string>> = {};
          for (const [id, cats] of Object.entries(stored)) {
            if (Array.isArray(cats)) out[id] = new Set(cats as string[]);
          }
          return out;
        }
      }
    } catch { /* fall through */ }
    return {};
  });
  // Per-indicator chart-settings OVERRIDES (gear popover) — a field-level layer
  // over each Indicator.chartSettings model default. Persisted in sim settings
  // AND serialized into SimulationState under "Simulator controls".
  const [indicatorChartOverrides, setIndicatorChartOverrides] = useState<Record<string, IndicatorChartSettings>>(() => {
    try {
      const raw = localStorage.getItem(SIM_SETTINGS_KEY);
      if (raw) {
        const stored = JSON.parse(raw).indicatorChartOverrides;
        if (stored && typeof stored === 'object') return stored as Record<string, IndicatorChartSettings>;
      }
    } catch { /* fall through */ }
    return {};
  });

  // GIF / WebM recording state
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const recordedFrames = useRef<ImageData[]>([]);
  const [recordFrameCount, setRecordFrameCount] = useState(0);
  // The displayed counter is throttled (~5 Hz); the captured-frames count is
  // tracked exactly via the ref. setState every step caused a SimulatorView
  // re-render per captured frame and slowed down the recording itself.
  const recordCountRef = useRef(0);
  const lastRecordCountSet = useRef(0);
  // WebM is the default; falls back to GIF in browsers without WebCodecs.
  const webmAvailable = isWebMSupported();
  type RecordFormat = 'gif' | 'webm';
  const [recordFormat, setRecordFormat] = useState<RecordFormat>(() => {
    const saved2 = saved.current.recordFormat as RecordFormat | undefined;
    if (saved2 === 'gif') return 'gif';
    return webmAvailable ? 'webm' : 'gif';
  });
  const [encodingWebM, setEncodingWebM] = useState(false);
  useEffect(() => { recordingRef.current = recording; }, [recording]);

  // Persist simulator settings
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(SIM_SETTINGS_KEY, JSON.stringify({
          targetFps, unlimitedFps, gensPerFrame, unlimitedGens,
          activeViewer, brushColor, brushW, brushH, brushMapping, showBrushCursor, showGridlines,
          infinityCanvas, indicatorVizModes, recordFormat,
          indicatorHiddenCategories: Object.fromEntries(
            Object.entries(indicatorHiddenCategories)
              .filter(([, s]) => s.size > 0)
              .map(([id, s]) => [id, [...s]]),
          ),
          indicatorChartOverrides,
          glyphMinPx: glyphMinPxRef.current,
        }));
      } catch { /* localStorage full */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [targetFps, unlimitedFps, gensPerFrame, unlimitedGens, activeViewer, brushColor, brushW, brushH, brushMapping, showBrushCursor, showGridlines, infinityCanvas, indicatorVizModes, recordFormat, indicatorHiddenCategories, indicatorChartOverrides]);

  // Manual Brush — signature-keyed merge effect. Re-derives `manualBrush`
  // whenever the cell attribute set (id+type) changes. Surviving attrs carry
  // their stored entry; new attrs seed `{enabled: true, value: defaultValue}`;
  // type-changed attrs reset to defaults. The signature key (not the model
  // object identity) means live name/description edits in the Modeler don't
  // wipe brush state mid-edit.
  const cellAttrSig = useMemo(
    () => model.attributes.filter(a => !a.isModelAttribute).map(a => a.id + ':' + a.type).join('|'),
    [model.attributes],
  );
  const manualBrushModelKey = model.properties.name;
  useEffect(() => {
    const stored = loadManualBrush(manualBrushModelKey) ?? {};
    const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
    const next: ManualBrushModelState = {};
    for (const a of cellAttrs) {
      const prev = stored[a.id];
      // Defensive: skip attribute types we have no widget for (cell attrs are
      // bool/integer/float/tag/neighborIndex today — color/interactionTable are
      // model-only).
      if (a.type === 'color' || a.type === 'lookupTable') continue;
      next[a.id] = prev
        ? { enabled: !!prev.enabled, value: typeof prev.value === 'string' ? prev.value : (a.defaultValue ?? '') }
        : { enabled: true, value: a.defaultValue ?? '' };
    }
    setManualBrush(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualBrushModelKey, cellAttrSig]);

  // Manual Brush — debounced persistence (per-model, separate localStorage entry).
  useEffect(() => {
    const t = setTimeout(() => saveManualBrush(manualBrushModelKey, manualBrush), 300);
    return () => clearTimeout(t);
  }, [manualBrushModelKey, manualBrush]);

  const cycleIndicatorVizMode = useCallback((id: string) => {
    setIndicatorVizModes(prev => {
      const cur = prev[id] ?? 'bars';
      const next: VizMode = cur === 'bars' ? 'multiline' : cur === 'multiline' ? 'stacked' : 'bars';
      return { ...prev, [id]: next };
    });
  }, []);

  const toggleIndicatorCategory = useCallback((id: string, category: string) => {
    setIndicatorHiddenCategories(prev => {
      const next = { ...prev };
      const set = new Set(next[id] ?? []);
      if (set.has(category)) set.delete(category); else set.add(category);
      if (set.size === 0) delete next[id]; else next[id] = set;
      return next;
    });
  }, []);

  const changeIndicatorChartOverrides = useCallback((id: string, next: IndicatorChartSettings | null) => {
    setIndicatorChartOverrides(prev => {
      const out = { ...prev };
      if (next === null) delete out[id]; else out[id] = next;
      return out;
    });
  }, []);

  // F3: Runtime model attribute values
  const [runtimeModelAttrs, setRuntimeModelAttrs] = useState<Record<string, number>>({});

  // F3b: Interaction-table defaults snapshot — captured the first time we see
  // a given `modelVersion` (= a fresh LOAD_MODEL / NEW_MODEL). Used by Reset
  // to Default to restore the table values to whatever was last loaded (live
  // edits via the simulator's per-cell editor mutate `model.attributes` via
  // updateAttribute, so a plain re-read of `model.attributes` wouldn't be
  // "default" anymore). Per-cell edits don't bump modelVersion (only
  // load/new do), so the snapshot survives table edits within a session.
  const interactionTableDefaultsRef = useRef<Record<string, Record<string, Record<string, number>>>>({});
  const lastSnapshottedVersionRef = useRef<number>(-1);

  // F5: Simulator dimension overrides
  const [simWidth, setSimWidth] = useState(100);
  const [simHeight, setSimHeight] = useState(100);

  // F6: Image import pending state
  const pendingImageImport = useRef<Uint8ClampedArray | null>(null);
  const pendingImageMapping = useRef<string>('');
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Save/Load state refs
  const pendingStateSave = useRef<((state: Record<string, unknown>) => void) | null>(null);
  const stateFileInputRef = useRef<HTMLInputElement>(null);
  const pendingSimStateRestore = useRef<SimulationState | null>(null);

  // Preset-save dialog
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetOverwriteTarget, setPresetOverwriteTarget] = useState<Preset | null>(null);
  // Per-action confirmation modals — delete / overwrite. Carry the target preset
  // so the deferred onConfirm doesn't need to recapture it through a closure.
  const [presetToDelete, setPresetToDelete] = useState<Preset | null>(null);
  const [presetToOverwrite, setPresetToOverwrite] = useState<Preset | null>(null);

  // Clipboard for Ctrl+C / Ctrl+V / Ctrl+X (cell-attribute region copy)
  const clipboardRef = useRef<{
    w: number;
    h: number;
    attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
  } | null>(null);
  // If set, the next regionData response should also fire a clearRegion for the source rect (Ctrl+X)
  const pendingCutRect = useRef<{ row: number; col: number; w: number; h: number } | null>(null);

  // Colors buffer + grid dimensions
  const colorsRef = useRef<Uint8ClampedArray | null>(null);
  // Per-cell glyph overlay buffers (worker ships them only when the model uses
  // setCellGlyph AND any cell has a non-zero glyph). null otherwise — the
  // overlay path short-circuits in that case.
  const glyphCodesRef = useRef<Uint32Array | null>(null);
  const glyphColorsRef = useRef<Uint32Array | null>(null);
  const gridWidth = useRef(0);
  const gridHeight = useRef(0);

  // Zoom/Pan state (refs to avoid re-renders on every mouse move)
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const cursorGrid = useRef<{ row: number; col: number } | null>(null);
  /** Cell coordinates / brush rect under the cursor. State (not a ref) so the
   *  overlay re-renders, but only updated when the integer cell or brush
   *  dimensions change to keep mousemove cheap. */
  const [hoverCellInfo, setHoverCellInfo] = useState<{
    col: number; row: number; x0: number; y0: number; x1: number; y1: number;
  } | null>(null);
  const lastPaintGrid = useRef<{ row: number; col: number } | null>(null);
  // Paint coalescing: instead of posting a paint message per mouse-move event
  // (~50-200/sec on a fast brush drag), collect cells in a buffer and flush
  // once per requestAnimationFrame. Each flush is a single round-trip through
  // the worker → GPU pipeline. The mouse-up handler force-flushes so the last
  // partial batch isn't lost. Different mappingIds within one batch are
  // flushed eagerly (rare in practice — only when the user changes brush
  // mid-drag, which already breaks the Bresenham line at lastPaintGrid reset).
  const pendingPaintCells = useRef<Array<{ row: number; col: number; r: number; g: number; b: number }>>([]);
  const pendingPaintMapping = useRef<string | null>(null);
  const pendingPaintViewer = useRef<string>('');
  const pendingPaintRaf = useRef<number | null>(null);

  // FPS + Gens/s tracking
  const fpsFrames = useRef(0);
  const fpsLastTime = useRef(performance.now());
  const gpsGens = useRef(0);
  const lastGenForGps = useRef(0);

  // 1:1 pixel source canvas (reused across draws)
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // P7 — when true, srcCanvasRef has had its 2D context transferred to the
  // worker via OffscreenCanvas. The worker writes WebGPU output directly to
  // it, so draw() must skip the putImageData step and only do the
  // zoom/pan drawImage. Reset when the worker is reinitialised.
  const directRenderActiveRef = useRef<boolean>(false);
  // True between worker init and the first useWebGPUStatus { ready: true }
  // message: signals that we still owe the worker a canvas transfer once it
  // confirms WebGPU is up. We defer the transfer (rather than doing it
  // optimistically at init time) so the JS-fallback period during async
  // device acquisition can still draw via putImageData on a regular 2D
  // canvas. Set in initWorkerWithDimensions; cleared in the
  // useWebGPUStatus handler after the canvas is sent.
  const pendingCanvasAttach = useRef<boolean>(false);
  // Holds the about-to-be-direct-render canvas between the moment we send
  // attachCanvas to the worker and the moment the worker confirms direct
  // render is live (second useWebGPUStatus { ready: true, directRender: true }).
  // Until that ack arrives we keep srcCanvasRef pointing at the regular 2D
  // canvas (which has the latest JS-fallback putImageData content) so draw()
  // doesn't flash blank. If the ack never arrives (worker rejected attach,
  // or the runtime was destroyed before processing it), the placeholder
  // canvas stays orphaned and we stay on the JS-fallback path.
  const pendingDirectRenderCanvas = useRef<HTMLCanvasElement | null>(null);
  // True between sending a soft `recompile` message under WebGPU direct render
  // and receiving the worker's post-rebuild `useWebGPUStatus { ready: true,
  // directRender: true }`. Used to trigger a fresh canvas re-attach so we
  // sidestep an issue where reusing the salvaged OffscreenCanvas across a
  // device swap leaves it in a broken state (no subsequent present produces
  // visible output, even play / viewer switches don't recover). Full Recompile
  // works because it creates a fresh canvas via Phase 1 — this flag opts the
  // soft recompile path into the same fresh-canvas treatment, but without
  // tearing down the worker (so model attribute sliders + grid state survive).
  const recompilePendingCanvasRefresh = useRef<boolean>(false);

  // Build full code display from all compiled functions
  const buildFullCode = useCallback((result: ReturnType<typeof compileGraph>) => {
    const parts: string[] = [];
    if (result.stepCode) {
      parts.push('// === Step Function ===\n' + result.stepCode);
    }
    if (result.initCode) {
      parts.push('// === Init Event (per-cell, runs once on Reset) ===\n' + result.initCode);
    }
    for (const ic of result.inputColorCodes) {
      const m = model.mappings.find(mp => mp.id === ic.mappingId);
      parts.push(`// === Input Mapping: ${m?.name || ic.mappingId} ===\n${ic.code}`);
    }
    for (const om of result.outputMappingCodes) {
      const m = model.mappings.find(mp => mp.id === om.mappingId);
      parts.push(`// === Output Mapping: ${m?.name || om.mappingId} ===\n${om.code}`);
    }
    return parts.join('\n\n');
  }, [model.mappings]);

  // Compile graph (deps include indicator watched state since it affects compiled code).
  // Always returns the JS CompileResult — it's the universal fallback for the worker
  // and the Show Code source when JS is the selected target. The Show Code panel
  // displays whichever artefact matches the currently-selected compile target:
  //   - JS selected      → readable JS source from buildFullCode
  //   - WebGPU selected  → WGSL shader source (an extra compile pass; only when active)
  //   - WASM selected    → placeholder string (binary, not human-readable)
  const compileModel = useCallback(() => {
    const m = withEffectiveNeighborhoods(model);
    const result = compileGraph(m.graphNodes, m.graphEdges, m);
    if (model.properties.useWebGPU) {
      try {
        const wgpu = compileGraphWebGPU(m.graphNodes, m.graphEdges, m);
        setCompiledCode(wgpu.shaderCode || '(no shader emitted)');
        setCompileError(wgpu.error || result.error || '');
      } catch (e) {
        setCompiledCode('');
        setCompileError(String((e as Error)?.message || e));
      }
    } else if (model.properties.useWasm) {
      setCompiledCode(
        '/* WebAssembly target selected.\n' +
        ' * The compiled module is a binary WASM blob — not human-readable.\n' +
        ' * Switch to "Debug / Reference (JS)" in Model Properties to inspect generated code.\n' +
        ' */'
      );
      setCompileError(result.error ?? '');
    } else {
      setCompiledCode(buildFullCode(result));
      setCompileError(result.error ?? '');
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.graphNodes, model.graphEdges, model.neighborhoods, model.indicators, model.properties.useWasm, model.properties.useWebGPU, buildFullCode]);

  // Draw using ImageData + zoom/pan transform
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const colors = colorsRef.current;
    const w = gridWidth.current;
    const h = gridHeight.current;
    if (!canvas || !w || !h) return;
    // P7 direct render: srcCanvas is populated by the worker via WebGPU, so
    // we don't need a CPU `colors` buffer to draw. Without direct render, a
    // missing colors buffer means we have nothing to display yet.
    if (!colors && !directRenderActiveRef.current) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Canvas fills available space. Setting canvas.width / .height resets the
    // backing store — one of the slowest browser operations and the dominant
    // per-frame cost on the play hot path. Only re-assign when dimensions
    // ACTUALLY changed (parent resize, panel collapse, etc).
    const parentW = canvas.parentElement?.clientWidth ?? 500;
    const parentH = canvas.parentElement?.clientHeight ?? 500;
    if (canvas.width !== parentW) canvas.width = parentW;
    if (canvas.height !== parentH) canvas.height = parentH;

    // Build 1:1 pixel source from RGBA buffer.
    // P7 direct render: when the canvas was transferred to the worker, the
    // OffscreenCanvas already holds the latest GPU-rendered frame — skip
    // putImageData (and DON'T recreate, since transferControlToOffscreen has
    // moved ownership of the 2D context).
    if (directRenderActiveRef.current && srcCanvasRef.current) {
      // canvas dimensions are fixed at transfer time; nothing to do here.
    } else if (colors) {
      if (!srcCanvasRef.current || srcCanvasRef.current.width !== w || srcCanvasRef.current.height !== h) {
        srcCanvasRef.current = document.createElement('canvas');
        srcCanvasRef.current.width = w;
        srcCanvasRef.current.height = h;
      }
      const srcCtx = srcCanvasRef.current.getContext('2d')!;
      const imageData = new ImageData(
        new Uint8ClampedArray(colors.buffer, colors.byteOffset, w * h * 4),
        w, h,
      );
      srcCtx.putImageData(imageData, 0, 0);
    }

    // Clear and apply zoom/pan
    ctx.clearRect(0, 0, parentW, parentH);
    ctx.imageSmoothingEnabled = false;

    const zoom = zoomRef.current;
    const pan = panRef.current;

    // Default scale: fit grid in canvas
    const baseScale = Math.min(parentW / w, parentH / h);
    const scale = baseScale * zoom;
    const scaledW = w * scale;
    const scaledH = h * scale;

    // Center the grid + apply pan offset
    const ox = (parentW - scaledW) / 2 + pan.x;
    const oy = (parentH - scaledH) / 2 + pan.y;

    // Infinity canvas: tile the grid bitmap across the viewport. Only engaged when
    // the toggle is on AND the model uses torus boundary — otherwise we'd render a
    // tiled image that lies about the simulation physics.
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';

    // Soft cap: at extreme zoom-out (cells << 1px) the tile count explodes. Beyond
    // ~256 visible tiles we draw only the centre tile to keep per-frame cost bounded.
    let txMin = 0, txMax = 0, tyMin = 0, tyMax = 0;
    if (infinity && scaledW > 0 && scaledH > 0) {
      txMin = Math.floor(-ox / scaledW);
      txMax = Math.floor((parentW - ox) / scaledW);
      tyMin = Math.floor(-oy / scaledH);
      tyMax = Math.floor((parentH - oy) / scaledH);
      const tileCount = (txMax - txMin + 1) * (tyMax - tyMin + 1);
      if (tileCount > 256) {
        txMin = txMax = tyMin = tyMax = 0;
      }
    }

    // Per-cell glyph overlay. Drawn AFTER the colour blit (so glyphs sit on
    // top of cell colours) but BEFORE gridlines and brush cursor (so those
    // remain crisp on top of glyphs). Skipped entirely when no glyph data
    // arrived for this frame OR cells are too small to read (<6px default;
    // configurable via genesisca_sim_settings.glyphMinPx).
    const drawGlyphOverlay = () => {
      const codes = glyphCodesRef.current;
      const cols = glyphColorsRef.current;
      if (!codes || !cols) return;
      const minPx = glyphMinPxRef.current;
      if (scale < minPx) return;
      const tileSize = Math.max(2, Math.round(scale));
      // Visible cell range. We compute once per (tile origin) for the infinity
      // path; for the non-infinity path tx=ty=0 only.
      const drawForTile = (tileOx: number, tileOy: number) => {
        const colMin = Math.max(0, Math.floor((0 - tileOx) / scale));
        const colMax = Math.min(w - 1, Math.ceil((parentW - tileOx) / scale));
        const rowMin = Math.max(0, Math.floor((0 - tileOy) / scale));
        const rowMax = Math.min(h - 1, Math.ceil((parentH - tileOy) / scale));
        if (colMin > colMax || rowMin > rowMax) return;
        for (let row = rowMin; row <= rowMax; row++) {
          const rowBase = row * w;
          const screenY = Math.round(tileOy + row * scale);
          for (let col = colMin; col <= colMax; col++) {
            const i = rowBase + col;
            const cp = codes[i]!;
            if (cp === 0) continue;
            const packed = cols[i]!;
            const r = packed & 0xff;
            const g = (packed >> 8) & 0xff;
            const b = (packed >> 16) & 0xff;
            const tile = getGlyphTile(cp, r, g, b, tileSize);
            const screenX = Math.round(tileOx + col * scale);
            ctx.drawImage(tile, screenX, screenY, tileSize, tileSize);
          }
        }
      };
      if (infinity) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          for (let tx = txMin; tx <= txMax; tx++) {
            drawForTile(ox + tx * scaledW, oy + ty * scaledH);
          }
        }
      } else {
        drawForTile(ox, oy);
      }
    };

    if (srcCanvasRef.current) {
      if (infinity) {
        // Snap each tile's left/top edges to integer pixels and derive width/height
        // from the difference with the NEXT tile's left/top. This guarantees that
        // tile (tx)'s right edge == tile (tx+1)'s left edge to the pixel — otherwise
        // sub-pixel destination positions at non-integer scaledW leave faint seams
        // (a half-pixel gap or overlap) at every tile boundary.
        for (let ty = tyMin; ty <= tyMax; ty++) {
          const yTop = Math.round(oy + ty * scaledH);
          const yBot = Math.round(oy + (ty + 1) * scaledH);
          for (let tx = txMin; tx <= txMax; tx++) {
            const xLeft = Math.round(ox + tx * scaledW);
            const xRight = Math.round(ox + (tx + 1) * scaledW);
            ctx.drawImage(srcCanvasRef.current, xLeft, yTop, xRight - xLeft, yBot - yTop);
          }
        }
      } else {
        ctx.drawImage(srcCanvasRef.current, ox, oy, scaledW, scaledH);
      }
    }

    // Glyph overlay (after colour blit, before gridlines + cursor).
    drawGlyphOverlay();

    // Draw gridlines when zoomed in enough (cells >= 4px)
    if (showGridlinesRef.current && scale >= 4) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const xtMin = infinity ? txMin : 0;
      const xtMax = infinity ? txMax : 0;
      const ytMin = infinity ? tyMin : 0;
      const ytMax = infinity ? tyMax : 0;
      for (let ty = ytMin; ty <= ytMax; ty++) {
        for (let tx = xtMin; tx <= xtMax; tx++) {
          const tileOx = ox + tx * scaledW;
          const tileOy = oy + ty * scaledH;
          const tileTop = Math.max(0, tileOy);
          const tileBot = Math.min(parentH, tileOy + scaledH);
          const tileLeft = Math.max(0, tileOx);
          const tileRight = Math.min(parentW, tileOx + scaledW);
          for (let col = 0; col <= w; col++) {
            const x = tileOx + col * scale;
            if (x >= 0 && x <= parentW) {
              ctx.moveTo(x, tileTop);
              ctx.lineTo(x, tileBot);
            }
          }
          for (let row = 0; row <= h; row++) {
            const y = tileOy + row * scale;
            if (y >= 0 && y <= parentH) {
              ctx.moveTo(tileLeft, y);
              ctx.lineTo(tileRight, y);
            }
          }
        }
      }
      ctx.stroke();
    }

    // Draw brush cursor rectangle. In infinity mode, draw one copy per visible
    // tile so the user always sees the brush location — using the same tile range
    // as the bitmap loop, not a fixed 3×3 neighbourhood (which left the far tiles
    // without an outline when the user zoomed out enough to see 4+ tiles per axis).
    // The rect itself can extend past a tile's edge into the neighbour; emitting
    // it on each tile naturally produces the wrap-onto-adjacent-tile visual.
    const cursor = cursorGrid.current;
    if (cursor && showBrushCursorRef.current) {
      const bw = brushWRef.current;
      const bh = brushHRef.current;
      const halfW = Math.floor((bw - 1) / 2);
      const halfH = Math.floor((bh - 1) / 2);
      const bx = ox + (cursor.col - halfW) * scale;
      const by = oy + (cursor.row - halfH) * scale;
      const bWidth = bw * scale;
      const bHeight = bh * scale;
      ctx.strokeStyle = 'rgba(76, 201, 240, 0.7)';
      ctx.lineWidth = 1;
      if (infinity) {
        // Extend by ceil(brushSize / gridSize) tiles on each side so a brush
        // that spans more than one tile still draws every overhanging copy.
        // The per-copy viewport-intersection check below culls anything off-screen.
        const brushSpanX = Math.max(1, Math.ceil(bw / w));
        const brushSpanY = Math.max(1, Math.ceil(bh / h));
        for (let ty = tyMin - brushSpanY; ty <= tyMax + brushSpanY; ty++) {
          for (let tx = txMin - brushSpanX; tx <= txMax + brushSpanX; tx++) {
            const rx = bx + tx * scaledW;
            const ry = by + ty * scaledH;
            if (rx + bWidth < 0 || rx > parentW || ry + bHeight < 0 || ry > parentH) continue;
            ctx.strokeRect(rx, ry, bWidth, bHeight);
          }
        }
      } else {
        ctx.strokeRect(bx, by, bWidth, bHeight);
      }
    }

    // Middle-click autoscroll indicator: small unfilled ring + centre dot at the
    // anchor, plus a faint direction line to the cursor. Kept low-contrast so it
    // doesn't compete with the cell content visually.
    const aoOrigin = autoscrollOriginRef.current;
    const aoCursor = autoscrollCursorRef.current;
    if (aoOrigin) {
      ctx.save();
      if (aoCursor) {
        const dx = aoCursor.x - aoOrigin.x;
        const dy = aoCursor.y - aoOrigin.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 12) {
          ctx.strokeStyle = 'rgba(220, 230, 245, 0.18)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(aoOrigin.x, aoOrigin.y);
          ctx.lineTo(aoCursor.x, aoCursor.y);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = 'rgba(220, 230, 245, 0.35)';
      ctx.fillStyle = 'rgba(220, 230, 245, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(aoOrigin.x, aoOrigin.y, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(aoOrigin.x, aoOrigin.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    fpsFrames.current++;
  }, []);

  // Track playing state in ref so worker message handler can access it
  const playingRef = useRef(false);
  const gensPerFrameRef = useRef(1);
  const targetFpsRef = useRef(30);
  const lastStepSentTime = useRef(0);
  const lastDrawTime = useRef(0);
  // P4 — replaced setTimeout with rAF for steadier pacing aligned to vsync.
  // setTimeout coalescing made high-FPS playback irregular ("stutter") because
  // the browser drifts timers under load. rAF resolves at the display's
  // refresh boundary, so the play loop ticks at predictable intervals.
  const nextStepRaf = useRef<number | null>(null);
  const unlimitedFpsRef = useRef(false);
  const unlimitedGensRef = useRef(false);
  const endConditionsRef = useRef(model.properties.endConditions);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { gensPerFrameRef.current = unlimitedGens ? 100 : gensPerFrame; }, [gensPerFrame, unlimitedGens]);
  useEffect(() => { targetFpsRef.current = unlimitedFps ? 999999 : targetFps; }, [targetFps, unlimitedFps]);
  useEffect(() => { unlimitedFpsRef.current = unlimitedFps; }, [unlimitedFps]);
  useEffect(() => { unlimitedGensRef.current = unlimitedGens; }, [unlimitedGens]);
  useEffect(() => { endConditionsRef.current = model.properties.endConditions; }, [model.properties.endConditions]);

  // End-condition evaluation: returns a non-empty reason string when the
  // simulation should auto-pause. Evaluated after each `stepped` message.
  const [endConditionNotice, setEndConditionNotice] = useState<string | null>(null);
  const endNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evalEndConditions = useCallback((gen: number, indicatorValues: Record<string, number | Record<string, number> | Record<string, number[]>>): string | null => {
    const ec = endConditionsRef.current;
    if (!ec || !ec.enabled) return null;
    if (typeof ec.maxGenerations === 'number' && ec.maxGenerations > 0 && gen >= ec.maxGenerations) {
      return `Max generations reached (${ec.maxGenerations})`;
    }
    for (const cond of ec.indicatorConditions || []) {
      const raw = indicatorValues[cond.indicatorId];
      const ind = (model.indicators || []).find(i => i.id === cond.indicatorId);
      if (!ind) continue;

      // Resolve the numeric left-hand-side of the comparison, depending on
      // whether this is a scalar indicator or a linked-frequency map.
      let lhs: number | null = null;
      let labelSuffix = '';
      if (typeof raw === 'number') {
        lhs = raw;
      } else if (raw && typeof raw === 'object') {
        // Linked-frequency value. Float-binned frequencies are disabled in the
        // UI (no stable category key at design time) — skip them here as a
        // safety net so a stale saved condition can't unexpectedly fire.
        const cellAttr = (model.attributes || []).find(a => a.id === ind.linkedAttributeId);
        if (cellAttr?.type === 'float') continue;
        const category = cond.category;
        if (category === undefined || category === '') continue;
        lhs = (raw as Record<string, number>)[category] ?? 0;
        labelSuffix = ` [${category}]`;
      }
      if (lhs === null) continue;

      const target = ind.dataType === 'bool' && cond.category === undefined
        ? (cond.value === 'true' || cond.value === '1' ? 1 : 0)
        : Number(cond.value);
      if (!Number.isFinite(target)) continue;

      let match = false;
      switch (cond.op) {
        case '==': match = lhs === target; break;
        case '!=': match = lhs !== target; break;
        case '>':  match = lhs >  target; break;
        case '<':  match = lhs <  target; break;
        case '>=': match = lhs >= target; break;
        case '<=': match = lhs <= target; break;
      }
      if (match) {
        const name = ind.name || cond.indicatorId;
        return `${name}${labelSuffix} ${cond.op} ${cond.value}`;
      }
    }
    return null;
  }, [model.indicators, model.attributes]);

  const sendNextStep = useCallback(() => {
    if (!playingRef.current || pendingStep.current) return;
    pendingStep.current = true;
    lastStepSentTime.current = performance.now();
    workerRef.current?.postMessage({
      type: 'step',
      count: gensPerFrameRef.current,
      activeViewer: activeViewerRef.current,
      skipColorPass: unlimitedGensRef.current,
    });
  }, []);

  // Handle messages from worker
  const onWorkerMessageRef = useRef<(e: MessageEvent) => void>(() => {});
  onWorkerMessageRef.current = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'inspectCellsData') {
      // Worker batched attribute readout + per-cell RGB for all subscribed
      // inspect cells. Per-cell colors are bundled here (instead of relying
      // on colorsRef) so the popover swatch works uniformly across JS / WASM
      // / WebGPU direct render — under direct render the full colors buffer
      // is never sent to the main thread.
      inspectDataRef.current.clear();
      inspectColorsRef.current.clear();
      inspectOrientationsRef.current.clear();
      const data = msg.data as Record<string, Record<string, number>>;
      for (const k of Object.keys(data)) inspectDataRef.current.set(Number(k), data[k]!);
      const colors = msg.colors as Record<string, { r: number; g: number; b: number }> | undefined;
      if (colors) {
        for (const k of Object.keys(colors)) inspectColorsRef.current.set(Number(k), colors[k]!);
      }
      const orientations = msg.orientations as Record<string, number> | undefined;
      if (orientations) {
        for (const k of Object.keys(orientations)) inspectOrientationsRef.current.set(Number(k), orientations[k]!);
      }
      bumpInspectVersion(v => v + 1);
      return;
    }
    if (msg.type === 'stepped') {
      colorsRef.current = msg.colors as Uint8ClampedArray;
      // Glyph overlay buffers — undefined when the model has no setCellGlyph
      // OR when every cell's glyph code is 0 this frame. Clearing to null in
      // the latter case lets the overlay skip the loop entirely (no need to
      // iterate visible cells just to find all zeros).
      const gc = msg.glyphCodes as Uint32Array | undefined;
      const gcol = msg.glyphColors as Uint32Array | undefined;
      glyphCodesRef.current = gc ?? null;
      glyphColorsRef.current = gcol ?? null;
      if (msg.indicators) {
        indicatorValuesRef.current = msg.indicators;
        // Collect history for indicators with expanded charts. Scalars → number[];
        // frequency maps → Record<category, number[]> so multi-line / stacked-area
        // charts can draw one series per category.
        const expanded = chartExpandedRef.current;
        if (expanded.size > 0) {
          const hist = indicatorHistoryRef.current;
          for (const id of expanded) {
            const v = msg.indicators[id];
            if (typeof v === 'number') {
              let arr = hist[id];
              if (!arr || !Array.isArray(arr)) { arr = []; hist[id] = arr; }
              (arr as number[]).push(v);
              if ((arr as number[]).length > 500) (arr as number[]).shift();
            } else if (v && typeof v === 'object') {
              // Spatial indicators send Record<seriesKey, number[]> (per-position
              // bin) — a live snapshot, NOT a time-history. Skip history
              // collection entirely; IndicatorSpatialChart reads the current
              // value directly from indicatorValuesRef. Detect structurally by an
              // array-valued entry (generation-axis frequency maps are number-valued).
              if (Array.isArray(Object.values(v)[0])) continue;
              let perCat = hist[id];
              if (!perCat || Array.isArray(perCat)) { perCat = {}; hist[id] = perCat; }
              for (const [cat, count] of Object.entries(v as Record<string, number>)) {
                let series = (perCat as Record<string, number[]>)[cat];
                if (!series) { series = []; (perCat as Record<string, number[]>)[cat] = series; }
                series.push(count);
                if (series.length > 500) series.shift();
              }
            }
          }
        }
      }
      const gen = msg.generation as number;
      gpsGens.current += gen - lastGenForGps.current;
      lastGenForGps.current = gen;

      pendingStep.current = false;

      // End-condition check: pause and surface a notice when a configured rule
      // matches. Only evaluated while playing to avoid re-pausing on each
      // manual step after the condition is already met.
      if (playingRef.current) {
        const reason = evalEndConditions(gen, indicatorValuesRef.current);
        if (reason) {
          playingRef.current = false;
          setPlaying(false);
          setEndConditionNotice(reason);
          if (endNoticeTimer.current) clearTimeout(endNoticeTimer.current);
          endNoticeTimer.current = setTimeout(() => setEndConditionNotice(null), 4000);
        }
      }

      // Update metrics (runs on every result, even without drawing)
      const now = performance.now();
      if (now - fpsLastTime.current >= 1000) {
        setActualFps(fpsFrames.current);
        setActualGps(gpsGens.current);
        fpsFrames.current = 0;
        gpsGens.current = 0;
        fpsLastTime.current = now;
      }

      generationRef.current = gen;
      if (unlimitedGensRef.current && playingRef.current) {
        // Unlimited gens: skip drawing, update generation counter periodically
        if (now - lastDrawTime.current >= 500) {
          lastDrawTime.current = now;
          setGeneration(gen);
          lastGenSetTime.current = now;
        }
        sendNextStep();
      } else {
        // Normal: throttle the React state update to ~10 Hz so the indicator
        // panel + transport-bar gen counter don't reconcile every step. Ref
        // is always current; visible UI ticks at a human-readable rate.
        if (now - lastGenSetTime.current >= 100) {
          setGeneration(gen);
          lastGenSetTime.current = now;
        }
        draw();
        // Under WebGPU direct render, drawImage(srcCanvas) reads the
        // OffscreenCanvas placeholder's *last-composited* frame. The worker
        // has just dispatched the present pass and posted stepped, but the
        // browser's compositor may not have picked up that frame yet — so
        // the immediate draw above can blit the *previous* frame. Schedule
        // a follow-up draw on the next animation frame: by then the
        // compositor has run, drawImage reads the new frame, and the user
        // sees the actual result of paint / paste / clear / reset / etc.
        // Without this, one-shot mutations under direct render leave the
        // canvas showing stale post-Play state until the next user action.
        // Cost is negligible (one extra drawImage at vsync rate).
        if (directRenderActiveRef.current) {
          requestAnimationFrame(() => draw());
        }

        // GIF frame capture. Two source paths depending on render mode:
        // - Non-direct (JS / WASM, or WebGPU pre-P7): srcCanvas's 2D context
        //   is available; getImageData reads the latest frame.
        // - Direct render: srcCanvas was transferred to the worker, so the
        //   2D context is unavailable. The worker (when recording) ships
        //   colors in the stepped message; we build ImageData directly.
        if (recordingRef.current) {
          const w = gridWidth.current, h = gridHeight.current;
          const stepColors = colorsRef.current;
          // Defensive dimension check: never push a frame whose size doesn't
          // match the first captured frame. Protects the GIF encode from
          // corrupted output if anything (mode toggle, off-cycle resize,
          // race) sneaks a different-sized frame past initWorker's
          // stop-recording reset.
          const expected = recordedFrames.current[0];
          let frame: ImageData | null = null;
          if (directRenderActiveRef.current && stepColors && w && h && stepColors.length >= w * h * 4) {
            // stepColors is the freshly-readback'd Uint8ClampedArray from
            // worker (only present in stepped when recording is active).
            // Copy it before buffering since later steps reuse the slot.
            const data = new Uint8ClampedArray(stepColors.buffer, stepColors.byteOffset, w * h * 4);
            frame = new ImageData(new Uint8ClampedArray(data), w, h);
          } else if (srcCanvasRef.current && !directRenderActiveRef.current) {
            const src = srcCanvasRef.current;
            let sctx: CanvasRenderingContext2D | null = null;
            try { sctx = src.getContext('2d'); } catch { /* transferred */ }
            if (sctx && src.width > 0 && src.height > 0) {
              frame = sctx.getImageData(0, 0, src.width, src.height);
            }
          }
          if (frame && (!expected || (frame.width === expected.width && frame.height === expected.height))) {
            recordedFrames.current.push(frame);
            recordCountRef.current += 1;
          }
          // Throttle the visible counter to ~5 Hz so we don't re-render the
          // SimulatorView on every captured frame.
          if (recordCountRef.current > 0 && now - lastRecordCountSet.current >= 200) {
            setRecordFrameCount(recordCountRef.current);
            lastRecordCountSet.current = now;
          }
        }

        // Schedule next step to maintain targetFps rate. Uses rAF so the
        // dispatch lands on a vsync boundary; if the target rate is below
        // the display's refresh, we wait additional rAFs until elapsed time
        // matches `msPerFrame`. At unlimited FPS, fires on every rAF.
        if (playingRef.current) {
          const msPerFrame = 1000 / targetFpsRef.current;
          if (nextStepRaf.current != null) cancelAnimationFrame(nextStepRaf.current);
          const tick = () => {
            nextStepRaf.current = null;
            if (!playingRef.current) return;
            const elapsed = performance.now() - lastStepSentTime.current;
            if (elapsed >= msPerFrame - 0.5) {
              sendNextStep();
            } else {
              nextStepRaf.current = requestAnimationFrame(tick);
            }
          };
          nextStepRaf.current = requestAnimationFrame(tick);
        }
      }
    } else if (msg.type === 'stopEvent') {
      // Compiled Stop Event node fired in the worker. Pause and surface the
      // user's message via the same blue notice used for end conditions.
      playingRef.current = false;
      setPlaying(false);
      setEndConditionNotice(String(msg.message ?? 'Stop condition reached'));
      if (endNoticeTimer.current) clearTimeout(endNoticeTimer.current);
      endNoticeTimer.current = setTimeout(() => setEndConditionNotice(null), 4000);
    } else if (msg.type === 'error') {
      setCompileError(msg.message as string);
      pendingStep.current = false;
    } else if (msg.type === 'ready') {
      pendingStep.current = false;
    } else if (msg.type === 'state') {
      if (pendingStateSave.current) {
        pendingStateSave.current(msg);
        pendingStateSave.current = null;
      }
    } else if (msg.type === 'regionData') {
      // Worker responded to a readRegion request — stash in the clipboard (copied by slice()
      // so subsequent pastes can reuse the same data).
      const attrs: Record<string, { type: string; buffer: ArrayBuffer }> = {};
      for (const [id, entry] of Object.entries(msg.attributes as Record<string, { type: string; buffer: ArrayBuffer }>)) {
        const copy = (entry.buffer as ArrayBuffer).slice(0);
        attrs[id] = { type: entry.type, buffer: copy };
      }
      clipboardRef.current = { w: msg.w as number, h: msg.h as number, attributes: attrs };
      // If this was a Ctrl+X, now clear the source rectangle
      if (pendingCutRect.current) {
        const rect = pendingCutRect.current;
        pendingCutRect.current = null;
        workerRef.current?.postMessage({
          type: 'clearRegion',
          row: rect.row, col: rect.col, w: rect.w, h: rect.h,
          activeViewer: activeViewerRef.current,
        });
      }
    }

    // F6: If there's a pending image import and we just got the first stepped (init done), send it
    if (msg.type === 'stepped' && pendingImageImport.current) {
      const pixels = pendingImageImport.current;
      pendingImageImport.current = null;
      workerRef.current?.postMessage(
        {
          type: 'importImage',
          pixels,
          mappingId: pendingImageMapping.current,
          activeViewer: activeViewerRef.current,
        },
        { transfer: [pixels.buffer] },
      );
    }

    // One-shot colors snapshot — used by handleScreenshot under direct render
    // (where the placeholder srcCanvas can't be read on the main thread).
    if (msg.type === 'colorsSnapshot') {
      const cb = screenshotPendingRef.current;
      if (cb && msg.tag === 'screenshot') {
        screenshotPendingRef.current = null;
        cb({ w: msg.w as number, h: msg.h as number, colors: msg.colors as Uint8ClampedArray | undefined });
      }
      return;
    }

    // Restore simulation state from loaded .gcaproj (after worker init completes)
    if (msg.type === 'stepped' && pendingSimStateRestore.current) {
      const state = pendingSimStateRestore.current;
      pendingSimStateRestore.current = null;
      applySimulationState(state);
    }

    // P7 deferred attach: a two-phase handshake with the worker so we never
    // claim direct render before it's actually live.
    //
    //   Phase 1 — useWebGPUStatus { ready: true, directRender: false }:
    //     Worker has its WebGPU runtime up but no canvas yet. We allocate a
    //     fresh canvas, transferControlToOffscreen, and ship it via
    //     attachCanvas. We do NOT swap srcCanvasRef yet — keep the existing
    //     regular 2D canvas (with its JS-fallback putImageData content) so
    //     draw() doesn't flash blank during the GPU's first present.
    //
    //   Phase 2 — useWebGPUStatus { ready: true, directRender: true }:
    //     Worker has wired the canvas in setupDirectRender and dispatched the
    //     first present. NOW we swap srcCanvasRef to the transferred canvas
    //     and flip directRenderActiveRef. Subsequent draw() reads GPU output.
    //
    // If Phase 2 never arrives (attachCanvas rejected, runtime destroyed in
    // a race), the transferred canvas stays orphaned in pendingDirectRenderCanvas
    // and we stay permanently on JS-fallback — graceful degradation.
    if (msg.type === 'useWebGPUStatus') {
      if (msg.ready && msg.directRender && pendingDirectRenderCanvas.current) {
        // Phase 2 ack — commit the swap.
        srcCanvasRef.current = pendingDirectRenderCanvas.current;
        pendingDirectRenderCanvas.current = null;
        directRenderActiveRef.current = true;
      } else if (msg.ready && msg.directRender && recompilePendingCanvasRefresh.current) {
        // Post-soft-recompile fresh-canvas swap. Allocate a NEW srcCanvas
        // placeholder, transferControlToOffscreen, and send attachCanvas to
        // the worker. Worker discards the salvaged-but-broken OffscreenCanvas
        // and runs setupDirectRender against the fresh one. The Phase 2
        // branch above commits the swap when the worker's reply lands. Grid
        // state and model attribute sliders survive because the worker isn't
        // torn down. The OFFSCREEN-RENDER FALSE branch never runs here —
        // the recompile path always lands in direct render when the user has
        // useWebGPU on.
        recompilePendingCanvasRefresh.current = false;
        try {
          const fresh = document.createElement('canvas');
          fresh.width = gridWidth.current;
          fresh.height = gridHeight.current;
          const offscreen = (fresh as HTMLCanvasElement & {
            transferControlToOffscreen: () => OffscreenCanvas;
          }).transferControlToOffscreen();
          pendingDirectRenderCanvas.current = fresh;
          workerRef.current?.postMessage(
            { type: 'attachCanvas', canvas: offscreen, width: fresh.width, height: fresh.height },
            [offscreen],
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[webgpu] post-recompile canvas refresh failed; staying with stale canvas:', e);
        }
      } else if (msg.ready && pendingCanvasAttach.current) {
        // Phase 1 ack — send attachCanvas, stash the fresh canvas, but DON'T
        // swap srcCanvasRef or set directRenderActiveRef yet.
        pendingCanvasAttach.current = false;
        try {
          const fresh = document.createElement('canvas');
          fresh.width = gridWidth.current;
          fresh.height = gridHeight.current;
          const offscreen = (fresh as HTMLCanvasElement & {
            transferControlToOffscreen: () => OffscreenCanvas;
          }).transferControlToOffscreen();
          workerRef.current?.postMessage(
            { type: 'attachCanvas', canvas: offscreen, width: fresh.width, height: fresh.height },
            [offscreen],
          );
          pendingDirectRenderCanvas.current = fresh;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[webgpu] deferred OffscreenCanvas transfer failed; staying on readback path:', e);
          directRenderActiveRef.current = false;
          pendingDirectRenderCanvas.current = null;
        }
      } else if (msg.ready === false) {
        // Worker reports WebGPU is off (init failure or explicit downgrade).
        // Drop any pending direct-render canvas so we don't apply it later.
        directRenderActiveRef.current = false;
        pendingDirectRenderCanvas.current = null;
      }
    }
  };

  // Reusable worker initializer (used by structural effect and dimension/image apply)
  const initWorkerWithDimensions = useCallback((w: number, h: number) => {
    // If a recording is in progress, abandon it before tearing down the
    // worker. Otherwise the captured frames (sized to the OUTGOING worker's
    // grid) would mix with future captures (sized to the INCOMING worker's
    // grid), and the GIF builder would encode the mixed buffer at the first
    // frame's dimensions — silently producing a broken / wrong-sized GIF
    // that only partially reflects what the user saw.
    if (recordingRef.current) {
      recordingRef.current = false;
      setRecording(false);
      recordedFrames.current = [];
      recordCountRef.current = 0;
      lastRecordCountSet.current = 0;
      setRecordFrameCount(0);
      // Tell the worker to stop including colors in stepped messages.
      workerRef.current?.postMessage({ type: 'setRecording', enabled: false });
    }
    workerRef.current?.terminate();
    // Clear stale buffers from the OUTGOING worker. Without this, `draw()`
    // can fire in the gap between `gridWidth.current = w` (below) and the
    // first stepped message from the new worker, and try to build a
    // `new Uint8ClampedArray(colors.buffer, 0, w*h*4)` view sized for the
    // NEW grid over the PREVIOUS worker's smaller colors buffer — throwing
    // "Invalid typed array length" and tearing down React. Same risk
    // applies to inspect-cell maps (a stale entry keyed by a no-longer-
    // -valid cellIdx). srcCanvas is rebuilt on the next draw when needed.
    colorsRef.current = null;
    glyphCodesRef.current = null;
    glyphColorsRef.current = null;
    inspectDataRef.current.clear();
    inspectColorsRef.current.clear();
    inspectOrientationsRef.current.clear();
    srcCanvasRef.current = null;
    const result = compileModel();
    const firstViewer = model.mappings.find(m => m.isAttributeToColor);
    const viewer = firstViewer?.id ?? '';
    setActiveViewer(viewer);
    const firstInput = model.mappings.find(m => !m.isAttributeToColor);
    // Fall back to the always-available Manual Brush when the model has no
    // color-input mappings, so the brush is immediately usable on empty
    // models or models that only define output mappings.
    setBrushMapping(firstInput?.id ?? MANUAL_BRUSH_MAPPING_ID);
    if (result.error) setCompileError(result.error);

    // Only reset pan/zoom when the grid dimensions actually change. This
    // function ALSO fires on structural reinit at the same dims (e.g. the
    // user edits an attribute or mapping while pan/zoom-focused on a region)
    // — resetting in that case throws the user back to a fresh view every
    // edit, breaking the back-and-forth tweak workflow.
    const dimsChanged = gridWidth.current !== w || gridHeight.current !== h;
    gridWidth.current = w;
    gridHeight.current = h;
    setSimWidth(w);
    setSimHeight(h);
    if (dimsChanged) {
      zoomRef.current = 1;
      panRef.current = { x: 0, y: 0 };
    }

    // Initialize runtime model attrs from defaults
    setRuntimeModelAttrs(computeDefaultModelAttrs(model.attributes));

    // Snapshot interaction-table defaults the first time we see this
    // modelVersion (= a fresh LOAD_MODEL / NEW_MODEL — modelVersion bumps in
    // ModelContext.tsx only for those two actions, not for per-attribute
    // edits). The simulator's per-cell table editor mutates `model.attributes`
    // directly via updateAttribute, so we need a snapshot taken BEFORE any of
    // those edits to recover the as-loaded values on Reset to Default.
    if (lastSnapshottedVersionRef.current !== modelVersion) {
      lastSnapshottedVersionRef.current = modelVersion;
      const snap: Record<string, Record<string, Record<string, number>>> = {};
      for (const a of model.attributes) {
        if (a.type === 'lookupTable' && a.tableValues) {
          snap[a.id] = JSON.parse(JSON.stringify(a.tableValues));
        }
      }
      interactionTableDefaultsRef.current = snap;
    }

    const worker = new Worker(
      new URL('./engine/sim.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e) => onWorkerMessageRef.current(e);
    // Resize / image-import override grid dimensions WITHOUT updating the
    // model state, so we have to feed the compilers a model with the new
    // dimensions baked in. WASM happens to be tolerant (it takes `total` as
    // a runtime function arg), but WebGPU bakes `total` into the WGSL bounds
    // check — without this override the shader rejects half the cells after a
    // resize-to-larger and the simulator looks half-frozen.
    const effModel = withEffectiveNeighborhoods(model);
    const dimsModel = (model.properties.gridWidth === w && model.properties.gridHeight === h)
      ? effModel
      : { ...effModel, properties: { ...effModel.properties, gridWidth: w, gridHeight: h } };
    // Viewer→int mapping is target-agnostic — the worker needs it for
    // uploadActiveViewer regardless of which compile target is active. WGSL
    // SetColorViewer-in-step writes are guarded on `control.activeViewer ==
    // <int>`; without this map populated, the upload defaults to -1, no guards
    // fire, and no-OM viewers (e.g. MNCA's "Case Colored") never write colors.
    const viewerIds = buildViewerIds(dimsModel);
    // Wave 2: compile WASM only when the user has selected the WASM target.
    // Mirrors the WebGPU gating below — saves a compile pass per model change
    // when WASM isn't active, and avoids surfacing WASM-only errors when the
    // user is on JS or WebGPU.
    const wasmResult = (() => {
      if (!model.properties.useWasm) {
        return { bytes: new Uint8Array(), minMemoryPages: 1, error: '', viewerIds, exports: [] };
      }
      try {
        const layout = computeLayoutFromModel(dimsModel);
        return compileGraphWasm(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel, layout, viewerIds);
      } catch (e) {
        return { bytes: new Uint8Array(), minMemoryPages: 1, error: String((e as Error)?.message || e), viewerIds, exports: [] };
      }
    })();
    // Wave 3: compile WebGPU shader alongside JS/WASM. Same fallback pattern:
    // any error and the worker stays on JS — useWebGPU only flips on once the
    // worker successfully acquires a device and the shader module compiles.
    const webgpuResult = (() => {
      // Skip the WebGPU compile when the user hasn't selected the WebGPU target.
      // Otherwise, async-only nodes etc. produce a shader error that the worker
      // would surface as a popup even though the model is running on JS/WASM.
      if (!model.properties.useWebGPU) {
        return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: '' };
      }
      try {
        return compileGraphWebGPU(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
      } catch (e) {
        return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: String((e as Error)?.message || e) };
      }
    })();
    // P7 direct render: under WebGPU we eventually transfer srcCanvas's
    // control to an OffscreenCanvas so the worker's WebGPU runtime can write
    // straight to it via the present compute pipeline. We DEFER that transfer
    // until the worker confirms via useWebGPUStatus that the runtime is up —
    // until then srcCanvas stays a regular 2D canvas so the JS-fallback
    // colors path (which the worker uses while async device init is in
    // flight) can still putImageData onto it. Without this deferral, every
    // worker init had a 50-500ms window where the user saw a frozen blank
    // grid even while the worker was correctly evolving CPU state.
    directRenderActiveRef.current = false;
    pendingCanvasAttach.current = false;
    pendingDirectRenderCanvas.current = null;
    // Drop any prior srcCanvas reference — if the previous worker init went
    // through the direct-render path, srcCanvasRef holds a transferred canvas
    // whose 2D context is permanently unavailable. Re-using it here would
    // make all later getImageData / drawImage calls fail silently (visible
    // symptom: GIF recording captures zero frames after a WebGPU→JS toggle).
    {
      const fresh = document.createElement('canvas');
      fresh.width = w; fresh.height = h;
      srcCanvasRef.current = fresh;
    }
    const offscreenSupported = typeof HTMLCanvasElement !== 'undefined'
      && typeof (HTMLCanvasElement.prototype as { transferControlToOffscreen?: unknown }).transferControlToOffscreen === 'function';
    // Mark that we want to attach a canvas once the worker reports ready.
    // The actual transferControlToOffscreen + postMessage('attachCanvas')
    // happens in the useWebGPUStatus handler.
    if (model.properties.useWebGPU && !webgpuResult.error && offscreenSupported) {
      pendingCanvasAttach.current = true;
    }
    const initMsg: Record<string, unknown> = {
      type: 'init',
      width: w,
      height: h,
      attributes: model.attributes.map(a => ({
        id: a.id, type: a.type,
        isModelAttribute: a.isModelAttribute, defaultValue: a.defaultValue,
        boundaryValue: a.boundaryValue,
        tagOptions: a.tagOptions,
        parentAttributeId: a.parentAttributeId,
        parentValues: a.parentValues,
        undefinedValue: a.undefinedValue,
      })),
      neighborhoods: effModel.neighborhoods.map(n => ({ id: n.id, coords: n.coords })),
      boundaryTreatment: model.properties.boundaryTreatment,
      updateMode: model.properties.updateMode || 'synchronous',
      asyncScheme: model.properties.asyncScheme || 'random-order',
      stepCode: result.stepCode,
      initCode: result.initCode,
      inputColorCodes: result.inputColorCodes,
      outputMappingCodes: result.outputMappingCodes,
      stopMessages: result.stopMessages,
      activeViewer: viewer,
      // Variegated Cells: orientation buffer + face-pattern lookup + the
      // interaction-table payload. The worker only allocates these when
      // variegatedCells.enabled is true; absent / disabled = no extra state.
      variegated: model.variegatedCells?.enabled ? {
        sourceAttributeId: model.variegatedCells.sourceAttributeId,
        facePalettes: model.variegatedCells.facePalettes,
        facePatterns: model.variegatedCells.facePatterns,
        facePatternAssignments: ((): Record<string, string> => {
          const src = model.attributes.find(a => a.id === model.variegatedCells!.sourceAttributeId);
          return src?.facePatternAssignments || {};
        })(),
      } : undefined,
      // Lookup tables — sent whenever the model has any (independent of
      // variegation; tag×tag tables need no faces). Row/col labels resolved
      // from each axis key source.
      interactionTables: model.attributes
        .filter(a => a.isModelAttribute && a.type === 'lookupTable')
        .map(a => ({
          id: a.id,
          rowLabels: resolveKeyLabels(a.rowKeySource, model),
          colLabels: resolveKeyLabels(a.colKeySource, model),
          values: a.tableValues || {},
        })),
      indicators: (model.indicators || []).map(i => ({
        id: i.id, kind: i.kind, dataType: i.dataType,
        defaultValue: i.defaultValue, accumulationMode: i.accumulationMode,
        tagOptions: i.tagOptions,
        linkedAttributeId: i.linkedAttributeId,
        linkedAggregation: i.linkedAggregation,
        binCount: i.binCount,
        xAxis: i.xAxis, spatialBinMode: i.spatialBinMode,
        spatialBinCount: i.spatialBinCount, spatialBinSize: i.spatialBinSize,
        trackedValues: i.trackedValues,
        watched: i.watched,
      })),
      wasmStepBytes: wasmResult.error ? undefined : wasmResult.bytes,
      wasmStepError: wasmResult.error,
      wasmExports: wasmResult.exports,
      viewerIds: wasmResult.viewerIds,
      useWasm: !!model.properties.useWasm,
      webgpuShaderCode: webgpuResult.error ? undefined : webgpuResult.shaderCode,
      webgpuShaderError: webgpuResult.error,
      webgpuEntryPoints: webgpuResult.error ? undefined : webgpuResult.entryPoints,
      webgpuLayout: webgpuResult.error ? undefined : webgpuResult.layout,
      useWebGPU: !!model.properties.useWebGPU,
      webgpuStopCheckInterval: Math.max(1, Math.floor(model.properties.webgpuStopCheckInterval ?? 1)),
      // Glyph overlay regions are only allocated when the graph actually uses
      // setCellGlyph. Worker reads this BEFORE initGrid so layout reserves the
      // matching memory (and the views are non-null).
      hasGlyphs: hasGlyphsInModel(model),
    };
    // Canvas transfer is deferred to the useWebGPUStatus handler — see
    // pendingCanvasAttach above. The init message never carries webgpuCanvas
    // anymore; the worker's startWebGPUInit runs without a canvas, falls
    // through to the readback path until attachCanvas arrives.
    worker.postMessage(initMsg);
    workerRef.current = worker;
    // Re-publish any open inspect-popup subscriptions to the fresh worker so
    // values keep streaming after a recompile / hard re-init.
    if (inspectCellIdxsRef.current.length > 0) {
      worker.postMessage({ type: 'setInspectCells', cellIdxs: inspectCellIdxsRef.current });
    }
    if (import.meta.env?.DEV) (window as unknown as { __simWorker?: Worker }).__simWorker = worker;
    generationRef.current = 0;
    lastGenSetTime.current = 0;
    setGeneration(0);
    setPlaying(false);
    indicatorValuesRef.current = {};
    indicatorHistoryRef.current = {};
    // NOTE: don't reset chartExpandedRef here. IndicatorDisplay populates it
    // during its render (via a ref-compare notification pattern tied to the
    // indicator id list), and that render happens BEFORE this useEffect runs.
    // Resetting it here wipes those entries, which means the FIRST few stepped
    // messages arrive with an empty expanded set and never populate history —
    // causing scalar sparklines to stay blank until a manual collapse/expand
    // remounts IndicatorSparkline. IndicatorDisplay's own indicator-id-change
    // detection handles the "new model" case by re-notifying as needed; stale
    // entries for removed indicators are harmless (the collection loop skips
    // ids whose value is missing from the incoming message).
    pendingStep.current = false;
    lastGenForGps.current = 0;
    gpsGens.current = 0;

    // Queue simulation state restoration if present in loaded model — but
    // only when the embedded snapshot still matches the current model's
    // structural settings. A grid resize OR a boundary-treatment change
    // invalidates the snapshot (cells were laid out for the old shape), so
    // we drop it rather than re-applying it. Otherwise the auto-restore
    // would re-trigger applySimulationState's "adapt model to state" branch
    // and silently revert the user's just-made boundary toggle to whatever
    // was active when the snapshot was saved.
    //
    // NOTE: Don't clobber an already-pending restore. `applySimulationState`
    // may have queued a preset's state BEFORE triggering this reinit (by
    // dispatching updateProperties). Overwriting with `model.simulationState`
    // here would drop the preset's modelAttrs, requiring a second click to
    // restore them.
    if (model.simulationState && !pendingSimStateRestore.current) {
      const s = model.simulationState;
      const dimsMatch = (s.width == null && s.height == null)
        || (s.width === w && s.height === h);
      // Stored states from before boundary was tracked have no
      // `boundaryTreatment` field — treat as compatible (don't pre-emptively
      // drop them). Newer snapshots are stamped on save.
      const boundaryMatch = !s.boundaryTreatment
        || s.boundaryTreatment === model.properties.boundaryTreatment;
      if (dimsMatch && boundaryMatch) {
        pendingSimStateRestore.current = model.simulationState;
      } else {
        pendingSimStateRestore.current = null;
        setSimulationState(undefined);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, compileModel]);

  // Terminate worker on unmount only (not on re-renders)
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Listen for project-save events to auto-capture simulation state.
  // `detail.include` is { grid?: boolean; controls?: boolean } — FileMenu's dialog fills it in.
  // If neither is included we still resolve immediately and clear simulationState.
  useEffect(() => {
    const captureState = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { resolve?: (state?: SimulationState | null) => void; include?: { grid?: boolean; controls?: boolean } }
        | undefined;
      const resolve = detail?.resolve;
      const include = detail?.include ?? { grid: true, controls: true };
      const wantGrid = include.grid !== false;
      const wantControls = include.controls !== false;

      if (!wantGrid && !wantControls) {
        // Nothing to capture — clear any stale embedded state from the model
        // and tell the caller "use no state" (null, distinct from undefined
        // which means "use whatever's already on the model").
        setSimulationState(undefined);
        resolve?.(null);
        return;
      }
      if (!workerRef.current) { resolve?.(null); return; }

      if (!wantGrid) {
        // Controls only: no need to round-trip through the worker. The current
        // model-attribute values live in `runtimeModelAttrs` (mirrors the
        // worker's cachedModelAttrs); pass them through so a controls-only save
        // doesn't silently zero out the user's tuned parameters.
        const state = serializeSimState(
          {
            generation: 0,
            width: gridWidth.current,
            height: gridHeight.current,
            attributes: {},
            modelAttrs: { ...runtimeModelAttrs }, indicators: {}, linkedAccumulators: {},
            colors: new ArrayBuffer(0),
          },
          { activeViewer, brushColor, brushW, brushH, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens, indicatorChartOverrides },
          { grid: false, controls: true },
          { boundaryTreatment: model.properties.boundaryTreatment },
        );
        setSimulationState(state);
        resolve?.(state);
        return;
      }

      // If a previous capture is still pending (worker hasn't replied yet),
      // resolve the prior promise rather than letting it hang. The replacement
      // capture will still finish via the new pendingStateSave callback.
      if (pendingStateSave.current) {
        // Drop the prior callback silently — its caller will see captured=null
        // via its own 5s timeout, but we keep the worker round-trip available
        // for the new request rather than racing two state messages.
        pendingStateSave.current = null;
      }
      pendingStateSave.current = (workerState) => {
        const state = serializeSimState(
          workerState as Parameters<typeof serializeSimState>[0],
          { activeViewer, brushColor, brushW, brushH, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens, indicatorChartOverrides },
          { grid: wantGrid, controls: wantControls },
          { boundaryTreatment: model.properties.boundaryTreatment },
        );
        setSimulationState(state);
        // Pass the freshly-captured state back through the event so callers
        // (FileMenu.doSave) can serialise it directly without depending on
        // React having flushed the setSimulationState dispatch.
        resolve?.(state);
      };
      workerRef.current.postMessage({ type: 'getState' });
    };
    window.addEventListener('genesis-capture-sim-state', captureState);
    return () => window.removeEventListener('genesis-capture-sim-state', captureState);
  }, [activeViewer, brushColor, brushW, brushH, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens, setSimulationState, runtimeModelAttrs, model.properties.boundaryTreatment]);

  // Smart init vs recompile: compare previous model to decide.
  // Full reinit for structural changes (grid size, attributes, neighborhoods, mappings, update mode).
  // Soft recompile for graph or indicator watch changes (preserves grid state).
  const prevModelRef = useRef<typeof model | null>(null);
  useEffect(() => {
    const prev = prevModelRef.current;
    prevModelRef.current = model;

    const needsFullInit = !prev || !workerRef.current
      || prev.properties.gridWidth !== model.properties.gridWidth
      || prev.properties.gridHeight !== model.properties.gridHeight
      || prev.properties.boundaryTreatment !== model.properties.boundaryTreatment
      || prev.properties.updateMode !== model.properties.updateMode
      || prev.properties.asyncScheme !== model.properties.asyncScheme
      || prev.properties.useWasm !== model.properties.useWasm
      || prev.properties.useWebGPU !== model.properties.useWebGPU
      || !attrsStructurallyEqual(prev.attributes, model.attributes)
      || variegatedLayoutKey(prev) !== variegatedLayoutKey(model)
      || prev.neighborhoods !== model.neighborhoods
      || prev.mappings !== model.mappings
      // Glyph regions are allocated at init time; changing whether the model
      // uses setCellGlyph requires re-laying out wasmMemory.
      || hasGlyphsInModel(prev) !== hasGlyphsInModel(model);

    if (needsFullInit) {
      workerRef.current?.terminate();
      workerRef.current = null;
      // When a freshly loaded model embeds a simulationState whose grid dims
      // differ from properties.gridWidth/Height (typical after an F5 Resize
      // before save — properties stay at the original size, the snapshot has
      // the resized size), initialise the worker at the SNAPSHOT's dims. This
      // avoids the dim-mismatch drop in initWorkerWithDimensions that would
      // otherwise scrub the snapshot and show a default grid. We can tell it's
      // a "fresh" snapshot (vs a stale one left over from a properties-only
      // edit) by comparing object identity to the previous model — load sets
      // a new simulationState reference; properties-edit leaves it alone.
      const snapJustChanged = !prev
        || (model.simulationState && model.simulationState !== prev.simulationState);
      const snapW = snapJustChanged
        ? (model.simulationState?.gridWidth ?? model.simulationState?.width ?? model.properties.gridWidth)
        : model.properties.gridWidth;
      const snapH = snapJustChanged
        ? (model.simulationState?.gridHeight ?? model.simulationState?.height ?? model.properties.gridHeight)
        : model.properties.gridHeight;
      initWorkerWithDimensions(snapW, snapH);
    } else {
      // Graph or indicator watch change only → soft recompile (preserves grid)
      // The Resize button updates `gridWidth.current` / `gridHeight.current` but
      // intentionally does NOT update model.properties (so the model isn't
      // marked dirty for a temporary experiment). Mirror the dimsModel pattern
      // from the full-reinit branch so the recompile sees the actual current
      // dims — otherwise WebGPU bakes the OLD `total` into its bounds check
      // and only the first N rows of the resized grid get computed (the
      // "top stripe" symptom). JS / WASM are tolerant (total is a runtime
      // arg there); only WebGPU exhibits the bug.
      const curW = gridWidth.current;
      const curH = gridHeight.current;
      const effModel = withEffectiveNeighborhoods(model);
      const dimsModel = (model.properties.gridWidth === curW && model.properties.gridHeight === curH)
        ? effModel
        : { ...effModel, properties: { ...effModel.properties, gridWidth: curW, gridHeight: curH } };
      const result = compileGraph(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
      // Show Code follows the selected target — same dispatch as compileModel().
      if (dimsModel.properties.useWebGPU) {
        try {
          const wgpu = compileGraphWebGPU(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
          setCompiledCode(wgpu.shaderCode || '(no shader emitted)');
          setCompileError(wgpu.error || result.error || '');
        } catch (e) {
          setCompiledCode('');
          setCompileError(String((e as Error)?.message || e));
        }
      } else if (dimsModel.properties.useWasm) {
        setCompiledCode(
          '/* WebAssembly target selected.\n' +
          ' * The compiled module is a binary WASM blob — not human-readable.\n' +
          ' * Switch to "Debug / Reference (JS)" in Model Properties to inspect generated code.\n' +
          ' */'
        );
        setCompileError(result.error ?? '');
      } else {
        setCompiledCode(buildFullCode(result));
        setCompileError(result.error ?? '');
      }
      // Build viewerIds unconditionally — see init path above for rationale.
      const viewerIds = buildViewerIds(dimsModel);
      const wasmResult = (() => {
        if (!dimsModel.properties.useWasm) {
          return { bytes: new Uint8Array(), minMemoryPages: 1, error: '', viewerIds, exports: [] };
        }
        try {
          const layout = computeLayoutFromModel(dimsModel);
          return compileGraphWasm(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel, layout, viewerIds);
        } catch (e) {
          return { bytes: new Uint8Array(), minMemoryPages: 1, error: String((e as Error)?.message || e), viewerIds, exports: [] };
        }
      })();
      const webgpuResult = (() => {
        if (!dimsModel.properties.useWebGPU) {
          return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: '' };
        }
        try {
          return compileGraphWebGPU(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
        } catch (e) {
          return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: String((e as Error)?.message || e) };
        }
      })();
      // Under WebGPU direct render, a soft recompile rebuilds the GPU device
      // and reconfigures the salvaged OffscreenCanvas — but in practice the
      // canvas can land in a broken state where no subsequent present produces
      // visible output (manual Recompile fixes it because it allocates a fresh
      // canvas via Phase 1/2). Set a flag so the useWebGPUStatus handler does
      // the same fresh-canvas swap automatically when the rebuild lands —
      // no worker teardown, model attribute sliders + grid state survive.
      if (dimsModel.properties.useWebGPU && !webgpuResult.error && directRenderActiveRef.current) {
        recompilePendingCanvasRefresh.current = true;
      }
      workerRef.current?.postMessage({
        type: 'recompile',
        stepCode: result.stepCode,
        initCode: result.initCode,
        inputColorCodes: result.inputColorCodes,
        outputMappingCodes: result.outputMappingCodes || [],
        variegated: model.variegatedCells?.enabled ? {
          sourceAttributeId: model.variegatedCells.sourceAttributeId,
          facePalettes: model.variegatedCells.facePalettes,
          facePatterns: model.variegatedCells.facePatterns,
          facePatternAssignments: ((): Record<string, string> => {
            const src = model.attributes.find(a => a.id === model.variegatedCells!.sourceAttributeId);
            return src?.facePatternAssignments || {};
          })(),
        } : undefined,
        interactionTables: model.attributes
          .filter(a => a.isModelAttribute && a.type === 'lookupTable')
          .map(a => ({
            id: a.id,
            rowLabels: resolveKeyLabels(a.rowKeySource, model),
            colLabels: resolveKeyLabels(a.colKeySource, model),
            values: a.tableValues || {},
          })),
        stopMessages: result.stopMessages,
        updateMode: model.properties.updateMode,
        asyncScheme: model.properties.asyncScheme,
        wasmStepBytes: wasmResult.error ? undefined : wasmResult.bytes,
        wasmStepError: wasmResult.error,
        wasmExports: wasmResult.exports,
        viewerIds: wasmResult.viewerIds,
        webgpuShaderCode: webgpuResult.error ? undefined : webgpuResult.shaderCode,
        webgpuShaderError: webgpuResult.error,
        webgpuEntryPoints: webgpuResult.error ? undefined : webgpuResult.entryPoints,
        webgpuLayout: webgpuResult.error ? undefined : webgpuResult.layout,
        webgpuStopCheckInterval: Math.max(1, Math.floor(model.properties.webgpuStopCheckInterval ?? 1)),
      });
      // If user has the model toggle on, ensure useWasm is set (recompile doesn't carry useWasm by default)
      workerRef.current?.postMessage({
        type: 'setUseWasm',
        enabled: !!model.properties.useWasm && !wasmResult.error,
      });
      workerRef.current?.postMessage({
        type: 'setUseWebGPU',
        enabled: !!model.properties.useWebGPU && !webgpuResult.error,
      });
      // Sync indicator definitions when they change (not included in recompile message)
      if (prev && prev.indicators !== model.indicators) {
        workerRef.current?.postMessage({
          type: 'updateIndicators',
          indicators: (model.indicators || []).map(i => ({
            id: i.id, kind: i.kind, dataType: i.dataType,
            defaultValue: i.defaultValue, accumulationMode: i.accumulationMode,
            tagOptions: i.tagOptions,
            linkedAttributeId: i.linkedAttributeId,
            linkedAggregation: i.linkedAggregation,
            binCount: i.binCount,
            xAxis: i.xAxis, spatialBinMode: i.spatialBinMode,
            spatialBinCount: i.spatialBinCount, spatialBinSize: i.spatialBinSize,
            trackedValues: i.trackedValues,
            watched: i.watched,
          })),
          attributes: model.attributes.map(a => ({
            id: a.id, type: a.type,
            isModelAttribute: a.isModelAttribute, defaultValue: a.defaultValue,
            tagOptions: a.tagOptions,
          })),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, compileModel]);

  // Resize handler
  useEffect(() => {
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  // Pause simulation when leaving tab, redraw when coming back
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => draw());
      // Under WebGPU direct render, the OffscreenCanvas can land in an
      // unpresented state if a soft recompile happened while the simulator
      // was hidden (startWebGPUInit unconfigures + reconfigures the canvas
      // context with the new device — the next compositor frame may show
      // blank). Ask the worker to re-dispatch the present so the canvas has
      // fresh content the moment the user returns to the tab.
      if (directRenderActiveRef.current && workerRef.current) {
        workerRef.current.postMessage({ type: 'refreshDisplay' });
      }
    } else if (playing) {
      setPlaying(false);
    }
  }, [visible, draw, playing]);

  // Brush refs (so event handlers don't need to re-register)
  const brushColorRef = useRef('#4cc9f0');
  const brushWRef = useRef(1);
  const brushHRef = useRef(1);
  const activeViewerRef = useRef('');
  const brushMappingRef = useRef('');
  useEffect(() => { brushColorRef.current = brushColor; }, [brushColor]);
  useEffect(() => { brushWRef.current = brushW; }, [brushW]);
  useEffect(() => { brushHRef.current = brushH; }, [brushH]);
  useEffect(() => { activeViewerRef.current = activeViewer; }, [activeViewer]);
  // When the user switches output-mapping tabs (e.g. while paused), fire one color pass so the
  // grid reflects the new mapping immediately instead of waiting for the next step/paint/reset.
  // Ref guard skips the initial mount — otherwise we'd fire before the worker has a step fn.
  const viewerInitDoneRef = useRef(false);
  useEffect(() => {
    if (!viewerInitDoneRef.current) {
      viewerInitDoneRef.current = true;
      return;
    }
    if (!workerRef.current) return;
    workerRef.current.postMessage({ type: 'colorPass', activeViewer });
  }, [activeViewer]);
  const showBrushCursorRef = useRef(true);
  useEffect(() => { showBrushCursorRef.current = showBrushCursor; }, [showBrushCursor]);
  const showGridlinesRef = useRef(false);
  useEffect(() => { showGridlinesRef.current = showGridlines; }, [showGridlines]);
  // Middle-click autoscroll — origin/cursor are canvas-local pixel coords.
  // When origin is non-null we're in autoscroll mode; the rAF loop pans by a
  // velocity proportional to (cursor - origin) and the draw() function paints
  // a small compass indicator at the origin.
  const autoscrollOriginRef = useRef<{ x: number; y: number } | null>(null);
  const autoscrollCursorRef = useRef<{ x: number; y: number } | null>(null);
  const autoscrollRafRef = useRef<number | null>(null);
  const infinityCanvasRef = useRef(false);
  useEffect(() => { infinityCanvasRef.current = infinityCanvas; draw(); }, [infinityCanvas, draw]);
  // Boundary-treatment ref so the memoized draw/screenToGrid/brushCellsAt callbacks
  // (empty-deps useCallbacks) can read the live value.
  const boundaryTreatmentRef = useRef<'torus' | 'constant'>(model.properties.boundaryTreatment);
  useEffect(() => {
    boundaryTreatmentRef.current = model.properties.boundaryTreatment;
    draw();
  }, [model.properties.boundaryTreatment, draw]);
  // When the model leaves torus, infinity canvas no longer makes physical sense
  // (it would lie about the grid wrapping). Force the toggle off.
  useEffect(() => {
    if (model.properties.boundaryTreatment !== 'torus' && infinityCanvas) {
      setInfinityCanvas(false);
    }
  }, [model.properties.boundaryTreatment, infinityCanvas]);
  useEffect(() => { brushMappingRef.current = brushMapping; }, [brushMapping]);
  // Mappings ref lets mouse/keyboard handlers see the latest model.mappings without re-registering.
  const mappingsRef = useRef(model.mappings);
  useEffect(() => { mappingsRef.current = model.mappings; }, [model.mappings]);
  // Cell attributes ref — flushPaintBatch needs the attribute types to encode
  // Manual Brush values into typed-array numerics. Keeping a ref avoids
  // re-registering the paint callback on every model edit.
  const cellAttrsRef = useRef<Attribute[]>(model.attributes.filter(a => !a.isModelAttribute));
  useEffect(() => { cellAttrsRef.current = model.attributes.filter(a => !a.isModelAttribute); }, [model.attributes]);
  // In-page color popover shown on Modifier+RMB (null = closed).
  // We render our own popover at the cursor because the native <input type="color">
  // picker opens as an OS-managed window anchored to the input's DOM position, which
  // never matches the cursor. The popover's "Full picker" row opens the native picker
  // for users who want the full gradient UI.
  const [colorPopover, setColorPopover] = useState<{ x: number; y: number } | null>(null);

  // Inspect-cell popups (Shift+LMB). Each popup tracks one cell. Multiple
  // popups can coexist; z-order is the array order (later items render on top).
  // inspectDataRef holds the latest worker-supplied attribute values keyed by
  // cellIdx; bumping inspectDataVersion forces a re-render of all popovers.
  const [inspectPopovers, setInspectPopovers] = useState<InspectPopoverState[]>([]);
  const [hoveredInspectIdx, setHoveredInspectIdx] = useState<number | null>(null);
  const [pulseInspectIdx, setPulseInspectIdx] = useState<number | null>(null);
  const [focusedInspectIdx, setFocusedInspectIdx] = useState<number | null>(null);
  const inspectDataRef = useRef<Map<number, Record<string, number>>>(new Map());
  const inspectColorsRef = useRef<Map<number, { r: number; g: number; b: number }>>(new Map());
  // Variegated cells only: per-cell orientation (0..3). Worker omits the field
  // entirely when variegation is disabled, so the popover only shows the
  // orientation row when the map has an entry for the cell.
  const inspectOrientationsRef = useRef<Map<number, number>>(new Map());
  const [, bumpInspectVersion] = useState(0);
  const popoverRectsRef = useRef<Map<number, DOMRect>>(new Map());
  const pulseTimerRef = useRef<number | null>(null);
  // Shift+LMB sweep: hold-and-drag a single transient inspector across cells
  // instead of pinning one popover per click. On release, if the cursor never
  // left the start cell we COMMIT (fall through to the existing pin path); if
  // it moved we DISCARD. The ref mirrors state so the mouse handlers (registered
  // once per useEffect run) read the live value without closure staleness.
  const [sweepInspector, setSweepInspector] = useState<InspectPopoverState | null>(null);
  const sweepInspectorRef = useRef<InspectPopoverState | null>(null);
  const sweepActiveRef = useRef(false);
  const sweepStartCellRef = useRef<number | null>(null);
  const sweepMovedRef = useRef(false);
  const sweepRectRef = useRef<DOMRect | null>(null);
  // Mirror the popover cell ids in a ref so worker-init code (running outside
  // React's render cycle) can re-publish the subscription without staleness.
  const inspectCellIdxsRef = useRef<number[]>([]);
  useEffect(() => {
    const pinnedIds = inspectPopovers.map(p => p.cellIdx);
    const sweepIdx = sweepInspector?.cellIdx;
    const ids = sweepIdx != null && !pinnedIds.includes(sweepIdx)
      ? [...pinnedIds, sweepIdx]
      : pinnedIds;
    inspectCellIdxsRef.current = ids;
    // Drop stale rect entries so the hover overlay doesn't anchor to a
    // popover that was just closed.
    const live = new Set(ids);
    for (const k of Array.from(popoverRectsRef.current.keys())) {
      if (!live.has(k)) popoverRectsRef.current.delete(k);
    }
    for (const k of Array.from(inspectDataRef.current.keys())) {
      if (!live.has(k)) inspectDataRef.current.delete(k);
    }
    for (const k of Array.from(inspectColorsRef.current.keys())) {
      if (!live.has(k)) inspectColorsRef.current.delete(k);
    }
    for (const k of Array.from(inspectOrientationsRef.current.keys())) {
      if (!live.has(k)) inspectOrientationsRef.current.delete(k);
    }
    workerRef.current?.postMessage({ type: 'setInspectCells', cellIdxs: ids });
  }, [inspectPopovers, sweepInspector?.cellIdx]);
  // Auto-close popovers whose cell is out of bounds after a grid resize.
  useEffect(() => {
    const w = model.properties.gridWidth;
    const h = model.properties.gridHeight;
    setInspectPopovers(prev => {
      const next = prev.filter(p => p.row < h && p.col < w);
      return next.length === prev.length ? prev : next;
    });
    setSweepInspector(prev => {
      if (!prev) return prev;
      if (prev.row >= h || prev.col >= w) {
        sweepActiveRef.current = false;
        sweepStartCellRef.current = null;
        sweepMovedRef.current = false;
        sweepInspectorRef.current = null;
        return null;
      }
      return prev;
    });
  }, [model.properties.gridWidth, model.properties.gridHeight]);

  // Pin (or re-focus) an inspector popover at the given cell. Shared by the
  // Shift+LMB click path (mouseup-after-no-movement on a sweep) and any
  // future commit point.
  const commitInspectPopover = useCallback((idx: number, row: number, col: number, x: number, y: number) => {
    setInspectPopovers(prev => {
      const existingIdx = prev.findIndex(p => p.cellIdx === idx);
      if (existingIdx >= 0) {
        const next = [...prev];
        const [moved] = next.splice(existingIdx, 1);
        next.push(moved!);
        setPulseInspectIdx(idx);
        if (pulseTimerRef.current != null) window.clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = window.setTimeout(() => {
          setPulseInspectIdx(curr => (curr === idx ? null : curr));
          pulseTimerRef.current = null;
        }, 500);
        setFocusedInspectIdx(idx);
        return next;
      }
      return [...prev, { cellIdx: idx, row, col, x, y }];
    });
    setFocusedInspectIdx(idx);
  }, []);

  /** Convert screen coords to grid cell coords. In infinity mode, wraps via
   *  modulo so painting / hovering across tile seams hits the correct cell. */
  const screenToGrid = useCallback((clientX: number, clientY: number): { row: number; col: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.parentElement!.getBoundingClientRect();
    const w = gridWidth.current;
    const h = gridHeight.current;
    const parentW = rect.width;
    const parentH = rect.height;
    const baseScale = Math.min(parentW / w, parentH / h);
    const scale = baseScale * zoomRef.current;
    const ox = (parentW - w * scale) / 2 + panRef.current.x;
    const oy = (parentH - h * scale) / 2 + panRef.current.y;
    let col = Math.floor((clientX - rect.left - ox) / scale);
    let row = Math.floor((clientY - rect.top - oy) / scale);
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
    if (infinity) {
      col = ((col % w) + w) % w;
      row = ((row % h) + h) % h;
      return { row, col };
    }
    if (col < 0 || col >= w || row < 0 || row >= h) return null;
    return { row, col };
  }, []);

  /** Inverse of screenToGrid: cell (row, col) → top-left viewport coords and
   *  cell pixel size. Used by the inspect-cell hover overlay to anchor a
   *  contour around the inspected cell. Returns null if the canvas is not
   *  yet mounted or the grid is empty. */
  const gridToScreen = useCallback((row: number, col: number): { x: number; y: number; cellSize: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.parentElement!.getBoundingClientRect();
    const w = gridWidth.current;
    const h = gridHeight.current;
    if (w === 0 || h === 0) return null;
    const baseScale = Math.min(rect.width / w, rect.height / h);
    const scale = baseScale * zoomRef.current;
    const ox = (rect.width - w * scale) / 2 + panRef.current.x;
    const oy = (rect.height - h * scale) / 2 + panRef.current.y;
    return { x: rect.left + ox + col * scale, y: rect.top + oy + row * scale, cellSize: scale };
  }, []);

  /** Parse hex color to RGB */
  const hexToRgb = (hex: string) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };

  /** Collect brush-rect cells around a grid center (no message sent). In infinity
   *  mode, individual cell coords are wrapped modulo grid size so the worker's
   *  paint handler (which drops out-of-bounds row/col) doesn't silently lose the
   *  cells of a brush that straddles a tile seam. */
  const brushCellsAt = useCallback((row: number, col: number, r: number, g: number, b: number) => {
    const bw = brushWRef.current;
    const bh = brushHRef.current;
    const cells: Array<{ row: number; col: number; r: number; g: number; b: number }> = [];
    const halfW = Math.floor((bw - 1) / 2);
    const halfH = Math.floor((bh - 1) / 2);
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
    const gw = gridWidth.current;
    const gh = gridHeight.current;
    for (let dr = -halfH; dr <= halfH + ((bh - 1) % 2); dr++) {
      for (let dc = -halfW; dc <= halfW + ((bw - 1) % 2); dc++) {
        let cellRow = row + dr;
        let cellCol = col + dc;
        if (infinity && gw > 0 && gh > 0) {
          cellRow = ((cellRow % gh) + gh) % gh;
          cellCol = ((cellCol % gw) + gw) % gw;
        }
        cells.push({ row: cellRow, col: cellCol, r, g, b });
      }
    }
    return cells;
  }, []);

  /** Flush whatever paint cells have accumulated since the last frame. Called
   *  on the rAF boundary by the coalescer below, and synchronously by mouse-up
   *  / unmount paths so the final brush stroke isn't dropped. */
  const flushPaintBatch = useCallback(() => {
    if (pendingPaintRaf.current != null) {
      cancelAnimationFrame(pendingPaintRaf.current);
      pendingPaintRaf.current = null;
    }
    const cells = pendingPaintCells.current;
    const mappingId = pendingPaintMapping.current;
    const viewer = pendingPaintViewer.current;
    if (cells.length === 0 || mappingId == null) return;
    pendingPaintCells.current = [];
    pendingPaintMapping.current = null;
    if (mappingId === MANUAL_BRUSH_MAPPING_ID) {
      // Snapshot the brush state AT FLUSH TIME so mid-drag widget edits land
      // on the second half of the stroke (matches the mid-drag-tab-switch
      // semantics that already exist for the color mapping case).
      const brush = manualBrushRef.current;
      const sets: Array<{ attrId: string; value: number }> = [];
      for (const attr of cellAttrsRef.current) {
        const entry = brush[attr.id];
        if (!entry || !entry.enabled) continue;
        sets.push({ attrId: attr.id, value: encodeAttrValue(attr, entry.value) });
      }
      if (sets.length === 0) return; // nothing enabled — a no-op stroke
      const trimmedCells = cells.map(c => ({ row: c.row, col: c.col }));
      workerRef.current?.postMessage({ type: 'paintManual', cells: trimmedCells, sets, activeViewer: viewer });
      return;
    }
    workerRef.current?.postMessage({ type: 'paint', cells, mappingId, activeViewer: viewer });
  }, []);

  /** Paint with Bresenham interpolation from last painted position to current.
   *  In infinity (torus tiling) mode, the line walks the SHORTER wrap path: the
   *  signed delta is folded into [-range/2, range/2] so dragging across a seam
   *  paints a few cells via the wrap, not a long line across the bounded grid. */
  const paintAt = useCallback((clientX: number, clientY: number) => {
    const center = screenToGrid(clientX, clientY);
    if (!center) return;
    const { r, g, b } = hexToRgb(brushColorRef.current);
    let allCells: Array<{ row: number; col: number; r: number; g: number; b: number }> = [];
    const prev = lastPaintGrid.current;
    if (prev && (prev.row !== center.row || prev.col !== center.col)) {
      const gw = gridWidth.current;
      const gh = gridHeight.current;
      const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
      let r0 = prev.row, c0 = prev.col;
      // Signed delta in cells. Without wrapping, a drag across the seam (e.g.
      // col 98 -> col 1) would compute a -97 delta and paint the long way; the
      // torus-shortest fold below collapses that to +3.
      let signedDR = center.row - r0;
      let signedDC = center.col - c0;
      if (infinity) {
        if (signedDR > gh / 2) signedDR -= gh;
        else if (signedDR < -gh / 2) signedDR += gh;
        if (signedDC > gw / 2) signedDC -= gw;
        else if (signedDC < -gw / 2) signedDC += gw;
      }
      const dr = Math.abs(signedDR), dc = Math.abs(signedDC);
      const sr = signedDR >= 0 ? 1 : -1, sc = signedDC >= 0 ? 1 : -1;
      let err = dc - dr;
      let stepsR = dr, stepsC = dc;
      // Bresenham — walks until both axis step counts are exhausted. Mod each
      // emitted (r0, c0) to grid range in infinity mode so the cells we push are
      // the wrapped cells the worker expects.
      while (stepsR > 0 || stepsC > 0) {
        const e2 = 2 * err;
        if (e2 > -dr && stepsC > 0) { err -= dr; c0 += sc; stepsC--; }
        if (e2 < dc && stepsR > 0) { err += dc; r0 += sr; stepsR--; }
        let cellR = r0, cellC = c0;
        if (infinity) {
          cellR = ((cellR % gh) + gh) % gh;
          cellC = ((cellC % gw) + gw) % gw;
        }
        allCells = allCells.concat(brushCellsAt(cellR, cellC, r, g, b));
      }
    } else {
      allCells = brushCellsAt(center.row, center.col, r, g, b);
    }
    lastPaintGrid.current = center;
    if (allCells.length === 0) return;
    const curMapping = brushMappingRef.current;
    const curViewer = activeViewerRef.current;
    // If the user changed brush mapping or active viewer mid-drag (rare), the
    // pending batch belongs to the previous target — flush before enqueuing the
    // new cells so they don't get sent to the wrong handler.
    if (
      pendingPaintMapping.current !== null &&
      (pendingPaintMapping.current !== curMapping || pendingPaintViewer.current !== curViewer)
    ) {
      flushPaintBatch();
    }
    pendingPaintMapping.current = curMapping;
    pendingPaintViewer.current = curViewer;
    for (let i = 0; i < allCells.length; i++) pendingPaintCells.current.push(allCells[i]!);
    if (pendingPaintRaf.current == null) {
      pendingPaintRaf.current = requestAnimationFrame(flushPaintBatch);
    }
  }, [screenToGrid, brushCellsAt, flushPaintBatch]);

  // Zoom/Pan/Brush event handlers
  useEffect(() => {
    const container = canvasRef.current?.parentElement;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-sim-overlay]')) return;
      e.preventDefault();
      // Ctrl+wheel = cycle through Input Mappings (for quick brush behavior switching)
      // Manual Brush participates in the cycle as the rightmost entry, so it's
      // always reachable even when the model has zero color-input mappings.
      if (e.ctrlKey) {
        const inputs = [
          ...mappingsRef.current.filter(m => !m.isAttributeToColor).map(m => m.id),
          MANUAL_BRUSH_MAPPING_ID,
        ];
        if (inputs.length === 0) return;
        const curIdx = inputs.findIndex(id => id === brushMappingRef.current);
        const base = curIdx < 0 ? 0 : curIdx;
        const nextIdx = (base + (e.deltaY > 0 ? 1 : -1) + inputs.length) % inputs.length;
        setBrushMapping(inputs[nextIdx]!);
        return;
      }
      const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(0.1, Math.min(50, oldZoom * zoomFactor));
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      panRef.current = {
        x: panRef.current.x - (mx - cx - panRef.current.x) * (newZoom / oldZoom - 1),
        y: panRef.current.y - (my - cy - panRef.current.y) * (newZoom / oldZoom - 1),
      };
      zoomRef.current = newZoom;
      draw();
    };

    const isResizingBrush = { active: false, startX: 0, startY: 0, startW: 0, startH: 0 };
    let canvasBrushActive = false; // true only when LMB started on canvas, not overlay

    // Middle-click autoscroll: rAF loop pans by (cursor - origin) each frame.
    // Speed scales with distance; below the deadzone the pointer is treated as
    // resting (no pan). Stops on any non-middle-button click, second middle
    // click, Escape, or unmount.
    const AUTOSCROLL_DEADZONE = 12;
    const AUTOSCROLL_DAMP = 12;
    const tickAutoscroll = () => {
      autoscrollRafRef.current = null;
      const origin = autoscrollOriginRef.current;
      const cur = autoscrollCursorRef.current;
      if (!origin) return;
      if (cur) {
        const dx = cur.x - origin.x;
        const dy = cur.y - origin.y;
        const dist = Math.hypot(dx, dy);
        if (dist > AUTOSCROLL_DEADZONE) {
          const speed = (dist - AUTOSCROLL_DEADZONE) / AUTOSCROLL_DAMP;
          const factor = speed / dist;
          panRef.current = {
            x: panRef.current.x - dx * factor,
            y: panRef.current.y - dy * factor,
          };
        }
      }
      draw();
      autoscrollRafRef.current = requestAnimationFrame(tickAutoscroll);
    };
    const stopAutoscroll = () => {
      if (autoscrollOriginRef.current == null) return;
      autoscrollOriginRef.current = null;
      autoscrollCursorRef.current = null;
      if (autoscrollRafRef.current != null) {
        cancelAnimationFrame(autoscrollRafRef.current);
        autoscrollRafRef.current = null;
      }
      container.style.cursor = '';
      draw();
    };
    const startAutoscroll = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      autoscrollOriginRef.current = { x: cx, y: cy };
      autoscrollCursorRef.current = { x: cx, y: cy };
      container.style.cursor = 'all-scroll';
      if (autoscrollRafRef.current == null) {
        autoscrollRafRef.current = requestAnimationFrame(tickAutoscroll);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      // Ignore events from overlay controls (transport bar, viewer bar, etc.)
      const target = e.target as HTMLElement;
      if (target.closest('[data-sim-overlay]')) { canvasBrushActive = false; return; }

      // Middle-click toggles autoscroll mode. Any other button while autoscroll
      // is active just exits and consumes the click — matches browser autoscroll
      // semantics (Firefox / Chromium).
      if (e.button === 1) {
        e.preventDefault();
        if (autoscrollOriginRef.current) stopAutoscroll();
        else startAutoscroll(e.clientX, e.clientY);
        return;
      }
      if (autoscrollOriginRef.current) {
        e.preventDefault();
        stopAutoscroll();
        return;
      }

      if (e.button === 0 && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Shift+LMB = start a cell-inspector sweep. A plain click (release on
        // the same cell as press, no drag) commits via mouseup → pins a popover
        // (today's behavior). Dragging to a different cell recycles a single
        // transient popover and discards it on release — quick-peek across a
        // region without accumulating popovers.
        e.preventDefault();
        const cell = screenToGrid(e.clientX, e.clientY);
        // Guard against the brief window where the canvas hasn't been laid out
        // (parent rect 0×0 → scale 0 → NaN row/col). `!cell` only catches the
        // out-of-bounds null return — a finite check is needed for the rest.
        if (!cell || !Number.isFinite(cell.row) || !Number.isFinite(cell.col)) return;
        const w = gridWidth.current;
        if (w <= 0) return;
        const idx = cell.row * w + cell.col;
        const inspector: InspectPopoverState = { cellIdx: idx, row: cell.row, col: cell.col, x: e.clientX, y: e.clientY };
        sweepActiveRef.current = true;
        sweepStartCellRef.current = idx;
        sweepMovedRef.current = false;
        sweepInspectorRef.current = inspector;
        setSweepInspector(inspector);
        return;
      }

      if (e.button === 0 && e.ctrlKey) {
        // Ctrl+LMB = resize brush
        e.preventDefault();
        isResizingBrush.active = true;
        isResizingBrush.startX = e.clientX;
        isResizingBrush.startY = e.clientY;
        isResizingBrush.startW = brushWRef.current;
        isResizingBrush.startH = brushHRef.current;
        container.style.cursor = 'nwse-resize';
      } else if (e.button === 0) {
        // LMB = brush — set initial paint position for Bresenham interpolation
        canvasBrushActive = true;
        lastPaintGrid.current = null; // first paint call sets it
        paintAt(e.clientX, e.clientY);
      } else if (e.button === 2 && (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) && brushMappingRef.current !== MANUAL_BRUSH_MAPPING_ID) {
        // Modifier+RMB = open the in-page brush color popover at the cursor.
        // Any modifier is accepted (Ctrl, Shift, Alt, Meta) because plain Ctrl+RMB
        // gets swallowed on some Windows/Chrome combos (observed on ABNT2/Brazilian
        // layouts where AltGr=Ctrl+Alt works but Ctrl alone does not). Shift+RMB,
        // Alt+RMB, Ctrl+Shift+RMB all work too. Suppressed when Manual Brush is
        // active — Manual has no color picker, so falling through to RMB pan is
        // the natural behaviour.
        e.preventDefault();
        setColorPopover({ x: e.clientX, y: e.clientY });
      } else if (e.button === 2) {
        // RMB = pan
        e.preventDefault();
        isPanning.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        container.style.cursor = 'grabbing';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      // Autoscroll active: just track cursor + redraw to update the indicator's
      // direction line. The actual pan happens in tickAutoscroll's rAF loop so
      // we keep moving even when the cursor sits still.
      if (autoscrollOriginRef.current) {
        const rect = container.getBoundingClientRect();
        autoscrollCursorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        return;
      }

      // The brush rectangle + hover-coords chip are on-canvas indicators — they
      // must stop tracking the pointer once it leaves the canvas area (top bar,
      // side panels, etc.). This is a window-level listener so it keeps firing
      // off-canvas, and in infinity-canvas mode screenToGrid WRAPS off-canvas
      // coords instead of returning null — so without this guard both would
      // persist with bogus wrapped values. Active drags (pan / paint / brush-
      // resize) legitimately continue off-canvas, so only bail when idle.
      if (!isPanning.current && !(e.buttons & 1) && !isResizingBrush.active) {
        const rect = container.getBoundingClientRect();
        const overCanvas = e.clientX >= rect.left && e.clientX < rect.right
          && e.clientY >= rect.top && e.clientY < rect.bottom;
        if (!overCanvas) {
          if (cursorGrid.current !== null) {
            cursorGrid.current = null;
            setHoverCellInfo(prev => (prev === null ? prev : null));
            draw();
          }
          return;
        }
      }

      // Update brush cursor position
      const gridPos = screenToGrid(e.clientX, e.clientY);
      cursorGrid.current = gridPos;
      // Update the hover-coords chip — only when the integer cell or brush
      // dimensions change, so React re-renders are coarse-grained.
      const bw = brushWRef.current;
      const bh = brushHRef.current;
      if (gridPos) {
        const halfW = Math.floor((bw - 1) / 2);
        const halfH = Math.floor((bh - 1) / 2);
        const x0 = gridPos.col - halfW;
        const y0 = gridPos.row - halfH;
        const x1 = x0 + bw - 1;
        const y1 = y0 + bh - 1;
        setHoverCellInfo(prev =>
          prev && prev.col === gridPos.col && prev.row === gridPos.row
            && prev.x0 === x0 && prev.y0 === y0 && prev.x1 === x1 && prev.y1 === y1
            ? prev
            : { col: gridPos.col, row: gridPos.row, x0, y0, x1, y1 }
        );
      } else {
        setHoverCellInfo(prev => (prev === null ? prev : null));
      }
      if (!isPanning.current && !(e.buttons & 1) && !isResizingBrush.active) draw();

      // Shift+LMB sweep: update the transient inspector to follow the cursor
      // cell, and detect movement off the start cell (= sweep, not click).
      // Releasing Shift mid-drag cancels the sweep entirely.
      if (sweepActiveRef.current) {
        if (!e.shiftKey) {
          sweepActiveRef.current = false;
          sweepStartCellRef.current = null;
          sweepMovedRef.current = false;
          sweepInspectorRef.current = null;
          setSweepInspector(null);
          return;
        }
        if (gridPos && Number.isFinite(gridPos.row) && Number.isFinite(gridPos.col)) {
          const w = gridWidth.current;
          if (w > 0) {
            const idx = gridPos.row * w + gridPos.col;
            if (idx !== sweepStartCellRef.current) sweepMovedRef.current = true;
            const prior = sweepInspectorRef.current;
            if (prior && prior.cellIdx !== idx) {
              const next = { ...prior, cellIdx: idx, row: gridPos.row, col: gridPos.col };
              sweepInspectorRef.current = next;
              setSweepInspector(next);
            }
          }
        }
        return;
      }

      // Ctrl+LMB drag = resize brush
      if (isResizingBrush.active) {
        const dx = e.clientX - isResizingBrush.startX;
        const dy = e.clientY - isResizingBrush.startY;
        const maxW = (gridWidth.current || simWidth) * 2;
        const maxH = (gridHeight.current || simHeight) * 2;
        const newW = Math.max(1, Math.min(maxW, isResizingBrush.startW + Math.round(dx / 5)));
        const newH = Math.max(1, Math.min(maxH, isResizingBrush.startH - Math.round(dy / 5)));
        setBrushW(newW);
        setBrushH(newH);
        draw();
        return;
      }
      if (e.buttons & 1 && canvasBrushActive) {
        // LMB held = brush drag (only if mousedown was on canvas, not overlay)
        if (!e.ctrlKey) paintAt(e.clientX, e.clientY);
        return;
      }
      if (!isPanning.current) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      panRef.current = {
        x: panRef.current.x + dx,
        y: panRef.current.y + dy,
      };
      draw();
    };

    const handleMouseUp = () => {
      // End of a Shift+LMB sweep: if the cursor never left the start cell,
      // commit (pin the popover — today's Shift+LMB click behavior). If it
      // moved, discard the transient. Runs before the brush-stroke cleanup
      // because sweep is mutually exclusive with paint/pan.
      if (sweepActiveRef.current) {
        const inspector = sweepInspectorRef.current;
        const moved = sweepMovedRef.current;
        sweepActiveRef.current = false;
        sweepStartCellRef.current = null;
        sweepMovedRef.current = false;
        sweepInspectorRef.current = null;
        setSweepInspector(null);
        if (!moved && inspector) {
          commitInspectPopover(inspector.cellIdx, inspector.row, inspector.col, inspector.x, inspector.y);
        }
        return;
      }
      isPanning.current = false;
      isResizingBrush.active = false;
      canvasBrushActive = false;
      lastPaintGrid.current = null;
      // End-of-stroke: flush whatever paint cells were buffered for the next
      // rAF. Otherwise the trailing few cells of a fast brush stroke get held
      // until the next paint event (which might never come if the user lifts
      // the mouse and waits) — visible as a "missing tail" on quick clicks.
      flushPaintBatch();
      container.style.cursor = '';
    };

    // Suppress browser context menu on canvas area
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const handleMouseLeave = () => {
      cursorGrid.current = null;
      setHoverCellInfo(prev => (prev === null ? prev : null));
      draw();
    };

    // Escape exits autoscroll. We attach at window level because the focus might
    // be on any overlay control while autoscroll is active.
    const handleKeyDownAutoscroll = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && autoscrollOriginRef.current) {
        stopAutoscroll();
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('contextmenu', handleContextMenu);
    container.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDownAutoscroll);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDownAutoscroll);
      // Stop autoscroll loop on unmount to avoid leaking the rAF cycle.
      if (autoscrollRafRef.current != null) {
        cancelAnimationFrame(autoscrollRafRef.current);
        autoscrollRafRef.current = null;
      }
      autoscrollOriginRef.current = null;
      autoscrollCursorRef.current = null;
    };
  }, [draw, paintAt, screenToGrid, flushPaintBatch, commitInspectPopover]);

  // Play: kick-start the step pipeline (worker message handler chains subsequent steps)
  useEffect(() => {
    if (playing) {
      sendNextStep();
    } else {
      // Stop: cancel any pending rAF
      if (nextStepRaf.current != null) { cancelAnimationFrame(nextStepRaf.current); nextStepRaf.current = null; }
    }
  }, [playing, sendNextStep]);


  const handleStep = () => {
    if (playing) { setPlaying(false); return; }
    if (pendingStep.current) return;
    pendingStep.current = true;
    workerRef.current?.postMessage({ type: 'step', count: 1, activeViewer });
  };

  const handleReset = () => {
    setPlaying(false);
    pendingStep.current = true;
    workerRef.current?.postMessage({ type: 'reset', activeViewer });
  };

  const handleRandomize = () => {
    setPlaying(false);
    pendingStep.current = true;
    workerRef.current?.postMessage({ type: 'randomize', activeViewer });
  };

  const handleRecompile = () => {
    setPlaying(false);
    workerRef.current?.terminate();
    workerRef.current = null;
    initWorkerWithDimensions(model.properties.gridWidth, model.properties.gridHeight);
  };

  const startRecording = () => {
    recordedFrames.current = [];
    recordCountRef.current = 0;
    lastRecordCountSet.current = 0;
    setRecordFrameCount(0);
    setRecording(true);
    // Tell the worker to include the colors buffer in stepped messages so we
    // can capture frames under WebGPU direct render (where srcCanvas's 2D
    // context is unavailable on the main thread). No-op on JS / WASM paths
    // — those already send colors every frame.
    workerRef.current?.postMessage({ type: 'setRecording', enabled: true });
  };

  const stopRecording = async () => {
    setRecording(false);
    workerRef.current?.postMessage({ type: 'setRecording', enabled: false });
    const frames = recordedFrames.current;
    if (frames.length === 0) return;
    const fname = model.properties.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';
    const fps = targetFpsRef.current || 30;

    // Use the format selected at the moment recording stops. WebM falls back
    // to GIF if the browser doesn't support WebCodecs (defensive — the UI
    // already greys out the WebM option in that case).
    const format: RecordFormat = recordFormat === 'webm' && !isWebMSupported() ? 'gif' : recordFormat;

    if (format === 'webm') {
      setEncodingWebM(true);
      try {
        const blob = await encodeFramesToWebM(frames, fps);
        triggerDownload(blob, `${fname}_recording.webm`);
      } catch (err) {
        console.error('WebM encode failed', err);
        alert(`WebM encode failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setEncodingWebM(false);
      }
    } else {
      const fw = frames[0]!.width;
      const fh = frames[0]!.height;
      // Downscale large grids to max 512px (GIF only — WebM keeps native size).
      const maxDim = 512;
      let outW = fw, outH = fh;
      if (fw > maxDim || fh > maxDim) {
        const s = maxDim / Math.max(fw, fh);
        outW = Math.round(fw * s);
        outH = Math.round(fh * s);
      }
      const gif = GIFEncoder();
      const delay = Math.round(1000 / fps);
      const needsScale = outW !== fw || outH !== fh;
      let scaleCanvas: HTMLCanvasElement | null = null;
      let scaleCtx: CanvasRenderingContext2D | null = null;
      let srcCanvas: HTMLCanvasElement | null = null;
      let srcCtx: CanvasRenderingContext2D | null = null;
      if (needsScale) {
        scaleCanvas = document.createElement('canvas');
        scaleCanvas.width = outW; scaleCanvas.height = outH;
        scaleCtx = scaleCanvas.getContext('2d')!;
        scaleCtx.imageSmoothingEnabled = false;
        srcCanvas = document.createElement('canvas');
        srcCanvas.width = fw; srcCanvas.height = fh;
        srcCtx = srcCanvas.getContext('2d')!;
      }
      for (const frame of frames) {
        let rgba: Uint8ClampedArray;
        if (needsScale && scaleCtx && scaleCanvas && srcCtx && srcCanvas) {
          srcCtx.putImageData(frame, 0, 0);
          scaleCtx.drawImage(srcCanvas, 0, 0, outW, outH);
          rgba = scaleCtx.getImageData(0, 0, outW, outH).data;
        } else {
          rgba = frame.data;
        }
        const palette = quantize(rgba, 256);
        const indexed = applyPalette(rgba, palette);
        gif.writeFrame(indexed, outW, outH, { palette, delay });
      }
      gif.finish();
      const blob = new Blob([gif.bytes()], { type: 'image/gif' });
      triggerDownload(blob, `${fname}_recording.gif`);
    }
    recordedFrames.current = [];
    recordCountRef.current = 0;
    lastRecordCountSet.current = 0;
    setRecordFrameCount(0);
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };


  const handleCopyCode = () => {
    navigator.clipboard.writeText(compiledCode).catch(() => {});
  };

  const handleResetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    draw();
  };

  // Simulator keyboard shortcuts (Space=step, Enter=play/pause, Esc=reset,
  // Ctrl+C/V/X=copy/paste/cut cell-attribute region under the brush)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'v' || e.key === 'x')) {
        const cur = cursorGrid.current;
        if (!cur) return;
        const bw = brushWRef.current, bh = brushHRef.current;
        // Top-left of the current brush rectangle (matches brushCellsAt geometry)
        const halfW = Math.floor((bw - 1) / 2);
        const halfH = Math.floor((bh - 1) / 2);
        const brushRow = cur.row - halfH;
        const brushCol = cur.col - halfW;
        if (e.key === 'c') {
          e.preventDefault();
          workerRef.current?.postMessage({ type: 'readRegion', row: brushRow, col: brushCol, w: bw, h: bh });
        } else if (e.key === 'x') {
          e.preventDefault();
          pendingCutRect.current = { row: brushRow, col: brushCol, w: bw, h: bh };
          workerRef.current?.postMessage({ type: 'readRegion', row: brushRow, col: brushCol, w: bw, h: bh });
        } else if (e.key === 'v') {
          const clip = clipboardRef.current;
          if (!clip) return;
          e.preventDefault();
          // Paste anchor = top-left of the current brush rectangle; paste W/H = clipboard W/H
          // Re-slice buffers so clipboard remains usable for subsequent pastes.
          const attrs: Record<string, { type: string; buffer: ArrayBuffer }> = {};
          for (const [id, entry] of Object.entries(clip.attributes)) {
            attrs[id] = { type: entry.type, buffer: entry.buffer.slice(0) };
          }
          workerRef.current?.postMessage({
            type: 'writeRegion',
            row: brushRow, col: brushCol, w: clip.w, h: clip.h,
            attributes: attrs,
            activeViewer: activeViewerRef.current,
          });
        }
        return;
      }
      if (e.key === ' ') { e.preventDefault(); handleStep(); }
      else if (e.key === 'Enter') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); handleReset(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });

  // F3: Update model attribute at runtime
  const handleModelAttrChange = (attrId: string, value: number) => {
    setRuntimeModelAttrs(prev => ({ ...prev, [attrId]: value }));
    workerRef.current?.postMessage({ type: 'updateModelAttrs', attrs: { [attrId]: value } });
  };

  // Variegated Cells: interaction-table model attrs are live-tuneable like
  // any other model attr but their payload is the full nested map (not a
  // single number). We persist via updateAttribute (marks the model dirty
  // because changing the table changes the model spec, same as editing it in
  // the modeler) AND post an updateInteractionTable message to the worker so
  // the simulator sees the new values immediately.
  const handleInteractionTableEdit = (
    attrId: string,
    tableValues: Record<string, Record<string, number>> | undefined,
    symmetric: boolean | undefined,
  ) => {
    const changes: Partial<Attribute> = {};
    if (tableValues !== undefined) changes.tableValues = tableValues;
    if (symmetric !== undefined) changes.symmetric = symmetric;
    updateAttribute(attrId, changes);
    if (tableValues !== undefined) {
      const a = model.attributes.find(x => x.id === attrId);
      workerRef.current?.postMessage({
        type: 'updateLookupTable',
        attrId,
        rowLabels: resolveKeyLabels(a?.rowKeySource, model),
        colLabels: resolveKeyLabels(a?.colKeySource, model),
        values: tableValues,
      });
    }
  };

  // Reset every model attribute back to its declared default value.
  // Scalar attrs come from `computeDefaultModelAttrs`. Interaction tables
  // restore from the snapshot captured at model-load time (see
  // `interactionTableDefaultsRef`) — both via `updateAttribute` (so a
  // subsequent .gcaproj save captures the restored values) AND via the worker
  // `updateInteractionTable` message (so the running simulation sees the
  // restored values immediately).
  const handleResetModelAttrs = () => {
    const defaults = computeDefaultModelAttrs(model.attributes);
    setRuntimeModelAttrs(defaults);
    workerRef.current?.postMessage({ type: 'updateModelAttrs', attrs: defaults });
    const tableDefaults = interactionTableDefaultsRef.current;
    for (const a of model.attributes) {
      if (a.type !== 'lookupTable') continue;
      const def = tableDefaults[a.id];
      if (!def) continue;
      // Deep clone — keep the snapshot intact so subsequent resets still work
      // after future edits.
      const restored = JSON.parse(JSON.stringify(def));
      updateAttribute(a.id, { tableValues: restored });
      workerRef.current?.postMessage({
        type: 'updateLookupTable',
        attrId: a.id,
        rowLabels: resolveKeyLabels(a.rowKeySource, model),
        colLabels: resolveKeyLabels(a.colKeySource, model),
        values: restored,
      });
    }
  };

  // F4: Screenshot export — 1:1 pixel-perfect from source canvas (no scaling).
  // Under WebGPU direct render the placeholder srcCanvas's 2D context is gone
  // (transferred to the worker), so toBlob/getImageData all fail. Ask the
  // worker for a fresh colors snapshot, paint it onto an offscreen 2D canvas,
  // then toBlob from there. Falls through to direct toBlob in JS/WASM modes.
  const screenshotPendingRef = useRef<((data: { w: number; h: number; colors?: Uint8ClampedArray }) => void) | null>(null);
  const handleScreenshot = () => {
    const w = gridWidth.current;
    const h = gridHeight.current;
    const downloadBlob = (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = model.properties.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';
      a.href = url;
      a.download = `${name}_gen${generationRef.current}.png`;
      a.click();
      URL.revokeObjectURL(url);
    };
    if (directRenderActiveRef.current) {
      if (!workerRef.current || !w || !h) return;
      screenshotPendingRef.current = ({ w: cw, h: ch, colors }) => {
        if (!colors || colors.length < cw * ch * 4) return;
        const off = document.createElement('canvas');
        off.width = cw; off.height = ch;
        const ctx = off.getContext('2d');
        if (!ctx) return;
        const imageData = new ImageData(new Uint8ClampedArray(colors), cw, ch);
        ctx.putImageData(imageData, 0, 0);
        off.toBlob(blob => { if (blob) downloadBlob(blob); }, 'image/png');
      };
      workerRef.current.postMessage({ type: 'requestColorsSnapshot', tag: 'screenshot' });
      return;
    }
    const src = srcCanvasRef.current;
    if (!src) return;
    src.toBlob(blob => { if (blob) downloadBlob(blob); }, 'image/png');
  };

  // Save simulation state
  const handleSaveState = () => {
    if (!workerRef.current) return;
    pendingStateSave.current = (workerState) => {
      const state = serializeSimState(
        workerState as Parameters<typeof serializeSimState>[0],
        {
          activeViewer,
          brushColor,
          brushW,
          brushH,
          brushMapping,
          targetFps,
          unlimitedFps,
          gensPerFrame,
          unlimitedGens,
          indicatorChartOverrides,
        },
        { grid: true, controls: true },
        { boundaryTreatment: model.properties.boundaryTreatment },
      );
      // Also store in model context so next .gcaproj save includes it
      setSimulationState(state);
      const name = model.properties.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';
      downloadStateFile(state, `${name}_gen${generationRef.current}.gcastate`);
    };
    workerRef.current.postMessage({ type: 'getState' });
  };

  // Load simulation state from .gcastate file
  const handleLoadState = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const state = await readStateFile(file);
      applySimulationState(state);
    } catch (err) {
      setCompileError(String(err));
    }
  };

  // Snapshot the current interaction-table values keyed by attribute id, deep-
  // cloned so a later mutation of model.attributes doesn't leak back into the
  // saved preset payload. Returns undefined when no interaction-table attrs
  // exist (serializePreset skips the field entirely in that case).
  const snapshotInteractionTables = (): Record<string, Record<string, Record<string, number>>> | undefined => {
    const out: Record<string, Record<string, Record<string, number>>> = {};
    let any = false;
    for (const a of model.attributes) {
      if (a.type !== 'lookupTable' || !a.tableValues) continue;
      out[a.id] = JSON.parse(JSON.stringify(a.tableValues));
      any = true;
    }
    return any ? out : undefined;
  };

  // Save current state as a named preset (captures modelAttrs always, grid optionally)
  const handleCreatePreset = (name: string, description: string, includeGrid: boolean) => {
    if (!workerRef.current) return;
    pendingStateSave.current = (workerState) => {
      const state = serializePreset(
        workerState as Parameters<typeof serializePreset>[0],
        { includeGrid },
        {
          boundaryTreatment: model.properties.boundaryTreatment,
          interactionTables: snapshotInteractionTables(),
        },
      );
      const id = 'preset_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const preset: Preset = { id, name, state, createdAt: Date.now() };
      if (description.trim()) preset.description = description.trim();
      addPreset(preset);
    };
    workerRef.current.postMessage({ type: 'getState' });
  };

  const handleLoadPreset = (p: Preset) => {
    // Only pause if the preset forces a structural worker reinit (grid
    // dimensions or boundary treatment change) — that genuinely restarts the
    // engine. Parameter-only / matching-dims presets apply live, so loading
    // them while playing must NOT interrupt the running simulation. Predicate
    // mirrors applySimulationState's boundaryChanged/dimsChanged check.
    const s = p.state;
    const hasGrid = s.width != null && s.height != null && s.attributes != null && s.colors != null;
    const boundaryChanged = !!s.boundaryTreatment && s.boundaryTreatment !== model.properties.boundaryTreatment;
    const dimsFromState = s.gridWidth != null && s.gridHeight != null
      ? { w: s.gridWidth, h: s.gridHeight }
      : hasGrid ? { w: s.width!, h: s.height! } : null;
    const dimsChanged = dimsFromState != null
      && (dimsFromState.w !== gridWidth.current || dimsFromState.h !== gridHeight.current);
    if ((boundaryChanged || dimsChanged) && playing) setPlaying(false);
    applySimulationState(p.state);
  };

  const handleDeletePreset = (p: Preset) => {
    setPresetToDelete(p);
  };

  // Overwrite preset: same pipeline as create, but dispatches updatePreset instead of addPreset.
  const handleOverwritePreset = (p: Preset) => {
    setPresetToOverwrite(p);
  };

  const doOverwritePreset = (target: Preset, name: string, description: string, includeGrid: boolean) => {
    if (!workerRef.current) return;
    pendingStateSave.current = (workerState) => {
      const state = serializePreset(
        workerState as Parameters<typeof serializePreset>[0],
        { includeGrid },
        {
          boundaryTreatment: model.properties.boundaryTreatment,
          interactionTables: snapshotInteractionTables(),
        },
      );
      const patch: Partial<Omit<Preset, 'id'>> = { name, state };
      patch.description = description.trim() || undefined;
      updatePreset(target.id, patch);
    };
    workerRef.current.postMessage({ type: 'getState' });
  };

  const applySimulationState = useCallback((state: SimulationState) => {
    if (!workerRef.current) return;

    // Wave A.6: standalone .gcastate files saved by pre-A.6 builds carry no
    // schemaVersion and may hold slot-index NI cell-attr arrays. Migrate
    // in place using the current model's neighborhoodHintIds. Embedded
    // simulationState inside .gcaproj files was already migrated by
    // readModelFile, but presets / direct state loads come through here.
    if ((state.schemaVersion ?? 1) < 2 && state.attributes) {
      migrateSimulationStateV1toV2(state, model);
    }

    const hasGrid = state.width != null && state.height != null && state.attributes != null && state.colors != null;
    const hasControls = state.brushColor != null || state.targetFps != null || state.activeViewer != null;

    // If the saved state has a different boundary treatment or different grid dimensions
    // than the current model, apply those through the normal model-update path. The
    // existing useEffect on [model] detects structural changes and triggers a full
    // worker reinit; the pending-restore mechanism then applies the grid/control
    // state after the new worker finishes its first step.
    const boundaryChanged = state.boundaryTreatment && state.boundaryTreatment !== model.properties.boundaryTreatment;
    const dimsFromState = state.gridWidth != null && state.gridHeight != null
      ? { w: state.gridWidth, h: state.gridHeight }
      : hasGrid ? { w: state.width!, h: state.height! } : null;
    const dimsChanged = dimsFromState != null
      && (dimsFromState.w !== gridWidth.current || dimsFromState.h !== gridHeight.current);
    if (boundaryChanged || dimsChanged) {
      pendingSimStateRestore.current = state;
      const changes: Partial<import('../model/types').ModelProperties> = {};
      if (boundaryChanged) changes.boundaryTreatment = state.boundaryTreatment!;
      if (dimsChanged) {
        changes.gridWidth = dimsFromState!.w;
        changes.gridHeight = dimsFromState!.h;
      }
      updateProperties(changes);
      return;
    }

    // Restore UI controls (independent of grid)
    if (hasControls) {
      if (state.activeViewer != null) setActiveViewer(state.activeViewer);
      if (state.brushColor != null) setBrushColor(state.brushColor);
      if (state.brushW != null) setBrushW(state.brushW);
      if (state.brushH != null) setBrushH(state.brushH);
      if (state.brushMapping != null) setBrushMapping(state.brushMapping);
      if (state.targetFps != null) setTargetFps(state.targetFps);
      if (state.unlimitedFps != null) setUnlimitedFps(state.unlimitedFps);
      if (state.gensPerFrame != null) setGensPerFrame(state.gensPerFrame);
      if (state.unlimitedGens != null) setUnlimitedGens(state.unlimitedGens);
      // Per-indicator chart-settings overrides (gear popover). Replace
      // wholesale — the saved snapshot is the complete override layer.
      if (state.indicatorChartOverrides != null) setIndicatorChartOverrides(state.indicatorChartOverrides);
    }

    // Restore model-attribute values independently — presets may carry these
    // without any UI controls, so gating on hasControls would silently skip them.
    if (state.modelAttrs) {
      setRuntimeModelAttrs(prev => ({ ...prev, ...state.modelAttrs }));
      workerRef.current?.postMessage({ type: 'updateModelAttrs', attrs: state.modelAttrs });
    }

    // Restore interaction-table model attributes. Presets (e.g. parameter sets
    // for chemistry models like Amphiphile) typically vary a dozen+ float values
    // across several tables; storing them by id->row->col->float keeps the
    // preset payload compact and human-readable. Apply to BOTH the worker
    // (immediate effect on the running simulation) AND the model state via
    // updateAttribute (so a subsequent .gcaproj save captures the preset values
    // and the Properties panel reflects them). UPDATE_ATTRIBUTE does NOT bump
    // modelVersion, so the interaction-table snapshot used by Reset-to-Default
    // stays pointed at the model's ORIGINAL defaults — letting the user always
    // get back to the model's shipped baseline after experimenting.
    if (state.interactionTables) {
      for (const [attrId, values] of Object.entries(state.interactionTables)) {
        const cloned = JSON.parse(JSON.stringify(values));
        updateAttribute(attrId, { tableValues: cloned });
        const a = model.attributes.find(x => x.id === attrId);
        workerRef.current?.postMessage({
          type: 'updateLookupTable',
          attrId,
          rowLabels: resolveKeyLabels(a?.rowKeySource, model),
          colLabels: resolveKeyLabels(a?.colKeySource, model),
          values: cloned,
        });
      }
    }

    // Restore grid state if present
    if (!hasGrid) return;

    // Validate dimensions match the current grid
    if (state.width !== gridWidth.current || state.height !== gridHeight.current) {
      setCompileError(
        `State dimensions (${state.width}\u00D7${state.height}) do not match current grid (${gridWidth.current}\u00D7${gridHeight.current}). Resize the grid first or load a matching state file.`,
      );
      return;
    }

    // Reset generation counter — saved states restore the grid configuration,
    // not the simulation history. Users building a starting configuration
    // shouldn't inherit the generation count they spent getting there.
    generationRef.current = 0;
    lastGenSetTime.current = 0;
    setGeneration(0);
    indicatorValuesRef.current = {};
    indicatorHistoryRef.current = {};

    // Convert serialized attributes back to ArrayBuffers for worker
    const attrBuffers: Record<string, { type: string; buffer: ArrayBuffer }> = {};
    const total = state.width! * state.height!;
    for (const [id, entry] of Object.entries(state.attributes!)) {
      // Backward-compat: files saved before `neighborIndex: 'int32'` was added
      // to ATTR_TYPE_MAP in fileOperations.ts wrote NI cell-attr buffers with
      // type='float64' even though the bytes were really int32. Fix the label
      // on the way in so deserializeTypedArray reads the buffer as Int32Array
      // (correct byte interpretation) instead of Float64Array (which would
      // slice 4N bytes into N/2 float64 elements of garbage and corrupt every
      // NI cell value silently). Detected by the model declaring the attr as
      // neighborIndex while the serialized type is float64.
      const modelAttr = model.attributes.find(a => a.id === id);
      if (modelAttr?.type === 'neighborIndex' && entry.type === 'float64') {
        entry.type = 'int32';
      }
      const arr = deserializeTypedArray(entry, total);
      const typeMap: Record<string, string> = { uint8: 'bool', int32: 'integer', float64: 'float' };
      attrBuffers[id] = { type: typeMap[entry.type] || 'float', buffer: arr.buffer };
    }

    const colorsBuffer = base64ToArrayBuffer(state.colors!);
    // NOTE: `generation`, `indicators`, `linkedAccumulators` are intentionally
    // NOT forwarded — the worker resets them to defaults in its loadState
    // handler so the user gets a clean run starting from the loaded grid state.
    const loadMsg: Record<string, unknown> = {
      type: 'loadState',
      width: state.width,
      height: state.height,
      attributes: attrBuffers,
      modelAttrs: state.modelAttrs || {},
      colors: colorsBuffer,
      activeViewer: state.activeViewer ?? activeViewerRef.current,
    };

    if (state.orderArray) {
      loadMsg.orderArray = base64ToArrayBuffer(state.orderArray);
    }

    workerRef.current.postMessage(loadMsg);
  }, [model.properties.boundaryTreatment, updateProperties]);

  // F5: Apply dimension override
  const handleApplyDimensions = () => {
    const w = Math.max(1, simWidth);
    const h = Math.max(1, simHeight);
    initWorkerWithDimensions(w, h);
  };

  // F6: Import image as starting point
  const handleImageImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const img = new Image();
    img.onload = () => {
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = img.width;
      tmpCanvas.height = img.height;
      const ctx = tmpCanvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      const pixels = new Uint8ClampedArray(imageData.data);
      // Store pixels for after worker reinit
      pendingImageImport.current = pixels;
      pendingImageMapping.current = brushMappingRef.current;
      // Reinit worker with image dimensions (1 pixel = 1 cell)
      initWorkerWithDimensions(img.width, img.height);
    };
    img.src = URL.createObjectURL(file);
  };

  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [topBarOpen, setTopBarOpen] = useState(true);
  const [bottomBarOpen, setBottomBarOpen] = useState(true);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  // Remembers panel + bar state before entering F-fullscreen so the toggle
  // restores the user's previous layout (instead of always opening everything).
  const prePanelStateRef = useRef<{ left: boolean; right: boolean; top: boolean; bottom: boolean } | null>(null);

  // F = toggle all four bars at once (true canvas fullscreen). Gated on
  // visibility so the shortcut doesn't fire from the Modeler / Help / Library
  // tabs (SimulatorView is always-mounted), and on no-active-text-field so the
  // user can still type 'f' in inputs.
  const visibleRef = useRef(visible);
  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!visibleRef.current) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae?.isContentEditable ?? false)) return;
      e.preventDefault();
      const anyOpen = leftPanelOpen || rightPanelOpen || topBarOpen || bottomBarOpen;
      if (anyOpen) {
        prePanelStateRef.current = { left: leftPanelOpen, right: rightPanelOpen, top: topBarOpen, bottom: bottomBarOpen };
        setLeftPanelOpen(false);
        setRightPanelOpen(false);
        setTopBarOpen(false);
        setBottomBarOpen(false);
      } else {
        const prev = prePanelStateRef.current;
        setLeftPanelOpen(prev ? prev.left : true);
        setRightPanelOpen(prev ? prev.right : true);
        setTopBarOpen(prev ? prev.top : true);
        setBottomBarOpen(prev ? prev.bottom : true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [leftPanelOpen, rightPanelOpen, topBarOpen, bottomBarOpen]);

  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);
  const attrToColorMappings = model.mappings.filter(m => m.isAttributeToColor);
  const colorToAttrMappings = model.mappings.filter(m => !m.isAttributeToColor);

  return (
    <div className={styles.simulatorLayout}>
      {/* === Left Panel (collapsible) === */}
      {leftPanelOpen && (
        <div className={styles.sidePanel} ref={leftPanelRef}>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Settings</span>
          </div>
          <div
            className={styles.leftPanelResizeHandle}
            onMouseDown={e => {
              e.preventDefault();
              const panel = leftPanelRef.current;
              if (!panel) return;
              const startX = e.clientX;
              const startW = panel.offsetWidth;
              // Drag below this on release → snap closed. Mirrors the
              // common IDE "drag inward to collapse" gesture. The drag
              // visually clamps a bit lower (40px) so the user sees the
              // panel shrink before the snap fires.
              const COLLAPSE_THRESHOLD = 100;
              const DRAG_MIN = 40;
              let lastW = startW;
              const onMove = (ev: MouseEvent) => {
                lastW = Math.max(DRAG_MIN, startW + (ev.clientX - startX));
                panel.style.width = lastW + 'px';
                panel.style.minWidth = lastW + 'px';
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (lastW < COLLAPSE_THRESHOLD) {
                  // Snap-close. The panel is unmounted next render, so
                  // any inline width/minWidth set during the drag goes
                  // with it — re-opening starts from the CSS default.
                  setLeftPanelOpen(false);
                }
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          />

          <div className={styles.panelBody}>
          <div className={styles.sectionTitle}>Actions</div>
          <button className={styles.controlButton} onClick={handleRandomize}>Randomize</button>
          <button className={styles.controlButton} onClick={handleRecompile}>Recompile</button>

          <hr className={styles.divider} />
          <div className={styles.sectionTitle}>Grid Dimensions</div>
          <div className={styles.fieldRow}>
            <span className={styles.statLabel}>W</span>
            <input className={styles.brushInput} style={{ flex: 1, width: 0, minWidth: 0 }} type="number" min={1} value={simWidth}
              onChange={e => setSimWidth(Math.max(1, Number(e.target.value) || 1))} />
            <span className={styles.statLabel}>H</span>
            <input className={styles.brushInput} style={{ flex: 1, width: 0, minWidth: 0 }} type="number" min={1} value={simHeight}
              onChange={e => setSimHeight(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <button className={styles.controlButton} onClick={handleApplyDimensions}>Resize</button>
          <div className={styles.fieldRow} style={{ marginTop: 6 }}>
            <span className={styles.statLabel} style={{ flex: 1 }} title="How neighbors outside the grid are handled">Boundary</span>
            <select
              className={styles.brushInput}
              style={{ flex: 1, width: 0, minWidth: 0 }}
              value={model.properties.boundaryTreatment}
              onChange={e => updateProperties({ boundaryTreatment: e.target.value as 'torus' | 'constant' })}
            >
              <option value="torus">Torus (wrap)</option>
              <option value="constant">Constant</option>
            </select>
          </div>

          <hr className={styles.divider} />
          <div className={styles.sectionTitle}>Presets</div>
          {(model.presets || []).length === 0 && (
            <div style={{ fontSize: 11, color: '#888', padding: '4px 0 6px' }}>
              No presets yet. Tune the model attributes below and save a snapshot.
            </div>
          )}
          {(model.presets || []).map(p => {
            const hasGrid = p.state.width != null;
            return (
              <div key={p.id} className={styles.fieldRow} title={p.description || (hasGrid ? `Includes grid (${p.state.width}\u00D7${p.state.height})` : 'Parameters only')}>
                <span className={styles.statLabel} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}{hasGrid ? ' \u25C9' : ''}
                </span>
                <button className={styles.controlButton} style={{ padding: '2px 8px', flex: 'none' }} onClick={() => handleLoadPreset(p)}>Load</button>
                <button className={styles.controlButton} style={{ padding: '2px 6px', flex: 'none' }} title="Overwrite preset with current state" onClick={() => handleOverwritePreset(p)}>&#x1F4BE;</button>
                <button className={styles.controlButton} style={{ padding: '2px 6px', flex: 'none' }} title="Delete preset" onClick={() => handleDeletePreset(p)}>&times;</button>
              </div>
            );
          })}
          <button className={styles.controlButton} onClick={() => setPresetDialogOpen(true)}>
            + Save Current as Preset&hellip;
          </button>

          {modelAttrs.length > 0 && (
            <>
              <hr className={styles.divider} />
              <div className={styles.sectionTitle}>Model Attributes</div>
              <button className={styles.controlButton} onClick={handleResetModelAttrs}>
                Reset to Default
              </button>
              {modelAttrs.map(a => (
                <div key={a.id} className={styles.fieldRow}>
                  <span className={styles.statLabel} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.description || a.name}>{a.name}</span>
                  {a.type === 'bool' ? (
                    <input type="checkbox" checked={(runtimeModelAttrs[a.id] ?? 0) === 1}
                      onChange={e => handleModelAttrChange(a.id, e.target.checked ? 1 : 0)} />
                  ) : a.type === 'integer' ? (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 2, minWidth: 0 }}>
                      {a.hasBounds && a.min != null && a.max != null && (
                        <input type="range" min={a.min} max={a.max} step={1}
                          value={runtimeModelAttrs[a.id] ?? 0}
                          onChange={e => handleModelAttrChange(a.id, Math.round(Number(e.target.value)))}
                          style={{ flex: 1, minWidth: 0, width: '100%' }} />
                      )}
                      <input className={styles.brushInput} type="number" step={1}
                        min={a.hasBounds ? a.min : undefined} max={a.hasBounds ? a.max : undefined}
                        value={runtimeModelAttrs[a.id] ?? 0}
                        onChange={e => {
                          let v = Math.round(Number(e.target.value) || 0);
                          if (a.hasBounds && a.min != null) v = Math.max(a.min, v);
                          if (a.hasBounds && a.max != null) v = Math.min(a.max, v);
                          handleModelAttrChange(a.id, v);
                        }} />
                    </div>
                  ) : a.type === 'float' ? (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 2, minWidth: 0 }}>
                      {a.hasBounds && a.min != null && a.max != null && (
                        <input type="range" min={a.min} max={a.max} step={(a.max - a.min) / 100}
                          value={runtimeModelAttrs[a.id] ?? 0}
                          onChange={e => handleModelAttrChange(a.id, Number(e.target.value))}
                          style={{ flex: 1, minWidth: 0, width: '100%' }} />
                      )}
                      <input className={styles.brushInput} type="number" step="any"
                        min={a.hasBounds ? a.min : undefined} max={a.hasBounds ? a.max : undefined}
                        value={runtimeModelAttrs[a.id] ?? 0}
                        onChange={e => {
                          let v = Number(e.target.value) || 0;
                          if (a.hasBounds && a.min != null) v = Math.max(a.min, v);
                          if (a.hasBounds && a.max != null) v = Math.min(a.max, v);
                          handleModelAttrChange(a.id, v);
                        }} />
                    </div>
                  ) : a.type === 'tag' ? (
                    <select className={styles.brushInput} style={{ width: 'auto' }}
                      value={runtimeModelAttrs[a.id] ?? 0}
                      onChange={e => handleModelAttrChange(a.id, Number(e.target.value))}>
                      {(a.tagOptions || []).map((t, i) => (
                        <option key={i} value={i}>{t}</option>
                      ))}
                      {(!a.tagOptions || a.tagOptions.length === 0) && <option value={0}>(no tags)</option>}
                    </select>
                  ) : a.type === 'color' ? (
                    <input type="color"
                      value={'#' + [
                        (runtimeModelAttrs[a.id + '_r'] ?? 128).toString(16).padStart(2, '0'),
                        (runtimeModelAttrs[a.id + '_g'] ?? 128).toString(16).padStart(2, '0'),
                        (runtimeModelAttrs[a.id + '_b'] ?? 128).toString(16).padStart(2, '0'),
                      ].join('')}
                      onChange={e => {
                        const hex = e.target.value;
                        handleModelAttrChange(a.id + '_r', parseInt(hex.slice(1, 3), 16));
                        handleModelAttrChange(a.id + '_g', parseInt(hex.slice(3, 5), 16));
                        handleModelAttrChange(a.id + '_b', parseInt(hex.slice(5, 7), 16));
                      }}
                      style={{ width: 50, height: 24, border: 'none', cursor: 'pointer' }}
                    />
                  ) : a.type === 'neighborIndex' ? (
                    // NeighborIndex is stored on GPU/WASM as a packed (dr, dc) i32.
                    // Reuses the modeler's NeighborIndexValuePicker: when the
                    // attribute has a `neighborhoodHintId`, the picker shows a
                    // clickable grid (one cell per offset) so the user just picks
                    // a position; otherwise it falls back to dr/dc number inputs.
                    // The model-side `neighborhoodHintId` is read-only here (the
                    // simulator doesn't mutate model definitions); the user
                    // changes it in the Attributes panel of the modeler.
                    (() => {
                      const raw = runtimeModelAttrs[a.id] ?? 0;
                      const value = raw === INVALID_NI ? 0 : (raw | 0);
                      const hint = a.neighborhoodHintId
                        ? (model.neighborhoods.find(n => n.id === a.neighborhoodHintId) ?? null)
                        : null;
                      const { dr, dc } = unpackNI(value);
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 2, minWidth: 0, alignItems: 'flex-end' }}>
                          <NeighborIndexValuePicker
                            value={value}
                            hint={hint}
                            onChange={packed => handleModelAttrChange(a.id, packed)}
                            cellSize={18}
                          />
                          <span style={{ fontSize: 10, color: '#7a8a9a' }}>
                            (dr {dr}, dc {dc})
                          </span>
                        </div>
                      );
                    })()
                  ) : a.type === 'lookupTable' ? (
                    // Lookup Tables are too wide for the single-row layout. The
                    // matrix editor renders below the label and dispatches an
                    // updateLookupTable worker message (live-tuned during sim).
                    <div style={{ flex: 2, minWidth: 0 }}>
                      {(() => {
                        const rowLabels = resolveKeyLabels(a.rowKeySource, model);
                        const colLabels = resolveKeyLabels(a.colKeySource, model);
                        return rowLabels.length > 0 && colLabels.length > 0 ? (
                          <LookupTableEditor
                            attribute={a}
                            rowLabels={rowLabels}
                            colLabels={colLabels}
                            compact
                            onChange={changes => handleInteractionTableEdit(a.id, changes.tableValues, changes.symmetric)}
                          />
                        ) : (
                          <div style={{ color: '#888', fontSize: '0.62rem' }}>
                            Set this table's row and column key sources to populate it.
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <input className={styles.brushInput} type="number" step="any"
                      value={runtimeModelAttrs[a.id] ?? 0}
                      onChange={e => handleModelAttrChange(a.id, Number(e.target.value) || 0)} />
                  )}
                </div>
              ))}
            </>
          )}

          {compileError && (
            <>
              <hr className={styles.divider} />
              <div className={styles.error}>{compileError}</div>
            </>
          )}

          <hr className={styles.divider} />
          <button className={styles.controlButton} onClick={() => setShowCode(!showCode)}>
            {showCode ? 'Hide' : 'Show'} Code
          </button>
          {showCode && (
            <div className={styles.codePanel}>
              <button className={styles.copyButton} onClick={handleCopyCode}>Copy</button>
              <pre className={styles.codeBlock}>{compiledCode || '(no compiled code)'}</pre>
            </div>
          )}
          </div>
        </div>
      )}

      {/* === Canvas Area === */}
      <div className={styles.canvasArea}>
        {compileError && (
          <div className={styles.errorBanner} data-sim-overlay>
            {compileError}
          </div>
        )}
        {/* Settings panel ear — sits at the canvas's left edge. We render it
            inside canvasArea (not inside .sidePanel, which has overflow:hidden
            and would clip a sticking-out ear) so it works in both states.
            Glyph + handler swap based on whether the panel is open. */}
        <button
          className={styles.panelExpandBtn}
          style={{ left: 0 }}
          onClick={() => setLeftPanelOpen(v => !v)}
          title={leftPanelOpen ? 'Close settings' : 'Open settings'}
          data-sim-overlay
        >{leftPanelOpen ? '‹' : '›'}</button>
        <canvas ref={canvasRef} className={styles.canvas} />

        {/* Top-left stats (discreet, no background) */}
        <div className={styles.statsOverlay} data-sim-overlay>
          <span>Gen {generation}</span>
          <span>{gridWidth.current || simWidth}&times;{gridHeight.current || simHeight}</span>
          <span>{actualFps} FPS</span>
          <span>{actualGps} g/s</span>
          {hoverCellInfo && (
            (hoverCellInfo.x0 === hoverCellInfo.x1 && hoverCellInfo.y0 === hoverCellInfo.y1)
              ? <span title="Hovered cell">Cell ({hoverCellInfo.col}, {hoverCellInfo.row})</span>
              : <span title="Brush footprint at the hovered cell">Cells ({hoverCellInfo.x0},{hoverCellInfo.y0}) {'\u2192'} ({hoverCellInfo.x1},{hoverCellInfo.y1})</span>
          )}
          {recording && <span style={{ color: '#e05050' }}>{'\u23FA'} REC {recordFrameCount}f</span>}
        </div>

        {/* Top overlay: small attached ear (its own pill) + viewer bar pill,
            wrapped together so the ear reads as a separate widget adjacent to
            the bar, not as one of the bar's tabs. Chevrons are inline SVGs so
            the up/down pair is pixel-identical. */}
        {attrToColorMappings.length > 0 && (
          <div className={styles.viewerBarRow} data-sim-overlay>
            <button
              className={styles.barAttachedEar}
              onClick={() => setTopBarOpen(v => !v)}
              title={topBarOpen ? 'Hide viewer bar' : 'Show viewer bar'}
            >{topBarOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}</button>
            {topBarOpen && (
              <div className={styles.viewerBar}>
                <span className={styles.viewerBarLabel}>Output Mapping (A{'\u2192'}C):</span>
                {attrToColorMappings.map(m => (
                  <button
                    key={m.id}
                    className={`${styles.viewerTab} ${activeViewer === m.id ? styles.viewerTabActive : ''}`}
                    onClick={() => setActiveViewer(m.id)}
                    title={m.description || undefined}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* End-condition pause notice (informational, not an error) */}
        {endConditionNotice && (
          <div
            data-sim-overlay
            style={{
              position: 'absolute', left: '50%', top: 54, transform: 'translateX(-50%)',
              background: 'rgba(76, 201, 240, 0.95)', color: '#0d1117',
              padding: '6px 14px', borderRadius: 6,
              fontSize: '0.78rem', fontWeight: 500,
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
              zIndex: 20, pointerEvents: 'none',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
            title="Simulation paused by a user-defined stop condition"
          >
            <span style={{ fontSize: '0.95rem' }}>&#9432;</span>
            <span>Simulation paused by user-defined stop condition &mdash; {endConditionNotice}</span>
          </div>
        )}

        {/* Bottom overlay: attached ear pill + transport bar pill in a flex
            wrapper. Ear visually adjacent to (and separate from) the bar. */}
        <div className={styles.transportBarRow} data-sim-overlay>
          <button
            className={styles.barAttachedEar}
            onClick={() => setBottomBarOpen(v => !v)}
            title={bottomBarOpen ? 'Hide transport bar' : 'Show transport bar'}
          >{bottomBarOpen ? <ChevronDownIcon /> : <ChevronUpIcon />}</button>
          {bottomBarOpen && (<>
        <div className={styles.transportBar}>
          {/* Save/Load state */}
          <button className={styles.transportBtn} onClick={handleSaveState} title="Save State (.gcastate)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
          </button>
          <button className={styles.transportBtn} onClick={() => stateFileInputRef.current?.click()} title="Load State (.gcastate)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <input ref={stateFileInputRef} type="file" accept=".gcastate" style={{ display: 'none' }} onChange={handleLoadState} />
          <div className={styles.transportDivider} />

          {/* Speed controls (left side) */}
          <div className={styles.transportSpeed}>
            <span className={styles.transportSpeedLabel}>FPS {unlimitedFps ? '\u221E' : targetFps}</span>
            <input className={styles.transportSlider} type="range" min={1} max={200} value={targetFps}
              disabled={unlimitedFps} onChange={e => setTargetFps(Number(e.target.value))} />
            <label className={styles.transportCheck}>
              <input type="checkbox" checked={unlimitedFps} onChange={e => setUnlimitedFps(e.target.checked)} />&infin;
            </label>
          </div>
          <div className={styles.transportDivider} />

          {/* Playback controls (center) */}
          <button className={styles.transportBtn} onClick={() => setPlaying(true)} disabled={playing} title="Play (Enter)">&#9654;</button>
          <button className={styles.transportBtn} onClick={() => setPlaying(false)} disabled={!playing} title="Pause (Enter)">&#9646;&#9646;</button>
          <button className={styles.transportBtn} onClick={handleStep} title="Step (Space)">&#9654;|</button>
          <button className={styles.transportBtn} onClick={handleReset} title="Reset (Esc)">&#9632;</button>
          <button className={styles.transportBtn} onClick={handleScreenshot} title="Screenshot (PNG)">{'\uD83D\uDCF7'}</button>
          {!recording ? (
            <>
              <button
                className={styles.transportBtn}
                onClick={startRecording}
                disabled={encodingWebM}
                title={encodingWebM ? 'Encoding WebM\u2026' : `Record ${recordFormat.toUpperCase()}`}
                style={{ color: '#e05050' }}
              >{'\u23FA'}</button>
              <select
                className={styles.transportBtn}
                value={recordFormat}
                onChange={e => setRecordFormat(e.target.value as RecordFormat)}
                disabled={encodingWebM}
                title={webmAvailable
                  ? 'Recording format'
                  : 'WebM not supported in this browser \u2014 use GIF instead'}
                style={{ padding: '4px 4px', fontSize: '0.65rem' }}
              >
                <option value="webm" disabled={!webmAvailable}>WebM</option>
                <option value="gif">GIF</option>
              </select>
            </>
          ) : (
            <button className={styles.transportBtn} onClick={stopRecording} title={`Stop & Save ${recordFormat.toUpperCase()}`} style={{ color: '#e05050' }}>{'\u23F9'} {recordFrameCount}</button>
          )}
          <div className={styles.transportDivider} />

          {/* Gens/frame (right side) */}
          <div className={styles.transportSpeed}>
            <span className={styles.transportSpeedLabel}>G/F {unlimitedGens ? '\u221E' : gensPerFrame}</span>
            <input className={styles.transportSlider} type="range" min={1} max={200} value={gensPerFrame}
              disabled={unlimitedGens} onChange={e => setGensPerFrame(Number(e.target.value))} />
            <label className={styles.transportCheck}>
              <input type="checkbox" checked={unlimitedGens} onChange={e => setUnlimitedGens(e.target.checked)} />&infin;
            </label>
          </div>
        </div>

        {playing && unlimitedGens && (
          <div className={styles.overlay}>
            Processing without displaying. Change Gens/Frame to see evolution.
          </div>
        )}
          </>)}
        </div>

        {/* Zoom controls (bottom-left, like modeler) */}
        <div className={styles.zoomControls} data-sim-overlay>
          <button className={styles.zoomBtn} onClick={() => { zoomRef.current = Math.min(50, zoomRef.current * 1.3); draw(); }} title="Zoom in">+</button>
          <button className={styles.zoomBtn} onClick={() => { zoomRef.current = Math.max(0.1, zoomRef.current / 1.3); draw(); }} title="Zoom out">&minus;</button>
          <button className={styles.zoomBtn} onClick={handleResetView} title="Fit view">&#x2922;</button>
          <button
            className={`${styles.zoomBtn} ${showGridlines ? styles.zoomBtnActive : ''}`}
            onClick={() => { setShowGridlines(v => !v); draw(); }}
            title="Toggle gridlines"
          >#</button>
          <button
            className={`${styles.zoomBtn} ${infinityCanvas ? styles.zoomBtnActive : ''}`}
            onClick={() => { setInfinityCanvas(v => !v); }}
            disabled={model.properties.boundaryTreatment !== 'torus'}
            title={
              model.properties.boundaryTreatment === 'torus'
                ? 'Infinity canvas (tile the grid across the viewport)'
                : 'Infinity canvas — only available with Torus boundary'
            }
            style={{ opacity: model.properties.boundaryTreatment === 'torus' ? 1 : 0.4 }}
          >&infin;</button>
        </div>

        {/* Right panel expand button */}
        {!rightPanelOpen && (
          <button className={styles.panelExpandBtnRight} data-sim-overlay
            onClick={() => setRightPanelOpen(true)} title="Open side panel">&lsaquo;</button>
        )}
      </div>

      {/* === Right Panel (single shared panel, resizable via left border drag) === */}
      {rightPanelOpen && (
        <div className={styles.rightPanel} ref={rightPanelRef}>
          {/* Collapse button outside panel (left edge tab) */}
          <button
            className={styles.rightPanelCollapseTab}
            onClick={() => setRightPanelOpen(false)}
            title="Close side panel"
          >&rsaquo;</button>

          {/* Drag handle on full left border */}
          <div
            className={styles.rightPanelResizeHandle}
            onMouseDown={e => {
              e.preventDefault();
              const panel = rightPanelRef.current;
              if (!panel) return;
              const startX = e.clientX;
              const startW = panel.offsetWidth;
              // Mirror of the left panel: drag-inward-to-collapse. Right
              // panel grows when the handle moves LEFT (delta inverted).
              const COLLAPSE_THRESHOLD = 100;
              const DRAG_MIN = 40;
              let lastW = startW;
              const onMove = (ev: MouseEvent) => {
                lastW = Math.max(DRAG_MIN, startW - (ev.clientX - startX));
                panel.style.width = lastW + 'px';
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (lastW < COLLAPSE_THRESHOLD) setRightPanelOpen(false);
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          />

          {/* Brush Section (top, shrinks to content) */}
          <div className={`${styles.rightPanelSection} ${styles.rightSectionBrush}`}>
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>Input Mapping (C{'\u2192'}A)</span>
            </div>
            <div className={styles.rightPanelSectionBody}>
            {/* Tab strip \u2014 always rendered: even when the model has zero color
                input mappings, the Manual tab still appears. */}
            <div className={styles.mappingTabs}>
              {colorToAttrMappings.map(m => (
                <button
                  key={m.id}
                  className={`${styles.mappingTab} ${brushMapping === m.id ? styles.mappingTabActive : ''}`}
                  onClick={() => setBrushMapping(m.id)}
                  title={m.description || undefined}
                >
                  {m.name}
                </button>
              ))}
              <button
                key={MANUAL_BRUSH_MAPPING_ID}
                className={`${styles.mappingTab} ${styles.mappingTabManual} ${brushMapping === MANUAL_BRUSH_MAPPING_ID ? styles.mappingTabActive : ''}`}
                onClick={() => setBrushMapping(MANUAL_BRUSH_MAPPING_ID)}
                title="Manual Brush \u2014 directly set chosen cell attributes on painted cells (always available)"
              >
                Manual
              </button>
            </div>
            {brushMapping === MANUAL_BRUSH_MAPPING_ID ? (
              <ManualBrushPanel
                cellAttributes={model.attributes.filter(a => !a.isModelAttribute)}
                state={manualBrush}
                onChange={setManualBrush}
              />
            ) : (
              <div className={styles.fieldRow}>
                <span className={styles.statLabel}>Color</span>
                <input type="color" className={styles.colorPicker} value={brushColor}
                  onChange={e => setBrushColor(e.target.value)} />
                {(() => {
                  const { r, g, b } = hexToRgb(brushColor);
                  const setChannel = (which: 'r' | 'g' | 'b', val: number) => {
                    const c = { r, g, b, [which]: Math.max(0, Math.min(255, val | 0)) };
                    const hex = '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
                    setBrushColor(hex);
                  };
                  return (
                    <>
                      <input className={styles.brushInput} type="number" min={0} max={255} title="Red"
                        value={r} onChange={e => setChannel('r', Number(e.target.value))} />
                      <input className={styles.brushInput} type="number" min={0} max={255} title="Green"
                        value={g} onChange={e => setChannel('g', Number(e.target.value))} />
                      <input className={styles.brushInput} type="number" min={0} max={255} title="Blue"
                        value={b} onChange={e => setChannel('b', Number(e.target.value))} />
                    </>
                  );
                })()}
              </div>
            )}
            <div className={styles.fieldRow}>
              <span className={styles.statLabel}>W</span>
              <input className={styles.brushInput} type="number" min={1} max={(gridWidth.current || simWidth) * 2} value={brushW}
                onChange={e => setBrushW(Math.max(1, Number(e.target.value) || 1))} />
              <span className={styles.statLabel}>H</span>
              <input className={styles.brushInput} type="number" min={1} max={(gridHeight.current || simHeight) * 2} value={brushH}
                onChange={e => setBrushH(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <hr className={styles.divider} />
            <button
              className={styles.controlButton}
              onClick={() => imageInputRef.current?.click()}
              disabled={brushMapping === MANUAL_BRUSH_MAPPING_ID}
              title={brushMapping === MANUAL_BRUSH_MAPPING_ID ? 'Image import uses the active color mapping \u2014 select a non-Manual tab to enable.' : undefined}
            >
              Open Image
            </button>
            <input ref={imageInputRef} type="file" accept=".png,.bmp,.jpg,.jpeg" style={{ display: 'none' }} onChange={handleImageImport} />
            <label className={styles.checkRow}>
              <input type="checkbox" checked={showBrushCursor} onChange={e => setShowBrushCursor(e.target.checked)} />
              Show brush cursor
            </label>
            <div className={styles.hint}>
              {brushMapping === MANUAL_BRUSH_MAPPING_ID
                ? <>LMB paint {'\u00B7'} RMB pan {'\u00B7'} Ctrl+LMB drag resize {'\u00B7'} Ctrl+wheel cycle mapping {'\u00B7'} Shift+LMB inspect</>
                : <>LMB paint {'\u00B7'} RMB pan {'\u00B7'} Ctrl+LMB drag resize {'\u00B7'} Ctrl+wheel cycle mapping {'\u00B7'} Shift+RMB color {'\u00B7'} Shift+LMB inspect</>}
            </div>
            </div>
          </div>

          {/* Indicators Section (bottom, fills remaining space) */}
          {(model.indicators || []).length > 0 && (
            <div className={`${styles.rightPanelSection} ${styles.rightSectionIndicators}`}>
              <div className={styles.panelHeader}>
                <span className={styles.panelTitle}>Indicators</span>
              </div>
              <div className={styles.rightPanelSectionBody}>
              <IndicatorDisplay
                indicators={model.indicators || []}
                values={indicatorValuesRef.current}
                history={indicatorHistoryRef.current}
                generation={generation}
                gridWidth={gridWidth.current || simWidth}
                gridHeight={gridHeight.current || simHeight}
                vizModes={indicatorVizModes}
                hiddenCategories={indicatorHiddenCategories}
                chartOverrides={indicatorChartOverrides}
                onToggleWatch={(id, watched) => updateIndicator(id, { watched })}
                onChartToggle={(id, expanded) => {
                  if (expanded) chartExpandedRef.current.add(id);
                  else chartExpandedRef.current.delete(id);
                }}
                onCycleVizMode={cycleIndicatorVizMode}
                onToggleCategory={toggleIndicatorCategory}
                onChangeChartOverrides={changeIndicatorChartOverrides}
              />
              </div>
            </div>
          )}
        </div>
      )}
      {colorPopover && (
        <BrushColorPopover
          x={colorPopover.x}
          y={colorPopover.y}
          color={brushColor}
          onChange={setBrushColor}
          onClose={() => setColorPopover(null)}
        />
      )}
      {inspectPopovers.map(p => (
        <InspectCellPopover
          key={p.cellIdx}
          popover={p}
          cellAttrs={model.attributes.filter(a => !a.isModelAttribute)}
          values={inspectDataRef.current.get(p.cellIdx) ?? null}
          color={inspectColorsRef.current.get(p.cellIdx) ?? null}
          orientation={inspectOrientationsRef.current.get(p.cellIdx) ?? null}
          pulse={pulseInspectIdx === p.cellIdx}
          focused={focusedInspectIdx === p.cellIdx}
          totalOpen={inspectPopovers.length}
          onClose={() => {
            setInspectPopovers(prev => prev.filter(pp => pp.cellIdx !== p.cellIdx));
            setFocusedInspectIdx(curr => (curr === p.cellIdx ? null : curr));
            setHoveredInspectIdx(curr => (curr === p.cellIdx ? null : curr));
          }}
          onCloseAll={() => {
            setInspectPopovers([]);
            setFocusedInspectIdx(null);
            setHoveredInspectIdx(null);
          }}
          onFocus={() => {
            setFocusedInspectIdx(p.cellIdx);
            setInspectPopovers(prev => {
              const i = prev.findIndex(pp => pp.cellIdx === p.cellIdx);
              if (i < 0 || i === prev.length - 1) return prev;
              const next = [...prev];
              const [moved] = next.splice(i, 1);
              next.push(moved!);
              return next;
            });
          }}
          onDragEnd={(x, y) => {
            setInspectPopovers(prev => prev.map(pp => pp.cellIdx === p.cellIdx ? { ...pp, x, y } : pp));
          }}
          onHoverEnter={() => setHoveredInspectIdx(p.cellIdx)}
          onHoverLeave={() => setHoveredInspectIdx(curr => (curr === p.cellIdx ? null : curr))}
          onRectMeasure={(rect) => { popoverRectsRef.current.set(p.cellIdx, rect); }}
        />
      ))}
      {sweepInspector && (
        <InspectCellPopover
          key="sweep"
          popover={sweepInspector}
          cellAttrs={model.attributes.filter(a => !a.isModelAttribute)}
          values={inspectDataRef.current.get(sweepInspector.cellIdx) ?? null}
          color={inspectColorsRef.current.get(sweepInspector.cellIdx) ?? null}
          orientation={inspectOrientationsRef.current.get(sweepInspector.cellIdx) ?? null}
          pulse={false}
          focused={false}
          totalOpen={inspectPopovers.length + 1}
          onClose={() => {}}
          onCloseAll={() => {}}
          onFocus={() => {}}
          onDragEnd={() => {}}
          onHoverEnter={() => {}}
          onHoverLeave={() => {}}
          onRectMeasure={(rect) => { sweepRectRef.current = rect; }}
        />
      )}
      {hoveredInspectIdx != null && (() => {
        const p = inspectPopovers.find(pp => pp.cellIdx === hoveredInspectIdx);
        if (!p) return null;
        const cell = gridToScreen(p.row, p.col);
        if (!cell) return null;
        const popupRect = popoverRectsRef.current.get(p.cellIdx);
        return (
          <InspectHoverLink
            cellX={cell.x}
            cellY={cell.y}
            cellSize={cell.cellSize}
            popupRect={popupRect}
          />
        );
      })()}
      {sweepInspector && (() => {
        // Always draw the link line + cell outline for the transient sweep
        // popover — it's the user's primary feedback for which cell is being
        // inspected as they drag the cursor around.
        const cell = gridToScreen(sweepInspector.row, sweepInspector.col);
        if (!cell) return null;
        return (
          <InspectHoverLink
            cellX={cell.x}
            cellY={cell.y}
            cellSize={cell.cellSize}
            popupRect={sweepRectRef.current ?? undefined}
          />
        );
      })()}
      {presetDialogOpen && (
        <PresetSaveDialog
          onConfirm={(name, description, includeGrid) => {
            setPresetDialogOpen(false);
            handleCreatePreset(name, description, includeGrid);
          }}
          onCancel={() => setPresetDialogOpen(false)}
        />
      )}
      {presetOverwriteTarget && (
        <PresetSaveDialog
          title={`Overwrite Preset "${presetOverwriteTarget.name}"`}
          confirmLabel="Overwrite"
          initialName={presetOverwriteTarget.name}
          initialDescription={presetOverwriteTarget.description ?? ''}
          onConfirm={(name, description, includeGrid) => {
            const target = presetOverwriteTarget;
            setPresetOverwriteTarget(null);
            doOverwritePreset(target, name, description, includeGrid);
          }}
          onCancel={() => setPresetOverwriteTarget(null)}
        />
      )}
      {presetToDelete && (
        <ConfirmDialog
          title="Delete preset?"
          message={`The preset "${presetToDelete.name}" will be removed from this model.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const id = presetToDelete.id;
            setPresetToDelete(null);
            deletePreset(id);
          }}
          onCancel={() => setPresetToDelete(null)}
        />
      )}
      {presetToOverwrite && (
        <ConfirmDialog
          title="Overwrite preset?"
          message={`Replace "${presetToOverwrite.name}" with the current simulation state? The current data in this preset will be lost.`}
          confirmLabel="Overwrite"
          danger
          onConfirm={() => {
            const target = presetToOverwrite;
            setPresetToOverwrite(null);
            setPresetOverwriteTarget(target);
          }}
          onCancel={() => setPresetToOverwrite(null)}
        />
      )}
    </div>
  );
}
