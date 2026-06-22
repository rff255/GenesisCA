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
  compile: (_nodeId, config, inputs, _boundary, ctx) => {
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
    if (ctx?.is3d) {
      // 3D: the r-disk becomes an r-SPHERE — a __ll layer loop + 3D membership
      // (__dx²+__dy²+__dz²<=__r2) + the 3D index (z*_fieldH+y)*_fieldW+x. D2: the
      // membership dz folds to the torus-SHORTEST distance so a sphere near the
      // z-seam wraps correctly (mirrors the x/y wrap below the membership test).
      return `(function(){ const __cx=_agentX[idx],__cy=_agentY[idx],__cz=_agentZ[idx],__r=${radius},__v=${value}; const __r2=__r*__r; const __cmin=Math.floor(__cx-__r),__cmax=Math.ceil(__cx+__r),__rmin=Math.floor(__cy-__r),__rmax=Math.ceil(__cy+__r),__lmin=Math.floor(__cz-__r),__lmax=Math.ceil(__cz+__r); const __hW=_fieldW/2,__hH=_fieldH/2,__hD=_fieldD/2; for(let __ll=__lmin;__ll<=__lmax;__ll++)for(let __rr=__rmin;__rr<=__rmax;__rr++)for(let __cc=__cmin;__cc<=__cmax;__cc++){ let __dx=__cc-__cx,__dy=__rr-__cy,__dz=__ll-__cz; if(_fieldBoundaryTorus){if(__dx>__hW)__dx-=_fieldW;else if(__dx<-__hW)__dx+=_fieldW;if(__dy>__hH)__dy-=_fieldH;else if(__dy<-__hH)__dy+=_fieldH;if(__dz>__hD)__dz-=_fieldD;else if(__dz<-__hD)__dz+=_fieldD;} if(__dx*__dx+__dy*__dy+__dz*__dz>__r2)continue; let __col=__cc,__row=__rr,__lay=__ll; if(_fieldBoundaryTorus){__col=((__col%_fieldW)+_fieldW)%_fieldW;__row=((__row%_fieldH)+_fieldH)%_fieldH;__lay=((__lay%_fieldD)+_fieldD)%_fieldD;}else{if(__col<0||__col>=_fieldW||__row<0||__row>=_fieldH||__lay<0||__lay>=_fieldD)continue;} const __ci=(__lay*_fieldH+__row)*_fieldW+__col; ${field}[__ci]=${apply}; } })();\n`;
    }
    return `(function(){ const __cx=_agentX[idx],__cy=_agentY[idx],__r=${radius},__v=${value}; const __r2=__r*__r; const __cmin=Math.floor(__cx-__r),__cmax=Math.ceil(__cx+__r),__rmin=Math.floor(__cy-__r),__rmax=Math.ceil(__cy+__r); for(let __rr=__rmin;__rr<=__rmax;__rr++)for(let __cc=__cmin;__cc<=__cmax;__cc++){ const __dx=__cc-__cx,__dy=__rr-__cy; if(__dx*__dx+__dy*__dy>__r2)continue; let __col=__cc,__row=__rr; if(_fieldBoundaryTorus){__col=((__col%_fieldW)+_fieldW)%_fieldW;__row=((__row%_fieldH)+_fieldH)%_fieldH;}else{if(__col<0||__col>=_fieldW||__row<0||__row>=_fieldH)continue;} const __ci=__row*_fieldW+__col; ${field}[__ci]=${apply}; } })();\n`;
  },
};
