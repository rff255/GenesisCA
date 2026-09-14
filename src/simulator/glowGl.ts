/**
 * The WebGL2 halo accumulator for the 2D agent glow on the CPU-overlay path —
 * the fast sibling of drawAgentGlow's Canvas2D sprite pass in SimulatorView.
 *
 * WHY THIS EXISTS (measured). The overlay glow was N Canvas2D `drawImage` calls
 * per frame — one cached halo sprite per agent per visible tile — and each of
 * those costs ~3-6 µs of per-call dispatch regardless of blend mode, sprite size
 * or scratch resolution (see agent-render.md § CPU-overlay glow). At 5 000 agents
 * with two infinity tiles in view that was ~75 ms per redraw against < 1 ms with
 * glow off: the option was unusable on exactly the bonded / sprite / metaball
 * models it exists for. Here the whole population is ONE instanced draw.
 *
 * WHAT IT COMPUTES — the SAME thing as the WebGPU direct-render halo pipeline
 * (agentWebgpuRuntime's vsGlow/fsGlow + GLOW_COMPOSE_WGSL), term for term:
 *   1. every agent's halo `g = intensity · t^steepness` (t remapped over the band
 *      outside the solid core) is accumulated ADDITIVELY and UNCLAMPED into an
 *      RGBA16F target as (colour·g, g) — the exact sum, nothing clips;
 *   2. a fullscreen pass tonemaps the accumulated MAGNITUDE (the alpha) with
 *      Reinhard `x/(1+x)` at the shared GLOW_TONE_EXPOSURE, the hue kept exact,
 *      and writes the premultiplied (hue·t, t) layer to this module's canvas;
 *   3. the caller SCREEN-blits that canvas region onto the display, exactly as
 *      it blitted the Canvas2D scratch — the composite rule is unchanged.
 * So the overlay now renders the GPU path's math directly instead of the 8-bit
 * log-encoded approximation the sprite path had to use (glowTone.ts explains
 * that encoding; it remains the FALLBACK when WebGL2 or a renderable float
 * target is unavailable, or after a context loss).
 *
 * One deliberate difference from the WGSL: a per-agent ALPHA scales the halo
 * here (`g · a`), matching the Canvas2D path it replaces (which blitted each
 * sprite at `globalAlpha = a/255`) — the direct-render pipeline only culls
 * alpha 0.
 *
 * LIFECYCLE. One module-level instance, created on first use; the canvas and the
 * HDR target are GROW-ONLY with a slow decay (a capture at 2048² must not pin
 * 50 MB for the rest of the session), and the region actually rendered and
 * blitted is always the agents' screen bbox at the canvas origin. A lost
 * context marks the instance dead; the caller falls back to Canvas2D for the
 * rest of the session rather than re-creating contexts in a loss loop.
 *
 * NEVER READ BACK: the display draw is a canvas→canvas drawImage, which stays on
 * the GPU; a readback would re-introduce the flush cost the design avoids.
 */
import { GLOW_TONE_EXPOSURE } from './glowTone';

/** Floats per halo instance: x, y (px from the bbox origin), outer radius R (px),
 *  core fraction (core radius / R), r, g, b (0..1), agent alpha (0..1). */
export const GLOW_GL_FLOATS = 8;
const STRIDE = GLOW_GL_FLOATS * 4;

/** After this many renders, a canvas more than twice the peak size the period
 *  asked for shrinks back to that peak (grow-only otherwise). */
const SHRINK_EVERY = 240;

