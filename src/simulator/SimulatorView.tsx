import { useCallback, useEffect, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { compileGraph } from '../modeler/vpl/compiler/compile';
import styles from './SimulatorView.module.css';

export function SimulatorView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { model } = useModel();
  const workerRef = useRef<Worker | null>(null);
  const rafRef = useRef<number>(0);
  const pendingStep = useRef(false);

  const [generation, setGeneration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [targetFps, setTargetFps] = useState(30);
  const [gensPerFrame, setGensPerFrame] = useState(1);
  const [compileError, setCompileError] = useState('');
  const [activeViewer, setActiveViewer] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [compiledCode, setCompiledCode] = useState('');
  const [actualFps, setActualFps] = useState(0);
  const [actualGps, setActualGps] = useState(0);

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
    const result = compileGraph(model.graphNodes, model.graphEdges);
    setCompiledCode(result.code);
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

    // FPS + Gens/s tracking
    fpsFrames.current++;
    const now = performance.now();
    if (now - fpsLastTime.current >= 1000) {
      setActualFps(fpsFrames.current);
      setActualGps(gpsGens.current);
      fpsFrames.current = 0;
      gpsGens.current = 0;
      fpsLastTime.current = now;
    }
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
      setGeneration(gen);
      pendingStep.current = false;
      draw();
    } else if (msg.type === 'error') {
      setCompileError(msg.message as string);
      pendingStep.current = false;
    } else if (msg.type === 'ready') {
      pendingStep.current = false;
    }
  };

  // Initialize worker when model changes
  useEffect(() => {
    workerRef.current?.terminate();
    const { code, error } = compileModel();
    const firstViewer = model.mappings.find(m => m.isAttributeToColor);
    const viewer = firstViewer?.id ?? '';
    setActiveViewer(viewer);
    if (error) setCompileError(error);

    gridWidth.current = model.properties.gridWidth;
    gridHeight.current = model.properties.gridHeight;
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };

    const worker = new Worker(
      new URL('./engine/sim.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e) => onWorkerMessageRef.current(e);
    worker.postMessage({
      type: 'init',
      width: model.properties.gridWidth,
      height: model.properties.gridHeight,
      attributes: model.attributes.map(a => ({
        id: a.id, type: a.type,
        isModelAttribute: a.isModelAttribute, defaultValue: a.defaultValue,
      })),
      neighborhoods: model.neighborhoods.map(n => ({ id: n.id, coords: n.coords })),
      boundaryTreatment: model.properties.boundaryTreatment,
      compiledCode: code,
      activeViewer: viewer,
    });
    workerRef.current = worker;
    setGeneration(0);
    setPlaying(false);
    pendingStep.current = false;
    lastGenForGps.current = 0;
    gpsGens.current = 0;

    return () => worker.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, compileModel]);

  // Resize handler
  useEffect(() => {
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  // Zoom/Pan event handlers on canvas area
  useEffect(() => {
    const container = canvasRef.current?.parentElement;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(0.1, Math.min(50, oldZoom * zoomFactor));

      // Zoom toward mouse position
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
      if (e.button === 0 || e.button === 1) { // left or middle click
        isPanning.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        container.style.cursor = 'grabbing';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
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

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draw]);

  // Play loop
  useEffect(() => {
    if (!playing) return;

    let lastFrameTime = 0;
    const msPerFrame = 1000 / targetFps;

    const loop = (time: number) => {
      if (!lastFrameTime) lastFrameTime = time;
      const elapsed = time - lastFrameTime;

      if (elapsed >= msPerFrame && !pendingStep.current) {
        lastFrameTime = time;
        pendingStep.current = true;
        workerRef.current?.postMessage({
          type: 'step',
          count: gensPerFrame,
          activeViewer,
        });
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, targetFps, gensPerFrame, activeViewer]);

  // Cleanup
  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

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
    const { code } = compileModel();
    workerRef.current?.postMessage({ type: 'recompile', compiledCode: code });
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(compiledCode).catch(() => {});
  };

  const handleResetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    draw();
  };

  const attrToColorMappings = model.mappings.filter(m => m.isAttributeToColor);

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
            {model.properties.gridWidth} x {model.properties.gridHeight}
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
          <span className={styles.statValue}>{targetFps}</span>
        </div>
        <input
          className={styles.speedInput}
          type="range"
          min={1}
          max={60}
          value={targetFps}
          onChange={e => setTargetFps(Number(e.target.value))}
        />

        <div className={styles.stat}>
          <span className={styles.statLabel}>Gens / Frame</span>
          <span className={styles.statValue}>{gensPerFrame}</span>
        </div>
        <input
          className={styles.speedInput}
          type="range"
          min={1}
          max={100}
          value={gensPerFrame}
          onChange={e => setGensPerFrame(Number(e.target.value))}
        />

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
      </div>
    </div>
  );
}
