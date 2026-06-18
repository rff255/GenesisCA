// 3D Grid CA — WebGL2 voxel renderer.
//
// Instanced unit cubes, one per ALIVE (alpha > 0) cell, decoded from the flat
// SoA cell index in the vertex shader. Orbit camera, a clip/slice plane as the
// PRIMARY see-inside (fragment discard — NOT depth-sorted blending), opt-in
// per-cell alpha (back-to-front instance sort, Option A), and GPU colour-id
// picking via a second FBO pass.
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
// plane), Z is vertical with layer increasing DOWNWARD, so a top-down view shows
// the grid like a 2D CA. `target` is the orbit pivot (moved by screen-space pan);
// `dist` is a multiple of the largest grid dimension.
export interface Camera3D { yaw: number; pitch: number; dist: number; target: [number, number, number]; }
// Clip/slice plane. `axis` 'x'|'y'|'z' cuts along a grid axis; 'camera' cuts along
// the current view direction (peel toward the viewer).
export interface ClipPlane3D { enabled: boolean; axis: 'x' | 'y' | 'z' | 'camera'; value: number; }
/** Toggleable scene overlays. */
export interface Viz3D { axes: boolean; grid: boolean; bounds: boolean; gizmo: boolean; }

const WORLD_UP: [number, number, number] = [0, 0, 1];

