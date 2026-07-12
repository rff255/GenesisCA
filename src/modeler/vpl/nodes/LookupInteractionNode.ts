import type { NodeTypeDef, PortDef } from '../types';
import type { CAModel } from '../../../model/types';
import { isMultiAxisTable, resolveAxes, MAX_LOOKUP_AXES } from '../compiler/variegation';

/** Index a Lookup Table model attribute.
 *
 *  LEGACY 2-axis tables: inputs `labelA` (row index) + `labelB` (column index) —
 *  integer indices into the table's row/column key sources. Output: the float at
 *  `tableValues[rowLabel][colLabel]` (0 when unset). Constant-time lookup via
 *  `_lookupTables[tableId][row * colCount + col]` where `colCount` (the column
 *  dimension = stride) is baked at compile time per table. The legacy emit is
 *  byte-identical to the pre-N-D compiler (no clamp — same trust model as ever).
 *
 *  MULTI-AXIS (N-D) tables (`attr.axes` present): one integer input per axis
 *  (`axis_0..axis_{N-1}`, labeled with the axis names — the static max-6 ports
 *  below, sliced per table by `applyLookupAxisPorts`, the expression-node
 *  pattern). Emit: per-axis SATURATING CLAMP `clamp((v|0) − min, 0, dim−1)`
 *  then the row-major multiply-add `Σ idxₖ·strideₖ` — identical semantics on
 *  all six compile surfaces (see docs/PLAN_ND_LOOKUP_TABLES.md D-NDT-5).
 *  Dims/mins are baked into config as `_dims`/`_mins` by compile.ts pre-resolve. */
