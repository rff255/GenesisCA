// ===========================================================================
// Shared, layout-agnostic AGENT ABI descriptor — the SINGLE source of truth for
// the agent-loop / division-event / init-event function signatures. The three
// CPU-side ABI mirrors — the PARAM name strings (compile.ts `buildAgent*Params`),
// the worker ARG value arrays (`buildAgent*Args`), and the parity harness's
// `buildArgs` — all DERIVE from this one descriptor, so they can never desync in
// ORDER (the silent "3D dimsModel / total" desync class the mirrors warned about
// in prose). Each field bundles its NAME + a `get(store, rt)` value resolver, so
// the name and the value are defined together in ONE place.
//
// STEP 0 change: the descriptor is currently profile-UNAWARE (every field always
// present ⇒ byte-identical to the hand-written mirrors), verified by the golden
// param comparison + the parity harness + `audit-agent-layout`. Phase 2 (STEP 3+)
// adds an optional `gate(profile)` per field so a capability's fields drop from
// ALL FOUR sites together with one edit here.
//
// The descriptor takes a lightweight `AgentAbiShape` (primitives) rather than the
// full model, so the worker (which keeps no model) can derive it from its own
// globals, and compile.ts / the harness from theirs — all producing the SAME
// ordered field list.
// ===========================================================================

import type { AgentStore } from '../../../simulator/engine/agentEngine';
import type { AgentCapabilities } from '../../../model/types';

export type AgentAbiKind = 'loop' | 'division' | 'init';

/** The primitives the descriptor needs — every site can produce these. Order of
 *  `agentAttrs` / `fieldAttrs` MUST match across sites (they all derive from
 *  `agentAttrsOf` / `cellFieldAttrsOf` in the same order). */
export interface AgentAbiShape {
  is3d: boolean;
  agentAttrs: ReadonlyArray<{ id: string }>;
  fieldAttrs: ReadonlyArray<{ id: string }>;
  hasLookupTables: boolean;
  /** P2 — USER BOND attributes (per-EDGE state), in `bondAttrsOf(model)` order.
   *  Adds `_bondAttr_<id>` (the ragged region) to the `loop` AND `division` blocks,
   *  plus `_bondFormAttr_<id>` (the per-agent Form-Bond initial-value request cell)
   *  to `loop`. ABSENT / empty ⇒ no fields at all, so every pre-P2 signature is
   *  byte-identical. Already empty when the Bonds capability is off — `bondAttrsOf`
   *  applies that filter, so the descriptor needs no `gate` (see the note on the
   *  `gate` hook below). */
  bondAttrs?: ReadonlyArray<{ id: string }>;
  /** L2 — the `_generation` scalar (Get Generation). **Asymmetric by design and
   *  the ONLY field that is**: the COMPILER passes the graph's real answer (so a
   *  graph that never reads the generation emits its historical param string and
   *  stays byte-identical), while the WORKER and the parity harness always pass
   *  `true` (so the value is always supplied). Params ≤ args is the safe
   *  direction for a JS function — an extra trailing arg is ignored, a missing
   *  param reads `undefined` — which makes the dangerous direction structurally
   *  impossible. Appended at the VERY END of every kind, after the 3D block. */
  usesGeneration?: boolean;
}

/** The runtime values the ARG resolvers pull from (the external caches the
 *  worker keeps as module globals + the harness passes as ctx). Per-agent SoA
 *  values come from the `AgentStore`; everything else from here. */
export interface AgentAbiRuntime {
  /** The current spatial hash (or null → all-pairs fallback). Shape:
   *  { binStart, binAgents, nBinsX/Y/Z, binSizeX/Y/Z, originX/Y/Z }. */
  hash: {
    binStart: unknown; binAgents: unknown;
    nBinsX: number; nBinsY: number; nBinsZ: number;
    binSizeX: number; binSizeY: number; binSizeZ: number;
    originX: number; originY: number; originZ: number;
  } | null;
  /** An empty Int32Array reused when `hash` is null (the two hash-array slots). */
  emptyI32: unknown;
  modelAttrs: unknown;
  /** The resolved active-viewer id (the loop may pass a per-pass override). */
  viewer: unknown;
  indicators: unknown;
  rngState: unknown;
  stopFlag: unknown;
  glyphCodes: unknown;
  glyphColors: unknown;
  lookupTables: unknown;
  width: number; height: number; total: number; torus: boolean;
  /** Resolve a cell-field array by attr id (the worker's `readAttrs[id]`). */
  fieldArray: (id: string) => unknown;
  // --- division-event extras (leading positional args) ---
  idx?: number; daughterIndex?: number; axisX?: number; axisY?: number;
  // --- init-event extras (leading host closures + trailing seed base) ---
  agentCreate?: unknown; agentAddToWorld?: unknown; seedBase?: number;
  /** L2 — the 0-based index of the generation being computed. See the pinned
   *  semantics on GetGenerationNode: init events read 0, a division event reads
   *  the generation it happened in, and cells + agents share one counter. */
  generation?: number;
}

