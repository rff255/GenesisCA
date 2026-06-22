// ===========================================================================
// Bond-Graph Agents — the co-resident agent engine (JS reference, v1).
//
// A SECOND engine the sim worker owns alongside the lattice CA. Agents are
// floating, continuous-position "cells": a maxAgents-length Structure-of-Arrays
// (free-list-holed + alive-mask + highWater loop bound), a persistent ragged
// bond store, a per-step force-integration driver (PR-A3), and a post-step
// structural phase (division/growth/death — PR-C). This module owns the data
// structures + allocation + seeding + serialization; the worker drives it and
// bridges it to the grid field (PR-D).
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
import { cbNum } from '../../model/centerBased';

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

/** A user agent-attribute definition (the non-model cell attributes double as
 *  agent attributes; each carries its id + runtime type + default value). */
export interface AgentAttrSpec { id: string; type: string; defaultValue: number }

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
  type: Int32Array; lineage: Int32Array;

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

  // --- request buffers the graph writes (validated + applied post-step; PR-B/C/D) ---
  divideRequest: Uint8Array;
  divideAxisX: Float64Array;
  divideAxisY: Float64Array;
  /** z component of the requested division axis (3D; transient, always-allocated,
   *  NOT serialized — like `divideRequest`/`divideAxisX`). 2D-ZERO in 2D. */
  divideAxisZ: Float64Array;
  divideAsym: Float64Array;
  killRequest: Uint8Array;
  /** Form-bond request: partner id + 1 (0 = none), with the rest length L and
   *  stiffness λ to use. One form request per agent per step (most rules form one
   *  bond/step; repeated steps form more). */
  bondFormReq: Int32Array;
  bondFormL: Float64Array;
  bondFormK: Float64Array;
  /** Break-bond request: partner id + 1 (0 = none). */
  bondBreakReq: Int32Array;

  // --- per-agent RGBA appearance (written by the agent colour pass; PR-A3) ---
  colors: Uint8ClampedArray;

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
}

/** Allocate the agent store once from the model's center-based config + agent
 *  attribute specs. All arrays are plain JS typed arrays (agents are JS-only in
 *  v1 — they sidestep the wasmMemory-view discipline; the Phase F WASM port
 *  bakes them as views). */
