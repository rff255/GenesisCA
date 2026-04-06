import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './SimulatorView.module.css';

const GRID_SIZE = 50;
const ALIVE_COLOR = '#4cc9f0';
const DEAD_COLOR = '#0d1b2a';
const GRID_LINE_COLOR = '#162030';

function createRandomGrid(): boolean[][] {
  return Array.from({ length: GRID_SIZE }, () =>
    Array.from({ length: GRID_SIZE }, () => Math.random() > 0.7)
  );
}

export function SimulatorView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [grid, setGrid] = useState(createRandomGrid);
  const [generation] = useState(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = Math.min(canvas.parentElement?.clientWidth ?? 500, canvas.parentElement?.clientHeight ?? 500) - 32;
    canvas.width = size;
    canvas.height = size;

    const cellSize = size / GRID_SIZE;

    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        ctx.fillStyle = grid[row]![col] ? ALIVE_COLOR : DEAD_COLOR;
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }

    // Grid lines
    ctx.strokeStyle = GRID_LINE_COLOR;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= GRID_SIZE; i++) {
      const pos = i * cellSize;
      ctx.beginPath();
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, pos);
      ctx.lineTo(size, pos);
      ctx.stroke();
    }
  }, [grid]);

  useEffect(() => {
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

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
          <span className={styles.statValue}>{GRID_SIZE} x {GRID_SIZE}</span>
        </div>

        <div className={styles.buttonGroup}>
          <button className={styles.controlButton}>Play</button>
          <button className={styles.controlButton}>Pause</button>
        </div>
        <div className={styles.buttonGroup}>
          <button className={styles.controlButton}>Step</button>
          <button className={styles.controlButton}>Reset</button>
        </div>

        <hr className={styles.divider} />

        <button
          className={styles.controlButtonAccent}
          onClick={() => setGrid(createRandomGrid())}
        >
          Randomize
        </button>
      </div>

      <div className={styles.canvasArea}>
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>
    </div>
  );
}
