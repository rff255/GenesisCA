// 3D Grid CA — live neighbourhood preview (drag to orbit).
//
// Reuses the simulator's Gl3DRenderer to show a 3D neighbourhood at a glance:
// the centre cell (amber) + its neighbour offsets (green) inside a small bounded
// box, gently auto-orbiting. Drag with the mouse to orbit manually. Mirrors the
// PLAN_BG_DIMENSIONS_AND_MODES §5 demo.

import { useEffect, useRef } from 'react';
import { Gl3DRenderer } from '../../simulator/render/gl3d';
import type { Coord3 } from './neighborhood3d';

export function NeighborhoodPreview3D({ coords3d, includeCentral }: { coords3d: Coord3[]; includeCentral: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rRef = useRef<Gl3DRenderer | null>(null);
  const camRef = useRef({ yaw: -0.9, pitch: 0.55, dist: 2.6, target: [0, 0, 0] as [number, number, number] });
  const draggingRef = useRef(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    try {
      const r = new Gl3DRenderer(c);
      r.setViz({ axes: true, grid: false, bounds: true, gizmo: true, voxels: true, agents: true });
      rRef.current = r;
    } catch { rRef.current = null; }
    return () => { rRef.current?.dispose(); rRef.current = null; };
  }, []);

  useEffect(() => {
    const r = rRef.current, c = canvasRef.current;
    if (!r || !c) return;
    // Volume just large enough to hold the neighbourhood (centred).
    let maxAbs = 1;
    for (const [dr, dc, dl] of coords3d) maxAbs = Math.max(maxAbs, Math.abs(dr), Math.abs(dc), Math.abs(dl));
    const S = 2 * maxAbs + 1, total = S * S * S, ctr = maxAbs;
    const colors = new Uint8ClampedArray(total * 4);
    const set = (layer: number, row: number, col: number, cr: number, cg: number, cb: number, ca: number) => {
      const i = ((layer * S + row) * S + col) * 4;
      colors[i] = cr; colors[i + 1] = cg; colors[i + 2] = cb; colors[i + 3] = ca;
    };
    for (const [dr, dc, dl] of coords3d) set(ctr + dl, ctr + dr, ctr + dc, 96, 206, 128, 235);  // neighbours: green
    // Centre cell: solid amber when included, faint when not.
    set(ctr, ctr, ctr, 232, 168, 64, includeCentral ? 255 : 90);
    r.setGrid(S, S, S);

    let raf = 0;
    const tick = () => {
      const dpr = window.devicePixelRatio || 1;
      r.resize(c.clientWidth || 220, c.clientHeight || 170, dpr);
      if (!draggingRef.current) camRef.current.yaw += 0.004;
      r.setCamera(camRef.current, r.canvasWidth / (r.canvasHeight || 1));
      r.uploadColors(colors, total);
      r.render();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [coords3d, includeCentral]);

  // Drag to orbit (pauses the auto-spin while dragging).
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    let lastX = 0, lastY = 0;
    const onDown = (e: PointerEvent) => { draggingRef.current = true; lastX = e.clientX; lastY = e.clientY; c.setPointerCapture?.(e.pointerId); e.preventDefault(); };
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const cam = camRef.current;
      cam.yaw -= (e.clientX - lastX) * 0.01;
      cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + (e.clientY - lastY) * 0.01));
      lastX = e.clientX; lastY = e.clientY;
    };
    const onUp = (e: PointerEvent) => { draggingRef.current = false; c.releasePointerCapture?.(e.pointerId); };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); camRef.current.dist = Math.max(0.8, Math.min(8, camRef.current.dist * (e.deltaY > 0 ? 1.1 : 0.9))); };
    c.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      c.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      c.removeEventListener('wheel', onWheel);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      title="Drag to orbit · scroll to zoom"
      style={{ width: '100%', height: 170, borderRadius: 6, background: '#0a0b0e', display: 'block', cursor: 'grab', touchAction: 'none' }}
    />
  );
}