/** One ABI field: its param NAME + a runtime value resolver. `gate` (STEP 3+)
 *  drops the field when the profile has the capability off; absent ⇒ core
 *  (always present). `cType` labels the value shape for the layout audit. */
export interface AgentAbiField {
  name: string;
  cType: 'f64[]' | 'i32[]' | 'u8[]' | 'u32[]' | 'clamped[]' | 'scalar' | 'obj' | 'fn';
  get: (s: AgentStore, rt: AgentAbiRuntime) => unknown;
  gate?: (p: AgentCapabilities) => boolean;
}

// Small field constructors keep the descriptor terse + consistent.
type Getter = (s: AgentStore, rt: AgentAbiRuntime) => unknown;
const F = (name: string, cType: AgentAbiField['cType'], get: Getter, gate?: (p: AgentCapabilities) => boolean): AgentAbiField => ({ name, cType, get, gate });

/** Build the ordered ABI field list for a function kind. Currently
 *  profile-unaware (STEP 0): every field is emitted, so the output is
 *  byte-identical to the hand-written mirrors. The `profile` param is accepted
 *  now so STEP 3+ can gate fields without a signature change at the call sites. */
export function deriveAgentAbi(kind: AgentAbiKind, shape: AgentAbiShape, profile?: AgentCapabilities): AgentAbiField[] {
  // The `gate(profile)` hook stays UNUSED, deliberately (P2 finding): NOT ONE
  // caller passes a profile — `compile.ts`'s three param builders, the worker's
  // three arg builders and every harness all call with `(kind, shape)`. Making the
  // hook live would therefore be a silent no-op at every real site, and wiring a
  // profile through six call sites is not what a capability gate needs to be:
  // the SHAPE is already the gate. P2's bond block drops when `shape.bondAttrs` is
  // empty, and `bondAttrsOf(model)` (the ONE resolver every site uses) returns
  // empty when the Bonds capability is off — so the block gates on the capability
  // without the descriptor ever seeing a profile.
  void profile;
  const { is3d, agentAttrs, fieldAttrs, hasLookupTables } = shape;
  const bondAttrs = shape.bondAttrs ?? [];
  const fields: AgentAbiField[] = [];

  // --- leading positional args (division / init) ---
  if (kind === 'division') {
    fields.push(
      F('idx', 'scalar', (_s, rt) => rt.idx),
      F('__daughterIndex', 'scalar', (_s, rt) => rt.daughterIndex),
      F('__axisDefaultX', 'scalar', (_s, rt) => rt.axisX),
      F('__axisDefaultY', 'scalar', (_s, rt) => rt.axisY),
    );
  } else if (kind === 'init') {
    fields.push(
      F('_agentCreate', 'fn', (_s, rt) => rt.agentCreate),
      F('_agentAddToWorld', 'fn', (_s, rt) => rt.agentAddToWorld),
      F('_agentMaxAgents', 'scalar', s => s.maxAgents),
    );
  }

  // --- liveness + loop control (loop / division carry it; init doesn't loop) ---
  if (kind === 'loop' || kind === 'division') {
    fields.push(
      F('_alive', 'u8[]', s => s.alive),
      F('highWater', 'scalar', s => s.highWater),
    );
  }

  // --- engine geometry / identity / reductions ---
  fields.push(
    F('_agentX', 'f64[]', s => s.x),
    F('_agentY', 'f64[]', s => s.y),
    F('_agentRadius', 'f64[]', s => s.radius),
    F('_agentTargetRadius', 'f64[]', s => s.targetRadius),
    F('_agentAge', 'f64[]', s => s.age),
    F('_agentLineage', 'i32[]', s => s.lineage),
  );
  // init omits bondCount/density (its writable geometry set is smaller).
  if (kind === 'loop' || kind === 'division') {
    fields.push(
      F('_agentBondCount', 'i32[]', s => s.bondCount),
      F('_agentDensity', 'f64[]', s => s.density),
    );
  }
  fields.push(
    F('_agentVX', 'f64[]', s => s.vx),
    F('_agentVY', 'f64[]', s => s.vy),
  );
  // force accumulator — loop only (division reads forces via velocity; init sets none).
  if (kind === 'loop') {
    fields.push(
      F('_agentForceX', 'f64[]', s => s.forceX),
      F('_agentForceY', 'f64[]', s => s.forceY),
    );
  }

  // --- spatial hash (loop only — Get Nearby Agents queries it) ---
  if (kind === 'loop') {
    fields.push(
      F('_hashValid', 'scalar', (_s, rt) => (rt.hash ? 1 : 0)),
      F('_hashBinStart', 'i32[]', (_s, rt) => (rt.hash ? rt.hash.binStart : rt.emptyI32)),
      F('_hashBinAgents', 'i32[]', (_s, rt) => (rt.hash ? rt.hash.binAgents : rt.emptyI32)),
      F('_hashNBinsX', 'scalar', (_s, rt) => (rt.hash ? rt.hash.nBinsX : 0)),
      F('_hashNBinsY', 'scalar', (_s, rt) => (rt.hash ? rt.hash.nBinsY : 0)),
      F('_hashBinSizeX', 'scalar', (_s, rt) => (rt.hash ? rt.hash.binSizeX : 1)),
      F('_hashBinSizeY', 'scalar', (_s, rt) => (rt.hash ? rt.hash.binSizeY : 1)),
      F('_hashOriginX', 'scalar', (_s, rt) => (rt.hash ? rt.hash.originX : 0)),
      F('_hashOriginY', 'scalar', (_s, rt) => (rt.hash ? rt.hash.originY : 0)),
    );
  }

  // --- request buffers (loop only — DivideAgent / KillAgent write them) ---
  if (kind === 'loop') {
    fields.push(
      F('_divideRequest', 'u8[]', s => s.divideRequest),
      F('_divideAxisX', 'f64[]', s => s.divideAxisX),
      F('_divideAxisY', 'f64[]', s => s.divideAxisY),
      F('_divideAsym', 'f64[]', s => s.divideAsym),
      F('_killRequest', 'u8[]', s => s.killRequest),
      // Unified spawning — the SAME host closures the Init Event uses, so
      // Create Agent + Add Agent To World work in the Behaviour graph too
      // (mid-step spawning). `_agentMaxAgents` is the by-id setters' range guard.
      F('_agentCreate', 'fn', (_s, rt) => rt.agentCreate),
      F('_agentAddToWorld', 'fn', (_s, rt) => rt.agentAddToWorld),
      F('_agentMaxAgents', 'scalar', s => s.maxAgents),
    );
  }

  // --- bond store ---
  if (kind === 'loop') {
    fields.push(
      F('_bondPartner', 'i32[]', s => s.bondPartner),
      F('_bondPartnerEpoch', 'i32[]', s => s.bondPartnerEpoch),
      F('_bondRestLength', 'f64[]', s => s.bondRestLength),
      F('_bondStiffness', 'f64[]', s => s.bondStiffness),
      F('_bondTypeLabel', 'i32[]', s => s.bondTypeLabel),
      F('maxBonds', 'scalar', s => s.maxBonds),
      F('_bondFormReq', 'i32[]', s => s.bondFormReq),
      F('_bondFormL', 'f64[]', s => s.bondFormL),
      F('_bondFormK', 'f64[]', s => s.bondFormK),
      F('_bondBreakReq', 'i32[]', s => s.bondBreakReq),
    );
    // P2 — USER BOND ATTRIBUTES: the ragged read/write region per attribute, then
    // the per-agent Form-Bond initial-value request cell per attribute. Both
    // blocks are EMPTY when the model has none (or Bonds is off), so every pre-P2
    // loop signature is byte-identical.
    for (const a of bondAttrs) fields.push(F(`_bondAttr_${a.id}`, 'obj', s => s.bondAttrs[a.id]));
    for (const a of bondAttrs) fields.push(F(`_bondFormAttr_${a.id}`, 'f64[]', s => s.bondFormAttrs[a.id]));
  } else if (kind === 'division') {
    // Division's smaller bond slice (For Each Bond over inherited bonds).
    fields.push(
      F('_bondPartner', 'i32[]', s => s.bondPartner),
      F('_bondRestLength', 'f64[]', s => s.bondRestLength),
      F('_bondPartnerEpoch', 'i32[]', s => s.bondPartnerEpoch),
      F('maxBonds', 'scalar', s => s.maxBonds),
    );
    // P2 — the division event reads/writes bond attributes too (a daughter can
    // inspect the bonds it inherited; P5 will assign them). NO `_bondFormAttr_`
    // block: the division ABI carries no `_bondFormReq`, so Form Bond is not
    // usable there in the first place.
    for (const a of bondAttrs) fields.push(F(`_bondAttr_${a.id}`, 'obj', s => s.bondAttrs[a.id]));
  }

  // --- user agent attributes (r_ read block, then w_ write block) ---
  for (const a of agentAttrs) {
    const id = a.id;
    fields.push(F(`r_${id}`, 'obj', s => s.attrRead[id]));
  }
  for (const a of agentAttrs) {
    const id = a.id;
    // Division's w_ block ALIASES attrRead (immediate writes in the sequential
    // structural phase); loop + init use attrWrite.
    if (kind === 'division') fields.push(F(`w_${id}`, 'obj', s => s.attrRead[id]));
    else fields.push(F(`w_${id}`, 'obj', s => s.attrWrite[id]));
  }

  // --- globals / rng / stop / glyph / sprites ---
  fields.push(
    F('modelAttrs', 'obj', (_s, rt) => rt.modelAttrs),
    F('colors', 'clamped[]', s => s.colors),
    F('activeViewer', 'obj', (_s, rt) => rt.viewer),
    F('_indicators', 'obj', (_s, rt) => rt.indicators),
    F('_rngState', 'obj', (_s, rt) => rt.rngState),
    F('_stopFlag', 'obj', (_s, rt) => rt.stopFlag),
    F('glyphCodes', 'obj', (_s, rt) => rt.glyphCodes),
    F('glyphColors', 'obj', (_s, rt) => rt.glyphColors),
    F('spriteIds', 'i32[]', s => s.spriteIds),
    F('spriteFrames', 'f64[]', s => s.spriteFrames),
    F('spriteSpeeds', 'f64[]', s => s.spriteSpeeds),
    F('spriteRotations', 'f64[]', s => s.spriteRotations),
    F('spriteScales', 'f64[]', s => s.spriteScales),
  );

  // --- lookup tables (pinned slot after glyphColors, before the field block) ---
  if (hasLookupTables) fields.push(F('_lookupTables', 'obj', (_s, rt) => rt.lookupTables));

  // --- closed feedback: field grid dims + the agent-accessible cell field arrays ---
  fields.push(
    F('_fieldW', 'scalar', (_s, rt) => rt.width),
    F('_fieldH', 'scalar', (_s, rt) => rt.height),
    F('_fieldTotal', 'scalar', (_s, rt) => rt.total),
    F('_fieldBoundaryTorus', 'scalar', (_s, rt) => (rt.torus ? 1 : 0)),
  );
  for (const a of fieldAttrs) {
    const id = a.id;
    fields.push(F(`_field_${id}`, 'obj', (_s, rt) => rt.fieldArray(id)));
  }

  // --- init trailing seed base (before the 3D block) ---
  if (kind === 'init') fields.push(F('_agentSeedBase', 'scalar', (_s, rt) => rt.seedBase));

  // --- trailing 3D block (byte-identical omission in 2D) ---
  if (is3d) {
    if (kind === 'loop') {
      fields.push(
        F('_agentZ', 'f64[]', s => s.z),
        F('_agentVZ', 'f64[]', s => s.vz),
        F('_agentForceZ', 'f64[]', s => s.forceZ),
        F('_divideAxisZ', 'f64[]', s => s.divideAxisZ),
        F('_fieldD', 'scalar', s => s.worldDepth),
        F('_hashNBinsZ', 'scalar', (_s, rt) => (rt.hash ? rt.hash.nBinsZ : 1)),
        F('_hashBinSizeZ', 'scalar', (_s, rt) => (rt.hash ? rt.hash.binSizeZ : 1)),
        F('_hashOriginZ', 'scalar', (_s, rt) => (rt.hash ? rt.hash.originZ : 0)),
      );
    } else if (kind === 'division') {
      // NO forceZ (division reads forces, never writes them).
      fields.push(
        F('_agentZ', 'f64[]', s => s.z),
        F('_agentVZ', 'f64[]', s => s.vz),
        F('_divideAxisZ', 'f64[]', s => s.divideAxisZ),
        F('_fieldD', 'scalar', s => s.worldDepth),
      );
    } else {
      // init: only `_agentZ` (Set Agent Position's z write).
      fields.push(F('_agentZ', 'f64[]', s => s.z));
    }
  }

  // --- L2: the generation scalar, appended AFTER the 3D block (i.e. dead last on
  // every kind) so a graph that doesn't read it keeps its historical signature.
  // See the `usesGeneration` note on AgentAbiShape for why this is the one field
  // whose param side is gated while its arg side is not.
  if (shape.usesGeneration) fields.push(F('_generation', 'scalar', (_s, rt) => rt.generation ?? 0));

  return fields;
}

/** The PARAM name string for a function kind (feeds `new Function(params, body)`). */
export function buildAgentAbiParams(kind: AgentAbiKind, shape: AgentAbiShape, profile?: AgentCapabilities): string {
  return deriveAgentAbi(kind, shape, profile).map(f => f.name).join(', ');
}

/** The ARG value array for a function kind — resolved from the store + runtime,
 *  in the SAME order as the params (both iterate `deriveAgentAbi`, so they can't
 *  desync). Used by BOTH the worker and the parity harness. */
export function buildAgentAbiArgs(kind: AgentAbiKind, shape: AgentAbiShape, s: AgentStore, rt: AgentAbiRuntime, profile?: AgentCapabilities): unknown[] {
  return deriveAgentAbi(kind, shape, profile).map(f => f.get(s, rt));
}
