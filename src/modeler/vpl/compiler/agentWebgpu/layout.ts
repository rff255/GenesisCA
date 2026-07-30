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
//   binding 1  agentI32   : array<i32>   — the i32 identity SoA (lineage/bondCount).
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
// strided buffers (G3/G4). 2D AND 3D: the z fields (z/vz/forceZ/zNext/
// divideAxisZ) are APPENDED only when gridDepth > 1, so a 2D model's field
// offsets are byte-identical.
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
  // --- G4: the structural-write request buffers (read_write so the behaviour
  //     shader can flag a division / bond / kill; the worker reads these back
  //     into the engine's CPU request arrays BEFORE runAgentStructuralPhase).
  //     Stored as f32 in the SAME agentF32 buffer (binding 0) so G4 adds ZERO
  //     new bindings: the flags are small integers (0/1, an agent id + 1) exact
  //     in f32 up to 2^24, and the axis/asymmetry/restLength/stiffness are already
  //     float. The worker re-uploads them as 0 each step (the request is per-step).
  'divideRequest', 'divideAxisX', 'divideAxisY', 'divideAsym',
  'bondFormReq', 'bondFormL', 'bondFormK', 'bondBreakReq',
  'killRequest',
] as const;

/** The structural-request f32 fields the worker round-trips (subset of
 *  AGENT_GPU_F32_FIELDS appended for G4). Uploaded as 0 each step (a fresh request
 *  slate) and read back into the engine's CPU request arrays after the dispatch. */
export const AGENT_GPU_REQUEST_FIELDS = [
  'divideRequest', 'divideAxisX', 'divideAxisY', 'divideAsym',
  'bondFormReq', 'bondFormL', 'bondFormK', 'bondBreakReq',
  'killRequest',
] as const;

/** P4 -- the request fields that are QUEUE-shaped (`maxAgents * bondReqSlots`).
 *  ONE list, consumed by the layout AND the runtime's upload/readback loops, so a
 *  field cannot be sized one way in the bases and another way when it is zeroed or
 *  read back. Mirrors `AGENT_REQUEST_QUEUE_FIELDS` on the CPU store. */
export const AGENT_GPU_QUEUE_FIELDS: ReadonlySet<string> = new Set([
  'bondFormReq', 'bondBreakReq', 'bondFormL', 'bondFormK',
]);

/** Per-agent i32 fields (identity / reductions the behaviour reads). */
export const AGENT_GPU_I32_FIELDS = [
  'lineage', 'bondCount',
] as const;

export type AgentGpuF32Field = (typeof AGENT_GPU_F32_FIELDS)[number];
export type AgentGpuI32Field = (typeof AGENT_GPU_I32_FIELDS)[number];

// ===========================================================================
// G5 — the field bridge (the closed agent↔grid morphogen feedback).
//
// The behaviour shader reads (Sample Field / Field Gradient / Read Cells Under)
// and writes (Affect Cells Under / Secrete To Field) CELL attributes the model
// marks `agentAccess`. Each accessible attribute occupies a contiguous run of
// `fieldTotal = W·H` f32 elements (the GPU mirror of the worker's per-cell
// `readAttrs[id]` array). TWO strided buffers (bindings 7 + 8 — below the
// behaviour's 7 ⇒ a field model uses 9 bindings, still under the conservative-
// adapter cap once `requiredLimits` raises maxStorageBuffersPerShaderStage):
//
//   binding 7  fieldRead    : array<f32>          — a READ-ONLY snapshot of the
//                                                  cell field at step start. ALL
//                                                  agents read the same pre-deposit
//                                                  values (a true snapshot — a
//                                                  documented difference vs the JS
//                                                  path, where a sequential agent
//                                                  reads other agents' same-step
//                                                  deposits; harmless for diffusion).
//   binding 8  fieldDeposit : array<atomic<u32>>  — the deposit accumulator,
//                                                  f32-bitcast-as-u32 + an atomic-CAS
//                                                  loop per op (set/add/subtract/
//                                                  max/min) so parallel agents
//                                                  writing the same cell don't race.
//                                                  Initialised each step to the
//                                                  field (so `add` accumulates onto
//                                                  it, `set`/`max`/`min` start from
//                                                  it), then read back into the cell
//                                                  read buffer BEFORE the cell step.
//
// `fieldReadAttrs` / `fieldWriteAttrs` are the ordered id lists (the bridge ABI —
// the worker uploads/reads back per-attr at `fieldBase[id]`). 2D AND 3D: in a
// 3D model `fieldTotal = W·H·D` and the shader indexes `(z·H + y)·W + x`
// (trilinear sampling / r-sphere scans).
// ===========================================================================

