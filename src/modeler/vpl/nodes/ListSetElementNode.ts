import type { NodeTypeDef } from '../types';

export const ListSetElementNode: NodeTypeDef = {
  type: 'listSetElement',
  label: 'List Set Element',
  category: 'data',
  color: '#00695c',
  ports: [
    { id: 'do', label: 'Do', kind: 'input', category: 'flow', dataType: 'any' },
    { id: 'index', label: 'Index', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number' },
    { id: 'value', label: 'Value', kind: 'input', category: 'value', dataType: 'any' },
    { id: 'done', label: 'Done', kind: 'output', category: 'flow', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '', _port_index: '0' },
  compile: (nodeId, config, getInput) => {
    const attrId = config.attributeId as string || '';
    const listSize = Number(config.listSize) || 4;
    const valueExpr = getInput?.('value') ?? '0';
    const indexExpr = getInput?.('index');
    if (indexExpr) {
      // Dynamic index
      const arrParts = [];
      for (let k = 0; k < listSize; k++) arrParts.push(`w_${attrId}_${k}`);
      return `([${arrParts.join(',')}][${indexExpr}] || [${arrParts[0]}])[idx] = ${valueExpr};\n`;
    }
    const idx = Number(config._port_index) || 0;
    const clampedIdx = Math.max(0, Math.min(listSize - 1, idx));
    return `w_${attrId}_${clampedIdx}[idx] = ${valueExpr};\n`;
  },
};
