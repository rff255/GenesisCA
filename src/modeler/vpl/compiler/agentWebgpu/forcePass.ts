// ===========================================================================
// PR7 / G3 — the WGSL AGENT FORCE PASS (hand-written engine code, the GPU
// sibling of the JS `runAgentStep` force loop + agentWasm's `emitForcePass`).
//
// A SECOND compute entry (`forcePass`) over the SAME GPU agent SoA the behaviour
// shader uses (agentWebgpu/layout.ts). It runs RIGHT AFTER the behaviour (same
// step), reusing the CPU-built spatial hash already uploaded for getNearbyAgents:
//   1. the 3×3 hash-stencil neighbour pass (soft-sphere repulsion/adhesion +
//      density), torus-wrapped, with an all-pairs fallback;
//   2. velocity Euler (momentum, maxSpeed, drag, dt);
//   3. position wrap/clamp into xNext/yNext (the GPU double-buffer);
//   4. age + the growth ramp toward targetRadius.
// The bond springs + structural phase + the hash BUILD stay CPU/JS (G4) — the GPU
// agent SoA carries no bond store. A graph with live bonds therefore stays on the
// JS/WASM agent target (the gate excludes bond/division/field nodes); for the
// Boids headline (no bonds, no division, no growth) this force pass is exact.
//
// 2D-ONLY (mirrors the behaviour shader's 2D Boids scope). f32 throughout —
// statistical parity vs JS/WASM's f64, NOT bit-exact (the documented WebGPU
// target constraint). The `bonding` flag (a control-uniform field) gates the
// soft-sphere force + the growth ramp, exactly like the JS `engineForces` /
// `growthRate` gates; density is always counted.
//
// HARD CONSTRAINT: like the behaviour compiler, this touches NO lattice/grid
// WebGPU code + NO existing agent JS/WASM path → byte-identity holds BY
// CONSTRUCTION.
// ===========================================================================

import type { AgentWebGPULayout } from './layout';

/** The ForceControl uniform — the per-step scalars the worker writes before the
 *  force dispatch (its own struct, separate from the behaviour's Control, so the
 *  two shaders stay decoupled). The field order MIRRORS the worker's write +
 *  `FORCE_PASS_PARAMS` (the WASM force-pass ABI) so the three force integrators
 *  read the same inputs. */
function emitForceControlStruct(): string {
  return `struct ForceControl {
  highWater  : u32,
  hashValid  : u32,
  nBinsX     : u32,
  nBinsY     : u32,
  bonding    : u32,
  torus      : u32,
  binSizeX   : f32,
  binSizeY   : f32,
  dtOverEta  : f32,
  muR        : f32,
  muA        : f32,
  range      : f32,
  momentum   : f32,
  maxSpeed   : f32,
  growthRate : f32,
  fieldW     : f32,
  fieldH     : f32,
};`;
}

/** Emit the standalone WGSL force-pass module for the given GPU agent layout.
 *  One invocation per agent slot (2-D dispatch tiling recovers the linear idx,
 *  the lattice pattern). Pure — no GPU calls. */
