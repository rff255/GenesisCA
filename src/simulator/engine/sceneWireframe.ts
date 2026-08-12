/**
 * Scene-anchored 3D wireframe geometry — the bounds box, the floor grid, the
 * origin axes and the BRUSH INTERACTION PLANE — shared by BOTH worker-side WGSL
 * renderers (the L1 voxel pass in webgpuRuntime.ts and the Phase C agent-sphere
 * pass in agentWebgpuRuntime.ts) AND by gl3d itself.
 *
 * WHY IT IS SHARED: in FREE mode the worker owns this geometry and draws it
 * depth-tested against its own scene (so voxels / spheres in front occlude it);
 * in FRAME mode gl3d draws the SAME groups from `renderOverlays` /
 * `renderBrushPlane`. The free↔frame flip must not move a single line, so there
 * is exactly ONE geometry builder per group. `buildSceneWireframeVerts` mirrors
 * gl3d's `renderOverlays` EXACTLY (same Z-up remap, same colours, same >100-cell
 * grid step, same origin-corner axes with 2-pronged arrowheads, same grid-scaled
 * extension/arrowhead length); `buildBrushPlaneVerts` IS what gl3d's
 * `renderBrushPlane` calls, so that one cannot drift at all.
 *
 * ⚠ Any edit to `buildSceneWireframeVerts` MUST land in gl3d's `renderOverlays`
 * (and its `renderAxisLabels` ext) in the same change — those two are a
 * documented lockstep pair. The same goes for the DRAW STATE: see
 * `SCENE_MSAA_SAMPLES` below, which the two worker passes must rasterize at.
 *
 * WHAT IS **NOT** HERE, deliberately: the always-on-top brush CURSOR visuals —
 * the amber footprint outline, the hovered/inspected cell cubes, the axis labels
 * and the corner gizmo. Those are UI that must stay visible THROUGH the scene, so
 * gl3d keeps drawing them (depth test off) on the overlay canvas in both modes.
 * Only geometry that sits at a definite place IN the volume belongs in this file.
 */

/**
 * THE ONE DRAW-STATE CONSTANT THE THREE RENDERERS MUST SHARE — the multisample
 * count the scene geometry is rasterized at.
 *
 * Sharing the GEOMETRY is not enough to make the free↔frame flip seamless: the
 * same 1-pixel line looks materially different depending on whether it is
 * multisampled. gl3d's WebGL2 context is created with `antialias: true`, which on
 * this hardware resolves to 4× MSAA; the two worker WGSL passes were left at the
 * WebGPU default of sampleCount 1, so flipping modes changed the wireframes'
 * brightness (the reported "moving the cursor out and back to the canvas makes
 * the Grid change its brightness").
 *
 * MEASURED on Particle Life 3D's floor grid — the SAME 274 vertices through the
 * SAME MVP, 500×500, once with `antialias: true` and once with `antialias: false`:
 *
 *   antialias:true   38 493 lit px, 48 % fully covered, mean alpha 198.15/255,
 *                    Σalpha 7 627 274, alphas {255, 191, 127, 64} (= 4/4…1/4)
 *   antialias:false  20 420 lit px, 100 % fully covered, mean alpha 255,
 *                    Σalpha 5 207 100
 *
 * i.e. 1.9× the lit pixels and +46 % total emitted light. Rendering both sides at
 * this sample count removes it.
 *
 * WHY 4: WebGPU core guarantees sampleCount 1 and 4 only, and 4 is what WebGL's
 * `antialias: true` picks on the overwhelmingly common configuration. A driver
 * that chooses a different WebGL sample count leaves a small residual — vastly
 * smaller than the 1-vs-4 gap this closes — and there is no portable way to ask
 * WebGPU for it.
 */
export const SCENE_MSAA_SAMPLES = 4;

export interface SceneViz { axes: boolean; grid: boolean; bounds: boolean }

/** The brush interaction plane: an axis-aligned slice at a cell index. */
export interface BrushPlaneSpec { axis: 'x' | 'y' | 'z'; pos: number }

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

