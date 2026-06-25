/// <reference types="@webgpu/types" />
// ===========================================================================
// PR7 / G3-runtime — the WebGPU AGENT runtime (the GPU sibling of the WASM
// agent dispatch in `runAgentStep`).
//
// A SELF-CONTAINED runtime that owns its own GPU device + buffers + the two
// agent compute pipelines (behaviour + force pass) emitted by
// `agentWebgpu/compile.ts` + `agentWebgpu/forcePass.ts`. It is the GPU analogue
// of `instantiateAgentWasm` + the WASM `behaviour`/`forcePass` calls — the worker
// uploads the CPU AgentStore SoA, dispatches the behaviour then the force shader,
// and reads `x/y/vx/vy/radius/density/age` back into the store so the structural
// phase + the render snapshot + the next step read the GPU-evolved state.
//
// SCOPE (the Boids headline): force-driven agents only. The GPU agent SoA carries
// NO bond store, so the bond springs + division + the spatial-hash BUILD stay on
// the CPU/JS side (the gate `isAgentGraphWebGPUSupported` excludes bond/division/
// field models). For Boids (no bonds, no division, no growth) the two GPU passes
// are exact (modulo f32-vs-f64 + per-cell PCG — the documented WebGPU constraints).
//
// HARD CONSTRAINT: this file is wholly ADDITIVE — it touches NO lattice/grid
// WebGPU runtime + NO existing agent JS/WASM path, so byte-identity for every
// non-WebGPU-agent model holds by construction. A SEPARATE device from the grid's
// `webgpuRuntime.ts` keeps the two simulators decoupled (a model can run a WASM
// grid + WebGPU agents, or vice versa).
//
// 2D-ONLY (mirrors the behaviour shader's 2D Boids scope). The agent SoA is
// uploaded/read-back as Float32 (the GPU has no f64), so this is statistical
// parity vs the JS/WASM f64 path, NOT bit-exact — the same target trade-off as
// the lattice WebGPU grid.
// ===========================================================================

import type { AgentStore } from './agentEngine';
import type { AgentWebGPULayout } from '../../modeler/vpl/compiler/agentWebgpu/layout';
import { AGENT_GPU_F32_FIELDS, AGENT_GPU_I32_FIELDS } from '../../modeler/vpl/compiler/agentWebgpu/layout';

// Workgroup size — MUST match the `@workgroup_size(64)` in both agent shaders.
const AGENT_WG = 64;
const MAX_WG_PER_DIM = 65535;

/** The mutable per-step force-pass dims the worker stashes after building the
 *  spatial hash (mirrors the WASM force-pass ABI fields). */
export interface AgentForceDispatchParams {
  hashValid: number;
  nBinsX: number;
  nBinsY: number;
  binSizeX: number;
  binSizeY: number;
  dtOverEta: number;
  muR: number;
  muA: number;
  range: number;
  momentum: number;
  maxSpeed: number;
  growthRate: number;
  fieldW: number;
  fieldH: number;
  bonding: number;
  torus: number;
}

interface PooledBuffer { buffer: GPUBuffer; size: number; inUse: boolean }

export interface AgentWebGPURuntime {
  device: GPUDevice;
  adapter: GPUAdapter;
  layout: AgentWebGPULayout;
  /** True once buffers + pipelines are live and a step can dispatch. */
  ready: boolean;

  // --- storage / uniform buffers (shared by the two pipelines) ---
  agentF32Buf: GPUBuffer;     // f32 SoA (read_write)
  agentI32Buf: GPUBuffer;     // i32 SoA (read)
  agentAliveBuf: GPUBuffer;   // u32/agent (read)
  hashBinsBuf: GPUBuffer;     // i32 binStart + binAgents (read)
  controlBuf: GPUBuffer;      // behaviour Control (uniform)
  rngStateBuf: GPUBuffer;     // u32/agent (read_write)
  agentColorsBuf: GPUBuffer;  // u32/agent (read_write)
  forceControlBuf: GPUBuffer; // force ForceControl (uniform)
  /** G5 field bridge — the read-only field snapshot (binding 7) + the atomic
   *  deposit accumulator (binding 8). null when the model has no agent-accessible
   *  cell attrs (the no-field Boids case). */
  fieldReadBuf: GPUBuffer | null;
  fieldDepositBuf: GPUBuffer | null;

