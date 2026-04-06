import { useCallback, useEffect, useRef, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { SimEngine } from './engine/SimEngine';
import styles from './SimulatorView.module.css';

const DEFAULT_CELL_COLOR = { r: 13, g: 27, b: 43 };

export function SimulatorView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { model } = useModel();
  const engineRef = useRef<SimEngine | null>(null);
  const animFrameRef = useRef<number>(0);
  const [generation, setGeneration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10); // generations per second
  const [compileError, setCompileError] = useState('');
  const [activeViewer, setActiveViewer] = useState('');

  // Initialize engine from model
  useEffect(() => {
    const engine = new SimEngine(model);
    engineRef.current = engine;
    setCompileError(engine.compileError);
    setGeneration(0);
    const firstViewer = model.mappings.find(m => m.isAttributeToColor);
    setActiveViewer(firstViewer?.id ?? '');
  }, [model]);

  // Draw the grid
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (!canvas || !engine) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height, grid, colors } = engine.state;
    const parentW = canvas.parentElement?.clientWidth ?? 500;
    const parentH = canvas.parentElement?.clientHeight ?? 500;
    const maxSize = Math.min(parentW, parentH) - 32;
    const cellSize = Math.max(1, Math.floor(maxSize / Math.max(width, height)));
    const canvasW = cellSize * width;
    const canvasH = cellSize * height;
    canvas.width = canvasW;
    canvas.height = canvasH;

    const viewer = activeViewer;

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const cellColors = colors[idx];
        const c = cellColors?.[viewer] ?? DEFAULT_CELL_COLOR;

        // Fallback: if no viewer colors, use a simple alive-based coloring
        if (!cellColors?.[viewer]) {
          const cell = grid[idx];
          const isAlive = cell && Object.values(cell).some(v => v === true);
          if (isAlive) {
            ctx.fillStyle = '#4cc9f0';
          } else {
            ctx.fillStyle = `rgb(${DEFAULT_CELL_COLOR.r},${DEFAULT_CELL_COLOR.g},${DEFAULT_CELL_COLOR.b})`;
          }
        } else {
          ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
        }
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }

    // Grid lines (only if cells are large enough)
    if (cellSize > 3) {
      ctx.strokeStyle = 'rgba(22, 33, 62, 0.5)';
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= width; i++) {
        ctx.beginPath();
        ctx.moveTo(i * cellSize, 0);
        ctx.lineTo(i * cellSize, canvasH);
        ctx.stroke();
      }
      for (let i = 0; i <= height; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * cellSize);
        ctx.lineTo(canvasW, i * cellSize);
        ctx.stroke();
      }
    }
  }, [activeViewer]);

  // Redraw when generation changes
  useEffect(() => {
    draw();
  }, [generation, draw, activeViewer]);

  // Redraw on resize
  useEffect(() => {
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  // Play loop
  useEffect(() => {
    if (!playing) return;
    const interval = Math.max(16, Math.round(1000 / speed));
    const timer = setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      const ok = engine.step();
      if (ok) {
        setGeneration(engine.state.generation);
      } else {
        setPlaying(false);
      }
    }, interval);
    return () => clearInterval(timer);
  }, [playing, speed]);

  // Cleanup animation frame
  useEffect(() => {
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  const handleStep = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.step();
    setGeneration(engine.state.generation);
  };

  const handleReset = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.reset();
    setGeneration(0);
    setPlaying(false);
  };

  const handleRandomize = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.randomize();
    setGeneration(0);
    setPlaying(false);
    draw();
  };

  const handleRecompile = () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.updateModel(model);
    setCompileError(engine.compileError);
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

        {attrToColorMappings.length > 1 && (
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
      </div>

      <div className={styles.canvasArea}>
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>
    </div>
  );
}
