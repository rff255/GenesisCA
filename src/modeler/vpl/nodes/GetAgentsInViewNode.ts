import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Half-angle (degrees) → cos, resolved at COMPILE time from the node's config so
 *  every target bakes the SAME literal (no runtime `cos`, so JS↔WASM stay bit-exact
 *  and no host-cos import is needed). Clamped to [0, 180]. */
export function viewCosHalf(config: Record<string, unknown>): { cosHalf: number; omni: boolean } {
  let deg = Number(config.halfAngle ?? 60);
  if (!Number.isFinite(deg)) deg = 60;
  if (deg < 0) deg = 0; else if (deg > 180) deg = 180;
  // halfAngle >= 180 ⇒ the cone is the whole plane/space ⇒ omnidirectional (the
  // fast-path emits exactly the Get Nearby Agents code, zero cone overhead).
  return { cosHalf: Math.cos((deg * Math.PI) / 180), omni: deg >= 180 };
}

/** The heading (x,y[,z]) expressions in the AGENT behaviour loop for the two backed
 *  sources. `velocity` (default) = the agent's own velocity (zero-cost, matches
 *  boids); `wired` = the node's Heading X/Y/Z inputs. The third source, `facing`,
 *  is NOT resolved here: `lowerFacingSource` ([facingSource.ts](../compiler/facingSource.ts))
 *  rewrites a `facing` node into the `wired` composition (Get Self Attribute [the
 *  chosen VECTOR facing attribute] → Break Vector → these Heading inputs) BEFORE
 *  compile, so all three targets get it for free via the verified vector lowering.
 *  An UNRESOLVED `facing` (no valid vector attr) falls through to `velocity` here.
 *  Returns raw f64 exprs. */
export function viewHeadingExprs(
  config: Record<string, unknown>, inputs: Record<string, string>, is3d: boolean,
): { hx: string; hy: string; hz: string } {
  const wired = config.headingSource === 'wired';
  return {
    hx: wired ? (inputs['headingX'] || '0') : '_agentVX[idx]',
    hy: wired ? (inputs['headingY'] || '0') : '_agentVY[idx]',
    hz: is3d ? (wired ? (inputs['headingZ'] || '0') : '_agentVZ[idx]') : '0',
  };
}

/** Get Agents In View — the array of OTHER agents within `Radius` AND inside a
 *  heading-relative vision CONE (half-angle in degrees). The directional analogue
 *  of Get Nearby Agents: the cone test rides the SAME 3×3(×3) spatial-hash gather,
 *  so it adds no SoA/ABI and prunes the list. Membership = `dot(heading, offset) ≥
 *  cos(halfAngle)·|heading|·|offset|` (a division-free rearrangement of `cosA ≥
 *  cosHalf`); a ZERO heading (a still agent under the `velocity` source) is
 *  omnidirectional (the ÷0 guard). `halfAngle = 180°` = omnidirectional (compiles
 *  to exactly Get Nearby Agents). Heading source: Velocity (default) or Wired
 *  (Heading X/Y/Z inputs). Per-agent, behaviour-graph only. */
