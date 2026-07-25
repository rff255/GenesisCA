/// <reference types="@webgpu/types" />
/**
 * WebGPU runtime — encapsulates device acquisition, buffer/pipeline lifecycle.
 *
 * Owned by the simulation worker. Holds the GPU device, the storage/uniform
 * buffers laid out by `webgpu/layout.ts`, and the compute pipelines compiled
 * from the WGSL emitted by `webgpu/compile.ts`.
 *
 * The runtime stays JS-side (no WGSL is written here — that's the compiler's
 * job). When `useWebGPU` is on AND `stepReady` is true, the worker routes
 * `runStep` / `runColorPass` / mutation handlers through it.
 */

import type { WebGPULayout, WebGPULayoutAttr } from '../../modeler/vpl/compiler/webgpu/layout';
import type { WebGPUEntryPoints } from '../../modeler/vpl/compiler/webgpu/compile';
import {
  type LinkedDef, type ReductionPlan,
  buildReductionPlan, emitReductionShader,
} from './webgpuReduce';
import { acquireSharedGpuDevice, releaseSharedGpuDevice } from './sharedGpuDevice';

export interface WebGPURuntimeInit {
  shaderCode: string;
  entryPoints: WebGPUEntryPoints;
  layout: WebGPULayout;
  /** Optional OffscreenCanvas transferred from the main thread for P7 direct
   *  render. When provided, the worker dispatches a small compute shader that
   *  copies the colors storage buffer into the canvas's current texture each
   *  frame, eliminating the per-frame readback + sendColors round-trip. The
   *  canvas dimensions must match the grid (gridWidth × gridHeight). When
   *  absent, the runtime falls back to the existing readbackColors path. */
  canvas?: OffscreenCanvas;
}

export interface WebGPURuntime {
  device: GPUDevice;
  adapter: GPUAdapter;
  shaderModule: GPUShaderModule;
  layout: WebGPULayout;
  entryPoints: WebGPUEntryPoints;
  /** True once buffers + pipelines are ready and runStepWebGPU can be called. */
  stepReady: boolean;

  // Attrs ping-pong buffers. attrsBufA + attrsBufB are the two underlying
  // GPU buffers, owned for the lifetime of the runtime. attrsReadBuf and
  // attrsWriteBuf are references that flip after every dispatchStep — the
  // "current read" is always whichever buffer holds the live state. This
  // eliminates the per-step W→R copy that used to dominate large grids.
  attrsBufA: GPUBuffer | null;
  attrsBufB: GPUBuffer | null;
  attrsReadBuf: GPUBuffer | null;
  attrsWriteBuf: GPUBuffer | null;
  colorsBuf: GPUBuffer | null;
  /** Small buffer holding (dRow, dCol) i32 pairs per neighbour, keyed by
   *  `WebGPULayoutNbr.wordOffset`. Replaces the old multi-GB per-cell index
   *  table — the WGSL `nbrCellIdx` helper computes cell indices inline. */
  nbrOffsetsBuf: GPUBuffer | null;
  modelAttrsBuf: GPUBuffer | null;
  indicatorsBuf: GPUBuffer | null;
  rngStateBuf: GPUBuffer | null;
  controlBuf: GPUBuffer | null;

  // Pipelines
  bindGroupLayout: GPUBindGroupLayout | null;
  /** Pipeline layout retained for lazy output-mapping pipeline creation —
   *  see ensureOutputPipeline / dispatchOutputMapping. */
  pipelineLayout: GPUPipelineLayout | null;
  /** Two bind group orientations; the active one flips after each step. */
  bindGroupAB: GPUBindGroup | null;
  bindGroupBA: GPUBindGroup | null;
  bindGroup: GPUBindGroup | null;
  stepPipeline: GPUComputePipeline | null;
  /** Variegated Cells: aux buffer holding facePatternLookup (i32) +
   *  interaction-table values (f32 stored as bitcast<u32>). Always created
   *  (stub-sized when variegation is off) so the bind group can bind
   *  binding 8 unconditionally and the pipeline layout stays model-independent. */
  varAuxBuf: GPUBuffer | null;
  /** Per-cell glyph codepoint buffer (binding 9, u32 per cell). Stub-sized
   *  when no setCellGlyph node exists; bound unconditionally so the pipeline
   *  layout stays model-independent. */
  glyphCodesBuf: GPUBuffer | null;
  /** Per-cell glyph colour buffer (binding 10, u32 per cell, R|G<<8|B<<16). */
  glyphColorsBuf: GPUBuffer | null;
  /** Variegated Cells: Init Event compute pipeline (parallel to step). Built
   *  when the compiled shader exposes `entryPoints.init`. Worker dispatches it
   *  on Reset and then swaps the ping-pong bind group so subsequent step reads
   *  see the init writes (mirrors the JS / WASM post-init swap). */
  initPipeline: GPUComputePipeline | null;
  /** One pipeline per outputMapping_<id>. Built lazily on first dispatch
   *  rather than upfront — most models have several mappings but the user
   *  only views one at a time, so building all of them at init wastes
   *  hundreds of ms of GPU pipeline compilation per recompile. Keyed by
   *  mappingId. */
  outputPipelines: Map<string, GPUComputePipeline>;
  /** SHA-ish hash of the WGSL source the current pipelines were built from.
   *  When a recompile lands with the same hash, we skip the (expensive) async
   *  pipeline rebuilds and reuse what's already on the device. */
  shaderHash: string;
  /** P7 direct-render — optional canvas state. When set, runColorPassWebGPU
   *  also dispatches the present pipeline so the canvas is updated in-place
   *  on the GPU, no per-frame readback. */
  canvas: OffscreenCanvas | null;
  canvasContext: GPUCanvasContext | null;
  canvasFormat: GPUTextureFormat | null;
  canvasShaderModule: GPUShaderModule | null;
  presentPipeline: GPUComputePipeline | null;
  presentBindGroupLayout: GPUBindGroupLayout | null;
  /** True iff the canvas was successfully configured and the present pipeline
   *  is built. The worker uses this flag to short-circuit the colors-readback
   *  + sendColors path. */
  directRender: boolean;

  // --- L1 — worker-side WGSL VOXEL render (3D grids on the WebGPU target) ---
  // A second, independent canvas path: instead of blitting the colors buffer 1:1
  // (2D direct render, above), a compute pass COMPACTS the visible cells into an
  // instance buffer and an indirect instanced draw rasterises unit cubes. The CPU
  // never learns the instance count, so no readback, no postMessage, and no
  // main-thread O(total) rescan. Mutually exclusive with `directRender` in
  // practice (the gate is 3D-only), but the two sets of state are separate.
  voxelCanvas: OffscreenCanvas | null;
  voxelCtx: GPUCanvasContext | null;
  voxelDepthTex: GPUTexture | null;
  voxelDepthW: number;
  voxelDepthH: number;
  /** One u32 cell index per VISIBLE cell, written by the compaction pass. Sized
   *  `total` (the worst case: every cell visible) so no capacity readback is
   *  ever needed. */
  voxelInstanceBuf: GPUBuffer | null;
  /** [vertexCount=36, instanceCount, firstVertex=0, firstInstance=0]. The
   *  compaction pass atomically bumps slot 1; the draw reads it indirectly. */
  voxelIndirectBuf: GPUBuffer | null;
  /** The camera / lighting / clip uniform (mirrors VoxelRenderView). */
  voxelViewBuf: GPUBuffer | null;
  voxelCompactPipeline: GPUComputePipeline | null;
  voxelCompactBindGroup: GPUBindGroup | null;
  /** Two draw pipelines differing only in cullMode — gl3d culls cube backfaces
   *  unless a clip interval is open (the cut's visible interior walls ARE
   *  backfaces). Selected per frame from the uniform's clip flag. */
  voxelDrawPipelineCull: GPURenderPipeline | null;
  voxelDrawPipelineNoCull: GPURenderPipeline | null;
  voxelDrawBindGroup: GPUBindGroup | null;
  /** True once the canvas is configured and both pipelines are built. */
  voxelRender: boolean;
  /** Premultiplied clear colour (the 3D background), mirrored from the view. */
  voxelClear: [number, number, number, number];
  /** Whether the current view wants backface culling (no open clip interval). */
  voxelCullBack: boolean;
  /** Scene-anchored wireframe overlays drawn in the SAME depth pass as the cubes
   *  (so voxels in front occlude them — the free-mode two-canvas fix). Mirror
   *  gl3d's renderOverlays; gated per-flag by the Viz3D axes/grid/bounds toggles
   *  the main thread threads via setGridViz. The gizmo / brush plane / brush
   *  outline / hover cells / axis labels stay in gl3d (always-on-top UI). */
  voxelLinePipeline: GPURenderPipeline | null;
  voxelLineBindGroup: GPUBindGroup | null;
  voxelLineBuf: GPUBuffer | null;
  /** Line-vertex count in voxelLineBuf (6 floats/vertex). */
  voxelLineCount: number;
  /** Cache key for the built line geometry (viz flags + dims) — rebuild only on change. */
  voxelLineSig: string;
  /** Which scene wireframes to draw (mirrors Viz3D axes/grid/bounds). */
  voxelViz: { axes: boolean; grid: boolean; bounds: boolean };

  /** L1 free-mode cast shadows (Phase 2). A depth-only pass renders the compacted
   *  cubes from the light POV into voxelShadowTex; the draw FS PCF-samples it. The
   *  2048² depth texture + comparison sampler are always allocated (bound in the
   *  draw bind group) but the extra depth pass only runs when voxelShadowOn — set
   *  from the uniform's shadowStrength each uploadVoxelView. Off ⇒ the draw FS
   *  short-circuits to 1.0 (the texture is bound but never sampled). */
  voxelShadowOn: boolean;
  voxelShadowTex: GPUTexture | null;
  voxelShadowSampler: GPUSampler | null;
  voxelShadowPipeline: GPURenderPipeline | null;
  voxelShadowBindGroup: GPUBindGroup | null;

  /** O5 reduction state — when watched linked indicators have GPU-eligible
   *  aggregations (total / freq-bool / freq-tag), the reductions buffer is
   *  populated by per-indicator atomic kernels each step and read back
   *  instead of doing the equivalent CPU work over a full attrs readback. */
  reductionsBuf: GPUBuffer | null;
  reductionShaderModule: GPUShaderModule | null;
  reductionBindGroupLayout: GPUBindGroupLayout | null;
  reductionBindGroupAB: GPUBindGroup | null;
  reductionBindGroupBA: GPUBindGroup | null;
  /** Pipelines keyed by entry-point name (one per plan entry). */
  reductionPipelines: Map<string, GPUComputePipeline>;
  reductionPlan: ReductionPlan | null;
  /** Reusable MAP_READ staging buffers, keyed by power-of-two byte size.
   *  Each readback acquires a buffer ≥ its required size, uses it, then
   *  releases it back to the pool. Avoids per-readback createBuffer +
   *  destroy churn (~tens of µs each, plus VRAM fragmentation pressure).
   *  Destroyed wholesale by destroyWebGPURuntime. */
  stagingPool: Map<number, PooledStagingBuffer[]>;
}

interface PooledStagingBuffer {
  buffer: GPUBuffer;
  /** Actual allocated size (≥ requested; rounded up to next power of two,
   *  min 64 bytes). */
  size: number;
  inUse: boolean;
}

export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

/** Lightweight string hash — good enough to detect "is this the same shader?".
 *  Not crypto-secure; collisions don't break correctness, just cause an
 *  unnecessary skip. */
