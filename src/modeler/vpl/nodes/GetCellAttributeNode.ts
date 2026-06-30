import type { NodeTypeDef } from '../types';

export const GetCellAttributeNode: NodeTypeDef = {
  type: 'getCellAttribute',
  label: 'Get Cell Attribute',
  agentLabel: 'Get Self Attribute',
  description: 'Reads an attribute value from the current cell.',
  agentDescription: "Reads one of the current agent's own attribute values.",
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
  ],
  defaultConfig: { attributeId: '' },
  compile: (nodeId, config, _inputs, _boundary, ctx) => {
    const attr = config.attributeId as string || '_undef';
    const readExpr = ctx ? ctx.readAttrExpr(attr, 'idx') : `r_${attr}[idx]`;
    return `const _v${nodeId} = ${readExpr};\n`;
  },
};
