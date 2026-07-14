// 3D Grid CA — WebGL2 voxel renderer.
//
// Instanced unit cubes, one per ALIVE (alpha > 0) cell, decoded from the flat
// SoA cell index in the vertex shader. Orbit camera, a clip/slice plane as the
// PRIMARY see-inside (fragment discard — NOT depth-sorted blending), opt-in
// per-cell alpha (back-to-front instance sort, Option A), and GPU colour-id
// picking via a second FBO pass. Also owns the 3D AGENT overlay pipelines:
// instanced sphere impostors for the agents + the bond-line pass (both clipped
// by the same interval and drawn over the voxel pass).
//
// Pure WebGL2 + a tiny mat4 helper — no React, no app imports. SimulatorView
// owns the lifecycle (create on entering 3D, dispose on leaving) and feeds it
// the RGBA colors buffer + camera/clip state through refs each frame.
//
// Culling is mandatory: a W×H×D volume can be millions of cells; we ONLY
// instance cells with alpha > 0 (compacted into the instance buffer each upload).

// ---------------------------------------------------------------------------
// mat4 (column-major, the order WebGL expects)
// ---------------------------------------------------------------------------
type Mat4 = Float32Array;

function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}
function mat4LookAt(eye: [number, number, number], center: [number, number, number], up: [number, number, number]): Mat4 {
  const [ex, ey, ez] = eye;
  let zx = ex - center[0], zy = ey - center[1], zz = ez - center[2];
  let rl = 1 / Math.hypot(zx, zy, zz) || 0; zx *= rl; zy *= rl; zz *= rl;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  rl = 1 / Math.hypot(xx, xy, xz) || 0; xx *= rl; xy *= rl; xz *= rl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
  m[12] = -(xx * ex + xy * ey + xz * ez);
  m[13] = -(yx * ex + yy * ey + yz * ez);
  m[14] = -(zx * ex + zy * ey + zz * ez);
  m[15] = 1;
  return m;
}
function mat4Ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n); m[15] = 1;
  return m;
}
/** 4×4 inverse (returns null if singular). */
function mat4Invert(m: Mat4): Mat4 | null {
  const a = m;
  const b00 = a[0]! * a[5]! - a[1]! * a[4]!, b01 = a[0]! * a[6]! - a[2]! * a[4]!;
  const b02 = a[0]! * a[7]! - a[3]! * a[4]!, b03 = a[1]! * a[6]! - a[2]! * a[5]!;
  const b04 = a[1]! * a[7]! - a[3]! * a[5]!, b05 = a[2]! * a[7]! - a[3]! * a[6]!;
  const b06 = a[8]! * a[13]! - a[9]! * a[12]!, b07 = a[8]! * a[14]! - a[10]! * a[12]!;
  const b08 = a[8]! * a[15]! - a[11]! * a[12]!, b09 = a[9]! * a[14]! - a[10]! * a[13]!;
  const b10 = a[9]! * a[15]! - a[11]! * a[13]!, b11 = a[10]! * a[15]! - a[11]! * a[14]!;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  const o = new Float32Array(16);
  o[0] = (a[5]! * b11 - a[6]! * b10 + a[7]! * b09) * det;
  o[1] = (a[2]! * b10 - a[1]! * b11 - a[3]! * b09) * det;
  o[2] = (a[13]! * b05 - a[14]! * b04 + a[15]! * b03) * det;
  o[3] = (a[10]! * b04 - a[9]! * b05 - a[11]! * b03) * det;
  o[4] = (a[6]! * b08 - a[4]! * b11 - a[7]! * b07) * det;
  o[5] = (a[0]! * b11 - a[2]! * b08 + a[3]! * b07) * det;
  o[6] = (a[14]! * b02 - a[12]! * b05 - a[15]! * b01) * det;
  o[7] = (a[8]! * b05 - a[10]! * b02 + a[11]! * b01) * det;
  o[8] = (a[4]! * b10 - a[5]! * b08 + a[7]! * b06) * det;
  o[9] = (a[1]! * b08 - a[0]! * b10 - a[3]! * b06) * det;
  o[10] = (a[12]! * b04 - a[13]! * b02 + a[15]! * b00) * det;
  o[11] = (a[9]! * b02 - a[8]! * b04 - a[11]! * b00) * det;
  o[12] = (a[5]! * b07 - a[4]! * b09 - a[6]! * b06) * det;
  o[13] = (a[0]! * b09 - a[1]! * b07 + a[2]! * b06) * det;
  o[14] = (a[13]! * b01 - a[12]! * b03 - a[14]! * b00) * det;
  o[15] = (a[8]! * b03 - a[9]! * b01 + a[10]! * b00) * det;
  return o;
}
/** Unproject an NDC point through inv(MVP) → world (perspective divide). */
function unproject(invMVP: Mat4, x: number, y: number, z: number): [number, number, number] | null {
  const m = invMVP;
  const ox = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const oy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const oz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  const ow = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!ow) return null;
  return [ox / ow, oy / ow, oz / ow];
}
function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
  return o;
}

// Z-up orbit camera (Blender convention): the XY plane is the horizon (the 2D-CA
// plane), Z is vertical with layer/depth increasing DOWNWARD, so a top-down view
// shows the grid like the 2D CA — col→+X (right), row→-Y (DOWN the screen),
// depth→-Z (into the screen). At the ±Depth POV the view is parallel to Z, so
// setCamera swaps in a Y-up (the "roll" that keeps row pointing down). `target`
// is the orbit pivot (moved by screen-space pan); `dist` is a multiple of the
// largest grid dimension.
export interface Camera3D { yaw: number; pitch: number; dist: number; target: [number, number, number]; }

/** Camera-distance bounds. `dist` is a MULTIPLE of the largest grid dimension (see
 *  setCamera), so these are grid-size independent: 0.2 is inside the volume, 40 is
 *  far out. The wheel zoom AND auto-zoom both clamp to this range — keep them here
 *  so the two can't drift apart. */
export const MIN_CAM_DIST = 0.2;
export const MAX_CAM_DIST = 40;
/** The default 3/4 view (also what "Reset view" restores). A FACTORY, not a shared
 *  const — `cam3dRef` mutates the camera in place, so handing out one object would
 *  let a reset alias the default. */
export const defaultCamera3d = (): Camera3D => ({ yaw: -0.9, pitch: 0.6, dist: 1.9, target: [0, 0, 0] });

/** Auto-zoom — the dolly sibling of auto-orbit. A one-way dolly would just fly into
 *  or away from the volume, so this OSCILLATES: the camera distance breathes around
 *  a BASE distance, `dist = base * (1 + amount * sin(phase))`, `phase` advancing at
 *  `speed` cycles/second. Because `dist` is a multiple of the largest grid dimension,
 *  the motion is grid-size independent for free. `amount` is a FRACTION of the base
 *  (0.35 = ±35%), never ≥ 1, so the multiplier can't reach 0. Session state (like
 *  auto-orbit) — a camera animation that resumed itself on every load would surprise. */
export interface AutoZoom3D { on: boolean; speed: number; amount: number; }
export const DEFAULT_AUTOZOOM3D: AutoZoom3D = { on: false, speed: 0.12, amount: 0.35 };
/** The base distance a given (dist, phase, amount) implies — the inverse of the
 *  oscillation. Used to RE-BASELINE when the user wheel-zooms (or resets the view)
 *  while auto-zoom is running, so their zoom sticks instead of being stomped on the
 *  next frame. Guards the (impossible for amount<1, but cheap) near-zero multiplier. */
export function autoZoomBaseFrom(dist: number, phase: number, amount: number): number {
  const mul = 1 + amount * Math.sin(phase);
  return mul > 0.05 ? dist / mul : dist;
}
// Clip/slice INTERVAL (slab). `axis` 'x'|'y'|'z' cuts along a grid axis; 'camera'
// cuts along the current view direction (peel toward the viewer). A fragment at
// world-coord `w` along the axis is kept iff `lo <= w <= hi` — two cuts (one from
// each side), so the user clips from both directions and the gap = visible
// thickness. `lo`/`hi` are in the SAME world space as the cube/sphere centres.
export interface ClipPlane3D { enabled: boolean; axis: 'x' | 'y' | 'z' | 'camera'; lo: number; hi: number; }
/** Toggleable scene overlays + render-layer visibility. `voxels`/`agents` gate the
 *  CA-grid voxel pass and the agent (bond + sphere) pass in render(). */
export interface Viz3D { axes: boolean; grid: boolean; bounds: boolean; gizmo: boolean; voxels: boolean; agents: boolean;
  /** Render the agent BOND lines (display-only — the bond springs keep simulating).
   *  Only meaningful when `agents` is on; the panel toggle only shows for models
   *  whose Bonds capability isn't Off (resolveMaxBonds > 0). */
  bonds: boolean; }

/** Bond-Graph Agents — the subset of the per-`stepped` render snapshot the 3D
 *  renderer needs. Positions are in continuous WORLD (cell) coordinates. `z` is a
 *  length-0 placeholder in 2D-agent models (RR-0 — the renderer reads `z[i] ?? 0`
 *  so it ships against the 2D engine), so it's typed as a maybe-empty array. */
export interface AgentSnapshot3D {
  highWater: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  radius: Float64Array;
  alive: Uint8Array;
  colors: Uint8ClampedArray;
  /** Flat [a, b, a, b, …] live bond index pairs (empty when no bonds). */
  bonds: Int32Array;
  /** Velocity — read only for a sprite whose asset has `orientToVelocity`. Length-0
   *  in 2D / non-sprite models (then treated as 0). */
  vx: Float64Array;
  vy: Float64Array;
  /** Per-agent sprite slot (1-based, 0 = none) + current frame (fractional) +
   *  facing (compass degrees) + size override (0 = use the asset default). All are
   *  length-0 for a non-sprite model → the renderer draws sphere impostors, exactly
   *  as before this feature (the sprite pass never runs). */
  spriteIds: Int32Array;
  spriteFrames: Float64Array;
  spriteRotations: Float64Array;
  spriteScales: Float64Array;
}

/** One sprite's atlas contribution — the decoded frame bitmaps + the render meta
 *  (mirrors the 2D `spriteMetaRef` entry). `slot` is the 1-based index into
 *  `model.sprites` (= the per-agent `spriteIds` value). */
export interface SpriteAtlasInput {
  slot: number;
  frames: ImageBitmap[];
  loop: boolean;
  defaultDirection: number;
  rotationOffset: number;
  orientToVelocity: boolean;
  scale: number;
}

/** gl3d-internal per-slot sprite render meta (built by setSpriteAtlas). */
interface SpriteSlotMeta {
  baseLayer: number;   // first atlas layer of this sprite's frames
  frameCount: number;
  aspect: number;      // frame width / height (native)
  loop: boolean;
  defaultDirection: number;
  rotationOffset: number;
  orientToVelocity: boolean;
  scale: number;
}

/** 3D scene lighting. One directional key light + ambient fill (+ an optional
 *  white Blinn-Phong highlight), shared by the voxel cubes and the agent
 *  sphere impostors (sprites are unlit textured billboards).
 *  - `mode: 'camera'` anchors the light to the VIEW: the ball position
 *    (bx, by, implied +z toward the viewer) is combined with the camera basis
 *    every frame, so shading stays constant while orbiting (headlight/matcap).
 *  - `mode: 'world'` uses the stored world-space unit vector (wx, wy, wz): the
 *    light is fixed in the SCENE, so orbiting sweeps the lit side (sun-style).
 *  The DEFAULT reproduces the historical hardcoded shade exactly (world light
 *  normalize(0.4, 0.8, 0.6), lum = 0.45 + 0.55·max(0, n·L), no specular). */
export interface Light3D {
  mode: 'camera' | 'world';
  /** Light-ball widget position (unit disc, view space: +x right, +y up).
   *  Drives the light in camera mode; drives the widget dot in both modes. */
  bx: number;
  by: number;
  /** World-space light direction (unit, toward the light) — used in world
   *  mode; refreshed from the ball + camera basis at drag time. */
  wx: number;
  wy: number;
  wz: number;
  ambient: number;   // base fill 0..1
  diffuse: number;   // directional strength 0..~1.5
  specular: number;  // white Blinn-Phong highlight strength 0..1 (default 0)
  /** GLOBAL LIGHTING (opt-in; default off = the historical per-fragment shade).
   *  These make cells/agents affect each other's shading instead of each surface
   *  being lit only by its own normal. */
  shadows: boolean;       // cast shadows (shadow map) — voxels + agents cast + receive
  shadowStrength: number; // 0..1 how dark a fully-shadowed diffuse term goes
  ao: boolean;            // ambient occlusion (voxel occupancy) — crevices darken
  aoStrength: number;     // 0..1 how much the ambient term is occluded
}

/** norm(0.4, 0.8, 0.6) — the exact light the shaders used to hardcode. */
const DEF_L = Math.hypot(0.4, 0.8, 0.6);
export const DEFAULT_LIGHT3D: Readonly<Light3D> = Object.freeze({
  mode: 'world' as const,
  bx: -0.2, by: 0.55,
  wx: 0.4 / DEF_L, wy: 0.8 / DEF_L, wz: 0.6 / DEF_L,
  ambient: 0.45, diffuse: 0.55, specular: 0,
  shadows: false, shadowStrength: 0.6, ao: false, aoStrength: 0.7,
});

/** Agent METABALLS — render the (non-sprite) agent population as ONE implicit
 *  surface instead of discrete sphere impostors: each agent contributes a
 *  Wyvill-style falloff over an influence radius (`influence` × its own radius),
 *  the fields SUM, and the surface is the isosurface at `threshold` — so agents
 *  whose influence radii overlap bulge toward each other and FUSE (Blender
 *  metaball semantics). Purely a RENDER mode: picking, brushing, bonds, physics
 *  and the compilers are untouched (agents stay spheres logically). */
export interface Metaballs3D {
  enabled: boolean;
  /** Falloff (influence) radius as a multiple of the agent radius. 1.0–3.0. */
  influence: number;
  /** The isovalue the surface sits at. Lower = fatter/more fused. 0.02–0.9. */
  threshold: number;
  /** Field voxels per cell (1 | 2 | 4) — the bake resolution. */
  resolution: number;
}
/** The threshold at which a LONE agent's metaball surface sits at exactly its
 *  own sphere radius (so enabling metaballs doesn't resize isolated agents):
 *  solve (1 − (r/R)²)³ = T with R = influence·r  ⇒  T = (1 − 1/influence²)³. */
export function metaballAutoThreshold(influence: number): number {
  const s = 1 - 1 / Math.max(1.0001, influence * influence);
  return Math.max(0.02, Math.min(0.9, s * s * s));
}
export const DEFAULT_METABALLS3D: Readonly<Metaballs3D> = Object.freeze({
  enabled: false, influence: 1.6, threshold: metaballAutoThreshold(1.6), resolution: 2,
});

const WORLD_UP: [number, number, number] = [0, 0, 1];

/** Camera basis (forward/right/up) from yaw/pitch in the Z-up convention.
 *  Exported for SimulatorView's light-ball widget (world-mode drags convert
 *  the view-space ball position through the CURRENT camera basis). */
export function cameraBasis(cam: Camera3D): { dir: [number, number, number]; right: [number, number, number]; up: [number, number, number] } {
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  // Direction from target → eye.
  const dir: [number, number, number] = [cp * cy, cp * sy, sp];
  // forward = -dir; right = normalize(forward × worldUp); up = right × forward.
  const fx = -dir[0], fy = -dir[1], fz = -dir[2];
  let rx = fy * WORLD_UP[2] - fz * WORLD_UP[1];
  let ry = fz * WORLD_UP[0] - fx * WORLD_UP[2];
  let rz = fx * WORLD_UP[1] - fy * WORLD_UP[0];
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  return { dir, right: [rx, ry, rz], up: [ux, uy, uz] };
}

/** Screen-space pan: move the camera target along the camera's right/up axes so
 *  panning tracks the current viewpoint (not a fixed world plane). `scale` maps
 *  pixels → world units (caller passes ~dist*dim/viewportHeight). */
export function panCamera(cam: Camera3D, dxPx: number, dyPx: number, scale: number): void {
  const { right, up } = cameraBasis(cam);
  cam.target[0] += (-dxPx * right[0] + dyPx * up[0]) * scale;
  cam.target[1] += (-dxPx * right[1] + dyPx * up[1]) * scale;
  cam.target[2] += (-dxPx * right[2] + dyPx * up[2]) * scale;
}

// 36-vertex unit cube centred at origin (side 1), with per-vertex face normals.
// pos.xyz then normal.xyz, 6 floats/vertex.
const CUBE: number[] = (() => {
  const faces: Array<{ n: [number, number, number]; v: [number, number, number][] }> = [
    { n: [0, 0, 1], v: [[-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]] },
    { n: [0, 0, -1], v: [[.5, -.5, -.5], [-.5, -.5, -.5], [-.5, .5, -.5], [.5, -.5, -.5], [-.5, .5, -.5], [.5, .5, -.5]] },
    { n: [1, 0, 0], v: [[.5, -.5, .5], [.5, -.5, -.5], [.5, .5, -.5], [.5, -.5, .5], [.5, .5, -.5], [.5, .5, .5]] },
    { n: [-1, 0, 0], v: [[-.5, -.5, -.5], [-.5, -.5, .5], [-.5, .5, .5], [-.5, -.5, -.5], [-.5, .5, .5], [-.5, .5, -.5]] },
    { n: [0, 1, 0], v: [[-.5, .5, .5], [.5, .5, .5], [.5, .5, -.5], [-.5, .5, .5], [.5, .5, -.5], [-.5, .5, -.5]] },
    { n: [0, -1, 0], v: [[-.5, -.5, -.5], [.5, -.5, -.5], [.5, -.5, .5], [-.5, -.5, -.5], [.5, -.5, .5], [-.5, -.5, .5]] },
  ];
  const out: number[] = [];
  for (const f of faces) for (const p of f.v) out.push(p[0], p[1], p[2], f.n[0], f.n[1], f.n[2]);
  return out;
})();