/** Camera basis (forward/right/up) from yaw/pitch in the Z-up convention. */
function cameraBasis(cam: Camera3D): { dir: [number, number, number]; right: [number, number, number]; up: [number, number, number] } {
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

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aCellIndex;  // flat SoA index of this instance
layout(location=3) in vec4 aColor;       // rgba 0..1
uniform mat4 uMVP;
uniform float uW; uniform float uWH; uniform vec3 uHalf; // half-extents (W-1)/2 etc.
uniform float uCubeScale;
out vec4 vColor;
out vec3 vNormal;
out vec3 vWorld;     // world-space cell-centre (for the clip plane)
void main() {
  float layer = floor(aCellIndex / uWH);
  float rem = aCellIndex - layer * uWH;
  float row = floor(rem / uW);
  float col = rem - row * uW;
  // Z-up: XY is the horizon plane; layer increases DOWNWARD (layer 0 on top).
  vec3 centre = vec3(col - uHalf.x, row - uHalf.y, uHalf.z - layer);
  vWorld = centre;
  vColor = aColor;
  vNormal = aNormal;
  gl_Position = uMVP * vec4(aPos * uCubeScale + centre, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vColor;
in vec3 vNormal;
in vec3 vWorld;
uniform int uClipEnabled;   // 0/1
uniform int uClipAxis;      // 0=x 1=y 2=z 3=camera-view-axis
uniform float uClipValue;   // cut position (cells beyond are hidden)
uniform vec3 uClipForward;  // camera forward (for axis 3)
out vec4 outColor;
void main() {
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vWorld.x : uClipAxis == 1 ? vWorld.y : uClipAxis == 2 ? vWorld.z : dot(vWorld, uClipForward);
    if (w > uClipValue) { discard; }
  }
  // Flat directional shade by face normal so the cubes read as solid volume.
  vec3 L = normalize(vec3(0.4, 0.8, 0.6));
  float lum = 0.45 + 0.55 * max(0.0, dot(normalize(vNormal), L));
  outColor = vec4(vColor.rgb * lum, vColor.a);
}`;

// Pick pass: encode the instance's cell index as RGB; nearest cube wins via depth.
const PICK_FS = `#version 300 es
precision highp float;
flat in float vPickIdx;
in vec3 vWorldP;
uniform int uClipEnabled;
uniform int uClipAxis;
uniform float uClipValue;
uniform vec3 uClipForward;
out vec4 outColor;
void main() {
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vWorldP.x : uClipAxis == 1 ? vWorldP.y : uClipAxis == 2 ? vWorldP.z : dot(vWorldP, uClipForward);
    if (w > uClipValue) { discard; }
  }
  float idx = vPickIdx;
  float r = mod(idx, 256.0);
  float g = mod(floor(idx / 256.0), 256.0);
  float b = mod(floor(idx / 65536.0), 256.0);
  outColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}`;
const PICK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=2) in float aCellIndex;
uniform mat4 uMVP;
uniform float uW; uniform float uWH; uniform vec3 uHalf; uniform float uCubeScale;
flat out float vPickIdx;
out vec3 vWorldP;
void main() {
  float layer = floor(aCellIndex / uWH);
  float rem = aCellIndex - layer * uWH;
  float row = floor(rem / uW);
  float col = rem - row * uW;
  vec3 centre = vec3(col - uHalf.x, row - uHalf.y, uHalf.z - layer);
  vWorldP = centre;
  vPickIdx = aCellIndex;
  gl_Position = uMVP * vec4(aPos * uCubeScale + centre, 1.0);
}`;

// Unlit coloured-line program for the axes / grid / bounds overlays + the gizmo.
const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uMVP;
out vec3 vCol;
void main(){ vCol = aColor; gl_Position = uMVP * vec4(aPos, 1.0); }`;
const LINE_FS = `#version 300 es
precision highp float;
in vec3 vCol; out vec4 o;
void main(){ o = vec4(vCol, 1.0); }`;

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
  private W = 1; private H = 1; private D = 1;
  private alphaBlend = false;
  private clip: ClipPlane3D = { enabled: false, axis: 'z', value: 0 };
  private mvp: Mat4 = mat4Identity();
  private camForward: [number, number, number] = [0, 0, -1];
  private camDir: [number, number, number] = [0, 0, 1];  // target → eye (for the gizmo)
  private viz: Viz3D = { axes: false, grid: false, bounds: false, gizmo: true };
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
    // instance buffer: [cellIndex, r, g, b, a] × 5 floats, stride 20.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 0); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 20, 4); gl.vertexAttribDivisor(3, 1);
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
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
  }

  setGrid(w: number, h: number, d: number): void {
    this.W = Math.max(1, w); this.H = Math.max(1, h); this.D = Math.max(1, d);
  }
  setAlphaBlend(on: boolean): void { this.alphaBlend = on; }
  setClipPlane(clip: ClipPlane3D): void { this.clip = clip; }
  setViz(viz: Viz3D): void { this.viz = viz; }

  /** Compute the view-projection matrix from the Z-up orbit camera. */
  setCamera(cam: Camera3D, aspect: number): void {
    const r = cam.dist * Math.max(this.W, this.H, this.D);
    const { dir } = cameraBasis(cam);
    const t = cam.target;
    const eye: [number, number, number] = [t[0] + r * dir[0], t[1] + r * dir[1], t[2] + r * dir[2]];
    this.camForward = [-dir[0], -dir[1], -dir[2]];
    this.camDir = dir;
    const proj = mat4Perspective(Math.PI / 4, aspect || 1, 0.05, r * 8 + 100);
    const view = mat4LookAt(eye, [t[0], t[1], t[2]], WORLD_UP);
    this.mvp = mat4Mul(proj, view);
  }

  /** Scan the RGBA colors buffer for alpha>0 cells, compact into the instance
   *  buffer. NEVER instances the full volume. Returns the visible count. */
  uploadColors(colors: Uint8ClampedArray, total: number): number {
    const need = total * 5;
    if (this.instData.length < need) this.instData = new Float32Array(need);
    const d = this.instData;
    let n = 0;
    for (let i = 0; i < total; i++) {
      const a = colors[i * 4 + 3]!;
      if (a === 0) continue;
      const o = n * 5;
      d[o] = i;
      d[o + 1] = colors[i * 4]! / 255;
      d[o + 2] = colors[i * 4 + 1]! / 255;
      d[o + 3] = colors[i * 4 + 2]! / 255;
      d[o + 4] = a / 255;
      n++;
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
    return n;
  }

  /** Back-to-front sort of the instance buffer by camera depth (Option A blend).
   *  Only call when alpha blending is enabled; opaque rendering needs no sort. */
  private sortBackToFront(): void {
    const n = this.instanceCount;
    if (n < 2) return;
    const d = this.instData;
    const W = this.W, WH = this.W * this.H;
    const hx = (W - 1) / 2, hy = (this.H - 1) / 2, hz = (this.D - 1) / 2;
    // eye direction approximated from the MVP isn't trivial; sort by -z of the
    // transformed centre. Build keys then index-sort, then rewrite the buffer.
    const m = this.mvp;
    const keys = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const idx = d[k * 5]!;
      const layer = Math.floor(idx / WH);
      const rem = idx - layer * WH;
      const row = Math.floor(rem / W);
      const col = rem - row * W;
      const cx = col - hx, cy = row - hy, cz = hz - layer;  // Z-up
      // clip-space w (depth proxy): row3 of MVP · centre
      keys[k] = m[2]! * cx + m[6]! * cy + m[10]! * cz + m[14]!;
    }
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => keys[b]! - keys[a]!);
    const sorted = new Float32Array(n * 5);
    for (let k = 0; k < n; k++) {
      const s = order[k]! * 5;
      sorted.set(d.subarray(s, s + 5), k * 5);
    }
    d.set(sorted.subarray(0, n * 5));
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sorted);
  }

  private setCommonUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): void {
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, this.mvp);
    gl.uniform1f(gl.getUniformLocation(prog, 'uW'), this.W);
    gl.uniform1f(gl.getUniformLocation(prog, 'uWH'), this.W * this.H);
    gl.uniform3f(gl.getUniformLocation(prog, 'uHalf'), (this.W - 1) / 2, (this.H - 1) / 2, (this.D - 1) / 2);
    gl.uniform1f(gl.getUniformLocation(prog, 'uCubeScale'), 0.92);
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipEnabled'), this.clip.enabled ? 1 : 0);
    const axisN = this.clip.axis === 'x' ? 0 : this.clip.axis === 'y' ? 1 : this.clip.axis === 'z' ? 2 : 3;
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipAxis'), axisN);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipValue'), this.clip.value);
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
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.renderOverlays();   // axes / grid / bounds (behind the voxels)
    if (this.instanceCount > 0) {
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
    this.renderGizmo();      // corner orientation widget (always on top)
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
      const L = Math.max(hx, hy, hz) + 1.5;
      seg(-L, 0, 0, L, 0, 0, 0.90, 0.27, 0.27);  // X red
      seg(0, -L, 0, 0, L, 0, 0.34, 0.82, 0.40);  // Y green
      seg(0, 0, -L, 0, 0, L, 0.36, 0.55, 0.95);  // Z blue
    }
    if (v.length === 0) return;
    const verts = new Float32Array(v);
    gl.useProgram(this.lineProg);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uMVP'), false, this.mvp);
    gl.drawArrays(gl.LINES, 0, verts.length / 6);
    gl.bindVertexArray(null);
  }

  /** Corner orientation gizmo: 3 colored axes rotating with the camera. */
  private renderGizmo(): void {
    if (!this.viz.gizmo) return;
    const gl = this.gl;
    const S = Math.max(48, Math.round(Math.min(gl.canvas.width, gl.canvas.height) * 0.16));
    gl.viewport(10, 10, S, S);
    gl.disable(gl.DEPTH_TEST);
    const d = this.camDir, r = 3;
    const view = mat4LookAt([d[0] * r, d[1] * r, d[2] * r], [0, 0, 0], WORLD_UP);
    const proj = mat4Ortho(-1.5, 1.5, -1.5, 1.5, -10, 10);
    const giz = mat4Mul(proj, view);
    const L = 1;
    const verts = new Float32Array([
      0, 0, 0, 0.90, 0.27, 0.27, L, 0, 0, 0.90, 0.27, 0.27,
      0, 0, 0, 0.34, 0.82, 0.40, 0, L, 0, 0.34, 0.82, 0.40,
      0, 0, 0, 0.36, 0.55, 0.95, 0, 0, L, 0.36, 0.55, 0.95,
    ]);
    gl.useProgram(this.lineProg);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uMVP'), false, giz);
    gl.drawArrays(gl.LINES, 0, 6);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
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
    const planeWorld = planeAxis === 'x' ? planePos - hx : planeAxis === 'y' ? planePos - hy : hz - planePos;
    if (Math.abs(dir[ai]!) < 1e-6) return null;
    const t = (planeWorld - near[ai]!) / dir[ai]!;
    if (t < 0) return null;
    const wx = near[0]! + dir[0]! * t, wy = near[1]! + dir[1]! * t, wz = near[2]! + dir[2]! * t;
    const col = Math.round(wx + hx), row = Math.round(wy + hy), layer = Math.round(hz - wz);
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
    if (out[3] === 0) return -1;  // background (cleared alpha 0)
    return out[0]! | (out[1]! << 8) | (out[2]! << 16);
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
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteBuffer(this.cubeBuf);
    gl.deleteBuffer(this.instBuf);
    gl.deleteBuffer(this.lineBuf);
    if (this.pickFbo) { gl.deleteFramebuffer(this.pickFbo); gl.deleteTexture(this.pickTex!); gl.deleteRenderbuffer(this.pickDepth!); }
  }
}
