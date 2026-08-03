// ===========================================================================
// PR7 / G3 — the WGSL AGENT FORCE PASS (hand-written engine code, the GPU
// sibling of the JS `runAgentStep` force loop + agentWasm's `emitForcePass`).
//
// A SECOND compute entry (`forcePass`) over the SAME GPU agent SoA the behaviour
// shader uses (agentWebgpu/layout.ts). It runs RIGHT AFTER the behaviour (same
// step), reusing the CPU-built spatial hash already uploaded for getNearbyAgents:
//   1. the 3×3[×3] hash-stencil neighbour pass (soft-sphere repulsion/adhesion +
//      density), torus-wrapped, with an all-pairs fallback;
//   2. velocity Euler (momentum, maxSpeed, drag, dt);
//   3. position wrap/clamp into xNext/yNext[/zNext] (the GPU double-buffer);
//   4. age + the growth ramp toward targetRadius.
// The structural phase (bonds / division / death) + the hash BUILD stay CPU/JS
// (target-independent — the worker round-trips the structural request flags and
// runs runAgentStructuralPhase after the readback).
//
// 2D AND 3D aware (the z fields append when gridDepth > 1). f32 throughout —
// statistical parity vs JS/WASM's f64, NOT bit-exact (the documented WebGPU
// target constraint). The soft-sphere runs when `bonding || doCollision`: the
// REPULSION half (d<sij volume exclusion = collision) is gated on the Collision
// capability's `doCollision`, the ADHESION half (d>=sij cohesion) on `bonding`;
// the growth ramp is gated on `growthRate > 0` (bonding-driven). The neighbour
// scan (+ density count) runs only when `bonding || doCollision || doDensity` —
// a custom-force model with no density consumer skips it entirely (P1).
// Mirrors the JS `engineForces`/`doCollision`/`doDensity`/`growthRate` gates.
//
// HARD CONSTRAINT: like the behaviour compiler, this touches NO lattice/grid
// WebGPU code + NO existing agent JS/WASM path → byte-identity holds BY
// CONSTRUCTION.
// ===========================================================================

import type { AgentWebGPULayout } from './layout';

// ===========================================================================
// B1 — the bin-sorted MIRROR (the resident force pass's coalesced neighbour scan).
//
// The resident hash build scatters a field-major mirror of the fields the force
// scan reads for NEIGHBOURS, in CSR (bin) order, plus a `sortedId` array. The
// mirror is a contiguous run of `maxAgents` f32 per field; a field's element at
// sorted-slot `s` is `sorted[fieldIndex*maxAgents + s]`. The mirror-variant force
// scan then reads neighbour fields COALESCED from the mirror at the CSR slot,
// instead of the random-access indirection `binAgents[p] -> agentF32[base + j]`.
//
// The field SET is the fields the ENGINE force pass reads (x, y[,z], radius, vx,
// vy[,vz]); B1's scan only reads x/y/[z]/radius, but vx/vy[/vz] ride the mirror so
// B2's fused gather can read neighbour velocities for free. sortedId (u32) carries
// each slot's canonical agent id (for the self-skip + B2's identity consumption).
// The mirror is built ONLY when the force scan runs (needScan = bonding ||
// doCollision || doDensity) — pure-custom-force models (Boids/PL) pay ZERO cost.
// ===========================================================================
/** The mirror field order (2D). The mirror stores one contiguous `maxAgents` run
 *  per field, in THIS order; field k's slot `s` is `sorted[k*maxAgents + s]`. */
export const AGENT_MIRROR_FIELDS_2D = ['x', 'y', 'radius', 'vx', 'vy'] as const;
/** The mirror field order (3D). */
export const AGENT_MIRROR_FIELDS_3D = ['x', 'y', 'z', 'radius', 'vx', 'vy', 'vz'] as const;
/** The mirror field order for the given dimensionality — the SINGLE source shared
 *  by the mirror scatter (agentWebgpuRuntime.ts) + the mirror force scan here. */
export function agentMirrorFields(is3d: boolean): readonly string[] {
  return is3d ? AGENT_MIRROR_FIELDS_3D : AGENT_MIRROR_FIELDS_2D;
}

/** The ForceControl uniform — the per-step scalars the worker writes before the
 *  force dispatch (its own struct, separate from the behaviour's Control, so the
 *  two shaders stay decoupled). The field order MIRRORS the worker's write +
 *  `FORCE_PASS_PARAMS` (the WASM force-pass ABI) so the three force integrators
 *  read the same inputs. */
