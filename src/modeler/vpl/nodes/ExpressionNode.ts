import type { NodeTypeDef, PortDef } from '../types';
import {
  buildVarMap, parseExpression, clampVisibleCount, VISIBLE_PORT_IDS,
} from '../compiler/expression/parser';
import { emitJS } from '../compiler/expression/emitJS';

/**
 * Expression node — type a math formula instead of wiring up many Math nodes.
 *
 * Has a fixed pool of 8 scalar input ports (`a`–`h`); `config.visibleCount`
 * controls how many the modeler shows. Per-port display names are user-editable
 * (`config._varName_<id>`) so a formula reads naturally (`u + Du*lap - u*v*v`).
 * Because all 8 ports live in `def.ports`, every compile target resolves them
 * with no special input-resolution code — unconnected ports fall through to
 * their inline number widget.
 *
 * `compile()` (the JS target) parses the formula and emits it via `emitJS`. The
 * WASM and WebGPU targets have their own `VALUE_NODE_EMITTERS` entries that
 * walk the same parsed AST. On a bad formula the JS target emits `0` (the
 * modeler's amber badge already tells the user what's wrong); WASM/WebGPU push
 * to `ctx.errors` and the worker falls back to JS.
 */
const INPUT_PORTS: PortDef[] = VISIBLE_PORT_IDS.map(id => ({
  id,
  label: id.toUpperCase(),
  kind: 'input' as const,
  category: 'value' as const,
  dataType: 'any' as const,
  inlineWidget: 'number' as const,
  defaultValue: '0',
}));

export const ExpressionNode: NodeTypeDef = {
  type: 'expression',
  label: 'Expression',
  description:
    'Type a math formula (e.g. a + b*c - pow(d,2)). Variables come from the input ports. '
    + 'Supports + - * / % ^ and sqrt abs floor ceil round min max pow mod exp log sin cos tan tanh.',
  category: 'logic',
  color: '#b8860b',
  ports: [
    ...INPUT_PORTS,
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { expression: '', visibleCount: 3 },
  compile: (nodeId, config, inputVars) => {
    const visibleCount = clampVisibleCount(config.visibleCount);
    const { map, errors } = buildVarMap(config, visibleCount);
    if (errors.length > 0) {
      if (import.meta.env?.DEV) console.warn(`Expression node ${nodeId}: ${errors[0]}`);
      return `const _v${nodeId} = 0;\n`;
    }
    const res = parseExpression(String(config.expression ?? ''), map);
    if ('error' in res) {
      if (import.meta.env?.DEV) console.warn(`Expression node ${nodeId}: ${res.error}`);
      return `const _v${nodeId} = 0;\n`;
    }
    return `const _v${nodeId} = ${emitJS(res.ast, inputVars)};\n`;
  },
};