const HALO_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in float aR;
layout(location=2) in float aCore;
layout(location=3) in vec4 aCol;
uniform vec2 uBox;
out vec2 vUv;
out vec4 vCol;
flat out float vCore;
void main() {
  // Quad corner (triangle-strip, 4 verts): (-1,-1)(1,-1)(-1,1)(1,1).
  vec2 corner = vec2((gl_VertexID == 1 || gl_VertexID == 3) ? 1.0 : -1.0, (gl_VertexID >= 2) ? 1.0 : -1.0);
  float hr = max(0.001, aR);   // ('half' is a reserved word in GLSL ES)
  // One-pixel pad so the fragment ring at d == 1 is never clipped by the quad
  // edge (the WGSL builder's pad); uv is rescaled so d == 1 still marks R.
  float padded = hr + 1.0;
  vec2 p = aPos + corner * padded;
  gl_Position = vec4(p.x / uBox.x * 2.0 - 1.0, 1.0 - p.y / uBox.y * 2.0, 0.0, 1.0);
  vUv = corner * (padded / hr);
  vCol = aCol;
  vCore = aCore;
}`;

/** fsGlow, verbatim: unclamped radiance into the HDR target. */
const HALO_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vCol;
flat in float vCore;
uniform float uIntensity;
uniform float uSteepness;
out vec4 outColor;
void main() {
  float d = length(vUv);
  if (d > 1.0) { discard; }
  float band = max(1.0e-4, 1.0 - vCore);
  float t = clamp((1.0 - d) / band, 0.0, 1.0);
  float g = max(0.0, uIntensity * pow(t, max(0.01, uSteepness))) * vCol.a;
  outColor = vec4(vCol.rgb * g, g);
}`;

const TONE_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** GLOW_COMPOSE_WGSL, verbatim: Reinhard on the MAGNITUDE, hue exact. */
const TONE_FS = `#version 300 es
precision highp float;
uniform sampler2D uHdr;
uniform float uExposure;
out vec4 outColor;
void main() {
  vec4 hdr = texelFetch(uHdr, ivec2(gl_FragCoord.xy), 0);
  float mag = hdr.a;
  if (mag <= 0.0) { discard; }
  vec3 hue = hdr.rgb / mag;
  float x = mag * uExposure;
  float t = x / (1.0 + x);
  outColor = vec4(clamp(hue, 0.0, 1.0) * t, t);
}`;

