/**
 * Scene-anchored 3D wireframe geometry — the bounds box, the floor grid and the
 * origin axes — shared by BOTH worker-side WGSL renderers (the L1 voxel pass in
 * webgpuRuntime.ts and the Phase C agent-sphere pass in agentWebgpuRuntime.ts).
 *
 * WHY IT IS SHARED: in FREE mode the worker owns these wireframes and draws them
 * depth-tested against its own scene (so voxels / spheres in front occlude them);
 * in FRAME mode gl3d draws the SAME three groups from `renderOverlays`. The
 * free↔frame flip must not move a single line, so there is exactly ONE geometry
 * builder for the worker side and it mirrors gl3d's `renderOverlays` EXACTLY
 * (same Z-up remap, same colours, same >100-cell grid step, same origin-corner
 * axes with 2-pronged arrowheads, same grid-scaled extension/arrowhead length).
 *
 * ⚠ Any edit here MUST land in gl3d's `renderOverlays` (and its `renderAxisLabels`
 * ext) in the same change — the two are a documented lockstep pair.
 */

export interface SceneViz { axes: boolean; grid: boolean; bounds: boolean }

/** Build the bounds / grid / axes line-list vertices (pos.xyz + colour.rgb per
 *  vertex, 6 floats each). Each `viz` flag gates its group; all-off ⇒ empty. */
export function buildSceneWireframeVerts(W: number, H: number, D: number, viz: SceneViz): Float32Array {
  const hx = (W - 1) / 2, hy = (H - 1) / 2, hz = (D - 1) / 2;
  const x0 = -hx - 0.5, x1 = hx + 0.5, y0 = -hy - 0.5, y1 = hy + 0.5, z0 = -hz - 0.5, z1 = hz + 0.5;
  const v: number[] = [];
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number) =>
    v.push(ax, ay, az, r, g, b, bx, by, bz, r, g, b);
  if (viz.grid) {
    const c = 0.26, g = 0.28, bl = 0.34;
    const sx = Math.max(1, Math.ceil(W / 100)), sy = Math.max(1, Math.ceil(H / 100));
    for (let i = 0; i <= W; i += sx) { const x = x0 + i; seg(x, y0, z0, x, y1, z0, c, g, bl); }
    for (let j = 0; j <= H; j += sy) { const y = y0 + j; seg(x0, y, z0, x1, y, z0, c, g, bl); }
  }
  if (viz.bounds) {
    const c = 0.42, g = 0.45, bl = 0.55;
    seg(x0, y0, z0, x1, y0, z0, c, g, bl); seg(x1, y0, z0, x1, y1, z0, c, g, bl);
    seg(x1, y1, z0, x0, y1, z0, c, g, bl); seg(x0, y1, z0, x0, y0, z0, c, g, bl);
    seg(x0, y0, z1, x1, y0, z1, c, g, bl); seg(x1, y0, z1, x1, y1, z1, c, g, bl);
    seg(x1, y1, z1, x0, y1, z1, c, g, bl); seg(x0, y1, z1, x0, y0, z1, c, g, bl);
    seg(x0, y0, z0, x0, y0, z1, c, g, bl); seg(x1, y0, z0, x1, y0, z1, c, g, bl);
    seg(x1, y1, z0, x1, y1, z1, c, g, bl); seg(x0, y1, z0, x0, y1, z1, c, g, bl);
  }
  if (viz.axes) {
    // Origin = cell (0,0,0)'s world centre (the volume CORNER): col→+X, row→−Y,
    // depth→−Z. cell(0,0,0) world = (-hx, +hy, +hz). Draw each axis toward its
    // positive direction + a 2-pronged arrowhead (identical to gl3d renderOverlays).
    const ox = -hx, oy = hy, oz = hz;
    // Extension + arrowhead scale with the grid — MUST stay byte-identical to
    // gl3d's renderOverlays (the free/frame flip must not move the axes).
    const maxDim = Math.max(W, H, D);
    const ext = 1.2 + maxDim * 0.02;
    const axis = (ex: number, ey: number, ez: number, r: number, g: number, b: number) => {
      seg(ox, oy, oz, ex, ey, ez, r, g, b);
      const dx = ex - ox, dy = ey - oy, dz = ez - oz;
      const len = Math.hypot(dx, dy, dz) || 1;
      const ux = dx / len, uy = dy / len, uz = dz / len;
      let px = -uy, py = ux, pz = 0;
      if (Math.hypot(px, py, pz) < 0.1) { px = 0; py = -uz; pz = uy; }
      const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
      const hl = 0.7 + maxDim * 0.025;
      seg(ex, ey, ez, ex - ux * hl + px * hl * 0.5, ey - uy * hl + py * hl * 0.5, ez - uz * hl + pz * hl * 0.5, r, g, b);
      seg(ex, ey, ez, ex - ux * hl - px * hl * 0.5, ey - uy * hl - py * hl * 0.5, ez - uz * hl - pz * hl * 0.5, r, g, b);
    };
    axis(hx + ext, oy, oz, 0.90, 0.27, 0.27);                 // +col → +X (red)
    axis(ox, -hy - ext, oz, 0.34, 0.82, 0.40);                // +row → -Y (green)
    axis(ox, oy, oz - (D - 1) - ext, 0.36, 0.55, 0.95);       // +depth → -Z (blue)
  }
  return new Float32Array(v);
}