// Shared cast-shadow sampling — spliced into the voxel + sphere fragment shaders
// (right after `precision`, so its uniforms + shadowFactor() are declared before
// use). Directional shadow map: transform the fragment's WORLD surface point into
// light-clip space, PCF-sample the depth compare (sampler2DShadow), and return a
// [0,1] factor folded by the user strength. uShadowEnabled=0 → 1.0 (no shadows,
// byte-identical to the historical shade). Takes ndl (= max(0, N·L)) so it needs
// no forward reference to the per-shader uLightDir.
const SHADOW_GLSL = `
precision highp sampler2DShadow;
uniform int uShadowEnabled;
uniform sampler2DShadow uShadowMap;
uniform mat4 uLightMVP;
uniform float uShadowStrength;
uniform vec2 uShadowTexel;
uniform float uShadowBias;   // base depth bias in [0,1] space (scale-relative: ~1 cell)
float shadowFactor(vec3 fragWorld, float ndl) {
  if (uShadowEnabled == 0) return 1.0;
  vec4 lp = uLightMVP * vec4(fragWorld, 1.0);
  vec3 sc = lp.xyz / lp.w * 0.5 + 0.5;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float bias = uShadowBias * (1.0 + 3.0 * (1.0 - ndl));  // slope-scaled (steeper = more)
  float ref = sc.z - bias;
  float s = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++)
      s += texture(uShadowMap, vec3(sc.xy + vec2(float(x), float(y)) * uShadowTexel, ref));
  s /= 9.0;
  return mix(1.0, s, uShadowStrength);
}
`;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in uint aCellIndex;   // flat SoA index of this instance (u32 —
                                         // a FLOAT attribute rounds indices >= 2^24
                                         // to even, shifting voxels onto the wrong
                                         // column on grids past ~16.7M cells)
layout(location=3) in vec4 aColor;       // rgba 0..1
layout(location=4) in float aAO;         // occupancy AO 0..1 (0 exposed, 1 buried)
uniform mat4 uMVP;
uniform uint uWu; uniform uint uWHu;     // grid W and W*H (integer — exact decode)
uniform vec3 uHalf;                      // half-extents (W-1)/2 etc.
uniform float uCubeScale;
out vec4 vColor;
out vec3 vNormal;
out vec3 vWorld;     // world-space cell-centre (for the clip plane)
out vec3 vFragWorld; // world-space surface point (for shadow-map sampling)
out float vAO;
void main() {
  uint layerU = aCellIndex / uWHu;
  uint remU = aCellIndex - layerU * uWHu;
  uint rowU = remU / uWu;
  float layer = float(layerU);
  float row = float(rowU);
  float col = float(remU - rowU * uWu);
  // Z-up. col→+X (right); row→-Y so a top-down view matches the 2D CA (row
  // increases DOWN the screen); layer/depth→-Z (into the screen / downward,
  // layer 0 on top).
  vec3 centre = vec3(col - uHalf.x, uHalf.y - row, uHalf.z - layer);
  vec3 world = aPos * uCubeScale + centre;
  vWorld = centre;
  vFragWorld = world;
  vColor = aColor;
  vNormal = aNormal;
  vAO = aAO;
  gl_Position = uMVP * vec4(world, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
${SHADOW_GLSL}
in vec4 vColor;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vFragWorld;
in float vAO;
uniform int uClipEnabled;   // 0/1
uniform int uClipAxis;      // 0=x 1=y 2=z 3=camera-view-axis
uniform float uClipLo;      // slab near bound (cells outside [lo,hi] are hidden)
uniform float uClipHi;      // slab far bound
uniform vec3 uClipForward;  // camera forward (for axis 3)
uniform vec3 uLightDir;     // world-space dir TOWARD the light (unit)
uniform float uAmbient;     // base fill
uniform float uDiffuse;     // directional strength
uniform float uSpecular;    // white Blinn-Phong highlight strength (0 = off)
uniform vec3 uViewDir;      // world-space dir toward the viewer (target→eye)
uniform float uAOStrength;  // occupancy-AO amount (0 = off)
out vec4 outColor;
void main() {
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vWorld.x : uClipAxis == 1 ? vWorld.y : uClipAxis == 2 ? vWorld.z : dot(vWorld, uClipForward);
    if (w < uClipLo || w > uClipHi) { discard; }
  }
  // Flat directional shade by face normal so the cubes read as solid volume.
  // Light dir + ambient/diffuse/specular come from the Lighting controls
  // (defaults reproduce the historical 0.45 + 0.55·n·L shade exactly). Global
  // lighting (opt-in) layers occupancy AO onto ambient + cast shadows onto diffuse.
  vec3 N = normalize(vNormal);
  float ndl = max(0.0, dot(N, uLightDir));
  float ao = 1.0 - uAOStrength * vAO;
  float sh = shadowFactor(vFragWorld, ndl);
  float lum = uAmbient * ao + uDiffuse * ndl * sh;
  vec3 col = vColor.rgb * lum;
  if (uSpecular > 0.0) {
    vec3 H = normalize(uLightDir + uViewDir);
    col += uSpecular * pow(max(0.0, dot(N, H)), 32.0) * sh;
  }
  outColor = vec4(col, vColor.a);
}`;

// Pick pass: encode the instance's cell index + 1 across the FULL RGBA (32 bits —
// RGB alone caps at 2^24-1, truncating picks on grids past ~16.7M cells); the
// cleared background stays 0 = miss. Nearest cube wins via depth.
const PICK_FS = `#version 300 es
precision highp float;
flat in uint vPickIdx;
in vec3 vWorldP;
uniform int uClipEnabled;
uniform int uClipAxis;
uniform float uClipLo;
uniform float uClipHi;
uniform vec3 uClipForward;
out vec4 outColor;
void main() {
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vWorldP.x : uClipAxis == 1 ? vWorldP.y : uClipAxis == 2 ? vWorldP.z : dot(vWorldP, uClipForward);
    if (w < uClipLo || w > uClipHi) { discard; }
  }
  uint id = vPickIdx + 1u;
  outColor = vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float((id >> 24) & 255u)) / 255.0;
}`;
const PICK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=2) in uint aCellIndex;
uniform mat4 uMVP;
uniform uint uWu; uniform uint uWHu; uniform vec3 uHalf; uniform float uCubeScale;
flat out uint vPickIdx;
out vec3 vWorldP;
void main() {
  uint layerU = aCellIndex / uWHu;
  uint remU = aCellIndex - layerU * uWHu;
  uint rowU = remU / uWu;
  float layer = float(layerU);
  float row = float(rowU);
  float col = float(remU - rowU * uWu);
  vec3 centre = vec3(col - uHalf.x, uHalf.y - row, uHalf.z - layer);
  vWorldP = centre;
  vPickIdx = aCellIndex;
  gl_Position = uMVP * vec4(aPos * uCubeScale + centre, 1.0);
}`;

// Unlit coloured-line program for the axes / grid / bounds overlays + the gizmo +
// the agent bonds. Carries the vertex's world position so the BOND pass can apply
// the SAME clip interval as the voxels/spheres (uClipEnabled is 0 for every other
// overlay, which is drawn in world OR gizmo-NDC space — see drawLines).
const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uMVP;
uniform float uPointSize;   // only affects gl.POINTS draws; ignored for LINES
out vec3 vCol;
out vec3 vWorldL;           // world pos (for the optional bond clip)
void main(){ vCol = aColor; vWorldL = aPos; gl_PointSize = uPointSize; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const LINE_FS = `#version 300 es
precision highp float;
in vec3 vCol;
in vec3 vWorldL;
uniform int uClipEnabled;   // 0 for every overlay except the bond pass
uniform int uClipAxis;
uniform float uClipLo;
uniform float uClipHi;
uniform vec3 uClipForward;
out vec4 o;
void main(){
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vWorldL.x : uClipAxis == 1 ? vWorldL.y : uClipAxis == 2 ? vWorldL.z : dot(vWorldL, uClipForward);
    if (w < uClipLo || w > uClipHi) { discard; }
  }
  o = vec4(vCol, 1.0);
}`;

// ---------------------------------------------------------------------------
// Bond-Graph Agents — sphere impostors (PR5). Agents have CONTINUOUS world
// positions + a per-agent radius, so they can't reuse the cube-instance path
// (which decodes x/y/z from a flat CELL index). Each agent is a camera-facing
// billboard quad (2 triangles, 4 verts) ray-cast in the fragment shader into a
// sphere: the FS discards outside the unit disc, derives the analytic sphere
// normal for a Lambert shade, and WRITES gl_FragDepth so the impostors
// depth-interleave with the voxel cubes + each other. Per-instance buffer is
// [x, y, z, radius, r, g, b, a] × 8 floats (stride 32). The world centre uses
// the SAME Z-up remap as the cube path: vec3(ax-uHalf.x, uHalf.y-ay, uHalf.z-az).
// ---------------------------------------------------------------------------
const SPHERE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;      // unit quad corner in [-1,1]
layout(location=1) in vec3 aPos;         // agent world position (col,row,layer space)
layout(location=2) in float aRadius;     // agent radius (cell units)
layout(location=3) in vec4 aColor;       // rgba 0..1
uniform mat4 uMVP;
uniform vec3 uHalf;                       // half-extents (W-1)/2 etc.
uniform vec3 uCamRight;                   // camera right (world)
uniform vec3 uCamUp;                      // camera up (world)
out vec3 vCentre;                         // sphere centre (world, for the FS raycast)
out float vRadius;
out vec2 vUV;                             // quad-local coord in [-1,1]
out vec4 vColor;
out float vSkip;                          // sprite-agent flag (draws a billboard instead)
void main() {
  // Z-up remap: a sphere at agent (ax,ay,az) sits in the voxel cube at cell
  // (layer=az,row=ay,col=ax) — col→+X, row→-Y, layer→-Z.
  vec3 centre = vec3(aPos.x - uHalf.x, uHalf.y - aPos.y, uHalf.z - aPos.z);
  vCentre = centre;
  // A NEGATIVE radius flags a SPRITE-agent (drawn by the billboard pass instead of
  // a sphere). uploadAgents encodes it in the sign so the sphere buffer stays 8
  // floats (non-sprite models keep a positive radius → byte-identical).
  float ar = abs(aRadius);
  vRadius = ar;
  vSkip = aRadius < 0.0 ? 1.0 : 0.0;
  vUV = aCorner;
  vColor = aColor;
  // Billboard: expand the quad in the camera plane by the radius.
  vec3 world = centre + (uCamRight * aCorner.x + uCamUp * aCorner.y) * ar;
  gl_Position = uMVP * vec4(world, 1.0);
}`;
const SPHERE_FS = `#version 300 es
precision highp float;
${SHADOW_GLSL}
in vec3 vCentre;
in float vRadius;
in vec2 vUV;
in vec4 vColor;
in float vSkip;
uniform mat4 uMVP;
uniform vec3 uCamForward;                 // camera forward (world; -dir)
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform int uClipEnabled;
uniform int uClipAxis;
uniform float uClipLo;
uniform float uClipHi;
uniform vec3 uClipForward;
uniform vec3 uLightDir;     // world-space dir TOWARD the light (unit)
uniform float uAmbient;
uniform float uDiffuse;
uniform float uSpecular;
out vec4 outColor;
void main() {
  if (vSkip > 0.5) { discard; }           // sprite-agent → drawn by the billboard pass
  float r2 = dot(vUV, vUV);
  if (r2 > 1.0) { discard; }              // outside the unit disc → not on the sphere
  float zc = sqrt(1.0 - r2);              // height above the billboard plane (unit)
  // Analytic surface normal + the surface world point (centre + radius·n).
  vec3 n = normalize(uCamRight * vUV.x + uCamUp * vUV.y - uCamForward * zc);
  vec3 surf = vCentre + n * vRadius;
  // Clip the surface point with the SAME interval test the voxel FS uses.
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? surf.x : uClipAxis == 1 ? surf.y : uClipAxis == 2 ? surf.z : dot(surf, uClipForward);
    if (w < uClipLo || w > uClipHi) { discard; }
  }
  // Re-project the surface point so the impostor depth-interleaves with cubes.
  vec4 clip = uMVP * vec4(surf, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
  // Same Lighting-controls shade as the voxel FS (view dir = -uCamForward), plus
  // the cast-shadow factor (agents receive shadows from voxels + each other).
  float ndl = max(0.0, dot(n, uLightDir));
  float sh = shadowFactor(surf, ndl);
  float lum = uAmbient + uDiffuse * ndl * sh;
  vec3 col = vColor.rgb * lum;
  if (uSpecular > 0.0) {
    vec3 H = normalize(uLightDir - uCamForward);
    col += uSpecular * pow(max(0.0, dot(n, H)), 32.0) * sh;
  }
  outColor = vec4(col, vColor.a);
}`;
// Agent pick pass: encode gl_InstanceID+1 into RGB (the COMPACTED instance index,
// NOT the slot id — SimulatorView maps it back via instanceToSlot). Raycast disc
// + gl_FragDepth so the nearest agent wins, mirroring the colour shade above.
const SPHERE_PICK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPos;
layout(location=2) in float aRadius;
uniform mat4 uMVP;
uniform vec3 uHalf;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
out vec3 vCentre;
out float vRadius;
out vec2 vUV;
flat out float vPickId;
void main() {
  vec3 centre = vec3(aPos.x - uHalf.x, uHalf.y - aPos.y, uHalf.z - aPos.z);
  vCentre = centre;
  float ar = abs(aRadius);                // sprite-agents carry -radius (still pickable)
  vRadius = ar;
  vUV = aCorner;
  vPickId = float(gl_InstanceID + 1);
  vec3 world = centre + (uCamRight * aCorner.x + uCamUp * aCorner.y) * ar;
  gl_Position = uMVP * vec4(world, 1.0);
}`;
const SPHERE_PICK_FS = `#version 300 es
precision highp float;
in vec3 vCentre;
in float vRadius;
in vec2 vUV;
flat in float vPickId;
uniform mat4 uMVP;
uniform vec3 uCamForward;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform int uClipEnabled;
uniform int uClipAxis;
uniform float uClipLo;
uniform float uClipHi;
uniform vec3 uClipForward;
out vec4 outColor;
void main() {
  float r2 = dot(vUV, vUV);
  if (r2 > 1.0) { discard; }
  float zc = sqrt(1.0 - r2);
  vec3 n = normalize(uCamRight * vUV.x + uCamUp * vUV.y - uCamForward * zc);
  vec3 surf = vCentre + n * vRadius;
  // Clip-aware picking: a clipped agent must not be pickable (matches SPHERE_FS).
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? surf.x : uClipAxis == 1 ? surf.y : uClipAxis == 2 ? surf.z : dot(surf, uClipForward);
    if (w < uClipLo || w > uClipHi) { discard; }
  }
  vec4 clip = uMVP * vec4(surf, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
  float idx = vPickId;
  float r = mod(idx, 256.0);
  float g = mod(floor(idx / 256.0), 256.0);
  float b = mod(floor(idx / 65536.0), 256.0);
  outColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}`;
// ---------------------------------------------------------------------------
// Bond-Graph Agent SPRITES (3D billboard pass). A sprite-agent draws a
// camera-facing textured quad from the sprite atlas (a TEXTURE_2D_ARRAY, one layer
// per (sprite, frame)) INSTEAD of the sphere impostor (which is skipped via the
// sign-flag above). Per-instance: [x,y,z (world), halfW, halfH (cell units),
// cosRot, sinRot, layer, alpha] × 9 floats (stride 36). The quad is ASPECT-shaped
// (halfW/halfH) so the atlas frame — stored stretched-to-square in its cell —
// renders at the sprite's native aspect with the longest side ≈ the agent
// diameter, matching the 2D `drawImage` sizing. The rotation is clockwise-on-screen
// (matches the 2D `ctx.rotate` compass convention). Depth uses the billboard-plane
// projected depth (no gl_FragDepth) so sprites depth-interleave with spheres/voxels.
const SPRITE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;      // unit quad corner in [-1,1]
layout(location=1) in vec3 aPos;         // agent world position (col,row,layer space)
layout(location=2) in vec2 aHalf;        // half-extent (w,h) in cell units
layout(location=3) in vec2 aRot;         // cos,sin of the facing rotation
layout(location=4) in float aLayer;      // atlas layer (baseLayer + resolved frame)
layout(location=5) in float aAlpha;      // agent alpha 0..1
uniform mat4 uMVP;
uniform vec3 uHalf;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
out vec2 vTex;
out float vLayer;
out float vAlpha;
out vec3 vSurf;
void main() {
  vec3 centre = vec3(aPos.x - uHalf.x, uHalf.y - aPos.y, uHalf.z - aPos.z);
  // Texcoord from the UNROTATED corner (the image is fixed to the quad); the quad
  // VERTICES rotate, so the image rotates with them. Flip V (image top = +V).
  vTex = vec2((aCorner.x + 1.0) * 0.5, (1.0 - aCorner.y) * 0.5);
  vLayer = aLayer;
  vAlpha = aAlpha;
  // Aspect-shaped local corner, then rotated clockwise-on-screen (matches
  // ctx.rotate: x' = x·cos + y·sin, y' = -x·sin + y·cos, with uCamUp = screen-up).
  vec2 local = vec2(aCorner.x * aHalf.x, aCorner.y * aHalf.y);
  vec2 rot = vec2(local.x * aRot.x + local.y * aRot.y, -local.x * aRot.y + local.y * aRot.x);
  vec3 world = centre + uCamRight * rot.x + uCamUp * rot.y;
  vSurf = world;
  gl_Position = uMVP * vec4(world, 1.0);
}`;
const SPRITE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vTex;
in float vLayer;
in float vAlpha;
in vec3 vSurf;
uniform sampler2DArray uAtlas;
uniform int uClipEnabled;
uniform int uClipAxis;
uniform float uClipLo;
uniform float uClipHi;
uniform vec3 uClipForward;
out vec4 outColor;
void main() {
  vec4 t = texture(uAtlas, vec3(vTex, vLayer));
  float a = t.a * vAlpha;
  if (a < 0.02) { discard; }              // fully transparent → no fragment (chroma-key / pad)
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vSurf.x : uClipAxis == 1 ? vSurf.y : uClipAxis == 2 ? vSurf.z : dot(vSurf, uClipForward);
    if (w < uClipLo || w > uClipHi) { discard; }
  }
  outColor = vec4(t.rgb, a);
}`;

// ---------------------------------------------------------------------------
// Cast-shadow DEPTH passes (global lighting). Render the voxel cubes + agent
// spheres from the LIGHT's orthographic POV into a depth texture; the main voxel
// + sphere shaders then PCF-sample it (SHADOW_GLSL) to darken shadowed diffuse.
// Depth-only (no colour output). Clip-aware so a clipped-open view's interior is
// lit as if the removed shell weren't casting.
// ---------------------------------------------------------------------------
const CUBE_SHADOW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=2) in uint aCellIndex;
uniform mat4 uLightMVP;
uniform uint uWu; uniform uint uWHu; uniform vec3 uHalf; uniform float uCubeScale;
out vec3 vWorldS;
void main() {
  uint layerU = aCellIndex / uWHu;
  uint remU = aCellIndex - layerU * uWHu;
  uint rowU = remU / uWu;
  vec3 centre = vec3(float(remU - rowU * uWu) - uHalf.x, uHalf.y - float(rowU), uHalf.z - float(layerU));
  vWorldS = centre;
  gl_Position = uLightMVP * vec4(aPos * uCubeScale + centre, 1.0);
}`;
const CUBE_SHADOW_FS = `#version 300 es
precision highp float;
in vec3 vWorldS;
uniform int uClipEnabled; uniform int uClipAxis; uniform float uClipLo; uniform float uClipHi; uniform vec3 uClipForward;
void main() {
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vWorldS.x : uClipAxis == 1 ? vWorldS.y : uClipAxis == 2 ? vWorldS.z : dot(vWorldS, uClipForward);
    if (w < uClipLo || w > uClipHi) discard;
  }
}`;
const SPHERE_SHADOW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPos;
layout(location=2) in float aRadius;
uniform mat4 uLightMVP;
uniform vec3 uHalf;
uniform vec3 uLightRight;   // billboard axes perpendicular to the light dir
uniform vec3 uLightUp;
out vec3 vCentreS;
out float vRadiusS;
out vec2 vUVS;
out float vSkipS;
void main() {
  vec3 centre = vec3(aPos.x - uHalf.x, uHalf.y - aPos.y, uHalf.z - aPos.z);
  vCentreS = centre;
  float ar = abs(aRadius);
  vRadiusS = ar;
  vSkipS = aRadius < 0.0 ? 1.0 : 0.0;   // sprite-agents don't cast a sphere shadow
  vUVS = aCorner;
  vec3 world = centre + (uLightRight * aCorner.x + uLightUp * aCorner.y) * ar;
  gl_Position = uLightMVP * vec4(world, 1.0);
}`;
const SPHERE_SHADOW_FS = `#version 300 es
precision highp float;
in vec3 vCentreS;
in float vRadiusS;
in vec2 vUVS;
in float vSkipS;
uniform mat4 uLightMVP;
uniform vec3 uLightRight;
uniform vec3 uLightUp;
uniform vec3 uLightDirW;    // dir TOWARD the light (unit)
uniform int uClipEnabled; uniform int uClipAxis; uniform float uClipLo; uniform float uClipHi; uniform vec3 uClipForward;
void main() {
  if (vSkipS > 0.5) discard;
  float r2 = dot(vUVS, vUVS);
  if (r2 > 1.0) discard;
  float zc = sqrt(1.0 - r2);
  vec3 surf = vCentreS + (uLightRight * vUVS.x + uLightUp * vUVS.y + uLightDirW * zc) * vRadiusS;
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? surf.x : uClipAxis == 1 ? surf.y : uClipAxis == 2 ? surf.z : dot(surf, uClipForward);
    if (w < uClipLo || w > uClipHi) discard;
  }
  vec4 clip = uLightMVP * vec4(surf, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
}`;

