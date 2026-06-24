import type { NodeTypeDef } from '../types';

/** Get Nearby Agents — the array of OTHER agents within `radius` of this agent
 *  (Bond-Graph Agents). The agent analogue of Get All Neighbor Indexes: it
 *  outputs a list of agent ids you iterate with For Each In Array, then read
 *  each via Get Agent Position / Get Agent Attribute / Get Agent Radius, form/
 *  break bonds to, apply forces from (flocking), etc. Queried against the
 *  engine's per-step uniform spatial hash (O(N)); the query radius should be
 *  ≤ the model's Neighbour Query Radius (Properties › Forces) so the hash bins
 *  cover it. Per-agent (never hoisted). */
export const GetNearbyAgentsNode: NodeTypeDef = {
  type: 'getNearbyAgents',
  label: 'Get Nearby Agents',
  description: 'Outputs the list of other agents within a radius — iterate with For Each In Array to read/bond/steer.',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'radius', label: 'Radius', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '5' },
    { id: 'agents', label: 'Agents', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs, _boundary, ctx) => {
    const r = inputs['radius'] || '5';
    const V = `_v${nodeId}`;
    if (ctx?.is3d) {
      // 3D: include the Z axis in the distance test (+ torus fold against _fieldD)
      // and query the 3D spatial hash — a 3×3×3 stencil with the 3D bin index
      // (nbz*NBinsY+nby)*NBinsX+nbx, matching the worker's hash layout + the
      // (3D-aware) WASM emitter. The 2D path below was silently wrong in 3D
      // (XY-only distance + 2D bin index). `_agentZ`/`_fieldD`/`_hashNBinsZ`/
      // `_hashBinSizeZ` ride the agent-loop signature only in 3D.
      const test3 = (jExpr: string) =>
        `{const __j=${jExpr}; if(__j!==idx&&_alive[__j]){let __dx=_agentX[__j]-__xi,__dy=_agentY[__j]-__yi,__dz=_agentZ[__j]-__zi; if(__tor){if(__dx>__hW)__dx-=__W;else if(__dx<-__hW)__dx+=__W;if(__dy>__hH)__dy-=__H;else if(__dy<-__hH)__dy+=__H;if(__dz>__hD)__dz-=__D;else if(__dz<-__hD)__dz+=__D;} if(__dx*__dx+__dy*__dy+__dz*__dz<=__r2)${V}.push(__j);}}`;
      return `const ${V}=[];{const __qr=${r},__r2=__qr*__qr,__xi=_agentX[idx],__yi=_agentY[idx],__zi=_agentZ[idx],__W=_fieldW,__H=_fieldH,__D=_fieldD,__hW=__W/2,__hH=__H/2,__hD=__D/2,__tor=_fieldBoundaryTorus;`
        + `if(_hashValid){let __bx=(__xi/_hashBinSizeX)|0;if(__bx<0)__bx=0;else if(__bx>=_hashNBinsX)__bx=_hashNBinsX-1;let __by=(__yi/_hashBinSizeY)|0;if(__by<0)__by=0;else if(__by>=_hashNBinsY)__by=_hashNBinsY-1;let __bz=(__zi/_hashBinSizeZ)|0;if(__bz<0)__bz=0;else if(__bz>=_hashNBinsZ)__bz=_hashNBinsZ-1;`
        + `for(let __ez=-1;__ez<=1;__ez++)for(let __ey=-1;__ey<=1;__ey++)for(let __ex=-1;__ex<=1;__ex++){let __nbx=__bx+__ex,__nby=__by+__ey,__nbz=__bz+__ez;if(__tor){__nbx=((__nbx%_hashNBinsX)+_hashNBinsX)%_hashNBinsX;__nby=((__nby%_hashNBinsY)+_hashNBinsY)%_hashNBinsY;__nbz=((__nbz%_hashNBinsZ)+_hashNBinsZ)%_hashNBinsZ;}else{if(__nbx<0||__nbx>=_hashNBinsX||__nby<0||__nby>=_hashNBinsY||__nbz<0||__nbz>=_hashNBinsZ)continue;}const __b=(__nbz*_hashNBinsY+__nby)*_hashNBinsX+__nbx;for(let __p=_hashBinStart[__b];__p<_hashBinStart[__b+1];__p++)${test3('_hashBinAgents[__p]')}}`
        + `}else{for(let __all=0;__all<highWater;__all++)${test3('__all')}}}\n`;
    }
    // 2D path (unchanged). Inlined twice (hash path + all-pairs fallback) to avoid a per-agent closure.
    const test = (jExpr: string) =>
      `{const __j=${jExpr}; if(__j!==idx&&_alive[__j]){let __dx=_agentX[__j]-__xi,__dy=_agentY[__j]-__yi; if(__tor){if(__dx>__hW)__dx-=__W;else if(__dx<-__hW)__dx+=__W;if(__dy>__hH)__dy-=__H;else if(__dy<-__hH)__dy+=__H;} if(__dx*__dx+__dy*__dy<=__r2)${V}.push(__j);}}`;
    return `const ${V}=[];{const __qr=${r},__r2=__qr*__qr,__xi=_agentX[idx],__yi=_agentY[idx],__W=_fieldW,__H=_fieldH,__hW=__W/2,__hH=__H/2,__tor=_fieldBoundaryTorus;`
      + `if(_hashValid){let __bx=(__xi/_hashBinSizeX)|0;if(__bx<0)__bx=0;else if(__bx>=_hashNBinsX)__bx=_hashNBinsX-1;let __by=(__yi/_hashBinSizeY)|0;if(__by<0)__by=0;else if(__by>=_hashNBinsY)__by=_hashNBinsY-1;`
      + `for(let __ey=-1;__ey<=1;__ey++)for(let __ex=-1;__ex<=1;__ex++){let __nbx=__bx+__ex,__nby=__by+__ey;if(__tor){__nbx=((__nbx%_hashNBinsX)+_hashNBinsX)%_hashNBinsX;__nby=((__nby%_hashNBinsY)+_hashNBinsY)%_hashNBinsY;}else{if(__nbx<0||__nbx>=_hashNBinsX||__nby<0||__nby>=_hashNBinsY)continue;}const __b=__nby*_hashNBinsX+__nbx;for(let __p=_hashBinStart[__b];__p<_hashBinStart[__b+1];__p++)${test('_hashBinAgents[__p]')}}`
      + `}else{for(let __all=0;__all<highWater;__all++)${test('__all')}}}\n`;
  },
};
