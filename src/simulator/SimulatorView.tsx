import { useCallback, useEffect, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { compileGraph } from '../modeler/vpl/compiler/compile';
import { compileGraphWasm } from '../modeler/vpl/compiler/wasm/compile';
import { computeLayoutFromModel, buildViewerIds } from '../modeler/vpl/compiler/wasm/layout';
import { compileGraphWebGPU } from '../modeler/vpl/compiler/webgpu/compile';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { IndicatorDisplay } from './IndicatorDisplay';
import { BrushColorPopover } from './BrushColorPopover';
import { PresetSaveDialog } from './PresetSaveDialog';
import { serializeSimState, serializePreset, downloadStateFile, readStateFile, base64ToArrayBuffer, deserializeTypedArray } from '../model/fileOperations';
import type { Preset, SimulationState } from '../model/types';
import styles from './SimulatorView.module.css';

const SIM_SETTINGS_KEY = 'genesisca_sim_settings';

function loadSimSettings(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SIM_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

export function SimulatorView({ visible = true }: { visible?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { model, updateIndicator, setSimulationState, addPreset, deletePreset, updatePreset, updateProperties } = useModel();
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
  const [showBrushCursor, setShowBrushCursor] = useState((saved.current.showBrushCursor as boolean) ?? true);
  const [showGridlines, setShowGridlines] = useState((saved.current.showGridlines as boolean) ?? false);

  // Indicator values from worker
  // Indicator values stored in ref (not state) to avoid extra re-renders on every step.
  // The component already re-renders from setGeneration, so ref values are read during that render.
  const indicatorValuesRef = useRef<Record<string, number | Record<string, number>>>({});
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

  // GIF recording state
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const recordedFrames = useRef<ImageData[]>([]);
  const [recordFrameCount, setRecordFrameCount] = useState(0);
  // The displayed counter is throttled (~5 Hz); the captured-frames count is
  // tracked exactly via the ref. setState every step caused a SimulatorView
  // re-render per captured frame and slowed down the recording itself.
  const recordCountRef = useRef(0);
  const lastRecordCountSet = useRef(0);
  useEffect(() => { recordingRef.current = recording; }, [recording]);

  // Persist simulator settings
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(SIM_SETTINGS_KEY, JSON.stringify({
          targetFps, unlimitedFps, gensPerFrame, unlimitedGens,
          activeViewer, brushColor, brushW, brushH, brushMapping, showBrushCursor, showGridlines,
          indicatorVizModes,
        }));
      } catch { /* localStorage full */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [targetFps, unlimitedFps, gensPerFrame, unlimitedGens, activeViewer, brushColor, brushW, brushH, brushMapping, showBrushCursor, showGridlines, indicatorVizModes]);

  const cycleIndicatorVizMode = useCallback((id: string) => {
    setIndicatorVizModes(prev => {
      const cur = prev[id] ?? 'bars';
      const next: VizMode = cur === 'bars' ? 'multiline' : cur === 'multiline' ? 'stacked' : 'bars';
      return { ...prev, [id]: next };
    });
  }, []);

  // F3: Runtime model attribute values
  const [runtimeModelAttrs, setRuntimeModelAttrs] = useState<Record<string, number>>({});

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
  const gridWidth = useRef(0);
  const gridHeight = useRef(0);

  // Zoom/Pan state (refs to avoid re-renders on every mouse move)
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const cursorGrid = useRef<{ row: number; col: number } | null>(null);
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

  // Build full code display from all compiled functions
  const buildFullCode = useCallback((result: ReturnType<typeof compileGraph>) => {
    const parts: string[] = [];
    if (result.stepCode) {
      parts.push('// === Step Function ===\n' + result.stepCode);
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

  // Compile graph (deps include indicator watched state since it affects compiled code)
  const compileModel = useCallback(() => {
    const result = compileGraph(model.graphNodes, model.graphEdges, model);
    setCompiledCode(buildFullCode(result));
    setCompileError(result.error ?? '');
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.graphNodes, model.graphEdges, model.indicators, buildFullCode]);

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

    if (srcCanvasRef.current) {
      ctx.drawImage(srcCanvasRef.current, ox, oy, scaledW, scaledH);
    }

    // Draw gridlines when zoomed in enough (cells >= 4px)
    if (showGridlinesRef.current && scale >= 4) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let col = 0; col <= w; col++) {
        const x = ox + col * scale;
        if (x >= 0 && x <= parentW) {
          ctx.moveTo(x, Math.max(0, oy));
          ctx.lineTo(x, Math.min(parentH, oy + scaledH));
        }
      }
      for (let row = 0; row <= h; row++) {
        const y = oy + row * scale;
        if (y >= 0 && y <= parentH) {
          ctx.moveTo(Math.max(0, ox), y);
          ctx.lineTo(Math.min(parentW, ox + scaledW), y);
        }
      }
      ctx.stroke();
    }

    // Draw brush cursor rectangle
    const cursor = cursorGrid.current;
    if (cursor && showBrushCursorRef.current) {
      const bw = brushWRef.current;
      const bh = brushHRef.current;
      const halfW = Math.floor((bw - 1) / 2);
      const halfH = Math.floor((bh - 1) / 2);
      const bx = ox + (cursor.col - halfW) * scale;
      const by = oy + (cursor.row - halfH) * scale;
      ctx.strokeStyle = 'rgba(76, 201, 240, 0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, bw * scale, bh * scale);
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
  const evalEndConditions = useCallback((gen: number, indicatorValues: Record<string, number | Record<string, number>>): string | null => {
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
    if (msg.type === 'stepped') {
      colorsRef.current = msg.colors as Uint8ClampedArray;
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

        // GIF frame capture. Two source paths depending on render mode:
        // - Non-direct (JS / WASM, or WebGPU pre-P7): srcCanvas's 2D context
        //   is available; getImageData reads the latest frame.
        // - Direct render: srcCanvas was transferred to the worker, so the
        //   2D context is unavailable. The worker (when recording) ships
        //   colors in the stepped message; we build ImageData directly.
        if (recordingRef.current) {
          const w = gridWidth.current, h = gridHeight.current;
          const stepColors = colorsRef.current;
          if (directRenderActiveRef.current && stepColors && w && h) {
            // stepColors is the freshly-readback'd Uint8ClampedArray from
            // worker (only present in stepped when recording is active).
            // Copy it before buffering since later steps reuse the slot.
            const data = new Uint8ClampedArray(stepColors.buffer, stepColors.byteOffset, w * h * 4);
            recordedFrames.current.push(new ImageData(new Uint8ClampedArray(data), w, h));
            recordCountRef.current += 1;
          } else if (srcCanvasRef.current && !directRenderActiveRef.current) {
            const src = srcCanvasRef.current;
            let sctx: CanvasRenderingContext2D | null = null;
            try { sctx = src.getContext('2d'); } catch { /* transferred */ }
            if (sctx) {
              recordedFrames.current.push(sctx.getImageData(0, 0, src.width, src.height));
              recordCountRef.current += 1;
            }
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

    // Restore simulation state from loaded .gcaproj (after worker init completes)
    if (msg.type === 'stepped' && pendingSimStateRestore.current) {
      const state = pendingSimStateRestore.current;
      pendingSimStateRestore.current = null;
      applySimulationState(state);
    }
  };

  // Reusable worker initializer (used by structural effect and dimension/image apply)
  const initWorkerWithDimensions = useCallback((w: number, h: number) => {
    workerRef.current?.terminate();
    const result = compileModel();
    const firstViewer = model.mappings.find(m => m.isAttributeToColor);
    const viewer = firstViewer?.id ?? '';
    setActiveViewer(viewer);
    const firstInput = model.mappings.find(m => !m.isAttributeToColor);
    setBrushMapping(firstInput?.id ?? '');
    if (result.error) setCompileError(result.error);

    gridWidth.current = w;
    gridHeight.current = h;
    setSimWidth(w);
    setSimHeight(h);
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };

    // Initialize runtime model attrs from defaults
    const mAttrs: Record<string, number> = {};
    for (const a of model.attributes) {
      if (!a.isModelAttribute) continue;
      switch (a.type) {
        case 'bool': mAttrs[a.id] = a.defaultValue === 'true' ? 1 : 0; break;
        case 'integer': mAttrs[a.id] = parseInt(a.defaultValue, 10) || 0; break;
        case 'float': mAttrs[a.id] = parseFloat(a.defaultValue) || 0; break;
        case 'color': {
          const hex = a.defaultValue || '#808080';
          mAttrs[a.id + '_r'] = parseInt(hex.slice(1, 3), 16) || 0;
          mAttrs[a.id + '_g'] = parseInt(hex.slice(3, 5), 16) || 0;
          mAttrs[a.id + '_b'] = parseInt(hex.slice(5, 7), 16) || 0;
          break;
        }
        default: mAttrs[a.id] = 0;
      }
    }
    setRuntimeModelAttrs(mAttrs);

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
    const dimsModel = (model.properties.gridWidth === w && model.properties.gridHeight === h)
      ? model
      : { ...model, properties: { ...model.properties, gridWidth: w, gridHeight: h } };
    // Wave 2: try to compile a WASM step alongside the JS one. If anything
    // fails (unsupported node, etc.) we still ship the JS bytes; the worker
    // falls back automatically when wasmStepBytes is missing/empty.
    const wasmResult = (() => {
      try {
        const layout = computeLayoutFromModel(dimsModel);
        const viewerIds = buildViewerIds(dimsModel);
        return compileGraphWasm(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel, layout, viewerIds);
      } catch (e) {
        return { bytes: new Uint8Array(), minMemoryPages: 1, error: String((e as Error)?.message || e), viewerIds: {}, exports: [] };
      }
    })();
    // Wave 3: compile WebGPU shader alongside JS/WASM. Same fallback pattern:
    // any error and the worker stays on JS — useWebGPU only flips on once the
    // worker successfully acquires a device and the shader module compiles.
    const webgpuResult = (() => {
      try {
        return compileGraphWebGPU(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
      } catch (e) {
        return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: String((e as Error)?.message || e) };
      }
    })();
    // P7 direct render: when WebGPU is the chosen target AND OffscreenCanvas
    // is supported (Chrome/Edge for sure, Firefox 144+; Safari is iffy),
    // pre-allocate srcCanvasRef at grid resolution and transfer its 2D
    // context to the worker. The worker then writes WebGPU output directly
    // to it via a present compute pipeline — no per-frame readback or
    // postMessage of the colors buffer. Failure or unsupported envs fall
    // back transparently: directRenderActiveRef stays false and the
    // existing readback-then-putImageData path runs.
    let canvasForWorker: OffscreenCanvas | undefined;
    directRenderActiveRef.current = false;
    const offscreenSupported = typeof HTMLCanvasElement !== 'undefined'
      && typeof (HTMLCanvasElement.prototype as { transferControlToOffscreen?: unknown }).transferControlToOffscreen === 'function';
    if (model.properties.useWebGPU && !webgpuResult.error && offscreenSupported) {
      try {
        // Always allocate a fresh srcCanvas so transferControlToOffscreen can
        // succeed (a canvas can only be transferred once, and only if it has
        // never had a 2D / WebGL context retrieved on the main thread).
        const fresh = document.createElement('canvas');
        fresh.width = w; fresh.height = h;
        canvasForWorker = (fresh as HTMLCanvasElement & { transferControlToOffscreen: () => OffscreenCanvas }).transferControlToOffscreen();
        srcCanvasRef.current = fresh;
        directRenderActiveRef.current = true;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[webgpu] OffscreenCanvas transfer failed; falling back to readback path:', e);
        canvasForWorker = undefined;
        directRenderActiveRef.current = false;
      }
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
      })),
      neighborhoods: model.neighborhoods.map(n => ({ id: n.id, coords: n.coords })),
      boundaryTreatment: model.properties.boundaryTreatment,
      updateMode: model.properties.updateMode || 'synchronous',
      asyncScheme: model.properties.asyncScheme || 'random-order',
      stepCode: result.stepCode,
      inputColorCodes: result.inputColorCodes,
      outputMappingCodes: result.outputMappingCodes,
      stopMessages: result.stopMessages,
      activeViewer: viewer,
      indicators: (model.indicators || []).map(i => ({
        id: i.id, kind: i.kind, dataType: i.dataType,
        defaultValue: i.defaultValue, accumulationMode: i.accumulationMode,
        tagOptions: i.tagOptions,
        linkedAttributeId: i.linkedAttributeId,
        linkedAggregation: i.linkedAggregation,
        binCount: i.binCount, watched: i.watched,
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
    };
    if (canvasForWorker) {
      initMsg.webgpuCanvas = canvasForWorker;
      initMsg.webgpuCanvasWidth = w;
      initMsg.webgpuCanvasHeight = h;
      worker.postMessage(initMsg, [canvasForWorker]);
    } else {
      worker.postMessage(initMsg);
    }
    workerRef.current = worker;
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
    // only if its dimensions match the grid we just initialised. A grid resize
    // invalidates the embedded snapshot; honor the resize and drop the stale
    // state (also clear it from the model so subsequent saves don't re-carry
    // the dead bytes). The user explicitly chose new dimensions; we'd rather
    // start fresh than refuse the resize.
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
      if (dimsMatch) {
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
        | { resolve?: () => void; include?: { grid?: boolean; controls?: boolean } }
        | undefined;
      const resolve = detail?.resolve;
      const include = detail?.include ?? { grid: true, controls: true };
      const wantGrid = include.grid !== false;
      const wantControls = include.controls !== false;

      if (!wantGrid && !wantControls) {
        // Nothing to capture — clear any stale embedded state from the model.
        setSimulationState(undefined);
        resolve?.();
        return;
      }
      if (!workerRef.current) { resolve?.(); return; }

      if (!wantGrid) {
        // Controls only: no need to round-trip through the worker.
        const state = serializeSimState(
          {
            generation: 0,
            width: gridWidth.current,
            height: gridHeight.current,
            attributes: {},
            modelAttrs: {}, indicators: {}, linkedAccumulators: {},
            colors: new ArrayBuffer(0),
          },
          { activeViewer, brushColor, brushW, brushH, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens },
          { grid: false, controls: true },
          { boundaryTreatment: model.properties.boundaryTreatment },
        );
        setSimulationState(state);
        resolve?.();
        return;
      }

      pendingStateSave.current = (workerState) => {
        const state = serializeSimState(
          workerState as Parameters<typeof serializeSimState>[0],
          { activeViewer, brushColor, brushW, brushH, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens },
          { grid: wantGrid, controls: wantControls },
          { boundaryTreatment: model.properties.boundaryTreatment },
        );
        setSimulationState(state);
        resolve?.();
      };
      workerRef.current.postMessage({ type: 'getState' });
    };
    window.addEventListener('genesis-capture-sim-state', captureState);
    return () => window.removeEventListener('genesis-capture-sim-state', captureState);
  }, [activeViewer, brushColor, brushW, brushH, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens, setSimulationState]);

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
      || prev.attributes !== model.attributes
      || prev.neighborhoods !== model.neighborhoods
      || prev.mappings !== model.mappings;

    if (needsFullInit) {
      workerRef.current?.terminate();
      workerRef.current = null;
      initWorkerWithDimensions(model.properties.gridWidth, model.properties.gridHeight);
    } else {
      // Graph or indicator watch change only → soft recompile (preserves grid)
      const result = compileGraph(model.graphNodes, model.graphEdges, model);
      setCompiledCode(buildFullCode(result));
      setCompileError(result.error ?? '');
      const wasmResult = (() => {
        try {
          const layout = computeLayoutFromModel(model);
          const viewerIds = buildViewerIds(model);
          return compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, viewerIds);
        } catch (e) {
          return { bytes: new Uint8Array(), minMemoryPages: 1, error: String((e as Error)?.message || e), viewerIds: {}, exports: [] };
        }
      })();
      const webgpuResult = (() => {
        try {
          return compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
        } catch (e) {
          return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: String((e as Error)?.message || e) };
        }
      })();
      workerRef.current?.postMessage({
        type: 'recompile',
        stepCode: result.stepCode,
        inputColorCodes: result.inputColorCodes,
        outputMappingCodes: result.outputMappingCodes || [],
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
            binCount: i.binCount, watched: i.watched,
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
  useEffect(() => { brushMappingRef.current = brushMapping; }, [brushMapping]);
  // Mappings ref lets mouse/keyboard handlers see the latest model.mappings without re-registering.
  const mappingsRef = useRef(model.mappings);
  useEffect(() => { mappingsRef.current = model.mappings; }, [model.mappings]);
  // In-page color popover shown on Modifier+RMB (null = closed).
  // We render our own popover at the cursor because the native <input type="color">
  // picker opens as an OS-managed window anchored to the input's DOM position, which
  // never matches the cursor. The popover's "Full picker" row opens the native picker
  // for users who want the full gradient UI.
  const [colorPopover, setColorPopover] = useState<{ x: number; y: number } | null>(null);

  /** Convert screen coords to grid cell coords */
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
    const col = Math.floor((clientX - rect.left - ox) / scale);
    const row = Math.floor((clientY - rect.top - oy) / scale);
    if (col < 0 || col >= w || row < 0 || row >= h) return null;
    return { row, col };
  }, []);

  /** Parse hex color to RGB */
  const hexToRgb = (hex: string) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };

  /** Collect brush-rect cells around a grid center (no message sent) */
  const brushCellsAt = useCallback((row: number, col: number, r: number, g: number, b: number) => {
    const bw = brushWRef.current;
    const bh = brushHRef.current;
    const cells: Array<{ row: number; col: number; r: number; g: number; b: number }> = [];
    const halfW = Math.floor((bw - 1) / 2);
    const halfH = Math.floor((bh - 1) / 2);
    for (let dr = -halfH; dr <= halfH + ((bh - 1) % 2); dr++) {
      for (let dc = -halfW; dc <= halfW + ((bw - 1) % 2); dc++) {
        cells.push({ row: row + dr, col: col + dc, r, g, b });
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
    workerRef.current?.postMessage({ type: 'paint', cells, mappingId, activeViewer: viewer });
  }, []);

  /** Paint with Bresenham interpolation from last painted position to current */
  const paintAt = useCallback((clientX: number, clientY: number) => {
    const center = screenToGrid(clientX, clientY);
    if (!center) return;
    const { r, g, b } = hexToRgb(brushColorRef.current);
    let allCells: Array<{ row: number; col: number; r: number; g: number; b: number }> = [];
    const prev = lastPaintGrid.current;
    if (prev && (prev.row !== center.row || prev.col !== center.col)) {
      // Bresenham line from prev to center
      let r0 = prev.row, c0 = prev.col;
      const r1 = center.row, c1 = center.col;
      let dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
      const sr = r0 < r1 ? 1 : -1, sc = c0 < c1 ? 1 : -1;
      let err = dc - dr;
      // Skip first point (already painted on previous call)
      while (r0 !== r1 || c0 !== c1) {
        const e2 = 2 * err;
        if (e2 > -dr) { err -= dr; c0 += sc; }
        if (e2 < dc) { err += dc; r0 += sr; }
        allCells = allCells.concat(brushCellsAt(r0, c0, r, g, b));
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
      if (e.ctrlKey) {
        const inputs = mappingsRef.current.filter(m => !m.isAttributeToColor);
        if (inputs.length === 0) return;
        const curIdx = inputs.findIndex(m => m.id === brushMappingRef.current);
        const base = curIdx < 0 ? 0 : curIdx;
        const nextIdx = (base + (e.deltaY > 0 ? 1 : -1) + inputs.length) % inputs.length;
        setBrushMapping(inputs[nextIdx]!.id);
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

    const handleMouseDown = (e: MouseEvent) => {
      // Ignore events from overlay controls (transport bar, viewer bar, etc.)
      const target = e.target as HTMLElement;
      if (target.closest('[data-sim-overlay]')) { canvasBrushActive = false; return; }

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
      } else if (e.button === 2 && (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) {
        // Modifier+RMB = open the in-page brush color popover at the cursor.
        // Any modifier is accepted (Ctrl, Shift, Alt, Meta) because plain Ctrl+RMB
        // gets swallowed on some Windows/Chrome combos (observed on ABNT2/Brazilian
        // layouts where AltGr=Ctrl+Alt works but Ctrl alone does not). Shift+RMB,
        // Alt+RMB, Ctrl+Shift+RMB all work too.
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
      // Update brush cursor position
      const gridPos = screenToGrid(e.clientX, e.clientY);
      cursorGrid.current = gridPos;
      if (!isPanning.current && !(e.buttons & 1) && !isResizingBrush.active) draw();

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

    const handleMouseLeave = () => { cursorGrid.current = null; draw(); };

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('contextmenu', handleContextMenu);
    container.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draw, paintAt, screenToGrid, flushPaintBatch]);

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

  const stopRecording = () => {
    setRecording(false);
    workerRef.current?.postMessage({ type: 'setRecording', enabled: false });
    const frames = recordedFrames.current;
    if (frames.length === 0) return;
    const fw = frames[0]!.width;
    const fh = frames[0]!.height;
    // Downscale large grids to max 512px
    const maxDim = 512;
    let outW = fw, outH = fh;
    if (fw > maxDim || fh > maxDim) {
      const s = maxDim / Math.max(fw, fh);
      outW = Math.round(fw * s);
      outH = Math.round(fh * s);
    }
    const gif = GIFEncoder();
    const delay = Math.round(1000 / (targetFpsRef.current || 30));
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fname = model.properties.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';
    a.href = url;
    a.download = `${fname}_recording.gif`;
    a.click();
    URL.revokeObjectURL(url);
    recordedFrames.current = [];
    recordCountRef.current = 0;
    lastRecordCountSet.current = 0;
    setRecordFrameCount(0);
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

  // F4: Screenshot export — 1:1 pixel-perfect from source canvas (no scaling)
  const handleScreenshot = () => {
    const src = srcCanvasRef.current;
    if (!src) return;
    src.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = model.properties.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';
      a.href = url;
      a.download = `${name}_gen${generationRef.current}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
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

  // Save current state as a named preset (captures modelAttrs always, grid optionally)
  const handleCreatePreset = (name: string, description: string, includeGrid: boolean) => {
    if (!workerRef.current) return;
    pendingStateSave.current = (workerState) => {
      const state = serializePreset(
        workerState as Parameters<typeof serializePreset>[0],
        { includeGrid },
        { boundaryTreatment: model.properties.boundaryTreatment },
      );
      const id = 'preset_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const preset: Preset = { id, name, state, createdAt: Date.now() };
      if (description.trim()) preset.description = description.trim();
      addPreset(preset);
    };
    workerRef.current.postMessage({ type: 'getState' });
  };

  const handleLoadPreset = (p: Preset) => {
    if (playing) setPlaying(false);
    applySimulationState(p.state);
  };

  const handleDeletePreset = (p: Preset) => {
    if (window.confirm(`Delete preset "${p.name}"?`)) {
      deletePreset(p.id);
    }
  };

  // Overwrite preset: same pipeline as create, but dispatches updatePreset instead of addPreset.
  const handleOverwritePreset = (p: Preset) => {
    if (!window.confirm(`Overwrite preset "${p.name}" with the current simulation state?`)) return;
    setPresetOverwriteTarget(p);
  };

  const doOverwritePreset = (target: Preset, name: string, description: string, includeGrid: boolean) => {
    if (!workerRef.current) return;
    pendingStateSave.current = (workerState) => {
      const state = serializePreset(
        workerState as Parameters<typeof serializePreset>[0],
        { includeGrid },
        { boundaryTreatment: model.properties.boundaryTreatment },
      );
      const patch: Partial<Omit<Preset, 'id'>> = { name, state };
      patch.description = description.trim() || undefined;
      updatePreset(target.id, patch);
    };
    workerRef.current.postMessage({ type: 'getState' });
  };

  const applySimulationState = useCallback((state: SimulationState) => {
    if (!workerRef.current) return;

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
    }

    // Restore model-attribute values independently — presets may carry these
    // without any UI controls, so gating on hasControls would silently skip them.
    if (state.modelAttrs) {
      setRuntimeModelAttrs(prev => ({ ...prev, ...state.modelAttrs }));
      workerRef.current?.postMessage({ type: 'updateModelAttrs', attrs: state.modelAttrs });
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
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);

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
            <button className={styles.panelCollapseBtn} onClick={() => setLeftPanelOpen(false)}>&lsaquo;</button>
          </div>
          <div
            className={styles.leftPanelResizeHandle}
            onMouseDown={e => {
              e.preventDefault();
              const panel = leftPanelRef.current;
              if (!panel) return;
              const startX = e.clientX;
              const startW = panel.offsetWidth;
              const onMove = (ev: MouseEvent) => {
                const newW = Math.max(150, Math.min(400, startW + (ev.clientX - startX)));
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

          <div className={styles.sectionTitle}>Actions</div>
          <button className={styles.controlButtonAccent} onClick={handleRandomize}>Randomize</button>
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
      )}

      {/* === Canvas Area === */}
      <div className={styles.canvasArea}>
        {compileError && (
          <div className={styles.errorBanner} data-sim-overlay>
            {compileError}
          </div>
        )}
        {!leftPanelOpen && (
          <button className={styles.panelExpandBtn} style={{ left: 0 }} onClick={() => setLeftPanelOpen(true)} title="Open settings" data-sim-overlay>&rsaquo;</button>
        )}
        <canvas ref={canvasRef} className={styles.canvas} />

        {/* Top-left stats (discreet, no background) */}
        <div className={styles.statsOverlay} data-sim-overlay>
          <span>Gen {generation}</span>
          <span>{gridWidth.current || simWidth}&times;{gridHeight.current || simHeight}</span>
          <span>{actualFps} FPS</span>
          <span>{actualGps} g/s</span>
          {recording && <span style={{ color: '#e05050' }}>{'\u23FA'} REC {recordFrameCount}f</span>}
        </div>

        {/* Top overlay: Viewer tabs */}
        {attrToColorMappings.length > 0 && (
          <div className={styles.viewerBar} data-sim-overlay>
            <span style={{ fontSize: '0.65rem', color: '#6080a0', marginRight: 4, whiteSpace: 'nowrap' }}>Output Mapping (A{'\u2192'}C):</span>
            {attrToColorMappings.map(m => (
              <button
                key={m.id}
                className={`${styles.viewerTab} ${activeViewer === m.id ? styles.viewerTabActive : ''}`}
                onClick={() => setActiveViewer(m.id)}
              >
                {m.name}
              </button>
            ))}
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

        {/* Bottom overlay: Transport controls + speed + stats */}
        <div className={styles.transportBar} data-sim-overlay>
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
            <button className={styles.transportBtn} onClick={startRecording} title="Record GIF" style={{ color: '#e05050' }}>{'\u23FA'}</button>
          ) : (
            <button className={styles.transportBtn} onClick={stopRecording} title="Stop & Save GIF" style={{ color: '#e05050' }}>{'\u23F9'} {recordFrameCount}</button>
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
              const onMove = (ev: MouseEvent) => {
                const newW = Math.max(160, startW - (ev.clientX - startX));
                panel.style.width = newW + 'px';
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
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
            {colorToAttrMappings.length > 0 && (
              <div className={styles.mappingTabs}>
                {colorToAttrMappings.map(m => (
                  <button
                    key={m.id}
                    className={`${styles.mappingTab} ${brushMapping === m.id ? styles.mappingTabActive : ''}`}
                    onClick={() => setBrushMapping(m.id)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            )}
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
            <div className={styles.fieldRow}>
              <span className={styles.statLabel}>W</span>
              <input className={styles.brushInput} type="number" min={1} max={(gridWidth.current || simWidth) * 2} value={brushW}
                onChange={e => setBrushW(Math.max(1, Number(e.target.value) || 1))} />
              <span className={styles.statLabel}>H</span>
              <input className={styles.brushInput} type="number" min={1} max={(gridHeight.current || simHeight) * 2} value={brushH}
                onChange={e => setBrushH(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <hr className={styles.divider} />
            <button className={styles.controlButton} onClick={() => imageInputRef.current?.click()}>
              Open Image
            </button>
            <input ref={imageInputRef} type="file" accept=".png,.bmp,.jpg,.jpeg" style={{ display: 'none' }} onChange={handleImageImport} />
            <label className={styles.checkRow}>
              <input type="checkbox" checked={showBrushCursor} onChange={e => setShowBrushCursor(e.target.checked)} />
              Show brush cursor
            </label>
            <div className={styles.hint}>LMB paint {'\u00B7'} RMB pan {'\u00B7'} Ctrl+LMB drag resize {'\u00B7'} Ctrl+wheel cycle mapping {'\u00B7'} Shift+RMB color</div>
          </div>

          {/* Indicators Section (bottom, fills remaining space) */}
          {(model.indicators || []).length > 0 && (
            <div className={`${styles.rightPanelSection} ${styles.rightSectionIndicators}`}>
              <div className={styles.panelHeader}>
                <span className={styles.panelTitle}>Indicators</span>
              </div>
              <IndicatorDisplay
                indicators={model.indicators || []}
                values={indicatorValuesRef.current}
                history={indicatorHistoryRef.current}
                generation={generation}
                vizModes={indicatorVizModes}
                onToggleWatch={(id, watched) => updateIndicator(id, { watched })}
                onChartToggle={(id, expanded) => {
                  if (expanded) chartExpandedRef.current.add(id);
                  else chartExpandedRef.current.delete(id);
                }}
                onCycleVizMode={cycleIndicatorVizMode}
              />
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
    </div>
  );
}