export function shaderHashOf(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}_${s.length}`;
}

export async function createWebGPURuntime(init: WebGPURuntimeInit): Promise<WebGPURuntime> {
  if (!isWebGPUAvailable()) {
    throw new Error('navigator.gpu is unavailable in this context');
  }
  // E1: take the worker's shared device (union limits requested once at the
  // singleton). Every runtime shares ONE device so a field-coupled model can
  // bind buffers across the grid + agent runtimes and rebuilds don't re-request
  // the adapter. destroyWebGPURuntime releases this reference.
  const sd = await acquireSharedGpuDevice();
  if (!sd) throw new Error('WebGPU shared device unavailable');
  const { device, adapter } = sd;

  // Everything past the acquire must release the device on failure (the caller's
  // catch only tears down a RETURNED runtime — a throw here has none).
  try {
    const shaderModule = device.createShaderModule({ code: init.shaderCode });
    const info = await shaderModule.getCompilationInfo();
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length > 0) {
      const lines = errors.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n');
      throw new Error('WGSL compile errors:\n' + lines);
    }

    return {
    device, adapter, shaderModule,
    layout: init.layout,
    entryPoints: init.entryPoints,
    stepReady: false,
    attrsBufA: null, attrsBufB: null,
    attrsReadBuf: null, attrsWriteBuf: null, colorsBuf: null,
    nbrOffsetsBuf: null, modelAttrsBuf: null, indicatorsBuf: null,
    rngStateBuf: null, controlBuf: null,
    bindGroupLayout: null,
    pipelineLayout: null,
    bindGroupAB: null, bindGroupBA: null, bindGroup: null,
    stepPipeline: null,
    varAuxBuf: null,
    glyphCodesBuf: null,
    glyphColorsBuf: null,
    initPipeline: null,
    outputPipelines: new Map(),
    shaderHash: shaderHashOf(init.shaderCode),
    stagingPool: new Map(),
    canvas: init.canvas ?? null,
    canvasContext: null,
    canvasFormat: null,
    canvasShaderModule: null,
    presentPipeline: null,
    presentBindGroupLayout: null,
    directRender: false,
    voxelCanvas: null,
    voxelCtx: null,
    voxelDepthTex: null,
    voxelDepthW: 0,
    voxelDepthH: 0,
    voxelInstanceBuf: null,
    voxelIndirectBuf: null,
    voxelViewBuf: null,
    voxelCompactPipeline: null,
    voxelCompactBindGroup: null,
    voxelDrawPipelineCull: null,
    voxelDrawPipelineNoCull: null,
    voxelDrawBindGroup: null,
    voxelRender: false,
    voxelClear: [0, 0, 0, 0],
    voxelCullBack: true,
    voxelLinePipeline: null,
    voxelLineBindGroup: null,
    voxelLineBuf: null,
    voxelLineCount: 0,
    voxelLineSig: '',
    voxelViz: { axes: false, grid: false, bounds: false },
    voxelShadowOn: false,
    voxelShadowTex: null,
    voxelShadowSampler: null,
    voxelShadowPipeline: null,
    voxelShadowBindGroup: null,
    reductionsBuf: null,
    reductionShaderModule: null,
    reductionBindGroupLayout: null,
    reductionBindGroupAB: null,
    reductionBindGroupBA: null,
    reductionPipelines: new Map(),
    reductionPlan: null,
  };
  } catch (err) {
    // A throw after the shared-device acquire (WGSL compile error, etc.) must
    // release the reference or the device leaks for the worker's life.
    releaseSharedGpuDevice(device);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Staging buffer pool — reusable MAP_READ buffers for readback paths.
// Buffers are sized in power-of-two byte classes (min 64) so a small number of
// distinct sizes covers all readbacks (stopFlag/control: 16 → 64 class,
// indicators: ~tens of bytes → 64 class, colors+attrs: large → matching class).
// ---------------------------------------------------------------------------

/** Round up to the next power of two, with a 64-byte floor. Keeps the number
 *  of distinct size classes small (a 100 MB readback and a 50 MB readback
 *  share the 128 MB class) so the pool doesn't fragment. */
function poolSizeClass(byteSize: number): number {
  const min = 64;
  let n = Math.max(min, byteSize | 0);
  // Round up to next power of two.
  n--;
  n |= n >>> 1; n |= n >>> 2; n |= n >>> 4;
  n |= n >>> 8; n |= n >>> 16;
  return (n + 1) >>> 0;
}

/** Acquire a staging buffer with at least `byteSize` bytes of MAP_READ +
 *  COPY_DST capacity. The returned buffer is marked in-use; release via
 *  releaseStagingBuffer once the unmap completes. */
function acquireStagingBuffer(rt: WebGPURuntime, byteSize: number): PooledStagingBuffer {
  const sizeClass = poolSizeClass(byteSize);
  let bucket = rt.stagingPool.get(sizeClass);
  if (!bucket) {
    bucket = [];
    rt.stagingPool.set(sizeClass, bucket);
  }
  for (const entry of bucket) {
    if (!entry.inUse) {
      entry.inUse = true;
      return entry;
    }
  }
  const buf = rt.device.createBuffer({
    label: `staging-${sizeClass}`, size: sizeClass,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const entry: PooledStagingBuffer = { buffer: buf, size: sizeClass, inUse: true };
  bucket.push(entry);
  return entry;
}

/** Mark a previously-acquired staging buffer as available. Caller must have
 *  already unmapped it. */
function releaseStagingBuffer(entry: PooledStagingBuffer): void {
  entry.inUse = false;
}

/** Destroy every pooled staging buffer. Called from destroyWebGPURuntime. */
function destroyStagingPool(rt: WebGPURuntime): void {
  for (const bucket of rt.stagingPool.values()) {
    for (const entry of bucket) {
      try { entry.buffer.destroy(); } catch { /* non-fatal */ }
    }
  }
  rt.stagingPool.clear();
}

/** Allocate the 8 buffers + bind-group + step + output mapping pipelines. */
export async function setupBuffersAndPipelines(rt: WebGPURuntime): Promise<void> {
  const { device, layout } = rt;

  // Defensive size check — surface a clear error before createBuffer's lower-
  // level "buffer size exceeds device limit" exception confuses the user.
  const limit = device.limits.maxStorageBufferBindingSize;
  const offenders: Array<{ name: string; bytes: number }> = [];
  if (layout.attrsBytes > limit) offenders.push({ name: 'attrsRead/Write', bytes: layout.attrsBytes });
  if (layout.nbrBytes > limit) offenders.push({ name: 'nbrOffsets', bytes: layout.nbrBytes });
  if (layout.colorsBytes > limit) offenders.push({ name: 'colors', bytes: layout.colorsBytes });
  if (offenders.length > 0) {
    const fmt = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
    const msgs = offenders.map(o => `${o.name} needs ${fmt(o.bytes)}`).join('; ');
    throw new Error(
      `Grid is too large for WebGPU on this device (max storage buffer ${fmt(limit)}). ${msgs}. Try reducing grid size, simplifying neighbourhoods, or switching to JavaScript / WebAssembly target.`,
    );
  }

  rt.attrsBufA = device.createBuffer({
    label: 'attrsA', size: layout.attrsBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  rt.attrsBufB = device.createBuffer({
    label: 'attrsB', size: layout.attrsBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  // Initial orientation: A is "read", B is "write". After each step they swap.
  rt.attrsReadBuf = rt.attrsBufA;
  rt.attrsWriteBuf = rt.attrsBufB;
  rt.colorsBuf = device.createBuffer({
    label: 'colors', size: layout.colorsBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  rt.nbrOffsetsBuf = device.createBuffer({
    label: 'nbrOffsets', size: layout.nbrBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  rt.modelAttrsBuf = device.createBuffer({
    label: 'modelAttrs', size: layout.modelAttrsBytes,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  rt.indicatorsBuf = device.createBuffer({
    label: 'indicators', size: layout.indicatorsBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  rt.rngStateBuf = device.createBuffer({
    label: 'rngState', size: layout.rngStateBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  rt.controlBuf = device.createBuffer({
    label: 'control', size: layout.controlBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  // Variegated Cells: aux buffer (binding 8). Always created — stub-sized
  // when variegation is off so the bind group can attach binding 8
  // unconditionally and the pipeline layout stays model-independent.
  rt.varAuxBuf = device.createBuffer({
    label: 'varAux', size: layout.varAuxBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Glyph buffers (bindings 9 & 10). Stub-sized when no setCellGlyph exists,
  // bound unconditionally for the same model-independent pipeline-layout
  // reason as varAux. COPY_SRC because the overlay path reads them back.
  rt.glyphCodesBuf = device.createBuffer({
    label: 'glyphCodes', size: layout.glyphCodesBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  rt.glyphColorsBuf = device.createBuffer({
    label: 'glyphColors', size: layout.glyphColorsBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });

  rt.bindGroupLayout = device.createBindGroupLayout({
    label: 'genesisca-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });

  // Two bind group orientations for ping-pong. AB reads A and writes B; BA
  // reads B and writes A. After each step we flip rt.bindGroup so the just-
  // written buffer becomes the next step's "read" — no per-step copy needed.
  const otherEntries = [
    { binding: 2, resource: { buffer: rt.colorsBuf } },
    { binding: 3, resource: { buffer: rt.nbrOffsetsBuf } },
    { binding: 4, resource: { buffer: rt.modelAttrsBuf } },
    { binding: 5, resource: { buffer: rt.indicatorsBuf } },
    { binding: 6, resource: { buffer: rt.rngStateBuf } },
    { binding: 7, resource: { buffer: rt.controlBuf } },
    { binding: 8, resource: { buffer: rt.varAuxBuf } },
    { binding: 9, resource: { buffer: rt.glyphCodesBuf } },
    { binding: 10, resource: { buffer: rt.glyphColorsBuf } },
  ];
  rt.bindGroupAB = device.createBindGroup({
    label: 'genesisca-bg-AB',
    layout: rt.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: rt.attrsBufA } },
      { binding: 1, resource: { buffer: rt.attrsBufB } },
      ...otherEntries,
    ],
  });
  rt.bindGroupBA = device.createBindGroup({
    label: 'genesisca-bg-BA',
    layout: rt.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: rt.attrsBufB } },
      { binding: 1, resource: { buffer: rt.attrsBufA } },
      ...otherEntries,
    ],
  });
  rt.bindGroup = rt.bindGroupAB;

  rt.pipelineLayout = device.createPipelineLayout({
    label: 'genesisca-pl', bindGroupLayouts: [rt.bindGroupLayout],
  });
  rt.stepPipeline = await device.createComputePipelineAsync({
    label: 'genesisca-step', layout: rt.pipelineLayout,
    compute: { module: rt.shaderModule, entryPoint: rt.entryPoints.step },
  });
  // Variegated Cells: Init Event entry point. Built lazily? No — init pipelines
  // are cheap to build relative to step (small WGSL, no neighbour loops in the
  // common case) and the user pays the cost once per recompile. Skip when the
  // compiled shader didn't expose an `init` entry (no InitEventNode in graph).
  if (rt.entryPoints.init) {
    rt.initPipeline = await device.createComputePipelineAsync({
      label: 'genesisca-init', layout: rt.pipelineLayout,
      compute: { module: rt.shaderModule, entryPoint: rt.entryPoints.init },
    });
  } else {
    rt.initPipeline = null;
  }
  // Output mapping pipelines are built lazily by dispatchOutputMapping on
  // first request — see O4 in the WebGPU plan. Models with several mappings
  // (Coagulation, MNCA viewers) save the per-recompile pipeline cost when
  // the user only visualises one at a time.
  rt.outputPipelines.clear();

  // P7 direct render — when a canvas was transferred, set up its WebGPU
  // context + the present pipeline. Failures are logged but non-fatal: the
  // worker falls back to the readback path if directRender stays false.
  if (rt.canvas) {
    try { setupDirectRender(rt); }
    catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[webgpu] direct-render setup failed, falling back to readback path:', e);
      rt.directRender = false;
    }
  }

  rt.stepReady = true;
}

// ---------------------------------------------------------------------------
// P7 — Direct render via OffscreenCanvas
// ---------------------------------------------------------------------------

/** WGSL: copy the colors storage buffer (RGBA8 packed u32 per cell) into the
 *  presented canvas texture. The grid is laid out row-major; the texture
 *  matches grid dimensions. */
function presentShaderSource(canvasFormat: GPUTextureFormat): string {
  return `
@group(0) @binding(0) var<storage, read> colorsIn : array<u32>;
@group(0) @binding(1) var canvasOut : texture_storage_2d<${canvasFormat}, write>;

