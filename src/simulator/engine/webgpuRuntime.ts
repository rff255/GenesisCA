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
  nbrIndicesBuf: GPUBuffer | null;
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
  const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter request returned null');
  // Request the adapter's max storage/buffer limits at device creation. Default
  // device limits cap storage buffers at 128 MB, which kills large grids that
  // use multi-neighbourhood patterns (e.g. MNCA's 692-cell-per-cell neighbour
  // index table at 500x500 is 660 MB). Devices that don't support the higher
  // tier still get whatever they support — requestDevice returns OK as long as
  // the requested limits are <= adapter limits.
  const required: Record<string, number> = {};
  const limitKeys = [
    'maxStorageBufferBindingSize', 'maxBufferSize', 'maxUniformBufferBindingSize',
    'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ',
    'maxComputeWorkgroupsPerDimension',
  ] as const;
  const limits = adapter.limits as unknown as Record<string, number>;
  for (const k of limitKeys) {
    const v = limits[k];
    if (typeof v === 'number') required[k] = v;
  }
  // Some adapters report supported limits the device can't actually back; the
  // first requestDevice call then fails with an opaque error. Retry once with
  // default limits so we degrade gracefully — models that fit within the
  // default 128 MB storage-buffer cap still work, larger grids will surface
  // the more specific "buffer size exceeds device limit" error in
  // setupBuffersAndPipelines.
  let device: GPUDevice | null = null;
  try {
    device = await adapter.requestDevice({ requiredLimits: required });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[webgpu] requestDevice with adapter max limits failed, retrying with defaults:', err);
    device = await adapter.requestDevice();
  }
  if (!device) throw new Error('WebGPU device request returned null');

  device.addEventListener('uncapturederror', (ev: Event) => {
    const err = (ev as GPUUncapturedErrorEvent).error;
    // eslint-disable-next-line no-console
    console.error('[webgpu] uncaptured device error:', err.message);
  });

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
    nbrIndicesBuf: null, modelAttrsBuf: null, indicatorsBuf: null,
    rngStateBuf: null, controlBuf: null,
    bindGroupLayout: null,
    pipelineLayout: null,
    bindGroupAB: null, bindGroupBA: null, bindGroup: null,
    stepPipeline: null,
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
    reductionsBuf: null,
    reductionShaderModule: null,
    reductionBindGroupLayout: null,
    reductionBindGroupAB: null,
    reductionBindGroupBA: null,
    reductionPipelines: new Map(),
    reductionPlan: null,
  };
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
  if (layout.nbrBytes > limit) offenders.push({ name: 'nbrIndices', bytes: layout.nbrBytes });
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
  rt.nbrIndicesBuf = device.createBuffer({
    label: 'nbrIndices', size: layout.nbrBytes,
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
    ],
  });

  // Two bind group orientations for ping-pong. AB reads A and writes B; BA
  // reads B and writes A. After each step we flip rt.bindGroup so the just-
  // written buffer becomes the next step's "read" — no per-step copy needed.
  const otherEntries = [
    { binding: 2, resource: { buffer: rt.colorsBuf } },
    { binding: 3, resource: { buffer: rt.nbrIndicesBuf } },
    { binding: 4, resource: { buffer: rt.modelAttrsBuf } },
    { binding: 5, resource: { buffer: rt.indicatorsBuf } },
    { binding: 6, resource: { buffer: rt.rngStateBuf } },
    { binding: 7, resource: { buffer: rt.controlBuf } },
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
  textureStore(canvasOut, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(r, g, b, a));
}
`;
}

function setupDirectRender(rt: WebGPURuntime): void {
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
    alphaMode: 'opaque',
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
  const groups = Math.ceil(rt.layout.total / REDUCE_WG);
  for (const e of rt.reductionPlan.entries) {
    const pipe = rt.reductionPipelines.get(e.entry);
    if (!pipe) continue;
    pass.setPipeline(pipe);
    pass.dispatchWorkgroups(Math.max(1, groups));
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

export function uploadNeighborIndices(rt: WebGPURuntime, indices: Record<string, Int32Array>): void {
  if (!rt.nbrIndicesBuf) return;
  const buf = new Uint8Array(rt.layout.nbrBytes);
  const view = new DataView(buf.buffer);
  for (const n of rt.layout.nbrs) {
    const src = indices[n.id];
    if (!src) continue;
    const lim = Math.min(n.count, src.length);
    for (let i = 0; i < lim; i++) view.setInt32(n.byteOffset + i * 4, src[i] ?? 0, true);
  }
  rt.device.queue.writeBuffer(rt.nbrIndicesBuf, 0, buf);
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
  const groups = Math.ceil(rt.layout.total / WORKGROUP_SIZE);
  pass.dispatchWorkgroups(Math.max(1, groups));
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
  const groups = Math.ceil(rt.layout.total / WORKGROUP_SIZE);
  pass.dispatchWorkgroups(Math.max(1, groups));
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
    const groups = Math.ceil(rt.layout.total / WORKGROUP_SIZE);
    omPass.dispatchWorkgroups(Math.max(1, groups));
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
    // attrsReadBuf / attrsWriteBuf are aliases of attrsBufA / attrsBufB —
    // destroy via the underlying refs to avoid double-destroy.
    for (const buf of [
      rt.attrsBufA, rt.attrsBufB, rt.colorsBuf, rt.nbrIndicesBuf,
      rt.modelAttrsBuf, rt.indicatorsBuf, rt.rngStateBuf, rt.controlBuf,
      rt.reductionsBuf,
    ]) {
      if (buf) buf.destroy();
    }
    const dev = rt.device as GPUDevice & { destroy?: () => void };
    if (typeof dev.destroy === 'function') dev.destroy();
  } catch { /* non-fatal */ }
}
