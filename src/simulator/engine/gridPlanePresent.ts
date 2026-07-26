/// <reference types="@webgpu/types" />
/**
 * Shared display-resolution grid-plane present — the ONE camera-inverting grid
 * shader used by BOTH the E2 grid+agents composite (agentWebgpuRuntime.ts) AND
 * the grid-only 2D WebGPU direct render (webgpuRuntime.ts).
 *
 * A fullscreen triangle whose FRAGMENT shader INVERTS the display-res camera —
 * display pixel → world coordinate `(fragCoord − oxPx)/scalePx` → cell
 * (`col=floor(wx)`, `row=floor(wy)`) → the grid runtime's `colorsBuf` (row-major
 * RGBA8 u32/cell) sampled NEAREST (integer floor = hard cell edges = the crisp
 * CA-block look; NOT linear). It is DISPLAY-PIXEL-BOUND — one cell lookup per
 * covered display pixel, so a 5000² field costs the same to present as a 300² one
 * (the single sampled plane is the efficient realization of "a plane of cells";
 * do NOT render W×H instanced quads). `torus` selects wrap (infinity canvas) vs
 * bounds-discard (the transparent letterbox).
 *
 * Extracted from agentWebgpuRuntime.ts so grid-only and grid+agents present the
 * SAME way (behavioural consistency — the same crisp-cell look, the same camera
 * math). The `GridPlaneView` byte layout is registered in
 * scripts/verify-render-uniform-layouts.mjs (mind the vec3 align-16/size-12 §10
 * trap — this struct is all scalars, so it has none).
 */

/** The grid-plane camera uniform (32 B, all scalars — no vec3 padding trap).
 *  Mirrors `GRID_PLANE_VIEW_WGSL` below AND the shader struct. */
export const GRID_PLANE_VIEW_BYTES = 32;

export function writeGridPlaneView(gridW: number, gridH: number, torus: boolean, scalePx: number, oxPx: number, oyPx: number): ArrayBuffer {
  const ab = new ArrayBuffer(GRID_PLANE_VIEW_BYTES);
  const u = new Uint32Array(ab), fl = new Float32Array(ab);
  u[0] = gridW >>> 0;
  u[1] = gridH >>> 0;
  u[2] = torus ? 1 : 0;
  u[3] = 0;
  fl[4] = scalePx;
  fl[5] = oxPx;
  fl[6] = oyPx;
  fl[7] = 0;
  return ab;
}

export const GRID_PLANE_VIEW_WGSL = `struct GridPlaneView {
  gridW   : u32,
  gridH   : u32,
  torus   : u32,
  _pad0   : u32,
  scalePx : f32,
  oxPx    : f32,
  oyPx    : f32,
  _pad1   : f32,
};`;

/** WGSL: a fullscreen triangle whose FS inverts the display-res camera to a world
 *  coordinate, resolves the covered cell (NEAREST), and samples the grid `colorsBuf`
 *  (packed RGBA8 u32/cell, row-major), premultiplied. */
export const GRID_PRESENT_WGSL = `${GRID_PLANE_VIEW_WGSL}
@group(0) @binding(0) var<storage, read> colorsIn : array<u32>;
@group(0) @binding(1) var<uniform>       gv       : GridPlaneView;

@vertex
fn vsMain(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  // A single oversized triangle covering the whole DISPLAY viewport.
  var p = vec2<f32>(-1.0, -1.0);
  if (vi == 1u) { p = vec2<f32>(3.0, -1.0); }
  else if (vi == 2u) { p = vec2<f32>(-1.0, 3.0); }
  return vec4<f32>(p, 0.0, 1.0);
}

@fragment
fn fsMain(@builtin(position) fragCoord : vec4<f32>) -> @location(0) vec4<f32> {
  // Invert the camera: display pixel → world coordinate. scalePx > 0 always
  // (guarded CPU-side: baseScale·zoom). DISPLAY-pixel-bound: one cell lookup per
  // covered display pixel, so field size does not affect present cost.
  let W : f32 = f32(gv.gridW);
  let H : f32 = f32(gv.gridH);
  var wx : f32 = (fragCoord.x - gv.oxPx) / gv.scalePx;
  var wy : f32 = (fragCoord.y - gv.oyPx) / gv.scalePx;
  if (gv.torus != 0u) {
    // Infinity canvas → the grid tiles: wrap into [0,W)×[0,H).
    wx = wx - floor(wx / W) * W;
    wy = wy - floor(wy / H) * H;
  } else {
    // Bounded → outside the grid is the transparent letterbox.
    if (wx < 0.0 || wx >= W || wy < 0.0 || wy >= H) { discard; }
  }
  // NEAREST cell = integer floor of the world coord (hard cell edges, no lerp).
  // wx,wy are in [0,W)/[0,H) here, so u32() truncation is a valid floor.
  let col : u32 = min(gv.gridW - 1u, u32(wx));
  let row : u32 = min(gv.gridH - 1u, u32(wy));
  let packed : u32 = colorsIn[row * gv.gridW + col];
  let r : f32 = f32((packed >>  0u) & 0xffu) / 255.0;
  let g : f32 = f32((packed >>  8u) & 0xffu) / 255.0;
  let b : f32 = f32((packed >> 16u) & 0xffu) / 255.0;
  let a : f32 = f32((packed >> 24u) & 0xffu) / 255.0;
  // Premultiplied (the canvas is 'premultiplied'); default a=1 → identity.
  return vec4<f32>(r * a, g * a, b * a, a);
}`;
