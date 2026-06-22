import type { NodeTypeDef } from '../types';

/** Affect Cells Under — write a CELL attribute (the field) over a radius of
 *  cells under the agent (Bond-Graph Agents, closed feedback). The agent
 *  analogue of the brush stamp: radius 0/1 = the cell under the agent; radius r
 *  = the r-disk. The op (set/add/subtract/max/min) is applied to each covered
 *  cell. Writes the cell READ buffer `_field_<attr>` in the DEPOSIT phase BEFORE
 *  the cell step, so the grid rule (which reads `r_`) incorporates it (a
 *  diffusion rule then spreads it). Many agents → one cell is resolved by the
 *  sequential agent loop applying each op in order (add accumulates, max wins) —
 *  a new agent-tier runtime guarantee. NOT async-only. */
export const AffectCellsUnderNode: NodeTypeDef = {
  type: 'affectCellsUnder',
  label: 'Affect Cells Under',
  description: 'Write a cell attribute over a radius of cells under the agent (deposit into the field before the cell step).',
  category: 'output',
  color: '#00695c',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    { id: 'radius', label: 'Radius', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
  ],
  defaultConfig: { attributeId: '', op: 'add' },
  compile: (_nodeId, config, inputs) => {
    const attr = config.attributeId as string || '_undef';
    const op = config.op as string || 'add';
    const value = inputs['value'] || '1';
    const radius = inputs['radius'] || '1';
    const field = `_field_${attr}`;
    const apply =
      op === 'set' ? '__v'
      : op === 'subtract' ? `${field}[__ci]-__v`
      : op === 'max' ? `Math.max(${field}[__ci],__v)`
      : op === 'min' ? `Math.min(${field}[__ci],__v)`
      : `${field}[__ci]+__v`; // add (default)
    return `(function(){ const __cx=_agentX[idx],__cy=_agentY[idx],__r=${radius},__v=${value}; const __r2=__r*__r; const __cmin=Math.floor(__cx-__r),__cmax=Math.ceil(__cx+__r),__rmin=Math.floor(__cy-__r),__rmax=Math.ceil(__cy+__r); for(let __rr=__rmin;__rr<=__rmax;__rr++)for(let __cc=__cmin;__cc<=__cmax;__cc++){ const __dx=__cc-__cx,__dy=__rr-__cy; if(__dx*__dx+__dy*__dy>__r2)continue; let __col=__cc,__row=__rr; if(_fieldBoundaryTorus){__col=((__col%_fieldW)+_fieldW)%_fieldW;__row=((__row%_fieldH)+_fieldH)%_fieldH;}else{if(__col<0||__col>=_fieldW||__row<0||__row>=_fieldH)continue;} const __ci=__row*_fieldW+__col; ${field}[__ci]=${apply}; } })();\n`;
  },
};
