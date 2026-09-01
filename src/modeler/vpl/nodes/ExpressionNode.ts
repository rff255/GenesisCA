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
  // UI LABEL ONLY — the type id stays `expression` (schema / config / compilers
  // never rename ids). "Math" pairs it with its boolean sibling, Logical
  // Expression, and makes the quick-add search find it by either word.
  label: 'Math Expression',
  description:
    'Type a math formula (e.g. a + b*c - pow(d,2)) instead of wiring up many Math nodes. '
    + 'Variables come from the input ports. '
    + 'Supports + - * / % ^ and sqrt abs floor ceil round min max pow mod exp log sin cos tan tanh. '
    + 'The boolean sibling is Logical Expression.',
  category: 'logic',
  color: '#b8860b',
  ports: [
    ...INPUT_PORTS,
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'any' },
  ],
  // A NEW node opens with TWO inputs (`a + b` is the commonest shape; the +/−
  // stepper grows it to 8). Deliberately NOT `DEFAULT_VISIBLE_COUNT`, which is
  // the back-compat fallback for a config that never declared the key at all —
  // changing that would retro-resize a hand-edited or legacy node.
  defaultConfig: { expression: '', visibleCount: 2 },
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