export function emitForceControlStruct(): string {
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
  nBinsZ     : u32,
  binSizeZ   : f32,
  fieldD     : f32,
  originX    : f32,
  originY    : f32,
  originZ    : f32,
  doCollision : u32,
  doDensity  : u32,
  doCharge   : u32,
  chargeK    : f32,
  chargeMaxD2 : f32,
  chargeMinC : f32,
  // C9 / STEP 6 — 0 static | 1 velocity | 2 force. Appended LAST so every
  // existing member's byte offset is unchanged. Gated at RUNTIME (the shader text
  // is not compile-identity-checked and a uniform branch is perfectly coherent) —
  // the same convention doCharge uses.
  motionMode : u32,
};`;
}

/** L1 — the LONG-RANGE CHARGE term, shared VERBATIM by the canonical neighbour
 *  body and the B1 bin-sorted MIRROR body (one source, so the two force pipelines
 *  cannot diverge — a term added to only one of them would be wrong exclusively
 *  for the models that engage the mirror, which is the hardest kind of bug to see).
 *
 *  Emitted UNCONDITIONALLY and gated at RUNTIME on `fc.doCharge`, unlike the WASM
 *  port which gates at compile time: the WASM param list is part of the module's
 *  bytes (so it must stay conditional for byte-identity), whereas the shader text
 *  is not compile-identity-checked, and a runtime gate means toggling charge never
 *  rebuilds a pipeline. The branch is on a uniform, so it is perfectly coherent.
 *
 *  Placed BEFORE the soft-sphere's `rmax` test: the charge cutoff is far wider, so
 *  evaluating it inside the existing cutoff would silently clip it to the contact
 *  radius (the same class of mistake as forgetting the hash bin edge). */
function chargeTerm(is3d: boolean): string {
  const fz = is3d ? ' fz = fz + cq * dz;' : '';
  return `
          if (fc.doCharge != 0u && d2 != 0.0 && d2 <= fc.chargeMaxD2) {
            let cq: f32 = fc.chargeK * (1.0 / (1.0 + d2) - fc.chargeMinC);
            fx = fx + cq * dx; fy = fy + cq * dy;${fz}
          }`;
}

/** Emit the standalone WGSL force-pass module for the given GPU agent layout.
 *  One invocation per agent slot (2-D dispatch tiling recovers the linear idx,
 *  the lattice pattern). Pure — no GPU calls. */
export function emitAgentForcePassWGSL(layout: AgentWebGPULayout, usesForceScatter = false, mirror = false): string {
  const is3d = layout.gridDepth > 1;
  // Apply Force To Agent — the behaviour shader scattered cross-agent force into an
  // atomic `forceScatter` buffer (X/Y[/Z] regions strided by maxAgents); the force
  // pass adds it to each agent's OWN self-force seed. Each agent reads only its own
  // slot here (no contention → a plain read + bitcast, not atomic). Absent → the
  // seed is byte-identical to the pre-feature force pass.
  const MA = layout.maxAgents;
  const scatterX = usesForceScatter ? ` + bitcast<f32>(forceScatter[i])` : '';
  const scatterY = usesForceScatter ? ` + bitcast<f32>(forceScatter[${MA}u + i])` : '';
  const scatterZ = usesForceScatter ? ` + bitcast<f32>(forceScatter[${2 * MA}u + i])` : '';
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
  const dz3 = is3d ? `
      var dz: f32 = ${f32('z', 'j')} - zi;` : '';
  const dzWrap = is3d ? `
        if (dz > hD) { dz = dz - fc.fieldD; } else if (dz < -hD) { dz = dz + fc.fieldD; }` : '';
  const d2Expr = is3d ? 'dx * dx + dy * dy + dz * dz' : 'dx * dx + dy * dy';
  const fz3 = is3d ? ' fz = fz + k * dz;' : '';
  const neighbourBody = `
    if (j != i && agentAlive[j] != 0u) {
      var dx: f32 = ${f32('x', 'j')} - xi;
      var dy: f32 = ${f32('y', 'j')} - yi;${dz3}
      if (fc.torus != 0u) {
        if (dx > hW) { dx = dx - fc.fieldW; } else if (dx < -hW) { dx = dx + fc.fieldW; }
        if (dy > hH) { dy = dy - fc.fieldH; } else if (dy < -hH) { dy = dy + fc.fieldH; }${dzWrap}
      }
      let d2: f32 = ${d2Expr};${chargeTerm(is3d).replace(/\n {10}/g, '\n      ')}
      let sij: f32 = ri + ${f32('radius', 'j')};
      let rmax: f32 = fc.range * sij;
      if (d2 != 0.0 && d2 < rmax * rmax) {
        dens = dens + 1.0;
        // Soft-sphere runs when EITHER bonding physics OR the Collision capability
        // is on: repulsion (d<sij) IS the volume-exclusion collision (gated on
        // doCollision), adhesion (d>=sij) is cohesion (gated on bonding). Mirrors
        // the JS/WASM force pass: muRep = doCollision?muR:0, muAdh = bonding?muA:0.
        if (fc.bonding != 0u || fc.doCollision != 0u) {
          let d: f32 = sqrt(d2);
          let muRep: f32 = select(0.0, fc.muR, fc.doCollision != 0u);
          let muAdh: f32 = select(0.0, fc.muA, fc.bonding != 0u);
          let mu: f32 = select(muAdh, muRep, d < sij);
          let F: f32 = mu * (d - sij);
          let k: f32 = F / d;
          fx = fx + k * dx; fy = fy + k * dy;${fz3}
        }
      }
    }`;

  // B1 (resident-only, `mirror`): the bin-sorted MIRROR neighbour body — reads
  // neighbour fields COALESCED from `sorted` at the CSR slot `sp`, `j` = the
  // canonical id from `sortedId[sp]` (for the self-skip). The mirror holds ONLY
  // alive agents (the scatter skips dead), so no `agentAlive[j]` check. Used only
  // in the hash-stencil branch (hashValid != 0); the all-pairs fallback (no hash
  // ⇒ no mirror this batch) stays canonical. `mirror` false ⇒ byte-identical.
  const mfields = agentMirrorFields(is3d);
  const sm = (field: string): string => {
    const k = mfields.indexOf(field);
    return k <= 0 ? 'sorted[sp]' : `sorted[${k * MA}u + sp]`;
  };
  const dz3m = is3d ? `\n        var dz: f32 = ${sm('z')} - zi;` : '';
  const mirrorBody = `
        let j: u32 = sortedId[sp];
        if (j != i) {
          var dx: f32 = ${sm('x')} - xi;
          var dy: f32 = ${sm('y')} - yi;${dz3m}
          if (fc.torus != 0u) {
            if (dx > hW) { dx = dx - fc.fieldW; } else if (dx < -hW) { dx = dx + fc.fieldW; }
            if (dy > hH) { dy = dy - fc.fieldH; } else if (dy < -hH) { dy = dy + fc.fieldH; }${dzWrap}
          }
          let d2: f32 = ${d2Expr};${chargeTerm(is3d)}
          let sij: f32 = ri + ${sm('radius')};
          let rmax: f32 = fc.range * sij;
          if (d2 != 0.0 && d2 < rmax * rmax) {
            dens = dens + 1.0;
            if (fc.bonding != 0u || fc.doCollision != 0u) {
              let d: f32 = sqrt(d2);
              let muRep: f32 = select(0.0, fc.muR, fc.doCollision != 0u);
              let muAdh: f32 = select(0.0, fc.muA, fc.bonding != 0u);
              let mu: f32 = select(muAdh, muRep, d < sij);
              let F: f32 = mu * (d - sij);
              let k: f32 = F / d;
              fx = fx + k * dx; fy = fy + k * dy;${fz3}
            }
          }
        }`;
  // The stencil inner loop body (shared by the 2D + 3D stencils). Non-mirror emits
  // the canonical `binAgents[p] -> agentF32` indirection VERBATIM (byte-identical).
  const stencilInner = mirror
    ? `let sp: u32 = u32(p);${mirrorBody}`
    : `let j: u32 = u32(${binAgentsAt('u32(p)')});${neighbourBody}`;

  // 3D-only declarations / extents.
  const zi3 = is3d ? `\n  let zi: f32 = ${f32('z', 'i')};` : '';
  const hD3 = is3d ? `\n  let hD: f32 = fc.fieldD * 0.5;` : '';
  const fz3Decl = is3d ? `\n  var fz: f32 = ${f32('forceZ', 'i')}${scatterZ};` : '';
  const deadZ = is3d ? `\n    ${f32('zNext', 'i')} = ${f32('z', 'i')};` : '';

  // The hash stencil — 3×3 (2D) or 3×3×3 (3D); the 3D bin index is
  // (nbz·nBinsY + nby)·nBinsX + nbx.
  const stencil = is3d ? `
    var bx: i32 = clamp(i32((xi - fc.originX) / fc.binSizeX), 0, i32(fc.nBinsX) - 1);
    var by: i32 = clamp(i32((yi - fc.originY) / fc.binSizeY), 0, i32(fc.nBinsY) - 1);
    var bz: i32 = clamp(i32((zi - fc.originZ) / fc.binSizeZ), 0, i32(fc.nBinsZ) - 1);
    for (var ez: i32 = -1; ez <= 1; ez = ez + 1) {
    for (var ey: i32 = -1; ey <= 1; ey = ey + 1) {
    for (var ex: i32 = -1; ex <= 1; ex = ex + 1) {
      var nbx: i32 = bx + ex; var nby: i32 = by + ey; var nbz: i32 = bz + ez;
      var skip: bool = false;
      if (fc.torus != 0u) {
        nbx = ((nbx % i32(fc.nBinsX)) + i32(fc.nBinsX)) % i32(fc.nBinsX);
        nby = ((nby % i32(fc.nBinsY)) + i32(fc.nBinsY)) % i32(fc.nBinsY);
        nbz = ((nbz % i32(fc.nBinsZ)) + i32(fc.nBinsZ)) % i32(fc.nBinsZ);
      } else {
        if (nbx < 0 || nbx >= i32(fc.nBinsX) || nby < 0 || nby >= i32(fc.nBinsY) || nbz < 0 || nbz >= i32(fc.nBinsZ)) { skip = true; }
      }
      if (!skip) {
        let b: i32 = (nbz * i32(fc.nBinsY) + nby) * i32(fc.nBinsX) + nbx;
        let pStart: i32 = ${binStartAt('u32(b)')};
        let pEnd: i32 = ${binStartAt('u32(b) + 1u')};
        for (var p: i32 = pStart; p < pEnd; p = p + 1) {
          ${stencilInner}
        }
      }
    } } }` : `
    var bx: i32 = i32((xi - fc.originX) / fc.binSizeX);
    bx = clamp(bx, 0, i32(fc.nBinsX) - 1);
    var by: i32 = i32((yi - fc.originY) / fc.binSizeY);
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
          ${stencilInner}
        }
      }
    } }`;

  // Velocity integration (z added in 3D) + the speed cap + position wrap/clamp.
  const vz3 = is3d ? `\n  var vzi: f32 = select(${f32('vz', 'i')}, fc.momentum * ${f32('vz', 'i')} + fc.dtOverEta * fz, fc.motionMode == 2u);` : '';
  const speed = is3d
    ? `sqrt(vxi * vxi + vyi * vyi + vzi * vzi)`
    : `sqrt(vxi * vxi + vyi * vyi)`;
  const capZ = is3d ? ' vzi = vzi * sc;' : '';
  const setVz = is3d ? `\n  ${f32('vz', 'i')} = vzi;` : '';
  const nz3 = is3d ? `\n  var nz: f32 = zi + vzi;` : '';
  const wrapZ = is3d ? `
    nz = ((nz % fc.fieldD) + fc.fieldD) % fc.fieldD;` : '';
  const clampZ = is3d ? `
    nz = clamp(nz, 0.0, fc.fieldD);` : '';
  const setZNext = is3d ? `\n    ${f32('zNext', 'i')} = nz;` : '';
  // C9 / STEP 4 — THE SAFETY CATCH on the GPU: a gated-OFF optional field has no
  // run in the layout, so its block is simply not emitted.
  const ageLine = layout.f32Base['age'] !== undefined
    ? `${f32('age', 'i')} = ${f32('age', 'i')} + 1.0;` : '';
  const growthBlock = layout.f32Base['targetRadius'] !== undefined ? `
  // Growth ramp toward targetRadius (no-op when growthRate==0, e.g. boids).
  let tr: f32 = ${f32('targetRadius', 'i')};
  let cur: f32 = ${f32('radius', 'i')};
  if (tr != cur && fc.growthRate > 0.0) {
    let dd: f32 = tr - cur;
    ${f32('radius', 'i')} = select(cur + sign(dd) * fc.growthRate, tr, abs(dd) <= fc.growthRate);
  }` : '';

  return `${emitForceControlStruct()}

