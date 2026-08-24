// ===========================================================================
// Bond-Graph Agents — the co-resident agent engine (data structures + driver
// support for ALL THREE agent targets).
//
// A SECOND engine the sim worker owns alongside the lattice CA. Agents are
// floating, continuous-position "cells": a maxAgents-length Structure-of-Arrays
// (free-list-holed + alive-mask + highWater loop bound), a persistent ragged
// bond store, a per-step force-integration driver (PR-A3), and a post-step
// structural phase (division/growth/death — PR-C). This module owns the data
// structures + allocation + seeding + serialization; the worker drives it and
// bridges it to the grid field (PR-D). The store is not JS-only: with
// `wasmBacked` the SoA is typed-array VIEWS over a single WebAssembly.Memory at
// the `computeAgentMemoryLayout` baked offsets (the WASM agent target reads/
// writes the SAME bytes), and the worker mirrors it to/from the GPU agent SoA
// (agentWebgpuRuntime upload/readback) for the WebGPU agent target.
//
// Engine-owned buffers use `_agent*`-style names (here plain SoA fields). USER
// agent attributes ride parallel `r_<id>` / `w_<id>` typed arrays sized
// maxAgents, identical naming to the lattice — so `Get Cell Attribute` /
// `Set Attribute` work on agents with ZERO node change via Decision D-IDX (the
// agent loop variable is `idx`). The agent loop reads engine geometry through
// dedicated nodes (Get Self Position / Get Radius / …), never Get Cell
// Attribute, so the user can't accidentally clobber position/radius.
//
// maxAgents / maxBonds are over-allocated ceilings. Overflow REJECTS + surfaces
// (never wraps — the Amphiphile-NI-poisoning class).
// ===========================================================================

import type { CenterBasedConfig } from '../../model/types';
import { normalizeFieldGates, type AgentFieldGates } from '../../model/agentFieldGating';
import { cbNum, resolveBondRequestDepth, resolveMaxBonds } from '../../model/centerBased';
import { BOND_REQ_ID_BIAS } from '../../modeler/vpl/compiler/bondRequestQueue';
import type { DividePartitionSpec } from '../../modeler/vpl/compiler/dividePartition';
import { DEFAULT_DIVIDE_PARTITION } from '../../modeler/vpl/compiler/dividePartition';

export type AgentAttrKind = 'uint8' | 'int32' | 'float64';
export type AgentTypedArray = Uint8Array | Int32Array | Float64Array;

/** Map a cell-attribute runtime type to its agent SoA typed-array kind — the
 *  SAME mapping the lattice uses (bool→uint8, integer/tag/neighborIndex→int32,
 *  float→float64). */
export function agentAttrKind(type: string): AgentAttrKind {
  switch (type) {
    case 'bool': return 'uint8';
    case 'integer': case 'tag': case 'neighborIndex': return 'int32';
    default: return 'float64';
  }
}

function makeArray(kind: AgentAttrKind, len: number): AgentTypedArray {
  if (kind === 'uint8') return new Uint8Array(len);
  if (kind === 'int32') return new Int32Array(len);
  return new Float64Array(len);
}

/** BOND-attribute typed-array kind (P2). Deliberately NARROWER than
 *  `agentAttrKind`: the ragged bond store has exactly TWO region shapes (Int32 +
 *  Float64 — see `AGENT_BOND_I32_FIELDS` / `AGENT_BOND_F64_FIELDS`), so a bond
 *  `bool` rides an Int32 region rather than adding a third (Uint8) ragged shape
 *  to the layout, the compaction field list and both compilers. The cost is 3
 *  bytes per bond slot for a bool; the benefit is that every bond region is one
 *  of two shapes on every target. Only bool / integer / float / tag are offered
 *  (decision D1) — anything else falls through to float64 defensively. */
export function bondAttrKind(type: string): 'int32' | 'float64' {
  return type === 'float' ? 'float64' : 'int32';
}

/** A user agent-attribute definition (the non-model cell attributes double as
 *  agent attributes; each carries its id + runtime type + default value). */
export interface AgentAttrSpec { id: string; type: string; defaultValue: number }

// ===========================================================================
// AW-MEM (PR6a) — the agent SoA on a single WebAssembly.Memory.
//
// To let the eventual WASM agent behaviour (PR6b) read the agent state at FIXED
// baked offsets, the whole AgentStore SoA can live as typed-array VIEWS over one
// WebAssembly.Memory. This is OPT-IN (`createAgentStore(cfg, specs, { wasmBacked
// })`): the default (plain typed arrays) is the byte-untouched JS-default path
// with ZERO blast radius. When `wasmBacked`, the SAME arrays are views over
// `memory.buffer` at the offsets `computeAgentMemoryLayout` bakes — so the JS
// engine code (`store.x[i]`, …) is bit-identical on either backing, and PR6b's
// WASM module reads `agentX` etc. at the stable offset.
//
// Alignment mirrors the lattice WASM layout (wasm/layout.ts computeMemoryLayout):
// each region starts 8-byte aligned for Float64, 4-byte for Int32, 1-byte for
// Uint8 (we still 8-align Float64 regions and keep Int32 4-aligned; Uint8 needs
// no alignment but we keep the running offset monotonic). Regions are
// non-overlapping within `totalBytes`, rounded up to a 64 KB page boundary.
//
// View discipline (B10): a baked-offset view CANNOT be reassigned (`store.x =
// new Float64Array(...)` would orphan the WASM-baked offset). Under wasmBacked,
// the position double-buffer swap copies-into (`x.set(xNext)`) instead of the
// cheap reference swap — see `swapPositions` in the worker. All other engine
// mutation is element-wise (in-place), so it's view-safe on both backings.
// ===========================================================================

/** Per-region byte offsets of the agent SoA on a WebAssembly.Memory + the total
 *  byte count and page count. Field names mirror the AgentStore arrays so the
 *  view-construction loop in `createAgentStore` is mechanical. */
export interface AgentMemoryLayout {
  totalBytes: number;
  pages: number;
  maxAgents: number;
  maxBonds: number;
  /** Per-agent Float64 fields (length maxAgents, stride 8). */
  f64: Record<string, number>;
  /** Per-agent Int32 fields (length maxAgents, stride 4). */
  i32: Record<string, number>;
  /** Per-agent Uint8 fields (length maxAgents, stride 1). */
  u8: Record<string, number>;
  /** FULL-COVERAGE: in SYNC agent mode the WASM module needs a SEPARATE attr-write
   *  region (the behaviour reads `attrOffset`/`attrRead`, writes `attrWriteOffset`;
   *  the worker primes attrRead→attrWrite before + swaps after). Empty `{}` in async
   *  mode (write aliases read = the `attrOffset` region). */
  attrWriteOffset: Record<string, number>;
  /** True when this layout reserved a distinct attr-write region (sync agent mode). */
  syncAttrs: boolean;
  /** Ragged bond Int32 fields (length maxAgents*maxBonds). */
  bondI32: Record<string, number>;
  /** Ragged bond Float64 fields (length maxAgents*maxBonds). */
  bondF64: Record<string, number>;
  /** colors region (Uint8Clamped, length maxAgents*4). */
  colorsOffset: number;
  /** freeList region (Int32, length maxAgents). */
  freeListOffset: number;
  /** Per-user-attr region offset, typed by the spec's kind. */
  attrOffset: Record<string, number>;
  // --- AW-RNG + AW-HASH (PR6b-2) control region. The worker writes these cells
  // BEFORE each WASM `behaviour` call; the WASM loop reads them. ---
  /** RNG state cell (Uint32, length 1) — the shared xorshift32 `_rs`. The worker
   *  copies the global `rngState[0]` in before the call + reads it back after, so
   *  the WASM loop advances the SAME stream the JS loop would (B13 bit-parity). */
  rngStateOffset: number;
  /** AW-HASH: the per-step spatial hash, copied into agent-memory views each step
   *  (S10 — a per-step O(nBins + liveCount) copy). `binStart` reserves
   *  `maxHashBins + 1` Int32; `binAgents` reserves `maxAgents` Int32. A step whose
   *  live `nBins + 1` exceeds `maxHashBins + 1` falls back to JS for that step
   *  (the worker's fits-check) — never silently wrong. */
  maxHashBins: number;
  hashBinStartOffset: number;
  hashBinAgentsOffset: number;
  /** Per-behaviour neighbour-query scratch (PR6b-2): `getNearbyAgents` writes the
   *  matched agent-id array here (Int32). Reserves `nearbyScratchSlots` buffers of
   *  `maxAgents` Int32 each (one per `getNearbyAgents` node, assigned at compile
   *  time); slot `k` starts at `nearbyScratchOffset + k*maxAgents*4`. A graph with
   *  more `getNearbyAgents` nodes than slots fails the WASM gate → JS fallback. */
  nearbyScratchSlots: number;
  nearbyScratchOffset: number;
  // --- FULL-COVERAGE WASM agent port (the whole-catalogue port) extra regions ---
  // All appended AFTER the PR6b-2 regions so every existing offset is byte-stable
  // (the W1 force-pass / drift-test / Boids path is unaffected — they pass 0 sizes
  // here, so the regions collapse to nothing).
  /** General per-agent bump-pointer array scratch (byte-granular) for the agent-
   *  array tier (filterAgents/joinAgents/getAgentsAttribute/picks/group ops over
   *  arrays + array Local Variables). One contiguous region; the compiler bumps a
   *  top pointer per agent (reset at loop top). Reserved `scratchBytes` bytes. */
  scratchOffset: number;
  scratchBytes: number;
  /** Model attributes — one f64 cell per scalar key (a color attr occupies 3 keys
   *  `id_r`/`id_g`/`id_b`). The worker copies `cachedModelAttrs` in before the call.
   *  `modelAttrOffset[key]` is the byte offset of that key's f64 cell. */
  modelAttrOffset: Record<string, number>;
  modelAttrBytes: number;
  /** Indicators — `indicatorCount` f64 cells (the worker copies `cachedIndicators`
   *  in and reads them back, mirroring the lattice grid). */
  indicatorsOffset: number;
  indicatorCount: number;
  /** Lookup (interaction) tables — one f64 region per model lookupTable attr, sized
   *  rows*cols. `lookupTableOffset[id]` is the byte offset + `lookupTableCols[id]`
   *  the col stride; the worker copies `cachedInteractionTables[id]` in. */
  lookupTableOffset: Record<string, number>;
  lookupTableCols: Record<string, number>;
  lookupTableBytes: number;
  /** Cell field arrays (`_field_<id>`) — the closed agent↔grid morphogen feedback.
   *  One f64 region per agent-accessible cell attr, sized `fieldTotal` (= W*H*D).
   *  The worker copies `readAttrs[id]` (as f64) in before the call and copies the
   *  readWrite ones back after (the deposit). `fieldOffset[id]` is the byte offset. */
  fieldOffset: Record<string, number>;
  fieldTotal: number;
  fieldBytes: number;
  /** Agent Stop Event flag (Uint32, length 1). The WASM agent behaviour writes a
   *  1-based stop index here (first-match-wins); the worker reads it back after the
   *  step and merges into the shared stopFlag. Always reserved (4 bytes) so the
   *  offset is stable regardless of whether the graph has a Stop Event. */
  stopFlagOffset: number;
  /** P2 — USER BOND ATTRIBUTES. `bondAttrOffset[id]` is the RAGGED region
   *  (maxAgents*maxBonds, Int32 or Float64 per `bondAttrKind`); `bondFormAttrOffset[id]`
   *  is the PER-AGENT f64 Form-Bond request cell (the initial value). Both empty
   *  `{}` when the model has no bond attributes OR `maxBonds === 0`, so every
   *  pre-P2 layout is byte-identical (these regions are appended LAST). */
  bondAttrOffset: Record<string, number>;
  bondFormAttrOffset: Record<string, number>;
  /** P4 — the STRUCTURAL REQUEST QUEUE stride (`D + 1`, the overflow bucket
   *  included). `1` reproduces the pre-P4 single-slot layout byte-for-byte, which
   *  is what a model whose agent graph uses no queue verb gets. The four request
   *  regions (`bondFormReq`/`bondBreakReq`/`bondFormL`/`bondFormK`) and every
   *  `bondFormAttrOffset` cell are sized `maxAgents * bondReqSlots`; entry `c` of
   *  agent `idx` lives at `idx * bondReqSlots + c`. See
   *  [bondRequestQueue.ts](../../modeler/vpl/compiler/bondRequestQueue.ts). */
  bondReqSlots: number;
  /** L2 — Get Generation: byte offset of a single f64 holding the 0-based index
   *  of the generation being computed. The worker keeps a Float64Array VIEW here
   *  and refreshes it whenever the counter moves, so the WASM agent behaviour
   *  reads it with a plain `f64.load` and the 16-param behaviour SIGNATURE is
   *  untouched. ALWAYS reserved (8 bytes) and appended dead LAST, so every offset
   *  above is byte-identical — which is why the WASM agent surface needs no usage
   *  gate: an unused generation emits no load and the module bytes are unchanged. */
  generationOffset: number;
  /** C10 / P11a — the Barnes–Hut octree node RESERVE (0 ⇒ the tree regions are not
   *  reserved at all and the offsets below are meaningless; that is the state of
   *  every model that does not use GLOBAL charge, which is why their layouts stay
   *  byte-identical). */
  chargeTreeNodes: number;
  /** Morton-SORTED positions, `maxAgents` f64 each (z all-zero in 2D). */
  treeSortedXOffset: number; treeSortedYOffset: number; treeSortedZOffset: number;
  /** Per-node centre of mass + bbox extent, `chargeTreeNodes` f64 each. */
  treeNodeCxOffset: number; treeNodeCyOffset: number; treeNodeCzOffset: number;
  treeNodeExtOffset: number;
  /** Per-node point range + SKIP LINK, `chargeTreeNodes` i32 each. `next === n+1`
   *  is the leaf test; `mass === end - start`. */
  treeNodeStartOffset: number; treeNodeEndOffset: number; treeNodeNextOffset: number;
  /** Sprite display state — reserved ONLY when the C9 `sprites` gate is on, so a
   *  sprite-free model's layout is byte-identical. `false` ⇒ the five offsets are
   *  meaningless and the WASM emitter must drop every sprite facet (the C9 safety
   *  catch, mirroring `layout.f64[name] === undefined` for the gated f64 group). */
  spritesReserved: boolean;
  /** `maxAgents` i32 (0 = no sprite, ≥1 = 1-based slot into `model.sprites`). */
  spriteIdsOffset: number;
  /** `maxAgents` f64 each: current frame (fractional), frames/step, facing in
   *  COMPASS degrees, per-agent size multiplier (0 = use the asset's scale). */
  spriteFramesOffset: number; spriteSpeedsOffset: number;
  spriteRotationsOffset: number; spriteScalesOffset: number;
}

/** Sizing inputs for the FULL-COVERAGE WASM agent layout regions — the compiler +
 *  the worker derive these from the SAME model so the baked offsets match. All 0 by
 *  default (the Boids/drift path), so the regions collapse to nothing. */
export interface AgentLayoutExtras {
  /** Per-agent array-scratch bytes (sum over array producers / array vars, worst-
   *  case). The compiler computes a conservative bound; the worker mirrors it. */
  scratchBytes?: number;
  /** Ordered model-attribute keys (color attrs expanded to id_r/id_g/id_b). */
  modelAttrKeys?: string[];
  /** Number of indicator cells. */
  indicatorCount?: number;
  /** Lookup-table id → { rows, cols } (row-major, stride cols). MULTI-AXIS
   *  (N-D) tables additionally carry `dims`/`mins` — the region is then sized
   *  `Π dims` (the emitter clamps per axis); `dims` present ⇔ multi-axis. */
  lookupTables?: Record<string, { rows: number; cols: number; dims?: number[]; mins?: number[] }>;
  /** Ordered agent-accessible cell-field attr ids. */
  fieldIds?: string[];
  /** Cell field length = W*H*D. */
  fieldTotal?: number;
  /** Sync agent mode — reserve a SEPARATE attr-write region per attr (the WASM
   *  behaviour reads attrRead, writes attrWrite; the worker primes + swaps). */
  syncAttrs?: boolean;
  /** P2 — USER BOND attributes, in `model.bondAttributes` order. Each gets ONE
   *  ragged region (maxAgents*maxBonds, typed by `bondAttrKind`) plus one
   *  per-agent f64 Form-Bond REQUEST cell. Empty / `maxBonds === 0` ⇒ zero bytes,
   *  so every existing model's layout is byte-identical. The store passes its own
   *  specs through `createAgentStore`, and the WASM compiler derives the SAME list
   *  from the model via `buildAgentLayoutExtras` — the baked-offset lockstep. */
  bondAttrSpecs?: AgentAttrSpec[];
  /** P4 — the STRUCTURAL REQUEST QUEUE stride (`D + 1`). Absent / 1 ⇒ the pre-P4
   *  single-slot layout, byte-identical. Computed ONCE by
   *  `bondReqSlotsForModel(model)` in `buildAgentLayoutExtras` (main thread) and
   *  SHIPPED to the worker, so the compiler's baked stride and the store's array
   *  shapes derive from one number. */
  bondReqSlots?: number;
  /** C9 / STEP 4 — which OPTIONAL per-agent field groups to allocate
   *  (`resolveAgentFieldGates(model)`). ABSENT ⇒ all on ⇒ byte-identical to
   *  pre-C9. `createAgentStore`'s `opts.fieldGates` OVERRIDES this (the
   *  `syncAttrs` / `bondAttrSpecs` / `bondReqSlots` precedent) so the allocated
   *  arrays and the baked offsets are computed from ONE record. */
  fieldGates?: AgentFieldGates;
  /** C10 / P11a — the Barnes–Hut octree NODE RESERVE for GLOBAL charge. 0 / absent
   *  ⇒ NO tree regions are reserved at all, so every model that does not use global
   *  charge keeps a byte-identical layout (and therefore byte-identical WASM). Set
   *  from `agentOctreeNodeReserve(maxAgents)` by `buildAgentLayoutExtras` when
   *  `usesGlobalCharge(cfg)`, and mirrored into the store by `createAgentStore` —
   *  the compiler bakes offsets from this number, so the two MUST derive it from
   *  the same resolver. */
  chargeTreeNodes?: number;
}

/** The number of `getNearbyAgents` scratch buffers the wasmBacked agent layout
 *  reserves. A graph exceeding it is rejected by `isAgentGraphWasmSupported`
 *  (→ JS fallback), never silently corrupted. */
export const AGENT_NEARBY_SCRATCH_SLOTS = 4;

/** AW-HASH reserve bound. The spatial-hash bin count is `nBinsX*nBinsY*nBinsZ`
 *  with `nBinsAxis = floor(worldAxis / binEdge)` and a per-step `binEdge =
 *  max(interactionRange*2*maxRadius, neighbourQueryRadius)`. Since `maxRadius`
 *  only ever GROWS the bin edge (→ FEWER bins), the worst case (most bins) is the
 *  SMALLEST possible bin edge, governed by the default radius + the neighbour
 *  query radius. We reserve from that minimum edge (capped) so the runtime hash
 *  always fits; a degenerate config that still overflows hits the worker's
 *  fits-check + JS fallback. Pure — mirrors how the worker computes `binEdge`. */
/** The maximum number of spatial-hash bins the engine will ever use in a single
 *  step — a CONSTANT independent of the world size. `buildSpatialHash` coarsens
 *  the bin edge so the per-step bin count never exceeds this, so the per-step
 *  hash cost (the `binStart.fill` + the WASM copy-in) is bounded REGARDLESS of
 *  how large the grid / agent world is. Filling/copying ~64K ints per step is a
 *  fraction of a millisecond, so the agent loop cost tracks the AGENT COUNT (and
 *  their spread), not the environment size — the property a sparse off-lattice
 *  population should have. (Was an effectively-unbounded 1<<20 world-derived
 *  reserve, which made a big grid silently slow the agents + reserve ~MBs.) */
export const AGENT_HASH_BIN_CAP = 1 << 16; // 65,536 bins

export function computeAgentMaxHashBins(
  worldWidth: number, worldHeight: number, worldDepth: number,
  interactionRange: number, defaultRadius: number, neighbourQueryRadius: number,
): number {
  const is3d = worldDepth > 1;
  // The minimum bin edge across a run (maxRadius ≥ defaultRadius only grows it).
  const minEdge = Math.max(1e-3, interactionRange * 2 * defaultRadius, neighbourQueryRadius);
  const nx = Math.max(1, Math.floor(worldWidth / minEdge));
  const ny = Math.max(1, Math.floor(worldHeight / minEdge));
  const nz = is3d ? Math.max(1, Math.floor(worldDepth / minEdge)) : 1;
  // Reserve = min(world-bin-count, the constant cap). A small world reserves only
  // what it needs; a huge world reserves the cap (and the per-step hash coarsens
  // its bin edge to fit, see buildSpatialHash) — so the reserve never blows up
  // with the world size (the "arbitrary limit scaling the volume up" report).
  return Math.min(AGENT_HASH_BIN_CAP, nx * ny * nz);
}

/** C9 / STEP 4 — the OPTIONAL per-agent f64 fields, each keyed by its gate. A
 *  gated-OFF field is omitted from the layout entirely (no offset, no bytes) and
 *  its store array is ZERO-LENGTH — on which `a[i] = v` is a silent no-op, so
 *  every engine WRITE needs no guard; only reads do (`?? 0`). */
const AGENT_F64_GATED: Record<string, keyof AgentFieldGates> = {
  targetRadius: 'targetRadius', age: 'age', density: 'density',
};

