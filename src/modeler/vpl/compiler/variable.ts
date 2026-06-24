/** Compile-target-independent helpers for Local Variables (per-cell scratch
 *  storage referenced by getVariable / setVariable / setArrayElement nodes).
 *  See `Variable` in `src/model/types.ts` for the schema. */

import type { Variable } from '../../../model/types';

/** Encode a Variable's initialValue (or any string value matching its
 *  dataType) as a JS numeric literal. Mirrors `attrValueLiteralJS` for
 *  cell attributes. Bools become 0/1; numbers parse decimal; tag indices
 *  are already stringified ints. Invalid → 0. */
export function variableValueLiteralJS(variable: Variable, raw: string | undefined): string {
  const r = raw ?? variable.initialValue ?? '0';
  if (variable.dataType === 'bool') {
    return (r === 'true' || r === '1') ? '1' : '0';
  }
  const n = Number(r);
  return Number.isFinite(n) ? String(n) : '0';
}

/** Typed-array constructor name for an array variable's element storage.
 *  Scalars don't need a typed array — they're JS locals. */
export function variableTypedArrayCtor(variable: Variable): 'Uint8Array' | 'Int32Array' | 'Float64Array' {
  if (variable.dataType === 'bool') return 'Uint8Array';
  if (variable.dataType === 'float') return 'Float64Array';
  return 'Int32Array'; // integer / tag
}

/** JS local variable name for a Variable. Same for scalar + array kinds. */
export function variableLocalName(variableId: string): string {
  return `_var_${safe(variableId)}`;
}

/** Build the per-step JS code that declares + initialises every Variable.
 *  Returns two parts:
 *    - preLoop: typed-array allocations + scalar `let` declarations that live
 *      at function scope (allocated once per step, reused across cells).
 *    - inLoopReset: per-cell reset lines that go at the top of the cell loop
 *      body — fills array variables with their initialValue and re-assigns
 *      scalar variables to their initialValue.
 *
 *  Lifetime: per-cell, per-step. Each cell sees a fresh copy with the
 *  initialValue at the start of its computation; user writes mutate the
 *  copy; nothing carries across to the next cell or the next step. */
export function buildVariableJS(variables: Variable[]): { preLoop: string[]; inLoopReset: string[] } {
  if (variables.length === 0) return { preLoop: [], inLoopReset: [] };
  const preLoop: string[] = [];
  const inLoopReset: string[] = [];
  for (const v of variables) {
    const name = variableLocalName(v.id);
    const init = variableValueLiteralJS(v, v.initialValue);
    if (v.kind === 'scalar') {
      // Scalar: declared INSIDE the loop body as a fresh `let` per cell.
      inLoopReset.push(`    let ${name} = ${init};`);
    } else {
      // Array: allocate the typed array ONCE outside the loop, refill every cell.
      const len = Math.max(0, Number(v.length) | 0) || 1;
      const ctor = variableTypedArrayCtor(v);
      preLoop.push(`  const ${name} = new ${ctor}(${len});`);
      // Fast .fill — most JS engines optimise this to a memset.
      inLoopReset.push(`    ${name}.fill(${init});`);
    }
  }
  return { preLoop, inLoopReset };
}

function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}
