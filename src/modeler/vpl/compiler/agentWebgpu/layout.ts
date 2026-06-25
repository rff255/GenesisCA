// ===========================================================================
// PR7 / G1 — the WebGPU agent SoA storage layout.
//
// The GPU mirror of `computeAgentMemoryLayout` (agentEngine.ts). The agent
// behaviour shader runs one invocation per agent slot; it reads the per-agent
// geometry / velocity / radius and writes the per-step force accumulator + the
// target radius. To stay near the lattice grid shader's ~10-storage-buffer
// footprint (conservative adapters cap `maxStorageBuffersPerShaderStage` at 8;
// the lattice raises it via `requiredLimits`), the agent SoA is packed into a
// SMALL number of strided storage buffers rather than one binding per field
// (the >8-binding gate, B12/S7):
//
//   binding 0  agentF32   : array<f32>   — the f32 geometry SoA, STRIDED (one
//                                          contiguous run per field, like the
//                                          worker's typed-array SoA). The fields
//                                          + their element offsets live in
//                                          `f32` below; a field's element k is at
//                                          `agentF32[fieldBase + k]`.
//   binding 1  agentI32   : array<i32>   — the i32 identity SoA (type/bondCount).
//   binding 2  agentU8AsU32: array<u32>  — `alive` as one u32 word per agent
//                                          (GPU storage can't address bytes, so
//                                          the worker expands the Uint8 `alive`
//                                          into a u32 word per agent on upload).
//   binding 3  hashBins    : array<i32>  — binStart (maxHashBins+1) followed by
//                                          binAgents (maxAgents), CPU-built +
//                                          uploaded each step (PR7b-lite).
//   binding 4  control     : Control     — the per-step scalars (highWater, hash
//                                          dims, world bounds, torus). A uniform
//                                          so `highWater` is NOT a baked literal
//                                          (baking would force a per-gen recompile).
//   binding 5  rngState    : array<u32>  — per-agent PCG seed (one u32/agent).
//   binding 6  agentColors : array<u32>  — per-agent packed RGBA (Set Cell Looks).
//
// That is SEVEN bindings for the Boids subset — comfortably under the 8-buffer
// floor, so no `requiredLimits` raise is needed for the agent path. Field /
// attribute / deposit bindings (G5/PR7c) append after these.
//
// NOTE: this layout is for the GPU shader's *binding* model only. It is
// SEPARATE from `AgentMemoryLayout` (the WASM byte layout) — the GPU never
// shares memory with the JS engine; the worker uploads/reads back through these
// strided buffers (G3/G4). 2D-only for now (the Boids scale target); the z
// fields are listed so a 3D port (worldDepth>1) can append them without
// reshuffling the 2D field offsets.
// ===========================================================================

/** Per-agent f32 fields, in SoA order. Each occupies a contiguous run of
 *  `maxAgents` f32 elements; field `name`'s element k is `agentF32[base + k]`.
 *  Keep geometry first so a future 3D port appends z fields at the END (existing
 *  2D field bases stay stable — the grid's "append-only" discipline).
 *
 *  `xNext`/`yNext` (G3, the force pass) are APPENDED at the end so the behaviour
 *  shader's field bases (compiled against the original list) stay byte-identical
 *  — the force pass reads x/y (the start-of-step snapshot, so a neighbour read is
 *  never half-updated) and writes the integrated position into xNext/yNext; the
 *  worker reads those back into the engine's xNext/yNext and `swapPositions`
 *  commits, exactly mirroring the JS/WASM double-buffer. */
export const AGENT_GPU_F32_FIELDS = [
  'x', 'y', 'vx', 'vy', 'radius', 'targetRadius', 'age',
  'forceX', 'forceY', 'density',
  'xNext', 'yNext',
] as const;

/** Per-agent i32 fields (identity / reductions the behaviour reads). */
export const AGENT_GPU_I32_FIELDS = [
  'type', 'lineage', 'bondCount',
] as const;

export type AgentGpuF32Field = (typeof AGENT_GPU_F32_FIELDS)[number];
export type AgentGpuI32Field = (typeof AGENT_GPU_I32_FIELDS)[number];

export interface AgentWebGPULayout {
  maxAgents: number;
  /** Max spatial-hash bins (binStart length = maxHashBins+1). 0 ⇒ no hash region
   *  (the behaviour never queries the hash). */
  maxHashBins: number;
  /** f32 field name → its element base offset in the `agentF32` array. */
  f32Base: Record<string, number>;
  /** i32 field name → its element base offset in the `agentI32` array. */
  i32Base: Record<string, number>;
  /** Number of f32 elements in `agentF32` (= AGENT_GPU_F32_FIELDS.length * maxAgents). */
  f32Len: number;
  /** Number of i32 elements in `agentI32`. */
  i32Len: number;
  /** binStart base (element 0 of `hashBins`). */
  hashBinStartBase: number;
  /** binAgents base in `hashBins` (= maxHashBins + 1). */
  hashBinAgentsBase: number;
  /** Total i32 elements in `hashBins`. */
  hashLen: number;
}

/** Compute the GPU agent storage layout. Pure (no GPU calls). */
export function computeAgentWebGPULayout(maxAgents: number, maxHashBins = 0): AgentWebGPULayout {
  const ma = Math.max(1, Math.floor(maxAgents));
  const f32Base: Record<string, number> = {};
  let off = 0;
  for (const f of AGENT_GPU_F32_FIELDS) { f32Base[f] = off; off += ma; }
  const f32Len = off;

  const i32Base: Record<string, number> = {};
  off = 0;
  for (const f of AGENT_GPU_I32_FIELDS) { i32Base[f] = off; off += ma; }
  const i32Len = off;

  const hb = Math.max(0, Math.floor(maxHashBins));
  const hashBinStartBase = 0;
  const hashBinAgentsBase = hb > 0 ? hb + 1 : 0;
  const hashLen = hb > 0 ? hb + 1 + ma : 0;

  return {
    maxAgents: ma, maxHashBins: hb,
    f32Base, i32Base, f32Len, i32Len,
    hashBinStartBase, hashBinAgentsBase, hashLen,
  };
}
