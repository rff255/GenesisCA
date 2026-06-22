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
  compile: (nodeId, config) => {
    const attr = config.attributeId as string || '_undef';
    return `const _v${nodeId} = (function(){ const fx=_agentX[idx],fy=_agentY[idx]; let x0=Math.floor(fx),y0=Math.floor(fy); const tx=fx-x0,ty=fy-y0; let x1=x0+1,y1=y0+1; if(_fieldBoundaryTorus){x0=((x0%_fieldW)+_fieldW)%_fieldW;x1=((x1%_fieldW)+_fieldW)%_fieldW;y0=((y0%_fieldH)+_fieldH)%_fieldH;y1=((y1%_fieldH)+_fieldH)%_fieldH;}else{if(x0<0)x0=0;else if(x0>=_fieldW)x0=_fieldW-1;if(x1<0)x1=0;else if(x1>=_fieldW)x1=_fieldW-1;if(y0<0)y0=0;else if(y0>=_fieldH)y0=_fieldH-1;if(y1<0)y1=0;else if(y1>=_fieldH)y1=_fieldH-1;} const f=_field_${attr}; return f[y0*_fieldW+x0]*(1-tx)*(1-ty)+f[y0*_fieldW+x1]*tx*(1-ty)+f[y1*_fieldW+x0]*(1-tx)*ty+f[y1*_fieldW+x1]*tx*ty; })();\n`;
  },
};