export interface AgentWebGPULayout {
  maxAgents: number;
  /** Max spatial-hash bins (binStart length = maxHashBins+1). 0 ⇒ no hash region
   *  (the behaviour never queries the hash). */
  maxHashBins: number;
  /** f32 field name → its element base offset in the `agentF32` array. INCLUDES
   *  the static geometry/force/request fields AND the per-USER-agent-attribute runs
   *  (G4 — Get/Set Attribute on an agent attribute). */
  f32Base: Record<string, number>;
  /** i32 field name → its element base offset in the `agentI32` array. */
  i32Base: Record<string, number>;
  /** Ordered USER agent-attribute ids stored in `agentF32` (`agentAttrsOf`). The
   *  attr's element k is `agentF32[attrBase[id] + k]`. f32 storage (the GPU has no
   *  f64); int/tag/bool values round-trip exactly up to 2^24 (rounded on write). */
  agentAttrIds: string[];
  /** Agent-attr id → its READ-run element base offset in `agentF32` (= f32Base[id]). */
  agentAttrBase: Record<string, number>;
  /** PX — agent-attr id → its WRITE-run element base offset in `agentF32`.
   *
   *  **`agentUpdateMode: 'sync'` needs a double buffer on the GPU exactly like the
   *  CPU targets do** (the store's `attrRead`/`attrWrite`, the WASM layout's
   *  `attrOffset`/`attrWriteOffset`). GPU threads run in parallel and in an
   *  unspecified order, so with ONE run per attribute agent A's write is visible to
   *  agent B's read within a single dispatch — async (single-buffer) semantics
   *  silently applied to a model the user configured as synchronous.
   *
   *  So when `syncAttrs` a SECOND contiguous run per attribute is appended after
   *  the read runs; the behaviour shader reads the read run and writes the write
   *  run, and a per-generation commit pass folds write → read.
   *
   *  **When async this ALIASES `agentAttrBase` (identical values, zero extra
   *  bytes)** — the emitters resolve the same WGSL offset for a read and a write,
   *  so an async model's shader is byte-identical to the pre-PX build. That is the
   *  byte-identity gate for the 8 shipped agent models. */
  agentAttrWriteBase: Record<string, number>;
  /** PX — true when the attribute WRITE runs are distinct from the read runs (the
   *  model is `agentUpdateMode: 'sync'` AND has ≥1 user agent attribute). Drives
   *  the runtime's write-run prime + the commit pass. */
  syncAttrs: boolean;
  /** Number of f32 elements in `agentF32` (= total field runs * maxAgents). */
  f32Len: number;
  /** Number of i32 elements in `agentI32`. */
  i32Len: number;
  /** binStart base (element 0 of `hashBins`). */
  hashBinStartBase: number;
  /** binAgents base in `hashBins` (= maxHashBins + 1). */
  hashBinAgentsBase: number;
  /** Total i32 elements in `hashBins`. */
  hashLen: number;