  // --- pipelines ---
  behaviourPipeline: GPUComputePipeline;
  forcePipeline: GPUComputePipeline;
  behaviourBindGroup: GPUBindGroup;
  forceBindGroup: GPUBindGroup;

  /** Reusable MAP_READ staging buffers, keyed by power-of-two byte size. */
  stagingPool: Map<number, PooledBuffer[]>;
  /** Scratch CPU upload buffers (one allocation per backing). */
  f32Upload: Float32Array;
  i32Upload: Int32Array;
  aliveUpload: Uint32Array;
  /** maxHashBins + 1 + maxAgents i32 scratch for the hash upload. */
  hashUpload: Int32Array;
  /** G5 — scratch CPU buffers for the field read snapshot + the deposit init/readback. */
  fieldReadUpload: Float32Array;
  fieldDepositUpload: Float32Array;
}

function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}

// ---------------------------------------------------------------------------
// Buffer sizes (4-byte clamped — storage buffers must be ≥4 bytes).
// ---------------------------------------------------------------------------

function f32Bytes(layout: AgentWebGPULayout): number { return Math.max(4, layout.f32Len * 4); }
function i32Bytes(layout: AgentWebGPULayout): number { return Math.max(4, layout.i32Len * 4); }
function aliveBytes(layout: AgentWebGPULayout): number { return Math.max(4, layout.maxAgents * 4); }
function hashBytes(layout: AgentWebGPULayout): number { return Math.max(4, Math.max(1, layout.hashLen) * 4); }
function rngBytes(layout: AgentWebGPULayout): number { return Math.max(4, layout.maxAgents * 4); }
function colorsBytes(layout: AgentWebGPULayout): number { return Math.max(4, layout.maxAgents * 4); }
// Control: 6×u32 + 4×f32 = 40 → round to 16-byte alignment (48). ForceControl:
// 6×u32 + 11×f32 = 68 → round to 80. WebGPU requires uniform-struct size be a
// multiple of 16; over-allocating to the next 16 is safe.
const CONTROL_BYTES = 48;
const FORCE_CONTROL_BYTES = 80;

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

/** Create the agent WebGPU runtime: acquire a device, compile the behaviour +
 *  force shaders, allocate the buffers, build the two bind groups + pipelines.
 *  Throws on any WGSL compile error / device failure (the worker catches +
 *  falls back to JS). */
