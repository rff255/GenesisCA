import type { NodeTypeDef, NodeConfig } from '../types';

/** Vector Op — vectorial math on `vector` values (the Unreal vector-math nodes /
 *  Blender Vector Math node). One node, an `op` dropdown: Add / Subtract / Scale
 *  (vector × scalar) / Dot / Cross / Length / Normalize / Distance / Negate /
 *  Lerp / Rotate (2D) / Rotate Around Axis (3D). Operates on the bundled
 *  [x, y, z] so you never touch the components (z = 0 in 2D, so 2D math is the
 *  natural plane). Multi-output: `result` (a vector) for the vector-returning
 *  ops, `value` (a float) for Dot / Length / Distance.
 *
 *  ANGLES ARE IN DEGREES (port `Angle°`) — matching every other user-facing angle
 *  surface (the FOV nodes' Half-angle°, sprite compass degrees). The Expression
 *  node's raw sin/cos stay in radians for math users; the lowering multiplies by
 *  π/180.
 *
 *  This node is EDITOR SUGAR: `expandComposites` lowers it to scalar
 *  arithmeticOperator/getConstant nodes before any per-target compile, so every
 *  op runs on JS / WASM / WebGPU (grid AND agents) with zero per-target emit.
 *  The `compile()` below is therefore never reached in the shipped pipeline; it
 *  is kept as a readable reference of each op's semantics. */

const NEEDS_B = new Set(['add', 'subtract', 'dot', 'cross', 'distance', 'lerp']);
const NEEDS_S = new Set(['scale']);
const NEEDS_T = new Set(['lerp']);
/** Ops taking the `Angle°` (degrees) input. */
const NEEDS_ANGLE = new Set(['rotate2d', 'rotateAxis']);
/** Ops taking the `Axis` vector input. */
const NEEDS_AXIS = new Set(['rotateAxis']);
const SCALAR_OUT = new Set(['dot', 'length', 'distance']);

/** Degrees → radians, shared by the node's reference compile() and the lowering. */
export const DEG_TO_RAD = Math.PI / 180;

/** COLLAPSED-node titles, one per op — the Math node's convention applied here:
 *  a collapsed, un-renamed node summarises the OPERATION it performs instead of
 *  reading a generic "Vector Op". Deliberately SHORTER than the op dropdown's
 *  own option text ("Add (A + B)"), which is written to disambiguate the ports
 *  while a collapsed strip only has room for the verb. Lives next to the op set
 *  it names (the `ARITHMETIC_UNARY_OPS` precedent) so a new op cannot ship with
 *  a stale title; an unknown op falls back to the node's label. */
export const VECTOR_OP_COLLAPSED_LABELS: Readonly<Record<string, string>> = {
  add: 'Vec Add',
  subtract: 'Vec Subtract',
  scale: 'Vec Scale',
  dot: 'Vec Dot',
  cross: 'Vec Cross',
  length: 'Vec Length',
  normalize: 'Vec Normalize',
  distance: 'Vec Distance',
  negate: 'Vec Negate',
  lerp: 'Vec Lerp',
  rotate2d: 'Rotate 2D',
  rotateAxis: 'Rotate Axis',
};

