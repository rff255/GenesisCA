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
import { normalizeFieldGates, type AgentFieldGates } from '../../../model/agentFieldGating';

/** The agent function kinds that share this ABI.
 *  - `loop`     — the per-agent behaviour step (+ every agent Output Mapping pass).
 *  - `division` — the Division Event: a SINGLE-agent fn run per daughter.
 *  - `init`     — the Agent Init Event: a once-per-reset setup fn (no `idx`).
 *  - `input`    — an Agent INPUT Mapping (C→A): a SINGLE-agent fn run once per
 *                 PAINTED agent. Structurally the division kind minus the
 *                 daughter-specific leading scalars: it leads with `idx`, its
 *                 `w_` block ALIASES `attrRead` (a paint is a sequential mutation
 *                 BETWEEN steps, so a write must land on the live buffer — under
 *                 sync agent mode `primeAgentAttrWrite` copies attrRead→attrWrite
 *                 at the top of the next step, so writing attrWrite would be
 *                 silently discarded), and it gets no hash / request / spawn
 *                 buffers (a paint gesture does not query neighbours or mutate
 *                 topology). The brush colour rides three LEADING params the
 *                 compiler adds outside this descriptor (`_r, _g, _b`), exactly
 *                 like the cell `inputColor` signature.
 *
 *                 It DOES carry the grow-only spawn closures + the `_killRequest`
 *                 lane, so an editor brush can add agents AROUND the one it
 *                 painted and remove agents — the two lifecycle verbs the user
 *                 expects a brush that "edits the agents it covers" to have. The
 *                 kill flags are DRAINED IMMEDIATELY by the paint handler (a
 *                 paint is a user gesture between generations; deferring the
 *                 death to the next structural phase would mean "I clicked erase
 *                 and nothing happened until I pressed Play").
 *  - `spawner`  — an Agent INPUT Mapping whose brush KIND is `spawner`: a
 *                 once-per-BRUSH-APPLICATION fn with NO self (no `idx`), which
 *                 receives the brush's world position + radius and creates the
 *                 agents itself. Structurally the `init` kind PLUS the brush
 *                 block (`_brushX`, `_brushY`, `_brushRadius`, and `_brushZ` in
 *                 the trailing 3D block) + `_killRequest` — i.e. removing those
 *                 from `spawner` yields exactly `init`. */
