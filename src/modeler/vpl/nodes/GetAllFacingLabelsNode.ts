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
/** Returns true if the node's config requests the 4-slot cardinal output
 *  (N/E/S/W) instead of the default 8-slot Moore output (N/NE/E/SE/S/SW/W/NW).
 *  Shared across all three compile targets so the array-length decision stays
 *  in lockstep. */
export function getAllFacingLabelsLen(config: Record<string, unknown>): 8 | 4 {
  return config?.cardinalsOnly ? 4 : 8;
}

export const GetAllFacingLabelsNode: NodeTypeDef = {
  type: 'getAllFacingLabels',
  label: 'Get All Facing Labels',
  description: 'Produces two parallel arrays of face labels at each 1-step neighbour encounter — by default 8 slots (Moore order N/NE/E/SE/S/SW/W/NW) or 4 slots (cardinal order N/E/S/W) when "Cardinals only" is checked. Pair with Aggregate for energy sums, or with For Each In Array for per-direction logic.',
  category: 'data',
  color: '#1976d2',
  requirements: { variegated: true },
  ports: [
    { id: 'myFaceLabels', label: 'My Faces', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
    { id: 'theirFaceLabels', label: 'Their Faces', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
  ],
  defaultConfig: { cardinalsOnly: false },
  compile: (nodeId, config) => {
    // Pre-resolve pass bakes the per-direction (dr, dc) offsets, the boundary
    // treatment, and the variegation source attribute id. We unroll the
    // direction loop at emit time so the per-cell hot path is straight-line
    // arithmetic + indexed memory reads (no JS for-loop overhead).
    const sourceAttrId = (config._sourceAttrId as string) || '';
    const boundary = (config._boundaryTreatment as string) || 'torus';
    const cardinalsOnly = !!config.cardinalsOnly;
    const my = `_v${nodeId}_myFaceLabels`;
    const their = `_v${nodeId}_theirFaceLabels`;
    const mySpec = `_ms${nodeId}`;
    const myOri = `_mo${nodeId}`;
    const mySpecRead = sourceAttrId ? `r_${sourceAttrId}[idx] | 0` : '0';
    const lines: string[] = [
      `const ${mySpec} = ${mySpecRead};`,
      `const ${myOri} = r_orientation[idx] | 0;`,
    ];
    // Direction offsets in canonical N/NE/E/SE/S/SW/W/NW order. The 4-slot
    // cardinal mode uses every other entry (slots 0, 2, 4, 6 = N, E, S, W).
    const OFFSETS: ReadonlyArray<readonly [number, number]> = [
      [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
    ];
    // d8 is the Moore slot (drives the face-rotation arithmetic, baked into
    // the face pattern lookup). slotIdx is the OUTPUT array index — same as
    // d8 in 8-slot mode, but 0..3 in cardinal-only mode.
    const iterations: ReadonlyArray<readonly [number, number]> = cardinalsOnly
      ? [[0, 0], [2, 1], [4, 2], [6, 3]]
      : [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7]];
    for (const [d8, slotIdx] of iterations) {
      const [dr, dc] = OFFSETS[d8]!;
      const dirP4 = (d8 + 4) & 7;
      const nci = `_nci${nodeId}_${slotIdx}`;
      const ts = `_ts${nodeId}_${slotIdx}`;
      const toL = `_to${nodeId}_${slotIdx}`;
      const mf = `_mf${nodeId}_${slotIdx}`;
      const tf = `_tf${nodeId}_${slotIdx}`;
      // Inline boundary-aware neighbour cell index.
      let nciExpr: string;
      if (boundary === 'constant') {
        const rowChecks: string[] = [];
        if (dr < 0) rowChecks.push(`_row + (${dr}) >= 0`);
        if (dr > 0) rowChecks.push(`_row + (${dr}) < H`);
        const colChecks: string[] = [];
        if (dc < 0) colChecks.push(`_col + (${dc}) >= 0`);
        if (dc > 0) colChecks.push(`_col + (${dc}) < W`);
        const allChecks = [...rowChecks, ...colChecks].join(' && ') || 'true';
        nciExpr = `((${allChecks}) ? (_row + (${dr})) * W + (_col + (${dc})) : total)`;
      } else {
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
        `const ${mf} = (${d8} + 2 * ${myOri}) & 7;`,
        `const ${tf} = ((${dirP4}) + 2 * ${toL}) & 7;`,
        `${my}[${slotIdx}] = (${mySpec} < 0) ? 0 : (_facePatternLookup[${mySpec} * 8 + ${mf}] | 0);`,
        `${their}[${slotIdx}] = (${nci} >= total) ? 0 : (_facePatternLookup[${ts} * 8 + ${tf}] | 0);`,
      );
    }
    return lines.join(' ') + '\n';
  },
};
