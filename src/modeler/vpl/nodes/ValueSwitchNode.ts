import type { NodeTypeDef } from '../types';

export const ValueSwitchNode: NodeTypeDef = {
  type: 'valueSwitch',
  label: 'Value Switch',
  description: 'Ternary value selector: returns If when Condition is truthy (nonzero), else Else. Both inputs always evaluate — use a flow Conditional for short-circuit. Relays SHAPE as well as value: wire two arrays and it selects an array; wire two vectors (or two colours) and it selects that composite component by component.',
  category: 'logic',
  color: '#b8860b',
  ports: [
    { id: 'condition', label: 'Condition', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'bool',   defaultValue: 'false' },
    // ifValue/elseValue/result are DUAL-MODE RELAY ports — the node selects a
    // value, so its output SHAPE is its input shape:
    //  - arrayCapable: both branches relay arrays ⇒ `result` is an array
    //    (handled by the compilers via producesArray / sourceYieldsArray). The
    //    flag lets the compatible-nodes menu offer Value Switch in array
    //    contexts too — wiring already works; that one is discovery only.
    //  - compositeCapable: both branches carry the SAME composite (`vector` /
    //    `color`) ⇒ `result` is that composite. That one IS load-bearing:
    //    `isValidConnection` consults it to permit the wire and
    //    `expandComposites` lowers the relay into one scalar Value Switch per
    //    component, so all three targets emit it through the verified scalar
    //    path with no per-target composite code. See compositeRelay.ts.
    { id: 'ifValue',   label: 'If',        kind: 'input', category: 'value', dataType: 'any', arrayCapable: true, compositeCapable: true, inlineWidget: 'number', defaultValue: '1' },
    { id: 'elseValue', label: 'Else',      kind: 'input', category: 'value', dataType: 'any', arrayCapable: true, compositeCapable: true, inlineWidget: 'number', defaultValue: '0' },
    { id: 'result',    label: 'Result',    kind: 'output', category: 'value', dataType: 'any', arrayCapable: true, compositeCapable: true },
  ],
  defaultConfig: {},
  compile: (nodeId, _config, inputs) => {
    const cond = inputs['condition'] || 'false';
    const ifV  = inputs['ifValue']   || '1';
    const elV  = inputs['elseValue'] || '0';
    return `const _v${nodeId} = (${cond}) ? (${ifV}) : (${elV});\n`;
  },
};