  // --- field bridge (G5) ---
  /** Grid width (cells per row). The field index is `row·gridWidth + col`. */
  gridWidth: number;
  /** Grid height (rows). */
  gridHeight: number;
  /** Cells per attribute run = gridWidth·gridHeight. */
  fieldTotal: number;
  /** Ordered cell-attr ids agents may READ (the `fieldRead` buffer runs). */
  fieldReadAttrs: string[];
  /** Ordered cell-attr ids agents may WRITE (the `fieldDeposit` buffer runs). */
  fieldWriteAttrs: string[];
  /** Attr id → its element base offset in the `fieldRead` array. */
  fieldReadBase: Record<string, number>;
  /** Attr id → its element base offset in the `fieldDeposit` array. */
  fieldWriteBase: Record<string, number>;
  /** Total f32 elements in `fieldRead`. 0 ⇒ no field bridge (no field buffers). */
  fieldReadLen: number;
  /** Total elements in `fieldDeposit`. 0 ⇒ no field write nodes. */
  fieldWriteLen: number;

  // --- universal-node bindings (Generic Agent Platform: full WebGPU coverage) ---
  /** 3D world depth (1 ⇒ 2D fast path). Drives the z fields + the 3×3×3 hash
   *  stencil + trilinear field sampling. */
  gridDepth: number;
  /** Model-attribute key → its element slot in the `auxF32` buffer (Get Model
   *  Attribute). Color attrs occupy 3 slots keyed `<id>_r`/`_g`/`_b`. */
  modelAttrSlot: Record<string, number>;
  /** Lookup-table id → its base/dims within `auxF32` (Table Lookup). Row-major.
   *  MULTI-AXIS (N-D) tables carry `dims`/`mins` (region `Π dims`, indexed
   *  `Σ idxₖ·strideₖ`); `dims` present ⇔ multi-axis. */
  lookupTables: Record<string, { base: number; rowCount: number; colCount: number; dims?: number[]; mins?: number[] }>;
  /** Total f32 elements in the `auxF32` buffer (model attrs + lookup tables).
   *  0 ⇒ no aux buffer (no Get Model Attribute / Table Lookup). */
  auxF32Len: number;
  /** Ordered model-attribute keys (the upload order, mirroring modelAttrSlot). */
  modelAttrKeys: string[];
  /** Ordered lookup-table ids (the upload order). */
  lookupTableIds: string[];
  /** Number of indicator slots (the `indicators` atomic<u32> buffer length).
   *  0 ⇒ no indicators binding. */
  indicatorCount: number;
  /** Per-agent bond capacity (the ragged `bondStore` stride, in bond slots). 0 ⇒
   *  no bond store buffer (no Get Bonded Agents / For Each Bond / Get Curvature).
   *  The store interleaves `[partnerId, restLengthBits, ...bondAttrs]` per slot, so
   *  an agent's bond k starts at `bondStore[idx·maxBonds·S + k·S]` where
   *  `S = bondSlotStride` (2 when the model declares no bond attributes). */
  maxBonds: number;
  /** Total i32 elements in the `bondStore` buffer (= maxAgents · maxBonds · S).
   *  0 ⇒ no bond store binding. */
  bondStoreLen: number;

  // --- P3 (Graph-Rewriting Automata): USER BOND ATTRIBUTES on the GPU ---------
  /** **THE bond-slot stride, in i32 words** (`2 + bondAttrIds.length`): word 0 =
   *  partner id, word 1 = rest length (f32 bits), then ONE word per user bond
   *  attribute. This is the SINGLE definition of the stride — every emitter, the
   *  layout and the runtime read it, never a literal `2`. A missed site would read
   *  the wrong lane SILENTLY, which is why the constant is not duplicated. With no
   *  bond attributes it is exactly 2 ⇒ every pre-P3 shader / buffer is unchanged. */
  bondSlotStride: number;
  /** Ordered USER bond-attribute ids (`bondAttrsOf(model)` order — the SAME order
   *  the CPU store's `bondAttrSpecs` and the WASM layout use). */
  bondAttrIds: string[];
  /** Bond-attr id → its WORD index inside a bond slot (`2 + i`). */
  bondAttrWord: Record<string, number>;
  /** Bond-attr id → true when the slot word holds **f32 BITS** (a `float`
   *  attribute — read with `bitcast<f32>`, written with `bitcast<i32>`), false when
   *  it holds a plain i32 (bool / integer / tag). Mirrors the CPU `bondAttrKind`. */
  bondAttrIsFloat: Record<string, boolean>;
  /** Bond-attr id → its per-agent f32 run base in `agentF32` carrying **Form
   *  Bond's INITIAL value** request (the sibling of `bondFormL` / `bondFormK`; the
   *  GPU mirror of the store's `bondFormAttrs[id]`). Appended after every other
   *  f32 run so all existing bases stay byte-stable. */
  bondFormAttrBase: Record<string, number>;
  /** P4 — the STRUCTURAL REQUEST QUEUE stride (`D + 1`, the overflow bucket
   *  included). Entry `c` of agent `idx` in a queue-shaped run is
   *  `base + idx * bondReqSlots + c`. `1` ⇒ the pre-P4 single-slot runs. */
  bondReqSlots: number;
}