export const LookupInteractionNode: NodeTypeDef = {
  type: 'lookupInteraction',
  label: 'Table Lookup',
  description: 'Indexes a Lookup Table model attribute — by row + column for a 2-axis table, or by one index per axis for a multi-axis table. Returns the stored value (a number matching the table’s value type — e.g. 0/1 for a Binary table).',
  category: 'logic',
  color: '#1976d2',
  ports: [
    { id: 'labelA', label: 'Row', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'labelB', label: 'Col', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    // Multi-axis index inputs — static max-MAX_LOOKUP_AXES ports, shown/relabeled
    // only for a multi-axis table (applyLookupAxisPorts in CaNode + effectivePorts).
    { id: 'axis_0', label: 'Axis 0', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'axis_1', label: 'Axis 1', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'axis_2', label: 'Axis 2', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'axis_3', label: 'Axis 3', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'axis_4', label: 'Axis 4', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'axis_5', label: 'Axis 5', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'float' },
  ],
  defaultConfig: { tableId: '' },
  compile: (nodeId, config, inputs) => {
    const tableId = (config.tableId as string) || '';
    if (!tableId) return `const _v${nodeId} = 0;\n`;
    const dims = lookupNodeDims(config);
    if (dims) {
      // Multi-axis: per-axis clamp + row-major multiply-add.
      const mins = lookupNodeMins(config);
      const strides = stridesOf(dims);
      const lines: string[] = [];
      const terms: string[] = [];
      for (let k = 0; k < dims.length; k++) {
        const src = inputs[`axis_${k}`] || '0';
        const min = Math.floor(Number(mins[k]) || 0);
        const dim = Math.max(1, Math.floor(Number(dims[k]) || 1));
        const iv = `_ax${nodeId}_${k}`;
        const raw = min !== 0 ? `((${src}) | 0) - ${min}` : `((${src}) | 0)`;
        lines.push(`const ${iv} = Math.min(Math.max(${raw}, 0), ${dim - 1});`);
        terms.push(strides[k] === 1 ? iv : `${iv} * ${strides[k]}`);
      }
      lines.push(`const _tbl${nodeId} = _lookupTables[${JSON.stringify(tableId)}];`);
      lines.push(`const _v${nodeId} = _tbl${nodeId} ? (_tbl${nodeId}[${terms.join(' + ')}] || 0) : 0;`);
      return lines.join(' ') + '\n';
    }
    // Legacy 2-axis — BYTE-IDENTICAL to the pre-N-D emit (no clamp).
    const labelA = inputs['labelA'] || '0';
    const labelB = inputs['labelB'] || '0';
    // Baked by compile.ts pre-resolve: colCount = the column key source's label
    // count (the row-major stride). When unset, fall back to 1 — the resulting
    // table degenerates and the runtime returns the (0,0) entry which is 0.
    const colCount = Number(config._colCount) || 1;
    return [
      `const _la${nodeId} = ((${labelA}) | 0);`,
      `const _lb${nodeId} = ((${labelB}) | 0);`,
      `const _tbl${nodeId} = _lookupTables[${JSON.stringify(tableId)}];`,
      `const _v${nodeId} = _tbl${nodeId} ? (_tbl${nodeId}[_la${nodeId} * ${colCount} + _lb${nodeId}] || 0) : 0;`,
    ].join(' ') + '\n';
  },
};

/** The baked multi-axis dims (compile.ts pre-resolve `_dims` — a comma-joined
 *  string, since NodeConfig holds scalars only), or null when the node targets
 *  a legacy 2-axis table. Shared with InteractionTableMapNode. */
export function lookupNodeDims(config: Record<string, unknown>): number[] | null {
  return parseBakedInts(config._dims);
}

/** The baked multi-axis intRange index offsets (`_mins`, comma-joined). */
export function lookupNodeMins(config: Record<string, unknown>): number[] {
  return parseBakedInts(config._mins) ?? [];
}

function parseBakedInts(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.length > 0 ? v.map(x => Math.floor(Number(x)) || 0) : null;
  if (typeof v === 'string' && v.length > 0) {
    const arr = v.split(',').map(s => Math.floor(Number(s)) || 0);
    return arr.length > 0 ? arr : null;
  }
  return null;
}

/** Row-major strides over `dims` in declared order (last axis contiguous). */
export function stridesOf(dims: readonly number[]): number[] {
  const strides = new Array<number>(dims.length).fill(1);
  for (let i = dims.length - 2; i >= 0; i--) {
    strides[i] = strides[i + 1]! * Math.max(1, Math.floor(dims[i + 1]!) || 1);
  }
  return strides;
}

/** Shape the Table Lookup node's INPUT port list for its referenced table —
 *  THE one port shaper consumed by BOTH CaNode.tsx and effectivePorts.ts (the
 *  buildExtraSlotPorts dual-consumption pattern, so the two can't drift):
 *   - legacy 2-axis table (or no model / no table picked): keep `labelA`/`labelB`,
 *     drop every `axis_*` port — the pre-N-D shape, existing wires never move;
 *   - multi-axis table: drop `labelA`/`labelB`, keep `axis_0..axis_{N-1}`
 *     relabeled with the axis names. */
export function applyLookupAxisPorts(
  inputs: PortDef[],
  config: Record<string, unknown> | undefined,
  model?: CAModel | null,
): PortDef[] {
  const tableId = String(config?.tableId ?? '');
  const attr = model?.attributes.find(
    a => a.id === tableId && a.isModelAttribute && a.type === 'lookupTable',
  );
  if (!attr || !isMultiAxisTable(attr) || !model) {
    return inputs.filter(p => !p.id.startsWith('axis_'));
  }
  const r = resolveAxes(attr, model);
  const n = Math.min(r.axes.length, MAX_LOOKUP_AXES);
  return inputs
    .filter(p => {
      if (p.id === 'labelA' || p.id === 'labelB') return false;
      if (!p.id.startsWith('axis_')) return true;
      return Number(p.id.slice(5)) < n;
    })
    .map(p => {
      if (!p.id.startsWith('axis_')) return p;
      const k = Number(p.id.slice(5));
      return { ...p, label: r.axes[k]!.name };
    });
}
