import type { NodeTypeDef } from '../types';
import { niCellExprStmts } from '../compiler/niCodec';

/** Transfer Cell Attributes to Neighbor — copy/move/swap the *current* values
 *  of a chosen set of cell attributes (and optionally orientation) between this
 *  cell and a target neighbour. Generalises the chemistry move-into-vacancy
 *  idiom into three operations.
 *
 *  Inputs (static):
 *    - `do`: flow trigger.
 *    - `targetNI`: the NeighborIndex of the destination/source cell.
 *
 *  Config:
 *    - `payloadCount` + per-slot `attr_${i}`: the cell attributes to transfer
 *      (read directly from the cells — no value input ports).
 *    - `operation`: 'copyTo' (self → neighbour), 'copyFrom' (neighbour → self),
 *      or 'swap' (exchange, via an intermediary so no data is lost).
 *    - `nonReceiving`: for copyTo/copyFrom only — what to do with the source
 *      cell that gave its values: 'untouched' (leave it) or 'defaults' (reset it
 *      to each attribute's declared `defaultValue`, the classic "leaves a vacancy
 *      behind" move). Ignored by swap (both cells receive values).
 *    - `includeOrientation`: also transfer the cell's current orientation, using
 *      the same operation (default value when reset = 0). Requires Variegated
 *      Cells enabled.
 *
 *  Post-update semantics: values are read from the WRITE buffer at the node's
 *  flow position, NOT snapshotted at cell-top. So whatever was written to self
 *  or the neighbour earlier in this generation step (by setAttribute /
 *  setNeighborAttributeByIndex / setOrientation / …) is what gets transferred.
 *  This node is async-only, where the write buffer aliases the read buffer
 *  (single buffer), so the write buffer is the live, current state.
 *
 *  Async-only. It writes neighbour cells (copyTo / swap / copyFrom+defaults) —
 *  sync mode's post-step bulk copy would overwrite those writes. Validation
 *  rejects sync-mode use. WebGPU is sync-only and rejects this node.
 */
export const MoveSelfToNeighborNode: NodeTypeDef = {
  type: 'moveSelfToNeighbor',
  label: 'Transfer Cell Attributes to Neighbor',
  description: 'Copy/move/swap the current values of chosen cell attributes (and optionally orientation) between this cell and a target neighbour. Async-only.',
  category: 'output',
  color: '#4a148c',
  requirements: { async: true, variegated: false }, // variegated only required when includeOrientation
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'targetNI', label: 'Target NI', kind: 'input', category: 'value', dataType: 'neighborIndex' },
  ],
  defaultConfig: { payloadCount: 1, operation: 'copyTo', nonReceiving: 'defaults', includeOrientation: false },
  compile: (_nodeId, config, inputs, boundary) => {
    const payloadCount = Math.max(1, Number(config.payloadCount) || 1);
    const operation = (config.operation as string) || 'copyTo';
    const resetSource = ((config.nonReceiving as string) || 'defaults') === 'defaults';
    // `_includeOriResolved` is baked by preResolveMoveNodes (includeOrientation
    // AND the model being variegated). Honour it so a stale `true` on a
    // non-variegated model can't emit a w_orientation reference that doesn't
    // exist. Fall back to the raw flag if pre-resolve hasn't run.
    const includeOri = config._includeOriResolved !== undefined
      ? !!config._includeOriResolved
      : !!config.includeOrientation;
    const ni = inputs['targetNI'] || '0';
    const b = boundary || 'torus';
    const lines: string[] = [];
    // Resolve target cell index ONCE. Used by every transfer.
    const niLocal = `_msn_ni_${_nodeId}`;
    lines.push(`const ${niLocal} = (${ni}) | 0;`);
    const cellAccess = niCellExprStmts(niLocal, b, `${_nodeId}_msn`);
    lines.push(cellAccess.stmts);
    const nbr = cellAccess.cellExpr;
    lines.push(`if (${niLocal} !== ${0x80000000 | 0} && ${nbr} < total) {`);
    // Emit one transfer per buffer (cell attrs + optional orientation). The read
    // and write both go through the write buffer `w_*`, so values reflect any
    // earlier mid-step writes (post-update semantics).
    const emitTransfer = (buf: string, tmp: string, def: string) => {
      if (operation === 'copyFrom') {
        lines.push(`  ${buf}[idx] = ${buf}[${nbr}];`);
        if (resetSource) lines.push(`  ${buf}[${nbr}] = ${def};`);
      } else if (operation === 'swap') {
        lines.push(`  const ${tmp} = ${buf}[idx];`);
        lines.push(`  ${buf}[idx] = ${buf}[${nbr}];`);
        lines.push(`  ${buf}[${nbr}] = ${tmp};`);
      } else {
        // copyTo (default)
        lines.push(`  ${buf}[${nbr}] = ${buf}[idx];`);
        if (resetSource) lines.push(`  ${buf}[idx] = ${def};`);
      }
    };
    for (let i = 0; i < payloadCount; i++) {
      const attrId = config[`attr_${i}`] as string;
      if (!attrId) continue;
      const def = (config[`_attr_${i}_default`] as string) ?? '0';
      emitTransfer(`w_${attrId}`, `_msn_t${i}_${_nodeId}`, def);
    }
    if (includeOri) emitTransfer('w_orientation', `_msn_tori_${_nodeId}`, '0');
    lines.push(`}`);
    return lines.join('\n') + '\n';
  },
};