@group(0) @binding(0) var<storage, read_write> agentF32   : array<f32>;
@group(0) @binding(1) var<storage, read>       agentAlive : array<u32>;
@group(0) @binding(2) var<storage, read>       hashBins   : array<i32>;
@group(0) @binding(3) var<uniform>             fc         : ForceControl;${usesForceScatter ? '\n@group(0) @binding(4) var<storage, read>       forceScatter : array<u32>;' : ''}${mirror ? '\n@group(0) @binding(5) var<storage, read>       sorted     : array<f32>;\n@group(0) @binding(6) var<storage, read>       sortedId   : array<u32>;' : ''}

@compute @workgroup_size(64)
fn forcePass(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i: u32 = gid.y * (nwg.x * 64u) + gid.x;
  if (i >= fc.highWater) { return; }
  if (agentAlive[i] == 0u) {
    // dead slot: carry the position forward unchanged (JS parity: xN[i]=x[i]).
    ${f32('xNext', 'i')} = ${f32('x', 'i')};
    ${f32('yNext', 'i')} = ${f32('y', 'i')};${deadZ}
    return;
  }

  let xi: f32 = ${f32('x', 'i')};
  let yi: f32 = ${f32('y', 'i')};${zi3}
  let ri: f32 = ${f32('radius', 'i')};
  let hW: f32 = fc.fieldW * 0.5;
  let hH: f32 = fc.fieldH * 0.5;${hD3}

  // Start from the graph-authored force: this agent's own Apply Force (self, in
  // agentF32) PLUS any cross-agent Apply Force To Agent scattered onto it this step.
  var fx: f32 = ${f32('forceX', 'i')}${scatterX};
  var fy: f32 = ${f32('forceY', 'i')}${scatterY};${fz3Decl}
  var dens: f32 = 0.0;

  // P1 (the dead density scan): the neighbour pass exists to (a) apply the
  // soft-sphere force and (b) count density. When NEITHER is needed (engine
  // physics off + no node reads density + no division fallback), skip the
  // whole scan — it was ~70% of a custom-force model's force-pass cost.
  // density[i] then keeps its last value (nothing observes it).
  // (charge joins the gate: a pure charged gas has no soft-sphere, no springs and
  // no density consumer, so without it the whole scan — and the charge — is skipped)
  if (fc.bonding != 0u || fc.doCollision != 0u || fc.doDensity != 0u || fc.doCharge != 0u) {
    if (fc.hashValid != 0u) {
      // --- hash-bin stencil over the CSR hash, torus-wrapped ---${stencil}
    } else {
      // --- all-pairs fallback (a world too small to tile) ---
      for (var j: u32 = 0u; j < fc.highWater; j = j + 1u) {${neighbourBody}
      }
    }
    ${layout.f32Base['density'] !== undefined ? `${f32('density', 'i')} = dens;` : ''}
  }

  // Integrate: v = momentum·v + (dt/eta)·F; optional speed cap; x += v; wrap/clamp.
  // C9 / STEP 6: under velocity the engine seeds no force, so the graph-set
  // velocity is carried through unchanged (a genuine coast); under static the
  // whole block below is skipped and the worker skips the position commit too.
  var vxi: f32 = select(${f32('vx', 'i')}, fc.momentum * ${f32('vx', 'i')} + fc.dtOverEta * fx, fc.motionMode == 2u);
  var vyi: f32 = select(${f32('vy', 'i')}, fc.momentum * ${f32('vy', 'i')} + fc.dtOverEta * fy, fc.motionMode == 2u);${vz3}
  if (fc.maxSpeed > 0.0) {
    let sp: f32 = ${speed};
    if (sp > fc.maxSpeed) { let sc: f32 = fc.maxSpeed / sp; vxi = vxi * sc; vyi = vyi * sc;${capZ} }
  }
  // C9 / STEP 6: static (0) writes NO velocity and NO position -- the worker
  // skips the position commit with it, so x stays the single live buffer and a
  // graph Set Agent Position write is not reverted by a stale xNext.
  if (fc.motionMode != 0u) {
    ${f32('vx', 'i')} = vxi;
    ${f32('vy', 'i')} = vyi;${setVz}

    var nx: f32 = xi + vxi;
    var ny: f32 = yi + vyi;${nz3}
    if (fc.torus != 0u) {
      nx = ((nx % fc.fieldW) + fc.fieldW) % fc.fieldW;
      ny = ((ny % fc.fieldH) + fc.fieldH) % fc.fieldH;${wrapZ}
    } else {
      nx = clamp(nx, 0.0, fc.fieldW);
      ny = clamp(ny, 0.0, fc.fieldH);${clampZ}
    }
    ${f32('xNext', 'i')} = nx;
    ${f32('yNext', 'i')} = ny;${setZNext}
  }
  ${ageLine}
${growthBlock}
}
`;
}