export type AgentAbiKind = 'loop' | 'division' | 'init' | 'input' | 'spawner';

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
  /** C9 / STEP 4 — which OPTIONAL per-agent SoA field groups this model allocates
   *  (`resolveAgentFieldGates(model)`). A gated-OFF group's params are DROPPED
   *  from every kind, and the compilers emit the typed default (0) for a read of
   *  the corresponding field. ABSENT ⇒ everything on ⇒ byte-identical to pre-C9.
   *  The sprite block is the big one (5 params, 36 B/agent) and is the ONLY group
   *  that costs no baked byte on any target — it is plain JS arrays. */
  gates?: AgentFieldGates;
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
  // --- spawner-brush extras (the brush's world geometry) ---
  brushX?: number; brushY?: number; brushZ?: number; brushRadius?: number;
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
  // C9 / STEP 4 — the optional field groups. Absent ⇒ all on ⇒ the pre-C9 param
  // list, byte-for-byte. (Deliberately NOT the `gate(profile)` hook below: the
  // SHAPE is the gate, exactly as P2's bond block established — every call site
  // already produces a shape, and none produces a profile.)
  const gates = normalizeFieldGates(shape.gates);
  const fields: AgentAbiField[] = [];
  /** The SINGLE-agent kinds: they take a leading `idx` and their `w_` block
   *  aliases `attrRead` (immediate writes in a sequential, between-steps pass).
   *  `input` is `division` minus the daughter scalars — every branch below that
   *  reads `division` for that reason reads this instead, so the two can never
   *  drift apart. */
  const singleAgent = kind === 'division' || kind === 'input';
  /** The two once-per-gesture / once-per-reset SETUP kinds: no `idx`, no loop
   *  control, and they lead with the grow-only spawn closures. `spawner` is
   *  `init` plus the brush block. */
  const setupKind = kind === 'init' || kind === 'spawner';

  // --- leading positional args (division / input / init / spawner) ---
  if (singleAgent) {
    fields.push(F('idx', 'scalar', (_s, rt) => rt.idx));
    if (kind === 'division') {
      fields.push(
        F('__daughterIndex', 'scalar', (_s, rt) => rt.daughterIndex),
        F('__axisDefaultX', 'scalar', (_s, rt) => rt.axisX),
        F('__axisDefaultY', 'scalar', (_s, rt) => rt.axisY),
      );
    }
  }
  if (setupKind || kind === 'input') {
    // The grow-only Create Agent / Add Agent To World host closures + the by-id
    // setters' range guard. On `input` they let an EDITOR brush spawn agents
    // around the one it painted (the unified-spawning idiom, the same closures
    // the behaviour graph gets); on `init`/`spawner` they are the whole point.
    fields.push(
      F('_agentCreate', 'fn', (_s, rt) => rt.agentCreate),
      F('_agentAddToWorld', 'fn', (_s, rt) => rt.agentAddToWorld),
      F('_agentMaxAgents', 'scalar', s => s.maxAgents),
    );
  }
  if (kind === 'input' || kind === 'spawner') {
    // Kill Agent's request lane. DRAINED IMMEDIATELY by the paint handler (see
    // the `input` note on AgentAbiKind) rather than at the next generation's
    // structural phase.
    fields.push(F('_killRequest', 'u8[]', s => s.killRequest));
  }
  if (kind === 'spawner') {
    // The brush's world geometry — what the rule distributes agents by. `_brushZ`
    // rides the TRAILING 3D block (the "2D is a strict prefix of 3D" invariant
    // `audit-agent-layout` asserts), not here.
    fields.push(
      F('_brushX', 'scalar', (_s, rt) => rt.brushX ?? 0),
      F('_brushY', 'scalar', (_s, rt) => rt.brushY ?? 0),
      F('_brushRadius', 'scalar', (_s, rt) => rt.brushRadius ?? 0),
    );
  }

  // --- liveness + loop control (loop / single-agent carry it; init doesn't loop) ---
  if (kind === 'loop' || singleAgent) {
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
  );
  if (gates.targetRadius) fields.push(F('_agentTargetRadius', 'f64[]', s => s.targetRadius));
  if (gates.age) fields.push(F('_agentAge', 'f64[]', s => s.age));
  fields.push(F('_agentLineage', 'i32[]', s => s.lineage));
  // init omits bondCount/density (its writable geometry set is smaller).
  // `_agentBondCount` is a CORE reduction and stays even with Bonds off (B1a).
  if (kind === 'loop' || singleAgent) {
    fields.push(F('_agentBondCount', 'i32[]', s => s.bondCount));
    if (gates.density) fields.push(F('_agentDensity', 'f64[]', s => s.density));
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
  } else if (singleAgent) {
    // The single-agent kinds' smaller bond slice (For Each Bond over this agent's bonds).
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
    if (singleAgent) fields.push(F(`w_${id}`, 'obj', s => s.attrRead[id]));
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
  );
  // C9 — the SPRITE block. 5 params / 36 B per agent. These are the JS ABI half;
  // the same gate also reserves the WASM sprite region and the five GPU
  // `AGENT_GPU_SPRITE_FIELDS` runs (both appended last), so `setAgentSprite` emits
  // on every agent target and dropping the group is a clean ABI + allocation win.
  if (gates.sprites) {
    fields.push(
      F('spriteIds', 'i32[]', s => s.spriteIds),
      F('spriteFrames', 'f64[]', s => s.spriteFrames),
      F('spriteSpeeds', 'f64[]', s => s.spriteSpeeds),
      F('spriteRotations', 'f64[]', s => s.spriteRotations),
      F('spriteScales', 'f64[]', s => s.spriteScales),
    );
  }

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

  // --- setup-kind trailing seed base (before the 3D block). For `spawner` it is
  // highWater at the start of THIS brush application — the same "index base" the
  // Init Event exposes, so a spawner can number the agents it creates. ---
  if (setupKind) fields.push(F('_agentSeedBase', 'scalar', (_s, rt) => rt.seedBase));

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
    } else if (singleAgent) {
      // NO forceZ (a single-agent pass reads forces, never writes them).
      fields.push(
        F('_agentZ', 'f64[]', s => s.z),
        F('_agentVZ', 'f64[]', s => s.vz),
        F('_divideAxisZ', 'f64[]', s => s.divideAxisZ),
        F('_fieldD', 'scalar', s => s.worldDepth),
      );
    } else {
      // init / spawner: `_agentZ` (Set Agent Position's z write), then — spawner
      // only — the brush's z. The brush block's z rides HERE, not with its x/y,
      // so 2D stays a strict PREFIX of 3D (the `audit-agent-layout` invariant).
      fields.push(F('_agentZ', 'f64[]', s => s.z));
      if (kind === 'spawner') fields.push(F('_brushZ', 'scalar', (_s, rt) => rt.brushZ ?? 0));
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