export const GetAgentsInViewNode: NodeTypeDef = {
  type: 'getAgentsInView',
  label: 'Get Agents In View',
  description: 'Nearby agents inside a heading-relative vision cone (set Half-angle°) — the directional Get Nearby Agents. Iterate with For Each In Array. Heading = Velocity (default), Wired, or Facing (a stored vector agent-attribute — needs the Orientation capability).',
  category: 'data',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'radius', label: 'Radius', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '5' },
    { id: 'headingX', label: 'Heading X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'headingY', label: 'Heading Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'headingZ', label: 'Heading Z', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'agents', label: 'Agents', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
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
  defaultConfig: { halfAngle: '60', headingSource: 'velocity' },
  compile: (nodeId, config, inputs, _boundary, ctx) => {
    const r = inputs['radius'] || '5';
    const V = `_v${nodeId}`;
    const is3d = !!ctx?.is3d;
    const { cosHalf, omni } = viewCosHalf(config);
    const { hx, hy, hz } = viewHeadingExprs(config, inputs, is3d);

    // The cone gate, appended to the distance test. Reuses `__dx/__dy[/__dz]` (the
    // torus-folded offset) and `__d2` already computed by the gather. Skipped
    // entirely in the omni fast-path (compile-time), so `halfAngle=180°` is exactly
    // Get Nearby Agents. `__hm2==0` (zero heading) ⇒ include (omnidirectional).
    const dotExpr = is3d ? `__hx*__dx+__hy*__dy+__hz*__dz` : `__hx*__dx+__hy*__dy`;
    const coneGate = omni
      ? ''
      : `if(__hm2===0){${V}.push(__j);}else{const __dot=${dotExpr},__d=Math.sqrt(__d2);if(__dot>=(${cosHalf}*__hm)*__d)${V}.push(__j);}`;
    // Without the cone (omni) the push is unconditional (matches Get Nearby Agents).
    const pushBody = omni ? `${V}.push(__j);` : coneGate;

    if (is3d) {
      const test3 = (jExpr: string) =>
        `{const __j=${jExpr}; if(__j!==idx&&_alive[__j]){let __dx=_agentX[__j]-__xi,__dy=_agentY[__j]-__yi,__dz=_agentZ[__j]-__zi; if(__tor){if(__dx>__hW)__dx-=__W;else if(__dx<-__hW)__dx+=__W;if(__dy>__hH)__dy-=__H;else if(__dy<-__hH)__dy+=__H;if(__dz>__hD)__dz-=__D;else if(__dz<-__hD)__dz+=__D;} const __d2=__dx*__dx+__dy*__dy+__dz*__dz; if(__d2<=__r2){${pushBody}}}}`;
      return `const ${V}=[];{const __qr=${r},__r2=__qr*__qr,__xi=_agentX[idx],__yi=_agentY[idx],__zi=_agentZ[idx],__W=_fieldW,__H=_fieldH,__D=_fieldD,__hW=__W/2,__hH=__H/2,__hD=__D/2,__tor=_fieldBoundaryTorus,__hx=${hx},__hy=${hy},__hz=${hz},__hm2=__hx*__hx+__hy*__hy+__hz*__hz,__hm=Math.sqrt(__hm2);`
        + `if(_hashValid){let __bx=((__xi-_hashOriginX)/_hashBinSizeX)|0;if(__bx<0)__bx=0;else if(__bx>=_hashNBinsX)__bx=_hashNBinsX-1;let __by=((__yi-_hashOriginY)/_hashBinSizeY)|0;if(__by<0)__by=0;else if(__by>=_hashNBinsY)__by=_hashNBinsY-1;let __bz=((__zi-_hashOriginZ)/_hashBinSizeZ)|0;if(__bz<0)__bz=0;else if(__bz>=_hashNBinsZ)__bz=_hashNBinsZ-1;`
        + `for(let __ez=-1;__ez<=1;__ez++)for(let __ey=-1;__ey<=1;__ey++)for(let __ex=-1;__ex<=1;__ex++){let __nbx=__bx+__ex,__nby=__by+__ey,__nbz=__bz+__ez;if(__tor){__nbx=((__nbx%_hashNBinsX)+_hashNBinsX)%_hashNBinsX;__nby=((__nby%_hashNBinsY)+_hashNBinsY)%_hashNBinsY;__nbz=((__nbz%_hashNBinsZ)+_hashNBinsZ)%_hashNBinsZ;}else{if(__nbx<0||__nbx>=_hashNBinsX||__nby<0||__nby>=_hashNBinsY||__nbz<0||__nbz>=_hashNBinsZ)continue;}const __b=(__nbz*_hashNBinsY+__nby)*_hashNBinsX+__nbx;for(let __p=_hashBinStart[__b];__p<_hashBinStart[__b+1];__p++)${test3('_hashBinAgents[__p]')}}`
        + `}else{for(let __all=0;__all<highWater;__all++)${test3('__all')}}}\n`;
    }
    // 2D
    const test = (jExpr: string) =>
      `{const __j=${jExpr}; if(__j!==idx&&_alive[__j]){let __dx=_agentX[__j]-__xi,__dy=_agentY[__j]-__yi; if(__tor){if(__dx>__hW)__dx-=__W;else if(__dx<-__hW)__dx+=__W;if(__dy>__hH)__dy-=__H;else if(__dy<-__hH)__dy+=__H;} const __d2=__dx*__dx+__dy*__dy; if(__d2<=__r2){${pushBody}}}}`;
    return `const ${V}=[];{const __qr=${r},__r2=__qr*__qr,__xi=_agentX[idx],__yi=_agentY[idx],__W=_fieldW,__H=_fieldH,__hW=__W/2,__hH=__H/2,__tor=_fieldBoundaryTorus,__hx=${hx},__hy=${hy},__hm2=__hx*__hx+__hy*__hy,__hm=Math.sqrt(__hm2);`
      + `if(_hashValid){let __bx=((__xi-_hashOriginX)/_hashBinSizeX)|0;if(__bx<0)__bx=0;else if(__bx>=_hashNBinsX)__bx=_hashNBinsX-1;let __by=((__yi-_hashOriginY)/_hashBinSizeY)|0;if(__by<0)__by=0;else if(__by>=_hashNBinsY)__by=_hashNBinsY-1;`
      + `for(let __ey=-1;__ey<=1;__ey++)for(let __ex=-1;__ex<=1;__ex++){let __nbx=__bx+__ex,__nby=__by+__ey;if(__tor){__nbx=((__nbx%_hashNBinsX)+_hashNBinsX)%_hashNBinsX;__nby=((__nby%_hashNBinsY)+_hashNBinsY)%_hashNBinsY;}else{if(__nbx<0||__nbx>=_hashNBinsX||__nby<0||__nby>=_hashNBinsY)continue;}const __b=__nby*_hashNBinsX+__nbx;for(let __p=_hashBinStart[__b];__p<_hashBinStart[__b+1];__p++)${test('_hashBinAgents[__p]')}}`
      + `}else{for(let __all=0;__all<highWater;__all++)${test('__all')}}}\n`;
  },
};
