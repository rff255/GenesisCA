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
import { initAgentSlot, freeStagedSlot } from './agentEngine';
import type { AgentWebGPULayout } from '../../modeler/vpl/compiler/agentWebgpu/layout';
import { AGENT_GPU_F32_FIELDS, AGENT_GPU_F32_FIELDS_3D, AGENT_GPU_I32_FIELDS, AGENT_GPU_QUEUE_FIELDS, AGENT_GPU_REQUEST_FIELDS } from '../../modeler/vpl/compiler/agentWebgpu/layout';
import { emitAgentForcePassWGSL, agentMirrorFields, emitForceControlStruct } from '../../modeler/vpl/compiler/agentWebgpu/forcePass';
import { acquireSharedGpuDevice, releaseSharedGpuDevice } from './sharedGpuDevice';

const REQUEST_FIELD_SET: ReadonlySet<string> = new Set(AGENT_GPU_REQUEST_FIELDS);

// Workgroup size — MUST match the `@workgroup_size(64)` in both agent shaders.
const AGENT_WG = 64;
const MAX_WG_PER_DIM = 65535;

/** PX — the attribute COMMIT shader (`agentUpdateMode: 'sync'` only).
 *
 *  Folds the per-attribute WRITE runs onto the READ runs, once per generation,
 *  right after the behaviour dispatch — so the next generation reads what this one
 *  wrote, which is what "synchronous" means. Both blocks are contiguous and in the
 *  same attribute order (see `computeAgentWebGPULayout`), so the whole commit is
 *  ONE linear copy of `agentAttrIds.length * maxAgents` elements.
 *
 *  It is a COMPUTE pass, not a `copyBufferToBuffer`: a same-buffer copy is a WebGPU
 *  validation error — the exact constraint the L1 voxel `posCommit` pass hit.
 *
 *  The 2-D index recovery mirrors `dispatchAgents` (a flat 1-D dispatch silently
 *  no-ops past 65535 workgroups). Covers ALL `maxAgents` slots, not just
 *  `highWater`: a Create Agent newborn lives beyond the live range and its GPU-written
 *  defaults must reach the read run before `readbackAgentStep` reconciles it. */
function attrCommitWGSL(readStart: number, writeStart: number, count: number): string {
  return `@group(0) @binding(0) var<storage, read_write> agentF32 : array<f32>;

@compute @workgroup_size(${AGENT_WG})
fn attrCommit(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i: u32 = gid.y * (nwg.x * ${AGENT_WG}u) + gid.x;
  if (i >= ${count}u) { return; }
  agentF32[${readStart}u + i] = agentF32[${writeStart}u + i];
}
`;
}

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
  /** Collision capability (soft-sphere REPULSION / volume exclusion), gated
   *  independently of bonding physics. Absent ⇒ falls back to `bonding`. */
  doCollision?: number;
  torus: number;
  /** L1 long-range charge (absent ⇒ 0 ⇒ off ⇒ the shader's charge branch never
   *  taken ⇒ behaviour-identical to the pre-charge force pass). `chargeMaxD2`
   *  (cutoff²) and `chargeMinC` (= 1/(1+cutoff²)) arrive PRECOMPUTED, the same way
   *  `dtOverEta` does, so all three targets fold identical constants. */
  doCharge?: number;
  chargeK?: number;
  chargeMaxD2?: number;
  chargeMinC?: number;
  /** 3D extents (default 1 ⇒ 2D — the z stencil / integration is gated off). */
  nBinsZ?: number;
  binSizeZ?: number;
  fieldD?: number;
  /** The bbox-anchored hash grid origin (0 on a torus). */
  originX?: number;
  originY?: number;
  originZ?: number;
  /** P1: run the neighbour/density scan. 0 ⇒ skip it entirely (engine physics
   *  off AND nothing reads density). Absent ⇒ 1 (the historical always-scan). */
  doDensity?: number;
}

interface PooledBuffer { buffer: GPUBuffer; size: number; inUse: boolean }

export interface AgentWebGPURuntime {
  device: GPUDevice;
  adapter: GPUAdapter;
  layout: AgentWebGPULayout;
  /** True once buffers + pipelines are live and a step can dispatch. */
  ready: boolean;
  /** True when the behaviour writes the i32 SoA (setAgentType) → readback pulls
   *  the i32 type run back into the CPU store. */
  usesI32Write: boolean;

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
  /** Universal-node bindings (Generic Agent Platform). null when the model uses
   *  none. auxF32 (9) = model attrs + lookup tables; indicators (10) = the atomic
   *  standalone-indicator buffer; bondStore (11) = the interleaved ragged bonds. */
  auxF32Buf: GPUBuffer | null;
  indicatorsBuf: GPUBuffer | null;
  bondStoreBuf: GPUBuffer | null;
  /** Mid-step spawning (binding 12) — a single-word atomic bump counter. null when
   *  the behaviour graph never uses Create Agent / Add Agent To World. Init to
   *  highWater before each dispatch; the shader allocates newborn slots by
   *  `atomicAdd`; the readback reconciles the committed newborns into the CPU store. */
  spawnCursorBuf: GPUBuffer | null;
  /** True when spawnCursorBuf is live (agentAlive is bound read_write, and the
   *  readback runs the spawn reconciliation). */
  usesSpawn: boolean;
  /** P3 — the behaviour (or an OM pass) WRITES the bond store (Set Bond
   *  Attribute): binding 11 is bound `storage`, the buffer carries COPY_SRC, and
   *  the worker reads the user attribute lanes back after each dispatch. */
  usesBondStoreWrite: boolean;
  /** Stop Event flag (binding 13) — a single-word atomic. null when the behaviour
   *  graph has no Stop Event. Seeded to 0 before each dispatch; the shader writes a
   *  1-based stop index via atomicCompareExchangeWeak; the readback returns it so
   *  the worker merges it into the shared stopFlag. */
  stopFlagBuf: GPUBuffer | null;
  usesStop: boolean;
  /** Apply Force To Agent (binding 14) — an f32-bitcast atomic force-scatter
   *  accumulator (X/Y[/Z] regions strided by maxAgents). null when the behaviour
   *  graph has no Apply Force To Agent. Zeroed (clearBuffer) before each behaviour
   *  dispatch; the force pass reads it (its binding 4) into the self-force seed. */
  forceScatterBuf: GPUBuffer | null;
  /** L2 — Get Generation (binding 15): a single u32 holding the 0-based index of
   *  the generation being computed. ALWAYS created (4 bytes) because the resident
   *  `posCommit` pass bumps it unconditionally; only the BEHAVIOUR/OM bind-group
   *  ENTRY is gated on real usage (a declared-but-unused storage global is stripped
   *  by Naga, which would mismatch the reflected layout).
   *
   *  THE reason it is a storage buffer and not a Control uniform field:
   *  `dispatchResidentBatch` encodes ALL N generations of a batch into ONE command
   *  encoder and submits once, with no CPU touch point between generations — a
   *  uniform written host-side would therefore be FROZEN for the whole batch, and
   *  silently so (every single-step test would still pass). */
  genCounterBuf: GPUBuffer;
  usesGeneration: boolean;

  // --- pipelines ---
  behaviourPipeline: GPUComputePipeline;
  forcePipeline: GPUComputePipeline;
  behaviourBindGroup: GPUBindGroup;
  forceBindGroup: GPUBindGroup;
  /** L3 — the RELAX COMMIT, appended BETWEEN consecutive force passes when
   *  `layoutIterations > 1`. It commits xNext→x (so the next force iteration
   *  integrates from the moved positions) and undoes that iteration's `age += 1`
   *  — nothing else. Deliberately NOT `posCommit`: that one also zeroes the force
   *  accumulator (which would drop the generation's graph-authored Apply Force
   *  after the first iteration) and bumps the GPU generation counter (which would
   *  make `Get Generation` advance `layoutIterations` times per generation).
   *  Reads `highWater` from the ForceControl uniform, which BOTH GPU paths write,
   *  so one pipeline serves the per-gen dispatch and the resident batch.
   *  null only if the pipeline failed to build (then the caller runs 1 iteration). */
  relaxCommitPipeline: GPUComputePipeline | null;
  relaxCommitBindGroup: GPUBindGroup | null;
  /** PX — the sync attribute-commit pass (write runs → read runs), appended to
   *  every `dispatchAgentStep` encoder. null unless `layout.syncAttrs` (an async
   *  model has one run per attribute, so there is nothing to commit). */
  attrCommitPipeline: GPUComputePipeline | null;
  attrCommitBindGroup: GPUBindGroup | null;
  /** Elements the commit pass copies (= agentAttrIds.length · maxAgents). 0 ⇒ no pass. */
  attrCommitCount: number;
  /** A1.5 — one GPU Agent Output-Mapping colour pass per mapping id (each writes
   *  agentColors from the agent attrs). Empty for a no-OM model (Boids). */
  omPipelines: Map<string, { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup }>;
  /** The mapping id of the active agent viewer — the resident batch + present
   *  dispatch `omPipelines.get(activeOmMappingId)` (the worker sets it from
   *  `agentColorViewer`). Empty ⇒ no OM dispatch (behaviour Set Cell Looks or
   *  the uploaded CPU colours drive agentColors). */
  activeOmMappingId: string;

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
  /** PR7c GPU residency — the lazily-built GPU hash-build + position-commit
   *  pipelines (see ensureAgentResident). null until residency first engages;
   *  `residentBuildFailed` latches a build failure so we don't retry per batch. */
  resident?: AgentResidentRuntime | null;
  residentBuildFailed?: boolean;

  // --- A1 direct agent render (GPU-side, agents-only 2D) ---
  /** The transferred OffscreenCanvas + its WebGPU context (display-pixel sized).
   *  null until `setupAgentDirectRender` succeeds. */
  renderCanvas?: OffscreenCanvas | null;
  renderCtx?: GPUCanvasContext | null;
  /** The RenderView uniform (camera + tiling + outline/glow/bg). */
  renderViewBuf?: GPUBuffer | null;
  /** Two pipelines from one module: plain (premultiplied-alpha) + glow (additive). */
  renderPlainPipeline?: GPURenderPipeline | null;
  renderGlowPipeline?: GPURenderPipeline | null;
  renderBindGroup?: GPUBindGroup | null;
  /** True once the render canvas is attached + pipelines live. dispatchResidentBatch
   *  appends the present pass to its single submit only when this is set. */
  renderActive?: boolean;
  /** The clear colour (from the last RenderView) — premultiplied RGBA in 0..1. */
  renderClear?: [number, number, number, number];
  /** Whether the last uploaded RenderView selected the glow pipeline. */
  renderGlow?: boolean;
  /** Torus-copy counts from the last RenderView (the render instance count is
   *  `highWater × renderCopiesX × renderCopiesY`). */
  renderCopiesX?: number;
  renderCopiesY?: number;
  // --- Phase C 3D sphere-impostor render (built when layout.gridDepth > 1) ---
  render3D?: boolean;
  renderSpherePipeline?: GPURenderPipeline | null;
  renderSphereBindGroup?: GPUBindGroup | null;
  renderView3DBuf?: GPUBuffer | null;
  renderDepthTex?: GPUTexture | null;
  renderDepthW?: number;
  renderDepthH?: number;
  // E2 — single-canvas composite (2D grid+agents, WebGPU grid). The canvas is
  // DISPLAY-sized; one encoder presents the grid layer (a fullscreen triangle whose
  // FS INVERTS the camera — display pixel → world coord → cell → grid `colorsBuf`,
  // NEAREST) then the agent disc pass (the same display-res camera as A1) with
  // loadOp:'load' over it, so BOTH layers ride ONE canvas at DISPLAY resolution —
  // agents stay crisp discs at any zoom. The main thread blits the canvas 1:1.
  renderComposite?: boolean;
  gridPresentPipeline?: GPURenderPipeline | null;
  gridPresentBGL?: GPUBindGroupLayout | null;
  gridPresentUniform?: GPUBuffer | null;
}

/** PR7c — the GPU-side spatial-hash build (clear→count→scan→scatter) + the
 *  per-generation position commit (xNext→x), letting a whole gens/frame batch
 *  run on the GPU with ZERO per-generation CPU work or transfers. */
export interface AgentResidentRuntime {
  countPipeline: GPUComputePipeline;
  scanPipeline: GPUComputePipeline;
  scatterPipeline: GPUComputePipeline;
  commitPipeline: GPUComputePipeline;
  countBind: GPUBindGroup;
  scanBind: GPUBindGroup;
  scatterBind: GPUBindGroup;
  commitBind: GPUBindGroup;
  /** Per-bin atomic counters (maxHashBins × u32). */
  countsBuf: GPUBuffer;
  /** Per-bin scatter cursors (maxHashBins × u32, seeded = binStart by the scan). */
  cursorBuf: GPUBuffer;
  /** The HashParams uniform (48 B — see HASH_PARAMS_WGSL). */
  hashParamsBuf: GPUBuffer;
  // --- B1 bin-sorted mirror (built ONLY when the force scan runs — needScan) ---
  /** True when the mirror scatter + mirror force pass were built (the model runs
   *  the engine force scan). false for pure-custom-force models (Boids/PL) — no
   *  mirror buffers/pipelines, the `scatterPipeline` is the plain scatter and the
   *  resident batch uses the shared `rt.forcePipeline`. */
  hasMirror: boolean;
  /** Field-major mirror of the neighbour-read fields — a contiguous `maxAgents`
   *  f32 run per `agentMirrorFields(is3d)` field, written in CSR (bin) order by the
   *  mirror scatter. null when !hasMirror. */
  sortedBuf: GPUBuffer | null;
  /** Each CSR slot's canonical agent id (u32 × maxAgents). null when !hasMirror. */
  sortedIdBuf: GPUBuffer | null;
  /** The resident-only mirror force pass (reads neighbour fields COALESCED from
   *  the mirror). null when !hasMirror ⇒ the batch uses the shared rt.forcePipeline. */
  forceMirrorPipeline: GPUComputePipeline | null;
  forceMirrorBind: GPUBindGroup | null;
}

/** CPU-computed per-batch hash geometry for the resident path (radius is static
 *  under residency eligibility, so this is exact for the whole batch). */