const AGENT_F64_FIELDS = [
  'x', 'y', 'z', 'xNext', 'yNext', 'zNext', 'vx', 'vy', 'vz',
  'forceX', 'forceY', 'forceZ', 'radius', 'targetRadius', 'age',
  'divideAxisX', 'divideAxisY', 'divideAxisZ', 'divideAsym',
  'bondFormL', 'bondFormK',
  'density',
] as const;
const AGENT_I32_FIELDS = [
  'lineage', 'epoch', 'bondCount',
  'bondFormReq', 'bondBreakReq',
] as const;
const AGENT_U8_FIELDS = ['alive', 'divideRequest', 'killRequest'] as const;
const AGENT_BOND_I32_FIELDS = ['bondPartner', 'bondPartnerEpoch', 'bondTypeLabel'] as const;
const AGENT_BOND_F64_FIELDS = ['bondRestLength', 'bondStiffness'] as const;

/** P4 — the per-agent fields that are QUEUE-shaped (`maxAgents * bondReqSlots`
 *  instead of `maxAgents`). ONE list, consumed by the layout AND the store's
 *  array factories, so a field cannot be sized one way in the baked offsets and
 *  another way in the view over them. `bondFormAttr_<id>` (P2's per-attribute
 *  Form-Bond initial value) is queue-shaped too — it is part of a form entry, so
 *  missing it would smear one entry's initial values across the whole queue. */
const AGENT_REQUEST_QUEUE_FIELDS: ReadonlySet<string> = new Set([
  'bondFormReq', 'bondBreakReq', 'bondFormL', 'bondFormK',
]);

function alignTo(off: number, align: number): number {
  return Math.ceil(off / align) * align;
}

/** Byte width of an agent-attribute kind (uint8→1, int32→4, float64→8). */
function attrKindBytes(kind: AgentAttrKind): number {
  return kind === 'uint8' ? 1 : kind === 'int32' ? 4 : 8;
}

/** Compute the byte layout of the agent SoA on a WebAssembly.Memory. Pure (no
 *  allocation). Every per-agent Float64 region is 8-byte aligned, Int32 4-byte,
 *  Uint8 1-byte; ragged bond regions are sized maxAgents*maxBonds; colors is
 *  maxAgents*4; each user attr gets its own region typed by its spec kind. All
 *  regions are non-overlapping within `totalBytes`. */
export function computeAgentMemoryLayout(
  maxAgents: number,
  maxBonds: number,
  attrSpecs: AgentAttrSpec[],
  /** AW-HASH reserve (PR6b-2): the max spatial-hash bin count the WASM behaviour
   *  may read. Appended at the END of the layout (after attrs) so every existing
   *  region offset is byte-identical — the drift-test (no hash) path is
   *  unaffected. 0 ⇒ no hash region (a behaviour that never queries the hash). */
  maxHashBins = 0,
  /** FULL-COVERAGE region sizing (the whole-catalogue WASM agent port). Default
   *  `{}` ⇒ all regions collapse to nothing (byte-identical to the Boids/drift
   *  layout). The compiler + worker build this from the SAME model. */
  extras: AgentLayoutExtras = {},
): AgentMemoryLayout {
  let off = 0;
  const f64: Record<string, number> = {};
  const i32: Record<string, number> = {};
  const u8: Record<string, number> = {};
  const bondI32: Record<string, number> = {};
  const bondF64: Record<string, number> = {};
  const attrOffset: Record<string, number> = {};

  // P4 — the request-queue stride (D+1). 1 ⇒ the pre-P4 single-slot layout, so
  // every offset below is byte-identical for a model that uses no queue verb.
  const bondReqSlots = Math.max(1, Math.floor(extras.bondReqSlots ?? 1));
  // C9 / STEP 4 — the optional-field gates. ABSENT ⇒ all on ⇒ every offset below
  // is byte-identical to pre-C9 (the model that keeps all four groups).
  const gates = normalizeFieldGates(extras.fieldGates);
  // Per-agent Float64 (8-aligned, maxAgents*8 each; the queue fields ×bondReqSlots)
  for (const name of AGENT_F64_FIELDS) {
    // C9 — a gated-OFF optional field reserves NO bytes and gets NO offset, so
    // `layout.f64[name] === undefined` is the emitters' "read the default" signal.
    const gk = AGENT_F64_GATED[name];
    if (gk && !gates[gk]) continue;
    off = alignTo(off, 8);
    f64[name] = off;
    off += maxAgents * (AGENT_REQUEST_QUEUE_FIELDS.has(name) ? bondReqSlots : 1) * 8;
  }
  // Per-agent Int32 (4-aligned, maxAgents*4 each; the queue fields ×bondReqSlots)
  for (const name of AGENT_I32_FIELDS) {
    off = alignTo(off, 4);
    i32[name] = off;
    off += maxAgents * (AGENT_REQUEST_QUEUE_FIELDS.has(name) ? bondReqSlots : 1) * 4;
  }
  // Ragged bond Int32 (4-aligned, maxAgents*maxBonds*4 each)
  for (const name of AGENT_BOND_I32_FIELDS) {
    off = alignTo(off, 4);
    bondI32[name] = off;
    off += maxAgents * maxBonds * 4;
  }
  // Ragged bond Float64 (8-aligned, maxAgents*maxBonds*8 each)
  for (const name of AGENT_BOND_F64_FIELDS) {
    off = alignTo(off, 8);
    bondF64[name] = off;
    off += maxAgents * maxBonds * 8;
  }
  // freeList (Int32, maxAgents*4)
  off = alignTo(off, 4);
  const freeListOffset = off;
  off += maxAgents * 4;
  // Per-agent Uint8 (1-aligned, maxAgents each)
  for (const name of AGENT_U8_FIELDS) {
    u8[name] = off;
    off += maxAgents;
  }
  // colors (Uint8 RGBA, maxAgents*4)
  const colorsOffset = off;
  off += maxAgents * 4;
  // User attributes — one region per spec, aligned + sized by its kind.
  for (const spec of attrSpecs) {
    const kind = agentAttrKind(spec.type);
    const ib = attrKindBytes(kind);
    off = alignTo(off, ib);
    attrOffset[spec.id] = off;
    off += maxAgents * ib;
  }

  // --- AW-RNG + AW-HASH control region (appended last → existing offsets stable) ---
  // RNG state cell (Uint32, length 1, 4-aligned).
  off = alignTo(off, 4);
  const rngStateOffset = off;
  off += 4;
  // Hash binStart (Int32, length maxHashBins + 1) + binAgents (Int32, length
  // maxAgents). Both 4-aligned. Reserve 0 when maxHashBins===0 (no hash).
  off = alignTo(off, 4);
  const hashBinStartOffset = off;
  off += (maxHashBins + 1) * 4;
  off = alignTo(off, 4);
  const hashBinAgentsOffset = off;
  off += maxAgents * 4;
  // getNearbyAgents per-node scratch (Int32, AGENT_NEARBY_SCRATCH_SLOTS × maxAgents).
  // Only reserved when there's a hash region (maxHashBins>0) — a behaviour that
  // never queries the hash never calls getNearbyAgents.
  off = alignTo(off, 4);
  const nearbyScratchSlots = maxHashBins > 0 ? AGENT_NEARBY_SCRATCH_SLOTS : 0;
  const nearbyScratchOffset = off;
  off += nearbyScratchSlots * maxAgents * 4;

  // --- FULL-COVERAGE regions (appended last → all PR6b-2 offsets byte-stable). ---
  // General per-agent array scratch (f64-aligned so any element type fits).
  off = alignTo(off, 8);
  const scratchOffset = off;
  const scratchBytes = Math.max(0, Math.floor(extras.scratchBytes ?? 0));
  off += scratchBytes;
  // Model attributes — one f64 cell per key.
  off = alignTo(off, 8);
  const modelAttrOffset: Record<string, number> = {};
  const modelAttrKeys = extras.modelAttrKeys ?? [];
  for (const k of modelAttrKeys) { modelAttrOffset[k] = off; off += 8; }
  const modelAttrBytes = modelAttrKeys.length * 8;
  // Indicators — f64 cells.
  off = alignTo(off, 8);
  const indicatorsOffset = off;
  const indicatorCount = Math.max(0, Math.floor(extras.indicatorCount ?? 0));
  off += indicatorCount * 8;
  // Lookup tables — one f64 region per table (rows*cols).
  off = alignTo(off, 8);
  const lookupTableOffset: Record<string, number> = {};
  const lookupTableCols: Record<string, number> = {};
  let lookupTableBytes = 0;
  const lookupTables = extras.lookupTables ?? {};
  for (const id of Object.keys(lookupTables)) {
    const { rows, cols, dims } = lookupTables[id]!;
    off = alignTo(off, 8);
    lookupTableOffset[id] = off;
    lookupTableCols[id] = cols;
    // Multi-axis tables reserve Π dims cells; legacy reserve rows*cols.
    const n = Math.max(0, dims && dims.length > 0 ? dims.reduce((a, b) => a * Math.max(1, b), 1) : rows * cols);
    off += n * 8;
    lookupTableBytes += n * 8;
  }
  // Cell field arrays — one f64 region per agent-accessible cell attr (sized total).
  off = alignTo(off, 8);
  const fieldOffset: Record<string, number> = {};
  const fieldIds = extras.fieldIds ?? [];
  const fieldTotal = Math.max(0, Math.floor(extras.fieldTotal ?? 0));
  for (const id of fieldIds) { off = alignTo(off, 8); fieldOffset[id] = off; off += fieldTotal * 8; }
  const fieldBytes = fieldIds.length * fieldTotal * 8;

  // Sync attr-write region — a SECOND copy of each user attr (sync agent mode only).
  const attrWriteOffset: Record<string, number> = {};
  const syncAttrs = !!extras.syncAttrs;
  if (syncAttrs) {
    for (const spec of attrSpecs) {
      const ib = attrKindBytes(agentAttrKind(spec.type));
      off = alignTo(off, ib);
      attrWriteOffset[spec.id] = off;
      off += maxAgents * ib;
    }
  }

  // Agent Stop Event flag (Uint32, length 1) — appended last so every existing
  // region offset is byte-stable. Always reserved (4 bytes, negligible).
  off = alignTo(off, 4);
  const stopFlagOffset = off;
  off += 4;

  // --- P2 USER BOND ATTRIBUTES (appended AFTER every existing region, so a model
  // with none is byte-identical and one with some shifts nothing). Per attribute:
  //   • one RAGGED region (maxAgents*maxBonds), Int32 or Float64 by `bondAttrKind`
  //   • one PER-AGENT f64 Form-Bond request cell (the initial value the structural
  //     phase hands to `formBond`) — the exact shape of `bondFormL` / `bondFormK`.
  // maxBonds === 0 (Bonds capability off) ⇒ zero ragged bytes; the request cells
  // are also skipped (a bonds-off model can raise no form request).
  const bondAttrOffset: Record<string, number> = {};
  const bondFormAttrOffset: Record<string, number> = {};
  const bondAttrSpecs = extras.bondAttrSpecs ?? [];
  if (maxBonds > 0) {
    for (const spec of bondAttrSpecs) {
      const ib = bondAttrKind(spec.type) === 'float64' ? 8 : 4;
      off = alignTo(off, ib);
      bondAttrOffset[spec.id] = off;
      off += maxAgents * maxBonds * ib;
    }
    for (const spec of bondAttrSpecs) {
      off = alignTo(off, 8);
      bondFormAttrOffset[spec.id] = off;
      // P4 — QUEUE-shaped: one initial-value cell per queue entry (see
      // AGENT_REQUEST_QUEUE_FIELDS). bondReqSlots === 1 ⇒ byte-identical to P2.
      off += maxAgents * bondReqSlots * 8;
    }
  }

  // L2 — Get Generation: one f64 cell, appended after EVERY other region so no
  // baked offset above can shift. Always reserved (8 bytes, negligible).
  off = alignTo(off, 8);
  const generationOffset = off;
  off += 8;

  // --- C10 / P11a — the BARNES–HUT OCTREE regions (GLOBAL charge only) --------
  // Appended after EVERY existing region and reserved ONLY when the model uses
  // global charge (`chargeTreeNodes > 0`), so a cutoff/off model keeps a
  // byte-identical layout. The worker COPIES the engine-built tree in here before
  // the WASM force pass, exactly like the AW-HASH copy; the WASM traversal then
  // reads it at these baked offsets, so JS and WASM walk the same numbers.
  //   • sorted positions (3 × maxAgents f64) — Morton order; z is all-zero in 2D
  //   • node start/end/next (3 × nodes i32) — `next` is the SKIP LINK
  //   • node centre-of-mass x/y/z + extent (4 × nodes f64)
  const chargeTreeNodes = Math.max(0, Math.floor(extras.chargeTreeNodes ?? 0));
  off = alignTo(off, 8);
  const treeSortedXOffset = off; off += chargeTreeNodes > 0 ? maxAgents * 8 : 0;
  const treeSortedYOffset = off; off += chargeTreeNodes > 0 ? maxAgents * 8 : 0;
  const treeSortedZOffset = off; off += chargeTreeNodes > 0 ? maxAgents * 8 : 0;
  const treeNodeCxOffset = off; off += chargeTreeNodes * 8;
  const treeNodeCyOffset = off; off += chargeTreeNodes * 8;
  const treeNodeCzOffset = off; off += chargeTreeNodes * 8;
  const treeNodeExtOffset = off; off += chargeTreeNodes * 8;
  off = alignTo(off, 4);
  const treeNodeStartOffset = off; off += chargeTreeNodes * 4;
  const treeNodeEndOffset = off; off += chargeTreeNodes * 4;
  const treeNodeNextOffset = off; off += chargeTreeNodes * 4;

  // --- SPRITE display state (appended after EVERY existing region) ------------
  // The five per-agent sprite buffers used to be plain JS arrays — the ONE field
  // group with no baked byte on any target — which is exactly why Set Agent
  // Sprite had no WASM emit and clamped a behaviour graph to JS. Giving them a
  // region makes the WASM module and the JS engine read/write the SAME bytes, so
  // the node emits like any other setter. Reserved ONLY when the sprites gate is
  // on (`model.sprites` non-empty OR the graph sets one), so every sprite-free
  // model keeps a byte-identical layout; and appended LAST so even a model that
  // DOES carry sprites shifts no offset that is already baked into a module.
  const spriteN = gates.sprites ? maxAgents : 0;
  off = alignTo(off, 8);
  const spriteFramesOffset = off; off += spriteN * 8;
  const spriteSpeedsOffset = off; off += spriteN * 8;
  const spriteRotationsOffset = off; off += spriteN * 8;
  const spriteScalesOffset = off; off += spriteN * 8;
  off = alignTo(off, 4);
  const spriteIdsOffset = off; off += spriteN * 4;

  const totalBytes = alignTo(off, 8);
  const pages = Math.max(1, Math.ceil(totalBytes / 65536));
  return {
    totalBytes, pages, maxAgents, maxBonds, f64, i32, u8, bondI32, bondF64,
    attrWriteOffset, syncAttrs,
    colorsOffset, freeListOffset, attrOffset,
    rngStateOffset, maxHashBins, hashBinStartOffset, hashBinAgentsOffset,
    nearbyScratchSlots, nearbyScratchOffset,
    scratchOffset, scratchBytes,
    modelAttrOffset, modelAttrBytes,
    indicatorsOffset, indicatorCount,
    lookupTableOffset, lookupTableCols, lookupTableBytes,
    fieldOffset, fieldTotal, fieldBytes,
    stopFlagOffset,
    bondAttrOffset, bondFormAttrOffset, bondReqSlots,
    generationOffset,
    chargeTreeNodes,
    treeSortedXOffset, treeSortedYOffset, treeSortedZOffset,
    treeNodeCxOffset, treeNodeCyOffset, treeNodeCzOffset, treeNodeExtOffset,
    treeNodeStartOffset, treeNodeEndOffset, treeNodeNextOffset,
    spritesReserved: spriteN > 0,
    spriteIdsOffset, spriteFramesOffset, spriteSpeedsOffset,
    spriteRotationsOffset, spriteScalesOffset,
  };
}

export interface AgentStore {
  config: CenterBasedConfig;
  maxAgents: number;
  maxBonds: number;
  worldWidth: number;
  worldHeight: number;
  /** Agent world depth — `gridDepth` (the agent world IS the grid 1:1). `1` in a
   *  2D model (the byte-identical 2D fast path); `>1` runs the 3D agent engine.
   *  The single agent-engine 3D predicate (`worldDepth > 1`) — the engine analogue
   *  of the compiler's `is3dModel(model)`; the MIRROR invariant (B2) is
   *  `is3dModel(model) ⟺ store.worldDepth > 1`. Set in `initAgents` from the SAME
   *  grid `depth` local (do NOT read the dormant `CenterBasedConfig.worldDepth`).
   *  Placeholder `1` until then; NOT serialized (re-derived from `gridDepth`). */
  worldDepth: number;

  // --- engine geometry (Float64) ---
  x: Float64Array; y: Float64Array;
  /** z-axis (3D agents). Always allocated; in a 2D model these stay 0 (the
   *  2D-ZERO invariant — `initAgentSlot` zeroes them, the 2D force/division
   *  branches never touch them), so the 2D numeric output is bit-identical. */
  z: Float64Array;
  /** Position double-buffer (overdamped Euler reads x/y, writes xNext/yNext, swaps). */
  xNext: Float64Array; yNext: Float64Array;
  /** z double-buffer (3D; always-allocated, 2D-ZERO in 2D). */
  zNext: Float64Array;
  /** Velocity (persisted when `momentum > 0` — boids/flocking; 0 = overdamped). */
  vx: Float64Array; vy: Float64Array;
  /** z velocity (3D; always-allocated, 2D-ZERO in 2D). */
  vz: Float64Array;
  /** Per-step net force accumulator. Reset to 0 each step; the behaviour graph's
   *  Apply Force adds into it BEFORE the engine soft-sphere + bond springs, so
   *  the force law is graph-authorable on top of (or instead of) the engine's. */
  forceX: Float64Array; forceY: Float64Array;
  /** z force accumulator (3D; always-allocated, 2D-ZERO in 2D). */
  forceZ: Float64Array;
  radius: Float64Array; targetRadius: Float64Array;
  age: Float64Array;

  // --- identity (Int32) ---
  lineage: Int32Array;

  // --- liveness ---
  alive: Uint8Array;
  /** Slot-generation tag, bumped on recycle — the dangling-bond ABI (PR-B). */
  epoch: Int32Array;

  // --- engine-computed per-agent reductions (filled by the driver, PR-A3+) ---
  bondCount: Int32Array;
  density: Float64Array;

  // --- ragged bond store (per-agent maxBonds slots; PR-B) ---
  bondPartner: Int32Array;       // length maxAgents*maxBonds; partner agent id (-1 = empty slot)
  bondPartnerEpoch: Int32Array;  // partner's epoch at form time — checked every read
  bondRestLength: Float64Array;  // L
  bondStiffness: Float64Array;   // λ
  bondTypeLabel: Int32Array;     // bond class

  // --- USER BOND ATTRIBUTES (P2) — per-EDGE state, the graph-rewriting enabler.
  // One ragged region per attribute, addressed exactly like the built-in bond
  // fields (`base = idx * maxBonds`, slot `k`), typed by `bondAttrKind`. SINGLE-
  // buffered (a bond is one object stored twice, so a write goes to BOTH slots —
  // invariant I2; there is no read/write double buffer to keep in step).
  /** Bond-attribute specs in `model.bondAttributes` order (empty when none, or
   *  when the Bonds capability is off). Drives the layout, the ABI block, the
   *  compaction field list and (de)serialization. */
  bondAttrSpecs: AgentAttrSpec[];
  /** attr id → its ragged region (length maxAgents*maxBonds; 0 when bonds off). */
  bondAttrs: Record<string, AgentTypedArray>;
  /** attr id → its region kind (mirrors `bondAttrKind(spec.type)`). */
  bondAttrKinds: Record<string, 'int32' | 'float64'>;
  /** attr id → the per-agent f64 Form-Bond REQUEST cell (the initial value the
   *  structural phase hands to `formBond`) — the sibling of `bondFormL`/`bondFormK`. */
  bondFormAttrs: Record<string, Float64Array>;
  /** THE COMPACTION FIELD LIST — every ragged per-bond-slot array (the five
   *  built-ins + one per bond attribute), in a fixed order. `moveBondSlot` is the
   *  ONLY place a bond slot's contents move, and it iterates THIS list, so a field
   *  added to the store cannot be missed by a compaction path (the silent
   *  swap-with-last corruption class). Built once in `createAgentStore`; the arrays
   *  are never reference-swapped (deserialize copies INTO them), so caching the
   *  references is safe. */
  bondSlotArrays: AgentTypedArray[];

  // --- request buffers the graph writes (validated + applied post-step; PR-B/C/D) ---
  divideRequest: Uint8Array;
  divideAxisX: Float64Array;
  divideAxisY: Float64Array;
  /** z component of the requested division axis (3D; transient, always-allocated,
   *  NOT serialized — like `divideRequest`/`divideAxisX`). 2D-ZERO in 2D. */
  divideAxisZ: Float64Array;
  divideAsym: Float64Array;
  killRequest: Uint8Array;
  // --- P4 — the STRUCTURAL REQUEST QUEUE. `bondReqSlots = D + 1` entries per
  // agent, addressed `idx * bondReqSlots + c`; entry D is the OVERFLOW BUCKET
  // (written by every op past the queue, applied by none — its occupancy IS the
  // overflow flag). Every entry carries BOTH sides, so one entry expresses all
  // three verbs and `rewireBond` is atomic by construction (invariant I5):
  //   bondBreakReq / bondFormReq   0 = empty · 1 = side unused · v+2 = agent v
  //   bondFormL / bondFormK        the FORM half's rest length + stiffness
  // See src/modeler/vpl/compiler/bondRequestQueue.ts for the encoding rationale.
  /** Queue stride (`D + 1`). 1 ⇒ the pre-P4 single-slot shape. */
  bondReqSlots: number;
  /** FORM side of each queue entry (`0` empty · `1` none · `id + 2`). */
  bondFormReq: Int32Array;
  /** Rest length L for the entry's form half (`0` ⇒ the contact distance). */
  bondFormL: Float64Array;
  /** Stiffness λ for the entry's form half (`0` ⇒ the model's bond stiffness). */
  bondFormK: Float64Array;
  /** BREAK side of each queue entry (`0` empty · `1` none · `id + 2`). */
  bondBreakReq: Int32Array;