// ---------------------------------------------------------------------------
// Agent METABALLS — implicit-surface pass. The agents' summed density field is
// BAKED on the CPU into a small RGBA8 3D texture over the agents' bounding box
// (A = density / F_MAX, RGB = density-weighted agent colour), then RAYMARCHED
// per pixel from a fullscreen quad: reconstruct the world ray from inv(MVP),
// intersect the field box, march to the first threshold crossing, bisect,
// shade with the SAME lighting model as the voxel/sphere shaders (incl. cast
// shadows via SHADOW_GLSL) and write gl_FragDepth with the SAME formula as
// SPHERE_FS so the blob depth-interleaves with voxels / bonds / sprites.
// NB uFieldA/uFieldB are the world coords of the field's CELL-MIN / CELL-MAX
// corners — NOT component-wise min/max: the Z-up remap NEGATES row and layer,
// so per-axis (p−A)/(B−A) with a negative span is exactly what keeps the
// texture (stored in ascending cell order) sampling un-mirrored, and the slab
// test below is order-robust via min/max.
// ---------------------------------------------------------------------------
const META_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;   // unit quad [-1,1]
out vec2 vNdc;
void main() { vNdc = aCorner; gl_Position = vec4(aCorner, 0.0, 1.0); }`;
const META_FS = `#version 300 es
precision highp float;
${SHADOW_GLSL}
precision highp sampler3D;
in vec2 vNdc;
uniform mat4 uMVP;         // for gl_FragDepth
uniform mat4 uInvMVP;      // NDC → world ray
uniform sampler3D uField;
uniform vec3 uFieldA;      // world coords of the field's cell-min corner
uniform vec3 uFieldB;      // world coords of the field's cell-max corner
uniform float uThreshold;  // the isovalue
uniform float uFMax;       // density scale (texture A × uFMax = density)
uniform float uStepWorld;  // march step (≈ half a field voxel, world units)
uniform int   uMaxSteps;
uniform vec3 uLightDir;    // same lighting uniforms as FS / SPHERE_FS
uniform float uAmbient;
uniform float uDiffuse;
uniform float uSpecular;
uniform int uClipEnabled;  // same clip-interval uniforms as FS / SPHERE_FS
uniform int uClipAxis;
uniform float uClipLo;
uniform float uClipHi;
uniform vec3 uClipForward;
out vec4 outColor;

vec4 sampleField(vec3 p) {                       // p in world space
  return texture(uField, (p - uFieldA) / (uFieldB - uFieldA));
}
float density(vec3 p) { return sampleField(p).a * uFMax; }

bool clipped(vec3 p) {
  if (uClipEnabled == 0) return false;
  float w = uClipAxis == 0 ? p.x : uClipAxis == 1 ? p.y : uClipAxis == 2 ? p.z : dot(p, uClipForward);
  return (w < uClipLo || w > uClipHi);
}