export async function createAgentWebGPURuntime(
  behaviourShader: string,
  forceShader: string,
  layout: AgentWebGPULayout,
): Promise<AgentWebGPURuntime> {
  if (!isWebGPUAvailable()) throw new Error('navigator.gpu is unavailable in this context');
  const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter request returned null (agents)');

  // Request the adapter's max storage limits (large agent counts can exceed the
  // default 128 MB cap on the f32 SoA, though the Boids subset is small).
  const required: Record<string, number> = {};
  const limits = adapter.limits as unknown as Record<string, number>;
  for (const k of [
    'maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupsPerDimension',
    'maxStorageBuffersPerShaderStage',
  ]) { const v = limits[k]; if (typeof v === 'number') required[k] = v; }
  let device: GPUDevice;
  try { device = await adapter.requestDevice({ requiredLimits: required }); }
  catch { device = await adapter.requestDevice(); }
  if (!device) throw new Error('WebGPU device request returned null (agents)');

  device.addEventListener('uncapturederror', (ev: Event) => {
    // eslint-disable-next-line no-console
    console.error('[agents/webgpu] uncaptured device error:', (ev as GPUUncapturedErrorEvent).error.message);
  });

  // Compile + validate both modules up front (clear errors before any dispatch).
  const behaviourModule = device.createShaderModule({ code: behaviourShader });
  const forceModule = device.createShaderModule({ code: forceShader });
  for (const [name, mod] of [['behaviour', behaviourModule], ['force', forceModule]] as const) {
    const info = await mod.getCompilationInfo();
    const errs = info.messages.filter(m => m.type === 'error');
    if (errs.length > 0) {
      throw new Error(`[agents/webgpu] ${name} WGSL compile errors:\n` +
        errs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
    }
  }

  const mk = (label: string, size: number, usage: number): GPUBuffer =>
    device.createBuffer({ label, size, usage });
  const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const STORAGE_RO = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;

  const agentF32Buf = mk('agentF32', f32Bytes(layout), STORAGE);
  const agentI32Buf = mk('agentI32', i32Bytes(layout), STORAGE_RO);
  const agentAliveBuf = mk('agentAlive', aliveBytes(layout), STORAGE_RO);
  const hashBinsBuf = mk('agentHashBins', hashBytes(layout), STORAGE_RO);
  const controlBuf = mk('agentControl', CONTROL_BYTES, UNIFORM);
  const rngStateBuf = mk('agentRngState', rngBytes(layout), STORAGE);
  const agentColorsBuf = mk('agentColors', colorsBytes(layout), STORAGE);
  const forceControlBuf = mk('agentForceControl', FORCE_CONTROL_BYTES, UNIFORM);
  // G5 field bridge — created only when the model has agent-accessible cell attrs.
  const hasFieldRead = layout.fieldReadLen > 0;
  const hasFieldWrite = layout.fieldWriteLen > 0;
  const fieldReadBuf = hasFieldRead ? mk('agentFieldRead', Math.max(4, layout.fieldReadLen * 4), STORAGE_RO) : null;
  const fieldDepositBuf = hasFieldWrite ? mk('agentFieldDeposit', Math.max(4, layout.fieldWriteLen * 4), STORAGE) : null;

  // --- behaviour pipeline (7 base bindings + the conditional field bridge
  //     bindings 7 (fieldRead) / 8 (fieldDeposit, atomic)) ---
  const behaviourEntries: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ];
  if (fieldReadBuf) behaviourEntries.push({ binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
  if (fieldDepositBuf) behaviourEntries.push({ binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
  const behaviourBGL = device.createBindGroupLayout({ label: 'agent-behaviour-bgl', entries: behaviourEntries });
  const behaviourPL = device.createPipelineLayout({ label: 'agent-behaviour-pl', bindGroupLayouts: [behaviourBGL] });
  const behaviourPipeline = await device.createComputePipelineAsync({
    label: 'agent-behaviour', layout: behaviourPL,
    compute: { module: behaviourModule, entryPoint: 'behaviour' },
  });
  const behaviourBgEntries: GPUBindGroupEntry[] = [
    { binding: 0, resource: { buffer: agentF32Buf } },
    { binding: 1, resource: { buffer: agentI32Buf } },
    { binding: 2, resource: { buffer: agentAliveBuf } },
    { binding: 3, resource: { buffer: hashBinsBuf } },
    { binding: 4, resource: { buffer: controlBuf } },
    { binding: 5, resource: { buffer: rngStateBuf } },
    { binding: 6, resource: { buffer: agentColorsBuf } },
  ];
  if (fieldReadBuf) behaviourBgEntries.push({ binding: 7, resource: { buffer: fieldReadBuf } });
  if (fieldDepositBuf) behaviourBgEntries.push({ binding: 8, resource: { buffer: fieldDepositBuf } });
  const behaviourBindGroup = device.createBindGroup({
    label: 'agent-behaviour-bg', layout: behaviourBGL, entries: behaviourBgEntries,
  });

  // --- force pipeline (4 bindings: agentF32 rw, agentAlive r, hashBins r, fc uniform) ---
  const forceBGL = device.createBindGroupLayout({
    label: 'agent-force-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const forcePL = device.createPipelineLayout({ label: 'agent-force-pl', bindGroupLayouts: [forceBGL] });
  const forcePipeline = await device.createComputePipelineAsync({
    label: 'agent-force', layout: forcePL,
    compute: { module: forceModule, entryPoint: 'forcePass' },
  });
  const forceBindGroup = device.createBindGroup({
    label: 'agent-force-bg', layout: forceBGL,
    entries: [
      { binding: 0, resource: { buffer: agentF32Buf } },
      { binding: 1, resource: { buffer: agentAliveBuf } },
      { binding: 2, resource: { buffer: hashBinsBuf } },
      { binding: 3, resource: { buffer: forceControlBuf } },
    ],
  });

  const rt: AgentWebGPURuntime = {
    device, adapter, layout, ready: true,
    agentF32Buf, agentI32Buf, agentAliveBuf, hashBinsBuf,
    controlBuf, rngStateBuf, agentColorsBuf, forceControlBuf,
    fieldReadBuf, fieldDepositBuf,
    behaviourPipeline, forcePipeline, behaviourBindGroup, forceBindGroup,
    stagingPool: new Map(),
    f32Upload: new Float32Array(layout.f32Len),
    i32Upload: new Int32Array(layout.i32Len),
    aliveUpload: new Uint32Array(layout.maxAgents),
    hashUpload: new Int32Array(Math.max(1, layout.hashLen)),
    fieldReadUpload: new Float32Array(Math.max(1, layout.fieldReadLen)),
    fieldDepositUpload: new Float32Array(Math.max(1, layout.fieldWriteLen)),
  };
  // Seed the per-agent RNG once (the GPU advances it in place across steps).
  seedAgentRng(rt, 0x1234abcd);
  return rt;
}

// ---------------------------------------------------------------------------
// Upload — pack the CPU AgentStore SoA into the strided GPU buffers.
// ---------------------------------------------------------------------------

/** Upload the per-agent f32 SoA (geometry + velocity + force + density), the i32
 *  SoA, and the alive mask (expanded to u32/agent). Called each step before the
 *  dispatch (positions evolve on the GPU but the structural phase / paint / seed
 *  mutate the CPU store between steps, so we re-upload). The RNG buffer is NOT
 *  touched here — it is seeded ONCE (`seedAgentRng`) and the GPU advances its own
 *  per-agent stream in place across steps (so successive steps draw fresh
 *  randomness; re-seeding every step would freeze the sequence). */
export function uploadAgentSoA(rt: AgentWebGPURuntime, s: AgentStore): void {
  const L = rt.layout, ma = L.maxAgents, hw = s.highWater;
  const f = rt.f32Upload, ix = rt.i32Upload, al = rt.aliveUpload;
  // f32 fields — map the CPU store array → the strided run at f32Base[field].
  const f32Src: Record<string, Float64Array> = {
    x: s.x, y: s.y, vx: s.vx, vy: s.vy, radius: s.radius, targetRadius: s.targetRadius,
    age: s.age, forceX: s.forceX, forceY: s.forceY, density: s.density,
    xNext: s.xNext, yNext: s.yNext,
  };
  for (const field of AGENT_GPU_F32_FIELDS) {
    const base = L.f32Base[field]!;
    const src = f32Src[field];
    if (!src) continue;
    for (let i = 0; i < hw; i++) f[base + i] = src[i]!;
    // leave [hw, ma) at 0 (dead slots never read in the shader's alive guard)
    for (let i = hw; i < ma; i++) f[base + i] = 0;
  }
  rt.device.queue.writeBuffer(rt.agentF32Buf, 0, f.buffer, f.byteOffset, f.byteLength);

  // i32 fields — type / lineage / bondCount.
  const i32Src: Record<string, Int32Array> = { type: s.type, lineage: s.lineage, bondCount: s.bondCount };
  for (const field of AGENT_GPU_I32_FIELDS) {
    const base = L.i32Base[field]!;
    const src = i32Src[field];
    if (!src) continue;
    for (let i = 0; i < hw; i++) ix[base + i] = src[i]!;
    for (let i = hw; i < ma; i++) ix[base + i] = 0;
  }
  rt.device.queue.writeBuffer(rt.agentI32Buf, 0, ix.buffer, ix.byteOffset, ix.byteLength);

  // alive mask → one u32/agent.
  for (let i = 0; i < hw; i++) al[i] = s.alive[i]!;
  for (let i = hw; i < ma; i++) al[i] = 0;
  rt.device.queue.writeBuffer(rt.agentAliveBuf, 0, al.buffer, al.byteOffset, al.byteLength);
}

/** Seed the per-agent RNG buffer ONCE from a single global seed (PCG-hashed per
 *  slot so adjacent agents don't share a stream). Called at runtime creation /
 *  on reset — NOT per step (the GPU advances the buffer in place each step). */
export function seedAgentRng(rt: AgentWebGPURuntime, seed: number): void {
  const ma = rt.layout.maxAgents;
  const buf = new Uint32Array(ma);
  for (let i = 0; i < ma; i++) {
    let st = ((seed >>> 0) + Math.imul(i, 2654435761)) >>> 0;
    st = (st ^ (st >>> 16)) >>> 0;
    st = Math.imul(st, 2246822519) >>> 0;
    st = (st ^ (st >>> 13)) >>> 0;
    buf[i] = st;
  }
  rt.device.queue.writeBuffer(rt.rngStateBuf, 0, buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Upload the CPU-built spatial hash (binStart prefix + binAgents) into the
 *  hashBins buffer at the layout's CSR offsets. Returns whether the hash fit the
 *  reserve; on overflow the caller should fall back to JS for this step. */
export function uploadAgentHash(
  rt: AgentWebGPURuntime,
  hash: { nBinsX: number; nBinsY: number; nBinsZ: number; binStart: Int32Array; binAgents: Int32Array } | null,
): boolean {
  const L = rt.layout;
  const h = rt.hashUpload;
  if (!hash) return false;
  const nBins = hash.nBinsX * hash.nBinsY * hash.nBinsZ;
  if ((nBins + 1) > (L.maxHashBins + 1)) return false; // overflow → JS fallback
  // binStart prefix (nBins+1 entries) at hashBinStartBase.
  const bsBase = L.hashBinStartBase;
  for (let i = 0; i <= nBins; i++) h[bsBase + i] = hash.binStart[i]!;
  // binAgents (used = binStart[nBins] entries) at hashBinAgentsBase.
  const baBase = L.hashBinAgentsBase;
  const used = hash.binStart[nBins]!;
  for (let i = 0; i < used; i++) h[baBase + i] = hash.binAgents[i]!;
  rt.device.queue.writeBuffer(rt.hashBinsBuf, 0, h.buffer, h.byteOffset, Math.max(4, L.hashLen * 4));
  return true;
}

/** Write the behaviour Control uniform (highWater + hash dims + world bounds). */
export function uploadAgentControl(
  rt: AgentWebGPURuntime,
  p: { highWater: number; hashValid: number; nBinsX: number; nBinsY: number;
       fieldTorus: number; binSizeX: number; binSizeY: number; fieldW: number; fieldH: number },
): void {
  // struct Control { highWater:u32, maxAgents:u32, hashValid:u32, nBinsX:u32,
  //   nBinsY:u32, fieldTorus:u32, binSizeX:f32, binSizeY:f32, fieldW:f32, fieldH:f32 }
  const ab = new ArrayBuffer(CONTROL_BYTES);
  const u = new Uint32Array(ab), fl = new Float32Array(ab);
  u[0] = p.highWater >>> 0;
  u[1] = rt.layout.maxAgents >>> 0;
  u[2] = p.hashValid >>> 0;
  u[3] = p.nBinsX >>> 0;
  u[4] = p.nBinsY >>> 0;
  u[5] = p.fieldTorus >>> 0;
  fl[6] = p.binSizeX;
  fl[7] = p.binSizeY;
  fl[8] = p.fieldW;
  fl[9] = p.fieldH;
  rt.device.queue.writeBuffer(rt.controlBuf, 0, ab);
}

/** Write the force-pass ForceControl uniform. Field order MIRRORS
 *  `emitForceControlStruct` in forcePass.ts. */
export function uploadAgentForceControl(rt: AgentWebGPURuntime, highWater: number, fp: AgentForceDispatchParams): void {
  // struct ForceControl { highWater:u32, hashValid:u32, nBinsX:u32, nBinsY:u32,
  //   bonding:u32, torus:u32, binSizeX:f32, binSizeY:f32, dtOverEta:f32, muR:f32,
  //   muA:f32, range:f32, momentum:f32, maxSpeed:f32, growthRate:f32, fieldW:f32, fieldH:f32 }
  const ab = new ArrayBuffer(FORCE_CONTROL_BYTES);
  const u = new Uint32Array(ab), fl = new Float32Array(ab);
  u[0] = highWater >>> 0;
  u[1] = fp.hashValid >>> 0;
  u[2] = fp.nBinsX >>> 0;
  u[3] = fp.nBinsY >>> 0;
  u[4] = fp.bonding >>> 0;
  u[5] = fp.torus >>> 0;
  fl[6] = fp.binSizeX;
  fl[7] = fp.binSizeY;
  fl[8] = fp.dtOverEta;
  fl[9] = fp.muR;
  fl[10] = fp.muA;
  fl[11] = fp.range;
  fl[12] = fp.momentum;
  fl[13] = fp.maxSpeed;
  fl[14] = fp.growthRate;
  fl[15] = fp.fieldW;
  fl[16] = fp.fieldH;
  rt.device.queue.writeBuffer(rt.forceControlBuf, 0, ab);
}

// ---------------------------------------------------------------------------
// Field bridge (G5) — upload the cell field snapshot + init the deposit buffer,
// then read the deposit back into the cell read buffer after the step.
// ---------------------------------------------------------------------------

/** A per-cell field array (the worker's `readAttrs[id]`, a typed array sized
 *  `fieldTotal`). The runtime reads/writes the first `fieldTotal` elements. */
export type FieldArray = ArrayLike<number> & { [i: number]: number };

/** Upload the cell field snapshot into `fieldRead` AND prime the atomic
 *  `fieldDeposit` accumulator with the SAME values (so `add` accumulates onto the
 *  current field, `set`/`max`/`min` start from it). `readArrays` are the
 *  agent-readable cell-attr arrays in `layout.fieldReadAttrs` order; `writeArrays`
 *  the writable subset in `layout.fieldWriteAttrs` order. */
export function uploadAgentField(
  rt: AgentWebGPURuntime,
  readArrays: Record<string, FieldArray>,
  writeArrays: Record<string, FieldArray>,
): void {
  const L = rt.layout, total = L.fieldTotal;
  if (rt.fieldReadBuf && L.fieldReadLen > 0) {
    const fr = rt.fieldReadUpload;
    for (const id of L.fieldReadAttrs) {
      const base = L.fieldReadBase[id]!;
      const src = readArrays[id];
      if (!src) { for (let i = 0; i < total; i++) fr[base + i] = 0; continue; }
      for (let i = 0; i < total; i++) fr[base + i] = src[i]!;
    }
    rt.device.queue.writeBuffer(rt.fieldReadBuf, 0, fr.buffer, fr.byteOffset, L.fieldReadLen * 4);
  }
  if (rt.fieldDepositBuf && L.fieldWriteLen > 0) {
    // Prime the deposit accumulator with the current field (f32 — the atomic CAS
    // reads it back as bitcast<f32>, so the byte pattern must be the f32 value).
    const fd = rt.fieldDepositUpload;
    for (const id of L.fieldWriteAttrs) {
      const base = L.fieldWriteBase[id]!;
      const src = writeArrays[id];
      if (!src) { for (let i = 0; i < total; i++) fd[base + i] = 0; continue; }
      for (let i = 0; i < total; i++) fd[base + i] = src[i]!;
    }
    rt.device.queue.writeBuffer(rt.fieldDepositBuf, 0, fd.buffer, fd.byteOffset, L.fieldWriteLen * 4);
  }
}

/** Read the deposit accumulator back and write the evolved field into the cell
 *  read buffers (BEFORE the cell CA step incorporates it). The deposit holds
 *  f32-bitcast values; we read them as Float32 and copy into the (possibly f64)
 *  cell arrays. */
export async function readbackAgentField(
  rt: AgentWebGPURuntime,
  writeArrays: Record<string, FieldArray & { [i: number]: number }>,
): Promise<void> {
  const L = rt.layout, total = L.fieldTotal;
  if (!rt.fieldDepositBuf || L.fieldWriteLen === 0) return;
  const byteLen = Math.max(4, L.fieldWriteLen * 4);
  const pooled = acquireStaging(rt, byteLen);
  const staging = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'agent-field-readback-enc' });
  enc.copyBufferToBuffer(rt.fieldDepositBuf, 0, staging, 0, byteLen);
  rt.device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ, 0, byteLen);
  const f = new Float32Array(staging.getMappedRange(0, byteLen));
  for (const id of L.fieldWriteAttrs) {
    const base = L.fieldWriteBase[id]!;
    const dst = writeArrays[id];
    if (!dst) continue;
    for (let i = 0; i < total; i++) dst[i] = f[base + i]!;
  }
  staging.unmap();
  pooled.inUse = false;
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

function dispatchAgents(pass: GPUComputePassEncoder, total: number): void {
  const groups = Math.max(1, Math.ceil(total / AGENT_WG));
  const x = Math.min(groups, MAX_WG_PER_DIM);
  const y = Math.ceil(groups / MAX_WG_PER_DIM);
  pass.dispatchWorkgroups(x, y);
}

/** Dispatch the behaviour shader then the force shader in one command buffer. */
export function dispatchAgentStep(rt: AgentWebGPURuntime, highWater: number): void {
  const enc = rt.device.createCommandEncoder({ label: 'agent-step-enc' });
  const total = Math.max(1, highWater);
  const passB = enc.beginComputePass({ label: 'agent-behaviour-pass' });
  passB.setPipeline(rt.behaviourPipeline);
  passB.setBindGroup(0, rt.behaviourBindGroup);
  dispatchAgents(passB, total);
  passB.end();
  const passF = enc.beginComputePass({ label: 'agent-force-pass' });
  passF.setPipeline(rt.forcePipeline);
  passF.setBindGroup(0, rt.forceBindGroup);
  dispatchAgents(passF, total);
  passF.end();
  rt.device.queue.submit([enc.finish()]);
}

// ---------------------------------------------------------------------------
// Readback — pull xNext/yNext/vx/vy/radius/density/age back into the CPU store.
// ---------------------------------------------------------------------------

function poolSizeClass(byteSize: number): number {
  let n = Math.max(64, byteSize | 0);
  n--; n |= n >>> 1; n |= n >>> 2; n |= n >>> 4; n |= n >>> 8; n |= n >>> 16;
  return (n + 1) >>> 0;
}
function acquireStaging(rt: AgentWebGPURuntime, byteSize: number): PooledBuffer {
  const sc = poolSizeClass(byteSize);
  let bucket = rt.stagingPool.get(sc);
  if (!bucket) { bucket = []; rt.stagingPool.set(sc, bucket); }
  for (const e of bucket) if (!e.inUse) { e.inUse = true; return e; }
  const buffer = rt.device.createBuffer({ label: `agent-staging-${sc}`, size: sc, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const entry: PooledBuffer = { buffer, size: sc, inUse: true };
  bucket.push(entry);
  return entry;
}

/** Read the f32 agent SoA back + commit the evolved fields into the CPU store.
 *  `xNext/yNext` → `x/y` (the GPU force pass wrote the integrated position into
 *  the Next slots; we commit them as the new live position, the JS `swapPositions`
 *  analogue) and `vx/vy/radius/density/age` are read in place. */
export async function readbackAgentStep(rt: AgentWebGPURuntime, s: AgentStore): Promise<void> {
  const L = rt.layout, hw = s.highWater;
  const byteLen = f32Bytes(L);
  const pooled = acquireStaging(rt, byteLen);
  const staging = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'agent-readback-enc' });
  enc.copyBufferToBuffer(rt.agentF32Buf, 0, staging, 0, byteLen);
  rt.device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ, 0, byteLen);
  const f = new Float32Array(staging.getMappedRange(0, byteLen));
  const xB = L.f32Base['xNext']!, yB = L.f32Base['yNext']!;
  const vxB = L.f32Base['vx']!, vyB = L.f32Base['vy']!;
  const radB = L.f32Base['radius']!, denB = L.f32Base['density']!, ageB = L.f32Base['age']!;
  for (let i = 0; i < hw; i++) {
    if (!s.alive[i]) continue;
    s.x[i] = f[xB + i]!; s.y[i] = f[yB + i]!;
    s.xNext[i] = f[xB + i]!; s.yNext[i] = f[yB + i]!;
    s.vx[i] = f[vxB + i]!; s.vy[i] = f[vyB + i]!;
    s.radius[i] = f[radB + i]!;
    s.density[i] = f[denB + i]!;
    s.age[i] = f[ageB + i]!;
  }
  staging.unmap();
  pooled.inUse = false;
}

// ---------------------------------------------------------------------------
// Dispose.
// ---------------------------------------------------------------------------

export function destroyAgentWebGPURuntime(rt: AgentWebGPURuntime | null): void {
  if (!rt) return;
  const bufs = [
    rt.agentF32Buf, rt.agentI32Buf, rt.agentAliveBuf, rt.hashBinsBuf,
    rt.controlBuf, rt.rngStateBuf, rt.agentColorsBuf, rt.forceControlBuf,
    rt.fieldReadBuf, rt.fieldDepositBuf,
  ];
  for (const b of bufs) { if (b) try { b.destroy(); } catch { /* non-fatal */ } }
  for (const bucket of rt.stagingPool.values()) for (const e of bucket) { try { e.buffer.destroy(); } catch { /* non-fatal */ } }
  rt.stagingPool.clear();
  rt.ready = false;
}
