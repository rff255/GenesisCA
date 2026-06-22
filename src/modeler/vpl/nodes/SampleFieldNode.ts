import type { NodeTypeDef } from '../types';

/** Sample Field — bilinearly read a CELL attribute (the morphogen field) at the
 *  agent's continuous position (Bond-Graph Agents, closed feedback). The field
 *  IS the lattice CA (Decision D-FIELD): every cell attribute doubles as a
 *  diffusible field the agents sense. Cell-centered sampling (cell index =
 *  centre; the fractional part lerps toward the neighbour cells). Reads the cell
 *  read buffer `_field_<attr>` (sized W·H, distinct from the agent attribute
 *  `r_<attr>`). Gather happens AFTER the cell step in the generation loop. */
export const SampleFieldNode: NodeTypeDef = {
  type: 'sampleField',
  label: 'Sample Field',
  description: "Bilinearly read a cell attribute (the field) at the agent's continuous position.",
  category: 'data',
  color: '#00695c',
  requirements: { bondGraph: true },
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, _inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    if (ctx?.is3d) {
      // 3D: trilinear 8-corner read of _field_<attr> at (agentX, agentY, agentZ).
      // index = (z*_fieldH + y)*_fieldW + x. Emit `_fieldW*_fieldH` inline (D1 — no _fieldWH).
      return `const _v${nodeId} = (function(){ const fx=_agentX[idx],fy=_agentY[idx],fz=_agentZ[idx]; let x0=Math.floor(fx),y0=Math.floor(fy),z0=Math.floor(fz); const tx=fx-x0,ty=fy-y0,tz=fz-z0; let x1=x0+1,y1=y0+1,z1=z0+1; if(_fieldBoundaryTorus){x0=((x0%_fieldW)+_fieldW)%_fieldW;x1=((x1%_fieldW)+_fieldW)%_fieldW;y0=((y0%_fieldH)+_fieldH)%_fieldH;y1=((y1%_fieldH)+_fieldH)%_fieldH;z0=((z0%_fieldD)+_fieldD)%_fieldD;z1=((z1%_fieldD)+_fieldD)%_fieldD;}else{if(x0<0)x0=0;else if(x0>=_fieldW)x0=_fieldW-1;if(x1<0)x1=0;else if(x1>=_fieldW)x1=_fieldW-1;if(y0<0)y0=0;else if(y0>=_fieldH)y0=_fieldH-1;if(y1<0)y1=0;else if(y1>=_fieldH)y1=_fieldH-1;if(z0<0)z0=0;else if(z0>=_fieldD)z0=_fieldD-1;if(z1<0)z1=0;else if(z1>=_fieldD)z1=_fieldD-1;} const f=_field_${attr}; const c000=f[(z0*_fieldH+y0)*_fieldW+x0],c100=f[(z0*_fieldH+y0)*_fieldW+x1],c010=f[(z0*_fieldH+y1)*_fieldW+x0],c110=f[(z0*_fieldH+y1)*_fieldW+x1],c001=f[(z1*_fieldH+y0)*_fieldW+x0],c101=f[(z1*_fieldH+y0)*_fieldW+x1],c011=f[(z1*_fieldH+y1)*_fieldW+x0],c111=f[(z1*_fieldH+y1)*_fieldW+x1]; const c00=c000*(1-tx)+c100*tx,c10=c010*(1-tx)+c110*tx,c01=c001*(1-tx)+c101*tx,c11=c011*(1-tx)+c111*tx; const c0=c00*(1-ty)+c10*ty,c1=c01*(1-ty)+c11*ty; return c0*(1-tz)+c1*tz; })();\n`;
    }
    return `const _v${nodeId} = (function(){ const fx=_agentX[idx],fy=_agentY[idx]; let x0=Math.floor(fx),y0=Math.floor(fy); const tx=fx-x0,ty=fy-y0; let x1=x0+1,y1=y0+1; if(_fieldBoundaryTorus){x0=((x0%_fieldW)+_fieldW)%_fieldW;x1=((x1%_fieldW)+_fieldW)%_fieldW;y0=((y0%_fieldH)+_fieldH)%_fieldH;y1=((y1%_fieldH)+_fieldH)%_fieldH;}else{if(x0<0)x0=0;else if(x0>=_fieldW)x0=_fieldW-1;if(x1<0)x1=0;else if(x1>=_fieldW)x1=_fieldW-1;if(y0<0)y0=0;else if(y0>=_fieldH)y0=_fieldH-1;if(y1<0)y1=0;else if(y1>=_fieldH)y1=_fieldH-1;} const f=_field_${attr}; return f[y0*_fieldW+x0]*(1-tx)*(1-ty)+f[y0*_fieldW+x1]*tx*(1-ty)+f[y1*_fieldW+x0]*(1-tx)*ty+f[y1*_fieldW+x1]*tx*ty; })();\n`;
  },
};
