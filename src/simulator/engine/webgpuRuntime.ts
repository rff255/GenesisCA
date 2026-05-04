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

export interface WebGPURuntimeInit {
  shaderCode: string;
  entryPoints: WebGPUEntryPoints;
  layout: WebGPULayout;
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
  /** Two bind group orientations; the active one flips after each step. */
  bindGroupAB: GPUBindGroup | null;
  bindGroupBA: GPUBindGroup | null;
  bindGroup: GPUBindGroup | null;
  stepPipeline: GPUComputePipeline | null;
  /** One pipeline per outputMapping_<id>. Keyed by mappingId. */
  outputPipelines: Map<string, GPUComputePipeline>;
  /** SHA-ish hash of the WGSL source the current pipelines were built from.
   *  When a recompile lands with the same hash, we skip the (expensive) async
   *  pipeline rebuilds and reuse what's already on the device. */
  shaderHash: string;
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
  const device = await adapter.requestDevice({ requiredLimits: required });
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
    bindGroupAB: null, bindGroupBA: null, bindGroup: null,
    stepPipeline: null,
    outputPipelines: new Map(),
    shaderHash: shaderHashOf(init.shaderCode),
  };
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

  const pipelineLayout = device.createPipelineLayout({
    label: 'genesisca-pl', bindGroupLayouts: [rt.bindGroupLayout],
  });
  rt.stepPipeline = await device.createComputePipelineAsync({
    label: 'genesisca-step', layout: pipelineLayout,
    compute: { module: rt.shaderModule, entryPoint: rt.entryPoints.step },
  });
  rt.outputPipelines.clear();
  for (const om of rt.entryPoints.outputMappings) {
    const pipe = await device.createComputePipelineAsync({
      label: `genesisca-${om.entry}`, layout: pipelineLayout,
      compute: { module: rt.shaderModule, entryPoint: om.entry },
    });
    rt.outputPipelines.set(om.mappingId, pipe);
  }

  rt.stepReady = true;
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

/** Dispatch one output mapping pipeline (writes to colors buffer). */
export function dispatchOutputMapping(rt: WebGPURuntime, mappingId: string): boolean {
  if (!rt.stepReady || !rt.bindGroup) return false;
  const pipe = rt.outputPipelines.get(mappingId);
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
  const stagingBuf = rt.device.createBuffer({
    size: Math.max(total, 16),
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const enc = rt.device.createCommandEncoder({ label: 'readback-batched-enc' });
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!;
    enc.copyBufferToBuffer(r.src, r.srcOffset, stagingBuf, offsets[i]!, r.size);
  }
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(stagingBuf.getMappedRange());
  const out: Uint8Array[] = [];
  for (let i = 0; i < regions.length; i++) {
    const off = offsets[i]!;
    out.push(mapped.slice(off, off + regions[i]!.size));
  }
  stagingBuf.unmap();
  stagingBuf.destroy();
  return out;
}

export async function readbackAttrs(rt: WebGPURuntime, dstAttrs: WorkerAttrArrays): Promise<void> {
  if (!rt.attrsReadBuf) return;
  const stagingBuf = rt.device.createBuffer({
    size: rt.layout.attrsBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const enc = rt.device.createCommandEncoder({ label: 'readback-enc' });
  enc.copyBufferToBuffer(rt.attrsReadBuf, 0, stagingBuf, 0, rt.layout.attrsBytes);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(stagingBuf.getMappedRange()).slice();
  stagingBuf.unmap();
  stagingBuf.destroy();
  unpackAttrsFromReadback(rt.layout, mapped, dstAttrs);
}

export async function readbackColors(rt: WebGPURuntime, dst: Uint8ClampedArray): Promise<void> {
  if (!rt.colorsBuf) return;
  const stagingBuf = rt.device.createBuffer({
    size: rt.layout.colorsBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const enc = rt.device.createCommandEncoder({ label: 'readback-colors-enc' });
  enc.copyBufferToBuffer(rt.colorsBuf, 0, stagingBuf, 0, rt.layout.colorsBytes);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(stagingBuf.getMappedRange());
  const limit = Math.min(dst.length, mapped.length);
  for (let i = 0; i < limit; i++) dst[i] = mapped[i]!;
  stagingBuf.unmap();
  stagingBuf.destroy();
}

export async function readbackIndicators(rt: WebGPURuntime, decode: (id: string, raw: number) => number): Promise<Record<string, number>> {
  if (!rt.indicatorsBuf || rt.layout.indicatorIds.length === 0) return {};
  const stagingBuf = rt.device.createBuffer({
    size: rt.layout.indicatorsBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const enc = rt.device.createCommandEncoder({ label: 'readback-ind-enc' });
  enc.copyBufferToBuffer(rt.indicatorsBuf, 0, stagingBuf, 0, rt.layout.indicatorsBytes);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(stagingBuf.getMappedRange()).slice();
  stagingBuf.unmap();
  stagingBuf.destroy();
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
  const stagingBuf = rt.device.createBuffer({
    size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const enc = rt.device.createCommandEncoder({ label: 'readback-control-enc' });
  enc.copyBufferToBuffer(rt.controlBuf, 0, stagingBuf, 0, 16);
  rt.device.queue.submit([enc.finish()]);
  await stagingBuf.mapAsync(GPUMapMode.READ);
  const mapped = new Uint32Array(stagingBuf.getMappedRange()).slice();
  stagingBuf.unmap();
  stagingBuf.destroy();
  // controlBuf layout: [activeViewer (i32), stopFlag (atomic u32), pad, pad]
  return mapped[1] ?? 0;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function destroyWebGPURuntime(rt: WebGPURuntime | null): void {
  if (!rt) return;
  try {
    // attrsReadBuf / attrsWriteBuf are aliases of attrsBufA / attrsBufB —
    // destroy via the underlying refs to avoid double-destroy.
    for (const buf of [
      rt.attrsBufA, rt.attrsBufB, rt.colorsBuf, rt.nbrIndicesBuf,
      rt.modelAttrsBuf, rt.indicatorsBuf, rt.rngStateBuf, rt.controlBuf,
    ]) {
      if (buf) buf.destroy();
    }
    const dev = rt.device as GPUDevice & { destroy?: () => void };
    if (typeof dev.destroy === 'function') dev.destroy();
  } catch { /* non-fatal */ }
}