/** **THE** bond-slot stride helper: `[partner, restBits, ...attrs]`. Exported so
 *  the runtime + the harnesses derive the stride from the same one place the
 *  layout does. */
export function bondSlotStrideOf(bondAttrCount: number): number {
  return 2 + Math.max(0, Math.floor(bondAttrCount) || 0);
}

export interface AgentWebGPUFieldSpec {
  /** Ordered cell-attr ids agents may READ (agentAccess read | readWrite). */
  readAttrs: string[];
  /** Ordered cell-attr ids agents may WRITE (agentAccess readWrite). */
  writeAttrs: string[];
  gridWidth: number;
  gridHeight: number;
  /** 3D world depth (default 1 ⇒ 2D; the field index becomes layer·W·H + row·W + col). */
  gridDepth?: number;
}

/** Universal-node bindings the agent shader may reference (Generic Agent
 *  Platform). All optional/additive — a Boids model passes none, so its layout +
 *  shader stay byte-identical. */
export interface AgentWebGPUExtras {
  /** Ordered model-attribute keys (scalar attrs as `<id>`; color attrs as the
   *  three `<id>_r`/`_g`/`_b` keys). Each gets one f32 slot in `auxF32`. */
  modelAttrKeys?: string[];
  /** Lookup tables (id → row/col dims; multi-axis tables carry `dims`/`mins`).
   *  Appended to `auxF32` after the model attrs. */
  lookupTables?: Array<{ id: string; rowCount: number; colCount: number; dims?: number[]; mins?: number[] }>;
  /** Number of standalone-indicator slots (the `indicators` atomic buffer). */
  indicatorCount?: number;
  /** Per-agent bond capacity (the ragged bond store stride). 0/absent ⇒ no store. */
  maxBonds?: number;
  /** 3D world depth (1 ⇒ 2D). */
  gridDepth?: number;
  /** PX — `agentUpdateMode: 'sync'`: allocate a SECOND run per user agent attribute
   *  (the write buffer). Absent/false ⇒ the write bases alias the read bases and
   *  the layout is byte-identical to pre-PX (the async fast path). */
  syncAttrs?: boolean;
  /** P3 — USER BOND attributes (per-EDGE state), in `bondAttrsOf(model)` order.
   *  Each widens the `bondStore` slot by ONE i32 word and adds one per-agent f32
   *  run for Form Bond's initial value. Absent/empty ⇒ stride 2 + no extra runs ⇒
   *  byte-identical to pre-P3. `float` ⇒ the slot word holds f32 bits. */
  bondAttrs?: Array<{ id: string; type: string }>;
  /** P4 -- the STRUCTURAL REQUEST QUEUE stride (`D + 1`). The four request runs
   *  (`bondFormReq`/`bondBreakReq`/`bondFormL`/`bondFormK`) and every
   *  `bondFormAttr_<id>` run become `maxAgents * bondReqSlots` long, addressed
   *  `base + idx * bondReqSlots + c` -- the SAME agent-major shape the CPU store
   *  uses, so the readback is a straight elementwise copy. Absent/1 gives the
   *  pre-P4 single-slot runs, so every base after them (and the whole emitted
   *  shader) is byte-identical. */
  bondReqSlots?: number;
}

