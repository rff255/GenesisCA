import type { NodeTypeDef } from '../types';

/** Secrete To Field — deposit a `rate` into a CELL attribute (the field) at the
 *  agent's continuous position via a bilinear 4-cell splat (Bond-Graph Agents,
 *  closed feedback). A negative rate CONSUMES (the sink that creates a depletion
 *  gradient — e.g. O2 uptake). Writes the cell READ buffer in the deposit phase
 *  before the cell step; the splat accumulates (many agents → one cell sums).
 *  The smooth (sub-cell) sibling of Affect Cells Under. NOT async-only. */
export const SecreteToFieldNode: NodeTypeDef = {
  type: 'secreteToField',
  label: 'Secrete To Field',
  description: "Deposit a rate into a cell attribute at the agent's position (bilinear splat; negative = consume).",
  category: 'output',
  color: '#00695c',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'rate', label: 'Rate', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (_nodeId, config, inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const rate = inputs['rate'] || '1';
    const field = `_field_${attr}`;
    if (ctx?.is3d) {
      // 3D: an 8-cell trilinear splat. The 8 trilinear weights sum to 1, so the
      // total deposit is __rate. index = (z*_fieldH + y)*_fieldW + x.
      return `(function(){ const fx=_agentX[idx],fy=_agentY[idx],fz=_agentZ[idx],__rate=${rate}; let x0=Math.floor(fx),y0=Math.floor(fy),z0=Math.floor(fz); const tx=fx-x0,ty=fy-y0,tz=fz-z0; let x1=x0+1,y1=y0+1,z1=z0+1; if(_fieldBoundaryTorus){x0=((x0%_fieldW)+_fieldW)%_fieldW;x1=((x1%_fieldW)+_fieldW)%_fieldW;y0=((y0%_fieldH)+_fieldH)%_fieldH;y1=((y1%_fieldH)+_fieldH)%_fieldH;z0=((z0%_fieldD)+_fieldD)%_fieldD;z1=((z1%_fieldD)+_fieldD)%_fieldD;}else{if(x0<0)x0=0;else if(x0>=_fieldW)x0=_fieldW-1;if(x1<0)x1=0;else if(x1>=_fieldW)x1=_fieldW-1;if(y0<0)y0=0;else if(y0>=_fieldH)y0=_fieldH-1;if(y1<0)y1=0;else if(y1>=_fieldH)y1=_fieldH-1;if(z0<0)z0=0;else if(z0>=_fieldD)z0=_fieldD-1;if(z1<0)z1=0;else if(z1>=_fieldD)z1=_fieldD-1;} const f=${field}; f[(z0*_fieldH+y0)*_fieldW+x0]+=__rate*(1-tx)*(1-ty)*(1-tz); f[(z0*_fieldH+y0)*_fieldW+x1]+=__rate*tx*(1-ty)*(1-tz); f[(z0*_fieldH+y1)*_fieldW+x0]+=__rate*(1-tx)*ty*(1-tz); f[(z0*_fieldH+y1)*_fieldW+x1]+=__rate*tx*ty*(1-tz); f[(z1*_fieldH+y0)*_fieldW+x0]+=__rate*(1-tx)*(1-ty)*tz; f[(z1*_fieldH+y0)*_fieldW+x1]+=__rate*tx*(1-ty)*tz; f[(z1*_fieldH+y1)*_fieldW+x0]+=__rate*(1-tx)*ty*tz; f[(z1*_fieldH+y1)*_fieldW+x1]+=__rate*tx*ty*tz; })();\n`;
    }
    return `(function(){ const fx=_agentX[idx],fy=_agentY[idx],__rate=${rate}; let x0=Math.floor(fx),y0=Math.floor(fy); const tx=fx-x0,ty=fy-y0; let x1=x0+1,y1=y0+1; if(_fieldBoundaryTorus){x0=((x0%_fieldW)+_fieldW)%_fieldW;x1=((x1%_fieldW)+_fieldW)%_fieldW;y0=((y0%_fieldH)+_fieldH)%_fieldH;y1=((y1%_fieldH)+_fieldH)%_fieldH;}else{if(x0<0)x0=0;else if(x0>=_fieldW)x0=_fieldW-1;if(x1<0)x1=0;else if(x1>=_fieldW)x1=_fieldW-1;if(y0<0)y0=0;else if(y0>=_fieldH)y0=_fieldH-1;if(y1<0)y1=0;else if(y1>=_fieldH)y1=_fieldH-1;} const f=${field}; f[y0*_fieldW+x0]+=__rate*(1-tx)*(1-ty); f[y0*_fieldW+x1]+=__rate*tx*(1-ty); f[y1*_fieldW+x0]+=__rate*(1-tx)*ty; f[y1*_fieldW+x1]+=__rate*tx*ty; })();\n`;
  },
};
