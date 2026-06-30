import type { NodeTypeDef, NodeConfig } from '../types';

/** Vector Op — vectorial math on `vector` values (the Unreal vector-math nodes /
 *  Blender Vector Math node). One node, an `op` dropdown: Add / Subtract / Scale
 *  (vector × scalar) / Dot / Cross / Length / Normalize / Distance / Negate /
 *  Lerp. Operates on the bundled [x, y, z] so you never touch the components
 *  (z = 0 in 2D, so 2D math is the natural plane). Multi-output: `result` (a
 *  vector) for the vector-returning ops, `value` (a float) for Dot / Length /
 *  Distance. JS compile target only. */

const NEEDS_B = new Set(['add', 'subtract', 'dot', 'cross', 'distance', 'lerp']);
const NEEDS_S = new Set(['scale']);
const NEEDS_T = new Set(['lerp']);
const SCALAR_OUT = new Set(['dot', 'length', 'distance']);

export const VectorOpNode: NodeTypeDef = {
  type: 'vectorOp',
  label: 'Vector Op',
  description: 'Vectorial math on vector values: add / subtract / scale / dot / cross / length / normalize / distance / negate / lerp.',
  category: 'logic',
  color: '#00838f',
  ports: [
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'vector' },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'vector' },
    { id: 's', label: 'Scalar', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    { id: 't', label: 'T', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
    { id: 'result', label: 'Vector', kind: 'output', category: 'value', dataType: 'vector' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'float' },
  ],
  hiddenPorts: (config: NodeConfig) => {
    const op = (config.op as string) || 'add';
    const hidden: string[] = [];
    if (!NEEDS_B.has(op)) hidden.push('b');
    if (!NEEDS_S.has(op)) hidden.push('s');
    if (!NEEDS_T.has(op)) hidden.push('t');
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
      default: return `${decl} ` + vec(`[${A}[0]+${B}[0], ${A}[1]+${B}[1], ${A}[2]+${B}[2]]`);
    }
  },
};
