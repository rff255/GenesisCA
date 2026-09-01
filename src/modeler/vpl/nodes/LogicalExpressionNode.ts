import type { NodeTypeDef, PortDef } from '../types';
import {
  buildLogicVarMap, parseLogicExpression, clampVisibleCount, VISIBLE_PORT_IDS,
} from '../compiler/expression/logicParser';
import { emitLogicJS } from '../compiler/expression/emitLogic';

/**
 * Logical Expression node — type a boolean formula instead of wiring up a chain
 * of Logic nodes. What the Expression node is to Math, this is to Logic.
 *
 * Has the same fixed pool of 8 input ports (`a`–`h`) as the Expression node,
 * with `config.visibleCount` controlling how many the modeler shows and
 * user-editable per-port names (`config._varName_<id>`) so a formula reads
 * naturally (`alive AND NOT crowded`). Because all 8 ports live in `def.ports`,
 * every compile target resolves them with no special input-resolution code;
 * an unconnected port falls through to its inline bool widget.
 *
 * THE PORTS ARE TYPED `any`, NOT `bool`, because the grammar's COMPARISON tier
 * reads them as numbers (`neighbours > 2`): the declared type is what the
 * discovery layer (`portsCompatible` — the connection-drop menu and the
 * drag-highlight) filters on, so a `bool` declaration would hide this node from
 * exactly the numeric sources comparisons exist for. The INLINE widget stays
 * `bool` — the node is still a boolean formula node, an unwired operand reads as
 * its True/False (1/0), and a constant to compare against is written in the
 * formula itself (`n > 3`).
 *
 * `compile()` (the JS target) parses the formula and emits it via `emitLogicJS`.
 * The WASM and WebGPU targets — cell and agent alike — have their own emitter
 * entries that walk the same parsed AST. On a bad formula the JS target emits
 * `0` (the modeler's amber badge already tells the user what's wrong); the other
 * targets report the error and the worker falls back to JS.
 */
const INPUT_PORTS: PortDef[] = VISIBLE_PORT_IDS.map(id => ({
  id,
  label: id.toUpperCase(),
  kind: 'input' as const,
  category: 'value' as const,
  // `any`: bare it is truthy-tested, in a comparison it is the raw number.
  dataType: 'any' as const,
  inlineWidget: 'bool' as const,
  defaultValue: 'false',
}));

export const LogicalExpressionNode: NodeTypeDef = {
  type: 'logicalExpression',
  label: 'Logical Expression',
  description:
    'Type a boolean formula (e.g. n > 2 AND NOT crowded). Variables come from the input ports. '
    + 'Operators NOT AND XOR OR (or ! && ^ ||), the comparisons < <= > >= == != (= is == too), '
    + 'parentheses, numbers, and the literals true/false. '
    + 'Precedence: comparisons > NOT > AND > XOR > OR, so NOT n > 2 reads as NOT (n > 2). '
    + 'A bare input is truthy-tested; in a comparison it is its raw number. '
    + 'No arithmetic (not even negation) — compute a value in a Math Expression node and wire it in.',
  category: 'logic',
  color: '#1a237e',
  ports: [
    ...INPUT_PORTS,
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'bool' },
  ],
  // A NEW node opens with TWO inputs, matching its Math Expression sibling (see
  // that node for why this is not `DEFAULT_VISIBLE_COUNT`).
  defaultConfig: { expression: '', visibleCount: 2 },
  compile: (nodeId, config, inputVars) => {
    const visibleCount = clampVisibleCount(config.visibleCount);
    const { map, errors } = buildLogicVarMap(config, visibleCount);
    if (errors.length > 0) {
      if (import.meta.env?.DEV) console.warn(`Logical Expression node ${nodeId}: ${errors[0]}`);
      return `const _v${nodeId} = 0;\n`;
    }
    const res = parseLogicExpression(String(config.expression ?? ''), map);
    if ('error' in res) {
      if (import.meta.env?.DEV) console.warn(`Logical Expression node ${nodeId}: ${res.error}`);
      return `const _v${nodeId} = 0;\n`;
    }
    return `const _v${nodeId} = ${emitLogicJS(res.ast, inputVars)};\n`;
  },
};