  // --- per-agent RGBA appearance (written by the agent colour pass; PR-A3) ---
  colors: Uint8ClampedArray;

  // --- agent sprites (DISPLAY) — PERSISTENT per-agent sprite state set by the Set
  //     Agent Sprite node (in the JS agent colour / behaviour pass) and advanced by
  //     the engine each step. Always plain arrays (never wasm/webgpu-backed — no
  //     agent compiler touches them; the decoded image frames live on the main
  //     thread). spriteIds: 0 = no sprite (draw the circle), >=1 = 1-based slot into
  //     model.sprites. spriteFrames: current frame (fractional; the engine does
  //     `frame += speed` each step; the render floors + wraps/clamps by the sprite's
  //     loop flag). spriteSpeeds: playback speed in frames per step (negative =
  //     reverse, 0 = hold). All reset to 0 on slot (re)allocation. ---
  spriteIds: Int32Array;
  spriteFrames: Float64Array;
  spriteSpeeds: Float64Array;
  // spriteRotations: per-agent facing angle in COMPASS degrees (0 = up/north,
  // clockwise), set by the Set Agent Sprite node's rotation facet. The render
  // aligns the sprite art's default direction to this (or to the velocity heading
  // when the sprite's orientToVelocity is on). spriteScales: per-agent size
  // multiplier override (0 = use the sprite asset's default scale, >0 = override).
  spriteRotations: Float64Array;
  spriteScales: Float64Array;

  // --- user attributes (r_<id> / w_<id>, sized maxAgents; D-IDX) ---
  attrSpecs: AgentAttrSpec[];
  attrRead: Record<string, AgentTypedArray>;
  attrWrite: Record<string, AgentTypedArray>;
  attrKind: Record<string, AgentAttrKind>;

  // --- loop bound + tallies + free-list ---
  highWater: number;   // exclusive loop bound; slots [0, highWater) may be alive or holes
  liveCount: number;   // display tally (NOT a loop bound)
  freeList: Int32Array; // recycled slots (LIFO stack)
  freeTop: number;

  // --- integration ---
  dt: number;          // current (clamped) timestep

  // --- AW-MEM (PR6a): the WebAssembly.Memory backing (opt-in). ---
  /** True when every SoA array above is a VIEW over `memory.buffer` at the
   *  `layout`'s baked offsets (so PR6b's WASM module reads the same bytes).
   *  False (the default) ⇒ the arrays are plain typed arrays (the JS-default
   *  path). Drives the `swapPositions` copy-into-vs-reference-swap discipline. */
  wasmBacked: boolean;
  /** The agent memory (only when `wasmBacked`). PR6b passes this as `env.mem`. */
  memory?: WebAssembly.Memory;
  /** The baked byte layout (only when `wasmBacked`). */
  layout?: AgentMemoryLayout;
  /** True when the agent attribute buffers are DOUBLE-buffered (sync update mode):
   *  `attrWrite` is a SEPARATE array from `attrRead`, so the behaviour reads the
   *  previous step (`attrRead`) and writes the next (`attrWrite`), swapped in at
   *  the step's end (`swapAgentAttrs`). False (default / async) ⇒ `attrWrite`
   *  aliases `attrRead` (immediate writes). Only ever true on the non-wasmBacked
   *  (JS) path — the WASM minimal emitter set writes no user attrs, so the mode is
   *  moot there. */
  syncAttrs: boolean;
  /** C9 / STEP 4 — which OPTIONAL field groups this store allocated. A gated-OFF
   *  group's arrays are ZERO-LENGTH; consult this before READING one (writes are
   *  silent no-ops). The ONE record the layout, the views and the ABI all used. */
  fieldGates: AgentFieldGates;
}

/** Options for `createAgentStore`. `wasmBacked` (default false) relocates the
 *  whole SoA onto a single WebAssembly.Memory as views at baked offsets (AW-MEM,
 *  PR6a) — PR6b passes this for the WASM target. Default false = plain typed
 *  arrays (the byte-untouched JS-default path). */
export interface CreateAgentStoreOpts {
  wasmBacked?: boolean;
  /** Sync agent update mode: allocate `attrWrite` as a SEPARATE buffer from
   *  `attrRead` (double-buffered attributes). Ignored under `wasmBacked` (the
   *  WASM minimal set writes no user attrs, so the mode is moot — kept aliased).
   *  Default false ⇒ single-buffer (async, byte-identical to pre-feature). */
  syncAttrs?: boolean;
  /** AW-HASH reserve (PR6b-2): the max spatial-hash bin count the wasmBacked
   *  layout reserves room for (binStart = maxHashBins+1 Int32). Only meaningful
   *  under `wasmBacked` (the WASM behaviour reads the in-memory hash). 0 (default)
   *  ⇒ no hash region (the minimal drift-test behaviour never queries it). */
  maxHashBins?: number;
  /** FULL-COVERAGE WASM agent port: the extra-region sizing the wasmBacked layout
   *  reserves (model attrs / indicators / lookup tables / cell fields / array
   *  scratch). The compiler + worker build this from the SAME model. Only used
   *  under `wasmBacked`; the sync-attr write region is driven by `syncAttrs`. */
  layoutExtras?: AgentLayoutExtras;
  /** P2 — USER BOND attributes (`model.bondAttributes`, in order). Allocates one
   *  ragged region + one per-agent Form-Bond request cell each, on BOTH backings,
   *  and OVERRIDES `layoutExtras.bondAttrSpecs` so the allocated arrays and the
   *  baked offsets are computed from one list (the `syncAttrs` precedent).
   *  Default `[]` ⇒ zero bytes ⇒ every existing model is byte-identical. */
  bondAttrSpecs?: AgentAttrSpec[];
  /** P4 — the STRUCTURAL REQUEST QUEUE stride (`D + 1`). The AUTHORITATIVE value:
   *  it overrides `layoutExtras.bondReqSlots` so the allocated arrays and the baked
   *  offsets are computed from one number (the `syncAttrs` / `bondAttrSpecs`
   *  precedent). Shipped by the main thread as `bondReqSlotsForModel(model)` on
   *  EVERY target — the same number the emitters bake. Absent ⇒ derived from the
   *  config's own depth. */
  bondReqSlots?: number;
  /** C9 / STEP 4 — the AUTHORITATIVE optional-field gates for this store: they
   *  override `layoutExtras.fieldGates` so the allocated arrays and the baked
   *  offsets come from ONE record (the `syncAttrs` / `bondReqSlots` precedent).
   *  Shipped by the main thread as `resolveAgentFieldGates(model)` on EVERY
   *  target. Absent ⇒ all groups allocated (byte-identical to pre-C9). */
  fieldGates?: AgentFieldGates;
}

/** Allocate the agent store once from the model's center-based config + agent
 *  attribute specs. By default all arrays are plain JS typed arrays (the
 *  JS-default path, byte-untouched). With `{ wasmBacked: true }` the SAME arrays
 *  are VIEWS over one WebAssembly.Memory at `computeAgentMemoryLayout`'s baked
 *  offsets — so the JS engine code reads them bit-identically while PR6b's WASM
 *  module reads them at fixed offsets. */
export function createAgentStore(
  config: CenterBasedConfig,
  attrSpecs: AgentAttrSpec[],
  opts?: CreateAgentStoreOpts,
): AgentStore {
  const maxAgents = Math.max(1, Math.floor(cbNum(config, 'maxAgents')));
  // maxBonds may be 0 — the pure-force / charged-particle case (no bond store).
  const maxBonds = resolveMaxBonds(config);
  const worldWidth = cbNum(config, 'worldWidth');
  const worldHeight = cbNum(config, 'worldHeight');

  const attrKind: Record<string, AgentAttrKind> = {};
  for (const spec of attrSpecs) attrKind[spec.id] = agentAttrKind(spec.type);

  // P4 — the STRUCTURAL REQUEST QUEUE stride. The main thread computes it ONCE
  // (`bondReqSlotsForModel(model)` — the same number every emitter bakes) and
  // ships it on every target; the explicit opt wins over the (WASM-only) layout
  // extras so the allocated arrays and the baked offsets are one number. The
  // config fallback covers pre-P4 call sites + the harnesses.
  const bondReqSlots = Math.max(1, Math.floor(
    opts?.bondReqSlots ?? opts?.layoutExtras?.bondReqSlots ?? (resolveBondRequestDepth(config) + 1),
  ));

  // C9 / STEP 4 — the optional-field gates. The explicit opt wins over the
  // (WASM-only) layout extras so the arrays below and the baked offsets are one
  // record; absent ⇒ everything allocated (pre-C9 byte-identical).
  const fieldGates = normalizeFieldGates(opts?.fieldGates ?? opts?.layoutExtras?.fieldGates);
  const wasmBacked = !!opts?.wasmBacked;
  // FULL-COVERAGE: sync attrs now apply on BOTH paths (the whole-catalogue WASM
  // module writes user attrs, so sync mode needs a distinct attr-write region —
  // reserved in the wasmBacked layout via `attrWriteOffset`).
  const syncAttrs = !!opts?.syncAttrs;
  let memory: WebAssembly.Memory | undefined;
  let layout: AgentMemoryLayout | undefined;

  // Array factories: plain (default) OR views over one WebAssembly.Memory.
  let f64: (name: typeof AGENT_F64_FIELDS[number]) => Float64Array;
  let i32: (name: typeof AGENT_I32_FIELDS[number]) => Int32Array;
  let u8: (name: typeof AGENT_U8_FIELDS[number]) => Uint8Array;
  let bondI32: (name: typeof AGENT_BOND_I32_FIELDS[number]) => Int32Array;
  let bondF64: (name: typeof AGENT_BOND_F64_FIELDS[number]) => Float64Array;
  let freeListArr: () => Int32Array;
  let colorsArr: () => Uint8ClampedArray;
  let attrArr: (id: string, kind: AgentAttrKind) => AgentTypedArray;

  // The store's OWN bond-attribute specs are authoritative for its own layout —
  // exactly how `syncAttrs` overrides the passed-through extras below, so the
  // allocated arrays and the baked offsets can never disagree.
  const bondAttrSpecs = maxBonds > 0 ? (opts?.bondAttrSpecs ?? []) : [];

  // Queue-shaped fields get `maxAgents * bondReqSlots` elements; everything else
  // keeps `maxAgents` (ONE list — AGENT_REQUEST_QUEUE_FIELDS — drives both the
  // baked offsets and these views, so they cannot disagree).
  // A gated-OFF optional field allocates ZERO elements. Writes to a zero-length
  // typed array are silent no-ops, so no engine write site needs a guard.
  const lenOf = (name: string) => {
    const gk = AGENT_F64_GATED[name];
    if (gk && !fieldGates[gk]) return 0;
    return maxAgents * (AGENT_REQUEST_QUEUE_FIELDS.has(name) ? bondReqSlots : 1);
  };

  // Sprite display buffers — VIEWS over the shared agent memory under a WASM
  // target (so the WASM Set Agent Sprite emit and the JS engine advance agree on
  // every byte), plain arrays otherwise. Zero-length when the sprites gate is off.
  const spriteLen = () => (fieldGates.sprites ? maxAgents : 0);
  let spriteF64: (which: 'spriteFramesOffset' | 'spriteSpeedsOffset' | 'spriteRotationsOffset' | 'spriteScalesOffset') => Float64Array;
  let spriteI32: () => Int32Array;

  if (wasmBacked) {
    const extras: AgentLayoutExtras = { ...(opts?.layoutExtras ?? {}), syncAttrs, bondAttrSpecs, bondReqSlots, fieldGates };
    layout = computeAgentMemoryLayout(maxAgents, maxBonds, attrSpecs, Math.max(0, Math.floor(opts?.maxHashBins ?? 0)), extras);
    memory = new WebAssembly.Memory({ initial: layout.pages });
    const buf = memory.buffer;
    f64 = (name) => new Float64Array(buf, layout!.f64[name] ?? 0, lenOf(name));
    i32 = (name) => new Int32Array(buf, layout!.i32[name]!, lenOf(name));
    u8 = (name) => new Uint8Array(buf, layout!.u8[name]!, maxAgents);
    bondI32 = (name) => new Int32Array(buf, layout!.bondI32[name]!, maxAgents * maxBonds);
    bondF64 = (name) => new Float64Array(buf, layout!.bondF64[name]!, maxAgents * maxBonds);
    freeListArr = () => new Int32Array(buf, layout!.freeListOffset, maxAgents);
    colorsArr = () => new Uint8ClampedArray(buf, layout!.colorsOffset, maxAgents * 4);
    attrArr = (id, kind) => {
      const o = layout!.attrOffset[id]!;
      if (kind === 'uint8') return new Uint8Array(buf, o, maxAgents);
      if (kind === 'int32') return new Int32Array(buf, o, maxAgents);
      return new Float64Array(buf, o, maxAgents);
    };
    spriteF64 = (which) => new Float64Array(buf, layout![which], spriteLen());
    spriteI32 = () => new Int32Array(buf, layout!.spriteIdsOffset, spriteLen());
  } else {
    f64 = (name) => new Float64Array(lenOf(name));
    i32 = (name) => new Int32Array(lenOf(name));
    u8 = () => new Uint8Array(maxAgents);
    bondI32 = () => new Int32Array(maxAgents * maxBonds);
    bondF64 = () => new Float64Array(maxAgents * maxBonds);
    freeListArr = () => new Int32Array(maxAgents);
    colorsArr = () => new Uint8ClampedArray(maxAgents * 4);
    attrArr = (_id, kind) => makeArray(kind, maxAgents);
    spriteF64 = () => new Float64Array(spriteLen());
    spriteI32 = () => new Int32Array(spriteLen());
  }

  const attrRead: Record<string, AgentTypedArray> = {};
  const attrWrite: Record<string, AgentTypedArray> = {};
  for (const spec of attrSpecs) {
    const kind = attrKind[spec.id]!;
    const r = attrArr(spec.id, kind);
    if (spec.defaultValue !== 0) r.fill(spec.defaultValue);
    attrRead[spec.id] = r;
    // ASYNC (default): SINGLE buffer — write aliases read, so an own-agent
    // read-modify-write AND a by-id Set Attribute to a neighbour are immediately
    // visible (sequential semantics).
    // SYNC: DOUBLE buffer — `attrWrite` is a separate array; the behaviour reads
    // the previous step (`attrRead`) and writes the next (`attrWrite`), swapped at
    // the step's end. (Positions are snapshot-integrated in BOTH modes via the
    // engine-owned x/y ↔ xNext/yNext — that's separate from this attribute flag.)
    if (syncAttrs) {
      // SYNC: a distinct write buffer. Under wasmBacked it MUST be a view over the
      // memory's reserved `attrWriteOffset` region (so the WASM module writes the
      // SAME bytes); else a plain typed array.
      let w: AgentTypedArray;
      if (wasmBacked) {
        const o = layout!.attrWriteOffset[spec.id]!;
        const buf = memory!.buffer;
        w = kind === 'uint8' ? new Uint8Array(buf, o, maxAgents)
          : kind === 'int32' ? new Int32Array(buf, o, maxAgents)
          : new Float64Array(buf, o, maxAgents);
      } else {
        w = attrArr(spec.id, kind);
      }
      if (spec.defaultValue !== 0) w.fill(spec.defaultValue);
      attrWrite[spec.id] = w;
    } else {
      attrWrite[spec.id] = r;
    }
  }

  const bondPartner = bondI32('bondPartner').fill(-1);

  // --- USER BOND ATTRIBUTES (P2): one ragged region + one per-agent request cell
  // each. Under wasmBacked these are VIEWS at the layout's baked offsets (so the
  // WASM behaviour reads/writes the SAME bytes); otherwise plain typed arrays.
  const bondAttrs: Record<string, AgentTypedArray> = {};
  const bondAttrKinds: Record<string, 'int32' | 'float64'> = {};
  const bondFormAttrs: Record<string, Float64Array> = {};
  for (const spec of bondAttrSpecs) {
    const kind = bondAttrKind(spec.type);
    bondAttrKinds[spec.id] = kind;
    const n = maxAgents * maxBonds;
    let arr: AgentTypedArray;
    let req: Float64Array;
    if (wasmBacked) {
      const buf = memory!.buffer;
      const o = layout!.bondAttrOffset[spec.id]!;
      arr = kind === 'float64' ? new Float64Array(buf, o, n) : new Int32Array(buf, o, n);
      // P4 — QUEUE-shaped (one initial-value cell per queue entry).
      req = new Float64Array(buf, layout!.bondFormAttrOffset[spec.id]!, maxAgents * bondReqSlots);
    } else {
      arr = kind === 'float64' ? new Float64Array(n) : new Int32Array(n);
      req = new Float64Array(maxAgents * bondReqSlots);
    }
    // Dead slots hold the attribute's default so a freshly-filled slot reads it
    // even before `addBondSlot` writes (defence in depth — addBondSlot always does).
    if (spec.defaultValue !== 0) arr.fill(spec.defaultValue);
    bondAttrs[spec.id] = arr;
    bondFormAttrs[spec.id] = req;
  }

  const bondPartnerEpoch = bondI32('bondPartnerEpoch');
  const bondRestLength = bondF64('bondRestLength');
  const bondStiffness = bondF64('bondStiffness');
  const bondTypeLabel = bondI32('bondTypeLabel');
  // THE compaction field list — every ragged per-slot array, once. `moveBondSlot`
  // iterates it, so `removeBondSlot` / `sweepStaleBonds` (and any future
  // compaction path) can never miss a field.
  const bondSlotArrays: AgentTypedArray[] = [
    bondPartner, bondPartnerEpoch, bondRestLength, bondStiffness, bondTypeLabel,
    ...bondAttrSpecs.map((spec: AgentAttrSpec) => bondAttrs[spec.id]!),
  ];

  return {
    config, maxAgents, maxBonds, worldWidth, worldHeight,
    // worldDepth placeholder — initAgents overwrites it with the grid `depth`
    // local (the 3D predicate). Do NOT read config.worldDepth here (S6): the
    // dormant CenterBasedConfig.worldDepth stays ignored — reading it reintroduces
    // the exact baked/passed desync B2 warns against.
    worldDepth: 1,
    x: f64('x'),
    y: f64('y'),
    z: f64('z'),
    xNext: f64('xNext'),
    yNext: f64('yNext'),
    zNext: f64('zNext'),
    vx: f64('vx'),
    vy: f64('vy'),
    vz: f64('vz'),
    forceX: f64('forceX'),
    forceY: f64('forceY'),
    forceZ: f64('forceZ'),
    radius: f64('radius'),
    targetRadius: f64('targetRadius'),
    age: f64('age'),
    lineage: i32('lineage'),
    alive: u8('alive'),
    epoch: i32('epoch'),
    bondCount: i32('bondCount'),
    density: f64('density'),
    bondPartner,
    bondPartnerEpoch,
    bondRestLength,
    bondStiffness,
    bondTypeLabel,
    bondAttrSpecs, bondAttrs, bondAttrKinds, bondFormAttrs, bondSlotArrays,
    divideRequest: u8('divideRequest'),
    divideAxisX: f64('divideAxisX'),
    divideAxisY: f64('divideAxisY'),
    divideAxisZ: f64('divideAxisZ'),
    divideAsym: f64('divideAsym'),
    killRequest: u8('killRequest'),
    bondReqSlots,
    bondFormReq: i32('bondFormReq'),
    bondFormL: f64('bondFormL'),
    bondFormK: f64('bondFormK'),
    bondBreakReq: i32('bondBreakReq'),
    colors: colorsArr(),
    // Persistent display sprite state. All 0: no sprite, frame 0, hold.
    // C9 / STEP 4 — the sprite block (36 B/agent) is ZERO-LENGTH when the model
    // carries no sprite assets and no Set Agent Sprite node. Every write site
    // (initAgentSlot / divideAgent) is a silent no-op on a zero-length array, and
    // `advanceAgentSprites` / the render snapshot are already gated on sprites.
    // Under a WASM agent target these are VIEWS over the shared agent memory (see
    // the sprite block in computeAgentMemoryLayout), so the WASM `setAgentSprite`
    // emit and the JS engine advance write the SAME bytes — which is what lets a
    // sprite-driving BEHAVIOUR graph run on WASM instead of clamping to JS.
    spriteIds: spriteI32(),
    spriteFrames: spriteF64('spriteFramesOffset'),
    spriteSpeeds: spriteF64('spriteSpeedsOffset'),
    spriteRotations: spriteF64('spriteRotationsOffset'),
    spriteScales: spriteF64('spriteScalesOffset'),
    attrSpecs,
    attrRead, attrWrite, attrKind,
    highWater: 0,
    liveCount: 0,
    freeList: freeListArr(),
    freeTop: 0,
    dt: cbNum(config, 'timeStep'),
    wasmBacked,
    memory,
    layout,
    syncAttrs,
    fieldGates,
  };
}