@compute @workgroup_size(8, 8)
fn presentColors(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = textureDimensions(canvasOut);
  if (gid.x >= dim.x || gid.y >= dim.y) { return; }
  let cellIdx = gid.y * dim.x + gid.x;
  let packed = colorsIn[cellIdx];
  let r = f32((packed >>  0u) & 0xffu) / 255.0;
  let g = f32((packed >>  8u) & 0xffu) / 255.0;
  let b = f32((packed >> 16u) & 0xffu) / 255.0;
  let a = f32((packed >> 24u) & 0xffu) / 255.0;
  // Authorable RGBA alpha (PR7): the canvas is configured 'premultiplied', so
  // write premultiplied RGB. For the default a=1.0 this is identity (r,g,b,1) —
  // every existing opaque model renders unchanged; sub-255 alpha now blends.
  textureStore(canvasOut, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(r * a, g * a, b * a, a));
}
`;
}

export function setupDirectRender(rt: WebGPURuntime): void {
  if (!rt.canvas || !rt.colorsBuf) return;
  const ctx = rt.canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!ctx) throw new Error('OffscreenCanvas.getContext("webgpu") returned null');
  const gpu = (typeof navigator !== 'undefined') ? (navigator as Navigator & { gpu: GPU }).gpu : null;
  // rgba8unorm is universally supported as a texture-storage format and is
  // what colors are packed as in the storage buffer (RGBA8). Don't trust
  // getPreferredCanvasFormat() here — bgra8unorm would require us to swap
  // channel order in the present shader.
  const format: GPUTextureFormat = 'rgba8unorm';
  ctx.configure({
    device: rt.device,
    format,
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    // PR7: 'premultiplied' so authored sub-255 alpha shows through (matches the
    // 2D canvas's source-over compositing). The present shader writes premultiplied
    // RGB; default a=255 → identity, so existing opaque models are unchanged.
    alphaMode: 'premultiplied',
  });
  rt.canvasContext = ctx;
  rt.canvasFormat = format;
  // Avoid the unused `gpu` complaint; it'd be needed for getPreferredCanvasFormat.
  void gpu;

  rt.presentBindGroupLayout = rt.device.createBindGroupLayout({
    label: 'genesisca-present-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format, viewDimension: '2d' } },
    ],
  });
  const presentLayout = rt.device.createPipelineLayout({
    label: 'genesisca-present-pl', bindGroupLayouts: [rt.presentBindGroupLayout],
  });
  rt.canvasShaderModule = rt.device.createShaderModule({ code: presentShaderSource(format) });
  rt.presentPipeline = rt.device.createComputePipeline({
    label: 'genesisca-present',
    layout: presentLayout,
    compute: { module: rt.canvasShaderModule, entryPoint: 'presentColors' },
  });
  rt.directRender = true;
}

const PRESENT_WG = 8;

// ---------------------------------------------------------------------------
// L1 — worker-side WGSL voxel render (3D grids)
//
// A 3D grid on the WebGPU target used to be permanently stuck on the readback
// path: the WebGL2 voxel renderer (gl3d.ts) lives on the MAIN thread and needs a
// CPU colours buffer, so every frame paid a total×4 GPU→CPU readback + a total×4
// copy + a total×4 structured transfer + an O(total) main-thread instance rescan.
// This pass does the whole thing on the GPU instead:
//
//   compaction (compute)  →  visible cells' flat indices into an instance buffer
//                            (alpha ≠ 0, plus the buried-cell cull) + an atomic
//                            instance counter written straight into the indirect
//                            draw args, so the CPU never learns the count
//   draw (indirect)       →  36-vertex unit cubes, one instance per visible cell
//
// Parity with gl3d is deliberate and load-bearing: the SAME Z-up world remap
// (col→+X, row→−Y, layer→−Z), the same ambient + diffuse·n·L + Blinn-Phong
// specular shade, the same clip interval, the same cube scale (cell gaps), the
// same buried-cull eligibility rule, and the MVP + light direction are computed
// on the main thread by the SHARED sceneCameraMatrices / lightWorldDirFor
// helpers gl3d itself uses — so the two renderers cannot disagree on projection
// or lighting. Occupancy AO (VS 6-neighbour scan) AND cast shadows (a depth-only
// light-POV pass + PCF-sampled draw FS, sharing gl3d's computeLightMVP) are BOTH
// replicated. Alpha blend stays a frame-mode feature (the worker's UI-sync flag
// flips back to gl3d for correct back-to-front sorting).
// ---------------------------------------------------------------------------

/** The voxel render's camera + lighting + clip uniform. `mvp` is column-major
 *  (16 f32). Byte layout mirrors VOXEL_VIEW_WGSL + uploadVoxelView. */
export interface VoxelRenderView {
  mvp: number[];                 // 16 floats, column-major
  halfX: number; halfY: number; halfZ: number;          // (W-1)/2 etc.
  lightX: number; lightY: number; lightZ: number;       // world dir TOWARD the light
  viewX: number; viewY: number; viewZ: number;          // world dir toward the viewer
  clipFwdX: number; clipFwdY: number; clipFwdZ: number; // camera forward (clip axis 3)
  ambient: number; diffuse: number; specular: number;
  cubeScale: number;             // 0.92 with cell gaps, 1.001 flush
  clipLo: number; clipHi: number;
  clipEnabled: number;           // 0 / 1
  clipAxis: number;              // 0=x 1=y 2=z 3=camera
  bgR: number; bgG: number; bgB: number; bgA: number;   // clear colour
  /** Buried-cell culling: 1 iff nothing can reveal a fully-enclosed cell
   *  (flush cubes, opaque, no clip) — mirrors gl3d's buriedCullEligible(). */
  cullBuried: number;
  /** Occupancy AO amount (0 = off ⇒ byte-behaviour-identical to no AO). The cube
   *  VS recomputes the 6-face-neighbour occupancy per instance (same scan gl3d
   *  does CPU-side in uploadColors); the FS folds it into the ambient term. */
  aoStrength: number;
  /** Cast-shadow amount (0 = off ⇒ the FS short-circuits shadowFactor to 1.0 and
   *  the shadow depth pass is skipped ⇒ byte-behaviour-identical to no shadows). */
  shadowStrength: number;
  /** Base depth bias in light-clip [0,1] space (scale-relative ~1 cell; mirrors
   *  gl3d's uShadowBias = min(0.02, max(0.0002, 0.9/depthRange))). */
  shadowBias: number;
  /** The directional shadow-map light MVP (16 floats, column-major, GL convention
   *  — from gl3d's shared computeLightMVP; the WGSL applies the GL→WGPU clip
   *  remaps). Empty when shadows off. */
  lightMVP: number[];
}
const VOXEL_VIEW_BYTES = 272;
// Cast-shadow depth-map resolution (mirrors gl3d's SHADOW_SIZE). MUST match the
// `1.0 / 2048.0` texel literal in VOXEL_DRAW_WGSL's shadowFactor.
const VOXEL_SHADOW_SIZE = 2048;

// The `@align(16)` on `ambient` is LOAD-BEARING, not decoration. A `vec3<f32>` has
// align 16 but SIZE 12, so WGSL's natural offset rule
// (offset = roundUp(align(m), offset(prev) + size(prev))) would place a following
// f32 at byte 124 — INSIDE clipFwd's trailing pad — shifting this whole scalar
// block 4 bytes down from the 16-byte-slot layout uploadVoxelView writes. That was
// a real shipped bug: the shader read `cubeScale` out of the specular slot (0 by
// default), every cube collapsed to a zero-size point, and the free-mode voxel
// canvas rendered NOTHING while the compaction (which only reads the members past
// `bg`, whose vec4 alignment re-syncs the layout) looked perfectly healthy. The
// attribute pins the block to byte 128 so the mirror below is exact; the byte
// offsets are annotated on both sides and asserted by scripts/verify-agent-render.mjs.
const VOXEL_VIEW_WGSL = `struct VoxelView {
  mvp                    : mat4x4<f32>,   // @0
  half                   : vec3<f32>,     // @64
  lightDir               : vec3<f32>,     // @80
  viewDir                : vec3<f32>,     // @96
  clipFwd                : vec3<f32>,     // @112 (size 12 → pads to 128)
  @align(16) ambient     : f32,           // @128 — pinned; see the note above
  diffuse                : f32,           // @132
  specular               : f32,           // @136
  cubeScale              : f32,           // @140
  clipLo                 : f32,           // @144
  clipHi                 : f32,           // @148
  clipEnabled            : u32,           // @152
  clipAxis               : u32,           // @156
  bg                     : vec4<f32>,     // @160
  gridW                  : u32,           // @176
  gridWH                 : u32,           // @180
  total                  : u32,           // @184
  cullBuried             : u32,           // @188
  aoStrength             : f32,           // @192 (0 = off)
  shadowStrength         : f32,           // @196 (0 = off)
  shadowBias             : f32,           // @200
  lightMVP               : mat4x4<f32>,   // @208 (align 16 ⇒ @204 is padding, unwritten)
};`;

/** Compaction: one thread per cell. Skips alpha-0 cells and (when eligible)
 *  cells whose 6 face-neighbours are all filled, then atomically appends the
 *  survivor's flat index to the instance buffer. The atomic counter IS slot 1 of
 *  the indirect draw args, so the draw picks up the count with no CPU round trip. */
const VOXEL_COMPACT_WGSL = `${VOXEL_VIEW_WGSL}
@group(0) @binding(0) var<storage, read>       colorsIn  : array<u32>;
@group(0) @binding(1) var<storage, read_write> instances : array<u32>;
@group(0) @binding(2) var<storage, read_write> drawArgs  : array<atomic<u32>>;
@group(0) @binding(3) var<uniform>             vv        : VoxelView;

fn filled(i: u32) -> bool { return ((colorsIn[i] >> 24u) & 0xffu) != 0u; }

@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  // 2-D dispatch tiling (dispatchCells) — a flat 1-D dispatch silently no-ops
  // past 65535*64 ≈ 4.19M cells, which is exactly the 3D-volume regime.
  let idx: u32 = gid.y * (nwg.x * 64u) + gid.x;
  if (idx >= vv.total) { return; }
  if (!filled(idx)) { return; }
  if (vv.cullBuried != 0u) {
    let H: u32 = vv.gridWH / vv.gridW;
    let D: u32 = vv.total / vv.gridWH;
    let layer: u32 = idx / vv.gridWH;
    let rem: u32 = idx - layer * vv.gridWH;
    let row: u32 = rem / vv.gridW;
    let col: u32 = rem - row * vv.gridW;
    var cnt: u32 = 0u;
    if (col > 0u          && filled(idx - 1u))         { cnt = cnt + 1u; }
    if (col + 1u < vv.gridW  && filled(idx + 1u))         { cnt = cnt + 1u; }
    if (row > 0u          && filled(idx - vv.gridW))   { cnt = cnt + 1u; }
    if (row + 1u < H      && filled(idx + vv.gridW))   { cnt = cnt + 1u; }
    if (layer > 0u        && filled(idx - vv.gridWH))  { cnt = cnt + 1u; }
    if (layer + 1u < D    && filled(idx + vv.gridWH))  { cnt = cnt + 1u; }
    if (cnt == 6u) { return; }
  }
  let slot: u32 = atomicAdd(&drawArgs[1], 1u);
  if (slot < arrayLength(&instances)) { instances[slot] = idx; }
}`;

/** Instanced unit cubes. The cube's 36 vertices are generated procedurally (no
 *  const/private array — a per-invocation array would burn private memory for
 *  every vertex thread), with CCW-outward winding so backface culling is valid.
 *  The cell index is read from the compacted instance buffer as a u32 and decoded
 *  with INTEGER math — never route a cell index through f32 (f32 cannot represent
 *  odd integers ≥ 2^24, and a 300³ volume is 27M cells). */
const VOXEL_DRAW_WGSL = `${VOXEL_VIEW_WGSL}
@group(0) @binding(0) var<storage, read> instances : array<u32>;
@group(0) @binding(1) var<storage, read> colorsIn  : array<u32>;
@group(0) @binding(2) var<uniform>       vv        : VoxelView;
@group(0) @binding(3) var shadowMap  : texture_depth_2d;
@group(0) @binding(4) var shadowSamp : sampler_comparison;

struct VSOut {
  @builtin(position) pos    : vec4<f32>,
  @location(0)       color  : vec4<f32>,
  @location(1)       normal : vec3<f32>,
  @location(2)       centre : vec3<f32>,
  @location(3) @interpolate(flat) ao : f32,   // occupancy AO 0..1 (0 exposed, 1 buried)
  @location(4)       fragWorld : vec3<f32>,   // world-space surface point (shadow sampling)
};

fn basisVec(k: u32) -> vec3<f32> {
  return vec3<f32>(f32(k == 0u), f32(k == 1u), f32(k == 2u));
}

fn filled(i: u32) -> bool { return ((colorsIn[i] >> 24u) & 0xffu) != 0u; }

// Cast-shadow sampling — the WGSL analogue of gl3d's SHADOW_GLSL shadowFactor.
// Transform the fragment's WORLD point into the light's clip space (the SHARED
// GL-convention lightMVP), PCF-sample the depth compare (3×3 taps over the
// hardware-2×2 comparison filter), and fold by strength. The GL→WGPU clip remaps:
// z sample ref = ndc.z·½+½ (matches the z:(z+w)·½ remap the depth pass writes),
// uv = ndc.xy·(½,−½)+½ (the −½ on y flips for WGPU's y-down framebuffer/texture).
// shadowStrength ≤ 0 → 1.0 (byte-identical to no shadows; ndl = max(0, N·L)).
fn shadowFactor(fw: vec3<f32>, ndl: f32) -> f32 {
  if (vv.shadowStrength <= 0.0) { return 1.0; }
  let lp: vec4<f32> = vv.lightMVP * vec4<f32>(fw, 1.0);
  let ndc: vec3<f32> = lp.xyz / lp.w;
  let uv: vec2<f32> = ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
  let d: f32 = ndc.z * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || d > 1.0) { return 1.0; }
  let bias: f32 = vv.shadowBias * (1.0 + 3.0 * (1.0 - ndl));  // slope-scaled
  let zRef: f32 = d - bias;   // 'ref' is a WGSL reserved keyword
  let texel: f32 = 1.0 / 2048.0;   // SHADOW_SIZE
  var s: f32 = 0.0;
  for (var y: i32 = -1; y <= 1; y = y + 1) {
    for (var x: i32 = -1; x <= 1; x = x + 1) {
      s = s + textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2<f32>(f32(x), f32(y)) * texel, zRef);
    }
  }
  return mix(1.0, s / 9.0, vv.shadowStrength);
}

