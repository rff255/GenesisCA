import { useCallback, useEffect, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { SimEngine } from './engine/SimEngine';
import styles from './SimulatorView.module.css';

export function SimulatorView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { model } = useModel();
  const engineRef = useRef<SimEngine | null>(null);
  const rafRef = useRef<number>(0);
  const generationRef = useRef(0);
  const [generation, setGeneration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [compileError, setCompileError] = useState('');
  const [activeViewer, setActiveViewer] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [compiledCode, setCompiledCode] = useState('');

  // Initialize engine from model
  useEffect(() => {
    const engine = new SimEngine(model);
    engineRef.current = engine;
    setCompileError(engine.compileError);
    setCompiledCode(engine.compiledCode);
    setGeneration(0);
    generationRef.current = 0;
    const firstViewer = model.mappings.find(m => m.isAttributeToColor);
    setActiveViewer(firstViewer?.id ?? '');
  }, [model]);

  // Draw using ImageData for performance
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (!canvas || !engine) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height, colors } = engine.state;
    const parentW = canvas.parentElement?.clientWidth ?? 500;
    const parentH = canvas.parentElement?.clientHeight ?? 500;
    const maxSize = Math.min(parentW, parentH) - 32;
    const cellSize = Math.max(1, Math.floor(maxSize / Math.max(width, height)));

    // Render at 1:1 pixel ratio into an offscreen canvas, then scale up
    const canvasW = cellSize * width;
    const canvasH = cellSize * height;
    canvas.width = canvasW;
    canvas.height = canvasH;

    if (cellSize === 1) {
      // Direct ImageData — fastest path
      const imageData = new ImageData(
        new Uint8ClampedArray(colors.buffer, colors.byteOffset, width * height * 4),
        width,
        height,
      );
      ctx.putImageData(imageData, 0, 0);
    } else {
      // Draw 1:1 ImageData to a temp canvas, then scale up
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = width;
      tempCanvas.height = height;
      const tempCtx = tempCanvas.getContext('2d')!;
      const imageData = new ImageData(
        new Uint8ClampedArray(colors.buffer, colors.byteOffset, width * height * 4),
        width,
        height,
      );
      tempCtx.putImageData(imageData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tempCanvas, 0, 0, canvasW, canvasH);
    }
  }, []);

  // Redraw when generation or viewer changes
  useEffect(() => {
    draw();
  }, [generation, draw, activeViewer]);

  // Redraw on resize
  useEffect(() => {
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  // Play loop using requestAnimationFrame
  useEffect(() => {
    if (!playing) return;

    let lastTime = 0;
    const msPerStep = Math.max(1, 1000 / speed);

    const loop = (time: number) => {
      const engine = engineRef.current;
      if (!engine) return;

      if (!lastTime) lastTime = time;
      const elapsed = time - lastTime;

      // Run as many steps as needed to keep up with desired speed
      const stepsToRun = Math.min(Math.floor(elapsed / msPerStep), 10); // cap at 10 per frame
      if (stepsToRun > 0) {
        lastTime += stepsToRun * msPerStep;
        for (let i = 0; i < stepsToRun; i++) {
          const ok = engine.step();
          if (!ok) {
            setPlaying(false);
            return;
          }
        }
        generationRef.current = engine.state.generation;
        draw();
        // Update React state sparingly (every frame, not every step)
        setGeneration(engine.state.generation);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, speed, draw]);

  const handleStep = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.step();
    generationRef.current = engine.state.generation;
    setGeneration(engine.state.generation);
  };

  const handleReset = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.reset();
    generationRef.current = 0;
    setGeneration(0);
    setPlaying(false);
    draw();
  };

  const handleRandomize = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.randomize();
    generationRef.current = 0;
    setGeneration(0);
    setPlaying(false);
    draw();
  };

  const handleRecompile = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.updateModel(model);
    setCompileError(engine.compileError);
    setCompiledCode(engine.compiledCode);
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(compiledCode).catch(() => {
      // Fallback: select text in the code block
    });
  };

  const handleViewerChange = (viewerId: string) => {
    setActiveViewer(viewerId);
    const engine = engineRef.current;
    if (engine) {
      engine.state.activeViewer = viewerId;
      // Re-run colors if we have a step function — for now just redraw
      draw();
    }
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

        <div className={styles.stat}>
          <span className={styles.statLabel}>Speed</span>
          <input
            className={styles.speedInput}
            type="range"
            min={1}
            max={60}
            value={speed}
            onChange={e => setSpeed(Number(e.target.value))}
          />
          <span className={styles.statValue}>{speed}/s</span>
        </div>

        <hr className={styles.divider} />

        <button className={styles.controlButtonAccent} onClick={handleRandomize}>
          Randomize
        </button>
        <button className={styles.controlButton} onClick={handleRecompile}>
          Recompile
        </button>

        {attrToColorMappings.length > 0 && (
          <>
            <hr className={styles.divider} />
            <div className={styles.stat}>
              <span className={styles.statLabel}>Viewer</span>
            </div>
            <select
              className={styles.viewerSelect}
              value={activeViewer}
              onChange={e => handleViewerChange(e.target.value)}
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