/** Sync update mode — copy `attrRead → attrWrite` for every user attribute, so the
 *  write buffer starts as a clone of the read buffer and attributes the behaviour
 *  doesn't touch carry over. Call BEFORE the behaviour. No-op when the store isn't
 *  double-buffered (async / wasmBacked). */
export function primeAgentAttrWrite(store: AgentStore): void {
  if (!store.syncAttrs) return;
  for (const spec of store.attrSpecs) {
    const r = store.attrRead[spec.id]!, w = store.attrWrite[spec.id]!;
    (w as unknown as { set(a: ArrayLike<number>): void }).set(r as unknown as ArrayLike<number>);
  }
}

/** Sync update mode — make the values the behaviour just wrote (`attrWrite`) the
 *  live (read) buffer for the structural phase, the render snapshot, and the next
 *  step. Call AFTER the behaviour. No-op when not double-buffered.
 *
 *  Plain JS arrays: a reference swap. **wasmBacked (B10/AW-SWAP discipline):** the
 *  attr arrays are VIEWS at the FIXED `attrOffset`/`attrWriteOffset`, and the WASM
 *  module always reads `attrOffset` (attrRead) + writes `attrWriteOffset` next step
 *  — a reference swap would orphan those baked offsets. So we COPY-INTO
 *  `attrRead ← attrWrite` (attrRead is the canonical read region the WASM reads), so
 *  the next step's WASM read sees the just-written values. Then `primeAgentAttrWrite`
 *  re-clones attrRead→attrWrite at the top of the next step. */
export function swapAgentAttrs(store: AgentStore): void {
  if (!store.syncAttrs) return;
  if (store.wasmBacked) {
    for (const spec of store.attrSpecs) {
      const r = store.attrRead[spec.id]!, w = store.attrWrite[spec.id]!;
      (r as unknown as { set(a: ArrayLike<number>): void }).set(w as unknown as ArrayLike<number>);
    }
    return;
  }
  for (const spec of store.attrSpecs) {
    const r = store.attrRead[spec.id]!;
    store.attrRead[spec.id] = store.attrWrite[spec.id]!;
    store.attrWrite[spec.id] = r;
  }
}

/** The neutral colour a freshly-seeded agent gets before any colour pass runs
 *  (a Behaviour-Step Set Cell Looks, or an Agent Output Mapping). GenesisCA has
 *  no built-in agent "type", so there is no per-type palette — every agent
 *  starts the same recognisable cyan and the model colours it however it likes. */
export const DEFAULT_AGENT_COLOR: readonly [number, number, number] = [76, 201, 240];

/** Allocate one agent slot. Free-list first (recycle), else grow highWater.
 *  Returns the new slot id, or -1 when the maxAgents ceiling is hit (the caller
 *  must REJECT + surface — never wrap). Does NOT set position/attrs; the caller
 *  initialises the slot. */
export function allocAgentSlot(store: AgentStore): number {
  let id: number;
  if (store.freeTop > 0) {
    id = store.freeList[--store.freeTop]!;
  } else if (store.highWater < store.maxAgents) {
    id = store.highWater++;
  } else {
    return -1; // ceiling — reject
  }
  store.alive[id] = 1;
  store.liveCount++;
  return id;
}

/** Reset a freshly-allocated slot's engine state to safe defaults + the agent
 *  attribute defaults. Bonds are cleared (their epoch bumped is the caller's
 *  job via freeAgentSlot on death). */
export function initAgentSlot(
  store: AgentStore, id: number,
  x: number, y: number, z: number, radius: number, lineage: number,
): void {
  store.x[id] = x; store.y[id] = y; store.z[id] = z;
  store.xNext[id] = x; store.yNext[id] = y; store.zNext[id] = z;
  store.vx[id] = 0; store.vy[id] = 0; store.vz[id] = 0;
  // Zero the WHOLE force accumulator, not just Z: the per-step reset only fills
  // 0..highWater at the TOP of a step, so a slot (re)allocated MID-step (a
  // division daughter, a behaviour spawn) must not carry a stale force into any
  // path that reads it before the next reset (defensive slot hygiene).
  store.forceX[id] = 0; store.forceY[id] = 0; store.forceZ[id] = 0;
  store.radius[id] = radius; store.targetRadius[id] = radius;
  store.age[id] = 0;
  store.lineage[id] = lineage;
  store.bondCount[id] = 0;
  store.density[id] = 0;
  store.divideRequest[id] = 0; store.killRequest[id] = 0;
  // Stale-request hygiene on recycled slots: the request PAYLOADS (division axis
  // / asymmetry, bond form params) are only meaningful with their flag set, but
  // clearing them keeps a recycled slot from ever pairing a fresh flag with a
  // previous occupant's payload.
  store.divideAxisX[id] = 0; store.divideAxisY[id] = 0; store.divideAxisZ[id] = 0;
  store.divideAsym[id] = 0;
  // P4 — clear the agent's WHOLE request queue (D entries + the overflow bucket),
  // not just entry 0: a recycled slot must never inherit a previous occupant's
  // queued ops. Bond-attribute Form-Bond initial values ride the same entries.
  clearAgentBondRequests(store, id);
  for (const spec of store.attrSpecs) {
    store.attrRead[spec.id]![id] = spec.defaultValue;
    store.attrWrite[spec.id]![id] = spec.defaultValue;
  }
  const [r, g, b] = DEFAULT_AGENT_COLOR;
  const c = id * 4;
  store.colors[c] = r; store.colors[c + 1] = g; store.colors[c + 2] = b; store.colors[c + 3] = 255;
  // Reset persistent sprite state so a recycled slot doesn't inherit a stale
  // sprite / frame / speed (Set Agent Sprite re-sets it from the agent's logic).
  store.spriteIds[id] = 0; store.spriteFrames[id] = 0; store.spriteSpeeds[id] = 0;
  store.spriteRotations[id] = 0; store.spriteScales[id] = 0;
}

/** Free an agent slot: mark dead, bump its epoch (so any stale bond pointing at
 *  it reads epoch-mismatch and is swept — the dangling-bond ABI), clear its own
 *  bond list, and push the slot onto the free-list for recycling. Breaking the
 *  PARTNERS' bonds to this agent is the structural phase's job (PR-C); the epoch
 *  bump is the cheap defence that makes a recycled slot never silently re-point
 *  a partner's spring at a stranger. */
export function freeAgentSlot(store: AgentStore, id: number): void {
  if (!store.alive[id]) return;
  // Break ALL bonds to/from this agent FIRST (removes it from every partner's
  // list) — must run while still marked alive so the partner lookup works.
  breakAllBonds(store, id);
  store.alive[id] = 0;
  store.epoch[id] = (store.epoch[id]! + 1) | 0;   // bump epoch → any stale bond is swept
  store.bondCount[id] = 0;
  store.divideRequest[id] = 0; store.killRequest[id] = 0;
  clearAgentBondRequests(store, id);
  store.freeList[store.freeTop++] = id;
  store.liveCount--;
}

/** P4 — clear ONE agent's whole structural-request queue (all `bondReqSlots`
 *  entries: the D queue entries plus the overflow bucket). The ONLY place a queue
 *  entry is zeroed wholesale, so a new lane added to an entry goes here and
 *  nowhere else (the `bondSlotArrays` compaction-list discipline applied to the
 *  request side). Zeroing the two TARGET lanes is what marks an entry empty; L/K
 *  and the per-attribute initial values are reset too so a recycled slot can never
 *  pair a fresh target with a previous occupant's payload. */
export function clearAgentBondRequests(store: AgentStore, id: number): void {
  const slots = store.bondReqSlots;
  const base = id * slots;
  for (let c = 0; c < slots; c++) {
    store.bondFormReq[base + c] = 0; store.bondBreakReq[base + c] = 0;
    store.bondFormL[base + c] = 0; store.bondFormK[base + c] = 0;
  }
  for (const spec of store.bondAttrSpecs) {
    const req = store.bondFormAttrs[spec.id]!;
    for (let c = 0; c < slots; c++) req[base + c] = spec.defaultValue;
  }
}

/** Generic Agent Platform: free a STAGED slot — a Create Agent that was never
 *  Added To World (alive=0, no bonds, liveCount NOT counted). `freeAgentSlot`
 *  early-returns on dead slots, so the Init Event's leak sweep uses this instead:
 *  bump the epoch (defensive) + push the slot back onto the free-list. */
export function freeStagedSlot(store: AgentStore, id: number): void {
  if (id < 0 || id >= store.maxAgents || store.alive[id]) return;
  store.epoch[id] = (store.epoch[id]! + 1) | 0;
  if (store.freeTop < store.maxAgents) store.freeList[store.freeTop++] = id;
}

/** Seed N agents. Each spec gives a position (+ optional radius/lineage);
 *  attributes initialise to their defaults. Returns the ids actually created
 *  (short of `specs.length` if the ceiling is hit — the worker surfaces that). */
export interface AgentSeedSpec { x: number; y: number; z?: number; radius?: number; lineage?: number }
export function seedAgents(store: AgentStore, specs: AgentSeedSpec[], defaultRadius: number): number[] {
  const ids: number[] = [];
  for (const s of specs) {
    const id = allocAgentSlot(store);
    if (id < 0) break; // ceiling
    initAgentSlot(store, id, s.x, s.y, s.z ?? 0, s.radius ?? defaultRadius, s.lineage ?? id);
    ids.push(id);
  }
  return ids;
}

/** Clear ALL agents (Reset). Keeps the allocation; zeroes the live region. */
export function clearAgents(store: AgentStore): void {
  store.alive.fill(0, 0, store.highWater);
  store.bondCount.fill(0, 0, store.highWater);
  store.bondPartner.fill(-1);
  store.highWater = 0;
  store.liveCount = 0;
  store.freeTop = 0;
}

// ---------------------------------------------------------------------------
// Render snapshot — copies of the live region for the `stepped` message. The
// renderer iterates 0..highWater and skips !alive. Copies (not transfers of the
// live arrays) so the engine keeps owning its SoA.
// ---------------------------------------------------------------------------

/** The render snapshot is FLOAT32 (P2 slim): every consumer (the 2D canvas
 *  overlay, the gl3d instance packer — itself f32 — the metaball bake, picking)
 *  is render-precision work, and f32 halves the per-frame slice + ship cost.
 *  The SIMULATION state stays f64 in the store; only this per-frame copy narrows. */
export interface AgentRenderSnapshot {
  highWater: number;
  liveCount: number;
  x: Float32Array;
  y: Float32Array;
  /** z (3D agents). Sliced only in 3D (`worldDepth > 1`); in 2D it's a length-0
   *  placeholder so the renderer draws at z=0 with no per-step alloc/transfer
   *  regression (A1). */
  z: Float32Array;
  /** Velocity — consumed ONLY by the sprite orientToVelocity heading (2D overlay
   *  + 3D billboards), so it ships ONLY when the model has sprites (the z/vz "A1"
   *  gate pattern); length-0 otherwise. Diagnostics that need velocities read the
   *  store via getState. */
  vx: Float32Array;
  vy: Float32Array;
  /** z velocity (3D + sprites; length-0 placeholder otherwise — see `vx`). */
  vz: Float32Array;
  radius: Float32Array;
  alive: Uint8Array;
  colors: Uint8ClampedArray;
  /** Flat [a, b, a, b, …] live bond index pairs (empty when no bonds). */
  bonds: Int32Array;
  /** Per-agent sprite slot (0 = none) + current frame (fractional; the render
   *  floors + wraps/clamps it by the sprite's loop flag). Sliced only when the
   *  model has sprites (`includeSprites`); else length-0 placeholders so non-sprite
   *  agent models pay no extra per-step alloc/transfer (the z/vz "A1" gate
   *  pattern). The speed stays worker-side (only the resolved frame renders). */
  spriteIds: Int32Array;
  spriteFrames: Float32Array;
  /** Per-agent sprite facing angle (compass degrees) + size override (0 = use the
   *  sprite's default scale). Shipped alongside spriteIds when the model has
   *  sprites; length-0 otherwise. */
  spriteRotations: Float32Array;
  spriteScales: Float32Array;
}

// ---------------------------------------------------------------------------
// Bonds — the persistent ragged store mutation API. Bonds are SYMMETRIC (both
// agents carry a slot), so form/break touch both lists. The partnerEpoch is
// stamped from the partner's current epoch at form time → a recycled slot (its
// epoch bumped on death) reads epoch-mismatch in the force loop + the stale
// sweep and is skipped (the dangling-bond ABI). maxBonds overflow REJECTS (the
// bond is simply not formed) — never wraps.
// ---------------------------------------------------------------------------

/** Is there a LIVE bond between a and b in a's list? */
export function hasBond(store: AgentStore, a: number, b: number): boolean {
  const base = a * store.maxBonds;
  const n = store.bondCount[a]!;
  for (let k = 0; k < n; k++) if (store.bondPartner[base + k] === b) return true;
  return false;
}

/** The ABSOLUTE ragged-store slot index (`a*maxBonds + k`) of a's bond to b, or
 *  -1. Epoch-checked like `getAgentState`'s bond listing, so a slot pointing at
 *  a RECYCLED id (the dangling-bond ABI) reads as absent rather than as a bond
 *  to whoever now occupies that slot.
 *
 *  Exported for the simulator's bond inspector (read + edit one edge). Nothing
 *  on a compile path uses it — the emitters address slots directly. */
export function bondSlotIndex(store: AgentStore, a: number, b: number): number {
  if (a < 0 || b < 0 || a >= store.highWater || b >= store.highWater) return -1;
  if (!store.alive[a] || !store.alive[b]) return -1;
  const base = a * store.maxBonds;
  const n = store.bondCount[a]!;
  for (let k = 0; k < n; k++) {
    if (store.bondPartner[base + k] === b && store.epoch[b] === store.bondPartnerEpoch[base + k]) return base + k;
  }
  return -1;
}

/** Write bond fields onto the symmetric bond a↔b — **BOTH slots**.
 *
 *  D2 / invariant **I2**: a bond is ONE object stored TWICE, and every per-slot
 *  field must agree in both rows (`verify-graph-rewrite.mjs` Tier D asserts it
 *  across the whole store). So this mirrors `formBond`'s two-sided stamping and
 *  the Set Bond Attribute node's two-sided write — never write one row.
 *
 *  `attrs` is keyed by bond-attribute id; unknown ids and absent fields are
 *  ignored. Returns false (and writes NOTHING) when the bond does not exist. */
export function setBondFields(
  store: AgentStore, a: number, b: number,
  patch: { restLength?: number; stiffness?: number; typeLabel?: number; attrs?: Record<string, number> },
): boolean {
  const sa = bondSlotIndex(store, a, b);
  const sb = bondSlotIndex(store, b, a);
  if (sa < 0 || sb < 0) return false;
  if (patch.restLength !== undefined && Number.isFinite(patch.restLength)) {
    store.bondRestLength[sa] = patch.restLength; store.bondRestLength[sb] = patch.restLength;
  }
  if (patch.stiffness !== undefined && Number.isFinite(patch.stiffness)) {
    store.bondStiffness[sa] = patch.stiffness; store.bondStiffness[sb] = patch.stiffness;
  }
  if (patch.typeLabel !== undefined && Number.isFinite(patch.typeLabel)) {
    store.bondTypeLabel[sa] = patch.typeLabel; store.bondTypeLabel[sb] = patch.typeLabel;
  }
  if (patch.attrs) {
    for (const spec of store.bondAttrSpecs) {
      const v = patch.attrs[spec.id];
      if (v === undefined || !Number.isFinite(v)) continue;
      // `as Uint8Array` is the store-wide index-compatible cast across the
      // Int32Array | Float64Array union (see moveBondSlot).
      const arr = store.bondAttrs[spec.id]! as Uint8Array;
      arr[sa] = v; arr[sb] = v;
    }
  }
  return true;
}

/** Move the CONTENTS of bond slot `src` into slot `dst`, across EVERY ragged bond
 *  field (the five built-ins + every user bond attribute).
 *
 *  THE COMPACTION LOCKSTEP RULE: this is the ONLY place a bond slot's contents
 *  move. Both swap-with-last compaction paths (`removeBondSlot` — used by Break
 *  Bond AND death — and `sweepStaleBonds`) call it, so a bond field added to
 *  `bondSlotArrays` cannot be missed by one of them. A missed field does not
 *  crash: it silently associates a value with the WRONG partner on the first bond
 *  removal, which is exactly what invariant I2 + the compaction audit in
 *  `scripts/verify-graph-rewrite.mjs` exist to catch. */
function moveBondSlot(store: AgentStore, dst: number, src: number): void {
  const arrays = store.bondSlotArrays;
  for (let f = 0; f < arrays.length; f++) {
    const a = arrays[f]! as Uint8Array;   // index-compatible across the union
    a[dst] = a[src]!;
  }
}

/** Add a bond slot to agent `a`'s list pointing at `b`. Internal (one direction).
 *  `attrValues` (P2) carries the bond attributes' initial values in
 *  `store.bondAttrSpecs` order; absent/short ⇒ each attribute's default. */
function addBondSlot(
  store: AgentStore, a: number, b: number, L: number, lambda: number, typeLabel: number,
  attrValues?: ArrayLike<number> | null,
): boolean {
  const n = store.bondCount[a]!;
  if (n >= store.maxBonds) return false; // overflow → reject
  const base = a * store.maxBonds + n;
  store.bondPartner[base] = b;
  store.bondPartnerEpoch[base] = store.epoch[b]!;
  store.bondRestLength[base] = L;
  store.bondStiffness[base] = lambda;
  store.bondTypeLabel[base] = typeLabel;
  const specs = store.bondAttrSpecs;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const v = attrValues && i < attrValues.length && Number.isFinite(attrValues[i]!) ? attrValues[i]! : spec.defaultValue;
    (store.bondAttrs[spec.id]! as Uint8Array)[base] = v;
  }
  store.bondCount[a] = n + 1;
  return true;
}

/** Form a symmetric bond a↔b. No-op (returns false) if already bonded, self, a
 *  dead agent, or EITHER list is full (atomic — neither side is half-added).
 *  `attrValues` writes the SAME initial bond-attribute values into BOTH slots, so
 *  invariant I2 (bond symmetry) holds by construction. */
export function formBond(
  store: AgentStore, a: number, b: number, L: number, lambda: number, typeLabel = 0,
  attrValues?: ArrayLike<number> | null,
): boolean {
  if (a === b || a < 0 || b < 0 || !store.alive[a] || !store.alive[b]) return false;
  if (hasBond(store, a, b)) return false;
  if (store.bondCount[a]! >= store.maxBonds || store.bondCount[b]! >= store.maxBonds) return false;
  addBondSlot(store, a, b, L, lambda, typeLabel, attrValues);
  addBondSlot(store, b, a, L, lambda, typeLabel, attrValues);
  return true;
}

/** Remove the bond slot pointing at `b` from `a`'s list (swap-remove). Internal. */
function removeBondSlot(store: AgentStore, a: number, b: number): boolean {
  const base = a * store.maxBonds;
  const n = store.bondCount[a]!;
  for (let k = 0; k < n; k++) {
    if (store.bondPartner[base + k] === b) {
      const last = n - 1;
      if (k !== last) moveBondSlot(store, base + k, base + last);
      store.bondPartner[base + last] = -1;
      store.bondCount[a] = last;
      return true;
    }
  }
  return false;
}

/** Break the symmetric bond a↔b (both directions). */
export function breakBond(store: AgentStore, a: number, b: number): boolean {
  if (a < 0 || b < 0) return false;
  const r1 = removeBondSlot(store, a, b);
  const r2 = removeBondSlot(store, b, a);
  return r1 || r2;
}

/** Break the bond between two agents NEITHER of which need be the requester — the
 *  third-party break a Break Bond with its `agentA` port WIRED asks for.
 *
 *  It is `breakBond` behind a whole-op PRE-CHECK, and the pre-check is the point
 *  (invariant **I5**): `a` and `b` must be live, in range and distinct, and the
 *  edge must actually EXIST. A "break" that breaks nothing must touch NOTHING —
 *  no slot may move, no degree may change — so a rejected entry leaves the graph
 *  EXACTLY as it was. (`breakBond` already no-ops on a missing edge, since
 *  `removeBondSlot` finds no slot; the range/liveness tests are not redundant
 *  though — an out-of-range id would index past the typed arrays.)
 *
 *  Symmetric by construction: `breakBond` removes BOTH rows' slots (I2) and each
 *  removal compacts its own row, so nothing is left dangling (I3).
 *
 *  Returns true when the bond was removed. */
export function breakBondBetween(store: AgentStore, a: number, b: number): boolean {
  const s = store, hw = s.highWater;
  if (a < 0 || a >= hw || !s.alive[a]) return false;
  if (b < 0 || b >= hw || !s.alive[b]) return false;
  if (a === b) return false;
  if (!hasBond(s, a, b)) return false;
  return breakBond(s, a, b);
}

/** P4 — REWIRE, the atomic graph-rewriting verb: move agent `a`'s edge from `from`
 *  to `to` as ONE operation (`break(a,from)` + `form(a,to)`), so the intermediate
 *  half-rewired state never exists.
 *
 *  ATOMICITY (invariant **I5**) is the whole point: the op is fully PRE-CHECKED
 *  and, if anything would reject, **nothing at all is applied** — never a break
 *  without its form. That is what makes a degree-preserving rule (triangle split,
 *  edge swap, pair annihilation) express its invariant at EVERY generation instead
 *  of only between them, which in turn is what makes invariant I6 testable.
 *
 *  Pre-conditions, all necessary:
 *   • `a↔from` must actually exist (otherwise the "rewire" would be a bare form,
 *     silently RAISING a's degree — the exact thing a degree-preserving rule
 *     forbids);
 *   • `to` must be a live agent other than `a`;
 *   • `to` must have room, unless `a↔to` already exists (then the form half is a
 *     no-op and only the break applies — a legitimate "collapse a double edge").
 *  `a`'s own capacity needs no check: the break frees one of its slots first.
 *  `to === from` is allowed and re-forms the same edge with the new L/λ/attributes.
 *
 *  Returns true when the rewire was applied. */
