import type { NodeTypeDef } from '../types';

/** Field Gradient — the spatial gradient (∂x, ∂y) of a CELL attribute at the
 *  agent's position (Bond-Graph Agents, closed feedback). Central differences of
 *  the bilinear field, ±0.5 cell. Drives chemotaxis (move up/down a morphogen)
 *  and gradient-aligned division (wire into Divide Agent's axis). Multi-output:
 *  `dx`/`dy` resolve via the `_v<id>_<port>` convention. */
export const FieldGradientNode: NodeTypeDef = {
  type: 'fieldGradient',
  label: 'Field Gradient',
  description: "The (∂x, ∂y) gradient of a cell attribute (the field) at the agent's position — for chemotaxis.",
  category: 'data',
  color: '#00695c',
  requirements: { bondGraph: true },
  ports: [
    { id: 'dx', label: '∂x', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'dy', label: '∂y', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config) => {
    const attr = config.attributeId as string || '_undef';
    // A local cell-centered bilinear sampler over this attr's field, then central diffs.
    return `const _fs${nodeId}=(px,py)=>{let x0=Math.floor(px),y0=Math.floor(py);const tx=px-x0,ty=py-y0;let x1=x0+1,y1=y0+1;if(_fieldBoundaryTorus){x0=((x0%_fieldW)+_fieldW)%_fieldW;x1=((x1%_fieldW)+_fieldW)%_fieldW;y0=((y0%_fieldH)+_fieldH)%_fieldH;y1=((y1%_fieldH)+_fieldH)%_fieldH;}else{if(x0<0)x0=0;else if(x0>=_fieldW)x0=_fieldW-1;if(x1<0)x1=0;else if(x1>=_fieldW)x1=_fieldW-1;if(y0<0)y0=0;else if(y0>=_fieldH)y0=_fieldH-1;if(y1<0)y1=0;else if(y1>=_fieldH)y1=_fieldH-1;}const f=_field_${attr};return f[y0*_fieldW+x0]*(1-tx)*(1-ty)+f[y0*_fieldW+x1]*tx*(1-ty)+f[y1*_fieldW+x0]*(1-tx)*ty+f[y1*_fieldW+x1]*tx*ty;};\nconst _v${nodeId}_dx=_fs${nodeId}(_agentX[idx]+0.5,_agentY[idx])-_fs${nodeId}(_agentX[idx]-0.5,_agentY[idx]);\nconst _v${nodeId}_dy=_fs${nodeId}(_agentX[idx],_agentY[idx]+0.5)-_fs${nodeId}(_agentX[idx],_agentY[idx]-0.5);\n`;
  },
};
