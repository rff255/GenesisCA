import type { NodeTypeDef } from '../types';
import { StepNode } from './StepNode';
import { GetCellAttributeNode } from './GetCellAttributeNode';
import { GetNeighborsAttributeNode } from './GetNeighborsAttributeNode';
import { GetConstantNode } from './GetConstantNode';
import { GroupCountingNode } from './GroupCountingNode';
import { StatementNode } from './StatementNode';
import { LogicOperatorNode } from './LogicOperatorNode';
import { ConditionalNode } from './ConditionalNode';
import { SetAttributeNode } from './SetAttributeNode';
import { SetColorViewerNode } from './SetColorViewerNode';

const ALL_NODES: NodeTypeDef[] = [
  StepNode,
  GetCellAttributeNode,
  GetNeighborsAttributeNode,
  GetConstantNode,
  GroupCountingNode,
  StatementNode,
  LogicOperatorNode,
  ConditionalNode,
  SetAttributeNode,
  SetColorViewerNode,
];

const registry = new Map<string, NodeTypeDef>();
for (const def of ALL_NODES) {
  registry.set(def.type, def);
}

export function getNodeDef(type: string): NodeTypeDef | undefined {
  return registry.get(type);
}

export function getAllNodeDefs(): NodeTypeDef[] {
  return ALL_NODES;
}

/** Grouped by category for the "Add Node" menu */
export function getNodeDefsByCategory(): Map<string, NodeTypeDef[]> {
  const grouped = new Map<string, NodeTypeDef[]>();
  for (const def of ALL_NODES) {
    const list = grouped.get(def.category) ?? [];
    list.push(def);
    grouped.set(def.category, list);
  }
  return grouped;
}
