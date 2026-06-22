import type { NodeTypeDef } from '../types';

/** Read Cells Under — aggregate a CELL attribute (the field) over an r-disk of
 *  cells under the agent (Bond-Graph Agents, closed feedback). The disk sibling
 *  of Sample Field (a point read): mean / sum / max / min over the cells within
 *  `radius`. Reads the cell read buffer after the cell step. */
export const ReadCellsUnderNode: NodeTypeDef = {
  type: 'readCellsUnder',
  label: 'Read Cells Under',
  description: 'Aggregate a cell attribute (mean/sum/max/min) over the cells within a radius under the agent.',
  category: 'data',
  color: '#00695c',
  requirements: { bondGraph: true },
  ports: [
    { id: 'radius', label: 'Radius', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '2' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: { attributeId: '', reduce: 'mean' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const reduce = config.reduce as string || 'mean';
    const radius = inputs['radius'] || '2';
    const field = `_field_${attr}`;
    const init = reduce === 'max' ? '-Infinity' : reduce === 'min' ? 'Infinity' : '0';
    const acc =
      reduce === 'max' ? 'if(__val>__acc)__acc=__val;'
      : reduce === 'min' ? 'if(__val<__acc)__acc=__val;'
      : '__acc+=__val;'; // sum / mean
    const finish = reduce === 'mean' ? '(__n>0?__acc/__n:0)' : reduce === 'max' || reduce === 'min' ? '(__n>0?__acc:0)' : '__acc';
    if (ctx?.is3d) {
      // 3D: the r-disk becomes an r-SPHERE (a __ll layer loop + 3D membership +
      // the 3D index). D2: the membership dz folds to the torus-shortest distance
      // so the sphere wraps correctly near the z-seam.
      return `const _v${nodeId}=(function(){ const __cx=_agentX[idx],__cy=_agentY[idx],__cz=_agentZ[idx],__r=${radius},__r2=__r*__r; let __acc=${init},__n=0; const __cmin=Math.floor(__cx-__r),__cmax=Math.ceil(__cx+__r),__rmin=Math.floor(__cy-__r),__rmax=Math.ceil(__cy+__r),__lmin=Math.floor(__cz-__r),__lmax=Math.ceil(__cz+__r); const __hW=_fieldW/2,__hH=_fieldH/2,__hD=_fieldD/2; for(let __ll=__lmin;__ll<=__lmax;__ll++)for(let __rr=__rmin;__rr<=__rmax;__rr++)for(let __cc=__cmin;__cc<=__cmax;__cc++){ let __dx=__cc-__cx,__dy=__rr-__cy,__dz=__ll-__cz; if(_fieldBoundaryTorus){if(__dx>__hW)__dx-=_fieldW;else if(__dx<-__hW)__dx+=_fieldW;if(__dy>__hH)__dy-=_fieldH;else if(__dy<-__hH)__dy+=_fieldH;if(__dz>__hD)__dz-=_fieldD;else if(__dz<-__hD)__dz+=_fieldD;} if(__dx*__dx+__dy*__dy+__dz*__dz>__r2)continue; let __col=__cc,__row=__rr,__lay=__ll; if(_fieldBoundaryTorus){__col=((__col%_fieldW)+_fieldW)%_fieldW;__row=((__row%_fieldH)+_fieldH)%_fieldH;__lay=((__lay%_fieldD)+_fieldD)%_fieldD;}else{if(__col<0||__col>=_fieldW||__row<0||__row>=_fieldH||__lay<0||__lay>=_fieldD)continue;} const __val=${field}[(__lay*_fieldH+__row)*_fieldW+__col]; ${acc} __n++; } return ${finish}; })();\n`;
    }
    return `const _v${nodeId}=(function(){ const __cx=_agentX[idx],__cy=_agentY[idx],__r=${radius},__r2=__r*__r; let __acc=${init},__n=0; const __cmin=Math.floor(__cx-__r),__cmax=Math.ceil(__cx+__r),__rmin=Math.floor(__cy-__r),__rmax=Math.ceil(__cy+__r); for(let __rr=__rmin;__rr<=__rmax;__rr++)for(let __cc=__cmin;__cc<=__cmax;__cc++){ const __dx=__cc-__cx,__dy=__rr-__cy; if(__dx*__dx+__dy*__dy>__r2)continue; let __col=__cc,__row=__rr; if(_fieldBoundaryTorus){__col=((__col%_fieldW)+_fieldW)%_fieldW;__row=((__row%_fieldH)+_fieldH)%_fieldH;}else{if(__col<0||__col>=_fieldW||__row<0||__row>=_fieldH)continue;} const __val=${field}[__row*_fieldW+__col]; ${acc} __n++; } return ${finish}; })();\n`;
  },
};