export const VectorOpNode: NodeTypeDef = {
  type: 'vectorOp',
  label: 'Vector Op',
  description: 'Vectorial math on vector values: add / subtract / scale / dot / cross / length / normalize / distance / negate / lerp / rotate (2D, about Z) / rotate around axis (3D). Angles are in DEGREES; + rotates from +X toward +Y (clockwise on screen, since rows grow downward).',
  category: 'logic',
  color: '#00838f',
  ports: [
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'vector' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'vector' },
    { id: 'axis', label: 'Axis', kind: 'input', category: 'value', dataType: 'vector' },
    { id: 's', label: 'Scalar', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    { id: 't', label: 'T', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
    { id: 'angle', label: 'Angle°', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Vector', kind: 'output', category: 'value', dataType: 'vector' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'float' },
  ],
  hiddenPorts: (config: NodeConfig) => {
    const op = (config.op as string) || 'add';
    const hidden: string[] = [];
    if (!NEEDS_B.has(op)) hidden.push('b');
    if (!NEEDS_S.has(op)) hidden.push('s');
    if (!NEEDS_T.has(op)) hidden.push('t');
    if (!NEEDS_ANGLE.has(op)) hidden.push('angle');
    if (!NEEDS_AXIS.has(op)) hidden.push('axis');
    if (SCALAR_OUT.has(op)) hidden.push('result'); else hidden.push('value');
    return hidden;
  },
  defaultConfig: { op: 'add' },
  compile: (nodeId, config, inputs) => {
    const op = (config.op as string) || 'add';
    const A = `__va${nodeId}`, B = `__vb${nodeId}`;
    const a = inputs['a'] || '[0,0,0]';
    const b = inputs['b'] || '[0,0,0]';
    const s = inputs['s'] || '1';
    const t = inputs['t'] || '0.5';
    const ang = inputs['angle'] || '0';
    const axis = inputs['axis'] || '[0,0,0]';
    const decl = `const ${A} = ${a}; const ${B} = ${b};`;
    const vec = (e: string) => `const _v${nodeId}_result = ${e};\n`;
    const val = (e: string) => `const _v${nodeId}_value = ${e};\n`;
    switch (op) {
      case 'add': return `${decl} ` + vec(`[${A}[0]+${B}[0], ${A}[1]+${B}[1], ${A}[2]+${B}[2]]`);
      case 'subtract': return `${decl} ` + vec(`[${A}[0]-${B}[0], ${A}[1]-${B}[1], ${A}[2]-${B}[2]]`);
      case 'scale': return `const ${A} = ${a};\n` + vec(`[${A}[0]*(${s}), ${A}[1]*(${s}), ${A}[2]*(${s})]`);
      case 'dot': return `${decl} ` + val(`${A}[0]*${B}[0]+${A}[1]*${B}[1]+${A}[2]*${B}[2]`);
      case 'cross': return `${decl} ` + vec(`[${A}[1]*${B}[2]-${A}[2]*${B}[1], ${A}[2]*${B}[0]-${A}[0]*${B}[2], ${A}[0]*${B}[1]-${A}[1]*${B}[0]]`);
      case 'length': return `const ${A} = ${a};\n` + val(`Math.hypot(${A}[0],${A}[1],${A}[2])`);
      case 'normalize': return `const ${A} = ${a}; const __vl${nodeId} = Math.hypot(${A}[0],${A}[1],${A}[2]) || 1;\n` + vec(`[${A}[0]/__vl${nodeId}, ${A}[1]/__vl${nodeId}, ${A}[2]/__vl${nodeId}]`);
      case 'distance': return `${decl} ` + val(`Math.hypot(${A}[0]-${B}[0],${A}[1]-${B}[1],${A}[2]-${B}[2])`);
      case 'negate': return `const ${A} = ${a};\n` + vec(`[-${A}[0], -${A}[1], -${A}[2]]`);
      case 'lerp': return `${decl} const __vt${nodeId} = ${t};\n` + vec(`[${A}[0]+(${B}[0]-${A}[0])*__vt${nodeId}, ${A}[1]+(${B}[1]-${A}[1])*__vt${nodeId}, ${A}[2]+(${B}[2]-${A}[2])*__vt${nodeId}]`);
      // Rotation about +Z (the XY plane); Z passes through unchanged.
      case 'rotate2d': return `const ${A} = ${a}; const __vr${nodeId} = (${ang}) * ${DEG_TO_RAD}; const __vc${nodeId} = Math.cos(__vr${nodeId}); const __vs${nodeId} = Math.sin(__vr${nodeId});\n`
        + vec(`[${A}[0]*__vc${nodeId} - ${A}[1]*__vs${nodeId}, ${A}[0]*__vs${nodeId} + ${A}[1]*__vc${nodeId}, ${A}[2]]`);
      // Rodrigues: v·cosθ + (k̂×v)·sinθ + k̂(k̂·v)(1−cosθ). A zero axis normalises
      // to (0,0,0) via the ÷0→0 guard, so the result degenerates to v·cosθ.
      case 'rotateAxis': return `const ${A} = ${a}; const __vk${nodeId} = ${axis}; const __vkl${nodeId} = Math.hypot(__vk${nodeId}[0],__vk${nodeId}[1],__vk${nodeId}[2]) || Infinity; const __vkn${nodeId} = [__vk${nodeId}[0]/__vkl${nodeId}, __vk${nodeId}[1]/__vkl${nodeId}, __vk${nodeId}[2]/__vkl${nodeId}]; const __vr${nodeId} = (${ang}) * ${DEG_TO_RAD}; const __vc${nodeId} = Math.cos(__vr${nodeId}); const __vs${nodeId} = Math.sin(__vr${nodeId}); const __vd${nodeId} = (__vkn${nodeId}[0]*${A}[0]+__vkn${nodeId}[1]*${A}[1]+__vkn${nodeId}[2]*${A}[2])*(1-__vc${nodeId});\n`
        + vec(`[${A}[0]*__vc${nodeId} + (__vkn${nodeId}[1]*${A}[2]-__vkn${nodeId}[2]*${A}[1])*__vs${nodeId} + __vkn${nodeId}[0]*__vd${nodeId}, ${A}[1]*__vc${nodeId} + (__vkn${nodeId}[2]*${A}[0]-__vkn${nodeId}[0]*${A}[2])*__vs${nodeId} + __vkn${nodeId}[1]*__vd${nodeId}, ${A}[2]*__vc${nodeId} + (__vkn${nodeId}[0]*${A}[1]-__vkn${nodeId}[1]*${A}[0])*__vs${nodeId} + __vkn${nodeId}[2]*__vd${nodeId}]`);
      default: return `${decl} ` + vec(`[${A}[0]+${B}[0], ${A}[1]+${B}[1], ${A}[2]+${B}[2]]`);
    }
  },
};
