import { useCallback, useEffect, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { compileGraph } from '../modeler/vpl/compiler/compile';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { IndicatorDisplay } from './IndicatorDisplay';
import styles from './SimulatorView.module.css';

const SIM_SETTINGS_KEY = 'genesisca_sim_settings';

function loadSimSettings(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SIM_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

export function SimulatorView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { model, updateIndicator } = useModel();
  const workerRef = useRef<Worker | null>(null);
  const pendingStep = useRef(false);

  const saved = useRef(loadSimSettings());

  const [generation, setGeneration] = useState(0);
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
  const indicatorHistoryRef = useRef<Record<string, number[]>>({});
  const chartExpandedRef = useRef<Set<string>>(new Set());

  // GIF recording state
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const recordedFrames = useRef<ImageData[]>([]);
  const [recordFrameCount, setRecordFrameCount] = useState(0);
  useEffect(() => { recordingRef.current = recording; }, [recording]);

  // Persist simulator settings
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(SIM_SETTINGS_KEY, JSON.stringify({
          targetFps, unlimitedFps, gensPerFrame, unlimitedGens,
          activeViewer, brushColor, brushW, brushH, brushMapping, showBrushCursor, showGridlines,
        }));
      } catch { /* localStorage full */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [targetFps, unlimitedFps, gensPerFrame, unlimitedGens, activeViewer, brushColor, brushW, brushH, brushMapping, showBrushCursor, showGridlines]);

  // F3: Runtime model attribute values
  const [runtimeModelAttrs, setRuntimeModelAttrs] = useState<Record<string, number>>({});

  // F5: Simulator dimension overrides
  const [simWidth, setSimWidth] = useState(100);
  const [simHeight, setSimHeight] = useState(100);

  // F6: Image import pending state
  const pendingImageImport = useRef<Uint8ClampedArray | null>(null);
  const pendingImageMapping = useRef<string>('');
  const imageInputRef = useRef<HTMLInputElement>(null);

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

  // FPS + Gens/s tracking
  const fpsFrames = useRef(0);
  const fpsLastTime = useRef(performance.now());
  const gpsGens = useRef(0);
  const lastGenForGps = useRef(0);

  // 1:1 pixel source canvas (reused across draws)
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Compile graph (deps include indicator watched state since it affects compiled code)
  const compileModel = useCallback(() => {
    const result = compileGraph(model.graphNodes, model.graphEdges, model);
    setCompiledCode(result.stepCode);
    setCompileError(result.error ?? '');
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.graphNodes, model.graphEdges, model.indicators]);

  // Draw using ImageData + zoom/pan transform
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const colors = colorsRef.current;
    const w = gridWidth.current;
    const h = gridHeight.current;
    if (!canvas || !colors || !w || !h) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Canvas fills available space
    const parentW = canvas.parentElement?.clientWidth ?? 500;
    const parentH = canvas.parentElement?.clientHeight ?? 500;
    canvas.width = parentW;
    canvas.height = parentH;

    // Build 1:1 pixel source from RGBA buffer
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

    ctx.drawImage(srcCanvasRef.current, ox, oy, scaledW, scaledH);

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
  const nextStepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlimitedFpsRef = useRef(false);
  const unlimitedGensRef = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { gensPerFrameRef.current = unlimitedGens ? 100 : gensPerFrame; }, [gensPerFrame, unlimitedGens]);
  useEffect(() => { targetFpsRef.current = unlimitedFps ? 999999 : targetFps; }, [targetFps, unlimitedFps]);
  useEffect(() => { unlimitedFpsRef.current = unlimitedFps; }, [unlimitedFps]);
  useEffect(() => { unlimitedGensRef.current = unlimitedGens; }, [unlimitedGens]);

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
        // Collect history for indicators with expanded charts (scalar values only)
        const expanded = chartExpandedRef.current;
        if (expanded.size > 0) {
          const hist = indicatorHistoryRef.current;
          for (const id of expanded) {
            const v = msg.indicators[id];
            if (typeof v === 'number') {
              let arr = hist[id];
              if (!arr) { arr = []; hist[id] = arr; }
              arr.push(v);
              if (arr.length > 500) arr.shift();
            }
          }
        }
      }
      const gen = msg.generation as number;
      gpsGens.current += gen - lastGenForGps.current;
      lastGenForGps.current = gen;

      pendingStep.current = false;

      // Update metrics (runs on every result, even without drawing)
      const now = performance.now();
      if (now - fpsLastTime.current >= 1000) {
        setActualFps(fpsFrames.current);
        setActualGps(gpsGens.current);
        fpsFrames.current = 0;
        gpsGens.current = 0;
        fpsLastTime.current = now;
      }

      if (unlimitedGensRef.current && playingRef.current) {
        // Unlimited gens: skip drawing, update generation counter periodically
        if (now - lastDrawTime.current >= 500) {
          lastDrawTime.current = now;
          setGeneration(gen);
        }
        sendNextStep();
      } else {
        // Normal: draw every result
        setGeneration(gen);
        draw();

        // GIF frame capture
        if (recordingRef.current && srcCanvasRef.current) {
          const src = srcCanvasRef.current;
          const sctx = src.getContext('2d');
          if (sctx) {
            recordedFrames.current.push(sctx.getImageData(0, 0, src.width, src.height));
            setRecordFrameCount(c => c + 1);
          }
        }

        // Schedule next step to maintain targetFps rate
        if (playingRef.current) {
          const msPerFrame = 1000 / targetFpsRef.current;
          const elapsed = performance.now() - lastStepSentTime.current;
          const delay = Math.max(0, msPerFrame - elapsed);

          if (delay <= 1) {
            sendNextStep();
          } else {
            if (nextStepTimer.current) clearTimeout(nextStepTimer.current);
            nextStepTimer.current = setTimeout(sendNextStep, delay);
          }
        }
      }
    } else if (msg.type === 'error') {
      setCompileError(msg.message as string);
      pendingStep.current = false;
    } else if (msg.type === 'ready') {
      pendingStep.current = false;
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
    worker.postMessage({
      type: 'init',
      width: w,
      height: h,
      attributes: model.attributes.map(a => ({
        id: a.id, type: a.type,
        isModelAttribute: a.isModelAttribute, defaultValue: a.defaultValue,
        tagOptions: a.tagOptions,
      })),
      neighborhoods: model.neighborhoods.map(n => ({ id: n.id, coords: n.coords })),
      boundaryTreatment: model.properties.boundaryTreatment,
      updateMode: model.properties.updateMode || 'synchronous',
      asyncScheme: model.properties.asyncScheme || 'random-order',
      stepCode: result.stepCode,
      inputColorCodes: result.inputColorCodes,
      outputMappingCodes: result.outputMappingCodes,
      activeViewer: viewer,
      indicators: (model.indicators || []).map(i => ({
        id: i.id, kind: i.kind, dataType: i.dataType,
        defaultValue: i.defaultValue, accumulationMode: i.accumulationMode,
        tagOptions: i.tagOptions,
        linkedAttributeId: i.linkedAttributeId,
        linkedAggregation: i.linkedAggregation,
        binCount: i.binCount, watched: i.watched,
      })),
    });
    workerRef.current = worker;
    setGeneration(0);
    setPlaying(false);
    indicatorValuesRef.current = {};
    indicatorHistoryRef.current = {};
    pendingStep.current = false;
    lastGenForGps.current = 0;
    gpsGens.current = 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, compileModel]);

  // Terminate worker on unmount only (not on re-renders)
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

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
      setCompiledCode(result.stepCode);
      setCompileError(result.error ?? '');
      workerRef.current?.postMessage({
        type: 'recompile',
        stepCode: result.stepCode,
        inputColorCodes: result.inputColorCodes,
        outputMappingCodes: result.outputMappingCodes || [],
        updateMode: model.properties.updateMode,
        asyncScheme: model.properties.asyncScheme,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, compileModel]);

  // Resize handler
  useEffect(() => {
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

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
  const showBrushCursorRef = useRef(true);
  useEffect(() => { showBrushCursorRef.current = showBrushCursor; }, [showBrushCursor]);
  const showGridlinesRef = useRef(false);
  useEffect(() => { showGridlinesRef.current = showGridlines; }, [showGridlines]);
  useEffect(() => { brushMappingRef.current = brushMapping; }, [brushMapping]);

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

  /** Send paint message for cells in brush rect around center */
  const paintAt = useCallback((clientX: number, clientY: number) => {
    const center = screenToGrid(clientX, clientY);
    if (!center) return;
    const bw = brushWRef.current;
    const bh = brushHRef.current;
    const { r, g, b } = hexToRgb(brushColorRef.current);
    const cells: Array<{ row: number; col: number; r: number; g: number; b: number }> = [];
    const halfW = Math.floor((bw - 1) / 2);
    const halfH = Math.floor((bh - 1) / 2);
    for (let dr = -halfH; dr <= halfH + ((bh - 1) % 2); dr++) {
      for (let dc = -halfW; dc <= halfW + ((bw - 1) % 2); dc++) {
        cells.push({ row: center.row + dr, col: center.col + dc, r, g, b });
      }
    }
    workerRef.current?.postMessage({ type: 'paint', cells, mappingId: brushMappingRef.current, activeViewer: activeViewerRef.current });
  }, [screenToGrid]);

  // Zoom/Pan/Brush event handlers
  useEffect(() => {
    const container = canvasRef.current?.parentElement;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-sim-overlay]')) return;
      e.preventDefault();
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
        // LMB = brush
        canvasBrushActive = true;
        paintAt(e.clientX, e.clientY);
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
  }, [draw, paintAt, screenToGrid]);

  // Play: kick-start the step pipeline (worker message handler chains subsequent steps)
  useEffect(() => {
    if (playing) {
      sendNextStep();
    } else {
      // Stop: cancel any pending timer
      if (nextStepTimer.current) { clearTimeout(nextStepTimer.current); nextStepTimer.current = null; }
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

  const startRecording = () => {
    recordedFrames.current = [];
    setRecordFrameCount(0);
    setRecording(true);
  };

  const stopRecording = () => {
    setRecording(false);
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

  // Simulator keyboard shortcuts (Space=step, Enter=play/pause, Esc=reset)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === ' ') { e.preventDefault(); handleStep(); }
      else if (e.key === 'Enter') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === 'Escape') { handleReset(); }
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
      a.download = `${name}_gen${generation}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

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
  const rightPanelRef = useRef<HTMLDivElement>(null);

  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);
  const attrToColorMappings = model.mappings.filter(m => m.isAttributeToColor);
  const colorToAttrMappings = model.mappings.filter(m => !m.isAttributeToColor);

  return (
    <div className={styles.simulatorLayout}>
      {/* === Left Panel (collapsible) === */}
      {leftPanelOpen && (
        <div className={styles.sidePanel}>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Settings</span>
            <button className={styles.panelCollapseBtn} onClick={() => setLeftPanelOpen(false)}>&lsaquo;</button>
          </div>

          <div className={styles.sectionTitle}>Actions</div>
          <button className={styles.controlButtonAccent} onClick={handleRandomize}>Randomize</button>

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

          {modelAttrs.length > 0 && (
            <>
              <hr className={styles.divider} />
              <div className={styles.sectionTitle}>Model Attributes</div>
              {modelAttrs.map(a => (
                <div key={a.id} className={styles.fieldRow}>
                  <span className={styles.statLabel} style={{ flex: 1 }}>{a.name}</span>
                  {a.type === 'bool' ? (
                    <input type="checkbox" checked={(runtimeModelAttrs[a.id] ?? 0) === 1}
                      onChange={e => handleModelAttrChange(a.id, e.target.checked ? 1 : 0)} />
                  ) : a.type === 'integer' ? (
                    <input className={styles.brushInput} type="number" step={1}
                      value={runtimeModelAttrs[a.id] ?? 0}
                      onChange={e => handleModelAttrChange(a.id, Math.round(Number(e.target.value) || 0))} />
                  ) : a.type === 'float' ? (
                    <input className={styles.brushInput} type="number" step="any"
                      value={runtimeModelAttrs[a.id] ?? 0}
                      onChange={e => handleModelAttrChange(a.id, Number(e.target.value) || 0)} />
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

        {/* Bottom overlay: Transport controls + speed + stats */}
        <div className={styles.transportBar} data-sim-overlay>
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
            <div className={styles.hint}>LMB: paint / RMB: pan / Ctrl+LMB drag: resize brush</div>
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
                onToggleWatch={(id, watched) => updateIndicator(id, { watched })}
                onChartToggle={(id, expanded) => {
                  if (expanded) chartExpandedRef.current.add(id);
                  else chartExpandedRef.current.delete(id);
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