/** Build the brush interaction plane's line list: a bright bounded rectangle on
 *  the slice the brush paints into, plus a dimmer interior grid, so the user sees
 *  exactly where the plane sits IN the volume.
 *
 *  ⚠ THE WHOLE PLANE — rectangle AND interior grid — is depth-tested scene
 *  geometry on every path: cells/agents in FRONT of the slice occlude it. It is
 *  NOT cursor UI (that is the amber footprint outline, which stays always-on-top),
 *  and treating it as such is exactly the reported bug this shared builder fixes:
 *  in free mode gl3d drew the plane onto the transparent overlay canvas ABOVE the
 *  worker's scene, which has no shared depth buffer, so it always painted in front.
 *
 *  Lines only — the plane has no filled surface on any path, so both worker line
 *  pipelines take this verbatim with no blended triangle pass.
 *
 *  Same Z-up remap as the wireframes: col→+X, row→−Y, layer→−Z. */
export function buildBrushPlaneVerts(W: number, H: number, D: number, p: BrushPlaneSpec): Float32Array {
  const hx = (W - 1) / 2, hy = (H - 1) / 2, hz = (D - 1) / 2;
  const x0 = -hx - 0.5, x1 = hx + 0.5, y0 = -hy - 0.5, y1 = hy + 0.5, z0 = -hz - 0.5, z1 = hz + 0.5;
  const v: number[] = [];
  // bright edge colour + dimmer interior grid (cyan, distinct from the bounds box)
  const er = 0.30, eg = 0.78, eb = 0.92;   // rectangle edges
  const gr = 0.18, gg = 0.42, gb = 0.52;   // interior grid
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number) =>
    v.push(ax, ay, az, r, g, b, bx, by, bz, r, g, b);
  if (p.axis === 'z') {
    const z = hz - p.pos;  // world Z of the layer (layer increases downward)
    const sx = Math.max(1, Math.ceil(W / 100)), sy = Math.max(1, Math.ceil(H / 100));
    for (let i = 0; i <= W; i += sx) { const x = x0 + i; seg(x, y0, z, x, y1, z, gr, gg, gb); }
    for (let j = 0; j <= H; j += sy) { const y = y0 + j; seg(x0, y, z, x1, y, z, gr, gg, gb); }
    seg(x0, y0, z, x1, y0, z, er, eg, eb); seg(x1, y0, z, x1, y1, z, er, eg, eb);
    seg(x1, y1, z, x0, y1, z, er, eg, eb); seg(x0, y1, z, x0, y0, z, er, eg, eb);
  } else if (p.axis === 'y') {
    const y = hy - p.pos;  // world Y of the row (row→-Y)
    const sx = Math.max(1, Math.ceil(W / 100)), sz = Math.max(1, Math.ceil(D / 100));
    for (let i = 0; i <= W; i += sx) { const x = x0 + i; seg(x, y, z0, x, y, z1, gr, gg, gb); }
    for (let k = 0; k <= D; k += sz) { const z = z0 + k; seg(x0, y, z, x1, y, z, gr, gg, gb); }
    seg(x0, y, z0, x1, y, z0, er, eg, eb); seg(x1, y, z0, x1, y, z1, er, eg, eb);
    seg(x1, y, z1, x0, y, z1, er, eg, eb); seg(x0, y, z1, x0, y, z0, er, eg, eb);
  } else {
    const x = p.pos - hx;  // world X of the column
    const sy = Math.max(1, Math.ceil(H / 100)), sz = Math.max(1, Math.ceil(D / 100));
    for (let j = 0; j <= H; j += sy) { const y = y0 + j; seg(x, y, z0, x, y, z1, gr, gg, gb); }
    for (let k = 0; k <= D; k += sz) { const z = z0 + k; seg(x, y0, z, x, y1, z, gr, gg, gb); }
    seg(x, y0, z0, x, y1, z0, er, eg, eb); seg(x, y1, z0, x, y1, z1, er, eg, eb);
    seg(x, y1, z1, x, y0, z1, er, eg, eb); seg(x, y0, z1, x, y0, z0, er, eg, eb);
  }
  return new Float32Array(v);
}
