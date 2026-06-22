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

  // --- engine geometry (Float64) ---
  x: Float64Array; y: Float64Array;
  /** Position double-buffer (overdamped Euler reads x/y, writes xNext/yNext, swaps). */
  xNext: Float64Array; yNext: Float64Array;
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

  // --- request buffers the graph writes (validated + applied post-step; PR-C/D) ---
  divideRequest: Uint8Array;
  divideAxisX: Float64Array;
  divideAxisY: Float64Array;
  divideAsym: Float64Array;
  killRequest: Uint8Array;

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
    const w = makeArray(kind, maxAgents);
    if (spec.defaultValue !== 0) { r.fill(spec.defaultValue); w.fill(spec.defaultValue); }
    attrRead[spec.id] = r;
    attrWrite[spec.id] = w;
  }

  const bondPartner = new Int32Array(maxAgents * maxBonds).fill(-1);

  return {
    config, maxAgents, maxBonds, worldWidth, worldHeight,
    x: new Float64Array(maxAgents),
    y: new Float64Array(maxAgents),
    xNext: new Float64Array(maxAgents),
    yNext: new Float64Array(maxAgents),
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
    divideAsym: new Float64Array(maxAgents),
    killRequest: new Uint8Array(maxAgents),
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
  x: number, y: number, radius: number, type: number, lineage: number,
): void {
  store.x[id] = x; store.y[id] = y;
  store.xNext[id] = x; store.yNext[id] = y;
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
  store.alive[id] = 0;
  store.epoch[id] = (store.epoch[id]! + 1) | 0;
  store.bondCount[id] = 0;
  const base = id * store.maxBonds;
  for (let k = 0; k < store.maxBonds; k++) store.bondPartner[base + k] = -1;
  store.divideRequest[id] = 0; store.killRequest[id] = 0;
  store.freeList[store.freeTop++] = id;
  store.liveCount--;
}

/** Seed N agents. Each spec gives a position (+ optional radius/type/lineage);
 *  attributes initialise to their defaults. Returns the ids actually created
 *  (short of `specs.length` if the ceiling is hit — the worker surfaces that). */
export interface AgentSeedSpec { x: number; y: number; radius?: number; type?: number; lineage?: number }
export function seedAgents(store: AgentStore, specs: AgentSeedSpec[], defaultRadius: number): number[] {
  const ids: number[] = [];
  for (const s of specs) {
    const id = allocAgentSlot(store);
    if (id < 0) break; // ceiling
    initAgentSlot(store, id, s.x, s.y, s.radius ?? defaultRadius, s.type ?? 0, s.lineage ?? id);
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
  radius: Float64Array;
  alive: Uint8Array;
  colors: Uint8ClampedArray;
  type: Int32Array;
}

export function snapshotAgentsForRender(store: AgentStore): AgentRenderSnapshot {
  const hw = store.highWater;
  return {
    highWater: hw,
    liveCount: store.liveCount,
    x: store.x.slice(0, hw),
    y: store.y.slice(0, hw),
    radius: store.radius.slice(0, hw),
    alive: store.alive.slice(0, hw),
    colors: store.colors.slice(0, hw * 4),
    type: store.type.slice(0, hw),
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
  return {
    highWater: hw, liveCount: store.liveCount, freeTop: store.freeTop, maxBonds: store.maxBonds,
    x: sl(store.x, hw), y: sl(store.y, hw), radius: sl(store.radius, hw), targetRadius: sl(store.targetRadius, hw),
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
