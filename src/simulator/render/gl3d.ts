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
function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
  return o;
}

export interface Camera3D { yaw: number; pitch: number; dist: number; panX: number; panY: number; }
export interface ClipPlane3D { enabled: boolean; axis: 'x' | 'y' | 'z'; value: number; }

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
  vec3 centre = vec3(col - uHalf.x, row - uHalf.y, layer - uHalf.z);
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
uniform int uClipAxis;      // 0=x 1=y 2=z
uniform float uClipValue;   // world-space cut along the axis (cells beyond are hidden)
out vec4 outColor;
void main() {
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vWorld.x : (uClipAxis == 1 ? vWorld.y : vWorld.z);
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
out vec4 outColor;
void main() {
  if (uClipEnabled == 1) {
    float w = uClipAxis == 0 ? vWorldP.x : (uClipAxis == 1 ? vWorldP.y : vWorldP.z);
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
  vec3 centre = vec3(col - uHalf.x, row - uHalf.y, layer - uHalf.z);
  vWorldP = centre;
  vPickIdx = aCellIndex;
  gl_Position = uMVP * vec4(aPos * uCubeScale + centre, 1.0);
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
  private W = 1; private H = 1; private D = 1;
  private alphaBlend = false;
  private clip: ClipPlane3D = { enabled: false, axis: 'z', value: 0 };
  private mvp: Mat4 = mat4Identity();
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
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
  }

  setGrid(w: number, h: number, d: number): void {
    this.W = Math.max(1, w); this.H = Math.max(1, h); this.D = Math.max(1, d);
  }
  setAlphaBlend(on: boolean): void { this.alphaBlend = on; }
  setClipPlane(clip: ClipPlane3D): void { this.clip = clip; }

  /** Compute the view-projection matrix from the orbit camera + canvas aspect. */
  setCamera(cam: Camera3D, aspect: number): void {
    const r = cam.dist * Math.max(this.W, this.H, this.D);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const eye: [number, number, number] = [r * cp * sy + cam.panX, r * sp + cam.panY, r * cp * cy];
    const target: [number, number, number] = [cam.panX, cam.panY, 0];
    const proj = mat4Perspective(Math.PI / 4, aspect || 1, 0.1, r * 8 + 100);
    const view = mat4LookAt(eye, target, [0, 1, 0]);
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
      const cx = col - hx, cy = row - hy, cz = layer - hz;
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
    gl.uniform1i(gl.getUniformLocation(prog, 'uClipAxis'), this.clip.axis === 'x' ? 0 : this.clip.axis === 'y' ? 1 : 2);
    gl.uniform1f(gl.getUniformLocation(prog, 'uClipValue'), this.clip.value);
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
    if (this.instanceCount === 0) return;
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
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.cubeBuf);
    gl.deleteBuffer(this.instBuf);
    if (this.pickFbo) { gl.deleteFramebuffer(this.pickFbo); gl.deleteTexture(this.pickTex!); gl.deleteRenderbuffer(this.pickDepth!); }
  }
}