/** Compute the GPU agent storage layout. Pure (no GPU calls). The optional
 *  `field` spec wires the closed agent↔grid feedback (Sample/Secrete/etc.);
 *  absent ⇒ no field buffers (the byte-identical no-field Boids layout).
 *  `agentAttrIds` (G4) lists the USER agent attributes — each gets a run in
 *  `agentF32` appended after the static fields (so the no-attr Boids layout is
 *  byte-identical). */
/** The 3D-only per-agent f32 fields, appended AFTER the 2D fields + the request
 *  fields when gridDepth>1 (so the 2D field bases stay byte-identical). */
export const AGENT_GPU_F32_FIELDS_3D = ['z', 'vz', 'forceZ', 'zNext', 'divideAxisZ'] as const;

export function computeAgentWebGPULayout(
  maxAgents: number,
  maxHashBins = 0,
  field?: AgentWebGPUFieldSpec,
  agentAttrIds: string[] = [],
  extras: AgentWebGPUExtras = {},
): AgentWebGPULayout {
  const ma = Math.max(1, Math.floor(maxAgents));
  const gd = Math.max(1, Math.floor(extras.gridDepth ?? field?.gridDepth ?? 1));
  const f32Base: Record<string, number> = {};
  let off = 0;
  // P4 -- the structural-request runs are QUEUE-shaped (ma * slots); everything
  // else keeps one element per agent. slots === 1 is byte-identical to pre-P4.
  const bondReqSlots = Math.max(1, Math.floor(extras.bondReqSlots ?? 1));
  for (const f of AGENT_GPU_F32_FIELDS) { f32Base[f] = off; off += ma * (AGENT_GPU_QUEUE_FIELDS.has(f) ? bondReqSlots : 1); }
  // 3D z fields — appended after the static 2D fields (2D layout byte-identical).
  if (gd > 1) { for (const f of AGENT_GPU_F32_FIELDS_3D) { f32Base[f] = off; off += ma; } }
  // User agent attributes — one READ run each, appended after the static fields.
  const agentAttrBase: Record<string, number> = {};
  for (const id of agentAttrIds) { f32Base[id] = off; agentAttrBase[id] = off; off += ma; }
  // PX — sync agent update: a SECOND contiguous block of WRITE runs, in the SAME
  // attribute order, appended right after the read block. The two blocks are each
  // contiguous by construction, which is what lets the commit pass be ONE linear
  // copy of `agentAttrIds.length * ma` elements. Async ⇒ no second block and the
  // write bases ALIAS the read bases (⇒ byte-identical shader + layout).
  const syncAttrs = !!extras.syncAttrs && agentAttrIds.length > 0;
  const agentAttrWriteBase: Record<string, number> = {};
  if (syncAttrs) { for (const id of agentAttrIds) { agentAttrWriteBase[id] = off; off += ma; } }
  else { for (const id of agentAttrIds) { agentAttrWriteBase[id] = agentAttrBase[id]!; } }
  // P3 — Form Bond's per-BOND-ATTRIBUTE initial-value request runs (the GPU
  // sibling of bondFormL / bondFormK). APPENDED LAST so every base above stays
  // byte-stable; a model with no bond attributes adds nothing at all.
  const bondAttrsIn = extras.bondAttrs ?? [];
  const bondFormAttrBase: Record<string, number> = {};
  for (const a of bondAttrsIn) { bondFormAttrBase[a.id] = off; f32Base[`bondFormAttr_${a.id}`] = off; off += ma * bondReqSlots; }
  const f32Len = off;

  const i32Base: Record<string, number> = {};
  off = 0;
  for (const f of AGENT_GPU_I32_FIELDS) { i32Base[f] = off; off += ma; }
  const i32Len = off;

  const hb = Math.max(0, Math.floor(maxHashBins));
  const hashBinStartBase = 0;
  const hashBinAgentsBase = hb > 0 ? hb + 1 : 0;
  const hashLen = hb > 0 ? hb + 1 + ma : 0;

  // --- field bridge layout (3D-aware: fieldTotal = W·H·D) ---
  const gridWidth = Math.max(1, Math.floor(field?.gridWidth ?? 1));
  const gridHeight = Math.max(1, Math.floor(field?.gridHeight ?? 1));
  const fieldTotal = gridWidth * gridHeight * gd;
  const fieldReadAttrs = field?.readAttrs ?? [];
  const fieldWriteAttrs = field?.writeAttrs ?? [];
  const fieldReadBase: Record<string, number> = {};
  let fo = 0;
  for (const id of fieldReadAttrs) { fieldReadBase[id] = fo; fo += fieldTotal; }
  const fieldReadLen = fo;
  const fieldWriteBase: Record<string, number> = {};
  fo = 0;
  for (const id of fieldWriteAttrs) { fieldWriteBase[id] = fo; fo += fieldTotal; }
  const fieldWriteLen = fo;

  // --- auxF32 (model attrs + lookup tables) ---
  const modelAttrKeys = extras.modelAttrKeys ?? [];
  const lookupTablesIn = extras.lookupTables ?? [];
  const modelAttrSlot: Record<string, number> = {};
  let auxOff = 0;
  for (const key of modelAttrKeys) { modelAttrSlot[key] = auxOff; auxOff += 1; }
  const lookupTables: Record<string, { base: number; rowCount: number; colCount: number; dims?: number[]; mins?: number[] }> = {};
  const lookupTableIds: string[] = [];
  for (const t of lookupTablesIn) {
    if (t.dims && t.dims.length > 0) {
      // Multi-axis: region sized Π dims (the emitter clamps per axis).
      const dims = t.dims.map(d => Math.max(1, Math.floor(d) || 1));
      lookupTables[t.id] = { base: auxOff, rowCount: t.rowCount, colCount: t.colCount, dims, mins: t.mins ?? dims.map(() => 0) };
      lookupTableIds.push(t.id);
      auxOff += dims.reduce((a, b) => a * b, 1);
    } else {
      lookupTables[t.id] = { base: auxOff, rowCount: t.rowCount, colCount: t.colCount };
      lookupTableIds.push(t.id);
      auxOff += t.rowCount * t.colCount;
    }
  }
  const auxF32Len = auxOff;

  const indicatorCount = Math.max(0, Math.floor(extras.indicatorCount ?? 0));
  const maxBonds = Math.max(0, Math.floor(extras.maxBonds ?? 0));
  // Interleaved [partner, restBits, ...bondAttrs] per bond slot. THE stride comes
  // from `bondSlotStrideOf` — the one definition (see AgentWebGPULayout).
  const bondAttrIds = bondAttrsIn.map(a => a.id);
  const bondSlotStride = bondSlotStrideOf(bondAttrIds.length);
  const bondAttrWord: Record<string, number> = {};
  const bondAttrIsFloat: Record<string, boolean> = {};
  bondAttrsIn.forEach((a, i) => { bondAttrWord[a.id] = 2 + i; bondAttrIsFloat[a.id] = a.type === 'float'; });
  const bondStoreLen = maxBonds > 0 ? ma * maxBonds * bondSlotStride : 0;

  return {
    maxAgents: ma, maxHashBins: hb,
    f32Base, i32Base, agentAttrIds: [...agentAttrIds], agentAttrBase, agentAttrWriteBase, syncAttrs, f32Len, i32Len,
    hashBinStartBase, hashBinAgentsBase, hashLen,
    gridWidth, gridHeight, fieldTotal,
    fieldReadAttrs, fieldWriteAttrs, fieldReadBase, fieldWriteBase,
    fieldReadLen, fieldWriteLen,
    gridDepth: gd, modelAttrSlot, lookupTables, auxF32Len,
    modelAttrKeys: [...modelAttrKeys], lookupTableIds,
    indicatorCount, maxBonds, bondStoreLen,
    bondSlotStride, bondAttrIds, bondAttrWord, bondAttrIsFloat, bondFormAttrBase,
    bondReqSlots,
  };
}
