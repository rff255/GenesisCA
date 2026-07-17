import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Field Gradient — the spatial gradient (∂x, ∂y) of a CELL attribute at the
 *  agent's position (Bond-Graph Agents, closed feedback). Central differences of
 *  the bilinear field, ±0.5 cell. Drives chemotaxis (move up/down a morphogen)
 *  and gradient-aligned division (wire into Divide Agent's axis). Multi-output:
 *  `dx`/`dy` resolve via the `_v<id>_<port>` convention. */
export const FieldGradientNode: NodeTypeDef = {
  type: 'fieldGradient',
  label: 'Field Gradient',
  agentLabel: 'Field Gradient (CA Grid)',
  description: "The (∂x, ∂y) gradient of a cell attribute (the field) at the agent's position — for chemotaxis.",
  category: 'data',
  color: '#00695c',
  requirements: { bondGraph: true },
  ports: [
    { id: 'dx', label: '∂x', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'dy', label: '∂y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'dz', label: '∂z', kind: 'output', category: 'value', dataType: 'float' },
  ],
  // The ∂z output only exists in a 3D-agent model.
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['dz']),
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, _inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    if (ctx?.is3d) {
      // 3D: a trilinear sampler over this attr's field, then central diffs on all 3 axes.
      // index = (z*_fieldH + y)*_fieldW + x (the grid's (layer*H+row)*W+col).
      return `const _fs${nodeId}=(px,py,pz)=>{let x0=Math.floor(px),y0=Math.floor(py),z0=Math.floor(pz);const tx=px-x0,ty=py-y0,tz=pz-z0;let x1=x0+1,y1=y0+1,z1=z0+1;if(_fieldBoundaryTorus){x0=((x0%_fieldW)+_fieldW)%_fieldW;x1=((x1%_fieldW)+_fieldW)%_fieldW;y0=((y0%_fieldH)+_fieldH)%_fieldH;y1=((y1%_fieldH)+_fieldH)%_fieldH;z0=((z0%_fieldD)+_fieldD)%_fieldD;z1=((z1%_fieldD)+_fieldD)%_fieldD;}else{if(x0<0)x0=0;else if(x0>=_fieldW)x0=_fieldW-1;if(x1<0)x1=0;else if(x1>=_fieldW)x1=_fieldW-1;if(y0<0)y0=0;else if(y0>=_fieldH)y0=_fieldH-1;if(y1<0)y1=0;else if(y1>=_fieldH)y1=_fieldH-1;if(z0<0)z0=0;else if(z0>=_fieldD)z0=_fieldD-1;if(z1<0)z1=0;else if(z1>=_fieldD)z1=_fieldD-1;}const f=_field_${attr};const c000=f[(z0*_fieldH+y0)*_fieldW+x0],c100=f[(z0*_fieldH+y0)*_fieldW+x1],c010=f[(z0*_fieldH+y1)*_fieldW+x0],c110=f[(z0*_fieldH+y1)*_fieldW+x1],c001=f[(z1*_fieldH+y0)*_fieldW+x0],c101=f[(z1*_fieldH+y0)*_fieldW+x1],c011=f[(z1*_fieldH+y1)*_fieldW+x0],c111=f[(z1*_fieldH+y1)*_fieldW+x1];const c00=c000*(1-tx)+c100*tx,c10=c010*(1-tx)+c110*tx,c01=c001*(1-tx)+c101*tx,c11=c011*(1-tx)+c111*tx;const c0=c00*(1-ty)+c10*ty,c1=c01*(1-ty)+c11*ty;return c0*(1-tz)+c1*tz;};\nconst _v${nodeId}_dx=_fs${nodeId}(_agentX[idx]+0.5,_agentY[idx],_agentZ[idx])-_fs${nodeId}(_agentX[idx]-0.5,_agentY[idx],_agentZ[idx]);\nconst _v${nodeId}_dy=_fs${nodeId}(_agentX[idx],_agentY[idx]+0.5,_agentZ[idx])-_fs${nodeId}(_agentX[idx],_agentY[idx]-0.5,_agentZ[idx]);\nconst _v${nodeId}_dz=_fs${nodeId}(_agentX[idx],_agentY[idx],_agentZ[idx]+0.5)-_fs${nodeId}(_agentX[idx],_agentY[idx],_agentZ[idx]-0.5);\n`;
    }
    // A local cell-centered bilinear sampler over this attr's field, then central diffs.
    return `const _fs${nodeId}=(px,py)=>{let x0=Math.floor(px),y0=Math.floor(py);const tx=px-x0,ty=py-y0;let x1=x0+1,y1=y0+1;if(_fieldBoundaryTorus){x0=((x0%_fieldW)+_fieldW)%_fieldW;x1=((x1%_fieldW)+_fieldW)%_fieldW;y0=((y0%_fieldH)+_fieldH)%_fieldH;y1=((y1%_fieldH)+_fieldH)%_fieldH;}else{if(x0<0)x0=0;else if(x0>=_fieldW)x0=_fieldW-1;if(x1<0)x1=0;else if(x1>=_fieldW)x1=_fieldW-1;if(y0<0)y0=0;else if(y0>=_fieldH)y0=_fieldH-1;if(y1<0)y1=0;else if(y1>=_fieldH)y1=_fieldH-1;}const f=_field_${attr};return f[y0*_fieldW+x0]*(1-tx)*(1-ty)+f[y0*_fieldW+x1]*tx*(1-ty)+f[y1*_fieldW+x0]*(1-tx)*ty+f[y1*_fieldW+x1]*tx*ty;};\nconst _v${nodeId}_dx=_fs${nodeId}(_agentX[idx]+0.5,_agentY[idx])-_fs${nodeId}(_agentX[idx]-0.5,_agentY[idx]);\nconst _v${nodeId}_dy=_fs${nodeId}(_agentX[idx],_agentY[idx]+0.5)-_fs${nodeId}(_agentX[idx],_agentY[idx]-0.5);\n`;
  },
};
