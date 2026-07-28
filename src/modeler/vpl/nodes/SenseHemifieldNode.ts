import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';
import { viewCosHalf, viewHeadingExprs } from './GetAgentsInViewNode';

/** Sense Hemifield — the Braitenberg LEFT / RIGHT sensor. Counts the nearby agents
 *  inside a heading-relative vision cone (same cone as Get Agents In View), SPLIT
 *  by which side of the heading they fall on. Outputs `Left Count` + `Right Count`;
 *  steer by their difference (a positive Left−Right turns toward the crowd, a
 *  negative turns away). Reuses the SAME 3×3(×3) spatial-hash gather + cone test as
 *  Get Agents In View (so it adds no SoA/ABI and shares the exact cone math), then
 *  splits each in-view neighbour by the sign of the heading-relative cross product:
 *
 *    2D:  cross = hx·dy − hy·dx                        (the z-component of h × offset)
 *    3D:  cross = det[heading, offset, up]             (triple product)
 *         up = +Z normally, swapped to +Y when the heading is near-vertical (so the
 *         XY cross doesn't degenerate). det[h,o,+Z] = hx·dy − hy·dx (reduces to the
 *         2D form); det[h,o,+Y] = hz·dx − hx·dz.
 *
 *  `cross ≥ 0` ⇒ LEFT, else RIGHT (a deterministic tie-break toward Left). A ZERO
 *  heading (a still agent under the `velocity` source) has no defined side, so the
 *  cone gate is omnidirectional and every in-range neighbour tallies as Left.
 *  `halfAngle = 180°` = omnidirectional (all in-range neighbours, split L/R).
 *  Per-agent, behaviour-graph only. Multi-output (`_v<id>_<port>`).
 *
 *  `config.visionColor` (optional `#rrggbb`) is DISPLAY-ONLY — the simulator's
 *  vision-cone overlay tints THIS node's wedges with it instead of picking the
 *  next automatic palette slot. Absent ⇒ the palette. No compiler emit reads
 *  it on any target. */
