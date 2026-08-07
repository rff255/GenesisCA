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
import { AGENT_GPU_F32_FIELDS, AGENT_GPU_F32_FIELDS_3D, AGENT_GPU_I32_FIELDS, AGENT_GPU_QUEUE_FIELDS, AGENT_GPU_REQUEST_FIELDS, AGENT_GPU_SPRITE_FIELDS } from '../../modeler/vpl/compiler/agentWebgpu/layout';
import { emitAgentForcePassWGSL, agentMirrorFields, emitForceControlStruct } from '../../modeler/vpl/compiler/agentWebgpu/forcePass';
import { acquireSharedGpuDevice, releaseSharedGpuDevice } from './sharedGpuDevice';
import { buildSceneWireframeVerts, type SceneViz } from './sceneWireframe';
import { GLOW_TONE_EXPOSURE } from '../glowTone';

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
  /** C10 / P11a - GLOBAL (Barnes-Hut) charge. When 1 the CUTOFF pair term is off
   *  (`doCharge` is 0) and the charge comes from the uploaded octree instead;
   *  `treeNodeCount` bounds the traversal, `chargeTheta2` is the opening angle
   *  squared (precomputed, like `chargeMaxD2`). Absent => 0 => no traversal. */
  chargeGlobal?: number;
  chargeTheta2?: number;
  treeNodeCount?: number;
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
  /** C9 / STEP 6 — the resolved MOTION mode: 0 static | 1 velocity | 2 force.
   *  Absent ⇒ 2 (the historical engine). `static` makes the shader write neither
   *  the velocity nor `xNext`, and the caller must skip the CPU position commit
   *  with it (`readbackAgentStep({ commitPositions: false })`) — the two MUST be
   *  skipped together or a graph `Set Agent Position` write is reverted by a
   *  stale `xNext` (the documented Ant Necrophoresis hazard). */
  motionMode?: number;
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
  /** The behaviour writes per-agent SPRITE state (Set Agent Sprite) — the five
   *  `AGENT_GPU_SPRITE_FIELDS` runs are seeded before every dispatch and read back
   *  after. No binding of its own (the runs live in `agentF32`). It ALSO blocks
   *  GPU residency (see `residencyModelBlockers`' `sprites` term): the CPU owns
   *  sprite state between generations. */
  usesSpriteWrite: boolean;
  /** Apply Force To Agent (binding 14) — an f32-bitcast atomic force-scatter
   *  accumulator (X/Y[/Z] regions strided by maxAgents). null when the behaviour
   *  graph has no Apply Force To Agent. Zeroed (clearBuffer) before each behaviour
   *  dispatch; the force pass reads it (its binding 4) into the self-force seed. */
  forceScatterBuf: GPUBuffer | null;
  /** C10 / P11a — the uploaded Barnes–Hut octree (GLOBAL charge only; null
   *  otherwise, and then the force shader declares no tree bindings either). */
  chargeTreeF32Buf: GPUBuffer | null;
  chargeTreeI32Buf: GPUBuffer | null;
  /** Reusable staging for the per-generation tree upload. */
  chargeTreeUploadF32: Float32Array | null;
  chargeTreeUploadI32: Int32Array | null;
  /** THE ACTIVE WINDOW — the highest slot index the GPU buffers may hold live data
   *  for. Every per-generation transfer covers `[0, gpuActiveHigh)` of each strided
   *  run instead of the `maxAgents` CEILING.
   *
   *  WHY (measured, user-reported): `maxAgents` is a user-set ceiling, so a model
   *  that grows to ~2 000 agents under a 60 000 ceiling was uploading, copying and
   *  mapping ~15 MB of mostly-dead slots EVERY generation. On a bonded /
   *  structurally-rewriting model — which can never be residency-eligible, so it
   *  always takes the per-generation round-trip — that measured **47 ms/gen at
   *  maxAgents 60 000 vs 10 ms/gen at 4 000, for the same population**. The window
   *  makes the cost track the POPULATION, so the ceiling is free to be generous.
   *
   *  It only ever GROWS (slots the GPU has written must keep being refreshed, or a
   *  dead slot's stale request lanes would be read back and drained). Slots it has
   *  never covered are still the zero the buffer was created with, which is exactly
   *  the "no requests, not alive" state the reconcile expects. */
  gpuActiveHigh: number;
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
  /** Cached compacted readback plan (rebuilt when the active window changes). */
  f32ReadPlan?: AgentF32ReadPlan;
  /** Reusable staging for the bond-store upload, grown to the active window (it
   *  used to be a fresh Int32Array(bondStoreLen) — i.e. the maxAgents CEILING —
   *  allocated on the per-generation path). */
  bondStoreUpload?: Int32Array;
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
  /** Two pipelines from one module: plain (premultiplied-alpha) + glow (screen). */
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
  // Scene-anchored wireframes (bounds / floor grid / origin axes), drawn in the
  // SAME render pass + depth buffer as the spheres so agents in front occlude
  // them — the agent-sphere sibling of the L1 voxel line pass. Geometry comes
  // from the SHARED buildSceneWireframeVerts (mirrors gl3d's renderOverlays).
  renderLinePipeline?: GPURenderPipeline | null;
  renderLineBindGroup?: GPUBindGroup | null;
  renderLineBuf?: GPUBuffer | null;
  renderLineCount?: number;
  renderLineSig?: string;
  /** Which wireframe groups to draw (mirrors the panel's Viz3D toggles). */
  renderViz?: SceneViz;
  /** (W-1)/2, (H-1)/2, (D-1)/2 from the last RenderView3D — the ONLY source the
   *  line geometry derives its dims from, so lines and spheres share one frame. */
  renderHalf3D?: [number, number, number];
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
// C10: 33 scalars -> 132 B, rounded to the uniform's 16-byte alignment. (Was 128
// for the 30 scalars through C9's `motionMode`.) The uniform-layout harness pins
// this against the WGSL struct.
const FORCE_CONTROL_BYTES = 144;

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
  /** The behaviour writes per-agent SPRITE state (Set Agent Sprite). Declares NO
   *  binding — the five runs live in `agentF32` — but it turns the sprite
   *  round-trip ON: the runs are SEEDED from the CPU store before every dispatch
   *  and read back after. Both halves are required together: the shader writes only
   *  the TICKED facets, so an un-seeded run would be read back as 0 and clobber the
   *  CPU's correct value (a spriteId of 0 = "no sprite" ⇒ agents drawn as discs). */
  usesSpriteWrite?: boolean;
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
  // C10 / P11a — the CPU-built Barnes–Hut octree, re-uploaded each generation (the
  // `uploadAgentHash` precedent). Created ONLY when the layout reserved nodes (i.e.
  // the model runs GLOBAL charge); the shader declares bindings 7/8 under the same
  // condition, so a cutoff/off model has neither buffers nor bindings.
  const hasChargeTree = layout.chargeTreeNodes > 0;
  const chargeTreeF32Buf = hasChargeTree ? mk('agentChargeTreeF32', Math.max(4, layout.chargeTreeF32Len * 4), STORAGE_RO) : null;
  const chargeTreeI32Buf = hasChargeTree ? mk('agentChargeTreeI32', Math.max(4, layout.chargeTreeI32Len * 4), STORAGE_RO) : null;
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
  if (chargeTreeF32Buf && chargeTreeI32Buf) {
    forceEntries.push({ binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
    forceEntries.push({ binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
  }
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
  if (chargeTreeF32Buf && chargeTreeI32Buf) {
    forceBgEntries.push({ binding: 7, resource: { buffer: chargeTreeF32Buf } });
    forceBgEntries.push({ binding: 8, resource: { buffer: chargeTreeI32Buf } });
  }
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
    // The sprite round-trip needs the layout to have RESERVED the runs (the C9
    // gate). `usesSpriteWrite ⇒ reserved` by construction (the gate is usage-
    // widened on the very node that sets this flag), but AND-ing it keeps a
    // hand-edited / mismatched layout from addressing a run that does not exist.
    usesSpriteWrite: !!usage.usesSpriteWrite && layout.spritesReserved,
    forceScatterBuf,
    chargeTreeF32Buf, chargeTreeI32Buf,
    chargeTreeUploadF32: hasChargeTree ? new Float32Array(Math.max(1, layout.chargeTreeF32Len)) : null,
    chargeTreeUploadI32: hasChargeTree ? new Int32Array(Math.max(1, layout.chargeTreeI32Len)) : null,
    // Fresh buffers are zero-initialised, so nothing is live yet.
    gpuActiveHigh: 0,
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

/** THE COMPACTED READBACK PLAN. The f32 SoA is a set of STRIDED runs (run r lives
 *  at `f32Base[r] .. +maxAgents`), so a windowed readback cannot be one prefix copy
 *  — the live prefixes are scattered across the whole buffer. Instead each run's
 *  live prefix is copied to its own slot in a COMPACTED staging buffer, and only
 *  `totalElems` are mapped.
 *
 *  EVERY run is planned (the same field lists the upload walks), not just the ones
 *  the reader happens to touch, so `compactBase` can never miss one — a missing
 *  base would silently read a neighbouring run's data. `compactBase` throws rather
 *  than returning undefined for exactly that reason. */
interface AgentF32ReadPlan {
  window: number;
  totalElems: number;
  /** gpu run base -> compacted run base */
  base: Map<number, number>;
  copies: Array<{ src: number; dst: number; elems: number }>;
}

function buildF32ReadPlan(rt: AgentWebGPURuntime, window: number): AgentF32ReadPlan {
  const L = rt.layout;
  const base = new Map<number, number>();
  const copies: Array<{ src: number; dst: number; elems: number }> = [];
  let cursor = 0;
  const add = (gpuBase: number | undefined, perAgent: number): void => {
    if (gpuBase === undefined || base.has(gpuBase)) return;
    const elems = window * perAgent;
    base.set(gpuBase, cursor);
    if (elems > 0) copies.push({ src: gpuBase, dst: cursor, elems });
    cursor += elems;
  };
  const f32Fields: readonly string[] = L.gridDepth > 1
    ? [...AGENT_GPU_F32_FIELDS, ...AGENT_GPU_F32_FIELDS_3D]
    : AGENT_GPU_F32_FIELDS;
  for (const field of f32Fields) add(L.f32Base[field], AGENT_GPU_QUEUE_FIELDS.has(field) ? L.bondReqSlots : 1);
  for (const id of L.agentAttrIds) { add(L.agentAttrBase[id], 1); add(L.agentAttrWriteBase[id], 1); }
  for (const id of L.bondAttrIds) add(L.bondFormAttrBase[id], L.bondReqSlots);
  // The SPRITE runs are planned under exactly the predicate that UPLOADS them
  // (`spriteRunsActive`), so the plan still covers precisely what crosses the bus
  // in both directions — and `compactBase` still throws for anything else.
  if (spriteRunsActive(rt)) for (const field of AGENT_GPU_SPRITE_FIELDS) add(L.f32Base[field], 1);
  return { window, totalElems: Math.max(1, cursor), base, copies };
}

/** Does this runtime round-trip the five SPRITE runs? ONE predicate, consulted by
 *  the upload, the read plan and both readbacks — they must agree or the readback
 *  reads a run the upload never seeded (and the shader writes only the TICKED
 *  facets, so an unseeded run would come back as 0 and wipe the CPU's sprite id). */
function spriteRunsActive(rt: AgentWebGPURuntime): boolean {
  return rt.usesSpriteWrite && rt.layout.spritesReserved;
}

function f32ReadPlan(rt: AgentWebGPURuntime, window: number): AgentF32ReadPlan {
  const cached = rt.f32ReadPlan;
  if (cached && cached.window === window) return cached;
  const plan = buildF32ReadPlan(rt, window);
  rt.f32ReadPlan = plan;
  return plan;
}

/** Resolve a GPU run base to its compacted staging base. Throws on an unplanned
 *  base — silently returning 0 would read a DIFFERENT run's values. */
function compactBase(plan: AgentF32ReadPlan, gpuBase: number): number {
  const b = plan.base.get(gpuBase);
  if (b === undefined) throw new Error(`[agents/webgpu] readback plan is missing run base ${gpuBase}`);
  return b;
}

/** Resolve THE ACTIVE WINDOW for a per-generation transfer — see
 *  `AgentWebGPURuntime.gpuActiveHigh`. Monotonic: it is raised to the store's
 *  highWater here so a grown population is covered, and `readbackAgentStep` raises
 *  it again to the post-dispatch spawn cursor (the shader can bump-allocate slots
 *  ABOVE highWater within a generation, and those must keep being refreshed
 *  afterwards or their stale request lanes would be read back and drained).
 *
 *  Clamped to the layout ceiling: everything downstream indexes strided runs whose
 *  stride IS maxAgents, so the window can never exceed it. */
function agentActiveWindow(rt: AgentWebGPURuntime, highWater: number): number {
  const ma = rt.layout.maxAgents;
  const w = Math.min(ma, Math.max(rt.gpuActiveHigh, Math.max(0, highWater)));
  rt.gpuActiveHigh = w;
  return w;
}

/** Upload the per-agent f32 SoA (geometry + velocity + force + density), the i32
 *  SoA, and the alive mask (expanded to u32/agent). Called each step before the
 *  dispatch (positions evolve on the GPU but the structural phase / paint / seed
 *  mutate the CPU store between steps, so we re-upload). The RNG buffer is NOT
 *  touched here — it is seeded ONCE (`seedAgentRng`) and the GPU advances its own
 *  per-agent stream in place across steps (so successive steps draw fresh
 *  randomness; re-seeding every step would freeze the sequence). */
export function uploadAgentSoA(rt: AgentWebGPURuntime, s: AgentStore): void {
  const L = rt.layout, hw = s.highWater;
  // THE ACTIVE WINDOW (see AgentWebGPURuntime.gpuActiveHigh). `ma` is the window,
  // NOT L.maxAgents: every fill loop and every writeBuffer below covers only the
  // live prefix of its strided run. It only grows, so a slot the GPU has ever
  // written keeps being refreshed; slots past it are still the zero the buffer was
  // created with. `hw` is clamped because a caller could hand a store whose
  // highWater outran a stale layout.
  const ma = agentActiveWindow(rt, hw);
  const f = rt.f32Upload, ix = rt.i32Upload, al = rt.aliveUpload;
  /** Upload one strided run's live prefix. `perAgent` is 1 for a plain run and
   *  `bondReqSlots` for a queue-shaped one. Element-indexed writeBuffer: both the
   *  destination byte offset and the size stay 4-aligned by construction. */
  const putF32 = (base: number, perAgent: number): void => {
    rt.device.queue.writeBuffer(rt.agentF32Buf, base * 4, f, base, ma * perAgent);
  };
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
  // SPRITE runs — SEEDED from the CPU store, which OWNS sprite state between
  // generations (`advanceAgentSprites` ticks frame += speed, `initAgentSlot`
  // clears a recycled slot, `divideAgent` hands a daughter its mother's sprite).
  // The shader writes only the facets its Set Agent Sprite nodes tick, so an
  // un-seeded run would be read back as 0 and clobber the CPU value.
  //
  // PRECISION: `spriteIds` is a slot index (exact in f32 far past any plausible
  // sprite count) and the other four are DISPLAY quantities the renderer already
  // consumes as f32 — a frame counter, compass degrees, a size multiplier. The
  // f64→f32 round-trip is therefore invisible; it is the same statistical-parity
  // stance the rest of the WebGPU agent SoA takes.
  if (spriteRunsActive(rt)) {
    const spriteSrc: Record<string, ArrayLike<number>> = {
      spriteIds: s.spriteIds, spriteFrames: s.spriteFrames, spriteSpeeds: s.spriteSpeeds,
      spriteRotations: s.spriteRotations, spriteScales: s.spriteScales,
    };
    for (const field of AGENT_GPU_SPRITE_FIELDS) {
      const base = L.f32Base[field];
      if (base === undefined) continue;
      const src = spriteSrc[field];
      const n = src ? Math.min(hw, src.length) : 0;   // 0-length when the C9 gate dropped it CPU-side
      for (let i = 0; i < n; i++) f[base + i] = src![i]!;
      for (let i = n; i < ma; i++) f[base + i] = 0;
    }
  }
  // Per-RUN uploads of the live prefix, instead of one whole-buffer write sized by
  // the maxAgents ceiling. ~30-50 small writeBuffer calls replace a single ~15 MB
  // one at a 60 000 ceiling with ~2 000 agents.
  for (const field of f32Fields) {
    const base = L.f32Base[field];
    if (base === undefined) continue;
    putF32(base, AGENT_GPU_QUEUE_FIELDS.has(field) ? L.bondReqSlots : 1);
  }
  for (const id of L.agentAttrIds) {
    const base = L.agentAttrBase[id]!;
    putF32(base, 1);
    const wbase = L.agentAttrWriteBase[id];
    if (wbase !== undefined && wbase !== base) putF32(wbase, 1);
  }
  for (const id of L.bondAttrIds) {
    const base = L.bondFormAttrBase[id];
    if (base !== undefined) putF32(base, L.bondReqSlots);
  }
  if (spriteRunsActive(rt)) {
    for (const field of AGENT_GPU_SPRITE_FIELDS) {
      const base = L.f32Base[field];
      if (base !== undefined) putF32(base, 1);
    }
  }

  // i32 fields — lineage / bondCount.
  const i32Src: Record<string, Int32Array> = { lineage: s.lineage, bondCount: s.bondCount };
  for (const field of AGENT_GPU_I32_FIELDS) {
    const base = L.i32Base[field]!;
    const src = i32Src[field];
    if (!src) continue;
    for (let i = 0; i < hw; i++) ix[base + i] = src[i]!;
    for (let i = hw; i < ma; i++) ix[base + i] = 0;
  }
  for (const field of AGENT_GPU_I32_FIELDS) {
    const base = L.i32Base[field];
    if (base !== undefined) rt.device.queue.writeBuffer(rt.agentI32Buf, base * 4, ix, base, ma);
  }

  // alive mask → one u32/agent.
  for (let i = 0; i < hw; i++) al[i] = s.alive[i]!;
  for (let i = hw; i < ma; i++) al[i] = 0;
  rt.device.queue.writeBuffer(rt.agentAliveBuf, 0, al, 0, ma);

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

/** C10 / P11a — upload the CPU-built Barnes–Hut octree for this generation (the
 *  `uploadAgentHash` precedent: one CPU structure, one write per buffer). Packs
 *  the tree's LIVE prefix into the layout's runs; the shader never reads past
 *  `treeNodeCount` / the live point count, so the tails stay whatever they were.
 *  Returns false when the runtime has no tree buffers (a non-global model) or the
 *  tree overflows the reserve — the caller then leaves `chargeGlobal` at 0 rather
 *  than dispatching a traversal over a truncated tree. */
export function uploadAgentChargeTree(
  rt: AgentWebGPURuntime,
  tree: {
    nodeCount: number; pointCount: number;
    sortedX: Float64Array; sortedY: Float64Array; sortedZ: Float64Array;
    nodeCx: Float64Array; nodeCy: Float64Array; nodeCz: Float64Array; nodeExt: Float64Array;
    nodeStart: Int32Array; nodeEnd: Int32Array; nodeNext: Int32Array;
  } | null,
): boolean {
  const L = rt.layout;
  if (!tree || !rt.chargeTreeF32Buf || !rt.chargeTreeI32Buf || !rt.chargeTreeUploadF32 || !rt.chargeTreeUploadI32) return false;
  const nN = tree.nodeCount, nP = tree.pointCount;
  if (nN > L.chargeTreeNodes || nP > L.maxAgents) return false;
  const f = rt.chargeTreeUploadF32, i = rt.chargeTreeUploadI32;
  for (let k = 0; k < nN; k++) {
    f[L.treeNodeCxBase + k] = tree.nodeCx[k]!;
    f[L.treeNodeCyBase + k] = tree.nodeCy[k]!;
    f[L.treeNodeCzBase + k] = tree.nodeCz[k]!;
    f[L.treeNodeExtBase + k] = tree.nodeExt[k]!;
    i[L.treeNodeStartBase + k] = tree.nodeStart[k]!;
    i[L.treeNodeEndBase + k] = tree.nodeEnd[k]!;
    i[L.treeNodeNextBase + k] = tree.nodeNext[k]!;
  }
  for (let k = 0; k < nP; k++) {
    f[L.treeSortedXBase + k] = tree.sortedX[k]!;
    f[L.treeSortedYBase + k] = tree.sortedY[k]!;
    f[L.treeSortedZBase + k] = tree.sortedZ[k]!;
  }
  rt.device.queue.writeBuffer(rt.chargeTreeF32Buf, 0, f.buffer, f.byteOffset, Math.max(4, L.chargeTreeF32Len * 4));
  rt.device.queue.writeBuffer(rt.chargeTreeI32Buf, 0, i.buffer, i.byteOffset, Math.max(4, L.chargeTreeI32Len * 4));
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
  // THE ACTIVE WINDOW — one agent's block is `mb * S` ints, so only the live
  // prefix is packed and uploaded (the ceiling's tail is already zero on the GPU
  // and is never read: the shader's bond loops run to bondCount).
  const win = agentActiveWindow(rt, s.highWater);
  const outLen = Math.min(L.bondStoreLen, Math.max(1, win * mb * S));
  const out = rt.bondStoreUpload && rt.bondStoreUpload.length >= outLen
    ? rt.bondStoreUpload.subarray(0, outLen)
    : (rt.bondStoreUpload = new Int32Array(outLen));
  out.fill(0);
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
  rt.device.queue.writeBuffer(rt.bondStoreBuf, 0, out, 0, outLen);
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
  // C9 / STEP 6 (absent ⇒ 2 = force = the historical engine).
  u[29] = (fp.motionMode ?? 2) >>> 0;
  // C10 / P11a — GLOBAL charge (absent ⇒ 0 ⇒ the traversal branch is never taken).
  u[30] = (fp.chargeGlobal ?? 0) >>> 0;
  fl[31] = fp.chargeTheta2 ?? 0;
  u[32] = (fp.treeNodeCount ?? 0) >>> 0;
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
  /** The glow HDR accumulation target (rgba16float, canvas-sized) + the compose
   *  pipeline that tonemaps it onto the canvas. Allocated lazily on the first
   *  glow present (ensureGlowHdrTex) so a glow-off model pays nothing. */
  glowHdrTex?: GPUTexture | null;
  glowHdrView?: GPUTextureView | null;
  glowHdrW?: number;
  glowHdrH?: number;
  glowComposePipeline?: GPURenderPipeline | null;
  glowComposeBGL?: GPUBindGroupLayout | null;
  glowComposeBindGroup?: GPUBindGroup | null;
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
  // Scene-anchored wireframes (bounds / floor grid / origin axes), drawn in the
  // SAME render pass + depth buffer as the spheres so agents in front occlude
  // them — the agent-sphere sibling of the L1 voxel line pass. Geometry comes
  // from the SHARED buildSceneWireframeVerts (mirrors gl3d's renderOverlays).
  renderLinePipeline?: GPURenderPipeline | null;
  renderLineBindGroup?: GPUBindGroup | null;
  renderLineBuf?: GPUBuffer | null;
  renderLineCount?: number;
  renderLineSig?: string;
  /** Which wireframe groups to draw (mirrors the panel's Viz3D toggles). */
  renderViz?: SceneViz;
  /** (W-1)/2, (H-1)/2, (D-1)/2 from the last RenderView3D — the ONLY source the
   *  line geometry derives its dims from, so lines and spheres share one frame. */
  renderHalf3D?: [number, number, number];
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
  /** Solid-core fraction of the glow band (0..1) — the SOLID (opaque, never
   *  added-out) body radius is `radPx + glowCore * glowSize`, and the additive
   *  halo falls off from there to `radPx + glowSize`. 0 ⇒ the core is exactly the
   *  agent disc. APPENDED LAST on purpose so every pre-existing member keeps its
   *  byte offset (the ForceControl.motionMode / VoxelView precedent); the
   *  verify-render-uniform-layouts harness pairs struct ⇄ writer by offset. */
  glowCore: number;
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
  glowCore      : f32,
};`;

/** Build the agent render module (VS pulls x/y/radius from agentF32 + packed
 *  RGBA from agentColors). TWO entry-point pairs, drawn as TWO passes when Glow
 *  is on (see presentAgentsEncode):
 *
 *    vsGlow/fsGlow — the SCREEN-blended HALO, over a quad enlarged to
 *                    `radPx+glowSize` (see glowBlend in buildAgentDiscPipelines).
 *    vsMain/fsMain — the SOLID CORE disc (premultiplied source-over), radius
 *                    `radPx + glowCore*glowSize`, + the optional outline rim.
 *
 *  HALO FIRST, CORE OVER IT. Glow used to REPLACE the disc (one additive draw
 *  from the centre out), so an isolated agent had no solid body at all — its
 *  centre read as `intensity·colour`, which is dim at low intensity and blows
 *  clusters to white at high intensity. That is the trade the Core slider
 *  removes: the core is opaque, so it can never be washed out or faded out, and
 *  the falloff only spans the band OUTSIDE it (t is remapped over
 *  [coreFrac, 1] instead of [0, 1]), where accumulation is what you want.
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
  @builtin(position) pos      : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
  @location(1)       col      : vec4<f32>,
  @location(2)       radPx    : f32,
  @location(3)       coreFrac : f32,
};

// One vertex builder, two quad sizes: halo=true widens the quad to the full
// glow radius; otherwise it is the solid-core radius. (NB this WGSL lives in a
// TS template literal - never put a backtick in these comments.)
fn buildVert(vi: u32, inst: u32, halo: bool) -> VSOut {
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
    out.coreFrac = 0.0;
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
  // The SOLID (opaque) body radius: the plain disc when glow is off, grown into
  // the halo band by Core when it is on.
  var coreR: f32 = radPx;
  if (rv.glowOn != 0u) { coreR = radPx + clamp(rv.glowCore, 0.0, 1.0) * rv.glowSize; }
  let outerR: f32 = max(0.001, radPx + rv.glowSize);
  var half: f32 = max(0.001, coreR);
  if (halo) { half = outerR; }
  // ANTI-ALIASING PAD. The FS coverage ramp straddles d == 1 (half a pixel in,
  // half a pixel out), but the quad CIRCUMSCRIBES the disc - they are tangent at
  // the four axis points, so without a pad the outer half of the ramp would be
  // clipped exactly there and the silhouette would keep four hard notches. Grow
  // the quad by one pixel and rescale uv so d == 1 still marks the DRAWN radius
  // (out.radPx stays the UNPADDED radius, so the outline band is unaffected).
  // The extra ring of fragments discards at cov == 0.
  let padded: f32 = half + 1.0;
  let sx: f32 = px + corner.x * padded;
  let sy: f32 = py + corner.y * padded;
  out.pos = vec4<f32>(sx / rv.canvasW * 2.0 - 1.0, 1.0 - sy / rv.canvasH * 2.0, 0.0, 1.0);
  out.uv = corner * (padded / half);
  out.col = vec4<f32>(f32(packed & 0xffu) / 255.0, f32((packed >> 8u) & 0xffu) / 255.0, f32((packed >> 16u) & 0xffu) / 255.0, a);
  out.radPx = half;
  // Where the core ends, in the HALO quad's uv units (only the halo FS reads it).
  out.coreFrac = clamp(coreR / outerR, 0.0, 1.0);
  return out;
}

@vertex
fn vsMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  return buildVert(vi, inst, false);
}

@vertex
fn vsGlow(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  return buildVert(vi, inst, true);
}

// The SOLID core disc — premultiplied source-over, so it is never added out.
@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  let d: f32 = length(in.uv);
  // ANTI-ALIASING - analytic edge coverage, ALWAYS ON. fwidth(d) is the per-pixel
  // step of d, so this is a one-pixel linear coverage ramp centred on the true
  // silhouette (cov == 0.5 exactly at d == 1) - the same half-in/half-out coverage
  // Canvas2D's arc fill already produces on the CPU overlay. Without it the rim is
  // a binary discard and the disc reads SERRATED, which is the whole difference
  // users saw between an overlay model and a direct-render one. Computed BEFORE
  // any discard so the derivative is taken in uniform control flow.
  let pxw: f32 = max(fwidth(d), 1.0e-5);
  let cov: f32 = clamp((1.0 - d) / pxw + 0.5, 0.0, 1.0);
  if (cov <= 0.0) { discard; }
  var rgb: vec3<f32> = in.col.rgb;
  let a: f32 = in.col.a * cov;
  if (rv.outlineOn != 0u) {
    // Match the 2D overlay rim rule (stampBatchedTile): darken the outer
    // min(1.5px, 0.25*rad) band by ×0.60. in.radPx is the DRAWN body radius
    // (== radPx when glow is off, the core radius when it is on), so the rim
    // always hugs the silhouette the user sees. Feathered with the SAME
    // derivative, so the band reads like the antialiased stroke() the overlay
    // draws instead of a second hard step inside the body.
    let radPx: f32 = max(0.001, in.radPx);
    let rim: f32 = min(1.5, 0.25 * radPx) / radPx;
    let t: f32 = clamp((d - (1.0 - rim)) / pxw + 0.5, 0.0, 1.0);
    rgb = rgb * mix(1.0, 0.60, t);
  }
  // Premultiplied output (the canvas is configured 'premultiplied').
  return vec4<f32>(rgb * a, a);
}

// The HALO — accumulated ADDITIVELY and UNCLAMPED into an rgba16float HDR target
// (see glowBlend + ensureGlowHdrTex), never straight onto the canvas. The falloff
// is remapped over the BAND [coreFrac, 1] so the whole dynamic range lands outside
// the solid core instead of being spent inside the body. It needs no coverage ramp
// of its own: t (and therefore the emitted value) already reaches zero CONTINUOUSLY
// at d == 1, so the halo edge was never aliased. The discard just trims the AA pad
// ring the vertex builder adds.
//
// THERE IS NO CLAMP ANY MORE, AND ITS ABSENCE IS THE POINT. The halo used to be
// SCREEN-blended straight onto the canvas with g clamped to [0,1] (the clamp was
// load-bearing there — screen's dst factor is (1-src), so an emitted value above 1
// SUBTRACTS the backdrop). That clamp made every agent carry a hard-edged, fully
// saturated PLATEAU DISC wherever intensity*t^steepness >= 1 — at the shipped
// Intensity 3 that disc covers most of the band, which is exactly the "oversaturated,
// contrast-artifact" look. Writing raw radiance into HDR and compressing ONCE, at
// compose time, removes the plateau by construction: no channel can be pinned.
@fragment
fn fsGlow(in: VSOut) -> @location(0) vec4<f32> {
  let d: f32 = length(in.uv);
  if (d > 1.0) { discard; }
  let band: f32 = max(1.0e-4, 1.0 - in.coreFrac);
  let t: f32 = clamp((1.0 - d) / band, 0.0, 1.0);
  let g: f32 = max(0.0, rv.glowIntensity * pow(t, max(0.01, rv.glowSteepness)));
  return vec4<f32>(in.col.rgb * g, g);
}`;
}

/** The HDR→canvas glow compose pass. A fullscreen triangle that reads the
 *  accumulated halo radiance, tonemaps it ONCE with Reinhard-Jodie, and
 *  SCREEN-blends the single result onto the canvas.
 *
 *  WHY A TONEMAP AND NOT A CLEVERER BLEND (the reference's whole lesson —
 *  studied from SandboxScience's particle-life-gpu shaders): a per-pair blend is
 *  MEMORYLESS, so N stacked halos of per-halo display value p always give
 *  1-(1-p)^N — screen, additive-with-clip, anything. That family exhausts the
 *  display range after ~4 overlaps for any p bright enough to see one halo, which
 *  is the plateau. Their renderer instead accumulates every particle additively
 *  into an rgba16float HDR target and compresses ONCE at compose time (ACES in
 *  particle-life-gpu/shaders/compose/compose_hdr.wgsl, Reinhard-Jodie / ACES /
 *  Lottes / AGX selectable in the 3D one). A tonemap sees the EXACT sum, so it can
 *  spend its shoulder where the density actually is.
 *
 *  THE CURVE IS APPLIED TO THE ACCUMULATED MAGNITUDE, AND THE HUE IS KEPT EXACT.
 *  The halo pass writes `Σ colour·g` into rgb and `Σ g` into alpha, so the mean
 *  contributing colour is `rgb/alpha` and the magnitude is `alpha`; the compose
 *  tonemaps the magnitude and re-applies that hue. This is the `c/(1+l)` branch of
 *  the reference's Reinhard-Jodie taken to its limit, chosen over the full Jodie
 *  mix (and over per-channel Reinhard) for one measured reason: BOTH of those
 *  desaturate the highlights, and desaturating highlights is exactly the
 *  "oversaturated look" that was reported. Measured on the same dense frame at the
 *  shipped Intensity 3, halo pixels with a channel pinned at 255: per-channel
 *  additive 37%, full Jodie 68%, hue-exact 2.5%; halo pixels that are near-WHITE:
 *  12.7% / 0.18% / 0.03%. It is also what makes the CPU sibling term-for-term
 *  identical (its whole design rests on the magnitude living in the alpha
 *  channel — see glowTone.ts), so the two 2D paths cannot look different.
 *
 *  Reinhard is chosen over ACES-Narkowicz because ACES maps 1.0 -> 0.80 and has
 *  slope 0.21 at the origin — it expects scene-referred radiance where 1.0 is
 *  mid-grey, and would darken a sparse field to a fifth. Reinhard has slope 1 at
 *  the origin (a faint halo is untouched) and a POWER-LAW shoulder, which is what
 *  keeps the densest cores discriminating: x/(1+x) still separates 5 overlaps
 *  (0.90) from 30 (0.98) where an exponential shoulder is flat at 1.0 by 5.
 *
 *  The composite against the backdrop stays SCREEN, exactly as before, so every
 *  property that rule bought is unchanged (a halo can only brighten the grid,
 *  never darken or overshoot it; the transparent agent canvas still composites
 *  over the page). What changed is that the compression now happens ONCE, on the
 *  exact sum, instead of once per overlapping pair. */
const GLOW_COMPOSE_WGSL = `
const GLOW_EXPOSURE : f32 = ${GLOW_TONE_EXPOSURE.toFixed(4)};

@group(0) @binding(0) var glowHdr : texture_2d<f32>;

@vertex
fn vsGlowCompose(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p: vec2<f32> = vec2<f32>(-1.0, -1.0);
  if (vi == 1u) { p = vec2<f32>(3.0, -1.0); }
  else if (vi == 2u) { p = vec2<f32>(-1.0, 3.0); }
  return vec4<f32>(p, 0.0, 1.0);
}

@fragment
fn fsGlowCompose(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let hdr: vec4<f32> = textureLoad(glowHdr, vec2<i32>(pos.xy), 0);
  let mag: f32 = hdr.a;                                  // the exact sum of g
  if (mag <= 0.0) { discard; }
  let hue: vec3<f32> = hdr.rgb / mag;                     // weighted mean colour
  let x: f32 = mag * GLOW_EXPOSURE;
  let t: f32 = x / (1.0 + x);                            // Reinhard on the magnitude
  // Premultiplied by construction: hue's channels are <= 1, so rgb <= a — VALID
  // for the 'premultiplied' canvas, and the same pixel the CPU filter produces.
  return vec4<f32>(clamp(hue, vec3<f32>(0.0), vec3<f32>(1.0)) * t, t);
}`;

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

/** Scene-anchored wireframe overlays (bounds box / floor grid / origin axes) for
 *  the 3D agent free mode, drawn in the SAME render pass + depth buffer as the
 *  sphere impostors so agents in front occlude them. Reuses the RenderView3D
 *  uniform (mvp @0) — no new uniform, no RenderView3D widening (which would move
 *  every later member; see verify-render-uniform-layouts.mjs). Line-list; pos +
 *  colour vertex attributes; depth-test ON + depth-write ON.
 *
 *  THE BUG THIS CLOSES: gl3d in `overlaysOnly` mode composites on a canvas ABOVE
 *  the sphere canvas with a transparent clear, so anything it drew there had NO
 *  depth relationship with the spheres — the floor grid / bounds / axes always
 *  painted IN FRONT of the agents. Reported as "move the cursor out of the canvas
 *  and the grid starts being drawn in front of the agents" (leaving the canvas
 *  releases the UI-sync pin ⇒ free mode ⇒ the two-canvas split). */
const AGENT_LINE_WGSL = `${RENDER_VIEW_3D_WGSL}
@group(0) @binding(0) var<uniform> rv : RenderView3D;
struct LOut { @builtin(position) pos : vec4<f32>, @location(0) color : vec3<f32> };
@vertex
fn vsLine(@location(0) p : vec3<f32>, @location(1) c : vec3<f32>) -> LOut {
  var out : LOut;
  var q : vec4<f32> = rv.mvp * vec4<f32>(p, 1.0);
  // DEPTH-CONVENTION MATCH — the load-bearing line of this pass. mvp is a
  // GL-convention projection (NDC z in [-1,1]) and the SPHERE fragment shader
  // writes its own depth as (clip.z/clip.w)*0.5 + 0.5, i.e. remapped to [0,1].
  // A rasterizer-generated depth is clip.z/clip.w with NO remap, so leaving this
  // out puts the lines in a DIFFERENT depth space from the spheres: every line
  // reads as nearer than it is and wins against ~29% of a sphere's pixels (found
  // by pixel probe, not by inspection). q.z = (q.z + q.w)*0.5 is the standard
  // GL-to-WebGPU clip-z remap, making the rasterized depth exactly the sphere's
  // formula. (The voxel line pass needs no such remap — its cubes use rasterizer
  // depth too, so both sides already share one convention.)
  q.z = (q.z + q.w) * 0.5;
  out.pos = q;
  out.color = c;
  return out;
}
@fragment
fn fsLine(in : LOut) -> @location(0) vec4<f32> {
  // Opaque lines; the canvas is premultiplied-alpha, alpha 1 ⇒ colour as-is.
  return vec4<f32>(in.color, 1.0);
}`;

/** Set which scene wireframes the 3D agent render draws (mirrors the panel's
 *  Viz3D axes/grid/bounds). Clears the geometry cache so the next present
 *  rebuilds. The agent sibling of uploadVoxelViz. */
export function uploadAgentViz(rt: AgentRenderSurface, viz: SceneViz): void {
  rt.renderViz = { axes: !!viz.axes, grid: !!viz.grid, bounds: !!viz.bounds };
  rt.renderLineSig = '';   // force a rebuild on the next present
}

/** (Re)build the wireframe vertex buffer when the viz flags or the world dims
 *  change. No-op when the signature is unchanged. The dims come from the LAST
 *  RenderView3D's half-extents (W = 2·halfX + 1, exact for integer dims), so the
 *  lines and the spheres can never disagree about the world frame. */
function ensureAgentLineBuffer(rt: AgentRenderSurface): void {
  // No camera yet (the attach presents once before the first setAgentCamera) —
  // the world dims are unknown, so draw nothing rather than a degenerate 1×1×1
  // box at the origin for that one frame.
  if (!rt.renderHalf3D) { rt.renderLineCount = 0; return; }
  const [hx, hy, hz] = rt.renderHalf3D;
  const viz = rt.renderViz ?? { axes: false, grid: false, bounds: false };
  const sig = `${viz.axes ? 1 : 0}${viz.grid ? 1 : 0}${viz.bounds ? 1 : 0}|${hx}|${hy}|${hz}`;
  if (sig === rt.renderLineSig && (rt.renderLineBuf || (rt.renderLineCount ?? 0) === 0)) return;
  rt.renderLineSig = sig;
  const W = Math.max(1, Math.round(2 * hx + 1)), H = Math.max(1, Math.round(2 * hy + 1)), D = Math.max(1, Math.round(2 * hz + 1));
  const verts = (viz.axes || viz.grid || viz.bounds) ? buildSceneWireframeVerts(W, H, D, viz) : new Float32Array(0);
  rt.renderLineCount = verts.length / 6;
  if (rt.renderLineBuf) { try { rt.renderLineBuf.destroy(); } catch { /* non-fatal */ } rt.renderLineBuf = null; }
  if (verts.length === 0) return;
  const buf = rt.device.createBuffer({
    label: 'agent-scene-lines', size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  rt.device.queue.writeBuffer(buf, 0, verts);
  rt.renderLineBuf = buf;
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

/** The glow HDR accumulation format. rgba16float is renderable AND blendable in
 *  core WebGPU (rgba32float is neither blendable nor guaranteed), which is what
 *  lets the halo pass sum with a plain additive blend and no clipping. */
const GLOW_HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/** Lazily (re)allocate the canvas-sized HDR halo target + its compose bind group.
 *  Returns null when the compose pipeline isn't built (then the caller skips the
 *  glow entirely rather than rendering a wrong one). */
function ensureGlowHdrTex(rt: AgentRenderSurface, w: number, h: number): GPUTextureView | null {
  if (!rt.glowComposeBGL || !rt.glowComposePipeline) return null;
  const W = Math.max(1, w), H = Math.max(1, h);
  if (!rt.glowHdrTex || rt.glowHdrW !== W || rt.glowHdrH !== H) {
    if (rt.glowHdrTex) { try { rt.glowHdrTex.destroy(); } catch { /* non-fatal */ } }
    rt.glowHdrTex = rt.device.createTexture({
      label: 'agent-glow-hdr', size: { width: W, height: H },
      format: GLOW_HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    rt.glowHdrView = rt.glowHdrTex.createView();
    rt.glowHdrW = W; rt.glowHdrH = H;
    rt.glowComposeBindGroup = rt.device.createBindGroup({
      label: 'agent-glow-compose-bg', layout: rt.glowComposeBGL,
      entries: [{ binding: 0, resource: rt.glowHdrView }],
    });
  }
  return rt.glowHdrView ?? null;
}

function destroyGlowHdrTex(rt: AgentRenderSurface): void {
  if (rt.glowHdrTex) { try { rt.glowHdrTex.destroy(); } catch { /* non-fatal */ } }
  rt.glowHdrTex = null; rt.glowHdrView = null;
  rt.glowComposeBindGroup = null;
  rt.glowHdrW = 0; rt.glowHdrH = 0;
}

/** Append the HDR halo accumulation pass (additive, cleared to zero). Returns
 *  false when the HDR target could not be built — the caller then skips the
 *  compose too, so a failure degrades to "no glow", never to a wrong one. */
function encodeGlowHdrPass(rt: AgentRenderSurface, enc: GPUCommandEncoder, w: number, h: number, insts: number): boolean {
  if (!rt.renderGlowPipeline || !rt.renderBindGroup) return false;
  const hdrView = ensureGlowHdrTex(rt, w, h);
  if (!hdrView) return false;
  const gp = enc.beginRenderPass({
    label: 'agent-glow-hdr-pass',
    colorAttachments: [{ view: hdrView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  gp.setPipeline(rt.renderGlowPipeline);
  gp.setBindGroup(0, rt.renderBindGroup);
  gp.draw(4, insts);
  gp.end();
  return true;
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
  // The wireframe geometry derives its world dims from THESE half-extents (one
  // source shared with the spheres). A dims change invalidates the cached buffer
  // via ensureAgentLineBuffer's signature.
  rt.renderHalf3D = [v.halfX, v.halfY, v.halfZ];
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
    // Scene-wireframe (bounds/grid/axes) line pipeline — reuses the RenderView3D
    // uniform (mvp) so it shares projection with the spheres, and depth-tests
    // against the SAME buffer the sphere pass writes, so agents in front occlude
    // it. A compile failure fails the WHOLE 3D setup (the voxel precedent): the
    // main thread then keeps gl3d frame mode, which draws the wireframes with
    // correct depth — never "free mode with no wireframes at all".
    const lineModule = rt.device.createShaderModule({ label: 'agent-scene-line', code: AGENT_LINE_WGSL });
    {
      const linfo = await lineModule.getCompilationInfo();
      const lerrs = linfo.messages.filter(m => m.type === 'error');
      if (lerrs.length > 0) {
        // eslint-disable-next-line no-console
        console.error('[agents/webgpu] scene-line WGSL compile errors:\n' + lerrs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
        return false;
      }
    }
    const lineBgl = rt.device.createBindGroupLayout({
      label: 'agent-scene-line-bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    const linePipeline = rt.device.createRenderPipeline({
      label: 'agent-scene-line', layout: rt.device.createPipelineLayout({ label: 'agent-scene-line-pl', bindGroupLayouts: [lineBgl] }),
      vertex: {
        module: lineModule, entryPoint: 'vsLine',
        buffers: [{ arrayStride: 24, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ] }],
      },
      fragment: { module: lineModule, entryPoint: 'fsLine', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const lineBindGroup = rt.device.createBindGroup({
      label: 'agent-scene-line-bg', layout: lineBgl,
      entries: [{ binding: 0, resource: { buffer: renderView3DBuf } }],
    });
    const renderBindGroup = rt.device.createBindGroup({
      label: 'agent-sphere-bg', layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: rt.agentF32Buf } },
        { binding: 1, resource: { buffer: rt.agentAliveBuf } },
        { binding: 2, resource: { buffer: rt.agentColorsBuf } },
        { binding: 3, resource: { buffer: renderView3DBuf } },
      ],
    });
    // ---- ATOMIC COMMIT — NO await below this line (see the ordering rule on
    // buildAgentDiscPipelines): every field points at the new resources before
    // anything old is destroyed, so a present landing mid-rebuild can never see a
    // live field referencing a destroyed one. -------------------------------
    const oldView3DBuf = rt.renderView3DBuf;
    const oldLineBuf = rt.renderLineBuf;
    rt.renderCanvas = canvas;
    rt.renderCtx = ctx;
    rt.render3D = true;
    rt.renderView3DBuf = renderView3DBuf;
    rt.renderSpherePipeline = pipeline;
    rt.renderSphereBindGroup = renderBindGroup;
    rt.renderLinePipeline = linePipeline;
    rt.renderLineBindGroup = lineBindGroup;
    // A re-attach rebuilds on the SAME surface — the old vertex buffer belongs to
    // the old view uniform's signature; force a rebuild against the current viz.
    rt.renderLineBuf = null;
    rt.renderLineCount = 0;
    rt.renderLineSig = '';
    rt.renderActive = true;
    rt.renderClear = [0, 0, 0, 0];
    // Audit L5 (3D sibling): a re-attach rebuilds on the SAME surface — release the
    // previous resources rather than orphaning them. LAST, once nothing points at them.
    if (oldView3DBuf) { try { oldView3DBuf.destroy(); } catch { /* non-fatal */ } }
    if (oldLineBuf) { try { oldLineBuf.destroy(); } catch { /* non-fatal */ } }
    return true;
  } catch {
    rt.renderActive = false;
    return false;
  }
}

/** Build the 2D disc render pipelines + bind group + view uniform on `rt` (the
 *  canvas must already be configured). Shared by the standalone disc render
 *  (setupAgentDiscRender) and the E2 composite (setupAgentCompositeRender), so
 *  the two paths can't drift on the disc pass. Returns false on a WGSL error.
 *
 *  ⚠ THE SWAP IS ATOMIC — every `await` and every resource creation happens
 *  BEFORE the first `rt.*` write, the commit block below has NO await in it, and
 *  the OLD resources are destroyed LAST. That ordering is load-bearing, not
 *  tidiness: this function is `async` and a re-attach fires on every real
 *  display-size change, so the worker's event loop runs OTHER messages at each
 *  await — and `rt.renderActive` is still true throughout, so a `setAgentCamera`
 *  / `refreshAgentDisplay` / batch-tail `sendColors` present can land mid-rebuild
 *  and encode+submit against whatever `rt` holds at that instant.
 *
 *  The shipped bug this fixes: the old code destroyed `rt.renderViewBuf` and THEN
 *  awaited the compose module's compilation info before building the matching
 *  bind group — so for that window `rt.renderBindGroup` still referenced the
 *  DESTROYED buffer, and any present in it submitted it:
 *      [Buffer "agent-render-view"] used in submit while destroyed.
 *       - While calling [Queue].Submit([[CommandBuffer from CommandEncoder
 *         "agent-present-once"]])
 *  (reported on a canvas-fullscreen toggle, which collapses several panels and
 *  can post more than one attach — two overlapping rebuilds widen that window to
 *  span a whole other attach's awaits).
 *
 *  THE GENERAL RULE for every GPU resource swap in this file and its siblings:
 *  either (a) build everything new, commit in ONE synchronous block, destroy the
 *  old last — as here; or (b) NULL every field that references the destroyed
 *  resource in the same synchronous block as the destroy, so every consumer's
 *  guard turns a mid-rebuild present into a no-op (what `releaseVoxelResources`
 *  does). Doing NEITHER — destroying a resource while a live field still points
 *  at it — is the defect class.
 *
 *  Destroying immediately after the atomic commit is safe: encode and submit are
 *  synchronous in every present path, so no command buffer can be recorded-but-
 *  unsubmitted across the swap, and an ALREADY-submitted one completes normally
 *  per spec. No `onSubmittedWorkDone` deferral is needed. */
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
  const mkPipe = (label: string, blend: GPUBlendState, vs: string, fs: string): GPURenderPipeline => rt.device.createRenderPipeline({
    label, layout: pl,
    vertex: { module, entryPoint: vs },
    fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
    primitive: { topology: 'triangle-strip' },
  });
  const plainBlend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  // PURE ADDITIVE — but into the rgba16float HDR target, NOT the canvas. Additive
  // is only ever wrong when the destination CLIPS; in float it is the exact sum,
  // which is precisely what the compose pass needs to tonemap. (Historically this
  // was additive straight onto the 8-bit canvas — which clipped, giving the hard
  // iso-line + hue collapse — and was then changed to SCREEN onto the canvas, which
  // removed the clip but replaced it with a per-PAIR compression that exhausts the
  // display range after ~4 overlaps. Accumulate-exactly-then-compress-once is the
  // architecture the reference uses and the one that fixes both.)
  const glowBlend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  };
  // The tonemapped halo layer composites onto the canvas with SCREEN — the same
  // rule the per-halo pass used, applied ONCE. Screen's own alpha rule is
  // source-over, which is what keeps the transparent agent canvas compositing
  // correctly over the page / the E2 grid layer.
  const glowComposeBlend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  // The HDR→canvas compose (its own module + bind-group layout: one sampled
  // texture). Its await is done HERE — before any rt.* write — so the commit
  // block below is uninterruptible.
  const composeModule = rt.device.createShaderModule({ code: GLOW_COMPOSE_WGSL });
  const composeInfo = await composeModule.getCompilationInfo();
  const composeErrs = composeInfo.messages.filter(m => m.type === 'error');
  if (composeErrs.length > 0) {
    // eslint-disable-next-line no-console
    console.error('[agents/webgpu] glow compose WGSL compile errors:\n' + composeErrs.map(m => `  line ${m.lineNum}: ${m.message}`).join('\n'));
    return false;
  }
  const composeBGL = rt.device.createBindGroupLayout({
    label: 'agent-glow-compose-bgl',
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }],
  });
  const composePipeline = rt.device.createRenderPipeline({
    label: 'agent-glow-compose',
    layout: rt.device.createPipelineLayout({ label: 'agent-glow-compose-pl', bindGroupLayouts: [composeBGL] }),
    vertex: { module: composeModule, entryPoint: 'vsGlowCompose' },
    fragment: { module: composeModule, entryPoint: 'fsGlowCompose', targets: [{ format, blend: glowComposeBlend }] },
    primitive: { topology: 'triangle-list' },
  });
  const renderViewBuf = rt.device.createBuffer({ label: 'agent-render-view', size: RENDER_VIEW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const plainPipeline = mkPipe('agent-render-plain', plainBlend, 'vsMain', 'fsMain');
  // The halo pipeline targets the HDR format, so it CANNOT share mkPipe's canvas target.
  const glowPipeline = rt.device.createRenderPipeline({
    label: 'agent-render-glow', layout: pl,
    vertex: { module, entryPoint: 'vsGlow' },
    fragment: { module, entryPoint: 'fsGlow', targets: [{ format: GLOW_HDR_FORMAT, blend: glowBlend }] },
    primitive: { topology: 'triangle-strip' },
  });
  const renderBindGroup = rt.device.createBindGroup({
    label: 'agent-render-bg', layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: rt.agentF32Buf } },
      { binding: 1, resource: { buffer: rt.agentAliveBuf } },
      { binding: 2, resource: { buffer: rt.agentColorsBuf } },
      { binding: 3, resource: { buffer: renderViewBuf } },
    ],
  });

  // ---- ATOMIC COMMIT — NO await below this line, and nothing is destroyed
  // until every field points at the new resources. -------------------------
  const oldViewBuf = rt.renderViewBuf;
  rt.renderViewBuf = renderViewBuf;
  rt.renderPlainPipeline = plainPipeline;
  rt.renderGlowPipeline = glowPipeline;
  rt.glowComposeBGL = composeBGL;
  rt.glowComposePipeline = composePipeline;
  rt.renderBindGroup = renderBindGroup;
  // A re-attach rebuilds the pipelines on the SAME surface — drop the previous HDR
  // target (its bind group belongs to the OLD compose layout) instead of orphaning
  // it. Must follow the glowComposeBGL commit: the next ensureGlowHdrTex rebuilds
  // the target's bind group against whatever layout `rt` now holds.
  destroyGlowHdrTex(rt);
  // Audit L5: a re-attach (every real display-size change) rebuilds the pipelines
  // on the SAME surface — release the previous view uniform instead of orphaning
  // it. LAST, so no live field ever references a destroyed buffer.
  if (oldViewBuf) { try { oldViewBuf.destroy(); } catch { /* non-fatal */ } }
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
    const gridPipeline = rt.device.createRenderPipeline({
      label: 'grid-present', layout: gpl,
      vertex: { module: gmod, entryPoint: 'vsMain' },
      fragment: { module: gmod, entryPoint: 'fsMain', targets: [{ format }] },   // opaque write (loadOp clear)
      primitive: { topology: 'triangle-list' },
    });
    const gridUniform = rt.device.createBuffer({ label: 'grid-plane-view', size: GRID_PLANE_VIEW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // ---- ATOMIC COMMIT — NO await below this line (the ordering rule on
    // buildAgentDiscPipelines). The previous grid uniform was PREVIOUSLY replaced
    // without being destroyed — a small leak on every re-attach; it is released
    // last, once nothing references it. -------------------------------------
    const oldGridUniform = rt.gridPresentUniform;
    rt.gridPresentPipeline = gridPipeline;
    rt.gridPresentBGL = gbgl;
    rt.gridPresentUniform = gridUniform;
    rt.renderCanvas = canvas;
    rt.renderCtx = ctx;
    rt.renderActive = true;
    rt.renderComposite = true;
    rt.renderClear = [0, 0, 0, 0];
    rt.renderGlow = false;
    if (oldGridUniform) { try { oldGridUniform.destroy(); } catch { /* non-fatal */ } }
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
    const copies = Math.max(1, rt.renderCopiesX ?? 1) * Math.max(1, rt.renderCopiesY ?? 1);
    const insts = Math.max(1, hw) * copies;
    // The HDR halo pass must be encoded BEFORE the canvas pass begins (a render
    // pass cannot be nested), exactly as in presentAgentsEncode.
    const glow = showAgents && !!rt.renderGlow && encodeGlowHdrPass(rt, enc, tex.width, tex.height, insts);
    const ap = enc.beginRenderPass({
      label: 'agent-composite-pass',
      colorAttachments: [{ view, loadOp: showGrid ? 'load' : 'clear', storeOp: 'store', clearValue: { r: cr, g: cg, b: cb, a: ca } }],
    });
    if (showAgents) {
      // Tonemapped halo layer OVER the grid, opaque cores over that.
      if (glow) {
        ap.setPipeline(rt.glowComposePipeline!);
        ap.setBindGroup(0, rt.glowComposeBindGroup!);
        ap.draw(3);
      }
      ap.setPipeline(rt.renderPlainPipeline!);
      ap.setBindGroup(0, rt.renderBindGroup);
      ap.draw(4, insts);
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
  const cap = rt.layout.maxAgents;
  const hw = Math.min(s.highWater, cap);
  // THE ACTIVE WINDOW. AgentRenderSurface is the narrow render-only shape, so it
  // may not carry gpuActiveHigh — fall back to the ceiling for a pure render
  // surface (its scratch is one run, not ~50, so the ceiling costs little there).
  const grown = (rt as Partial<AgentWebGPURuntime>).gpuActiveHigh;
  const ma = grown === undefined ? cap : Math.min(cap, Math.max(grown, hw));
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
  rt.device.queue.writeBuffer(rt.agentColorsBuf, 0, u, 0, Math.max(1, ma));
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
  fl[21] = v.glowCore;
  rt.device.queue.writeBuffer(rt.renderViewBuf, 0, ab);
  // Clear colour is applied CPU-side (loadOp clear); store premultiplied so the
  // premultiplied canvas composites the background correctly.
  const a = v.bgA;
  rt.renderClear = [v.bgR * a, v.bgG * a, v.bgB * a, a];
  // The HALO pass is skipped when it would contribute nothing — a zero band or a
  // zero intensity. (The core pass always draws; that IS the agent body.)
  rt.renderGlow = v.glowOn !== 0 && v.glowSize > 0 && v.glowIntensity > 0;
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
  const tex = rt.renderCtx.getCurrentTexture();
  const view = tex.createView();
  const [cr, cg, cb, ca] = rt.renderClear ?? [0, 0, 0, 0];
  const copies = Math.max(1, rt.renderCopiesX ?? 1) * Math.max(1, rt.renderCopiesY ?? 1);
  const insts = Math.max(1, hw) * copies;
  // THREE passes when Glow is on: the halo accumulates additively into the HDR
  // target, the compose tonemaps it ONCE onto the canvas, then the opaque core
  // draws over it. HALO UNDER CORE is the solid-core invariant (glow ON must leave
  // fully-opaque body pixels bit-identical); accumulate-then-compress is what
  // removes the density plateau (see GLOW_COMPOSE_WGSL).
  const glow = !!rt.renderGlow && encodeGlowHdrPass(rt, enc, tex.width, tex.height, insts);
  const pass = enc.beginRenderPass({
    label: 'agent-present',
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: cr, g: cg, b: cb, a: ca } }],
  });
  if (glow) {
    pass.setPipeline(rt.glowComposePipeline!);
    pass.setBindGroup(0, rt.glowComposeBindGroup!);
    pass.draw(3);
  }
  // Set the pipeline BEFORE its bind group: the compose uses a different bind-group
  // layout, and a pipeline switch invalidates incompatible groups.
  pass.setPipeline(rt.renderPlainPipeline!);
  pass.setBindGroup(0, rt.renderBindGroup);
  pass.draw(4, insts);
  pass.end();
}

/** Phase C: append the 3D sphere-impostor pass — one instance per agent (no
 *  infinity tiling), opaque, with a depth attachment so spheres depth-sort. */
function presentAgentSpheresEncode(rt: AgentRenderSurface, enc: GPUCommandEncoder, hw: number): void {
  if (!rt.renderCtx || !rt.renderSpherePipeline || !rt.renderSphereBindGroup) return;
  const tex = rt.renderCtx.getCurrentTexture();
  const view = tex.createView();
  const depthView = ensureAgentDepthTex(rt, tex.width, tex.height);
  // Rebuild the scene-wireframe geometry (bounds/grid/axes) when the viz flags or
  // world dims changed — buffer writes must happen OUTSIDE the render pass.
  ensureAgentLineBuffer(rt);
  const [cr, cg, cb, ca] = rt.renderClear ?? [0, 0, 0, 0];
  const pass = enc.beginRenderPass({
    label: 'agent-sphere-present',
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: cr, g: cg, b: cb, a: ca } }],
    depthStencilAttachment: { view: depthView, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  pass.setPipeline(rt.renderSpherePipeline);
  pass.setBindGroup(0, rt.renderSphereBindGroup);
  pass.draw(4, Math.max(1, hw));   // 4 verts (triangle-strip quad) × hw agents
  // Scene wireframes (bounds/grid/axes) in the SAME pass ⇒ shared depth ⇒ agents
  // in front occlude them (the free-mode two-canvas depth bug). Depth-write ON so
  // the axis arrowheads self-order; drawn after the spheres but depth decides.
  if (rt.renderLinePipeline && rt.renderLineBindGroup && rt.renderLineBuf && (rt.renderLineCount ?? 0) > 0) {
    pass.setPipeline(rt.renderLinePipeline);
    pass.setBindGroup(0, rt.renderLineBindGroup);
    pass.setVertexBuffer(0, rt.renderLineBuf);
    pass.draw(rt.renderLineCount!);
  }
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
  destroyGlowHdrTex(rt);
  const bufs = [rt.agentF32Buf, rt.agentAliveBuf, rt.agentColorsBuf, rt.renderViewBuf ?? null, rt.renderView3DBuf ?? null, rt.gridPresentUniform ?? null, rt.renderLineBuf ?? null];
  for (const b of bufs) { if (b) try { b.destroy(); } catch { /* non-fatal */ } }
  rt.renderLineBuf = null; rt.renderLineCount = 0; rt.renderLineSig = '';
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
  const wantI32 = rt.usesI32Write;
  const i32ByteLen = i32Bytes(L);
  const wantSpawn = rt.usesSpawn && !!rt.spawnCursorBuf;
  const wantStop = rt.usesStop && !!rt.stopFlagBuf;

  // --- THE ACTIVE WINDOW (see AgentWebGPURuntime.gpuActiveHigh).
  // A spawning behaviour bump-allocates slots ABOVE highWater via the atomic
  // spawn cursor, and the reconcile below reads [hw, cursor) — so the window is
  // not knowable until the cursor is. Read that ONE u32 first (a 4-byte
  // round-trip) and size everything else from it. A non-spawn model skips the
  // extra round-trip entirely: its window is exactly highWater.
  let cursorVal = 0;
  const pooledCursor = wantSpawn ? acquireStaging(rt, 4) : null;
  if (pooledCursor && rt.spawnCursorBuf) {
    const encC = rt.device.createCommandEncoder({ label: 'agent-readback-cursor' });
    encC.copyBufferToBuffer(rt.spawnCursorBuf, 0, pooledCursor.buffer, 0, 4);
    rt.device.queue.submit([encC.finish()]);
    await pooledCursor.buffer.mapAsync(GPUMapMode.READ, 0, 4);
    cursorVal = new Uint32Array(pooledCursor.buffer.getMappedRange(0, 4))[0]! >>> 0;
  }
  // Raise the window to cover everything the dispatch may have touched, and KEEP
  // it raised: a slot the GPU wrote must go on being refreshed by the upload, or
  // its stale request lanes would be read back and drained on a later generation.
  const win = agentActiveWindow(rt, Math.max(hw, Math.min(cursorVal, L.maxAgents)));
  const plan = f32ReadPlan(rt, win);
  const f32ByteLen = Math.max(4, plan.totalElems * 4);
  const colByteLen = Math.max(4, win * 4);
  const aliveByteLen = Math.max(4, win * 4);

  const pooledF = acquireStaging(rt, f32ByteLen);
  const stagingF = pooledF.buffer;
  const pooledC = acquireStaging(rt, colByteLen);
  const stagingC = pooledC.buffer;
  const pooledI = wantI32 ? acquireStaging(rt, i32ByteLen) : null;
  const pooledAlive = wantSpawn ? acquireStaging(rt, aliveByteLen) : null;
  const pooledStop = wantStop ? acquireStaging(rt, 4) : null;
  const enc = rt.device.createCommandEncoder({ label: 'agent-readback-enc' });
  // One copy per RUN, into the compacted staging layout — instead of one copy of
  // the whole maxAgents-sized buffer.
  for (const c of plan.copies) enc.copyBufferToBuffer(rt.agentF32Buf, c.src * 4, stagingF, c.dst * 4, c.elems * 4);
  enc.copyBufferToBuffer(rt.agentColorsBuf, 0, stagingC, 0, colByteLen);
  if (pooledI) enc.copyBufferToBuffer(rt.agentI32Buf, 0, pooledI.buffer, 0, i32ByteLen);
  if (pooledAlive) enc.copyBufferToBuffer(rt.agentAliveBuf, 0, pooledAlive.buffer, 0, aliveByteLen);
  if (pooledStop && rt.stopFlagBuf) enc.copyBufferToBuffer(rt.stopFlagBuf, 0, pooledStop.buffer, 0, 4);
  rt.device.queue.submit([enc.finish()]);
  await stagingF.mapAsync(GPUMapMode.READ, 0, f32ByteLen);
  await stagingC.mapAsync(GPUMapMode.READ, 0, colByteLen);
  if (pooledI) await pooledI.buffer.mapAsync(GPUMapMode.READ, 0, i32ByteLen);
  if (pooledAlive) await pooledAlive.buffer.mapAsync(GPUMapMode.READ, 0, aliveByteLen);
  if (pooledStop) await pooledStop.buffer.mapAsync(GPUMapMode.READ, 0, 4);
  const f = new Float32Array(stagingF.getMappedRange(0, f32ByteLen));
  const col = new Uint32Array(stagingC.getMappedRange(0, colByteLen));
  // Every base below is rebased into the compacted staging buffer.
  const CB = (b: number): number => compactBase(plan, b);
  const xB = CB(L.f32Base['xNext']!), yB = CB(L.f32Base['yNext']!);
  const vxB = CB(L.f32Base['vx']!), vyB = CB(L.f32Base['vy']!);
  const radB = CB(L.f32Base['radius']!), denB = CB(L.f32Base['density']!), ageB = CB(L.f32Base['age']!);
  // 3D z fields (present only when gridDepth>1).
  const is3d = L.gridDepth > 1;
  const zB = is3d ? CB(L.f32Base['zNext']!) : -1, vzB = is3d ? CB(L.f32Base['vz']!) : -1;
  // Structural-request bases (G4) — match AGENT_GPU_REQUEST_FIELDS / the emitters.
  const drB = CB(L.f32Base['divideRequest']!), daxB = CB(L.f32Base['divideAxisX']!), dayB = CB(L.f32Base['divideAxisY']!);
  const dasymB = CB(L.f32Base['divideAsym']!), bfrB = CB(L.f32Base['bondFormReq']!), bflB = CB(L.f32Base['bondFormL']!);
  const bfkB = CB(L.f32Base['bondFormK']!), bbrB = CB(L.f32Base['bondBreakReq']!), krB = CB(L.f32Base['killRequest']!);
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
    const base = CB(L.agentAttrBase[id]!);
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
    const rawBase = L.bondFormAttrBase[id];
    const dst = s.bondFormAttrs[id];
    if (rawBase === undefined || !dst) continue;
    const base = CB(rawBase);
    for (let i = 0; i < hw; i++) {
      if (!s.alive[i]) continue;
      const cb = i * s.bondReqSlots, gb = i * L.bondReqSlots;
      for (let c = 0; c < nq; c++) dst[cb + c] = f[base + gb + c]!;
    }
  }
  // SPRITE runs → back into the CPU arrays (Set Agent Sprite writes them GPU-side;
  // the CPU's `advanceAgentSprites` then ticks the frame for this generation, the
  // same order `runAgentStep` uses on JS/WASM). Only when the round-trip is on —
  // the plan planned exactly these runs under the same predicate.
  if (spriteRunsActive(rt)) {
    const spriteDst: Record<string, { arr: { [i: number]: number; length: number }; int: boolean } | undefined> = {
      spriteIds: { arr: s.spriteIds, int: true },
      spriteFrames: { arr: s.spriteFrames, int: false },
      spriteSpeeds: { arr: s.spriteSpeeds, int: false },
      spriteRotations: { arr: s.spriteRotations, int: false },
      spriteScales: { arr: s.spriteScales, int: false },
    };
    for (const field of AGENT_GPU_SPRITE_FIELDS) {
      const rawBase = L.f32Base[field]; const d = spriteDst[field];
      if (rawBase === undefined || !d || d.arr.length === 0) continue;
      const base = CB(rawBase);
      const n = Math.min(hw, d.arr.length);
      for (let i = 0; i < n; i++) {
        if (!s.alive[i]) continue;
        d.arr[i] = d.int ? Math.round(f[base + i]!) : f[base + i]!;
      }
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
    const ma = L.maxAgents;
    // Read ABOVE, before the windowed copies were sized from it. getMappedRange
    // must not be called twice for the same range, so reuse the value.
    const cursor = cursorVal;
    if (cursor > ma) spawnOverflow = true;   // some Create Agent calls got no slot
    const end = Math.min(cursor, ma);
    const x0 = CB(L.f32Base['x']!), y0 = CB(L.f32Base['y']!), z0 = is3d ? CB(L.f32Base['z']!) : -1;
    const trB = CB(L.f32Base['targetRadius']!);
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
          const base = CB(L.agentAttrBase[id]!);   // compacted staging, like every other read
          const dstR = s.attrRead[id] as { [i: number]: number } | undefined;
          const dstW = s.attrWrite[id] as { [i: number]: number } | undefined;
          if (!dstR) continue;
          const isInt = s.attrKind[id] !== 'float64';
          const v = isInt ? Math.round(f[base + k]!) : f[base + k]!;
          dstR[k] = v; if (dstW) dstW[k] = v;
        }
        // …and its SPRITE state, for the same reason: `initAgentSlot` just cleared
        // it, so a Set Agent Sprite on the newborn's Create handle would be lost.
        if (spriteRunsActive(rt)) {
          const sB = L.f32Base['spriteIds'];
          if (sB !== undefined && s.spriteIds.length > k) {
            s.spriteIds[k] = Math.round(f[CB(sB) + k]!);
            s.spriteFrames[k] = f[CB(L.f32Base['spriteFrames']!) + k]!;
            s.spriteSpeeds[k] = f[CB(L.f32Base['spriteSpeeds']!) + k]!;
            s.spriteRotations[k] = f[CB(L.f32Base['spriteRotations']!) + k]!;
            s.spriteScales[k] = f[CB(L.f32Base['spriteScales']!) + k]!;
          }
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
function emitPosCommitWGSL(layout: AgentWebGPULayout, motionMode = 2): string {
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
  ${motionMode === 0 ? `// C9 / STEP 6 (Static): the force pass writes NO xNext, so committing it would
  // revert a graph Set Agent Position write. Refresh the BACK buffer from the live
  // x instead, keeping the double buffer coherent with zero engine motion.
  agentF32[${xnB}u + i] = agentF32[${xB}u + i];
  agentF32[${ynB}u + i] = agentF32[${yB}u + i];${is3d ? `
  agentF32[${znB}u + i] = agentF32[${zB}u + i];` : ''}` : `agentF32[${xB}u + i] = agentF32[${xnB}u + i];
  agentF32[${yB}u + i] = agentF32[${ynB}u + i];${is3d ? `
  agentF32[${zB}u + i] = agentF32[${znB}u + i];` : ''}`}
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
export async function ensureAgentResident(rt: AgentWebGPURuntime, needScan = false, motionMode = 2): Promise<boolean> {
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
    const commit = await mkPipe('agent-pos-commit', emitPosCommitWGSL(L, motionMode), 'posCommit', [
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
      // C10 — the shared emitter declares bindings 7/8 whenever the layout
      // reserved tree nodes, so the MIRROR pipeline must supply them too or its
      // bind group mismatches. (A global-charge model is not residency-eligible
      // today, so this is defence in depth against the two paths drifting.)
      if (rt.chargeTreeF32Buf && rt.chargeTreeI32Buf) {
        forceEntries.push({ binding: 7, visibility: S, buffer: { type: 'read-only-storage' } });
        forceEntries.push({ binding: 8, visibility: S, buffer: { type: 'read-only-storage' } });
      }
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
      if (rt.chargeTreeF32Buf && rt.chargeTreeI32Buf) {
        fmEntries.push({ binding: 7, resource: { buffer: rt.chargeTreeF32Buf } });
        fmEntries.push({ binding: 8, resource: { buffer: rt.chargeTreeI32Buf } });
      }
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
  // THE ACTIVE WINDOW + the compacted plan, same as readbackAgentStep. Residency
  // excludes spawn, so the window is exactly the live population — no cursor
  // round-trip is needed here.
  const win = agentActiveWindow(rt, hw);
  const plan = f32ReadPlan(rt, win);
  const f32ByteLen = Math.max(4, plan.totalElems * 4);
  const colByteLen = Math.max(4, win * 4);
  const pooledF = acquireStaging(rt, f32ByteLen);
  const pooledC = acquireStaging(rt, colByteLen);
  const enc = rt.device.createCommandEncoder({ label: 'agent-frame-readback' });
  for (const c of plan.copies) enc.copyBufferToBuffer(rt.agentF32Buf, c.src * 4, pooledF.buffer, c.dst * 4, c.elems * 4);
  enc.copyBufferToBuffer(rt.agentColorsBuf, 0, pooledC.buffer, 0, colByteLen);
  rt.device.queue.submit([enc.finish()]);
  await pooledF.buffer.mapAsync(GPUMapMode.READ, 0, f32ByteLen);
  await pooledC.buffer.mapAsync(GPUMapMode.READ, 0, colByteLen);
  const f = new Float32Array(pooledF.buffer.getMappedRange(0, f32ByteLen));
  const col = new Uint32Array(pooledC.buffer.getMappedRange(0, colByteLen));
  const is3d = L.gridDepth > 1;
  const CB = (b: number): number => compactBase(plan, b);
  const xB = CB(L.f32Base['x']!), yB = CB(L.f32Base['y']!);
  const vxB = CB(L.f32Base['vx']!), vyB = CB(L.f32Base['vy']!);
  const radB = CB(L.f32Base['radius']!), denB = CB(L.f32Base['density']!), ageB = CB(L.f32Base['age']!);
  const zB = is3d ? CB(L.f32Base['z']!) : -1, vzB = is3d ? CB(L.f32Base['vz']!) : -1;
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
    const base = CB(L.agentAttrBase[id]!);
    const dst = s.attrRead[id] as { [i: number]: number } | undefined;
    if (!dst) continue;
    const isInt = s.attrKind[id] !== 'float64';
    for (let i = 0; i < hw; i++) { if (!s.alive[i]) continue; dst[i] = isInt ? Math.round(f[base + i]!) : f[base + i]!; }
  }
  // SPRITE runs — symmetric with `readbackAgentStep`. `usesSpriteWrite` is a
  // residency BLOCKER, so a sprite-writing behaviour never reaches this path
  // today; keeping the copy here means a future residency widening inherits the
  // correct semantics instead of silently dropping the shader's sprite writes.
  if (spriteRunsActive(rt)) {
    const ids = L.f32Base['spriteIds'];
    if (ids !== undefined && s.spriteIds.length > 0) {
      const bI = CB(ids), bF = CB(L.f32Base['spriteFrames']!), bS = CB(L.f32Base['spriteSpeeds']!);
      const bR = CB(L.f32Base['spriteRotations']!), bC = CB(L.f32Base['spriteScales']!);
      const n = Math.min(hw, s.spriteIds.length);
      for (let i = 0; i < n; i++) {
        if (!s.alive[i]) continue;
        s.spriteIds[i] = Math.round(f[bI + i]!);
        s.spriteFrames[i] = f[bF + i]!; s.spriteSpeeds[i] = f[bS + i]!;
        s.spriteRotations[i] = f[bR + i]!; s.spriteScales[i] = f[bC + i]!;
      }
    }
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
    rt.renderLineBuf ?? null,        // + the 3D scene-wireframe vertex buffer
  ];
  // A1 render canvas is a transferred OffscreenCanvas — its context is released
  // with the device; just drop the references (unconfigure is implicit on destroy).
  rt.renderActive = false;
  rt.renderCtx = null;
  rt.renderComposite = false;
  if (rt.renderDepthTex) { try { rt.renderDepthTex.destroy(); } catch { /* non-fatal */ } rt.renderDepthTex = null; }
  destroyGlowHdrTex(rt);
  for (const b of bufs) { if (b) try { b.destroy(); } catch { /* non-fatal */ } }
  rt.renderLineBuf = null; rt.renderLineCount = 0; rt.renderLineSig = '';
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