export function rewireBond(
  store: AgentStore, a: number, from: number, to: number, L: number, lambda: number,
  typeLabel = 0, attrValues?: ArrayLike<number> | null,
): boolean {
  const hw = store.highWater;
  if (a < 0 || a >= hw || !store.alive[a]) return false;
  if (from < 0 || from >= hw) return false;
  if (to < 0 || to >= hw || to === a || !store.alive[to]) return false;
  if (!hasBond(store, a, from)) return false;
  const reForming = to === from || hasBond(store, a, to);
  if (!reForming && store.bondCount[to]! >= store.maxBonds) return false;
  breakBond(store, a, from);
  formBond(store, a, to, L, lambda, typeLabel, attrValues);
  return true;
}

/** TRANSFER — hand agent `me`'s edge with `b` over to `to`, rewriting `b`'s slot
 *  **IN PLACE** so `b`'s adjacency ORDER is preserved. The third-party sibling of
 *  `rewireBond`, and the reason it exists:
 *
 *  `rewireBond(me, b → to)` is break+form AT `me`, and the engine's `breakBond`
 *  compacts by swapping the LAST slot into the freed one while `formBond`
 *  APPENDS. So a rewire SCRAMBLES THE THIRD PARTY'S SLOT ORDER (and attaches the
 *  new partner to the REQUESTER, not to `b`). znah's `reconnect` is
 *  `node[node.indexOf(i)] = j` — a single in-place overwrite. Slot order is not
 *  cosmetic for a graph automaton: a cubic split keeps slot 0 and hands slots 1
 *  and 2 to its daughters, so a scrambled receiver propagates into every later
 *  split and into the embedding forever.
 *
 *  **THE BOND KEEPS ITS VALUES.** It is the SAME edge re-pointed, so the rewritten
 *  slot at `b` retains its rest length, stiffness, type label and every bond
 *  attribute, and the slot appended at `to` is stamped with those SAME values —
 *  which is what makes invariant **I2** (both sides of a bond agree on every
 *  per-slot field) hold by construction. Per-edge state therefore travels with
 *  the edge, which is the semantically useful behaviour for a rewriting rule.
 *  (The node consequently has no rest-length / stiffness / bond-attribute ports:
 *  there is nothing for the caller to supply.)
 *
 *  ATOMICITY (invariant **I5**) — fully pre-checked, so a rejection leaves the
 *  graph EXACTLY as it was:
 *   • `me`, `b`, `to` all live and in range, and pairwise distinct;
 *   • **`b↔me` must EXIST** (else this would be a bare form at `to`, silently
 *     RAISING a degree — what a degree-preserving rule forbids);
 *   • **`b↔to` must NOT already exist** — the in-place rewrite would give `b` two
 *     slots pointing at `to`, a DOUBLE EDGE that I1/I2 would then report as
 *     corruption (and which no compaction path can undo);
 *   • `to` must have room. `me` needs no capacity check — it only loses.
 *
 *  **I3**: `b`'s slot is OVERWRITTEN, never blanked, so it is never transiently
 *  dangling. Degrees: `b` unchanged, `me` −1, `to` +1.
 *
 *  Returns true when the transfer was applied. */
export function transferBond(store: AgentStore, me: number, b: number, to: number): boolean {
  const s = store, hw = s.highWater, mb = s.maxBonds;
  if (me < 0 || me >= hw || !s.alive[me]) return false;
  if (b < 0 || b >= hw || !s.alive[b]) return false;
  if (to < 0 || to >= hw || !s.alive[to]) return false;
  if (b === me || b === to || to === me) return false;
  // Locate the slot at `b` holding `me` — the position the whole verb exists to
  // preserve — while checking the same row for `to` (the double-edge gate).
  const bBase = b * mb, bn = s.bondCount[b]!;
  let p = -1;
  for (let k = 0; k < bn; k++) {
    const q = s.bondPartner[bBase + k]!;
    if (q === me) p = bBase + k;
    else if (q === to) return false;   // b↔to already exists ⇒ would DOUBLE-EDGE
  }
  if (p < 0) return false;             // b↔me does not exist ⇒ would be a bare form
  if (s.bondCount[to]! >= mb) return false;
  // ---- past every gate: apply. Read the edge's values off b's slot FIRST, so
  // the appended slot at `to` is stamped identically (I2).
  const L = s.bondRestLength[p]!, K = s.bondStiffness[p]!, label = s.bondTypeLabel[p]!;
  const specs = s.bondAttrSpecs;
  const vals = specs.length > 0 ? new Float64Array(specs.length) : null;
  if (vals) for (let i = 0; i < specs.length; i++) vals[i] = (s.bondAttrs[specs[i]!.id]! as Uint8Array)[p]!;
  // 1. b's slot, IN PLACE — only the partner identity changes.
  s.bondPartner[p] = to;
  s.bondPartnerEpoch[p] = s.epoch[to]!;
  // 2. `me` loses its side through ordinary compaction (it is the requester,
  //    whose own order the verb makes no promise about).
  removeBondSlot(s, me, b);
  // 3. `to` appends the mirror slot with the SAME per-slot values (I2).
  addBondSlot(s, to, b, L, K, label, vals);
  return true;
}

/** P4 — DRAIN one step's STRUCTURAL REQUEST QUEUE: apply every agent's queued bond
 *  Form / Break / Rewire entries, IN SLOT ORDER (= the order the rule issued them),
 *  and clear the queue. Returns true when at least one agent overflowed (the caller
 *  surfaces the notice).
 *
 *  THIS IS THE ONE PLACE queue entries are consumed. It lives in the engine (not in
 *  the worker's structural phase) so the invariant harness exercises the SHIPPED
 *  code rather than a copy of it — a drain the tests re-implement proves nothing.
 *
 *  Entry encoding + the overflow bucket:
 *  [bondRequestQueue.ts](../../modeler/vpl/compiler/bondRequestQueue.ts). Each entry
 *  carries BOTH a break side and a form side, so one entry expresses every verb
 *  and a REWIRE is applied atomically by `rewireBond` (pre-check, then break + form,
 *  or nothing at all — invariant **I5**). `bondReqSlots === 1` (a model whose agent
 *  graph uses no queue verb) reduces this to the pre-P4 single-request drain.
 *
 *  P4b: a NEGATIVE break lane marks a **FORM BETWEEN** — bond two OTHER agents,
 *  the one edge a self-relative verb cannot create (the triangle split's `v₂–v₃`
 *  joins two newborns, neither of which is `self`). It rides the REQUESTING agent's
 *  own queue, so no thread ever writes another thread's rows and the WebGPU emit
 *  still needs no atomics.
 *
 *  B9: a NEGATIVE FORM lane marks a **TRANSFER** — hand this agent's edge with the
 *  named third party over to a new partner, rewriting the third party's slot IN
 *  PLACE (see `transferBond`). Decoded immediately after the Form Between branch;
 *  falling through would turn it into a bare Break.
 *
 *  BOTH lanes negative marks a **BREAK BETWEEN** — sever the bond between two
 *  agents the requester need not be part of (see `breakBondBetween`). Decoded
 *  FIRST, ahead of both single-sign tests: `bl < 0` alone is Form Between's
 *  marker, so falling through drops the entry and the bond silently survives.
 *
 *  P2: a form half's INITIAL bond-attribute values ride the per-entry
 *  `bondFormAttrs[<id>][base + c]` cells; `formBond` / `rewireBond` stamp the SAME
 *  values into BOTH slots (invariant **I2**). */
export function drainAgentBondRequests(store: AgentStore, lambda: number): boolean {
  const s = store;
  const hw = s.highWater, rad = s.radius, alive = s.alive;
  // Reused scratch (the spec list is fixed for the store's lifetime); no bond
  // attributes ⇒ null ⇒ formBond falls back to each attribute's default.
  const bondFormVals = s.bondAttrSpecs.length > 0 ? new Float64Array(s.bondAttrSpecs.length) : null;
  const reqSlots = s.bondReqSlots, reqDepth = reqSlots - 1;
  let overflow = false;
  for (let i = 0; i < hw; i++) {
    const base = i * reqSlots;
    if (!alive[i]) {
      // A dead agent's queue is dropped wholesale (its entries can only be stale).
      if (s.bondFormReq[base] !== 0 || s.bondBreakReq[base] !== 0) clearAgentBondRequests(s, i);
      continue;
    }
    let c = 0;
    for (; c < reqDepth; c++) {
      const bl = s.bondBreakReq[base + c]!, fl = s.bondFormReq[base + c]!;
      // The contiguous-prefix terminator: EVERY emitted op writes a non-zero value
      // into both lanes (the unused side writes BOND_REQ_NONE), so 0/0 means no op
      // was ever appended here — and therefore none is appended after it either.
      if (bl === 0 && fl === 0) break;
      s.bondBreakReq[base + c] = 0; s.bondFormReq[base + c] = 0;
      // BREAK BETWEEN — BOTH lanes negative, the one sign combination the other
      // two-id verbs left free. It MUST be decoded FIRST, ahead of both
      // single-sign tests: `bl < 0` alone is Form Between's marker, so falling
      // through would decode `b` from a NEGATIVE form lane, get −1, fail that
      // arm's `b >= 0` gate and DROP the entry — the bond silently survives, with
      // no error anywhere. `breakBondBetween` is the whole-op gate (dead / out of
      // range / self-aliased / no such edge ⇒ nothing touched — invariant I5).
      if (bl < 0 && fl < 0) {
        const a = -bl >= BOND_REQ_ID_BIAS ? -bl - BOND_REQ_ID_BIAS : -1;
        const b = -fl >= BOND_REQ_ID_BIAS ? -fl - BOND_REQ_ID_BIAS : -1;
        if (a >= 0 && b >= 0) breakBondBetween(s, a, b);
        continue;
      }
      // P4b — a NEGATIVE break lane is the FORM BETWEEN op kind (the only marker
      // distinguishing it from a Rewire, which also fills both lanes). Decoded
      // FIRST: without this branch the entry would fall through and be applied as
      // a plain self→B form, silently bonding the wrong pair.
      if (bl < 0) {
        const a = -bl >= BOND_REQ_ID_BIAS ? -bl - BOND_REQ_ID_BIAS : -1;
        const b = fl >= BOND_REQ_ID_BIAS ? fl - BOND_REQ_ID_BIAS : -1;
        if (a >= 0 && a < hw && b >= 0 && b < hw && alive[a] && alive[b]) {
          const L = s.bondFormL[base + c]! > 0 ? s.bondFormL[base + c]! : (rad[a]! + rad[b]!);
          const K = s.bondFormK[base + c]! > 0 ? s.bondFormK[base + c]! : lambda;
          if (bondFormVals) {
            for (let ai = 0; ai < s.bondAttrSpecs.length; ai++) {
              bondFormVals[ai] = s.bondFormAttrs[s.bondAttrSpecs[ai]!.id]![base + c]!;
            }
          }
          // `formBond` is the whole-op gate (self / dead / already-bonded / EITHER
          // list full ⇒ nothing added on either side) — invariant I5 for free.
          formBond(s, a, b, L, K, 0, bondFormVals);
        }
        continue;
      }
      // B9 — TRANSFER, the mirror-image marker: a NEGATIVE FORM lane. It MUST be
      // decoded here, immediately after the Form Between branch: fall through and
      // `to` decodes to −1, the entry lands in the plain-BREAK arm below with
      // `from = b`, and the transfer silently degrades to a bare Break (an edge
      // vanishes, no error anywhere). `transferBond` is the whole-op gate.
      if (fl < 0) {
        const tb = bl >= BOND_REQ_ID_BIAS ? bl - BOND_REQ_ID_BIAS : -1;
        const tto = -fl >= BOND_REQ_ID_BIAS ? -fl - BOND_REQ_ID_BIAS : -1;
        if (tb >= 0 && tto >= 0) transferBond(s, i, tb, tto);
        continue;
      }
      const from = bl >= BOND_REQ_ID_BIAS ? bl - BOND_REQ_ID_BIAS : -1;
      const to = fl >= BOND_REQ_ID_BIAS ? fl - BOND_REQ_ID_BIAS : -1;
      if (to >= 0) {
        // A form half — resolve its parameters (0 ⇒ the engine defaults).
        const L = s.bondFormL[base + c]! > 0 ? s.bondFormL[base + c]!
          : (rad[i]! + (to < hw ? rad[to]! : rad[i]!));
        const K = s.bondFormK[base + c]! > 0 ? s.bondFormK[base + c]! : lambda;
        if (bondFormVals) {
          for (let ai = 0; ai < s.bondAttrSpecs.length; ai++) {
            bondFormVals[ai] = s.bondFormAttrs[s.bondAttrSpecs[ai]!.id]![base + c]!;
          }
        }
        if (from >= 0) rewireBond(s, i, from, to, L, K, 0, bondFormVals);   // ATOMIC
        else if (to < hw && alive[to]) formBond(s, i, to, L, K, 0, bondFormVals);
      } else if (from >= 0) {
        breakBond(s, i, from);
      }
    }
    // The OVERFLOW BUCKET (entry `reqDepth`) is only ever written once the queue
    // filled, so it can only be occupied when the prefix ran to the end.
    if (c === reqDepth && (s.bondBreakReq[base + reqDepth] !== 0 || s.bondFormReq[base + reqDepth] !== 0)) {
      overflow = true;
      s.bondBreakReq[base + reqDepth] = 0; s.bondFormReq[base + reqDepth] = 0;
    }
  }
  return overflow;
}

/** Break ALL bonds attached to agent `a` (both directions). Called on death so
 *  no partner keeps a slot pointing at a recycled agent. */
export function breakAllBonds(store: AgentStore, a: number): void {
  const base = a * store.maxBonds;
  const n = store.bondCount[a]!;
  for (let k = 0; k < n; k++) {
    const p = store.bondPartner[base + k]!;
    if (p >= 0) removeBondSlot(store, p, a);
    store.bondPartner[base + k] = -1;
  }
  store.bondCount[a] = 0;
}

/** Per-step stale-bond sweep — drop any slot whose partner is dead OR whose
 *  stamped epoch no longer matches the partner's (a recycled slot). Cheap
 *  defence-in-depth on top of break-on-death + the force-loop epoch check. */
export function sweepStaleBonds(store: AgentStore): void {
  const hw = store.highWater, mb = store.maxBonds;
  for (let a = 0; a < hw; a++) {
    if (!store.alive[a]) continue;
    const base = a * mb;
    let n = store.bondCount[a]!;
    for (let k = 0; k < n; ) {
      const p = store.bondPartner[base + k]!;
      const stale = p < 0 || p >= hw || !store.alive[p] || store.bondPartnerEpoch[base + k] !== store.epoch[p];
      if (stale) {
        const last = n - 1;
        // The THIRD compaction path (alongside Break Bond + death, which both go
        // through removeBondSlot) — it MUST use the same field-list-driven move.
        if (k !== last) moveBondSlot(store, base + k, base + last);
        store.bondPartner[base + last] = -1;
        n = last;
      } else { k++; }
    }
    store.bondCount[a] = n;
  }
}

/** Snapshot the live bonds as flat [a, b] index pairs (a < b, deduped) for the
 *  bond render layer. Cheap; only built when there are bonds. */
export function snapshotBonds(store: AgentStore): Int32Array {
  const hw = store.highWater, mb = store.maxBonds;
  const pairs: number[] = [];
  for (let a = 0; a < hw; a++) {
    if (!store.alive[a]) continue;
    const base = a * mb;
    const n = store.bondCount[a]!;
    for (let k = 0; k < n; k++) {
      const b = store.bondPartner[base + k]!;
      if (b > a && store.alive[b]) { pairs.push(a, b); } // a<b dedupes the symmetric pair
    }
  }
  return Int32Array.from(pairs);
}

// ---------------------------------------------------------------------------
// Division — the tension-axis cell split (the morphogenesis headline). The
// division axis is the net-stretch direction of the agent's bonds (a 2×2
// closed-form symmetric eigensolve), so a glued cluster elongates + divides
// along its MECHANICAL axis, and partner bonds are inherited by geometry (each
// goes to the nearer daughter). Engine-owned — the graph never sees the per-bond
// partition (the freedom/guardrail boundary). All overflow REJECTS the WHOLE
// division (never a half-rewired partner — the riskiest single bug).
// ---------------------------------------------------------------------------

/** Principal eigenvector (largest eigenvalue) of the symmetric 2×2 tensor
 *  [[a,b],[b,c]], as a unit vector. The `b≈0` diagonal case picks the dominant
 *  axis directly. */
function principalEig2x2(a: number, b: number, c: number): [number, number] {
  const lambda = (a + c) / 2 + Math.sqrt(((a - c) / 2) ** 2 + b * b);
  if (Math.abs(b) > 1e-9) {
    const vx = b, vy = lambda - a;
    const n = Math.hypot(vx, vy) || 1;
    return [vx / n, vy / n];
  }
  return a >= c ? [1, 0] : [0, 1];
}

// ---------------------------------------------------------------------------
// 3×3 symmetric eigensolve (B6, the 3D division headline) — a PARALLEL branch
// to principalEig2x2, NOT a reducing generalisation (a reducing solver risks
// float-drift in the 2D path, so the 2D code stays the verbatim 2×2). The
// method is the analytic Cardano/Smith trigonometric closed form: branchless-
// deterministic (no Jacobi sweep-count nondeterminism), O(1).
//
//   B6-FATAL: the `acos` argument `r` MUST be clamped to [-1,1] BEFORE the call
//   — float round-off pushes |r| slightly past 1 for a symmetric (e.g. a clean
//   z-axis-line) tensor, `acos(>1) = NaN`, and the daughter is placed at NaN
//   with no error. principalEig3x3 AND minorEig3x3 share the SAME clamp (they
//   route through `eigsSorted3x3`, the single sorted-eigenvalue helper), so the
//   sibling can't re-derive φ without it.
// ---------------------------------------------------------------------------

/** The three eigenvalues of the symmetric 3×3 `[[a,d,f],[d,b,e],[f,e,c]]`,
 *  sorted DESCENDING `[eMax, eMid, eMin]`. Smith's analytic trig form. Returns
 *  `null` for an (already-)diagonal tensor (the off-diagonal energy is below
 *  threshold) so the caller picks the dominant diagonal axis directly. */
function eigsSorted3x3(a: number, b: number, c: number, d: number, e: number, f: number): [number, number, number] | null {
  // p1 = sum of squared off-diagonals. Below threshold ⇒ the matrix is diagonal
  // (B3: loosened from 1e-18 to 1e-15 — engine-critique). The caller short-circuits.
  const p1 = d * d + e * e + f * f;
  if (p1 < 1e-15) return null;
  const q = (a + b + c) / 3;                       // mean eigenvalue = trace/3
  const p2 = (a - q) * (a - q) + (b - q) * (b - q) + (c - q) * (c - q) + 2 * p1;
  const p = Math.sqrt(p2 / 6) || 1e-12;
  // B = (1/p)·(M − q·I); r = det(B)/2.
  const ba = (a - q) / p, bb = (b - q) / p, bc = (c - q) / p;
  const bd = d / p, be = e / p, bf = f / p;
  const detB =
    ba * (bb * bc - be * be) -
    bd * (bd * bc - be * bf) +
    bf * (bd * be - bb * bf);
  let r = detB / 2;
  // B6-FATAL: clamp BEFORE acos — the #1 NaN source.
  if (r < -1) r = -1; else if (r > 1) r = 1;
  const phi = Math.acos(r) / 3;
  const eig1 = q + 2 * p * Math.cos(phi);                       // largest
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);   // smallest
  const eig2 = 3 * q - eig1 - eig3;                             // trace − the other two
  return [eig1, eig2, eig3];
}

/** Unit eigenvector of the symmetric 3×3 `[[a,d,f],[d,b,e],[f,e,c]]` for a given
 *  eigenvalue λ: the largest-norm cross-product of two rows of `(M − λ·I)` (any
 *  two rows span the eigenvector's orthogonal complement; their cross product is
 *  the eigenvector — pick the most numerically robust pair). Isotropic / repeated
 *  degenerate case (all three cross-products ≈ 0) ⇒ a deterministic axis. */
function eigvec3x3(a: number, b: number, c: number, d: number, e: number, f: number, lambda: number): [number, number, number] {
  // Rows of (M − λI):
  const r0x = a - lambda, r0y = d, r0z = f;
  const r1x = d, r1y = b - lambda, r1z = e;
  const r2x = f, r2y = e, r2z = c - lambda;
  // Three candidate cross-products (one per row pair); take the largest-norm.
  const cross = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] =>
    [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  const c01 = cross(r0x, r0y, r0z, r1x, r1y, r1z);
  const c02 = cross(r0x, r0y, r0z, r2x, r2y, r2z);
  const c12 = cross(r1x, r1y, r1z, r2x, r2y, r2z);
  const n01 = c01[0] * c01[0] + c01[1] * c01[1] + c01[2] * c01[2];
  const n02 = c02[0] * c02[0] + c02[1] * c02[1] + c02[2] * c02[2];
  const n12 = c12[0] * c12[0] + c12[1] * c12[1] + c12[2] * c12[2];
  let best = c01, bn = n01;
  if (n02 > bn) { best = c02; bn = n02; }
  if (n12 > bn) { best = c12; bn = n12; }
  if (bn < 1e-18) return [0, 0, 1]; // isotropic / repeated eigenvalue → deterministic axis
  const n = Math.sqrt(bn);
  return [best[0] / n, best[1] / n, best[2] / n];
}