export function createAgentStore(config: CenterBasedConfig, attrSpecs: AgentAttrSpec[]): AgentStore {
  const maxAgents = Math.max(1, Math.floor(cbNum(config, 'maxAgents')));
  const maxBonds = Math.max(1, Math.floor(cbNum(config, 'maxBonds')));
  const worldWidth = cbNum(config, 'worldWidth');
  const worldHeight = cbNum(config, 'worldHeight');

  const attrRead: Record<string, AgentTypedArray> = {};
  const attrWrite: Record<string, AgentTypedArray> = {};
  const attrKind: Record<string, AgentAttrKind> = {};
  for (const spec of attrSpecs) {
    const kind = agentAttrKind(spec.type);
    attrKind[spec.id] = kind;
    const r = makeArray(kind, maxAgents);
    if (spec.defaultValue !== 0) r.fill(spec.defaultValue);
    attrRead[spec.id] = r;
    // SINGLE buffer for agent attributes: an agent reads + writes only its OWN
    // attrs (no neighbour-attr reads in the agent graph), so write aliases read
    // — an own-agent read-modify-write sees its write immediately, the natural
    // imperative semantics. (Positions ARE double-buffered for synchronous force
    // integration; that's separate, engine-owned x/y ↔ xNext/yNext.)
    attrWrite[spec.id] = r;
  }

  const bondPartner = new Int32Array(maxAgents * maxBonds).fill(-1);

  return {
    config, maxAgents, maxBonds, worldWidth, worldHeight,
    // worldDepth placeholder — initAgents overwrites it with the grid `depth`
    // local (the 3D predicate). Do NOT read config.worldDepth here (S6): the
    // dormant CenterBasedConfig.worldDepth stays ignored — reading it reintroduces
    // the exact baked/passed desync B2 warns against.
    worldDepth: 1,
    x: new Float64Array(maxAgents),
    y: new Float64Array(maxAgents),
    z: new Float64Array(maxAgents),
    xNext: new Float64Array(maxAgents),
    yNext: new Float64Array(maxAgents),
    zNext: new Float64Array(maxAgents),
    vx: new Float64Array(maxAgents),
    vy: new Float64Array(maxAgents),
    vz: new Float64Array(maxAgents),
    forceX: new Float64Array(maxAgents),
    forceY: new Float64Array(maxAgents),
    forceZ: new Float64Array(maxAgents),
    radius: new Float64Array(maxAgents),
    targetRadius: new Float64Array(maxAgents),
    age: new Float64Array(maxAgents),
    type: new Int32Array(maxAgents),
    lineage: new Int32Array(maxAgents),
    alive: new Uint8Array(maxAgents),
    epoch: new Int32Array(maxAgents),
    bondCount: new Int32Array(maxAgents),
    density: new Float64Array(maxAgents),
    bondPartner,
    bondPartnerEpoch: new Int32Array(maxAgents * maxBonds),
    bondRestLength: new Float64Array(maxAgents * maxBonds),
    bondStiffness: new Float64Array(maxAgents * maxBonds),
    bondTypeLabel: new Int32Array(maxAgents * maxBonds),
    divideRequest: new Uint8Array(maxAgents),
    divideAxisX: new Float64Array(maxAgents),
    divideAxisY: new Float64Array(maxAgents),
    divideAxisZ: new Float64Array(maxAgents),
    divideAsym: new Float64Array(maxAgents),
    killRequest: new Uint8Array(maxAgents),
    bondFormReq: new Int32Array(maxAgents),
    bondFormL: new Float64Array(maxAgents),
    bondFormK: new Float64Array(maxAgents),
    bondBreakReq: new Int32Array(maxAgents),
    colors: new Uint8ClampedArray(maxAgents * 4),
    attrSpecs,
    attrRead, attrWrite, attrKind,
    highWater: 0,
    liveCount: 0,
    freeList: new Int32Array(maxAgents),
    freeTop: 0,
    dt: cbNum(config, 'timeStep'),
  };
}

/** A small, distinguishable default palette so agents of different `type` are
 *  visible before any colour pass runs (Reset / pre-A3). */
const AGENT_PALETTE: Array<[number, number, number]> = [
  [76, 201, 240], [240, 113, 103], [120, 224, 143], [240, 196, 84],
  [197, 137, 232], [95, 209, 199], [240, 150, 196], [180, 180, 180],
];
export function defaultAgentColor(type: number): [number, number, number] {
  return AGENT_PALETTE[((type % AGENT_PALETTE.length) + AGENT_PALETTE.length) % AGENT_PALETTE.length]!;
}

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
  x: number, y: number, z: number, radius: number, type: number, lineage: number,
): void {
  store.x[id] = x; store.y[id] = y; store.z[id] = z;
  store.xNext[id] = x; store.yNext[id] = y; store.zNext[id] = z;
  store.vx[id] = 0; store.vy[id] = 0; store.vz[id] = 0;
  store.forceZ[id] = 0;
  store.radius[id] = radius; store.targetRadius[id] = radius;
  store.age[id] = 0;
  store.type[id] = type; store.lineage[id] = lineage;
  store.bondCount[id] = 0;
  store.density[id] = 0;
  store.divideRequest[id] = 0; store.killRequest[id] = 0;
  for (const spec of store.attrSpecs) {
    store.attrRead[spec.id]![id] = spec.defaultValue;
    store.attrWrite[spec.id]![id] = spec.defaultValue;
  }
  const [r, g, b] = defaultAgentColor(type);
  const c = id * 4;
  store.colors[c] = r; store.colors[c + 1] = g; store.colors[c + 2] = b; store.colors[c + 3] = 255;
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
  store.bondFormReq[id] = 0; store.bondBreakReq[id] = 0;
  store.freeList[store.freeTop++] = id;
  store.liveCount--;
}

/** Seed N agents. Each spec gives a position (+ optional radius/type/lineage);
 *  attributes initialise to their defaults. Returns the ids actually created
 *  (short of `specs.length` if the ceiling is hit — the worker surfaces that). */