export function emitAgentForcePassWGSL(layout: AgentWebGPULayout): string {
  const f32 = (field: string, idxExpr: string): string => {
    const base = layout.f32Base[field]!;
    return base === 0 ? `agentF32[${idxExpr}]` : `agentF32[${base}u + ${idxExpr}]`;
  };
  const bsBase = layout.hashBinStartBase;
  const baBase = layout.hashBinAgentsBase;
  const binStartAt = (e: string) => (bsBase === 0 ? `hashBins[${e}]` : `hashBins[${bsBase}u + ${e}]`);
  const binAgentsAt = (e: string) => (baBase === 0 ? `hashBins[${e}]` : `hashBins[${baBase}u + ${e}]`);

  // The per-neighbour body (candidate id `j`): torus-fold the displacement, skip
  // self / out-of-range, bump density, add the soft-sphere force when bonding.
  const neighbourBody = `
    if (j != i && agentAlive[j] != 0u) {
      var dx: f32 = ${f32('x', 'j')} - xi;
      var dy: f32 = ${f32('y', 'j')} - yi;
      if (fc.torus != 0u) {
        if (dx > hW) { dx = dx - fc.fieldW; } else if (dx < -hW) { dx = dx + fc.fieldW; }
        if (dy > hH) { dy = dy - fc.fieldH; } else if (dy < -hH) { dy = dy + fc.fieldH; }
      }
      let d2: f32 = dx * dx + dy * dy;
      let sij: f32 = ri + ${f32('radius', 'j')};
      let rmax: f32 = fc.range * sij;
      if (d2 != 0.0 && d2 < rmax * rmax) {
        dens = dens + 1.0;
        if (fc.bonding != 0u) {
          let d: f32 = sqrt(d2);
          let mu: f32 = select(fc.muA, fc.muR, d < sij);
          let F: f32 = mu * (d - sij);
          let k: f32 = F / d;
          fx = fx + k * dx; fy = fy + k * dy;
        }
      }
    }`;

  return `${emitForceControlStruct()}

@group(0) @binding(0) var<storage, read_write> agentF32   : array<f32>;
@group(0) @binding(1) var<storage, read>       agentAlive : array<u32>;
@group(0) @binding(2) var<storage, read>       hashBins   : array<i32>;
@group(0) @binding(3) var<uniform>             fc         : ForceControl;

@compute @workgroup_size(64)
fn forcePass(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i: u32 = gid.y * (nwg.x * 64u) + gid.x;
  if (i >= fc.highWater) { return; }
  if (agentAlive[i] == 0u) {
    // dead slot: carry the position forward unchanged (JS parity: xN[i]=x[i]).
    ${f32('xNext', 'i')} = ${f32('x', 'i')};
    ${f32('yNext', 'i')} = ${f32('y', 'i')};
    return;
  }

  let xi: f32 = ${f32('x', 'i')};
  let yi: f32 = ${f32('y', 'i')};
  let ri: f32 = ${f32('radius', 'i')};
  let hW: f32 = fc.fieldW * 0.5;
  let hH: f32 = fc.fieldH * 0.5;

  // Start from the graph-authored force (Apply Force wrote it this step).
  var fx: f32 = ${f32('forceX', 'i')};
  var fy: f32 = ${f32('forceY', 'i')};
  var dens: f32 = 0.0;

  if (fc.hashValid != 0u) {
    // --- 3×3 hash-bin stencil over the CSR hash, torus-wrapped ---
    var bx: i32 = i32(xi / fc.binSizeX);
    bx = clamp(bx, 0, i32(fc.nBinsX) - 1);
    var by: i32 = i32(yi / fc.binSizeY);
    by = clamp(by, 0, i32(fc.nBinsY) - 1);
    for (var ey: i32 = -1; ey <= 1; ey = ey + 1) {
    for (var ex: i32 = -1; ex <= 1; ex = ex + 1) {
      var nbx: i32 = bx + ex;
      var nby: i32 = by + ey;
      var skip: bool = false;
      if (fc.torus != 0u) {
        nbx = ((nbx % i32(fc.nBinsX)) + i32(fc.nBinsX)) % i32(fc.nBinsX);
        nby = ((nby % i32(fc.nBinsY)) + i32(fc.nBinsY)) % i32(fc.nBinsY);
      } else {
        if (nbx < 0 || nbx >= i32(fc.nBinsX) || nby < 0 || nby >= i32(fc.nBinsY)) { skip = true; }
      }
      if (!skip) {
        let b: i32 = nby * i32(fc.nBinsX) + nbx;
        let pStart: i32 = ${binStartAt('u32(b)')};
        let pEnd: i32 = ${binStartAt('u32(b) + 1u')};
        for (var p: i32 = pStart; p < pEnd; p = p + 1) {
          let j: u32 = u32(${binAgentsAt('u32(p)')});${neighbourBody}
        }
      }
    } }
  } else {
    // --- all-pairs fallback (a world too small to tile) ---
    for (var j: u32 = 0u; j < fc.highWater; j = j + 1u) {${neighbourBody}
    }
  }
  ${f32('density', 'i')} = dens;

  // Integrate: v = momentum·v + (dt/eta)·F; optional speed cap; x += v; wrap/clamp.
  var vxi: f32 = fc.momentum * ${f32('vx', 'i')} + fc.dtOverEta * fx;
  var vyi: f32 = fc.momentum * ${f32('vy', 'i')} + fc.dtOverEta * fy;
  if (fc.maxSpeed > 0.0) {
    let sp: f32 = sqrt(vxi * vxi + vyi * vyi);
    if (sp > fc.maxSpeed) { let sc: f32 = fc.maxSpeed / sp; vxi = vxi * sc; vyi = vyi * sc; }
  }
  ${f32('vx', 'i')} = vxi;
  ${f32('vy', 'i')} = vyi;

  var nx: f32 = xi + vxi;
  var ny: f32 = yi + vyi;
  if (fc.torus != 0u) {
    nx = ((nx % fc.fieldW) + fc.fieldW) % fc.fieldW;
    ny = ((ny % fc.fieldH) + fc.fieldH) % fc.fieldH;
  } else {
    nx = clamp(nx, 0.0, fc.fieldW);
    ny = clamp(ny, 0.0, fc.fieldH);
  }
  ${f32('xNext', 'i')} = nx;
  ${f32('yNext', 'i')} = ny;
  ${f32('age', 'i')} = ${f32('age', 'i')} + 1.0;

  // Growth ramp toward targetRadius (no-op when growthRate==0, e.g. boids).
  let tr: f32 = ${f32('targetRadius', 'i')};
  let cur: f32 = ${f32('radius', 'i')};
  if (tr != cur && fc.growthRate > 0.0) {
    let dd: f32 = tr - cur;
    ${f32('radius', 'i')} = select(cur + sign(dd) * fc.growthRate, tr, abs(dd) <= fc.growthRate);
  }
}
`;
}