/** Principal eigenvector (LARGEST eigenvalue) of the symmetric 3×3
 *  `[[a,d,f],[d,b,e],[f,e,c]]`, as a unit vector. Diagonal tensor ⇒ the dominant
 *  diagonal axis. Repeated-largest-eigenvalue degeneracy ⇒ an arbitrary-but-
 *  deterministic axis within the degenerate plane (eigvec3x3's cross-product
 *  fallback). */
function principalEig3x3(a: number, b: number, c: number, d: number, e: number, f: number): [number, number, number] {
  const eigs = eigsSorted3x3(a, b, c, d, e, f);
  if (!eigs) return a >= b && a >= c ? [1, 0, 0] : b >= c ? [0, 1, 0] : [0, 0, 1];
  return eigvec3x3(a, b, c, d, e, f, eigs[0]);
}

/** Minor eigenvector (SMALLEST eigenvalue) of the symmetric 3×3 — the sibling of
 *  principalEig3x3 for the degenerate "no tension" packing-gap fallback (divide
 *  into the lowest-density direction). Shares `eigsSorted3x3`'s `acos` clamp
 *  (B6-FATAL — a sibling that re-derived φ without the clamp would NaN
 *  independently). Diagonal tensor ⇒ the least-dominant diagonal axis. */
function minorEig3x3(a: number, b: number, c: number, d: number, e: number, f: number): [number, number, number] {
  const eigs = eigsSorted3x3(a, b, c, d, e, f);
  if (!eigs) return a <= b && a <= c ? [1, 0, 0] : b <= c ? [0, 1, 0] : [0, 0, 1];
  // F-1: repeated-smallest-eigenvalue degeneracy (eMid ≈ eMin) — e.g. a rank-1
  // packing tensor Σ r̂⊗r̂ from a single bond, where (M − eMin·I) is rank-deficient
  // and eigvec3x3's cross-product fallback can return its isotropic [0,0,1] default
  // (NOT actually in the degenerate eigenspace → a geometrically-wrong axis). The
  // minor eigenspace is the plane orthogonal to the (well-defined) principal axis,
  // so pick ANY unit vector orthogonal to principalEig3x3's result.
  const span = Math.abs(eigs[0]) + Math.abs(eigs[2]) || 1;
  if (Math.abs(eigs[1] - eigs[2]) < 1e-7 * span) {
    const [px, py, pz] = principalEig3x3(a, b, c, d, e, f);
    // Cross the principal axis with whichever world axis is least parallel to it
    // (largest cross-product norm) for a numerically robust orthogonal vector.
    const ax = Math.abs(px) <= Math.abs(py) && Math.abs(px) <= Math.abs(pz)
      ? [1, 0, 0]
      : Math.abs(py) <= Math.abs(pz) ? [0, 1, 0] : [0, 0, 1];
    const ox = py * ax[2]! - pz * ax[1]!;
    const oy = pz * ax[0]! - px * ax[2]!;
    const oz = px * ax[1]! - py * ax[0]!;
    const on = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
    return [ox / on, oy / on, oz / on];
  }
  return eigvec3x3(a, b, c, d, e, f, eigs[2]);
}

/** The tension-axis unit vector m̂ for a dividing agent: the principal
 *  eigenvector of `M = Σ_k max(0, λ_k(l_k − L_k))·(r̂_k ⊗ r̂_k)` over its bonds
 *  (stretched bonds only). Degenerate fallback (no tension): the MINOR
 *  eigenvector of the unweighted packing tensor `Σ r̂_k⊗r̂_k` (divide into the
 *  lowest-density gap); no bonds → a deterministic spread-out pseudo-axis. */
function tensionAxis(store: AgentStore, i: number, torus: boolean, W: number, H: number, D: number): [number, number, number] {
  const mb = store.maxBonds, base = i * mb, n = store.bondCount[i]!;
  const cx = store.x[i]!, cy = store.y[i]!;
  const halfW = W / 2, halfH = H / 2;
  if (D > 1) {
    // 3D: accumulate the 6-component symmetric tensor Σ w·(r̂⊗r̂) + the unweighted
    // packing tensor Σ r̂⊗r̂; pick the principal (tension) or minor (packing-gap)
    // eigenvector. The free-agent fallback is an INDEX-ONLY Fibonacci-sphere
    // direction (no highWater dependence — that would break replay).
    const cz = store.z[i]!, halfD = D / 2;
    // M = [[a,d,f],[d,b,e],[f,e,c]]; M2 = the unweighted sibling.
    let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, sumW = 0;
    let a2 = 0, b2 = 0, c2 = 0, d2 = 0, e2 = 0, f2 = 0;
    for (let k = 0; k < n; k++) {
      const p = store.bondPartner[base + k]!;
      if (p < 0 || !store.alive[p]) continue;
      let dx = store.x[p]! - cx, dy = store.y[p]! - cy, dz = store.z[p]! - cz;
      if (torus) {
        if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
        if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
        if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
      }
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-9) continue;
      const rx = dx / l, ry = dy / l, rz = dz / l;
      const w = Math.max(0, store.bondStiffness[base + k]! * (l - store.bondRestLength[base + k]!));
      a += w * rx * rx; b += w * ry * ry; c += w * rz * rz;
      d += w * rx * ry; e += w * ry * rz; f += w * rx * rz; sumW += w;
      a2 += rx * rx; b2 += ry * ry; c2 += rz * rz; d2 += rx * ry; e2 += ry * rz; f2 += rx * rz;
    }
    if (sumW > 1e-9) return principalEig3x3(a, b, c, d, e, f);
    if (a2 + b2 + c2 > 1e-9) return minorEig3x3(a2, b2, c2, d2, e2, f2); // divide into lowest-density gap
    // Free agent: a deterministic point on the unit sphere (golden-angle spiral),
    // indexed ONLY by the agent id i (replay-stable).
    const ga = 2.399963229728653; // golden angle
    const zz = 1 - (2 * (i + 0.5)) / Math.max(1, store.maxAgents); // ∈ (-1, 1)
    const rr = Math.sqrt(Math.max(0, 1 - zz * zz));
    const th = ga * i;
    return [Math.cos(th) * rr, Math.sin(th) * rr, zz];
  }
  // --- 2D: the EXACT current code, verbatim (the constant-0 z appended) ---
  let a = 0, b = 0, c = 0, sumW = 0;
  let a2 = 0, b2 = 0, c2 = 0;
  for (let k = 0; k < n; k++) {
    const p = store.bondPartner[base + k]!;
    if (p < 0 || !store.alive[p]) continue;
    let dx = store.x[p]! - cx, dy = store.y[p]! - cy;
    if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    const rx = dx / l, ry = dy / l;
    const w = Math.max(0, store.bondStiffness[base + k]! * (l - store.bondRestLength[base + k]!));
    a += w * rx * rx; b += w * rx * ry; c += w * ry * ry; sumW += w;
    a2 += rx * rx; b2 += rx * ry; c2 += ry * ry;
  }
  if (sumW > 1e-9) { const [mx, my] = principalEig2x2(a, b, c); return [mx, my, 0]; }
  if (a2 + c2 > 1e-9) { const [px, py] = principalEig2x2(a2, b2, c2); return [-py, px, 0]; } // minor = perpendicular
  const ang = i * 2.399963229728653; // golden angle — deterministic spread for free agents
  return [Math.cos(ang), Math.sin(ang), 0];
}

/** Divide agent `i` along its tension axis. Returns the new daughter's id, or a
 *  negative rejection code (-1 = maxAgents full, -2 = a daughter's bond list
 *  would overflow). On rejection the agent is UNCHANGED (no half-division). The
 *  mother slot becomes daughter A; a free-list slot becomes daughter B.
 *
 *  `partition` (P5) says HOW the mother's bonds are split — geometrically
 *  (`tension`, the default and byte-identical to the pre-P5 behaviour),
 *  `alternate` (A, B, A, B... in slot order), or `byBondAttribute` (a named P2
 *  bond attribute selects the daughter). It also carries decision D4, the
 *  daughter-daughter bond policy (`auto` = only when the mother was bonded).
 *  Omitting it reproduces the pre-P5 semantics exactly.
 *
 *  The DAUGHTER PLACEMENT is always along the resolved axis — the partition
 *  chooses which EDGES move, never where the daughters land.
 *
 *  Daughters inherit the mother's attributes verbatim (the divisionEvent graph
 *  can reassign them afterwards), and every inherited bond keeps its own bond
 *  attributes (oracle O9) — the partition only changes WHICH daughter holds it. */
export function divideAgent(
  store: AgentStore, i: number,
  axisX: number, axisY: number, axisZ: number, asym: number,
  defaultLambda: number, torus: boolean, W: number, H: number, D: number,
  outAxis?: number[],
  partition: DividePartitionSpec = DEFAULT_DIVIDE_PARTITION,
): number {
  if (!store.alive[i]) return -1;
  const is3d = D > 1;
  const mb = store.maxBonds;
  const cx = store.x[i]!, cy = store.y[i]!, cz = store.z[i]!;
  // Defensive: a non-finite mother position/radius would place BOTH daughters at
  // NaN (invisible spheres whose forces poison every neighbour they touch).
  // Reject the division instead of multiplying the corruption.
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || !Number.isFinite(store.radius[i]!)) return -1;
  const halfW = W / 2, halfH = H / 2, halfD = D / 2;

  // 1. axis — explicit override if wired (finite + non-zero), else the eigensolve
  let mx: number, my: number, mz: number;
  if (is3d) {
    if (Number.isFinite(axisX) && Number.isFinite(axisY) && Number.isFinite(axisZ) && (axisX !== 0 || axisY !== 0 || axisZ !== 0)) {
      const n = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ) || 1; mx = axisX / n; my = axisY / n; mz = axisZ / n;
    } else {
      [mx, my, mz] = tensionAxis(store, i, torus, W, H, D);
    }
  } else {
    mz = 0;
    if (Number.isFinite(axisX) && Number.isFinite(axisY) && (axisX !== 0 || axisY !== 0)) {
      const n = Math.hypot(axisX, axisY) || 1; mx = axisX / n; my = axisY / n;
    } else {
      [mx, my] = tensionAxis(store, i, torus, W, H, 1);
    }
  }
  if (outAxis) { outAxis[0] = mx; outAxis[1] = my; outAxis[2] = mz; }

  // 2. classify each mother bond by which daughter's side the partner is on
  const base = i * mb, n = store.bondCount[i]!;
  const sides: boolean[] = []; // true = side A (+m̂)
  let sideGE = 0, sideLT = 0;
  // P5 — the DECLARATIVE partition modes. `attrArr` is non-null only for a
  // `byBondAttribute` spec whose attribute the store actually allocated (a
  // deleted / bonds-off attribute degrades to `tension` here, matching
  // `dividePartitionFromConfig` and the node's validation badge — never a silent
  // mis-partition). `tension` leaves the loop below verbatim.
  const attrArr = partition.mode === 'byBondAttribute' && partition.attributeId
    ? (store.bondAttrs[partition.attributeId] ?? null)
    : null;
  const useTagB = attrArr !== null && partition.tagB.length > 0;
  for (let k = 0; k < n; k++) {
    if (attrArr !== null) {
      // A named bond attribute picks the daughter: a per-OPTION table for a tag,
      // else `value < threshold` -> A (which covers bool with threshold 0.5).
      const v = attrArr[base + k]!;
      let toB: boolean;
      if (useTagB) { const oi = v | 0; toB = oi >= 0 && oi < partition.tagB.length ? partition.tagB[oi] === 1 : false; }
      else toB = v >= partition.threshold;
      const side = !toB;
      sides.push(side);
      if (side) sideGE++; else sideLT++;
      continue;
    }
    if (partition.mode === 'alternate') {
      const side = (k & 1) === 0; // A, B, A, B... in SLOT order
      sides.push(side);
      if (side) sideGE++; else sideLT++;
      continue;
    }
    const p = store.bondPartner[base + k]!;
    let dx = store.x[p]! - cx, dy = store.y[p]! - cy;
    let side: boolean;
    if (is3d) {
      let dz = store.z[p]! - cz;
      if (torus) {
        if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
        if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
        if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
      }
      side = dx * mx + dy * my + dz * mz >= 0;
    } else {
      if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
      side = dx * mx + dy * my >= 0;
    }
    sides.push(side);
    if (side) sideGE++; else sideLT++;
  }
  // Decision D4 — the daughter-daughter bond. `auto` is the pre-P5 rule (only
  // when the mother was bonded, so a FREE agent's daughters separate); `always`
  // keeps a rewritten graph connected through every split; `never` is the
  // deliberate "split this node in two, disconnected" rewrite.
  // (`always` still needs a bond store — with the Bonds capability off, mb === 0,
  //  and asking for a bond there would make the capacity check reject EVERY
  //  division instead of just skipping a bond that cannot exist.)
  const addDaughterBond = partition.daughterBond === 'always' ? mb > 0
    : partition.daughterBond === 'never' ? false
      : n > 0;
  // 3. capacity pre-check — reject the WHOLE division on overflow (A keeps its
  //    side + the daughter bond; B gets its side + the daughter bond). Counts the
  //    RESOLVED partition's sides, so every mode inherits the whole-or-nothing
  //    rule (invariant I5) rather than only the geometric one.
  const aFinal = sideGE + (addDaughterBond ? 1 : 0);
  const bFinal = sideLT + (addDaughterBond ? 1 : 0);
  if (aFinal > mb || bFinal > mb) return -2;
  const newId = allocAgentSlot(store);
  if (newId < 0) return -1;

  // 4. geometry — split the area by asymmetry, place daughters along ±m̂
  const r = store.radius[i]!;
  const aFrac = Math.min(1, Math.max(0, asym));
  // D2 — what the split CONSERVES. `area` (the default) is the pre-D2 expression
  // VERBATIM — the same `Math.sqrt` calls in the same order, so every existing
  // model is bit-identical. `volume` uses ∛ so `rA³ + rB³ = r³`, and is coerced
  // away in a 2D world: "conserve r³" is meaningless on a disc, and the CaNode
  // row is hidden there, so a hand-edited 2D file must not behave differently
  // (the hidden-control STATE rule). `dividePartitionFromConfig` coerces too —
  // this is the last word, for a spec that reached us without a model.
  const volume = is3d && partition.conserve === 'volume';
  const rA = volume ? r * Math.cbrt(Math.max(1e-4, aFrac)) : r * Math.sqrt(Math.max(1e-4, aFrac));
  const rB = volume ? r * Math.cbrt(Math.max(1e-4, 1 - aFrac)) : r * Math.sqrt(Math.max(1e-4, 1 - aFrac));
  const off = r; // daughter centre separation
  let ax = cx + 0.5 * off * mx, ay = cy + 0.5 * off * my;
  let bx = cx - 0.5 * off * mx, by = cy - 0.5 * off * my;
  // z placement (3D); az/bz stay = cz in 2D (2D-ZERO — store.z is 0).
  let az = cz, bz = cz;
  if (is3d) { az = cz + 0.5 * off * mz; bz = cz - 0.5 * off * mz; }
  if (torus) {
    ax = ((ax % W) + W) % W; ay = ((ay % H) + H) % H; bx = ((bx % W) + W) % W; by = ((by % H) + H) % H;
    if (is3d) { az = ((az % D) + D) % D; bz = ((bz % D) + D) % D; }
  } else {
    ax = ax < 0 ? 0 : ax > W ? W : ax; ay = ay < 0 ? 0 : ay > H ? H : ay; bx = bx < 0 ? 0 : bx > W ? W : bx; by = by < 0 ? 0 : by > H ? H : by;
    if (is3d) { az = az < 0 ? 0 : az > D ? D : az; bz = bz < 0 ? 0 : bz > D ? D : bz; }
  }

  // 5. daughter B (new slot) — inherit mother's lineage/attrs/colour. z = bz
  // (the mother's z in 2D, the −½·off·m̂ offset in 3D).
  initAgentSlot(store, newId, bx, by, bz, rB, store.lineage[i]!);
  for (const spec of store.attrSpecs) {
    store.attrRead[spec.id]![newId] = store.attrRead[spec.id]![i]!;
  }
  store.targetRadius[newId] = store.targetRadius[i]!;
  for (let c = 0; c < 4; c++) store.colors[newId * 4 + c] = store.colors[i * 4 + c]!;
  // sprite state inherits verbatim like attrs/colours (initAgentSlot zeroed it) —
  // otherwise a dividing sprited agent yields one sprited + one plain daughter.
  store.spriteIds[newId] = store.spriteIds[i]!;
  store.spriteFrames[newId] = store.spriteFrames[i]!;
  store.spriteSpeeds[newId] = store.spriteSpeeds[i]!;
  store.spriteRotations[newId] = store.spriteRotations[i]!;
  store.spriteScales[newId] = store.spriteScales[i]!;

  // 6. daughter A — reuse mother slot i; shrink + relocate, reset age, clear request
  store.x[i] = ax; store.y[i] = ay; store.xNext[i] = ax; store.yNext[i] = ay;
  if (is3d) { store.z[i] = az; store.zNext[i] = az; }
  store.radius[i] = rA;
  store.age[i] = 0;
  store.divideRequest[i] = 0;

  // 7. reattach — move side-B partners' bonds from A(i) to B(newId). The snapshot
  // carries the USER BOND ATTRIBUTES too, so a re-formed bond arrives at daughter B
  // with the mother's values UNCHANGED — oracle O9: the partition chooses WHICH
  // daughter holds a bond, never what the bond carries. Must be read BEFORE the
  // first breakBond — the compaction swap moves slots around underneath us.
  const nAttr = store.bondAttrSpecs.length;
  const snap: Array<{ p: number; L: number; lam: number; typ: number; attrs: number[] | null }> = [];
  for (let k = 0; k < n; k++) {
    let attrs: number[] | null = null;
    if (nAttr > 0) {
      attrs = new Array<number>(nAttr);
      for (let ai = 0; ai < nAttr; ai++) attrs[ai] = (store.bondAttrs[store.bondAttrSpecs[ai]!.id]! as Uint8Array)[base + k]!;
    }
    snap.push({ p: store.bondPartner[base + k]!, L: store.bondRestLength[base + k]!, lam: store.bondStiffness[base + k]!, typ: store.bondTypeLabel[base + k]!, attrs });
  }
  for (let k = 0; k < n; k++) {
    if (!sides[k]) {
      const s = snap[k]!;
      breakBond(store, i, s.p);
      formBond(store, newId, s.p, s.L, s.lam, s.typ, s.attrs);
    }
  }
  // 8. daughter-daughter bond (tissue stays connected; free agents separate)
  if (addDaughterBond) formBond(store, i, newId, rA + rB, defaultLambda);

  return newId;
}

// ---------------------------------------------------------------------------
// Uniform spatial hash — the O(N) neighbour structure for the force driver.
// Bins the world into a CSR-style grid (binStart prefix-sums + binAgents grouped
// by bin) so each agent tests only its own bin + the 8 (2D) adjacent bins
// instead of every other agent. Box edge ≥ the max pair-interaction distance,
// so the 3×3 stencil is guaranteed to find every interacting pair. Returns null
// for a world too small to tile into ≥3 bins per axis (the caller falls back to
// the all-pairs O(N²) loop, which is correct + cheap at that scale).
//
// Reuses scratch buffers across steps (no per-step GC of the agent-sized
// binAgents array) — the binStart array is small (nBins+1) and reallocated when
// nBins changes (maxRadius growth shifts the bin size).
// ---------------------------------------------------------------------------

export interface SpatialHash {
  nBinsX: number; nBinsY: number;
  /** 3D bin count along z (1 in 2D — the query sites read `nBinsZ > 1` to switch
   *  to the 3×3×3 stencil). */
  nBinsZ: number;
  binSizeX: number; binSizeY: number;
  /** z bin edge (1 in 2D, unused). */
  binSizeZ: number;
  /** World-coordinate ORIGIN of bin (0,0,0). For a BOUNDED world the grid is
   *  anchored to the agents' bounding box (so the bin count + per-step cost scale
   *  with the agents' spread, NOT the world size). For a TORUS world this is
   *  (0,0,0) — the grid spans the whole world so the wrap-around stencil is
   *  correct — which makes the bin math byte-identical to the pre-origin code. A
   *  query computes its bin as `floor((pos - origin) / binSize)`. */
  originX: number; originY: number; originZ: number;
  binStart: Int32Array;   // length nBins+1 (prefix sums)
  binAgents: Int32Array;  // length liveCount (agent ids grouped by bin)
}

/** Per-store reusable scratch so the hash doesn't allocate every step. */
interface HashScratch { binStart: Int32Array; binAgents: Int32Array; cursor: Int32Array; }
const hashScratchMap = new WeakMap<AgentStore, HashScratch>();

// ===========================================================================
// C10 / P11a — THE DETERMINISTIC BARNES–HUT OCTREE (global charge).
//
// Built ONCE per generation in TypeScript and then TRAVERSED by each target:
// JS reads these arrays directly, the WASM force pass reads a COPY of them at
// baked offsets in the shared agent memory, and the WebGPU force pass reads an
// upload of them. That seam is deliberate and mirrors `buildSpatialHash`: the
// BUILD is where two implementations would drift (bbox reduction, float→int
// quantization, sort tie-break, split order) and it runs once per generation;
// the TRAVERSAL is the hot part and is pure arithmetic over shared bytes, which
// is exactly the shape the force pass already keeps bit-identical.
//
// DETERMINISM rests on four things, all of them structural:
//   1. Morton quantization is a pure function of the positions.
//   2. The sort is ORDER-CANONICAL — ties in the code are broken by the agent's
//      canonical id, so the permutation is a TOTAL order and cannot depend on the
//      sorting algorithm. Realised as a stable LSD radix sort seeded from an
//      id-ordered array (no comparator, no library sort).
//   3. The build is a deterministic DFS with a node-count CAP that degrades a
//      node to a LEAF when the reserve runs out. A leaf is MORE exact (it sums
//      its points pairwise), so the cap can never make a result wrong — only
//      slower — and it bites at exactly the same place every run.
//   4. The traversal is a fixed-order walk (nodeI ascending via skip links, leaf
//      points in sorted order), so the f64 accumulation order matches on JS+WASM.
// ===========================================================================