export interface AgentSeedSpec { x: number; y: number; z?: number; radius?: number; type?: number; lineage?: number }
export function seedAgents(store: AgentStore, specs: AgentSeedSpec[], defaultRadius: number): number[] {
  const ids: number[] = [];
  for (const s of specs) {
    const id = allocAgentSlot(store);
    if (id < 0) break; // ceiling
    initAgentSlot(store, id, s.x, s.y, s.z ?? 0, s.radius ?? defaultRadius, s.type ?? 0, s.lineage ?? id);
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

export interface AgentRenderSnapshot {
  highWater: number;
  liveCount: number;
  x: Float64Array;
  y: Float64Array;
  /** z (3D agents). Sliced only in 3D (`worldDepth > 1`); in 2D it's a length-0
   *  placeholder so the renderer draws at z=0 with no per-step alloc/transfer
   *  regression (A1 — vx/vy already pay that cost; z/vz don't need to in 2D). */
  z: Float64Array;
  /** Velocity (for heading indicators / flocking diagnostics). */
  vx: Float64Array;
  vy: Float64Array;
  /** z velocity (3D; length-0 placeholder in 2D — see `z`). */
  vz: Float64Array;
  radius: Float64Array;
  alive: Uint8Array;
  colors: Uint8ClampedArray;
  type: Int32Array;
  /** Flat [a, b, a, b, …] live bond index pairs (empty when no bonds). */
  bonds: Int32Array;
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

/** Add a bond slot to agent `a`'s list pointing at `b`. Internal (one direction). */
function addBondSlot(store: AgentStore, a: number, b: number, L: number, lambda: number, typeLabel: number): boolean {
  const n = store.bondCount[a]!;
  if (n >= store.maxBonds) return false; // overflow → reject
  const base = a * store.maxBonds + n;
  store.bondPartner[base] = b;
  store.bondPartnerEpoch[base] = store.epoch[b]!;
  store.bondRestLength[base] = L;
  store.bondStiffness[base] = lambda;
  store.bondTypeLabel[base] = typeLabel;
  store.bondCount[a] = n + 1;
  return true;
}

/** Form a symmetric bond a↔b. No-op (returns false) if already bonded, self, a
 *  dead agent, or EITHER list is full (atomic — neither side is half-added). */
export function formBond(store: AgentStore, a: number, b: number, L: number, lambda: number, typeLabel = 0): boolean {
  if (a === b || a < 0 || b < 0 || !store.alive[a] || !store.alive[b]) return false;
  if (hasBond(store, a, b)) return false;
  if (store.bondCount[a]! >= store.maxBonds || store.bondCount[b]! >= store.maxBonds) return false;
  addBondSlot(store, a, b, L, lambda, typeLabel);
  addBondSlot(store, b, a, L, lambda, typeLabel);
  return true;
}

/** Remove the bond slot pointing at `b` from `a`'s list (swap-remove). Internal. */
function removeBondSlot(store: AgentStore, a: number, b: number): boolean {
  const base = a * store.maxBonds;
  const n = store.bondCount[a]!;
  for (let k = 0; k < n; k++) {
    if (store.bondPartner[base + k] === b) {
      const last = n - 1;
      if (k !== last) {
        store.bondPartner[base + k] = store.bondPartner[base + last]!;
        store.bondPartnerEpoch[base + k] = store.bondPartnerEpoch[base + last]!;
        store.bondRestLength[base + k] = store.bondRestLength[base + last]!;
        store.bondStiffness[base + k] = store.bondStiffness[base + last]!;
        store.bondTypeLabel[base + k] = store.bondTypeLabel[base + last]!;
      }
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
        if (k !== last) {
          store.bondPartner[base + k] = store.bondPartner[base + last]!;
          store.bondPartnerEpoch[base + k] = store.bondPartnerEpoch[base + last]!;
          store.bondRestLength[base + k] = store.bondRestLength[base + last]!;
          store.bondStiffness[base + k] = store.bondStiffness[base + last]!;
          store.bondTypeLabel[base + k] = store.bondTypeLabel[base + last]!;
        }
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
 *  mother slot becomes daughter A; a free-list slot becomes daughter B. Each
 *  partner bond goes to the nearer daughter; a daughter-daughter bond is added
 *  when the mother was bonded (a free agent's daughters separate). Daughters
 *  inherit the mother's attributes verbatim (the divisionEvent graph can
 *  reassign them afterwards). */
export function divideAgent(
  store: AgentStore, i: number,
  axisX: number, axisY: number, axisZ: number, asym: number,
  defaultLambda: number, torus: boolean, W: number, H: number, D: number,
  outAxis?: number[],
): number {
  if (!store.alive[i]) return -1;
  const is3d = D > 1;
  const mb = store.maxBonds;
  const cx = store.x[i]!, cy = store.y[i]!, cz = store.z[i]!;
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
  for (let k = 0; k < n; k++) {
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
  const addDaughterBond = n > 0;
  // 3. capacity pre-check — reject the WHOLE division on overflow (A keeps its
  //    side + the daughter bond; B gets its side + the daughter bond).
  const aFinal = sideGE + (addDaughterBond ? 1 : 0);
  const bFinal = sideLT + (addDaughterBond ? 1 : 0);
  if (aFinal > mb || bFinal > mb) return -2;
  const newId = allocAgentSlot(store);
  if (newId < 0) return -1;

  // 4. geometry — split the area by asymmetry, place daughters along ±m̂
  const r = store.radius[i]!;
  const aFrac = Math.min(1, Math.max(0, asym));
  const rA = r * Math.sqrt(Math.max(1e-4, aFrac));
  const rB = r * Math.sqrt(Math.max(1e-4, 1 - aFrac));
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

  // 5. daughter B (new slot) — inherit mother's type/lineage/attrs/colour. z = bz
  // (the mother's z in 2D, the −½·off·m̂ offset in 3D).
  initAgentSlot(store, newId, bx, by, bz, rB, store.type[i]!, store.lineage[i]!);
  for (const spec of store.attrSpecs) {
    store.attrRead[spec.id]![newId] = store.attrRead[spec.id]![i]!;
  }
  store.targetRadius[newId] = store.targetRadius[i]!;
  for (let c = 0; c < 4; c++) store.colors[newId * 4 + c] = store.colors[i * 4 + c]!;

  // 6. daughter A — reuse mother slot i; shrink + relocate, reset age, clear request
  store.x[i] = ax; store.y[i] = ay; store.xNext[i] = ax; store.yNext[i] = ay;
  if (is3d) { store.z[i] = az; store.zNext[i] = az; }
  store.radius[i] = rA;
  store.age[i] = 0;
  store.divideRequest[i] = 0;

  // 7. reattach — move side-B partners' bonds from A(i) to B(newId)
  const snap: Array<{ p: number; L: number; lam: number; typ: number }> = [];
  for (let k = 0; k < n; k++) {
    snap.push({ p: store.bondPartner[base + k]!, L: store.bondRestLength[base + k]!, lam: store.bondStiffness[base + k]!, typ: store.bondTypeLabel[base + k]! });
  }
  for (let k = 0; k < n; k++) {
    if (!sides[k]) {
      const s = snap[k]!;
      breakBond(store, i, s.p);
      formBond(store, newId, s.p, s.L, s.lam, s.typ);
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
  binStart: Int32Array;   // length nBins+1 (prefix sums)
  binAgents: Int32Array;  // length liveCount (agent ids grouped by bin)
}

/** Per-store reusable scratch so the hash doesn't allocate every step. */
interface HashScratch { binStart: Int32Array; binAgents: Int32Array; cursor: Int32Array; }
const hashScratchMap = new WeakMap<AgentStore, HashScratch>();

export function buildSpatialHash(store: AgentStore, binSize: number, W: number, H: number, D: number): SpatialHash | null {
  const is3d = D > 1;
  const nBinsX = Math.floor(W / binSize);
  const nBinsY = Math.floor(H / binSize);
  // 3D adds a z-axis bin requirement: a shallow volume (D < 3·binSize → nBinsZ<3)
  // falls back to all-pairs even in a large W×H model (F1 — documented; PR7b
  // inherits the same threshold). nBinsZ stays 1 in 2D (no z-axis binning).
  const nBinsZ = is3d ? Math.floor(D / binSize) : 1;
  if (nBinsX < 3 || nBinsY < 3 || (is3d && nBinsZ < 3)) return null; // tiny world → all-pairs fallback
  const binSizeX = W / nBinsX, binSizeY = H / nBinsY; // exact tiling, ≥ binSize
  const binSizeZ = is3d ? D / nBinsZ : 1;
  const nBins = nBinsX * nBinsY * nBinsZ;
  const hw = store.highWater;

  let sc = hashScratchMap.get(store);
  if (!sc || sc.binStart.length < nBins + 1 || sc.binAgents.length < store.maxAgents) {
    sc = { binStart: new Int32Array(nBins + 1), binAgents: new Int32Array(store.maxAgents), cursor: new Int32Array(nBins) };
    hashScratchMap.set(store, sc);
  }
  const binStart = sc.binStart, binAgents = sc.binAgents, cursor = sc.cursor;
  binStart.fill(0, 0, nBins + 1);

  const x = store.x, y = store.y, z = store.z, alive = store.alive;
  // binOf — verbatim `by*nBinsX+bx` in 2D, z-major `(bz*nBinsY+by)*nBinsX+bx` in 3D.
  const binOf = is3d
    ? (i: number): number => {
        let bx = (x[i]! / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
        let by = (y[i]! / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
        let bz = (z[i]! / binSizeZ) | 0; if (bz < 0) bz = 0; else if (bz >= nBinsZ) bz = nBinsZ - 1;
        return (bz * nBinsY + by) * nBinsX + bx;
      }
    : (i: number): number => {
        let bx = (x[i]! / binSizeX) | 0; if (bx < 0) bx = 0; else if (bx >= nBinsX) bx = nBinsX - 1;
        let by = (y[i]! / binSizeY) | 0; if (by < 0) by = 0; else if (by >= nBinsY) by = nBinsY - 1;
        return by * nBinsX + bx;
      };
  // count → prefix sum → fill
  for (let i = 0; i < hw; i++) { if (!alive[i]) continue; binStart[binOf(i) + 1]!++; }
  for (let b = 0; b < nBins; b++) { binStart[b + 1]! += binStart[b]!; cursor[b] = binStart[b]!; }
  for (let i = 0; i < hw; i++) { if (!alive[i]) continue; const b = binOf(i); binAgents[cursor[b]!++] = i; }

  return { nBinsX, nBinsY, nBinsZ, binSizeX, binSizeY, binSizeZ, binStart, binAgents };
}

export function snapshotAgentsForRender(store: AgentStore): AgentRenderSnapshot {
  const hw = store.highWater;
  // A1: gate z/vz on worldDepth > 1 so 2D models pay NO extra per-step alloc/
  // transfer for the (always-zero) z arm. 2D → length-0 placeholders (renderer
  // reads z=0). 3D slices them like x/y/vx/vy.
  const is3d = store.worldDepth > 1;
  return {
    highWater: hw,
    liveCount: store.liveCount,
    x: store.x.slice(0, hw),
    y: store.y.slice(0, hw),
    z: is3d ? store.z.slice(0, hw) : new Float64Array(0),
    vx: store.vx.slice(0, hw),
    vy: store.vy.slice(0, hw),
    vz: is3d ? store.vz.slice(0, hw) : new Float64Array(0),
    radius: store.radius.slice(0, hw),
    alive: store.alive.slice(0, hw),
    colors: store.colors.slice(0, hw * 4),
    type: store.type.slice(0, hw),
    bonds: snapshotBonds(store),
  };
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
  /** z / z-velocity (3D agents). Always written when the store is 3D; absent on
   *  a legacy pre-z 2D save → `deserializeAgentStore` leaves z/vz at 0 (the
   *  `if (p.z)` additive-load guard). `worldDepth` is NOT serialized (re-derived
   *  from `gridDepth` on load). */
  z?: ArrayBuffer; vz?: ArrayBuffer;
  age: ArrayBuffer; type: ArrayBuffer; lineage: ArrayBuffer; alive: ArrayBuffer; epoch: ArrayBuffer;
  freeList: ArrayBuffer;
  bondCount: ArrayBuffer; bondPartner: ArrayBuffer; bondPartnerEpoch: ArrayBuffer;
  bondRestLength: ArrayBuffer; bondStiffness: ArrayBuffer; bondTypeLabel: ArrayBuffer;
  colors: ArrayBuffer;
  attrs: Record<string, { kind: AgentAttrKind; buffer: ArrayBuffer }>;
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
  const freeListCopy = store.freeList.slice(0, store.freeTop);
  transfers.push(freeListCopy.buffer);
  // z/vz: written only in 3D (worldDepth > 1) — a 2D save omits them and loads
  // back at z=0 via the deserialize `if (p.z)` guard, so 2D getState/.gcastate
  // pays no extra always-zero buffer (matches the snapshot A1 gate).
  const is3d = store.worldDepth > 1;
  return {
    highWater: hw, liveCount: store.liveCount, freeTop: store.freeTop, maxBonds: store.maxBonds,
    x: sl(store.x, hw), y: sl(store.y, hw), radius: sl(store.radius, hw), targetRadius: sl(store.targetRadius, hw),
    ...(is3d ? { z: sl(store.z, hw), vz: sl(store.vz, hw) } : {}),
    age: sl(store.age, hw), type: sl(store.type, hw), lineage: sl(store.lineage, hw),
    alive: sl(store.alive, hw), epoch: sl(store.epoch, hw),
    freeList: freeListCopy.buffer,
    bondCount: sl(store.bondCount, hw),
    bondPartner: sl(store.bondPartner, bw), bondPartnerEpoch: sl(store.bondPartnerEpoch, bw),
    bondRestLength: sl(store.bondRestLength, bw), bondStiffness: sl(store.bondStiffness, bw),
    bondTypeLabel: sl(store.bondTypeLabel, bw),
    colors: slColors(),
    attrs,
  };
}

/** Restore a snapshot INTO the existing store (copy-into, never reassign — the
 *  Phase F WASM port will view these over wasmMemory). Throws on a structural
 *  mismatch (maxBonds stride, overflow) so the loader can reject LOUDLY rather
 *  than silently mis-stride a ragged store. Returns nothing; mutates `store`. */
export function deserializeAgentStore(store: AgentStore, p: AgentStatePayload): void {
  if (p.maxBonds !== store.maxBonds) {
    throw new Error(`agent bond stride mismatch: saved maxBonds=${p.maxBonds}, model maxBonds=${store.maxBonds}`);
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
  // z/vz: additive-load guard (the grid's `depth ?? 1` discipline). A legacy
  // pre-z 2D save omits them → leave the freshly-allocated store's z/vz at 0.
  store.z.fill(0); store.vz.fill(0);
  if (p.z) copyInto(store.z, p.z, Float64Array as never);
  if (p.vz) copyInto(store.vz, p.vz, Float64Array as never);
  copyInto(store.radius, p.radius, Float64Array as never); copyInto(store.targetRadius, p.targetRadius, Float64Array as never);
  copyInto(store.age, p.age, Float64Array as never);
  copyInto(store.type, p.type, Int32Array as never); copyInto(store.lineage, p.lineage, Int32Array as never);
  copyInto(store.alive, p.alive, Uint8Array as never); copyInto(store.epoch, p.epoch, Int32Array as never);
  copyInto(store.bondCount, p.bondCount, Int32Array as never);
  copyInto(store.bondPartner, p.bondPartner, Int32Array as never);
  copyInto(store.bondPartnerEpoch, p.bondPartnerEpoch, Int32Array as never);
  copyInto(store.bondRestLength, p.bondRestLength, Float64Array as never);
  copyInto(store.bondStiffness, p.bondStiffness, Float64Array as never);
  copyInto(store.bondTypeLabel, p.bondTypeLabel, Int32Array as never);
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
