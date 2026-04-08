import type { NodeTypeDef } from '../types';
import { StepNode } from './StepNode';
import { GetCellAttributeNode } from './GetCellAttributeNode';
import { GetNeighborsAttributeNode } from './GetNeighborsAttributeNode';
import { GetConstantNode } from './GetConstantNode';
import { GetModelAttributeNode } from './GetModelAttributeNode';
import { GetRandomNode } from './GetRandomNode';
import { GetColorConstantNode } from './GetColorConstantNode';
import { ArithmeticOperatorNode } from './ArithmeticOperatorNode';
import { GroupCountingNode } from './GroupCountingNode';
import { GroupStatementNode } from './GroupStatementNode';
import { GroupOperatorNode } from './GroupOperatorNode';
import { StatementNode } from './StatementNode';
import { LogicOperatorNode } from './LogicOperatorNode';
import { ConditionalNode } from './ConditionalNode';
import { SequenceNode } from './SequenceNode';
import { LoopNode } from './LoopNode';
import { SetAttributeNode } from './SetAttributeNode';
import { SetColorViewerNode } from './SetColorViewerNode';
import { InputColorNode } from './InputColorNode';
import { MacroNode } from './MacroNode';
import { MacroInputNode } from './MacroInputNode';
import { MacroOutputNode } from './MacroOutputNode';
import { TagConstantNode } from './TagConstantNode';
import { ListGetElementNode } from './ListGetElementNode';
import { ListSetElementNode } from './ListSetElementNode';

const ALL_NODES: NodeTypeDef[] = [
  // Flow
  StepNode,
  ConditionalNode,
  SequenceNode,
  LoopNode,
  // Data
  GetCellAttributeNode,
  GetModelAttributeNode,
  GetNeighborsAttributeNode,
  GetConstantNode,
  GetRandomNode,
  TagConstantNode,
  ListGetElementNode,
  ListSetElementNode,
  // Arithmetic & Logic
  ArithmeticOperatorNode,
  StatementNode,
  LogicOperatorNode,
  // Aggregation
  GroupCountingNode,
  GroupStatementNode,
  GroupOperatorNode,
  // Output
  SetAttributeNode,
  // Color
  InputColorNode,
  SetColorViewerNode,
  GetColorConstantNode,
  // Macro
  MacroNode,
  MacroInputNode,
  MacroOutputNode,
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

/** Node types hidden from the "Add Node" menu (created programmatically) */
const HIDDEN_FROM_MENU = new Set(['macro', 'macroInput', 'macroOutput', 'listGetElement', 'listSetElement', 'tagConstant']);

/** Grouped by category for the "Add Node" menu */
export function getNodeDefsByCategory(): Map<string, NodeTypeDef[]> {
  const grouped = new Map<string, NodeTypeDef[]>();
  for (const def of ALL_NODES) {
    if (HIDDEN_FROM_MENU.has(def.type)) continue;
    const list = grouped.get(def.category) ?? [];
    list.push(def);
    grouped.set(def.category, list);
  }
  return grouped;
}