/** The tree, in the flat form all three targets consume. Node `n` covers the
 *  half-open range `[start[n], end[n])` of the MORTON-SORTED point arrays; `mass`
 *  is that range's length. `next[n]` is the SKIP LINK — the index of the next node
 *  after this whole subtree — so a traversal that accepts a node jumps straight
 *  past its children, and `next[n] === n + 1` is exactly the "is a leaf" test. */
export interface AgentOctree {
  /** Number of live points indexed (= the alive count at build time). */
  pointCount: number;
  /** Number of nodes built (≤ the reserve). */
  nodeCount: number;
  /** Morton-sorted positions (`pointCount` entries used). `sortedZ` is all-zero in
   *  2D — the tree is 3D-native and a 2D model is simply the z = 0 slice, so there
   *  is ONE build path and no 2D special case. */
  sortedX: Float64Array; sortedY: Float64Array; sortedZ: Float64Array;
  nodeStart: Int32Array; nodeEnd: Int32Array; nodeNext: Int32Array;
  /** Node CENTRE OF MASS (the mean of its points). */
  nodeCx: Float64Array; nodeCy: Float64Array; nodeCz: Float64Array;
  /** Node EXTENT — the largest side of the bounding box of its points. Compared
   *  against θ²·d² to decide whether the node may be collapsed to one body. */
  nodeExt: Float64Array;
}

interface OctreeScratch extends AgentOctree {
  morton: Uint32Array; order: Int32Array; tmp: Int32Array; counts: Int32Array;
  px: Float64Array; py: Float64Array; pz: Float64Array;
  nodeLevel: Int32Array; nodeParent: Int32Array;
  nodeMinX: Float64Array; nodeMinY: Float64Array; nodeMinZ: Float64Array;
  nodeMaxX: Float64Array; nodeMaxY: Float64Array; nodeMaxZ: Float64Array;
  capacityPoints: number; capacityNodes: number;
}
const octreeScratchMap = new WeakMap<AgentStore, OctreeScratch>();

/** Leaf capacity + depth limit (znah's reference values). A node with at most
 *  `LEAF` points, or at the depth limit, stops splitting. */
export const OCTREE_LEAF_SIZE = 16;
export const OCTREE_MAX_LEVEL = 10;

/** The node reserve for `maxAgents` agents. The DFS degrades to a leaf when this
 *  runs out (correct, just less approximated), so this is a performance budget and
 *  not a correctness bound. Measured node counts on real grown graphs sit far
 *  below `N` (a balanced octree with leaf capacity 16 has roughly N/8 nodes); the
 *  generous `N + 64` covers deep chains from heavy clustering. */
export function agentOctreeNodeReserve(maxAgents: number): number {
  return Math.max(1, Math.floor(maxAgents)) + 64;
}

/** Spread the low 10 bits of `x` into every third bit (the Morton interleave). */
function dilate3(x: number): number {
  let v = x & 0x3ff;
  v = (v | (v << 16)) & 0x30000ff;
  v = (v | (v << 8)) & 0x300f00f;
  v = (v | (v << 4)) & 0x30c30c3;
  v = (v | (v << 2)) & 0x9249249;
  return v >>> 0;
}

/** Build the per-generation Barnes–Hut octree over the store's LIVE agents.
 *  Returns null when there is nothing to build (no live agents) — the callers
 *  then simply add no charge this generation. Reuses per-store scratch so a
 *  steady-state generation allocates nothing. */
export function buildAgentOctree(store: AgentStore, is3d: boolean, nodeReserve?: number): AgentOctree | null {
  const hw = store.highWater, alive = store.alive;
  const x = store.x, y = store.y, z = store.z;
  const maxPoints = Math.max(1, store.maxAgents);
  const maxNodes = Math.max(1, Math.floor(nodeReserve ?? agentOctreeNodeReserve(store.maxAgents)));

  let sc = octreeScratchMap.get(store);
  if (!sc || sc.capacityPoints < maxPoints || sc.capacityNodes < maxNodes) {
    sc = {
      pointCount: 0, nodeCount: 0,
      sortedX: new Float64Array(maxPoints), sortedY: new Float64Array(maxPoints), sortedZ: new Float64Array(maxPoints),
      nodeStart: new Int32Array(maxNodes), nodeEnd: new Int32Array(maxNodes), nodeNext: new Int32Array(maxNodes),
      nodeCx: new Float64Array(maxNodes), nodeCy: new Float64Array(maxNodes), nodeCz: new Float64Array(maxNodes),
      nodeExt: new Float64Array(maxNodes),
      morton: new Uint32Array(maxPoints), order: new Int32Array(maxPoints), tmp: new Int32Array(maxPoints),
      counts: new Int32Array(1024),
      px: new Float64Array(maxPoints), py: new Float64Array(maxPoints), pz: new Float64Array(maxPoints),
      nodeLevel: new Int32Array(maxNodes), nodeParent: new Int32Array(maxNodes),
      nodeMinX: new Float64Array(maxNodes), nodeMinY: new Float64Array(maxNodes), nodeMinZ: new Float64Array(maxNodes),
      nodeMaxX: new Float64Array(maxNodes), nodeMaxY: new Float64Array(maxNodes), nodeMaxZ: new Float64Array(maxNodes),
      capacityPoints: maxPoints, capacityNodes: maxNodes,
    };
    octreeScratchMap.set(store, sc);
  }

  // --- gather the live points in CANONICAL id order (so the radix sort's
  //     stability makes the final order exactly (morton, id)) ------------------
  const px = sc.px, py = sc.py, pz = sc.pz;
  let n = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < hw; i++) {
    if (!alive[i]) continue;
    const xi = x[i]!, yi = y[i]!, zi = is3d ? z[i]! : 0;
    px[n] = xi; py[n] = yi; pz[n] = zi;
    if (xi < minX) minX = xi; if (xi > maxX) maxX = xi;
    if (yi < minY) minY = yi; if (yi > maxY) maxY = yi;
    if (zi < minZ) minZ = zi; if (zi > maxZ) maxZ = zi;
    n++;
  }
  if (n === 0) return null;

  // --- Morton codes over the cube that bounds the population ------------------
  // A CUBE (one `extent` for all three axes) keeps the octant split isotropic, so
  // the node extent used by the θ test means the same thing on every axis.
  let extent = maxX - minX;
  if (maxY - minY > extent) extent = maxY - minY;
  if (maxZ - minZ > extent) extent = maxZ - minZ;
  const loX = (minX + maxX) * 0.5 - extent * 0.5;
  const loY = (minY + maxY) * 0.5 - extent * 0.5;
  const loZ = (minZ + maxZ) * 0.5 - extent * 0.5;
  const scale = 1023 / (extent + 1e-8);
  const morton = sc.morton;
  for (let i = 0; i < n; i++) {
    // `| 0` after the multiply: the product is finite and in [0, 1023] by
    // construction (extent bounds every delta), so the truncation is exact.
    const ix = ((px[i]! - loX) * scale) | 0;
    const iy = ((py[i]! - loY) * scale) | 0;
    const iz = ((pz[i]! - loZ) * scale) | 0;
    morton[i] = (dilate3(ix) | (dilate3(iy) << 1) | (dilate3(iz) << 2)) >>> 0;
  }

  // --- ORDER-CANONICAL sort: stable LSD radix over 3 × 10 bits ---------------
  // Seeded with the identity permutation (= canonical id order) and stable at
  // every pass, so equal codes keep id order. No comparator ⇒ the result cannot
  // depend on a sort implementation, which is what makes the whole law replayable.
  let order = sc.order, tmp = sc.tmp;
  const counts = sc.counts;
  for (let i = 0; i < n; i++) order[i] = i;
  for (let shift = 0; shift < 30; shift += 10) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(morton[order[i]!]! >>> shift) & 1023]!++;
    let sum = 0;
    for (let b = 0; b < 1024; b++) { const c = counts[b]!; counts[b] = sum; sum += c; }
    for (let i = 0; i < n; i++) { const o = order[i]!; tmp[counts[(morton[o]! >>> shift) & 1023]!++] = o; }
    const swap = order; order = tmp; tmp = swap;
  }

  // --- materialise the sorted positions + sorted codes ------------------------
  const sortedX = sc.sortedX, sortedY = sc.sortedY, sortedZ = sc.sortedZ;
  // `tmp` is free after the last radix swap — reuse it to hold the SORTED codes so
  // the octant counting below reads them contiguously (Int32 holds 30 bits fine).
  const codes = tmp;
  for (let i = 0; i < n; i++) {
    const o = order[i]!;
    sortedX[i] = px[o]!; sortedY[i] = py[o]!; sortedZ[i] = pz[o]!;
    codes[i] = morton[o]!;
  }

  // --- build the nodes (DFS; children emitted contiguously in octant order) ---
  const nodeStart = sc.nodeStart, nodeEnd = sc.nodeEnd, nodeNext = sc.nodeNext;
  const nodeLevel = sc.nodeLevel, nodeParent = sc.nodeParent;
  let nodeCount = 0;
  // The octant histogram is PER LEVEL, not one shared array: `buildNode` recurses
  // between reading the counts and consuming them, so a single shared histogram
  // would be clobbered by the child call (a silent mis-split, not a crash).
  const oct = OCT_COUNTS;
  const buildNode = (level: number, start: number, end: number, parentIdx: number): void => {
    const ni = nodeCount++;
    nodeStart[ni] = start; nodeEnd[ni] = end; nodeLevel[ni] = level; nodeParent[ni] = parentIdx;
    // LEAF when small enough, at the depth limit, or when the node reserve is
    // exhausted (the degradation: a leaf is exact, just slower).
    if (end - start <= OCTREE_LEAF_SIZE || level >= OCTREE_MAX_LEVEL || nodeCount + 8 > maxNodes) {
      nodeNext[ni] = nodeCount;
      return;
    }
    const shift = (OCTREE_MAX_LEVEL - level - 1) * 3;
    const base = level * 8;
    for (let o = 0; o < 8; o++) oct[base + o] = 0;
    for (let i = start; i < end; i++) oct[base + ((codes[i]! >>> shift) & 7)]!++;
    let s = start;
    for (let o = 0; o < 8; o++) {
      const c = oct[base + o]!;
      if (c > 0) { buildNode(level + 1, s, s + c, ni); s += c; }
    }
    nodeNext[ni] = nodeCount;
  };
  buildNode(0, 0, n, 0);

  // --- accumulate centre of mass + bbox extent, children → parents ------------
  const nodeCx = sc.nodeCx, nodeCy = sc.nodeCy, nodeCz = sc.nodeCz, nodeExt = sc.nodeExt;
  const mnX = sc.nodeMinX, mnY = sc.nodeMinY, mnZ = sc.nodeMinZ;
  const mxX = sc.nodeMaxX, mxY = sc.nodeMaxY, mxZ = sc.nodeMaxZ;
  for (let i = 0; i < nodeCount; i++) {
    nodeCx[i] = 0; nodeCy[i] = 0; nodeCz[i] = 0;
    mnX[i] = Infinity; mnY[i] = Infinity; mnZ[i] = Infinity;
    mxX[i] = -Infinity; mxY[i] = -Infinity; mxZ[i] = -Infinity;
  }
  // Reverse order: a child always has a HIGHER index than its parent (DFS emits
  // the parent first), so walking down accumulates leaves before their ancestors.
  for (let ni = nodeCount - 1; ni >= 0; ni--) {
    if (nodeNext[ni] === ni + 1) {          // leaf → sum its own points
      for (let i = nodeStart[ni]!; i < nodeEnd[ni]!; i++) {
        const ax = sortedX[i]!, ay = sortedY[i]!, az = sortedZ[i]!;
        nodeCx[ni]! += ax; nodeCy[ni]! += ay; nodeCz[ni]! += az;
        if (ax < mnX[ni]!) mnX[ni] = ax; if (ax > mxX[ni]!) mxX[ni] = ax;
        if (ay < mnY[ni]!) mnY[ni] = ay; if (ay > mxY[ni]!) mxY[ni] = ay;
        if (az < mnZ[ni]!) mnZ[ni] = az; if (az > mxZ[ni]!) mxZ[ni] = az;
      }
    }
    const p = nodeParent[ni]!;
    if (p === ni) continue;                  // the root is its own parent
    nodeCx[p]! += nodeCx[ni]!; nodeCy[p]! += nodeCy[ni]!; nodeCz[p]! += nodeCz[ni]!;
    if (mnX[ni]! < mnX[p]!) mnX[p] = mnX[ni]!; if (mxX[ni]! > mxX[p]!) mxX[p] = mxX[ni]!;
    if (mnY[ni]! < mnY[p]!) mnY[p] = mnY[ni]!; if (mxY[ni]! > mxY[p]!) mxY[p] = mxY[ni]!;
    if (mnZ[ni]! < mnZ[p]!) mnZ[p] = mnZ[ni]!; if (mxZ[ni]! > mxZ[p]!) mxZ[p] = mxZ[ni]!;
  }
  for (let ni = 0; ni < nodeCount; ni++) {
    const mass = nodeEnd[ni]! - nodeStart[ni]!;
    nodeCx[ni]! /= mass; nodeCy[ni]! /= mass; nodeCz[ni]! /= mass;
    let e = mxX[ni]! - mnX[ni]!;
    const ey = mxY[ni]! - mnY[ni]!, ez = mxZ[ni]! - mnZ[ni]!;
    if (ey > e) e = ey; if (ez > e) e = ez;
    nodeExt[ni] = e;
  }

  sc.pointCount = n; sc.nodeCount = nodeCount;
  // `order`/`tmp` may have been swapped an odd number of times — put the scratch
  // references back so the next call reuses both buffers.
  sc.order = order; sc.tmp = tmp;
  return sc;
}
/** Per-LEVEL octant histograms (8 per level), hoisted so the recursive build
 *  allocates nothing. Indexed `level * 8 + octant` — see the note in `buildNode`
 *  about why a single shared histogram would be wrong. */
const OCT_COUNTS = new Int32Array(8 * (OCTREE_MAX_LEVEL + 2));