export interface ResidentHashParams {
  hashValid: number;
  nBinsX: number; nBinsY: number; nBinsZ: number;
  binSizeX: number; binSizeY: number; binSizeZ: number;
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
// Control: 8×u32 + 6×f32 = 56 → round to 16-byte alignment (64). ForceControl:
// 6×u32 + 11×f32 = 68 → round to 80. WebGPU requires uniform-struct size be a
// multiple of 16; over-allocating to the next 16 is safe.
// +16 bytes each for the bbox-anchored hash grid origin (originX/Y/Z + a pad,
// 16-byte aligned). Control was 14 u32/f32 (→64) + origin block = 80; ForceControl
// was 21 (→80, with WGSL's 16-byte round-up) + origin block = 96.
const CONTROL_BYTES = 80;
// 29 scalar fields = 116 B; padded to 128 (16-aligned headroom — WebGPU requires a
// uniform binding size that is a multiple of 16). The WGSL all-scalar struct's
// minBindingSize is 116 — a larger buffer is valid. (Was 25 fields / 112 before L1
// appended the four charge scalars.) Registered in verify-render-uniform-layouts.
const FORCE_CONTROL_BYTES = 128;

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

/** Create the agent WebGPU runtime: acquire a device, compile the behaviour +
 *  force shaders, allocate the buffers, build the two bind groups + pipelines.
 *  Throws on any WGSL compile error / device failure (the worker catches +
 *  falls back to JS). */
/** Which universal bindings the behaviour shader actually declares (from the
 *  compile result). The runtime binds matching entries ONLY for the used ones (a
 *  declared-but-unused storage global is stripped by Naga → a bind-group mismatch).
 *  Defaults to the region presence (the legacy path) when not provided. */
export interface AgentRuntimeUsage {
  usesBondStore?: boolean;
  usesIndicators?: boolean;
  usesAux?: boolean;
  usesSpawn?: boolean;
  usesStop?: boolean;
  usesForceScatter?: boolean;
  /** L2 — the behaviour reads Get Generation: bind the genCounter buffer (15). */
  usesGeneration?: boolean;
  /** P3 — the behaviour WRITES the bond store (Set Bond Attribute): binding 11 is
   *  declared `read_write`, so its bind-group entry must be `storage` (not
   *  read-only) and the buffer needs COPY_SRC for the attribute-lane readback. */
  usesBondStoreWrite?: boolean;
}

/** A1.5 — one Agent Output-Mapping GPU colour pass: its WGSL module + the
 *  read-only universal bindings it references (an OM never spawns / writes i32 /
 *  scatters force, so only aux/indicators/bondStore can appear). The runtime
 *  builds one compute pipeline + bind group per OM (sharing the SoA buffers). */
export interface AgentOMShaderInput {
  mappingId: string;
  code: string;
  usesBondStore: boolean;
  /** P3 — this OM pass writes the bond store (Set Bond Attribute in a colour
   *  pass) ⇒ bind binding 11 as `storage`, matching its `read_write` declaration. */
  usesBondStoreWrite?: boolean;
  usesIndicators: boolean;
  usesAux: boolean;
  /** L2 — this OM colour pass reads Get Generation (binding 15). */
  usesGeneration?: boolean;
}

/** A built OM colour-pass pipeline (shares the runtime's SoA/control buffers). */
interface AgentOMPipeline {
  pipeline: GPUComputePipeline;
  bindGroup: GPUBindGroup;
}

export async function createAgentWebGPURuntime(
  behaviourShader: string,
  forceShader: string,
  layout: AgentWebGPULayout,
  usesI32Write = false,
  usage: AgentRuntimeUsage = {},
  omShaders: AgentOMShaderInput[] = [],
): Promise<AgentWebGPURuntime> {
  if (!isWebGPUAvailable()) throw new Error('navigator.gpu is unavailable in this context');
  // E1: take the worker's shared device (one device serves the grid + every agent
  // runtime; the union limits were requested at the singleton). Released by
  // destroyAgentWebGPURuntime. A throw past this point releases the reference.
  const sd = await acquireSharedGpuDevice();
  if (!sd) throw new Error('WebGPU shared device unavailable (agents)');
  const device = sd.device, adapter = sd.adapter;
  try {

  // Compile + validate both modules up front (clear errors before any dispatch).
  const behaviourModule = device.createShaderModule({ code: behaviourShader });
  const forceModule = device.createShaderModule({ code: forceShader });
  // A1.5 — the OM colour-pass modules (one per agent mapping). A per-module
  // compile failure disables ONLY that OM (it keeps its last colours) — never the
  // whole runtime.
  const omModules = omShaders.map(o => ({ input: o, module: device.createShaderModule({ code: o.code }) }));
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

  // Mid-step spawning (Create Agent / Add To World): agentAlive is written on the
  // GPU (Add To World marks a newborn live) + read back to reconcile, so it needs
  // read_write storage + COPY_SRC; the spawnCursor atomic bump lives in its own tiny
  // storage buffer (binding 12). Created only when the shader declared them (usage).
  const hasSpawn = !!usage.usesSpawn;
  // Stop Event flag (binding 13) — a single-word atomic; seeded to 0 before each
  // dispatch, read back after, merged into the shared stopFlag by the worker.
  const hasStop = !!usage.usesStop;
  // Apply Force To Agent (binding 14) — an atomic f32 force-scatter accumulator,
  // X/Y[/Z] regions each `maxAgents` wide. Zeroed each step, read by the force pass.
  const hasForceScatter = !!usage.usesForceScatter;
  const forceScatterComponents = layout.gridDepth > 1 ? 3 : 2;
  const forceScatterBuf = hasForceScatter ? mk('agentForceScatter', Math.max(4, layout.maxAgents * forceScatterComponents * 4), STORAGE) : null;
  const agentF32Buf = mk('agentF32', f32Bytes(layout), STORAGE);
  // agentI32 needs COPY_SRC (readback) + read_write storage when setAgentType writes it.
  const agentI32Buf = mk('agentI32', i32Bytes(layout), usesI32Write ? STORAGE : STORAGE_RO);
  const agentAliveBuf = mk('agentAlive', aliveBytes(layout), hasSpawn ? STORAGE : STORAGE_RO);
  const spawnCursorBuf = hasSpawn ? mk('agentSpawnCursor', 4, STORAGE) : null;
  const stopFlagBuf = hasStop ? mk('agentStopFlag', 4, STORAGE) : null;
  // L2 — the generation counter. ALWAYS created: the resident posCommit pass bumps
  // it unconditionally (one shader, no variants), and 4 bytes is free. COPY_SRC so a
  // probe/test can read it back.
  const hasGeneration = !!usage.usesGeneration;
  const genCounterBuf = mk('agentGenCounter', 4, STORAGE);
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
  // Universal-node bindings — created only when the SHADER actually uses them
  // (the compiler's usage flags), NOT merely when the layout reserved the region:
  // an unused storage global is stripped by Naga, so binding it here would mismatch
  // the pipeline's reflected layout (the GoL-on-agents all-die bug). Fall back to
  // the region presence when no usage was provided (legacy callers).
  const hasAux = (usage.usesAux ?? layout.auxF32Len > 0) && layout.auxF32Len > 0;
  const hasIndicators = (usage.usesIndicators ?? layout.indicatorCount > 0) && layout.indicatorCount > 0;
  const hasBondStore = (usage.usesBondStore ?? layout.bondStoreLen > 0) && layout.bondStoreLen > 0;
  // A1.5 — the read-only aux / indicators / bond-store buffers must exist for the
  // UNION of the behaviour + every OM colour pass (an OM may read a model attr /
  // indicator / bond the behaviour doesn't). The BEHAVIOUR bind group still binds
  // ONLY the behaviour's own declared bindings (hasAux/…), and each OM binds its
  // own — a declared-but-unbound buffer is a valid unused entry, but a used-but-
  // unbound binding is not, so the buffer set is the union while each bind group
  // matches its shader exactly.
  const bufAux = (hasAux || omShaders.some(o => o.usesAux)) && layout.auxF32Len > 0;
  const bufIndicators = (hasIndicators || omShaders.some(o => o.usesIndicators)) && layout.indicatorCount > 0;
  const bufBondStore = (hasBondStore || omShaders.some(o => o.usesBondStore)) && layout.bondStoreLen > 0;
  const auxF32Buf = bufAux ? mk('agentAuxF32', Math.max(4, layout.auxF32Len * 4), STORAGE_RO) : null;
  const indicatorsBuf = bufIndicators ? mk('agentIndicators', Math.max(4, layout.indicatorCount * 4), STORAGE) : null;
  // P3 — a bond store the behaviour (or an OM pass) WRITES needs COPY_SRC so the
  // worker can read the user attribute lanes back after the dispatch.
  const bondStoreWrites = !!usage.usesBondStoreWrite || omShaders.some(o => o.usesBondStoreWrite);
  const bondStoreBuf = bufBondStore ? mk('agentBondStore', Math.max(4, layout.bondStoreLen * 4), bondStoreWrites ? STORAGE : STORAGE_RO) : null;
  // agentI32 is read_write only when the shader writes it (setAgentType).
  const i32WritesI32 = !!usesI32Write;

  // --- behaviour pipeline (7 base bindings + the conditional field/universal
  //     bindings 7..11) ---
  const behaviourEntries: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: i32WritesI32 ? 'storage' : 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: hasSpawn ? 'storage' : 'read-only-storage' } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ];
  if (fieldReadBuf) behaviourEntries.push({ binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
  if (fieldDepositBuf) behaviourEntries.push({ binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
  if (hasAux) behaviourEntries.push({ binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
  if (hasIndicators) behaviourEntries.push({ binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
  // P3 — `storage` (read-write) when Set Bond Attribute made binding 11 read_write.
  if (hasBondStore) behaviourEntries.push({ binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: bondStoreWrites ? 'storage' : 'read-only-storage' } });
  if (spawnCursorBuf) behaviourEntries.push({ binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
  if (stopFlagBuf) behaviourEntries.push({ binding: 13, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
  if (forceScatterBuf) behaviourEntries.push({ binding: 14, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
  if (hasGeneration) behaviourEntries.push({ binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
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
  if (hasAux) behaviourBgEntries.push({ binding: 9, resource: { buffer: auxF32Buf! } });
  if (hasIndicators) behaviourBgEntries.push({ binding: 10, resource: { buffer: indicatorsBuf! } });
  if (hasBondStore) behaviourBgEntries.push({ binding: 11, resource: { buffer: bondStoreBuf! } });
  if (spawnCursorBuf) behaviourBgEntries.push({ binding: 12, resource: { buffer: spawnCursorBuf } });
  if (stopFlagBuf) behaviourBgEntries.push({ binding: 13, resource: { buffer: stopFlagBuf } });
  if (forceScatterBuf) behaviourBgEntries.push({ binding: 14, resource: { buffer: forceScatterBuf } });
  if (hasGeneration) behaviourBgEntries.push({ binding: 15, resource: { buffer: genCounterBuf } });
  const behaviourBindGroup = device.createBindGroup({
    label: 'agent-behaviour-bg', layout: behaviourBGL, entries: behaviourBgEntries,
  });

  // --- force pipeline (4 bindings: agentF32 rw, agentAlive r, hashBins r, fc
  //     uniform; + binding 4 forceScatter r when Apply Force To Agent is used) ---
  const forceEntries: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
  ];
  if (forceScatterBuf) forceEntries.push({ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
  const forceBGL = device.createBindGroupLayout({ label: 'agent-force-bgl', entries: forceEntries });
  const forcePL = device.createPipelineLayout({ label: 'agent-force-pl', bindGroupLayouts: [forceBGL] });
  const forcePipeline = await device.createComputePipelineAsync({
    label: 'agent-force', layout: forcePL,
    compute: { module: forceModule, entryPoint: 'forcePass' },
  });
  const forceBgEntries: GPUBindGroupEntry[] = [
    { binding: 0, resource: { buffer: agentF32Buf } },
    { binding: 1, resource: { buffer: agentAliveBuf } },
    { binding: 2, resource: { buffer: hashBinsBuf } },
    { binding: 3, resource: { buffer: forceControlBuf } },
  ];
  if (forceScatterBuf) forceBgEntries.push({ binding: 4, resource: { buffer: forceScatterBuf } });
  const forceBindGroup = device.createBindGroup({ label: 'agent-force-bg', layout: forceBGL, entries: forceBgEntries });

  // --- L3 relax-commit pipeline (3 bindings: agentF32 rw, ForceControl uniform,
  //     agentAlive r). Built unconditionally: it is one tiny shader, and building
  //     it lazily would mean a model that only turns `layoutIterations` up in the
  //     Properties panel could not use it without a runtime rebuild. It is only
  //     ever DISPATCHED when layoutIterations > 1, so a default model pays nothing
  //     beyond the build. ---
  let relaxCommitPipeline: GPUComputePipeline | null = null;
  let relaxCommitBindGroup: GPUBindGroup | null = null;
  try {
    const relaxModule = device.createShaderModule({ label: 'agent-relax-commit', code: emitRelaxCommitWGSL(layout) });
    const rinfo = await relaxModule.getCompilationInfo();
    const rerr = rinfo.messages.filter(m => m.type === 'error');
    if (rerr.length) throw new Error(rerr.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
    const relaxBGL = device.createBindGroupLayout({
      label: 'agent-relax-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    relaxCommitPipeline = await device.createComputePipelineAsync({
      label: 'agent-relax-commit',
      layout: device.createPipelineLayout({ label: 'agent-relax-pl', bindGroupLayouts: [relaxBGL] }),
      compute: { module: relaxModule, entryPoint: 'relaxCommit' },
    });
    relaxCommitBindGroup = device.createBindGroup({
      label: 'agent-relax-bg', layout: relaxBGL,
      entries: [
        { binding: 0, resource: { buffer: agentF32Buf } },
        { binding: 1, resource: { buffer: forceControlBuf } },
        { binding: 2, resource: { buffer: agentAliveBuf } },
      ],
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[agents/webgpu] relax-commit pipeline build failed (layoutIterations clamps to 1): ' + ((e as Error)?.message || e));
    relaxCommitPipeline = null; relaxCommitBindGroup = null;
  }

  // --- PX attribute-commit pipeline (sync agent update only; 1 binding) ---
  // Built ONLY when the layout allocated distinct write runs, so an async model
  // creates no extra module/pipeline and its dispatch is unchanged.
  let attrCommitPipeline: GPUComputePipeline | null = null;
  let attrCommitBindGroup: GPUBindGroup | null = null;
  let attrCommitCount = 0;
  if (layout.syncAttrs && layout.agentAttrIds.length > 0) {
    const first = layout.agentAttrIds[0]!;
    const readStart = layout.agentAttrBase[first]!;
    const writeStart = layout.agentAttrWriteBase[first]!;
    attrCommitCount = layout.agentAttrIds.length * layout.maxAgents;
    const commitModule = device.createShaderModule({ code: attrCommitWGSL(readStart, writeStart, attrCommitCount) });
    const cinfo = await commitModule.getCompilationInfo();
    const cerrs = cinfo.messages.filter(m => m.type === 'error');
    if (cerrs.length > 0) {
      throw new Error('[agents/webgpu] attribute-commit WGSL compile errors:\n' +
        cerrs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
    }
    const commitBGL = device.createBindGroupLayout({
      label: 'agent-attr-commit-bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }],
    });
    attrCommitPipeline = await device.createComputePipelineAsync({
      label: 'agent-attr-commit',
      layout: device.createPipelineLayout({ label: 'agent-attr-commit-pl', bindGroupLayouts: [commitBGL] }),
      compute: { module: commitModule, entryPoint: 'attrCommit' },
    });
    attrCommitBindGroup = device.createBindGroup({
      label: 'agent-attr-commit-bg', layout: commitBGL,
      entries: [{ binding: 0, resource: { buffer: agentF32Buf } }],
    });
  }

  // --- A1.5 OM colour-pass pipelines (one per agent mapping) ---
  // Each OM module declares bindings 0-6 (the same base set the behaviour uses,
  // always) + the conditional field bindings 7/8 (layout-driven, like the
  // behaviour) + the read-only aux/indicators/bondStore per THAT OM's own usage.
  // An OM never spawns / writes i32 / scatters force, so agentI32 (1) + agentAlive
  // (2) are always read-only-storage here (a read_write SoA buffer binds fine to a
  // read-only entry). Shares ALL of the runtime's SoA/control buffers.
  const omPipelines = new Map<string, AgentOMPipeline>();
  for (const { input, module } of omModules) {
    try {
      const info = await module.getCompilationInfo();
      const errs = info.messages.filter(m => m.type === 'error');
      if (errs.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[agents/webgpu] OM "${input.mappingId}" WGSL compile error (colour pass disabled): ` +
          errs.map(m => `line ${m.lineNum}: ${m.message}`).join('; '));
        continue;
      }
      const omEntries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ];
      if (fieldReadBuf) omEntries.push({ binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
      if (fieldDepositBuf) omEntries.push({ binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
      if (input.usesAux && auxF32Buf) omEntries.push({ binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
      if (input.usesIndicators && indicatorsBuf) omEntries.push({ binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
      if (input.usesBondStore && bondStoreBuf) omEntries.push({ binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: input.usesBondStoreWrite ? 'storage' : 'read-only-storage' } });
      if (input.usesGeneration) omEntries.push({ binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
      const omBGL = device.createBindGroupLayout({ label: `agent-om-bgl-${input.mappingId}`, entries: omEntries });
      const omPL = device.createPipelineLayout({ label: `agent-om-pl-${input.mappingId}`, bindGroupLayouts: [omBGL] });
      const omPipeline = await device.createComputePipelineAsync({ label: `agent-om-${input.mappingId}`, layout: omPL, compute: { module, entryPoint: 'behaviour' } });
      const omBgEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: agentF32Buf } },
        { binding: 1, resource: { buffer: agentI32Buf } },
        { binding: 2, resource: { buffer: agentAliveBuf } },
        { binding: 3, resource: { buffer: hashBinsBuf } },
        { binding: 4, resource: { buffer: controlBuf } },
        { binding: 5, resource: { buffer: rngStateBuf } },
        { binding: 6, resource: { buffer: agentColorsBuf } },
      ];
      if (fieldReadBuf) omBgEntries.push({ binding: 7, resource: { buffer: fieldReadBuf } });
      if (fieldDepositBuf) omBgEntries.push({ binding: 8, resource: { buffer: fieldDepositBuf } });
      if (input.usesAux && auxF32Buf) omBgEntries.push({ binding: 9, resource: { buffer: auxF32Buf } });
      if (input.usesIndicators && indicatorsBuf) omBgEntries.push({ binding: 10, resource: { buffer: indicatorsBuf } });
      if (input.usesBondStore && bondStoreBuf) omBgEntries.push({ binding: 11, resource: { buffer: bondStoreBuf } });
      if (input.usesGeneration) omBgEntries.push({ binding: 15, resource: { buffer: genCounterBuf } });
      const omBindGroup = device.createBindGroup({ label: `agent-om-bg-${input.mappingId}`, layout: omBGL, entries: omBgEntries });
      omPipelines.set(input.mappingId, { pipeline: omPipeline, bindGroup: omBindGroup });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[agents/webgpu] OM "${input.mappingId}" pipeline build failed (colour pass disabled): ` + ((e as Error)?.message || e));
    }
  }

  const rt: AgentWebGPURuntime = {
    device, adapter, layout, ready: true, usesI32Write: i32WritesI32,
    agentF32Buf, agentI32Buf, agentAliveBuf, hashBinsBuf,
    controlBuf, rngStateBuf, agentColorsBuf, forceControlBuf,
    fieldReadBuf, fieldDepositBuf,
    auxF32Buf, indicatorsBuf, bondStoreBuf,
    spawnCursorBuf, usesSpawn: hasSpawn, usesBondStoreWrite: bondStoreWrites,
    stopFlagBuf, usesStop: hasStop,
    forceScatterBuf,
    genCounterBuf, usesGeneration: hasGeneration,
    behaviourPipeline, forcePipeline, behaviourBindGroup, forceBindGroup,
    relaxCommitPipeline, relaxCommitBindGroup,
    attrCommitPipeline, attrCommitBindGroup, attrCommitCount,
    omPipelines, activeOmMappingId: '',
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
  } catch (err) {
    // A throw past the shared-device acquire (WGSL compile error, buffer OOM)
    // must release the reference or the device leaks for the worker's life.
    releaseSharedGpuDevice(device);
    throw err;
  }
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
  // The 3D z fields are present in the layout (and the store) only when gridDepth>1.
  const f32Src: Record<string, Float64Array> = {
    x: s.x, y: s.y, vx: s.vx, vy: s.vy, radius: s.radius, targetRadius: s.targetRadius,
    age: s.age, forceX: s.forceX, forceY: s.forceY, density: s.density,
    xNext: s.xNext, yNext: s.yNext,
    z: s.z, vz: s.vz, forceZ: s.forceZ, zNext: s.zNext,
  };
  const f32Fields: readonly string[] = L.gridDepth > 1
    ? [...AGENT_GPU_F32_FIELDS, ...AGENT_GPU_F32_FIELDS_3D]
    : AGENT_GPU_F32_FIELDS;
  for (const field of f32Fields) {
    const base = L.f32Base[field];
    if (base === undefined) continue;
    // The structural-request runs (G4 — incl. the 3D divideAxisZ) are uploaded as
    // 0 — a fresh request slate each step (the shader sets the flag, the worker
    // reads it back). divideAxisZ has no CPU source array here, so it falls through.
    if (REQUEST_FIELD_SET.has(field) || field === 'divideAxisZ') {
      // P4 - a queue-shaped request run is `ma * bondReqSlots` long; zeroing only
      // the first `ma` elements would leave a previous step's queued entries live
      // on the GPU (the shader would append past them and the drain would apply
      // stale ops). AGENT_GPU_QUEUE_FIELDS is the one list that says which.
      const n = ma * (AGENT_GPU_QUEUE_FIELDS.has(field) ? L.bondReqSlots : 1);
      for (let i = 0; i < n; i++) f[base + i] = 0;
      continue;
    }
    const src = f32Src[field];
    if (!src) continue;
    for (let i = 0; i < hw; i++) f[base + i] = src[i]!;
    // leave [hw, ma) at 0 (dead slots never read in the shader's alive guard)
    for (let i = hw; i < ma; i++) f[base + i] = 0;
  }
  // User AGENT attributes (G4) — upload from the read buffer (the values the
  // behaviour shader's Get Attribute reads; Set Attribute writes them back).
  //
  // PX — under `syncAttrs` the layout carries a SECOND (write) run per attribute
  // and the shader writes THERE. Seed it from the SAME source: that is the GPU
  // analogue of `primeAgentAttrWrite` (the write buffer starts as a clone of the
  // read buffer, so an attribute the behaviour never touches carries over instead
  // of being clobbered with 0 by the commit pass). Async ⇒ writeBase === base ⇒
  // the second store is the same element written twice with the same value, so
  // the uploaded bytes are identical to pre-PX.
  for (const id of L.agentAttrIds) {
    const base = L.agentAttrBase[id]!;
    const wbase = L.agentAttrWriteBase[id] ?? base;
    const src = s.attrRead[id] as ArrayLike<number> | undefined;
    if (!src) { for (let i = 0; i < ma; i++) { f[base + i] = 0; f[wbase + i] = 0; } continue; }
    for (let i = 0; i < hw; i++) { const v = src[i]!; f[base + i] = v; f[wbase + i] = v; }
    for (let i = hw; i < ma; i++) { f[base + i] = 0; f[wbase + i] = 0; }
  }
  // P3 — Form Bond's per-BOND-ATTRIBUTE initial-value request runs. Uploaded as 0,
  // a fresh request slate each step exactly like bondFormReq / bondFormL /
  // bondFormK (the shader writes them, the worker reads them back). Empty for a
  // model with no bond attributes ⇒ the uploaded bytes are unchanged.
  for (const id of L.bondAttrIds) {
    const base = L.bondFormAttrBase[id];
    if (base === undefined) continue;
    for (let i = 0, n = ma * L.bondReqSlots; i < n; i++) f[base + i] = 0;
  }
  rt.device.queue.writeBuffer(rt.agentF32Buf, 0, f.buffer, f.byteOffset, f.byteLength);

  // i32 fields — lineage / bondCount.
  const i32Src: Record<string, Int32Array> = { lineage: s.lineage, bondCount: s.bondCount };
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

  // Seed the GPU agentColors buffer from the CPU store BEFORE the behaviour
  // dispatch. A model whose agent behaviour has NO colour write (no Set Cell
  // Looks, no Agent Output Mapping — e.g. Boids / Chemotaxis, which rely on the
  // per-slot DEFAULT_AGENT_COLOR) never touches agentColors in the shader, so
  // without this seed the readback (readbackAgentStep) pulls the buffer's
  // uninitialized ZEROS back into s.colors → fully-transparent agents (invisible
  // on the CPU overlay AND the composite disc pass). A colour-writing shader
  // simply overwrites this seed GPU-side, so the seed is idempotent there. This
  // mirrors the render-path seed (presentAgentsFromStore / uploadAgentRenderFields
  // both call uploadAgentColors) — the per-gen + resident SoA-upload path lacked
  // it, so a colour-less WebGPU-agent model was transparent on those paths.
  uploadAgentColors(rt, s);
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

/** Write the behaviour Control uniform (highWater + hash dims + world bounds +
 *  bond capacity + the 3D hash/field extents). Field order MIRRORS
 *  `emitControlStruct` in compile.ts. */
export function uploadAgentControl(
  rt: AgentWebGPURuntime,
  p: { highWater: number; hashValid: number; nBinsX: number; nBinsY: number;
       fieldTorus: number; binSizeX: number; binSizeY: number; fieldW: number; fieldH: number;
       nBinsZ?: number; binSizeZ?: number; fieldD?: number;
       originX?: number; originY?: number; originZ?: number },
): void {
  // struct Control { highWater:u32, maxAgents:u32, hashValid:u32, nBinsX:u32,
  //   nBinsY:u32, fieldTorus:u32, binSizeX:f32, binSizeY:f32, fieldW:f32, fieldH:f32,
  //   maxBonds:u32, nBinsZ:u32, binSizeZ:f32, fieldD:f32, originX:f32, originY:f32,
  //   originZ:f32, _pad:f32 }  (the bbox-anchored hash grid origin)
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
  u[10] = (rt.layout.maxBonds >>> 0);
  u[11] = (p.nBinsZ ?? 1) >>> 0;
  fl[12] = p.binSizeZ ?? 1;
  fl[13] = p.fieldD ?? 1;
  fl[14] = p.originX ?? 0;
  fl[15] = p.originY ?? 0;
  fl[16] = p.originZ ?? 0;
  rt.device.queue.writeBuffer(rt.controlBuf, 0, ab);
}

/** Upload the model attributes + lookup tables into the auxF32 buffer (the upload
 *  order MUST match the layout's `modelAttrKeys` then `lookupTableIds`). `attrs` is
 *  the worker's `cachedModelAttrs` (keys = scalar id / `<id>_r|_g|_b`); `tables` is
 *  per-table row-major f32 data keyed by table id. No-op without an aux buffer. */
export function uploadAgentAux(
  rt: AgentWebGPURuntime,
  attrs: Record<string, number>,
  tables: Record<string, ArrayLike<number>>,
): void {
  const L = rt.layout;
  if (!rt.auxF32Buf || L.auxF32Len === 0) return;
  const f = new Float32Array(L.auxF32Len);
  for (const key of L.modelAttrKeys) {
    const off = L.modelAttrSlot[key];
    if (off === undefined) continue;
    const v = attrs[key];
    f[off] = typeof v === 'number' ? v : 0;
  }
  for (const id of L.lookupTableIds) {
    const tl = L.lookupTables[id];
    if (!tl) continue;
    const data = tables[id];
    // A MULTI-AXIS (N-D) table reserves Π dims f32 slots (rowCount*colCount only
    // covers dims[0]*dims[1]) — the N-D emitter indexes the full Π-dims region,
    // so upload all of it or entries past dims[0]*dims[1] stay 0 (and this target
    // diverges from JS/WASM, which copy the whole tbl.length).
    const n = tl.dims && tl.dims.length > 0
      ? tl.dims.reduce((a, b) => a * Math.max(1, b), 1)
      : tl.rowCount * tl.colCount;
    for (let i = 0; i < n; i++) f[tl.base + i] = data ? (data[i] ?? 0) : 0;
  }
  rt.device.queue.writeBuffer(rt.auxF32Buf, 0, f.buffer, f.byteOffset, f.byteLength);
}

/** Upload the standalone-indicator values into the indicators atomic buffer
 *  (int/tag → bitcast<i32>; everything else → bitcast<f32>). `vals[slot]` is the
 *  per-slot value (the SAME order the compiler resolved `_indicatorIdx`); `isInt`
 *  flags the int/tag slots. No-op without an indicators buffer. */
export function uploadAgentIndicators(
  rt: AgentWebGPURuntime,
  vals: Float64Array | number[],
  isInt: boolean[],
): void {
  const L = rt.layout;
  if (!rt.indicatorsBuf || L.indicatorCount === 0) return;
  const u = new Uint32Array(L.indicatorCount);
  const fbuf = new Float32Array(1), fview = new Uint32Array(fbuf.buffer);
  for (let i = 0; i < L.indicatorCount; i++) {
    const v = (vals[i] ?? 0) as number;
    if (isInt[i]) u[i] = (Math.round(v) | 0) >>> 0;
    else { fbuf[0] = v; u[i] = fview[0]!; }
  }
  rt.device.queue.writeBuffer(rt.indicatorsBuf, 0, u.buffer, u.byteOffset, u.byteLength);
}

/** Read the standalone-indicator atomic buffer back into `out[slot]` (decoded per
 *  the `isInt` flag). No-op without an indicators buffer. */
export async function readbackAgentIndicators(
  rt: AgentWebGPURuntime,
  out: Float64Array | number[],
  isInt: boolean[],
): Promise<void> {
  const L = rt.layout;
  if (!rt.indicatorsBuf || L.indicatorCount === 0) return;
  const byteLen = Math.max(4, L.indicatorCount * 4);
  const pooled = acquireStaging(rt, byteLen);
  const staging = pooled.buffer;
  const enc = rt.device.createCommandEncoder({ label: 'agent-ind-readback-enc' });
  enc.copyBufferToBuffer(rt.indicatorsBuf, 0, staging, 0, byteLen);
  rt.device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ, 0, byteLen);
  const u = new Uint32Array(staging.getMappedRange(0, byteLen));
  const ibuf = new Int32Array(1), iview = new Uint32Array(ibuf.buffer);
  const fbuf = new Float32Array(1), fview = new Uint32Array(fbuf.buffer);
  for (let i = 0; i < L.indicatorCount; i++) {
    if (isInt[i]) { iview[0] = u[i]!; out[i] = ibuf[0]!; }
    else { fview[0] = u[i]!; out[i] = fbuf[0]!; }
  }
  staging.unmap();
  pooled.inUse = false;
}

/** Upload the ragged bond store (interleaved `[partnerId, restLengthBits,
 *  ...userBondAttributes]` per slot, stride `maxBonds · layout.bondSlotStride`).
 *  `s` is the CPU AgentStore (its parallel bondPartner / bondRestLength /
 *  bondAttrs arrays at stride `maxBonds`). No-op without a bond store.
 *
 *  P3 — the attribute words come from `s.bondAttrs[id]`, in the layout's
 *  `bondAttrIds` order (which IS `bondAttrsOf(model)` = the store's
 *  `bondAttrSpecs` order — the baked-offset lockstep). `float` attributes store
 *  f32 BITS (like restLength); bool/integer/tag store a plain i32. */
export function uploadAgentBondStore(rt: AgentWebGPURuntime, s: AgentStore): void {
  const L = rt.layout, mb = L.maxBonds, S = L.bondSlotStride;
  if (!rt.bondStoreBuf || L.bondStoreLen === 0 || mb === 0) return;
  const out = new Int32Array(L.bondStoreLen);
  const rb = new Float32Array(1), rv = new Int32Array(rb.buffer);
  const partner = s.bondPartner, rest = s.bondRestLength;
  const sStride = s.maxBonds; // the CPU store stride (== mb, but read it explicitly)
  const hw = s.highWater;
  const cap = Math.min(mb, sStride);
  // Resolve the attribute lanes ONCE (id → [word, srcArray, isFloat]); empty for a
  // model with no bond attributes ⇒ the loop below is the pre-P3 body verbatim.
  const lanes: Array<{ word: number; src: ArrayLike<number>; isF: boolean }> = [];
  for (const id of L.bondAttrIds) {
    const src = s.bondAttrs[id] as ArrayLike<number> | undefined;
    const word = L.bondAttrWord[id];
    if (!src || word === undefined) continue;
    lanes.push({ word, src, isF: !!L.bondAttrIsFloat[id] });
  }
  for (let i = 0; i < hw; i++) {
    const sBase = i * sStride, gBase = i * mb * S;
    for (let k = 0; k < cap; k++) {
      const g = gBase + k * S, c = sBase + k;
      out[g] = partner[c]!;
      rb[0] = rest[c]!; out[g + 1] = rv[0]!;
      for (const ln of lanes) {
        if (ln.isF) { rb[0] = ln.src[c]!; out[g + ln.word] = rv[0]!; }
        else out[g + ln.word] = ln.src[c]! | 0;
      }
    }
  }
  rt.device.queue.writeBuffer(rt.bondStoreBuf, 0, out.buffer, out.byteOffset, out.byteLength);
}

/** P3 — read the bond store's USER ATTRIBUTE lanes back into the CPU store after a
 *  dispatch whose behaviour ran Set Bond Attribute (`usesBondStoreWrite`). ONLY the
 *  attribute words are copied: partner / restLength are CPU-owned (the structural
 *  phase forms, breaks and compacts them) and the shader never writes them, so
 *  copying them back could only ever un-do a CPU edit.
 *
 *  Called BEFORE `runAgentStructuralPhase`, so a bond broken this step drops the
 *  values with its slot (compaction moves whole slots — `moveBondSlot`). */
export async function readbackAgentBondStore(rt: AgentWebGPURuntime, s: AgentStore): Promise<void> {
  const L = rt.layout, mb = L.maxBonds, S = L.bondSlotStride;
  if (!rt.bondStoreBuf || L.bondStoreLen === 0 || mb === 0 || L.bondAttrIds.length === 0) return;
  const lanes: Array<{ word: number; dst: { [i: number]: number }; isF: boolean }> = [];
  for (const id of L.bondAttrIds) {
    const dst = s.bondAttrs[id] as { [i: number]: number } | undefined;
    const word = L.bondAttrWord[id];
    if (!dst || word === undefined) continue;
    lanes.push({ word, dst, isF: !!L.bondAttrIsFloat[id] });
  }
  if (lanes.length === 0) return;
  const byteLen = L.bondStoreLen * 4;
  const staging = rt.device.createBuffer({ label: 'agentBondStore-readback', size: byteLen, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = rt.device.createCommandEncoder({ label: 'agent-bond-readback-enc' });
  enc.copyBufferToBuffer(rt.bondStoreBuf, 0, staging, 0, byteLen);
  rt.device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ, 0, byteLen);
  const gi = new Int32Array(staging.getMappedRange(0, byteLen));
  const gf = new Float32Array(gi.buffer, gi.byteOffset, gi.length);
  const sStride = s.maxBonds, hw = s.highWater, cap = Math.min(mb, sStride);
  for (let i = 0; i < hw; i++) {
    if (!s.alive[i]) continue;
    const sBase = i * sStride, gBase = i * mb * S;
    for (let k = 0; k < cap; k++) {
      const g = gBase + k * S, c = sBase + k;
      for (const ln of lanes) ln.dst[c] = ln.isF ? gf[g + ln.word]! : gi[g + ln.word]!;
    }
  }
  staging.unmap();
  staging.destroy();
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
  u[17] = (fp.nBinsZ ?? 1) >>> 0;
  fl[18] = fp.binSizeZ ?? 1;
  fl[19] = fp.fieldD ?? 1;
  fl[20] = fp.originX ?? 0;
  fl[21] = fp.originY ?? 0;
  fl[22] = fp.originZ ?? 0;
  u[23] = (fp.doCollision ?? fp.bonding) >>> 0; // Collision capability (repulsion); fallback to bonding for older callers
  u[24] = (fp.doDensity ?? 1) >>> 0; // P1: run the neighbour/density scan (absent → 1, the historical always-scan)
  // L1 charge (absent → 0 ⇒ the shader's charge branch is never taken).
  u[25] = (fp.doCharge ?? 0) >>> 0;
  fl[26] = fp.chargeK ?? 0;
  fl[27] = fp.chargeMaxD2 ?? 0;
  fl[28] = fp.chargeMinC ?? 0;
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
// E1b — GPU field bridge (copyBufferToBuffer, no CPU round-trip).
// For a field-coupled model on a WebGPU grid + WebGPU agents SHARING the E1
// device, the cell field lives in the grid's `attrsRead` buffer (GPU). Instead
// of the CPU `uploadAgentField`/`readbackAgentField` round-trip, copy the field
// GPU-side. Correct ONLY when every field attr is `float` — the grid stores a
// float attr as `bitcast<u32>(f32)`, the agent field buffers hold raw `f32`, so
// the byte pattern is identical and a plain buffer copy is exact (the caller's
// gate enforces the float-only condition; an int/bool/tag field needs the numeric
// convert `uploadAgentField` does and keeps the CPU bridge).
// ---------------------------------------------------------------------------

/** Prime the agent `fieldRead` + `fieldDeposit` buffers by copying the grid's
 *  `attrsRead` buffer GPU-side (replaces the CPU `uploadAgentField` prime).
 *  `gridByteOffset` maps a field attr id → its byte offset in the grid attrs
 *  buffer; `total` = `fieldTotal` (copies cells 0..total-1, so a constant-boundary
 *  sentinel slot at index `total` is excluded automatically). Both buffers must be
 *  on `rt.device` (the shared device). */
export function primeAgentFieldFromGrid(
  rt: AgentWebGPURuntime,
  gridAttrsReadBuf: GPUBuffer,
  gridByteOffset: Record<string, number>,
  total: number,
): void {
  const L = rt.layout;
  const bytes = total * 4;
  if (bytes <= 0) return;
  const enc = rt.device.createCommandEncoder({ label: 'agent-field-prime-gpu-enc' });
  if (rt.fieldReadBuf && L.fieldReadLen > 0) {
    for (const id of L.fieldReadAttrs) {
      const off = gridByteOffset[id];
      if (off === undefined) continue;
      enc.copyBufferToBuffer(gridAttrsReadBuf, off, rt.fieldReadBuf, L.fieldReadBase[id]! * 4, bytes);
    }
  }
  if (rt.fieldDepositBuf && L.fieldWriteLen > 0) {
    // Prime the atomic deposit accumulator with the current field (mirrors
    // uploadAgentField's priming so `add` accumulates onto it, `set`/`max`/`min`
    // start from it). The deposit is f32-bitcast, matching the grid's f32 word.
    for (const id of L.fieldWriteAttrs) {
      const off = gridByteOffset[id];
      if (off === undefined) continue;
      enc.copyBufferToBuffer(gridAttrsReadBuf, off, rt.fieldDepositBuf, L.fieldWriteBase[id]! * 4, bytes);
    }
  }
  rt.device.queue.submit([enc.finish()]);
}

/** Fold the agent `fieldDeposit` accumulator back into the grid's `attrsRead`
 *  buffer GPU-side (replaces the CPU `readbackAgentField`). The deposit words ARE
 *  the final f32 field (`readbackAgentField` is a plain copy), so the fold is a
 *  plain buffer copy — no decode. Only `fieldWriteAttrs` fold. */
export function foldAgentFieldToGrid(
  rt: AgentWebGPURuntime,
  gridAttrsReadBuf: GPUBuffer,
  gridByteOffset: Record<string, number>,
  total: number,
): void {
  const L = rt.layout;
  if (!rt.fieldDepositBuf || L.fieldWriteLen === 0) return;
  const bytes = total * 4;
  if (bytes <= 0) return;
  const enc = rt.device.createCommandEncoder({ label: 'agent-field-fold-gpu-enc' });
  for (const id of L.fieldWriteAttrs) {
    const off = gridByteOffset[id];
    if (off === undefined) continue;
    enc.copyBufferToBuffer(rt.fieldDepositBuf, L.fieldWriteBase[id]! * 4, gridAttrsReadBuf, off, bytes);
  }
  rt.device.queue.submit([enc.finish()]);
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
/** Seed the spawn cursor to `highWater` before a dispatch (the first newborn slot
 *  the atomic bump hands out). No-op without a spawn buffer. */
export function uploadAgentSpawnCursor(rt: AgentWebGPURuntime, highWater: number): void {
  if (!rt.spawnCursorBuf) return;
  const u = new Uint32Array([highWater >>> 0]);
  rt.device.queue.writeBuffer(rt.spawnCursorBuf, 0, u.buffer, u.byteOffset, u.byteLength);
}

/** L2 — seed the GPU generation counter from the CPU's `generation`.
 *
 *  Called by BOTH agent GPU paths, and the difference is the whole point:
 *   - the PER-GENERATION path calls it before every dispatch, so the counter is
 *     simply the host value;
 *   - the RESIDENT path calls it ONCE before a whole batch, and the per-generation
 *     `posCommit` pass advances it GPU-side from there — which is why a rule
 *     reading Get Generation sees N distinct values across an N-generation batch.
 *  Always available (the buffer is unconditional); the behaviour only READS it
 *  when the shader declared binding 15. */
export function uploadAgentGeneration(rt: AgentWebGPURuntime, generation: number): void {
  const u = new Uint32Array([Math.max(0, generation) >>> 0]);
  rt.device.queue.writeBuffer(rt.genCounterBuf, 0, u.buffer, u.byteOffset, u.byteLength);
}

/** Reset the Stop Event flag to 0 before a dispatch (so the shader's first-match
 *  atomicCompareExchangeWeak starts clean). No-op without a stop buffer. */
export function resetAgentStopFlag(rt: AgentWebGPURuntime): void {
  if (!rt.stopFlagBuf) return;
  rt.device.queue.writeBuffer(rt.stopFlagBuf, 0, new Uint32Array([0]).buffer, 0, 4);
}

export function dispatchAgentStep(rt: AgentWebGPURuntime, highWater: number, layoutIterations = 1): void {
  const enc = rt.device.createCommandEncoder({ label: 'agent-step-enc' });
  const total = Math.max(1, highWater);
  // Apply Force To Agent: zero the cross-agent force-scatter accumulator before the
  // behaviour pass writes it (the force pass then folds it into each self-force seed).
  if (rt.forceScatterBuf) enc.clearBuffer(rt.forceScatterBuf);
  const passB = enc.beginComputePass({ label: 'agent-behaviour-pass' });
  passB.setPipeline(rt.behaviourPipeline);
  passB.setBindGroup(0, rt.behaviourBindGroup);
  dispatchAgents(passB, total);
  passB.end();
  // L3 — the force integrator, `layoutIterations` times, separated by relax
  // commits. One iteration (the default) encodes exactly the single force pass
  // this used to be. `readbackAgentStep` performs the FINAL xNext→x commit
  // CPU-side, as before.
  encodeForceIterations(rt, enc, total, layoutIterations, pass => {
    pass.setPipeline(rt.forcePipeline);
    pass.setBindGroup(0, rt.forceBindGroup);
  });
  // PX — sync agent update: fold the attribute WRITE runs onto the READ runs. Passes
  // in one encoder execute in order, so this observes every behaviour write; the
  // force pass touches only geometry/velocity, never a user attribute, so its
  // position here is immaterial. After it, the READ runs hold the committed
  // generation — which is why `readbackAgentStep` / the spawn reconcile /
  // `readbackAgentFrame` all keep reading `agentAttrBase` unchanged.
  if (rt.attrCommitPipeline && rt.attrCommitBindGroup && rt.attrCommitCount > 0) {
    const passC = enc.beginComputePass({ label: 'agent-attr-commit-pass' });
    passC.setPipeline(rt.attrCommitPipeline);
    passC.setBindGroup(0, rt.attrCommitBindGroup);
    dispatchAgents(passC, rt.attrCommitCount);
    passC.end();
  }
  rt.device.queue.submit([enc.finish()]);
}

/** A1.5 — append the active Agent Output-Mapping colour pass to an encoder (reads
 *  the agent attrs the behaviour wrote → writes agentColors). No-op unless an OM
 *  pipeline for `activeOmMappingId` exists (a no-OM model / no active viewer keeps
 *  agentColors as the behaviour Set Cell Looks / uploaded CPU colours left it).
 *  `control` must already carry the batch's highWater (the caller uploaded it). */
export function dispatchAgentOMEncode(rt: AgentWebGPURuntime, enc: GPUCommandEncoder, highWater: number): boolean {
  // Default to the FIRST OM when the active viewer id isn't a built OM pipeline
  // (mirrors runAgentColorPass's `?? agentOutputMappingFns[0]`).
  const om = rt.omPipelines.get(rt.activeOmMappingId) ?? [...rt.omPipelines.values()][0];
  if (!om) return false;
  const pass = enc.beginComputePass({ label: 'agent-om-pass' });
  pass.setPipeline(om.pipeline);
  pass.setBindGroup(0, om.bindGroup);
  dispatchAgents(pass, Math.max(1, highWater));
  pass.end();
  return true;
}

// ---------------------------------------------------------------------------
// A1 — direct agent render. The WORKER renders the agents straight from the
// GPU SoA (x/y/radius/alive) + the packed agentColors buffer into a transferred
// OffscreenCanvas via instanced quads (one disc per agent × torus copy). No
// compiler changes — the render reads only engine-owned fields that exist for
// EVERY agent model (FP-1). Camera + tiling + outline/glow/bg live in the
// RenderView uniform, so pan/zoom/infinity is a uniform update + re-present
// (crisp at any zoom, unlike the upscaled grid blit).
// ---------------------------------------------------------------------------

/** A2 — the narrow render SURFACE the direct-render helpers operate on: a device,
 *  the layout (for the baked x/y/radius bases + maxAgents), the three buffers the
 *  render pipeline binds, and the render-pipeline state. `AgentWebGPURuntime` is
 *  structurally a superset (it declares all these), so the full webgpu-target
 *  runtime passes to every surface helper unchanged; a CPU-target model instead
 *  builds a lightweight render-ONLY surface (createAgentRenderOnlyRuntime) with
 *  no compute pipelines — the SAME AGENT_RENDER_WGSL fed by uploading the CPU
 *  store's positions/colours each frame (uploadAgentRenderFields). */
export interface AgentRenderSurface {
  device: GPUDevice;
  layout: AgentWebGPULayout;
  agentF32Buf: GPUBuffer;
  agentAliveBuf: GPUBuffer;
  agentColorsBuf: GPUBuffer;
  renderCanvas?: OffscreenCanvas | null;
  renderCtx?: GPUCanvasContext | null;
  renderViewBuf?: GPUBuffer | null;
  renderPlainPipeline?: GPURenderPipeline | null;
  renderGlowPipeline?: GPURenderPipeline | null;
  renderBindGroup?: GPUBindGroup | null;
  renderActive?: boolean;
  renderClear?: [number, number, number, number];
  renderGlow?: boolean;
  renderCopiesX?: number;
  renderCopiesY?: number;
  /** Render-only path: reusable CPU scratch for the tight per-frame upload
   *  (x/y/radius runs + alive), so a present doesn't allocate. Absent on the full
   *  webgpu runtime (which uploads via uploadAgentSoA's own persistent scratch). */
  renderF32Scratch?: Float32Array;
  renderAliveScratch?: Uint32Array;
  /** Persistent packing scratch for uploadAgentColors (audit M5). That runs on the
   *  per-frame path TWICE over (uploadAgentRenderFields for A2 + uploadAgentSoA per
   *  generation), so a fresh Uint32Array(maxAgents) there was 200 KB of garbage per
   *  call at 50k agents. Declared here (not only on the render-only surface)
   *  because the FULL webgpu runtime goes through the same helper. */
  renderColorScratch?: Uint32Array;
  // Phase C — 3D sphere-impostor render (built instead of the 2D disc pipeline when
  // layout.gridDepth > 1). The MVP + camera basis + light come from the main thread
  // (sceneCameraMatrices in gl3d.ts, so the two renderers agree on projection); the
  // pass is opaque with a depth attachment so spheres depth-sort among themselves.
  render3D?: boolean;
  renderSpherePipeline?: GPURenderPipeline | null;
  renderSphereBindGroup?: GPUBindGroup | null;
  renderView3DBuf?: GPUBuffer | null;
  renderDepthTex?: GPUTexture | null;
  renderDepthW?: number;
  renderDepthH?: number;
  // E2 — single-canvas composite (2D grid+agents, WebGPU grid). The canvas is
  // DISPLAY-sized; one encoder presents the grid layer (a fullscreen triangle whose
  // FS INVERTS the camera — display pixel → world coord → cell → grid `colorsBuf`,
  // NEAREST) then the agent disc pass (the same display-res camera as A1) with
  // loadOp:'load' over it, so BOTH layers ride ONE canvas at DISPLAY resolution —
  // agents stay crisp discs at any zoom. The main thread blits the canvas 1:1.
  renderComposite?: boolean;
  gridPresentPipeline?: GPURenderPipeline | null;
  gridPresentBGL?: GPUBindGroupLayout | null;
  gridPresentUniform?: GPUBuffer | null;
}

/** The camera + tiling + graphics uniform. Field order MIRRORS
 *  `RENDER_VIEW_WGSL` below AND `uploadAgentRenderView`. All scalar members ⇒
 *  tight 4-byte packing; the WGSL struct rounds to 96 B. */
export interface AgentRenderView {
  highWater: number;
  scalePx: number;
  oxPx: number;
  oyPx: number;
  canvasW: number;
  canvasH: number;
  worldW: number;
  worldH: number;
  copiesX: number;
  copiesY: number;
  startX: number;
  startY: number;
  outlineOn: number;
  glowOn: number;
  glowSize: number;
  glowIntensity: number;
  glowSteepness: number;
  bgR: number;
  bgG: number;
  bgB: number;
  bgA: number;
  // E2 composite only (CPU-side flags — NOT part of the RENDER_VIEW byte layout,
  // ignored by uploadAgentRenderView): the per-layer Show toggles. `showGrid` off
  // → skip the grid pass (agent pass clears to bg*); `showAgents` off → skip the
  // agent disc draw. Both off → a plain bg clear. `torus` selects the grid-plane
  // FS wrap policy (infinity canvas → tile the grid via modulo; bounded → discard
  // outside [0,W)×[0,H) so the grid layer letterboxes transparently).
  showGrid?: boolean;
  showAgents?: boolean;
  torus?: boolean;
}
const RENDER_VIEW_BYTES = 96;

const RENDER_VIEW_WGSL = `struct RenderView {
  highWater     : u32,
  scalePx       : f32,
  oxPx          : f32,
  oyPx          : f32,
  canvasW       : f32,
  canvasH       : f32,
  worldW        : f32,
  worldH        : f32,
  copiesX       : i32,
  copiesY       : i32,
  startX        : i32,
  startY        : i32,
  outlineOn     : u32,
  glowOn        : u32,
  glowSize      : f32,
  glowIntensity : f32,
  glowSteepness : f32,
  bgR           : f32,
  bgG           : f32,
  bgB           : f32,
  bgA           : f32,
};`;

/** Build the agent render module (VS pulls x/y/radius from agentF32 + packed
 *  RGBA from agentColors; FS = disc SDF + optional outline rim OR additive glow).
 *  The f32 field bases are baked from the layout (like emitBinOf). */
function agentRenderWGSL(layout: AgentWebGPULayout): string {
  const xB = layout.f32Base['x']!, yB = layout.f32Base['y']!, rB = layout.f32Base['radius']!;
  const at = (base: number): string => (base === 0 ? 'agent' : `${base}u + agent`);
  return `${RENDER_VIEW_WGSL}
@group(0) @binding(0) var<storage, read> agentF32    : array<f32>;
@group(0) @binding(1) var<storage, read> agentAlive  : array<u32>;
@group(0) @binding(2) var<storage, read> agentColors : array<u32>;
@group(0) @binding(3) var<uniform>       rv          : RenderView;

struct VSOut {
  @builtin(position) pos   : vec4<f32>,
  @location(0)       uv    : vec2<f32>,
  @location(1)       col   : vec4<f32>,
  @location(2)       radPx : f32,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  var out: VSOut;
  let hw: u32 = max(1u, rv.highWater);
  let agent: u32 = inst % hw;
  let copy:  u32 = inst / hw;
  let ncx: u32 = max(1u, u32(rv.copiesX));
  let cx: i32 = i32(copy % ncx) + rv.startX;
  let cy: i32 = i32(copy / ncx) + rv.startY;
  // Quad corner (triangle-strip, 4 verts): (-1,-1)(1,-1)(-1,1)(1,1).
  var corner: vec2<f32> = vec2<f32>(-1.0, -1.0);
  if (vi == 1u) { corner = vec2<f32>(1.0, -1.0); }
  else if (vi == 2u) { corner = vec2<f32>(-1.0, 1.0); }
  else if (vi == 3u) { corner = vec2<f32>(1.0, 1.0); }
  let packed: u32 = agentColors[agent];
  let a: f32 = f32((packed >> 24u) & 0xffu) / 255.0;
  // Dead / invisible agents → a degenerate off-screen quad (clipped away).
  if (agentAlive[agent] == 0u || a <= 0.0) {
    out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.uv = vec2<f32>(0.0, 0.0);
    out.col = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.radPx = 0.0;
    return out;
  }
  let ax: f32 = agentF32[${at(xB)}];
  let ay: f32 = agentF32[${at(yB)}];
  let ar: f32 = agentF32[${at(rB)}];
  let wx: f32 = ax + f32(cx) * rv.worldW;
  let wy: f32 = ay + f32(cy) * rv.worldH;
  let px: f32 = wx * rv.scalePx + rv.oxPx;
  let py: f32 = wy * rv.scalePx + rv.oyPx;
  // Floor the drawn radius at 1.2 px to MATCH the CPU overlay (audit M2): the
  // overlay clamps every disc with Math.max(1.2, r*scale) at all three draw sites,
  // so without this a sub-pixel agent (zoomed out / a large world) rendered as a
  // near-empty quad on the fast path while the CPU path still showed a dot. The
  // FS rim band derives from in.radPx, so it stays consistent with the same rule.
  let radPx: f32 = max(ar * rv.scalePx, 1.2);
  var half: f32 = radPx;
  if (rv.glowOn != 0u) { half = half + rv.glowSize; }
  let sx: f32 = px + corner.x * half;
  let sy: f32 = py + corner.y * half;
  out.pos = vec4<f32>(sx / rv.canvasW * 2.0 - 1.0, 1.0 - sy / rv.canvasH * 2.0, 0.0, 1.0);
  out.uv = corner;
  out.col = vec4<f32>(f32(packed & 0xffu) / 255.0, f32((packed >> 8u) & 0xffu) / 255.0, f32((packed >> 16u) & 0xffu) / 255.0, a);
  out.radPx = radPx;
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  let d: f32 = length(in.uv);
  if (rv.glowOn != 0u) {
    // Additive radial glow across the enlarged quad (selected by the glow pipeline).
    let t: f32 = max(0.0, 1.0 - d);
    let g: f32 = rv.glowIntensity * pow(t, max(0.01, rv.glowSteepness));
    return vec4<f32>(in.col.rgb * g, g);
  }
  if (d > 1.0) { discard; }
  var rgb: vec3<f32> = in.col.rgb;
  let a: f32 = in.col.a;
  if (rv.outlineOn != 0u) {
    // Match the 2D overlay rim rule (stampBatchedTile): darken the outer
    // min(1.5px, 0.25*rad) band by ×0.60.
    let radPx: f32 = max(0.001, in.radPx);
    let rim: f32 = min(1.5, 0.25 * radPx) / radPx;
    if (d > 1.0 - rim) { rgb = rgb * 0.60; }
  }
  // Premultiplied output (the canvas is configured 'premultiplied').
  return vec4<f32>(rgb * a, a);
}`;
}

// ---------------------------------------------------------------------------
// Phase C — 3D sphere-impostor render (agents-only, is3D, no bonds, alpha-blend
// off). Camera-facing billboard quads ray-cast into spheres in the FS, writing
// frag_depth so they depth-sort among themselves. The MAIN thread computes the
// MVP + camera basis + light with the SAME math the WebGL2 gl3d renderer uses
// (sceneCameraMatrices / lightWorldDirFor, exported from gl3d.ts), so the WGSL
// spheres and the gl3d overlays can't disagree on projection. Z-up world remap:
// col→+X, row→−Y, layer→−Z (identical to gl3d's SPHERE_VS).
// ---------------------------------------------------------------------------

/** The 3D camera + lighting uniform for the sphere pass. `mvp` is column-major
 *  (16 f32). Byte layout mirrors RENDER_VIEW_3D_WGSL + uploadAgentRenderView3D. */
export interface AgentRenderView3D {
  mode: '3d';
  mvp: number[];               // 16 floats, column-major
  halfX: number; halfY: number; halfZ: number;         // (W-1)/2 etc.
  camRightX: number; camRightY: number; camRightZ: number;
  camUpX: number; camUpY: number; camUpZ: number;
  camForwardX: number; camForwardY: number; camForwardZ: number;
  lightX: number; lightY: number; lightZ: number;      // world dir toward the light
  ambient: number; diffuse: number; specular: number;
  outlineOn: number;
  bgR: number; bgG: number; bgB: number; bgA: number;  // clear colour
}
const RENDER_VIEW_3D_BYTES = 176;

const RENDER_VIEW_3D_WGSL = `struct RenderView3D {
  mvp        : mat4x4<f32>,
  half       : vec3<f32>,
  camRight   : vec3<f32>,
  camUp      : vec3<f32>,
  camForward : vec3<f32>,
  lightDir   : vec3<f32>,
  ambient    : f32,
  diffuse    : f32,
  specular   : f32,
  outlineOn  : u32,
  bg         : vec4<f32>,
};`;

/** The 3D sphere-impostor module. VS pulls x/y/z/radius from agentF32, unpacks the
 *  RGBA from agentColors, and expands a camera-facing billboard quad; FS ray-casts
 *  the unit sphere, discards on miss/dead/alpha-0, writes frag_depth, and shades
 *  with the SAME formula gl3d's SPHERE_FS uses (ambient + diffuse·n·L + Blinn-Phong
 *  specular; shadows/AO not replicated — frame mode covers those). Opaque output
 *  (alpha-blend is gated off), premultiplied for the canvas. */
function agentRenderSphereWGSL(layout: AgentWebGPULayout): string {
  const xB = layout.f32Base['x']!, yB = layout.f32Base['y']!, rB = layout.f32Base['radius']!;
  // A 3D layout always carries a z field base (AGENT_GPU_F32_FIELDS_3D); fall back
  // to x's base defensively (never hit — the gate requires is3D).
  const zB = layout.f32Base['z'] ?? xB;
  const at = (base: number): string => (base === 0 ? 'agent' : `${base}u + agent`);
  return `${RENDER_VIEW_3D_WGSL}
@group(0) @binding(0) var<storage, read> agentF32    : array<f32>;
@group(0) @binding(1) var<storage, read> agentAlive  : array<u32>;
@group(0) @binding(2) var<storage, read> agentColors : array<u32>;
@group(0) @binding(3) var<uniform>       rv          : RenderView3D;

struct VSOut {
  @builtin(position) pos    : vec4<f32>,
  @location(0)       uv     : vec2<f32>,
  @location(1)       col    : vec4<f32>,
  @location(2)       centre : vec3<f32>,
  @location(3)       radius : f32,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  var out: VSOut;
  let agent: u32 = inst;   // 3D: no infinity tiling — one instance per agent.
  let packed: u32 = agentColors[agent];
  let a: f32 = f32((packed >> 24u) & 0xffu) / 255.0;
  if (agentAlive[agent] == 0u || a <= 0.0) {
    out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.uv = vec2<f32>(0.0, 0.0);
    out.col = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    out.centre = vec3<f32>(0.0, 0.0, 0.0);
    out.radius = 0.0;
    return out;
  }
  var corner: vec2<f32> = vec2<f32>(-1.0, -1.0);
  if (vi == 1u) { corner = vec2<f32>(1.0, -1.0); }
  else if (vi == 2u) { corner = vec2<f32>(-1.0, 1.0); }
  else if (vi == 3u) { corner = vec2<f32>(1.0, 1.0); }
  let ax: f32 = agentF32[${at(xB)}];
  let ay: f32 = agentF32[${at(yB)}];
  let az: f32 = agentF32[${at(zB)}];
  let ar: f32 = agentF32[${at(rB)}];
  // Z-up remap (matches gl3d SPHERE_VS): centre = (ax-half.x, half.y-ay, half.z-az).
  let centre: vec3<f32> = vec3<f32>(ax - rv.half.x, rv.half.y - ay, rv.half.z - az);
  let world: vec3<f32> = centre + (rv.camRight * corner.x + rv.camUp * corner.y) * ar;
  out.pos = rv.mvp * vec4<f32>(world, 1.0);
  out.uv = corner;
  out.col = vec4<f32>(f32(packed & 0xffu) / 255.0, f32((packed >> 8u) & 0xffu) / 255.0, f32((packed >> 16u) & 0xffu) / 255.0, a);
  out.centre = centre;
  out.radius = ar;
  return out;
}

struct FSOut {
  @location(0)          color : vec4<f32>,
  @builtin(frag_depth)  depth : f32,
};

@fragment
fn fsMain(in: VSOut) -> FSOut {
  var out: FSOut;
  let r2: f32 = dot(in.uv, in.uv);
  if (r2 > 1.0) { discard; }
  let zc: f32 = sqrt(1.0 - r2);                       // height above the billboard plane
  let n: vec3<f32> = normalize(rv.camRight * in.uv.x + rv.camUp * in.uv.y - rv.camForward * zc);
  let surf: vec3<f32> = in.centre + n * in.radius;    // world surface point
  let clip: vec4<f32> = rv.mvp * vec4<f32>(surf, 1.0);
  out.depth = (clip.z / clip.w) * 0.5 + 0.5;          // depth-interleave impostors
  // Lighting-controls shade (view dir = -camForward). Shadows/AO not replicated.
  let ndl: f32 = max(0.0, dot(n, rv.lightDir));
  var col: vec3<f32> = in.col.rgb * (rv.ambient + rv.diffuse * ndl);
  if (rv.specular > 0.0) {
    let H: vec3<f32> = normalize(rv.lightDir - rv.camForward);
    col = col + rv.specular * pow(max(0.0, dot(n, H)), 32.0);
  }
  if (rv.outlineOn != 0u) {
    // Silhouette rim — the 3D analogue of the 2D disc contour (match gl3d SPHERE_FS).
    let rr: f32 = sqrt(r2);
    let pxw: f32 = fwidth(rr);
    let band: f32 = min(1.5 * pxw, 0.25);
    let rim: f32 = smoothstep(1.0 - band - pxw, 1.0 - band + pxw, rr);
    col = col * (1.0 - 0.4 * rim);
  }
  // Opaque (alpha-blend gated off) → force alpha 1 so the sphere composites over the
  // page/overlays; premultiplied == straight at alpha 1.
  out.color = vec4<f32>(col, 1.0);
  return out;
}`;
}

/** Ensure the depth texture matches the canvas size (recreated on resize). */
function ensureAgentDepthTex(rt: AgentRenderSurface, w: number, h: number): GPUTextureView {
  if (!rt.renderDepthTex || rt.renderDepthW !== w || rt.renderDepthH !== h) {
    if (rt.renderDepthTex) { try { rt.renderDepthTex.destroy(); } catch { /* non-fatal */ } }
    rt.renderDepthTex = rt.device.createTexture({
      label: 'agent-render-depth', size: { width: Math.max(1, w), height: Math.max(1, h) },
      format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    rt.renderDepthW = w; rt.renderDepthH = h;
  }
  return rt.renderDepthTex.createView();
}

/** Write the 3D camera/lighting uniform (176 bytes, mirrors RENDER_VIEW_3D_WGSL). */
export function uploadAgentRenderView3D(rt: AgentRenderSurface, v: AgentRenderView3D): void {
  if (!rt.renderView3DBuf) return;
  const ab = new ArrayBuffer(RENDER_VIEW_3D_BYTES);
  const f = new Float32Array(ab), u = new Uint32Array(ab);
  for (let i = 0; i < 16; i++) f[i] = v.mvp[i] ?? 0;      // mvp 0..63
  f[16] = v.halfX; f[17] = v.halfY; f[18] = v.halfZ;      // half @64
  f[20] = v.camRightX; f[21] = v.camRightY; f[22] = v.camRightZ;   // @80
  f[24] = v.camUpX; f[25] = v.camUpY; f[26] = v.camUpZ;            // @96
  f[28] = v.camForwardX; f[29] = v.camForwardY; f[30] = v.camForwardZ; // @112
  f[32] = v.lightX; f[33] = v.lightY; f[34] = v.lightZ;   // lightDir @128
  f[35] = v.ambient; f[36] = v.diffuse; f[37] = v.specular; // @140,144,148
  u[38] = v.outlineOn >>> 0;                               // outlineOn @152
  f[40] = v.bgR; f[41] = v.bgG; f[42] = v.bgB; f[43] = v.bgA; // bg @160
  rt.device.queue.writeBuffer(rt.renderView3DBuf, 0, ab);
  const a = v.bgA;
  rt.renderClear = [v.bgR * a, v.bgG * a, v.bgB * a, a];
}

/** Set up direct render on the transferred OffscreenCanvas. Clones the grid's
 *  setupDirectRender shape (rgba8unorm, premultiplied). Non-fatal on failure
 *  (returns false → the worker keeps the CPU snapshot path). */
export async function setupAgentDirectRender(rt: AgentRenderSurface, canvas: OffscreenCanvas): Promise<boolean> {
  // Phase C: a 3D layout renders spheres with a depth attachment; a 2D layout
  // renders discs (the A1/A2 path). Mutually exclusive per surface (dimension is
  // baked into the layout), so branch here.
  if ((rt.layout.gridDepth ?? 1) > 1) return setupAgentSphereRender(rt, canvas);
  return setupAgentDiscRender(rt, canvas);
}

/** Phase C — the 3D sphere pipeline (opaque, depth-tested). */
async function setupAgentSphereRender(rt: AgentRenderSurface, canvas: OffscreenCanvas): Promise<boolean> {
  try {
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) return false;
    const format: GPUTextureFormat = 'rgba8unorm';
    ctx.configure({ device: rt.device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT, alphaMode: 'premultiplied' });
    const module = rt.device.createShaderModule({ code: agentRenderSphereWGSL(rt.layout) });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter(m => m.type === 'error');
    if (errs.length > 0) {
      // eslint-disable-next-line no-console
      console.error('[agents/webgpu] sphere WGSL compile errors:\n' + errs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
      return false;
    }
    const bgl = rt.device.createBindGroupLayout({
      label: 'agent-sphere-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const pl = rt.device.createPipelineLayout({ label: 'agent-sphere-pl', bindGroupLayouts: [bgl] });
    const pipeline = rt.device.createRenderPipeline({
      label: 'agent-sphere', layout: pl,
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format }] },   // opaque (no blend)
      primitive: { topology: 'triangle-strip' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const renderView3DBuf = rt.device.createBuffer({ label: 'agent-render-view-3d', size: RENDER_VIEW_3D_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const renderBindGroup = rt.device.createBindGroup({
      label: 'agent-sphere-bg', layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: rt.agentF32Buf } },
        { binding: 1, resource: { buffer: rt.agentAliveBuf } },
        { binding: 2, resource: { buffer: rt.agentColorsBuf } },
        { binding: 3, resource: { buffer: renderView3DBuf } },
      ],
    });
    rt.renderCanvas = canvas;
    rt.renderCtx = ctx;
    rt.render3D = true;
    // Audit L5 (3D sibling): a re-attach rebuilds on the SAME surface — release the
    // previous view uniform rather than orphaning it.
    if (rt.renderView3DBuf) { try { rt.renderView3DBuf.destroy(); } catch { /* non-fatal */ } }
    rt.renderView3DBuf = renderView3DBuf;
    rt.renderSpherePipeline = pipeline;
    rt.renderSphereBindGroup = renderBindGroup;
    rt.renderActive = true;
    rt.renderClear = [0, 0, 0, 0];
    return true;
  } catch {
    rt.renderActive = false;
    return false;
  }
}

/** Build the 2D disc render pipelines + bind group + view uniform on `rt` (the
 *  canvas must already be configured). Shared by the standalone disc render
 *  (setupAgentDiscRender) and the E2 composite (setupAgentCompositeRender), so
 *  the two paths can't drift on the disc pass. Returns false on a WGSL error. */
async function buildAgentDiscPipelines(rt: AgentRenderSurface): Promise<boolean> {
  const format: GPUTextureFormat = 'rgba8unorm';
  const module = rt.device.createShaderModule({ code: agentRenderWGSL(rt.layout) });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter(m => m.type === 'error');
  if (errs.length > 0) {
    // eslint-disable-next-line no-console
    console.error('[agents/webgpu] render WGSL compile errors:\n' + errs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
    return false;
  }
  const bgl = rt.device.createBindGroupLayout({
    label: 'agent-render-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const pl = rt.device.createPipelineLayout({ label: 'agent-render-pl', bindGroupLayouts: [bgl] });
  const mkPipe = (label: string, blend: GPUBlendState): GPURenderPipeline => rt.device.createRenderPipeline({
    label, layout: pl,
    vertex: { module, entryPoint: 'vsMain' },
    fragment: { module, entryPoint: 'fsMain', targets: [{ format, blend }] },
    primitive: { topology: 'triangle-strip' },
  });
  const plainBlend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const glowBlend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  };
  const renderViewBuf = rt.device.createBuffer({ label: 'agent-render-view', size: RENDER_VIEW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  // Audit L5: a re-attach (every real display-size change) rebuilds the pipelines
  // on the SAME surface — release the previous view uniform instead of orphaning it.
  if (rt.renderViewBuf) { try { rt.renderViewBuf.destroy(); } catch { /* non-fatal */ } }
  rt.renderViewBuf = renderViewBuf;
  rt.renderPlainPipeline = mkPipe('agent-render-plain', plainBlend);
  rt.renderGlowPipeline = mkPipe('agent-render-glow', glowBlend);
  rt.renderBindGroup = rt.device.createBindGroup({
    label: 'agent-render-bg', layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: rt.agentF32Buf } },
      { binding: 1, resource: { buffer: rt.agentAliveBuf } },
      { binding: 2, resource: { buffer: rt.agentColorsBuf } },
      { binding: 3, resource: { buffer: renderViewBuf } },
    ],
  });
  return true;
}

async function setupAgentDiscRender(rt: AgentRenderSurface, canvas: OffscreenCanvas): Promise<boolean> {
  try {
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) return false;
    const format: GPUTextureFormat = 'rgba8unorm';
    ctx.configure({ device: rt.device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT, alphaMode: 'premultiplied' });
    if (!(await buildAgentDiscPipelines(rt))) return false;
    rt.renderCanvas = canvas;
    rt.renderCtx = ctx;
    rt.renderActive = true;
    rt.renderComposite = false;
    rt.renderClear = [0, 0, 0, 0];
    rt.renderGlow = false;
    return true;
  } catch {
    rt.renderActive = false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// E2 — single-canvas composite: grid layer + agent discs on ONE DISPLAY-sized
// canvas in ONE encoder, at DISPLAY resolution through the camera. The grid layer
// is a fullscreen-triangle render pass whose FRAGMENT shader INVERTS the camera —
// display pixel → world coord → cell (col=floor(wx), row=floor(wy)) → the grid
// runtime's `colorsBuf` (row-major RGBA8 u32/cell) with NEAREST semantics (integer
// floor = hard cell edges = the crisp CA-block look). It is DISPLAY-PIXEL-BOUND
// (one cell lookup per covered display pixel), NOT cell-count-bound — a 5000² field
// costs the same to present as a 300² one (the single sampled plane is the
// efficient realization of "a plane of cells"; do NOT render W×H instanced quads).
// The agent disc pass loads over it (loadOp:'load') using the SAME display-res
// camera as the A1 render (scalePx=zoom·baseScale, ox/oy=pan), so agents stay CRISP
// discs at any zoom — the fix for the world-res "blob of cells" the first E2 hit.
// The canvas stays RENDER_ATTACHMENT-only (a render pass, not compute-present, so no
// STORAGE_BINDING divergence). The main thread blits the display-sized canvas 1:1.
// ---------------------------------------------------------------------------

/** The grid-plane camera uniform for the composite grid layer (32 B, all scalars —
 *  no vec3 padding trap). Mirrors `GRID_PLANE_VIEW_WGSL` below AND
 *  `writeGridPlaneView`. `torus` selects wrap (infinity) vs bounds-discard. */
const GRID_PLANE_VIEW_BYTES = 32;
function writeGridPlaneView(gridW: number, gridH: number, torus: boolean, scalePx: number, oxPx: number, oyPx: number): ArrayBuffer {
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

const GRID_PLANE_VIEW_WGSL = `struct GridPlaneView {
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
 *  (packed RGBA8 u32/cell, row-major) — the grid layer of the composite, premultiplied. */
const GRID_PRESENT_WGSL = `${GRID_PLANE_VIEW_WGSL}
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

/** Set up the composite render surface: configure the DISPLAY-sized canvas
 *  (RENDER_ATTACHMENT), build the disc pipelines AND the grid-present pipeline.
 *  Non-fatal on failure (returns false → the worker keeps the two-canvas path).
 *  The grid `colorsBuf` is passed per-present (it can be rebuilt on recompile),
 *  so only the pipeline/BGL/uniform are stored here. */
export async function setupAgentCompositeRender(rt: AgentRenderSurface, canvas: OffscreenCanvas): Promise<boolean> {
  try {
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!ctx) return false;
    const format: GPUTextureFormat = 'rgba8unorm';
    // COPY_SRC so a DEV probe can read composited pixels back (occlusion-safe
    // verification); harmless in production.
    ctx.configure({ device: rt.device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, alphaMode: 'premultiplied' });
    if (!(await buildAgentDiscPipelines(rt))) return false;
    const gmod = rt.device.createShaderModule({ code: GRID_PRESENT_WGSL });
    const ginfo = await gmod.getCompilationInfo();
    const gerrs = ginfo.messages.filter(m => m.type === 'error');
    if (gerrs.length > 0) {
      // eslint-disable-next-line no-console
      console.error('[agents/webgpu] grid-present WGSL compile errors:\n' + gerrs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
      return false;
    }
    const gbgl = rt.device.createBindGroupLayout({
      label: 'grid-present-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const gpl = rt.device.createPipelineLayout({ label: 'grid-present-pl', bindGroupLayouts: [gbgl] });
    rt.gridPresentPipeline = rt.device.createRenderPipeline({
      label: 'grid-present', layout: gpl,
      vertex: { module: gmod, entryPoint: 'vsMain' },
      fragment: { module: gmod, entryPoint: 'fsMain', targets: [{ format }] },   // opaque write (loadOp clear)
      primitive: { topology: 'triangle-list' },
    });
    rt.gridPresentBGL = gbgl;
    rt.gridPresentUniform = rt.device.createBuffer({ label: 'grid-plane-view', size: GRID_PLANE_VIEW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    rt.renderCanvas = canvas;
    rt.renderCtx = ctx;
    rt.renderActive = true;
    rt.renderComposite = true;
    rt.renderClear = [0, 0, 0, 0];
    rt.renderGlow = false;
    return true;
  } catch {
    rt.renderActive = false;
    rt.renderComposite = false;
    return false;
  }
}

/** Encode the composite present into `enc`: grid-present pass (fullscreen triangle
 *  whose FS inverts the DISPLAY-res camera to a cell, loadOp clear) then the agent
 *  disc pass (loadOp load, same display-res camera). `gridColorsBuf` is the LIVE
 *  grid runtime `colorsBuf` (passed per-present so a recompile-rebuilt buffer is
 *  always current); `scalePx`/`oxPx`/`oyPx`/`torus` are the SAME camera the disc
 *  pass reads from `renderViewBuf` — so grid and agents can't disagree on the
 *  transform. No-op unless composite is active. */
export function presentCompositeEncode(rt: AgentRenderSurface, enc: GPUCommandEncoder, gridColorsBuf: GPUBuffer, gridW: number, gridH: number, hw: number, showGrid: boolean, showAgents: boolean, scalePx: number, oxPx: number, oyPx: number, torus: boolean): void {
  if (!rt.renderActive || !rt.renderComposite || !rt.renderCtx) return;
  if (!rt.renderBindGroup || !rt.renderViewBuf || !rt.gridPresentPipeline || !rt.gridPresentBGL || !rt.gridPresentUniform) return;
  // Keep the uniform's highWater == the draw's instance decomposition base.
  rt.device.queue.writeBuffer(rt.renderViewBuf, 0, new Uint32Array([Math.max(1, hw) >>> 0]).buffer);
  const tex = rt.renderCtx.getCurrentTexture();
  const view = tex.createView();
  if (showGrid) {
    // Pass 1 — grid layer (fullscreen triangle), clears to transparent then writes.
    // The FS inverts (scalePx, oxPx, oyPx) → world → cell, sampling colorsBuf NEAREST.
    rt.device.queue.writeBuffer(rt.gridPresentUniform, 0, writeGridPlaneView(gridW, gridH, torus, scalePx, oxPx, oyPx));
    const gbind = rt.device.createBindGroup({
      label: 'grid-present-bg', layout: rt.gridPresentBGL,
      entries: [
        { binding: 0, resource: { buffer: gridColorsBuf } },
        { binding: 1, resource: { buffer: rt.gridPresentUniform } },
      ],
    });
    const gp = enc.beginRenderPass({
      label: 'grid-present-pass',
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    gp.setPipeline(rt.gridPresentPipeline); gp.setBindGroup(0, gbind); gp.draw(3); gp.end();
  }
  // Pass 2 — agent discs (+ the grid-hidden background clear). Runs when agents
  // show, OR (grid hidden) to clear the canvas to the agent background. When the
  // grid shows, LOAD over it; when hidden, CLEAR to bg2d (premultiplied in
  // renderClear) so agents sit on a solid backdrop.
  if (showAgents || !showGrid) {
    const [cr, cg, cb, ca] = rt.renderClear ?? [0, 0, 0, 0];
    const ap = enc.beginRenderPass({
      label: 'agent-composite-pass',
      colorAttachments: [{ view, loadOp: showGrid ? 'load' : 'clear', storeOp: 'store', clearValue: { r: cr, g: cg, b: cb, a: ca } }],
    });
    if (showAgents) {
      ap.setPipeline(rt.renderGlow ? rt.renderGlowPipeline! : rt.renderPlainPipeline!);
      ap.setBindGroup(0, rt.renderBindGroup);
      const copies = Math.max(1, rt.renderCopiesX ?? 1) * Math.max(1, rt.renderCopiesY ?? 1);
      ap.draw(4, Math.max(1, hw) * copies);
    }
    ap.end();
  }
}

/** Sync the render buffers from the CPU store (tight fields + colours) and
 *  present the composite (grid + agents) in one encoder+submit. Used by every
 *  composite present point (batch tail, camera, mutation). `showGrid`/`showAgents`
 *  gate the per-layer passes (Layers panel). */
export function presentAgentCompositeFromStore(rt: AgentRenderSurface, gridColorsBuf: GPUBuffer, gridW: number, gridH: number, s: AgentStore, showGrid: boolean, showAgents: boolean, scalePx: number, oxPx: number, oyPx: number, torus: boolean): void {
  if (!rt.renderActive || !rt.renderComposite) return;
  uploadAgentRenderFields(rt, s);
  const enc = rt.device.createCommandEncoder({ label: 'agent-composite-present' });
  presentCompositeEncode(rt, enc, gridColorsBuf, gridW, gridH, s.highWater, showGrid, showAgents, scalePx, oxPx, oyPx, torus);
  rt.device.queue.submit([enc.finish()]);
}

/** DEV/verification only: present the composite, then copy the whole canvas
 *  texture into a readback buffer and return the RGBA bytes at the given DISPLAY-
 *  pixel sample points (px,py in canvas/display coords). Occlusion-safe proof that
 *  BOTH layers land on ONE texture (grid pixel under a disc, disc pixel).
 *  Returns null if the surface isn't a composite. */
export async function debugReadCompositePixels(rt: AgentRenderSurface, gridColorsBuf: GPUBuffer, gridW: number, gridH: number, s: AgentStore, showGrid: boolean, showAgents: boolean, scalePx: number, oxPx: number, oyPx: number, torus: boolean, points: Array<[number, number]>): Promise<Array<[number, number, number, number]> | null> {
  if (!rt.renderActive || !rt.renderComposite || !rt.renderCtx) return null;
  uploadAgentRenderFields(rt, s);
  const enc = rt.device.createCommandEncoder({ label: 'agent-composite-dev-readback' });
  presentCompositeEncode(rt, enc, gridColorsBuf, gridW, gridH, s.highWater, showGrid, showAgents, scalePx, oxPx, oyPx, torus);
  const tex = rt.renderCtx.getCurrentTexture();
  const W = tex.width, H = tex.height;
  const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
  const rb = rt.device.createBuffer({ label: 'composite-readback', size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyTextureToBuffer({ texture: tex }, { buffer: rb, bytesPerRow, rowsPerImage: H }, { width: W, height: H, depthOrArrayLayers: 1 });
  rt.device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(rb.getMappedRange().slice(0));
  rb.unmap(); rb.destroy();
  const out: Array<[number, number, number, number]> = [];
  for (const [px, py] of points) {
    const x = Math.min(W - 1, Math.max(0, px | 0)), y = Math.min(H - 1, Math.max(0, py | 0));
    const o = y * bytesPerRow + x * 4;
    out.push([data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!]);
  }
  return out;
}

/** Pack the CPU store's per-agent RGBA (s.colors) into the GPU agentColors buffer
 *  (r|g<<8|b<<16|a<<24) — the SAME pack the behaviour shader / readbackAgentStep use.
 *  Needed so a MUTATION-driven present (seed/edit) shows the CPU-computed colours
 *  (the GPU behaviour shader hasn't re-run since). */
export function uploadAgentColors(rt: AgentRenderSurface, s: AgentStore): void {
  const ma = rt.layout.maxAgents, hw = s.highWater;
  // Persistent scratch (audit M5) — a fresh allocation here ran on the per-frame
  // path. Slots past highWater are zeroed explicitly (a fresh array was
  // zero-filled by construction; agents beyond hw must stay transparent).
  const u = rt.renderColorScratch && rt.renderColorScratch.length === ma
    ? rt.renderColorScratch
    : (rt.renderColorScratch = new Uint32Array(ma));
  const c = s.colors;
  for (let i = 0; i < hw; i++) {
    const ci = i * 4;
    u[i] = ((c[ci]! & 0xff) | ((c[ci + 1]! & 0xff) << 8) | ((c[ci + 2]! & 0xff) << 16) | ((c[ci + 3]! & 0xff) << 24)) >>> 0;
  }
  if (hw < ma) u.fill(0, hw, ma);
  rt.device.queue.writeBuffer(rt.agentColorsBuf, 0, u.buffer, u.byteOffset, u.byteLength);
}

/** Write the RenderView uniform + stash the clear colour / glow selection. */
export function uploadAgentRenderView(rt: AgentRenderSurface, v: AgentRenderView): void {
  if (!rt.renderViewBuf) return;
  const ab = new ArrayBuffer(RENDER_VIEW_BYTES);
  const u = new Uint32Array(ab), fl = new Float32Array(ab), i = new Int32Array(ab);
  u[0] = v.highWater >>> 0;
  fl[1] = v.scalePx; fl[2] = v.oxPx; fl[3] = v.oyPx;
  fl[4] = v.canvasW; fl[5] = v.canvasH;
  fl[6] = v.worldW; fl[7] = v.worldH;
  i[8] = v.copiesX | 0; i[9] = v.copiesY | 0; i[10] = v.startX | 0; i[11] = v.startY | 0;
  u[12] = v.outlineOn >>> 0; u[13] = v.glowOn >>> 0;
  fl[14] = v.glowSize; fl[15] = v.glowIntensity; fl[16] = v.glowSteepness;
  fl[17] = v.bgR; fl[18] = v.bgG; fl[19] = v.bgB; fl[20] = v.bgA;
  rt.device.queue.writeBuffer(rt.renderViewBuf, 0, ab);
  // Clear colour is applied CPU-side (loadOp clear); store premultiplied so the
  // premultiplied canvas composites the background correctly.
  const a = v.bgA;
  rt.renderClear = [v.bgR * a, v.bgG * a, v.bgB * a, a];
  rt.renderGlow = v.glowOn !== 0;
  rt.renderCopiesX = Math.max(1, v.copiesX | 0);
  rt.renderCopiesY = Math.max(1, v.copiesY | 0);
}

/** Append the agent render pass (instanced disc quads) to an existing encoder.
 *  Draws `hw × copiesX × copiesY` instances. No-op when render isn't active. */
export function presentAgentsEncode(rt: AgentRenderSurface, enc: GPUCommandEncoder, hw: number): void {
  if (!rt.renderActive || !rt.renderCtx) return;
  // Audit L3 — NEVER run the disc-only pass on a COMPOSITE surface: its canvas
  // carries the grid layer too, and this pass clears (loadOp:'clear') before
  // drawing only the discs, so it would wipe the grid. The composite has its own
  // encoder path (presentCompositeEncode) which needs the grid colours buffer +
  // dims this function does not receive. The E2 composite is disabled today, but
  // dispatchResidentBatch appends this pass unconditionally — so this guard is
  // what keeps a future E2 revival from silently blanking the grid under residency.
  if (rt.renderComposite) return;
  // Phase C: a 3D surface draws sphere impostors with a depth attachment (one
  // instance per agent, no infinity tiling); a 2D surface draws the disc quads.
  if (rt.render3D) { presentAgentSpheresEncode(rt, enc, hw); return; }
  if (!rt.renderBindGroup || !rt.renderViewBuf) return;
  // Keep the uniform's highWater == the draw's instance decomposition base. The
  // camera message can't know the live highWater (free mode ships no snapshot),
  // so patch it here from the value the caller passes (cheap 4-byte write, queued
  // before this encoder's submit reads it).
  rt.device.queue.writeBuffer(rt.renderViewBuf, 0, new Uint32Array([Math.max(1, hw) >>> 0]).buffer);
  const view = rt.renderCtx.getCurrentTexture().createView();
  const [cr, cg, cb, ca] = rt.renderClear ?? [0, 0, 0, 0];
  const pass = enc.beginRenderPass({
    label: 'agent-present',
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: cr, g: cg, b: cb, a: ca } }],
  });
  pass.setPipeline(rt.renderGlow ? rt.renderGlowPipeline! : rt.renderPlainPipeline!);
  pass.setBindGroup(0, rt.renderBindGroup);
  const copies = Math.max(1, rt.renderCopiesX ?? 1) * Math.max(1, rt.renderCopiesY ?? 1);
  pass.draw(4, Math.max(1, hw) * copies);
  pass.end();
}

/** Phase C: append the 3D sphere-impostor pass — one instance per agent (no
 *  infinity tiling), opaque, with a depth attachment so spheres depth-sort. */
function presentAgentSpheresEncode(rt: AgentRenderSurface, enc: GPUCommandEncoder, hw: number): void {
  if (!rt.renderCtx || !rt.renderSpherePipeline || !rt.renderSphereBindGroup) return;
  const tex = rt.renderCtx.getCurrentTexture();
  const view = tex.createView();
  const depthView = ensureAgentDepthTex(rt, tex.width, tex.height);
  const [cr, cg, cb, ca] = rt.renderClear ?? [0, 0, 0, 0];
  const pass = enc.beginRenderPass({
    label: 'agent-sphere-present',
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: cr, g: cg, b: cb, a: ca } }],
    depthStencilAttachment: { view: depthView, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  pass.setPipeline(rt.renderSpherePipeline);
  pass.setBindGroup(0, rt.renderSphereBindGroup);
  pass.draw(4, Math.max(1, hw));   // 4 verts (triangle-strip quad) × hw agents
  pass.end();
}

/** Present one frame (own encoder + submit) — for camera changes / mutation
 *  refresh / attach / tab-refocus. */
export function presentAgentsOnce(rt: AgentRenderSurface, hw: number): void {
  if (!rt.renderActive || !rt.renderCtx) return;
  const enc = rt.device.createCommandEncoder({ label: 'agent-present-once' });
  presentAgentsEncode(rt, enc, hw);
  rt.device.queue.submit([enc.finish()]);
}

/** Sync the GPU render buffers from the CPU store (positions + colours) and
 *  present. Used wherever the CPU store is authoritative (per-gen batch tail,
 *  mutations, load/reset) — NOT the resident batch (GPU-authoritative, presents
 *  inside its own submit). */
export function presentAgentsFromStore(rt: AgentWebGPURuntime, s: AgentStore): void {
  if (!rt.renderActive) return;
  uploadAgentSoA(rt, s);
  uploadAgentColors(rt, s);
  presentAgentsOnce(rt, s.highWater);
}

// ---------------------------------------------------------------------------
// A2 — render-ONLY runtime for CPU (JS / WASM) targets.
//
// A CPU-target model has no agent WebGPU runtime (no compute pipelines). To move
// the ~10 ms Canvas2D agent draw onto the GPU, the worker builds this lightweight
// surface — a device + the three render buffers (agentF32 / agentAlive /
// agentColors) — and uploads the CPU store's positions/colours each frame, then
// presents via the SAME AGENT_RENDER_WGSL pipeline (built by setupAgentDirectRender
// on attach). The sim keeps running on the CPU; only the DRAW moves to the GPU.
// ---------------------------------------------------------------------------

/** Build a render-only agent surface (device + the three render buffers sized to
 *  `layout`, NO compute pipelines). setupAgentDirectRender builds the render
 *  pipeline on it later (on canvas attach). Returns null when WebGPU is
 *  unavailable / device acquisition fails (the worker keeps the CPU overlay path). */
export async function createAgentRenderOnlyRuntime(layout: AgentWebGPULayout): Promise<AgentRenderSurface | null> {
  if (!isWebGPUAvailable()) return null;
  // E1: the render-only surface takes the shared device too (this closes the
  // C-report leak: a re-attach used to request a fresh device without releasing
  // the prior one). Released by destroyAgentRenderSurface.
  const sd = await acquireSharedGpuDevice();
  if (!sd) return null;
  const device = sd.device;
  try {
    const ma = layout.maxAgents;
    const mk = (label: string, bytes: number): GPUBuffer =>
      device.createBuffer({ label, size: Math.max(4, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    return {
      device, layout,
      agentF32Buf: mk('agent-render-f32', layout.f32Len * 4),
      agentAliveBuf: mk('agent-render-alive', ma * 4),
      agentColorsBuf: mk('agent-render-colors', ma * 4),
      renderActive: false,
      renderF32Scratch: new Float32Array(ma),
      renderAliveScratch: new Uint32Array(ma),
    };
  } catch {
    releaseSharedGpuDevice(device);
    return null;
  }
}

/** A2 tight upload: write ONLY x/y/radius (+ alive + colours) from the CPU store
 *  into the render buffers — exactly the fields AGENT_RENDER_WGSL reads. Reuses
 *  the surface's persistent scratch (no per-frame allocation). Dead / beyond-hw
 *  slots are culled by the alive mask (written 0 past hw), so the other runs need
 *  no zeroing. ≈ 1 MB of writeBuffer at 50k agents (≪ the readback we'd skip). */
export function uploadAgentRenderFields(rt: AgentRenderSurface, s: AgentStore): void {
  const L = rt.layout, ma = L.maxAgents, hw = Math.min(s.highWater, ma);
  const scratch = rt.renderF32Scratch ?? (rt.renderF32Scratch = new Float32Array(ma));
  const write = (base: number, src: ArrayLike<number>): void => {
    for (let i = 0; i < hw; i++) scratch[i] = src[i]!;
    // writeBuffer copies the source synchronously, so the scratch is reusable
    // across the three field writes.
    rt.device.queue.writeBuffer(rt.agentF32Buf, base * 4, scratch.buffer, 0, hw * 4);
  };
  if (hw > 0) {
    write(L.f32Base['x']!, s.x);
    write(L.f32Base['y']!, s.y);
    write(L.f32Base['radius']!, s.radius);
    // Phase C: a 3D layout carries a z field the sphere pass reads.
    if ((L.gridDepth ?? 1) > 1 && L.f32Base['z'] !== undefined && s.z) write(L.f32Base['z'], s.z);
  }
  const al = rt.renderAliveScratch ?? (rt.renderAliveScratch = new Uint32Array(ma));
  for (let i = 0; i < hw; i++) al[i] = s.alive[i]!;
  for (let i = hw; i < ma; i++) al[i] = 0;
  rt.device.queue.writeBuffer(rt.agentAliveBuf, 0, al.buffer, 0, ma * 4);
  uploadAgentColors(rt, s);
}

/** Sync the render-only surface from the CPU store (tight fields + colours) and
 *  present. The A2 analogue of presentAgentsFromStore (which uploads the FULL SoA
 *  because the webgpu compute step reads it next). */
export function presentAgentRenderFromStore(rt: AgentRenderSurface, s: AgentStore): void {
  if (!rt.renderActive) return;
  uploadAgentRenderFields(rt, s);
  presentAgentsOnce(rt, s.highWater);
}

/** Tear down a render-only surface (its three buffers + render-view uniform +
 *  device). The worker calls this ONLY on render-only surfaces — the full
 *  webgpu runtime is torn down by destroyAgentWebGPURuntime. */
export function destroyAgentRenderSurface(rt: AgentRenderSurface | null): void {
  if (!rt) return;
  rt.renderActive = false;
  rt.renderCtx = null;
  rt.renderComposite = false;
  if (rt.renderDepthTex) { try { rt.renderDepthTex.destroy(); } catch { /* non-fatal */ } rt.renderDepthTex = null; }
  const bufs = [rt.agentF32Buf, rt.agentAliveBuf, rt.agentColorsBuf, rt.renderViewBuf ?? null, rt.renderView3DBuf ?? null, rt.gridPresentUniform ?? null];
  for (const b of bufs) { if (b) try { b.destroy(); } catch { /* non-fatal */ } }
  // E1: release the shared-device reference (was: destroy a per-surface device).
  releaseSharedGpuDevice(rt.device);
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
 *  analogue) and `vx/vy/radius/density/age` are read in place.
 *
 *  G4: ALSO reads back (a) the structural-request runs → the engine's CPU request
 *  arrays (`divideRequest`/`bondFormReq`/`killRequest`/…) so `runAgentStructuralPhase`
 *  applies them CPU-side; (b) the user agent-attribute runs → `s.attrWrite[id]`
 *  (the "next" buffer — the caller swaps it in AFTER this readback); and (c) the
 *  packed `agentColors` → `s.colors` (per-agent RGBA for the render snapshot).
 *
 *  Unified spawning (usesSpawn): ALSO reads the atomic spawnCursor + the alive mask
 *  and reconciles the GPU-allocated newborns in [oldHighWater, cursor) into the CPU
 *  store — committed (alive) ones become live agents, staged-not-committed slots go
 *  to the free-list, and highWater advances. Returns `spawnOverflow` when the cursor
 *  ran past maxAgents (some Create Agent calls were dropped), and `agentStop` — the
 *  1-based Stop Event index the behaviour shader wrote (0 = none), which the worker
 *  merges into the shared stopFlag. */
export async function readbackAgentStep(rt: AgentWebGPURuntime, s: AgentStore): Promise<{ spawnOverflow: boolean; agentStop: number }> {
  const L = rt.layout, hw = s.highWater;
  const f32ByteLen = f32Bytes(L);
  const colByteLen = colorsBytes(L);
  const wantI32 = rt.usesI32Write;
  const i32ByteLen = i32Bytes(L);
  const wantSpawn = rt.usesSpawn && !!rt.spawnCursorBuf;
  const wantStop = rt.usesStop && !!rt.stopFlagBuf;
  const aliveByteLen = aliveBytes(L);
  const pooledF = acquireStaging(rt, f32ByteLen);
  const stagingF = pooledF.buffer;
  const pooledC = acquireStaging(rt, colByteLen);
  const stagingC = pooledC.buffer;
  const pooledI = wantI32 ? acquireStaging(rt, i32ByteLen) : null;
  const pooledAlive = wantSpawn ? acquireStaging(rt, aliveByteLen) : null;
  const pooledCursor = wantSpawn ? acquireStaging(rt, 4) : null;
  const pooledStop = wantStop ? acquireStaging(rt, 4) : null;
  const enc = rt.device.createCommandEncoder({ label: 'agent-readback-enc' });
  enc.copyBufferToBuffer(rt.agentF32Buf, 0, stagingF, 0, f32ByteLen);
  enc.copyBufferToBuffer(rt.agentColorsBuf, 0, stagingC, 0, colByteLen);
  if (pooledI) enc.copyBufferToBuffer(rt.agentI32Buf, 0, pooledI.buffer, 0, i32ByteLen);
  if (pooledAlive) enc.copyBufferToBuffer(rt.agentAliveBuf, 0, pooledAlive.buffer, 0, aliveByteLen);
  if (pooledCursor && rt.spawnCursorBuf) enc.copyBufferToBuffer(rt.spawnCursorBuf, 0, pooledCursor.buffer, 0, 4);
  if (pooledStop && rt.stopFlagBuf) enc.copyBufferToBuffer(rt.stopFlagBuf, 0, pooledStop.buffer, 0, 4);
  rt.device.queue.submit([enc.finish()]);
  await stagingF.mapAsync(GPUMapMode.READ, 0, f32ByteLen);
  await stagingC.mapAsync(GPUMapMode.READ, 0, colByteLen);
  if (pooledI) await pooledI.buffer.mapAsync(GPUMapMode.READ, 0, i32ByteLen);
  if (pooledAlive) await pooledAlive.buffer.mapAsync(GPUMapMode.READ, 0, aliveByteLen);
  if (pooledCursor) await pooledCursor.buffer.mapAsync(GPUMapMode.READ, 0, 4);
  if (pooledStop) await pooledStop.buffer.mapAsync(GPUMapMode.READ, 0, 4);
  const f = new Float32Array(stagingF.getMappedRange(0, f32ByteLen));
  const col = new Uint32Array(stagingC.getMappedRange(0, colByteLen));
  const xB = L.f32Base['xNext']!, yB = L.f32Base['yNext']!;
  const vxB = L.f32Base['vx']!, vyB = L.f32Base['vy']!;
  const radB = L.f32Base['radius']!, denB = L.f32Base['density']!, ageB = L.f32Base['age']!;
  // 3D z fields (present only when gridDepth>1).
  const is3d = L.gridDepth > 1;
  const zB = is3d ? L.f32Base['zNext']! : -1, vzB = is3d ? L.f32Base['vz']! : -1;
  // Structural-request bases (G4) — match AGENT_GPU_REQUEST_FIELDS / the emitters.
  const drB = L.f32Base['divideRequest']!, daxB = L.f32Base['divideAxisX']!, dayB = L.f32Base['divideAxisY']!;
  const dasymB = L.f32Base['divideAsym']!, bfrB = L.f32Base['bondFormReq']!, bflB = L.f32Base['bondFormL']!;
  const bfkB = L.f32Base['bondFormK']!, bbrB = L.f32Base['bondBreakReq']!, krB = L.f32Base['killRequest']!;
  // P4 - queue entries per agent, shared by the GPU runs and the CPU arrays.
  const nq = Math.min(L.bondReqSlots, s.bondReqSlots);
  for (let i = 0; i < hw; i++) {
    if (!s.alive[i]) continue;
    s.x[i] = f[xB + i]!; s.y[i] = f[yB + i]!;
    s.xNext[i] = f[xB + i]!; s.yNext[i] = f[yB + i]!;
    s.vx[i] = f[vxB + i]!; s.vy[i] = f[vyB + i]!;
    if (is3d) { s.z[i] = f[zB + i]!; s.zNext[i] = f[zB + i]!; s.vz[i] = f[vzB + i]!; }
    s.radius[i] = f[radB + i]!;
    s.density[i] = f[denB + i]!;
    s.age[i] = f[ageB + i]!;
    // Structural requests — round flags to ints (the engine arrays are Uint8/Int32).
    // P5: `divideRequest` is no longer a bare 0/1 flag — it carries the 1-based
    // DIVISION PARTITION code (the index into the compiler's partition table + 1),
    // so it must be ROUNDED, not clamped to 1. `Math.min(255, …)` matters because
    // the CPU array is a Uint8Array: an out-of-range value would wrap modulo 256
    // and could alias a DIFFERENT partition spec instead of degrading to none.
    {
      const dr = f[drB + i]!;
      s.divideRequest[i] = dr >= 0.5 ? Math.min(255, Math.round(dr)) : 0;
    }
    s.divideAxisX[i] = f[daxB + i]!; s.divideAxisY[i] = f[dayB + i]!;
    s.divideAsym[i] = f[dasymB + i]!;
    // P4 - the STRUCTURAL REQUEST QUEUE: copy the agent's WHOLE entry block, not
    // just entry 0. Both sides are agent-major with the same stride (each derived
    // from `bondReqSlotsForModel`), so this is a straight elementwise copy; `nq`
    // is min'd purely as a bounds guard.
    {
      const cb = i * s.bondReqSlots, gb = i * L.bondReqSlots;
      for (let c = 0; c < nq; c++) {
        s.bondFormReq[cb + c] = Math.round(f[bfrB + gb + c]!);
        s.bondBreakReq[cb + c] = Math.round(f[bbrB + gb + c]!);
        s.bondFormL[cb + c] = f[bflB + gb + c]!;
        s.bondFormK[cb + c] = f[bfkB + gb + c]!;
      }
    }
    s.killRequest[i] = f[krB + i]! >= 0.5 ? 1 : 0;
    // Per-agent packed RGBA → the snapshot colour buffer (s.colors is Uint8 RGBA).
    const c = col[i]! >>> 0, ci = i * 4;
    s.colors[ci] = c & 0xff; s.colors[ci + 1] = (c >>> 8) & 0xff;
    s.colors[ci + 2] = (c >>> 16) & 0xff; s.colors[ci + 3] = (c >>> 24) & 0xff;
  }
  // User AGENT attributes → the WRITE buffer (the caller swaps read↔write after).
  for (const id of L.agentAttrIds) {
    const base = L.agentAttrBase[id]!;
    const dst = s.attrWrite[id] as { [i: number]: number } | undefined;
    if (!dst) continue;
    const isInt = s.attrKind[id] !== 'float64';
    for (let i = 0; i < hw; i++) { if (!s.alive[i]) continue; dst[i] = isInt ? Math.round(f[base + i]!) : f[base + i]!; }
  }
  // P3 — Form Bond's per-BOND-ATTRIBUTE initial-value requests (the sibling of the
  // bondFormL / bondFormK reads above). The structural phase hands these to
  // `formBond`, which stamps BOTH slots (I2). The CPU request cells are f64 and
  // hold the raw value; typing happens where the ragged region is written.
  for (const id of L.bondAttrIds) {
    const base = L.bondFormAttrBase[id];
    const dst = s.bondFormAttrs[id];
    if (base === undefined || !dst) continue;
    for (let i = 0; i < hw; i++) {
      if (!s.alive[i]) continue;
      const cb = i * s.bondReqSlots, gb = i * L.bondReqSlots;
      for (let c = 0; c < nq; c++) dst[cb + c] = f[base + gb + c]!;
    }
  }
  // (No i32 SoA readback: the agent i32 fields — lineage / bondCount — are
  // CPU-owned + uploaded read-only. There is no built-in agent "type" any more,
  // and no behaviour node writes the i32 SoA.)

  // --- Unified spawning: reconcile the GPU-allocated newborns into the CPU store.
  // The behaviour shader bump-allocated slots in [hw, cursor) (createAgent) and
  // marked the committed ones alive (addAgentToWorld). Reconcile them here so the
  // structural phase / snapshot see them as first-class agents from this step
  // (they behave NEXT step — the next dispatch's highWater includes them). This is
  // the GPU analogue of the JS/WASM grow-only `_agentCreate` + leak-sweep. */
  let spawnOverflow = false;
  if (pooledAlive && pooledCursor) {
    const aliveArr = new Uint32Array(pooledAlive.buffer.getMappedRange(0, aliveByteLen));
    const cursorArr = new Uint32Array(pooledCursor.buffer.getMappedRange(0, 4));
    const ma = L.maxAgents;
    const cursor = cursorArr[0]! >>> 0;
    if (cursor > ma) spawnOverflow = true;   // some Create Agent calls got no slot
    const end = Math.min(cursor, ma);
    const x0 = L.f32Base['x']!, y0 = L.f32Base['y']!, z0 = is3d ? L.f32Base['z']! : -1;
    const trB = L.f32Base['targetRadius']!;
    for (let k = hw; k < end; k++) {
      if (aliveArr[k] === 1) {
        // A committed newborn — initialise the CPU slot's identity (initAgentSlot
        // resets attrs→defaults + colour + sprites, the GPU analogue), then overlay
        // the GPU-read attribute values (createAgent defaults + any setter overrides).
        const nx = f[x0 + k]!, ny = f[y0 + k]!, nz = is3d ? f[z0 + k]! : 0, nr = f[radB + k]!;
        initAgentSlot(s, k, nx, ny, nz, nr, k);
        s.alive[k] = 1;
        s.liveCount++;
        s.targetRadius[k] = f[trB + k]!;   // a Set Agent Radius by handle may have changed it
        for (const id of L.agentAttrIds) {
          const base = L.agentAttrBase[id]!;
          const dstR = s.attrRead[id] as { [i: number]: number } | undefined;
          const dstW = s.attrWrite[id] as { [i: number]: number } | undefined;
          if (!dstR) continue;
          const isInt = s.attrKind[id] !== 'float64';
          const v = isInt ? Math.round(f[base + k]!) : f[base + k]!;
          dstR[k] = v; if (dstW) dstW[k] = v;
        }
      } else {
        // Staged (Created) but never Added — a hole. Recycle its slot (bumps epoch,
        // pushes to the free-list) so a later alloc reuses it. Mirrors the JS leak-sweep.
        freeStagedSlot(s, k);
      }
    }
    s.highWater = end;
  }

  let agentStop = 0;
  if (pooledStop) {
    agentStop = new Uint32Array(pooledStop.buffer.getMappedRange(0, 4))[0]! >>> 0;
    pooledStop.buffer.unmap(); pooledStop.inUse = false;
  }
  if (pooledI) { pooledI.buffer.unmap(); pooledI.inUse = false; }
  if (pooledAlive) { pooledAlive.buffer.unmap(); pooledAlive.inUse = false; }
  if (pooledCursor) { pooledCursor.buffer.unmap(); pooledCursor.inUse = false; }
  stagingF.unmap(); stagingC.unmap();
  pooledF.inUse = false; pooledC.inUse = false;
  return { spawnOverflow, agentStop };
}

// ---------------------------------------------------------------------------
// PR7c — GPU residency. For eligible models (no structural mutations / spawn /
// stop / indicators / field bridge / sync attrs / growth / positional collision
// — the worker's agentResidentEligible gate) a WHOLE gens/frame batch runs on
// the GPU in ONE queue submit: per generation clear→count→scan→scatter builds
// the CSR spatial hash ON the GPU, then behaviour + force dispatch, then a tiny
// commit pass folds xNext→x. ZERO per-generation CPU work and ZERO transfers —
// the CPU store is refreshed ONCE per frame by readbackAgentFrame. This is what
// the measured maxAgents-proportional per-gen overhead (~60% of GPU step time
// at 50k) was spent on. Bin ORDER within a hash bin is nondeterministic
// (atomic scatter), so f32 accumulation order varies run-to-run — within the
// documented WebGPU statistical-parity stance.
// ---------------------------------------------------------------------------

/** The hash-build uniform. Field order MIRRORS uploadAgentHashParams. 48 B. */
const HASH_PARAMS_WGSL = `struct HashParams {
  highWater : u32,
  nBinsX    : u32,
  nBinsY    : u32,
  nBinsZ    : u32,
  torus     : u32,
  is3d      : u32,
  binSizeX  : f32,
  binSizeY  : f32,
  binSizeZ  : f32,
  originX   : f32,
  originY   : f32,
  originZ   : f32,
};`;
const HASH_PARAMS_BYTES = 48;

/** The shared WGSL bin index of agent i — MUST mirror the behaviour/force
 *  stencils' bin math (clamped truncation, z-major bin index). */
function emitBinOf(layout: AgentWebGPULayout): string {
  const f32 = (field: string, idxExpr: string): string => {
    const base = layout.f32Base[field]!;
    return base === 0 ? `agentF32[${idxExpr}]` : `agentF32[${base}u + ${idxExpr}]`;
  };
  const is3d = layout.gridDepth > 1;
  return `
fn binOf(i: u32) -> u32 {
  var bx: i32 = i32((${f32('x', 'i')} - hp.originX) / hp.binSizeX);
  bx = clamp(bx, 0, i32(hp.nBinsX) - 1);
  var by: i32 = i32((${f32('y', 'i')} - hp.originY) / hp.binSizeY);
  by = clamp(by, 0, i32(hp.nBinsY) - 1);${is3d ? `
  var bz: i32 = i32((${f32('z', 'i')} - hp.originZ) / hp.binSizeZ);
  bz = clamp(bz, 0, i32(hp.nBinsZ) - 1);
  return u32((bz * i32(hp.nBinsY) + by) * i32(hp.nBinsX) + bx);` : `
  return u32(by * i32(hp.nBinsX) + bx);`}
}`;
}

const RESIDENT_ENTRY = `@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>`;
const RESIDENT_IDX = `  let i: u32 = gid.y * (nwg.x * 64u) + gid.x;`;

function emitHashCountWGSL(layout: AgentWebGPULayout): string {
  return `${HASH_PARAMS_WGSL}
@group(0) @binding(0) var<storage, read>       agentF32   : array<f32>;
@group(0) @binding(1) var<storage, read>       agentAlive : array<u32>;
@group(0) @binding(2) var<storage, read_write> counts     : array<atomic<u32>>;
@group(0) @binding(3) var<uniform>             hp         : HashParams;
${emitBinOf(layout)}
@compute @workgroup_size(64)
fn hashCount(${RESIDENT_ENTRY}) {
${RESIDENT_IDX}
  if (i >= hp.highWater) { return; }
  if (agentAlive[i] == 0u) { return; }
  atomicAdd(&counts[binOf(i)], 1u);
}`;
}

/** Single-workgroup two-level exclusive scan over up to 65536 bins (256 threads
 *  × ≤256-bin chunks) — writes binStart (incl. the trailing total) into the
 *  hashBins CSR buffer at the layout's binStart base, and seeds the scatter
 *  cursors = binStart. */
function emitHashScanWGSL(layout: AgentWebGPULayout): string {
  const bsBase = layout.hashBinStartBase;
  const bsAt = (e: string) => (bsBase === 0 ? `hashBins[${e}]` : `hashBins[${bsBase}u + ${e}]`);
  return `${HASH_PARAMS_WGSL}
@group(0) @binding(0) var<storage, read>       counts   : array<u32>;
@group(0) @binding(1) var<storage, read_write> hashBins : array<i32>;
@group(0) @binding(2) var<storage, read_write> cursor   : array<u32>;
@group(0) @binding(3) var<uniform>             hp       : HashParams;
var<workgroup> partials : array<u32, 256>;
@compute @workgroup_size(256)
fn hashScan(@builtin(local_invocation_id) lid: vec3<u32>) {
  let t: u32 = lid.x;
  let nBins: u32 = hp.nBinsX * hp.nBinsY * hp.nBinsZ;
  let chunk: u32 = (nBins + 255u) / 256u;
  let start: u32 = t * chunk;
  var sum: u32 = 0u;
  for (var k: u32 = 0u; k < chunk; k = k + 1u) {
    let b = start + k;
    if (b < nBins) { sum = sum + counts[b]; }
  }
  partials[t] = sum;
  workgroupBarrier();
  if (t == 0u) {
    var acc: u32 = 0u;
    for (var q: u32 = 0u; q < 256u; q = q + 1u) { let v = partials[q]; partials[q] = acc; acc = acc + v; }
  }
  workgroupBarrier();
  var run: u32 = partials[t];
  for (var k: u32 = 0u; k < chunk; k = k + 1u) {
    let b = start + k;
    if (b < nBins) {
      ${bsAt('b')} = i32(run);
      cursor[b] = run;
      run = run + counts[b];
    }
  }
  if (t == 255u) { ${bsAt('nBins')} = i32(run); }
}`;
}

function emitHashScatterWGSL(layout: AgentWebGPULayout, withMirror = false): string {
  const baBase = layout.hashBinAgentsBase;
  const baAt = (e: string) => (baBase === 0 ? `hashBins[${e}]` : `hashBins[${baBase}u + ${e}]`);
  const is3d = layout.gridDepth > 1;
  const MA = layout.maxAgents;
  // B1 mirror: write the field-major mirror + sortedId at the SAME CSR slot the
  // binAgents entry gets (one extra store per field). The read of agentF32 field f
  // for agent i uses the compiled f32Base; the write target is the mirror run k*MA.
  const f32 = (field: string, idxExpr: string): string => {
    const base = layout.f32Base[field]!;
    return base === 0 ? `agentF32[${idxExpr}]` : `agentF32[${base}u + ${idxExpr}]`;
  };
  const mirrorBindings = withMirror
    ? `\n@group(0) @binding(5) var<storage, read_write> sorted     : array<f32>;\n@group(0) @binding(6) var<storage, read_write> sortedId   : array<u32>;`
    : '';
  const mirrorStores = withMirror
    ? '\n' + agentMirrorFields(is3d).map((f, k) =>
        `  sorted[${k === 0 ? '' : `${k * MA}u + `}slot] = ${f32(f, 'i')};`).join('\n')
      + '\n  sortedId[slot] = i;'
    : '';
  return `${HASH_PARAMS_WGSL}
@group(0) @binding(0) var<storage, read>       agentF32   : array<f32>;
@group(0) @binding(1) var<storage, read>       agentAlive : array<u32>;
@group(0) @binding(2) var<storage, read_write> hashBins   : array<i32>;
@group(0) @binding(3) var<storage, read_write> cursor     : array<atomic<u32>>;
@group(0) @binding(4) var<uniform>             hp         : HashParams;${mirrorBindings}
${emitBinOf(layout)}
@compute @workgroup_size(64)
fn hashScatter(${RESIDENT_ENTRY}) {
${RESIDENT_IDX}
  if (i >= hp.highWater) { return; }
  if (agentAlive[i] == 0u) { return; }
  let slot: u32 = atomicAdd(&cursor[binOf(i)], 1u);
  ${baAt('slot')} = i32(i);${mirrorStores}
}`;
}

/** The per-generation position commit — the GPU analogue of swapPositions
 *  (xNext→x); dead slots are safe (the force pass copied x→xNext for them).
 *  ALSO zeroes the per-step force accumulators for the NEXT generation — the
 *  per-gen path did this CPU-side before every upload; without it the
 *  behaviour's `applyForce +=` accumulates across generations unboundedly
 *  (the resident-path "no flocking" bug). */
function emitPosCommitWGSL(layout: AgentWebGPULayout): string {
  const is3d = layout.gridDepth > 1;
  const xB = layout.f32Base['x']!, yB = layout.f32Base['y']!;
  const xnB = layout.f32Base['xNext']!, ynB = layout.f32Base['yNext']!;
  const zB = is3d ? layout.f32Base['z']! : 0, znB = is3d ? layout.f32Base['zNext']! : 0;
  const fxB = layout.f32Base['forceX']!, fyB = layout.f32Base['forceY']!;
  const fzB = is3d ? layout.f32Base['forceZ']! : 0;
  return `${HASH_PARAMS_WGSL}
@group(0) @binding(0) var<storage, read_write> agentF32 : array<f32>;
@group(0) @binding(1) var<uniform>             hp       : HashParams;
@group(0) @binding(2) var<storage, read_write> genCounter : array<u32>;
@compute @workgroup_size(64)
fn posCommit(${RESIDENT_ENTRY}) {
${RESIDENT_IDX}
  // L2 — THE residency fix. This is the only pass that runs exactly once per
  // generation inside dispatchResidentBatch's single submit, so it owns the
  // generation counter. ONE invocation writes it (no race), and it runs BEFORE the
  // highWater guard so an empty population still advances the clock. WebGPU's
  // implicit inter-pass ordering makes the bump visible to the NEXT generation's
  // behaviour pass — which is what lets a rule reading Get Generation observe N
  // distinct values across an N-generation batch instead of one frozen value.
  if (i == 0u) { genCounter[0] = genCounter[0] + 1u; }
  if (i >= hp.highWater) { return; }
  agentF32[${xB}u + i] = agentF32[${xnB}u + i];
  agentF32[${yB}u + i] = agentF32[${ynB}u + i];${is3d ? `
  agentF32[${zB}u + i] = agentF32[${znB}u + i];` : ''}
  agentF32[${fxB}u + i] = 0.0;
  agentF32[${fyB}u + i] = 0.0;${is3d ? `
  agentF32[${fzB}u + i] = 0.0;` : ''}
}`;
}

/** L3 — the RELAX COMMIT that separates two consecutive force passes of the SAME
 *  generation (`layoutIterations > 1`). It does exactly two things:
 *
 *    1. commit xNext→x (+z) so the next force iteration integrates from the moved
 *       positions — the GPU analogue of `swapPositions` inside the CPU loop;
 *    2. `age -= 1`, undoing the `age += 1` the force pass it follows performed.
 *       N force passes and N−1 relax commits leave `age` advanced by exactly ONE
 *       per generation, which is what `myAge` (and Lifespan) mean.
 *
 *  It deliberately does NOT do what `posCommit` also does — zero the force
 *  accumulator (that would discard the generation's graph-authored Apply Force
 *  after the first iteration) or bump the generation counter (that would make
 *  `Get Generation` tick `layoutIterations` times per generation, breaking the L2
 *  semantics). Growth needs no correction here: the CPU scales the ramp rate by
 *  1/iterations, which reaches the same target radius.
 *
 *  `highWater` comes from the ForceControl uniform (NOT HashParams) because both
 *  GPU paths write ForceControl, so ONE pipeline serves the per-gen dispatch and
 *  the resident batch. The alive mask is read so dead slots — which the force pass
 *  returns from before its own `age += 1` — are left alone. */
function emitRelaxCommitWGSL(layout: AgentWebGPULayout): string {
  const is3d = layout.gridDepth > 1;
  const xB = layout.f32Base['x']!, yB = layout.f32Base['y']!;
  const xnB = layout.f32Base['xNext']!, ynB = layout.f32Base['yNext']!;
  const zB = is3d ? layout.f32Base['z']! : 0, znB = is3d ? layout.f32Base['zNext']! : 0;
  const ageB = layout.f32Base['age']!;
  return `${emitForceControlStruct()}
@group(0) @binding(0) var<storage, read_write> agentF32 : array<f32>;
@group(0) @binding(1) var<uniform>             fc       : ForceControl;
@group(0) @binding(2) var<storage, read>       agentAlive : array<u32>;
@compute @workgroup_size(64)
fn relaxCommit(${RESIDENT_ENTRY}) {
${RESIDENT_IDX}
  if (i >= fc.highWater) { return; }
  agentF32[${xB}u + i] = agentF32[${xnB}u + i];
  agentF32[${yB}u + i] = agentF32[${ynB}u + i];${is3d ? `
  agentF32[${zB}u + i] = agentF32[${znB}u + i];` : ''}
  if (agentAlive[i] != 0u) { agentF32[${ageB}u + i] = agentF32[${ageB}u + i] - 1.0; }
}`;
}

/** L3 — append one force pass, plus the `iterations − 1` extra [relax-commit →
 *  force] pairs, to an encoder. THE single place both GPU dispatch sites express
 *  "run the force integrator N times per generation", so they cannot disagree.
 *  `iterations` collapses to 1 when the relax-commit pipeline is unavailable, so a
 *  build failure degrades to today's behaviour instead of skipping the commits and
 *  silently integrating the same positions N times. */
function encodeForceIterations(
  rt: AgentWebGPURuntime, enc: GPUCommandEncoder, total: number, iterations: number,
  setForce: (pass: GPUComputePassEncoder) => void,
): void {
  const canRelax = !!(rt.relaxCommitPipeline && rt.relaxCommitBindGroup);
  const iters = canRelax ? Math.max(1, iterations) : 1;
  for (let it = 0; it < iters; it++) {
    if (it > 0) {
      const pr = enc.beginComputePass({ label: 'agent-relax-commit' });
      pr.setPipeline(rt.relaxCommitPipeline!); pr.setBindGroup(0, rt.relaxCommitBindGroup!);
      dispatchAgents(pr, total); pr.end();
    }
    const pf = enc.beginComputePass({ label: 'agent-force-pass' });
    setForce(pf);
    dispatchAgents(pf, total); pf.end();
  }
}

/** Lazily build the residency pipelines + buffers. Returns false (and latches
 *  residentBuildFailed) on any failure — the caller falls back to the per-gen
 *  path, never silently wrong.
 *
 *  `needScan` (B1): the ENGINE force pass runs its neighbour scan (bonding ||
 *  doCollision || doDensity). When true, the scatter ALSO writes a bin-sorted
 *  field-major mirror + sortedId, and the resident batch runs a mirror-variant
 *  force pass reading neighbour fields COALESCED from that mirror. When false
 *  (pure-custom-force models — Boids/PL) NO mirror is built and the resident
 *  batch uses the shared per-gen `rt.forcePipeline` (zero mirror cost).
 *  `needScan` is a STATIC per-model property (its gates don't change under the
 *  residency-eligibility conditions), so the first-build memoization is safe. */
export async function ensureAgentResident(rt: AgentWebGPURuntime, needScan = false): Promise<boolean> {
  if (rt.resident) return true;
  if (rt.residentBuildFailed) return false;
  try {
    const device = rt.device, L = rt.layout;
    const countsBuf = device.createBuffer({ label: 'agent-hash-counts', size: Math.max(4, L.maxHashBins * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const cursorBuf = device.createBuffer({ label: 'agent-hash-cursor', size: Math.max(4, L.maxHashBins * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const hashParamsBuf = device.createBuffer({ label: 'agent-hash-params', size: HASH_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mkPipe = async (label: string, code: string, entry: string, entries: GPUBindGroupLayoutEntry[]) => {
      const mod = device.createShaderModule({ code });
      const info = await mod.getCompilationInfo();
      const errs = info.messages.filter(m => m.type === 'error');
      if (errs.length > 0) throw new Error(`${label} WGSL: ` + errs.map(m => `line ${m.lineNum}: ${m.message}`).join('; '));
      const bgl = device.createBindGroupLayout({ label: `${label}-bgl`, entries });
      const pl = device.createPipelineLayout({ label: `${label}-pl`, bindGroupLayouts: [bgl] });
      const pipe = await device.createComputePipelineAsync({ label, layout: pl, compute: { module: mod, entryPoint: entry } });
      return { pipe, bgl };
    };
    const S = GPUShaderStage.COMPUTE;
    const count = await mkPipe('agent-hash-count', emitHashCountWGSL(L), 'hashCount', [
      { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: S, buffer: { type: 'storage' } },
      { binding: 3, visibility: S, buffer: { type: 'uniform' } },
    ]);
    const scan = await mkPipe('agent-hash-scan', emitHashScanWGSL(L), 'hashScan', [
      { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: S, buffer: { type: 'storage' } },
      { binding: 2, visibility: S, buffer: { type: 'storage' } },
      { binding: 3, visibility: S, buffer: { type: 'uniform' } },
    ]);
    // --- B1 mirror buffers + the mirror scatter/force variants (needScan only) ---
    const nMirror = agentMirrorFields(L.gridDepth > 1).length;
    const sortedBuf = needScan ? device.createBuffer({ label: 'agent-mirror-sorted', size: Math.max(4, nMirror * L.maxAgents * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }) : null;
    const sortedIdBuf = needScan ? device.createBuffer({ label: 'agent-mirror-sortedid', size: Math.max(4, L.maxAgents * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }) : null;
    // The scatter: mirror variant (writes hashBins + mirror + sortedId) when needScan.
    const scatterEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: S, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: S, buffer: { type: 'storage' } },
      { binding: 3, visibility: S, buffer: { type: 'storage' } },
      { binding: 4, visibility: S, buffer: { type: 'uniform' } },
    ];
    if (needScan) {
      scatterEntries.push({ binding: 5, visibility: S, buffer: { type: 'storage' } });
      scatterEntries.push({ binding: 6, visibility: S, buffer: { type: 'storage' } });
    }
    const scatter = await mkPipe('agent-hash-scatter', emitHashScatterWGSL(L, needScan), 'hashScatter', scatterEntries);
    const commit = await mkPipe('agent-pos-commit', emitPosCommitWGSL(L), 'posCommit', [
      { binding: 0, visibility: S, buffer: { type: 'storage' } },
      { binding: 1, visibility: S, buffer: { type: 'uniform' } },
      { binding: 2, visibility: S, buffer: { type: 'storage' } },
    ]);
    // The resident mirror force pass — reads neighbour fields from the mirror
    // (bindings 5/6). null when !needScan ⇒ the batch uses the shared rt.forcePipeline.
    let forceMirrorPipeline: GPUComputePipeline | null = null;
    let forceMirrorBind: GPUBindGroup | null = null;
    if (needScan) {
      const usesScatterFC = !!rt.forceScatterBuf;
      const forceEntries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: S, buffer: { type: 'storage' } },
        { binding: 1, visibility: S, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: S, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: S, buffer: { type: 'uniform' } },
      ];
      if (usesScatterFC) forceEntries.push({ binding: 4, visibility: S, buffer: { type: 'read-only-storage' } });
      forceEntries.push({ binding: 5, visibility: S, buffer: { type: 'read-only-storage' } });
      forceEntries.push({ binding: 6, visibility: S, buffer: { type: 'read-only-storage' } });
      const fm = await mkPipe('agent-force-mirror', emitAgentForcePassWGSL(L, usesScatterFC, true), 'forcePass', forceEntries);
      forceMirrorPipeline = fm.pipe;
      const fmEntries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: rt.agentF32Buf } },
        { binding: 1, resource: { buffer: rt.agentAliveBuf } },
        { binding: 2, resource: { buffer: rt.hashBinsBuf } },
        { binding: 3, resource: { buffer: rt.forceControlBuf } },
      ];
      if (usesScatterFC && rt.forceScatterBuf) fmEntries.push({ binding: 4, resource: { buffer: rt.forceScatterBuf } });
      fmEntries.push({ binding: 5, resource: { buffer: sortedBuf! } });
      fmEntries.push({ binding: 6, resource: { buffer: sortedIdBuf! } });
      forceMirrorBind = rt.device.createBindGroup({ label: 'agent-force-mirror-bg', layout: fm.bgl, entries: fmEntries });
    }
    const scatterBgEntries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: rt.agentF32Buf } },
      { binding: 1, resource: { buffer: rt.agentAliveBuf } },
      { binding: 2, resource: { buffer: rt.hashBinsBuf } },
      { binding: 3, resource: { buffer: cursorBuf } },
      { binding: 4, resource: { buffer: hashParamsBuf } },
    ];
    if (needScan) {
      scatterBgEntries.push({ binding: 5, resource: { buffer: sortedBuf! } });
      scatterBgEntries.push({ binding: 6, resource: { buffer: sortedIdBuf! } });
    }
    rt.resident = {
      countPipeline: count.pipe, scanPipeline: scan.pipe, scatterPipeline: scatter.pipe, commitPipeline: commit.pipe,
      countBind: rt.device.createBindGroup({ label: 'agent-hash-count-bg', layout: count.bgl, entries: [
        { binding: 0, resource: { buffer: rt.agentF32Buf } },
        { binding: 1, resource: { buffer: rt.agentAliveBuf } },
        { binding: 2, resource: { buffer: countsBuf } },
        { binding: 3, resource: { buffer: hashParamsBuf } },
      ] }),
      scanBind: rt.device.createBindGroup({ label: 'agent-hash-scan-bg', layout: scan.bgl, entries: [
        { binding: 0, resource: { buffer: countsBuf } },
        { binding: 1, resource: { buffer: rt.hashBinsBuf } },
        { binding: 2, resource: { buffer: cursorBuf } },
        { binding: 3, resource: { buffer: hashParamsBuf } },
      ] }),
      scatterBind: rt.device.createBindGroup({ label: 'agent-hash-scatter-bg', layout: scatter.bgl, entries: scatterBgEntries }),
      commitBind: rt.device.createBindGroup({ label: 'agent-pos-commit-bg', layout: commit.bgl, entries: [
        { binding: 0, resource: { buffer: rt.agentF32Buf } },
        { binding: 1, resource: { buffer: hashParamsBuf } },
        { binding: 2, resource: { buffer: rt.genCounterBuf } },
      ] }),
      countsBuf, cursorBuf, hashParamsBuf,
      hasMirror: needScan, sortedBuf, sortedIdBuf, forceMirrorPipeline, forceMirrorBind,
    };
    return true;
  } catch {
    rt.residentBuildFailed = true;
    rt.resident = null;
    return false;
  }
}

/** Compute the per-batch hash geometry CPU-side (origin 0; world-box bins;
 *  coarsened to fit the layout reserve — mirrors buildSpatialHash's cap loop;
 *  <3 bins on any used axis ⇒ hashValid 0, the all-pairs fallback). */
export function computeResidentHashParams(
  W: number, H: number, D: number,
  interactionRange: number, maxR: number, neighbourQueryRadius: number,
  maxBins: number,
  /** L1 — the long-range charge cutoff, or 0 when charge is off. It MUST join the
   *  bin-edge max: the force pass only ever sees pairs within one bin of the 3×3(×3)
   *  stencil, so a bin edge narrower than the charge cutoff silently truncates the
   *  force with no error anywhere. Widening is safe for the reserve — a LARGER edge
   *  yields FEWER bins, and the coarsen loop below caps the count regardless. */
  chargeMaxDist = 0,
): ResidentHashParams {
  const is3d = D > 1;
  let edge = Math.max(1e-3, interactionRange * 2 * maxR, neighbourQueryRadius, chargeMaxDist);
  let nx = Math.max(1, Math.floor(W / edge));
  let ny = Math.max(1, Math.floor(H / edge));
  let nz = is3d ? Math.max(1, Math.floor(D / edge)) : 1;
  for (let it = 0; it < 64 && nx * ny * nz > Math.max(1, maxBins); it++) {
    edge *= 1.3;
    nx = Math.max(1, Math.floor(W / edge));
    ny = Math.max(1, Math.floor(H / edge));
    nz = is3d ? Math.max(1, Math.floor(D / edge)) : 1;
  }
  const hashValid = (nx >= 3 && ny >= 3 && (!is3d || nz >= 3) && nx * ny * nz <= Math.max(1, maxBins)) ? 1 : 0;
  return { hashValid, nBinsX: nx, nBinsY: ny, nBinsZ: nz, binSizeX: W / nx, binSizeY: H / ny, binSizeZ: is3d ? D / nz : 1 };
}

/** Upload the HashParams uniform. Field order MIRRORS HASH_PARAMS_WGSL. */
export function uploadAgentHashParams(rt: AgentWebGPURuntime, highWater: number, hp: ResidentHashParams, torus: boolean): void {
  if (!rt.resident) return;
  const ab = new ArrayBuffer(HASH_PARAMS_BYTES);
  const u = new Uint32Array(ab), fl = new Float32Array(ab);
  u[0] = highWater >>> 0;
  u[1] = hp.nBinsX >>> 0;
  u[2] = hp.nBinsY >>> 0;
  u[3] = hp.nBinsZ >>> 0;
  u[4] = torus ? 1 : 0;
  u[5] = rt.layout.gridDepth > 1 ? 1 : 0;
  fl[6] = hp.binSizeX;
  fl[7] = hp.binSizeY;
  fl[8] = hp.binSizeZ;
  fl[9] = 0; fl[10] = 0; fl[11] = 0;   // origin — always 0 for the world-box hash
  rt.device.queue.writeBuffer(rt.resident.hashParamsBuf, 0, ab);
}

/** Encode + submit a WHOLE batch of generations in ONE queue submit: per gen
 *  [clear counts → count → scan → scatter] (hash build, when hashValid) →
 *  [clear forceScatter] → behaviour → force → posCommit. No CPU work between
 *  generations; the implicit inter-pass ordering provides the barriers. */
export function dispatchResidentBatch(rt: AgentWebGPURuntime, gens: number, highWater: number, hp: ResidentHashParams, layoutIterations = 1): void {
  const res = rt.resident;
  if (!res) throw new Error('resident pipelines not built');
  const enc = rt.device.createCommandEncoder({ label: 'agent-resident-batch' });
  const total = Math.max(1, highWater);
  const nBins = hp.nBinsX * hp.nBinsY * hp.nBinsZ;
  for (let g = 0; g < gens; g++) {
    if (hp.hashValid) {
      enc.clearBuffer(res.countsBuf, 0, nBins * 4);
      const pc = enc.beginComputePass({ label: 'agent-hash-count' });
      pc.setPipeline(res.countPipeline); pc.setBindGroup(0, res.countBind); dispatchAgents(pc, total); pc.end();
      const ps = enc.beginComputePass({ label: 'agent-hash-scan' });
      ps.setPipeline(res.scanPipeline); ps.setBindGroup(0, res.scanBind); ps.dispatchWorkgroups(1); ps.end();
      const px = enc.beginComputePass({ label: 'agent-hash-scatter' });
      px.setPipeline(res.scatterPipeline); px.setBindGroup(0, res.scatterBind); dispatchAgents(px, total); px.end();
    }
    if (rt.forceScatterBuf) enc.clearBuffer(rt.forceScatterBuf);
    const pb = enc.beginComputePass({ label: 'agent-behaviour-pass' });
    pb.setPipeline(rt.behaviourPipeline); pb.setBindGroup(0, rt.behaviourBindGroup); dispatchAgents(pb, total); pb.end();
    // B1: when the mirror was built (needScan), run the mirror-variant force pass
    // (coalesced neighbour reads from the bin-sorted mirror); else the shared
    // per-gen force pipeline (custom-force models — no scan, no mirror).
    // L3 — `layoutIterations` force passes, separated by relax commits. The hash
    // built above is REUSED across the iterations (as on the CPU): rebuilding it
    // per iteration would triple the pass count for a displacement far below one
    // bin edge. posCommit still runs exactly ONCE per generation, below, so the
    // generation counter and the force-accumulator reset stay per-generation.
    encodeForceIterations(rt, enc, total, layoutIterations, pf => {
      if (res.forceMirrorPipeline && res.forceMirrorBind) {
        pf.setPipeline(res.forceMirrorPipeline); pf.setBindGroup(0, res.forceMirrorBind);
      } else {
        pf.setPipeline(rt.forcePipeline); pf.setBindGroup(0, rt.forceBindGroup);
      }
    });
    const pm = enc.beginComputePass({ label: 'agent-pos-commit' });
    pm.setPipeline(res.commitPipeline); pm.setBindGroup(0, res.commitBind); dispatchAgents(pm, total); pm.end();
    // PX — the attribute commit (sync agent update), per generation, exactly as the
    // per-gen path does it. Residency currently EXCLUDES sync models
    // (`agentResidentEligible`), so `attrCommitPipeline` is always null here and
    // this is dead today — kept so that widening residency to sync inherits the
    // correct double-buffer semantics instead of silently reintroducing the race.
    if (rt.attrCommitPipeline && rt.attrCommitBindGroup && rt.attrCommitCount > 0) {
      const pa = enc.beginComputePass({ label: 'agent-attr-commit-pass' });
      pa.setPipeline(rt.attrCommitPipeline); pa.setBindGroup(0, rt.attrCommitBindGroup);
      dispatchAgents(pa, rt.attrCommitCount); pa.end();
    }
  }
  // A1.5 — the active Agent Output-Mapping colour pass writes agentColors from the
  // final-state agent attrs (once per batch = once per presented frame). For a
  // no-OM model this is a no-op and agentColors keeps the behaviour Set Cell Looks
  // colours (Boids). Runs AFTER the gen loop (reads the committed state) and BEFORE
  // the present, so the presented frame carries the OM colours (the resident
  // fast-path fix for OM-coloured models — Particle Life).
  dispatchAgentOMEncode(rt, enc, highWater);
  // A1 direct render: present the FINAL frame in the SAME submit (posCommit ran,
  // so agentF32[x] holds the committed position; the behaviour wrote agentColors).
  // No-op unless a render canvas is attached — and (audit L3) also a no-op on a
  // COMPOSITE surface, whose canvas carries the grid layer that this disc-only,
  // clear-first pass would wipe. Reviving E2 for residency therefore needs a
  // composite-aware batch present here, not just flipping the gate back on.
  presentAgentsEncode(rt, enc, highWater);
  rt.device.queue.submit([enc.finish()]);
}

/** The once-per-FRAME readback for the resident path: pull the f32 SoA + colours
 *  and commit positions (from the COMMITTED x/y[/z] — posCommit ran last),
 *  velocities, radius/density/age, the user agent attributes (async single-buffer
 *  ⇒ straight into attrRead), and the packed per-agent colours into the CPU
 *  store. No structural/spawn/stop handling — residency eligibility excludes
 *  them. */
export async function readbackAgentFrame(rt: AgentWebGPURuntime, s: AgentStore): Promise<void> {
  const L = rt.layout, hw = s.highWater;
  const f32ByteLen = f32Bytes(L);
  const colByteLen = colorsBytes(L);
  const pooledF = acquireStaging(rt, f32ByteLen);
  const pooledC = acquireStaging(rt, colByteLen);
  const enc = rt.device.createCommandEncoder({ label: 'agent-frame-readback' });
  enc.copyBufferToBuffer(rt.agentF32Buf, 0, pooledF.buffer, 0, f32ByteLen);
  enc.copyBufferToBuffer(rt.agentColorsBuf, 0, pooledC.buffer, 0, colByteLen);
  rt.device.queue.submit([enc.finish()]);
  await pooledF.buffer.mapAsync(GPUMapMode.READ, 0, f32ByteLen);
  await pooledC.buffer.mapAsync(GPUMapMode.READ, 0, colByteLen);
  const f = new Float32Array(pooledF.buffer.getMappedRange(0, f32ByteLen));
  const col = new Uint32Array(pooledC.buffer.getMappedRange(0, colByteLen));
  const is3d = L.gridDepth > 1;
  const xB = L.f32Base['x']!, yB = L.f32Base['y']!;
  const vxB = L.f32Base['vx']!, vyB = L.f32Base['vy']!;
  const radB = L.f32Base['radius']!, denB = L.f32Base['density']!, ageB = L.f32Base['age']!;
  const zB = is3d ? L.f32Base['z']! : -1, vzB = is3d ? L.f32Base['vz']! : -1;
  for (let i = 0; i < hw; i++) {
    if (!s.alive[i]) continue;
    s.x[i] = f[xB + i]!; s.y[i] = f[yB + i]!;
    s.xNext[i] = s.x[i]!; s.yNext[i] = s.y[i]!;
    s.vx[i] = f[vxB + i]!; s.vy[i] = f[vyB + i]!;
    if (is3d) { s.z[i] = f[zB + i]!; s.zNext[i] = s.z[i]!; s.vz[i] = f[vzB + i]!; }
    s.radius[i] = f[radB + i]!;
    s.density[i] = f[denB + i]!;
    s.age[i] = f[ageB + i]!;
    const c = col[i]! >>> 0, ci = i * 4;
    s.colors[ci] = c & 0xff; s.colors[ci + 1] = (c >>> 8) & 0xff;
    s.colors[ci + 2] = (c >>> 16) & 0xff; s.colors[ci + 3] = (c >>> 24) & 0xff;
  }
  // User agent attributes — async single-buffer under residency eligibility, so
  // attrWrite aliases attrRead; write attrRead directly (no swap needed).
  for (const id of L.agentAttrIds) {
    const base = L.agentAttrBase[id]!;
    const dst = s.attrRead[id] as { [i: number]: number } | undefined;
    if (!dst) continue;
    const isInt = s.attrKind[id] !== 'float64';
    for (let i = 0; i < hw; i++) { if (!s.alive[i]) continue; dst[i] = isInt ? Math.round(f[base + i]!) : f[base + i]!; }
  }
  pooledF.buffer.unmap();
  pooledC.buffer.unmap();
  pooledF.inUse = false; pooledC.inUse = false;
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
    rt.auxF32Buf, rt.indicatorsBuf, rt.bondStoreBuf, rt.spawnCursorBuf, rt.stopFlagBuf,
    rt.resident?.countsBuf ?? null, rt.resident?.cursorBuf ?? null, rt.resident?.hashParamsBuf ?? null,
    rt.resident?.sortedBuf ?? null, rt.resident?.sortedIdBuf ?? null,
    rt.renderViewBuf ?? null, rt.renderView3DBuf ?? null,   // + Phase C 3D uniform
    rt.gridPresentUniform ?? null,   // + E2 composite grid-dims uniform
  ];
  // A1 render canvas is a transferred OffscreenCanvas — its context is released
  // with the device; just drop the references (unconfigure is implicit on destroy).
  rt.renderActive = false;
  rt.renderCtx = null;
  rt.renderComposite = false;
  if (rt.renderDepthTex) { try { rt.renderDepthTex.destroy(); } catch { /* non-fatal */ } rt.renderDepthTex = null; }
  for (const b of bufs) { if (b) try { b.destroy(); } catch { /* non-fatal */ } }
  for (const bucket of rt.stagingPool.values()) for (const e of bucket) { try { e.buffer.destroy(); } catch { /* non-fatal */ } }
  rt.stagingPool.clear();
  // E1: release the shared-device reference (mirrors destroyWebGPURuntime). The
  // device is destroyed only when the LAST runtime — grid + all agent runtimes —
  // releases it, so a rebuild (soft recompile / target flip / reset) reuses the
  // ONE device and a live grid runtime isn't killed when the agent runtime tears
  // down. Before E1 each runtime destroyed its own device, which leaked on every
  // rebuild that didn't worker.terminate().
  releaseSharedGpuDevice(rt.device);
  rt.ready = false;
}