function compile(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const mk = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (!sh) throw new Error('glowGl: createShader failed');
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('glowGl shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  };
  const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  if (!p) throw new Error('glowGl: createProgram failed');
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('glowGl link: ' + gl.getProgramInfoLog(p));
  return p;
}

export interface GlowGlResult {
  /** The premultiplied tonemapped halo layer. */
  canvas: HTMLCanvasElement;
  /** Source rect of the rendered region inside `canvas` (the GL framebuffer
   *  origin is the BOTTOM-left, so the bbox-sized region sits at the bottom of
   *  the canvas image). */
  srcX: number; srcY: number; srcW: number; srcH: number;
}

export class GlowGlHalo {
  private readonly cv: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly haloProg: WebGLProgram;
  private readonly toneProg: WebGLProgram;
  private readonly uBox: WebGLUniformLocation | null;
  private readonly uIntensity: WebGLUniformLocation | null;
  private readonly uSteepness: WebGLUniformLocation | null;
  private readonly uHdr: WebGLUniformLocation | null;
  private readonly uExposure: WebGLUniformLocation | null;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly fbo: WebGLFramebuffer;
  private readonly hdrTex: WebGLTexture;
  private readonly maxSize: number;
  private capacity = 0;          // instances the VBO holds
  private hdrW = 0; private hdrH = 0;
  private lost = false;
  private peakW = 0; private peakH = 0; private tick = 0;

  private constructor(cv: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.cv = cv; this.gl = gl;
    this.haloProg = compile(gl, HALO_VS, HALO_FS);
    this.toneProg = compile(gl, TONE_VS, TONE_FS);
    this.uBox = gl.getUniformLocation(this.haloProg, 'uBox');
    this.uIntensity = gl.getUniformLocation(this.haloProg, 'uIntensity');
    this.uSteepness = gl.getUniformLocation(this.haloProg, 'uSteepness');
    this.uHdr = gl.getUniformLocation(this.toneProg, 'uHdr');
    this.uExposure = gl.getUniformLocation(this.toneProg, 'uExposure');
    const vao = gl.createVertexArray(), vbo = gl.createBuffer(), fbo = gl.createFramebuffer(), tex = gl.createTexture();
    if (!vao || !vbo || !fbo || !tex) throw new Error('glowGl: resource creation failed');
    this.vao = vao; this.vbo = vbo; this.fbo = fbo; this.hdrTex = tex;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    // One interleaved instance stream: pos(2f) R(1f) core(1f) col(4f), divisor 1.
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0);  gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE, 8);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 12); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, 16); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
  }

  /** null when WebGL2 or a renderable + blendable float colour target is not
   *  available — the caller then keeps the Canvas2D sprite path. */
  static create(): GlowGlHalo | null {
    if (typeof document === 'undefined') return null;
    try {
      const cv = document.createElement('canvas');
      const gl = cv.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, desynchronized: false,
      });
      if (!gl) return null;
      // RGBA16F must be COLOR-renderable (and it is blendable under either
      // extension); without one of these the additive accumulation cannot exist.
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return null;
      const inst = new GlowGlHalo(cv, gl);
      // Prove the target actually completes on this device before trusting it.
      if (!inst.ensureSize(4, 4)) { inst.destroy(); return null; }
      return inst;
    } catch (err) {
      if (import.meta.env?.DEV) console.warn('[glow] WebGL2 halo path unavailable, using the Canvas2D fallback:', err);
      return null;
    }
  }

  get alive(): boolean { return !this.lost && !this.gl.isContextLost(); }

  /** Grow the canvas + HDR target to cover w×h (never shrinks mid-period; see
   *  SHRINK_EVERY). false when the size is beyond the device limit or the
   *  framebuffer will not complete — the caller falls back for this frame. */
  private ensureSize(w: number, h: number): boolean {
    const gl = this.gl, cv = this.cv;
    if (w > this.maxSize || h > this.maxSize) return false;
    this.peakW = Math.max(this.peakW, w); this.peakH = Math.max(this.peakH, h);
    let tw = Math.max(w, cv.width), th = Math.max(h, cv.height);
    if (++this.tick >= SHRINK_EVERY) {
      const pw = this.peakW, ph = this.peakH;
      this.tick = 0; this.peakW = 0; this.peakH = 0;
      if (cv.width > 2 * pw || cv.height > 2 * ph) { tw = Math.max(w, pw); th = Math.max(h, ph); }
    }
    if (tw === this.hdrW && th === this.hdrH && cv.width === tw && cv.height === th) return true;
    cv.width = tw; cv.height = th;
    gl.bindTexture(gl.TEXTURE_2D, this.hdrTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.hdrTex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { this.hdrW = 0; this.hdrH = 0; return false; }
    this.hdrW = tw; this.hdrH = th;
    return true;
  }

  /** Accumulate `count` halo instances (GLOW_GL_FLOATS floats each, positions
   *  relative to the bbox origin) over a boxW×boxH region, tonemap once, and
   *  return where the finished premultiplied layer sits in the canvas. null on
   *  any failure (the caller falls back to Canvas2D for this frame). */
  render(inst: Float32Array, count: number, boxW: number, boxH: number, intensity: number, steepness: number): GlowGlResult | null {
    if (!this.alive || count <= 0 || boxW <= 0 || boxH <= 0) return null;
    const gl = this.gl;
    if (!this.ensureSize(boxW, boxH)) return null;
    // Instance upload — grow the VBO geometrically, otherwise sub-update.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const view = inst.subarray(0, count * GLOW_GL_FLOATS);
    if (count > this.capacity) {
      this.capacity = Math.max(count, this.capacity * 2, 256);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * STRIDE, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Both passes render the bbox region at the framebuffer origin; the scissor
    // keeps the clears to that region (a grown canvas is mostly unused).
    gl.viewport(0, 0, boxW, boxH);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, boxW, boxH);
    gl.clearColor(0, 0, 0, 0);

    // Pass 1 — ACCUMULATE EXACTLY: additive, unclamped, into the float target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.haloProg);
    gl.uniform2f(this.uBox, boxW, boxH);
    gl.uniform1f(this.uIntensity, intensity);
    gl.uniform1f(this.uSteepness, steepness);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);

    // Pass 2 — COMPRESS ONCE: tonemap the sum onto the (cleared) canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(this.toneProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.hdrTex);
    gl.uniform1i(this.uHdr, 0);
    gl.uniform1f(this.uExposure, GLOW_TONE_EXPOSURE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.SCISSOR_TEST);
    if (this.gl.isContextLost()) return null;
    return { canvas: this.cv, srcX: 0, srcY: this.cv.height - boxH, srcW: boxW, srcH: boxH };
  }

  destroy(): void {
    const gl = this.gl;
    try {
      gl.deleteVertexArray(this.vao); gl.deleteBuffer(this.vbo);
      gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.hdrTex);
      gl.deleteProgram(this.haloProg); gl.deleteProgram(this.toneProg);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* non-fatal */ }
    this.lost = true;
  }
}