void main() {
  // 1. World ray through this pixel (near → far plane).
  vec4 pn = uInvMVP * vec4(vNdc, -1.0, 1.0);
  vec4 pf = uInvMVP * vec4(vNdc, 1.0, 1.0);
  vec3 ro = pn.xyz / pn.w;
  vec3 rd = normalize(pf.xyz / pf.w - ro);
  // 2. Ray ∩ field box (slab test — robust to A/B being swapped per axis).
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uFieldA - ro) * inv, t1 = (uFieldB - ro) * inv;
  vec3 tmn = min(t0, t1), tmx = max(t0, t1);
  float tn = max(max(tmn.x, tmn.y), tmn.z);
  float tf = min(min(tmx.x, tmx.y), tmx.z);
  tn = max(tn, 0.0);
  if (tn >= tf) discard;                         // ray misses the field
  // 3. March for the first threshold crossing (clipped space reads empty →
  //    the clip interval cuts the blob open, matching the voxel/sphere cut).
  float t = tn, prevT = tn;
  bool hit = false;
  for (int i = 0; i < 512; i++) {
    if (i >= uMaxSteps || t > tf) break;
    vec3 p = ro + rd * t;
    float d = clipped(p) ? 0.0 : density(p);
    if (d >= uThreshold) { hit = true; break; }
    prevT = t;
    t += uStepWorld;
  }
  if (!hit) discard;
  // 4. Bisection refine between prevT (below) and t (above).
  float lo = prevT, hi = min(t, tf);
  for (int i = 0; i < 5; i++) {
    float m = 0.5 * (lo + hi);
    vec3 p = ro + rd * m;
    float d = clipped(p) ? 0.0 : density(p);
    if (d >= uThreshold) hi = m; else lo = m;
  }
  vec3 hitP = ro + rd * hi;
  // 5. Normal from the field gradient (central differences; grad points INWARD).
  float e = uStepWorld;
  vec3 g = vec3(
    density(hitP + vec3(e, 0, 0)) - density(hitP - vec3(e, 0, 0)),
    density(hitP + vec3(0, e, 0)) - density(hitP - vec3(0, e, 0)),
    density(hitP + vec3(0, 0, e)) - density(hitP - vec3(0, 0, e)));
  vec3 N = dot(g, g) < 1e-12 ? -rd : normalize(-g);
  // 6. Shade with the SAME model as FS / SPHERE_FS (+ cast shadows). View dir
  //    for the highlight = the actual per-pixel eye direction (-rd).
  vec3 base = sampleField(hitP).rgb;
  float ndl = max(0.0, dot(N, uLightDir));
  float sh = shadowFactor(hitP, ndl);
  float lum = uAmbient + uDiffuse * ndl * sh;
  vec3 col = base * lum;
  if (uSpecular > 0.0) {
    vec3 H = normalize(uLightDir - rd);
    col += uSpecular * pow(max(0.0, dot(N, H)), 32.0) * sh;
  }
  // 7. Depth — the SAME formula as SPHERE_FS so the blob interleaves with
  //    voxels / bonds / sprites.
  vec4 cpos = uMVP * vec4(hitP, 1.0);
  gl_FragDepth = (cpos.z / cpos.w) * 0.5 + 0.5;
  outColor = vec4(col, 1.0);
}`;

function compileProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, vsSrc); gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error('gl3d VS: ' + gl.getShaderInfoLog(vs));
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error('gl3d FS: ' + gl.getShaderInfoLog(fs));
  const p = gl.createProgram()!;
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('gl3d link: ' + gl.getProgramInfoLog(p));
  gl.deleteShader(vs); gl.deleteShader(fs);
  return p;
}

export class Gl3DRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private pickProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private cubeBuf: WebGLBuffer;
  private instBuf: WebGLBuffer;
  private instCapacity = 0;     // floats allocated in instBuf
  private instData: Float32Array = new Float32Array(0);
  /** Per-voxel occupancy AMBIENT OCCLUSION — one float/instance (0 = fully
   *  exposed, 1 = surrounded), a PARALLEL buffer to instBuf (attrib 4 on `vao`)
   *  so the tightly-tuned 5-lane instBuf layout + pick/sort stay untouched.
   *  Computed in uploadColors from neighbour occupancy only when light.ao is on. */
  private aoBuf: WebGLBuffer;
  private aoData: Float32Array = new Float32Array(0);
  private aoCapacity = 0;       // floats allocated in aoBuf
  /** Uint32 view over instData.buffer — the cellIndex lane (slot 0 of each 5-lane
   *  record) is written/read through THIS view so indices stay exact past 2^24
   *  (a Float32 write silently rounds odd indices to even on >16.7M-cell grids). */
  private instDataU32: Uint32Array = new Uint32Array(0);
  private W = 1; private H = 1; private D = 1;
  private alphaBlend = false;
  /** Scene lighting (see Light3D). Defaults = the historical hardcoded shade. */
  private light: Light3D = { ...DEFAULT_LIGHT3D };
  /** Voxel cube scale. 0.92 = the historical gapped lattice look; 1.001 when
   *  cell gaps are toggled OFF — deliberately NOT 1.0: exactly-coplanar shared
   *  faces of adjacent cubes z-fight along seam edges, while the hair of
   *  overlap keeps every interior face strictly behind a neighbour's outer
   *  face, so the volume renders seamless. */
  private cubeScale = 0.92;
  private clip: ClipPlane3D = { enabled: false, axis: 'z', lo: 0, hi: 0 };
  private mvp: Mat4 = mat4Identity();
  private camForward: [number, number, number] = [0, 0, -1];
  private camDir: [number, number, number] = [0, 0, 1];  // target → eye (for the gizmo)
  // Camera right/up basis (world), stashed each setCamera so the sphere
  // billboards face the camera (a stale basis points the impostors wrong).
  private camRight: [number, number, number] = [1, 0, 0];
  private camUp: [number, number, number] = [0, 1, 0];
  private viz: Viz3D = { axes: false, grid: false, bounds: false, gizmo: true, voxels: true, agents: true, bonds: true };
  /** Brush interaction plane (bounds + grid indicator). null = not shown. */
  private brushPlane: { axis: 'x' | 'y' | 'z'; pos: number } | null = null;
  /** Hovered brush FOOTPRINT — every cell the brush would affect, drawn as
   *  wireframe cube cursors. Empty = no hover. */
  private hoverCells: ReadonlyArray<{ layer: number; row: number; col: number }> = [];
  /** Brush footprint OUTLINE — a bounded wireframe (a few circles / a box) in
   *  cell space: a flat [col,row,layer, col,row,layer …] of LINE-segment endpoint
   *  pairs. Bounded geometry regardless of brush size (unlike a per-cell cursor).
   *  Null/empty = nothing to draw. */
  private brushOutline: Float32Array | null = null;
  /** Inspected cells to highlight (e.g. on inspect-dialog hover). Empty = none. */
  private inspectCells: ReadonlyArray<{ layer: number; row: number; col: number }> = [];
  /** Canvas clear colour [r,g,b,a] 0..1. Default transparent (shows the page). */
  private bgColor: [number, number, number, number] = [0, 0, 0, 0];
  /** Line overlay (axes/grid/bounds) + gizmo pipeline. */
  private lineProg: WebGLProgram;
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  /** Pick FBO. */
  private pickFbo: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private pickW = 0; private pickH = 0;
  /** Public for SimulatorView verification / DEV hooks. */
  instanceCount = 0;
  // --- Bond-Graph Agents (PR5): sphere-impostor + bond-line pipelines. ---
  private sphereProg: WebGLProgram;
  private spherePickProg: WebGLProgram;
  private sphereVao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;          // static unit-quad corners (4 verts)
  private agentInstBuf: WebGLBuffer;     // [x,y,z,radius,r,g,b,a] × 8 floats / agent
  private agentInstCapacity = 0;         // floats allocated in agentInstBuf
  private agentInstData: Float32Array = new Float32Array(0);
  /** Buffer position → ORIGINAL compacted instance index. Identity after
   *  uploadAgents; composed by sortAgentsBackToFront. The pick shader encodes
   *  gl_InstanceID (= the position in the possibly-SORTED buffer), so pickAgent
   *  must map back through this or an alpha-blend pick returns the WRONG agent
   *  (kill/move/inspect hit a different one after the sort reorders the buffer). */
  private agentInstOrder: Int32Array = new Int32Array(0);
  private agentAlphaBlend = false;
  /** Bond endpoint line list (Z-up remapped), rebuilt each uploadAgents. */
  private bondVerts: Float32Array = new Float32Array(0);
  /** Hovered / inspected agent ids (compacted instance indices) to ring. */
  private hoverAgents: ReadonlyArray<{ x: number; y: number; z: number; radius: number }> = [];
  private inspectAgents: ReadonlyArray<{ x: number; y: number; z: number; radius: number }> = [];
  /** Visible agent count (= ALIVE agents uploaded). DEV/verification. */
  agentInstanceCount = 0;
  // --- Agent SPRITES (3D billboard pass). ---
  private spriteProg: WebGLProgram;
  private spriteVao: WebGLVertexArrayObject;
  private spriteInstBuf: WebGLBuffer;      // [x,y,z,halfW,halfH,cos,sin,layer,alpha] × 9 floats
  private spriteInstData: Float32Array = new Float32Array(0);
  private spriteInstCapacity = 0;          // floats allocated in spriteInstBuf
  /** Number of sprite billboards in the last uploadAgents. DEV/verification. */
  spriteInstanceCount = 0;
  private spriteAtlasTex: WebGLTexture | null = null;
  private spriteAtlasLayers = 0;           // total layers currently allocated
  private spriteSlots = new Map<number, SpriteSlotMeta>();  // slot (1-based) → meta
  /** Fixed atlas cell size (each frame is drawn stretched to CELL×CELL; the
   *  aspect-shaped billboard quad un-stretches it — see SPRITE_VS). */
  private static readonly ATLAS_CELL = 128;
  // --- Agent METABALLS (implicit-surface agent render mode). The density field
  //     is baked LAZILY in render() from the packed agentInstData (which already
  //     carries alive-compacted positions/radii/colours + the negative-radius
  //     sprite flag), so toggling params re-bakes without a fresh snapshot. ---
  private metaballs: Metaballs3D = { ...DEFAULT_METABALLS3D };
  private metaProg: WebGLProgram;
  private metaVao: WebGLVertexArrayObject;
  private metaTex: WebGLTexture | null = null;   // TEXTURE_3D, RGBA8, LINEAR, CLAMP×3
  private metaFW = 0; private metaFH = 0; private metaFD = 0;
  /** World coords of the field's CELL-MIN / CELL-MAX corners (per-axis signs may
   *  invert vs a numeric min/max — deliberate, see the META_FS header comment). */
  private metaCornerA: [number, number, number] = [0, 0, 0];
  private metaCornerB: [number, number, number] = [0, 0, 0];
  private metaStepWorld = 0.25;
  private metaMaxSteps = 64;
  /** Params or agent data changed → re-bake before the next metaball pass. */
  private metaDirty = true;
  private metaTorus = false;                     // stashed by uploadAgents
  private metaWsum: Float32Array = new Float32Array(0);   // CPU bake scratch
  private metaCsum: Float32Array = new Float32Array(0);
  private metaBytes: Uint8Array = new Uint8Array(0);
  private static readonly META_TEX_UNIT = 2;     // 0 = sprite atlas, 1 = shadow map
  private static readonly META_F_MAX = 2.0;
  /** Cap on FW·FH·FD (≈128³) — bounds the per-step CPU bake + texture upload;
   *  past it the effective resolution is reduced (continuously, per axis). */
  private static readonly META_MAX_VOXELS = 1 << 21;
  // --- Cast shadows (global lighting). Depth-only light-space passes + a shadow
  //     depth texture the main voxel/sphere shaders PCF-sample. Created lazily
  //     the first time shadows are enabled; a 1×1 dummy keeps the sampler valid
  //     (always bound to SHADOW_TEX_UNIT) when shadows are off. ---
  private cubeShadowProg: WebGLProgram;
  private sphereShadowProg: WebGLProgram;
  private shadowFbo: WebGLFramebuffer | null = null;
  private shadowTex: WebGLTexture | null = null;
  private dummyShadowTexObj: WebGLTexture | null = null;
  private static readonly SHADOW_SIZE = 2048;
  private static readonly SHADOW_TEX_UNIT = 1;
  private lightMVP: Mat4 = mat4Identity();
  private lightRight: [number, number, number] = [1, 0, 0];
  private lightUp: [number, number, number] = [0, 1, 0];
  private shadowDepthRange = 1;   // ortho far-near span (world units) for a scale-relative bias
  private shadowUnsupported = false;  // set if the depth-only shadow FBO is incomplete (→ shadows quietly off)

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 not available for the 3D renderer');
    this.gl = gl;
    this.prog = compileProgram(gl, VS, FS);
    this.pickProg = compileProgram(gl, PICK_VS, PICK_FS);
    this.vao = gl.createVertexArray()!;
    this.cubeBuf = gl.createBuffer()!;
    this.instBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(CUBE), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    // instance buffer: [cellIndex(u32), r, g, b, a(f32)] × 5 lanes, stride 20. The
    // index lane is an INTEGER attribute (vertexAttribIPointer) — a float lane
    // cannot represent odd indices >= 2^24 (grids past ~16.7M cells).
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 20, 0); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 20, 4); gl.vertexAttribDivisor(3, 1);
    // Parallel per-instance AO buffer (attrib 4, 1 float). Only the main voxel
    // program declares location 4; the pick / shadow cube programs ignore it.
    this.aoBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aoBuf);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 4, 0); gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
    // Line pipeline (axes/grid/bounds/gizmo): pos(3) + color(3), stride 24.
    this.lineProg = compileProgram(gl, LINE_VS, LINE_FS);
    this.lineVao = gl.createVertexArray()!;
    this.lineBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    // Sphere-impostor pipeline (Bond-Graph Agents): a static unit quad (4 verts,
    // TRIANGLE_STRIP) + the per-instance [x,y,z,radius,r,g,b,a] buffer (stride 32).
    this.sphereProg = compileProgram(gl, SPHERE_VS, SPHERE_FS);
    this.spherePickProg = compileProgram(gl, SPHERE_PICK_VS, SPHERE_PICK_FS);
    this.sphereVao = gl.createVertexArray()!;
    this.quadBuf = gl.createBuffer()!;
    this.agentInstBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.sphereVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.agentInstBuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 12); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    // Sprite billboard pipeline: the SAME static unit quad (attrib 0, from quadBuf)
    // + a per-instance [x,y,z,halfW,halfH,cos,sin,layer,alpha] buffer (stride 36).
    this.spriteProg = compileProgram(gl, SPRITE_VS, SPRITE_FS);
    this.spriteVao = gl.createVertexArray()!;
    this.spriteInstBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.spriteVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteInstBuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 36, 12); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 36, 20); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 36, 28); gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, 36, 32); gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);
    // Metaball raymarch pipeline: the SAME static unit quad (attrib 0, from
    // quadBuf) on its own tiny VAO (keeps instanced-attrib divisors out of the
    // fullscreen pass).
    this.metaProg = compileProgram(gl, META_VS, META_FS);
    this.metaVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.metaVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    // Cast-shadow depth programs (reuse the cube VAO + sphere VAO — they read only
    // aPos/aCellIndex resp. aCorner/aPos/aRadius; the extra attribs are ignored).
    this.cubeShadowProg = compileProgram(gl, CUBE_SHADOW_VS, CUBE_SHADOW_FS);
    this.sphereShadowProg = compileProgram(gl, SPHERE_SHADOW_VS, SPHERE_SHADOW_FS);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
  }

  setGrid(w: number, h: number, d: number): void {
    this.W = Math.max(1, w); this.H = Math.max(1, h); this.D = Math.max(1, d);
  }
  setAlphaBlend(on: boolean): void { this.alphaBlend = on; }
  /** Scene lighting (voxels + agent spheres). See Light3D / DEFAULT_LIGHT3D. */
  setLight(l: Light3D): void { this.light = l; }
  /** Gaps between adjacent voxel cells (the 3D analogue of the 2D gridlines
   *  toggle). ON = the historical 0.92 cube scale; OFF = flush cubes (1.001 —
   *  see the cubeScale field for why not exactly 1.0). The pick pass shares
   *  the uniform, so clicking "between" cells matches what's drawn. */
  setCellGaps(on: boolean): void { this.cubeScale = on ? 0.92 : 1.001; }

  /** Resolve the light's WORLD direction for this frame: camera mode combines
   *  the ball position with the current camera basis (light rides the view);
   *  world mode returns the stored scene-fixed vector. */
  private lightWorldDir(): [number, number, number] {
    const l = this.light;
    if (l.mode === 'world') {
      const n = Math.hypot(l.wx, l.wy, l.wz) || 1;
      return [l.wx / n, l.wy / n, l.wz / n];
    }
    const bz = Math.sqrt(Math.max(0, 1 - l.bx * l.bx - l.by * l.by));
    const r = this.camRight, u = this.camUp, d = this.camDir;  // camDir = toward viewer
    const x = r[0] * l.bx + u[0] * l.by + d[0] * bz;
    const y = r[1] * l.bx + u[1] * l.by + d[1] * bz;
    const z = r[2] * l.bx + u[2] * l.by + d[2] * bz;
    const n = Math.hypot(x, y, z) || 1;
    return [x / n, y / n, z / n];
  }

  /** Upload the shared lighting uniforms (null locations — e.g. on the pick
   *  programs, which don't declare them — are silent no-ops per the GL spec). */
  private setLightUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): void {
    const L = this.lightWorldDir();
    gl.uniform3f(gl.getUniformLocation(prog, 'uLightDir'), L[0], L[1], L[2]);
    gl.uniform1f(gl.getUniformLocation(prog, 'uAmbient'), this.light.ambient);
    gl.uniform1f(gl.getUniformLocation(prog, 'uDiffuse'), this.light.diffuse);
    gl.uniform1f(gl.getUniformLocation(prog, 'uSpecular'), this.light.specular);
    gl.uniform3f(gl.getUniformLocation(prog, 'uViewDir'), this.camDir[0], this.camDir[1], this.camDir[2]);
    // Cast-shadow uniforms (voxel + sphere programs; null on pick/line = no-op).
    // The shadow map (or a 1×1 dummy when off) is ALWAYS bound to a dedicated unit
    // so the sampler2DShadow stays valid; the FS branches out on uShadowEnabled=0.
    const shadowsOn = this.light.shadows && !this.shadowUnsupported;
    gl.uniform1i(gl.getUniformLocation(prog, 'uShadowEnabled'), shadowsOn ? 1 : 0);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uLightMVP'), false, this.lightMVP);
    gl.uniform1f(gl.getUniformLocation(prog, 'uShadowStrength'), this.light.shadowStrength);
    const texel = 1 / Gl3DRenderer.SHADOW_SIZE;
    gl.uniform2f(gl.getUniformLocation(prog, 'uShadowTexel'), texel, texel);
    // ~0.9 world-unit (≈1 cell) base bias mapped into the light's [0,1] depth range
    // (scale-relative → avoids acne on small grids AND peter-panning on huge ones).
    gl.uniform1f(gl.getUniformLocation(prog, 'uShadowBias'), Math.min(0.02, Math.max(0.0002, 0.9 / (this.shadowDepthRange || 1))));
    gl.activeTexture(gl.TEXTURE0 + Gl3DRenderer.SHADOW_TEX_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, shadowsOn && this.shadowTex ? this.shadowTex : this.ensureDummyShadowTex());
    gl.uniform1i(gl.getUniformLocation(prog, 'uShadowMap'), Gl3DRenderer.SHADOW_TEX_UNIT);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Clip-interval uniforms (shared by the shadow depth passes). */
  private setClipUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): void {
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipEnabled'), this.clip.enabled ? 1 : 0);
    const axisN = this.clip.axis === 'x' ? 0 : this.clip.axis === 'y' ? 1 : this.clip.axis === 'z' ? 2 : 3;
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipAxis'), axisN);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipLo'), this.clip.lo);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipHi'), this.clip.hi);
    gl.uniform3f(gl.getUniformLocation(prog, 'uClipForward'), this.camForward[0], this.camForward[1], this.camForward[2]);
  }

  /** Directional shadow-map light matrix (ortho, fitting the volume's bounding
   *  sphere so it's stable at any light angle) + the light-perpendicular billboard
   *  axes for the sphere shadow caster. */
  private computeLightMVP(): void {
    const R = Math.hypot((this.W - 1) / 2 + 0.5, (this.H - 1) / 2 + 0.5, (this.D - 1) / 2 + 0.5) || 1;
    const L = this.lightWorldDir();  // dir toward the light (world centred at origin)
    const up: [number, number, number] = Math.abs(L[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    const eye: [number, number, number] = [L[0] * 2 * R, L[1] * 2 * R, L[2] * 2 * R];
    const view = mat4LookAt(eye, [0, 0, 0], up);
    const proj = mat4Ortho(-R, R, -R, R, 0.5 * R, 3.5 * R);
    this.lightMVP = mat4Mul(proj, view);
    this.shadowDepthRange = 3 * R;  // far - near, for the scale-relative depth bias
    // Billboard axes ⟂ L (cross(up,L) → right, cross(L,right) → up).
    let rx = up[1] * L[2] - up[2] * L[1], ry = up[2] * L[0] - up[0] * L[2], rz = up[0] * L[1] - up[1] * L[0];
    const rn = Math.hypot(rx, ry, rz) || 1; rx /= rn; ry /= rn; rz /= rn;
    this.lightRight = [rx, ry, rz];
    this.lightUp = [L[1] * rz - L[2] * ry, L[2] * rx - L[0] * rz, L[0] * ry - L[1] * rx];
  }

  /** Create the shadow depth texture + FBO (lazy — only when shadows first turn
   *  on). LINEAR + COMPARE_REF gives free 2×2 hardware PCF per tap. */
  private ensureShadowFbo(): void {
    if (this.shadowFbo || this.shadowUnsupported) return;
    const gl = this.gl, S = Gl3DRenderer.SHADOW_SIZE;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, S, S, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (!ok) {  // driver can't do a depth-only shadow FBO → quietly disable shadows
      gl.deleteFramebuffer(this.shadowFbo); gl.deleteTexture(this.shadowTex);
      this.shadowFbo = null; this.shadowTex = null; this.shadowUnsupported = true;
    }
  }

  /** A 1×1 depth-compare texture kept bound to SHADOW_TEX_UNIT while shadows are
   *  off, so the sampler2DShadow is always valid (never sampled — uShadowEnabled=0). */
  private ensureDummyShadowTex(): WebGLTexture {
    if (this.dummyShadowTexObj) return this.dummyShadowTexObj;
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.dummyShadowTexObj = t;
    return t;
  }

  /** Render the voxel cubes + agent spheres from the light POV into the shadow
   *  depth texture (no-op when shadows are off). Runs before the main pass. */
  private renderShadowMap(): void {
    if (!this.light.shadows || this.shadowUnsupported) return;
    const gl = this.gl, S = Gl3DRenderer.SHADOW_SIZE;
    this.ensureShadowFbo();
    if (!this.shadowFbo) return;  // creation failed (unsupported) → skip
    this.computeLightMVP();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, S, S);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    if (this.viz.voxels && this.instanceCount > 0) {
      gl.useProgram(this.cubeShadowProg);
      gl.bindVertexArray(this.vao);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.cubeShadowProg, 'uLightMVP'), false, this.lightMVP);
      gl.uniform1ui(gl.getUniformLocation(this.cubeShadowProg, 'uWu'), this.W);
      gl.uniform1ui(gl.getUniformLocation(this.cubeShadowProg, 'uWHu'), this.W * this.H);
      gl.uniform3f(gl.getUniformLocation(this.cubeShadowProg, 'uHalf'), hx, hy, hz);
      gl.uniform1f(gl.getUniformLocation(this.cubeShadowProg, 'uCubeScale'), this.cubeScale);
      this.setClipUniforms(gl, this.cubeShadowProg);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.instanceCount);
      gl.bindVertexArray(null);
    }
    if (this.viz.agents && this.agentInstanceCount > 0) {
      const L = this.lightWorldDir();
      gl.useProgram(this.sphereShadowProg);
      gl.bindVertexArray(this.sphereVao);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.sphereShadowProg, 'uLightMVP'), false, this.lightMVP);
      gl.uniform3f(gl.getUniformLocation(this.sphereShadowProg, 'uHalf'), hx, hy, hz);
      gl.uniform3f(gl.getUniformLocation(this.sphereShadowProg, 'uLightRight'), this.lightRight[0], this.lightRight[1], this.lightRight[2]);
      gl.uniform3f(gl.getUniformLocation(this.sphereShadowProg, 'uLightUp'), this.lightUp[0], this.lightUp[1], this.lightUp[2]);
      gl.uniform3f(gl.getUniformLocation(this.sphereShadowProg, 'uLightDirW'), L[0], L[1], L[2]);
      this.setClipUniforms(gl, this.sphereShadowProg);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.agentInstanceCount);
      gl.bindVertexArray(null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** "Draw agents in front" (default ON — the historical behaviour): agents render
   *  over the CA-grid VOXELS regardless of depth (the grid usually surrounds the
   *  agents completely and would hide them). The helper overlays (axes / floor
   *  grid / bounds / brush plane) keep NORMAL depth occlusion vs the agents either
   *  way — see render(). OFF = full normal depth (useful when the grid field is
   *  sparse enough to see both layers interleaved). */
  setAgentsInFront(on: boolean): void { this.agentsInFront = on; }
  private agentsInFront = true;
  setClipPlane(clip: ClipPlane3D): void { this.clip = clip; }
  setViz(viz: Viz3D): void { this.viz = viz; }
  setBrushPlane(p: { axis: 'x' | 'y' | 'z'; pos: number } | null): void { this.brushPlane = p; }
  /** Set the hovered brush footprint (every affected cell). Pass [] to clear. */
  setHoverCells(cells: ReadonlyArray<{ layer: number; row: number; col: number }>): void { this.hoverCells = cells; }
  /** Set the brush footprint OUTLINE (cell-space line-segment endpoint pairs).
   *  Pass null to clear. */
  setBrushOutline(pts: Float32Array | null): void { this.brushOutline = pts; }
  /** Set the inspected cells to highlight (white cube). Pass [] to clear. */
  setInspectCells(cells: ReadonlyArray<{ layer: number; row: number; col: number }>): void { this.inspectCells = cells; }
  /** Canvas background. `null` → transparent (page shows through). */
  setBackgroundColor(c: [number, number, number, number] | null): void { this.bgColor = c ?? [0, 0, 0, 0]; }

  /** (Re)build the sprite atlas from decoded sprite frames. Each (sprite, frame)
   *  becomes one CELL×CELL layer of a TEXTURE_2D_ARRAY (frames drawn STRETCHED to
   *  the square cell; the aspect-shaped billboard quad un-stretches them). The
   *  per-slot meta drives the billboard frame/rotation/size. Pass [] to clear (a
   *  non-sprite model). SimulatorView calls it only when the sprite set / decoded
   *  frames change, so the resize + upload cost is one-off. */
  setSpriteAtlas(sprites: ReadonlyArray<SpriteAtlasInput>): void {
    const gl = this.gl;
    this.spriteSlots.clear();
    let totalLayers = 0;
    for (const s of sprites) totalLayers += Math.max(0, s.frames.length);
    if (totalLayers === 0) {
      if (this.spriteAtlasTex) { gl.deleteTexture(this.spriteAtlasTex); this.spriteAtlasTex = null; }
      this.spriteAtlasLayers = 0;
      this.spriteInstanceCount = 0;
      return;
    }
    const CELL = Gl3DRenderer.ATLAS_CELL;
    if (!this.spriteAtlasTex || this.spriteAtlasLayers !== totalLayers) {
      if (this.spriteAtlasTex) gl.deleteTexture(this.spriteAtlasTex);
      this.spriteAtlasTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.spriteAtlasTex);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, CELL, CELL, totalLayers, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.spriteAtlasLayers = totalLayers;
    } else {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.spriteAtlasTex);
    }
    // Reusable CELL×CELL scratch canvas to stretch each native-size frame into a
    // square layer (straight-alpha, no premultiply — the FS blends with SRC_ALPHA).
    const scratch: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(CELL, CELL)
      : (() => { const c = document.createElement('canvas'); c.width = CELL; c.height = CELL; return c; })();
    const sctx = scratch.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    let layer = 0;
    for (const s of sprites) {
      if (s.frames.length === 0) continue;
      const f0 = s.frames[0]!;
      this.spriteSlots.set(s.slot, {
        baseLayer: layer, frameCount: s.frames.length,
        aspect: f0.width / Math.max(1, f0.height),
        loop: s.loop, defaultDirection: s.defaultDirection,
        rotationOffset: s.rotationOffset, orientToVelocity: s.orientToVelocity,
        scale: s.scale > 0 ? s.scale : 1,
      });
      for (const f of s.frames) {
        sctx.clearRect(0, 0, CELL, CELL);
        sctx.drawImage(f, 0, 0, CELL, CELL);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, CELL, CELL, 1, gl.RGBA, gl.UNSIGNED_BYTE, scratch as TexImageSource);
        layer++;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  /** Compute the view-projection matrix from the Z-up orbit camera. */
  setCamera(cam: Camera3D, aspect: number): void {
    const r = cam.dist * Math.max(this.W, this.H, this.D);
    const basis = cameraBasis(cam);
    const dir = basis.dir;
    const t = cam.target;
    const eye: [number, number, number] = [t[0] + r * dir[0], t[1] + r * dir[1], t[2] + r * dir[2]];
    this.camForward = [-dir[0], -dir[1], -dir[2]];
    this.camDir = dir;
    // Stash the camera right/up basis so the sphere billboards face the camera.
    // cameraBasis already returns right/up for forward = -dir (re-derived every
    // setCamera — orbit changes them, a stale basis points the impostors wrong).
    this.camRight = basis.right;
    this.camUp = basis.up;
    const proj = mat4Perspective(Math.PI / 4, aspect || 1, 0.05, r * 8 + 100);
    // Camera "roll" at the ±Depth POVs: looking down/up the Z (depth) axis makes
    // WORLD_UP (+Z) parallel to the view → lookAt degenerate. Override with a
    // Y-up so the top view matches the 2D CA (look down -Z → up +Y → col-right,
    // row-down) and the bottom view mirrors it (look up +Z → up -Y). General
    // orbit (clamped to |pitch|≤1.5 → |fwd.z|≤0.997) keeps WORLD_UP.
    const up: [number, number, number] = Math.abs(this.camForward[2]) > 0.999
      ? [0, this.camForward[2] > 0 ? -1 : 1, 0]
      : WORLD_UP;
    const view = mat4LookAt(eye, [t[0], t[1], t[2]], up);
    this.mvp = mat4Mul(proj, view);
  }

  /** Scan the RGBA colors buffer for alpha>0 cells, compact into the instance
   *  buffer. NEVER instances the full volume. Returns the visible count. */
  uploadColors(colors: Uint8ClampedArray, total: number): number {
    const need = total * 5;
    if (this.instData.length < need) {
      this.instData = new Float32Array(need);
      this.instDataU32 = new Uint32Array(this.instData.buffer);
    }
    const d = this.instData;
    const u = this.instDataU32;
    // Occupancy AO: darken cells by how many of their 6 face-neighbours are
    // filled (crevices/interiors → darker), so a packed volume reads as one solid
    // form instead of flat-shaded cubes. Only computed when AO is enabled (an
    // opt-in cost that folds into this per-step scan); otherwise the parallel
    // buffer is left as-is (multiplied by uAOStrength=0 in the FS, so ignored).
    const aoOn = this.light.ao;
    if (aoOn && this.aoData.length < total) this.aoData = new Float32Array(total);
    const ao = this.aoData;
    const W = this.W, H = this.H, D = this.D, WH = W * H;
    let col = 0, row = 0, layer = 0;
    let n = 0;
    for (let i = 0; i < total; i++) {
      const a = colors[i * 4 + 3]!;
      if (a !== 0) {
        const o = n * 5;
        u[o] = i;  // u32 lane — exact for any grid size (f32 rounds past 2^24)
        d[o + 1] = colors[i * 4]! / 255;
        d[o + 2] = colors[i * 4 + 1]! / 255;
        d[o + 3] = colors[i * 4 + 2]! / 255;
        d[o + 4] = a / 255;
        if (aoOn) {
          let cnt = 0;
          if (col > 0 && colors[(i - 1) * 4 + 3]! !== 0) cnt++;
          if (col < W - 1 && colors[(i + 1) * 4 + 3]! !== 0) cnt++;
          if (row > 0 && colors[(i - W) * 4 + 3]! !== 0) cnt++;
          if (row < H - 1 && colors[(i + W) * 4 + 3]! !== 0) cnt++;
          if (layer > 0 && colors[(i - WH) * 4 + 3]! !== 0) cnt++;
          if (layer < D - 1 && colors[(i + WH) * 4 + 3]! !== 0) cnt++;
          ao[n] = cnt / 6;
        }
        n++;
      }
      // Advance the (col,row,layer) of cell i — only tracked when AO is on (the
      // off path stays as cheap as the historical scan).
      if (aoOn && ++col >= W) { col = 0; if (++row >= H) { row = 0; layer++; } }
    }
    this.instanceCount = n;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    if (this.instCapacity < n * 5) {
      gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
      this.instCapacity = d.length;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, n * 5));
    }
    // Upload the parallel AO buffer. Grow allocates (keeping the attrib valid even
    // when AO is off); when AO is on we refresh it each step; when off + no grow we
    // skip (the buffered values are ×0 in the shader).
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aoBuf);
    if (this.aoCapacity < n) {
      gl.bufferData(gl.ARRAY_BUFFER, ao.length >= n ? ao : new Float32Array(n), gl.DYNAMIC_DRAW);
      this.aoCapacity = Math.max(n, ao.length);
    } else if (aoOn) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ao.subarray(0, n));
    }
    return n;
  }

  /** Back-to-front sort of the instance buffer by camera depth (Option A blend).
   *  Only call when alpha blending is enabled; opaque rendering needs no sort. */
  private sortBackToFront(): void {
    const n = this.instanceCount;
    if (n < 2) return;
    const u = this.instDataU32;
    const W = this.W, WH = this.W * this.H;
    const hx = (W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    // eye direction approximated from the MVP isn't trivial; sort by -z of the
    // transformed centre. Build keys then index-sort, then rewrite the buffer.
    const m = this.mvp;
    const keys = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const idx = u[k * 5]!;  // u32 lane (see instDataU32)
      const layer = Math.floor(idx / WH);
      const rem = idx - layer * WH;
      const row = Math.floor(rem / W);
      const col = rem - row * W;
      const cx = col - hx, cy = hy - row, cz = hz - layer;  // Z-up (row→-Y)
      // clip-space w (depth proxy): row3 of MVP · centre
      keys[k] = m[2]! * cx + m[6]! * cy + m[10]! * cz + m[14]!;
    }
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => keys[b]! - keys[a]!);
    // Copy the mixed u32/f32 records through the u32 view — a bit-exact lane copy
    // (reading the u32 index lane through the FLOAT view would reinterpret it).
    const sorted = new Uint32Array(n * 5);
    for (let k = 0; k < n; k++) {
      const s = order[k]! * 5;
      sorted.set(u.subarray(s, s + 5), k * 5);
    }
    u.set(sorted);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sorted);
    // Keep the parallel AO buffer in step with the reordered instances.
    if (this.light.ao && this.aoData.length >= n) {
      const ao = this.aoData;
      const sortedAo = new Float32Array(n);
      for (let k = 0; k < n; k++) sortedAo[k] = ao[order[k]!]!;
      ao.set(sortedAo.subarray(0, n));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.aoBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, sortedAo);
    }
  }

  // ------------------------------------------------------------------------
  // Bond-Graph Agents (PR5): sphere-impostor + bond-line upload / render / pick.
  // ------------------------------------------------------------------------
  setAgentAlphaBlend(on: boolean): void { this.agentAlphaBlend = on; }
  /** Agent metaballs config. `threshold` is a pure shader uniform (no re-bake);
   *  the other fields invalidate the baked field. */
  setMetaballs(cfg: Metaballs3D): void {
    const p = this.metaballs;
    if (p.enabled !== cfg.enabled || p.influence !== cfg.influence || p.resolution !== cfg.resolution) this.metaDirty = true;
    this.metaballs = { ...cfg };
  }
  /** Drop ALL agent geometry (spheres AND bond lines). Used when a non-agent /
   *  freshly-loaded model must not keep the previous model's agents lingering —
   *  zeroing agentInstanceCount alone leaves stale bondVerts drawing. */
  clearAgents(): void { this.agentInstanceCount = 0; this.spriteInstanceCount = 0; this.bondVerts = new Float32Array(0); this.metaDirty = true; }
  /** True when the renderer holds any agent geometry (spheres OR bond lines). */
  get hasAgentGeometry(): boolean { return this.agentInstanceCount > 0 || this.bondVerts.length > 0; }
  /** Highlight rings for the hovered / inspected agents (world geometry).
   *  Pass [] to clear. Drawn as wireframe rings with depth OFF (always visible). */
  setHoverAgents(agents: ReadonlyArray<{ x: number; y: number; z: number; radius: number }>): void { this.hoverAgents = agents; }
  setInspectAgents(agents: ReadonlyArray<{ x: number; y: number; z: number; radius: number }>): void { this.inspectAgents = agents; }

  /** Compact the ALIVE agents from the render snapshot into the per-instance
   *  buffer ([x,y,z,radius,r,g,b,a]) and (re)build the bond endpoint line list.
   *  Walks `alive` ASCENDING — the SAME direction `pickAgent`'s instance ids
   *  count, so `instanceToSlot` can map an instance index back to a slot. Reads
   *  `z[i] ?? 0` (RR-0) so it ships against the 2D engine (flat layer-0 sheet). */
  uploadAgents(snap: AgentSnapshot3D, torus: boolean): number {
    const hw = snap.highWater;
    const need = hw * 8;
    if (this.agentInstData.length < need) this.agentInstData = new Float32Array(need);
    const d = this.agentInstData;
    const hasZ = snap.z.length > 0;
    // Sprite pass inputs: active only when the model has decoded sprites AND the
    // snapshot carries a per-agent slot for every agent (length-0 otherwise → every
    // agent draws a sphere, byte-identical to a non-sprite model).
    const sids = snap.spriteIds, sfr = snap.spriteFrames, srot = snap.spriteRotations, sscl = snap.spriteScales;
    const svx = snap.vx, svy = snap.vy;
    const spritesActive = this.spriteSlots.size > 0 && sids.length === hw;
    const sp = spritesActive ? this.ensureSpriteCapacity(hw) : null;
    let ns = 0;  // sprite billboard count
    let n = 0;
    for (let i = 0; i < hw; i++) {
      if (!snap.alive[i]) continue;
      const o = n * 8;
      const x = snap.x[i]!, y = snap.y[i]!, z = hasZ ? snap.z[i]! : 0;
      d[o] = x;
      d[o + 1] = y;
      d[o + 2] = z;
      const c = i * 4;
      // A decoded, in-slot sprite-agent draws a billboard (below) instead of the
      // sphere; flag it via a NEGATIVE radius so the sphere FS discards it while
      // pick + the buffer stride stay unchanged. The magnitude is the sprite's
      // effective half-extent (not the raw radius) so the invisible pick-sphere
      // covers the whole scaled/aspect-shaped billboard — clicking the sprite's
      // edge to move/inspect/edit it registers.
      let isSprite = false;
      let spritePickR = 0;
      if (sp && sids[i]! > 0) {
        const meta = this.spriteSlots.get(sids[i]!);
        if (meta) {
          const fc = meta.frameCount;
          const raw = Math.floor(sfr[i]!);
          const frame = fc <= 1 ? 0 : meta.loop ? (((raw % fc) + fc) % fc) : (raw < 0 ? 0 : raw >= fc ? fc - 1 : raw);
          const perScale = (sscl.length === hw && sscl[i]! > 0) ? sscl[i]! : meta.scale;
          const diameter = snap.radius[i]! * 2 * perScale;
          const aspect = meta.aspect;
          let halfW = diameter / 2, halfH = diameter / 2;
          if (aspect >= 1) halfH = diameter / (2 * aspect); else halfW = (diameter * aspect) / 2;
          spritePickR = Math.max(halfW, halfH);  // pick-sphere covers the billboard
          // Facing: the per-agent rotation the node set (compass deg, 0 = up),
          // OR the world-XY velocity heading when the asset auto-orients (matches
          // the 2D atan2(vx,-vy) convention). Aligned to the art's default + offset.
          let facingDeg = srot.length === hw ? srot[i]! : 0;
          if (meta.orientToVelocity && svx.length === hw) {
            const vX = svx[i]!, vY = svy[i]!;
            if (vX * vX + vY * vY > 1e-9) facingDeg = Math.atan2(vX, -vY) * 180 / Math.PI;
          }
          const rr = ((facingDeg - meta.defaultDirection) + meta.rotationOffset) * Math.PI / 180;
          const so = ns * 9;
          sp[so] = x; sp[so + 1] = y; sp[so + 2] = z;
          sp[so + 3] = halfW; sp[so + 4] = halfH;
          sp[so + 5] = Math.cos(rr); sp[so + 6] = Math.sin(rr);
          sp[so + 7] = meta.baseLayer + frame;
          sp[so + 8] = snap.colors[c + 3]! / 255;
          ns++;
          isSprite = true;
        }
      }
      d[o + 3] = isSprite ? -spritePickR : snap.radius[i]!;
      d[o + 4] = snap.colors[c]! / 255;
      d[o + 5] = snap.colors[c + 1]! / 255;
      d[o + 6] = snap.colors[c + 2]! / 255;
      d[o + 7] = snap.colors[c + 3]! / 255;
      n++;
    }
    this.agentInstanceCount = n;
    this.spriteInstanceCount = ns;
    // Fresh agent data → the metaball field (baked lazily from agentInstData in
    // render()) is stale. Camera-only frames never re-upload, so never re-bake.
    this.metaDirty = true;
    this.metaTorus = torus;
    if (sp && ns > 0) {
      const gl2 = this.gl;
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.spriteInstBuf);
      if (this.spriteInstCapacity < ns * 9) {
        gl2.bufferData(gl2.ARRAY_BUFFER, sp, gl2.DYNAMIC_DRAW);
        this.spriteInstCapacity = sp.length;
      } else {
        gl2.bufferSubData(gl2.ARRAY_BUFFER, 0, sp.subarray(0, ns * 9));
      }
    }
    // Fresh upload = compacted order → identity permutation.
    if (this.agentInstOrder.length < n) this.agentInstOrder = new Int32Array(Math.max(n, 16));
    for (let k = 0; k < n; k++) this.agentInstOrder[k] = k;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.agentInstBuf);
    if (this.agentInstCapacity < n * 8) {
      gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
      this.agentInstCapacity = d.length;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, n * 8));
    }
    // Bonds: Z-up remapped endpoint pairs. Fold across the ±W/±H/±D seams when the
    // model is a torus so a seam-crossing bond draws as a short segment (RR-G4).
    const bonds = snap.bonds;
    if (bonds && bonds.length > 0) {
      const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
      const verts = new Float32Array(bonds.length * 6);  // 2 endpoints × 6 floats / pair
      const W = this.W, H = this.H, Dd = this.D;
      let p = 0;
      const col: [number, number, number] = [0.90, 0.90, 0.96];
      for (let b = 0; b < bonds.length; b += 2) {
        const i = bonds[b]!, j = bonds[b + 1]!;
        const ix = snap.x[i]!, iy = snap.y[i]!, iz = hasZ ? snap.z[i]! : 0;
        let jx = snap.x[j]!, jy = snap.y[j]!, jz = hasZ ? snap.z[j]! : 0;
        if (torus) {
          if (jx - ix > W / 2) jx -= W; else if (jx - ix < -W / 2) jx += W;
          if (jy - iy > H / 2) jy -= H; else if (jy - iy < -H / 2) jy += H;
          if (Dd > 1) { if (jz - iz > Dd / 2) jz -= Dd; else if (jz - iz < -Dd / 2) jz += Dd; }
        }
        verts[p++] = ix - hx; verts[p++] = hy - iy; verts[p++] = hz - iz; verts[p++] = col[0]; verts[p++] = col[1]; verts[p++] = col[2];
        verts[p++] = jx - hx; verts[p++] = hy - jy; verts[p++] = hz - jz; verts[p++] = col[0]; verts[p++] = col[1]; verts[p++] = col[2];
      }
      this.bondVerts = verts;
    } else {
      this.bondVerts = new Float32Array(0);
    }
    return n;
  }

  /** Grow + return the CPU-side sprite instance scratch to hold `hw` billboards
   *  (9 floats each). Reused across frames. */
  private ensureSpriteCapacity(hw: number): Float32Array {
    const need = hw * 9;
    if (this.spriteInstData.length < need) this.spriteInstData = new Float32Array(need);
    return this.spriteInstData;
  }

  /** Draw the sprite billboards (camera-facing textured quads from the atlas) for
   *  the sprite-agents. Runs AFTER the sphere pass in render(); the sprites depth-
   *  interleave with spheres/voxels (depth-test on) and blend by their alpha. */
  private renderSprites(): void {
    if (this.spriteInstanceCount === 0 || !this.spriteAtlasTex) return;
    const gl = this.gl;
    gl.useProgram(this.spriteProg);
    gl.bindVertexArray(this.spriteVao);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.spriteProg, 'uMVP'), false, this.mvp);
    gl.uniform3f(gl.getUniformLocation(this.spriteProg, 'uHalf'), (this.W - 1) / 2, (this.H - 1) / 2, (this.D - 1) / 2);
    gl.uniform3f(gl.getUniformLocation(this.spriteProg, 'uCamRight'), this.camRight[0], this.camRight[1], this.camRight[2]);
    gl.uniform3f(gl.getUniformLocation(this.spriteProg, 'uCamUp'), this.camUp[0], this.camUp[1], this.camUp[2]);
    gl.uniform1i(gl.getUniformLocation(this.spriteProg, 'uClipEnabled'), this.clip.enabled ? 1 : 0);
    const axisN = this.clip.axis === 'x' ? 0 : this.clip.axis === 'y' ? 1 : this.clip.axis === 'z' ? 2 : 3;
    gl.uniform1i(gl.getUniformLocation(this.spriteProg, 'uClipAxis'), axisN);
    gl.uniform1f(gl.getUniformLocation(this.spriteProg, 'uClipLo'), this.clip.lo);
    gl.uniform1f(gl.getUniformLocation(this.spriteProg, 'uClipHi'), this.clip.hi);
    gl.uniform3f(gl.getUniformLocation(this.spriteProg, 'uClipForward'), this.camForward[0], this.camForward[1], this.camForward[2]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.spriteAtlasTex);
    gl.uniform1i(gl.getUniformLocation(this.spriteProg, 'uAtlas'), 0);
    // Transparent-agent-friendly: depth-test on (occlude behind spheres/voxels),
    // depth-write off, alpha blend. Fully-transparent texels are discarded in the FS.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spriteInstanceCount);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.bindVertexArray(null);
  }

  /** Back-to-front sort of the agent instance buffer (alpha blend, Option A).
   *  Mirrors the cube sortBackToFront but reads the world position directly. */
  private sortAgentsBackToFront(): void {
    const n = this.agentInstanceCount;
    if (n < 2) return;
    const d = this.agentInstData;
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    const m = this.mvp;
    const keys = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const o = k * 8;
      const cx = d[o]! - hx, cy = hy - d[o + 1]!, cz = hz - d[o + 2]!;  // Z-up
      keys[k] = m[2]! * cx + m[6]! * cy + m[10]! * cz + m[14]!;
    }
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => keys[b]! - keys[a]!);
    const sorted = new Float32Array(n * 8);
    for (let k = 0; k < n; k++) sorted.set(d.subarray(order[k]! * 8, order[k]! * 8 + 8), k * 8);
    d.set(sorted.subarray(0, n * 8));
    // Compose the position→compacted-index permutation so pickAgent can undo
    // the reorder (the pick shader encodes the SORTED buffer position).
    const prevOrder = this.agentInstOrder.slice(0, n);
    for (let k = 0; k < n; k++) this.agentInstOrder[k] = prevOrder[order[k]!]!;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.agentInstBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sorted);
  }

  /** Sphere-shader uniforms (the camera billboard basis + half-extents + clip). */
  private setSphereUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): void {
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, this.mvp);
    gl.uniform3f(gl.getUniformLocation(prog, 'uHalf'), (this.W - 1) / 2, (this.H - 1) / 2, (this.D - 1) / 2);
    gl.uniform3f(gl.getUniformLocation(prog, 'uCamRight'), this.camRight[0], this.camRight[1], this.camRight[2]);
    gl.uniform3f(gl.getUniformLocation(prog, 'uCamUp'), this.camUp[0], this.camUp[1], this.camUp[2]);
    gl.uniform3f(gl.getUniformLocation(prog, 'uCamForward'), this.camForward[0], this.camForward[1], this.camForward[2]);
    this.setLightUniforms(gl, prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipEnabled'), this.clip.enabled ? 1 : 0);
    const axisN = this.clip.axis === 'x' ? 0 : this.clip.axis === 'y' ? 1 : this.clip.axis === 'z' ? 2 : 3;
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipAxis'), axisN);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipLo'), this.clip.lo);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipHi'), this.clip.hi);
    gl.uniform3f(gl.getUniformLocation(prog, 'uClipForward'), this.camForward[0], this.camForward[1], this.camForward[2]);
  }

  /** Draw the bond lines (depth-tested). Pass the active clip so bonds respect the
   *  clip interval like the voxels/spheres (the only LINE-program draw that does). */
  private renderBonds(): void {
    if (this.bondVerts.length === 0) return;
    this.drawLines(this.bondVerts, this.gl.LINES, this.mvp, 1, this.clip.enabled ? this.clip : null);
  }

  /** Draw the agent sphere impostors via instanced billboards. Opaque agents
   *  render depth-write-on; translucent agents (alpha blend) sort back-to-front
   *  + depth-write-off (Option A — the cube path's blend rule). */
  private renderAgents(): void {
    if (this.agentInstanceCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.sphereProg);
    gl.bindVertexArray(this.sphereVao);
    this.setSphereUniforms(gl, this.sphereProg);
    if (this.agentAlphaBlend) {
      this.sortAgentsBackToFront();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    } else {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.agentInstanceCount);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /** Bake the agents' summed density field into the RGBA8 3D texture (CPU splat).
   *  Reads the packed agentInstData — alive-compacted, colours 0..1, sprite-agents
   *  flagged by a NEGATIVE radius (excluded: they draw as billboards). The field
   *  covers the agents' influence bounding box (torus worlds bake the FULL world
   *  with wrapped splats, since agents can span the seam). Per voxel:
   *  A = clamp(Σw / F_MAX), RGB = Σ(w·colour)/Σw (density-weighted colour). */
  private bakeMetaballField(): void {
    this.metaDirty = false;
    const n = this.agentInstanceCount;
    const d = this.agentInstData;
    const influence = Math.max(1, this.metaballs.influence);
    // Pass 1 — collect the non-sprite agents' cell-space influence AABB.
    let count = 0, maxR = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < n; k++) {
      const o = k * 8;
      const r = d[o + 3]!;
      if (r <= 0) continue;                     // sprite-agent flag / degenerate
      count++;
      const R = influence * r;
      if (R > maxR) maxR = R;
      const x = d[o]!, y = d[o + 1]!, z = d[o + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (count === 0) { this.metaFW = 0; return; }
    // Field box in CELL coords. Torus → the full world (agents wrap across the
    // seam, so a tight bbox is meaningless AND the splat must wrap — see below).
    const torus = this.metaTorus;
    const pad = maxR + 1;
    const bx0 = torus ? -0.5 : minX - pad, bx1 = torus ? this.W - 0.5 : maxX + pad;
    const by0 = torus ? -0.5 : minY - pad, by1 = torus ? this.H - 0.5 : maxY + pad;
    const bz0 = torus ? -0.5 : minZ - pad, bz1 = torus ? this.D - 0.5 : maxZ + pad;
    const sx = Math.max(1e-3, bx1 - bx0), sy = Math.max(1e-3, by1 - by0), sz = Math.max(1e-3, bz1 - bz0);
    // Effective resolution: the user's setting, reduced CONTINUOUSLY when the
    // box would exceed the voxel cap (per-axis so the torus wrap stays exact).
    let effRes = Math.max(0.05, this.metaballs.resolution);
    if (sx * effRes * sy * effRes * sz * effRes > Gl3DRenderer.META_MAX_VOXELS) {
      effRes = Math.cbrt(Gl3DRenderer.META_MAX_VOXELS / (sx * sy * sz));
    }
    const FW = Math.max(1, Math.round(sx * effRes));
    const FH = Math.max(1, Math.round(sy * effRes));
    const FD = Math.max(1, Math.round(sz * effRes));
    // Per-axis resolution from the ROUNDED dims, so voxel (f + 0.5)/res spans the
    // box exactly — on a torus the modulo wrap then lands bit-exactly.
    const rx = FW / sx, ry = FH / sy, rz = FD / sz;
    const total = FW * FH * FD;
    if (this.metaWsum.length < total) {
      this.metaWsum = new Float32Array(total);
      this.metaCsum = new Float32Array(total * 3);
      this.metaBytes = new Uint8Array(total * 4);
    }
    const wsum = this.metaWsum, csum = this.metaCsum, bytes = this.metaBytes;
    wsum.fill(0, 0, total);
    csum.fill(0, 0, total * 3);
    // Pass 2 — splat each agent's falloff over its influence box:
    // w = (1 − (d/R)²)³ inside R (Wyvill soft-object kernel).
    for (let k = 0; k < n; k++) {
      const o = k * 8;
      const r = d[o + 3]!;
      if (r <= 0) continue;
      const R = influence * r;
      const R2 = R * R, invR2 = 1 / R2;
      const cx = d[o]!, cy = d[o + 1]!, cz = d[o + 2]!;
      const cr = d[o + 4]!, cg = d[o + 5]!, cb = d[o + 6]!;
      const fx0 = Math.floor((cx - R - bx0) * rx - 0.5), fx1 = Math.ceil((cx + R - bx0) * rx - 0.5);
      const fy0 = Math.floor((cy - R - by0) * ry - 0.5), fy1 = Math.ceil((cy + R - by0) * ry - 0.5);
      const fz0 = Math.floor((cz - R - bz0) * rz - 0.5), fz1 = Math.ceil((cz + R - bz0) * rz - 0.5);
      for (let fz = fz0; fz <= fz1; fz++) {
        let iz = fz;
        if (torus) { iz = fz % FD; if (iz < 0) iz += FD; }
        else if (fz < 0 || fz >= FD) continue;
        const dz = bz0 + (fz + 0.5) / rz - cz;
        const dz2 = dz * dz;
        if (dz2 >= R2) continue;
        for (let fy = fy0; fy <= fy1; fy++) {
          let iy = fy;
          if (torus) { iy = fy % FH; if (iy < 0) iy += FH; }
          else if (fy < 0 || fy >= FH) continue;
          const dy = by0 + (fy + 0.5) / ry - cy;
          const dyz2 = dz2 + dy * dy;
          if (dyz2 >= R2) continue;
          const rowBase = (iz * FH + iy) * FW;
          for (let fx = fx0; fx <= fx1; fx++) {
            let ix = fx;
            if (torus) { ix = fx % FW; if (ix < 0) ix += FW; }
            else if (fx < 0 || fx >= FW) continue;
            const dx = bx0 + (fx + 0.5) / rx - cx;
            const q = (dx * dx + dyz2) * invR2;
            if (q >= 1) continue;
            const tq = 1 - q;
            const w = tq * tq * tq;
            const idx = rowBase + ix;
            wsum[idx]! += w;
            const ci = idx * 3;
            csum[ci]! += w * cr; csum[ci + 1]! += w * cg; csum[ci + 2]! += w * cb;
          }
        }
      }
    }
    // Pass 3 — pack RGBA8: A = density / F_MAX, RGB = weighted-average colour.
    const invFMax = 255 / Gl3DRenderer.META_F_MAX;
    for (let i = 0; i < total; i++) {
      const wv = wsum[i]!;
      const bi = i * 4;
      if (wv <= 0) { bytes[bi] = 0; bytes[bi + 1] = 0; bytes[bi + 2] = 0; bytes[bi + 3] = 0; continue; }
      const ci = i * 3, inv = 255 / wv;
      bytes[bi] = Math.min(255, csum[ci]! * inv);
      bytes[bi + 1] = Math.min(255, csum[ci + 1]! * inv);
      bytes[bi + 2] = Math.min(255, csum[ci + 2]! * inv);
      bytes[bi + 3] = Math.min(255, wv * invFMax);
    }
    // Pass 4 — upload. Reallocate on a dims change, else subimage in place.
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + Gl3DRenderer.META_TEX_UNIT);
    if (!this.metaTex) this.metaTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.metaTex);
    const view = bytes.subarray(0, total * 4);
    if (FW !== this.metaFW || FH !== this.metaFH || FD !== this.metaFD) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, FW, FH, FD, 0, gl.RGBA, gl.UNSIGNED_BYTE, view);
      // Trilinear filtering is what smooths the quantised field between texels;
      // CLAMP on all three axes so the march can't wrap at the field edge.
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    } else {
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, FW, FH, FD, gl.RGBA, gl.UNSIGNED_BYTE, view);
    }
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.activeTexture(gl.TEXTURE0);
    this.metaFW = FW; this.metaFH = FH; this.metaFD = FD;
    // World-space corners of the field (Z-up remap NEGATES row/layer — pass the
    // SIGNED cell-min/cell-max corners, see the META_FS header comment).
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    const ex = bx0 + FW / rx, ey = by0 + FH / ry, ez = bz0 + FD / rz;
    this.metaCornerA = [bx0 - hx, hy - by0, hz - bz0];
    this.metaCornerB = [ex - hx, hy - ey, hz - ez];
    // March step = half the smallest voxel edge; step count covers the diagonal.
    this.metaStepWorld = 0.5 / Math.max(rx, ry, rz);
    const diag = Math.hypot(FW / rx, FH / ry, FD / rz);
    this.metaMaxSteps = Math.min(512, Math.ceil(diag / this.metaStepWorld) + 4);
  }

  /** Raymarch the baked metaball field from a fullscreen quad (replaces the
   *  sphere-impostor pass while metaballs are enabled). Opaque; writes depth. */
  private renderMetaballs(): void {
    if (!this.metaTex || this.metaFW === 0) return;
    const inv = mat4Invert(this.mvp);
    if (!inv) return;
    const gl = this.gl;
    gl.useProgram(this.metaProg);
    gl.bindVertexArray(this.metaVao);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.metaProg, 'uMVP'), false, this.mvp);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.metaProg, 'uInvMVP'), false, inv);
    gl.uniform3f(gl.getUniformLocation(this.metaProg, 'uFieldA'), this.metaCornerA[0], this.metaCornerA[1], this.metaCornerA[2]);
    gl.uniform3f(gl.getUniformLocation(this.metaProg, 'uFieldB'), this.metaCornerB[0], this.metaCornerB[1], this.metaCornerB[2]);
    gl.uniform1f(gl.getUniformLocation(this.metaProg, 'uThreshold'), Math.max(0.02, this.metaballs.threshold));
    gl.uniform1f(gl.getUniformLocation(this.metaProg, 'uFMax'), Gl3DRenderer.META_F_MAX);
    gl.uniform1f(gl.getUniformLocation(this.metaProg, 'uStepWorld'), this.metaStepWorld);
    gl.uniform1i(gl.getUniformLocation(this.metaProg, 'uMaxSteps'), this.metaMaxSteps);
    this.setLightUniforms(gl, this.metaProg);   // binds the shadow map (unit 1)…
    this.setClipUniforms(gl, this.metaProg);
    gl.activeTexture(gl.TEXTURE0 + Gl3DRenderer.META_TEX_UNIT);  // …and resets the
    gl.bindTexture(gl.TEXTURE_3D, this.metaTex);                 // active unit to 0,
    gl.uniform1i(gl.getUniformLocation(this.metaProg, 'uField'), Gl3DRenderer.META_TEX_UNIT);  // so bind AFTER it
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  /** Wireframe rings for hovered (amber) / inspected (white) agents, billboarded
   *  in the camera plane, drawn with depth OFF so they read as an always-visible
   *  cursor / highlight (mirrors renderHoverCells for voxels). */
  private renderAgentRings(): void {
    if (this.hoverAgents.length === 0 && this.inspectAgents.length === 0) return;
    const gl = this.gl;
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    const v: number[] = [];
    const ring = (a: { x: number; y: number; z: number; radius: number }, col: [number, number, number]) => {
      const cx = a.x - hx, cy = hy - a.y, cz = hz - a.z;       // Z-up centre
      const rr = a.radius * 1.35 + 0.25;                       // a touch outside the sphere
      const SEG = 24;
      let pxw = cx + this.camRight[0] * rr, pyw = cy + this.camRight[1] * rr, pzw = cz + this.camRight[2] * rr;
      for (let s = 1; s <= SEG; s++) {
        const ang = (s / SEG) * Math.PI * 2;
        const ca = Math.cos(ang) * rr, sa = Math.sin(ang) * rr;
        const nx = cx + this.camRight[0] * ca + this.camUp[0] * sa;
        const ny = cy + this.camRight[1] * ca + this.camUp[1] * sa;
        const nz = cz + this.camRight[2] * ca + this.camUp[2] * sa;
        v.push(pxw, pyw, pzw, col[0], col[1], col[2], nx, ny, nz, col[0], col[1], col[2]);
        pxw = nx; pyw = ny; pzw = nz;
      }
    };
    for (const a of this.hoverAgents) ring(a, [1.0, 0.85, 0.2]);
    for (const a of this.inspectAgents) ring(a, [0.95, 0.97, 1.0]);
    gl.disable(gl.DEPTH_TEST);
    this.drawLines(new Float32Array(v), gl.LINES, this.mvp);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Colour-id pick of the nearest agent sphere under (px, py) CSS px (top-left).
   *  Returns the COMPACTED instance index (0-based), or -1 for the background.
   *  SimulatorView's instanceToSlot maps it back to the engine slot id. */
  pickAgent(px: number, py: number, cssW: number, cssH: number): number {
    // Respect the Layers panel's Show toggle — a hidden agent must not be
    // killable/movable/inspectable by an invisible pick.
    if (!this.viz.agents) return -1;
    if (this.agentInstanceCount === 0) return -1;
    const gl = this.gl;
    const w = gl.canvas.width, h = gl.canvas.height;
    this.ensurePickFbo(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.spherePickProg);
    gl.bindVertexArray(this.sphereVao);
    this.setSphereUniforms(gl, this.spherePickProg);
    gl.disable(gl.BLEND); gl.depthMask(true);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.agentInstanceCount);
    gl.bindVertexArray(null);
    const bx = Math.floor(px / cssW * w);
    const by = Math.floor((1 - py / cssH) * h);
    const out = new Uint8Array(4);
    gl.readPixels(Math.max(0, Math.min(w - 1, bx)), Math.max(0, Math.min(h - 1, by)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (out[3] === 0) return -1;
    const id = out[0]! | (out[1]! << 8) | (out[2]! << 16);
    const pos = id - 1;  // shader encoded instanceID+1 = the buffer POSITION
    // Map back to the compacted instance index (identity unless the alpha-blend
    // back-to-front sort reordered the buffer).
    return pos >= 0 && pos < this.agentInstanceCount ? (this.agentInstOrder[pos] ?? pos) : pos;
  }

  private setCommonUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): void {
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, this.mvp);
    // Integer grid dims for the u32 index decode (float uniforms lose exactness
    // for W*H past 2^24 — e.g. 5001×5001).
    gl.uniform1ui(gl.getUniformLocation(prog, 'uWu'), this.W);
    gl.uniform1ui(gl.getUniformLocation(prog, 'uWHu'), this.W * this.H);
    gl.uniform3f(gl.getUniformLocation(prog, 'uHalf'), (this.W - 1) / 2, (this.H - 1) / 2, (this.D - 1) / 2);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCubeScale'), this.cubeScale);
    gl.uniform1f(gl.getUniformLocation(prog, 'uAOStrength'), this.light.ao ? this.light.aoStrength : 0);
    this.setLightUniforms(gl, prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipEnabled'), this.clip.enabled ? 1 : 0);
    const axisN = this.clip.axis === 'x' ? 0 : this.clip.axis === 'y' ? 1 : this.clip.axis === 'z' ? 2 : 3;
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipAxis'), axisN);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipLo'), this.clip.lo);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipHi'), this.clip.hi);
    gl.uniform3f(gl.getUniformLocation(prog, 'uClipForward'), this.camForward[0], this.camForward[1], this.camForward[2]);
  }

  /** Resize the drawing buffer to match the canvas display size × dpr. */
  resize(cssW: number, cssH: number, dpr: number): void {
    const gl = this.gl;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (gl.canvas.width !== w || gl.canvas.height !== h) { gl.canvas.width = w; gl.canvas.height = h; }
  }

  render(): void {
    const gl = this.gl;
    // Cast-shadow depth pass (light POV) — first, before the canvas pass. No-op
    // when shadows are off; the voxel/sphere shaders then PCF-sample the result.
    this.renderShadowMap();
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(this.bgColor[0], this.bgColor[1], this.bgColor[2], this.bgColor[3]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.renderOverlays();   // axes / grid / bounds (behind the voxels)
    this.renderBrushPlane(); // brush interaction-plane bounds + grid (depth-tested)
    // CA-grid voxels — gated by viz.voxels (render-layer toggle, req 7). The DRAW
    // is gated, not the upload, so the GPU buffer stays current for re-enable.
    if (this.viz.voxels && this.instanceCount > 0) {
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      this.setCommonUniforms(gl, this.prog);
      if (this.alphaBlend) {
        this.sortBackToFront();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.instanceCount);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }
    // Bond-Graph Agents (gated by viz.agents, req 7). With `agentsInFront` ON
    // (default — the historical behaviour), agents draw ON TOP of the CA-grid
    // VOXELS: the depth buffer is cleared after the voxel pass, then the HELPER
    // overlays' depth (axes / floor grid / bounds / brush plane) is RESTORED with
    // a colour-masked re-draw — so "in front" applies ONLY vs the voxels while
    // the helpers keep normal depth occlusion vs the agents (a brush plane in
    // front of the blob stays visible instead of being swallowed by spheres).
    // Agents still depth-sort among THEMSELVES (gl_FragDepth) + clip to the slab.
    // With `agentsInFront` OFF, no clear — full normal depth vs everything
    // (useful when the grid field is sparse enough to see both interleaved).
    if (this.viz.agents) {
      if (this.agentInstanceCount > 0 || this.bondVerts.length > 0) {
        if (this.agentsInFront) {
          gl.clear(gl.DEPTH_BUFFER_BIT);
          // Depth-only re-draw of the helper overlays (same viz gates as the
          // colour pass above, so exactly what was drawn gets its depth back).
          gl.colorMask(false, false, false, false);
          this.renderOverlays();
          this.renderBrushPlane();
          gl.colorMask(true, true, true, true);
        }
        if (this.viz.bonds) this.renderBonds(); // bonds first (depth-tested UNDER the spheres; display-toggleable)
        // Agent metaballs (opt-in) REPLACE the sphere impostors with one fused
        // implicit surface; sprites always draw (excluded from the field). The
        // field bakes lazily — camera-only frames reuse the 3D texture.
        if (this.metaballs.enabled) {
          if (this.metaDirty) this.bakeMetaballField();
          this.renderMetaballs();
        } else {
          this.renderAgents(); // sphere impostors (non-sprite agents)
        }
        this.renderSprites();  // sprite billboards (sprite-agents; on top, blended)
      }
      this.renderAgentRings(); // hovered/inspected agent rings (depth OFF, on top)
    }
    this.renderHoverCells(); // wireframe cube cursors on the brush footprint (on top)
    this.renderBrushOutline(); // brush footprint outline (bounded wireframe, on top)
    this.renderGizmo();      // corner orientation widget (always on top)
  }

  /** Draw a coloured line list (pos+color interleaved, 6 floats/vertex) through
   *  the line program with the current MVP. `mode` is gl.LINES or gl.POINTS. When
   *  `clip` is non-null the world-space vertices are clipped by the same interval
   *  as the voxels/spheres (used for the bond pass; every other overlay passes
   *  null so it is never clipped). */
  private drawLines(verts: Float32Array, mode: number, mvp: Mat4, pointSize = 1, clip: ClipPlane3D | null = null): void {
    if (verts.length === 0) return;
    const gl = this.gl;
    gl.useProgram(this.lineProg);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uMVP'), false, mvp);
    gl.uniform1f(gl.getUniformLocation(this.lineProg, 'uPointSize'), pointSize);
    if (clip && clip.enabled) {
      gl.uniform1i(gl.getUniformLocation(this.lineProg, 'uClipEnabled'), 1);
      gl.uniform1i(gl.getUniformLocation(this.lineProg, 'uClipAxis'), clip.axis === 'x' ? 0 : clip.axis === 'y' ? 1 : clip.axis === 'z' ? 2 : 3);
      gl.uniform1f(gl.getUniformLocation(this.lineProg, 'uClipLo'), clip.lo);
      gl.uniform1f(gl.getUniformLocation(this.lineProg, 'uClipHi'), clip.hi);
      gl.uniform3f(gl.getUniformLocation(this.lineProg, 'uClipForward'), this.camForward[0], this.camForward[1], this.camForward[2]);
    } else {
      gl.uniform1i(gl.getUniformLocation(this.lineProg, 'uClipEnabled'), 0);
    }
    gl.drawArrays(mode, 0, verts.length / 6);
    gl.bindVertexArray(null);
  }

  /** Build + draw the axes / grid / bounds line overlays (Z-up world space). */
  private renderOverlays(): void {
    if (!this.viz.axes && !this.viz.grid && !this.viz.bounds) return;
    const gl = this.gl;
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    const x0 = -hx - 0.5, x1 = hx + 0.5, y0 = -hy - 0.5, y1 = hy + 0.5, z0 = -hz - 0.5, z1 = hz + 0.5;
    const v: number[] = [];
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number) =>
      v.push(ax, ay, az, r, g, b, bx, by, bz, r, g, b);
    if (this.viz.grid) {
      const c = 0.26, g = 0.28, bl = 0.34;
      const sx = Math.max(1, Math.ceil(this.W / 100)), sy = Math.max(1, Math.ceil(this.H / 100));
      for (let i = 0; i <= this.W; i += sx) { const x = x0 + i; seg(x, y0, z0, x, y1, z0, c, g, bl); }
      for (let j = 0; j <= this.H; j += sy) { const y = y0 + j; seg(x0, y, z0, x1, y, z0, c, g, bl); }
    }
    if (this.viz.bounds) {
      const c = 0.42, g = 0.45, bl = 0.55;
      seg(x0, y0, z0, x1, y0, z0, c, g, bl); seg(x1, y0, z0, x1, y1, z0, c, g, bl);
      seg(x1, y1, z0, x0, y1, z0, c, g, bl); seg(x0, y1, z0, x0, y0, z0, c, g, bl);
      seg(x0, y0, z1, x1, y0, z1, c, g, bl); seg(x1, y0, z1, x1, y1, z1, c, g, bl);
      seg(x1, y1, z1, x0, y1, z1, c, g, bl); seg(x0, y1, z1, x0, y0, z1, c, g, bl);
      seg(x0, y0, z0, x0, y0, z1, c, g, bl); seg(x1, y0, z0, x1, y0, z1, c, g, bl);
      seg(x1, y1, z0, x1, y1, z1, c, g, bl); seg(x0, y1, z0, x0, y1, z1, c, g, bl);
    }
    if (this.viz.axes) {
      // Origin = cell (0,0,0)'s world centre (the volume CORNER, not the middle):
      // col→+X (right), row→-Y (DOWN the screen in the top view), layer/depth→-Z
      // (into the screen / downward). cell(0,0,0) world = (-hx, +hy, +hz).
      // Draw each axis from the origin toward its positive direction + an arrowhead.
      const ox = -hx, oy = hy, oz = hz;
      const ext = 1.2;
      const axis = (ex: number, ey: number, ez: number, r: number, g: number, b: number) => {
        seg(ox, oy, oz, ex, ey, ez, r, g, b);
        const dx = ex - ox, dy = ey - oy, dz = ez - oz;
        const len = Math.hypot(dx, dy, dz) || 1;
        const ux = dx / len, uy = dy / len, uz = dz / len;
        // a perpendicular for the 2-pronged arrowhead (world-up unless axis ∥ up)
        let px = -uy, py = ux, pz = 0;
        if (Math.hypot(px, py, pz) < 0.1) { px = 0; py = -uz; pz = uy; }
        const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
        const hl = 0.7;
        seg(ex, ey, ez, ex - ux * hl + px * hl * 0.5, ey - uy * hl + py * hl * 0.5, ez - uz * hl + pz * hl * 0.5, r, g, b);
        seg(ex, ey, ez, ex - ux * hl - px * hl * 0.5, ey - uy * hl - py * hl * 0.5, ez - uz * hl - pz * hl * 0.5, r, g, b);
      };
      axis(hx + ext, oy, oz, 0.90, 0.27, 0.27);                 // +col → +X (red, right)
      axis(ox, -hy - ext, oz, 0.34, 0.82, 0.40);                // +row → -Y (green, down-screen)
      axis(ox, oy, oz - (this.D - 1) - ext, 0.36, 0.55, 0.95);  // +depth → -Z (blue, into screen)
    }
    this.drawLines(new Float32Array(v), gl.LINES, this.mvp);
  }

  /** Brush interaction-plane indicator: a bright bounded rectangle + a grid on
   *  the slice the brush paints into, so the user sees exactly where the plane
   *  sits in the volume. Depth-tested (voxels in front occlude it). */
  private renderBrushPlane(): void {
    const p = this.brushPlane;
    if (!p) return;
    const gl = this.gl;
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    const x0 = -hx - 0.5, x1 = hx + 0.5, y0 = -hy - 0.5, y1 = hy + 0.5, z0 = -hz - 0.5, z1 = hz + 0.5;
    const v: number[] = [];
    // bright edge colour + dimmer interior grid (cyan, distinct from the bounds box)
    const er = 0.30, eg = 0.78, eb = 0.92;   // rectangle edges
    const gr = 0.18, gg = 0.42, gb = 0.52;   // interior grid
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number) =>
      v.push(ax, ay, az, r, g, b, bx, by, bz, r, g, b);
    if (p.axis === 'z') {
      const z = hz - p.pos;  // world Z of the layer (layer increases downward)
      const sx = Math.max(1, Math.ceil(this.W / 100)), sy = Math.max(1, Math.ceil(this.H / 100));
      for (let i = 0; i <= this.W; i += sx) { const x = x0 + i; seg(x, y0, z, x, y1, z, gr, gg, gb); }
      for (let j = 0; j <= this.H; j += sy) { const y = y0 + j; seg(x0, y, z, x1, y, z, gr, gg, gb); }
      seg(x0, y0, z, x1, y0, z, er, eg, eb); seg(x1, y0, z, x1, y1, z, er, eg, eb);
      seg(x1, y1, z, x0, y1, z, er, eg, eb); seg(x0, y1, z, x0, y0, z, er, eg, eb);
    } else if (p.axis === 'y') {
      const y = hy - p.pos;  // world Y of the row (row→-Y)
      const sx = Math.max(1, Math.ceil(this.W / 100)), sz = Math.max(1, Math.ceil(this.D / 100));
      for (let i = 0; i <= this.W; i += sx) { const x = x0 + i; seg(x, y, z0, x, y, z1, gr, gg, gb); }
      for (let k = 0; k <= this.D; k += sz) { const z = z0 + k; seg(x0, y, z, x1, y, z, gr, gg, gb); }
      seg(x0, y, z0, x1, y, z0, er, eg, eb); seg(x1, y, z0, x1, y, z1, er, eg, eb);
      seg(x1, y, z1, x0, y, z1, er, eg, eb); seg(x0, y, z1, x0, y, z0, er, eg, eb);
    } else {
      const x = p.pos - hx;  // world X of the column
      const sy = Math.max(1, Math.ceil(this.H / 100)), sz = Math.max(1, Math.ceil(this.D / 100));
      for (let j = 0; j <= this.H; j += sy) { const y = y0 + j; seg(x, y, z0, x, y, z1, gr, gg, gb); }
      for (let k = 0; k <= this.D; k += sz) { const z = z0 + k; seg(x, y0, z, x, y1, z, gr, gg, gb); }
      seg(x, y0, z0, x, y1, z0, er, eg, eb); seg(x, y1, z0, x, y1, z1, er, eg, eb);
      seg(x, y1, z1, x, y0, z1, er, eg, eb); seg(x, y0, z1, x, y0, z0, er, eg, eb);
    }
    this.drawLines(new Float32Array(v), gl.LINES, this.mvp);
  }

  /** Append the 12 wireframe edges of the cube framing a cell to `out`. */
  private pushCellCube(out: number[], c: { layer: number; row: number; col: number }, col: [number, number, number], h = 0.56): void {
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    const cx = c.col - hx, cy = hy - c.row, cz = hz - c.layer;  // Z-up cell centre (row→-Y)
    const xs = [cx - h, cx + h], ys = [cy - h, cy + h], zs = [cz - h, cz + h];
    const corner = (i: number): [number, number, number] => [xs[i & 1]!, ys[(i >> 1) & 1]!, zs[(i >> 2) & 1]!];
    const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const [r, g, b] = col;
    for (const [a, bb] of EDGES) {
      const A = corner(a!), B = corner(bb!);
      out.push(A[0], A[1], A[2], r, g, b, B[0], B[1], B[2], r, g, b);
    }
  }

  /** Wireframe-cube cursors on the brush FOOTPRINT (amber, every cell the brush
   *  would affect) + the inspected cells (white). Drawn with depth test OFF so
   *  they read as an always-visible cursor / highlight. */
  private renderHoverCells(): void {
    if (this.hoverCells.length === 0 && this.inspectCells.length === 0) return;
    const gl = this.gl;
    const v: number[] = [];
    for (const c of this.hoverCells) this.pushCellCube(v, c, [1.0, 0.85, 0.2]);     // amber brush cursor
    for (const c of this.inspectCells) this.pushCellCube(v, c, [0.95, 0.97, 1.0], 0.6); // white inspect highlight
    gl.disable(gl.DEPTH_TEST);
    this.drawLines(new Float32Array(v), gl.LINES, this.mvp);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Draw the brush footprint OUTLINE — a bounded amber wireframe (a few circles /
   *  a box). Maps the cell-space endpoint pairs to Z-up world space (same mapping
   *  as pushCellCube: col→+X, row→-Y, layer→-Z) and colours them amber. Depth OFF
   *  so it reads as an always-visible cursor. */
  private renderBrushOutline(): void {
    const pts = this.brushOutline;
    if (!pts || pts.length < 6) return;
    const gl = this.gl;
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    const n = (pts.length / 3) | 0;
    const v = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      v[i * 6] = pts[i * 3]! - hx;          // col → +X
      v[i * 6 + 1] = hy - pts[i * 3 + 1]!;  // row → -Y
      v[i * 6 + 2] = hz - pts[i * 3 + 2]!;  // layer → -Z
      v[i * 6 + 3] = 1.0; v[i * 6 + 4] = 0.85; v[i * 6 + 5] = 0.2;  // amber
    }
    gl.disable(gl.DEPTH_TEST);
    this.drawLines(v, gl.LINES, this.mvp);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Pixel size of the square corner-gizmo viewport (device px). */
  private gizmoSizePx(): number {
    const gl = this.gl;
    return Math.max(48, Math.round(Math.min(gl.canvas.width, gl.canvas.height) * 0.16));
  }
  /** Orthographic view-projection used to draw + hit-test the gizmo. */
  private gizmoMatrix(): Mat4 {
    const d = this.camDir, r = 3;
    const view = mat4LookAt([d[0] * r, d[1] * r, d[2] * r], [0, 0, 0], WORLD_UP);
    const proj = mat4Ortho(-1.6, 1.6, -1.6, 1.6, -10, 10);
    return mat4Mul(proj, view);
  }

  /** The 6 gizmo endpoints: a unit dir + bright (front) / dim (back) colours.
   *  Shared by the renderer and the click hit-test so they stay aligned. */
  private static readonly GIZMO_ENDS: ReadonlyArray<{ axis: 'x' | 'y' | 'z'; sign: 1 | -1; v: [number, number, number]; c: [number, number, number] }> = [
    { axis: 'x', sign: 1, v: [1, 0, 0], c: [0.90, 0.27, 0.27] },
    { axis: 'x', sign: -1, v: [-1, 0, 0], c: [0.50, 0.20, 0.20] },
    { axis: 'y', sign: 1, v: [0, 1, 0], c: [0.34, 0.82, 0.40] },
    { axis: 'y', sign: -1, v: [0, -1, 0], c: [0.20, 0.46, 0.25] },
    { axis: 'z', sign: 1, v: [0, 0, 1], c: [0.40, 0.58, 0.96] },
    { axis: 'z', sign: -1, v: [0, 0, -1], c: [0.22, 0.34, 0.58] },
  ];

  /** Stroke glyphs for the gizmo axis letters (polylines in a unit cell, y-up).
   *  Col=C (x), Row=R (y), Depth=D (z). */
  private static readonly GLYPHS: Record<string, number[][][]> = {
    C: [[[.28, .42], [-.18, .42], [-.3, .2], [-.3, -.2], [-.18, -.42], [.28, -.42]]],
    R: [[[-.28, -.45], [-.28, .45], [.16, .45], [.28, .3], [.28, .1], [.16, -.02], [-.28, -.02]], [[-.04, -.02], [.28, -.45]]],
    D: [[[-.28, -.45], [-.28, .45], [.05, .45], [.26, .22], [.26, -.22], [.05, -.45], [-.28, -.45]]],
  };
  /** Positive-axis labels: tip dir + colour + glyph (row/col/depth). */
  private static readonly GIZMO_LABELS: ReadonlyArray<{ v: [number, number, number]; c: [number, number, number]; glyph: string }> = [
    { v: [1, 0, 0], c: [0.96, 0.55, 0.55], glyph: 'C' },    // +col → +X
    { v: [0, -1, 0], c: [0.55, 0.92, 0.62], glyph: 'R' },   // +row → -Y
    { v: [0, 0, -1], c: [0.62, 0.74, 1.0], glyph: 'D' },    // +depth → -Z
  ];

  /** Corner orientation gizmo: 6 colored ± axis stubs + endpoint dots + R/C/D
   *  letters on the positive tips, depth-correct so a back axis can't draw over a
   *  front one. Rotates with the camera; clickable (gizmoHitTest) for the 6 POVs. */
  private renderGizmo(): void {
    if (!this.viz.gizmo) return;
    const gl = this.gl;
    const S = this.gizmoSizePx();
    gl.viewport(10, 10, S, S);
    // Depth-correct self-occlusion: clear ONLY the gizmo region's depth (scissor),
    // then draw with depth test ON so the nearer (front) axes occlude the back ones.
    gl.enable(gl.SCISSOR_TEST); gl.scissor(10, 10, S, S);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    const giz = this.gizmoMatrix();
    const lines: number[] = [];
    const pts: number[] = [];
    for (const e of Gl3DRenderer.GIZMO_ENDS) {
      lines.push(0, 0, 0, e.c[0], e.c[1], e.c[2], e.v[0], e.v[1], e.v[2], e.c[0], e.c[1], e.c[2]);
      pts.push(e.v[0], e.v[1], e.v[2], e.c[0], e.c[1], e.c[2]);
    }
    this.drawLines(new Float32Array(lines), gl.LINES, giz);
    this.drawLines(new Float32Array(pts), gl.POINTS, giz, Math.max(6, S * 0.14));
    // Axis letters (C/R/D on +col/+row/+depth): project each tip → gizmo NDC, then
    // nudge the glyph a CONSTANT radial offset beyond the tip so it sits just
    // outside the endpoint dot at a stable size/position from every angle. Drawn
    // with an identity MVP (NDC coords) + depth OFF so all three stay legible —
    // no back-face culling (that was the "letters disappear at some angles" bug).
    gl.disable(gl.DEPTH_TEST);
    const m = giz;
    const sz = 0.26;          // glyph half-size in gizmo NDC (uniform)
    const pushOut = 0.24;     // radial nudge beyond the tip (tip projects to ~0.63)
    const letters: number[] = [];
    for (const lab of Gl3DRenderer.GIZMO_LABELS) {
      const vx = lab.v[0], vy = lab.v[1], vz = lab.v[2];
      const w = (m[3]! * vx + m[7]! * vy + m[11]! * vz + m[15]!) || 1;
      let px = (m[0]! * vx + m[4]! * vy + m[8]! * vz + m[12]!) / w;
      let py = (m[1]! * vx + m[5]! * vy + m[9]! * vz + m[13]!) / w;
      const len = Math.hypot(px, py) || 1;
      px += (px / len) * pushOut; py += (py / len) * pushOut;
      const [r, g, b] = lab.c;
      for (const stroke of Gl3DRenderer.GLYPHS[lab.glyph]!) {
        for (let i = 0; i < stroke.length - 1; i++) {
          letters.push(px + stroke[i]![0]! * sz, py + stroke[i]![1]! * sz, 0, r, g, b,
            px + stroke[i + 1]![0]! * sz, py + stroke[i + 1]![1]! * sz, 0, r, g, b);
        }
      }
    }
    this.drawLines(new Float32Array(letters), gl.LINES, mat4Identity());  // identity → NDC
    gl.enable(gl.DEPTH_TEST);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  }

  /** Hit-test a click (CSS px, top-left origin) against the corner gizmo. Returns
   *  the clicked axis endpoint (for snapping to that POV) or null if the click is
   *  outside the gizmo / not near an endpoint. Edge-on (overlapping) endpoints
   *  tie-break to the one facing the camera. */
  gizmoHitTest(cssX: number, cssY: number, cssW: number, cssH: number): { axis: 'x' | 'y' | 'z'; sign: 1 | -1 } | null {
    if (!this.viz.gizmo) return null;
    const gl = this.gl;
    const dpr = gl.canvas.width / Math.max(1, cssW);
    const S = this.gizmoSizePx();
    // Click in drawing-buffer pixels, bottom-left origin (matches the viewport).
    const dx = cssX * dpr, dy = (cssH - cssY) * dpr;
    if (dx < 10 || dx > 10 + S || dy < 10 || dy > 10 + S) return null;
    const gxN = ((dx - 10) / S) * 2 - 1, gyN = ((dy - 10) / S) * 2 - 1;
    const giz = this.gizmoMatrix();
    const projXY = (vx: number, vy: number, vz: number): [number, number] => {
      const x = giz[0]! * vx + giz[4]! * vy + giz[8]! * vz + giz[12]!;
      const y = giz[1]! * vx + giz[5]! * vy + giz[9]! * vz + giz[13]!;
      const w = giz[3]! * vx + giz[7]! * vy + giz[11]! * vz + giz[15]! || 1;
      return [x / w, y / w];
    };
    let best: { axis: 'x' | 'y' | 'z'; sign: 1 | -1 } | null = null;
    let bestDist = 0.55;  // NDC radius threshold within the gizmo viewport
    let bestFacing = -2;
    for (const e of Gl3DRenderer.GIZMO_ENDS) {
      const [nx, ny] = projXY(e.v[0], e.v[1], e.v[2]);
      const dist = Math.hypot(nx - gxN, ny - gyN);
      if (dist > 0.55) continue;
      // camDir points target→eye; an endpoint facing the viewer has dir·camDir>0.
      const facing = e.v[0] * this.camDir[0] + e.v[1] * this.camDir[1] + e.v[2] * this.camDir[2];
      if (dist < bestDist - 0.1 || (Math.abs(dist - bestDist) <= 0.1 && facing > bestFacing)) {
        best = { axis: e.axis, sign: e.sign };
        bestDist = Math.min(bestDist, dist);
        bestFacing = facing;
      }
    }
    return best;
  }

  /** Ray-pick the world-space cell the cursor's ray hits on a given plane. Used
   *  by the "interaction plane" brush: unproject the cursor to a world ray and
   *  intersect the axis-aligned plane at `planePos` along `planeAxis`, returning
   *  the nearest in-bounds cell (or null). cssX/cssY are top-left CSS pixels. */
  pickOnPlane(cssX: number, cssY: number, cssW: number, cssH: number, planeAxis: 'x' | 'y' | 'z', planePos: number):
    { layer: number; row: number; col: number } | null {
    const inv = mat4Invert(this.mvp);
    if (!inv) return null;
    // NDC at the near + far planes → world ray.
    const ndcX = (cssX / cssW) * 2 - 1;
    const ndcY = 1 - (cssY / cssH) * 2;
    const near = unproject(inv, ndcX, ndcY, -1);
    const far = unproject(inv, ndcX, ndcY, 1);
    if (!near || !far) return null;
    const dir = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    // Plane: world coord along the chosen axis == planeWorld. Map planePos (a
    // grid index) → world. For 'z' (layer) the mapping is hz - layer.
    const hx = (this.W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    const ai = planeAxis === 'x' ? 0 : planeAxis === 'y' ? 1 : 2;
    // row→-Y world mapping: world_y = hy - row, so the row plane sits at hy - pos.
    const planeWorld = planeAxis === 'x' ? planePos - hx : planeAxis === 'y' ? hy - planePos : hz - planePos;
    if (Math.abs(dir[ai]!) < 1e-6) return null;
    const t = (planeWorld - near[ai]!) / dir[ai]!;
    if (t < 0) return null;
    const wx = near[0]! + dir[0]! * t, wy = near[1]! + dir[1]! * t, wz = near[2]! + dir[2]! * t;
    const col = Math.round(wx + hx), row = Math.round(hy - wy), layer = Math.round(hz - wz);
    if (col < 0 || col >= this.W || row < 0 || row >= this.H || layer < 0 || layer >= this.D) return null;
    return { layer, row, col };
  }

  private ensurePickFbo(w: number, h: number): void {
    const gl = this.gl;
    if (this.pickFbo && this.pickW === w && this.pickH === h) return;
    if (this.pickFbo) { gl.deleteFramebuffer(this.pickFbo); gl.deleteTexture(this.pickTex!); gl.deleteRenderbuffer(this.pickDepth!); }
    this.pickW = w; this.pickH = h;
    this.pickTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.pickDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Colour-id pick. (px, py) are CSS pixels with origin TOP-left (DOM convention).
   *  Returns the flat cell index, or -1 for the background. */
  pick(px: number, py: number, cssW: number, cssH: number): number {
    // Respect the Layers panel's Show toggle — never inspect/paint-target a
    // voxel the user can't see.
    if (!this.viz.voxels) return -1;
    const gl = this.gl;
    const w = gl.canvas.width, h = gl.canvas.height;
    this.ensurePickFbo(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.clearColor(0, 0, 0, 0);
    if (this.instanceCount > 0) {
      gl.useProgram(this.pickProg);
      gl.bindVertexArray(this.vao);
      this.setCommonUniforms(gl, this.pickProg);
      gl.disable(gl.BLEND); gl.depthMask(true);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.instanceCount);
      gl.bindVertexArray(null);
    }
    // Map CSS (top-left) → drawing-buffer (bottom-left) coords.
    const bx = Math.floor(px / cssW * w);
    const by = Math.floor((1 - py / cssH) * h);
    const out = new Uint8Array(4);
    gl.readPixels(Math.max(0, Math.min(w - 1, bx)), Math.max(0, Math.min(h - 1, by)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Full 32-bit decode (the shader encodes cellIndex+1 across RGBA; the cleared
    // background reads 0). RGB-only decoding capped picks at 2^24-1 — wrong cell
    // returned on grids past ~16.7M cells.
    const raw = (out[0]! | (out[1]! << 8) | (out[2]! << 16) | (out[3]! << 24)) >>> 0;
    return raw === 0 ? -1 : raw - 1;
  }

  /** Read the rendered display buffer as RGBA pixels (for screenshot/recording).
   *  Y is flipped to top-left origin to match ImageData. */
  readPixels(): { data: Uint8ClampedArray; width: number; height: number } {
    const gl = this.gl;
    const w = gl.canvas.width, h = gl.canvas.height;
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // Flip Y.
    const flipped = new Uint8ClampedArray(w * h * 4);
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * rowBytes;
      flipped.set(raw.subarray(src, src + rowBytes), y * rowBytes);
    }
    return { data: flipped, width: w, height: h };
  }

  get canvasWidth(): number { return this.gl.canvas.width; }
  get canvasHeight(): number { return this.gl.canvas.height; }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.prog);
    gl.deleteProgram(this.pickProg);
    gl.deleteProgram(this.lineProg);
    gl.deleteProgram(this.sphereProg);
    gl.deleteProgram(this.spherePickProg);
    gl.deleteProgram(this.spriteProg);
    gl.deleteProgram(this.metaProg);
    gl.deleteProgram(this.cubeShadowProg);
    gl.deleteProgram(this.sphereShadowProg);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteVertexArray(this.sphereVao);
    gl.deleteVertexArray(this.spriteVao);
    gl.deleteVertexArray(this.metaVao);
    if (this.metaTex) gl.deleteTexture(this.metaTex);
    gl.deleteBuffer(this.cubeBuf);
    gl.deleteBuffer(this.instBuf);
    gl.deleteBuffer(this.aoBuf);
    gl.deleteBuffer(this.lineBuf);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteBuffer(this.agentInstBuf);
    gl.deleteBuffer(this.spriteInstBuf);
    if (this.spriteAtlasTex) gl.deleteTexture(this.spriteAtlasTex);
    if (this.pickFbo) { gl.deleteFramebuffer(this.pickFbo); gl.deleteTexture(this.pickTex!); gl.deleteRenderbuffer(this.pickDepth!); }
    if (this.shadowFbo) { gl.deleteFramebuffer(this.shadowFbo); gl.deleteTexture(this.shadowTex!); }
    if (this.dummyShadowTexObj) gl.deleteTexture(this.dummyShadowTexObj);
  }
}