export function buildSpatialHash(
  store: AgentStore, binSize: number, W: number, H: number, D: number,
  torus = false, maxBins = AGENT_HASH_BIN_CAP,
): SpatialHash | null {
  const is3d = D > 1;
  const hw = store.highWater;
  const x = store.x, y = store.y, z = store.z, alive = store.alive;

  // --- choose the grid ORIGIN + per-axis EXTENT -----------------------------
  // TORUS: the grid spans the whole world from origin (0,0,0) so the wrap-around
  // stencil is correct (origin 0 → the bin math is byte-identical to the
  // pre-origin code). BOUNDED: anchor the grid to the agents' bounding box, so
  // the bin count (hence the per-step cost) tracks the agents' SPREAD, not the
  // world size — a tissue clustered in a corner of a huge volume pays for its own
  // extent, not the volume's.
  let ox = 0, oy = 0, oz = 0;
  let extX = W, extY = H, extZ = is3d ? D : 1;
  if (!torus) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let any = false;
    for (let i = 0; i < hw; i++) {
      if (!alive[i]) continue;
      any = true;
      const xi = x[i]!, yi = y[i]!;
      if (xi < minX) minX = xi; if (xi > maxX) maxX = xi;
      if (yi < minY) minY = yi; if (yi > maxY) maxY = yi;
      if (is3d) { const zi = z[i]!; if (zi < minZ) minZ = zi; if (zi > maxZ) maxZ = zi; }
    }
    if (!any) return null; // no agents → all-pairs (a no-op anyway)
    ox = minX; oy = minY; oz = is3d ? minZ : 0;
    extX = Math.max(0, maxX - minX); extY = Math.max(0, maxY - minY);
    extZ = is3d ? Math.max(0, maxZ - minZ) : 1;
  }

  // --- coarsen the bin edge so the total bin count fits `maxBins` ------------
  // The natural edge is `binSize` (≥ the interaction cutoff, so the 3×3 stencil
  // is sound). If that yields more bins than the reserve, grow the edge until it
  // fits (a larger edge is still sound — the stencil only covers MORE area).
  const dim = is3d ? 3 : 2;
  let edge = Math.max(1e-3, binSize);
  const binsAt = (e: number): number => {
    const nx = torus ? Math.floor(W / e) : Math.floor(extX / e) + 1;
    const ny = torus ? Math.floor(H / e) : Math.floor(extY / e) + 1;
    const nz = is3d ? (torus ? Math.floor(D / e) : Math.floor(extZ / e) + 1) : 1;
    return Math.max(1, nx) * Math.max(1, ny) * Math.max(1, nz);
  };
  for (let guard = 0; guard < 64 && binsAt(edge) > maxBins; guard++) {
    const factor = Math.pow(binsAt(edge) / maxBins, 1 / dim);
    edge *= Math.max(1.0625, factor); // grow at least a little so the loop terminates
  }

  // --- final bin dimensions -------------------------------------------------
  // TORUS keeps the exact-tiling edge (binSizeX = W/nBinsX) so the wrap is seam-
  // less; BOUNDED uses the (coarsened) edge directly + the bbox origin.
  let nBinsX: number, nBinsY: number, nBinsZ: number;
  let binSizeX: number, binSizeY: number, binSizeZ: number;
  if (torus) {
    nBinsX = Math.floor(W / edge); nBinsY = Math.floor(H / edge); nBinsZ = is3d ? Math.floor(D / edge) : 1;
    if (nBinsX < 3 || nBinsY < 3 || (is3d && nBinsZ < 3)) return null; // tiny world → all-pairs
    binSizeX = W / nBinsX; binSizeY = H / nBinsY; binSizeZ = is3d ? D / nBinsZ : 1;
  } else {
    nBinsX = Math.floor(extX / edge) + 1; nBinsY = Math.floor(extY / edge) + 1;
    nBinsZ = is3d ? Math.floor(extZ / edge) + 1 : 1;
    if (nBinsX < 3 || nBinsY < 3 || (is3d && nBinsZ < 3)) return null; // tiny spread → all-pairs (cheap)
    binSizeX = edge; binSizeY = edge; binSizeZ = is3d ? edge : 1;
  }
  const nBins = nBinsX * nBinsY * nBinsZ;

  let sc = hashScratchMap.get(store);
  if (!sc || sc.binStart.length < nBins + 1 || sc.binAgents.length < store.maxAgents) {
    sc = { binStart: new Int32Array(nBins + 1), binAgents: new Int32Array(store.maxAgents), cursor: new Int32Array(nBins) };
    hashScratchMap.set(store, sc);
  }
  const binStart = sc.binStart, binAgents = sc.binAgents, cursor = sc.cursor;
  binStart.fill(0, 0, nBins + 1);

  // binOf — `floor((pos-origin)/binSize)` (origin 0 on a torus → byte-identical
  // to the old `floor(pos/binSize)`). z-major `(bz*nBinsY+by)*nBinsX+bx` in 3D.
  const binOf = is3d
    ? (i: number): number => {
        let bx = ((x[i]! - ox) / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
        let by = ((y[i]! - oy) / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
        let bz = ((z[i]! - oz) / binSizeZ) | 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
        return (bz * nBinsY + by) * nBinsX + bx;
      }
    : (i: number): number => {
        let bx = ((x[i]! - ox) / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
        let by = ((y[i]! - oy) / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
        return by * nBinsX + bx;
      };
  // count → prefix sum → fill
  for (let i = 0; i < hw; i++) { if (!alive[i]) continue; binStart[binOf(i) + 1]!++; }
  for (let b = 0; b < nBins; b++) { binStart[b + 1]! += binStart[b]!; cursor[b] = binStart[b]!; }
  for (let i = 0; i < hw; i++) { if (!alive[i]) continue; const b = binOf(i); binAgents[cursor[b]!++] = i; }

  return { nBinsX, nBinsY, nBinsZ, binSizeX, binSizeY, binSizeZ, originX: ox, originY: oy, originZ: oz, binStart, binAgents };
}

/** HARD positional collision — a Jacobi position-projection constraint (the rigid,
 *  no-overlap alternative to the soft-sphere FORCE). Call AFTER the position commit
 *  (`swapPositions`), on the COMMITTED x/y[/z]: it rebuilds the hash on those
 *  positions, then for `iterations` sweeps pushes every overlapping pair
 *  (`d < s_ij = r_i + r_j`) apart to exactly touching — each moves HALF the overlap
 *  along the torus-shortest axis. **Jacobi**: each sweep reads the sweep-START
 *  positions (accumulating into the reused `forceX/Y[/Z]` buffers) and applies all
 *  corrections at once, so it is order-INDEPENDENT ⇒ identical on serial JS/WASM and
 *  parallel WebGPU (the WASM/WebGPU ports mirror this exact math for parity). No new
 *  per-agent SoA (reuses the dead force accumulator). The hash is rebuilt ONCE — the
 *  per-sweep corrections are sub-contact, so agents rarely cross bins between sweeps
 *  (the same locality the force pass relies on). A single sweep resolves an isolated
 *  pair exactly; dense packing converges over a few (hence the iteration knob). */
export function resolvePositionalCollisions(
  s: AgentStore, iterations: number, binEdge: number, reserve: number,
  W: number, H: number, D: number, is3d: boolean, torus: boolean,
): void {
  const hw = s.highWater, alive = s.alive, rad = s.radius;
  const x = s.x, y = s.y, zz = s.z;
  const corrX = s.forceX, corrY = s.forceY, corrZ = s.forceZ;
  const halfW = W / 2, halfH = H / 2, halfD = D / 2;
  const hash = buildSpatialHash(s, Math.max(1e-3, binEdge), W, H, D, torus, reserve);
  const nBinsX = hash ? hash.nBinsX : 0, nBinsY = hash ? hash.nBinsY : 0, nBinsZ = hash ? hash.nBinsZ : 0;
  const binStart = hash ? hash.binStart : null, binAgents = hash ? hash.binAgents : null;
  const bsX = hash ? hash.binSizeX : 1, bsY = hash ? hash.binSizeY : 1, bsZ = hash ? hash.binSizeZ : 1;
  const oX = hash ? hash.originX : 0, oY = hash ? hash.originY : 0, oZ = hash ? hash.originZ : 0;
  for (let iter = 0; iter < iterations; iter++) {
    // --- accumulate: corr[i] = Σ ½·overlap pushing i away from each overlapping j.
    // Interaction is INLINED (no closure — V8-optimal, matches the force pass) and
    // duplicated across 2D/3D × hash/all-pairs; identical float ops in every copy. ---
    if (is3d) {
      for (let i = 0; i < hw; i++) {
        if (!alive[i]) { corrX[i] = 0; corrY[i] = 0; corrZ[i] = 0; continue; }
        const xi = x[i]!, yi = y[i]!, zi = zz[i]!, ri = rad[i]!;
        let cx = 0, cy = 0, cz = 0;
        if (hash) {
          let bx = ((xi - oX) / bsX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
          let by = ((yi - oY) / bsY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
          let bz = ((zi - oZ) / bsZ) | 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
          for (let ddz = -1; ddz <= 1; ddz++) for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
            let nbx = bx + ddx, nby = by + ddy, nbz = bz + ddz;
            if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; nbz = ((nbz % nBinsZ) + nBinsZ) % nBinsZ; }
            else { if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY || nbz < 0 || nbz >= nBinsZ) continue; }
            const b = (nbz * nBinsY + nby) * nBinsX + nbx;
            const end = binStart![b + 1]!;
            for (let p = binStart![b]!; p < end; p++) {
              const j = binAgents![p]!;
              if (j === i || !alive[j]) continue;
              let dx = x[j]! - xi, dy = y[j]! - yi, dz = zz[j]! - zi;
              if (torus) {
                if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
                if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
                if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
              }
              const d2 = dx * dx + dy * dy + dz * dz;
              const sij = ri + rad[j]!;
              if (d2 > 0 && d2 < sij * sij) {
                const d = Math.sqrt(d2);
                const push = 0.5 * (sij - d) / d;
                cx -= push * dx; cy -= push * dy; cz -= push * dz;
              }
            }
          }
        } else {
          for (let j = 0; j < hw; j++) {
            if (j === i || !alive[j]) continue;
            let dx = x[j]! - xi, dy = y[j]! - yi, dz = zz[j]! - zi;
            if (torus) {
              if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W;
              if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H;
              if (dz > halfD) dz -= D; else if (dz < -halfD) dz += D;
            }
            const d2 = dx * dx + dy * dy + dz * dz;
            const sij = ri + rad[j]!;
            if (d2 > 0 && d2 < sij * sij) {
              const d = Math.sqrt(d2);
              const push = 0.5 * (sij - d) / d;
              cx -= push * dx; cy -= push * dy; cz -= push * dz;
            }
          }
        }
        corrX[i] = cx; corrY[i] = cy; corrZ[i] = cz;
      }
    } else {
      for (let i = 0; i < hw; i++) {
        if (!alive[i]) { corrX[i] = 0; corrY[i] = 0; continue; }
        const xi = x[i]!, yi = y[i]!, ri = rad[i]!;
        let cx = 0, cy = 0;
        if (hash) {
          let bx = ((xi - oX) / bsX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
          let by = ((yi - oY) / bsY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
          for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
            let nbx = bx + ddx, nby = by + ddy;
            if (torus) { nbx = ((nbx % nBinsX) + nBinsX) % nBinsX; nby = ((nby % nBinsY) + nBinsY) % nBinsY; }
            else { if (nbx < 0 || nbx >= nBinsX || nby < 0 || nby >= nBinsY) continue; }
            const b = nby * nBinsX + nbx;
            const end = binStart![b + 1]!;
            for (let p = binStart![b]!; p < end; p++) {
              const j = binAgents![p]!;
              if (j === i || !alive[j]) continue;
              let dx = x[j]! - xi, dy = y[j]! - yi;
              if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
              const d2 = dx * dx + dy * dy;
              const sij = ri + rad[j]!;
              if (d2 > 0 && d2 < sij * sij) {
                const d = Math.sqrt(d2);
                const push = 0.5 * (sij - d) / d;
                cx -= push * dx; cy -= push * dy;
              }
            }
          }
        } else {
          for (let j = 0; j < hw; j++) {
            if (j === i || !alive[j]) continue;
            let dx = x[j]! - xi, dy = y[j]! - yi;
            if (torus) { if (dx > halfW) dx -= W; else if (dx < -halfW) dx += W; if (dy > halfH) dy -= H; else if (dy < -halfH) dy += H; }
            const d2 = dx * dx + dy * dy;
            const sij = ri + rad[j]!;
            if (d2 > 0 && d2 < sij * sij) {
              const d = Math.sqrt(d2);
              const push = 0.5 * (sij - d) / d;
              cx -= push * dx; cy -= push * dy;
            }
          }
        }
        corrX[i] = cx; corrY[i] = cy;
      }
    }
    // --- apply: x += corr, re-wrap (torus) / clamp (bounded) ---
    for (let i = 0; i < hw; i++) {
      if (!alive[i]) continue;
      let nx = x[i]! + corrX[i]!, ny = y[i]! + corrY[i]!;
      if (torus) { nx = ((nx % W) + W) % W; ny = ((ny % H) + H) % H; }
      else { nx = nx < 0 ? 0 : nx > W ? W : nx; ny = ny < 0 ? 0 : ny > H ? H : ny; }
      x[i] = nx; y[i] = ny;
      if (is3d) {
        let nz = zz[i]! + corrZ[i]!;
        if (torus) nz = ((nz % D) + D) % D;
        else nz = nz < 0 ? 0 : nz > D ? D : nz;
        zz[i] = nz;
      }
    }
  }
}

/** Slice a Float64 store array into a fresh Float32 copy (narrowing convert). */
function f32Slice(src: Float64Array, n: number): Float32Array {
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  return out;
}

export function snapshotAgentsForRender(store: AgentStore, includeSprites = false, includeVelocity = false): AgentRenderSnapshot {
  const hw = store.highWater;
  // A1: gate z/vz on worldDepth > 1 so 2D models pay NO extra per-step alloc/
  // transfer for the (always-zero) z arm. 2D → length-0 placeholders (renderer
  // reads z=0). P2 slim: vx/vy ship only for consumers that actually READ a
  // heading — SPRITE models (orientToVelocity) and the vision-cone display
  // (`includeVelocity`, set while Show vision isn't Off) — and everything ships
  // as f32 (render precision — the store stays f64). 45 → ~21 B/agent for a
  // plain 2D model. NB a consumer that reads vx/vy WITHOUT requesting them sees
  // length-0 arrays, i.e. a silent zero heading (this is exactly how the vision
  // cones rendered as full circles before `includeVelocity` existed).
  const is3d = store.worldDepth > 1;
  const EMPTY = new Float32Array(0);
  const wantVel = includeSprites || includeVelocity;
  return {
    highWater: hw,
    liveCount: store.liveCount,
    x: f32Slice(store.x, hw),
    y: f32Slice(store.y, hw),
    z: is3d ? f32Slice(store.z, hw) : EMPTY,
    vx: wantVel ? f32Slice(store.vx, hw) : EMPTY,
    vy: wantVel ? f32Slice(store.vy, hw) : EMPTY,
    vz: is3d && wantVel ? f32Slice(store.vz, hw) : EMPTY,
    radius: f32Slice(store.radius, hw),
    alive: store.alive.slice(0, hw),
    colors: store.colors.slice(0, hw * 4),
    bonds: snapshotBonds(store),
    // Sprites: only ship the per-agent buffers when the model has sprites; else
    // length-0 so non-sprite agent models are byte-identical (no extra transfer).
    spriteIds: includeSprites ? store.spriteIds.slice(0, hw) : new Int32Array(0),
    spriteFrames: includeSprites ? f32Slice(store.spriteFrames, hw) : EMPTY,
    spriteRotations: includeSprites ? f32Slice(store.spriteRotations, hw) : EMPTY,
    spriteScales: includeSprites ? f32Slice(store.spriteScales, hw) : EMPTY,
  };
}

/** Advance every live agent's sprite frame by its per-agent speed (the engine
 *  half of the logic-driven playback — the Set Agent Sprite node sets the speed;
 *  this advances `frame += speed` once per simulation step). Unbounded by design
 *  (the render floors + wraps/clamps by the sprite's frame count + loop flag) —
 *  f64 keeps integer frames exact far past any realistic step count, and a reset
 *  (Set Frame) re-centres it. No-op for agents with no sprite (`spriteIds[i] === 0`)
 *  or zero speed. Called per step from the worker, gated on the model having
 *  sprites. */
export function advanceAgentSprites(store: AgentStore): void {
  const hw = store.highWater;
  const ids = store.spriteIds, frames = store.spriteFrames, speeds = store.spriteSpeeds, alive = store.alive;
  for (let i = 0; i < hw; i++) {
    if (alive[i] && ids[i]! > 0 && speeds[i] !== 0) frames[i]! += speeds[i]!;
  }
}

// ---------------------------------------------------------------------------
// Serialization — the holey agent table + ragged bond store + free-list. The
// dangling-bond ABI (partner-id validity + epoch + alive-mask) is restored
// exactly because the alive-mask + epoch + free-list all round-trip. Per-agent
// arrays are sliced to highWater; bond arrays to highWater*maxBonds (stride =
// maxBonds, carried in the payload so load can reject a mismatched stride
// loudly rather than silently mis-strided). PR-B1 hardens load validation.
// ---------------------------------------------------------------------------

export interface AgentStatePayload {
  highWater: number;
  liveCount: number;
  freeTop: number;
  maxBonds: number;
  x: ArrayBuffer; y: ArrayBuffer; radius: ArrayBuffer; targetRadius: ArrayBuffer;
  /** planar velocity — momentum models (flocking) lose their motion state
   *  without it. Optional for legacy pre-velocity saves → zeroed on load. */
  vx?: ArrayBuffer; vy?: ArrayBuffer;
  /** z / z-velocity (3D agents). Always written when the store is 3D; absent on
   *  a legacy pre-z 2D save → `deserializeAgentStore` leaves z/vz at 0 (the
   *  `if (p.z)` additive-load guard). `worldDepth` is NOT serialized (re-derived
   *  from `gridDepth` on load). */
  z?: ArrayBuffer; vz?: ArrayBuffer;
  /** sprite display state (Set Agent Sprite). Optional; zeroed on load when absent. */
  spriteIds?: ArrayBuffer; spriteFrames?: ArrayBuffer; spriteSpeeds?: ArrayBuffer;
  /** per-agent sprite facing angle + size override. Optional (legacy → 0). */
  spriteRotations?: ArrayBuffer; spriteScales?: ArrayBuffer;
  age: ArrayBuffer; lineage: ArrayBuffer; alive: ArrayBuffer; epoch: ArrayBuffer;
  freeList: ArrayBuffer;
  bondCount: ArrayBuffer; bondPartner: ArrayBuffer; bondPartnerEpoch: ArrayBuffer;
  bondRestLength: ArrayBuffer; bondStiffness: ArrayBuffer; bondTypeLabel: ArrayBuffer;
  colors: ArrayBuffer;
  attrs: Record<string, { kind: AgentAttrKind; buffer: ArrayBuffer }>;
  /** P2 — USER BOND ATTRIBUTES, one ragged buffer per attribute (sliced to
   *  highWater*maxBonds, like the built-in bond fields). Optional so a pre-P2
   *  `.gcastate` / `getState` payload still loads (each attribute falls back to
   *  its default). Mirrors `attrs`'s `{ kind, buffer }` shape. */
  bondAttrs?: Record<string, { kind: 'int32' | 'float64'; buffer: ArrayBuffer }>;
}

/** Snapshot the store into transferable buffers (for `getState` / .gcastate).
 *  Pushes every buffer onto `transfers` so the caller can transfer them. */
export function serializeAgentStore(store: AgentStore, transfers: ArrayBuffer[]): AgentStatePayload {
  const hw = store.highWater;
  const bw = hw * store.maxBonds;
  const sl = (a: AgentTypedArray, n: number): ArrayBuffer => { const c = a.slice(0, n); transfers.push(c.buffer); return c.buffer; };
  const slColors = (): ArrayBuffer => { const c = store.colors.slice(0, hw * 4); transfers.push(c.buffer); return c.buffer; };
  const attrs: Record<string, { kind: AgentAttrKind; buffer: ArrayBuffer }> = {};
  for (const spec of store.attrSpecs) {
    attrs[spec.id] = { kind: store.attrKind[spec.id]!, buffer: sl(store.attrRead[spec.id]!, hw) };
  }
  // P2 — one ragged buffer per user bond attribute (sliced like the built-ins).
  // Omitted entirely when the model has none, so a bond-attribute-free payload is
  // byte-identical to pre-P2.
  const bondAttrs: Record<string, { kind: 'int32' | 'float64'; buffer: ArrayBuffer }> = {};
  for (const spec of store.bondAttrSpecs) {
    bondAttrs[spec.id] = { kind: store.bondAttrKinds[spec.id]!, buffer: sl(store.bondAttrs[spec.id]!, bw) };
  }
  const freeListCopy = store.freeList.slice(0, store.freeTop);
  transfers.push(freeListCopy.buffer);
  // z/vz: written only in 3D (worldDepth > 1) — a 2D save omits them and loads
  // back at z=0 via the deserialize `if (p.z)` guard, so 2D getState/.gcastate
  // pays no extra always-zero buffer (matches the snapshot A1 gate).
  const is3d = store.worldDepth > 1;
  return {
    highWater: hw, liveCount: store.liveCount, freeTop: store.freeTop, maxBonds: store.maxBonds,
    x: sl(store.x, hw), y: sl(store.y, hw), radius: sl(store.radius, hw), targetRadius: sl(store.targetRadius, hw),
    vx: sl(store.vx, hw), vy: sl(store.vy, hw),
    ...(is3d ? { z: sl(store.z, hw), vz: sl(store.vz, hw) } : {}),
    spriteIds: sl(store.spriteIds, hw), spriteFrames: sl(store.spriteFrames, hw), spriteSpeeds: sl(store.spriteSpeeds, hw),
    spriteRotations: sl(store.spriteRotations, hw), spriteScales: sl(store.spriteScales, hw),
    age: sl(store.age, hw), lineage: sl(store.lineage, hw),
    alive: sl(store.alive, hw), epoch: sl(store.epoch, hw),
    freeList: freeListCopy.buffer,
    bondCount: sl(store.bondCount, hw),
    bondPartner: sl(store.bondPartner, bw), bondPartnerEpoch: sl(store.bondPartnerEpoch, bw),
    bondRestLength: sl(store.bondRestLength, bw), bondStiffness: sl(store.bondStiffness, bw),
    bondTypeLabel: sl(store.bondTypeLabel, bw),
    colors: slColors(),
    attrs,
    ...(store.bondAttrSpecs.length > 0 ? { bondAttrs } : {}),
  };
}

/** Restore a snapshot INTO the existing store (copy-into, never reassign — the
 *  Phase F WASM port will view these over wasmMemory). Throws on a structural
 *  mismatch (maxBonds stride, overflow) so the loader can reject LOUDLY rather
 *  than silently mis-stride a ragged store. Returns nothing; mutates `store`. */
export function deserializeAgentStore(store: AgentStore, p: AgentStatePayload): void {
  // A stride mismatch mis-strides a RAGGED restore, so reject it LOUDLY — BUT only
  // when the saved state actually HAS bonds. STEP 3 (Agent Capability Profiles): a
  // Bonds=off model now has maxBonds=0, so a state saved before the profile
  // tightened carries a larger stride but ZERO bonds; the ragged copyInto clamps to
  // the 0-length store and the bond-free state loads cleanly (the versioned-payload
  // compat, M1). `copyInto` uses min(dst,src) lengths, so an all-empty bond payload
  // never mis-strides.
  if (p.maxBonds !== store.maxBonds && new Int32Array(p.bondCount).some(c => c > 0)) {
    throw new Error(`agent bond stride mismatch: saved maxBonds=${p.maxBonds} (with live bonds), model maxBonds=${store.maxBonds}`);
  }
  const hw = p.highWater;
  if (hw > store.maxAgents) {
    throw new Error(`agent count ${hw} exceeds model maxAgents=${store.maxAgents}`);
  }
  const copyInto = (dst: AgentTypedArray, src: ArrayBuffer, Ctor: new (b: ArrayBuffer) => AgentTypedArray) => {
    const s = new Ctor(src);
    const n = Math.min(dst.length, s.length);
    for (let i = 0; i < n; i++) (dst as Uint8Array)[i] = s[i]!;
  };
  // clear the live region first so stale holes don't linger past hw
  store.alive.fill(0); store.bondPartner.fill(-1); store.bondCount.fill(0);
  copyInto(store.x, p.x, Float64Array as never); copyInto(store.y, p.y, Float64Array as never);
  // velocity + sprite state: ALWAYS reset before the additive load — loading
  // into a running session must not leave loaded agents inheriting the previous
  // run's velocities/sprites at unrelated slot indices.
  store.vx.fill(0); store.vy.fill(0);
  store.spriteIds.fill(0); store.spriteFrames.fill(0); store.spriteSpeeds.fill(0);
  store.spriteRotations.fill(0); store.spriteScales.fill(0);
  if (p.vx) copyInto(store.vx, p.vx, Float64Array as never);
  if (p.vy) copyInto(store.vy, p.vy, Float64Array as never);
  if (p.spriteIds) copyInto(store.spriteIds, p.spriteIds, Int32Array as never);
  if (p.spriteFrames) copyInto(store.spriteFrames, p.spriteFrames, Float64Array as never);
  if (p.spriteSpeeds) copyInto(store.spriteSpeeds, p.spriteSpeeds, Float64Array as never);
  if (p.spriteRotations) copyInto(store.spriteRotations, p.spriteRotations, Float64Array as never);
  if (p.spriteScales) copyInto(store.spriteScales, p.spriteScales, Float64Array as never);
  // z/vz: additive-load guard (the grid's `depth ?? 1` discipline). A legacy
  // pre-z 2D save omits them → leave the freshly-allocated store's z/vz at 0.
  store.z.fill(0); store.vz.fill(0);
  if (p.z) copyInto(store.z, p.z, Float64Array as never);
  if (p.vz) copyInto(store.vz, p.vz, Float64Array as never);
  copyInto(store.radius, p.radius, Float64Array as never); copyInto(store.targetRadius, p.targetRadius, Float64Array as never);
  copyInto(store.age, p.age, Float64Array as never);
  copyInto(store.lineage, p.lineage, Int32Array as never);
  copyInto(store.alive, p.alive, Uint8Array as never); copyInto(store.epoch, p.epoch, Int32Array as never);
  copyInto(store.bondCount, p.bondCount, Int32Array as never);
  copyInto(store.bondPartner, p.bondPartner, Int32Array as never);
  copyInto(store.bondPartnerEpoch, p.bondPartnerEpoch, Int32Array as never);
  copyInto(store.bondRestLength, p.bondRestLength, Float64Array as never);
  copyInto(store.bondStiffness, p.bondStiffness, Float64Array as never);
  copyInto(store.bondTypeLabel, p.bondTypeLabel, Int32Array as never);
  // P2 — user bond attributes. Reset to the attribute default FIRST (so an
  // attribute missing from an older payload doesn't inherit the previous run's
  // values on live slots), then copy whatever the payload carries.
  for (const spec of store.bondAttrSpecs) {
    const arr = store.bondAttrs[spec.id]!;
    (arr as Uint8Array).fill(spec.defaultValue);
    const entry = p.bondAttrs?.[spec.id];
    if (!entry) continue;
    copyInto(arr, entry.buffer, (entry.kind === 'float64' ? Float64Array : Int32Array) as never);
  }
  // colors is Uint8ClampedArray (outside the AgentTypedArray union) — copy directly.
  { const sc = new Uint8ClampedArray(p.colors); const n = Math.min(store.colors.length, sc.length); for (let i = 0; i < n; i++) store.colors[i] = sc[i]!; }
  copyInto(store.freeList, p.freeList, Int32Array as never);
  for (const spec of store.attrSpecs) {
    const entry = p.attrs[spec.id];
    if (!entry) continue;
    const Ctor = (entry.kind === 'uint8' ? Uint8Array : entry.kind === 'int32' ? Int32Array : Float64Array) as never;
    copyInto(store.attrRead[spec.id]!, entry.buffer, Ctor);
    // mirror into the write buffer so the first agent step reads consistent state
    copyInto(store.attrWrite[spec.id]!, entry.buffer, Ctor);
  }
  store.highWater = hw;
  store.liveCount = p.liveCount;
  store.freeTop = p.freeTop;
}