export const SenseHemifieldNode: NodeTypeDef = {
  type: 'senseHemifield',
  label: 'Sense Hemifield',
  description: 'Count nearby agents in the LEFT vs RIGHT half of a heading-relative vision cone — the Braitenberg L/R sensor. Steer by Left − Right. Set how far it senses with the Radius input (inline number, default 5) and how wide with Half-angle°. Heading = Velocity, Wired, or Facing (a stored vector agent-attribute — needs the Orientation capability). Optional Cone color tints its wedges in the simulator vision display.',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'radius', label: 'Radius', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '5' },
    { id: 'headingX', label: 'Heading X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'headingY', label: 'Heading Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'headingZ', label: 'Heading Z', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'leftCount', label: 'Left Count', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'rightCount', label: 'Right Count', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // Heading X/Y/Z only meaningful under the Wired source; Z only in a 3D model.
  hiddenPorts: (config, model) => {
    const wired = config.headingSource === 'wired';
    const is3d = !!model && is3dModelLike(model);
    const hidden: string[] = [];
    if (!wired) { hidden.push('headingX', 'headingY', 'headingZ'); }
    else if (!is3d) { hidden.push('headingZ'); }
    return hidden;
  },
  // 90° half-angle ⇒ a 180° front hemisphere split L/R (the classic Braitenberg field).
  defaultConfig: { halfAngle: '90', headingSource: 'velocity' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const r = inputs['radius'] || '5';
    const V = `_v${nodeId}`;
    const is3d = !!ctx?.is3d;
    const { cosHalf, omni } = viewCosHalf(config);
    const { hx, hy, hz } = viewHeadingExprs(config, inputs, is3d);
    const L = `__shL${nodeId}`, R = `__shR${nodeId}`;

    // Heading-relative side (see the node doc). `__upY` (3D only) selects the +Y
    // up-reference for a near-vertical heading; computed ONCE per agent (heading is
    // loop-invariant across the neighbour scan). cross ≥ 0 ⇒ Left, else Right.
    const crossExpr = is3d
      ? `(__upY?(__hz*__dx-__hx*__dz):(__hx*__dy-__hy*__dx))`
      : `(__hx*__dy-__hy*__dx)`;
    const tally = `{const __cross=${crossExpr};if(__cross>=0)${L}++;else ${R}++;}`;
    // In-cone gate → tally. Reuses `__dx/__dy[/__dz]` (torus-folded offset) + `__d2`
    // from the gather. Omni (halfAngle≥180) skips the cone (all in-range split L/R);
    // `__hm2===0` (zero heading) ⇒ omnidirectional (every in-range neighbour ⇒ Left).
    const dotExpr = is3d ? `__hx*__dx+__hy*__dy+__hz*__dz` : `__hx*__dx+__hy*__dy`;
    const body = omni
      ? tally
      : `if(__hm2===0){${tally}}else{const __dot=${dotExpr},__d=Math.sqrt(__d2);if(__dot>=(${cosHalf}*__hm)*__d)${tally}}`;

    if (is3d) {
      const test3 = (jExpr: string) =>
        `{const __j=${jExpr}; if(__j!==idx&&_alive[__j]){let __dx=_agentX[__j]-__xi,__dy=_agentY[__j]-__yi,__dz=_agentZ[__j]-__zi; if(__tor){if(__dx>__hW)__dx-=__W;else if(__dx<-__hW)__dx+=__W;if(__dy>__hH)__dy-=__H;else if(__dy<-__hH)__dy+=__H;if(__dz>__hD)__dz-=__D;else if(__dz<-__hD)__dz+=__D;} const __d2=__dx*__dx+__dy*__dy+__dz*__dz; if(__d2<=__r2){${body}}}}`;
      return `let ${L}=0,${R}=0;{const __qr=${r},__r2=__qr*__qr,__xi=_agentX[idx],__yi=_agentY[idx],__zi=_agentZ[idx],__W=_fieldW,__H=_fieldH,__D=_fieldD,__hW=__W/2,__hH=__H/2,__hD=__D/2,__tor=_fieldBoundaryTorus,__hx=${hx},__hy=${hy},__hz=${hz},__hm2=__hx*__hx+__hy*__hy+__hz*__hz,__hm=Math.sqrt(__hm2),__upY=__hz*__hz>0.81*__hm2;`
        + `if(_hashValid){let __bx=((__xi-_hashOriginX)/_hashBinSizeX)|0;if(__bx<0)__bx=0;else if(__bx>=_hashNBinsX)__bx=_hashNBinsX-1;let __by=((__yi-_hashOriginY)/_hashBinSizeY)|0;if(__by<0)__by=0;else if(__by>=_hashNBinsY)__by=_hashNBinsY-1;let __bz=((__zi-_hashOriginZ)/_hashBinSizeZ)|0;if(__bz<0)__bz=0;else if(__bz>=_hashNBinsZ)__bz=_hashNBinsZ-1;`
        + `for(let __ez=-1;__ez<=1;__ez++)for(let __ey=-1;__ey<=1;__ey++)for(let __ex=-1;__ex<=1;__ex++){let __nbx=__bx+__ex,__nby=__by+__ey,__nbz=__bz+__ez;if(__tor){__nbx=((__nbx%_hashNBinsX)+_hashNBinsX)%_hashNBinsX;__nby=((__nby%_hashNBinsY)+_hashNBinsY)%_hashNBinsY;__nbz=((__nbz%_hashNBinsZ)+_hashNBinsZ)%_hashNBinsZ;}else{if(__nbx<0||__nbx>=_hashNBinsX||__nby<0||__nby>=_hashNBinsY||__nbz<0||__nbz>=_hashNBinsZ)continue;}const __b=(__nbz*_hashNBinsY+__nby)*_hashNBinsX+__nbx;for(let __p=_hashBinStart[__b];__p<_hashBinStart[__b+1];__p++)${test3('_hashBinAgents[__p]')}}`
        + `}else{for(let __all=0;__all<highWater;__all++)${test3('__all')}}}`
        + `const ${V}_leftCount=${L},${V}_rightCount=${R};\n`;
    }
    // 2D
    const test = (jExpr: string) =>
      `{const __j=${jExpr}; if(__j!==idx&&_alive[__j]){let __dx=_agentX[__j]-__xi,__dy=_agentY[__j]-__yi; if(__tor){if(__dx>__hW)__dx-=__W;else if(__dx<-__hW)__dx+=__W;if(__dy>__hH)__dy-=__H;else if(__dy<-__hH)__dy+=__H;} const __d2=__dx*__dx+__dy*__dy; if(__d2<=__r2){${body}}}}`;
    return `let ${L}=0,${R}=0;{const __qr=${r},__r2=__qr*__qr,__xi=_agentX[idx],__yi=_agentY[idx],__W=_fieldW,__H=_fieldH,__hW=__W/2,__hH=__H/2,__tor=_fieldBoundaryTorus,__hx=${hx},__hy=${hy},__hm2=__hx*__hx+__hy*__hy,__hm=Math.sqrt(__hm2);`
      + `if(_hashValid){let __bx=((__xi-_hashOriginX)/_hashBinSizeX)|0;if(__bx<0)__bx=0;else if(__bx>=_hashNBinsX)__bx=_hashNBinsX-1;let __by=((__yi-_hashOriginY)/_hashBinSizeY)|0;if(__by<0)__by=0;else if(__by>=_hashNBinsY)__by=_hashNBinsY-1;`
      + `for(let __ey=-1;__ey<=1;__ey++)for(let __ex=-1;__ex<=1;__ex++){let __nbx=__bx+__ex,__nby=__by+__ey;if(__tor){__nbx=((__nbx%_hashNBinsX)+_hashNBinsX)%_hashNBinsX;__nby=((__nby%_hashNBinsY)+_hashNBinsY)%_hashNBinsY;}else{if(__nbx<0||__nbx>=_hashNBinsX||__nby<0||__nby>=_hashNBinsY)continue;}const __b=__nby*_hashNBinsX+__nbx;for(let __p=_hashBinStart[__b];__p<_hashBinStart[__b+1];__p++)${test('_hashBinAgents[__p]')}}`
      + `}else{for(let __all=0;__all<highWater;__all++)${test('__all')}}}`
      + `const ${V}_leftCount=${L},${V}_rightCount=${R};\n`;
  },
};
