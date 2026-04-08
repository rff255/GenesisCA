import type { NodeTypeDef } from '../types';

export const ListGetElementNode: NodeTypeDef = {
  type: 'listGetElement',
  label: 'List Get Element',
  category: 'data',
  color: '#00695c',
  ports: [
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '', _port_index: '0' },
  compile: (nodeId, config, getInput) => {
    const attrId = config.attributeId as string || '';
    const listSize = Number(config.listSize) || 4;
    const indexExpr = getInput?.('index');
    if (indexExpr) {
      // Dynamic index: build lookup array
      const arrParts = [];
      for (let k = 0; k < listSize; k++) arrParts.push(`r_${attrId}_${k}`);
      return `const _v${nodeId} = ([${arrParts.join(',')}][${indexExpr}] || [${arrParts[0]}])[idx];\n`;
    }
    // Constant index from inline widget
    const idx = Number(config._port_index) || 0;
    const clampedIdx = Math.max(0, Math.min(listSize - 1, idx));
    return `const _v${nodeId} = r_${attrId}_${clampedIdx}[idx];\n`;
  },
};
