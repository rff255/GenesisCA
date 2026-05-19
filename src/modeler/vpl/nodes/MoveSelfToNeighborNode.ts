import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

/** Atomic move-into-vacancy: push payloads to a target neighbour, then clear
 *  self. The canonical chemistry idiom for "ingredient moves into the empty
 *  space at NI" — packages the 4-write sequence (push attr + push orientation
 *  + clear attr + clear orientation) into a single flow node.
 *
 *  Inputs (static):
 *    - `do`: flow trigger.
 *    - `targetNI`: the NeighborIndex of the destination cell.
 *    - `orientation` (only when `transferOrientation` is true): the value to
 *      push to the destination cell's orientation (e.g. a post-rotation
 *      orientation override).
 *
 *  Inputs (dynamic, derived from `payloadCount` + per-slot `attr_${i}` config):
 *    - `payload_${i}`: the value to push to the destination's `attr_${i}`
 *      cell attribute. The source cell's same attribute is then cleared to
 *      its declared `defaultValue` (book §2.3.4 "ingredient leaves a vacancy
 *      behind").
 *
 *  Atomicity: payload reads happen at cell-top scope (SSA discipline — every
 *  upstream value lands in a JS `const` / WASM `local` before any flow write
 *  fires), so the four writes see the pre-move snapshot. No new compiler
 *  primitive needed; the SSA hoisting that already powers GetCellAttribute
 *  carries the guarantee.
 *
 *  Async-only. setNeighborAttributeByIndex (which this composes) requires
 *  asynchronous update mode — sync mode's post-step bulk copy would overwrite
 *  the neighbour writes. Validation rejects sync-mode use. WebGPU's WGSL
 *  emitter rejects this for the same reason.
 */
export const MoveSelfToNeighborNode: NodeTypeDef = {
  type: 'moveSelfToNeighbor',
  label: 'Move Self To Neighbor',
  description: 'Atomic move into a vacant neighbour: pushes per-attribute payloads (and optionally orientation) to the target NI, then clears self to defaults. Async-only — chemistry move-into-empty idiom.',
  category: 'output',
  color: '#4a148c',
  requirements: { async: true, variegated: false }, // variegated only required when transferOrientation
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'targetNI', label: 'Target NI', kind: 'input', category: 'value', dataType: 'neighborIndex' },
    { id: 'orientation', label: 'Orientation', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    // Dynamic `payload_${i}` ports — see effectivePorts.ts for the render-time list.
  ],
  defaultConfig: { payloadCount: 1, transferOrientation: false },
  compile: (_nodeId, config, inputs, boundary) => {
    const payloadCount = Math.max(1, Number(config.payloadCount) || 1);
    const transferOri = !!config.transferOrientation;
    const ni = inputs['targetNI'] || '0';
    const b = boundary || 'torus';
    const lines: string[] = [];
    // Resolve target cell index ONCE (SSA-style local). Used by every push.
    const niLocal = `_msn_ni_${_nodeId}`;
    lines.push(`const ${niLocal} = (${ni}) | 0;`);
    const cellAccess = niCellExprStmts(niLocal, b, `${_nodeId}_msn`);
    lines.push(cellAccess.stmts);
    lines.push(`if (${niLocal} !== ${0x80000000 | 0} && ${cellAccess.cellExpr} < total) {`);
    for (let i = 0; i < payloadCount; i++) {
      const attrId = config[`attr_${i}`] as string;
      if (!attrId) continue;
      const payload = inputs[`payload_${i}`] ?? '0';
      const clearTo = (config[`_attr_${i}_default`] as string) ?? '0';
      lines.push(`  w_${attrId}[${cellAccess.cellExpr}] = ${payload};`);
      lines.push(`  w_${attrId}[idx] = ${clearTo};`);
    }
    if (transferOri) {
      const oriValue = inputs['orientation'] ?? '0';
      lines.push(`  w_orientation[${cellAccess.cellExpr}] = ((${oriValue}) | 0) & 3;`);
      lines.push(`  w_orientation[idx] = 0;`);
    }
    lines.push(`}`);
    return lines.join('\n') + '\n';
  },
};
