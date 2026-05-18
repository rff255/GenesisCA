import type { NodeTypeDef } from '../types';

/** Produce two parallel arrays of length 8 — `myFaceLabels[d]` and
 *  `theirFaceLabels[d]` — covering every 1-step neighbour encounter in the
 *  canonical N/NE/E/SE/S/SW/W/NW direction order (index 0 = N, 7 = NW).
 *
 *  The companion to `Get Facing Labels` for the iterate-all-directions use
 *  case (e.g., summing interaction energies over every face slot in a
 *  chromatography model). Pair with `Aggregate` for direct reduction or with
 *  `For Each In Array` + `Array Element` for per-direction logic.
 *
 *  Like its single-direction sibling, this is intrinsic to the spatial grid —
 *  no neighborhood needed. Boundary treatment is honoured at compile time.
 *
 *  Compile-time bakes: source attr id + (dr, dc) lookup table + boundary
 *  treatment. Runtime per cell: 8 orientation reads, 16 facePatternLookup
 *  reads, 2 arrays of length 8 written. */
export const GetAllFacingLabelsNode: NodeTypeDef = {
  type: 'getAllFacingLabels',
  label: 'Get All Facing Labels',
  description: 'Produces two parallel arrays of length 8 with the face labels at every 1-step neighbour encounter (indexed N/NE/E/SE/S/SW/W/NW). Pair with Aggregate for energy sums, or with For Each In Array for per-direction logic.',
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'myFaceLabels', label: 'My Faces[8]', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
    { id: 'theirFaceLabels', label: 'Their Faces[8]', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
  ],
  defaultConfig: {},
  compile: (nodeId, config) => {
    // Pre-resolve pass bakes the per-direction (dr, dc) offsets, the boundary
    // treatment, and the variegation source attribute id. We unroll the
    // 8-direction loop at emit time so the per-cell hot path is straight-line
    // arithmetic + 16 indexed memory reads (no JS for-loop overhead).
    const sourceAttrId = (config._sourceAttrId as string) || '';
    const boundary = (config._boundaryTreatment as string) || 'torus';
    const my = `_v${nodeId}_myFaceLabels`;
    const their = `_v${nodeId}_theirFaceLabels`;
    const mySpec = `_ms${nodeId}`;
    const myOri = `_mo${nodeId}`;
    const mySpecRead = sourceAttrId ? `r_${sourceAttrId}[idx] | 0` : '0';
    const lines: string[] = [
      `const ${mySpec} = ${mySpecRead};`,
      `const ${myOri} = r_orientation[idx] | 0;`,
    ];
    // Direction offsets in canonical N/NE/E/SE/S/SW/W/NW order.
    const OFFSETS: ReadonlyArray<readonly [number, number]> = [
      [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
    ];
    for (let d = 0; d < 8; d++) {
      const [dr, dc] = OFFSETS[d]!;
      const dirP4 = (d + 4) & 7;
      const nci = `_nci${nodeId}_${d}`;
      const ts = `_ts${nodeId}_${d}`;
      const toL = `_to${nodeId}_${d}`;
      const mf = `_mf${nodeId}_${d}`;
      const tf = `_tf${nodeId}_${d}`;
      // Inline boundary-aware neighbour cell index.
      let nciExpr: string;
      if (boundary === 'constant') {
        // Compile-time-constant in-bounds checks: if dr/dc is 0 the row/col
        // can't escape, so drop the comparison. Tiny code-size win at no
        // logic cost.
        const rowChecks: string[] = [];
        if (dr < 0) rowChecks.push(`_row + (${dr}) >= 0`);
        if (dr > 0) rowChecks.push(`_row + (${dr}) < H`);
        const colChecks: string[] = [];
        if (dc < 0) colChecks.push(`_col + (${dc}) >= 0`);
        if (dc > 0) colChecks.push(`_col + (${dc}) < W`);
        const allChecks = [...rowChecks, ...colChecks].join(' && ') || 'true';
        nciExpr = `((${allChecks}) ? (_row + (${dr})) * W + (_col + (${dc})) : total)`;
      } else {
        // torus wrap. Fast-path: when dr or dc is 0 the wrap collapses to a
        // single modulo, eliminating one of the modulo-pair calls.
        const rowExpr = dr === 0
          ? `_row`
          : `(((_row + (${dr})) % H + H) % H)`;
        const colExpr = dc === 0
          ? `_col`
          : `(((_col + (${dc})) % W + W) % W)`;
        nciExpr = `(${rowExpr} * W + ${colExpr})`;
      }
      const theirSpecRead = sourceAttrId ? `r_${sourceAttrId}[${nci}] | 0` : '0';
      lines.push(
        `const ${nci} = ${nciExpr};`,
        `const ${ts} = ${theirSpecRead};`,
        `const ${toL} = r_orientation[${nci}] | 0;`,
        `const ${mf} = (${d} + 2 * ${myOri}) & 7;`,
        `const ${tf} = ((${dirP4}) + 2 * ${toL}) & 7;`,
        `${my}[${d}] = (${mySpec} < 0) ? 0 : (_facePatternLookup[${mySpec} * 8 + ${mf}] | 0);`,
        `${their}[${d}] = (${nci} >= total) ? 0 : (_facePatternLookup[${ts} * 8 + ${tf}] | 0);`,
      );
    }
    return lines.join(' ') + '\n';
  },
};