@vertex
fn vsMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  let cellIdx: u32 = instances[inst];
  let layer: u32 = cellIdx / vv.gridWH;
  let rem: u32 = cellIdx - layer * vv.gridWH;
  let row: u32 = rem / vv.gridW;
  let col: u32 = rem - row * vv.gridW;
  // Occupancy AO: the SAME 6-face-neighbour scan gl3d does CPU-side in
  // uploadColors (ao = cnt/6). Gated on aoStrength > 0 so the storage reads
  // aren't paid when AO is off (then ao stays 0 ⇒ the FS folds no darkening).
  var ao: f32 = 0.0;
  if (vv.aoStrength > 0.0) {
    let Hn: u32 = vv.gridWH / vv.gridW;
    let Dn: u32 = vv.total / vv.gridWH;
    var cnt: u32 = 0u;
    if (col > 0u          && filled(cellIdx - 1u))         { cnt = cnt + 1u; }
    if (col + 1u < vv.gridW  && filled(cellIdx + 1u))         { cnt = cnt + 1u; }
    if (row > 0u          && filled(cellIdx - vv.gridW))   { cnt = cnt + 1u; }
    if (row + 1u < Hn     && filled(cellIdx + vv.gridW))   { cnt = cnt + 1u; }
    if (layer > 0u        && filled(cellIdx - vv.gridWH))  { cnt = cnt + 1u; }
    if (layer + 1u < Dn   && filled(cellIdx + vv.gridWH))  { cnt = cnt + 1u; }
    ao = f32(cnt) / 6.0;
  }
  // Z-up remap, identical to gl3d's VS: col→+X (right), row→−Y (down the
  // screen, so a top-down view matches the 2D CA), layer→−Z (into the screen).
  let centre: vec3<f32> = vec3<f32>(f32(col) - vv.half.x, vv.half.y - f32(row), vv.half.z - f32(layer));
  // 6 faces × 6 verts. (u, v, n) is right-handed per face ⇒ the [0,1,2,0,2,3]
  // corner order is CCW seen from outside.
  let f: u32 = vi / 6u;
  let axis: u32 = f / 2u;
  let sgn: f32 = select(-1.0, 1.0, (f & 1u) == 0u);
  let n: vec3<f32> = sgn * basisVec(axis);
  let uu: vec3<f32> = sgn * basisVec((axis + 1u) % 3u);
  let vvv: vec3<f32> = basisVec((axis + 2u) % 3u);
  let k: u32 = vi % 6u;
  var ci: u32 = k;
  if (k == 3u) { ci = 0u; } else if (k == 4u) { ci = 2u; } else if (k == 5u) { ci = 3u; }
  let cu: f32 = select(-1.0, 1.0, ci == 1u || ci == 2u);
  let cv: f32 = select(-1.0, 1.0, ci == 2u || ci == 3u);
  let local: vec3<f32> = (n + uu * cu + vvv * cv) * 0.5;
  let world: vec3<f32> = local * vv.cubeScale + centre;
  let packed: u32 = colorsIn[cellIdx];
  var out: VSOut;
  out.pos = vv.mvp * vec4<f32>(world, 1.0);
  out.color = vec4<f32>(
    f32(packed & 0xffu) / 255.0,
    f32((packed >> 8u) & 0xffu) / 255.0,
    f32((packed >> 16u) & 0xffu) / 255.0,
    f32((packed >> 24u) & 0xffu) / 255.0);
  out.normal = n;
  out.centre = centre;
  out.ao = ao;
  out.fragWorld = world;
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  if (vv.clipEnabled == 1u) {
    var w: f32 = dot(in.centre, vv.clipFwd);
    if (vv.clipAxis == 0u) { w = in.centre.x; }
    else if (vv.clipAxis == 1u) { w = in.centre.y; }
    else if (vv.clipAxis == 2u) { w = in.centre.z; }
    if (w < vv.clipLo || w > vv.clipHi) { discard; }
  }
  // Flat directional shade by face normal (identical formula to gl3d's FS).
  // Occupancy AO folds onto ambient (ao = 1 - aoStrength·vAO); cast shadows fold
  // onto diffuse + specular (sh = shadowFactor). Both default to no-op (0 strength).
  let N: vec3<f32> = normalize(in.normal);
  let ndl: f32 = max(0.0, dot(N, vv.lightDir));
  let ao: f32 = 1.0 - vv.aoStrength * in.ao;
  let sh: f32 = shadowFactor(in.fragWorld, ndl);
  var col: vec3<f32> = in.color.rgb * (vv.ambient * ao + vv.diffuse * ndl * sh);
  if (vv.specular > 0.0) {
    let H: vec3<f32> = normalize(vv.lightDir + vv.viewDir);
    col = col + vv.specular * pow(max(0.0, dot(N, H)), 32.0) * sh;
  }
  // Alpha passes through exactly like gl3d's FS (outColor = vec4(col, vColor.a));
  // its WebGL canvas is premultipliedAlpha:true, ours is alphaMode 'premultiplied'.
  return vec4<f32>(col, in.color.a);
}`;

/** Cast-shadow depth pass. Renders the SAME compacted, procedurally-generated
 *  cubes from the LIGHT's ortho POV into a depth24plus shadow texture (gl3d's
 *  CUBE_SHADOW_VS/FS). Depth-only (no colour target). Uses the SHARED GL-convention
 *  lightMVP + the standard GL→WebGPU clip-z remap `p.z = (p.z + p.w)·½` so the
 *  written depth matches the `ndc.z·½+½` reference the draw FS samples. Cull mode
 *  is 'none' (both faces rasterise; the light-facing front wins the depth test —
 *  depth-identical to gl3d's cull-back-when-unclipped, and correct under a clip
 *  cut where interior walls must cast). The FS discards clipped cubes. */
const VOXEL_SHADOW_WGSL = `${VOXEL_VIEW_WGSL}
@group(0) @binding(0) var<storage, read> instances : array<u32>;
@group(0) @binding(1) var<uniform>       vv        : VoxelView;

struct SOut { @builtin(position) pos : vec4<f32>, @location(0) centre : vec3<f32> };

fn basisVec(k: u32) -> vec3<f32> {
  return vec3<f32>(f32(k == 0u), f32(k == 1u), f32(k == 2u));
}

@vertex
fn vsShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> SOut {
  let cellIdx: u32 = instances[inst];
  let layer: u32 = cellIdx / vv.gridWH;
  let rem: u32 = cellIdx - layer * vv.gridWH;
  let row: u32 = rem / vv.gridW;
  let col: u32 = rem - row * vv.gridW;
  let centre: vec3<f32> = vec3<f32>(f32(col) - vv.half.x, vv.half.y - f32(row), vv.half.z - f32(layer));
  let f: u32 = vi / 6u;
  let axis: u32 = f / 2u;
  let sgn: f32 = select(-1.0, 1.0, (f & 1u) == 0u);
  let n: vec3<f32> = sgn * basisVec(axis);
  let uu: vec3<f32> = sgn * basisVec((axis + 1u) % 3u);
  let vvv: vec3<f32> = basisVec((axis + 2u) % 3u);
  let k: u32 = vi % 6u;
  var ci: u32 = k;
  if (k == 3u) { ci = 0u; } else if (k == 4u) { ci = 2u; } else if (k == 5u) { ci = 3u; }
  let cu: f32 = select(-1.0, 1.0, ci == 1u || ci == 2u);
  let cv: f32 = select(-1.0, 1.0, ci == 2u || ci == 3u);
  let local: vec3<f32> = (n + uu * cu + vvv * cv) * 0.5;
  let world: vec3<f32> = local * vv.cubeScale + centre;
  var p: vec4<f32> = vv.lightMVP * vec4<f32>(world, 1.0);
  p.z = (p.z + p.w) * 0.5;   // GL clip-z [-w,w] → WebGPU clip-z [0,w]
  var out: SOut;
  out.pos = p;
  out.centre = centre;
  return out;
}

