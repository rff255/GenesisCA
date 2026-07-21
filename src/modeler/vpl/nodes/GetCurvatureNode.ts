import type { NodeTypeDef } from '../types';

/** Get Curvature — a local membrane-curvature measure for a BONDED agent
 *  (Bond-Graph Agents). Returns the magnitude of the mean unit-vector to this
 *  agent's bonded partners, in [0, 1]:
 *    - ~0  → the partners surround the agent evenly (a flat / interior membrane
 *            cell — the inward pulls cancel).
 *    - →1  → the partners are all on one side (a convex edge / corner / tip).
 *  Returns 0 for an agent with < 2 bonds (curvature undefined). Drives
 *  curvature-dependent behaviour — edge cells dividing or differentiating
 *  differently from interior cells, tip growth, wound healing. Per-agent.
 *
 *  Mirrors For Each Bond's bond iteration (the bond list is swept clean in the
 *  post-step structural phase, so no epoch re-check is needed at behaviour time).
 *  The current length is the raw Euclidean distance (bonds are short-range).
 *
 *  Lengths are Math.sqrt(dx*dx + dy*dy [+ dz*dz]) — NOT Math.hypot, which is
 *  correctly-rounded and differs by ULPs from the WASM emit's f64.sqrt-of-
 *  squared-sum; the sqrt-of-sum form (same associativity as the WASM ops in
 *  agentWasm/compile.ts emitCurvature) keeps JS↔WASM bit-parity (the
 *  getAgentOffset.distance lesson). */
export const GetCurvatureNode: NodeTypeDef = {
  type: 'getCurvature',
  label: 'Get Curvature',
  description: 'Local membrane curvature of a bonded agent (0 = flat/interior, →1 = convex edge/tip).',
  category: 'data',
  color: '#00838f',
  requirements: { bondGraph: true },
  ports: [
    { id: 'value', label: 'Curvature', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, _inputs, _boundary, ctx) =>
    ctx?.is3d
      // 3D: the mean unit-vector gains the z arm (depth torus-wrap via `_fieldD`).
      ? `const _v${nodeId} = (function(){ const bc = _agentBondCount[idx]; if (bc < 2) return 0; const base = idx * maxBonds; let sx = 0, sy = 0, sz = 0, cnt = 0; for (let _k = 0; _k < bc; _k++) { const p = _bondPartner[base + _k]; if (p < 0 || p >= highWater || !_alive[p]) continue; let dx = _agentX[p] - _agentX[idx], dy = _agentY[p] - _agentY[idx], dz = _agentZ[p] - _agentZ[idx]; if (_fieldBoundaryTorus) { const _cw = _fieldW, _ch = _fieldH, _cd = _fieldD, _chw = _cw / 2, _chh = _ch / 2, _chd = _cd / 2; if (dx > _chw) dx -= _cw; else if (dx < -_chw) dx += _cw; if (dy > _chh) dy -= _ch; else if (dy < -_chh) dy += _ch; if (dz > _chd) dz -= _cd; else if (dz < -_chd) dz += _cd; } const d = Math.sqrt(dx * dx + dy * dy + dz * dz); if (d > 1e-9) { sx += dx / d; sy += dy / d; sz += dz / d; cnt++; } } return cnt > 0 ? Math.sqrt(sx * sx + sy * sy + sz * sz) / cnt : 0; })();\n`
      : `const _v${nodeId} = (function(){ const bc = _agentBondCount[idx]; if (bc < 2) return 0; const base = idx * maxBonds; let sx = 0, sy = 0, cnt = 0; for (let _k = 0; _k < bc; _k++) { const p = _bondPartner[base + _k]; if (p < 0 || p >= highWater || !_alive[p]) continue; let dx = _agentX[p] - _agentX[idx], dy = _agentY[p] - _agentY[idx]; if (_fieldBoundaryTorus) { const _cw = _fieldW, _ch = _fieldH, _chw = _cw / 2, _chh = _ch / 2; if (dx > _chw) dx -= _cw; else if (dx < -_chw) dx += _cw; if (dy > _chh) dy -= _ch; else if (dy < -_chh) dy += _ch; } const d = Math.sqrt(dx * dx + dy * dy); if (d > 1e-9) { sx += dx / d; sy += dy / d; cnt++; } } return cnt > 0 ? Math.sqrt(sx * sx + sy * sy) / cnt : 0; })();\n`,
};
