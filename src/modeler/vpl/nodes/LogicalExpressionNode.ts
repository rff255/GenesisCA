import type { NodeTypeDef, PortDef } from '../types';
import {
  buildLogicVarMap, parseLogicExpression, clampVisibleCount, VISIBLE_PORT_IDS,
} from '../compiler/expression/logicParser';
import { emitLogicJS } from '../compiler/expression/emitLogic';

/**
 * Logical Expression node — type a boolean formula instead of wiring up a chain
 * of Logic nodes. What the Expression node is to Math, this is to Logic.
 *
 * Has the same fixed pool of 8 input ports (`a`–`h`) as the Expression node —
 * here typed `bool`, exactly like Logic's operands, so wiring compatibility is
 * identical — with `config.visibleCount` controlling how many the modeler shows
 * and user-editable per-port names (`config._varName_<id>`) so a formula reads
 * naturally (`alive AND NOT crowded`). Because all 8 ports live in `def.ports`,
 * every compile target resolves them with no special input-resolution code;
 * an unconnected port falls through to its inline bool widget.
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
  dataType: 'bool' as const,
  inlineWidget: 'bool' as const,
  defaultValue: 'false',
}));

export const LogicalExpressionNode: NodeTypeDef = {
  type: 'logicalExpression',
  label: 'Logical Expression',
  description:
    'Type a boolean formula (e.g. a AND NOT b OR c). Variables come from the input ports. '
    + 'Operators NOT AND XOR OR (or ! && ^ ||), parentheses, and the literals true/false. '
    + 'Precedence: NOT > AND > XOR > OR.',
  category: 'logic',
  color: '#1a237e',
  ports: [
    ...INPUT_PORTS,
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'bool' },
  ],
  defaultConfig: { expression: '', visibleCount: 3 },
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