@fragment
fn fsShadow(in: SOut) {
  if (vv.clipEnabled == 1u) {
    var w: f32 = dot(in.centre, vv.clipFwd);
    if (vv.clipAxis == 0u) { w = in.centre.x; }
    else if (vv.clipAxis == 1u) { w = in.centre.y; }
    else if (vv.clipAxis == 2u) { w = in.centre.z; }
    if (w < vv.clipLo || w > vv.clipHi) { discard; }
  }
}`;

/** Scene-anchored wireframe overlays (bounds box / floor grid / origin axes),
 *  drawn in the SAME render pass + depth buffer as the cubes so voxels in front
 *  occlude them. Reuses the VoxelView uniform (mvp @0) — no new uniform, no
 *  VoxelView widening (see verify-render-uniform-layouts.mjs). Line-list; pos +
 *  colour vertex attributes; depth-test ON + depth-write ON. */
const VOXEL_LINE_WGSL = `${VOXEL_VIEW_WGSL}
@group(0) @binding(0) var<uniform> vv : VoxelView;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) color : vec3<f32> };
@vertex
fn vsMain(@location(0) p : vec3<f32>, @location(1) c : vec3<f32>) -> VSOut {
  var out : VSOut;
  out.pos = vv.mvp * vec4<f32>(p, 1.0);
  out.color = c;
  return out;
}
@fragment
fn fsMain(in : VSOut) -> @location(0) vec4<f32> {
  // Opaque lines; the canvas is premultiplied-alpha, alpha 1 ⇒ colour as-is.
  return vec4<f32>(in.color, 1.0);
}`;

/** Build the bounds / grid / axes line-list vertices (pos.xyz + colour.rgb per
 *  vertex, 6 floats each), mirroring gl3d's renderOverlays EXACTLY (same Z-up
 *  remap, same colours, same >100-cell grid step, same origin-corner axes with
 *  2-pronged arrowheads). Each `viz` flag gates its group; all-off ⇒ empty. */
function buildVoxelOverlayVerts(W: number, H: number, D: number, viz: { axes: boolean; grid: boolean; bounds: boolean }): Float32Array {
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
    const ext = 1.2;
    const axis = (ex: number, ey: number, ez: number, r: number, g: number, b: number) => {
      seg(ox, oy, oz, ex, ey, ez, r, g, b);
      const dx = ex - ox, dy = ey - oy, dz = ez - oz;
      const len = Math.hypot(dx, dy, dz) || 1;
      const ux = dx / len, uy = dy / len, uz = dz / len;
      let px = -uy, py = ux, pz = 0;
      if (Math.hypot(px, py, pz) < 0.1) { px = 0; py = -uz; pz = uy; }
      const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
      const hl = 0.7;
      seg(ex, ey, ez, ex - ux * hl + px * hl * 0.5, ey - uy * hl + py * hl * 0.5, ez - uz * hl + pz * hl * 0.5, r, g, b);
      seg(ex, ey, ez, ex - ux * hl - px * hl * 0.5, ey - uy * hl - py * hl * 0.5, ez - uz * hl - pz * hl * 0.5, r, g, b);
    };
    axis(hx + ext, oy, oz, 0.90, 0.27, 0.27);                 // +col → +X (red)
    axis(ox, -hy - ext, oz, 0.34, 0.82, 0.40);                // +row → -Y (green)
    axis(ox, oy, oz - (D - 1) - ext, 0.36, 0.55, 0.95);       // +depth → -Z (blue)
  }
  return new Float32Array(v);
}

/** Set which scene wireframes the voxel render draws (mirrors Viz3D axes/grid/
 *  bounds). Clears the geometry cache so the next present rebuilds. */
export function uploadVoxelViz(rt: WebGPURuntime, viz: { axes: boolean; grid: boolean; bounds: boolean }): void {
  rt.voxelViz = { axes: !!viz.axes, grid: !!viz.grid, bounds: !!viz.bounds };
  rt.voxelLineSig = '';   // force rebuild on the next present
}

/** (Re)build the line-overlay vertex buffer when the viz flags or grid dims
 *  change. No-op when the signature is unchanged. */
function ensureVoxelLineBuffer(rt: WebGPURuntime): void {
  const W = rt.layout.gridWidth, H = rt.layout.gridHeight, D = rt.layout.gridDepth;
  const viz = rt.voxelViz;
  const sig = `${viz.axes ? 1 : 0}${viz.grid ? 1 : 0}${viz.bounds ? 1 : 0}|${W}|${H}|${D}`;
  if (sig === rt.voxelLineSig && (rt.voxelLineBuf || rt.voxelLineCount === 0)) return;
  rt.voxelLineSig = sig;
  const verts = (viz.axes || viz.grid || viz.bounds) ? buildVoxelOverlayVerts(W, H, D, viz) : new Float32Array(0);
  rt.voxelLineCount = verts.length / 6;
  if (rt.voxelLineBuf) { try { rt.voxelLineBuf.destroy(); } catch { /* non-fatal */ } rt.voxelLineBuf = null; }
  if (verts.length === 0) return;
  const buf = rt.device.createBuffer({
    label: 'voxel-lines', size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  rt.device.queue.writeBuffer(buf, 0, verts);
  rt.voxelLineBuf = buf;
}

/** Ensure the depth attachment matches the canvas size (recreated on resize). */
function ensureVoxelDepthTex(rt: WebGPURuntime, w: number, h: number): GPUTextureView {
  if (!rt.voxelDepthTex || rt.voxelDepthW !== w || rt.voxelDepthH !== h) {
    if (rt.voxelDepthTex) { try { rt.voxelDepthTex.destroy(); } catch { /* non-fatal */ } }
    rt.voxelDepthTex = rt.device.createTexture({
      label: 'voxel-render-depth', size: { width: Math.max(1, w), height: Math.max(1, h) },
      format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    rt.voxelDepthW = w; rt.voxelDepthH = h;
  }
  return rt.voxelDepthTex.createView();
}

/** Write the 192-byte camera/lighting/clip uniform (mirrors VOXEL_VIEW_WGSL). */
export function uploadVoxelView(rt: WebGPURuntime, v: VoxelRenderView): void {
  if (!rt.voxelViewBuf) return;
  const ab = new ArrayBuffer(VOXEL_VIEW_BYTES);
  const f = new Float32Array(ab), u = new Uint32Array(ab);
  for (let i = 0; i < 16; i++) f[i] = v.mvp[i] ?? 0;            // mvp   @0
  f[16] = v.halfX; f[17] = v.halfY; f[18] = v.halfZ;            // half  @64
  f[20] = v.lightX; f[21] = v.lightY; f[22] = v.lightZ;         // light @80
  f[24] = v.viewX; f[25] = v.viewY; f[26] = v.viewZ;            // view  @96
  f[28] = v.clipFwdX; f[29] = v.clipFwdY; f[30] = v.clipFwdZ;   // clipF @112
  // @128 — the scalar block. It only lands here because VOXEL_VIEW_WGSL pins
  // `ambient` with @align(16); without that the shader reads it from @124 and
  // every field below is off by one float (see the note on the struct).
  f[32] = v.ambient; f[33] = v.diffuse; f[34] = v.specular; f[35] = v.cubeScale;
  f[36] = v.clipLo; f[37] = v.clipHi;
  u[38] = v.clipEnabled >>> 0; u[39] = v.clipAxis >>> 0;
  f[40] = v.bgR; f[41] = v.bgG; f[42] = v.bgB; f[43] = v.bgA;   // bg    @160
  u[44] = rt.layout.gridWidth >>> 0;
  u[45] = (rt.layout.gridWidth * rt.layout.gridHeight) >>> 0;
  u[46] = rt.layout.total >>> 0;
  u[47] = v.cullBuried >>> 0;
  f[48] = v.aoStrength;                                         // @192
  f[49] = v.shadowStrength;                                     // @196
  f[50] = v.shadowBias;                                         // @200
  // @204 (f[51]) is padding — the mat4x4 @align(16) pushes lightMVP to @208.
  // Write each of the 16 floats with a LITERAL index so the layout harness
  // detects them (its matrix-loop parser only recognises a 0-based `f[i]` loop).
  const lm = v.lightMVP;
  f[52] = lm[0] ?? 0; f[53] = lm[1] ?? 0; f[54] = lm[2] ?? 0; f[55] = lm[3] ?? 0;
  f[56] = lm[4] ?? 0; f[57] = lm[5] ?? 0; f[58] = lm[6] ?? 0; f[59] = lm[7] ?? 0;
  f[60] = lm[8] ?? 0; f[61] = lm[9] ?? 0; f[62] = lm[10] ?? 0; f[63] = lm[11] ?? 0;
  f[64] = lm[12] ?? 0; f[65] = lm[13] ?? 0; f[66] = lm[14] ?? 0; f[67] = lm[15] ?? 0;
  rt.device.queue.writeBuffer(rt.voxelViewBuf, 0, ab);
  const a = v.bgA;
  rt.voxelClear = [v.bgR * a, v.bgG * a, v.bgB * a, a];
  // gl3d culls cube backfaces unless a clip interval is open (the cut's visible
  // interior walls ARE backfaces). Alpha blending never reaches free mode.
  rt.voxelCullBack = v.clipEnabled === 0;
  // The cast-shadow depth pass runs iff the light contributes shadows this frame.
  rt.voxelShadowOn = v.shadowStrength > 0;
}

/** Build the voxel render on a transferred OffscreenCanvas. Non-fatal on failure
 *  (returns false → the worker keeps the colours-readback path and gl3d renders). */
export async function setupVoxelRender(rt: WebGPURuntime, canvas: OffscreenCanvas): Promise<boolean> {
  try {
    if (!rt.colorsBuf) return false;
    const total = Math.max(1, rt.layout.total);
    const instBytes = total * 4;
    // Same defensive check as setupBuffersAndPipelines: surface an honest
    // fallback instead of a lower-level GPU validation error.
    if (instBytes > rt.device.limits.maxStorageBufferBindingSize) return false;
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) return false;
    const format: GPUTextureFormat = 'rgba8unorm';
    ctx.configure({ device: rt.device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT, alphaMode: 'premultiplied' });

    const compactModule = rt.device.createShaderModule({ label: 'voxel-compact', code: VOXEL_COMPACT_WGSL });
    const drawModule = rt.device.createShaderModule({ label: 'voxel-draw', code: VOXEL_DRAW_WGSL });
    const shadowModule = rt.device.createShaderModule({ label: 'voxel-shadow', code: VOXEL_SHADOW_WGSL });
    for (const [name, mod] of [['compact', compactModule], ['draw', drawModule], ['shadow', shadowModule]] as const) {
      const info = await mod.getCompilationInfo();
      const errs = info.messages.filter(m => m.type === 'error');
      if (errs.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`[webgpu] voxel ${name} WGSL compile errors:\n` + errs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
        return false;
      }
    }

    // Release anything a previous attach built on this runtime (a re-attach
    // fires on every REAL display-size change) — never orphan GPU buffers.
    releaseVoxelResources(rt);

    const instanceBuf = rt.device.createBuffer({
      label: 'voxel-instances', size: instBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const indirectBuf = rt.device.createBuffer({
      label: 'voxel-draw-args', size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    // [vertexCount, instanceCount, firstVertex, firstInstance]. vertexCount is
    // written ONCE; the per-frame clear zeroes only the instanceCount word.
    rt.device.queue.writeBuffer(indirectBuf, 0, new Uint32Array([36, 0, 0, 0]));
    const viewBuf = rt.device.createBuffer({
      label: 'voxel-view', size: VOXEL_VIEW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const compactBgl = rt.device.createBindGroupLayout({
      label: 'voxel-compact-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const compactPipeline = rt.device.createComputePipeline({
      label: 'voxel-compact',
      layout: rt.device.createPipelineLayout({ label: 'voxel-compact-pl', bindGroupLayouts: [compactBgl] }),
      compute: { module: compactModule, entryPoint: 'compact' },
    });
    const compactBindGroup = rt.device.createBindGroup({
      label: 'voxel-compact-bg', layout: compactBgl,
      entries: [
        { binding: 0, resource: { buffer: rt.colorsBuf } },
        { binding: 1, resource: { buffer: instanceBuf } },
        { binding: 2, resource: { buffer: indirectBuf } },
        { binding: 3, resource: { buffer: viewBuf } },
      ],
    });

    // Cast-shadow depth map (Phase 2). Always allocated + bound in the draw group;
    // the depth pass that fills it only runs when shadows are on (else the draw FS
    // short-circuits before sampling). Comparison sampler + linear filter ⇒ free
    // hardware 2×2 PCF per tap, like gl3d's LINEAR + COMPARE_REF depth texture.
    const shadowTex = rt.device.createTexture({
      label: 'voxel-shadow-map', size: { width: VOXEL_SHADOW_SIZE, height: VOXEL_SHADOW_SIZE },
      format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const shadowSampler = rt.device.createSampler({
      label: 'voxel-shadow-samp', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear',
    });

    const drawBgl = rt.device.createBindGroupLayout({
      label: 'voxel-draw-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    const drawPl = rt.device.createPipelineLayout({ label: 'voxel-draw-pl', bindGroupLayouts: [drawBgl] });
    const mkDraw = (label: string, cullMode: GPUCullMode): GPURenderPipeline => rt.device.createRenderPipeline({
      label, layout: drawPl,
      vertex: { module: drawModule, entryPoint: 'vsMain' },
      fragment: { module: drawModule, entryPoint: 'fsMain', targets: [{ format }] },  // opaque (no blend)
      primitive: { topology: 'triangle-list', cullMode },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const drawBindGroup = rt.device.createBindGroup({
      label: 'voxel-draw-bg', layout: drawBgl,
      entries: [
        { binding: 0, resource: { buffer: instanceBuf } },
        { binding: 1, resource: { buffer: rt.colorsBuf } },
        { binding: 2, resource: { buffer: viewBuf } },
        { binding: 3, resource: shadowTex.createView() },
        { binding: 4, resource: shadowSampler },
      ],
    });

    // Depth-only shadow-caster pipeline (light POV). cull 'none' — depth-identical
    // to gl3d's cull-back-when-unclipped (front face wins) and correct under a clip
    // cut. No colour target; the FS only discards clipped cubes.
    const shadowBgl = rt.device.createBindGroupLayout({
      label: 'voxel-shadow-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const shadowPipeline = rt.device.createRenderPipeline({
      label: 'voxel-shadow',
      layout: rt.device.createPipelineLayout({ label: 'voxel-shadow-pl', bindGroupLayouts: [shadowBgl] }),
      vertex: { module: shadowModule, entryPoint: 'vsShadow' },
      fragment: { module: shadowModule, entryPoint: 'fsShadow', targets: [] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const shadowBindGroup = rt.device.createBindGroup({
      label: 'voxel-shadow-bg', layout: shadowBgl,
      entries: [
        { binding: 0, resource: { buffer: instanceBuf } },
        { binding: 1, resource: { buffer: viewBuf } },
      ],
    });

    // Scene-wireframe (bounds/grid/axes) line pipeline — reuses the VoxelView
    // uniform (mvp) so it shares projection with the cubes; depth-tested against
    // the same buffer the cube pass writes, so voxels in front occlude it.
    const lineModule = rt.device.createShaderModule({ label: 'voxel-line', code: VOXEL_LINE_WGSL });
    {
      const info = await lineModule.getCompilationInfo();
      const errs = info.messages.filter(m => m.type === 'error');
      if (errs.length > 0) {
        // eslint-disable-next-line no-console
        console.error('[webgpu] voxel line WGSL compile errors:\n' + errs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
        return false;
      }
    }
    const lineBgl = rt.device.createBindGroupLayout({
      label: 'voxel-line-bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const linePipeline = rt.device.createRenderPipeline({
      label: 'voxel-line', layout: rt.device.createPipelineLayout({ label: 'voxel-line-pl', bindGroupLayouts: [lineBgl] }),
      vertex: {
        module: lineModule, entryPoint: 'vsMain',
        buffers: [{ arrayStride: 24, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ] }],
      },
      fragment: { module: lineModule, entryPoint: 'fsMain', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const lineBindGroup = rt.device.createBindGroup({
      label: 'voxel-line-bg', layout: lineBgl,
      entries: [{ binding: 0, resource: { buffer: viewBuf } }],
    });

    rt.voxelCanvas = canvas;
    rt.voxelCtx = ctx;
    rt.voxelInstanceBuf = instanceBuf;
    rt.voxelIndirectBuf = indirectBuf;
    rt.voxelViewBuf = viewBuf;
    rt.voxelCompactPipeline = compactPipeline;
    rt.voxelCompactBindGroup = compactBindGroup;
    rt.voxelDrawPipelineCull = mkDraw('voxel-draw-cull', 'back');
    rt.voxelDrawPipelineNoCull = mkDraw('voxel-draw-nocull', 'none');
    rt.voxelDrawBindGroup = drawBindGroup;
    rt.voxelLinePipeline = linePipeline;
    rt.voxelLineBindGroup = lineBindGroup;
    rt.voxelLineSig = '';   // force a rebuild against the current viz on the next present
    rt.voxelShadowTex = shadowTex;
    rt.voxelShadowSampler = shadowSampler;
    rt.voxelShadowPipeline = shadowPipeline;
    rt.voxelShadowBindGroup = shadowBindGroup;
    rt.voxelShadowOn = false;
    rt.voxelClear = [0, 0, 0, 0];
    rt.voxelCullBack = true;
    rt.voxelRender = true;
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[webgpu] setupVoxelRender failed:', (e as Error)?.message || String(e));
    rt.voxelRender = false;
    return false;
  }
}

/** Encode compaction + the indirect instanced draw into ONE encoder + ONE submit. */
export function presentVoxels(rt: WebGPURuntime): void {
  if (!rt.voxelRender || !rt.voxelCtx || !rt.voxelCompactPipeline || !rt.voxelCompactBindGroup
      || !rt.voxelDrawBindGroup || !rt.voxelIndirectBuf) return;
  const tex = rt.voxelCtx.getCurrentTexture();
  const view = tex.createView();
  const depthView = ensureVoxelDepthTex(rt, tex.width, tex.height);
  // Rebuild the scene-wireframe geometry (bounds/grid/axes) when the viz flags or
  // dims changed — buffer writes must happen outside the render pass.
  ensureVoxelLineBuffer(rt);
  const enc = rt.device.createCommandEncoder({ label: 'voxel-present-enc' });
  // Zero ONLY the instanceCount word — vertexCount (36) and the first* words
  // were written once at setup.
  enc.clearBuffer(rt.voxelIndirectBuf, 4, 4);
  const cpass = enc.beginComputePass({ label: 'voxel-compact-pass' });
  cpass.setPipeline(rt.voxelCompactPipeline);
  cpass.setBindGroup(0, rt.voxelCompactBindGroup);
  dispatchCells(cpass, rt.layout.total, VOXEL_COMPACT_WG);
  cpass.end();
  // Cast-shadow depth pass (Phase 2): render the SAME compacted cubes from the
  // light POV into the shadow depth map, so the display FS can PCF-sample it. Only
  // when shadows are on; the compacted instance buffer + indirect count are shared.
  if (rt.voxelShadowOn && rt.voxelShadowPipeline && rt.voxelShadowBindGroup && rt.voxelShadowTex) {
    const spass = enc.beginRenderPass({
      label: 'voxel-shadow-pass',
      colorAttachments: [],
      depthStencilAttachment: {
        view: rt.voxelShadowTex.createView(),
        depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    });
    spass.setPipeline(rt.voxelShadowPipeline);
    spass.setBindGroup(0, rt.voxelShadowBindGroup);
    spass.drawIndirect(rt.voxelIndirectBuf, 0);
    spass.end();
  }
  const [cr, cg, cb, ca] = rt.voxelClear;
  const rpass = enc.beginRenderPass({
    label: 'voxel-draw-pass',
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: cr, g: cg, b: cb, a: ca } }],
    depthStencilAttachment: { view: depthView, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  const pipe = rt.voxelCullBack ? rt.voxelDrawPipelineCull : rt.voxelDrawPipelineNoCull;
  if (pipe) {
    rpass.setPipeline(pipe);
    rpass.setBindGroup(0, rt.voxelDrawBindGroup);
    rpass.drawIndirect(rt.voxelIndirectBuf, 0);
  }
  // Scene wireframes (bounds/grid/axes) in the SAME pass ⇒ shared depth ⇒ voxels
  // in front occlude them (the free-mode two-canvas bug fix). Depth-write ON so
  // the axis arrowheads self-order; drawn after the cubes but depth handles order.
  if (rt.voxelLinePipeline && rt.voxelLineBindGroup && rt.voxelLineBuf && rt.voxelLineCount > 0) {
    rpass.setPipeline(rt.voxelLinePipeline);
    rpass.setBindGroup(0, rt.voxelLineBindGroup);
    rpass.setVertexBuffer(0, rt.voxelLineBuf);
    rpass.draw(rt.voxelLineCount);
  }
  rpass.end();
  rt.device.queue.submit([enc.finish()]);
}

const VOXEL_COMPACT_WG = 64;

/** DEV probe (verification only — the app never calls this). Present one frame,
 *  then read the indirect draw args back so a test can assert the GPU-computed
 *  instance count against an independently computed visible-cell count. This is
 *  the definitive correctness proof for the compaction while the pane is occluded
 *  (composited pixels are unreadable there). Optionally returns the first
 *  `sampleInstances` compacted cell indices. */
export async function debugReadVoxelInstances(
  rt: WebGPURuntime, sampleInstances = 0,
): Promise<{ instanceCount: number; vertexCount: number; sample: number[] } | null> {
  if (!rt.voxelRender || !rt.voxelIndirectBuf || !rt.voxelInstanceBuf) return null;
  presentVoxels(rt);
  const args = await readbackBufferBytes(rt, rt.voxelIndirectBuf, 0, 16);
  const a32 = new Uint32Array(args.buffer, args.byteOffset, 4);
  const instanceCount = a32[1] ?? 0;
  const sample: number[] = [];
  const n = Math.min(sampleInstances, instanceCount);
  if (n > 0) {
    const bytes = await readbackBufferBytes(rt, rt.voxelInstanceBuf, 0, n * 4);
    const i32 = new Uint32Array(bytes.buffer, bytes.byteOffset, n);
    for (let i = 0; i < n; i++) sample.push(i32[i]!);
  }
  return { instanceCount, vertexCount: a32[0] ?? 0, sample };
}

/** Copy `size` bytes out of a GPU buffer through the staging pool. */
async function readbackBufferBytes(rt: WebGPURuntime, src: GPUBuffer, offset: number, size: number): Promise<Uint8Array> {
  const pooled = acquireStagingBuffer(rt, size);
  const enc = rt.device.createCommandEncoder({ label: 'voxel-debug-readback-enc' });
  enc.copyBufferToBuffer(src, offset, pooled.buffer, 0, size);
  rt.device.queue.submit([enc.finish()]);
  await pooled.buffer.mapAsync(GPUMapMode.READ, 0, size);
  const out = new Uint8Array(pooled.buffer.getMappedRange(0, size)).slice();
  pooled.buffer.unmap();
  releaseStagingBuffer(pooled);
  return out;
}

/** Destroy the voxel buffers + depth texture (shared by re-attach and teardown).
 *  Leaves the canvas context alone — the caller decides whether to unconfigure. */
function releaseVoxelResources(rt: WebGPURuntime): void {
  for (const buf of [rt.voxelInstanceBuf, rt.voxelIndirectBuf, rt.voxelViewBuf, rt.voxelLineBuf]) {
    if (buf) { try { buf.destroy(); } catch { /* non-fatal */ } }
  }
  rt.voxelInstanceBuf = null; rt.voxelIndirectBuf = null; rt.voxelViewBuf = null;
  rt.voxelLineBuf = null; rt.voxelLineCount = 0; rt.voxelLineSig = '';
  if (rt.voxelDepthTex) { try { rt.voxelDepthTex.destroy(); } catch { /* non-fatal */ } }
  rt.voxelDepthTex = null; rt.voxelDepthW = 0; rt.voxelDepthH = 0;
  if (rt.voxelShadowTex) { try { rt.voxelShadowTex.destroy(); } catch { /* non-fatal */ } }
  rt.voxelShadowTex = null; rt.voxelShadowSampler = null;
  rt.voxelShadowPipeline = null; rt.voxelShadowBindGroup = null; rt.voxelShadowOn = false;
  rt.voxelCompactPipeline = null; rt.voxelCompactBindGroup = null;
  rt.voxelDrawPipelineCull = null; rt.voxelDrawPipelineNoCull = null; rt.voxelDrawBindGroup = null;
  rt.voxelLinePipeline = null; rt.voxelLineBindGroup = null;
}

/** Full teardown — buffers, depth texture, and the canvas context binding. */
export function destroyVoxelRender(rt: WebGPURuntime): void {
  releaseVoxelResources(rt);
  if (rt.voxelCtx) { try { rt.voxelCtx.unconfigure(); } catch { /* non-fatal */ } }
  rt.voxelCtx = null;
  rt.voxelCanvas = null;
  rt.voxelRender = false;
}

// ---------------------------------------------------------------------------
// O5 — GPU-side reduction for watched linked indicators
// ---------------------------------------------------------------------------

/** (Re)build the reduction shader, pipelines and reductions buffer for the
 *  given watched linked indicators. Called by the worker after each setup
 *  or recompile. Tears down any previous reduction state first. */
export function setupReductionPipelines(rt: WebGPURuntime, linkedDefs: LinkedDef[]): void {
  // Tear down previous state.
  if (rt.reductionsBuf) { try { rt.reductionsBuf.destroy(); } catch { /* ok */ } }
  rt.reductionsBuf = null;
  rt.reductionShaderModule = null;
  rt.reductionBindGroupLayout = null;
  rt.reductionBindGroupAB = null;
  rt.reductionBindGroupBA = null;
  rt.reductionPipelines = new Map();
  rt.reductionPlan = null;

  const plan = buildReductionPlan(linkedDefs, rt.layout);
  if (plan.entries.length === 0) {
    // No GPU-eligible watched indicators — leave plan unset; worker stays on
    // the existing CPU readback path for any remaining watched indicators.
    return;
  }
  rt.reductionPlan = plan;

  rt.reductionsBuf = rt.device.createBuffer({
    label: 'reductions',
    size: Math.max(16, plan.totalSlots * 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  rt.reductionBindGroupLayout = rt.device.createBindGroupLayout({
    label: 'genesisca-reduce-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  // Two bind groups so we read from whichever attrs buffer is "current read"
  // — mirrors the step shader's ping-pong AB/BA orientation. Without this,
  // reductions would read stale data after the first step's swap.
  if (rt.attrsBufA && rt.attrsBufB && rt.reductionsBuf) {
    rt.reductionBindGroupAB = rt.device.createBindGroup({
      label: 'reduce-bg-AB',
      layout: rt.reductionBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: rt.attrsBufA } },
        { binding: 1, resource: { buffer: rt.reductionsBuf } },
      ],
    });
    rt.reductionBindGroupBA = rt.device.createBindGroup({
      label: 'reduce-bg-BA',
      layout: rt.reductionBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: rt.attrsBufB } },
        { binding: 1, resource: { buffer: rt.reductionsBuf } },
      ],
    });
  }

  const wgsl = emitReductionShader(plan, rt.layout.total);
  rt.reductionShaderModule = rt.device.createShaderModule({ label: 'reduce-shader', code: wgsl });
  const reduceLayout = rt.device.createPipelineLayout({
    label: 'reduce-pl', bindGroupLayouts: [rt.reductionBindGroupLayout],
  });
  for (const e of plan.entries) {
    const pipe = rt.device.createComputePipeline({
      label: `reduce-${e.entry}`,
      layout: reduceLayout,
      compute: { module: rt.reductionShaderModule, entryPoint: e.entry },
    });
    rt.reductionPipelines.set(e.entry, pipe);
  }
}

const REDUCE_WG = 64;

/** WebGPU caps `dispatchWorkgroups` at `maxComputeWorkgroupsPerDimension`
 *  (65535 — the hardware/spec ceiling, even when we request the adapter max).
 *  A flat 1-D per-cell dispatch (`ceil(total/64)` groups) therefore SILENTLY
 *  fails — no error, the kernel just never runs — once `total > 65535*64 ≈
 *  4.19M` cells, which blanks the whole WebGPU sim on big 2D grids (e.g. the
 *  5000×5000 target = 25M) AND any 3D volume past ~4.2M cells. Fix: tile the
 *  dispatch into a 2-D workgroup grid. The per-cell shaders recover the linear
 *  index as `gid.y * (num_workgroups.x * 64) + gid.x` (see emitEntryPoint /
 *  the reduction shader). For grids that fit one dimension (≤ 65535*WG cells)
 *  this dispatches `(groups, 1)` — `gid.y == 0`, so `idx == gid.x`, identical
 *  to the old 1-D path. */
const MAX_WG_PER_DIM = 65535;
function dispatchCells(pass: GPUComputePassEncoder, total: number, wg: number): void {
  const groups = Math.max(1, Math.ceil(total / wg));
  const x = Math.min(groups, MAX_WG_PER_DIM);
  const y = Math.ceil(groups / MAX_WG_PER_DIM);
  pass.dispatchWorkgroups(x, y);
}

/** Zero the reductions buffer + dispatch every reduction kernel. The
 *  reductions buffer is re-zeroed every step so accumulation across
 *  generations stays a worker-side decision (per-gen vs accumulated). */
export function dispatchReductions(rt: WebGPURuntime): void {
  if (!rt.reductionPlan || !rt.reductionsBuf || !rt.reductionBindGroupLayout) return;
  // Zero the buffer via writeBuffer (one queue submission).
  const zero = new Uint32Array(rt.reductionPlan.totalSlots);
  rt.device.queue.writeBuffer(rt.reductionsBuf, 0, zero);
  // Dispatch each kernel using the bind group orientation that matches the
  // current "read" buffer.
  const bg = (rt.bindGroup === rt.bindGroupAB ? rt.reductionBindGroupAB : rt.reductionBindGroupBA);
  if (!bg) return;
  const enc = rt.device.createCommandEncoder({ label: 'reduce-enc' });
  const pass = enc.beginComputePass({ label: 'reduce-pass' });
  pass.setBindGroup(0, bg);
  for (const e of rt.reductionPlan.entries) {
    const pipe = rt.reductionPipelines.get(e.entry);
    if (!pipe) continue;
    pass.setPipeline(pipe);
    dispatchCells(pass, rt.layout.total, REDUCE_WG);
  }
  pass.end();
  rt.device.queue.submit([enc.finish()]);
}

/** Read the reductions buffer back. Small (typically a few u32s); cheap
 *  mapAsync. Returns the raw Uint32Array (caller decodes via decodeReductions). */
export async function readbackReductions(rt: WebGPURuntime): Promise<Uint32Array | null> {
  if (!rt.reductionPlan || !rt.reductionsBuf) return null;
  const size = Math.max(16, rt.reductionPlan.totalSlots * 4);
  const pooled = acquireStagingBuffer(rt, size);
  const stagingBuf = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'reduce-readback-enc' });
  enc.copyBufferToBuffer(rt.reductionsBuf, 0, stagingBuf, 0, size);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ, 0, size);
  const view = new Uint32Array(stagingBuf.getMappedRange(0, size).slice(0, rt.reductionPlan.totalSlots * 4));
  stagingBuf.unmap();
  releaseStagingBuffer(pooled);
  return view;
}

/** Dispatch the present pipeline: copy the colors storage buffer into the
 *  canvas's current texture. No-op when direct render isn't active. */
export function presentToCanvas(rt: WebGPURuntime): void {
  if (!rt.directRender || !rt.canvasContext || !rt.presentPipeline || !rt.colorsBuf || !rt.presentBindGroupLayout) return;
  const tex = rt.canvasContext.getCurrentTexture();
  const view = tex.createView();
  const bg = rt.device.createBindGroup({
    label: 'present-bg',
    layout: rt.presentBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: rt.colorsBuf } },
      { binding: 1, resource: view },
    ],
  });
  const enc = rt.device.createCommandEncoder({ label: 'present-enc' });
  const pass = enc.beginComputePass({ label: 'present-pass' });
  pass.setPipeline(rt.presentPipeline);
  pass.setBindGroup(0, bg);
  const w = tex.width, h = tex.height;
  pass.dispatchWorkgroups(Math.ceil(w / PRESENT_WG), Math.ceil(h / PRESENT_WG));
  pass.end();
  rt.device.queue.submit([enc.finish()]);
}

// ---------------------------------------------------------------------------
// Pack / unpack — convert worker-side typed arrays to/from GPU u32 SoA layout.
// ---------------------------------------------------------------------------

export type WorkerAttrArrays = Record<string, ArrayLike<number> & { length: number }>;

export function packAttrsForUpload(layout: WebGPULayout, srcAttrs: WorkerAttrArrays): Uint8Array {
  const buf = new Uint8Array(layout.attrsBytes);
  const view = new DataView(buf.buffer);
  for (const a of layout.attrs) {
    const src = srcAttrs[a.id];
    if (!src) continue;
    writeAttrIntoView(view, a, src);
  }
  return buf;
}

export function packAttrIntoUpload(layout: WebGPULayout, attrId: string, src: ArrayLike<number>): { bytes: Uint8Array; offset: number } | null {
  const a = layout.attrs.find(x => x.id === attrId);
  if (!a) return null;
  const buf = new Uint8Array(a.count * 4);
  const view = new DataView(buf.buffer);
  // Pack at offset 0 in this buffer (we write at GPU offset a.byteOffset).
  writeAttrIntoView(view, { ...a, byteOffset: 0 }, src);
  return { bytes: buf, offset: a.byteOffset };
}

function writeAttrIntoView(view: DataView, a: WebGPULayoutAttr, src: ArrayLike<number>): void {
  const n = Math.min(a.count, src.length);
  if (a.type === 'bool') {
    for (let i = 0; i < n; i++) view.setUint32(a.byteOffset + i * 4, (src[i] ?? 0) ? 1 : 0, true);
  } else if (a.type === 'integer' || a.type === 'tag') {
    for (let i = 0; i < n; i++) view.setInt32(a.byteOffset + i * 4, (src[i] ?? 0) | 0, true);
  } else if (a.type === 'float') {
    for (let i = 0; i < n; i++) view.setFloat32(a.byteOffset + i * 4, src[i] ?? 0, true);
  } else {
    for (let i = 0; i < n; i++) view.setUint32(a.byteOffset + i * 4, 0, true);
  }
}

/** Unpack a single attribute's bytes (size = count*4) into `dstAttrs[attrId]`.
 *  Used by selective readbacks where only one attr was copied out. */
export function unpackAttrFromReadback(
  layout: WebGPULayout, attrId: string, srcU8: Uint8Array, dstAttrs: WorkerAttrArrays,
): void {
  const a = layout.attrs.find(x => x.id === attrId);
  if (!a) return;
  const dst = dstAttrs[a.id];
  if (!dst) return;
  const view = new DataView(srcU8.buffer, srcU8.byteOffset, srcU8.byteLength);
  const n = Math.min(a.count, dst.length);
  if (a.type === 'bool') {
    for (let i = 0; i < n; i++) (dst as { [k: number]: number })[i] = view.getUint32(i * 4, true) ? 1 : 0;
  } else if (a.type === 'integer' || a.type === 'tag') {
    for (let i = 0; i < n; i++) (dst as { [k: number]: number })[i] = view.getInt32(i * 4, true);
  } else if (a.type === 'float') {
    for (let i = 0; i < n; i++) (dst as { [k: number]: number })[i] = view.getFloat32(i * 4, true);
  }
}

export function unpackAttrsFromReadback(
  layout: WebGPULayout, srcU8: Uint8Array, dstAttrs: WorkerAttrArrays,
): void {
  const view = new DataView(srcU8.buffer, srcU8.byteOffset, srcU8.byteLength);
  for (const a of layout.attrs) {
    const dst = dstAttrs[a.id];
    if (!dst) continue;
    const n = Math.min(a.count, dst.length);
    if (a.type === 'bool') {
      for (let i = 0; i < n; i++) (dst as { [k: number]: number })[i] = view.getUint32(a.byteOffset + i * 4, true) ? 1 : 0;
    } else if (a.type === 'integer' || a.type === 'tag') {
      for (let i = 0; i < n; i++) (dst as { [k: number]: number })[i] = view.getInt32(a.byteOffset + i * 4, true);
    } else if (a.type === 'float') {
      for (let i = 0; i < n; i++) (dst as { [k: number]: number })[i] = view.getFloat32(a.byteOffset + i * 4, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

export function uploadAttrs(rt: WebGPURuntime, srcAttrs: WorkerAttrArrays): void {
  if (!rt.attrsReadBuf) return;
  const packed = packAttrsForUpload(rt.layout, srcAttrs);
  // Only attrsReadBuf needs the new state. The next step's per-cell copy
  // preamble (`attrsWrite[idx] = attrsRead[idx]`) populates attrsWriteBuf
  // before any read, so a second writeBuffer here is dead bandwidth.
  rt.device.queue.writeBuffer(rt.attrsReadBuf, 0, packed);
}

/** Upload a single attribute (efficient path — only sends the bytes for one
 *  attr's region, not the whole grid). Used by mutation handlers when only
 *  one attr was touched. */
export function uploadAttr(rt: WebGPURuntime, attrId: string, src: ArrayLike<number>): void {
  if (!rt.attrsReadBuf) return;
  const packed = packAttrIntoUpload(rt.layout, attrId, src);
  if (!packed) return;
  rt.device.queue.writeBuffer(rt.attrsReadBuf, packed.offset, packed.bytes);
}

/** Upload the neighbour-offset table (vec2<i32>(dRow, dCol) per neighbour, per
 *  neighbourhood). The data lives on the layout itself — `coords` was captured
 *  at `computeWebGPULayout` time — so no parameter is needed beyond the
 *  runtime. The previous shape took a `Record<string, Int32Array>` of per-cell
 *  index tables; that table has been replaced by inline shader math (see the
 *  WGSL `nbrCellIdx` helper in encoder.ts). */
export function uploadNeighborOffsets(rt: WebGPURuntime): void {
  if (!rt.nbrOffsetsBuf) return;
  const buf = new Uint8Array(rt.layout.nbrBytes);
  const view = new DataView(buf.buffer);
  // 3D Grid CA: a 3D layout packs 3 i32 per neighbour (dRow, dCol, dLayer),
  // matching the encoder's `* 3u` stride; 2D packs 2 (dRow, dCol).
  const is3d = rt.layout.gridDepth > 1;
  for (const n of rt.layout.nbrs) {
    // `wordOffset` is the starting i32-element index inside the buffer for this
    // neighbourhood — matches what the compiler emits as `baseOffset`.
    let off = n.byteOffset;
    if (is3d) {
      const c3 = n.coords3d ?? n.coords.map(c => [c[0], c[1], 0] as [number, number, number]);
      for (let k = 0; k < c3.length; k++) {
        const t = c3[k]!;
        view.setInt32(off, t[0] | 0, true); off += 4;
        view.setInt32(off, t[1] | 0, true); off += 4;
        view.setInt32(off, (t[2] ?? 0) | 0, true); off += 4;
      }
    } else {
      for (let k = 0; k < n.coords.length; k++) {
        const pair = n.coords[k]!;
        view.setInt32(off, pair[0] | 0, true); off += 4;
        view.setInt32(off, pair[1] | 0, true); off += 4;
      }
    }
  }
  rt.device.queue.writeBuffer(rt.nbrOffsetsBuf, 0, buf);
}

export function uploadModelAttrs(rt: WebGPURuntime, modelAttrs: Record<string, number>): void {
  if (!rt.modelAttrsBuf) return;
  const buf = new Uint8Array(rt.layout.modelAttrsBytes);
  const view = new DataView(buf.buffer);
  for (const [key, off] of Object.entries(rt.layout.modelAttrOffset)) {
    view.setFloat32(off, modelAttrs[key] ?? 0, true);
  }
  rt.device.queue.writeBuffer(rt.modelAttrsBuf, 0, buf);
}

export function uploadActiveViewer(rt: WebGPURuntime, viewerId: number): void {
  if (!rt.controlBuf) return;
  const buf = new Int32Array([viewerId | 0]);
  rt.device.queue.writeBuffer(rt.controlBuf, rt.layout.controlOffsets.activeViewer, buf);
}

export function resetStopFlag(rt: WebGPURuntime): void {
  if (!rt.controlBuf) return;
  const buf = new Uint32Array([0]);
  rt.device.queue.writeBuffer(rt.controlBuf, rt.layout.controlOffsets.stopFlag, buf);
}

/** Seed the rngState buffer with one PCG-distributed u32 per cell, derived
 *  from a global seed. Different from JS/WASM single-stream xorshift — see
 *  CLAUDE.md WebGPU section. */
export function seedRngState(rt: WebGPURuntime, globalSeed: number): void {
  if (!rt.rngStateBuf) return;
  const total = rt.layout.total;
  const buf = new Uint32Array(total);
  let s = (globalSeed | 0) >>> 0;
  if (s === 0) s = 1;
  for (let i = 0; i < total; i++) {
    s = ((s ^ (s << 13)) | 0) >>> 0;
    s = ((s ^ (s >>> 17)) | 0) >>> 0;
    s = ((s ^ (s << 5)) | 0) >>> 0;
    buf[i] = s;
  }
  rt.device.queue.writeBuffer(rt.rngStateBuf, 0, buf);
}

/** Upload encoded indicator values. The compiler bitcasts the u32 atomic word
 *  as either f32 (most ops, linked sums, standalone float) or i32 (standalone
 *  integer/tag/bool reads via getIndicator). The caller passes
 *  `isIntEncoded(id)` so per-id encoding lines up with the compiler — without
 *  it, an integer indicator default of `5` would land as 0x40A00000 and
 *  getIndicator's bitcast<i32> would read back ~1.08 billion. */
export function uploadIndicators(
  rt: WebGPURuntime,
  values: Record<string, number>,
  isIntEncoded?: (id: string) => boolean,
): void {
  if (!rt.indicatorsBuf) return;
  const buf = new Uint8Array(rt.layout.indicatorsBytes);
  const view = new DataView(buf.buffer);
  let i = 0;
  for (const id of rt.layout.indicatorIds) {
    const v = values[id] ?? 0;
    if (isIntEncoded && isIntEncoded(id)) view.setInt32(i * 4, v | 0, true);
    else view.setFloat32(i * 4, v, true);
    i++;
  }
  rt.device.queue.writeBuffer(rt.indicatorsBuf, 0, buf);
}

/** Upload values for a specific subset of indicator slot indices (by index in
 *  layout.indicatorIds). Used by the per-step path to reset only the per-gen
 *  standalone slots, not the entire indicators buffer. Each slot is written
 *  with its own writeBuffer at the slot's byte offset — for small subsets
 *  (typical: 1–3 per-gen indicators per model) this is cheaper than packing
 *  the full buffer and one big writeBuffer. */
export function uploadIndicatorsAt(
  rt: WebGPURuntime,
  slotIdxs: ArrayLike<number>,
  values: Record<string, number>,
  isIntEncoded?: (id: string) => boolean,
): void {
  if (!rt.indicatorsBuf || slotIdxs.length === 0) return;
  const word = new ArrayBuffer(4);
  const view = new DataView(word);
  for (let k = 0; k < slotIdxs.length; k++) {
    const i = slotIdxs[k]!;
    const id = rt.layout.indicatorIds[i];
    if (id === undefined) continue;
    const v = values[id] ?? 0;
    if (isIntEncoded && isIntEncoded(id)) view.setInt32(0, v | 0, true);
    else view.setFloat32(0, v, true);
    rt.device.queue.writeBuffer(rt.indicatorsBuf, i * 4, word);
  }
}

// ---------------------------------------------------------------------------
// Step / output mapping dispatch
// ---------------------------------------------------------------------------

const WORKGROUP_SIZE = 64;

/** Encode + submit one step. After dispatch we swap the read/write buffer
 *  references AND flip the active bind group so the next step reads the
 *  just-written buffer. No copyBufferToBuffer — that copy used to dominate
 *  step time on large grids (~1 GB/s of bandwidth at 5000×5000). */
export function dispatchStep(rt: WebGPURuntime): void {
  if (!rt.stepReady || !rt.stepPipeline || !rt.bindGroup) return;
  const enc = rt.device.createCommandEncoder({ label: 'step-enc' });
  const pass = enc.beginComputePass({ label: 'step-pass' });
  pass.setPipeline(rt.stepPipeline);
  pass.setBindGroup(0, rt.bindGroup);
  dispatchCells(pass, rt.layout.total, WORKGROUP_SIZE);
  pass.end();
  rt.device.queue.submit([enc.finish()]);
  // Swap orientation. The buffer that was just written becomes "current read"
  // (output mappings and next-step inputs see the new state); the previous
  // "read" buffer is recycled as the next step's "write" target.
  const prevRead = rt.attrsReadBuf;
  rt.attrsReadBuf = rt.attrsWriteBuf;
  rt.attrsWriteBuf = prevRead;
  rt.bindGroup = rt.bindGroup === rt.bindGroupAB ? rt.bindGroupBA : rt.bindGroupAB;
}

/** Variegated Cells: Init Event dispatch. Per-cell entry point that runs ONCE
 *  on Reset (mirrors the JS / WASM `runInit` semantics). Uses the same bind
 *  group as the step shader (orientation + facePatternLookup + interaction
 *  tables read from the same bindings); same buffer-swap semantics so the
 *  next step reads init-time writes from what is now `attrsReadBuf`. Returns
 *  false when no init pipeline was compiled. */
export function dispatchInit(rt: WebGPURuntime): boolean {
  if (!rt.stepReady || !rt.initPipeline || !rt.bindGroup) return false;
  const enc = rt.device.createCommandEncoder({ label: 'init-enc' });
  const pass = enc.beginComputePass({ label: 'init-pass' });
  pass.setPipeline(rt.initPipeline);
  pass.setBindGroup(0, rt.bindGroup);
  dispatchCells(pass, rt.layout.total, WORKGROUP_SIZE);
  pass.end();
  rt.device.queue.submit([enc.finish()]);
  // Same swap as step: init writes land in attrsWriteBuf; flip so subsequent
  // step / color reads see them as the new "current read".
  const prevRead = rt.attrsReadBuf;
  rt.attrsReadBuf = rt.attrsWriteBuf;
  rt.attrsWriteBuf = prevRead;
  rt.bindGroup = rt.bindGroup === rt.bindGroupAB ? rt.bindGroupBA : rt.bindGroupAB;
  return true;
}

/** Variegated Cells: upload the per-cell orientation region into the current
 *  read buffer. The orientation region lives co-located with cell attrs inside
 *  attrsBufA/B at `layout.orientationWordOffset`. After upload the value is
 *  visible to the next step / color pass (which read from attrsReadBuf). */
export function uploadOrientation(rt: WebGPURuntime, src: ArrayLike<number>): void {
  if (!rt.attrsReadBuf || !rt.layout.variegatedEnabled) return;
  const count = Math.min(src.length, rt.layout.cellsPerAttr);
  const packed = new Uint32Array(count);
  for (let i = 0; i < count; i++) packed[i] = (src[i] ?? 0) & 0xffffffff;
  const byteOffset = rt.layout.orientationWordOffset * 4;
  rt.device.queue.writeBuffer(rt.attrsReadBuf, byteOffset, packed);
}

/** Variegated Cells: upload the facePatternLookup region of varAux. Values
 *  are i32, stored as u32 via bitcast (WGSL reads with bitcast<i32>). Builds
 *  the buffer on the JS side and `writeBuffer`s in one shot. */
export function uploadFacePatternLookup(rt: WebGPURuntime, src: ArrayLike<number>): void {
  if (!rt.varAuxBuf || !rt.layout.variegatedEnabled || rt.layout.facePatternLookupCount === 0) return;
  const count = Math.min(src.length, rt.layout.facePatternLookupCount);
  const packed = new Int32Array(count);
  for (let i = 0; i < count; i++) packed[i] = (src[i] ?? 0) | 0;
  const byteOffset = rt.layout.facePatternLookupWordOffset * 4;
  rt.device.queue.writeBuffer(rt.varAuxBuf, byteOffset, packed);
}

/** Variegated Cells: upload a single interaction table's region of varAux.
 *  Values are f32 stored bit-wise in u32 words (WGSL reads with
 *  `bitcast<f32>(varAux[..])`). Called on init/recompile AND on every live
 *  updateLookupTable so the GPU stays in sync. Decoupled from variegation —
 *  tag×tag tables have no faces but still live in varAux. */
export function uploadInteractionTable(rt: WebGPURuntime, tableId: string, src: ArrayLike<number>): void {
  if (!rt.varAuxBuf) return;
  const slot = rt.layout.interactionTableOffsets[tableId];
  if (!slot) return;
  const count = Math.min(src.length, slot.count);
  const packed = new Float32Array(count);
  for (let i = 0; i < count; i++) packed[i] = src[i] ?? 0;
  const byteOffset = slot.wordOffset * 4;
  rt.device.queue.writeBuffer(rt.varAuxBuf, byteOffset, packed);
}

/** Lazily create the output mapping pipeline for `mappingId` if it isn't
 *  already cached. Uses the synchronous createComputePipeline so callers can
 *  stay sync — the trade-off is a one-time hitch on first dispatch of each
 *  viewer (typically a few ms; documented in the O4 plan note). Returns the
 *  pipeline, or null if the model has no entry point for this mappingId. */
function ensureOutputPipeline(rt: WebGPURuntime, mappingId: string): GPUComputePipeline | null {
  const cached = rt.outputPipelines.get(mappingId);
  if (cached) return cached;
  if (!rt.pipelineLayout) return null;
  const om = rt.entryPoints.outputMappings.find(o => o.mappingId === mappingId);
  if (!om) return null;
  const pipe = rt.device.createComputePipeline({
    label: `genesisca-${om.entry}`, layout: rt.pipelineLayout,
    compute: { module: rt.shaderModule, entryPoint: om.entry },
  });
  rt.outputPipelines.set(mappingId, pipe);
  return pipe;
}

/** Dispatch one output mapping pipeline (writes to colors buffer). The
 *  pipeline is built on demand the first time a viewer is requested. */
export function dispatchOutputMapping(rt: WebGPURuntime, mappingId: string): boolean {
  if (!rt.stepReady || !rt.bindGroup) return false;
  const pipe = ensureOutputPipeline(rt, mappingId);
  if (!pipe) return false;
  const enc = rt.device.createCommandEncoder({ label: 'om-enc' });
  const pass = enc.beginComputePass({ label: 'om-pass' });
  pass.setPipeline(pipe);
  pass.setBindGroup(0, rt.bindGroup);
  dispatchCells(pass, rt.layout.total, WORKGROUP_SIZE);
  pass.end();
  rt.device.queue.submit([enc.finish()]);
  return true;
}

/** P6 — combined color-pass + canvas present in ONE encoder + ONE submit.
 *  Saves one driver round-trip per frame compared to dispatching them
 *  separately. Returns true iff the output mapping pipeline ran (caller
 *  uses this to decide whether to fall back to a step shader for models
 *  with SetColorViewer-in-step viewers like MNCA). */
export function dispatchColorPassAndPresent(rt: WebGPURuntime, mappingId: string): boolean {
  if (!rt.stepReady || !rt.bindGroup) return false;
  const pipe = ensureOutputPipeline(rt, mappingId);
  const wantPresent = !!(
    rt.directRender && rt.canvasContext && rt.presentPipeline
    && rt.colorsBuf && rt.presentBindGroupLayout
  );
  if (!pipe && !wantPresent) return false;
  const enc = rt.device.createCommandEncoder({ label: 'om+present-enc' });
  if (pipe) {
    const omPass = enc.beginComputePass({ label: 'om-pass' });
    omPass.setPipeline(pipe);
    omPass.setBindGroup(0, rt.bindGroup);
    dispatchCells(omPass, rt.layout.total, WORKGROUP_SIZE);
    omPass.end();
  }
  if (wantPresent) {
    // The canvas texture handle changes every frame, so the bind group must
    // be rebuilt; this is intrinsic to the canvas-context API.
    const tex = rt.canvasContext!.getCurrentTexture();
    const view = tex.createView();
    const bg = rt.device.createBindGroup({
      label: 'present-bg',
      layout: rt.presentBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: rt.colorsBuf! } },
        { binding: 1, resource: view },
      ],
    });
    const presentPass = enc.beginComputePass({ label: 'present-pass' });
    presentPass.setPipeline(rt.presentPipeline!);
    presentPass.setBindGroup(0, bg);
    presentPass.dispatchWorkgroups(Math.ceil(tex.width / PRESENT_WG), Math.ceil(tex.height / PRESENT_WG));
    presentPass.end();
  }
  rt.device.queue.submit([enc.finish()]);
  return !!pipe;
}

// ---------------------------------------------------------------------------
// Readback — async copy GPU → CPU staging buffer → caller's typed arrays.
// ---------------------------------------------------------------------------

/** A region to copy out of a GPU buffer in a batched readback. */
export interface ReadbackRegion {
  /** Source buffer (must allow COPY_SRC). */
  src: GPUBuffer;
  /** Byte offset within the source buffer. */
  srcOffset: number;
  /** Number of bytes to copy. Must be a multiple of 4. */
  size: number;
}

/** Batched readback: pack N regions into ONE staging buffer with sub-offsets,
 *  copy each via copyBufferToBuffer, then issue a SINGLE mapAsync. Returns a
 *  Uint8Array per region (already sliced to detach from the staging buffer
 *  before unmap). Callers decode each region's bytes per their own format.
 *
 *  Replaces the previous per-readback pattern (one staging buffer + one
 *  mapAsync per source) — saves N-1 GPU→CPU round trips on the per-step path
 *  where indicators + stopFlag (+ optionally colors / attrs) are all needed
 *  together. */
export async function readbackBatched(
  rt: WebGPURuntime,
  regions: ReadbackRegion[],
): Promise<Uint8Array[]> {
  if (regions.length === 0) return [];
  // Each sub-region is naturally 4-byte-aligned (all our buffers are u32-typed),
  // so a simple running offset works without alignment padding.
  const offsets: number[] = [];
  let total = 0;
  for (const r of regions) {
    offsets.push(total);
    total += r.size;
  }
  const pooled = acquireStagingBuffer(rt, Math.max(total, 16));
  const stagingBuf = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'readback-batched-enc' });
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!;
    enc.copyBufferToBuffer(r.src, r.srcOffset, stagingBuf, offsets[i]!, r.size);
  }
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ, 0, total);
  const mapped = new Uint8Array(stagingBuf.getMappedRange(0, total));
  const out: Uint8Array[] = [];
  for (let i = 0; i < regions.length; i++) {
    const off = offsets[i]!;
    out.push(mapped.slice(off, off + regions[i]!.size));
  }
  stagingBuf.unmap();
  releaseStagingBuffer(pooled);
  return out;
}

export async function readbackAttrs(rt: WebGPURuntime, dstAttrs: WorkerAttrArrays): Promise<void> {
  if (!rt.attrsReadBuf) return;
  const size = rt.layout.attrsBytes;
  const pooled = acquireStagingBuffer(rt, size);
  const stagingBuf = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'readback-enc' });
  enc.copyBufferToBuffer(rt.attrsReadBuf, 0, stagingBuf, 0, size);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ, 0, size);
  const mapped = new Uint8Array(stagingBuf.getMappedRange(0, size)).slice();
  stagingBuf.unmap();
  releaseStagingBuffer(pooled);
  unpackAttrsFromReadback(rt.layout, mapped, dstAttrs);
}

export async function readbackColors(rt: WebGPURuntime, dst: Uint8ClampedArray): Promise<void> {
  if (!rt.colorsBuf) return;
  const size = rt.layout.colorsBytes;
  const pooled = acquireStagingBuffer(rt, size);
  const stagingBuf = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'readback-colors-enc' });
  enc.copyBufferToBuffer(rt.colorsBuf, 0, stagingBuf, 0, size);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ, 0, size);
  const mapped = new Uint8Array(stagingBuf.getMappedRange(0, size));
  const limit = Math.min(dst.length, mapped.length);
  for (let i = 0; i < limit; i++) dst[i] = mapped[i]!;
  stagingBuf.unmap();
  releaseStagingBuffer(pooled);
}

/** Zero the GPU-side glyph buffers. Called at the top of every colour pass
 *  when `layout.hasGlyphs` is true so per-cell writes from setCellGlyph can
 *  treat "codepoint 0" as "no glyph here". Cheap — driver-level memset. */
export function clearGlyphBuffersWebGPU(rt: WebGPURuntime): void {
  if (!rt.layout.hasGlyphs || !rt.glyphCodesBuf || !rt.glyphColorsBuf) return;
  const enc = rt.device.createCommandEncoder({ label: 'clear-glyphs-enc' });
  enc.clearBuffer(rt.glyphCodesBuf, 0, rt.layout.glyphCodesBytes);
  enc.clearBuffer(rt.glyphColorsBuf, 0, rt.layout.glyphColorsBytes);
  rt.device.queue.submit([enc.finish()]);
}

export async function readbackGlyphs(
  rt: WebGPURuntime,
  dstCodes: Uint32Array,
  dstColors: Uint32Array,
): Promise<void> {
  if (!rt.layout.hasGlyphs || !rt.glyphCodesBuf || !rt.glyphColorsBuf) return;
  const codesSize = rt.layout.glyphCodesBytes;
  const colorsSize = rt.layout.glyphColorsBytes;
  // One staging buffer holds both regions back-to-back (codesSize aligned to 4
  // is fine; both regions are u32-aligned already).
  const totalSize = codesSize + colorsSize;
  const pooled = acquireStagingBuffer(rt, totalSize);
  const stagingBuf = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'readback-glyphs-enc' });
  enc.copyBufferToBuffer(rt.glyphCodesBuf, 0, stagingBuf, 0, codesSize);
  enc.copyBufferToBuffer(rt.glyphColorsBuf, 0, stagingBuf, codesSize, colorsSize);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ, 0, totalSize);
  const mapped = new Uint8Array(stagingBuf.getMappedRange(0, totalSize));
  const codesView = new Uint32Array(mapped.buffer, mapped.byteOffset, codesSize / 4);
  const colorsView = new Uint32Array(mapped.buffer, mapped.byteOffset + codesSize, colorsSize / 4);
  const lim1 = Math.min(dstCodes.length, codesView.length);
  for (let i = 0; i < lim1; i++) dstCodes[i] = codesView[i]!;
  const lim2 = Math.min(dstColors.length, colorsView.length);
  for (let i = 0; i < lim2; i++) dstColors[i] = colorsView[i]!;
  stagingBuf.unmap();
  releaseStagingBuffer(pooled);
}

export async function readbackIndicators(rt: WebGPURuntime, decode: (id: string, raw: number) => number): Promise<Record<string, number>> {
  if (!rt.indicatorsBuf || rt.layout.indicatorIds.length === 0) return {};
  const size = rt.layout.indicatorsBytes;
  const pooled = acquireStagingBuffer(rt, size);
  const stagingBuf = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'readback-ind-enc' });
  enc.copyBufferToBuffer(rt.indicatorsBuf, 0, stagingBuf, 0, size);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ, 0, size);
  const mapped = new Uint8Array(stagingBuf.getMappedRange(0, size)).slice();
  stagingBuf.unmap();
  releaseStagingBuffer(pooled);
  const view = new DataView(mapped.buffer);
  const out: Record<string, number> = {};
  for (let i = 0; i < rt.layout.indicatorIds.length; i++) {
    const id = rt.layout.indicatorIds[i]!;
    // Caller decides the encoding (f32 vs i32 bits) per-id.
    const raw = view.getUint32(i * 4, true);
    out[id] = decode(id, raw);
  }
  return out;
}

/** Read the stop flag value (0 = no stop, otherwise 1-based stop event index). */
export async function readbackStopFlag(rt: WebGPURuntime): Promise<number> {
  if (!rt.controlBuf) return 0;
  const size = 16;
  const pooled = acquireStagingBuffer(rt, size);
  const stagingBuf = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'readback-control-enc' });
  enc.copyBufferToBuffer(rt.controlBuf, 0, stagingBuf, 0, size);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ, 0, size);
  const mapped = new Uint32Array(stagingBuf.getMappedRange(0, size)).slice();
  stagingBuf.unmap();
  releaseStagingBuffer(pooled);
  // controlBuf layout: [activeViewer (i32), stopFlag (atomic u32), pad, pad]
  return mapped[1] ?? 0;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function destroyWebGPURuntime(rt: WebGPURuntime | null): void {
  if (!rt) return;
  try {
    destroyStagingPool(rt);
    // P7 — release the canvas context's device binding before destroying the
    // device so the OffscreenCanvas can be re-acquired by a future runtime
    // (e.g. after recompile-with-shader-rebuild).
    if (rt.canvasContext) {
      try { rt.canvasContext.unconfigure(); } catch { /* ok */ }
    }
    // L1 — release the voxel render's buffers + depth texture + canvas binding.
    destroyVoxelRender(rt);
    // attrsReadBuf / attrsWriteBuf are aliases of attrsBufA / attrsBufB —
    // destroy via the underlying refs to avoid double-destroy.
    for (const buf of [
      rt.attrsBufA, rt.attrsBufB, rt.colorsBuf, rt.nbrOffsetsBuf,
      rt.modelAttrsBuf, rt.indicatorsBuf, rt.rngStateBuf, rt.controlBuf,
      rt.reductionsBuf, rt.varAuxBuf, rt.glyphCodesBuf, rt.glyphColorsBuf,
    ]) {
      if (buf) buf.destroy();
    }
    // E1: release the shared-device reference (destroys the device only when the
    // LAST runtime — grid + all agent runtimes — has released it), instead of
    // destroying the device outright (which would kill a still-live agent runtime).
    releaseSharedGpuDevice(rt.device);
  } catch { /* non-fatal */ }
}
