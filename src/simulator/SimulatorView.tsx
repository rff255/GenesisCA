import { useCallback, useEffect, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { compileGraph } from '../modeler/vpl/compiler/compile';
import styles from './SimulatorView.module.css';

export function SimulatorView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { model } = useModel();
  const workerRef = useRef<Worker | null>(null);
  const pendingStep = useRef(false);

  const [generation, setGeneration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [targetFps, setTargetFps] = useState(30);
  const [unlimitedFps, setUnlimitedFps] = useState(false);
  const [gensPerFrame, setGensPerFrame] = useState(1);
  const [unlimitedGens, setUnlimitedGens] = useState(false);
  const [compileError, setCompileError] = useState('');
  const [activeViewer, setActiveViewer] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [compiledCode, setCompiledCode] = useState('');
  const [actualFps, setActualFps] = useState(0);
  const [actualGps, setActualGps] = useState(0);
  const [brushColor, setBrushColor] = useState('#4cc9f0');
  const [brushW, setBrushW] = useState(1);
  const [brushH, setBrushH] = useState(1);
  const [brushMapping, setBrushMapping] = useState('');

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

  // FPS + Gens/s tracking
  const fpsFrames = useRef(0);
  const fpsLastTime = useRef(performance.now());
  const gpsGens = useRef(0);
  const lastGenForGps = useRef(0);

  // 1:1 pixel source canvas (reused across draws)
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Compile graph
  const compileModel = useCallback(() => {
    const result = compileGraph(model.graphNodes, model.graphEdges, model);
    setCompiledCode(result.stepCode);
    setCompileError(result.error ?? '');
    return result;
  }, [model.graphNodes, model.graphEdges]);

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
    });
  }, []);

  // Handle messages from worker
  const onWorkerMessageRef = useRef<(e: MessageEvent) => void>(() => {});
  onWorkerMessageRef.current = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'stepped') {
      colorsRef.current = msg.colors as Uint8ClampedArray;
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

  // Reusable worker initializer (used by useEffect and dimension/image apply)
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
      })),
      neighborhoods: model.neighborhoods.map(n => ({ id: n.id, coords: n.coords })),
      boundaryTreatment: model.properties.boundaryTreatment,
      stepCode: result.stepCode,
      inputColorCodes: result.inputColorCodes,
      activeViewer: viewer,
    });
    workerRef.current = worker;
    setGeneration(0);
    setPlaying(false);
    pendingStep.current = false;
    lastGenForGps.current = 0;
    gpsGens.current = 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, compileModel]);

  // Initialize worker when model changes
  useEffect(() => {
    initWorkerWithDimensions(model.properties.gridWidth, model.properties.gridHeight);
    return () => workerRef.current?.terminate();
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

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        // LMB = pan
        isPanning.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        container.style.cursor = 'grabbing';
      } else if (e.button === 2) {
        // RMB = brush
        e.preventDefault();
        paintAt(e.clientX, e.clientY);
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (e.buttons & 2) {
        // RMB held = brush drag
        paintAt(e.clientX, e.clientY);
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
      container.style.cursor = '';
    };

    // Suppress browser context menu on canvas area
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draw, paintAt]);

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
    const result = compileModel();
    workerRef.current?.postMessage({
      type: 'recompile',
      stepCode: result.stepCode,
      inputColorCodes: result.inputColorCodes,
    });
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(compiledCode).catch(() => {});
  };

  const handleResetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    draw();
  };

  // F3: Update model attribute at runtime
  const handleModelAttrChange = (attrId: string, value: number) => {
    setRuntimeModelAttrs(prev => ({ ...prev, [attrId]: value }));
    workerRef.current?.postMessage({ type: 'updateModelAttrs', attrs: { [attrId]: value } });
  };

  // F4: Screenshot export
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

  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);
  const attrToColorMappings = model.mappings.filter(m => m.isAttributeToColor);
  const colorToAttrMappings = model.mappings.filter(m => !m.isAttributeToColor);

  return (
    <div className={styles.simulatorLayout}>
      <div className={styles.controls}>
        <h3 className={styles.controlsTitle}>Simulation</h3>

        <div className={styles.stat}>
          <span className={styles.statLabel}>Generation</span>
          <span className={styles.statValue}>{generation}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Grid Size</span>
          <span className={styles.statValue}>
            {gridWidth.current || simWidth} x {gridHeight.current || simHeight}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>FPS</span>
          <span className={styles.statValue}>{actualFps}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Gens/s</span>
          <span className={styles.statValue}>{actualGps}</span>
        </div>

        <div className={styles.buttonGroup}>
          <button
            className={styles.controlButton}
            onClick={() => setPlaying(true)}
            disabled={playing}
          >
            Play
          </button>
          <button
            className={styles.controlButton}
            onClick={() => setPlaying(false)}
            disabled={!playing}
          >
            Pause
          </button>
        </div>
        <div className={styles.buttonGroup}>
          <button className={styles.controlButton} onClick={handleStep} disabled={playing}>
            Step
          </button>
          <button className={styles.controlButton} onClick={handleReset}>
            Reset
          </button>
        </div>

        <hr className={styles.divider} />

        <div className={styles.stat}>
          <span className={styles.statLabel}>Target FPS</span>
          <span className={styles.statValue}>{unlimitedFps ? '\u221E' : targetFps}</span>
        </div>
        <input
          className={styles.speedInput}
          type="range"
          min={1}
          max={200}
          value={targetFps}
          disabled={unlimitedFps}
          onChange={e => setTargetFps(Number(e.target.value))}
        />
        <label className={styles.checkRow}>
          <input type="checkbox" checked={unlimitedFps} onChange={e => setUnlimitedFps(e.target.checked)} />
          Unlimited
        </label>

        <div className={styles.stat}>
          <span className={styles.statLabel}>Gens / Frame</span>
          <span className={styles.statValue}>{unlimitedGens ? '\u221E' : gensPerFrame}</span>
        </div>
        <input
          className={styles.speedInput}
          type="range"
          min={1}
          max={200}
          value={gensPerFrame}
          disabled={unlimitedGens}
          onChange={e => setGensPerFrame(Number(e.target.value))}
        />
        <label className={styles.checkRow}>
          <input type="checkbox" checked={unlimitedGens} onChange={e => setUnlimitedGens(e.target.checked)} />
          Unlimited
        </label>

        <hr className={styles.divider} />

        <button className={styles.controlButtonAccent} onClick={handleRandomize}>
          Randomize
        </button>
        <div className={styles.buttonGroup}>
          <button className={styles.controlButton} onClick={handleRecompile}>
            Recompile
          </button>
          <button className={styles.controlButton} onClick={handleResetView}>
            Fit
          </button>
        </div>
        <div className={styles.buttonGroup}>
          <button
            className={styles.controlButton}
            onClick={handleScreenshot}
            disabled={!colorsRef.current}
          >
            Screenshot
          </button>
          {colorToAttrMappings.length > 0 && (
            <button
              className={styles.controlButton}
              onClick={() => imageInputRef.current?.click()}
            >
              Import Image
            </button>
          )}
          <input
            ref={imageInputRef}
            type="file"
            accept=".png,.bmp,.jpg,.jpeg"
            style={{ display: 'none' }}
            onChange={handleImageImport}
          />
        </div>

        <hr className={styles.divider} />

        <div className={styles.sectionTitle}>Grid Dimensions</div>
        <div className={styles.fieldRow}>
          <span className={styles.statLabel}>W</span>
          <input
            className={styles.brushInput}
            type="number"
            min={1}
            value={simWidth}
            onChange={e => setSimWidth(Math.max(1, Number(e.target.value) || 1))}
          />
          <span className={styles.statLabel}>H</span>
          <input
            className={styles.brushInput}
            type="number"
            min={1}
            value={simHeight}
            onChange={e => setSimHeight(Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <button className={styles.controlButton} onClick={handleApplyDimensions}>
          Apply Dimensions
        </button>

        {modelAttrs.length > 0 && (
          <>
            <hr className={styles.divider} />
            <div className={styles.sectionTitle}>Model Attributes</div>
            {modelAttrs.map(a => (
              <div key={a.id} className={styles.fieldRow}>
                <span className={styles.statLabel} style={{ flex: 1 }}>{a.name}</span>
                {a.type === 'bool' ? (
                  <input
                    type="checkbox"
                    checked={(runtimeModelAttrs[a.id] ?? 0) === 1}
                    onChange={e => handleModelAttrChange(a.id, e.target.checked ? 1 : 0)}
                  />
                ) : (
                  <input
                    className={styles.brushInput}
                    type="number"
                    step={a.type === 'integer' ? 1 : 'any'}
                    value={runtimeModelAttrs[a.id] ?? 0}
                    onChange={e => handleModelAttrChange(a.id, Number(e.target.value) || 0)}
                  />
                )}
              </div>
            ))}
          </>
        )}

        <hr className={styles.divider} />

        <div className={styles.sectionTitle}>Brush (Right-click)</div>
        <div className={styles.fieldRow}>
          <span className={styles.statLabel}>Color</span>
          <input
            type="color"
            className={styles.colorPicker}
            value={brushColor}
            onChange={e => setBrushColor(e.target.value)}
          />
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.statLabel}>W</span>
          <input
            className={styles.brushInput}
            type="number"
            min={1}
            max={50}
            value={brushW}
            onChange={e => setBrushW(Math.max(1, Number(e.target.value) || 1))}
          />
          <span className={styles.statLabel}>H</span>
          <input
            className={styles.brushInput}
            type="number"
            min={1}
            max={50}
            value={brushH}
            onChange={e => setBrushH(Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        {colorToAttrMappings.length > 0 && (
          <>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Input Mapping</span>
            </div>
            <select
              className={styles.viewerSelect}
              value={brushMapping}
              onChange={e => setBrushMapping(e.target.value)}
            >
              <option value="">(fallback)</option>
              {colorToAttrMappings.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </>
        )}
        <div className={styles.hint}>LMB: pan / scroll: zoom / RMB: brush</div>

        {attrToColorMappings.length > 0 && (
          <>
            <hr className={styles.divider} />
            <div className={styles.stat}>
              <span className={styles.statLabel}>Viewer</span>
            </div>
            <select
              className={styles.viewerSelect}
              value={activeViewer}
              onChange={e => setActiveViewer(e.target.value)}
            >
              {attrToColorMappings.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </>
        )}

        {compileError && (
          <>
            <hr className={styles.divider} />
            <div className={styles.error}>{compileError}</div>
          </>
        )}

        <hr className={styles.divider} />
        <button
          className={styles.controlButton}
          onClick={() => setShowCode(!showCode)}
        >
          {showCode ? 'Hide' : 'Show'} Generated Code
        </button>
        {showCode && (
          <div className={styles.codePanel}>
            <button className={styles.copyButton} onClick={handleCopyCode}>
              Copy
            </button>
            <pre className={styles.codeBlock}>
              {compiledCode || '(no compiled code)'}
            </pre>
          </div>
        )}
      </div>

      <div className={styles.canvasArea}>
        <canvas ref={canvasRef} className={styles.canvas} />
        {playing && unlimitedGens && (
          <div className={styles.overlay}>
            Processing without displaying. Change &lsquo;Gens/Frame&rsquo; value to see evolution of the cell states.
          </div>
        )}
      </div>
    </div>
  );
}
